import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { SessionStore, validateSessionId } from './store.js';
import { GrillError } from './types.js';

export const DOCUMENT_NAMES = ['计划.md', '进度.md', 'AGENTS.md'] as const;
export class RemoteContexts {
  private contexts = new Map<string, RemoteContext>();
  constructor(readonly root: string, readonly publicUrl: string, private secret: string) {}
  forUser(identity: string): RemoteContext {
    return this.forKey(createHash('sha256').update(identity).digest('hex'));
  }
  private forKey(key: string): RemoteContext {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new GrillError('INVALID_OWNER', '用户标识无效');
    let context = this.contexts.get(key);
    if (!context) {
      context = new RemoteContext(this, key, new SessionStore(path.join(this.root, 'users', key, 'sessions')));
      this.contexts.set(key, context);
    }
    return context;
  }
  sign(value: string): string { return createHmac('sha256', this.secret).update(value).digest('hex'); }
  verifyDownload(url: URL, now = Math.floor(Date.now() / 1000)) {
    const user = url.searchParams.get('user') ?? '';
    const sessionId = validateSessionId(url.searchParams.get('session') ?? '');
    const name = url.searchParams.get('name') ?? '';
    const expires = Number(url.searchParams.get('expires'));
    if (!DOCUMENT_NAMES.includes(name as typeof DOCUMENT_NAMES[number])) throw new GrillError('INVALID_DOCUMENT', '文件无效');
    if (!Number.isSafeInteger(expires) || expires < now || expires > now + 900) throw new GrillError('EXPIRED_DOWNLOAD', '下载链接已过期');
    const wanted = Buffer.from(this.sign(JSON.stringify([user, sessionId, name, expires])));
    const received = Buffer.from(url.searchParams.get('signature') ?? '');
    if (wanted.length !== received.length || !timingSafeEqual(wanted, received)) throw new GrillError('INVALID_SIGNATURE', '下载签名无效');
    return { context: this.forKey(user), sessionId, name };
  }
}

export class RemoteContext {
  constructor(private parent: RemoteContexts, readonly userKey: string, readonly store: SessionStore) {}
  async start(goal: string, sessionId?: string) {
    const session = await this.store.startOrResume(goal, id => path.join(this.store.root, id, 'documents'), sessionId);
    await mkdir(session.workspaceRoot, { recursive: true });
    return session;
  }
  downloadUrl(sessionId: string, name: string, now = Math.floor(Date.now() / 1000)): string {
    validateSessionId(sessionId);
    if (!DOCUMENT_NAMES.includes(name as typeof DOCUMENT_NAMES[number])) throw new GrillError('INVALID_DOCUMENT', '文件无效');
    const expires = now + 900;
    const url = new URL('/download', this.parent.publicUrl);
    url.search = new URLSearchParams({ user: this.userKey, session: sessionId, name, expires: String(expires),
      signature: this.parent.sign(JSON.stringify([this.userKey, sessionId, name, expires])) }).toString();
    return url.href;
  }
  downloads(sessionId: string) { return DOCUMENT_NAMES.map(name => ({ name, url: this.downloadUrl(sessionId, name) })); }
}
