import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {isIP} from 'node:net';
import {randomBytes, scrypt as derive, timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {atomicWrite, readOptional, privateDirectory} from './storage.mjs';
import {obsidianClient} from './obsidian.mjs';

const scrypt = promisify(derive);
const cookieName = 'obsidian_admin';
const idleMs = 30 * 60 * 1000, lifetimeMs = 8 * 60 * 60 * 1000;
const publicDir = fileURLToPath(new URL('./public/', import.meta.url));
function fail(message, status = 400) {throw Object.assign(new Error(message), {status});}
function text(value, label, max = 512) {
  if (typeof value !== 'string' || !value || value.length > max || /[\x00-\x1f]/.test(value)) fail(`Enter a valid ${label}.`);
  return value;
}
function password(value) {text(value, 'admin password', 256); if (value.length < 12) fail('Use an admin password of at least 12 characters.'); return value;}
async function hash(value, salt = randomBytes(16).toString('hex')) {
  return {salt, hash: (await scrypt(value, salt, 32, {N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024})).toString('hex')};
}
async function matches(value, saved) {
  if (typeof value !== 'string' || value.length > 256) return false;
  const candidate = await hash(value, saved.salt);
  return timingSafeEqual(Buffer.from(candidate.hash, 'hex'), Buffer.from(saved.hash, 'hex'));
}
export function allowedHost(host, extras = []) {
  let name;
  try {name = new URL(`http://${host}`).hostname.replace(/^\[|\]$/g, '').toLowerCase();} catch {return false;}
  if (extras.includes(name) || name === 'localhost' || name === '::1') return true;
  if (isIP(name) === 4) {
    const [a, b] = name.split('.').map(Number);
    return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
  }
  return isIP(name) === 6 && /^(fc|fd|fe[89ab])/i.test(name);
}
export async function createAdmin({paths, obsidian = obsidianClient(paths), allowedHosts = [], tunnelRequired = true}) {
  for (const dir of [paths.state, paths.mcp, paths.tunnel]) await privateDirectory(dir);
  const stateFile = join(paths.state, 'state.json');
  let state = JSON.parse(await readOptional(stateFile) || '{}');
  const sessions = new Map(), attempts = new Map();
  let busy = false;
  async function persist(next) {await atomicWrite(stateFile, JSON.stringify(next)); state = next;}
  async function activate() {
    await atomicWrite(join(paths.config, 'obsidian-headless/admin-ready'), 'ready');
    await atomicWrite(join(paths.mcp, 'ready'), 'ready');
    await atomicWrite(join(paths.tunnel, 'ready'), 'ready');
  }
  if (state.initialized) await activate();
  function session(req) {
    const match = (req.headers.cookie || '').match(/(?:^|;\s*)obsidian_admin=([a-f0-9]{64})(?:;|$)/);
    const key = match?.[1], value = sessions.get(key), now = Date.now();
    if (!value || now - value.last > idleMs || now - value.created > lifetimeMs) {if (key) sessions.delete(key); return null;}
    if (req.url !== '/api/status') value.last = now;
    return {key, ...value};
  }
  function newSession(res) {
    const now = Date.now();
    for (const [key, value] of sessions) if (now - value.last > idleMs || now - value.created > lifetimeMs) sessions.delete(key);
    while (sessions.size >= 64) sessions.delete(sessions.keys().next().value);
    const key = randomBytes(32).toString('hex'), csrf = randomBytes(24).toString('hex');
    sessions.set(key, {csrf, last: now, created: now});
    // HTTP on a trusted LAN; Secure must be added if you put local TLS in front.
    res.setHeader('Set-Cookie', `${cookieName}=${key}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${lifetimeMs / 1000}`);
    return csrf;
  }
  function rate(req) {
    const now = Date.now();
    for (const [key, value] of attempts) if (now - value.start > 60000) attempts.delete(key);
    for (const [key, limit] of [['all', 30], [req.socket.remoteAddress, 5]]) {
      const value = attempts.get(key) || {start: now, count: 0};
      if (++value.count > limit) fail('Too many login attempts. Try again in a minute.', 429);
      attempts.set(key, value);
    }
  }
  function send(res, status, body) {res.writeHead(status, {'Content-Type': 'application/json'}); res.end(JSON.stringify(body));}
  async function status(auth) {
    const result = {passwordSet: Boolean(state.password), authenticated: Boolean(auth)};
    if (auth) Object.assign(result, {
      csrf: auth.csrf, tunnelRequired, initialized: Boolean(state.initialized), account: state.account || null,
      vault: state.vault || null, mcpConfigured: Boolean(await readOptional(join(paths.mcp, 'token'))),
      tunnelConfigured: Boolean(await readOptional(join(paths.tunnel, 'token'))),
      keyCreatedAt: state.keyCreatedAt || null, tunnelUpdatedAt: state.tunnelUpdatedAt || null,
    });
    return result;
  }
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'");
    let ownsLock = false;
    try {
      if (!allowedHost(req.headers.host, allowedHosts)) fail('Use the NAS LAN IP address or an explicitly allowed admin hostname.', 403);
      if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) fail('Cross-site requests are disabled.', 403);
      const path = new URL(req.url, 'http://localhost').pathname;
      if (req.method === 'GET' && path === '/healthz') return send(res, 200, {ok: true});
      const auth = session(req);
      if (req.method === 'GET' && path === '/api/status') return send(res, 200, await status(auth));
      if (req.method === 'GET' && path === '/api/vaults') {
        if (!auth) fail('Log in to the admin UI.', 401);
        if (state.vault) fail('The vault selection is locked.', 409);
        return send(res, 200, {vaults: await obsidian.vaults()});
      }
      if (req.method === 'GET' && ['/', '/app.js', '/style.css'].includes(path)) {
        const filename = path === '/' ? 'index.html' : path.slice(1);
        res.writeHead(200, {'Content-Type': {'index.html': 'text/html; charset=utf-8', 'app.js': 'text/javascript', 'style.css': 'text/css'}[filename]});
        return res.end(await readFile(join(publicDir, filename)));
      }
      if (req.method !== 'POST' || !path.startsWith('/api/')) fail('Not found.', 404);
      const origin = `http://${req.headers.host}`;
      if (req.headers.origin !== origin || req.headers['content-type'] !== 'application/json') fail('A same-origin JSON request is required.', 403);
      if (!['/api/password', '/api/login'].includes(path)) {
        if (!auth) fail('Log in to the admin UI.', 401);
        if (req.headers['x-csrf-token'] !== auth.csrf) fail('Refresh the page and try again.', 403);
      }
      if (path === '/api/password' && state.password) fail('The admin password has already been configured.', 409);
      if (['/api/password', '/api/login'].includes(path)) rate(req);
      if (busy) fail('Another configuration change is in progress. Try again.', 409);
      busy = true; ownsLock = true;
      let raw = '';
      for await (const chunk of req) {raw += chunk; if (Buffer.byteLength(raw) > 16384) fail('Request too large.', 413);}
      let body;
      try {body = JSON.parse(raw); if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error();}
      catch {fail('Invalid JSON request.');}
      if (path === '/api/password') {
        // Serialized with all writes; a second bootstrap cannot overwrite a password.
        if (state.password) fail('The admin password has already been configured.', 409);
        await persist({...state, password: await hash(password(body.password))});
        return send(res, 201, {csrf: newSession(res)});
      }
      if (path === '/api/login') {
        if (!state.password || !await matches(body.password, state.password)) fail('Incorrect admin password.', 401);
        return send(res, 200, {csrf: newSession(res)});
      }
      if (path === '/api/logout') {
        sessions.delete(auth.key);
        res.setHeader('Set-Cookie', `${cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
        return send(res, 200, {ok: true});
      }
      if (path === '/api/obsidian') {
        const email = text(body.email, 'Obsidian email', 254).trim().toLowerCase();
        if (state.vault && email !== state.account.email) fail('This deployment is locked to its original Obsidian account.', 409);
        const result = await obsidian.authenticate({email, password: text(body.password, 'Obsidian password'), mfa: body.mfa ? text(body.mfa, 'two-factor code', 32) : ''});
        if (state.vault && result.account.email !== state.account.email) fail('Obsidian returned a different account. The existing credentials were preserved.', 409);
        await obsidian.commit(result.token);
        await persist({...state, account: result.account});
        return send(res, 200, {ok: true});
      }
      if (path === '/api/vault') {
        if (state.vault || state.initialized) fail('This deployment is locked to its original vault.', 409);
        const account = await obsidian.currentAccount();
        if (!state.account || account.email !== state.account.email) fail('Log into Obsidian again.');
        const id = text(body.id, 'vault ID', 128);
        const selected = (await obsidian.vaults()).find(v => v.id === id);
        if (!selected) fail('Choose a vault available to your account.');
        const result = await obsidian.setup(id, body.password ? text(body.password, 'vault encryption password') : '');
        if (result.vaultId !== id) fail('Obsidian returned a different vault.');
        await persist({...state, account, vault: selected});
        return send(res, 200, {ok: true});
      }
      if (path === '/api/key') {
        if (!state.vault) fail('Select your vault first.');
        const exists = Boolean(await readOptional(join(paths.mcp, 'token')));
        if (exists && body.regenerate !== true) fail('Confirm regeneration to replace the existing key.', 409);
        const key = randomBytes(32).toString('base64url');
        await atomicWrite(join(paths.mcp, 'token'), key);
        await persist({...state, keyCreatedAt: new Date().toISOString()});
        return send(res, 201, {key}); // The only endpoint that returns a key.
      }
      if (path === '/api/tunnel') {
        if (!state.vault) fail('Select your vault first.');
        const token = text(body.token, 'Cloudflare tunnel token', 4096).trim();
        if (!/^[A-Za-z0-9_+/=-]+$/.test(token) || token.length < 16) fail('Enter the Cloudflare connector token.');
        await atomicWrite(join(paths.tunnel, 'token'), token);
        await persist({...state, tunnelUpdatedAt: new Date().toISOString()});
        return send(res, 200, {ok: true});
      }
      if (path === '/api/initialize') {
        if (!state.vault || !await readOptional(join(paths.mcp, 'token')) || (tunnelRequired && !await readOptional(join(paths.tunnel, 'token')))) fail('Configure Obsidian, an MCP key, and the tunnel token first.');
        await persist({...state, initialized: true});
        await activate();
        return send(res, 200, {ok: true});
      }
      fail('Not found.', 404);
    } catch (error) {
      // Never log request bodies, provider errors, tokens, or raw CLI output.
      if (!res.headersSent) send(res, error.status || 400, {error: error.status ? error.message : 'The operation failed. Check your credentials and try again.'});
      else res.end();
    } finally {if (ownsLock) busy = false;}
  });
  server.requestTimeout = 65000;
  server.headersTimeout = 10000;
  return server;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const paths = {state: '/admin-state', config: '/home/node/.config', vault: '/vault', mcp: '/run/mcp-key', tunnel: '/run/tunnel-key'};
  const allowedHosts = (process.env.ADMIN_ALLOWED_HOSTS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const server = await createAdmin({paths, allowedHosts, tunnelRequired: process.env.ADMIN_TUNNEL_REQUIRED !== 'false'});
  server.listen(8090, '0.0.0.0', () => console.log('Admin UI listening on port 8090. Keep it private to your LAN.'));
}
