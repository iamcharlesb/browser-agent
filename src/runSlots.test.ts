import assert from "node:assert/strict";
import { test } from "node:test";
import { RunSlots } from "./runSlots";

test("only runs that really use the browser reserve it; text work runs side by side", () => {
  const slots = new RunSlots(4);
  slots.acquire("a", { botName: "Website Designer", interactionMode: "turbo", browser: false });
  assert.equal(slots.canStart({ botName: "Principal Fullstack", interactionMode: "turbo", browser: false }), true);
  slots.acquire("b", { botName: "Principal Fullstack", interactionMode: "turbo", browser: false });
  slots.acquire("c", { botName: "Researcher", interactionMode: "turbo", browser: true });
  assert.equal(slots.browserRunId, "c");
  assert.equal(slots.canStart({ botName: "Scout", interactionMode: "turbo", browser: true }), false);
  assert.equal(slots.canStart({ botName: "Scout", interactionMode: "turbo", browser: false }), true);
});

test("a consulted specialist is never blocked by the coordinator that is waiting on it", () => {
  const slots = new RunSlots(4);
  slots.acquire("coordinator", { botName: "Product Marketing", interactionMode: "turbo", browser: true });
  assert.equal(slots.canStart({ botName: "Competitor Intelligence", interactionMode: "turbo", browser: false }), true);
  assert.equal(slots.canStart({ botName: "Product Marketing", browser: false }), false, "one run per bot still holds");
});

test("without an override the interaction mode keeps its old meaning", () => {
  const slots = new RunSlots(2);
  assert.equal(slots.resource({ botName: "x", interactionMode: "chat" }).browser, false);
  assert.equal(slots.resource({ botName: "x", interactionMode: "act" }).browser, true);
  assert.equal(slots.resource({ botName: "x" }).browser, true);
});

test("a reservation that is reused must match its owner", () => {
  const slots = new RunSlots(2);
  slots.acquire("r", { botName: "x", browser: false });
  slots.acquire("r", { botName: "x", browser: false });
  assert.throws(() => slots.acquire("r", { botName: "x", browser: true }), /does not match/);
});
