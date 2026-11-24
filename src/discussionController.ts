import { randomUUID } from "node:crypto";
import { envInteger } from "./runtimeConfig";

export interface DiscussionLimits {
  maxConsultations: number;
  maxPerBot: number;
  maxDurationMs: number;
  repeatSimilarity: number;
  contextChars: number;
}

export function discussionLimits(): DiscussionLimits {
  return {
    maxConsultations: envInteger("BROWSER_AGENT_MAX_DISCUSSION_ROUNDS", 4, 1, 100),
    maxPerBot: envInteger("BROWSER_AGENT_MAX_CONSULTATIONS_PER_BOT", 2, 1, 100),
    maxDurationMs: envInteger("BROWSER_AGENT_MAX_DISCUSSION_SECONDS", 180, 1, 14_400) * 1000,
    repeatSimilarity: envInteger("BROWSER_AGENT_DISCUSSION_REPEAT_PERCENT", 85, 50, 100) / 100,
    contextChars: envInteger("BROWSER_AGENT_DISCUSSION_CONTEXT_CHARS", 12_000, 2000, 100_000)
  };
}

export interface Consultation {
  id: string;
  bot: string;
  task: string;
  suppliedContext: string;
  status: "pending" | "queued" | "running" | "completed" | "failed";
  summary?: string;
  outcomeRef?: string;
}
export type DiscussionPhase = "consulting" | "synthesizing" | "completed" | "failed" | "cancelled";

const words = (text: string): Set<string> => new Set(text.toLowerCase().match(/[a-z0-9][a-z0-9_.:/%-]*/g) || []);
const normalized = (text: string): string => text.toLowerCase().replace(/\s+/g, " ").trim();
const botKey = (text: string): string => text.trim().toLowerCase();

/** Lexical repetition is a stopping heuristic, never proof that two claims agree or are true. */
export function replySimilarity(left: string, right: string): number {
  const a = words(left), b = words(right);
  if (!a.size || !b.size) return 0;
  const common = [...a].filter(word => b.has(word)).length;
  return common / (a.size + b.size - common);
}

export function isRoutingEcho(summary: string): boolean {
  return /^(?:\s*(?:plan:\s*)?)(?:handing off to\b|i[’']?m checking with\b|continue acting as\b)/i.test(summary);
}

/** Owns admission and termination, without using another model to judge another model. */
export class DiscussionController {
  readonly consultations: Consultation[] = [];
  readonly startedAt: number;
  phase: DiscussionPhase = "consulting";
  stopReason?: string;
  activeRunId?: string;
  activeBot?: string;

  constructor(readonly coordinator: string, readonly limits: DiscussionLimits, private readonly now = Date.now) {
    this.startedAt = now();
  }

  remainingMs(): number { return Math.max(0, this.limits.maxDurationMs - (this.now() - this.startedAt)); }

  stop(reason: string): void {
    if (["completed", "failed", "cancelled"].includes(this.phase)) return;
    this.phase = "synthesizing";
    this.stopReason ??= reason;
  }

  checkBudget(): void {
    if (!this.remainingMs()) this.stop("The discussion time budget was reached.");
    if (this.consultations.length >= this.limits.maxConsultations) this.stop("The consultation budget was reached.");
  }

  request(bot: string, task: string, suppliedContext = ""): { allowed: true; consultation: Consultation } | { allowed: false; reason: string } {
    this.checkBudget();
    if (this.phase !== "consulting") return { allowed: false, reason: this.stopReason || "This discussion is already closed." };
    const previous = this.consultations.filter(item => botKey(item.bot) === botKey(bot));
    let reason: string | undefined;
    if (botKey(bot) === botKey(this.coordinator)) reason = "A coordinator cannot consult itself.";
    else if (!bot.trim() || !task.trim()) reason = "A consultation needs a named specialist and a specific question.";
    else if (previous.length >= this.limits.maxPerBot) reason = "The per-specialist consultation budget was reached.";
    else if (previous.some(item => normalized(item.task + " " + item.suppliedContext) === normalized(task + " " + suppliedContext))) {
      reason = "This specialist already received the same question and supplied evidence.";
    }
    if (reason) { this.stop(reason); return { allowed: false, reason }; }
    const consultation: Consultation = { id: randomUUID(), bot: bot.trim(), task, suppliedContext, status: "pending" };
    this.consultations.push(consultation);
    return { allowed: true, consultation };
  }

  record(id: string, result: { success: boolean; summary: string; outcomeRef?: string; delegated?: boolean }, continueAfterFailure = false): boolean {
    const item = this.consultations.find(entry => entry.id === id);
    if (!item || !["pending", "queued", "running"].includes(item.status) || ["completed", "failed", "cancelled"].includes(this.phase)) return false;
    item.summary = result.summary;
    item.outcomeRef = result.outcomeRef;
    const invalid = result.delegated || !result.summary.trim() || isRoutingEcho(result.summary);
    item.status = result.success && !invalid ? "completed" : "failed";
    if (invalid && !continueAfterFailure) this.stop("The specialist returned routing text or an empty answer instead of a result.");
    else if (!result.success && !continueAfterFailure) this.stop("The specialist could not complete its consultation.");
    else if (this.consultations.some(previous => previous !== item && previous.status === "completed" &&
      botKey(previous.bot) === botKey(item.bot) && replySimilarity(previous.summary || "", result.summary) >= this.limits.repeatSimilarity)) {
      this.stop("The specialist repeated an earlier answer; further consultation is unlikely to add useful information.");
    }
    this.checkBudget();
    return true;
  }

  claim(id: string): boolean {
    const item = this.consultations.find(entry => entry.id === id);
    if (!item || !["pending", "queued"].includes(item.status) || this.phase !== "consulting") return false;
    item.status = "running";
    return true;
  }

  context(): string {
    const header = [
      `CONSULTATIONS: ${this.consultations.length}/${this.limits.maxConsultations}. Phase: ${this.phase}.`,
      this.stopReason ? `STOP REASON: ${this.stopReason}` : "Further consultation must answer a distinct unresolved question.",
      "These are attributed reports, not independent verification. Repeating a claim does not strengthen its evidence. A text-only specialist cannot resolve missing live observations."
    ].join("\n");
    const budget = Math.max(0, this.limits.contextChars - header.length - 2);
    const perEntry = Math.floor(budget / Math.max(1, this.consultations.length));
    const entries = this.consultations.map(item => [
      `${item.bot} | ${item.status} | consultation ${item.id}${item.outcomeRef ? ` | source ${item.outcomeRef}` : ""}`,
      `Question: ${item.task.slice(0, Math.floor(perEntry * .2))}`,
      `Supplied evidence/context (coordinator report): ${item.suppliedContext.slice(0, Math.floor(perEntry * .3))}`,
      `Specialist answer (reported): ${(item.summary || "Awaiting result").slice(0, Math.floor(perEntry * .4))}`
    ].join("\n").slice(0, perEntry));
    return [header, ...entries].join("\n\n").slice(0, this.limits.contextChars);
  }

  finish(success: boolean): void { this.phase = success ? "completed" : "failed"; }
  cancel(): void { this.phase = "cancelled"; this.stopReason = "Stopped by the user."; }
  snapshot() {
    return { phase: this.phase, consultations: this.consultations.length, maxConsultations: this.limits.maxConsultations,
      stopReason: this.stopReason, runId: this.activeRunId, botName: this.activeBot };
  }
}
