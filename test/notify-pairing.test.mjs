import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {readPairingCredential} from '../src/notify-pairing.mjs';

test('pairing accepts only a bootstrap credential for the configured Gateway, rejects shared-token files and expiry',t=>{
  const dir=mkdtempSync(join(tmpdir(),'notify-pairing-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'credential.json');const url='wss://gateway.example:443';
  const valid={url,bootstrapToken:'temporary-test-only',expiresAtMs:2000};
  writeFileSync(path,JSON.stringify(valid));assert.equal(readPairingCredential(path,'wss://gateway.example',1000),valid.bootstrapToken);
  assert.throws(()=>readPairingCredential(path,'wss://other.example',1000),/different Gateway/);
  assert.throws(()=>readPairingCredential(path,url,3000),/expired/);
  writeFileSync(path,JSON.stringify({token:'shared-token'}));assert.throws(()=>readPairingCredential(path,url),/short-lived bootstrap/);
  writeFileSync(path,JSON.stringify({setupCode:Buffer.from(JSON.stringify(valid)).toString('base64url')}));
  assert.equal(readPairingCredential(path,url,1000),valid.bootstrapToken);
  writeFileSync(path,'sensitive-non-JSON-token');
  assert.throws(()=>readPairingCredential(path,url),e=>!e.message.includes('sensitive-non-JSON-token'));
});
