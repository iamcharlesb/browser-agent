/**
 * Applies the code fixes learn mode proposes, under guardrails.
 *
 * A bot editing its own source is only acceptable if every edit is reversible and proven before it
 * is kept. So: validate every patch before touching anything, snapshot the files, apply, run the
 * real build + test suite, and restore the snapshot if anything goes red. A session either leaves
 * the tree green or leaves it exactly as it was - never half-fixed.
 */

import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, lstatSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** A single exact-text replacement. No fuzzy matching: `find` must appear exactly once. */
export interface ProposedPatch {
  /** Repo-relative path, e.g. `src/promptLoop.ts`. */
  file: string;
  find: string;
  replace: string;
  rationale: string;
}

export interface VerificationCheck {
  name: string;
  ok: boolean;
  output: string;
  durationMs: number;
}

export interface VerificationResult {
  ok: boolean;
  checks: VerificationCheck[];
}

export type Verifier = () => Promise<VerificationResult>;

export interface SelfFixOptions {
  repoRoot: string;
  /** Directories a patch may touch, repo-relative. Everything else is rejected. */
  allowedDirs?: string[];
  verify?: Verifier;
  /** Validate and report without writing anything. */
  dryRun?: boolean;
  /** Where snapshots of the pre-fix files are kept for forensics. */
  backupDir?: string;
}

export interface SelfFixOutcome {
  applied: boolean;
  rolledBack: boolean;
  files: string[];
  patches: ProposedPatch[];
  rejected: Array<{ patch: ProposedPatch; reason: string }>;
  verification?: VerificationResult;
  summary: string;
}

export const DEFAULT_ALLOWED_DIRS = ["src", "static"];
const ALLOWED_EXTENSIONS = [".ts", ".html", ".css", ".md"];
const PROTECTED_BASENAMES = new Set([".env", ".env.local", "package.json", "package-lock.json", "tsconfig.json"]);
/** A "fix" that rewrites half a file is not a fix; it's a rewrite nobody reviewed. */
const MAX_PATCH_CHARS = 6_000;
export const MAX_PATCHES_PER_SESSION = 8;

function hasAllowedExtension(file: string): boolean {
  return ALLOWED_EXTENSIONS.some((extension) => file.endsWith(extension));
}

/**
 * Resolves a patch's target path or explains why it is not patchable. Rejects absolute paths,
 * traversal, symlinks (which can point anywhere), protected files, and anything outside the
 * allowed directories.
 */
export function resolvePatchTarget(
  repoRoot: string,
  file: string,
  allowedDirs: string[] = DEFAULT_ALLOWED_DIRS
): { ok: true; absolutePath: string } | { ok: false; reason: string } {
  if (!file || typeof file !== "string") return { ok: false, reason: "patch.file must be a non-empty string" };
  if (isAbsolute(file)) return { ok: false, reason: "patch.file must be repo-relative" };
  if (file.includes("\0")) return { ok: false, reason: "patch.file contains a null byte" };

  const root = resolve(repoRoot);
  const absolutePath = resolve(root, file);
  const relativePath = relative(root, absolutePath);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    return { ok: false, reason: `patch.file escapes the repo: ${file}` };
  }

  const segments = relativePath.split(sep);
  if (!allowedDirs.includes(segments[0])) {
    return { ok: false, reason: `patch.file must live under ${allowedDirs.join(" or ")}/: ${file}` };
  }
  if (segments.includes("node_modules") || segments.includes(".git") || segments.includes("build") || segments.includes("dist")) {
    return { ok: false, reason: `generated or vendored paths are not patchable: ${file}` };
  }
  if (PROTECTED_BASENAMES.has(segments[segments.length - 1])) {
    return { ok: false, reason: `protected file: ${file}` };
  }
  if (!hasAllowedExtension(relativePath)) {
    return { ok: false, reason: `only ${ALLOWED_EXTENSIONS.join(", ")} files are patchable: ${file}` };
  }
  if (!existsSync(absolutePath)) {
    return { ok: false, reason: `file does not exist: ${file}` };
  }
  // Checked with lstat, not stat: a symlink inside src/ could otherwise redirect a write outside it.
  if (lstatSync(absolutePath).isSymbolicLink()) {
    return { ok: false, reason: `symlinks are not patchable: ${file}` };
  }
  return { ok: true, absolutePath };
}

interface ValidatedPatch {
  patch: ProposedPatch;
  absolutePath: string;
  original: string;
  next: string;
}

async function validatePatch(
  repoRoot: string,
  patch: ProposedPatch,
  allowedDirs: string[],
  pendingContents: Map<string, string>
): Promise<{ ok: true; validated: ValidatedPatch } | { ok: false; reason: string }> {
  if (typeof patch.find !== "string" || patch.find.length === 0) {
    return { ok: false, reason: "patch.find must be a non-empty string" };
  }
  if (typeof patch.replace !== "string") {
    return { ok: false, reason: "patch.replace must be a string" };
  }
  if (patch.find === patch.replace) {
    return { ok: false, reason: "patch is a no-op" };
  }
  if (patch.find.length > MAX_PATCH_CHARS || patch.replace.length > MAX_PATCH_CHARS) {
    return { ok: false, reason: `patch exceeds ${MAX_PATCH_CHARS} characters; split it into smaller edits` };
  }

  const target = resolvePatchTarget(repoRoot, patch.file, allowedDirs);
  if (!target.ok) return { ok: false, reason: target.reason };

  // Read through the pending map so several patches to one file stack instead of clobbering.
  const current = pendingContents.get(target.absolutePath) ?? (await readFile(target.absolutePath, "utf8"));
  const firstIndex = current.indexOf(patch.find);
  if (firstIndex === -1) {
    return { ok: false, reason: `patch.find not found in ${patch.file}` };
  }
  if (current.indexOf(patch.find, firstIndex + 1) !== -1) {
    return { ok: false, reason: `patch.find is ambiguous in ${patch.file} (matches more than once)` };
  }
  const next = current.slice(0, firstIndex) + patch.replace + current.slice(firstIndex + patch.find.length);
  if (next.trim().length === 0) {
    return { ok: false, reason: `patch would empty ${patch.file}` };
  }
  return { ok: true, validated: { patch, absolutePath: target.absolutePath, original: current, next } };
}

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number
): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolvePromise) => {
    execFile(
      command,
      args,
      { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, CI: "1" } },
      (error, stdout, stderr) => {
        const output = `${stdout ?? ""}${stderr ?? ""}`.trim();
        resolvePromise({ ok: !error, output: output.slice(-6_000) });
      }
    );
  });
}

/**
 * The real gate: typecheck then the test suite, in the repo. Learn mode reports "the code works"
 * only because this ran and came back green - never because a model said so.
 */
export function createDefaultVerifier(repoRoot: string, timeoutMs = 10 * 60_000): Verifier {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  return async () => {
    const checks: VerificationCheck[] = [];
    for (const [name, args] of [
      ["typecheck (tsc)", ["run", "build"]],
      ["tests (node --test)", ["test"]]
    ] as Array<[string, string[]]>) {
      const startedAt = Date.now();
      const result = await runCommand(npm, args, repoRoot, timeoutMs);
      checks.push({ name, ok: result.ok, output: result.output, durationMs: Date.now() - startedAt });
      // A failed typecheck makes the test output meaningless, so stop at the first red check.
      if (!result.ok) break;
    }
    return { ok: checks.length > 0 && checks.every((check) => check.ok), checks };
  };
}

/**
 * Applies every patch or none of them, then verifies. On a red verification the snapshot is
 * restored, so `rolledBack: true` means the tree is byte-identical to before the call.
 */
export async function applyPatches(patches: ProposedPatch[], options: SelfFixOptions): Promise<SelfFixOutcome> {
  const allowedDirs = options.allowedDirs ?? DEFAULT_ALLOWED_DIRS;
  const rejected: Array<{ patch: ProposedPatch; reason: string }> = [];
  const validated: ValidatedPatch[] = [];
  const pendingContents = new Map<string, string>();

  if (patches.length === 0) {
    return {
      applied: false,
      rolledBack: false,
      files: [],
      patches: [],
      rejected: [],
      summary: "No patches were proposed."
    };
  }
  if (patches.length > MAX_PATCHES_PER_SESSION) {
    return {
      applied: false,
      rolledBack: false,
      files: [],
      patches,
      rejected: patches.map((patch) => ({
        patch,
        reason: `a session may apply at most ${MAX_PATCHES_PER_SESSION} patches`
      })),
      summary: `Refused ${patches.length} patches: over the ${MAX_PATCHES_PER_SESSION}-patch session limit.`
    };
  }

  for (const patch of patches) {
    const result = await validatePatch(options.repoRoot, patch, allowedDirs, pendingContents);
    if (result.ok) {
      validated.push(result.validated);
      pendingContents.set(result.validated.absolutePath, result.validated.next);
    } else {
      rejected.push({ patch, reason: result.reason });
    }
  }

  if (validated.length === 0) {
    return {
      applied: false,
      rolledBack: false,
      files: [],
      patches,
      rejected,
      summary: `All ${patches.length} proposed patch(es) were rejected before any file was touched.`
    };
  }

  const files = [...new Set(validated.map((item) => relative(resolve(options.repoRoot), item.absolutePath)))];

  if (options.dryRun) {
    return {
      applied: false,
      rolledBack: false,
      files,
      patches: validated.map((item) => item.patch),
      rejected,
      summary: `Dry run: ${validated.length} patch(es) would apply cleanly to ${files.join(", ")}.`
    };
  }

  // One snapshot per file, taken before the first write to it.
  const snapshots = new Map<string, string>();
  for (const item of validated) {
    if (!snapshots.has(item.absolutePath)) snapshots.set(item.absolutePath, item.original);
  }

  if (options.backupDir) {
    try {
      await mkdir(options.backupDir, { recursive: true });
      for (const [absolutePath, content] of snapshots) {
        const backupPath = join(options.backupDir, relative(resolve(options.repoRoot), absolutePath).replace(/[\\/]/g, "__"));
        await mkdir(dirname(backupPath), { recursive: true });
        await writeFile(backupPath, content, "utf8");
      }
    } catch (err) {
      // Forensic copies are a convenience; the in-memory snapshot is what rollback relies on.
      console.warn(`Learn mode: could not write patch backups: ${(err as Error).message}`);
    }
  }

  const restore = async (): Promise<void> => {
    for (const [absolutePath, content] of snapshots) {
      await writeFile(absolutePath, content, "utf8");
    }
  };

  try {
    for (const [absolutePath, content] of pendingContents) {
      if (snapshots.has(absolutePath)) await writeFile(absolutePath, content, "utf8");
    }
  } catch (err) {
    await restore().catch(() => undefined);
    return {
      applied: false,
      rolledBack: true,
      files,
      patches: validated.map((item) => item.patch),
      rejected,
      summary: `Writing patches failed (${(err as Error).message}); the tree was restored.`
    };
  }

  const verify = options.verify ?? createDefaultVerifier(options.repoRoot);
  let verification: VerificationResult;
  try {
    verification = await verify();
  } catch (err) {
    await restore();
    return {
      applied: false,
      rolledBack: true,
      files,
      patches: validated.map((item) => item.patch),
      rejected,
      verification: { ok: false, checks: [{ name: "verify", ok: false, output: (err as Error).message, durationMs: 0 }] },
      summary: `Verification could not run (${(err as Error).message}); the tree was restored.`
    };
  }

  if (!verification.ok) {
    await restore();
    const failed = verification.checks.find((check) => !check.ok);
    return {
      applied: false,
      rolledBack: true,
      files,
      patches: validated.map((item) => item.patch),
      rejected,
      verification,
      summary: `Rolled back ${validated.length} patch(es): ${failed ? failed.name : "verification"} failed.`
    };
  }

  return {
    applied: true,
    rolledBack: false,
    files,
    patches: validated.map((item) => item.patch),
    rejected,
    verification,
    summary: `Applied ${validated.length} patch(es) to ${files.join(", ")} and verification passed.`
  };
}
