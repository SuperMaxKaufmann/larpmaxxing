import fs from 'node:fs';
import path from 'node:path';
import {randomBytes, randomUUID, createHash, timingSafeEqual} from 'node:crypto';
import {createLocalJWKSet, jwtVerify} from 'jose';

const ISSUER = 'https://auth.openai.com';
const RESOURCE = 'https://api.openai.com/v1';
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const terminalRefresh = new Set(['invalid_grant','invalid_refresh_token','token_expired','refresh_token_expired','refresh_token_invalidated','refresh_token_reused']);
const secret = value => typeof value === 'string' && value.length > 0 && value.length <= 32768 && !/\s/.test(value);
const clientId = value => typeof value === 'string' && /^oaiapp_[a-zA-Z0-9_-]{1,200}$/.test(value);
const fail = message => Object.assign(new Error(message), {status:400});
const equal = (a,b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a),Buffer.from(b));

// Only this app's own OAuth registration is read. Never read another app's
// credentials, browser cookies, Codex auth files, or Claude session tokens.
export class ChatGPTAccess {
  constructor(dir, session, {fetchImpl=fetch, now=Date.now}={}) {
    this.file=path.join(dir,'chatgpt-auth.json'); this.session=session; this.fetch=fetchImpl; this.now=now;
    this.pending=null; this.refreshes=new Map(); this.generation=0; this.loginSequence=0; this.restored=false;
    this.state={hostId:`urn:uuid:${randomUUID()}`,activeId:null,profiles:[]};
    if(fs.existsSync(this.file)) {
      try {
        const stat=fs.lstatSync(this.file);
        if(!stat.isFile()||stat.isSymbolicLink()||stat.size>2_000_000)throw Error();
        const saved=JSON.parse(fs.readFileSync(this.file,'utf8'));
        if(!/^urn:uuid:[a-f0-9-]{36}$/.test(saved.hostId)||!Array.isArray(saved.profiles)||saved.profiles.length>50)throw Error();
        if(saved.profiles.some(p=>!clientId(p.clientId)||typeof p.id!=='string'||!Array.isArray(p.scopes)))throw Error();
        this.state=saved;
        if(process.platform!=='win32')fs.chmodSync(this.file,0o600);
      } catch { throw fail('The saved ChatGPT connection could not be read. Restore its private credential file before reconnecting.'); }
    }
  }
  save() {
    const temp=`${this.file}.${randomUUID()}.tmp`;
    try { fs.writeFileSync(temp,JSON.stringify(this.state),{mode:0o600,flag:'wx'}); fs.renameSync(temp,this.file); }
    finally { if(fs.existsSync(temp))fs.unlinkSync(temp); }
  }
  status() {
    const active=this.session.status.authMode==='chatgpt'?this.state.profiles.find(p=>p.id===this.state.activeId):null;
    return {accounts:this.state.profiles.map(p=>({id:p.id,label:p.email||'ChatGPT account',registration:p.id.slice(0,8),connected:!!p.accessToken,planEnabled:p.scopes.includes('chatgpt.tokens.use.direct')})),activeId:active?.id||null,welcomeAccountId:active&&!active.welcomed?active.id:null,notice:this.notice||null};
  }
  acknowledge(id) {const profile=this.state.profiles.find(p=>p.id===id);if(profile){profile.welcomed=true;this.save();}}
  async request(url, options={}) {
    try { return await this.fetch(url,{...options,redirect:'error',signal:AbortSignal.timeout(20000)}); }
    catch { throw fail('Could not reach ChatGPT sign-in. Your saved connection is unchanged. Try again when connected.'); }
  }
  async json(response) { try {const value=await response.json();if(!value||typeof value!=='object')throw Error();return value;}catch {throw fail('ChatGPT returned an invalid sign-in response. Please try again.');} }
  async discovery() {
    if(this.metadata)return this.metadata;
    const response=await this.request(`${ISSUER}/.well-known/openid-configuration`);
    if(!response.ok)throw fail('ChatGPT sign-in is temporarily unavailable.');
    const value=await this.json(response);
    // Discovery cannot redirect tokens to another host, including through HTTP redirects.
    for(const key of ['authorization_endpoint','token_endpoint','jwks_uri','revocation_endpoint']) {
      let url;try {url=new URL(value[key]);}catch {throw fail('ChatGPT sign-in metadata is invalid.');}
      if(url.origin!==ISSUER||url.username||url.password||url.hash)throw fail('ChatGPT sign-in metadata is invalid.');
    }
    if(value.issuer!==ISSUER)throw fail('ChatGPT sign-in issuer is invalid.');
    this.metadata=value;return value;
  }
  async identity(token, id, nonce, subject) {
    try {
      const meta=await this.discovery();
      const response=await this.request(meta.jwks_uri);
      if(!response.ok)throw Error();
      const jwks=await this.json(response);
      const {payload}=await jwtVerify(token,createLocalJWKSet(jwks),{issuer:ISSUER,audience:id,algorithms:['RS256'],requiredClaims:['exp','iat','sub'],currentDate:new Date(this.now())});
      if(typeof payload.sub!=='string'||!payload.sub||(nonce&&!equal(payload.nonce,nonce))||(subject&&payload.sub!==subject))throw Error();
      if(Array.isArray(payload.aud)&&payload.aud.length>1&&payload.azp!==id)throw Error();
      return {subject:payload.sub,email:typeof payload.email==='string'?payload.email.slice(0,254):''};
    } catch {throw fail('ChatGPT identity verification failed. No connection was replaced. Start sign-in again.');}
  }
  async begin(origin, id) {
    const sequence=++this.loginSequence;
    if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin))throw fail('ChatGPT sign-in requires this app’s 127.0.0.1 address.');
    const profile=id?this.state.profiles.find(p=>p.id===id):null;
    if(id&&!profile)throw fail('Choose a saved ChatGPT account.');
    if(this.state.profiles.length>=50&&!profile)throw fail('Too many saved account registrations. Reuse an existing account.');
    const meta=await this.discovery();
    this.save(); // The host identity survives restarts and failed attempts.
    if(sequence!==this.loginSequence)throw fail('This sign-in was replaced by a newer attempt.');
    const pending={id:profile?.id,state:randomBytes(32).toString('base64url'),nonce:randomBytes(32).toString('base64url'),verifier:randomBytes(32).toString('base64url'),clientId:profile?.clientId||(!id?this.retryClientId:undefined),redirectURI:`${origin}/oauth/callback/chatgpt`,expiresAt:this.now()+600000,generation:this.generation,sequence};
    this.pending=pending;
    const url=new URL(meta.authorization_endpoint);
    const values={client_id:pending.clientId||'dynamic_agent_client',ext_agent_host_id:this.state.hostId,response_type:'code',redirect_uri:pending.redirectURI,scope:SCOPES,resource:RESOURCE,state:pending.state,nonce:pending.nonce,code_challenge_method:'S256',code_challenge:createHash('sha256').update(pending.verifier).digest('base64url')};
    if(!pending.clientId)values.agent_name_hint='Larpmaxxing';
    if(profile&&!profile.scopes.includes('chatgpt.tokens.use.direct'))values.prompt='consent';
    // Omit optional login/token hints: no private identity token goes to the UI.
    for(const [key,value]of Object.entries(values))url.searchParams.set(key,value);
    return {url:url.href};
  }
  tokens(data, previous={}) {
    if(!secret(data.access_token)||String(data.token_type).toLowerCase()!=='bearer'||!Number.isFinite(data.expires_in)||data.expires_in<=0)throw fail('ChatGPT returned incomplete credentials. Start sign-in again.');
    if(data.refresh_token!==undefined&&!secret(data.refresh_token))throw fail('ChatGPT returned incomplete credentials.');
    const scopes=data.scope===undefined?previous.scopes:typeof data.scope==='string'?data.scope.split(/\s+/).filter(Boolean):null;
    if(!Array.isArray(scopes))throw fail('ChatGPT did not confirm the granted permissions.');
    return {accessToken:data.access_token,refreshToken:data.refresh_token||previous.refreshToken,idToken:data.id_token||previous.idToken,scopes,expiresAt:this.now()+data.expires_in*1000};
  }
  async finish(params) {
    const pending=this.pending;
    if(!pending||pending.expiresAt<this.now()||!equal(params.get('state'),pending.state)||pending.generation!==this.generation)throw fail('ChatGPT sign-in expired or did not match. Start sign-in again.');
    this.pending=null; // Consume valid state before any network request.
    if(params.has('error'))throw fail('ChatGPT authorization was declined or unavailable. Your existing connection is unchanged.');
    const returned=params.get('client_id');
    if(pending.clientId&&returned&&returned!==pending.clientId)throw fail('ChatGPT returned a different account registration. Start sign-in again.');
    const issued=pending.clientId||returned, code=params.get('code');
    if(!clientId(issued)||!secret(code))throw fail('ChatGPT registration was incomplete. Start sign-in again.');
    if(!pending.clientId)this.retryClientId=issued;
    const meta=await this.discovery();
    const response=await this.request(meta.token_endpoint,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:issued,code,code_verifier:pending.verifier,redirect_uri:pending.redirectURI,resource:RESOURCE}).toString()});
    const data=await this.json(response);
    if(!response.ok)throw fail('ChatGPT could not exchange this sign-in code. Start sign-in again.');
    const previous=this.state.profiles.find(p=>p.id===pending.id);
    const identity=await this.identity(data.id_token,issued,pending.nonce,previous?.subject);
    const tokens=this.tokens(data);
    if(pending.generation!==this.generation||pending.sequence!==this.loginSequence)throw fail('This sign-in was cancelled or replaced.');
    const profile={...previous,id:previous?.id||randomUUID(),clientId:issued,...identity,...tokens};
    this.state.profiles=this.state.profiles.filter(p=>p.id!==profile.id);this.state.profiles.push(profile);this.save();
    this.retryClientId=null;
    if(!tokens.scopes.includes('chatgpt.tokens.use.direct'))throw fail('You signed in, but ChatGPT plan usage was not enabled. Continue with this saved account and allow plan usage.');
    await this.activate(profile.id);return this.status();
  }
  async accessToken(id) {
    let profile=this.state.profiles.find(p=>p.id===id);
    if(!profile?.accessToken||!profile.scopes.includes('chatgpt.tokens.use.direct'))throw fail('Sign in to ChatGPT and enable plan usage to continue.');
    if(profile.expiresAt>this.now()+60000)return profile.accessToken;
    if(this.refreshes.has(id))return this.refreshes.get(id);
    const generation=this.generation;
    const promise=(async()=>{
      if(!profile.refreshToken)throw fail('Your ChatGPT connection needs sign-in again.');
      const meta=await this.discovery();
      const response=await this.request(meta.token_endpoint,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',client_id:profile.clientId,refresh_token:profile.refreshToken,resource:RESOURCE}).toString()});
      const data=await this.json(response);
      if(!response.ok) {
        if(terminalRefresh.has(data.error)) {this.clearTokens(profile);this.save();if(this.state.activeId===id&&this.session.status.authMode==='chatgpt')this.session.clear();}
        throw fail(terminalRefresh.has(data.error)?'Your ChatGPT connection expired or was revoked. Continue with ChatGPT to reconnect.':'ChatGPT could not renew the connection. Try again later; your saved credentials were retained.');
      }
      if(data.id_token)await this.identity(data.id_token,profile.clientId,undefined,profile.subject);
      const tokens=this.tokens(data,profile);
      if(generation!==this.generation||this.state.profiles.find(p=>p.id===id)!==profile)throw fail('ChatGPT connection changed during renewal.');
      Object.assign(profile,tokens);this.save();
      if(!profile.scopes.includes('chatgpt.tokens.use.direct'))throw fail('ChatGPT plan usage is no longer enabled for this connection.');
      return profile.accessToken;
    })();
    this.refreshes.set(id,promise);try{return await promise;}finally{this.refreshes.delete(id);}
  }
  async activate(id) {
    const generation=this.generation, revision=this.session.revision;
    const profile=this.state.profiles.find(p=>p.id===id);
    const token=await this.accessToken(id);
    const response=await this.request(`${RESOURCE}/models`,{headers:{Authorization:`Bearer ${token}`}});
    if(!response.ok)throw fail('ChatGPT could not list models for this account. Check plan eligibility and app access in ChatGPT settings. Your connection is saved.');
    const data=await this.json(response);
    if(!Array.isArray(data.models)||data.models.length>20000)throw fail('ChatGPT returned an invalid model catalog.');
    const models=[...new Map(data.models.filter(m=>m.visibility==='list'&&typeof m.slug==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(m.slug)).map(m=>[m.slug,{id:m.slug,label:typeof m.display_name==='string'?m.display_name.slice(0,150):m.slug}])).values()];
    if(!models.length)throw fail('No models are available for this ChatGPT connection. Check app access in ChatGPT settings.');
    if(generation!==this.generation||revision!==this.session.revision)throw fail('Model access changed during connection. Please try again.');
    this.session.connectChatGPT({models,model:profile.model,effort:profile.effort,accountLabel:profile.email||'ChatGPT account',getAccessToken:()=>this.accessToken(id),saveSelection:(model,effort)=>{profile.model=model;profile.effort=effort;this.save();}});
    this.state.activeId=id;this.restored=true;this.notice=null;this.save();
  }
  async restore() {
    if(this.restoring)return this.restoring;
    if(this.restored||this.session.status.verified)return;
    this.restored=true;
    const id=this.state.activeId;if(!id)return;
    this.restoring=this.activate(id).catch(error=>{this.notice=error.message;}).finally(()=>{this.restoring=null;});
    await this.restoring;
  }
  pause() {this.generation++;this.pending=null;this.restored=true;this.state.activeId=null;this.save();}
  clearTokens(profile) {for(const key of ['accessToken','refreshToken','idToken','expiresAt'])delete profile[key];}
  async signOut(id=this.state.activeId) {
    const profile=this.state.profiles.find(p=>p.id===id);if(!profile)throw fail('Choose a saved ChatGPT account.');
    this.generation++;this.pending=null;this.restored=true;
    if(this.state.activeId===id) {this.state.activeId=null;if(this.session.status.authMode==='chatgpt')this.session.clear();}
    const token=profile.refreshToken;this.clearTokens(profile);this.save();
    let revoked=false;
    if(token)try {const meta=await this.discovery();const response=await this.request(meta.revocation_endpoint,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token,token_type_hint:'refresh_token',client_id:profile.clientId}).toString()});revoked=response.status===200;}catch{}
    return {notice:revoked?'Signed out of ChatGPT. Your imported sources remain saved.':'Signed out locally. Remote revocation was not confirmed; disconnect Larpmaxxing in ChatGPT Settings → Usage.'};
  }
}
