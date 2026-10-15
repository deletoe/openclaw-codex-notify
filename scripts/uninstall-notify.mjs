#!/usr/bin/env node
import { homedir } from 'node:os';
import { dirname,join,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync,readFileSync,writeFileSync,mkdirSync,copyFileSync,renameSync,unlinkSync,chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const path=process.env.CODEX_NOTIFY_CONFIG??join(root,'.local','notify','config.json');
if(!existsSync(path))throw new Error('Collector configuration does not exist');
const config=JSON.parse(readFileSync(path,'utf8'));
const label=process.env.CODEX_NOTIFY_SERVICE_LABEL??'com.openclaw.codex-notify';
if(!/^[a-zA-Z0-9.-]+$/.test(label))throw new Error('Invalid service label');
const plist=join(homedir(),'Library','LaunchAgents',label+'.plist');
if(existsSync(plist)){
  const owner=execFileSync('/usr/bin/plutil',['-extract','EnvironmentVariables.CODEX_NOTIFY_CONFIG','raw','-o','-',plist],{encoding:'utf8'}).trim();
  if(resolve(owner)!==resolve(path))throw new Error('Service belongs to another collector configuration');
}
const quoted=s=>`'${s.replaceAll("'", "'\\''")}'`;
const hookPath=quoted(join(root,'src','notify-hook.mjs'));
const changes=[];
for(const home of config.codexHomes??[]){
  const path=join(home,'hooks.json');if(!existsSync(path))continue;
  const value=JSON.parse(readFileSync(path,'utf8'));let removed=0;
  for(const [event,groups] of Object.entries(value.hooks??{})){
    value.hooks[event]=groups.flatMap(group=>{
      if(!Array.isArray(group.hooks))return [group];
      const hooks=group.hooks.filter(h=>h.command?.includes(hookPath)!==true);
      if(hooks.length===group.hooks.length)return [group];
      removed+=group.hooks.length-hooks.length;
      return hooks.length?[{...group,hooks}]:[];
    });
  }
  if(removed)changes.push({path,value,removed});
}
console.log(JSON.stringify({apply:process.argv.includes('--apply'),service:plist,hooks:changes.map(({path,removed})=>({path,removed})),statePreserved:config.stateDir},null,2));
if(!process.argv.includes('--apply'))process.exit(0);
const domain=`gui/${process.getuid()}`;
let loaded=false;try{execFileSync('/bin/launchctl',['print',`${domain}/${label}`],{stdio:'ignore'});loaded=true;}catch{}
if(loaded)execFileSync('/bin/launchctl',['bootout',`${domain}/${label}`],{stdio:'ignore'});
const backup=join(config.stateDir,'backups',`uninstall-${Date.now()}`);mkdirSync(backup,{recursive:true,mode:0o700});
function save(path,value,name){
  copyFileSync(path,join(backup,name));chmodSync(join(backup,name),0o600);
  const temp=path+'.tmp';writeFileSync(temp,JSON.stringify(value,null,2)+'\n',{mode:0o600});renameSync(temp,path);
}
for(let i=0;i<changes.length;i++)save(changes[i].path,changes[i].value,`hooks-${i}.json`);
save(path,{...config,gateway:{...config.gateway,enabled:false}},'config.json');
if(existsSync(plist)){copyFileSync(plist,join(backup,'launch-agent.plist'));chmodSync(join(backup,'launch-agent.plist'),0o600);unlinkSync(plist);}
