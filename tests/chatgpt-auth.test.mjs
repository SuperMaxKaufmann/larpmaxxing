import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {generateKeyPair,exportJWK,SignJWT} from 'jose';
import {ChatGPTAccess} from '../server/chatgpt-auth.mjs';
import {ModelSession} from '../server/model-access.mjs';
import {createApp} from '../server/index.mjs';
import {Store} from '../server/storage.mjs';
import {completeJSON,modelErrorDetails} from '../server/providers.mjs';

const issuer='https://auth.openai.com',resource='https://api.openai.com/v1';
const metadata={issuer,authorization_endpoint:issuer+'/api/accounts/authorize',token_endpoint:issuer+'/api/accounts/oauth/token',jwks_uri:issuer+'/.well-known/jwks.json',revocation_endpoint:issuer+'/api/accounts/oauth/revoke'};
const scopes='openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const keys=await generateKeyPair('RS256');
const publicKey=await exportJWK(keys.publicKey);publicKey.kid='synthetic-test-key';
async function fixture(t) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'larp-chatgpt-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const session=new ModelSession(),requests=[];
 let now=Date.now();
 const config={scope:scopes,claims:{},expiry:3600,refreshError:null,token:'synthetic-access-token',refresh:'synthetic-refresh-token'};
 let auth;
 const fetchImpl=async(url,options={})=>{
  requests.push({url,options});assert.equal(options.redirect,'error');
  if(url.endsWith('openid-configuration'))return Response.json(metadata);
  if(url===metadata.jwks_uri)return Response.json({keys:[publicKey]});
  if(url===metadata.token_endpoint){
   const form=new URLSearchParams(options.body);
   if(form.get('grant_type')==='refresh_token') {
    if(config.refreshError)return Response.json({error:config.refreshError},{status:400});
    await new Promise(r=>setTimeout(r,5));
    return Response.json({access_token:'synthetic-renewed-token',refresh_token:'synthetic-rotated-token',token_type:'Bearer',expires_in:3600});
   }
   const nonce=new URL(auth.lastURL).searchParams.get('nonce');
   const idToken=await new SignJWT({nonce,email:'synthetic@example.invalid',...config.claims}).setProtectedHeader({alg:'RS256',kid:'synthetic-test-key'}).setIssuer(config.issuer||issuer).setSubject(config.subject||'synthetic-user').setAudience(config.audience||form.get('client_id')).setIssuedAt(Math.floor(now/1000)).setExpirationTime(Math.floor(now/1000)+config.expiry).sign(keys.privateKey);
   return Response.json({access_token:config.token,refresh_token:config.refresh,id_token:idToken,scope:config.scope,token_type:'Bearer',expires_in:config.expiry});
  }
  if(url===resource+'/models')return Response.json({models:[{slug:'gpt-6-astra',display_name:'Astra',visibility:'list'},{slug:'gpt-5.4-mini',display_name:'Mini',visibility:'list'},{slug:'hidden-model',visibility:'hide'}]});
  if(url===metadata.revocation_endpoint)return new Response(null,{status:config.revokeFailure?503:200});
  throw Error('Unexpected endpoint');
 };
 auth=new ChatGPTAccess(dir,session,{fetchImpl,now:()=>now});
 const begin=async(id)=>{const result=await auth.begin('http://127.0.0.1:3210',id);auth.lastURL=result.url;return new URL(result.url);};
 const finish=async(url,client='oaiapp_synthetic')=>auth.finish(new URLSearchParams({state:url.searchParams.get('state'),code:'synthetic-code',client_id:client}));
 return {dir,session,auth,requests,config,fetchImpl,begin,finish,advance:ms=>{now+=ms;}};
}

test('ChatGPT sign-in uses PKCE, persists only private server credentials, and survives restart',async t=>{
 const f=await fixture(t),url=await f.begin();
 assert.equal(url.origin,issuer);assert.equal(url.searchParams.get('client_id'),'dynamic_agent_client');assert.equal(url.searchParams.get('agent_name_hint'),'Larpmaxxing');assert.equal(url.searchParams.get('scope'),scopes);assert.equal(url.searchParams.get('code_challenge_method'),'S256');assert.ok(!url.searchParams.has('client_secret'));assert.ok(!url.searchParams.has('id_token_hint'));
 const host=url.searchParams.get('ext_agent_host_id');
 await f.finish(url);
 assert.equal(f.session.status.authMode,'chatgpt');assert.equal(f.session.status.validation,'chatgpt-models-list');assert.equal(f.session.status.availableModels.length,2);assert.equal(f.session.status.availableModels[0].label,'Astra');
 const publicData=JSON.stringify({model:f.session.status,chatgpt:f.auth.status()});assert.ok(!publicData.includes('synthetic-access'));assert.ok(!publicData.includes('synthetic-refresh'));assert.ok(!publicData.includes('id_token'));
 assert.equal(fs.statSync(f.auth.file).mode&0o777,0o600);
 f.session.selectModel('gpt-5.4-mini','high');
 const nextSession=new ModelSession();const restored=new ChatGPTAccess(f.dir,nextSession,{fetchImpl:f.fetchImpl});await restored.restore();
 assert.equal(nextSession.status.model,'gpt-5.4-mini');assert.equal(nextSession.status.effort,'high');assert.equal(restored.state.hostId,host);
 const repeat=new URL((await restored.begin('http://127.0.0.1:4444',restored.status().activeId)).url);assert.equal(repeat.searchParams.get('client_id'),'oaiapp_synthetic');assert.equal(repeat.searchParams.get('agent_name_hint'),null);assert.equal(repeat.searchParams.get('ext_agent_host_id'),host);
 assert.ok(!f.requests.some(r=>r.url.endsWith('/responses')));
});

test('bad state, replay, expired state, wrong callback registration and denied consent do not connect',async t=>{
 const f=await fixture(t);let url=await f.begin();
 await assert.rejects(f.auth.finish(new URLSearchParams({state:'wrong',code:'x'})),/did not match/);
 await f.finish(url);await assert.rejects(f.finish(url),/did not match/);
 const id=f.auth.status().activeId;url=await f.begin(id);await assert.rejects(f.finish(url,'oaiapp_wrong'),/different account registration/);assert.equal(f.auth.status().activeId,id);
 url=await f.begin();f.advance(600001);await assert.rejects(f.finish(url),/expired/);
 url=await f.begin();await assert.rejects(f.auth.finish(new URLSearchParams({state:url.searchParams.get('state'),error:'access_denied',error_description:'UNTRUSTED PRIVATE CONTENT'})),/declined/);assert.equal(f.auth.status().activeId,id);
 await assert.rejects(f.auth.begin('http://evil.invalid:3210'),/127.0.0.1/);
});

test('OIDC validates nonce, audience, issuer, expiry and returning account identity',async t=>{
 for(const change of [{claims:{nonce:'wrong'}},{audience:'oaiapp_other'},{issuer:'https://evil.invalid'},{expiry:-1}]) {
  const f=await fixture(t);Object.assign(f.config,change);await assert.rejects(f.finish(await f.begin()),/verification failed/);assert.equal(f.session.status.verified,false);assert.equal(f.auth.state.profiles.length,0);
 }
 const f=await fixture(t);await f.finish(await f.begin());const id=f.auth.status().activeId;f.config.subject='another-user';await assert.rejects(f.finish(await f.begin(id)),/verification failed/);assert.equal(f.auth.state.profiles[0].subject,'synthetic-user');
});

test('identity without plan scope stays saved but does not authorize inference',async t=>{
 const f=await fixture(t);f.config.scope='openid email profile';await assert.rejects(f.finish(await f.begin()),/plan usage was not enabled/);
 assert.equal(f.session.status.verified,false);assert.equal(f.auth.status().accounts.length,1);assert.equal(f.auth.status().accounts[0].planEnabled,false);assert.equal(f.requests.filter(r=>r.url.endsWith('/models')).length,0);
 const retry=await f.begin(f.auth.status().accounts[0].id);assert.equal(retry.searchParams.get('prompt'),'consent');assert.equal(retry.searchParams.get('client_id'),'oaiapp_synthetic');
});

test('refresh is serialized, rotates tokens together, and does not silently fall back to API billing',async t=>{
 const f=await fixture(t);await f.finish(await f.begin());const id=f.auth.status().activeId;f.advance(3600000);
 const result=await Promise.all([f.auth.accessToken(id),f.auth.accessToken(id),f.auth.accessToken(id)]);assert.deepEqual(result,Array(3).fill('synthetic-renewed-token'));
 assert.equal(f.requests.filter(r=>r.options.body?.includes('grant_type=refresh_token')).length,1);
 const stored=JSON.parse(fs.readFileSync(f.auth.file));assert.equal(stored.profiles[0].refreshToken,'synthetic-rotated-token');assert.equal(stored.profiles[0].accessToken,'synthetic-renewed-token');assert.ok(stored.profiles[0].scopes.includes('chatgpt.tokens.use.direct'));
 f.advance(3600000);f.config.refreshError='invalid_grant';await assert.rejects(f.auth.accessToken(id),/expired or was revoked/);assert.equal(f.session.status.verified,false);assert.equal(f.auth.state.profiles[0].accessToken,undefined);assert.equal(f.auth.state.profiles[0].clientId,'oaiapp_synthetic');
});

test('temporary refresh failure retains credentials and sign-out revokes and clears tokens',async t=>{
 const f=await fixture(t);await f.finish(await f.begin());const id=f.auth.status().activeId;f.advance(3600000);f.config.refreshError='temporarily_unavailable';await assert.rejects(f.auth.accessToken(id),/retained/);assert.ok(f.auth.state.profiles[0].refreshToken);
 f.config.revokeFailure=true;const result=await f.auth.signOut();assert.match(result.notice,/not confirmed/);assert.equal(f.session.status.verified,false);assert.equal(f.auth.state.profiles[0].idToken,undefined);assert.ok(!fs.readFileSync(f.auth.file,'utf8').includes('synthetic-refresh-token'));assert.equal(f.auth.state.profiles[0].clientId,'oaiapp_synthetic');
});

test('registrations with the same email remain distinct and selection changes use matching credentials',async t=>{
 const f=await fixture(t);await f.finish(await f.begin());const first=f.auth.status().activeId;f.config.subject='user-two';f.config.token='synthetic-token-two';await f.finish(await f.begin(),'oaiapp_second');
 assert.equal(f.auth.status().accounts.length,2);assert.notEqual(first,f.auth.status().activeId);await f.auth.activate(first);assert.equal(await f.session.getCredentials().getAccessToken(),'synthetic-access-token');
});

test('untrusted discovery endpoints cannot receive credentials',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'larp-chatgpt-invalid-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));let calls=0;
 const auth=new ChatGPTAccess(dir,new ModelSession(),{fetchImpl:async()=>{calls++;return Response.json({...metadata,token_endpoint:'https://evil.invalid/token'});}});
 await assert.rejects(auth.begin('http://127.0.0.1:3210'),/metadata is invalid/);assert.equal(calls,1);
});

function stream(events) {return new Response(events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}});}
const output={output:[{content:[{type:'output_text',text:'{"draft":"Synthetic hello"}'}]}]};
const credentials={provider:'openai',model:'gpt-6-astra',authMode:'chatgpt',getAccessToken:async()=>'synthetic-subscription-token'};
test('subscription requests use the public streaming endpoint without unsupported fields or tools',async()=>{
 let call;
 const result=await completeJSON('openai','Application rules',{intent:'Synthetic fixture'},{credentials,effort:'high',fetchImpl:async(url,options)=>{call={url,options};return stream([{type:'response.output_text.delta',delta:'ignored partial'},{type:'response.completed',response:output}]);}});
 assert.equal(result.draft,'Synthetic hello');assert.equal(call.url,resource+'/responses');assert.equal(call.options.headers.Authorization,'Bearer synthetic-subscription-token');
 const body=JSON.parse(call.options.body);assert.equal(body.stream,true);assert.equal(body.store,false);assert.equal(body.max_output_tokens,undefined);assert.equal(body.reasoning.effort,'high');assert.equal(body.tools,undefined);assert.equal(body.input[0].role,'developer');assert.equal(body.input[1].role,'user');
});

test('partial streams, failed terminal events and usage limits never become successful drafts',async()=>{
 for(const events of [[{type:'response.output_text.delta',delta:'{"draft":"partial"}'}],[{type:'response.incomplete',response:{incomplete_details:{reason:'max_output_tokens'}}}],[{type:'response.failed',response:{error:{code:'subscription_sharing_usage_limit_exceeded',message:'DO NOT LEAK private provider text'}}}]]) {
  await assert.rejects(completeJSON('openai','rules',{}, {credentials,fetchImpl:async()=>stream(events)}),error=>{assert.ok(!error.message.includes('DO NOT LEAK'));if(events[0].type==='response.failed'){assert.match(error.message,/ChatGPT plan or app usage/);assert.equal(modelErrorDetails(error).providerCode,'subscription_sharing_usage_limit_exceeded');}return true;});
 }
 let calls=0;await assert.rejects(completeJSON('openai','rules',{}, {credentials:{...credentials,getAccessToken:async()=>{throw Error('PRIVATE TOKEN');}},env:{OPENAI_API_KEY:'never-use-this'},fetchImpl:async()=>{calls++;}}),/ChatGPT connection/);assert.equal(calls,0);
});

test('HTTP routes enforce CSRF, expose no tokens and preserve sources through sign-in',async t=>{
 const f=await fixture(t),store=new Store(f.dir);const server=createApp({store,modelSession:f.session,chatgptAccess:f.auth});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));const base='http://127.0.0.1:'+server.address().port;
 const state=await(await fetch(base+'/api/onboarding')).json();assert.ok(state.chatgpt);assert.equal(state.model.verified,false);
 let response=await fetch(base+'/api/onboarding/chatgpt',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(response.status,403);
 response=await fetch(base+'/api/onboarding/chatgpt',{method:'POST',headers:{'Content-Type':'application/json','X-Local-Token':state.csrfToken},body:'{}'});assert.equal(response.status,200);const result=await response.json();f.auth.lastURL=result.url;
 const signIn=new URL(result.url);response=await fetch(base+'/oauth/callback/chatgpt?'+new URLSearchParams({state:signIn.searchParams.get('state'),client_id:'oaiapp_synthetic',code:'synthetic-code'}),{redirect:'manual',headers:{'sec-fetch-site':'cross-site'}});assert.equal(response.status,303);assert.equal(response.headers.get('Location'),'/?connected=chatgpt');
 const connected=await(await fetch(base+'/api/onboarding')).json();assert.equal(connected.model.authMode,'chatgpt');assert.ok(!JSON.stringify(connected).includes('synthetic-access-token'));assert.ok(connected.chatgpt.welcomeAccountId);
 await fetch(base+'/api/onboarding/chatgpt/ack',{method:'POST',headers:{'Content-Type':'application/json','X-Local-Token':state.csrfToken},body:JSON.stringify({accountId:connected.chatgpt.activeId})});assert.equal(f.auth.status().welcomeAccountId,null);
 assert.equal((await fetch(base+'/chatgpt-auth.json')).status,404);
});
