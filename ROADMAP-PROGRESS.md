# Instagram agent roadmap progress

One small task per day, run by Cursor (cursor-agent) from the daily routine.
Source plan: `ROADMAP-INSTAGRAM-AGENT-HANDOFF.md`. Changes stay uncommitted until Catherine reviews them.
Rules: no commits/pushes, no .env or secrets, no live Instagram, no private IG APIs, no unsupervised engagement, no rewrite of `static/index.html`.

## Priority order (reliability first)
2026-10-21: Reordered unchecked tasks for browser-reliability priority (Catherine's routine); original week sections kept for reference.

1. 21 — IG SPA reliability: waits/retries
2. 18 — confirm helpers in browserController.ts
3. 2
4. 3
5. 4
6. 5
7. 6
8. 7
9. 8
10. 9
11. 10
12. 11
13. 12
14. 13
15. 14
16. 15
17. 16
18. 17
19. 19
20. 20
21. 22
22. 23

## Week 1 — Foundation (exit: propose/approve via API with no Instagram)
- [x] 1. `src/campaignStore.ts`: types + schema for per-bot campaign (niche, engaged[], skip[], dailyBudget) and engagement queue items (proposed | approved | denied | done | failed); safe per-bot JSON path helper. No wiring yet.
  - 2026-10-18: Done (uncommitted, awaiting review). New 174-line file with Campaign/EngagementItem types, defaultCampaign (budget 6), validators with handle normalizing, and campaignFilePath that rejects unsafe bot ids; `npm run build` passes, no tests yet (task 5).
- [x] 2. `src/campaignStore.ts`: load/save per-bot JSON with atomic write and validation/defaults.
  - 2026-10-21: Done (uncommitted, awaiting review). loadCampaignState/saveCampaignState ({version:1,campaign,queue}), missing file gives defaults, corrupt file throws naming the path and is kept, temp-file+rename atomic write; build + /tmp smoke checks pass.
- [x] 3. `src/campaignStore.ts`: queue operations (add proposal, approve, deny, edit draft, mark done/failed) with legal status transitions only.
  - 2026-10-21: Done (uncommitted, awaiting review). Pure propose/approve/deny/editDraft/markDone/markFailed + canTransition; only proposed→approved|denied and approved→denied|done|failed allowed, editDraft only while proposed, illegal/unknown id throws; build + smoke checks pass.
- [ ] 4. `src/campaignStore.ts`: daily budget tracking with day-roll (counter resets on a new local day).
- [ ] 5. `src/campaignStore.test.ts`: tests for schema/validation and status transitions; add to `npm test`.
- [ ] 6. `src/campaignStore.test.ts`: tests for budget day-roll and path safety (bot id cannot escape the data dir).
- [ ] 7. `src/agentTools.ts`: `campaign_memory` tool (read campaign, add to engaged/skip, set niche/budget).
- [ ] 8. `src/agentTools.ts`: `engagement_queue` tool (propose, list) — the agent cannot approve its own proposals.
- [ ] 9. `src/server.ts`: REST endpoints for campaign read/update.
- [ ] 10. `src/server.ts`: REST endpoints for queue list/approve/deny/edit + a small API test.

## Week 2 — Research → Propose (exit: research never silently likes/follows/comments)
- [ ] 11. `src/promptLoop.ts`: orchestrator rule so research runs end in propose, not engage (+ test).
- [ ] 12. Skip handles already in engaged/skip when proposing (store-level filter + test).
- [ ] 13. `static/index.html`: read-only queue panel listing proposals (minimal, isolated addition).
- [ ] 14. `static/index.html`: edit draft, approve selected, deny actions wired to the REST API.

## Week 3 — Execute approved (exit: approve 3 → execute 3 → memory records; re-research skips them)
- [ ] 15. Hard gate in tool execution: like/follow/comment only for an approved queue item (code, not prompt) + test.
- [ ] 16. "Run approved" path: iterate approved items with pacing between actions.
- [ ] 17. Enforce dailyBudget in the run-approved path + test.
- [ ] 18. `src/browserController.ts`: confirm helpers (Follow→Following, like state, comment visible) before mark_done.
- [ ] 19. On done, record handle in engaged[]; on failure mark failed with reason (+ test).

## Week 4 — Continuity + harden (exit: multi-day loop without unsupervised engage)
- [ ] 20. `src/scheduler.ts`: optional "drain approved only" schedule mode; no new proposals unattended (+ test).
- [ ] 21. IG SPA reliability: waits/retries in the confirm helpers.
- [ ] 22. Light metrics (counts per status/day) exposed via API.
- [ ] 23. README: document the propose → approve → run-approved workflow.
