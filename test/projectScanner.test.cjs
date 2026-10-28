const {test} = require('node:test');
const assert = require('node:assert/strict');
const scanner = require('../static/projectScanner');
const {projectImportConfig, projectPathAllowed} = require('../.test-dist/projectAttachments');

test('selecting a dependency folder itself is rejected before enumeration', async () => {
  await assert.rejects(scanner.collect({name:'node_modules',values(){throw new Error('Dependency root was enumerated');}},projectImportConfig()),/source project folder/);
});

test('folder traversal never opens dependency directories or private files across ecosystems', async () => {
  const config = projectImportConfig();
  const excluded = ['node_modules','vendor','.venv','site-packages','target','Pods','.gradle','.m2','.dart_tool','.pub-cache','deps','_build','.build','obj','.nuget'];
  const children = excluded.map(name => ({name,kind:'directory',values() { throw new Error('Entered excluded directory: '+name); }}));
  children.push({name:'.env',kind:'file',getFile() { throw new Error('Opened private file'); }});
  children.push({name:'packages',kind:'directory',async *values() { yield {name:'main.ts',kind:'file',async getFile() { return {size:20,async text(){return 'first-party source';}}; }}; }});
  const directory = {name:'fixture',async *values() { yield* children; }};
  const result = await scanner.collect(directory, config);
  assert.equal(result.skippedDirectories, excluded.length);
  assert.equal(result.files.length,1);
  assert.equal(result.files[0].webkitRelativePath,'fixture/packages/main.ts');
  assert.equal(await result.files[0].text(),'first-party source');
  for (const folder of excluded) {
    assert.equal(projectPathAllowed(folder+'/dependency.ts'),false,folder);
    assert.equal(scanner.allowed(folder+'/dependency.ts',config),false,folder);
  }
  assert.equal(projectPathAllowed('packages/frontend/src/main.ts'),true);
});

test('folder enumeration stops at limits before opening further files or reading source text', async () => {
  let opened=0;
  const directory={name:'fixture',async *values(){for(let i=0;i<100;i++)yield{name:i+'.ts',kind:'file',async getFile(){opened++;return{size:1,text(){throw new Error('Content read during enumeration');}};}};}};
  await assert.rejects(scanner.collect(directory,{...projectImportConfig(),maxFiles:1}),/import limit/);
  assert.equal(opened,2);
});
