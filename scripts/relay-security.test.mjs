import test from 'node:test';
import assert from 'node:assert/strict';
import { isPublicAddress, safeFetch } from '../src/lib/relay-security.server.ts';

test('relay excludes private, mapped, metadata and reserved IP ranges', () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '192.168.1.2', '172.31.2.1', '169.254.169.254', '100.64.1.1', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '2001:db8::1', '224.0.0.1']) assert.equal(isPublicAddress(address), false, address);
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.equal(isPublicAddress(address), true, address);
});
test('relay rejects private URLs and credentials before opening a socket', async () => {
  for (const url of ['http://example.com', 'https://127.0.0.1', 'https://[::1]', 'https://user:secret@example.com', 'https://example.com:8443']) await assert.rejects(safeFetch(url));
});
