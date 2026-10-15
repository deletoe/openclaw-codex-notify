#!/usr/bin/env node
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, existsSync, readFileSync, writeFileSync, copyFileSync, chmodSync, renameSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { discoverHomes } from '../src/notify-homes.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
if(process.platform!=='darwin')throw new Error('The service installer currently supports macOS only');
let dir=resolve(process.env.CODEX_NOTIFY_STATE_DIR??join(root,'.local','notify'));
const configPath=process.env.CODEX_NOTIFY_CONFIG??join(dir,'config.json');
const old=existsSync(configPath)?JSON.parse(readFileSync(configPath,'utf8')):{};
dir=resolve(old.stateDir??dir);
const homes=discoverHomes(old.codexHomes??[join(homedir(),'.codex')]);
const runtime=existsSync('/opt/homebrew/bin/node')?'/opt/homebrew/bin/node':process.execPath;
const shellQuote=s=>`'${s.replaceAll("'", "'\\''")}'`;
const migrateArg=process.argv.indexOf('--migrate-from');
if(migrateArg>=0&&(!process.argv[migrateArg+1]||process.argv[migrateArg+1].startsWith('--')))throw new Error('--migrate-from requires the previous package directory');
const previousRoot=migrateArg>=0?resolve(process.argv[migrateArg+1]):null;
let migratedHooks=0;
const events=['PreToolUse','PermissionRequest','PostToolUse','UserPromptSubmit','Interrupt'];
const hooks=homes.map(home=>{
  const path=join(home,'hooks.json');const value=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{};
  value.hooks??={};
  const command=`CODEX_NOTIFY_STATE_DIR=${shellQuote(dir)} ${shellQuote(runtime)} ${shellQuote(join(root,'src/notify-hook.mjs'))}`;
  for(const event of events){
    value.hooks[event]??=[];
    let seen=false;
    value.hooks[event]=value.hooks[event].flatMap(group=>{
      if(!Array.isArray(group.hooks))return [group];
      let changed=false;
      const hooks=group.hooks.flatMap(h=>{
        if(previousRoot&&typeof h.command==='string'&&h.command.startsWith(`CODEX_NOTIFY_STATE_DIR=${shellQuote(dir)} `)&&h.command.endsWith(shellQuote(join(previousRoot,'src','notify-hook.mjs')))){
          h={...h,command};changed=true;migratedHooks++;
        }
        if(h.command===command){if(seen){changed=true;return [];}seen=true;}
        return [h];
      });
      return changed?(hooks.length?[{...group,hooks}]:[]):[group];
    });
    if(!seen)value.hooks[event].push({hooks:[{type:'command',command,timeout:2,async:event!=='Interrupt'}]});
  }
  return {path,value};
});
const xml=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const label=process.env.CODEX_NOTIFY_SERVICE_LABEL??'com.openclaw.codex-notify';
if(!/^[a-zA-Z0-9.-]+$/.test(label))throw new Error('Invalid service label');
const plistPath=join(homedir(),'Library','LaunchAgents',`${label}.plist`);
const plist=`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${xml(runtime)}</string><string>${xml(join(root,'src/notify.mjs'))}</string><string>run</string></array>
<key>WorkingDirectory</key><string>${xml(root)}</string>
<key>EnvironmentVariables</key><dict><key>CODEX_NOTIFY_CONFIG</key><string>${xml(configPath)}</string><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>15</integer>
<key>StandardOutPath</key><string>${xml(join(dir,'service.log'))}</string>
<key>StandardErrorPath</key><string>${xml(join(dir,'service-error.log'))}</string>
</dict></plist>\n`;
let gatewayUrl=process.env.CODEX_NOTIFY_GATEWAY_URL??old.gateway?.url;
let deviceDisplayName=old.gateway?.clientDisplayName;
const nodeState=join(process.env.OPENCLAW_STATE_DIR??join(homedir(),'.openclaw'),'state','openclaw.sqlite');
if(!gatewayUrl&&existsSync(nodeState)){
  const db=new DatabaseSync(nodeState,{readOnly:true});
  try{const row=db.prepare('SELECT value_json FROM config_machine_state WHERE state_key=?').get('nodeHost.config');
    const host=row?JSON.parse(row.value_json):null;const g=host?.gateway;
    deviceDisplayName??=host?.displayName;
    if(g?.host)gatewayUrl=`${g.tls?'wss':'ws'}://${g.host}:${g.port??(g.tls?443:18789)}`;
  }finally{db.close();}
}
const gatewayPath=join(dir,'gateway.json');
if(gatewayUrl&&!['ws:','wss:'].includes(new URL(gatewayUrl).protocol))throw new Error('Invalid Gateway URL');
const config={stateDir:dir,pollMs:5000,...old,replies:{allowedSenderIds:[],...old.replies},codexHomes:homes,gateway:{enabled:false,transport:'sdk',identitySource:existsSync(nodeState)?'openclaw-node':'standalone',...(existsSync(nodeState)?{openclawStateDb:nodeState}:{}),...(deviceDisplayName?{clientDisplayName:deviceDisplayName}:{}),credentialsPath:join(dir,'operator.json'),configPath:gatewayPath,...old.gateway,
  ...(process.env.CODEX_NOTIFY_GATEWAY_URL?{url:gatewayUrl,enabled:false}:{})}};
const plan={configPath,runtimeRoot:root,gatewayUrl:gatewayUrl??null,channelId:config.gateway.channelId??null,
  hookFiles:hooks.map(h=>h.path),events,launchAgent:plistPath,apply:process.argv.includes('--apply'),previousRoot,migratedHooks,
  hookTrustRequired:true,notice:'No session/project filter. Hook trust is managed by Codex. The public Gateway SDK reuses the node device identity and stores only a separate operator credential.'};
if(!process.argv.includes('--apply')){console.log(JSON.stringify(plan,null,2));process.exit(0);}
mkdirSync(dir,{recursive:true,mode:0o700});chmodSync(dir,0o700);
const backups=join(dir,'backups',new Date().toISOString().replaceAll(':','-'));mkdirSync(backups,{recursive:true,mode:0o700});
function save(path,text,name){
  mkdirSync(dirname(path),{recursive:true,mode:0o700});
  if(existsSync(path)){const b=join(backups,name);copyFileSync(path,b);chmodSync(b,0o600);}
  const temp=`${path}.codex-notify-${process.pid}.tmp`;
  writeFileSync(temp,text,{mode:0o600});renameSync(temp,path);chmodSync(path,0o600);
}
save(configPath,JSON.stringify(config,null,2)+'\n','config.json');
if(gatewayUrl&&!existsSync(gatewayPath))save(gatewayPath,JSON.stringify({gateway:{mode:'remote',remote:{url:gatewayUrl}}},null,2)+'\n','gateway.json');
for(let i=0;i<hooks.length;i++)save(hooks[i].path,JSON.stringify(hooks[i].value,null,2)+'\n',`hooks-${i}.json`);
save(plistPath,plist,'launch-agent.plist');
execFileSync('/usr/bin/plutil',['-lint',plistPath],{stdio:'inherit'});
if(process.argv.includes('--start')){
  const domain=`gui/${process.getuid()}`;
  try{execFileSync('/bin/launchctl',['bootout',`${domain}/${label}`],{stdio:'ignore'});}catch{}
  execFileSync('/bin/launchctl',['bootstrap',domain,plistPath],{stdio:'inherit'});
}
console.log(JSON.stringify({...plan,backups},null,2));
