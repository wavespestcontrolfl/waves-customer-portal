/**
 * /ingest PostHog proxy — pins the contract that makes it safe to expose
 * unauthenticated on the portal origin:
 *  - dark (404) unless GATE_POSTHOG_INGEST_PROXY=true; 405 for non GET/POST/OPTIONS
 *  - upstream host is FIXED: /static/* → assets host, everything else → API host,
 *    query string preserved, ../ cannot escape the host
 *  - cookies / authorization / referer never reach PostHog; origin + content-type
 *    do; X-Forwarded-For carries the visitor IP; raw POST body forwarded byte-for-byte
 *  - upstream status/body/CORS headers pass through; set-cookie and
 *    content-encoding do not; CORP is cross-origin (hub loads array.js from here)
 *  - oversize body → 413, upstream failure → 502
 *
 * Runs the real router on an ephemeral Express listener with global.fetch stubbed.
 */
const http = require('http');
const express = require('express');

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const featureGates = require('../config/feature-gates');
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
  featureGates.gates.posthogIngestProxy = true;
});

afterEach(() => {
  featureGates.gates.posthogIngestProxy = false;
});

describe('gate + method surface', () => {
  test('404 and no upstream call while the gate is off', async () => {
    featureGates.gates.posthogIngestProxy = false;
    const res = await request({ path: '/ingest/e/' });
    expect(res.status).toBe(404);
    expect(fetchCalls).toHaveLength(0);
  });

  test('405 for methods posthog-js never uses', async () => {
    const res = await request({ method: 'DELETE', path: '/ingest/e/' });
    expect(res.status).toBe(405);
    expect(res.headers.allow).toBe('GET, POST, OPTIONS');
    expect(fetchCalls).toHaveLength(0);
  });
});

describe('upstream routing', () => {
  test('/static/* goes to the assets host, everything else to the API host, query kept', async () => {
    await request({ path: '/ingest/static/array.js' });
    await request({ path: '/ingest/e/?ip=1&_=123&ver=1.2' });
    await request({ path: '/ingest/array/phc_abc/config.js' });
    expect(fetchCalls.map((c) => c.url)).toEqual([
      `${router.ASSET_HOST}/static/array.js`,
      `${router.API_HOST}/e/?ip=1&_=123&ver=1.2`,
      `${router.API_HOST}/array/phc_abc/config.js`,
    ]);
  });

  test('path traversal cannot escape the fixed host', () => {
    const url = router.upstreamUrl({ originalUrl: '/ingest/static/../../evil', baseUrl: '/ingest' });
    expect(url.startsWith(router.ASSET_HOST + '/')).toBe(true);
    expect(url).not.toContain('..');
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

  test('upstream failure → 502', async () => {
    fetchImpl = async () => { throw new Error('ECONNRESET'); };
    const res = await request({ method: 'POST', path: '/ingest/e/', headers: { 'content-type': 'text/plain', 'content-length': '2' }, body: '{}' });
    expect(res.status).toBe(502);
  });
});
