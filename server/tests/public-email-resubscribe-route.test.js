'use strict';

// GET/POST /api/public/email-resubscribe/:token (GATE_PORTAL_EMAIL_RESUBSCRIBE).
// Real router, real express, the real service over a recording fake db. The release itself
// (SendGrid first, then the transaction, retry after a failure) is proven on real SQL in
// public-email-resubscribe-postgres.test.js and email-resubscribe-postgres.test.js.

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const express = require('express');

// A fresh copy of the router (and its 20-per-minute limiter) for every test.
let db;
let logger;
let Resub;
let router;
function loadFresh() {
  jest.isolateModules(() => {
    db = require('../models/db');
    logger = require('../services/logger');
    Resub = require('../services/email-resubscribe');
    router = require('../routes/public-email-resubscribe');
  });
}

const TOKEN = 'B'.repeat(43);
const NOW = Date.now();
let request;
let suppressions;
let hardBlock;
let calls;

// Records every builder call. Reads resolve to `request` (first) or `suppressions` (thenable).
function installDb() {
  calls = [];
  db.mockImplementation((table) => {
    const builder = new Proxy({}, {
      get: (_t, method) => {
        if (method === 'then') {
          return (resolve, reject) => Promise.resolve(table === 'email_suppressions' ? suppressions : []).then(resolve, reject);
        }
        return (...args) => {
          calls.push([table, String(method), ...args]);
          if (method === 'first') {
            if (table === 'email_resubscribe_requests') return Promise.resolve(request);
            return Promise.resolve(table === 'email_suppressions' && hardBlock ? { id: 'block-1' } : undefined);
          }
          return builder;
        };
      },
    });
    return builder;
  });
  db.raw = (sql) => ({ sql });
  db.transaction = jest.fn(async () => { throw new Error('no transaction expected on a GET'); });
}
const writes = () => calls.filter(([, method]) => ['insert', 'update', 'del', 'delete'].includes(method));

let server;
let baseUrl;
afterEach((done) => { server.close(done); });

beforeEach((done) => {
  loadFresh();
  request = {
    id: 'req-1', email: 'pat@example.com', customer_id: 'cust-1', sent_at: new Date(NOW - 1000),
    expires_at: new Date(NOW + 3600000), used_at: null,
  };
  suppressions = [{ id: 'sup-1', email: 'pat@example.com', group_key: null }];
  hardBlock = false;
  installDb();
  process.env.GATE_PORTAL_EMAIL_RESUBSCRIBE = 'true';
  const app = express();
  app.use(express.json());
  app.use('/api/public/email-resubscribe', router);
  server = app.listen(0, '127.0.0.1', () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterEach(() => { delete process.env.GATE_PORTAL_EMAIL_RESUBSCRIBE; jest.restoreAllMocks(); });

const get = (token = TOKEN) => fetch(`${baseUrl}/api/public/email-resubscribe/${token}`);
const post = (token = TOKEN, { form = true } = {}) => fetch(`${baseUrl}/api/public/email-resubscribe/${token}`, {
  method: 'POST',
  headers: { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json' },
  body: form ? '' : '{}',
});
const expectPrivacy = (res) => {
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect(res.headers.get('x-robots-tag')).toBe('noindex');
  expect(res.headers.get('referrer-policy')).toBe('no-referrer');
};

describe('GET /:token is read-only', () => {
  test('an open link whose address is still blocked renders the confirm form with the escaped address, and writes nothing', async () => {
    request.email = 'pat+<b>@example.com';
    const complete = jest.spyOn(Resub, 'completeResubscribe');
    const res = await get();
    const html = await res.text();
    expect(res.status).toBe(200);
    expectPrivacy(res);
    expect(html).toContain('Turn Waves emails back on?');
    expect(html).toContain('pat+&lt;b&gt;@example.com');
    expect(html).not.toContain('pat+<b>@');
    expect(html).toContain(`<form method="POST" action="/api/public/email-resubscribe/${TOKEN}">`);
    expect(html).toContain('Turn emails back on');
    expect(writes()).toEqual([]);
    expect(db.transaction).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  test('an open link whose address now has a hard block shows the generic expired page: no button, no write', async () => {
    hardBlock = true;
    const res = await get();
    const html = await res.text();
    expect(res.status).toBe(404);
    expectPrivacy(res);
    expect(html).toContain('This link has expired or was already used.');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('pat@example.com');
    expect(writes()).toEqual([]);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  test('a link refused for a hard block stays the generic expired page on every reopen and re-press', async () => {
    request.used_at = new Date();
    request.outcome = { refused: 'hard_block' };
    const complete = jest.spyOn(Resub, 'completeResubscribe');
    for (let i = 0; i < 2; i += 1) {
      const page = await get();
      expect(page.status).toBe(404);
      expect(await page.text()).toContain('This link has expired or was already used.');
      const press = await post();
      expect(press.status).toBe(404);
      const html = await press.text();
      expect(html).toContain('This link has expired or was already used.');
      expect(html).not.toContain("You're all set.");
    }
    expect(complete).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
  });

  test("a used link, or an address with nothing left to release, says You're all set and writes nothing", async () => {
    request.used_at = new Date();
    let res = await get();
    expect(await res.text()).toContain("You're all set.");
    expect(res.status).toBe(200);
    request.used_at = null;
    suppressions = [];
    res = await get();
    expect(await res.text()).toContain("You're all set.");
    expect(writes()).toEqual([]);
  });

  test.each([
    ['an expired link', () => { request.expires_at = new Date(NOW - 1000); }],
    ['a never-sent request', () => { request.sent_at = null; }],
    ['an unknown token', () => { request = undefined; }],
  ])('%s: the generic expired page with 404 and privacy headers, no write', async (_name, arrange) => {
    arrange();
    const res = await get();
    expect(res.status).toBe(404);
    expectPrivacy(res);
    expect(await res.text()).toContain('This link has expired or was already used.');
    expect(writes()).toEqual([]);
  });

  test('a malformed token is the same expired page and never reaches the database', async () => {
    for (const bad of ['short', 'x'.repeat(44), `${'B'.repeat(42)}!`]) {
      const res = await get(bad);
      expect(res.status).toBe(404);
      expect(await res.text()).toContain('This link has expired or was already used.');
    }
    expect(db).not.toHaveBeenCalled();
  });

  test('the gate off: every route is the same 404 page and nothing is read', async () => {
    delete process.env.GATE_PORTAL_EMAIL_RESUBSCRIBE;
    const res = await get();
    expect(res.status).toBe(404);
    expectPrivacy(res);
    expect(await res.text()).toContain('This link has expired or was already used.');
    expect((await post()).status).toBe(404);
    expect((await post(TOKEN, { form: false })).status).toBe(404);
    expect(db).not.toHaveBeenCalled();
  });
});

describe('POST /:token', () => {
  test.each([
    ['done', 200, 'Done.', 'Waves emails will reach'],
    ['already', 200, "You're all set.", 'Waves emails are on for this address.'],
    ['retry', 503, "We couldn't finish that.", 'Please try the button again in a few minutes.'],
  ])('form submit, %s: status %s and the page text', async (result, status, heading, body) => {
    const complete = jest.spyOn(Resub, 'completeResubscribe').mockResolvedValue(result);
    const res = await post();
    const html = await res.text();
    expect(res.status).toBe(status);
    expectPrivacy(res);
    expect(html).toContain(heading);
    expect(html).toContain(body);
    if (result === 'done') expect(html).toContain('pat@example.com');
    // Only the retry page offers the button again (same form, same token); done/already do not.
    const form = `<form method="POST" action="/api/public/email-resubscribe/${TOKEN}">`;
    if (result === 'retry') {
      expect(html).toContain(form);
      expect(html).toContain('Turn emails back on');
    } else {
      expect(html).not.toContain(form);
    }
    expect(complete).toHaveBeenCalledWith(request);
  });

  test.each([
    ['done', 200, true],
    ['already', 200, true],
    ['retry', 503, false],
  ])('JSON client, %s: { success, state }', async (result, status, success) => {
    jest.spyOn(Resub, 'completeResubscribe').mockResolvedValue(result);
    const res = await post(TOKEN, { form: false });
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ success, state: result });
  });

  test('a retry is logged by request id only, never the address', async () => {
    jest.spyOn(Resub, 'completeResubscribe').mockResolvedValue('retry');
    await post();
    expect(JSON.stringify(logger.warn.mock.calls)).toContain('req-1');
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('pat@example.com');
  });

  test('a request that expired between the page and the press: the expired page (form) or 404 JSON', async () => {
    jest.spyOn(Resub, 'completeResubscribe').mockResolvedValue('expired');
    const form = await post();
    expect(form.status).toBe(404);
    expect(await form.text()).toContain('This link has expired or was already used.');
    const json = await post(TOKEN, { form: false });
    expect(json.status).toBe(404);
    expect(await json.json()).toEqual({ success: false, state: 'expired' });
  });

  test('a used token never touches SendGrid or the database again', async () => {
    request.used_at = new Date();
    const complete = jest.spyOn(Resub, 'completeResubscribe');
    const res = await post();
    expect(await res.text()).toContain("You're all set.");
    expect(complete).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
  });

  test.each([
    ['an expired link', () => { request.expires_at = new Date(NOW - 1000); }],
    ['an unknown token', () => { request = undefined; }],
  ])('%s: 404, the page for a form and JSON for a client, and nothing released', async (_name, arrange) => {
    arrange();
    const complete = jest.spyOn(Resub, 'completeResubscribe');
    const form = await post();
    expect(form.status).toBe(404);
    expect(await form.text()).toContain('This link has expired or was already used.');
    const json = await post(TOKEN, { form: false });
    expect(json.status).toBe(404);
    expect(await json.json()).toEqual({ success: false, state: 'expired' });
    expect(complete).not.toHaveBeenCalled();
  });

  test('a service error is a 500 with error code only in the log', async () => {
    jest.spyOn(Resub, 'completeResubscribe').mockRejectedValue(Object.assign(new Error('select pat@example.com failed'), { code: '57014' }));
    const res = await post(TOKEN, { form: false });
    expect(res.status).toBe(500);
    expect(JSON.stringify(logger.error.mock.calls)).toContain('57014');
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('pat@example.com');
  });
});

describe('limiter', () => {
  test('the 21st request in a minute is a 429 (gate on)', async () => {
    request = undefined;
    const statuses = [];
    for (let i = 0; i < 21; i += 1) statuses.push((await get()).status);
    expect(statuses.slice(0, 20).every((s) => s === 404)).toBe(true);
    expect(statuses[20]).toBe(429);
  });
});

describe('the early guard ahead of the global /api limiter and the body parsers', () => {
  test('server/index.js mounts the guard before the global /api/ limiter and the JSON parser', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.js'), 'utf8');
    const guardAt = src.indexOf("app.use('/api/public/email-resubscribe', require('./routes/public-email-resubscribe').preParserGuard)");
    expect(guardAt).toBeGreaterThan(-1);
    expect(src.indexOf("app.use('/api/', limiter)")).toBeGreaterThan(guardAt);
    expect(src.indexOf('app.use(express.json(')).toBeGreaterThan(guardAt);
  });

  // The production order: early guard, then the global /api limiter and the body parser, then the router.
  async function withStack({ exhaustedLimiter }, fn) {
    const app = express();
    app.use('/api/public/email-resubscribe', router.preParserGuard);
    if (exhaustedLimiter) app.use('/api/', (_req, res) => res.status(429).json({ error: 'Too many requests' }));
    app.use(express.json());
    app.use('/api/public/email-resubscribe', router);
    const stackServer = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    try {
      await fn(`http://127.0.0.1:${stackServer.address().port}/api/public/email-resubscribe/${TOKEN}`);
    } finally {
      await new Promise((resolve) => stackServer.close(resolve));
    }
  }

  test('dark: an IP the global limiter refuses still gets the generic 404 page with privacy headers, never a 429', async () => {
    delete process.env.GATE_PORTAL_EMAIL_RESUBSCRIBE;
    await withStack({ exhaustedLimiter: true }, async (url) => {
      const res = await fetch(url);
      expect(res.status).toBe(404);
      expectPrivacy(res);
      expect(await res.text()).toContain('Link expired.');
    });
    expect(calls).toEqual([]);
  });

  test('dark: malformed JSON is the same 404, never a parser 400', async () => {
    delete process.env.GATE_PORTAL_EMAIL_RESUBSCRIBE;
    await withStack({ exhaustedLimiter: false }, async (url) => {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad' });
      expect(res.status).toBe(404);
      expectPrivacy(res);
      expect(await res.json()).toEqual({ success: false, state: 'expired' });
    });
  });

  test('live: the global limiter\'s 429 and a parser 400 still carry the privacy headers', async () => {
    await withStack({ exhaustedLimiter: true }, async (url) => {
      const res = await fetch(url);
      expect(res.status).toBe(429);
      expectPrivacy(res);
    });
    await withStack({ exhaustedLimiter: false }, async (url) => {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad' });
      expect(res.status).toBe(400);
      expectPrivacy(res);
    });
  });
});
