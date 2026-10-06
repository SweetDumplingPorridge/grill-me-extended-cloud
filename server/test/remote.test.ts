import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RemoteContexts } from '../src/remote.js';

test('remote contexts isolate identities and allocate workspaces without client paths', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grill-remote-'));
  const contexts = new RemoteContexts(root, 'https://example.com', 'test-secret-at-least-thirty-two-characters');
  const alice = contexts.forUser('github:101');
  assert.equal(contexts.forUser('github:101').store, alice.store);
  const started = await alice.start('建立项目');
  assert.ok(started.workspaceRoot.startsWith(root));
  assert.equal(path.basename(path.dirname(started.workspaceRoot)), started.sessionId);
  const bob = contexts.forUser('github:202');
  await assert.rejects(bob.store.get(started.sessionId), /找不到会话/);
  const restored = new RemoteContexts(root, 'https://example.com', 'test-secret-at-least-thirty-two-characters');
  assert.equal((await restored.forUser('github:101').store.get(started.sessionId)).goal, '建立项目');
});

test('download signatures bind owner, session, filename and expiration', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grill-links-'));
  const contexts = new RemoteContexts(root, 'https://example.com', 'test-secret-at-least-thirty-two-characters');
  const alice = contexts.forUser('github:101');
  const started = await alice.start('下载验证');
  const url = new URL(alice.downloadUrl(started.sessionId, '计划.md', 1000));
  const ticket = contexts.verifyDownload(url, 1001);
  assert.equal(ticket.sessionId, started.sessionId);
  assert.equal(ticket.name, '计划.md');
  assert.throws(() => contexts.verifyDownload(url, 2000), /过期/);
  url.searchParams.set('name', 'session.json');
  assert.throws(() => contexts.verifyDownload(url, 1001));
  const valid = new URL(alice.downloadUrl(started.sessionId, '计划.md', 1000));
  valid.searchParams.set('user', 'different-user');
  assert.throws(() => contexts.verifyDownload(valid, 1001));
});
