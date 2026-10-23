import assert from "node:assert/strict";
import { it } from "node:test";
import { FrameStream } from "./frameStream";

it("keeps only the latest pending frame independently for every viewer", async () => {
  const stream = new FrameStream();
  const a = stream.subscribe();
  const b = stream.subscribe();
  for (let i = 0; i < 10000; i++) stream.push(String(i));
  assert.equal(await a.frames.next(), "9999");
  assert.equal(await b.frames.next(), "9999");
  a.dispose();
  const next = b.frames.next();
  stream.push("new");
  assert.equal(await next, "new");
  assert.equal(await a.frames.next(), null);
  b.dispose();
});

it("wakes waiting readers on disconnect and session shutdown", async () => {
  const stream = new FrameStream();
  const a = stream.subscribe();
  const waiting = a.frames.next();
  a.dispose();
  assert.equal(await waiting, null);
  const b = stream.subscribe();
  const pending = b.frames.next();
  stream.push(null);
  assert.equal(await pending, null);
  stream.push("ignored");
  assert.equal(await stream.subscribe().frames.next(), null);
});
