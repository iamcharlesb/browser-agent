/** Host-side runner for the out-of-process action-script worker (`scriptWorker.ts`).
 *
 * Spawns the worker with an empty environment (`env: {}`), forwards each tool RPC to the caller's
 * gated dispatcher, enforces a hard tool-call cap + wall-clock deadline + cooperative abort, and
 * returns the accumulated logs, return value, optional `final_answer`, and updated `state`.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  HostMessage,
  LineBuffer,
  ScriptToolResult,
  WorkerMessage,
  encodeMessage
} from "./scriptProtocol";

export const DEFAULT_SYNC_TIMEOUT_MS = 3_000;
export const DEFAULT_WALL_TIMEOUT_MS = 45_000;
export const DEFAULT_MAX_TOOL_CALLS = 10;
const MAX_LOGS_KEPT = 30;

export interface RunActionScriptOptions {
  code: string;
  toolNames: string[];
  state?: Record<string, unknown>;
  syncTimeoutMs?: number;
  wallTimeoutMs?: number;
  maxToolCalls?: number;
  shouldAbort?: () => boolean;
  onToolCall: (name: string, input: Record<string, unknown>) => Promise<ScriptToolResult>;
}

export interface ActionScriptResult {
  ok: boolean;
  logs: string[];
  toolCallsExecuted: number;
  returned?: string;
  finalAnswer?: string;
  error?: string;
  state: Record<string, unknown>;
  summaryMessage: string;
}

function resolveWorkerEntry(): { execPath: string; args: string[] } {
  const jsCandidate = join(__dirname, "scriptWorker.js");
  if (existsSync(jsCandidate)) {
    return { execPath: process.execPath, args: [jsCandidate] };
  }
  const distCandidate = join(__dirname, "..", "dist", "scriptWorker.js");
  if (existsSync(distCandidate)) {
    return { execPath: process.execPath, args: [distCandidate] };
  }
  const buildCandidate = join(__dirname, "..", "build", "scriptWorker.js");
  if (existsSync(buildCandidate)) {
    return { execPath: process.execPath, args: [buildCandidate] };
  }
  return { execPath: process.execPath, args: [jsCandidate] };
}

export function formatActionScriptSummary(result: Omit<ActionScriptResult, "summaryMessage">): string {
  const parts: string[] = [];
  parts.push(
    `Script ${result.ok ? "completed" : "failed"} (${result.toolCallsExecuted} tool call(s)).`
  );
  if (result.logs.length > 0) {
    parts.push(`Logs:\n${result.logs.map((line) => `  ${line}`).join("\n")}`);
  }
  if (result.finalAnswer !== undefined) {
    parts.push(`Final Answer: ${result.finalAnswer}`);
  } else if (result.returned !== undefined) {
    parts.push(`Returned: ${result.returned}`);
  }
  if (result.error) {
    parts.push(`Error: ${result.error}`);
  }
  return parts.join("\n");
}

export async function runActionScript(options: RunActionScriptOptions): Promise<ActionScriptResult> {
  const code = (options.code ?? "").trim();
  const currentState: Record<string, unknown> = { ...(options.state ?? {}) };
  if (!code) {
    const base = {
      ok: false,
      logs: [],
      toolCallsExecuted: 0,
      error: "Script code must be non-empty.",
      state: currentState
    };
    return { ...base, summaryMessage: formatActionScriptSummary(base) };
  }

  const allowedTools = new Set(options.toolNames);
  const syncTimeoutMs = options.syncTimeoutMs ?? DEFAULT_SYNC_TIMEOUT_MS;
  const wallTimeoutMs = options.wallTimeoutMs ?? DEFAULT_WALL_TIMEOUT_MS;
  const maxToolCalls = options.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;

  const { execPath, args } = resolveWorkerEntry();

  return new Promise<ActionScriptResult>((resolve) => {
    const logs: string[] = [];
    let toolCallsExecuted = 0;
    let settled = false;

    const child = spawn(execPath, args, {
      env: {},
      stdio: ["pipe", "pipe", "ignore"]
    });

    const finish = (partial: Omit<ActionScriptResult, "summaryMessage">) => {
      if (settled) return;
      settled = true;
      clearTimeout(wallTimer);
      try {
        child.kill("SIGKILL");
      } catch {
        // Child may already be dead.
      }
      resolve({
        ...partial,
        summaryMessage: formatActionScriptSummary(partial)
      });
    };

    const wallTimer = setTimeout(() => {
      finish({
        ok: false,
        logs,
        toolCallsExecuted,
        error: `Script exceeded wall-clock timeout (${wallTimeoutMs}ms).`,
        state: currentState
      });
    }, wallTimeoutMs);

    const sendToWorker = (message: HostMessage) => {
      if (settled || !child.stdin.writable) return;
      child.stdin.write(encodeMessage(message));
    };

    const lineBuffer = new LineBuffer();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      for (const line of lineBuffer.push(chunk)) {
        if (settled) return;
        let msg: WorkerMessage;
        try {
          msg = JSON.parse(line) as WorkerMessage;
        } catch {
          continue;
        }

        if (msg.kind === "ready") {
          sendToWorker({
            kind: "start",
            code,
            toolNames: [...allowedTools],
            syncTimeoutMs,
            state: currentState
          });
        } else if (msg.kind === "log") {
          if (logs.length < MAX_LOGS_KEPT) {
            logs.push(msg.text);
          }
        } else if (msg.kind === "tool") {
          if (options.shouldAbort?.()) {
            finish({
              ok: false,
              logs,
              toolCallsExecuted,
              error: "Run aborted by user.",
              state: currentState
            });
            return;
          }

          if (!allowedTools.has(msg.name)) {
            sendToWorker({
              kind: "tool_result",
              id: msg.id,
              ok: false,
              message: `Tool "${msg.name}" is not available in script scope.`
            });
            continue;
          }

          if (toolCallsExecuted >= maxToolCalls) {
            sendToWorker({
              kind: "tool_result",
              id: msg.id,
              ok: false,
              message: `Script reached maximum allowed tool calls (${maxToolCalls}). Return or call final_answer() with your progress.`
            });
            continue;
          }

          toolCallsExecuted += 1;
          void options
            .onToolCall(msg.name, msg.input ?? {})
            .then((result) => {
              sendToWorker({
                kind: "tool_result",
                id: msg.id,
                ok: result.ok,
                message: result.message,
                data: result.data
              });
            })
            .catch((err: unknown) => {
              sendToWorker({
                kind: "tool_result",
                id: msg.id,
                ok: false,
                message: (err as Error)?.message ?? String(err)
              });
            });
        } else if (msg.kind === "done") {
          const nextState =
            msg.state && typeof msg.state === "object" && !Array.isArray(msg.state)
              ? msg.state
              : currentState;
          finish({
            ok: msg.ok,
            logs,
            toolCallsExecuted,
            returned: msg.returned,
            finalAnswer: msg.finalAnswer,
            error: msg.error,
            state: nextState
          });
        }
      }
    });

    child.on("error", (err) => {
      finish({
        ok: false,
        logs,
        toolCallsExecuted,
        error: `Worker process error: ${err.message}`,
        state: currentState
      });
    });

    child.on("exit", (exitCode) => {
      if (!settled) {
        finish({
          ok: false,
          logs,
          toolCallsExecuted,
          error: `Worker exited unexpectedly (code ${exitCode ?? "unknown"}).`,
          state: currentState
        });
      }
    });
  });
}
