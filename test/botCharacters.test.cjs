const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const characters = require('../static/botCharacters.js');

test('built-in Pilo roles select the new characters consistently', () => {
  for (const [name, expected] of [
    ['Primary Bot', 'pilo'], ['Local Terminal & DevOps Bot', 'byte'],
    ['Product Marketing', 'star'], ['Chief Marketing Officer', 'marketing'],
    ['Ads Specialist (Google, Meta & more)', 'bot'], ['Blog Writer', 'blogger'],
    ['Website Designer', 'designer'], ['GIF Animator', 'designer'],
    ['X / Grok Trend Researcher', 'nova'], ['ChatGPT Assistant', 'sage'],
    ['Research Agent', 'frog'], ['Wall Street Analyst', 'yellow'],
    ['Reddit Community Growth', 'blob'], ['SEO Specialist', 'yellow'],
    ['Instagram Follower Growth', 'heart'], ['LinkedIn Growth', 'sage'],
    ['Influencer', 'cat'], ['Funnel Specialist', 'yellow'], ['Founder Operator', 'pilo']
  ]) assert.equal(characters.select({name}), expected, name);
  assert.equal(characters.select({name:'Custom name',profileId:'website-designer'}), 'designer');
  assert.equal(characters.select({name:'Planning friend'}), characters.select({name:'Planning friend'}));
  assert.equal(characters.select({name:'My bot',shape:'character-designer',shapeCustomized:true}), 'designer');
  assert.equal(characters.select({name:'Blog Writer',shape:'character-cat',shapeCustomized:true}), 'cat');
});

test('owner-picked silhouettes, uploads and person portraits retain their identity', () => {
  assert.equal(characters.select({name:'Website Designer',shapeCustomized:true}), null);
  assert.equal(characters.select({name:'Andrej Karpathy',avatarImage:'./avatars/andrej-karpathy.jpg?v=1'}), null);
  assert.equal(characters.select({name:'Blog Writer',avatarImage:'./uploads/my-photo.png'}), null);
  assert.equal(characters.select({name:'Blog Writer',avatarImage:'./uploads/pilo-custom.png'}), null);
  assert.equal(characters.select({name:'Blog Writer',avatarImage:'./avatars/blog-writer.svg?v=1'}), 'blogger');
  assert.equal(characters.select({name:'Primary Bot',avatarImage:'./pilo-mascot.png'}), 'pilo');
});

test('every character renders all expressions without SVG ID collisions or injected markup', () => {
  assert.equal(characters.names.length,15);
  const ids = new Set();
  for (const name of characters.names) {
    for (const mode of ['idle','thinking','writing','happy','sad']) {
      const svg=characters.render(name,mode);
      assert.match(svg,new RegExp('data-expression="'+mode+'"'));
      for (const expression of ['thinking','writing','happy','sad']) assert.ok(svg.includes('expression-'+expression));
      const localIds = new Set([...svg.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]));
      for (const id of localIds) {assert.ok(!ids.has(id));ids.add(id);}
      for (const ref of svg.matchAll(/url\(#([^)]+)\)/g)) assert.ok(localIds.has(ref[1]),ref[1]);
    }
  }
  const svg=characters.render('"><script>alert(1)</script>','"><script>alert(1)</script>');
  assert.ok(!svg.includes('<script>'));
  assert.match(svg,/data-expression="idle"/);
});

test('run expressions follow real output and failure events', () => {
  assert.equal(characters.forStep({toolName:'web_search'}),'thinking');
  assert.equal(characters.forStep({toolName:'workspace_file',message:'Read notes.md'}),'thinking');
  assert.equal(characters.forStep({toolName:'workspace_file',message:'Wrote notes.md'}),'writing');
  assert.equal(characters.forStep({toolName:'create_document'}),'writing');
  assert.equal(characters.forStep({toolName:'workspace_file',ok:false}),'sad');
  assert.equal(characters.expression('attentive'),'thinking');
  assert.equal(characters.expression('proud'),'happy');
});

test('shared renderer is usable in the browser and the UI ships all required assets', () => {
  const window={};const context=vm.createContext({window});
  for (const file of ['botCharacterArtwork.js','botCharacters.js']) vm.runInContext(readFileSync(join(__dirname,'../static',file),'utf8'),context);
  assert.equal(window.PiloCharacters.select({name:'Blog Writer'}),'blogger');
  const html=readFileSync(join(__dirname,'../static/index.html'),'utf8');
  const server=readFileSync(join(__dirname,'../src/server.ts'),'utf8');
  for (const file of ['botCharacterArtwork.js','botCharacters.js','botCharacters.css']) {
    assert.ok(html.includes('./'+file));assert.ok(server.includes('"/'+file+'"'));
  }
  assert.ok(html.indexOf('./botCharacterArtwork.js')<html.indexOf('./botCharacters.js'));
  for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);
});

test('the app avatar renderer replaces built-ins but preserves photos and custom silhouettes', () => {
  const html=readFileSync(join(__dirname,'../static/index.html'),'utf8');
  const source=html.slice(html.indexOf('  function applyAvatarElement('),html.indexOf('  function syncComposerAction('));
  const context={PiloCharacters:characters,defaultAvatarImage:()=>'',esc:value=>value,renderBotIcon:()=>'<span class="legacy-custom"></span>',applyBotAnimPersonality:el=>{el.dataset.botExpression='happy';},setBotExpression:(el,state)=>{el.expression=state;}};
  vm.createContext(context);vm.runInContext(source,context);
  function element(){const classes=new Set();return {dataset:{},classList:{add:(...names)=>names.forEach(n=>classes.add(n)),remove:(...names)=>names.forEach(n=>classes.delete(n)),contains:n=>classes.has(n),toggle:(n,on)=>on?classes.add(n):classes.delete(n)},style:{removeProperty(){},setProperty(){}}};}
  const role=element();context.applyAvatarElement(role,{name:'Blog Writer',avatarImage:'./avatars/blog-writer.svg?v=1'},true,true);
  assert.ok(role.classList.contains('character-avatar'));assert.ok(!role.classList.contains('photo-avatar'));assert.match(role.innerHTML,/pilo-character/);assert.equal(role.expression,'thinking');
  const photo=element();context.applyAvatarElement(photo,{name:'Owner',avatarImage:'./uploads/me.png'},false,false);
  assert.ok(photo.classList.contains('photo-avatar'));assert.match(photo.innerHTML,/uploads\/me.png/);
  const custom=element();context.applyAvatarElement(custom,{name:'My designer',shape:'hexagon',shapeCustomized:true,color:'#123456'},false,false);
  assert.match(custom.innerHTML,/legacy-custom/);assert.ok(!custom.classList.contains('character-avatar'));
});


test('saved repeated icons migrate once to distinct preview characters', () => {
  for (const [name,previous,expected] of [
    ['Reddit Community Growth','character-heart','blob'],
    ['SEO Specialist','character-heart','yellow'],
    ['Instagram Follower Growth','character-marketing','heart'],
    ['Founder Operator','character-cloud','pilo']
  ]) {
    const bot={name,shape:previous,shapeCustomized:true,description:'Keep this role'};
    assert.equal(characters.migrateSavedIcon(bot),true);
    assert.equal(characters.select(bot),expected);
    assert.equal(bot.description,'Keep this role');
    assert.equal(characters.migrateSavedIcon(bot),false);
    bot.shape=previous;
    assert.equal(characters.migrateSavedIcon(bot),false,'later owner selections are retained');
  }
  assert.equal(characters.migrateSavedIcon({name:'constructor',shape:'character-marketing'}),false);
  assert.equal(characters.migrateSavedIcon({name:'Product Marketing',shape:'character-marketing'}),false);
  assert.equal(characters.migrateSavedIcon({name:'SEO Specialist',shape:'character-cat'}),false);
});
