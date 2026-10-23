import test from "node:test";
import assert from "node:assert/strict";

import { FixApprovalGate } from "./fixApproval";
import { FixProposal } from "./learnMode";

function proposal(ids: string[] = ["fix-1", "fix-2"]): FixProposal {
  return {
    sessionId: "session-1",
    task: "grow my followers",
    notes: [],
    fixes: ids.map((id) => ({
      id,
      patch: { file: "src/promptLoop.ts", find: id, replace: `${id}!`, rationale: "because" },
      preview: `- before:\n${id}\n- after:\n${id}!`
    }))
  };
}

test("approving settles the waiting session", async () => {
  const gate = new FixApprovalGate();
  const waiting = gate.request(proposal());
  assert.equal(gate.isWaiting, true);
  assert.equal(gate.pendingProposal?.sessionId, "session-1");

  assert.equal(gate.settle({ approved: true, patchIds: ["fix-1"] }), true);
  const decision = await waiting;
  assert.equal(decision.approved, true);
  assert.deepEqual(decision.patchIds, ["fix-1"]);
  assert.equal(gate.isWaiting, false);
  assert.equal(gate.pendingProposal, null);
});

test("declining settles with approved false", async () => {
  const gate = new FixApprovalGate();
  const waiting = gate.request(proposal());
  gate.settle({ approved: false, reason: "I'll read it myself" });
  const decision = await waiting;
  assert.equal(decision.approved, false);
  assert.match(decision.reason ?? "", /read it myself/);
});

test("no answer times out as a decline, not as an approval", async () => {
  const gate = new FixApprovalGate(30);
  const decision = await gate.request(proposal());
  assert.equal(decision.approved, false, "silence must never mean yes");
  assert.match(decision.reason ?? "", /nobody answered/);
  assert.equal(gate.isWaiting, false);
});

test("a duplicate or late decision is a no-op rather than an error", async () => {
  const gate = new FixApprovalGate();
  const waiting = gate.request(proposal());
  assert.equal(gate.settle({ approved: true }), true);
  assert.equal(gate.settle({ approved: false }), false, "second click decides nothing");
  assert.equal((await waiting).approved, true);
  assert.equal(gate.settle({ approved: true }), false, "nothing pending");
});

test("a second proposal while one waits is declined instead of orphaning it", async () => {
  const gate = new FixApprovalGate();
  const first = gate.request(proposal(["fix-1"]));
  const second = await gate.request(proposal(["fix-9"]));

  assert.equal(second.approved, false);
  assert.match(second.reason ?? "", /already waiting/);
  assert.equal(gate.pendingProposal?.fixes[0].id, "fix-1", "the first proposal still owns the gate");

  gate.settle({ approved: false });
  assert.equal((await first).approved, false);
});

test("patch ids are filtered down to the ones in the pending proposal", () => {
  const gate = new FixApprovalGate();
  void gate.request(proposal(["fix-1", "fix-2"]));

  assert.deepEqual(gate.normalizePatchIds(["fix-2", "fix-404", 7, null]), ["fix-2"]);
  assert.deepEqual(gate.normalizePatchIds(undefined), undefined, "undefined means every patch");
  assert.deepEqual(gate.normalizePatchIds("fix-1"), undefined);
  assert.deepEqual(gate.normalizePatchIds([]), []);
});
