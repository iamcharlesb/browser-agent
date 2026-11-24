/** Compact, user-facing step labels for technical tool payloads. Full JSON stays in model tool output. */

function basename(path: string): string {
  const parts = String(path || "").replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || path;
}

function tryParseJson(raw: string): Record<string, unknown> | null {
  const text = String(raw || "").trim();
  if (!text.startsWith("{") && !text.startsWith("[")) return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function summarizeToolResultMessage(toolName: string, message: string, maxChars = 180): string {
  const raw = String(message || "").trim();
  if (!raw) return toolName || "working";
  const firstLine = raw.split("\n")[0].trim();
  const parsed = tryParseJson(firstLine) || tryParseJson(raw);
  if (parsed) {
    const path = typeof parsed.path === "string" ? parsed.path : "";
    const file = path ? basename(path) : "";
    if (toolName === "code_project" || ("hash" in parsed && path)) {
      if (typeof parsed.startLine === "number" && typeof parsed.endLine === "number") {
        return `Read ${path} · lines ${parsed.startLine}–${parsed.endLine}`.slice(0, maxChars);
      }
      if (typeof parsed.totalFiles === "number" || typeof parsed.indexedAt === "string") {
        const count = typeof parsed.totalFiles === "number" ? parsed.totalFiles : typeof parsed.files === "number" ? parsed.files : null;
        return (count != null ? `Indexed ${count} source files` : "Refreshed the local code index").slice(0, maxChars);
      }
      if (Array.isArray(parsed.matches)) {
        return `Found ${parsed.matches.length} code match${parsed.matches.length === 1 ? "" : "es"}${file ? ` in ${file}` : ""}`.slice(0, maxChars);
      }
      if (typeof parsed.beforeHash === "string" || parsed.changed === true) {
        return `Patched ${path || "source file"}`.slice(0, maxChars);
      }
      if (path) return `Inspected ${path}`.slice(0, maxChars);
    }
    if (toolName === "workspace_file" && path) {
      if (parsed.changed === true || typeof parsed.beforeHash === "string") return `Patched ${path}`.slice(0, maxChars);
      return `Updated ${path}`.slice(0, maxChars);
    }
  }
  if (/^\{"path":/.test(firstLine) && firstLine.includes('"hash"')) {
    const pathMatch = /"path"\s*:\s*"((?:\\.|[^"\\])*)"/.exec(firstLine);
    const start = /"startLine"\s*:\s*(\d+)/.exec(firstLine);
    const end = /"endLine"\s*:\s*(\d+)/.exec(firstLine);
    if (pathMatch) {
      const path = pathMatch[1].replace(/\\"/g, '"');
      if (start && end) return `Read ${path} · lines ${start[1]}–${end[1]}`.slice(0, maxChars);
      return `Inspected ${path}`.slice(0, maxChars);
    }
  }
  return firstLine.slice(0, maxChars);
}
