/** Post-process shopping summaries with verified product-page thumbnails (og:image). */
import { assertPublicUrl, fetchPublic } from "./webResearch";

const PRODUCT_URL =
  /https?:\/\/[^\s)\]<>"']+/gi;

const SEARCH_HOST = /(?:google\.|bing\.com|duckduckgo\.com|search\.yahoo)/i;
const NON_PRODUCT_URL =
  /(?:^|\.)(?:investor\.|sec\.gov|reuters\.com|bloomberg\.com|finance\.yahoo\.com|seekingalpha\.com|marketwatch\.com|wsj\.com|ft\.com|cnbc\.com|nasdaq\.com|nyse\.com|github\.com|docs\.|wikipedia\.org|medium\.com|substack\.com|linkedin\.com|x\.com|twitter\.com|reddit\.com|youtube\.com|youtu\.be)\b|\/(?:investor-news|news-details|press-releases?|earnings|sec-filings?|10-[kq]|docs?)\b/i;

export function looksLikeShoppingSummary(text: string): boolean {
  // Financial / earnings / SaaS pricing analyses mention "$" and "price" — never treat them as shopping.
  if (/\b(?:earnings|revenue|eps|market cap|stock price|price target|valuation|10-k|10-q|guidance|investor relations|mrr|arr|churn|runway)\b/i.test(text)) {
    return false;
  }
  return /\b(?:ship(?:ped|ping|s)?\b|in stock|out of stock|add to cart|buy now|free delivery|nursery|shrub|hibiscus|plant(?:s)?\b|checkout|storefront)\b/i.test(text);
}

export function extractProductUrls(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of text.match(PRODUCT_URL) || []) {
    const url = match.replace(/[.,;]+$/g, "");
    try {
      const parsed = new URL(url);
      if (!/^https?:$/i.test(parsed.protocol)) continue;
      if (SEARCH_HOST.test(parsed.hostname)) continue;
      if (NON_PRODUCT_URL.test(parsed.hostname + parsed.pathname)) continue;
      const norm = parsed.href;
      if (!seen.has(norm)) {
        seen.add(norm);
        out.push(norm);
      }
    } catch {
      // ignore
    }
  }
  return out;
}

function resolveUrl(src: string, base: string): string {
  try {
    return new URL(src.trim(), base).href;
  } catch {
    return src;
  }
}

function isSafeImageUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return /^https?:$/i.test(parsed.protocol) && !/\s/.test(url);
  } catch {
    return false;
  }
}

export async function fetchOpenGraphImage(pageUrl: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const { response: res, url: finalUrl } = await fetchPublic(pageUrl, signal, "text/html,application/xhtml+xml");
    if (!res.ok) return null;
    const html = (await res.text()).slice(0, 250_000);
    const patterns = [
      /<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image(?::secure_url)?["']/i,
      /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i
    ];
    for (const pattern of patterns) {
      const match = pattern.exec(html);
      if (match?.[1]) {
        const image = resolveUrl(match[1], finalUrl.href);
        if (isSafeImageUrl(image)) { await assertPublicUrl(image); return image; }
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** Append markdown product thumbnails when the model omitted them. */
export async function enrichShoppingSummary(summary: string, signal?: AbortSignal): Promise<string> {
  const text = summary.trim();
  if (!text || !looksLikeShoppingSummary(text)) return summary;
  if (/!\[[^\]]*\]\(https?:\/\//i.test(text)) return summary;

  const productUrls = extractProductUrls(text).slice(0, 3);
  if (!productUrls.length) return summary;

  const thumbs: string[] = [];
  for (const url of productUrls) {
    const image = await fetchOpenGraphImage(url, signal);
    if (image) thumbs.push(`[![Product photo](${image})](${url})`);
  }
  if (!thumbs.length) return summary;
  return `${text}\n\n${thumbs.join("\n\n")}`;
}
