import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadAgentProfile, readPlaybookPage } from "./agentProfile";

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
  assert.match(profile.soul, /not a polite chatbot/);
  assert.match(profile.playbooks, /allowable cost per lead/);
  assert.match(profile.playbooks, /approval before publishing/);
  assert.ok(profile.instructions.length <= 2400);
  assert.ok(profile.soul.length <= 900);
  assert.ok(profile.characters < 8000);
});
test("The Value Architect loads its compact role and on-demand offer/economics playbook", () => {
  const profile = loadAgentProfile({ botName: "The Value Architect", task: "Review offer pricing and unit economics", root });
  assert.match(profile.instructions, /Alex Hormozi|landing\/funnel page|create_document/i);
  assert.match(profile.soul, /commercially ruthless|Alex Hormozi|build the page/i);
  assert.match(profile.soul, /binding growth constraint/);
  assert.ok(profile.selected.includes("value-architect"));
  assert.match(profile.playbooks, /Landing \/ funnel page doctrine|value equation/i);
  const { readPlaybookPage } = require("./agentProfile") as typeof import("./agentProfile");
  const page = readPlaybookPage("value-architect", 0, root);
  assert.match(page.text, /Landing \/ funnel page doctrine|North star and diagnosis/);
  assert.equal(page.text.length, 900);
});
test("The Systems Architect loads its compact role and on-demand engineering playbook", () => {
  const profile = loadAgentProfile({ botName: "The Systems Architect", task: "Review distributed systems architecture", root });
  assert.match(profile.instructions, /never impersonate them/i);
  assert.match(profile.instructions, /simplest operable system/);
  assert.match(profile.soul, /principal engineer|Challenge fashion/);
  assert.ok(profile.selected.includes("systems-architect"));
  assert.match(profile.playbooks, /system design method/i);
  const { readPlaybookPage } = require("./agentProfile") as typeof import("./agentProfile");
  assert.match(readPlaybookPage("systems-architect", 0, root).text, /simplest architecture/i);
});
test("The Engineering Craftsman loads its compact role and on-demand quality/performance playbook", () => {
  const profile = loadAgentProfile({ botName: "The Engineering Craftsman", task: "Review web performance and AI-generated code", root });
  assert.match(profile.instructions, /Addy Osmani|published engineering/i);
  assert.match(profile.soul, /evidence over vibes|Addy Osmani/);
  assert.match(profile.soul, /hard review|Reproduce the problem/);
  assert.ok(profile.selected.includes("engineering-craftsman"));
  assert.match(profile.playbooks, /Core Web Vitals/i);
  const { readPlaybookPage } = require("./agentProfile") as typeof import("./agentProfile");
  assert.match(readPlaybookPage("engineering-craftsman", 0, root).text, /Engineering Craftsman/);
});
test("The Neural Architect loads its compact identity and on-demand AI research playbook", () => {
  const profile = loadAgentProfile({ botName: "The Neural Architect", task: "Evaluate transformer inference and agent orchestration", root });
  assert.match(profile.instructions, /Andrej Karpathy|published teaching/i);
  assert.match(profile.soul, /experimentally humble/);
  assert.match(profile.soul, /teacher-engineer|Andrej Karpathy/);
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
      /BROWSER_AGENT_CORE_PROFILE_CHARS/);
  } finally {
    if (previous === undefined) delete process.env.BROWSER_AGENT_CORE_PROFILE_CHARS;
    else process.env.BROWSER_AGENT_CORE_PROFILE_CHARS = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("soul personality has a separate budget from operating instructions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-profile-soul-budget-"));
  const previousCore = process.env.BROWSER_AGENT_CORE_PROFILE_CHARS;
  const previousSoul = process.env.BROWSER_AGENT_SOUL_CHARS;
  try {
    process.env.BROWSER_AGENT_CORE_PROFILE_CHARS = "500";
    process.env.BROWSER_AGENT_SOUL_CHARS = "220";
    await mkdir(join(directory, "playbooks"));
    await writeFile(join(directory, "playbooks", "manifest.json"), '{"version":1,"playbooks":[]}');
    await writeFile(join(directory, "AGENTS.md"), "Keep replies short and honest.");
    await writeFile(join(directory, "soul.md"), "Direct voice with a strong personality that intentionally exceeds the tiny soul budget for this test by repeating the same blunt stance. ".repeat(3));
    assert.throws(() => loadAgentProfile({ botName: "Bot", task: "Continue", root: directory }),
      /BROWSER_AGENT_SOUL_CHARS/);
    await writeFile(join(directory, "soul.md"), "Methods only: diagnose funnel, write copy, measure CAC.");
    assert.throws(() => loadAgentProfile({ botName: "Bot", task: "Continue", root: directory }),
      /explicit speaking personality/);
    await writeFile(join(directory, "soul.md"), "Blunt direct voice. Challenge weak offers.");
    const profile = loadAgentProfile({ botName: "Bot", task: "Continue", root: directory });
    assert.match(profile.soul, /Blunt direct voice/);
    assert.ok(profile.instructions.length <= 500);
    assert.ok(profile.soul.length <= 220);
  } finally {
    if (previousCore === undefined) delete process.env.BROWSER_AGENT_CORE_PROFILE_CHARS;
    else process.env.BROWSER_AGENT_CORE_PROFILE_CHARS = previousCore;
    if (previousSoul === undefined) delete process.env.BROWSER_AGENT_SOUL_CHARS;
    else process.env.BROWSER_AGENT_SOUL_CHARS = previousSoul;
    await rm(directory, { recursive: true, force: true });
  }
});

test("inspired-by catalog names load the corresponding specialist instructions and playbooks", () => {
  for (const [name, legacyName, playbook] of [
    ["Inspired by Alex Hormozi", "The Value Architect", "value-architect"],
    ["Alex Hormozi", "The Value Architect", "value-architect"],
    ["Inspired by Sabri Suby", "The Revenue Architect", ""],
    ["Inspired by Addy Osmani", "The Engineering Craftsman", "engineering-craftsman"],
    ["Addy Osmani", "The Engineering Craftsman", "engineering-craftsman"],
    ["Inspired by Andrej Karpathy", "The Neural Architect", "neural-architect"],
    ["Andrej Karpathy", "The Neural Architect", "neural-architect"]
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
    ["Ads Specialist (Google, Meta & more)", "paid-media", "advertising"]
  ]) {
    const profile = loadAgentProfile({ botName: name, task: "Review my product funnel", root });
    assert.match(profile.instructions.toLowerCase(), new RegExp(term));
    assert.ok(profile.instructions.length <= 2400);
    assert.ok(profile.soul.length <= 900);
    assert.ok(profile.characters < 8000);
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

test("all specialist souls apply distinct diagnostic habits within separate instruction and soul budgets", () => {
  for (const [profileId, habit] of [["neural-architect", /held-out evaluations/], ["revenue-architect", /funnel bottleneck/], ["value-architect", /delay and effort/], ["engineering-craftsman", /Reproduce the problem/], ["systems-architect", /failure modes/]] as const) {
    const profile = loadAgentProfile({ botName: "Renamed", profileId, task: "Help", root });
    assert.match(profile.soul, habit);
    assert.match(profile.soul, /Voice|# Voice|voice|tone|Speak|speak|Blunt|Curious|Pragmatic|Candid|Hungry|Clear/i);
    assert.ok(profile.instructions.length <= 2400);
    assert.ok(profile.soul.length <= 900);
  }
});

test("catalog and template bots each load a personality-bearing soul", () => {
  for (const name of [
    "Primary Bot",
    "Inspired by Sabri Suby",
    "Alex Hormozi",
    "Addy Osmani",
    "Andrej Karpathy",
    "Principal Fullstack Engineer, Cloud & DevOps",
    "Chief Marketing Officer",
    "Product Marketing",
    "Founder Operator",
    "Mark Zuckerberg",
    "Alexandr Wang",
    "Sundar Pichai",
    "UX Psychology & Conversion Expert",
    "Ads Specialist (Google, Meta & more)",
    "YouTube Concept & Code Learner",
    "Local Terminal & DevOps Bot",
    "Instagram Follower Growth",
    "Reddit Community Growth",
    "SEO Specialist",
    "Blog Writer",
    "X / Grok Trend Researcher",
    "Competitor Intelligence",
    "GIF Animator",
    "Funnel Specialist",
    "LinkedIn Growth",
    "Resume Bot",
    "Influencer",
    "Technical Program Manager",
    "Product Manager",
    "Supervisor Bot",
    "Supercomputer",
    "Bot Creator",
    "Critica"
  ]) {
    const profile = loadAgentProfile({ botName: name, task: "Help with my work", root });
    assert.match(profile.soul, /Voice|# Voice|voice|tone|Speak|speak|Blunt|Curious|Pragmatic|Candid|Hungry|Clear|Warm|Fast|Practical|Proactive|Street-smart|Research-first|Executive|teacher|ops engineer|growth|analyst|Founder-CMO|chief of staff|motion designer|conversion operator|ban-aware|career editor|Hormozi|Osmani|Karpathy|Zuckerberg|Wang|Pichai|Influencer|program lead|product manager|UX psychologist|blogger/i);
    assert.ok(profile.soul.length <= 900, name);
    assert.ok(profile.instructions.length <= 2400, name);
  }
});

test("new personality and role bots load dedicated playbooks", () => {
  for (const [name, profileId, playbook, habit] of [
    ["Mark Zuckerberg", "mark-zuckerberg", "mark-zuckerberg", /Zuckerberg|ship/i],
    ["Alexandr Wang", "alex-wang", "alex-wang", /Wang|bottleneck/i],
    ["Alexander Wang", undefined, "alex-wang", /Wang|bottleneck/i],
    ["Sundar Pichai", "sundar-pichai", "sundar-pichai", /Pichai|user-first/i],
    ["Influencer", undefined, "influencer", /craft-obsessed|hooks/i],
    ["Technical Program Manager", undefined, "tpm", /program lead|owners, dates/i],
    ["Product Manager", undefined, "product-manager", /best product manager|feature factories/i],
    ["UX Psychology & Conversion Expert", undefined, "ux", /UX psychologist|dark pattern/i],
    ["Supervisor Bot", "supervisor", "supervisor", /night-shift supervisor|pending improvement/i],
    ["Supercomputer", "supercomputer", "supercomputer", /Zuckerberg|Alexandr Wang|Jarvis/i],
    ["Bot Creator", "bot-creator", "bot-creator", /bot architect|Jarvis|purpose/i],
    ["Critica", "critica", "critica", /Critica|devastating insight|rewrite/i],
    ["Blog Writer", "blog-writer", "blog-writer", /Amazon|human|Further reading|blogger/i]
  ] as const) {
    const profile = loadAgentProfile({ botName: name, profileId: profileId as any, task: "Help with my work", root });
    assert.ok(profile.selected.includes(playbook), name);
    assert.match(profile.soul, habit);
    assert.ok(profile.soul.length <= 900, name);
    assert.ok(profile.instructions.length <= 2400, name);
  }
});


test("Chief Marketing Officer loads a compact identity and the relevant playbook", () => {
  const profile = loadAgentProfile({ botName: "Chief Marketing Officer", profileId: "chief-marketing-officer", task: "Prepare weekly content strategy", root });
  assert.match(profile.instructions, /owner publishes|never post/i);
  assert.ok(profile.selected.includes("cmo"));
  assert.match(profile.playbooks, /historical median|period-matched median|channel mix/i);
  assert.match(profile.soul, /Founder-CMO|marketing lead/);
  assert.ok(profile.instructions.length <= 2400);
  assert.ok(profile.soul.length <= 900);
});

test("Product Marketing retains its role, voice and playbook after renaming", () => {
  const profile = loadAgentProfile({ botName: "My Launch Partner", profileId: "product-marketing", task: "Help with my work", root });
  assert.match(profile.instructions, /customer research, positioning, messaging/);
  assert.match(profile.instructions, /explicit approval before publishing/);
  assert.match(profile.soul, /customer-minded product marketer/);
  assert.ok(profile.selected.includes("product-marketing"));
  assert.match(profile.playbooks, /Keep planned capabilities distinct from shipped features/);
  const named = loadAgentProfile({ botName: "Product Marketing", task: "Help with my work", root });
  assert.equal(profile.revision, named.revision);
  assert.ok(profile.instructions.length <= 2400);
  assert.ok(profile.soul.length <= 900);
});

test("team collaboration playbook loads for multi-bot funnel planning asks", () => {
  const profile = loadAgentProfile({
    botName: "Magicsite.AI - Product Marketing Bot",
    task: "now give me a complete plan of which bots going to work and how the funnels are going to work",
    root
  });
  assert.ok(profile.selected.includes("team-collaboration"));
  assert.match(profile.playbooks, /TEAM expertise|Funnel stages|Owners/i);
});

test("Founder Operator and new specialist bots load roles and playbooks", () => {
  const operator = loadAgentProfile({ botName: "Founder Operator", profileId: "founder-operator", task: "Run weekly ops triage", root });
  assert.match(operator.instructions, /chief-of-staff|Never spend|decision/i);
  assert.ok(operator.selected.includes("founder-operator"));
  assert.match(operator.soul, /chief of staff|owners, deadlines/i);
  assert.ok(operator.instructions.length <= 2400);
  assert.ok(operator.soul.length <= 900);

  for (const [name, playbook, habit] of [
    ["GIF Animator", "gif-animator", /motion designer|frames|loop/i],
    ["Funnel Specialist", "funnel", /conversion operator|drop-off/i],
    ["Website Designer", "website-designer", /senior web designer|conversion number/i],
    ["LinkedIn Growth", "linkedin", /personalization-obsessed|ban-aware/i],
    ["Resume Bot", "resume", /career editor|quantified/i]
  ] as const) {
    const profile = loadAgentProfile({ botName: name, task: "Help with my work", root });
    assert.ok(profile.selected.includes(playbook), name + " must select " + playbook);
    assert.match(profile.soul, habit);
    assert.ok(profile.soul.length <= 900, name);
    assert.ok(profile.instructions.length <= 2400, name);
  }
});


test("Website Designer retains its dedicated profile after renaming and through its alias", () => {
  const renamed = loadAgentProfile({ profileId: "website-designer", botName: "My Design Partner", task: "Help", root });
  const alias = loadAgentProfile({ botName: "Web Designer", task: "Help", root });
  for (const profile of [renamed, alias]) {
    assert.match(profile.instructions, /finished, responsive, accessible HTML/);
    assert.match(profile.soul, /senior web designer/);
    assert.ok(profile.selected.includes("website-designer"));
    assert.match(profile.playbooks, /Label prototype forms/);
    assert.ok(profile.instructions.length <= 2400);
    assert.ok(profile.soul.length <= 900);
  }
});

test("EB1A specialist keeps evidence safeguards and procedure after rename", () => {
  const profile = loadAgentProfile({ profileId: "eb1a-research", botName: "My RFE Partner", task: "Research my case", root });
  assert.match(profile.instructions, /Never invent impact/);
  assert.match(profile.playbooks, /documented bridge/);
  assert.match(profile.playbooks, /separate self-contained deliverables/);
  assert.match(profile.playbooks, /base, bonus and equity/);
  assert.ok(profile.instructions.length <= 2400);
  assert.ok(profile.soul.length <= 900);
  assert.ok(profile.playbooks.length <= 3200);
});

test("analyst profiles retain independent identity, role playbooks and voice after renaming", () => {
  for (const [name, profileId, habit] of [
    ["Wall Street Analyst", "wall-street-analyst", /equity-research|thesis/i],
    ["Goldman Sachs Analyst", "goldman-sachs-analyst", /banking|comparables/i],
    ["Jim Cramer", "jim-cramer", /Cramer|homework|bull-versus-bear/i]
  ] as const) {
    for (const botName of [name, "My Finance Partner"]) {
      const profile = loadAgentProfile({ botName, profileId, task: "Help with my work", root });
      assert.match(profile.instructions, /independent AI/i);
      assert.match(profile.instructions, /not affiliated|no institutional affiliation/i);
      assert.match(profile.instructions, /not.*personalized financial advice|no.*personalized financial advice/i);
      assert.match(profile.soul, habit);
      assert.ok(profile.selected.includes(profileId));
      assert.ok(profile.instructions.length <= 2400);
      assert.ok(profile.soul.length <= 900);
    }
    const page = readPlaybookPage(profileId, 0, root);
    assert.match(page.text, /public|sources/i);
  }
});
