import test from "node:test";
import assert from "node:assert/strict";
import { runActionScript } from "./scriptRunner";

test("runActionScript composes multiple tool calls, persists state, and supports final_answer", async () => {
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  const step1 = await runActionScript({
    code: `
      const first = await calculate({ expression: "6 * 7" });
      state.base = Number(first.data);
      console.log("computed base", state.base);
      return state.base;
    `,
    toolNames: ["calculate"],
    state: {},
    onToolCall: async (name, input) => {
      calls.push({ name, input });
      return { ok: true, message: "42", data: "42" };
    }
  });

  assert.equal(step1.ok, true, step1.error);
  assert.equal(step1.toolCallsExecuted, 1);
  assert.equal(step1.returned, "42");
  assert.equal(step1.state.base, 42);
  assert.ok(step1.logs.some((line) => line.includes("computed base 42")));

  const step2 = await runActionScript({
    code: `
      const next = await calculate({ expression: state.base + " + 8" });
      final_answer("Total is " + next.data);
    `,
    toolNames: ["calculate"],
    state: step1.state,
    onToolCall: async (name, input) => {
      calls.push({ name, input });
      return { ok: true, message: "50", data: "50" };
    }
  });

  assert.equal(step2.ok, true, step2.error);
  assert.equal(step2.finalAnswer, "Total is 50");
  assert.equal(calls.length, 2);
});

test("runActionScript blocks disallowed tools, dynamic eval, and excessive tool loops", async () => {
  const evalAttempt = await runActionScript({
    code: `return eval("1 + 1");`,
    toolNames: ["calculate"],
    onToolCall: async () => ({ ok: true, message: "ok" })
  });
  assert.equal(evalAttempt.ok, false);
  assert.match(evalAttempt.error ?? "", /Code generation from strings disallowed/i);

  let count = 0;
  const capped = await runActionScript({
    code: `
      const results = [];
      for (let i = 0; i < 6; i++) {
        const r = await calculate({ expression: String(i) });
        results.push(r.ok);
      }
      return results;
    `,
    toolNames: ["calculate"],
    maxToolCalls: 3,
    onToolCall: async () => {
      count += 1;
      return { ok: true, message: "ok" };
    }
  });
  assert.equal(capped.ok, true);
  assert.equal(count, 3, "only maxToolCalls RPCs reach the host dispatcher");
  assert.equal(capped.returned, "[true,true,true,false,false,false]");
});
