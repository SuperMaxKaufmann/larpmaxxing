import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../server/storage.mjs';
import {ModelSession} from '../server/model-access.mjs';
import {createApp} from '../server/index.mjs';
import {completeJSON} from '../server/providers.mjs';
import {PLAN_SYSTEM,DRAFT_SYSTEM,REVIEW_SYSTEM} from '../server/drafting.mjs';
import {CLAUDE_PLAN_MODELS,ClaudePlanError,ClaudeRunError,checkClaudeCode,interpretRun,locateClaude,planEnv,runClaudePlan} from '../server/claude-plan.mjs';

const events=list=>list.map(event=>JSON.stringify(event)).join('\n');
const signedOutRun=events([
  {type:'system',subtype:'init',apiKeySource:'none',model:'claude-sonnet-5-5'},
  {type:'assistant',error:'authentication_failed',is_api_error_message:true,message:{model:'<synthetic>',content:[{type:'text',text:'Not logged in · Please run /login'}]}},
  {type:'result',subtype:'success',is_error:true,terminal_reason:'api_error',api_error_status:null,result:'Not logged in · Please run /login'},
]);
const successRun=text=>events([{type:'system',subtype:'init',apiKeySource:'none'},{type:'assistant',message:{content:[{type:'text',text}]}},{type:'result',subtype:'success',is_error:false,stop_reason:'end_turn',result:text}]);
const tempDir=(t,prefix)=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),prefix));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;};

test('finds Claude Code on PATH, in the native installer location, or at CLAUDE_CLI_PATH',()=>{
  const home=path.join(path.sep,'home','writer'),bin=path.join(path.sep,'opt','tools');
  assert.equal(locateClaude({PATH:bin,HOME:home},{isExecutable:file=>file===path.join(bin,'claude')}),path.join(bin,'claude'));
  assert.equal(locateClaude({PATH:'',HOME:home},{isExecutable:file=>file===path.join(home,'.local','bin','claude')}),path.join(home,'.local','bin','claude'));
  assert.equal(locateClaude({PATH:'relative/bin',HOME:home},{isExecutable:file=>file.startsWith('relative')}),null);
  assert.equal(locateClaude({CLAUDE_CLI_PATH:'claude',PATH:bin},{isExecutable:()=>true}),null);
  assert.equal(locateClaude({CLAUDE_CLI_PATH:path.join(bin,'custom-claude'),PATH:bin},{isExecutable:()=>true}),path.join(bin,'custom-claude'));
  assert.equal(locateClaude({PATH:bin,HOME:home},{isExecutable:()=>false}),null);
});

test('the CLI gets an allowlisted environment that cannot switch it to API billing or bare mode',()=>{
  const env=planEnv({HOME:'/h',PATH:'/bin',LC_ALL:'de_DE.UTF-8',CLAUDE_CONFIG_DIR:'/c',CLAUDE_CODE_OAUTH_TOKEN:'own-plan-token',ANTHROPIC_API_KEY:'sk-api',ANTHROPIC_BASE_URL:'http://proxy',ANTHROPIC_AUTH_TOKEN:'x',CLAUDE_CODE_SIMPLE:'1',CLAUDECODE:'1',CLAUDE_CODE_USE_BEDROCK:'1',OPENAI_API_KEY:'sk-openai',GMAIL_ACCESS_TOKEN:'g'});
  assert.deepEqual(Object.keys(env).sort(),['CLAUDE_CODE_OAUTH_TOKEN','CLAUDE_CONFIG_DIR','HOME','LC_ALL','PATH']);
});

test('sign-in check explains missing, signed-out and API-billing setups before anything is sent',async()=>{
  const replies=status=>{const calls=[];return {calls,exec:async(file,args,options)=>{calls.push({file,args,options});if(args[0]==='--version')return {code:0,stdout:'2.1.300 (Claude Code)\n'};return {code:status.loggedIn?0:1,stdout:JSON.stringify(status)};}};};
  await assert.rejects(checkClaudeCode({env:{},locate:()=>null}),error=>error instanceof ClaudePlanError&&error.code==='missing'&&/claude auth login/.test(error.message)&&/CLAUDE_CLI_PATH/.test(error.message));
  await assert.rejects(checkClaudeCode({env:{},locate:()=>'/bin/claude',exec:replies({loggedIn:false,authMethod:'none'}).exec}),error=>error.code==='signed_out'&&/claude auth login/.test(error.message));
  await assert.rejects(checkClaudeCode({env:{},locate:()=>'/bin/claude',exec:replies({loggedIn:true,authMethod:'api_key',apiProvider:'firstParty'}).exec}),error=>error.code==='not_plan');
  await assert.rejects(checkClaudeCode({env:{},locate:()=>'/bin/claude',exec:replies({loggedIn:true,authMethod:'third_party',apiProvider:'bedrock'}).exec}),error=>error.code==='not_plan');
  await assert.rejects(checkClaudeCode({env:{},locate:()=>'/bin/claude',exec:async()=>{throw new ClaudeRunError('missing');}}),error=>error.code==='missing');
  await assert.rejects(checkClaudeCode({env:{},locate:()=>'/bin/claude',exec:async()=>({code:0,stdout:'not json'})}),error=>error.code==='unreadable');
  const ok=replies({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty',email:'writer@example.com',subscriptionType:'pro'});
  const result=await checkClaudeCode({env:{HOME:'/h',ANTHROPIC_API_KEY:'sk-api'},locate:()=>'/bin/claude',exec:ok.exec});
  assert.deepEqual({version:result.version,plan:result.plan,accountLabel:result.accountLabel,binary:result.binary},{version:'2.1.300',plan:'Claude Pro',accountLabel:'writer@example.com',binary:'/bin/claude'});
  assert.deepEqual(ok.calls.map(call=>call.args),[['--version'],['auth','status']]);
  assert.ok(ok.calls.every(call=>!('ANTHROPIC_API_KEY' in call.options.env)));
  const token=await checkClaudeCode({env:{},locate:()=>'/bin/claude',exec:replies({loggedIn:true,authMethod:'oauth_token'}).exec});
  assert.equal(token.accountLabel,'Claude plan');
});

test('run output maps to fixed categories and never returns CLI error text',()=>{
  assert.equal(interpretRun(successRun('{"draft":"Hi"}'),0),'{"draft":"Hi"}');
  const failure=(stdout,code=1)=>{try{interpretRun(stdout,code);}catch(error){assert.ok(error instanceof ClaudeRunError);return error.code;}assert.fail('expected a failure');};
  assert.equal(failure(signedOutRun),'signed_out');
  assert.equal(failure(events([{type:'system',subtype:'api_retry',error:'rate_limit'},{type:'result',subtype:'success',is_error:true,result:'x'}])),'limit');
  assert.equal(failure(events([{type:'assistant',error:'model_not_found'},{type:'result',is_error:true,subtype:'success'}])),'model');
  assert.equal(failure(events([{type:'assistant',error:'billing_error'},{type:'result',is_error:true,subtype:'success'}])),'account');
  assert.equal(failure(events([{type:'result',subtype:'success',is_error:true,result:'Claude AI usage limit reached|1760000000'}])),'limit');
  assert.equal(failure(events([{type:'result',subtype:'error_max_turns',is_error:true}])),'incomplete');
  assert.equal(failure(events([{type:'result',subtype:'success',is_error:false,stop_reason:'max_tokens',result:'{'}])),'output_limit');
  assert.equal(failure(events([{type:'system',subtype:'init',apiKeySource:'ANTHROPIC_API_KEY'},{type:'result',subtype:'success',is_error:false,result:'{}'}]),0),'not_plan');
  assert.equal(failure('',1),'failed');
  assert.equal(failure('',0),'invalid_response');
});

test('a run sends private content on stdin only, with tools and customizations off and no saved session',async()=>{
  let seen,prompt;
  const exec=async(file,args,options)=>{seen={file,args,options};prompt=fs.readFileSync(args[args.indexOf('--system-prompt-file')+1],'utf8');return {code:0,stdout:successRun('{"ok":true}')};};
  const content=JSON.stringify({intent:'Private intent about the merger'});
  const text=await runClaudePlan({binary:'/bin/claude',env:{HOME:'/h',ANTHROPIC_API_KEY:'sk-api'},system:'Write carefully.',content,model:'opus',effort:'high',exec});
  assert.equal(text,'{"ok":true}');
  assert.equal(seen.file,'/bin/claude');assert.equal(prompt,'Write carefully.');assert.equal(seen.options.input,content);
  for(const flag of ['-p','--safe-mode','--strict-mcp-config','--disable-slash-commands','--no-session-persistence'])assert.ok(seen.args.includes(flag),flag);
  assert.equal(seen.args[seen.args.indexOf('--tools')+1],'');
  assert.equal(seen.args[seen.args.indexOf('--model')+1],'opus');assert.equal(seen.args[seen.args.indexOf('--effort')+1],'high');
  assert.equal(seen.args[seen.args.indexOf('--output-format')+1],'stream-json');
  assert.ok(!seen.args.includes('--bare'),'bare mode ignores the plan login');
  assert.ok(!seen.args.some(arg=>arg.includes('merger')));
  assert.deepEqual(Object.keys(seen.options.env),['HOME']);
  assert.equal(fs.existsSync(seen.options.cwd),false,'the private working directory is removed');
  await runClaudePlan({binary:'/bin/claude',system:'S',content:'{}',model:'sonnet',exec});
  assert.ok(!seen.args.includes('--effort'));
});

test('completeJSON routes claude-plan through the CLI runner with plan-specific errors',async()=>{
  const credentials=run=>({provider:'claude-plan',authMode:'claude-plan',model:'sonnet',run});
  let received;
  const parsed=await completeJSON('claude-plan','Plan the reply.',{intent:'hello'},{credentials:credentials(async options=>{received=options;return 'Sure:\n```json\n{"points":[]}\n```';}),effort:'low'});
  assert.deepEqual(parsed,{points:[]});
  assert.equal(received.model,'sonnet');assert.equal(received.effort,'low');assert.match(received.system,/Plan the reply\.\nReturn a single JSON object only\./);assert.equal(received.content,'{"intent":"hello"}');
  assert.deepEqual(await completeJSON('claude-plan','S',{},{credentials:credentials(async()=>'Here it is: {"draft":"Hi"} Hope that helps.')}),{draft:'Hi'});
  await assert.rejects(completeJSON('claude-plan','S',{},{credentials:credentials(async()=>{throw new ClaudeRunError('limit');})}),/Claude plan usage limit reached/);
  await assert.rejects(completeJSON('claude-plan','S',{},{credentials:credentials(async()=>{throw new ClaudeRunError('signed_out');})}),/claude auth login/);
  await assert.rejects(completeJSON('claude-plan','S',{},{credentials:credentials(async()=>{throw new ClaudeRunError('missing');})}),/can no longer be found/);
  await assert.rejects(completeJSON('claude-plan','S',{},{credentials:credentials(async()=>{throw new Error('raw CLI text with secrets');})}),error=>!/secrets/.test(error.message)&&/Claude Code could not complete/.test(error.message));
  await assert.rejects(completeJSON('claude-plan','S',{},{credentials:credentials(async()=>'no json here')}),/did not return valid JSON/);
  await assert.rejects(completeJSON('claude-plan','S',{},{env:{ANTHROPIC_API_KEY:'sk',ANTHROPIC_MODEL:'sonnet'}}),/not configured/);
  await assert.rejects(completeJSON('claude-plan','S',{},{credentials:{provider:'claude-plan',model:'sonnet'}}),/not configured/);
  await assert.rejects(completeJSON('claude-plan','S',{},{credentials:credentials(async()=>'{}'),effort:'none'}),/effort supported/);
  const controller=new AbortController();
  const pending=completeJSON('claude-plan','S',{},{credentials:credentials(()=>new Promise(()=>{})),signal:controller.signal});
  controller.abort();
  await assert.rejects(pending,/cancelled/);
  await assert.rejects(completeJSON('claude-plan','S',{},{credentials:credentials(()=>new Promise(()=>{})),timeoutMs:20}),/timed out/);
});

test('a Claude plan can stand alone or sit beside ChatGPT, with a route per task',async()=>{
  const saved=[];
  const session=new ModelSession({verifier:async({provider})=>({provider,model:'gpt-test',verified:true,validation:'models-list',verifiedAt:new Date().toISOString(),availableModelCount:2,availableModels:[{id:'gpt-test'},{id:'gpt-6-astra'}]})});
  session.useRouteStorage({},routes=>saved.push(routes));
  const run=async()=>'{}';
  let status=session.connectClaude({models:CLAUDE_PLAN_MODELS,run,version:'2.1.300',accountLabel:'writer@example.com',plan:'Claude Pro'});
  assert.equal(status.verified,true);assert.equal(status.authMode,'claude-plan');assert.equal(status.provider,'claude-plan');assert.equal(status.model,'sonnet');
  assert.deepEqual(status.tasks.critique,{provider:'claude-plan',model:'sonnet',effort:'default',inherited:true,available:true});
  assert.ok(!JSON.stringify(status).includes('run'));
  await session.verify({provider:'openai',apiKey:'synthetic-key'});
  status=session.status;
  assert.equal(status.authMode,undefined);assert.equal(status.provider,'openai');assert.equal(status.claude.accountLabel,'writer@example.com');
  assert.deepEqual(status.availableModels.map(model=>[model.provider,model.id,model.connection]),[['openai','gpt-test','OpenAI API'],['openai','gpt-6-astra','OpenAI API'],['claude-plan','sonnet','Claude plan'],['claude-plan','opus','Claude plan'],['claude-plan','haiku','Claude plan']]);
  assert.equal(status.tasks.drafting.provider,'openai');
  const revision=session.revision;
  status=session.setRoutes({critique:{provider:'claude-plan',model:'haiku',effort:'low'},analysis:{provider:'claude-plan',model:'opus',effort:'max'}});
  assert.ok(session.revision>revision);
  assert.deepEqual(status.tasks.critique,{provider:'claude-plan',model:'haiku',effort:'low',inherited:false,available:true});
  assert.equal(status.tasks.drafting.model,'gpt-test');
  assert.deepEqual(saved.at(-1).analysis,{provider:'claude-plan',model:'opus',effort:'max'});
  assert.equal(session.credentialsFor('claude-plan').run,run);assert.equal(session.credentialsFor('anthropic'),null);
  status=session.setRoutes({drafting:{provider:'claude-plan',model:'opus'}});
  assert.equal(status.tasks.drafting.provider,'claude-plan');assert.equal(status.model,'gpt-test','the primary default is kept');
  status=session.setRoutes({drafting:{provider:'openai',model:'gpt-6-astra',effort:'high'},critique:null});
  assert.equal(status.tasks.drafting.model,'gpt-6-astra');assert.equal(status.effort,'high');assert.equal(status.tasks.critique.inherited,true);
  assert.throws(()=>session.setRoutes({review:null}),/drafting, critique or analysis/);
  assert.throws(()=>session.setRoutes({critique:{provider:'claude-plan',model:'fable'}}),/Choose a model/);
  assert.throws(()=>session.setRoutes({critique:{provider:'claude-plan',model:'haiku',effort:'none'}}),/effort supported/);
  assert.throws(()=>session.setRoutes({drafting:null}),/Choose a model/);
  status=session.disconnectClaude();
  assert.equal(status.claude,null);assert.equal(status.tasks.analysis.inherited,true);assert.equal(saved.at(-1).analysis,null);
  session.connectClaude({models:CLAUDE_PLAN_MODELS,run});
  session.setRoutes({critique:{provider:'claude-plan',model:'opus'},analysis:{provider:'openai',model:'gpt-test'}});
  status=session.clear();
  assert.equal(status.verified,true,'the Claude plan stays connected');assert.equal(status.authMode,'claude-plan');
  assert.equal(status.tasks.critique.model,'opus');assert.equal(status.tasks.analysis.inherited,true,'routes to the removed connection are dropped');
});

test('a saved route to an account that is not connected is reported, never rerouted',()=>{
  const session=new ModelSession();
  session.useRouteStorage({critique:{provider:'claude-plan',model:'opus',effort:'high'},analysis:{provider:'evil',model:'x',effort:'default'}});
  session.connectChatGPT({models:[{id:'gpt-test'}],model:'gpt-test',accountLabel:'a@example.com',getAccessToken:async()=>'token'});
  const {tasks}=session.status;
  assert.deepEqual(tasks.critique,{provider:'claude-plan',model:'opus',effort:'high',inherited:false,available:false});
  assert.equal(tasks.analysis.inherited,true,'invalid saved routes are ignored');
});

function fakeClaude(t) {
  const dir=tempDir(t,'larp-fake-claude-');
  const binary=path.join(dir,'claude');
  fs.writeFileSync(path.join(dir,'package.json'),'{"type":"commonjs"}');
  fs.writeFileSync(binary,`#!${process.execPath}
const fs=require('fs'),path=require('path');
const dir=path.dirname(process.argv[1]);
const scenario=JSON.parse(fs.readFileSync(path.join(dir,'scenario.json'),'utf8'));
const args=process.argv.slice(2);
const out=event=>process.stdout.write(JSON.stringify(event)+'\\n');
if(args[0]==='--version'){process.stdout.write('2.1.300 (Claude Code)\\n');process.exit(0);}
if(args[0]==='auth'){
  const status=scenario.auth==='signed_out'?{loggedIn:false,authMethod:'none',apiProvider:'firstParty'}:{loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty',email:'writer@example.com',subscriptionType:'pro'};
  process.stdout.write(JSON.stringify(status,null,2));process.exit(status.loggedIn?0:1);
}
let input='';process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{
  const flag=name=>{const at=args.indexOf(name);return at<0?null:args[at+1];};
  const system=fs.readFileSync(flag('--system-prompt-file'),'utf8');
  fs.appendFileSync(path.join(dir,'calls.jsonl'),JSON.stringify({args,stdin:input,cwd:process.cwd(),envKeys:Object.keys(process.env),model:flag('--model'),effort:flag('--effort'),system})+'\\n');
  out({type:'system',subtype:'init',apiKeySource:'none'});
  if(scenario.run==='slow'){setTimeout(()=>{},60000);return;}
  if(scenario.run==='rate_limit'){out({type:'assistant',error:'rate_limit',message:{content:[{type:'text',text:'Claude AI usage limit reached'}]}});out({type:'result',subtype:'success',is_error:true,result:'Claude AI usage limit reached'});process.exit(1);}
  const payload=JSON.parse(input);
  const reply=/Analyze incoming questions/.test(system)?{incomingRequests:[],points:[{id:'p1',text:payload.intent}],missing:[]}:/Produce \\{draft:string\\}/.test(system)?{draft:'Thanks, I will keep the tradeoffs in the outline.'}:/Review a candidate draft/.test(system)?{contentIssues:[],styleIssues:['Slightly formal.'],missingPointIds:[],unsupportedClaims:[]}:{ok:true};
  out({type:'result',subtype:'success',is_error:false,stop_reason:'end_turn',result:'Here you go:\\n'+JSON.stringify(reply)});
});
`,{mode:0o755});
  const scenario=value=>fs.writeFileSync(path.join(dir,'scenario.json'),JSON.stringify(value));
  const calls=()=>fs.existsSync(path.join(dir,'calls.jsonl'))?fs.readFileSync(path.join(dir,'calls.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line)):[];
  scenario({});
  return {binary,scenario,calls};
}

async function harness(t,env) {
  const store=new Store(tempDir(t,'larp-claude-http-'));
  const session=new ModelSession({verifier:async({provider})=>({provider,model:'gpt-test',verified:true,validation:'models-list',verifiedAt:new Date().toISOString(),availableModelCount:1,availableModels:[{id:'gpt-test'}]})});
  const server=createApp({store,env,modelSession:session});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`;
  const initial=await(await fetch(base+'/api/onboarding')).json();
  const call=async(route,input={},method='POST')=>{const response=await fetch(base+route,{method,headers:{'Content-Type':'application/json','X-Local-Token':initial.csrfToken},body:JSON.stringify(input)});return {status:response.status,data:await response.json()};};
  return {store,session,call,initial,base};
}

const request={intent:'Thank you for the outline. Please keep the tradeoffs.',channel:'email',language:'en',modeId:'team',context:'Could you review the outline?'};
function addPersonality(store) {
  const current=store.readProfile();
  current.profile.modes.push({id:'team',name:'Close colleagues',status:'accepted',guidance:'Keep warmth and useful detail.',language:'en',channel:'email'});
  store.saveProfile(current.profile,current.version);
}

test('end to end: connect through the real CLI process, draft with Sonnet and critique with Haiku',{skip:process.platform==='win32'},async t=>{
  const fake=fakeClaude(t);
  const {store,call,initial}=await harness(t,{CLAUDE_CLI_PATH:fake.binary,HOME:os.tmpdir(),ANTHROPIC_API_KEY:'sk-must-not-pass',CLAUDE_CODE_SIMPLE:'1'});
  assert.deepEqual(initial.claude,{connected:false,version:'',accountLabel:'',plan:'',notice:null});
  const connected=await call('/api/onboarding/claude');
  assert.equal(connected.status,200);
  assert.deepEqual(connected.data.claude,{connected:true,version:'2.1.300',accountLabel:'writer@example.com',plan:'Claude Pro',notice:null});
  assert.equal(connected.data.model.verified,true);assert.equal(connected.data.model.authMode,'claude-plan');
  assert.equal(fake.calls().length,0,'connecting sends no prompt');
  assert.equal(store.readState().modelSettings.claudePlan,true);
  await call('/api/onboarding/paste',{authorship:'own',text:'Thanks for explaining the tradeoffs. The context helps me decide.'});
  await call('/api/onboarding/start');
  addPersonality(store);
  const routes=await call('/api/workspace/model',{tasks:{drafting:{provider:'claude-plan',modelId:'sonnet',effort:'medium'},critique:{provider:'claude-plan',modelId:'haiku',effort:'low'},analysis:null}});
  assert.equal(routes.status,200);assert.equal(routes.data.model.tasks.critique.model,'haiku');
  const preview=await call('/api/workspace/draft/preview',request);
  assert.deepEqual(preview.data.routes.critique,{provider:'claude-plan',model:'haiku',effort:'low',inherited:false});
  const draft=await call('/api/workspace/draft',request);
  assert.equal(draft.status,200,JSON.stringify(draft.data));
  assert.equal(draft.data.draft,'Thanks, I will keep the tradeoffs in the outline.');
  assert.deepEqual(draft.data.review.styleIssues,['Slightly formal.']);
  assert.equal(draft.data.provider,'claude-plan');assert.equal(draft.data.model,'sonnet');assert.deepEqual(draft.data.critique,{provider:'claude-plan',model:'haiku',effort:'low'});
  const calls=fake.calls();
  assert.deepEqual(calls.map(c=>[c.model,c.effort]),[['sonnet','medium'],['sonnet','medium'],['haiku','low']]);
  assert.ok(calls[0].system.startsWith(PLAN_SYSTEM)&&calls[1].system.startsWith(DRAFT_SYSTEM)&&calls[2].system.startsWith(REVIEW_SYSTEM));
  for(const c of calls) {
    assert.ok(c.stdin.includes('Please keep the tradeoffs'),'content arrives on stdin');
    assert.ok(!c.args.some(arg=>arg.includes('tradeoffs')),'content never appears in arguments');
    assert.ok(!c.envKeys.includes('ANTHROPIC_API_KEY')&&!c.envKeys.includes('CLAUDE_CODE_SIMPLE'));
    assert.equal(fs.existsSync(c.cwd),false);
  }
  fake.scenario({run:'rate_limit'});
  const limited=await call('/api/workspace/draft',request);
  assert.equal(limited.status,400);assert.match(limited.data.error,/Claude plan usage limit reached/);
  const off=await call('/api/onboarding/claude',{},'DELETE');
  assert.equal(off.data.model.verified,false);assert.equal(store.readState().modelSettings.claudePlan,false);
});

test('connection errors say how to install or sign in to Claude Code',{skip:process.platform==='win32'},async t=>{
  const fake=fakeClaude(t);
  fake.scenario({auth:'signed_out'});
  const signedOut=await harness(t,{CLAUDE_CLI_PATH:fake.binary});
  const refused=await signedOut.call('/api/onboarding/claude');
  assert.equal(refused.status,409);assert.match(refused.data.error,/isn’t signed in.*claude auth login/);
  assert.match((await(await fetch(signedOut.base+'/api/onboarding')).json()).claude.notice,/claude auth login/);
  const missing=await harness(t,{CLAUDE_CLI_PATH:path.join(os.tmpdir(),'no-such-claude-binary'),PATH:'',HOME:tempDir(t,'larp-empty-home-')});
  const absent=await missing.call('/api/onboarding/claude');
  assert.equal(absent.status,409);assert.match(absent.data.error,/isn’t installed/);
});

test('a hung CLI is stopped at the timeout and its result discarded',{skip:process.platform==='win32'},async t=>{
  const fake=fakeClaude(t);
  fake.scenario({run:'slow'});
  const credentials={provider:'claude-plan',authMode:'claude-plan',model:'haiku',run:options=>runClaudePlan({...options,binary:fake.binary,env:{HOME:os.tmpdir()}})};
  const started=Date.now();
  await assert.rejects(completeJSON('claude-plan','Review.',{draft:'x'},{credentials,timeoutMs:1500}),/timed out/);
  assert.ok(Date.now()-started<10000);
  assert.equal(fake.calls().length,1);
});

test('workspace sends critique and analysis to Claude while ChatGPT or an API key drafts',async t=>{
  const store=new Store(tempDir(t,'larp-claude-routes-'));
  const session=new ModelSession({verifier:async({provider})=>({provider,model:'gpt-test',verified:true,validation:'models-list',verifiedAt:new Date().toISOString(),availableModelCount:1,availableModels:[{id:'gpt-test'}]})});
  const calls=[];
  const complete=async(provider,system,payload,options)=>{
    calls.push({provider,system,model:options.credentials.model,effort:options.effort});
    if(system===PLAN_SYSTEM)return {incomingRequests:[],points:[{id:'p1',text:payload.intent}],missing:[]};
    if(system===DRAFT_SYSTEM)return {draft:'Thanks, I will keep the tradeoffs.'};
    if(system===REVIEW_SYSTEM)return {contentIssues:[],styleIssues:[],missingPointIds:[],unsupportedClaims:[]};
    return {observations:[]};
  };
  const server=createApp({store,env:{},modelSession:session,complete});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`;
  const {csrfToken}=await(await fetch(base+'/api/onboarding')).json();
  const call=async(route,input={})=>{const response=await fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json','X-Local-Token':csrfToken},body:JSON.stringify(input)});return {status:response.status,data:await response.json()};};
  await call('/api/onboarding/model',{provider:'openai',apiKey:'synthetic-key'});
  session.connectClaude({models:CLAUDE_PLAN_MODELS,run:async()=>'{}'});
  await call('/api/onboarding/paste',{authorship:'own',text:'Thanks for explaining the tradeoffs. The context helps me decide.'});
  await call('/api/onboarding/start');
  addPersonality(store);
  const saved=await call('/api/workspace/model',{tasks:{critique:{provider:'claude-plan',modelId:'opus',effort:'high'},analysis:{provider:'claude-plan',modelId:'haiku'}}});
  assert.equal(saved.status,200);
  assert.deepEqual(store.readState().modelSettings.routes.critique,{provider:'claude-plan',model:'opus',effort:'high'});
  const draft=await call('/api/workspace/draft',request);
  assert.equal(draft.status,200);
  assert.deepEqual(calls.map(c=>[c.provider,c.model,c.effort]),[['openai','gpt-test','default'],['openai','gpt-test','default'],['claude-plan','opus','high']]);
  const job=await call('/api/workspace/personalities',{provider:'claude-plan',modelId:'opus',effort:'max'});
  assert.equal(job.status,200);assert.equal(job.data.job.provider,'claude-plan');assert.equal(job.data.job.modelId,'opus');
  session.disconnectClaude();
  const fallback=await call('/api/workspace/draft',request);
  assert.equal(fallback.status,200,'removed Claude routes fall back to drafting only after an explicit disconnect');
  assert.equal(calls.at(-1).provider,'openai');
  session.useRouteStorage({critique:{provider:'claude-plan',model:'opus',effort:'high'}});
  const unavailable=await call('/api/workspace/draft',request);
  assert.equal(unavailable.status,409);assert.match(unavailable.data.error,/chosen for critique \(opus\) isn’t connected/);
  const step=await call(`/api/workspace/personalities/${encodeURIComponent(job.data.job.id)}`,{action:'step'});
  assert.equal(step.data.job.status,'conflict','a Claude baseline never continues on another provider');
  assert.equal(calls.filter(c=>c.provider==='openai'&&c.system!==PLAN_SYSTEM&&c.system!==DRAFT_SYSTEM&&c.system!==REVIEW_SYSTEM).length,0);
});
