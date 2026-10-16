/** CLI harness for the autonomous browser agent. */

import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { BrowserController, DEFAULT_PROFILE_DIR, PageState, defaultBrowserConfig } from "./browserController";
import { AgentOrchestrator, DEFAULT_MODEL } from "./promptLoop";

interface CliOptions {
  login: boolean;
  loginUrl: string;
  task: string;
  headless: boolean;
  maxSteps: number;
  maxDuration: number;
  viewportWidth: number;
  viewportHeight: number;
  model: string;
  keepRecentImages: number;
  profileDir: string;
}

function printUsage(): void {
  console.log(
    [
      "Autonomous browser agent powered by an OpenAI model and Playwright.",
      "",
      "Usage: node dist/cli.js --task \"<description>\" [options]",
      "       node dist/cli.js --login [--login-url <url>]",
      "",
      "Both modes share the same persistent browser profile (--profile-dir), so logging in and",
      "clearing MFA once in --login mode carries over into every later --task run.",
      "",
      "Options:",
      "  --task <string>             Natural language description of the task to accomplish.",
      "  --login                     Open the persistent profile in a visible window so you can",
      "                               sign in to whatever sites you need. Press Enter when done.",
      "  --login-url <url>           URL to open in --login mode. Default: about:blank.",
      "  --headless                  Run the browser without a visible UI window (--task mode only).",
      "  --max-steps <n>             Maximum agent steps before the circuit breaker halts the run. Default: 20.",
      "  --max-duration <seconds>    Maximum wall-clock seconds before the circuit breaker halts the run. Default: 900.",
      "  --viewport <WxH>            Browser viewport size, e.g. 1280x800. Default: 1280x800.",
      `  --model <id>                OpenAI model id to use. Default: ${DEFAULT_MODEL}.`,
      "  --keep-recent-images <n>    Number of most recent screenshots to keep active in context. Default: 2.",
      `  --profile-dir <path>        Persistent Chromium profile directory. Default: ${DEFAULT_PROFILE_DIR}.`,
      "  --help                      Show this help message."
    ].join("\n")
  );
}

function parseViewport(value: string): { width: number; height: number } {
  const match = /^(\d+)x(\d+)$/i.exec(value.trim());
  if (!match) {
    throw new Error(`Invalid viewport '${value}'. Expected format WIDTHxHEIGHT, e.g. 1280x800.`);
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width <= 0 || height <= 0) {
    throw new Error("Viewport dimensions must be positive integers.");
  }
  return { width, height };
}

function parseCliArgs(argv: string[]): CliOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      task: { type: "string" },
      login: { type: "boolean", default: false },
      "login-url": { type: "string", default: "about:blank" },
      headless: { type: "boolean", default: false },
      "max-steps": { type: "string", default: "20" },
      "max-duration": { type: "string", default: "900" },
      viewport: { type: "string", default: "1280x800" },
      model: { type: "string", default: DEFAULT_MODEL },
      "keep-recent-images": { type: "string", default: "2" },
      "profile-dir": { type: "string", default: DEFAULT_PROFILE_DIR },
      help: { type: "boolean", default: false }
    },
    allowPositionals: false
  });

  if (values.help) {
    printUsage();
    process.exit(0);
  }

  const login = Boolean(values.login);
  if (!login && (!values.task || !String(values.task).trim())) {
    throw new Error("--task is required (or pass --login to set up a signed-in session).");
  }

  const viewport = parseViewport(String(values.viewport));
  const maxSteps = Number(values["max-steps"]);
  const maxDuration = Number(values["max-duration"]);
  const keepRecentImages = Number(values["keep-recent-images"]);
  if (!Number.isFinite(maxSteps) || maxSteps <= 0) {
    throw new Error("--max-steps must be a positive number.");
  }
  if (!Number.isFinite(maxDuration) || maxDuration <= 0) {
    throw new Error("--max-duration must be a positive number.");
  }
  if (!Number.isFinite(keepRecentImages) || keepRecentImages < 0) {
    throw new Error("--keep-recent-images must be a non-negative number.");
  }

  return {
    login,
    loginUrl: String(values["login-url"]),
    task: String(values.task ?? ""),
    headless: Boolean(values.headless),
    maxSteps,
    maxDuration,
    viewportWidth: viewport.width,
    viewportHeight: viewport.height,
    model: String(values.model),
    keepRecentImages,
    profileDir: String(values["profile-dir"])
  };
}

function makeHumanVerificationHook(headless: boolean): (state: PageState) => Promise<void> {
  return async (state: PageState) => {
    if (headless) {
      console.warn(
        `Human verification detected at ${state.url}, but the browser is running headless so ` +
          "there is no visible window to solve it in. Re-run without --headless if this task " +
          "is likely to hit one."
      );
      return;
    }
    console.log(`\n>>> Human verification required at ${state.url} (${state.title})`);
    console.log(">>> Solve it in the browser window, then press Enter here to continue...");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      await rl.question("");
    } finally {
      rl.close();
    }
  };
}

async function runLoginSetup(options: CliOptions): Promise<number> {
  const browser = new BrowserController(
    defaultBrowserConfig({
      viewportWidth: options.viewportWidth,
      viewportHeight: options.viewportHeight,
      headless: false,
      userDataDir: options.profileDir
    })
  );
  try {
    await browser.start();
    await browser.navigate(options.loginUrl);
    console.log(`\n>>> A browser window is open at ${options.loginUrl}.`);
    console.log(`>>> Profile directory: ${options.profileDir}`);
    console.log(">>> Sign in to whatever sites your tasks will need. MFA only needs to happen");
    console.log(">>> once here — later --task runs reuse this same signed-in session.");
    console.log(">>> Press Enter here when you're done to close the browser and save the session.");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      await rl.question("");
    } finally {
      rl.close();
    }
  } catch (err) {
    console.error(`Login setup failed: ${(err as Error).message}`);
    return 2;
  } finally {
    await browser.close();
  }
  console.log("Session saved.");
  return 0;
}

async function runTask(options: CliOptions): Promise<number> {
  const browser = new BrowserController(
    defaultBrowserConfig({
      viewportWidth: options.viewportWidth,
      viewportHeight: options.viewportHeight,
      headless: options.headless,
      userDataDir: options.profileDir
    })
  );

  let result;
  try {
    await browser.start();
    try {
      const orchestrator = new AgentOrchestrator({
        task: options.task,
        browser,
        model: options.model,
        maxSteps: options.maxSteps,
        maxDurationSeconds: options.maxDuration,
        keepRecentImages: options.keepRecentImages,
        onHumanVerification: makeHumanVerificationHook(options.headless)
      });
      result = await orchestrator.run();
    } finally {
      await browser.close();
    }
  } catch (err) {
    console.error(`Agent could not start: ${(err as Error).message}`);
    return 2;
  }

  const status = result.success ? "SUCCESS" : "FAILURE";
  console.log(
    `Run finished: ${status} (reason=${result.terminationReason}, steps=${result.stepsTaken}, ` +
      `elapsed=${result.elapsedSeconds.toFixed(1)}s)`
  );
  console.log(`Summary: ${result.summary}`);
  return result.success ? 0 : 1;
}

async function main(): Promise<number> {
  let options: CliOptions;
  try {
    options = parseCliArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`Argument error: ${(err as Error).message}`);
    printUsage();
    return 2;
  }

  return options.login ? runLoginSetup(options) : runTask(options);
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("Unhandled error while running the agent.", err);
    process.exit(1);
  });
