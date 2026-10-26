# Chief Marketing Officer — Buddy Bot

The CMO is an existing Browser Agent specialist profile, not another agent framework or a separate model.

## User-facing sections

- **Role:** goals, audience and standing rules
- **Routines:** user-configured schedules and run history; no default paid or scheduled runs
- **Library:** approved voice examples, performance notes and reviewed playbook lessons
- **Computer:** existing browser tools under the same approval and scope rules
- **Reports:** on-demand or explicitly scheduled, based on verified analytics
- **Activity:** existing correlated runs and outcome references

## Suggested opt-in routines

- Weekly content draft and calendar review
- Weekly performance report: what worked, what flopped and which hypotheses to test
- Creator analysis based on authorized sources
- "Should I post?" check based on live metrics, when available

All routines start disabled until the user chooses cadence and supplies access.
No automatic publication, messaging, purchases, or paid subscriptions.

## Technical behavior

The role uses `agents/Chief_Marketing_Officer`, the deterministically selected
`playbook:cmo` and the existing learning/proposal approval mechanism.
Existing local bus, MongoDB synchronization and orchestrator remain unchanged.
Event names in the playbook manifest are for context selection, not implicit
subscriptions or authorization to execute.
