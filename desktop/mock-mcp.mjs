// Test fixture only: a deterministic stdio MCP server; never registered in the app.
import readline from 'node:readline';
for await (const line of readline.createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.id == null) continue;
  let result = {};
  if (message.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'test-server', version: '1' } };
  if (message.method === 'tools/list') result = { tools: [{ name: 'echo', description: 'Echo test', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] };
  if (message.method === 'tools/call') {
    if (message.params.name === 'hang') continue;
    result = { content: [{ type: 'text', text: message.params.arguments.text }] };
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n');
}
