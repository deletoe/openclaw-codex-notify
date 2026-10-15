#!/usr/bin/env node
import { readdirSync, readFileSync, existsSync, lstatSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const excluded = new Set(['.git', 'node_modules', 'dist', '.local']);
const findings = [];
const sourceFiles = [];
function walk(dir) {
  for (const item of readdirSync(join(root, dir), { withFileTypes: true })) {
    if (excluded.has(item.name)) continue;
    const name = join(dir, item.name);
    if (item.isSymbolicLink()) { findings.push(`${name}: unexpected symlink`); continue; }
    if (item.isDirectory()) walk(name); else sourceFiles.push(name);
  }
}
walk('');
const secretRules = [
  ['private key', /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/],
  ['GitHub credential', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/],
  ['API credential', /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/],
  ['JWT credential', /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{15,}\b/],
  ['personal macOS path', /\/Users\/(?!test(?:\/|\b)|example(?:\/|\b)|USER(?:\/|\b)|USERNAME(?:\/|\b))[^\s/'"`]+/],
  ['private network address', /\b(?:192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/],
];
const privateName = /(?:^|\/)(?:operator|pairing|gateway|health)\.json$|\.(?:sqlite(?:-\w+)?|db|pem|key|log)$|(?:^|\/)\.env(?:\.|$)/;
const sourceAllowed = /^(?:\.gitignore|\.github\/workflows\/[^/]+\.ya?ml|package(?:-lock)?\.json|npm-shrinkwrap\.json|openclaw\.plugin\.json|index\.mjs|cli\.mjs|bin\.mjs|README(?:\.zh-CN)?\.md|LICENSE|SECURITY\.md|(?:src|scripts|test)\/.+\.mjs|scripts\/notify-permissions\.jxa|docs\/[^/]+\.md|skills\/codex-notify-reply\/SKILL\.md|examples\/config\.example\.json)$/;
for (const name of sourceFiles) {
  if (!sourceAllowed.test(name)) findings.push(`${name}: unexpected publication source file`);
  if (privateName.test(name)) findings.push(`${name}: private runtime filename`);
  if (lstatSync(join(root, name)).size > 2 * 1024 * 1024) { findings.push(`${name}: unexpected large file`); continue; }
  const text = readFileSync(join(root, name), 'utf8');
  for (const [label, pattern] of secretRules) if (pattern.test(text)) findings.push(`${name}: ${label}`);
  if (name.endsWith('.md')) {
    for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = match[1].split('#')[0];
      if (!target || /^(?:https?:|mailto:)/.test(target)) continue;
      if (!existsSync(resolve(root, dirname(name), target))) findings.push(`${name}: broken relative link ${target}`);
    }
  }
}
const pack = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))[0];
const allowed = /^(?:package\.json|openclaw\.plugin\.json|npm-shrinkwrap\.json|index\.mjs|cli\.mjs|bin\.mjs|README(?:\.zh-CN)?\.md|LICENSE|SECURITY\.md|(?:src|scripts|docs|skills|examples)\/)/;
for (const { path } of pack.files) if (!allowed.test(path) || privateName.test(path)) findings.push(`${path}: unexpected npm archive entry`);
if (findings.length) { console.error(findings.join('\n')); process.exit(1); }
console.log(`Public source and package audit passed (${sourceFiles.length} source files, ${pack.files.length} archive entries).`);
