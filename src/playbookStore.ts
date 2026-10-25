import { watch, type FSWatcher } from "node:fs";
/** Reviewed playbook state is durable; notifications never execute a model or tool. */
import { randomUUID, createHash } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Db, ChangeStream } from "mongodb";
import { BOT_ID_PATTERN } from "./learningStore";
import { envInteger } from "./runtimeConfig";
import { redactSecrets } from "./security";
import { sharedMongoDatabase } from "./userStore";

export interface PlaybookProposal {
  kind: "proposal"; workspaceId: string; botId: string; id: string; text: string;
  evidenceRef: string; status: "pending" | "approved" | "rejected"; createdAt: string;
  reviewedBy?: string; reviewedAt?: string;
}
export interface ApprovedPlaybook {
  kind: "approved"; workspaceId: string; botId: string; revision: number;
  lessons: Array<{ proposalId: string; text: string; evidenceRef: string }>;
  updatedAt: string;
}
export interface PlaybookUpdated {
  id: string; topic: "playbook.updated"; botId: string; revision: number; ref: string;
}
export class RevisionConflict extends Error {}
const chains = new Map<string, Promise<unknown>>();

export class PlaybookStore {
  private readonly listeners = new Set<(event: PlaybookUpdated) => Promise<void> | void>();
  private stream: ChangeStream | null = null;
  private localWatcher: FSWatcher | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private watchStarting: Promise<void> | null = null;
  private indexed: Db | null = null;
  private readonly notificationChains = new Map<string, Promise<void>>();
  readonly workspaceId: string;

  constructor(private readonly directory: string, private readonly database: () => Promise<Db | null> = sharedMongoDatabase,
    workspaceId = process.env.BROWSER_AGENT_WORKSPACE_ID?.trim() || "local") {
    this.workspaceId = workspaceId;
  }

  private validateBot(botId: string): void {
    if (!BOT_ID_PATTERN.test(botId) || botId.length > 128) throw new Error("Invalid bot id.");
  }
  private path(key: string): string {
    return join(this.directory, createHash("sha256").update(`${this.workspaceId}:${key}`).digest("hex") + ".json");
  }
  private async read<T>(key: string): Promise<T | null> {
    try { return JSON.parse(await readFile(this.path(key), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }
  private async write(key: string, record: unknown): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const target = this.path(key), temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
    await rename(temporary, target);
  }
  private serialize<T>(botId: string, operation: () => Promise<T>): Promise<T> {
    const key = `${this.directory}:${this.workspaceId}:${botId}`;
    const next = (chains.get(key) || Promise.resolve()).catch(() => undefined).then(operation);
    chains.set(key, next);
    void next.finally(() => { if (chains.get(key) === next) chains.delete(key); }).catch(() => undefined);
    return next;
  }
  private async collection() {
    // Explicit shared workspace identity prevents silently merging installations.
    if (this.workspaceId === "local") return null;
    const db = await this.database();
    if (!db) return null;
    const collection = db.collection("agent_playbooks");
    if (this.indexed !== db) {
      await collection.createIndex({ workspaceId: 1, kind: 1, botId: 1, id: 1 }, { unique: true });
      this.indexed = db;
    }
    return collection;
  }

  async propose(botId: string, text: string, evidenceRef: string): Promise<PlaybookProposal> {
    this.validateBot(botId);
    text = redactSecrets(text).replace(/\s+/g, " ").trim();
    evidenceRef = redactSecrets(evidenceRef).trim().slice(0, 240);
    if (!text || text.length > 600 || !evidenceRef) throw new Error("A playbook proposal needs <=600 characters and an evidence reference.");
    const proposal: PlaybookProposal = { kind: "proposal", workspaceId: this.workspaceId, botId,
      id: randomUUID(), text, evidenceRef, status: "pending", createdAt: new Date().toISOString() };
    await this.write(`proposal:${proposal.id}`, proposal);
    const collection = await this.collection();
    if (collection) await collection.updateOne({ workspaceId: this.workspaceId, kind: "proposal", botId, id: proposal.id }, { $setOnInsert: proposal }, { upsert: true });
    return proposal;
  }

  async approved(botId: string): Promise<ApprovedPlaybook> {
    this.validateBot(botId);
    const collection = await this.collection();
    if (collection) {
      const record = await collection.findOne({ workspaceId: this.workspaceId, kind: "approved", botId });
      if (record) { await this.write(`approved:${botId}`, record); return record as unknown as ApprovedPlaybook; }
    }
    return await this.read<ApprovedPlaybook>(`approved:${botId}`) || {
      kind: "approved", workspaceId: this.workspaceId, botId, revision: 0, lessons: [], updatedAt: ""
    };
  }

  async review(input: { botId: string; proposalId: string; decision: "approve" | "reject"; reviewer: string; expectedRevision: number }): Promise<ApprovedPlaybook> {
    this.validateBot(input.botId);
    if (!/^[a-f0-9-]{36}$/.test(input.proposalId) || !input.reviewer.trim() || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || !["approve", "reject"].includes(input.decision)) throw new Error("Invalid review arguments.");
    return this.serialize(input.botId, async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const lockPath = this.path(`review-lock:${input.botId}`);
      let lock;
      try { lock = await open(lockPath, "wx", 0o600); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new RevisionConflict("Another review holds the bot lock. Retry after it finishes; an abandoned lock requires owner recovery.");
        throw error;
      }
      try {
      await lock.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      const collection = await this.collection();
      // Never fork an approved shared revision while the shared authority is down.
      if (this.workspaceId !== "local" && !collection) throw new Error("Shared playbook storage is unavailable; review remains pending.");
      const filter = { workspaceId: this.workspaceId, kind: "proposal", botId: input.botId, id: input.proposalId };
      const proposal = (collection ? await collection.findOne(filter) : null) as unknown as PlaybookProposal | null || await this.read<PlaybookProposal>(`proposal:${input.proposalId}`);
      if (!proposal || proposal.botId !== input.botId || proposal.workspaceId !== this.workspaceId) throw new Error("Proposal not found in this bot/workspace.");
      const current = await this.approved(input.botId);
      // Crash recovery: a committed revision may precede updating proposal status.
      const alreadyApplied = current.lessons.some(lesson => lesson.proposalId === proposal.id);
      if (alreadyApplied && input.decision !== "approve") throw new Error("An approved lesson cannot be rejected retroactively. Create a reviewed correction instead.");
      if (!alreadyApplied && current.revision !== input.expectedRevision) throw new RevisionConflict("Playbook changed; inspect the current revision before reviewing again.");
      if (!alreadyApplied && proposal.status !== "pending") throw new Error("Proposal has already been reviewed.");
      let next = current;
      if (input.decision === "approve" && !alreadyApplied) {
        const lessons = [...current.lessons, { proposalId: proposal.id, text: proposal.text, evidenceRef: proposal.evidenceRef }];
        if (formatApprovedPlaybook({ ...current, lessons }).length > envInteger("BROWSER_AGENT_REVIEWED_PLAYBOOK_CHARS", 1200)) {
          throw new Error("Reviewed playbook budget reached. Compact the proposal with the owner before approval; no lessons were dropped.");
        }
        next = { ...current, lessons, revision: current.revision + 1, updatedAt: new Date().toISOString() };
        if (collection) {
          try {
            const update = await collection.updateOne({ workspaceId: this.workspaceId, kind: "approved", botId: input.botId, revision: input.expectedRevision }, { $set: next }, { upsert: input.expectedRevision === 0 });
            if (!update.matchedCount && !update.upsertedCount) throw new RevisionConflict("Playbook revision changed.");
          } catch (error) {
            if ((error as {code?: number}).code === 11000) throw new RevisionConflict("Playbook revision changed.");
            throw error;
          }
        }
        await this.write(`approved:${input.botId}`, next);
      }
      const reviewed = { ...proposal, status: input.decision === "approve" ? "approved" as const : "rejected" as const,
        reviewedBy: redactSecrets(input.reviewer), reviewedAt: new Date().toISOString() };
      await this.write(`proposal:${proposal.id}`, reviewed);
      if (collection) await collection.updateOne(filter, { $set: reviewed }, { upsert: true });
      if (next.revision > current.revision || alreadyApplied) await this.notify(next);
      return next;
      } finally { await lock.close(); await unlink(lockPath).catch(() => undefined); }
    });
  }

  async proposal(botId: string, proposalId: string): Promise<PlaybookProposal | null> {
    this.validateBot(botId);
    if (!/^[a-f0-9-]{36}$/.test(proposalId)) throw new Error("Invalid proposal reference.");
    const collection = await this.collection();
    const record = (collection ? await collection.findOne({ workspaceId: this.workspaceId, kind: "proposal", botId, id: proposalId }) : null) as unknown as PlaybookProposal | null || await this.read<PlaybookProposal>(`proposal:${proposalId}`);
    return record && record.workspaceId === this.workspaceId && record.botId === botId ? record : null;
  }

  async proposals(botId: string): Promise<PlaybookProposal[]> {
    this.validateBot(botId);
    const records = new Map<string, PlaybookProposal>();
    const files = await readdir(this.directory).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
    for (const file of files) {
      if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
      const record = JSON.parse(await readFile(join(this.directory, file), "utf8"));
      if (record.kind === "proposal" && record.botId === botId && record.workspaceId === this.workspaceId) records.set(record.id, record);
    }
    const collection = await this.collection();
    if (collection) for await (const record of collection.find({ workspaceId: this.workspaceId, kind: "proposal", botId })) {
      records.set(String(record.id), record as unknown as PlaybookProposal);
    }
    return [...records.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  subscribe(listener: (event: PlaybookUpdated) => Promise<void> | void): () => void {
    this.listeners.add(listener);
    this.stopped = false;
    void mkdir(this.directory, { recursive: true, mode: 0o700 }).then(() => {
      if (this.stopped || this.localWatcher) return;
      this.localWatcher = watch(this.directory, { persistent: false }, (_event, filename) => {
        if (!filename || !/^[a-f0-9]{64}\.json$/.test(String(filename))) return;
        void readFile(join(this.directory, String(filename)), "utf8").then(text => {
          const record = JSON.parse(text);
          if (record.kind === "approved" && record.workspaceId === this.workspaceId && BOT_ID_PATTERN.test(record.botId)) return this.notify(record);
        }).catch(() => undefined);
      });
      this.localWatcher.on("error", () => { this.localWatcher?.close(); this.localWatcher = null; });
    }).catch(() => undefined);
    void this.startWatch();
    return () => { this.listeners.delete(listener); if (!this.listeners.size) void this.close(); };
  }
  private async notify(record: ApprovedPlaybook): Promise<void> {
    const previous = this.notificationChains.get(record.botId) || Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      if (!this.listeners.size) return;
      const receiptKey = `notification:${record.botId}`;
      const receipt = await this.read<{ revision: number }>(receiptKey);
      if (receipt && receipt.revision >= record.revision) return;
      const ref = `playbook:${record.botId}:${record.revision}`;
      const event: PlaybookUpdated = { id: createHash("sha256").update(`${this.workspaceId}:${ref}`).digest("hex"), topic: "playbook.updated", botId: record.botId, revision: record.revision, ref };
      for (const listener of this.listeners) await listener(event);
      // Acknowledge only after deterministic subscribers succeed. Repeated delivery
      // after a crash is possible; handlers must be idempotent. Never run an action here.
      await this.write(receiptKey, { revision: record.revision });
    });
    this.notificationChains.set(record.botId, next);
    try { await next; } finally { if (this.notificationChains.get(record.botId) === next) this.notificationChains.delete(record.botId); }
  }
  private async startWatch(): Promise<void> {
    if (this.stopped || this.stream || this.watchStarting || this.workspaceId === "local") return;
    this.watchStarting = (async () => {
      const collection = await this.collection();
      if (!collection || this.stopped) return;
      const stream = collection.watch([{ $match: { "fullDocument.workspaceId": this.workspaceId, "fullDocument.kind": "approved" } }], { fullDocument: "updateLookup" });
      this.stream = stream;
      stream.on("change", change => { if ("fullDocument" in change && change.fullDocument) void this.notify(change.fullDocument as unknown as ApprovedPlaybook).catch(() => this.scheduleRetry()); });
      const restart = () => { if (this.stream !== stream) return; this.stream = null; void stream.close().catch(() => undefined); this.scheduleRetry(); };
      stream.on("error", restart); stream.on("close", restart);
      // Snapshot reconciliation handles oplog expiry/reconnection; these are state
      // invalidations, not a general task queue. No per-browser Mongo cursors.
      for await (const record of collection.find({ workspaceId: this.workspaceId, kind: "approved" })) {
        await this.notify(record as unknown as ApprovedPlaybook);
      }
    })().catch(() => this.scheduleRetry()).finally(() => { this.watchStarting = null; if (!this.stream) this.scheduleRetry(); });
    await this.watchStarting;
  }
  private scheduleRetry(): void {
    if (this.retry || this.stopped || this.workspaceId === "local") return;
    this.retry = setTimeout(() => { this.retry = null; if (this.stream) { const stream = this.stream; this.stream = null; void stream.close().catch(() => undefined); } void this.startWatch(); }, envInteger("BROWSER_AGENT_PLAYBOOK_RETRY_MS", 15000));
    this.retry.unref();
  }
  async close(): Promise<void> {
    this.stopped = true;
    this.localWatcher?.close(); this.localWatcher = null;
    if (this.retry) clearTimeout(this.retry); this.retry = null;
    const stream = this.stream; this.stream = null;
    if (stream) await stream.close().catch(() => undefined);
  }
}

export function formatApprovedPlaybook(record: ApprovedPlaybook): string {
  return record.lessons.map(lesson => `- ${lesson.text} (evidence: ${lesson.evidenceRef})`).join("\n");
}
