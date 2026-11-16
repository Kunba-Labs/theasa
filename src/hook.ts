// The Stop hook. Runs inside the agent's turn, so: fast, quiet, always exit 0.
import { tailLines } from "./live";
import { existsSync, readFileSync, writeFileSync, readdirSync, unlinkSync, openSync, readSync, fstatSync, closeSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { createHash, randomBytes } from "crypto";
import { parseClaude, parseCodex, type Turn, type Tokens, type Agent } from "./parse";
import { projectFor, type ProjectRef } from "./git";
import { findIcon } from "./icon";
import { HOME, ensureHome, machine, serverUrl, readToken } from "./config";

type Offset = { offset: number; base?: Tokens; session_id?: string; cwd?: string };
const sha = (s: string) => createHash("sha1").update(s).digest("hex");

function readFrom(path: string, offset: number): { text: string; size: number } {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const start = offset <= size ? offset : 0; // file shrank or was replaced: start over
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    return { text: buf.toString("utf8"), size };
  } finally { closeSync(fd); }
}

export function findCodexTranscript(sessionId: string): string | null {
  const root = join(homedir(), ".codex", "sessions");
  if (!sessionId || !existsSync(root)) return null;
  // newest days first; rollout file names end with the session id
  const walk = (dir: string, depth: number): string | null => {
    let names: string[];
    try { names = readdirSync(dir).sort().reverse(); } catch { return null; }
    for (const n of names) {
      const p = join(dir, n);
      if (depth < 3) { const r = walk(p, depth + 1); if (r) return r; }
      else if (n.endsWith(`${sessionId}.jsonl`)) return p;
    }
    return null;
  };
  return walk(root, 0);
}

// Parse the transcript from the stored offset. Returns the turns and the next offset:
// the start of the last turn, so a turn that a Stop hook lets continue is read again in full.
export function readTurns(agent: Agent, path: string, prev: Offset | null, firstRunLastOnly = true): { turns: Turn[]; next: Offset } {
  const start = prev?.offset ?? 0;
  const { text, size } = readFrom(path, start);
  const lines = text.split("\n");
  let meta: { session_id?: string; cwd?: string } = { session_id: prev?.session_id, cwd: prev?.cwd };
  if (agent === "codex" && !meta.session_id) {
    try { const m = JSON.parse(lines[0]); if (m.type === "session_meta") meta = { session_id: m.payload.id ?? m.payload.session_id, cwd: m.payload.cwd }; } catch {}
  }
  let turns = agent === "claude" ? parseClaude(lines) : parseCodex(lines, prev?.base, meta);
  // byte offset of each line start
  const lineStart: number[] = [];
  let pos = start;
  for (const l of lines) { lineStart.push(pos); pos += Buffer.byteLength(l, "utf8") + 1; }
  const last = turns.at(-1);
  const next: Offset = last?.line != null
    ? { offset: lineStart[last.line], base: last.base, session_id: meta.session_id, cwd: last.cwd || meta.cwd }
    : { offset: prev?.offset ?? 0, base: prev?.base, session_id: meta.session_id, cwd: meta.cwd };
  if (!prev && firstRunLastOnly) turns = turns.slice(-1); // history is for `theasa backfill`
  void size;
  return { turns, next };
}

export async function post(path: string, body: any, timeoutMs = 2500): Promise<Response> {
  return fetch(serverUrl() + path, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${readToken()}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

function spool(body: any) {
  writeFileSync(join(HOME, "spool", `${Date.now()}-${randomBytes(4).toString("hex")}.json`), JSON.stringify(body));
}

export async function flushSpool(max = 50): Promise<{ sent: number; left: number }> {
  const dir = join(HOME, "spool");
  let files: string[] = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort(); } catch { return { sent: 0, left: 0 }; }
  let sent = 0;
  for (const f of files.slice(0, max)) {
    const p = join(dir, f);
    let body: any;
    try { body = JSON.parse(readFileSync(p, "utf8")); } catch { unlinkSync(p); continue; }
    const r = await post(body.__path ?? "/api/ingest", body).catch(() => null);
    if (!r) break; // still down
    if (r.ok || r.status === 400) { unlinkSync(p); sent++; if (r.ok && body.project) await sendIcon(body.project).catch(() => {}); } // 400 will never succeed: drop it
    else if (r.status === 401) break;
  }
  return { sent, left: Math.max(0, files.length - sent) };
}

export async function sendIcon(ref: ProjectRef, force = false) {
  const mark = join(HOME, "icons-sent", sha(ref.key));
  try { if (!force && Date.now() - Number(readFileSync(mark, "utf8").split(" ")[0]) < 86400e3) return; } catch {}
  const icon = findIcon(ref.root);
  const iconSha = icon ? sha(icon.data.toString("base64")) : "none";
  let prevSha = "";
  try { prevSha = readFileSync(mark, "utf8").split(" ")[1] ?? ""; } catch {}
  if (icon && iconSha !== prevSha) {
    const r = await post("/api/icon", { project_key: ref.key, mime: icon.mime, data: icon.data.toString("base64") }).catch(() => null);
    if (!r?.ok) return; // try again next turn
  }
  writeFileSync(mark, `${Date.now()} ${iconSha}`);
}

const IMG = /\.(png|jpe?g|gif|webp)$/i;
// images the agent handed to the user: the hook runs on the same machine, so it can attach a copy
export function embedSentImages(turns: Turn[]) {
  for (const t of turns) for (const a of t.attachments ?? []) {
    if (a.kind !== "sent" || a.data || !IMG.test(a.name)) continue;
    try {
      if (statSync(a.name).size > 1_500_000) continue;
      a.data = readFileSync(a.name).toString("base64");
      a.media_type = "image/" + (a.name.match(IMG)![1].toLowerCase().replace("jpg", "jpeg"));
    } catch {}
  }
}

export async function sendTurns(agent: Agent, turns: Turn[], cwdHint: string, transcript: string, summarize = true): Promise<boolean> {
  if (!turns.length) return true;
  embedSentImages(turns);
  // group by project (a session can cd into another repo, rare)
  const groups = new Map<string, { ref: ProjectRef; turns: Turn[] }>();
  for (const t of turns) {
    const ref = projectFor(t.cwd || cwdHint);
    if (!groups.has(ref.key)) groups.set(ref.key, { ref, turns: [] });
    groups.get(ref.key)!.turns.push(t);
  }
  let ok = true;
  for (const { ref, turns: ts } of groups.values()) {
    const body = { machine: machine(), transcript_path: transcript, summarize, project: ref, turns: ts.map(({ line, base, ...t }) => t) };
    const r = await post("/api/ingest", body).catch(() => null);
    if (!r || !(r.ok || r.status === 400)) { spool(body); ok = false; continue; }
    await sendIcon(ref).catch(() => {});
  }
  return ok;
}

// what the agent showed before it asked, in this turn: its text, files it sent (images embedded), artifacts it published
export function askExtras(transcript: unknown): { context?: string; attachments?: any[] } {
  if (typeof transcript !== "string" || !existsSync(transcript)) return {};
  try {
    // read back far enough to hold the current turn's prompt (a long turn starts before the last 512 KB).
    // parseClaude ignores lines until it sees a prompt, and an earlier turn ends before the current one starts,
    // so a window that parses to any turn holds the current prompt, and its last turn is the current turn.
    const size = statSync(transcript).size;
    let turns = parseClaude(tailLines(transcript));
    for (let read = 512_000, bytes = 4_000_000; !turns.length && read < size; read = bytes, bytes *= 4) turns = parseClaude(tailLines(transcript, bytes));
    const turn = turns.at(-1);
    if (!turn) return {};
    const att = (turn.attachments ?? []).filter((a) => a.dir === "out").slice(-12);
    embedSentImages([{ ...turn, attachments: att }]);
    let budget = 8_000_000; // ponytail: per question; larger images go without a preview
    for (const a of att) if (a.data) { if (a.data.length > budget) delete a.data; else budget -= a.data.length; }
    return { context: turn.final_text ? turn.final_text.slice(-4000) : undefined, attachments: att };
  } catch { return {}; }
}

// PreToolUse on AskUserQuestion: tell the server what is asked, then get out of the way (never blocks the tool)
export async function runAskHook() {
  try {
    if (process.env.THEASA_CHILD) return;
    const p: any = JSON.parse((await new Response(Bun.stdin.stream()).text()) || "{}");
    if (p.tool_name !== "AskUserQuestion" || !Array.isArray(p.tool_input?.questions)) return;
    await post("/api/asks", { agent: "claude", session_id: p.session_id, questions: p.tool_input.questions, transcript_path: p.transcript_path, ...askExtras(p.transcript_path) }, 3000);
  } catch {}
}

export async function runHook(agent: Agent) {
  try {
    if (process.env.THEASA_CHILD) return; // our own summariser
    // Codex started from inside a Claude session (codex-review.sh, a Bash tool call) is part of that Claude turn
    if (agent === "codex" && process.env.CLAUDECODE === "1") return;
    ensureHome();
    const raw = await new Response(Bun.stdin.stream()).text();
    let payload: any = {};
    try { payload = JSON.parse(raw || "{}"); } catch {}
    try { writeFileSync(join(HOME, `last-hook-${agent}.json`), raw.slice(0, 20000)); } catch {} // for `theasa status` and debugging
    let transcript: string | null = payload.transcript_path ?? null;
    if (!transcript && agent === "codex") transcript = findCodexTranscript(payload.session_id ?? payload.thread_id ?? "");
    if (!transcript || !existsSync(transcript)) return;
    const offFile = join(HOME, "offsets", sha(transcript) + ".json");
    let prev: Offset | null = null;
    try { prev = JSON.parse(readFileSync(offFile, "utf8")); } catch {}
    const { turns, next } = readTurns(agent, transcript, prev);
    const last = turns.at(-1);
    if (last && !last.final_text && payload.last_assistant_message) last.final_text = String(payload.last_assistant_message);
    await sendTurns(agent, turns, payload.cwd ?? "", transcript);
    writeFileSync(offFile, JSON.stringify(next));
    if (readdirSync(join(HOME, "spool")).length) await flushSpool(20).catch(() => {});
  } catch (e) {
    try { writeFileSync(join(HOME, "hook-error.log"), `${new Date().toISOString()} ${agent} ${String((e as any)?.stack ?? e)}\n`, { flag: "a" }); } catch {}
  }
}
