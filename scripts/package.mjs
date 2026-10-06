import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { zipSync } from 'fflate';

const root = path.resolve(import.meta.dirname, '..');
let names;
try { names = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }).toString().split('\0').filter(Boolean); }
catch {
  // ZIP users can repackage without a Git checkout. Walk only approved source folders.
  names = ['.gitattributes', '.gitignore', '.dockerignore', '.env.example', 'README.md', 'Dockerfile', 'Caddyfile', 'compose.yaml', 'package.json', 'package-lock.json', 'tsconfig.json', 'playwright.config.ts'];
  const walk = async (folder) => {
    for (const entry of await readdir(path.join(root, folder), { withFileTypes: true })) {
      const name = `${folder}/${entry.name}`;
      if (entry.isDirectory()) await walk(name); else if (entry.isFile()) names.push(name);
    }
  };
  for (const folder of ['server/src', 'server/test', 'web/src', 'web/test', 'scripts', 'skills', 'docs', '.github', '.codex-plugin']) await walk(folder);
}
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
