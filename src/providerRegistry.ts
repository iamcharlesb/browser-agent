import "./environment";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export type CloudProvider =
  | "openai"
  | "ollama"
  | "huggingface"
  | "deepseek"
  | "qwen"
  | "kimi"
  | "zhipu"
  | "minimax"
  | "yi"
  | "baichuan"
  | "doubao"
  | "stepfun"
  | "siliconflow"
  | "anthropic"
  | "xai"
  | "compatible";
export interface ProviderDefinition {
  id: CloudProvider; label: string; keyVariable?: string; keyAliases?: string[];
  modelVariable: string; urlVariable: string; apiVariable: string;
  defaultModel?: string; baseURL?: string; api: "responses" | "chat"; headers?: Record<string, string>;
}
// Deployment configuration, packaged alongside the app; never holds credentials.
export const providerDefinitions: ProviderDefinition[] = JSON.parse(readFileSync(resolve(__dirname, "../config/providers.json"), "utf8"));
export function providerDefinition(id: string): ProviderDefinition | undefined { return providerDefinitions.find(provider => provider.id === id); }
export function providerKey(provider: ProviderDefinition): string | undefined {
  return [provider.keyVariable, ...(provider.keyAliases || [])].filter(Boolean).map(key => process.env[key!]?.trim()).find(Boolean);
}
export function providerModel(provider: ProviderDefinition): string | undefined { return process.env[provider.modelVariable]?.trim() || provider.defaultModel; }
export function providerURL(provider: ProviderDefinition): string | undefined { return process.env[provider.urlVariable]?.trim() || provider.baseURL; }
export function providerApi(provider: ProviderDefinition): "chat" | "responses" {
  const api = process.env[provider.apiVariable]?.trim() || provider.api;
  if (api !== "chat" && api !== "responses") throw new Error(`${provider.apiVariable} must be responses or chat.`);
  return api;
}
/** Deliberately expose connection metadata and booleans, never saved key values. */
function displayURL(provider: ProviderDefinition): string {
  const raw = providerURL(provider);
  if (!raw) return "";
  try { const url = new URL(raw); return url.username || url.password || url.search || url.hash ? "" : raw; } catch { return ""; }
}
export function providerCatalog() {
  return providerDefinitions.map(provider => ({ id: provider.id, label: provider.label,
    model: providerModel(provider) || "", baseURL: displayURL(provider), api: providerApi(provider),
    configured: !provider.keyVariable || Boolean(providerKey(provider)) }));
}
