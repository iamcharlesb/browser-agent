/** Browser operations and state capture, backed by Playwright for Node. */

import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BrowserContext, Page, chromium, errors as playwrightErrors } from "playwright";

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
      (el as HTMLElement).innerText ||
      (el as HTMLInputElement).value ||
      "";
    label = label.trim().replace(/\s+/g, " ").slice(0, 80);
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

const VERIFICATION_TITLE_KEYWORDS = [
  "are you a human",
  "verify you are human",
  "unusual traffic",
  "security check",
  "just a moment",
  "checking your browser",
  "captcha",
  "robot check",
  "attention required",
  "sign in",
  "sign up",
  "log in",
  "login",
  "verify it's you",
  "two-factor",
  "two factor",
  "2fa",
  "one-time code",
  "one time code",
  "verification code"
];

/**
 * Executed inside the page via page.evaluate — must be a real function, see note above.
 * Flags CAPTCHA/bot-check widgets AND generic login/sign-in/MFA forms. The agent never fills
 * these in itself (it has no credentials and must not attempt to); it only uses this signal to
 * pause and hand off to a real human via the human-verification flow.
 */
function detectVerificationChallenge(): boolean {
  const selectors = [
    'iframe[src*="recaptcha"]',
    'iframe[src*="hcaptcha"]',
    'iframe[title*="captcha" i]',
    'div[class*="cf-turnstile"]',
    "div#challenge-form",
    'input[type="password"]',
    'input[autocomplete="one-time-code"]'
  ];
  for (const selector of selectors) {
    if (document.querySelector(selector)) return true;
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
}

export function defaultBrowserConfig(overrides: Partial<BrowserConfig> = {}): BrowserConfig {
  const config: BrowserConfig = {
    viewportWidth: 1280,
    viewportHeight: 800,
    headless: true,
    navigationTimeoutMs: 30_000,
    actionTimeoutMs: 10_000,
    idleTimeoutMs: 4_000,
    maxElements: 50,
    userDataDir: DEFAULT_PROFILE_DIR,
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
  stateHash: string;
  requiresHumanVerification: boolean;
  capturedAt: number;
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

function computeStateHash(url: string, title: string, interactiveCount: number): string {
  return createHash("sha256")
    .update(`${url}|${title}|${interactiveCount}`, "utf8")
    .digest("hex")
    .slice(0, 16);
}

export class BrowserController {
  private readonly config: BrowserConfig;
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  constructor(config: Partial<BrowserConfig> = {}) {
    this.config = defaultBrowserConfig(config);
  }

  async start(): Promise<void> {
    if (this.page !== null) {
      return;
    }
    try {
      mkdirSync(this.config.userDataDir, { recursive: true });
      this.context = await chromium.launchPersistentContext(this.config.userDataDir, {
        headless: this.config.headless,
        viewport: { width: this.config.viewportWidth, height: this.config.viewportHeight },
        deviceScaleFactor: 1,
        userAgent: this.config.userAgent
      });
      this.context.setDefaultTimeout(this.config.actionTimeoutMs);
      this.page = this.context.pages()[0] ?? (await this.context.newPage());
      this.page.setDefaultNavigationTimeout(this.config.navigationTimeoutMs);
    } catch (err) {
      await this.close();
      throw new BrowserActionError(`Failed to start the browser: ${(err as Error).message}`);
    }
  }

  async close(): Promise<void> {
    if (this.context !== null) {
      try {
        await this.context.close();
      } catch {
        // best-effort cleanup
      }
    }
    this.page = null;
    this.context = null;
  }

  private requirePage(): Page {
    if (this.page === null) {
      throw new BrowserActionError("Browser has not been started. Call start() first.");
    }
    return this.page;
  }

  async waitForIdle(timeoutMs?: number): Promise<void> {
    const page = this.requirePage();
    try {
      await page.waitForLoadState("networkidle", { timeout: timeoutMs ?? this.config.idleTimeoutMs });
    } catch {
      // best-effort: many pages never go fully idle (polling, websockets, etc.)
    }
  }

  async navigate(url: string): Promise<void> {
    const page = this.requirePage();
    const target = url.trim();
    if (!target) {
      throw new BrowserActionError("navigate requires a non-empty url");
    }
    const resolved = target.includes("://") ? target : `https://${target}`;
    try {
      await page.goto(resolved, { waitUntil: "domcontentloaded", timeout: this.config.navigationTimeoutMs });
    } catch (err) {
      const prefix = err instanceof playwrightErrors.TimeoutError ? "Timed out navigating to" : "Failed to navigate to";
      throw new BrowserActionError(`${prefix} ${resolved}: ${(err as Error).message}`);
    }
    await this.waitForIdle();
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
    await this.waitForIdle();
  }

  async typeText(x: number, y: number, text: string, clear = true): Promise<void> {
    const page = this.requirePage();
    this.validateCoords(x, y);
    try {
      await page.mouse.click(x, y);
      if (clear) {
        await page.keyboard.press("Control+A");
        await page.keyboard.press("Backspace");
      }
      if (text) {
        await page.keyboard.type(text, { delay: 15 });
      }
    } catch (err) {
      throw new BrowserActionError(`Failed to type at (${x}, ${y}): ${(err as Error).message}`);
    }
    await this.waitForIdle();
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
      await page.waitForTimeout(150);
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

  async captureState(): Promise<PageState> {
    const page = this.requirePage();
    let screenshotBuffer: Buffer;
    let url: string;
    let title: string;
    let rawElements: RawElement[];
    try {
      screenshotBuffer = await page.screenshot({ type: "png" });
      url = page.url();
      title = await page.title();
      rawElements = await page.evaluate(extractInteractiveElements, INTERACTIVE_SELECTOR);
    } catch (err) {
      throw new BrowserActionError(`Failed to capture page state: ${(err as Error).message}`);
    }

    let requiresHumanVerification = VERIFICATION_TITLE_KEYWORDS.some((keyword) =>
      title.toLowerCase().includes(keyword)
    );
    if (!requiresHumanVerification) {
      try {
        requiresHumanVerification = await page.evaluate(detectVerificationChallenge);
      } catch {
        requiresHumanVerification = false;
      }
    }

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

    return {
      url,
      title,
      screenshotB64: screenshotBuffer.toString("base64"),
      elements,
      stateHash: computeStateHash(url, title, elements.length),
      requiresHumanVerification,
      capturedAt: Date.now()
    };
  }
}
