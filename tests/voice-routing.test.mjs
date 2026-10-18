import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../server/storage.mjs';
import {normalizeImport} from '../server/evidence.mjs';
import {ModelSession} from '../server/model-access.mjs';
import {createApp} from '../server/index.mjs';
import {PersonalitiesService,PERSONALITY_ANALYSIS_SYSTEM,PERSONALITY_SYNTHESIS_SYSTEM,assertPersonalityLimit} from '../server/personalities.mjs';
import {PLAN_SYSTEM,DRAFT_SYSTEM,REVIEW_SYSTEM,ROUTE_SYSTEM,routeDraft,needsRouting,GLOBAL_CONTEXT_ID} from '../server/drafting.mjs';
import {ADJUST_SYSTEM,checkProposal} from '../server/adjust.mjs';

const tempStore=t=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'larp-voice-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return new Store(dir);};
const mode=(id,extra={})=>({id,name:`Personality ${id}`,description:`For ${id}.`,guidance:`### Tone\nWarm with ${id}.`,status:'accepted',...extra});
const fields=(lang)=>lang==='de'
  ?{whenToUse:'Für Vorgesetzte und unbekannte ältere Kontakte.',boundaries:'Nicht für Freunde.',tone:'Höflich und klar.',warmth:'Freundlich, aber zurückhaltend.',directness:'Direkt mit Begründung.',languageGuidance:'Sie, außer die andere Person bietet das Du an.',openingsAndClosings:'Guten Tag … / Viele Grüße'}
  :{whenToUse:'For bosses and unfamiliar senior contacts.',boundaries:'Not for friends.',tone:'Polite and clear.',warmth:'Friendly but reserved.',directness:'Direct, with reasons.',openingsAndClosings:'Hi … / Best'};

test('routing fills automatic choices from the model and keeps the user’s fixed ones',async()=>{
  const profile={preferences:[],examples:[],modes:[mode('boss',{languages:['de','en'],audience:['boss']}),mode('friends'),mode('old',{status:'rejected'})]};
  let seen;
  const complete=async(system,payload)=>{seen={system,payload};return {modeId:'boss',channel:'whatsapp',language:'de',formality:'Sie',reason:'German message to a supervisor.'};};
  const routed=await routeDraft(profile,{intent:'Kurze Rückmeldung zum Termin',context:'Sehr geehrter Herr …'},complete);
  assert.equal(seen.system,ROUTE_SYSTEM);
  assert.deepEqual(seen.payload.personalities.map(p=>p.id),['boss','friends'],'only accepted personalities are offered');
  assert.deepEqual(routed,{modeId:'boss',channel:'whatsapp',language:'de',formality:'Sie',reason:'German message to a supervisor.',automatic:['modeId','channel','language','formality']});
  const fixed=await routeDraft(profile,{intent:'x',modeId:'friends',channel:'email'},complete);
  assert.equal(fixed.modeId,'friends');assert.equal(fixed.channel,'email');assert.deepEqual(fixed.automatic,['language','formality']);
  const english=await routeDraft(profile,{intent:'x'},async()=>({modeId:'friends',channel:'slack',language:'en',formality:'Sie'}));
  assert.equal(english.formality,'auto','du/Sie applies only to German');
  await assert.rejects(routeDraft(profile,{intent:'x'},async()=>({modeId:'old',channel:'email',language:'en'})),/could not choose/);
  await assert.rejects(routeDraft({preferences:[],examples:[],modes:[]},{intent:'x'},complete),/accepted personality/);
  assert.equal(needsRouting({modeId:'boss',channel:'email',language:'en'}),false);
  assert.equal(needsRouting({modeId:'boss',channel:'auto',language:'en'}),true);
});

test('German personalities are written in German, bilingual ones per language, never per channel',async t=>{
  const store=tempStore(t);
  store.mutate(state=>{state.sources=normalizeImport([{id:'a',title:'Synthetic',source:'gmail',messages:[{id:'a1',role:'user',kind:'sent',text:'Guten Tag, vielen Dank für die Unterlagen.'},{id:'a2',role:'user',kind:'sent',text:'Hi, thanks for the update, that helps.'}]}]).conversations;state.sources[0].audience='my boss';});
  let analysisPayload;
  const refs=payload=>payload.conversations.flatMap(c=>c.messages.map(m=>({conversationId:c.id,messageId:m.id,excerpt:m.text.slice(0,30)})));
  const service=new PersonalitiesService(store,{complete:async(system,payload)=>{
    if(system===PERSONALITY_ANALYSIS_SYSTEM){analysisPayload=payload;return {observations:[{key:'Vorgesetzte',summary:'Höflich und klar.',usage:'Vorgesetzte',sources:refs(payload),conflictingEvidence:[]}]};}
    const sources=payload.observations[0].sources;
    return {personalities:[
      {name:'Vorgesetzte und Ältere',description:'Für Vorgesetzte und unbekannte ältere Kontakte.',audience:['boss','senior contacts'],languages:['de','en'],primaryLanguage:'de',formality:'Sie',guidance:{de:fields('de'),en:fields('en')},channel:'email',sources},
      {name:'Nur Deutsch',description:'Für Familie.',audience:['family'],languages:['de'],primaryLanguage:'de',guidance:{de:{...fields('de'),whenToUse:'Für die Familie.'}},sources},
    ]};
  }});
  let job=service.create({provider:'openai',modelId:'synthetic'});
  while(job.status==='ready')job=await service.act(job.id);
  assert.equal(analysisPayload.conversations[0].audience,'my boss','the user’s note reaches the analysis');
  assert.match(PERSONALITY_SYNTHESIS_SYSTEM,/Never translate/);
  const [bilingual,german]=store.readProfile().profile.modes;
  assert.match(bilingual.guidance,/^## Deutsch\n\n### Wann passend\nFür Vorgesetzte/);assert.match(bilingual.guidance,/### Ton\nHöflich und klar\./);
  assert.match(bilingual.guidance,/## English\n\n### When to use\nFor bosses/);assert.match(bilingual.guidance,/### Tone\nPolite and clear\./);
  assert.match(bilingual.guidance,/### Ausführlichkeit und Aufbau\nAus den importierten Nachrichten nicht ableitbar/);
  assert.deepEqual(bilingual.languages,['de','en']);assert.equal(bilingual.language,'');assert.equal(bilingual.channel,'');assert.equal(bilingual.relationship,'boss, senior contacts');
  assert.ok(!/^## /m.test(german.guidance),'a single-language personality has no language headings');
  assert.match(german.guidance,/### Wann passend\nFür die Familie\./);assert.equal(german.language,'de');
});

test('baselines respect the limit of five and replace earlier unreviewed proposals',async t=>{
  const store=tempStore(t);
  store.mutate(state=>{state.sources=normalizeImport([{id:'a',title:'S',source:'gmail',messages:[{id:'a1',role:'user',kind:'sent',text:'Thanks, this explanation helps a lot.'},{id:'a2',role:'user',kind:'sent',text:'Could you keep the context visible?'}]}]).conversations;});
  const current=store.readProfile();
  current.profile.modes=[mode('one'),mode('two'),mode('three'),mode('four',{status:'edited'}),mode('stale',{status:'proposed',baseline:{jobId:'old'}}),mode('gone',{status:'rejected'})];
  store.saveProfile(current.profile,current.version);
  let target;
  const service=new PersonalitiesService(store,{complete:async(system,payload)=>{
    if(system===PERSONALITY_ANALYSIS_SYSTEM)return {observations:[{key:'k',summary:'Warm.',usage:'u',sources:payload.conversations.flatMap(c=>c.messages.map(m=>({conversationId:c.id,messageId:m.id,excerpt:m.text.slice(0,20)}))),conflictingEvidence:[]}]};
    target=payload.targetPersonalities;
    return {personalities:['New A','New B'].map(name=>({name,description:`For ${name}.`,languages:['en'],guidance:{en:{...fields('en'),tone:`Tone ${name}.`}},sources:payload.observations[0].sources}))};
  }});
  let job=service.create({provider:'openai',modelId:'synthetic'});
  while(job.status==='ready')job=await service.act(job.id);
  assert.deepEqual(target,{min:1,max:1});
  const names=store.readProfile().profile.modes.map(m=>m.name);
  assert.ok(!names.includes('Personality stale'),'the unreviewed proposal was replaced');
  assert.deepEqual(names.filter(n=>n.startsWith('New')),['New A']);
  assert.match(job.warnings.join(' '),/Only 1 of 2 new personalities fit the limit of 5/);
  const full=store.readProfile();full.profile.modes.find(m=>m.name==='New A').status='accepted';store.saveProfile(full.profile,full.version);
  assert.throws(()=>service.create({provider:'openai',modelId:'other'}),/already have 5/);
  const profile=store.readProfile().profile;
  assert.throws(()=>assertPersonalityLimit({...profile,modes:[...profile.modes,mode('six')]},profile),/at most 5/);
  assert.doesNotThrow(()=>assertPersonalityLimit({...profile,modes:[...profile.modes,mode('seven',{status:'rejected'})]},profile));
});

test('feedback agent proposals are checked before anything changes',()=>{
  const profile={preferences:[],examples:[],modes:[mode('boss'),mode('friends'),mode('off',{status:'disabled'})]};
  assert.throws(()=>checkProposal({action:'delete_everything',revisionInstruction:'x'},profile,'boss'),/usable suggestion/);
  assert.throws(()=>checkProposal({action:'this_message_only'},profile,'boss'),/how to fix/);
  assert.throws(()=>checkProposal({action:'update_personality',guidance:'### Tone\nAlways mention the offer of €500 from 2026-11-01.',revisionInstruction:'x'},profile,'boss'),/details from this conversation/);
  assert.throws(()=>checkProposal({action:'switch_personality',personalityId:'off',revisionInstruction:'x'},profile,'boss'),/not available/);
  const update=checkProposal({action:'update_personality',guidance:'### Tone\nRelaxed, no “Dear”.',reason:'Recurs with your boss.',revisionInstruction:'Drop the formal greeting.'},profile,'boss');
  assert.equal(update.before,'### Tone\nWarm with boss.');assert.equal(update.personalityName,'Personality boss');
});

async function workspace(t,respond) {
  const store=tempStore(t),calls=[];
  const session=new ModelSession({verifier:async({provider})=>({provider,model:'gpt-test',verified:true,validation:'models-list',verifiedAt:new Date().toISOString(),availableModelCount:1,availableModels:[{id:'gpt-test'}]})});
  const complete=async(provider,system,payload)=>{calls.push({system,payload});return respond(system,payload);};
  const server=createApp({store,env:{},modelSession:session,complete});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`;
  const {csrfToken}=await(await fetch(base+'/api/onboarding')).json();
  const call=async(route,input={},method='POST')=>{const response=await fetch(base+route,{method,headers:{'Content-Type':'application/json','X-Local-Token':csrfToken},body:JSON.stringify(input)});return {status:response.status,data:await response.json()};};
  await call('/api/onboarding/model',{provider:'openai',apiKey:'synthetic-key'});
  const pasted=await call('/api/onboarding/paste',{authorship:'own',audience:'my boss',text:'Thanks for explaining the tradeoffs. The context helps me decide.'});
  assert.equal(pasted.data.sources[0].audience,'my boss');
  await call('/api/onboarding/start');
  const current=store.readProfile();
  current.profile.modes.push(mode('boss',{audience:['boss'],languages:['de']}),mode('friends'));
  store.saveProfile(current.profile,current.version);
  return {store,call,calls};
}
const drafting=(extra={})=>(system,payload)=>{
  if(system===ROUTE_SYSTEM)return {modeId:'boss',channel:'slack',language:'de',formality:'du',reason:'Chat with your supervisor.'};
  if(system===PLAN_SYSTEM)return {incomingRequests:[],points:[{id:'p1',text:payload.intent}],missing:[]};
  if(system===DRAFT_SYSTEM)return {draft:'Danke dir, passt so.'};
  if(system===REVIEW_SYSTEM)return {contentIssues:[],styleIssues:[],missingPointIds:[],unsupportedClaims:[]};
  if(system===ADJUST_SYSTEM)return extra.adjust(payload);
  throw new Error('unexpected request');
};

test('drafts choose personality, channel and language automatically and use the global context',async t=>{
  const {call,calls,store}=await workspace(t,drafting());
  const before=store.readProfile();
  assert.equal((await call('/api/workspace/global-context',{text:'Ich heiße Max. Ich unterschreibe mit „Max“.',version:before.version})).status,200);
  const preview=await call('/api/workspace/draft/preview',{intent:'Danke, passt.'});
  assert.equal(preview.data.payload,null);assert.equal(preview.data.routing.system,ROUTE_SYSTEM);
  const draft=await call('/api/workspace/draft',{intent:'Danke, passt.',context:'Kannst du das bis Freitag prüfen?'});
  assert.equal(draft.status,200,JSON.stringify(draft.data));
  assert.deepEqual(calls.map(c=>c.system),[ROUTE_SYSTEM,PLAN_SYSTEM,DRAFT_SYSTEM,REVIEW_SYSTEM]);
  assert.deepEqual({modeId:draft.data.request.modeId,channel:draft.data.request.channel,language:draft.data.request.language,formality:draft.data.request.formality},{modeId:'boss',channel:'slack',language:'de',formality:'du'});
  assert.equal(draft.data.routing.modeName,'Personality boss');
  assert.match(calls[2].payload.globalContext,/Ich heiße Max/);
  assert.ok(!calls[2].payload.preferences.some(p=>p.id===GLOBAL_CONTEXT_ID),'the global context is not duplicated as a rule');
  calls.length=0;
  await call('/api/workspace/draft',{intent:'Danke.',modeId:'friends',channel:'email',language:'en'});
  assert.equal(calls[0].system,PLAN_SYSTEM,'fully chosen drafts skip routing');
});

test('the feedback agent adjusts the personality, the global context, or switches personality on request',async t=>{
  let reply;
  const {call,calls,store}=await workspace(t,drafting({adjust:payload=>reply(payload)}));
  const draft=(await call('/api/workspace/draft',{intent:'Danke, passt.'})).data;
  reply=payload=>{assert.equal(payload.personality.id,'boss');assert.equal(payload.complaint,'Viel zu steif für meinen Chef.');assert.deepEqual(payload.otherPersonalities.map(p=>p.id),['friends']);
    return {action:'update_personality',reason:'Das betrifft jede Nachricht an deinen Chef.',guidance:'### Ton\nLocker, ohne „Sehr geehrter“.',revisionInstruction:'Make it less stiff.'};};
  const asked=await call('/api/workspace/adjust',{draftId:draft.id,draftText:'Danke dir, passt so.',complaint:'Viel zu steif für meinen Chef.'});
  assert.equal(asked.status,200);assert.equal(calls.at(-1).system,ADJUST_SYSTEM);
  assert.equal(store.readProfile().profile.modes.find(m=>m.id==='boss').guidance,'### Tone\nWarm with boss.','nothing changes before apply');
  const applied=await call('/api/workspace/adjust/apply',{proposal:asked.data.proposal,version:asked.data.profileVersion});
  assert.deepEqual(applied.data.modeId,'boss');assert.equal(applied.data.revisionInstruction,'Make it less stiff.');assert.equal(applied.data.restart,false);
  const boss=store.readProfile().profile.modes.find(m=>m.id==='boss');
  assert.equal(boss.guidance,'### Ton\nLocker, ohne „Sehr geehrter“.');assert.equal(boss.status,'edited');
  assert.match(store.readState().history.at(-1).reason,/Adjusted personality/);
  assert.equal((await call('/api/workspace/adjust/apply',{proposal:asked.data.proposal,version:asked.data.profileVersion})).status,409,'a stale proposal is refused');
  reply=()=>({action:'update_global',reason:'Gilt für alle Nachrichten.',globalContext:'Ich unterschreibe immer mit „Max“.',revisionInstruction:'Sign with Max.'});
  const global=await call('/api/workspace/adjust',{draftId:draft.id,draftText:'x',complaint:'Ich unterschreibe immer mit Max.'});
  await call('/api/workspace/adjust/apply',{proposal:global.data.proposal,version:global.data.profileVersion});
  assert.equal(store.readProfile().profile.preferences.find(p=>p.id===GLOBAL_CONTEXT_ID).text,'Ich unterschreibe immer mit „Max“.');
  reply=()=>({action:'switch_personality',personalityId:'friends',reason:'This is for a friend.',revisionInstruction:'Rewrite for a friend.'});
  const version=store.readProfile().version;
  const switched=await call('/api/workspace/adjust',{draftId:draft.id,draftText:'x',complaint:'This is for my friend.'});
  const result=await call('/api/workspace/adjust/apply',{proposal:switched.data.proposal,version:switched.data.profileVersion});
  assert.equal(result.data.modeId,'friends');assert.equal(result.data.restart,true);assert.equal(store.readProfile().version,version,'switching saves nothing');
  assert.equal((await call('/api/workspace/adjust',{draftId:'missing',draftText:'x',complaint:'y'})).status,404);
});
