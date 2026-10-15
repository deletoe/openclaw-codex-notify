import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,appendFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {NotifyStore} from '../src/notify-store.mjs';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
test('actual daemon reads global files, dispatches send once, and retains its receipt across restart',{timeout:10000},async t=>{
  const root=mkdtempSync(join(tmpdir(),'notify-daemon-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const home=join(root,'home');mkdirSync(join(home,'sessions'),{recursive:true});
  const state=join(root,'state');const store=new NotifyStore(state);
  store.db.prepare('UPDATE meta SET value=? WHERE key=?').run(String(Date.now()-3600_000),'startedAt');store.close();
  const calls=join(root,'calls.jsonl');const binary=join(root,'fake-openclaw');
  writeFileSync(binary,`#!${process.execPath}\nconst fs=require('node:fs');fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(process.argv.slice(2))+'\\n');process.stdout.write('{"messageId":"mock-discord-receipt"}');\n`,{mode:0o700});
  const configPath=join(root,'config.json');writeFileSync(configPath,JSON.stringify({stateDir:state,codexHomes:[home],pollMs:50,device:'Test Mac',gateway:{binary,configPath:join(root,'gateway.json'),channelId:'1000000000000000001'}}));
  const id='11111111-1111-1111-1111-111111111111';const rollout=join(home,'sessions',`rollout-${id}.jsonl`);
  const record=(p,at)=>JSON.stringify({timestamp:new Date(at).toISOString(),type:'event_msg',payload:p})+'\n';
  const at=Date.now()-21*60_000;
  writeFileSync(rollout,record({type:'task_started',turn_id:'t1'},at-1000)+record({type:'task_complete',turn_id:'t1',last_agent_message:'test body'},at));
  const start=()=>spawn(process.execPath,['src/notify.mjs','run'],{cwd:resolve('.'),env:{...process.env,CODEX_NOTIFY_CONFIG:configPath},stdio:['ignore','ignore','pipe']});
  let child=start();t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL')});
  for(let i=0;i<80&&!existsSync(calls);i++)await sleep(50);
  assert.ok(existsSync(calls),'daemon should issue a send using the fake CLI');
  const args=JSON.parse(readFileSync(calls,'utf8').trim());assert.deepEqual(args.slice(0,3),['gateway','call','send']);
  const payload=JSON.parse(args.at(-1));assert.equal(payload.to,'channel:1000000000000000001');assert.match(payload.message,/Test Mac/);
  child.kill('SIGTERM');await once(child,'exit');child=start();
  // Restart must neither reset the deadline nor re-send the same matter.
  await sleep(300);assert.equal(readFileSync(calls,'utf8').trim().split('\n').length,1);
  const now=Date.now();appendFileSync(rollout,record({type:'task_started',turn_id:'t2'},now)+record({type:'task_complete',turn_id:'t2',last_agent_message:'new'},now+1)+record({type:'user_message',message:'handled'},now+2));
  await sleep(200);child.kill('SIGTERM');await once(child,'exit');
  const check=new NotifyStore(state);assert.ok(check.list().some(r=>r.state==='sent'));
  assert.equal(check.db.prepare("SELECT state FROM reminders WHERE turn_id='t2'").get().state,'cancelled');check.close();
});
