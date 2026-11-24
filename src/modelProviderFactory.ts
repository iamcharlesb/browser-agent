import OpenAI from "openai";
import { envInteger, resolveModel } from "./runtimeConfig";
import { providerDefinition, providerKey, providerURL } from "./providerRegistry";

export interface ModelClientOptions { apiKey?: string; baseURL?: string; fetch?: typeof fetch; timeoutMs?: number }
/** One client factory shared by interactive engines and model-authored patch proposals. */
export function createModelClient(modelId: string, options: ModelClientOptions = {}) {
  const model = resolveModel(modelId);
  const provider = providerDefinition(model.provider);
  const apiKey = options.apiKey ?? (provider ? providerKey(provider) : undefined);
  const baseURL = options.baseURL ?? (provider ? providerURL(provider) : undefined);
  if (model.provider === "compatible" && !baseURL) throw new Error("Set the OpenAI-compatible API endpoint in Settings or COMPATIBLE_BASE_URL.");
  const client = new OpenAI({ apiKey: apiKey || "local-unconfigured", maxRetries: 0,
    timeout: options.timeoutMs ?? envInteger("BROWSER_AGENT_MODEL_TIMEOUT_MS", 120_000),
    ...(baseURL ? { baseURL } : {}), ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(provider?.headers ? { defaultHeaders: provider.headers } : {}) });
  return { client, model: model.provider === "ollama" ? modelId.replace(/^ollama:/, "") : modelId,
    provider: model.provider, api: model.api, apiKey, baseURL };
}
