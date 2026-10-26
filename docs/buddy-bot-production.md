# OpenBuddy — production readiness and operating boundaries

OpenBuddy is the product. The existing `browser-agent` runtime is the implementation.
The separate Fireworks++ framework is frozen for this product; no dependency or
migration to Fireworks++ is required.

## Scope

- Keep compact per-bot operating instructions, relevant playbooks, and reviewed lessons.
- Keep the existing local message bus, durable event relay, and MongoDB change streams.
- Use deterministic application code to route events; events and playbook revisions
  never authorize model calls, browser actions, shell execution, or paid tasks.
- Use existing dependencies instead of introducing a new agent framework or message broker.
- Local, single-operator desktop usage is the current supported trust boundary.
  Do not market this as multi-tenant hosted software until isolation is independently verified.
- Check license terms before distribution. MongoDB Server is SSPL; provider model
  weights and APIs may have separate proprietary terms. No claim is made that
  every component meets OSI open-source criteria.

## Release blockers

- [ ] Validate clean desktop install, startup, sign-in, and Google OAuth callbacks
  for both development and packaged app ports.
- [ ] Resolve any MongoDB connectivity timeout and test explicit error/recovery UI.
- [ ] Validate external-effect authorization and approval flow with adversarial tests.
- [ ] Crash/restart tests for queued, running, completed, and awaiting-approval jobs.
  Reconcile unknown external effects before retrying them.
- [ ] Test concurrent device edits, revision conflicts, offline outbox, and reconnect.
- [ ] Test relay deduplication, replay, resume-token loss and Mongo failover against
  a real replica set. Change streams do not guarantee exactly-once external effects.
- [ ] Validate secrets and credentials are not accessible through browser or shell tools.
- [ ] Confirm automated build/tests/secret scan on every pull request and main commit.
- [ ] Set up error reporting, recovery runbooks, backup/restore drills, and release rollback.
- [ ] Package and sign supported desktop distributions; test upgrades from previous builds.
- [ ] Run measured comparisons of token usage, model invocations, task success,
  latency, and cost against a fixed evaluation dataset before claiming savings.

## Deployment boundary

Cross-machine notifications and task execution are separate features.
`DurableEventStream` is an at-least-once notification relay; the local
`MessageBus` dispatches subscribers in process. `WorkflowOrchestrator`
handles dependency state. None of them grants remote execution permission.
Do not promote a notification into an execution request without authentication,
authorization, durable state, idempotency keys and reconciliation.

A playbook update takes effect on a subsequent task, not by interrupting an
active agent. Proposed lessons remain pending until explicit owner approval.

## Minimal release verification

From a clean checkout on a supported Node.js installation:

```sh
npm ci
npm test
npm run build:production
```

CI runs the same checks without production secrets. Human verification is still
necessary for OAuth, browser automation, MongoDB connectivity, and desktop signing.
