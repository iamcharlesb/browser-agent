import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { MongoClient } from "mongodb";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  getUserByGoogleSub,
  preserveBotDeletions,
  resetUserStoreForTests,
  saveUserBotsAndSettings,
  subscribeUserChanges,
  upsertGoogleUser,
  USER_STORE_DIR_NAME
} from "./userStore";

describe("userStore local persistence", () => {
  const previousUri = process.env.MONGODB_URI;

  afterEach(async () => {
    if (previousUri === undefined) delete process.env.MONGODB_URI;
    else process.env.MONGODB_URI = previousUri;
    await resetUserStoreForTests();
  });

  it("upserts a Google user to local JSON when Mongo is unset", async () => {
    delete process.env.MONGODB_URI;
    const root = await mkdtemp(join(tmpdir(), "openbots-userstore-"));
    try {
      const profile = {
        googleSub: "sub-abc",
        email: "dev@example.com",
        name: "Dev User",
        picture: null as string | null
      };
      const first = await upsertGoogleUser(root, profile);
      assert.equal(first.backend, "local");
      assert.equal(first.user.email, "dev@example.com");
      assert.deepEqual(first.user.bots, []);

      const saved = await saveUserBotsAndSettings(root, profile.googleSub, {
        bots: [{ id: "bot1", name: "Research" }],
        settings: { model: "gpt-4.1-mini" }
      });
      assert.equal(saved.backend, "local");
      assert.equal(saved.user.bots.length, 1);
      assert.equal(saved.user.settings.model, "gpt-4.1-mini");

      const loaded = await getUserByGoogleSub(root, profile.googleSub);
      assert.equal(loaded.backend, "local");
      assert.equal(loaded.user?.bots[0]?.name, "Research");

      const raw = await readFile(join(root, USER_STORE_DIR_NAME, "sub-abc.json"), "utf8");
      assert.match(raw, /dev@example.com/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves bots across profile upserts", async () => {
    delete process.env.MONGODB_URI;
    const root = await mkdtemp(join(tmpdir(), "openbots-userstore-"));
    try {
      await upsertGoogleUser(root, {
        googleSub: "sub-keep",
        email: "a@example.com",
        name: "A",
        picture: null
      });
      await saveUserBotsAndSettings(root, "sub-keep", { bots: [{ id: "x", name: "X" }] });
      const again = await upsertGoogleUser(root, {
        googleSub: "sub-keep",
        email: "b@example.com",
        name: "B",
        picture: "https://example.com/p.png"
      });
      assert.equal(again.user.email, "b@example.com");
      assert.equal(again.user.bots[0]?.name, "X");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

it("stale roster writes cannot revive a deleted bot", () => {
  const deleted = preserveBotDeletions([{id: "medium", name: "Medium"}], [{id: "medium", deleted: true}]);
  const stale = preserveBotDeletions(deleted, [{id: "medium", name: "Medium"}, {id: "new", name: "New"}]);
  assert.deepEqual(stale, [{id: "new", name: "New"}, {id: "medium", deleted: true}]);
});


it("shares one Mongo change stream, isolates user notifications and closes on unsubscribe", async (t) => {
  const previousUri = process.env.MONGODB_URI;
  await resetUserStoreForTests();
  process.env.MONGODB_URI = "mongodb://test.invalid";
  const stream = new EventEmitter() as EventEmitter & { close: () => Promise<void> };
  let closes = 0;
  let watches = 0;
  stream.close = async () => { closes++; stream.emit("close"); };
  const collection = {
    createIndex: async () => "index",
    watch: (_pipeline: unknown, options: unknown) => {
      watches++;
      assert.deepEqual(options, { fullDocument: "updateLookup", maxAwaitTimeMS: 1000 });
      return stream;
    }
  };
  t.mock.method(MongoClient.prototype, "connect", async function(this: MongoClient) { return this; });
  t.mock.method(MongoClient.prototype, "db", () => ({ collection: () => collection }));
  t.mock.method(MongoClient.prototype, "close", async () => {});
  try {
    let first = 0;
    let second = 0;
    const stopFirst = subscribeUserChanges("first", () => { first++; });
    const stopSecond = subscribeUserChanges("second", () => { second++; });
    await new Promise(resolve => setImmediate(resolve));
    first = second = 0;
    stream.emit("change", { operationType: "update", fullDocument: { googleSub: "first" } });
    assert.equal(first, 1);
    assert.equal(second, 0);
    assert.equal(watches, 1);
    stopFirst();
    assert.equal(closes, 0);
    stream.emit("change", { operationType: "insert", fullDocument: { googleSub: "second" } });
    assert.equal(second, 1);
    stopSecond();
    assert.equal(closes, 1);
  } finally {
    await resetUserStoreForTests();
    if (previousUri === undefined) delete process.env.MONGODB_URI;
    else process.env.MONGODB_URI = previousUri;
  }
});
