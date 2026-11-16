// Project identity: git remote when there is one, else the main worktree path.
import { basename, dirname } from "path";
import { existsSync } from "fs";

export type ProjectRef = { key: string; name: string; root: string; remote: string; branch: string; head: string };

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stderr: "ignore" });
  return r.exitCode === 0 ? r.stdout.toString().trim() : "";
}

export function normRemote(url: string): string {
  if (!url) return "";
  let s = url.trim().replace(/\.git$/, "").replace(/\/$/, "");
  s = s.replace(/^[a-z+]+:\/\//i, "").replace(/^[^@/]+@/, ""); // protocol, user@
  s = s.replace(/^([^/:]+):(?!\d+\/)/, "$1/"); // scp form host:path
  s = s.replace(/^([^/]+):\d+\//, "$1/"); // drop port
  const [host, ...rest] = s.split("/");
  return [host.toLowerCase(), ...rest].join("/");
}

// A deleted agent worktree (.claude/worktrees/agent-x) still belongs to its repo.
export function stripWorktree(cwd: string): string {
  const i = cwd.indexOf("/.claude/worktrees/");
  return i >= 0 ? cwd.slice(0, i) : cwd;
}

const cache = new Map<string, ProjectRef>();

export function projectFor(cwdIn: string): ProjectRef {
  const hit = cache.get(cwdIn);
  if (hit) return hit;
  let cwd = cwdIn;
  if (!existsSync(cwd)) cwd = stripWorktree(cwd);
  let ref: ProjectRef;
  const top = existsSync(cwd) ? git(cwd, "rev-parse", "--show-toplevel") : "";
  if (top) {
    const common = git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir");
    const root = common.endsWith("/.git") ? dirname(common) : top;
    const remote = git(root, "config", "--get", "remote.origin.url");
    ref = {
      key: normRemote(remote) || root,
      name: basename(root),
      root,
      remote: normRemote(remote),
      branch: git(cwd, "rev-parse", "--abbrev-ref", "HEAD"),
      head: git(cwd, "rev-parse", "--short", "HEAD"),
    };
  } else {
    const root = stripWorktree(cwdIn);
    ref = { key: root, name: basename(root) || root, root, remote: "", branch: "", head: "" };
  }
  cache.set(cwdIn, ref);
  return ref;
}
