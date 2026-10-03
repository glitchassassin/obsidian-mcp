import {spawn} from 'node:child_process';
import {join} from 'node:path';
import {atomicWrite, readOptional} from './storage.mjs';

// These are the same fixed API endpoints used by the pinned official CLI.
// Login is staged and verified before replacing the running client's token.
export function obsidianClient({config, vault}) {
  const tokenPath = join(config, 'obsidian-headless/auth_token');
  async function request(path, body) {
    let result;
    try {
      const response = await fetch(`https://api.obsidian.md${path}`, {
        method: 'POST', headers: {'Content-Type': 'application/json', Origin: 'https://obsidian.md',
          'User-Agent': 'obsidian-headless/0.0.14'},
        body: JSON.stringify(body), signal: AbortSignal.timeout(30000), redirect: 'error',
      });
      if (!response.ok) throw new Error();
      result = await response.json();
    } catch {throw Object.assign(new Error('Obsidian could not be reached. Try again.'), {status: 400});}
    if (result.error) {
      if (String(result.error).includes('2FA code')) throw Object.assign(new Error('Enter a valid Obsidian two-factor code and try again.'), {status: 400});
      throw Object.assign(new Error('Obsidian rejected the request. Check your credentials and Sync subscription.'), {status: 400});
    }
    return result;
  }
  async function profile(token) {
    const info = await request('/user/info', {token});
    if (typeof info.email !== 'string' || !info.email.includes('@')) throw Object.assign(new Error('Obsidian did not return a verified account identity.'), {status: 400});
    return {email: info.email.trim().toLowerCase()};
  }
  async function cli(args) {
    return new Promise((resolve, reject) => {
      // Sensitive options travel over stdin, never through OS arguments or logs.
      const child = spawn(process.execPath, ['/app/admin/cli-input.cjs'], {
        env: {...process.env, XDG_CONFIG_HOME: config}, stdio: ['pipe', 'pipe', 'pipe'],
      });
      let output = '', bytes = 0, timedOut = false;
      const timer = setTimeout(() => {timedOut = true; child.kill('SIGKILL');}, 60000);
      child.stdout.on('data', data => {bytes += data.length; if (bytes > 65536) child.kill('SIGKILL'); else output += data;});
      // CLI errors may contain sensitive provider data. Don't relay or log them.
      child.stderr.resume();
      child.stdin.on('error', () => {});
      child.on('error', () => {clearTimeout(timer); reject(Object.assign(new Error('Could not start the Obsidian client.'), {status: 400}), {status: 400});});
      child.on('close', code => {
        clearTimeout(timer);
        if (code || timedOut || bytes > 65536) return reject(Object.assign(new Error('Vault setup failed. Check the encryption password and your access to this vault.'), {status: 400}), {status: 400});
        try {resolve(JSON.parse(output));} catch {reject(Object.assign(new Error('Unexpected Obsidian client response.'), {status: 400}), {status: 400});}
      });
      child.stdin.end(JSON.stringify(args));
    });
  }
  return {
    async authenticate({email, password, mfa}) {
      const login = await request('/user/signin', {email, password, mfa: mfa || ''});
      if (typeof login.token !== 'string' || !login.token) throw Object.assign(new Error('Obsidian did not return a login token.'), {status: 400});
      return {token: login.token, account: await profile(login.token)};
    },
    async commit(token) {await atomicWrite(tokenPath, token);},
    async currentAccount() {
      const token = await readOptional(tokenPath);
      if (!token) throw Object.assign(new Error('Log into Obsidian first.'), {status: 400});
      return profile(token);
    },
    async vaults() {
      const token = await readOptional(tokenPath);
      if (!token) throw Object.assign(new Error('Log into Obsidian first.'), {status: 400});
      const result = await request('/vault/list', {token, supported_encryption_version: 3});
      return [...(result.vaults || []), ...(result.shared || [])].map(v => ({id: v.id, name: v.name}));
    },
    async setup(id, password) {
      const args = ['sync-setup', '--vault', id, '--path', vault, '--device-name', 'obsidian-mcp', '--json'];
      if (password) args.push('--password', password);
      return cli(args);
    },
  };
}
