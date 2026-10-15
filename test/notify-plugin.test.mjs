import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,readdirSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import plugin from '../index.mjs';
import { context,runCli } from '../cli.mjs';

test('plugin registration is lazy; state defaults outside the package and honors an existing configuration',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'notify-plugin-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const configPath=join(dir,'config.json');writeFileSync(configPath,JSON.stringify({stateDir:join(dir,'durable'),gateway:{url:'wss://gateway.example:443',clientDisplayName:'test-mac'}}));
  let registrations=0;
  plugin.register({pluginConfig:{configPath},registerCli(callback,metadata){
    registrations++;assert.equal(typeof callback,'function');assert.equal(metadata.descriptors[0].name,'codex-notify');
  }});
  assert.equal(registrations,1);
  assert.equal(context(undefined,{},dir).state,join(dir,'.openclaw','codex-notify'));
  assert.equal(context(undefined,{OPENCLAW_STATE_DIR:join(dir,'profile')},dir).state,join(dir,'profile','codex-notify'));
  assert.equal(context(undefined,{CODEX_NOTIFY_CONFIG:configPath},dir).state,join(dir,'durable'));
  const output=[];await runCli(['--help'],{print:s=>output.push(s)});
  assert.ok(output[0].includes('pairing-request'));assert.ok(!existsSync(join(dir,'durable')));
  await runCli(['--config',configPath,'pairing-request'],{print:s=>output.push(s)});
  assert.ok(output[1].includes('Target computer: test-mac'));assert.ok(output[1].includes("--config '"));
  assert.ok(!existsSync(join(dir,'durable')));
});

test('CLI child execution uses the stable host package root rather than the disposable import capture',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'notify-stable-root-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const config=join(dir,'config.json'),stable=join(dir,'installed plugin'),marker=join(dir,'executed');
  writeFileSync(config,'{}');mkdirSync(join(stable,'scripts'),{recursive:true});
  writeFileSync(join(stable,'scripts/connect-notify.mjs'),`import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(marker)},'stable package');`);
  await runCli(['--config',config,'pair'],{packageRoot:stable});
  assert.equal(readFileSync(marker,'utf8'),'stable package');
});

test('permission setup is an explicit command, works before collector configuration and preserves flags',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'notify-permissions-cli-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const stable=join(dir,'plugin'),marker=join(dir,'args.json'),missingConfig=join(dir,'not-installed','config.json');
  mkdirSync(join(stable,'src'),{recursive:true});
  writeFileSync(join(stable,'src','notify-permissions.mjs'),`import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(marker)},JSON.stringify(process.argv.slice(2)));`);
  await runCli(['--config',missingConfig,'permissions','--backend','jxa','--request','--verify'],{packageRoot:stable});
  assert.deepEqual(JSON.parse(readFileSync(marker,'utf8')),['--backend','jxa','--request','--verify']);
  assert.equal(existsSync(missingConfig),false);
  await assert.rejects(runCli(['install','--app-permissions','jxa'],{packageRoot:stable}),/requires --apply/);
  await assert.rejects(runCli(['install','--apply','--app-permissions','automatic'],{packageRoot:stable}),/explicit selection/);
});

test('macOS installer is repeatable and uninstall preserves unrelated Hooks, credentials and deduplication',{skip:process.platform!=='darwin'},t=>{
  const dir=mkdtempSync(join(tmpdir(),'notify-install-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const home=join(dir,'home'),state=join(dir,'state'),codex=join(home,'.codex');
  mkdirSync(codex,{recursive:true});mkdirSync(state,{recursive:true});
  const original={unrelated:{keep:true},hooks:{
    PreToolUse:[{matcher:'existing',hooks:[{type:'command',command:'unrelated-hook'}]},{matcher:'empty',hooks:[]}],
    PermissionRequest:[],PostToolUse:[],UserPromptSubmit:[],Interrupt:[]
  }};
  const hookPath=join(codex,'hooks.json');writeFileSync(hookPath,JSON.stringify(original));
  const configPath=join(state,'config.json');writeFileSync(configPath,JSON.stringify({stateDir:state,codexHomes:[codex]}));
  writeFileSync(join(state,'operator.json'),'preserve-credentials');writeFileSync(join(state,'notify.sqlite'),'preserve-deduplication');
  const label=`com.openclaw.codex-notify.test-${process.pid}`;
  // Redirect only OS discovery in these child processes; never change the real user's HOME or services.
  function run(script,apply,migrateFrom){
    const source=`import os from 'node:os';import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
      os.homedir=()=>${JSON.stringify(home)};const realExec=cp.execFileSync;
      cp.execFileSync=(file,args,options)=>file==='/bin/ps'?'':realExec(file,args,options);syncBuiltinESMExports();
      ${apply?"process.argv.push('--apply');":''}
      ${migrateFrom?`process.argv.push('--migrate-from',${JSON.stringify(migrateFrom)});`:''}
      await import(${JSON.stringify(pathToFileURL(resolve('scripts',script)).href)});`;
    return execFileSync(process.execPath,['--input-type=module','-e',source],{encoding:'utf8',env:{...process.env,
      CODEX_NOTIFY_CONFIG:configPath,CODEX_NOTIFY_STATE_DIR:state,CODEX_NOTIFY_SERVICE_LABEL:label,CODEX_NOTIFY_GATEWAY_URL:'wss://gateway.example:443'}});
  }
  run('install-notify.mjs',false);assert.deepEqual(JSON.parse(readFileSync(hookPath)),original);
  const plist=join(home,'Library','LaunchAgents',label+'.plist');assert.equal(existsSync(plist),false);
  run('install-notify.mjs',true);const first=JSON.parse(readFileSync(hookPath));
  assert.deepEqual(JSON.parse(readFileSync(configPath)).replies.allowedSenderIds,[]);
  run('install-notify.mjs',true);assert.deepEqual(JSON.parse(readFileSync(hookPath)),first);
  const legacyRoot=join(dir,'legacy checkout');
  const legacy=JSON.parse(JSON.stringify(first).replaceAll(resolve('src/notify-hook.mjs'),join(legacyRoot,'src','notify-hook.mjs')));
  writeFileSync(hookPath,JSON.stringify(legacy));
  run('install-notify.mjs',false,legacyRoot);assert.deepEqual(JSON.parse(readFileSync(hookPath)),legacy);
  run('install-notify.mjs',true,legacyRoot);assert.deepEqual(JSON.parse(readFileSync(hookPath)),first);
  assert.equal(first.hooks.PreToolUse.length,3);assert.ok(existsSync(plist));
  assert.ok(readdirSync(join(state,'backups')).length>=2);
  run('uninstall-notify.mjs',false);assert.ok(existsSync(plist));
  run('uninstall-notify.mjs',true);
  assert.deepEqual(JSON.parse(readFileSync(hookPath)),original);assert.equal(existsSync(plist),false);
  assert.equal(readFileSync(join(state,'operator.json'),'utf8'),'preserve-credentials');
  assert.equal(readFileSync(join(state,'notify.sqlite'),'utf8'),'preserve-deduplication');
});
