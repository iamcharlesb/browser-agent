import "./environment";
/**
 * Browserless research: an Agents SDK sub-agent with the hosted web search tool, plus a plain
 * page reader. Public lookups should never need Chrome; the browser stays for page work the user
 * explicitly asks for.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { envInteger } from "./runtimeConfig";
import { providerDefinition, providerKey, providerModel, providerURL } from "./providerRegistry";

export interface HostedSearchConfig { apiKey: string; baseURL?: string; model: string }

/** Hosted search needs an OpenAI Responses key, independent of the provider chosen for chat. */
export function hostedSearchConfig(): HostedSearchConfig | null {
  if ((process.env.BROWSER_AGENT_SEARCH_BACKEND || "auto").trim() === "scrape") return null;
  const openai = providerDefinition("openai");
  const apiKey = openai ? providerKey(openai) : undefined;
  const model = process.env.BROWSER_AGENT_SEARCH_MODEL?.trim() || (openai ? providerModel(openai) : undefined);
  if (!openai || !apiKey || !model) return null;
  return { apiKey, baseURL: providerURL(openai), model };
}

const SEARCH_INSTRUCTIONS =
  "You are a web research worker. Search the web for the query and return only findings that answer it. " +
  "Return at most 8 bullets, each one specific fact with its source URL in parentheses. Include prices, dates, " +
  "versions and numbers exactly as published. Note conflicting sources and say when something could not be verified. " +
  "No introduction, no conclusion, no advice.";

const cache = new Map<string, { at: number; text: string }>();
const CACHE_TTL_MS = envInteger("BROWSER_AGENT_SEARCH_CACHE_SECONDS", 600, 0, 86400) * 1000;
const CACHE_LIMIT = envInteger("BROWSER_AGENT_SEARCH_CACHE_ENTRIES", 50, 1, 1000);

/** Repeated identical lookups inside one session should not pay for a second search. */
function cached(query: string): string | undefined {
  const hit = cache.get(query.toLowerCase());
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.text;
  cache.delete(query.toLowerCase());
  return undefined;
}

function remember(query: string, text: string): void {
  cache.set(query.toLowerCase(), { at: Date.now(), text });
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
}

export async function hostedWebSearch(query: string, config: HostedSearchConfig, signal?: AbortSignal): Promise<string> {
  const q = query.trim();
  const hit = cached(q);
  if (hit) return hit;
  const base = (config.baseURL || "https://api.openai.com/v1").replace(/\/+$/, "");
  const response = await fetch(`${base}/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`
    },
    body: JSON.stringify({
      model: config.model,
      instructions: SEARCH_INSTRUCTIONS,
      input: q,
      tools: [{ type: "web_search_preview", search_context_size: "low" }]
    }),
    signal
  });
  if (!response.ok) {
    throw new Error(`Hosted web search failed with HTTP ${response.status}.`);
  }
  const payload = (await response.json()) as {
    output_text?: string;
    output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
  };
  const extracted =
    typeof payload.output_text === "string" && payload.output_text.trim()
      ? payload.output_text.trim()
      : (payload.output ?? [])
          .filter((item) => item?.type === "message" && Array.isArray(item.content))
          .flatMap((item) => item.content ?? [])
          .filter((block) => (block?.type === "output_text" || block?.type === "text") && typeof block.text === "string")
          .map((block) => block.text!)
          .join("\n")
          .trim();
  if (!extracted) throw new Error("Hosted web search returned no findings.");
  remember(q, extracted);
  return extracted;
}

function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 6) {
    const value = address.toLowerCase();
    if (value.startsWith("::ffff:")) {
      const suffix = value.slice(7);
      if (isIP(suffix) === 4) return isPrivateAddress(suffix);
      const parts = suffix.split(":").map(part => parseInt(part, 16));
      return parts.length !== 2 || isPrivateAddress([parts[0] >> 8, parts[0] & 255, parts[1] >> 8, parts[1] & 255].join("."));
    }
    return !/^[23]/.test(value); // Only global unicast IPv6; exclude loopback, LAN and translation ranges.
  }
  const [a, b] = address.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || b === 0)) || (a === 198 && (b === 18 || b === 19)) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

/** Page reads are for public pages; local services and the LAN stay out of reach of model-chosen URLs. */
export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error(`"${raw.slice(0, 120)}" is not a valid URL.`); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("fetch_url only reads http(s) pages.");
  if (url.username || url.password) throw new Error("fetch_url does not accept URLs with credentials.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) throw new Error("fetch_url does not read local addresses.");
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addresses.length || addresses.some(entry => isPrivateAddress(entry.address))) throw new Error("fetch_url does not read private network addresses.");
  return url;
}

/** Resolve again at connection time, validating the address actually used (DNS rebinding safe). */
async function requestPublic(url: URL, signal: AbortSignal | undefined, accept: string): Promise<Response> {
  return new Promise((resolve, reject) => {
    const timeout = AbortSignal.timeout(envInteger("BROWSER_AGENT_FETCH_TIMEOUT_MS", 10000, 1000, 60000));
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: { "User-Agent": "Pilo/0.1 (+page reader)", Accept: accept, "Accept-Encoding": "identity" },
      lookup: (hostname, _options, callback) => {
        void lookup(hostname, { all: true }).then(addresses => {
          if (!addresses.length || addresses.some(entry => isPrivateAddress(entry.address))) callback(new Error("fetch_url does not read private network addresses."), "", 4);
          else if (_options.all) callback(null, addresses);
          else callback(null, addresses[0].address, addresses[0].family);
        }, error => callback(error, "", 4));
      }
    }, response => {
      const headers = new Headers();
      for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
      const status = response.statusCode || 502;
      if ([204, 205, 304].includes(status) || (status >= 300 && status < 400 && headers.has("location"))) {
        response.destroy(); resolve(new Response(null, { status, headers })); return;
      }
      const chunks: Buffer[] = []; let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > envInteger("BROWSER_AGENT_FETCH_MAX_BYTES", 2000000, 10000, 10000000)) { request.destroy(new Error("Public page exceeds the configured byte limit.")); return; }
        chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => resolve(new Response(Buffer.concat(chunks), { status, headers })));
    });
    request.on("error", reject); request.end();
  });
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec))).replace(/&amp;/g, "&");
}

export function htmlToText(html: string): { title: string; text: string } {
  const title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || "").replace(/\s+/g, " ").trim();
  const body = html
    .replace(/<(script|style|noscript|svg|nav|footer|iframe)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|br)\s*>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  const text = decodeEntities(body).split("\n").map(line => line.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");
  return { title, text };
}

/** Fetches a public URL, following up to 3 redirects and re-checking every hop's address. */
export async function fetchPublic(raw: string, signal?: AbortSignal, accept = "text/html,text/plain,application/json;q=0.9,*/*;q=0.5"): Promise<{ response: Response; url: URL }> {
  let url = await assertPublicUrl(raw.trim());
  for (let hop = 0; hop < 4; hop += 1) {
    const response = await requestPublic(url, signal, accept);
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      url = await assertPublicUrl(new URL(location, url).toString());
      continue;
    }
    return { response, url };
  }
  throw new Error(`Too many redirects for ${raw}.`);
}

/** Exposes source URLs instead of discarding photos while stripping HTML tags. */
export function pageImageCandidates(html: string, pageUrl: string): string[] {
  const candidates = new Set<string>();
  const add = (raw: string | undefined) => {
    if (!raw || raw.length > 2048 || candidates.size >= 12) return;
    try {
      const url = new URL(decodeEntities(raw), pageUrl);
      if (/^https?:$/.test(url.protocol) && !url.username && !url.password) candidates.add(url.href);
    } catch { /* Ignore malformed source attributes. */ }
  };
  const source = html.replace(/<!--[\s\S]*?-->|<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "");
  for (const tag of source.match(/<(?:img|meta)\b[^>]*>/gi) || []) {
    const attrs: Record<string, string> = {};
    for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
      attrs[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4];
    }
    if (/^<meta\b/i.test(tag)) {
      if (/^(?:og:image(?::url|:secure_url)?|twitter:image(?::src)?)$/i.test(attrs.property || attrs.name || "")) add(attrs.content);
    } else {
      add(attrs["data-src"] || attrs["data-original"] || attrs.src);
    }
  }
  return [...candidates];
}

/** Reads public page text and image sources, or reports a direct image response. */
export async function fetchUrlText(raw: string, signal?: AbortSignal): Promise<string> {
  const maxChars = envInteger("BROWSER_AGENT_FETCH_CHARS", 6000, 500, 50_000);
  const { response, url } = await fetchPublic(raw, signal);
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}. The page could not be read.`);
  const type = response.headers.get("content-type") || "";
  if (/^image\//i.test(type)) {
    const bytes = (await response.arrayBuffer()).byteLength;
    if (!bytes) throw new Error(`${url} returned an empty image response.`);
    return `URL: ${url}\nImage response: ${type}\nBytes: ${bytes}\nVisual quality and reuse rights have not been verified; inspect the image and its source license.`;
  }
  if (!/text\/|json|xml/i.test(type)) throw new Error(`${url} returned ${type || "unknown content"}, not readable text.`);
  const body = (await response.text()).slice(0, 2_000_000);
  const { title, text } = /html/i.test(type) ? htmlToText(body) : { title: "", text: body };
  const clipped = text.length > maxChars ? `${text.slice(0, maxChars)}\n[truncated: ${text.length - maxChars} more characters]` : text;
  const images = /html/i.test(type) ? pageImageCandidates(body, url.href) : [];
  const imageSection = images.length ? `\n\nImage candidates (not visually reviewed or licensed by this tool):\n${images.join("\n")}` : "";
  return `${title ? `Title: ${title}\n` : ""}URL: ${url}\n\n${clipped}${imageSection}`;
}
