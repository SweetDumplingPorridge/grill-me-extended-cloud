export type RemoteSettings = {
  dataRoot: string; publicUrl: string; downloadSecret: string; localDev: boolean;
  githubClientId?: string; githubClientSecret?: string; allowedLogins?: string[];
};
export function validateSettings(settings: RemoteSettings) {
  const url = new URL(settings.publicUrl);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('PUBLIC_URL 必须是无路径、参数和凭据的根 URL');
  if (settings.downloadSecret.length < 32) throw new Error('DOWNLOAD_SECRET 至少需要 32 个字符');
  if (settings.localDev) {
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('LOCAL_DEV 仅允许本机回环地址');
  } else {
    if (url.protocol !== 'https:') throw new Error('生产环境 PUBLIC_URL 必须使用 HTTPS');
    if (!settings.githubClientId || !settings.githubClientSecret || !settings.allowedLogins?.length) throw new Error('生产环境必须配置 GitHub OAuth 和允许登录的账号');
  }
}
