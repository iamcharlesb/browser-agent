import assert from "node:assert/strict";
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
