/**
 * Open Bots desktop shell — starts the local agent server and shows it in Electron.
 */
const { app, BrowserWindow, shell, Menu } = require("electron");
const { spawn } = require("node:child_process");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");

const PROJECT_ROOT = path.join(__dirname, "..");
// Defaults to the dev output (dist/). `yarn desktop:built` points this at build/ so the desktop
// shell can run the production copy instead.
const SERVER_ENTRY = path.resolve(
  PROJECT_ROOT,
  process.env.BROWSER_AGENT_SERVER_ENTRY || path.join("dist", "server.js")
);

let mainWindow = null;
let serverProcess = null;
let serverPort = null;

function findFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close((err) => (err ? reject(err) : resolve(port)));
    });
    probe.on("error", reject);
  });
}

function waitForServer(port, timeoutMs = 30000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const req = http.get({ host: "127.0.0.1", port, path: "/", timeout: 1500 }, (res) => {
        res.resume();
        resolve();
      });
      req.on("error", () => {
        if (Date.now() - started > timeoutMs) {
          reject(new Error("Open Bots server did not become ready in time."));
          return;
        }
        setTimeout(tryOnce, 250);
      });
      req.on("timeout", () => {
        req.destroy();
      });
    };
    tryOnce();
  });
}

function startServer(port) {
  serverProcess = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      BROWSER_AGENT_UI_PORT: String(port),
      BROWSER_AGENT_UI_HOST: "127.0.0.1",
      BROWSER_AGENT_NO_OPEN: "1",
      BROWSER_AGENT_LIVE_RELOAD: "0",
      // The desktop app is a built copy, so `/learn <task>` works here too. Set
      // BROWSER_AGENT_LEARN_MODE=0 to turn it off, BROWSER_AGENT_LEARN_SELF_FIX=0 for
      // findings without letting it patch its own source.
      BROWSER_AGENT_LEARN_MODE: process.env.BROWSER_AGENT_LEARN_MODE ?? "1"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  serverProcess.stdout.on("data", (chunk) => {
    process.stdout.write(`[server] ${chunk}`);
  });
  serverProcess.stderr.on("data", (chunk) => {
    process.stderr.write(`[server] ${chunk}`);
  });
  serverProcess.on("exit", (code, signal) => {
    if (!app.isQuitting) {
      console.error(`[server] exited unexpectedly (code=${code}, signal=${signal})`);
    }
    serverProcess = null;
  });
}

function stopServer() {
  if (!serverProcess) return;
  const child = serverProcess;
  serverProcess = null;
  try {
    child.kill("SIGTERM");
  } catch (_) {
    /* ignore */
  }
}

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: "Open Bots",
    backgroundColor: "#f8f9fb",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.loadURL(`http://127.0.0.1:${port}/`);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function buildMenu() {
  const isMac = process.platform === "darwin";
  const template = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" },
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" }
            ]
          }
        ]
      : []),
    {
      label: "File",
      submenu: [isMac ? { role: "close" } : { role: "quit" }]
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" }
      ]
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" }
      ]
    },
    {
      label: "Window",
      submenu: [{ role: "minimize" }, { role: "zoom" }, ...(isMac ? [{ type: "separator" }, { role: "front" }] : [])]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function boot() {
  buildMenu();
  // Attach to an already-running server (e.g. `npm run dev` on 8765) without spawning dist/.
  const attachExisting = process.env.BROWSER_AGENT_ATTACH_EXISTING === "1";
  serverPort = Number(process.env.BROWSER_AGENT_UI_PORT) || (attachExisting ? 8765 : await findFreePort());
  if (!attachExisting) {
    startServer(serverPort);
  }
  await waitForServer(serverPort);
  createWindow(serverPort);
}

app.whenReady().then(boot).catch((err) => {
  console.error(err);
  app.quit();
});

app.on("before-quit", () => {
  app.isQuitting = true;
  stopServer();
});

app.on("window-all-closed", () => {
  // On macOS closing the last window does NOT quit the app - the dock icon reopens it through
  // "activate" below. Stopping the server here therefore left that reopened window pointing at a
  // port with nothing listening on it. `before-quit` is what actually shuts the server down.
  if (process.platform === "darwin") return;
  stopServer();
  app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length !== 0 || !serverPort) return;
  // If the server died while the app sat in the dock, bring it back first - otherwise the reopened
  // window loads a dead port and looks like the app is broken.
  const attachExisting = process.env.BROWSER_AGENT_ATTACH_EXISTING === "1";
  if (!serverProcess && !attachExisting) {
    startServer(serverPort);
    waitForServer(serverPort)
      .then(() => createWindow(serverPort))
      .catch((err) => {
        console.error(`[server] could not be restarted: ${err.message}`);
        createWindow(serverPort);
      });
    return;
  }
  createWindow(serverPort);
});
