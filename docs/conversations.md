# Conversations, coordination and reset

## Keep the bot grounded

A follow-up should preserve the existing goal, corrections, exact target and
artifacts. Roles and attachment clarifications are handled directly; they should
not trigger a specialist consultation. Bot-reported work is historical context
until verified against a current job, artifact or source.

When asking for analytics, name the property and period. A summary should distinguish
measured figures, older reported figures and unavailable evidence. General web search
cannot answer how your private analytics are performing. Local Engine declines
unsupported conversational requests rather than searching the user's wording.

The pasted marketing conversation exposed unwanted handoffs for role clarification,
unclear differences between proposed work and actual scheduled work, and unrelated
Local Engine search results. Regression checks cover these routing and fallback
failures. Scripted tests establish runtime behavior, not the quality of a live model.

## Reset one bot or every bot

1. Open the Settings icon in the chat header.
2. Under Reset conversations, choose a bot name or All bots.
3. Select Reset conversations, review the scope, then Confirm reset.

The server stops affected active runs, cancels their queued requests and bounded
discussions, and waits for conversation writes before clearing saved context.
Another bot's work is retained when only one bot is selected. A busy learning
session must finish or be stopped first. If a stopped run has not closed yet,
reset reports a retry message rather than claiming completion.

| Cleared | Retained |
| --- | --- |
| Selected transcript and composer draft | Bot roster, names, role instructions and voices |
| Saved task turns, objectives, corrections and artifact references | Approved operational playbooks |
| Selected bot's conversational knowledge and local learned notes | Provider configuration and account sign-ins |
| Selected runs and queued requests | Artifact files, uploaded bytes and saved outcome audit records |
| All bots also clears shared workspace conversation notes | Existing schedules and workflow definitions |

Resetting one bot retains shared workspace instructions that apply to all bots.
Deleting an attachment reference prevents the reset bot from retrieving that
project through the former conversation's authorization; the physical upload is
retained. Reset is a conversation cleanup, not a full account or filesystem erasure.
Existing schedules can create new work later; cancel them separately if needed.

## Other windows and signed-in sync

Reset markers survive restart. Other windows refresh markers on focus, and windows
on the same origin receive a storage notification. Old conversation payloads are
rejected so a stale window cannot repopulate cleared server context. The transcript
reset marker also wins over an older roster snapshot during normal sync. Signed-in
transcript changes follow the app's normal save/retry status; disconnected devices
must reconnect and sync to see the reset.

Reset requires an explicit same-origin request and confirmation. Merely opening
Settings, reading the documentation or fetching reset state never invokes a model
or resets anything.

## Troubleshooting

If Local Engine appears, select a configured conversational model to handle goals,
specialists and analysis. If analytics show a sign-in screen, reconnect the intended
browser session; do not treat an old screenshot as current access. If a handoff fails,
report the actual failure and available evidence. A proposed plan, owner assignment
or weekly review document does not prove any job has been scheduled.
