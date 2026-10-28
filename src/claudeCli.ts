/** Invoke the local Claude Code CLI as an Pilo model backend. */

import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import OpenAI from "openai";

export const CLAUDE_CLI_TOOL_SCHEMA = {
  type: "object",
  properties: {
    content: { type: ["string", "null"] },
    tool_calls: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          arguments: { type: "object" }
        },
        required: ["name", "arguments"]
      }
    }
  },
  required: ["content", "tool_calls"]
} as const;

export interface ClaudeCliInvokeOptions {
  systemPrompt: string;
  userPrompt: string;
  /** Alias passed to `claude --model` (sonnet | opus | haiku | full id). */
  modelAlias?: string;
  /** Absolute path override; otherwise PATH + common install locations. */
  cliPath?: string;
  timeoutMs?: number;
  cwd?: string;
  signal?: AbortSignal;
}

export interface ClaudeCliStructuredTurn {
  content: string | null;
  tool_calls: Array<{ name: string; arguments: Record<string, unknown> }>;
}

export interface ClaudeCliResult {
  structured: ClaudeCliStructuredTurn;
  rawResultText: string;
  sessionId?: string;
  model?: string;
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
  costUsd?: number;
}

function candidateClaudePaths(explicit?: string): string[] {
  const home = homedir();
  const fromEnv = [
    explicit,
    process.env.CLAUDE_CLI_PATH,
    process.env.CLAUDE_PATH
  ].filter((p): p is string => Boolean(p && p.trim()));
  return [
    ...fromEnv,
    "claude",
    join(home, ".local", "bin", "claude"),
    "/usr/local/bin/claude",
    "/opt/homebrew/bin/claude"
  ];
}

/** True when a Claude Code CLI binary is resolvable on this machine. */
export function isClaudeCliAvailable(explicitPath?: string): boolean {
  for (const candidate of candidateClaudePaths(explicitPath)) {
    if (candidate === "claude") {
      // PATH lookup is deferred to spawn; treat as available if other absolute paths fail.
      continue;
    }
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      /* try next */
    }
  }
  // Assume PATH may still resolve `claude` (common after `npm i -g` / local installers).
  return true;
}

export function resolveClaudeCliBinary(explicitPath?: string): string {
  for (const candidate of candidateClaudePaths(explicitPath)) {
    if (candidate === "claude") continue;
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* try next */
    }
  }
  return explicitPath?.trim() || process.env.CLAUDE_CLI_PATH?.trim() || "claude";
}

/** Parse Pilo model id into a Claude CLI --model alias. */
export function claudeCliModelAlias(rawModel: string): string | undefined {
  const trimmed = rawModel.trim();
  if (trimmed === "claude-cli") return undefined;
  if (trimmed.startsWith("claude-cli:")) {
    const alias = trimmed.slice("claude-cli:".length).trim();
    return alias || undefined;
  }
  return undefined;
}

export function isClaudeCliModel(rawModel: string): boolean {
  const m = rawModel.trim().toLowerCase();
  return m === "claude-cli" || m.startsWith("claude-cli:");
}

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("Claude CLI returned empty output.");
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new Error("Claude CLI output was not valid JSON.");
  }
}

function normalizeStructured(value: unknown, fallbackText: string): ClaudeCliStructuredTurn {
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const content =
      typeof obj.content === "string" ? obj.content : obj.content === null ? null : fallbackText || null;
    const rawCalls = Array.isArray(obj.tool_calls) ? obj.tool_calls : [];
    const tool_calls = rawCalls
      .map((call) => {
        if (!call || typeof call !== "object") return null;
        const c = call as Record<string, unknown>;
        const name = String(c.name ?? "").trim();
        if (!name) return null;
        const args =
          c.arguments && typeof c.arguments === "object" && !Array.isArray(c.arguments)
            ? (c.arguments as Record<string, unknown>)
            : typeof c.arguments === "string"
              ? (JSON.parse(c.arguments || "{}") as Record<string, unknown>)
              : {};
        return { name, arguments: args };
      })
      .filter((c): c is { name: string; arguments: Record<string, unknown> } => Boolean(c));
    return { content, tool_calls };
  }
  return { content: fallbackText || null, tool_calls: [] };
}

/**
 * Run one non-interactive Claude Code turn with Pilo-shaped structured tool_calls.
 * Uses the user's local Claude login (no ANTHROPIC_API_KEY required when CLI is logged in).
 */
export async function invokeClaudeCli(options: ClaudeCliInvokeOptions): Promise<ClaudeCliResult> {
  const bin = resolveClaudeCliBinary(options.cliPath);
  const timeoutMs = options.timeoutMs ?? 120_000;
  const args = [
    "-p",
    "--output-format",
    "json",
    "--tools",
    "",
    "--json-schema",
    JSON.stringify(CLAUDE_CLI_TOOL_SCHEMA),
    "--system-prompt",
    options.systemPrompt
  ];
  if (options.modelAlias) {
    args.push("--model", options.modelAlias);
  }
  args.push(options.userPrompt);

  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: options.cwd,
      signal: options.signal,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Claude CLI timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      out += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      err += String(chunk);
    });
    child.on("error", (spawnErr) => {
      clearTimeout(timer);
      reject(
        new Error(
          `Failed to start Claude CLI (${bin}): ${spawnErr.message}. Install Claude Code and ensure \`claude\` is on PATH, or set CLAUDE_CLI_PATH.`
        )
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 && !out.trim()) {
        reject(new Error(`Claude CLI exited with code ${code}: ${(err || out).trim().slice(0, 400) || "no output"}`));
        return;
      }
      resolve(out);
    });
  });

  const parsed = extractJsonObject(stdout) as Record<string, unknown>;
  if (parsed.is_error === true) {
    const msg = String(parsed.result || parsed.error || "Claude CLI reported an error.");
    throw new Error(msg);
  }

  const resultText = typeof parsed.result === "string" ? parsed.result : "";
  const structuredRaw = parsed.structured_output ?? (() => {
    try {
      return resultText ? JSON.parse(resultText) : null;
    } catch {
      return null;
    }
  })();
  const structured = normalizeStructured(structuredRaw, resultText);

  const usageObj = (parsed.usage && typeof parsed.usage === "object" ? parsed.usage : {}) as Record<
    string,
    unknown
  >;
  const inputTokens = Number(usageObj.input_tokens ?? 0) || 0;
  const outputTokens = Number(usageObj.output_tokens ?? 0) || 0;
  const modelUsage = parsed.modelUsage && typeof parsed.modelUsage === "object" ? parsed.modelUsage : null;
  let modelName: string | undefined;
  if (modelUsage) {
    modelName = Object.keys(modelUsage as Record<string, unknown>)[0];
  }

  return {
    structured,
    rawResultText: resultText,
    sessionId: typeof parsed.session_id === "string" ? parsed.session_id : undefined,
    model: modelName,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens
    },
    costUsd: typeof parsed.total_cost_usd === "number" ? parsed.total_cost_usd : undefined
  };
}

/** Convert a Claude CLI structured turn into an OpenAI ChatCompletion-shaped object. */
export function claudeCliResultToChatCompletion(
  result: ClaudeCliResult,
  fallbackModel: string
): OpenAI.Chat.Completions.ChatCompletion {
  const toolCalls = result.structured.tool_calls.slice(0, 4).map((call, index) => ({
    id: `claude_cli_${Date.now()}_${index}`,
    type: "function" as const,
    function: {
      name: call.name,
      arguments: JSON.stringify(call.arguments ?? {})
    }
  }));
  const content = result.structured.content;
  return {
    id: result.sessionId || `claude-cli-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: result.model || fallbackModel,
    choices: [
      {
        index: 0,
        finish_reason: toolCalls.length ? "tool_calls" : "stop",
        logprobs: null,
        message: {
          role: "assistant",
          content: content && content.trim() ? content : null,
          tool_calls: toolCalls.length ? toolCalls : undefined
        }
      }
    ],
    usage: {
      prompt_tokens: result.usage?.input_tokens ?? 0,
      completion_tokens: result.usage?.output_tokens ?? 0,
      total_tokens: result.usage?.total_tokens ?? 0
    }
  } as OpenAI.Chat.Completions.ChatCompletion;
}

/** Flatten OpenAI-style chat history into a compact text prompt for Claude CLI. */
export function flattenMessagesForClaudeCli(
  messages: Array<{ role?: string; content?: unknown; tool_calls?: unknown; tool_call_id?: string }>
): string {
  const lines: string[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "tool") {
      const body =
        typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "");
      lines.push(`TOOL_RESULT (${message.tool_call_id || "unknown"}):\n${body.slice(0, 1400)}`);
      continue;
    }
    if (message.role === "assistant") {
      if (typeof message.content === "string" && message.content.trim()) {
        lines.push(`ASSISTANT:\n${message.content.trim()}`);
      }
      if (Array.isArray(message.tool_calls)) {
        for (const call of message.tool_calls as Array<Record<string, any>>) {
          lines.push(
            `ASSISTANT_TOOL_CALL: ${call.function?.name || "?"} ${String(call.function?.arguments || "{}")}`
          );
        }
      }
      continue;
    }
    if (typeof message.content === "string") {
      lines.push(`USER:\n${message.content}`);
      continue;
    }
    if (Array.isArray(message.content)) {
      const textParts = message.content
        .filter((part: any) => part && part.type === "text" && typeof part.text === "string")
        .map((part: any) => part.text as string);
      if (textParts.length) lines.push(`USER:\n${textParts.join("\n")}`);
    }
  }
  lines.push(
    "Respond ONLY via the JSON schema: set content for a short user-facing note (or null), and tool_calls for Pilo tools (empty array if you are done talking with no tools)."
  );
  return lines.join("\n\n").slice(0, 48_000);
}

export function toolsCatalogForClaudeCli(
  tools: OpenAI.Chat.Completions.ChatCompletionTool[]
): string {
  const lines = ["AVAILABLE PILO TOOLS (call these via tool_calls; do not invent others):"];
  for (const tool of tools) {
    if (tool.type !== "function") continue;
    const params = tool.function.parameters
      ? JSON.stringify(tool.function.parameters).slice(0, 500)
      : "{}";
    lines.push(`- ${tool.function.name}: ${tool.function.description || ""} | params=${params}`);
  }
  return lines.join("\n");
}
