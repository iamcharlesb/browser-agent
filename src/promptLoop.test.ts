import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentOrchestrator, extractArithmeticExpression } from "./promptLoop";
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
  assert.match(requestBodies[0].instructions, /PLAN FIRST ON COMPLEX ASKS/);
  assert.match(requestBodies[0].instructions, /FOLLOWER GROWTH PLAYBOOK|proactive marketing specialist/i);
  assert.match(requestBodies[0].instructions, /REDDIT \/ COMMUNITY GROWTH PLAYBOOK|never naive spam|karma-build/i);
  assert.match(requestBodies[0].instructions, /SEO \/ AI VISIBILITY PLAYBOOK|GEO \/ AEO|never invent private/i);
  assert.match(requestBodies[0].instructions, /UX \/ PRODUCT DESIGN PLAYBOOK|heuristic scan|never invent user/i);
  assert.match(requestBodies[0].instructions, /LINKEDIN \/ B2B OUTREACH PLAYBOOK|weekly invite caps|never bulk-connect/i);
  assert.match(requestBodies[0].instructions, /COLD EMAIL \/ SEQUENCE PLATFORM PLAYBOOK|SPF\/DKIM\/DMARC|mail cannot be unsent/i);
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

test("shouldAbort stops the loop instead of letting it keep calling the model", { concurrency: false }, async () => {
  let modelCalls = 0;
  let aborted = false;
  // Always answers with another tool call, so only the abort check can end this run.
  const mockFetch: typeof fetch = async () => {
    modelCalls += 1;
    const payload = makeResponsesPayload(
      [
        {
          id: `fc_item_${modelCalls}`,
          type: "function_call",
          status: "completed",
          call_id: `call_${modelCalls}`,
          name: "calculate",
          arguments: JSON.stringify({ expression: "1 + 1" })
        }
      ],
      `resp_${modelCalls}`
    );
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  };

  const agent = new AgentOrchestrator({
    task: "Keep calculating until you are told to stop.",
    model: "gpt-6-luna",
    apiKey: "test-key-not-a-secret",
    fetch: mockFetch,
    browser: {} as BrowserController,
    maxApiRetries: 1,
    // Stand in for the user pressing Stop after the first model turn.
    shouldAbort: () => {
      if (modelCalls >= 1) aborted = true;
      return aborted;
    }
  });

  const result = await agent.run();
  assert.equal(result.success, false);
  assert.equal(result.terminationReason, "stopped");
  assert.match(result.summary, /Stopped before finishing/);
  assert.equal(modelCalls, 1, "the loop must not call the model again after Stop");
});

test("a run that is never aborted is unaffected by the abort hook", { concurrency: false }, async () => {
  const mockFetch: typeof fetch = async () =>
    new Response(
      JSON.stringify(
        makeResponsesPayload([
          {
            id: "msg_ok",
            type: "message",
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", text: "Your follower count is 1,204." }]
          }
        ])
      ),
      { status: 200, headers: { "content-type": "application/json" } }
    );

  const agent = new AgentOrchestrator({
    task: "Tell me the follower count.",
    model: "gpt-6-luna",
    apiKey: "test-key-not-a-secret",
    fetch: mockFetch,
    browser: {} as BrowserController,
    maxApiRetries: 1,
    shouldAbort: () => false
  });

  const result = await agent.run();
  assert.equal(result.success, true, result.summary);
  assert.equal(result.terminationReason, "direct_reply");
});

test("a throwing shouldAbort hook does not kill the run", { concurrency: false }, async () => {
  const mockFetch: typeof fetch = async () =>
    new Response(
      JSON.stringify(
        makeResponsesPayload([
          {
            id: "msg_ok",
            type: "message",
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", text: "Done." }]
          }
        ])
      ),
      { status: 200, headers: { "content-type": "application/json" } }
    );

  const agent = new AgentOrchestrator({
    task: "Say done.",
    model: "gpt-6-luna",
    apiKey: "test-key-not-a-secret",
    fetch: mockFetch,
    browser: {} as BrowserController,
    maxApiRetries: 1,
    shouldAbort: () => {
      throw new Error("hook is broken");
    }
  });

  const result = await agent.run();
  assert.equal(result.success, true, result.summary);
});

test("arithmetic is recognised, research questions are not", () => {
  // Found by learn mode: "calculate 2 + 2" fell through to web_search and came back with film
  // trivia, because the local engine had no calculator route at all.
  for (const [request, expected] of [
    ["calculate 2 + 2", "2 + 2"],
    ["calculate 2 + 2 and tell me the answer", "2 + 2"],
    ["What is 17 * 3?", "17 * 3"],
    ["compute (12 + 8) / 5", "(12 + 8) / 5"],
    ["please can you evaluate 100 - 42.5", "100 - 42.5"],
    ["1,250 * 0.15", "1,250 * 0.15"]
  ] as Array<[string, string]>) {
    assert.equal(extractArithmeticExpression(request), expected, request);
  }

  // Anything with words left over is a question for a real tool, not the calculator.
  for (const request of [
    "what is the revenue for Q2 2024",
    "calculate how many followers I gained",
    "what is my follower count",
    "42",
    "check my profile",
    "compute the engagement rate for my last 9 posts"
  ]) {
    assert.equal(extractArithmeticExpression(request), null, request);
  }
});

test("standing approval changes the prompt from 'always ask' to 'go do it'", { concurrency: false }, async () => {
  // The complaint this fixes: the user turned on "Approve for me", said yes in chat, and the bot
  // kept asking anyway - because the approval never reached the system prompt.
  const capture = async (standingApproval: boolean): Promise<string> => {
    let instructions = "";
    const mockFetch: typeof fetch = async (_input, init) => {
      instructions = JSON.parse(String(init?.body)).instructions;
      return new Response(
        JSON.stringify(
          makeResponsesPayload([
            {
              id: "msg_ok",
              type: "message",
              status: "completed",
              role: "assistant",
              content: [{ type: "output_text", text: "Done." }]
            }
          ])
        ),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    };
    await new AgentOrchestrator({
      task: "grow my instagram followers",
      model: "gpt-6-luna",
      apiKey: "test-key-not-a-secret",
      fetch: mockFetch,
      browser: {} as BrowserController,
      maxApiRetries: 1,
      standingApproval
    }).run();
    return instructions;
  };

  const asking = await capture(false);
  assert.match(asking, /has NOT granted standing approval/);
  assert.match(asking, /Stop for approval before follows\/likes\/comments/);
  assert.match(asking, /Never follow\/like\/comment\/message until they approve/);
  // It should point at the real control rather than taking a chat "yes" as blanket approval.
  assert.match(asking, /turn on 'Approve for me' in the composer/);
  assert.match(asking, /Never claim standing approval you weren't given/);

  const approved = await capture(true);
  assert.match(approved, /STANDING APPROVAL/);
  assert.match(approved, /Do NOT re-ask for what is already approved/);
  assert.match(approved, /EXECUTE the paced batch/);
  assert.doesNotMatch(approved, /Stop for approval before follows\/likes\/comments/);
  assert.doesNotMatch(approved, /Never follow\/like\/comment\/message until they approve/);

  // The limits that must survive a blanket yes.
  assert.match(approved, /publishing new posts\/content, direct messages, payments/);
  assert.match(approved, /Scheduled\/unattended runs are still research-and-draft only/);
  assert.match(approved, /paced batches/);
});
