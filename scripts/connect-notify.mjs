#!/usr/bin/env node
// Operator role-upgrade helper using the public Gateway SDK and the existing node's device key.
import { resolve } from 'node:path';
import { loadNotifyConfig } from '../src/notify.mjs';
import { readPairingCredential, NOTIFY_SCOPES } from '../src/notify-pairing.mjs';
import { NotifyGatewayClient, gatewayUrl } from '../src/notify-client.mjs';

const config=loadNotifyConfig();
const url=gatewayUrl(config.gateway);
if(!url?.startsWith('wss://'))throw new Error('Enrollment requires the configured secure Gateway URL');
const arg=process.argv.indexOf('--bootstrap-file');
const bootstrap=arg>=0?readPairingCredential(resolve(process.argv[arg+1]),url):undefined;
const client=new NotifyGatewayClient(config.gateway,{bootstrapToken:bootstrap});
try{console.log(JSON.stringify({connected:true,...await client.open()},null,2));}
catch(error){console.log(JSON.stringify({connected:false,code:error.code??'CONNECT_FAILED',requestId:error.requestId??null,
  deviceId:client.auth.identity().deviceId,
  requestedScopes:NOTIFY_SCOPES,
  ...(error.code==='PAIRING_REQUIRED'&&error.requestId?{approvalCommand:`openclaw devices approve ${error.requestId}`}:{ }),
  stage:error.code==='PAIRING_REQUIRED'?'pairing':error.code?.startsWith('AUTH_')?'authentication':'connection',
  action:error.code==='PAIRING_REQUIRED'&&error.requestId?'Approve this exact request on the Gateway and reconnect.':
    error.code?.startsWith('AUTH_')?'Authentication did not succeed; no approval request is confirmed. Check the existing connection configuration before choosing an enrollment method.':
    'Check Gateway authorization or protocol compatibility.'},null,2));process.exitCode=1;}
finally{client.close();}
