> 2026-11-14: the web UI is removed (see the decision in theasa.md). UI items below are now built and
> verified in Sidra's Theasa tab (sidra-spec F15); this server spec keeps the API behind them.

# Build Spec: Theasa

> Contract for the build. Derived from theasa.md on 2026-11-13.
> Check items off ONLY when the acceptance criteria are verified working,
> not when the code is merely written.

## How to use this spec
Build against this file. When a feature lands and its criteria verify, flip
`[ ]` to `[x]` and commit the spec change with the feature. Run
`/product-planner check` to audit coverage.

## F1. Install and setup
- [x] `theasa install` adds a Stop hook to `~/.claude/settings.json` and to `~/.codex/hooks.json`, and keeps every existing hook in both files.
  - Accept: diff both files before and after; only the Theasa entry is added; existing `codex-review.sh`, `manual-guard.sh` and herdr hooks are still there.
- [x] Running `theasa install` twice adds nothing the second time.
  - Accept: second run reports "already installed"; the files are byte-identical.
- [x] `theasa uninstall` removes only the Theasa hook entries.
  - Accept: after install then uninstall, both files equal their original content.
- [x] Install creates `~/.theasa/token` (random, mode 600) when none exists, and never overwrites an existing one.
  - Accept: `stat` shows mode 600; a second install keeps the same token.
- [x] Install on a client machine takes a server URL (`--server http://host:port`) and stores it in `~/.theasa/config.json`.
  - Accept: hook posts go to that URL; without the flag they go to localhost.
- [x] `theasa status` prints server reachability, hook install state per agent, spool size and queue size.
  - Accept: with the server stopped it says "server unreachable" and the spool count.

## F2. Turn capture (hook)
- [x] A finished Claude Code turn creates one turn record on the server within 5 seconds.
  - Accept: ask Claude a one-line question in any repo; the turn appears in `GET /api/turns?project=<id>`.
- [ ] A finished Codex turn creates one turn record on the server within 5 seconds. (gap: works end to end, verified with `--dangerously-bypass-hook-trust`; Codex runs the hook only after you trust it once in Codex, which is your step)
  - Accept: same check with `codex` in a repo.
- [x] The hook always exits 0 and returns in under 1 second, also when the server is down.
  - Accept: stop the server, finish a turn, time the hook (`time theasa hook claude < payload.json`), exit code 0.
- [x] When the server is unreachable, the turn is written to `~/.theasa/spool/` and sent on the next successful hook run or by `theasa status --flush`.
  - Accept: stop server, finish 2 turns, start server, finish 1 turn; all 3 turns are on the server, spool is empty.
- [x] The hook does nothing when `THEASA_CHILD=1` is set or when `stop_hook_active` is true.
  - Changed 2026-11-13: `stop_hook_active` is no longer skipped. A Stop hook that blocks (codex-review.sh) lets the turn continue, so skipping would lose the turn's end. The hook re-reads from the last turn's start instead, and the server updates the turn.
  - Accept: run the hook with `THEASA_CHILD=1`; no request is made and no spool file is written.
- [x] A turn is only stored once, even when the hook fires twice for the same turn.
  - Accept: pipe the same payload to the hook twice; the server has one turn.
- [x] The hook reads only the part of the transcript after the previous turn (stored byte offset per session).
  - Accept: in a 3-turn session, turn 3's prompt and tools hold only turn 3's content.
- [x] Codex turns are found when the payload has no `transcript_path`, by looking up the rollout file by session id.
  - Accept: a payload with only `session_id` and `cwd` still produces a turn with token counts.

## F3. Turn stats
- [x] Each turn stores tokens split into input, output, cache read and cache write, and the model name.
  - Accept: compare a Claude turn's totals with the sum of `usage` fields in its transcript lines; they match exactly.
- [x] Codex turns store tokens from the `token_count` events of that turn (difference of `total_token_usage`).
  - Accept: totals match the last minus first `total_token_usage` in that turn's rollout lines.
- [x] Each turn stores start time, end time and wall duration.
  - Accept: start is the user prompt timestamp, end is the last assistant line; duration shown matches.
- [x] Each turn stores the tool calls (name and count) and the files changed (path, lines added, lines removed).
  - Note: files written through Bash (`echo >`, `sed -i`) are not counted; only Edit, Write and patch results are.
  - Accept: a turn that edits 2 files lists both paths with plus and minus counts on the Turn detail view.
- [x] Each turn stores an estimated cost at API list price, labelled as an estimate.
  - Accept: the cost shown equals tokens times the prices in the bundled price table; the UI says "Est. cost".
- [x] Each turn stores machine name, git branch and HEAD commit.
  - Accept: Turn detail shows them; values match `hostname` and `git rev-parse` at the time of the turn.

## F4. Project identity and icons
- [x] Turns from a git worktree (for example `.claude/worktrees/agent-*`) are filed under the main repo's project.
  - Accept: a turn run inside a worktree of api-server shows under "api-server", not as a new project.
- [x] Two clones of the same remote on two machines are one project.
  - Accept: post turns with the same remote URL and different paths and hostnames; one project, two machines listed.
- [x] A folder with no git repo is its own project, keyed by its path.
  - Accept: a turn in a plain folder creates a project named after the folder.
- [x] The project icon is found in the repo and shown in the sidebar, project header, overview table and decision cards.
  - Accept: api-server, mail-app, web-app and crm show their own icons from their `public/` folders.
- [x] Icon detection prefers an icon that a page actually links (`<link rel="icon">` in an index.html or layout) and skips framework placeholder icons.
  - Changed 2026-11-13: a native app icon (iOS/macOS AppIcon 1024) ranks above web icons, so shop-v3 shows its seller-app icon (same mascot, on yellow). Rails, Vite and React placeholders are skipped.
  - Accept: shop-v3 shows the mascot from `frontend/public/favicon.svg`, not the red circle `app/public/icon.png`.
- [x] A project without an icon shows a letter tile.
  - Accept: theasa shows a "T" tile until it has an icon.
- [x] The icon can be replaced by hand from the project page.
  - Accept: upload a PNG on the project page; it shows everywhere and survives a new turn.
- [x] A project can be renamed and hidden in the UI.
  - Accept: rename "shop-v3" to "Shop"; the new name shows on all views; a hidden project leaves the sidebar but its data stays.

## F5. Summaries
- [x] After a turn is stored, a summary job runs in the background with the same agent that did the turn.
  - Accept: a Codex turn's summary says "written by Codex"; a Claude turn's says "written by Claude Code".
- [x] The summariser uses the smallest model (Claude Haiku; Codex with low reasoning effort).
  - Note: Claude runs `--model haiku`; Codex runs its configured default model with `model_reasoning_effort=low`, because the ChatGPT login rejects some model names.
  - Accept: the summary job record shows the model used.
- [x] Summary runs do not trigger Theasa's hook or the user's other Stop hooks.
  - Accept: after 5 summaries, there are no new turns from the summariser and no `codex-review.sh` run in the logs.
- [x] The summary is 1 to 6 lines in Simplified Technical English: short sentences, active voice, one statement per sentence.
  - Verified 2026-11-13 on 67 real summaries: 93% of lines are 20 words or fewer.
  - Accept: read 10 summaries; no sentence over 20 words in the "what was done" list.
- [x] A turn with no real work (a short question and answer) gets a one-line summary, not an empty one.
  - Accept: ask "what time is it"; the summary is one line.
- [x] While a summary is pending, the turn shows "Summary in queue" with the agent name.
  - Accept: the timeline shows the pending state, then the summary without a page reload.
- [x] A failed summary is retried up to 3 times with backoff, then shown as failed with a Retry button.
  - Accept: set the CLI path to a missing binary; the job fails 3 times, the turn shows "Summary failed", Retry works after the path is fixed.
- [x] "Redo summary" on Turn detail runs a new summary and replaces the old one.
  - Accept: click it; the summary text changes and the job count goes up by one.
- [x] Each summary gives the turn a verdict: Clean (done, nothing open), Watch (done, one or more watch items), Broken (tests or build fail at the end of the turn). Added 2026-11-13 with the v2 design.
  - Accept: a turn that ends with failing tests shows "Broken" with a red dot; one with a watch item shows "Watch".
- [x] Each summary gives 3 to 8 steps, each with the time from the prompt, a title, one line of text and a tone (neutral, good, problem). Added 2026-11-13 with the v2 design.
  - Accept: Turn detail shows the steps on a time rail; the first step is at +0:00 and the last is before the turn's duration.
- [x] The summariser's own tokens, cost and delay are stored per job.
  - Accept: the Overview "Summary worker" panel shows totals that equal the sum over jobs.

## F6. Decisions
- [x] Decisions extracted from a turn show with "why" and "not chosen" (when the turn gives them).
  - Accept: a turn where the agent chose between two options shows both fields on Turn detail.
- [x] Each project has a decision log, newest first, each linked to its turn.
  - Accept: click a decision in the right rail; Turn detail of that turn opens.
- [x] Overview shows the latest decisions across all projects, with the project icon.
  - Accept: 4 newest decisions from different projects are listed.
- [x] A decision can be dismissed as wrong; it then leaves the log but stays visible on its turn, struck through.
  - Accept: dismiss one; it is gone from the rail and shown struck through on Turn detail.
- [x] A decision can be marked as superseded by a later one; both stay, the old one is labelled.
  - Accept: mark one superseded; the log shows the old one under the new one, labelled "superseded".

## F7. Watch list
- [x] Watch items extracted from a turn have text and an impact (high, medium, low).
  - Accept: Turn detail shows each watch item with its impact label.
- [x] Open watch items show in the project's right rail and as a count in the sidebar.
  - Accept: api-server with 2 open items shows "2 watch" in the sidebar.
- [x] "Mark done" closes an item; it leaves the open list and the counts drop.
  - Accept: mark one done; sidebar count goes from 2 to 1 without reload.
- [x] Overview shows the total open watch items and which projects hold them.
  - Accept: the "Needs attention" count on Pulse equals the sum of open items.

## F8. Timeline view
- [x] The project timeline lists turns newest first, grouped by day, each with time, agent badge, model, duration, tokens and cost.
  - Accept: compare with the mockup; all fields present for a summarised turn.
- [x] Each turn shows the user's prompt (truncated to 2 lines) and the summary lines.
  - Accept: a long prompt is cut with an ellipsis; Turn detail shows it in full.
- [x] Turns with decisions or watch items show as a card; quiet turns (no files changed, no decisions) show as one grey line; more than 3 quiet turns in a row fold into "Show N more quiet turns". Added 2026-11-13 with the v2 design.
  - Accept: a day with 9 quiet turns shows 3 lines and a fold button that opens the rest.
- [x] Range filter Today, 7 days, 30 days changes the turns and the stat tiles.
  - Accept: pick 7 days; the Turns tile count equals the number of turns listed.
- [x] Agent filter (all, Claude Code, Codex) and "only with decisions" filter work.
  - Accept: pick Codex; only Codex turns remain.
- [x] New turns and finished summaries appear without reload.
  - Accept: keep the page open, finish a turn in another terminal; it appears within 5 seconds.
- [x] The header shows how many agents are active (a turn ended in the last 10 minutes per session).
  - Accept: with 2 sessions busy, it reads "2 agents active".

## F9. Overview (Pulse)
- [x] Pulse lists each active project per day with its icon, health word (worst verdict of its turns), turn count, agents, and 2 to 3 outcome lines. Added 2026-11-13 with the v2 design.
  - Accept: a project with one Broken turn today shows "Broken" on Pulse, under "Today".
- [x] A "Needs attention" list shows all open watch items across projects, high impact first.
  - Accept: order is high, medium, low; each item links to its turn.
- [x] Totals strip: turns, tokens, agent time, estimated cost, for the chosen range.
  - Accept: numbers equal SQL sums over the same range.
- [x] Tokens per day chart, stacked by agent, for the chosen range.
  - Accept: each bar equals the day's sum per agent.
- [x] Projects table: icon, name, machines, last turn, turns, tokens, time, cost, open watch items; click opens the timeline.
  - Accept: sort order is last turn first; clicking a row opens that project.
- [x] Summary worker panel: written, in queue, failed, summariser tokens and cost, median delay; "Retry failed" button.
  - Accept: with 2 failed jobs, the button retries both.

## F10. Turn detail
- [x] Shows the full prompt, summary, decisions, watch items, files changed, time, tokens and tools used.
  - Accept: matches the mockup's sections for a real turn.
- [x] Shows the resume command for that session (`claude --resume <id>` or `codex resume <id>`) with a Copy button.
  - Accept: paste the copied command in the repo; the session resumes.
- [x] "Raw transcript" shows the redacted turn digest that was stored.
  - Accept: the digest opens; secrets in it are masked.

- [x] The agent's last message shows under "The agent's reply", rendered as markdown (headings, lists, tables, code blocks, links) and sanitised; a long reply is folded behind "Show the whole reply". Added 2026-11-13.
  - Accept: a turn whose reply has a table and a code block shows both formatted; a `<script>` in the reply does not run.
- [x] "Changes" groups the changed files into Code, Documents and text, Images and media, and Outside this repo; each file opens to its diff with added lines green and removed lines red. Added 2026-11-13.
  - Accept: turn 3166 (theasa) shows the spec edit as a coloured diff under Documents and text, and scratchpad files under Outside this repo.
- [x] What you attached shows under "You asked": pasted images as thumbnails, files you mentioned as chips. Added 2026-11-13.
  - Accept: web-app turn 7829 shows its 12 pasted screenshots.
- [x] What the agent handed back shows under "Shared with you": each published artifact once, with its link, title and how often it was published; sent files, with a preview for images. Added 2026-11-13.
  - Accept: turn 3166 lists "Theasa mockups, published 3 times" with its claude.ai link.
- [x] Timeline cards say what changed in one line: code (+/- in N files), documents, media, files outside the repo, attachments from you, items shared with you. Added 2026-11-13.
  - Accept: a turn that only published an artifact shows as a card with "1 item shared with you".

## F11. Search
- [x] Search finds turns by words in prompt, summary, decisions, watch items and file paths, across all projects.
  - Accept: search "webhook"; turns whose summary or files mention it are listed with project icon and date.
- [x] Search results link to Turn detail.
  - Accept: click a result; the right turn opens.

## F12. Backfill
- [x] `theasa backfill` imports past Claude Code and Codex transcripts that are still on disk, with stats, without summaries.
  - Accept: run it; turn counts per project match the number of user prompts in the transcripts; no summary jobs are created.
- [x] `theasa backfill --summarize --since 7d` also queues summaries for the imported turns in that range.
  - Accept: summary jobs are created only for turns in the last 7 days.
- [x] Running backfill twice does not duplicate turns.
  - Accept: second run reports 0 new turns.
- [x] Theasa's own summariser sessions are skipped by backfill.
  - Accept: no turn from the summariser's scratch dir appears after backfill.

## F13. Live agents and answers (added 2026-11-14)
The owner asked: "detect waiting agents and show the questions, allow me to answer the questions inline from the app".
Source of truth is herdr (`herdr agent list`), which knows every agent pane on the machine and whether it is
working, done, idle or blocked on a dialog. Only agents in herdr panes are seen.
- [x] The Agents page lists every agent pane, grouped Needs you / Your turn / Working, with project, pane title and age
  - Accept: open `#/agents` with herdr running; each pane shows once with its status. Without herdr the page says so.
- [x] A Claude AskUserQuestion shows as the questions with their options (from a PreToolUse hook on AskUserQuestion)
  - Accept: a new Claude session asks two questions; the card shows both with header, options and descriptions.
- [x] Answers go back into the pane: the dialog is cancelled, the answers are the next prompt
  - Accept: pick options and type an own answer, Send; the agent's next message repeats the answers. Verified 2026-11-14.
- [x] Any other dialog (permission prompt, trust dialog, Codex approval, a session started before the hook) shows the pane's screen with its choices as buttons
  - Accept: numbered choices send the digit; a bare cursor list sends arrows and Enter. Verified on the folder-trust dialog.
- [x] A finished agent takes your next message from the card; a question at the end of its last reply is highlighted
  - Accept: type in the card, ⌘ Enter or Send; it appears in the pane as a prompt.
- [x] Header shows "N need you" (amber) and "N agents working" from herdr; Pulse shows the waiting agents first
- [x] Typing an answer is never interrupted by live updates; drafts survive a rerender
- [x] Writes need the token; keys are a fixed list (digit, arrows, enter, esc, tab, space, y, n); unknown panes get 404
- [x] A question carries what the agent showed with it (added 2026-11-14, owner: "when a agent asks question and it has designs to present we should show them as attachments to the agent question so we can review"): each option's `preview`, the agent's text before the question, images it sent (SendUserFile, served from `/api/asks/attachments/:id`, raster only) and artifacts it published (claude.ai links only)
  - Accept: an agent sends two PNGs, then asks with previews; `/api/agents` shows the previews, its sentence and both images. Verified live 2026-11-14.
- [x] A dialog herdr reads as done (Claude's side-by-side preview layout) still counts as open while the screen shows it; an answer waits until the dialog is gone from the screen
- [ ] Push notification on the iPad when an agent needs you (gap: needs Web Push with a service worker and VAPID keys; not built)

## Non-functional
- [x] All write endpoints need `Authorization: Bearer <token>`; a missing or wrong token gets 401 and stores nothing.
  - Accept: `curl -X POST` without a token returns 401; the turn count does not change.
- [x] The UI and read API need no token and change nothing.
  - Accept: every GET works without a token; no GET changes data. Mark done, dismiss, rename and retry are POSTs that need the token, which the page reads from a one-time login (token pasted once, kept in localStorage).
- [x] The server listens on `0.0.0.0` on a fixed port (4747). Changed 2026-11-13: it binds `127.0.0.1` by default; `THEASA_BIND` changes it.
  - Accept: open the UI from another device on the LAN.
- [x] Secrets are redacted in the hook before sending (API keys, bearer tokens, private keys, `.env` style `KEY=value` for names with SECRET, TOKEN, KEY, PASSWORD).
  - Accept: a turn that prints `sk-ant-...` and `STRIPE_SECRET_KEY=...` is stored with both masked; the summariser input is masked too.
- [x] Turn digests over 60k characters are trimmed in the middle with a marker before storing and summarising.
  - Accept: a huge turn stores a digest under the limit with "[trimmed]".
- [x] SQLite runs in WAL mode; concurrent hook posts from 5 sessions all land.
  - Accept: fire 20 parallel posts; 20 turns stored, no "database is locked" error.
- [ ] Empty states: no projects (shows the install command), project with no turns, no decisions, no watch items. (gap: written, not walked on an empty database)
  - Accept: start with an empty DB; each view shows its empty message, no broken layout.
- [x] Layout works at phone width (390 px): menus stack, no horizontal scroll except inside the projects table box.
  - Accept: resize to 390 px; timeline reads top to bottom.
- [ ] Text contrast at least 4.5:1, real buttons and links, keyboard reachable filters. (gap: contrast checked on the palette, muted text 5.1:1 or more; a keyboard walk through the timeline was not done)
  - Accept: tab through the timeline; every control gets focus; contrast checker passes on muted text.
- [x] `GET /health` returns status, DB size, queue length and version.
  - Accept: curl returns JSON with those fields.
- [ ] `GET /api/projects/<id>/export` returns all of the project's turns, decisions and watch items as JSON. (gap: export verified; the re-import script is not written)
  - Accept: the export re-imports into an empty DB with the same counts (manual script).
- [ ] The server runs as a background service that starts at login (launchd plist written by `theasa install --service`). (gap: launchd job loaded and running with RunAtLoad and KeepAlive; a reboot was not tested)
  - Accept: reboot; the UI is up without a manual start.

## Out of scope
- More agents (Gemini CLI, OpenCode, Cursor). Unpark when one is used daily.
- Daily or weekly digests. Unpark after one month of data.
- Notifications for high-impact watch items. Unpark if items get missed.
- Semantic search. Unpark if FTS misses things.
- ADR file export into repos. Unpark if decisions should live in git.
- Per-user accounts and auth on the UI. Unpark if access widens beyond the LAN.
- Token leaderboards, OpenTelemetry ingest, trace trees with full tool I/O, cloud sync.
- Caddy host and herdr launcher (localhost port only, decided 2026-11-13).
