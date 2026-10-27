# OpenBuddy documentation

OpenBuddy is a local assistant workspace with named specialist bots, browser tools,
coding tools, saved conversation context, reviewed playbooks and a terminal CLI.
The desktop app and CLI use the same Node.js server. This guide describes what
actually runs, how to control it, and what has been validated.

## Start a session

Start the desktop app using the repository's desktop commands, or install the
[CLI preview](cli.md) and run `openbuddy serve`. Open the local address the server
prints. Choose or create a bot, configure a provider model in Settings, then send
a concrete request. Give it the target, the evidence and the desired deliverable.

Provider model versions, credentials, prices and operating limits are configured
through the server environment. Settings can select configured models and set
session credentials. Local Engine is a deterministic toolbox, not a conversational
language model. Ollama requires a configured local language model. The server
does not silently replace a failed API model with web search.

## Understand the execution modes

| Mode | Behavior |
| --- | --- |
| Chat | Text and workspace tools; no browser navigation or clicks |
| Browse | Read and navigate browser pages; no interactive browser actions |
| Act | Browser tools with independent effect and approval checks |
| Turbo | Explicit broader approval mode; payments, destructive actions and human verification still have gates |

Live Google Analytics or Search Console inspection needs an accessible, signed-in
browser session and a browser-capable mode, or an attached report/export. A public
welcome page or a Google sign-in screen does not establish account performance.
Compare the same property and date ranges; reported older figures are historical.

## A plan is different from a running task

Assigning owners in a response does not start those bots. A saved dashboard template
does not collect new analytics. A weekly retro plan does not create a recurring job.
Review the actual job queue, workflows and schedules before expecting background work.
Ask for a specific deliverable and verify its artifact link or completed result.

Multi-bot consultations are bounded by application code. They may consult a
specialist and return to the coordinator for a final answer. Repeated answers,
worker failures or policy blocks terminate the discussion rather than creating an
unlimited bot conversation. [Orchestration details](bounded-orchestration.md).

Scheduled work is read-only. Recurring paid model work needs explicit approval.
Notifications and change-stream updates refresh state; they do not start a model,
browser action or paid recurring job.

## Roles, memory and a fresh start

Bot names identify saved server context. Profiles contain compact operating
instructions, a separate voice and relevant playbooks loaded on demand. A user
clarifying a role or pointing to the right attachment should receive a direct
answer; that clarification is not a request to contact another bot.

Use Settings → Reset conversations to reset one bot or all bots. The confirmation
explains the deletion and retained state. [Conversation and reset guide](conversations.md).
Model-proposed lessons stay pending until reviewed; approved playbooks are retained.

## Data, approvals and distribution

This runtime supports a local single operator. Google sign-in can sync bot rosters
and transcripts using MongoDB or local storage. Guest conversations are stored on
the current device. MongoDB change streams do not supply tenant isolation or
exactly-once execution of external actions.

CLI operator data lives in a separate directory, defaulting to `~/.openbuddy`.
The release tarball excludes credentials, local state and browser profiles.
Use [setup](../README.md) for browser sessions, provider configuration and storage,
[coding tools](coding-capability.md) for project access, and
[validation](cli-validation.md) for tested behavior and known limits.
