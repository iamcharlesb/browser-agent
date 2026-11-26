import assert from "node:assert/strict";
import test from "node:test";
import { createModelClient } from "./modelProviderFactory";
import { providerCatalog } from "./providerRegistry";
import { defaultModel, modelConfigurationIssue, resolveModel } from "./runtimeConfig";
import { AgentOrchestrator } from "./promptLoop";
import { BrowserController } from "./browserController";
import { saveProviderSettings } from "./providerSettings";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function environment(values: Record<string, string | undefined>, run: () => Promise<void>) {
  const before = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await run();
  } finally { for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value; }
}

for (const provider of ["openai", "qwen", "kimi"] as const) {
  for (const agentEngine of ["cheap", "openai-sdk"] as const) {
    test(`${provider} factory routes a two-turn tool loop through ${agentEngine} with its own credentials`, async () => {
      const prefix = provider.toUpperCase();
      await environment({ [`${prefix}_MODEL`]: `${provider}-fixture`, [`${prefix}_BASE_URL`]: `https://${provider}.fixture.invalid/v1`,
        [`${prefix}_API_KEY`]: `fixture-${provider}-credential`, [`${prefix}_API_MODE`]: provider === "qwen" ? "chat" : "responses",
        BROWSER_AGENT_MODELS_JSON: JSON.stringify([{id:`${provider}-fixture`,provider,api:provider === "qwen" ? "chat" : "responses"}]) }, async () => {
        const calls: any[] = [];
        const agent = new AgentOrchestrator({ task: "Calculate 2+3 using the calculator and report the answer.", model: `${provider}-fixture`,
          interactionMode: "chat", agentEngine, browser: {} as BrowserController,
          fetch: async (url, init) => {
            assert.ok(String(url).startsWith(`https://${provider}.fixture.invalid/v1/`));
            assert.equal(new Headers(init?.headers).get("authorization"), `Bearer fixture-${provider}-credential`);
            const body = JSON.parse(String(init?.body)); calls.push(body);
            const name = calls.length === 1 ? "calculate" : "finish_task";
            const args = JSON.stringify(calls.length === 1 ? {expression:"2+3"} : {success:true,summary:"5"});
            const result = provider === "qwen" ? {id:`c_${calls.length}`, object:"chat.completion",created:1,model:body.model,
              choices:[{index:0,finish_reason:"tool_calls",message:{role:"assistant",content:null,tool_calls:[{id:`call_${calls.length}`,type:"function",function:{name,arguments:args}}]}}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}}
              : {id:`r_${calls.length}`,object:"response",created_at:1,status:"completed",model:body.model,
                output:[{type:"function_call",id:`fc_${calls.length}`,call_id:`call_${calls.length}`,name,arguments:args}],usage:{input_tokens:10,output_tokens:5,total_tokens:15}};
            return new Response(JSON.stringify(result), {headers:{"content-type":"application/json"}});
          } });
        const result = await agent.run(); assert.equal(result.success, true); assert.equal(calls.length, 2);
        assert.match(JSON.stringify(calls[1]), /5/);
      });
    });
  }
}

test("provider defaults and missing-key errors never borrow another provider's credentials", async () => {
  await environment({ BROWSER_AGENT_PROVIDER:"qwen",BROWSER_AGENT_MODEL:undefined,QWEN_MODEL:"qwen-fixture",QWEN_API_KEY:undefined,DASHSCOPE_API_KEY:undefined,OPENAI_API_KEY:"fixture-openai-only" }, async () => {
    assert.equal(defaultModel(), "qwen-fixture");
    assert.match(modelConfigurationIssue("qwen-fixture")!, /Qwen/);
    const client = createModelClient("qwen-fixture"); assert.equal(client.apiKey, undefined);
    assert.equal(resolveModel("kimi-custom").provider, "kimi");
    assert.doesNotMatch(JSON.stringify(providerCatalog()), /fixture-openai-only/);
  });
});

test("Settings persists provider selection, endpoint and model and rejects invalid writes atomically", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pilo-provider-setup-")); const file = join(directory, ".env");
  try {
    const updates = await saveProviderSettings({provider:"kimi",providerApiKey:"fixture-kimi-key",providerModel:"kimi-fixture",providerBaseURL:"https://kimi.fixture.invalid/v1"}, file);
    assert.equal(updates.BROWSER_AGENT_MODEL, "kimi-fixture"); assert.equal(updates.KIMI_API_KEY, "fixture-kimi-key");
    const before = await readFile(file, "utf8");
    await assert.rejects(saveProviderSettings({provider:"qwen",providerModel:"qwen-fixture\nBAD=1"}, file), /single-line/);
    await assert.rejects(saveProviderSettings({provider:"compatible",providerModel:"fixture",providerBaseURL:"https://user:pass@example.com/v1"}, file), /without credentials/);
    assert.equal(await readFile(file, "utf8"), before);
    await saveProviderSettings({provider:"kimi",providerApiKey:"",providerModel:"kimi-other",providerBaseURL:"https://kimi.fixture.invalid/v1"}, file);
    assert.match(await readFile(file, "utf8"), /KIMI_API_KEY="fixture-kimi-key"/);
  } finally { await rm(directory, {recursive:true,force:true}); }
});

test("providerCatalog and resolveModel support Ollama, Hugging Face, and Chinese LLM providers", () => {
  const ids = new Set(providerCatalog().map((p) => p.id));
  for (const expected of [
    "ollama", "huggingface", "deepseek", "qwen", "kimi",
    "zhipu", "minimax", "yi", "baichuan", "doubao", "stepfun", "siliconflow"
  ]) {
    assert.ok(ids.has(expected as any), `Expected provider "${expected}" in catalog`);
  }

  assert.equal(resolveModel("hf:Qwen/Qwen2.5-72B-Instruct").provider, "huggingface");
  assert.equal(createModelClient("hf:Qwen/Qwen2.5-72B-Instruct", { apiKey: "test-hf" }).model, "Qwen/Qwen2.5-72B-Instruct");
  assert.equal(resolveModel("deepseek-chat").provider, "deepseek");
  assert.equal(resolveModel("glm-4-plus").provider, "zhipu");
  assert.equal(resolveModel("MiniMax-Text-01").provider, "minimax");
  assert.equal(resolveModel("yi-lightning").provider, "yi");
  assert.equal(resolveModel("Baichuan4").provider, "baichuan");
  assert.equal(resolveModel("doubao-pro-32k").provider, "doubao");
  assert.equal(resolveModel("step-2-16k").provider, "stepfun");
});
