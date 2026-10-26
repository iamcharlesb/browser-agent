/** Async acceptance for all bots; the shared browser has a single execution owner. */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { redactSecretValues } from "./security";
export interface AsyncAgentJob<T> { id: string; input: T; status: "queued" | "running" | "completed" | "failed" | "cancelled"; runId?: string; error?: string; attempts?: number; updatedAt?: string }
export interface AsyncQueueOptions<T> {
  maxConcurrent?: number;
  canStart?: (input: T, running: AsyncAgentJob<T>[]) => boolean;
}
export class AsyncAgentQueue<T> {
  private jobs = new Map<string, AsyncAgentJob<T>>();
  private pending: string[] = [];
  private running = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(private readonly blocked: () => boolean, private readonly execute: (job: AsyncAgentJob<T>) => Promise<void>, private readonly maxPending = 50, private readonly persistencePath?: string, private readonly options: AsyncQueueOptions<T> = {}) {}
  /** Restore queued work and mark interrupted executions for operator review, never auto-retry them. */
  restore(armImmediately = true): void {
    if (!this.persistencePath) return;
    try {
      const saved = JSON.parse(readFileSync(this.persistencePath, "utf8")) as AsyncAgentJob<T>[];
      for (const entry of saved.slice(-100)) {
        if (!entry || typeof entry.id !== "string" || !entry.input || !["queued", "running", "completed", "failed", "cancelled"].includes(entry.status)) continue;
        const job = { ...entry };
        if (job.status === "running") { job.status = "failed"; job.error = "The server restarted while this job was running. Review its external effects before retrying."; }
        this.jobs.set(job.id, job);
        if (job.status === "queued") this.pending.push(job.id);
      }
      if (armImmediately) this.arm();
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  resume(): void { this.arm(); }
  enqueue(input: T, first = false): AsyncAgentJob<T> {
    if (this.pending.length >= this.maxPending) throw new Error("Agent request queue is full.");
    const job: AsyncAgentJob<T> = { id: randomUUID(), input, status: "queued" };
    this.jobs.set(job.id, job);
    if (first) this.pending.unshift(job.id); else this.pending.push(job.id);
    try { this.persist(true); }
    catch (error) { this.jobs.delete(job.id); this.pending = this.pending.filter(id => id !== job.id); throw error; }
    this.arm(); return job;
  }
  get(id: string): AsyncAgentJob<T> | undefined { return this.jobs.get(id); }
  retry(id: string, confirmed: boolean, input?: T): AsyncAgentJob<T> {
    if (!confirmed) throw new Error("Retry requires explicit confirmation to avoid repeating an external side effect.");
    const job = this.jobs.get(id);
    if (!job || job.status !== "failed") throw new Error("Only failed jobs can be retried.");
    if (this.pending.length >= this.maxPending) throw new Error("Agent request queue is full.");
    const previous = { ...job };
    if (input !== undefined) job.input = input;
    job.status = "queued"; job.error = undefined; job.runId = undefined; job.updatedAt = new Date().toISOString();
    this.pending.push(id);
    try { this.persist(true); }
    catch (error) { Object.assign(job, previous); this.pending = this.pending.filter(candidate => candidate !== id); throw error; }
    this.arm();
    return job;
  }
  cancel(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job || job.status !== "queued") return false;
    job.status = "cancelled"; job.updatedAt = new Date().toISOString(); this.pending = this.pending.filter(candidate => candidate !== id); this.persist(); return true;
  }
  clear(): void { for (const id of [...this.pending]) this.cancel(id); }
  private arm(): void {
    if (this.timer || this.running.size >= (this.options.maxConcurrent ?? 1) || !this.pending.length) return;
    this.timer = setTimeout(() => { this.timer = null; void this.drain(); }, 100);
    this.timer.unref();
  }
  private drain(): void {
    while (this.running.size < (this.options.maxConcurrent ?? 1) && this.pending.length && !this.blocked()) {
      const running = [...this.running].map(id => this.jobs.get(id)!);
      // Skip a blocked browser/bot job so unrelated text work can use a free slot.
      const index = this.pending.findIndex(id => !this.options.canStart || this.options.canStart(this.jobs.get(id)!.input, running));
      if (index < 0) break;
      const job = this.jobs.get(this.pending.splice(index, 1)[0])!;
      this.running.add(job.id);
      job.status = "running"; job.attempts = (job.attempts ?? 0) + 1; job.updatedAt = new Date().toISOString();
      void this.runJob(job);
    }
    this.arm();
  }
  private async runJob(job: AsyncAgentJob<T>): Promise<void> {
    try { this.persist(); await this.execute(job); if ((job.status as string) !== "cancelled") job.status = "completed"; }
    catch (error) { if ((job.status as string) !== "cancelled") { job.status = "failed"; job.error = error instanceof Error ? error.message : "Agent request failed."; } }
    finally {
      job.updatedAt = new Date().toISOString(); this.persist();
      this.running.delete(job.id);
      // Bounded completed-job metadata; active/queued jobs are never discarded.
      for (const [id, entry] of this.jobs) if (this.jobs.size > 100 && !["queued", "running"].includes(entry.status)) this.jobs.delete(id);
      this.arm();
    }
  }
  list(): AsyncAgentJob<T>[] { return [...this.jobs.values()]; }
  private persist(strict = false): void {
    if (!this.persistencePath) return;
    try {
      mkdirSync(dirname(this.persistencePath), { recursive: true, mode: 0o700 });
      const all = [...this.jobs.values()];
      const active = all.filter(job => ["queued", "running"].includes(job.status));
      const terminal = all.filter(job => !["queued", "running"].includes(job.status));
      const jobs = [...terminal.slice(Math.max(0, terminal.length - Math.max(0, 100 - active.length))), ...active].map(job => redactSecretValues(job));
      const temporary = `${this.persistencePath}.${process.pid}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(jobs, null, 2)}\n`, { mode: 0o600 });
      renameSync(temporary, this.persistencePath);
    } catch (error) {
      // Persistence failure must be visible and should reject new accepted work.
      if (strict) throw new Error(`Could not persist async agent queue: ${error instanceof Error ? error.message : String(error)}`);
      console.warn("Could not update async agent queue state on disk.", error instanceof Error ? error.message : String(error));
    }
  }
}
