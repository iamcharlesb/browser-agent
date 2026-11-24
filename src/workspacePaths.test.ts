import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { executeTool, runTerminalCommand, WORKSPACE_ROOT } from "./agentTools";
import { BrowserController } from "./browserController";
import { resolveWorkspacePath } from "./workspacePaths";

test("workspace tools reject symlink targets and parents without reading or changing outside files", async () => {
  const workspace = await mkdtemp(join(WORKSPACE_ROOT, ".path-test-"));
  const outside = await mkdtemp(join(tmpdir(), "pilo-outside-"));
  const controller = {} as BrowserController;
  try {
    await writeFile(join(outside, "fixture.txt"), "outside fixture");
    await symlink(outside, join(workspace, "linked"), "dir");
    await symlink(join(outside, "fixture.txt"), join(workspace, "file-link"));
    await symlink(join(outside, "missing.txt"), join(workspace, "dangling"));
    for (const path of [join(workspace, "linked", "fixture.txt"), join(workspace, "file-link"), join(workspace, "dangling"), join(workspace, "linked", "new", "file.txt")]) {
      for (const action of ["read", "write", "append"]) {
        const result = await executeTool("workspace_file", { action, path, content: "must not write" }, controller);
        assert.equal(result.ok, false, `${action}: ${path}`);
        assert.match(result.message, /symbolic links/);
      }
    }
    const listing = await executeTool("workspace_file", { action: "list", path: join(workspace, "linked") }, controller);
    assert.equal(listing.ok, false);
    await assert.rejects(runTerminalCommand("pwd", join(workspace, "linked")), /symbolic links/);
    assert.equal(await readFile(join(outside, "fixture.txt"), "utf8"), "outside fixture");
    await assert.rejects(readFile(join(outside, "missing.txt")), { code: "ENOENT" });
    await assert.rejects(readFile(join(outside, "new", "file.txt")), { code: "ENOENT" });
    const regular = join(workspace, "nested", "file.txt");
    assert.equal((await executeTool("workspace_file", { action: "write", path: regular, content: "hello" }, controller)).ok, true);
    assert.equal((await executeTool("workspace_file", { action: "append", path: regular, content: " world" }, controller)).ok, true);
    assert.equal(await readFile(regular, "utf8"), "hello world");
    assert.equal((await executeTool("workspace_file", { action: "read", path: regular }, controller)).ok, true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("workspace root aliases work while traversal and non-directory parents fail", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pilo-root-"));
  try {
    const root = join(directory, "workspace");
    await mkdir(root);
    await writeFile(join(root, "file.txt"), "fixture");
    await symlink(root, join(directory, "alias"), "dir");
    assert.equal(await readFile(await resolveWorkspacePath(join(directory, "alias"), "file.txt"), "utf8"), "fixture");
    await assert.rejects(resolveWorkspacePath(root, "../outside", true), /outside/);
    await assert.rejects(resolveWorkspacePath(root, "file.txt/child", true), /not a directory/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
