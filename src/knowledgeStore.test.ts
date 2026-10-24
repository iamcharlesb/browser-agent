import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyKnowledge,saveKnowledge,searchKnowledge,knowledgeContext,loadKnowledge,persistKnowledge,rememberWorkflowStep,workflowRunbook } from './knowledgeStore';

test('site-specific runbooks are retrieved with sources, without dumping unrelated documents',()=>{
 let kb=saveKnowledge(emptyKnowledge(),{kind:'runbook',title:'Google Search Console property selection',text:'Preconditions: verify the intended Google account. Open the property picker and select the exact magicsite.ai domain. Verify the property header before checking Performance. A welcome screen alone does not mean there are no accessible properties.',source:'https://search.google.com/search-console'});
 kb=saveKnowledge(kb,{kind:'runbook',title:'MagicSite blog image upload',text:'Find the exact article in blog management, choose Edit, upload the existing artifact, save the draft and reopen to verify the featured image.',source:'https://magicsite.ai/admin/blog'});
 kb=saveKnowledge(kb,{kind:'reference',title:'Other source',text:'Unrelated Kubernetes deployment instructions '.repeat(1000),source:'https://example.test/kubernetes'});
 assert.equal(searchKnowledge(kb,'search.google.com Search Console domain property magicsite.ai')[0].title,'Google Search Console property selection');
 const context=knowledgeContext(kb,'Search Console property picker');
 assert.match(context,/property picker/);assert.doesNotMatch(context,/Kubernetes/);assert.ok(context.length<=3000);assert.match(context,/reference data|reference data,|reference|approval/);
});

test('long reference sources are chunked, retain citations and survive restart in the intended bot only',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'knowledge-'));
 try{
 let kb=saveKnowledge(emptyKnowledge(),{kind:'reference',title:'Operations manual',text:'Unrelated notes. '.repeat(200)+'GSC performance queries: select the verified property, then open Performance and export queries. '+'More notes. '.repeat(200),source:'User attachment source-1'});
 await persistKnowledge(dir,'seo',kb);kb=await loadKnowledge(dir,'seo');
 const result=searchKnowledge(kb,'GSC performance queries')[0];assert.match(result.text,/GSC performance queries/);assert.match(result.id,/:/);assert.equal(result.source,'User attachment source-1');
 assert.deepEqual(await loadKnowledge(dir,'different-bot'),emptyKnowledge());
 }finally{await rm(dir,{recursive:true});}
});

test('updating a runbook replaces its previous version and never creates approval state',()=>{
 let kb=saveKnowledge(emptyKnowledge(),{kind:'runbook',title:'Edit draft',text:'Old route',source:'User note'});
 kb=saveKnowledge(kb,{kind:'runbook',title:'Edit draft',text:'Use blog management, match title, then edit.',source:'User note'});
 assert.equal(kb.entries.length,1);assert.doesNotMatch(knowledgeContext(kb,'edit draft'),/Old route/);assert.equal('standingApproval' in kb,false);
});


test('concurrent saves serialize snapshots without losing the latest knowledge',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'knowledge-writes-'));
 try {
 const first=saveKnowledge(emptyKnowledge(),{kind:'runbook',title:'Draft',text:'First procedure',source:'Test'});
 const second=saveKnowledge(first,{kind:'runbook',title:'Image',text:'Attach and verify image',source:'Test'});
 await Promise.all([persistKnowledge(dir,'seo',first),persistKnowledge(dir,'seo',second)]);
 assert.equal((await loadKnowledge(dir,'seo')).entries.length,2);
 }finally{await rm(dir,{recursive:true});}
});


test('successful workflows yield a compact fallback runbook without failed clicks, waits or typed content',()=>{
 let trace: string[]=[];
 trace=rememberWorkflowStep(trace,{type:'step',toolName:'navigate',ok:true,toolInput:{url:'https://example.test/admin/blog?token=private'}});
 trace=rememberWorkflowStep(trace,{type:'step',toolName:'wait',ok:true,message:'Waited 2 seconds'});
 trace=rememberWorkflowStep(trace,{type:'step',toolName:'click_coords',ok:false,toolInput:{x:9999,y:9999}});
 trace=rememberWorkflowStep(trace,{type:'step',toolName:'click_element',ok:true,toolInput:{target:'tr:has(a[title="Requested draft"]) button[aria-haspopup="menu"]'}});
 const runbook=workflowRunbook('Edit the draft',trace,true,'Saved and reopened the intended draft.','https://example.test/admin/blog');
 assert.ok(runbook);assert.match(runbook.text,/exact current title/);assert.doesNotMatch(runbook.text,/private|Waited|9999/);assert.match(runbook.text,/not proof of current state/);
 assert.equal(workflowRunbook('Edit draft',trace,false,'Blocked','https://example.test'),undefined);
 assert.equal(workflowRunbook('Upload image',trace,true,'Saved without a featured image','https://example.test'),undefined);
});
