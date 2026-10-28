#!/usr/bin/env node
import { parseArgs } from "node:util";
import { createInterface } from "node:readline";
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { TerminalClient } from "./terminalClient";

const help = `Pilo CLI — local agent conversations and browser tasks

Usage:
  pilo serve [--port 8765] [--data-dir PATH] [--env-file PATH] [--workspace PATH]
  pilo chat [--bot NAME] [--profile ID] [--model ID]
  pilo ask --task "Your request" [--json]
  pilo status
  pilo models

Client options:
  --server URL       Local server (BROWSER_AGENT_SERVER_URL or http://127.0.0.1:8765)
  --bot NAME         Conversation identity; the server retains its context
  --profile ID       Specialist profile, e.g. chief-marketing-officer
  --model ID         Use a server-configured model; server default when omitted
  --mode MODE        chat (default), browse, or act
  --engine ENGINE    cheap (default) or openai-sdk
  --json             Emit only the final result as JSON (ask)
  --help / --version Show help or version

Chat commands: /bot NAME, /model ID, /help, /quit
Approvals require an interactive terminal and apply once. Piped requests deny tool approvals.
Ctrl-C stops only this CLI request. Notifications and status reads never start tasks.
Provider credentials and limits are configured in the server environment.
`;

async function main(): Promise<number | void> {
  const { values, positionals } = parseArgs({
    options: {
      help: { type: "boolean", short: "h" }, version: { type: "boolean", short: "v" },
      task: { type: "string" }, server: { type: "string" }, bot: { type: "string" },
      profile: { type: "string" }, model: { type: "string" }, mode: { type: "string" }, engine: { type: "string" },
      json: { type: "boolean" }, port: { type: "string" }, "data-dir": { type: "string" },
      "env-file": { type: "string" }, workspace: { type: "string" }
    }, allowPositionals: true
  });
  if (values.help) { console.log(help); return 0; }
  if (values.version) { console.log(JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")).version); return 0; }
  if (positionals.length > 1) throw new Error("Pass task text with --task; see --help.");
  const command = positionals[0] || (values.task ? "ask" : "chat");
  if (!["serve", "chat", "ask", "status", "models"].includes(command)) throw new Error(`Unknown command: ${command}. See --help.`);
  if (values["env-file"] && command !== "serve") throw new Error("--env-file configures serve; client credentials stay on the server.");
  if (command === "serve") {
    if (values["env-file"]) process.env.BROWSER_AGENT_ENV_FILE = resolve(values["env-file"]);
    process.env.BROWSER_AGENT_ENV_FILE ||= join(resolve(values["data-dir"] || process.env.BROWSER_AGENT_DATA_DIR || join(homedir(), ".openbuddy")), ".env");
    await import("./environment");
    const port = Number(values.port || process.env.BROWSER_AGENT_UI_PORT || 8765);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("--port must be an integer between 1 and 65535.");
    const directory = resolve(values["data-dir"] || process.env.BROWSER_AGENT_DATA_DIR || join(homedir(), ".openbuddy"));
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    process.env.BROWSER_AGENT_DATA_DIR = directory;
    process.env.BROWSER_AGENT_UI_HOST = "127.0.0.1";
    process.env.BROWSER_AGENT_UI_PORT = String(port);
    process.env.BROWSER_AGENT_LEARN_MODE = "0";
    process.env.BROWSER_AGENT_WORKSPACE_ROOT = resolve(values.workspace || process.env.BROWSER_AGENT_WORKSPACE_ROOT || process.cwd());
    console.log(`Pilo data: ${directory}`);
    console.log(`Coding workspace: ${process.env.BROWSER_AGENT_WORKSPACE_ROOT}`);
    await import("./server");
    return;
  }
  const client = new TerminalClient(values.server || process.env.BROWSER_AGENT_SERVER_URL || "http://127.0.0.1:8765");
  if (command === "status" || command === "models") {
    const status = await client.json("/api/status");
    console.log(JSON.stringify(command === "models" ? status.models : {
      ok: status.ok, defaultModel: status.defaultModel, isRunning: status.isRunning,
      activeRuns: status.activeRuns, maxConcurrentRuns: status.maxConcurrentRuns
    }, null, 2));
    return 0;
  }
  if (values.json && command !== "ask") throw new Error("--json is supported with ask.");
  if (command === "ask" && !values.task?.trim()) throw new Error("ask requires --task with a non-empty request.");
  const mode = values.mode || "chat", engine = values.engine || "cheap";
  if (mode !== "chat" && mode !== "browse" && mode !== "act") throw new Error("--mode must be chat, browse, or act.");
  if (engine !== "cheap" && engine !== "openai-sdk") throw new Error("--engine must be cheap or openai-sdk.");
  const timeout = Number(process.env.BROWSER_AGENT_CLI_TIMEOUT_SECONDS || 1800);
  if (!Number.isSafeInteger(timeout) || timeout < 1) throw new Error("BROWSER_AGENT_CLI_TIMEOUT_SECONDS must be a positive integer.");
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  const ask = async (prompt: string): Promise<string | undefined> => {
    if (interactive) process.stderr.write(prompt);
    const line = await iterator.next();
    return line.done ? undefined : line.value;
  };
  let botName = values.bot?.trim() || "CLI Assistant", model = values.model;
  let activeAbort: AbortController | undefined;
  let chatExitCode = 0;
  let interrupted = false;
  const interrupt = () => {
    interrupted = true;
    activeAbort?.abort(new Error("Stopped by user."));
    lines.close();
  };
  process.on("SIGINT", interrupt);
  lines.on("SIGINT", interrupt);
  try {
    if (command === "chat" && interactive) console.error(`Pilo · ${botName}\n/bot NAME · /model ID · /quit`);
    while (!interrupted) {
      const task = command === "ask" ? values.task! : await ask(`${botName}> `);
      if (task === undefined || (command === "chat" && task.trim() === "/quit")) break;
      if (!task.trim()) continue;
      if (command === "chat" && task.startsWith("/")) {
        if (task.startsWith("/bot ") && task.slice(5).trim()) botName = task.slice(5).trim();
        else if (task.startsWith("/model ") && task.slice(7).trim()) model = task.slice(7).trim();
        else console.error("Commands: /bot NAME, /model ID, /help, /quit");
        continue;
      }
      activeAbort = new AbortController();
      const timer = setTimeout(() => activeAbort!.abort(new Error("CLI request timed out.")), timeout * 1000);
      try {
        const result = await client.run({ task, botName, ...(values.profile ? { profileId: values.profile } : {}),
          ...(model ? { model } : {}), interactionMode: mode, agentEngine: engine }, {
          signal: activeAbort.signal,
          approve: interactive ? async description => /^(y|yes)$/i.test((await ask(`Approve once: ${description}\n[y/N] `)) || "") : undefined
        });
        console.log(values.json ? JSON.stringify(result) : String(result.summary || "No summary returned."));
        if (command === "ask") return result.success === true ? 0 : 1;
        if (result.success !== true && chatExitCode === 0) chatExitCode = 1;
      } catch (error) {
        if (command === "ask" || interrupted) throw error;
        chatExitCode = 2;
        console.error(`Request failed: ${(error as Error).message}`);
      } finally { clearTimeout(timer); activeAbort = undefined; }
    }
    return interrupted ? 130 : chatExitCode;
  } finally { process.off("SIGINT", interrupt); lines.close(); }
}

if (require.main === module) {
  main().then(code => { if (code !== undefined) process.exitCode = code; }).catch(error => {
    // Transport errors never dump request bodies or server-side configuration.
    console.error(`Pilo: ${error instanceof Error ? error.message : "Request failed."}`);
    process.exitCode = error instanceof Error && error.message === "Stopped by user." ? 130 : 2;
  });
}
