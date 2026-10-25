import assert from "node:assert/strict";
import test from "node:test";
import { assessTaskRisk, redactSecrets, redactSecretValues } from "./security";

const approval = "external_side_effect";

test("harmless YouTube learning requests do not prompt for approval", () => {
  const task = "Continue as YouTube Concept Learner (understand videos like Codex). What can I learn and apply from this video?";
  assert.deepEqual(assessTaskRisk(task).approvalsRequired, []);
});

test("an analogy using like does not look like a social action", () => {
  assert.deepEqual(assessTaskRisk("Explain this workflow like ChatGPT does." ).approvalsRequired, []);
});

test("writing code comments does not look like publishing a social comment", () => {
  assert.deepEqual(assessTaskRisk("Add comments to explain this function." ).approvalsRequired, []);
});

test("analyzing a social post does not look like publishing one", () => {
  assert.deepEqual(assessTaskRisk("Analyze this post and summarize its main idea." ).approvalsRequired, []);
});

test("following a set of steps does not look like following an account", () => {
  assert.deepEqual(assessTaskRisk("Follow these steps to install the package." ).approvalsRequired, []);
});

test("liking a named social post requires approval", () => {
  assert.deepEqual(assessTaskRisk("Please like this post on Instagram." ).approvalsRequired, [approval]);
});

test("reacting to a video requires approval", () => {
  assert.deepEqual(assessTaskRisk("React to the video on my account." ).approvalsRequired, [approval]);
});

test("following an account requires approval", () => {
  assert.deepEqual(assessTaskRisk("Follow @example on Instagram." ).approvalsRequired, [approval]);
});

test("posting content requires approval", () => {
  assert.deepEqual(assessTaskRisk("Publish this announcement to LinkedIn." ).approvalsRequired, [approval]);
});

test("sending a direct message requires approval", () => {
  assert.deepEqual(assessTaskRisk("Send a DM to the creator." ).approvalsRequired, [approval]);
});

test("deleting content requires approval", () => {
  assert.deepEqual(assessTaskRisk("Delete the old campaign post." ).approvalsRequired, [approval]);
});

test("purchases require financial approval", () => {
  assert.deepEqual(assessTaskRisk("Buy the annual plan." ).approvalsRequired, ["financial_transaction"]);
});

test("publishing secrets is blocked, not merely approval-gated", () => {
  const result = assessTaskRisk("Post my API key publicly on GitHub.");
  assert.equal(result.blocked, true);
  assert.deepEqual(result.approvalsRequired, []);
});

test("LinkedIn networking actions require approval", () => {
  // "connect" is LinkedIn's primary verb and used to pass the gate entirely, so the agent could
  // put connection requests in real inboxes under the user's name with no prompt.
  for (const task of [
    "connect with 20 founders on LinkedIn",
    "send connection requests to these prospects",
    "send 15 invites to the people on this list",
    "invite these recruiters to connect",
    "connect with @someone",
    "endorse their skills on LinkedIn",
    "accept all pending invitations",
    "withdraw my sent connection requests"
  ]) {
    assert.deepEqual(assessTaskRisk(task).approvalsRequired, [approval], task);
  }
});

test("ordinary uses of connect and invite stay ungated", () => {
  for (const task of [
    "connect to the database and run the migration",
    "connect the API to the frontend",
    "explain how OAuth connects the two services",
    "check whether the websocket reconnects after a drop",
    "summarize the LinkedIn post about hiring",
    "research which founders are worth connecting with later"
  ]) {
    assert.deepEqual(assessTaskRisk(task).approvalsRequired, [], task);
  }
});

test("cold-email campaign actions require approval", () => {
  // Starting a sequence puts real mail in real inboxes under the user's domain; it cannot be
  // unsent, and it carries CAN-SPAM / GDPR obligations.
  for (const task of [
    "launch the Instantly sequence",
    "start the cold outreach campaign",
    "resume my campaign in instantly.ai",
    "start sending to the warm list",
    "send these 200 cold emails",
    "upload this lead list to the Instantly campaign",
    "add these leads to the sequence",
    "enroll these prospects in the Lemlist sequence"
  ]) {
    assert.deepEqual(assessTaskRisk(task).approvalsRequired, [approval], task);
  }
});

test("researching and drafting outreach stays ungated", () => {
  for (const task of [
    "draft a cold email sequence for SaaS founders",
    "review my Instantly campaign stats and tell me the reply rate",
    "research which lead list performed best",
    "write three subject line variants for the campaign",
    "explain how Instantly handles inbox rotation"
  ]) {
    assert.deepEqual(assessTaskRisk(task).approvalsRequired, [], task);
  }
});

 test("quoted draft titles and payment questions are not purchases", () => {
  for (const task of [
    'Draft ideas: “A local service website checklist before spending on ads”. Useful trade communities.',
    'Write “What should we buy for a better website?”',
    'Why does this require payment? Explain why we need to pay.',
    'Do not buy links. Never purchase ads.'
  ]) assert.ok(!assessTaskRisk(task).approvalsRequired.includes("financial_transaction"), task);
  for (const task of ['Buy the annual plan.', 'Research options and buy the annual plan.', 'Pay the invoice.'])
    assert.ok(assessTaskRisk(task).approvalsRequired.includes("financial_transaction"), task);
});

test("redacts opaque environment credentials, nested events and database URLs", () => {
  const previous = process.env.AUDIT_TEST_SECRET;
  const secret = "opaque-" + "credential".repeat(3);
  process.env.AUDIT_TEST_SECRET = secret;
  try {
    assert.ok(!redactSecrets(`provider error: ${secret}`).includes(secret));
    assert.ok(!redactSecrets("mongodb+srv://" + "user:unknown-password@cluster.invalid/db").includes("unknown-password"));
    const original = { toolInput: { apiKey: "opaque-key", text: `value ${secret}` }, totalTokens: 12 };
    const safe = redactSecretValues(original);
    assert.equal(safe.toolInput.apiKey, "[REDACTED]");
    assert.ok(!safe.toolInput.text.includes(secret));
    assert.equal(safe.totalTokens, 12);
    assert.equal(original.toolInput.apiKey, "opaque-key");
  } finally {
    if (previous === undefined) delete process.env.AUDIT_TEST_SECRET;
    else process.env.AUDIT_TEST_SECRET = previous;
  }
});

test("redaction preserves JSON argument syntax for replayed tool calls", () => {
  const argumentsJson = JSON.stringify({ apiKey: "opaque-credential", target: "report" });
  const safe = JSON.parse(redactSecrets(argumentsJson));
  assert.equal(safe.apiKey, "[REDACTED]");
  assert.equal(safe.target, "report");
});
