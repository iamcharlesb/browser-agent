# Compact profiles, reviewed playbooks, and async work

The runtime separates stable operating instructions, voice, domain procedures, task state, and notifications. The pasted design is implemented as application behavior; its external product timing and novelty claims are not treated as requirements or established facts.

## What loads for a task

1. Shared `AGENTS.md`: compact operating rules, evidence requirements, task continuity, and learning boundaries.
2. Shared `soul.md`, or `agents/BOT_ID/soul.md`: tone and behavior, never authority.
3. Optional `agents/BOT_ID/AGENTS.md`: additional compact role instructions.
4. Optional owner-authored `agents/BOT_ID/playbook.md` and separately reviewed lessons.
5. Relevant domain playbooks selected deterministically from `playbooks/manifest.json`; no model call selects them. At most two are loaded by default, within the configured character budget. Whole paragraphs are retained, and full role guidance remains available through paginated `knowledge_base(read, id="playbook:seo", offset=0)` calls.
6. Current runtime authorization, task continuity, relevant source retrieval, and user-authored corrections. Runtime tool checks remain authoritative.

Core plus voice must fit `BROWSER_AGENT_CORE_PROFILE_CHARS`; oversized trusted core files fail explicitly rather than losing safety instructions through truncation. Model-proposed notes are excluded from automatic learning-context injection. The learning tool can still list them as reference data. The core instruction set is roughly 400–500 tokens as an engineering estimate; actual tokenizer usage depends on the model. Tool schemas, runtime authorization, task state, attachments, selected playbooks and responses add more tokens.

The measured generic Primary Bot prompt changed from 18,210 to 3,795 characters. This compares system-prompt text only, not a production cost or quality benchmark. Profile load events report the selected files' revision, selected playbook IDs, profile characters and complete system-prompt characters. Existing usage events retain actual provider token accounting. `/api/status` exposes aggregate profile loads, prompt characters, usage-reported model calls and administrative notification counts.

## Learning proposals and review

`learning_kb(save)` persists a bounded reference note and creates a pending playbook proposal with its evidence reference. It publishes `agent.learning.proposed` with the bot ID and proposal reference. It does not edit Markdown files, publish a lesson to every bot, or promote itself into operational instructions.

The local owner can inspect and review proposals:

```sh
npm run profiles:review -- --list --bot Primary_Bot
npm run profiles:review -- --show --bot Primary_Bot --proposal PROPOSAL_UUID
npm run profiles:review -- --bot Primary_Bot --proposal PROPOSAL_UUID --decision approve --reviewer OWNER --revision 0
```

Use the current revision shown by `--show`. Approval means the owner has inspected the proposed procedure and its evidence; the runtime does not treat a model's success claim as automatic verification. Rejection keeps the lesson inactive. This CLI is deliberately not exposed as an agent tool. The existing host shell is not a security sandbox; a privileged operator can still edit files directly.

Reviews use expected revisions and a cross-process local review lock. Mongo-backed reviews also use compare-and-set updates and a unique workspace/bot index. A shared review cannot silently fork when Mongo is unavailable. Repeating an already committed approval is idempotent. A full lesson budget rejects the new promotion rather than silently deleting existing lessons. Abandoned review locks require owner recovery after checking that the recorded process is no longer running; they are not automatically removed while an old writer could still be alive.

## Storage and cross-system updates

Local pending proposals, approved state and notification receipts live in ignored, private `.browser-agent-playbooks/` files. `BROWSER_AGENT_WORKSPACE_ID` enables sharing through the existing server-side `MONGODB_URI`, in the `agent_playbooks` collection. Set the same explicit workspace identity on trusted installations that should share procedures; unset means local-only playbooks. Do not use the shared workspace setting as a substitute for multiuser authentication or tenant isolation. Root Markdown files and role manifest files are deployed configuration; Mongo synchronizes reviewed lesson state, not source-code files.

One collection change stream per backend instance multiplexes approved revisions. Events carry only `id`, `topic`, `botId`, `revision`, and `ref`. Consumers acknowledge a revision after deterministic subscribers finish. Per-bot notification chains serialize delivery and stored receipts suppress repeated snapshots. Local filesystem notifications are best effort; every new run also reloads its approved profile. If shared storage is unreachable, an already cached reviewed profile can be read, but new shared approval is blocked.

Driver-managed resumption plus snapshot reconciliation recovers current approved state after reconnect or lost oplog history. This is a state-notification service, not a general durable task queue. It does not promise replay of every intermediate revision or exactly-once outward effects. Retry timers reconnect infrastructure; they do not wake models. No hardcoded Grok, ChatGPT, or other platform heartbeat is assumed. A profile update takes effect on the next task and never restarts active work.

## Compact communication and asynchronous execution

Full agent outcomes are private records in `.browser-agent-outcomes/`. The completion event carries a task ID, status and reference instead of the entire result. Coordinator context uses short outcome previews and retrieves full details only when needed, with paginated `knowledge_base(read, id="outcome_UUID", offset=0)` calls. Consult another specialist only for a specific unresolved dependency; do not poll every bot just because it exists. Notifications and routing consume no LLM tokens. A requested synthesis or unresolved decision still invokes a model.

Requests from all bots can enter the backend queue asynchronously through `/api/run/queue`. The browser UI submits them immediately and follows job IDs. Closing the tab does not discard accepted requests. The shared browser and approval state retain one execution owner; async acceptance does not mean multiple bots can click the same page concurrently. Recent run IDs allow SSE replay for an accepted job without attaching to a different bot's run. Stop clears pending requests; remove cancels a queued request; steer replaces its queued instruction and stops the current action before continuing.

The queue is process-owned and bounded. Pending requests do not survive a server restart, and this change does not make agent execution distributed across machines. Do not replay uncertain outward actions automatically. Those require durable authorization, leases, execution receipts and reconciliation beyond the profile-notification service. Rehearsal `/learn` jobs retain their separate lifecycle.

The message input remains usable during background runs. Toolbar clicks and asynchronous completion return focus to it without interrupting an intentionally selected input, dialog, browser surface, or text selection. Switching to or creating another bot no longer requires stopping the active bot.

## Environment configuration

- `BROWSER_AGENT_PROFILE_DIR`: optional trusted profile directory containing the same file layout.
- `BROWSER_AGENT_CORE_PROFILE_CHARS=2400`
- `BROWSER_AGENT_PLAYBOOK_CHARS=3200`
- `BROWSER_AGENT_MAX_PLAYBOOKS=2`
- `BROWSER_AGENT_REVIEWED_PLAYBOOK_CHARS=1200`
- `BROWSER_AGENT_WORKSPACE_ID`: unset for local, explicit common ID for shared reviewed state.
- `BROWSER_AGENT_PLAYBOOK_RETRY_MS=15000`: infrastructure recovery only.

Model versions and runtime step/time budgets continue to come from environment configuration. Ordinary composer requests no longer override those budgets with hardcoded UI values.

## Research relationship

[Anthropic's context engineering guidance](https://www.anthropic.com/research/effective-context-engineering-for-ai-agents) motivates bounded relevant context and progressive disclosure. [Agentic Context Engineering](https://arxiv.org/abs/2510.04618) treats context as an evolving playbook; this implementation uses explicit owner review rather than claiming to reproduce the paper's training/evaluation mechanism or results. [MongoDB's change-stream documentation](https://www.mongodb.com/docs/drivers/node/v6.x/monitoring-and-logging/change-streams/) supplies the database notification mechanism; application code still owns acknowledgments, version checks and recovery.

There is no novelty or patentability claim, and no paid production-model comparison was run. Regression coverage includes profile isolation and bounds, symlink rejection, reviewed revision conflicts, model-note exclusion, compact outcomes, mocked Mongo synchronization/workspace separation, async queue controls, focus behavior and existing browser/tool authorization tests. A live Mongo replica-set integration remains a deployment check.

Final validation: 247 browser-agent tests and 41 framework tests passed. Both test commands ran their source-secret checks. Browser inline scripts parse and both repository diffs pass whitespace checks.
