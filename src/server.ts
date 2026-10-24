/** Local web UI for the browser agent: a chat-style task box with a live step feed. */

import { ensureManagedChrome, managedChromeEnabled } from "./managedChrome";
import { FrameStream } from "./frameStream";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, watch } from "node:fs";
import { IncomingMessage, ServerResponse, createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { OAuth2Client } from "google-auth-library";
import {
  BrowserController,
  PageState,
  SessionMode,
  browserSessionConfig,
  chromeCdpLaunchCommand,
  embeddedBrowserAvailable,
  probeCdpEndpoint,
  resolveEmbeddedCdpEndpoint,
  DEFAULT_CDP_ENDPOINT,
  DEFAULT_CDP_PROFILE_DIR,
  DEFAULT_EMBEDDED_PROFILE_LABEL,
  DEFAULT_ELECTRON_CDP_PORT
} from "./browserController";
import type { InteractionMode, ObserveMode } from "./promptLoop";
import {
  ARTIFACTS_DIR,
  WORKSPACE_ROOT,
  clearTerminalHistory,
  getTerminalHistory,
  runTerminalCommand
} from "./agentTools";
import { artifactContentType, isRunInProgressMessage, resolveLoginDuringRun } from "./apiContract";
import { resolveClaudeCliBinary } from "./claudeCli";
import {
  appendLearning,
  applyApprovalDenial,
  applyLearningKbTool,
  applyRunOutcome,
  applyUserTurnInput,
  botIdFromName,
  distillLearningKb,
  isUserCorrectionOrRule,
  loadLearningKb,
  updateLearningKb,
  type LearningKind
} from "./learningStore";
import { AgentEvent, AgentOrchestrator, AgentResult, DEFAULT_MODEL, requiresInitialBrowserState } from "./promptLoop";
import { ApprovalCategory, assessTaskRisk, redactSecrets } from "./security";
import { TaskApprovalScope, TerminalApprovalDecision } from "./approvalPolicy";
import { nextDailyOccurrence } from "./scheduler";
import { AgentHandoffRequest, TOPICS, localBus } from "./messageBus";
import { MAX_HANDOFF_DEPTH, decideHandoff } from "./handoff";
import {
  LearnModeSession,
  LearnReport,
  LearnRunOutcome,
  renderLearnDocument,
  renderLearnReport
} from "./learnMode";
import { createDefaultVerifier } from "./selfFix";
import { createPatchProposer } from "./patchProposer";
import { FixApprovalGate } from "./fixApproval";
import {
  getUserByGoogleSub,
  mongodbConfigured,
  resolveAuthBackend,
  saveUserBotsAndSettings,
  upsertGoogleUser,
  type BotRosterEntry,
  type UserSettings
} from "./userStore";

const STATIC_DIR = join(__dirname, "..", "static");
const ENV_FILE = join(__dirname, "..", ".env");
const SCHEDULE_FILE = join(__dirname, "..", ".browser-agent-schedules.json");
const USAGE_FILE = join(__dirname, "..", ".browser-agent-usage.json");
/** Per-bot durable learning KB (intents / mistakes / learnings). Local JSON only. */
const LEARNINGS_DIR = join(__dirname, "..", ".browser-agent-learnings");
/** Learn-mode self-play reports and pre-fix file snapshots. */
const LEARN_REPORT_DIR = join(__dirname, "..", ".browser-agent-learn");
/** Repo root: `__dirname` is dist/ in dev and build/ in the production copy, both one level down. */
const REPO_ROOT = join(__dirname, "..");

// Keep local setup dependency-free. Values already provided by the shell always win.
if (existsSync(ENV_FILE)) {
  for (const rawLine of readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    if (process.env[key] !== undefined) continue;
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

const PORT = Number(process.env.BROWSER_AGENT_UI_PORT ?? 8765);
const HOST = process.env.BROWSER_AGENT_UI_HOST ?? "127.0.0.1";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || "";
const GOOGLE_SESSION_COOKIE = "openbots_google_session";
/**
 * Learn mode is on in the production copy (`npm run built` sets this) and off in dev unless asked
 * for, because a learn session rebuilds and re-runs the test suite - that would fight tsc --watch.
 */
const LEARN_MODE_ENABLED = process.env.BROWSER_AGENT_LEARN_MODE === "1";
/** Learn mode may patch its own source. Set to "0" to get findings only. */
const LEARN_SELF_FIX_ENABLED = process.env.BROWSER_AGENT_LEARN_SELF_FIX !== "0";
/**
 * Replay history per run. Events carry base64 screenshots, so an unbounded 500-step run would hold
 * tens of megabytes of JPEG in memory for the whole process lifetime.
 */
const MAX_RETAINED_RUN_EVENTS = 400;
const googleOAuthClient = new OAuth2Client();

function cookieValue(req: IncomingMessage, name: string): string | null {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return null;
  for (const item of cookieHeader.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0 || item.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(item.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

function setGoogleSessionCookie(res: ServerResponse, value: string, maxAge: number): void {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${GOOGLE_SESSION_COOKIE}=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`
  );
}

type VerifiedGoogleUser = {
  id: string;
  name: string;
  email: string;
  picture: string | null;
};

async function verifyGoogleSession(req: IncomingMessage): Promise<VerifiedGoogleUser | null> {
  const credential = cookieValue(req, GOOGLE_SESSION_COOKIE);
  if (!credential || !GOOGLE_CLIENT_ID) return null;
  try {
    const ticket = await googleOAuthClient.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    if (!payload?.sub || !payload.email || payload.email_verified !== true) return null;
    return {
      id: payload.sub,
      name: payload.name ?? "Google user",
      email: payload.email,
      picture: typeof payload.picture === "string" ? payload.picture : null
    };
  } catch {
    return null;
  }
}

function persistenceMeta() {
  return {
    backend: resolveAuthBackend(),
    mongodbConfigured: mongodbConfigured(),
    note:
      resolveAuthBackend() === "mongodb"
        ? "Signed-in data syncs to MongoDB when reachable; otherwise falls back to local files."
        : "Signed-in data persists under .browser-agent-users/ (set MONGODB_URI for Atlas)."
  };
}

function isSameOriginRequest(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (!origin || !host) return false;
  try {
    const originUrl = new URL(origin);
    const forwardedProtocol = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim();
    const expectedProtocol = forwardedProtocol === "https" || Boolean((req.socket as typeof req.socket & { encrypted?: boolean }).encrypted)
      ? "https:"
      : "http:";
    return originUrl.host === host && originUrl.protocol === expectedProtocol;
  } catch {
    return false;
  }
}

/**
 * Dev-only live reload: this tool is explicitly local/single-user, so it's safe to always run
 * this. `buildId` changes on every process start (so a backend restart under `node --watch`
 * triggers a reload) and whenever a static file changes (so frontend-only edits reload too)
 * without needing a build step for the static assets themselves.
 */
let buildId = randomUUID();
const liveReloadClients = new Set<ServerResponse>();

function notifyLiveReload(): void {
  buildId = randomUUID();
  for (const client of liveReloadClients) {
    client.write(`data: ${buildId}\n\n`);
  }
}

if (process.env.BROWSER_AGENT_LIVE_RELOAD === "1") {
  try {
    const watcher = watch(STATIC_DIR, { recursive: true }, () => notifyLiveReload());
    watcher.on("error", (err) => {
      console.warn(`Live reload file watch stopped: ${err.message}`);
      watcher.close();
    });
  } catch (err) {
    console.warn(`Live reload file watch failed to start: ${(err as Error).message}`);
  }
}

/** A minimal async pull-queue used to fan a run's events out over SSE. */
class AsyncQueue<T> {
  private items: T[] = [];
  private waiters: Array<(value: T) => void> = [];

  push(item: T): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(item);
    } else {
      this.items.push(item);
    }
  }

  next(): Promise<T> {
    const item = this.items.shift();
    if (item !== undefined) {
      return Promise.resolve(item);
    }
    return new Promise<T>((resolve) => {
      this.waiters.push(resolve);
    });
  }
}

interface RunState {
  botName: string;
  headless: boolean;
  isRunning: boolean;
  cancelled: boolean;
  nextSequence: number;
  events: SequencedRunEvent[];
  subscribers: Set<AsyncQueue<SequencedRunEvent | null>>;
  resolveVerification: (() => void) | null;
  resolveApproval: ((decision: TerminalApprovalDecision) => void) | null;
  approvalId: string | null;
}

interface SequencedRunEvent {
  sequence: number;
  event: AgentEvent;
}

function publishRunEvent(run: RunState, event: AgentEvent | null): void {
  const sequencedEvent = event ? { sequence: run.nextSequence++, event } : null;
  if (sequencedEvent) {
    run.events.push(sequencedEvent);
    // Trim oldest first. Sequence numbers come from a counter, not the array length, so a
    // reconnecting client's `after=` cursor still lines up after a trim.
    if (run.events.length > MAX_RETAINED_RUN_EVENTS) {
      run.events.splice(0, run.events.length - MAX_RETAINED_RUN_EVENTS);
    }
    localBus.publish(TOPICS.runEvent, { botName: run.botName, event }, { source: run.botName });
  }
  for (const subscriber of run.subscribers) subscriber.push(sequencedEvent);
}

/**
 * The one shared Chromium process against the persistent profile. Only one can exist at a time
 * (the profile directory is locked to a single process), so "conversation" and "login" sessions
 * take turns owning it. A "conversation" session stays open across multiple /api/run calls for
 * the same bot - that's what lets a bot remember it's already on a page between chat messages,
 * instead of every message starting over from a blank tab.
 */
interface BrowserSession {
  kind: "conversation" | "login";
  botKey: string | null;
  controller: BrowserController;
  frameQueue: FrameStream;
  viewportWidth: number;
  viewportHeight: number;
}

interface RunRequestBody {
  sessionMode?: SessionMode;
  task: string;
  botName?: string;
  expertise?: string;
  initialUrl?: string;
  collaborationContext?: string;
  approvedCategories?: ApprovalCategory[];
  /** Opt-in for lower-risk tool approvals. Financial actions always need task-specific approval. */
  autoApprove?: boolean;
  scheduleId?: string;
  scheduleTimeZone?: string;
  headless?: boolean;
  maxSteps?: number;
  maxDurationSeconds?: number;
  model?: string;
  /** chat = text tools only; browse = nav/read; act = full (default). */
  interactionMode?: InteractionMode;
  observeMode?: ObserveMode;
}

interface ScheduledTask {
  id: string;
  botName: string;
  expertise: string;
  task: string;
  nextRunAt: string;
  recurrenceMinutes: number | null;
  recurrenceType?: "interval" | "daily";
  timeZone?: string;
  localTime?: string;
  status: "scheduled" | "queued" | "running" | "completed" | "failed";
  lastResult?: string;
  lastRunAt?: string;
}

let currentRun: RunState | null = null;
/** Set while an orchestrator is still executing, which outlasts `currentRun.isRunning` on a stop. */
let activeRunPromise: Promise<AgentResult> | null = null;
let activeSession: BrowserSession | null = null;
/** Desktop prefers normal Chrome with an in-app live view; native tabs are an advanced option. */
function resolveDefaultSessionMode(): SessionMode {
  return managedChromeEnabled() ? "cdp" : embeddedBrowserAvailable() ? "embedded" : "persistent";
}
let activeSessionMode: SessionMode = resolveDefaultSessionMode();
let schedules: ScheduledTask[] = [];
const scheduleTimers = new Map<string, NodeJS.Timeout>();

interface BotSessionMemory {
  taskApproval: TaskApprovalScope;
  recentSteps: string[];
  lastUrl: string;
  lastTitle: string;
}

const botSessionMemory = new Map<string, BotSessionMemory>();

function getBotSessionMemory(botKey: string): BotSessionMemory {
  let mem = botSessionMemory.get(botKey);
  if (!mem) {
    mem = {
      taskApproval: new TaskApprovalScope(),
      recentSteps: [],
      lastUrl: "",
      lastTitle: ""
    };
    botSessionMemory.set(botKey, mem);
  }
  return mem;
}

/**
 * $ per 1M tokens, verified directly before use (not guessed). Models not listed here (local
 * engine, Ollama, xAI/Grok) still have their token counts tracked, just no cost estimate shown.
 */
const MODEL_PRICING_PER_MILLION: Record<string, { input: number; output: number }> = {
  "gpt-6-luna": { input: 0.1, output: 0.5 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4o": { input: 2.5, output: 10.0 },
  // Anthropic public list prices (approx; usage tracker is best-effort).
  "claude-sonnet-4-5": { input: 3.0, output: 15.0 },
  "claude-haiku-4-5": { input: 1.0, output: 5.0 },
  "claude-opus-4-5": { input: 15.0, output: 75.0 },
  // Image generation: $5/1M text-input tokens, $30/1M image-output tokens (verified before use).
  // Doesn't account for image-input tokens (only relevant for image editing, not implemented).
  "gpt-image-2": { input: 5.0, output: 30.0 }
};

interface ModelUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  calls: number;
}

let usageByModel: Record<string, ModelUsage> = {};
let usageSaveTimer: NodeJS.Timeout | null = null;

function recordUsage(model: string, promptTokens: number, completionTokens: number, totalTokens: number): void {
  const current = usageByModel[model] ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 0 };
  usageByModel[model] = {
    promptTokens: current.promptTokens + promptTokens,
    completionTokens: current.completionTokens + completionTokens,
    totalTokens: current.totalTokens + totalTokens,
    calls: current.calls + 1
  };
  // Debounce the write so a fast sequence of steps doesn't hit disk on every single API call.
  if (usageSaveTimer) clearTimeout(usageSaveTimer);
  usageSaveTimer = setTimeout(() => {
    void writeFile(USAGE_FILE, `${JSON.stringify(usageByModel, null, 2)}\n`, { mode: 0o600 }).catch(() => undefined);
  }, 2000);
}

function usageSnapshot(): {
  byModel: Array<ModelUsage & { model: string; estimatedCostUsd: number | null }>;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  totalEstimatedCostUsd: number;
} {
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalTokens = 0;
  let totalEstimatedCostUsd = 0;
  const byModel = Object.entries(usageByModel).map(([model, usage]) => {
    totalPromptTokens += usage.promptTokens;
    totalCompletionTokens += usage.completionTokens;
    totalTokens += usage.totalTokens;
    const pricing = MODEL_PRICING_PER_MILLION[model];
    const estimatedCostUsd = pricing
      ? (usage.promptTokens / 1_000_000) * pricing.input + (usage.completionTokens / 1_000_000) * pricing.output
      : null;
    if (estimatedCostUsd !== null) totalEstimatedCostUsd += estimatedCostUsd;
    return { model, ...usage, estimatedCostUsd };
  });
  return { byModel, totalPromptTokens, totalCompletionTokens, totalTokens, totalEstimatedCostUsd };
}

try {
  usageByModel = JSON.parse(readFileSync(USAGE_FILE, "utf8")) as Record<string, ModelUsage>;
} catch {
  usageByModel = {};
}

function validateRunRequest(body: unknown): RunRequestBody {
  if (typeof body !== "object" || body === null) {
    throw new Error("Request body must be a JSON object.");
  }
  const record = body as Record<string, unknown>;
  const task = typeof record.task === "string" ? record.task.trim() : "";
  if (!task || task.length > 200_000) {
    throw new Error("task must be a non-empty string of at most 200000 characters.");
  }
  const headless = record.headless === undefined ? true : Boolean(record.headless);
  const maxSteps = record.maxSteps === undefined ? 120 : Number(record.maxSteps);
  if (!Number.isFinite(maxSteps) || maxSteps < 1 || maxSteps > 500) {
    throw new Error("maxSteps must be a number between 1 and 500.");
  }
  const maxDurationSeconds = record.maxDurationSeconds === undefined ? 14_400 : Number(record.maxDurationSeconds);
  if (!Number.isFinite(maxDurationSeconds) || maxDurationSeconds <= 0 || maxDurationSeconds > 86_400) {
    throw new Error("maxDurationSeconds must be a number between 1 and 86400.");
  }
  const model = record.model === undefined ? DEFAULT_MODEL : String(record.model);
  const approvedCategories = Array.isArray(record.approvedCategories)
    ? record.approvedCategories.filter(
        (value): value is ApprovalCategory => value === "financial_transaction" || value === "external_side_effect"
      )
    : [];
  return {
    task,
    sessionMode: parseSessionMode(record.sessionMode),
    interactionMode:
      record.interactionMode === "chat" ||
      record.interactionMode === "browse" ||
      record.interactionMode === "act" ||
      record.interactionMode === "turbo"
        ? record.interactionMode
        : undefined,
    observeMode: record.observeMode === "text" || record.observeMode === "vision" ? record.observeMode : undefined,
    headless,
    maxSteps,
    maxDurationSeconds,
    model,
    botName: typeof record.botName === "string" ? record.botName.slice(0, 120) : undefined,
    expertise: typeof record.expertise === "string" ? record.expertise.slice(0, 500) : undefined,
    initialUrl: typeof record.initialUrl === "string" ? record.initialUrl.trim().slice(0, 1000) : undefined,
    collaborationContext:
      typeof record.collaborationContext === "string" ? record.collaborationContext.slice(0, 10_000) : undefined,
    approvedCategories,
    autoApprove: Boolean(record.autoApprove),
    scheduleId: typeof record.scheduleId === "string" ? record.scheduleId : undefined,
    scheduleTimeZone: typeof record.scheduleTimeZone === "string" ? record.scheduleTimeZone.slice(0, 100) : undefined
  };
}

async function saveSchedules(): Promise<void> {
  await writeFile(SCHEDULE_FILE, `${JSON.stringify(schedules, null, 2)}\n`, { mode: 0o600 });
}

function buildScheduledTask(input: Record<string, unknown>): ScheduledTask {
  const task = typeof input.task === "string" ? input.task.trim() : "";
  const botName = typeof input.botName === "string" ? input.botName.trim().slice(0, 120) : "Scheduled Agent";
  const expertise = typeof input.expertise === "string" ? input.expertise.trim().slice(0, 500) : "general research";
  const recurrenceMinutes = input.recurrenceMinutes == null ? null : Number(input.recurrenceMinutes);
  const recurrenceType: "daily" | "interval" = input.scheduleType === "daily" ? "daily" : "interval";
  const timeZone = typeof input.timeZone === "string" ? input.timeZone : "UTC";
  try { new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date()); }
  catch { throw new Error("Use a valid IANA timezone, such as America/Los_Angeles."); }
  if (input.scheduleType === "interval" && recurrenceMinutes === null) throw new Error("Enter a repeat interval in minutes.");
  if (!task || task.length > 200_000) throw new Error("task is required and must be at most 200000 characters.");
  const risk = assessTaskRisk(task);
  if (risk.blocked || risk.approvalsRequired.length > 0) {
    throw new Error(risk.reason ?? "Scheduled tasks cannot include financial transactions or unapproved external side effects.");
  }
  if ((input.scheduleType === "daily" || recurrenceMinutes !== null) && input.costApproved !== true) {
    throw new Error("Recurring schedules may consume paid model tokens. Ask the user to explicitly approve recurring API usage before creating one.");
  }
  let nextRunAt: Date;
  if (recurrenceType === "daily") {
    const localTime = typeof input.localTime === "string" ? input.localTime : "";
    nextRunAt = nextDailyOccurrence(timeZone, localTime);
    return {
      id: randomUUID(), botName, expertise, task, nextRunAt: nextRunAt.toISOString(),
      recurrenceMinutes: null, recurrenceType, timeZone, localTime, status: "scheduled"
    };
  }
  nextRunAt = new Date(String(input.runAt ?? ""));
  if (!Number.isFinite(nextRunAt.getTime()) || nextRunAt.getTime() <= Date.now()) throw new Error("runAt must be a future date.");
  if (recurrenceMinutes !== null && (!Number.isFinite(recurrenceMinutes) || recurrenceMinutes < 5)) {
    throw new Error("recurrenceMinutes must be at least 5 minutes.");
  }
  return {
    id: randomUUID(), botName, expertise, task, nextRunAt: nextRunAt.toISOString(), recurrenceMinutes,
    recurrenceType: recurrenceMinutes ? "interval" : undefined, timeZone, status: "scheduled"
  };
}

async function persistAndArmSchedule(schedule: ScheduledTask): Promise<void> {
  schedules.push(schedule);
  await saveSchedules();
  armSchedule(schedule);
}

function armSchedule(schedule: ScheduledTask): void {
  const existing = scheduleTimers.get(schedule.id);
  if (existing) clearTimeout(existing);
  const delay = Math.max(0, new Date(schedule.nextRunAt).getTime() - Date.now());
  const timer = setTimeout(() => void executeSchedule(schedule.id), Math.min(delay, 2_147_000_000));
  scheduleTimers.set(schedule.id, timer);
}

async function executeSchedule(id: string): Promise<void> {
  const schedule = schedules.find((item) => item.id === id);
  if (!schedule) return;
  if (new Date(schedule.nextRunAt).getTime() > Date.now() + 1000) {
    armSchedule(schedule);
    return;
  }
  if ((currentRun && currentRun.isRunning) || activeSession?.kind === "login") {
    schedule.status = "queued";
    schedule.nextRunAt = new Date(Date.now() + 60_000).toISOString();
    await saveSchedules();
    armSchedule(schedule);
    return;
  }
  schedule.status = "running";
  schedule.lastRunAt = new Date().toISOString();
  await saveSchedules();
  startRun({
    task: schedule.task,
    botName: schedule.botName,
    expertise: schedule.expertise,
    headless: true,
    maxSteps: 120,
    maxDurationSeconds: 14_400,
    model: DEFAULT_MODEL,
    approvedCategories: [],
    scheduleTimeZone: schedule.timeZone,
    scheduleId: schedule.id
  });
}

try {
  const stored = JSON.parse(readFileSync(SCHEDULE_FILE, "utf8")) as ScheduledTask[];
  schedules = Array.isArray(stored) ? stored : [];
  for (const schedule of schedules) {
    if (schedule.status === "running") schedule.status = "queued";
    if (new Date(schedule.nextRunAt).getTime() < Date.now()) schedule.nextRunAt = new Date(Date.now() + 1000).toISOString();
    armSchedule(schedule);
  }
} catch {
  schedules = [];
}

async function onHumanVerification(run: RunState, _state: PageState): Promise<void> {
  // Even when running headless, our embedded live screencast panel lets the user interact
  // directly with the page and click "I've handled it — resume". Only skip if this is an
  // unattended background schedule run with no UI viewer.
  let checking = false;
  let observedUrl = _state.url;
  const session = activeSession;
  const monitor = setInterval(async () => {
    if (checking || !session || activeSession !== session || !run.resolveVerification) return;
    checking = true;
    try {
      // A challenge can turn into a hard site block or browser sign-in rejection.
      // End that wait so the orchestrator can report the access block accurately.
      const state = await session.controller.captureState({ includeScreenshot: false });
      if (!Boolean(run.resolveVerification) || activeSession !== session) return;
      if (state.url !== observedUrl) {
        observedUrl = state.url;
        publishRunEvent(run, { type: "observe", url: state.url, title: state.title });
      }
      if (state.accessDenied) run.resolveVerification?.();
    } catch {
      // Navigations may invalidate page evaluation; leave explicit Resume available.
    } finally {
      checking = false;
    }
  }, 1500);
  try {
    await new Promise<void>((resolve) => {
      run.resolveVerification = resolve;
    });
  } finally {
    clearInterval(monitor);
    run.resolveVerification = null;
  }
}

/** Pauses a run and waits for an explicit POST /api/approval before a shell command or file
 * write/append is allowed to execute. Only ever wired up for attended (non-scheduled) runs. */
async function onTerminalApproval(run: RunState, approvalId: string): Promise<TerminalApprovalDecision> {
  run.approvalId = approvalId;
  const approved = await new Promise<TerminalApprovalDecision>((resolve) => {
    run.resolveApproval = resolve;
  });
  run.resolveApproval = null;
  run.approvalId = null;
  return approved;
}

function resolvePendingApproval(decision: TerminalApprovalDecision, approvalId: unknown): boolean {
  if (!currentRun || !currentRun.isRunning || !currentRun.resolveApproval || typeof approvalId !== "string" || currentRun.approvalId !== approvalId) {
    return false;
  }
  const resolve = currentRun.resolveApproval;
  currentRun.resolveApproval = null;
  resolve(decision);
  return true;
}

/**
 * Starts a run and resolves with its result. Callers that only want fire-and-forget behaviour can
 * ignore the promise (it never rejects - a crash resolves as an unsuccessful AgentResult), while
 * learn mode needs to await each self-play turn.
 */
function startRun(body: RunRequestBody, options: { handoffDepth?: number } = {}): Promise<AgentResult> {
  if (currentRun && currentRun.isRunning) {
    throw new Error("A run is already in progress. Wait for it to finish or stop it first.");
  }
  // A stopped run reports "stopped" to the UI right away, but the orchestrator takes until its
  // next abort check to actually let go of the browser. Starting a second run in that window would
  // give two agents the same Chromium page.
  if (activeRunPromise) {
    throw new Error("The previous run is still in progress (winding down). Try again in a moment.");
  }
  if (activeSession?.kind === "login") {
    // Seamlessly promote an open login session into the bot's conversation session so the
    // exact page the user just signed into is preserved without closing the browser!
    activeSession.kind = "conversation";
    activeSession.botKey = body.botName?.trim() || "default";
  }

  const botKey = body.botName?.trim() || "default";
  const run: RunState = {
    botName: body.botName?.trim() || "default",
    headless: Boolean(body.headless),
    isRunning: true,
    cancelled: false,
    nextSequence: 1,
    events: [],
    subscribers: new Set<AsyncQueue<SequencedRunEvent | null>>(),
    resolveVerification: null,
    resolveApproval: null,
    approvalId: null
  };
  currentRun = run;
  const handoffDepth = options.handoffDepth ?? 0;
  localBus.publish(
    TOPICS.runStarted,
    { botName: run.botName, task: body.task, handoffDepth, unattended: Boolean(body.scheduleId) },
    { source: run.botName }
  );

  const runPromise = (async (): Promise<AgentResult> => {
    let result: AgentResult = {
      success: false,
      summary: "Run did not produce a result.",
      stepsTaken: 0,
      elapsedSeconds: 0,
      terminationReason: "no_result"
    };
    try {
      // A server restart or mode change must not silently send a Chrome task into Electron.
      if (body.sessionMode) activeSessionMode = body.sessionMode;
      if (activeSession && sessionModeMismatch(activeSession.controller, activeSessionMode)) {
        const old = activeSession;
        activeSession = null;
        old.frameQueue.push(null);
        await old.controller.close().catch(() => undefined);
      }
      const existingUrl = activeSession ? activeSession.controller.currentUrl() : "about:blank";
      const needsBrowserImmediately = requiresInitialBrowserState(body.task, existingUrl);

      if (!activeSession && needsBrowserImmediately) {
        const controller = new BrowserController(
          browserSessionConfig(activeSessionMode, { headless: run.headless, unattended: Boolean(body.scheduleId) })
        );
        await controller.start();
        const viewport = controller.viewportSize;
        const session: BrowserSession = {
          kind: "conversation",
          botKey,
          controller,
          frameQueue: new FrameStream(),
          viewportWidth: viewport.width,
          viewportHeight: viewport.height
        };
        await controller.startScreencast((frame) => session.frameQueue.push(frame));
        activeSession = session;
      } else if (activeSession) {
        activeSession.kind = "conversation";
        activeSession.botKey = botKey;
      }

      // Create a standby controller if starting text-only; if the LLM decides to call a browser tool,
      // AgentOrchestrator will start it on demand.
      const controller = activeSession
        ? activeSession.controller
        : new BrowserController(
            browserSessionConfig(activeSessionMode, { headless: run.headless, unattended: Boolean(body.scheduleId) })
          );

      if (activeSession && needsBrowserImmediately) {
        const currentUrl = controller.currentUrl();
        if ((!currentUrl || currentUrl === "about:blank") && body.initialUrl && body.initialUrl !== "about:blank") {
          await controller.navigate(body.initialUrl).catch(() => undefined);
        }
      }

      const learningBotId = botIdFromName(body.botName || botKey);
      let learningContext = "";
      try {
        const kb = await updateLearningKb(LEARNINGS_DIR, learningBotId, (current) =>
          applyUserTurnInput(current, body.task)
        );
        let mergedKb = kb;
        if (isUserCorrectionOrRule(body.task)) {
          await updateLearningKb(LEARNINGS_DIR, "_workspace", (shared) =>
            applyUserTurnInput(shared, body.task)
          ).catch(() => undefined);
        }
        const sharedKb = await loadLearningKb(LEARNINGS_DIR, "_workspace").catch(() => null);
        if (sharedKb) {
          for (const entry of sharedKb.mistakes) {
            mergedKb = appendLearning(mergedKb, {
              kind: "mistake",
              text: entry.text,
              source: entry.source
            });
          }
          for (const entry of sharedKb.learnings.filter((l) => l.source === "user_correction")) {
            mergedKb = appendLearning(mergedKb, {
              kind: "learning",
              text: entry.text,
              source: entry.source
            });
          }
        }
        learningContext = distillLearningKb(mergedKb);
      } catch (err) {
        console.warn(`Learning KB load failed for ${learningBotId}:`, (err as Error).message);
      }
      const botMem = getBotSessionMemory(botKey);
      const liveBrowserUrl = controller.isStarted ? controller.currentUrl() : botMem.lastUrl;
      const sessionContinuityLines: string[] = [];
      if (liveBrowserUrl && liveBrowserUrl !== "about:blank") {
        sessionContinuityLines.push(
          `ACTIVE BROWSER SESSION STATE: The browser is currently open on ${liveBrowserUrl}${
            botMem.lastTitle ? ` ("${botMem.lastTitle}")` : ""
          }. Do NOT restart navigation from the home/listing page if the screen or form you need is already open.`
        );
      }
      if (botMem.recentSteps.length > 0) {
        sessionContinuityLines.push(
          `RECENTLY EXECUTED STEPS & ARTIFACTS IN THIS SESSION (do not repeat completed work or regenerate images already created):\n` +
            botMem.recentSteps.slice(-12).map((s) => `- ${s}`).join("\n")
        );
      }
      const collaborationContext = [
        body.collaborationContext?.trim() || "",
        sessionContinuityLines.join("\n\n"),
        learningContext
      ]
        .filter(Boolean)
        .join("\n\n");

      const interactionMode: InteractionMode =
        body.interactionMode === "chat" ||
        body.interactionMode === "browse" ||
        body.interactionMode === "act" ||
        body.interactionMode === "turbo"
          ? body.interactionMode
          : "act";
      const observeMode: ObserveMode =
        body.observeMode === "vision" || body.observeMode === "text" ? body.observeMode : "text";
      const effectiveAutoApprove = Boolean(body.autoApprove) || interactionMode === "turbo";

      const orchestrator = new AgentOrchestrator({
        task: body.task,
        botName: body.botName,
        expertise: body.expertise,
        collaborationContext: collaborationContext || undefined,
        browser: controller,
        model: body.model,
        maxSteps: body.maxSteps,
        maxDurationSeconds: body.maxDurationSeconds,
        interactionMode,
        observeMode,
        taskApprovalScope: body.scheduleId ? undefined : botMem.taskApproval,
        onEvent: (event) => {
          if (event.type === "observe") {
            if (typeof event.url === "string" && event.url !== "about:blank") botMem.lastUrl = event.url;
            if (typeof event.title === "string" && event.title) botMem.lastTitle = event.title;
          }
          if (event.type === "step") {
            if (typeof event.url === "string" && event.url !== "about:blank") botMem.lastUrl = event.url;
            if (typeof event.title === "string" && event.title) botMem.lastTitle = event.title;
            const msg = typeof event.message === "string" ? event.message : "";
            const artifact = typeof event.artifactUrl === "string" ? ` [artifact: ${event.artifactUrl}]` : "";
            if (msg) {
              botMem.recentSteps.push(`${msg}${artifact}`);
              if (botMem.recentSteps.length > 24) {
                botMem.recentSteps.splice(0, botMem.recentSteps.length - 24);
              }
            }
          }
          if (event.type === "usage" && typeof event.model === "string") {
            recordUsage(
              event.model,
              Number(event.promptTokens ?? 0),
              Number(event.completionTokens ?? 0),
              Number(event.totalTokens ?? 0)
            );
          }
          // If the standby controller was started mid-run by a tool call, promote it to activeSession
          if (!activeSession && controller.isStarted) {
            const viewport = controller.viewportSize;
            const promoted: BrowserSession = {
              kind: "conversation",
              botKey,
              controller,
              frameQueue: new FrameStream(),
              viewportWidth: viewport.width,
              viewportHeight: viewport.height
            };
            void controller.startScreencast((frame) => promoted.frameQueue.push(frame)).catch(() => undefined);
            activeSession = promoted;
          }
          const safeEvent = { ...event };
          if (typeof safeEvent.summary === "string") safeEvent.summary = redactSecrets(safeEvent.summary);
          // Tells the UI not to start the next hop itself: the bus owns delegation now, and two
          // starts for one handoff would mean two runs fighting over the same browser.
          if (safeEvent.type === "terminal" && safeEvent.delegateTo) safeEvent.handoffOwnedByServer = true;
          publishRunEvent(run, safeEvent);

          // Both of these fire on the same run and used to load/save independently, so whichever
          // saved second overwrote the other's entry. updateLearningKb serializes the pair per bot.
          if (event.type === "privileged_approval_resolved" && event.approved === false) {
            const description = typeof event.description === "string" ? event.description : "privileged action";
            void updateLearningKb(LEARNINGS_DIR, learningBotId, (kb) => applyApprovalDenial(kb, description)).catch(
              (err: Error) => console.warn("Learning KB approval denial save failed:", err.message)
            );
          }

          if (event.type === "terminal") {
            void updateLearningKb(LEARNINGS_DIR, learningBotId, (kb) =>
              applyRunOutcome(kb, {
                task: body.task,
                success: Boolean(event.success),
                summary: String(event.summary ?? ""),
                terminationReason: typeof event.terminationReason === "string" ? event.terminationReason : undefined
              })
            ).catch((err: Error) => console.warn("Learning KB run-outcome save failed:", err.message));
          }

          if (body.scheduleId && event.type === "terminal") {
            const schedule = schedules.find((item) => item.id === body.scheduleId);
            if (schedule) {
              schedule.lastResult = redactSecrets(String(event.summary ?? ""));
              const success = Boolean(event.success);
              if (schedule.recurrenceType === "daily" && schedule.localTime && schedule.timeZone) {
                schedule.status = "scheduled";
                schedule.nextRunAt = nextDailyOccurrence(schedule.timeZone, schedule.localTime).toISOString();
                armSchedule(schedule);
              } else if (schedule.recurrenceMinutes) {
                schedule.status = "scheduled";
                schedule.nextRunAt = new Date(Date.now() + schedule.recurrenceMinutes * 60_000).toISOString();
                armSchedule(schedule);
              } else {
                schedule.status = success ? "completed" : "failed";
              }
              void saveSchedules();
            }
          }
        },
        onHumanVerification: (state) => {
          if (body.scheduleId) return; // Don't block unattended scheduled runs
          return onHumanVerification(run, state);
        },
        // Scheduled/unattended runs never get run_terminal_command or workspace_file write/append
        // at all (filtered out of the model's tool list below) - nobody is present to approve them.
        allowPrivilegedTools: !body.scheduleId,
        allowBrowserInteraction: !body.scheduleId,
        // "Approve for me" or Turbo mode grants standing approval, and never for a scheduled run -
        // nobody is watching those, so they stay research-and-draft only.
        standingApproval: effectiveAutoApprove && !body.scheduleId,
        scheduleTimeZone: body.scheduleTimeZone,
        onScheduleTask: async (input) => {
          try {
            const scheduled = buildScheduledTask({
              ...input,
              botName: body.botName || "Scheduled Agent",
              expertise: body.expertise || "general research",
              timeZone: typeof input.timeZone === "string" ? input.timeZone : body.scheduleTimeZone || "UTC"
            });
            await persistAndArmSchedule(scheduled);
            return {
              ok: true,
              message: `${scheduled.botName} scheduled for ${new Date(scheduled.nextRunAt).toLocaleString("en-US", { timeZone: scheduled.timeZone })}${scheduled.recurrenceType === "daily" ? ` daily (${scheduled.timeZone})` : ""}.`
            };
          } catch (error) {
            return { ok: false, message: (error as Error).message };
          }
        },
        onLearningKb: async (input) => {
          try {
            const action = String(input.action ?? "read") as "read" | "list" | "save";
            const kind = typeof input.kind === "string" ? (input.kind as LearningKind) : undefined;
            const text = typeof input.text === "string" ? input.text : undefined;
            if (action !== "save") {
              const kb = await loadLearningKb(LEARNINGS_DIR, learningBotId);
              return { ok: true, message: applyLearningKbTool(kb, { action, kind, text }).message };
            }
            // Serialized with the run-outcome and approval-denial writes for the same bot.
            let message = "";
            await updateLearningKb(LEARNINGS_DIR, learningBotId, (kb) => {
              const result = applyLearningKbTool(kb, { action, kind, text });
              message = result.message;
              return result.state;
            });
            if (kind === "mistake" && text) {
              await updateLearningKb(LEARNINGS_DIR, "_workspace", (shared) =>
                applyLearningKbTool(shared, { action: "save", kind: "mistake", text }).state
              ).catch(() => undefined);
            }
            return { ok: true, message };
          } catch (error) {
            return { ok: false, message: (error as Error).message };
          }
        },
        onTerminalApproval: body.scheduleId ? undefined : effectiveAutoApprove ? () => true : (details) => onTerminalApproval(run, details.approvalId),
        // "Stop" used to be cosmetic: it told the UI the run had ended while the loop kept calling
        // the model and clicking the page. The orchestrator now polls this before every step.
        shouldAbort: () => run.cancelled
      });
      result = await orchestrator.run();
    } catch (err) {
      result = {
        success: false,
        summary: `Run stopped before completion: ${(err as Error).message}`,
        stepsTaken: 0,
        elapsedSeconds: 0,
        terminationReason: "crash"
      };
      if (!run.cancelled) {
        publishRunEvent(run, {
          type: "terminal",
          success: false,
          summary: result.summary,
          terminationReason: "crash",
          stepsTaken: 0,
          elapsedSeconds: 0
        });
      }
    } finally {
      run.isRunning = false;
      publishRunEvent(run, null);
    }

    return result;
  })();

  activeRunPromise = runPromise;
  // Announce the result only after the run slot is free, so a handoff subscriber can start the
  // next hop immediately instead of bouncing off the "already in progress" guard.
  void runPromise
    .finally(() => {
      if (activeRunPromise === runPromise) activeRunPromise = null;
    })
    .then((result) => {
      localBus.publish(TOPICS.runCompleted, { botName: run.botName, result, handoffDepth }, { source: run.botName });

      // Delegation goes out as a message, not a direct call into another bot. A bus subscriber
      // picks it up, so a handoff now also happens for scheduled runs and survives the UI closing
      // mid-run - both of which silently dropped the handoff when the browser owned it.
      if (result.delegateTo?.targetBotName) {
        localBus.publish<AgentHandoffRequest>(
          TOPICS.handoffRequested,
          {
            fromBot: run.botName,
            toBot: result.delegateTo.targetBotName,
            task: result.delegateTo.task,
            handoffNote: result.delegateTo.handoffNote,
            depth: handoffDepth + 1,
            model: body.model,
            scheduleTimeZone: body.scheduleTimeZone,
            unattended: Boolean(body.scheduleId)
          },
          { source: run.botName }
        );
      }
    })
    .catch(() => undefined);

  return runPromise;
}

/**
 * The only place a handoff turns back into a run. Everything that wants a peer bot to do something
 * publishes on `agent.handoff.requested` and this decides whether it may happen - so the depth cap
 * and the risk gate are enforced once, server-side, instead of in whatever caller had the idea.
 */
localBus.subscribe<AgentHandoffRequest>(TOPICS.handoffRequested, async (message) => {
  const request = message.payload;
  const reject = (reason: string): void => {
    console.warn(`Handoff ${request.fromBot} -> ${request.toBot} rejected: ${reason}`);
    localBus.publish(TOPICS.handoffRejected, { ...request, reason }, { source: "server" });
  };

  const decision = decideHandoff(request, MAX_HANDOFF_DEPTH);
  if (!decision.allowed) {
    reject(decision.reason);
    return;
  }

  try {
    void startRun(
      {
        task: decision.delegatedTask,
        botName: request.toBot,
        collaborationContext: `DELEGATION HANDOFF FROM '${request.fromBot}': ${request.handoffNote || request.task}`,
        approvedCategories: [],
        autoApprove: false,
        model: request.model,
        scheduleTimeZone: request.scheduleTimeZone,
        headless: true,
        maxSteps: 120,
        maxDurationSeconds: 14_400,
        // A delegated run started by a schedule stays unattended: no terminal, no file writes.
        ...(request.unattended ? { scheduleId: `handoff-${randomUUID()}` } : {})
      },
      { handoffDepth: request.depth }
    );
    localBus.publish(TOPICS.handoffQueued, { ...request, queued: true }, { source: "server" });
  } catch (err) {
    reject((err as Error).message);
  }
});

// ---------------------------------------------------------------------------
// Learn mode
// ---------------------------------------------------------------------------

interface ActiveLearnSession {
  sessionId: string;
  task: string;
  startedAt: string;
  promise: Promise<LearnReport>;
}

let activeLearnSession: ActiveLearnSession | null = null;
let lastLearnReport: LearnReport | null = null;
/** Holds a proposed patch set while the user decides. Nothing is written until it says yes. */
const fixApprovalGate = new FixApprovalGate();

// Published from inside the session, so the report is readable the moment a client sees the
// completion event on /api/learn/events - before `session.run()`'s own promise has even resolved.
localBus.subscribe<{ report: LearnReport }>(TOPICS.learnCompleted, (message) => {
  lastLearnReport = message.payload.report;
});

/**
 * One self-play turn: a real run through the real orchestrator, with its event stream captured so
 * the rubric can score what actually happened rather than just the final summary.
 */
async function runLearnTurn(body: RunRequestBody): Promise<LearnRunOutcome> {
  const events: AgentEvent[] = [];
  const unsubscribe = localBus.subscribe<{ botName: string; event: AgentEvent }>(TOPICS.runEvent, (message) => {
    events.push(message.payload.event);
  });
  try {
    const result = await startRun(body);
    // Bus delivery is a microtask, so let the terminal event land before we stop listening.
    await new Promise((resolve) => setImmediate(resolve));
    return {
      summary: result.summary,
      success: result.success,
      stepsTaken: result.stepsTaken,
      elapsedSeconds: result.elapsedSeconds,
      terminationReason: result.terminationReason,
      events
    };
  } finally {
    unsubscribe();
  }
}

function startLearnSession(input: {
  task: string;
  botName?: string;
  expertise?: string;
  model?: string;
  maxRounds?: number;
  allowSelfFix?: boolean;
}): ActiveLearnSession {
  if (!LEARN_MODE_ENABLED) {
    throw new Error("Learn mode is off in this instance. Start the production copy with `npm run built`.");
  }
  if (activeLearnSession) {
    throw new Error("A learn session is already in progress. Wait for it to finish.");
  }
  if (currentRun?.isRunning || activeRunPromise) {
    throw new Error("A run is already in progress. Wait for it to finish or stop it first.");
  }

  const task = input.task.trim();
  const botName = input.botName?.trim() || "Buddy Bot";
  const risk = assessTaskRisk(task);
  if (risk.blocked) {
    throw new Error(risk.reason ?? "This task is blocked.");
  }
  // Self-play means nobody is watching each turn, so a task that could like, follow, post, or pay
  // is not something to rehearse unsupervised. Rehearse the research half instead.
  if (risk.approvalsRequired.length > 0) {
    throw new Error(
      `Learn mode won't rehearse a task that can cause a real side effect (${risk.approvalsRequired.join(", ")}). Give it the research or drafting half of the task instead.`
    );
  }

  const learningBotId = botIdFromName(botName);
  const session = new LearnModeSession({
    task,
    bus: localBus,
    repoRoot: REPO_ROOT,
    reportDir: LEARN_REPORT_DIR,
    maxRounds: input.maxRounds ?? 3,
    allowSelfFix: LEARN_SELF_FIX_ENABLED && input.allowSelfFix !== false,
    verify: createDefaultVerifier(REPO_ROOT),
    proposePatches: createPatchProposer({ repoRoot: REPO_ROOT, model: input.model ?? DEFAULT_MODEL }),
    // Patches are written, documented, and then held here until the user says yes.
    onFixApproval: fixApprovalGate.request,
    runner: ({ message, round, transcript }) => {
      const priorHistory =
        round > 0 && transcript.length > 0
          ? "\n\nPrior self-play turns in this session:\n" +
            transcript
              .map(
                (t) =>
                  `Round ${t.round + 1} User: ${t.userMessage}\nRound ${t.round + 1} Your Reply: ${t.botSummary}`
              )
              .join("\n\n")
          : "";
      return runLearnTurn({
        task: message,
        botName,
        expertise: input.expertise,
        collaborationContext:
          (round === 0
            ? "LEARN MODE: this is a self-play rehearsal. Behave exactly as you would for the real user."
            : "LEARN MODE follow-up: the simulated user is pushing back on your previous answer. Carry forward the exact step/proposal from your prior reply below and execute it.") +
          priorHistory,
        approvedCategories: [],
        autoApprove: false,
        model: input.model,
        headless: true,
        maxSteps: 40,
        maxDurationSeconds: 900
      });
    },
    onLearning: async ({ kind, text }) => {
      await updateLearningKb(LEARNINGS_DIR, learningBotId, (kb) =>
        appendLearning(kb, { kind, text: `learn mode: ${text}`, source: "auto" })
      );
    }
  });

  const promise = session
    .run()
    .then((report) => {
      lastLearnReport = report;
      return report;
    })
    .finally(() => {
      if (activeLearnSession?.sessionId === session.sessionId) activeLearnSession = null;
    });

  activeLearnSession = {
    sessionId: session.sessionId,
    task,
    startedAt: new Date().toISOString(),
    promise
  };
  // The HTTP caller gets the session id immediately; results arrive over /api/events and
  // /api/learn/report. An unhandled rejection here must not take the server down.
  void promise.catch((err: Error) => console.warn(`Learn session failed: ${err.message}`));
  return activeLearnSession;
}

function stopCurrentRun(): boolean {
  if (!currentRun || !currentRun.isRunning) {
    return false;
  }
  const run = currentRun;
  run.cancelled = true;
  if (run.resolveVerification) {
    run.resolveVerification();
  }
  if (run.resolveApproval) {
    run.resolveApproval(false);
  }
  publishRunEvent(run, {
    type: "terminal",
    success: false,
    summary: "Stopped by user.",
    terminationReason: "stopped",
    stepsTaken: 0,
    elapsedSeconds: 0
  });
  run.isRunning = false;
  publishRunEvent(run, null);
  return true;
}

function activeBrowserSession(): BrowserSession | null {
  return activeSession;
}

function parseSessionMode(value: unknown): SessionMode | undefined {
  if (value === "guest" || value === "persistent" || value === "cdp" || value === "embedded") return value;
  return undefined;
}

function profileDirForMode(mode: SessionMode): string {
  if (mode === "guest") return "Ephemeral Guest Context";
  if (mode === "cdp") return DEFAULT_CDP_PROFILE_DIR;
  if (mode === "embedded") return DEFAULT_EMBEDDED_PROFILE_LABEL;
  return activeSession?.controller.profileDir ?? browserSessionConfig(mode).userDataDir;
}

function cdpEndpointForMode(mode: SessionMode): string | null {
  if (mode === "cdp") return process.env.BROWSER_AGENT_CDP_ENDPOINT || DEFAULT_CDP_ENDPOINT;
  if (mode === "embedded") return resolveEmbeddedCdpEndpoint();
  return null;
}

function sessionModeMismatch(controller: BrowserController, mode: SessionMode): boolean {
  return controller.sessionMode !== mode;
}

async function openLoginSession(
  url: string,
  botName?: string,
  requestedMode?: SessionMode
): Promise<{
  viewportWidth: number;
  viewportHeight: number;
  url: string;
  sessionMode: SessionMode;
  tabs: Awaited<ReturnType<BrowserController["getTabs"]>>;
  navigationError: string | null;
}> {
  const targetMode = requestedMode ?? activeSessionMode;
  const modeChanged = Boolean(activeSession && sessionModeMismatch(activeSession.controller, targetMode));

  // During an active task run, never open/replace a second Chromium — reuse the bot's browser
  // so the UI can stream frames without a scary conflict error.
  const loginAction = resolveLoginDuringRun({
    runIsActive: Boolean(currentRun && currentRun.isRunning),
    hasActiveSession: Boolean(activeSession),
    modeChanged
  });
  if (loginAction === "reuse" && activeSession) {
    await activeSession.controller.start();
    await activeSession.controller.showWindow();
    const session = activeSession;
    await session.controller.startScreencast(frame => session.frameQueue.push(frame));
    if (botName) activeSession.botKey = botName.trim();
    let navigationError: string | null = null;
    // Still honor an explicit navigate request on the live bot tab (or soft-recover via new tab).
    if (url && url !== "about:blank") {
      try {
        await activeSession.controller.navigate(url);
      } catch (err) {
        navigationError = (err as Error).message;
      }
    }
    return {
      viewportWidth: activeSession.viewportWidth,
      viewportHeight: activeSession.viewportHeight,
      url: activeSession.controller.currentUrl(),
      sessionMode: activeSessionMode,
      tabs: await activeSession.controller.getTabs(),
      navigationError
    };
  }
  if (loginAction === "busy") {
    const busy = new Error("A task run is in progress. Wait for it to finish or stop it first.") as Error & {
      statusCode?: number;
      code?: string;
    };
    busy.statusCode = 409;
    busy.code = "run_in_progress";
    throw busy;
  }

  if (modeChanged && activeSession) {
    const oldSession = activeSession;
    activeSession = null;
    oldSession.frameQueue.push(null);
    await oldSession.controller.close().catch(() => undefined);
  }
  activeSessionMode = targetMode;

  if (activeSession) {
    await activeSession.controller.start();
    await activeSession.controller.showWindow();
    const session = activeSession;
    await session.controller.startScreencast(frame => session.frameQueue.push(frame));
    activeSession.kind = "login";
    if (botName) activeSession.botKey = botName.trim();
    let navigationError: string | null = null;
    if (url && url !== "about:blank") {
      try {
        await activeSession.controller.navigate(url);
      } catch (err) {
        // Soft path: keep the existing session alive and report the failure so the UI can
        // retry via Go / new tab instead of failing the whole login open silently.
        navigationError = (err as Error).message;
      }
    }
    return {
      viewportWidth: activeSession.viewportWidth,
      viewportHeight: activeSession.viewportHeight,
      url: activeSession.controller.currentUrl(),
      sessionMode: activeSessionMode,
      tabs: await activeSession.controller.getTabs(),
      navigationError
    };
  }
  // Login / CAPTCHA needs a real visible window — screencast-only headless is painful for puzzles.
  const controller = new BrowserController(
    browserSessionConfig(activeSessionMode, { headless: false })
  );
  const { width, height } = controller.viewportSize;
  const session: BrowserSession = {
    kind: "login",
    botKey: botName ? botName.trim() : null,
    controller,
    frameQueue: new FrameStream(),
    viewportWidth: width,
    viewportHeight: height
  };
  activeSession = session;
  try {
    await controller.start();
    await controller.startScreencast((frame) => session.frameQueue.push(frame));
    if (url && url !== "about:blank") {
      await controller.navigate(url);
    }
  } catch (err) {
    activeSession = null;
    await controller.close().catch(() => undefined);
    throw err;
  }
  return {
    viewportWidth: width,
    viewportHeight: height,
    url: controller.currentUrl(),
    sessionMode: activeSessionMode,
    tabs: await controller.getTabs(),
    navigationError: null as string | null
  };
}

async function closeLoginSession(keepBrowserOpen = true): Promise<boolean> {
  if (!activeSession) {
    return false;
  }
  if (keepBrowserOpen) {
    activeSession.kind = "conversation";
    activeSession.botKey = activeSession.botKey || "default";
    return true;
  }
  const session = activeSession;
  activeSession = null;
  session.frameQueue.push(null);
  await session.controller.close();
  return true;
}

function resumeCurrentRun(): boolean {
  if (!currentRun || !currentRun.isRunning || !currentRun.resolveVerification) {
    return false;
  }
  currentRun.resolveVerification();
  return true;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

async function handleEventsStream(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!currentRun) {
    sendJson(res, 404, { detail: "No run has been started yet." });
    return;
  }
  const run = currentRun;
  const requestedSequence = Number(req.headers["last-event-id"] ?? new URL(req.url ?? "/api/events", "http://localhost").searchParams.get("after") ?? 0);
  const afterSequence = Number.isSafeInteger(requestedSequence) && requestedSequence > 0 ? requestedSequence : 0;
  const history = run.events.filter((item) => item.sequence > afterSequence);
  const subscriber = new AsyncQueue<SequencedRunEvent | null>();
  if (run.isRunning) run.subscribers.add(subscriber);
  res.once("close", () => {
    run.subscribers.delete(subscriber);
    subscriber.push(null);
  });
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive"
  });

  for (const event of history) {
    if (res.destroyed) break;
    res.write(`id: ${event.sequence}\ndata: ${JSON.stringify(event.event)}\n\n`);
  }
  if (!run.isRunning || res.destroyed) {
    run.subscribers.delete(subscriber);
    res.end();
    return;
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const item = await subscriber.next();
    if (item === null) {
      break;
    }
    res.write(`id: ${item.sequence}\ndata: ${JSON.stringify(item.event)}\n\n`);
    if (item.event.type === "terminal") {
      break;
    }
  }
  run.subscribers.delete(subscriber);
  res.end();
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "GET" && url.pathname === "/browserRuntime.js") {
    const script = await readFile(join(STATIC_DIR, "browserRuntime.js"), "utf8");
    res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache" });
    res.end(script);
    return;
  }

  if (req.method === "GET" && url.pathname === "/") {
    try {
      const html = await readFile(join(STATIC_DIR, "index.html"), "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } catch {
      sendJson(res, 500, { detail: "Failed to load the UI page." });
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/auth/google/config") {
    const host = req.headers.host || `${HOST}:${PORT}`;
    const forwardedProtocol = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim();
    const protocol = forwardedProtocol === "https" ? "https" : "http";
    const googleEnabled = Boolean(GOOGLE_CLIENT_ID);
    sendJson(res, 200, {
      enabled: googleEnabled,
      googleEnabled,
      clientId: GOOGLE_CLIENT_ID || null,
      /** Exact origin the GIS button needs in Google Cloud Authorized JavaScript origins. */
      authorizedOrigin: `${protocol}://${host}`,
      ...persistenceMeta()
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/google") {
    if (!isSameOriginRequest(req)) {
      sendJson(res, 403, { detail: "Google sign-in requests must come from this app." });
      return;
    }
    if (!GOOGLE_CLIENT_ID) {
      sendJson(res, 503, { detail: "Google sign-in is not configured. Set GOOGLE_CLIENT_ID in .env." });
      return;
    }
    try {
      const body = (await readJsonBody(req)) as Record<string, unknown>;
      const credential = typeof body.credential === "string" ? body.credential : "";
      const nonce = typeof body.nonce === "string" ? body.nonce : "";
      if (!credential || credential.length > 16_000 || !nonce) {
        sendJson(res, 400, { detail: "A valid Google sign-in credential is required." });
        return;
      }

      const ticket = await googleOAuthClient.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
      const payload = ticket.getPayload();
      if (!payload?.sub || !payload.email || payload.email_verified !== true || payload.nonce !== nonce) {
        sendJson(res, 401, { detail: "Google did not return a verified account for this sign-in." });
        return;
      }

      const user = {
        id: payload.sub,
        name: payload.name ?? "Google user",
        email: payload.email,
        picture: typeof payload.picture === "string" ? payload.picture : null
      };
      const { user: stored, backend } = await upsertGoogleUser(REPO_ROOT, {
        googleSub: user.id,
        email: user.email,
        name: user.name,
        picture: user.picture
      });

      const maxAge = Math.max(1, Math.min(3600, (payload.exp ?? 0) - Math.floor(Date.now() / 1000)));
      setGoogleSessionCookie(res, credential, maxAge);
      sendJson(res, 200, {
        authenticated: true,
        user,
        persistence: { ...persistenceMeta(), backend, bots: stored.bots, settings: stored.settings }
      });
    } catch {
      sendJson(res, 401, { detail: "Google sign-in could not be verified. Please try again." });
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/auth/google/session") {
    const user = await verifyGoogleSession(req);
    if (!user) {
      if (cookieValue(req, GOOGLE_SESSION_COOKIE)) setGoogleSessionCookie(res, "", 0);
      sendJson(res, 200, { authenticated: false, ...persistenceMeta() });
      return;
    }
    const { user: stored, backend } = await getUserByGoogleSub(REPO_ROOT, user.id, {
      email: user.email,
      name: user.name,
      picture: user.picture
    });
    sendJson(res, 200, {
      authenticated: true,
      user,
      persistence: {
        ...persistenceMeta(),
        backend,
        bots: stored?.bots ?? [],
        settings: stored?.settings ?? {}
      }
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/google/logout") {
    if (!isSameOriginRequest(req)) {
      sendJson(res, 403, { detail: "Sign-out requests must come from this app." });
      return;
    }
    setGoogleSessionCookie(res, "", 0);
    sendJson(res, 200, { authenticated: false });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/user/data") {
    const user = await verifyGoogleSession(req);
    if (!user) {
      sendJson(res, 401, { detail: "Google sign-in required to load cloud/local persisted data." });
      return;
    }
    const { user: stored, backend } = await getUserByGoogleSub(REPO_ROOT, user.id, {
      email: user.email,
      name: user.name,
      picture: user.picture
    });
    sendJson(res, 200, {
      user,
      bots: stored?.bots ?? [],
      settings: stored?.settings ?? {},
      ...persistenceMeta(),
      backend
    });
    return;
  }

  if (req.method === "PUT" && url.pathname === "/api/user/data") {
    if (!isSameOriginRequest(req)) {
      sendJson(res, 403, { detail: "Persist requests must come from this app." });
      return;
    }
    const user = await verifyGoogleSession(req);
    if (!user) {
      sendJson(res, 401, { detail: "Google sign-in required to save persisted data." });
      return;
    }
    try {
      const body = (await readJsonBody(req)) as Record<string, unknown>;
      const bots = Array.isArray(body.bots)
        ? body.bots.filter((b): b is BotRosterEntry => Boolean(b) && typeof b === "object" && !Array.isArray(b))
        : undefined;
      const settings =
        body.settings && typeof body.settings === "object" && !Array.isArray(body.settings)
          ? (body.settings as UserSettings)
          : undefined;
      if (bots === undefined && settings === undefined) {
        sendJson(res, 400, { detail: "Provide bots and/or settings to save." });
        return;
      }
      if (bots && bots.length > 200) {
        sendJson(res, 400, { detail: "Bot roster is too large (max 200)." });
        return;
      }
      const { user: stored, backend } = await saveUserBotsAndSettings(
        REPO_ROOT,
        user.id,
        { bots, settings },
        { email: user.email, name: user.name, picture: user.picture }
      );
      sendJson(res, 200, {
        ok: true,
        bots: stored.bots,
        settings: stored.settings,
        ...persistenceMeta(),
        backend
      });
    } catch {
      sendJson(res, 500, { detail: "Could not save user data." });
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/status") {
    const tabs = activeSession ? await activeSession.controller.getTabs() : [];
    sendJson(res, 200, {
      ok: true,
      auth: {
        googleEnabled: Boolean(GOOGLE_CLIENT_ID),
        ...persistenceMeta()
      },
      hasApiKey: Boolean(process.env.OPENAI_API_KEY || process.env.XAI_API_KEY || process.env.ANTHROPIC_API_KEY),
      hasOpenAiKey: Boolean(process.env.OPENAI_API_KEY),
      hasAnthropicKey: Boolean(process.env.ANTHROPIC_API_KEY),
      hasXaiKey: Boolean(process.env.XAI_API_KEY),
      hasClaudeCli: Boolean(resolveClaudeCliBinary()),
      claudeCliPath: process.env.CLAUDE_CLI_PATH || resolveClaudeCliBinary(),
      defaultModel: DEFAULT_MODEL,
      isRunning: Boolean(currentRun?.isRunning),
      runBotName: currentRun?.botName ?? null,
      learnModeEnabled: LEARN_MODE_ENABLED,
      learnSelfFixEnabled: LEARN_MODE_ENABLED && LEARN_SELF_FIX_ENABLED,
      learnSessionRunning: Boolean(activeLearnSession),
      learnAwaitingApproval: fixApprovalGate.isWaiting,
      runHasPendingApproval: Boolean(currentRun?.resolveApproval),
      runHasPendingVerification: Boolean(currentRun?.resolveVerification),
      waitingForVerification: Boolean(currentRun?.resolveVerification),
      hasBrowserSession: Boolean(activeSession),
      sessionKind: activeSession?.kind ?? null,
      sessionMode: activeSessionMode,
      defaultSessionMode: resolveDefaultSessionMode(),
      desktopBrowserEngine: managedChromeEnabled() ? "chrome-cdp-v1" : "native-v1",
      embeddedAvailable: embeddedBrowserAvailable(),
      electronCdpPort: embeddedBrowserAvailable()
        ? Number(process.env.OPEN_BOTS_ELECTRON_CDP_PORT) || DEFAULT_ELECTRON_CDP_PORT
        : null,
      currentUrl: activeSession ? activeSession.controller.currentUrl() : null,
      tabs,
      browserName:
        activeSession?.controller.browserName ??
        (activeSessionMode === "guest" || activeSessionMode === "embedded" ? "chromium" : "chrome"),
      profileDir: profileDirForMode(activeSessionMode),
      cdpEndpoint: cdpEndpointForMode(activeSessionMode),
      cdpConnected:
        activeSessionMode === "cdp" || activeSessionMode === "embedded"
          ? Boolean(activeSession?.controller.isStarted)
          : false
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/chrome/cdp") {
    const endpoint = process.env.BROWSER_AGENT_CDP_ENDPOINT || DEFAULT_CDP_ENDPOINT;
    const launch = chromeCdpLaunchCommand(endpoint, DEFAULT_CDP_PROFILE_DIR);
    const reachable = await probeCdpEndpoint(endpoint);
    sendJson(res, 200, {
      endpoint: launch.endpoint,
      profileDir: launch.profileDir,
      command: launch.command,
      port: launch.port,
      reachable,
      sessionMode: activeSessionMode
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/chrome/cdp/connect") {
    try {
      const endpoint = process.env.BROWSER_AGENT_CDP_ENDPOINT || DEFAULT_CDP_ENDPOINT;
      if (managedChromeEnabled()) await ensureManagedChrome(endpoint, DEFAULT_CDP_PROFILE_DIR, probeCdpEndpoint);
      const reachable = await probeCdpEndpoint(endpoint);
      if (!reachable) {
        const launch = chromeCdpLaunchCommand(endpoint, DEFAULT_CDP_PROFILE_DIR);
        sendJson(res, 503, {
          detail: "Chrome with remote debugging is not reachable.",
          command: launch.command,
          endpoint: launch.endpoint,
          profileDir: launch.profileDir
        });
        return;
      }
      activeSessionMode = "cdp";
      if (activeSession && (!currentRun || !currentRun.isRunning)) {
        const old = activeSession;
        activeSession = null;
        old.frameQueue.push(null);
        await old.controller.close().catch(() => undefined);
      }
      const result = await openLoginSession("about:blank", undefined, "cdp");
      sendJson(res, 200, {
        status: "ok",
        sessionMode: result.sessionMode,
        url: result.url,
        tabs: result.tabs,
        endpoint
      });
    } catch (err) {
      const launch = chromeCdpLaunchCommand();
      sendJson(res, 500, {
        detail: (err as Error).message,
        command: launch.command
      });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/session/mode") {
    try {
      const body = (await readJsonBody(req)) as Record<string, unknown>;
      const mode = parseSessionMode(body.mode) ?? resolveDefaultSessionMode();
      const changed = activeSessionMode !== mode;
      activeSessionMode = mode;
      if (changed && activeSession && (!currentRun || !currentRun.isRunning)) {
        const old = activeSession;
        activeSession = null;
        old.frameQueue.push(null);
        await old.controller.close().catch(() => undefined);
      }
      sendJson(res, 200, {
        status: "ok",
        sessionMode: activeSessionMode,
        embeddedAvailable: embeddedBrowserAvailable(),
        ...(mode === "cdp" ? chromeCdpLaunchCommand() : {})
      });
    } catch (err) {
      sendJson(res, 400, { detail: (err as Error).message });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/settings") {
    try {
      const body = (await readJsonBody(req)) as Record<string, unknown>;
      if (typeof body.openaiApiKey === "string" && body.openaiApiKey.trim()) {
        process.env.OPENAI_API_KEY = body.openaiApiKey.trim();
      }
      if (typeof body.xaiApiKey === "string" && body.xaiApiKey.trim()) {
        process.env.XAI_API_KEY = body.xaiApiKey.trim();
      }
      if (typeof body.anthropicApiKey === "string" && body.anthropicApiKey.trim()) {
        process.env.ANTHROPIC_API_KEY = body.anthropicApiKey.trim();
      }
      if (typeof body.baseURL === "string") {
        if (body.baseURL.trim()) process.env.OPENAI_BASE_URL = body.baseURL.trim();
        else delete process.env.OPENAI_BASE_URL;
      }
      sendJson(res, 200, {
        status: "saved",
        hasOpenAiKey: Boolean(process.env.OPENAI_API_KEY),
        hasXaiKey: Boolean(process.env.XAI_API_KEY),
        hasAnthropicKey: Boolean(process.env.ANTHROPIC_API_KEY)
      });
    } catch (err) {
      sendJson(res, 400, { detail: (err as Error).message });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/stop") {
    const stopped = stopCurrentRun();
    sendJson(res, 200, { status: stopped ? "stopped" : "idle" });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/terminal") {
    sendJson(res, 200, {
      ok: true,
      cwd: WORKSPACE_ROOT,
      history: getTerminalHistory()
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/terminal") {
    try {
      const body = (await readJsonBody(req)) as Record<string, unknown>;
      const command = typeof body.command === "string" ? body.command.trim() : "";
      const cwd = typeof body.cwd === "string" ? body.cwd.trim() : undefined;
      if (!command) {
        sendJson(res, 400, { detail: "command is required." });
        return;
      }
      const risk = assessTaskRisk(command);
      if (risk.blocked) {
        sendJson(res, 403, { detail: risk.reason, code: "credential_exposure_blocked" });
        return;
      }
      const entry = await runTerminalCommand(command, cwd, 20_000, "user");
      sendJson(res, 200, { ok: entry.exitCode === 0, entry });
    } catch (err) {
      sendJson(res, 400, { detail: (err as Error).message });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/terminal/clear") {
    clearTerminalHistory();
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/run") {
    try {
      const body = validateRunRequest(await readJsonBody(req));
      const risk = assessTaskRisk(body.task);
      if (risk.blocked) {
        sendJson(res, 403, { detail: risk.reason, code: "credential_exposure_blocked" });
        return;
      }
      const effectiveAutoApprove = Boolean(body.autoApprove) || body.interactionMode === "turbo";
      const missingApprovals = risk.approvalsRequired.filter(
        (category) =>
          !body.approvedCategories?.includes(category) &&
          (category === "financial_transaction" || !effectiveAutoApprove)
      );
      if (missingApprovals.length > 0) {
        sendJson(res, 428, {
          detail: "This task can create an external or financial side effect and needs your approval before it runs.",
          code: "approval_required",
          approvalsRequired: missingApprovals
        });
        return;
      }
      startRun(body);
      sendJson(res, 200, { status: "started" });
    } catch (err) {
      const message = (err as Error).message;
      const alreadyRunning = isRunInProgressMessage(message);
      sendJson(res, alreadyRunning ? 409 : 400, {
        detail: message,
        code: alreadyRunning ? "run_in_progress" : undefined
      });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/learn") {
    try {
      const raw = (await readJsonBody(req)) as Record<string, unknown> | null;
      const task = typeof raw?.task === "string" ? raw.task.trim() : "";
      if (!task || task.length > 20_000) {
        sendJson(res, 400, { detail: "task must be a non-empty string of at most 20000 characters." });
        return;
      }
      const maxRounds = raw?.maxRounds === undefined ? 3 : Number(raw.maxRounds);
      if (!Number.isFinite(maxRounds) || maxRounds < 1 || maxRounds > 5) {
        sendJson(res, 400, { detail: "maxRounds must be a number between 1 and 5." });
        return;
      }
      const session = startLearnSession({
        task,
        botName: typeof raw?.botName === "string" ? raw.botName.slice(0, 120) : undefined,
        expertise: typeof raw?.expertise === "string" ? raw.expertise.slice(0, 500) : undefined,
        model: typeof raw?.model === "string" ? raw.model : undefined,
        maxRounds,
        allowSelfFix: raw?.allowSelfFix !== false
      });
      sendJson(res, 200, {
        status: "started",
        sessionId: session.sessionId,
        selfFix: LEARN_SELF_FIX_ENABLED && raw?.allowSelfFix !== false
      });
    } catch (err) {
      const message = (err as Error).message;
      const busy = isRunInProgressMessage(message) || /already in progress/i.test(message);
      sendJson(res, busy ? 409 : LEARN_MODE_ENABLED ? 400 : 404, {
        detail: message,
        code: busy ? "run_in_progress" : LEARN_MODE_ENABLED ? undefined : "learn_mode_disabled"
      });
    }
    return;
  }

  // What the session wants to change, and nothing has been written yet. Served separately so a
  // reloaded tab can pick the decision back up mid-session.
  if (req.method === "GET" && url.pathname === "/api/learn/proposal") {
    const pending = fixApprovalGate.pendingProposal;
    if (!pending) {
      sendJson(res, 404, { detail: "No code changes are waiting for a decision.", waiting: false });
      return;
    }
    sendJson(res, 200, { waiting: true, proposal: pending });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/learn/approval") {
    if (!fixApprovalGate.isWaiting) {
      sendJson(res, 409, { detail: "No code changes are waiting for a decision.", code: "no_pending_proposal" });
      return;
    }
    try {
      const raw = (await readJsonBody(req)) as Record<string, unknown> | null;
      const approved = raw?.approved === true;
      const patchIds = fixApprovalGate.normalizePatchIds(raw?.patchIds);
      if (approved && patchIds && patchIds.length === 0) {
        sendJson(res, 400, { detail: "None of the given patchIds belong to the pending proposal." });
        return;
      }
      const settled = fixApprovalGate.settle({
        approved,
        ...(patchIds ? { patchIds } : {}),
        reason: typeof raw?.reason === "string" ? raw.reason.slice(0, 500) : approved ? "you approved them" : "you declined"
      });
      if (!settled) {
        sendJson(res, 409, { detail: "That decision arrived too late.", code: "no_pending_proposal" });
        return;
      }
      sendJson(res, 200, { status: approved ? "approved" : "denied", patchIds: patchIds ?? "all" });
    } catch (err) {
      sendJson(res, 400, { detail: (err as Error).message });
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/learn/report") {
    if (!lastLearnReport) {
      sendJson(res, 404, {
        detail: activeLearnSession ? "The learn session is still running." : "No learn session has finished yet.",
        running: Boolean(activeLearnSession)
      });
      return;
    }
    sendJson(res, 200, {
      running: Boolean(activeLearnSession),
      report: lastLearnReport,
      rendered: renderLearnReport(lastLearnReport),
      document: renderLearnDocument(lastLearnReport),
      documentPath: join(LEARN_REPORT_DIR, "latest.md")
    });
    return;
  }

  // Learn progress rides the bus, not a run's event stream: a session spans several runs, so a
  // per-run SSE connection would drop between turns.
  if (req.method === "GET" && url.pathname === "/api/learn/events") {
    if (!LEARN_MODE_ENABLED) {
      sendJson(res, 404, { detail: "Learn mode is off in this instance.", code: "learn_mode_disabled" });
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    });
    const unsubscribe = localBus.subscribe("learn.#", (message) => {
      if (res.destroyed) return;
      res.write(`data: ${JSON.stringify({ topic: message.topic, ...(message.payload as object) })}\n\n`);
    });
    const heartbeat = setInterval(() => {
      if (!res.destroyed) res.write(": keep-alive\n\n");
    }, 15_000);
    res.once("close", () => {
      unsubscribe();
      clearInterval(heartbeat);
    });
    return;
  }

  /**
   * Thumbs up / thumbs down on one agent reply. This is the cheapest signal the bot gets about
   * whether it read the user's intent, so it goes straight into the per-bot learning KB and comes
   * back as context on the next run - a dislike becomes a "mistake", a like becomes a "learning".
   */
  if (req.method === "POST" && url.pathname === "/api/feedback") {
    try {
      const raw = (await readJsonBody(req)) as Record<string, unknown> | null;
      const kind = raw?.kind === "like" ? "like" : raw?.kind === "dislike" ? "dislike" : null;
      if (!kind) {
        sendJson(res, 400, { detail: 'kind must be "like" or "dislike".' });
        return;
      }
      const botName = typeof raw?.botName === "string" && raw.botName.trim() ? raw.botName.slice(0, 120) : "default";
      const summary = typeof raw?.summary === "string" ? raw.summary.slice(0, 400) : "";
      const reason = typeof raw?.reason === "string" ? raw.reason.slice(0, 400).trim() : "";
      if (!summary && !reason) {
        sendJson(res, 400, { detail: "Nothing to record: send the reply text or a reason." });
        return;
      }

      // A dislike with a stated reason is the most useful thing here - keep the reason first so it
      // survives the KB's per-entry truncation.
      const text =
        kind === "like"
          ? `user liked: ${summary}`
          : reason
            ? `user disliked (${reason}): ${summary}`
            : `user disliked: ${summary}`;

      const learningBotId = botIdFromName(botName);
      await updateLearningKb(LEARNINGS_DIR, learningBotId, (kb) =>
        appendLearning(kb, {
          kind: kind === "like" ? "learning" : "mistake",
          text,
          source: "user_correction"
        })
      );
      localBus.publish("feedback.received", { botName, kind, reason }, { source: "ui" });
      sendJson(res, 200, {
        status: "recorded",
        kind,
        message:
          kind === "like"
            ? "Noted — I'll keep doing that."
            : "Noted — I'll avoid that next time."
      });
    } catch (err) {
      sendJson(res, 400, { detail: (err as Error).message });
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/schedules") {
    sendJson(res, 200, { schedules });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/usage") {
    sendJson(res, 200, usageSnapshot());
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/learnings") {
    try {
      const botName = url.searchParams.get("bot") || url.searchParams.get("botName") || "default";
      const botId = botIdFromName(botName);
      const kb = await loadLearningKb(LEARNINGS_DIR, botId);
      const recent = [...kb.mistakes, ...kb.learnings, ...kb.intents, ...kb.hypotheses]
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .slice(-6)
        .reverse();
      sendJson(res, 200, {
        botId,
        niche: kb.niche,
        counts: {
          intents: kb.intents.length,
          mistakes: kb.mistakes.length,
          learnings: kb.learnings.length,
          hypotheses: kb.hypotheses.length
        },
        distilled: distillLearningKb(kb),
        recent,
        updatedAt: kb.updatedAt
      });
    } catch (err) {
      sendJson(res, 400, { detail: (err as Error).message });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/schedules") {
    try {
      const body = (await readJsonBody(req)) as Record<string, unknown>;
      const schedule = buildScheduledTask(body);
      await persistAndArmSchedule(schedule);
      sendJson(res, 201, { schedule });
    } catch (err) {
      sendJson(res, 400, { detail: (err as Error).message });
    }
    return;
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/api/schedules/")) {
    const id = decodeURIComponent(url.pathname.slice("/api/schedules/".length));
    const index = schedules.findIndex((schedule) => schedule.id === id);
    if (index < 0) {
      sendJson(res, 404, { detail: "Schedule not found." });
      return;
    }
    const [removed] = schedules.splice(index, 1);
    const timer = scheduleTimers.get(removed.id);
    if (timer) clearTimeout(timer);
    scheduleTimers.delete(removed.id);
    await saveSchedules();
    sendJson(res, 200, { status: "deleted" });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/livereload") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    });
    res.write(`data: ${buildId}\n\n`);
    liveReloadClients.add(res);
    req.on("close", () => {
      liveReloadClients.delete(res);
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/login") {
    try {
      const body = (await readJsonBody(req)) as Record<string, unknown>;
      const loginUrl = typeof body.url === "string" && body.url.trim() ? body.url.trim() : "about:blank";
      const botName = typeof body.botName === "string" ? body.botName : undefined;
      const requestedMode = parseSessionMode(body.mode);
      const {
        viewportWidth,
        viewportHeight,
        url: currentUrl,
        sessionMode,
        tabs,
        navigationError
      } = await openLoginSession(loginUrl, botName, requestedMode);
      const state = await activeSession?.controller.captureState().catch(() => undefined);
      sendJson(res, 200, {
        status: "opened",
        sessionMode,
        browserName: activeSession?.controller.browserName,
        accessDenied: state?.accessDenied ?? false,
        profileDir: profileDirForMode(sessionMode),
        embeddedAvailable: embeddedBrowserAvailable(),
        viewportWidth,
        viewportHeight,
        url: currentUrl,
        tabs,
        navigationError
      });
    } catch (err) {
      const error = err as Error & { statusCode?: number; code?: string };
      const message = error.message;
      const conflict = error.statusCode === 409 || isRunInProgressMessage(message);
      sendJson(res, conflict ? 409 : 400, {
        detail: message,
        code: error.code || (conflict ? "run_in_progress" : undefined)
      });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/login/close") {
    const body = (await readJsonBody(req).catch(() => ({}))) as Record<string, unknown>;
    const keepOpen = body.keepBrowserOpen !== false;
    await closeLoginSession(keepOpen);
    sendJson(res, 200, { status: "closed", currentUrl: activeSession ? activeSession.controller.currentUrl() : null });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/login/screencast") {
    const session = activeBrowserSession();
    if (!session) {
      sendJson(res, 404, { detail: "No browser session is currently open." });
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    });
    res.flushHeaders();
    const { frames, dispose } = session.frameQueue.subscribe();
    res.once("close", dispose);
    const initialFrame = session.controller.latestFrame;
    if (initialFrame) frames.push(initialFrame);
    try {
      while (!res.destroyed) {
        const frame = await frames.next();
        if (frame === null || res.destroyed) break;
        if (!res.write(`data: ${frame}\n\n`)) {
          // Pause this viewer only; its pending slot keeps replacing stale frames.
          await new Promise<void>(resolve => {
            const done = () => {
              res.off("drain", done);
              res.off("close", done);
              resolve();
            };
            res.once("drain", done);
            res.once("close", done);
            if (res.destroyed) done();
          });
        }
      }
    } finally {
      dispose();
      res.off("close", dispose);
      res.end();
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/login/input") {
    let session = activeBrowserSession();
    if (!session) {
      if (currentRun && currentRun.isRunning) {
        sendJson(res, 409, {
          detail: "A task run is in progress. Wait for it to finish or stop it first.",
          code: "run_in_progress"
        });
        return;
      }
      await openLoginSession("about:blank");
      session = activeBrowserSession();
    }
    if (!session) {
      sendJson(res, 404, { detail: "No browser session is currently open." });
      return;
    }
    const controller = session.controller;
    try {
      const body = (await readJsonBody(req)) as Record<string, unknown>;
      const inputType = String(body.type ?? "");
      switch (inputType) {
        case "resize": {
          const size = await controller.resizeViewport(body.width, body.height);
          session.viewportWidth = size.width;
          session.viewportHeight = size.height;
          break;
        }
        case "navigate": {
          const targetUrl = String(body.url ?? "");
          const useNewTab = Boolean(body.newTab) || body.mode === "new_tab";
          if (useNewTab) {
            await controller.newTab(targetUrl || "https://www.google.com/");
          } else {
            await controller.navigate(targetUrl);
          }
          break;
        }
        case "back":
          await controller.goBack();
          break;
        case "forward":
          await controller.goForward();
          break;
        case "reload":
          await controller.reload();
          break;
        case "new_tab":
          await controller.newTab(typeof body.url === "string" ? body.url : "https://www.google.com/");
          break;
        case "switch_tab":
          await controller.switchTab(Number(body.index ?? 0));
          break;
        case "close_tab":
          await controller.closeTab(Number(body.index ?? 0));
          break;
        case "click":
          await controller.remoteClick(Number(body.x), Number(body.y));
          break;
        case "move":
          await controller.remoteMouseMove(Number(body.x), Number(body.y));
          break;
        case "type":
          await controller.remoteType(String(body.text ?? ""));
          break;
        case "paste":
          await controller.remotePaste(String(body.text ?? ""));
          break;
        case "key":
          await controller.remoteKeyPress(String(body.key ?? ""));
          break;
        case "scroll":
          await controller.remoteScroll(
            Number(body.x),
            Number(body.y),
            Number(body.deltaX ?? 0),
            Number(body.deltaY ?? 0)
          );
          break;
        default:
          sendJson(res, 400, { detail: `Unknown input type '${inputType}'.` });
          return;
      }
      const tabs = await controller.getTabs();
      sendJson(res, 200, { status: "ok", url: controller.currentUrl(), tabs, viewportWidth: controller.viewportSize.width, viewportHeight: controller.viewportSize.height });
    } catch (err) {
      sendJson(res, 400, { detail: (err as Error).message });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/resume") {
    if (resumeCurrentRun()) {
      sendJson(res, 200, { status: "resumed" });
    } else {
      sendJson(res, 409, { detail: "No run is currently waiting for human verification." });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/approval") {
    try {
      const body = (await readJsonBody(req)) as Record<string, unknown>;
      if (typeof body.approved !== "boolean" || (body.scope !== undefined && body.scope !== "once" && body.scope !== "task")) {
        sendJson(res, 400, { detail: "approved must be a boolean; scope must be once or task." });
        return;
      }
      const approved = body.approved;
      if (resolvePendingApproval({ approved, scope: body.scope === "task" ? "task" : "once" }, body.approvalId)) {
        sendJson(res, 200, { status: approved ? "approved" : "denied" });
      } else {
        sendJson(res, 409, { detail: "No command or file write is currently waiting for approval." });
      }
    } catch (err) {
      sendJson(res, 400, { detail: (err as Error).message });
    }
    return;
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/artifacts/")) {
    const filename = decodeURIComponent(url.pathname.slice("/api/artifacts/".length)).replace(/[^a-zA-Z0-9._-]/g, "_");
    try {
      const data = await readFile(join(ARTIFACTS_DIR, filename));
      const { contentType, inline } = artifactContentType(filename);
      const forceDownload =
        url.searchParams.get("download") === "1" || url.searchParams.get("download") === "true";
      const disposition = forceDownload || !inline ? "attachment" : "inline";
      res.writeHead(200, {
        "Content-Type": contentType,
        "Content-Disposition": `${disposition}; filename="${filename}"`,
        "Cache-Control": "private, max-age=3600"
      });
      res.end(data);
    } catch {
      sendJson(res, 404, { detail: "Artifact not found." });
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/events") {
    await handleEventsStream(req, res);
    return;
  }

  sendJson(res, 404, { detail: "Not found." });
}

const server = createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error("Unhandled request error.", err);
    if (!res.headersSent) {
      sendJson(res, 500, { detail: "Internal server error." });
    } else {
      res.end();
    }
  });
});

async function gracefulShutdown(): Promise<void> {
  if (currentRun) {
    currentRun.cancelled = true;
    currentRun.isRunning = false;
    publishRunEvent(currentRun, null);
  }
  if (activeSession) {
    const sess = activeSession;
    activeSession = null;
    sess.frameQueue.push(null);
    await sess.controller.close().catch(() => undefined);
  }
  if (typeof server.closeAllConnections === "function") {
    server.closeAllConnections();
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
}

process.on("SIGTERM", () => void gracefulShutdown());
process.on("SIGINT", () => void gracefulShutdown());

server.listen(PORT, HOST, () => {
  console.log(`Open Bots Server listening on http://${HOST}:${PORT}`);
});
