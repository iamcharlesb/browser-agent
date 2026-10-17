/** Local web UI for the browser agent: a chat-style task box with a live step feed. */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, watch } from "node:fs";
import { IncomingMessage, ServerResponse, createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BrowserController, DEFAULT_PROFILE_DIR, PageState, defaultBrowserConfig } from "./browserController";
import { AgentEvent, AgentOrchestrator, DEFAULT_MODEL } from "./promptLoop";
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
  const headless = record.headless === undefined ? false : Boolean(record.headless);
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

async function onHumanVerification(run: RunState, state: PageState): Promise<void> {
  if (run.headless) {
    console.warn(
      `Human verification detected at ${state.url} during a headless run; there is no visible ` +
        "window to solve it in, so the run continues without pausing."
    );
    return;
  }
  await new Promise<void>((resolve) => {
    run.resolveVerification = resolve;
  });
  run.resolveVerification = null;
}

function startRun(body: RunRequestBody): void {
  if (currentRun && currentRun.isRunning) {
    throw new Error("A run is already in progress. Wait for it to finish first.");
  }
  if (activeSession?.kind === "login") {
    throw new Error("A login session is open. Close it first (POST /api/login/close).");
  }

  const botKey = body.botName?.trim() || "default";
  const run: RunState = {
    headless: Boolean(body.headless),
    isRunning: true,
    queue: new AsyncQueue<AgentEvent | null>(),
    resolveVerification: null
  };
  currentRun = run;

  void (async () => {
    try {
      // Reuse the existing browser/page when this message continues the same bot's conversation,
      // so the agent sees wherever it actually left off instead of a blank tab every message.
      // Switching to a different bot (or recovering from a crash) starts a fresh session.
      if (!activeSession || activeSession.kind !== "conversation" || activeSession.botKey !== botKey) {
        if (activeSession) {
          await activeSession.controller.close().catch(() => undefined);
          activeSession = null;
        }
        const controller = new BrowserController(defaultBrowserConfig({ headless: run.headless }));
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
      }
      const session = activeSession;

      const orchestrator = new AgentOrchestrator({
        task: body.task,
        botName: body.botName,
        expertise: body.expertise,
        collaborationContext: body.collaborationContext,
        browser: session.controller,
        model: body.model,
        maxSteps: body.maxSteps,
        maxDurationSeconds: body.maxDurationSeconds,
        onEvent: (event) => {
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
        onHumanVerification: (state) => onHumanVerification(run, state)
      });
      await orchestrator.run();
    } catch (err) {
      run.queue.push({
        type: "terminal",
        success: false,
        summary: `Run crashed before completion: ${(err as Error).message}`,
        terminationReason: "crash",
        stepsTaken: 0,
        elapsedSeconds: 0
      });
      // The session may be in a bad state after an unexpected crash - drop it so the next
      // message starts clean rather than reusing a possibly-broken browser.
      if (activeSession) {
        await activeSession.controller.close().catch(() => undefined);
        activeSession = null;
      }
    } finally {
      run.isRunning = false;
      run.queue.push(null);
    }
  })();
}

function activeBrowserSession(): BrowserSession | null {
  return activeSession;
}

async function openLoginSession(url: string): Promise<{ viewportWidth: number; viewportHeight: number }> {
  if (activeSession?.kind === "login") {
    throw new Error("A login session is already open.");
  }
  if (currentRun && currentRun.isRunning) {
    throw new Error("A task run is in progress. Wait for it to finish first.");
  }
  if (activeSession) {
    // A conversation browser was sitting open between messages. Only one Chromium process can
    // hold the shared profile at a time, so end that first - its cookies/login state are on
    // disk already, so nothing is lost except the current page position, which the next message
    // to that bot will simply re-navigate from.
    await activeSession.controller.close().catch(() => undefined);
    activeSession = null;
  }
  // Always headless under the hood: the embedded live view (CDP screencast) is what renders the
  // page inside the web UI tab, instead of popping a separate OS browser window.
  const controller = new BrowserController(defaultBrowserConfig({ headless: true }));
  const { width, height } = controller.viewportSize;
  const session: BrowserSession = {
    kind: "login",
    botKey: null,
    controller,
    frameQueue: new AsyncQueue<string | null>(),
    viewportWidth: width,
    viewportHeight: height
  };
  activeSession = session;
  try {
    await controller.start();
    await controller.navigate(url);
    await controller.startScreencast((frame) => session.frameQueue.push(frame));
  } catch (err) {
    activeSession = null;
    await controller.close().catch(() => undefined);
    throw err;
  }
  return { viewportWidth: width, viewportHeight: height };
}

async function closeLoginSession(): Promise<boolean> {
  if (!activeSession || activeSession.kind !== "login") {
    return false;
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

  if (req.method === "POST" && url.pathname === "/api/run") {
    if (!process.env.OPENAI_API_KEY) {
      sendJson(res, 400, { detail: "OPENAI_API_KEY is not set in the server environment." });
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
      const loginUrl = typeof body.url === "string" && body.url.trim() ? body.url.trim() : "about:blank";
      const { viewportWidth, viewportHeight } = await openLoginSession(loginUrl);
      sendJson(res, 200, { status: "opened", profileDir: DEFAULT_PROFILE_DIR, viewportWidth, viewportHeight });
    } catch (err) {
      const message = (err as Error).message;
      const conflict = message.includes("already open") || message.includes("in progress");
      sendJson(res, conflict ? 409 : 400, { detail: message });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/login/close") {
    const closed = await closeLoginSession();
    if (closed) {
      sendJson(res, 200, { status: "closed" });
    } else {
      sendJson(res, 409, { detail: "No login session is currently open." });
    }
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
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const frame = await session.frameQueue.next();
      if (frame === null) break;
      res.write(`data: ${frame}\n\n`);
    }
    res.end();
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/login/input") {
    const session = activeBrowserSession();
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
        case "click":
          await controller.remoteClick(Number(body.x), Number(body.y));
          break;
        case "move":
          await controller.remoteMouseMove(Number(body.x), Number(body.y));
          break;
        case "type":
          await controller.remoteType(String(body.text ?? ""));
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
      sendJson(res, 200, { status: "ok" });
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

server.listen(PORT, HOST, () => {
  console.log(`Browser Agent UI listening on http://${HOST}:${PORT}`);
});
