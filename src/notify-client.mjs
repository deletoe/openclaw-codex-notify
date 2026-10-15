import { GatewayClient } from '@openclaw/gateway-client';
import { PROTOCOL_VERSION } from '@openclaw/gateway-protocol/version';
import { generateKeyPairSync, createHash, createPublicKey, sign } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, chmodSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { NOTIFY_SCOPES, hasNotifyScopes } from './notify-pairing.mjs';

const originKey = url => new URL(url).href;
export const credentialPath = config => config.credentialsPath ?? join(dirname(config.configPath), 'operator.json');
export function gatewayUrl(config) {
  const url = config.url ?? JSON.parse(readFileSync(config.configPath, 'utf8')).gateway?.remote?.url;
  if (!url || !['wss:', 'ws:'].includes(new URL(url).protocol)) throw new Error('Gateway URL is missing or invalid');
  return url;
}

// The public SDK uses a host-owned token store and a read-only reference to the existing device key.
export class OperatorCredentials {
  constructor(path, url, options={}) { this.path = path; this.key = originKey(url);this.options=options; }
  read() { try{return existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8')) : { version:1, gateways:{} };}
    catch{throw new Error('Cannot read operator credentials; credential contents are suppressed');} }
  write(data) {
    mkdirSync(dirname(this.path), { recursive:true, mode:0o700 });
    const temp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(data)+'\n', { mode:0o600 });
    renameSync(temp,this.path); chmodSync(this.path,0o600);
  }
  identity() {
    const data=this.read();
    if(this.options.identitySource==='openclaw-node'){
      const path=this.options.openclawStateDb??join(process.env.OPENCLAW_STATE_DIR??join(homedir(),'.openclaw'),'state','openclaw.sqlite');
      const db=new DatabaseSync(path,{readOnly:true});let row;
      try{row=db.prepare('SELECT device_id,public_key_pem,private_key_pem FROM device_identities WHERE identity_key=?').get('primary');}
      finally{db.close();}
      if(!row)throw new Error('Existing OpenClaw device identity was not found');
      const raw=createPublicKey(row.public_key_pem).export({format:'jwk'}).x;
      const deviceId=createHash('sha256').update(Buffer.from(raw,'base64url')).digest('hex');
      if(deviceId!==row.device_id||createPublicKey(row.private_key_pem).export({format:'jwk'}).x!==raw)
        throw new Error('Existing OpenClaw device identity failed key verification');
      if(data.identity?.deviceId!==deviceId||data.identity?.source!=='openclaw-primary'){
        if(data.identity?.deviceId!==deviceId&&Object.values(data.gateways??{}).some(g=>g.operator?.token))
          throw new Error('Cannot replace an already-authorized operator identity');
        if(existsSync(this.path)){const backup=`${this.path}.before-node-reuse-${Date.now()}`;copyFileSync(this.path,backup);chmodSync(backup,0o600);}
        data.identity={deviceId,source:'openclaw-primary'};this.write(data);
      }
      return {deviceId,publicKeyPem:row.public_key_pem,privateKeyPem:row.private_key_pem};
    }
    if (!data.identity) {
      const {publicKey,privateKey}=generateKeyPairSync('ed25519');
      const raw=publicKey.export({format:'jwk'}).x;
      data.identity={deviceId:createHash('sha256').update(Buffer.from(raw,'base64url')).digest('hex'),
        publicKeyPem:publicKey.export({format:'pem',type:'spki'}),
        privateKeyPem:privateKey.export({format:'pem',type:'pkcs8'})};
      this.write(data);
    }
    return data.identity;
  }
  token() { return this.read().gateways?.[this.key]?.operator ?? null; }
  hostDeps() {
    return {
      loadOrCreateDeviceIdentity:()=>this.identity(),
      signDevicePayload:(key,payload)=>sign(null,Buffer.from(payload),key).toString('base64url'),
      publicKeyRawBase64UrlFromPem:pem=>createPublicKey(pem).export({format:'jwk'}).x,
      loadDeviceAuthToken:({deviceId,role})=>deviceId===this.identity().deviceId&&role==='operator'?this.token():null,
      storeDeviceAuthToken:({deviceId,role,token,scopes})=>{
        if(deviceId!==this.identity().deviceId||role!=='operator'||scopes.some(s=>!NOTIFY_SCOPES.includes(s)))
          throw new Error('Unexpected device authorization grant');
        const data=this.read();data.gateways??={};data.gateways[this.key]={operator:{token,scopes}};this.write(data);
      },
      clearDeviceAuthToken:()=>{const data=this.read();delete data.gateways?.[this.key];this.write(data);},
      logDebug:()=>{},logError:()=>{},redactForLog:()=> '[Gateway diagnostic suppressed]'
    };
  }
}

export class NotifyGatewayError extends Error {
  constructor(code, {requestId=null, beforeDispatch=true}={}) {
    super(`Gateway ${code}`);this.code=code;this.requestId=requestId;this.beforeDispatch=beforeDispatch;
  }
}
export class NotifyGatewayClient {
  constructor(config,{bootstrapToken,Client=GatewayClient}={}) {
    this.config=config;this.url=gatewayUrl(config);this.auth=new OperatorCredentials(credentialPath(config),this.url,config);
    this.Client=Client;this.bootstrapToken=bootstrapToken;
  }
  async open() {
    if(this.client)throw new Error('Client is already open');
    return await new Promise((resolve,reject)=>{
      let settled=false;
      const fail=(error)=>{if(settled)return;settled=true;clearTimeout(timer);this.client?.stop();
        reject(new NotifyGatewayError(error.details?.code??error.code??'CONNECTION_FAILED',{
          requestId:typeof error.details?.requestId==='string'?error.details.requestId:null}));};
      const timer=setTimeout(()=>fail({code:'CONNECT_TIMEOUT'}),this.config.connectTimeoutMs??15000);
      this.client=new this.Client({url:this.url,clientName:'cli',clientDisplayName:'Codex session reminders',mode:'cli',
        ...(this.config.identitySource==='openclaw-node'&&process.platform==='darwin'?{platform:'macos',deviceFamily:'Mac'}:{}),
        ...(this.config.clientDisplayName?{clientDisplayName:this.config.clientDisplayName}:{}),
        role:'operator',scopes:NOTIFY_SCOPES,minProtocol:PROTOCOL_VERSION,maxProtocol:PROTOCOL_VERSION,
        hostDeps:this.auth.hostDeps(),requestTimeoutMs:15000,
        ...(this.bootstrapToken?{bootstrapToken:this.bootstrapToken,preferBootstrapToken:true}:{}),
        onHelloOk:hello=>{
          if(settled)return;
          if(hello.auth?.role!=='operator'||!hasNotifyScopes(hello.auth?.scopes)){fail({code:'REQUESTED_SCOPES_MISSING'});return;}
          this.policy=hello.policy;
          settled=true;clearTimeout(timer);resolve({deviceId:this.auth.identity().deviceId,role:hello.auth.role,
            scopes:hello.auth.scopes,version:hello.server?.version});
        },
        onConnectError:fail,onClose:(_code,_reason,info)=>{if(!settled)fail(info?.connectError??{code:'CONNECTION_CLOSED'});}
      });
      try{this.client.start();}catch(error){fail(error);}
    });
  }
  async request(method,params) {
    if(!['send','agents.list','conversations.list','channels.status'].includes(method))throw new Error('Notification client method is not allowed');
    if(!this.client)throw new Error('Gateway client is not connected');
    try{return await this.client.request(method,params,{timeoutMs:15000});}
    catch(error){throw new NotifyGatewayError(error.code??'REQUEST_FAILED',{beforeDispatch:error.requestSent===false});}
  }
  close() { this.client?.stop();this.client=null; }
}
