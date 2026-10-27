import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, copyFile, cp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import { TerminalClient } from "./terminalClient";

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
  await cp(resolve(__dirname, "..", "docs"), join(directory, "docs"), { recursive: true });
  await copyFile(resolve(__dirname, "..", "README.md"), join(directory, "README.md"));
  for (const file of ["index.html", "browserRuntime.js", "uiState.js"]) await copyFile(resolve(__dirname, "..", "static", file), join(directory, "static", file));
  let capturedPersonaPrompt = "";
  const cliPrompts: string[] = [];
  let cliToolCalls = 0;
  let scenario = "repeat", modelCalls = 0, coordinatorCalls = 0, workerCalls = 0, finalCalls = 0;
  const asyncStarted: string[] = [];
  const releaseAsync = new Map<string, () => void>();
  const finalAnswer = "Low visibility explains the observed click count. The underlying ranking cause is unverified; compare the page with the relevant search results next.";
  const provider = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    modelCalls++;
    if (scenario === "cli-memory") {
      cliPrompts.push(JSON.stringify(body));
      const replies = ["Cedar bakery campaign draft; $25 budget; awaiting review.",
        "Corrected budget: $15. Keep the Cedar bakery audience. Draft only.",
        "Private checklist recorded.", "Resuming Cedar bakery with a $15 limit; draft only."];
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(response(message(replies[cliPrompts.length - 1] || "Context retained."), modelCalls)));
      return;
    }
    if (scenario === "cli-approval") {
      res.setHeader("content-type", "application/json");
      const output = cliToolCalls++ % 2 === 0
        ? [{ id: "fc_write", type: "function_call", call_id: "cli_write", name: "workspace_file",
          arguments: JSON.stringify({ action: "write", path: "cli-approved.txt", content: "explicitly approved" }) }]
        : message("The attempted file action has finished.");
      res.end(JSON.stringify(response(output, modelCalls)));
      return;
    }
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
  const dataRoot = join(directory, "operator-data");
  await mkdir(dataRoot);
  const child = spawn(process.execPath, [join(compiled, "server.js")], {
    cwd: directory, stdio: ["ignore", "pipe", "pipe"], env: {
      PATH: process.env.PATH,
      BROWSER_AGENT_UI_PORT: String(uiPort), BROWSER_AGENT_UI_HOST: "127.0.0.1",
      BROWSER_AGENT_NO_OPEN: "1", BROWSER_AGENT_LEARN_MODE: "0", BROWSER_AGENT_MANAGED_CHROME: "0",
      BROWSER_AGENT_PROFILE_DIR: resolve(__dirname, ".."), BROWSER_AGENT_WORKSPACE_ID: "local",
      BROWSER_AGENT_DATA_DIR: dataRoot, BROWSER_AGENT_WORKSPACE_ROOT: directory,
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
    await t.test("documentation route works without a model call", async () => {
      const before = modelCalls;
      const res = await fetch(base + "/docs?topic=conversations");
      assert.equal(res.status, 200); assert.match(res.headers.get("content-type") || "", /text\/html/);
      assert.match(await res.text(), /Reset one bot or every bot/);
      assert.equal(modelCalls, before);
    });
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
    const memories = await readdir(join(dataRoot, ".browser-agent-task-memory"));
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
    const cli = async (args: string[], input = "") => {
      const process = spawn(global.process.execPath, [join(compiled, "openbuddyCli.js"), ...args, "--server", base], {
        cwd: directory, env: { PATH: global.process.env.PATH, BROWSER_AGENT_CLI_TIMEOUT_SECONDS: "10" }, stdio: ["pipe", "pipe", "pipe"]
      });
      let stdout = "", stderr = "";
      process.stdout.on("data", chunk => stdout += chunk);
      process.stderr.on("data", chunk => stderr += chunk);
      const timeout = setTimeout(() => process.kill("SIGTERM"), 15_000);
      try {
        process.stdin.end(input);
        const [code] = await once(process, "exit");
        return { code, stdout, stderr };
      } finally { clearTimeout(timeout); }
    };
    await t.test("terminal chat preserves goals and corrections, isolates bots and resumes from a new invocation", async () => {
      scenario = "cli-memory";
      const result = await cli(["chat", "--bot", "CLI Marketing", "--profile", "chief-marketing-officer", "--model", "integration-model"], [
        "Prepare a draft campaign for Cedar bakery with a $25 budget. Draft only.",
        "Correction: budget is $15. Keep the bakery audience.",
        "/bot CLI Private", "Remember PRIVATE_BOT_MARKER as a private checklist.",
        "/bot CLI Marketing", "Resume the draft and summarize approved limits.", "/quit", ""
      ].join("\n"));
      assert.equal(result.code, 0, result.stderr + logs);
      assert.match(result.stdout, /Corrected budget: \$15/);
      assert.equal(cliPrompts.length, 4, JSON.stringify(result));
      assert.match(cliPrompts[1], /Cedar bakery/);
      assert.match(cliPrompts[3], /Cedar bakery/);
      assert.match(cliPrompts[3], /\$15/);
      assert.doesNotMatch(cliPrompts[2], /Cedar bakery/);
      assert.doesNotMatch(cliPrompts[3], /PRIVATE_BOT_MARKER/);
      assert.match(cliPrompts[0], /Chief Marketing Officer/);
      const resumed = await cli(["ask", "--bot", "CLI Marketing", "--task", "Continue the existing draft", "--json"]);
      assert.equal(resumed.code, 0, resumed.stderr);
      assert.equal(JSON.parse(resumed.stdout).success, true);
      assert.match(cliPrompts[4], /Cedar bakery/);
      assert.match(cliPrompts[4], /\$15/);
      const before = modelCalls;
      assert.equal((await cli(["status"])).code, 0);
      assert.equal((await cli(["models"])).code, 0);
      assert.equal(modelCalls, before, "CLI status and catalog reads never start model work");
      const blocked = await cli(["ask", "--task", "Publish this campaign message", "--json"]);
      assert.equal(blocked.code, 2);
      assert.equal(blocked.stdout, "");
      assert.match(blocked.stderr, /approval/);
      assert.equal(modelCalls, before, "a piped task cannot implicitly approve external effects");
      await assert.rejects(readdir(join(directory, ".browser-agent-task-memory")), /ENOENT/);
      assert.ok((await readdir(join(dataRoot, ".browser-agent-task-memory"))).length > 0);
    });
    await t.test("CLI denies piped file writes and the transport only executes a separately approved write", async () => {
      scenario = "cli-approval";
      cliToolCalls = 0;
      const denied = await cli(["ask", "--task", "Create a local note", "--json", "--bot", "CLI Denied"]);
      assert.equal(denied.code, 0, denied.stderr);
      await assert.rejects(readFile(join(directory, "cli-approved.txt")));
      const client = new TerminalClient(base);
      let approvals = 0;
      await client.run({ task: "Create a local note", botName: "CLI Approved", interactionMode: "chat", agentEngine: "cheap" }, {
        signal: AbortSignal.timeout(10_000), approve: async description => { approvals++; assert.match(description, /cli-approved/); return true; }
      });
      assert.equal(approvals, 1);
      assert.equal(await readFile(join(directory, "cli-approved.txt"), "utf8"), "explicitly approved");
    });
    await t.test("CLI follows bounded specialist discussion through the final synthesis", async () => {
      scenario = "repeat"; coordinatorCalls = 0; workerCalls = 0; finalCalls = 0;
      const result = await cli(["ask", "--bot", "CLI Coordinator", "--task", "Diagnose why this page has no clicks", "--json"]);
      assert.equal(result.code, 0, result.stderr + logs);
      assert.equal(JSON.parse(result.stdout).summary, finalAnswer);
      assert.equal(JSON.parse(result.stdout).discussionFinal, true);
      assert.equal(finalCalls, 1);
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
    await t.test("interrupting a terminal run leaves another bot running", async () => {
      scenario = "async"; asyncStarted.length = 0; releaseAsync.clear();
      const client = new TerminalClient(base);
      const abort = new AbortController();
      const first = client.run({ task: "ASYNC_A", botName: "CLI Cancel", interactionMode: "chat", agentEngine: "cheap" }, { signal: abort.signal });
      const stopped = assert.rejects(first, /terminal interruption/);
      const other = client.run({ task: "ASYNC_B", botName: "CLI Continue", interactionMode: "chat", agentEngine: "cheap" }, { signal: AbortSignal.timeout(10_000) });
      await waitFor(async () => asyncStarted, values => values.includes("ASYNC_A") && values.includes("ASYNC_B"));
      abort.abort(new Error("terminal interruption"));
      await stopped;
      const status = await fetch(base + "/api/status").then(r => r.json());
      assert.ok(status.activeRuns.some((run: any) => run.botName === "CLI Continue"));
      releaseAsync.get("ASYNC_A")!(); releaseAsync.get("ASYNC_B")!();
      assert.equal((await other).success, true);
    });
    await t.test("reset waits for the selected run, cancels its queue and leaves another bot working", async () => {
      scenario = "async"; asyncStarted.length = 0; releaseAsync.clear();
      const enqueue = async (botName: string, task: string) => fetch(base + "/api/run/queue", { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ task, botName, interactionMode: "chat", agentEngine: "cheap", model: "integration-model" }) }).then(r => r.json());
      await enqueue("Reset Running A", "ASYNC_A");
      const b = await enqueue("Reset Running B", "ASYNC_B");
      const c = await enqueue("Reset Running A", "ASYNC_C");
      await waitFor(async () => asyncStarted, values => values.includes("ASYNC_A") && values.includes("ASYNC_B"));
      const reset = await fetch(base + "/api/conversations/reset", { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ scope: "bot", botName: "Reset Running A", confirm: true }) });
      assert.equal(reset.status, 200, await reset.text());
      assert.equal((await fetch(base + "/api/run/jobs/" + c.id).then(r => r.json())).status, "cancelled");
      assert.equal((await fetch(base + "/api/run/jobs/" + b.id).then(r => r.json())).status, "running");
      assert.equal(asyncStarted.includes("ASYNC_C"), false);
      releaseAsync.get("ASYNC_A")!(); releaseAsync.get("ASYNC_B")!();
      await waitFor(() => fetch(base + "/api/run/jobs/" + b.id).then(r => r.json()), job => job.status === "completed");
      await assert.rejects(readFile(join(dataRoot, ".browser-agent-task-memory", "Reset_Running_A.json")), /ENOENT/);
      assert.match(await readFile(join(dataRoot, ".browser-agent-task-memory", "Reset_Running_B.json"), "utf8"), /ASYNC_B/);
    });
    await t.test("the whole UI boots and two chat results stay in their own conversations", async () => {
      scenario = "async";
      const uiStateResponse = await fetch(base + "/uiState.js");
      assert.equal(uiStateResponse.status, 200);
      assert.match(uiStateResponse.headers.get("content-type") || "", /javascript/);
      assert.match(await uiStateResponse.text(), /OpenBuddyUI/);
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
        assert.deepEqual(errors, [], "UI initialization must not stop before rendering bot icons");
        const avatars = page.locator('.template-card[data-name] .template-avatar');
        assert.ok(await avatars.count() > 0);
        assert.equal(await avatars.locator(':scope > *').count(), await avatars.count(), "every catalog bot has a rendered icon");
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
    await t.test("Settings resets one bot or all bots while retaining roles and rejecting stale history", async () => {
      const before = modelCalls;
      const denied = await fetch(base + "/api/conversations/reset", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scope: "all", confirm: true }) });
      assert.equal(denied.status, 403);
      const unconfirmed = await fetch(base + "/api/conversations/reset", { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ scope: "all" }) });
      assert.equal(unconfirmed.status, 400);
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
        await page.route("https://fonts.**/*", route => route.abort());
        await page.addInitScript(() => {
          if (localStorage.getItem("reset-fixture")) return;
          localStorage.setItem("reset-fixture", "1");
          localStorage.setItem("agentFireworksAgentsV2", JSON.stringify([
            { id: "reset-a", name: "Reset A", description: "Keep A role", transcript: [{ role: "user", html: "Old A goal" }] },
            { id: "reset-b", name: "Reset B", description: "Keep B role", transcript: [{ role: "user", html: "Old B goal" }] }
          ]));
          localStorage.setItem("openBotsComposerDrafts", JSON.stringify({ "reset-a": "A unfinished draft", "reset-b": "B unfinished draft" }));
          localStorage.setItem("openBotsSelectedBot", "reset-a");
        });
        await page.goto(base, { waitUntil: "domcontentloaded" });
        await page.locator('#agent-list .agent-row[data-agent-id="reset-a"]').click();
        await page.locator("#header-settings-btn").click();
        await page.selectOption("#conversation-reset-target", "reset-a");
        await page.locator("#conversation-reset-button").click();
        await page.locator("#conversation-reset-cancel").click();
        assert.equal(await page.locator("#conversation-reset-confirm").isVisible(), false);
        await page.locator("#conversation-reset-button").click();
        await page.locator("#conversation-reset-commit").click();
        await page.waitForFunction(() => document.querySelector("#conversation-reset-status")!.textContent!.includes("Conversations reset"));
        let stored = await page.evaluate(() => JSON.parse(localStorage.getItem("agentFireworksAgentsV2")!));
        assert.deepEqual(stored.find((bot: any) => bot.id === "reset-a").transcript, []);
        assert.equal(stored.find((bot: any) => bot.id === "reset-a").description, "Keep A role");
        assert.equal(stored.find((bot: any) => bot.id === "reset-b").transcript[0].html, "Old B goal");
        let drafts = await page.evaluate(() => JSON.parse(localStorage.getItem("openBotsComposerDrafts")!));
        assert.equal(drafts["reset-a"], undefined); assert.equal(drafts["reset-b"], "B unfinished draft");
        const stale = await fetch(base + "/api/run/queue", { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ task: "Resume", botName: "Reset A", interactionMode: "chat", conversationResetAt: 0, conversationTurns: [{ role: "user", text: "Old A goal" }] }) });
        assert.equal(stale.status, 409); assert.equal((await stale.json()).code, "conversation_reset_required");
        await page.selectOption("#conversation-reset-target", "all");
        await page.locator("#conversation-reset-button").click();
        await page.locator("#conversation-reset-commit").click();
        await page.waitForFunction(() => document.querySelector("#conversation-reset-status")!.textContent!.includes("Conversations reset"));
        stored = await page.evaluate(() => JSON.parse(localStorage.getItem("agentFireworksAgentsV2")!));
        assert.ok(stored.every((bot: any) => bot.transcript.length === 0));
        drafts = await page.evaluate(() => JSON.parse(localStorage.getItem("openBotsComposerDrafts")!));
        assert.equal(drafts["reset-b"], undefined);
        await page.reload();
        await page.locator('#agent-list .agent-row[data-agent-id="reset-b"]').click();
        assert.doesNotMatch(await page.locator("#messages").innerText(), /Old [AB] goal/);
        assert.equal(await page.locator("#prompt").inputValue(), "");
        assert.deepEqual(errors, []);
      } finally { await browser.close(); }
      assert.equal(modelCalls, before, "opening settings and resetting never starts a model");
      const state = await fetch(base + "/api/conversations/state").then(r => r.json());
      assert.ok(state.all > 0);
      assert.deepEqual(await readdir(join(dataRoot, ".browser-agent-task-memory")), []);
    });
  } finally {
    for (const release of releaseAsync.values()) release();
    child.kill("SIGTERM");
    if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
    await new Promise<void>(done => provider.close(() => done()));
  }
});
