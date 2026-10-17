import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const hash = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const uid = () => crypto.randomUUID();
const emptyProfile = () => ({preferences:[],examples:[],modes:[]});
export function defaultDataDir() {
  if (process.env.OWN_WORDS_DATA_DIR) return path.resolve(process.env.OWN_WORDS_DATA_DIR);
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Own Words');
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || os.homedir(), 'Own Words');
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'own-words');
}
export function serializeProfile(profile) {
  validateProfile(profile);
  const sections = [
    ['Global hard rules','preferences',p=>p.category==='hard'],
    ['General and scoped writing guidance','preferences',p=>p.category!=='hard'],
    ['Audience and situation personalities','modes',()=>true],
    ['Examples and rejected wording','examples',()=>true]
  ];
  let out = '# My writing profile\n\nThis file is the profile source of truth. Edit record text or JSON metadata, preserving record markers. Only accepted or edited records are used. Changes are reloaded on every request. Evidence references and decisions live beside each record. Feedback history is stored separately in state.json.\n';
  for (const [heading,collection,predicate] of sections) {
    out += `\n## ${heading}\n\n`;
    for (const record of profile[collection].filter(predicate)) {
      const {text,guidance,...metadata} = record;
      const body = collection==='modes' ? guidance || '' : text || '';
      if (/<!--\s*\/?ow\b/.test(body)) throw new Error('Record text contains a reserved profile marker.');
      out += `<!-- ow: ${JSON.stringify({collection,...metadata})} -->\n${body}\n<!-- /ow -->\n\n`;
    }
  }
  return out;
}
export function parseProfile(markdown) {
  if (typeof markdown!=='string' || markdown.length>5_000_000) throw new Error('Invalid profile document.');
  const profile = emptyProfile();
  const regex = /<!-- ow: (\{[^\n]*\}) -->\r?\n([\s\S]*?)\r?\n<!-- \/ow -->/g;
  let match;
  while ((match=regex.exec(markdown))) {
    const {collection,...metadata}=JSON.parse(match[1]);
    if (!Object.hasOwn(profile,collection)) throw new Error('Unknown profile record collection.');
    profile[collection].push({...metadata,[collection==='modes'?'guidance':'text']:match[2]});
  }
  if ((markdown.match(/<!-- ow:/g)||[]).length!==profile.preferences.length+profile.examples.length+profile.modes.length) throw new Error('Malformed record markers. Fix the Markdown document before continuing.');
  validateProfile(profile);
  return profile;
}
export function validateProfile(profile) {
  if (!profile || typeof profile!=='object') throw new Error('Profile must be an object.');
  const statuses=['proposed','accepted','edited','rejected','disabled'];
  const scopeTypes=['global','language','channel','audience','recipient','situation','mode'];
  for (const collection of ['preferences','examples','modes']) {
    const label=collection==='modes'?'personalities':collection;
    if (!Array.isArray(profile[collection]) || profile[collection].length>10000) throw new Error(`Invalid ${label}.`);
    const seen=new Set();
    for (const item of profile[collection]) {
      if (!item.id || typeof item.id!=='string' || seen.has(item.id)) throw new Error(`Missing or duplicate ${label} ID.`);
      seen.add(item.id);
      if (!statuses.includes(item.status)) throw new Error(`Invalid status in ${label}.`);
      if (collection==='modes') {
        if (typeof item.name!=='string' || !item.name.trim()) throw new Error('A personality needs a name.');
        if (item.guidance!=null && typeof item.guidance!=='string') throw new Error('Personality guidance must be text.');
      } else if (typeof item.text!=='string' || !item.text.trim()) throw new Error('A preference or example needs text.');
      if (collection==='preferences') {
        if (!item.scope || !scopeTypes.includes(item.scope.type)) throw new Error('A preference needs a valid scope.');
        if (item.scope.type!=='global' && !String(item.scope.value||'').trim()) throw new Error('A scoped preference needs a scope value.');
        if (item.banned && (!Array.isArray(item.banned) || item.banned.some(v=>typeof v!=='string'||!v||v.length>500))) throw new Error('Banned literals must be nonempty strings, at most 500 characters.');
      }
    }
  }
}
export class Store {
  constructor(dir=defaultDataDir(), {allowInsideProject=false}={}) {
    this.dir=path.resolve(dir);
    // Resolve existing ancestors to prevent a symlink from placing private data inside the checkout.
    let ancestor=this.dir, suffix=[];
    while (!fs.existsSync(ancestor)) {suffix.unshift(path.basename(ancestor));ancestor=path.dirname(ancestor);}
    const real=path.join(fs.realpathSync(ancestor),...suffix);
    if (!allowInsideProject && (real===projectRoot || real.startsWith(projectRoot+path.sep))) throw new Error('OWN_WORDS_DATA_DIR must be outside the publishable project.');
    fs.mkdirSync(this.dir,{recursive:true,mode:0o700});
    fs.chmodSync(this.dir,0o700);
    this.profileFile=path.join(this.dir,'profile.md');
    this.stateFile=path.join(this.dir,'state.json');
    if (!fs.existsSync(this.profileFile)) this.atomic(this.profileFile,serializeProfile(emptyProfile()));
    if (!fs.existsSync(this.stateFile)) this.writeState({sources:[],jobs:[],drafts:[],feedback:[],evaluations:[],comparisons:[],history:[]});
  }
  atomic(file,content) {
    const temp=file+'.'+uid()+'.tmp';
    try {fs.writeFileSync(temp,content,{mode:0o600,flag:'wx'});fs.renameSync(temp,file);fs.chmodSync(file,0o600);} finally {if(fs.existsSync(temp))fs.unlinkSync(temp);}
  }
  readState() {return JSON.parse(fs.readFileSync(this.stateFile,'utf8'));}
  writeState(state) {this.atomic(this.stateFile,JSON.stringify(state));}
  mutate(fn) {const state=this.readState();const result=fn(state);this.writeState(state);return result;}
  readProfile() {const markdown=fs.readFileSync(this.profileFile,'utf8');return {profile:parseProfile(markdown),markdown,version:hash(markdown)};}
  saveProfile(profile,version,reason='Profile edited') {return this.saveMarkdown(serializeProfile(profile),version,reason);}
  saveMarkdown(markdown,version,reason='Markdown edited') {
    parseProfile(markdown);
    const current=this.readProfile();
    if (version!==current.version) {const err=new Error('The profile changed on disk or in another tab. Reload before saving.');err.status=409;throw err;}
    this.mutate(s=>{s.history.push({id:uid(),date:new Date().toISOString(),reason,markdown:current.markdown});s.history=s.history.slice(-30);});
    this.atomic(this.profileFile,markdown);
    return this.readProfile();
  }
  undo() {
    const current=this.readProfile();
    const previous=this.mutate(s=>s.history.pop());
    if (!previous) throw new Error('No profile change to undo.');
    parseProfile(previous.markdown);
    this.atomic(this.profileFile,previous.markdown);
    return {previousVersion:current.version,...this.readProfile()};
  }
}
