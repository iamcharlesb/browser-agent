# Live News Fetching & Briefing Playbook

## 1. Fetch Fresh Sources First
- Run targeted `web_search` queries including the topic and current timeframe (today / this week / current year) before summarizing.
- Open key articles or official announcements with `fetch_url` when snippets are thin or numbers/quotes need verification.
- Prefer primary sources (official filings, press releases, government/agency updates) and established newsrooms over repost blogs.

## 2. Verification & Freshness Checks
- Record the publication date (and time when breaking) for every item.
- If a story is developing or sources disagree, state both accounts and attribute each to its outlet.
- Never extrapolate beyond what retrieved sources report; if a paywall blocks full text, note the limitation honestly.

## 3. Clean Scannable Briefing Format (No Dense Bullet Walls)
Open with a single crisp header line (e.g., `## Latest Briefing — <Date>`), then format each story (default 5 items unless asked for more) as its own clean section:

### `Category` · Short, Concrete Headline
*Source · Date*

1–2 short, plain-English sentences covering what happened and why it matters. State any unconfirmed or developing caveats clearly.

[Read Source →](https://example.com)

Keep paragraphs short (under 40 words each) so every story scans in 3 seconds.

## 4. Beats & Follow-Ups
- Support topic beats (AI & tech, markets & business, world, science, policy, sports) and custom watchlists.
- Only create recurring news schedules when the user explicitly requests and approves a schedule.
