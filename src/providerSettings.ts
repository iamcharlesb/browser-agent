import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { environmentFilePath } from "./environment";
import { providerDefinition, providerModel, providerURL } from "./providerRegistry";

const fields: Record<string, string> = {
  openaiApiKey: "OPENAI_API_KEY", anthropicApiKey: "ANTHROPIC_API_KEY",
  xaiApiKey: "XAI_API_KEY", deepgramApiKey: "DEEPGRAM_API_KEY",
  elevenLabsApiKey: "ELEVENLABS_API_KEY", baseURL: "OPENAI_BASE_URL"
};
let saves: Promise<unknown> = Promise.resolve();

/** Persist only connection fields, preserving unrelated environment configuration. */
export async function saveProviderSettings(input: Record<string, unknown>, file = environmentFilePath): Promise<Record<string, string | undefined>> {
  const updates: Record<string, string | undefined> = {};
  if (input.provider !== undefined) {
    const provider = typeof input.provider === "string" && providerDefinition(input.provider);
    if (!provider) throw new Error("Choose a supported provider.");
    const text = (field: string, fallback = "") => {
      const value = input[field] ?? fallback;
      if (typeof value !== "string" || /[\r\n\0]/.test(value)) throw new Error("Connection settings must be single-line text values.");
      return value.trim();
    };
    const model = text("providerModel", providerModel(provider));
    const url = text("providerBaseURL", providerURL(provider));
    const key = text("providerApiKey");
    if (!model) throw new Error("Enter the model ID supplied by your provider.");
    if (url) {
      let parsed: URL;
      try { parsed = new URL(url); } catch { throw new Error("Enter a valid API endpoint URL."); }
      if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("Use an http(s) API base URL without credentials, query parameters, or fragments.");
    } else throw new Error("Enter your provider's API endpoint URL.");
    updates.BROWSER_AGENT_PROVIDER = provider.id;
    updates.BROWSER_AGENT_MODEL = provider.id === "ollama" ? `ollama:${model.replace(/^ollama:/, "")}` : model;
    updates[provider.modelVariable] = model.replace(/^ollama:/, "");
    updates[provider.urlVariable] = url;
    if (key && provider.keyVariable) updates[provider.keyVariable] = key;
  }
  for (const [field, variable] of Object.entries(fields)) {
    if (input[field] === undefined) continue;
    if (typeof input[field] !== "string" || /[\r\n\0]/.test(input[field] as string)) throw new Error("Connection settings must be single-line text values.");
    const value = (input[field] as string).trim();
    if (field === "baseURL") {
      if (value) {
        try { if (!["http:", "https:"].includes(new URL(value).protocol)) throw new Error(); }
        catch { throw new Error("The API connection URL must start with http:// or https://."); }
      }
      updates[variable] = value || undefined;
    } else if (value) updates[variable] = value;
  }
  if (!Object.keys(updates).length) return updates;
  const next = saves.catch(() => undefined).then(async () => {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      const info = await lstat(file).catch(error => { if (error.code === "ENOENT") return null; throw error; });
      if (info && (!info.isFile() || info.isSymbolicLink())) throw new Error("Not a regular configuration file.");
      const previous = await readFile(file, "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; });
      const remaining = new Set(Object.keys(updates));
      const lines = previous.split(/\r?\n/).filter((line, index, all) => index < all.length - 1 || line !== "").flatMap(line => {
        const variable = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1];
        if (!variable || !Object.hasOwn(updates, variable)) return [line];
        // Replace duplicate entries with one authoritative value.
        if (!remaining.delete(variable) || updates[variable] === undefined) return [];
        return [`${variable}=${JSON.stringify(updates[variable])}`];
      });
      for (const variable of remaining) if (updates[variable] !== undefined) lines.push(`${variable}=${JSON.stringify(updates[variable])}`);
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      await writeFile(temporary, lines.join("\n") + "\n", { mode: 0o600, flag: "wx" });
      await rename(temporary, file);
    } catch {
      await unlink(temporary).catch(() => undefined);
      throw new Error("Could not save the connection securely. Check that the local environment file is writable; the connection was not changed.");
    }
  });
  saves = next;
  await next;
  return updates;
}
