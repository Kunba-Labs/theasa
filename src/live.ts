// Live agents: which panes wait for you, and what they ask. herdr knows every agent pane and its state;
// this module reads that, adds the pending question, and sends your answer back into the pane.
import type { Database } from "bun:sqlite";
import { openSync, readSync, fstatSync, closeSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { projectFor } from "./git";
import { askExtras } from "./hook";
import { redact } from "./redact";
import { projectBadge } from "./db";

const HERDR = process.env.THEASA_HERDR_BIN || Bun.which("herdr") || "/opt/homebrew/bin/herdr";

export type AskQuestion = { question: string; header?: string; multiSelect?: boolean; options: { label: string; description?: string; preview?: string }[] };
// what came with a question: the agent's text before it, and what it showed (sent files, artifacts)
export type AskAttachment = { id: number; kind: "sent" | "artifact"; name: string; url?: string; media_type?: string; src?: string };
export type AskExtras = { context?: string; attachments: AskAttachment[] };
export type ScreenOption = { label: string; keys: string[]; selected: boolean };
export type LiveAgent = {
  pane_id: string; agent: string; status: "blocked" | "done" | "idle" | "working" | "unknown"; title: string; cwd: string;
  session_id: string | null; since: string; project: any | null;
  ask?: AskQuestion[];                      // Claude's AskUserQuestion, read from the transcript
  ask_extras?: AskExtras;                   // from the hook: context and attachments for the question
  screen?: { text: string; options: ScreenOption[] }; // any other dialog: the pane's screen
  last?: { turn_id: number; headline: string | null; text: string; question: string | null; ended_at: string };
};

export async function herdr(args: string[], timeoutMs = 5000, raw = false): Promise<any> {
  const p = Bun.spawn([HERDR, ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const timer = setTimeout(() => p.kill(), timeoutMs);
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  clearTimeout(timer);
  if (code !== 0) {
    let msg = err.trim() || `herdr exited with ${code}`;
    try { msg = JSON.parse(err).error?.message || msg; } catch {}
    throw new Error(msg);
  }
  return raw ? out : JSON.parse(out).result;
}

// the last AskUserQuestion in a transcript that has no answer yet
export function pendingAsk(lines: string[]): AskQuestion[] | null {
  let pending: { id: string; questions: AskQuestion[] } | null = null;
  for (const l of lines) {
    if (!l.includes("AskUserQuestion") && !(pending && l.includes(pending.id))) continue;
    let o: any; try { o = JSON.parse(l); } catch { continue; }
    const c = o.message?.content;
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (b?.type === "tool_use" && b.name === "AskUserQuestion" && Array.isArray(b.input?.questions)) pending = { id: b.id, questions: b.input.questions };
      else if (b?.type === "tool_result" && pending && b.tool_use_id === pending.id) pending = null;
    }
  }
  return pending?.questions ?? null;
}

// the choices on a dialog screen, with the keys that pick each one:
// numbered ("❯ 1. Yes" / "  2. No") take the digit; a bare cursor list ("❯ No, exit" / "  Yes, I trust") takes arrows and Enter
export function screenOptions(text: string): ScreenOption[] {
  const lines = text.split("\n");
  const num: ScreenOption[] = [];
  for (const l of lines) {
    const m = l.match(/^\s*([❯›>])?\s*(\d{1,2})\.\s+(.+?)\s*$/);
    if (m && !num.some((o) => o.keys[0] === m[2])) num.push({ label: m[3], keys: [m[2]], selected: !!m[1] });
  }
  if (num.length >= 2) return num;
  const at = lines.findLastIndex((l) => /^\s*❯\s+\S/.test(l));
  if (at < 0) return [];
  const indent = lines[at].indexOf("❯") + 2;
  const item = (l: string) => l.length > indent && l.slice(0, indent).trim() === "" && l[indent] !== " ";
  let a = at, b = at;
  while (a > 0 && item(lines[a - 1])) a--;
  while (b < lines.length - 1 && item(lines[b + 1])) b++;
  if (b === a) return [];
  return lines.slice(a, b + 1).map((l, i) => {
    const d = i - (at - a);
    return { label: l.replace(/^\s*❯?\s*/, "").trim(), keys: [...Array(Math.abs(d)).fill(d < 0 ? "up" : "down"), "enter"].slice(0, 10), selected: d === 0 };
  });
}

// the paragraph of a reply that asks you something, if any
export function lastQuestion(text: string): string | null {
  const paras = text.trim().split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const tail = paras.slice(-2).reverse().find((p) => /\?\s*(\*\*)?\s*$/m.test(p) || /\?["”)]?\s*$/.test(p));
  return tail ?? null;
}

export function tailLines(path: string, bytes = 512_000): string[] {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size, start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString("utf8").split("\n");
    return start ? lines.slice(1) : lines;
  } finally { closeSync(fd); }
}

function claudeTranscript(db: Database, sid: string): string | null {
  const row: any = db.query("SELECT transcript_path FROM sessions WHERE id=?").get(`claude:${sid}`);
  if (row?.transcript_path && existsSync(row.transcript_path)) return row.transcript_path;
  const base = join(homedir(), ".claude", "projects");
  try { for (const d of readdirSync(base)) { const p = join(base, d, sid + ".jsonl"); if (existsSync(p)) return p; } } catch {}
  return null;
}

export function createLive(db: Database, onChange: () => void) {
  const since = new Map<string, { status: string; at: string }>();
  const projects = new Map<string, any>();
  const asks = new Map<string, AskQuestion[]>(); // session id -> questions from the PreToolUse hook
  const extras = new Map<string, AskExtras>();
  const blobs = new Map<number, { sid: string; media_type: string; data: Buffer }>();
  let nextBlob = 1;
  const transcripts = new Map<string, string>(); // session id -> transcript, to read again once the dialog shows
  const dropAsk = (sid: string) => { asks.delete(sid); extras.delete(sid); transcripts.delete(sid); for (const [k, b] of blobs) if (b.sid === sid) blobs.delete(k); };
  let cache: { at: number; agents: LiveAgent[]; error: string | null } = { at: 0, agents: [], error: null };
  let inflight: Promise<typeof cache> | null = null;
  let sig = "";

  const projectOf = (cwd: string) => {
    if (!projects.get(cwd)?.id) { // unknown projects are looked up again: the first turn may land later
      const ref = projectFor(cwd);
      const p: any = db.query("SELECT * FROM projects WHERE key=?").get(ref.key);
      projects.set(cwd, p ? projectBadge(p) : { id: null, name: ref.name, icon_url: null, initial: ref.name.slice(0, 1).toUpperCase() });
    }
    return projects.get(cwd);
  };

  async function load() {
    let list: any[];
    try { list = (await herdr(["agent", "list"])).agents ?? []; }
    catch (e: any) { return (cache = { at: Date.now(), agents: [], error: `herdr is not reachable: ${e.message}` }); }
    const agents: LiveAgent[] = [];
    for (const a of list) {
      let status = (a.agent_status ?? "unknown") as LiveAgent["status"];
      const prev = since.get(a.pane_id);
      const sid = a.agent_session?.value ?? null;
      // herdr misses some dialogs (the side-by-side preview layout reads as done); our hook knows a question is
      // open, so the screen decides: still showing the dialog = blocked, gone = the question was answered
      if (sid && asks.has(sid) && status !== "blocked" && status !== "working") {
        if (await dialogOpen(a.pane_id)) status = "blocked"; else dropAsk(sid);
      }
      if (!prev || prev.status !== status) {
        if (prev?.status === "blocked" && sid) dropAsk(sid); // the dialog closed: answered or cancelled
        since.set(a.pane_id, { status, at: new Date().toISOString() });
      }
      const cwd = a.foreground_cwd || a.cwd || "";
      const x: LiveAgent = { pane_id: a.pane_id, agent: a.agent, status, title: a.terminal_title_stripped || a.agent, cwd, session_id: sid, since: since.get(a.pane_id)!.at, project: cwd ? projectOf(cwd) : null };
      if (status === "blocked") {
        x.ask = (sid && asks.get(sid)) || undefined;
        // the hook runs before Claude flushes the turn's last lines; once the dialog shows they are on disk
        const tp0 = sid ? transcripts.get(sid) : undefined;
        if (x.ask && sid && tp0 && existsSync(tp0)) {
          const e = extras.get(sid);
          if (!e?.context && !e?.attachments.length) setExtras(sid, askExtras(tp0));
          transcripts.delete(sid); // read once
        }
        if (x.ask && sid && extras.has(sid)) x.ask_extras = extras.get(sid);
        const tp = !x.ask && a.agent === "claude" && sid ? claudeTranscript(db, sid) : null;
        if (tp) x.ask = pendingAsk(tailLines(tp)) ?? undefined; // older Claude versions write it early
        if (!x.ask) {
          const text: string = await herdr(["agent", "read", a.pane_id, "--source", "visible"], 5000, true).catch(() => "");
          // drop Nerd Font icons (private-use code points) and shorten the full-width rules
          const lines = String(text).replace(/[\u{E000}-\u{F8FF}\u{F0000}-\u{FFFFD}]/gu, "").split("\n").map((l) => /^[\s─━═]{20,}$/.test(l) ? "────" : l.trimEnd());
          while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
          const shown = lines.slice(-30).join("\n");
          x.screen = { text: redact(shown), options: screenOptions(shown).map((o) => ({ ...o, label: redact(o.label) })) };
        }
      }
      if ((status === "done" || status === "idle" || status === "blocked") && sid) {
        const t: any = db.query("SELECT id, headline, final_text, ended_at FROM turns WHERE session_id=? ORDER BY started_at DESC LIMIT 1").get(sid);
        if (t?.final_text) x.last = { turn_id: t.id, headline: t.headline, text: t.final_text.length > 4000 ? "…" + t.final_text.slice(-4000) : t.final_text, question: lastQuestion(t.final_text), ended_at: t.ended_at };
      }
      agents.push(x);
    }
    for (const k of since.keys()) if (!list.some((a) => a.pane_id === k)) since.delete(k);
    return (cache = { at: Date.now(), agents, error: null });
  }

  // Claude's and Codex's dialogs end with a key hint line that has "Esc to cancel"
  async function dialogOpen(pane: string) {
    const text: string = await herdr(["agent", "read", pane, "--source", "visible"], 5000, true).catch(() => "");
    return /Esc to cancel/i.test(text.split("\n").filter((l) => l.trim()).slice(-4).join("\n"));
  }

  async function get(maxAgeMs = 2000) {
    if (Date.now() - cache.at < maxAgeMs) return cache;
    inflight ??= load().finally(() => { inflight = null; });
    return inflight;
  }

  // poll while someone has the UI open, and tell it when an agent changes state or asks something new
  async function tick(watching: boolean) {
    if (!watching) return;
    const c = await get(0);
    const s = JSON.stringify(c.agents.map((a) => [a.pane_id, a.status, a.ask?.map((q) => q.question), a.screen?.text.slice(-400), a.last?.turn_id]));
    if (s !== sig) { if (sig) onChange(); sig = s; }
  }

  async function find(pane: string) {
    if (!/^[\w:-]{1,64}$/.test(pane)) return null;
    return (await get(0)).agents.find((a) => a.pane_id === pane) ?? null;
  }

  const KEY = /^(\d|esc|enter|up|down|left|right|tab|space|y|n)$/;
  async function keys(pane: string, ks: unknown) {
    const a = await find(pane);
    if (!a) return { error: "that agent is gone", status: 404 };
    if (!Array.isArray(ks) || !ks.length || ks.length > 10 || !ks.every((k) => typeof k === "string" && KEY.test(k))) return { error: "keys must be 1 to 10 of: a digit, esc, enter, up, down, left, right, tab, space, y, n", status: 400 };
    await herdr(["agent", "send-keys", pane, ...(ks as string[])]);
    cache.at = 0;
    return { ok: true };
  }

  // a message for the agent. An open AskUserQuestion is cancelled first and the answers go in as the
  // next prompt: key-driving that dialog (tabs, multi-select, Submit) breaks with each Claude Code release.
  async function prompt(pane: string, text: unknown) {
    const a = await find(pane);
    if (!a) return { error: "that agent is gone", status: 404 };
    if (typeof text !== "string" || !text.trim() || text.length > 20000) return { error: "send 1 to 20000 characters of text", status: 400 };
    if (a.status === "working") return { error: "the agent is working; send when it is done", status: 409 };
    if (a.status === "blocked") {
      if (!a.ask) return { error: "the agent shows a dialog; pick one of its choices first", status: 409 };
      await herdr(["agent", "send-keys", pane, "esc"]);
      // the answer must not go into a dialog that is still open
      // herdr's state alone is not enough (it can read done while the dialog shows), so the screen must agree
      let ok = false;
      for (let i = 0; i < 16 && !ok; i++) {
        await Bun.sleep(500);
        const st = (await herdr(["agent", "get", pane]).catch(() => null))?.agent?.agent_status;
        ok = (st === "idle" || st === "done") && !(await dialogOpen(pane));
      }
      if (!ok) { cache.at = 0; return { error: "the dialog did not close; nothing was sent. Look at the pane and try again", status: 409 }; }
    }
    await herdr(["agent", "prompt", pane, text], 15000);
    cache.at = 0;
    return { ok: true };
  }

  const RASTER = /^image\/(png|jpeg|gif|webp)$/;
  const str = (v: any, max: number) => (typeof v === "string" && v ? v.slice(0, max) : undefined);
  function noteAsk(sid: unknown, questions: unknown, extra: any = {}) {
    if (typeof sid !== "string" || !Array.isArray(questions)) return false;
    const qs = questions.slice(0, 8).map((q: any) => ({ question: String(q?.question ?? ""), header: str(q?.header, 40), multiSelect: !!q?.multiSelect,
      options: (Array.isArray(q?.options) ? q.options : []).slice(0, 12).map((o: any) => ({ label: String(o?.label ?? ""), description: str(o?.description, 500), preview: str(o?.preview, 8000) })) }));
    dropAsk(sid);
    asks.set(sid, qs);
    // read back later from disk, so only a transcript (.jsonl), never any file a client names
    if (typeof extra.transcript_path === "string" && extra.transcript_path.endsWith(".jsonl")) transcripts.set(sid, extra.transcript_path);
    setExtras(sid, extra);
    cache.at = 0;
    return true;
  }
  function setExtras(sid: string, extra: any) {
    for (const [k, b] of blobs) if (b.sid === sid) blobs.delete(k);
    const atts: AskAttachment[] = [];
    for (const a of (Array.isArray(extra.attachments) ? extra.attachments : []).slice(0, 12)) {
      if (a?.kind !== "sent" && a?.kind !== "artifact") continue;
      const id = nextBlob++;
      const att: AskAttachment = { id, kind: a.kind, name: String(a.name ?? "").slice(0, 300) };
      // artifacts link out only to claude.ai, the same rule as everywhere else
      if (a.kind === "artifact" && typeof a.url === "string" && /^https:\/\/claude\.ai\//.test(a.url)) att.url = a.url;
      if (typeof a.data === "string" && RASTER.test(a.media_type ?? "") && a.data.length <= 2_100_000) {
        blobs.set(id, { sid, media_type: a.media_type, data: Buffer.from(a.data, "base64") });
        att.media_type = a.media_type;
        att.src = `/api/asks/attachments/${id}`;
      }
      atts.push(att);
    }
    const ctx = str(extra.context, 4000);
    extras.set(sid, { context: ctx && redact(ctx), attachments: atts });
  }
  const blob = (id: number) => blobs.get(id) ?? null;

  return { get, tick, keys, prompt, noteAsk, blob };
}
