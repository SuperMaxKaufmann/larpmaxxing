import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../server/storage.mjs';
import {ModelSession} from '../server/model-access.mjs';
import {createApp} from '../server/index.mjs';
import {normalizeImport} from '../server/evidence.mjs';
import {PERSONALITY_ANALYSIS_SYSTEM,PERSONALITY_SYNTHESIS_SYSTEM} from '../server/personalities.mjs';

const syntheticKey='synthetic-personality-test-key';
const details={whenToUse:'Use for collaborative discussions with peers.',boundaries:'Do not assume this tone suits formal requests.',tone:'Thoughtful and direct.',warmth:'Acknowledge the useful work before requesting a revision.',directness:'Make the request explicit without excessive hedging.',detailAndStructure:'Preserve the reason behind the request and use short paragraphs.',languageGuidance:'Follow the supplied English or German context independently.',openingsAndClosings:'Use a brief acknowledgment; keep closings proportionate.',vocabulary:'Use familiar concrete wording.',do:'Explain what would help the reader.',avoid:'Do not invent dates or commitments.',uncertainty:'Synthetic fixture; no personal quality conclusion.'};
async function setup(t,{complete}={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'larp-personality-http-')),store=new Store(dir),calls=[];
  const session=new ModelSession({verifier:async({provider})=>({provider,model:'gpt-default',verified:true,validation:'models-list',verifiedAt:new Date().toISOString(),availableModels:[{id:'gpt-default'},{id:'gpt-analysis'},{id:'gpt-6-astra'}],availableModelCount:3})});
  const sources=normalizeImport(Array.from({length:6},(_,i)=>({id:`source-${i}`,source:'gmail',title:`Synthetic group ${i%3}`,messages:[{id:`own-${i}`,role:'user',kind:'sent',text:`Thanks for the useful context in example ${i}. Please keep the explanation of the tradeoffs.`},{id:`own-extra-${i}`,role:'user',kind:'sent',text:`The reasoning in example ${i} helps me understand the next step. Thank you.`}]}))).conversations;
  store.mutate(state=>state.sources=sources.map(source=>({...source,onboardingEligible:true,candidate:false})));
  const responder=async(provider,system,payload,options)=>{
    calls.push({provider,system,payload,options});
    if(complete)return complete(provider,system,payload,options);
    if(system===PERSONALITY_ANALYSIS_SYSTEM)return {observations:[...(payload.previousObservations||[]),...payload.conversations.map(source=>({key:`cluster-${Number(source.id.at(-1))%3}`,summary:'Keep the useful explanation and acknowledge the other person.',usage:'Collaborative discussion.',sources:source.messages.map(message=>({conversationId:source.id,messageId:message.id,excerpt:message.text.slice(0,120)}))}))],warnings:[]};
    if(system===PERSONALITY_SYNTHESIS_SYSTEM)return {personalities:payload.observations.slice(0,3).map((observation,i)=>({name:`Synthetic personality ${i+1}`,description:'When collaborating with peers.',details:{...details,tone:`Thoughtful and direct in synthetic situation ${i+1}.`},language:'en',channel:'email',sources:observation.sources})),warnings:[]};
    throw Error('Unexpected model stage');
  };
  const server=createApp({store,modelSession:session,complete:responder,env:{}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));fs.rmSync(dir,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}`,initial=await(await fetch(base+'/api/onboarding')).json();
  const post=async(route,input={})=>{const response=await fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json','X-Local-Token':initial.csrfToken},body:JSON.stringify(input)});return {status:response.status,data:await response.json()};};
  assert.equal((await post('/api/onboarding/model',{provider:'openai',apiKey:syntheticKey})).status,200);
  return {base,post,store,session,calls};
}

test('baseline endpoint covers every source and uses the selected analysis model without changing drafting model',async t=>{
  const {post,store,session,calls,base}=await setup(t);
  const preview=await post('/api/workspace/personalities/preview');
  assert.equal(preview.status,200);assert.equal(preview.data.counts.sources,6);assert.equal(calls.length,0);
  const created=await post('/api/workspace/personalities',{modelId:'gpt-analysis',apiKey:'must-not-persist'});
  assert.equal(created.status,200);assert.equal(created.data.job.modelId,'gpt-analysis');
  let job=created.data.job;
  for(let i=0;i<30&&job.status==='ready';i++)job=(await post(`/api/workspace/personalities/${job.id}`,{action:'step'})).data.job;
  assert.equal(job.status,'complete');assert.equal(job.personalityIds.length,3);
  assert.equal(session.status.model,'gpt-default');assert.ok(calls.every(call=>call.options.credentials.model==='gpt-analysis'));
  assert.ok(calls.every(call=>call.options.credentials.apiKey===syntheticKey));
  assert.equal(calls.filter(call=>call.system===PERSONALITY_SYNTHESIS_SYSTEM).length,1);
  const seen=new Set(calls.filter(call=>call.system===PERSONALITY_ANALYSIS_SYSTEM).flatMap(call=>call.payload.conversations.map(source=>source.id)));
  assert.equal(seen.size,6);assert.ok(store.readProfile().profile.modes.every(record=>record.status==='proposed'&&record.guidance.includes('### Warmth')));
  const publicState=await(await fetch(base+'/api/workspace')).json();assert.equal(publicState.personalityJobs[0].status,'complete');
  for(const content of [JSON.stringify(publicState),fs.readFileSync(store.stateFile,'utf8')]){assert.ok(!content.includes(syntheticKey));assert.ok(!content.includes('must-not-persist'));}
});

test('baseline model IDs must belong to the connected account',async t=>{
  const {post,calls}=await setup(t);
  assert.equal((await post('/api/workspace/personalities',{modelId:'unavailable'})).status,409);
  assert.equal((await post('/api/workspace/personalities',{})).status,400);
  assert.equal(calls.length,0);
});

test('changing model access during baseline discards the in-flight result',async t=>{
  let release,started;const gate=new Promise(resolve=>release=resolve),ready=new Promise(resolve=>started=resolve);
  const {post,session,store}=await setup(t,{complete:async()=>{started();await gate;return {observations:[],warnings:[]};}});
  const {data:{job}}=await post('/api/workspace/personalities',{modelId:'gpt-analysis'});
  const pending=post(`/api/workspace/personalities/${job.id}`,{action:'step'});await ready;session.clear();release();
  const result=await pending;assert.ok(['error','conflict'].includes(result.data.job.status));assert.equal(result.data.job.processedBatches,0);assert.equal(store.readProfile().profile.modes.length,0);
});

test('HTTP effort controls reach every baseline step independently of default generation settings',async t=>{
  const {post,session,calls,store}=await setup(t);
  assert.equal((await post('/api/workspace/model',{modelId:'gpt-6-astra',effort:'low'})).status,200);
  let job=(await post('/api/workspace/personalities',{modelId:'gpt-6-astra',effort:'high'})).data.job;
  assert.equal(job.effort,'high');
  for(let i=0;i<10&&job.status==='ready';i++)job=(await post(`/api/workspace/personalities/${job.id}`,{action:'step'})).data.job;
  assert.equal(job.status,'complete');
  assert.ok(calls.length>1&&calls.every(call=>call.options.effort==='high'));
  assert.equal(session.status.effort,'low');
  assert.equal(store.readProfile().profile.modes[0].baseline.effort,'high');
});

test('resume can change effort while preserving analyzed batches and rejects invalid settings before mutation',async t=>{
  const {post,calls,store}=await setup(t);
  let job=(await post('/api/workspace/personalities',{modelId:'gpt-6-astra',effort:'medium'})).data.job;
  const route=`/api/workspace/personalities/${job.id}`;
  job=(await post(route,{action:'step'})).data.job;
  assert.equal(job.processedBatches,1);
  await post(route,{action:'cancel'});
  const before=fs.readFileSync(store.stateFile,'utf8');
  assert.equal((await post(route,{action:'resume',effort:'ultra'})).status,400);
  assert.equal(fs.readFileSync(store.stateFile,'utf8'),before);
  assert.equal((await post(route,{action:'step',effort:'low'})).status,400);
  job=(await post(route,{action:'resume',effort:'low'})).data.job;
  assert.equal(job.processedBatches,1);assert.equal(job.effort,'low');
  job=(await post(route,{action:'step'})).data.job;
  assert.equal(job.processedBatches,2);
  assert.deepEqual(calls.map(call=>call.options.effort),['medium','low']);
  assert.equal((await post('/api/workspace/personalities',{modelId:'gpt-default',effort:'high'})).status,400);
  assert.equal(calls.length,2);
});
