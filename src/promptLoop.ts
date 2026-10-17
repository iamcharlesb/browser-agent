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
  // Explicit headless Codex & Local Terminal tool requests never need initial browser state
  if (
    /\b(run_terminal_command|terminal|shell|bash|zsh|git status|git log|npm |npx |python3? |node |ls |grep |web_search|workspace_file|create_document|calculate)\b/.test(lower) &&
    !/\b(click|instagram|x\.com|twitter|linkedin|current page|on this page)\b/.test(lower)
  ) {
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
  private readonly useLocalEngine: boolean;
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

    const rawModel = (options.model || DEFAULT_MODEL).trim();
    const isLocalEngineRequested = rawModel === "local-engine";
    const isOllamaModel = rawModel.startsWith("ollama:");
    const isGrokModel = rawModel.toLowerCase().startsWith("grok");

    const cloudKey =
      options.apiKey ??
      (isGrokModel ? process.env.XAI_API_KEY || process.env.OPENAI_API_KEY : process.env.OPENAI_API_KEY);

    this.useLocalEngine = isLocalEngineRequested || (!isOllamaModel && !cloudKey);

    const resolvedKey = isOllamaModel ? "ollama-local" : cloudKey || "local-no-cloud-key";
    const resolvedBaseURL =
      options.baseURL ??
      (isOllamaModel
        ? process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434/v1"
        : isGrokModel
        ? process.env.XAI_BASE_URL || "https://api.x.ai/v1"
        : process.env.OPENAI_BASE_URL);

    this.task = task;
    this.botName = options.botName?.trim() || "Open Bot";
    this.expertise = options.expertise?.trim() || "autonomous local terminal, Codex, and browser execution";
    this.collaborationContext = options.collaborationContext?.trim() || "";
    this.browser = options.browser;
    this.client = new OpenAI({
      apiKey: resolvedKey,
      ...(resolvedBaseURL ? { baseURL: resolvedBaseURL } : {})
    });
    this.model = isOllamaModel ? rawModel.slice("ollama:".length) || "llama3.2" : rawModel;
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
      "Everything runs locally on the user's machine behind the browser (no cloud sandbox required).\n" +
      "You have three local execution modes:\n" +
      "- LOCAL TERMINAL (`run_terminal_command`): Execute real local shell commands (`node`, `python3`, `git`, `npm`, `ls`, `grep`, `curl`, tests, scripts) directly in the project workspace.\n" +
      "- CODEX HEADLESS TOOLS (Fast & Low-Token, NO Browser Needed): `understand_youtube_video` (extracts YouTube title, description, chapters & full spoken transcript over HTTP and lets you apply its concepts), `web_search`, `calculate`, `create_document`, `workspace_file`.\n" +
      "- LOCAL HEADLESS BROWSER TOOLS (Runs behind the browser UI when interacting with a live webpage or signed-in account): `navigate`, `click_mark`, `type_mark`, `click_element`, `click_coords`, `type_text`, `extract_page_data`, `scroll_page`, `go_back`, `key_press`, `wait`.\n" +
      "Rules:\n" +
      "1. SPEED: Execute actions immediately and batch independent tool calls in a single turn whenever possible to complete the job in the minimum number of steps.\n" +
      "2. Use `run_terminal_command` whenever the user asks to run terminal/shell commands, inspect system/git state, run code/scripts, or verify builds locally.\n" +
      "3. Check `[Detected Stats: ...]` and `Text:` in browser observations FIRST! If requested numbers (e.g. posts, followers, following, bio, prices) are already present, immediately call `finish_task` (or reply directly) with the exact numbers.\n" +
      "4. After clicking a profile/navigation link on a Single-Page App (like Instagram or X), if stats haven't appeared yet, call `extract_page_data` (with `selector: \"header\"` or `mode: \"text\"`) or `wait` (1 second) — NEVER call `fail_task` on the first try.\n" +
      "5. For YouTube links or video learning requests, ALWAYS call `understand_youtube_video` instead of `navigate`, then synthesize and apply the concepts.\n" +
      "6. Never expose credentials. Ask before financial transactions or public posting/deleting unless approved.\n" +
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

  private extractUserRequestCore(): string {
    const marker = "User request:";
    const idx = this.task.lastIndexOf(marker);
    return idx >= 0 ? this.task.slice(idx + marker.length).trim() : this.task.trim();
  }

  private async runLocalEngine(): Promise<AgentResult> {
    const rawRequest = this.extractUserRequestCore();
    const outputs: string[] = [];
    let steps = 0;

    const emitLocalStep = (
      toolName: string,
      toolInput: Record<string, unknown>,
      res: ToolExecutionResult,
      state?: PageState | null
    ) => {
      steps += 1;
      this.emit({
        type: "step",
        step: steps,
        toolName,
        toolInput,
        ok: res.ok,
        message: res.message.split("\n")[0].slice(0, 180),
        artifactUrl: res.artifactUrl,
        terminalEntry: res.terminalEntry,
        url: state?.url,
        title: state?.title,
        screenshotB64: state?.screenshotB64
      });
    };

    // 1. Check for explicit terminal / shell command requests
    const cmdMatch =
      /(?:^\$\s*(.+)$)|(?:run\s+(?:the\s+)?(?:terminal\s+|shell\s+)?command\s+[`"']?([^`"'\n]+)[`"']?)|(?:`((?:git|ls|pwd|node|npm|npx|python3?|pip|cat|grep|find|uname|whoami|date|echo|curl)\b[^`]+)`)/im.exec(
        rawRequest
      );
    if (cmdMatch || /^(?:git|ls|pwd|node|npm|npx|python3?|uname|whoami|date|echo)\b/i.test(rawRequest)) {
      const cmd = (cmdMatch ? cmdMatch[1] || cmdMatch[2] || cmdMatch[3] : rawRequest).trim();
      const res = await executeTool("run_terminal_command", { command: cmd }, this.browser);
      emitLocalStep("run_terminal_command", { command: cmd }, res);
      outputs.push(
        `### Local Terminal Execution\nCommand: \`$ ${cmd}\`\n\`\`\`text\n${
          (res.terminalEntry?.stdout || res.terminalEntry?.stderr || res.message).trim()
        }\n\`\`\``
      );
    }

    // 2. Check for YouTube video understanding
    const ytMatch = /(https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=[^\s&]+|youtu\.be\/[^\s?&]+|youtube\.com\/shorts\/[^\s?&]+))/i.exec(
      rawRequest
    );
    if (ytMatch || /\byoutube\b/i.test(rawRequest)) {
      const target = ytMatch ? ytMatch[1] : rawRequest;
      const res = await executeTool("understand_youtube_video", { urlOrQuery: target }, this.browser);
      emitLocalStep("understand_youtube_video", { urlOrQuery: target }, res);
      outputs.push(`### YouTube Video Analysis (Local Headless)\n${res.message.slice(0, 3500)}`);
    }

    // 3. Check for live browser navigation / scraping behind the browser
    const urlMatch = /(https?:\/\/[^\s)]+)/i.exec(rawRequest);
    if (urlMatch && !ytMatch) {
      const targetUrl = urlMatch[1];
      if (!this.browser.isStarted) {
        await this.browser.start();
      }
      const navRes = await executeTool("navigate", { url: targetUrl }, this.browser);
      const state = await this.browser.captureState().catch(() => null);
      emitLocalStep("navigate", { url: targetUrl }, navRes, state);
      const extRes = await executeTool("extract_page_data", { mode: "text" }, this.browser);
      emitLocalStep("extract_page_data", { mode: "text" }, extRes, state);
      outputs.push(`### Local Headless Browser Extraction (${targetUrl})\n${extRes.message.slice(0, 2500)}`);
    }

    // 4. Fallback to local web search + workspace summary if no other tool matched
    if (outputs.length === 0) {
      const searchRes = await executeTool("web_search", { query: rawRequest.slice(0, 120) }, this.browser);
      emitLocalStep("web_search", { query: rawRequest.slice(0, 120) }, searchRes);
      outputs.push(`### Local Research Results (Zero Cloud)\n${searchRes.message}`);
    }

    return this.finish({
      success: true,
      summary: outputs.join("\n\n"),
      stepsTaken: Math.max(1, steps),
      elapsedSeconds: this.loopGuard.elapsedSeconds(),
      terminationReason: "finish_task"
    });
  }

  /**
   * Pre-executes obvious first actions (direct `$ command`, YouTube URL extraction, or explicit
   * target URL navigation) BEFORE waiting on the first LLM round-trip so the user sees immediate
   * action within milliseconds of submitting a job.
   */
  private async preExecuteFirstAction(): Promise<{
    instantFinish?: AgentResult;
    preExecutedContext?: string;
    initialState?: PageState | null;
    stepsUsed: number;
  }> {
    const rawRequest = this.extractUserRequestCore();

    // 1. Direct `$ <command>` shell invocation: run immediately in <30ms and return without waiting on LLM
    const directShellMatch = /^\$\s*([^\n]+)$/.exec(rawRequest);
    if (directShellMatch) {
      const cmd = directShellMatch[1].trim();
      const res = await executeTool("run_terminal_command", { command: cmd }, this.browser);
      this.emit({
        type: "step",
        step: 1,
        toolName: "run_terminal_command",
        toolInput: { command: cmd },
        ok: res.ok,
        message: res.message.split("\n")[0].slice(0, 180),
        terminalEntry: res.terminalEntry
      });
      const out = (res.terminalEntry?.stdout || res.terminalEntry?.stderr || res.message).trim();
      return {
        stepsUsed: 1,
        instantFinish: this.finish({
          success: res.ok,
          summary: `Executed \`$ ${cmd}\` locally (${res.terminalEntry?.durationMs ?? 0}ms):\n\`\`\`text\n${out}\n\`\`\``,
          stepsTaken: 1,
          elapsedSeconds: this.loopGuard.elapsedSeconds(),
          terminationReason: "finish_task"
        })
      };
    }

    // 2. YouTube video URL in prompt: immediately extract video metadata & transcript before Turn 1
    const ytMatch =
      /(https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=[^\s&)]+|youtu\.be\/[^\s?&)]+|youtube\.com\/shorts\/[^\s?&)]+))/i.exec(
        rawRequest
      );
    if (ytMatch && !/\b(open in browser|watch in browser)\b/i.test(rawRequest)) {
      const videoUrl = ytMatch[1];
      const res = await executeTool("understand_youtube_video", { urlOrQuery: videoUrl }, this.browser);
      this.emit({
        type: "step",
        step: 1,
        toolName: "understand_youtube_video",
        toolInput: { urlOrQuery: videoUrl },
        ok: res.ok,
        message: res.message.split("\n")[0].slice(0, 180)
      });
      return {
        stepsUsed: 1,
        preExecutedContext: `[PRE-EXECUTED TOOL OUTPUT: understand_youtube_video("${videoUrl}")]\n${res.message}\n(You already have the full video analysis above — synthesize your response or take the next step immediately without calling understand_youtube_video again.)`
      };
    }

    // 3. Explicit non-YouTube URL in browser request: navigate immediately so Step 1 starts on the target page
    const urlMatch = /(https?:\/\/[^\s)"'>]+)/i.exec(rawRequest);
    if (urlMatch && !ytMatch) {
      const targetUrl = urlMatch[1];
      if (!this.browser.isStarted) {
        await this.browser.start();
      }
      const cur = this.browser.currentUrl();
      if (!cur || cur === "about:blank" || !cur.startsWith(targetUrl.slice(0, 24))) {
        const navRes = await executeTool("navigate", { url: targetUrl }, this.browser);
        const state = await this.browser.captureState().catch(() => null);
        this.emit({
          type: "step",
          step: 1,
          toolName: "navigate",
          toolInput: { url: targetUrl },
          ok: navRes.ok,
          message: navRes.message,
          url: state?.url,
          title: state?.title,
          screenshotB64: state?.screenshotB64
        });
        return {
          stepsUsed: 1,
          initialState: state,
          preExecutedContext: `[PRE-EXECUTED NAVIGATION: Already navigated to ${state?.url || targetUrl}. Do not call navigate("${targetUrl}") again.]`
        };
      }
    }

    return { stepsUsed: 0 };
  }

  async run(): Promise<AgentResult> {
    if (this.useLocalEngine) {
      return this.runLocalEngine();
    }

    const pre = await this.preExecuteFirstAction();
    if (pre.instantFinish) {
      return pre.instantFinish;
    }

    let step = pre.stepsUsed;
    let pendingToolOutputs: Array<{ id: string; result: ToolExecutionResult }> = [];
    let warningText: string | null = null;
    let directiveText: string | null = null;
    const preContext = pre.preExecutedContext ?? null;

    if (this.messages.length === 0) {
      this.messages.push({ role: "system", content: this.systemPrompt });
    }

    const currentUrl = this.browser.isStarted ? this.browser.currentUrl() : "about:blank";
    const skipInitialScreenshot = !requiresInitialBrowserState(this.task, currentUrl);
    let state: PageState | null = pre.initialState ?? null;

    if (!state && !skipInitialScreenshot && this.browser.isStarted) {
      try {
        state = await this.browser.captureState();
      } catch (err) {
        return this.finish({
          success: false,
          summary: `Failed to capture initial page state: ${(err as Error).message}`,
          stepsTaken: step,
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

    let isFirstTurn = true;

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

      this.appendObservation(
        step,
        isFirstTurn,
        state,
        pendingToolOutputs,
        warningText,
        directiveText,
        isFirstTurn ? preContext : null
      );
      isFirstTurn = false;
      this.loopGuard.pruneContext(this.messages as PrunableMessage[], this.keepRecentImages);

      let response: OpenAI.Chat.Completions.ChatCompletion;
      try {
        response = await this.callLlm();
      } catch {
        // If cloud API or local Ollama is unreachable on first turn, automatically fall back to our zero-cloud local engine!
        if (step <= 2) {
          return this.runLocalEngine();
        }
        return this.finish({
          success: false,
          summary: "LLM endpoint unreachable; switch to 'Local Engine (Zero Cloud)' in Settings or check your connection.",
          stepsTaken: step - 1,
          elapsedSeconds: this.loopGuard.elapsedSeconds(),
          terminationReason: "llm_error"
        });
      }

      const message = response.choices[0].message;
      const toolCalls = this.extractToolCalls(message);
      this.messages.push(this.serializeAssistantMessage(message, toolCalls.length));

      if (toolCalls.length === 0) {
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
        pendingToolOutputs = [];
        warningText = null;
        directiveText = null;
        continue;
      }

      pendingToolOutputs = [];
      let touchedBrowserInBatch = false;
      const preHash = state?.stateHash ?? "none";

      for (let i = 0; i < toolCalls.length; i += 1) {
        const toolCall = toolCalls[i];
        if (i > 0) {
          step += 1;
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
          if (step <= 2 && this.browser.isStarted) {
            try {
              await this.browser.wait(0.6);
              state = await this.browser.captureState();
              pendingToolOutputs.push({
                id: toolCall.id,
                result: {
                  ok: true,
                  message:
                    "Refreshed live DOM after SPA transition. Re-check `[Detected Stats]` and `Text:` in the observation below — if the requested info is now visible, call `finish_task` with the answer!"
                }
              });
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
          toolCall.name === "run_terminal_command" ||
          toolCall.name === "understand_youtube_video" ||
          toolCall.name === "web_search" ||
          toolCall.name === "calculate" ||
          toolCall.name === "create_document" ||
          toolCall.name === "workspace_file";

        if (!isNonBrowserTool) {
          touchedBrowserInBatch = true;
          if (!this.browser.isStarted) {
            await this.browser.start();
          }
        }

        const execResult = await executeTool(toolCall.name, toolCall.input, this.browser);
        pendingToolOutputs.push({ id: toolCall.id, result: execResult });

        // Capture browser state only on the last browser tool in the batch (or if the next tool depends on fresh markIds)
        const nextCall = toolCalls[i + 1];
        const nextNeedsFreshMarks =
          nextCall && (nextCall.name === "click_mark" || nextCall.name === "type_mark");

        if (!isNonBrowserTool && this.browser.isStarted && (i === toolCalls.length - 1 || nextNeedsFreshMarks)) {
          try {
            state = await this.browser.captureState();
          } catch (err) {
            pendingToolOutputs[pendingToolOutputs.length - 1].result = {
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
          terminalEntry: execResult.terminalEntry,
          url: isNonBrowserTool ? undefined : state?.url,
          title: isNonBrowserTool ? undefined : state?.title,
          screenshotB64: isNonBrowserTool ? undefined : state?.screenshotB64,
          warning: warningText,
          directive: directiveText
        });
      }

      if (touchedBrowserInBatch && state?.requiresHumanVerification) {
        state = await this.handleHumanVerification(state);
      }
    }
  }

  private appendObservation(
    step: number,
    isFirstTurn: boolean,
    state: PageState | null,
    pendingToolOutputs: Array<{ id: string; result: ToolExecutionResult }>,
    warningText: string | null,
    directiveText: string | null,
    preExecutedContext: string | null
  ): void {
    for (const item of pendingToolOutputs) {
      this.messages.push({
        role: "tool",
        tool_call_id: item.id,
        content: item.result.message
      });
    }

    const lines: string[] = [];
    if (isFirstTurn) {
      lines.push(`TASK: ${this.task}`);
      if (preExecutedContext) {
        lines.push(preExecutedContext);
      }
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
    } else if (isFirstTurn && !preExecutedContext) {
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
          parallel_tool_calls: true,
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
        const backoffMs = Math.min(400 * attempt, 2000);
        // eslint-disable-next-line no-console
        console.warn(
          `LLM API call failed (attempt ${attempt}/${this.maxApiRetries}): ${
            (err as Error).message
          }. Retrying in ${backoffMs}ms.`
        );
        await sleep(backoffMs);
      }
    }
    throw new Error(`Exhausted retries calling the LLM API: ${(lastErr as Error)?.message ?? lastErr}`);
  }

  private serializeAssistantMessage(
    message: OpenAI.Chat.Completions.ChatCompletionMessage,
    maxCalls = 4
  ): ChatMessage {
    const serialized: { role: "assistant"; content: string | null; tool_calls?: unknown[] } = {
      role: "assistant",
      content: message.content
    };
    if (message.tool_calls && message.tool_calls.length > 0 && maxCalls > 0) {
      serialized.tool_calls = message.tool_calls.slice(0, maxCalls).map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.function.name, arguments: call.function.arguments }
      }));
    }
    return serialized;
  }

  private extractToolCalls(message: OpenAI.Chat.Completions.ChatCompletionMessage): ExtractedToolCall[] {
    if (!message.tool_calls || message.tool_calls.length === 0) {
      return [];
    }
    return message.tool_calls.slice(0, 4).map((call) => {
      let input: Record<string, unknown> = {};
      try {
        input = call.function.arguments ? JSON.parse(call.function.arguments) : {};
      } catch {
        input = {};
      }
      return { id: call.id, name: call.function.name, input };
    });
  }
}
