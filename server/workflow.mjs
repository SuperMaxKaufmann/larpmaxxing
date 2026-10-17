import {normalizeImport,discover,extractEvidence,proposeModes} from './evidence.mjs';
import {uid,hash} from './storage.mjs';

export const jobSummary = ({queue,...job}) => job;
export function createImport(store, input, options={}) {
  const normalized=normalizeImport(input,options);
  normalized.conversations=normalized.conversations.map(c=>({...c,...(options.onboardingEligible?{onboardingEligible:true}:{}),nativeId:c.nativeId||c.id,id:c.id.startsWith(`${c.source}:`)?c.id:`${c.source}:${c.id}`}));
  if (!normalized.conversations.length) throw new Error('No conversations could be read. Use a supported JSON export, a labeled transcript, or an explicit manual evidence type.');
  const job={id:uid(),title:options.title||'Imported evidence',status:'ready',total:normalized.conversations.length,processed:0,added:0,duplicates:0,excluded:0,warnings:normalized.warnings||[],date:new Date().toISOString(),queue:normalized.conversations,filters:options.filters||{}};
  store.mutate(s=>s.jobs.push(job));
  return jobSummary(job);
}
export function stepImport(store,id,action='step') {
  return store.mutate(s=>{
    const job=s.jobs.find(j=>j.id===id);if(!job)throw new Error('Import job not found.');
    if(action==='cancel') {job.status='cancelled';return jobSummary(job);}
    if(action==='resume') {if(job.processed<job.total)job.status='ready';return jobSummary(job);}
    if(action!=='step')throw new Error('Unknown import action.');
    if(['cancelled','complete'].includes(job.status))return jobSummary(job);
    job.status='running';
    const batch=job.queue.slice(0,20);
    for(const conversation of batch) {
      const discovery=discover(conversation,job.filters);
      if(discovery.excluded){job.excluded++;job.processed++;continue;}
      const existing=s.sources.find(c=>c.id===conversation.id);
      if(existing) {
        if(conversation.onboardingEligible)existing.onboardingEligible=true;
        const ids=new Set(existing.messages.map(m=>m.id));
        const additions=conversation.messages.filter(m=>!ids.has(m.id));
        existing.messages.push(...additions);
        if(['gmail','slack'].includes(existing.source)&&existing.messages.every(m=>m.date&&Number.isFinite(Date.parse(m.date))))existing.messages.sort((a,b)=>Date.parse(a.date)-Date.parse(b.date));
        if(additions.length) {existing.discovery=discover(existing,job.filters);existing.candidate=existing.discovery.candidate;}
        job.duplicates++;
      } else {s.sources.push({...conversation,discovery,candidate:discovery.candidate});job.added++;}
      job.processed++;
    }
    job.queue.splice(0,batch.length);
    if(job.processed>=job.total)job.status='complete';
    return jobSummary(job);
  });
}
function mergeRecords(existing,proposed) {
  for(const record of proposed) {
    const match=existing.find(x=>x.id===record.id || (x.text===record.text&&JSON.stringify(x.scope)===JSON.stringify(record.scope)&&x.kind===record.kind));
    if(!match)existing.push(record);
    else {
      if(record.kind && match.status==='proposed')match.kind=record.kind;
      if(record.approvalConflict)match.approvalConflict=true;
      const sources=new Set((match.sources||[]).map(r=>`${r.conversationId}:${r.messageId}`));
      for(const source of record.sources||[])if(!sources.has(`${source.conversationId}:${source.messageId}`)){(match.sources??=[]).push(source);sources.add(`${source.conversationId}:${source.messageId}`);}
    }
  }
}
export function extractSelected(store,sourceIds) {
  if(!Array.isArray(sourceIds)||!sourceIds.length)throw new Error('Select at least one source.');
  const state=store.readState();const current=store.readProfile();const warnings=[];
  for(const id of new Set(sourceIds)) {
    const source=state.sources.find(s=>s.id===id);if(!source)throw new Error('Source not found.');
    const result=extractEvidence(source);
    mergeRecords(current.profile.preferences,result.preferences||[]);
    mergeRecords(current.profile.examples,result.examples||[]);
    warnings.push(...(result.warnings||[]));
  }
  // Preserve contrary explicit directions as separate proposals and flag common opposites across sources.
  for(const a of current.profile.preferences)for(const b of current.profile.preferences) {
    if(a.id===b.id||JSON.stringify(a.scope)!==JSON.stringify(b.scope))continue;
    const pairs=[[/\bshort(?:er)?\b|\bkürzer\b/i,/\bdetail|ausführlich|explanation/i],[/\bcasual\b|locker|weniger förmlich/i,/\bformal\b|förmlich/i]];
    if(pairs.some(([x,y])=>x.test(a.text)&&y.test(b.text))){a.conflicts=[...new Set([...(a.conflicts||[]),b.id])];b.conflicts=[...new Set([...(b.conflicts||[]),a.id])];}
  }
  store.saveProfile(current.profile,current.version,'Extracted evidence for review');
  return {warnings,...store.readProfile()};
}
export function suggestModes(store) {
  const current=store.readProfile();
  const proposals=proposeModes(current.profile.preferences,current.profile.examples);
  for(const mode of proposals) if(!current.profile.modes.some(m=>m.id===mode.id))current.profile.modes.push(mode);
  store.saveProfile(current.profile,current.version,'Proposed evidence-backed personalities');
  return {modes:proposals,warnings:proposals.length?[]:['Evidence is sparse. Add a few reviewed examples, or create a personality yourself.'],...store.readProfile()};
}
export function deleteSource(store,id,derivedAction='disable') {
  if(!['disable','delete'].includes(derivedAction))throw new Error('Choose disable or delete for derived records.');
  const current=store.readProfile();
  const affectedExamples=[];
  for(const collection of ['preferences','examples','modes']) {
    current.profile[collection]=current.profile[collection].filter(record=>{
      const refs=record.sources||[];
      const affected=refs.some(r=>r.conversationId===id)||(record.sourceIds||[]).includes(id)||(record.baseline?.sourceIds||[]).includes(id);
      if(!affected)return true;
      if(collection==='examples')affectedExamples.push(record.id);
      if(derivedAction==='delete')return false;
      record.status='disabled';record.sources=refs.filter(r=>r.conversationId!==id);record.sourceIds=(record.sourceIds||[]).filter(x=>x!==id);
      if(Array.isArray(record.conflictingEvidence))record.conflictingEvidence=record.conflictingEvidence.filter(ref=>ref?.conversationId!==id);
      if(record.baseline?.sourceIds)record.baseline.sourceIds=record.baseline.sourceIds.filter(sourceId=>sourceId!==id);
      record.disabledReason='Supporting source deleted. Review this retained preference before reactivating.';
      return true;
    });
  }
  store.saveProfile(current.profile,current.version,'Source removed');
  store.mutate(s=>{
    s.sources=s.sources.filter(x=>x.id!==id);
    for(const job of s.learningJobs||[])if(job.sourceIds?.includes(id)){job.status='cancelled';job.error='A selected source was removed. Create a new analysis with the remaining sources.';job.sourceIds=job.sourceIds.filter(sourceId=>sourceId!==id);}
    // Baseline jobs contain rolling evidence summaries. Remove the whole affected
    // job so deletion cannot retain or later restore excerpts from that source.
    s.personalityJobs=(s.personalityJobs||[]).filter(job=>!job.sourceIds?.includes(id));
    // Cancelled queues and undo snapshots must not silently resurrect deleted source material.
    for(const job of s.jobs) {const count=job.queue.filter(x=>x.id===id).length;job.queue=job.queue.filter(x=>x.id!==id);job.total-=count;}
    s.history=[];
    s.drafts=s.drafts.filter(d=>!(d.usedExamples||[]).some(x=>affectedExamples.includes(x))&&!(d.appliedPreferences||[]).some(p=>(p.sources||[]).some(r=>r.conversationId===id)));
    s.comparisons=[];
  });
  return {deleted:id,derivedAction,notice:'Source removed; profile undo history cleared so it cannot restore deleted evidence. Disabled derived text is retained only when requested.'};
}
export function recordFeedback(store,input) {
  const state=store.readState();
  const draft=state.drafts.find(d=>d.id===input.draftId);if(!draft)throw new Error('Draft not found.');
  if(!['approved','unsuitable','edited'].includes(input.verdict))throw new Error('Choose a feedback verdict.');
  if(!['style','facts','mixed'].includes(input.editType))throw new Error('Choose whether changes concern style, facts, or both.');
  if(!['message','mode','recipient','global'].includes(input.scope))throw new Error('Choose a feedback scope.');
  const finalText=typeof input.finalText==='string'?input.finalText:draft.draft;
  if(!finalText.trim())throw new Error('Feedback needs a final text.');
  const feedback={id:uid(),date:new Date().toISOString(),draftId:draft.id,before:draft.draft,after:finalText,verdict:input.verdict,editType:input.editType,note:input.note||'',scope:input.scope,modeId:draft.modeId,recipient:draft.request?.recipient||'',diff:lineDiff(draft.draft,finalText)};
  const current=store.readProfile();
  const sources=[{conversationId:`feedback:${feedback.id}`,messageId:draft.id,excerpt:feedback.note||feedback.verdict,date:feedback.date}];
  const exampleScope=input.scope==='global'?{type:'global',value:''}:input.scope==='recipient'?{type:'recipient',value:feedback.recipient}:{type:'mode',value:draft.modeId};
  if(input.scope==='recipient'&&!feedback.recipient)throw new Error('Provide a recipient before saving recipient-specific feedback.');
  if(input.scope!=='message') {
    if(input.verdict==='approved'||(input.verdict==='edited'&&input.editType!=='facts')) {
      current.profile.examples.push({id:uid(),text:finalText,kind:'approved',status:'accepted',scope:exampleScope,sources,date:feedback.date,language:draft.request.language,channel:draft.request.channel,modeId:input.scope==='mode'?draft.modeId:undefined});
    } else if(input.verdict==='unsuitable') current.profile.examples.push({id:uid(),text:finalText,kind:'rejected',status:'accepted',scope:exampleScope,sources,date:feedback.date,language:draft.request.language,channel:draft.request.channel,modeId:input.scope==='mode'?draft.modeId:undefined});
  }
  // Only a deliberate, nonfactual note can propose future guidance. Edits never silently become rules.
  if(input.scope!=='message' && input.editType!=='facts' && feedback.note.trim()) {
    const scope=input.scope==='global'?{type:'global',value:''}:input.scope==='recipient'?{type:'recipient',value:feedback.recipient}:{type:'mode',value:draft.modeId};
    if(!scope.value&&scope.type!=='global')throw new Error('Provide a recipient before saving recipient-specific guidance.');
    current.profile.preferences.push({id:uid(),text:feedback.note,scope,basis:'explicit',status:'proposed',strength:'strong',category:'guidance',banned:[],sources,conflicts:[],date:feedback.date});
  }
  store.saveProfile(current.profile,current.version,'Saved feedback and proposed guidance');
  store.mutate(s=>s.feedback.push(feedback));
  return {feedback,notice:input.scope==='message'?'Feedback retained for this message only. No reusable example or preference was created.':'Feedback saved. Any future guidance is proposed and needs review.',...store.readProfile()};
}
export function lineDiff(before,after) {
  const old=before.split('\n'),next=after.split('\n');
  return {removed:old.filter(x=>!next.includes(x)),added:next.filter(x=>!old.includes(x)),note:'Line comparison. Factual versus stylistic classification is supplied by you, not inferred automatically.'};
}
