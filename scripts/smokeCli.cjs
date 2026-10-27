#!/usr/bin/env node
/** Install the actual tarball into a disposable prefix; run without checkout dependencies. */
const assert = require("node:assert/strict");
const { mkdtemp, mkdir, readFile, readdir, rm, writeFile } = require("node:fs/promises");
const { join, resolve } = require("node:path");
const { tmpdir } = require("node:os");
const { createServer } = require("node:http");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
async function listen(server) {
  server.listen(0, "127.0.0.1"); await once(server, "listening"); return server.address().port;
}
async function waitFor(read) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) { try { return await read(); } catch { await new Promise(done => setTimeout(done, 50)); } }
  throw new Error("Packaged server startup timed out.");
}
async function main() {
  const archive = resolve(process.argv[2] || "release/iamcharlesb-openbuddy-cli-0.1.0-preview.1.tgz");
  const directory = await mkdtemp(join(tmpdir(), "openbuddy-cli-smoke-"));
  const environment = { PATH: process.env.PATH, BROWSER_AGENT_CLI_TIMEOUT_SECONDS: "10", ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) };
  const run = async (file, args, options = {}) => {
    const child = spawn(file, args, { cwd: directory, env: environment, stdio: ["ignore", "pipe", "pipe"], ...options });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => stdout += chunk); child.stderr.on("data", chunk => stderr += chunk);
    const [code] = await once(child, "exit");
    assert.equal(code, 0, stderr + stdout); return stdout;
  };
  let server, provider;
  const captured = [];
  try {
    await run("npm", ["install", "--prefix", directory, "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund", archive]);
    const installed = join(directory, "node_modules/@iamcharlesb/openbuddy-cli");
    const cli = join(installed, "dist/openbuddyCli.js");
    assert.equal((await readdir(join(directory, "node_modules"))).includes("electron"), false);
    assert.equal((await run(process.execPath, [cli, "--version"])).trim(), "0.1.0-preview.1");
    assert.match(await run(process.execPath, [cli, "--help"]), /openbuddy serve/);
    await assert.rejects(readFile(join(installed, ".env")));
    provider = createServer(async (req, res) => {
      let raw = ""; for await (const chunk of req) raw += chunk;
      captured.push(raw);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: "resp_" + captured.length, object: "response", created_at: 1, status: "completed", model: "smoke-model",
        output: [{ id: "msg", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Cedar bakery draft with a $15 budget. Draft only." }] }],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } }));
    });
    const providerPort = await listen(provider);
    const reservation = createServer(); const port = await listen(reservation);
    await new Promise(done => reservation.close(done));
    const data = join(directory, "data"), workspace = join(directory, "workspace");
    await mkdir(workspace);
    const config = join(directory, "smoke.env");
    await writeFile(config, ["OPENAI_API_KEY=test-key", "OPENAI_MODEL=smoke-model", `OPENAI_BASE_URL=http://127.0.0.1:${providerPort}/v1`,
      'BROWSER_AGENT_MODELS_JSON=[{"id":"smoke-model","provider":"openai","api":"responses"}]', "BROWSER_AGENT_MANAGED_CHROME=0"].join("\n"));
    const base = `http://127.0.0.1:${port}`;
    let logs = "";
    const start = async () => {
      server = spawn(process.execPath, [cli, "serve", "--port", String(port), "--data-dir", data, "--workspace", workspace, "--env-file", config], { cwd: directory, env: environment, stdio: ["ignore", "pipe", "pipe"] });
      server.stdout.on("data", chunk => logs += chunk); server.stderr.on("data", chunk => logs += chunk);
      await waitFor(async () => { const res = await fetch(base + "/api/status"); assert.equal(res.ok, true); return res.json(); }).catch(error => { throw new Error(error.message + logs); });
    };
    const stop = async () => { if (server && server.exitCode === null && server.signalCode === null) { server.kill("SIGTERM"); await once(server, "exit"); } server = undefined; };
    await start();
    const docs = await fetch(base + "/docs?topic=conversations");
    assert.equal(docs.status, 200); assert.match(await docs.text(), /Reset one bot or every bot/);
    const setup = await fetch(base + "/docs?topic=setup");
    assert.equal(setup.status, 200); assert.match(await setup.text(), /Approvals and conversation flow/);
    const first = JSON.parse(await run(process.execPath, [cli, "ask", "--server", base, "--bot", "Packaged Marketing", "--task", "Draft a campaign for Cedar bakery with a $15 budget", "--json"]));
    assert.equal(first.success, true);
    await stop(); await start();
    const second = JSON.parse(await run(process.execPath, [cli, "ask", "--server", base, "--bot", "Packaged Marketing", "--task", "Summarize the earlier draft and budget", "--json"]));
    assert.equal(second.success, true);
    assert.match(captured[1], /Cedar bakery/); assert.match(captured[1], /\$15/);
    assert.ok((await readdir(data)).includes(".browser-agent-task-memory"));
    assert.equal((await readdir(installed)).some(name => name.startsWith(".browser-agent-")), false);
    const reset = await fetch(base + "/api/conversations/reset", { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ scope: "bot", botName: "Packaged Marketing", confirm: true }) });
    assert.equal(reset.status, 200);
    const state = await reset.json(); assert.ok(state.bots.Packaged_Marketing > 0);
    await stop(); await start();
    const resetState = await fetch(base + "/api/conversations/state").then(res => res.json());
    assert.equal(resetState.bots.Packaged_Marketing, state.bots.Packaged_Marketing);
    await stop();
    console.log("Packaged CLI smoke: fresh install, no Electron, help/version, server startup, docs, chat, restart continuity, reset persistence and separate private storage passed.");
  } finally {
    if (server && server.exitCode === null && server.signalCode === null) { server.kill("SIGTERM"); await once(server, "exit"); }
    if (provider) { provider.closeAllConnections(); await new Promise(done => provider.close(done)); }
    await rm(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
