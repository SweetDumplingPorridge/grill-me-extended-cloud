import express from 'express';
import { readFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { GithubOAuthProvider } from './auth.js';
import { createMcpServer } from './index.js';
import { RemoteContexts } from './remote.js';
import { validateSettings, type RemoteSettings } from './config.js';

export async function createRemoteApp(settings: RemoteSettings, dependencies: { githubFetch?: typeof fetch } = {}) {
  validateSettings(settings);
  const app = express();
  app.disable('x-powered-by');
  // A single trusted proxy (Caddy or the cloud platform ingress). Never trust arbitrary forwarded headers.
  if (!settings.localDev) app.set('trust proxy', 1);
  const contexts = new RemoteContexts(path.resolve(settings.dataRoot), settings.publicUrl, settings.downloadSecret);
  app.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); next(); });
  app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'grill-me-extended', version: '0.2.0' }));
  app.get('/', (_req, res) => res.type('text').send('Grill Me Extended · 私人需求访谈服务\nMCP endpoint: /mcp\n不调用模型 API。访谈数据保存在部署者服务器的持久磁盘中。'));
  const cookie = (header: string | undefined) => header?.split(';').map(s => s.trim()).find(s => s.startsWith('grill_oauth_state='))?.slice('grill_oauth_state='.length) ?? '';
  if (!settings.localDev) {
    const provider = await GithubOAuthProvider.open({ root: settings.dataRoot, publicUrl: settings.publicUrl, githubClientId: settings.githubClientId!, githubClientSecret: settings.githubClientSecret!, allowedLogins: settings.allowedLogins!, fetcher: dependencies.githubFetch });
    app.use(mcpAuthRouter({ provider, issuerUrl: new URL(settings.publicUrl), resourceServerUrl: new URL('/mcp', settings.publicUrl), scopesSupported: ['interview'], resourceName: 'Grill Me Extended' }));
    app.post('/oauth/consent', express.urlencoded({ extended: false, limit: '4kb' }), (req, res) => {
      try { res.redirect(provider.githubLogin(String(req.body.state ?? ''), cookie(req.headers.cookie))); }
      catch { res.status(400).type('text').send('登录请求已失效，请在 ChatGPT 中重新连接。'); }
    });
    app.get('/oauth/github/callback', async (req, res) => {
      try {
        const redirect = await provider.finishGithub(String(req.query.code ?? ''), String(req.query.state ?? ''), cookie(req.headers.cookie));
        res.clearCookie('grill_oauth_state', { path: '/oauth' }); res.redirect(redirect);
      } catch { res.status(403).type('text').send('登录失败或账号未被允许，请重新连接或联系部署者。'); }
    });
    app.use('/mcp', requireBearerAuth({ verifier: provider, expectedResource: new URL('/mcp', settings.publicUrl), requiredScopes: ['interview'], resourceMetadataUrl: new URL('/.well-known/oauth-protected-resource/mcp', settings.publicUrl).href }));
  }
  app.post('/mcp', express.json({ limit: '1mb' }), async (req, res) => {
    const identity = settings.localDev ? 'local-dev' : req.auth?.extra?.identity;
    if (typeof identity !== 'string') { res.status(401).json({ error: 'unauthorized' }); return; }
    const server = createMcpServer({ remote: contexts.forUser(identity) });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void transport.close(); void server.close(); });
    try { await server.connect(transport); await transport.handleRequest(req, res, req.body); }
    catch { if (!res.headersSent) res.status(500).json({ error: 'MCP_REQUEST_FAILED' }); }
  });
  app.all('/mcp', (_req, res) => res.status(405).set('Allow', 'POST').end());
  app.get('/download', async (req, res) => {
    try {
      const ticket = contexts.verifyDownload(new URL(req.originalUrl, settings.publicUrl));
      const session = await ticket.context.store.get(ticket.sessionId);
      if (session.status !== 'MATERIALIZED') throw new Error('Not materialized');
      const file = path.join(session.workspaceRoot, ticket.name);
      const stat = await lstat(file); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe file');
      res.set('Referrer-Policy', 'no-referrer').set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(ticket.name)}`).type('text/markdown').send(await readFile(file, 'utf8'));
    } catch { res.status(403).type('text').send('下载链接无效或已过期，请在 ChatGPT 中重新获取文档。'); }
  });
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = (error as { status?: number }).status;
    res.status(status === 413 ? 413 : 400).json({ error: status === 413 ? 'REQUEST_TOO_LARGE' : 'INVALID_REQUEST' });
  });
  return app;
}
