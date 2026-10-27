# OpenBuddy

OpenBuddy is the desktop product built on the existing browser-agent runtime. It uses compact per-bot playbooks, a local pub/sub bus and optional MongoDB-backed event synchronization. Fireworks++ is not a dependency or prerequisite.

See [production-readiness and operating boundaries](docs/buddy-bot-production.md) before deployment.

For terminal chat and a standalone server without Electron, see the [OpenBuddy CLI preview](docs/cli.md).

Open `/docs` on the running local server for setup, conversation reset, orchestration,
coding, CLI installation, validation and known limitations. Settings includes a
Reset conversations control for one bot or all bots.

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

The send button stays available during a run. Follow-up messages queue in order.
Sending a new instruction while a run waits for browser verification or shell/file
approval stops that waiting run and starts the new request; it does not approve
the pending action. The Stop button cancels the current run and its queued requests.

## What gets gated, and how it generalises

Approval is decided by what an action **does**, not by which site it happens on.
Matching the task text against platform vocabulary ("connect with founders on
LinkedIn", "launch the Instantly sequence") needs a new rule for every platform
and lets every unlisted one through. Button verbs, on the other hand, are shared
across the whole web: `Send`, `Follow`, `Publish`, `Delete`, and `Pay` mean the
same thing everywhere, so classifying the button covers sites nobody wrote a rule
for — including ones that did not exist when this was written.

`src/actionEffect.ts` sorts every click and keystroke into four levels:

| Effect | Meaning | Gated? |
| --- | --- | --- |
| `read` | only looks at the page | no |
| `reversible` | only this user sees it, and it can be undone — filters, drafts, bookmarks | no |
| `outward` | someone else sees it, or it goes out under the user's name — follow, connect, send, post, comment, like, endorse, apply, launch a campaign | yes, unless **Approve for me** is on |
| `irreversible` | destroys something or moves money — delete, remove, pay, buy, place order, cancel a subscription | **always**, even with Approve for me |

Two independent signals feed the decision and the stricter one wins:

1. the model declares an `effect` on the tool call — it can see the screenshot and
   knows that a bare `Save` on a profile-edit page makes the bio public;
2. the gate independently reads the element's real label and role.

The ratchet only turns one way. A model that declares `read` while clicking a
button labelled `Delete account` is still stopped. Raising the level is always
allowed, because over-declaring costs one question and under-declaring is how real
damage happens.

Known limit, stated rather than hidden: icon-only buttons (Instagram's heart,
LinkedIn's connect icon) often carry no readable label, so the declaration is the
only signal for them. The deterministic half is a floor that catches careless or
false declarations — not a complete classifier on its own. Unlabelled elements fall
back to `reversible` rather than prompting, because gating every unlabelled icon
would train the user to click Approve without reading, which is worse than no gate.

Approving an outward action "for this task" does **not** also grant shell or file
access for that task; the two grants are tracked separately.

The task-text patterns in `src/security.ts` still run, but only as an up-front
heads-up when a run starts. Enforcement happens at the click.

## Agent modes (Chat / Browse / Act)

Above the composer:

| Mode | What it can do | Token profile |
| --- | --- | --- |
| **Chat** | Text tools only (`web_search`, `reddit_search`, docs, shell read-only path) — no browser navigate/click | Cheapest |
| **Browse** | Navigate, scroll, extract — no click/type | Low (text-first observations) |
| **Act** | Full browser with effect-based approval gates | Same as before; still text-first by default |

Observations default to **text-first** (marks + page text). Vision screenshots are sent only for CAPTCHA/access walls, icon-only UIs, or after consecutive click failures.

## Auth modes (Google vs Guest)

OpenBuddy supports two identity modes for open-source / local use:

| Mode | How | Where bots & prefs live |
| --- | --- | --- |
| **Google Sign-In** | GIS button → verified ID token → HttpOnly session cookie | MongoDB when `MONGODB_URI` is set; otherwise local JSON under `.browser-agent-users/` |
| **Guest** | Default when not signed in (no interstitial — header **Sign in** is optional) | **This device only** — `localStorage` (and ephemeral browser profile). Nothing is written to Mongo |

### Google OAuth setup

1. In [Google Cloud Console](https://console.cloud.google.com/apis/credentials), create an **OAuth 2.0 Client ID** (application type: Web).
2. Under **Authorized JavaScript origins**, add:
   - `http://127.0.0.1:8765` (dev)
   - `http://localhost:8765` (if you open the dev app using `localhost`)
   - `http://127.0.0.1:8766` (built / `desktop:built` — stable default port)
   - `http://localhost:8766` (if you open the built app using `localhost`)
   - plus any deployed origin you use
3. Under **Authorized redirect URIs**, add the exact callback URL(s) for the ports you use:
   - `http://127.0.0.1:8765/api/auth/google/callback` (dev)
   - `http://localhost:8765/api/auth/google/callback` (dev via `localhost`)
   - `http://127.0.0.1:8766/api/auth/google/callback` (built desktop)
   - `http://localhost:8766/api/auth/google/callback` (built desktop via `localhost`)
   - plus `<your deployed origin>/api/auth/google/callback`
4. Copy the client ID into `.env` as `GOOGLE_CLIENT_ID` (same pattern as SuperBuilder’s `GOOGLE_CLIENT_ID` / `NEXT_PUBLIC_GOOGLE_CLIENT_ID`). GIS Sign-In does **not** require a client secret.
5. Restart the server (or `npm run desktop:built`). Unsigned visitors start as **Guest** automatically (no Sign in / Guest choice screen). Sign-in is available from:
   - Top bar: **Sign in** (becomes **Account** when signed in)
   - Sidebar: avatar / **Connect Apps** → Google button in the Account modal

Electron opens Google sign-in in the system browser because Google blocks authentication in embedded user agents. The system browser completes the redirect, then the app exchanges a short-lived, one-time handoff with its local server so the Electron session is signed in too. In Electron, click the Google button in the browser page it opens to finish.

Do not commit `.env` or real client secrets. `.env.example` documents the keys only.

### Model and budget configuration

The server and CLI load `.env` before deriving defaults; shell environment values take precedence. Set `BROWSER_AGENT_MODEL` for the selected default and provider versions through `OPENAI_MODEL`, `ANTHROPIC_MODEL`, `XAI_MODEL`, and `OLLAMA_MODEL`. `OPENAI_IMAGE_MODEL` enables image generation. With no configured model the default is the explicit Local Engine.

`BROWSER_AGENT_MODELS_JSON` adds models as `{ "id": "deployment-id", "label": "Optional name", "provider": "openai", "api": "responses" }`. Supported providers are `openai`, `anthropic`, `xai`, `ollama`, `claude-cli`, and `local`; API modes are `responses` or `chat`. Explicit registry metadata wins over legacy model-name inference. `OPENAI_API_MODE` controls unregistered OpenAI models. The settings/composer menus are populated from the server catalog, with saved custom selections preserved.

`.env.example` also documents step/output/context limits and reasoning effort. The custom loop removes complete old rounds above the text budget, preserves the task and recent observations, and starts a new Responses chain after compaction. Images have a separate retention limit. Oversized pinned context produces an explicit error. The SDK checks the shared tool step/time budget, but its internal history is not compacted by the custom-loop policy.

Optional `MODEL_PRICING_JSON` contains input/output prices per million tokens. Models without configured prices show no estimate. Provider keys stay server-side; Anthropic and xAI do not borrow the OpenAI key. Key inputs are cleared after saving session settings. Local `.env` remains ignored; never copy it into an artifact or commit.

### MongoDB (optional cloud persistence)

Signed-in Google users can sync bot roster + key settings to MongoDB Atlas:

```sh
# .env — use your own Atlas connection string; never commit it
MONGODB_URI=mongodb+srv://USER:PASSWORD@CLUSTER.mongodb.net/openbots?retryWrites=true&w=majority
MONGODB_DB=openbots
```

- Database default name: `openbots` (override with `MONGODB_DB`)
- Collection: `users` (indexed on `googleSub`, `email`)
- If `MONGODB_URI` is unset or unreachable, Google auth still works and data falls back to `.browser-agent-users/`
- Live synchronization uses a shared MongoDB change stream and authenticated `/api/user/events` notifications. Atlas, a replica set, or a sharded cluster is required for change streams; standalone MongoDB and local-file mode retain a 15-second polling fallback.
- Saves are debounced and serialized; failed saves stay queued for retry. Notifications reload a current snapshot and never replace a running turn's transcript.
- Guest explorers are never blocked by missing Mongo

## Sign-in / browser sessions

### In-app browser (desktop default)

On the Electron desktop app (`yarn desktop` / `yarn desktop:built`), browsing
defaults to **Chrome-backed browsing**: normal installed Google Chrome with a
dedicated saved profile, displayed live inside the app. Chrome starts and connects
automatically; no manual launch command is needed. Native Electron tabs remain an
advanced option with app-owned cookies (`persist:open-bots`). Playwright attaches over Electron’s remote
debugging port (default `9333`, override with `OPEN_BOTS_ELECTRON_CDP_PORT`).

This does **not** open or focus your personal Chrome. Sign in to sites inside the
Live Browser panel. The OpenBuddy UI window itself is never the automation target.

Plain `npm run built` / `yarn built` in a normal browser (no Electron) falls back
to OpenBuddy Chrome / guest as before.

**Honest limit:** Google OAuth and some bot walls still fail inside embedded
Chromium. That is expected — use Connected Chrome below, or `reddit_search` /
`google_property` for research without scraping.

### External OpenBuddy Chrome (legacy / non-desktop)

**Connect Apps → Open Chrome to sign in** launches a dedicated Chrome window with
profile `~/.buddy-bot-chrome-profile` (not your personal Chrome). Useful when you
are not on the desktop shell, or want an external window. Playwright-launched
Chrome still carries automation signals; Reddit/Google often block it.

### Connected Chrome (CDP) — escape hatch for Reddit / Google

Optional external window when the in-app browser is blocked:

1. Open **Connect Apps → Connect my Chrome**.
2. Copy and run the launch command (starts Chrome with remote debugging on a
   dedicated profile `~/.buddy-bot-chrome-cdp`, not your daily Chrome profile).
3. Click **Connect my Chrome** again so OpenBuddy attaches via CDP (port `9222`).
4. Sign in to Reddit/Google in that Chrome window, then run the task.

Optional: set `BROWSER_AGENT_CDP_ENDPOINT` (default `http://127.0.0.1:9222`).

Access-denied pages suggest Connected Chrome when the in-app browser is blocked;
they are not presented as CAPTCHAs. For Reddit research without browsing, prefer
`reddit_search`. For GA/GTM/GSC guidance, prefer `google_property`.

## Desktop app (Electron)

```sh
yarn install
yarn desktop           # production copy (build/), port 8766
yarn desktop:dev       # dist/ + tsc --watch, port 8765
yarn desktop:built     # production copy (build/), learn mode on, port 8766
```

**Dev desktop** (`yarn desktop:dev`): compiles to `dist/`, watches TypeScript,
starts Electron with `node --watch` on the server, UI at [http://127.0.0.1:8765](http://127.0.0.1:8765).
Add that origin under Google Cloud → Credentials → Authorized JavaScript origins for sign-in.
Code changes apply without a production `build/`.

**Production desktop** (`yarn desktop` / `yarn desktop:built`): compiles into `build/`, starts the agent from it on
**8766**, Electron window with the **in-app browser** (CDP on `9333`). `/learn` works here.

| Command | Server it runs | Learn mode |
| --- | --- | --- |
| `yarn desktop:dev` | `tsc --watch` → `dist/`, Electron on **8765** | off (override with `BROWSER_AGENT_LEARN_MODE=1`) |
| `yarn desktop` / `desktop:built` | compiles `build/`, Electron starts it on **8766** | on |
| `yarn desktop:attach` | attaches to a server already listening (default `8766`; use `BROWSER_AGENT_UI_PORT=8765` for `yarn dev`) | whatever that server has |

`yarn desktop:attach` is for when `yarn built` or `yarn dev` is already running in another terminal —
it opens the window against that server instead of starting a second one. Two servers would otherwise
both want the same Chromium profile directory, and only one process can hold it.

npm works for all of these too (`npm run desktop`, `npm run desktop:built`).

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


## Interactive browser architecture

Independent **Chat** agents can work in parallel while one **Browse**, **Act**, or **Turbo** task owns the shared browser. The default is four total execution slots and one task per bot; configure `BROWSER_AGENT_MAX_CONCURRENT_RUNS` and `BROWSER_AGENT_MAX_PENDING_RUNS` in the environment. Browser tasks queue with a visible reason. Switching chats preserves each run's event stream and sends its results to its original chat. Stop and Steer affect the selected bot's work. Use Chat for drafting or analysis that should continue alongside another bot's browser task.

The browser and Electron share the same workspace and agent server. Run
`npm run desktop` from either the repository root or this directory for the
production desktop; use `npm run desktop:dev` for the watched desktop. For a
regular browser, run `npm run built` here (`npm run bots:built` from the root).

- **Native desktop workspace:** `electron/browserWorkspace.js` owns one sandboxed
  `WebContentsView` per tab. Native tabs and in-page state survive UI refreshes and
  agent-server restarts. Toolbar commands use preload IPC; native browsing does
  not go through screenshot/input HTTP requests.
- **Shared automation target:** the desktop's private browser broker supplies
  active tab identity to `src/desktopBrowser.ts`; Playwright attaches to that tab.
  The desktop emits URL/title/tab changes directly to the UI.
- **Web interaction scheduler:** `static/browserRuntime.js` sends one browser
  input request at a time. Adjacent wheel deltas and typed text are combined;
  clicks, keys, and navigation preserve their order. A failed action reports
  its error and lets subsequent actions proceed.
- **Live frame delivery:** `src/frameStream.ts` fans frames out to independent
  subscribers. Each viewer stores at most one pending frame, replacing stale
  frames. The SSE handler waits for HTTP drain when a viewer is slow and
  releases the subscription on disconnect or session shutdown.
- **Display scheduling:** the UI presents the latest frame once per animation
  frame and disconnects the frame feed while the tab is hidden. Returning to
  the tab fetches current browser status and reconnects to the current frame.
- **Run events:** chat steps and approvals keep their existing ordered,
  replayable event stream; they do not use disposable frame delivery.

This separates rendering and input pacing from workspace UI code without adding
another frontend framework or changing the agent/tool API. Web browsing still
uses a JPEG preview over SSE; it is not a native browser view. The focused
runtime/frame tests run as part of `npm test`.


See [Desktop workspace architecture](docs/desktop-architecture.md) for component
ownership, reload behavior, the VS Code fork decision, and implementation limits.


### Clipboard images and compact knowledge

Paste screenshots into the chat input with Ctrl+V (Cmd+V on macOS), or use **+** to attach images or text files. Images have removable previews and are sent as image inputs on that chat turn. The API engines support these inputs; Local Engine and Claude CLI report that image inspection is unavailable. Up to four images (3 MB each) or eight total attachments are supported. Text/code files can be up to 200 KB. Pasted text longer than 1,200 characters becomes a source attachment; shorter text stays in the input.

Text sources are stored locally and searched with ranked lexical retrieval. The bot receives a compact task summary and relevant excerpts, rather than the full source/history. It can use `knowledge_base` to search, read longer source text, list saved entries, and save a short reusable runbook with preconditions, steps, verification, and pitfalls. Successful browser workflows also produce a compact fallback procedure from their action trace when the model does not save a runbook. Runbooks are guidance to verify, not approval grants. Image contents become reusable knowledge only when the agent interprets them and saves a textual lesson; there is no background OCR or embedding API bill.

Per-reply Like feedback and explicit corrections are saved into that bot's local learning store. Corrections become guidance for future replies. A task-scoped approval is remembered only as a temporary workflow preference; it never grants permission in future tasks. Irreversible browser actions only offer a one-time approval.

Knowledge is scoped by bot and stored in `.browser-agent-knowledge/`; attachment metadata is in `.browser-agent-attachments/`, and image files are local artifacts. These runtime directories are excluded from Git. Renaming a bot currently changes its name-based knowledge scope.

### Select a project folder

Use **+ → Select project folder** in the composer to attach a project for analysis. The folder picker works in Electron and Chromium browsers. Each folder counts as one attachment and retains relative paths; the chip shows how many source files were imported. Common dependencies, build output, binary files and credential files are excluded, and the import reports the excluded count.

The imported folder is a **read-only snapshot**. Bots browse its file listing, search code and retrieve file pages through `knowledge_base` using its `project:ID`, keeping the full project out of the initial model prompt. The snapshot remains available to the bot after sending the message and across server restarts. Select the folder again to include later changes. Importing a folder does not move the terminal workspace or grant permission to edit its original files.

Defaults are 2,000 source files, 256,000 bytes per source file, and 8,000,000 bytes per project. Configure `BROWSER_AGENT_PROJECT_MAX_FILES`, `BROWSER_AGENT_PROJECT_MAX_FILE_BYTES` and `BROWSER_AGENT_PROJECT_MAX_BYTES` in the environment. Oversized projects require a smaller subfolder; the importer does not silently truncate them. **+ → Attach files** remains available for individual files and images.

### Compact profiles and asynchronous requests

Runtime behavior now loads `AGENTS.md`, `soul.md`, relevant role playbooks, and separately reviewed lessons. Queued bot requests are accepted by the backend and continue when the UI closes; the shared browser still has one execution owner. See [profile configuration, proposal review, Mongo synchronization, async queue and focus behavior](docs/agent-profiles.md).

### Event-driven orchestration

The app supports shared MongoDB event delivery, resumable workflows with dependencies, restart recovery, bounded event-selected playbooks, and a correction observer with human-reviewed voice/playbook drafts. See [event-driven orchestration](docs/event-driven-orchestration.md) for configuration, API usage, and delivery guarantees.

### Reopening your session

The same browser profile and app address restore your selected bot, saved conversation, and separate unfinished text drafts for each bot. Drafts save while typing and when leaving the page. Clearing a draft keeps it cleared. Existing mode/model preferences remain persistent. The native browser-pane visibility preference also survives reopening.

This device-local state uses browser storage; a different browser profile or origin (including switching between a file preview and localhost) has separate storage. Reopening does not submit work again. The UI reconnects to active runs when the server is still running; closing the whole desktop app does not checkpoint and resume a stopped model or browser process. Unsent file attachments are not included in text draft restoration.

### Reusable coding workspace

Use **+ → Index local coding workspace** to build or refresh a private offline source index, then ask a bot to inspect, implement and test a change. Both agent engines can retrieve ranked code excerpts, inspect file/symbol maps and live source, and make stale-checked exact patches through the existing approval controls. Dependencies and generated/private files are excluded. Selected project-folder snapshots also retain an index for reuse across turns and restarts. See [coding capability](docs/coding-capability.md) for scope, configuration, and examples.
