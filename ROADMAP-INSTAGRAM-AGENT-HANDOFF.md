# Handoff: Instagram marketing agent roadmap (Open Bots)

**From:** Cursor agent session (Intelligent agent review)  
**To:** Grok Bot  
**Date:** 2026-10-17  
**Status:** Plan only — user asked not to implement yet. Do not start coding unless the user says so.

## Context

Project: `agentfireworks` → `node/browser_agent` (“Open Bots”).  
Goal: make a social-media marketing agent (Instagram follower growth) that can find relevant accounts, like, and comment — intelligently, but **not** unsupervised autopilot.

Current product already has: ReAct browser loop, Playwright + persistent profile, approvals for side effects, Instagram-oriented prompts, schedules that are **read-only** for engagement.

Gap vs ChatGPT Dots: weak durable memory, no engagement queue, schedules can’t safely engage.

## North star

User: “Grow my Instagram followers in my niche.”

1. Agent audits signed-in IG profile  
2. Finds niche-relevant accounts, drafts comments  
3. Writes proposals to a queue and **stops**  
4. User edits/approves in a checklist UI  
5. Agent executes **only approved** items, paced (≈5–8/day), confirms UI state  
6. Remembers engaged handles so next research skips them  

Unattended schedules: research/monitor only, or later **drain pre-approved queue** with hard daily caps — never invent new likes overnight.

## 4-week roadmap

### Week 1 — Foundation
- Per-bot JSON campaign store: niche, engaged[], skip[], dailyBudget  
- Engagement queue schema: proposed | approved | denied | done | failed  
- REST APIs + tools: `campaign_memory`, `engagement_queue`  
- Tests for schema, budget day-roll, path safety  
**Exit:** propose/approve via API with no Instagram.

### Week 2 — Research → Propose
- Orchestrator rule: research runs end in propose, not engage  
- Skip handles already in engaged/skip  
- UI checklist: edit draft, approve selected, deny  
**Exit:** research never silently likes/follows/comments.

### Week 3 — Execute approved
- “Run approved” path; hard gate in tools (not prompt-only)  
- Pacing + dailyBudget  
- Confirm Follow→Following / like / comment visible before mark_done  
**Exit:** approve 3 → execute 3 → memory records; re-research skips them.

### Week 4 — Continuity + harden
- Optional schedule: drain approved only (no new proposes unattended)  
- IG SPA reliability, metrics, README workflow  
**Exit:** multi-day loop without unsupervised engage.

## Explicit non-goals (this month)

- Unsupervised overnight liking from model judgment  
- Instagram private/mobile APIs  
- Multi-account farms  
- Full CRM  
- Rewriting the entire ~5k-line `index.html`

## Code touch map

| Week | Files |
|------|--------|
| 1 | new `campaignStore.ts` (+ tests); `agentTools.ts`; `server.ts` |
| 2 | `promptLoop.ts`; `static/index.html` queue panel |
| 3 | tool execute gate; confirm helpers in `browserController.ts` |
| 4 | schedule drain; README; light metrics |

## Acceptance criteria

- Research → proposed items only, zero engagement executed  
- Approvals persist across reload  
- Execute only approved + budget enforced  
- Second research does not re-propose engaged/skip handles  
- Schedules cannot invent new engagement

## How to help the user

- Hold the plan; answer questions; refine scope  
- When they say start Week 1, implement store + API first  
- Prefer the approve gate and daily budget over polish if time slips  

## Related Cursor canvas

`/Users/charlesbarathidass/.cursor/projects/Users-charlesbarathidass-Documents-Development-ai-products-agentfireworks/canvases/instagram-agent-roadmap.canvas.tsx`
