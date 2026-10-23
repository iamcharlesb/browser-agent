/** Per-bot durable learning KB: intents, mistakes, learnings, hypotheses. Local JSON only. */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { redactSecrets } from "./security";

export const BOT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
export const MAX_ENTRY_CHARS = 160;
export const MAX_INTENTS = 8;
export const MAX_MISTAKES = 8;
export const MAX_LEARNINGS = 10;
export const MAX_HYPOTHESES = 4;
/** Hard cap for CONTEXT injection (token-lean). */
export const MAX_DISTILL_CHARS = 1000;

export type LearningKind = "intent" | "mistake" | "learning" | "hypothesis";
export type LearningSource = "auto" | "tool" | "user_correction";

export interface LearningEntry {
  id: string;
  kind: LearningKind;
  text: string;
  source: LearningSource;
  createdAt: string;
}

export interface LearningKbState {
  version: 1;
  botId: string;
  niche: string;
  intents: LearningEntry[];
  mistakes: LearningEntry[];
  learnings: LearningEntry[];
  hypotheses: LearningEntry[];
  updatedAt: string;
}

const LEARNING_KINDS: readonly LearningKind[] = ["intent", "mistake", "learning", "hypothesis"];
const LEARNING_SOURCES: readonly LearningSource[] = ["auto", "tool", "user_correction"];

const KIND_CAPS: Record<LearningKind, number> = {
  intent: MAX_INTENTS,
  mistake: MAX_MISTAKES,
  learning: MAX_LEARNINGS,
  hypothesis: MAX_HYPOTHESES
};

function assertObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function assertString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string.`);
  }
  return value;
}

/** Path-safe bot id from free-form bot display names. */
export function botIdFromName(name: string): string {
  const raw = assertString(name, "botName").trim();
  const slug = raw
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
  if (!slug || !BOT_ID_PATTERN.test(slug)) {
    return "default";
  }
  return slug;
}

/** Sanitize and redact a KB note. Empty after sanitize → "". */
export function sanitizeLearningText(raw: string, maxChars = MAX_ENTRY_CHARS): string {
  const redacted = redactSecrets(String(raw ?? ""))
    .replace(/\s+/g, " ")
    .trim();
  if (!redacted) return "";
  return redacted.length > maxChars ? `${redacted.slice(0, maxChars - 1)}…` : redacted;
}

function nowIso(now?: Date): string {
  return (now ?? new Date()).toISOString();
}

export function defaultLearningKb(botId: string, now?: Date): LearningKbState {
  const id = assertString(botId, "botId").trim();
  if (!BOT_ID_PATTERN.test(id)) {
    throw new Error("botId must match [A-Za-z0-9_-].");
  }
  return {
    version: 1,
    botId: id,
    niche: "",
    intents: [],
    mistakes: [],
    learnings: [],
    hypotheses: [],
    updatedAt: nowIso(now)
  };
}

function validateEntry(value: unknown, label: string): LearningEntry {
  const obj = assertObject(value, label);
  const id = assertString(obj.id, `${label}.id`).trim();
  if (!id) throw new Error(`${label}.id must be non-empty.`);
  const kind = assertString(obj.kind, `${label}.kind`) as LearningKind;
  if (!LEARNING_KINDS.includes(kind)) {
    throw new Error(`${label}.kind must be one of: ${LEARNING_KINDS.join(", ")}.`);
  }
  const text = sanitizeLearningText(assertString(obj.text, `${label}.text`));
  if (!text) throw new Error(`${label}.text must be non-empty after sanitization.`);
  const source = assertString(obj.source ?? "auto", `${label}.source`) as LearningSource;
  if (!LEARNING_SOURCES.includes(source)) {
    throw new Error(`${label}.source must be one of: ${LEARNING_SOURCES.join(", ")}.`);
  }
  const createdAt = assertString(obj.createdAt, `${label}.createdAt`);
  return { id, kind, text, source, createdAt };
}

function validateEntryList(
  value: unknown,
  label: string,
  kind: LearningKind,
  cap: number
): LearningEntry[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  const out: LearningEntry[] = [];
  for (let i = 0; i < value.length; i++) {
    const entry = validateEntry(value[i], `${label}[${i}]`);
    if (entry.kind !== kind) {
      throw new Error(`${label}[${i}].kind must be "${kind}".`);
    }
    out.push(entry);
  }
  return out.slice(-cap);
}

export function validateLearningKb(value: unknown, expectedBotId?: string): LearningKbState {
  const obj = assertObject(value, "LearningKb");
  if (obj.version !== 1) {
    throw new Error("LearningKb.version must be 1.");
  }
  const botId = assertString(obj.botId, "LearningKb.botId").trim();
  if (!BOT_ID_PATTERN.test(botId)) {
    throw new Error("LearningKb.botId must match [A-Za-z0-9_-].");
  }
  if (expectedBotId !== undefined && botId !== expectedBotId) {
    throw new Error(`LearningKb.botId "${botId}" does not match requested botId "${expectedBotId}".`);
  }
  const niche = sanitizeLearningText(assertString(obj.niche ?? "", "LearningKb.niche"), 80);
  const updatedAt = assertString(obj.updatedAt ?? nowIso(), "LearningKb.updatedAt");
  return {
    version: 1,
    botId,
    niche,
    intents: validateEntryList(obj.intents, "LearningKb.intents", "intent", MAX_INTENTS),
    mistakes: validateEntryList(obj.mistakes, "LearningKb.mistakes", "mistake", MAX_MISTAKES),
    learnings: validateEntryList(obj.learnings, "LearningKb.learnings", "learning", MAX_LEARNINGS),
    hypotheses: validateEntryList(obj.hypotheses, "LearningKb.hypotheses", "hypothesis", MAX_HYPOTHESES),
    updatedAt
  };
}

/**
 * Safe path for a bot's learning JSON under baseDir.
 * Rejects bot ids that could escape the directory.
 */
export function learningFilePath(baseDir: string, botId: string): string {
  const id = assertString(botId, "botId").trim();
  if (!BOT_ID_PATTERN.test(id)) {
    throw new Error("botId must match [A-Za-z0-9_-] (path escape rejected).");
  }
  const root = resolve(baseDir);
  const resolved = resolve(join(root, `${id}.json`));
  const rel = relative(root, resolved);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Learning path for botId "${id}" escapes baseDir.`);
  }
  return resolved;
}

/** Load per-bot learning KB. Missing file → defaults (does not create the file). */
export async function loadLearningKb(baseDir: string, botId: string): Promise<LearningKbState> {
  const filePath = learningFilePath(baseDir, botId);
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? (err as { code: unknown }).code : undefined;
    if (code === "ENOENT") {
      return defaultLearningKb(botId);
    }
    throw new Error(`${filePath}: failed to read (${err instanceof Error ? err.message : String(err)}).`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${filePath}: corrupt JSON (${err instanceof Error ? err.message : String(err)}).`);
  }
  try {
    return validateLearningKb(parsed, botId);
  } catch (err) {
    throw new Error(`${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Validate then atomically write learning KB (temp file + rename). */
export async function saveLearningKb(baseDir: string, state: LearningKbState): Promise<void> {
  const botId = state.botId;
  if (typeof botId !== "string" || !botId.trim()) {
    throw new Error("LearningKb.botId is required before save.");
  }
  const filePath = learningFilePath(baseDir, botId);
  const validated = validateLearningKb(state, botId);
  await mkdir(baseDir, { recursive: true });
  const tempPath = join(dirname(filePath), `.${botId}.${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
    await rename(tempPath, filePath);
  } catch (err) {
    try {
      await unlink(tempPath);
    } catch {
      /* temp may not exist */
    }
    throw new Error(`${filePath}: failed to save (${err instanceof Error ? err.message : String(err)}).`);
  }
}

/**
 * One in-flight read-modify-write per bot file, chained by path.
 *
 * The write itself is atomic (temp + rename), but a load/save pair is not: two callers that both
 * loaded before either saved would each write their own view and the first one's entry would
 * vanish. The server fires several of these per run (an approval denial and a run outcome can land
 * microseconds apart), so the pair has to be serialized, not just the write.
 */
const learningWriteChains = new Map<string, Promise<unknown>>();

export async function updateLearningKb(
  baseDir: string,
  botId: string,
  mutate: (state: LearningKbState) => LearningKbState | Promise<LearningKbState>
): Promise<LearningKbState> {
  const filePath = learningFilePath(baseDir, botId);
  const previous = learningWriteChains.get(filePath) ?? Promise.resolve();
  const next = previous.then(
    async () => {
      const current = await loadLearningKb(baseDir, botId);
      const mutated = await mutate(current);
      await saveLearningKb(baseDir, mutated);
      return mutated;
    },
    async () => {
      // A failed predecessor must not poison the queue; start this update from fresh state.
      const current = await loadLearningKb(baseDir, botId);
      const mutated = await mutate(current);
      await saveLearningKb(baseDir, mutated);
      return mutated;
    }
  );
  learningWriteChains.set(filePath, next);
  try {
    return await next;
  } finally {
    if (learningWriteChains.get(filePath) === next) learningWriteChains.delete(filePath);
  }
}

function listForKind(state: LearningKbState, kind: LearningKind): LearningEntry[] {
  switch (kind) {
    case "intent":
      return state.intents;
    case "mistake":
      return state.mistakes;
    case "learning":
      return state.learnings;
    case "hypothesis":
      return state.hypotheses;
  }
}

function withKindList(state: LearningKbState, kind: LearningKind, list: LearningEntry[]): LearningKbState {
  switch (kind) {
    case "intent":
      return { ...state, intents: list };
    case "mistake":
      return { ...state, mistakes: list };
    case "learning":
      return { ...state, learnings: list };
    case "hypothesis":
      return { ...state, hypotheses: list };
  }
}

/** Append a note; dedupes near-identical recent text; caps list size. */
export function appendLearning(
  state: LearningKbState,
  input: { kind: LearningKind; text: string; source?: LearningSource },
  now?: Date
): LearningKbState {
  const kind = assertString(input.kind, "kind") as LearningKind;
  if (!LEARNING_KINDS.includes(kind)) {
    throw new Error(`kind must be one of: ${LEARNING_KINDS.join(", ")}.`);
  }
  const text = sanitizeLearningText(input.text);
  if (!text) {
    return state;
  }
  const source = (input.source ?? "auto") as LearningSource;
  if (!LEARNING_SOURCES.includes(source)) {
    throw new Error(`source must be one of: ${LEARNING_SOURCES.join(", ")}.`);
  }
  const existing = listForKind(state, kind);
  const normalized = text.toLowerCase();
  if (existing.some((e) => e.text.toLowerCase() === normalized)) {
    return state;
  }
  const entry: LearningEntry = {
    id: randomUUID(),
    kind,
    text,
    source,
    createdAt: nowIso(now)
  };
  const next = [...existing, entry].slice(-KIND_CAPS[kind]);
  return { ...withKindList(state, kind, next), updatedAt: nowIso(now) };
}

export function setNiche(state: LearningKbState, niche: string, now?: Date): LearningKbState {
  const cleaned = sanitizeLearningText(niche, 80);
  if (!cleaned || cleaned === state.niche) return state;
  return { ...state, niche: cleaned, updatedAt: nowIso(now) };
}

/** Compact CONTEXT block (≤ MAX_DISTILL_CHARS). Empty KB → "". */
export function distillLearningKb(state: LearningKbState, maxChars = MAX_DISTILL_CHARS): string {
  const lines: string[] = ["LEARNINGS / KB (local, distilled — use & update; do not dump full history):"];
  if (state.niche) lines.push(`Niche: ${state.niche}`);

  const pushSection = (label: string, entries: LearningEntry[], take: number) => {
    if (!entries.length) return;
    const recent = entries.slice(-take);
    lines.push(`${label}:`);
    for (const e of recent) {
      lines.push(`- ${e.text}`);
    }
  };

  pushSection("Intents/goals", state.intents, 4);
  pushSection("Mistakes/corrections (avoid repeating)", state.mistakes, 4);
  pushSection("What worked", state.learnings, 5);
  pushSection("Check next", state.hypotheses, 2);

  if (lines.length <= 1) return "";

  let out = lines.join("\n");
  if (out.length <= maxChars) return out;

  // Prefer keeping mistakes + niche when trimming.
  const trimmed: string[] = [lines[0]];
  if (state.niche) trimmed.push(`Niche: ${state.niche}`);
  pushOnto(trimmed, "Mistakes/corrections (avoid repeating)", state.mistakes, 3);
  pushOnto(trimmed, "Intents/goals", state.intents, 2);
  pushOnto(trimmed, "What worked", state.learnings, 3);
  pushOnto(trimmed, "Check next", state.hypotheses, 1);
  out = trimmed.join("\n");
  if (out.length > maxChars) {
    out = `${out.slice(0, maxChars - 1)}…`;
  }
  return out;

  function pushOnto(target: string[], label: string, entries: LearningEntry[], take: number): void {
    if (!entries.length) return;
    target.push(`${label}:`);
    for (const e of entries.slice(-take)) {
      target.push(`- ${e.text}`);
    }
  }
}

const CORRECTION_PATTERN =
  /\b(don'?t|do not|stop|wrong|instead|never\b|not that|i (?:said|meant|told you|want)|correct(?:ion)?|mistake|avoid|no more)\b/i;
const NICHE_PATTERN =
  /\b(?:niche|audience|target\s+(?:market|audience)|vertical|in\s+the\s+([a-z0-9 &\-]{3,40})\s+(?:space|niche|market))\b/i;
const GOAL_PATTERN =
  /\b(?:grow|increase|rank|seo|reddit|instagram|followers?|engagement|keyword|funnel|ga4|gtm)\b/i;

/** Light auto-extract from a finished run (summarized, not full transcript). */
export function applyRunOutcome(
  state: LearningKbState,
  input: {
    task: string;
    success: boolean;
    summary: string;
    terminationReason?: string;
  },
  now?: Date
): LearningKbState {
  let next = state;
  const task = sanitizeLearningText(input.task, 200);
  const summary = sanitizeLearningText(input.summary, 200);
  if (!task && !summary) return state;

  if (task && CORRECTION_PATTERN.test(task)) {
    next = appendLearning(
      next,
      { kind: "mistake", text: `User correction: ${task}`, source: "user_correction" },
      now
    );
  }

  if (task && GOAL_PATTERN.test(task)) {
    next = appendLearning(next, { kind: "intent", text: task.slice(0, MAX_ENTRY_CHARS), source: "auto" }, now);
  }

  const nicheMatch = NICHE_PATTERN.exec(`${task} ${summary}`);
  if (nicheMatch?.[1]) {
    const inferred = sanitizeLearningText(nicheMatch[1], 80);
    if (inferred && inferred.length > 2) {
      next = setNiche(next, inferred, now);
    }
  }

  if (input.success && summary) {
    next = appendLearning(
      next,
      { kind: "learning", text: `Worked: ${summary}`, source: "auto" },
      now
    );
  } else if (!input.success && summary) {
    const reason = input.terminationReason ? ` (${input.terminationReason})` : "";
    next = appendLearning(
      next,
      { kind: "mistake", text: `Failed${reason}: ${summary}`, source: "auto" },
      now
    );
  }

  return next;
}

/** Record a denied privileged action as a mistake. */
export function applyApprovalDenial(
  state: LearningKbState,
  description: string,
  now?: Date
): LearningKbState {
  const text = sanitizeLearningText(description, MAX_ENTRY_CHARS);
  if (!text) return state;
  return appendLearning(
    state,
    { kind: "mistake", text: `User denied approval: ${text}`, source: "user_correction" },
    now
  );
}

export interface LearningKbToolInput {
  action: "read" | "list" | "save";
  kind?: LearningKind;
  text?: string;
}

/** Dispatch for the learning_kb agent tool. Mutates via returned state. */
export function applyLearningKbTool(
  state: LearningKbState,
  input: LearningKbToolInput,
  now?: Date
): { state: LearningKbState; message: string } {
  const action = String(input.action ?? "read");
  if (action === "read" || action === "list") {
    const distilled = distillLearningKb(state);
    const counts = `intents=${state.intents.length} mistakes=${state.mistakes.length} learnings=${state.learnings.length} hypotheses=${state.hypotheses.length}`;
    if (!distilled) {
      return { state, message: `Learning KB empty for bot "${state.botId}" (${counts}).` };
    }
    return { state, message: `${counts}\n${distilled}` };
  }
  if (action === "save") {
    const kind = (input.kind ?? "learning") as LearningKind;
    if (!LEARNING_KINDS.includes(kind)) {
      return { state, message: `Invalid kind; use one of: ${LEARNING_KINDS.join(", ")}.` };
    }
    const text = sanitizeLearningText(String(input.text ?? ""));
    if (!text) {
      return { state, message: "save requires non-empty text (secrets are redacted)." };
    }
    let next = appendLearning(state, { kind, text, source: "tool" }, now);
    if (kind === "intent" && /niche|audience|market/i.test(text) && !next.niche) {
      next = setNiche(next, text, now);
    }
    return {
      state: next,
      message: `Saved ${kind}: "${text}" (local KB updated).`
    };
  }
  return { state, message: `Unsupported learning_kb action: ${action}` };
}
