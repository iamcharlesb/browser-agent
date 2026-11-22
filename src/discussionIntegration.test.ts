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
import { emptyTaskMemory, rememberTurn, saveTaskMemory } from "./taskMemory";
import { botIdFromName } from "./learningStore";

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

test("real server discussion lifecycle terminates repetition, worker failure, and policy rejection", { timeout: 120_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "bounded-discussion-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const compiled = join(directory, "runtime");
  await mkdir(compiled);
  for (const file of await readdir(__dirname)) {
    if (file.endsWith(".js") && !file.endsWith(".test.js")) await copyFile(join(__dirname, file), join(compiled, file));
  }
  await symlink(resolve(__dirname, "..", "node_modules"), join(directory, "node_modules"), "dir");
  await cp(resolve(__dirname, "..", "config"), join(directory, "config"), { recursive: true });
  await mkdir(join(directory, "static"));
  await cp(resolve(__dirname, "..", "static", "avatars"), join(directory, "static", "avatars"), { recursive: true });
  await cp(resolve(__dirname, "..", "docs"), join(directory, "docs"), { recursive: true });
  await copyFile(resolve(__dirname, "..", "README.md"), join(directory, "README.md"));
  for (const file of ["index.html", "browserRuntime.js", "botCatalog.js", "uiState.js", "responseMarkdown.js", "runStream.js", "artifactPreview.js", "pilo-logo.png", "pilo-icon.png"]) await copyFile(resolve(__dirname, "..", "static", file), join(directory, "static", file));
  let capturedPersonaPrompt = "";
  const cliPrompts: string[] = [];
  let cliToolCalls = 0;
  const teamPrompts: Array<{ name: string; text: string; tools: string[] }> = [];
  let teamFinalPrompt = "";
  let workflowPlanCalls = 0, dependencyPrompt = "";
  let scenario = "repeat", modelCalls = 0, coordinatorCalls = 0, workerCalls = 0, finalCalls = 0;
  const asyncStarted: string[] = [];
  const releaseAsync = new Map<string, () => void>();
  const finalAnswer = "Low visibility explains the observed click count. The underlying ranking cause is unverified; compare the page with the relevant search results next.";
  const provider = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    modelCalls++;
    if (scenario === "workflow-delivery") {
      res.setHeader("content-type", "application/json");
      const instructions = String(body.instructions || "");
      if (instructions.startsWith("You are Workflow Planner.")) {
        if (workflowPlanCalls++ === 0) res.end(JSON.stringify(response([{ id: "fc_plan", type: "function_call", call_id: "plan1", name: "plan_workflow", arguments: JSON.stringify({ action: "create", tasks: [
          { id: "copy", botName: "SEO Specialist", task: "Write three landscaping headlines", executionMode: "text", expectedOutput: "text", acceptanceCriteria: "Three specific headlines" },
          { id: "review", botName: "Blog Writer", task: "Review the supplied headline options", dependsOn: ["copy"], executionMode: "text", expectedOutput: "text", acceptanceCriteria: "Choose one headline and explain why" }
        ] }) }], modelCalls)));
        else res.end(JSON.stringify(response(message("Saved the team delivery draft. Review and start it in Workflows."), modelCalls)));
      } else if (instructions.startsWith("You are SEO Specialist.")) res.end(JSON.stringify(response(message("DELIVERED_HEADLINES: landscaping websites; quote requests; local proof."), modelCalls)));
      else { dependencyPrompt = JSON.stringify(body); res.end(JSON.stringify(response(message("Selected the quote-request headline based on the supplied options."), modelCalls))); }
      return;
    }
    if (scenario === "unknown-roster") {
      const names = (body.tools || []).map((tool: any) => tool.name || tool.function?.name);
      res.setHeader("content-type", "application/json");
      if (names.includes("delegate_to_bot")) res.end(JSON.stringify(response([{ id: "unknown_call", type: "function_call", call_id: "unknown_peer", name: "delegate_to_bot", arguments: JSON.stringify({ targetBotName: "Imaginary Worker", task: "Give a status report" }) }], modelCalls)));
      else { teamFinalPrompt = JSON.stringify(body); res.end(JSON.stringify(response(message("That target is not a saved bot. No contact happened."), modelCalls))); }
      return;
    }
    if (scenario === "team" || scenario === "team-failure") {
      const instructions = String(body.instructions || "");
      const name = /^You are ([^.]+)\./.exec(instructions)?.[1] || "unknown";
      const names = (body.tools || []).map((tool: any) => tool.name || tool.function?.name);
      res.setHeader("content-type", "application/json");
      if (names.every((name: string) => ["finish_task", "fail_task", "plan_workflow"].includes(name))) {
        teamFinalPrompt = JSON.stringify(body); finalCalls++;
        res.end(JSON.stringify(response(message("The requested team reports have been collected. Here are the supported next steps; no recurring work was scheduled."), modelCalls)));
      } else {
        teamPrompts.push({ name, text: instructions, tools: names });
        if (scenario === "team-failure" && name === "SEO Specialist") { res.statusCode = 400; res.end(JSON.stringify({ error: { message: "Synthetic SEO outage", type: "invalid_request_error" } })); }
        else res.end(JSON.stringify(response(message(`${name}: a concrete role-specific next action, with historical work clearly labelled.`), modelCalls)));
      }
      return;
    }
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
    if (names.every((name: string) => ["finish_task", "fail_task", "plan_workflow"].includes(name))) {
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
    await waitFor(() => fetch(base + "/api/status").then(r => r.json()), value => Boolean(value)).catch(error => { throw new Error(error.message + "\nIsolated server log:\n" + logs); });
    await t.test("HTTP boundary blocks cross-origin commands and approvals before any work", async () => {
      const before = modelCalls;
      for (const endpoint of ["/api/terminal", "/api/run", "/api/approval", "/api/schedules", "/api/learn"]) {
        for (const origin of [undefined, "https://example.invalid", "null"]) {
          const response = await fetch(base + endpoint, { method: "POST",
            headers: { "content-type": "text/plain", ...(origin ? { origin } : {}) },
            body: JSON.stringify({ command: "pwd", approved: true, task: "Do work" }) });
          assert.equal(response.status, 403, endpoint);
        }
      }
      assert.equal(modelCalls, before);
      const allowed = await fetch(base + "/api/terminal", { method: "POST",
        headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ command: "pwd" }) });
      assert.equal(allowed.status, 200);
      assert.equal((await allowed.json()).ok, true);
      for (const asset of ["/responseMarkdown.js", "/runStream.js"]) {
        const response = await fetch(base + asset);
        assert.equal(response.status, 200);
        assert.match(response.headers.get("content-type") || "", /javascript/);
      }
    });
    await t.test("unavailable coordination models are rejected before starting or queuing specialists", async () => {
      const before = modelCalls;
      const jobsBefore = await fetch(base + "/api/run/jobs").then(r => r.json());
      for (const model of ["local-engine", "grok-unconfigured-test"]) {
        for (const endpoint of ["/api/run", "/api/run/queue"]) {
          const res = await fetch(base + endpoint, { method: "POST", headers: { "content-type": "application/json", origin: base },
            body: JSON.stringify({ task: "Coordinate with all bots", botName: "Coordinator", interactionMode: "chat", model,
              workspaceBots: [{ id: "coordinator", name: "Coordinator" }, { id: "seo", name: "SEO Specialist" }] }) });
          assert.equal(res.status, 400);
          const error = await res.json();
          assert.match(error.detail, model === "local-engine" ? /cannot run bot consultations/ : /xAI is not connected/);
          if (model !== "local-engine") { assert.equal(error.code, "model_not_configured"); assert.equal(error.provider, "xai"); }
        }
      }
      assert.equal(modelCalls, before);
      assert.deepEqual(await fetch(base + "/api/run/jobs").then(r => r.json()), jobsBefore);
      const state = await fetch(base + "/api/status").then(r => r.json());
      assert.equal(state.isRunning, false);
    });
    await t.test("browser profiles switch separate Chrome endpoints and retain Default", async () => {
      const post = (body: unknown, origin = true) => fetch(base + "/api/browser/profiles", { method: "POST", headers: { "content-type": "application/json", ...(origin ? { Origin: base } : {}) }, body: JSON.stringify(body) });
      assert.equal((await post({ action: "create", name: "Denied" }, false)).status, 403);
      const created = await post({ action: "create", name: "Test Work" }).then(r => r.json());
      const profile = created.profiles.find((item: any) => item.name === "Test Work");
      assert.ok(profile);
      const switched = await post({ action: "switch", id: profile.id }).then(r => r.json());
      assert.equal(switched.activeId, profile.id);
      assert.equal(switched.sessionMode, "cdp");
      const chrome = await fetch(base + "/api/chrome/cdp").then(r => r.json());
      assert.ok(chrome.endpoint.endsWith(":" + profile.port));
      assert.ok(chrome.profileDir.endsWith(profile.id));
      assert.equal((await post({ action: "switch", id: "default" }).then(r => r.json())).activeId, "default");
    });
    await t.test("profile switcher creates and switches browser sessions without model calls", async () => {
      const before = modelCalls;
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.route("https://fonts.**/*", route => route.abort());
        await page.goto(base, { waitUntil: "domcontentloaded" });
        await page.locator('#browser-profiles-btn').click();
        await page.locator('#browser-profile-name').fill('UI Client');
        await page.getByRole('button', { name: 'Create profile', exact: true }).click();
        await page.waitForFunction(() => document.getElementById('browser-profiles-btn')!.textContent!.includes('UI Client'));
        const state = await fetch(base + '/api/browser/profiles').then(r => r.json());
        assert.equal(state.profiles.find((profile: any) => profile.id === state.activeId).name, 'UI Client');
        await page.selectOption('#browser-profile-select', 'default');
        await page.waitForFunction(() => document.getElementById('browser-profiles-btn')!.textContent === 'Profiles: Default');
        assert.equal((await fetch(base + '/api/browser/profiles').then(r => r.json())).activeId, 'default');
        assert.equal(modelCalls, before);
      } finally { await browser.close(); }
    });
    await t.test("scheduled permissions stay bound to the creation profile and mismatches wake no model", async () => {
      const before = modelCalls;
      const headers = { "content-type": "application/json", Origin: base };
      const createdResponse = await fetch(base + "/api/schedules", { method: "POST", headers, body: JSON.stringify({
        task: "Prepare a status note", scheduleType: "once", runAt: new Date(Date.now() + 3000).toISOString(),
        grant: { browser: true, outward: true, maxOutwardActions: 1 }
      }) });
      assert.equal(createdResponse.status, 201);
      const created = (await createdResponse.json()).schedule;
      assert.equal(created.browserProfileId, "default");
      assert.equal(created.grant.maxOutwardActions, 1);
      const profiles = await fetch(base + "/api/browser/profiles").then(r => r.json());
      const other = profiles.profiles.find((item: any) => item.id !== "default");
      try {
        assert.equal((await fetch(base + "/api/browser/profiles", { method: "POST", headers, body: JSON.stringify({ action: "switch", id: other.id }) })).status, 200);
        const waiting = await waitFor(() => fetch(base + "/api/schedules").then(r => r.json()), value => value.schedules.some((item: any) => item.id === created.id && item.status === "queued"));
        assert.match(waiting.schedules.find((item: any) => item.id === created.id).lastResult, /Waiting for the browser profile/);
        assert.equal(modelCalls, before);
      } finally {
        await fetch(base + "/api/schedules/" + created.id, { method: "DELETE", headers });
        await fetch(base + "/api/browser/profiles", { method: "POST", headers, body: JSON.stringify({ action: "switch", id: "default" }) });
      }
    });
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
          const res = await fetch(base + "/api/run", { method: "POST", headers: { "content-type": "application/json", origin: base },
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
      const res = await fetch(base + "/api/run", { method: "POST", headers: { "content-type": "application/json", origin: base },
        body: JSON.stringify({ task: "Suggest the next experiment.", botName: "My AI Lab", profileId: "neural-architect",
          botInstructions: "Inspect our support dataset before proposing changes.", interactionMode: "chat", agentEngine: "cheap", model: "integration-model" }) });
      assert.equal(res.status, 200);
      const submission = await res.json();
      const final = terminalEvents(await fetch(base + "/api/events?runId=" + submission.runId).then(r => r.text())).at(-1)!;
      assert.ok(final);
      assert.match(capturedPersonaPrompt, /SOUL/);
      assert.match(capturedPersonaPrompt, /tiny working baseline/);
      assert.match(capturedPersonaPrompt, /OWNER BOT PROFILE/);
      assert.match(capturedPersonaPrompt, /FORMAT MATRIX/);
      assert.match(capturedPersonaPrompt, /Inspect our support dataset/);
      assert.doesNotMatch(capturedPersonaPrompt, /customer-obsessed/);
    });
    const cli = async (args: string[], input = "") => {
      const process = spawn(global.process.execPath, [join(compiled, "piloCli.js"), ...args, "--server", base], {
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
    for (const engine of ["cheap", "openai-sdk"] as const) await t.test(engine + " chat plans a dormant workflow and explicit start passes delivered results to the next owner", async () => {
      scenario = "workflow-delivery"; workflowPlanCalls = 0; dependencyPrompt = "";
      const client = new TerminalClient(base);
      await client.run({ task: "Prepare a team delivery draft", botName: "Workflow Planner", interactionMode: "chat", agentEngine: engine,
        workspaceBots: [{ id: "seo", name: "SEO Specialist", botInstructions: "SAVED_SEO_ROLE: produce headlines" }, { id: "writer", name: "Blog Writer" }] } as any, { signal: AbortSignal.timeout(12_000) });
      const drafts = await fetch(base + "/api/workflows").then(r => r.json());
      const draft = drafts.workflows.find((item: any) => item.status === "draft");
      assert.ok(draft);
      assert.ok(draft.tasks.every((item: any) => item.status === "blocked"));
      assert.equal(dependencyPrompt, "", "draft planning did not start workers");
      const started = await fetch(base + `/api/workflows/${draft.id}/start`, { method: "POST", headers: { Origin: base } });
      assert.equal(started.status, 202);
      const completed = await waitFor(() => fetch(base + `/api/workflows/${draft.id}`).then(r => r.json()), value => ["completed", "failed"].includes(value.workflow.status));
      assert.equal(completed.workflow.status, "completed");
      assert.match(completed.workflow.tasks[0].result.summary, /DELIVERED_HEADLINES/);
      assert.match(dependencyPrompt, /DELIVERED_HEADLINES/);
      assert.match(dependencyPrompt, /DELIVERY CONTRACT/);
      assert.ok(completed.workflow.tasks.every((item: any) => item.attempts === 1));
    });
    await t.test("workflow cancellation stops its active job and prevents dependent dispatch", async () => {
      scenario = "async";
      const created = await fetch(base + "/api/workflows", { method: "POST", headers: { "content-type": "application/json", Origin: base }, body: JSON.stringify({ tasks: [
        { id: "build", botName: "Cancel Workflow Builder", task: "ASYNC_C", model: "integration-model", executionMode: "text" },
        { id: "review", botName: "Cancel Workflow Reviewer", task: "Review the draft", model: "integration-model", executionMode: "text", dependsOn: ["build"] }
      ] }) }).then(r => r.json());
      const id = created.workflow.id;
      assert.equal((await fetch(base + `/api/workflows/${id}/start`, { method: "POST", headers: { Origin: base } })).status, 202);
      await waitFor(async () => asyncStarted, value => value.includes("ASYNC_C"));
      assert.equal((await fetch(base + `/api/workflows/${id}/cancel`, { method: "POST" })).status, 403);
      const cancelled = await fetch(base + `/api/workflows/${id}/cancel`, { method: "POST", headers: { Origin: base } }).then(r => r.json());
      releaseAsync.get("ASYNC_C")!();
      assert.equal(cancelled.workflow.status, "cancelled");
      assert.ok(cancelled.workflow.tasks.every((task: any) => task.status === "cancelled"));
      const jobs = await fetch(base + "/api/run/jobs").then(r => r.json());
      assert.ok(jobs.jobs.filter((job: any) => job.input.workflowId === id).every((job: any) => job.status === "cancelled"));
      assert.equal(jobs.jobs.some((job: any) => job.input.workflowId === id && job.input.workflowTaskId === "review"), false);
    });
    for (const engine of ["cheap", "openai-sdk"] as const) for (const fail of [false, true]) await t.test(engine + " four-bot coordination uses saved identities, profiles and work context" + (fail ? " and continues past one failure" : ""), async () => {
      scenario = fail ? "team-failure" : "team"; teamPrompts.length = 0; finalCalls = 0;
      const peers = ["SEO Specialist", "Blog Writer", "Reddit Community Growth", "Instagram Follower Growth"].map((name, index) => ({ id: `team-${index}`, name,
        botInstructions: `OWNER_ROLE_${index}: use your saved specialist responsibilities; do not publish anything.`, ...(index === 3 ? { profileId: "chief-marketing-officer" } : {}) }));
      const before = new Map<string, string>();
      for (const [index, peer] of peers.entries()) {
        await saveTaskMemory(join(dataRoot, ".browser-agent-task-memory"), botIdFromName(peer.name), rememberTurn(emptyTaskMemory(), "agent", `OWN_WORK_${index}: a dated prior result, not current verification.`));
        before.set(peer.name, await readFile(join(dataRoot, ".browser-agent-task-memory", botIdFromName(peer.name) + ".json"), "utf8"));
      }
      const client = new TerminalClient(base);
      const owner = fail ? "Team Coordinator Failure" : "Team Coordinator";
      await saveTaskMemory(join(dataRoot, ".browser-agent-task-memory"), botIdFromName(owner),
        rememberTurn(emptyTaskMemory(), "user", "We are not going to spend a penny. Prepare organic marketing for MagicSite landscapers."));
      const result = await client.run({ task: "can you work with all the bots and keep things ready?", botName: owner, interactionMode: "chat", agentEngine: engine,
        workspaceBots: peers } as any, { signal: AbortSignal.timeout(12_000) });
      assert.equal(result.discussionFinal, true);
      assert.equal(teamPrompts.length, 4, logs);
      assert.equal(finalCalls, 1);
      for (const [index, peer] of peers.entries()) {
        const prompt = teamPrompts.find(item => item.name === peer.name)!;
        assert.ok(prompt, peer.name + " was actually contacted");
        assert.match(prompt.text.split("SOUL")[0], new RegExp(`OWNER_ROLE_${index}`));
        assert.match(prompt.text, new RegExp(`OWN_WORK_${index}`));
        assert.match(prompt.text, /Latest explicit user spending constraint.*not going to spend a penny/);
        assert.match(prompt.text, /MagicSite landscapers/);
        assert.match(prompt.text, /usable role-specific draft or analysis/);
        // Consulted specialists may research and compute but never act: no browser, files, terminal, paid or outward tools.
        assert.deepEqual(prompt.tools.slice().sort(), ["calculate", "fail_task", "fetch_url", "finish_task", "knowledge_base", "web_search"]);
        assert.equal(await readFile(join(dataRoot, ".browser-agent-task-memory", botIdFromName(peer.name) + ".json"), "utf8"), before.get(peer.name), "consultation did not replace the worker's user task");
      }
      assert.deepEqual(result.coordination.requested, peers.map(peer => peer.name));
      assert.equal(result.coordination.completed.length, fail ? 3 : 4);
      assert.equal(result.coordination.failed.length, fail ? 1 : 0);
      assert.deepEqual(result.coordination.notContacted, []);
      assert.match(teamFinalPrompt, /APPLICATION VERIFIED COVERAGE/);
      assert.match(teamFinalPrompt, /No ongoing|no background|no recurring|not schedule|did not schedule/);
    });
    await t.test("coordination status answers the pasted SEO contact question from receipts without another model call", async () => {
      const before = modelCalls;
      const result = await cli(["ask", "--bot", "Team Coordinator", "--model", "local-engine", "--task", "did you talked with SEO bot?", "--json"]);
      assert.equal(result.code, 0, result.stderr);
      const summary = JSON.parse(result.stdout).summary;
      assert.match(summary, /SEO Specialist: completed/);
      assert.doesNotMatch(summary, /Wikipedia|Local Research Results/);
      const status = await fetch(base + "/api/coordination?bot=Team%20Coordinator").then(r => r.json());
      assert.equal(status.consultations.filter((item: any) => item.toBot === "SEO Specialist" && item.status === "completed").length, 2);
      assert.equal(modelCalls, before);
    });
    await t.test("a five-bot request reports the fifth uncontacted bot at the configured four-consultation limit", async () => {
      scenario = "team"; teamPrompts.length = 0; finalCalls = 0;
      const peers = ["SEO Specialist", "Blog Writer", "Reddit Community Growth", "Instagram Follower Growth", "Funnel Specialist"].map((name, index) => ({ id: `cap-${index}`, name }));
      const result = await new TerminalClient(base).run({ task: "Coordinate with all bots on the organic plan", botName: "Limited Coordinator", interactionMode: "chat", agentEngine: "cheap", workspaceBots: peers } as any, { signal: AbortSignal.timeout(12_000) });
      assert.equal(teamPrompts.length, 4); assert.equal(finalCalls, 1);
      assert.deepEqual(result.coordination.notContacted, ["Funnel Specialist"]);
      assert.equal(result.coordination.completed.length, 4);
    });
    await t.test("a busy saved SEO bot queues its consultation and replies when its existing task finishes", async () => {
      scenario = "async"; asyncStarted.length = 0; releaseAsync.clear(); teamPrompts.length = 0;
      const busy = await fetch(base + "/api/run/queue", { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ task: "ASYNC_A", botName: "SEO Specialist", interactionMode: "chat", model: "integration-model", agentEngine: "cheap" }) }).then(r => r.json());
      await waitFor(async () => asyncStarted, values => values.includes("ASYNC_A"));
      const submission = await fetch(base + "/api/run", { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ task: "Check wth seo", botName: "Busy Coordinator", interactionMode: "chat", agentEngine: "cheap", workspaceBots: [{ id: "saved-seo", name: "SEO Specialist", botInstructions: "Use the existing SEO role" }] }) }).then(r => r.json());
      const original = terminalEvents(await fetch(base + "/api/events?runId=" + submission.runId).then(r => r.text())).at(-1)!;
      await waitFor(() => fetch(base + "/api/run/jobs").then(r => r.json()), data => data.jobs.some((job: any) => job.input.consultationId && job.input.discussionId === original.discussionId && job.status === "queued"));
      assert.equal((await fetch(base + "/api/run/jobs/" + busy.id).then(r => r.json())).status, "running");
      scenario = "team"; releaseAsync.get("ASYNC_A")!();
      const state = await waitFor(() => fetch(base + "/api/discussions/" + original.discussionId).then(r => r.json()), value => value.phase === "completed");
      assert.deepEqual(state.coordination.completed, ["SEO Specialist"]);
      assert.deepEqual(state.coordination.failed, []);
      assert.equal(teamPrompts.length, 1);
      assert.match(teamPrompts[0].text, /ASYNC_A/);
    });
    await t.test("a made-up specialist is rejected against the saved roster without spawning a generic bot", async () => {
      scenario = "unknown-roster";
      const before = modelCalls;
      const result = await new TerminalClient(base).run({ task: "Review a useful marketing check", botName: "Roster Coordinator", interactionMode: "chat", agentEngine: "cheap", workspaceBots: [{ id: "real-seo", name: "SEO Specialist" }] } as any, { signal: AbortSignal.timeout(10_000) });
      assert.equal(modelCalls - before, 2, "only the original coordinator and its final answer ran");
      assert.match(teamFinalPrompt, /No saved workspace bot matches/);
      assert.match(result.summary, /No contact happened/);
      const status = await fetch(base + "/api/coordination?bot=Roster%20Coordinator").then(r => r.json());
      assert.deepEqual(status.consultations, []);
      const calls = modelCalls;
      const reply = await cli(["ask", "--bot", "Roster Coordinator", "--model", "local-engine", "--task", "did you talked with SEO bot?", "--json"]);
      assert.equal(reply.code, 0, reply.stderr);
      assert.match(JSON.parse(reply.stdout).summary, /no recorded specialist contact/);
      assert.equal(modelCalls, calls);
    });
    await t.test("the actual chat UI submits saved roster identities and displays four verified coordination replies", async () => {
      scenario = "team"; teamPrompts.length = 0; finalCalls = 0;
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
        await page.route("https://fonts.**/*", route => route.abort());
        await page.addInitScript(() => {
          localStorage.setItem("agentFireworksAgentsV2", JSON.stringify([
            { id: "ui-coordinator", name: "Marketing Coordinator", description: "Coordinate an organic growth team", transcript: [] },
            ...["SEO Specialist", "Blog Writer", "Reddit Community Growth", "Instagram Follower Growth"].map((name, index) => ({ id: "ui-specialist-" + index, name,
              description: "UI_SAVED_ROLE_" + index, transcript: [{ role: "user", html: "Existing user goal " + index }] }))
          ]));
          localStorage.setItem("openBotsInteractionMode", "chat"); localStorage.setItem("openBotsAgentEngine", "cheap");
        });
        await page.goto(base, { waitUntil: "domcontentloaded" });
        await page.locator('#agent-list .agent-row[data-agent-id="ui-coordinator"]').click();
        await page.waitForFunction(() => Boolean(document.querySelector('#composer-model-select option[value="integration-model"]')));
        await page.selectOption("#composer-model-select", "integration-model");
        await page.locator("#prompt").fill("Coordinate with all the bots on our organic growth strategy; collect their status and next actions.");
        await page.locator("#send-button").click();
        await page.waitForFunction(() => document.querySelector("#messages")!.textContent!.includes("Actual coordination results"));
        const text = await page.locator("#messages").innerText();
        for (const name of ["SEO Specialist", "Blog Writer", "Reddit Community Growth", "Instagram Follower Growth"]) assert.ok(text.includes(name), name);
        assert.equal(await page.locator('#messages section').filter({ hasText: '— findings' }).count(), 4, "receipts expose actual specialist replies without asking again");
        assert.match(text, /concrete role-specific next action/);
        assert.equal(teamPrompts.length, 4); assert.equal(finalCalls, 1);
        const bots = await page.evaluate(() => JSON.parse(localStorage.getItem("agentFireworksAgentsV2")!));
        assert.ok(bots.filter((bot: any) => bot.id.startsWith("ui-specialist-")).every((bot: any) => bot.transcript.length === 1), "consultation replies stayed with their requesting coordinator");
        await page.screenshot({ path: join(tmpdir(), "pilo-team-coordination.png"), fullPage: true });
        await page.selectOption("#composer-model-select", "local-engine");
        await page.waitForFunction(() => !document.getElementById("execution-model-notice")!.hidden);
        assert.match(await page.locator("#execution-model-notice").innerText(), /tools only/);
        assert.deepEqual(errors, []);
      } finally { await browser.close(); }
    });
    await t.test("Huddle setup persists members and each question gathers only the selected bots", async () => {
      scenario = "team"; teamPrompts.length = 0; finalCalls = 0;
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
        const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
        const submitted: any[] = [];
        await page.route(/\/api\/run(?:\/queue)?$/, async route => { submitted.push(route.request().postDataJSON()); await route.continue(); });
        await page.addInitScript(() => {
          if (!localStorage.getItem("agentFireworksAgentsV2")) localStorage.setItem("agentFireworksAgentsV2", JSON.stringify([
            { id: "h-seo", name: "SEO Specialist", description: "HUDDLE_ROLE_SEO search strategy", transcript: [] },
            { id: "h-writer", name: "Blog Writer", description: "HUDDLE_ROLE_WRITER content strategy", transcript: [] },
            { id: "h-founder", name: "Founder Operator", description: "HUDDLE_ROLE_FOUNDER priorities", transcript: [] }
          ]));
          localStorage.setItem("openBotsAgentEngine", "cheap");
        });
        await page.goto(base, { waitUntil: "domcontentloaded" });
        const before = modelCalls;
        await page.getByRole("button", { name: "Create a huddle", exact: true }).click();
        await page.waitForFunction(() => document.querySelector("#huddle-limit")!.textContent!.includes("up to"));
        assert.equal(await page.locator("#huddle-save").isDisabled(), true);
        await page.locator("#huddle-name").fill("Launch planning");
        await page.getByRole("checkbox", { name: "SEO Specialist", exact: true }).check();
        await page.locator("#huddle-search").fill("Blog");
        assert.equal(await page.locator(".huddle-choice:visible").count(), 1);
        await page.getByRole("checkbox", { name: "Blog Writer", exact: true }).check();
        await page.locator("#huddle-search").fill("");
        assert.match(await page.locator("#huddle-count").innerText(), /2.*selected/);
        await page.screenshot({ path: join(tmpdir(), "pilo-huddle-setup.png") });
        assert.equal(modelCalls, before, "opening and selecting participants starts no model work");
        await page.locator("#huddle-save").click();
        assert.equal(await page.locator("#huddle-modal").isVisible(), false);
        assert.equal(await page.locator("#huddle-member-list .huddle-member").count(), 2);
        assert.equal(await page.locator("#prompt").getAttribute("placeholder"), "Ask the huddle…");
        const session = await page.evaluate(() => JSON.parse(localStorage.getItem("agentFireworksAgentsV2")!).find((bot: any) => bot.kind === "huddle"));
        assert.deepEqual(new Set(session.participantIds), new Set(["h-seo", "h-writer"]));
        await page.reload();
        await page.waitForSelector("#huddle-members:not([hidden])");
        assert.equal(modelCalls, before, "reopening a saved session starts no model work");
        await page.waitForFunction(() => Boolean(document.querySelector('#composer-model-select option[value="integration-model"]')));
        await page.selectOption("#composer-model-select", "integration-model");
        await page.locator("#prompt").fill("What should our launch prioritize?");
        await page.locator("#send-button").click();
        await page.waitForFunction(() => document.querySelector("#messages")!.textContent!.includes("Actual coordination results"));
        assert.deepEqual(submitted[0].huddleParticipantIds, session.participantIds);
        assert.equal(submitted[0].interactionMode, "chat");
        assert.equal(submitted[0].autoApprove, false);
        assert.deepEqual(submitted[0].workspaceBots.map((bot: any) => bot.id), ["h-seo", "h-writer"]);
        assert.deepEqual(new Set(teamPrompts.map(item => item.name)), new Set(["SEO Specialist", "Blog Writer"]));
        assert.equal(await page.locator("#messages section").filter({ hasText: "— findings" }).count(), 2);
        assert.ok(teamPrompts[1].text.includes(teamPrompts[0].name), "later speakers receive the attributed shared discussion context");
        await page.waitForFunction(() => document.querySelector("#status-badge-text")!.textContent === "Ready");
        teamPrompts.length = 0;
        await page.locator("#edit-huddle").click();
        await page.waitForFunction(() => document.querySelector("#huddle-limit")!.textContent!.includes("up to"));
        await page.getByRole("checkbox", { name: "Blog Writer", exact: true }).uncheck();
        await page.getByRole("checkbox", { name: "Founder Operator", exact: true }).check();
        await page.locator("#huddle-save").click();
        await page.waitForTimeout(450);
        await page.locator("#prompt").fill("How does that change our next step?");
        await page.locator("#send-button").click();
        await page.waitForFunction(() => document.querySelectorAll("#messages section").length >= 4, null, { timeout: 10000 }).catch(async error => {
          throw new Error(error.message + "\n" + JSON.stringify({ submitted, teamPrompts, text: await page.locator("#messages").innerText(), status: await page.locator("#status").innerText() }));
        });
        assert.deepEqual(new Set(teamPrompts.map(item => item.name)), new Set(["SEO Specialist", "Founder Operator"]));
        assert.equal(await page.locator("#messages").innerText().then(text => text.includes("What should our launch prioritize?")), true);
        await page.waitForFunction(() => document.querySelector("#status-badge-text")!.textContent === "Ready");
        scenario = "async"; asyncStarted.length = 0; releaseAsync.clear();
        await page.waitForTimeout(450);
        await page.locator("#prompt").fill("UI_C");
        await page.locator("#send-button").click();
        await waitFor(async () => asyncStarted, values => values.includes("UI_C"));
        await page.waitForTimeout(450);
        await page.locator("#prompt").fill("UI_A");
        await page.locator("#send-button").click();
        await page.waitForSelector(".queued-command");
        await page.locator("#stop-run-btn").click();
        await page.waitForFunction(() => document.querySelector("#status-badge-text")!.textContent === "Ready");
        releaseAsync.get("UI_C")!();
        await page.waitForTimeout(400);
        assert.deepEqual(asyncStarted, ["UI_C"], "Stop cancels the remaining speakers and queued follow-up");
        assert.equal(await page.locator("#command-queue").isVisible(), false);
        assert.deepEqual(errors, []);
      } finally { await browser.close(); }
    });
    await t.test("Huddles and the main selector share all built-ins and custom bots without pre-adding them", async () => {
      scenario = "team"; teamPrompts.length = 0;
      const browser = await chromium.launch({headless:true});
      try {
        const page = await browser.newPage();
        const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
        await page.addInitScript(() => {
          localStorage.setItem("agentFireworksAgentsV2", JSON.stringify([
            {id:"renamed-pichai",name:"My Platform Advisor",profileId:"sundar-pichai",transcript:[]},
            {id:"my-custom",name:"My Custom Reviewer",description:"Review assumptions",transcript:[]}
          ]));
          localStorage.setItem("openBotsAgentEngine","cheap");
        });
        await page.goto(base);
        const catalogNames = await page.locator(".template-card[data-name]").evaluateAll(cards => cards.map(card=>card.getAttribute("data-name")!).sort());
        assert.ok(catalogNames.includes("Wall Street Analyst"));
        assert.ok(catalogNames.includes("Goldman Sachs Analyst"));
        assert.ok(catalogNames.includes("My Custom Reviewer"));
        assert.ok(catalogNames.includes("My Platform Advisor"));
        assert.equal(catalogNames.includes("Sundar Pichai"),false,"a renamed saved profile is not duplicated");
        const before = modelCalls;
        await page.locator("#new-huddle-button").click();
        const pickerNames = await page.locator("#huddle-choices input").evaluateAll(inputs=>inputs.map(input=>input.getAttribute("aria-label")!).sort());
        assert.deepEqual(pickerNames,catalogNames,"both selectors consume the same catalog");
        assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem("agentFireworksAgentsV2")!).length),2,"opening the picker does not seed the roster");
        await page.waitForFunction(()=>document.querySelector("#huddle-limit")!.textContent!.includes("up to"));
        await page.locator("#huddle-name").fill("Research review");
        for(const name of ["Wall Street Analyst","Goldman Sachs Analyst","My Custom Reviewer"]) await page.getByRole("checkbox",{name,exact:true}).check();
        await page.locator("#huddle-save").click();
        const saved = await page.evaluate(()=>JSON.parse(localStorage.getItem("agentFireworksAgentsV2")!));
        const session = saved.find((bot:any)=>bot.kind === "huddle");
        assert.equal(new Set(session.participantIds).size,3,"newly added bot identities are distinct");
        assert.equal(saved.length,5,"only selected unadded bots and the huddle are saved");
        assert.ok(saved.some((bot:any)=>bot.profileId === "wall-street-analyst"));
        assert.ok(saved.some((bot:any)=>bot.profileId === "goldman-sachs-analyst"));
        assert.equal(modelCalls,before,"selecting catalog participants starts no model work");
        await page.waitForFunction(()=>Boolean(document.querySelector('#composer-model-select option[value="integration-model"]')));
        await page.selectOption("#composer-model-select","integration-model");
        await page.locator("#prompt").fill("What assumptions should we check?");
        await page.locator("#send-button").click();
        await page.waitForFunction(()=>document.querySelector("#messages")!.textContent!.includes("Actual coordination results"));
        assert.deepEqual(new Set(teamPrompts.map(item=>item.name)),new Set(["Wall Street Analyst","Goldman Sachs Analyst","My Custom Reviewer"]));
        assert.deepEqual(errors,[]);
      } finally { await browser.close(); }
    });
    await t.test("invalid Huddle participants are rejected before queuing or model work", async () => {
      const before = modelCalls;
      const workspaceBots = [{ id: "h-a", name: "First" }, { id: "h-b", name: "Second" }];
      for (const endpoint of ["/api/run", "/api/run/queue"]) {
        const response = await fetch(base + endpoint, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ task: "What should we do?", botName: "Huddle: invalid", model: "integration-model", workspaceBots, huddleParticipantIds: ["h-a", "absent"] }) });
        assert.equal(response.status, 400);
        assert.match((await response.json()).detail, /available saved bot/);
      }
      const local = await fetch(base + "/api/run", { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ task: "What should we do?", botName: "Huddle: local", model: "local-engine", workspaceBots, huddleParticipantIds: ["h-a", "h-b"] }) });
      assert.equal(local.status, 400);
      assert.match((await local.json()).detail, /cannot run bot consultations/);
      assert.equal(modelCalls, before);
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
      const switchBusy = await fetch(base + "/api/browser/profiles", { method: "POST", headers: { "content-type": "application/json", Origin: base }, body: JSON.stringify({ action: "switch", id: "default" }) });
      assert.equal(switchBusy.status, 409);
      const status = await fetch(base + "/api/status").then(r => r.json());
      assert.equal(status.activeRuns.length, 2);
      await fetch(base + "/api/stop?runId=" + aState.runId, { method: "POST", headers: { origin: base } });
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
    await t.test("portraits stay inside the header and preview controls fit narrow browser panes", async () => {
      const before = modelCalls;
      for (const filename of ["sabri-suby.jpg", "alex-hormozi.webp", "addy-osmani.jpg", "andrej-karpathy.jpg", "mark-zuckerberg.jpg", "sundar-pichai.webp"]) {
        const response = await fetch(base + "/avatars/" + filename);
        assert.equal(response.status, 200, filename);
        assert.match(response.headers.get("content-type") || "", /image\/(jpeg|webp)/);
        assert.ok((await response.arrayBuffer()).byteLength > 0);
      }
      assert.equal((await fetch(base + "/avatars/not-an-avatar.jpg")).status, 404);
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
        await page.addInitScript(() => {
          localStorage.setItem("agentFireworksAgentsV2", JSON.stringify([
            { id: "header-addy", name: "Addy Osmani", transcript: [] },
            { id: "header-mark", name: "Mark Zuckerberg", transcript: [] },
            { id: "header-sundar", name: "Sundar Pichai", transcript: [] }
          ]));
          localStorage.setItem("openBotsSelectedBot", "header-addy");
        });
        await page.goto(base);
        for (const id of ["header-addy", "header-mark", "header-sundar"]) {
          await page.locator('.agent-row[data-agent-id="' + id + '"]').click();
          await page.waitForFunction(() => {
            const image = document.querySelector<HTMLImageElement>("#chip-avatar img");
            return image?.complete && image.naturalWidth > 0;
          });
          const metrics = await page.evaluate(() => {
            const avatar = document.querySelector<HTMLElement>("#chip-avatar")!;
            const box = avatar.getBoundingClientRect();
            const topbar = document.querySelector("#topbar")!.getBoundingClientRect();
            return { width: box.width, height: box.height, clipped: getComputedStyle(avatar).overflow,
              inside: box.top >= topbar.top && box.bottom <= topbar.bottom };
          });
          assert.deepEqual(metrics, { width: 20, height: 20, clipped: "hidden", inside: true });
          const portraitStates = await page.evaluate(() => {
            const original = document.querySelector<HTMLElement>("#chip-avatar")!;
            return ["is-working", "is-step", "needs-you", "just-finished"].map(state => {
              const host = document.createElement("div"); host.className = "run-presence";
              const portrait = original.cloneNode(true) as HTMLElement;
              portrait.removeAttribute("id"); portrait.classList.add("is-expressive", state);
              host.appendChild(portrait); document.body.appendChild(host);
              const style = getComputedStyle(portrait);
              const result = { animation: style.animationName, transform: style.transform, clipped: style.overflow,
                childAnimation: getComputedStyle(portrait.querySelector("img")!).animationName };
              host.remove(); return result;
            });
          });
          for (const state of portraitStates) assert.deepEqual(state, { animation: "none", transform: "none", clipped: "hidden", childAnimation: "none" });
        }
        for (const width of [320, 480, 680]) {
          await page.evaluate(width => {
            const workspace = document.querySelector<HTMLElement>("#workspace")!;
            workspace.classList.add("has-browser");
            workspace.style.gridTemplateColumns = "minmax(0, 1fr) " + width + "px";
            document.querySelector("#browser-panel")!.classList.add("artifact-mode");
            document.querySelector("#artifact-preview-title")!.textContent = "a-very-long-generated-landscape-website-filename.html";
          }, width);
          const fits = await page.evaluate(() => [".browser-toolbar", ".artifact-preview-bar"].every(selector => {
            const bar = document.querySelector<HTMLElement>(selector)!;
            const bounds = bar.getBoundingClientRect();
            return bar.scrollWidth <= bar.clientWidth && Array.from(bar.children).every(child => {
              const rect = child.getBoundingClientRect();
              return rect.left >= bounds.left && rect.right <= bounds.right && rect.top >= bounds.top && rect.bottom <= bounds.bottom;
            });
          }));
          assert.equal(fits, true, "controls must fit a " + width + "px pane");
        }
      } finally { await browser.close(); }
      assert.equal(modelCalls, before, "layout and portrait reads do not activate models");
    });
    await t.test("the whole UI boots and two chat results stay in their own conversations", async () => {
      scenario = "async";
      const uiStateResponse = await fetch(base + "/uiState.js");
      assert.equal(uiStateResponse.status, 200);
      assert.match(uiStateResponse.headers.get("content-type") || "", /javascript/);
      assert.match(await uiStateResponse.text(), /PiloUI/);
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        const submitted: any[] = [];
        // Exercise the real UI payload, while keeping this concurrency fixture's
        // workers text-only so it does not need two shared browser owners.
        await page.route(/\/api\/run(?:\/queue)?$/, async route => {
          const payload = route.request().postDataJSON();
          submitted.push(payload);
          await route.continue({ postData: JSON.stringify({ ...payload, interactionMode: "chat" }) });
        });
        const errors: string[] = [];
        page.on("pageerror", error => errors.push(error.message));
        await page.route("https://fonts.**/*", route => route.abort());
        await page.addInitScript(() => {
          localStorage.setItem("agentFireworksAgentsV2", JSON.stringify([
            { id: "writer", name: "Async Writer", description: "Write concise answers", transcript: [] },
            { id: "researcher", name: "Async Researcher", description: "Research concise answers", transcript: [] }
          ]));
          localStorage.setItem("openBotsInteractionMode", "chat");
          localStorage.setItem("agentFireworksAutoApprove", "0");
          localStorage.setItem("openBotsAgentEngine", "cheap");
        });
        await page.goto(base, { waitUntil: "domcontentloaded" });
        await page.waitForSelector('.agent-row[data-agent-id="writer"]');
        assert.deepEqual(errors, [], "UI initialization must not stop before rendering bot icons");
        assert.equal(await page.locator('[data-interaction-mode]').count(), 0);
        assert.equal(await page.evaluate(() => localStorage.getItem("openBotsInteractionMode")), "turbo");
        const avatars = page.locator('.template-card[data-name] .template-avatar');
        assert.ok(await avatars.count() > 0);
        assert.equal(await avatars.locator(':scope > *').count(), await avatars.count(), "every catalog bot has a rendered icon");
        await page.waitForFunction(() => Boolean(document.querySelector('#model-select option[value="integration-model"]')));
        await page.selectOption("#model-select", "integration-model", { force: true });
        await page.locator('.agent-row[data-agent-id="writer"]').click();
        await page.locator("#prompt").fill("UI_A");
        await page.locator("#send-button").click();
        await waitFor(async () => asyncStarted, value => value.includes("UI_A"));
        assert.equal(submitted[0].interactionMode, "turbo");
        assert.equal(submitted[0].autoApprove, false);
        const currentAvatar = page.locator('.agent-row[data-agent-id="writer"] .agent-avatar');
        assert.equal(await currentAvatar.evaluate(el => el.classList.contains("is-expressive")), false);
        assert.equal(await currentAvatar.locator(".bot").evaluate(el => getComputedStyle(el).animationName), "none");
        await page.locator("#prompt").fill("Keep this writer draft");
        await page.locator("#brand-home-btn").click();
        assert.equal(await page.locator("#welcome").isVisible(), true);
        assert.match(await page.locator("#agent-chip").innerText(), /New Bot/);
        assert.equal(await page.locator("#status").innerText(), "");
        assert.equal(await page.locator("#step-counter").innerText(), "");
        assert.equal(await page.locator("#composer-stop-button").isVisible(), false);
        assert.equal(await page.locator("#prompt").inputValue(), "");
        const backgroundAvatar = page.locator('.agent-row[data-agent-id="writer"] .agent-avatar');
        assert.equal(await backgroundAvatar.evaluate(el => el.classList.contains("is-expressive")), true);
        assert.notEqual(await backgroundAvatar.locator(".bot").evaluate(el => getComputedStyle(el).animationName), "none");
        const idleAvatar = page.locator('.agent-row[data-agent-id="researcher"] .agent-avatar');
        assert.equal(await idleAvatar.locator(".bot").evaluate(el => getComputedStyle(el).animationName), "none");
        await page.locator('.agent-row[data-agent-id="writer"]').click();
        assert.equal(await page.locator("#welcome").isVisible(), false);
        assert.equal(await page.locator("#prompt").inputValue(), "Keep this writer draft");
        assert.equal(await page.locator("#status-badge-text").innerText(), "Working");
        await page.locator('.agent-row[data-agent-id="researcher"]').click();
        await page.waitForTimeout(450);
        await page.locator('#auto-approve-toggle').click();
        await page.locator("#prompt").fill("UI_B");
        await page.locator("#send-button").click();
        await waitFor(async () => asyncStarted, value => value.includes("UI_B"));
        assert.equal(submitted[1].interactionMode, "turbo");
        assert.equal(submitted[1].autoApprove, true);
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
      assert.deepEqual((await fetch(base + "/api/coordination?bot=Team%20Coordinator").then(r => r.json())).consultations, [], "a reset does not re-inject old consultation receipts");
    });
    await t.test("a missing provider opens the correct connection field and saves privately without starting a model", async () => {
      const before = modelCalls;
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
        await page.route("https://fonts.**/*", route => route.abort());
        await page.addInitScript(() => {
          localStorage.setItem("agentFireworksAgentsV2", JSON.stringify([{ id: "connect-ui", name: "Reconnect Bot", description: "Review SEO requests", transcript: [] }]));
          localStorage.setItem("agentFireworksModel", "grok-unconfigured-test");
          localStorage.setItem("openBotsInteractionMode", "chat");
        });
        await page.goto(base, { waitUntil: "domcontentloaded" });
        await page.locator('#agent-list .agent-row[data-agent-id="connect-ui"]').click();
        await page.waitForFunction(() => (document.querySelector("#model-select") as HTMLSelectElement).value === "grok-unconfigured-test");
        await page.locator("#prompt").fill("Help with this SEO task");
        await page.locator("#send-button").click();
        await page.locator(".connect-provider").click();
        assert.equal(await page.locator("#provider-credentials").getAttribute("open"), "");
        assert.equal(await page.evaluate(() => document.activeElement?.id), "settings-xai-key");
        await page.locator("#settings-xai-key").fill("test-key-xai-ui");
        await page.locator('#settings-form button[type="submit"]').click();
        await page.waitForFunction(() => document.querySelector("#settings-status")!.textContent!.includes("saved on this computer"));
        assert.equal(await page.locator("#settings-xai-key").inputValue(), "");
        assert.equal(await page.locator("#execution-model-notice").isHidden(), true);
        assert.match(await readFile(join(directory, ".env"), "utf8"), /XAI_API_KEY=/);
        const state = await fetch(base + "/api/status").then(r => r.json());
        assert.equal(state.hasXaiKey, true);
        assert.equal(JSON.stringify(state).includes("test-key-xai-ui"), false);
        assert.equal(modelCalls, before, "saving a connection must never automatically retry a model request");
        assert.deepEqual(errors, []);
      } finally { await browser.close(); }
    });
    await t.test("Settings connects Qwen and Kimi, selects the saved model, and makes no provider calls", async () => {
      const before = modelCalls;
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.goto(base);
        await page.locator("#header-settings-btn").click();
        for (const provider of ["qwen", "kimi"]) {
          await page.selectOption("#settings-provider", provider);
          await page.locator("#settings-provider-key").fill(`fixture-${provider}-ui-key`);
          await page.locator('#settings-form button[type="submit"]').click();
          await page.waitForFunction(() => document.querySelector("#settings-provider-key")!.getAttribute("type") === "password" && (document.querySelector("#settings-provider-key") as HTMLInputElement).value === "");
          const state = await fetch(base + "/api/status").then(r => r.json());
          const selected = state.providers.find((item: any) => item.id === provider);
          assert.equal(selected.configured, true);
          assert.equal(state.defaultModel, selected.model);
          await page.waitForFunction(model => (document.querySelector("#composer-model-select") as HTMLSelectElement).value === model, selected.model);
          assert.equal(JSON.stringify(state).includes(`fixture-${provider}-ui-key`), false);
        }
        assert.equal(modelCalls, before, "saving connections is not authorization to call a model");
      } finally { await browser.close(); }
    });
  } finally {
    for (const release of releaseAsync.values()) release();
    child.kill("SIGTERM");
    if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
    await new Promise<void>(done => provider.close(() => done()));
  }
});
