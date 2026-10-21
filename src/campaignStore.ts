/** Per-bot campaign types, schema helpers, load/save, and queue ops. */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const DEFAULT_DAILY_BUDGET = 6;

export type EngagementStatus = "proposed" | "approved" | "denied" | "done" | "failed";

export type EngagementAction = "like" | "follow" | "comment";

export interface Campaign {
  botId: string;
  niche: string;
  engaged: string[];
  skip: string[];
  dailyBudget: number;
  /** Local calendar day (YYYY-MM-DD) that usedToday applies to. */
  budgetDay: string;
  usedToday: number;
}

export interface EngagementItem {
  id: string;
  handle: string;
  action: EngagementAction;
  draftComment?: string;
  status: EngagementStatus;
  createdAt: string;
  updatedAt: string;
  reason?: string;
  error?: string;
}

const BOT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const BUDGET_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ENGAGEMENT_STATUSES: readonly EngagementStatus[] = [
  "proposed",
  "approved",
  "denied",
  "done",
  "failed"
];
const ENGAGEMENT_ACTIONS: readonly EngagementAction[] = ["like", "follow", "comment"];

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

function assertNonNegativeNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative finite number.`);
  }
  return value;
}

/** Trim, strip a leading @, and lowercase an Instagram handle. */
export function normalizeHandle(raw: string): string {
  const trimmed = raw.trim();
  const withoutAt = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
  return withoutAt.toLowerCase();
}

function normalizeHandleList(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array of handles.`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== "string") {
      throw new Error(`${label}[${index}] must be a string handle.`);
    }
    const normalized = normalizeHandle(entry);
    if (!normalized) {
      throw new Error(`${label}[${index}] must be a non-empty handle.`);
    }
    return normalized;
  });
}

export function defaultCampaign(botId: string): Campaign {
  const id = assertString(botId, "botId").trim();
  if (!BOT_ID_PATTERN.test(id)) {
    throw new Error('botId must match [A-Za-z0-9_-].');
  }
  return {
    botId: id,
    niche: "",
    engaged: [],
    skip: [],
    dailyBudget: DEFAULT_DAILY_BUDGET,
    budgetDay: "",
    usedToday: 0
  };
}

export function validateCampaign(value: unknown): Campaign {
  const obj = assertObject(value, "Campaign");
  const botId = assertString(obj.botId, "Campaign.botId").trim();
  if (!BOT_ID_PATTERN.test(botId)) {
    throw new Error('Campaign.botId must match [A-Za-z0-9_-].');
  }
  const niche = assertString(obj.niche ?? "", "Campaign.niche");
  const engaged = normalizeHandleList(obj.engaged ?? [], "Campaign.engaged");
  const skip = normalizeHandleList(obj.skip ?? [], "Campaign.skip");
  const dailyBudget =
    obj.dailyBudget === undefined ? DEFAULT_DAILY_BUDGET : assertNonNegativeNumber(obj.dailyBudget, "Campaign.dailyBudget");
  const budgetDay = assertString(obj.budgetDay ?? "", "Campaign.budgetDay");
  if (budgetDay !== "" && !BUDGET_DAY_PATTERN.test(budgetDay)) {
    throw new Error("Campaign.budgetDay must be YYYY-MM-DD or empty.");
  }
  const usedToday =
    obj.usedToday === undefined ? 0 : assertNonNegativeNumber(obj.usedToday, "Campaign.usedToday");
  return { botId, niche, engaged, skip, dailyBudget, budgetDay, usedToday };
}

export function validateEngagementItem(value: unknown): EngagementItem {
  const obj = assertObject(value, "EngagementItem");
  const id = assertString(obj.id, "EngagementItem.id").trim();
  if (!id) {
    throw new Error("EngagementItem.id must be a non-empty string.");
  }
  const handle = normalizeHandle(assertString(obj.handle, "EngagementItem.handle"));
  if (!handle) {
    throw new Error("EngagementItem.handle must be a non-empty handle.");
  }
  const action = assertString(obj.action, "EngagementItem.action") as EngagementAction;
  if (!ENGAGEMENT_ACTIONS.includes(action)) {
    throw new Error(`EngagementItem.action must be one of: ${ENGAGEMENT_ACTIONS.join(", ")}.`);
  }
  const status = assertString(obj.status, "EngagementItem.status") as EngagementStatus;
  if (!ENGAGEMENT_STATUSES.includes(status)) {
    throw new Error(`EngagementItem.status must be one of: ${ENGAGEMENT_STATUSES.join(", ")}.`);
  }
  const createdAt = assertString(obj.createdAt, "EngagementItem.createdAt");
  const updatedAt = assertString(obj.updatedAt, "EngagementItem.updatedAt");
  const item: EngagementItem = { id, handle, action, status, createdAt, updatedAt };
  if (obj.draftComment !== undefined) {
    item.draftComment = assertString(obj.draftComment, "EngagementItem.draftComment");
  }
  if (obj.reason !== undefined) {
    item.reason = assertString(obj.reason, "EngagementItem.reason");
  }
  if (obj.error !== undefined) {
    item.error = assertString(obj.error, "EngagementItem.error");
  }
  return item;
}

/**
 * Safe path for a bot's campaign JSON under baseDir.
 * Rejects bot ids that could escape the directory.
 */
export function campaignFilePath(baseDir: string, botId: string): string {
  const id = assertString(botId, "botId").trim();
  if (!BOT_ID_PATTERN.test(id)) {
    throw new Error('botId must match [A-Za-z0-9_-] (path escape rejected).');
  }
  const root = resolve(baseDir);
  const resolved = resolve(join(root, `${id}.json`));
  const rel = relative(root, resolved);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Campaign path for botId "${id}" escapes baseDir.`);
  }
  return resolved;
}

export interface CampaignState {
  version: 1;
  campaign: Campaign;
  queue: EngagementItem[];
}

export function defaultCampaignState(botId: string): CampaignState {
  return { version: 1, campaign: defaultCampaign(botId), queue: [] };
}

function validateCampaignState(value: unknown, expectedBotId: string, filePath: string): CampaignState {
  let obj: Record<string, unknown>;
  try {
    obj = assertObject(value, "CampaignState");
  } catch (err) {
    throw new Error(`${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (obj.version !== 1) {
    throw new Error(`${filePath}: version must be 1.`);
  }
  let campaign: Campaign;
  try {
    campaign = validateCampaign(obj.campaign);
  } catch (err) {
    throw new Error(`${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (campaign.botId !== expectedBotId) {
    throw new Error(
      `${filePath}: campaign.botId "${campaign.botId}" does not match requested botId "${expectedBotId}".`
    );
  }
  if (!Array.isArray(obj.queue)) {
    throw new Error(`${filePath}: queue must be an array.`);
  }
  const queue: EngagementItem[] = [];
  for (let i = 0; i < obj.queue.length; i++) {
    try {
      queue.push(validateEngagementItem(obj.queue[i]));
    } catch (err) {
      throw new Error(
        `${filePath}: queue[${i}]: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  return { version: 1, campaign, queue };
}

/** Load per-bot campaign state. Missing file → defaults (does not create the file). */
export async function loadCampaignState(baseDir: string, botId: string): Promise<CampaignState> {
  const filePath = campaignFilePath(baseDir, botId);
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? (err as { code: unknown }).code : undefined;
    if (code === "ENOENT") {
      return defaultCampaignState(botId);
    }
    throw new Error(
      `${filePath}: failed to read (${err instanceof Error ? err.message : String(err)}).`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `${filePath}: corrupt JSON (${err instanceof Error ? err.message : String(err)}).`
    );
  }
  return validateCampaignState(parsed, botId, filePath);
}

/** Validate then atomically write campaign state (temp file + rename). */
export async function saveCampaignState(baseDir: string, state: CampaignState): Promise<void> {
  const botId = state.campaign?.botId;
  if (typeof botId !== "string" || !botId.trim()) {
    throw new Error("CampaignState.campaign.botId is required before save.");
  }
  const filePath = campaignFilePath(baseDir, botId);
  const validated = validateCampaignState(state, botId, filePath);
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
    throw new Error(
      `${filePath}: failed to save (${err instanceof Error ? err.message : String(err)}).`
    );
  }
}

const ALLOWED_TRANSITIONS: ReadonlyMap<EngagementStatus, ReadonlySet<EngagementStatus>> = new Map([
  ["proposed", new Set(["approved", "denied"])],
  ["approved", new Set(["denied", "done", "failed"])],
  ["denied", new Set()],
  ["done", new Set()],
  ["failed", new Set()]
]);

export function canTransition(from: EngagementStatus, to: EngagementStatus): boolean {
  return ALLOWED_TRANSITIONS.get(from)?.has(to) ?? false;
}

function nowIso(now?: Date): string {
  return (now ?? new Date()).toISOString();
}

function findItemIndex(state: CampaignState, id: string): number {
  const index = state.queue.findIndex((item) => item.id === id);
  if (index < 0) {
    throw new Error(`Unknown engagement id "${id}".`);
  }
  return index;
}

function transitionItem(
  state: CampaignState,
  id: string,
  to: EngagementStatus,
  patch: Partial<Pick<EngagementItem, "reason" | "error" | "draftComment">>,
  now?: Date
): CampaignState {
  const index = findItemIndex(state, id);
  const item = state.queue[index];
  const from = item.status;
  if (!canTransition(from, to)) {
    throw new Error(
      `Illegal transition for id "${id}": ${from} -> ${to}.`
    );
  }
  const updated: EngagementItem = {
    ...item,
    ...patch,
    status: to,
    updatedAt: nowIso(now)
  };
  const queue = state.queue.slice();
  queue[index] = updated;
  return { ...state, queue };
}

export function proposeEngagement(
  state: CampaignState,
  input: { handle: string; action: EngagementAction; draftComment?: string; reason?: string },
  now?: Date
): CampaignState {
  const handle = normalizeHandle(assertString(input.handle, "handle"));
  if (!handle) {
    throw new Error("handle must be a non-empty handle.");
  }
  const action = assertString(input.action, "action") as EngagementAction;
  if (!ENGAGEMENT_ACTIONS.includes(action)) {
    throw new Error(`action must be one of: ${ENGAGEMENT_ACTIONS.join(", ")}.`);
  }
  const ts = nowIso(now);
  const item: EngagementItem = {
    id: randomUUID(),
    handle,
    action,
    status: "proposed",
    createdAt: ts,
    updatedAt: ts
  };
  if (input.draftComment !== undefined) {
    item.draftComment = assertString(input.draftComment, "draftComment");
  }
  if (input.reason !== undefined) {
    item.reason = assertString(input.reason, "reason");
  }
  return { ...state, queue: [...state.queue, item] };
}

export function approveEngagement(state: CampaignState, id: string, now?: Date): CampaignState {
  return transitionItem(state, id, "approved", {}, now);
}

export function denyEngagement(
  state: CampaignState,
  id: string,
  reason?: string,
  now?: Date
): CampaignState {
  const patch: Partial<Pick<EngagementItem, "reason">> = {};
  if (reason !== undefined) {
    patch.reason = assertString(reason, "reason");
  }
  return transitionItem(state, id, "denied", patch, now);
}

export function editDraft(
  state: CampaignState,
  id: string,
  draftComment: string,
  now?: Date
): CampaignState {
  const index = findItemIndex(state, id);
  const item = state.queue[index];
  if (item.status !== "proposed") {
    throw new Error(
      `Illegal transition for id "${id}": ${item.status} -> editDraft (only proposed allows editDraft).`
    );
  }
  const updated: EngagementItem = {
    ...item,
    draftComment: assertString(draftComment, "draftComment"),
    updatedAt: nowIso(now)
  };
  const queue = state.queue.slice();
  queue[index] = updated;
  return { ...state, queue };
}

export function markDone(state: CampaignState, id: string, now?: Date): CampaignState {
  return transitionItem(state, id, "done", {}, now);
}

export function markFailed(
  state: CampaignState,
  id: string,
  error: string,
  now?: Date
): CampaignState {
  return transitionItem(state, id, "failed", { error: assertString(error, "error") }, now);
}
