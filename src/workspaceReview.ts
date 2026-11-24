import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { providerCatalog } from "./providerRegistry";
import { redactSecrets } from "./security";

const exec = promisify(execFile);

export interface WorkspaceReviewFile {
  status: string;
  path: string;
  originalPath?: string;
}

export interface WorkspaceReviewResult {
  gitAvailable: boolean;
  branch: string;
  files: WorkspaceReviewFile[];
  diffStat: string;
  selectedFile?: string;
  diff: string;
}

async function assertInsideWorkspace(workspaceRoot: string, relPath: string): Promise<string> {
  if (!relPath || isAbsolute(relPath) || relPath.includes("\0")) {
    throw new Error("File path must be relative to the workspace.");
  }
  const base = await realpath(workspaceRoot);
  const candidate = resolve(base, relPath);
  const rel = relative(base, candidate);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("File path must stay inside the workspace.");
  }
  return rel.split(sep).join("/");
}

/** Parse `git status --porcelain=v1 -z` records, handling renames/copies and unquoted paths. */
export function parsePorcelainZ(raw: string): WorkspaceReviewFile[] {
  const entries: WorkspaceReviewFile[] = [];
  const tokens = raw.split("\0");
  let index = 0;
  while (index < tokens.length && entries.length < 200) {
    const token = tokens[index];
    index += 1;
    if (!token || token.length < 4) continue;
    const status = token.slice(0, 2).trim() || "M";
    const filePath = token.slice(3);
    const x = token[0];
    const y = token[1];
    if (x === "R" || x === "C" || y === "R" || y === "C") {
      const originalPath = tokens[index] || undefined;
      index += 1;
      entries.push({ status, path: filePath, ...(originalPath ? { originalPath } : {}) });
    } else {
      entries.push({ status, path: filePath });
    }
  }
  return entries;
}

async function readUntrackedPreview(workspaceRoot: string, relPath: string): Promise<string> {
  const base = await realpath(workspaceRoot);
  const target = await realpath(resolve(base, relPath));
  const rel = relative(base, target);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("File path must stay inside the workspace.");
  }
  const info = await lstat(target);
  if (!info.isFile() || info.size > 200_000) {
    return `--- /dev/null\n+++ b/${relPath}\n(untracked non-regular or large file: ${info.size} bytes)`;
  }
  const content = await readFile(target, "utf8");
  if (content.includes("\0")) {
    return `--- /dev/null\n+++ b/${relPath}\n(binary untracked file)`;
  }
  const addedLines = content
    .split("\n")
    .slice(0, 300)
    .map((line) => `+${line}`)
    .join("\n");
  return `--- /dev/null\n+++ b/${relPath}\n${addedLines}`;
}

/**
 * Read-only Git review snapshot for the right-pane Review tab.
 * Includes unstaged diffs, staged diffs, and untracked file previews.
 */
export async function getWorkspaceReview(
  workspaceRoot: string,
  file?: string
): Promise<WorkspaceReviewResult> {
  const opts = { cwd: workspaceRoot, encoding: "utf8" as const, timeout: 8000, maxBuffer: 2 * 1024 * 1024 };
  try {
    await exec("git", ["rev-parse", "--is-inside-work-tree"], opts);
  } catch {
    return {
      gitAvailable: false,
      branch: "",
      files: [],
      diffStat: "",
      diff: ""
    };
  }

  const [{ stdout: branchOut }, { stdout: statusOut }, { stdout: unstagedStat }, { stdout: stagedStat }] =
    await Promise.all([
      exec("git", ["branch", "--show-current"], opts).catch(() => ({ stdout: "" })),
      exec("git", ["status", "--porcelain=v1", "-z"], opts).catch(() => ({ stdout: "" })),
      exec("git", ["diff", "--stat"], opts).catch(() => ({ stdout: "" })),
      exec("git", ["diff", "--cached", "--stat"], opts).catch(() => ({ stdout: "" }))
    ]);

  const files = parsePorcelainZ(statusOut);
  const diffStat = redactSecrets([stagedStat.trim(), unstagedStat.trim()].filter(Boolean).join("\n"));

  let selectedFile: string | undefined;
  let diff = "";
  if (file && file.trim()) {
    selectedFile = await assertInsideWorkspace(workspaceRoot, file.trim());
    const matched = files.find((f) => f.path === selectedFile);
    const parts: string[] = [];

    if (matched?.status === "??") {
      parts.push(await readUntrackedPreview(workspaceRoot, selectedFile));
    } else {
      const [{ stdout: stagedDiff }, { stdout: unstagedDiff }] = await Promise.all([
        exec("git", ["diff", "--cached", "--", selectedFile], opts).catch(() => ({ stdout: "" })),
        exec("git", ["diff", "--", selectedFile], opts).catch(() => ({ stdout: "" }))
      ]);
      if (stagedDiff.trim()) parts.push(`# Staged changes\n${stagedDiff.trim()}`);
      if (unstagedDiff.trim()) parts.push(`# Unstaged changes\n${unstagedDiff.trim()}`);
    }
    diff = redactSecrets(parts.join("\n\n")).slice(0, 40_000);
  } else {
    const [{ stdout: stagedDiff }, { stdout: unstagedDiff }] = await Promise.all([
      exec("git", ["diff", "--cached"], opts).catch(() => ({ stdout: "" })),
      exec("git", ["diff"], opts).catch(() => ({ stdout: "" }))
    ]);
    const parts: string[] = [];
    if (stagedDiff.trim()) parts.push(`# Staged changes\n${stagedDiff.trim()}`);
    if (unstagedDiff.trim()) parts.push(`# Unstaged changes\n${unstagedDiff.trim()}`);
    const untracked = files.filter((f) => f.status === "??");
    if (untracked.length > 0 && parts.length === 0) {
      parts.push(`# Untracked files (${untracked.length})\n` + untracked.map((f) => `?? ${f.path}`).join("\n"));
    }
    diff = redactSecrets(parts.join("\n\n")).slice(0, 40_000);
  }

  return {
    gitAvailable: true,
    branch: branchOut.trim() || "HEAD",
    files,
    diffStat,
    selectedFile,
    diff
  };
}

/**
 * Read-only catalog of configured providers, Agent Gateway protocols, and built-in tools.
 * Deliberately exposes only connection status and capability metadata, never credentials.
 */
export function getWorkspacePluginsSummary() {
  const providers = providerCatalog();
  const ollama = providers.find((p) => p.id === "ollama");
  const ollamaStatus = ollama && ollama.model ? "configured" : "unconfigured";
  return {
    providers,
    protocols: [
      { id: "mcp", name: "MCP Federation", status: "supported", description: "Namespaced tool, resource, and prompt federation with RBAC filtering (available via PiloAgentGateway)." },
      { id: "a2a", name: "A2A Agent Routing", status: "supported", description: "Agent Cards (/.well-known/agent.json) and cancellable task routing (available via PiloAgentGateway)." },
      { id: "ollama", name: "Local Ollama", status: ollamaStatus, description: "Native tool calling, structured outputs, /api/tags discovery, and cloud failover." }
    ],
    tools: [
      { id: "code_project", name: "Code Index & Search", category: "Workspace", description: "Git-aware cached code index, map, search, and live line reads." },
      { id: "workspace_file", name: "Hash-Checked File Patching", category: "Workspace", description: "Safe workspace edits guarded by expectedHash verification." },
      { id: "run_terminal_command", name: "Local Terminal", category: "DevOps", description: "Run build, test, and git commands under workspace permissions." },
      { id: "browser", name: "Playwright / Chrome CDP", category: "Browser", description: "Live browser automation with action-effect approval gates." },
      { id: "web_research", name: "Browserless Web Research", category: "Research", description: "SSRF-safe public URL reader and hosted web search." }
    ]
  };
}
