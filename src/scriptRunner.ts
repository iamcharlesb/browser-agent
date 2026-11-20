/** Arbitrary model-authored JavaScript is disabled until OS-enforced isolation is available.
 * A VM context and an empty child environment are not security boundaries.
 * Keep a fail-closed compatibility entry point for stale model/tool requests.
 */
import type { ScriptToolResult } from "./scriptProtocol";

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
  const result = {
    ok: false,
    logs: [],
    toolCallsExecuted: 0,
    error: "Action scripts are disabled: secure process isolation is unavailable. Call individual approved tools instead.",
    state: { ...(options.state ?? {}) }
  };
  return { ...result, summaryMessage: formatActionScriptSummary(result) };
}
