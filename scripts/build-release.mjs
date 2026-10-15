#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
execFileSync(process.execPath, [join(root, 'scripts', 'audit-public.mjs')], { cwd: root, stdio: 'inherit' });
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(join(root, 'openclaw.plugin.json'), 'utf8'));
if (pkg.version !== manifest.version) throw new Error('Manifest/package version mismatch');
const dist = join(root, 'dist');mkdirSync(dist, { recursive: true });
const pluginName = `openclaw-codex-notify-${pkg.version}.tgz`;
const skillName = `codex-notify-reply-skill-v${pkg.version}.tgz`;
for (const name of readdirSync(dist)) if (/^(?:openclaw-codex-notify-[\d.]+\.tgz|codex-notify-reply-skill-v[\d.]+\.tgz|SHA256SUMS)$/.test(name)) unlinkSync(join(dist, name));
const packed = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', dist], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))[0];
if (packed.filename !== pluginName) throw new Error('Unexpected package archive name');
// Minimal portable USTAR for the standalone one-file Skill, with anonymous
// owner and stable timestamps; archive metadata must not expose local users.
const body = readFileSync(join(root, 'skills', 'codex-notify-reply', 'SKILL.md'));
const header = Buffer.alloc(512);
const field = (offset, length, value) => header.write(value, offset, length, 'ascii');
const octal = (offset, length, value) => field(offset, length, value.toString(8).padStart(length - 1, '0') + '\0');
field(0, 100, 'codex-notify-reply/SKILL.md');octal(100, 8, 0o644);octal(108, 8, 0);octal(116, 8, 0);octal(124, 12, body.length);octal(136, 12, 0);
header.fill(32, 148, 156);field(156, 1, '0');field(257, 6, 'ustar\0');field(263, 2, '00');field(265, 32, 'root');field(297, 32, 'root');
const checksum = header.reduce((sum, byte) => sum + byte, 0);field(148, 8, checksum.toString(8).padStart(6, '0') + '\0 ');
const tar = Buffer.concat([header, body, Buffer.alloc((512 - body.length % 512) % 512), Buffer.alloc(1024)]);
writeFileSync(join(dist, skillName), gzipSync(tar));
const lines = [pluginName, skillName].map(name => `${createHash('sha256').update(readFileSync(join(dist, name))).digest('hex')}  ${name}`);
writeFileSync(join(dist, 'SHA256SUMS'), lines.join('\n') + '\n');
console.log(`Built ${pluginName}, ${skillName}, SHA256SUMS`);
