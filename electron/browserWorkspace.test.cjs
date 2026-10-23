const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { BrowserWorkspace, resolveBrowserUrl } = require("./browserWorkspace");

function fixture() {
  class View {
    constructor(options) {
      this.options = options;
      this.webContents = new EventEmitter();
      Object.assign(this.webContents, {
        url: "", title: "", destroyed: false, targetId: require("node:crypto").randomUUID(),
        getOrCreateDevToolsTargetId() { return this.targetId; },
        getURL() { return this.url; }, getTitle() { return this.title; },
        isLoading() { return false; }, isDestroyed() { return this.destroyed; },
        setUserAgent(ua) { this.ua = ua; },
        setWindowOpenHandler(handler) { this.popup = handler; },
        async loadURL(url) { this.url = url; this.emit("did-navigate"); },
        close() { this.destroyed = true; }
      });
    }
    setBounds(bounds) { this.bounds = bounds; }
  }
  const children = new Set();
  const window = { contentView: { addChildView(view) { children.add(view); }, removeChildView(view) { children.delete(view); } } };
  const workspace = new BrowserWorkspace({ WebContentsView: View, session: { getUserAgent: () => "Browser" } });
  workspace.attach(window);
  workspace.visible = true;
  workspace.setBounds({ x: 20, y: 30, width: 800, height: 600 });
  return { workspace, children };
}

test("tabs retain separate native views and only the selected tab is painted", async () => {
  const { workspace } = fixture();
  const first = workspace.active();
  first.view.webContents.pageState = "draft text";
  await workspace.command({ type: "new_tab", url: "https://example.com" });
  assert.equal(workspace.snapshot().tabs.length, 2);
  assert.equal(first.view.bounds.width, 0);
  assert.equal(workspace.active().view.bounds.width, 800);
  await workspace.command({ type: "switch_tab", index: 0 });
  assert.equal(workspace.active(), first);
  assert.equal(first.view.webContents.pageState, "draft text");
  assert.equal(first.view.webContents.ua, undefined, "internal automation IDs must not be sent to sites in the user agent");
  assert.equal(workspace.snapshot().tabs[0].targetId, first.view.webContents.targetId);
});

test("UI refresh and pane hiding change bounds without reloading or destroying pages", async () => {
  const { workspace } = fixture();
  await workspace.command({ type: "navigate", url: "https://example.com/path" });
  const tab = workspace.active();
  workspace.visible = false;
  workspace.layout();
  workspace.visible = true;
  workspace.layout();
  assert.equal(workspace.active(), tab);
  assert.equal(tab.view.webContents.url, "https://example.com/path");
  assert.equal(tab.view.webContents.destroyed, false);
});

test("closing the last tab leaves a usable blank tab and destroys removed webContents", async () => {
  const { workspace, children } = fixture();
  const old = workspace.active();
  await workspace.command({ type: "close_tab", index: 0 });
  assert.equal(old.view.webContents.destroyed, true);
  assert.equal(children.size, 1);
  assert.equal(workspace.snapshot().tabs[0].url, "about:blank");
  workspace.dispose();
  assert.equal(children.size, 0);
});

test("popups become native tabs and unsupported schemes cannot enter the workspace", () => {
  const { workspace } = fixture();
  const popup = workspace.active().view.webContents.popup({ url: "https://example.com/popup" });
  assert.equal(popup.action, "allow");
  const contents = popup.createWindow({ webPreferences: {} });
  assert.equal(contents, workspace.active().view.webContents);
  assert.equal(workspace.snapshot().tabs.length, 2);
  workspace.active().view.webContents.popup({ url: "file:///etc/passwd" });
  assert.equal(workspace.snapshot().tabs.length, 2);
  for (const url of ["javascript:alert(1)", "file:///tmp/a", "data:text/html,hello"]) {
    assert.throws(() => resolveBrowserUrl(url));
  }
  assert.equal(resolveBrowserUrl("example.com"), "https://example.com");
});

test("bounds reject non-finite values before reaching native layout", () => {
  const { workspace } = fixture();
  workspace.setBounds({ x: -4, y: Infinity, width: NaN, height: 999999 });
  assert.deepEqual(workspace.bounds, { x: 0, y: 0, width: 0, height: 20000 });
});
