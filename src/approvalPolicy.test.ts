import assert from "node:assert/strict";
import { test } from "node:test";
import { canAutoApprove, isReadOnlyCommand, TaskApprovalScope } from "./approvalPolicy";

test("repository inspection batches do not need repeated approval", () => {
  for (const command of [
    "pwd && ls -la",
    "git status --short --branch; git remote -v; git branch --show-current; git log -1 --oneline",
    "git -C node/browser_agent status --short --branch; cat .gitmodules",
    "git diff --stat | head -20",
    "git merge-base --is-ancestor origin/main main; git rev-list --left-right --count origin/main...main",
    "cat 'folder with spaces/package.json' 2>/dev/null",
    "git submodule status; git ls-tree HEAD node/browser_agent"
  ]) assert.equal(isReadOnlyCommand(command), true, command);
});

test("writes, execution, network and shell escape variants still require approval", () => {
  for (const command of [
    "git push origin main", "git fetch origin", "git branch new-branch", "git remote add x url",
    "git reset --hard", "git -c alias.status='!rm file' status", "git log --output=log.txt",
    "git diff --output=diff.txt", "git diff --ext-diff", "git show --textconv HEAD:file",
    "git status; rm file", "ls && node script.js", "cat $(touch file)", "cat `touch file`",
    "ls > output", "pwd & touch file", "cat file\nrm file", "git status | sh",
    "find . -exec rm {} +", "sed -i s/a/b/ file", "rg --pre=script text", "npm test",
    "cat foo\\;rm file", "cat $FILE", "ls *", "git status;", "", "c'at' file"
  ]) assert.equal(isReadOnlyCommand(command), false, command);
});

test("task grants are explicit, limited to shell/files, and reset for every run", () => {
  const scope = new TaskApprovalScope();
  assert.equal(scope.allows("run_terminal_command"), false);
  assert.equal(scope.resolve(true), true);
  assert.equal(scope.allows("workspace_file"), false);
  assert.equal(scope.resolve({ approved: false, scope: "task" }), false);
  assert.equal(scope.allows("run_terminal_command"), false);
  assert.equal(scope.resolve({ approved: true, scope: "task" }), true);
  assert.equal(scope.allows("run_terminal_command"), true);
  assert.equal(scope.allows("workspace_file"), true);
  assert.equal(scope.allows("generate_image"), false);
  assert.equal(new TaskApprovalScope().allows("run_terminal_command"), false);
});

test("a task-scoped approval for an irreversible browser action cannot grant later shell access", () => {
  const scope = new TaskApprovalScope();
  assert.equal(scope.resolve({ approved: true, scope: "task" }, "none"), true);
  assert.equal(scope.allows("run_terminal_command"), false);
});


test("persistent approval and Turbo cannot approve payments or irreversible actions", () => {
  for (const enabled of [true, false]) {
    assert.equal(canAutoApprove(enabled, "irreversible"), false);
    assert.equal(canAutoApprove(enabled, "financial"), false);
  }
  assert.equal(canAutoApprove(true, "outward"), true);
  assert.equal(canAutoApprove(true, "shell"), true);
  assert.equal(canAutoApprove(false, "shell"), false);
});
