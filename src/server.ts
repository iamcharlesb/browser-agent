/** Local web UI for the browser agent: a chat-style task box with a live step feed. */

import { IncomingMessage, ServerResponse, createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { BrowserController, DEFAULT_PROFILE_DIR, PageState, defaultBrowserConfig } from "./browserController";
import { AgentEvent, AgentOrchestrator, DEFAULT_MODEL } from "./promptLoop";

const STATIC_DIR = join(__dirname, "..", "static");
const PORT = Number(process.env.BROWSER_AGENT_UI_PORT ?? 8765);
const HOST = process.env.BROWSER_AGENT_UI_HOST ?? "127.0.0.1";

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

interface RunRequestBody {
  task: string;
  headless?: boolean;
  maxSteps?: number;
  maxDurationSeconds?: number;
  model?: string;
}

interface LoginSession {
  controller: BrowserController;
}

let currentRun: RunState | null = null;
let loginSession: LoginSession | null = null;

function validateRunRequest(body: unknown): RunRequestBody {
  if (typeof body !== "object" || body === null) {
    throw new Error("Request body must be a JSON object.");
  }
  const record = body as Record<string, unknown>;
  const task = typeof record.task === "string" ? record.task.trim() : "";
  if (!task || task.length > 2000) {
    throw new Error("task must be a non-empty string of at most 2000 characters.");
  }
  const headless = record.headless === undefined ? false : Boolean(record.headless);
  const maxSteps = record.maxSteps === undefined ? 20 : Number(record.maxSteps);
  if (!Number.isFinite(maxSteps) || maxSteps < 1 || maxSteps > 100) {
    throw new Error("maxSteps must be a number between 1 and 100.");
  }
  const maxDurationSeconds = record.maxDurationSeconds === undefined ? 900 : Number(record.maxDurationSeconds);
  if (!Number.isFinite(maxDurationSeconds) || maxDurationSeconds <= 0 || maxDurationSeconds > 3600) {
    throw new Error("maxDurationSeconds must be a number between 0 and 3600.");
  }
  const model = record.model === undefined ? DEFAULT_MODEL : String(record.model);
  return { task, headless, maxSteps, maxDurationSeconds, model };
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
  if (loginSession) {
    throw new Error("A login session is open. Close it first (POST /api/login/close).");
  }

  const run: RunState = {
    headless: Boolean(body.headless),
    isRunning: true,
    queue: new AsyncQueue<AgentEvent | null>(),
    resolveVerification: null
  };
  currentRun = run;

  void (async () => {
    const browser = new BrowserController(defaultBrowserConfig({ headless: run.headless }));
    try {
      await browser.start();
      try {
        const orchestrator = new AgentOrchestrator({
          task: body.task,
          browser,
          model: body.model,
          maxSteps: body.maxSteps,
          maxDurationSeconds: body.maxDurationSeconds,
          onEvent: (event) => run.queue.push(event),
          onHumanVerification: (state) => onHumanVerification(run, state)
        });
        await orchestrator.run();
      } finally {
        await browser.close();
      }
    } catch (err) {
      run.queue.push({
        type: "terminal",
        success: false,
        summary: `Run crashed before completion: ${(err as Error).message}`,
        terminationReason: "crash",
        stepsTaken: 0,
        elapsedSeconds: 0
      });
    } finally {
      run.isRunning = false;
      run.queue.push(null);
    }
  })();
}

async function openLoginSession(url: string): Promise<void> {
  if (loginSession) {
    throw new Error("A login session is already open.");
  }
  if (currentRun && currentRun.isRunning) {
    throw new Error("A task run is in progress. Wait for it to finish first.");
  }
  const controller = new BrowserController(defaultBrowserConfig({ headless: false }));
  loginSession = { controller };
  try {
    await controller.start();
    await controller.navigate(url);
  } catch (err) {
    loginSession = null;
    await controller.close().catch(() => undefined);
    throw err;
  }
}

async function closeLoginSession(): Promise<boolean> {
  if (!loginSession) {
    return false;
  }
  const session = loginSession;
  loginSession = null;
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
      startRun(body);
      sendJson(res, 200, { status: "started" });
    } catch (err) {
      const message = (err as Error).message;
      const alreadyRunning = message.includes("already in progress");
      sendJson(res, alreadyRunning ? 409 : 400, { detail: message });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/login") {
    try {
      const body = (await readJsonBody(req)) as Record<string, unknown>;
      const loginUrl = typeof body.url === "string" && body.url.trim() ? body.url.trim() : "about:blank";
      await openLoginSession(loginUrl);
      sendJson(res, 200, { status: "opened", profileDir: DEFAULT_PROFILE_DIR });
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
