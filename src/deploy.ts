// Ship a build to the service: the committed HEAD becomes a release in ~/.theasa/releases, tested there,
// then ~/.theasa/current points at it and the service restarts. Uncommitted edits in the repo never run.
import { existsSync, mkdirSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync, readFileSync } from "fs";
import { join, resolve, basename } from "path";
import { randomBytes } from "crypto";
import { HOME, ensureHome, serverUrl } from "./config";

const REPO = resolve(import.meta.dir, "..");
const RELEASES = join(HOME, "releases");
const CURRENT = join(HOME, "current");
const KEEP = 5;

function run(cmd: string[], cwd: string, env: Record<string, string | undefined> = process.env) {
  const r = Bun.spawnSync(cmd, { cwd, env, stdout: "pipe", stderr: "pipe" });
  const out = r.stdout.toString() + r.stderr.toString();
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed:\n${out.trim().split("\n").slice(-25).join("\n")}`);
  return out.trim();
}

const current = () => { try { return readlinkSync(CURRENT); } catch { return null; } };
function point(dir: string) { // atomic: a new link renamed over the old one
  const tmp = CURRENT + ".new";
  rmSync(tmp, { force: true });
  symlinkSync(dir, tmp);
  renameSync(tmp, CURRENT);
}

// the release's own installer writes the plist and the hooks (paths through ~/.theasa/current) and restarts the service
const activate = (dir: string) => run([process.execPath, join(dir, "theasa.ts"), "install", "--service"], dir);

// the release id (folder name) is unique per deploy, so an old server can never pass for the new one
const releaseOf = (dir: string): string => basename(dir);

// release null = the service ran straight from the repo (before the first deploy): any healthy server without a build
async function healthy(release: string | null, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const h: any = await fetch(serverUrl() + "/health", { signal: AbortSignal.timeout(1500) }).then((r) => r.json()).catch(() => null);
    if (h && (release === null ? h.status === "ok" && !h.build : h.build?.release === release)) return h;
    await Bun.sleep(500);
  }
  return null;
}

async function switchTo(dir: string, prev: string | null, log: (s: string) => void) {
  const id = releaseOf(dir);
  let why = "";
  try {
    point(dir);
    activate(dir);
    const h = await healthy(id);
    if (h) return h;
    why = `the server did not report release ${id} within 20 s`;
  } catch (e: any) { why = e.message; }
  // one failure path: put the previous release back and check that it runs
  log(`! ${why}; going back`);
  let back = "";
  if (!prev) {
    // first deploy: before it, the service and hooks ran from the repo; put that back
    try {
      rmSync(CURRENT, { force: true });
      activate(REPO);
      back = (await healthy(null)) ? "the service runs from the repo again, as before" : "put the service back on the repo, but it did not report healthy: check `theasa status`";
    } catch (e: any) { back = `putting the service back on the repo failed too: ${e.message}`; }
  } else {
    try {
      point(prev);
      activate(prev);
      back = (await healthy(releaseOf(prev))) ? `rolled back to ${basename(prev)}, which is running` : `rolled back to ${basename(prev)}, but it did not report healthy either: check \`theasa status\``;
    } catch (e: any) { back = `rollback to ${basename(prev)} failed too: ${e.message}`; }
  }
  let tail = ""; try { tail = readFileSync(join(HOME, "server.log"), "utf8").split("\n").slice(-15).join("\n"); } catch {}
  throw new Error(`release ${id} did not start (${why}); ${back}.\nserver.log:\n${tail}`);
}

export async function deploy(opts: { skipTests?: boolean; log?: (s: string) => void } = {}) {
  const log = opts.log ?? console.log;
  ensureHome();
  if (!existsSync(join(REPO, ".git"))) throw new Error("run deploy from the theasa git checkout");
  const sha = run(["git", "rev-parse", "--short=10", "HEAD"], REPO);
  const subject = run(["git", "log", "-1", "--format=%s"], REPO);
  const dirty = run(["git", "status", "--porcelain", "--", ".", ":!.claude"], REPO);
  if (dirty) log(`Note: uncommitted changes are not deployed (only HEAD ${sha} is):\n${dirty}`);
  if (current()?.includes("-" + sha)) log(`HEAD ${sha} is already the current release; deploying it again.`);

  // unique per deploy (ms + random), and created exclusively: two deploys can never share or delete each other's folder
  mkdirSync(RELEASES, { recursive: true });
  const dir = join(RELEASES, `${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 18)}-${sha}-${randomBytes(3).toString("hex")}`);
  mkdirSync(dir);
  try {
    // no shell: the release path comes from THEASA_HOME and is never parsed as a command
    const tar = dir + ".tar";
    try { run(["git", "archive", "--format=tar", "-o", tar, "HEAD"], REPO); run(["tar", "-xf", tar, "-C", dir], REPO); }
    finally { rmSync(tar, { force: true }); }
    run([process.execPath, "install", "--frozen-lockfile", "--production"], dir);
    if (!opts.skipTests) { log("Running the tests on the release…"); run([process.execPath, "test"], dir, { ...process.env, THEASA_HOME: undefined }); }
    writeFileSync(join(dir, "BUILD"), JSON.stringify({ release: basename(dir), sha, subject, deployed_at: new Date().toISOString() }) + "\n");
  } catch (e) { rmSync(dir, { recursive: true, force: true }); throw e; }

  const h = await switchTo(dir, current(), log);
  prune();
  log(`Deployed ${sha} "${subject}": server up, ${h.turns} turns, queue ${h.queue}.`);
}

export async function rollback(log: (s: string) => void = console.log) {
  const cur = current();
  const all = releases();
  const i = cur ? all.indexOf(cur) : -1;
  if (i <= 0) throw new Error("there is no earlier release to go back to");
  const h = await switchTo(all[i - 1], cur, log);
  log(`Rolled back to ${basename(all[i - 1])}: server up, ${h.turns} turns.`);
}

export function releases() {
  try { return readdirSync(RELEASES).filter((n) => existsSync(join(RELEASES, n, "BUILD"))).sort().map((n) => join(RELEASES, n)); } catch { return []; }
}

function prune() {
  const keep = new Set([current()]);
  const all = releases();
  for (const d of all.slice(0, Math.max(0, all.length - KEEP))) if (!keep.has(d)) rmSync(d, { recursive: true, force: true });
  // half-made release folders (no BUILD) from an aborted deploy
  try { for (const n of readdirSync(RELEASES)) if (!existsSync(join(RELEASES, n, "BUILD")) && join(RELEASES, n) !== current()) rmSync(join(RELEASES, n), { recursive: true, force: true }); } catch {}
}
