/** Load local configuration before modules derive defaults. Shell values always win. */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** An explicit file is exclusive; otherwise app settings override the parent checkout. */
export function environmentFilesFor(applicationRoot: string, explicit?: string): string[] {
  if (explicit) return [resolve(explicit)];
  const files = [join(applicationRoot, ".env")];
  const parentRoot = resolve(applicationRoot, "..", ".."), modules = join(parentRoot, ".gitmodules");
  if (existsSync(modules) && /path\s*=\s*node\/browser_agent\s*$/m.test(readFileSync(modules, "utf8"))) files.push(join(parentRoot, ".env"));
  return files;
}
export const environmentFilePaths = environmentFilesFor(resolve(__dirname, ".."), process.env.BROWSER_AGENT_ENV_FILE);
export const environmentFilePath = environmentFilePaths[0];
for (const envFile of environmentFilePaths) {
  if (!existsSync(envFile)) continue;
  for (const rawLine of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim().replace(/^export\s+/, "");
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || process.env[key] !== undefined) continue;
    let value = line.slice(separator + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      try { value = JSON.parse(value); } catch { value = value.slice(1, -1); }
    } else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
    process.env[key] = value;
  }
}
