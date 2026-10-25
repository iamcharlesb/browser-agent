import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AsyncAgentQueue } from "./asyncAgentQueue";
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test("all bots enqueue asynchronously and keep one shared-browser owner", async () => {
  let blocked = true, running = 0, peak = 0;
  const executions: string[] = [];
  const queue = new AsyncAgentQueue<string>(() => blocked, async job => {
    running++; peak = Math.max(peak, running); executions.push(job.input);
    job.runId = "run-" + job.id;
    await pause(20); running--;
  });
  const first = queue.enqueue("Writer"), second = queue.enqueue("Researcher"), third = queue.enqueue("Cancel this");
  assert.equal(executions.length, 0);
  assert.equal(queue.cancel(third.id), true);
  await pause(150);
  assert.equal(first.status, "queued");
  blocked = false;
  for (let attempt = 0; attempt < 25 && second.status !== "completed"; attempt++) await pause(40);
  assert.deepEqual(executions, ["Writer", "Researcher"]);
  assert.equal(peak, 1);
  assert.equal(first.status, "completed");
  assert.equal(third.status, "cancelled");
});

test("stop clears pending work and failed jobs do not block later agents", async () => {
  const executed: string[] = [];
  const queue = new AsyncAgentQueue<string>(() => false, async job => {
    executed.push(job.input);
    if (job.input === "fail") throw Error("Expected worker failure");
  });
  const cancelled = queue.enqueue("cancelled"); queue.clear();
  const failed = queue.enqueue("fail"), succeeded = queue.enqueue("success");
  for (let attempt = 0; attempt < 25 && succeeded.status !== "completed"; attempt++) await pause(40);
  assert.deepEqual(executed, ["fail", "success"]);
  assert.equal(failed.status, "failed");
  assert.equal(cancelled.status, "cancelled");
});

test("queued jobs survive restart and interrupted running jobs require review", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-queue-recovery-"));
  try {
    const file = join(directory, "queue.json");
    const first = new AsyncAgentQueue<{ task: string }>(() => true, async () => undefined, 50, file);
    const queued = first.enqueue({ task: "waiting" });
    const persisted = JSON.parse(await readFile(file, "utf8"));
    assert.equal(persisted[0].status, "queued");
    const restored = new AsyncAgentQueue<{ task: string }>(() => true, async () => undefined, 50, file);
    restored.restore(false);
    assert.equal(restored.get(queued.id)?.status, "queued");

    let release!: () => void;
    const started = new Promise<void>(resolve => { release = resolve; });
    const runningQueue = new AsyncAgentQueue<string>(() => false, async () => started, 50, file);
    const running = runningQueue.enqueue("may have side effects");
    for (let attempt = 0; attempt < 20 && running.status !== "running"; attempt++) await pause(10);
    const afterRestart = new AsyncAgentQueue<string>(() => true, async () => undefined, 50, file);
    afterRestart.restore(false);
    assert.equal(afterRestart.get(running.id)?.status, "failed");
    assert.match(afterRestart.get(running.id)?.error || "", /review its external effects/i);
    release();
    await pause(40);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("retrying a failed queued job requires explicit duplicate-effect confirmation", async () => {
  const queue = new AsyncAgentQueue<string>(() => true, async () => undefined);
  const job = queue.enqueue("task");
  job.status = "failed";
  assert.throws(() => queue.retry(job.id, false), /explicit confirmation/);
  assert.equal(queue.retry(job.id, true).status, "queued");
  queue.clear();
});
