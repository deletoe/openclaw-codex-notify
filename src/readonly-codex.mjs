import { spawn } from 'node:child_process';
import { existsSync, realpathSync, accessSync, constants, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { BridgeError } from './errors.mjs';

const READ_METHODS = new Set(['thread/list', 'thread/read']);
const executable = path => { try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; } };
export function discoverCodexCli({ binary, path = process.env.PATH ?? '' } = {}) {
  if (binary) {
    if (!isAbsolute(binary) || !executable(binary)) throw new BridgeError('CODEX_NOT_FOUND', 'Configured Codex CLI must be an executable absolute path.');
    return binary;
  }
  const candidates = [...path.split(':').filter(isAbsolute).map(dir => join(dir, 'codex')), '/opt/homebrew/bin/codex', '/usr/local/bin/codex'];
  const found = candidates.find(executable);
  if (!found) throw new BridgeError('CODEX_NOT_FOUND', 'Codex CLI was not found. Set replies.cliBinary to its executable absolute path.');
  return found;
}
export function discoverCodex(config = {}) {
  if (config.binary) {
    if (!isAbsolute(config.binary) || !existsSync(config.binary)) throw new BridgeError('CODEX_NOT_FOUND', 'Configured local Codex binary does not exist.');
    return config.binary;
  }
  // Use the native App distribution so its reader tracks App storage changes.
  const candidates = [
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
    '/Applications/Codex.app/Contents/Resources/codex',
    join(homedir(), 'Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex')
  ];
  const binary = candidates.find(p => existsSync(p));
  return binary ?? discoverCodexCli();
}

// This client cannot send arbitrary RPCs. No prompt, turn, resume, fork or mutation path.
export class ReadOnlyRpc {
  constructor({ binary, prefixArgs = [], codexHome = join(homedir(), '.codex'), cwd, timeoutMs = 12000, maxBytes = 8 * 1024 * 1024 }) {
    this.options = { binary, prefixArgs, codexHome, cwd, timeoutMs, maxBytes };
  }
  async call(method, params) {
    if (!READ_METHODS.has(method)) throw new BridgeError('READ_ONLY_METHOD', `RPC ${method} is not allowed by the read-only client.`);
    const { binary, prefixArgs, codexHome, cwd, timeoutMs, maxBytes } = this.options;
    return new Promise((resolve, reject) => {
      let done = false, buffer = '', bytes = 0, timer, child;
      const finish = (error, result) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        child?.stdin.end();
        child?.kill('SIGTERM');
        // A stalled App Server cannot leave this read hanging indefinitely.
        if (child) { const killer = setTimeout(() => child.kill('SIGKILL'), 1000); killer.unref(); child.once('exit', () => clearTimeout(killer)); }
        error ? reject(error) : resolve(result);
      };
      const send = payload => { if (!done) child.stdin.write(JSON.stringify(payload) + '\n'); };
      try {
        child = spawn(binary, [...prefixArgs, '-c', 'sandbox_mode="read-only"', 'app-server', '--listen', 'stdio://'], {
          cwd, stdio: ['pipe','pipe','pipe'],
          // Do not inherit App IPC, caller identities, API keys or gateway credentials.
          env: { HOME: homedir(), CODEX_HOME: codexHome, PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin', TMPDIR: tmpdir(), LANG: 'en_US.UTF-8' }
        });
      } catch { finish(new BridgeError('CODEX_START_FAILED', 'Could not launch the local read-only Codex client.')); return; }
      child.on('error', () => finish(new BridgeError('CODEX_START_FAILED', 'Could not launch the local read-only Codex client.')));
      child.stdin.on('error', () => finish(new BridgeError('CODEX_PIPE_CLOSED', 'Local Codex closed the read-only transport.')));
      child.stderr.on('data', () => {}); // Drain diagnostics; do not expose possible native secrets.
      child.on('exit', () => finish(new BridgeError('CODEX_CLOSED', 'Read-only Codex exited before answering.')));
      timer = setTimeout(() => finish(new BridgeError('CODEX_TIMEOUT', 'Read-only Codex request timed out; no mutation was issued.')), timeoutMs);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', data => {
        bytes += Buffer.byteLength(data, 'utf8');
        if (bytes > maxBytes) { finish(new BridgeError('READ_LIMIT', 'Native result exceeded the bounded read budget.')); return; }
        buffer += data;
        while (buffer.includes('\n') && !done) {
          const index = buffer.indexOf('\n');
          const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
          if (!line.trim()) continue;
          let message;
          try { message = JSON.parse(line); }
          catch { finish(new BridgeError('CODEX_PROTOCOL', 'Native Codex returned invalid JSON.')); break; }
          // Never act on server tool/approval requests, even if the protocol changes.
          if (message.method && message.id !== undefined) {
            send({ id: message.id, error: { code: -32601, message: 'This client supports read-only responses only.' } });
            continue;
          }
          if (message.id !== 1 && message.id !== 2) continue;
          if (message.error) { finish(new BridgeError('CODEX_RPC_ERROR', `Codex rejected ${message.id === 1 ? 'initialize' : method} (code ${message.error.code}); update the isolated reader adapter if its schema changed.`)); break; }
          if (!Object.hasOwn(message, 'result')) { finish(new BridgeError('CODEX_PROTOCOL', 'Missing native result.')); break; }
          if (message.id === 1) {
            send({ method: 'initialized', params: {} });
            send({ id: 2, method, params });
          } else finish(null, message.result);
        }
      });
      send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'openclaw_connect_readonly', version: '0.2.0' } } });
    });
  }
}
function samePath(a, b) { try { return realpathSync(a) === realpathSync(b); } catch { return false; } }
function summary(thread) {
  return { threadId: thread.id, title: thread.name ?? thread.title ?? null, source: thread.source ?? null,
    cwd: thread.cwd, historyMode: thread.historyMode ?? null, createdAt: thread.createdAt, updatedAt: thread.updatedAt,
    readerStatus: thread.status ?? null,
    activity: thread.status?.type === 'notLoaded' ? 'unknown' : 'observed-by-reader-only' };
}
export class ReadOnlyCodex {
  constructor(config, { rpc } = {}) {
    this.config = config;
    this.rpc = rpc;
  }
  client() {
    if (!this.rpc) this.rpc = new ReadOnlyRpc({ binary: discoverCodex(this.config.readonlyCodex),
      codexHome: this.config.readonlyCodex?.home ?? join(homedir(), '.codex'), cwd: this.config.project.path });
    return this.rpc;
  }
  async list({ limit = 20, cursor } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 2048))) {
      throw new BridgeError('INVALID_INPUT', 'Use limit 1..100 and a bounded native cursor.');
    }
    // Paginated App-created threads may exist only in the native state index.
    const data = await this.client().call('thread/list', { cwd: this.config.project.path, sourceKinds: [], useStateDbOnly: true, limit, ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(data?.data)) throw new BridgeError('CODEX_SCHEMA_CHANGED', 'thread/list result does not match the reader adapter.');
    return { transport: 'codex-cli-app-server-readonly', project: this.config.project,
      sessions: data.data.filter(t => samePath(t.cwd, this.config.project.path)).map(summary), nextCursor: data.nextCursor ?? null,
      activityNotice: 'A separate reader cannot establish whether Codex App is running a turn. notLoaded does not mean idle.' };
  }
  async read(threadId, { limit = 10, maxTextChars = 12000, prioritizeUserInput = false } = {}) {
    if (typeof threadId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(threadId) || !Number.isInteger(limit) || limit < 1 || limit > 50 || !Number.isInteger(maxTextChars) || maxTextChars < 1 || maxTextChars > 30000 || typeof prioritizeUserInput!=='boolean') {
      throw new BridgeError('INVALID_INPUT', 'Invalid thread ID or read budget.');
    }
    // Verify scope using metadata before requesting any conversation content.
    const metadata = await this.client().call('thread/read', { threadId, includeTurns: false });
    this.verify(metadata?.thread, threadId);
    const data = await this.client().call('thread/read', { threadId, includeTurns: true });
    const thread = data?.thread;
    this.verify(thread, threadId);
    if (!Array.isArray(thread.turns)) throw new BridgeError('CODEX_SCHEMA_CHANGED', 'No compatible turn array in thread/read; a paging adapter is required.');
    let budget = maxTextChars;
    const clipped = text => { const value = String(text ?? ''); const result = value.slice(0, budget); budget -= result.length; return { text: result, truncated: result.length < value.length }; };
    const selected=thread.turns.slice(-limit),userClips=new Map();
    const userText=item=>(item.content??[]).filter(c=>c.type==='text').map(c=>c.text).join('\n');
    // Input-delivery verification must not lose the human prompt behind a large final report.
    if(prioritizeUserInput)for(const turn of [...selected].reverse())for(const item of [...(turn.items??[])].reverse())if(item.type==='userMessage')userClips.set(item,clipped(userText(item)));
    // Spend the text budget on newest messages first, then restore chronological order.
    const turns = selected.reverse().map(turn => ({ turnId: turn.id, status: turn.status,
      messages: [...(turn.items ?? [])].reverse().filter(i => i.type === 'agentMessage' || i.type === 'userMessage').map(item => {
        const text = item.type === 'agentMessage' ? item.text : userText(item);
        return { role: item.type === 'agentMessage' ? 'assistant' : 'user', phase: item.phase ?? null, ...(userClips.get(item)??clipped(text)) };
      }).reverse() })).reverse();
    return { transport: 'codex-cli-app-server-readonly', ...summary(thread), configuredProjectId: this.config.project.projectId, scope: 'canonical-cwd', turns,
      responses: turns.flatMap(t => t.messages.filter(m => m.role === 'assistant' && m.phase === 'final_answer').map(m => m.text)),
      hasOlderTurns: thread.turns.length > limit, textTruncated: turns.some(t => t.messages.some(m => m.truncated)),
      activityNotice: 'readerStatus is process-local. Do not use it as authorization to write, resume or interrupt the App session.' };
  }
  verify(thread, requestedId) {
    if (!thread || thread.id !== requestedId || !samePath(thread.cwd, this.config.project.path)) {
      throw new BridgeError('WRONG_TARGET', 'Native thread does not belong to the configured App project path.');
    }
  }
}
