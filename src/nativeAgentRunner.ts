import OpenAI from "openai";
import type { PageState } from "./browserController";
import { redactSecrets } from "./security";

/**
 * Pure Node.js agent runner for Pilo (replaces @openai/agents SDK).
 *
 * Supports both the Responses API (OpenAI, Kimi, etc.) and the Chat Completions API
 * (Ollama, Qwen, Anthropic-compatible, xAI, and OpenAI-compatible endpoints) with
 * native tool calling, vision snapshots, usage/cache accounting, abort signals,
 * and premature-finish verification.
 */

export interface NativeAgentToolResult {
  output: string;
  terminalResult?: {
    success: boolean;
    summary: string;
    terminationReason: string;
    delegateTo?: {
      targetBotName: string;
      task: string;
      handoffNote?: string;
    };
  };
}

export interface RunNativeAgentOptions {
  botName: string;
  systemPrompt: string;
  initialUserPrompt: string;
  taskImages?: string[];
  model: string;
  apiKey: string;
  baseURL?: string;
  useResponses: boolean;
  openAIClient?: OpenAI;
  maxSteps: number;
  tools: OpenAI.Chat.Completions.ChatCompletionTool[];
  shouldAbort: () => boolean;
  /** Run-level cancellation; replaces polling shouldAbort when supplied. */
  abortSignal?: AbortSignal;
  /** Browser snapshots default to low detail; "high" is reserved for verifying visual claims. */
  snapshotDetail?: () => "low" | "high";
  onToolCall: (name: string, input: Record<string, unknown>) => Promise<NativeAgentToolResult>;
  onUsage?: (usage: { promptTokens: number; completionTokens: number; totalTokens: number; cachedTokens: number }) => void;
  checkPrematureFinish?: (text: string) => string | null | Promise<string | null>;
  getLatestObservationImage?: () => string | undefined;
  getLatestObservationText?: () => string;
}

export interface NativeAgentRunOutcome {
  success: boolean;
  summary: string;
  stepsTaken: number;
  terminationReason: string;
  delegateTo?: {
    targetBotName: string;
    task: string;
    handoffNote?: string;
  };
}

export function formatObservationForRunner(state: PageState | null, step: number): string {
  if (!state) return "";
  const lines: string[] = [`[Live Browser Observation — Step ${step} | URL: ${state.url} | Title: "${state.title}"]`];
  if (state.tabs?.length) {
    lines.push(
      `Open tabs (switch_tab uses index; * is active):\n${state.tabs
        .map((tab) => `${tab.index}${tab.active ? "*" : ""}: ${tab.title} | ${tab.url}`)
        .join("\n")}`
    );
  }
  if (state.pageText) {
    lines.push(`Text:\n${state.pageText}`);
  }
  if (state.elements.length > 0) {
    const compactEls = state.elements.slice(0, 60).map((el) => {
      const desc = el.elementType || el.role;
      const tag = desc ? `${el.tag}[${desc}]` : el.tag;
      const label = (el.text || "").slice(0, 80);
      return `#${el.markId} ${tag} "${label}" @(${el.x},${el.y})`;
    });
    lines.push(`Elements (${compactEls.length}):\n${compactEls.join(" | ")}`);
  }
  return lines.join("\n");
}

function parseToolArgs(raw: unknown): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === "") {
    return { ok: true, value: {} };
  }
  if (typeof raw === "object" && !Array.isArray(raw)) {
    return { ok: true, value: raw as Record<string, unknown> };
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return { ok: true, value: {} };
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return { ok: true, value: parsed as Record<string, unknown> };
      }
      return { ok: false, error: "Tool arguments must be a JSON object." };
    } catch (error) {
      return {
        ok: false,
        error: `Malformed JSON tool arguments: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }
  return { ok: false, error: "Tool arguments must be a JSON object." };
}

/** Sums provider-reported prompt-cache hits so the UI can show whether caching is working. */
function cachedInputTokens(details: unknown): number {
  const entries = Array.isArray(details) ? details : details ? [details] : [];
  return entries.reduce((total: number, entry) => {
    const value = entry && typeof entry === "object" ? (entry as Record<string, unknown>).cached_tokens : 0;
    return total + (typeof value === "number" ? value : 0);
  }, 0);
}

function toResponsesTools(tools: OpenAI.Chat.Completions.ChatCompletionTool[]): Array<Record<string, unknown>> {
  return tools
    .filter((t): t is OpenAI.Chat.Completions.ChatCompletionTool & { type: "function" } => t.type === "function")
    .map((t) => {
      const rawParams = (t.function.parameters ?? { type: "object", properties: {} }) as Record<string, unknown>;
      return {
        type: "function",
        name: t.function.name,
        description: t.function.description || t.function.name,
        strict: false,
        parameters: {
          type: "object",
          properties: (rawParams.properties ?? {}) as Record<string, unknown>,
          ...(Array.isArray(rawParams.required) ? { required: rawParams.required } : {}),
          additionalProperties: true
        }
      };
    });
}

function extractResponsesText(output: unknown[]): string {
  const parts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    if (obj.type === "message" && Array.isArray(obj.content)) {
      for (const block of obj.content) {
        if (!block || typeof block !== "object") continue;
        const b = block as Record<string, unknown>;
        if ((b.type === "output_text" || b.type === "text") && typeof b.text === "string") {
          parts.push(b.text);
        }
      }
    }
  }
  return parts.join("\n").trim();
}

export async function runWithNativeAgentRunner(
  options: RunNativeAgentOptions
): Promise<NativeAgentRunOutcome> {
  const abortController = new AbortController();
  let stepsTaken = 0;
  let capturedTerminal: NativeAgentRunOutcome | null = null;

  const abortFromRun = () => abortController.abort();
  options.abortSignal?.addEventListener("abort", abortFromRun, { once: true });
  if (options.abortSignal?.aborted) abortController.abort();

  const abortPollTimer = options.abortSignal
    ? null
    : setInterval(() => {
        try {
          if (options.shouldAbort() && !abortController.signal.aborted) {
            abortController.abort();
          }
        } catch {
          // ignore
        }
      }, 150);

  const client =
    options.openAIClient ??
    new OpenAI({
      apiKey: options.apiKey || "local-ollama",
      ...(options.baseURL ? { baseURL: options.baseURL } : {})
    });

  const executeTool = async (name: string, rawArgs: unknown): Promise<string> => {
    if (options.shouldAbort() || abortController.signal.aborted) {
      abortController.abort();
      return "Run stopped by user.";
    }
    const parsed = parseToolArgs(rawArgs);
    if (!parsed.ok) {
      return `Tool call "${name}" rejected: ${parsed.error}`;
    }
    stepsTaken += 1;
    const res = await options.onToolCall(name, parsed.value);
    if (res.terminalResult) {
      capturedTerminal = {
        success: res.terminalResult.success,
        summary: res.terminalResult.summary,
        stepsTaken,
        terminationReason: res.terminalResult.terminationReason,
        delegateTo: res.terminalResult.delegateTo
      };
      abortController.abort();
    }
    return redactSecrets(res.output);
  };

  try {
    if (options.useResponses) {
      return await runResponsesLoop(client, options, abortController, executeTool, () => stepsTaken, () => capturedTerminal);
    }
    return await runChatCompletionsLoop(client, options, abortController, executeTool, () => stepsTaken, () => capturedTerminal);
  } catch (err) {
    if (capturedTerminal) return capturedTerminal;
    if (options.shouldAbort() || abortController.signal.aborted) {
      return {
        success: false,
        summary: "Stopped before finishing.",
        stepsTaken,
        terminationReason: "stopped"
      };
    }
    throw err;
  } finally {
    if (abortPollTimer) clearInterval(abortPollTimer);
    options.abortSignal?.removeEventListener("abort", abortFromRun);
  }
}

async function runResponsesLoop(
  client: OpenAI,
  options: RunNativeAgentOptions,
  abortController: AbortController,
  executeTool: (name: string, rawArgs: unknown) => Promise<string>,
  getStepsTaken: () => number,
  getCapturedTerminal: () => NativeAgentRunOutcome | null
): Promise<NativeAgentRunOutcome> {
  const buildUserItem = (text: string, withTaskImages: boolean): Record<string, unknown> => {
    const snapshot = options.getLatestObservationImage?.();
    const images: Array<Record<string, unknown>> = [
      ...(withTaskImages
        ? (options.taskImages || []).map((image) => ({ type: "input_image", image_url: image, detail: "auto" }))
        : []),
      ...(snapshot
        ? [{ type: "input_image", image_url: `data:image/jpeg;base64,${snapshot}`, detail: options.snapshotDetail?.() ?? "low" }]
        : [])
    ];
    return {
      role: "user",
      content: images.length ? [{ type: "input_text", text }, ...images] : text
    };
  };

  const tools = toResponsesTools(options.tools);
  const inputItems: Array<Record<string, unknown>> = [buildUserItem(options.initialUserPrompt, true)];
  let prematureRetries = 0;
  let turns = 0;

  while (true) {
    if (options.shouldAbort() || abortController.signal.aborted) {
      const terminal = getCapturedTerminal();
      if (terminal) return terminal;
      return { success: false, summary: "Stopped before finishing.", stepsTaken: getStepsTaken(), terminationReason: "stopped" };
    }
    if (turns >= Math.max(1, options.maxSteps)) {
      return {
        success: false,
        summary: `Stopped by circuit breaker: Reached max steps (${options.maxSteps}).`,
        stepsTaken: getStepsTaken(),
        terminationReason: "circuit_breaker"
      };
    }
    turns += 1;

    const response = (await (client as any).responses.create(
      {
        model: options.model,
        instructions: options.systemPrompt,
        input: inputItems,
        ...(tools.length > 0 ? { tools } : {})
      },
      { signal: abortController.signal }
    )) as {
      status?: string;
      error?: { message?: string } | null;
      incomplete_details?: { reason?: string } | null;
      output?: Array<Record<string, unknown>>;
      output_text?: string;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        total_tokens?: number;
        input_tokens_details?: unknown;
      };
    };

    if (options.onUsage && response?.usage) {
      const promptTokens = response.usage.input_tokens ?? 0;
      const completionTokens = response.usage.output_tokens ?? 0;
      options.onUsage({
        promptTokens,
        completionTokens,
        totalTokens: response.usage.total_tokens ?? promptTokens + completionTokens,
        cachedTokens: cachedInputTokens(response.usage.input_tokens_details)
      });
    }

    if (response?.status === "failed" || response?.status === "incomplete" || response?.status === "cancelled") {
      const detail =
        response.error?.message ??
        response.incomplete_details?.reason ??
        `Response ended with status "${response.status}".`;
      throw new Error(`Responses API ${response.status}: ${detail}`);
    }

    const output = Array.isArray(response?.output) ? response.output : [];
    for (const item of output) {
      inputItems.push(item);
    }

    const toolCalls = output.filter((item) => item?.type === "function_call");
    if (toolCalls.length > 0) {
      for (const call of toolCalls) {
        const callId = String(call.call_id ?? call.id ?? "");
        const name = String(call.name ?? "");
        const toolOutput = await executeTool(name, call.arguments);
        const terminal = getCapturedTerminal();
        if (terminal) return terminal;
        inputItems.push({
          type: "function_call_output",
          call_id: callId,
          output: toolOutput
        });
      }
      continue;
    }

    const finalOutput =
      typeof response?.output_text === "string" && response.output_text.trim()
        ? response.output_text.trim()
        : extractResponsesText(output);

    if (finalOutput && options.checkPrematureFinish && prematureRetries < 2) {
      const premature = await options.checkPrematureFinish(finalOutput);
      if (premature) {
        prematureRetries += 1;
        const latestObs = options.getLatestObservationText ? options.getLatestObservationText() : "";
        inputItems.push(buildUserItem(`[PREVIOUS ATTEMPT INCOMPLETE]:\n${premature}\n${latestObs}`, false));
        continue;
      }
    }

    return {
      success: true,
      summary: finalOutput || "Task completed.",
      stepsTaken: Math.max(1, getStepsTaken()),
      terminationReason: "direct_reply"
    };
  }
}

async function runChatCompletionsLoop(
  client: OpenAI,
  options: RunNativeAgentOptions,
  abortController: AbortController,
  executeTool: (name: string, rawArgs: unknown) => Promise<string>,
  getStepsTaken: () => number,
  getCapturedTerminal: () => NativeAgentRunOutcome | null
): Promise<NativeAgentRunOutcome> {
  const buildUserMessage = (text: string, withTaskImages: boolean): OpenAI.Chat.Completions.ChatCompletionMessageParam => {
    const snapshot = options.getLatestObservationImage?.();
    const images: OpenAI.Chat.Completions.ChatCompletionContentPartImage[] = [
      ...(withTaskImages
        ? (options.taskImages || []).map((url) => ({
            type: "image_url" as const,
            image_url: { url, detail: "auto" as const }
          }))
        : []),
      ...(snapshot
        ? [
            {
              type: "image_url" as const,
              image_url: { url: `data:image/jpeg;base64,${snapshot}`, detail: options.snapshotDetail?.() ?? ("low" as const) }
            }
          ]
        : [])
    ];
    if (images.length === 0) {
      return { role: "user", content: text };
    }
    return {
      role: "user",
      content: [{ type: "text", text }, ...images]
    };
  };

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: options.systemPrompt },
    buildUserMessage(options.initialUserPrompt, true)
  ];
  let prematureRetries = 0;
  let turns = 0;

  while (true) {
    if (options.shouldAbort() || abortController.signal.aborted) {
      const terminal = getCapturedTerminal();
      if (terminal) return terminal;
      return { success: false, summary: "Stopped before finishing.", stepsTaken: getStepsTaken(), terminationReason: "stopped" };
    }
    if (turns >= Math.max(1, options.maxSteps)) {
      return {
        success: false,
        summary: `Stopped by circuit breaker: Reached max steps (${options.maxSteps}).`,
        stepsTaken: getStepsTaken(),
        terminationReason: "circuit_breaker"
      };
    }
    turns += 1;

    const completion = await client.chat.completions.create(
      {
        model: options.model,
        messages,
        ...(options.tools.length > 0 ? { tools: options.tools } : {})
      },
      { signal: abortController.signal }
    );

    if (options.onUsage && completion.usage) {
      const promptTokens = completion.usage.prompt_tokens ?? 0;
      const completionTokens = completion.usage.completion_tokens ?? 0;
      options.onUsage({
        promptTokens,
        completionTokens,
        totalTokens: completion.usage.total_tokens ?? promptTokens + completionTokens,
        cachedTokens: cachedInputTokens((completion.usage as { prompt_tokens_details?: unknown }).prompt_tokens_details)
      });
    }

    const choice = completion.choices[0];
    const finishReason = choice?.finish_reason;
    if (finishReason === "length") {
      throw new Error("Chat completion was truncated (finish_reason: length).");
    }
    if (finishReason === "content_filter") {
      throw new Error("Chat completion was blocked by content filter (finish_reason: content_filter).");
    }

    const assistantMsg = choice?.message;
    if (!assistantMsg) {
      return {
        success: true,
        summary: "Task completed.",
        stepsTaken: Math.max(1, getStepsTaken()),
        terminationReason: "direct_reply"
      };
    }

    messages.push(assistantMsg);

    const toolCalls = assistantMsg.tool_calls ?? [];
    if (toolCalls.length > 0) {
      for (const call of toolCalls) {
        if (call.type !== "function") continue;
        const toolOutput = await executeTool(call.function.name, call.function.arguments);
        const terminal = getCapturedTerminal();
        if (terminal) return terminal;
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: toolOutput
        });
      }
      continue;
    }

    const finalOutput = typeof assistantMsg.content === "string" ? assistantMsg.content.trim() : "";
    if (finalOutput && options.checkPrematureFinish && prematureRetries < 2) {
      const premature = await options.checkPrematureFinish(finalOutput);
      if (premature) {
        prematureRetries += 1;
        const latestObs = options.getLatestObservationText ? options.getLatestObservationText() : "";
        messages.push(buildUserMessage(`[PREVIOUS ATTEMPT INCOMPLETE]:\n${premature}\n${latestObs}`, false));
        continue;
      }
    }

    return {
      success: true,
      summary: finalOutput || "Task completed.",
      stepsTaken: Math.max(1, getStepsTaken()),
      terminationReason: "direct_reply"
    };
  }
}
