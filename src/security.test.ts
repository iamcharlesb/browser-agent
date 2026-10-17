import assert from "node:assert/strict";
import test from "node:test";
import { assessTaskRisk } from "./security";

const approval = "external_side_effect";

test("harmless YouTube learning requests do not prompt for approval", () => {
  const task = "Continue as YouTube Concept Learner (understand videos like Codex). What can I learn and apply from this video?";
  assert.deepEqual(assessTaskRisk(task).approvalsRequired, []);
});

test("an analogy using like does not look like a social action", () => {
  assert.deepEqual(assessTaskRisk("Explain this workflow like ChatGPT does." ).approvalsRequired, []);
});

test("writing code comments does not look like publishing a social comment", () => {
  assert.deepEqual(assessTaskRisk("Add comments to explain this function." ).approvalsRequired, []);
});

test("analyzing a social post does not look like publishing one", () => {
  assert.deepEqual(assessTaskRisk("Analyze this post and summarize its main idea." ).approvalsRequired, []);
});

test("following a set of steps does not look like following an account", () => {
  assert.deepEqual(assessTaskRisk("Follow these steps to install the package." ).approvalsRequired, []);
});

test("liking a named social post requires approval", () => {
  assert.deepEqual(assessTaskRisk("Please like this post on Instagram." ).approvalsRequired, [approval]);
});

test("reacting to a video requires approval", () => {
  assert.deepEqual(assessTaskRisk("React to the video on my account." ).approvalsRequired, [approval]);
});

test("following an account requires approval", () => {
  assert.deepEqual(assessTaskRisk("Follow @example on Instagram." ).approvalsRequired, [approval]);
});

test("posting content requires approval", () => {
  assert.deepEqual(assessTaskRisk("Publish this announcement to LinkedIn." ).approvalsRequired, [approval]);
});

test("sending a direct message requires approval", () => {
  assert.deepEqual(assessTaskRisk("Send a DM to the creator." ).approvalsRequired, [approval]);
});

test("deleting content requires approval", () => {
  assert.deepEqual(assessTaskRisk("Delete the old campaign post." ).approvalsRequired, [approval]);
});

test("purchases require financial approval", () => {
  assert.deepEqual(assessTaskRisk("Buy the annual plan." ).approvalsRequired, ["financial_transaction"]);
});

test("publishing secrets is blocked, not merely approval-gated", () => {
  const result = assessTaskRisk("Post my API key publicly on GitHub.");
  assert.equal(result.blocked, true);
  assert.deepEqual(result.approvalsRequired, []);
});
