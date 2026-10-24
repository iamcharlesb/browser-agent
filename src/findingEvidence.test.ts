import assert from 'node:assert/strict';
import {test} from 'node:test';
import {findingEvidenceIssue,ViewInspection} from './findingEvidence';
import {AgentOrchestrator} from './promptLoop';
import {BrowserController,PageState} from './browserController';
const current={url:'https://example.test/reports',stateHash:'new'};
const evidence=(overrides:Partial<ViewInspection>={}):ViewInspection=>({url:current.url,stateHash:current.stateHash,scope:'#results',scopeFound:true,optionCount:0,rowCount:0,examples:[],contexts:[],emptyIndicator:'',accessDeniedIndicator:'',text:'',...overrides});

test('absence claims require the intended current tab and fresh scoped evidence across applications',()=>{
 for(const claim of ['There are no properties to choose from.','There are no invoices available.','I cannot find the requested records.','I do not have access to the report.']) {
  assert.ok(findingEvidenceIssue(claim,current));
  assert.ok(findingEvidenceIssue(claim,current,evidence({url:'https://wrong.test',emptyIndicator:'No results'})));
 }
 assert.ok(findingEvidenceIssue('There are no records.',current,evidence({stateHash:'stale'})));
 assert.ok(findingEvidenceIssue('There are no records.',current,evidence({scopeFound:false})));
});

test('visible choices/rows contradict absence; explicit scoped emptiness and access denial are reportable',()=>{
 assert.ok(findingEvidenceIssue('There are no available accounts.',current,evidence({optionCount:3,examples:['Account A','Account B']})));
 assert.ok(findingEvidenceIssue('There are no orders in this table.',current,evidence({rowCount:2})));
 assert.equal(findingEvidenceIssue('There are no results in the selected filter.',current,evidence({emptyIndicator:'No results'})),null);
 assert.ok(findingEvidenceIssue('There are no results in the current page.',current,evidence({scope:'current page',emptyIndicator:'No results'})));
 assert.equal(findingEvidenceIssue('I do not have access to this report.',current,evidence({accessDeniedIndicator:'permission denied'})),null);
 assert.equal(findingEvidenceIssue('The report contains 12 queries.',current),null);
});

for(const agentEngine of ['cheap','openai-sdk'] as const){
 test(`${agentEngine} challenges a false no-data answer and can recover using a fresh inspection`,async()=>{
  let calls=0;
  const state:PageState={...current,title:'Analytics',requiresHumanVerification:false,screenshotB64:'',elements:[],pageText:'Performance 12 queries',capturedAt:Date.now(),tabs:[{index:0,url:'https://other.test',title:'Other app',active:false},{index:1,url:current.url,title:'Analytics',active:true}]};
  let inspected:ViewInspection|undefined;
  const browser={isStarted:true,sessionMode:'persistent',currentUrl:()=>current.url,captureState:async()=>state,get lastViewInspection(){return inspected;},inspectView:async()=>{inspected=evidence({rowCount:2,examples:['repair service | 7 clicks','local services | 5 clicks']});return inspected;}} as unknown as BrowserController;
  const fetch:typeof globalThis.fetch=async(_input,init)=>{
   calls++;const body=JSON.parse(String(init?.body));
   const output=calls===1?[{type:'message',id:'m1',role:'assistant',status:'completed',content:[{type:'output_text',text:'There are no queries available.'}]}]:calls===2?[{type:'function_call',id:'fc2',call_id:'c2',name:'inspect_view',arguments:JSON.stringify({selector:'#results'})}]:[{type:'message',id:'m3',role:'assistant',status:'completed',content:[{type:'output_text',text:'The report contains repair service (7 clicks) and local services (5 clicks).'}]}];
   if(calls===2)assert.match(JSON.stringify(body),/Unverified conclusion|PREVIOUS ATTEMPT INCOMPLETE/);
   return new Response(JSON.stringify({id:`resp_${calls}`,object:'response',created_at:1,status:'completed',model:'gpt-6-luna',output,usage:{input_tokens:10,output_tokens:5,total_tokens:15}}),{headers:{'content-type':'application/json'}});
  };
  const result=await new AgentOrchestrator({task:'Read the report queries',agentEngine,model:'gpt-6-luna',apiKey:'test-key',fetch,browser,maxSteps:6}).run();
  assert.equal(result.success,true,result.summary);assert.match(result.summary,/repair service/);assert.equal(calls,3);
 });
}
