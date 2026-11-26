import test from "node:test";
import assert from "node:assert/strict";
import { externalChromeEndpoint, requestedBrowserTarget } from "./browserIntent";

test("an external Chrome correction and a short reply retain the requested profile", () => {
  const first = { role: "user", text: "can you check in the browser from catherine profile" };
  const correction = { role: "user", text: "not from your inbrowser but from outside chrome" };
  assert.deepEqual(requestedBrowserTarget(first.text), { external: false, profile: "catherine" });
  const external = { external: true, profile: "catherine" };
  assert.deepEqual(requestedBrowserTarget(correction.text, [first]), external);
  const history = [first, correction, { role: "agent", text: "Reply use the browser" }];
  assert.deepEqual(requestedBrowserTarget("yep", history), external);
  assert.equal(requestedBrowserTarget("no browser", history), undefined);
  assert.equal(requestedBrowserTarget("summarize the results", history), undefined);
  assert.equal(requestedBrowserTarget("check my user profile"), undefined);
});

test("external targets resolve only to the operator's matching loopback connection", () => {
  assert.equal(externalChromeEndpoint("catherine", "Catherine", "http://127.0.0.1:9222"), "http://127.0.0.1:9222");
  assert.equal(externalChromeEndpoint("other", "Catherine", "http://127.0.0.1:9222"), undefined);
  assert.equal(externalChromeEndpoint("catherine", "Catherine", "http://external.example:9222"), undefined);
  assert.equal(externalChromeEndpoint("catherine", "Catherine", "http://localhost:99999"), undefined);
});
