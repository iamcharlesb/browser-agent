import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyApprovedVoice, ConversationObserver } from "./conversationObserver";

test("observer drafts explicit corrections and coalesces repeated evidence without a model", async () => {
  const directory = await mkdtemp(join(tmpdir(), "conversation-observer-"));
  try {
    const observer = new ConversationObserver(directory);
    assert.equal(await observer.observeTurn({ botName: "UX Bot", userText: "Build a chart for this data", outcomeRef: "outcome-a" }), null);
    const first = await observer.observeTurn({ botName: "UX Bot", userText: "Correction: keep the tone concise and friendly.", outcomeRef: "outcome-a" });
    assert.equal(first?.kind, "voice");
    const second = await observer.observeTurn({ botName: "UX Bot", userText: "Correction: keep the tone concise and friendly.", outcomeRef: "outcome-b" });
    assert.equal(second?.id, first?.id);
    assert.deepEqual(second?.evidence, ["outcome-a", "outcome-b"]);
    assert.equal((await observer.pending()).length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("observer records delivery misses for overnight supervisor review without a model", async () => {
  const directory = await mkdtemp(join(tmpdir(), "conversation-observer-miss-"));
  try {
    const observer = new ConversationObserver(directory);
    const miss = await observer.observeTurn({ botName: "Alex Hormozi", userText: "man just create one landing page for a landscape funnel", outcomeRef: "outcome-miss" });
    assert.equal(miss?.kind, "playbook");
    assert.match(miss?.instruction || "", /Delivery miss|landing/i);
    assert.equal(miss?.botId, "The_Value_Architect");
    assert.equal((await observer.pending()).length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("voice changes are written only after the operator approves a pending suggestion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "conversation-observer-voice-"));
  try {
    await mkdir(join(directory, "agents"), { recursive: true });
    await writeFile(join(directory, "AGENTS.md"), "Operating rules.");
    await writeFile(join(directory, "soul.md"), "Shared voice.");
    const observer = new ConversationObserver(join(directory, "observer"));
    const suggestion = await observer.observeTurn({ botName: "UX Bot", userText: "From now on, use a concise friendly tone.", outcomeRef: "outcome-1" });
    const voicePath = join(directory, "agents", "UX_Bot", "soul.md");
    assert.equal(existsSync(voicePath), false);
    await observer.decide(suggestion!.id, "approve");
    await applyApprovedVoice(directory, suggestion!);
    assert.match(await readFile(voicePath, "utf8"), /concise friendly tone/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
