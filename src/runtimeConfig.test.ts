import assert from "node:assert/strict";
import { it } from "node:test";
import { defaultModel, envInteger, modelCatalog, modelPricing, resolveModel } from "./runtimeConfig";
import { AgentOrchestrator } from "./promptLoop";
import { BrowserController } from "./browserController";

function withEnv(values: Record<string, string | undefined>, callback: () => void) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    callback();
  } finally {
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}

it("resolves arbitrary model versions and API capabilities from environment metadata", () => {
  withEnv({ BROWSER_AGENT_MODEL: "custom-reasoner", BROWSER_AGENT_MODELS_JSON: JSON.stringify([{ id: "custom-reasoner", provider: "anthropic", api: "chat", apiKey: "never-expose-this" }]) }, () => {
    assert.equal(defaultModel(), "custom-reasoner");
    assert.equal(resolveModel("custom-reasoner").provider, "anthropic");
    assert.equal(resolveModel("custom-reasoner").api, "chat");
    assert.ok(!JSON.stringify(modelCatalog()).includes("never-expose-this"));
  });
});

it("validates budgets and pricing without guessing a price for unknown models", () => {
  withEnv({ MODEL_PRICING_JSON: "{}", TEST_BUDGET: "NaN" }, () => {
    assert.deepEqual(modelPricing(), {});
    assert.throws(() => envInteger("TEST_BUDGET", 4), /TEST_BUDGET/);
  });
  withEnv({ MODEL_PRICING_JSON: '{"custom":{"input":-1,"output":1}}' }, () => assert.throws(modelPricing, /non-negative/));
});

it("does not send the OpenAI credential to another provider", () => {
  withEnv({ OPENAI_API_KEY: "openai-only-test-value", ANTHROPIC_API_KEY: undefined, XAI_API_KEY: undefined }, () => {
    for (const model of ["claude-test-model", "grok-test-model"]) {
      const agent = new AgentOrchestrator({ task: "Explain the result", model, browser: {} as BrowserController });
      assert.notEqual((agent as any).resolvedApiKey, process.env.OPENAI_API_KEY);
    }
  });
});
