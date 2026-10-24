import { createHash, timingSafeEqual } from "node:crypto";

type HandoffEntry<T> = {
  expiresAt: number;
  verifierHash: Buffer;
  result?: T;
};

export type HandoffExchange<T> =
  | { status: "pending" }
  | { status: "invalid" }
  | { status: "complete"; value: T };

/** One-time, short-lived bridge from an external OAuth browser back to the local app. */
export class GoogleSignInHandoffStore<T> {
  private readonly entries = new Map<string, HandoffEntry<T>>();

  constructor(private readonly maxEntries = 512) {}

  register(state: string, verifier: string, expiresAt: number, now = Date.now()): boolean {
    this.prune(now);
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (!oldest) break;
      this.entries.delete(oldest);
    }
    this.entries.set(state, {
      expiresAt,
      verifierHash: createHash("sha256").update(verifier).digest()
    });
    return true;
  }

  isPending(state: string, now = Date.now()): boolean {
    const entry = this.entries.get(state);
    if (!entry || entry.expiresAt <= now) {
      this.entries.delete(state);
      return false;
    }
    return entry.result === undefined;
  }

  complete(state: string, result: T, expiresAt: number, now = Date.now()): boolean {
    const entry = this.entries.get(state);
    if (!entry || entry.expiresAt <= now || entry.result !== undefined) {
      this.entries.delete(state);
      return false;
    }
    entry.result = result;
    entry.expiresAt = expiresAt;
    return true;
  }

  exchange(state: string, verifier: string, now = Date.now()): HandoffExchange<T> {
    const entry = this.entries.get(state);
    if (!entry || entry.expiresAt <= now) {
      this.entries.delete(state);
      return { status: "invalid" };
    }
    if (entry.result === undefined) return { status: "pending" };

    const verifierHash = createHash("sha256").update(verifier).digest();
    if (!timingSafeEqual(entry.verifierHash, verifierHash)) return { status: "invalid" };

    this.entries.delete(state);
    return { status: "complete", value: entry.result };
  }

  invalidate(state: string): void {
    this.entries.delete(state);
  }

  private prune(now: number): void {
    for (const [state, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(state);
    }
  }
}
