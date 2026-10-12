import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { startCompanion } from '../desktop/companion.mjs';

test('companion restricts origin/token and runs real configured stdio MCP with timeout', async () => {
  const token = 'test-pairing-token-at-least-32-characters';
  const origin = 'http://localhost:8080';
  const runtime = await startCompanion({ token, allowedOrigins: [origin], timeoutMs: 1000,
    servers: { fixture: { command: process.execPath, args: [fileURLToPath(new URL('../desktop/mock-mcp.mjs', import.meta.url))] } } }, { port: 4338 });
  const url = 'http://127.0.0.1:4338/mcp/fixture';
  const post = (rpc, headers = {}) => fetch(url, { method: 'POST', headers: { origin, authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers }, body: JSON.stringify(rpc) });
  try {
    assert.equal((await fetch(url)).status, 403);
    assert.equal((await post({}, { origin: 'https://untrusted.example' })).status, 403);
    assert.equal((await post({}, { authorization: 'Bearer wrong' })).status, 401);
    const init = await (await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })).json();
    assert.equal(init.result.serverInfo.name, 'test-server');
    const listing = await (await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json();
    assert.equal(listing.result.tools[0].name, 'echo');
    const result = await (await post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { text: 'real pipe roundtrip' } } })).json();
    assert.equal(result.result.content[0].text, 'real pipe roundtrip');
    assert.equal((await post({ jsonrpc: '2.0', id: 4, method: 'browser/spawn', params: { command: 'anything' } })).status, 400);
    const timeout = await (await post({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'hang', arguments: {} } })).json();
    assert.match(timeout.error.message, /timed out/);
    const status = await (await fetch('http://127.0.0.1:4338/status', { headers: { origin, authorization: `Bearer ${token}` } })).json();
    assert.ok(status.logs.length > 0);
    assert.ok(!JSON.stringify(status).includes('real pipe roundtrip'));
    assert.ok(!JSON.stringify(status).includes(token));
  } finally { await runtime.close(); }
});
