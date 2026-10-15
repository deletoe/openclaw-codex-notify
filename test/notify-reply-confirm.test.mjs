import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NotifyStore } from '../src/notify-store.mjs';
import { ReplyRouter } from '../src/notify-replies.mjs';
import { compareReplyText,confirmReplyDelivery,replyErrorOutput } from '../src/notify-reply-confirm.mjs';

function fixture(t,{content='收到',observed=content,transport='openclaw-computer-use',source='app',taskStatus='completed'}={}) {
  const dir=mkdtempSync(join(tmpdir(),'reply-confirm-'));const store=new NotifyStore(dir,{now:()=>2000000000000});
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const home='/native/home',threadId='11111111-2222-4333-8444-555555555555';
  store.ingest({id:'start',type:'start',home,session:threadId,turn:'baseline',at:2000000000001,metadata:{cwd:'/project',title:'Fixture'}});
  store.ingest({id:'complete',type:'complete',home,session:threadId,turn:'baseline',at:2000000000002,content:'done'});
  const id=store.list()[0].id,destination={gateway:'wss://example.com',channelId:'1000000000000000001',accountId:'default'};
  store.claim(id);store.finish(id,{channel:'discord',messageId:'1000000000000000002'},destination);
  const router=new ReplyRouter(store,destination),r=router.prepare({messageId:'1000000000000000003',replyToId:'1000000000000000002',senderId:'1000000000000000004',channelId:destination.channelId,accountId:'default',content});
  router.begin(r.deliveryKey,r.claimToken,'baseline',{transport});router.uncertain(r.deliveryKey,r.claimToken,'Previously failed registration');
  const native={threadId,turns:[{turnId:'baseline',status:'completed',messages:[]},{turnId:'new-user-turn',status:taskStatus,messages:[{role:'user',text:observed,truncated:false}]}]};
  const receipt={home,threadId,turnId:'new-user-turn',evidence:'Fixture input observed; native persisted turn independently read.'};
  const args={router,key:r.deliveryKey,token:r.claimToken,receipt,native,sourceRouting:{kind:source}};
  return {store,router,r,native,receipt,args,confirm:()=>confirmReplyDelivery(args)};
}

test('text match is exact first and accepts only one additional LF for the explicit App mode',()=>{
  assert.equal(compareReplyText('a\n','a\n',{allowAppTrailingLf:true}).kind,'exact');
  for(const original of ['收到','a\nb','a\n',' a ']){
    const result=compareReplyText(original,original+'\n',{allowAppTrailingLf:true});
    assert.equal(result.kind,'app-added-single-lf');assert.equal(result.observedBytes,result.expectedBytes+1);assert.equal(result.extraSuffixHex,'0a');
    assert.notEqual(result.expectedSha256,result.observedSha256);
  }
});
test('no trim: spaces, tabs, CRLF, internal edits, removed or multiple extra newlines remain different',()=>{
  for(const [a,b] of [['a',' a'],['a','a '],['a','a\t'],['a','a\r\n'],['a','a\n\n'],['a\n','a'],['a\nb','ab\n'],['a\r\nb','a\nb'],['é','e\u0301']]){
    assert.equal(compareReplyText(a,b,{allowAppTrailingLf:true}).matched,false,JSON.stringify([a,b]));
  }
  assert.equal(compareReplyText('a','a\n').matched,false);
});
test('App LF recovery registers existing input, preserves both hashes and never changes original text',t=>{
  const f=fixture(t,{observed:'收到\n'});const result=f.confirm();
  assert.equal(result.deliveryStatus,'delivered');assert.equal(result.registrationStatus,'registered');assert.equal(result.taskStatus,'completed');
  assert.equal(result.inputRetryAllowed,false);assert.equal(result.receipt.textMatch.kind,'app-added-single-lf');
  assert.equal(f.router.get(f.r.deliveryKey).content,'收到');assert.equal(f.native.turns[1].messages[0].text,'收到\n');
});
test('CLI and unknown-source inputs do not inherit App-only LF tolerance',t=>{
  for(const mode of [{transport:'codex-cli-resume',source:'cli'},{transport:'openclaw-computer-use',source:'unknown'}]){
    const f=fixture(t,{...mode,observed:'收到\n'});
    assert.throws(f.confirm,{code:'REPLY_TEXT_UNVERIFIED'});assert.equal(f.router.get(f.r.deliveryKey).state,'uncertain');
  }
  const exact=fixture(t,{transport:'codex-cli-resume',source:'cli'});assert.equal(exact.confirm().registrationStatus,'registered');
});
test('registration failure reports delivered separately from pending registration and task failure',t=>{
  const f=fixture(t,{taskStatus:'failed'}),real=f.router.confirm.bind(f.router);
  f.router.confirm=()=>{throw Object.assign(new Error('Fixture database write failure'),{code:'SQLITE_BUSY'});};
  let failure;try{f.confirm();}catch(e){failure=e;}
  const output=replyErrorOutput(failure);
  assert.equal(output.code,'REPLY_REGISTRATION_FAILED');assert.equal(output.deliveryStatus,'delivered');assert.equal(output.registrationStatus,'pending');
  assert.equal(output.taskStatus,'failed');assert.equal(output.inputRetryAllowed,false);assert.equal(output.registrationRetryAllowed,true);
  assert.equal(f.router.get(f.r.deliveryKey).state,'uncertain');
  f.router.confirm=real;assert.equal(f.confirm().state,'forwarded');
});
test('registration retry is idempotent and cannot bind another new turn',t=>{
  const f=fixture(t);let calls=0;const real=f.router.confirm.bind(f.router);f.router.confirm=(...args)=>{calls++;return real(...args);};
  f.confirm();const retry=f.confirm();assert.equal(retry.alreadyRegistered,true);assert.equal(retry.registrationStatus,'registered');assert.equal(calls,1);
  assert.throws(()=>confirmReplyDelivery({...f.args,receipt:{...f.receipt,turnId:'different'}}),{code:'REPLY_ALREADY_REGISTERED'});
  assert.equal(f.router.get(f.r.deliveryKey).receipt.turnId,'new-user-turn');
});
test('wrong home/thread, old turn, missing baseline, absent user text or truncated text cannot register',t=>{
  for(const alter of [
    f=>{f.args.receipt={...f.receipt,home:'/wrong'};},
    f=>{f.args.native={...f.native,threadId:'wrong'};},
    f=>{f.args.receipt={...f.receipt,turnId:'baseline'};},
    f=>{f.native.turns=f.native.turns.slice(1);},
    f=>{f.native.turns[1].messages=[{role:'assistant',text:'收到',truncated:false}];},
    f=>{f.native.turns[1].messages[0].truncated=true;}
  ]){const f=fixture(t);alter(f);assert.throws(f.confirm);assert.equal(f.router.get(f.r.deliveryKey).state,'uncertain');}
});
test('known delivery is independent of whether the new task is running or finished',t=>{
  for(const status of ['inProgress','completed','failed','interrupted']){const f=fixture(t,{taskStatus:status});const r=f.confirm();assert.equal(r.deliveryStatus,'delivered');assert.equal(r.taskStatus,status);}
});
