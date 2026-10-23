import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MAX_PATCHES_PER_SESSION, applyPatches, resolvePatchTarget } from "./selfFix";

async function makeRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "selffix-"));
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "static"), { recursive: true });
  await writeFile(join(root, "src", "a.ts"), "export const greeting = 'hello';\nexport const other = 1;\n", "utf8");
  await writeFile(join(root, "src", "dupe.ts"), "const x = 1;\nconst y = 1;\n", "utf8");
  await writeFile(join(root, ".env"), "SECRET=1\n", "utf8");
  return root;
}

const ok = async () => ({ ok: true, checks: [{ name: "stub", ok: true, output: "", durationMs: 0 }] });
const red = async () => ({ ok: false, checks: [{ name: "stub", ok: false, output: "TS1005", durationMs: 0 }] });

test("rejects paths outside the allowed directories", async () => {
  const root = await makeRepo();
  for (const [file, pattern] of [
    ["../outside.ts", /escapes the repo|repo-relative/],
    ["/etc/passwd", /repo-relative/],
    [".env", /must live under/],
    ["package.json", /must live under/],
    ["src/missing.ts", /does not exist/],
    ["src/a.json", /only .* are patchable|must live under/]
  ] as Array<[string, RegExp]>) {
    const result = resolvePatchTarget(root, file);
    assert.equal(result.ok, false, `${file} should be rejected`);
    if (!result.ok) assert.match(result.reason, pattern);
  }
  assert.equal(resolvePatchTarget(root, "src/a.ts").ok, true);
});

test("rejects symlinks so a link inside src cannot redirect a write", async () => {
  const root = await makeRepo();
  await symlink(join(root, ".env"), join(root, "src", "link.ts"));
  const result = resolvePatchTarget(root, "src/link.ts");
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /symlink/);
});

test("applies a verified patch", async () => {
  const root = await makeRepo();
  const outcome = await applyPatches(
    [{ file: "src/a.ts", find: "'hello'", replace: "'hi there'", rationale: "shorter" }],
    { repoRoot: root, verify: ok }
  );
  assert.equal(outcome.applied, true);
  assert.equal(outcome.rolledBack, false);
  assert.match(await readFile(join(root, "src", "a.ts"), "utf8"), /'hi there'/);
});

test("rolls the tree back byte-for-byte when verification fails", async () => {
  const root = await makeRepo();
  const before = await readFile(join(root, "src", "a.ts"), "utf8");
  const outcome = await applyPatches(
    [{ file: "src/a.ts", find: "'hello'", replace: "'broken", rationale: "introduces a syntax error" }],
    { repoRoot: root, verify: red }
  );
  assert.equal(outcome.applied, false);
  assert.equal(outcome.rolledBack, true);
  assert.match(outcome.summary, /Rolled back/);
  assert.equal(await readFile(join(root, "src", "a.ts"), "utf8"), before);
});

test("an ambiguous or missing find is rejected before anything is written", async () => {
  const root = await makeRepo();
  const before = await readFile(join(root, "src", "dupe.ts"), "utf8");
  let verifyCalls = 0;
  const outcome = await applyPatches(
    [
      { file: "src/dupe.ts", find: "const", replace: "let", rationale: "ambiguous" },
      { file: "src/a.ts", find: "not in the file", replace: "x", rationale: "missing" }
    ],
    {
      repoRoot: root,
      verify: async () => {
        verifyCalls += 1;
        return ok();
      }
    }
  );
  assert.equal(outcome.applied, false);
  assert.equal(outcome.rejected.length, 2);
  assert.match(outcome.rejected[0].reason, /ambiguous/);
  assert.match(outcome.rejected[1].reason, /not found/);
  assert.equal(verifyCalls, 0, "nothing to verify when nothing applied");
  assert.equal(await readFile(join(root, "src", "dupe.ts"), "utf8"), before);
});

test("a valid patch still applies when a sibling patch is rejected", async () => {
  const root = await makeRepo();
  const outcome = await applyPatches(
    [
      { file: "src/a.ts", find: "'hello'", replace: "'hey'", rationale: "fine" },
      { file: "../escape.ts", find: "a", replace: "b", rationale: "not allowed" }
    ],
    { repoRoot: root, verify: ok }
  );
  assert.equal(outcome.applied, true);
  assert.equal(outcome.files.length, 1);
  assert.equal(outcome.rejected.length, 1);
  assert.match(await readFile(join(root, "src", "a.ts"), "utf8"), /'hey'/);
});

test("stacked patches to one file both land", async () => {
  const root = await makeRepo();
  const outcome = await applyPatches(
    [
      { file: "src/a.ts", find: "'hello'", replace: "'hey'", rationale: "one" },
      { file: "src/a.ts", find: "other = 1", replace: "other = 2", rationale: "two" }
    ],
    { repoRoot: root, verify: ok }
  );
  assert.equal(outcome.applied, true);
  const content = await readFile(join(root, "src", "a.ts"), "utf8");
  assert.match(content, /'hey'/);
  assert.match(content, /other = 2/);
});

test("over the session patch limit nothing is attempted", async () => {
  const root = await makeRepo();
  const patches = Array.from({ length: MAX_PATCHES_PER_SESSION + 1 }, (_, i) => ({
    file: "src/a.ts",
    find: `'hello'${i}`,
    replace: "x",
    rationale: "bulk"
  }));
  const outcome = await applyPatches(patches, { repoRoot: root, verify: ok });
  assert.equal(outcome.applied, false);
  assert.match(outcome.summary, /over the .*-patch session limit/);
});

test("dry run reports without writing", async () => {
  const root = await makeRepo();
  const before = await readFile(join(root, "src", "a.ts"), "utf8");
  const outcome = await applyPatches(
    [{ file: "src/a.ts", find: "'hello'", replace: "'hey'", rationale: "preview" }],
    { repoRoot: root, dryRun: true, verify: ok }
  );
  assert.equal(outcome.applied, false);
  assert.match(outcome.summary, /Dry run/);
  assert.equal(await readFile(join(root, "src", "a.ts"), "utf8"), before);
});

test("a patch that would empty a file is rejected", async () => {
  const root = await makeRepo();
  const content = await readFile(join(root, "src", "a.ts"), "utf8");
  const outcome = await applyPatches(
    [{ file: "src/a.ts", find: content, replace: "  ", rationale: "wipe" }],
    { repoRoot: root, verify: ok }
  );
  assert.equal(outcome.applied, false);
  assert.match(outcome.rejected[0].reason, /would empty/);
});
