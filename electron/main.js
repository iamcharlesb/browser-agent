/**
 * OpenBuddy desktop shell — starts the local agent server and shows it in Electron.
 * Default browsing surface: docked WebContentsView (in-app), driven via Electron CDP.
 * Optional escape hatch: external Connected Chrome on port 9222 (handled by the agent server).
 */
const { app, BrowserWindow, WebContentsView, session, shell, Menu, ipcMain, nativeImage } = require("electron");
const { spawn } = require("node:child_process");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { BrowserWorkspace, startBrowserBroker } = require("./browserWorkspace");
const { getExternalGoogleSignInAppUrl, buildDesktopGoogleSignInUrl } = require("./googleSignIn");

const PROJECT_ROOT = path.join(__dirname, "..");
// Defaults to the dev output (dist/). `yarn desktop:built` points this at build/ so the desktop
// shell can run the production copy instead.
const SERVER_ENTRY = path.resolve(
  PROJECT_ROOT,
  process.env.BROWSER_AGENT_SERVER_ENTRY || path.join("dist", "server.js")
);

/** Dedicated Electron CDP port — not 9222, to avoid colliding with Connected Chrome. */
const ELECTRON_CDP_PORT = Number(process.env.OPEN_BOTS_ELECTRON_CDP_PORT) || 9333;

// Must be set before app ready so Playwright can connectOverCDP to this process.
app.commandLine.appendSwitch("remote-debugging-port", String(ELECTRON_CDP_PORT));

let mainWindow = null;
let browserWorkspace = null;
let browserBroker = null;
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

function isPortFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => {
      probe.close(() => resolve(true));
    });
  });
}

/** Prefer a stable UI port so Google OAuth Authorized JavaScript origins stay valid. */
async function resolveServerPort(attachExisting) {
  // Dev (live reload / attach to `yarn dev`) → 8765; production desktop:built → 8766.
  const liveReload = process.env.BROWSER_AGENT_LIVE_RELOAD === "1";
  const preferred =
    Number(process.env.BROWSER_AGENT_UI_PORT) ||
    (attachExisting || liveReload ? 8765 : 8766);
  if (attachExisting) return preferred;
  if (await isPortFree(preferred)) return preferred;
  const fallback = await findFreePort();
  console.warn(
    `[desktop] Port ${preferred} is busy; using http://127.0.0.1:${fallback}. ` +
      `Add that origin to Google Cloud → Credentials → Authorized JavaScript origins, or free port ${preferred}.`
  );
  return fallback;
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
          reject(new Error("OpenBuddy server did not become ready in time."));
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
  // `BROWSER_AGENT_LIVE_RELOAD=1` (desktop:dev) uses Node --watch so dist/ rebuilds restart the server.
  const liveReload = process.env.BROWSER_AGENT_LIVE_RELOAD === "1";
  const nodeArgs = liveReload ? ["--watch", SERVER_ENTRY] : [SERVER_ENTRY];
  serverProcess = spawn(process.execPath, nodeArgs, {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      BROWSER_AGENT_UI_PORT: String(port),
      BROWSER_AGENT_UI_HOST: "127.0.0.1",
      BROWSER_AGENT_NO_OPEN: "1",
      BROWSER_AGENT_LIVE_RELOAD: liveReload ? "1" : "0",
      // Desktop defaults to the in-app / embedded browser (Electron CDP), not the user's Chrome.
      OPEN_BOTS_EMBEDDED: "1",
      OPEN_BOTS_BROWSER_BROKER_URL: browserBroker?.url || "",
      OPEN_BOTS_BROWSER_BROKER_TOKEN: browserBroker?.token || "",
      OPEN_BOTS_ELECTRON_CDP_PORT: String(ELECTRON_CDP_PORT),
      OPEN_BOTS_ELECTRON_CDP_ENDPOINT: `http://127.0.0.1:${ELECTRON_CDP_PORT}`,
      OPEN_BOTS_UI_ORIGIN: `http://127.0.0.1:${port}`,
      BROWSER_AGENT_EMBEDDED_CDP_ENDPOINT: `http://127.0.0.1:${ELECTRON_CDP_PORT}`,
      // Production desktop (`desktop:built`) defaults learn mode on. Dev desktop leaves it
      // off unless set (see scripts/desktopDev.js). Override with BROWSER_AGENT_LEARN_MODE.
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

function ensureBrowserWorkspace() {
  if (!browserWorkspace) {
    browserWorkspace = new BrowserWorkspace({
      WebContentsView,
      session: session.fromPartition("persist:open-bots"),
      onChange(state) {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("workspace:browser-state", state);
      }
    });
  }
  return browserWorkspace;
}

function isWorkspaceSender(event) {
  return Boolean(mainWindow && event.sender === mainWindow.webContents &&
    event.senderFrame === mainWindow.webContents.mainFrame);
}

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: "OpenBuddy",
    icon: path.join(PROJECT_ROOT, "static", "open-bots-icon.png"),
    show: false,
    ...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 14, y: 16 } } : {}),
    backgroundColor: "#f8f9fb",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow.maximize();
    mainWindow.show();
  });
  mainWindow.loadURL(`http://127.0.0.1:${port}/`);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const externalGoogleSignInUrl = getExternalGoogleSignInAppUrl(url, `http://127.0.0.1:${port}`);
    shell.openExternal(externalGoogleSignInUrl || url);
    return { action: "deny" };
  });

  // Create the Live Browser target early so Playwright can find it (not the UI webContents).
  ensureBrowserWorkspace().attach(mainWindow);

  mainWindow.webContents.on("did-start-loading", () => {
    if (browserWorkspace) { browserWorkspace.visible = false; browserWorkspace.layout(); }
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin !== `http://127.0.0.1:${port}`) event.preventDefault();
  });

  mainWindow.on("resize", () => {
    browserWorkspace?.layout();
  });

  mainWindow.on("close", () => browserWorkspace?.dispose());
  mainWindow.on("closed", () => { mainWindow = null; });
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

ipcMain.on("live-browser:bounds", (event, bounds) => {
  if (isWorkspaceSender(event)) browserWorkspace?.setBounds(bounds);
});
ipcMain.on("live-browser:visible", (event, visible) => {
  if (!isWorkspaceSender(event) || !browserWorkspace) return;
  browserWorkspace.visible = Boolean(visible);
  browserWorkspace.layout();
});
ipcMain.handle("workspace:browser-state", (event) => {
  if (!isWorkspaceSender(event)) throw new Error("Untrusted workspace sender.");
  return ensureBrowserWorkspace().snapshot();
});
ipcMain.handle("workspace:browser-command", (event, input) => {
  if (!isWorkspaceSender(event)) throw new Error("Untrusted workspace sender.");
  return ensureBrowserWorkspace().command(input);
});
ipcMain.handle("auth:google-sign-in", async (event, handoff) => {
  if (!isWorkspaceSender(event)) throw new Error("Untrusted workspace sender.");
  const nonce = typeof handoff?.nonce === "string" ? handoff.nonce : "";
  const verifier = typeof handoff?.handoffVerifier === "string" ? handoff.handoffVerifier : "";
  const url = buildDesktopGoogleSignInUrl(serverPort, nonce);
  if (!url || !/^[a-f0-9]{48,128}$/i.test(verifier)) {
    throw new Error("Could not prepare secure Google sign-in.");
  }
  await shell.openExternal(url);
});

async function boot() {
  if (process.platform === "darwin" && app.dock) {
    const icon = nativeImage.createFromPath(path.join(PROJECT_ROOT, "static", "open-bots-icon.png"));
    if (!icon.isEmpty()) app.dock.setIcon(icon);
  }
  buildMenu();
  // Attach to an already-running server (e.g. `npm run dev` on 8765) without spawning dist/.
  const attachExisting = process.env.BROWSER_AGENT_ATTACH_EXISTING === "1";
  serverPort = await resolveServerPort(attachExisting);
  console.log(`[desktop] UI origin for Google sign-in: http://127.0.0.1:${serverPort}`);
  browserBroker = await startBrowserBroker(ensureBrowserWorkspace());
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
  browserWorkspace?.dispose();
  browserBroker?.server.close();
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
