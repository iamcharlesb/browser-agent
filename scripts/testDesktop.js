const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const projectRoot = path.join(__dirname, '..');
const { _electron, chromium } = require(path.join(projectRoot, 'node_modules/playwright'));
async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return port;
}
(async () => {
  const uiPort = await freePort();
  let cdpPort = await freePort();
  while (cdpPort === uiPort) cdpPort = await freePort();
  const origin = `http://127.0.0.1:${uiPort}`;
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'openbots-workspace-'));
  fs.mkdirSync(userData + '/runtime');
  fs.cpSync(path.join(projectRoot, 'dist'), userData + '/runtime/dist', {recursive:true});
  fs.symlinkSync(path.join(projectRoot, 'node_modules'), userData + '/runtime/node_modules');
  fs.symlinkSync(path.join(projectRoot, 'static'), userData + '/runtime/static');
  const main = path.join(projectRoot, 'electron/main.js');
  const harness = userData + '/main.cjs';
  fs.writeFileSync(harness, `require('electron').app.setPath('userData', ${JSON.stringify(userData)}); require(${JSON.stringify(main)});`);
  const fixture = http.createServer((req, res) => res.end('<html><head><title>Workspace fixture</title></head><body><input id="draft"><a target="_blank" href="/popup">Popup</a></body></html>'));
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + fixture.address().port;
  let app;
  let cdp;
  try {
    const env = {...process.env, BROWSER_AGENT_UI_PORT:String(uiPort), OPEN_BOTS_ELECTRON_CDP_PORT:String(cdpPort), BROWSER_AGENT_LEARN_MODE:'0', BROWSER_AGENT_MANAGED_CHROME:'0', BROWSER_AGENT_SERVER_ENTRY:userData + '/runtime/dist/server.js', BROWSER_AGENT_LIVE_RELOAD:'1'};
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.BROWSER_AGENT_ATTACH_EXISTING;
    app = await _electron.launch({ executablePath: require(path.join(projectRoot, 'node_modules/electron')), args: [harness], cwd: projectRoot, env, timeout:30000 });
    app.process().stderr.on('data', chunk => { if (String(chunk).includes('Error')) process.stderr.write(chunk); });
    console.log("Electron launched.");
    await app.firstWindow();
    let ui;
    for (let attempt = 0; attempt < 100; attempt++) {
      ui = app.context().pages().find(page => page.url().startsWith(origin));
      if (ui) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ui, 'Workspace renderer was created');
    const errors = [];
    ui.on('pageerror', error => errors.push(error.message));
    console.log("Window URL:", ui.url());
    await ui.waitForFunction(() => window.openBotsDesktop && document.querySelector('#toggle-browser-btn'));
    await ui.waitForTimeout(600);
    await ui.evaluate(() => window.openBotsDesktop.browserCommand({type:'navigate',url:'about:blank'}));
    await ui.evaluate(url => window.openBotsDesktop.browserCommand({type:'new_tab',url}), url);
    let state = await ui.evaluate(() => window.openBotsDesktop.getBrowserState());
    assert.equal(state.tabs.length, 2);
    cdp = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
    let target;
    for (const page of cdp.contexts().flatMap(context => context.pages())) {
      if (page.url().startsWith(url)) target = page;
    }
    assert.ok(target, 'Native tab is present in the same Electron context');
    await target.locator('#draft').fill('keep this unsaved text');
    const activeId = state.activeTabId;
    await ui.reload();
    await ui.waitForFunction(() => window.openBotsDesktop && window.OpenBotsBrowserRuntime);
    state = await ui.evaluate(() => window.openBotsDesktop.getBrowserState());
    assert.equal(state.activeTabId, activeId);
    assert.equal(await target.locator('#draft').inputValue(), 'keep this unsaved text');
    // Agent attaches to the selected native tab without replacing it.
    const response = await ui.request.post(origin + '/api/login', {data:{url:'about:blank',mode:'embedded'}});
    const login = await response.json();
    assert.equal(response.status(), 200, JSON.stringify(login));
    assert.equal(login.url, url + '/');
    assert.equal(login.tabs.length, 2);
    // Agent tab switch uses the desktop-owned tab model, not arbitrary CDP pages.
    const switched = await ui.request.post(origin + '/api/login/input', {data:{type:'switch_tab',index:0}});
    assert.equal(switched.status(), 200, await switched.text());
    state = await ui.evaluate(() => window.openBotsDesktop.getBrowserState());
    assert.equal(state.tabs[0].active, true);
    await ui.evaluate(() => window.openBotsDesktop.browserCommand({type:'switch_tab',index:1}));
    assert.equal(await target.locator('#draft').inputValue(), 'keep this unsaved text');
    // Genuine popups retain their opener while being docked as workspace tabs.
    const popupPromise = target.waitForEvent('popup');
    await target.evaluate(() => window.open('/popup', 'workspace-popup'));
    const popup = await popupPromise;
    await popup.waitForLoadState();
    assert.equal(await popup.evaluate(() => Boolean(window.opener)), true);
    state = await ui.evaluate(() => window.openBotsDesktop.getBrowserState());
    assert.equal(state.tabs.length, 3);
    await ui.evaluate(() => window.openBotsDesktop.browserCommand({type:'switch_tab',index:1}));
    // Restart only the watched server using an isolated copy of the built modules.
    fs.appendFileSync(userData + '/runtime/dist/desktopBrowser.js', '\n// smoke restart\n');
    let restarted = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      try {
        const response = await fetch(origin + '/api/status');
        const status = await response.json();
        if (!status.hasBrowserSession) { restarted = true; break; }
      } catch {}
    }
    assert.equal(restarted, true, 'Watched agent server restarted independently');
    assert.equal(await target.locator('#draft').inputValue(), 'keep this unsaved text');
    await ui.waitForFunction(() => window.openBotsDesktop);
    state = await ui.evaluate(() => window.openBotsDesktop.getBrowserState());
    assert.equal(state.tabs.length, 3);
    assert.deepEqual(errors, []);
    console.log('PASS: native tabs, draft survives UI reload AND backend restart, agent controls selected tab, and docked popups retain opener.');
  } finally {
    if (cdp) await cdp.close();
    if (app) await app.close();
    fixture.closeAllConnections();
    await new Promise(resolve => fixture.close(resolve));
    fs.rmSync(userData, {recursive:true, force:true});
  }
})().catch(error => {console.error(error); process.exitCode=1;});
