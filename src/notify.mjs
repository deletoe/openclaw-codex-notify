#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, hostname } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createServer, createConnection } from 'node:net';
import { NotifyStore } from './notify-store.mjs';
import { NativeSource } from './notify-source.mjs';
import { GatewaySender, deliverDue } from './notify-gateway.mjs';
import { discoverHomes } from './notify-homes.mjs';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const defaultConfigPath = join(root, '.local', 'notify', 'config.json');
export function loadNotifyConfig(path = process.env.CODEX_NOTIFY_CONFIG ?? defaultConfigPath) {
  const c = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  return { stateDir: resolve(c.stateDir ?? join(root, '.local', 'notify')),
    pollMs: c.pollMs ?? 5000, gateway: c.gateway ?? {}, device: c.device ?? deviceName(), ...c,
    codexHomes: discoverHomes(c.codexHomes ?? [join(homedir(), '.codex')]) };
}
function deviceName() { try { return execFileSync('/usr/sbin/scutil', ['--get','ComputerName'], { encoding:'utf8' }).trim(); } catch { return hostname(); } }
async function singleton(socket) {
  if (existsSync(socket)) {
    const alive = await new Promise(resolve => {
      const s = createConnection(socket); s.setTimeout(500);
      s.once('connect', () => { s.destroy(); resolve(true); });
      s.once('error', () => resolve(false)); s.once('timeout', () => { s.destroy(); resolve(true); });
    });
    if (alive) throw new Error('Notification service is already running');
    unlinkSync(socket);
  }
  const server = createServer(s => s.end());
  await new Promise((resolve,reject) => { server.once('error',reject); server.listen(socket, resolve); });
  return server;
}
export async function runService(c) {
  mkdirSync(c.stateDir, { recursive: true, mode: 0o700 });
  const lock = await singleton(join(c.stateDir, 'service.sock'));
  const store = new NotifyStore(c.stateDir);
  const spool = join(c.stateDir, 'spool'); mkdirSync(spool, { recursive: true, mode: 0o700 });
  store.recover();
  const source = new NativeSource(store, c.codexHomes); const sender = new GatewaySender(c.gateway);
  let stopped = false;
  const stop = () => { stopped = true; };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  const ingest = () => {
    source.homes = discoverHomes(source.homes);
    source.health.homes = source.homes.length;
    source.health.hookInstallCheckRequired = source.homes.filter(h=>!c.codexHomes.includes(h));
    source.scan(); source.drainHooks(spool);
    // Require a healthy native scan before sending: stale monitoring must not turn into a false alert.
    if (source.health.errors.length) throw new Error('Native source scan failed; delivery deferred');
  };
  try {
    while (!stopped) {
      let error = null; let delivery = null;
      try { ingest(); delivery = await deliverDue(store, sender, { device: c.device, beforeSend: ingest }); }
      catch (e) { error = e.message; }
      const health = { at: new Date().toISOString(), pid: process.pid, source: source.health,
        gatewayConfigured: sender.configured(), delivery, error,
        states: store.db.prepare('SELECT state,count(*) count FROM reminders GROUP BY state').all() };
      const path = join(c.stateDir, 'health.json'); writeFileSync(path, JSON.stringify(health,null,2), { mode: 0o600 });
      await new Promise(resolve => { const timer = setTimeout(resolve, c.pollMs); const wake = () => { clearTimeout(timer); resolve(); };
        process.once('SIGTERM', wake); process.once('SIGINT', wake); timer.unref?.();
        // Socket keeps the process alive; remove temporary handlers after each sleep.
        setTimeout(() => { process.removeListener('SIGTERM',wake); process.removeListener('SIGINT',wake); }, c.pollMs).unref(); });
    }
  } finally { lock.close(); store.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const c = loadNotifyConfig(); const [command, arg] = process.argv.slice(2);
  try {
    if (command === 'run') await runService(c);
    else {
      const store = new NotifyStore(c.stateDir);
      try {
        if (command === 'status') console.log(JSON.stringify({ config: { codexHomes:c.codexHomes, device:c.device,
          gatewayConfigured:new GatewaySender(c.gateway).configured() }, health: existsSync(join(c.stateDir,'health.json')) ? JSON.parse(readFileSync(join(c.stateDir,'health.json'),'utf8')) : null,
          reminders:store.list() },null,2));
        else if (command === 'ack' && arg) console.log(JSON.stringify({ cancelled:store.acknowledge(arg) }));
        else throw new Error('Usage: notify run|status|ack <reminder-id>');
      } finally { store.close(); }
    }
  } catch (e) { console.error(e.message); process.exitCode=1; }
}
