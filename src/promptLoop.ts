/** The ReAct orchestrator: observe, evaluate delta, infer, execute, supervise, prune. */

import OpenAI from "openai";
import { findingEvidenceIssue, isAbsenceClaim } from "./findingEvidence";
import { randomUUID } from "node:crypto";
import { isReadOnlyCommand, TaskApprovalScope, TerminalApprovalDecision } from "./approvalPolicy";
import {
  classifyBrowserAction,
  describeEffectAction,
  effectRequiresApproval,
  INTERACTIVE_TOOLS,
  isCssSelector
} from "./actionEffect";
import { assessTaskRisk } from "./security";
import { TOOLS, ToolExecutionResult, executeTool } from "./agentTools";
import {
  accessDeniedRecoveryHint,
  BrowserController,
  PageState,
  SessionMode
} from "./browserController";
import {
  claudeCliModelAlias,
  claudeCliResultToChatCompletion,
  flattenMessagesForClaudeCli,
  invokeClaudeCli,
  isClaudeCliModel,
  toolsCatalogForClaudeCli
} from "./claudeCli";
import { CircuitBreakerTriggered, LoopGuard, PrunableMessage } from "./loopGuard";
import { formatObservationForSdk, runWithOpenAIAgentsSdk } from "./openaiAgentsRunner";
import { runActionScript } from "./scriptRunner";
import { ScriptToolResult } from "./scriptProtocol";

export const DEFAULT_MODEL = "gpt-6-luna";
/** Leave room for complete article text and tool arguments; the prompt keeps ordinary replies concise. */
const MAX_TOKENS = 4096;
const GPT6_REASONING_EFFORT = "low" as const;
/** Cap tool output text fed back into the model (full UI events can still show more). */
const MAX_TOOL_RESULT_CHARS = 1400;
const ZERO_DELTA_WARNING =
  "Warning: Last action produced zero visual or DOM changes. Choose an alternate element or approach.";
const MAX_API_RETRIES_DEFAULT = 3;
/** Local mutation and paid-generation tools excluded from scheduled/unattended runs. */
const PRIVILEGED_TOOL_NAMES = new Set(["run_terminal_command", "workspace_file", "create_document", "generate_image", "upload_file"]);
const INTERACTIVE_BROWSER_TOOL_NAMES = new Set(["upload_file", "click_mark", "type_mark", "click_element", "click_coords", "type_text", "key_press"]);
/** All tools that drive Playwright (excluded in Chat mode). */
const BROWSER_TOOL_NAMES = new Set([
  "list_tabs", "switch_tab", "inspect_view",
  "upload_file",
  "navigate",
  "click_mark",
  "type_mark",
  "click_element",
  "click_coords",
  "type_text",
  "extract_page_data",
  "scroll_page",
  "wait",
  "key_press",
  "go_back"
]);
const HEADLESS_RESEARCH_TOOL_NAMES = new Set([
  "web_search",
  "reddit_search",
  "google_property",
  "calculate",
  "understand_youtube_video",
  "create_document",
  "workspace_file",
  "run_terminal_command"
]);
const MUTATING_WORKSPACE_FILE_ACTIONS = new Set(["write", "append"]);
const NON_SCRIPTABLE_META_TOOLS = new Set([
  "run_action_script",
  "delegate_to_bot",
  "schedule_task",
  "finish_task",
  "fail_task"
]);
const MAX_PREMATURE_FINISH_REJECTIONS = 2;
const PREMATURE_FINISH_ADMISSION =
  /\b(i (?:haven['’]t|have not) (?:[a-z]+(?:\s+or\s+[a-z]+)?\s+)?(?:saved|published|completed|typed|entered|filled|verified|created|written|submitted|updated|anything)|no (?:posts?|articles?|drafts?|items?|changes?) (?:have been|were) (?:created|saved|published|written|drafted)|(?:editor|form|fields?|draft) (?:is|are) still (?:blank|empty|unsaved)|not attached to a (?:post|draft|article) yet|i['’]m paused at|i need to finish (?:checking|creating|writing|drafting|filling|verifying)|verify the (?:form|page|editor|site) supports [^\n.]{1,40} before (?:saving|creating|writing)|i should have saved|i got stuck|i['’]ll continue from|i (?:can|will) (?:now )?(?:prepare|create|draft|write|fill|check) [^.\n]{1,80} (?:as drafts?|next|before)|i should check for overlap before|haven['’]t verified that [a-z0-9 _-]+ was saved)\b/i;
const EXTERNAL_BLOCKER_MENTION =
  /\b(captcha|sign[- ]?in|log[- ]?in|403|access denied|blocked|approval|permission|missing credentials|cannot access)\b/i;

/**
 * Detects when the model calls `finish_task` while admitting in its own summary that it stopped
 * mid-workflow (e.g. opened the editor and generated an image, left the editor blank, or promised
 * "I'll continue from the editor and check the save state" instead of actually doing it).
 */
export function detectPrematureFinish(summary: string): string | null {
  const text = (summary ?? "").trim();
  if (!text) return null;
  if (text.endsWith("?")) return null;
  if (EXTERNAL_BLOCKER_MENTION.test(text)) return null;
  if (PREMATURE_FINISH_ADMISSION.test(text)) {
    return (
      "Premature finish_task rejected: your summary states that the work is still unsaved or the editor is still blank. " +
      "Do not stop to narrate status or apologize — execute the remaining actions now (fill the editor fields, click Save/Draft, or use run_action_script) and verify the saved state before calling finish_task."
    );
  }
  return null;
}

const PREMATURE_FAIL_PATTERN =
  /\b(did not change after click\/arrowdown|only exposed title and dropdown|no content\/seo inputs|permission to use a generated image|generate_image.*costs money|saving now would recreate an incomplete)\b/i;

export function detectPrematureFail(reason: string): string | null {
  const text = (reason ?? "").trim();
  if (!text) return null;
  if (PREMATURE_FAIL_PATTERN.test(text)) {
    return (
      "Premature fail_task rejected: (1) To change a <select> dropdown, call `type_mark(markId, text='<option label or value>')` instead of clicking and pressing ArrowDown. " +
      "(2) `generate_image` is pre-authorized when creating blog posts or articles — call `generate_image` directly without asking permission. " +
      "(3) Call `scroll_page(direction='down')` or inspect the updated `Elements:` list to fill content/SEO fields below the fold and save the draft."
    );
  }
  return null;
}

export type ObserveMode = "text" | "vision";
/** Chat = text tools only; Browse = browser read+nav; Act = full click/type with effect gates; Turbo = full autonomous auto-run. */
export type InteractionMode = "chat" | "browse" | "act" | "turbo";
/** "openai-sdk" = official @openai/agents Runner (default in UI); "cheap" = token-lean custom loop. */
export type AgentEngine = "openai-sdk" | "cheap";

function requiresPrivilegedApproval(toolName: string, input: Record<string, unknown>): boolean {
  if (toolName === "run_terminal_command") return !isReadOnlyCommand(String(input.command ?? ""));
  if (toolName === "workspace_file") {
    return MUTATING_WORKSPACE_FILE_ACTIONS.has(String(input.action ?? ""));
  }
  return false;
}

function describePrivilegedCall(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "run_terminal_command") {
    const cwd = typeof input.cwd === "string" && input.cwd ? ` (in ${input.cwd})` : "";
    return `Run shell command${cwd}: ${String(input.command ?? "")}`;
  }
  const action = String(input.action ?? "");
  const path = String(input.path ?? "");
  return `${action === "append" ? "Append to" : "Overwrite"} file: ${path}`;
}

export interface AgentResult {
  success: boolean;
  summary: string;
  stepsTaken: number;
  elapsedSeconds: number;
  terminationReason: string;
  delegateTo?: {
    targetBotName: string;
    task: string;
    handoffNote?: string;
  };
}

export type AgentEvent = Record<string, unknown>;
export type OnEvent = (event: AgentEvent) => void;
export type OnHumanVerification = (state: PageState) => Promise<void> | void;
/** Returns true to run the command/write, false to deny it. Must default to deny if unset. */
export type OnTerminalApproval = (details: { toolName: string; description: string; approvalId: string; approvalKind?: "shell" | "outward" | "irreversible" }) => Promise<TerminalApprovalDecision> | TerminalApprovalDecision;
export type OnScheduleTask = (input: Record<string, unknown>) => Promise<ToolExecutionResult>;
export type OnLearningKb = (input: Record<string, unknown>) => Promise<ToolExecutionResult>;
/**
 * Polled before every model call and every tool call. Returning true ends the run immediately.
 * Without this, "Stop" only told the UI the run was over - the loop kept calling the model and
 * kept driving the browser, so a stopped agent could still click things and spend tokens.
 */
export type ShouldAbort = () => boolean;

interface ExtractedToolCall {
  argumentError?: string;
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AgentOrchestratorOptions {
  task: string;
  botName?: string;
  expertise?: string;
  collaborationContext?: string;
  taskImages?: string[];
  onKnowledgeBase?: OnLearningKb;
  browser: BrowserController;
  apiKey?: string;
  /** Injectable transport for deterministic API tests; production uses the SDK default fetch. */
  fetch?: typeof fetch;
  baseURL?: string;
  model?: string;
  maxSteps?: number;
  maxDurationSeconds?: number;
  keepRecentImages?: number;
  maxApiRetries?: number;
  onEvent?: OnEvent;
  onHumanVerification?: OnHumanVerification;
  onTerminalApproval?: OnTerminalApproval;
  onScheduleTask?: OnScheduleTask;
  onLearningKb?: OnLearningKb;
  /** Cooperative cancellation; see ShouldAbort. */
  shouldAbort?: ShouldAbort;
  abortSignal?: AbortSignal;
  scheduleTimeZone?: string;
  /**
   * The user turned on "Approve for me", so engagement they've already scoped is approved.
   * Without this the prompt kept ordering the bot to stop and ask even after the user had said
   * yes - it asked, got a yes, then asked again on the next turn.
   */
  standingApproval?: boolean;
  /** Shared per-bot approval scope so "Allowed for this task" persists across follow-up chat turns. */
  taskApprovalScope?: TaskApprovalScope;
  /** Set false for scheduled/unattended runs: removes local writes and paid image generation. */
  allowPrivilegedTools?: boolean;
  /** Set false for unattended tasks so they can inspect pages but cannot click or type. */
  allowBrowserInteraction?: boolean;
  /**
   * Observation budget. Default `text` skips JPEG vision tokens unless CAPTCHA, access wall,
   * icon-only UI, or consecutive click failures force a vision pass.
   */
  observeMode?: ObserveMode;
  /** Product mode: chat (no browser), browse (nav/read), act (full), turbo (autonomous). Defaults to act. */
  interactionMode?: InteractionMode;
  /** Execution engine: "openai-sdk" (@openai/agents Runner) or "cheap" (token-lean custom loop). */
  agentEngine?: AgentEngine;
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
 * a live browser observation on Step 1?
 * Whenever a live browser page is ALREADY open (`browserUrl` is non-empty and not `about:blank`),
 * we always include the current browser state (unless the user is running a direct `$` command,
 * pure arithmetic, or headless YouTube transcript analysis) so follow-up turns ("yes sir",
 * "continue", "namespace should be magicsite.ai") recognize the already-opened screen instead of
 * restarting from scratch.
 */
export function requiresInitialBrowserState(task: string, browserUrl: string): boolean {
  const marker = "User request:";
  const idx = task.lastIndexOf(marker);
  const coreRequest = (idx >= 0 ? task.slice(idx + marker.length) : task).trim();
  const lower = coreRequest.toLowerCase();
  const fullLower = task.toLowerCase();

  // Direct shell command or pure arithmetic does not need browser observation
  if (/^\$\s*[^\n]+$/.test(coreRequest) || extractArithmeticExpression(coreRequest) !== null) {
    return false;
  }

  // YouTube understanding is always handled headlessly via `understand_youtube_video` (Codex-style)
  if (/youtube\.com|youtu\.be|\byoutube\b|understand_youtube_video/.test(lower) && !/\b(open in browser|watch in browser)\b/.test(lower)) {
    return false;
  }
  // Explicit headless Codex & Local Terminal tool requests never need initial browser state unless a page is already open and referenced
  if (
    /\b(run_terminal_command|terminal|shell|bash|zsh|git status|git log|npm |npx |python3? |node |ls |grep |web_search|workspace_file|create_document|calculate|other bots|my bots|workspace bots|delegate_to_bot)\b/.test(lower) &&
    !/\b(click|instagram|x\.com|twitter|linkedin|current page|on this page|browser|website|site|page|screen|admin|blog|module)\b/.test(lower)
  ) {
    return false;
  }

  // If a real browser screen is ALREADY open in the active session, always show it on Step 1
  // so the agent recognizes the open page/form on follow-up turns ("yes sir", "continue", etc.).
  if (browserUrl && browserUrl !== "about:blank") {
    return true;
  }

  const explicitBrowserIntent =
    /\b(open in browser|open|visit|navigate to|go to|browse|click|scroll|follower|following|post|article|blog|admin|module|editor|form|draft|website|site|page|profile|bio|account|instagram|twitter|x\.com|linkedin|github|login|sign in|scrape|on this page|current page|on screen)\b/.test(
      fullLower
    ) ||
    /https?:\/\/|\b[a-z0-9-]+\.(?:com|ai|io|pro|org|net|co|app|dev)\b|\/admin\b/i.test(coreRequest);
  if (explicitBrowserIntent) return true;
  return false;
}

/**
 * Pulls a pure arithmetic expression out of a request, or null if there isn't one.
 *
 * Deliberately strict: it only matches when what's left after stripping a leading "calculate"/
 * "what is" is *entirely* numbers and operators. "calculate 2 + 2" matches; "what's the revenue
 * for Q2 2024" does not, so a research question never gets handed to the calculator.
 */
export function extractArithmeticExpression(request: string): string | null {
  const stripped = request
    .trim()
    .replace(/^(?:please\s+)?(?:can you\s+)?(?:calculate|compute|evaluate|work out|what(?:'s| is))\s+/i, "")
    .replace(/[?.]+\s*$/, "")
    .replace(/\s+and\s+tell\s+me\s+the\s+answer$/i, "")
    .trim();
  if (!stripped || stripped.length > 200) return null;
  // Numbers and operators only, and at least one operator - a bare "42" is not a calculation.
  if (!/^[\d\s+\-*/^%().,]+$/.test(stripped)) return null;
  if (!/[+\-*/^%]/.test(stripped)) return null;
  if (!/\d/.test(stripped)) return null;
  return stripped;
}

export class AgentOrchestrator {
  private readonly task: string;
  private readonly botName: string;
  private readonly expertise: string;
  private readonly collaborationContext: string;
  private readonly taskImages: string[];
  private readonly onKnowledgeBase?: OnLearningKb;
  private readonly browser: BrowserController;
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly useResponsesApi: boolean;
  private readonly useClaudeCli: boolean;
  private readonly claudeCliModelAlias?: string;
  private responsesPreviousId: string | undefined;
  private responsesMessageIndex = 0;
  private readonly useLocalEngine: boolean;
  private readonly keepRecentImages: number;
  private readonly maxApiRetries: number;
  private readonly onEvent?: OnEvent;
  private readonly onHumanVerification?: OnHumanVerification;
  private readonly onTerminalApproval?: OnTerminalApproval;
  private readonly taskApproval: TaskApprovalScope;
  private readonly standingApproval: boolean;
  private readonly allowPrivilegedTools: boolean;
  private readonly onScheduleTask?: OnScheduleTask;
  private readonly onLearningKb?: OnLearningKb;
  private readonly shouldAbort?: ShouldAbort;
  private readonly abortSignal?: AbortSignal;
  private readonly scheduleTimeZone: string;
  private readonly allowBrowserInteraction: boolean;
  private readonly observeMode: ObserveMode;
  private readonly interactionMode: InteractionMode;
  private readonly agentEngine: AgentEngine;
  private readonly resolvedApiKey: string;
  private readonly resolvedBaseURL?: string;
  private readonly maxStepsConfig: number;
  private latestEvidenceState: PageState | null = null;
  private forceVisionOnce = false;
  private consecutiveClickFailures = 0;
  private prematureFinishRejections = 0;
  private scriptState: Record<string, unknown> = {};
  private readonly toolsForModel: OpenAI.Chat.Completions.ChatCompletionTool[];
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
    const useClaudeCli = isClaudeCliModel(rawModel);
    const isClaudeModel = !useClaudeCli && rawModel.toLowerCase().startsWith("claude");

    const cloudKey =
      options.apiKey ??
      (isClaudeModel
        ? process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY
        : isGrokModel
          ? process.env.XAI_API_KEY || process.env.OPENAI_API_KEY
          : process.env.OPENAI_API_KEY);

    // Claude CLI uses the local `claude` login — no cloud key required.
    this.useLocalEngine = isLocalEngineRequested || (!isOllamaModel && !useClaudeCli && !cloudKey);
    this.useClaudeCli = useClaudeCli;
    this.claudeCliModelAlias = useClaudeCli ? claudeCliModelAlias(rawModel) : undefined;

    const resolvedKey = isOllamaModel ? "ollama-local" : cloudKey || "local-no-cloud-key";
    const resolvedBaseURL =
      options.baseURL ??
      (isOllamaModel
        ? process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434/v1"
        : isClaudeModel
          ? process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com/v1/"
          : isGrokModel
            ? process.env.XAI_BASE_URL || "https://api.x.ai/v1"
            : process.env.OPENAI_BASE_URL);

    this.task = task;
    this.botName = options.botName?.trim() || "Open Bot";
    this.expertise = options.expertise?.trim() || "autonomous local terminal, Codex, and browser execution";
    this.collaborationContext = options.collaborationContext?.trim() || "";
    this.taskImages = options.taskImages || [];
    this.onKnowledgeBase = options.onKnowledgeBase;
    this.browser = options.browser;
    this.client = new OpenAI({
      apiKey: resolvedKey,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(resolvedBaseURL ? { baseURL: resolvedBaseURL } : {}),
      ...(isClaudeModel
        ? {
            // Anthropic's OpenAI-compatible Chat Completions endpoint.
            defaultHeaders: { "anthropic-version": "2023-06-01" }
          }
        : {})
    });
    this.model = isOllamaModel ? rawModel.slice("ollama:".length) || "llama3.2" : rawModel;
    this.useResponsesApi =
      this.model.startsWith("gpt-6") && !isGrokModel && !isOllamaModel && !isClaudeModel && !useClaudeCli;
    this.keepRecentImages = Math.max(keepRecentImages, this.taskImages.length + 1);
    this.maxApiRetries = maxApiRetries;
    this.onEvent = options.onEvent;
    this.onHumanVerification = options.onHumanVerification;
    this.onTerminalApproval = options.onTerminalApproval;
    this.taskApproval = options.taskApprovalScope ?? new TaskApprovalScope();
    this.allowPrivilegedTools = options.allowPrivilegedTools ?? true;
    this.interactionMode = options.interactionMode ?? "act";
    this.standingApproval =
      (options.standingApproval ?? this.interactionMode === "turbo") && this.allowPrivilegedTools;
    this.onScheduleTask = options.onScheduleTask;
    this.onLearningKb = options.onLearningKb;
    this.shouldAbort = options.shouldAbort;
    this.abortSignal = options.abortSignal;
    this.scheduleTimeZone = options.scheduleTimeZone || "UTC";
    this.observeMode = options.observeMode ?? "text";
    this.agentEngine = options.agentEngine ?? "cheap";
    this.resolvedApiKey = resolvedKey;
    this.resolvedBaseURL = resolvedBaseURL;
    this.maxStepsConfig = options.maxSteps ?? 25;
    // Chat never drives the browser; browse/act honor allowBrowserInteraction for scheduled runs.
    this.allowBrowserInteraction =
      this.interactionMode === "chat"
        ? false
        : this.interactionMode === "browse"
          ? false
          : (options.allowBrowserInteraction ?? true);
    this.toolsForModel = TOOLS.filter((tool) => {
      if (tool.type !== "function") return true;
      const name = tool.function.name;
      if (!this.allowPrivilegedTools && PRIVILEGED_TOOL_NAMES.has(name)) return false;
      if (this.interactionMode === "chat" && BROWSER_TOOL_NAMES.has(name)) return false;
      if (this.interactionMode === "browse" && INTERACTIVE_BROWSER_TOOL_NAMES.has(name)) return false;
      if (!this.allowBrowserInteraction && INTERACTIVE_BROWSER_TOOL_NAMES.has(name)) return false;
      return true;
    });
    this.loopGuard = new LoopGuard(options.maxSteps ?? 25, options.maxDurationSeconds ?? 900.0);
    this.systemPrompt = this.buildSystemPrompt();
  }

  private sessionMode(): SessionMode {
    return this.browser.sessionMode;
  }

  private shouldCaptureScreenshot(state?: PageState | null): boolean {
    if (this.forceVisionOnce) return true;
    if (this.observeMode === "vision") return true;
    if (state?.requiresHumanVerification || state?.accessDenied) return true;
    if (this.consecutiveClickFailures >= 2) return true;
    if (state?.elements?.length) {
      const unlabeled = state.elements.filter((el) => !el.text.trim()).length;
      if (unlabeled >= Math.ceil(state.elements.length * 0.6)) return true;
    }
    return false;
  }

  private async captureObservation(): Promise<PageState> {
    // First pass without screenshot when text-first; upgrade if walls/icon-only demand vision.
    const wantShot = this.observeMode === "vision" || this.forceVisionOnce || this.consecutiveClickFailures >= 2;
    let state = await this.browser.captureState({ includeScreenshot: wantShot });
    if (!wantShot && this.shouldCaptureScreenshot(state) && !state.screenshotB64) {
      state = await this.browser.captureState({ includeScreenshot: true });
    }
    this.forceVisionOnce = false;
    this.latestEvidenceState = state;
    return state;
  }

  private async reviewCompletion(summary: string, state: PageState | null): Promise<string | null> {
    if (this.interactionMode !== "chat" && this.browser.isStarted && isAbsenceClaim(summary)) {
      this.forceVisionOnce = true;
      const fresh = await this.captureObservation().catch(() => state);
      if (fresh && state) Object.assign(state,fresh);
      const issue = findingEvidenceIssue(summary,fresh,this.browser.lastViewInspection);
      if (issue) return `Unverified conclusion rejected: ${issue}\n${formatObservationForSdk(fresh,0)}`;
    }
    return detectPrematureFinish(summary);
  }

  private buildSystemPrompt(): string {
    // The approval rules have to reflect what the user actually granted. Hardcoding "always stop
    // and ask" meant the bot asked, got a yes, and then asked again on the very next turn.
    // One rule that covers every site, instead of a paragraph per platform. The model declares the
    // effect; actionEffect.ts independently checks the real button label and takes the stricter of
    // the two, so a wrong declaration cannot unlock anything.
    const effectRule =
      "EFFECTS — label every click before you make it:\n" +
      "- Every click_* / type_* call takes an `effect`: read | reversible | outward | irreversible.\n" +
      "- read = you only look. reversible = only this user sees it and it can be undone (filters, drafts, bookmarks).\n" +
      "- outward = another person sees it, or it goes out under the user's name: follow, connect, send, post, comment, like, endorse, apply, invite, launch a campaign, start a sequence.\n" +
      "- irreversible = destroys something or moves money: delete, remove, pay, buy, place order, cancel a subscription.\n" +
      "- Judge the consequence, not the wording. 'Save' on a profile-edit page is outward because the bio becomes public. 'Confirm' at the end of a checkout is irreversible.\n" +
      "- This is the same question on every site, so you never need a platform-specific rule: ask what the click does to the world, not which app you are in.\n" +
      "- Declaring a higher effect than needed costs one question. Declaring a lower one is a lie the gate will catch anyway, and it is how real damage happens.\n";

    const approvalRules = this.standingApproval && this.interactionMode === "turbo"
      ? "TURBO APPROVAL — execute the user's scoped task end-to-end, including requested uploads, saves, and publication, without asking for routine or outward confirmation. This takes precedence over role templates that say to ask before publishing. A prior yes continues the established task; never ask the same question again. Preserve explicit limits (draft-only stays draft-only). Never expand the scope. Payments, destructive or irreversible actions and human verification still use their existing gates. Scheduled runs remain research-and-draft only.\n"
      : this.standingApproval
      ? "STANDING APPROVAL — the user has turned on 'Approve for me'. They have already said yes:\n" +
        "- Engagement they've scoped (follows, likes, comments on targets you shortlisted) is APPROVED. Do it in paced batches without asking again.\n" +
        "- Do NOT re-ask for what is already approved. Re-asking after a yes is the exact thing they complained about. Announce what you're doing, then do it.\n" +
        "- For publishing new content, direct messages, or profile changes, ask once only if the user has not already explicitly authorized that specific action in the conversation. Payments, deletions and irreversible actions still use their tool approval gates.\n" +
        "- Scheduled/unattended runs are still research-and-draft only; standing approval does not extend to them.\n" +
        "- If part of a request is in scope and part isn't, do the in-scope part now and name the rest in one line.\n"
      : "APPROVALS — the user has NOT granted standing approval:\n" +
        "- Stop for approval before follows/likes/comments/posts/publishes/GA-GTM edits; research + drafting is free to do.\n" +
        "- Propose a specific batch (targets + exact wording) and ask once. Don't ask the same question twice.\n" +
        "- If they say they approve everything / give blanket approval, tell them to turn on 'Approve for me' in the composer — one click, and it's what actually grants it. Never claim standing approval you weren't given.\n";

    return (
      `You are ${this.botName}. Role & Purpose: ${this.expertise}.\n` +
      "Local personal agent in Open Bots (runs behind the user's browser).\n" +
      "VOICE: Sound natural, warm, and direct, like a thoughtful person. In user-facing prose, do not use hyphens, en dashes, or em dashes. Restructure the sentence with commas, periods, or parentheses. Keep exact code, URLs, commands, identifiers, and quoted text unchanged when accuracy requires it.\n" +
      "TOKEN DISCIPLINE (critical — stay useful like Grok, not expensive):\n" +
      "- Prefer tools over long explanations once a plan is agreed. Act, then give a short result.\n" +
      "- User-facing replies: ≤150 words unless they ask for detail. Requested articles/drafts are deliverables: honor their requested length, and return the full text if the external editor cannot save it. Never claim a draft is saved without checking save status and reopening it.\n" +
      "- Structured plans beat paragraphs: short labeled lines, not bold bullet essays.\n" +
      "- Finish as soon as you have the answer or a concrete next ask. Don't narrate every click.\n" +
      "- Batch independent tool calls. Prefer extract_page_data / Detected Stats over re-navigating.\n" +
      "- FAST NAVIGATION: Reuse the latest observation. Native click_mark/click_element opens pointer-driven menus; newly opened menu/dialog controls appear first in the next marks list. Click the exact Edit action from those marks instead of re-extracting full HTML, reopening the menu, or walking Tab repeatedly. Use run_action_script for a known short sequence; check each result and stop on failure or ambiguity. Search once only when the target row is absent, then match the exact draft title/workspace. Never guess a different row to save steps.\n" +
      "- EVIDENCE: Browser tabs are listed in observations. Use list_tabs/switch_tab to inspect the intended application; user tab changes invalidate old assumptions and marks. Before reporting no data, no results, or missing access, use inspect_view on the intended current scope. Inspect selectable contexts and native/ARIA data regions; a missing selector/table or welcome page is not proof of absence. Do not infer account-wide absence from an empty filtered view. If the default range/filter is empty but the task calls for broader research, inspect the available filters and the appropriate requested range before stopping.\n" +
      "- Observations are text-first (marks + page text). Do not ask for screenshots when Text answers the ask.\n" +
      `- Mode: ${this.interactionMode.toUpperCase()} (` +
      (this.interactionMode === "chat"
        ? "text tools only — no browser navigate/click"
        : this.interactionMode === "browse"
          ? "navigate/read/extract only — no click/type"
          : this.interactionMode === "turbo"
            ? "autonomous turbo execution — auto-run browser actions, multi-step scripts via run_action_script, shell commands, and file writes end-to-end without stopping for routine/outward confirmation"
            : "full browser with effect gates") +
      ").\n" +
      "- Reddit/Google bot walls: prefer reddit_search / google_property / web_search, or tell the user to switch to Connected Chrome — do not hammer Playwright Chrome.\n" +
      "PLAN FIRST ON COMPLEX ASKS (marketing, growth, Reddit, SEO, multi-step work):\n" +
      "- Before spraying tools, briefly reason: goal, niche signals, constraints (esp. ban/spam/karma risk), biggest leverage.\n" +
      "- Then give a compact actionable plan (≤8 short lines). Prefer structured labels over essays.\n" +
      "- ≤3 targeted research calls when needed; don't burn a step farm of generic searches before a plan.\n" +
      "- Start research/audit tools to ground the plan in their real account/site when signed in; don't wait to be spoon-fed niche details.\n" +
      effectRule +
      approvalRules +
      "SCHEDULING: schedule_task for one-time/daily jobs (tz=" + this.scheduleTimeZone + "). Schedules are read-only for engagement (research/monitor/draft only). Never like/follow/comment/post from a schedule. Ask before recurring paid model runs; set costApproved only after explicit yes.\n" +
      "VOICE: warm, direct, specific — like a sharp social-media co-founder texting. Never corporate filler ('Certainly!', 'Here are several strategies:', 'In conclusion').\n" +
      "CAPABILITIES: upload_file (attach saved generated artifacts through hidden file inputs or upload buttons); delegate_to_bot (workspace roster in CONTEXT); learning_kb (durable local memory); run_terminal_command; headless web_search/reddit_search/google_property/calculate/create_document/workspace_file/understand_youtube_video; generate_image (one clear prompt); browser navigate/click_*/type_*/extract_page_data/scroll/wait (when mode allows).\n" +
      "Rules:\n" +
      "1. SPEED after the plan: batch tools; minimum steps; don't stall asking what the niche is if the profile can tell you.\n" +
      "2. PEER BOTS: answer from OPEN BOTS WORKSPACE ROSTER — never generic 'what is a bot' definitions.\n" +
      "3. Read-only repository inspection runs without approval. Other shell commands/file writes use the tool's approval gate; call the tool directly rather than asking for permission in prose first. 'Approve for me' and task-scoped shell/file approval suppress repeat prompts. If denied, adapt once; don't retry the denied action.\n" +
      "TASK CONTINUITY: Before acting on a follow-up, reconcile SAVED TASK CONTINUITY, user corrections, existing artifacts, and the current page. A side question does not cancel unfinished work. Use the exact existing draft title/workspace and saved image filename. If an approach failed, inspect fresh marks and viewport and choose a different approach; do not restart the same home/list navigation loop. Never edit the first table row as a substitute for locating the intended draft. Treat requests such as 'can you', 'proceed', 'sort it out', and 'yes' in the supplied conversation as instructions to continue the established task. Carry forward known paths, remotes, goals, and prior decisions. Inspect available state before asking for missing information. Ask only when a material choice cannot be inferred; bundle those choices into one question. Do not invent lost context.\n" +
      "EXECUTION: A request to commit, push, migrate, or fix authorizes the normal steps for that task. Verify the destination and preserve uncommitted work, then invoke tools. Do not end with 'want me to proceed?' for work already requested. Never infer publication/visibility changes, destructive history rewrites, or secret disclosure from vague approval. Respect explicit limits such as 'do not push' and show actual diffs when review was requested.\n" +
      "REPOSITORIES: Trace parent and submodule remotes together; after changing anything, check a fresh checkout/setup path before claiming migration complete. Report partial completion honestly.\n" +
      "BOT HANDOFFS: Use only bots present in the supplied roster. Creating a bot and delegating work are different actions; never claim you created or contacted a bot without a successful tool result.\n" +
      "4. Check [Detected Stats] and Text first; if the ask is only for numbers/bio, finish_task immediately.\n" +
      "5. After SPA profile clicks (IG/X), extract_page_data or wait(1s) before failing.\n" +
      "6. YouTube → understand_youtube_video, never navigate for transcripts.\n" +
      "7. Never expose credentials. Money and destructive actions use their approval gates; public actions follow the approval rules above.\n" +
      (this.standingApproval
        ? "8. RESEARCH YOURSELF for niche targets: infer niche from profile, find real candidates, draft comments, then EXECUTE the paced batch — they've already approved engagement. Report what you did; don't ask first.\n"
        : "8. RESEARCH YOURSELF for niche targets: infer niche from profile, find real candidates, draft comments, return a shortlist for approval. Never follow/like/comment/message until they approve specific targets+wording.\n") +
      "9. PACE engagement: ≤5–8 likes/follows/comments per run with wait between; leave the rest for later.\n" +
      "10. CONFIRM UI state (Follow→Following, toast, visible comment) before claiming success.\n" +
      "KNOWLEDGE: Use retrieved runbooks and knowledge_base(search/read) for targeted details. After a verified successful workflow, save a short runbook with account/workspace preconditions, stable navigation, verification and pitfalls. Treat saved runbooks as guidance to recheck, not proof of current state or permission. Inspect pasted images directly, reconcile them with page text, and save a concise textual correction/runbook when they teach something reusable. Never infer resource absence or missing access from a landing page. Check the intended tab, current selection/filter, and actual data region first.\n" +
      "11. CONTINUOUS SELF-IMPROVEMENT (LEARNINGS/KB in CONTEXT): Recall niche, user rules, prior mistakes, and what worked from LEARNINGS/KB. Every time the user gives feedback, corrects an action, states a preference/rule, or teaches you how a site/workflow operates, call learning_kb(action='save', kind='mistake'|'learning'|'intent'|'hypothesis', text=...) so you permanently improve across runs and never repeat the same mistake.\n" +
      "12. FORMS, DROPDOWNS & HERO IMAGES: To select an option in a `<select>` dropdown, call `type_mark(markId, text='<option label or value>')` (do NOT click and press ArrowDown). If form fields or editors are below the fold, call `scroll_page(direction='down')` or use the marks listed in `Elements:`. When creating a blog post or article that needs a hero/featured image, `generate_image` is pre-authorized — call it directly without stopping to ask permission. Then use upload_file with its saved filename to attach it; do not type a local path into an upload button or stop at opening a file chooser. Reuse the existing artifact after a yes or retry. Verify the preview, save the draft, and reopen it to confirm the image persists. A selected file alone is not proof of a completed upload.\n" +
      "INSTAGRAM / FOLLOWER GROWTH PLAYBOOK (be a proactive marketing specialist):\n" +
      "- On 'grow followers / increase engagement / help me market': do NOT dump generic tips and stop. Reason → plan → audit/research → propose concrete next actions for approval.\n" +
      "- Plan shape (keep lean): Goal & niche | Profile audit | Content angle (2–3 post ideas) | Engagement (who to like/comment + draft lines) | Follow targets (5–8 handles + why) | Pacing (≤5–8 actions/run) | Schedule (optional daily research-only check-in).\n" +
      "- Execution order: (1) open signed-in profile + read stats/bio/posts, (2) infer niche, (3) research real accounts / hashtags, (4) return shortlist + draft comments + ask what to approve, (5) only then execute approved follows/likes/comments with pacing.\n" +
      "- If not signed in: say so once, ask Open Live Browser / sign in, then resume — don't burn steps guessing.\n" +
      (this.standingApproval
        ? "- They approved engagement: run propose→execute yourself in paced batches, and report results instead of asking.\n"
        : "- Prefer propose→approve→execute over unsupervised engagement.\n") +
      "REDDIT / COMMUNITY GROWTH PLAYBOOK (smart marketer — never naive spam):\n" +
      "- On 'Reddit bot / promote on Reddit / community growth': refuse unsupervised auto-posting. Reason → lean plan → research rules/subs → drafts + schedule for approval. Never blast links or spam identical comments.\n" +
      "- Plan shape (≤8 lines): Positioning | Target subs (3–5 + why) | Rules/self-promo norms | Account trust (aged > throwaway; karma/comment history; ban/shadowban/spam-filter risk) | Karma-build phase (value-only first) | Content angles (2–3 value-first drafts, disclosure when relevant) | Engagement + pacing | Schedule (research/draft-only unless they approve a specific post) | Do-NOT list.\n" +
      "- If reddit_search returns 403, do not repeat the same API requests. Try navigate to the relevant community in the connected browser; an API block does not prove that the browser is blocked. If both browser and web search fail, preserve useful draft templates, label unverified details, and state the blocker.\n" +
      "- Risks to name briefly: subreddit rules, karma/min-age gates, spam filters, shadowbans, ban evasion, throwaway accounts, pacing, undisclosed self-promo.\n" +
      "- Value-first: helpful answers/teardowns/checklists before any product mention; soft disclosure; link only when rules allow and after trust is earned.\n" +
      "- Output: concrete shortlist + 1–2 draft posts/comments + proposed weekly cadence; ask what to approve. Never post/comment/upvote from a schedule without explicit per-item approval.\n" +
      "SEO / AI VISIBILITY PLAYBOOK (research-oriented growth strategist):\n" +
      "- On 'SEO / keywords / GA4 / GTM / organic / funnel / AI visibility / GEO / AEO': do NOT dump generic SEO tips and stop. Reason → compact labeled plan → research/audit (browser when signed in) → findings + measurement → ask approval before changes.\n" +
      "- Plan shape (≤8–10 short labeled lines): Keywords/clusters (info vs commercial, long-tail, competitor gaps) | GA4 (traffic, conversions, landing pages, funnels) | GTM (events/tags/triggers — advise & inspect only unless approved) | Funnel (awareness → consider → convert) | On-page/tech checks | Content calendar / topic clusters | AI visibility (entity clarity, citations, FAQ, brand mentions) | Measurement plan | Approvals needed.\n" +
      "- GA/GTM: open analytics.google.com / tagmanager.google.com / Search Console when signed in; read-only by default. Never invent private metrics or claim numbers you didn't see. Ask before creating/editing tags, triggers, goals, or property settings.\n" +
      "- Keyword strategy variants: informational vs commercial intent, long-tail clusters, competitor gap themes — keep clusters tight and prioritized, not encyclopedic lists.\n" +
      "- AI visibility / GEO / AEO: honest tactics only (clear entities, citable facts, FAQ structure, authoritative brand mentions). State limits of ChatGPT/Claude/Perplexity-style answer engines; never promise 'rank #1 in AI' or fake visibility scores.\n" +
      "- SERP: prefer Search Console + user's own properties + careful web_search. Do NOT scrape Google SERP in ways that violate ToS.\n" +
      "- Output: compact plan → grounded findings → prioritized next actions + what to approve. Stop before publishing content, changing tags, or editing analytics config.\n" +
      "LINKEDIN / B2B OUTREACH PLAYBOOK (research-led, never a connect-spray):\n" +
      "- On 'LinkedIn / connect / prospects / leads / outreach / ICP': do NOT start connecting. Reason → compact plan → research real profiles → draft personalised notes → batch for approval.\n" +
      "- Plan shape (≤8 lines): ICP & trigger | Target list (5-10 profiles + why each) | Connection note drafts (personalised, ≤300 chars) | Follow-up message | Pacing | What needs approval | Risks | Measurement.\n" +
      "- LIMITS worth naming once: LinkedIn weekly invite caps (roughly 100-200/week, account-dependent), automation detection, and restriction/ban risk. Pace ≤10-15 invites per run with waits. Never bulk-connect.\n" +
      "- Personalise from something real on the profile (a post, a role change, shared group). A generic 'I'd like to add you to my network' is what gets accounts flagged and ignored.\n" +
      "- Connect, invite, endorse, message, and post are side effects: they need approval unless standing approval is on, and messages/posts need it even then.\n" +
      "- Prefer: engage with their content first → connect with a referenced note → follow up only after they accept. Never scrape at volume or use private/unofficial LinkedIn APIs.\n" +
      "COLD EMAIL / SEQUENCE PLATFORM PLAYBOOK (Instantly, Lemlist, Apollo, Smartlead):\n" +
      "- You can navigate these in the browser when the user is signed in: read campaign stats, build lists, draft copy, and set a sequence up. You must NOT press send, launch, resume, or enable a campaign without explicit approval for that specific campaign — mail cannot be unsent.\n" +
      "- Plan shape (≤8 lines): Offer & ICP | List source & verification | Domain/inbox health (separate sending domain, SPF/DKIM/DMARC, warmup, daily cap) | Sequence (3-4 touches, value-first) | Personalisation variables | Deliverability risks | Compliance | What to approve.\n" +
      "- Say plainly, once, what the user is responsible for: consent/legitimate interest under GDPR, CAN-SPAM's real postal address and working one-click opt-out, honouring unsubscribes, and that burnt domains don't recover quickly. Advise a dedicated sending domain, never the primary one.\n" +
      "- Sensible defaults to recommend: warm the inbox first, 20-50 sends/inbox/day, spread across inboxes, stop a sequence on reply, suppress existing customers and prior recipients.\n" +
      "- Never invent reply/open rates, never buy or scrape lists, never send to a list the user can't explain the source of. If deliverability looks bad, say so instead of sending anyway.\n" +
      "- Reading dashboards, exporting stats, and drafting copy are free. Launching, resuming, importing-then-sending, and anything that puts mail in an inbox are approval-gated.\n" +
      "UX / PRODUCT DESIGN PLAYBOOK (evidence-based product partner):\n" +
      "- On 'UX / UI / usability / a11y / flow / IA / wireframe / redesign': do NOT dump generic design tips and stop. Reason → compact labeled plan → inspect the live page in the browser → severity-ranked findings → ask approval before product UI changes.\n" +
      "- Plan shape (≤8–10 short labeled lines): Goals & audience | Key flows | Heuristic scan (Nielsen-style, lean) | A11y (contrast, focus, labels, keyboard) | IA/nav/copy | Friction & opportunities | Prioritized fixes (P0–P2) | Approvals / retest.\n" +
      "- Ground critique in what you see on the page (CTAs, forms, empty/error states, hierarchy, spacing, mobile when relevant). Never invent user interviews, heatmaps, or conversion rates you didn't observe.\n" +
      "- Prefer clear problem → evidence → recommended fix over subjective taste. Call out accessibility issues with WCAG-minded language when visible.\n" +
      "- Output: short plan → findings with severity → concrete next actions; stop before rewriting live product UI unless the user approves specific changes.\n" +
      (this.collaborationContext ? `\nCONTEXT:\n${this.collaborationContext}\n` : "")
    );
  }

  private humanizeSummary(raw: string): string {
    if (!raw) return raw;
    if (/```/.test(raw)) return raw.trim();

    let text = raw.trim();
    text = text.replace(
      /^(?:Certainly!|Sure!|Of course!|Great question!)?\s*(?:To\s+[^:\n]{8,110},\s*(?:we|you)\s+can\s+(?:implement|use|try|follow|focus on)[^:\n]*:|Here\s+are\s+(?:several|some|a few|key)\s+(?:strategies|ways|steps|tips)[^:\n]*:)\s*/i,
      ""
    );

    const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
    const bulletMatches = lines.filter((l) => /^(?:[-*•]|\d+\.)\s+\*\*[^*]+\*\*\s*:\s*/.test(l));
    if (bulletMatches.length >= 3 && bulletMatches.length >= lines.length - 2) {
      const converted = bulletMatches.slice(0, 3).map((l) =>
        l.replace(/^(?:[-*•]|\d+\.)\s+\*\*([^*]+)\*\*\s*:\s*/, (_, title) => `**${title.trim()}** — `).trim()
      );
      const tail = lines.find(
        (l) => !/^(?:[-*•]|\d+\.)\s+/.test(l) && lines.indexOf(l) > lines.indexOf(bulletMatches[bulletMatches.length - 1])
      );
      return [
        "Here's what I'd actually focus on first to get real traction:",
        converted.join("\n\n"),
        tail || "Want me to jump in on one of these right now, or check out your current page first?"
      ].join("\n\n");
    }

    return text;
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
    if (this.interactionMode !== "chat" && this.latestEvidenceState && findingEvidenceIssue(result.summary,this.latestEvidenceState,this.browser.lastViewInspection)) {
      result = {...result,success:false,summary:`I have not verified the requested finding. The last observed page was ${this.latestEvidenceState.url}. The task is incomplete; I have not established that the requested resource is empty or inaccessible.`,terminationReason:"unverified_finding"};
    }
    const cleanedSummary = this.humanizeSummary(result.summary);
    const finalResult: AgentResult = { ...result, summary: cleanedSummary };
    this.emit({
      type: "terminal",
      success: finalResult.success,
      summary: finalResult.summary,
      terminationReason: finalResult.terminationReason,
      stepsTaken: finalResult.stepsTaken,
      elapsedSeconds: finalResult.elapsedSeconds,
      ...(finalResult.delegateTo ? { delegateTo: finalResult.delegateTo } : {})
    });
    return finalResult;
  }

  /**
   * Pauses and asks the user to explicitly approve a shell command or file write before it runs.
   * Unlike handleHumanVerification (which safely continues if unattended), this defaults to DENY
   * when there's no hook or the hook throws - running an unapproved command is the unsafe default,
   * not the safe one.
   */
  private async requestPrivilegedApproval(toolName: string, input: Record<string, unknown>): Promise<boolean> {
    if (!this.allowPrivilegedTools) return false;
    const financial = toolName === "run_terminal_command" && assessTaskRisk(String(input.command || "")).approvalsRequired.includes("financial_transaction");
    if (!financial && (!requiresPrivilegedApproval(toolName, input) || this.standingApproval || this.taskApproval.allows(toolName))) return true;
    const description = describePrivilegedCall(toolName, input);
    const approvalId = randomUUID();
    this.emit({
      type: "privileged_approval_required",
      approvalId,
      approvalKind: financial ? "irreversible" : "shell",
      toolName,
      description,
      message: `${this.botName} wants to: ${description}. Approve or deny before it runs.`
    });

    const waitStarted = Date.now();
    let approved = false;
    let approvalScope: "once" | "task" = "once";
    if (this.onTerminalApproval) {
      try {
        const decision = await this.onTerminalApproval({ toolName, description, approvalId, approvalKind: financial ? "irreversible" : "shell" });
        approvalScope = typeof decision === "object" && decision.scope === "task" ? "task" : "once";
        approved = this.taskApproval.resolve(decision, financial ? "none" : "privileged");
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("onTerminalApproval hook raised; denying by default.", err);
        approved = false;
      }
    } else {
      // eslint-disable-next-line no-console
      console.warn(`Privileged call "${description}" denied: no onTerminalApproval hook was configured.`);
    }
    this.loopGuard.extendDeadline((Date.now() - waitStarted) / 1000);

    this.emit({ type: "privileged_approval_resolved", approvalId, toolName, description, approved, approvalScope });
    return approved && !this.aborted();
  }

  /**
   * Reads the label of the element a tool call is about to act on. The model names an element by
   * mark id or by text; either way the real on-screen label is what the gate should judge, not the
   * model's description of it.
   */
  private resolveActionTarget(toolName: string, input: Record<string, unknown>): { label?: string; role?: string } {
    if (toolName === "click_mark" || toolName === "type_mark" || (toolName === "upload_file" && input.markId !== undefined)) {
      const markId = Math.trunc(Number(input.markId));
      const el = Number.isNaN(markId) ? undefined : this.browser.getElementByMark(markId);
      return { label: el?.text, role: el?.role };
    }
    if (toolName === "upload_file") return {};
    if (toolName === "click_element") {
      const target = typeof input.target === "string" ? input.target : undefined;
      // A CSS selector carries no human label, so do not mine it for verbs.
      return { label: target && isCssSelector(target) ? undefined : target };
    }
    if (toolName === "click_coords") return { label: typeof input.label === "string" ? input.label : undefined };
    return {};
  }

  /**
   * The general approval gate: classify what this click/keystroke actually does and stop only when
   * it reaches someone else or cannot be taken back. This replaces guessing from the task text,
   * which needed a new rule per platform and let every unlisted site through.
   */
  private async gateBrowserAction(
    toolName: string,
    input: Record<string, unknown>
  ): Promise<ToolExecutionResult | null> {
    if (!INTERACTIVE_TOOLS.has(toolName)) return null;
    const observed = typeof this.browser.inspectActionTarget === "function" && this.browser.isStarted
      ? await this.browser.inspectActionTarget(toolName, input) : {};
    const target = { ...this.resolveActionTarget(toolName, input), ...observed };
    const captchaLike =
      /\b(captcha|i'?m not a robot|recaptcha|hcaptcha|turnstile|verify you are human|select all images)\b/i.test(
        target.label || ""
      );
    if (captchaLike) {
      return {
        ok: false,
        message:
          "Not executed: CAPTCHA / human-verification controls must be solved by you in Live Browser, then click Resume. The agent will not click CAPTCHA tiles."
      };
    }
    const decision = classifyBrowserAction({
      toolName,
      label: target.label,
      role: target.role,
      declaredEffect: input.effect,
      pressEnter: Boolean(input.pressEnter)
    });
    if (!effectRequiresApproval(decision.effect, this.standingApproval)) return null;
    // A "yes for the whole task" on outward actions covers the rest of the batch; irreversible
    // ones are deliberately excluded from that shortcut.
    if (decision.effect === "outward" && this.taskApproval.allowsOutwardAction()) return null;

    const description = describeEffectAction(toolName, target.label, decision.effect);
    if (!this.allowPrivilegedTools) {
      // Unattended/scheduled runs have nobody to ask, so they stay research-and-draft only.
      return {
        ok: false,
        message: `Not executed: "${description}" is ${decision.effect} and this run is unattended. Research and draft it instead, and leave it for the user to send.`
      };
    }

    const approvalId = randomUUID();
    this.emit({
      type: "privileged_approval_required",
      approvalId,
      approvalKind: decision.effect === "irreversible" ? "irreversible" : "outward",
      toolName,
      description,
      message: `${this.botName} wants to: ${description}. ${decision.reason}. Approve or deny before it runs.`
    });

    const waitStarted = Date.now();
    let approved = false;
    let approvalScope: "once" | "task" = "once";
    if (this.onTerminalApproval) {
      try {
        const approvalDecision = await this.onTerminalApproval({ toolName, description, approvalId, approvalKind: decision.effect === "irreversible" ? "irreversible" : "outward" });
        approvalScope = decision.effect !== "irreversible" && typeof approvalDecision === "object" && approvalDecision.scope === "task" ? "task" : "once";
        approved = this.taskApproval.resolve(
          approvalDecision,
          // A task-wide answer can cover similar outward actions or shell/files, never an
          // irreversible action. Irreversible approval applies to this click only.
          decision.effect === "irreversible" ? "none" : decision.effect === "outward" ? "outward-action" : "privileged"
        );
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("onTerminalApproval hook raised; denying by default.", err);
        approved = false;
      }
    }
    this.loopGuard.extendDeadline((Date.now() - waitStarted) / 1000);
    this.emit({ type: "privileged_approval_resolved", approvalId, toolName, description, approved, approvalScope });

    return approved && !this.aborted()
      ? null
      : { ok: false, message: `The user did not approve "${description}", so it was not executed.` };
  }

  private async handleHumanVerification(state: PageState): Promise<PageState> {
    this.emit({
      type: "human_verification",
      url: state.url,
      title: state.title,
      screenshotB64: state.screenshotB64,
      message:
        "Human verification / CAPTCHA detected. Open Live Browser, solve the challenge yourself " +
        "(do not ask the agent to click images), then click I've handled it — resume. " +
        "If you need a different site (e.g. Instagram) while a captcha is up, use Go or + New Tab " +
        "in the live browser — navigation will recover onto a fresh tab if the current one is stuck."
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
      this.forceVisionOnce = true;
      resolvedState = await this.captureObservation();
    } catch {
      return state;
    }
    this.emit({
      type: "human_verification_resolved",
      accessDenied: Boolean(resolvedState.accessDenied),
      requiresHumanVerification: Boolean(resolvedState.requiresHumanVerification),
      url: resolvedState.url,
      title: resolvedState.title,
      screenshotB64: resolvedState.screenshotB64
    });
    return resolvedState;
  }

  /** True once the caller has asked for the run to stop. Never throws out of the hook. */
  private aborted(): boolean {
    if (this.abortSignal?.aborted) return true;
    if (!this.shouldAbort) return false;
    try {
      return this.shouldAbort();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("shouldAbort hook raised; treating the run as still active.", err);
      return false;
    }
  }

  private abortResult(step: number): AgentResult {
    return this.finish({
      success: false,
      summary: "Stopped before finishing, as you asked.",
      stepsTaken: step,
      elapsedSeconds: this.loopGuard.elapsedSeconds(),
      terminationReason: "stopped"
    });
  }

  private accessDeniedResult(state: PageState, step: number): AgentResult {
    return this.finish({
      success: false,
      summary: accessDeniedRecoveryHint(this.sessionMode(), state.url, state.signInRejected),
      stepsTaken: step,
      elapsedSeconds: this.loopGuard.elapsedSeconds(),
      terminationReason: "access_denied"
    });
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
      const approved = await this.requestPrivilegedApproval("run_terminal_command", { command: cmd });
      const res = approved
        ? await executeTool("run_terminal_command", { command: cmd }, this.browser, this.abortSignal)
        : { ok: false, message: "This command was not approved by the user and was not executed." } as ToolExecutionResult;
      emitLocalStep("run_terminal_command", { command: cmd }, res);
      outputs.push(
        `### Local Terminal Execution\nCommand: \`$ ${cmd}\`\n\`\`\`text\n${
          (res.terminalEntry?.stdout || res.terminalEntry?.stderr || res.message).trim()
        }\n\`\`\``
      );
      if (!res.ok) {
        return this.finish({
          success: false,
          summary: outputs.join("\n\n"),
          stepsTaken: steps,
          elapsedSeconds: this.loopGuard.elapsedSeconds(),
          terminationReason: approved ? "command_failed" : "approval_denied"
        });
      }
    }

    // 2. Check for YouTube video understanding
    const ytMatch = /(https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=[^\s&]+|youtu\.be\/[^\s?&]+|youtube\.com\/shorts\/[^\s?&]+))/i.exec(
      rawRequest
    );
    if (ytMatch || /\byoutube\b/i.test(rawRequest)) {
      const target = ytMatch ? ytMatch[1] : rawRequest;
      const res = await executeTool("understand_youtube_video", { urlOrQuery: target }, this.browser, this.abortSignal);
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
      const navRes = await executeTool("navigate", { url: targetUrl }, this.browser, this.abortSignal);
      const state = await this.captureObservation().catch(() => null);
      emitLocalStep("navigate", { url: targetUrl }, navRes, state);
      if (state?.accessDenied) return this.accessDeniedResult(state, steps);
      const extRes = await executeTool("extract_page_data", { mode: "text" }, this.browser, this.abortSignal);
      emitLocalStep("extract_page_data", { mode: "text" }, extRes, state);
      outputs.push(`### Local Browser Extraction (${targetUrl})\n${extRes.message.slice(0, 2500)}`);
    }

    // 4. Check for workspace bots / peer bots inquiry
    if (
      outputs.length === 0 &&
      /\b(other bots|my bots|what bots|which bots|list bots|workspace bots|peer bots)\b/i.test(rawRequest) &&
      this.collaborationContext
    ) {
      const rosterIdx = this.collaborationContext.indexOf("OPEN BOTS WORKSPACE ROSTER:");
      const rosterText =
        rosterIdx >= 0 ? this.collaborationContext.slice(rosterIdx).trim() : this.collaborationContext;
      outputs.push(`### Your Open Bots Workspace Roster\n${rosterText}`);
    }

    // 5. Fallback to local web search + workspace summary if no other tool matched
    // Arithmetic has to be caught before the web_search fallback. Without this, "calculate 2 + 2"
    // fell through to a search and came back with film trivia - a confidently wrong answer to a
    // question the calculator tool could have answered exactly.
    const arithmetic = extractArithmeticExpression(rawRequest);
    if (outputs.length === 0 && arithmetic) {
      const calcRes = await executeTool("calculate", { expression: arithmetic }, this.browser, this.abortSignal);
      emitLocalStep("calculate", { expression: arithmetic }, calcRes);
      if (calcRes.ok) {
        outputs.push(calcRes.message);
      }
    }

    if (outputs.length === 0) {
      const searchRes = await executeTool("web_search", { query: rawRequest.slice(0, 120) }, this.browser, this.abortSignal);
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

    // 1. Direct `$ <command>` shell invocation: skips the LLM round-trip for speed, but still goes
    //    through the same explicit per-command approval as any other privileged tool call - and is
    //    only available on attended runs, never on scheduled/unattended ones.
    const directShellMatch = /^\$\s*([^\n]+)$/.exec(rawRequest);
    if (directShellMatch && this.allowPrivilegedTools) {
      const cmd = directShellMatch[1].trim();
      const approved = await this.requestPrivilegedApproval("run_terminal_command", { command: cmd });
      const res = approved
        ? await executeTool("run_terminal_command", { command: cmd }, this.browser, this.abortSignal)
        : { ok: false, message: "This command was not approved by the user and was not executed." };
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
          summary: approved
            ? `Executed \`$ ${cmd}\` locally (${res.terminalEntry?.durationMs ?? 0}ms):\n\`\`\`text\n${out}\n\`\`\``
            : `Command \`$ ${cmd}\` was not approved and was not run.`,
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
      const res = await executeTool("understand_youtube_video", { urlOrQuery: videoUrl }, this.browser, this.abortSignal);
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
        const navRes = await executeTool("navigate", { url: targetUrl }, this.browser, this.abortSignal);
        const state = await this.captureObservation().catch(() => null);
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
    if (this.taskImages.length && (this.useClaudeCli || this.model === "local-engine")) {
      return this.finish({ success: false, summary: "This execution engine cannot inspect pasted images. Select an image-capable API model to analyze this attachment.", stepsTaken: 0, elapsedSeconds: 0, terminationReason: "unsupported_image_input" });
    }
    if (this.useLocalEngine) {
      return this.runLocalEngine();
    }

    const pre = this.taskImages.length ? { stepsUsed: 0, initialState: null, preExecutedContext: null, instantFinish: null } : await this.preExecuteFirstAction();
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
        state = await this.captureObservation();
      } catch (err) {
        return this.finish({
          success: false,
          summary: `Failed to capture initial page state: ${(err as Error).message}`,
          stepsTaken: step,
          elapsedSeconds: this.loopGuard.elapsedSeconds(),
          terminationReason: "initial_observation_error"
        });
      }

      this.emit({
        type: "observe",
        step: 0,
        url: state.url,
        title: state.title,
        screenshotB64: state.screenshotB64
      });
    }

    if (state?.accessDenied) return this.accessDeniedResult(state, step);
    if (state?.requiresHumanVerification) state = await this.handleHumanVerification(state);
    if (state?.accessDenied) return this.accessDeniedResult(state, step);

    if (this.agentEngine === "openai-sdk" && !this.useClaudeCli) {
      return this.runOpenAIAgentsSdkEngine(step, state, preContext);
    }

    let isFirstTurn = true;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (this.aborted()) return this.abortResult(step);
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
        if (response.usage) {
          this.emit({
            type: "usage",
            model: this.model,
            promptTokens: response.usage.prompt_tokens ?? 0,
            completionTokens: response.usage.completion_tokens ?? 0,
            totalTokens: response.usage.total_tokens ?? 0
          });
        }
      } catch (err) {
        // A heuristic local search is not an LLM fallback: silently substituting it masks
        // authentication/model/API errors and makes the agent appear to have reasoned.
        if (this.aborted()) return this.abortResult(step);
        const detail = (err instanceof Error ? err.message : String(err))
          .replace(/\b(?:sk|xai)-[A-Za-z0-9_-]{12,}\b/g, "[redacted key]")
          .replace(/Incorrect API key provided:\s*\S+/gi, "Incorrect API key provided: [redacted]")
          .slice(0, 280);
        return this.finish({
          success: false,
          summary: `I couldn't reach the selected model, so I haven't substituted a local heuristic answer. ${detail || "Check the model, API key, and connection in Settings."}`,
          stepsTaken: step - 1,
          elapsedSeconds: this.loopGuard.elapsedSeconds(),
          terminationReason: "llm_error"
        });
      }

      // A model call can take a while; don't spend its tool calls on a run the user stopped.
      if (this.aborted()) return this.abortResult(step);

      const message = response.choices[0].message;
      const toolCalls = this.extractToolCalls(message);
      this.messages.push(this.serializeAssistantMessage(message, toolCalls.length));
      if (this.useResponsesApi) this.responsesMessageIndex = this.messages.length;

      if (toolCalls.length === 0) {
        const directReply = (message.content ?? "").trim();
        if (directReply) {
          const premature =
            this.prematureFinishRejections < MAX_PREMATURE_FINISH_REJECTIONS
              ? await this.reviewCompletion(directReply, state)
              : null;
          if (premature) {
            this.prematureFinishRejections += 1;
            pendingToolOutputs = [];
            warningText = null;
            directiveText = premature;
            continue;
          }
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
        // Checked per call, not per batch: a batch of eight clicks must not finish after Stop.
        if (this.aborted()) return this.abortResult(step);

        if (toolCall.argumentError) {
          const result = { ok: false, message: toolCall.argumentError };
          pendingToolOutputs.push({ id: toolCall.id, result });
          this.emit({type: "step", step, toolName: toolCall.name, ok: false, message: result.message});
          continue;
        }
        if (toolCall.name === "delegate_to_bot") {
          const targetBotName = String(toolCall.input.targetBotName ?? "").trim() || "Specialist Bot";
          const delegatedTask = String(toolCall.input.task ?? "").trim() || this.extractUserRequestCore();
          const handoffNote = typeof toolCall.input.handoffNote === "string" ? toolCall.input.handoffNote.trim() : "";
          this.emit({
            type: "step",
            step,
            toolName: "delegate_to_bot",
            toolInput: toolCall.input,
            ok: true,
            message: `Delegating to ${targetBotName}: ${delegatedTask.slice(0, 120)}`
          });
          return this.finish({
            success: true,
            summary: `Handing off to **${targetBotName}**${handoffNote ? ` — ${handoffNote}` : ""}.`,
            stepsTaken: step,
            elapsedSeconds: this.loopGuard.elapsedSeconds(),
            terminationReason: "delegate_to_bot",
            delegateTo: {
              targetBotName,
              task: delegatedTask,
              handoffNote
            }
          });
        }

        if (toolCall.name === "schedule_task") {
          const result = this.onScheduleTask
            ? await this.onScheduleTask(toolCall.input)
            : { ok: false, message: "Scheduling is unavailable in this app instance." };
          pendingToolOutputs.push({ id: toolCall.id, result });
          this.emit({
            type: "step",
            step,
            toolName: "schedule_task",
            toolInput: toolCall.input,
            ok: result.ok,
            message: result.message.slice(0, 180)
          });
          continue;
        }

        if (toolCall.name === "learning_kb" || toolCall.name === "knowledge_base") {
          const handler = toolCall.name === "knowledge_base" ? this.onKnowledgeBase : this.onLearningKb;
          const result = handler
            ? await handler(toolCall.input)
            : { ok: false, message: "Learning KB is unavailable in this app instance." };
          pendingToolOutputs.push({ id: toolCall.id, result });
          this.emit({
            type: "step",
            step,
            toolName: toolCall.name,
            toolInput: toolCall.input,
            ok: result.ok,
            message: result.message.slice(0, 180)
          });
          continue;
        }

        if (toolCall.name === "run_action_script") {
          const code = typeof toolCall.input.code === "string" ? toolCall.input.code : "";
          const allowedToolNames = this.toolsForModel
            .flatMap((t) => (t.type === "function" ? [t.function.name] : []))
            .filter((name) => !NON_SCRIPTABLE_META_TOOLS.has(name));

          const scriptResult = await runActionScript({
            code,
            toolNames: allowedToolNames,
            state: this.scriptState,
            shouldAbort: () => this.aborted(),
            onToolCall: async (subName, subInput): Promise<ScriptToolResult> => {
              if (this.aborted()) {
                return { ok: false, message: "Run aborted by user." };
              }
              if (subName === "learning_kb" || subName === "knowledge_base") {
                const handler = subName === "knowledge_base" ? this.onKnowledgeBase : this.onLearningKb;
                const kbRes = handler
                  ? await handler(subInput)
                  : { ok: false, message: "Learning KB is unavailable in this app instance." };
                return { ok: kbRes.ok, message: kbRes.message, data: kbRes.data };
              }

              const subIsNonBrowser =
                HEADLESS_RESEARCH_TOOL_NAMES.has(subName) || subName === "generate_image";
              if (!subIsNonBrowser) {
                touchedBrowserInBatch = true;
                if (!this.browser.isStarted) {
                  await this.browser.start();
                }
              }

              let subResult: ToolExecutionResult;
              const effectRefusal = await this.gateBrowserAction(subName, subInput);
              if (effectRefusal) {
                subResult = effectRefusal;
              } else if (requiresPrivilegedApproval(subName, subInput)) {
                const approved = await this.requestPrivilegedApproval(subName, subInput);
                subResult = approved
                  ? await executeTool(subName, subInput, this.browser, this.abortSignal)
                  : { ok: false, message: "This action was not approved by the user and was not executed." };
              } else {
                subResult = await executeTool(subName, subInput, this.browser, this.abortSignal);
              }

              let obsData = subResult.data;
              if (!subIsNonBrowser && this.browser.isStarted) {
                try {
                  state = await this.captureObservation();
                  const marksPreview = (state.elements ?? [])
                    .slice(0, 25)
                    .map((el) => `#${el.markId} [${el.tag}] ${el.text}`)
                    .join(" | ");
                  obsData = [
                    subResult.data,
                    `URL: ${state.url}`,
                    `Title: ${state.title}`,
                    marksPreview ? `Marks: ${marksPreview}` : ""
                  ]
                    .filter(Boolean)
                    .join("\n");
                } catch {
                  // Ignore post-subtool observation error; outer loop still tracks state.
                }
              }

              this.emit({
                type: "step",
                step,
                toolName: subName,
                toolInput: subInput,
                ok: subResult.ok,
                message: `[script] ${subResult.message.split("\n")[0].slice(0, 160)}`,
                artifactUrl: subResult.artifactUrl,
                terminalEntry: subResult.terminalEntry,
                url: subIsNonBrowser ? undefined : state?.url,
                title: subIsNonBrowser ? undefined : state?.title
              });

              return {
                ok: subResult.ok,
                message: subResult.message,
                data: obsData
              };
            }
          });

          this.scriptState = scriptResult.state;
          this.emit({
            type: "step",
            step,
            toolName: "run_action_script",
            toolInput: { code: code.slice(0, 240) },
            ok: scriptResult.ok,
            message: scriptResult.summaryMessage.split("\n")[0].slice(0, 180)
          });

          if (scriptResult.ok && scriptResult.finalAnswer !== undefined) {
            const premature =
              this.prematureFinishRejections < MAX_PREMATURE_FINISH_REJECTIONS
                ? await this.reviewCompletion(scriptResult.finalAnswer, state)
                : null;
            if (!premature) {
              return this.finish({
                success: true,
                summary: scriptResult.finalAnswer,
                stepsTaken: step,
                elapsedSeconds: this.loopGuard.elapsedSeconds(),
                terminationReason: "finish_task"
              });
            }
            this.prematureFinishRejections += 1;
            pendingToolOutputs.push({
              id: toolCall.id,
              result: { ok: false, message: premature }
            });
            continue;
          }

          pendingToolOutputs.push({
            id: toolCall.id,
            result: {
              ok: scriptResult.ok,
              message: scriptResult.summaryMessage,
              data: scriptResult.returned
            }
          });
          continue;
        }

        if (toolCall.name === "finish_task") {
          const summary = typeof toolCall.input.summary === "string" ? toolCall.input.summary : "Task completed.";
          const premature =
            this.prematureFinishRejections < MAX_PREMATURE_FINISH_REJECTIONS
              ? await this.reviewCompletion(summary, state)
              : null;
          if (premature) {
            this.prematureFinishRejections += 1;
            const result = { ok: false, message: premature };
            pendingToolOutputs.push({ id: toolCall.id, result });
            this.emit({
              type: "step",
              step,
              toolName: "finish_task",
              toolInput: toolCall.input,
              ok: false,
              message: premature.slice(0, 180)
            });
            continue;
          }
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
          const prematureFail =
            this.prematureFinishRejections < MAX_PREMATURE_FINISH_REJECTIONS
              ? (await this.reviewCompletion(reason, state)) || detectPrematureFail(reason)
              : null;
          if (prematureFail) {
            this.prematureFinishRejections += 1;
            const result = { ok: false, message: prematureFail };
            pendingToolOutputs.push({ id: toolCall.id, result });
            this.emit({
              type: "step",
              step,
              toolName: "fail_task",
              toolInput: toolCall.input,
              ok: false,
              message: prematureFail.slice(0, 180)
            });
            continue;
          }
          if (step <= 2 && this.browser.isStarted) {
            try {
              await this.browser.wait(0.6);
              state = await this.captureObservation();
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

        const isNonBrowserTool = HEADLESS_RESEARCH_TOOL_NAMES.has(toolCall.name) || toolCall.name === "generate_image";

        if (!isNonBrowserTool) {
          touchedBrowserInBatch = true;
          if (!this.browser.isStarted) {
            await this.browser.start();
          }
        }

        let execResult: ToolExecutionResult;
        const effectRefusal = await this.gateBrowserAction(toolCall.name, toolCall.input);
        if (effectRefusal) {
          execResult = effectRefusal;
        } else if (requiresPrivilegedApproval(toolCall.name, toolCall.input)) {
          const approved = await this.requestPrivilegedApproval(toolCall.name, toolCall.input);
          execResult = approved
            ? await executeTool(toolCall.name, toolCall.input, this.browser, this.abortSignal)
            : { ok: false, message: "This action was not approved by the user and was not executed." };
        } else {
          execResult = await executeTool(toolCall.name, toolCall.input, this.browser, this.abortSignal);
        }
        if (INTERACTIVE_BROWSER_TOOL_NAMES.has(toolCall.name)) {
          if (execResult.ok) this.consecutiveClickFailures = 0;
          else {
            this.consecutiveClickFailures += 1;
            if (this.consecutiveClickFailures >= 2) this.forceVisionOnce = true;
          }
        }
        pendingToolOutputs.push({ id: toolCall.id, result: execResult });
        if (execResult.imageUsage) {
          this.emit({
            type: "usage",
            model: execResult.imageUsage.model,
            promptTokens: execResult.imageUsage.promptTokens,
            completionTokens: execResult.imageUsage.outputTokens,
            totalTokens: execResult.imageUsage.totalTokens
          });
        }

        // Capture browser state only on the last browser tool in the batch (or if the next tool depends on fresh markIds)
        const nextCall = toolCalls[i + 1];
        const nextNeedsFreshMarks =
          nextCall && (nextCall.name === "click_mark" || nextCall.name === "type_mark");

        if (!isNonBrowserTool && this.browser.isStarted && (i === toolCalls.length - 1 || nextNeedsFreshMarks)) {
          try {
            state = await this.captureObservation();
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

      if (touchedBrowserInBatch && state?.accessDenied) return this.accessDeniedResult(state, step);
      if (touchedBrowserInBatch && state?.requiresHumanVerification) {
        state = await this.handleHumanVerification(state);
        if (state.accessDenied) return this.accessDeniedResult(state, step);
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
      const raw = item.result.message || "";
      const content =
        raw.length > MAX_TOOL_RESULT_CHARS
          ? `${raw.slice(0, MAX_TOOL_RESULT_CHARS)}\n[tool output truncated]`
          : raw;
      this.messages.push({
        role: "tool",
        tool_call_id: item.id,
        content
      });
    }

    const lines: string[] = [];
    if (state?.tabs?.length) lines.push(`OPEN TABS (switch_tab uses index): ${state.tabs.map(tab=>`${tab.index}${tab.active?"*":""}: ${tab.title} | ${tab.url}`).join("\n")}`);
    if (isFirstTurn) {
      lines.push(`TASK: ${this.task}`);
      if (preExecutedContext) {
        lines.push(preExecutedContext);
      } else if (state && state.url && state.url !== "about:blank") {
        lines.push(
          `[ACTIVE BROWSER SCREEN ALREADY OPEN — URL: ${state.url} | Title: "${state.title}". ` +
            `Do NOT call navigate("${state.url}") again or restart from the beginning if the page or form you need is already open on screen below. ` +
            `Inspect Text and Elements below and continue directly from the current screen.]`
        );
      }
    }
    if (state) {
      lines.push(`Step ${step} | URL: ${state.url} | Title: ${state.title}`);
      if (state.pageText) {
        lines.push(`Text:\n${state.pageText}`);
      }
      if (state.elements.length > 0) {
        // Keep marks lean — enough to click, not a full DOM dump.
        const compactEls = state.elements.slice(0, 40).map((el) => {
          const desc = el.elementType || el.role;
          const tag = desc ? `${el.tag}[${desc}]` : el.tag;
          const label = (el.text || "").slice(0, 48);
          return `#${el.markId} ${tag} "${label}" @(${el.x},${el.y})`;
        });
        lines.push(`Elements: ${compactEls.join(" | ")}`);
      }
    } else if (isFirstTurn && !preExecutedContext) {
      lines.push("(Browser not needed unless you call a browser tool.)");
    }
    if (warningText) lines.push(warningText);
    if (directiveText) lines.push(directiveText);

    // Text-first: only attach vision when we captured a screenshot and it is still useful.
    const textHasStats = Boolean(state?.pageText && /\[Detected Stats:/i.test(state.pageText));
    const includeScreenshot = Boolean(
      state &&
        state.screenshotB64 &&
        state.url !== "about:blank" &&
        !textHasStats &&
        this.shouldCaptureScreenshot(state)
    );
    const images: OpenAI.Chat.Completions.ChatCompletionContentPart[] = isFirstTurn
      ? this.taskImages.map(url => ({ type: "image_url", image_url: { url, detail: "high" } })) : [];
    if (includeScreenshot && state) images.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${state.screenshotB64}`, detail: "low" } });
    this.messages.push({ role: "user", content: images.length ? [{ type: "text", text: lines.join("\n") }, ...images] : lines.join("\n") });
  }

  private async callClaudeCliLlm(): Promise<OpenAI.Chat.Completions.ChatCompletion> {
    const system =
      `${this.systemPrompt}\n\n${toolsCatalogForClaudeCli(this.toolsForModel)}\n` +
      "You must drive Open Bots tools through structured tool_calls. Do not use Claude Code built-in tools.";
    const userPrompt = flattenMessagesForClaudeCli(this.messages as Array<Record<string, unknown>>);
    const result = await invokeClaudeCli({
      systemPrompt: system,
      userPrompt,
      modelAlias: this.claudeCliModelAlias,
      cwd: process.cwd(),
      signal: this.abortSignal
    });
    return claudeCliResultToChatCompletion(result, this.model);
  }

  private async callLlm(): Promise<OpenAI.Chat.Completions.ChatCompletion> {
    if (this.useClaudeCli) {
      return this.callClaudeCliLlm();
    }
    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= this.maxApiRetries; attempt += 1) {
      try {
        if (this.useResponsesApi) {
          const response = await this.client.responses.create({
            model: this.model,
            instructions: this.systemPrompt,
            input: this.responsesInputFromMessages(),
            ...(this.responsesPreviousId ? { previous_response_id: this.responsesPreviousId } : {}),
            tools: this.toolsForModel.map((tool) => ({
              type: "function" as const,
              name: tool.function.name,
              description: tool.function.description,
              parameters: (tool.function.parameters ?? {}) as Record<string, unknown>,
              strict: false
            })),
            tool_choice: "auto",
            parallel_tool_calls: true,
            max_output_tokens: MAX_TOKENS,
            reasoning: { effort: GPT6_REASONING_EFFORT }
          }, { signal: this.abortSignal });
          this.responsesPreviousId = response.id;
          const calls = response.output
            .filter((item): item is OpenAI.Responses.ResponseFunctionToolCall => item.type === "function_call")
            .map((call) => ({
              id: call.call_id,
              type: "function" as const,
              function: { name: call.name, arguments: call.arguments }
            }));
          const content = response.output_text?.trim() || null;
          const inputTokens = response.usage?.input_tokens ?? 0;
          const outputTokens = response.usage?.output_tokens ?? 0;
          return {
            id: response.id,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: response.model,
            choices: [{
              index: 0,
              finish_reason: calls.length ? "tool_calls" : "stop",
              logprobs: null,
              message: { role: "assistant", content, tool_calls: calls.length ? calls : undefined }
            }],
            usage: {
              prompt_tokens: inputTokens,
              completion_tokens: outputTokens,
              total_tokens: response.usage?.total_tokens ?? inputTokens + outputTokens
            }
          } as OpenAI.Chat.Completions.ChatCompletion;
        }

        return await this.client.chat.completions.create({
          model: this.model,
          tools: this.toolsForModel,
          tool_choice: "auto",
          parallel_tool_calls: true,
          messages: this.messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
          max_tokens: MAX_TOKENS
        }, { signal: this.abortSignal });
      } catch (err) {
        if (this.aborted()) throw err;
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
        if (this.aborted()) {
          throw new Error("Run stopped while retrying the LLM API.");
        }
      }
    }
    throw new Error(`Exhausted retries calling the LLM API: ${(lastErr as Error)?.message ?? lastErr}`);
  }

  /** Convert the orchestrator's existing conversation/tool history into Responses API input.
   * GPT-6 function calling with reasoning is supported on Responses; Chat Completions only
   * permits tool calling with reasoning disabled for this model family. */
  private responsesInputFromMessages(): OpenAI.Responses.ResponseInput {
    const fromIndex = this.responsesPreviousId ? this.responsesMessageIndex : 0;
    const items: OpenAI.Responses.ResponseInputItem[] = [];
    for (const raw of this.messages.slice(fromIndex)) {
      const message = raw as Record<string, any>;
      if (message.role === "system") continue; // supplied via `instructions` on every response
      if (message.role === "tool") {
        items.push({
          type: "function_call_output",
          call_id: String(message.tool_call_id ?? ""),
          output: typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "")
        });
        continue;
      }
      if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
        if (typeof message.content === "string" && message.content.trim()) {
          items.push({ role: "assistant", content: message.content });
        }
        for (const call of message.tool_calls) {
          items.push({
            type: "function_call",
            call_id: String(call.id),
            name: String(call.function?.name ?? ""),
            arguments: String(call.function?.arguments ?? "{}")
          });
        }
        continue;
      }

      const role = message.role === "assistant" ? "assistant" : "user";
      if (typeof message.content === "string" || message.content == null) {
        items.push({ role, content: message.content ?? "" });
        continue;
      }
      if (Array.isArray(message.content)) {
        const content = (message.content as any[]).reduce((parts: any[], part: any) => {
          if (part.type === "text") parts.push({ type: "input_text", text: String(part.text ?? "") });
          if (part.type === "image_url" && part.image_url?.url) {
            parts.push({
              type: "input_image" as const,
              image_url: String(part.image_url.url),
              detail: part.image_url.detail === "low" ? "low" as const : "auto" as const
            });
          }
          return parts;
        }, []);
        items.push({ role, content } as OpenAI.Responses.ResponseInputItem);
      }
    }
    return items;
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
    return message.tool_calls.slice(0, this.useResponsesApi ? undefined : 4).map((call) => {
      let input: Record<string, unknown> = {};
      let argumentError: string | undefined;
      try {
        input = call.function.arguments ? JSON.parse(call.function.arguments) : {};
        if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Expected object");
      } catch {
        input = {};
        argumentError = "Tool arguments were incomplete or invalid JSON. No action was taken. Retry with complete arguments; split large article text into smaller paragraphs if needed.";
      }
      return { id: call.id, name: call.function.name, input, argumentError };
    });
  }

  private async runOpenAIAgentsSdkEngine(
    initialStep: number,
    initialState: PageState | null,
    preExecutedContext: string | null
  ): Promise<AgentResult> {
    let step = initialStep;
    let state: PageState | null = initialState;

    const initialLines: string[] = [`TASK: ${this.task}`];
    if (preExecutedContext) {
      initialLines.push(preExecutedContext);
    } else if (state && state.url && state.url !== "about:blank") {
      initialLines.push(
        `[ACTIVE BROWSER SCREEN ALREADY OPEN — URL: ${state.url} | Title: "${state.title}". ` +
          `Do NOT call navigate("${state.url}") again or restart from the beginning if the page or form you need is already open on screen below. ` +
          `Inspect Text and Elements below and continue directly from the current screen.]`
      );
    }
    if (state) {
      initialLines.push(formatObservationForSdk(state, Math.max(1, step)));
    }

    try {
      const outcome = await runWithOpenAIAgentsSdk({
        botName: this.botName,
        systemPrompt: this.systemPrompt,
        initialUserPrompt: initialLines.join("\n\n"),
        taskImages: this.taskImages,
        model: this.model,
        apiKey: this.resolvedApiKey,
        baseURL: this.resolvedBaseURL,
        useResponses: this.useResponsesApi,
        openAIClient: this.client,
        maxSteps: this.maxStepsConfig,
        tools: this.toolsForModel,
        shouldAbort: () => this.aborted(),
        checkPrematureFinish: (text) => this.reviewCompletion(text,state),
        getLatestObservationImage: () => this.latestEvidenceState?.screenshotB64,
        getLatestObservationText: () => formatObservationForSdk(state, step),
        onUsage: (usage) => {
          this.emit({
            type: "usage",
            model: this.model,
            promptTokens: usage.promptTokens,
            completionTokens: usage.completionTokens,
            totalTokens: usage.totalTokens
          });
        },
        onToolCall: async (toolName, toolInput) => {
          step += 1;
          if (this.aborted()) {
            return {
              output: "Run stopped by user.",
              terminalResult: {
                success: false,
                summary: "Stopped before finishing.",
                terminationReason: "stopped"
              }
            };
          }

          if (toolName === "delegate_to_bot") {
            const targetBotName = String(toolInput.targetBotName ?? "").trim() || "Specialist Bot";
            const delegatedTask = String(toolInput.task ?? "").trim() || this.extractUserRequestCore();
            const handoffNote = typeof toolInput.handoffNote === "string" ? toolInput.handoffNote.trim() : "";
            this.emit({
              type: "step",
              step,
              toolName: "delegate_to_bot",
              toolInput,
              ok: true,
              message: `Delegating to ${targetBotName}: ${delegatedTask.slice(0, 120)}`
            });
            return {
              output: `Delegated to ${targetBotName}.`,
              terminalResult: {
                success: true,
                summary: `Handing off to **${targetBotName}**${handoffNote ? ` — ${handoffNote}` : ""}.`,
                terminationReason: "delegate_to_bot",
                delegateTo: { targetBotName, task: delegatedTask, handoffNote }
              }
            };
          }

          if (toolName === "schedule_task") {
            const result = this.onScheduleTask
              ? await this.onScheduleTask(toolInput)
              : { ok: false, message: "Scheduling is unavailable in this app instance." };
            this.emit({
              type: "step",
              step,
              toolName: "schedule_task",
              toolInput,
              ok: result.ok,
              message: result.message.slice(0, 180)
            });
            return { output: result.message };
          }

          if (toolName === "learning_kb" || toolName === "knowledge_base") {
            const handler = toolName === "knowledge_base" ? this.onKnowledgeBase : this.onLearningKb;
            const result = handler
              ? await handler(toolInput)
              : { ok: false, message: "Learning KB is unavailable in this app instance." };
            this.emit({
              type: "step",
              step,
              toolName,
              toolInput,
              ok: result.ok,
              message: result.message.slice(0, 180)
            });
            return { output: result.message };
          }

          if (toolName === "run_action_script") {
            const code = typeof toolInput.code === "string" ? toolInput.code : "";
            const allowedToolNames = this.toolsForModel
              .flatMap((t) => (t.type === "function" ? [t.function.name] : []))
              .filter((name) => !NON_SCRIPTABLE_META_TOOLS.has(name));

            const scriptResult = await runActionScript({
              code,
              toolNames: allowedToolNames,
              state: this.scriptState,
              shouldAbort: () => this.aborted(),
              onToolCall: async (subName, subInput): Promise<ScriptToolResult> => {
                if (this.aborted()) {
                  return { ok: false, message: "Run aborted by user." };
                }
                if (subName === "learning_kb" || subName === "knowledge_base") {
                  const handler = subName === "knowledge_base" ? this.onKnowledgeBase : this.onLearningKb;
                  const kbRes = handler
                    ? await handler(subInput)
                    : { ok: false, message: "Learning KB is unavailable in this app instance." };
                  return { ok: kbRes.ok, message: kbRes.message, data: kbRes.data };
                }
                const subIsNonBrowser =
                  HEADLESS_RESEARCH_TOOL_NAMES.has(subName) || subName === "generate_image";
                if (!subIsNonBrowser && !this.browser.isStarted) {
                  await this.browser.start();
                }
                let subResult: ToolExecutionResult;
                const effectRefusal = await this.gateBrowserAction(subName, subInput);
                if (effectRefusal) {
                  subResult = effectRefusal;
                } else if (requiresPrivilegedApproval(subName, subInput)) {
                  const approved = await this.requestPrivilegedApproval(subName, subInput);
                  subResult = approved
                    ? await executeTool(subName, subInput, this.browser, this.abortSignal)
                    : { ok: false, message: "This action was not approved by the user and was not executed." };
                } else {
                  subResult = await executeTool(subName, subInput, this.browser, this.abortSignal);
                }
                let obsData = subResult.data;
                if (!subIsNonBrowser && this.browser.isStarted) {
                  try {
                    state = await this.captureObservation();
                    const marksPreview = (state.elements ?? [])
                      .slice(0, 35)
                      .map((el) => `#${el.markId} [${el.tag}] ${el.text}`)
                      .join(" | ");
                    obsData = [
                      subResult.data,
                      `URL: ${state.url}`,
                      `Title: ${state.title}`,
                      marksPreview ? `Marks: ${marksPreview}` : ""
                    ]
                      .filter(Boolean)
                      .join("\n");
                  } catch {
                    // ignore
                  }
                }
                this.emit({
                  type: "step",
                  step,
                  toolName: subName,
                  toolInput: subInput,
                  ok: subResult.ok,
                  message: `[script] ${subResult.message.split("\n")[0].slice(0, 160)}`,
                  artifactUrl: subResult.artifactUrl,
                  terminalEntry: subResult.terminalEntry,
                  url: subIsNonBrowser ? undefined : state?.url,
                  title: subIsNonBrowser ? undefined : state?.title
                });
                return { ok: subResult.ok, message: subResult.message, data: obsData };
              }
            });

            this.scriptState = scriptResult.state;
            this.emit({
              type: "step",
              step,
              toolName: "run_action_script",
              toolInput: { code: code.slice(0, 240) },
              ok: scriptResult.ok,
              message: scriptResult.summaryMessage.split("\n")[0].slice(0, 180)
            });

            if (scriptResult.ok && scriptResult.finalAnswer !== undefined) {
              const premature =
                this.prematureFinishRejections < MAX_PREMATURE_FINISH_REJECTIONS
                  ? await this.reviewCompletion(scriptResult.finalAnswer, state)
                  : null;
              if (!premature) {
                return {
                  output: scriptResult.finalAnswer,
                  terminalResult: {
                    success: true,
                    summary: scriptResult.finalAnswer,
                    terminationReason: "finish_task"
                  }
                };
              }
              this.prematureFinishRejections += 1;
              return { output: `${premature}\n\n${formatObservationForSdk(state, step)}` };
            }

            return {
              output: `${scriptResult.summaryMessage}\n\n${formatObservationForSdk(state, step)}`
            };
          }

          if (toolName === "finish_task") {
            const summary = typeof toolInput.summary === "string" ? toolInput.summary : "Task completed.";
            const premature =
              this.prematureFinishRejections < MAX_PREMATURE_FINISH_REJECTIONS
                ? await this.reviewCompletion(summary, state)
                : null;
            if (premature) {
              this.prematureFinishRejections += 1;
              this.emit({
                type: "step",
                step,
                toolName: "finish_task",
                toolInput,
                ok: false,
                message: premature.slice(0, 180)
              });
              return { output: `${premature}\n\n${formatObservationForSdk(state, step)}` };
            }
            return {
              output: summary,
              terminalResult: {
                success: true,
                summary,
                terminationReason: "finish_task"
              }
            };
          }

          if (toolName === "fail_task") {
            const reason = typeof toolInput.reason === "string" ? toolInput.reason : "Task failed.";
            const prematureFail =
              this.prematureFinishRejections < MAX_PREMATURE_FINISH_REJECTIONS
                ? (await this.reviewCompletion(reason, state)) || detectPrematureFail(reason)
                : null;
            if (prematureFail) {
              this.prematureFinishRejections += 1;
              this.emit({
                type: "step",
                step,
                toolName: "fail_task",
                toolInput,
                ok: false,
                message: prematureFail.slice(0, 180)
              });
              return { output: `${prematureFail}\n\n${formatObservationForSdk(state, step)}` };
            }
            return {
              output: reason,
              terminalResult: {
                success: false,
                summary: reason,
                terminationReason: "fail_task"
              }
            };
          }

          const isNonBrowserTool = HEADLESS_RESEARCH_TOOL_NAMES.has(toolName) || toolName === "generate_image";
          if (!isNonBrowserTool && !this.browser.isStarted) {
            await this.browser.start();
          }

          let execResult: ToolExecutionResult;
          const effectRefusal = await this.gateBrowserAction(toolName, toolInput);
          if (effectRefusal) {
            execResult = effectRefusal;
          } else if (requiresPrivilegedApproval(toolName, toolInput)) {
            const approved = await this.requestPrivilegedApproval(toolName, toolInput);
            execResult = approved
              ? await executeTool(toolName, toolInput, this.browser, this.abortSignal)
              : { ok: false, message: "This action was not approved by the user and was not executed." };
          } else {
            execResult = await executeTool(toolName, toolInput, this.browser, this.abortSignal);
          }

          if (execResult.imageUsage) {
            this.emit({
              type: "usage",
              model: execResult.imageUsage.model,
              promptTokens: execResult.imageUsage.promptTokens,
              completionTokens: execResult.imageUsage.outputTokens,
              totalTokens: execResult.imageUsage.totalTokens
            });
          }

          if (!isNonBrowserTool && this.browser.isStarted) {
            try {
              state = await this.captureObservation();
            } catch {
              // ignore post-action capture error
            }
          }

          this.emit({
            type: "step",
            step,
            toolName,
            toolInput,
            ok: execResult.ok,
            message: execResult.message.split("\n")[0].slice(0, 180),
            artifactUrl: execResult.artifactUrl,
            terminalEntry: execResult.terminalEntry,
            url: isNonBrowserTool ? undefined : state?.url,
            title: isNonBrowserTool ? undefined : state?.title,
            screenshotB64: isNonBrowserTool ? undefined : state?.screenshotB64
          });

          const obsBlock = !isNonBrowserTool && state ? `\n\n${formatObservationForSdk(state, step)}` : "";
          return {
            output: `${execResult.message}${obsBlock}`
          };
        }
      });

      return this.finish({
        success: outcome.success,
        summary: outcome.summary,
        stepsTaken: outcome.stepsTaken,
        elapsedSeconds: this.loopGuard.elapsedSeconds(),
        terminationReason: outcome.terminationReason,
        delegateTo: outcome.delegateTo
      });
    } catch (err) {
      const detail = (err instanceof Error ? err.message : String(err))
        .replace(/\b(?:sk|xai)-[A-Za-z0-9_-]{12,}\b/g, "[redacted key]")
        .replace(/Incorrect API key provided:\s*\S+/gi, "Incorrect API key provided: [redacted]")
        .slice(0, 280);
      return this.finish({
        success: false,
        summary: `I couldn't reach the selected model, so I haven't substituted a local heuristic answer. ${detail || "Check the model, API key, and connection in Settings."}`,
        stepsTaken: step,
        elapsedSeconds: this.loopGuard.elapsedSeconds(),
        terminationReason: "llm_error"
      });
    }
  }
}
