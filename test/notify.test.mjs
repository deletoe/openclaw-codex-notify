import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, appendFileSync, renameSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { NotifyStore, formatReminder, toolSignature } from '../src/notify-store.mjs';
import { NativeSource, consumeRecord, consumeHook } from '../src/notify-source.mjs';
import { GatewaySender, deliverDue } from '../src/notify-gateway.mjs';
import { discoverHomes } from '../src/notify-homes.mjs';

const delay = 20 * 60_000;
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(),'codex-notify-')); let now = 100_000;
  const store = new NotifyStore(dir,{ now:()=>now });
  t.after(()=>{try{store.close()}catch{} rmSync(dir,{recursive:true,force:true});});
  let seq=0;
  return {dir,store,now:()=>now,set:v=>now=v,
    emit: e=>store.ingest({ id:`e${++seq}`,home:'/codex',session:'s1',at:now,turn:'t1',...e })};
}
test('20-minute deadline; replies cancel only the same session, new turns create new matters',t=>{
  const f=fixture(t); f.emit({type:'complete',content:'完成'});
  f.set(f.now()+delay-1); assert.equal(f.store.due().length,0);
  f.emit({type:'reply',session:'other'}); f.set(f.now()+1); assert.equal(f.store.due().length,1);
  f.emit({type:'reply'}); assert.equal(f.store.due().length,0);
  f.set(f.now()+1);f.emit({type:'start',turn:'t2'});f.set(f.now()+1);f.emit({type:'complete',turn:'t2',content:'第二轮'});
  f.set(f.now()+delay);assert.equal(f.store.due().length,1);
  assert.equal(f.store.due()[0].turn_id,'t2');
});
test('parallel approvals resolve by exact request; late PermissionRequest cannot resurrect a handled item',t=>{
  const f=fixture(t);
  for(const id of ['a','b']) { f.emit({type:'tool',request:id,signature:id});f.emit({type:'wait',kind:'approval',signature:id,content:id}); }
  f.emit({type:'resolved',request:'a'});f.set(f.now()+delay);
  assert.deepEqual(f.store.due().map(x=>x.request_id),['b']);
  f.emit({type:'wait',kind:'approval',signature:'a',content:'late'});
  assert.equal(f.store.list().filter(x=>x.state==='pending').length,1);
});
test('out-of-order events, replay and explicit acknowledgement never reopen a matter',t=>{
  const f=fixture(t);f.emit({type:'reply',at:f.now()+100});
  f.emit({type:'complete',at:f.now()+50,content:'late result'});
  assert.equal(f.store.list()[0].state,'cancelled');
  f.emit({type:'complete',session:'s2',content:'another'});
  const id=f.store.list().find(x=>x.session_id==='s2').id;
  f.store.acknowledge(id);f.emit({type:'complete',session:'s2',content:'same matter'});
  assert.equal(f.store.list().filter(x=>x.session_id==='s2').length,1);
  assert.equal(f.store.list().find(x=>x.id===id).state,'cancelled');
});
test('actual native completion is authoritative; old history and temporary Stop are ignored',t=>{
  const f=fixture(t);
  const record=(type,p,at=f.now())=>consumeRecord(f.store,'/codex','s1',{timestamp:new Date(at).toISOString(),type,payload:p},`native-${type}-${at}`);
  record('event_msg',{type:'task_started',turn_id:'t1'},f.now()-200);
  record('event_msg',{type:'task_complete',turn_id:'old',last_agent_message:'old'},f.now()-100);
  assert.equal(f.store.list().length,0);
  consumeHook(f.store,'/codex',{session_id:'s1',turn_id:'t1',hook_event_name:'Stop'},'stop',f.now());
  assert.equal(f.store.list().length,0);
  record('event_msg',{type:'task_complete',turn_id:'t1',last_agent_message:'real'});
  assert.equal(f.store.list().length,1);
});
test('async questions survive display acknowledgement and turn completion; user reply cancels them',t=>{
  const f=fixture(t);f.emit({type:'start'});
  const native=(payload,id)=>consumeRecord(f.store,'/codex','s1',{timestamp:new Date(f.now()).toISOString(),type:'response_item',payload},id);
  native({type:'function_call',name:'request_user_input_async',call_id:'q',arguments:JSON.stringify({questions:[{title:'选哪个？',options:['A','B']}]})},'call');
  native({type:'function_call_output',call_id:'q',output:'{"accepted":true}'},'accepted');
  f.emit({type:'complete',content:'等待回答'}); f.set(f.now()+delay);
  assert.deepEqual(f.store.due().map(x=>x.kind),['input']);
  assert.match(f.store.due()[0].content,/A \/ B/);
  f.emit({type:'reply'});assert.equal(f.store.due().length,0);
});
test('synchronous questions resolve on tool output, interruption cancels all pending turn items',t=>{
  const f=fixture(t);f.emit({type:'start'});
  for(const id of ['q1','q2']) {
    f.emit({type:'tool',request:id});f.emit({type:'wait',kind:'input',request:id,content:'问题'});
  }
  consumeRecord(f.store,'/codex','s1',{timestamp:new Date(f.now()).toISOString(),type:'response_item',payload:{type:'function_call_output',call_id:'q1',output:'answer'}},'output');
  f.emit({type:'stop'});assert.ok(f.store.list().every(x=>x.state==='cancelled'));
});
test('hooks map approval to pre-tool call id, PostToolUse cancels it, delayed pre hook does not undo resolution',t=>{
  const f=fixture(t);f.emit({type:'start'});
  const h={session_id:'s1',turn_id:'t1',tool_name:'Bash',tool_input:{command:'echo test'}};
  consumeHook(f.store,'/codex',{...h,hook_event_name:'PreToolUse',tool_use_id:'call'},'pre',f.now());
  consumeHook(f.store,'/codex',{...h,hook_event_name:'PermissionRequest'},'approval',f.now());
  assert.equal(f.store.db.prepare('SELECT request_id FROM reminders').get().request_id,'call');
  consumeHook(f.store,'/codex',{...h,hook_event_name:'PostToolUse',tool_use_id:'call'},'post',f.now());
  consumeHook(f.store,'/codex',{...h,hook_event_name:'PreToolUse',tool_use_id:'call'},'late-pre',f.now());
  consumeHook(f.store,'/codex',{...h,hook_event_name:'PermissionRequest'},'late-approval',f.now());
  assert.ok(f.store.list().every(x=>x.state==='cancelled'));
});
test('archive cancellation; once sent or ambiguous after a crash, no automatic second delivery',async t=>{
  const f=fixture(t); f.emit({type:'complete',content:'done'}); f.set(f.now()+delay+5000);
  let calls=0;const sender={configured:()=>true,send:async()=>{calls++;return {messageId:'discord-1'}}};
  await deliverDue(f.store,sender,{device:'Mac'});await deliverDue(f.store,sender,{device:'Mac'});
  assert.equal(calls,1);
  f.emit({type:'complete',turn:'t2',content:'new'});f.set(f.now()+delay+5000);
  const r=f.store.due()[0];f.store.claim(r.id);f.store.recover();
  await deliverDue(f.store,sender,{device:'Mac'});assert.equal(calls,1);
  f.emit({type:'complete',session:'s3',content:'archived'});f.store.session('/codex','s3',{archived:1});
  assert.equal(f.store.list().find(x=>x.session_id==='s3').state,'cancelled');
});
test('pre-send reconciliation catches a reply arriving after the due query',async t=>{
  const f=fixture(t);f.emit({type:'complete',content:'done'});f.set(f.now()+delay+5000);
  let sent=0;
  await deliverDue(f.store,{configured:()=>true,send:async()=>{sent++}},{device:'Mac',beforeSend:async()=>f.emit({type:'reply'})});
  assert.equal(sent,0);
});
test('a proven connection failure before dispatch is retried after cooldown, then sent only once',async t=>{
  const f=fixture(t);f.emit({type:'complete',content:'done'});f.set(f.now()+delay+5000);
  let calls=0;const sender={configured:()=>true,send:async()=>{if(++calls===1)throw Object.assign(new Error('offline before send'),{beforeDispatch:true});return {messageId:'receipt'};}};
  await deliverDue(f.store,sender,{device:'Mac'});assert.equal(f.store.list()[0].state,'pending');
  await deliverDue(f.store,sender,{device:'Mac'});assert.equal(calls,1);
  f.set(f.now()+65000);await deliverDue(f.store,sender,{device:'Mac'});await deliverDue(f.store,sender,{device:'Mac'});
  assert.equal(calls,2);assert.equal(f.store.list()[0].state,'sent');
});
test('unconfigured gateway leaves pending items intact; unknown outcome does not retry',async t=>{
  const f=fixture(t);f.emit({type:'complete',content:'done'});f.set(f.now()+delay+5000);
  await deliverDue(f.store,{configured:()=>false},{device:'Mac'});assert.equal(f.store.due().length,1);
  let n=0;const sender={configured:()=>true,send:async()=>{n++;throw new Error('timeout')}};
  await deliverDue(f.store,sender,{device:'Mac'});await deliverDue(f.store,sender,{device:'Mac'});
  assert.equal(n,1);assert.equal(f.store.list()[0].state,'uncertain');
});
test('global scanner covers multiple projects, UTF-8 partial writes, restart, and archival',t=>{
  const f=fixture(t);const home=join(f.dir,'codex');mkdirSync(join(home,'sessions'),{recursive:true});
  const db=new DatabaseSync(join(home,'state_5.sqlite'));
  db.exec('CREATE TABLE threads(id TEXT,rollout_path TEXT,cwd TEXT,title TEXT,name TEXT,archived INTEGER)');
  const ids=['11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222'];
  const files=ids.map(id=>join(home,'sessions',`rollout-${id}.jsonl`));
  const line=(p)=>JSON.stringify({timestamp:new Date(f.now()).toISOString(),type:'event_msg',payload:p})+'\n';
  for(let i=0;i<2;i++){writeFileSync(files[i],line({type:'task_started',turn_id:'t1'}));db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,0)').run(ids[i],files[i],`/project-${i}`,'title',`session-${i}`);}
  const source=new NativeSource(f.store,[home]);source.scan();
  assert.equal(source.health.errors.length,0);
  const completed=line({type:'task_complete',turn_id:'t1',last_agent_message:'中文完成✅'});
  appendFileSync(files[0],completed.slice(0,-3));source.scan({discover:false});assert.equal(f.store.list().length,0);
  appendFileSync(files[0],completed.slice(-3));appendFileSync(files[1],completed);source.scan({discover:false});
  assert.equal(f.store.list().length,2);assert.deepEqual(new Set(f.store.list().map(x=>x.title)),new Set(['session-0','session-1']));
  const restarted=new NativeSource(f.store,[home]);restarted.scan();assert.equal(f.store.list().length,2);
  db.prepare('UPDATE threads SET archived=1 WHERE id=?').run(ids[0]);restarted.discover();
  assert.equal(f.store.list().filter(x=>x.state==='cancelled').length,1);
  db.prepare('DELETE FROM threads WHERE id=?').run(ids[1]);restarted.discover();
  assert.ok(f.store.list().every(x=>x.state==='cancelled'));db.close();
});
test('hook collector appends private local events and returns neutral JSON',t=>{
  const f=fixture(t);const input={session_id:'s1',hook_event_name:'UserPromptSubmit',prompt:'not stored',tool_response:'not stored'};
  const output=execFileSync(process.execPath,['src/notify-hook.mjs'],{input:JSON.stringify(input),encoding:'utf8',env:{...process.env,CODEX_NOTIFY_STATE_DIR:f.dir,CODEX_HOME:'/codex'}});
  assert.deepEqual(JSON.parse(output),{});
  const source=new NativeSource(f.store,['/codex']);source.drainHooks(join(f.dir,'spool'));
  assert.equal(readdirSync(join(f.dir,'spool')).length,0);
});
test('compact single-line metadata, safe mentions, long body attached in full',()=>{
  const row={id:'a'.repeat(64),title:'name\n@everyone',session_id:'s1',kind:'approval',content:'正文'.repeat(2000)};
  const result=formatReminder(row,'Mac\nBook');
  assert.equal(result.message.split('\n')[0].includes('\r'),false);assert.ok(result.message.length<2000);
  assert.ok(!result.message.includes('@everyone'));assert.equal(Buffer.from(result.buffer,'base64').toString(),row.content);
});
test('Gateway sender uses send with stable idempotency, no token argv, and the exact Discord channel',async()=>{
  assert.equal(new GatewaySender({enabled:false,channelId:'1000000000000000001',useDefaultConfig:true}).configured(),false);
  let captured;
  const sender=new GatewaySender({channelId:'1000000000000000001',configPath:'/private/config.json'}, {run:(bin,args,opts,cb)=>{captured={bin,args,opts};cb(null,'{"messageId":"m1"}');}});
  const receipt=await sender.send({id:'stable'}, {message:'hello'});assert.equal(receipt.messageId,'m1');
  assert.deepEqual(captured.args.slice(0,3),['gateway','call','send']);
  const p=JSON.parse(captured.args.at(-1));assert.equal(p.to,'channel:1000000000000000001');assert.equal(p.idempotencyKey,'codex-notify:stable');
  assert.ok(!captured.args.includes('--token'));assert.equal(captured.opts.env.OPENCLAW_CONFIG_PATH,'/private/config.json');
});

test('identical parallel commands still produce separate approval matters',t=>{
  const f=fixture(t);f.emit({type:'start'});
  const sig=toolSignature('Bash',{command:'same'});
  for(const id of ['a','b'])f.emit({type:'tool',request:id,signature:sig});
  f.emit({type:'wait',kind:'approval',signature:sig,content:'same'});
  f.emit({type:'wait',kind:'approval',signature:sig,content:'same'});
  assert.equal(f.store.list().length,2);
  f.emit({type:'resolved',request:'a'});assert.equal(f.store.list().filter(x=>x.state==='pending').length,1);
});
test('paginated SQLite-only sessions complete, reply, fail, and resolve approved running commands without JSONL',t=>{
  const f=fixture(t);const home=join(f.dir,'native');mkdirSync(home);
  const state=new DatabaseSync(join(home,'state_5.sqlite'));
  state.exec('CREATE TABLE threads(id TEXT,rollout_path TEXT,cwd TEXT,title TEXT,name TEXT,archived INTEGER)');
  state.prepare('INSERT INTO threads VALUES(?,?,?,?,?,0)').run('s1','/missing.jsonl','/any-project','title','native session');
  const db=new DatabaseSync(join(home,'thread_history_1.sqlite'));
  db.exec(`CREATE TABLE thread_turns(thread_id TEXT,turn_id TEXT,status TEXT,error_json TEXT,started_at INTEGER,completed_at INTEGER,final_agent_item_id TEXT);
    CREATE TABLE thread_items(thread_id TEXT,turn_id TEXT,item_id TEXT,created_at_ms INTEGER,item_json TEXT,item_type TEXT);`);
  f.set(f.now()+10_000);
  db.prepare('INSERT INTO thread_turns VALUES(?,?,?,?,?,?,?)').run('s1','t1','completed',null,105,110,'final');
  db.prepare('INSERT INTO thread_items VALUES(?,?,?,?,?,?)').run('s1','t1','final',110000,JSON.stringify({type:'agentMessage',text:'数据库里的完整结果'}),'agentMessage');
  const source=new NativeSource(f.store,[home]);source.scan();assert.equal(source.health.errors.length,0);
  assert.equal(f.store.list()[0].title,'native session');
  assert.equal(f.store.db.prepare('SELECT content FROM reminders').get().content,'数据库里的完整结果');
  db.prepare('INSERT INTO thread_items VALUES(?,?,?,?,?,?)').run('s1','t2','reply',111000,'{"type":"userMessage"}','userMessage');
  f.set(112000);source.scan();assert.equal(f.store.list()[0].state,'cancelled');
  db.prepare('INSERT INTO thread_turns VALUES(?,?,?,?,?,?,?)').run('s1','t2','failed','{"message":"failed for real"}',112,113,null);
  f.set(114000);source.scan();assert.ok(f.store.list().some(x=>x.kind==='failed'&&x.state==='pending'));
  f.emit({home,session:'s1',type:'tool',turn:'t3',request:'cmd'});
  f.emit({home,session:'s1',type:'wait',turn:'t3',kind:'approval',request:'cmd',content:'approval'});
  db.prepare('INSERT INTO thread_items VALUES(?,?,?,?,?,?)').run('s1','t3','cmd',114000,'{"status":"inProgress","processId":"running"}','commandExecution');
  source.scan();assert.equal(f.store.list().find(x=>x.kind==='approval').state,'cancelled');
  db.close();state.close();
});
test('old zstd archives are not parsed as JSON, new process CODEX_HOME directories are discovered',t=>{
  const f=fixture(t);const home=join(f.dir,'custom home');mkdirSync(home);
  const db=new DatabaseSync(join(home,'state_5.sqlite'));
  db.exec('CREATE TABLE threads(id TEXT,rollout_path TEXT,cwd TEXT,title TEXT,archived INTEGER)');
  const zst=join(home,'old.jsonl.zst');writeFileSync(zst,Buffer.from('28b52ffd','hex'));
  db.prepare('INSERT INTO threads VALUES(?,?,?,?,0)').run('s1',zst,'/project','old');
  const source=new NativeSource(f.store,[home]);source.scan();assert.equal(source.health.errors.length,0);
  const homes=discoverHomes(['/default'],{listProcesses:()=>`/Applications/ChatGPT.app/codex app-server HOME=/Users/test CODEX_HOME=${home} PATH=/usr/bin\n/bin/zsh not-codex CODEX_HOME=/ignored`});
  assert.deepEqual(homes,['/default',home]);db.close();
});
test('JSONL file replacement replays safely without duplicate reminders',t=>{
  const f=fixture(t);const path=join(f.dir,'rollout.jsonl');const source=new NativeSource(f.store,[]);
  const line=JSON.stringify({timestamp:new Date(f.now()).toISOString(),type:'event_msg',payload:{type:'task_complete',turn_id:'t1',last_agent_message:'done'}})+'\n';
  writeFileSync(path,line);source.read(path,{home:'/codex',session:'s1'});
  renameSync(path,`${path}.old`);writeFileSync(path,line);source.read(path,{home:'/codex',session:'s1'});
  assert.equal(f.store.list().length,1);
});
