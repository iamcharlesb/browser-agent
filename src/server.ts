/** Local web UI for the browser agent: a chat-style task box with a live step feed. */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, watch } from "node:fs";
import { IncomingMessage, ServerResponse, createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BrowserController, DEFAULT_PROFILE_DIR, PageState, defaultBrowserConfig } from "./browserController";
import { ARTIFACTS_DIR } from "./agentTools";
import { AgentEvent, AgentOrchestrator, DEFAULT_MODEL, requiresInitialBrowserState } from "./promptLoop";
import { ApprovalCategory, assessTaskRisk, redactSecrets } from "./security";

const STATIC_DIR = join(__dirname, "..", "static");
const ENV_FILE = join(__dirname, "..", ".env");
const SCHEDULE_FILE = join(__dirname, "..", ".browser-agent-schedules.json");

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

try {
  watch(STATIC_DIR, { recursive: true }, () => notifyLiveReload());
} catch (err) {
  console.warn(`Live reload file watch failed to start: ${(err as Error).message}`);
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
  headless: boolean;
  isRunning: boolean;
  cancelled: boolean;
  queue: AsyncQueue<AgentEvent | null>;
  resolveVerification: (() => void) | null;
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
  frameQueue: AsyncQueue<string | null>;
  viewportWidth: number;
  viewportHeight: number;
}

interface RunRequestBody {
  task: string;
  botName?: string;
  expertise?: string;
  initialUrl?: string;
  collaborationContext?: string;
  approvedCategories?: ApprovalCategory[];
  scheduleId?: string;
  headless?: boolean;
  maxSteps?: number;
  maxDurationSeconds?: number;
  model?: string;
}

interface ScheduledTask {
  id: string;
  botName: string;
  expertise: string;
  task: string;
  nextRunAt: string;
  recurrenceMinutes: number | null;
  status: "scheduled" | "queued" | "running" | "completed" | "failed";
  lastResult?: string;
  lastRunAt?: string;
}

let currentRun: RunState | null = null;
let activeSession: BrowserSession | null = null;
let activeSessionMode: "persistent" | "guest" = "persistent";
let schedules: ScheduledTask[] = [];
const scheduleTimers = new Map<string, NodeJS.Timeout>();

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
    scheduleId: typeof record.scheduleId === "string" ? record.scheduleId : undefined
  };
}

async function saveSchedules(): Promise<void> {
  await writeFile(SCHEDULE_FILE, `${JSON.stringify(schedules, null, 2)}\n`, { mode: 0o600 });
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
  await new Promise<void>((resolve) => {
    run.resolveVerification = resolve;
  });
  run.resolveVerification = null;
}

function startRun(body: RunRequestBody): void {
  if (currentRun && currentRun.isRunning) {
    throw new Error("A run is already in progress. Wait for it to finish or stop it first.");
  }
  if (activeSession?.kind === "login") {
    // Seamlessly promote an open login session into the bot's conversation session so the
    // exact page the user just signed into is preserved without closing the browser!
    activeSession.kind = "conversation";
    activeSession.botKey = body.botName?.trim() || "default";
  }

  const botKey = body.botName?.trim() || "default";
  const run: RunState = {
    headless: Boolean(body.headless),
    isRunning: true,
    cancelled: false,
    queue: new AsyncQueue<AgentEvent | null>(),
    resolveVerification: null
  };
  currentRun = run;

  void (async () => {
    try {
      const existingUrl = activeSession ? activeSession.controller.currentUrl() : "about:blank";
      const needsBrowserImmediately = requiresInitialBrowserState(body.task, existingUrl);

      if (!activeSession && needsBrowserImmediately) {
        const controller = new BrowserController(
          defaultBrowserConfig({ headless: run.headless, guestMode: activeSessionMode === "guest" })
        );
        await controller.start();
        const viewport = controller.viewportSize;
        const session: BrowserSession = {
          kind: "conversation",
          botKey,
          controller,
          frameQueue: new AsyncQueue<string | null>(),
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
            defaultBrowserConfig({ headless: run.headless, guestMode: activeSessionMode === "guest" })
          );

      if (activeSession && needsBrowserImmediately) {
        const currentUrl = controller.currentUrl();
        if ((!currentUrl || currentUrl === "about:blank") && body.initialUrl && body.initialUrl !== "about:blank") {
          await controller.navigate(body.initialUrl).catch(() => undefined);
        }
      }

      const orchestrator = new AgentOrchestrator({
        task: body.task,
        botName: body.botName,
        expertise: body.expertise,
        collaborationContext: body.collaborationContext,
        browser: controller,
        model: body.model,
        maxSteps: body.maxSteps,
        maxDurationSeconds: body.maxDurationSeconds,
        onEvent: (event) => {
          // If the standby controller was started mid-run by a tool call, promote it to activeSession
          if (!activeSession && controller.isStarted) {
            const viewport = controller.viewportSize;
            const promoted: BrowserSession = {
              kind: "conversation",
              botKey,
              controller,
              frameQueue: new AsyncQueue<string | null>(),
              viewportWidth: viewport.width,
              viewportHeight: viewport.height
            };
            void controller.startScreencast((frame) => promoted.frameQueue.push(frame)).catch(() => undefined);
            activeSession = promoted;
          }
          const safeEvent = { ...event };
          if (typeof safeEvent.summary === "string") safeEvent.summary = redactSecrets(safeEvent.summary);
          run.queue.push(safeEvent);
          if (body.scheduleId && event.type === "terminal") {
            const schedule = schedules.find((item) => item.id === body.scheduleId);
            if (schedule) {
              schedule.lastResult = redactSecrets(String(event.summary ?? ""));
              const success = Boolean(event.success);
              if (schedule.recurrenceMinutes) {
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
        }
      });
      await orchestrator.run();
    } catch (err) {
      if (!run.cancelled) {
        run.queue.push({
          type: "terminal",
          success: false,
          summary: `Run stopped before completion: ${(err as Error).message}`,
          terminationReason: "crash",
          stepsTaken: 0,
          elapsedSeconds: 0
        });
      }
    } finally {
      run.isRunning = false;
      run.queue.push(null);
    }
  })();
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
  run.queue.push({
    type: "terminal",
    success: false,
    summary: "Stopped by user.",
    terminationReason: "stopped",
    stepsTaken: 0,
    elapsedSeconds: 0
  });
  run.isRunning = false;
  run.queue.push(null);
  return true;
}

function activeBrowserSession(): BrowserSession | null {
  return activeSession;
}

async function openLoginSession(
  url: string,
  botName?: string,
  requestedMode?: "persistent" | "guest"
): Promise<{ viewportWidth: number; viewportHeight: number; url: string; sessionMode: "persistent" | "guest" }> {
  if (currentRun && currentRun.isRunning) {
    throw new Error("A task run is in progress. Wait for it to finish or stop it first.");
  }
  const targetMode = requestedMode ?? activeSessionMode;
  const modeChanged = activeSession && activeSession.controller.isGuestMode !== (targetMode === "guest");
  if (modeChanged && activeSession) {
    const oldSession = activeSession;
    activeSession = null;
    oldSession.frameQueue.push(null);
    await oldSession.controller.close().catch(() => undefined);
  }
  activeSessionMode = targetMode;

  if (activeSession) {
    activeSession.kind = "login";
    if (botName) activeSession.botKey = botName.trim();
    if (url && url !== "about:blank") {
      await activeSession.controller.navigate(url).catch(() => undefined);
    }
    return {
      viewportWidth: activeSession.viewportWidth,
      viewportHeight: activeSession.viewportHeight,
      url: activeSession.controller.currentUrl(),
      sessionMode: activeSessionMode
    };
  }
  const controller = new BrowserController(
    defaultBrowserConfig({ headless: true, guestMode: activeSessionMode === "guest" })
  );
  const { width, height } = controller.viewportSize;
  const session: BrowserSession = {
    kind: "login",
    botKey: botName ? botName.trim() : null,
    controller,
    frameQueue: new AsyncQueue<string | null>(),
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
    sessionMode: activeSessionMode
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

async function handleEventsStream(res: ServerResponse): Promise<void> {
  if (!currentRun) {
    sendJson(res, 404, { detail: "No run has been started yet." });
    return;
  }
  const run = currentRun;
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive"
  });

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const event = await run.queue.next();
    if (event === null) {
      break;
    }
    res.write(`data: ${JSON.stringify(event)}\n\n`);
    if (event.type === "terminal") {
      break;
    }
  }
  res.end();
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

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

  if (req.method === "GET" && url.pathname === "/api/status") {
    const tabs = activeSession ? await activeSession.controller.getTabs() : [];
    sendJson(res, 200, {
      ok: true,
      hasApiKey: Boolean(process.env.OPENAI_API_KEY || process.env.XAI_API_KEY),
      hasOpenAiKey: Boolean(process.env.OPENAI_API_KEY),
      hasXaiKey: Boolean(process.env.XAI_API_KEY),
      defaultModel: DEFAULT_MODEL,
      isRunning: Boolean(currentRun?.isRunning),
      waitingForVerification: Boolean(currentRun?.resolveVerification),
      hasBrowserSession: Boolean(activeSession),
      sessionKind: activeSession?.kind ?? null,
      sessionMode: activeSessionMode,
      currentUrl: activeSession ? activeSession.controller.currentUrl() : null,
      tabs,
      profileDir: activeSessionMode === "guest" ? "Ephemeral Guest Context" : DEFAULT_PROFILE_DIR
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/session/mode") {
    try {
      const body = (await readJsonBody(req)) as Record<string, unknown>;
      const mode: "persistent" | "guest" = body.mode === "guest" ? "guest" : "persistent";
      const changed = activeSessionMode !== mode;
      activeSessionMode = mode;
      if (changed && activeSession && (!currentRun || !currentRun.isRunning)) {
        const old = activeSession;
        activeSession = null;
        old.frameQueue.push(null);
        await old.controller.close().catch(() => undefined);
      }
      sendJson(res, 200, { status: "ok", sessionMode: activeSessionMode });
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
      if (typeof body.baseURL === "string") {
        if (body.baseURL.trim()) process.env.OPENAI_BASE_URL = body.baseURL.trim();
        else delete process.env.OPENAI_BASE_URL;
      }
      sendJson(res, 200, {
        status: "saved",
        hasOpenAiKey: Boolean(process.env.OPENAI_API_KEY),
        hasXaiKey: Boolean(process.env.XAI_API_KEY)
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

  if (req.method === "POST" && url.pathname === "/api/run") {
    if (!process.env.OPENAI_API_KEY && !process.env.XAI_API_KEY) {
      sendJson(res, 400, { detail: "No API key is set. Click Settings in the header to configure your OpenAI or xAI Grok key." });
      return;
    }
    try {
      const body = validateRunRequest(await readJsonBody(req));
      const risk = assessTaskRisk(body.task);
      if (risk.blocked) {
        sendJson(res, 403, { detail: risk.reason, code: "credential_exposure_blocked" });
        return;
      }
      const missingApprovals = risk.approvalsRequired.filter(
        (category) => !body.approvedCategories?.includes(category)
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
      const alreadyRunning = message.includes("already in progress");
      sendJson(res, alreadyRunning ? 409 : 400, { detail: message });
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/schedules") {
    sendJson(res, 200, { schedules });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/schedules") {
    try {
      const body = (await readJsonBody(req)) as Record<string, unknown>;
      const task = typeof body.task === "string" ? body.task.trim() : "";
      const botName = typeof body.botName === "string" ? body.botName.trim().slice(0, 120) : "Scheduled Agent";
      const expertise = typeof body.expertise === "string" ? body.expertise.trim().slice(0, 500) : "general research";
      const runAt = new Date(String(body.runAt ?? ""));
      const recurrenceMinutes = body.recurrenceMinutes == null ? null : Number(body.recurrenceMinutes);
      if (!task || task.length > 200_000) throw new Error("task is required and must be at most 200000 characters.");
      if (!Number.isFinite(runAt.getTime()) || runAt.getTime() <= Date.now()) throw new Error("runAt must be a future date.");
      if (recurrenceMinutes !== null && (!Number.isFinite(recurrenceMinutes) || recurrenceMinutes < 5)) {
        throw new Error("recurrenceMinutes must be at least 5 minutes.");
      }
      const risk = assessTaskRisk(task);
      if (risk.blocked || risk.approvalsRequired.length > 0) {
        throw new Error(
          risk.reason ?? "Scheduled tasks cannot include financial transactions or unapproved external side effects."
        );
      }
      const schedule: ScheduledTask = {
        id: randomUUID(),
        botName,
        expertise,
        task,
        nextRunAt: runAt.toISOString(),
        recurrenceMinutes,
        status: "scheduled"
      };
      schedules.push(schedule);
      await saveSchedules();
      armSchedule(schedule);
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
      const loginUrl = typeof body.url === "string" && body.url.trim() ? body.url.trim() : "https://www.google.com/";
      const botName = typeof body.botName === "string" ? body.botName : undefined;
      const requestedMode =
        body.mode === "guest" ? "guest" : body.mode === "persistent" ? "persistent" : undefined;
      const { viewportWidth, viewportHeight, url: currentUrl, sessionMode } = await openLoginSession(
        loginUrl,
        botName,
        requestedMode
      );
      const tabs = activeSession ? await activeSession.controller.getTabs() : [];
      sendJson(res, 200, {
        status: "opened",
        sessionMode,
        profileDir: sessionMode === "guest" ? "Ephemeral Guest Context" : DEFAULT_PROFILE_DIR,
        viewportWidth,
        viewportHeight,
        url: currentUrl,
        tabs
      });
    } catch (err) {
      const message = (err as Error).message;
      const conflict = message.includes("in progress");
      sendJson(res, conflict ? 409 : 400, { detail: message });
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
    const initialFrame = session.controller.latestFrame;
    if (initialFrame) {
      res.write(`data: ${initialFrame}\n\n`);
    }
    let closed = false;
    req.on("close", () => {
      closed = true;
    });
    while (!closed) {
      const frame = await session.frameQueue.next();
      if (frame === null || closed) break;
      res.write(`data: ${frame}\n\n`);
    }
    res.end();
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/login/input") {
    let session = activeBrowserSession();
    if (!session) {
      await openLoginSession("https://www.google.com/");
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
        case "navigate":
          await controller.navigate(String(body.url ?? ""));
          break;
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
      sendJson(res, 200, { status: "ok", url: controller.currentUrl(), tabs });
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

  if (req.method === "GET" && url.pathname.startsWith("/api/artifacts/")) {
    const filename = decodeURIComponent(url.pathname.slice("/api/artifacts/".length)).replace(/[^a-zA-Z0-9._-]/g, "_");
    try {
      const data = await readFile(join(ARTIFACTS_DIR, filename));
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${filename}"`
      });
      res.end(data);
    } catch {
      sendJson(res, 404, { detail: "Artifact not found." });
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/events") {
    await handleEventsStream(res);
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
    currentRun.queue.push(null);
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
