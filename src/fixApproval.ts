/**
 * Holds a written-but-unapplied patch set while the user decides.
 *
 * At the moment this gate is waiting, nothing has been written to any file - the patches exist
 * only inside the proposal object. So every way of not getting a "yes" (a timeout, a closed tab, a
 * crashed UI) has the same result as an explicit "no": the source is untouched. That is the same
 * rule the run loop uses for terminal commands, and it is why the default here is DENY.
 */

import { FixApprovalDecision, FixProposal } from "./learnMode";

export const DEFAULT_FIX_APPROVAL_TIMEOUT_MS = 30 * 60_000;

interface Pending {
  proposal: FixProposal;
  resolve: (decision: FixApprovalDecision) => void;
  timer: NodeJS.Timeout;
}

export class FixApprovalGate {
  private pending: Pending | null = null;

  constructor(private readonly timeoutMs: number = DEFAULT_FIX_APPROVAL_TIMEOUT_MS) {}

  /** The patch set currently awaiting a decision, so a reloaded tab can pick it back up. */
  get pendingProposal(): FixProposal | null {
    return this.pending?.proposal ?? null;
  }

  get isWaiting(): boolean {
    return this.pending !== null;
  }

  /** The `onFixApproval` hook handed to a learn session. */
  request = (proposal: FixProposal): Promise<FixApprovalDecision> => {
    // A second proposal while one is pending would orphan the first session's promise forever.
    if (this.pending) {
      return Promise.resolve({
        approved: false,
        reason: "another patch set was already waiting for a decision"
      });
    }
    return new Promise<FixApprovalDecision>((resolve) => {
      const timer = setTimeout(() => {
        this.settle({ approved: false, reason: `nobody answered within ${Math.round(this.timeoutMs / 60_000)} minutes` });
      }, this.timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
      this.pending = { proposal, resolve, timer };
    });
  };

  /** Returns false when there was nothing to decide (a late or duplicate click). */
  settle(decision: FixApprovalDecision): boolean {
    const pending = this.pending;
    if (!pending) return false;
    this.pending = null;
    clearTimeout(pending.timer);
    pending.resolve(decision);
    return true;
  }

  /** Keeps only ids that belong to the pending proposal; undefined in, undefined out (= all). */
  normalizePatchIds(patchIds: unknown): string[] | undefined {
    if (!Array.isArray(patchIds)) return undefined;
    const known = new Set((this.pendingProposal?.fixes ?? []).map((fix) => fix.id));
    return patchIds.filter((id): id is string => typeof id === "string" && known.has(id));
  }
}
