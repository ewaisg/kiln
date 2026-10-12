import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
let challenge, tokenExchanges = 0;
try {
  const page = await browser.newPage();
  await page.route('**/api/mcp-oauth', async route => {
    const input = route.request().postDataJSON();
    if (input.action === 'discover') return route.fulfill({ json: { issuer: 'https://oauth.example', resource: 'https://mcp.example/mcp', authorizationEndpoint: 'https://oauth.example/authorize', tokenEndpoint: 'https://oauth.example/token', scopes: ['tools:read'] } });
    tokenExchanges++;
    assert.equal(input.code, 'mock-authorization-code'); assert.equal(input.clientId, 'public-client');
    assert.equal(input.resource, 'https://mcp.example/mcp');
    assert.equal(createHash('sha256').update(input.verifier).digest('base64url'), challenge);
    return route.fulfill({ json: { accessToken: 'mock-oauth-token', expiresIn: 3600 } });
  });
  await page.route('https://oauth.example/authorize?**', async route => {
    const url = new URL(route.request().url());
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256'); challenge = url.searchParams.get('code_challenge');
    assert.equal(url.searchParams.get('resource'), 'https://mcp.example/mcp');
    const redirect = new URL(url.searchParams.get('redirect_uri'));
    redirect.search = new URLSearchParams({ state: url.searchParams.get('state'), code: 'mock-authorization-code', iss: 'https://oauth.example' }).toString();
    await route.fulfill({ status: 302, headers: { location: redirect.toString() } });
  });
  await page.goto('http://127.0.0.1:8080', { waitUntil: 'domcontentloaded' });
  await page.getByRole('textbox', { name: 'Message', exact: true }).waitFor();
  await page.evaluate(async () => {
    const source = await (await fetch('/src/lib/mcp-oauth.ts')).text();
    const storePath = source.match(/from\s+["']([^"']*\/store\.ts[^"']*)["']/)?.[1] ?? '/src/lib/store.ts';
    const { useKiln } = await import(storePath); await useKiln.persist.rehydrate();
    useKiln.getState().upsertMcp({ id: 'oauth-test', name: 'OAuth test', url: 'https://mcp.example/mcp', token: '', oauthClientId: 'public-client' });
    useKiln.getState().updateSettings({ rememberCredentials: false });
  });
  // Wait for the durable configuration commit before leaving this page.
  await page.waitForFunction(async () => {
    const db = await new Promise(resolve => { const request = indexedDB.open('kiln', 3); request.onsuccess = () => resolve(request.result); });
    const data = await new Promise(resolve => { const request = db.transaction('workspace').objectStore('workspace').get('kiln-v1'); request.onsuccess = () => resolve(request.result); }); db.close();
    return data && JSON.parse(data).state.mcpServers.some(server => server.id === 'oauth-test');
  });
  await page.evaluate(async () => {
    const { startMcpOAuth } = await import('/src/lib/mcp-oauth.ts');
    await startMcpOAuth({ id: 'oauth-test', name: 'OAuth test', url: 'https://mcp.example/mcp', token: '', oauthClientId: 'public-client' });
  }).catch(error => { if (!error.message.includes('Execution context was destroyed')) throw error; });
  await page.waitForURL('http://127.0.0.1:8080/');
  await page.getByRole('textbox', { name: 'Message', exact: true }).waitFor();
  assert.equal(tokenExchanges, 1);
  assert.ok(!page.url().includes('code='));
  const persisted = await page.evaluate(async () => {
    const db = await new Promise(resolve => { const request = indexedDB.open('kiln', 3); request.onsuccess = () => resolve(request.result); });
    const data = await new Promise(resolve => { const request = db.transaction('workspace').objectStore('workspace').get('kiln-v1'); request.onsuccess = () => resolve(request.result); }); db.close(); return data;
  });
  assert.ok(!persisted.includes('mock-oauth-token'), 'session-only token must not be persisted');
  const rejected = await page.evaluate(async () => {
    const { completeMcpOAuth, pkceChallenge } = await import('/src/lib/mcp-oauth.ts');
    const failures = [];
    for (const [params, pending] of [
      ['?state=wrong&code=attacker-code', { state: 'correct', issuer: 'https://oauth.example', created: Date.now() }],
      ['?state=correct&code=attacker-code&iss=https://attacker.example', { state: 'correct', issuer: 'https://oauth.example', created: Date.now() }],
      ['?state=correct&code=attacker-code', { state: 'correct', issuer: 'https://oauth.example', created: 0 }],
    ]) {
      sessionStorage.setItem('kiln-mcp-oauth-request', JSON.stringify(pending));
      try { await completeMcpOAuth(params); } catch (error) { failures.push(error.message); }
    }
    return { failures, challenge: await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), pendingCleared: sessionStorage.getItem('kiln-mcp-oauth-request') === null };
  });
  assert.equal(rejected.failures.length, 3); assert.equal(tokenExchanges, 1); assert.equal(rejected.pendingCleared, true);
  assert.equal(rejected.challenge, 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  console.log(JSON.stringify({ passed: ['RFC7636 PKCE vector', 'PKCE S256 verifier binding', 'resource and issuer binding', 'state/issuer/expiry attack rejection', 'authorization redirect/callback', 'code removed from history', 'session-only credential persistence'], authorizationServer: 'mocked only', tokenExchanges }, null, 2));
} finally { await browser.close(); }
