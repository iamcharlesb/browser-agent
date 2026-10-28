import assert from "node:assert/strict";
import { it } from "node:test";
import { defaultModel, envInteger, modelCatalog, modelPricing, resolveModel } from "./runtimeConfig";
import { AgentOrchestrator } from "./promptLoop";
import { BrowserController } from "./browserController";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { saveProviderSettings } from "./providerSettings";

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

it("saved provider connections survive fresh processes and preserve unrelated configuration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "provider-settings-"));
  const file = join(directory, ".env");
  try {
    await writeFile(file, "# Operator configuration\nOPENAI_MODEL=fixture-model\nCUSTOM_LIMIT=17\nexport OPENAI_API_KEY=test-key-stale\n");
    const key = 'test-key-with-quote"and-backslash\\';
    await Promise.all([
      saveProviderSettings({ openaiApiKey: key }, file),
      saveProviderSettings({ xaiApiKey: "test-key-xai" }, file)
    ]);
    await saveProviderSettings({ openaiApiKey: "", baseURL: "http://127.0.0.1:1234/v1" }, file);
    const contents = await readFile(file, "utf8");
    assert.match(contents, /# Operator configuration\nOPENAI_MODEL=fixture-model\nCUSTOM_LIMIT=17/);
    if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o777, 0o600);
    const check = (override?: string) => spawnSync(process.execPath, ["-e", `require(${JSON.stringify(require.resolve("./environment"))}); process.stdout.write(JSON.stringify({ keyMatches: process.env.OPENAI_API_KEY === ${JSON.stringify(key)}, xaiPresent: process.env.XAI_API_KEY === 'test-key-xai', modelPreserved: process.env.OPENAI_MODEL === 'fixture-model', inheritedWins: process.env.OPENAI_API_KEY === 'inherited-test-key' }));`], {
      env: { PATH: process.env.PATH, BROWSER_AGENT_ENV_FILE: file, ...(override ? { OPENAI_API_KEY: override } : {}) }, encoding: "utf8"
    });
    const restarted = check();
    assert.equal(restarted.status, 0);
    assert.deepEqual(JSON.parse(restarted.stdout), { keyMatches: true, xaiPresent: true, modelPreserved: true, inheritedWins: false });
    assert.equal(JSON.parse(check("inherited-test-key").stdout).inheritedWins, true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("provider saves reject injection and symlinks without altering existing configuration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "provider-settings-rejection-"));
  const file = join(directory, ".env"), link = join(directory, "linked.env");
  try {
    await writeFile(file, "CUSTOM_LIMIT=17\n");
    await assert.rejects(saveProviderSettings({ openaiApiKey: "test-key\nCUSTOM_LIMIT=0" }, file), /single-line/);
    await assert.rejects(saveProviderSettings({ baseURL: "file:///tmp/fixture" }, file), /http/);
    await symlink(file, link);
    await assert.rejects(saveProviderSettings({ openaiApiKey: "test-key" }, link), /not changed/);
    assert.equal(await readFile(file, "utf8"), "CUSTOM_LIMIT=17\n");
    // A failed save must not poison the serial queue.
    await saveProviderSettings({ anthropicApiKey: "test-key-anthropic" }, file);
    assert.match(await readFile(file, "utf8"), /ANTHROPIC_API_KEY=/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("the browser checkout loads the repository environment with app and shell precedence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "checkout-environment-"));
  const app = join(directory, "node", "browser_agent"), compiled = join(app, "dist");
  try {
    await mkdir(compiled, { recursive: true });
    await copyFile(require.resolve("./environment"), join(compiled, "environment.js"));
    await writeFile(join(directory, ".gitmodules"), '[submodule "node/browser_agent"]\n path = node/browser_agent\n');
    await writeFile(join(directory, ".env"), 'export OPENAI_API_KEY="test-key-root"\nOPENAI_MODEL=fixture-model\n');
    const run = (extra: Record<string, string> = {}) => {
      const result = spawnSync(process.execPath, ["-e", `require(${JSON.stringify(join(compiled, "environment.js"))}); process.stdout.write(JSON.stringify({root:process.env.OPENAI_API_KEY==='test-key-root',app:process.env.OPENAI_API_KEY==='test-key-app',shell:process.env.OPENAI_API_KEY==='test-key-shell',model:process.env.OPENAI_MODEL==='fixture-model',isolated:process.env.OPENAI_API_KEY===undefined}));`], {
        env: { PATH: process.env.PATH, ...extra }, encoding: "utf8"
      });
      assert.equal(result.status, 0); return JSON.parse(result.stdout);
    };
    assert.equal(run().root, true);
    await writeFile(join(app, ".env"), "OPENAI_API_KEY=test-key-app\n");
    assert.equal(run().app, true);
    assert.equal(run().model, true, "the root fills missing model settings");
    assert.equal(run({ OPENAI_API_KEY: "test-key-shell" }).shell, true);
    assert.equal(run({ BROWSER_AGENT_ENV_FILE: join(directory, "absent.env") }).isolated, true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
