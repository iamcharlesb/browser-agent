"use strict";

const http = require("node:http");
const { spawn } = require("node:child_process");

/**
 * Poll `url` until it responds (any status), then open it in the default browser.
 * No-op when BROWSER_AGENT_NO_OPEN=1. Never throws; failures are logged only.
 */
function openWhenReady(url) {
  if (process.env.BROWSER_AGENT_NO_OPEN === "1") return;

  const deadline = Date.now() + 30_000;
  const intervalMs = 300;

  function tryOnce() {
    const req = http.get(url, (res) => {
      res.resume();
      openUrl(url);
    });
    req.on("error", () => {
      if (Date.now() >= deadline) return;
      setTimeout(tryOnce, intervalMs);
    });
    req.setTimeout(intervalMs, () => {
      req.destroy();
    });
  }

  tryOnce();
}

function openUrl(url) {
  let command;
  let args;
  if (process.platform === "darwin") {
    command = "open";
    args = [url];
  } else if (process.platform === "win32") {
    command = "cmd";
    args = ["/c", "start", "", url];
  } else {
    command = "xdg-open";
    args = [url];
  }

  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore"
    });
    child.on("error", (err) => {
      console.error(`[openBrowser] Failed to open ${url}: ${err.message}`);
    });
    child.unref();
  } catch (err) {
    console.error(`[openBrowser] Failed to open ${url}: ${err.message}`);
  }
}

module.exports = { openWhenReady };
