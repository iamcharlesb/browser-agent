import assert from "node:assert/strict";
import { test } from "node:test";
import { userRequestsDirectAnswer } from "./handoffPolicy";

test("anti-handoff and status-read phrasing suppress delegation", () => {
  for (const task of [
    "not asking you to hand offf anything instead asing get all the goals that were already assigned",
    "don't hand off — just tell me the goals",
    "what's the plan for reddit bot?",
    "how many subreddits?",
    "get all the goals from all the bots",
    "just list the goals",
    "I did not ask you to hand this to another bot"
  ]) {
    assert.equal(userRequestsDirectAnswer(task), true, task);
  }
});

test("ordinary coordination requests still allow handoff", () => {
  for (const task of [
    "Ask Reddit Community Growth for a status report",
    "Coordinate with SEO Specialist on the draft",
    "work with all the bots on the organic plan"
  ]) {
    assert.equal(userRequestsDirectAnswer(task), false, task);
  }
});
