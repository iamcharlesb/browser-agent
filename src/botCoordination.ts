import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { redactSecretValues } from "./security";
import { envInteger } from "./runtimeConfig";

export interface WorkspaceBot { id: string; name: string; profileId?: string; botInstructions?: string; expertise?: string }
export function parseWorkspaceBots(value: unknown): WorkspaceBot[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 100) throw new Error("workspaceBots must contain at most 100 saved bots.");
  const ids = new Set<string>();
  return value.map(entry => {
    if (!entry || typeof entry.id !== "string" || !/^[A-Za-z0-9_-]{1,120}$/.test(entry.id) || ids.has(entry.id) ||
        typeof entry.name !== "string" || !entry.name.trim() || entry.name.length > 120) throw new Error("Each workspace bot needs a unique id and a name.");
    ids.add(entry.id);
    return { id: entry.id, name: entry.name.trim(),
      ...(typeof entry.profileId === "string" ? { profileId: entry.profileId.slice(0, 100) } : {}),
      ...(typeof entry.botInstructions === "string" ? { botInstructions: entry.botInstructions.slice(0, 12_000) } : {}),
      ...(typeof entry.expertise === "string" ? { expertise: entry.expertise.slice(0, 500) } : {}) };
  });
}
const key = (value: string) => value.trim().toLowerCase();
const alias = (value: string) => key(value).replace(/\b(?:bot|agent|specialist)\b/g, "").replace(/[^a-z0-9]+/g, " ").trim();
export function resolveWorkspaceBot(bots: WorkspaceBot[], target: string): WorkspaceBot {
  const exact = bots.filter(bot => bot.id === target || key(bot.name) === key(target));
  const matches = exact.length ? exact : bots.filter(bot => alias(bot.name) === alias(target));
  if (matches.length !== 1) throw new Error(matches.length ? `The bot name '${target}' is ambiguous; use its saved id.` : `No saved workspace bot matches '${target}'. Use a bot from the roster.`);
  return matches[0];
}
export function currentUserRequest(task: string): string {
  const marker = "User request:", index = task.lastIndexOf(marker);
  return (index < 0 ? task : task.slice(index + marker.length)).trim();
}
/** Only an explicit current request selects peers; reading status never starts another bot. */
export function requestedCoordination(task: string, bots: WorkspaceBot[] | undefined, owner: string): WorkspaceBot[] {
  if (!bots) return [];
  const text = currentUserRequest(task);
  if (/^(?:did|have|has|were|was|are|is|what|who|when|how)\b/i.test(text) || /\b(?:don't|do not|never|stop)\s+(?:delegate|consult|ask|coordinate|talk|check)/i.test(text)) return [];
  const peers = bots.filter(bot => key(bot.name) !== key(owner));
  if (/\b(?:coordinate|consult|check|speak|talk|discuss|ask)\b[\s\S]{0,60}\b(?:all|every|each|the team)\b/i.test(text)) return peers;
  const named = /\b(?:check\s+(?:with|wth)|ask|consult|talk\s+(?:to|with)|speak\s+(?:to|with)|coordinate\s+with)\s+(.+)/i.exec(text);
  if (!named) return [];
  const target = alias(named[1]);
  return peers.filter(bot => {
    const name = alias(bot.name); return name && (target === name || target.startsWith(name + " ") || target.includes(" and " + name) || target.includes(" " + name + " "));
  });
}
export interface CoordinationRecord {
  id: string; discussionId: string; fromBot: string; toBot: string; targetBotId?: string;
  status: "queued" | "running" | "completed" | "failed" | "interrupted";
  summary?: string; outcomeRef?: string; updatedAt: string;
  generation?: number;
}
/** Durable receipts, never executable jobs. Restart marks unfinished contact as interrupted. */
export class CoordinationJournal {
  private records: CoordinationRecord[] = [];
  private readonly limit = envInteger("BROWSER_AGENT_COORDINATION_RECORDS", 500, 20, 10000);
  constructor(private readonly file: string) {
    try {
      const records = JSON.parse(readFileSync(file, "utf8"));
      if (!Array.isArray(records)) throw new Error("Invalid coordination journal.");
      this.records = records.slice(-this.limit).map(record => ["queued", "running"].includes(record.status) ? { ...record, status: "interrupted" } : record);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  record(input: Omit<CoordinationRecord, "updatedAt">): void {
    const previous = this.records.find(record => record.id === input.id);
    const next = redactSecretValues({ ...previous, ...input, generation: input.generation ?? previous?.generation ?? 0,
      summary: input.summary?.slice(0, envInteger("BROWSER_AGENT_COORDINATION_SUMMARY_CHARS", 1400)), updatedAt: new Date().toISOString() });
    const records = this.records.filter(record => record.id !== input.id).concat(next).slice(-this.limit);
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileSync(this.file + ".tmp", JSON.stringify(records), { mode: 0o600 });
    renameSync(this.file + ".tmp", this.file); this.records = records;
  }
  list(owner: string): CoordinationRecord[] { return this.records.filter(record => key(record.fromBot) === key(owner)).slice(-envInteger("BROWSER_AGENT_COORDINATION_CONTEXT_RECORDS", 12, 1, this.limit)).map(record => ({ ...record })); }
}
