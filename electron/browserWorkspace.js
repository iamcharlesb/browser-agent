/** Desktop-owned browser workspace. Its lifetime is independent of the UI and agent server. */
const { randomUUID } = require("node:crypto");
const { createServer } = require("node:http");

function resolveBrowserUrl(value) {
  const input = String(value || "about:blank").trim();
  const target = input === "about:blank" || /^[a-z][a-z\d+.-]*:/i.test(input)
    ? input : input.includes(".") && !input.includes(" ")
      ? `https://${input}` : `https://www.google.com/search?q=${encodeURIComponent(input)}`;
  const parsed = new URL(target);
  if (!["http:", "https:"].includes(parsed.protocol) && target !== "about:blank") {
    throw new Error("Browser navigation supports HTTP, HTTPS, and about:blank.");
  }
  return target;
}

class BrowserWorkspace {
  constructor({ WebContentsView, session, onChange = () => {} }) {
    this.WebContentsView = WebContentsView;
    this.session = session;
    this.onChange = onChange;
    this.tabs = [];
    this.activeId = null;
    this.window = null;
    this.visible = false;
    this.bounds = { x: 0, y: 0, width: 0, height: 0 };
  }

  attach(window) {
    this.window = window;
    for (const tab of this.tabs) window.contentView.addChildView(tab.view);
    if (!this.tabs.length) this.newTab("about:blank");
    this.layout();
  }

  active() { return this.tabs.find(tab => tab.id === this.activeId); }

  snapshot() {
    return {
      activeTabId: this.activeId,
      tabs: this.tabs.map((tab, index) => ({
        id: tab.id, targetId: tab.view.webContents.getOrCreateDevToolsTargetId(), index, url: tab.view.webContents.getURL() || "about:blank",
        title: tab.view.webContents.getTitle() || "New Tab", active: tab.id === this.activeId,
        loading: tab.view.webContents.isLoading()
      }))
    };
  }

  changed() { this.onChange(this.snapshot()); }

  newTab(url, popupOptions = null) {
    const target = resolveBrowserUrl(url);
    const id = randomUUID();
    const view = new this.WebContentsView({ webPreferences: {
      ...popupOptions?.webPreferences,
      preload: undefined,
      session: this.session, contextIsolation: true, nodeIntegration: false, sandbox: true
    } });
    // Keep browser identity unmodified. Automation target IDs stay on the private broker.
    const tab = { id, view };
    this.tabs.push(tab);
    this.activeId = id;
    this.window?.contentView.addChildView(view);
    for (const event of ["did-navigate", "did-navigate-in-page", "page-title-updated", "did-start-loading", "did-stop-loading"]) {
      view.webContents.on(event, () => this.changed());
    }
    view.webContents.on("will-navigate", (event, url) => {
      try { resolveBrowserUrl(url); } catch { event.preventDefault(); }
    });
    view.webContents.setWindowOpenHandler(({ url }) => {
      try { resolveBrowserUrl(url); } catch { return { action: "deny" }; }
      // Electron performs popup navigation itself, preserving opener/postMessage and POST data.
      return { action: "allow", createWindow: options => this.newTab(url, options).view.webContents };
    });
    view.webContents.on("destroyed", () => {
      if (this.tabs.includes(tab)) this.removeTab(tab);
    });
    if (!popupOptions) void view.webContents.loadURL(target).catch(() => this.changed());
    this.layout();
    this.changed();
    return tab;
  }

  layout() {
    for (const tab of this.tabs) {
      tab.view.setBounds(this.visible && tab.id === this.activeId
        ? this.bounds : { x: 0, y: 0, width: 0, height: 0 });
    }
  }

  setBounds(bounds) {
    const safe = {};
    for (const key of ["x", "y", "width", "height"]) {
      const value = Number(bounds?.[key]);
      safe[key] = Number.isFinite(value) ? Math.max(0, Math.min(20000, Math.round(value))) : 0;
    }
    this.bounds = safe;
    this.layout();
  }

  async command(input) {
    const type = input?.type;
    let tab = this.active();
    if (type === "new_tab") {
      this.newTab(input.url);
    } else if (type === "switch_tab" || type === "close_tab") {
      const target = this.tabs[Number(input.index)];
      if (!target) throw new Error("Browser tab no longer exists.");
      if (type === "switch_tab") this.activeId = target.id;
      else {
        this.removeTab(target);
      }
    } else {
      if (!tab) tab = this.newTab("about:blank");
      const wc = tab.view.webContents;
      if (type === "navigate") await wc.loadURL(resolveBrowserUrl(input.url));
      else if (type === "back") { if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack(); }
      else if (type === "forward") { if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward(); }
      else if (type === "reload") wc.reload();
      else throw new Error("Unsupported browser workspace command.");
    }
    this.layout();
    this.changed();
    return this.snapshot();
  }

  removeTab(tab) {
    const index = this.tabs.indexOf(tab);
    this.tabs = this.tabs.filter(item => item !== tab);
    this.window?.contentView.removeChildView(tab.view);
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    if (this.activeId === tab.id) this.activeId = this.tabs[Math.min(index, this.tabs.length - 1)]?.id || null;
    if (!this.tabs.length && this.window) this.newTab("about:blank");
    this.layout();
    this.changed();
  }

  dispose() {
    const tabs = this.tabs;
    this.tabs = [];
    for (const tab of tabs) {
      this.window?.contentView.removeChildView(tab.view);
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    }
    this.tabs = [];
    this.activeId = null;
    this.window = null;
  }
}

/** Private loopback control plane for the agent process; never exposed to visited pages. */
async function startBrowserBroker(workspace) {
  const token = randomUUID();
  const server = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    if (req.headers.authorization !== `Bearer ${token}` || req.headers.origin) {
      res.writeHead(403).end(JSON.stringify({ detail: "Forbidden" }));
      return;
    }
    try {
      if (req.method === "GET" && req.url === "/state") {
        res.end(JSON.stringify(workspace.snapshot()));
      } else if (req.method === "POST" && req.url === "/command") {
        let raw = "";
        for await (const chunk of req) {
          raw += chunk;
          if (raw.length > 8192) throw new Error("Command too large.");
        }
        res.end(JSON.stringify(await workspace.command(JSON.parse(raw))));
      } else res.writeHead(404).end(JSON.stringify({ detail: "Not found" }));
    } catch (error) { res.writeHead(400).end(JSON.stringify({ detail: error.message })); }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { server, token, url: `http://127.0.0.1:${server.address().port}` };
}

module.exports = { BrowserWorkspace, resolveBrowserUrl, startBrowserBroker };
