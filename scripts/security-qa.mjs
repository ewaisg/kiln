import assert from 'node:assert/strict';
const base = process.env.KILN_QA_URL ?? 'http://127.0.0.1:8080';
const results = [];
for (const path of ['/api/chat', '/api/models', '/api/mcp', '/api/tool-chat', '/api/media', '/api/mcp-oauth']) {
  const response = await fetch(base + path, { method: 'POST', headers: { origin: 'https://untrusted.example', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 403, `${path}: cross origin must be rejected`);
  results.push(`${path}: cross-origin rejection`);
}
for (const address of ['https://127.0.0.1', 'https://[::1]', 'https://169.254.169.254', 'https://user:secret@example.com']) {
  const response = await fetch(base + '/api/mcp', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ url: address, token: '', rpc: { jsonrpc: '2.0', id: 1, method: 'initialize' } }) });
  assert.equal(response.status, 400, `${address}: SSRF target must be rejected`);
}
results.push('MCP: loopback, IPv6, metadata, URL-credential rejection');
console.log(JSON.stringify({ passed: results, paidRequests: 0 }, null, 2));
