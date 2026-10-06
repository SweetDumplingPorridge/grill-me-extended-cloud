import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { zipSync } from 'fflate';

const root = path.resolve(import.meta.dirname, '..');
const names = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root }).toString().split('\0').filter(Boolean);
for (const file of ['server/dist/index.mjs', 'server/dist/http.mjs', 'web/dist/app.js']) if (!names.includes(file)) names.push(file);
const files = {};
for (const name of names) {
  if (name.split('/').some(segment => ['node_modules', 'data', 'releases', 'artifacts', '.git'].includes(segment)) || (name.startsWith('.env') && name !== '.env.example') || name === '.mcp.json') throw new Error(`Refusing to package private/runtime file ${name}`);
  files[`grill-me-extended-cloud/${name}`] = new Uint8Array(await readFile(path.join(root, name)));
}
await mkdir(path.join(root, 'releases'), { recursive: true });
const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
const name = `grill-me-extended-cloud-${version}.zip`;
const buffer = zipSync(files, { level: 6 });
await writeFile(path.join(root, 'releases', name), buffer);
const digest = createHash('sha256').update(buffer).digest('hex');
await writeFile(path.join(root, 'releases', name + '.sha256'), `${digest}  ${name}\n`);
console.log(`Packaged ${names.length} files: releases/${name} (${buffer.length} bytes)`);
