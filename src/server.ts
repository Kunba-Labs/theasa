import type { Database } from "bun:sqlite";
import { timingSafeEqual, createHash } from "crypto";
import { join } from "path";
import { statSync } from "fs";
import { openDb, indexTurn, projectBadge } from "./db";
import { costOf, loadPrices } from "./prices";
import { enqueue, startWorker } from "./summarize";
import { createLive } from "./live";
import type { Turn } from "./parse";
import { HOME, ensureHome, readToken, DEFAULT_PORT, readConfig } from "./config";

const VERSION = "0.1.0";
// written by `theasa deploy`; absent when the server runs straight from the repo
// release = the release folder's name, unique per deploy (older BUILD files lack the field)
const BUILD = (() => { try { return { ...JSON.parse(require("fs").readFileSync(join(import.meta.dir, "..", "BUILD"), "utf8")), release: require("path").basename(join(import.meta.dir, "..")) }; } catch { return null; } })();
const RASTER = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const json = (d: any, status = 200) => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json" } });
const now = () => new Date().toISOString();

export function sinceFor(range: string | null): string {
  const d = new Date();
  if (range === "today") { d.setHours(0, 0, 0, 0); return d.toISOString(); }
  const days = range === "month" ? 30 : range === "all" ? 36500 : 7;
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - (days - 1));
  return d.toISOString();
}
const localDay = (iso: string) => { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const RANK: Record<string, number> = { broken: 3, watch: 2, clean: 1 };
const worst = (vs: (string | null)[]) => vs.reduce<string | null>((a, v) => (v && (RANK[v] ?? 0) > (RANK[a ?? ""] ?? 0) ? v : a), null);

export type IngestBody = {
  machine: string; transcript_path?: string; summarize?: boolean; refresh?: boolean;
  project: { key: string; name: string; root: string; remote: string; branch?: string; head?: string };
  turns: Turn[];
};

// "canvas.json" is a file name; "Plan v1.2" is a title (has a space, and ".2" is no extension)
export const isFileName = (n: string) => !/\s/.test(n) && /\.[a-z][a-z0-9]{0,5}$/i.test(n);

export function ingest(db: Database, b: IngestBody) {
  if (!b?.project?.key || !Array.isArray(b.turns)) throw new Error("bad body: project.key and turns[] are required");
  let stored = 0, updated = 0, queued = 0;
  db.transaction(() => {
    db.query(`INSERT INTO projects (key, name, root, remote) VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET name=excluded.name, root=COALESCE(NULLIF(excluded.root,''), root), remote=COALESCE(NULLIF(excluded.remote,''), remote)`)
      .run(b.project.key, b.project.name, b.project.root ?? "", b.project.remote ?? "");
    const pid = (db.query("SELECT id FROM projects WHERE key=?").get(b.project.key) as any).id;
    for (const t of b.turns) {
      if (!t?.session_id || !t?.turn_key) continue;
      const sid = `${t.agent}:${t.session_id}`;
      db.query(`INSERT INTO sessions (id, project_id, agent, session_id, machine, cwd, transcript_path, first_at, last_at) VALUES (?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET last_at=MAX(last_at, excluded.last_at), first_at=MIN(first_at, excluded.first_at), project_id=excluded.project_id,
        transcript_path=COALESCE(excluded.transcript_path, transcript_path)`)
        .run(sid, pid, t.agent, t.session_id, b.machine, t.cwd, b.transcript_path ?? null, t.started_at, t.ended_at);
      const cost = costOf(t.model, t.tokens);
      const old: any = db.query("SELECT id, ended_at, out_tok, model_calls, summary_status FROM turns WHERE agent=? AND session_id=? AND turn_key=?").get(t.agent, t.session_id, t.turn_key);
      const vals = [pid, b.machine, t.cwd, b.project.branch ?? "", b.project.head ?? "", t.started_at, t.ended_at, t.duration_ms, t.tool_ms,
        t.prompt, t.final_text, t.model, t.tokens.input, t.tokens.output, t.tokens.cache_read, t.tokens.cache_write, t.model_calls,
        JSON.stringify(t.tools), JSON.stringify(t.files), t.log, cost];
      let id: number;
      const saveExtras = (turnId: number) => {
        db.query("UPDATE turns SET diffs=? WHERE id=?").run(JSON.stringify(t.diffs ?? {}), turnId);
        // a publish from a file only knows the file name; a publish of the same page (this turn's old rows
        // included) may know its title, so look it up before those rows are replaced
        for (const a of t.attachments ?? []) {
          if (a.kind === "artifact" && a.url && (!a.name || isFileName(a.name))) {
            const names = db.query("SELECT name FROM attachments WHERE url=? AND kind='artifact' AND name != ''").all(a.url) as any[];
            const named = names.find((r) => !isFileName(r.name));
            if (named) a.name = named.name;
          }
        }
        db.query("DELETE FROM attachments WHERE turn_id=?").run(turnId);
        for (const a of t.attachments ?? []) {
          db.query("INSERT INTO attachments (turn_id, dir, kind, name, url, media_type, data, count) VALUES (?,?,?,?,?,?,?,?)")
            .run(turnId, a.dir, a.kind, a.name ?? "", a.url ?? null, a.media_type ?? null, a.data ? Buffer.from(a.data, "base64") : null, a.count ?? 1);
        }
      };
      if (!old) {
        const r = db.query(`INSERT INTO turns (project_id, machine, cwd, branch, head, started_at, ended_at, duration_ms, tool_ms, prompt, final_text, model,
          in_tok, out_tok, cache_read, cache_write, model_calls, tools, files, log, cost, agent, session_id, turn_key)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(...vals, t.agent, t.session_id, t.turn_key);
        id = Number(r.lastInsertRowid);
        saveExtras(id);
        stored++;
      } else if (t.ended_at > old.ended_at || t.model_calls !== old.model_calls) {
        // the same turn came again with more content (a Stop hook let it continue)
        db.query(`UPDATE turns SET project_id=?, machine=?, cwd=?, branch=?, head=?, started_at=?, ended_at=?, duration_ms=?, tool_ms=?, prompt=?, final_text=?, model=?,
          in_tok=?, out_tok=?, cache_read=?, cache_write=?, model_calls=?, tools=?, files=?, log=?, cost=? WHERE id=?`).run(...vals, old.id);
        id = old.id;
        saveExtras(id);
        updated++;
      } else {
        // unchanged, but imported without a summary and now one is asked for
        if (b.refresh) { db.query("UPDATE turns SET files=? WHERE id=?").run(JSON.stringify(t.files), old.id); saveExtras(old.id); indexTurn(db, old.id); }
        if (b.summarize === true && (old.summary_status === "skipped" || old.summary_status === "none")) { enqueue(db, old.id, t.agent); queued++; }
        continue;
      }
      indexTurn(db, id);
      if (b.summarize !== false) enqueue(db, id, t.agent);
      else if (!old) db.query("UPDATE turns SET summary_status='skipped' WHERE id=?").run(id);
    }
  })();
  return { stored, updated, queued };
}

function projectRow(p: any) {
  const b = projectBadge(p);
  return { id: b.id, key: p.key, name: b.name, repo_name: p.name, root: p.root, remote: p.remote, hidden: !!p.hidden,
    has_icon: !!p.icon_sha, icon_url: b.icon_url, initial: b.initial, icon_locked: !!p.icon_locked };
}
const P_COLS = "id, key, name, display_name, root, remote, hidden, icon_sha, icon_locked";

function turnRow(t: any) {
  return {
    id: t.id, agent: t.agent, session_id: t.session_id, project_id: t.project_id, machine: t.machine, cwd: t.cwd, branch: t.branch, head: t.head,
    started_at: t.started_at, ended_at: t.ended_at, duration_ms: t.duration_ms, tool_ms: t.tool_ms, prompt: t.prompt, model: t.model,
    tokens: { input: t.in_tok, output: t.out_tok, cache_read: t.cache_read, cache_write: t.cache_write }, model_calls: t.model_calls,
    cost: t.cost, tools: JSON.parse(t.tools || "{}"), files: JSON.parse(t.files || "[]"),
    headline: t.headline, summary: JSON.parse(t.summary || "[]"), verdict: t.verdict, steps: JSON.parse(t.steps || "[]"),
    summary_status: t.summary_status, summary_error: t.summary_error,
    decisions: t.n_dec ?? undefined, watch: t.n_watch ?? undefined,
    att_in: t.att_in ?? 0, att_out: t.att_out ?? 0,
  };
}

function workerStats(db: Database, since: string) {
  const q = (s: string, ...a: any[]) => db.query(s).get(...a) as any;
  const done = q("SELECT COUNT(*) n, SUM(in_tok+out_tok+cache_read+cache_write) tok, SUM(cost) cost FROM summary_jobs WHERE status='done' AND finished_at>=?", since);
  const delays = (db.query(`SELECT (julianday(j.finished_at)-julianday(t.ended_at))*86400 d FROM summary_jobs j JOIN turns t ON t.id=j.turn_id
     WHERE j.status='done' AND j.finished_at>=? AND t.summary_status='done' ORDER BY d`).all(since) as any[]).map((r) => r.d).filter((d) => d >= 0 && d < 86400);
  return {
    written: done.n, tokens: done.tok ?? 0, cost: done.cost ?? 0,
    queued: q("SELECT COUNT(*) n FROM summary_jobs WHERE status IN ('queued','running')").n,
    running: q("SELECT COUNT(*) n FROM summary_jobs WHERE status='running'").n,
    failed: q("SELECT COUNT(*) n FROM summary_jobs WHERE status='failed'").n,
    median_delay_s: delays.length ? Math.round(delays[Math.floor(delays.length / 2)]) : null,
  };
}

function activeSessions(db: Database) {
  const since = new Date(Date.now() - 10 * 60e3).toISOString();
  return db.query(`SELECT s.agent, s.session_id, s.machine, s.last_at, s.project_id, COALESCE(p.display_name,p.name) project FROM sessions s JOIN projects p ON p.id=s.project_id
    WHERE s.last_at>=? ORDER BY s.last_at DESC`).all(since) as any[];
}

export function pulse(db: Database, range: string) {
  const since = sinceFor(range);
  const turns = db.query(`SELECT t.id, t.project_id, t.agent, t.started_at, t.ended_at, t.duration_ms, t.in_tok, t.out_tok, t.cache_read, t.cache_write, t.cost,
    t.headline, t.verdict, t.files, t.summary_status, t.prompt,
    (SELECT COUNT(*) FROM decisions d WHERE d.turn_id=t.id AND d.status='active') n_dec,
    (SELECT COUNT(*) FROM watch_items w WHERE w.turn_id=t.id) n_watch
    FROM turns t JOIN projects p ON p.id=t.project_id WHERE t.started_at>=? AND p.hidden=0 ORDER BY t.started_at DESC`).all(since) as any[];
  const projects = new Map((db.query(`SELECT ${P_COLS} FROM projects`).all() as any[]).map((p) => [p.id, projectRow(p)]));
  const tok = (t: any) => (t.in_tok ?? 0) + (t.out_tok ?? 0) + (t.cache_read ?? 0) + (t.cache_write ?? 0);
  const totals = {
    turns: turns.length,
    agent_ms: turns.reduce((a, t) => a + (t.duration_ms ?? 0), 0),
    tokens: turns.reduce((a, t) => a + tok(t), 0),
    cache_share: (() => { const all = turns.reduce((a, t) => a + (t.in_tok ?? 0) + (t.cache_read ?? 0) + (t.cache_write ?? 0), 0); return all ? turns.reduce((a, t) => a + (t.cache_read ?? 0), 0) / all : 0; })(),
    cost: turns.reduce((a, t) => a + (t.cost ?? 0), 0),
    priced: turns.filter((t) => t.cost != null).length,
    by_agent: turns.reduce((a: any, t) => ((a[t.agent] = (a[t.agent] ?? 0) + 1), a), {}),
  };
  // bars: hours for today, days otherwise
  const bars: any[] = [];
  if (range === "today") {
    for (let h = 0; h < 24; h++) bars.push({ label: String(h).padStart(2, "0"), claude: 0, codex: 0 });
    for (const t of turns) bars[new Date(t.started_at).getHours()][t.agent === "codex" ? "codex" : "claude"] += tok(t);
  } else {
    const days = range === "month" ? 30 : 7;
    const idx = new Map<string, any>();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - i);
      const b = { label: days > 7 ? String(d.getDate()) : d.toLocaleDateString("en-GB", { weekday: "short" }), day: localDay(d.toISOString()), claude: 0, codex: 0 };
      bars.push(b); idx.set(b.day, b);
    }
    for (const t of turns) { const b = idx.get(localDay(t.started_at)); if (b) b[t.agent === "codex" ? "codex" : "claude"] += tok(t); }
  }
  // per day per project
  const dayMap = new Map<string, Map<number, any[]>>();
  for (const t of turns) {
    const d = localDay(t.started_at);
    if (!dayMap.has(d)) dayMap.set(d, new Map());
    const m = dayMap.get(d)!;
    if (!m.has(t.project_id)) m.set(t.project_id, []);
    m.get(t.project_id)!.push(t);
  }
  const days = [...dayMap.entries()].map(([day, m]) => ({
    day,
    items: [...m.entries()].map(([pid, ts]) => {
      const files = new Set<string>();
      for (const t of ts) for (const f of JSON.parse(t.files || "[]")) files.add(f.path);
      const weight = (t: any) => (t.verdict === "broken" ? 100 : 0) + t.n_watch * 10 + t.n_dec * 10 + JSON.parse(t.files || "[]").length;
      const top = [...ts].filter((t) => t.headline).sort((a, b) => weight(b) - weight(a)).slice(0, 3);
      return {
        project: projects.get(pid), turns: ts.length, agents: [...new Set(ts.map((t) => t.agent))], last_at: ts[0].ended_at,
        health: worst(ts.map((t) => t.verdict)), pending: ts.filter((t) => ["queued", "running"].includes(t.summary_status)).length,
        bullets: top.map((t) => ({ turn_id: t.id, text: t.headline, verdict: t.verdict })),
        decisions: ts.reduce((a, t) => a + t.n_dec, 0), watch: ts.reduce((a, t) => a + t.n_watch, 0), files: files.size,
      };
    }).sort((a, b) => (b.last_at > a.last_at ? 1 : -1)),
  }));
  const attention = (db.query(`SELECT w.id, w.text, w.impact, w.created_at, w.turn_id, w.project_id FROM watch_items w JOIN projects p ON p.id=w.project_id
    WHERE w.status='open' AND p.hidden=0 ORDER BY CASE w.impact WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, w.created_at DESC LIMIT 30`).all() as any[])
    .map((w) => ({ ...w, project: projects.get(w.project_id) }));
  const openCount = (db.query("SELECT COUNT(*) n FROM watch_items w JOIN projects p ON p.id=w.project_id WHERE w.status='open' AND p.hidden=0").get() as any).n;
  const decisions = (db.query(`SELECT d.id, d.text, d.created_at, d.turn_id, d.project_id FROM decisions d JOIN projects p ON p.id=d.project_id
    WHERE d.status='active' AND d.created_at>=? AND p.hidden=0 ORDER BY d.created_at DESC LIMIT 8`).all(since) as any[]).map((d) => ({ ...d, project: projects.get(d.project_id) }));
  const decCount = (db.query("SELECT COUNT(*) n FROM decisions WHERE status='active' AND created_at>=?").get(since) as any).n;
  return { range, since, totals, bars, days, attention, open_watch: openCount, decisions, decisions_count: decCount, worker: workerStats(db, since), active: activeSessions(db) };
}

export function projectsList(db: Database, range: string) {
  const since = sinceFor(range);
  return (db.query(`SELECT ${P_COLS.split(", ").map((c) => "p." + c).join(", ")},
      (SELECT MAX(ended_at) FROM turns WHERE project_id=p.id) last_at,
      (SELECT COUNT(*) FROM turns WHERE project_id=p.id AND started_at>=?) turns,
      (SELECT SUM(in_tok+out_tok+cache_read+cache_write) FROM turns WHERE project_id=p.id AND started_at>=?) tokens,
      (SELECT SUM(cost) FROM turns WHERE project_id=p.id AND started_at>=?) cost,
      (SELECT SUM(duration_ms) FROM turns WHERE project_id=p.id AND started_at>=?) agent_ms,
      (SELECT COUNT(*) FROM watch_items WHERE project_id=p.id AND status='open') open_watch,
      (SELECT GROUP_CONCAT(DISTINCT machine) FROM sessions WHERE project_id=p.id) machines
    FROM projects p ORDER BY last_at DESC`).all(since, since, since, since) as any[])
    .map((p) => ({ ...projectRow(p), last_at: p.last_at, turns: p.turns, tokens: p.tokens ?? 0, cost: p.cost ?? 0, agent_ms: p.agent_ms ?? 0, open_watch: p.open_watch, machines: (p.machines ?? "").split(",").filter(Boolean) }));
}

export function projectDetail(db: Database, id: number, range: string, agent: string | null, only: string | null) {
  const p: any = db.query(`SELECT ${P_COLS} FROM projects WHERE id=?`).get(id);
  if (!p) return null;
  const since = sinceFor(range);
  const span: any = db.query("SELECT MIN(started_at) first_at, MAX(ended_at) last_at, COUNT(*) n FROM turns WHERE project_id=?").get(id);
  const machines = db.query("SELECT machine, COUNT(*) n FROM turns WHERE project_id=? GROUP BY machine ORDER BY n DESC").all(id);
  let where = "t.project_id=? AND t.started_at>=?";
  const args: any[] = [id, since];
  if (agent && agent !== "all") { where += " AND t.agent=?"; args.push(agent); }
  const turns = (db.query(`SELECT t.*, (SELECT COUNT(*) FROM decisions d WHERE d.turn_id=t.id AND d.status!='dismissed') n_dec,
      (SELECT COUNT(*) FROM watch_items w WHERE w.turn_id=t.id) n_watch,
      (SELECT COUNT(*) FROM attachments a WHERE a.turn_id=t.id AND a.dir='in') att_in,
      (SELECT COUNT(*) FROM attachments a WHERE a.turn_id=t.id AND a.dir='out') att_out
      FROM turns t WHERE ${where} ORDER BY t.started_at DESC LIMIT 500`).all(...args) as any[])
    .map((t) => {
      const r = turnRow(t);
      (r as any).notes = [
        ...(db.query("SELECT id, text, status FROM decisions WHERE turn_id=? AND status!='dismissed'").all(t.id) as any[]).map((d) => ({ kind: "decision", ...d })),
        ...(db.query("SELECT id, text, impact, status FROM watch_items WHERE turn_id=?").all(t.id) as any[]).map((w) => ({ kind: "watch", ...w })),
      ];
      return r;
    })
    .filter((t: any) => only !== "notes" || t.notes.length);
  const all = db.query("SELECT duration_ms, in_tok, out_tok, cache_read, cache_write, cost, started_at FROM turns WHERE project_id=? AND started_at>=?").all(id, since) as any[];
  const totals = { turns: all.length, agent_ms: all.reduce((a, t) => a + (t.duration_ms ?? 0), 0), tokens: all.reduce((a, t) => a + t.in_tok + t.out_tok + t.cache_read + t.cache_write, 0), cost: all.reduce((a, t) => a + (t.cost ?? 0), 0) };
  const hist: number[] = range === "today" ? Array(24).fill(0) : Array(range === "month" ? 30 : 7).fill(0);
  const base = new Date(sinceFor(range)).getTime();
  for (const t of all) {
    const i = range === "today" ? new Date(t.started_at).getHours() : Math.floor((Date.parse(t.started_at) - base) / 86400e3);
    if (i >= 0 && i < hist.length) hist[i] += Math.round((t.duration_ms ?? 0) / 60000);
  }
  const decisions = db.query("SELECT d.*, t.agent FROM decisions d JOIN turns t ON t.id=d.turn_id WHERE d.project_id=? AND d.status!='dismissed' ORDER BY d.created_at DESC LIMIT 100").all(id);
  const watch = db.query("SELECT w.*, t.agent FROM watch_items w JOIN turns t ON t.id=w.turn_id WHERE w.project_id=? ORDER BY w.status='open' DESC, w.created_at DESC LIMIT 100").all(id);
  // from the turns: a session that moved between repos still shows under each of them
  const sessions = (db.query("SELECT agent, session_id, MAX(machine) machine, MAX(ended_at) last_at FROM turns WHERE project_id=? GROUP BY agent, session_id ORDER BY last_at DESC LIMIT 5").all(id) as any[])
    .map((s) => ({ ...s, active: Date.now() - Date.parse(s.last_at) < 10 * 60e3 }));
  return { project: projectRow(p), first_at: span.first_at, last_at: span.last_at, total_turns: span.n, machines, totals, hist, turns, decisions, watch, sessions };
}

export function turnDetail(db: Database, id: number) {
  const t: any = db.query("SELECT * FROM turns WHERE id=?").get(id);
  if (!t) return null;
  const p: any = db.query(`SELECT ${P_COLS} FROM projects WHERE id=?`).get(t.project_id);
  const decisions = db.query("SELECT * FROM decisions WHERE turn_id=?").all(id);
  const watch = db.query("SELECT * FROM watch_items WHERE turn_id=?").all(id);
  const job = db.query("SELECT * FROM summary_jobs WHERE turn_id=? ORDER BY id DESC LIMIT 1").get(id);
  const jobs = (db.query("SELECT COUNT(*) n FROM summary_jobs WHERE turn_id=?").get(id) as any).n;
  const seq = db.query("SELECT id FROM turns WHERE agent=? AND session_id=? ORDER BY started_at").all(t.agent, t.session_id) as any[];
  const prev: any = db.query("SELECT id FROM turns WHERE project_id=? AND started_at<? ORDER BY started_at DESC LIMIT 1").get(t.project_id, t.started_at);
  const next: any = db.query("SELECT id FROM turns WHERE project_id=? AND started_at>? ORDER BY started_at ASC LIMIT 1").get(t.project_id, t.started_at);
  const s: any = db.query("SELECT first_at FROM sessions WHERE id=?").get(`${t.agent}:${t.session_id}`);
  const resume = `cd ${shq(t.cwd ?? "")} && ${t.agent === "codex" ? "codex resume" : "claude --resume"} ${shq(t.session_id)}`;
  const attachments = (db.query("SELECT id, dir, kind, name, url, media_type, count, data IS NOT NULL has_data FROM attachments WHERE turn_id=? ORDER BY id").all(id) as any[])
    .map((a) => ({ ...a, has_data: !!a.has_data, src: a.has_data && RASTER.has(a.media_type ?? "") ? `/api/attachments/${a.id}` : null }));
  return { turn: { ...turnRow(t), final_text: t.final_text, diffs: JSON.parse(t.diffs || "{}") }, attachments, project: projectRow(p), decisions, watch, job, job_count: jobs,
    session: { index: seq.findIndex((x) => x.id === id) + 1, count: seq.length, first_at: s?.first_at }, prev: prev?.id ?? null, next: next?.id ?? null, resume };
}

// a path or id as one shell word: bare when it is plain, else single-quoted ("/my repo" or "; rm -rf ~" copy safely)
export const shq = (s: string) => (/^[\w@%+=:,./~-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

export function search(db: Database, q: string) {
  const words = q.match(/[\p{L}\p{N}_./-]+/gu) ?? [];
  if (!words.length) return [];
  const match = words.map((w) => `"${w.replace(/"/g, "")}"*`).join(" ");
  const rows = db.query(`SELECT s.turn_id, snippet(search, 0, '[[', ']]', ' … ', 14) snip FROM search s WHERE search MATCH ? ORDER BY rank LIMIT 50`).all(match) as any[];
  return rows.map((r) => {
    const t: any = db.query("SELECT id, project_id, agent, started_at, headline, prompt, verdict FROM turns WHERE id=?").get(r.turn_id);
    const p: any = db.query(`SELECT ${P_COLS} FROM projects WHERE id=?`).get(t.project_id);
    return { ...t, snippet: r.snip, project: projectRow(p) };
  });
}

export function exportProject(db: Database, id: number) {
  const p: any = db.query(`SELECT ${P_COLS} FROM projects WHERE id=?`).get(id);
  if (!p) return null;
  const turns = db.query("SELECT * FROM turns WHERE project_id=? ORDER BY started_at").all(id);
  return { version: VERSION, exported_at: now(), project: projectRow(p), turns,
    decisions: db.query("SELECT * FROM decisions WHERE project_id=?").all(id), watch_items: db.query("SELECT * FROM watch_items WHERE project_id=?").all(id) };
}

function authed(req: Request, token: string): boolean {
  const h = req.headers.get("authorization") ?? "";
  const given = Buffer.from(h.replace(/^Bearer\s+/i, ""));
  const want = Buffer.from(token);
  return !!token && given.length === want.length && timingSafeEqual(given, want);
}

const MAX_STREAMS = 64; // ponytail: one global cap on open /api/events streams; per-client limits if one client hogs it

export function createApp(db: Database, opts: { token: string; dbPath?: string; live?: ReturnType<typeof createLive>; openReads?: boolean }) {
  const clients = new Set<ReadableStreamDefaultController>();
  let pending: Timer | null = null;
  const changed = () => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      for (const c of clients) { try { c.enqueue(`data: change\n\n`); } catch { clients.delete(c); } }
    }, 300);
  };
  const live = opts.live ?? createLive(db, changed);

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const m = (re: RegExp) => path.match(re);
    const range = url.searchParams.get("range") ?? "week";

    if (req.method === "GET") {
      let r0: RegExpMatchArray | null;
      // headless: the UI is the Theasa tab in Sidra; this only says what answers here
      if (path === "/") return json({ service: "theasa", version: VERSION, build: BUILD, ui: "Sidra (Theasa tab)", health: "/health", api: "/api/*" });
      if (path === "/health") {
        let size = 0;
        try { size = statSync(opts.dbPath ?? "").size; } catch {}
        const w = workerStats(db, sinceFor("today"));
        return json({ status: "ok", version: VERSION, build: BUILD, db_bytes: size, queue: w.queued, failed: w.failed, turns: (db.query("SELECT COUNT(*) n FROM turns").get() as any).n });
      }
      if (path === "/api/events") {
        if (clients.size >= MAX_STREAMS) return json({ error: "too many open event streams" }, 503);
        let ctl: ReadableStreamDefaultController;
        const stream = new ReadableStream({
          start(c) { ctl = c; clients.add(c); c.enqueue(`retry: 3000\n\ndata: hello\n\n`); },
          cancel() { clients.delete(ctl); },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } });
      }
      // every read under /api holds prompts, replies, screens or files: token only. Open: /, /health, the change
      // stream (it carries only "change") and project icons (Sidra loads them with AsyncImage, which sends no token).
      // THEASA_OPEN_READS=1 opens the turn data again for a read-only Sidra without a token; screens and files stay closed.
      const open = path === "/api/events" || /^\/api\/projects\/\d+\/icon$/.test(path)
        || (opts.openReads && !(path === "/api/agents" || path.startsWith("/api/asks/") || path.startsWith("/api/attachments/")));
      if (path.startsWith("/api/") && !open && !authed(req, opts.token)) return json({ error: "a valid bearer token is required" }, 401);
      if ((r0 = m(/^\/api\/asks\/attachments\/(\d+)$/))) {
        const b = live.blob(+r0[1]);
        return b ? new Response(b.data, { headers: { "content-type": b.media_type, "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox", "cache-control": "private, max-age=3600" } }) : json({ error: "not found" }, 404);
      }
      if (path === "/api/agents") { const c = await live.get(); return json({ available: !c.error, error: c.error, agents: c.agents }); }
      if (path === "/api/pulse") return json(pulse(db, range));
      if (path === "/api/projects") return json(projectsList(db, range));
      if (path === "/api/search") return json(search(db, url.searchParams.get("q") ?? ""));
      let r;
      if ((r = m(/^\/api\/projects\/(\d+)$/))) { const d = projectDetail(db, +r[1], range, url.searchParams.get("agent"), url.searchParams.get("only")); return d ? json(d) : json({ error: "not found" }, 404); }
      if ((r = m(/^\/api\/projects\/(\d+)\/export$/))) { const d = exportProject(db, +r[1]); return d ? new Response(JSON.stringify(d, null, 2), { headers: { "content-type": "application/json", "content-disposition": `attachment; filename="theasa-project-${r[1]}.json"` } }) : json({ error: "not found" }, 404); }
      if ((r = m(/^\/api\/projects\/(\d+)\/icon$/))) {
        const p: any = db.query("SELECT icon, icon_mime FROM projects WHERE id=?").get(+r[1]);
        if (!p?.icon) return new Response("no icon", { status: 404 });
        return new Response(p.icon, { headers: { "content-type": p.icon_mime, "cache-control": "public, max-age=86400",
          "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox" } });
      }
      if ((r = m(/^\/api\/attachments\/(\d+)$/))) {
        const a: any = db.query("SELECT data, media_type FROM attachments WHERE id=?").get(+r[1]);
        // raster formats only: an SVG (or HTML labelled as an image) could run script on this origin
        if (!a?.data || !RASTER.has(a.media_type ?? "")) return new Response("not found", { status: 404 });
        return new Response(a.data, { headers: { "content-type": a.media_type, "cache-control": "private, max-age=86400",
          "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox" } });
      }
      if ((r = m(/^\/api\/turns\/(\d+)$/))) { const d = turnDetail(db, +r[1]); return d ? json(d) : json({ error: "not found" }, 404); }
      if ((r = m(/^\/api\/turns\/(\d+)\/digest$/))) {
        const t: any = db.query("SELECT prompt, final_text, log FROM turns WHERE id=?").get(+r[1]);
        return t ? new Response(`USER ASKED:\n${t.prompt}\n\nLAST MESSAGE:\n${t.final_text}\n\nLOG:\n${t.log}`, { headers: { "content-type": "text/plain; charset=utf-8" } }) : json({ error: "not found" }, 404);
      }
      return json({ error: "not found" }, 404);
    }

    if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
    if (!authed(req, opts.token)) return json({ error: "a valid bearer token is required" }, 401);
    let r;
    const body = async () => { try { return await req.json(); } catch { return {}; } };
    if ((m(/^\/api\/agents\/([^/]+)\/(keys|prompt)$/))) {
      const [, pane, what] = m(/^\/api\/agents\/([^/]+)\/(keys|prompt)$/)!;
      const b: any = await body();
      try {
        const r: any = what === "keys" ? await live.keys(decodeURIComponent(pane), b.keys) : await live.prompt(decodeURIComponent(pane), b.text);
        if (r.error) return json({ error: r.error }, r.status);
        changed(); return json(r);
      } catch (e: any) { return json({ error: e.message }, 502); }
    }
    if (path === "/api/asks") { const b: any = await body(); if (!live.noteAsk(b.session_id, b.questions, b)) return json({ error: "send session_id and questions" }, 400); changed(); return json({ ok: true }); }
    if (path === "/api/ingest") {
      try { const res = ingest(db, (await body()) as IngestBody); changed(); return json(res); }
      catch (e: any) { return json({ error: String(e.message ?? e) }, 400); }
    }
    if (path === "/api/icon") {
      const b: any = await body();
      if (!b.project_key || !b.data) return json({ error: "project_key and data required" }, 400);
      if (b.mime != null && !/^image\/[\w.+-]+$/.test(b.mime)) return json({ error: "mime must be an image type" }, 400);
      const data = Buffer.from(b.data, "base64");
      const sha = createHash("sha256").update(data).digest("hex");
      const res = db.query("UPDATE projects SET icon=?, icon_mime=?, icon_sha=? WHERE key=? AND icon_locked=0").run(data, b.mime ?? "image/png", sha, b.project_key);
      changed();
      return json({ updated: res.changes });
    }
    if ((r = m(/^\/api\/projects\/(\d+)$/))) {
      const b: any = await body();
      if (typeof b.name === "string") db.query("UPDATE projects SET display_name=? WHERE id=?").run(b.name.trim() || null, +r[1]);
      if (typeof b.hidden === "boolean") db.query("UPDATE projects SET hidden=? WHERE id=?").run(b.hidden ? 1 : 0, +r[1]);
      if (b.icon_reset) db.query("UPDATE projects SET icon_locked=0 WHERE id=?").run(+r[1]);
      changed();
      return json({ ok: true });
    }
    if ((r = m(/^\/api\/projects\/(\d+)\/icon$/))) {
      const form = await req.formData().catch(() => null);
      const f = form?.get("icon");
      if (!(f instanceof Blob) || f.size === 0 || f.size > 1_000_000) return json({ error: "send an image under 1 MB as form field 'icon'" }, 400);
      if (!/^image\//.test(f.type)) return json({ error: "the file must be an image" }, 400);
      const data = Buffer.from(await f.arrayBuffer());
      db.query("UPDATE projects SET icon=?, icon_mime=?, icon_sha=?, icon_locked=1 WHERE id=?").run(data, f.type, createHash("sha256").update(data).digest("hex"), +r[1]);
      changed();
      return json({ ok: true });
    }
    if ((r = m(/^\/api\/turns\/(\d+)\/resummarize$/))) {
      const t: any = db.query("SELECT agent FROM turns WHERE id=?").get(+r[1]);
      if (!t) return json({ error: "not found" }, 404);
      enqueue(db, +r[1], t.agent);
      changed();
      return json({ ok: true });
    }
    if ((r = m(/^\/api\/watch\/(\d+)\/(done|open)$/))) {
      db.query("UPDATE watch_items SET status=?, done_at=? WHERE id=?").run(r[2], r[2] === "done" ? now() : null, +r[1]);
      changed();
      return json({ ok: true });
    }
    if ((r = m(/^\/api\/decisions\/(\d+)\/(dismiss|restore|supersede)$/))) {
      const b: any = await body();
      if (r[2] === "dismiss") db.query("UPDATE decisions SET status='dismissed' WHERE id=?").run(+r[1]);
      if (r[2] === "restore") db.query("UPDATE decisions SET status='active', superseded_by=NULL WHERE id=?").run(+r[1]);
      if (r[2] === "supersede") {
        const by = Number(b.by);
        if (!by || by === +r[1]) return json({ error: "by: the id of the newer decision is required" }, 400);
        db.query("UPDATE decisions SET status='superseded', superseded_by=? WHERE id=?").run(by, +r[1]);
      }
      changed();
      return json({ ok: true });
    }
    if (path === "/api/jobs/retry-failed") {
      const failed = db.query("SELECT turn_id, agent FROM summary_jobs WHERE status='failed'").all() as any[];
      for (const f of failed) enqueue(db, f.turn_id, f.agent);
      changed();
      return json({ retried: failed.length });
    }
    return json({ error: "not found" }, 404);
  }
  const startLive = () => setInterval(() => live.tick(clients.size > 0).catch(() => {}), 3000);
  return { handle, changed, startLive };
}

export async function serve() {
  ensureHome();
  const dbPath = join(HOME, "theasa.db");
  const db = openDb(dbPath);
  const token = readToken();
  if (!token) { console.error("No token. Run: theasa install"); process.exit(1); }
  loadPrices(HOME).then(() => {
    // fill in costs for turns stored before the price file was there
    const rows = db.query("SELECT id, model, in_tok, out_tok, cache_read, cache_write FROM turns WHERE cost IS NULL").all() as any[];
    for (const t of rows) {
      const c = costOf(t.model, { input: t.in_tok, output: t.out_tok, cache_read: t.cache_read, cache_write: t.cache_write });
      if (c != null) db.query("UPDATE turns SET cost=? WHERE id=?").run(c, t.id);
    }
  });
  const app = createApp(db, { token, dbPath, openReads: process.env.THEASA_OPEN_READS === "1" });
  app.startLive();
  startWorker(db, { workDir: join(HOME, "work"), onChange: app.changed, bins: { claude: process.env.THEASA_CLAUDE_BIN || "claude", codex: process.env.THEASA_CODEX_BIN || "codex" } });
  const port = Number(process.env.THEASA_PORT || readConfig().port || DEFAULT_PORT);
  // ponytail: loopback only; Tailscale serve publishes it to the tailnet. THEASA_BIND=0.0.0.0 for a plain LAN.
  const hostname = process.env.THEASA_BIND || readConfig().bind || "127.0.0.1";
  // development: false, or Bun answers an exception with an HTML page that shows the source and stack
  Bun.serve({ port, hostname, idleTimeout: 0, development: false, fetch: app.handle,
    error(e) { console.error(e); return json({ error: "internal error" }, 500); } });
  console.log(`Theasa ${VERSION}${BUILD ? " build " + BUILD.sha : " (repo)"} on http://${hostname}:${port}, data in ${HOME}`);
}
