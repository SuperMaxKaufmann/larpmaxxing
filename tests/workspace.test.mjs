import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../server/storage.mjs';
import {ModelSession} from '../server/model-access.mjs';
import {createApp} from '../server/index.mjs';
import {PLAN_SYSTEM,DRAFT_SYSTEM,REVIEW_SYSTEM} from '../server/drafting.mjs';

const key='synthetic-workspace-session-key';
const request={intent:'Thank you for the outline. Please keep the explanation of the tradeoffs.',channel:'email',language:'en',modeId:'team',context:'Could you review the outline?',requiredPhrases:['tradeoffs']};
const verified=provider=>({provider,model:'gpt-test',verified:true,validation:'models-list',verifiedAt:new Date().toISOString(),availableModelCount:3,availableModels:[{id:'gpt-test'},{id:'gpt-other'},{id:'gpt-6-astra'}]});
async function setup(t,{complete,ready=true}={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'larp-workspace-test-'));
  const store=new Store(dir),session=new ModelSession({verifier:async({provider})=>verified(provider)}),calls=[];
  const responder=async(provider,system,payload,options)=>{
    calls.push({provider,system,payload,options});
    if(complete)return complete(provider,system,payload,options);
    if(system===PLAN_SYSTEM)return {incomingRequests:['Review the outline'],points:[{id:'p1',text:payload.intent}],missing:[]};
    if(system===DRAFT_SYSTEM)return {draft:'Thank you — please keep the explanation of the tradeoffs.'};
    if(system===REVIEW_SYSTEM)return {contentIssues:[],styleIssues:[],missingPointIds:[],unsupportedClaims:[]};
    return {preferences:[],examples:[],modes:[]};
  };
  const server=createApp({store,modelSession:session,complete:responder});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));fs.rmSync(dir,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}`;
  const initial=await(await fetch(base+'/api/onboarding')).json();
  const post=async(route,input={},method='POST')=>{const response=await fetch(base+route,{method,headers:{'Content-Type':'application/json','X-Local-Token':initial.csrfToken},body:JSON.stringify(input)});return {status:response.status,data:await response.json()};};
  if(ready){
    await post('/api/onboarding/model',{provider:'openai',apiKey:key});
    await post('/api/onboarding/paste',{authorship:'own',text:'Thanks for explaining the tradeoffs. The context helps me decide.'});
    await post('/api/onboarding/start');
    const current=store.readProfile();
    current.profile.modes.push({id:'team',name:'Close colleagues',status:'accepted',guidance:'Keep warmth and useful detail.',language:'en',channel:'email',relationship:'colleagues'});
    current.profile.preferences.push({id:'no-dash',text:'Never use em dashes.',status:'accepted',scope:{type:'global',value:''},basis:'explicit',category:'hard',banned:['—']});
    store.saveProfile(current.profile,current.version);
  }
  return {base,post,store,session,calls};
}
test('workspace requires verified access and one authored source before generation',async t=>{
  const {post,base,calls}=await setup(t,{ready:false});
  assert.equal((await fetch(base+'/api/workspace')).status,409);
  await post('/api/onboarding/model',{provider:'openai',apiKey:key});
  assert.equal((await post('/api/workspace/draft',request)).status,409);
  assert.equal(calls.length,0);
});
test('real drafting pipeline uses session credentials, accepted rules and stores no request-side credentials',async t=>{
  const {post,store,calls,base}=await setup(t);
  const preview=await post('/api/workspace/draft/preview',request);
  assert.equal(preview.status,200);assert.equal(preview.data.payload.preferences[0].id,'no-dash');assert.equal(calls.length,0);
  const generated=await post('/api/workspace/draft',{...request,provider:'demo',apiKey:'must-not-persist'});
  assert.equal(generated.status,200);assert.equal(generated.data.demo,false);assert.equal(generated.data.provider,'openai');assert.equal(generated.data.model,'gpt-test');
  assert.ok(!generated.data.draft.includes('—'));assert.equal(generated.data.checks.missingRequired.length,0);
  assert.equal(calls.length,3);assert.ok(calls.every(c=>c.options.credentials.apiKey===key));
  assert.ok(calls.every(c=>!JSON.stringify(c.payload).includes(key)));
  const publicState=await(await fetch(base+'/api/workspace')).json();assert.ok(!JSON.stringify(publicState).includes(key));assert.ok(!JSON.stringify(publicState).includes('must-not-persist'));
  assert.ok(!fs.readFileSync(store.stateFile,'utf8').includes(key));
  const feedback=await post('/api/feedback',{draftId:generated.data.id,verdict:'edited',editType:'style',scope:'mode',note:'Keep the friendly opening.',finalText:'Thanks for the outline. Please keep the tradeoffs clear.'});
  assert.equal(feedback.status,200);assert.equal(feedback.data.profile.preferences.at(-1).status,'proposed');assert.equal(feedback.data.feedback.before,generated.data.draft);
});
test('manual mode choice is required and model suggestion can be overridden',async t=>{
  const {post}=await setup(t);
  const suggestion=await post('/api/workspace/suggest-mode',{...request,relationship:'colleagues'});assert.equal(suggestion.data.modeId,'team');
  const invalid=await post('/api/workspace/draft',{...request,modeId:''});assert.equal(invalid.status,400);
  const good=await post('/api/workspace/draft',request);assert.equal(good.status,200);
});
test('session model selection validates catalog and does not require submitting the key again',async t=>{
  const {post,calls}=await setup(t);
  assert.equal((await post('/api/workspace/model',{modelId:'not-listed'})).status,400);
  assert.equal((await post('/api/workspace/model',{modelId:'gpt-other'})).status,200);
  assert.equal((await post('/api/workspace/draft',request)).data.model,'gpt-other');
  assert.ok(calls.every(c=>c.options.credentials.model==='gpt-other'));
});

test('selected effort reaches planning, drafting and review and is saved with the result',async t=>{
  const {post,calls}=await setup(t);
  assert.equal((await post('/api/workspace/model',{modelId:'gpt-6-astra',effort:'high'})).status,200);
  assert.equal((await post('/api/workspace/draft/preview',request)).data.effort,'high');
  const result=await post('/api/workspace/draft',request);
  assert.equal(result.status,200);assert.equal(result.data.effort,'high');
  assert.equal(calls.length,3);assert.ok(calls.every(call=>call.options.effort==='high'));
  const rejected=await post('/api/workspace/model',{modelId:'gpt-6-astra',effort:'none'});
  assert.equal(rejected.status,400);
});

test('changing effort during inference discards the stale draft',async t=>{
  let release,started;const gate=new Promise(r=>release=r),ready=new Promise(r=>started=r);
  const {post,store}=await setup(t,{complete:async()=>{started();await gate;return {points:[{id:'p1',text:'Keep the tradeoffs.'}],incomingRequests:[],missing:[]};}});
  await post('/api/workspace/model',{modelId:'gpt-6-astra',effort:'low'});
  const pending=post('/api/workspace/draft',request);await ready;
  await post('/api/workspace/model',{modelId:'gpt-6-astra',effort:'medium'});release();
  assert.equal((await pending).status,409);assert.equal(store.readState().drafts.length,0);
});
test('switching or forgetting session access during inference discards stale drafts',async t=>{
  let release,started;const gate=new Promise(r=>release=r),ready=new Promise(r=>started=r);
  const {post,store}=await setup(t,{complete:async(_provider,system)=>{if(system===PLAN_SYSTEM){started();await gate;return {points:[{id:'p1',text:'Keep the tradeoffs.'}],incomingRequests:[],missing:[]};}throw new Error('No subsequent calls allowed');}});
  const pending=post('/api/workspace/draft',request);await ready;
  await post('/api/onboarding/model',{},'DELETE');release();
  const result=await pending;assert.equal(result.status,409);assert.equal(store.readState().drafts.length,0);
});
test('a changed profile during inference is not overwritten by a stale generation',async t=>{
  let release,started;const gate=new Promise(r=>release=r),ready=new Promise(r=>started=r);
  const {post,store}=await setup(t,{complete:async(_provider,system)=>{if(system===PLAN_SYSTEM){started();await gate;return {points:[{id:'p1',text:'Keep the tradeoffs.'}],incomingRequests:[],missing:[]};}if(system===DRAFT_SYSTEM)return {draft:'Please keep the tradeoffs.'};return {contentIssues:[],styleIssues:[],missingPointIds:[],unsupportedClaims:[]};}});
  const pending=post('/api/workspace/draft',request);await ready;
  const current=store.readProfile();current.profile.modes[0].guidance='Preserve detail and a warm opening.';store.saveProfile(current.profile,current.version);release();
  assert.equal((await pending).status,409);assert.equal(store.readState().drafts.length,0);
});
test('comparison keeps labels hidden, uses same factual intent, and never becomes training evidence',async t=>{
  const {post,store,calls}=await setup(t);const before=store.readProfile().version;
  const comparison=await post('/api/workspace/compare',request);assert.equal(comparison.status,200);assert.equal(comparison.data.labels,undefined);assert.equal(comparison.data.demo,false);
  assert.equal(calls.length,6);assert.ok(calls.every(c=>c.payload.intent===request.intent));assert.equal(store.readProfile().version,before);
  assert.equal(store.readState().drafts.length,0);
  const vote=await post('/api/evaluations',{comparisonId:comparison.data.id,choice:'tie',note:'Both retained the context.'});assert.equal(vote.status,200);assert.ok(vote.data.labels.left);
});

test('profile changes stop the next outbound stage instead of retransmitting superseded evidence',async t=>{
  let release,started;const gate=new Promise(r=>release=r),ready=new Promise(r=>started=r);
  const {post,store,calls}=await setup(t,{complete:async(_provider,system)=>{
    if(system===PLAN_SYSTEM){started();await gate;return {points:[{id:'p1',text:'Keep the explanation.'}],incomingRequests:[],missing:[]};}
    if(system===DRAFT_SYSTEM)return {draft:'Keep the explanation of the tradeoffs.'};
    return {contentIssues:[],styleIssues:[],missingPointIds:[],unsupportedClaims:[]};
  }});
  const pending=post('/api/workspace/draft',request);await ready;
  const current=store.readProfile();current.profile.modes[0].guidance='Use the newly reviewed guidance.';store.saveProfile(current.profile,current.version);release();
  const result=await pending;
  assert.equal(result.status,409);
  assert.equal(calls.length,1,'Neither drafting nor review may receive superseded profile material.');
  assert.equal(store.readState().drafts.length,0);
});

test('changing the selected model during critique prevents an otherwise completed draft being stored',async t=>{
  let release,started;const gate=new Promise(r=>release=r),ready=new Promise(r=>started=r);
  const {post,store}=await setup(t,{complete:async(_provider,system)=>{
    if(system===PLAN_SYSTEM)return {points:[{id:'p1',text:'Keep the explanation.'}],incomingRequests:[],missing:[]};
    if(system===DRAFT_SYSTEM)return {draft:'Please keep the explanation of the tradeoffs.'};
    started();await gate;return {contentIssues:[],styleIssues:[],missingPointIds:[],unsupportedClaims:[]};
  }});
  const pending=post('/api/workspace/draft',request);await ready;
  assert.equal((await post('/api/workspace/model',{modelId:'gpt-other'})).status,200);release();
  assert.equal((await pending).status,409);
  assert.equal(store.readState().drafts.length,0);
});

test('draft preview matches the first outbound payload exactly and makes no model call',async t=>{
  const {post,calls}=await setup(t);
  const input={...request,previousDraft:'Thanks. Please retain the tradeoffs.',revision:'warmer',apiKey:'private-field-not-part-of-intent',provider:'anthropic'};
  const preview=await post('/api/workspace/draft/preview',input);
  assert.equal(calls.length,0);
  assert.equal((await post('/api/workspace/draft',input)).status,200);
  assert.deepEqual(calls[0].payload,preview.data.payload);
  assert.equal(calls[0].provider,'openai');
  assert.ok(!JSON.stringify(calls[0].payload).includes('private-field-not-part-of-intent'));
});

test('deleting a selected source while analysis is pending cannot resurrect its examples or preferences',async t=>{
  let release,started;const gate=new Promise(r=>release=r),ready=new Promise(r=>started=r);
  const {post,store}=await setup(t,{complete:async(_provider,_system,payload)=>{
    started();await gate;
    const source=payload.conversations[0],message=source.messages[0];
    return {preferences:[{text:'Keep the explanation.',scope:{type:'channel',value:'email'},sources:[{conversationId:source.id,messageId:message.id,excerpt:message.text.slice(0,40)}]}],modes:[],warnings:[]};
  }});
  const source=store.readState().sources[0];
  const job=await post('/api/workspace/learn',{sourceIds:[source.id]});
  assert.equal(job.status,200);
  const pending=post(`/api/workspace/learn/${job.data.job.id}`,{action:'step'});await ready;
  const removed=await post(`/api/onboarding/sources/${encodeURIComponent(source.id)}`,{},'DELETE');assert.equal(removed.status,200);release();
  const result=await pending;assert.equal(result.status,200);assert.ok(['stale','cancelled'].includes(result.data.job.status));
  assert.equal(store.readState().sources.length,0);
  for(const collection of ['preferences','examples','modes'])assert.ok(store.readProfile().profile[collection].every(item=>!(item.sources||[]).some(ref=>ref.conversationId===source.id)));
});

test('model replacement during learning keeps the batch reviewable and saves no proposals from the old session',async t=>{
  let release,started;const gate=new Promise(r=>release=r),ready=new Promise(r=>started=r);
  const {post,store}=await setup(t,{complete:async(_provider,_system,payload)=>{
    started();await gate;
    const source=payload.conversations[0],message=source.messages[0];
    return {preferences:[{text:'Keep the explanation.',scope:{type:'channel',value:'email'},sources:[{conversationId:source.id,messageId:message.id,excerpt:message.text.slice(0,40)}]}],modes:[],warnings:[]};
  }});
  const source=store.readState().sources[0],before=store.readProfile().version;
  const job=await post('/api/workspace/learn',{sourceIds:[source.id]});
  const pending=post(`/api/workspace/learn/${job.data.job.id}`,{action:'step'});await ready;
  await post('/api/workspace/model',{modelId:'gpt-other'});release();
  const result=await pending;assert.equal(result.status,200);assert.ok(['error','conflict'].includes(result.data.job.status));
  assert.equal(result.data.job.processed,0);
  assert.equal(store.readProfile().version,before);
});

test('source search finds bilingual message content without transferring private text',async t=>{
 const {post,base,store}=await setup(t);
 await post('/api/onboarding/paste',{text:'Subject: Planning\nDanke für die Erklärung. Lass uns den Vorschlag natürlicher formulieren.',authorship:'own'});
 const result=await(await fetch(base+'/api/workspace/search?q='+encodeURIComponent('NATÜRLICHER'))).json();
 assert.equal(result.sourceIds.length,1);
 assert.equal(store.readState().sources.find(s=>s.id===result.sourceIds[0]).title,'Planning');
 assert.deepEqual(Object.keys(result),['sourceIds']);
 assert.ok(!JSON.stringify(result).includes('Vorschlag'));
});
