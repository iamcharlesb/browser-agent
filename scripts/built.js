#!/usr/bin/env node
/** Build and run an isolated production copy alongside the dev server. */

const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { openWhenReady } = require("./openBrowser");

const projectRoot = path.join(__dirname, "..");
const tscBin = path.join(projectRoot, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");

console.log("[built] Compiling production files into ./build...");
const build = spawnSync(tscBin, ["-p", "tsconfig.json", "--outDir", "build"], {
  cwd: projectRoot,
  stdio: "inherit"
});

if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

process.env.BROWSER_AGENT_UI_PORT ??= "8766";
const host = process.env.BROWSER_AGENT_UI_HOST;
const openHost = !host || host === "0.0.0.0" ? "127.0.0.1" : host;
const port = process.env.BROWSER_AGENT_UI_PORT;
console.log(`[built] Starting production build on http://${openHost}:${port}`);
openWhenReady(`http://${openHost}:${port}`);
require(path.join(projectRoot, "build", "server.js"));
