/**
 * POST /api/public/blog-read-depth — anonymous, cookie-free blog
 * read-depth beacon (owner-approved 2026-09-27, "E2: cookie-free
 * read-depth counts"). Contract (mirrored in docs/public-route-contracts.md):
 *
 *  - Gated behind GATE_BLOG_READ_DEPTH: dark gives the SAME generic 404 as
 *    an unknown route, before the route's own rate limiter, at any volume.
 *  - Site is derived ONLY from the Origin header (never the body); a
 *    missing/null/unknown origin drops the beacon with 204 and no write.
 *  - `p` must be a known blog category path, `m` one of 25/50/75/100/next;
 *    anything else is 400 (or 413 when the body exceeds the 1 KB cap).
 *  - Nothing about the request (IP, UA, referrer, path, milestone) is ever
 *    logged — the write failure path logs only a fixed error kind.
 */
const mockIsEnabled = jest.fn(() => true);
jest.mock('../config/feature-gates', () => ({ isEnabled: (...args) => mockIsEnabled(...args) }));

const mockInsert = jest.fn();
const mockLoggerWarn = jest.fn();
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: (...args) => mockLoggerWarn(...args), error: jest.fn() }));
jest.mock('../models/db', () => {
  const db = jest.fn(() => ({
    insert: (row) => {
      const chain = {
        onConflict: () => chain,
        merge: (mergeArgs) => mockInsert(row, mergeArgs),
      };
      return chain;
    },
  }));
  db.raw = (sql) => ({ __raw: sql });
  return db;
});

const http = require('http');
const express = require('express');
const { notFoundBody } = require('../middleware/errors');

let server;
let base;

const mockFellThrough = jest.fn();

function appServer() {
  const app = express();
  app.use('/api/public/blog-read-depth', require('../routes/public-blog-read-depth'));
  // Stands in for everything mounted after the router in server/index.js
  // (the request logger among it): nothing may ever reach it.
  app.use((req, res) => { mockFellThrough(req.method, req.originalUrl); res.status(599).end(); });
  return app;
}

function startServer() {
  const app = appServer();
  server = app.listen(0);
  return new Promise((resolve) => server.once('listening', () => {
    base = `http://127.0.0.1:${server.address().port}`;
    resolve();
  }));
}

function stopServer() {
  return new Promise((resolve) => (server ? server.close(resolve) : resolve()));
}

// Node's global fetch refuses to set an Origin request header (it's on the
// Fetch spec's forbidden-header-name list); this route's whole contract is
// keyed on that header, so — same pattern as posthog-ingest-proxy.test.js —
// drive it with the raw http module instead, which has no such restriction.
function post(body, { origin, raw } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'text/plain;charset=UTF-8' };
    if (origin !== undefined) headers.Origin = origin;
    const payload = raw !== undefined ? raw : JSON.stringify(body);
    const req = http.request(`${base}/api/public/blog-read-depth`, { method: 'POST', headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: res.statusCode,
          headers: res.headers,
          json: async () => JSON.parse(text),
        });
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

const GOOD_BODY = { p: '/pest-control/florida-huntsman-spider/', m: '50' };
const SPOKE_ORIGIN = 'https://www.parrishpestcontrol.com';
const HUB_ORIGIN = 'https://wavespestcontrol.com';

beforeEach(async () => {
  mockIsEnabled.mockReturnValue(true);
  mockInsert.mockClear();
  mockLoggerWarn.mockClear();
  mockFellThrough.mockClear();
  // Every request in this file comes from 127.0.0.1, so the per-source daily
  // dedupe would otherwise carry over from one test to the next.
  require('../routes/public-blog-read-depth')._private.resetDedupe();
  await startServer();
});

// Any method/path, raw http (see post() for why not fetch).
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

afterEach(() => stopServer());

describe('gate off', () => {
  test('gives the generic unknown-route 404, no limiter headers, nothing stored', async () => {
    mockIsEnabled.mockReturnValue(false);
    const res = await post(GOOD_BODY, { origin: SPOKE_ORIGIN });
    expect(res.status).toBe(404);
    expect(res.headers['ratelimit-limit']).toBeUndefined();
    expect(res.headers['x-ratelimit-limit']).toBeUndefined();
    // Privacy headers land even on the dark 404 (same order as the other
    // dark-gated public routes — noStore runs ahead of the gate check).
    expect(res.headers['cache-control']).toMatch(/no-store/);
    expect(res.headers['x-robots-tag']).toMatch(/noindex/);
    const body = await res.json();
    expect(body).toEqual(notFoundBody({ method: 'POST', originalUrl: '/api/public/blog-read-depth' }));
    expect(mockInsert).not.toHaveBeenCalled();
  });

  test('never a 429 even under a burst well past the per-route cap', async () => {
    mockIsEnabled.mockReturnValue(false);
    for (let i = 0; i < 10; i += 1) {
      const res = await post(GOOD_BODY, { origin: SPOKE_ORIGIN });
      expect(res.status).toBe(404);
    }
    expect(mockInsert).not.toHaveBeenCalled();
  });
});

describe('valid beacon', () => {
  test('stores the right site, path and milestone and responds 204', async () => {
    const res = await post(GOOD_BODY, { origin: SPOKE_ORIGIN });
    expect(res.status).toBe(204);
    // The write is fire-and-forget after the response — give the microtask a tick.
    await new Promise((r) => setImmediate(r));
    expect(mockInsert).toHaveBeenCalledTimes(1);
    const [row, mergeArgs] = mockInsert.mock.calls[0];
    expect(row).toMatchObject({
      site: 'parrishpestcontrol.com',
      path: '/pest-control/florida-huntsman-spider/',
      milestone: '50',
      count: 1,
    });
    expect(row.day).toEqual(expect.objectContaining({ __raw: expect.stringContaining("America/New_York") }));
    expect(mergeArgs).toEqual(expect.objectContaining({ count: expect.objectContaining({ __raw: expect.stringContaining('count + 1') }) }));
    // updated_at tracks the latest increment, not just the day's first beacon.
    expect(mergeArgs.updated_at).toEqual({ __raw: 'now()' });
  });

  test('www. is stripped and a spoke origin maps to its bare-domain key', async () => {
    const res = await post(GOOD_BODY, { origin: SPOKE_ORIGIN });
    expect(res.status).toBe(204);
    await new Promise((r) => setImmediate(r));
    expect(mockInsert.mock.calls[0][0].site).toBe('parrishpestcontrol.com');
  });

  test('the hub origin (no www) resolves to its own key', async () => {
    const res = await post(GOOD_BODY, { origin: HUB_ORIGIN });
    expect(res.status).toBe(204);
    await new Promise((r) => setImmediate(r));
    expect(mockInsert.mock.calls[0][0].site).toBe('wavespestcontrol.com');
  });

  test('every valid milestone is accepted', async () => {
    for (const m of ['25', '50', '75', '100', 'next']) {
      mockInsert.mockClear();
      const res = await post({ ...GOOD_BODY, m }, { origin: SPOKE_ORIGIN });
      expect(res.status).toBe(204);
      await new Promise((r) => setImmediate(r));
      expect(mockInsert).toHaveBeenCalledTimes(1);
      expect(mockInsert.mock.calls[0][0].milestone).toBe(m);
    }
  });

  test('every valid blog category is accepted', async () => {
    for (const category of ['lawn-care', 'mosquito', 'pest-control', 'seasonal', 'termite', 'tree-shrub']) {
      mockInsert.mockClear();
      const p = `/${category}/some-post-slug/`;
      const res = await post({ p, m: '25' }, { origin: SPOKE_ORIGIN });
      expect(res.status).toBe(204);
      await new Promise((r) => setImmediate(r));
      expect(mockInsert).toHaveBeenCalledTimes(1);
      expect(mockInsert.mock.calls[0][0].path).toBe(p);
    }
  });
});

describe('origin handling', () => {
  test('missing origin gives 204 with no write', async () => {
    const res = await post(GOOD_BODY, {});
    expect(res.status).toBe(204);
    await new Promise((r) => setImmediate(r));
    expect(mockInsert).not.toHaveBeenCalled();
  });

  test('the literal "null" origin gives 204 with no write', async () => {
    const res = await post(GOOD_BODY, { origin: 'null' });
    expect(res.status).toBe(204);
    await new Promise((r) => setImmediate(r));
    expect(mockInsert).not.toHaveBeenCalled();
  });

  test('an unknown (non-fleet) origin gives 204 with no write', async () => {
    const res = await post(GOOD_BODY, { origin: 'https://evil-scraper.example.com' });
    expect(res.status).toBe(204);
    await new Promise((r) => setImmediate(r));
    expect(mockInsert).not.toHaveBeenCalled();
  });

  test('the credentialed portal origin (not a blog site) gives 204 with no write', async () => {
    const res = await post(GOOD_BODY, { origin: 'https://portal.wavespestcontrol.com' });
    expect(res.status).toBe(204);
    await new Promise((r) => setImmediate(r));
    expect(mockInsert).not.toHaveBeenCalled();
  });
});

describe('validation — 400 (or 413), no write', () => {
  test('non-JSON body', async () => {
    const res = await post(null, { origin: SPOKE_ORIGIN, raw: 'not json at all' });
    expect(res.status).toBe(400);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  test('a JSON array or scalar (not an object) is rejected', async () => {
    let res = await post(null, { origin: SPOKE_ORIGIN, raw: '[1,2,3]' });
    expect(res.status).toBe(400);
    res = await post(null, { origin: SPOKE_ORIGIN, raw: '"just a string"' });
    expect(res.status).toBe(400);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  test('invalid path shapes', async () => {
    for (const p of [
      '/pest-control/no-trailing-slash',
      'pest-control/missing-leading-slash/',
      '/not-a-real-category/some-post/',
      '/pest-control/Has-Upper-Case/',
      '/pest-control//',
      '/pest-control/' + 'a'.repeat(195) + '/',
    ]) {
      const res = await post({ p, m: '50' }, { origin: SPOKE_ORIGIN });
      expect(res.status).toBe(400);
    }
    expect(mockInsert).not.toHaveBeenCalled();
  });

  test('invalid milestone values', async () => {
    for (const m of ['0', '110', 'fifty', '', null, 25]) {
      const res = await post({ p: GOOD_BODY.p, m }, { origin: SPOKE_ORIGIN });
      expect(res.status).toBe(400);
    }
    expect(mockInsert).not.toHaveBeenCalled();
  });

  test('an oversized body (over the 1 KB cap) is refused (400 or 413), never stored', async () => {
    const res = await post(null, { origin: SPOKE_ORIGIN, raw: JSON.stringify({ p: GOOD_BODY.p, m: '50', junk: 'x'.repeat(5000) }) });
    expect([400, 413]).toContain(res.status);
    expect(mockInsert).not.toHaveBeenCalled();
  });
});

describe('rate limiting', () => {
  // The shared `base` server (used by every other test) keeps the DEFAULT
  // 120/min cap so ~30 ordinary functional requests never trip it. This test
  // needs its own isolated router instance — a fresh rate-limit store, with
  // a tiny cap — so it must not share the module cache (or the counter) with
  // the rest of the file: jest.isolateModules requires a brand-new instance
  // of the router (and its rateLimit() store) while the SAME mocks (feature
  // gates, db, logger — closures over the outer jest.fn()s) still apply.
  test('the per-route limiter returns 429 past its cap, after the gate check', async () => {
    let isolatedServer;
    let isolatedBase;
    const prevMax = process.env.BLOG_READ_DEPTH_RATE_MAX;
    process.env.BLOG_READ_DEPTH_RATE_MAX = '3';
    try {
      jest.isolateModules(() => {
        const app = express();
        app.use('/api/public/blog-read-depth', require('../routes/public-blog-read-depth'));
        isolatedServer = app.listen(0);
      });
      await new Promise((resolve) => isolatedServer.once('listening', resolve));
      isolatedBase = `http://127.0.0.1:${isolatedServer.address().port}`;

      const hit = () => new Promise((resolve, reject) => {
        const req = http.request(`${isolatedBase}/api/public/blog-read-depth`, {
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
      for (let i = 0; i < 5; i += 1) {
        statuses.push(await hit());
      }
      expect(statuses.slice(0, 3)).toEqual([204, 204, 204]);
      expect(statuses[3]).toBe(429);
      expect(statuses[4]).toBe(429);
    } finally {
      if (prevMax === undefined) delete process.env.BLOG_READ_DEPTH_RATE_MAX;
      else process.env.BLOG_READ_DEPTH_RATE_MAX = prevMax;
      await new Promise((resolve) => (isolatedServer ? isolatedServer.close(resolve) : resolve()));
    }
  });
});

describe('no request data is logged', () => {
  test('a write failure logs only a fixed error kind — never path/site/milestone', async () => {
    mockInsert.mockImplementationOnce(() => { throw Object.assign(new Error('boom'), { code: '23505' }); });
    const res = await post(GOOD_BODY, { origin: SPOKE_ORIGIN });
    expect(res.status).toBe(204);
    await new Promise((r) => setImmediate(r));
    expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
    const [line] = mockLoggerWarn.mock.calls[0];
    expect(line).not.toContain(GOOD_BODY.p);
    expect(line).not.toContain('parrishpestcontrol.com');
    expect(line).toContain('23505');
  });

  test('a code-less failure never logs its message (knex embeds the SQL and bound values)', async () => {
    const leaky = `insert into "blog_read_depth_daily" ("day", "site", "path", "milestone") values (..., 'parrishpestcontrol.com', '${GOOD_BODY.p}', '50') - Connection terminated unexpectedly`;
    mockInsert.mockImplementationOnce(() => { throw new Error(leaky); });
    const res = await post(GOOD_BODY, { origin: SPOKE_ORIGIN });
    expect(res.status).toBe(204);
    await new Promise((r) => setImmediate(r));
    expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
    const [line] = mockLoggerWarn.mock.calls[0];
    expect(line).toBe('[blog-read-depth] write failed: Error');
  });

  test('errorKind keeps only a plain code or class name', () => {
    const { errorKind } = require('../routes/public-blog-read-depth')._private;
    expect(errorKind(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBe('ECONNRESET');
    expect(errorKind(Object.assign(new Error('x'), { code: 'bad code /pest-control/a/' }))).toBe('Error');
    const timeout = new Error('Knex: Timeout acquiring a connection');
    timeout.name = 'KnexTimeoutError';
    expect(errorKind(timeout)).toBe('KnexTimeoutError');
    expect(errorKind({ name: 'not an error class /x/' })).toBe('error');
    expect(errorKind(undefined)).toBe('error');
  });
});

describe('one count per source per day', () => {
  test('a repeat beacon from the same source is answered 204 but counted once', async () => {
    expect((await post(GOOD_BODY, { origin: SPOKE_ORIGIN })).status).toBe(204);
    expect((await post(GOOD_BODY, { origin: SPOKE_ORIGIN })).status).toBe(204);
    // the same site claimed via the bare or www origin is still the same beacon
    expect((await post(GOOD_BODY, { origin: 'https://parrishpestcontrol.com' })).status).toBe(204);
    await new Promise((r) => setImmediate(r));
    expect(mockInsert).toHaveBeenCalledTimes(1);
  });

  test('another milestone, post or site from the same source still counts', async () => {
    await post(GOOD_BODY, { origin: SPOKE_ORIGIN });
    await post({ ...GOOD_BODY, m: '75' }, { origin: SPOKE_ORIGIN });
    await post({ ...GOOD_BODY, p: '/termite/drywood-termites/' }, { origin: SPOKE_ORIGIN });
    await post(GOOD_BODY, { origin: HUB_ORIGIN });
    await new Promise((r) => setImmediate(r));
    expect(mockInsert).toHaveBeenCalledTimes(4);
  });

  test('the dedupe resets at America/New_York midnight, not UTC', () => {
    const { firstBeaconToday } = require('../routes/public-blog-read-depth')._private;
    const lateEt = new Date('2026-09-27T03:59:00Z'); // 11:59 PM EDT, Sep 26
    const utcMidnight = new Date('2026-09-27T00:30:00Z'); // 8:30 PM EDT, same ET day
    const nextEt = new Date('2026-09-27T04:01:00Z'); // 12:01 AM EDT, Sep 27
    expect(firstBeaconToday('src', 'wavespestcontrol.com', '/termite/a/', '50', utcMidnight)).toBe(true);
    expect(firstBeaconToday('src', 'wavespestcontrol.com', '/termite/a/', '50', lateEt)).toBe(false);
    expect(firstBeaconToday('src', 'wavespestcontrol.com', '/termite/a/', '50', nextEt)).toBe(true);
  });

  test('past the daily cap further beacons are dropped, not counted', () => {
    const prev = process.env.BLOG_READ_DEPTH_DEDUPE_MAX;
    process.env.BLOG_READ_DEPTH_DEDUPE_MAX = '2';
    try {
      jest.isolateModules(() => {
        const { firstBeaconToday } = require('../routes/public-blog-read-depth')._private;
        const now = new Date('2026-09-27T16:00:00Z');
        expect(firstBeaconToday('a', 'wavespestcontrol.com', '/termite/a/', '25', now)).toBe(true);
        expect(firstBeaconToday('b', 'wavespestcontrol.com', '/termite/a/', '25', now)).toBe(true);
        expect(firstBeaconToday('c', 'wavespestcontrol.com', '/termite/a/', '25', now)).toBe(false);
      });
    } finally {
      if (prev === undefined) delete process.env.BLOG_READ_DEPTH_DEDUPE_MAX;
      else process.env.BLOG_READ_DEPTH_DEDUPE_MAX = prev;
    }
  });
});

describe('terminal 404: nothing falls through the router', () => {
  test.each([
    ['GET', '/api/public/blog-read-depth'],
    ['OPTIONS', '/api/public/blog-read-depth'],
    ['PUT', '/api/public/blog-read-depth'],
    ['POST', '/api/public/blog-read-depth/extra'],
  ])('%s %s gets the generic 404 with the gate on', async (method, path) => {
    const res = await send(method, path, { origin: SPOKE_ORIGIN });
    expect(res.status).toBe(404);
    expect(JSON.parse(res.text)).toEqual(notFoundBody({ method, originalUrl: path }));
    expect(res.headers['cache-control']).toMatch(/no-store/);
    expect(mockFellThrough).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  test('with the gate off an OPTIONS preflight is the same generic 404', async () => {
    mockIsEnabled.mockReturnValue(false);
    const res = await send('OPTIONS', '/api/public/blog-read-depth', { origin: SPOKE_ORIGIN });
    expect(res.status).toBe(404);
    expect(mockFellThrough).not.toHaveBeenCalled();
  });
});

describe('server/index.js mount order', () => {
  // The dark 404 must answer every request — an allowed-origin OPTIONS
  // preflight included — so the router has to sit ahead of the global
  // cors() (which would answer 204), the global /api/ limiter (a revealing
  // 429) and the global JSON parser. The real app boots a server + DB, so
  // pin the ORDER statically from the entrypoint source, as the ops-digest
  // route does (codex P0 r1 on #5022).
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const at = (needle) => { const i = src.indexOf(needle); expect(i).toBeGreaterThan(-1); return i; };

  test('the read-depth router precedes the global cors(), the /api/ limiter and the JSON parser', () => {
    const mount = at("app.use('/api/public/blog-read-depth', require('./routes/public-blog-read-depth'));");
    expect(mount).toBeLessThan(at('app.use(cors({'));
    expect(mount).toBeLessThan(at("app.use('/api/', limiter);"));
    expect(mount).toBeLessThan(at("app.use(express.json({ limit: '1mb'"));
    expect(src.indexOf("app.use('/api/public/blog-read-depth'", mount + 1)).toBe(-1);
  });
});
