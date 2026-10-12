import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes, timingSafeEqual, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function startCompanion(config, { port = 4318 } = {}) {
  if (!Array.isArray(config.allowedOrigins) || !config.allowedOrigins.length || typeof config.token !== 'string' || config.token.length < 32) {
    throw new Error('Configure exact allowedOrigins and a pairing token of at least 32 characters.');
  }
  const origins = new Set(config.allowedOrigins.map(origin => new URL(origin).origin));
  const processes = new Map();
  const logs = [];
  const log = (server, event) => { logs.push({ time: new Date().toISOString(), server, event }); if (logs.length > 100) logs.shift(); };
  function launch(name) {
    if (processes.has(name)) return processes.get(name);
    const spec = config.servers?.[name];
    if (!spec || typeof spec.command !== 'string' || !Array.isArray(spec.args) || !spec.args.every(arg => typeof arg === 'string')) throw new Error('Unknown configured local server.');
    // Only the user's disk configuration can choose commands. No shell or browser-provided arguments.
    const child = spawn(spec.command, spec.args, { shell: false, windowsHide: true, cwd: spec.cwd,
      env: { ...process.env, ...(spec.env ?? {}) }, stdio: ['pipe', 'pipe', 'pipe'] });
    const state = { child, pending: new Map(), buffer: '', stderrBytes: 0 };
    processes.set(name, state);
    log(name, 'Process started');
    child.stdout.on('data', chunk => {
      state.buffer += chunk.toString();
      if (state.buffer.length > 4_000_000) { child.kill(); return; }
      let newline;
      while ((newline = state.buffer.indexOf('\n')) !== -1) {
        const line = state.buffer.slice(0, newline); state.buffer = state.buffer.slice(newline + 1);
        let message; try { message = JSON.parse(line); } catch { continue; }
        if (message.id != null && (message.result != null || message.error != null)) {
          const pending = state.pending.get(String(message.id));
          if (pending) { state.pending.delete(String(message.id)); pending.resolve(message); }
        } else if (message.id != null && message.method) {
          // No sampling, roots, or elicitation support; never silently execute server requests.
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Client requests are unsupported.' } }) + '\n');
        }
      }
    });
    child.stderr.on('data', chunk => { state.stderrBytes += chunk.length; });
    const fail = error => {
      log(name, 'Process stopped'); processes.delete(name);
      for (const pending of state.pending.values()) pending.reject(error);
      state.pending.clear();
    };
    child.on('error', () => fail(new Error('Local executable could not start. Check its configured absolute path.')));
    child.on('exit', () => fail(new Error('The local MCP process exited.')));
    return state;
  }
  async function rpc(name, message, signal) {
    if (!['initialize', 'notifications/initialized', 'tools/list', 'tools/call', 'notifications/cancelled'].includes(message.method)) throw new Error('Unsupported MCP method.');
    const state = launch(name);
    if (message.id == null) { state.child.stdin.write(JSON.stringify(message) + '\n'); return null; }
    const internal = randomUUID();
    const outgoing = { ...message, id: internal };
    const result = await new Promise((resolveReply, reject) => {
      const stop = () => {
        state.pending.delete(internal);
        state.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: internal, reason: 'Cancelled or timed out' } }) + '\n');
        reject(new Error('MCP call cancelled or timed out.'));
      };
      signal.addEventListener('abort', stop, { once: true });
      state.pending.set(internal, {
        resolve: reply => { signal.removeEventListener('abort', stop); resolveReply(reply); },
        reject: error => { signal.removeEventListener('abort', stop); reject(error); },
      });
      if (signal.aborted) stop(); else state.child.stdin.write(JSON.stringify(outgoing) + '\n');
    });
    log(name, `${message.method} completed`);
    return { ...result, id: message.id };
  }
  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    if (!origin || !origins.has(origin) || !['127.0.0.1', 'localhost'].some(host => req.headers.host === `${host}:${port}`)) {
      res.writeHead(403); res.end('Origin or host rejected'); return;
    }
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'Origin');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    res.setHeader('access-control-allow-headers', 'authorization,content-type,mcp-protocol-version,mcp-session-id');
    res.setHeader('access-control-expose-headers', 'mcp-session-id');
    res.setHeader('access-control-allow-private-network', 'true');
    res.setHeader('cache-control', 'no-store');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const received = Buffer.from((req.headers.authorization ?? '').replace(/^Bearer /, ''));
    const expected = Buffer.from(config.token);
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) { res.writeHead(401); res.end('Pairing token required'); return; }
    try {
      if (req.method === 'GET' && req.url === '/status') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ servers: Object.keys(config.servers ?? {}), logs, running: [...processes.keys()] })); return;
      }
      if (req.method !== 'POST' || !req.url?.startsWith('/mcp/')) { res.writeHead(404); res.end(); return; }
      const name = decodeURIComponent(req.url.slice(5));
      let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 200_000) throw new Error('Request too large'); }
      const message = JSON.parse(raw);
      if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') throw new Error('Invalid MCP request');
      const controller = new AbortController();
      res.once('close', () => { if (!res.writableEnded) controller.abort(); });
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(Math.min(120_000, Math.max(1000, config.timeoutMs ?? 60_000)))]);
      const result = await rpc(name, message, signal);
      res.setHeader('content-type', 'application/json');
      res.end(result == null ? '' : JSON.stringify(result));
    } catch (error) {
      if (!res.destroyed) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: error.message } })); }
    }
  });
  await new Promise(resolveStarted => server.listen(port, '127.0.0.1', resolveStarted));
  return { server, close: async () => { for (const state of processes.values()) state.child.kill(); await new Promise(done => server.close(done)); } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const configFile = resolve(process.argv[2] ?? 'desktop/companion.config.json');
  if (process.argv.includes('--init')) {
    const template = { allowedOrigins: ['http://localhost:8080'], token: randomBytes(32).toString('base64url'), timeoutMs: 60000, servers: {} };
    await writeFile(configFile, JSON.stringify(template, null, 2), { flag: 'wx', mode: 0o600 });
    console.log('Created companion configuration. Add server executable paths and exact Kiln origins before starting.');
  } else {
    const config = JSON.parse(await readFile(configFile, 'utf8'));
    const runtime = await startCompanion(config);
    console.log('Kiln companion listening on loopback port 4318. Credentials and tool content are not logged.');
    for (const event of ['SIGINT', 'SIGTERM']) process.on(event, () => { void runtime.close().then(() => process.exit()); });
  }
}
