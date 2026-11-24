import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conversationEpoch, readConversationResets, resetConversationFiles } from "./conversationReset";
import { documentationMarkdown, renderDocumentation, DOCUMENTATION_TOPICS } from "./documentation";
import { preserveBotDeletions } from "./userStore";

test("reset removes only selected conversation context and keeps profiles, reviewed playbooks and artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "conversation-reset-"));
  try {
    for (const folder of [".browser-agent-task-memory", ".browser-agent-knowledge", ".browser-agent-learnings", ".browser-agent-playbooks", "artifacts"]) {
      await mkdir(join(root, folder));
      for (const name of ["Writer", "Researcher", "_workspace"]) await writeFile(join(root, folder, name + ".json"), "retained or reset");
    }
    const one = await resetConversationFiles(root, "bot", "Writer");
    assert.ok(conversationEpoch(one, "Writer") > 0);
    assert.equal(conversationEpoch(one, "Researcher"), 0);
    await assert.rejects(readFile(join(root, ".browser-agent-task-memory", "Writer.json")), /ENOENT/);
    assert.equal(await readFile(join(root, ".browser-agent-task-memory", "Researcher.json"), "utf8"), "retained or reset");
    assert.equal(await readFile(join(root, ".browser-agent-learnings", "_workspace.json"), "utf8"), "retained or reset");
    const all = await resetConversationFiles(root, "all");
    assert.ok(conversationEpoch(all, "Researcher") > conversationEpoch(one, "Writer"));
    await assert.rejects(readFile(join(root, ".browser-agent-learnings", "_workspace.json")), /ENOENT/);
    assert.equal(await readFile(join(root, ".browser-agent-playbooks", "Writer.json"), "utf8"), "retained or reset");
    assert.equal(await readFile(join(root, "artifacts", "Writer.json"), "utf8"), "retained or reset");
    assert.deepEqual(await readConversationResets(root), all);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("older signed-in roster writes cannot restore reset transcripts or discard newer messages", () => {
  const current = [{ id: "writer", name: "Writer", conversationResetAt: 10, transcript: [{ role: "user", html: "A new request" }] }];
  const merged = preserveBotDeletions(current, [{ id: "writer", name: "Writer", transcript: [{ role: "user", html: "An old private goal" }] }]);
  assert.equal(merged[0].conversationResetAt, 10);
  assert.deepEqual(merged[0].transcript, current[0].transcript);
});

test("bundled documentation resolves only known topics and escapes raw source HTML", async () => {
  for (const topic of DOCUMENTATION_TOPICS) {
    const html = await renderDocumentation(join(__dirname, ".."), topic.id);
    assert.match(html, /Pilo Docs/); assert.match(html, /aria-current="page"/);
  }
  assert.match(await renderDocumentation(join(__dirname, ".."), "../../.env"), /Pilo documentation/);
  const html = documentationMarkdown('# Guide\n\n<script>alert("private")</script>\n\n[unsafe](javascript:alert)\n\n```sh\n<private>\n```');
  assert.doesNotMatch(html, /<script>|href="javascript:/);
  assert.match(html, /&lt;private&gt;/);
});
