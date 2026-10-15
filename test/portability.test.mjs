import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverCodexCli, ReadOnlyCodex } from '../src/readonly-codex.mjs';
import { SessionInspector } from '../src/notify-session-source.mjs';

test('CLI discovery respects executable absolute config and PATH without an Apple Silicon-specific prefix', t => {
  const root = mkdtempSync(join(tmpdir(), 'notify-cli-location-'));t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'custom tools');mkdirSync(dir);
  const binary = join(dir, 'codex');writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  assert.equal(discoverCodexCli({ path: dir }), binary);
  assert.equal(discoverCodexCli({ binary }), binary);
  assert.throws(() => discoverCodexCli({ binary: 'codex' }), { code: 'CODEX_NOT_FOUND' });
  assert.throws(() => discoverCodexCli({ binary: dir }), { code: 'CODEX_NOT_FOUND' });
  const denied = join(root, 'not-executable');writeFileSync(denied, 'fixture', { mode: 0o600 });
  assert.throws(() => discoverCodexCli({ binary: denied }), { code: 'CODEX_NOT_FOUND' });
});

test('configured native reader is used for both metadata and history inspection', async () => {
  const binary = '/configured/native-reader';
  const original = ReadOnlyCodex.prototype.read;
  let seen;
  ReadOnlyCodex.prototype.read = async function (id) { seen = { binary: this.config.readonlyCodex.binary, home: this.config.readonlyCodex.home, id }; return { threadId: id, turns: [] }; };
  try {
    const target = { home: '/fixture/native-home', cwd: process.cwd(), threadId: 'fixture-thread', title: 'Fixture' };
    const inspector = new SessionInspector({ binary, metadataReader: async () => ({ id: target.threadId, cwd: target.cwd, source: 'exec', originator: 'codex_exec' }) });
    const result = await inspector.inspect(target);
    assert.equal(result.sourceRouting.kind, 'cli');
    assert.deepEqual(seen, { binary, home: target.home, id: target.threadId });
  } finally { ReadOnlyCodex.prototype.read = original; }
});
