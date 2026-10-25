# Conversation requirements audit — 25 October 2026

This audit compares the user’s requests in this chat, the six supplied role specifications, and the pasted orchestration discussion with the checked-out browser-agent implementation. It distinguishes code inspection, isolated browser verification, runtime unit/integration tests, and work that has not been demonstrated against live services. A passing test suite alone does not establish that every requested feature is complete.

## Findings that were corrected in this audit

1. **Portrait identity had been guessed from attachment order.** The photos now come from explicitly named portraits on each person’s own site/company page. `static/avatars/provenance.json` records the exact source page, image URL and file hash. No identity was inferred from an uploaded face.
2. **Portrait replacements reused URLs cached for a day.** Each current portrait URL now contains its file hash; image responses revalidate and the HTML response disables storage. Old avatar URLs still resolve to the corrected assets. This addresses stale cached images as well as wrong assignments in the code. The supplied screenshot shows former titles, but it is not evidence of the currently running process’s version.
3. **The customizer preview ignored preset portraits.** The preview now uses the selected preset photo and matches the created bot.
4. **Bot renaming overwrote user-authored descriptions.** The legacy-name migration now preserves existing descriptions, summaries, IDs, and chat history while rebuilding the matching role intent.
5. **Legacy seed cleanup could remove used bots.** Automatic seeding code has been removed. Unused canonical seed records are archived locally before removal; canonical records containing user messages are retained. Earlier versions may already have removed a record; this patch cannot reconstruct content that no longer exists in either device storage or its backups.
6. **Scrolling was only declared, not working under a long roster.** A 40-bot browser scenario demonstrated that the sidebar parent could grow beyond the viewport. The parent now has a bounded minimum height and hidden overflow, while the list scrolls and rows do not shrink.
7. **Welcome/New Bot icons still had 3D styling.** The welcome mark and New Bot control now use flat bot graphics. Blog Writer uses a flat document/pen SVG.
8. **The Electron window icon did not explicitly update the macOS dock.** The existing brand SVG is now accompanied by a raster icon, used by both the window and `app.dock.setIcon`.
9. **The full role attachments were not retained for retrieval.** Six complete user-supplied specifications are now appended to their relevant playbooks. Compact runtime context remains bounded; `knowledge_base` can retrieve the remaining pages. UX and paid-media bots now also have dedicated compact instructions and voice files.
10. **The discussion round limit was hardcoded.** It now comes from `BROWSER_AGENT_MAX_DISCUSSION_ROUNDS`, with an eventual synthesis required at the configured limit.
11. **Settings still exposed every provider credential by default.** Provider connection fields are now collapsed, while estimated dollars are visible at the top of settings.
12. **Background sidebar refreshes reset the preset dropdown.** Refreshing its available options now preserves an existing valid choice.

## Requirement-by-requirement assessment

| User requirement | Current assessment | Evidence and boundary |
| --- | --- | --- |
| All bots can work asynchronously | Implemented as asynchronous acceptance and persistent queuing; simultaneous execution is not implemented | `src/asyncAgentQueue.ts` accepts multiple jobs and restores queued jobs. The executor and shared browser retain one active owner. This must not be described as all bots running models or browser actions concurrently. |
| Meaningful bot discussions, possibly many rounds, eventually conclude | Implemented with a configurable bound | `src/server.ts` tracks specialist replies and returns control to the coordinator; the final round disables further delegation and asks for synthesis. Runtime tests validate coordination mechanics. Quality of a real multi-model discussion was not evaluated in this audit. |
| Estimated dollars and less noisy settings | Implemented for configured prices | Usage/cost details are in settings, alongside collapsed advanced information. `MODEL_PRICING_JSON` supplies prices. Missing provider prices are not live billing measurements; no billing comparison was performed. |
| Predefined UX bot from supplied role | Corrected and available | Dedicated core/voice at `agents/UX_Psychology_Conversion_Expert/`; full attachment in `playbooks/ux.md`. Bounded profile/reference retrieval is tested. |
| Predefined advertising bot from supplied role | Corrected and available | Dedicated core/voice at `agents/Paid_Media_Performance_Marketing_Specialist/`; full attachment in `playbooks/paid-media.md`. No real campaign was launched or ad account audited. |
| Alex Hormozi bot | Correct exact public name and profile | `Inspired by Alex Hormozi` maps to the offers/value/growth profile and its complete supplied reference. The prior internal Value Architect directory is retained as a stable learning/profile namespace. |
| Sabri Suby bot | Correct exact public name and supplied role scope | `Inspired by Sabri Suby` maps to direct response/revenue strategy. The visible Sabri request stops at “Belief 1: Understand the Market Before”; there is no complete additional role attachment in the supplied files. The implemented compact role and direct-response playbook should not be represented as a transcription of a missing full specification. |
| Principal full-stack/cloud/distributed systems bot | Available | `The Systems Architect`, dedicated core/voice and complete supplied reference. This is a role-based bot and has no single-person portrait/name. |
| Addy Osmani bot | Correct exact public name and profile | `Inspired by Addy Osmani` maps to engineering quality, frontend architecture, performance and AI-assisted engineering. Complete supplied reference retained. |
| Andrej Karpathy bot | Correct exact public name and profile | `Inspired by Andrej Karpathy` maps to AI/LLM/agent engineering. Complete supplied reference retained. |
| Correct portraits | Corrected with explicit source provenance | Named first-party images, local assets, content hashes, and browser image decoding checks. These associations no longer depend on the previous guessed attachment order. |
| Specialist dropdown is optional | Verified in the actual UI | Blank bot remains available. Selecting the Alex preset fills the required name, relevant role and matching portrait preview; creating it adds one sidebar bot. |
| Show all predefined bots in three columns | Verified on desktop | The browser audit checks the three computed columns and all four exact person-inspired entries. Narrow screens use the responsive column rules. |
| Sort bots not yet added first | Verified | Available entries precede added entries; each group is sorted by name. An added card opens the existing bot without duplication. |
| Sidebar only includes bots the user added | Corrected and verified | Fresh storage yields an empty roster. Catalog entries alone do not create roster entries. Unused canonical seed records are archived/hidden; manually created records and history are preserved. |
| Smaller bot icons and scrolling | Verified | Final sidebar avatar boxes are 29 CSS pixels: 38 → 33 after the first 5-pixel request, then 33 → 29 after the later 4-pixel request. A 40-bot roster now actually scrolls. |
| Use 2D icons for New Bot | Corrected and verified | Both New Bot and welcome bot marks have no gradient/background image; photo portraits remain photographs. |
| Replace the pictured blob/blog icon | Corrected conservatively | Removed the sculpted welcome mark and supplied Blog Writer with a flat document/pen icon. The earlier interpretation that only Blog Writer was meant did not cover the pictured welcome mark. |
| Unmanaged observer suggests improvements | Partial relative to the broad original request | Existing observer deterministically detects explicit corrections and proposes drafts. It does not generally understand every conversation or autonomously write trusted instructions. Review is required by the repository instructions; the code must keep proposed lessons pending until reviewed. |
| Observer/workflow/cost controls only inside settings | Verified | All three controls reside inside `#settings-modal`; the later settings-only instruction supersedes the earlier header request. |
| Scheduled tasks for every bot | Implemented, inspected | The schedule dialog fetches all schedules, groups by bot, and supports management. Scheduler tests pass. No real recurring job was started in this audit. |
| Beautiful charts with preview and download | Basic capability exists; richer behavior remains partial | `create_document` can save model-authored SVG; artifact rendering previews SVG and provides a download. There is no dedicated validated chart builder/editor or demonstrated quality guarantee. No paid model-generated chart was commissioned during this audit. |
| Dislike means correction, not avoiding a topic | Verified in UI and inspected on backend | The Correct flow requires guidance, posts `kind: correction`, stores explicit user guidance, and acknowledges applying it. It does not claim to immediately regenerate the prior response. |
| MongoDB events, deterministic routing, reviewed playbooks, low token context | Implemented mechanisms; external deployment unverified | Durable events/workflow state/profile budgets/reviewed playbooks have tests. MongoDB workspace setup is opt-in. No live cross-device Mongo deployment or comparative token-efficiency benchmark was run. The pasted discussion’s adaptive compiler/novelty ideas are not proven product capabilities. |
| Commit and push completed changes | Performed for preceding work; this audit revision records its own commit | Parent repository and browser-agent submodule are both updated. No unrelated parent work is included. |

## Remaining limits that must not be called fully implemented

- Independent bots do not execute simultaneously; the current asynchronous queue serializes the active executor.
- The observer proposes explicit corrections; it is not a general autonomous improvement analyst. Trusted instruction updates require review.
- Charts rely on generated SVG. A structured chart authoring tool and consistent visual-quality validation remain outside the demonstrated capability.
- A specialist renamed to an arbitrary custom name can lose automatic backend profile selection because core profiles are selected by name/known aliases. The requested exact “Inspired by …” names are covered and tested; a universal stable preset ID across arbitrary renames, schedules and workflows is not yet implemented.
- Full source attachments are available on demand. This does not mean the bots have read every external book/resource mentioned in those attachments or can promise its results.
- The audit uses isolated UI/API fixtures plus runtime tests. It does not validate current provider credentials, paid execution, real campaign changes, the user’s live Google session, or a deployed Mongo cluster.

## Verification

- `node scripts/auditBotCatalog.cjs`: 19 checks using the actual HTML, CSS, browser runtime and local portrait files in Chromium; API calls are isolated fixtures so no real user jobs or paid model calls are started.
- The checks cover fresh onboarding, exact labels, source-to-bot portrait mapping and photo decode, three columns, preset role and preview, explicit roster membership, icon size, reload persistence, no duplicate bots, correction feedback, migration/history preservation, unused seed cleanup, settings placement, flat graphics, available-first sorting, and scrolling with 40 bots.
- `npm test`: includes the repository secret scan and TypeScript test build. 266/266 tests passed. Added profile checks verify dedicated UX/paid roles and bounded access to complete source references.
- Visual inspection: [saved browser screenshot](audit-evidence/bot-catalog.png), produced from the checked-out current UI.
- Live services, model reasoning quality and macOS dock rendering are not asserted by the isolated UI check. The dock code is configured; confirming a running dock icon requires launching/restarting the desktop shell.

## Portrait source pages

- Sabri Suby: [King Kong team page](https://kingkong.co/about-us/), named “Sabri Suby Founder & Head of Growth.”
- Alex Hormozi: [Acquisition.com profile](https://www.acquisition.com/about-alex-hormozi-acquisition), explicitly labeled Alex Hormozi portrait.
- Addy Osmani: [official press page](https://addyosmani.com/press/), photo labeled “addy osmani photo” under “2020 Photoshoot - Cyan.”
- Andrej Karpathy: [personal profile](https://karpathy.ai/), main profile image alongside the named heading.
