#!/usr/bin/env bun
// Theasa, the all-seeing eye. One entry point for the server, the hook and the admin commands.
import { join } from "path";
import { readdirSync } from "fs";
import { HOME, serverUrl, readToken } from "./src/config";

const [cmd, ...args] = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };

const HELP = `theasa <command>

  serve                         run the server and summary worker (port 4747)
  install [--server URL] [--service]
                                add the Stop hook to Claude Code and Codex, make the token;
                                --server for a client machine, --service to start at login (macOS)
  uninstall [--service]         remove only Theasa's hooks (and the service)
  status [--flush]              server, hooks, spool and queue; --flush sends spooled turns
  backfill [--summarize] [--since 7d] [--include-exec] [--refresh]
                                import past transcripts (stats only unless --summarize);
                                --refresh re-reads diffs and attachments of stored turns
  deploy [--skip-tests]          ship the committed HEAD to the service: release copy, tests,
                                switch, restart, health check (rolls back if it does not start)
  rollback                      go back to the previous release
  token                         print the token (Sidra's Theasa tab asks for it)
  hook claude|codex             run by the agents, not by you
`;

switch (cmd) {
  case "serve": {
    const { serve } = await import("./src/server");
    await serve();
    break;
  }
  case "hook": {
    const { runHook, runAskHook } = await import("./src/hook");
    if (args[0] === "claude-ask") await runAskHook();
    else await runHook(args[0] === "codex" ? "codex" : "claude");
    process.exit(0);
  }
  case "install": {
    const { install } = await import("./src/install");
    for (const l of install({ server: opt("server"), service: flag("service") })) console.log(l);
    console.log(`\nServer ${serverUrl()} (headless; connect from Sidra's Theasa tab). Import history with: theasa backfill`);
    break;
  }
  case "uninstall": {
    const { uninstall } = await import("./src/install");
    for (const l of uninstall({ service: flag("service") })) console.log(l);
    break;
  }
  case "status": {
    const { hookState } = await import("./src/install");
    const { flushSpool } = await import("./src/hook");
    const url = serverUrl();
    const h = await fetch(url + "/health", { signal: AbortSignal.timeout(2000) }).then((r) => r.json()).catch(() => null);
    console.log(h ? `server ${url}: up, v${h.version} ${h.build ? "build " + h.build.sha + " (" + h.build.deployed_at.slice(0, 16).replace("T", " ") + ")" : "from the repo"}, ${h.turns} turns, queue ${h.queue}, failed ${h.failed}, db ${(h.db_bytes / 1e6).toFixed(1)} MB` : `server ${url}: unreachable`);
    for (const s of hookState()) console.log(`${s.agent} hook: ${s.installed ? "installed" : "not installed"} (${s.file})`);
    console.log(`token: ${readToken() ? "present" : "missing, run theasa install"}`);
    let spool = 0;
    try { spool = readdirSync(join(HOME, "spool")).filter((f) => f.endsWith(".json")).length; } catch {}
    if (flag("flush") && spool) { const r = await flushSpool(10000); console.log(`spool: sent ${r.sent}, ${r.left} left`); }
    else console.log(`spool: ${spool} turn batches waiting${spool && !h ? " (sent when the server is back)" : ""}`);
    break;
  }
  case "backfill": {
    const { backfill } = await import("./src/backfill");
    await backfill({ summarize: flag("summarize"), since: opt("since"), includeExec: flag("include-exec"), refresh: flag("refresh") });
    break;
  }
  case "deploy":
  case "rollback": {
    const d = await import("./src/deploy");
    try { cmd === "deploy" ? await d.deploy({ skipTests: flag("skip-tests") }) : await d.rollback(); }
    catch (e: any) { console.error(`${cmd} failed: ${e.message}`); process.exit(1); }
    break;
  }
  case "token":
    console.log(readToken() || "no token yet: run theasa install");
    break;
  default:
    console.log(HELP);
}
