/**
 * Official / public research adapters so the agent can avoid DOM fights on
 * Reddit and Google properties when the goal is research or drafts.
 */

const MAX_ADAPTER_CHARS = 1400;

function truncate(text: string, max = MAX_ADAPTER_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 20)}\n…(truncated)`;
}

export interface RedditSearchOptions {
  query: string;
  subreddit?: string;
  sort?: "relevance" | "hot" | "top" | "new";
  limit?: number;
}

/** Public Reddit JSON (no OAuth). Read-only research; never posts. */
export async function redditSearch(options: RedditSearchOptions): Promise<string> {
  const query = options.query.trim();
  if (!query) return "reddit_search requires a non-empty query.";
  const limit = Math.min(Math.max(options.limit ?? 8, 1), 15);
  const sort = options.sort ?? "relevance";
  const sub = options.subreddit?.replace(/^r\//i, "").trim();

  const url = sub
    ? `https://www.reddit.com/r/${encodeURIComponent(sub)}/search.json?q=${encodeURIComponent(query)}&restrict_sr=1&sort=${sort}&limit=${limit}`
    : `https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=${sort}&limit=${limit}`;

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "OpenBots/1.0 (personal research agent; +local)",
        Accept: "application/json"
      },
      signal: AbortSignal.timeout(12_000)
    });
    if (!res.ok) {
      return truncate(
        `Reddit search HTTP ${res.status}. Prefer Connected Chrome for browsing, or try web_search. ` +
          `Do not scrape reddit.com in Playwright-launched Chrome if you hit a bot wall.`
      );
    }
    const data = (await res.json()) as {
      data?: { children?: Array<{ data?: Record<string, unknown> }> };
    };
    const children = data.data?.children ?? [];
    if (children.length === 0) {
      return `No Reddit results for "${query}"${sub ? ` in r/${sub}` : ""}.`;
    }
    const lines = children.map((child, i) => {
      const d = child.data ?? {};
      const title = String(d.title ?? "(no title)").slice(0, 120);
      const subreddit = String(d.subreddit ?? "");
      const score = d.score ?? "?";
      const comments = d.num_comments ?? "?";
      const permalink = d.permalink ? `https://www.reddit.com${d.permalink}` : "";
      const selftext = String(d.selftext ?? "")
        .replace(/\s+/g, " ")
        .slice(0, 160);
      return `${i + 1}. [${subreddit}] ${title} (↑${score} · ${comments} comments)\n   ${permalink}${selftext ? `\n   ${selftext}` : ""}`;
    });
    return truncate(
      `Reddit research (public JSON, read-only — draft only; never auto-post):\n${lines.join("\n")}`
    );
  } catch (err) {
    return truncate(`Reddit search failed: ${(err as Error).message}. Try web_search or Connected Chrome.`);
  }
}

export type GoogleProperty = "analytics" | "tagmanager" | "search_console" | "ads";

/** Guidance + deep links for Google properties (browser or future OAuth). */
export function googlePropertyGuide(property: GoogleProperty, note?: string): string {
  const links: Record<GoogleProperty, { name: string; url: string; tip: string }> = {
    analytics: {
      name: "Google Analytics (GA4)",
      url: "https://analytics.google.com/",
      tip: "Read-only by default. Open Reports → Engagement / Acquisition. Never invent metrics."
    },
    tagmanager: {
      name: "Google Tag Manager",
      url: "https://tagmanager.google.com/",
      tip: "Inspect tags/triggers only unless the user approved edits."
    },
    search_console: {
      name: "Google Search Console",
      url: "https://search.google.com/search-console",
      tip: "Prefer GSC over scraping Google SERP. Use Performance and URL Inspection on owned properties."
    },
    ads: {
      name: "Google Ads",
      url: "https://ads.google.com/",
      tip: "Ask before changing bids or campaigns. Prefer Connected Chrome for Google sign-in."
    }
  };
  const info = links[property];
  const extra = note?.trim() ? `\nContext: ${note.trim().slice(0, 200)}` : "";
  return truncate(
    `${info.name}\nOpen: ${info.url}\n${info.tip}\n` +
      `Auth tip: use Connect Apps → Connect my Chrome for Google login; Playwright-launched Chrome often fails OAuth.` +
      extra
  );
}
