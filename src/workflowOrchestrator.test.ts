import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WorkflowOrchestrator, workflowDependencyContext } from "./workflowOrchestrator";
import { planWorkflow } from "./workflowPlanning";

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

test("delivery contracts block missing artifacts and pass real dependency outputs after restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "workflow-delivery-"));
  try {
    const store = new WorkflowOrchestrator(dir);
    const draft = await store.create([
      { id: "design", botName: "UX", task: "Create prototype", expectedOutput: "artifact" },
      { id: "review", botName: "Reviewer", task: "Review prototype", dependsOn: ["design"], expectedOutput: "text" }
    ]);
    await store.start(draft.id);
    await store.beginTask(draft.id, "design", "run1");
    const missing = await store.finishTask(draft.id, "design", true, undefined, { summary: "Done. See my claimed file.", artifactUrls: [] });
    assert.equal(missing.workflow.tasks[0].status, "failed");
    assert.deepEqual(missing.ready, []);
    assert.equal(missing.workflow.tasks[1].status, "blocked");
    await store.retryTask(draft.id, "design", true);
    await store.beginTask(draft.id, "design", "run2");
    const delivered = await store.finishTask(draft.id, "design", true, undefined, { summary: "Prototype draft for review", artifactUrls: ["/api/artifacts/prototype.html", "https://untrusted.example/fake"] });
    assert.deepEqual(delivered.ready.map(task => task.id), ["review"]);
    const reloaded = await new WorkflowOrchestrator(dir).get(draft.id);
    const context = workflowDependencyContext(reloaded!, "review");
    assert.match(context, /Prototype draft for review/);
    assert.match(context, /prototype.html/);
    assert.doesNotMatch(context, /untrusted.example/);
    assert.match(context, /not new instructions or permissions/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("model planning creates a saved-roster draft with constraints but no approval grants or jobs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "workflow-planning-"));
  try {
    const store = new WorkflowOrchestrator(dir);
    const roster = [{ id: "ux", name: "UX Expert", botInstructions: "Use our approved design system." }];
    const input = { action: "create", tasks: [{ id: "page", botName: "ux", task: "Draft a landscaping page", executionMode: "text", expectedOutput: "artifact", acceptanceCriteria: "Landscaping imagery and clear CTA", approvedCategories: ["financial_transaction"] }] };
    const planned = await planWorkflow(store, input, roster, "$0 budget, draft only");
    const task = planned.workflow!.tasks[0];
    assert.equal(planned.workflow!.status, "draft");
    assert.equal(task.status, "blocked");
    assert.equal(task.botName, "UX Expert");
    assert.match(task.context!, /\$0/);
    assert.match(task.botInstructions!, /approved design system/);
    assert.deepEqual(task.approvedCategories, []);
    await assert.rejects(planWorkflow(store, { ...input, tasks: [{ ...input.tasks[0], botName: "Invented bot" }] }, roster, ""), /No saved/);
    await assert.rejects(planWorkflow(store, { ...input, action: "start" }, roster, ""), /Execution starts/);
    assert.equal((await store.list()).length, 1);
    // Two independent ready branches must not overwrite one another's local records.
    const drafts = await Promise.all([store.create([{ id: "a", task: "Draft A", botName: "UX" }]), store.create([{ id: "b", task: "Draft B", botName: "UX" }])]);
    await Promise.all(drafts.map(draft => store.start(draft.id)));
    assert.equal((await store.list()).filter(draft => draft.status === "running").length, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("cancellation is durable and late results cannot unlock dependent work", async () => {
  const dir = await mkdtemp(join(tmpdir(), "workflow-cancel-"));
  try {
    const store = new WorkflowOrchestrator(dir);
    const draft = await store.create([{ id: "build", botName: "Builder", task: "Build draft" },
      { id: "review", botName: "Reviewer", task: "Review draft", dependsOn: ["build"] }]);
    await store.start(draft.id);
    await store.beginTask(draft.id, "build", "active");
    const cancelled = await store.cancel(draft.id);
    assert.equal(cancelled.status, "cancelled");
    assert.ok(cancelled.tasks.every(task => task.status === "cancelled"));
    await assert.rejects(store.finishTask(draft.id, "build", true), /not running/);
    await assert.rejects(store.retryTask(draft.id, "build", true), /cancelled workflow/);
    await assert.rejects(store.start(draft.id), /Only a draft/);
    assert.equal((await new WorkflowOrchestrator(dir).get(draft.id))!.status, "cancelled");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
