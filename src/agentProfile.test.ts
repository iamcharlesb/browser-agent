import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadAgentProfile } from "./agentProfile";

const root = join(__dirname, "..");
test("generic bots load compact core and voice without every niche playbook", () => {
  const profile = loadAgentProfile({ botName: "Primary Bot", task: "Explain the arithmetic", root });
  assert.deepEqual(profile.selected, []);
  assert.ok(profile.characters < 2400);
  assert.match(profile.instructions, /TOKEN DISCIPLINE/);
  assert.match(profile.soul, /Voice/);
});
test("The Revenue Architect has a compact direct-response profile with ethical guardrails", () => {
  const profile = loadAgentProfile({ botName: "The Revenue Architect", task: "Audit acquisition economics", root });
  assert.match(profile.instructions, /Never claim to be Sabri Suby/);
  assert.match(profile.instructions, /Never invent proof/);
  assert.match(profile.soul, /customer-obsessed/);
  assert.match(profile.playbooks, /allowable cost per lead/);
  assert.match(profile.playbooks, /approval before publishing/);
  assert.ok(profile.characters < 5600);
});
test("The Value Architect loads its compact role and on-demand offer/economics playbook", () => {
  const profile = loadAgentProfile({ botName: "The Value Architect", task: "Review offer pricing and unit economics", root });
  assert.match(profile.instructions, /never impersonate him/);
  assert.match(profile.soul, /commercially disciplined/);
  assert.ok(profile.selected.includes("value-architect"));
  assert.match(profile.playbooks, /value equation/i);
  const { readPlaybookPage } = require("./agentProfile") as typeof import("./agentProfile");
  const page = readPlaybookPage("value-architect", 0, root);
  assert.match(page.text, /North star and diagnosis/);
  assert.equal(page.text.length, 900);
});
test("The Systems Architect loads its compact role and on-demand engineering playbook", () => {
  const profile = loadAgentProfile({ botName: "The Systems Architect", task: "Review distributed systems architecture", root });
  assert.match(profile.instructions, /never impersonate them/i);
  assert.match(profile.instructions, /simplest operable system/);
  assert.ok(profile.selected.includes("systems-architect"));
  assert.match(profile.playbooks, /system design method/i);
  const { readPlaybookPage } = require("./agentProfile") as typeof import("./agentProfile");
  assert.match(readPlaybookPage("systems-architect", 0, root).text, /simplest architecture/i);
});
test("The Engineering Craftsman loads its compact role and on-demand quality/performance playbook", () => {
  const profile = loadAgentProfile({ botName: "The Engineering Craftsman", task: "Review web performance and AI-generated code", root });
  assert.match(profile.instructions, /never impersonate him/i);
  assert.match(profile.soul, /evidence over cleverness/);
  assert.ok(profile.selected.includes("engineering-craftsman"));
  assert.match(profile.playbooks, /Core Web Vitals/i);
  const { readPlaybookPage } = require("./agentProfile") as typeof import("./agentProfile");
  assert.match(readPlaybookPage("engineering-craftsman", 0, root).text, /Engineering Craftsman/);
});
test("The Neural Architect loads its compact identity and on-demand AI research playbook", () => {
  const profile = loadAgentProfile({ botName: "The Neural Architect", task: "Evaluate transformer inference and agent orchestration", root });
  assert.match(profile.instructions, /never impersonate him/i);
  assert.match(profile.soul, /experimentally humble/);
  assert.ok(profile.selected.includes("neural-architect"));
  assert.match(profile.playbooks, /First-principles approach/i);
  const { readPlaybookPage } = require("./agentProfile") as typeof import("./agentProfile");
  assert.match(readPlaybookPage("neural-architect", 0, root).text, /Neural Architect/);
});
test("known event names select only the playbooks mapped to that event", () => {
  const ux = loadAgentProfile({ botName: "UX Bot", task: "Handle review", event: "ux.review.requested", root });
  assert.deepEqual(ux.selected, ["ux"]);
  const paid = loadAgentProfile({ botName: "Ads Bot", task: "Handle update", event: "campaign.performance.updated", root });
  assert.deepEqual(paid.selected, ["paid-media"]);
});
test("deterministic selection isolates bot topics and enforces the context budget", () => {
  const profile = loadAgentProfile({ botName: "Reddit Community Growth", task: "Explain the next plan", root });
  assert.deepEqual(profile.selected, ["reddit"]);
  assert.match(profile.playbooks, /REDDIT/);
  assert.doesNotMatch(profile.playbooks, /LINKEDIN|INSTAGRAM/);
  assert.ok(profile.playbooks.length <= 3200);
  const approved = loadAgentProfile({ botName: "Research", task: "List keywords for the site", root, approvedPlaybook: "Verify the selected property before claiming it is empty." });
  assert.match(approved.playbooks, /selected property/);
  assert.ok(approved.selected.includes("seo"));
  assert.notEqual(approved.revision, profile.revision);
});
test("profile files cannot escape through symlinks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-profile-"));
  const outside = await mkdtemp(join(tmpdir(), "agent-profile-outside-"));
  try {
    await mkdir(join(directory, "playbooks"));
    await writeFile(join(directory, "AGENTS.md"), "Core");
    await writeFile(join(directory, "soul.md"), "Voice");
    await writeFile(join(outside, "private.md"), "Must never be loaded");
    await symlink(join(outside, "private.md"), join(directory, "playbooks", "escape.md"));
    await writeFile(join(directory, "playbooks", "manifest.json"), JSON.stringify({ version: 1, playbooks: [{ id: "escape", file: "escape.md", terms: ["escape"], events: [] }] }));
    assert.throws(() => loadAgentProfile({ botName: "Bot", task: "escape", root: directory }), /inside/);
  } finally { await rm(directory, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});
test("editing soul changes the next loaded revision without rewriting active runs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-profile-edit-"));
  try {
    await mkdir(join(directory, "playbooks"));
    await writeFile(join(directory, "AGENTS.md"), await readFile(join(root, "AGENTS.md")));
    await writeFile(join(directory, "soul.md"), "Voice one");
    await writeFile(join(directory, "playbooks", "manifest.json"), '{"version":1,"playbooks":[]}');
    const first = loadAgentProfile({ botName: "Bot", task: "Explain", root: directory });
    await writeFile(join(directory, "soul.md"), "Voice two");
    const second = loadAgentProfile({ botName: "Bot", task: "Explain", root: directory });
    assert.notEqual(first.revision, second.revision);
    assert.equal(first.soul, "Voice one");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("long role playbooks remain available through bounded on-demand pages", async () => {
  const { readPlaybookPage } = await import("./agentProfile");
  const first = readPlaybookPage("seo", 0, root);
  assert.ok(first.text.length <= 900);
  assert.equal(first.nextOffset, 900);
  const next = readPlaybookPage("seo", first.nextOffset!, root);
  assert.notEqual(next.text, first.text);
  assert.throws(() => readPlaybookPage("../../.env", 0, root), /Invalid/);
});

test("per-bot instructions and voice stay isolated while owner and reviewed procedures both load", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-profile-overrides-"));
  try {
    await mkdir(join(directory, "playbooks"));
    await mkdir(join(directory, "agents", "Writer_Bot"), { recursive: true });
    await writeFile(join(directory, "AGENTS.md"), "Shared operating rules.");
    await writeFile(join(directory, "soul.md"), "Shared voice.");
    await writeFile(join(directory, "playbooks", "manifest.json"), '{"version":1,"playbooks":[]}');
    await writeFile(join(directory, "agents", "Writer_Bot", "AGENTS.md"), "Preserve the requested audience.");
    await writeFile(join(directory, "agents", "Writer_Bot", "soul.md"), "Use the writer's specific voice.");
    await writeFile(join(directory, "agents", "Writer_Bot", "playbook.md"), "Keep the exact existing draft title.");

    const writer = loadAgentProfile({ botName: "Writer Bot", task: "Continue", root: directory,
      approvedPlaybook: "Reopen the saved record to verify persistence." });
    assert.match(writer.instructions, /Shared operating rules/);
    assert.match(writer.instructions, /requested audience/);
    assert.equal(writer.soul, "Use the writer's specific voice.");
    assert.match(writer.playbooks, /exact existing draft title/);
    assert.match(writer.playbooks, /verify persistence/);

    const other = loadAgentProfile({ botName: "Research Bot", task: "Continue", root: directory });
    assert.equal(other.instructions, "Shared operating rules.");
    assert.equal(other.soul, "Shared voice.");
    assert.equal(other.playbooks, "");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("oversized trusted instructions fail explicitly instead of dropping operating rules", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-profile-budget-"));
  const previous = process.env.BROWSER_AGENT_CORE_PROFILE_CHARS;
  try {
    process.env.BROWSER_AGENT_CORE_PROFILE_CHARS = "100";
    await writeFile(join(directory, "AGENTS.md"), "Important operating rule. ".repeat(10));
    await writeFile(join(directory, "soul.md"), "Voice.");
    assert.throws(() => loadAgentProfile({ botName: "Bot", task: "Continue", root: directory }),
      /exceed BROWSER_AGENT_CORE_PROFILE_CHARS/);
  } finally {
    if (previous === undefined) delete process.env.BROWSER_AGENT_CORE_PROFILE_CHARS;
    else process.env.BROWSER_AGENT_CORE_PROFILE_CHARS = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("inspired-by catalog names load the corresponding specialist instructions and playbooks", () => {
  for (const [name, legacyName, playbook] of [
    ["Inspired by Alex Hormozi", "The Value Architect", "value-architect"],
    ["Inspired by Sabri Suby", "The Revenue Architect", ""],
    ["Inspired by Addy Osmani", "The Engineering Craftsman", "engineering-craftsman"],
    ["Inspired by Andrej Karpathy", "The Neural Architect", "neural-architect"]
  ]) {
    const profile = loadAgentProfile({ botName: name, task: "Help with my work", root });
    const legacy = loadAgentProfile({ botName: legacyName, task: "Help with my work", root });
    assert.equal(profile.instructions, legacy.instructions);
    assert.equal(profile.soul, legacy.soul);
    if (playbook) assert.ok(profile.selected.includes(playbook), name + " must select its specialist playbook");
    else assert.match(profile.playbooks, /allowable cost per lead/);
  }
});

test("UX and paid media bots load dedicated roles and complete supplied references on demand", () => {
  for (const [name, id, term] of [
    ["UX Psychology & Conversion Expert", "ux", "psychologist"],
    ["Paid Media & Performance Marketing Specialist", "paid-media", "advertising"]
  ]) {
    const profile = loadAgentProfile({ botName: name, task: "Review my product funnel", root });
    assert.match(profile.instructions.toLowerCase(), new RegExp(term));
    assert.ok(profile.characters < 5600);
    const file = readFileSync(join(root, "playbooks", id + ".md"), "utf8");
    const offset = file.indexOf("# Complete supplied role specification");
    assert.ok(offset > 0);
    const { readPlaybookPage } = require("./agentProfile") as typeof import("./agentProfile");
    assert.match(readPlaybookPage(id, offset, root).text, /Complete supplied role specification/);
  }
});


test("stable specialist identity preserves soul and knowledge after a display rename", () => {
  const renamed = loadAgentProfile({ botName: "My AI Lab", profileId: "neural-architect", task: "Help with my work", botInstructions: "Inspect our support dataset before proposing changes.", root });
  const original = loadAgentProfile({ botName: "Inspired by Andrej Karpathy", task: "Help with my work", root });
  assert.equal(renamed.soul, original.soul);
  assert.match(renamed.soul, /tiny working baseline/);
  assert.match(renamed.instructions, /OWNER BOT PROFILE/);
  assert.match(renamed.instructions, /Inspect our support dataset/);
  assert.deepEqual(renamed.selected, original.selected);
  assert.notEqual(renamed.revision, original.revision);
  const other = loadAgentProfile({ botName: "Primary Bot", task: "Help", root });
  assert.doesNotMatch(other.instructions, /support dataset/);
  assert.throws(() => loadAgentProfile({ botName: "Test", profileId: "../../outside", task: "Help", root }), /Unknown specialist/);
  assert.throws(() => loadAgentProfile({ botName: "Test", botInstructions: "x".repeat(12001), task: "Help", root }), /Bot instructions exceed/);
});

test("all specialist souls apply distinct diagnostic habits within the core budget", () => {
  for (const [profileId, habit] of [["neural-architect", /held-out evaluations/], ["revenue-architect", /funnel bottleneck/], ["value-architect", /delay and effort/], ["engineering-craftsman", /Reproduce the problem/], ["systems-architect", /failure modes/]] as const) {
    const profile = loadAgentProfile({ botName: "Renamed", profileId, task: "Help", root });
    assert.match(profile.soul, habit);
    assert.ok(profile.instructions.length + profile.soul.length <= 2400);
  }
});


test("Chief Marketing Officer loads a compact identity and the relevant playbook", () => {
  const profile = loadAgentProfile({ botName: "Chief Marketing Officer", profileId: "chief-marketing-officer", task: "Prepare weekly content strategy", root });
  assert.match(profile.instructions, /owner publishes|Never publish/i);
  assert.ok(profile.selected.includes("cmo"));
  assert.match(profile.playbooks, /historical median|period-matched median/i);
  assert.ok(profile.instructions.length + profile.soul.length <= 2400);
});
