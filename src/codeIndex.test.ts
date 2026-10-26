import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { buildCodeIndex, queryCodeIndex, sourceHash } from './codeIndex';
import { workspaceCode, guardedCodePatch } from './workspaceCode';
import { queryProjectFiles } from './projectAttachments';
import { storeChatAttachment, loadChatAttachments } from './chatAttachments';

const auth = 'import { sessions } from "./sessions";\nexport function authenticateUser(token: string) {\n  return sessions.validate(token);\n}\n';
test('ranked source retrieval finds identifiers across camel case and returns bounded cited evidence', () => {
  const index = buildCodeIndex([{path:'src/auth.ts',text:auth}, {path:'src/theme.ts',text:'export const color = "blue";'}, {path:'README.md',text:'authentication configuration overview'}]);
  const result = queryCodeIndex(index,{action:'search',query:'authenticate user'}) as any;
  assert.equal(result.matches[0].path,'src/auth.ts');
  assert.equal(result.matches[0].startLine,1);
  assert.match(result.matches[0].text,/sessions.validate/);
  assert.ok(JSON.stringify(result).length < 6500);
  const map = queryCodeIndex(index,{action:'map',path:'src/auth.ts'}) as any;
  assert.equal(map.files[0].symbols[0].name,'authenticateUser');
  assert.deepEqual(map.files[0].imports,['./sessions']);
  assert.equal((queryCodeIndex(index,{action:'search',query:'missingIdentifier'}) as any).matches.length,0);
  assert.throws(()=>queryCodeIndex(index,{action:'search',query:'auth',offset:-1}),/offset/);
});

test('incremental revisions reuse unchanged files, reflect deletions, and detect changed source', () => {
  const first = buildCodeIndex([{path:'auth.ts',text:auth},{path:'old.ts',text:'const old = true;'}]);
  const unchanged = buildCodeIndex([{path:'auth.ts',text:auth},{path:'old.ts',text:'const old = true;'}],JSON.parse(JSON.stringify(first)));
  assert.equal(unchanged.reusedFiles,2); assert.equal(unchanged.revision,first.revision);
  const next = buildCodeIndex([{path:'auth.ts',text:auth+'// Changed behavior\n'}],unchanged);
  assert.equal(next.reusedFiles,0); assert.notEqual(next.revision,first.revision);
  assert.deepEqual(next.files.map(file=>file.path),['auth.ts']);
});

test('imports persist a reusable index alongside read-only snapshot source', async () => {
  const base = await mkdtemp(join(tmpdir(),'code-snapshot-'));
  try {
    const saved = await storeChatAttachment(base,join(base,'artifacts'),{name:'demo',projectFiles:[{path:'auth.ts',text:auth}]});
    const legacy = JSON.parse(await readFile(join(base, saved.id + '.json'), 'utf8'));
    delete legacy.codeIndex; delete legacy.indexRevision;
    await writeFile(join(base, saved.id + '.json'), JSON.stringify(legacy));
    const [loaded] = await loadChatAttachments(base,`[attachment: ${saved.id}]`);
    assert.equal(loaded.codeIndex?.revision,saved.codeIndex?.revision);
    const result = queryProjectFiles(loaded.projectFiles!,{action:'retrieve',query:'authenticate user'},loaded.codeIndex) as any;
    assert.equal(result.matches[0].path,'auth.ts');
    assert.throws(()=>queryProjectFiles(loaded.projectFiles!,{action:'patch',path:'auth.ts'}),/only/);
  } finally { await rm(base,{recursive:true,force:true}); }
});

test('live index persists across reload, honors Git exclusions, skips credentials/dependencies/symlink escapes and refreshes', async () => {
  const base = await mkdtemp(join(tmpdir(),'workspace-code-'));
  const root=join(base,'repo'),cache=join(base,'cache');
  await mkdir(root); execFileSync('git',['init','-q'],{cwd:root});
  try {
    await mkdir(join(root,'src')); await mkdir(join(root,'node_modules')); await mkdir(join(root,'build'));
    await writeFile(join(root,'.gitignore'),'private.ts\n');
    await writeFile(join(root,'src/auth.ts'),auth);
    await writeFile(join(root,'private.ts'),'excluded private source');
    await writeFile(join(root,'node_modules/download.ts'),'downloadedDependency');
    await writeFile(join(root,'build/output.ts'),'generatedOutput');
    await writeFile(join(root,'.env'),'TOKEN=do-not-index');
    await writeFile(join(base,'outside.ts'),'outsideMarker');
    await symlink(join(base,'outside.ts'),join(root,'src/escape.ts'));
    const first = await workspaceCode({action:'index'},root,cache) as any;
    assert.equal(first.gitAware,true); assert.equal(first.totalFiles,2);
    const result = await workspaceCode({action:'search',query:'authenticate user'},root,cache) as any;
    assert.equal(result.matches[0].path,'src/auth.ts');
    const disk = (await import('node:fs/promises')).readdir(cache);
    const persisted = await readFile(join(cache,(await disk)[0]),'utf8');
    assert.doesNotMatch(persisted,/downloadedDependency|generatedOutput|outsideMarker|excluded private source|do-not-index/);
    const status = await workspaceCode({action:'status'},root,cache) as any;
    assert.equal(status.revision,first.revision);
    const again = await workspaceCode({action:'index'},root,cache) as any;
    assert.equal(again.reusedFiles,first.totalFiles);
    const live = await workspaceCode({action:'read',path:'src/auth.ts',line:2},root,cache) as any;
    assert.equal(live.hash,sourceHash(auth)); assert.equal(live.startLine,2);
    await guardedCodePatch(root,'src/auth.ts',live.hash,'sessions.validate(token)','sessions.validate(token.trim())');
    await assert.rejects(guardedCodePatch(root,'src/auth.ts',live.hash,'return','throw'),/Source changed/);
    const updated = await workspaceCode({action:'index'},root,cache) as any;
    assert.notEqual(updated.revision,first.revision); assert.equal(updated.reusedFiles,1);
    await assert.rejects(workspaceCode({action:'read',path:'src/escape.ts'},root,cache),/within the workspace/);
    await assert.rejects(workspaceCode({action:'index',root:'..'},root,cache),/within the workspace/);
    await assert.rejects(workspaceCode({action:'index',root:'node_modules'},root,cache),/source project directory/);
    await assert.rejects(guardedCodePatch(root,'src/escape.ts',sourceHash('outsideMarker'),'outsideMarker','changed'),/within the workspace/);
    assert.equal(await readFile(join(base,'outside.ts'),'utf8'),'outsideMarker');
    await assert.rejects(guardedCodePatch(root,'src/auth.ts',sourceHash(await readFile(join(root,'src/auth.ts'),'utf8')),'','bad'),/exactly one/);
  } finally { await rm(base,{recursive:true,force:true}); }
});

test('non-Git folders use bounded fallback enumeration without downloaded or private directories', async () => {
  const base=await mkdtemp(join(tmpdir(),'code-nongit-'));
  try {
    await mkdir(join(base,'vendor')); await writeFile(join(base,'vendor/dep.ts'),'excludedDependency');
    await writeFile(join(base,'source.py'),'def compute_total():\n    return 42\n');
    const map=await workspaceCode({action:'map'},base,join(base,'.browser-agent-code-index')) as any;
    assert.equal(map.totalFiles,1); assert.equal(map.files[0].symbols[0].name,'compute_total');
  } finally { await rm(base,{recursive:true,force:true}); }
});

for (const agentEngine of ['cheap','openai-sdk'] as const) {
  test(`${agentEngine} enforces existing approval gates on guarded patches`, async () => {
    const { AgentOrchestrator } = await import('./promptLoop');
    const { BrowserController } = await import('./browserController');
    let requests=0, approvals=0;
    const agent = new AgentOrchestrator({task:'Refactor the local source code.', interactionMode:'chat', agentEngine, model:'integration-model', apiKey:'test-key', browser:{} as InstanceType<typeof BrowserController>,
      onTerminalApproval:()=>{ approvals++; return false; },
      fetch: async()=>{
        requests++;
        const output = requests === 1 ? [{type:'function_call',id:'fc_patch',call_id:'patch_call',name:'workspace_file',arguments:JSON.stringify({action:'patch',path:'does-not-exist.ts',expectedHash:'0'.repeat(64),oldText:'before',newText:'after'})}]
          : [{type:'message',id:'msg_done',role:'assistant',status:'completed',content:[{type:'output_text',text:'The edit was not approved.'}]}];
        return new Response(JSON.stringify({id:`r_${requests}`,object:'response',created_at:1,status:'completed',model:'integration-model',output,usage:{input_tokens:10,output_tokens:5,total_tokens:15}}),{headers:{'content-type':'application/json'}});
      }});
    await agent.run();
    assert.equal(approvals,1,'patch cannot bypass the workspace edit gate');
  });
}

test('chunk limits are explicit and a larger rebuild does not reuse an incomplete chunk set',()=>{
  const saved=process.env.BROWSER_AGENT_CODE_MAX_CHUNKS;
  try {
    process.env.BROWSER_AGENT_CODE_MAX_CHUNKS='1';
    const sources=[{path:'long.ts',text:Array.from({length:200},(_,i)=>`export const marker${i} = ${i};`).join('\n')}];
    const limited=buildCodeIndex(sources); assert.equal(limited.truncated,true);
    process.env.BROWSER_AGENT_CODE_MAX_CHUNKS='100';
    const full=buildCodeIndex(sources,limited); assert.equal(full.truncated,false); assert.equal(full.reusedFiles,0);
    assert.ok(full.files[0].chunks.length>1);
  } finally { if(saved===undefined)delete process.env.BROWSER_AGENT_CODE_MAX_CHUNKS;else process.env.BROWSER_AGENT_CODE_MAX_CHUNKS=saved; }
});


test('excerpts contain the matching declaration even near the bottom of a long chunk',()=>{
  const padding=Array.from({length:55},(_,i)=>`// General setup line ${i} with extra context and details`);
  const index=buildCodeIndex([{path:'src/target.ts',text:[...padding,'export function computeInvoiceTotal() { return 42; }'].join('\n')}]);
  const found=queryCodeIndex(index,{action:'search',query:'computeInvoiceTotal'}) as any;
  assert.match(found.matches[0].text,/function computeInvoiceTotal/);
  assert.ok(found.matches[0].startLine<=56 && found.matches[0].endLine>=56);
});

for (const agentEngine of ['cheap','openai-sdk'] as const) {
  test(`${agentEngine} can call live code retrieval without embedding the repository in its prompt`, async () => {
    const { AgentOrchestrator } = await import('./promptLoop');
    const { BrowserController } = await import('./browserController');
    const requests: any[]=[];
    const agent=new AgentOrchestrator({task:'Read the local package manifest through code_project.',interactionMode:'chat',agentEngine,model:'integration-model',apiKey:'test-key',browser:{} as InstanceType<typeof BrowserController>,
      fetch:async(_input,init)=>{
        requests.push(JSON.parse(String(init?.body)));
        const output=requests.length===1?[{type:'function_call',id:'fc_code',call_id:'code_call',name:'code_project',arguments:JSON.stringify({action:'read',path:'package.json'})}]
          :[{type:'message',id:'msg_code',role:'assistant',status:'completed',content:[{type:'output_text',text:'I inspected the live manifest.'}]}];
        return new Response(JSON.stringify({id:`rc_${requests.length}`,object:'response',created_at:1,status:'completed',model:'integration-model',output,usage:{input_tokens:10,output_tokens:5,total_tokens:15}}),{headers:{'content-type':'application/json'}});
      }});
    assert.equal((await agent.run()).success,true);
    assert.match(JSON.stringify(requests[0].tools),/code_project/);
    assert.doesNotMatch(JSON.stringify(requests[0].input),/fireworks-plus-plus/);
    assert.match(JSON.stringify(requests[1].input),/fireworks-plus-plus/);
    assert.match(JSON.stringify(requests[1].input),/live/);
  });
}
