import test from "node:test";
import assert from "node:assert/strict";
import { DiscussionController, type DiscussionLimits } from "./discussionController";

const limits: DiscussionLimits = { maxConsultations: 4, maxPerBot: 2, maxDurationMs: 180_000, repeatSimilarity: .85, contextChars: 12_000 };
function admit(control: DiscussionController, bot: string, task = "Diagnose ranking", context = "") {
  const result = control.request(bot, task, context);
  if (!result.allowed) assert.fail(result.reason);
  return result.consultation.id;
}

test("the fourteen-round SEO failure stops after two repeated specialist answers", () => {
  const control = new DiscussionController("Coordinator", limits);
  let calls = 0;
  for (let round = 1; round <= 14; round++) {
    const admission = control.request("SEO Specialist", `Reconcile the ranking cause, round ${round}`, "Indexed; 140 impressions; 0 clicks; page position 85.8.");
    if (!admission.allowed) break;
    calls++;
    control.record(admission.consultation.id, { success: true, summary: "The page is indexed. It has 140 impressions, 0 clicks, and position 85.8. Inspect the canonical and compare the query intent with the page." });
    if (control.phase === "synthesizing") break;
  }
  assert.equal(calls, 2);
  assert.equal(control.phase, "synthesizing");
  assert.match(control.stopReason!, /repeated/);
});

test("distinct specialists still share one total consultation budget", () => {
  const control = new DiscussionController("Coordinator", limits);
  for (const bot of ["SEO", "Content", "Funnel", "Social"]) {
    const id = admit(control, bot);
    control.record(id, { success: true, summary: `${bot} has returned its bounded recommendation.` });
  }
  assert.equal(control.phase, "synthesizing");
  assert.equal(control.request("Fifth bot", "Another topic").allowed, false);
  assert.equal(control.consultations.length, 4);
});

test("a legacy 24-round setting cannot bypass the per-specialist budget", () => {
  const control = new DiscussionController("Coordinator", { ...limits, maxConsultations: 24 });
  control.record(admit(control, "SEO", "Question one"), { success: true, summary: "Indexed and accessible." });
  control.record(admit(control, "seo", "Question two"), { success: true, summary: "Commercial intent requires comparisons and specific examples." });
  const blocked = control.request(" SEO ", "Question three");
  assert.equal(blocked.allowed, false);
  assert.match(control.stopReason!, /per-specialist/);
});

test("the same question with unchanged context is not sent twice", () => {
  const control = new DiscussionController("Coordinator", limits);
  control.record(admit(control, "SEO", "Check canonical", "Selected canonical: inspected URL"), { success: true, summary: "The reported canonical matches." });
  assert.equal(control.request("SEO", "Check canonical", "Selected canonical: inspected URL").allowed, false);
  assert.match(control.stopReason!, /same question/);
});

test("fresh supplied evidence allows one focused follow-up and retains prior findings", () => {
  const control = new DiscussionController("Coordinator", limits);
  control.record(admit(control, "SEO", "Check canonical", "Canonical value unreadable"), { success: true, summary: "Canonical identity is unknown.", outcomeRef: "outcome_first" });
  admit(control, "SEO", "Check canonical", "Google-selected canonical: Inspected URL. Fetch succeeded.");
  const context = control.context();
  assert.match(context, /Canonical value unreadable/);
  assert.match(context, /Google-selected canonical: Inspected URL/);
  assert.match(context, /outcome_first/);
  assert.match(context, /not independent verification/);
});

for (const result of [
  { success: true, summary: "Handing off to SEO Specialist — inspect this report." },
  { success: true, summary: "I’m checking with Funnel and will bring the result back." },
  { success: true, summary: "" },
  { success: true, summary: "Consult another bot.", delegated: true },
  { success: false, summary: "The tool is unavailable." }
]) {
  test(`invalid or failed worker result forces a final synthesis: ${result.summary || "empty"}`, () => {
    const control = new DiscussionController("Coordinator", limits);
    control.record(admit(control, "SEO"), result);
    assert.equal(control.phase, "synthesizing");
    assert.equal(control.consultations[0].status, "failed");
  });
}

test("duplicate bus delivery and duplicate completion cannot run a consultation twice", () => {
  const control = new DiscussionController("Coordinator", limits);
  const id = admit(control, "SEO");
  assert.equal(control.claim(id), true);
  assert.equal(control.claim(id), false);
  assert.equal(control.record(id, { success: true, summary: "A bounded finding." }), true);
  assert.equal(control.record(id, { success: true, summary: "A duplicate finding." }), false);
  assert.equal(control.consultations[0].summary, "A bounded finding.");
});

test("elapsed time is shared across specialists and coordinator turns", () => {
  let now = 0;
  const control = new DiscussionController("Coordinator", limits, () => now);
  const id = admit(control, "SEO");
  now = limits.maxDurationMs;
  control.record(id, { success: true, summary: "Indexed." });
  assert.equal(control.phase, "synthesizing");
  assert.match(control.stopReason!, /time budget/);
  assert.equal(control.request("Funnel", "Check conversions").allowed, false);
});

test("user cancellation and completion prevent new handoffs or stale result revival", () => {
  const control = new DiscussionController("Coordinator", limits);
  const id = admit(control, "SEO");
  control.cancel();
  assert.equal(control.record(id, { success: true, summary: "Late reply." }), false);
  assert.equal(control.request("Funnel", "Next check").allowed, false);
  assert.equal(control.phase, "cancelled");
  const complete = new DiscussionController("Coordinator", limits);
  complete.finish(true);
  assert.equal(complete.request("SEO", "A new task").allowed, false);
  assert.equal(complete.phase, "completed");
});

test("self consultation is rejected and bounded context remains bounded under long replies", () => {
  const self = new DiscussionController("Coordinator", limits);
  assert.equal(self.request(" coordinator ", "Delegate to myself").allowed, false);
  const control = new DiscussionController("Coordinator", limits);
  for (const bot of ["SEO", "Content", "Funnel", "Social"]) {
    control.record(admit(control, bot, "Question ".repeat(1000), "Supplied observation ".repeat(1000)), { success: true, summary: `${bot} ${"Finding ".repeat(2000)}` });
  }
  assert.ok(control.context().length <= limits.contextChars);
  for (const bot of ["SEO", "Content", "Funnel", "Social"]) assert.ok(control.context().includes(bot));
});
