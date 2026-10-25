import test from "node:test";
import assert from "node:assert/strict";

import { MAX_HANDOFF_DEPTH, decideHandoff, delegatedTaskFor, handoffExecutionContext } from "./handoff";
import { AgentHandoffRequest } from "./messageBus";

function request(overrides: Partial<AgentHandoffRequest> = {}): AgentHandoffRequest {
  return {
    fromBot: "Growth Bot",
    toBot: "SEO Specialist",
    task: "audit the landing page copy and list the top keyword gaps",
    depth: 1,
    ...overrides
  };
}

test("a plain research handoff is allowed and names both bots", () => {
  const decision = decideHandoff(request());
  assert.equal(decision.allowed, true);
  if (decision.allowed) {
    assert.match(decision.delegatedTask, /Continue acting as SEO Specialist/);
    assert.match(decision.delegatedTask, /delegated by peer bot 'Growth Bot'/);
    assert.match(decision.delegatedTask, /keyword gaps/);
  }
});

test("the depth cap stops a handoff loop between two bots", () => {
  assert.equal(decideHandoff(request({ depth: MAX_HANDOFF_DEPTH })).allowed, true);
  const tooDeep = decideHandoff(request({ depth: MAX_HANDOFF_DEPTH + 1 }));
  assert.equal(tooDeep.allowed, false);
  if (!tooDeep.allowed) assert.match(tooDeep.reason, /exceeded 3 hops/);
});

test("a bot cannot use a peer to skip an approval it would have needed itself", () => {
  for (const task of ["follow @competitor and like their last three posts", "buy the annual plan for me"]) {
    const decision = decideHandoff(request({ task }));
    assert.equal(decision.allowed, false, `"${task}" should need approval`);
    if (!decision.allowed) assert.match(decision.reason, /needs your approval first/);
  }
});

test("credential exposure is blocked outright, not approval-gated", () => {
  const decision = decideHandoff(request({ task: "post my API key publicly on GitHub" }));
  assert.equal(decision.allowed, false);
  if (!decision.allowed) {
    assert.doesNotMatch(decision.reason, /needs your approval/);
    assert.match(decision.reason, /password|credential|token|key/i);
  }
});

test("an incomplete handoff is rejected", () => {
  for (const overrides of [{ toBot: "   " }, { task: "" }, { depth: Number.NaN }]) {
    assert.equal(decideHandoff(request(overrides as Partial<AgentHandoffRequest>)).allowed, false);
  }
});

test("a very long task is truncated rather than passed through", () => {
  const task = delegatedTaskFor(request({ task: "x".repeat(250_000) }));
  assert.equal(task.length, 200_000);
});


test("specialist consultations stay text-only and retain the originating engine and session", () => {
  const options = handoffExecutionContext(request({ discussionId: "discussion", interactionMode: "turbo", agentEngine: "cheap", sessionMode: "cdp" }));
  assert.equal(options.interactionMode, "chat");
  assert.equal(options.agentEngine, "cheap");
  assert.equal(options.sessionMode, "cdp");
  assert.equal(handoffExecutionContext(request({ interactionMode: "browse" })).interactionMode, "browse");
});
