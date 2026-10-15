import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ensureReplySchema, recordDiscordDelivery } from './notify-replies.mjs';

export const digest = value => createHash('sha256').update(value).digest('hex');
export const sessionKey = (home, id) => digest(`${home}\0${id}`);
export const toolSignature = (name, input = {}) => {
  const ordered = x => Array.isArray(x) ? x.map(ordered) : x && typeof x === 'object'
    ? Object.fromEntries(Object.keys(x).sort().map(k => [k, ordered(x[k])])) : x;
  return digest(`${name}\0${JSON.stringify(ordered(input))}`);
};

export class NotifyStore {
  constructor(dir, { now = Date.now, delayMs = 20 * 60_000 } = {}) {
    this.now = now; this.delayMs = delayMs;
    mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700);
    const path = join(dir, 'notify.sqlite');
    this.db = new DatabaseSync(path); chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(key TEXT PRIMARY KEY,home TEXT NOT NULL,id TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',cwd TEXT NOT NULL DEFAULT '',archived INTEGER NOT NULL DEFAULT 0,
        turn_id TEXT,last_reply INTEGER NOT NULL DEFAULT 0,last_start INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS cursors(path TEXT PRIMARY KEY,offset INTEGER NOT NULL,identity TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS native_index(home TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(home,id));
      CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS tools(session_key TEXT NOT NULL,call_id TEXT NOT NULL,turn_id TEXT,
        signature TEXT,at INTEGER NOT NULL,done INTEGER NOT NULL DEFAULT 0,async_input INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(session_key,call_id));
      CREATE TABLE IF NOT EXISTS reminders(id TEXT PRIMARY KEY,session_key TEXT NOT NULL,turn_id TEXT NOT NULL,
        kind TEXT NOT NULL,request_id TEXT NOT NULL,content TEXT NOT NULL,created INTEGER NOT NULL,due INTEGER NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending',reason TEXT,dispatched INTEGER,receipt TEXT,retry_after INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS reminders_due ON reminders(state,due);
      CREATE INDEX IF NOT EXISTS reminders_session ON reminders(session_key,turn_id,state);`);
    if(!this.db.prepare('PRAGMA table_info(reminders)').all().some(c=>c.name==='retry_after'))
      this.db.exec('ALTER TABLE reminders ADD COLUMN retry_after INTEGER NOT NULL DEFAULT 0');
    this.db.prepare('INSERT OR IGNORE INTO meta VALUES(?,?)').run('startedAt', String(now()));
    this.db.prepare('INSERT OR IGNORE INTO meta VALUES(?,?)').run('installationId', randomUUID());
    ensureReplySchema(this.db);
  }
  close() { this.db.close(); }
  meta(key) { return this.db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value; }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); this.db.exec('COMMIT'); return r; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  session(home, id, metadata = {}) {
    const key = sessionKey(home, id);
    this.db.prepare('INSERT OR IGNORE INTO sessions(key,home,id) VALUES(?,?,?)').run(key, home, id);
    for (const field of ['title', 'cwd', 'archived']) if (metadata[field] !== undefined)
      this.db.prepare(`UPDATE sessions SET ${field}=? WHERE key=?`).run(metadata[field], key);
    if (metadata.archived) this.cancel(key, Infinity, 'archived');
    return this.db.prepare('SELECT * FROM sessions WHERE key=?').get(key);
  }
  cancel(key, at, reason, { turn, request, kinds } = {}) {
    let sql = "UPDATE reminders SET state='cancelled',reason=? WHERE session_key=? AND state='pending' AND created<=?";
    const args = [reason, key, Number.isFinite(at) ? at : Number.MAX_SAFE_INTEGER];
    if (turn) { sql += ' AND turn_id=?'; args.push(turn); }
    if (request) { sql += ' AND request_id=?'; args.push(request); }
    if (kinds?.length) { sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`; args.push(...kinds); }
    return this.db.prepare(sql).run(...args).changes;
  }
  wait(s, e) {
    if (!e.turn || !e.request) return;
    const id = digest(`${this.meta('installationId')}\0${s.key}\0${e.turn}\0${e.kind}\0${e.request}`);
    const handled = s.archived || s.last_reply >= e.at || s.last_start > e.at;
    this.db.prepare(`INSERT INTO reminders(id,session_key,turn_id,kind,request_id,content,created,due,state,reason)
      VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET content=excluded.content
      WHERE reminders.state='pending' AND reminders.content=''`).run(id, s.key, e.turn, e.kind, e.request,
      String(e.content ?? ''), e.at, e.at + this.delayMs,
      handled ? 'cancelled' : 'pending', handled ? 'already-handled' : null);
  }
  ingest(e) {
    if (!e.id || !e.home || !e.session || !Number.isFinite(e.at)) throw new Error('Invalid notification event');
    return this.transaction(() => {
      if (!this.db.prepare('INSERT OR IGNORE INTO events VALUES(?,?)').run(e.id, e.at).changes) return false;
      let s = this.session(e.home, e.session, e.metadata);
      const turn = e.turn ?? s.turn_id;
      if (e.type === 'start') {
        this.cancel(s.key, e.at, 'continued');
        this.db.prepare('UPDATE sessions SET turn_id=?,last_start=max(last_start,?) WHERE key=? AND last_start<=?')
          .run(turn, e.at, s.key, e.at);
      } else if (e.type === 'reply') {
        this.cancel(s.key, e.at, 'user-replied');
        this.db.prepare('UPDATE sessions SET last_reply=max(last_reply,?) WHERE key=?').run(e.at, s.key);
      } else if (e.type === 'tool') {
        if (!e.request) return true;
        // A late PreToolUse hook must not reopen a tool whose output was already observed.
        this.db.prepare(`INSERT INTO tools VALUES(?,?,?,?,?,0,?) ON CONFLICT(session_key,call_id) DO UPDATE SET
          signature=coalesce(excluded.signature,tools.signature),turn_id=coalesce(excluded.turn_id,tools.turn_id)`)
          .run(s.key, e.request, turn, e.signature ?? null, e.at, e.asyncInput ? 1 : 0);
      } else if (e.type === 'resolved') {
        if (e.request) {
          this.db.prepare(`INSERT INTO tools VALUES(?,?,?,?,?,1,0) ON CONFLICT(session_key,call_id) DO UPDATE SET done=1`)
            .run(s.key, e.request, turn, e.signature ?? null, e.at);
          this.cancel(s.key, e.at, 'request-resolved', { request: e.request });
        } else if (e.signature) {
          for (const t of this.db.prepare('SELECT call_id FROM tools WHERE session_key=? AND signature=? AND at<=?').all(s.key, e.signature, e.at)) {
            this.db.prepare('UPDATE tools SET done=1 WHERE session_key=? AND call_id=?').run(s.key, t.call_id);
            this.cancel(s.key, e.at, 'request-resolved', { request: t.call_id });
          }
          this.cancel(s.key, e.at, 'request-resolved', { request: `approval:${e.signature}` });
        }
      } else if (e.type === 'wait') {
        if (e.at < Number(this.meta('startedAt'))) return true;
        let request = e.request;
        if (e.kind === 'approval' && !request && e.signature) {
          const t = this.db.prepare(`SELECT * FROM tools t WHERE session_key=? AND signature=? AND turn_id=?
            ORDER BY (NOT EXISTS(SELECT 1 FROM reminders r WHERE r.session_key=t.session_key AND r.request_id=t.call_id)) DESC,
              at DESC LIMIT 1`).get(s.key, e.signature, turn);
          request = t?.call_id ?? `approval:${e.signature}`;
        }
        const done = request && this.db.prepare('SELECT done FROM tools WHERE session_key=? AND call_id=?').get(s.key, request)?.done;
        this.wait(s, { ...e, turn, request });
        if (done) this.cancel(s.key, Infinity, 'already-resolved', { request });
      } else if (e.type === 'complete') {
        this.cancel(s.key, e.at, 'turn-finished', { turn, kinds: ['approval'] });
        this.db.prepare(`UPDATE reminders SET state='cancelled',reason='turn-finished'
          WHERE session_key=? AND turn_id=? AND kind='input' AND state='pending' AND created<=?
          AND request_id IN (SELECT call_id FROM tools WHERE session_key=? AND async_input=0)`)
          .run(s.key, turn, e.at, s.key);
        if (e.at >= Number(this.meta('startedAt'))) {
          const existingInput = this.db.prepare("SELECT 1 FROM reminders WHERE session_key=? AND turn_id=? AND kind='input' AND state='pending' LIMIT 1").get(s.key, turn);
          if (!existingInput) this.wait(s, { ...e, turn, kind: 'completed', request: 'final' });
        }
      } else if (e.type === 'stop') {
        this.cancel(s.key, e.at, 'interrupted', { turn });
      } else if (e.type === 'activity') {
        // A new tool/model continuation invalidates a premature Stop-hook completion candidate.
        this.cancel(s.key, e.at, 'still-running', { turn, kinds: ['completed'] });
      }
      return true;
    });
  }
  due(at = this.now()) {
    return this.db.prepare(`SELECT r.*,s.id session_id,s.title,s.home FROM reminders r JOIN sessions s ON s.key=r.session_key
      WHERE r.state='pending' AND r.due<=? AND r.retry_after<=? AND s.archived=0 ORDER BY r.due,r.id`).all(at,at);
  }
  claim(id) {
    return this.db.prepare("UPDATE reminders SET state='sending',dispatched=? WHERE id=? AND state='pending'").run(this.now(), id).changes === 1;
  }
  finish(id, receipt, destination) {
    return this.transaction(() => {
      if (this.db.prepare("UPDATE reminders SET state='sent',receipt=? WHERE id=? AND state='sending'").run(JSON.stringify(receipt), id).changes !== 1) return;
      recordDiscordDelivery(this,id,receipt,destination);
    });
  }
  uncertain(id, reason) { this.db.prepare("UPDATE reminders SET state='uncertain',reason=? WHERE id=? AND state='sending'").run(reason, id); }
  defer(id,reason) { this.db.prepare("UPDATE reminders SET state='pending',reason=?,retry_after=? WHERE id=? AND state='sending'").run(reason,this.now()+60000,id); }
  recover() { return this.db.prepare("UPDATE reminders SET state='uncertain',reason='service-restarted-after-dispatch' WHERE state='sending'").run().changes; }
  acknowledge(id) { return this.db.prepare("UPDATE reminders SET state='cancelled',reason='acknowledged' WHERE id=? AND state='pending'").run(id).changes; }
  list() { return this.db.prepare(`SELECT r.id,s.id session_id,s.title,r.kind,r.state,r.created,r.due,r.reason
    FROM reminders r JOIN sessions s ON s.key=r.session_key ORDER BY r.created DESC LIMIT 100`).all(); }
}

const oneLine = (s, n) => String(s ?? '').replace(/[\r\n\t]+/g, ' ').replace(/@/g, '@\u200b').trim().slice(0, n);
export function formatReminder(row, device) {
  const labels = { completed: '本轮完成', approval: '等待批准', input: '等待输入', failed: '执行失败' };
  const header = `🔔 ${oneLine(device, 80)} · ${oneLine(row.title || row.session_id, 120)} · ${labels[row.kind] ?? row.kind}（20分钟）`;
  const content = String(row.content ?? '').replace(/@/g, '@\u200b');
  const budget = 1900 - header.length - 1;
  const clipped = content.length > budget;
  return { message: `${header}\n${clipped ? content.slice(0, budget - 18) + '\n…（全文见附件）' : content}`,
    ...(clipped ? { buffer: Buffer.from(content, 'utf8').toString('base64'), filename: `codex-${row.id.slice(0, 12)}.txt`, contentType: 'text/plain' } : {}) };
}
