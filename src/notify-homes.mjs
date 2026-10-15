import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

// Read only this login user's process inventory; never log process environments.
export function discoverHomes(configured = [join(homedir(), '.codex')], { listProcesses } = {}) {
  const homes = new Set(configured.map(p => resolve(p)));
  try {
    const processes = listProcesses ? listProcesses() : execFileSync('/bin/ps',
      ['eww', '-U', String(process.getuid()), '-o', 'command='], { encoding:'utf8', maxBuffer:32*1024*1024 });
    for (const line of processes.split('\n')) {
      if (!/^\s*(?:\S*\/codex\s|codex\s|(?:\S*\/)?node\s+\S*\/codex\s)/.test(line)) continue;
      const home = line.match(/(?:^|\s)CODEX_HOME=(.*?)(?=\s[A-Za-z_][A-Za-z0-9_]*=|$)/)?.[1];
      if (home && existsSync(home)) homes.add(resolve(home));
    }
  } catch {
    // Explicit homes remain usable when process inventory is restricted.
  }
  return [...homes];
}
