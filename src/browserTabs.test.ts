import test from "node:test";
import assert from "node:assert/strict";
import { executeTool, TOOLS } from "./agentTools";
import type { BrowserController } from "./browserController";

test("navigation exposes an explicit choice between reusing and opening a tab", async () => {
  const calls: string[] = [];
  const browser = { navigate: async (url: string) => { calls.push("current:" + url); },
    newTab: async (url: string) => { calls.push("new:" + url); }, currentUrl: () => "https://example.test/" } as unknown as BrowserController;
  assert.equal((await executeTool("navigate", { url: "https://example.test/" }, browser)).ok, true);
  assert.equal((await executeTool("navigate", { url: "https://example.test/", newTab: false }, browser)).ok, true);
  const opened = await executeTool("navigate", { url: "https://example.test/", newTab: true }, browser);
  assert.equal(opened.ok, true);
  assert.match(opened.message, /Opened a new tab/);
  assert.equal((await executeTool("navigate", { url: "https://example.test/", newTab: "false" }, browser)).ok, false);
  assert.deepEqual(calls, ["current:https://example.test/", "current:https://example.test/", "new:https://example.test/"]);
  const tool = TOOLS.find(tool => tool.type === "function" && tool.function.name === "navigate");
  assert.ok(tool && tool.type === "function");
  assert.ok((tool.function.parameters?.properties as Record<string, unknown>).newTab);
});
