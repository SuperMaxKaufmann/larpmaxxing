import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const roots=['server','public','scripts','tests'];
let failed=false;
for(const root of roots) for(const file of fs.readdirSync(root)) {
  if(!/\.(?:mjs|js)$/.test(file))continue;
  const result=spawnSync(process.execPath,['--check',path.join(root,file)],{encoding:'utf8'});
  if(result.status!==0){process.stderr.write(result.stderr);failed=true;}
}
const forbidden=['.env','state.json','profile.md','chatgpt-auth.json','data','private','exports'];
for(const file of forbidden)if(fs.existsSync(file)){console.error(`Private material must not be in the publishable tree: ${file}`);failed=true;}
if(failed)process.exit(1);
console.log('Syntax and publishable-tree checks passed.');
