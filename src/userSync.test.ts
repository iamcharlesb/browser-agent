import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { it } from "node:test";

function syncHarness() {
  const html = readFileSync(join(__dirname, "../static/index.html"), "utf8");
  const functions = html.slice(html.indexOf("  function scheduleGooglePersist()"), html.indexOf("  function applyGooglePersistence"));
  const refresh = html.slice(html.indexOf("  function refreshGooglePersistence()"), html.indexOf("  googleSyncTimer = window.setInterval"));
  const requests: { path: string; options: any; resolve: (value: any) => void; reject: (error: Error) => void }[] = [];
  const timers = new Map<number, () => void>();
  let timerId = 0;
  const applied: any[] = [];
  const context: any = {
    googleIdentityUser: { id: "user1" }, googlePersistTimer: null,
    googlePersistInFlight: false, googlePersistPending: false, googleEditRevision: 0,
    googleLastSyncedBotsJson: null, googleSyncInFlight: false, googleSyncRequested: false,
    agents: [{ id: "bot", transcript: ["first"] }], deletedBotIds: [],
    currentInteractionMode: "act", currentSessionMode: "guest", isRunning: false,
    document: { hidden: false, getElementById: () => null },
    localStorage: { getItem: () => "" },
    setTimeout: (callback: () => void) => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: (id: number) => timers.delete(id),
    fetch: (path: string, options: any) => new Promise((resolve, reject) => requests.push({ path, options, resolve, reject })),
    readResponse: (value: any) => { if (!value.ok) throw Error("save failed"); return value; },
    applyGooglePersistence: (data: any) => applied.push(data),
    setGoogleSignInStatus: () => {}
  };
  runInNewContext(functions + refresh, context);
  return { context, requests, applied, fireTimer() {
    const entry = timers.entries().next().value;
    assert.ok(entry);
    timers.delete(entry[0]);
    entry[1]();
  } };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

it("serializes cloud writes and retains edits made while a save is in flight", async () => {
  const h = syncHarness();
  h.context.scheduleGooglePersist(); h.fireTimer();
  h.context.agents[0].transcript.push("second");
  h.context.scheduleGooglePersist(); h.fireTimer();
  h.context.refreshGooglePersistence();
  assert.equal(h.requests.length, 1);
  h.requests[0].resolve({ ok: true, backend: "mongodb" });
  await settle();
  assert.equal(h.applied.length, 0);
  h.fireTimer();
  assert.equal(h.requests.length, 2);
  assert.deepEqual(JSON.parse(h.requests[1].options.body).bots[0].transcript, ["first", "second"]);
  h.requests[1].resolve({ ok: true, backend: "mongodb" });
  await settle();
  assert.equal(h.applied.length, 1);
  assert.equal(h.requests[2].path, "/api/user/data");
});

it("retries failed saves with the latest local data", async () => {
  const h = syncHarness();
  h.context.scheduleGooglePersist(); h.fireTimer();
  h.requests[0].resolve({ ok: false });
  await settle();
  assert.equal(h.context.googlePersistPending, true);
  h.context.agents[0].transcript.push("offline edit");
  h.fireTimer();
  assert.equal(h.requests.length, 2);
  assert.deepEqual(JSON.parse(h.requests[1].options.body).bots[0].transcript, ["first", "offline edit"]);
});

it("discards a refresh response if edits or an account change occurred during the request", async () => {
  const h = syncHarness();
  h.context.refreshGooglePersistence();
  h.context.scheduleGooglePersist();
  h.requests[0].resolve({ ok: true, bots: [] });
  await settle();
  assert.equal(h.applied.length, 0);
  h.context.googlePersistPending = false;
  h.context.refreshGooglePersistence();
  h.context.googleIdentityUser = { id: "other-user" };
  h.requests[1].resolve({ ok: true, bots: [] });
  await settle();
  assert.equal(h.applied.length, 0);
});


it("keeps a local fallback save pending until MongoDB acknowledges it", async () => {
  const h = syncHarness();
  h.context.scheduleGooglePersist(); h.fireTimer();
  h.requests[0].resolve({ ok: true, backend: "local", mongodbConfigured: true });
  await settle();
  assert.equal(h.context.googlePersistPending, true);
  assert.equal(h.context.googleLastSyncedBotsJson, null);
  assert.equal(h.applied.length, 0);
  h.fireTimer();
  assert.equal(h.requests.length, 2);
});

it("fetches again when a change notification arrives during a refresh", async () => {
  const h = syncHarness();
  h.context.refreshGooglePersistence();
  h.context.refreshGooglePersistence();
  assert.equal(h.requests.length, 1);
  h.requests[0].resolve({ ok: true, bots: [] });
  await settle();
  assert.equal(h.requests.length, 2);
});
