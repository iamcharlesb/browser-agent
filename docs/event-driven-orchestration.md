# Event-driven agent orchestration

Open Bots uses application code for routing and task state. Models handle the requested work; incoming notifications do not wake a model or perform a browser action by themselves.

## Runtime layers

- **Context compiler:** `loadAgentProfile` combines shared instructions, the bot voice (`soul.md`), a bot-owned playbook, reviewed lessons, and at most two relevant playbooks. Task terms and an optional known `eventName` select playbooks. Character budgets are configured through `BROWSER_AGENT_CORE_PROFILE_CHARS`, `BROWSER_AGENT_PLAYBOOK_CHARS`, and `BROWSER_AGENT_MAX_PLAYBOOKS`. A task that does not need judgment can use deterministic paths such as arithmetic and local tool calls.
- **Event relay:** `DurableEventStream` mirrors an allowlist of small semantic application events into MongoDB `agent_events`. One Change Stream per server process fans safe event types into that process's local bus and an SSE endpoint at `/api/agent/events`. Run-step telemetry and page contents are not mirrored. Payloads are redacted, capped at 64 KB, and expire after `BROWSER_AGENT_EVENT_RETENTION_DAYS`.
- **Workflow control plane:** workflows are DAGs with validated task IDs and dependencies. Save a draft with `POST /api/workflows`, inspect it, and explicitly start it with `POST /api/workflows/:id/start`. Ready tasks enter the single-browser queue; dependencies become ready only after successful completion. Workflow state uses MongoDB when a shared workspace is configured and local atomic files otherwise.
- **Iterative bot discussions:** the coordinator can consult specialists, compare replies, and return to a bot with a focused follow-up while material questions remain. It should give a clear conclusion as soon as the evidence is sufficient. The discussion is capped at 24 specialist replies; at that limit the coordinator is instructed to stop delegating and report its best supported outcome, remaining uncertainty, and next steps.
- **Queue and recovery:** queued jobs are persisted locally. Queued tasks resume after restart. A task interrupted while running is marked failed for review; it is never retried automatically. Retrying a failed workflow step requires an explicit confirmation and fresh policy approvals.
- **Conversation observer:** completed turns are checked locally for explicit correction or persistent preference language. Matching instructions become pending voice or playbook suggestions. The Observer header panel lets the operator approve or dismiss each suggestion. Voice changes write to `agents/<bot-id>/soul.md` only after approval; playbook changes go through the reviewed revision store. The observer never makes a model call.

## Enable shared events and workflow state

Set `MONGODB_URI`, `MONGODB_DB`, and the same non-`local` `BROWSER_AGENT_WORKSPACE_ID` on each trusted installation. MongoDB Change Streams require a deployment that supports them (typically a replica set or sharded cluster). Leave the workspace ID unset or `local` for local-only operation.

The workspace ID is a routing namespace. It is not authentication, user isolation, or permission to perform external actions. This browser agent remains a single-operator tool. Do not connect untrusted tenants to the same workspace or expose the local server to the public internet.

## API sketch

Create a draft. Every task needs an ID, bot name, task, and optional `dependsOn` array. A task with an outward or financial effect must list the corresponding value in `approvedCategories` before it can be created.

```json
{
  "tasks": [
    { "id": "research", "botName": "Competitor Intelligence", "task": "Compare these competitors", "dependsOn": [] },
    { "id": "ux-review", "botName": "UX Specialist", "task": "Review the comparison and propose UX changes", "dependsOn": ["research"] }
  ]
}
```

Use `GET /api/workflows` to inspect status, then `POST /api/workflows/<id>/start` to start. `GET /api/agent/events` is an SSE stream with replay cursors; `POST /api/agent/events` accepts a small `{ "payload": { ... } }` workspace event. These endpoints require the app's same-origin request for writes.

An event may select a task-relevant playbook when the caller explicitly submits a run containing a known `eventName`. An event by itself is not a run request. Remote handoff notifications are retained as facts but are excluded from the remote auto-dispatch allowlist so they cannot start duplicate agents on every installation.

## Delivery and side-effect guarantees

The Mongo relay is at-least-once. Each server saves a Change Stream resume token only after local deterministic subscribers settle; if the oplog token expires, it reconciles from the durable event collection. Repeated delivery is possible, and handlers must be idempotent. The collection's retention period bounds replay history.

MongoDB does not provide exactly-once execution of outward actions or account isolation. Workflows serialize browser ownership within one server, but the shared browser session is not portable between installations. A task that may have performed an external action before a crash stays failed until a human reviews and explicitly retries it.
