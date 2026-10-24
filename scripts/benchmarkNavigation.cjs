/** Local fixture: pointer-driven CMS menu after more controls than the observation budget. */
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { chromium } = require('playwright');
const { BrowserController } = require('../dist/browserController');

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    const title = 'Local SEO Checklist for Small Businesses: 10 Steps to Get Found';
    await page.setContent(`<style>button{padding:6px;margin:3px}#toolbar{display:grid;grid-template-columns:repeat(10,1fr)}[hidden]{display:none!important}</style>
      <div id="toolbar">${Array.from({length:50},(_,i)=>`<button>Other control ${i+1}</button>`).join('')}</div>
      <table><tbody><tr><td><a title="${title}" href="#draft">${title}</a></td><td><button aria-haspopup="menu" id="actions">Actions</button></td></tr></tbody></table>
      <div id="menu" role="menu" hidden><button role="menuitem" id="edit">Edit draft</button></div>
      <section id="editor" hidden><h1>${title}</h1><input aria-label="Hero image" type="file"></section>
      <script>
        window.realActions=0;
        document.querySelector('#actions').addEventListener('pointerdown',event=>{if(event.button===0){document.querySelector('#menu').hidden=false;window.realActions++}});
        document.querySelector('#edit').addEventListener('click',()=>{document.querySelector('#menu').hidden=true;document.querySelector('#editor').hidden=false;window.realActions++});
      </script>`);
    const selector = `tr:has(a[title="${title}"]) button[aria-haspopup="menu"]`;
    // Reproduce why the former synthetic-click implementation needed repeated attempts/Tab.
    await page.locator(selector).evaluate(el=>el.click());
    assert.equal(await page.locator('#menu').isVisible(), false, 'Synthetic click should reproduce the closed-menu failure');
    const controller = new BrowserController({ maxElements: 40 });
    controller.ensureActivePage = async () => page;
    const start = performance.now();
    await controller.clickBySelectorOrText(selector);
    const state = await controller.captureState({ includeScreenshot: false });
    const edit = state.elements.find(el=>el.text==='Edit draft');
    assert.ok(edit, 'Open menu action must survive the 40-element observation cap');
    assert.equal(edit.markId, 1, 'Open menu must appear before table/toolbar noise');
    await controller.clickMark(edit.markId);
    assert.equal(await page.locator('#editor').isVisible(), true);
    assert.equal(await page.evaluate(()=>window.realActions), 2);
    assert.equal(await page.locator('#editor h1').textContent(), title);
    console.log(JSON.stringify({ task: 'Open the exact draft from a CMS table', browserActions: 2, observationsBetweenActions: 1, keyboardTabActions: 0, fullHtmlExtractions: 0, elapsedMs: Math.round(performance.now()-start) }));
    // Text targets must use native click too, without selecting a surrounding container.
    await page.evaluate(()=>{document.querySelector('#editor').hidden=true;document.querySelector('#menu').hidden=false});
    await controller.clickBySelectorOrText('Edit draft');
    assert.equal(await page.locator('#editor').isVisible(),true);
    console.log('PASS: native selector/text clicks and prioritized menu marks. Local fixture only; no live site modified.');
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1});
