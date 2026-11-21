import { redactSecrets } from "./security";
/**
 * OpenAI Agents SDK (@openai/agents) runner integration for Pilo.
 *
 * Used when `agentEngine === "openai-sdk"` (the default mode in the header).
 * Selecting "Cheap" in the header switches to the token-lean custom loop in `promptLoop.ts`.
 */

import { Agent, MaxTurnsExceededError, OpenAIProvider, Runner, tool, user, type AgentInputItem } from "@openai/agents";
import type OpenAI from "openai";
import type { PageState } from "./browserController";

export interface OpenAIAgentsSdkToolResult {
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

export interface RunOpenAIAgentsSdkOptions {
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
  onToolCall: (name: string, input: Record<string, unknown>) => Promise<OpenAIAgentsSdkToolResult>;
  onUsage?: (usage: { promptTokens: number; completionTokens: number; totalTokens: number; cachedTokens: number }) => void;
  checkPrematureFinish?: (text: string) => string | null | Promise<string | null>;
  getLatestObservationImage?: () => string | undefined;
  getLatestObservationText?: () => string;
}

export interface OpenAIAgentsSdkRunOutcome {
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

export function formatObservationForSdk(state: PageState | null, step: number): string {
  if (!state) return "";
  const lines: string[] = [`[Live Browser Observation — Step ${step} | URL: ${state.url} | Title: "${state.title}"]`];
  if (state.tabs?.length) lines.push(`Open tabs (switch_tab uses index; * is active):\n${state.tabs.map(tab=>`${tab.index}${tab.active?"*":""}: ${tab.title} | ${tab.url}`).join("\n")}`);
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

export async function runWithOpenAIAgentsSdk(
  options: RunOpenAIAgentsSdkOptions
): Promise<OpenAIAgentsSdkRunOutcome> {
  const abortController = new AbortController();
  let stepsTaken = 0;
  let capturedTerminal: OpenAIAgentsSdkRunOutcome | null = null;

  const abortFromRun = () => abortController.abort();
  options.abortSignal?.addEventListener("abort", abortFromRun, { once: true });
  if (options.abortSignal?.aborted) abortController.abort();
  // Without a run signal, fall back to polling the cooperative stop flag.
  const abortPollTimer = options.abortSignal ? null : setInterval(() => {
    try {
      if (options.shouldAbort() && !abortController.signal.aborted) {
        abortController.abort();
      }
    } catch {
      // ignore
    }
  }, 150);

  try {
    const sdkTools = options.tools
      .filter((t): t is OpenAI.Chat.Completions.ChatCompletionTool & { type: "function" } => t.type === "function")
      .map((t) => {
        const rawParams = (t.function.parameters ?? {
          type: "object",
          properties: {}
        }) as Record<string, unknown>;
        const parameters = {
          type: "object" as const,
          properties: (rawParams.properties ?? {}) as Record<string, unknown>,
          ...(Array.isArray(rawParams.required) ? { required: rawParams.required as string[] } : {}),
          additionalProperties: true
        };

        return tool({
          name: t.function.name,
          description: t.function.description || t.function.name,
          parameters: parameters as any,
          strict: false,
          execute: async (rawInput: unknown) => {
            if (options.shouldAbort()) {
              abortController.abort();
              return "Run stopped by user.";
            }
            const parsedInput: Record<string, unknown> =
              rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)
                ? (rawInput as Record<string, unknown>)
                : typeof rawInput === "string"
                  ? (() => {
                      try {
                        return JSON.parse(rawInput) as Record<string, unknown>;
                      } catch {
                        return {};
                      }
                    })()
                  : {};

            stepsTaken += 1;
            const res = await options.onToolCall(t.function.name, parsedInput);
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
          }
        });
      });

    const provider = options.openAIClient
      ? new OpenAIProvider({
          openAIClient: options.openAIClient as any,
          useResponses: options.useResponses,
          strictFeatureValidation: false
        })
      : new OpenAIProvider({
          apiKey: options.apiKey,
          ...(options.baseURL ? { baseURL: options.baseURL } : {}),
          useResponses: options.useResponses,
          strictFeatureValidation: false
        });

    const agent = new Agent({
      name: options.botName || "Open Bot",
      instructions: options.systemPrompt,
      model: options.model,
      tools: sdkTools
    });

    const runner = new Runner({
      modelProvider: provider,
      tracingDisabled: true
    });

    const userMessage = (text: string, withTaskImages: boolean): AgentInputItem => {
      const snapshot = options.getLatestObservationImage?.();
      const images = [
        ...(withTaskImages ? (options.taskImages || []).map(image => ({ type: "input_image" as const, image, detail: "auto" as const })) : []),
        ...(snapshot ? [{ type: "input_image" as const, image: `data:image/jpeg;base64,${snapshot}`, detail: options.snapshotDetail?.() ?? "low" }] : [])
      ];
      return user(images.length ? [{ type: "input_text", text }, ...images] : text);
    };
    let currentInput: AgentInputItem[] = [userMessage(options.initialUserPrompt, true)];
    let prematureRetries = 0;

    while (true) {
      let runResult;
      try {
        runResult = await runner.run(agent, currentInput, {
          maxTurns: Math.max(1, options.maxSteps - stepsTaken),
          signal: abortController.signal
        });
      } catch (err) {
        if (capturedTerminal) {
          return capturedTerminal;
        }
        if (options.shouldAbort()) {
          return {
            success: false,
            summary: "Stopped before finishing.",
            stepsTaken,
            terminationReason: "stopped"
          };
        }
        if (err instanceof MaxTurnsExceededError) {
          return {
            success: false,
            summary: `Stopped by circuit breaker: Reached max steps (${options.maxSteps}).`,
            stepsTaken,
            terminationReason: "circuit_breaker"
          };
        }
        throw err;
      }

      if (options.onUsage && Array.isArray(runResult.rawResponses)) {
        for (const resp of runResult.rawResponses) {
          if (resp?.usage) {
            options.onUsage({
              promptTokens: resp.usage.inputTokens ?? 0,
              completionTokens: resp.usage.outputTokens ?? 0,
              totalTokens: resp.usage.totalTokens ?? (resp.usage.inputTokens ?? 0) + (resp.usage.outputTokens ?? 0),
              cachedTokens: cachedInputTokens(resp.usage.inputTokensDetails)
            });
          }
        }
      }

      if (capturedTerminal) {
        return capturedTerminal;
      }

      const finalOutput =
        typeof runResult.finalOutput === "string"
          ? runResult.finalOutput.trim()
          : runResult.finalOutput !== undefined
            ? JSON.stringify(runResult.finalOutput)
            : "";

      if (finalOutput && options.checkPrematureFinish && prematureRetries < 2) {
        const premature = await options.checkPrematureFinish(finalOutput);
        if (premature) {
          prematureRetries += 1;
          const latestObs = options.getLatestObservationText ? options.getLatestObservationText() : "";
          // Continue the same conversation; restarting would resend and redo every earlier turn.
          currentInput = [...runResult.history, userMessage(`[PREVIOUS ATTEMPT INCOMPLETE]:\n${premature}\n${latestObs}`, false)];
          continue;
        }
      }

      return {
        success: true,
        summary: finalOutput || "Task completed.",
        stepsTaken: Math.max(1, stepsTaken),
        terminationReason: "direct_reply"
      };
    }
  } finally {
    if (abortPollTimer) clearInterval(abortPollTimer);
    options.abortSignal?.removeEventListener("abort", abortFromRun);
  }
}

/** Sums provider-reported prompt-cache hits so the UI can show whether caching is working. */
function cachedInputTokens(details: unknown): number {
  const entries = Array.isArray(details) ? details : details ? [details] : [];
  return entries.reduce((total: number, entry) => {
    const value = entry && typeof entry === "object" ? (entry as Record<string, unknown>).cached_tokens : 0;
    return total + (typeof value === "number" ? value : 0);
  }, 0);
}
