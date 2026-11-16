// bun test. One file: the logic that would hurt if it broke.
import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const TMP = mkdtempSync(join(tmpdir(), "theasa-test-"));
process.env.THEASA_HOME = join(TMP, "home");
process.env.THEASA_CLAUDE_SETTINGS = join(TMP, "claude-settings.json");
process.env.THEASA_CODEX_HOOKS = join(TMP, "codex-hooks.json");
// a fake herdr: `agent list` prints herdr-list.json, every call is logged
process.env.THEASA_HERDR_BIN = join(TMP, "herdr");
writeFileSync(join(TMP, "herdr"), `#!/bin/sh\necho "$@" >> "${TMP}/herdr.log"\ncase "$1 $2" in\n  "agent list") cat "${TMP}/herdr-list.json" ;;\n  "agent wait") [ -f "${TMP}/wait-fails" ] && exit 1; echo '{"result":{}}' ;;\n  "agent get") [ -f "${TMP}/wait-fails" ] && echo '{"result":{"agent":{"agent_status":"blocked"}}}' || echo '{"result":{"agent":{"agent_status":"done"}}}' ;;\n  "agent read") [ -f "${TMP}/screen.txt" ] && cat "${TMP}/screen.txt" && exit 0; printf ' Allow this?\\n ❯ 1. Yes\\n   2. No\\n' ;;\n  *) echo '{"result":{"type":"ok"}}' ;;\nesac\n`, { mode: 0o755 });

const { parseClaude, parseCodex, patchChanges, trimMiddle } = await import("./src/parse");
const { redact } = await import("./src/redact");
const { normRemote, stripWorktree } = await import("./src/git");
const { score } = await import("./src/icon");
const { openDb } = await import("./src/db");
const { createApp, ingest, isFileName, shq } = await import("./src/server");
const { ensureHome, HOME } = await import("./src/config");
const { normalise, storeSummary, startWorker, enqueue } = await import("./src/summarize");
const { install, uninstall } = await import("./src/install");
const { readTurns, askExtras } = await import("./src/hook");
const { setTableForTest } = await import("./src/prices");
const { pendingAsk, screenOptions, lastQuestion } = await import("./src/live");

const L = (...o: any[]) => o.map((x) => JSON.stringify(x));
const ts = (s: number) => new Date(Date.UTC(2026, 10, 13, 10, 0, s)).toISOString();

const claudeLines = L(
  { type: "user", uuid: "u1", promptId: "p1", sessionId: "S", cwd: "/r", timestamp: ts(0), message: { content: "fix the bug" }, origin: { kind: "human" } },
  { type: "assistant", timestamp: ts(2), message: { id: "m1", model: "claude-opus-5-5", usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 }, content: [{ type: "thinking" }] } },
  { type: "assistant", timestamp: ts(3), message: { id: "m1", model: "claude-opus-5-5", usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 }, content: [{ type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/r/a.ts" } }] } },
  { type: "user", timestamp: ts(5), message: { content: [{ type: "tool_result", tool_use_id: "t1" }] }, toolUseResult: { filePath: "/r/a.ts", structuredPatch: [{ lines: [" x", "+a", "+b", "-c"] }] } },
  { type: "assistant", timestamp: ts(8), message: { id: "m2", model: "claude-opus-5-5", usage: { input_tokens: 1, output_tokens: 7, cache_read_input_tokens: 200, cache_creation_input_tokens: 0 }, content: [{ type: "text", text: "Fixed. The key is sk-ant-abcdefghijklmnop123." }] } },
  { type: "system", subtype: "turn_duration", durationMs: 8000, timestamp: ts(8) },
  { type: "user", isMeta: true, timestamp: ts(500), message: { content: "<local-command-caveat>x</local-command-caveat>" } },
  { type: "user", uuid: "u2", promptId: "p2", isMeta: true, sessionId: "S", cwd: "/r", timestamp: ts(600), message: { content: "Another Claude session sent a message: ..." }, origin: { kind: "peer", name: "Reviewer", body: "prod is down" } },
  { type: "assistant", timestamp: ts(605), message: { id: "m3", model: "claude-opus-5-5", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text: "Looking." }] } },
);

test("claude: one call's usage counts once, turn ends at turn_duration, peer messages start a turn, secrets masked", () => {
  const turns = parseClaude(claudeLines);
  expect(turns.length).toBe(2);
  const [a, b] = turns;
  expect(a.tokens).toEqual({ input: 11, output: 12, cache_read: 300, cache_write: 20 });
  expect(a.model_calls).toBe(2);
  expect(a.ended_at).toBe(ts(8)); // the meta line at +500 s does not stretch it
  expect(a.duration_ms).toBe(8000);
  expect(a.tool_ms).toBe(2000);
  expect(a.files).toEqual([{ path: "/r/a.ts", add: 2, del: 1 }]);
  expect(a.tools).toEqual({ Edit: 1 });
  expect(a.final_text).toContain("sk-ant-[masked]");
  expect(a.final_text).not.toContain("abcdefghijklmnop");
  expect(b.prompt).toBe("Message from Reviewer: prod is down");
  expect(a.line).toBe(0);
  expect(b.line).toBe(7);
});

const codexLines = L(
  { type: "session_meta", timestamp: ts(0), payload: { id: "CX", cwd: "/c", originator: "codex_cli_rs" } },
  { type: "event_msg", timestamp: ts(1), payload: { type: "task_started", turn_id: "T1" } },
  { type: "turn_context", timestamp: ts(1), payload: { model: "gpt-6-sol", cwd: "/c" } },
  { type: "event_msg", timestamp: ts(1), payload: { type: "user_message", message: "add retries" } },
  { type: "response_item", timestamp: ts(2), payload: { type: "custom_tool_call", name: "exec", call_id: "c1", input: 'await tools.apply_patch("*** Begin Patch\\n*** Update File: src/x.ts\\n@@\\n-old\\n+new\\n+more\\n*** End Patch")' } },
  { type: "response_item", timestamp: ts(4), payload: { type: "custom_tool_call_output", call_id: "c1" } },
  { type: "event_msg", timestamp: ts(4), payload: { type: "token_count", info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 50 } } } },
  { type: "event_msg", timestamp: ts(6), payload: { type: "task_complete", turn_id: "T1", last_agent_message: "Done." } },
  { type: "event_msg", timestamp: ts(10), payload: { type: "task_started", turn_id: "T2" } },
  { type: "event_msg", timestamp: ts(10), payload: { type: "user_message", message: "and tests" } },
  { type: "event_msg", timestamp: ts(12), payload: { type: "token_count", info: { total_token_usage: { input_tokens: 3000, cached_input_tokens: 2000, output_tokens: 80 } } } },
  { type: "event_msg", timestamp: ts(13), payload: { type: "task_complete", turn_id: "T2", last_agent_message: "Tests added." } },
);

test("codex: tokens per turn are the difference of running totals, patches give file changes", () => {
  const [a, b] = parseCodex(codexLines);
  expect(a.session_id).toBe("CX");
  expect(a.prompt).toBe("add retries");
  expect(a.tokens).toEqual({ input: 400, output: 50, cache_read: 600, cache_write: 0 });
  expect(b.tokens).toEqual({ input: 600, output: 30, cache_read: 1400, cache_write: 0 });
  expect(a.files).toEqual([{ path: "src/x.ts", add: 2, del: 1 }]);
  expect(a.tools).toEqual({ apply_patch: 1 });
  expect(a.tool_ms).toBe(2000);
  expect(b.final_text).toBe("Tests added.");
});

test("patchChanges and trimMiddle", () => {
  expect(patchChanges("*** Add File: a\n+1\n+2\n*** Delete File: b\n")).toEqual([{ path: "a", add: 2, del: 0 }, { path: "b", add: 0, del: 0 }]);
  const t = trimMiddle("x".repeat(100), 60);
  expect(t.length).toBeLessThanOrEqual(80);
  expect(t).toContain("[trimmed");
});

test("redact masks keys, tokens and KEY=value secrets", () => {
  const s = redact("STRIPE_SECRET_KEY=sk_live_abc123456789xyz Authorization: Bearer abcdefghijklmnopqrstuvwx ghp_abcdefghijklmnopqrstuvwxyz123 postgres://u:hunter22@db/x"); // gitleaks:allow (fake key: the redact test input)
  expect(s).not.toContain("abc123456789xyz");
  expect(s).not.toContain("abcdefghijklmnopqrstuvwx ");
  expect(s).not.toContain("ghp_abcdefghij");
  expect(s).not.toContain("hunter22");
  expect(redact("PORT=4747 name=theasa")).toBe("PORT=4747 name=theasa");
});

test("project identity: remotes normalise, worktrees map to their repo, icons rank", () => {
  expect(normRemote("git@git.example.com:api-server/api-server.git")).toBe("git.example.com/api-server/api-server");
  expect(normRemote("https://GitHub.com/example-org/crm.git")).toBe("github.com/example-org/crm");
  expect(normRemote("ssh://git@host:2222/a/b.git")).toBe("host/a/b");
  expect(stripWorktree("/x/api-server/.claude/worktrees/agent-1/sub")).toBe("/x/api-server");
  expect(score("ios/Runner/Assets.xcassets/AppIcon.appiconset/Icon-App-1024x1024@1x.png")).toBeGreaterThan(score("public/apple-touch-icon.png"));
  expect(score("public/apple-touch-icon.png")).toBeGreaterThan(score("public/favicon.svg"));
  expect(score("src/thing.png")).toBe(0);
});

test("install adds one hook, keeps others, twice is a no-op, uninstall restores the bytes", () => {
  const orig = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "bash ~/.claude/hooks/codex-review.sh" }] }] }, model: "opus" }, null, 2) + "\n";
  writeFileSync(process.env.THEASA_CLAUDE_SETTINGS!, orig);
  install();
  const after = readFileSync(process.env.THEASA_CLAUDE_SETTINGS!, "utf8");
  const j = JSON.parse(after);
  expect(j.hooks.Stop.length).toBe(2);
  expect(j.hooks.PreToolUse[0]).toMatchObject({ matcher: "AskUserQuestion" });
  expect(j.hooks.PreToolUse[0].hooks[0].command).toContain("hook claude-ask");
  expect(j.hooks.Stop[0].hooks[0].command).toContain("codex-review.sh");
  expect(JSON.parse(readFileSync(process.env.THEASA_CODEX_HOOKS!, "utf8")).hooks.Stop[0].hooks[0].command).toContain("hook codex");
  const tokenBefore = readFileSync(join(process.env.THEASA_HOME!, "token"), "utf8");
  install();
  expect(readFileSync(process.env.THEASA_CLAUDE_SETTINGS!, "utf8")).toBe(after);
  expect(readFileSync(join(process.env.THEASA_HOME!, "token"), "utf8")).toBe(tokenBefore);
  uninstall();
  expect(readFileSync(process.env.THEASA_CLAUDE_SETTINGS!, "utf8")).toBe(orig);
  expect(existsSync(process.env.THEASA_CODEX_HOOKS!)).toBe(false); // it did not exist before
});

test("hook offsets: the last turn is read again, so a continued turn comes back whole", () => {
  const f = join(TMP, "t.jsonl");
  writeFileSync(f, claudeLines.slice(0, 6).join("\n") + "\n");
  const r1 = readTurns("claude", f, null);
  expect(r1.turns.length).toBe(1);
  expect(r1.next.offset).toBe(0);
  writeFileSync(f, claudeLines.join("\n") + "\n");
  const r2 = readTurns("claude", f, r1.next);
  expect(r2.turns.map((t) => t.turn_key)).toEqual(["u1", "u2"]);
  expect(r2.next.offset).toBe(Buffer.byteLength(claudeLines.slice(0, 7).join("\n") + "\n"));
});

let db: any, app: any;
beforeAll(() => {
  setTableForTest({ "claude-opus-5-5": { input_cost_per_token: 5e-6, output_cost_per_token: 25e-6, cache_read_input_token_cost: 5e-7, cache_creation_input_token_cost: 6.25e-6 } });
  db = openDb(join(TMP, "t.db"));
  app = createApp(db, { token: "secret-token" });
});
const P = { key: "git.x/a/b", name: "b", root: "/r", remote: "git.x/a/b", branch: "main", head: "abc" };
const AUTH = { headers: { authorization: "Bearer secret-token" } };
const req = (path: string, body?: any, token = "secret-token") => app.handle(new Request("http://x" + path, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + token }, body: JSON.stringify(body) }));

test("ingest: needs the token, stores once, prices the turn, queues a summary", async () => {
  const turns = parseClaude(claudeLines);
  expect((await req("/api/ingest", { machine: "m", project: P, turns }, "wrong")).status).toBe(401);
  expect((db.query("SELECT COUNT(*) n FROM turns").get() as any).n).toBe(0);
  const r1 = await (await req("/api/ingest", { machine: "m", project: P, turns })).json();
  const r2 = await (await req("/api/ingest", { machine: "m", project: P, turns })).json();
  expect(r1.stored).toBe(2);
  expect(r2.stored + r2.updated).toBe(0);
  const t: any = db.query("SELECT * FROM turns WHERE turn_key='u1'").get();
  expect(t.cost).toBeCloseTo(11 * 5e-6 + 12 * 25e-6 + 300 * 5e-7 + 20 * 6.25e-6, 10);
  expect(t.summary_status).toBe("queued");
  expect((db.query("SELECT COUNT(*) n FROM summary_jobs").get() as any).n).toBe(2);
});

test("summaries: verdict follows watch items, redo keeps done state, search finds it, pulse rolls up", async () => {
  const t: any = db.query("SELECT id FROM turns WHERE turn_key='u1'").get();
  const res = normalise({ headline: "The bug is fixed.", summary: ["The bug is fixed."], verdict: "clean", steps: [{ at: "+0:05", title: "Edit", text: "a.ts", tone: "good" }],
    decisions: [{ text: "Use a guard clause.", why: "Smaller diff.", alternative: "A rewrite." }], watch: [{ text: "Old caches keep the bug.", impact: "medium" }] });
  expect(res.verdict).toBe("watch");
  storeSummary(db, t.id, res);
  const w: any = db.query("SELECT id FROM watch_items WHERE turn_id=?").get(t.id);
  expect((await req(`/api/watch/${w.id}/done`, {})).status).toBe(200);
  storeSummary(db, t.id, res); // redo
  expect((db.query("SELECT status FROM watch_items WHERE turn_id=?").get(t.id) as any).status).toBe("done");
  const s = await (await app.handle(new Request("http://x/api/search?q=guard", AUTH))).json();
  expect(s[0].id).toBe(t.id);
  const p = await (await app.handle(new Request("http://x/api/pulse?range=month", AUTH))).json();
  expect(p.totals.turns).toBeGreaterThanOrEqual(0);
});

test("reads need the token: turn data, search, export; health, events and icons stay open", async () => {
  const t: any = db.query("SELECT id, project_id FROM turns WHERE turn_key='u1'").get();
  const closed = ["/api/pulse", "/api/projects", `/api/projects/${t.project_id}`, `/api/projects/${t.project_id}/export`, "/api/search?q=bug", `/api/turns/${t.id}`, `/api/turns/${t.id}/digest`, "/api/nope"];
  for (const p of closed) {
    expect((await app.handle(new Request("http://x" + p))).status).toBe(401);
    expect((await app.handle(new Request("http://x" + p, { headers: { authorization: "Bearer secret-tokeX" } }))).status).toBe(401);
  }
  expect((await app.handle(new Request("http://x/api/pulse", AUTH))).status).toBe(200);
  expect((await app.handle(new Request("http://x/health"))).status).toBe(200);
  expect((await app.handle(new Request(`http://x/api/projects/${t.project_id}/icon`))).status).toBe(404); // open, no icon yet
  const ev = await app.handle(new Request("http://x/api/events"));
  expect(ev.status).toBe(200);
  await ev.body?.cancel();
  // THEASA_OPEN_READS: turn data opens again, live screens and files do not
  const openApp = createApp(db, { token: "secret-token", openReads: true });
  expect((await openApp.handle(new Request("http://x/api/pulse"))).status).toBe(200);
  expect((await openApp.handle(new Request("http://x/api/agents"))).status).toBe(401);
});

test("hardening: owner-only data dir, quoted resume command, icons must be images", async () => {
  const { statSync } = await import("fs");
  ensureHome();
  expect(statSync(HOME).mode & 0o777).toBe(0o700);
  expect(shq("/r/plain-path.v2")).toBe("/r/plain-path.v2");
  expect(shq("/my repo")).toBe("'/my repo'");
  expect(shq("x'; rm -rf ~")).toBe(`'x'\\''; rm -rf ~'`);
  const t: any = db.query("SELECT id FROM turns WHERE turn_key='u1'").get();
  db.query("UPDATE turns SET cwd=? WHERE id=?").run("/r/my repo", t.id);
  expect((await (await app.handle(new Request(`http://x/api/turns/${t.id}`, AUTH))).json()).resume).toBe("cd '/r/my repo' && claude --resume S");
  db.query("UPDATE turns SET cwd='/r' WHERE id=?").run(t.id);
  expect((await req("/api/icon", { project_key: P.key, mime: "text/html", data: "PGgxPg==" })).status).toBe(400);
  expect((await req("/api/icon", { project_key: P.key, mime: "image/png", data: "iVBORw0KGgo=" })).status).toBe(200);
  // projectBadge: one icon URL and initial for project rows (and live agents)
  const row = (await (await app.handle(new Request("http://x/api/projects", AUTH))).json()).find((r: any) => r.key === P.key);
  expect(row.icon_url).toMatch(new RegExp(`^/api/projects/${row.id}/icon\\?v=[0-9a-f]{8}$`));
  expect([row.name, row.initial, row.has_icon]).toEqual(["b", "B", true]);
});

test("worker: a missing CLI fails 3 times, then the turn shows failed and retry re-queues", async () => {
  db.query("DELETE FROM summary_jobs").run();
  const t: any = db.query("SELECT id FROM turns WHERE turn_key='u2'").get();
  enqueue(db, t.id, "claude");
  const w = startWorker(db, { workDir: join(TMP, "work"), concurrency: 1, onChange: () => {}, bins: { claude: "/nonexistent/claude", codex: "/nonexistent/codex" } });
  for (let i = 0; i < 3; i++) {
    db.query("UPDATE summary_jobs SET next_at = '2000-01-01T00:00:00.000Z' WHERE status='queued'").run(); // skip the backoff wait
    await w.tick();
    await Bun.sleep(150);
  }
  w.stop();
  expect((db.query("SELECT summary_status FROM turns WHERE id=?").get(t.id) as any).summary_status).toBe("failed");
  const r = await (await req("/api/jobs/retry-failed", {})).json();
  expect(r.retried).toBe(1);
  expect((db.query("SELECT summary_status FROM turns WHERE id=?").get(t.id) as any).summary_status).toBe("queued");
});

test("parallel posts all land (WAL)", async () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ ...parseClaude(claudeLines)[0], turn_key: "par" + i, session_id: "P" + i }));
  await Promise.all(many.map((t) => req("/api/ingest", { machine: "m", project: P, turns: [t], summarize: false })));
  expect((db.query("SELECT COUNT(*) n FROM turns WHERE turn_key LIKE 'par%'").get() as any).n).toBe(20);
});

test("codex: a turn without task_complete yet (Stop fires first) is still returned", () => {
  const open = codexLines.slice(0, 7);
  const turns = parseCodex(open);
  expect(turns.length).toBe(1);
  expect(turns[0].prompt).toBe("add retries");
  expect(turns[0].ended_at).toBe(ts(4));
  expect(turns[0].tokens.output).toBe(50);
});

test("diffs and attachments: Edit hunks, pasted images, @-files, sent files, artifact URLs", () => {
  const lines = L(
    { type: "user", uuid: "x1", promptId: "q1", sessionId: "S2", cwd: "/r", timestamp: ts(0), message: { content: [{ type: "text", text: "look at this" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } }] } },
    { type: "attachment", timestamp: ts(0), attachment: { type: "file", filename: "/r/notes.md" } },
    { type: "assistant", timestamp: ts(1), message: { id: "n1", model: "m", usage: { output_tokens: 1 }, content: [
      { type: "tool_use", id: "e1", name: "Edit", input: { file_path: "/r/a.ts" } },
      { type: "tool_use", id: "s1", name: "SendUserFile", input: { files: ["/tmp/shot.png"] } },
      { type: "tool_use", id: "a1", name: "Artifact", input: { file_path: "/tmp/page.html", title: "Plan" } },
      { type: "tool_use", id: "a2", name: "Artifact", input: { action: "read", url: "https://claude.ai/artifact/READ" } },
    ] } },
    { type: "user", timestamp: ts(2), message: { content: [{ type: "tool_result", tool_use_id: "e1" }] }, toolUseResult: { filePath: "/r/a.ts", structuredPatch: [{ oldStart: 3, oldLines: 1, newStart: 3, newLines: 2, lines: [" ctx", "-old", "+new", "+more"] }] } },
    { type: "user", timestamp: ts(3), message: { content: [{ type: "tool_result", tool_use_id: "a1", content: "Updated the Artifact at https://claude.ai/artifact/AbC123 (Version 2)" }] } },
  );
  const [t] = parseClaude(lines);
  expect(t.diffs["/r/a.ts"]).toBe("@@ -3,1 +3,2 @@\n ctx\n-old\n+new\n+more");
  expect(t.attachments).toEqual([
    { dir: "in", kind: "image", name: "Pasted image", media_type: "image/png", data: "iVBORw0KGgo=" },
    { dir: "in", kind: "file", name: "/r/notes.md" },
    { dir: "out", kind: "sent", name: "/tmp/shot.png" },
    { dir: "out", kind: "artifact", name: "Plan", url: "https://claude.ai/artifact/AbC123" },
  ]);
  const files = patchChanges('*** Begin Patch\\n*** Update File: src/x.ts\\n@@ fn\\n-old\\n+new\\n*** End Patch', new Map());
  expect(files).toEqual([{ path: "src/x.ts", add: 1, del: 1 }]);
  const [c] = parseCodex(codexLines);
  expect(c.diffs["src/x.ts"]).toBe("@@\n-old\n+new\n+more");
});

test("attachments: only raster images are served; refresh keeps artifact titles and reindexes files", async () => {
  const base = { ...parseClaude(claudeLines)[0], turn_key: "att1", session_id: "ATT", files: [], diffs: {} };
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString("base64");
  const png = "iVBORw0KGgo=";
  await req("/api/ingest", { machine: "m", project: P, summarize: false, turns: [{ ...base, attachments: [
    { dir: "in", kind: "image", name: "x", media_type: "image/svg+xml", data: svg },
    { dir: "in", kind: "image", name: "y", media_type: "image/png", data: png },
    { dir: "out", kind: "artifact", name: "Plan v1.2", url: "https://claude.ai/artifact/T1" },
  ] }] });
  const id = (db.query("SELECT id FROM turns WHERE turn_key='att1'").get() as any).id;
  const rows = db.query("SELECT id, media_type FROM attachments WHERE turn_id=? AND kind='image' ORDER BY id").all(id) as any[];
  expect((await app.handle(new Request(`http://x/api/attachments/${rows[1].id}`))).status).toBe(401); // pasted images need the token
  expect((await app.handle(new Request(`http://x/api/attachments/${rows[0].id}`, { headers: { authorization: "Bearer secret-token" } }))).status).toBe(404);
  const ok = await app.handle(new Request(`http://x/api/attachments/${rows[1].id}`, { headers: { authorization: "Bearer secret-token" } }));
  expect(ok.status).toBe(200);
  expect(ok.headers.get("content-security-policy")).toContain("sandbox");
  // refresh: the same page now only known by its file name, and a new file path to find
  await req("/api/ingest", { machine: "m", project: P, summarize: false, refresh: true, turns: [{ ...base,
    files: [{ path: "/r/zebra-unique-file.ts", add: 1, del: 0 }],
    attachments: [{ dir: "out", kind: "artifact", name: "canvas.json", url: "https://claude.ai/artifact/T1" }] }] });
  expect((db.query("SELECT name FROM attachments WHERE turn_id=? AND kind='artifact'").get(id) as any).name).toBe("Plan v1.2");
  expect([isFileName("canvas.json"), isFileName("Plan v1.2"), isFileName("notes.v2")]).toEqual([true, false, true]);
  const found = await (await app.handle(new Request("http://x/api/search?q=zebra-unique-file", AUTH))).json();
  expect(found.map((r: any) => r.id)).toContain(id);
});

test("live: pending questions, dialog choices, reply questions", () => {
  const q = [{ question: "Which DB?", header: "DB", multiSelect: false, options: [{ label: "SQLite" }, { label: "Postgres" }] }];
  const use = { type: "assistant", message: { content: [{ type: "tool_use", id: "a1", name: "AskUserQuestion", input: { questions: q } }] } };
  const res = { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "a1", content: "answered" }] } };
  expect(pendingAsk(L(use))).toEqual(q);
  expect(pendingAsk(L(use, res))).toBeNull();
  expect(screenOptions(" Allow?\n ❯ 1. Yes\n   2. Yes, and don't ask again\n   3. No\n").map((o) => [o.label, o.keys, o.selected]))
    .toEqual([["Yes", ["1"], true], ["Yes, and don't ask again", ["2"], false], ["No", ["3"], false]]);
  expect(screenOptions(" Trust it?\n\n ❯ No, exit\n   Yes, I trust this folder\n\n Enter to confirm").map((o) => o.keys))
    .toEqual([["enter"], ["down", "enter"]]);
  expect(screenOptions("❯ \n just output")).toEqual([]);
  expect(lastQuestion("Done.\n\nShould I push it to main?")).toBe("Should I push it to main?");
  expect(lastQuestion("Done. Tests pass.")).toBeNull();
});

test("agents: lists herdr panes, keeps hook questions until the dialog closes, answers go in as a prompt", async () => {
  const list = (status: string) => writeFileSync(join(TMP, "herdr-list.json"), JSON.stringify({ result: { agents: [{ agent: "claude", pane_id: "w1:p1", agent_status: status, cwd: "/nowhere", terminal_title_stripped: "Demo", agent_session: { value: "SESS" } }] } }));
  const log = () => { try { return readFileSync(join(TMP, "herdr.log"), "utf8"); } catch { return ""; } };
  const get = async () => (await (await app.handle(new Request("http://x/api/agents", { headers: { authorization: "Bearer secret-token" } }))).json());
  const q = [{ question: "Which DB?", options: [{ label: "SQLite" }] }];
  list("working");
  expect((await get()).agents[0]).toMatchObject({ pane_id: "w1:p1", status: "working", title: "Demo" });
  expect((await req("/api/asks", { session_id: "SESS", questions: q }, "nope")).status).toBe(401);
  expect((await req("/api/asks", { session_id: "SESS", questions: q })).status).toBe(200);
  list("blocked");
  await new Promise((r) => setTimeout(r, 2100)); // past the 2 s cache
  const a = (await get()).agents[0];
  expect(a.ask[0].question).toBe("Which DB?");
  expect(a.screen).toBeUndefined();
  expect((await req("/api/agents/w1:p1/keys", { keys: ["rm -rf"] })).status).toBe(400);
  expect((await req("/api/agents/w9:p9/prompt", { text: "hi" })).status).toBe(404);
  writeFileSync(join(TMP, "wait-fails"), "");
  expect((await req("/api/agents/w1:p1/prompt", { text: "Lost answer" })).status).toBe(409); // dialog stayed open: nothing sent
  expect(log()).not.toContain("agent prompt w1:p1 Lost answer");
  require("fs").unlinkSync(join(TMP, "wait-fails"));
  await new Promise((r) => setTimeout(r, 10));
  expect((await req("/api/agents/w1:p1/prompt", { text: "Answers: SQLite" })).status).toBe(200);
  expect(log()).toContain("agent send-keys w1:p1 esc");
  expect(log()).toContain("agent prompt w1:p1 Answers: SQLite");
  list("working");
  await new Promise((r) => setTimeout(r, 2100));
  await get(); // the dialog closed: the hook questions are dropped
  list("blocked");
  await new Promise((r) => setTimeout(r, 2100));
  const b = (await get()).agents[0];
  expect(b.ask).toBeUndefined();
  expect(b.screen.options.map((o: any) => o.label)).toEqual(["Yes", "No"]);
  expect((await req("/api/agents/w1:p1/prompt", { text: "hi" })).status).toBe(409); // pick a choice first
  expect((await req("/api/agents/w1:p1/keys", { keys: ["2"] })).status).toBe(200);
  expect(log()).toContain("agent send-keys w1:p1 2");
}, 40000);

test("asks carry what the agent showed: option previews, its text, sent images and artifacts", async () => {
  const png = join(TMP, "design.png"), svg = join(TMP, "design.svg");
  writeFileSync(png, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));
  writeFileSync(svg, "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>");
  const tr = join(TMP, "ask-transcript.jsonl");
  writeFileSync(tr, L(
    { type: "user", uuid: "q1", promptId: "pq", sessionId: "ASK", cwd: "/r", timestamp: ts(0), message: { content: "give me icon options" }, origin: { kind: "human" } },
    { type: "assistant", timestamp: ts(5), message: { id: "x1", model: "claude-opus-5-5", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text: "Here are **three** icon options." }, { type: "tool_use", id: "s1", name: "SendUserFile", input: { files: [png, svg] } }, { type: "tool_use", id: "s2", name: "Artifact", input: { title: "Icon sheet", url: "https://claude.ai/artifact/abc" } }] } },
    { type: "user", timestamp: ts(6), message: { content: [{ type: "tool_result", tool_use_id: "s1" }, { type: "tool_result", tool_use_id: "s2" }] } },
  ).join("\n") + "\n");
  const ex = askExtras(tr);
  expect(ex.context).toContain("three");
  expect(ex.attachments!.map((a: any) => [a.kind, !!a.data])).toEqual([["sent", true], ["sent", false], ["artifact", false]]);
  expect(askExtras("/nope")).toEqual({});
  // a long turn: its prompt sits more than 512 KB before the question
  const long = join(TMP, "ask-long.jsonl");
  writeFileSync(long, L(
    { type: "user", uuid: "q2", promptId: "pl", sessionId: "ASK", cwd: "/r", timestamp: ts(0), message: { content: "make designs" }, origin: { kind: "human" } },
    { type: "assistant", timestamp: ts(5), message: { id: "y1", model: "claude-opus-5-5", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "build" } }] } },
    { type: "user", timestamp: ts(6), message: { content: [{ type: "tool_result", tool_use_id: "b1", content: "x".repeat(700_000) }] } },
    { type: "assistant", timestamp: ts(7), message: { id: "y2", model: "claude-opus-5-5", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text: "Two designs ready." }, { type: "tool_use", id: "s3", name: "SendUserFile", input: { files: [png] } }] } },
  ).join("\n") + "\n");
  // the window holds the end of an earlier turn and the whole current one: the current one wins
  const two = join(TMP, "ask-two.jsonl");
  writeFileSync(two, L(
    { type: "user", uuid: "e1", promptId: "pe", sessionId: "ASK", cwd: "/r", timestamp: ts(0), message: { content: "earlier" }, origin: { kind: "human" } },
    { type: "assistant", timestamp: ts(1), message: { id: "z0", model: "m", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "tool_use", id: "e2", name: "Bash", input: {} }] } },
    { type: "user", timestamp: ts(2), message: { content: [{ type: "tool_result", tool_use_id: "e2", content: "y".repeat(700_000) }] } },
    { type: "assistant", timestamp: ts(3), message: { id: "z1", model: "m", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text: "Earlier turn text." }, { type: "tool_use", id: "e3", name: "SendUserFile", input: { files: [svg] } }] } },
    { type: "user", uuid: "c1", promptId: "pc", sessionId: "ASK", cwd: "/r", timestamp: ts(9), message: { content: "current" }, origin: { kind: "human" } },
    { type: "assistant", timestamp: ts(10), message: { id: "z2", model: "m", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text: "Current turn text." }] } },
  ).join("\n") + "\n");
  const tx = askExtras(two);
  expect(tx.context).toBe("Current turn text.");
  expect(tx.attachments).toEqual([]);
  const lx = askExtras(long);
  expect(lx.context).toBe("Two designs ready.");
  expect(lx.attachments!.length).toBe(1);

  writeFileSync(join(TMP, "herdr-list.json"), JSON.stringify({ result: { agents: [{ agent: "claude", pane_id: "w2:p1", agent_status: "blocked", cwd: "/nowhere", agent_session: { value: "ASK" } }] } }));
  const q = [{ question: "Which icon?", options: [{ label: "A", preview: "[ eye ]" }, { label: "B" }] }];
  expect((await req("/api/asks", { session_id: "ASK", questions: q, ...ex, attachments: [...ex.attachments!, { kind: "sent", name: "evil.svg", media_type: "image/svg+xml", data: Buffer.from("<svg/>").toString("base64") }, { kind: "artifact", name: "x", url: "javascript:alert(1)" }] })).status).toBe(200);
  await new Promise((r) => setTimeout(r, 2100));
  const a = (await (await app.handle(new Request("http://x/api/agents", { headers: { authorization: "Bearer secret-token" } }))).json()).agents.find((x: any) => x.pane_id === "w2:p1");
  expect(a.ask[0].options[0].preview).toBe("[ eye ]");
  expect(a.ask_extras.context).toContain("three");
  const atts = a.ask_extras.attachments;
  expect(atts.map((x: any) => !!x.src)).toEqual([true, false, false, false, false]); // only the png is served
  expect(atts[2].url).toBe("https://claude.ai/artifact/abc");
  expect(atts[4].url).toBeUndefined(); // a javascript: link is dropped
  const img = await app.handle(new Request("http://x" + atts[0].src, { headers: { authorization: "Bearer secret-token" } }));
  expect(img.status).toBe(200);
  expect(img.headers.get("content-type")).toBe("image/png");
  expect((await app.handle(new Request("http://x/api/agents"))).status).toBe(401); // screens and sent files need the token
  expect((await app.handle(new Request("http://x" + atts[0].src))).status).toBe(401);
  expect((await app.handle(new Request("http://x/api/asks/attachments/999999", { headers: { authorization: "Bearer secret-token" } }))).status).toBe(404);
}, 40000);

test("a question herdr reads as done stays open while the screen shows the dialog", async () => {
  const list = (status: string) => writeFileSync(join(TMP, "herdr-list.json"), JSON.stringify({ result: { agents: [{ agent: "claude", pane_id: "w3:p1", agent_status: status, cwd: "/nowhere", agent_session: { value: "PREV" } }] } }));
  const get = async () => (await (await app.handle(new Request("http://x/api/agents", { headers: { authorization: "Bearer secret-token" } }))).json()).agents.find((x: any) => x.pane_id === "w3:p1");
  list("working");
  await req("/api/asks", { session_id: "PREV", questions: [{ question: "Which icon?", options: [{ label: "A", preview: "[A]" }] }] });
  writeFileSync(join(TMP, "screen.txt"), " Which icon?\n ❯ 1. A   │ [A]\n\nEnter to select · ↑/↓ to navigate · Esc to cancel\n");
  list("done");
  await new Promise((r) => setTimeout(r, 2100));
  const a = await get();
  expect(a.status).toBe("blocked");
  expect(a.ask[0].options[0].preview).toBe("[A]");
  writeFileSync(join(TMP, "screen.txt"), "⏺ Got it.\n❯ \n"); // answered in the terminal
  await new Promise((r) => setTimeout(r, 2100));
  const b = await get();
  expect(b.status).toBe("done");
  expect(b.ask).toBeUndefined();
  require("fs").unlinkSync(join(TMP, "screen.txt"));
}, 15000);
