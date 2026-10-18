const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const accepted = r => ['accepted','edited'].includes(r.status);
const uid = () => crypto.randomUUID();
let deps, data, mounted = false, loading = false;
const ui = {tab:'write',busy:'',error:'',voiceFilter:'proposed',sourceSearch:'',sourceMatches:null,sourceFrom:'',sourceTo:'',selected:new Set(),intent:'',context:'',modeId:'',channel:'email',language:'en',formality:'auto',recipient:'',relationship:'',purpose:'',required:'',draft:null,draftText:'',suggestion:null,manualMode:false,preview:null,comparison:null,feedback:{verdict:'approved',editType:'style',scope:'message',note:''},learning:false,cancel:false,importJob:null,personalityLearning:false,personalityCancel:false,personalityModel:'',personalityEffort:'default'};
const disable = () => ui.busy ? 'disabled' : '';
const options = (entries, selected) => entries.map(([value,label]) => `<option value="${esc(value)}" ${value===selected?'selected':''}>${esc(label)}</option>`).join('');
const field = (label,id,value='',placeholder='') => `<label class="field-label" for="${id}">${label}</label><input id="${id}" value="${esc(value)}" placeholder="${esc(placeholder)}">`;
const dropdown = (label,id,entries,selected) => `<div><label class="field-label" for="${id}">${label}</label><select id="${id}">${options(entries,selected)}</select></div>`;
const effortNames = {default:'Model default',none:'None',minimal:'Minimal',low:'Low',medium:'Medium',high:'High',xhigh:'Extra high',max:'Maximum'};
// Older saved failures did not retain all of the provider's quota codes.
// An unidentified 429 cannot be safely described as a temporary rate limit.
function jobError(job) {
  if(job.error&&job.errorDetails?.httpStatus===429&&!job.errorDetails.providerCode&&job.errorDetails.authMode!=='chatgpt')return 'The model provider returned HTTP 429. A rate, credit, or usage limit is blocking requests. Check API billing and limits before resuming. Completed batches remain saved.';
  return job.error;
}
// A model choice is "provider|model": a ChatGPT and a Claude plan can be connected together.
const routeKey = (provider, modelId) => provider && modelId ? `${provider}|${modelId}` : '';
const parseRoute = key => { const at=String(key||'').indexOf('|'); return at>0?{provider:key.slice(0,at),modelId:key.slice(at+1)}:null; };
function modelEntry(modelId,provider) { return (data.model?.availableModels||[]).find(item=>typeof item!=='string'&&item.id===modelId&&(!provider||!item.provider||item.provider===provider)); }
function modelLabel(route) { const model=route&&modelEntry(route.model,route.provider); return model?.label||route?.model||'Select a model'; }
function connectionLabel(route) { return modelEntry(route?.model,route?.provider)?.connection||(route?.provider==='claude-plan'?'Claude plan':data.model?.authMode==='chatgpt'?'ChatGPT plan':route?.provider==='anthropic'?'Anthropic':'OpenAI'); }
function modelChoices(selected,{follow=false}={}) {
  const groups=new Map();
  for(const model of data.model?.availableModels||[]) {if(typeof model==='string')continue;const label=model.connection||model.provider||'Connected';if(!groups.has(label))groups.set(label,[]);groups.get(label).push(model);}
  return `${follow?`<option value="" ${selected?'':'selected'}>Same as drafting</option>`:`<option value="" ${selected?'':'selected'}>Choose a model</option>`}${[...groups].map(([label,models])=>`<optgroup label="${esc(label)}">${models.map(model=>{const key=routeKey(model.provider,model.id);return `<option value="${esc(key)}" ${key===selected?'selected':''}>${esc(model.label||model.id)}</option>`;}).join('')}</optgroup>`).join('')}`;
}
function modelEfforts(modelId,provider) {
  const model=modelEntry(modelId,provider);
  return ['default',...new Set((model?.efforts||[]).filter(effort=>effort!=='default'&&Object.hasOwn(effortNames,effort)))];
}
function validEffort(modelId,effort,provider) { return modelEfforts(modelId,provider).includes(effort)?effort:'default'; }
function effortField(id,modelId,effort,provider) {
  const choices=modelEfforts(modelId,provider),supported=choices.length>1;
  return `<div id="${id}-control"><label class="field-label" for="${id}">Reasoning effort</label><select id="${id}" aria-describedby="${id}-hint" ${supported?'':'disabled'}>${options(choices.map(value=>[value,effortNames[value]]),validEffort(modelId,effort,provider))}</select><p id="${id}-hint" class="input-hint">${supported?'Higher effort can take longer and use more of your limits or credits. Model default leaves the choice to the provider.':'This model has no verified effort control. It uses the provider’s default.'}</p></div>`;
}
function updateEffortField(dialog,id,modelId,effort,onChange,provider) {
  const selected=validEffort(modelId,effort,provider);
  $(`#${id}-control`,dialog).outerHTML=effortField(id,modelId,selected,provider);
  $(`#${id}`,dialog).onchange=event=>onChange(event.target.value);
  return selected;
}
const button = (label,action,extra='',primary=false) => `<button type="button" class="button ${primary?'primary':'secondary'}" data-ws="${action}" ${extra} ${disable()}>${label}</button>`;
const date = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric'}) : 'Date unknown';
const plural = (n, noun) => `${n} ${n===1?noun:/[^aeiou]y$/.test(noun)?`${noun.slice(0,-1)}ies`:/(?:s|x|z|ch|sh)$/.test(noun)?`${noun}es`:`${noun}s`}`;
function currentRequest() { return {intent:ui.intent,context:ui.context,modeId:ui.modeId,channel:ui.channel,language:ui.language,formality:ui.formality,recipient:ui.recipient,relationship:ui.relationship,purpose:ui.purpose,requiredPhrases:ui.required.split('\n').map(x=>x.trim()).filter(Boolean)}; }
async function refresh() { data = await deps.api('/api/workspace'); data.profile ||= {preferences:[],examples:[],modes:[]}; data.sources ||= []; data.learningJobs ||= []; data.personalityJobs ||= []; data.feedback ||= []; data.drafts ||= []; for(const id of ui.selected)if(!data.sources.some(s=>s.id===id))ui.selected.delete(id); }
export async function openWorkspace(config) {
  deps = config;
  if (loading) return;
  loading = true;
  try {
    await refresh();
    if (!mounted) { ui.tab = data.profile.modes.some(accepted) ? 'write' : 'voice'; mounted = true; }
    render();
  } catch (e) { if(/404|endpoint not found/i.test(e.message))e.message='Restart the local server to load this update. Saved sources remain; session-only keys need to be entered again.'; $('#app').innerHTML = `<main class="loading-screen"><span class="brand">Λ / LARPMAXXING</span><div class="error-box" role="alert">${esc(e.message)}</div><button class="button secondary" id="workspace-retry">Retry</button></main>`; $('#workspace-retry').onclick=()=>openWorkspace(config); }
  finally { loading=false; }
}
function modal(title, content, onBind=()=>{}) {
  const dialog = $('#workspace-dialog');
  dialog.innerHTML = `<div class="dialog-head"><span class="panel-marker">LARPMAXXING</span><button class="text-button dialog-close" data-close aria-label="Close">×</button></div><h2 id="workspace-dialog-title">${esc(title)}</h2>${content}`;
  $('[data-close]',dialog).onclick=()=>dialog.close();
  onBind(dialog);
  if (!dialog.open) dialog.showModal();
}
async function run(label, work, {paint=true}={}) {
  if(ui.busy) return;
  ui.busy=label; ui.error=''; if(paint) render();
  try { await work(); }
  catch(e) { ui.error=e.message; }
  finally { ui.busy=''; const d=$('#workspace-dialog'); if(paint || !d?.open)render(); else if(ui.error){let n=$('.dialog-error',d);if(!n){n=document.createElement('p');n.className='error-box dialog-error';d.append(n);}n.textContent=ui.error;} }
}
async function saveProfile(profile, notice) { await deps.api('/api/profile',{profile,version:data.profileVersion}); await refresh(); if(notice)deps.notify(notice); }
function cloneProfile() { return structuredClone(data.profile); }
function refsFor(record) {
  const refs=[...(record.sources||[])];
  for(const id of record.sourceIds||[]) {
    const linked=[...data.profile.preferences,...data.profile.examples].find(r=>r.id===id);
    if(linked)refs.push(...(linked.sources||[]));
    else if(data.sources.some(s=>s.id===id)&&!refs.some(ref=>ref.conversationId===id))refs.push({conversationId:id});
  }
  return [...new Map(refs.map(r=>[`${r.conversationId}:${r.messageId}:${r.excerpt}`,r])).values()];
}
function refsMarkup(record) {
  const refs=refsFor(record);
  return `<details class="record-evidence"><summary>Why this is here${refs.length?` · ${plural(refs.length,'reference')}`:''}</summary><p class="muted">${esc(record.basis||'User decision')} · ${esc(record.strength||'Not scored')} · ${date(record.date)}</p>${refs.length?refs.map(ref=>`<blockquote>${ref.excerpt?`<p>${esc(ref.excerpt)}</p>`:''}<footer>${esc(ref.title||ref.conversationId||ref.label||'Source reference')}${ref.messageId?` · ${esc(ref.messageId)}`:''}${ref.conversationId&&!ref.conversationId.startsWith('feedback:')?` <button type="button" class="text-button" data-ws="inspect" data-id="${esc(ref.conversationId)}">Inspect</button>`:''}</footer></blockquote>`).join(''):'<p class="muted">Added manually. No historical evidence claimed.</p>'}${record.reportedSources?.length?`<p class="muted">Chatbot report citations are unverified claims:</p><pre>${esc(JSON.stringify(record.reportedSources,null,2))}</pre>`:''}${record.conflicts?.length?`<div class="warning-box">Conflicting evidence: ${esc(record.conflicts.map(x=>typeof x==='string'?x:JSON.stringify(x)).join('; '))}</div>`:''}${record.conflictingEvidence?.length?`<div class="warning-box">${record.conflictingEvidence.map(e=>`<p>${esc(typeof e==='string'?e:e.excerpt||e.text||JSON.stringify(e))}</p>`).join('')}</div>`:''}${record.limitations?.length?`<p class="muted">${esc(record.limitations.join(' '))}</p>`:''}</details>`;
}
function planStatus() {
  const plans=[...(data.model?.authMode==='chatgpt'?['Using ChatGPT plan · <a href="https://chatgpt.com/settings/usage" target="_blank" rel="noopener noreferrer">Manage usage ↗</a>']:[]),...(data.model?.claude?['Using Claude plan · <a href="https://claude.ai/settings/usage" target="_blank" rel="noopener noreferrer">Manage usage ↗</a>']:[])];
  return plans.length?`<p class="plan-status">${plans.join('<span class="plan-separator"> · </span>')}</p>`:'';
}
const TASK_ROWS=[['drafting','Drafting','Plans and writes each draft.'],['critique','Critique','Reviews each draft against your intent.'],['analysis','Analysis','Learns from sources you select. Also the starting choice for baseline personalities.']];
function taskEffortField(task,key,effort) {
  const choice=parseRoute(key);
  if(!choice)return `<div id="${task}-effort-control"><label class="field-label" for="${task}-effort">Reasoning effort</label><select id="${task}-effort" disabled><option>Same as drafting</option></select><p class="input-hint">Follows the drafting model and effort.</p></div>`;
  return effortField(`${task}-effort`,choice.modelId,effort,choice.provider);
}
function showModelSettings() {
  const tasks=data.model?.tasks||{},claude=data.model?.claude;
  const picks=Object.fromEntries(TASK_ROWS.map(([task])=>{const route=tasks[task];const own=route&&(task==='drafting'||!route.inherited);return [task,{key:own?routeKey(route.provider,route.model):'',effort:own?route.effort||'default':'default'}];}));
  const missing=TASK_ROWS.filter(([task])=>tasks[task]&&!tasks[task].inherited&&tasks[task].available===false).map(([,label])=>label);
  const plans=[data.model?.authMode==='chatgpt'?`ChatGPT plan · ${esc(data.model.accountLabel)}`:'',claude?`Claude plan · ${esc(claude.accountLabel)}`:'',data.model?.verified&&!['chatgpt','claude-plan'].includes(data.model?.authMode)?`${esc(data.model.provider==='anthropic'?'Anthropic':'OpenAI')} API key`:''].filter(Boolean).join(' and ');
  modal('The connected mind.',`<p class="dialog-description">Connected: ${plans||'nothing yet'}. Choose which model handles each task. Plan requests use your plan’s limits; API requests are billed by your provider.</p>${missing.length?`<p class="error-box">${esc(missing.join(', '))} ${missing.length===1?'uses':'use'} a model whose account isn’t connected. Reconnect it or choose another model.</p>`:''}<form id="model-choice">${TASK_ROWS.map(([task,label,hint])=>`<fieldset class="task-route"><legend>${label}</legend><p class="input-hint">${hint}</p><div class="form-grid"><div><label class="field-label" for="${task}-model">Model</label><select id="${task}-model">${modelChoices(picks[task].key,{follow:task!=='drafting'})}</select></div>${taskEffortField(task,picks[task].key,picks[task].effort)}</div></fieldset>`).join('')}<button class="button primary" type="submit">Save model choices</button></form><div class="claude-connection">${claude?`<p class="input-hint">Claude plan runs through Claude Code${claude.version?` ${esc(claude.version)}`:''} on this computer. <a href="https://claude.ai/settings/usage" target="_blank" rel="noopener noreferrer">Manage usage ↗</a></p><button class="text-button" type="button" id="disconnect-claude">Disconnect Claude plan</button>`:`<p class="input-hint">Have Claude Pro or Max? Add it to use Claude for some tasks. It runs through Claude Code on this computer, signed in with your own Claude account.</p><button class="button secondary" type="button" id="connect-claude">Add Claude plan</button>`}</div><p class="input-hint">Availability in the list does not guarantee inference access or billing readiness.</p><button class="text-button" type="button" id="change-model-key">Connection settings</button>`,dialog=>{
    for(const [task] of TASK_ROWS) {
      const bindEffort=()=>{const select=$(`#${task}-effort`,dialog);if(select&&!select.disabled)select.onchange=event=>{picks[task].effort=event.target.value;};};
      bindEffort();
      $(`#${task}-model`,dialog).onchange=event=>{const key=event.target.value,choice=parseRoute(key);picks[task]={key,effort:choice?validEffort(choice.modelId,picks[task].effort,choice.provider):'default'};$(`#${task}-effort-control`,dialog).outerHTML=taskEffortField(task,key,picks[task].effort);bindEffort();};
    }
    $('#model-choice',dialog).onsubmit=e=>{
      e.preventDefault();
      const drafting=parseRoute(picks.drafting.key);if(!drafting){$('#drafting-model',dialog).focus();return;}
      const route=task=>{const choice=parseRoute(picks[task].key);return choice?{provider:choice.provider,modelId:choice.modelId,effort:validEffort(choice.modelId,picks[task].effort,choice.provider)}:null;};
      run('model',async()=>{await deps.api('/api/workspace/model',{tasks:{drafting:route('drafting'),critique:route('critique'),analysis:route('analysis')}});await refresh();dialog.close();render();},{paint:false});
    };
    $('#connect-claude',dialog)?.addEventListener('click',()=>run('claude',async()=>{await deps.api('/api/onboarding/claude',{});await refresh();showModelSettings();deps.notify('Claude plan connected. Choose the tasks it should handle.');},{paint:false}));
    $('#disconnect-claude',dialog)?.addEventListener('click',()=>run('claude',async()=>{const result=await deps.api('/api/onboarding/claude',{},'DELETE');if(!result.model?.verified){dialog.close();deps.changeModel();return;}await refresh();showModelSettings();deps.notify(result.notice);},{paint:false}));
    $('#change-model-key',dialog).onclick=()=>{dialog.close();deps.changeModel();};
    // The header shows the drafting model; repaint it once this dialog closes,
    // unless the app has already left the workspace (the dialog is then detached).
    dialog.addEventListener('close',()=>{if(dialog.isConnected)render();},{once:true});
  });
}
function render() {
  if(!data)return;
  $('#app').innerHTML = `<div class="workspace-shell"><header class="workspace-top"><a href="/" class="brand"><span class="brand-symbol">Λ</span>LARPMAXXING</a><nav aria-label="Workspace">${[['write','Write'],['voice','Your voice'],['sources','Sources']].map(([tab,label])=>`<button class="nav-item ${ui.tab===tab?'active':''}" data-tab="${tab}" ${ui.tab===tab?'aria-current="page"':''}>${label}${tab==='voice'&&[...data.profile.preferences,...data.profile.modes].some(p=>p.status==='proposed')?'<span class="nav-dot"></span>':''}</button>`).join('')}</nav><button class="model-indicator text-button" data-ws="model"><span class="status-dot"></span>${esc(connectionLabel(data.model?.tasks?.drafting))}<span class="model-name"> / ${esc(modelLabel(data.model?.tasks?.drafting))}</span></button></header><main id="main" class="workspace-main" tabindex="-1">${planStatus()}${ui.error?`<div class="error-box" role="alert">${esc(ui.error)}</div>`:''}${ui.tab==='write'?renderWrite():ui.tab==='voice'?renderVoice():renderSources()}</main><footer class="workspace-footer"><span>WRITE LIKE PLATO. EXIST LIKE DIONYSUS.</span><span>PRIVATE WORDS. DELIBERATE CHOICES.</span></footer></div><dialog id="workspace-dialog" class="workspace-dialog" aria-labelledby="workspace-dialog-title"></dialog>`;
  bind();
}
function renderWrite() {
  const modes=data.profile.modes.filter(accepted);
  return `<div class="page-heading"><div><span class="eyebrow">I / THE LETTER</span><h1>Say what you mean.</h1><p>Your intent. Your voice. Nothing sent without you.</p></div><div class="marble-mark" aria-hidden="true">Λ</div></div>${!modes.length?`<div class="onboarding-note"><div><h3>Give the harness a voice first.</h3><p>Create your baseline personalities from imported sources, then review and fine-tune them.</p></div>${button('Shape your voice','voice','','true')}</div>`:''}<div class="compose-grid"><section class="composer"><form id="compose-form"><label class="field-label large-label" for="intent">What I want to say <span>required</span></label><textarea id="intent" class="intent-field" rows="7" placeholder="The points you want to make, in your own words. Rough notes are fine." required>${esc(ui.intent)}</textarea><p class="input-hint dictation-hint">Type or use your device’s dictation in this field. On Windows: Win + H. On Mac: your configured Dictation shortcut.</p><details class="context-section" ${ui.context?'open':''}><summary>Conversation or context <span>optional</span></summary><textarea id="context" rows="5" placeholder="Paste the incoming message or conversation.">${esc(ui.context)}</textarea></details><div class="form-grid">${dropdown('Channel','channel',[['email','Email'],['slack','Slack'],['whatsapp','WhatsApp'],['outreach','Cold outreach']],ui.channel)}${dropdown('Language','language',[['en','English'],['de','Deutsch']],ui.language)}</div><div class="mode-row">${dropdown('Personality','modeId',[['','Choose a personality'],...modes.map(m=>[m.id,m.name])],ui.modeId)}${ui.context?button('Suggest','suggest-mode'):''}</div>${ui.suggestion?`<p class="selection-note">${esc(ui.suggestion.reason)}${ui.suggestion.ambiguous?' Choose a personality to continue.':''}</p>`:''}${ui.language==='de'?`<div class="form-grid">${dropdown('Anrede','formality',[['auto','Use personality preference'],['du','du'],['Sie','Sie']],ui.formality)}</div>`:''}<details class="context-section"><summary>Recipient & details <span>optional</span></summary><div class="form-grid"><div>${field('Recipient','recipient',ui.recipient,'Name or label')}</div><div>${field('Relationship','relationship',ui.relationship,'e.g. close colleague')}</div></div><div class="form-grid"><div>${field('Purpose','purpose',ui.purpose,'e.g. follow-up')}</div><div><label class="field-label" for="required">Exact phrases to preserve</label><textarea id="required" rows="2" placeholder="One per line">${esc(ui.required)}</textarea></div></div></details><div class="generate-row"><button type="submit" class="button primary" ${disable()} ${!modes.length?'disabled':''}>${ui.busy==='draft'?'<span class="spinner"></span>Writing…':'Create draft ↗'}</button><button type="button" class="text-button" data-ws="draft-preview" ${disable()}>Inspect what is sent</button></div><p class="disclosure">Sends your intent, context, selected personality, applicable accepted preferences, and a few relevant examples to ${esc(data.model?.authMode==='chatgpt'?'ChatGPT plan':data.model?.provider==='anthropic'?'Anthropic':'OpenAI')} for planning, drafting, and review.</p></form></section><section class="draft-pane" aria-label="Your draft">${renderDraft()}</section></div><details class="secondary-section" ${ui.comparison||ui.busy==='compare'||ui.busy==='vote'?'open':''}><summary>Recent drafts & comparison</summary>${renderRecent()}<p class="muted">Compare a personalized draft with a generic baseline using the same current intent. Both go to your selected provider; hard rules remain in both. Use a new message you did not use for profile creation.</p>${button('Compare this message','compare')}${renderComparison()}</details>`;
}
function renderDraft() {
  const draft=ui.draft;
  if(!draft)return `<div class="empty-draft"><div class="empty-monogram" aria-hidden="true">Λ</div><span class="eyebrow">ROOM FOR YOUR WORDS</span><p>A draft will appear here.<br>Review it, make it yours, copy it.</p></div>`;
  if(draft.needsClarification)return `<div class="draft-heading"><span class="eyebrow">ONE THING FIRST</span></div><h2>A little more context.</h2><p class="muted">Add the missing information to your intent, then create the draft again.</p><ul class="plain-list">${(draft.plan?.missing||[]).map(x=>`<li>${esc(x)}</li>`).join('')}</ul>`;
  const issues=[...(draft.checks?.hardRules||[]).filter(x=>!x.passed).map(x=>`Banned literal is still present: ${x.literal}`),...(draft.checks?.warnings||[]),...(draft.checks?.missingRequired||[]).map(x=>`Missing exact phrase: ${x}`),...(draft.checks?.possibleLeaks||[]).map(x=>`Possible historical fact: ${x.detail}`),...(draft.review?.contentIssues||[]),...(draft.review?.unsupportedClaims||[]),...(draft.review?.styleIssues||[]),...(draft.review?.missingPointIds||[]).map(x=>`Review intended point ${x}`)];
  return `<div class="draft-heading"><span class="eyebrow">YOUR DRAFT</span><button class="text-button" data-ws="copy">Copy ↗</button></div><textarea id="draft-text" class="draft-editor" aria-label="Edit your draft" rows="13">${esc(ui.draftText)}</textarea><p id="draft-edit-note" class="input-hint" ${ui.draftText===draft.draft?'hidden':''}>You edited this draft. Model review below describes the generated version; review your changes too. Literal rules are checked again when you copy.</p><div class="revision-row">${[['warmer','Warmer'],['more direct','More direct'],['less formal','Less formal'],['add detail','Add detail'],['shorter','Shorter']].map(([value,label])=>`<button type="button" class="revision-button" data-revision="${value}" ${disable()}>${label}</button>`).join('')}</div>${issues.length?`<div class="warning-box"><strong>Review before copying</strong><ul>${issues.map(x=>`<li>${esc(x)}</li>`).join('')}</ul></div>`:''}<details class="draft-checks"><summary>Applied voice & content checks</summary><p class="muted">${esc(draft.selection?.reason||'Selected personality and accepted rules applied.')}</p>${(draft.appliedPreferences||[]).map(p=>`<p class="applied-rule">${esc(p.text)}</p>`).join('')}<ul class="plain-list">${(draft.plan?.points||[]).map(p=>`<li>${esc(p.text||p)}</li>`).join('')}</ul><p class="muted">Literal checks: ${(draft.checks?.hardRules||[]).length?(draft.checks.hardRules.every(x=>x.passed)?'passed':'needs attention'):'no banned literals configured'}. Tone and meaning still need your judgment.${draft.review?.unavailable?' Model-assisted review was unavailable.':''}</p></details><details class="feedback-section"><summary>Save an example or correction</summary><form id="feedback-form"><div class="form-grid">${dropdown('Your judgment','feedback-verdict',[['approved','Good example'],['edited','I edited this'],['unsuitable','Does not sound like me']],ui.feedback.verdict)}${dropdown('What changed?','feedback-type',[['style','Wording / style'],['facts','Facts only'],['mixed','Facts and style']],ui.feedback.editType)}</div>${dropdown('Use this feedback for','feedback-scope',[['message','This message only'],['mode','This personality'],['recipient','This recipient'],['global','All future drafts']],ui.feedback.scope)}<label class="field-label" for="feedback-note">What should it learn? <span>optional</span></label><textarea id="feedback-note" rows="2" placeholder="Describe the wording change, separate from any factual correction.">${esc(ui.feedback.note)}</textarea><p class="input-hint">The edited text above is the final version. Future preferences are proposed for your review; they are never silently accepted.</p><button class="button secondary" type="submit" ${disable()}>Save feedback</button></form></details>`;
}
function renderRecent() {
  return data.drafts.length?`<div class="recent-list">${data.drafts.slice(0,5).map(d=>`<button type="button" data-ws="load-draft" data-id="${esc(d.id)}"><span>${esc((d.request?.intent||d.draft||'Draft').slice(0,75))}</span><span>${date(d.date)}</span></button>`).join('')}</div>`:'<p class="muted">Your recent drafts will stay in this local copy.</p>';
}
function renderComparison() {
  const c=ui.comparison;if(!c)return '';
  return `<div class="comparison-grid">${[['left','Draft A'],['right','Draft B']].map(([side,label])=>`<section><h3>${label}</h3><pre class="draft-comparison">${esc(c[side]?.draft)}</pre>${c.voted?'':button(`This sounds more like me`,'vote',`data-side="${side}"`)}</section>`).join('')}</div>${c.voted?`<p class="selection-note">Saved your judgment: ${esc(c.voted.winner)}${c.voted.labels?`. A: ${esc(c.voted.labels.left)}. B: ${esc(c.voted.labels.right)}.`:''}</p>`:button('No meaningful difference','vote','data-side="tie"')}`;
}
function renderVoice() {
  const pending=[...data.profile.preferences,...data.profile.examples,...data.profile.modes].filter(r=>r.status==='proposed').length;
  const modes=data.profile.modes;
  const visible=r=>ui.voiceFilter==='all'||ui.voiceFilter==='proposed'&&r.status==='proposed'||ui.voiceFilter==='active'&&accepted(r);
  return `<div class="page-heading"><div><span class="eyebrow">II / THE VOICE</span><h1>Know what it knows.</h1><p>Every preference is yours to accept, change, or undo.</p></div><div class="page-actions">${button('Undo last change','undo')}</div></div>${renderPersonalityBaseline()}<div class="voice-toolbar"><div class="segmented" role="group" aria-label="Profile filter">${[['proposed',`Review${pending?` (${pending})`:''}`],['active','In use'],['all','Everything']].map(([value,label])=>`<button type="button" data-filter="${value}" class="${ui.voiceFilter===value?'active':''}">${label}</button>`).join('')}</div><div class="inline-actions">${button('Add preference','new-preference')}${button('Add example','new-example')}</div></div><section class="voice-section"><div class="section-heading"><h2>Personalities</h2><button class="text-button" data-ws="new-mode">Create personality +</button></div><p class="muted section-intro">Your baseline, ready to fine-tune. Accept, edit, split, merge, or remove a personality. Language and channel stay separate.</p><div class="modes-grid">${modes.filter(visible).map(renderPersonalityCard).join('')||'<div class="empty-section">No personalities in this view. Create your baseline or review proposals from your sources.</div>'}</div></section><section class="voice-section"><div class="section-heading"><h2>Preferences</h2><span class="muted">Explicit decisions take precedence.</span></div><div class="records">${data.profile.preferences.filter(visible).map(p=>`<article class="preference-card"><div class="record-meta"><span>${esc(p.category==='hard'?'Hard rule':p.basis||'Guidance')}</span><span>${esc(p.scope?.type==='mode'?'personality':p.scope?.type||'global')}${p.scope?.value?` / ${esc(p.scope.type==='mode'?(data.profile.modes.find(mode=>mode.id===p.scope.value)?.name||'Deleted personality'):p.scope.value)}`:''} · ${esc(p.status)}</span></div><h3>${esc(p.text)}</h3>${p.banned?.length?`<p class="literal-rule">Banned literally: ${p.banned.map(x=>`<code>${esc(x)}</code>`).join(' ')}</p>`:''}${refsMarkup(p)}${recordActions('preferences',p)}</article>`).join('')||'<p class="empty-section">No preferences in this view. Nothing is assumed from an AI draft or a one-off correction.</p>'}</div></section><section class="voice-section"><div class="section-heading"><h2>Examples</h2><span class="muted">Sent does not automatically mean good.</span></div><div class="examples-grid">${data.profile.examples.filter(visible).map(e=>`<article class="example-card"><div class="record-meta"><span>${esc(e.kind||'Unknown')}</span><span>${esc(e.status)} · ${date(e.date)}</span></div><blockquote>${esc(e.text)}</blockquote>${refsMarkup(e)}${recordActions('examples',e)}</article>`).join('')||'<p class="empty-section">No examples in this view. Add a message that sounds right, or wording you want to avoid.</p>'}</div></section><details class="secondary-section"><summary>Profile file & feedback history</summary><p class="muted">The Markdown profile is the source of truth. File edits are reloaded on every request. Concurrent edits are rejected rather than overwritten.</p>${button('Edit Markdown','markdown')}<div class="history-list">${(data.profileHistory||[]).slice(-5).reverse().map(h=>`<p><span>${date(h.date)}</span> ${esc(h.reason)}</p>`).join('')}</div>${data.feedback.slice(0,8).map(f=>`<details class="feedback-history"><summary>${esc(f.verdict)} · ${esc(f.editType)} · ${esc(f.scope==='mode'?'personality':f.scope)} · ${date(f.date)}</summary><p>${esc(f.note)}</p><div class="comparison-grid"><div><h3>Before</h3><pre>${esc(f.before)}</pre></div><div><h3>After</h3><pre>${esc(f.after)}</pre></div></div><button class="text-button danger" data-ws="delete-feedback" data-id="${esc(f.id)}">Remove feedback and derived records</button></details>`).join('')}</details>`;
}
function formatPersonalityGuidance(value) {
  const sections=[];let paragraph=[];
  const flush=()=>{const text=paragraph.join('\n').trim();if(text)sections.push(`<p>${esc(text)}</p>`);paragraph=[];};
  for(const line of String(value||'No distinctive guidance yet.').split('\n')) {
    if(line.startsWith('### ')){flush();sections.push(`<h4>${esc(line.slice(4).trim())}</h4>`);}
    else if(!line.trim())flush();else paragraph.push(line);
  }
  flush();return sections.join('');
}
function renderPersonalityCard(mode) {
  const baseline=mode.baseline;
  return `<article class="mode-card personality-card"><div class="record-meta"><span>${baseline?'Baseline · ':''}${esc(mode.status)}</span><span>${esc(mode.language||'Any language')} · ${esc(mode.channel||'Any channel')}</span></div><h3>${esc(mode.name)}</h3><p>${esc(mode.description||'Choose when this personality applies.')}</p><details class="personality-detail"><summary>Detailed personality</summary><div class="mode-guidance">${formatPersonalityGuidance(mode.guidance)}</div>${baseline?`<p class="input-hint">Created from ${plural(Number(baseline.totalSources)||0,'source')} with ${esc(baseline.modelId||baseline.provider)} · ${date(baseline.analyzedAt)}</p>`:''}</details>${mode.sample?`<details><summary>Generated sample</summary><blockquote>${esc(mode.sample)}</blockquote><p class="input-hint">Generated illustration, not historical evidence.</p></details>`:''}${refsMarkup(mode)}${recordActions('modes',mode)}</article>`;
}
function renderPersonalityBaseline() {
  const hasBaseline=data.profile.modes.some(m=>m.baseline);
  const active=data.personalityJobs.some(j=>['ready','running'].includes(j.status));
  if(hasBaseline&&!active) {
    const completed=data.personalityJobs.filter(j=>j.status==='complete');
    return `<section class="personality-baseline baseline-compact" aria-label="Baseline personalities"><div class="baseline-intro"><div><h2>Your baseline personalities.</h2><p>Review the personalities below, then fine-tune what sounds like you.</p></div>${button('Create a new baseline','personality-preview','',true)}</div>${renderPersonalityJobs(data.personalityJobs.filter(j=>j.status!=='complete'))}${completed.length?`<details class="baseline-history"><summary>Analysis details</summary>${renderPersonalityJobs(completed)}</details>`:''}</section>`;
  }
  return `<section class="personality-baseline" aria-label="Baseline personalities"><div class="baseline-intro"><div><span class="eyebrow">YOUR STARTING POINT</span><h2>${hasBaseline?'Your voice, with a foundation.':'Find your personalities.'}</h2><p>Analyze all imported sources and group your writing into 3–5 detailed personalities. Review the baseline, then make it yours.</p><p class="input-hint">A model of your writing choices, grounded in your examples. Sparse evidence may support fewer personalities.</p></div>${button(hasBaseline?'Create a new baseline':'Create baseline personalities','personality-preview',active?'disabled':'',true)}</div>${renderPersonalityJobs()}</section>`;
}
function renderPersonalityJobs(jobs=data.personalityJobs) {
  return jobs.slice(-3).reverse().map(job=>{
    const total=Math.max(1,(Number(job.batchCount)||0)+1);
    const complete=job.status==='complete';
    const processed=complete?total:Math.min(Number(job.processedBatches)||0,total-1);
    const phase=complete?((job.personalityIds||[]).length?'Baseline ready':'More evidence needed'):job.phase==='synthesize'?'Creating personalities':'Analyzing sources';
    const waiting=['cancelled','failed','paused','error','conflict'].includes(job.status);
    return `<div class="personality-job" role="status"><div class="personality-job-heading"><strong>${phase}</strong><span>${esc(job.status)} · ${esc(job.modelId||'Selected model')} · ${esc(effortNames[job.effort]||effortNames.default)} effort</span></div><progress aria-label="Personality creation progress" max="${total}" value="${processed}"></progress><p>${plural(Number(job.totalSources)||0,'source')} · ${plural(Number(job.totalMessages)||0,'message')} · ${Math.min(Number(job.processedBatches)||0,Number(job.batchCount)||0)} / ${Number(job.batchCount)||0} batches analyzed${complete?` · ${plural((job.personalityIds||[]).length,'personality')} created`:''}</p>${job.error?`<p class="error-text">${esc(jobError(job))}</p>`:''}${job.warnings?.length?`<details><summary>Evidence & limitations</summary>${job.warnings.map(w=>`<p>${esc(w)}</p>`).join('')}</details>`:''}${complete?`<p class="input-hint">Review the proposed personalities below. Your accepted profile is unchanged until you choose.</p>`:job.status==='stale'?'<p class="input-hint">Imported sources changed. Create a new baseline to include the current archive.</p>':job.status==='ready'&&!ui.personalityLearning||waiting?button('Resume baseline','resume-personalities',`data-id="${esc(job.id)}"`):['ready','running'].includes(job.status)?`<button class="text-button" data-ws="cancel-personalities" data-id="${esc(job.id)}">Cancel analysis</button>`:''}</div>`;
  }).join('');
}
function recordActions(collection,r) {
  return `<div class="record-actions">${collection==='modes'&&accepted(r)?`<button class="text-button" data-ws="try-mode" data-id="${esc(r.id)}">Write with this personality</button>`:''}${r.status==='proposed'?`<button class="text-button" data-ws="record-status" data-collection="${collection}" data-id="${esc(r.id)}" data-status="accepted">${collection==='examples'&&r.kind==='sent'?'Use as a good example':'Accept'}</button>`:''}<button class="text-button" data-ws="edit-record" data-collection="${collection}" data-id="${esc(r.id)}">Edit</button>${accepted(r)?`<button class="text-button" data-ws="record-status" data-collection="${collection}" data-id="${esc(r.id)}" data-status="disabled">Disable</button>`:r.status==='disabled'?`<button class="text-button" data-ws="record-status" data-collection="${collection}" data-id="${esc(r.id)}" data-status="accepted">Enable</button>`:''}${r.status==='proposed'?`<button class="text-button" data-ws="record-status" data-collection="${collection}" data-id="${esc(r.id)}" data-status="rejected">Reject</button>`:''}${collection==='modes'?`<button class="text-button" data-ws="duplicate-mode" data-id="${esc(r.id)}">Split / duplicate</button>`:''}</div>`;
}
function filteredSources() {
  return data.sources.filter(s=>(!ui.sourceSearch||(ui.sourceMatches?ui.sourceMatches.has(s.id):`${s.title} ${s.source} ${(s.discovery?.reasons||[]).join(' ')}`.toLowerCase().includes(ui.sourceSearch.toLowerCase())))&&(!ui.sourceFrom||!s.date||s.date.slice(0,10)>=ui.sourceFrom)&&(!ui.sourceTo||!s.date||s.date.slice(0,10)<=ui.sourceTo));
}
function renderSources() {
  const sources=filteredSources();
  return `<div class="page-heading"><div><span class="eyebrow">III / THE EVIDENCE</span><h1>Start with your words.</h1><p>Choose what the harness can learn from. Keep the rest out.</p></div>${button('Add sources','add-sources')}</div><div class="source-workspace"><section class="source-selection"><div class="source-search"><label class="visually-hidden" for="source-search">Search source titles and messages</label><input id="source-search" placeholder="Search titles and message content…" value="${esc(ui.sourceSearch)}"></div><details class="source-date-filter"><summary>Date range & selection</summary><div class="date-grid"><div>${field('From','source-from',ui.sourceFrom)}</div><div>${field('To','source-to',ui.sourceTo)}</div></div><p class="input-hint">Dates use UTC. Undated sources remain visible for manual review.</p><button class="text-button" data-ws="select-visible">Select visible</button> <button class="text-button" data-ws="clear-sources">Clear selection</button></details><div class="source-records">${sources.map(s=>`<article class="source-record"><label><input type="checkbox" data-source-select="${esc(s.id)}" ${ui.selected.has(s.id)?'checked':''} ${ui.learning?'disabled':''}><span><strong>${esc(s.title||'Untitled source')}</strong><span class="source-description">${esc(s.source)} · ${Number(s.ownMessageCount)||0} yours / ${Number(s.messageCount)||0} messages · ${date(s.date)}</span>${s.candidate?'<span class="candidate-label">Writing evidence found</span>':''}</span></label><button class="text-button" data-ws="inspect" data-id="${esc(s.id)}">Inspect</button></article>`).join('')||'<p class="empty-section">No sources match. You can also inspect conversations that did not match a keyword.</p>'}</div></section><aside class="learning-panel"><span class="eyebrow">YOUR SELECTION</span><h2>${plural(ui.selected.size,'source')}</h2><p>Find recurring writing choices, retain their evidence, and propose personalities.</p><p class="muted">Learning sends selected message excerpts to your connected model. Review the exact selection first. Nothing is automatically accepted.</p>${button('Review & learn','learn-preview',!ui.selected.size?'disabled':'',true)}${renderLearningJobs()}<details class="secondary-section"><summary>Chatbot reports & exports</summary><p class="muted">Model access does not expose ChatGPT or Claude history. Import an export, selected conversation, or a report from your existing chatbot.</p>${button('Get the chatbot prompt','chatbot-prompt')}<form id="archive-form">${dropdown('Evidence type','import-kind',[['conversation','Conversation / JSON export'],['report','Chatbot preference report'],['explicit-preference','An explicit preference'],['user-written','My own writing'],['approved','A draft I approved'],['rejected','Wording I rejected']], 'conversation')}<label class="field-label" for="import-text">Paste evidence</label><textarea id="import-text" rows="5" placeholder="Paste a report, JSON, or User: / Assistant: transcript"></textarea><label class="field-label" for="import-file">Or choose an extracted JSON / text file</label><input id="import-file" type="file" accept=".json,.txt,.md"><p class="input-hint">Up to 32 MiB per batch. Unzip exports first. Report citations remain unverified claims.</p><button class="button secondary" type="submit" ${disable()}>Import locally</button></form>${ui.importJob?`<p class="muted">Import ${esc(ui.importJob.status)} · ${ui.importJob.processed}/${ui.importJob.total}</p>${ui.importJob.status==='cancelled'?button('Resume import','resume-import'):['ready','running'].includes(ui.importJob.status)?'<button class="text-button" data-ws="cancel-import">Cancel after this batch</button>':''}`:''}<button class="text-button" data-ws="extract-local" ${disable()}>Extract explicit evidence locally from selection</button></details></aside></div>`;
}
function renderLearningJobs() {
  return data.learningJobs.slice(-3).reverse().map(j=>`<div class="learning-job"><div><strong>${esc(j.status)}</strong><span>${Number(j.processed)||0} / ${Number(j.total)||0}</span></div><progress max="${Math.max(1,j.total||1)}" value="${j.processed||0}"></progress><p>${Object.entries(j.proposalCounts||{}).map(([key,n])=>`${n} ${key==='modes'?'personalities':key}`).join(' · ')||'Preparing evidence…'}</p>${j.error?`<p class="error-text">${esc(jobError(j))}</p>`:''}${j.warnings?.length?`<details><summary>Limitations</summary>${j.warnings.map(w=>`<p>${esc(w)}</p>`).join('')}</details>`:''}${j.status==='ready'&&!ui.learning?button('Continue','resume-learn',`data-id="${esc(j.id)}"`):['running','ready'].includes(j.status)?`<button class="text-button" data-ws="cancel-learn" data-id="${esc(j.id)}">Cancel after this batch</button>`:['cancelled','failed','paused','error','conflict'].includes(j.status)?button('Resume','resume-learn',`data-id="${esc(j.id)}"`):j.status==='stale'?'<p class="input-hint">Sources changed. Select the remaining sources and start a new analysis.</p>':button('Review what was learned','voice')}</div>`).join('');
}
function scopeValueField(type,value='') {
  const entries={language:[['en','English'],['de','Deutsch']],channel:[['email','Email'],['slack','Slack'],['whatsapp','WhatsApp'],['outreach','Cold outreach']],mode:data.profile.modes.map(m=>[m.id,m.name])}[type];
  if(entries)return `<label class="field-label" for="edit-scope-value">${type==='mode'?'Personality':'For'}</label><select id="edit-scope-value">${options([['','Choose…'],...entries],value)}</select>`;
  if(type==='global')return '<label class="field-label" for="edit-scope-value">For</label><input id="edit-scope-value" value="" placeholder="All future writing" disabled>';
  return field(type==='recipient'?'Recipient':type==='audience'?'Audience':'Situation','edit-scope-value',value,'Use the same label when drafting');
}
function editRecord(collection, record, isNew=false) {
  const r=structuredClone(record||{}), mode=collection==='modes', example=collection==='examples';
  const scope=r.scope||{type:'global',value:''};
  const form=mode?`<div>${field('Personality name','edit-name',r.name||'','e.g. Close colleagues')}</div><label class="field-label" for="edit-description">When it applies</label><textarea id="edit-description" rows="2" placeholder="Audience, relationship, or situation">${esc(r.description||'')}</textarea><label class="field-label" for="edit-text">Distinctive writing preferences</label><textarea id="edit-text" rows="12" placeholder="Describe the way you actually want to write.">${esc(r.guidance||'')}</textarea><div class="form-grid">${dropdown('Language','edit-language',[['','Any'],['en','English'],['de','Deutsch']],r.language||'')}${dropdown('Channel','edit-channel',[['','Any'],['email','Email'],['slack','Slack'],['whatsapp','WhatsApp'],['outreach','Cold outreach']],r.channel||'')}</div><div class="form-grid"><div>${field('Relationship','edit-relationship',r.relationship||'')}</div>${dropdown('German address','edit-formality',[['','Unspecified'],['du','du'],['Sie','Sie']],r.formality||'')}</div><details><summary>Merge into another personality</summary><p class="input-hint">Combines the guidance and references. Existing scope links move to the destination. Review the resulting personality.</p>${dropdown('Destination','merge-target',[['','Do not merge'],...data.profile.modes.filter(m=>m.id!==r.id).map(m=>[m.id,m.name])],'')}</details>`:`<label class="field-label" for="edit-text">${example?'Example text':'Preference'}</label><textarea id="edit-text" rows="5" required>${esc(r.text||'')}</textarea>${example?dropdown('Evidence type','edit-kind',[['approved','Good example I approve'],['user-written','My own writing'],['rejected','Rejected wording'],['sent','Sent, quality unconfirmed']],r.kind||'approved'):dropdown('Type','edit-category',[['guidance','Writing guidance'],['hard','Hard literal rule'],['rejected-wording','Avoid this wording']],r.category||'guidance')}<div class="form-grid">${dropdown('Applies to','edit-scope',[['global','All writing'],['language','Language'],['channel','Channel'],['audience','Audience'],['recipient','Recipient'],['situation','This situation'],['mode','Personality']],scope.type)}<div>${scopeValueField(scope.type,scope.value)}</div></div><p class="input-hint">Keep one-off corrections limited to their original situation. Global preferences apply to future writing.</p>${!example?`<label class="field-label" for="edit-banned">Banned literals <span>hard rules only, one per line</span></label><textarea id="edit-banned" rows="2" placeholder="For example: —">${esc((r.banned||[]).join('\n'))}</textarea>`:''}`;
  modal(`${isNew?'Add':'Edit'} ${mode?'personality':example?'example':'preference'}`,`<form id="record-form" class="record-form">${form}<div class="dialog-actions"><button type="submit" class="button primary">${isNew?'Add to my voice':'Save reviewed change'}</button>${!isNew?'<button type="button" class="text-button danger" id="delete-record">Delete</button>':''}</div><p class="input-hint">This is an explicit profile decision. You can undo it from Your voice.</p></form>`,dialog=>{
    $('#edit-scope',dialog)?.addEventListener('change',e=>{$('#edit-scope-value',dialog).parentElement.innerHTML=scopeValueField(e.target.value,'');});
    $('#record-form',dialog).onsubmit=event=>{
      event.preventDefault();
      const text=$('#edit-text',dialog).value.trim();
      const updated={...r,id:r.id||uid(),status:isNew?'accepted':'edited',date:r.date||new Date().toISOString(),sources:r.sources||[]};
      if(mode){delete updated.details;Object.assign(updated,{name:$('#edit-name',dialog).value.trim(),description:$('#edit-description',dialog).value.trim(),guidance:text,language:$('#edit-language',dialog).value,channel:$('#edit-channel',dialog).value,relationship:$('#edit-relationship',dialog).value.trim(),formality:$('#edit-formality',dialog).value});}
      else {updated.text=text;updated.scope={type:$('#edit-scope',dialog).value,value:$('#edit-scope-value',dialog).value.trim()};if(updated.scope.type==='global')updated.scope.value='';if(example)updated.kind=$('#edit-kind',dialog).value;else Object.assign(updated,{category:$('#edit-category',dialog).value,basis:'explicit',strength:'strong',banned:$('#edit-banned',dialog).value.split('\n').filter(v=>v.length),conflicts:r.conflicts||[]});}
      const mergeId=mode?$('#merge-target',dialog).value:'';
      run('save-profile',async()=>{
        const profile=cloneProfile();
        if(mergeId) {
          const target=profile.modes.find(m=>m.id===mergeId);if(!target)throw Error('The destination personality no longer exists. Reload and retry.');
          delete target.details;target.guidance=[target.guidance,text].filter(Boolean).join('\n');target.sourceIds=[...new Set([...(target.sourceIds||[]),...(r.sourceIds||[])])];target.sources=[...(target.sources||[]),...(r.sources||[])];target.status='edited';
          profile.modes=profile.modes.filter(m=>m.id!==r.id);
          for(const record of [...profile.preferences,...profile.examples]){if(record.scope?.type==='mode'&&record.scope.value===r.id)record.scope.value=target.id;if(record.modeId===r.id)record.modeId=target.id;}
        }else {const index=profile[collection].findIndex(x=>x.id===updated.id);if(index>=0)profile[collection][index]=updated;else profile[collection].push(updated);}
        await saveProfile(profile,'Profile updated.');ui.voiceFilter='active';dialog.close();render();
      },{paint:false});
    };
    $('#delete-record',dialog)?.addEventListener('click',()=>run('delete-record',async()=>{
      const profile=cloneProfile();profile[collection]=profile[collection].filter(x=>x.id!==r.id);
      if(mode)for(const linked of [...profile.preferences,...profile.examples])if(linked.scope?.type==='mode'&&linked.scope.value===r.id||linked.modeId===r.id)linked.status='disabled';
      await saveProfile(profile,'Removed. Undo is available.');dialog.close();render();
    },{paint:false}));
  });
}
async function inspectSource(id) {
  let source;
  try { source=await deps.api(`/api/workspace/sources/${encodeURIComponent(id)}`); }
  catch(error){const match=data.sources.find(s=>s.id.endsWith(`:${id}`));if(!match)throw error;source=await deps.api(`/api/workspace/sources/${encodeURIComponent(match.id)}`);}
  modal(source.title||'Source conversation',`<p class="dialog-description">${esc(source.source)} · ${date(source.date)}. Source text is evidence, never instructions to the app.</p>${source.discovery?.reasons?.length?`<p class="selection-note">${esc(source.discovery.reasons.join(' '))}</p>`:''}<div class="source-messages">${(source.messages||[]).map(m=>`<article><div class="record-meta"><span>${esc(m.role)} · ${esc(m.kind||'Unknown approval')}</span><span>${date(m.date)}</span></div><pre>${esc(m.text)}</pre><p class="input-hint">Message: ${esc(m.id)}${m.parentId?` · Parent: ${esc(m.parentId)}`:''}</p>${m.metadata?.excludedFragments?.length?`<details><summary>Excluded quotes / signature</summary><pre>${esc(JSON.stringify(m.metadata.excludedFragments,null,2))}</pre></details>`:''}</article>`).join('')}</div><details class="source-delete"><summary>Remove this source</summary><p class="input-hint">Deletes the source and derived profile records. Profile undo history is cleared so deleted evidence cannot return through undo.</p><button class="button secondary danger" id="delete-source">Delete source & derived records</button></details>`,dialog=>{
    $('#delete-source',dialog).onclick=()=>run('remove-source',async()=>{await deps.api(`/api/sources/${encodeURIComponent(source.id)}`,{derivedAction:'delete'},'DELETE');ui.selected.delete(source.id);await refresh();dialog.close();render();deps.notify('Source and derived records removed.');},{paint:false});
  });
}
function setJob(job) {const index=data.learningJobs.findIndex(j=>j.id===job.id);if(index<0)data.learningJobs.push(job);else data.learningJobs[index]=job;}
async function processLearning(job) {
  ui.learning=true;ui.cancel=false;setJob(job);render();
  try {
    while(!['complete','cancelled','failed','paused','error','conflict','stale'].includes(job.status)) {
      const result=await deps.api(`/api/workspace/learn/${encodeURIComponent(job.id)}`,{action:ui.cancel?'cancel':'step'});
      job=result.job;setJob(job);render();
      if(job.status==='running'){deps.notify('This analysis is already running in another request. You can cancel it here.');break;}
      await new Promise(resolve=>setTimeout(resolve,0));
    }
    await refresh();
    deps.notify(job.status==='complete'?'Learning finished. Review the proposals in Your voice.':`Learning ${job.status}. Your completed batches are retained.`);
  }catch(e){ui.error=e.message;await refresh().catch(()=>{});}
  finally {ui.learning=false;ui.busy='';render();}
}
async function processImport(job) {
  ui.cancelImport=false;ui.importJob=job;render();
  while(!['complete','cancelled'].includes(job.status)) {
    const result=await deps.api(`/api/jobs/${encodeURIComponent(job.id)}`,{action:ui.cancelImport?'cancel':'step'});job=result.job;ui.importJob=job;render();await new Promise(resolve=>setTimeout(resolve,0));
  }
  await refresh();
  deps.notify(job.status==='complete'?'Imported locally. Select the new evidence to review or learn.':'Import paused. Resume when ready.');
}
async function draftRequest(revision='') {
  const request=currentRequest();
  if(!request.intent.trim())throw Error('Add what you want to say first.');
  if(!request.modeId)throw Error('Choose a reviewed personality first.');
  if(!data.model?.tasks?.drafting?.model)throw Error('Select a drafting model using the model button above.');
  if(revision){request.previousDraft=ui.draftText;request.revision=revision;}
  const result=await deps.api('/api/workspace/draft',request);
  ui.draft={...result,request:result.request||request};ui.draftText=result.draft||'';ui.comparison=null;await refresh();
}
function bind() {
  $$('[data-tab]').forEach(b=>b.onclick=()=>{ui.tab=b.dataset.tab;ui.error='';render();});
  const textFields=['intent','context','recipient','relationship','purpose','required'];
  for(const key of textFields)$(`#${key}`)?.addEventListener('input',e=>{ui[key]=e.target.value;if(key==='context')ui.suggestion=null;});
  for(const key of ['channel','language','modeId','formality'])$(`#${key}`)?.addEventListener('change',e=>{ui[key]=e.target.value;if(key==='modeId'){ui.manualMode=Boolean(ui.modeId);ui.suggestion={reason:'You selected this personality. This overrides any suggestion.',ambiguous:false};render();}else if(['channel','language'].includes(key)){if(ui.context.trim()&&!ui.manualMode)autoSuggest();else if(key==='language')render();}});
  $('#context')?.addEventListener('change',()=>autoSuggest());
  $('#relationship')?.addEventListener('change',()=>autoSuggest());
  $('#draft-text')?.addEventListener('input',e=>{ui.draftText=e.target.value;const note=$('#draft-edit-note');if(note)note.hidden=ui.draftText===ui.draft.draft;});
  $('#compose-form')?.addEventListener('submit',e=>{e.preventDefault();run('draft',()=>draftRequest());});
  $$('[data-revision]').forEach(b=>b.onclick=()=>run('revision',()=>draftRequest(b.dataset.revision)));
  $('#feedback-verdict')?.addEventListener('change',e=>ui.feedback.verdict=e.target.value);
  $('#feedback-type')?.addEventListener('change',e=>ui.feedback.editType=e.target.value);
  $('#feedback-scope')?.addEventListener('change',e=>ui.feedback.scope=e.target.value);
  $('#feedback-note')?.addEventListener('input',e=>ui.feedback.note=e.target.value);
  $('#feedback-form')?.addEventListener('submit',e=>{e.preventDefault();run('feedback',async()=>{const result=await deps.api('/api/feedback',{draftId:ui.draft.id,finalText:ui.draftText,...ui.feedback});await refresh();deps.notify(result.notice||'Feedback saved.');});});
  $$('[data-filter]').forEach(b=>b.onclick=()=>{ui.voiceFilter=b.dataset.filter;render();});
  $('#source-search')?.addEventListener('input',e=>{ui.sourceSearch=e.target.value;ui.sourceMatches=null;clearTimeout(searchTimer);const sequence=++searchSequence;if(!ui.sourceSearch.trim()){renderSearchResults();return;}searchTimer=setTimeout(async()=>{try{const result=await deps.api(`/api/workspace/search?q=${encodeURIComponent(ui.sourceSearch)}`);if(sequence!==searchSequence)return;ui.sourceMatches=new Set(result.sourceIds||[]);if(ui.tab==='sources')renderSearchResults();}catch(error){if(sequence===searchSequence){ui.error=error.message;renderSearchResults();}}},240);});
  for(const [id,key]of [['source-from','sourceFrom'],['source-to','sourceTo']]){const input=$(`#${id}`);if(input){input.type='date';input.addEventListener('change',e=>{ui[key]=e.target.value;render();});}}
  $$('[data-source-select]').forEach(input=>input.onchange=()=>{input.checked?ui.selected.add(input.dataset.sourceSelect):ui.selected.delete(input.dataset.sourceSelect);render();});
  $('#archive-form')?.addEventListener('submit',async e=>{
    e.preventDefault();const kind=$('#import-kind').value;const pasted=$('#import-text').value;const file=$('#import-file').files[0];
    run('import',async()=>{if(file?.size>32*1024*1024)throw Error('Use an extracted JSON or text file under 32 MiB.');const input=file?await file.text():pasted;if(!input.trim())throw Error('Paste evidence or choose a file first.');const result=await deps.api('/api/import',{input,kind,source:'auto',title:file?.name||''});await processImport(result.job);});
  });
  $$('[data-ws]').forEach(b=>b.addEventListener('click',()=>action(b.dataset.ws,b)));
}
async function action(name,b) {
  if(['voice','sources','write'].includes(name)){ui.tab=name;render();return;}
  if(name==='add-sources'){deps.manageSources();return;}
  if(name==='copy'){const banned=(ui.draft.appliedPreferences||[]).filter(p=>p.category==='hard').flatMap(p=>p.banned||[]).filter(literal=>ui.draftText.includes(literal));const missing=(ui.draft.request?.requiredPhrases||[]).filter(phrase=>phrase&&!ui.draftText.includes(phrase));if(banned.length||missing.length){ui.error=[...new Set(banned)].map(literal=>`Remove the banned literal ${JSON.stringify(literal)} before copying.`).concat(missing.map(phrase=>`Restore the required phrase ${JSON.stringify(phrase)} before copying.`)).join(' ');render();return;}try{await navigator.clipboard.writeText(ui.draftText);deps.notify('Copied. Review and send it yourself.');}catch{ui.error='Clipboard access was unavailable. Select and copy the draft directly.';render();}return;}
  if(name==='try-mode'){ui.modeId=b.dataset.id;ui.manualMode=true;ui.suggestion={reason:'You selected this personality from your reviewed voice.',ambiguous:false};ui.tab='write';render();return;}
  if(name==='new-mode'){editRecord('modes',null,true);return;}
  if(name==='new-preference'){editRecord('preferences',null,true);return;}
  if(name==='new-example'){editRecord('examples',null,true);return;}
  if(name==='edit-record'){editRecord(b.dataset.collection,data.profile[b.dataset.collection].find(r=>r.id===b.dataset.id));return;}
  if(name==='duplicate-mode'){const original=data.profile.modes.find(m=>m.id===b.dataset.id);editRecord('modes',{...original,id:uid(),name:`${original.name} / new situation`},true);return;}
  if(name==='select-visible'){for(const s of filteredSources())ui.selected.add(s.id);render();return;}
  if(name==='clear-sources'){ui.selected.clear();render();return;}
  if(name==='cancel-learn'){ui.cancel=true;try{const result=await deps.api(`/api/workspace/learn/${encodeURIComponent(b.dataset.id)}`,{action:'cancel'});setJob(result.job);render();}catch(e){ui.error=e.message;render();}return;}
  if(name==='personality-preview'){await run(name,()=>showPersonalityPreview(0),{paint:false});return;}
  if(name==='cancel-personalities'){ui.personalityCancel=true;try{const result=await deps.api(`/api/workspace/personalities/${encodeURIComponent(b.dataset.id)}`,{action:'cancel'});setPersonalityJob(result.job);render();}catch(e){ui.error=e.message;render();}return;}
  if(name==='resume-personalities'){if(ui.personalityLearning||ui.busy)return;showPersonalityResume(data.personalityJobs.find(job=>job.id===b.dataset.id));return;}
  if(name==='cancel-import'){ui.cancelImport=true;return;}
  if(name==='load-draft'){const draft=data.drafts.find(d=>d.id===b.dataset.id);ui.draft=draft;ui.draftText=draft.draft||'';ui.manualMode=true;const request=draft.request||{};for(const key of ['intent','context','modeId','channel','language','formality','recipient','relationship','purpose'])if(request[key]!=null)ui[key]=request[key];ui.required=(request.requiredPhrases||[]).join('\n');render();return;}
  if(name==='model') {showModelSettings();return;}
  if(name==='record-status') { await run(name,async()=>{const profile=cloneProfile();const record=profile[b.dataset.collection].find(r=>r.id===b.dataset.id);record.status=b.dataset.status;if(b.dataset.collection==='examples'&&record.kind==='sent'&&record.status==='accepted'){record.originalKind='sent';record.kind='approved';}await saveProfile(profile,'Decision saved.');});return; }
  if(name==='undo'){await run(name,async()=>{await deps.api('/api/profile/undo',{});await refresh();deps.notify('Last profile change undone.');});return;}
  if(name==='inspect'){await run(name,()=>inspectSource(b.dataset.id),{paint:false});return;}
  if(name==='draft-preview'){await run(name,async()=>{const preview=await deps.api('/api/workspace/draft/preview',currentRequest());const routes=preview.routes||{};modal('What the model receives.',`<p class="dialog-description">Planning and generation send this payload to ${esc(connectionLabel(routes.drafting))} (${esc(modelLabel(routes.drafting))}); critique sends it to ${esc(connectionLabel(routes.critique))} (${esc(modelLabel(routes.critique))}). Later calls also include the plan and draft. Example facts are redacted where possible. Review for unintended details.</p>${preview.warnings?.map(x=>`<p class="input-hint">${esc(x)}</p>`).join('')||''}<pre class="payload-preview">${esc(JSON.stringify(preview.payload,null,2))}</pre>`);},{paint:false});return;}
  if(name==='suggest-mode'){await run(name,async()=>{ui.suggestion=await deps.api('/api/workspace/suggest-mode',currentRequest());ui.manualMode=false;if(ui.suggestion.modeId&&!ui.suggestion.ambiguous)ui.modeId=ui.suggestion.modeId;else ui.modeId='';});return;}
  if(name==='compare'){await run(name,async()=>{ui.comparison=await deps.api('/api/workspace/compare',currentRequest());});return;}
  if(name==='vote'){await run(name,async()=>{ui.comparison.voted=await deps.api('/api/evaluations',{comparisonId:ui.comparison.id,choice:b.dataset.side,note:''});});return;}
  if(name==='delete-feedback'){await run(name,async()=>{await deps.api(`/api/feedback/${encodeURIComponent(b.dataset.id)}`,{},'DELETE');await refresh();deps.notify('Feedback and derived records removed.');});return;}
  if(name==='learn-preview') { await run(name,()=>showLearningPreview([...ui.selected],0),{paint:false});return; }
  if(name==='resume-learn'){if(ui.learning)return;ui.busy='learning';try{const result=await deps.api(`/api/workspace/learn/${encodeURIComponent(b.dataset.id)}`,{action:'resume'});await processLearning(result.job);}catch(e){ui.error=e.message;ui.busy='';render();}return;}
  if(name==='resume-import'){await run(name,async()=>{const result=await deps.api(`/api/jobs/${encodeURIComponent(ui.importJob.id)}`,{action:'resume'});await processImport(result.job);});return;}
  if(name==='extract-local'){await run(name,async()=>{const result=await deps.api('/api/extract',{sourceIds:[...ui.selected]});await refresh();deps.notify((result.warnings||[]).join(' ')||'Explicit evidence proposed locally. Review it in Your voice.');});return;}
  if(name==='chatbot-prompt'){await run(name,async()=>{const result=await deps.api('/api/chatbot-prompt');modal('Ask your existing chatbot.',`<p class="dialog-description">Paste this into your existing chatbot, then import its report. It must separate retrieved evidence from impressions and disclose its search limits.</p><textarea id="chatbot-prompt-text" readonly rows="15">${esc(result.prompt)}</textarea><button class="button secondary" id="copy-chatbot">Copy prompt</button>`,dialog=>{$('#copy-chatbot',dialog).onclick=async()=>{try{await navigator.clipboard.writeText(result.prompt);deps.notify('Prompt copied.');}catch{$('#chatbot-prompt-text',dialog).select();}};});},{paint:false});return;}
  if(name==='markdown'){await run(name,async()=>{const result=await deps.api('/api/profile/markdown');modal('Your profile, in Markdown.',`<p class="dialog-description">Edit text and JSON metadata while preserving record markers. A concurrent edit will be rejected so your changes are not overwritten.</p><form id="markdown-form"><textarea id="markdown-text" class="code-editor" rows="18">${esc(result.markdown)}</textarea><button class="button primary" type="submit">Save profile</button></form>`,dialog=>{$('#markdown-form',dialog).onsubmit=e=>{e.preventDefault();const markdown=$('#markdown-text',dialog).value;run('save-markdown',async()=>{await deps.api('/api/profile/markdown',{markdown,version:result.version},'PUT');await refresh();dialog.close();render();},{paint:false});};});},{paint:false});}
}
let suggestionSequence=0,searchSequence=0,searchTimer;
function renderSearchResults(){const active=document.activeElement?.id==='source-search';const position=$('#source-search')?.selectionStart;render();if(active&&$('#source-search')){$('#source-search').focus();$('#source-search').setSelectionRange(position,position);}}
async function autoSuggest() {
  if(!ui.context.trim()||ui.manualMode||ui.busy)return;
  const sequence=++suggestionSequence;
  try {const suggestion=await deps.api('/api/workspace/suggest-mode',currentRequest());if(sequence!==suggestionSequence||ui.manualMode)return;ui.suggestion=suggestion;ui.modeId=suggestion.ambiguous?'':suggestion.modeId||'';render();}
  catch(e){if(sequence===suggestionSequence){ui.error=e.message;render();}}
}
async function showLearningPreview(sourceIds,batchIndex) {
  const preview=await deps.api('/api/workspace/learn/preview',{sourceIds,batchIndex});
  const count=Number(preview.batchCount)||1,index=Number(preview.batchIndex)||0;
  modal('Choose what leaves this computer.',`<p class="dialog-description">These selected excerpts go to ${esc(connectionLabel(data.model?.tasks?.analysis))} (${esc(modelLabel(data.model?.tasks?.analysis))}) to propose writing preferences and personalities. Incoming messages provide context. Sent messages are not assumed to be approved. Nothing is accepted automatically.</p><div class="preview-pagination"><span>Batch ${index+1} of ${count}</span><div><button class="text-button" id="preview-previous" ${index===0?'disabled':''}>Previous</button><button class="text-button" id="preview-next" ${index+1>=count?'disabled':''}>Next</button></div></div>${(preview.warnings||[]).map(w=>`<p class="input-hint">${esc(w)}</p>`).join('')}<details class="payload-detail"><summary>Inspect the exact content in this batch</summary><pre class="payload-preview">${esc(JSON.stringify(preview.payload,null,2))}</pre></details><p class="input-hint">Starting sends all ${count} selected ${count===1?'batch':'batches'}, one at a time. You can cancel between batches and resume later.</p><button class="button primary" id="begin-learning">Send selection & learn</button>`,dialog=>{
    for(const [id,next]of [['preview-previous',index-1],['preview-next',index+1]])$(`#${id}`,dialog).onclick=()=>run('preview-batch',()=>showLearningPreview(sourceIds,next),{paint:false});
    $('#begin-learning',dialog).onclick=async()=>{if(ui.learning||ui.busy)return;dialog.close();ui.busy='learning';ui.learning=true;render();try{const result=await deps.api('/api/workspace/learn',{sourceIds});await processLearning(result.job);}catch(e){ui.error=e.message;ui.busy='';ui.learning=false;render();}};
  });
}

function setPersonalityJob(job) {
  const index=data.personalityJobs.findIndex(j=>j.id===job.id);
  if(index<0)data.personalityJobs.push(job);else data.personalityJobs[index]=job;
}
async function processPersonalities(job) {
  ui.personalityLearning=true;ui.personalityCancel=false;ui.tab='voice';setPersonalityJob(job);render();
  try {
    while(!['complete','cancelled','failed','paused','error','conflict','stale'].includes(job.status)) {
      const result=await deps.api(`/api/workspace/personalities/${encodeURIComponent(job.id)}`,{action:ui.personalityCancel?'cancel':'step'});
      job=result.job;setPersonalityJob(job);render();
      if(job.status==='running'){deps.notify('This analysis is running in another request. You can cancel it here.');break;}
      await new Promise(resolve=>setTimeout(resolve,0));
    }
    await refresh();
    if(job.status==='complete')ui.voiceFilter='proposed';
    deps.notify(job.status==='complete'?'Your baseline is ready. Review and fine-tune the proposed personalities.':`Baseline ${job.status}. Completed analysis is retained.`);
  }catch(e){ui.error=e.message;await refresh().catch(()=>{});}
  finally {ui.personalityLearning=false;ui.busy='';render();}
}
function showPersonalityResume(job) {
  if(!job)return;
  const effort=validEffort(job.modelId,job.effort||'default',job.provider);
  modal('Resume your baseline.',`<p class="dialog-description">Continue with ${esc(job.modelId||'the selected model')}. ${Math.min(Number(job.processedBatches)||0,Number(job.batchCount)||0)} of ${Number(job.batchCount)||0} completed batches are retained.</p>${job.error?`<p class="error-box">${esc(jobError(job))}</p>`:''}<form id="personality-resume-form">${effortField('resume-effort',job.modelId,effort,job.provider)}<p class="input-hint">This effort applies to the remaining analysis and synthesis. Provider charges apply to the remaining requests. No completed batch is repeated.</p><button type="submit" class="button primary">Resume analysis</button></form>`,dialog=>{
    $('#personality-resume-form',dialog).onsubmit=async event=>{
      event.preventDefault();if(ui.personalityLearning||ui.busy)return;
      const selectedEffort=validEffort(job.modelId,$('#resume-effort',dialog).value,job.provider);
      dialog.close();ui.busy='personalities';
      try{const result=await deps.api(`/api/workspace/personalities/${encodeURIComponent(job.id)}`,{action:'resume',effort:selectedEffort});await processPersonalities(result.job);}
      catch(error){ui.error=error.message;ui.busy='';render();}
    };
  });
}
function baselineBilling(choice) {
  const connection=modelEntry(choice?.modelId,choice?.provider)?.connection||'';
  return /plan$/.test(connection)?`Uses your ${connection} for this run. Plan limits apply.`:choice?'Uses your connected API key for this run. Provider charges apply.':'Choose a model for this run.';
}
async function showPersonalityPreview(batchIndex) {
  const preview=await deps.api('/api/workspace/personalities/preview',{batchIndex});
  const count=Number(preview.batchCount)||0,index=Number(preview.batchIndex)||0;
  const sources=Number(preview.counts?.sources??preview.totalSources)||0,messages=Number(preview.counts?.messages??preview.totalMessages)||0;
  const available=(data.model?.availableModels||[]).filter(m=>typeof m!=='string').map(m=>routeKey(m.provider,m.id));
  const analysis=data.model?.tasks?.analysis;
  if(!available.includes(ui.personalityModel)){ui.personalityModel=analysis?.available!==false&&available.includes(routeKey(analysis?.provider,analysis?.model))?routeKey(analysis.provider,analysis.model):available[0]||'';ui.personalityEffort=analysis?.effort||'default';}
  const pick=parseRoute(ui.personalityModel);
  ui.personalityEffort=validEffort(pick?.modelId,ui.personalityEffort,pick?.provider);
  const disclosures=Array.isArray(preview.synthesisDisclosures)?preview.synthesisDisclosures:preview.synthesisDisclosures?[preview.synthesisDisclosures]:[];
  modal('Create your baseline personalities.',`<p class="dialog-description">Analyze all ${plural(sources,'imported source')} into 3–5 detailed personalities to review and fine-tune.</p><form id="personality-create-form"><div class="form-grid"><div><label class="field-label" for="personality-model">Model for this analysis</label><select id="personality-model">${modelChoices(ui.personalityModel)}</select></div>${effortField('personality-effort',pick?.modelId,ui.personalityEffort,pick?.provider)}</div><p class="input-hint" id="personality-billing">${baselineBilling(pick)} Your drafting model stays unchanged.</p><div class="baseline-preview-summary"><span>${plural(sources,'source')}</span><span>${plural(messages,'message')}</span><span>${plural(count,'analysis batch')} + synthesis</span></div><p class="muted">Reads the first ${Number(preview.limits?.excerpt||1800).toLocaleString()} characters of each message. Earlier batches are compressed into up to ${Number(preview.limits?.observations||10)} observations, so detail can be lost.</p><details class="payload-detail"><summary>Coverage & limits</summary><p class="muted">Includes all imported sources, regardless of search or selection in Sources. Incoming messages are context; unapproved drafts are not your voice. Closing this page pauses the queue after the current request; resume here later.</p>${(preview.warnings||[]).map(w=>`<p class="muted">${esc(w)}</p>`).join('')}</details>${count?`<div class="preview-pagination"><span>Batch ${index+1} of ${count}</span><div><button type="button" class="text-button" id="personality-preview-previous" ${index===0?'disabled':''}>Previous</button><button type="button" class="text-button" id="personality-preview-next" ${index+1>=count?'disabled':''}>Next</button></div></div>`:''}<details class="payload-detail"><summary>Inspect the content sent in this batch</summary><pre class="payload-preview">${esc(JSON.stringify(preview.payload,null,2))}</pre></details>${disclosures.length?`<details class="payload-detail"><summary>What synthesis receives</summary>${disclosures.map(item=>`<p class="muted">${esc(typeof item==='string'?item:JSON.stringify(item))}</p>`).join('')}</details>`:''}<p class="input-hint">Sparse evidence may support fewer than three personalities. All results remain proposals until you review them.</p><button type="submit" class="button primary" id="begin-personalities" ${!count||!available.length?'disabled':''}>Analyze all sources & create</button></form>`,dialog=>{
    $('#personality-effort',dialog).onchange=event=>{ui.personalityEffort=event.target.value;};
    $('#personality-model',dialog).onchange=event=>{ui.personalityModel=event.target.value;const choice=parseRoute(ui.personalityModel);ui.personalityEffort=updateEffortField(dialog,'personality-effort',choice?.modelId,ui.personalityEffort,value=>{ui.personalityEffort=value;},choice?.provider);$('#personality-billing',dialog).textContent=`${baselineBilling(choice)} Your drafting model stays unchanged.`;};
    for(const [id,next]of [['personality-preview-previous',index-1],['personality-preview-next',index+1]])$(`#${id}`,dialog)?.addEventListener('click',()=>run('personality-preview-batch',()=>showPersonalityPreview(next),{paint:false}));
    $('#personality-create-form',dialog).onsubmit=async event=>{
      event.preventDefault();if(ui.personalityLearning||ui.busy)return;
      const choice=parseRoute($('#personality-model',dialog).value);
      if(!choice){$('#personality-model',dialog).focus();return;}
      ui.personalityModel=routeKey(choice.provider,choice.modelId);ui.personalityEffort=validEffort(choice.modelId,$('#personality-effort',dialog).value,choice.provider);dialog.close();ui.busy='personalities';ui.personalityLearning=true;ui.tab='voice';render();
      try{const result=await deps.api('/api/workspace/personalities',{provider:choice.provider,modelId:choice.modelId,effort:ui.personalityEffort});await processPersonalities(result.job);}
      catch(e){ui.error=e.message;ui.busy='';ui.personalityLearning=false;render();}
    };
  });
}
