// Background summary worker: runs the same agent CLI that did the turn, headless and quiet.
import type { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { indexTurn } from "./db";
import { costOf } from "./prices";

export const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["headline", "summary", "verdict", "steps", "decisions", "watch"],
  properties: {
    headline: { type: "string", description: "One sentence, at most 20 words: the main result of the turn." },
    summary: { type: "array", items: { type: "string" }, description: "1 to 6 sentences. What was done and the result." },
    verdict: { type: "string", enum: ["clean", "watch", "broken"] },
    steps: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["at", "title", "text", "tone"],
        properties: {
          at: { type: "string", description: "Time from the prompt as +m:ss, copied from the log." },
          title: { type: "string" }, text: { type: "string" },
          tone: { type: "string", enum: ["neutral", "good", "problem"] },
        },
      },
    },
    decisions: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["text", "why", "alternative"],
        properties: { text: { type: "string" }, why: { type: "string" }, alternative: { type: "string" } },
      },
    },
    watch: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["text", "impact"],
        properties: { text: { type: "string" }, impact: { type: "string", enum: ["high", "medium", "low"] } },
      },
    },
  },
};

export const SYSTEM = `You write the work log for a coding agent turn. The reader is the developer who owns the project. They did not watch the turn.

Write in ASD-STE100 Simplified Technical English, about 80% strict:
- One statement in each sentence. At most 20 words in a sentence.
- Use the active voice. Use the simple present or simple past tense.
- Use common, simple words. Use one word for one meaning. No idioms, no marketing words, no filler.
- Keep technical names exactly as they are: file paths, commands, function names, product names.
- Do not write "the agent" in every sentence. Write what changed: "The log stream stays open." not "The agent made the log stream stay open."

Fields:
- headline: the main result in one sentence. For a question with no code change, write the answer: "Answered: <answer>."
- summary: 1 to 6 sentences. The first sentence is the headline again or close to it. Include test results when the log shows them. A short question gets 1 sentence.
- verdict: "broken" when tests, a build or a deploy fail at the end of the turn, or the work stopped unfinished. "watch" when there is at least one watch item. Else "clean".
- steps: 3 to 8 steps that tell the story, with the "+m:ss" time from the log. Tone "problem" for failures, "good" for a passing check or a finished change, else "neutral". Use [] for a trivial turn.
- decisions: only real choices the agent or the user made in this turn, between two or more ways to do something. Give the reason (why) and the option that was not chosen (alternative; "" if the log does not say). Do not invent decisions. Use [] when there are none.
- watch: things the developer must know or do later: a risk, an open problem, a manual step, a follow-up, a failing test that was left. Plain words are allowed here; be precise. Impact: high = breaks production or loses data, medium = needs action soon, low = good to know. Use [] when there is nothing.

Use only facts from the input. If the input does not show a result, do not claim it.`;

export function buildPrompt(t: any, projectName: string): string {
  const files = JSON.parse(t.files || "[]").map((f: any) => `${f.path} (+${f.add} -${f.del})`).join("\n") || "none";
  const tools = Object.entries(JSON.parse(t.tools || "{}")).map(([k, v]) => `${k}(${v})`).join(", ") || "none";
  return `${t.attachments_note ? t.attachments_note + "\n" : ""}Project: ${projectName}
Agent: ${t.agent} (${t.model || "unknown model"})
Duration: ${Math.round((t.duration_ms ?? 0) / 1000)} s
Tools used: ${tools}
Files changed:
${files}

THE USER ASKED:
${t.prompt}

THE AGENT'S LAST MESSAGE:
${(t.final_text || "").slice(0, 6000)}

LOG (time from the prompt, tool calls and messages):
${t.log}`;
}

type Result = { out: any; model: string; tokens: { input: number; output: number; cache_read: number; cache_write: number }; cost: number | null };

export function codexDefaultModel(): string {
  try { return readFileSync(join(homedir(), ".codex", "config.toml"), "utf8").match(/^model\s*=\s*"([^"]+)"/m)?.[1] ?? ""; } catch { return ""; }
}

async function run(cmd: string[], input: string, cwd: string, timeoutMs: number) {
  const p = Bun.spawn(cmd, {
    cwd, stdin: new Blob([input]), stdout: "pipe", stderr: "pipe",
    env: { ...process.env, THEASA_CHILD: "1", CLAUDECODE: "", CLAUDE_CODE_ENTRYPOINT: "" },
  });
  const timer = setTimeout(() => p.kill(), timeoutMs);
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  clearTimeout(timer);
  return { out, err, code };
}

export async function summariseWith(agent: string, prompt: string, workDir: string, bins = { claude: "claude", codex: "codex" }): Promise<Result> {
  mkdirSync(workDir, { recursive: true });
  if (agent === "codex") {
    const schemaFile = join(workDir, "schema.json"), outFile = join(workDir, `out-${process.pid}-${Date.now()}.json`);
    writeFileSync(schemaFile, JSON.stringify(SCHEMA));
    const r = await run([bins.codex, "exec", "--ephemeral", "--skip-git-repo-check", "-s", "read-only",
      "-c", 'model_reasoning_effort="low"', "--output-schema", schemaFile, "-o", outFile, "--json", "-"],
      SYSTEM + "\n\n---\n\n" + prompt, workDir, 300_000);
    if (r.code !== 0 || !existsSync(outFile)) throw new Error(`codex exited ${r.code}: ${(r.err || r.out).slice(-400)}`);
    let usage: any = {};
    for (const l of r.out.split("\n")) { try { const e = JSON.parse(l); if (e.type === "turn.completed") usage = e.usage ?? {}; } catch {} }
    const model = codexDefaultModel();
    const tokens = { input: (usage.input_tokens ?? 0) - (usage.cached_input_tokens ?? 0), output: usage.output_tokens ?? 0, cache_read: usage.cached_input_tokens ?? 0, cache_write: usage.cache_write_input_tokens ?? 0 };
    const out = JSON.parse(readFileSync(outFile, "utf8"));
    try { unlinkSync(outFile); } catch {}
    return { out, model, tokens, cost: costOf(model, tokens) };
  }
  const r = await run([bins.claude, "-p", "--model", "haiku", "--setting-sources", "", "--tools", "", "--strict-mcp-config",
    "--no-session-persistence", "--output-format", "json", "--json-schema", JSON.stringify(SCHEMA), "--system-prompt", SYSTEM],
    prompt, workDir, 300_000);
  let j: any;
  try { j = JSON.parse(r.out); } catch { throw new Error(`claude exited ${r.code}: ${(r.err || r.out).slice(-400)}`); }
  if (j.is_error) throw new Error("claude: " + String(j.result ?? j.subtype).slice(0, 400));
  const out = j.structured_output ?? JSON.parse(j.result);
  const u = j.usage ?? {};
  return {
    out, model: Object.keys(j.modelUsage ?? {})[0] ?? "haiku",
    tokens: { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cache_read: u.cache_read_input_tokens ?? 0, cache_write: u.cache_creation_input_tokens ?? 0 },
    cost: j.total_cost_usd ?? null,
  };
}

export function normalise(o: any) {
  const s = (x: any) => (typeof x === "string" ? x.trim() : "");
  const summary = (Array.isArray(o.summary) ? o.summary : []).map(s).filter(Boolean).slice(0, 6);
  const watch = (Array.isArray(o.watch) ? o.watch : []).filter((w: any) => s(w?.text)).map((w: any) => ({ text: s(w.text), impact: ["high", "medium", "low"].includes(w.impact) ? w.impact : "medium" }));
  const decisions = (Array.isArray(o.decisions) ? o.decisions : []).filter((d: any) => s(d?.text)).map((d: any) => ({ text: s(d.text), why: s(d.why), alternative: s(d.alternative) }));
  const steps = (Array.isArray(o.steps) ? o.steps : []).filter((x: any) => s(x?.title)).slice(0, 8)
    .map((x: any) => ({ at: s(x.at) || "", title: s(x.title), text: s(x.text), tone: ["neutral", "good", "problem"].includes(x.tone) ? x.tone : "neutral" }));
  let verdict = ["clean", "watch", "broken"].includes(o.verdict) ? o.verdict : "clean";
  if (verdict === "clean" && watch.length) verdict = "watch";
  const headline = s(o.headline) || summary[0] || "";
  return { headline, summary: summary.length ? summary : headline ? [headline] : [], verdict, steps, decisions, watch };
}

export function storeSummary(db: Database, turnId: number, res: ReturnType<typeof normalise>) {
  const t: any = db.query("SELECT project_id, ended_at FROM turns WHERE id = ?").get(turnId);
  db.transaction(() => {
    db.query("UPDATE turns SET headline=?, summary=?, verdict=?, steps=?, summary_status='done', summary_error=NULL WHERE id=?")
      .run(res.headline, JSON.stringify(res.summary), res.verdict, JSON.stringify(res.steps), turnId);
    // a redo replaces the turn's items; done/dismissed state of identical text is kept
    const oldW = new Map((db.query("SELECT text, status, done_at FROM watch_items WHERE turn_id=?").all(turnId) as any[]).map((w) => [w.text, w]));
    const oldD = new Map((db.query("SELECT text, status FROM decisions WHERE turn_id=?").all(turnId) as any[]).map((d) => [d.text, d]));
    db.query("DELETE FROM watch_items WHERE turn_id=?").run(turnId);
    db.query("DELETE FROM decisions WHERE turn_id=?").run(turnId);
    for (const w of res.watch) {
      const o: any = oldW.get(w.text);
      db.query("INSERT INTO watch_items (turn_id, project_id, text, impact, status, done_at, created_at) VALUES (?,?,?,?,?,?,?)")
        .run(turnId, t.project_id, w.text, w.impact, o?.status ?? "open", o?.done_at ?? null, t.ended_at);
    }
    for (const d of res.decisions) {
      const o: any = oldD.get(d.text);
      db.query("INSERT INTO decisions (turn_id, project_id, text, why, alternative, status, created_at) VALUES (?,?,?,?,?,?,?)")
        .run(turnId, t.project_id, d.text, d.why, d.alternative, o?.status ?? "active", t.ended_at);
    }
  })();
  indexTurn(db, turnId);
}

export function enqueue(db: Database, turnId: number, agent: string) {
  db.query("DELETE FROM summary_jobs WHERE turn_id=? AND status IN ('queued','failed')").run(turnId);
  db.query("INSERT INTO summary_jobs (turn_id, agent, status, next_at) VALUES (?, ?, 'queued', strftime('%Y-%m-%dT%H:%M:%fZ','now'))").run(turnId, agent);
  db.query("UPDATE turns SET summary_status='queued', summary_error=NULL WHERE id=?").run(turnId);
}

export function startWorker(db: Database, opts: { workDir: string; concurrency?: number; onChange: () => void; bins?: { claude: string; codex: string } }) {
  let running = 0;
  const conc = opts.concurrency ?? 2;
  // a crash mid-job leaves 'running' rows: put them back in the queue
  db.query("UPDATE summary_jobs SET status='queued' WHERE status='running'").run();
  db.query("UPDATE turns SET summary_status='queued' WHERE summary_status='running'").run();
  const tick = async () => {
    while (running < conc) {
      const job: any = db.query("SELECT * FROM summary_jobs WHERE status='queued' AND next_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now') ORDER BY id DESC LIMIT 1").get();
      if (!job) return;
      running++;
      db.query("UPDATE summary_jobs SET status='running', started_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), attempts=attempts+1 WHERE id=?").run(job.id);
      db.query("UPDATE turns SET summary_status='running' WHERE id=?").run(job.turn_id);
      opts.onChange();
      (async () => {
        try {
          const t: any = db.query("SELECT t.*, COALESCE(p.display_name, p.name) AS pname FROM turns t JOIN projects p ON p.id=t.project_id WHERE t.id=?").get(job.turn_id);
          if (!t) throw new Error("turn is gone");
          const atts = db.query("SELECT dir, kind, name, url FROM attachments WHERE turn_id=?").all(job.turn_id) as any[];
          if (atts.length) t.attachments_note = "Attachments: " + atts.map((a) => `${a.dir === "in" ? "the user attached" : "the agent shared"} ${a.kind} ${a.name}${a.url ? " (" + a.url + ")" : ""}`).join("; ");
          const r = await summariseWith(job.agent, buildPrompt(t, t.pname), opts.workDir, opts.bins);
          storeSummary(db, job.turn_id, normalise(r.out));
          db.query("UPDATE summary_jobs SET status='done', model=?, in_tok=?, out_tok=?, cache_read=?, cache_write=?, cost=?, finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), error=NULL WHERE id=?")
            .run(r.model, r.tokens.input, r.tokens.output, r.tokens.cache_read, r.tokens.cache_write, r.cost, job.id);
        } catch (e: any) {
          const attempts = job.attempts + 1;
          const err = String(e?.message ?? e).slice(0, 1000);
          if (attempts < 3) {
            const wait = [30, 120][attempts - 1] ?? 300; // backoff
            db.query("UPDATE summary_jobs SET status='queued', error=?, next_at=strftime('%Y-%m-%dT%H:%M:%fZ','now', ?) WHERE id=?").run(err, `+${wait} seconds`, job.id);
            db.query("UPDATE turns SET summary_status='queued', summary_error=? WHERE id=?").run(err, job.turn_id);
          } else {
            db.query("UPDATE summary_jobs SET status='failed', error=?, finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(err, job.id);
            db.query("UPDATE turns SET summary_status='failed', summary_error=? WHERE id=?").run(err, job.turn_id);
          }
        } finally {
          running--;
          opts.onChange();
          tick();
        }
      })();
    }
  };
  const iv = setInterval(tick, 3000);
  tick();
  return { tick, stop: () => clearInterval(iv) };
}
