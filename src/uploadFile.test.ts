import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, writeFile, rm, symlink, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ARTIFACTS_DIR, executeTool } from "./agentTools";
import { artifactUrlFor } from "./apiContract";
import { BrowserController } from "./browserController";
import { classifyBrowserAction, effectRequiresApproval } from "./actionEffect";

test("upload reuses an existing artifact, including its artifact URL, without regenerating it", async () => {
  const filename = `upload-test-${randomUUID()}.png`;
  await mkdir(ARTIFACTS_DIR, { recursive: true });
  await writeFile(join(ARTIFACTS_DIR, filename), "image fixture");
  const calls: unknown[][] = [];
  const browser = { uploadFile: async (...args: unknown[]) => { calls.push(args); } } as unknown as BrowserController;
  try {
    const result = await executeTool("upload_file", { filename: artifactUrlFor(filename), selector: '#hero', effect: "reversible" }, browser);
    assert.equal(result.ok, true, result.message);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], join(ARTIFACTS_DIR, filename));
    assert.equal(calls[0][1], "#hero");
    assert.match(result.message, /reopen it to verify/);
  } finally { await rm(join(ARTIFACTS_DIR, filename)); }
});

test("uploads reject traversal, arbitrary local files, missing files and symlink escapes", async () => {
  const filename = `upload-test-${randomUUID()}.png`;
  const temp = await mkdtemp(join(tmpdir(), "upload-test-"));
  const outside = join(temp, 'private.png');
  await writeFile(outside, "private fixture");
  await mkdir(ARTIFACTS_DIR, { recursive: true });
  await symlink(outside, join(ARTIFACTS_DIR, filename));
  const browser = { uploadFile: async () => { assert.fail("Disallowed upload reached the browser"); } } as unknown as BrowserController;
  try {
    for (const path of ["../private.png", "/etc/passwd", "/artifacts/%2e%2e%2fprivate.png", `missing-${randomUUID()}.png`, filename]) {
      const result = await executeTool("upload_file", { filename: path, effect: "reversible" }, browser);
      assert.equal(result.ok, false, path);
    }
  } finally {
    await rm(join(ARTIFACTS_DIR, filename));
    await rm(temp, { recursive: true });
  }
});

test("upload effects honor draft scope and keep outward/irreversible gates", () => {
  assert.equal(classifyBrowserAction({ toolName: 'upload_file' }).effect, 'outward');
  assert.equal(classifyBrowserAction({ toolName: 'upload_file', declaredEffect: 'reversible' }).effect, 'reversible');
  assert.equal(effectRequiresApproval('outward', true), false);
  assert.equal(effectRequiresApproval('irreversible', true), true);
});
