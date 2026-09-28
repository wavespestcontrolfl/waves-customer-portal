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
const mockLoggerInfo = jest.fn();
jest.mock('../services/logger', () => ({ info: (...args) => mockLoggerInfo(...args), warn: (...args) => mockLoggerWarn(...args), error: jest.fn() }));
jest.mock('../models/db', () => {
  const db = jest.fn();
  // The route writes through ONE parameterized upsert: capture its SQL and
  // bindings as mockInsert(sql, bindings).
  db.raw = (sql, bindings) => mockInsert(sql, bindings);
  return db;
});
const mockFetchSitemapPaths = jest.fn();
jest.mock('../services/content/content-registry-live-status', () => ({
  fetchSitemapPaths: (...args) => mockFetchSitemapPaths(...args),
}));

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

// The count lands after a sitemap lookup, a few ticks after the 204.
const flush = async () => { for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r)); };
const written = (i = 0) => {
  const [sql, b] = mockInsert.mock.calls[i];
  return { sql, site: b[0], path: b[1], milestone: b[2], cap: b[3] };
};

beforeEach(async () => {
  mockIsEnabled.mockReturnValue(true);
  mockInsert.mockClear();
  mockLoggerWarn.mockClear();
  mockLoggerInfo.mockClear();
  mockFellThrough.mockClear();
  // Unless a test says otherwise, every path is on its site's sitemap.
  mockFetchSitemapPaths.mockReset();
  mockFetchSitemapPaths.mockResolvedValue({ has: () => true });
  require('../routes/public-blog-read-depth')._private.resetLivePaths();
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
    // The write is fire-and-forget after the response.
    await flush();
    expect(mockInsert).toHaveBeenCalledTimes(1);
    const w = written();
    expect(w).toMatchObject({ site: 'parrishpestcontrol.com', path: '/pest-control/florida-huntsman-spider/', milestone: '50' });
    expect(w.sql).toMatch(/\(now\(\) AT TIME ZONE 'America\/New_York'\)::date/);
    expect(w.sql).toMatch(/ON CONFLICT \(day, site, path, milestone\)/);
    // updated_at tracks the latest increment, not just the day's first beacon.
    expect(w.sql).toMatch(/count = blog_read_depth_daily\.count \+ 1, updated_at = now\(\)/);
  });

  test('www. is stripped and a spoke origin maps to its bare-domain key', async () => {
    const res = await post(GOOD_BODY, { origin: SPOKE_ORIGIN });
    expect(res.status).toBe(204);
    await flush();
    expect(written().site).toBe('parrishpestcontrol.com');
  });

  test('the hub origin (no www) resolves to its own key', async () => {
    const res = await post(GOOD_BODY, { origin: HUB_ORIGIN });
    expect(res.status).toBe(204);
    await flush();
    expect(written().site).toBe('wavespestcontrol.com');
  });

  test('every valid milestone is accepted', async () => {
    for (const m of ['25', '50', '75', '100', 'next']) {
      mockInsert.mockClear();
      const res = await post({ ...GOOD_BODY, m }, { origin: SPOKE_ORIGIN });
      expect(res.status).toBe(204);
      await flush();
      expect(mockInsert).toHaveBeenCalledTimes(1);
      expect(written().milestone).toBe(m);
    }
  });

  test('every valid blog category is accepted', async () => {
    for (const category of ['lawn-care', 'mosquito', 'pest-control', 'seasonal', 'termite', 'tree-shrub']) {
      mockInsert.mockClear();
      const p = `/${category}/some-post-slug/`;
      const res = await post({ p, m: '25' }, { origin: SPOKE_ORIGIN });
      expect(res.status).toBe(204);
      await flush();
      expect(mockInsert).toHaveBeenCalledTimes(1);
      expect(written().path).toBe(p);
    }
  });
});

describe('origin handling', () => {
  test('missing origin gives 204 with no write', async () => {
    const res = await post(GOOD_BODY, {});
    expect(res.status).toBe(204);
    await flush();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  test('the literal "null" origin gives 204 with no write', async () => {
    const res = await post(GOOD_BODY, { origin: 'null' });
    expect(res.status).toBe(204);
    await flush();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  test('an unknown (non-fleet) origin gives 204 with no write', async () => {
    const res = await post(GOOD_BODY, { origin: 'https://evil-scraper.example.com' });
    expect(res.status).toBe(204);
    await flush();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  test('the credentialed portal origin (not a blog site) gives 204 with no write', async () => {
    const res = await post(GOOD_BODY, { origin: 'https://portal.wavespestcontrol.com' });
    expect(res.status).toBe(204);
    await flush();
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
    await flush();
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
    await flush();
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

describe('only posts the site actually publishes count', () => {
  const POST_PATH = GOOD_BODY.p;

  test('a path on the claimed site\'s sitemap counts, and the sitemap is read once and reused', async () => {
    mockFetchSitemapPaths.mockResolvedValue(new Set([POST_PATH]));
    await post({ p: POST_PATH, m: '25' }, { origin: HUB_ORIGIN });
    await post({ p: POST_PATH, m: '50' }, { origin: HUB_ORIGIN });
    await flush();
    expect(mockFetchSitemapPaths).toHaveBeenCalledTimes(1);
    expect(mockFetchSitemapPaths).toHaveBeenCalledWith({ sitemapUrl: 'https://wavespestcontrol.com/sitemap-index.xml' });
    expect(mockInsert).toHaveBeenCalledTimes(2);
  });

  test('an invented slug is answered 204 but never stored', async () => {
    mockFetchSitemapPaths.mockResolvedValue(new Set([POST_PATH]));
    const res = await post({ p: '/pest-control/not-a-real-post/', m: '50' }, { origin: HUB_ORIGIN });
    expect(res.status).toBe(204);
    await flush();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  test('a spoke beacon is checked against that spoke\'s own sitemap', async () => {
    mockFetchSitemapPaths.mockImplementation(async ({ sitemapUrl }) => (
      sitemapUrl === 'https://parrishpestcontrol.com/sitemap-index.xml'
        ? new Set([`https://parrishpestcontrol.com${POST_PATH}`]) // spoke entries are absolute
        : new Set()));
    await post(GOOD_BODY, { origin: SPOKE_ORIGIN });
    await flush();
    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(written().site).toBe('parrishpestcontrol.com');
    mockInsert.mockClear();
    await post({ p: '/termite/drywood-termites/', m: '50' }, { origin: SPOKE_ORIGIN }); // not on that spoke
    await flush();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  test('no sitemap yet: dropped, and not refetched until the retry window passes', async () => {
    const { isLivePath } = require('../routes/public-blog-read-depth')._private;
    mockFetchSitemapPaths.mockResolvedValue(null); // both the index and /sitemap.xml missing
    const t0 = 1000000;
    expect(await isLivePath('wavespestcontrol.com', POST_PATH, t0)).toBe(false);
    expect(mockFetchSitemapPaths).toHaveBeenCalledTimes(2);
    expect(await isLivePath('wavespestcontrol.com', POST_PATH, t0 + 60 * 1000)).toBe(false);
    expect(mockFetchSitemapPaths).toHaveBeenCalledTimes(2);
    mockFetchSitemapPaths.mockResolvedValue(new Set([POST_PATH]));
    expect(await isLivePath('wavespestcontrol.com', POST_PATH, t0 + 5 * 60 * 1000)).toBe(true);
    expect(mockFetchSitemapPaths).toHaveBeenCalledTimes(3);
  });

  test('falls back to /sitemap.xml when the site has no sitemap-index.xml', async () => {
    const { isLivePath } = require('../routes/public-blog-read-depth')._private;
    mockFetchSitemapPaths.mockImplementation(async ({ sitemapUrl }) => (
      sitemapUrl.endsWith('/sitemap.xml') ? new Set([POST_PATH]) : null));
    expect(await isLivePath('wavespestcontrol.com', POST_PATH, 4000000)).toBe(true);
    expect(mockFetchSitemapPaths.mock.calls.map(([arg]) => arg.sitemapUrl)).toEqual([
      'https://wavespestcontrol.com/sitemap-index.xml',
      'https://wavespestcontrol.com/sitemap.xml',
    ]);
  });

  test('a failed refresh keeps the last good list', async () => {
    const { isLivePath } = require('../routes/public-blog-read-depth')._private;
    mockFetchSitemapPaths.mockResolvedValueOnce(new Set([POST_PATH]));
    const t0 = 2000000;
    expect(await isLivePath('wavespestcontrol.com', POST_PATH, t0)).toBe(true);
    mockFetchSitemapPaths.mockRejectedValue(new Error('network')); // index and fallback both fail
    expect(await isLivePath('wavespestcontrol.com', POST_PATH, t0 + 6 * 60 * 60 * 1000)).toBe(true);
    expect(mockFetchSitemapPaths).toHaveBeenCalledTimes(3);
  });

  test('concurrent beacons for one site share a single sitemap fetch', async () => {
    let release;
    mockFetchSitemapPaths.mockImplementation(() => new Promise((r) => { release = () => r(new Set([POST_PATH])); }));
    const { isLivePath } = require('../routes/public-blog-read-depth')._private;
    const a = isLivePath('wavespestcontrol.com', POST_PATH, 3000000);
    const b = isLivePath('wavespestcontrol.com', POST_PATH, 3000001);
    release();
    expect(await Promise.all([a, b])).toEqual([true, true]);
    expect(mockFetchSitemapPaths).toHaveBeenCalledTimes(1);
  });

  test('each (day, site, path, milestone) bucket stops at the daily cap', async () => {
    const { DAILY_BUCKET_CAP } = require('../routes/public-blog-read-depth')._private;
    await post(GOOD_BODY, { origin: HUB_ORIGIN });
    await flush();
    const w = written();
    expect(w.sql).toMatch(/WHERE blog_read_depth_daily\.count < \?/);
    expect(w.cap).toBe(DAILY_BUCKET_CAP);
    expect(DAILY_BUCKET_CAP).toBe(2000);
  });
});

describe('sitemap outages are logged once, with the site key only', () => {
  const POST_PATH = GOOD_BODY.p;
  const { isLivePath } = require('../routes/public-blog-read-depth')._private;

  test('an unreadable sitemap warns once per outage, however often it is retried', async () => {
    mockFetchSitemapPaths.mockResolvedValue(null);
    const t0 = 5000000;
    expect(await isLivePath('wavespestcontrol.com', POST_PATH, t0)).toBe(false);
    expect(await isLivePath('wavespestcontrol.com', POST_PATH, t0 + 5 * 60 * 1000)).toBe(false);
    expect(await isLivePath('wavespestcontrol.com', POST_PATH, t0 + 10 * 60 * 1000)).toBe(false);
    expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
    const [line] = mockLoggerWarn.mock.calls[0];
    expect(line).toContain('wavespestcontrol.com');
    expect(line).toContain('its beacons are dropped');
    expect(line).not.toContain(POST_PATH);
  });

  test('recovery is logged once, and a later outage warns again against the last good list', async () => {
    const t0 = 6000000;
    mockFetchSitemapPaths.mockResolvedValue(null);
    await isLivePath('wavespestcontrol.com', POST_PATH, t0);
    mockFetchSitemapPaths.mockResolvedValue(new Set([POST_PATH]));
    expect(await isLivePath('wavespestcontrol.com', POST_PATH, t0 + 5 * 60 * 1000)).toBe(true);
    expect(mockLoggerInfo).toHaveBeenCalledTimes(1);
    expect(mockLoggerInfo.mock.calls[0][0]).toContain('wavespestcontrol.com');
    mockFetchSitemapPaths.mockResolvedValue(null);
    expect(await isLivePath('wavespestcontrol.com', POST_PATH, t0 + 7 * 60 * 60 * 1000)).toBe(true);
    expect(mockLoggerWarn).toHaveBeenCalledTimes(2);
    expect(mockLoggerWarn.mock.calls[1][0]).toContain('counting against the last good list');
  });

  test('a sitemap that always loads logs nothing', async () => {
    mockFetchSitemapPaths.mockResolvedValue(new Set([POST_PATH]));
    await isLivePath('wavespestcontrol.com', POST_PATH, 8000000);
    await isLivePath('wavespestcontrol.com', POST_PATH, 8000000 + 7 * 60 * 60 * 1000);
    expect(mockLoggerWarn).not.toHaveBeenCalled();
    expect(mockLoggerInfo).not.toHaveBeenCalled();
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
