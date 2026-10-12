import { chromium } from 'playwright';
import assert from 'node:assert/strict';
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
let toolCalls = 0, modelTurns = 0;
try {
  const page = await browser.newPage();
  await page.route('**/api/mcp', async route => {
    const { rpc } = route.request().postDataJSON();
    let result = {};
    if (rpc.method === 'initialize') result = { serverInfo: { name: 'Mock MCP' } };
    if (rpc.method === 'tools/list') result = { tools: [{ name: 'lookup', description: 'Look up record', inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } }, { name: 'delete', inputSchema: { type: 'object', properties: {} } }] };
    if (rpc.method === 'tools/call') { toolCalls++; assert.equal(rpc.params.name, 'lookup'); assert.equal(rpc.params.arguments.key, 'actual-argument'); result = { content: [{ type: 'text', text: 'record-result' }] }; }
    await route.fulfill({ json: { ok: true, status: 200, sessionId: 'mock-session', payload: { jsonrpc: '2.0', id: rpc.id, result } } });
  });
  await page.route('**/api/tool-chat', async route => {
    const payload = route.request().postDataJSON(); modelTurns++;
    assert.equal(payload.body.tools.length, 1, 'ungranted delete must never reach model');
    const name = payload.body.tools[0].function.name;
    let chunks;
    if (modelTurns === 1) chunks = [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name, arguments: '{"key":' } }] } }] }, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"actual-argument"}' } }] } }] }];
    else { assert.ok(payload.body.messages.some(message => message.role === 'tool' && message.content === 'record-result')); chunks = [{ choices: [{ delta: { content: 'Used approved tool result.' } }] }]; }
    await route.fulfill({ contentType: 'text/event-stream', body: chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n' });
  });
  await page.goto('http://127.0.0.1:8080', { waitUntil: 'domcontentloaded' });
  await page.getByRole('textbox', { name: 'Message', exact: true }).waitFor();
  const result = await page.evaluate(async () => {
    const source = await (await fetch('/src/lib/tool-chat.ts')).text();
    const storePath = source.match(/from\s+["']([^"']*\/store\.ts[^"']*)["']/)?.[1] ?? '/src/lib/store.ts';
    const { useKiln } = await import(storePath);
    const { streamChatWithTools } = await import('/src/lib/tool-chat.ts');
    await useKiln.persist.rehydrate();
    useKiln.setState({ mcpServers: [{ id: 'qa', name: 'Mock MCP', url: 'https://mcp.example/mcp', token: 'mock-token' }], toolGrants: { 'qa:lookup': true } });
    const events = [], deltas = [];
    let response;
    try { response = await streamChatWithTools({ endpoint: { id: 'mock', kind: 'custom', name: 'Mock', baseUrl: 'https://mock.example/v1', apiKey: 'mock-key', model: 'mock-tool-model', apiVersion: '', direct: false }, messages: [{ role: 'user', content: 'Look up my record' }], temperature: 0.4, maxTokens: 100, signal: new AbortController().signal, onDelta: value => deltas.push(value), onToolEvent: event => events.push(event) }); }
    catch (error) { throw new Error(error.message + ' EVENTS ' + JSON.stringify(events)); }
    return { response, events, deltas };
  });
  assert.equal(result.response, 'Used approved tool result.');
  assert.equal(toolCalls, 1); assert.equal(modelTurns, 2);
  assert.ok(result.events.some(event => event.phase === 'running'));
  assert.ok(result.events.some(event => event.phase === 'complete'));
  console.log(JSON.stringify({ passed: ['model-driven MCP discovery', 'grant-filtered schemas', 'streamed tool argument assembly', 'actual argument payload', 'tool result follow-up', 'processing events'], upstream: 'mocked only', toolCalls, modelTurns }, null, 2));
} finally { await browser.close(); }
