import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const execute = promisify(execFile);
export const permissionGuide = {
  recommended: 'Use a signed OpenClaw.app or dedicated signed UI helper with a stable bundle ID and path.',
  nativeSetup: 'OpenClaw.app → Dashboard → Settings → This Mac → Permissions; enable Computer Control if that is the selected provider.',
  documentation: 'https://docs.openclaw.ai/platforms/mac/permissions',
  currentJxaRoute: 'Run permissions --backend jxa through the same Mac node executor used for App input. Explicit --request requests missing grants; --verify reads window structure without typing.',
  scope: 'A Terminal or Codex result does not prove the OpenClaw node is authorized. macOS chooses the responsible app; process ancestry is diagnostic evidence, not proof of TCC ownership.',
  sharedRuntime: 'Do not treat a generic node grant as package-specific: it can authorize other code using the same runtime. Prefer the signed app/helper.',
  policy: 'A tool/policy denial stops the operation; do not switch drivers, reset TCC or modify its database to bypass it.',
};

export function permissionAssessment(probe) {
  const grantsReady = probe.accessibility === 'granted' && probe.automation?.state === 'granted';
  const uiReadVerified = grantsReady && probe.target?.bundleId === 'com.openai.codex' && probe.target.runningCount === 1 && probe.uiProbe?.state === 'verified_read_only';
  return { grantsReadyForCurrentExecutor: grantsReady, uiReadVerifiedForCurrentExecutor: uiReadVerified,
    inputCapabilityVerified: false, sessionRoutingVerified: false,
    status: uiReadVerified ? 'read_only_probe_passed' : grantsReady ? 'needs_ui_verification' : probe.automation?.state === 'denied' ? 'denied' : 'needs_permission_or_recheck' };
}

export function executorContext() {
  const ancestors = [];
  let pid = process.pid;
  for (let i = 0; i < 8 && pid > 1; i++) {
    try {
      // Only executable names, never process arguments containing credentials.
      const row = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'ppid=', '-o', 'comm='], { encoding: 'utf8', timeout: 1000 }).trim();
      const match = row.match(/^(\d+)\s+(.+)$/);
      if (!match) break;
      ancestors.push({ pid, executable: match[2] });
      pid = Number(match[1]);
    } catch { break; }
  }
  return { host: hostname(), uid: process.getuid?.(), runtime: process.execPath, ancestors,
    permissionOwner: 'determined_by_macos_not_inferred', verificationScope: 'current_executor_only' };
}

export async function checkPermissions({ backend, request = false, verify = false, openSettings = false, packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..') } = {}, { run = execute, platform = process.platform, context = executorContext } = {}) {
  if (!backend) {
    if (request || verify || openSettings) throw new Error('Select the existing authorized route explicitly with --backend jxa; use OpenClaw.app for native Computer Control grants.');
    return { status: 'choose_existing_provider', guide: permissionGuide };
  }
  if (backend !== 'jxa') throw new Error('Only the existing jxa route is probed here. Use the native OpenClaw permissions page for Computer Control.');
  if (platform !== 'darwin') throw new Error('Run macOS permission setup on the target Mac, not the VPS.');
  const execution = context();
  try {
    // System Events must be running for the public AE permission API. Launch it
    // only for the user's explicit request, without activating the Codex App.
    if (request) await run('/usr/bin/open', ['-g', '-b', 'com.apple.systemevents'], { timeout: 5000 });
    const { stdout } = await run('/usr/bin/osascript', ['-l', 'JavaScript', join(packageRoot, 'scripts', 'notify-permissions.jxa'), ...(request ? ['--request'] : []), ...(verify ? ['--verify'] : [])],
      { timeout: request ? 55000 : 15000, maxBuffer: 256 * 1024, encoding: 'utf8' });
    const probe = JSON.parse(stdout);
    const assessment = permissionAssessment(probe);
    let settingsOpened = null;
    if (openSettings && !assessment.grantsReadyForCurrentExecutor) {
      settingsOpened = probe.accessibility !== 'granted' ? 'Accessibility' : 'Automation';
      await run('/usr/bin/open', [`x-apple.systempreferences:com.apple.preference.security?Privacy_${settingsOpened}`], { timeout: 5000 });
    }
    return { ...assessment, probe, execution, settingsOpened, guide: permissionGuide,
      next: assessment.uiReadVerifiedForCurrentExecutor ? 'Read-only prerequisites passed for this invocation. Real session identity, drafts and input delivery still require separate checks.' : 'Complete the indicated grant in System Settings, then re-run through the same node with --backend jxa --verify. A missing or stopped App/System Events is not a denial.' };
  } catch (error) {
    return { status: 'probe_failed_or_timed_out', grantsReadyForCurrentExecutor: false, uiReadVerifiedForCurrentExecutor: false,
      inputCapabilityVerified: false, inputAttempted: false, execution, guide: permissionGuide,
      error: String(error.stderr || error.message).slice(0, 1500),
      next: 'Stop. Do not assume authorization or retry input. After the user resolves permission/settings, explicitly recheck through the same executor.' };
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { backend: { type: 'string' }, request: { type: 'boolean' }, verify: { type: 'boolean' }, 'open-settings': { type: 'boolean' } } });
  const report = await checkPermissions({ ...values, openSettings: values['open-settings'] });
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== 'choose_existing_provider' && !report.uiReadVerifiedForCurrentExecutor) process.exitCode = 2;
}
