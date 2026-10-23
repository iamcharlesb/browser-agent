import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  MAX_DISTILL_CHARS,
  appendLearning,
  applyApprovalDenial,
  applyLearningKbTool,
  applyRunOutcome,
  botIdFromName,
  defaultLearningKb,
  distillLearningKb,
  learningFilePath,
  loadLearningKb,
  sanitizeLearningText,
  saveLearningKb,
  setNiche,
  updateLearningKb,
  validateLearningKb
} from "./learningStore";

test("botIdFromName slugs display names and rejects path escapes", () => {
  assert.equal(botIdFromName("Instagram Growth Agent"), "Instagram_Growth_Agent");
  assert.equal(botIdFromName("../etc/passwd"), "etc_passwd");
  assert.equal(botIdFromName("!!!"), "default");
  assert.throws(() => learningFilePath("/tmp/kb", "../x"), /path escape|must match/);
  assert.throws(() => learningFilePath("/tmp/kb", "a/b"), /must match/);
  const safe = learningFilePath("/tmp/kb", "My_Bot");
  assert.equal(safe, join("/tmp/kb", "My_Bot.json"));
});

test("sanitizeLearningText redacts secrets and caps length", () => {
  const redacted = sanitizeLearningText("password=hunter2 and sk-abcdefghijklmnopqrstuvwxyz123456");
  assert.match(redacted, /\[REDACTED/);
  assert.ok(!redacted.includes("hunter2"));
  const long = sanitizeLearningText("x".repeat(500), 40);
  assert.ok(long.length <= 40);
});

test("validateLearningKb defaults and rejects bad version", () => {
  const d = defaultLearningKb("seo_bot");
  assert.equal(d.version, 1);
  assert.equal(d.botId, "seo_bot");
  assert.deepEqual(d.learnings, []);
  assert.throws(() => validateLearningKb({ version: 2, botId: "x" }), /version must be 1/);
});

test("appendLearning dedupes, caps, and distill stays lean", () => {
  let state = defaultLearningKb("bot");
  state = appendLearning(state, { kind: "learning", text: "Ask before posting", source: "tool" });
  state = appendLearning(state, { kind: "learning", text: "Ask before posting", source: "tool" });
  assert.equal(state.learnings.length, 1);
  state = setNiche(state, "indie SaaS SEO");
  state = appendLearning(state, { kind: "mistake", text: "Don't cold-DM without approval", source: "user_correction" });
  state = appendLearning(state, { kind: "intent", text: "Grow organic traffic via long-tail", source: "auto" });
  const distilled = distillLearningKb(state);
  assert.match(distilled, /LEARNINGS \/ KB/);
  assert.match(distilled, /indie SaaS SEO/);
  assert.match(distilled, /Ask before posting/);
  assert.ok(distilled.length <= MAX_DISTILL_CHARS);
});

test("applyRunOutcome records corrections, goals, and outcomes", () => {
  let state = defaultLearningKb("bot");
  state = applyRunOutcome(state, {
    task: "Don't spam identical Reddit comments — value-first only",
    success: false,
    summary: "User pushed back on spam approach",
    terminationReason: "fail_task"
  });
  assert.ok(state.mistakes.length >= 1);
  assert.ok(state.mistakes.some((m) => /correction|Failed/i.test(m.text)));

  state = applyRunOutcome(state, {
    task: "Help me grow Instagram followers for my pottery brand",
    success: true,
    summary: "Proposed 6 handles + draft comments for approval"
  });
  assert.ok(state.intents.some((i) => /Instagram/i.test(i.text)));
  assert.ok(state.learnings.some((l) => /Worked:/i.test(l.text)));
});

test("applyApprovalDenial and learning_kb tool save/read", () => {
  let state = defaultLearningKb("bot");
  state = applyApprovalDenial(state, "Run shell: rm -rf /tmp/foo");
  assert.ok(state.mistakes.some((m) => /denied approval/i.test(m.text)));

  const saved = applyLearningKbTool(state, {
    action: "save",
    kind: "hypothesis",
    text: "Next time check GA4 landing pages before keyword brainstorm"
  });
  assert.match(saved.message, /Saved hypothesis/);
  const read = applyLearningKbTool(saved.state, { action: "read" });
  assert.match(read.message, /Check next/);
  assert.match(read.message, /GA4/);
});

test("load/save atomic JSON round-trip", async () => {
  const dir = await mkdtemp(join(tmpdir(), "learning-kb-"));
  try {
    const empty = await loadLearningKb(dir, "round_trip");
    assert.equal(empty.botId, "round_trip");
    assert.equal(empty.learnings.length, 0);

    let state = appendLearning(empty, {
      kind: "intent",
      text: "Rank for local bakery SEO",
      source: "tool"
    });
    state = setNiche(state, "local bakery");
    await saveLearningKb(dir, state);

    const raw = await readFile(join(dir, "round_trip.json"), "utf8");
    assert.match(raw, /"version": 1/);
    const loaded = await loadLearningKb(dir, "round_trip");
    assert.equal(loaded.niche, "local bakery");
    assert.equal(loaded.intents.length, 1);
    assert.equal(loaded.intents[0].text, "Rank for local bakery SEO");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("concurrent updates all survive instead of overwriting each other", async () => {
  const dir = await mkdtemp(join(tmpdir(), "learn-kb-race-"));
  try {
    await saveLearningKb(dir, defaultLearningKb("racer"));

    // Fired without awaiting each other, the way the server fires an approval denial and a run
    // outcome. A plain load/save pair here loses every write but the last.
    await Promise.all(
      ["first", "second", "third", "fourth"].map((label) =>
        updateLearningKb(dir, "racer", (kb) =>
          appendLearning(kb, { kind: "learning", text: `lesson ${label}`, source: "auto" })
        )
      )
    );

    const kb = await loadLearningKb(dir, "racer");
    assert.equal(kb.learnings.length, 4, `expected all four writes, got ${kb.learnings.length}`);
    for (const label of ["first", "second", "third", "fourth"]) {
      assert.ok(
        kb.learnings.some((entry) => entry.text.includes(label)),
        `"${label}" was overwritten`
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failed update does not poison the queue for the next one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "learn-kb-recover-"));
  try {
    await saveLearningKb(dir, defaultLearningKb("recover"));

    const failing = updateLearningKb(dir, "recover", () => {
      throw new Error("mutator blew up");
    });
    const following = updateLearningKb(dir, "recover", (kb) =>
      appendLearning(kb, { kind: "learning", text: "still written", source: "auto" })
    );

    await assert.rejects(() => failing, /mutator blew up/);
    await following;

    const kb = await loadLearningKb(dir, "recover");
    assert.equal(kb.learnings.length, 1);
    assert.match(kb.learnings[0].text, /still written/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
