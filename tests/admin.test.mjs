import {test} from 'node:test';
import {request} from 'node:http';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAdmin, allowedHost} from '../admin/server.mjs';

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'obsidian-admin-test-'));
  const paths = Object.fromEntries(['state', 'config', 'vault', 'mcp', 'tunnel'].map(name => [name, join(root, name)]));
  let savedToken, providerCalls = 0, setupCalls = 0;
  const provider = {
    async authenticate({email, password, mfa}) {
      providerCalls++;
      if (password === 'mfa-required' && !mfa) throw Object.assign(new Error('Enter a valid Obsidian two-factor code and try again.'), {status: 400});
      return {token: password, account: {email: password === 'wrong-provider-account' ? 'another@example.com' : email}};
    },
    async commit(token) {savedToken = token;},
    async currentAccount() {return {email: 'owner@example.com'};},
    async vaults() {return [{id: 'vault-one', name: '<Vault one>'}, {id: 'vault-two', name: 'Vault two'}];},
    async setup(id) {setupCalls++; return {vaultId: id};},
  };
  const server = await createAdmin({paths, obsidian: provider, ...options});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '', csrf = '';
  const call = async (path, body, options = {}) => {
    const headers = {Cookie: cookie, ...options.headers};
    if (body !== undefined) Object.assign(headers, {'Content-Type': 'application/json', Origin: base, 'X-CSRF-Token': csrf}, options.headers);
    const response = await fetch(base + path, {method: body === undefined ? 'GET' : 'POST', headers,
      body: body === undefined ? undefined : JSON.stringify(body)});
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const data = await response.json();
    if (data.csrf) csrf = data.csrf;
    return {status: response.status, data, headers: response.headers};
  };
  t.after(async () => {await new Promise(resolve => server.close(resolve)); await rm(root, {recursive: true, force: true});});
  return {paths, call, base, server, provider, counters: () => ({savedToken, providerCalls, setupCalls})};
}
async function selectVault(f) {
  assert.equal((await f.call('/api/password', {password: 'synthetic-admin-password'})).status, 201);
  assert.equal((await f.call('/api/obsidian', {email: 'owner@example.com', password: 'original-token'})).status, 200);
  assert.equal((await f.call('/api/vault', {id: 'vault-one', password: 'encryption-password'})).status, 200);
}

test('setup, mandatory auth, one-time keys, immutable identity, and re-authentication', async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.call('/api/status')).data, {passwordSet: false, authenticated: false});
  assert.equal((await f.call('/api/key', {})).status, 401);
  assert.equal((await f.call('/api/password', {password: 'short'})).status, 400);
  await selectVault(f);
  assert.equal((await f.call('/api/password', {password: 'replacement-password'})).status, 409);
  assert.equal((await f.call('/api/initialize', {})).status, 400);
  assert.equal((await f.call('/api/vaults')).status, 409);
  assert.equal((await f.call('/api/vault', {id: 'vault-two'})).status, 409);
  assert.equal(f.counters().setupCalls, 1);
  assert.equal((await f.call('/api/obsidian', {email: 'another@example.com', password: 'evil'})).status, 409);
  assert.equal(f.counters().providerCalls, 1);
  assert.equal((await f.call('/api/obsidian', {email: 'owner@example.com', password: 'wrong-provider-account'})).status, 409);
  assert.equal(f.counters().savedToken, 'original-token');
  const key = (await f.call('/api/key', {})).data.key;
  assert.match(key, /^[A-Za-z0-9_-]{43}$/);
  assert.equal((await readFile(join(f.paths.mcp, 'token'), 'utf8')), key);
  assert.equal((await stat(join(f.paths.mcp, 'token'))).mode & 0o777, 0o600);
  assert.equal((await f.call('/api/key', {})).status, 409);
  const tunnel = 'synthetic-cloudflare-connector-token';
  assert.equal((await f.call('/api/tunnel', {token: tunnel})).status, 200);
  assert.equal((await f.call('/api/initialize', {})).status, 200);
  for (const path of [join(f.paths.config, 'obsidian-headless/admin-ready'), join(f.paths.mcp, 'ready'), join(f.paths.tunnel, 'ready')]) assert.equal(await readFile(path, 'utf8'), 'ready');
  const status = await f.call('/api/status');
  assert.equal(status.data.initialized, true);
  assert.equal(status.data.vault.id, 'vault-one');
  assert(!JSON.stringify(status.data).includes(key));
  assert(!JSON.stringify(status.data).includes(tunnel));
  assert.equal(status.headers.get('cache-control'), 'no-store');
  const stored = await readFile(join(f.paths.state, 'state.json'), 'utf8');
  for (const secret of ['synthetic-admin-password', 'encryption-password', key, tunnel, 'original-token']) assert(!stored.includes(secret));
  assert.equal((await f.call('/api/obsidian', {email: 'owner@example.com', password: 'mfa-required'})).status, 400);
  assert.equal(f.counters().savedToken, 'original-token');
  assert.equal((await f.call('/api/obsidian', {email: 'owner@example.com', password: 'replacement-token', mfa: '123456'})).status, 200);
  assert.equal(f.counters().savedToken, 'replacement-token');
  const next = (await f.call('/api/key', {regenerate: true})).data.key;
  assert.notEqual(key, next);
  assert.equal((await f.call('/api/logout', {})).status, 200);
  assert.equal((await f.call('/api/tunnel', {token: tunnel})).status, 401);
  assert.equal((await f.call('/api/login', {password: 'wrong-password'})).status, 401);
  assert.equal((await f.call('/api/login', {password: 'synthetic-admin-password'})).status, 200);
  assert.equal((await f.call('/api/status')).data.initialized, true);
});

test('cross-origin, missing CSRF, public hosts, and oversized requests are rejected', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('/api/password', {password: 'synthetic-admin-password'}, {headers: {Origin: 'https://evil.example'}})).status, 403);
  assert.equal((await f.call('/api/password', {password: 'synthetic-admin-password'})).status, 201);
  assert.equal((await f.call('/api/obsidian', {email: 'owner@example.com', password: 'secret'}, {headers: {'X-CSRF-Token': ''}})).status, 403);
  const publicHostStatus = await new Promise(resolve => {const req = request(f.base + '/api/status', {headers: {Host: 'evil.example'}}, res => {res.resume(); resolve(res.statusCode);}); req.end();});
  assert.equal(publicHostStatus, 403);
  assert.equal((await f.call('/api/obsidian', {password: 'a'.repeat(17000)})).status, 413);
});

test('bootstrap is serialized and stored identity survives server recreation', async t => {
  const f = await fixture(t);
  const replies = await Promise.all([f.call('/api/password', {password: 'synthetic-admin-password'}), f.call('/api/password', {password: 'different-admin-password'})]);
  assert.equal(replies.filter(r => r.status === 201).length, 1);
  assert.equal(replies.filter(r => r.status === 409).length, 1);
  const recreated = await createAdmin({paths: f.paths, obsidian: f.provider});
  await new Promise(resolve => recreated.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => recreated.close(resolve)));
  const base = `http://127.0.0.1:${recreated.address().port}`;
  assert.deepEqual(await (await fetch(base + '/api/status')).json(), {passwordSet: true, authenticated: false});
  const response = await fetch(base + '/api/password', {method: 'POST', headers: {'Content-Type': 'application/json', Origin: base}, body: JSON.stringify({password: 'new-password-test'})});
  assert.equal(response.status, 409);
});

test('login rate limits apply before expensive password checks', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 5; i++) assert.equal((await f.call('/api/login', {password: 'incorrect'})).status, 401);
  assert.equal((await f.call('/api/login', {password: 'incorrect'})).status, 429);
});

test('Host validation permits LAN addresses and explicit local hostnames', () => {
  for (const host of ['192.168.1.20:8090', '10.0.0.2:8090', '172.16.0.1', '[fd00::1]:8090', 'localhost:8090']) assert(allowedHost(host));
  for (const host of ['evil.example:8090', '8.8.8.8:8090', '172.32.0.1', '[2001:4860::1]:8090']) assert(!allowedHost(host));
  assert(allowedHost('nas.local:8090', ['nas.local']));
});


test('a deployment without cloudflared can initialize without a tunnel token', async t => {
  const f = await fixture(t, {tunnelRequired: false});
  await selectVault(f);
  assert.equal((await f.call('/api/key', {})).status, 201);
  assert.equal((await f.call('/api/status')).data.tunnelRequired, false);
  assert.equal((await f.call('/api/initialize', {})).status, 200);
});
