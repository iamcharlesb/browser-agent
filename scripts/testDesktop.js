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
  const fixture = http.createServer((req, res) => res.end('<html><head><title>Workspace fixture</title></head><body><input id="draft"><section contenteditable="true"><h3 data-placeholder="Article title"><br></h3><p data-placeholder="Story body"><br></p></section><a target="_blank" href="/popup">Popup</a></body></html>'));
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
    ui.setDefaultTimeout(15000);
    ui.setDefaultNavigationTimeout(15000);
    await ui.waitForTimeout(600);
    await ui.locator('#toggle-browser-btn').click();
    await ui.locator('#browser-expand-btn').click();
    await ui.waitForFunction(() => {
      const panel = document.querySelector('#browser-panel').getBoundingClientRect();
      return document.querySelector('#app').classList.contains('browser-focus') && panel.width >= innerWidth - 1;
    });
    assert.equal(await ui.locator('#browser-expand-btn').getAttribute('aria-pressed'), 'true');
    assert.equal(await ui.locator('#conversation').isVisible(), false);
    await ui.keyboard.press('Escape');
    await ui.waitForFunction(() => !document.querySelector('#app').classList.contains('browser-focus'));
    // Keep a full-width text row and docked composer at different split widths.
    console.log('Checking composer layout.');
    for (const width of ['360px', '38%', '65%']) {
      await ui.evaluate(width => document.querySelector('#workspace').style.setProperty('--chat-width', width), width);
      await ui.waitForTimeout(150);
      const measure = () => ui.evaluate(() => {
        const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return {y:r.y,width:r.width,height:r.height,bottom:r.bottom,right:r.right}; };
        return {composer:rect('#composer'), prompt:rect('#prompt'), toolbar:rect('.composer-toolbar'), send:rect('#send-button')};
      });
      const empty = await measure();
      assert.ok(empty.prompt.width >= empty.composer.width - 24, 'Input spans the composer width');
      assert.ok(empty.toolbar.y >= empty.prompt.bottom, 'Controls sit below the input');
      assert.ok(empty.send.right <= empty.composer.right, 'Send stays within the composer');
      await ui.locator('#prompt').fill('hi');
      assert.ok(Math.abs((await measure()).composer.bottom - empty.composer.bottom) < 2, 'Typing does not move the composer');
      await ui.locator('#prompt').fill(('A long message with several words and line breaks.\n').repeat(30));
      assert.ok((await measure()).prompt.height <= 160, 'Long drafts have a bounded height');
      assert.ok(await ui.locator('#prompt').evaluate(el => el.scrollHeight > el.clientHeight), 'Long drafts scroll internally');
      await ui.locator('#prompt').fill('');
      assert.equal((await measure()).prompt.height, 44, 'Clearing restores the compact input');
    }
    console.log('Composer layout passed.');
    await ui.evaluate(() => document.querySelector('#workspace').style.removeProperty('--chat-width'));
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
    console.log('Attaching agent.');
    const response = await ui.request.post(origin + '/api/login', {data:{url:'about:blank',mode:'embedded'}});
    const login = await response.json();
    assert.equal(response.status(), 200, JSON.stringify(login));
    assert.equal(login.url, url + '/');
    assert.equal(login.tabs.length, 2);
    const resized = await ui.request.post(origin + '/api/login/input', {data:{type:'resize',width:980,height:1240}});
    assert.equal(resized.status(), 200, await resized.text());
    assert.deepEqual(await target.evaluate(() => ({width:innerWidth,height:innerHeight})), {width:980,height:1240});
    assert.equal(await target.locator('#draft').inputValue(), 'keep this unsaved text');
    console.log('Checking editor.');
    // Medium-style inherited editable blocks must be targetable without wiping each other.
    const {BrowserController} = require(path.join(projectRoot, 'dist/browserController'));
    const editor = new BrowserController({viewportWidth:980,viewportHeight:1240});
    editor.page = target;
    let observation = await editor.captureState();
    assert.ok(observation.screenshotB64.length > 0, 'Page capture returns an image');
    const titleMark = observation.elements.find(el => el.text === 'Article title');
    assert.ok(titleMark, 'Rich editor title has its own mark');
    await editor.typeMark(titleMark.markId, 'Buddy Bot Code');
    observation = await editor.captureState({includeScreenshot:false});
    const bodyMark = observation.elements.find(el => el.text === 'Story body');
    assert.ok(bodyMark, 'Rich editor body has its own mark');
    await editor.typeMark(bodyMark.markId, 'An unpublished article body.');
    await editor.keyPress('END');
    assert.equal(await target.locator('h3').innerText(), 'Buddy Bot Code');
    assert.equal(await target.locator('section p').innerText(), 'An unpublished article body.');
    console.log('Checking switching.');
    // Agent tab switch uses the desktop-owned tab model, not arbitrary CDP pages.
    const switched = await ui.request.post(origin + '/api/login/input', {data:{type:'switch_tab',index:0}});
    assert.equal(switched.status(), 200, await switched.text());
    state = await ui.evaluate(() => window.openBotsDesktop.getBrowserState());
    assert.equal(state.tabs[0].active, true);
    await ui.evaluate(() => window.openBotsDesktop.browserCommand({type:'switch_tab',index:1}));
    assert.equal(await target.locator('#draft').inputValue(), 'keep this unsaved text');
    console.log('Checking popup.');
    // Genuine popups retain their opener while being docked as workspace tabs.
    await target.evaluate(() => { window.open('/popup', 'workspace-popup'); });
    await ui.waitForFunction(() => window.openBotsDesktop.getBrowserState().then(state => state.tabs.length === 3));
    const popup = cdp.contexts().flatMap(context => context.pages()).find(page => page.url() === url + '/popup');
    assert.ok(popup, 'Popup is exposed as a desktop-owned CDP tab');
    await popup.waitForLoadState();
    assert.equal(await popup.evaluate(() => Boolean(window.opener)), true);
    state = await ui.evaluate(() => window.openBotsDesktop.getBrowserState());
    assert.equal(state.tabs.length, 3);
    await ui.evaluate(() => window.openBotsDesktop.browserCommand({type:'switch_tab',index:1}));
    console.log('Checking backend restart.');
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
    await ui.reload();
    await ui.waitForFunction(() => window.openBotsDesktop && document.querySelector('#header-new-btn'));
    await ui.waitForTimeout(400);
    console.log('Checking chat owner.');
    // A delayed result must stay with its requesting bot after the user switches chats.
    await ui.route('**/api/run', route => { console.log('Mock run requested.'); return route.fulfill({json:{status:'started'}}); });
    let finishMockRun;
    const resultGate = new Promise(resolve => { finishMockRun = resolve; });
    await ui.route('**/api/events?*', async route => {
      await resultGate;
      await route.fulfill({contentType:'text/event-stream', body:'id: 999\ndata: ' + JSON.stringify({type:'terminal',success:true,summary:'Writer draft result stays here.',reason:'direct_reply'}) + '\n\n'});
    });
    const createBot = async name => {
      await ui.locator('#header-new-btn').click();
      await ui.locator('#create-bot-modal').waitFor({state:'visible'});
      await ui.locator('#bot-name-input').fill(name);
      await ui.locator('#create-bot-submit-btn').click();
    };
    await createBot('Writer regression');
    await ui.locator('#prompt').fill('Prepare an article outline.');
    await ui.locator('#send-button').click();
    console.log('Run UI:', await ui.locator('#status').innerText(), errors);
    await ui.waitForFunction(() => document.querySelector('#stop-run-btn') && !document.querySelector('#stop-run-btn').hidden);
    await createBot('Community regression');
    finishMockRun();
    await ui.waitForFunction(() => document.querySelector('#status').textContent === 'Answered directly');
    assert.equal(await ui.locator('#messages').innerText().then(text => text.includes('Writer draft result stays here.')), false);
    await ui.locator('.agent-row').filter({hasText:'Writer regression'}).click();
    assert.ok((await ui.locator('#messages').innerText()).includes('Writer draft result stays here.'));
    assert.deepEqual(errors, []);
    console.log('PASS: full-window browser layout and Escape restore, responsive page viewport preserves drafts, native tabs survive reload/restart, agent tab selection, and popup opener.');
  } finally {
    if (cdp) await cdp.close();
    if (app) await app.close();
    fixture.closeAllConnections();
    await new Promise(resolve => fixture.close(resolve));
    fs.rmSync(userData, {recursive:true, force:true});
  }
})().catch(error => {console.error(error); process.exitCode=1;});
