/**
 * Learn mode: the bot stands in the user's shoes and grades its own experience.
 *
 * Given a task, it plays both sides over the local message bus - a simulated user sends turns on
 * `learn.turn.user`, the real agent loop answers on `learn.turn.bot` - then scores the transcript
 * against a fixed rubric. If the experience is not stellar it writes down every area that needs
 * work, optionally proposes source patches, applies them behind selfFix's verify-or-rollback gate,
 * and finishes by running the real build and test suite so the final verdict is evidence, not an
 * opinion.
 *
 * Scores come from run telemetry (steps, failed tool calls, approval stalls, repeated summaries),
 * not from asking a model whether it did well - a model grading itself is not a signal.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { AgentEvent } from "./promptLoop";
import { MessageBus, TOPICS } from "./messageBus";
import {
  ProposedPatch,
  SelfFixOutcome,
  VerificationResult,
  Verifier,
  applyPatches,
  createDefaultVerifier
} from "./selfFix";

export type LearnSeverity = "blocker" | "major" | "minor";
export type LearnVerdict = "stellar" | "improved" | "needs_human";

export interface LearnRunOutcome {
  summary: string;
  success: boolean;
  stepsTaken: number;
  elapsedSeconds: number;
  terminationReason: string;
  events: AgentEvent[];
}

/** Runs one turn against the real agent loop. Injected so tests never need a model or a browser. */
export type LearnRunner = (input: {
  message: string;
  round: number;
  sessionId: string;
  correlationId: string;
}) => Promise<LearnRunOutcome>;

export interface LearnTurn {
  round: number;
  userMessage: string;
  botSummary: string;
  success: boolean;
  stepsTaken: number;
  elapsedSeconds: number;
  terminationReason: string;
  toolCalls: number;
  failedToolCalls: number;
  repeatedToolCalls: number;
  approvalPrompts: number;
  supervisorWarnings: number;
  verificationPauses: number;
  llmError: boolean;
}

export interface LearnScore {
  dimension: LearnDimension;
  score: number;
  evidence: string;
}

export interface ImprovementNote {
  id: string;
  dimension: LearnDimension;
  area: string;
  severity: LearnSeverity;
  evidence: string;
  suggestedFix: string;
}

/** One patch, waiting for a yes or no. `id` is what the user approves a subset by. */
export interface ProposedFix {
  id: string;
  noteId?: string;
  patch: ProposedPatch;
  /** Short before/after excerpt for the UI, so a decision needs no file reading. */
  preview: string;
}

export interface FixProposal {
  sessionId: string;
  task: string;
  notes: ImprovementNote[];
  fixes: ProposedFix[];
}

export interface FixApprovalDecision {
  approved: boolean;
  /** Which fix ids to apply. Omitted means every one in the proposal. */
  patchIds?: string[];
  reason?: string;
}

/**
 * Asked before a single character of source is written. Like the terminal-approval hook in the
 * run loop, no hook means DENY: applying an unreviewed edit is the unsafe default, not the safe one.
 */
export type OnFixApproval = (proposal: FixProposal) => Promise<FixApprovalDecision> | FixApprovalDecision;

export type FixDecisionOutcome = "not_needed" | "none_proposed" | "approved" | "denied";

export interface LearnReport {
  sessionId: string;
  task: string;
  persona: string;
  startedAt: string;
  finishedAt: string;
  rounds: number;
  transcript: LearnTurn[];
  scores: LearnScore[];
  overallScore: number;
  stellar: boolean;
  notes: ImprovementNote[];
  /** What was offered, kept whether or not it was approved, so a denial is still a record. */
  proposal?: FixProposal;
  fixDecision: FixDecisionOutcome;
  fixDecisionReason?: string;
  fix?: SelfFixOutcome;
  verification?: VerificationResult;
  verdict: LearnVerdict;
  confirmation: string;
}

export type LearnDimension =
  | "outcome"
  | "efficiency"
  | "reliability"
  | "momentum"
  | "clarity"
  | "continuity"
  | "relevance";

/** A dimension at or above this is good enough; everything below produces an improvement note. */
export const STELLAR_THRESHOLD = 4;

const DIMENSION_AREAS: Record<LearnDimension, { area: string; fix: string }> = {
  outcome: {
    area: "src/promptLoop.ts (run loop termination)",
    fix: "The run ended without delivering the asked-for result. Check the termination path that fired and make the loop either finish with the answer or state plainly what it needs."
  },
  efficiency: {
    area: "src/loopGuard.ts + system prompt step discipline",
    fix: "Too many steps for the work done. Batch independent tool calls and prefer extract_page_data over re-navigating."
  },
  reliability: {
    area: "src/agentTools.ts / src/browserController.ts",
    fix: "Tool calls failed during the run. Add a wait/retry around the failing selector or validate the arguments before the call."
  },
  momentum: {
    area: "src/promptLoop.ts (buildSystemPrompt rules 1 and 8)",
    fix: "The bot asked the user for something it could have found out itself. Tighten the rule that says to infer context from the page before asking."
  },
  clarity: {
    area: "src/promptLoop.ts (humanizeSummary)",
    fix: "The reply read like a template: filler opener, bullet wall, or over the word budget. Extend humanizeSummary to strip that shape."
  },
  continuity: {
    area: "src/server.ts (collaborationContext) + conversation history",
    fix: "A follow-up turn was answered as if it were the first. Make sure prior turns reach the next run's context."
  },
  relevance: {
    area: "src/promptLoop.ts (runLocalEngine tool routing)",
    fix: "A long reply came back with nothing to do with the question - usually a tool answering a request it should never have been handed. Route the request to the right tool, or say plainly that it can't be answered."
  }
};

const FILLER_OPENERS =
  /^(certainly|sure|of course|great question|absolutely|i'd be happy to|here are (?:several|some|a few|key))\b/i;
const STALL_QUESTIONS =
  /\b(what(?:'s| is) your (?:niche|goal|target|audience)|which (?:account|platform|niche)|could you (?:tell|share|clarify)|can you (?:tell|share|clarify)|let me know (?:what|which|your))\b/i;

function clamp(score: number): number {
  return Math.max(0, Math.min(5, Math.round(score * 10) / 10));
}

const STOPWORDS = new Set(
  ("a an and are as at be but by can could do does for from get give has have how i if in is it its me my of on " +
    "or please show so tell that the then there these this to us want was what when where which who why will with " +
    "you your now just actually result first concrete step proposed").split(" ")
);

/** Content words only: the ones that carry what the request was about. */
function contentWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 1 && !STOPWORDS.has(word));
}

/**
 * How much of what the user asked about shows up in the reply.
 *
 * Deliberately only applied to LONG replies. A correct terse answer ("4") legitimately shares no
 * words with its question, so judging it this way would punish the best possible reply. A 200-word
 * wall that shares nothing with the question is a different thing: that is a tool answering a
 * request it was never meant to handle, which is exactly what this is here to catch.
 */
export const RELEVANCE_MIN_WORDS = 40;

/**
 * Drops verbatim repetitions of the question from the reply.
 *
 * Several tools open by quoting the request back ("Web search results for \"...\":"), which would
 * otherwise score as a perfect match no matter what followed it. Only a full verbatim echo is
 * removed - a reply that happens to reuse some of the asker's words is genuinely on topic.
 */
export function stripEchoedQuestion(userMessage: string, botSummary: string): string {
  const needle = userMessage.trim();
  if (needle.length < 8) return botSummary;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return botSummary.replace(new RegExp(escaped, "gi"), " ");
}

export function relevanceOverlap(userMessage: string, botSummary: string): number | null {
  const body = stripEchoedQuestion(userMessage, botSummary);
  if (wordCount(body) < RELEVANCE_MIN_WORDS) return null;
  const asked = [...new Set(contentWords(userMessage))];
  if (asked.length === 0) return null;
  const replied = new Set(contentWords(body));
  const hits = asked.filter((word) => replied.has(word)).length;
  return hits / asked.length;
}

function wordCount(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

function normalizeSummary(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").replace(/[^a-z0-9 ]/g, "").trim();
}

/** Turns the event stream of one run into the few numbers the rubric actually scores. */
export function summarizeRunEvents(events: AgentEvent[]): Omit<LearnTurn, "round" | "userMessage" | "botSummary" | "success" | "stepsTaken" | "elapsedSeconds" | "terminationReason" | "llmError"> {
  let toolCalls = 0;
  let failedToolCalls = 0;
  let repeatedToolCalls = 0;
  let approvalPrompts = 0;
  let supervisorWarnings = 0;
  let verificationPauses = 0;
  let previousToolName: string | null = null;

  for (const event of events) {
    switch (event.type) {
      case "step": {
        toolCalls += 1;
        if (event.ok === false) failedToolCalls += 1;
        if (event.warning || event.directive) supervisorWarnings += 1;
        const toolName = typeof event.toolName === "string" ? event.toolName : null;
        if (toolName && toolName === previousToolName) repeatedToolCalls += 1;
        previousToolName = toolName;
        break;
      }
      case "privileged_approval_required":
        approvalPrompts += 1;
        break;
      case "human_verification":
        verificationPauses += 1;
        break;
      default:
        break;
    }
  }

  return {
    toolCalls,
    failedToolCalls,
    repeatedToolCalls,
    approvalPrompts,
    supervisorWarnings,
    verificationPauses
  };
}

export function toLearnTurn(round: number, userMessage: string, outcome: LearnRunOutcome): LearnTurn {
  return {
    round,
    userMessage,
    botSummary: outcome.summary ?? "",
    success: Boolean(outcome.success),
    stepsTaken: Number(outcome.stepsTaken ?? 0),
    elapsedSeconds: Number(outcome.elapsedSeconds ?? 0),
    terminationReason: outcome.terminationReason ?? "unknown",
    llmError: outcome.terminationReason === "llm_error",
    ...summarizeRunEvents(outcome.events ?? [])
  };
}

/**
 * The default stand-in for the user. Round 0 is the task as written; later rounds push on whatever
 * the previous turn did worst, which is what a real user would do.
 */
export function defaultUserSimulator(input: {
  task: string;
  round: number;
  transcript: LearnTurn[];
}): string | null {
  const { task, round, transcript } = input;
  if (round === 0) return task;

  const last = transcript[transcript.length - 1];
  if (!last) return null;

  if (last.llmError) return null; // Nothing to probe: the model never answered.
  if (!last.success) {
    return `That didn't work - you reported: "${last.botSummary.slice(0, 160)}". Do the part you can do now, and tell me exactly what is blocking the rest.`;
  }
  if (STALL_QUESTIONS.test(last.botSummary) || last.botSummary.trim().endsWith("?")) {
    return "Don't ask me for details you can find yourself - go look, then come back with the answer.";
  }
  if (round === 1) {
    return "Good. Now actually do the first concrete step you proposed, and show me the result.";
  }
  return null;
}

/** The rubric. Every dimension is derived from telemetry so the same transcript always scores the same. */
export function scoreExperience(transcript: LearnTurn[]): LearnScore[] {
  if (transcript.length === 0) {
    return [
      { dimension: "outcome", score: 0, evidence: "No turns were recorded." }
    ];
  }

  const scores: LearnScore[] = [];
  const failedTurns = transcript.filter((turn) => !turn.success);
  const llmErrors = transcript.filter((turn) => turn.llmError);

  // outcome - did the user get what they asked for?
  if (llmErrors.length > 0) {
    scores.push({
      dimension: "outcome",
      score: 0,
      evidence: `The model was unreachable on ${llmErrors.length} of ${transcript.length} turn(s): ${llmErrors[0].botSummary.slice(0, 140)}`
    });
  } else {
    const completed = transcript.filter(
      (turn) => turn.success && (turn.terminationReason === "finish_task" || turn.terminationReason === "direct_reply")
    ).length;
    const circuitBreakers = transcript.filter((turn) => turn.terminationReason === "circuit_breaker").length;
    const ratio = completed / transcript.length;
    scores.push({
      dimension: "outcome",
      score: clamp(ratio * 5 - circuitBreakers),
      evidence: `${completed}/${transcript.length} turn(s) ended with a delivered answer${circuitBreakers ? `; ${circuitBreakers} hit the circuit breaker` : ""}.`
    });
  }

  // efficiency - steps spent per turn.
  const avgSteps = transcript.reduce((total, turn) => total + turn.stepsTaken, 0) / transcript.length;
  scores.push({
    dimension: "efficiency",
    score: clamp(avgSteps <= 6 ? 5 : avgSteps >= 30 ? 1 : 5 - ((avgSteps - 6) / 24) * 4),
    evidence: `${avgSteps.toFixed(1)} steps per turn on average.`
  });

  // reliability - how many tool calls blew up.
  const toolCalls = transcript.reduce((total, turn) => total + turn.toolCalls, 0);
  const failedCalls = transcript.reduce((total, turn) => total + turn.failedToolCalls, 0);
  scores.push({
    dimension: "reliability",
    score: clamp(toolCalls === 0 ? 5 : 5 - (failedCalls / toolCalls) * 10),
    evidence: toolCalls === 0 ? "No tool calls were made." : `${failedCalls}/${toolCalls} tool call(s) failed.`
  });

  // momentum - stalling on the user instead of going and finding out.
  const stalls = transcript.filter(
    (turn) => turn.stepsTaken <= 1 && (STALL_QUESTIONS.test(turn.botSummary) || turn.botSummary.trim().endsWith("?"))
  );
  const deniedStalls = transcript.reduce((total, turn) => total + turn.approvalPrompts, 0);
  scores.push({
    dimension: "momentum",
    score: clamp(5 - stalls.length * 2.5 - Math.max(0, deniedStalls - 1) * 0.5),
    evidence: stalls.length
      ? `${stalls.length} turn(s) asked the user a question without doing any work first.`
      : "Every turn did work before replying."
  });

  // clarity - does the reply read like a person or a template?
  let clarityPenalty = 0;
  const clarityNotes: string[] = [];
  for (const turn of transcript) {
    const summary = turn.botSummary.trim();
    if (!summary) {
      clarityPenalty += 2;
      clarityNotes.push(`round ${turn.round} returned an empty reply`);
      continue;
    }
    if (FILLER_OPENERS.test(summary)) {
      clarityPenalty += 1;
      clarityNotes.push(`round ${turn.round} opened with filler`);
    }
    const words = wordCount(summary);
    if (words > 220) {
      clarityPenalty += 1;
      clarityNotes.push(`round ${turn.round} ran to ${words} words`);
    }
    const boldBullets = (summary.match(/^\s*(?:[-*•]|\d+\.)\s+\*\*/gm) ?? []).length;
    if (boldBullets >= 5) {
      clarityPenalty += 1;
      clarityNotes.push(`round ${turn.round} was a ${boldBullets}-item bullet wall`);
    }
  }
  scores.push({
    dimension: "clarity",
    score: clamp(5 - clarityPenalty),
    evidence: clarityNotes.length ? clarityNotes.join("; ") : "Replies were direct and within budget."
  });

  // relevance - is the long reply even about what was asked?
  const judged = transcript
    .map((turn) => ({ turn, overlap: relevanceOverlap(turn.userMessage, turn.botSummary) }))
    .filter((item): item is { turn: LearnTurn; overlap: number } => item.overlap !== null);
  if (judged.length > 0) {
    // Scored on the WORST round, not the average. One long reply about nothing the user asked for
    // is a defect on its own, and averaging lets a lucky word match in another round bury it.
    const worst = judged.reduce((lowest, item) => (item.overlap < lowest.overlap ? item : lowest));
    scores.push({
      dimension: "relevance",
      // 0 overlap scores 1, and 0.3 or better scores a clean 5.
      score: clamp(1 + Math.min(worst.overlap / 0.3, 1) * 4),
      evidence:
        worst.overlap === 0
          ? `round ${worst.turn.round} answered "${worst.turn.userMessage.slice(0, 60)}" with ${wordCount(worst.turn.botSummary)} words sharing nothing with the question`
          : `worst round had ${(worst.overlap * 100).toFixed(0)}% of what was asked about in its reply.`
    });
  }

  // continuity - was the follow-up actually read?
  if (transcript.length > 1) {
    const seen = new Set<string>();
    let duplicates = 0;
    for (const turn of transcript) {
      const normalized = normalizeSummary(turn.botSummary).slice(0, 220);
      if (normalized && seen.has(normalized)) duplicates += 1;
      if (normalized) seen.add(normalized);
    }
    scores.push({
      dimension: "continuity",
      score: clamp(5 - duplicates * 3),
      evidence: duplicates
        ? `${duplicates} follow-up turn(s) repeated an earlier reply verbatim.`
        : "Each follow-up moved the conversation forward."
    });
  }

  if (failedTurns.length === transcript.length && transcript.length > 0) {
    // Every turn failed: outcome already scored it, this just makes the evidence explicit.
    const outcome = scores.find((score) => score.dimension === "outcome");
    if (outcome) outcome.evidence += " Every turn failed.";
  }

  return scores;
}

export function notesFromScores(scores: LearnScore[]): ImprovementNote[] {
  return scores
    .filter((score) => score.score < STELLAR_THRESHOLD)
    .sort((a, b) => a.score - b.score)
    .map((score) => {
      const mapping = DIMENSION_AREAS[score.dimension];
      return {
        id: `${score.dimension}-${randomUUID().slice(0, 8)}`,
        dimension: score.dimension,
        area: mapping.area,
        severity: score.score <= 1 ? "blocker" : score.score < 3 ? "major" : "minor",
        evidence: score.evidence,
        suggestedFix: mapping.fix
      } satisfies ImprovementNote;
    });
}

export function personaFor(task: string): string {
  return (
    `You are the user who just typed: "${task.trim().slice(0, 300)}". ` +
    "Judge the experience the way that user would: did you get the thing you asked for, quickly, " +
    "without being asked questions you shouldn't have to answer?"
  );
}

export interface LearnModeOptions {
  task: string;
  bus: MessageBus;
  runner: LearnRunner;
  repoRoot: string;
  /** Default 3. The simulator can stop earlier when it has nothing left to probe. */
  maxRounds?: number;
  userSimulator?: (input: { task: string; round: number; transcript: LearnTurn[] }) => string | null;
  /**
   * Turns improvement notes into exact-text patches. Left out, learn mode reports the areas and
   * applies nothing - it never invents an edit on its own.
   */
  proposePatches?: (input: { notes: ImprovementNote[]; transcript: LearnTurn[]; task: string }) => Promise<ProposedPatch[]>;
  /**
   * Asked before anything is written. Without it, patches are proposed, documented, and left
   * unapplied - the session reports what it would change and stops there.
   */
  onFixApproval?: OnFixApproval;
  /** Defaults to the real `npm run build` + `npm test`. */
  verify?: Verifier;
  /** Set false to skip the patch-proposal step entirely and only report findings. */
  allowSelfFix?: boolean;
  reportDir?: string;
  /** Lets the session write durable lessons into the bot's learning KB. */
  onLearning?: (input: { kind: "mistake" | "learning"; text: string }) => Promise<void> | void;
}

/** A few lines of before/after, enough to decide on a patch without opening the file. */
export function previewPatch(patch: ProposedPatch, maxLines = 6, maxChars = 400): string {
  const clip = (text: string): string => {
    const lines = text.split("\n");
    const kept = lines.slice(0, maxLines).join("\n").slice(0, maxChars);
    const truncated = lines.length > maxLines || text.length > kept.length;
    return `${kept}${truncated ? "\n…" : ""}`;
  };
  return `- before:\n${clip(patch.find)}\n- after:\n${clip(patch.replace)}`;
}

/**
 * The durable write-up of a session: what it tried, how it scored, what needs work, and the exact
 * patches it wants to apply. Saved whether or not anything is approved, so a denial still leaves a
 * record you can act on later by hand.
 */
export function renderLearnDocument(report: LearnReport): string {
  const lines: string[] = [];
  lines.push(`# Learn session - ${report.verdict}`);
  lines.push("");
  lines.push(`- Task: ${report.task}`);
  lines.push(`- Session: \`${report.sessionId}\``);
  lines.push(`- Ran: ${report.startedAt} to ${report.finishedAt} (${report.rounds} round(s))`);
  lines.push(`- Score: ${report.overallScore.toFixed(1)}/5 ${report.stellar ? "(stellar)" : "(below the bar)"}`);
  lines.push("");

  lines.push("## Scores");
  lines.push("");
  lines.push("| Dimension | Score | Evidence |");
  lines.push("| --- | --- | --- |");
  for (const score of report.scores) {
    lines.push(`| ${score.dimension} | ${score.score.toFixed(1)}/5 | ${score.evidence.replace(/\|/g, "\\|")} |`);
  }
  lines.push("");

  lines.push("## What the user experienced");
  lines.push("");
  for (const turn of report.transcript) {
    lines.push(`### Round ${turn.round + 1}`);
    lines.push("");
    lines.push(`**As you:** ${turn.userMessage}`);
    lines.push("");
    lines.push(
      `**Bot:** ${turn.botSummary || "(empty reply)"}\n\n` +
        `_${turn.success ? "Succeeded" : "Failed"} in ${turn.stepsTaken} step(s) / ${turn.elapsedSeconds.toFixed(1)}s ` +
        `(${turn.terminationReason}); ${turn.failedToolCalls}/${turn.toolCalls} tool call(s) failed; ` +
        `${turn.approvalPrompts} approval prompt(s)._`
    );
    lines.push("");
  }

  if (report.notes.length === 0) {
    lines.push("## Areas to improve");
    lines.push("");
    lines.push("None - every dimension cleared the bar.");
    lines.push("");
  } else {
    lines.push("## Areas to improve");
    lines.push("");
    for (const note of report.notes) {
      lines.push(`### [${note.severity}] ${note.dimension} - ${note.area}`);
      lines.push("");
      lines.push(`- Evidence: ${note.evidence}`);
      lines.push(`- Suggested: ${note.suggestedFix}`);
      lines.push("");
    }
  }

  lines.push("## Proposed code changes");
  lines.push("");
  if (!report.proposal || report.proposal.fixes.length === 0) {
    lines.push(
      report.fixDecision === "not_needed"
        ? "None needed."
        : `None written. ${report.fixDecisionReason ?? "No patch could be written for these findings."}`
    );
    lines.push("");
  } else {
    const statusLine =
      report.fixDecision === "approved"
        ? report.fix?.applied
          ? "**Approved and applied** (verification passed)."
          : `**Approved but not kept** - ${report.fix?.summary ?? "the change did not survive verification"}.`
        : `**Not applied** - ${report.fixDecisionReason ?? "awaiting your approval"}. Nothing in the tree was changed.`;
    lines.push(statusLine);
    lines.push("");
    for (const fix of report.proposal.fixes) {
      lines.push(`### ${fix.id} - \`${fix.patch.file}\``);
      lines.push("");
      lines.push(`${fix.patch.rationale}`);
      lines.push("");
      lines.push("```diff");
      for (const line of fix.patch.find.split("\n")) lines.push(`-${line}`);
      for (const line of fix.patch.replace.split("\n")) lines.push(`+${line}`);
      lines.push("```");
      lines.push("");
    }
  }

  lines.push("## Confirmation");
  lines.push("");
  lines.push(report.confirmation);
  lines.push("");
  return lines.join("\n");
}

export function renderLearnReport(report: LearnReport): string {
  const lines: string[] = [];
  const verdictLabel =
    report.verdict === "stellar"
      ? "Stellar - no changes needed"
      : report.verdict === "improved"
        ? "Was not stellar; fixed and verified"
        : "Needs a human";
  lines.push(`**Learn mode - ${verdictLabel}** (${report.overallScore.toFixed(1)}/5 over ${report.rounds} self-play round(s))`);
  lines.push("");
  for (const score of report.scores) {
    lines.push(`- ${score.dimension}: ${score.score.toFixed(1)}/5 - ${score.evidence}`);
  }
  if (report.notes.length > 0) {
    lines.push("");
    lines.push("Areas to improve:");
    for (const note of report.notes) {
      lines.push(`- [${note.severity}] ${note.area} - ${note.suggestedFix}`);
    }
  }
  if (report.proposal && report.proposal.fixes.length > 0) {
    lines.push("");
    lines.push(
      report.fixDecision === "approved"
        ? `Proposed ${report.proposal.fixes.length} code change(s), which you approved:`
        : `I wrote ${report.proposal.fixes.length} code change(s) but changed nothing - say the word and I'll apply them:`
    );
    for (const fix of report.proposal.fixes) {
      lines.push(`- \`${fix.patch.file}\` — ${fix.patch.rationale}`);
    }
  }
  if (report.fix) {
    lines.push("");
    lines.push(`Self-fix: ${report.fix.summary}`);
    if (report.fix.rejected.length > 0) {
      for (const rejection of report.fix.rejected) {
        lines.push(`- rejected ${rejection.patch.file}: ${rejection.reason}`);
      }
    }
  }
  lines.push("");
  lines.push(report.confirmation);
  return lines.join("\n");
}

export class LearnModeSession {
  readonly sessionId = randomUUID();
  private readonly options: LearnModeOptions;

  constructor(options: LearnModeOptions) {
    if (!options.task.trim()) throw new Error("learn mode needs a non-empty task");
    this.options = options;
  }

  async run(): Promise<LearnReport> {
    const {
      task,
      bus,
      runner,
      repoRoot,
      maxRounds = 3,
      userSimulator = defaultUserSimulator,
      proposePatches,
      allowSelfFix = true,
      reportDir,
      onLearning
    } = this.options;

    const startedAt = new Date().toISOString();
    const persona = personaFor(task);
    const transcript: LearnTurn[] = [];
    const correlationId = this.sessionId;

    bus.publish(TOPICS.learnStarted, { sessionId: this.sessionId, task, persona }, { source: "learn-mode", correlationId });

    for (let round = 0; round < maxRounds; round += 1) {
      const message = userSimulator({ task, round, transcript });
      if (!message) break;

      await bus.publishAndWait(
        TOPICS.learnUserTurn,
        { sessionId: this.sessionId, round, message },
        { source: "simulated-user", correlationId }
      );

      let outcome: LearnRunOutcome;
      try {
        outcome = await runner({ message, round, sessionId: this.sessionId, correlationId });
      } catch (err) {
        outcome = {
          summary: `The run crashed: ${(err as Error).message}`,
          success: false,
          stepsTaken: 0,
          elapsedSeconds: 0,
          terminationReason: "crash",
          events: []
        };
      }

      const turn = toLearnTurn(round, message, outcome);
      transcript.push(turn);
      await bus.publishAndWait(
        TOPICS.learnBotTurn,
        { sessionId: this.sessionId, round, turn },
        { source: "bot-under-test", correlationId }
      );

      // A dead model or a tripped breaker won't get better on the next round.
      if (turn.llmError || turn.terminationReason === "crash") break;
    }

    const scores = scoreExperience(transcript);
    const overallScore = scores.length
      ? scores.reduce((total, score) => total + score.score, 0) / scores.length
      : 0;
    const notes = notesFromScores(scores);
    const stellar = scores.length > 0 && scores.every((score) => score.score >= STELLAR_THRESHOLD);

    bus.publish(
      TOPICS.learnScored,
      { sessionId: this.sessionId, scores, overallScore, stellar, notes },
      { source: "learn-mode", correlationId }
    );

    let fix: SelfFixOutcome | undefined;
    let proposal: FixProposal | undefined;
    let fixDecision: FixDecisionOutcome = stellar ? "not_needed" : "none_proposed";
    let fixDecisionReason: string | undefined;

    if (!stellar && allowSelfFix && proposePatches) {
      let patches: ProposedPatch[] = [];
      try {
        patches = await proposePatches({ notes, transcript, task });
      } catch (err) {
        fixDecisionReason = `No patches could be written: ${(err as Error).message}`;
      }

      if (patches.length > 0) {
        proposal = {
          sessionId: this.sessionId,
          task,
          notes,
          fixes: patches.map((patch, index) => ({
            id: `fix-${index + 1}`,
            ...(notes[index] ? { noteId: notes[index].id } : {}),
            patch,
            preview: previewPatch(patch)
          }))
        };
        // Published, documented, and still unapplied. Nothing is written until the answer comes back.
        bus.publish(TOPICS.learnFixProposed, { sessionId: this.sessionId, proposal }, { source: "learn-mode", correlationId });

        let decision: FixApprovalDecision = {
          approved: false,
          reason: "nobody was asked, so the patches were left unapplied"
        };
        if (this.options.onFixApproval) {
          try {
            decision = await this.options.onFixApproval(proposal);
          } catch (err) {
            decision = { approved: false, reason: `the approval hook failed (${(err as Error).message})` };
          }
        }
        bus.publish(
          TOPICS.learnFixDecision,
          { sessionId: this.sessionId, ...decision },
          { source: "learn-mode", correlationId }
        );

        if (decision.approved) {
          const selected = decision.patchIds
            ? proposal.fixes.filter((item) => decision.patchIds?.includes(item.id))
            : proposal.fixes;
          if (selected.length === 0) {
            fixDecision = "denied";
            fixDecisionReason = "approved, but no patches were selected";
          } else {
            fixDecision = "approved";
            fixDecisionReason = decision.reason;
            fix = await applyPatches(
              selected.map((item) => item.patch),
              {
                repoRoot,
                verify: this.options.verify,
                backupDir: reportDir ? join(reportDir, "backups", this.sessionId) : undefined
              }
            );
            bus.publish(TOPICS.learnFixApplied, { sessionId: this.sessionId, fix }, { source: "learn-mode", correlationId });
          }
        } else {
          fixDecision = "denied";
          fixDecisionReason = decision.reason ?? "you didn't approve the patches";
        }
      }
    }

    // Always confirm the tree is green at the end, fix or no fix - that is the point of the mode.
    const verify = this.options.verify ?? createDefaultVerifier(repoRoot);
    let verification: VerificationResult;
    if (fix?.applied && fix.verification) {
      verification = fix.verification; // Already proven green by the self-fix gate.
    } else {
      try {
        verification = await verify();
      } catch (err) {
        verification = {
          ok: false,
          checks: [{ name: "verify", ok: false, output: (err as Error).message, durationMs: 0 }]
        };
      }
    }
    bus.publish(TOPICS.learnVerified, { sessionId: this.sessionId, verification }, { source: "learn-mode", correlationId });

    const verdict: LearnVerdict = stellar
      ? "stellar"
      : fix?.applied && verification.ok
        ? "improved"
        : "needs_human";

    const failedCheck = verification.checks.find((check) => !check.ok);
    const baseConfirmation = verification.ok
      ? `Verified: ${verification.checks.map((check) => check.name).join(" + ")} passed, so the code builds and the suite is green.`
      : `Not verified: ${failedCheck ? `${failedCheck.name} failed` : "verification failed"}. The tree was left ${fix?.rolledBack ? "rolled back to its pre-fix state" : "untouched"}; a human needs to look.`;
    const confirmation =
      fixDecision === "denied" && proposal
        ? `${proposal.fixes.length} patch(es) are written down and waiting - nothing was changed (${fixDecisionReason}). ${baseConfirmation}`
        : baseConfirmation;

    const report: LearnReport = {
      sessionId: this.sessionId,
      task,
      persona,
      startedAt,
      finishedAt: new Date().toISOString(),
      rounds: transcript.length,
      transcript,
      scores,
      overallScore,
      stellar,
      notes,
      ...(proposal ? { proposal } : {}),
      fixDecision,
      ...(fixDecisionReason ? { fixDecisionReason } : {}),
      ...(fix ? { fix } : {}),
      verification,
      verdict,
      confirmation
    };

    if (onLearning) {
      for (const note of notes.slice(0, 3)) {
        try {
          await onLearning({
            kind: note.severity === "minor" ? "learning" : "mistake",
            text: `${note.dimension}: ${note.evidence}`
          });
        } catch {
          // The KB is a nice-to-have here; a failed write must not fail the session.
        }
      }
    }

    if (reportDir) {
      try {
        await mkdir(reportDir, { recursive: true });
        const serialized = JSON.stringify(report, null, 2);
        // The markdown copy is the one a person reads: findings and the exact diffs, kept whether
        // or not the patches were approved, so a denial still leaves something to act on.
        const document = renderLearnDocument(report);
        await writeFile(join(reportDir, `${this.sessionId}.json`), serialized, "utf8");
        await writeFile(join(reportDir, "latest.json"), serialized, "utf8");
        await writeFile(join(reportDir, `${this.sessionId}.md`), document, "utf8");
        await writeFile(join(reportDir, "latest.md"), document, "utf8");
      } catch (err) {
        console.warn(`Learn mode: could not persist report: ${(err as Error).message}`);
      }
    }

    bus.publish(TOPICS.learnCompleted, { sessionId: this.sessionId, report }, { source: "learn-mode", correlationId });
    return report;
  }
}
