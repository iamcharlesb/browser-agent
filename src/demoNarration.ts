import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envInteger } from "./runtimeConfig";

// Fixed application-owned narration. The route cannot synthesize arbitrary text.
export const demoNarration = [
  "Explore Pilo's specialist bots.",
  "Choose Demo Director to prepare your demo.",
  "Open the workspace tools.",
  "Browse Pilo's built in help."
];
const run = promisify(execFile);
let active = false;
export async function renderDemoNarration(scene: unknown): Promise<Buffer> {
  if (typeof scene !== "number" || !Number.isInteger(scene) || !demoNarration[scene]) throw new Error("Unknown narration scene.");
  if (active) throw new Error("Narration is busy. Please retry.");
  active = true;
  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), "pilo-narration-"));
    const file = join(directory, "voice.wav");
    const rate = envInteger("BROWSER_AGENT_DEMO_SPEECH_RATE", 180, 100, 250);
    const voice = process.env.BROWSER_AGENT_DEMO_VOICE;
    const timeout = envInteger("BROWSER_AGENT_DEMO_SPEECH_TIMEOUT_MS", 15000, 1000, 60000);
    if (process.platform === "darwin") {
      await run("/usr/bin/say", ["-o", file, "--file-format=WAVE", "--data-format=LEI16@22050", "-r", String(rate), ...(voice ? ["-v", voice] : []), demoNarration[scene]], { timeout });
    } else if (process.platform === "linux") {
      await run("espeak", ["-w", file, "-s", String(rate), ...(voice ? ["-v", voice] : []), demoNarration[scene]], { timeout });
    } else throw new Error("Local narration is unavailable on this host.");
    return await readFile(file);
  } catch {
    throw new Error("Local narration needs macOS speech or eSpeak on the Pilo host and a valid configured voice. Disable voice to continue silently.");
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
    active = false;
  }
}
