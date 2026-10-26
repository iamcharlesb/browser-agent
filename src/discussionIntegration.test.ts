import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, copyFile, readdir, rm, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as { port: number }).port;
}
async function waitFor<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    try { const value = await read(); if (accept(value)) return value; } catch { /* startup/transition */ }
    await new Promise(done => setTimeout(done, 20));
  }
  throw new Error("The isolated discussion did not finish within the test deadline.");
}
function response(output: unknown[], id: number) {
  return { id: `resp_${id}`, object: "response", created_at: 1, status: "completed", model: "integration-model", output,
    parallel_tool_calls: false, usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } };
}
function message(text: string) {
  return [{ id: "msg", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text }] }];
}
const terminalEvents = (sse: string): Array<Record<string, any>> => sse.split("\n")
  .filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6))).filter(event => event.type === "terminal");

test("real server discussion lifecycle terminates repetition, worker failure, and policy rejection", { timeout: 45_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "bounded-discussion-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const compiled = join(directory, "runtime");
  await mkdir(compiled);
  for (const file of await readdir(__dirname)) {
    if (file.endsWith(".js") && !file.endsWith(".test.js")) await copyFile(join(__dirname, file), join(compiled, file));
  }
  await symlink(resolve(__dirname, "..", "node_modules"), join(directory, "node_modules"), "dir");
  await mkdir(join(directory, "static"));
  for (const file of ["index.html", "browserRuntime.js"]) await copyFile(resolve(__dirname, "..", "static", file), join(directory, "static", file));
  let capturedPersonaPrompt = "";
  let scenario = "repeat", modelCalls = 0, coordinatorCalls = 0, workerCalls = 0, finalCalls = 0;
  const asyncStarted: string[] = [];
  const releaseAsync = new Map<string, () => void>();
  const finalAnswer = "Low visibility explains the observed click count. The underlying ranking cause is unverified; compare the page with the relevant search results next.";
  const provider = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    modelCalls++;
    if (scenario === "persona") {
      capturedPersonaPrompt = JSON.stringify(body);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(response(message("Start with a tiny baseline and inspect the support dataset."), modelCalls)));
      return;
    }
    const names = (body.tools || []).map((tool: any) => tool.name || tool.function?.name);
    res.setHeader("content-type", "application/json");
    if (scenario === "async") {
      const key = [...JSON.stringify(body).matchAll(/(?:ASYNC|UI)_[ABC]/g)].at(-1)?.[0] || "unknown";
      asyncStarted.push(key);
      await new Promise<void>(done => releaseAsync.set(key, done));
      res.end(JSON.stringify(response(message(`Completed ${key} independently.`), modelCalls)));
      return;
    }
    if (names.every((name: string) => ["finish_task", "fail_task"].includes(name))) {
      finalCalls++;
      res.end(JSON.stringify(response(message(finalAnswer), modelCalls)));
    } else if (names.includes("delegate_to_bot")) {
      coordinatorCalls++;
      const task = scenario === "rejected" ? "buy the annual plan for me" : `Explain the ranking gap, focused question ${coordinatorCalls}`;
      res.end(JSON.stringify(response([{ id: "fc_delegate", type: "function_call", status: "completed", call_id: `call_${modelCalls}`,
        name: "delegate_to_bot", arguments: JSON.stringify({ targetBotName: "SEO Specialist", task, handoffNote: "Reported evidence: indexed; no clicks; poor ranking." }) }], modelCalls)));
    } else {
      workerCalls++;
      if (scenario === "worker-failure") {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: { message: "Synthetic specialist failure", type: "invalid_request_error" } }));
      } else res.end(JSON.stringify(response(message("The report shows poor visibility. A canonical inspection and comparison with the relevant results are the next checks. No new live evidence is available."), modelCalls)));
    }
  });
  const providerPort = await listen(provider);
  const reservation = createServer();
  const uiPort = await listen(reservation);
  await new Promise<void>(done => reservation.close(() => done()));
  const child = spawn(process.execPath, [join(compiled, "server.js")], {
    cwd: directory, stdio: ["ignore", "pipe", "pipe"], env: {
      PATH: process.env.PATH,
      BROWSER_AGENT_UI_PORT: String(uiPort), BROWSER_AGENT_UI_HOST: "127.0.0.1",
      BROWSER_AGENT_NO_OPEN: "1", BROWSER_AGENT_LEARN_MODE: "0", BROWSER_AGENT_MANAGED_CHROME: "0",
      BROWSER_AGENT_PROFILE_DIR: resolve(__dirname, ".."), BROWSER_AGENT_WORKSPACE_ID: "local",
      OPENAI_API_KEY: "test-key", OPENAI_MODEL: "integration-model", OPENAI_BASE_URL: `http://127.0.0.1:${providerPort}/v1`,
      BROWSER_AGENT_MODELS_JSON: JSON.stringify([{ id: "integration-model", provider: "openai", api: "responses" }]),
      BROWSER_AGENT_MAX_DISCUSSION_ROUNDS: "4", BROWSER_AGENT_MAX_CONSULTATIONS_PER_BOT: "2",
      BROWSER_AGENT_MAX_DISCUSSION_SECONDS: "20", BROWSER_AGENT_SYNTHESIS_MAX_SECONDS: "10"
    }
  });
  let logs = "";
  child.stdout!.on("data", chunk => { logs += chunk; });
  child.stderr!.on("data", chunk => { logs += chunk; });
  const base = `http://127.0.0.1:${uiPort}`;
  try {
    await waitFor(() => fetch(base + "/api/status").then(r => r.json()), value => Boolean(value));
    await t.test("manual indexing rejects cross-origin requests and cannot escape the coding workspace", async () => {
      const before = modelCalls;
      const blocked = await fetch(base + "/api/code/index", {method: "POST", headers: {"content-type": "application/json"}, body: "{}"});
      assert.equal(blocked.status, 403);
      const escaped = await fetch(base + "/api/code/index", {method: "POST", headers: {"content-type": "application/json", origin: base}, body: JSON.stringify({root: ".."})});
      assert.equal(escaped.status, 400);
      assert.match((await escaped.json()).detail, /within the workspace/);
      assert.equal(modelCalls, before, "indexing does not wake a model");
    });
    for (const name of ["repeat", "worker-failure", "rejected"]) {
      await t.test(name, async () => {
        scenario = name; coordinatorCalls = 0; workerCalls = 0; finalCalls = 0;
        const submission = await waitFor<{ runId: string }>(async () => {
          const res = await fetch(base + "/api/run", { method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ task: "Diagnose why this page has no clicks and recommend the next action.", botName: "Coordinator", interactionMode: "chat", agentEngine: "cheap", model: "integration-model" }) });
          if (!res.ok) throw new Error("Run transition is still in progress.");
          return res.json() as Promise<{ runId: string }>;
        }, value => Boolean(value.runId));
        const original = terminalEvents(await fetch(base + "/api/events?runId=" + submission.runId).then(r => r.text())).at(-1)!;
        assert.ok(original.discussionId);
        assert.equal(original.runId, submission.runId);
        const state = await waitFor(() => fetch(base + "/api/discussions/" + original.discussionId).then(r => r.json()), value => ["completed", "failed"].includes(value.phase));
        assert.equal(state.phase, "completed", logs);
        assert.equal(workerCalls, name === "repeat" ? 2 : name === "rejected" ? 0 : 1);
        assert.equal(finalCalls, 1);
        const final = terminalEvents(await fetch(base + "/api/events?runId=" + state.runId).then(r => r.text())).at(-1)!;
        assert.equal(final.summary, finalAnswer);
        assert.equal(final.discussionFinal, true);
        assert.equal(final.delegateTo, undefined);
        assert.equal(final.discussionId, original.discussionId);
        const count = modelCalls;
        await fetch(base + "/api/discussions/" + original.discussionId);
        assert.equal(modelCalls, count, "reading discussion state cannot wake a model");
      });
    }
    const memories = await readdir(join(directory, ".browser-agent-task-memory"));
    assert.ok(memories.every(file => !/seo/i.test(file)), "consultation did not overwrite the specialist's user task memory");
    await t.test("renamed specialist and owner instructions reach the actual provider prompt", async () => {
      scenario = "persona";
      const res = await fetch(base + "/api/run", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ task: "Suggest the next experiment.", botName: "My AI Lab", profileId: "neural-architect",
          botInstructions: "Inspect our support dataset before proposing changes.", interactionMode: "chat", agentEngine: "cheap", model: "integration-model" }) });
      assert.equal(res.status, 200);
      const submission = await res.json();
      const final = terminalEvents(await fetch(base + "/api/events?runId=" + submission.runId).then(r => r.text())).at(-1)!;
      assert.ok(final);
      assert.match(capturedPersonaPrompt, /SOUL/);
      assert.match(capturedPersonaPrompt, /tiny working baseline/);
      assert.match(capturedPersonaPrompt, /OWNER BOT PROFILE/);
      assert.match(capturedPersonaPrompt, /Do not use hyphen bullets/);
      assert.match(capturedPersonaPrompt, /Inspect our support dataset/);
      assert.doesNotMatch(capturedPersonaPrompt, /customer-obsessed/);
    });
    await t.test("two agents execute concurrently; same-bot work waits and scoped Stop leaves the other agent running", async () => {
      scenario = "async";
      const enqueue = async (botName: string, task: string) => fetch(base + "/api/run/queue", {
        method: "POST", headers: { "content-type": "application/json", origin: base },
        body: JSON.stringify({ task, botName, interactionMode: "chat", agentEngine: "cheap", model: "integration-model" })
      }).then(r => r.json());
      const a = await enqueue("Async Writer", "ASYNC_A");
      const b = await enqueue("Async Researcher", "ASYNC_B");
      const c = await enqueue("Async Writer", "ASYNC_C");
      await waitFor(async () => asyncStarted, value => value.includes("ASYNC_A") && value.includes("ASYNC_B")).catch(async error => {
        const queue = await fetch(base + "/api/run/jobs").then(r => r.json());
        throw new Error(error.message + "\n" + JSON.stringify({ asyncStarted, queue, logs }));
      });
      assert.equal(asyncStarted.includes("ASYNC_C"), false);
      const aState = await fetch(base + "/api/run/jobs/" + a.id).then(r => r.json());
      const bState = await fetch(base + "/api/run/jobs/" + b.id).then(r => r.json());
      assert.notEqual(aState.runId, bState.runId);
      const status = await fetch(base + "/api/status").then(r => r.json());
      assert.equal(status.activeRuns.length, 2);
      await fetch(base + "/api/stop?runId=" + aState.runId, { method: "POST" });
      releaseAsync.get("ASYNC_A")!();
      await waitFor(async () => asyncStarted, value => value.includes("ASYNC_C"));
      assert.equal((await fetch(base + "/api/run/jobs/" + b.id).then(r => r.json())).status, "running");
      releaseAsync.get("ASYNC_B")!(); releaseAsync.get("ASYNC_C")!();
      await waitFor(() => fetch(base + "/api/run/jobs/" + c.id).then(r => r.json()), value => value.status === "completed");
      assert.equal((await fetch(base + "/api/run/jobs/" + a.id).then(r => r.json())).status, "cancelled");
    });
    await t.test("the whole UI boots and two chat results stay in their own conversations", async () => {
      scenario = "async";
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        const errors: string[] = [];
        page.on("pageerror", error => errors.push(error.message));
        await page.route("https://fonts.**/*", route => route.abort());
        await page.addInitScript(() => {
          localStorage.setItem("agentFireworksAgentsV2", JSON.stringify([
            { id: "writer", name: "Async Writer", description: "Write concise answers", transcript: [] },
            { id: "researcher", name: "Async Researcher", description: "Research concise answers", transcript: [] }
          ]));
          localStorage.setItem("openBotsInteractionMode", "chat");
          localStorage.setItem("openBotsAgentEngine", "cheap");
        });
        await page.goto(base, { waitUntil: "domcontentloaded" });
        await page.waitForSelector('.agent-row[data-agent-id="writer"]');
        await page.waitForFunction(() => Boolean(document.querySelector('#model-select option[value="integration-model"]')));
        await page.selectOption("#model-select", "integration-model", { force: true });
        await page.locator('.agent-row[data-agent-id="writer"]').click();
        await page.locator("#prompt").fill("UI_A");
        await page.locator("#send-button").click();
        await waitFor(async () => asyncStarted, value => value.includes("UI_A"));
        await page.locator('.agent-row[data-agent-id="researcher"]').click();
        await page.waitForTimeout(450);
        await page.locator("#prompt").fill("UI_B");
        await page.locator("#send-button").click();
        await waitFor(async () => asyncStarted, value => value.includes("UI_B"));
        releaseAsync.get("UI_B")!();
        await page.waitForFunction(() => document.querySelector("#messages")!.textContent!.includes("Completed UI_B independently."));
        await page.locator('.agent-row[data-agent-id="writer"]').click();
        assert.equal((await page.locator("#messages").innerText()).includes("Completed UI_B independently."), false);
        releaseAsync.get("UI_A")!();
        await page.waitForFunction(() => document.querySelector("#messages")!.textContent!.includes("Completed UI_A independently."));
        assert.deepEqual(errors, []);
      } finally { await browser.close(); }
    });
  } finally {
    for (const release of releaseAsync.values()) release();
    child.kill("SIGTERM");
    if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
    await new Promise<void>(done => provider.close(() => done()));
  }
});
