import assert from "node:assert/strict";
import { it } from "node:test";
import { compactContext, contextCharacters, ContextBudgetExceeded, ContextMessage } from "./contextBudget";

it("bounds text-only histories while preserving task, recent rounds and tool pairs", () => {
  const messages: ContextMessage[] = [{ role: "system", content: "Follow approvals." }, { role: "user", content: "TASK: verify the report" }];
  for (let index = 0; index < 12; index++) {
    if (index) messages.push({ role: "user", content: `Observation ${index}: ` + "x".repeat(1000) });
    messages.push({ role: "assistant", tool_calls: [{ id: `call_${index}`, function: { name: "inspect_view", arguments: "{}" } }] });
    messages.push({ role: "tool", tool_call_id: `call_${index}`, content: "result " + "y".repeat(1000) });
  }
  const result = compactContext(messages, 5500, 2);
  assert.ok(result.removedMessages > 0);
  assert.ok(result.after <= 5500);
  assert.equal(messages[0].content, "Follow approvals.");
  assert.equal(messages[1].content, "TASK: verify the report");
  for (const message of messages) {
    if (message.role === "tool") assert.ok(messages.some(assistant =>
      Array.isArray(assistant.tool_calls) && assistant.tool_calls.some(call => call.id === message.tool_call_id)));
  }
  assert.ok(messages.some(message => message.tool_call_id === "call_11"));
  assert.ok(messages.some(message => message.tool_call_id === "call_10"));
});

it("uses a separate image budget and rejects oversized pinned context explicitly", () => {
  const images = [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/jpeg;base64," + "a".repeat(50000) } }] }];
  assert.ok(contextCharacters(images) < 200);
  assert.equal(compactContext(images, 500).removedMessages, 0);
  assert.throws(() => compactContext([{ role: "user", content: "x".repeat(1000) }], 100), ContextBudgetExceeded);
});
