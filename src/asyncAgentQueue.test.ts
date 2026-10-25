import assert from "node:assert/strict";
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
