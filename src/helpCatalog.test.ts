import test from "node:test";
import assert from "node:assert/strict";
import { getHelpCatalog } from "./helpCatalog";

test("getHelpCatalog returns all topics by default and filters by topic", () => {
  const full = getHelpCatalog();
  assert.equal(full.topic, null);
  assert.ok(full.items.length >= 5);
  assert.ok(full.topics.some((t) => t.id === "env"));
  assert.ok(full.topics.some((t) => t.id === "ollama"));
  assert.ok(full.topics.some((t) => t.id === "gateway"));

  const envOnly = getHelpCatalog("env");
  assert.equal(envOnly.topic, "env");
  assert.equal(envOnly.items.length, 1);
  assert.equal(envOnly.items[0].id, "env");
  assert.match(envOnly.items[0].snippet || "", /BROWSER_AGENT_PROVIDER/);
});
