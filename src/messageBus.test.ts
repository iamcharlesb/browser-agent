import test from "node:test";
import assert from "node:assert/strict";

import { BUS_ERROR_TOPIC, MessageBus, topicMatches } from "./messageBus";

test("topic patterns match on segments", () => {
  assert.ok(topicMatches("agent.run.started", "agent.run.started"));
  assert.ok(topicMatches("agent.run.*", "agent.run.started"));
  assert.ok(topicMatches("agent.#", "agent.run.started"));
  assert.ok(topicMatches("#", "anything.at.all"));

  assert.ok(!topicMatches("agent.run.*", "agent.run.started.extra"));
  assert.ok(!topicMatches("agent.run.*", "agent.run"));
  assert.ok(!topicMatches("agent.#", "agent"), "# must consume at least one segment");
  assert.ok(!topicMatches("agent.run.started", "agent.run.stopped"));
});

test("publish delivers to matching subscribers only", async () => {
  const bus = new MessageBus();
  const exact: string[] = [];
  const wildcard: string[] = [];
  const unrelated: string[] = [];

  bus.subscribe<number>("agent.run.started", (message) => { exact.push(`exact:${message.payload}`); });
  bus.subscribe<number>("agent.#", (message) => { wildcard.push(`wild:${message.topic}`); });
  bus.subscribe<number>("learn.#", (message) => { unrelated.push(message.topic); });

  await bus.publishAndWait("agent.run.started", 1);
  await bus.publishAndWait("agent.run.completed", 2);

  assert.deepEqual(exact, ["exact:1"]);
  assert.deepEqual(wildcard, ["wild:agent.run.started", "wild:agent.run.completed"]);
  assert.deepEqual(unrelated, []);
});

test("unsubscribe stops delivery and subscribeOnce fires a single time", async () => {
  const bus = new MessageBus();
  const seen: string[] = [];
  const unsubscribe = bus.subscribe<string>("t.a", (message) => { seen.push(`sub:${message.payload}`); });
  bus.subscribeOnce<string>("t.a", (message) => { seen.push(`once:${message.payload}`); });

  await bus.publishAndWait("t.a", "first");
  unsubscribe();
  await bus.publishAndWait("t.a", "second");

  assert.deepEqual(seen, ["sub:first", "once:first"]);
});

test("a throwing subscriber does not break the publisher or its peers", async () => {
  const errors: string[] = [];
  const bus = new MessageBus({ onError: (err) => errors.push(err.message) });
  const peerSaw: string[] = [];
  const busErrors: string[] = [];

  bus.subscribe("t.b", () => {
    throw new Error("handler exploded");
  });
  bus.subscribe<string>("t.b", (message) => { peerSaw.push(message.payload); });
  bus.subscribe<{ error: string }>(BUS_ERROR_TOPIC, (message) => { busErrors.push(message.payload.error); });

  await bus.publishAndWait("t.b", "payload");
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(errors, ["handler exploded"]);
  assert.deepEqual(peerSaw, ["payload"]);
  assert.deepEqual(busErrors, ["handler exploded"]);
});

test("request resolves with the reply and times out otherwise", async () => {
  const bus = new MessageBus();
  bus.subscribe<{ n: number }>("math.double", (message) => {
    bus.reply(message, { result: message.payload.n * 2 });
  });

  const reply = await bus.request<{ n: number }, { result: number }>("math.double", { n: 21 });
  assert.equal(reply.result, 42);

  await assert.rejects(
    () => bus.request("nobody.listening", {}, { timeoutMs: 30 }),
    /No reply on "nobody.listening" within 30ms/
  );
});

test("publishing to a wildcard topic is rejected", () => {
  const bus = new MessageBus();
  assert.throws(() => bus.publish("agent.*", {}), /Cannot publish to a wildcard topic/);
  assert.throws(() => bus.subscribe("agent.#.late", () => undefined), /may only be the last segment/);
  assert.throws(() => bus.publish("bad..topic", {}), /empty segment/);
});

test("history is capped and filterable", async () => {
  const bus = new MessageBus({ historyLimit: 3 });
  for (let i = 0; i < 5; i += 1) {
    await bus.publishAndWait(`t.item.${i}`, i);
  }
  const all = bus.history();
  assert.equal(all.length, 3, "oldest messages are dropped");
  assert.deepEqual(
    all.map((message) => message.payload),
    [2, 3, 4]
  );
  assert.equal(bus.history("t.item.4").length, 1);
});

test("a subscriber added during delivery does not receive the in-flight message", async () => {
  const bus = new MessageBus();
  const late: string[] = [];
  bus.subscribe("t.c", () => {
    bus.subscribe<string>("t.c", (message) => { late.push(message.payload); });
  });

  await bus.publishAndWait("t.c", "first");
  assert.deepEqual(late, []);
  await bus.publishAndWait("t.c", "second");
  assert.deepEqual(late, ["second"]);
});
