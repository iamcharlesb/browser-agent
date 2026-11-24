# Per-bot configuration

The shared `../AGENTS.md` supplies operating rules and `../soul.md` supplies default voice. Add optional files under a bot's existing `botIdFromName` ID:

```text
agents/Primary_Bot/AGENTS.md     # compact additional role instructions
agents/Primary_Bot/soul.md      # optional replacement voice
agents/Primary_Bot/playbook.md  # owner-authored procedure
```

`Primary Bot` maps to `Primary_Bot`. This is the same name-derived ID used by the current learning store, not the browser roster's UUID. Renaming a bot changes this lookup; stable account-scoped IDs are a separate migration.

Role `AGENTS.md` shares the core operating-instruction budget (`BROWSER_AGENT_CORE_PROFILE_CHARS`). `soul.md` has its own budget (`BROWSER_AGENT_SOUL_CHARS`) and must carry an explicit speaking personality—tone, cadence, and stance—not only methods. The owner procedure and reviewed lessons share the playbook budget with selected role playbooks. Files outside the configured profile directory, including symlink escapes, cannot be loaded. Files are read at the beginning of each run; editing a file does not interrupt or rewrite an active run.

Do not put secrets, model versions, permission grants, task history, or raw reasoning in these files. Environment configuration owns versions and limits. Runtime tool policy always remains authoritative. Use the reviewed proposal workflow for model-authored lessons.
