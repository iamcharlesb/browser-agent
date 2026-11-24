import test from "node:test";
import assert from "node:assert/strict";
import { runActionScript } from "./scriptRunner";

test("action scripts fail closed without executing code or dispatching tools", async () => {
  let dispatched = 0;
  for (const code of [
    'return Object.constructor("return process")()',
    'return console.log.constructor("return process")()',
    'await calculate({ expression: "1+1" }); final_answer("forged")',
    'state.changed = true; while (true) {}'
  ]) {
    const result = await runActionScript({ code, toolNames: ["calculate"], state: { retained: true },
      onToolCall: async () => { dispatched++; return { ok: true, message: "unexpected" }; } });
    assert.equal(result.ok, false);
    assert.match(result.error!, /disabled/);
    assert.equal(result.toolCallsExecuted, 0);
    assert.equal(result.finalAnswer, undefined);
    assert.deepEqual(result.state, { retained: true });
  }
  assert.equal(dispatched, 0);
});
