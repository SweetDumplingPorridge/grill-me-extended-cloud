import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createRemoteApp } from './http.js';

const localDev = process.env.LOCAL_DEV === 'true';
const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 无效');
const app = await createRemoteApp({
  dataRoot: process.env.GRILL_ME_EXTENDED_DATA_DIR ?? path.resolve('data'),
  publicUrl: process.env.PUBLIC_URL ?? `http://127.0.0.1:${port}`,
  downloadSecret: process.env.DOWNLOAD_SECRET ?? (localDev ? randomBytes(32).toString('hex') : ''), localDev,
  githubClientId: process.env.GITHUB_CLIENT_ID, githubClientSecret: process.env.GITHUB_CLIENT_SECRET,
  allowedLogins: process.env.ALLOWED_GITHUB_LOGINS?.split(',').map(s => s.trim()).filter(Boolean),
});
const server = app.listen(port, localDev ? '127.0.0.1' : '0.0.0.0', () => console.error(`Grill Me Extended listening on port ${port} (${localDev ? 'local development' : 'OAuth protected'})`));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(1), 10000).unref(); });
