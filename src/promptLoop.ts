/** The ReAct orchestrator: observe, evaluate delta, infer, execute, supervise, prune. */

import OpenAI from "openai";
import { TOOLS, ToolExecutionResult, executeTool } from "./agentTools";
import { BrowserActionError, BrowserController, PageState } from "./browserController";
import { CircuitBreakerTriggered, LoopGuard, PrunableMessage } from "./loopGuard";

export const DEFAULT_MODEL = "gpt-4o-mini";
const MAX_TOKENS = 1200;
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
  botName?: string;
  expertise?: string;
  collaborationContext?: string;
  browser: BrowserController;
  apiKey?: string;
  baseURL?: string;
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

/**
 * Heuristic check: does this user request work in Codex text/tool mode without needing
 * a live browser screenshot on Step 1?
 * We only capture an initial browser state if the user explicitly asks to interact with
 * a live webpage/social account (and NOT when analyzing a YouTube video, coding, researching, etc.).
 */
export function requiresInitialBrowserState(task: string, browserUrl: string): boolean {
  const lower = task.toLowerCase();
  // YouTube understanding is always handled headlessly via `understand_youtube_video` (Codex-style)
  if (/youtube\.com|youtu\.be|\byoutube\b|understand_youtube_video/.test(lower) && !/\b(open in browser|watch in browser)\b/.test(lower)) {
    return false;
  }
  // Explicit headless Codex tool requests never need initial browser state
  if (/\b(web_search|workspace_file|create_document|calculate)\b/.test(lower) && !/\b(click|instagram|x\.com|twitter|linkedin|current page|on this page)\b/.test(lower)) {
    return false;
  }
  const explicitBrowserIntent =
    /\b(open in browser|navigate to|go to|browse|click|scroll|follower|following|post|profile|bio|account|instagram|twitter|x\.com|linkedin|github|login|sign in|scrape|on this page|current page|on screen)\b/.test(
      lower
    );
  if (explicitBrowserIntent) return true;
  if (browserUrl && browserUrl !== "about:blank" && /\b(this page|current page|here|on screen)\b/.test(lower)) {
    return true;
  }
  return false;
}

export class AgentOrchestrator {
  private readonly task: string;
  private readonly botName: string;
  private readonly expertise: string;
  private readonly collaborationContext: string;
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
    const keepRecentImages = options.keepRecentImages ?? 1;
    if (keepRecentImages < 0) {
      throw new Error("keepRecentImages must be non-negative");
    }
    const maxApiRetries = options.maxApiRetries ?? MAX_API_RETRIES_DEFAULT;
    if (maxApiRetries <= 0) {
      throw new Error("maxApiRetries must be a positive integer");
    }

    const isGrokModel = Boolean(options.model && options.model.toLowerCase().startsWith("grok"));
    const resolvedKey =
      options.apiKey ??
      (isGrokModel ? process.env.XAI_API_KEY || process.env.OPENAI_API_KEY : process.env.OPENAI_API_KEY);
    if (!resolvedKey) {
      throw new Error("API key is not set. Configure OPENAI_API_KEY (or XAI_API_KEY) in Settings.");
    }
    const resolvedBaseURL =
      options.baseURL ?? (isGrokModel ? process.env.XAI_BASE_URL || "https://api.x.ai/v1" : process.env.OPENAI_BASE_URL);

    this.task = task;
    this.botName = options.botName?.trim() || "Browser Agent";
    this.expertise = options.expertise?.trim() || "general research and execution";
    this.collaborationContext = options.collaborationContext?.trim() || "";
    this.browser = options.browser;
    this.client = new OpenAI({
      apiKey: resolvedKey,
      ...(resolvedBaseURL ? { baseURL: resolvedBaseURL } : {})
    });
    this.model = options.model || DEFAULT_MODEL;
    this.keepRecentImages = keepRecentImages;
    this.maxApiRetries = maxApiRetries;
    this.onEvent = options.onEvent;
    this.onHumanVerification = options.onHumanVerification;
    this.loopGuard = new LoopGuard(options.maxSteps ?? 25, options.maxDurationSeconds ?? 900.0);
    this.systemPrompt = this.buildSystemPrompt();
  }

  private buildSystemPrompt(): string {
    return (
      `You are ${this.botName}. Role & Purpose: ${this.expertise}.\n` +
      "You operate like Codex + Grok with two execution modes:\n" +
      "- CODEX HEADLESS TOOLS (Fast & Low-Token, NO Browser Needed): `understand_youtube_video` (extracts YouTube title, description, chapters & full spoken transcript over HTTP and lets you apply its concepts), `web_search`, `calculate`, `create_document`, `workspace_file`.\n" +
      "- LIVE BROWSER TOOLS (When interacting with a webpage or signed-in account): `navigate`, `click_mark`, `type_mark`, `click_element`, `click_coords`, `type_text`, `extract_page_data`, `scroll_page`, `go_back`, `key_press`, `wait`.\n" +
      "Rules:\n" +
      "1. Check `[Detected Stats: ...]` and `Text:` in the observation FIRST! If the requested numbers (e.g. posts, followers, following, bio, prices) are already present in `[Detected Stats]` or `Text:`, immediately call `finish_task` (or reply directly) with the exact numbers.\n" +
      "2. After clicking a profile/navigation link on a Single-Page App (like Instagram or X), if the stats haven't appeared yet, call `extract_page_data` (with `selector: \"header\"` or `mode: \"text\"`) or `wait` (2 seconds) — NEVER call `fail_task` on the first try.\n" +
      "3. For YouTube links or video learning requests, ALWAYS call `understand_youtube_video` instead of `navigate`, then synthesize and apply the concepts.\n" +
      "4. Never expose credentials. Ask before financial transactions or public posting/deleting unless approved.\n" +
      (this.collaborationContext ? `\nCONTEXT:\n${this.collaborationContext}\n` : "")
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
        "A human-verification or sign-in page was detected. Complete it in the live browser " +
        "panel on the right, then click 'I've handled it — resume'."
    });

    const waitStarted = Date.now();
    if (this.onHumanVerification) {
      try {
        await this.onHumanVerification(state);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("onHumanVerification hook raised; continuing without a pause.", err);
      }
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

    const currentUrl = this.browser.isStarted ? this.browser.currentUrl() : "about:blank";
    const skipInitialScreenshot = !requiresInitialBrowserState(this.task, currentUrl);
    let state: PageState | null = null;

    if (!skipInitialScreenshot && this.browser.isStarted) {
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
    }

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
      this.loopGuard.pruneContext(this.messages as PrunableMessage[], this.keepRecentImages);

      let response: OpenAI.Chat.Completions.ChatCompletion;
      try {
        response = await this.callLlm();
      } catch (err) {
        return this.finish({
          success: false,
          summary: `LLM call failed: ${(err as Error).message}`,
          stepsTaken: step - 1,
          elapsedSeconds: this.loopGuard.elapsedSeconds(),
          terminationReason: "llm_error"
        });
      }

      const message = response.choices[0].message;
      this.messages.push(this.serializeAssistantMessage(message));
      const toolCall = this.extractToolCall(message);
      if (!toolCall) {
        // Conversational fast-path: if the model answered directly in plain text/Markdown, finish immediately!
        const directReply = (message.content ?? "").trim();
        if (directReply) {
          return this.finish({
            success: true,
            summary: directReply,
            stepsTaken: step,
            elapsedSeconds: this.loopGuard.elapsedSeconds(),
            terminationReason: "direct_reply"
          });
        }
        lastToolCallId = null;
        lastExecResult = { ok: false, message: "Call a tool or provide a final response." };
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
        // Guard against premature Step 1-2 failure after an SPA route transition (e.g. clicking Profile on Instagram)
        if (step <= 2 && this.browser.isStarted) {
          try {
            await this.browser.wait(1.2);
            state = await this.browser.captureState();
            lastToolCallId = toolCall.id;
            lastExecResult = {
              ok: true,
              message:
                "Refreshed live DOM after SPA transition. Re-check `[Detected Stats]` and `Text:` in the observation below — if the requested info (such as follower/following/post counts) is now visible, call `finish_task` with the answer!"
            };
            warningText = null;
            directiveText = null;
            continue;
          } catch {
            // Fall through to normal fail_task if refresh fails
          }
        }
        return this.finish({
          success: false,
          summary: reason,
          stepsTaken: step,
          elapsedSeconds: this.loopGuard.elapsedSeconds(),
          terminationReason: "fail_task"
        });
      }

      const isNonBrowserTool =
        toolCall.name === "understand_youtube_video" ||
        toolCall.name === "web_search" ||
        toolCall.name === "calculate" ||
        toolCall.name === "create_document" ||
        toolCall.name === "workspace_file";

      if (!isNonBrowserTool && !this.browser.isStarted) {
        await this.browser.start();
      }

      const preHash = state?.stateHash ?? "none";
      let execResult = await executeTool(toolCall.name, toolCall.input, this.browser);

      if (!isNonBrowserTool && this.browser.isStarted) {
        try {
          state = await this.browser.captureState();
        } catch (err) {
          execResult = {
            ok: false,
            message: `${execResult.message} (post-action observation failed: ${(err as Error).message})`
          };
        }
      }

      const isNonVisualTool = isNonBrowserTool || toolCall.name === "extract_page_data";
      const postHash = state?.stateHash ?? "none";
      const supervision = this.loopGuard.supervise(
        step,
        toolCall.name,
        toolCall.input,
        preHash,
        isNonVisualTool ? `${postHash}_${step}` : postHash
      );
      warningText = !isNonVisualTool && supervision.zeroDeltaWarning && execResult.ok ? ZERO_DELTA_WARNING : null;
      directiveText = supervision.directive;
      this.emit({
        type: "step",
        step,
        toolName: toolCall.name,
        toolInput: toolCall.input,
        ok: execResult.ok,
        message: execResult.message.split("\n")[0].slice(0, 180),
        artifactUrl: execResult.artifactUrl,
        url: isNonBrowserTool ? undefined : state?.url,
        title: isNonBrowserTool ? undefined : state?.title,
        screenshotB64: isNonBrowserTool ? undefined : state?.screenshotB64,
        warning: warningText,
        directive: directiveText
      });
      lastToolCallId = toolCall.id;
      lastExecResult = execResult;

      if (state?.requiresHumanVerification) {
        state = await this.handleHumanVerification(state);
      }
    }
  }

  private appendObservation(
    step: number,
    state: PageState | null,
    lastToolCallId: string | null,
    lastExecResult: ToolExecutionResult | null,
    warningText: string | null,
    directiveText: string | null
  ): void {
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
    if (state) {
      lines.push(`Step ${step} | URL: ${state.url} | Title: ${state.title}`);
      if (state.pageText) {
        lines.push(`Text:\n${state.pageText}`);
      }
      if (state.elements.length > 0) {
        const compactEls = state.elements.map((el) => {
          const desc = el.elementType || el.role;
          const tag = desc ? `${el.tag}[${desc}]` : el.tag;
          return `#${el.markId} ${tag} "${el.text}" @(${el.x},${el.y})`;
        });
        lines.push(`Elements: ${compactEls.join(" | ")}`);
      }
    } else if (step === 1) {
      lines.push("(Browser not needed unless you call a browser tool.)");
    }
    if (warningText) lines.push(warningText);
    if (directiveText) lines.push(directiveText);

    const includeScreenshot = Boolean(state && state.screenshotB64 && state.url !== "about:blank");
    if (includeScreenshot && state) {
      this.messages.push({
        role: "user",
        content: [
          { type: "text", text: lines.join("\n") },
          {
            type: "image_url",
            // detail: "low" uses a fixed 85 tokens per image in OpenAI Vision instead of 765-1105 tokens!
            image_url: { url: `data:image/jpeg;base64,${state.screenshotB64}`, detail: "low" }
          }
        ]
      } as OpenAI.Chat.Completions.ChatCompletionUserMessageParam);
    } else {
      this.messages.push({
        role: "user",
        content: lines.join("\n")
      });
    }
  }

  private async callLlm(): Promise<OpenAI.Chat.Completions.ChatCompletion> {
    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= this.maxApiRetries; attempt += 1) {
      try {
        return await this.client.chat.completions.create({
          model: this.model,
          max_tokens: MAX_TOKENS,
          tools: TOOLS,
          tool_choice: "auto",
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
          `LLM API call failed (attempt ${attempt}/${this.maxApiRetries}): ${
            (err as Error).message
          }. Retrying in ${backoffMs / 1000}s.`
        );
        await sleep(backoffMs);
      }
    }
    throw new Error(`Exhausted retries calling the LLM API: ${(lastErr as Error)?.message ?? lastErr}`);
  }

  private serializeAssistantMessage(
    message: OpenAI.Chat.Completions.ChatCompletionMessage
  ): ChatMessage {
    const serialized: { role: "assistant"; content: string | null; tool_calls?: unknown[] } = {
      role: "assistant",
      content: message.content
    };
    if (message.tool_calls && message.tool_calls.length > 0) {
      // Only serialize the single tool call we actually execute so OpenAI/xAI never errors on unresponded tool_call_ids
      serialized.tool_calls = message.tool_calls.slice(0, 1).map((call) => ({
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
