import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync,realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NotifyStore } from '../src/notify-store.mjs';
import { ReplyRouter } from '../src/notify-replies.mjs';
import { sendCliReply } from '../src/notify-cli-reply.mjs';

const uuid='11111111-2222-4333-8444-555555555555';
function fixture(t,{source='cli',status='completed',returnedThread=uuid,exitCode=0,persist=true,afterSource=source,hang=false}={}){
  const root=mkdtempSync(join(tmpdir(),'notify-cli-input-'));const home=join(root,'native-home'),cwd=join(root,'project');
  mkdirSync(home);mkdirSync(cwd);const store=new NotifyStore(join(root,'state'),{now:()=>2000000000000});
  t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
  const destination={gateway:'wss://example.com',channelId:'1000000000000000001',accountId:'default'};
  const router=new ReplyRouter(store,destination);
  store.ingest({id:'start',type:'start',home,session:uuid,turn:'old',at:2000000000001,metadata:{cwd,title:'Fixture CLI'}});
  store.ingest({id:'complete',type:'complete',home,session:uuid,turn:'old',at:2000000000002,content:'old'});
  const id=store.list()[0].id;store.claim(id);store.finish(id,{channel:'discord',messageId:'1000000000000000002'},destination);
  const reply=router.prepare({messageId:'1000000000000000003',replyToId:'1000000000000000002',senderId:'1000000000000000004',channelId:destination.channelId,accountId:'default',content:'原文 $() `quoted`\n第二行'});
  const record=join(root,'cli-call.json'),binary=join(root,'fake-codex');
  writeFileSync(binary,`#!${process.execPath}\nconst fs=require('node:fs');let text='';process.stdin.setEncoding('utf8');process.stdin.on('data',d=>text+=d);process.stdin.on('end',()=>{fs.writeFileSync(${JSON.stringify(record)},JSON.stringify({args:process.argv.slice(2),text,home:process.env.CODEX_HOME,cwd:process.cwd(),envKeys:Object.keys(process.env)}));process.stdout.write(JSON.stringify({type:'thread.started',thread_id:${JSON.stringify(returnedThread)}})+'\\n');${hang?'setInterval(()=>{},10000);':`process.exitCode=${exitCode};`}});\n`,{mode:0o700});
  const inspector={inspect:async()=>{
    const after=existsSync(record),kind=after?afterSource:source;
    return {sourceRouting:{kind,evidence:{source:kind==='app'?'vscode':'cli',originator:kind==='app'?'Codex Desktop':'codex_cli_rs'}},native:{threadId:uuid,turns:[{turnId:'old',status,messages:[]},...(after&&persist?[{turnId:'new',status:exitCode===0?'completed':'failed',messages:[{role:'user',text:reply.content,truncated:false}]}]:[])]}};
  }};
  const run=(extra={})=>sendCliReply({router,key:reply.deliveryKey,token:reply.claimToken,baselineTurnId:'old',binary,inspector,...extra});
  return {root,home,cwd,store,router,reply,record,run};
}
test('CLI-origin reply resumes explicit UUID with exact native home/cwd and raw stdin, without policy bypass flags',async t=>{
  const f=fixture(t);process.env.CODEX_APP_TOOLS_PIPE_PATH='do-not-forward';
  try{
    const result=await f.run();assert.equal(result.state,'forwarded');assert.equal(result.inputTransport,'codex-cli-resume');
    assert.equal(result.receipt.threadId,uuid);assert.equal(result.receipt.turnId,'new');
    const call=JSON.parse(readFileSync(f.record));assert.deepEqual(call.args,['exec','resume','--json',uuid,'-']);
    assert.equal(call.text,f.reply.content);assert.equal(call.home,f.home);assert.equal(realpathSync(call.cwd),realpathSync(f.cwd));
    assert.ok(!call.envKeys.includes('CODEX_APP_TOOLS_PIPE_PATH'));
    await assert.rejects(f.run(),{code:'REPLY_NOT_SENDABLE'});
  }finally{delete process.env.CODEX_APP_TOOLS_PIPE_PATH;}
});
test('App and unknown sources are refused before begin or spawn; no CLI fallback',async t=>{
  for(const source of ['app','unknown','ide']){
    const f=fixture(t,{source});await assert.rejects(f.run(),{code:'NOT_A_CLI_SESSION'});
    assert.equal(f.router.get(f.reply.deliveryKey).state,'prepared');assert.equal(existsSync(f.record),false);
  }
});
test('active turns, stale baselines and missing CLI binaries are rejected before dispatch',async t=>{
  const active=fixture(t,{status:'inProgress'});await assert.rejects(active.run(),{code:'SESSION_BUSY'});assert.equal(existsSync(active.record),false);
  const f=fixture(t);await assert.rejects(f.run({baselineTurnId:'wrong'}),{code:'BASELINE_CHANGED'});
  await assert.rejects(f.run({binary:join(f.root,'missing-cli')}),{code:'CLI_BINARY_MISSING'});
  assert.equal(f.router.get(f.reply.deliveryKey).state,'prepared');
});
test('new unrelated thread, missing persisted input and changed source become uncertain and never retry',async t=>{
  for(const options of [{returnedThread:'66666666-2222-4333-8444-555555555555'},{persist:false},{afterSource:'app'}]){
    const f=fixture(t,options);await assert.rejects(f.run());
    assert.equal(f.router.get(f.reply.deliveryKey).state,'uncertain');await assert.rejects(f.run(),{code:'REPLY_NOT_SENDABLE'});
  }
});
test('a persisted input may be delivered even if the task itself later fails',async t=>{
  const f=fixture(t,{exitCode:1});const r=await f.run();assert.equal(r.state,'forwarded');assert.equal(r.execution.taskCompleted,false);assert.equal(r.receipt.turnStatus,'failed');
});
test('a timed out CLI runner stays uncertain rather than silently replaying the human prompt',async t=>{
  const f=fixture(t,{hang:true});await assert.rejects(f.run({timeoutMs:150}),{code:'CLI_REPLY_TIMEOUT'});
  assert.equal(f.router.get(f.reply.deliveryKey).state,'uncertain');await assert.rejects(f.run(),{code:'REPLY_NOT_SENDABLE'});
});
test('CLI registration failure preserves delivered facts and cannot trigger a second input',async t=>{
  const f=fixture(t);f.router.confirm=()=>{throw Object.assign(new Error('fixture write failure'),{code:'SQLITE_BUSY'});};
  await assert.rejects(f.run(),e=>e.code==='REPLY_REGISTRATION_FAILED'&&e.deliveryStatus==='delivered'&&e.registrationStatus==='pending'&&e.taskStatus==='completed'&&e.inputRetryAllowed===false);
  assert.equal(f.router.get(f.reply.deliveryKey).state,'uncertain');
  await assert.rejects(f.run(),{code:'REPLY_NOT_SENDABLE'});
});
