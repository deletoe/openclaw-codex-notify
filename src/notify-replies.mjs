import { createHash, randomUUID } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('hex');
const snowflake = value => typeof value === 'string' && /^\d{15,25}$/.test(value);
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const origin = value => {
  const url = new URL(value);
  if (!['ws:','wss:'].includes(url.protocol) || url.username || url.password) fail('INVALID_GATEWAY', 'Invalid Gateway identity');
  return url.href;
};
export function ensureReplySchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS discord_notifications (
    key TEXT PRIMARY KEY,gateway TEXT NOT NULL,account_id TEXT NOT NULL,channel_id TEXT NOT NULL,message_id TEXT NOT NULL,
    reminder_id TEXT NOT NULL,target TEXT NOT NULL,created INTEGER NOT NULL,
    UNIQUE(gateway,account_id,channel_id,message_id));
    CREATE TABLE IF NOT EXISTS discord_replies (
    key TEXT PRIMARY KEY,notification_key TEXT NOT NULL,message_id TEXT NOT NULL,sender_id TEXT NOT NULL,
    body TEXT NOT NULL,body_hash TEXT NOT NULL,state TEXT NOT NULL,token TEXT NOT NULL,created INTEGER NOT NULL,
    updated INTEGER NOT NULL,baseline_turn_id TEXT,receipt TEXT,error TEXT);
    CREATE INDEX IF NOT EXISTS discord_reply_state ON discord_replies(state,notification_key);`);
  if(!db.prepare('PRAGMA table_info(discord_replies)').all().some(c=>c.name==='transport'))db.exec('ALTER TABLE discord_replies ADD COLUMN transport TEXT');
}
export function discordMessageIds(receipt) {
  if (!receipt || typeof receipt !== 'object') return [];
  if (receipt.channel && receipt.channel !== 'discord') return [];
  return [...new Set([receipt.messageId,...(Array.isArray(receipt.messageIds) ? receipt.messageIds : [])].filter(snowflake))];
}
function destination(input) {
  if (!input || !snowflake(input.channelId) || typeof input.accountId !== 'string' || !input.accountId.trim()) {
    fail('INVALID_DESTINATION', 'An exact Discord account and channel ID are required');
  }
  return { gateway: origin(input.gateway), accountId: input.accountId, channelId: input.channelId,
    nodeId: input.nodeId ?? null, nodeName: input.nodeName ?? null };
}
export function recordDiscordDelivery(store, reminderId, receipt, input) {
  if (!input) return 0; // Legacy receipt without an attested destination needs explicit indexing.
  const d = destination(input);
  const row = store.db.prepare(`SELECT r.*,s.id session_id,s.home,s.cwd,s.title,s.archived
    FROM reminders r JOIN sessions s ON s.key=r.session_key WHERE r.id=?`).get(reminderId);
  if (!row) fail('UNKNOWN_REMINDER', 'No original reminder for this delivery');
  const target = { reminderId, threadId: row.session_id, home: row.home, cwd: row.cwd, title: row.title,
    kind: row.kind, turnId: row.turn_id, requestId: row.request_id, nodeId: d.nodeId, nodeName: d.nodeName };
  let count = 0;
  for (const messageId of discordMessageIds(receipt)) {
    const key = hash(`${d.gateway}\0${d.accountId}\0${d.channelId}\0${messageId}`);
    const existing = store.db.prepare('SELECT reminder_id FROM discord_notifications WHERE key=?').get(key);
    if (existing && existing.reminder_id !== reminderId) fail('DELIVERY_COLLISION', 'Discord message ID is already bound to another reminder; do not overwrite');
    count += store.db.prepare('INSERT OR IGNORE INTO discord_notifications(key,gateway,account_id,channel_id,message_id,reminder_id,target,created) VALUES(?,?,?,?,?,?,?,?)')
      .run(key,d.gateway,d.accountId,d.channelId,messageId,reminderId,JSON.stringify(target),store.now()).changes;
  }
  return count;
}

export class ReplyRouter {
  constructor(store, configuredDestination, { allowedSenderIds } = {}) {
    this.store = store;
    this.destination = destination(configuredDestination);
    if (allowedSenderIds !== undefined && (!Array.isArray(allowedSenderIds) || allowedSenderIds.some(id => !snowflake(id)))) fail('INVALID_SENDER_POLICY', 'allowedSenderIds must be Discord user IDs');
    this.allowedSenderIds = allowedSenderIds;
  }
  resolve({ messageId, channelId, accountId }) {
    if (!snowflake(messageId)) fail('INVALID_REFERENCE', 'Use the native Discord reply reference ID, not notification text or a session title');
    const d = this.destination;
    if (channelId !== d.channelId || accountId !== d.accountId) return { matched: false, reason: 'wrong-channel-or-account' };
    const row = this.store.db.prepare('SELECT * FROM discord_notifications WHERE gateway=? AND account_id=? AND channel_id=? AND message_id=?')
      .get(d.gateway,accountId,channelId,messageId);
    if (!row) return { matched: false, reason: 'unknown-notification' };
    const target = JSON.parse(row.target);
    const current = this.store.db.prepare('SELECT archived FROM sessions WHERE home=? AND id=?').get(target.home,target.threadId);
    return { matched: true, notificationKey: row.key, messageId, accountId, channelId,
      target, targetArchived: Boolean(current?.archived), authentication: 'caller-must-enforce-native-Discord-sender-policy',
      inputTransport: 'source-check-required', action: 'classify-native-origin-before-forwarding' };
  }
  indexExisting({ messageIds, apply = false } = {}) {
    if (!Array.isArray(messageIds) || !messageIds.length || messageIds.some(id => !snowflake(id))) fail('INVALID_REFERENCE', 'Explicit messageIds are required for legacy indexing');
    return this.store.transaction(() => {
      const matches = [];
      for (const row of this.store.db.prepare("SELECT id,receipt FROM reminders WHERE state='sent' AND receipt IS NOT NULL").all()) {
        const receipt = JSON.parse(row.receipt);
        const selected = discordMessageIds(receipt).filter(id => messageIds.includes(id));
        if (!selected.length) continue;
        if (apply) recordDiscordDelivery(this.store,row.id,{ channel:'discord',messageIds:selected },this.destination);
        matches.push({ reminderId: row.id, messageIds: selected });
      }
      const missing = messageIds.filter(id => !matches.some(m => m.messageIds.includes(id)));
      if (missing.length) fail('MISSING_RECEIPT', 'At least one message ID has no confirmed stored Discord send receipt');
      return { apply, matches, destination: this.destination,
        notice: 'Legacy receipts do not store their destination. The operator must verify this exact account/channel before applying.' };
    });
  }
  prepare(input) {
    if (!input || !snowflake(input.messageId) || !snowflake(input.senderId)) fail('INVALID_REPLY', 'Native Discord message ID and sender ID are required');
    if (input.messageId===input.replyToId) fail('INVALID_REPLY', 'A Discord message cannot reply to itself');
    if (input.isBot === true || input.isWebhook === true) fail('NON_HUMAN_REPLY', 'Bot/webhook messages are not forwarded');
    if (this.allowedSenderIds && !this.allowedSenderIds.includes(input.senderId)) fail('SENDER_DENIED', 'Sender is not on the configured reply allowlist');
    if (input.attachments?.length) fail('UNSUPPORTED_REPLY_MEDIA', 'Reply forwarding currently accepts text only; do not silently discard attachments');
    if (typeof input.content !== 'string' || !input.content.trim() || input.content.length > 20000) fail('INVALID_REPLY_TEXT', 'A nonempty bounded human reply is required');
    const route = this.resolve({ messageId:input.replyToId,channelId:input.channelId,accountId:input.accountId });
    if (!route.matched) return route;
    if (route.targetArchived) fail('TARGET_ARCHIVED', 'Original Codex session is archived; do not create a substitute');
    const d = this.destination;
    const key = hash(`${d.gateway}\0${input.accountId}\0${input.channelId}\0${input.messageId}`);
    const contentHash = hash(input.content);
    return this.store.transaction(() => {
      const old = this.store.db.prepare('SELECT * FROM discord_replies WHERE key=?').get(key);
      if (old && (old.notification_key !== route.notificationKey || old.body_hash !== contentHash || old.sender_id !== input.senderId)) {
        fail('REPLY_CONFLICT', 'This Discord message ID was already bound to a different target/body/sender; edits are not a new delivery');
      }
      if (!old) this.store.db.prepare('INSERT INTO discord_replies(key,notification_key,message_id,sender_id,body,body_hash,state,token,created,updated,baseline_turn_id,receipt,error) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(key,route.notificationKey,input.messageId,input.senderId,input.content,contentHash,'prepared',randomUUID(),this.store.now(),this.store.now(),null,null,null);
      return this.get(key);
    });
  }
  get(key) {
    const r = this.store.db.prepare(`SELECT r.*,n.target,n.gateway,n.message_id reply_to_id,n.channel_id,n.account_id FROM discord_replies r
      JOIN discord_notifications n ON n.key=r.notification_key WHERE r.key=?`).get(key);
    if (!r) fail('UNKNOWN_REPLY', 'Unknown reply delivery');
    if(r.gateway!==this.destination.gateway || r.channel_id!==this.destination.channelId || r.account_id!==this.destination.accountId) fail('WRONG_REPLY_CONTEXT','Reply belongs to a different configured Gateway/account/channel');
    return { matched:true, deliveryKey:r.key, claimToken:r.token, state:r.state, sourceMessageId:r.message_id, replyToId:r.reply_to_id,senderId:r.sender_id,
      channelId:r.channel_id, accountId:r.account_id, target:JSON.parse(r.target), content:r.body,
      baselineTurnId:r.baseline_turn_id, receipt:r.receipt ? JSON.parse(r.receipt) : null, error:r.error,
      inputTransport:r.transport??'source-check-required',
      deliveryStatus:r.state==='forwarded'?'delivered':r.state==='prepared'?'not-attempted':'unverified',
      registrationStatus:r.state==='forwarded'?'registered':'pending',
      taskStatusAtRegistration:r.receipt?JSON.parse(r.receipt).turnStatus??'unknown':'unknown',
      canSend:r.state==='prepared', requires:'Verify native sender authorization, fresh source metadata and exact original session. CLI origins use CLI resume; App origins use authorized App UI automation; unknown sources stop.' };
  }
  begin(key, token, baselineTurnId,{transport='openclaw-computer-use'}={}) {
    return this.store.transaction(() => {
      const r = this.get(key);
      if (r.claimToken !== token || r.state !== 'prepared') fail('REPLY_NOT_SENDABLE', 'Reply is already sent/in-flight/uncertain or has a different owner; never resend');
      if(this.allowedSenderIds&&!this.allowedSenderIds.includes(r.senderId))fail('SENDER_DENIED','Sender is no longer on the configured reply allowlist');
      if(this.store.db.prepare('SELECT archived FROM sessions WHERE home=? AND id=?').get(r.target.home,r.target.threadId)?.archived)fail('TARGET_ARCHIVED','Original session was archived before dispatch');
      if (typeof baselineTurnId !== 'string' || !baselineTurnId.trim() || baselineTurnId.length > 200) fail('MISSING_BASELINE', 'Read the exact original session and record its last persisted turn before sending');
      if(!['openclaw-computer-use','codex-cli-resume'].includes(transport))fail('INVALID_INPUT_TRANSPORT','Unknown input route');
      // A different reply must not overlap an in-flight or uncertain input to the same native store/thread.
      for (const other of this.store.db.prepare(`SELECT r.key,n.target FROM discord_replies r JOIN discord_notifications n ON n.key=r.notification_key
        WHERE r.state IN ('sending','uncertain') AND r.key<>?`).all(key)) {
        const t=JSON.parse(other.target);
        if (t.home===r.target.home && t.threadId===r.target.threadId) fail('SESSION_REPLY_BUSY', 'An earlier reply to the same native session needs reconciliation');
      }
      this.store.db.prepare("UPDATE discord_replies SET state='sending',baseline_turn_id=?,transport=?,updated=? WHERE key=?").run(baselineTurnId,transport,this.store.now(),key);
      return this.get(key);
    });
  }
  confirm(key, token, receipt) {
    return this.store.transaction(() => {
      const r=this.get(key);
      if(r.claimToken!==token || !['sending','uncertain'].includes(r.state)) fail('REPLY_NOT_IN_FLIGHT', 'No matching in-flight reply to confirm');
      if(receipt?.threadId!==r.target.threadId || receipt?.home!==r.target.home || typeof receipt.turnId!=='string' || !receipt.turnId.trim() || receipt.turnId===r.baselineTurnId ||
        typeof receipt.evidence!=='string' || !receipt.evidence.trim() || receipt.evidence.length>20000) fail('INVALID_REPLY_RECEIPT', 'Verify the same native home/thread, a new persisted turn and actual input evidence');
      if(receipt.transport&&r.inputTransport!=='source-check-required'&&receipt.transport!==r.inputTransport)fail('INVALID_REPLY_RECEIPT','Receipt transport differs from the dispatched route; never retry an uncertain App input through CLI');
      this.store.db.prepare("UPDATE discord_replies SET state='forwarded',receipt=?,error=NULL,updated=? WHERE key=?").run(JSON.stringify(receipt),this.store.now(),key);
      return this.get(key);
    });
  }
  uncertain(key,token,reason='App input outcome unknown') {
    const r=this.get(key);
    if(r.claimToken!==token || !['sending','uncertain'].includes(r.state)) fail('REPLY_NOT_IN_FLIGHT','No matching in-flight reply');
    this.store.db.prepare("UPDATE discord_replies SET state='uncertain',error=?,updated=? WHERE key=?").run(String(reason).slice(0,1000),this.store.now(),key);
    return this.get(key);
  }
}
