# Pilo — architecture audit and release gates

Reviewed 2026-10-26 against the current Browser Agent runtime. This is a code review plus GitHub Actions observations, not a live provider benchmark, penetration test, or production certification.

## Architecture decisions

- **Pilo** is the product name; technical package `browser-agent`, legacy local-storage keys, internal APIs and persisted IDs stay unchanged until a tested migration. Renaming persistent keys in place could hide existing bots and conversations.
- Keep the existing TypeScript/Electron/Playwright runtime, local pub/sub and MongoDB Change Streams; no new agent framework, Redux or message broker.
- Use the lightweight observable view store for selected bot only. The server remains authoritative for execution, approvals, durable job state and learning.
- Every agent loads compact core instructions and task-specific playbooks. No automatic model invocation on notifications; coordinate deterministically where possible.

## Verified from source

- `src/asyncAgentQueue.ts` supports limited concurrent text jobs but serializes access to a shared browser. It does not provide cross-server work leases.
- `src/messageBus.ts` provides local pub/sub and request/reply; `src/durableEventStream.ts` persists selected event notifications with MongoDB and reconnect logic.
- `src/discussionController.ts` bounds consultations, but consultation state is process-owned and some routing is name-based.
- `src/taskMemory.ts`, `src/learningStore.ts` and `src/playbookStore.ts` implement scoped memories and reviewed lessons. They do not guarantee every exchange becomes durable learning.
- `src/chatAttachments.ts` persists explicitly attached project snapshots. `src/server.ts` now reintroduces up to four compact previously selected project references for the same bot in subsequent model calls. Project data is retrieved on demand. This is not a cross-device project source synchronization feature.
- UI branding was changed to Pilo in primary desktop and HTML files while preserving legacy compatibility keys.

## CI observations and fixes

The previous CI run installed successfully using `--legacy-peer-deps`, but the test suite failed. The log identified a CMO profile over its configured core budget, several platform-dependent UI/browser tests, and canceled timeout tests. The CMO identity was shortened and the request/reply timeout now remains live while awaiting a result. These fixes require a fresh full-suite CI result before merging.

The underlying OpenAI SDK 4 / Zod 4 peer conflict remains technical debt; `--legacy-peer-deps` is a temporary compatibility mechanism, not a resolution.

## Production blockers

| Priority | Requirement | Acceptance criteria |
| --- | --- | --- |
| P0 | Passing CI | Clean dependency installation, secret scans, compile, all deterministic tests and desktop smoke suite |
| P0 | Correct bot routing | Stable IDs through delegation, scheduling, renames, concurrent discussions; never deliver another bot's private context |
| P0 | Durable discussions | Persist and recover coordinator goals, consultation outcomes and associated task IDs after restart |
| P0 | Project continuity | Reused snapshots survive subsequent turns; permissions are scoped and missing local files are identified |
| P0 | Browser/shell safety | Sandboxed permissions, independent effect checks, approval tests and no automatic external effect replay |
| P0 | Packaged authentication | Google OAuth callbacks and Mongo connection recovery verified on actual desktop build |
| P1 | Long-lived learning | Corrections and verified outcomes become reviewable lessons; rejected or obsolete lessons cannot silently reactivate |
| P1 | Local performance | Compare billed tokens per successful task, model calls, task quality, latency and costs against a fixed baseline |
| P1 | Offline and cross-device | Conflict-safe writes, revisions, offline outbox, restore and reconciliation |
| P1 for hosted | Distributed workers | Leases/fencing, idempotency, tenant isolation and account-scoped storage/tool sessions |
| P2 | Feature parity | Evaluate report generation, structured charts, background routines and external integrations end-to-end |
| P2 | Distribution | Signed installers, OS matrix, backup/restore, upgrade/rollback and crash reporting |

## Naming compatibility

Do not rename `agentFireworksAgentsV2`, `openBotsSelectedBot` or other persisted keys without migration tests. The old repository and package IDs are implementation names, not the public product name.

## Token-efficiency criteria

A smaller system prompt alone does not prove lower total cost. Include provider usage, tool schema costs, retries, retrieval overhead, output tokens, fallback models and task completion quality. Measure per successful task rather than per wake-up.

## Release decision

**Not production-ready yet.** Suitable for continued local development and controlled testing. Merge only after CI validation; hosted multi-user operation remains outside the supported boundary.
