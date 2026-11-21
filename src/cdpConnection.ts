import { envInteger } from "./runtimeConfig";

/** Retry attachment only, never replay page actions or replace the user's browser/profile. */
export async function connectCdp<T>(endpoint: string, connect: (endpoint: string, options: { timeout: number }) => Promise<T>): Promise<T> {
  const attempts = envInteger("BROWSER_AGENT_CDP_CONNECT_ATTEMPTS", 2, 1, 3);
  const timeout = envInteger("BROWSER_AGENT_CDP_CONNECT_TIMEOUT_MS", 10000, 1000, 60000);
  for (let attempt = 1; ; attempt++) {
    try { return await connect(endpoint, { timeout }); }
    catch (error) {
      if (attempt >= attempts || !/timeout|timed out|ECONNRESET|ECONNREFUSED|socket hang up|closed/i.test(String(error))) throw error;
    }
  }
}
