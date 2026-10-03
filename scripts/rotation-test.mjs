import {Client} from '/app/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import {StreamableHTTPClientTransport} from '/app/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js';
import assert from 'node:assert/strict';
import {writeFile, unlink} from 'node:fs/promises';
const url = new URL('http://127.0.0.1:8000/mcp');
const transport = new StreamableHTTPClientTransport(url, {requestInit: {headers: {Authorization: 'Bearer synthetic-ci-mcp-key'}}});
const client = new Client({name: 'rotation-test', version: '1'});
await client.connect(transport);
assert((await client.listTools()).tools.length > 0);
const session = transport.sessionId;
assert(session);
await writeFile('/vault/ci-rotation-ready', 'ready');
let rotated = false;
for (let i = 0; i < 40; i++) {
  try {
    const response = await fetch(url, {method: 'POST', headers: {Authorization: 'Bearer synthetic-ci-mcp-key', 'Mcp-Session-Id': session, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream'}, body: JSON.stringify({jsonrpc: '2.0', id: 10, method: 'tools/list', params: {}})});
    await response.body?.cancel();
    if (response.status === 401) {rotated = true; break;}
  } catch {}
  await new Promise(r => setTimeout(r, 500));
}
assert(rotated, 'Old key and existing session must be rejected after rotation');
await client.close();
const replacement = new Client({name: 'rotation-replacement', version: '1'});
await replacement.connect(new StreamableHTTPClientTransport(url, {requestInit: {headers: {Authorization: 'Bearer synthetic-ci-replacement-key'}}}));
assert((await replacement.listTools()).tools.length > 0);
await replacement.close();
await unlink('/vault/ci-rotation-ready');
console.log('PASS: old MCP key/session revoked, replacement authenticated');
