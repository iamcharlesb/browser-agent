import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  getUserByGoogleSub,
  resetUserStoreForTests,
  saveUserBotsAndSettings,
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
