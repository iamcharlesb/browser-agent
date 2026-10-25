import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MessageBus } from "./messageBus";
import { DurableEventStream } from "./durableEventStream";

test("shared event relay is disabled without an explicit Mongo workspace", async () => {
  const oldUri = process.env.MONGODB_URI;
  const oldWorkspace = process.env.BROWSER_AGENT_WORKSPACE_ID;
  delete process.env.MONGODB_URI;
  delete process.env.BROWSER_AGENT_WORKSPACE_ID;
  const directory = await mkdtemp(join(tmpdir(), "agent-events-"));
  try {
    const relay = new DurableEventStream({ stateDirectory: directory });
    assert.equal(relay.enabled, false);
    assert.equal(await relay.publish("workspace.event", { safe: true }), null);
    const bus = new MessageBus();
    await relay.start(bus);
    bus.publish("agent.run.started", { task: "local" });
    assert.deepEqual(await relay.list(), []);
    await relay.close();
  } finally {
    if (oldUri === undefined) delete process.env.MONGODB_URI; else process.env.MONGODB_URI = oldUri;
    if (oldWorkspace === undefined) delete process.env.BROWSER_AGENT_WORKSPACE_ID; else process.env.BROWSER_AGENT_WORKSPACE_ID = oldWorkspace;
    await rm(directory, { recursive: true, force: true });
  }
});

test("SSE cursors encode stable event time and id", () => {
  const relay = new DurableEventStream({ stateDirectory: tmpdir(), workspaceId: "test" });
  const event = { _id: "event-1", workspaceId: "test", topic: "workspace.event", payload: {}, publishedAt: new Date("2026-10-25T12:00:00.000Z"), schemaVersion: 1 as const };
  const cursor = Buffer.from(relay.cursor(event), "base64url").toString("utf8");
  assert.equal(cursor, "2026-10-25T12:00:00.000Z|event-1");
});
