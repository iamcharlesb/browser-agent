import assert from "node:assert/strict";
import { it } from "node:test";
const { createInputQueue, createFramePresenter } = require("../static/browserRuntime.js");

it("serializes input and merges adjacent scrolls without crossing click/key barriers", async () => {
  const sent: any[] = [];
  let release!: () => void;
  let complete!: () => void;
  const completed = new Promise<void>(resolve => { complete = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const enqueue = createInputQueue(async (input: any) => {
    sent.push(input);
    if (sent.length === 1) await blocked;
    if (input.type === "key") complete();
  }, (error: Error) => { throw error; });
  enqueue({ type: "click", x: 1, y: 2 });
  await new Promise(resolve => setTimeout(resolve, 10));
  enqueue({ type: "scroll", x: 1, y: 2, deltaX: 0, deltaY: 3 });
  enqueue({ type: "scroll", x: 4, y: 5, deltaX: 2, deltaY: 6 });
  enqueue({ type: "type", text: "a" });
  enqueue({ type: "type", text: "b" });
  enqueue({ type: "key", key: "Enter" });
  assert.equal(sent.length, 1);
  release();
  await completed;
  assert.deepEqual(sent, [
    { type: "click", x: 1, y: 2 },
    { type: "scroll", x: 4, y: 5, deltaX: 2, deltaY: 9 },
    { type: "type", text: "ab" },
    { type: "key", key: "Enter" }
  ]);
});

it("continues the input queue after an action fails", async () => {
  const errors: string[] = [];
  let complete!: () => void;
  const completed = new Promise<void>(resolve => { complete = resolve; });
  const enqueue = createInputQueue(async (input: any) => {
    if (input.type === "click") throw new Error("closed tab");
    complete();
  }, (error: Error) => errors.push(error.message));
  enqueue({ type: "click" });
  enqueue({ type: "navigate", url: "https://example.com" });
  await completed;
  assert.deepEqual(errors, ["closed tab"]);
});

it("presents only the newest frame per paint and cancels pending work", () => {
  let paint!: () => void;
  const shown: string[] = [];
  let scheduled = 0;
  let cancelled = 0;
  const presenter = createFramePresenter((frame: string) => shown.push(frame), (callback: () => void) => {
    scheduled++;
    paint = callback;
    return scheduled;
  }, () => { cancelled++; });
  presenter.push("old");
  presenter.push("new");
  assert.equal(scheduled, 1);
  paint();
  assert.deepEqual(shown, ["new"]);
  presenter.push("stale");
  presenter.clear();
  assert.equal(cancelled, 1);
});
