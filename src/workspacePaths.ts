import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/** Resolve beneath the selected workspace, rejecting symlinks in every child component.
 * The workspace itself may be a symlink (for example macOS /tmp). This is path
 * containment, not an OS sandbox against a concurrent process replacing directories.
 */
export async function resolveWorkspacePath(workspace: string, input: string, allowMissing = false): Promise<string> {
  const lexicalRoot = resolve(workspace);
  const lexicalTarget = resolve(lexicalRoot, input.trim() || ".");
  const rel = relative(lexicalRoot, lexicalTarget);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("Path is outside the project workspace.");
  }
  let target = await realpath(lexicalRoot);
  const parts = rel ? rel.split(sep) : [];
  for (let index = 0; index < parts.length; index++) {
    target = join(target, parts[index]);
    const info = await lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (allowMissing && error.code === "ENOENT") return null;
      throw error;
    });
    if (info?.isSymbolicLink()) throw new Error("Workspace paths cannot traverse symbolic links.");
    if (info && index < parts.length - 1 && !info.isDirectory()) throw new Error("Workspace parent is not a directory.");
  }
  return target;
}
