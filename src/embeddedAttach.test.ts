import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { BrowserController, browserSessionConfig } from "./browserController";

for (const missingTab of [false, true]) {
  test(`embedded attachment uses the broker target without Target.createTarget (missing tab: ${missingTab})`, async t => {
    const previousUrl = process.env.OPEN_BOTS_BROWSER_BROKER_URL;
    const previousToken = process.env.OPEN_BOTS_BROWSER_BROKER_TOKEN;
    process.env.OPEN_BOTS_BROWSER_BROKER_URL = "http://broker.invalid";
    process.env.OPEN_BOTS_BROWSER_BROKER_TOKEN = "test-broker-token";
    t.after(() => {
      if (previousUrl === undefined) delete process.env.OPEN_BOTS_BROWSER_BROKER_URL; else process.env.OPEN_BOTS_BROWSER_BROKER_URL = previousUrl;
      if (previousToken === undefined) delete process.env.OPEN_BOTS_BROWSER_BROKER_TOKEN; else process.env.OPEN_BOTS_BROWSER_BROKER_TOKEN = previousToken;
    });
    let created = !missingTab;
    let newTabs = 0;
    const page = {
      isClosed: () => false, url: () => "about:blank", on: () => {},
      setDefaultNavigationTimeout: () => {},
      evaluate: async () => { throw Error("Do not inspect arbitrary pages to choose the target"); }
    };
    const context = {
      pages: () => created ? [page] : [], on: () => {}, setDefaultTimeout: () => {},
      newPage: async () => { throw Error("Target.createTarget: Not supported"); },
      newCDPSession: async () => ({ send: async () => ({ targetInfo: { targetId: "owned-target" } }), detach: async () => {} })
    };
    t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
      if (String(url).endsWith("/json/version")) return new Response("{}", { status: 200 });
      if (String(url).endsWith("/command")) {
        assert.deepEqual(JSON.parse(String(init?.body)), { type: "new_tab", url: "about:blank" });
        created = true; newTabs++;
      }
      return Response.json({ activeTabId: created ? "owned" : null, tabs: created ? [{ id: "owned", targetId: "owned-target" }] : [] });
    });
    t.mock.method(chromium, "connectOverCDP", async () => ({ contexts: () => [context], close: async () => {} }) as any);
    const controller = new BrowserController(browserSessionConfig("embedded"));
    try {
      await controller.start();
      assert.equal(controller.isStarted, true);
      assert.equal(newTabs, missingTab ? 1 : 0);
    } finally { await controller.close(); }
  });
}

test("legacy embedded attachment fails clearly without creating a page or choosing the workspace UI", async t => {
  const previousUrl = process.env.OPEN_BOTS_BROWSER_BROKER_URL;
  delete process.env.OPEN_BOTS_BROWSER_BROKER_URL;
  t.after(() => { if (previousUrl === undefined) delete process.env.OPEN_BOTS_BROWSER_BROKER_URL; else process.env.OPEN_BOTS_BROWSER_BROKER_URL = previousUrl; });
  t.mock.method(globalThis, "fetch", async () => new Response("{}"));
  let newPages = 0;
  const context = { pages: () => [], newPage: async () => { newPages++; throw Error("Target.createTarget: Not supported"); } };
  t.mock.method(chromium, "connectOverCDP", async () => ({ contexts: () => [context], close: async () => {} }) as any);
  const controller = new BrowserController(browserSessionConfig("embedded"));
  await assert.rejects(controller.start(), /No live in-app browser tab/);
  assert.equal(newPages, 0);
});
