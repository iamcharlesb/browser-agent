import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { RESPONSE_STYLE } from './responseStyle';
const html=readFileSync(join(__dirname,'..','static','index.html'),'utf8');
const script=readFileSync(join(__dirname,'..','static','responseMarkdown.js'),'utf8');
const scope: any={}; vm.createContext(scope); vm.runInContext(script,scope);
const format=(text:string):string=>scope.OpenBotsMarkdown.format(text);

test('response markdown uses paragraphs and semantic lists without surplus layout breaks',()=>{
  const rendered=format('The answer comes first.\nThis is the same paragraph.\n\n## Evidence\n\n1. Inspect the source\n2. Run the tests\n\nA final paragraph.');
  assert.match(rendered,/<p>The answer comes first\. This is the same paragraph\.<\/p>/);
  assert.match(rendered,/<h2>Evidence<\/h2><ol><li>Inspect the source<\/li><li>Run the tests<\/li><\/ol>/);
  assert.doesNotMatch(rendered,/<br>/);
});
test('fenced and inline code preserve literal whitespace, symbols, hyphens and markdown characters',()=>{
  const code='  const marker = "**not bold**";\n\n  console.log("--dry-run", marker);';
  const rendered=format('```ts\n'+code+'\n```\n\nUse `node --test` to verify.');
  assert.match(rendered,/<code>  const marker = &quot;\*\*not bold\*\*&quot;;\n\n  console.log/);
  assert.doesNotMatch(rendered,/<strong>not bold/);
  assert.match(rendered,/<code>node --test<\/code>/);
  assert.match(rendered,/class="copy-code"/);
  assert.equal((rendered.match(/<pre>/g)||[]).length,1);
});
test('mixed nested lists retain list types and numbered starting values',()=>{
  const rendered=format('3. First step\n   * Evidence\n   * Verification\n4. Next step');
  assert.match(rendered,/<ol start="3"><li>First step<ul><li>Evidence<\/li><li>Verification<\/li><\/ul><\/li><li>Next step/);
});
test('tables, quotes and artifact previews are structured and links cannot inject HTML',()=>{
  assert.match(format('| Option | Result |\n| --- | --- |\n| Local | Fast |'),/<table><thead><tr><th scope="col">Option/);
  assert.match(format('> Verified result'),/<blockquote><div class="reply-content"><p>Verified result/);
  assert.match(format('![Preview](sandbox:/api/artifacts/report.png)'),/<img loading="lazy" referrerpolicy="no-referrer" src="\/api\/artifacts\/report.png"/);
  assert.match(format('[![Product photo](https://cdn.example.com/item.jpg)](https://shop.example.com/item)'),/<a href="https:\/\/shop\.example\.com\/item" target="_blank" rel="noopener noreferrer"><img loading="lazy" referrerpolicy="no-referrer" src="https:\/\/cdn\.example\.com\/item\.jpg" alt="Product photo"><\/a>/);
  assert.match(format('See docs (https://www.postgresql.org/docs/18/sql-select.html).'),/\(<a href="https:\/\/www\.postgresql\.org\/docs\/18\/sql-select\.html" target="_blank" rel="noopener noreferrer">https:\/\/www\.postgresql\.org\/docs\/18\/sql-select\.html<\/a>\)\./);
  assert.match(format('```html\n<h1>Hi</h1>\n```'),/class="preview-code"/);
  const hostile=format('<script>alert(1)</script>\n\n[x](javascript:alert(1))\n\n![x](https://example.com/\"onerror=evil)');
  assert.doesNotMatch(hostile,/<script>|href="javascript:|src="https:[^"]*"onerror=/);
  assert.match(hostile,/&lt;script&gt;/);
});
test('shared response guidance requests direct writing without prose dashes while preserving exact technical text',()=>{
  assert.match(RESPONSE_STYLE,/Lead with the answer/);
  assert.match(RESPONSE_STYLE,/FORMAT MATRIX/);
  assert.match(RESPONSE_STYLE,/Preserve exact code/);
});

test('response layout keeps code and tables inside the reading column, supports copying, and repairs old spacing',async()=>{
  const {chromium}=await import('playwright');
  const browser=await chromium.launch({headless:true});
  const code='  const flag = "--dry-run";\n  console.log(flag);';
  const sample='The implementation is ready. The source index is reusable, and the critical behavior is verified.\n\n## What changed\n\n1. Reuse unchanged source files.\n2. Retrieve the relevant implementation.\n\n```js\n'+code+'\n```\n\n| Check | Result |\n| --- | --- |\n| Source retrieval | Passed |\n| Edit conflict | Rejected safely |\n\nThe next step is to try the workflow on your own project.';
  try {
    const page=await browser.newPage(); const errors:string[]=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.addInitScript(({rendered,legacy})=>{
      Object.defineProperty(navigator,'clipboard',{value:{writeText:async(text:string)=>{(window as any).copiedText=text;}}});
      localStorage.setItem('agentFireworksAgentsV2',JSON.stringify([{id:'ux-bot',name:'Product Engineer',description:'Direct guidance.',transcript:[{role:'user',html:'Improve the coding workflow.'},{role:'agent',html:legacy},{role:'agent',html:rendered}]}]));
      localStorage.setItem('openBotsSelectedBot','ux-bot');
    },{rendered:format(sample),legacy:'<h3>Saved result</h3><br><br>The saved conversation remains readable.<br><br><a href="/api/artifacts/chart.png"><img src="/api/artifacts/chart.png" alt="Saved chart"></a>'});
    await page.route('**/*',async route=>{
      const url=new URL(route.request().url());
      if(url.hostname!=='response.test')return route.abort();
      if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:html});
      if(['/responseMarkdown.js','/runStream.js','/botCatalog.js'].includes(url.pathname))return route.fulfill({contentType:'text/javascript',body:readFileSync(join(__dirname,'..','static',url.pathname.slice(1)))});
      if(url.pathname==='/browserRuntime.js')return route.fulfill({contentType:'text/javascript',body:readFileSync(join(__dirname,'..','static','browserRuntime.js'))});
      if(url.pathname==='/uiState.js')return route.fulfill({contentType:'text/javascript',body:readFileSync(join(__dirname,'..','static','uiState.js'))});
      if(url.pathname.startsWith('/api/'))return route.fulfill({contentType:'application/json',body:JSON.stringify({isRunning:false,models:[],jobs:[],events:[],workflows:[],suggestions:[],schedules:[]})});
      return route.abort();
    });
    await page.goto('http://response.test/',{waitUntil:'domcontentloaded'});
    const bubbles=page.locator('.message.agent .bubble');
    await bubbles.last().waitFor();
    assert.equal(await bubbles.first().locator('img').count(),1,'legacy image evidence cannot be lost');
    assert.equal(await bubbles.first().locator(':scope > br').count(),0);
    assert.equal(await bubbles.last().locator('pre br').count(),0);
    assert.equal(await bubbles.last().locator('pre code').textContent(),code);
    for(const width of [1440,768,390]){
      await page.setViewportSize({width,height:1000});
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      assert.equal(await bubbles.last().evaluate(el=>getComputedStyle(el).backgroundColor),'rgba(0, 0, 0, 0)');
    }
    await bubbles.last().locator('.copy-code').click();
    await page.waitForFunction(()=>!!(window as any).copiedText);
    assert.equal(await page.evaluate(()=>(window as any).copiedText),code);
    const response=page.locator('.message.agent').last(); await response.hover();
    await response.locator('.fb-copy').click();
    await page.waitForFunction(()=>(window as any).copiedText.includes('The implementation is ready'));
    assert.doesNotMatch(await page.evaluate(()=>(window as any).copiedText),/Copy code|Copied/);
    assert.deepEqual(errors,[]);
  } finally { await browser.close(); }
});
