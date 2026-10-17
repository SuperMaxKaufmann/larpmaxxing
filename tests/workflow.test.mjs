import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../server/storage.mjs';
import {createImport,stepImport,extractSelected,deleteSource,recordFeedback} from '../server/workflow.mjs';
import {selectContext} from '../server/drafting.mjs';
const setup=t=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ownwords-workflow-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return new Store(dir);};
const mode={id:'team',name:'Colleagues',guidance:'Be warm and concrete.',status:'accepted'};
const draft={id:'draft1',draft:'Thanks, I will take a look.',modeId:'team',request:{intent:'Thank them and say I will review it.',language:'en',channel:'email',recipient:'Alex'}};

test('batch imports persist progress, cancel, resume after restart and deduplicate exports',t=>{
 const store=setup(t);const conversations=Array.from({length:45},(_,i)=>({id:`c${i}`,title:`reply ${i}`,source:'manual',messages:[{id:`m${i}`,role:'user',text:'Always avoid formulaic openings.',kind:'explicit-preference'}]}));
 const job=createImport(store,{conversations});assert.equal(job.total,45);
 assert.equal(stepImport(store,job.id).processed,20);
 assert.equal(stepImport(store,job.id,'cancel').status,'cancelled');
 assert.equal(stepImport(store,job.id).processed,20);
 const reopened=new Store(store.dir);stepImport(reopened,job.id,'resume');stepImport(reopened,job.id);assert.equal(stepImport(reopened,job.id).status,'complete');
 const repeat=createImport(reopened,{conversations});while(stepImport(reopened,repeat.id).status!=='complete'){}
 assert.equal(reopened.readState().sources.length,45);assert.equal(reopened.readState().jobs.at(-1).duplicates,45);
});
test('selected date ranges and exclusions prevent disallowed conversations from persisting',t=>{
 const store=setup(t);
 const job=createImport(store,{conversations:[{id:'old',title:'reply',date:'2020-01-01',messages:[]},{id:'exclude',title:'medical reply',date:'2026-05-01',messages:[]},{id:'yes',title:'Reply to colleague',date:'2026-05-01',messages:[]}]},{filters:{after:'2026-01-01',exclude:['medical']}});
 const result=stepImport(store,job.id);assert.equal(result.excluded,2);assert.deepEqual(store.readState().sources.map(x=>x.id),['manual:yes']);
});
test('repeated extraction retains user decisions and does not multiply evidence',t=>{
 const store=setup(t);const job=createImport(store,'Always avoid em dashes.',{kind:'explicit-preference'});stepImport(store,job.id);
 const id=store.readState().sources[0].id;
 const first=extractSelected(store,[id]);assert.ok(first.profile.preferences.length);
 first.profile.preferences[0].status='rejected';store.saveProfile(first.profile,first.version);
 const second=extractSelected(store,[id]);assert.equal(second.profile.preferences.length,first.profile.preferences.length);assert.equal(second.profile.preferences[0].status,'rejected');
 assert.equal(second.profile.preferences[0].sources.length,1);
});
test('source deletion removes queued duplicate sources and derived records and clears undo history',t=>{
 const store=setup(t);const job=createImport(store,'Never use em dashes.',{kind:'explicit-preference'});stepImport(store,job.id);
 const id=store.readState().sources[0].id;extractSelected(store,[id]);createImport(store,'Never use em dashes.',{kind:'explicit-preference'});
 deleteSource(store,id,'delete');assert.equal(store.readState().sources.length,0);assert.equal(store.readProfile().profile.preferences.length,0);assert.equal(store.readState().history.length,0);assert.ok(store.readState().jobs.every(j=>!j.queue.some(s=>s.id===id)));
});
test('source deletion removes baseline analysis summaries and personalities influenced by uncited sources',t=>{
 const store=setup(t);const current=store.readProfile();
 store.mutate(state=>{state.sources=[{id:'deleted',messages:[]},{id:'quoted',messages:[]}];state.personalityJobs=[{id:'baseline-job',sourceIds:['deleted','quoted'],observations:[{summary:'Private intermediate evidence'}]},{id:'unrelated',sourceIds:['quoted']}];});
 current.profile.modes.push({id:'baseline',name:'Collaborative',status:'proposed',guidance:'Explain the reasoning.',sources:[{conversationId:'quoted',messageId:'q',excerpt:'Thanks'}],baseline:{sourceIds:['deleted','quoted']}});
 store.saveProfile(current.profile,current.version);
 deleteSource(store,'deleted','delete');
 assert.equal(store.readProfile().profile.modes.length,0);
 assert.deepEqual(store.readState().personalityJobs.map(job=>job.id),['unrelated']);
 assert.ok(!fs.readFileSync(store.stateFile,'utf8').includes('Private intermediate evidence'));
});
test('message-only edits retain before/after without reusable style evidence',t=>{
 const store=setup(t);store.mutate(s=>s.drafts.push(draft));
 const result=recordFeedback(store,{draftId:draft.id,finalText:'Thanks, I will look through it carefully.',verdict:'edited',editType:'style',note:'Keep warmth.',scope:'message'});
 assert.equal(result.profile.preferences.length,0);assert.equal(result.profile.examples.length,0);assert.equal(result.feedback.before,draft.draft);assert.ok(result.feedback.diff.added.length);
});
test('facts-only edits never become a style preference or approved example',t=>{
 const store=setup(t);store.mutate(s=>s.drafts.push(draft));
 const result=recordFeedback(store,{draftId:draft.id,finalText:'Thanks, I can review this on Thursday.',verdict:'edited',editType:'facts',note:'Use Thursday instead of Wednesday.',scope:'global'});
 assert.equal(result.profile.preferences.length,0);assert.equal(result.profile.examples.length,0);
});
test('recipient feedback proposes scoped rules and cannot leak examples into another recipient',t=>{
 const store=setup(t);const current=store.readProfile();current.profile.modes.push(mode);store.saveProfile(current.profile,current.version);store.mutate(s=>s.drafts.push(draft));
 const result=recordFeedback(store,{draftId:draft.id,finalText:'Thanks Alex, I will take a look.',verdict:'approved',editType:'style',note:'Keep a personal thanks for Alex.',scope:'recipient'});
 assert.equal(result.profile.preferences[0].status,'proposed');assert.equal(result.profile.preferences[0].scope.value,'Alex');
 const request={modeId:'team',language:'en',channel:'email',recipient:'Someone else'};
 assert.equal(selectContext(result.profile,request).examples.length,0);assert.equal(selectContext(result.profile,{...request,recipient:'Alex'}).examples.length,1);
});

test('native conversation IDs from different providers remain separate and later approval updates one example',t=>{
 const store=setup(t);
 const incoming={id:'same',title:'Draft',messages:[{id:'u',role:'user',text:'Write a reply.'},{id:'a',role:'assistant',text:'Hello, thanks for your message.',parentId:'u'}]};
 for(const source of ['chatgpt','claude']) {const job=createImport(store,{conversations:[{...incoming,source}]});stepImport(store,job.id);}
 assert.equal(store.readState().sources.length,2);assert.notEqual(store.readState().sources[0].id,store.readState().sources[1].id);
 const firstId=store.readState().sources[0].id;extractSelected(store,[firstId]);
 const before=store.readProfile().profile.examples.find(e=>e.kind==='ai-unknown');assert.ok(before);
 const next=createImport(store,{conversations:[{...incoming,source:'chatgpt',messages:[...incoming.messages,{id:'approved',role:'user',text:'Perfect, send that.',parentId:'a'}]}]});stepImport(store,next.id);extractSelected(store,[firstId]);
 const same=store.readProfile().profile.examples.filter(e=>e.id===before.id);assert.equal(same.length,1);assert.equal(same[0].kind,'approved');assert.equal(same[0].status,'proposed');
});
