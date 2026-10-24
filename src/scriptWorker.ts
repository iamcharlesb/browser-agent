/** The action-script executor, running as its own process.
 *
 * Code-as-action (smolagents pattern): instead of picking one tool per model turn, the model
 * writes a short script that composes several tools, keeps intermediate results in `state`,
 * and can call `final_answer(...)` when finished.
 *
 * This process is deliberately powerless. It has no Playwright handle, no OpenAI client, no
 * secrets in its environment, and no module loader reachable from script scope: every tool call
 * is an RPC the agent process validates and performs. The vm context here disables dynamic code
 * generation (`strings: false, wasm: false`) as defence in depth, while the process boundary and
 * host-side approval gates form the security boundary.
 */

import vm from "node:vm";
import {
  HostMessage,
  LineBuffer,
  ScriptToolResult,
  WorkerMessage,
  encodeMessage
} from "./scriptProtocol";

const MAX_LOG_CHARS = 600;
const MAX_RETURN_CHARS = 4_000;
const MAX_STATE_JSON_CHARS = 32_000;
const MAX_SLEEP_SECONDS = 30;

class FinalAnswerSignal {
  constructor(readonly value: unknown) {}
}

function send(message: WorkerMessage): void {
  process.stdout.write(encodeMessage(message));
}

const pendingCalls = new Map<number, (result: ScriptToolResult) => void>();
let nextCallId = 1;

function callAgent(name: string, input: Record<string, unknown>): Promise<ScriptToolResult> {
  return new Promise((resolve) => {
    let payload: Record<string, unknown>;
    try {
      // Round-trips through JSON so a script cannot smuggle a getter, a proxy or a cycle
      // across the wire; the agent process only ever sees plain data.
      payload = JSON.parse(JSON.stringify(input ?? {})) as Record<string, unknown>;
    } catch {
      resolve({ ok: false, message: `Arguments for ${name} must be plain JSON-serializable data.` });
      return;
    }
    const id = nextCallId;
    nextCallId += 1;
    pendingCalls.set(id, resolve);
    send({ kind: "tool", id, name, input: payload });
  });
}

function stringifyLogArg(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function safeCloneState(raw: Record<string, unknown>): Record<string, unknown> {
  try {
    const serialized = JSON.stringify(raw ?? {});
    if (!serialized || serialized.length > MAX_STATE_JSON_CHARS) {
      return {};
    }
    const parsed = JSON.parse(serialized);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function buildScriptContext(
  toolNames: string[],
  state: Record<string, unknown>
): vm.Context {
  const logFn = (...args: unknown[]) =>
    send({ kind: "log", text: args.map(stringifyLogArg).join(" ").slice(0, MAX_LOG_CHARS) });

  const scope: Record<string, unknown> = {
    state,
    JSON,
    Math,
    Date,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Promise,
    RegExp,
    Error,
    Map,
    Set,
    isNaN,
    parseInt,
    parseFloat,
    encodeURIComponent,
    decodeURIComponent,
    print: logFn,
    console: {
      log: logFn,
      warn: logFn,
      error: logFn
    },
    sleep: (seconds: number) => {
      const bounded = Math.min(Math.max(Number(seconds) || 0, 0), MAX_SLEEP_SECONDS);
      return new Promise((resolve) => setTimeout(resolve, bounded * 1000));
    },
    final_answer: (value: unknown) => {
      throw new FinalAnswerSignal(value);
    }
  };
  for (const name of toolNames) {
    scope[name] = (input: Record<string, unknown> = {}) => callAgent(name, input);
  }
  return vm.createContext(scope, {
    name: "action-script",
    codeGeneration: { strings: false, wasm: false }
  });
}

async function runScript(
  code: string,
  toolNames: string[],
  syncTimeoutMs: number,
  initialState?: Record<string, unknown>
): Promise<void> {
  const state: Record<string, unknown> = safeCloneState(initialState ?? {});
  try {
    const context = buildScriptContext(toolNames, state);
    // Wrapped in an async IIFE so script code can `await` tools and `return` an answer.
    const wrapped = `(async () => {\n${code}\n})()`;
    // This timeout only bounds synchronous execution, which is exactly what it is for: it kills
    // a `while (true) {}` that never awaits. The agent process owns the wall-clock deadline.
    const promise = vm.runInContext(wrapped, context, {
      filename: "action-script.js",
      timeout: syncTimeoutMs
    }) as Promise<unknown>;
    const returned = await promise;
    send({
      kind: "done",
      ok: true,
      returned: returned === undefined ? undefined : stringifyLogArg(returned).slice(0, MAX_RETURN_CHARS),
      state: safeCloneState(state)
    });
  } catch (err) {
    if (err instanceof FinalAnswerSignal) {
      send({
        kind: "done",
        ok: true,
        finalAnswer: stringifyLogArg(err.value).slice(0, MAX_RETURN_CHARS),
        state: safeCloneState(state)
      });
      return;
    }
    send({
      kind: "done",
      ok: false,
      error: (err as Error)?.message ?? String(err),
      state: safeCloneState(state)
    });
  }
}

const inbound = new LineBuffer();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  for (const line of inbound.push(chunk)) {
    let message: HostMessage;
    try {
      message = JSON.parse(line) as HostMessage;
    } catch {
      continue;
    }
    if (message.kind === "start") {
      void runScript(message.code, message.toolNames, message.syncTimeoutMs, message.state);
    } else if (message.kind === "tool_result") {
      const resolve = pendingCalls.get(message.id);
      if (resolve) {
        pendingCalls.delete(message.id);
        resolve({ ok: message.ok, message: message.message, data: message.data });
      }
    }
  }
});
process.stdin.on("end", () => process.exit(0));

send({ kind: "ready" });
