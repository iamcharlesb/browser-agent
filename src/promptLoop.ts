import { createModelClient } from "./modelProviderFactory";
import { DELIVERABLE_BAR, RESPONSE_STYLE } from "./responseStyle";
import { loadAgentProfile, LoadedProfile } from "./agentProfile";
import { compactContext, ContextMessage } from "./contextBudget";
import { defaultModel, envInteger, modelConfigurationIssue, resolveModel } from "./runtimeConfig";
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
import { assessTaskRisk, redactSecrets, redactSecretValues } from "./security";
import { userRequestsDirectAnswer } from "./handoffPolicy";
import { shouldBlockBrowserNavigation, taskPrefersWebSearchFirst, isSearchEngineResultsUrl, isSearchEngineSiteUrl } from "./searchRouting";
import {
  enrichFinishSummary,
  formatInstructionFor,
  inferResponseFormat,
  inferResponseFormatForFinish
} from "./responseFormat";
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
  toolsCatalogForClaudeCli
} from "./claudeCli";
import { CircuitBreakerTriggered, LoopGuard, PrunableMessage } from "./loopGuard";
import { formatObservationForSdk, runWithOpenAIAgentsSdk } from "./openaiAgentsRunner";
import { ScriptToolResult } from "./scriptProtocol";
import { summarizeToolResultMessage } from "./toolResultSummary";

export const DEFAULT_MODEL = defaultModel();
/** Leave room for complete article text and tool arguments; the prompt keeps ordinary replies concise. */
const MAX_TOKENS = envInteger("BROWSER_AGENT_MAX_OUTPUT_TOKENS", 16384);
const REASONING_EFFORT = (() => {
  const value = process.env.BROWSER_AGENT_REASONING_EFFORT || "low";
  if (!["low", "medium", "high"].includes(value)) throw new Error("Invalid BROWSER_AGENT_REASONING_EFFORT.");
  return value as "low" | "medium" | "high";
})();
/** Cap tool output text fed back into the model (full UI events can still show more). */
const MAX_TOOL_RESULT_CHARS = envInteger("BROWSER_AGENT_TOOL_RESULT_CHARS", 1400);
const ZERO_DELTA_WARNING =
  "Warning: Last action produced zero visual or DOM changes. Choose an alternate element or approach.";
const MAX_API_RETRIES_DEFAULT = envInteger("BROWSER_AGENT_API_ATTEMPTS", 3, 1, 10);
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
/** Consulted specialists may research and compute but never act: no browser, files, terminal or paid tools. */
const CONSULTATION_TOOL_NAMES = new Set(["knowledge_base", "finish_task", "fail_task", "web_search", "fetch_url", "calculate"]);
const HEADLESS_RESEARCH_TOOL_NAMES = new Set([
  "web_search",
  "fetch_url",
  "reddit_search",
  "google_property",
  "calculate",
  "understand_youtube_video",
  "create_document",
  "workspace_file",
  "code_project",
  "run_terminal_command"
]);
/**
 * Topic tools are only sent when the request mentions their topic. Every tool schema is resent on
 * each model turn, so unused ones are pure token cost. BROWSER_AGENT_TOOL_PRUNING=off sends all.
 */
const CODE_TOPIC = /^\s*\$|\b(?:code|coding|repo\w*|bugs?|fix|tests?|build|files?|folders?|director(?:y|ies)|terminal|commands?|shell|npm|git|functions?|class|deploy\w*|scripts?|compile|refactor|project|typescript|python|javascript|api|endpoint|server|install)\b/i;
const TOPIC_TOOLS: Record<string, RegExp> = {
  understand_youtube_video: /youtu/i,
  reddit_search: /\breddit\b|\bsubreddits?\b|\br\/\w/i,
  google_property: /\b(?:analytics|ga4|gtm|tag manager|search console|google ads|ads manager)\b/i,
  generate_image: /\b(?:images?|pictures?|photos?|illustrations?|logos?|thumbnails?|banners?|visuals?|blog|articles?|posts?|graphics?|websites?|landing pages?|homepages?|mockups?|hero)\b/i,
  code_project: CODE_TOPIC,
  workspace_file: CODE_TOPIC,
  run_terminal_command: CODE_TOPIC,
  schedule_task: /\b(?:schedul\w*|every|daily|weekly|monthly|hourly|remind\w*|recurring|monitor\w*|watch\w*|tomorrow|tonight|later|morning|evening)\b|\bat \d/i
};

export function toolNeededForRequest(name: string, request: string): boolean {
  if ((process.env.BROWSER_AGENT_TOOL_PRUNING || "on").trim() === "off") return true;
  const topic = TOPIC_TOOLS[name];
  return !topic || topic.test(request);
}

/** What separates a useful answer from a correct but generic one. */
const HELPFULNESS_RULES =
  "HELPFULNESS: Answer the goal behind the question, not only its literal wording. Give a concrete recommendation with the reason, " +
  "using the user's own situation from CONTEXT and learning_kb when available. Prefer specifics (names, numbers, links, exact steps) over categories of advice. " +
  "When details are missing, state a reasonable assumption and proceed instead of asking; ask only when a wrong guess would waste real work or money. " +
  "Do the work yourself with tools rather than telling the user how to do it. End with the single most useful next action only when there is one.";

const MUTATING_WORKSPACE_FILE_ACTIONS = new Set(["write", "append", "patch"]);
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
      "Do not stop to narrate status or apologize — execute the remaining actions now (fill the editor fields, click Save/Draft, or use the approved individual tools) and verify the saved state before calling finish_task."
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
  return `${action === "append" ? "Append to" : action === "patch" ? "Patch" : "Overwrite"} file: ${path}`;
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
  profileId?: string;
  botInstructions?: string;
  task: string;
  botName?: string;
  expertise?: string;
  /** Only supplied by the reviewed profile repository, never by model tool arguments. */
  approvedPlaybook?: string;
  /** Known application event name used only for deterministic playbook selection. */
  eventName?: string;
  collaborationContext?: string;
  taskImages?: string[];
  onKnowledgeBase?: OnLearningKb;
  onWorkflowPlan?: OnLearningKb;
  initialBrowserError?: string;
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
  /** Scheduled run whose operator pre-approved this many outward actions; undefined means none. */
  scheduledOutwardLimit?: number;
  /** False removes all browser tools; search APIs and local tools remain available. */
  allowBrowserTools?: boolean;
  /** Disable coordinator handoffs when the discussion must produce its final synthesis. */
  allowBotDelegation?: boolean;
  /** Read-only peer consultation: no browser, shell, file mutation, schedules or subdelegation. */
  consultationOnly?: boolean;
  /** Final synthesis can only return an answer; no new research, writes, or handoffs. */
  finalAnswerOnly?: boolean;
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
  | { role: "assistant"; content: string | null; tool_calls?: unknown[]; reasoning_content?: string };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableOpenAIError(err: unknown): boolean {
  if (err instanceof OpenAI.APIConnectionError) return true;
  return err instanceof OpenAI.APIError &&
    (err.status === 408 || err.status === 409 || err.status === 429 || (err.status !== undefined && err.status >= 500));
}

/** Only explicit page work or a page-dependent continuation needs an initial observation.
 * Domains, research topics and an unrelated open tab do not start a browser.
 * The model can still request browser tools later when public/text tools are insufficient.
 */
export function requiresInitialBrowserState(task: string, browserUrl: string, mode: InteractionMode = "act"): boolean {
  if (mode === "chat") return false;
  const marker = "User request:", index = task.lastIndexOf(marker);
  const request = (index >= 0 ? task.slice(index + marker.length) : task).trim();
  if (/^\$\s*[^\n]+$/.test(request) || extractArithmeticExpression(request) !== null) return false;
  if (/youtube\.com|youtu\.be|\byoutube\b/i.test(request) && !/\b(?:open|watch) in browser\b/i.test(request)) return false;
  const pageReference = /\b(?:this|current|that|the open)\b[^.!?\n]{0,65}\b(?:page|screen|tab|editor|form|module|account)\b|\bon screen\b|\/admin\b/i.test(request);
  if (pageReference) return true;
  if (isInformationQuestion(request)) return false;
  const explicitAction = /\b(?:click|scroll|sign in|log in|login)\b/i.test(request) ||
    /\b(?:open|visit|browse|go to|inspect)\b[^\n]{0,100}(?:https?:\/\/|[a-z0-9-]+\.(?:com|ai|io|org|net|app|dev)\b|\bbrowser\b|\bwebsite\b|\baccount\b)/i.test(request);
  if (explicitAction) return true;
  return Boolean(browserUrl && browserUrl !== "about:blank" &&
    (/^(?:yes(?: sir)?|ok(?:ay)?|continue|proceed|go ahead|do it)[.! ]*$/i.test(request) || /^namespace should be\b/i.test(request)));
}

const EXPLICIT_BROWSER_REQUEST = /\b(?:use (?:the |my |your )?(?:browser|chrome)|(?:in|with|via) (?:the |my |your )?(?:browser|chrome))\b/i;
/** Pilo offered browser access in its last answer; a short yes accepts that offer. */
export const BROWSER_OFFER = /\breply \*{0,2}use the browser\*{0,2}\b/i;

/** "How do I log in to AWS?" asks for knowledge, not for Pilo to drive a browser. */
export function isInformationQuestion(request: string): boolean {
  if (EXPLICIT_BROWSER_REQUEST.test(request)) return false;
  return /^(?:how|what|why|when|where|which|who|is|are|does|do|should|explain|tell me)\b/i.test(request.trim()) && !/\bfor me\b/i.test(request);
}

export function browserWorkRequested(task: string, browserUrl = "about:blank", mode: InteractionMode = "turbo", continuationAllowed = false, browserOffered = false): boolean {
  if (mode === "chat") return false;
  const marker = task.lastIndexOf("User request:");
  const request = (marker >= 0 ? task.slice(marker + "User request:".length) : task).trim();
  if (/\b(?:no browser|(?:don['’]t|do not|never)\s+(?:open|use|launch)\s+(?:the |your )?(?:browser|chrome))\b/i.test(request)) return false;
  if (/^(?:yes(?: sir)?|ok(?:ay)?|continue|proceed|go ahead|do it)[.! ]*$/i.test(request) || /^namespace should be\b/i.test(request)) return browserOffered || (continuationAllowed && browserUrl !== "about:blank");
  if (EXPLICIT_BROWSER_REQUEST.test(request) || requiresInitialBrowserState(request, browserUrl, mode)) return true;
  return !isInformationQuestion(request) &&
    /\b(?:publish|upload|submit|fill (?:in |out )?(?:the |this )?form)\b/i.test(request);
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
  private readonly onWorkflowPlan?: OnLearningKb;
  private browserUnavailableReason?: string;
  private readonly browser: BrowserController;
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly useResponsesApi: boolean;
  private readonly useClaudeCli: boolean;
  private readonly claudeCliModelAlias?: string;
  private responsesPreviousId: string | undefined;
  private responsesMessageIndex = 0;
  private readonly useLocalEngine: boolean;
  private readonly modelConfigurationIssue?: string;
  private readonly keepRecentImages: number;
  private readonly maxApiRetries: number;
  private readonly onEvent?: OnEvent;
  private readonly onHumanVerification?: OnHumanVerification;
  private readonly onTerminalApproval?: OnTerminalApproval;
  private readonly taskApproval: TaskApprovalScope;
  private readonly standingApproval: boolean;
  private readonly scheduledOutwardLimit?: number;
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
  private readonly toolsForModel: OpenAI.Chat.Completions.ChatCompletionTool[];
  private readonly loopGuard: LoopGuard;
  private readonly messages: ChatMessage[] = [];
  private readonly systemPrompt: string;
  private readonly profile: LoadedProfile;

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

    const rawModel = (options.model || defaultModel()).trim();
    const modelDefinition = resolveModel(rawModel);
    const isLocalEngineRequested = modelDefinition.provider === "local";
    const useClaudeCli = modelDefinition.provider === "claude-cli";
    this.useLocalEngine = isLocalEngineRequested;
    this.modelConfigurationIssue = modelConfigurationIssue(rawModel, options.apiKey);
    this.useClaudeCli = useClaudeCli;
    this.claudeCliModelAlias = useClaudeCli ? claudeCliModelAlias(rawModel) : undefined;
    const connection = createModelClient(rawModel, { apiKey: options.apiKey, baseURL: options.baseURL, fetch: options.fetch,
      timeoutMs: Math.min(envInteger("BROWSER_AGENT_MODEL_TIMEOUT_MS", 120_000),
        (options.maxDurationSeconds ?? envInteger("BROWSER_AGENT_MAX_DURATION_SECONDS", 900)) * 1000) });
    const resolvedKey = connection.apiKey || "local-unconfigured";
    const resolvedBaseURL = connection.baseURL;

    this.task = task;
    this.botName = options.botName?.trim() || "Open Bot";
    this.expertise = options.expertise?.trim() || "autonomous local terminal, Codex, and browser execution";
    this.collaborationContext = options.collaborationContext?.trim() || "";
    this.taskImages = options.taskImages || [];
    this.onKnowledgeBase = options.onKnowledgeBase;
    this.onWorkflowPlan = options.onWorkflowPlan;
    this.browserUnavailableReason = options.initialBrowserError;
    this.browser = options.browser;
    this.client = connection.client;
    this.model = connection.model;
    this.useResponsesApi = connection.api === "responses";
    this.keepRecentImages = Math.max(keepRecentImages, this.taskImages.length + 1);
    this.maxApiRetries = maxApiRetries;
    this.onEvent = options.onEvent;
    this.onHumanVerification = options.onHumanVerification;
    this.onTerminalApproval = options.onTerminalApproval;
    this.taskApproval = options.taskApprovalScope ?? new TaskApprovalScope();
    this.allowPrivilegedTools = options.allowPrivilegedTools ?? true;
    this.interactionMode = options.interactionMode ?? "act";
    this.standingApproval =
      Boolean(options.standingApproval) && this.allowPrivilegedTools;
    this.onScheduleTask = options.onScheduleTask;
    this.scheduledOutwardLimit = options.scheduledOutwardLimit;
    this.onLearningKb = options.onLearningKb;
    this.shouldAbort = options.shouldAbort;
    this.abortSignal = options.abortSignal;
    this.scheduleTimeZone = options.scheduleTimeZone || "UTC";
    this.observeMode = options.observeMode ?? "text";
    this.agentEngine = options.agentEngine ?? "cheap";
    this.resolvedApiKey = resolvedKey;
    this.resolvedBaseURL = resolvedBaseURL;
    this.maxStepsConfig = options.maxSteps ?? envInteger("BROWSER_AGENT_MAX_STEPS", 25);
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
      if (options.consultationOnly && !CONSULTATION_TOOL_NAMES.has(name)) return false;
      if (name === "plan_workflow" && (!options.onWorkflowPlan || (!this.allowPrivilegedTools && !options.finalAnswerOnly))) return false;
      if (options.finalAnswerOnly && !["finish_task", "fail_task", "plan_workflow"].includes(name)) return false;
      if (name === "delegate_to_bot" && (options.allowBotDelegation === false || userRequestsDirectAnswer(this.extractUserRequestCore()))) return false;
      if (!this.allowPrivilegedTools && PRIVILEGED_TOOL_NAMES.has(name)) return false;
      if (options.allowBrowserTools === false && BROWSER_TOOL_NAMES.has(name)) return false;
      if (this.interactionMode === "chat" && BROWSER_TOOL_NAMES.has(name)) return false;
      if (this.interactionMode === "browse" && INTERACTIVE_BROWSER_TOOL_NAMES.has(name)) return false;
      if (!this.allowBrowserInteraction && INTERACTIVE_BROWSER_TOOL_NAMES.has(name)) return false;
      if (!toolNeededForRequest(name, `${this.extractUserRequestCore()}\n${options.botInstructions || ""}\n${this.expertise}`)) return false;
      return true;
    });
    this.loopGuard = new LoopGuard(this.maxStepsConfig, options.maxDurationSeconds ?? envInteger("BROWSER_AGENT_MAX_DURATION_SECONDS", 900));
    this.profile = loadAgentProfile({ profileId: options.profileId, botInstructions: options.botInstructions, botName: this.botName, expertise: this.expertise, task: this.extractUserRequestCore(), event: options.eventName, approvedPlaybook: options.approvedPlaybook });
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

    const approvalRules = this.scheduledOutwardLimit !== undefined
      ? `SCHEDULE PERMISSION — the user saved permission for this scheduled job to take up to ${this.scheduledOutwardLimit} outward action(s) per run within its task. Do them without asking. Irreversible actions and payments are always declined. If an action is declined, finish the rest and report it.\n`
      : this.standingApproval && this.interactionMode === "turbo"
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

    const has = (name: string) => this.toolsForModel.some(tool => tool.type === "function" && tool.function.name === name);
    const browserTools = this.toolsForModel.some(tool => tool.type === "function" && BROWSER_TOOL_NAMES.has(tool.function.name));
    const interactiveTools = this.toolsForModel.some(tool => tool.type === "function" && INTERACTIVE_BROWSER_TOOL_NAMES.has(tool.function.name));

    // Identity and stable rules come first; per-task text (format line, context) goes last so
    // provider prompt caching can reuse the long prefix across this bot's turns.
    return [
      `You are ${this.botName}. Role & Purpose: ${this.expertise}.`,
      RESPONSE_STYLE,
      HELPFULNESS_RULES,
      DELIVERABLE_BAR,
      "MULTI-STEP EXECUTION: Work in a loop until the deliverable is verified or you hit a real blocker. Batch independent tool calls in one turn. Never stop after one read with a raw payload.",
      browserTools
        ? "BROWSER ACCESS: The user asked for page work in this request. Use web_search and fetch_url for public facts, and the browser only for the requested page work. Never open Google/Bing/DuckDuckGo in the browser or type searches into Chrome."
        : "BROWSER ACCESS: Chrome is not enabled for this request. Use web_search for public facts and fetch_url to read specific pages. If the task truly needs a signed-in page or an interactive action, deliver everything you can first, then end with one line: Reply **use the browser** to let me open it.",
      browserTools ? "BROWSER TABS: Inspect the observed open tabs or call list_tabs first. Reuse a relevant tab with switch_tab; navigate({url}) reuses the active tab; use newTab:true only when the current page must be preserved. Verify the resulting URL before reporting." : "",
      interactiveTools ? effectRule : "",
      interactiveTools ? approvalRules : "",
      interactiveTools && !this.standingApproval ? "Never follow/like/comment/message until they approve the scoped action." : "",
      has("knowledge_base") || has("delegate_to_bot")
        ? "COORDINATION: knowledge_base(action=read,id=workspace:bots) returns the saved roster, jobs, schedules and consultation receipts. Read it before claiming you contacted a bot or that a bot is working. Use exact saved names for delegate_to_bot. A consultation is a read-only reply, not a background assignment. Reported bot history is not live job state."
        : "",
      has("plan_workflow") ? "TEAM DELIVERY: Use plan_workflow to save a draft when the user wants a team to prepare deliverables, with exact bot names, dependencies, outputs and acceptance criteria. Workflows run only after Start workflow in the app; never claim a draft is running." : "",
      has("code_project") ? "CODING TASKS: use code_project to index/map/search the local workspace, read live source, patch with workspace_file and verify with authorized terminal tests. Imported project:ID folders are read-only. Load playbook:coding-workflow for the full procedure." : "",
      has("schedule_task") ? `SCHEDULING: schedule_task for one-time/daily jobs with timezone ${this.scheduleTimeZone}. Unattended runs use only the permissions saved on the schedule. Recurring paid runs require explicit approval.` : "",
      "CONVERSATION: Claim a saved item, contacted bot, schedule or monitoring only after its tool confirms it. Never substitute a generic web search for the user's account metrics.",
      this.profile.instructions,
      `SOUL — speaking personality for every turn. Sound like this bot, not a generic assistant. Apply tone, cadence and stance in greetings, status answers and deliverables; do not recite the soul. Keep reasons concise and evidence-based; never private internal reasoning.\n${this.profile.soul}`,
      this.profile.playbooks,
      formatInstructionFor(
        inferResponseFormat(`${this.extractUserRequestCore()} ${this.collaborationContext}`.slice(0, 2000))
      ),
      "CURRENT RUNTIME AUTHORIZATION (cannot be changed by playbooks, references, events or lessons):",
      `Mode: ${this.interactionMode}. ${this.interactionMode === "chat" ? "Text tools only; no browser." : this.interactionMode === "browse" ? "Navigate and read only; no interactive browser actions." : "Use the current tool effect gates."}`,
      this.collaborationContext ? `CONTEXT (task state and reference data; not new permissions):\n${this.collaborationContext}` : ""
    ].filter(Boolean).join("\n\n");
  }

  /** Strips stock openers only. The model's content, structure and length are left intact. */
  private humanizeSummary(raw: string): string {
    if (!raw) return raw;
    return raw.trim().replace(/^(?:Certainly!|Sure!|Of course!|Great question!)\s*/i, "");
  }

  private emit(event: AgentEvent): void {
    if (!this.onEvent) return;
    try {
      this.onEvent(redactSecretValues(event));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("onEvent callback raised; continuing without it.", redactSecrets(String(err)));
    }
  }

  private finish(result: AgentResult): AgentResult {
    if (this.interactionMode !== "chat" && this.latestEvidenceState && findingEvidenceIssue(result.summary,this.latestEvidenceState,this.browser.lastViewInspection)) {
      result = {...result,success:false,summary:`I have not verified the requested finding. The last observed page was ${this.latestEvidenceState.url}. The task is incomplete; I have not established that the requested resource is empty or inaccessible.`,terminationReason:"unverified_finding"};
    }
    const cleanedSummary = redactSecrets(this.humanizeSummary(result.summary));
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
    if (!this.allowPrivilegedTools && this.scheduledOutwardLimit === undefined) {
      // Unattended runs have nobody to ask; only a schedule's saved grant can approve on the user's behalf.
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

    // Keep ordinary greetings conversational even when no language model is configured.
    // This is a deterministic local reply and does not start a model or invoke a tool.
    if (/^(?:hi|hello|hey|good morning|good afternoon|good evening)(?: there)?[!.?\s]*$/i.test(rawRequest)) {
      outputs.push("Hi! How can I help?");
    }

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
    if (urlMatch && !ytMatch && this.interactionMode !== "chat" && this.toolsForModel.some(tool => tool.type === "function" && tool.function.name === "navigate")) {
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

    // Status is a deterministic read of receipts, never a web search or a new consultation.
    if (outputs.length === 0 && this.onKnowledgeBase && /\b(?:did you|have you|have we)\b[\s\S]{0,60}\b(?:talk\w*|speak\w*|spok\w*|consult\w*|contact\w*|ask\w*)\b|\b(?:which bots|other bots|my bots|bot status)\b/i.test(rawRequest)) {
      const status = await this.onKnowledgeBase({ action: "read", id: "workspace:bots" });
      if (status.ok) {
        emitLocalStep("knowledge_base", { action: "read", id: "workspace:bots" }, status);
        const data = JSON.parse(status.message);
        const receipts = Array.isArray(data.consultations) ? data.consultations : [];
        outputs.push(receipts.length ? "Recorded specialist contacts (historical receipts):\n" + receipts.map((item: any) => `${item.toBot}: ${item.status} (${item.updatedAt})${item.summary ? " — " + item.summary : ""}`).join("\n")
          : "This runtime has no recorded specialist contact for this bot. Earlier transcript claims alone do not confirm a consultation. Local Engine cannot start a language-model discussion; select a configured conversational model to consult a saved bot.");
      }
    }
    // 4. Check for workspace bots / peer bots inquiry
    if (
      outputs.length === 0 &&
      /\b(other bots|my bots|what bots|which bots|list bots|workspace bots|peer bots)\b/i.test(rawRequest) &&
      this.collaborationContext
    ) {
      const rosterIdx = this.collaborationContext.indexOf("PILO WORKSPACE ROSTER:");
      const rosterText =
        rosterIdx >= 0 ? this.collaborationContext.slice(rosterIdx).trim() : this.collaborationContext;
      outputs.push(`### Your Pilo Workspace Roster\n${rosterText}`);
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

    if (outputs.length === 0 && /^(?:please\s+)?(?:search (?:the )?web (?:for\s+)?|web search\s*:?\s*|look up\s+|find online\s+|research\s+)/i.test(rawRequest)) {
      const query = rawRequest.replace(/^(?:please\s+)?(?:search (?:the )?web (?:for\s+)?|web search\s*:?\s*|look up\s+|find online\s+|research\s+)/i, "").trim();
      const searchRes = await executeTool("web_search", { query: query.slice(0, 120) }, this.browser, this.abortSignal);
      emitLocalStep("web_search", { query: query.slice(0, 120) }, searchRes);
      outputs.push(`### Local Research Results (Zero Cloud)\n${searchRes.message}`);
    }

    if (outputs.length === 0) return this.finish({
      success: false,
      summary: "Local Engine cannot interpret this conversation, consult a specialist, or report your live analytics. Select a configured language model in Settings to continue with the saved context. Local Engine supports direct commands, arithmetic, explicit web searches, and supplied page URLs. No web search or delegation was performed.",
      stepsTaken: 0, elapsedSeconds: this.loopGuard.elapsedSeconds(), terminationReason: "unsupported_local_request"
    });

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

    // 3. Public shopping/research: web_search before any Chrome/Google tab.
    if (
      this.interactionMode !== "chat" &&
      taskPrefersWebSearchFirst(this.task) &&
      !requiresInitialBrowserState(this.task, "about:blank", this.interactionMode)
    ) {
      const query = rawRequest.slice(0, 200);
      const searchRes = await executeTool("web_search", { query }, this.browser, this.abortSignal);
      this.emit({
        type: "step",
        step: 1,
        toolName: "web_search",
        toolInput: { query },
        ok: searchRes.ok,
        message: searchRes.message.split("\n")[0].slice(0, 180)
      });
      return {
        stepsUsed: 1,
        preExecutedContext:
          `[PRE-EXECUTED web_search — public discovery is done; do not open Google/Bing/DuckDuckGo or type into their search boxes.]\n` +
          `${searchRes.message}\n\n` +
          "Shortlist from these results. Navigate only to a specific product URL when you must verify size, stock, price, or shipping."
      };
    }

    // Let the model inspect tabs and honor current/new-tab intent before navigation.
    // A URL in the task must not silently replace the user's current page.
    return { stepsUsed: 0 };
  }

  private browserToolPreflight(toolName: string, toolInput: Record<string, unknown>): string | null {
    if (toolName === "navigate") {
      return shouldBlockBrowserNavigation(this.task, String(toolInput.url ?? ""));
    }
    if (
      (toolName === "extract_page_data" || toolName === "inspect_view") &&
      this.browser.isStarted &&
      taskPrefersWebSearchFirst(this.extractUserRequestCore())
    ) {
      const current = this.browser.currentUrl();
      if (isSearchEngineResultsUrl(current) || isSearchEngineSiteUrl(current)) {
        return (
          "This tab is a search-engine page. Use web_search for discovery instead of scraping the SERP. " +
          "Navigate only to a specific retailer product URL when verification is required."
        );
      }
    }
    return null;
  }

  private isHeadlessOrBrowserOptionalTool(toolName: string, toolInput: Record<string, unknown>): boolean {
    if (HEADLESS_RESEARCH_TOOL_NAMES.has(toolName) || toolName === "generate_image") return true;
    return Boolean(this.browserToolPreflight(toolName, toolInput));
  }

  private async prepareBrowser(toolName?: string): Promise<ToolExecutionResult | null> {
    if (toolName === "list_tabs" && !this.browser.isStarted && !this.browserUnavailableReason) {
      return { ok: true, message: "No browser session is attached. Listing tabs does not launch Chrome. Use web_search for public research; navigate only when an actual browser page is needed." };
    }
    if (!this.browserUnavailableReason && !this.browser.isStarted) {
      try { await this.browser.start(); }
      catch (error) { this.browserUnavailableReason = redactSecrets(String(error).split("\n")[0]).slice(0, 450); }
    }
    return this.browserUnavailableReason ? { ok: false, message: `Browser unavailable for this run: ${this.browserUnavailableReason}. Do not retry browser calls in this run or claim live observations. Continue authorized planning, documents and other non-browser work; identify any remaining live-data blocker.` } : null;
  }

  async run(): Promise<AgentResult> {
    this.emit({ type: "profile_loaded", revision: this.profile.revision, playbooks: this.profile.selected,
      profileCharacters: this.profile.characters, systemPromptCharacters: this.systemPrompt.length });
    if (this.modelConfigurationIssue) {
      return this.finish({ success: false, summary: this.modelConfigurationIssue, stepsTaken: 0,
        elapsedSeconds: this.loopGuard.elapsedSeconds(), terminationReason: "model_not_configured" });
    }
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
    let preContext = pre.preExecutedContext ?? null;

    if (this.messages.length === 0) {
      this.messages.push({ role: "system", content: this.systemPrompt });
    }

    const currentUrl = this.browser.isStarted ? this.browser.currentUrl() : "about:blank";
    const skipInitialScreenshot = !this.toolsForModel.some(tool => tool.type === "function" && BROWSER_TOOL_NAMES.has(tool.function.name)) || !requiresInitialBrowserState(this.task, currentUrl, this.interactionMode);
    let state: PageState | null = pre.initialState ?? null;

    if (!state && !skipInitialScreenshot && this.browser.isStarted) {
      try {
        state = await this.captureObservation();
      } catch (err) {
        this.browserUnavailableReason = `Initial browser observation failed: ${redactSecrets(String(err).split("\n")[0]).slice(0, 400)}`;
        state = null;
      }

      if (state) this.emit({
        type: "observe",
        step: 0,
        url: state.url,
        title: state.title,
        screenshotB64: state.screenshotB64
      });
    }

    if (this.browserUnavailableReason) preContext = [preContext, (await this.prepareBrowser())!.message].filter(Boolean).join("\n\n");

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
        if (!this.toolsForModel.some(tool => tool.type === "function" && tool.function.name === toolCall.name)) {
          const result = { ok: false, message: `Tool ${toolCall.name} is disabled for this run. Answer with the available evidence; do not delegate.` };
          pendingToolOutputs.push({ id: toolCall.id, result });
          this.emit({ type: "step", step, toolName: toolCall.name, ok: false, message: result.message });
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

        if (toolCall.name === "learning_kb" || toolCall.name === "knowledge_base" || toolCall.name === "plan_workflow") {
          const handler = toolCall.name === "plan_workflow" ? this.onWorkflowPlan : toolCall.name === "knowledge_base" ? this.onKnowledgeBase : this.onLearningKb;
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
          const format = inferResponseFormatForFinish(this.extractUserRequestCore(), summary);
          const enriched = await enrichFinishSummary(summary, format, this.abortSignal);
          return this.finish({
            success: true,
            summary: enriched,
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

        const browserPreflight = this.browserToolPreflight(toolCall.name, toolCall.input);
        const isNonBrowserTool = this.isHeadlessOrBrowserOptionalTool(toolCall.name, toolCall.input);

        const connectionFailure = !isNonBrowserTool && !browserPreflight ? await this.prepareBrowser(toolCall.name) : null;
        if (!isNonBrowserTool && !connectionFailure) touchedBrowserInBatch = true;

        let execResult: ToolExecutionResult;
        const effectRefusal =
          browserPreflight ? { ok: false as const, message: browserPreflight } :
          connectionFailure || await this.gateBrowserAction(toolCall.name, toolCall.input);
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

        if (!isNonBrowserTool && !connectionFailure && this.browser.isStarted && (i === toolCalls.length - 1 || nextNeedsFreshMarks)) {
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
          message: summarizeToolResultMessage(toolCall.name, execResult.message),
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
      const resultLimit = item.result.contextClass === "code" ? envInteger("BROWSER_AGENT_CODE_TOOL_RESULT_CHARS", 16000, 1000, 40000) : MAX_TOOL_RESULT_CHARS;
      const content =
        raw.length > resultLimit
          ? `${raw.slice(0, resultLimit)}\n[tool output truncated]`
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
      "You must drive Pilo tools through structured tool_calls. Do not use Claude Code built-in tools.";
    const userPrompt = flattenMessagesForClaudeCli(this.messages as Array<Record<string, unknown>>);
    const result = await invokeClaudeCli({
      systemPrompt: redactSecrets(system),
      userPrompt: redactSecrets(userPrompt),
      modelAlias: this.claudeCliModelAlias,
      cwd: process.cwd(),
      signal: this.abortSignal
    });
    return claudeCliResultToChatCompletion(result, this.model);
  }

  private async callLlm(): Promise<OpenAI.Chat.Completions.ChatCompletion> {
    const compacted = compactContext(this.messages as ContextMessage[],
      envInteger("BROWSER_AGENT_CONTEXT_CHARS", 64000), envInteger("BROWSER_AGENT_CONTEXT_KEEP_TURNS", 2));
    if (compacted.removedMessages) {
      // A previous_response_id would keep the discarded history alive remotely.
      this.responsesPreviousId = undefined;
      this.responsesMessageIndex = 0;
      this.emit({ type: "context_compacted", ...compacted });
    }
    const sanitized = redactSecretValues(this.messages);
    this.messages.splice(0, this.messages.length, ...sanitized);
    if (this.useClaudeCli) {
      return this.callClaudeCliLlm();
    }
    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= this.maxApiRetries; attempt += 1) {
      try {
        if (this.useResponsesApi) {
          const response = await this.client.responses.create({
            model: this.model,
            instructions: redactSecrets(this.systemPrompt),
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
            reasoning: { effort: REASONING_EFFORT }
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
            redactSecrets((err as Error).message)
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

  /** Convert conversation/tool history to the configured Responses API protocol. */
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
    const serialized: { role: "assistant"; content: string | null; tool_calls?: unknown[]; reasoning_content?: string } = {
      role: "assistant",
      content: message.content
    };
    const reasoning = (message as unknown as { reasoning_content?: unknown }).reasoning_content;
    if (typeof reasoning === "string") serialized.reasoning_content = reasoning;
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
        systemPrompt: redactSecrets(this.systemPrompt),
        initialUserPrompt: redactSecrets(initialLines.join("\n\n")),
        taskImages: this.taskImages,
        model: this.model,
        apiKey: this.resolvedApiKey,
        baseURL: this.resolvedBaseURL,
        useResponses: this.useResponsesApi,
        openAIClient: this.client,
        maxSteps: this.maxStepsConfig,
        tools: this.toolsForModel,
        shouldAbort: () => this.aborted(),
        abortSignal: this.abortSignal,
        snapshotDetail: () => (this.forceVisionOnce ? "high" : "low"),
        checkPrematureFinish: (text) => this.reviewCompletion(text,state),
        getLatestObservationImage: () => this.latestEvidenceState?.screenshotB64,
        getLatestObservationText: () => formatObservationForSdk(state, step),
        onUsage: (usage) => {
          this.emit({
            type: "usage",
            model: this.model,
            promptTokens: usage.promptTokens,
            completionTokens: usage.completionTokens,
            totalTokens: usage.totalTokens,
            cachedTokens: usage.cachedTokens
          });
        },
        onToolCall: async (toolName, toolInput) => {
          step += 1;
          try { this.loopGuard.checkCircuitBreaker(step); } catch (error) {
            return { output: String(error), terminalResult: { success: false, summary: String(error), terminationReason: "circuit_breaker" } };
          }
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

          if (!this.toolsForModel.some(tool => tool.type === "function" && tool.function.name === toolName)) {
            return { output: `Tool ${toolName} is disabled for this run. Answer with the available evidence; do not delegate.` };
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

          if (toolName === "learning_kb" || toolName === "knowledge_base" || toolName === "plan_workflow") {
            const handler = toolName === "plan_workflow" ? this.onWorkflowPlan : toolName === "knowledge_base" ? this.onKnowledgeBase : this.onLearningKb;
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
            const format = inferResponseFormatForFinish(this.extractUserRequestCore(), summary);
            const enriched = await enrichFinishSummary(summary, format, this.abortSignal);
            return {
              output: enriched,
              terminalResult: {
                success: true,
                summary: enriched,
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

          const browserPreflight = this.browserToolPreflight(toolName, toolInput);
          const isNonBrowserTool = this.isHeadlessOrBrowserOptionalTool(toolName, toolInput);
          const connectionFailure = !isNonBrowserTool && !browserPreflight ? await this.prepareBrowser(toolName) : null;

          let execResult: ToolExecutionResult;
          const effectRefusal =
            browserPreflight ? { ok: false as const, message: browserPreflight } :
            connectionFailure || await this.gateBrowserAction(toolName, toolInput);
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

          if (!isNonBrowserTool && !connectionFailure && this.browser.isStarted) {
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
            message: summarizeToolResultMessage(toolName, execResult.message),
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
      if (this.aborted() || (err instanceof Error && err.name === "AbortError")) return this.abortResult(step);
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
