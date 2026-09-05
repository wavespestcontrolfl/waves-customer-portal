'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { previewServer } = require('../browser');
const { checkoutStamp } = require('../../dev/context');
const root = path.resolve(__dirname, '../../..');

test('audit rejects an unrelated local server and never stops it', async () => {
  const server = http.createServer((_req, res) => res.end('unrelated preview'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    await assert.rejects(previewServer(root, url), /another checkout or commit/);
    assert.equal((await fetch(url)).status, 200);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('audit may reuse a matching server but does not take ownership', async () => {
  const server = http.createServer((_req, res) => {
    res.setHeader('X-Waves-Checkout', checkoutStamp(root));
    res.end('matching preview');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const preview = await previewServer(root, `${url}/`);
    assert.equal(preview.baseUrl, url, 'A copied URL with a trailing slash must keep same-origin requests working');
    await preview.close();
    assert.equal((await fetch(url)).status, 200);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('preview audit refuses a remote target before making requests', async () => {
  await assert.rejects(previewServer(root, 'https://example.invalid'), /local HTTP server/);
});
