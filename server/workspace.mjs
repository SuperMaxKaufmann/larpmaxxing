import {completeJSON} from './providers.mjs';
import {generateDraft,previewDraft,suggestMode} from './drafting.mjs';
import {LearningService} from './learning.mjs';
import {PersonalitiesService} from './personalities.mjs';
import {uid} from './storage.mjs';
import {randomInt} from 'node:crypto';
import {validateEffort} from './model-options.mjs';

const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const text=(value,limit=60000)=>typeof value==='string'?value.slice(0,limit):'';
const sourceSummary=s=>({id:s.id,title:s.title,source:s.source,date:s.date||null,messageCount:s.messages?.length||0,ownMessageCount:(s.messages||[]).filter(m=>m.role==='user'&&m.text?.trim()).length,candidate:!!s.candidate,discovery:s.discovery||{}});

// Explicit allowlist prevents request-side credentials and unrelated fields from being saved with drafts.
function requestFrom(input,provider) {
  if(!input||typeof input!=='object'||Array.isArray(input))throw fail('Provide a drafting request.');
  if(typeof input.intent!=='string'||input.intent.length>30000)throw fail('Enter what you want to say (up to 30,000 characters).');
  if(typeof input.context==='string'&&input.context.length>60000)throw fail('Use up to 60,000 characters of conversation context.');
  if(typeof input.previousDraft==='string'&&input.previousDraft.length>60000)throw fail('Use up to 60,000 characters in the previous draft.');
  if(typeof input.revision==='string'&&input.revision.length>2000)throw fail('Use up to 2,000 characters of revision instructions.');
  return {intent:input.intent,context:text(input.context),channel:input.channel,language:input.language,modeId:text(input.modeId,200),recipient:text(input.recipient,1000),relationship:text(input.relationship,1000),purpose:text(input.purpose,1000),situation:text(input.situation,1000),formality:['du','Sie'].includes(input.formality)?input.formality:'auto',requiredPhrases:input.requiredPhrases||[],previousDraft:text(input.previousDraft),revision:text(input.revision,2000),provider};
}

export class Workspace {
  constructor(store,onboarding,{complete=completeJSON,generate=generateDraft,fetchImpl=globalThis.fetch}={}) {
    this.store=store;this.onboarding=onboarding;this.session=onboarding.modelSession;this.complete=complete;this.generate=generate;this.fetchImpl=fetchImpl;
    this.learning=new LearningService(store,{complete:(system,payload)=>this.completion()(system,payload)});
    this.personalities=new PersonalitiesService(store,{complete:(system,payload,selection)=>this.completion(selection)(system,payload)});
  }
  requireAccess(){this.onboarding.requireModel();}
  requireSource(){this.requireAccess();if(!this.onboarding.getSources().some(s=>s.messages.some(m=>m.role==='user'&&m.text?.trim())))throw fail('Add at least one source containing your writing before using the harness.',409);}
  status(){
    this.requireAccess();
    const current=this.store.readProfile(),state=this.store.readState();
    return {profile:current.profile,profileVersion:current.version,model:this.session.status,sources:state.sources.map(sourceSummary),learningJobs:this.learning.list(),personalityJobs:this.personalities.list(),drafts:state.drafts.slice(-12).reverse(),feedback:state.feedback.slice(-30).reverse(),profileHistory:state.history.map(({id,date,reason})=>({id,date,reason})),notice:'Learning sends bounded excerpts plus reviewed preference and personality summaries. Baseline personality creation analyzes all imported sources in batches, then combines the findings. Drafting sends current intent/context, the selected personality, accepted applicable rules and a few style examples. Nothing is sent automatically.'};
  }
  source(id){this.requireAccess();const source=this.store.readState().sources.find(s=>s.id===id);if(!source)throw fail('Source not found.',404);return source;}
  search(query=''){this.requireAccess();if(typeof query!=='string'||query.length>300)throw fail('Use a search phrase of at most 300 characters.');const needle=query.normalize('NFC').toLowerCase().trim();const matches=this.store.readState().sources.filter(source=>!needle||`${source.title||''} ${source.source||''}`.normalize('NFC').toLowerCase().includes(needle)||(source.messages||[]).some(message=>String(message.text||'').normalize('NFC').toLowerCase().includes(needle)));return {sourceIds:matches.map(source=>source.id)};}
  selectModel(modelId,effort){this.requireAccess();return {model:this.session.selectModel(modelId,effort)};}
  completion({profileVersion,modelId,provider,effort}={}){
    this.requireAccess();const credentials=this.session.getCredentials();
    if(provider&&provider!==credentials?.provider)throw fail('Reconnect the provider selected for this personality baseline before resuming.',409);
    if(modelId){
      if(!this.session.status.availableModels.some(model=>model.id===modelId))throw fail('Choose a model available to the connected account.',409);
      credentials.model=modelId;
    }
    if(!credentials?.model)throw fail('Choose an available generation model first.',409);
    const selectedEffort=validateEffort(credentials.provider,credentials.model,effort===undefined?(modelId?'default':this.session.status.effort):effort);
    const revision=this.session.revision;
    const current=()=>{if(!this.session.isCurrent(revision))throw fail('Model access changed during this request. Nothing was saved; retry with the current model.',409);if(profileVersion&&this.store.readProfile().version!==profileVersion)throw fail('Your writing profile changed during this request. Nothing was saved; review it and generate again.',409);};
    const run=async(system,payload)=>{current();const result=await this.complete(credentials.provider,system,payload,{credentials,effort:selectedEffort,fetchImpl:this.fetchImpl});current();return result;};
    return Object.assign(run,{provider:credentials.provider,model:credentials.model,effort:selectedEffort,current});
  }
  createPersonalities(input){
    this.requireSource();
    if(!input||typeof input.modelId!=='string'||!input.modelId)throw fail('Choose a model for the personality baseline.');
    const selected=this.completion({modelId:input.modelId,effort:input.effort});
    return this.personalities.create({provider:selected.provider,modelId:selected.model,effort:selected.effort});
  }
  suggest(input){this.requireAccess();return suggestMode(this.store.readProfile().profile,input);}
  preview(input){this.requireAccess();const request=requestFrom(input,this.session.status.provider);return {...previewDraft(this.store.readProfile().profile,request),provider:this.session.status.provider,model:this.session.status.model,effort:this.session.status.effort};}
  async draft(input){
    this.requireSource();
    const current=this.store.readProfile();const complete=this.completion({profileVersion:current.version});
    const request=requestFrom(input,complete.provider);
    const result=await this.generate(current.profile,request,{complete:(_provider,system,payload)=>complete(system,payload)});
    complete.current();
    if(this.store.readProfile().version!==current.version)throw fail('Your writing profile changed during drafting. Review it and generate again.',409);
    result.model=complete.model;result.effort=complete.effort;result.profileVersion=current.version;
    if(result.draft)this.store.mutate(state=>state.drafts.push(result));
    return result;
  }
  async compare(input){
    this.requireSource();
    const current=this.store.readProfile();const complete=this.completion({profileVersion:current.version});const request=requestFrom(input,complete.provider);
    const options={complete:(_provider,system,payload)=>complete(system,payload)};
    const personal=await this.generate(current.profile,{...request,personalized:true},options);
    const generic=await this.generate(current.profile,{...request,personalized:false},options);
    complete.current();
    if(personal.needsClarification||generic.needsClarification)throw fail('This comparison needs clarification. Add the missing information to your intent and try again.');
    if(this.store.readProfile().version!==current.version)throw fail('Your profile changed during comparison. Please retry.',409);
    const flip=randomInt(2)===1;
    const comparison={id:uid(),caseId:'personal-comparison',date:new Date().toISOString(),left:flip?personal:generic,right:flip?generic:personal,labels:flip?{left:'personalized',right:'generic'}:{left:'generic',right:'personalized'},profileVersion:current.version,demo:false,model:complete.model,effort:complete.effort};
    this.store.mutate(state=>state.comparisons.push(comparison));
    return {id:comparison.id,left:{draft:comparison.left.draft,checks:comparison.left.checks,review:comparison.left.review},right:{draft:comparison.right.draft,checks:comparison.right.checks,review:comparison.right.review},demo:false,notice:'Same intent, with and without your style guidance. Choose which sounds more like you; labels appear after your vote. This comparison is not added to your profile.'};
  }
}
