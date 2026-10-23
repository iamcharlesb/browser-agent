import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPatchProposer, extractReferencedFiles, parsePatchResponse } from "./patchProposer";
import { ImprovementNote, LearnTurn } from "./learnMode";

const note: ImprovementNote = {
  id: "clarity-1",
  dimension: "clarity",
  area: "src/promptLoop.ts (humanizeSummary)",
  severity: "major",
  evidence: "round 0 opened with filler",
  suggestedFix: "Extend humanizeSummary to strip that shape."
};

const turn: LearnTurn = {
  round: 0,
  userMessage: "help me market",
  botSummary: "Certainly! Here are several strategies:",
  success: true,
  stepsTaken: 1,
  elapsedSeconds: 4,
  terminationReason: "direct_reply",
  toolCalls: 0,
  failedToolCalls: 0,
  repeatedToolCalls: 0,
  approvalPrompts: 0,
  supervisorWarnings: 0,
  verificationPauses: 0,
  llmError: false
};

test("file references are pulled out of the note text", () => {
  assert.deepEqual(extractReferencedFiles([note]), ["src/promptLoop.ts"]);
  assert.deepEqual(
    extractReferencedFiles([{ ...note, area: "src/server.ts (collaborationContext) + static/index.html" }]),
    ["src/server.ts", "static/index.html"]
  );
  assert.deepEqual(extractReferencedFiles([{ ...note, area: "model configuration", suggestedFix: "check the key" }]), []);
});

test("patch JSON is parsed out of a chatty reply and capped", () => {
  const raw = 'Here you go:\n{"patches":[{"file":"src/a.ts","find":"x","replace":"y","rationale":"r"},{"file":"src/b.ts","find":"p","replace":"q"}]}\nHope that helps.';
  const patches = parsePatchResponse(raw, 5);
  assert.equal(patches.length, 2);
  assert.deepEqual(patches[0], { file: "src/a.ts", find: "x", replace: "y", rationale: "r" });
  assert.equal(patches[1].rationale, "no rationale given");
  assert.equal(parsePatchResponse(raw, 1).length, 1, "respects maxPatches");
});

test("malformed or empty replies yield no patches rather than a guess", () => {
  assert.deepEqual(parsePatchResponse("", 4), []);
  assert.deepEqual(parsePatchResponse("I could not find a safe fix.", 4), []);
  assert.deepEqual(parsePatchResponse('{"patches":"nope"}', 4), []);
  assert.deepEqual(parsePatchResponse('{"patches":[{"file":"src/a.ts","find":"","replace":"y"}]}', 4), []);
  assert.deepEqual(parsePatchResponse('{"patches":[{"file":"src/a.ts"}]}', 4), []);
});

test("the proposer shows the model the referenced file and drops patches for other files", async () => {
  const root = await mkdtemp(join(tmpdir(), "proposer-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "promptLoop.ts"), "function humanizeSummary() { return 'filler'; }\n", "utf8");

  let seenPrompt = "";
  const propose = createPatchProposer({
    repoRoot: root,
    complete: async ({ userPrompt }) => {
      seenPrompt = userPrompt;
      return JSON.stringify({
        patches: [
          { file: "src/promptLoop.ts", find: "'filler'", replace: "''", rationale: "strip filler" },
          { file: "src/secrets.ts", find: "a", replace: "b", rationale: "never shown to the model" }
        ]
      });
    }
  });
  assert.ok(propose, "an injected completer always yields a proposer");

  const patches = await propose!({ notes: [note], transcript: [turn], task: "help me market" });
  assert.equal(patches.length, 1, "a patch for a file the model was not shown is dropped");
  assert.equal(patches[0].file, "src/promptLoop.ts");
  assert.match(seenPrompt, /FILE src\/promptLoop\.ts/);
  assert.match(seenPrompt, /humanizeSummary/);
  assert.match(seenPrompt, /round 0/);
});

test("no notes means no model call at all", async () => {
  const root = await mkdtemp(join(tmpdir(), "proposer-empty-"));
  let calls = 0;
  const propose = createPatchProposer({
    repoRoot: root,
    complete: async () => {
      calls += 1;
      return "{}";
    }
  });
  assert.deepEqual(await propose!({ notes: [], transcript: [turn], task: "t" }), []);
  assert.equal(calls, 0);
});

test("a note with no readable file yields no patches", async () => {
  const root = await mkdtemp(join(tmpdir(), "proposer-missing-"));
  let calls = 0;
  const propose = createPatchProposer({
    repoRoot: root,
    complete: async () => {
      calls += 1;
      return "{}";
    }
  });
  assert.deepEqual(await propose!({ notes: [note], transcript: [turn], task: "t" }), []);
  assert.equal(calls, 0, "nothing to show the model, so nothing is asked");
});

test("the local heuristic engine cannot propose patches", () => {
  assert.equal(createPatchProposer({ repoRoot: tmpdir(), model: "local-engine", apiKey: "sk-test" }), undefined);
});
