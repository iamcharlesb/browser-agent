#!/usr/bin/env node
/**
 * Local dev launcher: rebuilds TypeScript on every change and restarts the server process
 * automatically. No extra dependencies (no nodemon/concurrently) — just tsc's watch mode plus
 * Node's built-in `--watch`, which restarts the process when any file it required changes.
 */

const { spawnSync, spawn } = require("node:child_process");
const path = require("node:path");

const projectRoot = path.join(__dirname, "..");
const tscBin = path.join(projectRoot, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");

console.log("[dev] Building once before starting watchers...");
const initialBuild = spawnSync(tscBin, ["-p", "tsconfig.json"], { cwd: projectRoot, stdio: "inherit" });
if (initialBuild.status !== 0) {
  console.error("[dev] Initial build failed. Fix the errors above and re-run.");
  process.exit(initialBuild.status ?? 1);
}

const children = [];

function spawnWatcher(name, command, args) {
  const child = spawn(command, args, {
    cwd: projectRoot,
    stdio: "inherit",
    env: { ...process.env, BROWSER_AGENT_LIVE_RELOAD: "1" }
  });
  child.on("exit", (code, signal) => {
    if (signal) return; // killed by us during shutdown
    console.error(`[dev] ${name} exited unexpectedly (code ${code}).`);
  });
  children.push(child);
  return child;
}

console.log("[dev] Watching TypeScript sources and the server process...");
spawnWatcher("tsc --watch", tscBin, ["-w", "-p", "tsconfig.json", "--preserveWatchOutput"]);
spawnWatcher("node --watch server", process.execPath, ["--watch", "dist/server.js"]);

function shutdown() {
  for (const child of children) {
    child.kill("SIGTERM");
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
