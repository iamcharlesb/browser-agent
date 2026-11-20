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
  await cp(resolve(__dirname, "..", "static", "avatars"), join(directory, "static", "avatars"), { recursive: true });
  await cp(resolve(__dirname, "..", "docs"), join(directory, "docs"), { recursive: true });
  await copyFile(resolve(__dirname, "..", "README.md"), join(directory, "README.md"));
  for (const file of ["index.html", "browserRuntime.js", "uiState.js", "responseMarkdown.js", "runStream.js", "artifactPreview.js", "pilo-logo.png", "pilo-icon.png"]) await copyFile(resolve(__dirname, "..", "static", file), join(directory, "static", file));
  let capturedPersonaPrompt = "";
  const cliPrompts: string[] = [];
  let cliToolCalls = 0;
  const teamPrompts: Array<{ name: string; text: string; tools: string[] }> = [];
  let teamFinalPrompt = "";
  let scenario = "repeat", modelCalls = 0, coordinatorCalls = 0, workerCalls = 0, finalCalls = 0;
  const asyncStarted: string[] = [];
  const releaseAsync = new Map<string, () => void>();
  const finalAnswer = "Low visibility explains the observed click count. The underlying ranking cause is unverified; compare the page with the relevant search results next.";
  const provider = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    modelCalls++;
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
      if (names.every((name: string) => ["finish_task", "fail_task"].includes(name))) {
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
      assert.match(capturedPersonaPrompt, /Do not use hyphen bullets/);
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
      const result = await client.run({ task: "Coordinate with all the saved bots on our organic strategy. Collect each role's progress and next action; draft only.", botName: fail ? "Team Coordinator Failure" : "Team Coordinator", interactionMode: "chat", agentEngine: engine,
        workspaceBots: peers } as any, { signal: AbortSignal.timeout(12_000) });
      assert.equal(result.discussionFinal, true);
      assert.equal(teamPrompts.length, 4, logs);
      assert.equal(finalCalls, 1);
      for (const [index, peer] of peers.entries()) {
        const prompt = teamPrompts.find(item => item.name === peer.name)!;
        assert.ok(prompt, peer.name + " was actually contacted");
        assert.match(prompt.text.split("SOUL")[0], new RegExp(`OWNER_ROLE_${index}`));
        assert.match(prompt.text, new RegExp(`OWN_WORK_${index}`));
        assert.deepEqual(prompt.tools.slice().sort(), ["fail_task", "finish_task", "knowledge_base"]);
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
      for (const filename of ["sabri-suby.jpg", "alex-hormozi.webp", "addy-osmani.jpg", "andrej-karpathy.jpg", "mark-zuckerberg.jpg"]) {
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
            { id: "header-mark", name: "Mark Zuckerberg", transcript: [] }
          ]));
          localStorage.setItem("openBotsSelectedBot", "header-addy");
        });
        await page.goto(base);
        for (const id of ["header-addy", "header-mark"]) {
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
          assert.deepEqual(metrics, { width: 26, height: 26, clipped: "hidden", inside: true });
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
  } finally {
    for (const release of releaseAsync.values()) release();
    child.kill("SIGTERM");
    if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
    await new Promise<void>(done => provider.close(() => done()));
  }
});
