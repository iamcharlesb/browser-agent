/** Wire protocol between the agent process and the out-of-process action-script executor.
 *
 * One JSON object per line in each direction. Kept in its own module with no imports so the
 * worker can load it without pulling in Playwright, the OpenAI client, or anything else the
 * agent process holds.
 */

/** Worker -> agent. */
export type WorkerMessage =
  | { kind: "ready" }
  | { kind: "tool"; id: number; name: string; input: Record<string, unknown> }
  | { kind: "log"; text: string }
  | {
      kind: "done";
      ok: boolean;
      returned?: string;
      finalAnswer?: string;
      error?: string;
      state?: Record<string, unknown>;
    };

/** Agent -> worker. */
export type HostMessage =
  | {
      kind: "start";
      code: string;
      toolNames: string[];
      syncTimeoutMs: number;
      state?: Record<string, unknown>;
    }
  | { kind: "tool_result"; id: number; ok: boolean; message: string; data?: string };

/** What a tool call hands back to a script. Mirrors the agent's own ToolExecutionResult,
 * narrowed to the fields that are safe and useful to expose to script code. */
export interface ScriptToolResult {
  ok: boolean;
  message: string;
  data?: string;
}

export function encodeMessage(message: WorkerMessage | HostMessage): string {
  return `${JSON.stringify(message)}\n`;
}

/** Splits a stdio chunk stream into whole lines, carrying the partial tail between calls. */
export class LineBuffer {
  private tail = "";

  push(chunk: string): string[] {
    const lines = (this.tail + chunk).split("\n");
    this.tail = lines.pop() ?? "";
    return lines.filter((line) => line.trim().length > 0);
  }
}
