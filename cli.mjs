import { parseArgs } from 'node:util';
import { homedir,hostname } from 'node:os';
import { dirname,join,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync,readFileSync,writeFileSync,mkdirSync,copyFileSync,renameSync } from 'node:fs';
import { spawn,execFileSync } from 'node:child_process';

const root=dirname(fileURLToPath(import.meta.url));
const quote=s=>`'${String(s).replaceAll("'", "'\\''")}'`;
const commands={
  install:['Install collector and Codex Hooks (dry run unless --apply)',[['gateway <url>','Gateway wss:// URL'],['migrate-from <directory>','Replace this previous checkout/package Hook path'],['apply','Write installation'],['start','Start after installing'],['app-permissions <backend>','Explicitly request and check the existing jxa route after install; run via the actual Mac node']]],
  permissions:['Guide or check App permissions; no prompts unless explicitly requested',[['backend <name>','Existing UI route: jxa; omit for official native setup guide'],['request','Request missing macOS grants in this executor'],['verify','Read target window structure only after grants pass'],['open-settings','Open a missing permission pane for the user']]],
  pair:['Connect or request operator authorization',[['file <path>','Private JSON setup credential']]],
  'pairing-request':['Print instructions to give the Gateway administrator',[]],
  channels:['Discover Discord channels across visible agents',[['query <name>','Channel search, default codex'],['agent <id>','Limit to one agent']]],
  target:['Save a verified destination while delivery is disabled',[['channel-id <id>','Discord channel ID'],['account <id>','Discord account, default default'],['agent <id>','Owning OpenClaw agent']]],
  enable:['Enable delivery and start/reload this collector',[]],
  disable:['Disable delivery and stop this collector',[]],
  status:['Read collector status',[]],
  start:['Start the installed collector',[]],
  stop:['Stop the installed collector',[]],
  restart:['Restart the installed collector',[]],
  ack:['Mark one pending matter handled',[['id <id>','Reminder ID from status']]],
  'reply-resolve':['Resolve a native Discord reply reference to its exact original Codex session',[['message-id <id>','Referenced notification Discord ID'],['channel-id <id>','Native inbound channel ID'],['account <id>','Native inbound account ID']]],
  'reply-index':['Index explicitly verified legacy send receipts (dry run unless --apply)',[['message-id <id>','One verified notification ID'],['file <path>','JSON with explicit messageIds'],['apply','Write verified mappings']]],
  'reply-prepare':['Deduplicate a human reply and resolve its original App session',[['file <path>','Private normalized native inbound JSON']]],
  'reply-status':['Read a reply delivery state',[['key <id>','Reply delivery key']]],
  'reply-read':['Read exact original native Codex home/thread without resuming it',[['key <id>','Reply delivery key']]],
  'reply-send-cli':['Resume a positively identified CLI-origin session with this reply via stdin',[['key <id>','Reply delivery key'],['token <token>','Local claim token'],['baseline-turn <id>','Latest persisted turn before input']]],
  'reply-skill':['Optionally install the Skill on an agent host; not required on a node-only Mac',[['apply','Install the bundled skill without replacing an unrelated file']]],
  'reply-begin':['Mark an App input attempt before sending once',[['key <id>','Reply delivery key'],['token <token>','Local claim token'],['baseline-turn <id>','Latest persisted turn before input']]],
  'reply-confirm':['Record verified same-session input delivery',[['key <id>','Reply delivery key'],['token <token>','Local claim token'],['file <path>','Verified App receipt JSON']]],
  'reply-uncertain':['Stop automatic retries after an ambiguous App input',[['key <id>','Reply delivery key'],['token <token>','Local claim token'],['file <path>','Optional JSON reason']]],
  uninstall:['Remove this service and its Hooks; preserve state and credentials',[['apply','Apply removal (otherwise dry run)']]]
};

export function registerCommands(program,{configPath,packageRoot}={}){
  const parent=program.command('codex-notify').description('Local Codex 20-minute reminders')
    .option('--config <path>','Collector configuration path',configPath);
  for(const [name,[description,options]] of Object.entries(commands)){
    const command=parent.command(name).description(description);
    for(const [flag,help] of options)command.option(`--${flag}`,help);
    command.action(async(options)=>{
      const values={...parent.opts(),...options};const args=[name];
      for(const [key,value] of Object.entries(values))if(value!==undefined&&value!==false){
        args.push('--'+key.replace(/[A-Z]/g,c=>'-'+c.toLowerCase()));if(value!==true)args.push(String(value));
      }
      try {await runCli(args,{packageRoot});}catch(error){console.error(error.message);process.exitCode=1;}
    });
  }
}

export function context(configPath,env=process.env,home=homedir()){
  const path=resolve(configPath??env.CODEX_NOTIFY_CONFIG??join(env.OPENCLAW_STATE_DIR??join(home,'.openclaw'),'codex-notify','config.json'));
  const config=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{};
  return {path,config,state:resolve(config.stateDir??dirname(path)),home};
}
function persist(ctx,config){
  mkdirSync(dirname(ctx.path),{recursive:true,mode:0o700});
  if(existsSync(ctx.path)){
    const backup=join(ctx.state,'backups',`config-${Date.now()}.json`);mkdirSync(dirname(backup),{recursive:true,mode:0o700});
    copyFileSync(ctx.path,backup);execFileSync('/bin/chmod',['600',backup]);
  }
  const temp=ctx.path+'.tmp';writeFileSync(temp,JSON.stringify(config,null,2)+'\n',{mode:0o600});renameSync(temp,ctx.path);
}
function service(ctx){
  for(const label of ['com.openclaw.codex-notify']){
    const path=join(ctx.home,'Library','LaunchAgents',label+'.plist');
    if(!existsSync(path))continue;
    const configured=execFileSync('/usr/bin/plutil',['-extract','EnvironmentVariables.CODEX_NOTIFY_CONFIG','raw','-o','-',path],{encoding:'utf8'}).trim();
    if(resolve(configured)!==ctx.path)throw new Error(`Another Codex collector already exists (${label}). Use --config ${configured} to manage it; migrate deliberately to preserve deduplication.`);
    return {label,path,domain:`gui/${process.getuid()}`};
  }
  return {label:'com.openclaw.codex-notify',path:join(ctx.home,'Library','LaunchAgents','com.openclaw.codex-notify.plist'),domain:`gui/${process.getuid()}`};
}
function stopService(s){
  try{execFileSync('/bin/launchctl',['print',`${s.domain}/${s.label}`],{stdio:'ignore'});}
  catch{return;}
  execFileSync('/bin/launchctl',['bootout',`${s.domain}/${s.label}`],{stdio:'ignore'});
}
function startService(s){
  if(!existsSync(s.path))throw new Error('Service is not installed. Run install --apply first.');
  stopService(s);execFileSync('/bin/launchctl',['bootstrap',s.domain,s.path],{stdio:'inherit'});
}
function child(relative,args,ctx,extraEnv={}){
  const runtime=process.release?.name==='node'?process.execPath:execFileSync('/usr/bin/which',['node'],{encoding:'utf8'}).trim();
  const version=execFileSync(runtime,['--version'],{encoding:'utf8'}).trim().match(/^v(\d+)\.(\d+)\./);
  if(!version||Number(version[1])<24||(Number(version[1])===24&&Number(version[2])<16))throw new Error('Collector requires Node.js 24.16 or newer');
  return new Promise((resolveChild,reject)=>{
    const proc=spawn(runtime,[join(ctx.packageRoot,relative),...args],{
      env:{...process.env,CODEX_NOTIFY_CONFIG:ctx.path,CODEX_NOTIFY_STATE_DIR:ctx.state,...extraEnv},stdio:'inherit'
    });
    proc.once('error',reject);proc.once('close',code=>resolveChild(code??1));
  });
}

export async function runCli(argv,{configPath,packageRoot,print=console.log}={}){
  const parsed=parseArgs({args:argv,allowPositionals:true,options:{
    config:{type:'string'},gateway:{type:'string'},'migrate-from':{type:'string'},apply:{type:'boolean'},start:{type:'boolean'},
    file:{type:'string'},query:{type:'string'},agent:{type:'string'},'channel-id':{type:'string'},account:{type:'string'},id:{type:'string'},help:{type:'boolean'},
    'message-id':{type:'string'},key:{type:'string'},token:{type:'string'},'baseline-turn':{type:'string'},
    backend:{type:'string'},request:{type:'boolean'},verify:{type:'boolean'},'open-settings':{type:'boolean'},'app-permissions':{type:'string'}
  }});
  const [command,...rest]=parsed.positionals;const o=parsed.values;
  if(o.help||!command){print('codex-notify [--config PATH] <command>\n'+Object.entries(commands).map(([k,[v]])=>`${k.padEnd(18)} ${v}`).join('\n'));return;}
  if(!commands[command]||rest.length)throw new Error('Unknown command or extra positional arguments; use --help');
  const ctx=context(o.config??configPath);
  // OpenClaw imports runtime modules from a disposable capture. Long-lived processes must use api.rootDir.
  ctx.packageRoot=resolve(packageRoot??root);
  if(command==='permissions'){
    const args=[];for(const key of ['backend','request','verify','open-settings'])if(o[key]){args.push('--'+key);if(typeof o[key]==='string')args.push(o[key]);}
    const code=await child('src/notify-permissions.mjs',args,ctx);if(code)process.exitCode=code;return;
  }
  if(command==='pairing-request'){
    const g=ctx.config.gateway??{};
    const url=g.url??(g.configPath&&existsSync(g.configPath)?JSON.parse(readFileSync(g.configPath,'utf8')).gateway?.remote?.url:null);
    if(!url)throw new Error('Install with --gateway wss://HOST first');
    print(`Target computer: ${g.clientDisplayName??hostname()} (local hostname: ${hostname()}).\nOn the Gateway, generate full-access setup JSON using:\n  openclaw qr --public-url ${quote(url)} --json\nUse a private temporary file (mode 600), then transfer its exact JSON through the existing trusted node or SSH to this computer:\n  ${join(ctx.state,'pairing.json')}\nKeep the directory mode 700 and file mode 600. Do not print setup codes or tokens. On this computer run:\n  openclaw codex-notify --config ${quote(ctx.path)} pair --file ${quote(join(ctx.state,'pairing.json'))}\nIf PAIRING_REQUIRED is returned, approve the exact requestId on the Gateway, then repeat pair. Do not use --limited: directory discovery requests operator.admin.`);
    return;
  }
  if(command==='install'){
    if(o['app-permissions']&&(!o.apply||o['app-permissions']!=='jxa'))throw new Error('--app-permissions jxa requires --apply and explicit selection of the existing JXA route');
    if(process.platform!=='darwin')throw new Error('Collector service installation currently supports macOS only');
    const s=service(ctx);
    const args=[...(o.apply?['--apply']:[]),...(o.start?['--start']:[]),...(o['migrate-from']?['--migrate-from',resolve(o['migrate-from'])]:[])];
    if(o.start&&!o.apply)throw new Error('--start requires --apply');
    const code=await child('scripts/install-notify.mjs',args,ctx,{CODEX_NOTIFY_SERVICE_LABEL:s.label,...(o.gateway?{CODEX_NOTIFY_GATEWAY_URL:o.gateway}:{})});
    if(code)throw new Error(`Installer exited ${code}`);
    if(o['app-permissions']){
      const permissionCode=await child('src/notify-permissions.mjs',['--backend','jxa','--request','--verify'],ctx);
      if(permissionCode){print('Collector installed; App permissions/verification remain incomplete. Recheck through the same Mac node after user action.');process.exitCode=permissionCode;}
    }
    return;
  }
  if(!existsSync(ctx.path))throw new Error('Collector configuration is missing; run install first');
  if(command==='reply-skill'){
    const source=join(ctx.packageRoot,'skills','codex-notify-reply','SKILL.md');
    const target=join(process.env.OPENCLAW_STATE_DIR??join(ctx.home,'.openclaw'),'skills','codex-notify-reply','SKILL.md');
    if(!existsSync(source))throw new Error('Bundled reply skill is missing');
    const text=readFileSync(source,'utf8');
    if(existsSync(target)&&readFileSync(target,'utf8')!==text)throw new Error('Reply skill already exists with different content; review and merge it before replacing');
    if(o.apply){mkdirSync(dirname(target),{recursive:true,mode:0o700});writeFileSync(target,text,{mode:0o600});}
    print(JSON.stringify({source,target,apply:o.apply===true,nodeRestartRequired:o.apply===true}));return;
  }
  if(command.startsWith('reply-')){
    const args=[command];
    for(const key of ['file','message-id','channel-id','account','key','token','baseline-turn'])if(o[key]!==undefined)args.push('--'+key,o[key]);
    if(o.apply)args.push('--apply');
    const code=await child('src/notify-reply-cli.mjs',args,ctx);if(code)process.exitCode=code;return;
  }
  if(command==='pair'||command==='channels'||command==='status'||command==='ack'){
    if(command==='ack'&&!o.id)throw new Error('ack requires --id');
    const script=command==='pair'?'scripts/connect-notify.mjs':command==='channels'?'scripts/discover-notify-channel.mjs':'src/notify.mjs';
    const args=command==='pair'?(o.file?['--bootstrap-file',resolve(o.file)]:[]):command==='channels'?[...(o.query?['--query',o.query]:[]),...(o.agent?['--agent',o.agent]:[])]:command==='ack'?['ack',o.id]:['status'];
    const code=await child(script,args,ctx);if(code)process.exitCode=code;return;
  }
  if(command==='target'){
    if(ctx.config.gateway?.enabled)throw new Error('Run disable before changing the delivery target');
    if(!/^\d{15,25}$/.test(o['channel-id']??''))throw new Error('target requires a Discord --channel-id');
    ctx.config.gateway={...ctx.config.gateway,channelId:o['channel-id'],accountId:o.account??'default',...(o.agent?{agentId:o.agent}:{}),enabled:false};
    persist(ctx,ctx.config);print('Destination saved; delivery remains disabled. Run enable after verifying the channel.');return;
  }
  const s=service(ctx);
  if(command==='enable'){
    const {GatewaySender}=await import('./src/notify-gateway.mjs');
    const {NotifyGatewayClient}=await import('./src/notify-client.mjs');
    const g={...ctx.config.gateway,enabled:true};
    if(!new GatewaySender(g).configured())throw new Error('Missing approved operator.admin credentials or channel ID; run pair and target first');
    if(!existsSync(s.path))throw new Error('Service is not installed; run install --apply first');
    const client=new NotifyGatewayClient(g);try{await client.open();}finally{client.close();}
    persist(ctx,{...ctx.config,gateway:g});startService(s);print('Delivery enabled.');return;
  }
  if(command==='disable'){
    stopService(s);persist(ctx,{...ctx.config,gateway:{...ctx.config.gateway,enabled:false}});print('Delivery disabled; state and credentials preserved.');return;
  }
  if(command==='start'||command==='restart'){startService(s);print('Collector started.');return;}
  if(command==='stop'){stopService(s);print('Collector stopped.');return;}
  if(command==='uninstall'){
    const code=await child('scripts/uninstall-notify.mjs',o.apply?['--apply']:[],ctx,{CODEX_NOTIFY_SERVICE_LABEL:s.label});
    if(code)throw new Error(`Uninstaller exited ${code}`);
  }
}
