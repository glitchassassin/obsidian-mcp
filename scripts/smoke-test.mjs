// Run inside the MCP container. Uses only synthetic files and removes them.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, rm, stat } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const endpoint = new URL('http://127.0.0.1:8000/mcp');
const key = process.env.SUPERGATEWAY_API_KEY ?? (process.env.SUPERGATEWAY_API_KEY_FILE ? (await readFile(process.env.SUPERGATEWAY_API_KEY_FILE, 'utf8')).trim() : undefined);
assert(key, 'Gateway key must be configured');
for (const authorization of [undefined, 'Bearer incorrect-synthetic-key']) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(authorization ? { Authorization: authorization } : {}) },
    body: '{}',
  });
  assert.equal(response.status, 401, 'Missing/wrong bearer must be rejected');
}

const client = new Client({ name: 'obsidian-mcp-smoke', version: '1.0.0' });
const transport = new StreamableHTTPClientTransport(endpoint, {
  requestInit: { headers: { Authorization: `Bearer ${key}` } },
});
const directory = `/vault/obsidian-mcp-smoke-${randomUUID()}`;
const resultText = (result) => result.content.filter((item) => item.type === 'text').map((item) => item.text).join('\n');
async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert(!result.isError, `${name}: ${resultText(result)}`);
  return result;
}

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  for (const name of ['read_file', 'write_file', 'start_search', 'get_more_search_results', 'start_process']) {
    assert(tools.some((tool) => tool.name === name), `Missing tool: ${name}`);
  }
  await call('create_directory', { path: directory });
  const note = 'Synthetic vault note — OBSIDIAN_MCP_SEARCH_SENTINEL\n';
  await call('write_file', { path: `${directory}/note.md`, content: note });
  assert.equal(await readFile(`${directory}/note.md`, 'utf8'), note);
  const read = await call('read_file', { path: `${directory}/note.md` });
  assert(resultText(read).includes('OBSIDIAN_MCP_SEARCH_SENTINEL'));

  const search = await call('start_search', {
    path: directory, pattern: 'OBSIDIAN_MCP_SEARCH_SENTINEL', searchType: 'content', literalSearch: true,
  });
  let searchText = resultText(search);
  const session = searchText.match(/session:\s*([A-Za-z0-9_-]+)/i)?.[1];
  if (session) {
    for (let attempt = 0; attempt < 20; attempt++) {
      const page = resultText(await call('get_more_search_results', { sessionId: session }));
      searchText += page;
      if (page.includes('OBSIDIAN_MCP_SEARCH_SENTINEL')) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  assert(searchText.includes('OBSIDIAN_MCP_SEARCH_SENTINEL'), 'Content search must find note text');
  if (session) await call('stop_search', { sessionId: session });

  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6ZAAAAABJRU5ErkJggg==';
  await call('write_file', { path: `${directory}/image.png`, content: png });
  assert.deepEqual(await readFile(`${directory}/image.png`), Buffer.from(png, 'base64'));

  const binary = Buffer.from([0, 255, 128, 10, 13, 1, 2, 3]);
  const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n% synthetic storage fixture\n'), binary]);
  const script = `import base64,pathlib\nroot=pathlib.Path(${JSON.stringify(directory)})\n` +
    `root.joinpath('reference.pdf').write_bytes(base64.b64decode('${pdf.toString('base64')}'))\n` +
    `root.joinpath('attachment.bin').write_bytes(base64.b64decode('${binary.toString('base64')}'))\nprint('BINARY_WRITE_OK')\n`;
  const encoded = Buffer.from(script).toString('base64');
  const command = `python3 -c "import base64;exec(base64.b64decode('${encoded}'))"`;
  const terminal = await call('start_process', { command, timeout_ms: 10000 });
  assert(resultText(terminal).includes('BINARY_WRITE_OK'), 'Terminal upload must complete');
  assert.deepEqual(await readFile(`${directory}/reference.pdf`), pdf);
  assert.deepEqual(await readFile(`${directory}/attachment.bin`), binary);

  // Container isolation remains effective even for unrestricted shell tools.
  assert.equal(process.env.OBSIDIAN_AUTH_TOKEN, undefined);
  await assert.rejects(stat('/home/node/.config/obsidian-headless/auth_token'), { code: 'ENOENT' });
  const config = JSON.parse(await readFile('/home/node/.claude-server-commander/config.json', 'utf8'));
  assert.deepEqual(config.allowedDirectories, ['/vault']);
  assert.equal(config.telemetryEnabled, false);
  assert.equal(process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY, '1');
  console.log(`PASS: bearer rejection, MCP handshake, ${tools.length} tools, note read/write, grep, PNG/PDF/binary writes, credential isolation, telemetry configuration.`);
} finally {
  await client.close().catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
