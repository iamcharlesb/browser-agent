/**
 * Change triggers for schedules. A probe runs in application code on the schedule's cadence and
 * the model only starts when the probe reports a change, so a quiet watch costs no tokens.
 */

import { createHash } from "node:crypto";
import { fetchPublic, fetchUrlText } from "./webResearch";
import { envInteger } from "./runtimeConfig";

export type TriggerKind = "page" | "feed" | "json";

export interface ScheduleTrigger {
  kind: TriggerKind;
  url: string;
  /** page: only fire when this phrase is present (case-insensitive). */
  contains?: string;
  /** json: dot path to the watched value, e.g. "data.items.0.price". */
  path?: string;
}

export interface TriggerState {
  fingerprint?: string;
  /** feed: item ids already seen, newest first. */
  seen?: string[];
  checkedAt?: string;
}

export interface ProbeResult {
  changed: boolean;
  /** Compact description of what changed; becomes part of the woken run's context. */
  change: string;
  state: TriggerState;
}

const MAX_SEEN = envInteger("BROWSER_AGENT_WATCH_SEEN_ITEMS", 200, 10, 10000);
const MAX_CHANGE_CHARS = envInteger("BROWSER_AGENT_WATCH_CHANGE_CHARS", 3000, 200, 20000);

export function parseTrigger(input: unknown): ScheduleTrigger | undefined {
  if (input == null) return undefined;
  if (typeof input !== "object" || Array.isArray(input)) throw new Error("trigger must be an object.");
  const record = input as Record<string, unknown>;
  const kind = record.kind;
  if (kind !== "page" && kind !== "feed" && kind !== "json") throw new Error("trigger.kind must be page, feed or json.");
  const url = typeof record.url === "string" ? record.url.trim() : "";
  if (!/^https?:\/\//i.test(url) || url.length > 2000) throw new Error("trigger.url must be an http(s) URL.");
  const contains = typeof record.contains === "string" && record.contains.trim() ? record.contains.trim().slice(0, 200) : undefined;
  const path = typeof record.path === "string" && record.path.trim() ? record.path.trim().slice(0, 200) : undefined;
  return { kind, url, ...(contains ? { contains } : {}), ...(path ? { path } : {}) };
}

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

/** Pulls item ids and titles from RSS or Atom without a parser dependency. */
export function feedItems(xml: string): Array<{ id: string; title: string; link: string }> {
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) || [];
  return blocks.map(block => {
    const text = (name: string) => (new RegExp(`<(?:[a-z]+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:[a-z]+:)?${name}>`, "i").exec(block)?.[1] || "")
      .replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]+>/g, "").trim();
    const link = text("link") || /<link\b[^>]*href="([^"]+)"/i.exec(block)?.[1] || "";
    const title = text("title");
    const id = text("guid") || text("id") || link || hash(title);
    return { id, title, link };
  }).filter(item => item.id);
}

export function valueAtPath(value: unknown, path?: string): unknown {
  if (!path) return value;
  return path.split(".").reduce<unknown>((current, key) =>
    current && typeof current === "object" ? (current as Record<string, unknown>)[key] : undefined, value);
}

/** Pure comparison step, separated from fetching so it can be tested without a network. */
export function compareSnapshot(trigger: ScheduleTrigger, body: string, previous: TriggerState, now = new Date()): ProbeResult {
  const checkedAt = now.toISOString();
  if (trigger.kind === "feed") {
    const items = feedItems(body);
    const seen = new Set(previous.seen || []);
    const fresh = items.filter(item => !seen.has(item.id));
    const state = { seen: [...fresh.map(item => item.id), ...(previous.seen || [])].slice(0, MAX_SEEN), checkedAt };
    // The first probe records a baseline; existing items are not news.
    if (!previous.seen) return { changed: false, change: "", state };
    const change = fresh.map(item => `- ${item.title || "(untitled)"} ${item.link}`.trim()).join("\n").slice(0, MAX_CHANGE_CHARS);
    return { changed: fresh.length > 0, change: fresh.length ? `${fresh.length} new feed item(s):\n${change}` : "", state };
  }
  let watched = body;
  if (trigger.kind === "json") {
    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch { throw new Error(`${trigger.url} did not return JSON.`); }
    watched = JSON.stringify(valueAtPath(parsed, trigger.path) ?? null);
  }
  if (trigger.contains && !watched.toLowerCase().includes(trigger.contains.toLowerCase())) {
    return { changed: false, change: "", state: { fingerprint: previous.fingerprint, checkedAt } };
  }
  const fingerprint = hash(watched);
  const state = { fingerprint, checkedAt };
  if (!previous.fingerprint && !trigger.contains) return { changed: false, change: "", state };
  if (previous.fingerprint === fingerprint) return { changed: false, change: "", state };
  const label = trigger.kind === "json" ? `Value${trigger.path ? ` at ${trigger.path}` : ""} is now: ` : trigger.contains ? `Page now contains "${trigger.contains}". Current text:\n` : "Page changed. Current text:\n";
  return { changed: true, change: `${label}${watched.slice(0, MAX_CHANGE_CHARS)}`, state };
}

export async function probeTrigger(trigger: ScheduleTrigger, previous: TriggerState, signal?: AbortSignal): Promise<ProbeResult> {
  let body: string;
  if (trigger.kind === "page") {
    // Drop the URL/title header so only page content affects the fingerprint.
    body = (await fetchUrlText(trigger.url, signal)).split("\n\n").slice(1).join("\n\n");
  } else {
    const { response } = await fetchPublic(trigger.url, signal);
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${trigger.url}.`);
    body = (await response.text()).slice(0, 2_000_000);
  }
  return compareSnapshot(trigger, body, previous);
}
