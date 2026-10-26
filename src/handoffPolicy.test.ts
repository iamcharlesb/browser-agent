import test from "node:test";
import assert from "node:assert/strict";
import { userRequestsDirectAnswer } from "./handoffPolicy";

test("a correction that asks for the answer directly disables optional delegation", () => {
  assert.equal(userRequestsDirectAnswer("I know all those things man, my question is why we are not getting clicks."), true);
  assert.equal(userRequestsDirectAnswer("Better you tell me."), true);
  assert.equal(userRequestsDirectAnswer("Stop handing this to the SEO bot and give me your best answer."), true);
});

test("ordinary specialist questions and explicit requests to consult remain delegable", () => {
  assert.equal(userRequestsDirectAnswer("Check why this page is not getting clicks."), false);
  assert.equal(userRequestsDirectAnswer("Ask the SEO specialist to review this page."), false);
});
