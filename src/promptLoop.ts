/** The ReAct orchestrator: observe, evaluate delta, infer, execute, supervise, prune. */

import OpenAI from "openai";
import { TOOLS, ToolExecutionResult, executeTool } from "./agentTools";
import { BrowserActionError, BrowserController, PageState } from "./browserController";
import { CircuitBreakerTriggered, LoopGuard, PrunableMessage } from "./loopGuard";

export const DEFAULT_MODEL = "gpt-4o";
const MAX_TOKENS = 1536;
const ZERO_DELTA_WARNING =
  "Warning: Last action produced zero visual or DOM changes. Choose an alternate element or approach.";
const MAX_API_RETRIES_DEFAULT = 3;

export interface AgentResult {
  success: boolean;
  summary: string;
  stepsTaken: number;
  elapsedSeconds: number;
  terminationReason: string;
}

export type AgentEvent = Record<string, unknown>;
export type OnEvent = (event: AgentEvent) => void;
export type OnHumanVerification = (state: PageState) => Promise<void> | void;

interface ExtractedToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AgentOrchestratorOptions {
  task: string;
  browser: BrowserController;
  apiKey?: string;
  model?: string;
  maxSteps?: number;
  maxDurationSeconds?: number;
  keepRecentImages?: number;
  maxApiRetries?: number;
  onEvent?: OnEvent;
  onHumanVerification?: OnHumanVerification;
}

type ChatMessage =
  | OpenAI.Chat.Completions.ChatCompletionMessageParam
  | { role: "assistant"; content: string | null; tool_calls?: unknown[] };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableOpenAIError(err: unknown): boolean {
  return (
    err instanceof OpenAI.APIConnectionError ||
    err instanceof OpenAI.RateLimitError ||
    err instanceof OpenAI.APIError
  );
}

export class AgentOrchestrator {
  private readonly task: string;
  private readonly browser: BrowserController;
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly keepRecentImages: number;
  private readonly maxApiRetries: number;
  private readonly onEvent?: OnEvent;
  private readonly onHumanVerification?: OnHumanVerification;
  private readonly loopGuard: LoopGuard;
  private readonly messages: ChatMessage[] = [];
  private readonly systemPrompt: string;

  constructor(options: AgentOrchestratorOptions) {
    const task = options.task.trim();
    if (!task) {
      throw new Error("task must be a non-empty string");
    }
    const keepRecentImages = options.keepRecentImages ?? 2;
    if (keepRecentImages < 0) {
      throw new Error("keepRecentImages must be non-negative");
    }
    const maxApiRetries = options.maxApiRetries ?? MAX_API_RETRIES_DEFAULT;
    if (maxApiRetries <= 0) {
      throw new Error("maxApiRetries must be a positive integer");
    }

    const resolvedKey = options.apiKey ?? process.env.OPENAI_API_KEY;
    if (!resolvedKey) {
      throw new Error("OPENAI_API_KEY is not set and no apiKey was provided.");
    }

    this.task = task;
    this.browser = options.browser;
    this.client = new OpenAI({ apiKey: resolvedKey });
    this.model = options.model ?? DEFAULT_MODEL;
    this.keepRecentImages = keepRecentImages;
    this.maxApiRetries = maxApiRetries;
    this.onEvent = options.onEvent;
    this.onHumanVerification = options.onHumanVerification;
    this.loopGuard = new LoopGuard(options.maxSteps ?? 20, options.maxDurationSeconds ?? 900.0);
    this.systemPrompt = this.buildSystemPrompt();
  }

  private buildSystemPrompt(): string {
    return (
      "You are an autonomous browser automation agent. You control a real Chromium browser " +
      "through a fixed set of tools and must accomplish the user's task in as few reliable " +
      "steps as possible.\n\n" +
      "Rules:\n" +
      "1. Ground every action in the CURRENT screenshot and interactive element list. Do not " +
      "assume an action succeeded until you observe the resulting screenshot.\n" +
      "2. Coordinates for click_coords and type_text are pixel offsets from the top-left of " +
      "the viewport shown in the latest screenshot.\n" +
      "3. If you see a warning that the last action produced no change, do not repeat it " +
      "verbatim. Try a different element, scroll, or an alternate approach.\n" +
      "4. If you receive a SYSTEM SUPERVISOR WARNING about a repetitive or oscillating loop, " +
      "you must change strategy immediately.\n" +
      "5. Call finish_task as soon as the task is verifiably complete, with a concise summary.\n" +
      "6. Call fail_task if the task is impossible, blocked, or you have exhausted reasonable " +
      "approaches.\n" +
      "7. You must call exactly one tool per turn. Never respond with plain text only.\n\n" +
      `TASK:\n${this.task}`
    );
  }

  private emit(event: AgentEvent): void {
    if (!this.onEvent) return;
    try {
      this.onEvent(event);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("onEvent callback raised; continuing without it.", err);
    }
  }

  private finish(result: AgentResult): AgentResult {
    this.emit({
      type: "terminal",
      success: result.success,
      summary: result.summary,
      terminationReason: result.terminationReason,
      stepsTaken: result.stepsTaken,
      elapsedSeconds: result.elapsedSeconds
    });
    return result;
  }

  private async handleHumanVerification(state: PageState): Promise<PageState> {
    this.emit({
      type: "human_verification",
      url: state.url,
      title: state.title,
      screenshotB64: state.screenshotB64,
      message:
        "A human-verification or CAPTCHA page was detected. Solve it in the visible browser " +
        "window, then signal the agent to resume."
    });

    const waitStarted = Date.now();
    if (this.onHumanVerification) {
      try {
        await this.onHumanVerification(state);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("onHumanVerification hook raised; continuing without a pause.", err);
      }
    } else {
      // eslint-disable-next-line no-console
      console.warn(
        `Human verification page detected at ${state.url} but no onHumanVerification hook was ` +
          "configured; continuing without pausing."
      );
    }
    this.loopGuard.extendDeadline((Date.now() - waitStarted) / 1000);

    let resolvedState: PageState;
    try {
      resolvedState = await this.browser.captureState();
    } catch {
      return state;
    }
    this.emit({
      type: "human_verification_resolved",
      url: resolvedState.url,
      title: resolvedState.title,
      screenshotB64: resolvedState.screenshotB64
    });
    return resolvedState;
  }

  async run(): Promise<AgentResult> {
    let step = 0;
    let lastToolCallId: string | null = null;
    let lastExecResult: ToolExecutionResult | null = null;
    let warningText: string | null = null;
    let directiveText: string | null = null;

    if (this.messages.length === 0) {
      this.messages.push({ role: "system", content: this.systemPrompt });
    }

    let state: PageState;
    try {
      state = await this.browser.captureState();
    } catch (err) {
      return this.finish({
        success: false,
        summary: `Failed to capture initial page state: ${(err as Error).message}`,
        stepsTaken: 0,
        elapsedSeconds: this.loopGuard.elapsedSeconds(),
        terminationReason: "initial_observation_error"
      });
    }

    if (state.requiresHumanVerification) {
      state = await this.handleHumanVerification(state);
    }

    this.emit({
      type: "observe",
      step: 0,
      url: state.url,
      title: state.title,
      screenshotB64: state.screenshotB64
    });

    // eslint-disable-next-line no-constant-condition
    while (true) {
      step += 1;
      try {
        this.loopGuard.checkCircuitBreaker(step);
      } catch (err) {
        if (err instanceof CircuitBreakerTriggered) {
          return this.finish({
            success: false,
            summary: `Stopped by circuit breaker: ${err.message}`,
            stepsTaken: step - 1,
            elapsedSeconds: this.loopGuard.elapsedSeconds(),
            terminationReason: "circuit_breaker"
          });
        }
        throw err;
      }

      this.appendObservation(step, state, lastToolCallId, lastExecResult, warningText, directiveText);
      const pruned = this.loopGuard.pruneContext(this.messages as PrunableMessage[], this.keepRecentImages);
      if (pruned) {
        // eslint-disable-next-line no-console
        console.debug(`Pruned ${pruned} archived screenshot(s) from context.`);
      }

      let response: OpenAI.Chat.Completions.ChatCompletion;
      try {
        response = await this.callLlm();
      } catch (err) {
        return this.finish({
          success: false,
          summary: `LLM call failed after retries: ${(err as Error).message}`,
          stepsTaken: step - 1,
          elapsedSeconds: this.loopGuard.elapsedSeconds(),
          terminationReason: "llm_error"
        });
      }

      const message = response.choices[0].message;
      this.messages.push(this.serializeAssistantMessage(message));
      const toolCall = this.extractToolCall(message);
      if (!toolCall) {
        lastToolCallId = null;
        lastExecResult = { ok: false, message: "No tool call was produced. You must call exactly one tool." };
        warningText = null;
        directiveText = null;
        continue;
      }

      if (toolCall.name === "finish_task") {
        const summary = typeof toolCall.input.summary === "string" ? toolCall.input.summary : "Task completed.";
        return this.finish({
          success: true,
          summary,
          stepsTaken: step,
          elapsedSeconds: this.loopGuard.elapsedSeconds(),
          terminationReason: "finish_task"
        });
      }
      if (toolCall.name === "fail_task") {
        const reason = typeof toolCall.input.reason === "string" ? toolCall.input.reason : "Task failed.";
        return this.finish({
          success: false,
          summary: reason,
          stepsTaken: step,
          elapsedSeconds: this.loopGuard.elapsedSeconds(),
          terminationReason: "fail_task"
        });
      }

      const preHash = state.stateHash;
      let execResult = await executeTool(toolCall.name, toolCall.input, this.browser);

      try {
        state = await this.browser.captureState();
      } catch (err) {
        execResult = {
          ok: false,
          message: `${execResult.message} (post-action observation failed: ${(err as Error).message})`
        };
        // `state` keeps its previous value so the loop can still proceed.
      }

      const supervision = this.loopGuard.supervise(step, toolCall.name, toolCall.input, preHash, state.stateHash);
      warningText = supervision.zeroDeltaWarning && execResult.ok ? ZERO_DELTA_WARNING : null;
      directiveText = supervision.directive;
      this.emit({
        type: "step",
        step,
        toolName: toolCall.name,
        toolInput: toolCall.input,
        ok: execResult.ok,
        message: execResult.message,
        url: state.url,
        title: state.title,
        screenshotB64: state.screenshotB64,
        warning: warningText,
        directive: directiveText
      });
      lastToolCallId = toolCall.id;
      lastExecResult = execResult;

      if (state.requiresHumanVerification) {
        state = await this.handleHumanVerification(state);
      }
    }
  }

  private appendObservation(
    step: number,
    state: PageState,
    lastToolCallId: string | null,
    lastExecResult: ToolExecutionResult | null,
    warningText: string | null,
    directiveText: string | null
  ): void {
    // OpenAI's "tool" role messages must carry plain string content, so the tool result and
    // the next observation (text + image) are sent as two separate messages.
    if (lastToolCallId !== null && lastExecResult !== null) {
      this.messages.push({
        role: "tool",
        tool_call_id: lastToolCallId,
        content: lastExecResult.message
      });
    }

    const lines: string[] = [];
    if (step === 1) {
      lines.push(`TASK: ${this.task}`);
    }
    lines.push(`Step ${step} observation:`);
    lines.push(`URL: ${state.url}`);
    lines.push(`Title: ${state.title}`);
    if (state.elements.length > 0) {
      lines.push('Interactive elements (mark_id: tag[type/role] "text" @ (x, y) size wxh):');
      for (const element of state.elements) {
        const descriptor = element.elementType || element.role;
        const tagLabel = descriptor ? `${element.tag}[${descriptor}]` : element.tag;
        lines.push(
          `  #${element.markId} ${tagLabel} "${element.text}" @ (${element.x}, ${element.y}) ` +
            `size ${element.width}x${element.height}`
        );
      }
    } else {
      lines.push("No interactive elements were detected in the current viewport.");
    }
    if (warningText) {
      lines.push("");
      lines.push(warningText);
    }
    if (directiveText) {
      lines.push("");
      lines.push(directiveText);
    }

    this.messages.push({
      role: "user",
      content: [
        { type: "text", text: lines.join("\n") },
        {
          type: "image_url",
          image_url: { url: `data:image/png;base64,${state.screenshotB64}`, detail: "auto" }
        }
      ]
    } as OpenAI.Chat.Completions.ChatCompletionUserMessageParam);
  }

  private async callLlm(): Promise<OpenAI.Chat.Completions.ChatCompletion> {
    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= this.maxApiRetries; attempt += 1) {
      try {
        return await this.client.chat.completions.create({
          model: this.model,
          max_tokens: MAX_TOKENS,
          tools: TOOLS,
          tool_choice: "required",
          parallel_tool_calls: false,
          messages: this.messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[]
        });
      } catch (err) {
        if (!isRetryableOpenAIError(err)) {
          throw err;
        }
        lastErr = err;
        if (attempt === this.maxApiRetries) {
          break;
        }
        const backoffMs = Math.min(2 ** attempt, 10) * 1000;
        // eslint-disable-next-line no-console
        console.warn(
          `OpenAI API call failed (attempt ${attempt}/${this.maxApiRetries}): ${
            (err as Error).message
          }. Retrying in ${backoffMs / 1000}s.`
        );
        await sleep(backoffMs);
      }
    }
    throw new Error(`Exhausted retries calling the OpenAI API: ${(lastErr as Error)?.message ?? lastErr}`);
  }

  private serializeAssistantMessage(
    message: OpenAI.Chat.Completions.ChatCompletionMessage
  ): ChatMessage {
    const serialized: { role: "assistant"; content: string | null; tool_calls?: unknown[] } = {
      role: "assistant",
      content: message.content
    };
    if (message.tool_calls && message.tool_calls.length > 0) {
      serialized.tool_calls = message.tool_calls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.function.name, arguments: call.function.arguments }
      }));
    }
    return serialized;
  }

  private extractToolCall(message: OpenAI.Chat.Completions.ChatCompletionMessage): ExtractedToolCall | null {
    if (!message.tool_calls || message.tool_calls.length === 0) {
      return null;
    }
    const call = message.tool_calls[0];
    let input: Record<string, unknown> = {};
    try {
      input = call.function.arguments ? JSON.parse(call.function.arguments) : {};
    } catch {
      input = {};
    }
    return { id: call.id, name: call.function.name, input };
  }
}
