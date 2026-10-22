/** Browser operations and state capture, backed by Playwright for Node. */

import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BrowserContext, CDPSession, Page, chromium, errors as playwrightErrors } from "playwright";

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

const INTERACTIVE_SELECTOR =
  'a[href], button, input, select, textarea, ' +
  '[role="button"], [role="link"], [role="checkbox"], [role="radio"], ' +
  '[role="tab"], [role="menuitem"], [role="combobox"], [role="switch"], ' +
  '[onclick], [contenteditable="true"]';

/** Executed inside the page via page.evaluate — must be a real function, not a string, so
 * Playwright's Node binding actually invokes it with the given argument. */
function extractInteractiveElements(selector: string): RawElement[] {
  const nodes = Array.from(document.querySelectorAll(selector));
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const results: RawElement[] = [];
  for (const el of nodes) {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (rect.bottom < 0 || rect.top > vh || rect.right < 0 || rect.left > vw) continue;
    const style = window.getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") continue;
    if (parseFloat(style.opacity || "1") === 0) continue;
    const cx = Math.round(rect.left + rect.width / 2);
    const cy = Math.round(rect.top + rect.height / 2);
    let label: string =
      el.getAttribute("aria-label") ||
      el.getAttribute("placeholder") ||
      el.getAttribute("title") ||
      el.getAttribute("alt") ||
      (el as HTMLElement).innerText ||
      (el as HTMLInputElement).value ||
      "";
    if (!label) {
      const img = el.querySelector("img[alt]");
      if (img) label = img.getAttribute("alt") || "";
    }
    if (!label) {
      const svgTitle = el.querySelector("svg title, svg[aria-label]");
      if (svgTitle) label = svgTitle.getAttribute("aria-label") || svgTitle.textContent || "";
    }
    const href = el.getAttribute("href") || "";
    label = label.trim().replace(/\s+/g, " ").slice(0, 90);
    if (href && !href.startsWith("javascript:") && href !== "#" && label.length < 60) {
      const shortHref = href.length > 45 ? href.slice(0, 42) + "..." : href;
      label = label ? `${label} -> ${shortHref}` : shortHref;
    }
    results.push({
      tag: el.tagName.toLowerCase(),
      elementType: el.getAttribute("type") || "",
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
  /** Persistent on-disk Chromium profile directory. Same directory across runs = same cookies,
   * local storage, and signed-in sessions, so logins and MFA only have to happen once. */
  userDataDir: string;
  /** When true, launches an isolated ephemeral Guest browser context without saving cookies/sessions to disk. */
  guestMode?: boolean;
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

export interface InteractiveElement {
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
  capturedAt: number;
}

export interface BrowserTabInfo {
  index: number;
  title: string;
  url: string;
  active: boolean;
}

interface RawElement {
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

export class BrowserController {
  private readonly config: BrowserConfig;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private cdpSession: CDPSession | null = null;
  private lastScreencastFrame: string | null = null;
  private screencastCallback: ((base64Jpeg: string) => void) | null = null;
  private lastElements: InteractiveElement[] = [];

  constructor(config: Partial<BrowserConfig> = {}) {
    this.config = defaultBrowserConfig(config);
  }

  get isGuestMode(): boolean {
    return Boolean(this.config.guestMode);
  }

  get viewportSize(): { width: number; height: number } {
    return { width: this.config.viewportWidth, height: this.config.viewportHeight };
  }

  get latestFrame(): string | null {
    return this.lastScreencastFrame;
  }

  get isStarted(): boolean {
    return this.page !== null;
  }

  currentUrl(): string {
    return this.page ? this.page.url() : "about:blank";
  }

  getElementByMark(markId: number): InteractiveElement | undefined {
    return this.lastElements.find((el) => el.markId === markId);
  }

  async getTabs(): Promise<BrowserTabInfo[]> {
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
    await target.bringToFront().catch(() => undefined);
    if (this.screencastCallback) {
      await this.startScreencast(this.screencastCallback).catch(() => undefined);
    }
  }

  async newTab(url = "https://www.google.com/"): Promise<void> {
    if (!this.context) await this.start();
    if (!this.context) {
      throw new BrowserActionError("Failed to open a new tab: browser context is unavailable.");
    }
    const newPage = await this.context.newPage();
    newPage.setDefaultNavigationTimeout(this.config.navigationTimeoutMs);
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
    if (this.page !== null) {
      return;
    }
    try {
      const ua =
        this.config.userAgent ??
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
      if (this.config.guestMode) {
        const browser = await chromium.launch({ headless: this.config.headless });
        this.context = await browser.newContext({
          viewport: { width: this.config.viewportWidth, height: this.config.viewportHeight },
          deviceScaleFactor: 1,
          userAgent: ua
        });
      } else {
        mkdirSync(this.config.userDataDir, { recursive: true });
        clearStaleSingletonLock(this.config.userDataDir);
        const launchOptions = {
          headless: this.config.headless,
          viewport: { width: this.config.viewportWidth, height: this.config.viewportHeight },
          deviceScaleFactor: 1,
          userAgent: ua
        };
        try {
          this.context = await chromium.launchPersistentContext(this.config.userDataDir, launchOptions);
        } catch (launchErr) {
          // A lock can be recreated by the dying process between our cleanup and the launch
          // attempt itself; one clear-and-retry resolves that window without masking a real,
          // persistent failure (e.g. a genuinely different process actually using this profile).
          clearStaleSingletonLock(this.config.userDataDir);
          this.context = await chromium.launchPersistentContext(this.config.userDataDir, launchOptions);
        }
      }
      this.context.setDefaultTimeout(this.config.actionTimeoutMs);
      this.page = this.context.pages()[0] ?? (await this.context.newPage());
      this.page.setDefaultNavigationTimeout(this.config.navigationTimeoutMs);
      // Automatically adopt popups/new tabs opened by target="_blank" links
      this.context.on("page", (newPage) => {
        newPage.setDefaultNavigationTimeout(this.config.navigationTimeoutMs);
        this.page = newPage;
        if (this.screencastCallback) {
          void this.startScreencast(this.screencastCallback).catch(() => undefined);
        }
      });
    } catch (err) {
      await this.close();
      throw new BrowserActionError(`Failed to start the browser: ${(err as Error).message}`);
    }
  }

  async close(): Promise<void> {
    await this.stopScreencast();
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
    this.lastScreencastFrame = null;
    this.screencastCallback = null;
  }

  /**
   * Streams a live JPEG screencast of the page via Chrome DevTools Protocol, so a caller (the
   * web UI) can render the real browser inline instead of opening a separate OS window.
   */
  async startScreencast(onFrame: (base64Jpeg: string) => void): Promise<void> {
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
    await this.requirePage().keyboard.press(key);
  }

  async remoteScroll(x: number, y: number, deltaX: number, deltaY: number): Promise<void> {
    const page = this.requirePage();
    await page.mouse.move(x, y);
    await page.mouse.wheel(deltaX, deltaY);
  }

  async goBack(): Promise<void> {
    const page = this.requirePage();
    await page.goBack({ waitUntil: "domcontentloaded", timeout: this.config.navigationTimeoutMs }).catch(() => null);
    await this.waitForIdle();
  }

  async goForward(): Promise<void> {
    const page = this.requirePage();
    await page.goForward({ waitUntil: "domcontentloaded", timeout: this.config.navigationTimeoutMs }).catch(() => null);
    await this.waitForIdle();
  }

  async reload(): Promise<void> {
    const page = this.requirePage();
    await page.reload({ waitUntil: "domcontentloaded", timeout: this.config.navigationTimeoutMs }).catch(() => null);
    await this.waitForIdle();
  }

  private requirePage(): Page {
    if (this.page === null || this.page.isClosed()) {
      throw new BrowserActionError("Browser has not been started. Call start() first.");
    }
    return this.page;
  }

  /** Prefer a live page; adopt another open tab or create one when the active page died. */
  private async ensureActivePage(): Promise<Page> {
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
      await this.page.bringToFront().catch(() => undefined);
      if (this.screencastCallback) {
        await this.startScreencast(this.screencastCallback).catch(() => undefined);
      }
      return this.page;
    }
    const fresh = await this.context.newPage();
    fresh.setDefaultNavigationTimeout(this.config.navigationTimeoutMs);
    this.page = fresh;
    if (this.screencastCallback) {
      await this.startScreencast(this.screencastCallback).catch(() => undefined);
    }
    return fresh;
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
      if (!isRecoverableNavigationError(err)) {
        throw new BrowserActionError(`Failed to navigate to ${resolved}: ${(err as Error).message}`);
      }
      try {
        if (!this.context) await this.start();
        const openPages = (this.context?.pages() ?? []).filter((p) => !p.isClosed());
        const primary = openPages[0];
        if (primary && (!this.page || primary !== this.page || this.page.isClosed())) {
          this.page = primary;
          await primary.bringToFront().catch(() => undefined);
          if (this.screencastCallback) {
            await this.startScreencast(this.screencastCallback).catch(() => undefined);
          }
          await this.gotoOnPage(primary, resolved);
        } else if (this.context) {
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
    const page = this.requirePage();
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
    await this.click(el.x, el.y);
    return el;
  }

  async typeMark(markId: number, text: string, clear = true, pressEnter = false): Promise<InteractiveElement> {
    const el = this.getElementByMark(markId);
    if (!el) {
      throw new BrowserActionError(`Mark #${markId} not found in current viewport elements. Check the latest element list.`);
    }
    await this.typeText(el.x, el.y, text, clear, pressEnter);
    return el;
  }

  async typeText(x: number, y: number, text: string, clear = true, pressEnter = false): Promise<void> {
    const page = this.requirePage();
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
    const page = this.requirePage();
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
    const page = this.requirePage();
    try {
      await page.keyboard.press(key.trim());
    } catch (err) {
      throw new BrowserActionError(`Failed to press key '${key}': ${(err as Error).message}`);
    }
    await this.waitForIdle();
  }

  async wait(seconds: number): Promise<void> {
    const clamped = Math.max(0.1, Math.min(seconds, 10.0));
    const page = this.requirePage();
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
    const page = this.requirePage();
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
    const page = this.requirePage();
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

  async captureState(): Promise<PageState> {
    const page = this.requirePage();
    let screenshotBuffer: Buffer;
    let url: string;
    let title: string;
    let rawElements: RawElement[];
    let pageText = "";
    let challengeDetected = false;
    try {
      url = page.url();
      const [shotBuf, pageTitle, elementsRes, textRes, challengeRes] = await Promise.all([
        page.screenshot({ type: "jpeg", quality: 55, animations: "disabled" }),
        page.title().catch(() => ""),
        page.evaluate(extractInteractiveElements, INTERACTIVE_SELECTOR).catch(() => [] as RawElement[]),
        page.evaluate(extractPageTextSummary).catch(() => ""),
        page.evaluate(detectVerificationChallenge).catch(() => false)
      ]);
      screenshotBuffer = shotBuf;
      this.lastScreencastFrame = screenshotBuffer.toString("base64");
      title = pageTitle;
      rawElements = elementsRes;
      pageText = textRes;
      challengeDetected = challengeRes;
    } catch (err) {
      throw new BrowserActionError(`Failed to capture page state: ${(err as Error).message}`);
    }

    const requiresHumanVerification = titleRequiresHumanVerification(title) || challengeDetected;

    const limited = Array.isArray(rawElements) ? rawElements.slice(0, this.config.maxElements) : [];
    const elements: InteractiveElement[] = limited.map((item, index) => ({
      markId: index + 1,
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
      screenshotB64: this.lastScreencastFrame,
      elements,
      pageText,
      stateHash: computeStateHash(url, title, elements.length, pageText),
      requiresHumanVerification,
      capturedAt: Date.now()
    };
  }
}
