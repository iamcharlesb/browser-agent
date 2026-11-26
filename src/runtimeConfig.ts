import "./environment";
import { providerDefinitions, providerDefinition, providerKey, providerModel, providerURL, providerApi } from "./providerRegistry";

export type ModelProvider =
  | "openai"
  | "anthropic"
  | "xai"
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
  | "claude-cli"
  | "local"
  | "compatible";
export type ModelApi = "responses" | "chat";
export interface ModelDefinition { id: string; label: string; provider: ModelProvider; api?: ModelApi }
const providers: ModelProvider[] = [
  "openai", "anthropic", "xai", "ollama", "huggingface", "deepseek", "qwen", "kimi",
  "zhipu", "minimax", "yi", "baichuan", "doubao", "stepfun", "siliconflow",
  "claude-cli", "local", "compatible"
];

export function envInteger(name: string, fallback: number, min = 1, max = 1_000_000): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  return value;
}

export function modelCatalog(): ModelDefinition[] {
  const models: ModelDefinition[] = [
    { id: "local-engine", label: "Local Engine", provider: "local" },
    { id: "claude-cli", label: "Claude CLI", provider: "claude-cli" }
  ];
  for (const provider of providerDefinitions) {
    const configured = providerModel(provider);
    if (configured) models.push({ id: provider.id === "ollama" ? `ollama:${configured}` : configured, label: `${provider.label} · ${configured}`, provider: provider.id, api: providerApi(provider) });
  }
  const raw = process.env.BROWSER_AGENT_MODELS_JSON?.trim();
  if (raw) {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new Error("BROWSER_AGENT_MODELS_JSON must be a JSON array."); }
    if (!Array.isArray(parsed)) throw new Error("BROWSER_AGENT_MODELS_JSON must be a JSON array.");
    for (const entry of parsed) {
      if (!entry || typeof entry.id !== "string" || !entry.id.trim() || !providers.includes(entry.provider) ||
          (entry.api !== undefined && entry.api !== "responses" && entry.api !== "chat")) {
        throw new Error("Each configured model needs an id, a valid provider, and optional api (responses or chat).");
      }
      // Deliberate projection: arbitrary configuration fields never reach /api/status.
      models.push({ id: entry.id.trim(), label: typeof entry.label === "string" ? entry.label : entry.id, provider: entry.provider, ...(entry.api ? { api: entry.api } : {}) });
    }
  }
  return Array.from(new Map(models.map(model => [model.id, model])).values());
}

export function defaultModel(): string {
  const selected = providerDefinition(process.env.BROWSER_AGENT_PROVIDER || "");
  return process.env.BROWSER_AGENT_MODEL?.trim() || (selected && providerModel(selected)) || process.env.OPENAI_MODEL?.trim() ||
    providerDefinitions.filter(provider => provider.keyVariable && providerKey(provider)).map(providerModel).find(Boolean) || "local-engine";
}

/** Explicit registry metadata wins; name inference supports existing saved selections. */
export function resolveModel(id: string): ModelDefinition & { api: ModelApi } {
  const registered = modelCatalog().find(model => model.id === id);
  const inferred: ModelProvider =
    id === "local-engine" ? "local" :
    id.startsWith("claude-cli") ? "claude-cli" :
    id.startsWith("ollama:") ? "ollama" :
    id.startsWith("hf:") ? "huggingface" :
    /^deepseek/i.test(id) ? "deepseek" :
    /^qwen/i.test(id) ? "qwen" :
    /^(kimi|moonshot)/i.test(id) ? "kimi" :
    /^glm/i.test(id) ? "zhipu" :
    /^(minimax|abab)/i.test(id) ? "minimax" :
    /^yi-/i.test(id) ? "yi" :
    /^baichuan/i.test(id) ? "baichuan" :
    /^doubao/i.test(id) ? "doubao" :
    /^step-/i.test(id) ? "stepfun" :
    /^claude/i.test(id) ? "anthropic" :
    /^grok/i.test(id) ? "xai" :
    "openai";
  const provider = registered?.provider ?? inferred;
  const definition = providerDefinition(provider);
  return { id, label: registered?.label ?? id, provider, api: registered?.api ?? (definition ? providerApi(definition) : "chat") };
}

/** A selected cloud model must never silently become the deterministic Local Engine. */
export function modelConfigurationIssue(id: string, apiKey?: string): string | undefined {
  const { provider } = resolveModel(id);
  const definition = providerDefinition(provider);
  if (definition?.keyVariable && !(apiKey ?? providerKey(definition))?.trim()) {
    return `${definition.label} is not connected. Open Settings → Provider keys and connection, enter your API key, and save. Then retry your request.`;
  }
  if (provider === "compatible" && !providerURL(definition!)) return "Set the API endpoint in Settings or COMPATIBLE_BASE_URL.";
  return undefined;
}

export function modelPricing(): Record<string, { input: number; output: number }> {
  const raw = process.env.MODEL_PRICING_JSON?.trim();
  if (!raw) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("MODEL_PRICING_JSON must be an object of input/output prices per million tokens."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("MODEL_PRICING_JSON must be an object.");
  const prices: Record<string, { input: number; output: number }> = {};
  for (const [model, price] of Object.entries(parsed)) {
    if (!price || typeof price.input !== "number" || typeof price.output !== "number" || !Number.isFinite(price.input) || !Number.isFinite(price.output) || price.input < 0 || price.output < 0) {
      throw new Error("MODEL_PRICING_JSON prices must be finite non-negative numbers.");
    }
    prices[model] = { input: price.input, output: price.output };
  }
  return prices;
}
