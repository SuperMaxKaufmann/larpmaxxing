import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {Store,projectRoot,uid} from './storage.mjs';
import {providerStatus} from './providers.mjs';
import {integrationStatus} from './integrations.mjs';
import {suggestMode,generateDraft} from './drafting.mjs';
import {createImport,stepImport,extractSelected,suggestModes,deleteSource,recordFeedback,jobSummary} from './workflow.mjs';
import {Onboarding} from './onboarding.mjs';
import {Workspace} from './workspace.mjs';
import {ChatGPTAccess} from './chatgpt-auth.mjs';

function json(res,data,status=200) {res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));}
async function body(req) {
  if(!req.headers['content-type']?.startsWith('application/json'))throw Object.assign(new Error('JSON content type required.'),{status:415});
  const chunks=[];let length=0;
  for await(const chunk of req) {length+=chunk.length;if(length>32*1024*1024)throw Object.assign(new Error('Import too large. Extract the archive and use numbered JSON exports or smaller selections (32 MiB per request).'),{status:413});chunks.push(chunk);}
  try {return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}catch {throw new Error('Invalid JSON request.');}
}
function readJSON(relative) {return JSON.parse(fs.readFileSync(path.join(projectRoot,relative),'utf8'));}
function heldoutCases() {const raw=readJSON('fixtures/heldout.json');return Array.isArray(raw)?raw:raw.cases||[];}
export function createApp({store=new Store(),generate=generateDraft,onboarding,modelSession,sourceTool,env,fetchImpl,complete,chatgptAccess}={}) {
  const csrfToken=crypto.randomBytes(32).toString('hex');
  const harness=onboarding||new Onboarding(store,{modelSession,sourceTool,env,fetchImpl});
  const chatgpt=chatgptAccess||new ChatGPTAccess(store.dir,harness.modelSession,{fetchImpl});
  const workspace=new Workspace(store,harness,{generate,complete,fetchImpl});
  const server=http.createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    res.setHeader('Permissions-Policy','camera=(), geolocation=()');
    try {
      const port=server.address()?.port;
      const allowedHosts=new Set([`127.0.0.1:${port}`,`localhost:${port}`]);
      if(!allowedHosts.has(req.headers.host))return json(res,{error:'Only loopback host requests are allowed.'},403);
      const url=new URL(req.url,`http://${req.headers.host}`);
      if(req.method==='GET'&&url.pathname==='/oauth/callback/chatgpt') {
        try {await chatgpt.finish(url.searchParams);res.writeHead(303,{Location:'/?connected=chatgpt','Cache-Control':'no-store'});res.end();}
        catch(error) {chatgpt.notice=error.message;res.writeHead(303,{Location:'/?connection_error=chatgpt','Cache-Control':'no-store'});res.end();}
        return;
      }
      // OAuth callbacks are authenticated by one-use state and PKCE.
      if(req.method==='GET'&&url.pathname==='/oauth/callback/gmail') {
        try {await harness.finishGoogleOAuth(url.searchParams);res.writeHead(303,{Location:'/?connected=gmail','Cache-Control':'no-store'});res.end();}
        catch {res.writeHead(303,{Location:'/?connection_error=gmail','Cache-Control':'no-store'});res.end();}
        return;
      }
      const origin=req.headers.origin;
      // OAuth redirect chains keep Sec-Fetch-Site: cross-site on the final
      // navigation home. These pages contain only the public application shell.
      // Private API reads/writes and embedded or programmatic requests keep the
      // existing origin, fetch-metadata and CSRF checks.
      const publicNavigation=req.method==='GET'&&['/','/index.html','/setup'].includes(url.pathname)
        &&req.headers['sec-fetch-mode']==='navigate'&&req.headers['sec-fetch-dest']==='document';
      if(!publicNavigation&&((origin&&!new Set([`http://127.0.0.1:${port}`,`http://localhost:${port}`]).has(origin)) || req.headers['sec-fetch-site']==='cross-site'))return json(res,{error:'Cross-site requests are not allowed.'},403);
      if(url.pathname.startsWith('/api/')) {
        const method=req.method;
        if(!['GET','POST','PUT','DELETE'].includes(method))return json(res,{error:'Method not allowed.'},405);
        const isWrite=method!=='GET';
        if(isWrite&&req.headers['x-local-token']!==csrfToken)return json(res,{error:'Reload the app to obtain a local session token.'},403);
        const input=isWrite?await body(req):{};
        const route=url.pathname;
        if(route.startsWith('/api/workspace')) {
          workspace.requireAccess();
          if(method==='GET'&&route==='/api/workspace')return json(res,{...workspace.status(),csrfToken});
          if(method==='GET'&&route==='/api/workspace/search')return json(res,workspace.search(url.searchParams.get('q')||''));
          if(method==='GET'&&route.startsWith('/api/workspace/sources/'))return json(res,workspace.source(decodeURIComponent(route.slice('/api/workspace/sources/'.length))));
          if(method==='POST'&&route==='/api/workspace/model')return json(res,workspace.selectModel(input.modelId,input.effort));
          if(method==='POST'&&route==='/api/workspace/personalities/preview')return json(res,workspace.personalities.preview(input.batchIndex??0));
          if(method==='POST'&&route==='/api/workspace/personalities')return json(res,{job:workspace.createPersonalities(input)});
          const personalities=route.match(/^\/api\/workspace\/personalities\/([^/]+)$/);
          if(method==='POST'&&personalities) {if(input.action==='step'||!input.action)workspace.requireSource();return json(res,{job:await workspace.personalities.act(decodeURIComponent(personalities[1]),input.action||'step',{effort:input.effort})});}
          if(method==='POST'&&route==='/api/workspace/learn/preview')return json(res,workspace.learning.preview(input.sourceIds,input.batchIndex||0));
          if(method==='POST'&&route==='/api/workspace/learn') {workspace.requireSource();workspace.completion();return json(res,{job:workspace.learning.create(input.sourceIds)});}
          const learning=route.match(/^\/api\/workspace\/learn\/([^/]+)$/);
          if(method==='POST'&&learning) {if(input.action==='step'||!input.action){workspace.requireSource();workspace.completion();}return json(res,{job:await workspace.learning.act(decodeURIComponent(learning[1]),input.action||'step')});}
          if(method==='POST'&&route==='/api/workspace/suggest-mode')return json(res,workspace.suggest(input));
          if(method==='POST'&&route==='/api/workspace/draft/preview')return json(res,workspace.preview(input));
          if(method==='POST'&&route==='/api/workspace/draft')return json(res,await workspace.draft(input));
          if(method==='POST'&&route==='/api/workspace/compare')return json(res,await workspace.compare(input));
          return json(res,{error:'Workspace endpoint not found.'},404);
        }
        if(method==='GET'&&route==='/api/onboarding') {await chatgpt.restore();return json(res,{...harness.status(),chatgpt:chatgpt.status(),csrfToken});}
        if(method==='POST'&&route==='/api/onboarding/chatgpt')return json(res,await chatgpt.begin(`http://127.0.0.1:${port}`,input.accountId));
        if(method==='POST'&&route==='/api/onboarding/chatgpt/use') {await chatgpt.activate(input.accountId);return json(res,{model:harness.modelSession.status});}
        if(method==='POST'&&route==='/api/onboarding/chatgpt/ack') {chatgpt.acknowledge(input.accountId);return json(res,{ok:true});}
        if(method==='DELETE'&&route==='/api/onboarding/chatgpt')return json(res,await chatgpt.signOut(input.accountId));
        if(method==='POST'&&route==='/api/onboarding/model') {const result=await harness.verifyModel(input);chatgpt.pause();return json(res,result);}
        if(method==='DELETE'&&route==='/api/onboarding/model') {if(harness.modelSession.status.authMode==='chatgpt')return json(res,await chatgpt.signOut());chatgpt.pause();return json(res,harness.forgetModel());}
        if(method==='POST'&&route==='/api/onboarding/paste')return json(res,harness.paste(input));
        if(method==='POST'&&route==='/api/onboarding/start')return json(res,harness.start());
        if(method==='POST'&&route==='/api/onboarding/oauth/gmail')return json(res,harness.beginGoogleOAuth(`http://${req.headers.host}`));
        if(method==='GET'&&route==='/api/onboarding/slack/dms')return json(res,await harness.listDMs(url.searchParams.get('cursor')));
        const connection=route.match(/^\/api\/onboarding\/connect\/(gmail|slack)$/);
        if(connection&&method==='POST')return json(res,await harness.connect(connection[1],input));
        if(connection&&method==='DELETE')return json(res,harness.disconnect(connection[1]));
        const importing=route.match(/^\/api\/onboarding\/import\/(gmail|slack)$/);
        if(importing&&method==='POST')return json(res,await harness.import(importing[1],input));
        if(method==='DELETE'&&route.startsWith('/api/onboarding/sources/'))return json(res,harness.removeSource(decodeURIComponent(route.slice('/api/onboarding/sources/'.length))));
        if(method==='GET'&&route==='/api/state') {
          const current=store.readProfile();const state=store.readState();
          return json(res,{profile:current.profile,profileVersion:current.version,sources:state.sources,jobs:state.jobs.map(jobSummary),feedback:state.feedback,evaluations:state.evaluations,profileHistory:state.history.map(({markdown,...item})=>item),csrfToken,config:{dataDir:store.dir,providers:providerStatus(),integrations:await integrationStatus(),limits:{importBytes:32*1024*1024,batchConversations:20}}});
        }
        if(method==='GET'&&route==='/api/chatbot-prompt')return json(res,{prompt:fs.readFileSync(path.join(projectRoot,'docs/ask-your-chatbot.md'),'utf8')});
        if(method==='GET'&&route==='/api/fixtures') {const fixture=readJSON('fixtures/conversations.json');return json(res,Array.isArray(fixture)?{conversations:fixture}:fixture);}
        if(method==='GET'&&route==='/api/heldout')return json(res,{cases:heldoutCases()});
        if(method==='GET'&&route==='/api/profile/markdown') {const {markdown,version}=store.readProfile();return json(res,{markdown,version});}
        if(method==='GET'&&route.startsWith('/api/sources/')) {const source=store.readState().sources.find(x=>x.id===decodeURIComponent(route.slice('/api/sources/'.length)));if(!source)return json(res,{error:'Source not found.'},404);return json(res,source);}
        if(method==='POST'&&route==='/api/import')return json(res,{job:createImport(store,input.input,{...input,onboardingEligible:true})});
        if(method==='POST'&&route.startsWith('/api/jobs/'))return json(res,{job:stepImport(store,decodeURIComponent(route.slice('/api/jobs/'.length)),input.action)});
        if(method==='POST'&&route==='/api/extract')return json(res,extractSelected(store,input.sourceIds));
        if(method==='DELETE'&&route.startsWith('/api/sources/'))return json(res,deleteSource(store,decodeURIComponent(route.slice('/api/sources/'.length)),input.derivedAction));
        if(method==='POST'&&route==='/api/profile')return json(res,store.saveProfile(input.profile,input.version));
        if(method==='PUT'&&route==='/api/profile/markdown')return json(res,store.saveMarkdown(input.markdown,input.version));
        if(method==='POST'&&route==='/api/profile/undo')return json(res,store.undo());
        if(method==='POST'&&route==='/api/modes/propose')return json(res,suggestModes(store));
        if(method==='POST'&&route==='/api/suggest-mode')return json(res,suggestMode(store.readProfile().profile,input));
        if(method==='POST'&&route==='/api/draft/preview')return json(res,workspace.preview(input));
        if(method==='POST'&&route==='/api/draft')return json(res,await workspace.draft(input));
        if(method==='POST'&&route==='/api/feedback')return json(res,recordFeedback(store,input));
        if(method==='DELETE'&&route.startsWith('/api/feedback/')) {
          const id=decodeURIComponent(route.slice('/api/feedback/'.length));
          const current=store.readProfile();
          for(const collection of ['preferences','examples'])current.profile[collection]=current.profile[collection].filter(p=>!(p.sources||[]).some(s=>s.conversationId===`feedback:${id}`));
          store.saveProfile(current.profile,current.version,'Removed feedback and its derived records');
          store.mutate(s=>{s.feedback=s.feedback.filter(f=>f.id!==id);s.history=[];});
          return json(res,{deleted:id});
        }
        if(method==='POST'&&['/api/integrations/gmail','/api/integrations/slack'].includes(route))return json(res,await harness.import(route.endsWith('gmail')?'gmail':'slack',input));
        if(method==='POST'&&route==='/api/compare') {
          if(input.caseId) {
            const testCase=heldoutCases().find(c=>c.id===input.caseId);if(!testCase)throw new Error('Held-out case not found.');
            return json(res,await workspace.compare({...testCase,...testCase.draftRequest,formality:testCase.addressForm||'auto',modeId:input.modeId}));
          }
          return json(res,await workspace.compare(input));
        }
        if(method==='POST'&&route==='/api/evaluations') {
          if(!['left','right','tie'].includes(input.choice))throw new Error('Choose left, right, or tie.');
          const evaluation=store.mutate(s=>{
            const comparison=s.comparisons.find(c=>c.id===input.comparisonId);if(!comparison)throw new Error('Comparison not found.');
            const record={id:uid(),comparisonId:comparison.id,caseId:comparison.caseId,choice:input.choice,note:input.note||'',labels:comparison.labels,winner:input.choice==='tie'?'tie':comparison.labels[input.choice],demo:comparison.demo,profileVersion:comparison.profileVersion,date:new Date().toISOString()};
            s.evaluations.push(record);return record;
          });return json(res,evaluation);
        }
        return json(res,{error:'API endpoint not found.'},404);
      }
      if(req.method!=='GET')return json(res,{error:'Method not allowed.'},405);
      const files={'/':'index.html','/index.html':'index.html','/app.js':'app.js','/workspace.js':'workspace.js','/styles.css':'styles.css','/setup':'setup.html'};
      const filename=files[url.pathname];if(!filename)return json(res,{error:'Not found.'},404);
      const type=filename.endsWith('.js')?'text/javascript':filename.endsWith('.css')?'text/css':'text/html';
      res.writeHead(200,{'Content-Type':type+'; charset=utf-8','Cache-Control':'no-store'});res.end(fs.readFileSync(path.join(projectRoot,'public',filename)));
    } catch(error) {if(!res.headersSent)json(res,{error:error.message||'Request failed.'},error.status||400);else res.end();}
  });
  server.requestTimeout=180000;
  return server;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  const port=Number(process.env.PORT||3210);
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error('PORT must be between 1 and 65535.');
  const server=createApp();
  server.listen(port,'127.0.0.1',()=>console.log(`Larpmaxxing is available at http://127.0.0.1:${port}\nPrivate data stays outside the source tree. Learning and drafting send selected content only when requested in the app.`));
  server.on('error',err=>{console.error(err.code==='EADDRINUSE'?'Port is busy. Set PORT to another local port.':'Unable to start the local server.');process.exitCode=1;});
}
