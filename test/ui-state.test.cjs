const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

function load() {
  const window = {};
  const sandbox = { window, Object, Set, TypeError };
  vm.runInNewContext(readFileSync(join(__dirname, "../static/uiState.js"), "utf8"), sandbox);
  return window.OpenBuddyUI;
}

test("UI store supports immutable snapshots, subscriptions and unsubscribe", () => {
  const { createStore } = load();
  const store = createStore({ selectedBotId: null });
  let hits = 0;
  const unsubscribe = store.subscribe(() => { hits++; });
  const old = store.getState();
  store.setState({ selectedBotId: "bot-1" });
  assert.equal(store.getState().selectedBotId, "bot-1");
  assert.equal(old.selectedBotId, null);
  assert.equal(hits, 1);
  store.setState({ selectedBotId: "bot-1" });
  assert.equal(hits, 1);
  unsubscribe();
  store.setState({ selectedBotId: "bot-2" });
  assert.equal(hits, 1);
});
