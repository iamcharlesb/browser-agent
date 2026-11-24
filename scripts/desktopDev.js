#!/usr/bin/env node
const { desktopExecutable } = require("./desktopExecutable");
/**
 * Opens Pilo in Electron against the DEV output (dist/) with watch/reload.
 *
 *   yarn desktop:dev
 *
 * The desktop owns browser sessions and the watched agent server. Rebuilding
 * dist/ restarts only the agent server; the Electron window and browser tabs stay alive.
 *
 * Alternative (two terminals): `yarn dev` then
 *   BROWSER_AGENT_UI_PORT=8765 yarn desktop:attach
 */

const { spawn, spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const path = require("node:path");

const projectRoot = path.join(__dirname, "..");
const isWindows = process.platform === "win32";
const electronBin = path.join(projectRoot, "node_modules", ".bin", isWindows ? "electron.cmd" : "electron");
const tscBin = path.join(projectRoot, "node_modules", ".bin", isWindows ? "tsc.cmd" : "tsc");
const serverEntry = path.join("dist", "server.js");

if (!existsSync(electronBin)) {
  console.error("[desktop:dev] Electron is not installed. Run `yarn install` first.");
  process.exit(1);
}

console.log("[desktop:dev] Building once before starting watchers...");
const initialBuild = spawnSync(tscBin, ["-p", "tsconfig.json"], { cwd: projectRoot, stdio: "inherit" });
if (initialBuild.status !== 0) {
  console.error("[desktop:dev] Initial build failed. Fix the errors above and re-run.");
  process.exit(initialBuild.status ?? 1);
}
if (!existsSync(path.join(projectRoot, serverEntry))) {
  console.error(`[desktop:dev] ${serverEntry} is missing after the build.`);
  process.exit(1);
}

const children = [];
let shuttingDown = false;

function spawnChild(name, command, args, env) {
  const child = spawn(command, args, {
    cwd: projectRoot,
    stdio: "inherit",
    env
  });
  child.on("error", (error) => {
    console.error(`[desktop:dev] Could not start ${name}: ${error.message}`);
    shutdown(1);
  });
  child.on("exit", (code, signal) => {
    if (shuttingDown || signal) return;
    console.error(`[desktop:dev] ${name} exited unexpectedly (code ${code}).`);
    shutdown(code ?? 1);
  });
  children.push(child);
  return child;
}

const uiPort = process.env.BROWSER_AGENT_UI_PORT || "8765";
const sharedEnv = {
  ...process.env,
  BROWSER_AGENT_UI_PORT: uiPort,
  BROWSER_AGENT_LIVE_RELOAD: "1",
  BROWSER_AGENT_LEARN_MODE: process.env.BROWSER_AGENT_LEARN_MODE ?? "0",
  BROWSER_AGENT_NO_OPEN: "1"
};

console.log(
  `[desktop:dev] Watching TypeScript → dist/; server + Electron on http://127.0.0.1:${uiPort}` +
    ` (Google OAuth origin).`
);

spawnChild("tsc --watch", tscBin, ["-w", "-p", "tsconfig.json", "--preserveWatchOutput"], sharedEnv);
const electronEnv = { ...sharedEnv, BROWSER_AGENT_SERVER_ENTRY: serverEntry };
delete electronEnv.BROWSER_AGENT_ATTACH_EXISTING;
// Avoid Electron's CLI treating an intentional Ctrl+C as an error.
spawnChild("electron", desktopExecutable(), ["."], electronEnv);

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    try {
      child.kill("SIGTERM");
    } catch (_) {
      /* ignore */
    }
  }
  process.exit(code);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => shutdown(0));
}
