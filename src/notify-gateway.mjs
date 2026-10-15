import { execFile } from 'node:child_process';
import { formatReminder as format } from './notify-store.mjs';
import { NotifyGatewayClient, OperatorCredentials, credentialPath, gatewayUrl } from './notify-client.mjs';
import { hasNotifyScopes } from './notify-pairing.mjs';

export class GatewaySender {
  constructor(config, { run = execFile } = {}) { this.config = config; this.run = run; }
  destination() {
    const c=this.config;
    let gateway;try{gateway=gatewayUrl(c);}catch{return undefined;}
    let nodeId=null;
    if(c.identitySource==='openclaw-node')try { nodeId=new OperatorCredentials(credentialPath(c),gatewayUrl(c),c).read().identity?.deviceId??null; } catch {}
    return {gateway,channelId:c.channelId,accountId:c.accountId??'default',nodeId,nodeName:c.clientDisplayName??null};
  }
  configured() {
    const ready=this.config.enabled !== false && /^\d{15,25}$/.test(this.config.channelId ?? '') &&
      (this.config.url || this.config.profile || this.config.configPath || this.config.useDefaultConfig === true);
    if(!ready || this.config.transport!=='sdk')return Boolean(ready);
    try{const grant=new OperatorCredentials(credentialPath(this.config),gatewayUrl(this.config),this.config).token();return Boolean(grant?.token&&hasNotifyScopes(grant.scopes));}catch{return false;}
  }
  async send(row, formatted) {
    if (!this.configured()) throw new Error('Gateway destination or connection configuration is missing');
    const payload = { channel: 'discord', to: `channel:${this.config.channelId}`, ...formatted,
      idempotencyKey: `codex-notify:${row.id}`,
      ...(this.config.accountId ? { accountId: this.config.accountId } : {}) };
    if(this.config.transport==='sdk'){
      const client=new NotifyGatewayClient(this.config);
      try{
        await client.open();
        const policy=client.policy;
        const exceedsAttachment=payload.buffer&&policy?.attachments?.maxBytes!=null&&Buffer.from(payload.buffer,'base64').length>policy.attachments.maxBytes;
        const exceedsFrame=policy?.maxPayload!=null&&Buffer.byteLength(JSON.stringify(payload))+1024>policy.maxPayload;
        if(payload.buffer&&(exceedsAttachment||exceedsFrame)){
          delete payload.buffer;delete payload.filename;delete payload.contentType;
          payload.message=payload.message.replace('全文见附件','正文过长，显示节选');
        }
        return await client.request('send',payload);
      }
      finally{client.close();}
    }
    const args = [...(this.config.profile ? ['--profile', this.config.profile] : []),
      'gateway', 'call', 'send', '--json', '--timeout', '15000', '--params', JSON.stringify(payload)];
    const env = { ...process.env, ...(this.config.configPath ? { OPENCLAW_CONFIG_PATH: this.config.configPath } : {}) };
    // Never place auth tokens on argv or in service logs. OpenClaw owns its device credentials.
    return await new Promise((resolve, reject) => {
      this.run(this.config.binary ?? '/opt/homebrew/bin/openclaw', args,
        { env, encoding: 'utf8', timeout: 25_000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
          if (error) { reject(new Error(`Gateway send failed or outcome unknown (${error.code ?? 'transport'}); inspect receipt before retrying`)); return; }
          try { resolve(JSON.parse(stdout)); }
          catch { reject(new Error('Gateway returned an unreadable receipt; delivery outcome is unknown')); }
        });
    });
  }
}

export async function deliverDue(store, sender, { device, beforeSend = async () => {}, graceMs = 5000 } = {}) {
  if (!sender.configured()) return { sent: 0, blocked: 'gateway-not-configured' };
  let sent = 0;
  for (const candidate of store.due(store.now() - graceMs)) {
    await beforeSend(); // Drain new replies and resolved requests immediately before dispatch.
    const row = store.due(store.now() - graceMs).find(r => r.id === candidate.id);
    if (!row || !store.claim(row.id)) continue;
    try { store.finish(row.id, await sender.send(row, format(row, device)), sender.destination?.()); sent++; }
    catch (e) { e.beforeDispatch===true?store.defer(row.id,e.message):store.uncertain(row.id, e.message); }
  }
  return { sent };
}
