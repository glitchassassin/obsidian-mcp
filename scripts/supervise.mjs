import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';

const mode = process.argv[2];
const config = {
  sync: {
    files: ['/home/node/.config/obsidian-headless/admin-ready', '/home/node/.config/obsidian-headless/auth_token'],
    command: '/app/scripts/run-sync.sh', args: [],
  },
  mcp: {
    files: ['/run/mcp-key/ready', '/run/mcp-key/token'],
    command: '/app/scripts/run-mcp.sh', args: [],
  },
  tunnel: {
    files: ['/run/tunnel-key/ready', '/run/tunnel-key/token'],
    command: '/usr/local/bin/cloudflared', args: ['tunnel', '--no-autoupdate', 'run', '--token-file', '/run/tunnel-key/token'],
  },
}[mode];
if (!config) throw new Error('Unknown service mode');
let child, fingerprint, stopping = false, stoppingChild;
const health = createServer((req, res) => {
  if (req.url !== '/healthz') {res.writeHead(404); return res.end();}
  res.writeHead(200, {'Content-Type': 'application/json'});
  res.end(JSON.stringify({state: child ? 'running' : 'waiting', service: mode}));
});
health.listen(8001, '127.0.0.1');
async function signature() {
  try {
    const contents = await Promise.all(config.files.map(path => readFile(path)));
    if (contents.some(data => !data.length)) return null;
    return createHash('sha256').update(Buffer.concat(contents)).digest('hex');
  } catch (error) {if (error.code === 'ENOENT') return null; throw error;}
}
async function stopChild() {
  if (stoppingChild) return stoppingChild;
  if (!child) return;
  const old = child; child = undefined;
  stoppingChild = (async () => {
    const signal = name => {try {process.kill(-old.pid, name);} catch (error) {if (error.code !== 'ESRCH') throw error;}};
    signal('SIGTERM');
    // Kill the entire group, including Desktop Commander's stdio child.
    await delay(1500);
    signal('SIGKILL');
  })();
  await stoppingChild; stoppingChild = undefined;
}
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  if (stopping) return;
  stopping = true;
  stopChild().then(() => {health.close(); process.exit(0);});
});
console.log(`${mode}: waiting for admin setup.`);
let retryAt = 0;
while (!stopping) {
  const next = await signature();
  if (next !== fingerprint) {
    await stopChild(); fingerprint = next; retryAt = 0;
  }
  if (next && !child && Date.now() >= retryAt && !stopping) {
    console.log(`${mode}: starting configured service.`);
    const running = spawn(config.command, config.args, {stdio: 'inherit', detached: true});
    child = running;
    const exited = () => {
      if (child === running) {child = undefined; retryAt = Date.now() + 5000;}
      // A gateway crash can leave its stdio descendants behind.
      try {process.kill(-running.pid, 'SIGKILL');} catch {}
    };
    running.once('exit', exited);
    running.once('error', exited);
  }
  await delay(1000);
}
