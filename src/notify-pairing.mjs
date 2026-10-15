import { readFileSync } from 'node:fs';

export const NOTIFY_SCOPES = ['operator.read', 'operator.write', 'operator.admin'];
export const hasNotifyScopes = scopes => Array.isArray(scopes) && scopes.includes('operator.admin');
export function readPairingCredential(path, expectedUrl, now = Date.now()) {
  let data;
  try{
    data=JSON.parse(readFileSync(path,'utf8'));
    if (typeof data.setupCode==='string') data=JSON.parse(Buffer.from(data.setupCode,'base64url').toString('utf8'));
  }catch{throw new Error('Cannot read a valid JSON pairing credential; credential contents are suppressed');}
  if (!data.bootstrapToken || typeof data.bootstrapToken!=='string') throw new Error('Expected a short-lived bootstrap credential, not a shared Gateway token');
  let matches=false;
  try{matches=new URL(data.url).href===new URL(expectedUrl).href;}catch{}
  if (!matches) throw new Error('Pairing credential targets a different Gateway');
  if (data.expiresAtMs!=null && data.expiresAtMs<=now) throw new Error('Pairing credential expired; issue a new credential on the Gateway');
  return data.bootstrapToken;
}
