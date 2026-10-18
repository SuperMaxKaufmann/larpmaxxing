import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {Store} from '../server/storage.mjs';
import {createApp} from '../server/index.mjs';
import {ModelSession} from '../server/model-access.mjs';
import {PLAN_SYSTEM,DRAFT_SYSTEM} from '../server/drafting.mjs';
async function app(t, {generate}={}) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ownwords-http-'));const store=new Store(dir);const modelSession=new ModelSession({verifier:async()=>({provider:'openai',model:'gpt-test',verified:true,validation:'models-list',verifiedAt:new Date().toISOString(),availableModelCount:1,availableModels:[{id:'gpt-test'}]})});await modelSession.verify({provider:'openai',apiKey:'synthetic-http-test-key'});const server=createApp({store,modelSession,complete:async(_provider,system,payload)=>system===PLAN_SYSTEM?{incomingRequests:[],points:[{id:'p1',text:payload.intent}],missing:[]}:system===DRAFT_SYSTEM?{draft:payload.intent}:{contentIssues:[],styleIssues:[],missingPointIds:[],unsupportedClaims:[]},...(generate?{generate}:{})});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});});
 const base=`http://127.0.0.1:${server.address().port}`;const state=await(await fetch(base+'/api/state')).json();
 const post=async(route,input={},method='POST')=>fetch(base+route,{method,headers:{'Content-Type':'application/json','X-Local-Token':state.csrfToken},body:JSON.stringify(input)});
 await post('/api/onboarding/paste',{text:'Thanks for the outline. I appreciate the explanation.',authorship:'own'});
 return {base,store,post,state};
}
test('loopback HTTP boundaries block cross-site writes, rebinding hosts and private files',async t=>{
 const {base}=await app(t);
 assert.equal((await fetch(base+'/api/state',{headers:{Origin:'https://evil.example'}})).status,403);
 const rebinding=await new Promise((resolve,reject)=>{const req=http.get(base+'/api/state',{headers:{Host:'evil.example'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);});assert.equal(rebinding,403);
 assert.equal((await fetch(base+'/api/import',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);
 assert.equal((await fetch(base+'/.env')).status,404);assert.equal((await fetch(base+'/server/index.mjs')).status,404);
 const res=await fetch(base+'/');assert.equal(res.status,200);assert.ok(res.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
});
test('complete import-review-mode-draft-feedback workflow stays independent of live credentials',async t=>{
 const {post,base}=await app(t);
 const imported=await(await post('/api/import',{input:'Never use em dashes.',kind:'explicit-preference',source:'manual'})).json();assert.ok(imported.job.id);
 await post(`/api/jobs/${imported.job.id}`,{action:'step'});
 let state=await(await fetch(base+'/api/state')).json();await post('/api/extract',{sourceIds:state.sources.map(s=>s.id)});
 state=await(await fetch(base+'/api/state')).json();assert.ok(state.profile.preferences.length);
 state.profile.preferences.forEach(p=>p.status='accepted');state.profile.modes.push({id:'mode1',name:'Work',guidance:'Be warm and preserve details.',status:'accepted'});
 assert.equal((await post('/api/profile',{profile:state.profile,version:state.profileVersion})).status,200);
 const request={intent:'Thank you — please send the revised outline.',context:'',channel:'email',language:'en',modeId:'mode1',provider:'demo',requiredPhrases:['revised outline']};
 const preview=await(await post('/api/draft/preview',request)).json();assert.ok(preview.payload.preferences.length);assert.ok(!JSON.stringify(preview).includes('API_KEY'));
 const result=await(await post('/api/draft',request)).json();assert.equal(result.demo,false);assert.ok(!result.draft.includes('—'));assert.equal(result.checks.missingRequired.length,0);
 const feedback=await(await post('/api/feedback',{draftId:result.id,finalText:result.draft,verdict:'approved',editType:'style',scope:'mode',note:'Preserve a warm thank you.'})).json();assert.equal(feedback.profile.preferences.at(-1).status,'proposed');assert.equal(feedback.profile.examples.at(-1).kind,'approved');
});
test('held-out comparisons do not enter profile and labels remain hidden until judgment',async t=>{
 const {post,base,store}=await app(t);const current=store.readProfile();current.profile.modes.push({id:'one',name:'One',guidance:'Warm.',status:'accepted'});store.saveProfile(current.profile,current.version);
 const cases=await(await fetch(base+'/api/heldout')).json();const compared=await(await post('/api/compare',{caseId:cases.cases[0].id,modeId:'one',provider:'demo'})).json();assert.ok(compared.id);assert.equal(compared.labels,undefined);assert.equal(compared.demo,false);
 assert.equal(store.readState().sources.length,1);assert.equal(store.readProfile().profile.examples.length,0);
 const evaluated=await(await post('/api/evaluations',{comparisonId:compared.id,choice:'tie',note:'Demo only.'})).json();assert.ok(evaluated.labels.left);assert.equal(evaluated.demo,false);
});

test('profile changes during inference prevent stale evidence or obsolete rules from being saved',async t=>{
 let release,started;
 const gate=new Promise(r=>release=r),ready=new Promise(r=>started=r);
 const {post,store}=await app(t,{generate:async()=>{started();await gate;return {id:'stale',draft:'Old profile result',appliedPreferences:[],usedExamples:[]};}});
 const pending=post('/api/draft',{intent:'Synthetic content.',modeId:'synthetic',channel:'email',language:'en'});await ready;
 const current=store.readProfile();current.profile.preferences.push({id:'new',text:'Never use em dashes.',scope:{type:'global',value:''},category:'hard',status:'accepted',banned:['—']});store.saveProfile(current.profile,current.version);
 release();const response=await pending;assert.equal(response.status,409);assert.equal(store.readState().drafts.length,0);
});

test('OAuth return can navigate to the public shell while cross-site APIs remain blocked',async t=>{
 const {base,state}=await app(t);
 const request=(pathname,headers={},method='GET')=>new Promise((resolve,reject)=>{
  const req=http.request(base+pathname,{method,headers},res=>{let text='';res.setEncoding('utf8');res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve({status:res.statusCode,type:res.headers['content-type'],text}));});req.on('error',reject);req.end();
 });
 const navigation={'sec-fetch-site':'cross-site','sec-fetch-mode':'navigate','sec-fetch-dest':'document'};
 for(const page of ['/?connected=chatgpt','/?connection_error=chatgpt','/?connected=gmail','/index.html','/setup']) {
  const response=await request(page,navigation);assert.equal(response.status,200);assert.match(response.type,/text\/html/);assert.ok(!response.text.includes(state.csrfToken));
 }
 for(const route of ['/api/onboarding','/api/state','/api/profile/markdown','/api/workspace','/api/onboarding/chatgpt']) {
  assert.equal((await request(route,navigation)).status,403);
  assert.equal((await request(route,{...navigation,Origin:'https://auth.openai.com','X-Local-Token':state.csrfToken},'POST')).status,403);
 }
 assert.equal((await request('/',{...navigation,'sec-fetch-mode':'cors','sec-fetch-dest':'empty'})).status,403);
 assert.equal((await request('/',{...navigation,'sec-fetch-dest':'iframe'})).status,403);
 assert.equal((await request('/',navigation,'POST')).status,403);
 assert.equal((await request('/',{...navigation,Host:'evil.example'})).status,403);
 assert.equal((await request('/chatgpt-auth.json',navigation)).status,403);
});
