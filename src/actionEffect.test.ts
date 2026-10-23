import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyBrowserAction,
  classifyLabel,
  describeEffectAction,
  effectRequiresApproval,
  isCssSelector,
  maxEffect,
  normalizeLabel
} from "./actionEffect.js";

test("labels classify by verb, not by platform", () => {
  // The whole point: none of these name a platform, yet they cover all of them.
  for (const label of ["Follow", "Connect", "Send", "Post", "Publish", "Comment", "Like", "Endorse", "Apply"]) {
    assert.equal(classifyLabel(label), "outward", `${label} should be outward`);
  }
  for (const label of ["Delete", "Delete account", "Pay now", "Buy now", "Place order", "Confirm payment"]) {
    assert.equal(classifyLabel(label), "irreversible", `${label} should be irreversible`);
  }
  for (const label of ["Save", "Filter", "Next", "Close", "Download", "Edit", "Show more"]) {
    assert.equal(classifyLabel(label), "reversible", `${label} should be reversible`);
  }
});

test("platforms this code has never heard of are still covered", () => {
  // No Mastodon/Shopify/Patreon pattern exists anywhere in this repo.
  assert.equal(classifyLabel("Boost"), null, "unknown verb is honestly unknown, not silently safe");
  assert.equal(classifyLabel("Send invite"), "outward");
  assert.equal(classifyLabel("Publish listing"), "outward");
  assert.equal(classifyLabel("Confirm and pay"), "irreversible");
  assert.equal(classifyLabel("Start campaign"), "outward");
});

test("nav nouns are reads when they are links, actions when they are buttons", () => {
  assert.equal(classifyLabel("Followers", "link"), "read");
  assert.equal(classifyLabel("Connections", "tab"), "read");
  // Instagram's "Following" *button* unfollows when clicked - it must not be read as a tab.
  assert.equal(classifyLabel("Following", "button"), "outward");
});

test("strictest pattern wins over a harmless-looking prefix", () => {
  assert.equal(classifyLabel("Cancel"), "reversible");
  assert.equal(classifyLabel("Cancel subscription"), "irreversible");
  assert.equal(classifyLabel("Save"), "reversible");
  assert.equal(classifyLabel("Remove from list"), "irreversible");
});

test("unreadable labels report unknown rather than guessing", () => {
  assert.equal(classifyLabel(""), null);
  assert.equal(classifyLabel(undefined), null);
  assert.equal(classifyLabel("1.2K"), null, "a bare count carries no verb");
});

test("the model can raise the effect level but never lower it", () => {
  const lying = classifyBrowserAction({
    toolName: "click_mark",
    label: "Delete account",
    declaredEffect: "read"
  });
  assert.equal(lying.effect, "irreversible", "a false declaration cannot unlock the gate");
  assert.equal(lying.declared, "read");
  assert.equal(lying.observed, "irreversible");

  const cautious = classifyBrowserAction({
    toolName: "click_mark",
    label: "Save",
    declaredEffect: "outward"
  });
  assert.equal(cautious.effect, "outward", "the model knows Save-on-profile is public; let it say so");
});

test("icon-only buttons fall back to the declaration", () => {
  const undeclared = classifyBrowserAction({ toolName: "click_mark", label: "" });
  assert.equal(undeclared.effect, "reversible");
  assert.equal(undeclared.observed, null);
  assert.match(undeclared.reason, /icon-only/);

  const declared = classifyBrowserAction({ toolName: "click_mark", label: "", declaredEffect: "outward" });
  assert.equal(declared.effect, "outward", "the heart icon on a post is outward and the model knows it");
});

test("garbage declarations are ignored, not trusted", () => {
  const decision = classifyBrowserAction({
    toolName: "click_mark",
    label: "Follow",
    declaredEffect: "totally-safe-i-promise"
  });
  assert.equal(decision.declared, null);
  assert.equal(decision.effect, "outward");
});

test("typing is a draft until Enter sends it", () => {
  const drafting = classifyBrowserAction({ toolName: "type_mark", label: "Add a comment", pressEnter: false });
  assert.equal(drafting.effect, "reversible");

  const sending = classifyBrowserAction({ toolName: "type_mark", label: "Add a comment", pressEnter: true });
  assert.equal(sending.effect, "outward");

  const searching = classifyBrowserAction({ toolName: "type_mark", label: "Search", pressEnter: true });
  assert.equal(searching.effect, "reversible", "Enter in a search box is not outward");
});

test("a readable label is not inflated by the unknown-element baseline", () => {
  const navLink = classifyBrowserAction({ toolName: "click_mark", label: "Followers", role: "link" });
  assert.equal(navLink.effect, "read", "a link we could read is a read, not a maybe");
  assert.equal(navLink.observed, "read");
});

test("read-only tools are never gated", () => {
  for (const toolName of ["navigate", "scroll", "screenshot", "web_search"]) {
    const decision = classifyBrowserAction({ toolName, declaredEffect: "irreversible" });
    assert.equal(decision.effect, "read", `${toolName} observes only`);
  }
});

test("standing approval covers outward but never irreversible", () => {
  assert.equal(effectRequiresApproval("read", false), false);
  assert.equal(effectRequiresApproval("reversible", false), false);

  assert.equal(effectRequiresApproval("outward", false), true);
  assert.equal(effectRequiresApproval("outward", true), false, "'Approve for me' is exactly this");

  assert.equal(effectRequiresApproval("irreversible", false), true);
  assert.equal(
    effectRequiresApproval("irreversible", true),
    true,
    "approving follows is not consent to spend money or delete things"
  );
});

test("maxEffect orders the taxonomy", () => {
  assert.equal(maxEffect("read", "outward"), "outward");
  assert.equal(maxEffect("irreversible", "outward"), "irreversible");
  assert.equal(maxEffect("reversible", "read"), "reversible");
});

test("normalizeLabel strips decoration without losing the verb", () => {
  assert.equal(normalizeLabel("  Follow  "), "follow");
  assert.equal(normalizeLabel("Send — now!"), "send now");
  assert.equal(normalizeLabel("Pay $49.00"), "pay 49 00");
});

test("approval prompts name the real button", () => {
  assert.match(describeEffectAction("click_mark", "Send connection request", "outward"), /Send connection request/);
  assert.match(describeEffectAction("click_mark", "Delete", "irreversible"), /irreversible/);
  assert.match(describeEffectAction("click_mark", undefined, "outward"), /unlabelled/);
});

test("CSS selectors are not mined for verbs", () => {
  assert.equal(isCssSelector("#post-list a"), true);
  assert.equal(isCssSelector(".follow-button"), true);
  assert.equal(isCssSelector("button[data-id='send']"), true);
  assert.equal(isCssSelector("div.card"), true);

  assert.equal(isCssSelector("Send connection request"), false, "prose is not a selector");
  assert.equal(isCssSelector("Follow"), false);
  assert.equal(isCssSelector("Pay $49.00"), false);
});
