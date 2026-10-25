import type { SessionMode } from "./browserController";
import type { AgentEngine, InteractionMode } from "./promptLoop";
/**
 * Local in-process publish/subscribe bus.
 *
 * Bots never call each other directly. A bot that needs a peer publishes a message on a topic and
 * the server-side subscriber decides what to run next. That matters for three reasons:
 *   1. Delegation used to be implemented in the browser UI, so a handoff was lost whenever the tab
 *      was closed and never happened at all for headless/scheduled runs.
 *   2. Publisher and subscriber can't deadlock on each other - there is no direct call edge.
 *   3. Every hop is observable: `history()` is the audit trail of who asked whom to do what.
 *
 * Topic patterns use dot segments: `*` matches exactly one segment, `#` matches one or more and
 * must be the last segment. `agent.run.*` matches `agent.run.started`; `agent.#` matches both.
 */

import { randomUUID } from "node:crypto";

export interface BusMessage<T = unknown> {
  id: string;
  topic: string;
  payload: T;
  publishedAt: string;
  /** Who published it, for the audit trail (usually a bot name or "server"). */
  source?: string;
  /** Ties a request to its reply, and a whole delegation chain back to its first hop. */
  correlationId?: string;
  /** Topic a responder should publish its reply on; set by `request()`. */
  replyTo?: string;
}

export type BusHandler<T = unknown> = (message: BusMessage<T>) => void | Promise<void>;
export type Unsubscribe = () => void;

export interface PublishOptions {
  id?: string;
  publishedAt?: string;
  source?: string;
  correlationId?: string;
  replyTo?: string;
}

export interface MessageBusOptions {
  /** Messages kept for replay/audit. Oldest are dropped first. */
  historyLimit?: number;
  onError?: (error: Error, message: BusMessage) => void;
}

/** Handler failures are republished here rather than crashing the publisher. */
export const BUS_ERROR_TOPIC = "$bus.error";

export interface BusErrorPayload {
  topic: string;
  error: string;
  messageId: string;
}

const TOPIC_PATTERN = /^[A-Za-z0-9_$][A-Za-z0-9_$.*#-]*$/;

export function assertValidTopic(topic: string): void {
  if (!topic || !TOPIC_PATTERN.test(topic)) {
    throw new Error(`Invalid bus topic: ${JSON.stringify(topic)}`);
  }
  const segments = topic.split(".");
  if (segments.some((segment) => segment.length === 0)) {
    throw new Error(`Invalid bus topic (empty segment): ${JSON.stringify(topic)}`);
  }
  const hashIndex = segments.indexOf("#");
  if (hashIndex !== -1 && hashIndex !== segments.length - 1) {
    throw new Error(`"#" may only be the last segment of a topic pattern: ${JSON.stringify(topic)}`);
  }
}

export function topicMatches(pattern: string, topic: string): boolean {
  if (pattern === topic) return true;
  const patternSegments = pattern.split(".");
  const topicSegments = topic.split(".");

  for (let i = 0; i < patternSegments.length; i += 1) {
    const patternSegment = patternSegments[i];
    if (patternSegment === "#") {
      // "#" must consume at least one remaining segment, so `agent.#` does not match `agent`.
      return topicSegments.length > i;
    }
    if (i >= topicSegments.length) return false;
    if (patternSegment === "*") continue;
    if (patternSegment !== topicSegments[i]) return false;
  }
  return patternSegments.length === topicSegments.length;
}

interface Subscription {
  pattern: string;
  handler: BusHandler<never>;
  once: boolean;
  disposed: boolean;
}

export class MessageBus {
  private readonly subscriptions: Subscription[] = [];
  private readonly messages: BusMessage[] = [];
  private readonly historyLimit: number;
  private readonly onError?: (error: Error, message: BusMessage) => void;

  constructor(options: MessageBusOptions = {}) {
    this.historyLimit = options.historyLimit ?? 500;
    if (this.historyLimit < 0) throw new Error("historyLimit must be non-negative");
    this.onError = options.onError;
  }

  subscribe<T = unknown>(pattern: string, handler: BusHandler<T>): Unsubscribe {
    assertValidTopic(pattern);
    const subscription: Subscription = {
      pattern,
      handler: handler as BusHandler<never>,
      once: false,
      disposed: false
    };
    this.subscriptions.push(subscription);
    return () => this.dispose(subscription);
  }

  subscribeOnce<T = unknown>(pattern: string, handler: BusHandler<T>): Unsubscribe {
    assertValidTopic(pattern);
    const subscription: Subscription = {
      pattern,
      handler: handler as BusHandler<never>,
      once: true,
      disposed: false
    };
    this.subscriptions.push(subscription);
    return () => this.dispose(subscription);
  }

  /** Fire-and-forget. Handlers run on a later microtask so a publisher never blocks on them. */
  publish<T>(topic: string, payload: T, options: PublishOptions = {}): BusMessage<T> {
    const message = this.record(topic, payload, options);
    void this.dispatch(message);
    return message;
  }

  /** Publish and wait for every matching handler to settle. Used where ordering matters. */
  async publishAndWait<T>(topic: string, payload: T, options: PublishOptions = {}): Promise<BusMessage<T>> {
    const message = this.record(topic, payload, options);
    await this.dispatch(message);
    return message;
  }

  /** Publish and reject if any subscriber fails, for durable consumers that must not ack early. */
  async publishAndWaitStrict<T>(topic: string, payload: T, options: PublishOptions = {}): Promise<BusMessage<T>> {
    const message = this.record(topic, payload, options);
    await this.dispatch(message, true);
    return message;
  }

  /**
   * Request/response over topics. The responder gets `replyTo` on the message and answers with
   * `bus.reply(message, payload)`; nothing holds a reference to the other participant.
   */
  async request<Req, Res>(
    topic: string,
    payload: Req,
    options: PublishOptions & { timeoutMs?: number } = {}
  ): Promise<Res> {
    const correlationId = options.correlationId ?? randomUUID();
    const replyTopic = `$reply.${correlationId.replace(/[^A-Za-z0-9_-]/g, "")}`;
    const timeoutMs = options.timeoutMs ?? 30_000;

    return new Promise<Res>((resolve, reject) => {
      let timer: NodeJS.Timeout | null = null;
      const unsubscribe = this.subscribeOnce<Res>(replyTopic, (message) => {
        if (timer) clearTimeout(timer);
        resolve(message.payload);
      });
      timer = setTimeout(() => {
        unsubscribe();
        reject(new Error(`No reply on "${topic}" within ${timeoutMs}ms`));
      }, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
      this.publish(topic, payload, { ...options, correlationId, replyTo: replyTopic });
    });
  }

  reply<T>(message: BusMessage, payload: T, options: PublishOptions = {}): void {
    if (!message.replyTo) {
      throw new Error(`Message on "${message.topic}" has no replyTo topic to answer on.`);
    }
    this.publish(message.replyTo, payload, { ...options, correlationId: message.correlationId });
  }

  /** Replay buffer, oldest first. `pattern` accepts the same wildcards as `subscribe`. */
  history(pattern?: string, limit?: number): BusMessage[] {
    const matched = pattern
      ? this.messages.filter((message) => topicMatches(pattern, message.topic))
      : [...this.messages];
    if (limit === undefined) return matched;
    return matched.slice(Math.max(0, matched.length - limit));
  }

  subscriberCount(topic?: string): number {
    if (!topic) return this.subscriptions.length;
    return this.subscriptions.filter((subscription) => topicMatches(subscription.pattern, topic)).length;
  }

  clear(): void {
    this.subscriptions.length = 0;
    this.messages.length = 0;
  }

  private record<T>(topic: string, payload: T, options: PublishOptions): BusMessage<T> {
    assertValidTopic(topic);
    if (topic.includes("*") || topic.includes("#")) {
      throw new Error(`Cannot publish to a wildcard topic: ${JSON.stringify(topic)}`);
    }
    const message: BusMessage<T> = {
      id: options.id ?? randomUUID(),
      topic,
      payload,
      publishedAt: options.publishedAt ?? new Date().toISOString(),
      ...(options.source ? { source: options.source } : {}),
      ...(options.correlationId ? { correlationId: options.correlationId } : {}),
      ...(options.replyTo ? { replyTo: options.replyTo } : {})
    };
    if (this.historyLimit > 0) {
      this.messages.push(message as BusMessage);
      if (this.messages.length > this.historyLimit) {
        this.messages.splice(0, this.messages.length - this.historyLimit);
      }
    }
    return message;
  }

  private async dispatch(message: BusMessage, strict = false): Promise<void> {
    // Snapshot first: a handler that subscribes or unsubscribes must not change this delivery.
    const matched = this.subscriptions.filter(
      (subscription) => !subscription.disposed && topicMatches(subscription.pattern, message.topic)
    );
    if (matched.length === 0) return;

    const failures: Error[] = [];
    await Promise.all(
      matched.map(async (subscription) => {
        if (subscription.disposed) return;
        if (subscription.once) this.dispose(subscription);
        try {
          await subscription.handler(message as never);
        } catch (err) {
          failures.push(err instanceof Error ? err : new Error(String(err)));
          this.handleSubscriberError(err, message);
        }
      })
    );
    if (strict && failures.length) throw new AggregateError(failures, `One or more subscribers failed for "${message.topic}".`);
  }

  private handleSubscriberError(err: unknown, message: BusMessage): void {
    const error = err instanceof Error ? err : new Error(String(err));
    if (this.onError) {
      try {
        this.onError(error, message);
      } catch {
        // An onError hook that throws must not take the bus down with it.
      }
    }
    // Republishing an error from an error handler would loop forever.
    if (message.topic === BUS_ERROR_TOPIC) return;
    this.publish<BusErrorPayload>(BUS_ERROR_TOPIC, {
      topic: message.topic,
      error: error.message,
      messageId: message.id
    });
  }

  private dispose(subscription: Subscription): void {
    if (subscription.disposed) return;
    subscription.disposed = true;
    const index = this.subscriptions.indexOf(subscription);
    if (index >= 0) this.subscriptions.splice(index, 1);
  }
}

// ---------------------------------------------------------------------------
// Topics used by this app. Kept here so the whole message surface is in one place.
// ---------------------------------------------------------------------------

export const TOPICS = {
  /** A bot wants a peer to take over. Payload: AgentHandoffRequest. */
  handoffRequested: "agent.handoff.requested",
  /** The server accepted a handoff and queued it. Payload: AgentHandoffRequest & { queued: true }. */
  handoffQueued: "agent.handoff.queued",
  /** A handoff could not be queued. Payload: AgentHandoffRequest & { reason: string }. */
  handoffRejected: "agent.handoff.rejected",
  runStarted: "agent.run.started",
  runEvent: "agent.run.event",
  runCompleted: "agent.run.completed",
  learnStarted: "learn.session.started",
  learnUserTurn: "learn.turn.user",
  learnBotTurn: "learn.turn.bot",
  learnScored: "learn.session.scored",
  /** Patches are written but NOT applied: the session is waiting for the user's decision. */
  learnFixProposed: "learn.fix.proposed",
  /** The user approved or denied. Payload: { sessionId, approved, patchIds?, reason? }. */
  learnFixDecision: "learn.fix.decision",
  learnFixApplied: "learn.fix.applied",
  learnVerified: "learn.session.verified",
  learnCompleted: "learn.session.completed"
} as const;

export interface AgentHandoffRequest {
  discussionId?: string;
  fromBot: string;
  toBot: string;
  task: string;
  handoffNote?: string;
  /** Hop count, so a handoff loop between two bots can't run forever. */
  depth: number;
  model?: string;
  scheduleTimeZone?: string;
  sessionMode?: SessionMode;
  agentEngine?: AgentEngine;
  interactionMode?: InteractionMode;
  /** True when no human is watching (scheduled runs): privileged tools stay off. */
  unattended?: boolean;
}

/** Process-wide bus. Modules import this rather than passing a bus through every call site. */
export const localBus = new MessageBus();
