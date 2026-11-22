import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

const html = readFileSync(join(__dirname, "../static/index.html"), "utf8");
function source(name: string) {
  const start = html.indexOf("  function " + name + "(");
  assert.ok(start >= 0);
  return html.slice(start, html.indexOf("\n  function ", start + 1));
}

test("restoring a running bot uses readable activity instead of raw tool JSON", () => {
  const record = {
    ownerId: "seo", runId: "run-seo", botName: "SEO Specialist", status: "running",
    lastStep: { step: 2, toolName: "knowledge_base", message: JSON.stringify({ browserProfile: { id: "default" }, roster: [], jobs: [] }) }
  };
  const context: any = {
    learnEvents: null, activeAgentId: "seo", queuedRunsAfterActive: [],
    runTracker: { activeFor: () => record },
    findPeerBotByQuery: () => ({ id: "seo" }),
    status: { textContent: "" }, stepCounter: { textContent: "" },
    setAgentMotion() {}, setStatusState() {}, renderCommandQueue() {},
    setRunPresence(activity: string) { context.presence = activity; }
  };
  vm.createContext(context);
  vm.runInContext(source("runStepActivity") + source("restoreSelectedRun"), context);
  context.restoreSelectedRun(false);
  assert.equal(context.status.textContent, "Reading workspace knowledge");
  assert.equal(context.presence, "Reading workspace knowledge");
  assert.equal(context.stepCounter.textContent, "Step 2");
  for (const message of ['  {"browserProfile":{}}', '[{"id":"default"}]']) {
    assert.equal(context.runStepActivity({ message }), "Thinking");
  }
  assert.equal(context.runStepActivity({ message: "Checking keyword coverage" }), "Checking keyword coverage");
  assert.equal(context.runStepActivity({ toolName: "web_search", message: "{}" }), "Searching the web");
});
