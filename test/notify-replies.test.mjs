import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NotifyStore } from '../src/notify-store.mjs';
import { ReplyRouter,recordDiscordDelivery } from '../src/notify-replies.mjs';
import { deliverDue } from '../src/notify-gateway.mjs';

const channelId='1000000000000000005',accountId='default',messageId='1000000000000000006';
const dest={gateway:'wss://gateway.example:443',channelId,accountId,nodeId:'fixture-node',nodeName:'Fixture Mac'};
function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'notify-replies-'));let now=2000000000000;
  const store=new NotifyStore(dir,{now:()=>now,delayMs:100});
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  return {store,dir,tick:ms=>{now+=ms;},router:new ReplyRouter(store,dest)};
}
function matter(store,{home='/native/home',session='session-one',title='Same title',turn='turn-old'}={}){
  const at=store.now()+1;
  store.ingest({id:`start-${home}-${session}-${turn}`,home,session,turn,at,type:'start',metadata:{title,cwd:'/work/project'}});
  store.ingest({id:`complete-${home}-${session}-${turn}`,home,session,turn,at:at+1,type:'complete',content:'result'});
  return store.db.prepare('SELECT r.id FROM reminders r JOIN sessions s ON s.key=r.session_key WHERE s.home=? AND s.id=? AND r.turn_id=?').get(home,session,turn).id;
}
function delivered(store,options={},id=messageId){const reminder=matter(store,options);store.claim(reminder);store.finish(reminder,{messageId:id,channel:'discord'},dest);return reminder;}
const inbound=(extra={})=>({messageId:'1000000000000000007',replyToId:messageId,channelId,accountId,senderId:'1000000000000000001',content:'请继续，原样保留 $() 和换行\n第二行',isBot:false,...extra});

test('delivery stores exact message-to-native-home/thread snapshots, not title matching',t=>{
  const {store,router}=fixture(t);delivered(store,{session:'session-one',home:'/home/a'});
  delivered(store,{session:'session-two',home:'/home/b'},'1000000000000000008');
  const a=router.resolve({messageId,channelId,accountId});
  const b=router.resolve({messageId:'1000000000000000008',channelId,accountId});
  assert.equal(a.target.threadId,'session-one');assert.equal(a.target.home,'/home/a');
  assert.equal(b.target.threadId,'session-two');assert.equal(b.target.home,'/home/b');
  assert.equal(a.target.title,b.target.title);assert.equal(a.target.nodeId,'fixture-node');
});
test('account/channel/gateway boundaries and unknown or forged references never guess',t=>{
  const {store,router}=fixture(t);delivered(store);
  assert.equal(router.resolve({messageId,channelId:'1000000000000000009',accountId}).matched,false);
  assert.equal(router.resolve({messageId,channelId,accountId:'different-bot'}).matched,false);
  assert.equal(new ReplyRouter(store,{...dest,gateway:'wss://another.example'}).resolve({messageId,channelId,accountId}).matched,false);
  assert.equal(router.resolve({messageId:'1000000000000000010',channelId,accountId}).matched,false);
  assert.throws(()=>router.resolve({messageId:'Same title',channelId,accountId}),{code:'INVALID_REFERENCE'});
});
test('old confirmed receipts need an explicit verified destination and can be indexed without resending',t=>{
  const {store,router}=fixture(t);const id=matter(store);store.claim(id);store.finish(id,{messageId,channel:'discord'});
  assert.equal(router.resolve({messageId,channelId,accountId}).matched,false);
  assert.equal(router.indexExisting({messageIds:[messageId]}).apply,false);
  assert.equal(router.resolve({messageId,channelId,accountId}).matched,false);
  router.indexExisting({messageIds:[messageId],apply:true});
  assert.equal(router.resolve({messageId,channelId,accountId}).target.reminderId,id);
  assert.equal(store.db.prepare('SELECT state FROM reminders WHERE id=?').get(id).state,'sent');
  assert.throws(()=>router.indexExisting({messageIds:['1000000000000000010'],apply:true}),{code:'MISSING_RECEIPT'});
});
test('a Discord message cannot be rebound to another reminder, even across a receipt retry',t=>{
  const {store}=fixture(t);delivered(store);const id=matter(store,{session:'other'});store.claim(id);
  assert.throws(()=>store.finish(id,{messageId,channel:'discord'},dest),{code:'DELIVERY_COLLISION'});
  assert.equal(store.db.prepare('SELECT state FROM reminders WHERE id=?').get(id).state,'sending');
});
test('duplicate inbound delivery preserves one raw message; edits and different senders conflict',t=>{
  const {store,router}=fixture(t);delivered(store);
  const a=router.prepare(inbound()),b=router.prepare(inbound());
  assert.equal(a.deliveryKey,b.deliveryKey);assert.equal(a.claimToken,b.claimToken);
  assert.equal(a.content,inbound().content);assert.equal(a.state,'prepared');
  assert.throws(()=>router.prepare(inbound({content:'edited'})),{code:'REPLY_CONFLICT'});
  assert.throws(()=>router.prepare(inbound({senderId:'1000000000000000011'})),{code:'REPLY_CONFLICT'});
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM discord_replies').get().n,1);
});
test('human, sender allowlist, attachment and archived-session checks fail before an input attempt',t=>{
  const {store,router}=fixture(t);delivered(store);
  assert.throws(()=>router.prepare(inbound({isBot:true})),{code:'NON_HUMAN_REPLY'});
  assert.throws(()=>router.prepare(inbound({isWebhook:true})),{code:'NON_HUMAN_REPLY'});
  assert.throws(()=>router.prepare(inbound({messageId})),{code:'INVALID_REPLY'});
  assert.throws(()=>router.prepare(inbound({attachments:[{url:'https://example.com/file'}]})),{code:'UNSUPPORTED_REPLY_MEDIA'});
  assert.throws(()=>new ReplyRouter(store,dest,{allowedSenderIds:[]}).prepare(inbound()),{code:'SENDER_DENIED'});
  store.session('/native/home','session-one',{archived:1});
  assert.throws(()=>router.prepare(inbound()),{code:'TARGET_ARCHIVED'});
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM discord_replies').get().n,0);
});
test('a prepared reply is rechecked after sender policy, destination or archival changes',t=>{
  const {store,router}=fixture(t);delivered(store);const r=router.prepare(inbound());
  assert.throws(()=>new ReplyRouter(store,{...dest,accountId:'different-account'}).get(r.deliveryKey),{code:'WRONG_REPLY_CONTEXT'});
  assert.throws(()=>new ReplyRouter(store,dest,{allowedSenderIds:[]}).begin(r.deliveryKey,r.claimToken,'baseline'),{code:'SENDER_DENIED'});
  store.session('/native/home','session-one',{archived:1});
  assert.throws(()=>router.begin(r.deliveryKey,r.claimToken,'baseline'),{code:'TARGET_ARCHIVED'});
});
test('one in-flight/uncertain write per home/thread survives restart; a different session can proceed',t=>{
  const {store,router,dir}=fixture(t);delivered(store);
  const a=router.prepare(inbound());router.begin(a.deliveryKey,a.claimToken,'baseline');
  const b=router.prepare(inbound({messageId:'1000000000000000012',content:'second'}));
  assert.throws(()=>router.begin(b.deliveryKey,b.claimToken,'baseline'),{code:'SESSION_REPLY_BUSY'});
  const reopened=new NotifyStore(dir);t.after(()=>reopened.close());
  const again=new ReplyRouter(reopened,dest);reopened.recover();
  assert.equal(again.prepare(inbound()).state,'sending');
  assert.throws(()=>again.begin(a.deliveryKey,a.claimToken,'baseline'),{code:'REPLY_NOT_SENDABLE'});
  router.uncertain(a.deliveryKey,a.claimToken);
  assert.throws(()=>router.begin(b.deliveryKey,b.claimToken,'baseline'),{code:'SESSION_REPLY_BUSY'});
  delivered(store,{session:'other',home:'/native/other'},'1000000000000000008');
  const c=router.prepare(inbound({messageId:'1000000000000000013',replyToId:'1000000000000000008'}));
  assert.equal(router.begin(c.deliveryKey,c.claimToken,'other-baseline').state,'sending');
});
test('confirmed input needs the exact native home/thread and a new turn; native cancellation stays separate',t=>{
  const {store,router}=fixture(t);const reminder=delivered(store);
  const a=router.prepare(inbound());router.begin(a.deliveryKey,a.claimToken,'baseline');
  const receipt={home:a.target.home,threadId:a.target.threadId,turnId:'new-turn',evidence:'Fixture UI send + independently read native turn'};
  assert.throws(()=>router.confirm(a.deliveryKey,a.claimToken,{...receipt,threadId:'wrong'}),{code:'INVALID_REPLY_RECEIPT'});
  assert.throws(()=>router.confirm(a.deliveryKey,a.claimToken,{...receipt,home:'/wrong/home'}),{code:'INVALID_REPLY_RECEIPT'});
  assert.throws(()=>router.confirm(a.deliveryKey,a.claimToken,{...receipt,turnId:'baseline'}),{code:'INVALID_REPLY_RECEIPT'});
  router.uncertain(a.deliveryKey,a.claimToken);assert.equal(router.confirm(a.deliveryKey,a.claimToken,receipt).state,'forwarded');
  assert.equal(router.prepare(inbound()).state,'forwarded');
  assert.throws(()=>router.begin(a.deliveryKey,a.claimToken,'new-turn'),{code:'REPLY_NOT_SENDABLE'});
  assert.equal(store.db.prepare('SELECT state FROM reminders WHERE id=?').get(reminder).state,'sent');
});
test('delivery dispatcher indexes real receipt identities without changing delay or reminder content',async t=>{
  const {store,router,tick}=fixture(t);matter(store);tick(200);
  const calls=[];const sender={configured:()=>true,destination:()=>dest,send:async(row,message)=>{calls.push(message);return{messageId,channel:'discord'};}};
  assert.deepEqual(await deliverDue(store,sender,{device:'Fixture Mac',graceMs:0}),{sent:1});
  assert.equal(router.resolve({messageId,channelId,accountId}).matched,true);
  assert.match(calls[0].message,/Fixture Mac/);assert.ok(!calls[0].message.includes('session-one'));
});
