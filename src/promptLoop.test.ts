import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AgentOrchestrator,
  AgentOrchestratorOptions,
  detectPrematureFail,
  extractArithmeticExpression,
  requiresInitialBrowserState
} from "./promptLoop";
import { classifyBrowserAction } from "./actionEffect";
import { BrowserController, PageState } from "./browserController";
import { WORKSPACE_ROOT } from "./agentTools";

test("a blocked page ends the run without asking the user to solve a nonexistent CAPTCHA", async () => {
  const state: PageState = {
    url: "https://medium.com/", title: "Attention Required! | Cloudflare", screenshotB64: "",
    elements: [], pageText: "Sorry, you have been blocked", stateHash: "blocked", capturedAt: 0,
    accessDenied: true, requiresHumanVerification: false
  };
  let verificationRequests = 0;
  const browser = {
    isStarted: true,
    sessionMode: "persistent",
    currentUrl: () => state.url,
    captureState: async () => state
  } as unknown as BrowserController;
  const agent = new AgentOrchestrator({
    task: "Sign in on this page", browser, model: "gpt-6-luna", apiKey: "test-key",
    onHumanVerification: () => { verificationRequests++; },
    fetch: async () => { throw new Error("A denied page should stop before calling a model"); }
  });
  const result = await agent.run();
  assert.equal(result.success, false);
  assert.equal(result.terminationReason, "access_denied");
  assert.equal(verificationRequests, 0);
});

test("shell approval is reused only when explicitly granted for this task", async () => {
  const run = async (decision: boolean | { approved: boolean; scope: "task" }, standingApproval = false) => {
    let requests = 0;
    let prompts = 0;
    const events: Array<Record<string, unknown>> = [];
    const fetch: typeof globalThis.fetch = async () => {
      requests++;
      const output = requests < 3
        ? [{ type: "function_call", call_id: `call_${requests}`, name: "run_terminal_command", arguments: JSON.stringify({ command: `printf approval_${requests}` }) }]
        : [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Checked both commands." }] }];
      return new Response(JSON.stringify(makeResponsesPayload(output, `resp_${requests}`)), { headers: { "content-type": "application/json" } });
    };
    const agent = new AgentOrchestrator({
      task: "Use terminal tools to check two shell commands.", model: "gpt-6-luna", apiKey: "test-key",
      browser: {} as BrowserController, fetch, standingApproval,
      onEvent: event => events.push(event),
      onTerminalApproval: () => { prompts++; return decision; }
    });
    assert.equal((await agent.run()).success, true);
    return { prompts, events };
  };
  assert.equal((await run(true)).prompts, 2);
  const scoped = await run({ approved: true, scope: "task" });
  assert.equal(scoped.prompts, 1);
  const required = scoped.events.find(event => event.type === "privileged_approval_required")!;
  const resolved = scoped.events.find(event => event.type === "privileged_approval_resolved")!;
  assert.equal(typeof required.approvalId, "string");
  assert.equal(required.approvalId, resolved.approvalId);
  assert.equal((await run({ approved: false, scope: "task" })).prompts, 2);
  const automatic = await run(true, true);
  assert.equal(automatic.prompts, 0);
  assert.equal(automatic.events.some(event => event.type === "privileged_approval_required"), false);
});

test("direct shell paths share the same inspection, denial and unattended policy", async () => {
  for (const model of ["local-engine", "gpt-6-luna"]) {
    const options: AgentOrchestratorOptions = {
      task: "$ pwd", model, apiKey: "test-key", browser: {} as BrowserController,
      onTerminalApproval: () => { throw new Error("Read-only inspection must not ask"); }
    };
    const inspected = await new AgentOrchestrator(options).run();
    assert.equal(inspected.success, true);
    assert.ok(inspected.summary.includes(WORKSPACE_ROOT), inspected.summary);
    const denied = await new AgentOrchestrator({ ...options, task: "$ printf must_not_run", onTerminalApproval: () => false }).run();
    assert.equal(denied.success, false);
    assert.match(denied.summary, /not approved/);
    // The local fallback must not regain shell access that scheduled runs explicitly disable.
    if (model === "local-engine") {
      const unattended = await new AgentOrchestrator({ ...options, allowPrivilegedTools: false, standingApproval: true }).run();
      assert.equal(unattended.success, false);
      assert.match(unattended.summary, /not approved/);
    }
  }
});

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
  assert.ok(requestBodies[0].max_output_tokens >= 4096, "Article tool arguments must fit without truncation");
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
  assert.match(approved, /ask once only if the user has not already explicitly authorized/);
  assert.match(approved, /Scheduled\/unattended runs are still research-and-draft only/);
  assert.match(approved, /paced batches/);
});

test("the effect gate stops an outward click no task-text rule anticipated", { concurrency: false }, async () => {
  // A platform this codebase has never heard of, so no regex in security.ts can save us here.
  const state: PageState = {
    url: "https://some-new-social-app.example/u/dana", title: "Dana", screenshotB64: "",
    elements: [
      { markId: 1, tag: "button", role: "button", elementType: "button", text: "Send connection request", x: 10, y: 20, width: 100, height: 30 },
      { markId: 2, tag: "a", role: "link", elementType: "link", text: "Followers", x: 10, y: 60, width: 100, height: 30 },
      { markId: 3, tag: "button", role: "button", elementType: "button", text: "Delete account", x: 10, y: 90, width: 100, height: 30 }
    ],
    pageText: "Dana's profile", stateHash: "profile", capturedAt: 0,
    accessDenied: false, requiresHumanVerification: false
  };

  const run = async (opts: { standingApproval?: boolean; approve?: boolean; markId?: number; declared?: string }) => {
    const asked: string[] = [];
    let clicks = 0;
    let requests = 0;
    const browser = {
      isStarted: true,
      start: async () => {},
      currentUrl: () => state.url,
      captureState: async () => state,
      getElementByMark: (markId: number) => state.elements.find((el) => el.markId === markId),
      clickMark: async (markId: number) => { clicks++; return state.elements.find((el) => el.markId === markId)!; }
    } as unknown as BrowserController;
    const fetch: typeof globalThis.fetch = async () => {
      requests++;
      const output = requests === 1
        ? [{ type: "function_call", call_id: "call_1", name: "click_mark",
             arguments: JSON.stringify({ markId: opts.markId ?? 1, ...(opts.declared ? { effect: opts.declared } : {}) }) }]
        : [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] }];
      return new Response(JSON.stringify(makeResponsesPayload(output, `resp_${requests}`)), { headers: { "content-type": "application/json" } });
    };
    await new AgentOrchestrator({
      task: "Open Dana's profile on this site", model: "gpt-6-luna", apiKey: "test-key",
      browser, fetch, standingApproval: opts.standingApproval ?? false,
      onTerminalApproval: ({ description }) => { asked.push(description); return opts.approve ?? false; }
    }).run();
    return { asked, clicks };
  };

  const denied = await run({ approve: false });
  assert.equal(denied.asked.length, 1, "an outward click must be asked about");
  assert.match(denied.asked[0], /Send connection request/, "the question names the real button");
  assert.equal(denied.clicks, 0, "denial actually blocks the click");

  const approved = await run({ approve: true });
  assert.equal(approved.clicks, 1, "approval lets it through");

  const standing = await run({ standingApproval: true });
  assert.equal(standing.asked.length, 0, "'Approve for me' is what stops the re-asking");
  assert.equal(standing.clicks, 1);

  const navigating = await run({ markId: 2, approve: false });
  assert.equal(navigating.asked.length, 0, "clicking a Followers link is reading, not acting");
  assert.equal(navigating.clicks, 1);

  const lying = await run({ markId: 1, declared: "read", approve: false });
  assert.equal(lying.asked.length, 1, "a false 'read' declaration cannot unlock an outward button");
  assert.equal(lying.clicks, 0);

  // The line that matters most: approving engagement is not consent to destroy the account.
  const destructive = await run({ markId: 3, standingApproval: true, approve: false });
  assert.equal(destructive.asked.length, 1, "standing approval must never cover an irreversible click");
  assert.equal(destructive.clicks, 0);
});


test("Responses returns an output for every call in batches larger than four", async () => {
  const bodies: any[] = [];
  const mockFetch: typeof fetch = async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    const output = bodies.length === 1
      ? Array.from({length: 6}, (_, i) => ({id: "fc_" + i, type: "function_call", status: "completed", call_id: "call_" + i, name: "calculate", arguments: JSON.stringify({expression: "2+2"})}))
      : [{id: "msg_done", type: "message", status: "completed", role: "assistant", content: [{type: "output_text", text: "All six calculations finished."}]}];
    return new Response(JSON.stringify(makeResponsesPayload(output, "resp_" + bodies.length)), {status: 200, headers: {"content-type": "application/json"}});
  };
  const agent = new AgentOrchestrator({task: "Calculate six values.", model: "gpt-6-luna", apiKey: "test-key", fetch: mockFetch, browser: {} as BrowserController, maxApiRetries: 1});
  const result = await agent.run();
  assert.equal(result.success, true, result.summary);
  assert.deepEqual(bodies[1].input.filter((item: any) => item.type === "function_call_output").map((item: any) => item.call_id), Array.from({length: 6}, (_, i) => "call_" + i));
});


test("truncated completion arguments cannot produce a false task-completed result", async () => {
  const bodies: any[] = [];
  const mockFetch: typeof fetch = async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    const output = bodies.length === 1
      ? [{id:"fc_bad",type:"function_call",status:"completed",call_id:"call_bad",name:"finish",arguments:'{"summary":"cut off'}]
      : [{id:"msg_done",type:"message",status:"completed",role:"assistant",content:[{type:"output_text",text:"The previous tool input was incomplete; no completion was recorded."}]}];
    return new Response(JSON.stringify(makeResponsesPayload(output, "resp_bad_" + bodies.length)), {status:200,headers:{"content-type":"application/json"}});
  };
  const agent = new AgentOrchestrator({task:"Prepare an article.",model:"gpt-6-luna",apiKey:"test-key",fetch:mockFetch,browser:{} as BrowserController,maxApiRetries:1});
  const result = await agent.run();
  assert.match(result.summary, /no completion was recorded/);
  assert.ok(bodies[1].input.some((item:any) => item.call_id === "call_bad" && /No action was taken/.test(item.output)));
});

test("premature finish_task admitting blank/unsaved editor is rejected so the agent completes the save", async () => {
  const bodies: any[] = [];
  const mockFetch: typeof fetch = async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    if (bodies.length === 1) {
      return new Response(
        JSON.stringify(
          makeResponsesPayload(
            [
              {
                id: "fc_premature",
                type: "function_call",
                status: "completed",
                call_id: "call_premature",
                name: "finish_task",
                arguments: JSON.stringify({
                  summary:
                    "I'm back in the MagicSite editor and have generated the article's hero image. I haven't saved or published anything yet—the editor is still blank."
                })
              }
            ],
            "resp_1"
          )
        ),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return new Response(
      JSON.stringify(
        makeResponsesPayload(
          [
            {
              id: "fc_done",
              type: "function_call",
              status: "completed",
              call_id: "call_done",
              name: "finish_task",
              arguments: JSON.stringify({
                summary: "Filled the title, tags, and content in the MagicSite editor and saved the draft."
              })
            }
          ],
          "resp_2"
        )
      ),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };

  const agent = new AgentOrchestrator({
    task: "Write and save article 1 in MagicSite.",
    model: "gpt-6-luna",
    apiKey: "test-key",
    fetch: mockFetch,
    browser: {} as BrowserController,
    maxApiRetries: 1
  });
  const result = await agent.run();
  assert.equal(result.success, true);
  assert.match(result.summary, /saved the draft/);
  assert.equal(bodies.length, 2, "must reject the premature finish and force a second turn");
  assert.ok(
    bodies[1].input.some(
      (item: any) => item.call_id === "call_premature" && /Premature finish_task rejected/.test(item.output)
    )
  );
});

test("AgentOrchestrator executes run_action_script and completes when final_answer is called", async () => {
  const mockFetch: typeof fetch = async () => {
    return new Response(
      JSON.stringify(
        makeResponsesPayload(
          [
            {
              id: "fc_script",
              type: "function_call",
              status: "completed",
              call_id: "call_script",
              name: "run_action_script",
              arguments: JSON.stringify({
                code: `
                  const a = await calculate({ expression: "10 + 15" });
                  const b = await calculate({ expression: "25 * 2" });
                  final_answer("Combined script result: " + a.message + " and " + b.message);
                `
              })
            }
          ],
          "resp_script_1"
        )
      ),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };

  const agent = new AgentOrchestrator({
    task: "Run two calculations in one script.",
    model: "gpt-6-luna",
    apiKey: "test-key",
    fetch: mockFetch,
    browser: {} as BrowserController,
    maxApiRetries: 1
  });
  const result = await agent.run();
  assert.equal(result.success, true);
  assert.match(result.summary, /Combined script result:.*25.*50/);
});

test("interactionMode turbo auto-runs outward browser actions without prompting", async () => {
  const asked: string[] = [];
  let clicks = 0;
  const pageState: PageState = {
    url: "https://example.test/editor",
    title: "Editor",
    pageText: "Editor",
    screenshotB64: "",
    stateHash: "h1",
    capturedAt: 0,
    accessDenied: false,
    requiresHumanVerification: false,
    elements: [
      {
        markId: 1,
        tag: "button",
        role: "button",
        elementType: "button",
        text: "Publish article",
        x: 10,
        y: 10,
        width: 80,
        height: 24
      }
    ]
  };
  const browser = {
    sessionMode: "persistent",
    isStarted: true,
    currentUrl: () => pageState.url,
    start: async () => {},
    captureState: async () => pageState,
    getElementByMark: (id: number) => pageState.elements.find((el) => el.markId === id),
    clickMark: async (id: number) => {
      clicks += 1;
      return pageState.elements.find((el) => el.markId === id)!;
    }
  } as unknown as BrowserController;

  let requests = 0;
  const mockFetch: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    assert.match(body.instructions, /TURBO APPROVAL/);
    assert.match(body.instructions, /requested uploads, saves, and publication/);
    assert.doesNotMatch(body.instructions, /Still stop and ask, every time/);
    assert.ok(body.tools.some((tool: any) => tool.name === "upload_file"));
    requests += 1;
    const output =
      requests === 1
        ? [
            {
              type: "function_call",
              call_id: "call_pub",
              name: "click_mark",
              arguments: JSON.stringify({ markId: 1, effect: "outward" })
            }
          ]
        : [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Published." }] }];
    return new Response(JSON.stringify(makeResponsesPayload(output, `resp_turbo_${requests}`)), {
      headers: { "content-type": "application/json" }
    });
  };

  await new AgentOrchestrator({
    task: "Publish the article on this page",
    model: "gpt-6-luna",
    apiKey: "test-key",
    browser,
    fetch: mockFetch,
    interactionMode: "turbo",
    onTerminalApproval: ({ description }) => {
      asked.push(description);
      return false;
    }
  }).run();

  assert.equal(asked.length, 0, "Turbo mode must not prompt on outward actions");
  assert.equal(clicks, 1, "Turbo mode executes the click automatically");
});

test("follow-up turns recognize an already-open browser screen and do not gate Create New Post", async () => {
  for (const followUp of [
    "yes sir",
    "continue",
    "namespace should be magicsite.ai",
    "I was referring to the one in the /admin module there is a blog management",
    "now can you write 5 articles with images in this blog management module?"
  ]) {
    assert.equal(
      requiresInitialBrowserState(
        `Continue acting as magic seo. User request: ${followUp}`,
        "https://www.magicsite.ai/admin/blog"
      ),
      true,
      `follow-up "${followUp}" must include the already-open screen`
    );
  }

  // Opening a CMS draft form ("Create New Post", "+ Create New Post", "Save Draft") stays reversible
  // even when the model conservatively declares "outward" because of the noun "Post".
  for (const label of ["Create New Post", "+ Create New Post", "New Post", "Save Draft", "Save as Draft"]) {
    const decision = classifyBrowserAction({
      toolName: "click_element",
      label,
      declaredEffect: "outward"
    });
    assert.equal(decision.effect, "reversible", `"${label}" must not prompt for outward approval`);
  }
});

test("detectPrematureFail rejects giving up on <select> ArrowDown or asking permission for generate_image", () => {
  const rejection = detectPrematureFail(
    "The editor form only exposed title and dropdown controls in the current connected-browser snapshot. The namespace selection did not change after click/ArrowDown; no content/SEO inputs or usable image URL are available yet. Need permission to use a generated image (which costs money)."
  );
  assert.ok(rejection);
  assert.match(rejection!, /type_mark/);
  assert.match(rejection!, /generate_image/);
});

test("agentEngine openai-sdk runs via @openai/agents Runner and completes tool calls", async () => {
  let requests = 0;
  const mockFetch: typeof fetch = async () => {
    requests += 1;
    const output =
      requests === 1
        ? [
            {
              type: "function_call",
              call_id: "call_finish_sdk",
              name: "finish_task",
              arguments: JSON.stringify({ summary: "Completed via OpenAI Agents SDK." })
            }
          ]
        : [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] }];
    return new Response(JSON.stringify(makeResponsesPayload(output, `resp_sdk_${requests}`)), {
      headers: { "content-type": "application/json" }
    });
  };

  const result = await new AgentOrchestrator({
    task: "Complete this task using the OpenAI Agents SDK",
    model: "gpt-6-luna",
    apiKey: "test-key",
    browser: {
      isStarted: false,
      sessionMode: "persistent",
      currentUrl: () => "about:blank"
    } as unknown as BrowserController,
    fetch: mockFetch,
    agentEngine: "openai-sdk"
  }).run();

  assert.equal(result.success, true);
  assert.match(result.summary, /Completed via OpenAI Agents SDK/);
});


test("payment actions ask every time in Turbo even with task and standing approval", async () => {
  let prompts = 0, clicks = 0, requests = 0;
  const browser = {
    isStarted: true, currentUrl: () => "about:blank",
    clickBySelectorOrText: async () => { clicks++; }
  } as unknown as BrowserController;
  const agent = new AgentOrchestrator({
    task: "Complete the two requested actions.", model: "gpt-6-luna", apiKey: "test-key",
    interactionMode: "turbo", standingApproval: true, browser,
    onTerminalApproval: details => {
      prompts++;
      assert.equal(details.approvalKind, "irreversible");
      return { approved: prompts === 1, scope: "task" };
    },
    fetch: async () => {
      requests++;
      const output = requests < 3
        ? [{ type: "function_call", call_id: `pay_${requests}`, name: "click_element", arguments: JSON.stringify({ target: "Pay now", effect: "reversible" }) }]
        : [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "The second action was denied." }] }];
      return new Response(JSON.stringify(makeResponsesPayload(output)), { headers: { "content-type": "application/json" } });
    }
  });
  assert.equal((await agent.run()).success, true);
  assert.equal(prompts, 2);
  assert.equal(clicks, 1);
});

test("Stop aborts an in-flight model request", async () => {
  const controller = new AbortController();
  let requested = false;
  const agent = new AgentOrchestrator({
    task: "Explain the tradeoffs.", model: "gpt-6-luna", apiKey: "test-key",
    browser: {} as BrowserController, abortSignal: controller.signal,
    fetch: async (_input, init) => {
      requested = true;
      const signal = init?.signal;
      assert.ok(signal);
      setTimeout(() => controller.abort(), 10);
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    }
  });
  const result = await agent.run();
  assert.equal(requested, true);
  assert.equal(result.terminationReason, "stopped");
});

test("financial shell operations cannot use standing approval", async () => {
  let prompts = 0;
  const events: Array<Record<string, unknown>> = [];
  const result = await new AgentOrchestrator({
    task: "$ payment-client pay invoice", model: "local-engine", browser: {} as BrowserController,
    interactionMode: "turbo", standingApproval: true,
    onEvent: event => events.push(event),
    onTerminalApproval: details => {
      prompts++;
      assert.equal(details.approvalKind, "irreversible");
      return false;
    }
  }).run();
  assert.equal(result.success, false);
  assert.equal(prompts, 1);
  assert.ok(events.some(event => event.type === "privileged_approval_required" && event.approvalKind === "irreversible"));
});
