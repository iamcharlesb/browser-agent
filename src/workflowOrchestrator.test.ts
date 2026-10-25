import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WorkflowOrchestrator } from "./workflowOrchestrator";

test("workflow graph persists, unlocks dependencies, and finishes deterministically", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-workflows-"));
  try {
    const store = new WorkflowOrchestrator(directory);
    const draft = await store.create([
      { id: "research", botName: "Research", task: "Compare options" },
      { id: "review", botName: "UX", task: "Review findings", dependsOn: ["research"] }
    ]);
    const restarted = new WorkflowOrchestrator(directory);
    const { workflow, ready } = await restarted.start(draft.id);
    assert.equal(workflow.status, "running");
    assert.deepEqual(ready.map(task => task.id), ["research"]);
    await restarted.beginTask(draft.id, "research", "job-1");
    const next = await restarted.finishTask(draft.id, "research", true);
    assert.deepEqual(next.ready.map(task => task.id), ["review"]);
    await restarted.beginTask(draft.id, "review", "job-2");
    const completed = await restarted.finishTask(draft.id, "review", true);
    assert.equal(completed.workflow.status, "completed");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("workflow rejects cycles and retry requires explicit confirmation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-workflow-rules-"));
  try {
    const store = new WorkflowOrchestrator(directory);
    await assert.rejects(store.create([
      { id: "a", botName: "A", task: "a", dependsOn: ["b"] },
      { id: "b", botName: "B", task: "b", dependsOn: ["a"] }
    ]), /cycle/);
    const draft = await store.create([{ id: "a", botName: "A", task: "Retryable" }]);
    await store.start(draft.id);
    await store.beginTask(draft.id, "a", "job");
    await store.finishTask(draft.id, "a", false, "failed once");
    await assert.rejects(store.retryTask(draft.id, "a", false), /explicit confirmation/);
    const retry = await store.retryTask(draft.id, "a", true);
    assert.deepEqual(retry.ready.map(task => task.id), ["a"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a running workflow task is not automatically replayed after a server restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-workflow-recovery-"));
  try {
    const first = new WorkflowOrchestrator(directory);
    const draft = await first.create([{ id: "step", botName: "Bot", task: "May have had an external effect" }]);
    await first.start(draft.id);
    await first.beginTask(draft.id, "step", "job");
    const second = new WorkflowOrchestrator(directory);
    const recovered = await second.recoverInterrupted();
    assert.equal(recovered[0].tasks[0].status, "failed");
    assert.match(recovered[0].tasks[0].error!, /Review external effects/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
