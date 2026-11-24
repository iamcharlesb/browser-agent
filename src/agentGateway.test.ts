import test from "node:test";
import assert from "node:assert/strict";
import { PiloAgentGateway } from "./agentGateway";

test("PiloAgentGateway enforces auth, RBAC, guardrails, rate limits, and A2A routing", async () => {
  const gw = new PiloAgentGateway({
    apiKeys: [
      { id: "dev", key: "pilo-dev-test-key", roles: ["developer"] },
      { id: "admin", key: "pilo-admin-test-key", roles: ["admin"] }
    ],
    roles: [
      {
        name: "developer",
        permissions: [
          { resourceType: "mcp_tool", action: "call", resourceId: "math__add" },
          { resourceType: "a2a_agent", action: "invoke", resourceId: "ollama-coder" }
        ]
      },
      {
        name: "admin",
        permissions: [{ resourceType: "*", action: "*", resourceId: "*" }]
      }
    ],
    blockedPatterns: [/DROP\s+TABLE/i],
    rateLimit: { maxRequests: 3, windowMs: 60_000 }
  });

  gw.registerTool({
    name: "add",
    namespace: "math",
    description: "Add numbers",
    execute: (args) => String(Number(args.a) + Number(args.b))
  });
  gw.registerTool({
    name: "deploy",
    namespace: "ops",
    description: "Deploy release",
    execute: () => "deployed"
  });
  gw.registerAgent({
    id: "ollama-coder",
    name: "Ollama Coder",
    description: "Local coding specialist",
    provider: "ollama",
    model: "qwen2.5-coder",
    run: async (input) => `coded:${input}`
  });

  // Unauthenticated rejected
  assert.throws(() => gw.listTools(), /Authentication required/);

  // Developer only sees math__add
  const devHeaders = { "x-api-key": "pilo-dev-test-key" };
  assert.deepEqual(
    gw.listTools(devHeaders).map((t) => t.name),
    ["math__add"]
  );

  // Developer can call math__add and invoke ollama-coder
  const sum = await gw.callTool("math__add", { a: 2, b: 5 }, devHeaders);
  assert.equal(sum.output, "7");

  const task = await gw.sendTask({ agentId: "ollama-coder", input: "fix bug" }, devHeaders);
  assert.equal(task.state, "completed");
  assert.equal(task.output, "coded:fix bug");

  // Developer denied ops__deploy
  await assert.rejects(() => gw.callTool("ops__deploy", {}, devHeaders), /Forbidden/);

  // Guardrail blocks admin payload
  const adminHeaders = { "x-api-key": "pilo-admin-test-key" };
  await assert.rejects(
    () => gw.callTool("ops__deploy", { sql: "DROP TABLE prod" }, adminHeaders),
    /Blocked by gateway guardrail/
  );
});

test("PiloAgentGateway fails over from cloud provider to local Ollama and discovers Ollama models", async () => {
  const mockFetch: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/api/tags")) {
      return new Response(JSON.stringify({ models: [{ name: "qwen2.5-coder:latest" }] }), {
        headers: { "content-type": "application/json" }
      });
    }
    if (url.includes("api.openai.com")) {
      return new Response("upstream unavailable", { status: 503 });
    }
    return new Response(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: "local ollama reply" } }],
        usage: { total_tokens: 21 }
      }),
      { headers: { "content-type": "application/json" } }
    );
  };

  const gw = new PiloAgentGateway({ allowAnonymous: true, fetch: mockFetch });
  const models = await gw.listOllamaModels("http://127.0.0.1:11434/v1");
  assert.deepEqual(models, ["qwen2.5-coder:latest"]);

  const reply = await gw.routeChat({
    provider: "openai",
    model: "gpt-5-mini",
    apiKey: "test-cloud-key",
    fallbackProviders: [{ provider: "ollama", model: "qwen2.5-coder", baseURL: "http://127.0.0.1:11434/v1" }],
    messages: [{ role: "user", content: "hello" }]
  });

  assert.equal(reply.provider, "ollama");
  assert.equal(reply.fallbackUsed, true);
  assert.equal(reply.content, "local ollama reply");
  assert.equal(reply.totalTokens, 21);
});
