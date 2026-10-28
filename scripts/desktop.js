#!/usr/bin/env node
/**
 * Opens Pilo in Electron against the PRODUCTION copy.
 *
 *   yarn desktop:built     compile into build/, then open Electron on it
 *   yarn desktop:attach    skip the build and attach to a server that is already running
 *
 * Dev desktop (`yarn desktop` / `desktop:dev`) uses dist/ + watch on port 8765 — see desktopDev.js.
 * This script is the production path only.
 */

const { spawn, spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const path = require("node:path");

const projectRoot = path.join(__dirname, "..");
const isWindows = process.platform === "win32";
const electronBin = path.join(projectRoot, "node_modules", ".bin", isWindows ? "electron.cmd" : "electron");
const tscBin = path.join(projectRoot, "node_modules", ".bin", isWindows ? "tsc.cmd" : "tsc");

const attach = process.argv.includes("--attach");
const serverEntry = path.join("build", "server.js");

if (!existsSync(electronBin)) {
  console.error("[desktop] Electron is not installed. Run `yarn install` first.");
  process.exit(1);
}

if (!attach) {
  console.log("[desktop] Compiling production files into ./build...");
  const build = spawnSync(tscBin, ["-p", "tsconfig.json", "--outDir", "build"], {
    cwd: projectRoot,
    stdio: "inherit"
  });
  if (build.status !== 0) {
    console.error("[desktop] Build failed. Fix the errors above and re-run.");
    process.exit(build.status ?? 1);
  }
  if (!existsSync(path.join(projectRoot, serverEntry))) {
    console.error(`[desktop] ${serverEntry} is missing after the build.`);
    process.exit(1);
  }
}

// Learn mode is on in the production copy; an explicit env value always wins.
const env = {
  ...process.env,
  BROWSER_AGENT_LEARN_MODE: process.env.BROWSER_AGENT_LEARN_MODE ?? "1"
};

if (attach) {
  // Reuse a server that is already listening (e.g. `yarn built` on 8766) rather than starting one.
  env.BROWSER_AGENT_ATTACH_EXISTING = "1";
  env.BROWSER_AGENT_UI_PORT = process.env.BROWSER_AGENT_UI_PORT || "8766";
  console.log(`[desktop] Attaching to the server already on port ${env.BROWSER_AGENT_UI_PORT}...`);
} else {
  // Electron starts its own server from build/. Prefer a stable port so Google GIS
  // Authorized JavaScript origins (http://127.0.0.1:8766) keep working across restarts.
  env.BROWSER_AGENT_SERVER_ENTRY = serverEntry;
  env.BROWSER_AGENT_UI_PORT = process.env.BROWSER_AGENT_UI_PORT || "8766";
  delete env.BROWSER_AGENT_ATTACH_EXISTING;
  console.log(`[desktop] Starting Electron on the production build (port ${env.BROWSER_AGENT_UI_PORT})...`);
}

// Launch the binary directly: Electron's CLI reports normal Ctrl+C as a failure.
const child = spawn(require("electron"), ["."], { cwd: projectRoot, stdio: "inherit", env });
let shuttingDown = false;
child.on("error", (error) => {
  console.error(`[desktop] Could not start Electron: ${error.message}`);
  process.exit(1);
});
child.on("exit", (code, signal) => process.exit(shuttingDown ? 0 : signal ? 1 : code ?? 0));

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    shuttingDown = true;
    child.kill(signal);
  });
}
