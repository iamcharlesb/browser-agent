const test = require('node:test');
const assert = require('node:assert/strict');
const {merge} = require('../static/botCatalog.js');
test('one catalog combines unadded built-ins with saved/custom bots and resolves renamed profiles', () => {
  const presets=[{name:'Sundar Pichai',profileId:'sundar-pichai',description:'Platform leadership'},{name:'Wall Street Analyst',profileId:'wall-street-analyst'}];
  const saved=[{id:'sundar',name:'My Product Advisor',profileId:'sundar-pichai',description:'My instructions'},{id:'custom',name:'My Custom Bot'},{id:'session',kind:'huddle',name:'Huddle: Work'},{id:'deleted',name:'Old Bot',deleted:true}];
  const catalog=merge(presets,saved);
  assert.equal(catalog.length,3);
  assert.equal(catalog[0].name,'My Product Advisor');
  assert.equal(catalog[0].description,'My instructions');
  assert.equal(catalog[0].savedId,'sundar');
  assert.equal(catalog[1].savedId,undefined);
  assert.equal(catalog[2].savedId,'custom');
  assert.equal(new Set(catalog.map(bot=>bot.catalogKey)).size,3);
  assert.equal(saved.length,4,'building the catalog does not add any bots');
  assert.equal(presets[0].name,'Sundar Pichai','saved preferences do not mutate the definitions');
});
test('legacy saved names match the built-in once and membership keys survive adding a bot',()=>{
  const presets=[{name:'Blog Writer',profileId:'blog-writer'}];
  const before=merge(presets,[])[0];
  const after=merge(presets,[{id:'writer',name:'Blog Writer'}])[0];
  assert.equal(after.catalogKey,before.catalogKey);
  assert.equal(after.savedId,'writer');
});
test('consolidated engineering exposes one capability card without changing legacy chats',()=>{
  const presets=[{name:'Engineering',profileId:'systems-architect',summary:'Websites, code, terminal and DevOps',consolidates:['website-designer','Website Designer','Local Terminal & DevOps Bot','Principal Fullstack Engineer, Cloud & DevOps']}];
  const saved=[
    {id:'principal',name:'Principal Fullstack Engineer, Cloud & DevOps',profileId:'systems-architect',transcript:[{role:'user',html:'Existing project'}]},
    {id:'designer',name:'Website Designer',profileId:'website-designer',transcript:[{role:'user',html:'Existing website'}]},
    {id:'terminal',name:'Local Terminal & DevOps Bot',transcript:[]},
    {id:'custom',name:'My Code Reviewer',transcript:[]}
  ];
  const before=JSON.stringify(saved);
  const catalog=merge(presets,saved);
  assert.deepEqual(catalog.map(bot=>bot.name),['Engineering','My Code Reviewer']);
  assert.equal(catalog[0].savedId,'principal');
  assert.equal(catalog[0].profileId,'systems-architect');
  assert.equal(JSON.stringify(saved),before,'ids, names, histories and existing roles remain intact');
  const unadded=merge(presets,saved.filter(bot=>bot.id!=='principal'));
  assert.equal(unadded[0].name,'Engineering');
  assert.equal(unadded[0].savedId,undefined,'a legacy designer is not silently reused as the combined engineering role');
});
