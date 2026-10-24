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
