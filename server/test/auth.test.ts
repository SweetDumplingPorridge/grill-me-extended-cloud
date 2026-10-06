import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GithubOAuthProvider } from '../src/auth.js';

test('OAuth binds login cookie, owner allowlist, code, client, redirect and resource; tokens persist and revoke', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grill-auth-'));
  const fetcher: typeof fetch = async (url) => new Response(JSON.stringify(String(url).endsWith('/user')
    ? { id: 101, login: 'owner' } : { access_token: 'upstream-only' }), { headers: { 'Content-Type': 'application/json' } });
  const settings = { root, publicUrl: 'https://grill.example', githubClientId: 'id', githubClientSecret: 'secret', allowedLogins: ['owner'], fetcher };
  const provider = await GithubOAuthProvider.open(settings);
  const client = await provider.clientsStore.registerClient!({ redirect_uris: ['https://chatgpt.com/callback'], token_endpoint_auth_method: 'none' });
  const other = await provider.clientsStore.registerClient!({ redirect_uris: ['https://chatgpt.com/callback'], token_endpoint_auth_method: 'none' });
  let state = '';
  const response = { cookie(_name: string, value: string) { state = value; }, type() { return this; }, send() {} };
  await provider.authorize(client, { redirectUri: 'https://chatgpt.com/callback', codeChallenge: 'challenge', state: 'chat-state', resource: new URL('https://grill.example/mcp') }, response as never);
  assert.ok(state.length >= 32);
  await assert.rejects(provider.finishGithub('gh-code', state, 'bad-cookie'), /state/);
  const redirect = new URL(await provider.finishGithub('gh-code', state, state));
  assert.equal(redirect.searchParams.get('state'), 'chat-state');
  const code = redirect.searchParams.get('code')!;
  await assert.rejects(provider.challengeForAuthorizationCode(other, code));
  assert.equal(await provider.challengeForAuthorizationCode(client, code), 'challenge');
  await assert.rejects(provider.exchangeAuthorizationCode(client, code, undefined, 'https://evil.example', new URL('https://grill.example/mcp')));
  await assert.rejects(provider.exchangeAuthorizationCode(client, code, undefined, 'https://chatgpt.com/callback', new URL('https://evil.example/mcp')));
  const tokens = await provider.exchangeAuthorizationCode(client, code, undefined, 'https://chatgpt.com/callback', new URL('https://grill.example/mcp'));
  await assert.rejects(provider.exchangeAuthorizationCode(client, code));
  const reopened = await GithubOAuthProvider.open(settings);
  assert.equal((await reopened.verifyAccessToken(tokens.access_token)).extra?.identity, 'github:101');
  await assert.rejects(reopened.exchangeRefreshToken(other, tokens.refresh_token!));
  const refreshed = await reopened.exchangeRefreshToken(client, tokens.refresh_token!);
  await assert.rejects(reopened.exchangeRefreshToken(client, tokens.refresh_token!));
  await reopened.revokeToken(client, { token: refreshed.access_token });
  await assert.rejects(reopened.verifyAccessToken(refreshed.access_token));
});

test('OAuth denies an authenticated GitHub account outside allowlist', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grill-denied-'));
  const fetcher: typeof fetch = async (url) => new Response(JSON.stringify(String(url).endsWith('/user')
    ? { id: 999, login: 'outsider' } : { access_token: 'upstream' }));
  const provider = await GithubOAuthProvider.open({ root, publicUrl: 'https://grill.example', githubClientId: 'id', githubClientSecret: 'secret', allowedLogins: ['owner'], fetcher });
  const client = await provider.clientsStore.registerClient!({ redirect_uris: ['https://chatgpt.com/callback'] });
  let state = '';
  await provider.authorize(client, { redirectUri: 'https://chatgpt.com/callback', codeChallenge: 'challenge' }, { cookie(_n: string, v: string) { state = v; }, type() { return this; }, send() {} } as never);
  await assert.rejects(provider.finishGithub('code', state, state), /无权/);
});
