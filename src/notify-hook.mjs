#!/usr/bin/env node
// Short local-only hook: append one private spool record, never perform network I/O.
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

try {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 1024 * 1024) throw new Error('Hook input too large');
  }
  const raw = JSON.parse(input);
  // Drop tool results and unrelated environment data before storing the event.
  const hook = Object.fromEntries(['hook_event_name','session_id','turn_id','tool_name','tool_use_id','tool_input','cwd','transcript_path']
    .filter(k => raw[k] !== undefined).map(k => [k, raw[k]]));
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const stateDir = process.env.CODEX_NOTIFY_STATE_DIR ?? join(root, '.local', 'notify');
  const spool = join(stateDir, 'spool'); mkdirSync(spool, { recursive: true, mode: 0o700 });
  const id = randomUUID(); const path = join(spool, `${id}.json`);
  writeFileSync(`${path}.tmp`, JSON.stringify({ id, at: Date.now(), home: resolve(process.env.CODEX_HOME ?? join(homedir(), '.codex')), hook }), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
} catch {
  // Notification collection never changes approval decisions, tool results or the agent loop.
}
process.stdout.write('{}\n');
