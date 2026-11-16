# Product Plan: Theasa (the all-seeing eye)

> A LAN service that watches every coding-agent turn and keeps a readable, per-project record of what was done, what was decided, what to watch, and what it cost. Generated 2026-11-13. Market researched live on 2026-11-13.

Visual mockups: https://claude.ai/artifact/NrTgRJB56m4ki4Qdqz3xsG (Project timeline, Overview, Turn detail).

**Design decision, 2026-11-13:** v2 Pulse is the home screen (Linear-Pulse style digest per project per day, health word, outcome lines, "Needs attention" rail). It replaces the v1 Overview with its stat-card grid. v2 Project timeline and v2 Turn detail follow the same look (Geist, grey hierarchy, colour only on status dots and agent tags).

## The product

- **What:** a Bun + SQLite service on one machine on the LAN. It registers itself as the turn-complete (Stop) hook in Claude Code and Codex. When a turn ends, the hook sends a digest of the turn to the server. The server then runs the same agent CLI in the background to write a summary in Simplified Technical English (ASD-STE100, about 80% strict). It shows a timeline per project with the summary, decisions, things to watch, tokens and time per turn.
- **Who:** One developer first. Several Claude and Codex sessions run in parallel over many repos (api-server, shop-v3, mail-app, web-app, crm and others), on more than one machine. The reader is the person who must know, at a glance, what the agents did today and what needs attention.
- **Platform:** web UI (one plain HTML page) served by the Bun process on a localhost port, reachable from the LAN. No Caddy host (decided 2026-11-13).
- **Stack (decided 2026-11-13):** Bun, bun:sqlite, Bun.serve, one static HTML page, no build step. Shared bearer token for hook posts; the UI is read-only and open on the LAN.

### Assumptions as stated

1. A Stop (turn-complete) hook is the right place to capture each turn, for Claude Code and Codex.
2. Tokens used and time spent per turn are available when the turn ends.
3. Running the same agent CLI to summarise is a good way to get summaries.
4. Summaries in STE (about 80%) are easier to read than normal agent prose.
5. Decisions and "things to be aware of" can be pulled out of a turn automatically.
6. A timeline per project is the main view.
7. One server on the network collects turns from all machines.
8. Capture starts with new turns from the hook.

## Market landscape

| Product | Target | Pricing | Take |
|---|---|---|---|
| [agentsview](https://github.com/wesm/agentsview) | Devs, local-first | Free, MIT | Strongest broad rival: 50+ agents, SQLite FTS5, project grouping with worktree rules, multi-machine via Postgres or ClickHouse, Friction Log. No AI summaries per turn. |
| [Agent Kitchen](https://pypi.org/project/agent-kitchen/) | Single dev, macOS | Free, Apache 2.0 | Closest to the timeline idea: repo-grouped timeline, Haiku writes one line per session plus a repo narrative. Per session, not per turn; no decisions or tokens; single machine. |
| [claude-mem](https://docs.claude-mem.ai/hooks-architecture) | Claude Code users | Free | Stop hook writes a structured summary per stop into SQLite, viewer on :37777. Summaries are for agent memory, not a human report. Had a Stop-hook loop bug ([#1288](https://github.com/thedotmack/claude-mem/issues/1288)). |
| [disler observability](https://github.com/disler/claude-code-hooks-multi-agent-observability) | Devs | Free | Same stack as Theasa (hooks, Bun, SQLite). Live event stream, not a durable work log. Claude Code only, localhost only. |
| [ccusage](https://github.com/ryoppippi/ccusage) | Devs | Free, MIT | The default cost counter (19.4k stars). Terminal tables, Claude and Codex, per project. No UI, no summaries, one machine. Accuracy complaints. |
| [Langfuse](https://langfuse.com/integrations/developer-tools/claude-code) / [LangSmith](https://docs.langchain.com/langsmith/trace-claude-code) / [Phoenix](https://arize.com/docs/phoenix/integrations/coding-agents/claude-code) | Teams building LLM apps | Free self-host to $2,499/mo | Trace tree per turn from a Stop hook. Debugging view of raw prompts and tool I/O. LangSmith Insights summarises in batch (Plus plan). Langfuse self-host is 6 containers, 4 to 6 GB RAM. |
| [Entire](https://docs.entire.com/overview) | Teams | Not stated | Links commits to sessions on a git branch; "Dispatches" summarise work into updates. Cloud; stored a plaintext API key in a hands-on test ([review](https://techstackups.com/guides/entire-io-hands-on-what-it-actually-captures/)). |
| [Devin Session Insights](https://docs.devin.ai/product-guides/session-insights) | Devin users | Included | Issue Timeline with high, medium, low impact ratings. Good model for the watch list. Devin only. |

Also-rans: [claude-code-log](https://github.com/daaain/claude-code-log) (static HTML export), [Sniffly](https://github.com/chiphuyen/sniffly) (Claude error analytics), [opcode](https://github.com/winfunc/opcode) (desktop GUI, no releases), [vibe-log](https://github.com/vibe-log/vibe-log-cli) (daily standup via your own agent), [adrchive](https://pypi.org/project/adrchive/) (Stop hook drafts ADRs), [afterpaths](https://github.com/burnssa/afterpaths) (Decisions, Gotchas, Dead Ends), Grafana, Datadog, Honeycomb (OTel dashboards, metadata only), Claude Code `/usage`, `/insights`, `/recap` and the claude.ai analytics dashboard (numbers, org level, no project content).

### How the closest ones work

- **agentsview:** discovers transcript files on disk, syncs into SQLite with FTS5, file watchers push live updates over SSE. Views: token and cost dashboards, heatmap, session viewer, "Recent Edits" by project and path, Friction Log. Multi-machine by pushing to Postgres. Source: https://github.com/wesm/agentsview
- **Agent Kitchen:** batch `agent-kitchen index` over transcripts, Haiku summarises through the Agent SDK so it draws on a Max plan. Status per session: done, in progress, waiting. Source: https://pypi.org/project/agent-kitchen/ , https://vivekhaldar.com/articles/your-agent-sessions-are-disappearing/
- **Langfuse hook:** a single Stop hook reads only the new bytes of the transcript since its last run, tracks offsets per session in a state file, and groups rows into turns. Source: https://langfuse.com/integrations/developer-tools/claude-code
- **adrchive:** Stop hook, gates by file delta and a Haiku classifier, drafts decision records that a human promotes; accepted records are never edited, only superseded. Source: https://pypi.org/project/adrchive/

## Table stakes and conventions

1. Capture with one install step and no code changes (hook or plugin). Sources: Langfuse, LangSmith, Phoenix pages above.
2. Turn as the unit, session as the group. Source: https://langfuse.com/integrations/developer-tools/claude-code
3. Tokens split into input, output, cache read, cache write, with model and estimated cost from the LiteLLM price file. Source: https://github.com/ryoppippi/ccusage
4. Claude Code and Codex at minimum. Sources: ccusage, agentsview.
5. Project grouping from the git root or remote, with worktrees mapped to their repo. Source: https://github.com/wesm/agentsview
6. Full-text search. Source: https://github.com/wesm/agentsview
7. Import of past transcripts (backfill), because Claude Code deletes sessions after 30 days by default. Source: https://code.claude.com/docs/en/costs
8. Hooks never block the agent and always exit 0. Source: https://hoangsonww.github.io/Claude-Code-Agent-Monitor/ , https://hn.jakechampion.name/item/47602986
9. Secret redaction before anything is stored or summarised. Sources: https://docs.langchain.com/langsmith/trace-claude-code , Entire review above.
10. A link from every summary back to the raw transcript. Source: https://github.com/daaain/claude-code-log

## Assumption check

1. **Stop hook is the right capture point: Confirmed.** Langfuse, claude-mem, adrchive and LangSmith all use it. Codex hooks are stable since v0.124 ([source](https://codex.danielvaughan.com/2026/04/23/codex-cli-hooks-graduate-stable-v0124-mcp-observation-inline-config/)); this machine already runs Codex `hooks.json` (SessionStart). Caveat: Codex skipped Stop on Esc-cancelled turns before v0.150 ([source](https://codex.danielvaughan.com/2026/08/27/codex-cli-v0150-interrupt-hooks-turn-interruption-lifecycle-event/)); local Codex is 0.165, so this is fine.
2. **Tokens and time come with the hook: Challenged.** The Claude Code Stop payload has no token, duration or file stats; three requests for it were closed ([#46089](https://github.com/anthropics/claude-code/issues/46089)). Do this instead: the hook reads the transcript JSONL (Claude: `transcript_path`; Codex: `~/.codex/sessions/.../rollout-*.jsonl` with `token_count` events) from a stored byte offset, like Langfuse does.
3. **Summarise with the same agent CLI: Confirmed, with two risks.** vibe-log and Agent Kitchen do the same. Risk one: cost. Every summary spends the user's plan, so Theasa shows summariser tokens and cost apart from the agent's, and uses the smallest model (Claude Haiku, Codex with low reasoning). Risk two: recursion. A `claude -p` summary run fires your own Stop hooks, including `~/.claude/hooks/codex-review.sh`, which runs a full Codex review. The summariser must run with an env guard (`THEASA_CHILD=1`) that the Theasa hook checks, and with `--setting-sources ""` (no user hooks), the same trick `codex-review.sh` already uses for its fallback. claude-mem shipped a Stop-hook loop ([#1288](https://github.com/thedotmack/claude-mem/issues/1288)); do not repeat it.
4. **STE summaries are easier to read: Untested, but an open position.** No summary tool found uses STE ([research](https://themenonlab.blog/blog/asd-ste100-simplified-technical-english-prompting)). The author of STE-Prompt warns that strict STE suits procedures but not risk discussion. So: STE for the "what was done" lines, plainer prose allowed for watch items. Validate by reading the first 50 real summaries.
5. **Decisions and watch items can be extracted automatically: Partly challenged.** It works (afterpaths, adrchive), but summaries hallucinate: one Claude summary invented a task to remove a protective Stop hook ([source](https://claudeissues.com/issue/43930-bug-session-summary-hallucinated-a-task-to-remove-a-protective-stop-hook-potenti)). Do this: every decision carries "why" and "not chosen", links to its turn, and can be dismissed. Watch items have an open or done state and an impact level (Devin's pattern). A decision that is replaced is marked superseded, never edited (adrchive's rule).
6. **Per-project timeline is the main view: Confirmed.** Agent Kitchen, claude-code-log and agentsview all group by repo; "group sessions by project" is a repeated Claude Code request ([#35431](https://github.com/anthropics/claude-code/issues/35431)). Challenge on identity: the folder name is not enough. Your repos use `.claude/worktrees/agent-*` and several sessions per checkout. Project = git toplevel of the main worktree, keyed by remote URL when there is one.
7. **One server for all machines: Confirmed as a real gap.** Only agentsview (Postgres) and Agent Monitor (SSH) do multi-machine; users build their own Supabase sync ([source](https://dev.to/ryantech00/how-i-track-claude-code-costs-across-multiple-pcs-13bl), ccusage #222). LAN-only answers the "no upload to a third party" objection ([HN](https://news.ycombinator.com/item?id=47350416)).
8. **Start with new turns only: Challenged.** Backfill is table stakes. Claude Code deletes transcripts after 30 days, so day one should import what is still on disk. Summaries for backfilled turns are optional (cost), stats are not.

## Gaps and opportunities

### Missing from the plan (ranked)

Table stakes:
1. Backfill import of existing Claude and Codex transcripts.
2. Transcript-based stats (tokens with cache split, model, wall time, tool calls, files changed).
3. Secret redaction before storage and before the summariser sees the text.
4. Full-text search over prompts, summaries, decisions and file paths.
5. Worktree and multi-session mapping to one project.
6. Non-blocking hook with a local spool when the server is down (one community Langfuse hook lost 55% of sessions under concurrency).
7. Link to raw transcript and a resume command.

Differentiators worth having:
1. **Real project icons**, found in the repo (favicon, apple-touch-icon, app icon) and shown everywhere a project appears. Asked for 2026-11-13. Detection is not trivial: shop-v3's Rails app ships a placeholder red circle as `icon.png`, while its real mark is `frontend/public/favicon.svg`. So: ranked detection plus a manual override in the UI.
2. Summariser cost panel (no rival shows the cost of its own summaries).
3. Decision log across projects with why and not-chosen.
4. Watch list with open or done state and impact.

### Openings (what rivals do badly)

- Nobody gives a readable per-turn record; observability tools give trace trees full of raw tool output.
- Cost figures are distrusted (ccusage #288, #705). Show the split and say "estimate at API list price".
- Single-machine tools; heavy self-host stacks (Langfuse).

### Not building

- Token leaderboards (Meta and Amazon removed theirs after gaming; [source](https://www.cio.com/article/4178825/amazon-deletes-devs-tokenmaxxing-leaderboard-to-minimize-costs-2.html)).
- A trace tree with full tool I/O. Link to the transcript instead.
- OpenTelemetry ingest. Hooks plus transcripts give more, with less setup.
- Cloud sync or accounts.

## Production completeness

- **Auth and accounts:** one shared bearer token (`~/.theasa/token`) for all write endpoints. UI and read API open on the LAN, read-only. No user accounts. Needed. Changed 2026-11-16 (public release): reads need the token too, except `/`, `/health`, `/api/events` and project icons; `THEASA_OPEN_READS=1` opens turn data again.
- **Unhappy paths:** server down (hook spools to disk, flushes later); summary fails or times out (retry with backoff, shown as failed, manual retry); bad token (401, hook logs it once); transcript missing (turn stored with stats unknown); empty states for no projects and no turns; very long turns (digest truncated with a marker). Needed.
- **Admin:** CLI only: `theasa serve | install | uninstall | status | backfill | token`. Needed.
- **Money:** not needed; no billing.
- **Notifications:** not needed now (Parked).
- **Data:** SQLite file in `~/.theasa/`, WAL mode. Backup is a file copy (documented). Retention: forever. Export: JSON per project from the API. Needed.
- **Legal/compliance:** not needed; personal LAN tool. Redaction covers the real risk.
- **Analytics and observability:** the Summary worker panel (queue, failures, delay, summariser cost) and a `/health` endpoint. Needed.
- **Onboarding:** `theasa install` writes hooks for Claude and Codex, makes the token, offers backfill. Empty UI state shows the install command. Needed.
- **i18n:** not needed; English only.
- **Mobile/responsive:** the timeline must read on a phone (the menus stack). Needed.
- **SEO/landing:** not needed.

## Build plan

One build. Data flow:

1. **Hook** (`theasa hook claude|codex`, run by the agent): exits at once if `THEASA_CHILD` is set or `stop_hook_active` is true. Reads the stdin payload, finds the transcript, reads from the stored offset, builds a turn digest (prompt, final reply, assistant text, tool calls with file paths, token sums, first and last timestamps, model, cwd, git root, branch, head, remote), redacts secrets, POSTs it with a 3 s timeout. On failure it writes the digest to `~/.theasa/spool/`. Always exits 0. Once per project per machine it also sends the detected icon.
2. **Server** (`theasa serve`): Bun.serve on `0.0.0.0:<port>`. SQLite tables: `projects`, `sessions`, `turns`, `decisions`, `watch_items`, `summary_jobs`, plus an FTS5 table. Ingest is idempotent on (agent, session_id, turn_id).
3. **Summary worker** (in the server process): a queue with concurrency 1 to 2. Runs `claude -p --model haiku --setting-sources "" --output-format json` or `codex exec` with low reasoning, with `THEASA_CHILD=1`, cwd in a scratch dir, a JSON schema prompt (summary lines, decisions with why and alternative, watch items with impact). Stores result and the summariser's own tokens.
4. **UI**: one HTML page with three views from the mockups: Overview, Project timeline, Turn detail. Polls or uses SSE for live updates.

Data model notes: a project is keyed by git remote (or main-worktree path when there is no remote); sessions belong to a project and a machine; turns hold stats and the redacted digest; decisions and watch items belong to a turn and roll up to the project.

### Parked

- More agents (Gemini CLI, OpenCode, Cursor): unpark when one of them is used daily.
- Daily or weekly digest per project (standup text): unpark after a month of turn data exists.
- Desktop or phone notification for high-impact watch items: unpark if watch items get missed.
- Semantic search: unpark if FTS misses things in practice.
- ADR file export into the repo: unpark if decisions should live in git.
- Per-user auth on the UI: unpark if anyone outside the household LAN gets access.
- herdr workspace launcher: user did not ask for one with the localhost-only setup.

## Risks and open questions

- STE readability is untested. Review the first 50 summaries before tuning the prompt.
- Summariser cost on a busy day (about 200 turns per week now). Haiku keeps it small; measure in the worker panel.
- Codex Stop payload fields are not documented on this machine; the hook must find the rollout file by session id when `transcript_path` is missing.
- Remote machines need the CLI only for their hook (Bun on each machine, or a tiny shell plus curl fallback). Decide when the second machine is added.
- Summaries can be wrong. Mitigation: evidence links, dismiss, redo summary.

## Sources

Research files with every URL read: `research-usage.md`, `research-observability.md`, `research-summaries.md` (session scratchpad, 2026-11-13). Key URLs:

- https://github.com/wesm/agentsview
- https://pypi.org/project/agent-kitchen/
- https://vivekhaldar.com/articles/your-agent-sessions-are-disappearing/
- https://docs.claude-mem.ai/hooks-architecture
- https://github.com/thedotmack/claude-mem/issues/1288
- https://github.com/disler/claude-code-hooks-multi-agent-observability
- https://github.com/ryoppippi/ccusage
- https://langfuse.com/integrations/developer-tools/claude-code
- https://langfuse.com/resources/engineering/coding-agent-tracing
- https://docs.langchain.com/langsmith/trace-claude-code
- https://docs.langchain.com/langsmith/insights
- https://arize.com/docs/phoenix/integrations/coding-agents/claude-code
- https://docs.entire.com/overview
- https://techstackups.com/guides/entire-io-hands-on-what-it-actually-captures/
- https://docs.devin.ai/product-guides/session-insights
- https://pypi.org/project/adrchive/
- https://github.com/burnssa/afterpaths
- https://code.claude.com/docs/en/costs
- https://code.claude.com/docs/en/monitoring-usage
- https://github.com/anthropics/claude-code/issues/29585
- https://github.com/anthropics/claude-code/issues/46089
- https://github.com/anthropics/claude-code/issues/41133
- https://news.ycombinator.com/item?id=47350416
- https://hn.jakechampion.name/item/47602986
- https://themenonlab.blog/blog/asd-ste100-simplified-technical-english-prompting
- https://codex.danielvaughan.com/2026/04/23/codex-cli-hooks-graduate-stable-v0124-mcp-observation-inline-config/
- https://codex.danielvaughan.com/2026/08/27/codex-cli-v0150-interrupt-hooks-turn-interruption-lifecycle-event/
- https://www.cio.com/article/4178825/amazon-deletes-devs-tokenmaxxing-leaderboard-to-minimize-costs-2.html

## Decision 2026-11-14: headless backend, UI in Sidra
owner: "Delete our web ui and just keep the backend headless since sidra has the ui". The web UI
(`public/`, the marked/DOMPurify vendor routes and the PWA icons) is removed; the server keeps only the
JSON API, `/api/events` and project icons. The UI is the native Theasa tab in Sidra (`Sidra/Theasa`,
spec F15 in `sidra/docs/plans/sidra-spec.md`). Spec items F7-F11 and F13 that describe web screens now
describe that tab; their checks were made on the web version and are re-verified in Sidra. What this
gives up: no view from a browser on a machine without Sidra (any other Mac, a phone).
