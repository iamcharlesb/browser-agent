import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

const html = readFileSync(join(__dirname, "..", "static", "index.html"), "utf8");
const start = html.indexOf("  function followDiscussion(");
const end = html.indexOf("  /**", start);
const code = html.slice(start, end);
const settle = async () => { for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve)); };

function harness(fetch: (path: string) => Promise<unknown>) {
  const timers: Array<() => void> = [], attachments: string[] = [];
  const state: Record<string, any> = {
    discussionFollowToken: 0, fetch, readResponse: (value: unknown) => value,
    isRunning: false, setStatusState() {}, status: { textContent: "" },
    findPeerBotByQuery: (name: string) => ({ id: name }),
    localStorage: { removeItem() {} }, runEventCursorKey: "cursor",
    connectRunEvents: () => attachments.push(state.runStreamId),
    setTimeout: (callback: () => void) => timers.push(callback),
    clearRunClientState: () => { state.discussionFollowToken++; state.isRunning = false; },
    scheduleQueuedRun() {}, encodeURIComponent
  };
  vm.createContext(state);
  vm.runInContext(code + '\nfollowDiscussion("discussion_1", "run_original");', state);
  return { state, timers, attachments };
}

test("the UI waits for its own next run instead of attaching to an unrelated active run", async () => {
  const paths: string[] = [];
  let calls = 0;
  const h = harness(async path => {
    paths.push(path);
    return ++calls === 1 ? { runId: "run_original", phase: "consulting", consultations: 1, maxConsultations: 4 }
      : { runId: "run_specialist", botName: "SEO", phase: "consulting", consultations: 1, maxConsultations: 4 };
  });
  await settle();
  assert.deepEqual(h.attachments, []);
  h.timers.shift()!();
  await settle();
  assert.deepEqual(h.attachments, ["run_specialist"]);
  assert.ok(paths.every(path => path === "/api/discussions/discussion_1"));
  assert.equal(h.state.runningAgentName, "SEO");
});

test("a fast final synthesis is replayed even if it finished before the next poll", async () => {
  const h = harness(async () => ({ runId: "run_final", botName: "Coordinator", phase: "completed" }));
  await settle();
  assert.deepEqual(h.attachments, ["run_final"]);
});

test("stopping the UI invalidates a pending discussion poll", async () => {
  let resolve!: (value: unknown) => void;
  const h = harness(() => new Promise(done => { resolve = done; }));
  h.state.discussionFollowToken++;
  resolve({ runId: "run_specialist", botName: "SEO", phase: "consulting" });
  await settle();
  assert.deepEqual(h.attachments, []);
});

function streamHarness(fetchJson: (path: string) => Promise<unknown> = async () => ({})) {
  const runtime = /<script id="run-stream-runtime">([\s\S]*?)<\/script>/.exec(html)![1];
  const scope: Record<string, any> = { module: { exports: {} }, setTimeout, encodeURIComponent };
  vm.createContext(scope);
  vm.runInContext(runtime, scope);
  const sources: any[] = [], delivered: any[] = [];
  class Source {
    closed = false;
    onmessage?: (event: unknown) => void;
    onerror?: () => void;
    constructor(readonly url: string) { sources.push(this); }
    close() { this.closed = true; }
    emit(event: unknown) { this.onmessage?.({ data: JSON.stringify(event), lastEventId: "1" }); }
  }
  const tracker = scope.module.exports.create({ EventSource: Source, fetchJson,
    onEvent: (record: any, event: any) => delivered.push({ ownerId: record.ownerId, event }) });
  return { tracker, sources, delivered };
}

test("independent streams deliver each result to its owning bot without closing the other stream", () => {
  const h = streamHarness();
  h.tracker.subscribe({ runId: "run_a", ownerId: "writer", botName: "Writer" });
  h.tracker.subscribe({ runId: "run_b", ownerId: "researcher", botName: "Researcher" });
  h.sources[1].emit({ type: "terminal", runId: "run_b", success: true, summary: "Research complete" });
  assert.equal(h.sources[0].closed, false);
  assert.equal(h.sources[1].closed, true);
  assert.equal(h.tracker.activeFor("writer").runId, "run_a");
  assert.equal(h.tracker.activeFor("researcher"), undefined);
  h.sources[0].emit({ type: "terminal", runId: "run_a", success: true, summary: "Draft complete" });
  assert.deepEqual(h.delivered.map(item => item.ownerId), ["researcher", "writer"]);
  h.sources[0].emit({ type: "terminal", runId: "run_a", success: true, summary: "Duplicate" });
  assert.equal(h.delivered.length, 2);
});

test("reconnecting an ended stream recovers its own terminal result instead of trusting global busy state", async () => {
  const paths: string[] = [];
  const h = streamHarness(async path => {
    paths.push(path);
    return { isRunning: false, terminal: { type: "terminal", runId: "run_a", success: true, summary: "Recovered result" } };
  });
  h.tracker.subscribe({ runId: "run_a", ownerId: "writer", botName: "Writer" });
  h.sources[0].onerror();
  await settle();
  assert.deepEqual(paths, ["/api/runs/run_a"]);
  assert.equal(h.delivered[0].event.summary, "Recovered result");
  assert.equal(h.tracker.activeFor("writer"), undefined);
});
