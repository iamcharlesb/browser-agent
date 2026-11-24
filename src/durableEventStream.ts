/**
 * Shared, at-least-once event relay for separately running Pilo installations.
 * MongoDB is the durable log and one Change Stream per server process fans updates
 * into that process's local bus. It transports facts only: a remote event is never
 * sufficient authorization to start a model, browser action, or paid schedule.
 */
import { EJSON } from "bson";
import { type ChangeStream, type Collection, type Db } from "mongodb";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BusMessage, MessageBus, Unsubscribe } from "./messageBus";
import { envInteger } from "./runtimeConfig";
import { redactSecretValues } from "./security";
import { sharedMongoDatabase } from "./userStore";

export interface SharedAgentEvent {
  _id: string;
  workspaceId: string;
  topic: string;
  payload: unknown;
  source?: string;
  correlationId?: string;
  publishedAt: string | Date;
  schemaVersion: 1;
}
export interface EventRelayState { resumeToken?: unknown; publishedAt?: string | Date; lastEventId?: string }
export interface RelayOptions {
  workspaceId?: string;
  stateDirectory: string;
  database?: () => Promise<Db | null>;
  remoteTopics?: string[];
  onRemoteEvent?: (event: SharedAgentEvent) => void;
  onError?: (error: Error) => void;
}

const DEFAULT_REMOTE_TOPICS = ["agent.run.started", "agent.run.completed", "agent.playbook.updated", "workflow.created", "workflow.started", "workflow.task.queued", "workflow.task.completed", "workspace.event"];
const DURABLE_TOPICS = new Set([
  "agent.run.started", "agent.run.completed", "agent.handoff.requested", "agent.handoff.queued", "agent.handoff.rejected",
  "agent.playbook.updated", "agent.learning.proposed", "observer.suggestion.proposed", "observer.suggestion.reviewed",
  "workspace.event", "marketing.strategy.updated", "positioning.insight.discovered", "offer.experiment.proposed",
  "workflow.created", "workflow.started", "workflow.task.queued", "workflow.task.completed",
  "funnel.design.proposed", "ux.review.requested", "ux.review.completed", "ux.audit.completed", "campaign.creative.requested",
  "campaign.performance.updated", "product.feature.launched", "customer.objection.detected", "advertising.audit.requested",
  "ads.performance.anomaly", "ads.tracking.issue.detected", "ads.optimization.recommended", "experiment.results.available",
  "landing.page.created", "conversion.friction.detected", "pricing.experiment.proposed"
]);
const toError = (error: unknown) => error instanceof Error ? error : new Error(String(error));

export class DurableEventStream {
  readonly workspaceId: string;
  private readonly database: () => Promise<Db | null>;
  private readonly remoteTopics: Set<string>;
  private readonly stateFile: string;
  private readonly localIds = new Set<string>();
  private readonly processedRemoteIds = new Set<string>();
  private bus: MessageBus | null = null;
  private unsubscribe: Unsubscribe | null = null;
  private stream: ChangeStream | null = null;
  private state: EventRelayState = {};
  private chain: Promise<void> = Promise.resolve();
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private stopped = false;
  private startup: Promise<void> | null = null;

  constructor(private readonly options: RelayOptions) {
    this.workspaceId = options.workspaceId ?? process.env.BROWSER_AGENT_WORKSPACE_ID?.trim() ?? "local";
    this.database = options.database ?? sharedMongoDatabase;
    this.remoteTopics = new Set(options.remoteTopics ?? DEFAULT_REMOTE_TOPICS);
    this.stateFile = join(options.stateDirectory, `event-offset-${this.workspaceId.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);
  }

  get enabled(): boolean { return this.workspaceId !== "local" && Boolean(process.env.MONGODB_URI?.trim()); }

  async start(bus: MessageBus): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    this.bus = bus;
    if (!this.enabled) return;
    await this.loadState();
    this.unsubscribe = bus.subscribe("agent.#", message => this.persistLocal(message));
    // These are explicit, separately known application event families. The generic
    // agent wildcard already covers agent.*; the other namespaces are opt-in.
    const extra = ["playbook.#", "observer.#", "workflow.#", "ux.#", "ads.#", "campaign.#"];
    for (const pattern of extra) {
      const off = bus.subscribe(pattern, message => this.persistLocal(message));
      const previous = this.unsubscribe;
      this.unsubscribe = () => { previous?.(); off(); };
    }
    await this.openStream();
  }

  async publish(topic: string, payload: unknown, options: { source?: string; correlationId?: string; id?: string } = {}): Promise<string | null> {
    if (!this.enabled) return null;
    const db = await this.database();
    if (!db) throw new Error("Shared event storage is unavailable; event was not accepted.");
    const record: SharedAgentEvent = {
      _id: options.id ?? randomUUID(),
      workspaceId: this.workspaceId,
      topic,
      payload: redactSecretValues(payload),
      ...(options.source ? { source: options.source } : {}),
      ...(options.correlationId ? { correlationId: options.correlationId } : {}),
      publishedAt: new Date(),
      schemaVersion: 1
    };
    this.localIds.add(record._id);
    if (this.localIds.size > 2000) this.localIds.delete(this.localIds.values().next().value!);
    try {
      const collection = db.collection<SharedAgentEvent>("agent_events");
      await collection.insertOne(record as SharedAgentEvent & { _id: string });
    } catch (error) {
      if ((error as { code?: number }).code === 11000) return record._id;
      this.localIds.delete(record._id);
      throw error;
    }
    return record._id;
  }

  async list(after?: string, limit = 100): Promise<SharedAgentEvent[]> {
    if (!this.enabled) return [];
    const db = await this.database();
    if (!db) return [];
    const size = Math.max(1, Math.min(500, Math.floor(limit)));
    const query: Record<string, unknown> = { workspaceId: this.workspaceId };
    if (after) {
      const cursorText = Buffer.from(after, "base64url").toString("utf8");
      const split = cursorText.indexOf("|");
      const timestamp = new Date(cursorText.slice(0, split));
      const id = cursorText.slice(split + 1);
      if (split < 1 || !Number.isFinite(timestamp.getTime()) || !id) throw new Error("Invalid shared event cursor.");
      query.$or = [{ publishedAt: { $gt: timestamp } }, { publishedAt: timestamp, _id: { $gt: id } }];
    }
    return db.collection<SharedAgentEvent>("agent_events").find(query).sort({ publishedAt: 1, _id: 1 }).limit(size).toArray();
  }

  cursor(event: SharedAgentEvent): string {
    const timestamp = event.publishedAt instanceof Date ? event.publishedAt.toISOString() : event.publishedAt;
    return Buffer.from(`${timestamp}|${event._id}`).toString("base64url");
  }

  async close(): Promise<void> {
    this.stopped = true;
    this.started = false;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.unsubscribe?.(); this.unsubscribe = null;
    const stream = this.stream; this.stream = null;
    if (stream) await stream.close().catch(() => undefined);
  }

  private async persistLocal(message: BusMessage): Promise<void> {
    if (message.source === "mongo-event-stream") return;
    if (!DURABLE_TOPICS.has(message.topic)) return;
    if (JSON.stringify(message.payload).length > 64_000) {
      this.options.onError?.(new Error(`Event '${message.topic}' exceeded the 64 KB shared-event limit and was not mirrored.`));
      return;
    }
    try { await this.publish(message.topic, message.payload, { source: message.source, correlationId: message.correlationId, id: message.id }); }
    catch (error) { this.options.onError?.(toError(error)); }
  }

  private async loadState(): Promise<void> {
    try { this.state = EJSON.parse(await readFile(this.stateFile, "utf8")) as EventRelayState; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.options.onError?.(toError(error)); }
  }

  private async saveState(): Promise<void> {
    await mkdir(this.options.stateDirectory, { recursive: true, mode: 0o700 });
    const temp = `${this.stateFile}.${process.pid}.tmp`;
    await writeFile(temp, EJSON.stringify(this.state), { mode: 0o600 });
    await rename(temp, this.stateFile);
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.openStream();
    }, envInteger("BROWSER_AGENT_EVENT_RETRY_MS", 15000));
    this.retryTimer.unref();
  }

  private async openStream(): Promise<void> {
    if (this.stopped || !this.started || this.stream || this.startup) return this.startup ?? Promise.resolve();
    this.startup = (async () => {
      const db = await this.database();
      if (!db || this.stopped) { this.scheduleRetry(); return; }
      const collection = db.collection<SharedAgentEvent>("agent_events");
      await collection.createIndex({ workspaceId: 1, publishedAt: 1, _id: 1 });
      await collection.createIndex({ publishedAt: 1 }, { expireAfterSeconds: envInteger("BROWSER_AGENT_EVENT_RETENTION_DAYS", 30, 1, 365) * 86400 });
      const stream = collection.watch([{ $match: { "fullDocument.workspaceId": this.workspaceId } }], {
        fullDocument: "updateLookup", maxAwaitTimeMS: 1000,
        ...(this.state.resumeToken ? { resumeAfter: this.state.resumeToken as object } : {})
      });
      this.stream = stream;
      stream.on("change", change => {
        this.chain = this.chain.then(async () => {
          if (!this.stream || this.stream !== stream) return;
          const record = "fullDocument" in change ? change.fullDocument as SharedAgentEvent | undefined : undefined;
          if (record) await this.deliverRemote(record);
          this.state = { resumeToken: change._id, publishedAt: record?.publishedAt ?? this.state.publishedAt, lastEventId: record?._id ?? this.state.lastEventId };
          await this.saveState();
        }).catch(error => {
          this.options.onError?.(toError(error));
          // Do not advance the durable cursor after a failed local subscriber.
          // Reconnect from the last saved token and replay the event at least once.
          restart();
        });
      });
      const restart = () => {
        if (this.stream !== stream) return;
        this.stream = null;
        void stream.close().catch(() => undefined);
        // Mongo reports code 286 after the oplog no longer contains the saved token.
        // The durable event collection is then reconciled from the last stored timestamp.
        if (this.state.resumeToken && stream.resumeToken === undefined) this.state.resumeToken = undefined;
        this.scheduleRetry();
      };
      stream.on("error", error => {
        this.options.onError?.(toError(error));
        if ((error as { code?: number }).code === 286 || (error as { code?: number }).code === 260) this.state.resumeToken = undefined;
        restart();
      });
      stream.on("close", restart);
      if (!this.state.resumeToken && this.state.publishedAt) await this.replaySinceCheckpoint(collection);
    })().catch(error => {
      this.options.onError?.(toError(error));
      const failedStream = this.stream;
      this.stream = null;
      if (failedStream) void failedStream.close().catch(() => undefined);
      this.scheduleRetry();
    }).finally(() => { this.startup = null; });
    await this.startup;
  }

  private async replaySinceCheckpoint(collection: Collection<SharedAgentEvent>): Promise<void> {
    let checkpoint = this.state.publishedAt instanceof Date ? this.state.publishedAt : new Date(this.state.publishedAt!);
    let lastId = this.state.lastEventId ?? "";
    if (!Number.isFinite(checkpoint.getTime())) return;
    while (!this.stopped) {
      const query = { workspaceId: this.workspaceId, ...(lastId
        ? { $or: [{ publishedAt: { $gt: checkpoint } }, { publishedAt: checkpoint, _id: { $gt: lastId } }] }
        : { publishedAt: { $gte: checkpoint } }) };
      const events = await collection.find(query).sort({ publishedAt: 1, _id: 1 }).limit(500).toArray() as unknown as SharedAgentEvent[];
      if (!events.length) break;
      for (const record of events) {
        this.chain = this.chain.then(async () => {
          await this.deliverRemote(record);
          checkpoint = record.publishedAt instanceof Date ? record.publishedAt : new Date(record.publishedAt);
          lastId = record._id;
          this.state.publishedAt = record.publishedAt;
          this.state.lastEventId = record._id;
          await this.saveState();
        });
        await this.chain;
      }
      await this.saveState();
      if (events.length < 500) break;
    }
    await this.saveState();
  }

  private async deliverRemote(record: SharedAgentEvent): Promise<void> {
    if (this.localIds.delete(record._id) || this.processedRemoteIds.has(record._id) || !this.remoteTopics.has(record.topic)) return;
    const safe = { ...record, payload: redactSecretValues(record.payload) };
    this.options.onRemoteEvent?.(safe);
    await this.bus?.publishAndWaitStrict(record.topic, safe.payload, { id: record._id, publishedAt: record.publishedAt instanceof Date ? record.publishedAt.toISOString() : record.publishedAt, source: "mongo-event-stream", correlationId: record.correlationId });
    this.processedRemoteIds.add(record._id);
    if (this.processedRemoteIds.size > 2000) this.processedRemoteIds.delete(this.processedRemoteIds.values().next().value!);
  }
}
