import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { loadAgentProfile, readPlaybookPage } from "./agentProfile";
import { renderDocumentation } from "./documentation";

const root = join(__dirname, "..");

test("Demo Director retains its skill and bounded operating context after renaming", () => {
  const named = loadAgentProfile({ botName: "Demo Director", task: "Help with my work", root });
  const renamed = loadAgentProfile({ botName: "My Video Partner", profileId: "demo-director", task: "Help with my work", root });
  assert.equal(renamed.revision, named.revision);
  assert.deepEqual(renamed.selected, ["demo-director"]);
  assert.match(renamed.instructions, /use record_screen/);
  assert.match(renamed.soul, /calm, precise product demo director/);
  assert.match(renamed.playbooks, /Timed storyboard table/);
  assert.match(renamed.playbooks, /needs rehearsal/);
  assert.ok(renamed.instructions.length <= 2400);
  assert.ok(renamed.soul.length <= 900);
  assert.ok(renamed.playbooks.length <= 3200);
});

test("demo requests load the skill on demand and its complete tool handoff remains retrievable", () => {
  const generic = loadAgentProfile({ botName: "Primary Bot", task: "Explain the arithmetic", root });
  assert.ok(!generic.selected.includes("demo-director"));
  const demo = loadAgentProfile({ botName: "Primary Bot", task: "Create a product demo storyboard and recording plan", root });
  assert.ok(demo.selected.includes("demo-director"));
  let text = "";
  let offset: number | null = 0;
  while (offset !== null) {
    const page = readPlaybookPage("demo-director", offset, root);
    assert.ok(page.text.length <= 900);
    text += page.text;
    offset = page.nextOffset;
  }
  assert.equal(text, readFileSync(join(root, "playbooks/demo-director.md"), "utf8").trim());
  assert.match(text, /create_document with format md/);
  assert.match(text, /Never substitute an HTML animation/);
  assert.match(text, /record_screen\(action="status"\)/);
});

test("the shipped catalog routes Demo Director and renamed saved profiles to demo starter prompts", () => {
  const html = readFileSync(join(root, "static/index.html"), "utf8");
  const presetsSource = html.match(/var LATEST_BOT_PRESETS = (\[[\s\S]*?\n  \]);/);
  assert.ok(presetsSource);
  const presets = runInNewContext(presetsSource[1]);
  const preset = presets.find((item: { profileId: string }) => item.profileId === "demo-director");
  assert.equal(preset.name, "Demo Director");
  const start = html.indexOf("  function inferredIntent(");
  const end = html.indexOf("    var roleText =", start);
  assert.ok(start > 0 && end > start);
  const infer = runInNewContext(`${html.slice(start, end)}return null; }\ninferredIntent;`, {
    LATEST_BOT_PRESETS: presets,
    SPECIALIST_NAME_ALIASES: {}
  });
  for (const name of ["Demo Director", "My Video Partner"]) {
    const intent = infer(name, "", "demo-director");
    assert.equal(intent.kind, "demo-director");
    assert.equal(intent.needsBrowserOnInit, false);
    assert.equal(intent.suggestions.length, 3);
    assert.match(intent.suggestions.join(" "), /storyboard|voiceover/);
    assert.match(intent.task, /built-in recorder/);
  }
});

test("Demo Director guide is available in the in-app documentation", async () => {
  const html = await renderDocumentation(root, "demos");
  assert.match(html, /Demo Director skill · Pilo Docs/);
  assert.match(html, /WebM video/);
});
