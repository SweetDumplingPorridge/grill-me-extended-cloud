import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createRemoteApp } from '../src/http.js';

test('HTTP exposes a real MCP interview, rejects client paths, exports and restores persistent state', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grill-http-'));
  const app = await createRemoteApp({ dataRoot: root, publicUrl: 'http://127.0.0.1:39123', downloadSecret: 'test-secret-at-least-thirty-two-characters', localDev: true });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const client = new Client({ name: 'integration', version: '1' });
  try {
    assert.equal((await fetch(base + '/healthz')).status, 200);
    await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp')));
    const bad = await client.callTool({ name: 'session_start_or_resume', arguments: { goal: 'x', workspace: root } });
    assert.equal(bad.isError, true);
    const start = await client.callTool({ name: 'session_start_or_resume', arguments: { goal: '测试云端采访' } });
    const sessionId = (start.structuredContent as any).session_id;
    const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: { session_id: sessionId, ...args } });
    const questions = [1,2,3].map(n => ({ id: `q${n}`, prompt: `题 ${n}`, kind: 'text', recommendationReason: '确认范围', recommendedText: '可验收约束', allowOther: true }));
    await call('question_batch_put', { expected_revision: 1, questions, decided_summary: [], remaining_areas: ['范围'] });
    const rendered = await call('questionnaire_render', {});
    assert.equal((rendered._meta as any)['grillMeExtended/questionnaire'].questions.length, 3);
    const answers = questions.map(q => ({ questionId: q.id, text: '明确范围' }));
    const submitted = await call('answers_submit', { expected_revision: 2, idempotency_key: 'stable-submit-key', answers });
    assert.equal((submitted.structuredContent as any).revision, 3);
    const replay = await call('answers_submit', { expected_revision: 2, idempotency_key: 'stable-submit-key', answers });
    assert.equal((replay.structuredContent as any).revision, 3);
    await call('candidate_plan_put', { expected_revision: 3, markdown: '# 云端计划\n实施服务', decisions: ['明确范围'], unresolved: [] });
    await call('review_record', { expected_revision: 4, decision: 'approve', reasons: [] });
    assert.equal((await call('documents_materialize', { expected_revision: 5 })).isError, undefined);
    assert.equal((await call('documents_materialize', { expected_revision: 5 })).isError, undefined);
    const docs = await call('documents_download', {});
    const urls = (docs.structuredContent as any).downloads;
    assert.equal(urls.length, 3);
    const download = new URL(urls[0].url); download.host = new URL(base).host;
    const downloaded = await fetch(download);
    assert.equal(downloaded.status, 200);
    assert.match(await downloaded.text(), /云端计划/);
    download.searchParams.set('signature', 'tampered');
    assert.equal((await fetch(download)).status, 403);
    const reopened = await createRemoteApp({ dataRoot: root, publicUrl: base, downloadSecret: 'test-secret-at-least-thirty-two-characters', localDev: true });
    const second = reopened.listen(0, '127.0.0.1'); await once(second, 'listening');
    const recovered = new Client({ name: 'recovery', version: '1' });
    try {
      await recovered.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(second.address() as any).port}/mcp`)));
      const state = await recovered.callTool({ name: 'session_get', arguments: { session_id: sessionId } });
      assert.equal((state.structuredContent as any).status, 'MATERIALIZED');
    } finally { await recovered.close(); second.close(); }
  } finally { await client.close(); server.close(); }
});

test('production HTTP requires authentication and advertises OAuth discovery', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grill-protected-'));
  const app = await createRemoteApp({ dataRoot: root, publicUrl: 'https://grill.example', downloadSecret: 'test-secret-at-least-thirty-two-characters', localDev: false, githubClientId: 'test-id', githubClientSecret: 'test-secret', allowedLogins: ['owner'] });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const unauthorized = await fetch(base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(unauthorized.status, 401);
    const invalid = await fetch(base + '/mcp', { method: 'POST', headers: { authorization: 'Bearer invalid-token', 'content-type': 'application/json' }, body: '{}' });
    assert.equal(invalid.status, 401);
    assert.match(unauthorized.headers.get('www-authenticate')!, /resource_metadata/);
    const meta = await (await fetch(base + '/.well-known/oauth-protected-resource/mcp')).json() as any;
    assert.equal(meta.resource, 'https://grill.example/mcp');
    const oauth = await (await fetch(base + '/.well-known/oauth-authorization-server')).json() as any;
    assert.ok(oauth.code_challenge_methods_supported.includes('S256'));
  } finally { server.close(); }
});

test('real OAuth HTTP registration and PKCE login unlock MCP; wrong verifier and reused codes fail', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grill-pkce-'));
  const app = await createRemoteApp({ dataRoot: root, publicUrl: 'https://grill.example', downloadSecret: 'test-secret-at-least-thirty-two-characters', localDev: false, githubClientId: 'test-id', githubClientSecret: 'test-secret', allowedLogins: ['owner'] }, {
    githubFetch: async (url) => new Response(JSON.stringify(String(url).endsWith('/user') ? { id: 101, login: 'owner' } : { access_token: 'upstream-token' })),
  });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const client = new Client({ name: 'oauth-integration', version: '1' });
  try {
    const registration = await fetch(base + '/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'ChatGPT test', redirect_uris: ['https://chatgpt.com/callback'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'] }) });
    assert.equal(registration.status, 201);
    const registered = await registration.json() as any;
    const verifier = 'a-secure-pkce-verifier-with-more-than-forty-three-characters';
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const auth = await fetch(base + '/authorize?' + new URLSearchParams({ client_id: registered.client_id, response_type: 'code', redirect_uri: 'https://chatgpt.com/callback', code_challenge: challenge, code_challenge_method: 'S256', resource: 'https://grill.example/mcp', state: 'chat-state' }), { redirect: 'manual' });
    assert.equal(auth.status, 200);
    const cookie = auth.headers.get('set-cookie')!.split(';')[0]!;
    const state = cookie.split('=')[1]!;
    const consent = await fetch(base + '/oauth/consent', { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ state }) });
    assert.equal(new URL(consent.headers.get('location')!).hostname, 'github.com');
    const callback = await fetch(base + '/oauth/github/callback?' + new URLSearchParams({ state, code: 'github-fixture-code' }), { headers: { cookie }, redirect: 'manual' });
    const location = new URL(callback.headers.get('location')!);
    assert.equal(location.searchParams.get('state'), 'chat-state');
    const code = location.searchParams.get('code')!;
    const exchange = (codeVerifier: string) => fetch(base + '/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: registered.client_id, grant_type: 'authorization_code', code, code_verifier: codeVerifier, redirect_uri: 'https://chatgpt.com/callback', resource: 'https://grill.example/mcp' }) });
    assert.equal((await exchange('incorrect-verifier')).status, 400);
    const accepted = await exchange(verifier); assert.equal(accepted.status, 200);
    const tokens = await accepted.json() as any;
    assert.equal((await exchange(verifier)).status, 400);
    await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { authorization: `Bearer ${tokens.access_token}` } } }));
    const started = await client.callTool({ name: 'session_start_or_resume', arguments: { goal: '授权成功' } });
    assert.equal(started.isError, undefined);
    assert.equal((started.structuredContent as any).status, 'COLLECTING');
  } finally { await client.close(); server.close(); }
});
