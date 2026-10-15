import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { checkPermissions, permissionAssessment } from '../src/notify-permissions.mjs';

const source = readFileSync(new URL('../scripts/notify-permissions.jxa', import.meta.url), 'utf8');
function nativeProbe({ codes = [0], trusted = true, grantAx = false, count = 1, windows = 1, uiError = false } = {}, argv = []) {
  const calls = [];
  const app = { processIdentifier: 123, localizedName: 'ChatGPT' };
  let ax = trusted;
  const dollar = Object.assign(value => value, {
    NSRunningApplication: { runningApplicationsWithBundleIdentifier(id) { calls.push(['identify', id]); return { count, objectAtIndex: () => app }; } },
    NSAppleEventDescriptor: { descriptorWithBundleIdentifier: () => ({ aeDesc: {} }) },
    AEDeterminePermissionToAutomateTarget(_desc, _cls, _event, ask) { calls.push(['automation', ask]); return codes.length > 1 ? codes.shift() : codes[0]; },
    AXIsProcessTrusted: () => ax,
    AXIsProcessTrustedWithOptions(options) { calls.push(['requestAx', options]); ax = grantAx; return ax; },
  });
  const sandbox = { $: dollar, ObjC: { import() {}, bindFunction() {}, unwrap: value => value }, Application(id) {
    calls.push(['ui', id]);
    if (uiError) throw new Error('Permission denied');
    return { processes: { whose: () => () => [{ unixId: () => 123, windows: () => Array.from({ length: windows }, () => ({ role: () => 'AXWindow', size: () => [800, 600] })) }] } };
  } };
  vm.createContext(sandbox);vm.runInContext(source, sandbox);
  return { result: JSON.parse(sandbox.run(argv)), calls };
}

test('JXA preflight does not prompt or read App UI; bundle identity accepts process named ChatGPT', () => {
  const { result, calls } = nativeProbe({ trusted: false, codes: [-1744] });
  assert.equal(result.target.bundleId, 'com.openai.codex');assert.equal(result.target.processName, 'ChatGPT');
  assert.equal(result.accessibility, 'not_granted');assert.equal(result.automation.state, 'consent_required');
  assert.equal(calls.some(c => c[0] === 'requestAx' || c[0] === 'ui' || c[0] === 'automation' && c[1]), false);
});
test('explicit request records asynchronous AX as incomplete, not granted just because a prompt ran', () => {
  const { result, calls } = nativeProbe({ trusted: false, codes: [-1744, 0] }, ['--request', '--verify']);
  assert.deepEqual(result.requestAttempted, ['accessibility', 'automation']);
  assert.equal(result.accessibility, 'not_granted');assert.equal(result.uiProbe.state, 'blocked');
  assert.equal(calls.some(c => c[0] === 'ui'), false);assert.equal(permissionAssessment(result).grantsReadyForCurrentExecutor, false);
});
test('known Automation denial stops requests and UI calls; absent System Events is a different state', () => {
  const { result, calls } = nativeProbe({ trusted: false, codes: [-1743] }, ['--request', '--verify']);
  assert.equal(result.automation.state, 'denied');assert.deepEqual(result.requestAttempted, []);
  assert.equal(calls.some(c => c[0] === 'requestAx' || c[0] === 'ui'), false);
  assert.equal(nativeProbe({ codes: [-600] }).result.automation.state, 'target_not_running');
});
test('already-granted setup does not ask again; read probe never claims input or session verification', () => {
  const { result, calls } = nativeProbe({}, ['--request', '--verify']);
  assert.deepEqual(result.requestAttempted, []);assert.equal(result.inputAttempted, false);
  assert.equal(calls.filter(c => c[0] === 'ui').length, 1);
  assert.deepEqual(permissionAssessment(result), { grantsReadyForCurrentExecutor: true, uiReadVerifiedForCurrentExecutor: true,
    inputCapabilityVerified: false, sessionRoutingVerified: false, status: 'read_only_probe_passed' });
});
test('UI errors, ambiguous App identity and absent windows cannot pass verification', () => {
  for (const fixture of [{ uiError: true }, { count: 2 }, { count: 0 }, { windows: 0 }]) {
    const { result, calls } = nativeProbe(fixture, ['--verify']);
    assert.equal(permissionAssessment(result).uiReadVerifiedForCurrentExecutor, false);
    if (fixture.count !== undefined) assert.equal(calls.some(c => c[0] === 'ui'), false);
  }
});
test('default command returns official guide without starting any process; explicit route required', async () => {
  const run = async () => { throw new Error('unexpected subprocess'); };
  assert.equal((await checkPermissions({}, { run })).status, 'choose_existing_provider');
  await assert.rejects(checkPermissions({ request: true }, { run }), /explicitly/);
  await assert.rejects(checkPermissions({ backend: 'jxa' }, { run, platform: 'linux' }), /target Mac/);
});
test('preflight is bounded, has no open side effect and exposes current executor scope only', async () => {
  const calls = [];
  const result = await checkPermissions({ backend: 'jxa', packageRoot: '/plugin with spaces' }, { platform: 'darwin', context: () => ({ verificationScope: 'current_executor_only' }),
    run: async (file, args, options) => { calls.push({ file, args, options }); return { stdout: JSON.stringify(nativeProbe().result) }; } });
  assert.equal(calls.length, 1);assert.equal(calls[0].file, '/usr/bin/osascript');
  assert.ok(calls[0].args.includes('/plugin with spaces/scripts/notify-permissions.jxa'));assert.equal(calls[0].options.timeout, 15000);
  assert.equal(result.execution.verificationScope, 'current_executor_only');assert.equal(result.uiReadVerifiedForCurrentExecutor, false);
});
test('explicit requests are bounded; timeout never reports grants or retries', async () => {
  const calls = [];
  const result = await checkPermissions({ backend: 'jxa', request: true, verify: true }, { platform: 'darwin', context: () => ({}), run: async (file, args, options) => {
    calls.push({ file, args, options });if (file === '/usr/bin/osascript') throw new Error('timed out');return { stdout: '' };
  } });
  assert.equal(calls.length, 2);assert.deepEqual(calls[0].args, ['-g', '-b', 'com.apple.systemevents']);
  assert.equal(calls[1].options.timeout, 55000);assert.ok(calls[1].args.includes('--verify'));
  assert.equal(result.status, 'probe_failed_or_timed_out');assert.equal(result.inputAttempted, false);
});
test('settings opens only by explicit selection while a grant is missing', async () => {
  const calls = [];
  const result = await checkPermissions({ backend: 'jxa', openSettings: true }, { platform: 'darwin', context: () => ({}), run: async (file, args) => {
    calls.push([file, args]);return { stdout: JSON.stringify(nativeProbe({ trusted: false }).result) };
  } });
  assert.equal(result.settingsOpened, 'Accessibility');assert.equal(calls.length, 2);
  assert.equal(calls[1][1][0], 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
});
