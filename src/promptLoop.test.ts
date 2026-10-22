import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentOrchestrator } from "./promptLoop";
import { BrowserController } from "./browserController";

function makeResponsesPayload(output: unknown[], id = "resp_test") {
  return {
    id,
    object: "response",
    created_at: 1,
    status: "completed",
    model: "gpt-6-luna",
    output,
    parallel_tool_calls: true,
    tool_choice: "auto",
    tools: [],
    usage: {
      input_tokens: 10,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 5,
      output_tokens_details: { reasoning_tokens: 2 },
      total_tokens: 15
    }
  };
}

test("GPT-6 Luna uses Responses API with reasoning enabled", { concurrency: false }, async () => {
  const requestBodies: Array<Record<string, any>> = [];
  const mockFetch: typeof fetch = async (_input, init) => {
    requestBodies.push(JSON.parse(String(init?.body)));
    const response = requestBodies.length === 1
      ? makeResponsesPayload([{
          id: "fc_item_1",
          type: "function_call",
          status: "completed",
          call_id: "call_1",
          name: "calculate",
          arguments: JSON.stringify({ expression: "(12 + 8) / 5" })
        }], "resp_first")
      : makeResponsesPayload([{
          id: "msg_test",
          type: "message",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: "I'll compare the constraints, assumptions, and options before recommending a path." }]
        }], "resp_final");
    return new Response(JSON.stringify(response), { status: 200, headers: { "content-type": "application/json" } });
  };

  const agent = new AgentOrchestrator({
    task: "Reason through the tradeoffs and recommend a good option.",
    model: "gpt-6-luna",
    apiKey: "test-key-not-a-secret",
    fetch: mockFetch,
    browser: {} as BrowserController,
    maxApiRetries: 1
  });
  const result = await agent.run();
  assert.equal(result.success, true, result.summary);
  assert.match(result.summary, /compare the constraints/);
  assert.equal(requestBodies.length, 2);
  assert.equal(requestBodies[0].model, "gpt-6-luna");
  assert.equal(requestBodies[0].reasoning.effort, "low");
  assert.match(requestBodies[0].instructions, /TOKEN DISCIPLINE/);
  assert.match(requestBodies[0].instructions, /FOLLOWER GROWTH PLAYBOOK|prefer tools over long explanations/i);
  assert.ok(Array.isArray(requestBodies[0].tools) && requestBodies[0].tools.length > 0);
  assert.equal(requestBodies[0].messages, undefined);
  assert.equal(requestBodies[1].previous_response_id, "resp_first");
  assert.ok(requestBodies[1].input.some((item: any) => item.type === "function_call_output" && item.call_id === "call_1"));
});

test("model errors are surfaced instead of silently becoming local heuristic answers", { concurrency: false }, async () => {
  const mockFetch: typeof fetch = async () => new Response(JSON.stringify({
    error: { message: "Invalid API key" }
  }), { status: 401, headers: { "content-type": "application/json" } });

  const agent = new AgentOrchestrator({
    task: "Explain what a good plan should consider.",
    model: "gpt-6-luna",
    apiKey: "test-key-not-a-secret",
    fetch: mockFetch,
    browser: {} as BrowserController,
    maxApiRetries: 1
  });
  const result = await agent.run();
  assert.equal(result.success, false);
  assert.equal(result.terminationReason, "llm_error");
  assert.match(result.summary, /401 Invalid API key/);
  assert.doesNotMatch(result.summary, /test-key/);
  assert.doesNotMatch(result.summary, /Local Research Results/);
});

test("daily scheduling tool creates a schedule and unattended tools are read-only", { concurrency: false }, async () => {
  const requestBodies: Array<Record<string, any>> = [];
  let scheduledInput: Record<string, unknown> | null = null;
  const mockFetch: typeof fetch = async (_input, init) => {
    requestBodies.push(JSON.parse(String(init?.body)));
    const response = requestBodies.length === 1
      ? makeResponsesPayload([{
          id: "fc_schedule",
          type: "function_call",
          status: "completed",
          call_id: "schedule_call",
          name: "schedule_task",
          arguments: JSON.stringify({ task: "Review recent public posts and prepare a report", scheduleType: "daily", localTime: "15:00", timeZone: "America/Los_Angeles", costApproved: true })
        }], "resp_schedule")
      : makeResponsesPayload([{
          id: "msg_schedule",
          type: "message",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: "Done — I set up the daily read-only review for 3:00 p.m. Pacific." }]
        }], "resp_done");
    return new Response(JSON.stringify(response), { status: 200, headers: { "content-type": "application/json" } });
  };
  const agent = new AgentOrchestrator({
    task: "Run this every day at 3pm Pacific.",
    model: "gpt-6-luna",
    apiKey: "test-key-not-a-secret",
    fetch: mockFetch,
    browser: {} as BrowserController,
    maxApiRetries: 1,
    allowPrivilegedTools: false,
    allowBrowserInteraction: false,
    scheduleTimeZone: "America/Los_Angeles",
    onScheduleTask: async (input) => {
      scheduledInput = input;
      return { ok: true, message: "Scheduled daily at 15:00 America/Los_Angeles." };
    }
  });
  const result = await agent.run();
  assert.equal(result.success, true, result.summary);
  assert.equal((scheduledInput as Record<string, unknown> | null)?.scheduleType, "daily");
  assert.match(requestBodies[0].instructions, /schedule_task for one-time\/daily jobs/);
  assert.match(requestBodies[0].instructions, /America\/Los_Angeles/);
  assert.match(requestBodies[0].instructions, /TOKEN DISCIPLINE/);
  const functionNames = requestBodies[0].tools.map((tool: any) => tool.name || tool.function?.name);
  assert.ok(functionNames.includes("schedule_task"));
  assert.ok(!functionNames.includes("click_element"));
  assert.ok(!functionNames.includes("type_text"));
  assert.ok(!functionNames.includes("run_terminal_command"));
  assert.ok(!functionNames.includes("create_document"));
  assert.ok(!functionNames.includes("generate_image"));
});
