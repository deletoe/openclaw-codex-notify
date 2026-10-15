import { DatabaseSync } from 'node:sqlite';
import { existsSync, readdirSync, statSync, openSync, readSync, closeSync, readFileSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { digest, sessionKey, toolSignature } from './notify-store.mjs';

const INPUT_TOOL = /(?:^|[._/])request_?user_?input(?:_async)?$/i;
export const isInputTool = name => INPUT_TOOL.test(String(name ?? ''));
export function questionsText(input = {}) {
  return (input.questions ?? []).map(q => {
    const title = q.question ?? q.title ?? q.header ?? '';
    const opts = (q.options ?? []).map(o => typeof o === 'string' ? o : o.label).filter(Boolean);
    return [title, opts.length ? opts.join(' / ') : ''].filter(Boolean).join('\n');
  }).join('\n\n');
}
function parseInput(input) { try { return typeof input === 'string' ? JSON.parse(input) : input ?? {}; } catch { return {}; } }
function normalizedTool(name, input) {
  if (['exec_command', 'shell_command', 'shell', 'Bash'].includes(name)) return ['Bash', { command: input.cmd ?? input.command ?? '' }];
  return [name, input];
}
const signature = (name, input) => toolSignature(...normalizedTool(name, input));

// Adapter for both legacy JSONL and current paginated histories' durable rollout events.
// No runtime status from a separate App Server is used.
export function consumeRecord(store, home, session, record, eventId) {
  const p = record.payload ?? {};
  const at = Date.parse(record.timestamp);
  if (!Number.isFinite(at)) return;
  const s = store.session(home, session);
  const turn = p.turn_id ?? p.turnId ?? s.turn_id;
  if (at < Number(store.meta('startedAt'))) {
    if (record.type === 'event_msg' && p.type === 'task_started' && turn)
      store.db.prepare('UPDATE sessions SET turn_id=?,last_start=? WHERE key=? AND last_start<=?').run(turn, at, s.key, at);
    return;
  }
  const emit = (type, fields = {}, suffix = '') => store.ingest({
    id: `${eventId}:${type}:${suffix}`, home, session, at, turn, type, ...fields
  });
  if (record.type === 'event_msg') {
    if (p.type === 'task_started') emit('start');
    else if (p.type === 'task_complete') emit('complete', { content: p.last_agent_message ?? '' });
    else if (p.type === 'turn_aborted') emit('stop');
    else if (p.type === 'user_message') emit('reply');
    else if (p.type === 'item_completed') {
      const item = p.item ?? {};
      if (item.type === 'userMessage') emit('reply');
      if (['reasoning', 'commandExecution', 'fileChange', 'mcpToolCall'].includes(item.type)) emit('activity');
      if (['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'functionCallOutput'].includes(item.type) && item.status !== 'inProgress')
        emit('resolved', { request: item.id });
    }
  }
  if (record.type !== 'response_item') return;
  if (p.type === 'message' && p.role === 'user') {
    // Initial environment/developer blocks are not user replies. Durable userMessage is authoritative
    // on paginated histories; legacy user_message or real user text is accepted here too.
    const text = (p.content ?? []).filter(c => ['input_text', 'text'].includes(c.type)).map(c => c.text ?? '').join('\n');
    if (text && !/^\s*<(?:environment_context|permissions instructions|skills_instructions|INSTRUCTIONS|user_instructions|turn_aborted)/.test(text)) emit('reply');
  }
  if (['function_call', 'custom_tool_call'].includes(p.type)) {
    const input = parseInput(p.arguments ?? p.input);
    const asyncInput = /_async$/.test(p.name ?? '');
    emit('activity');
    emit('tool', { request: p.call_id ?? p.id, signature: signature(p.name, input), asyncInput });
    if (isInputTool(p.name)) emit('wait', { kind: 'input', request: p.call_id ?? p.id, content: questionsText(input) });
  }
  if (['function_call_output', 'custom_tool_call_output'].includes(p.type)) {
    const tool = store.db.prepare('SELECT * FROM tools WHERE session_key=? AND call_id=?').get(s.key, p.call_id);
    // async prompts return immediately after display; their output is not an answer.
    const output=parseInput(p.output);
    const rejected=output.accepted===false || output.isError===true || output.error!=null;
    if (!tool?.async_input || rejected) emit('resolved', { request: p.call_id });
  }
}

export function consumeHook(store, home, hook, id, at) {
  const session = hook.session_id;
  if (!session) throw new Error('Hook has no session_id');
  const input = hook.tool_input ?? {};
  const tool = hook.tool_name ?? '';
  const s = store.session(home, session, { cwd: hook.cwd ?? '' });
  const e = { id, home, session, at, turn: hook.turn_id ?? s.turn_id };
  const sig = signature(tool, input);
  if (hook.hook_event_name === 'UserPromptSubmit') store.ingest({ ...e, type: 'reply' });
  else if (hook.hook_event_name === 'Interrupt') store.ingest({ ...e, type: 'stop' });
  else if (hook.hook_event_name === 'PermissionRequest') store.ingest({ ...e, type: 'wait', kind: 'approval',
    request: hook.tool_use_id, signature: sig, content: [input.description ?? input.justification, input.command ?? input.cmd ?? tool].filter(Boolean).join('\n') });
  else if (hook.hook_event_name === 'PreToolUse') {
    store.ingest({ ...e, id: `${id}:activity`, type: 'activity' });
    store.ingest({ ...e, type: 'tool', request: hook.tool_use_id, signature: sig, asyncInput: /_async$/.test(tool) });
    if (isInputTool(tool)) store.ingest({ ...e, id: `${id}:input`, type: 'wait', kind: 'input', request: hook.tool_use_id, content: questionsText(input) });
  } else if (hook.hook_event_name === 'PostToolUse' && !/_async$/.test(tool)) {
    store.ingest({ ...e, type: 'resolved', request: hook.tool_use_id, signature: sig });
  }
  // Stop is deliberately not a completion signal: another Stop hook can continue the turn.
  // The scanner waits for the durable task_complete event instead.
}

export class NativeSource {
  constructor(store, homes, { maxChunkBytes = 16 * 1024 * 1024 } = {}) {
    this.store = store; this.homes = homes; this.maxChunkBytes = maxChunkBytes; this.files = new Map();
    this.lastDiscovery = 0; this.health = { files: 0, homes: homes.length, errors: [] };
  }
  discover() {
    for (const home of this.homes) {
      const candidates = readdirSync(home).filter(n => /^state_\d+\.sqlite$/.test(n)).sort((a,b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]));
      if (candidates[0]) {
        const db = new DatabaseSync(join(home, candidates[0]), { readOnly: true });
        try {
          const fields = db.prepare('PRAGMA table_info(threads)').all().map(x => x.name);
          const name = fields.includes('name') ? "coalesce(nullif(name,''),title)" : 'title';
          const rows=db.prepare(`SELECT id,rollout_path,cwd,${name} title,archived FROM threads`).all();
          const ids=new Set(rows.map(r=>r.id));
          for(const old of this.store.db.prepare('SELECT id FROM native_index WHERE home=?').all(home))if(!ids.has(old.id)){
            this.store.session(home,old.id,{archived:1});
            this.store.db.prepare('DELETE FROM native_index WHERE home=? AND id=?').run(home,old.id);
            for(const [path,context] of this.files)if(context.home===home&&context.session===old.id)this.files.delete(path);
          }
          for (const row of rows) {
            this.store.db.prepare('INSERT OR IGNORE INTO native_index VALUES(?,?)').run(home,row.id);
            this.store.session(home, row.id, { title: row.title ?? '', cwd: row.cwd, archived: row.archived });
            // Historical zstd rollouts are immutable archives, never JSONL input streams.
            if (row.rollout_path.endsWith('.jsonl') && existsSync(row.rollout_path)) this.files.set(row.rollout_path, { home, session: row.id });
          }
        } finally { db.close(); }
      }
      // Also discover CLI sessions before (or without) native SQLite indexing. All projects/sources.
      const root = join(home, 'sessions');
      if (existsSync(root)) for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
        const path = join(entry.parentPath, entry.name);
        if (this.files.has(path)) continue;
        const id = entry.name.match(/([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl$/i)?.[1];
        if (id) { this.files.set(path, { home, session: id }); this.store.session(home, id); }
      }
    }
    this.health.files = this.files.size;
    this.lastDiscovery = Date.now();
  }
  scan({ discover = true } = {}) {
    this.health.errors = [];
    if (discover && Date.now() - this.lastDiscovery >= 15_000) {
      try { this.discover(); } catch (e) { this.health.errors.push(`discovery: ${e.message}`); }
    }
    for (const [path, context] of this.files) {
      try { this.read(path, context); }
      catch (e) { this.health.errors.push(`${context.session}: ${e.message}`); }
    }
    for (const home of this.homes) {
      try { this.scanProjection(home); }
      catch (e) { this.health.errors.push(`projection: ${e.message}`); }
    }
    return this.health;
  }
  scanProjection(home) {
    const path = join(home, 'thread_history_1.sqlite');
    if (!existsSync(path)) return;
    const db = new DatabaseSync(path, { readOnly: true });
    const since = Number(this.store.meta('startedAt'));
    try {
      const turns = db.prepare(`SELECT thread_id,turn_id,status,error_json,started_at,completed_at,final_agent_item_id
        FROM thread_turns WHERE started_at>=? OR completed_at>=? OR status='inProgress' ORDER BY started_at,turn_id`)
        .all(Math.floor(since / 1000), Math.floor(since / 1000));
      for (const t of turns) {
        // The state index supplies the global title/path/archival metadata.
        const s = this.store.session(home, t.thread_id);
        const base = { home, session:t.thread_id, turn:t.turn_id };
        const start = Number(t.started_at) * 1000;
        if (start && start < since && s.last_start <= start)
          this.store.db.prepare('UPDATE sessions SET turn_id=?,last_start=? WHERE key=?').run(t.turn_id,start,s.key);
        else if (start >= since) this.store.ingest({...base,id:`projection:${s.key}:${t.turn_id}:start`,at:start,type:'start'});
        const completed = Number(t.completed_at) * 1000;
        if (completed >= since) {
          let content = '';
          if (t.final_agent_item_id) {
            const item=db.prepare('SELECT item_json FROM thread_items WHERE thread_id=? AND item_id=? AND turn_id=?')
              .get(t.thread_id,t.final_agent_item_id,t.turn_id);
            if (item) content=JSON.parse(item.item_json).text ?? '';
          }
          if (t.status === 'completed') this.store.ingest({...base,id:`projection:${s.key}:${t.turn_id}:complete`,at:completed,type:'complete',content});
          else if (t.status === 'interrupted') this.store.ingest({...base,id:`projection:${s.key}:${t.turn_id}:stop`,at:completed,type:'stop'});
          else if (t.status === 'failed') {
            this.store.ingest({...base,id:`projection:${s.key}:${t.turn_id}:stop`,at:completed,type:'stop'});
            const error=t.error_json?JSON.parse(t.error_json):{};
            this.store.ingest({...base,id:`projection:${s.key}:${t.turn_id}:failed`,at:completed,type:'wait',kind:'failed',request:'error',content:error.message || content || '执行失败'});
          }
        }
      }
      for (const item of db.prepare(`SELECT thread_id,turn_id,item_id,created_at_ms,item_json FROM thread_items
        WHERE item_type='userMessage' AND created_at_ms>=? ORDER BY created_at_ms`).all(since)) {
        this.store.ingest({id:`projection:${sessionKey(home,item.thread_id)}:${item.item_id}:reply`,home,session:item.thread_id,
          turn:item.turn_id,at:item.created_at_ms,type:'reply'});
      }
      // A process id is evidence that a command was launched after approval, even if it still runs.
      for (const item of db.prepare(`SELECT thread_id,turn_id,item_id,created_at_ms,item_json FROM thread_items
        WHERE item_type='commandExecution' AND created_at_ms>=?`).all(since)) {
        const j=JSON.parse(item.item_json);
        if(j.processId != null || ['completed','failed','declined'].includes(j.status))
          this.store.ingest({id:`projection:${sessionKey(home,item.thread_id)}:${item.item_id}:resolved`,home,session:item.thread_id,
            turn:item.turn_id,at:Date.now(),type:'resolved',request:item.item_id});
      }
    } finally { db.close(); }
  }
  read(path, { home, session }) {
    if (!existsSync(path)) return;
    const stat = statSync(path); const identity = `${stat.dev}:${stat.ino}`;
    let cursor = this.store.db.prepare('SELECT * FROM cursors WHERE path=?').get(path);
    if (cursor && cursor.identity === identity && cursor.offset === stat.size) return;
    let offset = cursor && cursor.identity === identity && cursor.offset <= stat.size ? cursor.offset : 0;
    const fd = openSync(path, 'r');
    try {
      // Skip old history on first discovery, but reconstruct turn context from a bounded tail.
      const initial = !cursor && stat.mtimeMs < Number(this.store.meta('startedAt'));
      const tailBytes = Math.min(this.maxChunkBytes, 256 * 1024);
      if (initial && stat.size > tailBytes) offset = stat.size - tailBytes;
      let skipFirst = offset > 0 && !cursor;
      while (offset < stat.size) {
        const buffer = Buffer.alloc(Math.min(this.maxChunkBytes, stat.size - offset));
        const count = readSync(fd, buffer, 0, buffer.length, offset);
        const bytes = buffer.subarray(0, count); const lastNewline = bytes.lastIndexOf(10);
        if (lastNewline < 0) {
          if (count === this.maxChunkBytes) throw new Error('Rollout record exceeds read limit');
          break; // Writer has not completed the final JSON line yet.
        }
        const complete = bytes.subarray(0, lastNewline + 1);
        // Replaying after a crash is safe: event IDs include the native file identity and byte offset.
        let position = offset;
        for (const line of complete.toString('utf8').split('\n').slice(0, -1)) {
          const start = position; position += Buffer.byteLength(line) + 1;
          if (skipFirst) { skipFirst = false; continue; }
          let record;
          try { record = JSON.parse(line); } catch { throw new Error(`Invalid rollout JSON at byte ${start}`); }
          if (record.type === 'session_meta') this.store.session(home, session, { cwd: record.payload?.cwd ?? '' });
          consumeRecord(this.store, home, session, record, digest(`${path}\0${identity}\0${start}`));
        }
        offset += complete.length;
        this.store.db.prepare('INSERT OR REPLACE INTO cursors VALUES(?,?,?)').run(path, offset, identity);
        cursor = { offset, identity };
      }
    } finally { closeSync(fd); }
  }
  drainHooks(spool) {
    const events = [];
    for (const name of readdirSync(spool).filter(n => n.endsWith('.json'))) {
      const path = join(spool, name); const data = JSON.parse(readFileSync(path, 'utf8'));
      events.push({ path, data });
    }
    for (const {path, data} of events.sort((a,b) => a.data.at - b.data.at)) {
      if (!this.homes.includes(resolve(data.home))) throw new Error('Hook from an unconfigured Codex home');
      consumeHook(this.store, resolve(data.home), data.hook, data.id, data.at);
      unlinkSync(path);
    }
  }
}
