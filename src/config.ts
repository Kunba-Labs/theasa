import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "fs";
import { join } from "path";
import { homedir, hostname } from "os";
import { randomBytes } from "crypto";

export const HOME = process.env.THEASA_HOME || join(homedir(), ".theasa");
export const DEFAULT_PORT = 4747;
export const machine = () => hostname().replace(/\.local$/, "");

// the database, spool and hook payloads hold whole prompts and replies: owner only
export function ensureHome() {
  for (const d of ["", "spool", "offsets", "icons-sent", "work"]) mkdirSync(join(HOME, d), { recursive: true, mode: 0o700 });
  chmodSync(HOME, 0o700);
}

export type Config = { server?: string; port?: number; bind?: string };
export function readConfig(): Config {
  try { return JSON.parse(readFileSync(join(HOME, "config.json"), "utf8")); } catch { return {}; }
}
export function writeConfig(c: Config) {
  ensureHome();
  writeFileSync(join(HOME, "config.json"), JSON.stringify(c, null, 2) + "\n");
}
export const serverUrl = () => (process.env.THEASA_SERVER || readConfig().server || `http://127.0.0.1:${readConfig().port ?? DEFAULT_PORT}`).replace(/\/$/, "");

export function tokenPath() { return join(HOME, "token"); }
export function readToken(): string {
  if (process.env.THEASA_TOKEN) return process.env.THEASA_TOKEN;
  try { return readFileSync(tokenPath(), "utf8").trim(); } catch { return ""; }
}
// Never overwrites: a second install keeps the same token.
export function ensureToken(): { token: string; created: boolean } {
  ensureHome();
  const p = tokenPath();
  if (existsSync(p)) return { token: readFileSync(p, "utf8").trim(), created: false };
  const token = randomBytes(24).toString("base64url");
  writeFileSync(p, token + "\n", { mode: 0o600 });
  chmodSync(p, 0o600);
  return { token, created: true };
}
