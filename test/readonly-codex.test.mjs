import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { ReadOnlyCodex, ReadOnlyRpc } from '../src/readonly-codex.mjs';

const project = { path: realpathSync(process.cwd()), projectId: 'test-project', name: 'openclaw-connect' };
const thread = { id: 'fixture-thread', cwd: project.path, status: { type: 'notLoaded' }, source: 'vscode', turns: [
  { id: 'first', status: 'completed', items: [{ type: 'userMessage', content: [{ type: 'text', text: 'compute' }] }, { type: 'agentMessage', phase: 'final_answer', text: '5' }] },
  { id: 'second', status: 'completed', items: [{ type: 'userMessage', content: [{ type: 'text', text: 'double it' }] }, { type: 'agentMessage', phase: 'final_answer', text: '10' }] }
] };
function transport(scenario, extra = {}) { return new ReadOnlyRpc({ binary: process.execPath, prefixArgs: [resolve('test/fixtures/readonly-server.mjs'),'--scenario',scenario], cwd: process.cwd(), codexHome: tmpdir(), timeoutMs: 1000, ...extra }); }
test('transport sends only initialize/initialized/read RPC; no inherited executor or gateway auth', async () => {
  process.env.OPENCLAW_CONNECT_TEST_SECRET = 'not-forwarded';
  try {
    const result = await transport('success').call('thread/list', { cwd: project.path });
    assert.deepEqual(result.methods, ['initialize','initialized','thread/list']);
    assert.ok(result.args.includes('sandbox_mode="read-only"'));
    assert.ok(!result.envKeys.includes('OPENCLAW_CONNECT_TEST_SECRET'));
    assert.ok(!result.envKeys.includes('CODEX_APP_TOOLS_PIPE_PATH'));
  } finally { delete process.env.OPENCLAW_CONNECT_TEST_SECRET; }
});
test('read-only transport rejects turn/start, resume, metadata writes, shell and deletion before spawn', async () => {
  const rpc = new ReadOnlyRpc({ binary: '/does/not/exist' });
  for (const method of ['thread/start','thread/resume','thread/fork','turn/start','command/exec','thread/archive','thread/delete','thread/metadata/update']) {
    await assert.rejects(rpc.call(method, {}), { code: 'READ_ONLY_METHOD' });
  }
});
test('native protocol failure, drift, oversize and timeout fail without a fallback', async () => {
  await assert.rejects(transport('invalid').call('thread/list', {}), { code: 'CODEX_PROTOCOL' });
  await assert.rejects(transport('reject').call('thread/list', {}), { code: 'CODEX_RPC_ERROR' });
  await assert.rejects(transport('huge', { maxBytes: 1000 }).call('thread/list', {}), { code: 'READ_LIMIT' });
  await assert.rejects(transport('hang', { timeoutMs: 200 }).call('thread/list', {}), { code: 'CODEX_TIMEOUT' });
});
test('reader verifies target metadata before history; notLoaded stays activity unknown', async () => {
  const calls = [];
  const reader = new ReadOnlyCodex({ project }, { rpc: { call: async (method, params) => { calls.push({ method, params }); return { thread }; } } });
  const result = await reader.read(thread.id);
  assert.deepEqual(calls.map(c => c.params.includeTurns), [false,true]);
  assert.ok(calls.every(c => c.method === 'thread/read'));
  assert.deepEqual(result.responses, ['5','10']);
  assert.equal(result.activity, 'unknown');
  assert.equal(result.turns.length, 2);
});
test('another project or different returned thread ID is refused before content is requested', async () => {
  for (const wrong of [{ ...thread, cwd: tmpdir() }, { ...thread, id: 'different-thread' }]) {
    const calls = [];
    const reader = new ReadOnlyCodex({ project }, { rpc: { call: async (method, params) => { calls.push(params); return { thread: wrong }; } } });
    await assert.rejects(reader.read(thread.id), { code: 'WRONG_TARGET' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].includeTurns, false);
  }
});
test('list filters native results to exact project even if server ignores its cwd filter', async () => {
  const reader = new ReadOnlyCodex({ project }, { rpc: { call: async (method, params) => {
    assert.equal(method, 'thread/list'); assert.equal(params.cwd, project.path);
    assert.equal(params.useStateDbOnly, true);
    return { data: [thread, { ...thread, id: 'other-project', cwd: tmpdir() }], nextCursor: 'cursor' };
  } } });
  const result = await reader.list();
  assert.deepEqual(result.sessions.map(t => t.threadId), [thread.id]);
  assert.equal(result.nextCursor, 'cursor');
});
test('bounded reads retain latest answer before old prompt text', async () => {
  const reader = new ReadOnlyCodex({ project }, { rpc: { call: async () => ({ thread }) } });
  const result = await reader.read(thread.id, { maxTextChars: 2 });
  assert.equal(result.responses.at(-1), '10');
  assert.equal(result.textTruncated, true);
});
test('delivery-verification reads preserve the newest human input even behind a long final report',async()=>{
  const input='original human reply';
  const long={...thread,turns:[{id:'new',status:'completed',items:[{type:'userMessage',content:[{type:'text',text:input}]},{type:'agentMessage',phase:'final_answer',text:'x'.repeat(10000)}]}]};
  const reader=new ReadOnlyCodex({project},{rpc:{call:async()=>({thread:long})}});
  const result=await reader.read(thread.id,{maxTextChars:100,prioritizeUserInput:true});
  assert.equal(result.turns[0].messages[0].text,input);assert.equal(result.turns[0].messages[0].truncated,false);
  assert.equal(result.textTruncated,true);
});
