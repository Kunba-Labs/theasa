import { Database } from "bun:sqlite";

export function openDb(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  db.exec(`
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY, key TEXT UNIQUE NOT NULL, name TEXT NOT NULL, display_name TEXT,
  root TEXT, remote TEXT, icon BLOB, icon_mime TEXT, icon_sha TEXT, icon_locked INTEGER DEFAULT 0,
  hidden INTEGER DEFAULT 0, created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, project_id INTEGER REFERENCES projects(id), agent TEXT, session_id TEXT,
  machine TEXT, cwd TEXT, transcript_path TEXT, first_at TEXT, last_at TEXT
);
CREATE TABLE IF NOT EXISTS turns (
  id INTEGER PRIMARY KEY, agent TEXT NOT NULL, session_id TEXT NOT NULL, turn_key TEXT NOT NULL,
  project_id INTEGER REFERENCES projects(id), machine TEXT, cwd TEXT, branch TEXT, head TEXT,
  started_at TEXT, ended_at TEXT, duration_ms INTEGER, tool_ms INTEGER,
  prompt TEXT, final_text TEXT, model TEXT,
  in_tok INTEGER, out_tok INTEGER, cache_read INTEGER, cache_write INTEGER, model_calls INTEGER,
  tools TEXT, files TEXT, log TEXT, cost REAL,
  headline TEXT, summary TEXT, verdict TEXT, steps TEXT,
  summary_status TEXT DEFAULT 'none', summary_error TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(agent, session_id, turn_key)
);
CREATE INDEX IF NOT EXISTS turns_project_time ON turns(project_id, started_at);
CREATE INDEX IF NOT EXISTS turns_time ON turns(started_at);
CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY, turn_id INTEGER REFERENCES turns(id) ON DELETE CASCADE, project_id INTEGER,
  text TEXT, why TEXT, alternative TEXT, status TEXT DEFAULT 'active', superseded_by INTEGER,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS watch_items (
  id INTEGER PRIMARY KEY, turn_id INTEGER REFERENCES turns(id) ON DELETE CASCADE, project_id INTEGER,
  text TEXT, impact TEXT, status TEXT DEFAULT 'open', done_at TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS summary_jobs (
  id INTEGER PRIMARY KEY, turn_id INTEGER REFERENCES turns(id) ON DELETE CASCADE, agent TEXT, model TEXT,
  status TEXT DEFAULT 'queued', attempts INTEGER DEFAULT 0, next_at TEXT, error TEXT,
  in_tok INTEGER DEFAULT 0, out_tok INTEGER DEFAULT 0, cache_read INTEGER DEFAULT 0, cache_write INTEGER DEFAULT 0,
  cost REAL, queued_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), started_at TEXT, finished_at TEXT
);
CREATE INDEX IF NOT EXISTS jobs_status ON summary_jobs(status, next_at);
CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(body, turn_id UNINDEXED, project_id UNINDEXED);
CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY, turn_id INTEGER REFERENCES turns(id) ON DELETE CASCADE, dir TEXT, kind TEXT,
  name TEXT, url TEXT, media_type TEXT, data BLOB, count INTEGER DEFAULT 1
);
CREATE INDEX IF NOT EXISTS attachments_turn ON attachments(turn_id);
`);
  // columns added after the first release
  const cols = new Set((db.query("PRAGMA table_info(turns)").all() as any[]).map((c) => c.name));
  if (!cols.has("diffs")) db.exec("ALTER TABLE turns ADD COLUMN diffs TEXT");
  return db;
}

// how a project shows in the app: one place for the name, icon URL and initial (server rows and live agents)
export const projectBadge = (p: any) => ({
  id: p.id as number, name: (p.display_name || p.name) as string,
  icon_url: p.icon_sha ? `/api/projects/${p.id}/icon?v=${p.icon_sha.slice(0, 8)}` : null,
  initial: (p.display_name || p.name || "?").slice(0, 1).toUpperCase(),
});

export function indexTurn(db: Database, turnId: number) {
  const t: any = db.query("SELECT * FROM turns WHERE id = ?").get(turnId);
  if (!t) return;
  const dec = db.query("SELECT text, why FROM decisions WHERE turn_id = ?").all(turnId) as any[];
  const w = db.query("SELECT text FROM watch_items WHERE turn_id = ?").all(turnId) as any[];
  const files = JSON.parse(t.files || "[]").map((f: any) => f.path).join(" ");
  const summary = JSON.parse(t.summary || "[]").join(" ");
  const body = [t.prompt, t.headline, summary, dec.map((d) => d.text + " " + (d.why ?? "")).join(" "), w.map((x) => x.text).join(" "), files, t.final_text?.slice(0, 2000)].join("\n");
  db.query("DELETE FROM search WHERE turn_id = ?").run(turnId);
  db.query("INSERT INTO search (body, turn_id, project_id) VALUES (?, ?, ?)").run(body, turnId, t.project_id);
}
