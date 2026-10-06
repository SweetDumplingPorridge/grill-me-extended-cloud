import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Response } from 'express';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { InvalidGrantError, InvalidTokenError, InvalidScopeError, InvalidRequestError } from '@modelcontextprotocol/sdk/server/auth/errors.js';

type Settings = { root: string; publicUrl: string; githubClientId: string; githubClientSecret: string; allowedLogins: string[]; fetcher?: typeof fetch };
type Pending = { clientId: string; params: AuthorizationParams; expires: number };
type Code = Pending & { identity: string };
type Token = { clientId: string; identity: string; scopes: string[]; expires: number; kind: 'access' | 'refresh'; resource: string };
type State = { clients: Record<string, OAuthClientInformationFull>; tokens: Record<string, Token> };
const now = () => Math.floor(Date.now() / 1000);
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]!);

export class GithubOAuthProvider implements OAuthServerProvider {
  private pending = new Map<string, Pending>();
  private codes = new Map<string, Code>();
  private writes = Promise.resolve();
  private constructor(private settings: Settings, private state: State) {}
  static async open(settings: Settings) {
    let state: State = { clients: {}, tokens: {} };
    try { state = JSON.parse(await readFile(path.join(settings.root, 'oauth.json'), 'utf8')); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    return new GithubOAuthProvider(settings, state);
  }
  private save() {
    const snapshot = JSON.stringify(this.state);
    const write = this.writes.catch(() => {}).then(async () => {
      await mkdir(this.settings.root, { recursive: true });
      const target = path.join(this.settings.root, 'oauth.json');
      const temp = `${target}.${randomUUID()}.tmp`;
      await writeFile(temp, snapshot, { mode: 0o600 }); await rename(temp, target);
    });
    this.writes = write; return write;
  }
  get clientsStore() {
    return {
      getClient: async (id: string) => this.state.clients[id],
      registerClient: async (input: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>): Promise<OAuthClientInformationFull> => {
        if (Object.keys(this.state.clients).length >= 500) throw new InvalidRequestError('客户端注册数已达到上限');
        for (const value of input.redirect_uris) {
          const url = new URL(value);
          if (url.username || url.password || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) throw new InvalidRequestError('redirect_uri 必须使用 HTTPS 或本机回调');
        }
        const client: OAuthClientInformationFull = { ...input, client_id: randomUUID(), client_id_issued_at: now() };
        this.state.clients[client.client_id] = client; await this.save(); return client;
      },
    };
  }
  private resource(resource?: URL) {
    const expected = new URL('/mcp', this.settings.publicUrl).href;
    if (resource && resource.href !== expected) throw new InvalidRequestError('resource 不匹配');
    return expected;
  }
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response) {
    this.resource(params.resource);
    if ((params.scopes ?? ['interview']).some(s => s !== 'interview')) throw new InvalidScopeError('仅支持 interview scope');
    for (const [key, value] of this.pending) if (value.expires < now()) this.pending.delete(key);
    for (const [key, value] of this.codes) if (value.expires < now()) this.codes.delete(key);
    if (this.pending.size >= 500) throw new InvalidRequestError('登录请求过多');
    const state = randomBytes(32).toString('hex');
    this.pending.set(state, { clientId: client.client_id, params: { ...params, scopes: params.scopes?.length ? params.scopes : ['interview'] }, expires: now() + 600 });
    res.cookie('grill_oauth_state', state, { httpOnly: true, secure: new URL(this.settings.publicUrl).protocol === 'https:', sameSite: 'lax', path: '/oauth', maxAge: 600000 });
    res.type('html').send(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>连接 Grill Me Extended</title><style>body{font:16px system-ui;max-width:520px;margin:48px auto;padding:20px;line-height:1.7}button{padding:14px 20px;font:inherit}p{overflow-wrap:anywhere}</style><h1>连接 Grill Me Extended</h1><p>允许 ${escapeHtml(client.client_name ?? '此聊天客户端')} 创建访谈、保存答案并下载你的计划文档。</p><p>授权回调：${escapeHtml(params.redirectUri)}</p><p>仅配置的 GitHub 账号可以登录。服务不需要模型 API 密钥。</p><form method="post" action="/oauth/consent"><input type="hidden" name="state" value="${state}"><button>同意并用 GitHub 登录</button></form></html>`);
  }
  githubLogin(state: string, cookie: string) {
    const pending = this.pending.get(state);
    if (!pending || pending.expires < now() || state !== cookie) throw new InvalidRequestError('OAuth state 无效');
    const url = new URL('https://github.com/login/oauth/authorize');
    url.search = new URLSearchParams({ client_id: this.settings.githubClientId, redirect_uri: new URL('/oauth/github/callback', this.settings.publicUrl).href, scope: 'read:user', state }).toString();
    return url.href;
  }
  async finishGithub(code: string, state: string, cookie: string) {
    const pending = this.pending.get(state);
    if (!pending || pending.expires < now() || !state || state !== cookie) throw new InvalidRequestError('OAuth state 无效');
    this.pending.delete(state);
    const request = this.settings.fetcher ?? fetch;
    const exchange = await request('https://github.com/login/oauth/access_token', {
      method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: this.settings.githubClientId, client_secret: this.settings.githubClientSecret, code, redirect_uri: new URL('/oauth/github/callback', this.settings.publicUrl).href }), signal: AbortSignal.timeout(15000),
    });
    const upstream = await exchange.json() as { access_token?: string };
    if (!exchange.ok || !upstream.access_token) throw new InvalidGrantError('GitHub 登录失败');
    const profile = await request('https://api.github.com/user', { headers: { Authorization: `Bearer ${upstream.access_token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'grill-me-extended' }, signal: AbortSignal.timeout(15000) });
    const user = await profile.json() as { id?: number; login?: string };
    if (!profile.ok || !Number.isSafeInteger(user.id) || typeof user.login !== 'string' || !this.settings.allowedLogins.map(s => s.toLowerCase()).includes(user.login.toLowerCase())) throw new InvalidGrantError('该 GitHub 账号无权使用此私人服务');
    const authorizationCode = randomBytes(32).toString('hex');
    this.codes.set(authorizationCode, { ...pending, identity: `github:${user.id}`, expires: now() + 120 });
    const redirect = new URL(pending.params.redirectUri);
    redirect.searchParams.set('code', authorizationCode);
    if (pending.params.state) redirect.searchParams.set('state', pending.params.state);
    return redirect.href;
  }
  private getCode(client: OAuthClientInformationFull, code: string) {
    const stored = this.codes.get(code);
    if (!stored || stored.expires < now() || stored.clientId !== client.client_id) throw new InvalidGrantError('授权码无效或过期');
    return stored;
  }
  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string) { return this.getCode(client, code).params.codeChallenge; }
  async exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string, _verifier?: string, redirectUri?: string, resource?: URL): Promise<OAuthTokens> {
    const stored = this.getCode(client, code);
    if (redirectUri !== stored.params.redirectUri) throw new InvalidGrantError('redirect_uri 不匹配');
    this.resource(resource);
    this.codes.delete(code);
    return this.mint(client.client_id, stored.identity, stored.params.scopes ?? ['interview']);
  }
  private async mint(clientId: string, identity: string, scopes: string[]): Promise<OAuthTokens> {
    for (const [key, value] of Object.entries(this.state.tokens)) if (value.expires < now()) delete this.state.tokens[key];
    const access = randomBytes(32).toString('hex'), refresh = randomBytes(32).toString('hex');
    const resource = this.resource();
    this.state.tokens[hash(access)] = { clientId, identity, scopes, kind: 'access', expires: now() + 3600, resource };
    this.state.tokens[hash(refresh)] = { clientId, identity, scopes, kind: 'refresh', expires: now() + 2592000, resource };
    await this.save();
    return { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: 3600, scope: scopes.join(' ') };
  }
  async exchangeRefreshToken(client: OAuthClientInformationFull, refresh: string, scopes?: string[], resource?: URL) {
    this.resource(resource);
    const stored = this.state.tokens[hash(refresh)];
    if (!stored || stored.kind !== 'refresh' || stored.expires < now() || stored.clientId !== client.client_id) throw new InvalidGrantError('刷新令牌无效');
    if (scopes?.some(scope => !stored.scopes.includes(scope))) throw new InvalidScopeError('不能扩大权限');
    delete this.state.tokens[hash(refresh)];
    return this.mint(stored.clientId, stored.identity, scopes ?? stored.scopes);
  }
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const stored = this.state.tokens[hash(token)];
    if (!stored || stored.kind !== 'access' || stored.expires <= now()) throw new InvalidTokenError('Access token is invalid or expired');
    return { token, clientId: stored.clientId, scopes: stored.scopes, expiresAt: stored.expires, resource: new URL(stored.resource), extra: { identity: stored.identity } };
  }
  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest) {
    const key = hash(request.token), stored = this.state.tokens[key];
    if (stored?.clientId === client.client_id) { delete this.state.tokens[key]; await this.save(); }
  }
}
