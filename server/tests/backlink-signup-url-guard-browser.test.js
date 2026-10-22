/**
 * GATE_BACKLINK_SIGNUP_URL_GUARD, real browser: a redirect hop from a pinned
 * host to a loopback address never connects. Playwright does not route
 * redirect hops, so this is the network-layer lock (guardedLaunchArgs).
 * Skips when no Playwright Chromium is installed (CI image without browsers).
 */

const http = require('http');
const fs = require('fs');

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));

const { _internals } = require('../services/backlink-agent/signup-worker');

let chromium = null;
try {
  ({ chromium } = require('playwright'));
  if (!fs.existsSync(chromium.executablePath())) chromium = null;
} catch { chromium = null; }

const maybe = chromium ? test : test.skip;

maybe('a 302 from the pinned host to 127.0.0.1 is never fetched', async () => {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    if (req.url === '/start') {
      res.writeHead(302, { Location: `http://127.0.0.1:${server.address().port}/secret` });
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end('<p>secret</p>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const pins = { pinned: new Set(['pinned.invalid']), rules: 'MAP pinned.invalid 127.0.0.1' };
  const browser = await chromium.launch({ headless: true, args: _internals.guardedLaunchArgs(pins) });
  try {
    const page = await browser.newPage();
    await page.goto(`http://pinned.invalid:${port}/start`, { timeout: 15000 }).catch(() => {});
    expect(hits).toContain('/start');
    expect(hits).not.toContain('/secret');
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
}, 30000);
