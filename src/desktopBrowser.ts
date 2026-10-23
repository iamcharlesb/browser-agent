/** The desktop owns tabs; Playwright is an attached automation client. */
export interface DesktopBrowserState {
  activeTabId: string | null;
  tabs: Array<{ id: string; targetId: string; index: number; url: string; title: string; active: boolean }>;
}

export function desktopBrowserAvailable(): boolean {
  return Boolean(process.env.OPEN_BOTS_BROWSER_BROKER_URL && process.env.OPEN_BOTS_BROWSER_BROKER_TOKEN);
}

export async function desktopBrowserRequest(command?: Record<string, unknown>): Promise<DesktopBrowserState> {
  const endpoint = process.env.OPEN_BOTS_BROWSER_BROKER_URL;
  const token = process.env.OPEN_BOTS_BROWSER_BROKER_TOKEN;
  if (!endpoint || !token) throw new Error("Desktop browser workspace is unavailable.");
  const response = await fetch(`${endpoint}${command ? "/command" : "/state"}`, {
    method: command ? "POST" : "GET",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: command ? JSON.stringify(command) : undefined,
    signal: AbortSignal.timeout(command ? 30000 : 3000)
  });
  if (!response.ok) throw new Error(`Desktop browser workspace request failed (${response.status}).`);
  return response.json() as Promise<DesktopBrowserState>;
}
