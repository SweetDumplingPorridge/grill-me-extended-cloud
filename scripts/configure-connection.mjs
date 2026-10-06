import { writeFile } from 'node:fs/promises';
const url = new URL(process.argv[2] ?? '');
if (url.protocol !== 'https:' || url.pathname !== '/mcp' || url.search || url.hash || url.username || url.password) throw new Error('Enter your HTTPS /mcp endpoint without credentials or query parameters');
await writeFile('.mcp.json', JSON.stringify({ mcpServers: { 'grill-me-extended': { url: url.href } } }, null, 2) + '\n');
console.log('Saved .mcp.json. ChatGPT web/mobile connects through the Plugins UI; no local config file is required.');
