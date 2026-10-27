import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { ApiError, localServerUrl, TerminalClient } from "./terminalClient";

test("CLI only accepts loopback origins without credentials or hidden paths", () => {
  assert.equal(localServerUrl("http://127.0.0.1:8765/"), "http://127.0.0.1:8765");
  assert.equal(localServerUrl("http://[::1]:8765"), "http://[::1]:8765");
  for (const url of ["https://example.com", "http://127.0.0.1.example.com", "http://user:password@localhost", "http://localhost/private", "http://localhost/?key=hidden"]) {
    assert.throws(() => localServerUrl(url));
  }
});

test("CLI decodes fragmented Unicode results and cancels only its queued job on abort", async () => {
  const requests: Array<{ method: string; path: string }> = [];
  let mode = "unicode";
  const server = createServer(async (req, res) => {
    requests.push({ method: req.method!, path: req.url! });
    if (req.url === "/api/run/queue") {
      res.setHeader("content-type", "application/json");
      if (mode === "approval") { res.statusCode = 428; res.end(JSON.stringify({ detail: "Explicit approval required", approvalsRequired: ["external_side_effect"] })); }
      else res.end(JSON.stringify({ id: "own-job" }));
    } else if (req.method === "DELETE") res.end("{}");
    else if (req.url === "/api/run/jobs/own-job") res.end(JSON.stringify(mode === "queued" ? { status: "queued" } : { runId: "own-run" }));
    else if (req.url === "/api/discussions/own-discussion") res.end(JSON.stringify({ phase: "consulting", runId: "own-run" }));
    else if (req.url?.startsWith("/api/stop?")) res.end("{}");
    else if (req.url?.startsWith("/api/events")) {
      res.setHeader("content-type", "text/event-stream");
      const bytes = Buffer.from('id: 1\ndata: ' + JSON.stringify({ type: "terminal", success: true, summary: "Café ☕",
        ...(mode === "discussion" ? { delegateTo: "Specialist", discussionId: "own-discussion" } : {}) }) + '\n\n');
      const split = bytes.indexOf(Buffer.from("é")) + 1;
      res.write(bytes.subarray(0, split));
      setTimeout(() => res.end(bytes.subarray(split)), 5);
    } else { res.statusCode = 404; res.end("{}"); }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const client = new TerminalClient(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  const input = { task: "Read a draft", botName: "Terminal", interactionMode: "chat", agentEngine: "cheap" } as const;
  try {
    const result = await client.run(input, { signal: AbortSignal.timeout(2_000) });
    assert.equal(result.summary, "Café ☕");
    mode = "approval";
    await assert.rejects(client.run(input, { signal: AbortSignal.timeout(2_000) }), error => error instanceof ApiError && error.status === 428);
    mode = "queued";
    requests.length = 0;
    const controller = new AbortController();
    const cancelled = client.run(input, { signal: controller.signal });
    const assertion = assert.rejects(cancelled, /operator stop/);
    while (!requests.some(request => request.method === "GET")) await new Promise<void>(done => setTimeout(done, 5));
    controller.abort(new Error("operator stop"));
    await assertion;
    assert.ok(requests.some(request => request.method === "DELETE" && request.path === "/api/run/jobs/own-job"));
    assert.equal(requests.some(request => request.path === "/api/stop"), false, "there is no unscoped Stop request");
    mode = "discussion"; requests.length = 0;
    const discussionAbort = new AbortController();
    const discussion = assert.rejects(client.run(input, { signal: discussionAbort.signal }), /stop discussion/);
    while (!requests.some(request => request.path === "/api/discussions/own-discussion")) await new Promise<void>(done => setTimeout(done, 5));
    discussionAbort.abort(new Error("stop discussion"));
    await discussion;
    assert.ok(requests.some(request => request.path === "/api/stop?discussionId=own-discussion"));
  } finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
});
