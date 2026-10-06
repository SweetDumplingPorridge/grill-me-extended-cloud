import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { zipSync, unzipSync } from 'fflate';

const root = path.resolve(import.meta.dirname, '..');
const plugin = path.join(root, 'plugins/grill-me-extended-chat');
const files = {};
async function walk(folder = '') {
  for (const entry of await readdir(path.join(plugin, folder), { withFileTypes: true })) {
    const name = path.posix.join(folder, entry.name);
    if (entry.isDirectory()) await walk(name);
    else if (entry.isFile()) files[name] = new Uint8Array(await readFile(path.join(plugin, name)));
  }
}
await walk();
const decoder = new TextDecoder('utf-8', { fatal: true });
const manifest = JSON.parse(decoder.decode(files['plugin.json']));
if (manifest.name !== 'grill-me-extended-chat' || !manifest.$schema) throw new Error('Invalid plugin identity');
for (const reference of ['composerIcon', 'logo']) {
  const name = manifest.extensions['com.openai'].interface[reference].replace(/^\.\//, '');
  if (!files[name]) throw new Error(`Missing asset: ${name}`);
}
if (files['mcp.json'] || files['.mcp.json']) throw new Error('Standalone plugin must not require an MCP endpoint');
const skill = decoder.decode(files['skills/grill-me-extended/SKILL.md']);
if (!skill.startsWith('---\nname: grill-me-extended\ndescription:')) throw new Error('Invalid skill header');
for (const name of Object.keys(files)) {
  if (name.includes('..') || name.startsWith('/') || name.includes('\\')) throw new Error(`Unsafe package path: ${name}`);
  decoder.decode(files[name]);
}
const output = path.join(root, 'releases');
await mkdir(output, { recursive: true });
const name = `grill-me-extended-chat-${manifest.version}.zip`;
const buffer = zipSync(files, { level: 6 });
const unpacked = unzipSync(buffer);
if (!unpacked['plugin.json'] || Object.keys(unpacked).length !== Object.keys(files).length) throw new Error('Archive layout mismatch');
await writeFile(path.join(output, name), buffer);
await writeFile(path.join(output, `${name}.sha256`), `${createHash('sha256').update(buffer).digest('hex')}  ${name}\n`);
await writeFile(path.join(output, 'Grill-Me-Extended-Chat.md'), '# 使用方式\n\n请在上传本文件后明确要求 ChatGPT 按下方流程采访并自审。此文件是对话流程附件，不是 MCP 服务或已安装插件。\n\n' + skill);
console.log(`Validated standalone package: ${name}; ${Object.keys(files).length} UTF-8 files, ${buffer.length} bytes. Also wrote Grill-Me-Extended-Chat.md.`);
