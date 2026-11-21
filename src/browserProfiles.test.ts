import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { BrowserProfiles } from "./browserProfiles";

test("browser profiles persist selection and keep cookies in separate user-data directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilo-profiles-"));
  try {
    const profiles = new BrowserProfiles(root);
    const work = profiles.create("Work"), personal = profiles.create("Personal");
    assert.notEqual(work.port, personal.port);
    assert.notEqual(profiles.directory(work.id), profiles.directory(personal.id));
    profiles.select(work.id);
    assert.equal(new BrowserProfiles(root).active().id, work.id);
    assert.throws(() => profiles.create("work"), /already exists/);
    assert.throws(() => profiles.select("../../outside"), /Unknown/);
    const first = await chromium.launchPersistentContext(profiles.directory(work.id), { headless: true });
    try { await first.addCookies([{ name: "session", value: "test-work-login", domain: "example.test", path: "/", expires: Math.floor(Date.now() / 1000) + 3600 }]); }
    finally { await first.close(); }
    const other = await chromium.launchPersistentContext(profiles.directory(personal.id), { headless: true });
    try { assert.equal((await other.cookies()).length, 0); } finally { await other.close(); }
    const back = await chromium.launchPersistentContext(profiles.directory(work.id), { headless: true });
    try { assert.equal((await back.cookies()).find(cookie => cookie.name === "session")?.value, "test-work-login"); } finally { await back.close(); }
    profiles.select("default");
    assert.equal(profiles.active().id, "default");
  } finally { await rm(root, { recursive: true, force: true }); }
});
