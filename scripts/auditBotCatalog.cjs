/** Isolated UI audit: serves repo UI through Playwright routes; no real jobs, accounts or model calls. */
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const provenance = JSON.parse(fs.readFileSync(path.join(root, 'static/avatars/provenance.json'), 'utf8'));
const names = ['Inspired by Alex Hormozi', 'Inspired by Sabri Suby', 'Inspired by Addy Osmani', 'Inspired by Andrej Karpathy'];
(async () => {
  const browser = await chromium.launch({ headless: true });
  const errors = [];
  const feedback = [];
  async function open(roster = []) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1080 } });
    await context.addInitScript(value => {
      if (!localStorage.getItem('audit-initialized')) {
        localStorage.setItem('agentFireworksAgentsV2', JSON.stringify(value));
        localStorage.setItem('audit-initialized', '1');
      }
    }, roster);
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.hostname !== 'openbots.audit') return route.abort();
      if (url.pathname.startsWith('/api/')) {
        if (url.pathname === '/api/feedback') feedback.push(request.postDataJSON());
        const payload = url.pathname === '/api/usage' ? { totalEstimatedCostUsd: 0.0123, totalTokens: 100, byModel: [] }
          : url.pathname === '/api/auth/google/config' ? { enabled: false }
          : url.pathname === '/api/auth/google/session' ? { user: null }
          : url.pathname === '/api/feedback' ? { message: 'Correction saved — I’ll apply that guidance in future replies.' }
          : { isRunning: false, sessionMode: 'guest', models: [], schedules: [], workflows: [], suggestions: [], jobs: [], totals: {}, byModel: [], events: [] };
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify(payload) });
      }
      const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (!/^(index\.html|browserRuntime\.js|avatars\/[a-z0-9.-]+)$/.test(relative)) return route.fulfill({ status: 404, body: '' });
      const file = path.join(root, 'static', relative);
      if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
      const ext = path.extname(file);
      return route.fulfill({ contentType: { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml' }[ext], body: fs.readFileSync(file) });
    });
    const page = await context.newPage();
    page.on('pageerror', err => errors.push(err.message));
    await page.goto('http://openbots.audit/');
    await page.waitForSelector('.template-card[data-name="Inspired by Alex Hormozi"]', { state: 'attached' });
    return { page, context };
  }
  try {
    const { page, context } = await open();
    assert.equal(await page.locator('#agent-list .agent-row').count(), 0, 'Fresh roster must be empty');
    for (const name of names) {
      const card = page.locator('.template-card').filter({ has: page.locator('strong', { hasText: name }) });
      assert.equal(await card.count(), 1, name + ' appears exactly once');
      const image = card.locator('img');
      const source = provenance.find(item => item.botName === name);
      assert.ok(source, name + ' requires a named portrait source');
      assert.equal(await image.getAttribute('src'), '/avatars/' + source.file + '?v=' + source.sha256.slice(0, 12));
      assert.ok((await card.getAttribute('data-desc')).includes(name.replace('Inspired by ', '')), 'Role must name the matching inspiration');
      await image.evaluate(img => img.decode());
      assert.equal(await image.evaluate(img => img.naturalWidth > 0), true);
      assert.notEqual(await image.evaluate(img => getComputedStyle(img).transform), 'none', name + ' must use its headshot crop');
    }
    assert.equal(await page.locator('.template-grid').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length), 3);
    assert.equal(await page.locator('#settings-modal #observer-chip').count(), 1);
    assert.equal(await page.locator('#settings-modal #header-workflow-btn').count(), 1);
    assert.equal(await page.locator('#settings-modal #header-cost-chip').count(), 1);
    assert.equal(await page.locator('#new-agent-button .agent-avatar').evaluate(el => getComputedStyle(el).backgroundImage), 'none');
    assert.equal(await page.locator('#welcome-avatar .bot').evaluate(el => getComputedStyle(el).backgroundImage), 'none');
    await page.locator('#header-settings-btn').click();
    await page.waitForFunction(() => document.getElementById('header-cost-chip').textContent === '~$0.01');
    assert.equal(await page.locator('#header-cost-chip').isVisible(), true);
    assert.equal(await page.locator('#provider-credentials').getAttribute('open'), null);
    await page.locator('#settings-modal [data-close-modal="settings-modal"]').first().click();
    const out = process.env.OPENBOTS_AUDIT_SCREENSHOT || '/tmp/openbots-catalog-audit.png';
    await page.screenshot({ path: out, fullPage: true });
    await page.locator('#welcome-create-bot-btn').click();
    await page.locator('#bot-preset-select').selectOption({ label: 'Inspired by Alex Hormozi' });
    assert.equal(await page.locator('#bot-name-input').inputValue(), names[0]);
    assert.match(await page.locator('#bot-desc-input').inputValue(), /offers, pricing, acquisition, monetization, retention/);
    assert.match(await page.locator('#bot-modal-preview img').getAttribute('src'), /alex-hormozi\.webp\?v=/);
    await page.locator('#create-bot-submit-btn').click();
    assert.equal(await page.locator('#agent-list .agent-row').count(), 1);
    assert.equal(await page.locator('#agent-list .agent-name').textContent(), names[0]);
    assert.equal(await page.locator('#agent-list .agent-avatar').evaluate(el => getComputedStyle(el).width), '29px');
    await page.evaluate(() => sessionStorage.removeItem("openBotsSelectedBot"));
    await page.reload();
    await page.waitForSelector('.template-card[data-name="Inspired by Alex Hormozi"]', { state: 'attached' });
    assert.equal(await page.locator('#agent-list .agent-row').count(), 1);
    assert.equal(await page.locator('.template-card[data-name="Inspired by Alex Hormozi"]').isVisible(), false, 'Added bots must be hidden in the catalog');
    assert.equal(await page.locator('#bot-preset-select option[value="Inspired by Alex Hormozi"]').count(), 0, 'Added bots must be absent from onboarding dropdown');
    const visibleNames = await page.locator('.template-card[data-name]:visible').evaluateAll(cards => cards.map(card => card.dataset.name));
    assert.equal(visibleNames.includes(names[0]), false);
    await page.locator('#agent-list .agent-row').click();
    assert.equal(await page.locator('#agent-list .agent-row').count(), 1, 'Open added bot must not duplicate it');
    await page.locator('.fb-dislike').first().click();
    await page.locator('.fb-reason-input').fill('Consider the full discussion before answering.');
    await page.locator('.fb-send-dislike').click();
    await page.waitForFunction(() => !!document.querySelector('.msg-feedback-note'));
    assert.equal(feedback[0].kind, 'correction');
    assert.match(feedback[0].reason, /full discussion/);
    await page.locator('#agent-list .agent-row').hover();
    await page.waitForFunction(() => !document.getElementById("app").classList.contains("sidebar-collapsed"));
    await page.locator('#agent-list .agent-delete').click();
    assert.equal(await page.locator('.template-card[data-name="Inspired by Alex Hormozi"]').isVisible(), true, 'Deleting a bot restores its onboarding card');
    assert.equal(await page.locator('#bot-preset-select option[value="Inspired by Alex Hormozi"]').count(), 1);
    await context.close();
    const legacy = await open([
      { id: 'agent_123', name: 'The Value Architect', description: 'Keep my custom target of independent SaaS founders.', transcript: [{ role: 'user', html: 'Review my offer' }] },
      { id: 'agent_the_systems_architect', name: 'The Systems Architect', transcript: [] }
    ]);
    const saved = await legacy.page.evaluate(() => JSON.parse(localStorage.getItem('agentFireworksAgentsV2')));
    assert.equal(saved.length, 1, 'Unused automatic seed must stay out of sidebar');
    assert.equal(saved[0].id, 'agent_123');
    assert.equal(saved[0].name, names[0]);
    assert.match(saved[0].description, /independent SaaS founders/);
    assert.equal(saved[0].transcript.length, 1);
    await legacy.context.close();
    const many = await open(Array.from({ length: 40 }, (_, i) => ({ id: 'agent_' + i, name: 'My custom bot ' + i, transcript: [] })));
    await many.page.locator('#sidebar-collapse-btn').count().then(async count => {
      if (count && await many.page.locator('#sidebar-collapse-btn').isVisible()) {
        // Sidebar defaults may be collapsed at this viewport; expand with the real toggle.
        const collapsed = await many.page.locator('#app').evaluate(el => el.classList.contains('sidebar-collapsed'));
        if (collapsed) await many.page.locator('#sidebar-collapse-btn').click();
      }
    });
    assert.equal(await many.page.locator('#agent-list').evaluate(el => getComputedStyle(el).overflowY), 'auto');
    assert.equal(await many.page.locator('#agent-list').evaluate(el => el.scrollHeight > el.clientHeight), true);
    await many.context.close();
    assert.deepEqual(errors, [], 'UI should not throw JavaScript errors');
    console.log(JSON.stringify({ success: true, checks: ['fresh roster empty', 'four exact inspired-by names', 'all portraits decode with headshot crops', 'three columns', 'matching preset role', 'matching portrait preview', 'explicit onboarding only', '29px sidebar icons', 'reload persistence', 'no duplicates', 'correction feedback', 'legacy rename preserves custom instructions and history', 'unused automatic seeds hidden', 'settings-only observer/workflow/cost controls', 'flat welcome and new-bot icons', 'added bots hidden from catalog and dropdown', 'deleted bots available again', 'long sidebar scrolls', 'estimated dollars visible in settings', 'provider credentials collapsed'], screenshot: out }, null, 2));
  } finally { await browser.close(); }
})().catch(err => { console.error(err); process.exitCode = 1; });
