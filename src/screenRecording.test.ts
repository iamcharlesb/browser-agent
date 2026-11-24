import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecordingStore } from "./screenRecording";
import { artifactContentType, artifactPreviewKind } from "./apiContract";

test("recording requests do not pretend to capture and cannot be duplicated or revived", async () => {
  const store = new RecordingStore();
  const request = store.request(10);
  assert.equal(request.state, "pending");
  assert.equal(request.artifactUrl, undefined);
  assert.equal(store.request(10).id, request.id);
  assert.throws(() => store.request(-1), /duration/);
  store.transition(request.id, "recording");
  assert.throws(() => store.transition(request.id, "recording"), /already started/);
  store.transition(request.id, "failed");
  assert.throws(() => store.transition(request.id, "recording"), /already started/);
  assert.notEqual(store.request(10).id, request.id);
});

test("only an active capture can save a bounded WebM artifact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pilo-video-test-"));
  try {
    const store = new RecordingStore(); const request = store.request(1);
    const video = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(40)]);
    await assert.rejects(() => store.save(request.id, video, directory), /No active/);
    store.transition(request.id, "recording");
    await assert.rejects(() => store.save(request.id, Buffer.from("<html>mockup</html>"), directory), /WebM/);
    const saved = await store.save(request.id, video, directory);
    assert.equal(saved?.state, "completed");
    assert.match(saved?.artifactUrl || "", /\.webm$/);
    assert.deepEqual(await readFile(join(directory, `pilo-recording-${request.id}.webm`)), video);
    assert.deepEqual(artifactContentType("take.webm"), { contentType: "video/webm", inline: true });
    assert.equal(artifactPreviewKind("take.webm"), "video");
    await assert.rejects(() => store.save(request.id, video, directory), /No active/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
