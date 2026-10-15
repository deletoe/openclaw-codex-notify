import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { mkdtempSync, rmSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createPublicKey, verify, generateKeyPairSync, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { buildDeviceAuthPayloadV3 } from '@openclaw/gateway-client';
import { NotifyGatewayClient, OperatorCredentials } from '../src/notify-client.mjs';
import { GatewaySender } from '../src/notify-gateway.mjs';
import { NOTIFY_SCOPES } from '../src/notify-pairing.mjs';

test('operator client can reuse the node device key without copying or changing native credentials',t=>{
  const dir=mkdtempSync(join(tmpdir(),'notify-node-key-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const state=join(dir,'openclaw.sqlite'),path=join(dir,'operator.json'),url='wss://gateway.example';
  const {publicKey,privateKey}=generateKeyPairSync('ed25519');const raw=publicKey.export({format:'jwk'}).x;
  const id=createHash('sha256').update(Buffer.from(raw,'base64url')).digest('hex');
  const pub=publicKey.export({format:'pem',type:'spki'}),priv=privateKey.export({format:'pem',type:'pkcs8'});
  const db=new DatabaseSync(state);db.exec('CREATE TABLE device_identities(identity_key TEXT,device_id TEXT,public_key_pem TEXT,private_key_pem TEXT); CREATE TABLE device_auth_tokens(role TEXT,token TEXT)');
  db.prepare('INSERT INTO device_identities VALUES(?,?,?,?)').run('primary',id,pub,priv);
  db.prepare('INSERT INTO device_auth_tokens VALUES(?,?)').run('node','existing-node-token');
  const auth=new OperatorCredentials(path,url,{identitySource:'openclaw-node',openclawStateDb:state});
  assert.equal(auth.identity().deviceId,id);assert.equal(auth.identity().privateKeyPem,priv);
  assert.ok(!readFileSync(path,'utf8').includes('PRIVATE KEY'));
  assert.deepEqual(auth.read().identity,{deviceId:id,source:'openclaw-primary'});
  const hooks=auth.hostDeps();assert.equal(hooks.loadDeviceAuthToken({deviceId:id,role:'operator'}),null);
  hooks.storeDeviceAuthToken({deviceId:id,role:'operator',token:'new-operator-only',scopes:NOTIFY_SCOPES});
  assert.equal(auth.token().token,'new-operator-only');assert.equal(hooks.loadDeviceAuthToken({deviceId:id,role:'node'}),null);
  assert.equal(db.prepare('SELECT token FROM device_auth_tokens WHERE role=?').get('node').token,'existing-node-token');
  assert.equal(db.prepare('SELECT private_key_pem FROM device_identities').get().private_key_pem,priv);db.close();
});

test('public SDK performs signed bootstrap, waits for approval, reuses device token and calls send',{timeout:10000},async t=>{
  const dir=mkdtempSync(join(tmpdir(),'notify-sdk-'));
  const server=new WebSocketServer({host:'127.0.0.1',port:0});await once(server,'listening');
  t.after(async()=>{for(const s of server.clients)s.terminate();await new Promise(r=>server.close(r));rmSync(dir,{recursive:true,force:true});});
  const url=`ws://127.0.0.1:${server.address().port}`;
  const config={url,credentialsPath:join(dir,'operator.json'),transport:'sdk',connectTimeoutMs:2000};
  let approved=false;let grantedScopes=NOTIFY_SCOPES;let issuedToken='device-scoped-test-token';const connects=[];const requests=[];
  server.on('connection',s=>{
    const nonce='test-challenge';const ts=Date.now();s.send(JSON.stringify({type:'event',event:'connect.challenge',payload:{nonce,ts}}));
    s.on('message',raw=>{
      const m=JSON.parse(String(raw));
      if(m.method==='connect'){
        const p=m.params;connects.push(p);
        assert.equal(p.role,'operator');assert.deepEqual(p.scopes,['operator.read','operator.write','operator.admin']);assert.equal(p.minProtocol,4);assert.equal(p.maxProtocol,4);
        assert.equal(p.device.nonce,nonce);assert.equal(p.device.signedAt,ts);
        const payload=buildDeviceAuthPayloadV3({deviceId:p.device.id,clientId:p.client.id,clientMode:p.client.mode,
          role:p.role,scopes:p.scopes,signedAtMs:p.device.signedAt,token:p.auth.bootstrapToken??p.auth.token,
          nonce,platform:p.client.platform,deviceFamily:p.client.deviceFamily});
        const key=createPublicKey({format:'jwk',key:{kty:'OKP',crv:'Ed25519',x:p.device.publicKey}});
        assert.ok(verify(null,Buffer.from(payload),key,Buffer.from(p.device.signature,'base64url')));
        if(!approved){s.send(JSON.stringify({type:'res',id:m.id,ok:false,error:{code:'NOT_PAIRED',message:'pairing required',details:{code:'PAIRING_REQUIRED',requestId:'exact-approval-request'}}}));return;}
        s.send(JSON.stringify({type:'res',id:m.id,ok:true,payload:{type:'hello-ok',protocol:4,server:{version:'test',connId:'conn'},
          features:{methods:['send'],events:[]},snapshot:{presence:[],health:{},stateVersion:{presence:0,health:0},uptimeMs:0},
          auth:{role:'operator',scopes:grantedScopes,deviceToken:issuedToken},
          policy:{maxPayload:1048576,maxBufferedBytes:1048576,tickIntervalMs:30000}}}));
      }else{requests.push(m);s.send(JSON.stringify({type:'res',id:m.id,ok:true,payload:{messageId:'discord-test-receipt'}}));}
    });
  });
  let client=new NotifyGatewayClient(config,{bootstrapToken:'short-lived-test-bootstrap'});
  await assert.rejects(client.open(),e=>e.code==='PAIRING_REQUIRED'&&e.requestId==='exact-approval-request'&&e.beforeDispatch);
  client.close();assert.equal(new OperatorCredentials(config.credentialsPath,url).token(),null);
  approved=true;client=new NotifyGatewayClient(config,{bootstrapToken:'short-lived-test-bootstrap'});
  const connected=await client.open();client.close();assert.equal(connected.role,'operator');
  assert.equal(connects[0].device.id,connects[1].device.id);
  const saved=new OperatorCredentials(config.credentialsPath,url).token();assert.equal(saved.token,'device-scoped-test-token');
  assert.ok(!readFileSync(config.credentialsPath,'utf8').includes('short-lived-test-bootstrap'));
  assert.equal(statSync(config.credentialsPath).mode&0o777,0o600);
  assert.equal(new OperatorCredentials(config.credentialsPath,'ws://different-gateway').token(),null);
  client=new NotifyGatewayClient(config);await client.open();
  await assert.rejects(client.request('config.patch',{}),/not allowed/);client.close();
  assert.equal(connects[2].auth.token,'device-scoped-test-token');assert.ok(!connects[2].auth.bootstrapToken);
  const sender=new GatewaySender({...config,configPath:join(dir,'unused.json'),channelId:'1000000000000000001',enabled:true});
  assert.equal(sender.configured(),true);
  const receipt=await sender.send({id:'matter-1'},{message:'one-line metadata\nbody'});
  assert.equal(receipt.messageId,'discord-test-receipt');assert.equal(requests.length,1);
  assert.equal(requests[0].method,'send');assert.equal(requests[0].params.idempotencyKey,'codex-notify:matter-1');
  assert.equal(requests[0].params.to,'channel:1000000000000000001');
  // An old write grant must not be mistaken for a successful admin upgrade.
  grantedScopes=['operator.read','operator.write'];issuedToken='old-write-token';
  const auth=new OperatorCredentials(config.credentialsPath,url);
  auth.hostDeps().storeDeviceAuthToken({deviceId:auth.identity().deviceId,role:'operator',token:issuedToken,scopes:grantedScopes});
  client=new NotifyGatewayClient(config);
  await assert.rejects(client.open(),e=>e.code==='REQUESTED_SCOPES_MISSING');client.close();
  assert.equal(sender.configured(),false);
  // Gateway admin grants satisfy ordinary read/write methods even if only admin is echoed.
  grantedScopes=['operator.admin'];issuedToken='upgraded-admin-token';client=new NotifyGatewayClient(config);
  assert.deepEqual((await client.open()).scopes,['operator.admin']);client.close();
  assert.equal(sender.configured(),true);
});
