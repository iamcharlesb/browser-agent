import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { storeChatAttachment,loadChatAttachments,attachmentImages } from './chatAttachments';
import { AgentOrchestrator } from './promptLoop';
import { BrowserController } from './browserController';
const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aEl8AAAAASUVORK5CYII=';

test('attachments use local opaque references; source text and image bytes survive a reload',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'chat-files-')),artifacts=join(dir,'artifacts');
 try{
 const picture=await storeChatAttachment(dir,artifacts,{name:'screenshot.png',dataUrl:image});
 const note=await storeChatAttachment(dir,artifacts,{name:'workflow.txt',text:'Open the Search Console property picker before concluding no properties exist.'});
 const files=await loadChatAttachments(dir,`Check this [attachment: ${picture.id}] [attachment: ${note.id}]`);
 assert.equal(files.length,2);assert.match(picture.url!,/^\/api\/artifacts\//);assert.equal(files[1].text,note.text);assert.deepEqual(await attachmentImages(artifacts,files),[image]);
 assert.deepEqual(await loadChatAttachments(dir,'[attachment: ../../etc/passwd]'),[]);
 await assert.rejects(storeChatAttachment(dir,artifacts,{dataUrl:'data:image/png;base64,ZmFrZQ=='}),/content does not match/);
 await assert.rejects(storeChatAttachment(dir,artifacts,{dataUrl:'data:image/svg+xml;base64,PHN2Zz4='}),/PNG/);
 }finally{await rm(dir,{recursive:true});}
});

for(const agentEngine of ['cheap','openai-sdk'] as const) {
 test(`${agentEngine} sends pasted images to the model and dispatches knowledge retrieval`,async()=>{
 const requests: any[]=[],lookups: any[]=[];
 const mockFetch: typeof fetch=async(_input,init)=>{
   const body=JSON.parse(String(init?.body));requests.push(body);
   const output=requests.length===1?[{type:'function_call',id:'fc_1',call_id:'call_1',name:'knowledge_base',arguments:JSON.stringify({action:'search',query:'Search Console property picker'})}]:[{type:'message',id:'m_1',role:'assistant',status:'completed',content:[{type:'output_text',text:'The screenshot shows properties. I will inspect the picker.'}]}];
   return new Response(JSON.stringify({id:`resp_${requests.length}`,object:'response',created_at:1,status:'completed',model:'gpt-6-luna',output,usage:{input_tokens:10,output_tokens:5,total_tokens:15}}),{headers:{'content-type':'application/json'}});
 };
 const result=await new AgentOrchestrator({task:'Interpret the attached screenshot of Search Console.',taskImages:[image],agentEngine,model:'gpt-6-luna',apiKey:'test-key',fetch:mockFetch,browser:{} as BrowserController,onKnowledgeBase:async input=>{lookups.push(input);return {ok:true,message:'Open property picker and inspect available domains.'};}}).run();
 assert.equal(result.success,true,result.summary);assert.equal(lookups.length,1);assert.ok(JSON.stringify(requests[0].input).includes(image));assert.match(JSON.stringify(requests[0].input),/input_image/);
 });
}

import { prepareProjectFiles, projectReference, queryProjectFiles, projectImportConfig } from './projectAttachments';

test('project folder snapshots preserve paths, exclude generated/private files and support bounded source retrieval after reload', async () => {
 const dir=await mkdtemp(join(tmpdir(),'project-files-'));
 try {
  const credential='sk-'+'a'.repeat(32);
  const project=await storeChatAttachment(dir,join(dir,'artifacts'),{name:'my-project',projectFiles:[
   {path:'README.md',text:'Project overview'},
   {path:'src/main.ts',text:'export const greeting = "hello";\nexport const endpoint = "'+credential+'";'},
   {path:'test/main.ts',text:'assert.equal(greeting, "hello");'},
   {path:'src/empty.ts',text:''},
   {path:'node_modules/lib/index.js',text:'dependency'},
   {path:'.git/config',text:'git internals'},
   {path:'.env',text:'private settings'},
   {path:'.npmrc',text:'private registry credentials'}
  ]});
  assert.equal(project.type,'project');assert.equal(project.fileCount,4);assert.equal(project.skipped,4);
  assert.ok(!JSON.stringify(project.projectFiles).includes(credential));
  const restored=(await loadChatAttachments(dir,`Review this [attachment: ${project.id}]`))[0];
  assert.deepEqual(restored.projectFiles,project.projectFiles);
  const listing=queryProjectFiles(restored.projectFiles!,{action:'list',path:'src'}) as any;
  assert.deepEqual(listing.files.map((file:any)=>file.path),['src/empty.ts','src/main.ts']);
  const file=queryProjectFiles(restored.projectFiles!,{action:'read',path:'src/main.ts',offset:7}) as any;
  assert.match(file.text,/greeting/);assert.equal(file.nextOffset,null);
  const matches=queryProjectFiles(restored.projectFiles!,{action:'search',query:'greeting'}) as any;
  assert.equal(matches.matches.length,2);assert.equal(matches.matches[0].line,1);
  assert.throws(()=>queryProjectFiles(restored.projectFiles!,{action:'read',path:'../private'}),/escape/);
  assert.throws(()=>queryProjectFiles(restored.projectFiles!,{action:'write',path:'src/main.ts'}),/list, read and search/);
  assert.ok(projectReference(project).length<1200);assert.match(projectReference(project),/read-only|Read-only/);
 } finally {await rm(dir,{recursive:true});}
});

test('project snapshots reject traversal/duplicate paths, enforce import bounds and paginate source reads and searches', () => {
 for(const path of ['../private','/etc/passwd','src/../../outside','C:\\private.txt','src//bad.ts']) assert.throws(()=>prepareProjectFiles([{path,text:'data'}]));
 assert.throws(()=>prepareProjectFiles([{path:'x.ts',text:'a'},{path:'x.ts',text:'b'}]),/Duplicate/);
 assert.throws(()=>prepareProjectFiles([{path:'.env',text:'private'}]),/no supported/);
 assert.throws(()=>prepareProjectFiles([{path:'binary.ts',text:'a\0b'}]),/no supported/);
 assert.throws(()=>prepareProjectFiles([{path:'big.ts',text:'x'.repeat(projectImportConfig().maxFileBytes+1)}]),/no supported/);
 const files=prepareProjectFiles(Array.from({length:45},(_,i)=>({path:`src/file${i}.ts`,text:'needle\n'.repeat(30)}))).projectFiles;
 const first=queryProjectFiles(files,{action:'list'}) as any;assert.equal(first.files.length,40);assert.equal(first.nextOffset,40);
 const last=queryProjectFiles(files,{action:'list',offset:40}) as any;assert.equal(last.files.length,5);assert.equal(last.nextOffset,null);
 const search=queryProjectFiles(files,{action:'search',query:'needle'}) as any;assert.equal(search.matches.length,20);assert.equal(search.nextOffset,20);
 const read=queryProjectFiles([{path:'long.ts',text:'x'.repeat(4200),size:4200}],{action:'read',path:'long.ts'}) as any;assert.equal(read.text.length,4000);assert.equal(read.nextOffset,4000);
 const previous=process.env.BROWSER_AGENT_PROJECT_MAX_FILES;
 try {process.env.BROWSER_AGENT_PROJECT_MAX_FILES='1';assert.throws(()=>prepareProjectFiles([{path:'a.ts',text:'a'},{path:'b.ts',text:'b'}]),/1–1/);}
 finally {if(previous===undefined)delete process.env.BROWSER_AGENT_PROJECT_MAX_FILES;else process.env.BROWSER_AGENT_PROJECT_MAX_FILES=previous;}
});

for(const agentEngine of ['cheap','openai-sdk'] as const) {
 test(`${agentEngine} retrieves selected project code on demand instead of embedding the whole snapshot`,async()=>{
  const requests:any[]=[],lookups:any[]=[];
  const source=prepareProjectFiles([{path:'src/main.ts',text:'export const architectureMarker = "source-read-on-demand";'}]);
  const id='12345678-1234-4234-8234-123456789abc';
  const mockFetch:typeof fetch=async(_input,init)=>{
   const body=JSON.parse(String(init?.body));requests.push(body);
   const output=requests.length===1?[{type:'function_call',id:'fc_project',call_id:'call_project',name:'knowledge_base',arguments:JSON.stringify({action:'read',id:'project:'+id,path:'src/main.ts'})}]:[{type:'message',id:'m_project',role:'assistant',status:'completed',content:[{type:'output_text',text:'I read src/main.ts and reviewed its exported constant.'}]}];
   return new Response(JSON.stringify({id:`response_${requests.length}`,object:'response',created_at:1,status:'completed',model:'gpt-6-luna',output,usage:{input_tokens:10,output_tokens:5,total_tokens:15}}),{headers:{'content-type':'application/json'}});
  };
  const result=await new AgentOrchestrator({task:'Review the attached source project.',collaborationContext:projectReference({id,name:'my-project',fileCount:1}),interactionMode:'chat',agentEngine,model:'gpt-6-luna',apiKey:'test-key',fetch:mockFetch,browser:{} as BrowserController,onKnowledgeBase:async input=>{lookups.push(input);return {ok:true,message:JSON.stringify(queryProjectFiles(source.projectFiles,input))};}}).run();
  assert.equal(result.success,true,result.summary);assert.equal(lookups[0].path,'src/main.ts');
  assert.ok(!JSON.stringify(requests[0].input).includes('source-read-on-demand'));
  assert.ok(JSON.stringify(requests[1].input).includes('source-read-on-demand'));
 });
}
