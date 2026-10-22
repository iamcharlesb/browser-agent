/** The ReAct orchestrator: observe, evaluate delta, infer, execute, supervise, prune. */

import OpenAI from "openai";
import { TOOLS, ToolExecutionResult, executeTool } from "./agentTools";
import { BrowserActionError, BrowserController, PageState } from "./browserController";
import {
  claudeCliModelAlias,
  claudeCliResultToChatCompletion,
  flattenMessagesForClaudeCli,
  invokeClaudeCli,
  isClaudeCliModel,
  toolsCatalogForClaudeCli
} from "./claudeCli";
import { CircuitBreakerTriggered, LoopGuard, PrunableMessage } from "./loopGuard";

export const DEFAULT_MODEL = "gpt-6-luna";
/** Keep replies short — Grok-like usefulness without dumping tokens into long essays. */
const MAX_TOKENS = 800;
const GPT6_REASONING_EFFORT = "low" as const;
/** Cap tool output text fed back into the model (full UI events can still show more). */
const MAX_TOOL_RESULT_CHARS = 1400;
const ZERO_DELTA_WARNING =
  "Warning: Last action produced zero visual or DOM changes. Choose an alternate element or approach.";
const MAX_API_RETRIES_DEFAULT = 3;
/** Local mutation and paid-generation tools excluded from scheduled/unattended runs. */
const PRIVILEGED_TOOL_NAMES = new Set(["run_terminal_command", "workspace_file", "create_document", "generate_image"]);
const INTERACTIVE_BROWSER_TOOL_NAMES = new Set(["click_mark", "type_mark", "click_element", "click_coords", "type_text", "key_press"]);
const MUTATING_WORKSPACE_FILE_ACTIONS = new Set(["write", "append"]);

function requiresPrivilegedApproval(toolName: string, input: Record<string, unknown>): boolean {
  if (toolName === "run_terminal_command") return true;
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
export type OnTerminalApproval = (details: { toolName: string; description: string }) => Promise<boolean> | boolean;
export type OnScheduleTask = (input: Record<string, unknown>) => Promise<ToolExecutionResult>;
export type OnLearningKb = (input: Record<string, unknown>) => Promise<ToolExecutionResult>;

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
  scheduleTimeZone?: string;
  /** Set false for scheduled/unattended runs: removes local writes and paid image generation. */
  allowPrivilegedTools?: boolean;
  /** Set false for unattended tasks so they can inspect pages but cannot click or type. */
  allowBrowserInteraction?: boolean;
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
    /\b(run_terminal_command|terminal|shell|bash|zsh|git status|git log|npm |npx |python3? |node |ls |grep |web_search|workspace_file|create_document|calculate|other bots|my bots|workspace bots|delegate_to_bot)\b/.test(lower) &&
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
  private readonly allowPrivilegedTools: boolean;
  private readonly onScheduleTask?: OnScheduleTask;
  private readonly onLearningKb?: OnLearningKb;
  private readonly scheduleTimeZone: string;
  private readonly allowBrowserInteraction: boolean;
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
    this.keepRecentImages = keepRecentImages;
    this.maxApiRetries = maxApiRetries;
    this.onEvent = options.onEvent;
    this.onHumanVerification = options.onHumanVerification;
    this.onTerminalApproval = options.onTerminalApproval;
    this.allowPrivilegedTools = options.allowPrivilegedTools ?? true;
    this.onScheduleTask = options.onScheduleTask;
    this.onLearningKb = options.onLearningKb;
    this.scheduleTimeZone = options.scheduleTimeZone || "UTC";
    this.allowBrowserInteraction = options.allowBrowserInteraction ?? true;
    this.toolsForModel = TOOLS.filter((tool) => {
      if (tool.type !== "function") return true;
      if (!this.allowPrivilegedTools && PRIVILEGED_TOOL_NAMES.has(tool.function.name)) return false;
      if (!this.allowBrowserInteraction && INTERACTIVE_BROWSER_TOOL_NAMES.has(tool.function.name)) return false;
      return true;
    });
    this.loopGuard = new LoopGuard(options.maxSteps ?? 25, options.maxDurationSeconds ?? 900.0);
    this.systemPrompt = this.buildSystemPrompt();
  }

  private buildSystemPrompt(): string {
    return (
      `You are ${this.botName}. Role & Purpose: ${this.expertise}.\n` +
      "Local personal agent in Open Bots (runs behind the user's browser).\n" +
      "TOKEN DISCIPLINE (critical — stay useful like Grok, not expensive):\n" +
      "- Prefer tools over long explanations once a plan is agreed. Act, then give a short result.\n" +
      "- User-facing replies: ≤150 words unless they ask for detail. No essays, no filler, no textbook walls.\n" +
      "- Structured plans beat paragraphs: short labeled lines, not bold bullet essays.\n" +
      "- Finish as soon as you have the answer or a concrete next ask. Don't narrate every click.\n" +
      "- Batch independent tool calls. Prefer extract_page_data / Detected Stats over re-navigating.\n" +
      "- Skip screenshots mentally when Text/Detected Stats already answer the question.\n" +
      "PLAN FIRST ON COMPLEX ASKS (marketing, growth, Reddit, SEO, multi-step work):\n" +
      "- Before spraying tools, briefly reason: goal, niche signals, constraints (esp. ban/spam/karma risk), biggest leverage.\n" +
      "- Then give a compact actionable plan (≤8 short lines). Prefer structured labels over essays.\n" +
      "- ≤3 targeted research calls when needed; don't burn a step farm of generic searches before a plan.\n" +
      "- Start research/audit tools to ground the plan in their real account/site when signed in; don't wait to be spoon-fed niche details.\n" +
      "- Stop for approval before follows/likes/comments/posts/publishes/GA-GTM edits; research + drafting is free to do.\n" +
      "SCHEDULING: schedule_task for one-time/daily jobs (tz=" + this.scheduleTimeZone + "). Schedules are read-only for engagement (research/monitor/draft only). Never like/follow/comment/post from a schedule. Ask before recurring paid model runs; set costApproved only after explicit yes.\n" +
      "VOICE: warm, direct, specific — like a sharp social-media co-founder texting. Never corporate filler ('Certainly!', 'Here are several strategies:', 'In conclusion').\n" +
      "CAPABILITIES: delegate_to_bot (workspace roster in CONTEXT); learning_kb (durable local memory); run_terminal_command; headless web_search/calculate/create_document/workspace_file/understand_youtube_video; generate_image (one clear prompt); browser navigate/click_*/type_*/extract_page_data/scroll/wait.\n" +
      "Rules:\n" +
      "1. SPEED after the plan: batch tools; minimum steps; don't stall asking what the niche is if the profile can tell you.\n" +
      "2. PEER BOTS: answer from OPEN BOTS WORKSPACE ROSTER — never generic 'what is a bot' definitions.\n" +
      "3. Terminal/file writes need user approval; if denied, adapt once — don't retry the same call.\n" +
      "4. Check [Detected Stats] and Text first; if the ask is only for numbers/bio, finish_task immediately.\n" +
      "5. After SPA profile clicks (IG/X), extract_page_data or wait(1s) before failing.\n" +
      "6. YouTube → understand_youtube_video, never navigate for transcripts.\n" +
      "7. Never expose credentials; ask before money or public post/delete.\n" +
      "8. RESEARCH YOURSELF for niche targets: infer niche from profile, find real candidates, draft comments, return a shortlist for approval. Never follow/like/comment/message until they approve specific targets+wording.\n" +
      "9. PACE engagement: ≤5–8 likes/follows/comments per run with wait between; leave the rest for later.\n" +
      "10. CONFIRM UI state (Follow→Following, toast, visible comment) before claiming success.\n" +
      "11. LEARNINGS/KB in CONTEXT: recall niche, prior mistakes, and what worked; when the user corrects you, call learning_kb save (mistake/intent) so the next run is smarter. For growth/SEO/Reddit, reuse prior niche and avoid repeating failed approaches.\n" +
      "INSTAGRAM / FOLLOWER GROWTH PLAYBOOK (be a proactive marketing specialist):\n" +
      "- On 'grow followers / increase engagement / help me market': do NOT dump generic tips and stop. Reason → plan → audit/research → propose concrete next actions for approval.\n" +
      "- Plan shape (keep lean): Goal & niche | Profile audit | Content angle (2–3 post ideas) | Engagement (who to like/comment + draft lines) | Follow targets (5–8 handles + why) | Pacing (≤5–8 actions/run) | Schedule (optional daily research-only check-in).\n" +
      "- Execution order: (1) open signed-in profile + read stats/bio/posts, (2) infer niche, (3) research real accounts / hashtags, (4) return shortlist + draft comments + ask what to approve, (5) only then execute approved follows/likes/comments with pacing.\n" +
      "- If not signed in: say so once, ask Open Live Browser / sign in, then resume — don't burn steps guessing.\n" +
      "- Prefer propose→approve→execute over unsupervised engagement.\n" +
      "REDDIT / COMMUNITY GROWTH PLAYBOOK (smart marketer — never naive spam):\n" +
      "- On 'Reddit bot / promote on Reddit / community growth': refuse unsupervised auto-posting. Reason → lean plan → research rules/subs → drafts + schedule for approval. Never blast links or spam identical comments.\n" +
      "- Plan shape (≤8 lines): Positioning | Target subs (3–5 + why) | Rules/self-promo norms | Account trust (aged > throwaway; karma/comment history; ban/shadowban/spam-filter risk) | Karma-build phase (value-only first) | Content angles (2–3 value-first drafts, disclosure when relevant) | Engagement + pacing | Schedule (research/draft-only unless they approve a specific post) | Do-NOT list.\n" +
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
    const description = describePrivilegedCall(toolName, input);
    this.emit({
      type: "privileged_approval_required",
      toolName,
      description,
      message: `${this.botName} wants to: ${description}. Approve or deny before it runs.`
    });

    const waitStarted = Date.now();
    let approved = false;
    if (this.onTerminalApproval) {
      try {
        approved = await this.onTerminalApproval({ toolName, description });
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

    this.emit({ type: "privileged_approval_resolved", toolName, description, approved });
    return approved;
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

    // 1. Direct `$ <command>` shell invocation: skips the LLM round-trip for speed, but still goes
    //    through the same explicit per-command approval as any other privileged tool call - and is
    //    only available on attended runs, never on scheduled/unattended ones.
    const directShellMatch = /^\$\s*([^\n]+)$/.exec(rawRequest);
    if (directShellMatch && this.allowPrivilegedTools) {
      const cmd = directShellMatch[1].trim();
      const approved = await this.requestPrivilegedApproval("run_terminal_command", { command: cmd });
      const res = approved
        ? await executeTool("run_terminal_command", { command: cmd }, this.browser)
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

      const message = response.choices[0].message;
      const toolCalls = this.extractToolCalls(message);
      this.messages.push(this.serializeAssistantMessage(message, toolCalls.length));
      if (this.useResponsesApi) this.responsesMessageIndex = this.messages.length;

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

        if (toolCall.name === "learning_kb") {
          const result = this.onLearningKb
            ? await this.onLearningKb(toolCall.input)
            : { ok: false, message: "Learning KB is unavailable in this app instance." };
          pendingToolOutputs.push({ id: toolCall.id, result });
          this.emit({
            type: "step",
            step,
            toolName: "learning_kb",
            toolInput: toolCall.input,
            ok: result.ok,
            message: result.message.slice(0, 180)
          });
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

        let execResult: ToolExecutionResult;
        if (requiresPrivilegedApproval(toolCall.name, toolCall.input)) {
          const approved = await this.requestPrivilegedApproval(toolCall.name, toolCall.input);
          execResult = approved
            ? await executeTool(toolCall.name, toolCall.input, this.browser)
            : { ok: false, message: "This action was not approved by the user and was not executed." };
        } else {
          execResult = await executeTool(toolCall.name, toolCall.input, this.browser);
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

    // Skip screenshots when text already has profile stats — saves vision tokens on IG/X audits.
    const textHasStats = Boolean(state?.pageText && /\[Detected Stats:/i.test(state.pageText));
    const includeScreenshot = Boolean(
      state && state.screenshotB64 && state.url !== "about:blank" && !textHasStats
    );
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

  private async callClaudeCliLlm(): Promise<OpenAI.Chat.Completions.ChatCompletion> {
    const system =
      `${this.systemPrompt}\n\n${toolsCatalogForClaudeCli(this.toolsForModel)}\n` +
      "You must drive Open Bots tools through structured tool_calls. Do not use Claude Code built-in tools.";
    const userPrompt = flattenMessagesForClaudeCli(this.messages as Array<Record<string, unknown>>);
    const result = await invokeClaudeCli({
      systemPrompt: system,
      userPrompt,
      modelAlias: this.claudeCliModelAlias,
      cwd: process.cwd()
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
          });
          this.responsesPreviousId = response.id;
          const calls = response.output
            .filter((item): item is OpenAI.Responses.ResponseFunctionToolCall => item.type === "function_call")
            .slice(0, 4)
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
