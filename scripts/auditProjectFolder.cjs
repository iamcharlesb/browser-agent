/** Real folder-selection UI + real attachment storage, with all account/model APIs isolated. */
const { chromium } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { storeChatAttachment, loadChatAttachments } = require('../.test-dist/chatAttachments');
const { projectImportConfig, queryProjectFiles } = require('../.test-dist/projectAttachments');
const root = path.resolve(__dirname, '..');
(async () => {
 const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'openbots-folder-audit-'));
 const folder = path.join(temp, 'example-project');
 const store = path.join(temp, 'attachments');
 const errors = [];
 let submitted, uploaded, saved;
 const browser = await chromium.launch({ headless: true });
 try {
  await fs.mkdir(path.join(folder,'src'),{recursive:true});
  await fs.mkdir(path.join(folder,'node_modules','ignored'),{recursive:true});
  await fs.writeFile(path.join(folder,'package.json'),JSON.stringify({name:'example-project',scripts:{build:'tsc'}}));
  await fs.writeFile(path.join(folder,'README.md'),'Project source for analysis.');
  await fs.writeFile(path.join(folder,'src','main.ts'),'export const projectAuditMarker = "inspect-on-demand";');
  await fs.writeFile(path.join(folder,'.env'),'PRIVATE_CONFIGURATION=do-not-import');
  await fs.writeFile(path.join(folder,'node_modules','ignored','index.js'),'do not import dependencies');
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.route('**/*',async route=>{
   const request=route.request(),url=new URL(request.url());
   if(url.hostname!=='openbots.audit')return route.abort();
   if(url.pathname==='/api/attachments/project-config')return route.fulfill({json:projectImportConfig()});
   if(url.pathname==='/api/attachments'&&request.method()==='POST'){
    uploaded=request.postDataJSON();
    saved=await storeChatAttachment(store,path.join(temp,'artifacts'),uploaded.files[0]);
    const {text,projectFiles,...metadata}=saved;
    assert.equal(projectFiles.length,3);
    assert.equal(metadata.projectFiles,undefined);
    return route.fulfill({json:{attachments:[metadata]}});
   }
   if(url.pathname==='/api/run'&&request.method()==='POST'){
    submitted=request.postDataJSON();
    return route.fulfill({json:{runId:'audit-project-run'}});
   }
   if(url.pathname.startsWith('/api/'))return route.fulfill({json:url.pathname==='/api/auth/google/config'?{enabled:false}:{isRunning:false,sessionMode:'guest',models:[],jobs:[],schedules:[],byModel:[],totalTokens:0,totalEstimatedCostUsd:0}});
   const rel=url.pathname==='/'?'index.html':url.pathname.slice(1);
   if(!/^(index\.html|browserRuntime\.js|avatars\/[a-z0-9.-]+)$/.test(rel))return route.fulfill({status:404,body:''});
   const file=path.join(root,'static',rel);
   try{return route.fulfill({body:await fs.readFile(file),contentType:{'.html':'text/html','.js':'text/javascript','.jpg':'image/jpeg','.webp':'image/webp','.png':'image/png','.svg':'image/svg+xml'}[path.extname(file)]});}
   catch{return route.fulfill({status:404,body:''});}
  });
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://openbots.audit/');
  await page.locator('.template-card[data-name="Inspired by Addy Osmani"]').click();
  await page.locator('#attach-button').click();
  assert.equal(await page.locator('#attach-files-option').isVisible(),true);
  assert.equal(await page.locator('#attach-folder-option').isVisible(),true);
  const chooserPromise=page.waitForEvent('filechooser');
  await page.locator('#attach-folder-option').click();
  const chooser=await chooserPromise;
  await chooser.setFiles(folder);
  await page.waitForFunction(()=>document.querySelector('.attachment-chip')?.textContent.includes('3 indexed source files'));
  assert.deepEqual(uploaded.files[0].projectFiles.map(file=>file.path).sort(),['README.md','package.json','src/main.ts']);
  assert.equal(saved.type,'project');assert.equal(saved.skipped,2);
  assert.equal(await page.locator('#attachment-menu').isVisible(),false);
  assert.equal(await page.locator('#project-folder-input').inputValue(),'');
  await page.screenshot({path:'/tmp/openbots-project-folder-audit.png',fullPage:true});
  await page.locator('#prompt').fill('Analyze the architecture of this project.');
  await page.locator('#send-button').click();
  await page.waitForFunction(()=>document.querySelector('#messages')?.textContent.includes('Analyze the architecture'));
  for(let i=0;!submitted&&i<40;i++)await page.waitForTimeout(50);
  assert.ok(submitted,'The selected project must be sent with the bot request');
  assert.ok(submitted.task.includes('[attachment: '+saved.id+']'));
  assert.ok(!submitted.task.includes('inspect-on-demand'),'Whole source must not be embedded in the initial prompt');
  const restored=(await loadChatAttachments(store,submitted.task))[0];
  const result=queryProjectFiles(restored.projectFiles,{action:'read',path:'src/main.ts'});
  assert.match(result.text,/projectAuditMarker/);
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({success:true,checks:['files and folder menu','real directory picker selection','relative paths preserved','dependencies and credentials excluded before upload','project chip with file count','local snapshot persisted','bot request references project','on-demand source read','no JavaScript errors'],screenshot:'/tmp/openbots-project-folder-audit.png'},null,2));
 } finally {await browser.close();await fs.rm(temp,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
