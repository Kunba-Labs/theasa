// Register Theasa's hooks in Claude Code and Codex without touching any other hook.
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "fs";
import { join, dirname, resolve } from "path";
import { homedir } from "os";
import { HOME, ensureHome, ensureToken, readConfig, writeConfig, DEFAULT_PORT } from "./config";

// a deployed release runs through ~/.theasa/current, so the next deploy only moves that link
const SELF = resolve(import.meta.dir, "..", "theasa.ts");
const ENTRY = SELF.startsWith(join(HOME, "releases") + "/") ? join(HOME, "current", "theasa.ts") : SELF;
const MARK = `theasa.ts" hook`;
// the PATH symlink (/opt/homebrew/bin/bun) survives upgrades; process.execPath points into a versioned Cellar dir
const BUN = Bun.which("bun") ?? process.execPath;
export const hookCommand = (agent: string) => `"${BUN}" "${ENTRY}" hook ${agent}`;

export const TARGETS = () => [
  { agent: "claude", file: process.env.THEASA_CLAUDE_SETTINGS || join(homedir(), ".claude", "settings.json") },
  { agent: "codex", file: process.env.THEASA_CODEX_HOOKS || join(homedir(), ".codex", "hooks.json") },
];

const isOurs = (h: any) => typeof h?.command === "string" && h.command.includes(MARK);

function load(file: string): { obj: any; text: string | null } {
  if (!existsSync(file)) return { obj: {}, text: null };
  const text = readFileSync(file, "utf8");
  return { obj: JSON.parse(text), text };
}
function dump(obj: any, like: string | null) {
  return JSON.stringify(obj, null, 2) + (like == null || like.endsWith("\n") ? "\n" : "");
}

// Stop for every agent; for Claude also PreToolUse on AskUserQuestion, so the app can show the questions
// (Claude writes a pending tool call to the transcript only after it is answered)
export const HOOKS: Record<string, { event: string; matcher?: string; cmd: string; timeout: number }[]> = {
  claude: [{ event: "Stop", cmd: "claude", timeout: 15 }, { event: "PreToolUse", matcher: "AskUserQuestion", cmd: "claude-ask", timeout: 5 }],
  codex: [{ event: "Stop", cmd: "codex", timeout: 15 }],
};

export function addHook(obj: any, agent: string): boolean {
  obj.hooks ??= {};
  let changed = false;
  for (const h of HOOKS[agent] ?? []) {
    const list = (obj.hooks[h.event] ??= []);
    const mine = list.flatMap((g: any) => (g.hooks ?? []).filter(isOurs));
    if (mine.length) {
      for (const x of mine) if (x.command !== hookCommand(h.cmd)) { x.command = hookCommand(h.cmd); changed = true; } // bun or the repo moved
      continue;
    }
    list.push({ ...(h.matcher ? { matcher: h.matcher } : {}), hooks: [{ type: "command", command: hookCommand(h.cmd), timeout: h.timeout }] });
    changed = true;
  }
  return changed;
}

export function removeHook(obj: any): boolean {
  let changed = false;
  for (const ev of Object.keys(obj?.hooks ?? {})) {
    const list = obj.hooks[ev];
    if (!Array.isArray(list)) continue;
    obj.hooks[ev] = list
      .map((g: any) => { const hs = (g.hooks ?? []).filter((h: any) => !isOurs(h)); if (hs.length !== (g.hooks ?? []).length) changed = true; return { ...g, hooks: hs }; })
      .filter((g: any) => g.hooks.length > 0);
    if (!obj.hooks[ev].length) delete obj.hooks[ev];
  }
  if (obj?.hooks && !Object.keys(obj.hooks).length) delete obj.hooks;
  return changed;
}

const backupPath = (agent: string) => join(HOME, "backup", `${agent}-hooks.orig.json`);

export function install(opts: { server?: string; service?: boolean } = {}) {
  ensureHome();
  const out: string[] = [];
  const { created } = ensureToken();
  out.push(created ? `Token created: ${join(HOME, "token")} (mode 600)` : `Token kept: ${join(HOME, "token")}`);
  if (opts.server) { writeConfig({ ...readConfig(), server: opts.server }); out.push(`Hooks will post to ${opts.server}`); }
  for (const { agent, file } of TARGETS()) {
    const { obj, text } = load(file);
    mkdirSync(join(HOME, "backup"), { recursive: true });
    if (!existsSync(backupPath(agent))) writeFileSync(backupPath(agent), text ?? "");
    if (!addHook(obj, agent)) { out.push(`${agent}: already installed in ${file}`); continue; }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, dump(obj, text));
    out.push(`${agent}: hooks written to ${file}`);
  }
  if (opts.service) out.push(installService());
  return out;
}

export function uninstall(opts: { service?: boolean } = {}) {
  const out: string[] = [];
  for (const { agent, file } of TARGETS()) {
    if (!existsSync(file)) continue;
    const { obj, text } = load(file);
    if (!removeHook(obj)) { out.push(`${agent}: no Theasa hook in ${file}`); continue; }
    // byte-identical restore when nothing else changed since install
    const bak = backupPath(agent);
    if (existsSync(bak)) {
      const orig = readFileSync(bak, "utf8");
      const same = orig === "" ? JSON.stringify(obj) === "{}" : JSON.stringify(JSON.parse(orig)) === JSON.stringify(obj);
      if (same) {
        if (orig === "") unlinkSync(file); else writeFileSync(file, orig);
        unlinkSync(bak);
        out.push(`${agent}: hook removed, ${file} restored to its original bytes`);
        continue;
      }
    }
    writeFileSync(file, dump(obj, text));
    out.push(`${agent}: hook removed from ${file}`);
  }
  if (opts.service) out.push(uninstallService());
  return out;
}

export function hookState() {
  return TARGETS().map(({ agent, file }) => {
    try { return { agent, file, installed: (load(file).obj?.hooks?.Stop ?? []).some((g: any) => (g.hooks ?? []).some(isOurs)) }; }
    catch { return { agent, file, installed: false }; }
  });
}

const LABEL = "nl.theasa.server";
const plistPath = () => join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);

function installService(): string {
  const port = readConfig().port ?? DEFAULT_PORT;
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${esc(BUN)}</string><string>${esc(ENTRY)}</string><string>serve</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>WorkingDirectory</key><string>${esc(HOME)}</string>
  <key>StandardOutPath</key><string>${esc(join(HOME, "server.log"))}</string>
  <key>StandardErrorPath</key><string>${esc(join(HOME, "server.log"))}</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>${esc([join(homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"))}</string>
    <key>THEASA_HOME</key><string>${esc(HOME)}</string>
  </dict>
</dict>
</plist>
`;
  mkdirSync(dirname(plistPath()), { recursive: true });
  writeFileSync(plistPath(), plist);
  const uid = process.getuid?.() ?? 501;
  Bun.spawnSync(["launchctl", "bootout", `gui/${uid}/${LABEL}`], { stderr: "ignore" });
  // bootout returns before the old job is gone; bootstrap fails with error 5 until then
  let r = Bun.spawnSync(["launchctl", "bootstrap", `gui/${uid}`, plistPath()]);
  for (let i = 0; i < 20 && r.exitCode !== 0; i++) {
    Bun.sleepSync(250);
    r = Bun.spawnSync(["launchctl", "bootstrap", `gui/${uid}`, plistPath()]);
  }
  return r.exitCode === 0 ? `Service ${LABEL} loaded: starts at login, serves http://localhost:${port}` : `Service file written to ${plistPath()}, but launchctl said: ${r.stderr.toString().trim()}`;
}

function uninstallService(): string {
  const uid = process.getuid?.() ?? 501;
  Bun.spawnSync(["launchctl", "bootout", `gui/${uid}/${LABEL}`], { stderr: "ignore" });
  if (existsSync(plistPath())) unlinkSync(plistPath());
  return `Service ${LABEL} removed`;
}
