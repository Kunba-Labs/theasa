// Import past transcripts that are still on disk. Stats only, unless --summarize.
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { createHash } from "crypto";
import { readTurns, post, sendIcon, embedSentImages } from "./hook";
import { projectFor } from "./git";
import { HOME, ensureHome, machine } from "./config";
import type { Agent, Turn } from "./parse";

const sha = (s: string) => createHash("sha1").update(s).digest("hex");

function files(root: string, depth: number, pick: (name: string) => boolean): string[] {
  const out: string[] = [];
  const walk = (dir: string, d: number) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory() && d < depth) walk(p, d + 1);
      else if (e.isFile() && pick(e.name)) out.push(p);
    }
  };
  walk(root, 0);
  return out;
}

export function parseSince(s?: string): number | null {
  if (!s) return null;
  const m = s.match(/^(\d+)([dhw])$/);
  if (!m) throw new Error(`--since takes a value like 7d, 12h or 2w, not "${s}"`);
  return Date.now() - Number(m[1]) * { h: 3600e3, d: 86400e3, w: 7 * 86400e3 }[m[2] as "h" | "d" | "w"];
}

export async function backfill(opts: { summarize?: boolean; since?: string; includeExec?: boolean; refresh?: boolean; log?: (s: string) => void }) {
  ensureHome();
  const log = opts.log ?? console.log;
  const since = parseSince(opts.since);
  const work = join(HOME, "work");
  const sources: { agent: Agent; path: string }[] = [
    ...files(join(homedir(), ".claude", "projects"), 1, (n) => n.endsWith(".jsonl")).map((path) => ({ agent: "claude" as Agent, path })),
    ...files(join(homedir(), ".codex", "sessions"), 3, (n) => n.startsWith("rollout-") && n.endsWith(".jsonl")).map((path) => ({ agent: "codex" as Agent, path })),
  ];
  let stored = 0, updated = 0, seen = 0, skipped = 0, failed = 0, queued = 0;
  const iconsDone = new Set<string>();
  for (const [i, src] of sources.entries()) {
    if (src.agent === "codex" && !opts.includeExec) {
      try {
        const head = readFileSync(src.path, "utf8").slice(0, 20000).split("\n")[0];
        if (JSON.parse(head).payload?.originator === "codex_exec") { skipped++; continue; } // hook-driven reviews, not your work
      } catch {}
    }
    let turns: Turn[], next;
    try { ({ turns, next } = readTurns(src.agent, src.path, null, false)); } catch { failed++; continue; }
    turns = turns.filter((t) => t.cwd && !t.cwd.startsWith(work));
    if (!turns.length) continue;
    embedSentImages(turns);
    seen += turns.length;
    const groups = new Map<string, { ref: any; turns: Turn[] }>();
    for (const t of turns) {
      const ref = projectFor(t.cwd);
      if (!groups.has(ref.key)) groups.set(ref.key, { ref, turns: [] });
      groups.get(ref.key)!.turns.push(t);
    }
    for (const { ref, turns: ts } of groups.values()) {
      if (!iconsDone.has(ref.key)) { iconsDone.add(ref.key); await sendIcon(ref, true).catch(() => {}); }
      for (const summarize of [false, true]) {
        const part = ts.filter((t) => summarize === !!(opts.summarize && (since == null || Date.parse(t.ended_at) >= since)));
        for (let k = 0; k < part.length; k += 40) {
          const chunk = part.slice(k, k + 40).map(({ line, base, ...t }) => t);
          const r = await post("/api/ingest", { machine: machine(), transcript_path: src.path, summarize, refresh: opts.refresh, project: ref, turns: chunk }, 60000).catch((e) => e);
          if (!(r instanceof Response) || !r.ok) { failed++; log(`! ${src.path}: ${r instanceof Response ? r.status + " " + (await r.text()).slice(0, 200) : String(r)}`); continue; }
          const j: any = await r.json();
          stored += j.stored; updated += j.updated;
          if (summarize) queued += j.stored + j.updated + (j.queued ?? 0);
        }
      }
    }
    // the live hook continues from the last turn
    writeFileSync(join(HOME, "offsets", sha(src.path) + ".json"), JSON.stringify(next));
    if ((i + 1) % 50 === 0) log(`… ${i + 1}/${sources.length} transcripts, ${stored} new turns`);
  }
  log(`Backfill done: ${sources.length} transcripts, ${seen} turns read, ${stored} new, ${updated} updated, ${queued} summaries queued, ${skipped} codex exec sessions skipped${failed ? `, ${failed} failures` : ""}.`);
  return { stored, updated, seen, skipped, failed, queued };
}
