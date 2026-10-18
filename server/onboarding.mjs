import {createHash,randomBytes} from 'node:crypto';
import {ModelSession} from './model-access.mjs';
import {callSourceTool} from './source-mcp.mjs';
import {createImport,stepImport,deleteSource} from './workflow.mjs';
import {separateQuotedContent,discover} from './evidence.mjs';

const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const digest=text=>createHash('sha256').update(text).digest('hex').slice(0,24);
const emailOf=text=>(String(text).match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]||'').toLowerCase();
const secret=value=>typeof value==='string'&&value.trim().length>0&&value.length<=8192&&!/[\r\n\x00]/.test(value);
const summary=source=>({id:source.id,title:source.title,source:source.source,audience:source.audience||'',messageCount:source.messages.length,ownMessageCount:source.messages.filter(m=>m.role==='user').length});
// The user's own note on who a batch of messages is with, e.g. "my boss" or "close friends".
function audienceNote(value){if(value==null||value==='')return '';if(typeof value!=='string'||value.length>300||/[\r\n\x00]/.test(value))throw fail('Describe who these messages are with in one line (up to 300 characters).');return value.trim();}
function dateRange(input) {
  const dates={};
  for(const key of ['after','before'])if(input[key]) {
    const value=input[key];
    if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value)throw fail('Select a valid calendar date.');
    dates[key]=value;
  }
  if(dates.after&&dates.before&&dates.after>dates.before)throw fail('The end date must be on or after the start date.');
  // A calendar end date includes that entire UTC day; the source APIs use an upper timestamp bound.
  if(dates.before)dates.before=new Date(Date.parse(dates.before)+86400000).toISOString();
  return dates;
}

export function parsePastedEmails({text,authorship,ownEmail}={}) {
  if(typeof text!=='string'||!/[\p{L}\p{N}]/u.test(text))throw fail('Paste at least one email with readable text.');
  if(text.length>200000)throw fail('Paste up to 200,000 characters at a time.');
  if(!['own','thread'].includes(authorship))throw fail('Tell us whether these are your messages or a conversation with other people.');
  const normalized=text.replace(/\r\n?/g,'\n').trim();
  const headers=[...normalized.matchAll(/^(?:From|Von):[\t ]*([^\n]*)/gim)];
  if(authorship==='thread'&&!emailOf(ownEmail))throw fail('Enter your email address so incoming messages stay separate from your writing.');
  if(authorship==='thread'&&!headers.length)throw fail('This conversation needs From: or Von: headers to identify authors. Alternatively paste only your outgoing message.');
  if(authorship==='own'&&headers.length>1)throw fail('This looks like a conversation with several senders. Choose “An email thread” and enter your email address.');
  const warnings=[];
  const blocks=authorship==='thread'?headers.map((header,i)=>({body:normalized.slice(header.index+header[0].length,headers[i+1]?.index??normalized.length),author:header[1]})):[{body:normalized,author:'User-supplied outgoing message'}];
  const messages=blocks.map((block,i)=>{
    const body=block.body.replace(/^(?:From|Von|To|An|Cc|Bcc|Date|Datum|Sent|Gesendet|Subject|Betreff):[^\n]*\n?/gim,'').trim();
    const cleaned=separateQuotedContent(body);
    const own=authorship==='own'||emailOf(block.author)===emailOf(ownEmail);
    return {id:`paste-message-${digest(`${i}:${block.author}:${body}`)}`,role:own?'user':'incoming',kind:own?'user-written':'incoming',text:cleaned.text,rawText:body,author:block.author,date:null,metadata:{attribution:authorship==='own'?'user-asserted-outgoing':own?'user-specified-email-match':'other-sender',excludedFragments:cleaned.excludedFragments}};
  }).filter(message=>message.text.trim());
  if(!messages.length)throw fail('Only quoted or empty content was found. Paste some authored email text.');
  if(!messages.some(m=>m.role==='user'))warnings.push('No message matched your email address. This source provides context but cannot yet teach your writing style.');
  if(headers.length&&normalized.slice(0,headers[0].index).trim()&&authorship==='thread')warnings.push('Unattributed text before the first From: header was excluded.');
  const title=normalized.match(/^(?:Subject|Betreff):[\t ]*(.+)$/im)?.[1]||`Pasted ${authorship==='own'?'email':'conversation'}`;
  return {conversations:[{id:`paste-${digest(normalized+'|'+authorship+'|'+emailOf(ownEmail))}`,title:title.slice(0,160),source:'pasted-email',messages}],warnings};
}

export class Onboarding {
  constructor(store,{modelSession=new ModelSession(),sourceTool=callSourceTool,env=process.env,fetchImpl=globalThis.fetch}={}) {
    this.store=store;this.modelSession=modelSession;this.sourceTool=sourceTool;this.env=env;this.fetchImpl=fetchImpl;
    this.credentials={gmailToken:'',slackToken:''};this.connected={gmail:false,slack:false};this.generations={gmail:0,slack:0};this.oauth=null;
  }
  requireModel(){if(!this.modelSession.status.verified)throw fail('Connect ChatGPT or a model API key first.',409);}
  getSources(){return this.store.readState().sources.filter(s=>s.onboardingEligible&&s.messages?.some(m=>m.text?.trim()));}
  status(){
    const sources=this.getSources();const previous=this.store.readState().harness;
    const fingerprint=digest(JSON.stringify(sources.map(s=>[s.id,s.messages.map(m=>[m.id,m.text])])));
    const ready=this.modelSession.status.verified&&sources.length>0&&previous?.fingerprint===fingerprint;
    return {model:{...this.modelSession.status,configured:this.modelSession.status.verified,storage:this.modelSession.status.authMode==='chatgpt'?'protected-local-file':this.modelSession.status.authMode==='claude-plan'?'claude-code':'session'},sources:sources.map(summary),connections:{
      gmail:{connected:this.connected.gmail,configured:!!(this.env.GOOGLE_CLIENT_ID||this.env.GMAIL_ACCESS_TOKEN),authMode:this.env.GOOGLE_CLIENT_ID?'oauth':'token',transport:'local-mcp',reason:'Uses your own Google OAuth app or authorized Gmail read-only access token.'},
      slack:{connected:this.connected.slack,configured:!!this.env.SLACK_USER_TOKEN,authMode:'token',transport:'local-mcp',reason:'Use a user OAuth token from your installed Slack app, with im:read and im:history. Only one-to-one conversations are read.'}
    },harness:{status:ready?'ready':'idle',sourceCount:sources.length,conversationCount:sources.length,messageCount:sources.reduce((n,s)=>n+s.messages.length,0),proposalCount:0,discoveryCount:ready?previous.discoveryCount:0},defaults:{openai:'',anthropic:''}};
  }
  async verifyModel(input){for(const provider of ['gmail','slack'])this.disconnect(provider);return {model:await this.modelSession.verify(input)};}
  forgetModel(){this.modelSession.clear();this.oauth=null;for(const provider of ['gmail','slack'])this.disconnect(provider);return {model:this.modelSession.status};}
  async tool(name,args,credentials=this.credentials){return this.sourceTool({credentials:{...credentials},fetchImpl:this.fetchImpl},name,args);}
  ingest(result,{audience=''}={}){
    const before=new Set(this.getSources().map(s=>s.id));
    if(!result.conversations?.length)return {addedCount:0,sources:this.getSources().map(summary),warnings:result.warnings||[],notice:'No messages matched. Try a different date range.'};
    const job=createImport(this.store,{conversations:result.conversations},{source:'auto',title:'Harness source import'});
    while(stepImport(this.store,job.id).status!=='complete'){}
    const ids=new Set(result.conversations.map(c=>c.id.startsWith(`${c.source}:`)?c.id:`${c.source}:${c.id}`));
    this.store.mutate(s=>{for(const source of s.sources)if(ids.has(source.id)){source.onboardingEligible=true;if(audience)source.audience=audience;}delete s.harness;});
    const sources=this.getSources();return {addedCount:sources.filter(s=>!before.has(s.id)).length,sources:sources.map(summary),warnings:result.warnings||[]};
  }
  paste(input){this.requireModel();const audience=audienceNote(input?.audience);return this.ingest(parsePastedEmails(input),{audience});}
  async connect(provider,{token}={}) {
    this.requireModel();if(!['gmail','slack'].includes(provider))throw fail('Unknown source.');
    const sequence=++this.generations[provider];
    this.connected[provider]=false;this.credentials[`${provider}Token`]='';
    const value=token||this.env[provider==='gmail'?'GMAIL_ACCESS_TOKEN':'SLACK_USER_TOKEN'];
    if(!secret(value))throw fail(`Provide an authorized ${provider==='gmail'?'Gmail read-only access':'Slack user OAuth'} token.`);
    const credentials={...this.credentials,[`${provider}Token`]:value.trim()};
    const result=await this.tool(provider==='gmail'?'gmail_status':'slack_list_dms',provider==='gmail'?{}:{maxResults:1,includeNames:false},credentials);
    if(sequence!==this.generations[provider]||!this.modelSession.status.verified)throw fail('Connection was cancelled. Connect again.',409);
    this.credentials[`${provider}Token`]=value.trim();this.connected[provider]=true;
    return {connected:true,provider,warnings:result.warnings||[],connections:this.status().connections};
  }
  disconnect(provider){if(!['gmail','slack'].includes(provider))throw fail('Unknown source.');this.generations[provider]++;this.connected[provider]=false;this.credentials[`${provider}Token`]='';if(provider==='gmail')this.oauth=null;return {connections:this.status().connections};}
  async listDMs(cursor){this.requireModel();if(!this.connected.slack)throw fail('Connect Slack first.');const generation=this.generations.slack;const result=await this.tool('slack_list_dms',{...(cursor?{cursor}:{}),maxResults:20});if(generation!==this.generations.slack||!this.modelSession.status.verified)throw fail('Slack connection changed. Connect again.',409);return {...result,conversations:result.conversations.map(c=>({...c,name:c.name||`1:1 with ${c.userId}`}))};}
  async import(provider,input={}) {
    this.requireModel();if(!this.connected[provider])throw fail(`Connect ${provider} first.`);
    const generation=this.generations[provider];const credentials={...this.credentials};const dates=dateRange(input);let result;
    const unchanged=()=>{if(generation!==this.generations[provider]||!this.modelSession.status.verified)throw fail('Connection changed during import. No new messages were saved. Retry after reconnecting.',409);};
    if(provider==='gmail')result=await this.tool('gmail_import',{...dates,maxResults:30},credentials);
    else if(provider==='slack') {
      if(!Array.isArray(input.conversationIds)||!input.conversationIds.length||input.conversationIds.length>20||input.conversationIds.some(id=>typeof id!=='string'))throw fail('Select between 1 and 20 one-to-one conversations.');
      result={conversations:[],warnings:[]};
      for(const channelId of new Set(input.conversationIds)) {
        unchanged();
        const pulled=await this.tool('slack_import_dm',{channelId,...dates,maxResults:100},credentials);
        unchanged();
        result.conversations.push(...pulled.conversations);result.warnings.push(...(pulled.warnings||[]));
      }
    } else throw fail('Unknown source.');
    unchanged();
    return this.ingest(result);
  }
  removeSource(id){this.requireModel();if(!this.getSources().some(s=>s.id===id))throw fail('Source not found.',404);const result=deleteSource(this.store,id,'delete');this.store.mutate(s=>delete s.harness);return result;}
  start(){
    this.requireModel();const sources=this.getSources();if(!sources.length)throw fail('Add at least one source before starting the harness.',409);
    if(!sources.some(s=>s.messages.some(m=>m.role==='user'&&m.text.trim())))throw fail('The sources contain only incoming text. Add a message you wrote, or correct your email address first.',409);
    const fingerprint=digest(JSON.stringify(sources.map(s=>[s.id,s.messages.map(m=>[m.id,m.text])])));
    const discoveryCount=sources.filter(s=>discover(s).candidate).length;
    this.store.mutate(s=>{s.harness={fingerprint,discoveryCount,startedAt:new Date().toISOString()};});
    return {harness:this.status().harness,notice:'Your sources are prepared locally. Profile learning and the drafting workspace are the next step; no email content has been sent to a model.'};
  }
  beginGoogleOAuth(origin){
    this.requireModel();if(!this.env.GOOGLE_CLIENT_ID)throw fail('Configure a Google Desktop OAuth client with GOOGLE_CLIENT_ID, or connect using an access token.');
    if(!/^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(origin))throw fail('OAuth requires this app’s loopback origin.');
    this.disconnect('gmail');
    const state=randomBytes(32).toString('base64url'),verifier=randomBytes(32).toString('base64url');
    const redirectURI=`${origin}/oauth/callback/gmail`;
    this.oauth={state,verifier,redirectURI,expiresAt:Date.now()+600000,generation:this.generations.gmail};
    const url=new URL('https://accounts.google.com/o/oauth2/v2/auth');
    const values={client_id:this.env.GOOGLE_CLIENT_ID,redirect_uri:redirectURI,response_type:'code',scope:'https://www.googleapis.com/auth/gmail.readonly',state,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',access_type:'online'};
    for(const [key,value]of Object.entries(values))url.searchParams.set(key,value);
    return {url:url.href};
  }
  async finishGoogleOAuth(params){
    const pending=this.oauth;
    if(!pending||pending.expiresAt<Date.now()||params.get('state')!==pending.state||pending.generation!==this.generations.gmail)throw fail('OAuth state is missing, expired, or mismatched. Start the connection again.');
    this.oauth=null;
    this.requireModel();if(params.has('error'))throw fail('Google authorization was declined or unavailable.');
    const code=params.get('code');if(!code||code.length>4096)throw fail('Google returned no authorization code.');
    const form=new URLSearchParams({code,client_id:this.env.GOOGLE_CLIENT_ID,redirect_uri:pending.redirectURI,grant_type:'authorization_code',code_verifier:pending.verifier});
    if(this.env.GOOGLE_CLIENT_SECRET)form.set('client_secret',this.env.GOOGLE_CLIENT_SECRET);
    let data;
    try {const response=await this.fetchImpl('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:form.toString(),redirect:'error',signal:AbortSignal.timeout(30000)});if(!response.ok)throw new Error();data=await response.json();if(!secret(data?.access_token))throw new Error();}
    catch {throw fail('Google authorization could not be completed. Check your Desktop OAuth client configuration and retry.');}
    if(pending.generation!==this.generations.gmail)throw fail('Connection was cancelled. Start again.',409);
    return this.connect('gmail',{token:data.access_token});
  }
}
