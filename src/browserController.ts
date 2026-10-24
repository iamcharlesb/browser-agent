/** Browser operations and state capture, backed by Playwright for Node. */

import { browserViewportSize } from "./apiContract";
import { ensureManagedChrome, managedChromeEnabled } from "./managedChrome";
import { desktopBrowserAvailable, desktopBrowserRequest } from "./desktopBrowser";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  Browser,
  BrowserContext,
  CDPSession,
  Page,
  chromium,
  errors as playwrightErrors
} from "playwright";

/**
 * Chromium's own singleton-instance lock files for a profile directory. If the process that
 * created them dies abruptly (crash, force-quit, OOM, killed parent process) instead of calling
 * context.close(), these are left behind and block every future launch against that profile with
 * an opaque "Target page, context or browser has been closed" error - Chromium doesn't reliably
 * self-heal from this. Safe to clear unconditionally right before launching: this app already
 * enforces at most one BrowserController using a given profile directory at a time (the server's
 * single activeSession slot), so if we're here, we know nothing legitimate is really holding it.
 */
const CHROMIUM_SINGLETON_LOCK_FILES = ["SingletonLock", "SingletonCookie", "SingletonSocket"];

function clearStaleSingletonLock(userDataDir: string): void {
  for (const filename of CHROMIUM_SINGLETON_LOCK_FILES) {
    try {
      rmSync(join(userDataDir, filename), { force: true });
    } catch {
      // best-effort; a failed cleanup here just means the original launch error resurfaces
    }
  }
}

/**
 * Default on-disk profile directory. Using a persistent Chromium profile (cookies, local
 * storage, session state) instead of a fresh in-memory context on every run is what lets the
 * agent stay signed in across runs: log in and clear MFA once in this profile, and subsequent
 * runs reuse that session instead of hitting a login wall every time.
 */
export const DEFAULT_PROFILE_DIR = join(homedir(), ".browser-agent-profile");
/** A dedicated Chrome profile; never open or copy the user's personal Chrome profile. */
export const DEFAULT_CHROME_PROFILE_DIR = join(homedir(), ".buddy-bot-chrome-profile");
/** Profile used when the user starts Chrome with remote debugging for CDP attach. */
export const DEFAULT_CDP_PROFILE_DIR = join(homedir(), ".buddy-bot-chrome-cdp");
export const DEFAULT_CDP_ENDPOINT = "http://127.0.0.1:9222";
/** Electron remote-debugging port for the in-app Live Browser (not Connected Chrome's 9222). */
export const DEFAULT_ELECTRON_CDP_PORT = 9333;
export const DEFAULT_ELECTRON_CDP_ENDPOINT = `http://127.0.0.1:${DEFAULT_ELECTRON_CDP_PORT}`;
/** User-agent marker set on Electron's Live Browser WebContents so Playwright can select it. */
export const EMBEDDED_UA_MARKER = "OpenBotsLive/1";
/** Informational path label for embedded mode (cookies actually live in Electron partition persist:open-bots). */
export const DEFAULT_EMBEDDED_PROFILE_LABEL = "persist:open-bots";
export type SessionMode = "persistent" | "guest" | "cdp" | "embedded";

const INTERACTIVE_SELECTOR =
  'a[href], button, input, select, textarea, ' +
  '[role="button"], [role="link"], [role="checkbox"], [role="radio"], ' +
  '[role="tab"], [role="menuitem"], [role="combobox"], [role="switch"], ' +
  '[onclick], [contenteditable="true"], [contenteditable="true"] h1, [contenteditable="true"] h2, [contenteditable="true"] h3, [contenteditable="true"] p';

/** Executed inside the page via page.evaluate — must be a real function, not a string, so
 * Playwright's Node binding actually invokes it with the given argument. */
function extractInteractiveElements(selector: string): RawElement[] {
  const nodes = Array.from(document.querySelectorAll(selector));
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const results: RawElement[] = [];
  for (const [domIndex, el] of nodes.entries()) {
    const tagLower = el.tagName.toLowerCase();
    const editable = (el as HTMLElement).isContentEditable;
    const isDirectEditableRoot = el.getAttribute("contenteditable") === "true";
    // Rich editors with both headings and paragraphs expose sub-blocks; single-block editors (TipTap/Quill <div contenteditable="true"><p><br></p></div>) should expose the root editor.
    if (isDirectEditableRoot) {
      const hasHeading = Boolean(el.querySelector("h1, h2, h3"));
      const pCount = el.querySelectorAll("p").length;
      if (hasHeading && pCount > 0) continue;
    } else if (editable) {
      const rootEditable = el.closest('[contenteditable="true"]');
      if (rootEditable) {
        const hasHeading = Boolean(rootEditable.querySelector("h1, h2, h3"));
        const pCount = rootEditable.querySelectorAll("p").length;
        if (!(hasHeading && pCount > 0)) continue;
      }
    }
    const isFormControl =
      tagLower === "input" ||
      tagLower === "textarea" ||
      tagLower === "select" ||
      editable ||
      el.getAttribute("type") === "submit";
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    const maxBottom = isFormControl ? vh * 3.5 : vh;
    if (rect.bottom < 0 || rect.top > maxBottom || rect.right < 0 || rect.left > vw) continue;
    const style = window.getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") continue;
    if (parseFloat(style.opacity || "1") === 0) continue;
    const cx = Math.max(1, Math.min(vw - 1, Math.round(rect.left + rect.width / 2)));
    const cy = Math.max(1, Math.min(vh - 1, Math.round(rect.top + rect.height / 2)));
    let label = "";
    if (tagLower === "select") {
      const sel = el as HTMLSelectElement;
      const selectedText = (sel.selectedOptions?.[0]?.text || sel.value || "").trim().replace(/\s+/g, " ");
      const opts = Array.from(sel.options)
        .map((o) => (o.text || o.value || "").trim().replace(/\s+/g, " "))
        .filter(Boolean)
        .slice(0, 6)
        .join(" | ");
      label = `Selected: "${selectedText}" [Options: ${opts}]`;
    } else {
      label =
        el.getAttribute("aria-label") ||
        el.getAttribute("placeholder") ||
        el.getAttribute("data-placeholder") ||
        el.getAttribute("data-default-value") ||
        el.getAttribute("name") ||
        el.getAttribute("title") ||
        el.getAttribute("alt") ||
        (el as HTMLElement).innerText ||
        (el as HTMLInputElement).value ||
        "";
    }
    if (!label && isFormControl) {
      const prev = el.previousElementSibling;
      const parentLabel = el.closest("label");
      const associatedLabel =
        (prev && prev.tagName.toLowerCase() === "label" ? (prev as HTMLElement).innerText : "") ||
        (parentLabel ? parentLabel.innerText : "");
      if (associatedLabel) label = associatedLabel;
      else if (editable) label = "Rich text content editor";
    }
    if (!label) {
      const img = el.querySelector("img[alt]");
      if (img) label = img.getAttribute("alt") || "";
    }
    if (!label) {
      const svgTitle = el.querySelector("svg title, svg[aria-label]");
      if (svgTitle) label = svgTitle.getAttribute("aria-label") || svgTitle.textContent || "";
    }
    const href = el.getAttribute("href") || "";
    label = label.trim().replace(/\s+/g, " ").slice(0, 110);
    if (href && !href.startsWith("javascript:") && href !== "#" && label.length < 60) {
      const shortHref = href.length > 45 ? href.slice(0, 42) + "..." : href;
      label = label ? `${label} -> ${shortHref}` : shortHref;
    }
    results.push({
      tag: tagLower,
      domIndex,
      elementType: editable ? "contenteditable" : el.getAttribute("type") || "",
      role: el.getAttribute("role") || "",
      text: label,
      x: cx,
      y: cy,
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    });
  }
  return results;
}

/** Extracts visible readable text and key stats from the current viewport/page so the agent can read counts, metrics, and content directly. */
function extractPageTextSummary(): string {
  const body = document.body;
  if (!body) return "";
  const metaDesc =
    document
      .querySelector('meta[name="description"], meta[property="og:description"]')
      ?.getAttribute("content") || "";

  // Extract main/header/article content first so left-sidebar navigation links don't drown out profile stats
  const priorityNodes = Array.from(document.querySelectorAll("main, header, article, [role='main']"));
  const priorityText = priorityNodes
    .map((el) => ((el as HTMLElement).innerText || "").trim())
    .filter(Boolean)
    .join("\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();

  // Also explicitly surface any visible numeric stat badges (e.g. "12 posts", "39 followers", "184 following", prices, counts)
  const statMatches: string[] = [];
  const statEls = Array.from(document.querySelectorAll("header li, header span, header a, main li, main span, main a, h1, h2, h3"));
  for (const el of statEls) {
    const t = ((el as HTMLElement).innerText || el.getAttribute("title") || "").replace(/\s+/g, " ").trim();
    if (
      t.length >= 2 &&
      t.length <= 65 &&
      /\b\d[\d,.]*[kmbKMB]?\s*(followers?|following|posts?|subscribers?|views?|likes?|stars?|forks?|reviews?|items?|results?)\b/i.test(t)
    ) {
      if (!statMatches.includes(t)) statMatches.push(t);
    }
  }

  const rawBodyText = (body.innerText || "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();

  const parts: string[] = [];
  if (metaDesc) parts.push(`[Meta: ${metaDesc}]`);
  if (statMatches.length > 0) parts.push(`[Detected Stats: ${statMatches.slice(0, 12).join(" | ")}]`);
  if (priorityText) {
    parts.push(priorityText.slice(0, 2200));
  } else {
    parts.push(rawBodyText.slice(0, 2200));
  }
  return parts.join("\n").slice(0, 2800);
}

const VERIFICATION_TITLE_KEYWORDS = [
  "are you a human",
  "verify you are human",
  "prove your humanity",
  "prove you are human",
  "human verification",
  "unusual traffic",
  "unusual activity",
  "security check",
  "just a moment",
  "checking your browser",
  "captcha",
  "robot check",
  "not a robot",
  "attention required",
  "verify it's you",
  "select all images",
  "checkpoint",
  "two-factor",
  "two factor",
  "2fa",
  "one-time code",
  "one time code",
  "verification code"
];

export function titleRequiresHumanVerification(title: string): boolean {
  const lower = title.toLowerCase();
  return VERIFICATION_TITLE_KEYWORDS.some((keyword) => lower.includes(keyword));
}

/** A rejected OAuth browser cannot be recovered by solving a CAPTCHA. */
export function googleSignInRejected(url: string, title = "", text = ""): boolean {
  try {
    const target = new URL(url);
    if (target.hostname !== "accounts.google.com") return false;
    return /\/signin\/rejected(?:\/|$)/i.test(target.pathname) ||
      target.searchParams.get("error") === "disallowed_useragent" ||
      /this browser or app may (?:not be secure|be insecure)|disallowed_useragent/i.test(text) ||
      (/couldn[’']t sign you in/i.test(title) && /try using a different browser/i.test(text));
  } catch {
    return false;
  }
}

export function pageAccessDenied(title: string, text: string): boolean {
  return /^(?:access denied|403 forbidden|request blocked)(?:\b|\s)/i.test(title.trim()) ||
    /(?:^|\n)\s*(?:sorry,? you have been blocked|you are unable to access\s+\S+|error (?:code:?\s*)?1020\b)/i.test(text.trim());
}

function isRecoverableNavigationError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    err instanceof playwrightErrors.TimeoutError ||
    /has been closed|Target closed|Target page, context or browser has been closed|Execution context was destroyed|frame was detached|Browser has not been started/i.test(
      msg
    )
  );
}

/**
 * Executed inside the page via page.evaluate — must be a real function, see note above.
 * Flags active CAPTCHA/bot-check widgets AND blocking login/MFA walls.
 */
function detectVerificationChallenge(): boolean {
  const captchaSelectors = [
    'iframe[src*="recaptcha"]',
    'iframe[src*="hcaptcha"]',
    'iframe[src*="challenges.cloudflare"]',
    'iframe[title*="captcha" i]',
    'iframe[title*="recaptcha" i]',
    'div[class*="cf-turnstile"]',
    "div#challenge-form",
    'div[class*="g-recaptcha"]',
    'input[autocomplete="one-time-code"]'
  ];
  for (const selector of captchaSelectors) {
    const el = document.querySelector(selector);
    if (el) {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) return true;
    }
  }
  const bodyText = (document.body?.innerText || "").slice(0, 800).toLowerCase();
  if (
    /select all images with|i'?m not a robot|prove your humanity|prove you(?:'?re| are) human|unusual traffic|verify you are human|complete the security check/.test(
      bodyText
    )
  ) {
    return true;
  }
  // Only flag password inputs if the page is predominantly a login/auth screen (not a full content page with a hidden or header login input)
  const pwd = document.querySelector('input[type="password"]');
  if (pwd) {
    const rect = pwd.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      const urlPath = window.location.pathname.toLowerCase();
      const isAuthUrl = /\/(login|signin|sign-in|accounts\/login|auth|session|challenge|checkpoint)/.test(urlPath);
      const mainLinks = document.querySelectorAll("a[href]").length;
      if (isAuthUrl || mainLinks < 25) {
        return true;
      }
    }
  }
  return false;
}

export class BrowserActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserActionError";
  }
}

export interface BrowserConfig {
  viewportWidth: number;
  viewportHeight: number;
  headless: boolean;
  navigationTimeoutMs: number;
  actionTimeoutMs: number;
  idleTimeoutMs: number;
  maxElements: number;
  userAgent?: string;
  channel?: "chrome";
  /** Persistent on-disk Chromium profile directory. Same directory across runs = same cookies,
   * local storage, and signed-in sessions, so logins and MFA only have to happen once. */
  userDataDir: string;
  /** When true, launches an isolated ephemeral Guest browser context without saving cookies/sessions to disk. */
  guestMode?: boolean;
  /**
   * When set, attach to an already-running Chrome (or Electron) via CDP instead of launching
   * Playwright's Chrome. Used by Connected Chrome and the in-app embedded browser.
   */
  cdpEndpoint?: string;
  /** When true, CDP target is Electron's docked Live Browser — never focus-steal. */
  embeddedMode?: boolean;
  /** Open Bots UI origin (e.g. http://127.0.0.1:8765) so embedded attach can skip the app chrome. */
  uiOrigin?: string;
}

export function defaultBrowserConfig(overrides: Partial<BrowserConfig> = {}): BrowserConfig {
  const config: BrowserConfig = {
    viewportWidth: 1280,
    viewportHeight: 800,
    headless: true,
    navigationTimeoutMs: 18_000,
    actionTimeoutMs: 6_000,
    idleTimeoutMs: 250,
    maxElements: 40,
    userDataDir: DEFAULT_PROFILE_DIR,
    guestMode: false,
    ...overrides
  };
  if (config.viewportWidth <= 0 || config.viewportHeight <= 0) {
    throw new Error("viewport dimensions must be positive integers");
  }
  if (config.navigationTimeoutMs <= 0 || config.actionTimeoutMs <= 0 || config.idleTimeoutMs <= 0) {
    throw new Error("timeouts must be positive integers");
  }
  if (config.maxElements <= 0) {
    throw new Error("maxElements must be a positive integer");
  }
  return config;
}

/** Shell one-liner to start Chrome with remote debugging for Connected Chrome mode. */
export function chromeCdpLaunchCommand(
  endpoint = DEFAULT_CDP_ENDPOINT,
  profileDir = DEFAULT_CDP_PROFILE_DIR
): { endpoint: string; profileDir: string; command: string; port: number } {
  const portMatch = endpoint.match(/:(\d+)\s*$/);
  const port = portMatch ? Number(portMatch[1]) : 9222;
  const quotedProfile = profileDir.includes(" ") ? `"${profileDir}"` : profileDir;
  const command =
    process.platform === "darwin"
      ? `open -na "Google Chrome" --args --remote-debugging-port=${port} --user-data-dir=${quotedProfile}`
      : process.platform === "win32"
        ? `start "" chrome.exe --remote-debugging-port=${port} --user-data-dir=${quotedProfile}`
        : `google-chrome --remote-debugging-port=${port} --user-data-dir=${quotedProfile}`;
  return { endpoint, profileDir, command, port };
}

export async function probeCdpEndpoint(endpoint = DEFAULT_CDP_ENDPOINT): Promise<boolean> {
  try {
    const res = await fetch(`${endpoint.replace(/\/$/, "")}/json/version`, {
      signal: AbortSignal.timeout(1500)
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * On macOS, closing all windows of the dedicated Chrome instance leaves the Chrome process running
 * in the Dock with `/json/version` reachable but `/json/list` empty (`[]`). Playwright's
 * `connectOverCDP` then fails with `Protocol error (Browser.setDownloadBehavior): Browser context
 * management is not supported`. Opening a `about:blank` page target via `/json/new` wakes up a
 * browser window/context before Playwright attaches.
 */
export async function ensureCdpPageTarget(endpoint = DEFAULT_CDP_ENDPOINT): Promise<void> {
  const base = endpoint.replace(/\/$/, "");
  try {
    const listRes = await fetch(`${base}/json/list`, { signal: AbortSignal.timeout(1500) });
    if (listRes.ok) {
      const targets = (await listRes.json()) as Array<{ type?: string }>;
      if (Array.isArray(targets) && targets.some((t) => t && t.type === "page")) {
        return;
      }
    }
    const putRes = await fetch(`${base}/json/new?about:blank`, {
      method: "PUT",
      signal: AbortSignal.timeout(3000)
    });
    if (!putRes.ok) {
      await fetch(`${base}/json/new?about:blank`, { signal: AbortSignal.timeout(3000) }).catch(() => undefined);
    }
  } catch {
    // Ignore; reachability errors are handled by probeCdpEndpoint / connectOverCDP.
  }
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

export function resolveEmbeddedCdpEndpoint(explicit?: string): string {
  return (
    explicit ||
    process.env.BROWSER_AGENT_EMBEDDED_CDP_ENDPOINT ||
    process.env.OPEN_BOTS_ELECTRON_CDP_ENDPOINT ||
    `http://127.0.0.1:${process.env.OPEN_BOTS_ELECTRON_CDP_PORT || DEFAULT_ELECTRON_CDP_PORT}`
  );
}

/** True when the desktop shell (Electron) advertised an in-app browser. */
export function embeddedBrowserAvailable(): boolean {
  return process.env.OPEN_BOTS_EMBEDDED === "1";
}

/** Attended saved sessions stay in visible Chrome from login through task execution. */
export function browserSessionConfig(
  mode: SessionMode,
  options: { headless?: boolean; unattended?: boolean; cdpEndpoint?: string } = {}
): BrowserConfig {
  // Scheduled/unattended runs stay on ephemeral headless Chromium (no Live Browser / no focus).
  if (options.unattended && mode !== "cdp") {
    return defaultBrowserConfig({ headless: options.headless ?? true, guestMode: mode === "guest" });
  }
  if (mode === "embedded") {
    return defaultBrowserConfig({
      headless: false,
      userDataDir: DEFAULT_EMBEDDED_PROFILE_LABEL,
      cdpEndpoint: resolveEmbeddedCdpEndpoint(options.cdpEndpoint),
      embeddedMode: true,
      uiOrigin: process.env.OPEN_BOTS_UI_ORIGIN
    });
  }
  if (mode === "cdp") {
    return defaultBrowserConfig({
      channel: "chrome",
      headless: false,
      userDataDir: DEFAULT_CDP_PROFILE_DIR,
      cdpEndpoint: options.cdpEndpoint || process.env.BROWSER_AGENT_CDP_ENDPOINT || DEFAULT_CDP_ENDPOINT
    });
  }
  if (mode === "guest") {
    return defaultBrowserConfig({ headless: options.headless ?? true, guestMode: true });
  }
  return defaultBrowserConfig({ channel: "chrome", headless: false, userDataDir: DEFAULT_CHROME_PROFILE_DIR });
}

/** Sites that often block Playwright-launched Chrome; prefer Connected Chrome (CDP). */
export function sitePrefersConnectedChrome(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return (
      host.includes("reddit.com") ||
      host.includes("google.com") ||
      host.includes("googleapis.com") ||
      host.includes("accounts.google.") ||
      host.includes("youtube.com") ||
      host.includes("cloudflare.com") ||
      host.includes("medium.com")
    );
  } catch {
    return false;
  }
}

export function accessDeniedRecoveryHint(sessionMode: SessionMode, url: string, signInRejected = false): string {
  if (signInRejected || googleSignInRejected(url)) {
    return "Google rejected sign-in from this browser. This is a browser security restriction, not a CAPTCHA. " +
      "Open the original website in a supported browser and complete sign-in yourself, or use the website’s email sign-in option if available. " +
      (sessionMode === "cdp"
        ? "Connected Chrome is already active; reconnecting does not guarantee Google will accept sign-in. "
        : "Connect Apps → Connect my Chrome can reuse a dedicated Chrome session, but Google may still reject sign-in. ") +
      "A login in your personal browser is not automatically shared with this app. Retry the task only after the site is signed in in the connected browser.";
  }
  if (sessionMode === "cdp") {
    return (
      `The website denied access to ${url}. You are already on Connected Chrome; solve any CAPTCHA in the Live Browser, ` +
      `or use reddit_search / web_search for research instead of scraping. Signing in does not always guarantee automated access.`
    );
  }
  if (sessionMode === "embedded") {
    return (
      `The website denied access to ${url}. The in-app browser was blocked (common for Reddit/Google OAuth). ` +
      `Switch to Connect Apps → Connect my Chrome (external window), then retry. ` +
      `For research, prefer reddit_search or web_search.`
    );
  }
  return (
    `The website denied access to ${url}. This is an access block, not a CAPTCHA to solve. ` +
    `Switch to Connected Chrome (Connect Apps → Connect my Chrome): start Chrome with remote debugging, then retry. ` +
    `Playwright-launched Chrome is often blocked by Reddit/Google. For research, prefer reddit_search or web_search.`
  );
}

/** Pick Electron's Live Browser page — never the Open Bots UI webContents. */
async function pickEmbeddedLivePage(
  browser: Browser,
  uiOrigin?: string
): Promise<{ context: BrowserContext; page: Page }> {
  const pages: Page[] = [];
  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      if (!page.isClosed()) pages.push(page);
    }
  }

  for (const page of pages) {
    try {
      const ua = await page.evaluate(() => navigator.userAgent);
      if (ua.includes(EMBEDDED_UA_MARKER)) {
        return { context: page.context(), page };
      }
    } catch {
      // page may be mid-navigation
    }
  }

  const origin = (uiOrigin || "").replace(/\/$/, "");
  if (origin) {
    for (const page of pages) {
      const url = page.url();
      if (url === origin || url.startsWith(`${origin}/`) || url.startsWith(`${origin}?`)) continue;
      return { context: page.context(), page };
    }
  }

  // Prefer a non-default context when Electron exposes the persist:open-bots partition separately.
  const contexts = browser.contexts();
  const ctx = contexts.length > 1 ? contexts[contexts.length - 1] : contexts[0];
  if (!ctx) {
    throw new BrowserActionError("No browser context available for the in-app browser.");
  }
  const existing = ctx.pages().find((p) => !p.isClosed());
  const page = existing ?? (await ctx.newPage());
  return { context: ctx, page };
}

export interface InteractiveElement {
  domIndex?: number;
  markId: number;
  tag: string;
  role: string;
  elementType: string;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PageState {
  url: string;
  title: string;
  screenshotB64: string;
  elements: InteractiveElement[];
  pageText: string;
  stateHash: string;
  requiresHumanVerification: boolean;
  accessDenied?: boolean;
  signInRejected?: boolean;
  capturedAt: number;
}

export interface BrowserTabInfo {
  index: number;
  title: string;
  url: string;
  active: boolean;
}

interface RawElement {
  domIndex?: number;
  tag?: string;
  elementType?: string;
  role?: string;
  text?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

function computeStateHash(url: string, title: string, interactiveCount: number, textSnippet: string): string {
  return createHash("sha256")
    .update(`${url}|${title}|${interactiveCount}|${textSnippet.slice(0, 400)}`, "utf8")
    .digest("hex")
    .slice(0, 16);
}

/** Normalize common model key spellings while preserving literal character case. */
export function normalizeBrowserKey(key: string): string {
  const aliases: Record<string, string> = {
    end: "End", home: "Home", enter: "Enter", return: "Enter", escape: "Escape", esc: "Escape",
    backspace: "Backspace", delete: "Delete", tab: "Tab", space: "Space",
    arrowup: "ArrowUp", arrowdown: "ArrowDown", arrowleft: "ArrowLeft", arrowright: "ArrowRight",
    pageup: "PageUp", pagedown: "PageDown", ctrl: "Control", control: "Control",
    cmd: "Meta", command: "Meta", meta: "Meta", shift: "Shift", alt: "Alt", option: "Alt"
  };
  return key.trim().split("+").map(part => aliases[part.toLowerCase()] || part).join("+");
}

export class BrowserController {
  private readonly config: BrowserConfig;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  /** Kept for CDP attach so close() can disconnect without killing the user's Chrome. */
  private attachedBrowser: Browser | null = null;
  private cdpSession: CDPSession | null = null;
  private lastScreencastFrame: string | null = null;
  private screencastCallback: ((base64Jpeg: string) => void) | null = null;
  private lastElements: InteractiveElement[] = [];
  private startPromise: Promise<void> | null = null;
  private desktopTargetIds = new WeakMap<Page, string>();

  constructor(config: Partial<BrowserConfig> = {}) {
    this.config = defaultBrowserConfig(config);
  }

  get isGuestMode(): boolean {
    return Boolean(this.config.guestMode);
  }

  get isCdpMode(): boolean {
    return Boolean(this.config.cdpEndpoint) && !this.config.embeddedMode;
  }

  get isEmbeddedMode(): boolean {
    return Boolean(this.config.embeddedMode);
  }

  get sessionMode(): SessionMode {
    if (this.config.embeddedMode) return "embedded";
    if (this.config.cdpEndpoint) return "cdp";
    if (this.config.guestMode) return "guest";
    return "persistent";
  }

  get cdpEndpoint(): string | undefined {
    return this.config.cdpEndpoint;
  }

  get browserName(): "chrome" | "chromium" {
    if (this.config.embeddedMode) return "chromium";
    return this.config.channel ?? "chromium";
  }
  get profileDir(): string { return this.config.userDataDir; }

  /** No-op in embedded mode — never steal OS focus from the user's personal Chrome. */
  async showWindow(): Promise<void> {
    if (this.config.embeddedMode || (this.isCdpMode && managedChromeEnabled())) return;
    const page = await this.ensureActivePage();
    await page.bringToFront();
  }

  private async maybeBringToFront(page: Page): Promise<void> {
    if (this.config.embeddedMode || (this.isCdpMode && managedChromeEnabled())) return;
    await page.bringToFront().catch(() => undefined);
  }

  get viewportSize(): { width: number; height: number } {
    return { width: this.config.viewportWidth, height: this.config.viewportHeight };
  }

  async resizeViewport(width: unknown, height: unknown): Promise<{ width: number; height: number }> {
    const size = browserViewportSize(width, height);
    const page = await this.ensureActivePage();
    if (page.viewportSize()?.width === size.width && page.viewportSize()?.height === size.height) return size;
    await page.setViewportSize(size);
    this.config.viewportWidth = size.width;
    this.config.viewportHeight = size.height;
    this.lastElements = [];
    // Screencast max dimensions were negotiated when the feed started.
    if (this.screencastCallback) await this.startScreencast(this.screencastCallback);
    return size;
  }

  get latestFrame(): string | null {
    return this.lastScreencastFrame;
  }

  get isStarted(): boolean {
    return this.page !== null && !this.page.isClosed();
  }

  currentUrl(): string {
    return this.page ? this.page.url() : "about:blank";
  }

  getElementByMark(markId: number): InteractiveElement | undefined {
    return this.lastElements.find((el) => el.markId === markId);
  }

  async getTabs(): Promise<BrowserTabInfo[]> {
    if (this.config.embeddedMode && desktopBrowserAvailable()) {
      await this.syncEmbeddedPage();
      return (await desktopBrowserRequest()).tabs;
    }
    if (!this.context) return [];
    const pages = this.context.pages().filter((p) => !p.isClosed());
    const tabs: BrowserTabInfo[] = [];
    for (let i = 0; i < pages.length; i += 1) {
      const p = pages[i];
      const title = await p.title().catch(() => "");
      tabs.push({
        index: i,
        title: title || p.url() || "New Tab",
        url: p.url(),
        active: p === this.page
      });
    }
    return tabs;
  }

  async switchTab(index: number): Promise<void> {
    if (this.config.embeddedMode && desktopBrowserAvailable()) {
      await desktopBrowserRequest({ type: "switch_tab", index });
      await this.syncEmbeddedPage();
      return;
    }
    if (!this.context) {
      throw new BrowserActionError("Browser has not been started. Call start() first.");
    }
    const pages = this.context.pages().filter((p) => !p.isClosed());
    if (index < 0 || index >= pages.length) {
      throw new BrowserActionError(`Tab index ${index} is out of range (0–${Math.max(0, pages.length - 1)}).`);
    }
    const target = pages[index];
    if (target === this.page) return;
    this.page = target;
    if (!this.config.embeddedMode) await target.setViewportSize(this.viewportSize);
    await this.maybeBringToFront(target);
    if (this.screencastCallback) {
      await this.startScreencast(this.screencastCallback).catch(() => undefined);
    }
  }

  async newTab(url = "https://www.google.com/"): Promise<void> {
    if (this.config.embeddedMode && desktopBrowserAvailable()) {
      await desktopBrowserRequest({ type: "new_tab", url });
      await this.syncEmbeddedPage();
      return;
    }
    // Compatibility for an older desktop without the workspace broker.
    if (this.config.embeddedMode) {
      await this.navigate(url || "about:blank");
      return;
    }
    if (!this.context) await this.start();
    if (!this.context) {
      throw new BrowserActionError("Failed to open a new tab: browser context is unavailable.");
    }
    const newPage = await this.context.newPage();
    newPage.setDefaultNavigationTimeout(this.config.navigationTimeoutMs);
    await newPage.setViewportSize(this.viewportSize);
    this.page = newPage;
    if (this.screencastCallback) {
      await this.startScreencast(this.screencastCallback).catch(() => undefined);
    }
    if (url && url !== "about:blank") {
      await this.gotoOnPage(newPage, url);
      await this.waitForIdle(undefined, 140);
    }
  }

  async closeTab(index: number): Promise<void> {
    if (this.config.embeddedMode && desktopBrowserAvailable()) {
      await desktopBrowserRequest({ type: "close_tab", index });
      await this.syncEmbeddedPage();
      return;
    }
    if (!this.context) {
      throw new BrowserActionError("Browser has not been started. Call start() first.");
    }
    const pages = this.context.pages().filter((p) => !p.isClosed());
    if (pages.length <= 1) {
      throw new BrowserActionError("Cannot close the last open tab.");
    }
    if (index < 0 || index >= pages.length) {
      throw new BrowserActionError(`Tab index ${index} is out of range (0–${pages.length - 1}).`);
    }
    const target = pages[index];
    const closingActive = target === this.page;
    await target.close().catch(() => undefined);
    const remaining = this.context.pages().filter((p) => !p.isClosed());
    this.page = closingActive ? remaining[remaining.length - 1] ?? null : this.page;
    if (this.page && this.page.isClosed()) {
      this.page = remaining[remaining.length - 1] ?? null;
    }
    if (this.page && this.screencastCallback) {
      await this.startScreencast(this.screencastCallback).catch(() => undefined);
    }
  }

  async start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    const pending = this.startInternal();
    this.startPromise = pending;
    try { await pending; } finally { if (this.startPromise === pending) this.startPromise = null; }
  }

  private async startInternal(): Promise<void> {
    if (this.isStarted) {
      await this.syncEmbeddedPage();
      return;
    }
    try {
      const identity = this.config.userAgent ? { userAgent: this.config.userAgent } : {};
      if (this.config.cdpEndpoint) {
        const endpoint = this.config.cdpEndpoint;
        if (!this.config.embeddedMode && managedChromeEnabled()) {
          await ensureManagedChrome(endpoint, this.config.userDataDir, probeCdpEndpoint);
        }
        const reachable = await probeCdpEndpoint(endpoint);
        if (!reachable) {
          if (this.config.embeddedMode) {
            throw new BrowserActionError(
              `In-app browser CDP is not reachable at ${endpoint}. Restart the desktop app (yarn desktop / yarn desktop:built).`
            );
          }
          const { command } = chromeCdpLaunchCommand(endpoint, this.config.userDataDir);
          throw new BrowserActionError(
            `Connected Chrome is not running at ${endpoint}. Start it once, then retry:\n${command}`
          );
        }
        if (!this.config.embeddedMode) {
          await ensureCdpPageTarget(endpoint);
        }
        const browser = await chromium.connectOverCDP(endpoint);
        this.attachedBrowser = browser;
        if (this.config.embeddedMode) {
          const picked = await pickEmbeddedLivePage(browser, this.config.uiOrigin);
          this.context = picked.context;
          this.page = picked.page;
          await this.syncEmbeddedPage();
        } else {
          this.context = browser.contexts()[0] ?? (await browser.newContext({
            viewport: { width: this.config.viewportWidth, height: this.config.viewportHeight },
            deviceScaleFactor: 1,
            ...identity
          }));
        }
      } else if (this.config.guestMode) {
        const browser = await chromium.launch({ headless: this.config.headless, channel: this.config.channel });
        this.context = await browser.newContext({
          viewport: { width: this.config.viewportWidth, height: this.config.viewportHeight },
          deviceScaleFactor: 1,
          ...identity
        });
      } else {
        mkdirSync(this.config.userDataDir, { recursive: true });
        // Soften automation fingerprints for dedicated Chrome. Best-effort — does not fix Google/Reddit;
        // use Connected Chrome (CDP) for those sites.
        const launchOptions: Parameters<typeof chromium.launchPersistentContext>[1] = {
          channel: this.config.channel,
          headless: this.config.headless,
          viewport: { width: this.config.viewportWidth, height: this.config.viewportHeight },
          deviceScaleFactor: 1,
          ignoreDefaultArgs: this.config.channel === "chrome" ? ["--enable-automation"] : undefined,
          args:
            this.config.channel === "chrome"
              ? ["--disable-blink-features=AutomationControlled"]
              : undefined,
          ...identity
        };
        if (this.config.channel === "chrome") {
          // Chrome owns its profile locks. A second app instance must fail rather than
          // deleting the locks of an open sign-in window.
          this.context = await chromium.launchPersistentContext(this.config.userDataDir, launchOptions);
        } else {
          clearStaleSingletonLock(this.config.userDataDir);
          try {
            this.context = await chromium.launchPersistentContext(this.config.userDataDir, launchOptions);
          } catch {
            clearStaleSingletonLock(this.config.userDataDir);
            this.context = await chromium.launchPersistentContext(this.config.userDataDir, launchOptions);
          }
        }
      }
      const context = this.context;
      if (!context) {
        throw new BrowserActionError("Browser context failed to initialize.");
      }
      context.on("close", () => {
        if (this.context !== context) return;
        this.context = null;
        this.page = null;
        this.cdpSession = null;
        this.lastScreencastFrame = null;
      });
      this.context.setDefaultTimeout(this.config.actionTimeoutMs);
      if (!this.page || this.page.isClosed()) {
        this.page = this.context.pages()[0] ?? (await this.context.newPage());
      }
      if (!this.config.embeddedMode) await this.page.setViewportSize(this.viewportSize);
      this.page.setDefaultNavigationTimeout(this.config.navigationTimeoutMs);
      for (const page of this.context.pages()) this.trackPageClose(page);
      // Automatically adopt popups/new tabs opened by target="_blank" links
      this.context.on("page", (newPage) => {
        newPage.setDefaultNavigationTimeout(this.config.navigationTimeoutMs);
        this.trackPageClose(newPage);
        // In embedded mode keep driving the docked Live Browser page, not a detached CDP page.
        if (this.config.embeddedMode) return;
        this.page = newPage;
        if (this.screencastCallback) {
          void this.startScreencast(this.screencastCallback).catch(() => undefined);
        }
      });
    } catch (err) {
      await this.close();
      if (err instanceof BrowserActionError) throw err;
      const cleanMessage = stripAnsi((err as Error).message || String(err));
      if (this.config.cdpEndpoint) {
        if (this.config.embeddedMode) {
          throw new BrowserActionError(
            `Could not attach to the in-app browser at ${this.config.cdpEndpoint}. ${cleanMessage}`
          );
        }
        const { command } = chromeCdpLaunchCommand(this.config.cdpEndpoint, this.config.userDataDir);
        throw new BrowserActionError(
          `Could not attach to Connected Chrome at ${this.config.cdpEndpoint}. ${cleanMessage}\nStart Chrome with:\n${command}`
        );
      }
      if (this.config.channel === "chrome") {
        throw new BrowserActionError(`Could not open Buddy Bot's Chrome session. Make sure Google Chrome is installed and this profile is not already open in another Buddy Bot instance. ${cleanMessage}`);
      }
      throw new BrowserActionError(`Failed to start the browser: ${cleanMessage}`);
    }
  }

  private trackPageClose(page: Page): void {
    page.on("close", () => {
      if (this.page !== page) return;
      this.page = this.context?.pages().filter(candidate => !candidate.isClosed()).at(-1) ?? null;
      if (this.page && this.screencastCallback) {
        void this.startScreencast(this.screencastCallback).catch(() => undefined);
      }
    });
  }

  async close(): Promise<void> {
    await this.stopScreencast();
    if (this.config.cdpEndpoint && this.attachedBrowser) {
      // Disconnect Playwright from the user's Chrome; do not close their browser windows.
      try {
        await this.attachedBrowser.close();
      } catch {
        // best-effort
      }
      this.attachedBrowser = null;
      this.page = null;
      this.context = null;
      this.lastScreencastFrame = null;
      this.screencastCallback = null;
      return;
    }
    if (this.context !== null) {
      try {
        const browser = this.context.browser();
        await this.context.close();
        if (browser) {
          await browser.close().catch(() => undefined);
        }
      } catch {
        // best-effort cleanup
      }
    }
    this.page = null;
    this.context = null;
    this.attachedBrowser = null;
    this.lastScreencastFrame = null;
    this.screencastCallback = null;
  }

  /**
   * Streams a live JPEG screencast of the page via Chrome DevTools Protocol, so a caller (the
   * web UI) can render the real browser inline instead of opening a separate OS window.
   */
  async startScreencast(onFrame: (base64Jpeg: string) => void): Promise<void> {
    if (this.config.embeddedMode && desktopBrowserAvailable()) return;
    const page = this.requirePage();
    this.screencastCallback = onFrame;
    if (this.cdpSession !== null) {
      await this.stopScreencast();
      this.screencastCallback = onFrame;
    }
    try {
      const session = await page.context().newCDPSession(page);
      this.cdpSession = session;
      session.on("Page.screencastFrame", (payload) => {
        this.lastScreencastFrame = payload.data;
        onFrame(payload.data);
        void session.send("Page.screencastFrameAck", { sessionId: payload.sessionId }).catch(() => undefined);
      });
      await session.send("Page.startScreencast", {
        format: "jpeg",
        quality: 72,
        maxWidth: this.config.viewportWidth,
        maxHeight: this.config.viewportHeight,
        everyNthFrame: 1
      });
    } catch (err) {
      this.cdpSession = null;
      throw new BrowserActionError(`Failed to start screencast: ${(err as Error).message}`);
    }
  }

  async stopScreencast(): Promise<void> {
    if (this.cdpSession === null) {
      return;
    }
    const session = this.cdpSession;
    this.cdpSession = null;
    try {
      await session.send("Page.stopScreencast");
    } catch {
      // best-effort
    }
    try {
      await session.detach();
    } catch {
      // best-effort
    }
  }

  // ---- Remote-control primitives for the embedded live view. These forward raw input from a
  // viewer's click/keyboard events into the real page, for interactive flows like signing in.

  async remoteMouseMove(x: number, y: number): Promise<void> {
    await this.requirePage().mouse.move(x, y);
  }

  async remoteClick(x: number, y: number): Promise<void> {
    await this.requirePage().mouse.click(x, y);
  }

  async remoteType(text: string): Promise<void> {
    if (!text) return;
    await this.requirePage().keyboard.type(text, { delay: 8 });
  }

  async remotePaste(text: string): Promise<void> {
    if (!text) return;
    await this.requirePage().keyboard.insertText(text);
  }

  async remoteKeyPress(key: string): Promise<void> {
    if (!key) return;
    await this.requirePage().keyboard.press(normalizeBrowserKey(key));
  }

  async remoteScroll(x: number, y: number, deltaX: number, deltaY: number): Promise<void> {
    const page = this.requirePage();
    await page.mouse.move(x, y);
    await page.mouse.wheel(deltaX, deltaY);
  }

  async goBack(): Promise<void> {
    const page = await this.ensureActivePage();
    await page.goBack({ waitUntil: "domcontentloaded", timeout: this.config.navigationTimeoutMs }).catch(() => null);
    await this.waitForIdle();
  }

  async goForward(): Promise<void> {
    const page = await this.ensureActivePage();
    await page.goForward({ waitUntil: "domcontentloaded", timeout: this.config.navigationTimeoutMs }).catch(() => null);
    await this.waitForIdle();
  }

  async reload(): Promise<void> {
    const page = await this.ensureActivePage();
    await page.reload({ waitUntil: "domcontentloaded", timeout: this.config.navigationTimeoutMs }).catch(() => null);
    await this.waitForIdle();
  }

  private async syncEmbeddedPage(): Promise<void> {
    if (!this.config.embeddedMode || !this.attachedBrowser || !desktopBrowserAvailable()) return;
    const state = await desktopBrowserRequest();
    if (!state.activeTabId) throw new BrowserActionError("No active desktop browser tab.");
    const targetId = state.tabs.find(tab => tab.id === state.activeTabId)?.targetId;
    if (!targetId) throw new BrowserActionError("Desktop browser target is unavailable.");
    for (const context of this.attachedBrowser.contexts()) {
      for (const page of context.pages()) {
        if (page.isClosed()) continue;
        let pageTargetId = this.desktopTargetIds.get(page);
        if (!pageTargetId) {
          const probe = await context.newCDPSession(page);
          try {
            const result = await probe.send("Target.getTargetInfo");
            pageTargetId = result.targetInfo.targetId;
            this.desktopTargetIds.set(page, pageTargetId);
          } finally { await probe.detach().catch(() => undefined); }
        }
        if (pageTargetId !== targetId) continue;
        if (this.page !== page) this.lastElements = [];
        this.context = context;
        this.page = page;
        return;
      }
    }
    throw new BrowserActionError("The active desktop browser tab is still connecting. Retry shortly.");
  }

  private requirePage(): Page {
    if (this.page === null || this.page.isClosed()) {
      throw new BrowserActionError("Browser has not been started. Call start() first.");
    }
    return this.page;
  }

  /** Prefer a live page; adopt another open tab or create/reconnect one when the active page or window died. */
  private async ensureActivePage(): Promise<Page> {
    await this.syncEmbeddedPage();
    if (this.page && !this.page.isClosed()) {
      return this.page;
    }
    if (!this.context) {
      await this.start();
      return this.requirePage();
    }
    const openPages = this.context.pages().filter((p) => !p.isClosed());
    if (openPages.length > 0) {
      this.page = openPages[openPages.length - 1];
      await this.maybeBringToFront(this.page);
      if (this.screencastCallback) {
        await this.startScreencast(this.screencastCallback).catch(() => undefined);
      }
      return this.page;
    }
    try {
      if (this.config.cdpEndpoint && !this.config.embeddedMode) {
        await ensureCdpPageTarget(this.config.cdpEndpoint);
      }
      const fresh = await this.context.newPage();
      fresh.setDefaultNavigationTimeout(this.config.navigationTimeoutMs);
      this.page = fresh;
      this.trackPageClose(fresh);
      if (this.screencastCallback) {
        await this.startScreencast(this.screencastCallback).catch(() => undefined);
      }
      return fresh;
    } catch {
      // Context or attached Chrome window was closed mid-session; reconnect cleanly.
      const savedCallback = this.screencastCallback;
      await this.close();
      await this.start();
      if (savedCallback) {
        await this.startScreencast(savedCallback).catch(() => undefined);
      }
      return this.requirePage();
    }
  }

  private resolveNavigateUrl(url: string): string {
    const target = url.trim();
    if (!target) {
      throw new BrowserActionError("navigate requires a non-empty url");
    }
    if (target === "about:blank" || target.includes("://")) {
      return target;
    }
    if (target.includes(".") && !target.includes(" ")) {
      return `https://${target}`;
    }
    return `https://www.google.com/search?q=${encodeURIComponent(target)}`;
  }

  private async gotoOnPage(page: Page, resolvedUrl: string): Promise<void> {
    await page.goto(resolvedUrl, { waitUntil: "domcontentloaded", timeout: this.config.navigationTimeoutMs });
  }

  async waitForIdle(timeoutMs?: number, minSettleMs = 0): Promise<void> {
    const page = await this.ensureActivePage();
    try {
      await page.waitForLoadState("domcontentloaded", { timeout: timeoutMs ?? this.config.idleTimeoutMs });
    } catch {
      // best-effort
    }
    if (minSettleMs > 0) {
      await page.waitForTimeout(minSettleMs).catch(() => undefined);
    }
  }

  /**
   * Navigate the active tab. If that tab is closed, stuck, or times out (common on captcha
   * walls), soft-recover by retrying on the primary open page or opening a dedicated new tab.
   */
  async navigate(url: string): Promise<void> {
    const resolved = this.resolveNavigateUrl(url);
    try {
      const page = await this.ensureActivePage();
      await this.gotoOnPage(page, resolved);
    } catch (err) {
      if (this.config.embeddedMode || !isRecoverableNavigationError(err)) {
        // Native tab ownership belongs to the host; never recover onto an arbitrary
        // CDP page (which could be the workspace UI).
        throw new BrowserActionError(`Failed to navigate to ${resolved}: ${(err as Error).message}`);
      }
      try {
        if (!this.context) await this.start();
        const openPages = (this.context?.pages() ?? []).filter((p) => !p.isClosed());
        const primary = openPages[0];
        if (primary && (!this.page || primary !== this.page || this.page.isClosed())) {
          this.page = primary;
          await this.maybeBringToFront(primary);
          if (this.screencastCallback) {
            await this.startScreencast(this.screencastCallback).catch(() => undefined);
          }
          await this.gotoOnPage(primary, resolved);
        } else if (this.context && !this.config.embeddedMode) {
          const dedicated = await this.context.newPage();
          dedicated.setDefaultNavigationTimeout(this.config.navigationTimeoutMs);
          this.page = dedicated;
          if (this.screencastCallback) {
            await this.startScreencast(this.screencastCallback).catch(() => undefined);
          }
          await this.gotoOnPage(dedicated, resolved);
        } else {
          throw err;
        }
      } catch (retryErr) {
        const prefix =
          err instanceof playwrightErrors.TimeoutError || retryErr instanceof playwrightErrors.TimeoutError
            ? "Timed out navigating to"
            : "Failed to navigate to";
        throw new BrowserActionError(`${prefix} ${resolved}: ${(retryErr as Error).message}`);
      }
    }
    await this.waitForIdle(undefined, 140);
  }

  private validateCoords(x: number, y: number): void {
    if (x < 0 || y < 0 || x > this.config.viewportWidth || y > this.config.viewportHeight) {
      throw new BrowserActionError(
        `Coordinates (${x}, ${y}) fall outside the ${this.config.viewportWidth}x${this.config.viewportHeight} viewport.`
      );
    }
  }

  async click(x: number, y: number): Promise<void> {
    const page = await this.ensureActivePage();
    this.validateCoords(x, y);
    try {
      await page.mouse.click(x, y);
    } catch (err) {
      throw new BrowserActionError(`Failed to click at (${x}, ${y}): ${(err as Error).message}`);
    }
    await this.waitForIdle(undefined, 160);
  }

  async clickMark(markId: number): Promise<InteractiveElement> {
    const el = this.getElementByMark(markId);
    if (!el) {
      throw new BrowserActionError(`Mark #${markId} not found in current viewport elements. Check the latest element list.`);
    }
    if (el.domIndex !== undefined) {
      try {
        const page = await this.ensureActivePage();
        const locator = page.locator(INTERACTIVE_SELECTOR).nth(el.domIndex);
        await locator.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => undefined);
        await locator.click({ timeout: this.config.actionTimeoutMs });
        await this.waitForIdle(undefined, 160);
        return el;
      } catch {
        // Fallback to coordinate click if DOM index shifted
      }
    }
    await this.click(el.x, el.y);
    return el;
  }

  /** Native file attachment, including hidden inputs used by custom CMS upload controls. */
  async uploadFile(filePath: string, selector?: string, markId?: number): Promise<void> {
    const page = await this.ensureActivePage();
    const marked = markId === undefined ? undefined : this.getElementByMark(markId);
    if (markId !== undefined && marked?.domIndex === undefined) {
      throw new BrowserActionError(`Upload mark #${markId} is unavailable. Refresh the observation.`);
    }
    const target = marked
      ? page.locator(INTERACTIVE_SELECTOR).nth(marked.domIndex!)
      : page.locator(selector?.trim() || 'input[type="file"]');
    const count = await target.count();
    if (count !== 1) {
      throw new BrowserActionError(`Upload target matched ${count} elements. Specify the exact file input or upload button selector/markId.`);
    }
    const isInput = await target.evaluate(node => node.tagName === "INPUT" && (node as HTMLInputElement).type === "file");
    if (isInput) {
      await target.setInputFiles(filePath, { timeout: this.config.actionTimeoutMs });
    } else {
      const [chooser] = await Promise.all([
        page.waitForEvent("filechooser", { timeout: this.config.actionTimeoutMs }),
        target.click({ timeout: this.config.actionTimeoutMs })
      ]);
      await chooser.setFiles(filePath, { timeout: this.config.actionTimeoutMs });
    }
    await this.waitForIdle(undefined, 160);
  }

  async typeMark(markId: number, text: string, clear = true, pressEnter = false): Promise<InteractiveElement> {
    const el = this.getElementByMark(markId);
    if (!el) {
      throw new BrowserActionError(`Mark #${markId} not found in current viewport elements. Check the latest element list.`);
    }
    if (el.domIndex !== undefined && el.tag === "select") {
      const page = await this.ensureActivePage();
      const field = page.locator(INTERACTIVE_SELECTOR).nth(el.domIndex);
      await field.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => undefined);
      const selectedLabel = await field.evaluate((node, query) => {
        const select = node as HTMLSelectElement;
        const q = String(query ?? "").trim().toLowerCase();
        const options = Array.from(select.options);
        const match =
          options.find((o) => o.value.toLowerCase() === q || (o.text || "").trim().toLowerCase() === q) ||
          options.find((o) => (o.text || "").toLowerCase().includes(q) || o.value.toLowerCase().includes(q));
        if (!match) return null;
        select.value = match.value;
        select.dispatchEvent(new Event("input", { bubbles: true }));
        select.dispatchEvent(new Event("change", { bubbles: true }));
        return (match.text || match.value).trim();
      }, text);
      if (!selectedLabel) {
        await field.selectOption({ label: text }).catch(() => field.selectOption(text));
      }
      await this.waitForIdle(undefined, 120);
      return el;
    }
    if (el.domIndex !== undefined && (el.elementType === "contenteditable" || el.tag === "input" || el.tag === "textarea")) {
      const page = await this.ensureActivePage();
      const field = page.locator(INTERACTIVE_SELECTOR).nth(el.domIndex);
      await field.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => undefined);
      if (el.elementType === "contenteditable" && text.includes("\n")) {
        // Fill the first paragraph to establish a caret in the exact editable block.
        const lines = text.split("\n");
        if (clear) await field.fill(lines[0]);
        else { await field.focus(); await page.keyboard.insertText(lines[0]); }
        for (let i = 1; i < lines.length; i++) {
          await page.keyboard.press("Enter");
          if (lines[i]) await page.keyboard.insertText(lines[i]);
        }
      } else if (clear) await field.fill(text);
      else { await field.focus(); await page.keyboard.insertText(text); }
      if (pressEnter) await field.press("Enter");
      await this.waitForIdle(undefined, pressEnter ? 160 : 40);
    } else {
      await this.typeText(el.x, el.y, text, clear, pressEnter);
    }
    return el;
  }

  async typeText(x: number, y: number, text: string, clear = true, pressEnter = false): Promise<void> {
    const page = await this.ensureActivePage();
    this.validateCoords(x, y);
    try {
      await page.mouse.click(x, y);
      if (clear) {
        const selectAll = process.platform === "darwin" ? "Meta+A" : "Control+A";
        await page.keyboard.press(selectAll);
        await page.keyboard.press("Backspace");
      }
      if (text) {
        await page.keyboard.insertText(text);
      }
      if (pressEnter) {
        await page.keyboard.press("Enter");
      }
    } catch (err) {
      throw new BrowserActionError(`Failed to type at (${x}, ${y}): ${(err as Error).message}`);
    }
    await this.waitForIdle(undefined, pressEnter ? 160 : 40);
  }

  async scroll(direction: "up" | "down", amount = 600): Promise<void> {
    const normalized = direction.trim().toLowerCase();
    if (normalized !== "up" && normalized !== "down") {
      throw new BrowserActionError(`scroll direction must be 'up' or 'down', got '${direction}'`);
    }
    if (amount <= 0) {
      throw new BrowserActionError("scroll amount must be a positive integer");
    }
    const page = await this.ensureActivePage();
    const delta = normalized === "down" ? amount : -amount;
    try {
      await page.mouse.wheel(0, delta);
      await page.waitForTimeout(50);
    } catch (err) {
      throw new BrowserActionError(`Failed to scroll ${normalized}: ${(err as Error).message}`);
    }
  }

  async keyPress(key: string): Promise<void> {
    if (!key || !key.trim()) {
      throw new BrowserActionError("keyPress requires a non-empty key name");
    }
    const page = await this.ensureActivePage();
    try {
      await page.keyboard.press(normalizeBrowserKey(key));
    } catch (err) {
      throw new BrowserActionError(`Failed to press key '${key}': ${(err as Error).message}`);
    }
    await this.waitForIdle();
  }

  async wait(seconds: number): Promise<void> {
    const clamped = Math.max(0.1, Math.min(seconds, 10.0));
    const page = await this.ensureActivePage();
    try {
      await page.waitForTimeout(clamped * 1000);
    } catch (err) {
      throw new BrowserActionError(`Failed to wait: ${(err as Error).message}`);
    }
  }

  /**
   * Extracts structured content (tables, lists, headings, links, or text matching a CSS selector)
   * directly from the live DOM so any agent can scrape, audit, or analyze page data reliably.
   */
  async extractPageData(selector?: string, mode: "text" | "links" | "tables" | "headings" | "html" = "text"): Promise<string> {
    const page = await this.ensureActivePage();
    try {
      return await page.evaluate(
        ({ sel, extractMode }) => {
          const root = sel ? document.querySelector(sel) : document.body;
          if (!root) return `No element found matching selector: ${sel}`;
          if (extractMode === "links") {
            const anchors = Array.from(root.querySelectorAll("a[href]")).slice(0, 50);
            return anchors
              .map((a, i) => {
                const text = (a.textContent || a.getAttribute("aria-label") || "").trim().replace(/\s+/g, " ").slice(0, 70);
                const href = (a as HTMLAnchorElement).href;
                return `${i + 1}. ${text || "[link]"} -> ${href}`;
              })
              .join("\n");
          }
          if (extractMode === "headings") {
            const headings = Array.from(root.querySelectorAll("h1, h2, h3, h4")).slice(0, 45);
            return headings
              .map((h) => `${h.tagName}: ${(h.textContent || "").trim().replace(/\s+/g, " ")}`)
              .join("\n");
          }
          if (extractMode === "tables") {
            const tables = Array.from(root.querySelectorAll("table")).slice(0, 4);
            if (!tables.length) return "No <table> elements found on page.";
            return tables
              .map((t, idx) => {
                const rows = Array.from(t.querySelectorAll("tr")).slice(0, 30);
                const csv = rows
                  .map((r) =>
                    Array.from(r.querySelectorAll("th, td"))
                      .map((c) => (c.textContent || "").trim().replace(/\s+/g, " "))
                      .join(" | ")
                  )
                  .join("\n");
                return `Table ${idx + 1}:\n${csv}`;
              })
              .join("\n\n");
          }
          if (extractMode === "html") {
            return root.innerHTML.slice(0, 3500);
          }
          return ((root as HTMLElement).innerText || root.textContent || "").trim().replace(/\n{3,}/g, "\n\n").slice(0, 3500);
        },
        { sel: selector?.trim() || "", extractMode: mode }
      );
    } catch (err) {
      throw new BrowserActionError(`Failed to extract page data: ${(err as Error).message}`);
    }
  }

  /**
   * Clicks the first visible element on the page matching a text substring, aria-label, or CSS selector.
   * Gives agents a fast, reliable fallback when pixel coordinates are small or shifting.
   */
  async clickBySelectorOrText(target: string): Promise<string> {
    const page = await this.ensureActivePage();
    const query = target.trim();
    if (!query) {
      throw new BrowserActionError("clickBySelectorOrText requires a non-empty target");
    }
    try {
      const clickedLabel = await page.evaluate((q) => {
        const lower = q.toLowerCase();
        // Special handling for "profile" on Instagram/X where the sidebar link only has an <img alt="...'s profile picture">
        if (lower === "profile" || lower === "my profile") {
          const sidebarProfile = Array.from(document.querySelectorAll('a[href]')).find((a) => {
            const rect = a.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0 || rect.left > 280) return false;
            const imgAlt = a.querySelector("img[alt]")?.getAttribute("alt") || "";
            const txt = ((a as HTMLElement).innerText || a.getAttribute("aria-label") || "").trim();
            return /profile picture/i.test(imgAlt) || /^profile$/i.test(txt);
          });
          if (sidebarProfile) {
            (sidebarProfile as HTMLElement).click();
            return (sidebarProfile.getAttribute("href") || "Profile").trim();
          }
        }
        const candidates = Array.from(
          document.querySelectorAll('a, button, input, [role="button"], [role="link"], [role="tab"], [role="menuitem"], span, div')
        );
        for (const el of candidates) {
          const rect = el.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) continue;
          const imgAlt = el.querySelector("img[alt]")?.getAttribute("alt") || "";
          const label = (
            el.getAttribute("aria-label") ||
            el.getAttribute("title") ||
            el.getAttribute("placeholder") ||
            (el as HTMLElement).innerText ||
            imgAlt ||
            ""
          )
            .trim()
            .replace(/\s+/g, " ");
          if (label && label.toLowerCase() === lower) {
            (el as HTMLElement).click();
            return label;
          }
        }
        for (const el of candidates) {
          const rect = el.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) continue;
          const imgAlt = el.querySelector("img[alt]")?.getAttribute("alt") || "";
          const label = (
            el.getAttribute("aria-label") ||
            el.getAttribute("title") ||
            (el as HTMLElement).innerText ||
            imgAlt ||
            ""
          )
            .trim()
            .replace(/\s+/g, " ");
          if (label && label.length < 100 && label.toLowerCase().includes(lower)) {
            (el as HTMLElement).click();
            return label;
          }
        }
        try {
          const selEl = document.querySelector(q) as HTMLElement | null;
          if (selEl) {
            selEl.click();
            return q;
          }
        } catch {
          // ignore invalid CSS selector
        }
        return null;
      }, query);

      if (!clickedLabel) {
        throw new BrowserActionError(`Could not find a visible element matching "${query}".`);
      }
      await this.waitForIdle(undefined, 160);
      return clickedLabel;
    } catch (err) {
      if (err instanceof BrowserActionError) throw err;
      throw new BrowserActionError(`Failed to click "${query}": ${(err as Error).message}`);
    }
  }

  private async captureScreenshot(page: Page): Promise<Buffer> {
    const capture = () => page.screenshot({ type: "jpeg", quality: 55, animations: "disabled" });
    try {
      return await capture();
    } catch (error) {
      if (!/zero.width|0 width|width.*(?:0|zero)|height.*(?:0|zero)/i.test(String(error))) throw error;
      await page.setViewportSize({ width: this.config.viewportWidth || 1280, height: this.config.viewportHeight || 800 });
      return capture();
    }
  }

  async captureState(options: { includeScreenshot?: boolean } = {}): Promise<PageState> {
    const page = await this.ensureActivePage();
    const includeScreenshot = options.includeScreenshot !== false;
    let screenshotB64 = "";
    let url: string;
    let title: string;
    let rawElements: RawElement[];
    let pageText = "";
    let challengeDetected = false;
    try {
      url = page.url();
      const [shotBuf, pageTitle, elementsRes, textRes, challengeRes] = await Promise.all([
        includeScreenshot
          ? this.captureScreenshot(page)
          : Promise.resolve(null as Buffer | null),
        page.title().catch(() => ""),
        page.evaluate(extractInteractiveElements, INTERACTIVE_SELECTOR).catch(() => [] as RawElement[]),
        page.evaluate(extractPageTextSummary).catch(() => ""),
        page.evaluate(detectVerificationChallenge).catch(() => false)
      ]);
      if (shotBuf) {
        screenshotB64 = shotBuf.toString("base64");
        this.lastScreencastFrame = screenshotB64;
      }
      title = pageTitle;
      rawElements = elementsRes;
      pageText = textRes;
      challengeDetected = challengeRes;
    } catch (err) {
      throw new BrowserActionError(`Failed to capture page state: ${(err as Error).message}`);
    }

    const signInRejected = googleSignInRejected(url, title, pageText);
    const accessDenied = signInRejected || pageAccessDenied(title, pageText);
    const requiresHumanVerification = !accessDenied && (titleRequiresHumanVerification(title) || challengeDetected);

    const limited = Array.isArray(rawElements) ? rawElements.slice(0, this.config.maxElements) : [];
    const elements: InteractiveElement[] = limited.map((item, index) => ({
      markId: index + 1,
      domIndex: item.domIndex,
      tag: String(item.tag ?? ""),
      role: String(item.role ?? ""),
      elementType: String(item.elementType ?? ""),
      text: String(item.text ?? ""),
      x: Math.trunc(Number(item.x ?? 0)),
      y: Math.trunc(Number(item.y ?? 0)),
      width: Math.trunc(Number(item.width ?? 0)),
      height: Math.trunc(Number(item.height ?? 0))
    }));
    this.lastElements = elements;

    return {
      url,
      title,
      screenshotB64,
      elements,
      pageText,
      stateHash: computeStateHash(url, title, elements.length, pageText),
      requiresHumanVerification,
      accessDenied,
      signInRejected,
      capturedAt: Date.now()
    };
  }
}
