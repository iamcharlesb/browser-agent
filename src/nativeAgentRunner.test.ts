import test from "node:test";
import assert from "node:assert/strict";
import OpenAI from "openai";
import { runWithNativeAgentRunner } from "./nativeAgentRunner";

test("nativeAgentRunner executes Chat Completions tool loop (Ollama / compatible) without @openai/agents", async () => {
  let turn = 0;
  const mockFetch: typeof fetch = async () => {
    turn += 1;
    const payload =
      turn === 1
        ? {
            id: "chatcmpl_1",
            object: "chat.completion",
            created: 1,
            model: "qwen2.5-coder",
            choices: [
              {
                index: 0,
                finish_reason: "tool_calls",
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "call_local_1",
                      type: "function",
                      function: { name: "read_status", arguments: JSON.stringify({ target: "repo" }) }
                    }
                  ]
                }
              }
            ],
            usage: { prompt_tokens: 15, completion_tokens: 8, total_tokens: 23 }
          }
        : {
            id: "chatcmpl_2",
            object: "chat.completion",
            created: 2,
            model: "qwen2.5-coder",
            choices: [
              {
                index: 0,
                finish_reason: "stop",
                message: { role: "assistant", content: "Status verified: healthy" }
              }
            ],
            usage: { prompt_tokens: 30, completion_tokens: 6, total_tokens: 36 }
          };
    return new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } });
  };

  const usages: number[] = [];
  const client = new OpenAI({ apiKey: "local-ollama", baseURL: "http://127.0.0.1:11434/v1", fetch: mockFetch });
  const outcome = await runWithNativeAgentRunner({
    botName: "Ollama Coder",
    systemPrompt: "Verify status.",
    initialUserPrompt: "Check repo status",
    model: "qwen2.5-coder",
    apiKey: "local-ollama",
    useResponses: false,
    openAIClient: client,
    maxSteps: 5,
    tools: [
      {
        type: "function",
        function: {
          name: "read_status",
          description: "Read status",
          parameters: { type: "object", properties: { target: { type: "string" } } }
        }
      }
    ],
    shouldAbort: () => false,
    onUsage: (u) => usages.push(u.totalTokens),
    onToolCall: async (name, input) => {
      assert.equal(name, "read_status");
      assert.equal(input.target, "repo");
      return { output: "healthy" };
    }
  });

  assert.equal(outcome.success, true);
  assert.equal(outcome.summary, "Status verified: healthy");
  assert.deepEqual(usages, [23, 36]);
});

test("nativeAgentRunner enforces maxSteps circuit breaker and premature-finish retry", async () => {
  let turn = 0;
  const mockFetch: typeof fetch = async () => {
    turn += 1;
    const payload = {
      id: `chatcmpl_${turn}`,
      object: "chat.completion",
      created: turn,
      model: "llama3.2",
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: { role: "assistant", content: turn === 1 ? "Draft reply" : "Verified final reply" }
        }
      ]
    };
    return new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } });
  };

  const client = new OpenAI({ apiKey: "local-ollama", baseURL: "http://127.0.0.1:11434/v1", fetch: mockFetch });
  let checks = 0;
  const outcome = await runWithNativeAgentRunner({
    botName: "Verifier",
    systemPrompt: "Be thorough.",
    initialUserPrompt: "Finish",
    model: "llama3.2",
    apiKey: "local-ollama",
    useResponses: false,
    openAIClient: client,
    maxSteps: 4,
    tools: [],
    shouldAbort: () => false,
    checkPrematureFinish: (text) => {
      checks += 1;
      return checks === 1 && text === "Draft reply" ? "Verify before finishing." : null;
    },
    onToolCall: async () => ({ output: "" })
  });

  assert.equal(outcome.success, true);
  assert.equal(outcome.summary, "Verified final reply");
  assert.equal(checks, 2);
});

test("nativeAgentRunner rejects malformed JSON tool arguments without invoking handler", async () => {
  let turn = 0;
  let handlerCalled = false;
  const mockFetch: typeof fetch = async () => {
    turn += 1;
    const payload =
      turn === 1
        ? {
            id: "chatcmpl_bad_args",
            object: "chat.completion",
            created: 1,
            model: "llama3.2",
            choices: [
              {
                index: 0,
                finish_reason: "tool_calls",
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "call_bad",
                      type: "function",
                      function: { name: "finish_task", arguments: "{truncated-json" }
                    }
                  ]
                }
              }
            ]
          }
        : {
            id: "chatcmpl_recover",
            object: "chat.completion",
            created: 2,
            model: "llama3.2",
            choices: [
              {
                index: 0,
                finish_reason: "stop",
                message: { role: "assistant", content: "Recovered cleanly" }
              }
            ]
          };
    return new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } });
  };

  const client = new OpenAI({ apiKey: "local-ollama", baseURL: "http://127.0.0.1:11434/v1", fetch: mockFetch });
  const outcome = await runWithNativeAgentRunner({
    botName: "Safe Runner",
    systemPrompt: "Be safe.",
    initialUserPrompt: "Run",
    model: "llama3.2",
    apiKey: "local-ollama",
    useResponses: false,
    openAIClient: client,
    maxSteps: 4,
    tools: [
      {
        type: "function",
        function: { name: "finish_task", description: "Finish", parameters: { type: "object", properties: {} } }
      }
    ],
    shouldAbort: () => false,
    onToolCall: async () => {
      handlerCalled = true;
      return { output: "should not run" };
    }
  });

  assert.equal(handlerCalled, false);
  assert.equal(outcome.success, true);
  assert.equal(outcome.summary, "Recovered cleanly");
});

test("nativeAgentRunner throws on failed or incomplete Responses API status", async () => {
  const mockFetch: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        id: "resp_failed",
        status: "failed",
        error: { message: "Upstream model failure" },
        output: []
      }),
      { headers: { "content-type": "application/json" } }
    );

  const client = new OpenAI({ apiKey: "test-key", fetch: mockFetch });
  await assert.rejects(
    () =>
      runWithNativeAgentRunner({
        botName: "Responses Bot",
        systemPrompt: "Run",
        initialUserPrompt: "Test",
        model: "gpt-5-mini",
        apiKey: "test-key",
        useResponses: true,
        openAIClient: client,
        maxSteps: 3,
        tools: [],
        shouldAbort: () => false,
        onToolCall: async () => ({ output: "" })
      }),
    /Responses API failed: Upstream model failure/
  );
});

test("nativeAgentRunner throws on truncated Chat Completions finish_reason length", async () => {
  const mockFetch: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        id: "chatcmpl_trunc",
        object: "chat.completion",
        created: 1,
        model: "llama3.2",
        choices: [
          {
            index: 0,
            finish_reason: "length",
            message: { role: "assistant", content: "Partial unfinished answer..." }
          }
        ]
      }),
      { headers: { "content-type": "application/json" } }
    );

  const client = new OpenAI({ apiKey: "local-ollama", baseURL: "http://127.0.0.1:11434/v1", fetch: mockFetch });
  await assert.rejects(
    () =>
      runWithNativeAgentRunner({
        botName: "Truncated Bot",
        systemPrompt: "Answer fully.",
        initialUserPrompt: "Write essay",
        model: "llama3.2",
        apiKey: "local-ollama",
        useResponses: false,
        openAIClient: client,
        maxSteps: 3,
        tools: [],
        shouldAbort: () => false,
        onToolCall: async () => ({ output: "" })
      }),
    /truncated \(finish_reason: length\)/
  );
});
