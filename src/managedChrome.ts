/** A normal installed Chrome process, independently owned from the agent server. */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

export function managedChromeEnabled(): boolean {
  return process.env.BROWSER_AGENT_MANAGED_CHROME === "1" ||
    (process.env.OPEN_BOTS_EMBEDDED === "1" && process.env.BROWSER_AGENT_MANAGED_CHROME !== "0");
}

export function chromeLaunchArgs(endpoint: string, profileDir: string): string[] {
  const target = new URL(endpoint);
  if (target.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) ||
      target.username || target.password || target.pathname !== "/" || target.search || target.hash) {
    throw new Error("Automatic Chrome startup requires a local HTTP debugging endpoint.");
  }
  return [
    `--remote-debugging-port=${target.port || "80"}`, "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${profileDir}`, "--no-first-run", "--no-default-browser-check", "about:blank"
  ];
}

function installedChrome(): string {
  const candidates = [
    process.env.BROWSER_AGENT_CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    join(homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Google/Chrome/Application/chrome.exe"),
    process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, "Google/Chrome/Application/chrome.exe"),
    ...(process.env.PATH || "").split(delimiter).flatMap(dir => [join(dir, "google-chrome"), join(dir, "google-chrome-stable"), join(dir, "chrome.exe")])
  ];
  const binary = candidates.find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));
  if (!binary) throw new Error("Google Chrome is required for website browsing. Install Chrome, then retry; the app connects automatically.");
  return binary;
}

const starts = new Map<string, Promise<void>>();
export async function ensureManagedChrome(endpoint: string, profileDir: string, probe: (endpoint: string) => Promise<boolean>): Promise<void> {
  if (await probe(endpoint)) return;
  const existing = starts.get(endpoint);
  if (existing) return existing;
  const start = (async () => {
    const args = chromeLaunchArgs(endpoint, profileDir);
    const child = spawn(installedChrome(), args, { detached: true, stdio: "ignore" });
    let launchError: Error | undefined;
    child.once("error", error => { launchError = error; });
    child.unref();
    const deadline = Date.now() + 15000;
    do {
      if (launchError) throw launchError;
      if (await probe(endpoint)) return;
      await new Promise(resolve => setTimeout(resolve, 200));
    } while (Date.now() < deadline);
    throw new Error("Chrome did not become ready. Close the app’s dedicated Chrome window and retry; your personal Chrome can stay open.");
  })();
  starts.set(endpoint, start);
  try { await start; } finally { starts.delete(endpoint); }
}
