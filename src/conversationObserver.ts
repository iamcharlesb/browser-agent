/** Deterministic conversation observer. It records explicit corrections as reviewable drafts. */
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { botIdFromName } from "./learningStore";
import { envInteger } from "./runtimeConfig";
import { redactSecrets } from "./security";

export type ObserverSuggestionKind = "voice" | "playbook";
export interface ObserverSuggestion {
  id: string; botId: string; botName: string; kind: ObserverSuggestionKind;
  instruction: string; evidence: string[]; status: "pending" | "approved" | "rejected";
  createdAt: string; reviewedAt?: string;
}
const CORRECTION = /\b(?:correction|i meant|i mean|you misunderstood|that's not what i asked|that is not what i asked|please (?:always|never|stop)|from now on|remember to|don't (?:repeat|do that)|do not (?:repeat|do that)|keep (?:the|your) (?:tone|voice|style)|use (?:a|the|my) (?:tone|voice|style))\b/i;
/** User signals the bot missed a concrete deliverable or ignored a simple ask. */
const DELIVERY_MISS = /\b(?:think again|try again|that(?:'| i)?s not (?:what|it)|my question is simple|just (?:create|make|build|do)|man just|i (?:said|asked|need) (?:a |one )?(?:landing|funnel|page)|need a (?:landing|funnel) page|thats all|that'?s all)\b/i;
const VOICE = /\b(?:tone|voice|style|format|wording|concise|friendly|formal|bullets|no dashes)\b/i;

export class ConversationObserver {
  private readonly file: string;
  private records: ObserverSuggestion[] = [];
  private ready: Promise<void>;
  constructor(private readonly directory: string) {
    this.file = join(directory, "suggestions.json");
    this.ready = this.load();
  }
  private async load(): Promise<void> {
    try {
      const value = JSON.parse(await readFile(this.file, "utf8"));
      if (Array.isArray(value)) this.records = value.filter(record => record && typeof record.id === "string" && typeof record.instruction === "string");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  private async save(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(this.records.slice(-500), null, 2), { mode: 0o600 });
    await rename(temp, this.file);
  }
  async observeTurn(input: { botName: string; userText: string; outcomeRef: string }): Promise<ObserverSuggestion | null> {
    await this.ready;
    const instruction = redactSecrets(input.userText).replace(/\s+/g, " ").trim().slice(0, 600);
    if (!instruction) return null;
    const isCorrection = CORRECTION.test(instruction);
    const isMiss = DELIVERY_MISS.test(instruction);
    if (!isCorrection && !isMiss) return null;
    const botName = input.botName.trim().slice(0, 120) || "default";
    const botId = botIdFromName(botName);
    const kind: ObserverSuggestionKind = isCorrection && VOICE.test(instruction) ? "voice" : "playbook";
    const normalized = isMiss && !isCorrection
      ? `Delivery miss: honor concrete asks immediately (landing/funnel pages, artifacts). User said: ${instruction}`
      : instruction;
    const existing = this.records.find(item => item.status === "pending" && item.botId === botId && item.instruction.toLowerCase() === normalized.toLowerCase());
    if (existing) {
      if (!existing.evidence.includes(input.outcomeRef)) existing.evidence.push(input.outcomeRef);
      await this.save();
      return existing;
    }
    const suggestion: ObserverSuggestion = {
      id: randomUUID(), botId, botName, kind, instruction: normalized,
      evidence: [redactSecrets(input.outcomeRef).slice(0, 180)], status: "pending", createdAt: new Date().toISOString()
    };
    this.records.push(suggestion);
    await this.save();
    return suggestion;
  }
  async pending(): Promise<ObserverSuggestion[]> {
    await this.ready;
    return this.records.filter(item => item.status === "pending").slice(-100).reverse();
  }
  async get(id: string): Promise<ObserverSuggestion | null> {
    await this.ready;
    return this.records.find(record => record.id === id) ?? null;
  }
  async decide(id: string, decision: "approve" | "reject"): Promise<ObserverSuggestion> {
    await this.ready;
    const item = this.records.find(record => record.id === id);
    if (!item) throw new Error("Observer suggestion not found.");
    if (item.status !== "pending") throw new Error("Observer suggestion has already been reviewed.");
    item.status = decision === "approve" ? "approved" : "rejected";
    item.reviewedAt = new Date().toISOString();
    await this.save();
    return item;
  }
}

/** Apply an owner-approved voice suggestion inside the configured profile root only. */
export async function applyApprovedVoice(profileRoot: string, suggestion: ObserverSuggestion): Promise<string> {
  const root = realpathSync(profileRoot);
  const agentsRootPath = resolve(root, "agents");
  await mkdir(agentsRootPath, { recursive: true, mode: 0o700 });
  const agentsRoot = realpathSync(agentsRootPath);
  const agentsRel = relative(root, agentsRoot);
  if (agentsRel === ".." || agentsRel.startsWith(`..${sep}`) || isAbsolute(agentsRel)) throw new Error("Agents directory must stay inside the configured profile root.");
  const directoryPath = resolve(agentsRoot, suggestion.botId);
  await mkdir(directoryPath, { recursive: true, mode: 0o700 });
  const botDirectory = realpathSync(directoryPath);
  if (botDirectory !== directoryPath) throw new Error("Bot profile directories cannot be symbolic links.");
  const withinAgents = relative(agentsRoot, botDirectory);
  if (!withinAgents || withinAgents === ".." || withinAgents.startsWith(`..${sep}`) || isAbsolute(withinAgents)) throw new Error("Bot voice directory must stay inside the configured agents directory.");
  const voicePath = resolve(botDirectory, "soul.md");
  if (existsSync(voicePath) && lstatSync(voicePath).isSymbolicLink()) throw new Error("Bot voice file cannot be a symbolic link.");
  const previous = existsSync(voicePath) ? await readFile(voicePath, "utf8") : "";
  const addition = `- ${suggestion.instruction}`;
  if (previous.split(/\r?\n/).some(line => line.trim().toLowerCase() === addition.toLowerCase())) return voicePath;
  const next = [previous.trim(), addition].filter(Boolean).join("\n") + "\n";
  const instructionsPath = resolve(botDirectory, "AGENTS.md");
  const sharedInstructionsPath = resolve(root, "AGENTS.md");
  if ((existsSync(sharedInstructionsPath) && lstatSync(sharedInstructionsPath).isSymbolicLink()) || (existsSync(instructionsPath) && lstatSync(instructionsPath).isSymbolicLink())) throw new Error("Instruction files cannot be symbolic links.");
  const sharedInstructions = existsSync(sharedInstructionsPath) ? await readFile(sharedInstructionsPath, "utf8") : "";
  const botInstructions = existsSync(instructionsPath) ? await readFile(instructionsPath, "utf8") : "";
  if (sharedInstructions.length + botInstructions.length + next.length > envInteger("BROWSER_AGENT_CORE_PROFILE_CHARS", 2400)) throw new Error("Approved voice would exceed the configured core profile budget. Shorten the existing voice file first.");
  const temp = `${voicePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, next, { mode: 0o600 });
  await rename(temp, voicePath);
  return voicePath;
}
