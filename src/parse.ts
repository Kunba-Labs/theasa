// Turns out of agent transcripts. Pure functions: lines in, turns out.
// Claude Code: ~/.claude/projects/<dir>/<session>.jsonl
// Codex:       ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
import { redact } from "./redact";

export type Agent = "claude" | "codex";
export type Tokens = { input: number; output: number; cache_read: number; cache_write: number };
export type FileChange = { path: string; add: number; del: number };
// in: what the user attached to the prompt. out: what the agent handed back (artifacts, sent files).
export type Attachment = { dir: "in" | "out"; kind: "image" | "file" | "document" | "artifact" | "sent"; name: string; url?: string; media_type?: string; data?: string; count?: number };
export type Turn = {
  agent: Agent;
  session_id: string;
  turn_key: string;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  tool_ms: number;
  prompt: string;
  final_text: string;
  model: string;
  tokens: Tokens;
  model_calls: number;
  tools: Record<string, number>;
  files: FileChange[];
  diffs: Record<string, string>; // unified diff text per file path, capped
  attachments: Attachment[];
  log: string; // chronological digest for the summariser, redacted, trimmed
  cwd: string;
  line?: number; // index of the line that starts the turn (for the hook's offset)
  base?: Tokens; // Codex: running token total before the turn
};

const LOG_LIMIT = 60_000;

export function trimMiddle(s: string, max = LOG_LIMIT): string {
  if (s.length <= max) return s;
  const half = Math.floor((max - 40) / 2);
  return s.slice(0, half) + "\n…[trimmed " + (s.length - 2 * half) + " chars]…\n" + s.slice(-half);
}

const ms = (a: string, b: string) => Math.max(0, Date.parse(b) - Date.parse(a));
const clock = (start: string, t: string) => {
  const s = Math.floor(ms(start, t) / 1000);
  return "+" + Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
};
const one = (s: string, n = 200) => s.replace(/\s+/g, " ").trim().slice(0, n);
const zero = (): Tokens => ({ input: 0, output: 0, cache_read: 0, cache_write: 0 });

const DIFF_FILE_LINES = 400, DIFF_TURN_CHARS = 150_000, IMG_MAX = 1_500_000;

function addDiff(diffs: Map<string, string[]>, path: string, lines: string[]) {
  const cur = diffs.get(path) ?? [];
  const room = DIFF_FILE_LINES - cur.length;
  if (room > 0) cur.push(...lines.slice(0, room));
  if (lines.length > room && !cur.at(-1)?.startsWith("…")) cur.push("… more lines not shown");
  diffs.set(path, cur);
}

function finishDiffs(diffs: Map<string, string[]>): Record<string, string> {
  const out: Record<string, string> = {};
  let total = 0;
  // smallest first, so one huge file does not push out the rest
  for (const [p, lines] of [...diffs.entries()].sort((a, b) => a[1].length - b[1].length)) {
    const text = redact(lines.join("\n"));
    if (total + text.length > DIFF_TURN_CHARS) { out[p] = "… diff not stored (the turn's diffs are too large)"; continue; }
    out[p] = text;
    total += text.length;
  }
  return out;
}

// one entry per artifact URL, counting repeat publishes
function finishAttachments(list: Attachment[]): Attachment[] {
  const out: Attachment[] = [];
  const byUrl = new Map<string, Attachment>();
  for (const a of list) {
    if (a.kind === "artifact" && a.url) {
      const prev = byUrl.get(a.url);
      if (prev) { prev.count = (prev.count ?? 1) + 1; if (a.name && prev.name.startsWith("http")) prev.name = a.name; continue; }
      byUrl.set(a.url, a);
    }
    if (a.kind === "artifact" && !a.url) continue; // publish that failed or never named its page
    out.push(a);
  }
  return out;
}

const ARTIFACT_URL = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9_-]+/;
const baseName = (p: string) => p.split("/").pop() || p;

function addFile(files: Map<string, FileChange>, path: string, add: number, del: number) {
  const f = files.get(path) ?? { path, add: 0, del: 0 };
  f.add += add;
  f.del += del;
  files.set(path, f);
}

function parseLines(lines: string[]): any[] {
  const out: any[] = [];
  lines.forEach((l, i) => {
    if (!l.trim()) return;
    try { const d = JSON.parse(l); if (d && typeof d === "object") { d.__i = i; out.push(d); } } catch { /* partial last line while the agent writes: skip */ }
  });
  return out;
}

// ---------- Claude Code ----------

function userText(d: any): string | null {
  const c = d.message?.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return null;
  if (c.some((x: any) => x?.type === "tool_result")) return null;
  return c.filter((x: any) => x?.type === "text").map((x: any) => x.text).join("\n");
}

function isClaudePrompt(d: any, curPromptId?: string): boolean {
  if (d.type !== "user" || d.isSidechain || d.isCompactSummary) return false;
  const t = userText(d);
  if (t == null || t.startsWith("<local-command")) return false;
  // meta entries (peer messages, wake-ups) start a turn only when they open a new prompt
  if (d.isMeta) return !!d.promptId && d.promptId !== curPromptId;
  return true;
}

export function cleanPrompt(t: string, originKind?: string, origin?: any): string {
  if (originKind === "peer" && origin?.body) return "Message from " + (origin.name ?? "another session") + ": " + origin.body;
  if (originKind === "task-notification" || t.startsWith("<task-notification")) {
    const s = t.match(/<summary>([\s\S]*?)<\/summary>/)?.[1];
    return "Background task finished" + (s ? ": " + one(s, 300) : ".");
  }
  const cmd = t.match(/<command-name>([\s\S]*?)<\/command-name>/)?.[1];
  if (cmd) {
    const args = t.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1] ?? "";
    return (cmd.trim() + " " + args.trim()).trim();
  }
  return t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim() || "(continued without a new prompt)";
}

function promptAttachments(d: any): Attachment[] {
  const c = d.message?.content;
  if (!Array.isArray(c)) return [];
  const out: Attachment[] = [];
  for (const b of c) {
    if (b?.type === "image") {
      const data = b.source?.type === "base64" && String(b.source.data ?? "").length <= IMG_MAX * 1.37 ? b.source.data : undefined;
      out.push({ dir: "in", kind: "image", name: "Pasted image", media_type: b.source?.media_type, data });
    } else if (b?.type === "document") {
      out.push({ dir: "in", kind: "document", name: b.title ?? b.source?.media_type ?? "Document", media_type: b.source?.media_type });
    }
  }
  return out;
}

function newTurn(d: any, prompt: string) {
  return {
    attachments: promptAttachments(d), diffs: new Map<string, string[]>(), artifacts: new Map<string, Attachment>(),
    key: d.uuid ?? d.promptId ?? d.timestamp, session_id: d.sessionId ?? "", promptId: d.promptId, line: d.__i,
    start: d.timestamp, end: d.timestamp, prompt, cwd: d.cwd ?? "", closed: false,
    model: "", lastText: "", calls: new Map(), tools: {} as Record<string, number>,
    files: new Map<string, FileChange>(), log: ["USER: " + one(prompt, 2000)], pending: new Map<string, string>(), tool_ms: 0,
  };
}

export function parseClaude(lines: string[], session_id = ""): Turn[] {
  const rows = parseLines(lines);
  const turns: Turn[] = [];
  let cur: any = null;

  const finish = () => {
    if (!cur) return;
    if (cur.calls.size > 0) {
      const tokens = zero();
      for (const u of cur.calls.values()) {
        tokens.input += u.input_tokens ?? 0;
        tokens.output += u.output_tokens ?? 0;
        tokens.cache_read += u.cache_read_input_tokens ?? 0;
        tokens.cache_write += u.cache_creation_input_tokens ?? 0;
      }
      turns.push({
        agent: "claude",
        session_id: cur.session_id || session_id,
        turn_key: cur.key,
        started_at: cur.start,
        ended_at: cur.end,
        duration_ms: ms(cur.start, cur.end),
        tool_ms: cur.tool_ms,
        prompt: redact(cur.prompt),
        final_text: redact(cur.lastText),
        model: cur.model,
        tokens,
        model_calls: cur.calls.size,
        tools: cur.tools,
        files: [...cur.files.values()],
        diffs: finishDiffs(cur.diffs),
        attachments: finishAttachments(cur.attachments),
        log: trimMiddle(redact(cur.log.join("\n"))),
        cwd: cur.cwd,
        line: cur.line,
      });
    }
    cur = null;
  };

  for (const d of rows) {
    if (d.isSidechain) continue;
    if (d.type === "user" && d.isCompactSummary && (!cur || cur.closed)) {
      // auto-compaction mid-work: the work goes on, so it is one turn
      finish();
      cur = newTurn(d, "Continued after the context was compacted.");
      continue;
    }
    if (isClaudePrompt(d, cur?.promptId)) {
      finish();
      cur = newTurn(d, cleanPrompt(userText(d) ?? "", d.origin?.kind, d.origin));
      continue;
    }
    if (!cur || cur.closed || !d.timestamp) continue;
    if (d.type === "attachment" && d.attachment?.type === "file" && d.attachment.filename && Date.parse(d.timestamp) - Date.parse(cur.start) < 5000) {
      if (!cur.attachments.some((a: Attachment) => a.name === d.attachment.filename)) cur.attachments.push({ dir: "in", kind: "file", name: d.attachment.filename });
      continue;
    }
    if (d.type === "system" && d.subtype === "turn_duration") { cur.end = d.timestamp; cur.closed = true; continue; }
    if (d.type === "assistant") {
      const m = d.message ?? {};
      if (m.model && m.model !== "<synthetic>") cur.model = m.model;
      if (m.id && m.usage) cur.calls.set(m.id, m.usage); // same usage repeats on every content block of one call
      cur.end = d.timestamp;
      for (const b of m.content ?? []) {
        if (b.type === "text" && b.text?.trim()) {
          cur.lastText = b.text;
          cur.log.push(clock(cur.start, d.timestamp) + " SAID: " + one(b.text, 600));
        } else if (b.type === "tool_use") {
          cur.tools[b.name] = (cur.tools[b.name] ?? 0) + 1;
          cur.pending.set(b.id, d.timestamp);
          const i = b.input ?? {};
          const what = i.command ?? i.file_path ?? i.pattern ?? i.description ?? i.url ?? i.query ?? "";
          cur.log.push(clock(cur.start, d.timestamp) + " " + b.name + ": " + one(String(what), 200));
          if (b.name === "SendUserFile") {
            for (const f of Array.isArray(i.files) ? i.files : []) cur.attachments.push({ dir: "out", kind: "sent", name: String(f) });
          } else if (b.name === "Artifact" && (i.action == null || i.action === "publish") && !i.asset) {
            const a: Attachment = { dir: "out", kind: "artifact", name: i.title ?? (i.file_path ? baseName(i.file_path) : ""), url: typeof i.url === "string" ? i.url : undefined };
            cur.attachments.push(a);
            cur.artifacts.set(b.id, a);
          }
        }
      }
    } else if (d.type === "user") {
      if (Array.isArray(d.message?.content) && d.message.content.some((b: any) => b?.type === "tool_result")) cur.end = d.timestamp;
      for (const b of d.message?.content ?? []) {
        if (b?.type !== "tool_result") continue;
        const t0 = cur.pending.get(b.tool_use_id);
        if (t0) cur.tool_ms += ms(t0, d.timestamp);
        const art = cur.artifacts.get(b.tool_use_id);
        if (art && !art.url) {
          const txt = typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "");
          art.url = txt.match(ARTIFACT_URL)?.[0];
        }
        if (b.is_error) cur.log.push(clock(cur.start, d.timestamp) + " ERROR: " + one(typeof b.content === "string" ? b.content : JSON.stringify(b.content), 300));
      }
      // ponytail: files written through Bash (echo >, sed -i) are not counted; only Edit/Write/MultiEdit results are.
      // Upgrade path: snapshot `git status` at UserPromptSubmit and diff it at Stop.
      const r = d.toolUseResult;
      if (r && typeof r === "object" && r.filePath) {
        if (Array.isArray(r.structuredPatch)) {
          let a = 0, x = 0;
          const text: string[] = [];
          for (const h of r.structuredPatch) {
            text.push(`@@ -${h.oldStart ?? 0},${h.oldLines ?? 0} +${h.newStart ?? 0},${h.newLines ?? 0} @@`);
            for (const line of h.lines ?? []) {
              text.push(line);
              if (line.startsWith("+")) a++; else if (line.startsWith("-")) x++;
            }
          }
          addFile(cur.files, r.filePath, a, x);
          if (r.structuredPatch.length) addDiff(cur.diffs, r.filePath, text);
          else if (r.type === "create" && typeof r.content === "string") {
            addFile(cur.files, r.filePath, r.content.split("\n").length, 0);
            addDiff(cur.diffs, r.filePath, ["@@ new file @@", ...r.content.split("\n").map((l: string) => "+" + l)]);
          }
        } else if (r.type === "create" && typeof r.content === "string") {
          addFile(cur.files, r.filePath, r.content.split("\n").length, 0);
          addDiff(cur.diffs, r.filePath, ["@@ new file @@", ...r.content.split("\n").map((l: string) => "+" + l)]);
        }
      }
    }
  }
  finish();
  return turns;
}

// ---------- Codex ----------

function codexToolNames(p: any): string[] {
  const input = String(p.input ?? p.arguments ?? "");
  if (p.name === "exec" || p.name === "js") {
    const inner = [...input.matchAll(/tools\.(\w+)\(/g)].map((m) => m[1]);
    if (inner.length) return inner;
  }
  return [p.name];
}

export function patchChanges(text: string, diffs?: Map<string, string[]>): FileChange[] {
  const files = new Map<string, FileChange>();
  let path = "";
  for (const raw of text.split(/\\n|\n/)) {
    const line = raw.replace(/\\"/g, '"').replace(/\\t/g, "\t");
    const h = line.match(/\*\*\* (Update|Add|Delete) File: (.+?)["'`]?\)?;?$/);
    if (h) { path = h[2].trim(); addFile(files, path, 0, 0); diffs && addDiff(diffs, path, [h[1] === "Add" ? "@@ new file @@" : h[1] === "Delete" ? "@@ deleted @@" : ""].filter(Boolean)); continue; }
    if (!path || line.startsWith("+++") || line.startsWith("---") || line.startsWith("***")) { if (line.startsWith("*** End")) path = ""; continue; }
    if (line.startsWith("+")) addFile(files, path, 1, 0);
    else if (line.startsWith("-")) addFile(files, path, 0, 1);
    if (diffs && (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ") || line.startsWith("@@"))) addDiff(diffs, path, [line]);
  }
  return [...files.values()];
}

export function parseCodex(lines: string[], prevTotal?: Tokens, meta?: { session_id?: string; cwd?: string }): Turn[] {
  const rows = parseLines(lines);
  const turns: Turn[] = [];
  let session_id = meta?.session_id ?? "", cwd = meta?.cwd ?? "";
  let lastTotal: Tokens = prevTotal ?? zero();
  let cur: any = null;

  const finish = (end: string, finalText: string) => {
    if (!cur) return;
    const t = cur.total ?? lastTotal;
    const tokens: Tokens = {
      input: Math.max(0, (t.input - t.cache_read) - (cur.base.input - cur.base.cache_read)),
      output: Math.max(0, t.output - cur.base.output),
      cache_read: Math.max(0, t.cache_read - cur.base.cache_read),
      cache_write: Math.max(0, t.cache_write - cur.base.cache_write),
    };
    lastTotal = t;
    turns.push({
      agent: "codex", session_id, turn_key: cur.key,
      started_at: cur.start, ended_at: end, duration_ms: ms(cur.start, end), tool_ms: cur.tool_ms,
      prompt: redact(cur.prompt), final_text: redact(finalText || cur.lastText), model: cur.model,
      tokens, model_calls: cur.calls, tools: cur.tools,
      files: (() => { const m = new Map<string, FileChange>(); for (const f of cur.files) addFile(m, f.path, f.add, f.del); return [...m.values()]; })(),
      diffs: finishDiffs(cur.diffs), attachments: finishAttachments(cur.attachments),
      log: trimMiddle(redact(["USER: " + one(cur.prompt, 2000), ...cur.log].join("\n"))), cwd,
      line: cur.line, base: cur.base,
    });
    cur = null;
  };

  for (const d of rows) {
    const p = d.payload ?? {};
    if (cur && d.timestamp) cur.lastTs = d.timestamp;
    if (d.type === "session_meta") { session_id = p.id ?? p.session_id ?? session_id; cwd = p.cwd ?? cwd; continue; }
    if (d.type === "turn_context") { if (cur) cur.model = p.model ?? cur.model; if (p.cwd) cwd = p.cwd; continue; }
    const t = p.type;
    if (d.type === "event_msg" && t === "task_started") {
      if (cur) finish(d.timestamp, "");
      cur = { key: p.turn_id, line: d.__i, start: d.timestamp, prompt: "", userMsgs: [] as string[], model: "", tools: {} as Record<string, number>,
        files: [] as FileChange[], log: [] as string[], pending: new Map<string, string>(), tool_ms: 0, calls: 0, lastText: "",
        diffs: new Map<string, string[]>(), attachments: [] as Attachment[],
        base: { ...lastTotal }, total: null as Tokens | null };
      continue;
    }
    if (!cur) continue;
    if (d.type === "event_msg" && t === "user_message" && p.message) { cur.prompt = String(p.message); continue; }
    if (d.type === "response_item" && t === "message" && p.role === "user") {
      for (const c of p.content ?? []) if (c?.type === "input_image") {
        const m = String(c.image_url ?? "").match(/^data:([^;]+);base64,(.*)$/);
        cur.attachments.push({ dir: "in", kind: "image", name: "Attached image", media_type: m?.[1], data: m && m[2].length <= IMG_MAX * 1.37 ? m[2] : undefined });
      }
    }
    if (d.type === "response_item" && t === "message" && p.role === "user" && !cur.prompt) {
      const txt = (p.content ?? []).map((c: any) => c.text ?? "").join("\n").trim();
      if (txt && !txt.startsWith("<")) cur.userMsgs.push(txt);
      continue;
    }
    if (d.type === "response_item" && t === "message" && p.role === "assistant") {
      const txt = (p.content ?? []).map((c: any) => c.text ?? "").join("\n").trim();
      if (txt) { cur.lastText = txt; cur.log.push(clock(cur.start, d.timestamp) + " SAID: " + one(txt, 600)); }
      continue;
    }
    if (d.type === "response_item" && (t === "function_call" || t === "custom_tool_call" || t === "local_shell_call")) {
      for (const n of codexToolNames(p)) cur.tools[n] = (cur.tools[n] ?? 0) + 1;
      if (p.call_id) cur.pending.set(p.call_id, d.timestamp);
      const input = String(p.input ?? p.arguments ?? "");
      cur.files.push(...patchChanges(input, cur.diffs));
      const cmd = input.match(/cmd:\s*["'`]([^"'`]{1,200})/)?.[1] ?? input;
      cur.log.push(clock(cur.start, d.timestamp) + " " + codexToolNames(p).join(",") + ": " + one(cmd, 200));
      continue;
    }
    if (d.type === "response_item" && (t === "function_call_output" || t === "custom_tool_call_output")) {
      const t0 = cur.pending.get(p.call_id);
      if (t0) cur.tool_ms += ms(t0, d.timestamp);
      continue;
    }
    if (d.type === "event_msg" && t === "token_count" && p.info?.total_token_usage) {
      const u = p.info.total_token_usage;
      cur.total = { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cache_read: u.cached_input_tokens ?? 0, cache_write: u.cache_write_input_tokens ?? 0 };
      cur.calls++;
      continue;
    }
    if (d.type === "event_msg" && (t === "task_complete" || t === "turn_aborted")) {
      if (!cur.prompt) cur.prompt = cur.userMsgs.at(-1) ?? "";
      if (t === "turn_aborted") cur.log.push(clock(cur.start, d.timestamp) + " ABORTED by the user");
      finish(d.timestamp, p.last_agent_message ?? "");
    }
  }
  // Codex runs the Stop hook before it writes task_complete: close the open turn at its last event
  if (cur) {
    if (!cur.prompt) cur.prompt = cur.userMsgs.at(-1) ?? "";
    finish(cur.lastTs ?? cur.start, "");
  }
  return turns;
}

export function lastTotal(lines: string[]): Tokens | undefined {
  let t: Tokens | undefined;
  for (const d of parseLines(lines)) {
    const u = d.payload?.type === "token_count" ? d.payload.info?.total_token_usage : null;
    if (u) t = { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cache_read: u.cached_input_tokens ?? 0, cache_write: u.cache_write_input_tokens ?? 0 };
  }
  return t;
}
