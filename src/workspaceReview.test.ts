import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getWorkspacePluginsSummary, getWorkspaceReview, parsePorcelainZ } from "./workspaceReview";

test("getWorkspaceReview inspects git status and blocks path traversal", async () => {
  const repoRoot = resolve(__dirname, "..");
  const review = await getWorkspaceReview(repoRoot);
  assert.equal(review.gitAvailable, true);
  assert.ok(review.branch.length > 0);
  assert.ok(Array.isArray(review.files));

  await assert.rejects(() => getWorkspaceReview(repoRoot, "../outside.txt"), /must stay inside the workspace/);
  await assert.rejects(() => getWorkspaceReview(repoRoot, "/etc/passwd"), /must be relative to the workspace/);
});

test("getWorkspaceReview returns gitAvailable false for non-git directories", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pilo-review-nongit-"));
  try {
    const review = await getWorkspaceReview(dir);
    assert.equal(review.gitAvailable, false);
    assert.deepEqual(review.files, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("getWorkspacePluginsSummary lists Agent Gateway protocols, tools, and providers without secrets", () => {
  const summary = getWorkspacePluginsSummary();
  assert.ok(summary.protocols.some((p) => p.id === "mcp"));
  assert.ok(summary.protocols.some((p) => p.id === "a2a"));
  assert.ok(summary.protocols.some((p) => p.id === "ollama"));
  assert.ok(summary.tools.some((t) => t.id === "code_project"));
  assert.ok(summary.providers.some((p) => p.id === "ollama"));
});

test("parsePorcelainZ handles renames, spaces, and untracked files cleanly", () => {
  const raw = "R  new name.ts\0old name.ts\0?? untracked file.md\0M  src/server.ts\0";
  const parsed = parsePorcelainZ(raw);
  assert.deepEqual(parsed, [
    { status: "R", path: "new name.ts", originalPath: "old name.ts" },
    { status: "??", path: "untracked file.md" },
    { status: "M", path: "src/server.ts" }
  ]);
});
