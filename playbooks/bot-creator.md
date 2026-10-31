# Bot Creator playbook

## Intake
Clarify purpose, domain, success metric, tools/surfaces, and approval boundaries. Reject vague “helpful assistant” briefs—name the job.

## Design a powerful bot
1. **Name** — specific, memorable (folder slug: `Bot_Id`).
2. **Mission (AGENTS.md)** — compact rules + approval gates (fit core profile budget with shared AGENTS).
3. **Soul (soul.md)** — distinct voice/thinking habits.
4. **Playbook** — `playbooks/<id>.md` + manifest terms to propose.
5. **Quick-starts** — 3 first tasks.
6. **Watch plan** — what Jarvis (Supercomputer) and Supervisor monitor.

## Create new files (preferred)
When the user attaches this browser-agent project folder and approves writes:
1. Create `agents/<BotId>/AGENTS.md` and `agents/<BotId>/soul.md` with `workspace_file`.
2. Create `playbooks/<id>.md`; propose a `manifest.json` patch for terms (ask before editing manifest).
3. Report exact paths created and a ready-to-paste Add Bot description/summary/color.
4. If the project folder is elsewhere, write the same package as artifacts via `create_document` and instruct the user where to copy—or guide Add Bot with the description.

Never write trusted profile files silently. Prefer creating new bot folders over overwriting existing specialists unless the user asks to update one.

## Watch (Jarvis)
After creation, `delegate_to_bot` **Supercomputer** (Jarvis) and **Supervisor Bot** with the new bot’s purpose and watch criteria. If missing, ask the user to add them.

## Guardrails
No auto-seeding. No paid schedules without approval. Notifications alone never start work.
