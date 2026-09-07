/**
 * /ingest PostHog proxy — pins the contract that makes it safe to expose
 * unauthenticated on the portal origin:
 *  - dark (404) unless GATE_POSTHOG_INGEST_PROXY is on, read at REQUEST time (an
 *    env change after the router loaded flips it); 405 for non GET/POST/OPTIONS
 *  - upstream host is FIXED: /static/* and /array/* → assets host, everything else → API host,
 *    query string preserved, ../ cannot escape the host
 *  - cookies / authorization / referer never reach PostHog; origin + content-type
 *    do; X-Forwarded-For carries the visitor IP; raw POST body forwarded byte-for-byte;
 *    a gzip-encoded body arrives inflated WITHOUT a content-encoding label
 *  - upstream status/body/CORS headers pass through; set-cookie and
 *    content-encoding do not; CORP is cross-origin (hub loads array.js from here)
 *  - oversize body → 413, upstream failure → 502; the failure log never
 *    carries the caller-controlled path
 *  - per-IP limiter sits AFTER the gate: gate-off probes never spend budget,
 *    the (n+1)th enabled request in a minute is 429 and never reaches upstream,
 *    and IPv6 addresses in one /64 share a bucket (shared unauthenticated key)
 *
 * Runs the real router on an ephemeral Express listener with global.fetch stubbed.
 */
const http = require('http');
const express = require('express');

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const zlib = require('zlib');
const logger = require('../services/logger');
const router = require('../routes/posthog-ingest');

let server;
let baseUrl;
let fetchCalls;
let fetchImpl;

function request({ method = 'GET', path = '/', headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const req = http.request(baseUrl + path, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function upstreamResponse({ status = 200, body = 'ok', headers = {} } = {}) {
  return new Response(body, { status, headers });
}

beforeAll((done) => {
  const app = express();
  app.set('trust proxy', true);
  app.use('/ingest', router);
  // A json parser AFTER the mount must never see /ingest bodies.
  app.use(express.json());
  server = app.listen(0, '127.0.0.1', () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});

afterAll((done) => { server.close(done); });

beforeEach(() => {
  fetchCalls = [];
  fetchImpl = async () => upstreamResponse();
  global.fetch = jest.fn(async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    return fetchImpl(url, init);
  });
  process.env.GATE_POSTHOG_INGEST_PROXY = 'true';
});

afterEach(() => {
  delete process.env.GATE_POSTHOG_INGEST_PROXY;
});

describe('gate + method surface', () => {
  test('404 and no upstream call while the gate is off', async () => {
    delete process.env.GATE_POSTHOG_INGEST_PROXY;
    const res = await request({ path: '/ingest/e/' });
    expect(res.status).toBe(404);
    expect(fetchCalls).toHaveLength(0);
  });

  test('the gate is read per request: an env change after load flips the route without a reload', async () => {
    expect((await request({ path: '/ingest/flags/' })).status).toBe(200);
    delete process.env.GATE_POSTHOG_INGEST_PROXY;
    expect((await request({ path: '/ingest/flags/' })).status).toBe(404);
    process.env.GATE_POSTHOG_INGEST_PROXY = '1';
    expect((await request({ path: '/ingest/flags/' })).status).toBe(200);
    process.env.GATE_POSTHOG_INGEST_PROXY = 'false';
    expect((await request({ path: '/ingest/flags/' })).status).toBe(404);
    expect(fetchCalls).toHaveLength(2);
  });

  test('405 for methods posthog-js never uses', async () => {
    const res = await request({ method: 'DELETE', path: '/ingest/e/' });
    expect(res.status).toBe(405);
    expect(res.headers.allow).toBe('GET, POST, OPTIONS');
    expect(fetchCalls).toHaveLength(0);
  });
});

describe('upstream routing', () => {
  test('/static/* and /array/* go to the assets host, everything else to the API host, query kept', async () => {
    await request({ path: '/ingest/static/array.js' });
    await request({ path: '/ingest/e/?ip=1&_=123&ver=1.2' });
    await request({ path: '/ingest/array/phc_abc/config.js' });
    await request({ path: '/ingest/array/phc_abc/config?v=1' });
    await request({ path: '/ingest/flags/?v=2' });
    expect(fetchCalls.map((c) => c.url)).toEqual([
      `${router.ASSET_HOST}/static/array.js`,
      `${router.API_HOST}/e/?ip=1&_=123&ver=1.2`,
      `${router.ASSET_HOST}/array/phc_abc/config.js`,
      `${router.ASSET_HOST}/array/phc_abc/config?v=1`,
      `${router.API_HOST}/flags/?v=2`,
    ]);
  });

  test('path traversal cannot escape the fixed host', () => {
    const url = router.upstreamUrl({ originalUrl: '/ingest/static/../../evil', baseUrl: '/ingest' });
    expect(url.startsWith(router.ASSET_HOST + '/')).toBe(true);
    expect(url).not.toContain('..');
  });

  test('protocol-relative and backslash tails stay pinned to the PostHog origin (SSRF)', () => {
    const cases = ['/ingest//evil.com/e/?x=1', '/ingest///evil.com/e/', '/ingest/\\\\evil.com/e/', '/ingest/\\\\/evil.com/static/array.js'];
    for (const originalUrl of cases) {
      const url = router.upstreamUrl({ originalUrl, baseUrl: '/ingest' });
      const u = new URL(url);
      expect([router.API_HOST, router.ASSET_HOST]).toContain(u.origin);
      expect(u.hostname.endsWith('.posthog.com')).toBe(true);
    }
    expect(router.upstreamUrl({ originalUrl: '/ingest//evil.com/e/?x=1', baseUrl: '/ingest' })).toBe(`${router.API_HOST}/evil.com/e/?x=1`);
  });

  test('a protocol-relative request over HTTP never reaches a foreign host', async () => {
    await request({ path: '/ingest//evil.com/e/' });
    expect(fetchCalls).toHaveLength(1);
    expect(new URL(fetchCalls[0].url).origin).toBe(router.API_HOST);
  });
});

describe('request boundary', () => {
  test('forwards body, content-type and origin; strips cookie/authorization/referer; sets X-Forwarded-For', async () => {
    const payload = Buffer.from('{"api_key":"phc_abc","batch":[]}');
    await request({
      method: 'POST',
      path: '/ingest/e/?compression=gzip-js',
      headers: {
        'content-type': 'text/plain',
        'content-length': String(payload.length),
        origin: 'https://www.wavespestcontrol.com',
        cookie: 'session=secret',
        authorization: 'Bearer nope',
        referer: 'https://portal.wavespestcontrol.com/estimate/tok_abc',
        'x-forwarded-for': '203.0.113.9',
      },
      body: payload,
    });
    expect(fetchCalls).toHaveLength(1);
    const { init } = fetchCalls[0];
    expect(init.method).toBe('POST');
    expect(Buffer.from(init.body).equals(payload)).toBe(true);
    expect(init.headers['content-type']).toBe('text/plain');
    expect(init.headers.origin).toBe('https://www.wavespestcontrol.com');
    expect(init.headers.cookie).toBeUndefined();
    expect(init.headers.authorization).toBeUndefined();
    expect(init.headers.referer).toBeUndefined();
    expect(init.headers.host).toBeUndefined();
    // trust proxy on → req.ip is the client behind the edge, not the edge.
    expect(init.headers['x-forwarded-for']).toBe('203.0.113.9');
    expect(init.redirect).toBe('manual');
  });

  test('a gzip-encoded body is forwarded inflated, with no content-encoding label', async () => {
    const plain = Buffer.from('{"api_key":"phc_abc","batch":[{"event":"$pageview"}]}');
    const gz = zlib.gzipSync(plain);
    await request({
      method: 'POST',
      path: '/ingest/batch/',
      headers: { 'content-type': 'text/plain', 'content-encoding': 'gzip', 'content-length': String(gz.length) },
      body: gz,
    });
    const { init } = fetchCalls[0];
    expect(Buffer.from(init.body).equals(plain)).toBe(true);
    expect(init.headers['content-encoding']).toBeUndefined();
    expect(init.headers['content-type']).toBe('text/plain');
  });

  test('GET carries no body', async () => {
    await request({ path: '/ingest/flags/?v=2' });
    expect(fetchCalls[0].init.body).toBeUndefined();
  });

  test('oversize body → 413 without an upstream call', async () => {
    const big = Buffer.alloc(2 * 1024 * 1024 + 1, 0x41);
    const res = await request({
      method: 'POST',
      path: '/ingest/s/',
      headers: { 'content-type': 'text/plain', 'content-length': String(big.length) },
      body: big,
    });
    expect(res.status).toBe(413);
    expect(fetchCalls).toHaveLength(0);
  });
});

describe('response boundary', () => {
  test('status, body and CORS headers pass through; set-cookie/content-encoding do not; CORP is cross-origin', async () => {
    fetchImpl = async () => upstreamResponse({
      status: 200,
      body: '1',
      headers: {
        'content-type': 'application/json',
        'access-control-allow-origin': 'https://www.wavespestcontrol.com',
        'access-control-allow-credentials': 'true',
        'set-cookie': 'ph=1',
        'content-encoding': 'gzip',
        'cache-control': 'public, max-age=3600',
      },
    });
    const res = await request({ path: '/ingest/decide/?v=3', headers: { origin: 'https://www.wavespestcontrol.com' } });
    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe('1');
    expect(res.headers['content-type']).toBe('application/json');
    expect(res.headers['access-control-allow-origin']).toBe('https://www.wavespestcontrol.com');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(res.headers['cache-control']).toBe('public, max-age=3600');
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
  });

  test('preflight OPTIONS is forwarded and its answer returned', async () => {
    fetchImpl = async () => upstreamResponse({ status: 204, body: null, headers: { 'access-control-allow-methods': 'POST' } });
    const res = await request({ method: 'OPTIONS', path: '/ingest/e/', headers: { origin: 'https://pestcontrolparrish.com' } });
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-methods']).toBe('POST');
    expect(fetchCalls[0].init.method).toBe('OPTIONS');
  });

  test('upstream failure → 502, and the log never carries the caller-controlled path', async () => {
    fetchImpl = async () => { throw new Error('ECONNRESET'); };
    logger.warn.mockClear();
    const res = await request({ method: 'POST', path: '/ingest/e/jane.doe%40example.com/941-555-0100', headers: { 'content-type': 'text/plain', 'content-length': '2' }, body: '{}' });
    expect(res.status).toBe(502);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const line = String(logger.warn.mock.calls[0][0]);
    expect(line).toContain('[posthog-ingest] upstream failed POST ingest');
    expect(line).not.toContain('jane');
    expect(line).not.toContain('941');
    expect(line).not.toContain('/e/');
  });
});

describe('per-IP limiter after the gate', () => {
  // Isolated router instances with a 2/min budget so the (n+1)th request is
  // observable without 300 round trips. The gate itself is read from the live
  // env per request, so each test sets it directly.
  function isolatedRouter() {
    let r;
    jest.isolateModules(() => {
      process.env.POSTHOG_INGEST_RATE_MAX = '2';
      r = require('../routes/posthog-ingest');
      delete process.env.POSTHOG_INGEST_RATE_MAX;
    });
    return r;
  }

  function listen(r) {
    return new Promise((resolve) => {
      const app = express();
      app.set('trust proxy', true);
      app.use('/ingest', r);
      const srv = app.listen(0, '127.0.0.1', () => resolve({ srv, base: `http://127.0.0.1:${srv.address().port}` }));
    });
  }

  const get = (base, path, ip) => new Promise((resolve, reject) => {
    const req = http.request(base + path, { method: 'GET', headers: { 'x-forwarded-for': ip } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });

  test('enabled: the (n+1)th request per IP in a minute is 429 and never reaches upstream; another IP is unaffected', async () => {
    const { srv, base } = await listen(isolatedRouter());
    try {
      const a = [];
      for (let i = 0; i < 3; i++) a.push(await get(base, '/ingest/flags/?v=2', '198.51.100.7'));
      expect(a).toEqual([200, 200, 429]);
      expect(fetchCalls).toHaveLength(2);
      expect(await get(base, '/ingest/flags/?v=2', '198.51.100.8')).toBe(200);
      expect(fetchCalls).toHaveLength(3);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  test('IPv6 addresses inside one /64 share a bucket (shared unauthenticated key)', async () => {
    const { srv, base } = await listen(isolatedRouter());
    try {
      expect(await get(base, '/ingest/flags/', '2001:db8:1:2::10')).toBe(200);
      expect(await get(base, '/ingest/flags/', '2001:DB8:1:2:0:0:0:99')).toBe(200);
      // Third address in the same /64 → same bucket → over budget.
      expect(await get(base, '/ingest/flags/', '2001:db8:1:2:abcd::1')).toBe(429);
      // A different /64 is a different bucket.
      expect(await get(base, '/ingest/flags/', '2001:db8:1:3::10')).toBe(200);
      expect(fetchCalls).toHaveLength(3);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  test('gate off: probes stay 404 past the budget — the limiter sits after the gate', async () => {
    const { srv, base } = await listen(isolatedRouter());
    delete process.env.GATE_POSTHOG_INGEST_PROXY;
    try {
      const probes = [];
      for (let i = 0; i < 4; i++) probes.push(await get(base, '/ingest/e/', '198.51.100.9'));
      expect(probes).toEqual([404, 404, 404, 404]);
      expect(fetchCalls).toHaveLength(0);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });
});
