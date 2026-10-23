# Open Bots (Browser Agent)

## Approvals and conversation flow

Common read-only shell checks (`pwd`, `ls`, `cat`, and supported Git inspection
commands) run without a permission prompt. Unknown shell syntax, other commands,
and file writes still pause before execution. Commands containing mutations or
substitutions do not become read-only just because they start with `git status`.

At a prompt, choose **Allow once**, **Allow shell & files for this task**, or
**Deny**. A task grant allows shell commands (including commands that contact
remote services) and file edits for the current run only; it expires at completion
or stop and does not transfer to another bot/run. **Approve for me** is the broader
persistent opt-in. Financial task gates and unattended restrictions still apply.

Replies enter upward above the composer, with the newest message at the bottom.
Scrolling back pauses automatic following while new replies/steps arrive. Reduced
motion preferences disable reply entrance animation. Recent context retains the
opening goal and meaningful conversation rather than filling up with approval cards.

## Desktop app (Electron)

```sh
yarn install
yarn desktop:built     # production copy (build/), learn mode on  <- the one you usually want
```

One line: compiles into `build/`, starts the agent server from it, and opens Open Bots in an
Electron window. `/learn` works here.

| Command | Server it runs | Learn mode |
| --- | --- | --- |
| `yarn desktop:built` | compiles `build/`, Electron starts it on a free port | on |
| `yarn desktop:attach` | attaches to a server already listening (default `8766`, override with `BROWSER_AGENT_UI_PORT`) | whatever that server has |
| `yarn desktop` | compiles `dist/`, Electron starts it (dev output) | on |

`yarn desktop:attach` is for when `yarn built` is already running in another terminal — it opens the
window against that server instead of starting a second one. Two servers would otherwise both want
the same Chromium profile directory, and only one process can hold it.

npm works for all of these too (`npm run desktop:built`).

### Claude models

- **Claude CLI (local)** — pick `Claude CLI` / `Claude CLI · Sonnet|Opus|Haiku` in the model menu. Uses your installed `claude` binary and local login (`claude` on PATH, or set `CLAUDE_CLI_PATH`). No Anthropic API key required when logged in.
- **Claude API** — pick Claude Sonnet / Haiku / Opus and set `ANTHROPIC_API_KEY` in `.env` or Settings.

## Run in development and production (browser)

Use two terminal windows from this directory:

```sh
npm run dev
```

The development server rebuilds and restarts as source files change. It uses port **8765** by default; open [http://127.0.0.1:8765](http://127.0.0.1:8765).

In a second terminal, run:

```sh
npm run built
```

This compiles an isolated production copy into `build/` and starts it at [http://127.0.0.1:8766](http://127.0.0.1:8766). Development stays on **8765** while production uses **8766**, so both servers can run at the same time. The `build/` output is ignored by Git.

Set `BROWSER_AGENT_UI_PORT` to override a server's default port. For example, `BROWSER_AGENT_UI_PORT=8770 npm run dev` or `BROWSER_AGENT_UI_PORT=8771 npm run built`. The UI opens automatically in the default browser on start; set `BROWSER_AGENT_NO_OPEN=1` to disable.

## Learn mode (`/learn <task>`)

Learn mode runs a task as a **rehearsal**: the bot stands in your shoes, plays both sides of the
conversation, grades the experience against a fixed rubric, writes down everything that needs work,
shows you the exact code changes it wants to make, and — only if you approve them — applies them and
runs the real build and test suite, so the final verdict is evidence rather than an opinion.

It is on in the built copies (`npm run built`, `npm run desktop`) and off under `npm run dev`,
because a session rebuilds and re-runs the suite, which would fight `tsc --watch`.

```sh
npm run built          # learn mode on, self-fix on
# then, in the app:
/learn read my profile bio and tell me the follower count
```

| Env | Default | Effect |
| --- | --- | --- |
| `BROWSER_AGENT_LEARN_MODE` | `1` in built copies, `0` in dev | Turns the mode and its endpoints on |
| `BROWSER_AGENT_LEARN_SELF_FIX` | `1` | `0` skips writing patches entirely and only reports findings |

Even with self-fix on, no patch is applied without your explicit approval — the setting only
controls whether patches are written and offered at all.

### What a session does

1. **Self-play.** A simulated user sends up to 3 turns on the bus (`learn.turn.user`); the real
   orchestrator answers each one (`learn.turn.bot`). Round 0 is the task as written; later rounds
   push on whatever the previous turn did worst — a failure, a stall, or an unactioned proposal.
2. **Scoring.** Six dimensions, all derived from run telemetry rather than from asking a model how
   it did: `outcome`, `efficiency`, `reliability`, `momentum` (did it ask you something it could
   have looked up?), `clarity` (filler openers, bullet walls, word budget), `continuity` (was the
   follow-up actually read?). Every dimension at 4/5 or better is **stellar**.
3. **Findings.** Each dimension below 4 becomes an improvement note with the evidence, the severity,
   and the file that owns the behaviour.
4. **Proposal — it asks before it touches anything.** Notes go to a model that writes exact-text
   patches. They are shown to you with a before/after preview per file and **nothing is written
   until you say yes**. Tick the ones you want; untick the rest. Declining, closing the tab, or
   just not answering within 30 minutes all mean the same thing: the source is untouched. The
   patches are still written into the session document, so you can read or apply them later by hand.
5. **Verify or roll back.** Once approved: every patch is validated (repo-relative, under `src/` or
   `static/`, no symlinks, no protected files, `find` must match exactly once), applied **all or
   none**, then `npm run build` and `npm test` run for real. If either goes red the snapshot is
   restored and the tree is byte-identical to before. A green run is the only way a patch survives.
6. **Confirmation.** The report ends with what was actually verified. Verdicts are `stellar`,
   `improved` (was not stellar, you approved a fix, verified green) or `needs_human`.

Every session writes a markdown document — scores, the full self-play transcript, each finding, and
the exact diffs with their approval status — whether or not anything was approved. A declined
session still leaves you something to act on.

Learn mode refuses to rehearse a task that could cause a real side effect — following, liking,
posting, paying — since self-play means nobody is watching each turn. Give it the research or
drafting half instead.

Reports, documents and pre-fix file snapshots land in `.browser-agent-learn/`. `latest.md` is the
one to read; `latest.json` is the same thing structured.

| | |
| --- | --- |
| `POST /api/learn` | `{ task, botName?, expertise?, model?, maxRounds? (1-5), allowSelfFix? }` -> `{ status, sessionId, selfFix }` |
| `GET /api/learn/events` | SSE of `learn.*` bus messages; spans the whole session, not one run |
| `GET /api/learn/proposal` | The patch set waiting for a decision, so a reloaded tab can pick it up |
| `POST /api/learn/approval` | `{ approved, patchIds?, reason? }` — omit `patchIds` to mean all of them |
| `GET /api/learn/report` | The last finished report, a chat summary, and the markdown document |

## Local message bus (bots talk by publishing, not by calling)

Bots never call each other. A bot that wants a peer to take over publishes
`agent.handoff.requested` on the in-process bus in [`src/messageBus.ts`](src/messageBus.ts), and one
server-side subscriber decides what happens next ([`src/handoff.ts`](src/handoff.ts) holds the
policy). Delegation used to be wired in the browser UI, which meant a handoff was lost when the tab
closed and never happened at all for scheduled runs.

The subscriber enforces, in one place:

- a **3-hop cap**, so `A -> B -> A` cannot bounce forever;
- the **same risk gate as `/api/run`**, so a bot cannot use a peer to skip an approval it would have
  needed itself;
- **unattended inheritance** — a handoff from a scheduled run stays unattended (no terminal, no
  file writes).

Topics: `agent.handoff.{requested,queued,rejected}`, `agent.run.{started,event,completed}`,
`learn.*`. Patterns use dot segments where `*` matches one segment and `#` matches the rest
(`agent.#`). `bus.request()/bus.reply()` gives request/response over topics with a timeout, and a
handler that throws is isolated — the error is republished on `$bus.error` instead of reaching the
publisher.

## API contract (artifacts)

Typed helpers live in [`src/apiContract.ts`](src/apiContract.ts).

### `GET /api/artifacts/:filename`

Serves a file written by tools such as `generate_image` or `create_document`.

| | |
| --- | --- |
| Path | Filename is sanitized to `[A-Za-z0-9._-]`; missing files → `404` `{ "detail": "Artifact not found." }` |
| Query | `?download=1` (or `true`) forces `Content-Disposition: attachment` |
| Images (`.png` / `.jpg` / `.jpeg` / `.webp` / `.gif`) | Correct image `Content-Type`, `Content-Disposition: inline` (so chat `<img>` previews work) |
| Other types | Matching text/PDF types when known; otherwise `application/octet-stream` + attachment |

Example URL returned on a step event: `/api/artifacts/image-1729000000000.png`.

### SSE run events (`GET /api/events`)

When a tool produces a file, the `step` event may include:

```json
{
  "type": "step",
  "step": 3,
  "toolName": "generate_image",
  "ok": true,
  "message": "Generated image \"…\" …",
  "artifactUrl": "/api/artifacts/image-….png"
}
```

The chat UI renders image `artifactUrl` values inline; non-image artifacts remain download links in the agent summary.
