/** Async acceptance for all bots; the shared browser has a single execution owner. */
import { randomUUID } from "node:crypto";
export interface AsyncAgentJob<T> { id: string; input: T; status: "queued" | "running" | "completed" | "failed" | "cancelled"; runId?: string; error?: string }
export class AsyncAgentQueue<T> {
  private jobs = new Map<string, AsyncAgentJob<T>>();
  private pending: string[] = [];
  private busy = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(private readonly blocked: () => boolean, private readonly execute: (job: AsyncAgentJob<T>) => Promise<void>, private readonly maxPending = 50) {}
  enqueue(input: T, first = false): AsyncAgentJob<T> {
    if (this.pending.length >= this.maxPending) throw new Error("Agent request queue is full.");
    const job: AsyncAgentJob<T> = { id: randomUUID(), input, status: "queued" };
    this.jobs.set(job.id, job);
    if (first) this.pending.unshift(job.id); else this.pending.push(job.id);
    this.arm(); return job;
  }
  get(id: string): AsyncAgentJob<T> | undefined { return this.jobs.get(id); }
  cancel(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job || job.status !== "queued") return false;
    job.status = "cancelled"; this.pending = this.pending.filter(candidate => candidate !== id); return true;
  }
  clear(): void { for (const id of this.pending) this.cancel(id); }
  private arm(): void {
    if (this.timer || this.busy || !this.pending.length) return;
    this.timer = setTimeout(() => { this.timer = null; void this.drain(); }, 100);
    this.timer.unref();
  }
  private async drain(): Promise<void> {
    if (this.busy || !this.pending.length) return;
    if (this.blocked()) { this.arm(); return; }
    const job = this.jobs.get(this.pending.shift()!)!;
    this.busy = true; job.status = "running";
    try { await this.execute(job); if ((job.status as string) !== "cancelled") job.status = "completed"; }
    catch (error) { job.status = "failed"; job.error = error instanceof Error ? error.message : "Agent request failed."; }
    finally {
      this.busy = false;
      // Bounded completed-job metadata; active/queued jobs are never discarded.
      for (const [id, entry] of this.jobs) if (this.jobs.size > 100 && !["queued", "running"].includes(entry.status)) this.jobs.delete(id);
      this.arm();
    }
  }
}
