import test from "node:test";
import assert from "node:assert/strict";
import { connectCdp } from "./cdpConnection";

test("CDP retries transient attachment against the same endpoint within a finite budget", async () => {
  const previous = process.env.BROWSER_AGENT_CDP_CONNECT_ATTEMPTS;
  process.env.BROWSER_AGENT_CDP_CONNECT_ATTEMPTS = "2";
  try {
    let calls = 0;
    const endpoint = "http://127.0.0.1:9222";
    const connected = await connectCdp(endpoint, async (target, options) => {
      assert.equal(target, endpoint); assert.ok(options.timeout > 0);
      if (++calls === 1) throw new Error("connectOverCDP: Timeout exceeded");
      return "same-session";
    });
    assert.equal(connected, "same-session"); assert.equal(calls, 2);
    calls = 0;
    await assert.rejects(connectCdp(endpoint, async () => { calls++; throw new Error("Timeout exceeded"); }), /Timeout/);
    assert.equal(calls, 2);
    calls = 0;
    await assert.rejects(connectCdp(endpoint, async () => { calls++; throw new Error("403 forbidden"); }), /forbidden/);
    assert.equal(calls, 1);
  } finally {
    if (previous === undefined) delete process.env.BROWSER_AGENT_CDP_CONNECT_ATTEMPTS;
    else process.env.BROWSER_AGENT_CDP_CONNECT_ATTEMPTS = previous;
  }
});
