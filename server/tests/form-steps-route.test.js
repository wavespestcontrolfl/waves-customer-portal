/**
 * POST /api/public/form-steps — anonymous, cookie-free quote-form and quiz
 * step counter (a near copy of the blog read-depth beacon). Contract
 * (mirrored in docs/public-route-contracts.md):
 *
 *  - No feature gate: it only counts anonymous daily totals.
 *  - Site is derived ONLY from the Origin header (never the body); a
 *    missing/null/unknown origin drops the beacon with 204 and no write.
 *  - `f` must be a known form and `s` a step of THAT form (FORM_STEPS);
 *    anything else is dropped with the same 204, as is a bad or oversized
 *    body. Nothing is written for a dropped beacon.
 *  - Nothing about the request (IP, UA, referrer, form, step) is ever
 *    logged — the write failure path logs only a fixed error kind.
 */
const mockInsert = jest.fn();
const mockLoggerWarn = jest.fn();
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: (...args) => mockLoggerWarn(...args), error: jest.fn() }));
jest.mock('../models/db', () => {
  const db = jest.fn();
  // The route writes through ONE parameterized upsert: capture its SQL and
  // bindings as mockInsert(sql, bindings).
  db.raw = (sql, bindings) => mockInsert(sql, bindings);
  return db;
});

// The shared server takes well over the default 120/min per-IP cap in this
// file (the every-step test alone sends 44), so lift it here; the rate
// limiting test below builds its own router with a tiny cap.
process.env.FORM_STEPS_RATE_MAX = '100000';

const http = require('http');
const express = require('express');
const { notFoundBody } = require('../middleware/errors');
const { FORM_STEPS, _private } = require('../routes/public-form-steps');

// The first POST of the file lazy-loads the body parser and its charset
// tables inside jest's module registry. On a loaded machine that one request
// has passed the 5 s default (two timeouts with every assertion still
// green), so this file allows 30 s a test.
jest.setTimeout(30000);

let server;
let base;

const mockFellThrough = jest.fn();

function startServer() {
  const app = express();
  app.use('/api/public/form-steps', require('../routes/public-form-steps'));
  // Stands in for everything mounted after the router in server/index.js
  // (the request logger among it): nothing may ever reach it.
  app.use((req, res) => { mockFellThrough(req.method, req.originalUrl); res.status(599).end(); });
  server = app.listen(0);
  return new Promise((resolve) => server.once('listening', () => {
    base = `http://127.0.0.1:${server.address().port}`;
    resolve();
  }));
}

function stopServer() {
  return new Promise((resolve) => (server ? server.close(resolve) : resolve()));
}

// Node's global fetch refuses to set an Origin request header, and this
// route's contract is keyed on that header, so drive it with raw http.
function post(body, { origin, raw, path = '/api/public/form-steps', method = 'POST' } = {}) {
  return new Promise((resolve, reject) => {
    const payload = raw !== undefined ? raw : JSON.stringify(body);
    // An explicit length, as a browser sends: Node's client leaves a body on
    // DELETE unframed, and the server's own parser answers that with a 400
    // before Express sees the request.
    const headers = { 'Content-Type': 'text/plain;charset=UTF-8', 'Content-Length': Buffer.byteLength(payload) };
    if (origin !== undefined) headers.Origin = origin;
    const req = http.request(`${base}${path}`, { method, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function send(method, path, { origin } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (origin !== undefined) headers.Origin = origin;
    const req = http.request(`${base}${path}`, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

const SPOKE_ORIGIN = 'https://www.parrishpestcontrol.com';
const HUB_ORIGIN = 'https://wavespestcontrol.com';
const GOOD_BODY = { f: 'quote', s: 'email' };

const flush = async () => { for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r)); };
const written = (i = 0) => {
  const [sql, b] = mockInsert.mock.calls[i];
  return { sql, site: b[0], form: b[1], step: b[2], cap: b[3] };
};

beforeEach(async () => {
  mockInsert.mockReset();
  mockLoggerWarn.mockClear();
  mockFellThrough.mockClear();
  await startServer();
});

afterEach(() => stopServer());

describe('allowlist', () => {
  test('the exported allowlist is exactly the agreed forms and steps', () => {
    expect(Object.keys(FORM_STEPS).sort()).toEqual(['lawn_quiz', 'pest_quiz', 'quote']);
    expect(FORM_STEPS.quote).toEqual([
      'view', 'start', 'interest', 'frequency', 'family', 'product', 'cadence',
      'name', 'email', 'phone', 'address', 'lead',
    ]);
    const quiz = [
      'view', 'start', 'seeing', 'property', 'timeline', 'name', 'email', 'phone',
      'address', 'lead', 'end_call', 'end_business', 'end_price', 'end_review',
      'call_tap', 'price_tap',
    ];
    expect(FORM_STEPS.pest_quiz).toEqual(quiz);
    expect(FORM_STEPS.lawn_quiz).toEqual(quiz);
  });
});

describe('valid beacon', () => {
  test('writes one upsert with (day, site, form, step) and responds 204', async () => {
    const res = await post(GOOD_BODY, { origin: SPOKE_ORIGIN });
    expect(res.status).toBe(204);
    expect(res.headers['cache-control']).toMatch(/no-store/);
    await flush();
    expect(mockInsert).toHaveBeenCalledTimes(1);
    const w = written();
    expect(w).toMatchObject({ site: 'parrishpestcontrol.com', form: 'quote', step: 'email' });
    expect(w.sql).toMatch(/INSERT INTO form_step_daily \(day, site, form, step, count\)/);
    expect(w.sql).toMatch(/\(now\(\) AT TIME ZONE 'America\/New_York'\)::date/);
    expect(w.sql).toMatch(/ON CONFLICT \(day, site, form, step\)/);
    expect(w.sql).toMatch(/DO UPDATE SET count = form_step_daily\.count \+ 1\s+WHERE/);
  });

  test('each of the three forms writes its own row', async () => {
    for (const form of ['quote', 'pest_quiz', 'lawn_quiz']) {
      mockInsert.mockClear();
      const res = await post({ f: form, s: 'view' }, { origin: HUB_ORIGIN });
      expect(res.status).toBe(204);
      await flush();
      expect(mockInsert).toHaveBeenCalledTimes(1);
      expect(written()).toMatchObject({ site: 'wavespestcontrol.com', form, step: 'view' });
    }
  });

  test('every allowlisted step of every form is accepted', async () => {
    for (const [form, steps] of Object.entries(FORM_STEPS)) {
      for (const step of steps) {
        mockInsert.mockClear();
        const res = await post({ f: form, s: step }, { origin: SPOKE_ORIGIN });
        expect(res.status).toBe(204);
        await flush();
        expect(mockInsert).toHaveBeenCalledTimes(1);
        expect(written()).toMatchObject({ form, step });
      }
    }
  });

  test('www. is stripped and the hub origin resolves to its own key', async () => {
    await post(GOOD_BODY, { origin: SPOKE_ORIGIN });
    await post(GOOD_BODY, { origin: HUB_ORIGIN });
    await flush();
    expect(written(0).site).toBe('parrishpestcontrol.com');
    expect(written(1).site).toBe('wavespestcontrol.com');
  });

  test('a site key in the body is ignored', async () => {
    await post({ ...GOOD_BODY, site: 'evil.example.com' }, { origin: SPOKE_ORIGIN });
    await flush();
    expect(written().site).toBe('parrishpestcontrol.com');
  });
});

describe('origin handling', () => {
  test.each([
    ['missing', {}],
    ['the literal "null"', { origin: 'null' }],
    ['an unknown (non-fleet)', { origin: 'https://evil-scraper.example.com' }],
    ['the credentialed portal', { origin: 'https://portal.wavespestcontrol.com' }],
    // Shapes the fleet registry's normalizer would accept as configuration
    // values. A browser's Origin is one serialized https origin, nothing else.
    ['a bare fleet domain as the', { origin: 'wavespestcontrol.com' }],
    ['a fleet URL with a path as the', { origin: 'https://wavespestcontrol.com/pest-control-quiz/' }],
    ['a fleet URL with a trailing slash as the', { origin: 'https://wavespestcontrol.com/' }],
    ['a fleet host with a port as the', { origin: 'https://wavespestcontrol.com:8443' }],
    ['a plain-http fleet', { origin: 'http://wavespestcontrol.com' }],
    ['a JSON list of fleet domains as the', { origin: '["wavespestcontrol.com","parrishpestcontrol.com"]' }],
    ['a comma-joined pair as the', { origin: 'https://evil.example.com, https://wavespestcontrol.com' }],
  ])('%s origin gives 204 with no write', async (_name, opts) => {
    const res = await post(GOOD_BODY, opts);
    expect(res.status).toBe(204);
    await flush();
    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockFellThrough).not.toHaveBeenCalled();
  });

  test('resolveSite never throws, whatever the header holds', () => {
    const { resolveSite } = _private;
    // A JSON list of non-strings made the registry's normalizer throw; that
    // ran after the 204, so the throw reached the app's error logger.
    for (const origin of ['[{"toString":1}]', '[null,{}]', '{', '', ' ', 'https://', ['https://wavespestcontrol.com'], 42, null, undefined]) {
      expect(resolveSite({ headers: { origin } })).toBeNull();
    }
    expect(resolveSite({ headers: {} })).toBeNull();
    expect(resolveSite({ headers: { origin: 'https://www.venicelawncare.com' } })).toBe('venicelawncare.com');
  });
});

describe('dropped beacons answer 204 and write nothing', () => {
  test('a step from another form\'s list', async () => {
    for (const body of [
      { f: 'quote', s: 'seeing' },
      { f: 'quote', s: 'end_call' },
      { f: 'pest_quiz', s: 'frequency' },
      { f: 'lawn_quiz', s: 'cadence' },
    ]) {
      const res = await post(body, { origin: SPOKE_ORIGIN });
      expect(res.status).toBe(204);
    }
    await flush();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  test('an unknown form, an unknown or missing step, wrong types', async () => {
    for (const body of [
      { f: 'contact', s: 'view' },
      { f: 'Quote', s: 'view' },
      { f: '', s: 'view' },
      { f: 'quote', s: 'nope' },
      { f: 'quote', s: '' },
      { f: 'quote' },
      { s: 'view' },
      {},
      { f: 1, s: 'view' },
      { f: 'quote', s: null },
      { f: ['quote'], s: ['view'] },
    ]) {
      const res = await post(body, { origin: SPOKE_ORIGIN });
      expect(res.status).toBe(204);
    }
    await flush();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  test('prototype keys never count as a form or step', async () => {
    for (const raw of [
      '{"f":"__proto__","s":"view"}',
      '{"f":"constructor","s":"view"}',
      '{"f":"toString","s":"view"}',
      '{"f":"hasOwnProperty","s":"length"}',
      '{"f":"quote","s":"__proto__"}',
      '{"f":"quote","s":"constructor"}',
      '{"__proto__":{"f":"quote","s":"view"}}',
      '{"constructor":{"prototype":{"f":"quote","s":"view"}}}',
    ]) {
      const res = await post(null, { origin: SPOKE_ORIGIN, raw });
      expect(res.status).toBe(204);
    }
    await flush();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  test('non-JSON, a JSON array or scalar, and an empty body', async () => {
    for (const raw of ['not json at all', '[1,2,3]', '"just a string"', '42', 'null', '']) {
      const res = await post(null, { origin: SPOKE_ORIGIN, raw });
      expect(res.status).toBe(204);
    }
    await flush();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  test('an oversized body (over the 1 KB cap) is dropped with 204, never stored', async () => {
    const res = await post(null, { origin: SPOKE_ORIGIN, raw: JSON.stringify({ ...GOOD_BODY, junk: 'x'.repeat(5000) }) });
    expect(res.status).toBe(204);
    await flush();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  test('only POST / reads a body: an oversized body anywhere else gets the terminal 404', async () => {
    const raw = JSON.stringify({ ...GOOD_BODY, junk: 'x'.repeat(5000) });
    for (const [method, path] of [
      ['POST', '/api/public/form-steps/extra'],
      ['PUT', '/api/public/form-steps'],
      ['DELETE', '/api/public/form-steps/a/b'],
    ]) {
      const res = await post(null, { origin: SPOKE_ORIGIN, raw, path, method });
      expect({ method, path, status: res.status }).toEqual({ method, path, status: 404 });
      expect(res.headers['cache-control']).toMatch(/no-store/);
    }
    // A well-formed beacon on a wrong path counts nothing either.
    expect((await post(GOOD_BODY, { origin: SPOKE_ORIGIN, path: '/api/public/form-steps/extra' })).status).toBe(404);
    await flush();
    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockFellThrough).not.toHaveBeenCalled();
  });

  test('validateBody pins each error branch', () => {
    const { validateBody } = _private;
    expect(validateBody('{"f":"quote","s":"view"}')).toEqual({ value: { f: 'quote', s: 'view' } });
    expect(validateBody('{')).toEqual({ error: 'invalid_json' });
    expect(validateBody('[]')).toEqual({ error: 'invalid_json' });
    expect(validateBody(undefined)).toEqual({ error: 'invalid_json' });
    expect(validateBody('{"f":"x","s":"view"}')).toEqual({ error: 'invalid_form' });
    expect(validateBody('{"f":"quote","s":"seeing"}')).toEqual({ error: 'invalid_step' });
  });
});

describe('rate limiting', () => {
  // A fresh router instance (and rate-limit store) with a tiny cap, so the
  // rest of the file keeps the default 120/min.
  test('the per-route limiter returns 429 past its cap', async () => {
    let isolatedServer;
    const prevMax = process.env.FORM_STEPS_RATE_MAX;
    process.env.FORM_STEPS_RATE_MAX = '3';
    try {
      jest.isolateModules(() => {
        const app = express();
        app.use('/api/public/form-steps', require('../routes/public-form-steps'));
        isolatedServer = app.listen(0);
      });
      await new Promise((resolve) => isolatedServer.once('listening', resolve));
      const isolatedBase = `http://127.0.0.1:${isolatedServer.address().port}`;
      const hit = () => new Promise((resolve, reject) => {
        const req = http.request(`${isolatedBase}/api/public/form-steps`, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=UTF-8', Origin: SPOKE_ORIGIN },
        }, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        });
        req.on('error', reject);
        req.write(JSON.stringify(GOOD_BODY));
        req.end();
      });
      const statuses = [];
      for (let i = 0; i < 5; i += 1) statuses.push(await hit());
      expect(statuses).toEqual([204, 204, 204, 429, 429]);
    } finally {
      if (prevMax === undefined) delete process.env.FORM_STEPS_RATE_MAX;
      else process.env.FORM_STEPS_RATE_MAX = prevMax;
      await new Promise((resolve) => (isolatedServer ? isolatedServer.close(resolve) : resolve()));
    }
  });
});

describe('write failures and logging', () => {
  test('the response is 204 even when the write rejects, and only a fixed error kind is logged', async () => {
    mockInsert.mockImplementationOnce(() => Promise.reject(Object.assign(new Error('boom'), { code: '23505' })));
    const res = await post(GOOD_BODY, { origin: SPOKE_ORIGIN });
    expect(res.status).toBe(204);
    await flush();
    expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
    const [line] = mockLoggerWarn.mock.calls[0];
    expect(line).toBe('[form-steps] write failed: 23505');
    expect(line).not.toContain('quote');
    expect(line).not.toContain('email');
    expect(line).not.toContain('parrishpestcontrol.com');
  });

  test('a synchronous throw from the write is also swallowed', async () => {
    mockInsert.mockImplementationOnce(() => { throw new Error('sync boom'); });
    const res = await post(GOOD_BODY, { origin: SPOKE_ORIGIN });
    expect(res.status).toBe(204);
    await flush();
    expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
  });

  test('a code-less failure never logs its message (knex embeds the SQL and bound values)', async () => {
    const leaky = 'insert into "form_step_daily" (...) values (..., \'parrishpestcontrol.com\', \'quote\', \'email\') - Connection terminated unexpectedly';
    mockInsert.mockImplementationOnce(() => Promise.reject(new Error(leaky)));
    await post(GOOD_BODY, { origin: SPOKE_ORIGIN });
    await flush();
    expect(mockLoggerWarn.mock.calls[0][0]).toBe('[form-steps] write failed: Error');
  });

  test('a dropped beacon logs nothing', async () => {
    await post({ f: 'quote', s: 'seeing' }, { origin: SPOKE_ORIGIN });
    await post(GOOD_BODY, { origin: 'https://evil-scraper.example.com' });
    await flush();
    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });

  test('errorKind keeps only a plain code or class name', () => {
    const { errorKind } = _private;
    expect(errorKind(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBe('ECONNRESET');
    expect(errorKind(Object.assign(new Error('x'), { code: 'bad code quote/email' }))).toBe('Error');
    const timeout = new Error('Knex: Timeout acquiring a connection');
    timeout.name = 'KnexTimeoutError';
    expect(errorKind(timeout)).toBe('KnexTimeoutError');
    expect(errorKind({ name: 'not an error class /x/' })).toBe('error');
    expect(errorKind(undefined)).toBe('error');
  });
});

describe('daily bucket cap', () => {
  test('each (day, site, form, step) bucket stops at the cap, in the SQL', async () => {
    await post(GOOD_BODY, { origin: HUB_ORIGIN });
    await flush();
    const w = written();
    expect(w.sql).toMatch(/WHERE form_step_daily\.count < \?/);
    expect(w.cap).toBe(_private.DAILY_BUCKET_CAP);
    expect(_private.DAILY_BUCKET_CAP).toBe(2000);
  });
});

describe('daily totals only: a bucket never records when', () => {
  test('the upsert writes no timestamp', async () => {
    await post({ f: 'pest_quiz', s: 'lead' }, { origin: HUB_ORIGIN });
    await flush();
    const { sql } = written();
    // `now()` appears once, to compute the ET day; nothing else stores a time.
    expect(sql.match(/now\(\)/g)).toHaveLength(1);
    expect(sql).not.toMatch(/created_at|updated_at/);
  });

  test('the table has no timestamp column', () => {
    const fs = require('fs');
    const path = require('path');
    const migration = fs.readFileSync(path.join(__dirname, '..', 'models', 'migrations', '20261120020000_form_step_daily.js'), 'utf8');
    const up = migration.slice(migration.indexOf('exports.up'), migration.indexOf('exports.down'));
    expect(up.match(/\bt\.[a-zA-Z]+\('([a-z_]+)'/g)).toEqual(["t.date('day'", "t.text('site'", "t.text('form'", "t.text('step'", "t.integer('count'"]);
    expect(up).toMatch(/t\.primary\(\['day', 'site', 'form', 'step'\]\);/);
    expect(up).not.toMatch(/timestamp|created_at|updated_at/);
  });
});

describe('terminal 404: nothing falls through the router', () => {
  test.each([
    ['GET', '/api/public/form-steps'],
    ['OPTIONS', '/api/public/form-steps'],
    ['PUT', '/api/public/form-steps'],
    ['POST', '/api/public/form-steps/extra'],
  ])('%s %s gets the generic 404', async (method, path) => {
    const res = await send(method, path, { origin: SPOKE_ORIGIN });
    expect(res.status).toBe(404);
    expect(JSON.parse(res.text)).toEqual(notFoundBody({ method, originalUrl: path }));
    expect(res.headers['cache-control']).toMatch(/no-store/);
    expect(mockFellThrough).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });
});

describe('server/index.js mount order', () => {
  // The router must sit ahead of the global cors() (which would answer an
  // allowed-origin OPTIONS preflight with 204), the global /api/ limiter and
  // the global JSON parser. The real app boots a server + DB, so pin the
  // ORDER statically from the entrypoint source, as the read-depth test does.
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const at = (needle) => { const i = src.indexOf(needle); expect(i).toBeGreaterThan(-1); return i; };

  test('the form-steps router precedes the global cors(), the /api/ limiter and the JSON parser', () => {
    const mount = at("app.use('/api/public/form-steps', require('./routes/public-form-steps'));");
    expect(mount).toBeLessThan(at('app.use(cors({'));
    expect(mount).toBeLessThan(at("app.use('/api/', limiter);"));
    expect(mount).toBeLessThan(at("app.use(express.json({ limit: '1mb'"));
    expect(src.indexOf("app.use('/api/public/form-steps'", mount + 1)).toBe(-1);
  });
});
