/** Prefer API web_search over driving a browser search engine. */

export function isBareSearchQuery(target: string): boolean {
  const value = target.trim();
  if (!value || value === "about:blank" || /:\/\//.test(value)) return false;
  // Domain-like host without spaces (example.com or example.com/path).
  if (/^[a-z0-9.-]+\.[a-z]{2,}(?:[/:?#].*)?$/i.test(value) && !/\s/.test(value)) return false;
  return true;
}

function searchEngineKind(hostname: string): "google" | "bing" | "duckduckgo" | "yahoo" | null {
  const host = hostname.replace(/^www\./i, "").toLowerCase();
  if (/^(?:google\.[a-z.]+)$/i.test(host)) return "google";
  if (host === "bing.com") return "bing";
  if (host === "duckduckgo.com" || host.endsWith(".duckduckgo.com")) return "duckduckgo";
  if (host === "search.yahoo.com") return "yahoo";
  return null;
}

/** Search-engine home or search UI — not a retailer/product page. */
export function isSearchEngineSiteUrl(target: string): boolean {
  const raw = target.trim();
  if (!raw) return false;
  try {
    const url = new URL(/:\/\//.test(raw) ? raw : `https://${raw}`);
    const kind = searchEngineKind(url.hostname);
    if (!kind) return false;
    if (isSearchEngineResultsUrl(raw)) return true;
    const path = url.pathname.replace(/\/$/, "") || "/";
    if (kind === "google" && (path === "/" || path === "/webhp")) return true;
    if (kind === "bing" && path === "/") return true;
    if (kind === "duckduckgo" && (path === "/" || path === "")) return true;
    if (kind === "yahoo" && path === "/") return true;
    return false;
  } catch {
    return false;
  }
}

export function isLikelyProductPageUrl(target: string): boolean {
  const raw = target.trim();
  if (!raw) return false;
  try {
    const url = new URL(/:\/\//.test(raw) ? raw : `https://${raw}`);
    if (searchEngineKind(url.hostname)) return false;
    return /\/(?:products?|product-page|item|p\/|shop\/[^/]+|collections\/[^/]+\/products?)\b/i.test(url.pathname);
  } catch {
    return false;
  }
}

/** Public product/research asks should shortlist with web_search before Chrome. */
export function taskPrefersWebSearchFirst(task: string): boolean {
  const request = (task.replace(/^[\s\S]*User request:\s*/i, "").trim() || task.trim()).slice(0, 1200);
  if (!request) return false;
  if (/\b(?:search console|gsc|ga4|google analytics|tag manager|ads manager|sign in|log in|my account|signed in|dashboard)\b/i.test(request)) {
    return false;
  }
  if (/\b(?:this page|current page|on screen|the open tab|click |upload |save |publish |editor|form module)\b/i.test(request)) {
    return false;
  }
  const urlInTask = /(https?:\/\/[^\s)]+)/i.exec(request)?.[1];
  if (urlInTask && !isSearchEngineSiteUrl(urlInTask) && !isSearchEngineResultsUrl(urlInTask) && !isBareSearchQuery(urlInTask)) {
    return false;
  }
  return /\b(?:find|search|look up|ship(?:ped|ping)?|shrub|tree|flower|plant|hibiscus|nursery|buy|price|compare|research)\b/i.test(request);
}

export function shouldBlockBrowserNavigation(task: string, navigateUrl: string): string | null {
  const url = navigateUrl.trim();
  if (!url) return null;
  if (isBareSearchQuery(url) || isSearchEngineResultsUrl(url) || isSearchEngineSiteUrl(url)) {
    return browserSearchBlockedMessage(searchQueryFromNavigateTarget(url) || url);
  }
  if (taskPrefersWebSearchFirst(task) && !isLikelyProductPageUrl(url)) {
    return (
      `${browserSearchBlockedMessage(searchQueryFromNavigateTarget(task) || task.slice(0, 160))} ` +
      "Use fetch_url on a specific product URL when you must confirm size, stock, price, or shipping."
    );
  }
  return null;
}

export function isSearchEngineResultsUrl(target: string): boolean {
  const raw = target.trim();
  if (!raw) return false;
  try {
    const url = new URL(/:\/\//.test(raw) ? raw : `https://${raw}`);
    const kind = searchEngineKind(url.hostname);
    if (!kind) return false;
    if (kind === "google") {
      return url.pathname === "/search" || url.pathname.startsWith("/search") || url.pathname === "/url";
    }
    if (kind === "bing" || kind === "yahoo") {
      return url.pathname.startsWith("/search");
    }
    // DuckDuckGo HTML/lite/search pages with a query.
    return url.searchParams.has("q") || /\/html\/?$/i.test(url.pathname);
  } catch {
    return false;
  }
}

export function browserSearchBlockedMessage(queryHint?: string): string {
  const q = (queryHint || "").trim().slice(0, 160);
  return (
    "Use web_search for public research and shopping discovery instead of opening or typing into Google/Bing/DuckDuckGo in the browser. " +
    (q ? `Call web_search({ query: ${JSON.stringify(q)} }). ` : "Call web_search with the user's lookup. ") +
    "After shortlisting, use fetch_url on a specific retailer or product URL when you need to verify price, size, stock, or shipping."
  );
}

/** Extract a usable query from a search-engine URL or bare query string. */
export function searchQueryFromNavigateTarget(target: string): string {
  const raw = target.trim();
  if (isBareSearchQuery(raw)) return raw.slice(0, 200);
  try {
    const url = new URL(/:\/\//.test(raw) ? raw : `https://${raw}`);
    const q = url.searchParams.get("q") || url.searchParams.get("p");
    if (q) return q.slice(0, 200);
  } catch {
    // ignore
  }
  return "";
}
