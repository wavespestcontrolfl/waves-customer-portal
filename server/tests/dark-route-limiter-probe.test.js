/**
 * A dark (GATE_* off) public route answers the generic 404 BEFORE any rate
 * limiter (AGENTS.md, Public route surface): a probe must never see a 429
 * that a live route would give and a dark one must not. This test runs the
 * real app and measures it instead of reading the code.
 *
 *  1. express-rate-limit is replaced by a recorder. It evaluates the real
 *     `skip` (as in production) and, when the request is counted, logs a hit
 *     and calls next(). It never answers 429.
 *  2. The app boots twice, once with every GATE_* "false" (dark) and once with
 *     every GATE_* "true" (live). Same routes, read from the Express router
 *     stack, probed with an unauthenticated request.
 *  3. A route is a dark-gated route when its dark answer is a 404 that never
 *     touched the database and its live answer is not. It breaks the rule when
 *     a limiter counted that dark request.
 *
 * Every violation on main is listed in KNOWN with its reason. A new one fails,
 * and so does a listed one that got fixed (delete its line).
 * Fix: skip the limiter while the gate is off, or mount a PreGuard in
 * server/index.js before `app.use('/api/', limiter)`.
 *
 * Not covered: limiters a route hand-rolls (a Map and a 429 in the route
 * file), routes whose path is a regexp, and a route whose live answer is also
 * a 404 for the fake token (the differential cannot tell it from a bad token).
 */

const fs = require('fs');
const path = require('path');

global.__limiterHits = [];
global.__dbTouches = 0;

jest.mock('express-rate-limit', () => {
  const limiter = (opts = {}) => async (req, res, next) => {
    // Production counts the request unless skip() says otherwise; skips keyed
    // on NODE_ENV !== 'production' must not hide a hit here.
    const env = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    let skipped = false;
    try { skipped = opts.skip ? await opts.skip(req, res) : false; } catch { skipped = false; }
    process.env.NODE_ENV = env;
    if (!skipped) {
      const m = opts.message;
      global.__limiterHits.push((m && m.error) || (typeof m === 'string' ? m : 'limiter'));
    }
    next();
  };
  limiter.default = limiter;
  limiter.rateLimit = limiter;
  limiter.ipKeyGenerator = (ip) => ip;
  limiter.MemoryStore = class MemoryStore {};
  return limiter;
});

// Any database use is counted and fails, so a request that passes its gate
// ends in a 500, never in a read or write.
jest.mock('../models/db', () => {
  const chain = new Proxy(function chainFn() {}, {
    get: (_t, p) => (p === 'then' ? (_res, rej) => rej(new Error('db blocked')) : chain),
    apply: () => chain,
  });
  const root = new Proxy(function rootFn() {}, {
    get: (_t, p) => {
      if (p === 'then' || typeof p === 'symbol') return undefined;
      global.__dbTouches += 1;
      return chain;
    },
    apply: () => { global.__dbTouches += 1; return chain; },
  });
  return root;
});
jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
// index.js listens on a port as soon as it loads; the probe uses its own server.
jest.mock('http', () => {
  const actual = jest.requireActual('http');
  return { ...actual, createServer: (...a) => { const s = actual.createServer(...a); s.listen = () => s; return s; } };
});

const http = jest.requireActual('http');
const net = require('net');
const express = require('express');
const rateLimit = require('express-rate-limit');

const TOKENS = ['a1'.repeat(32), 'b2'.repeat(16), 'Zx_9'.repeat(11).slice(0, 43)];

// ---- reading the router stack ------------------------------------------------
function mountPath(layer) {
  if (layer.regexp.fast_slash) return '';
  let src = layer.regexp.source.replace(/^\^/, '').replace(/\\\/\?\(\?=\\\/\|\$\)$/, '');
  src = src.replace(/\(\?:\\\/\(\[\^\/\]\+\?\)\)/g, '/:p').replace(/\\(.)/g, '$1');
  return /[()[\]*?|+^$]/.test(src) ? null : src;
}

function listRoutes(app) {
  const out = []; let skipped = 0;
  const walk = (stack, prefix) => {
    for (const layer of stack) {
      if (layer.route) {
        const paths = [].concat(layer.route.path);
        const methods = Object.keys(layer.route.methods).flatMap((m) => (m === '_all' ? ['get', 'post'] : [m]));
        for (const p of paths) {
          if (typeof p !== 'string' || /[()[\]|+^$]/.test(p)) { skipped += 1; continue; }
          for (const method of methods) out.push({ method: method.toUpperCase(), tpl: prefix + p });
        }
      } else if (layer.name === 'router' && layer.handle.stack) {
        const m = mountPath(layer);
        if (m === null) skipped += 1; else walk(layer.handle.stack, prefix + m);
      }
    }
  };
  walk(app._router.stack, '');
  return { routes: out, skipped };
}

// The sweep runs every handler: nothing may leave the machine (a weather or maps call would spend quota).
// Node hands Socket.connect either an options object (tls) or a normalized [options, cb] array.
const realConnect = net.Socket.prototype.connect;
const LOOPBACK = /^(127\.0\.0\.1|localhost|::1|\[::1\])$/;
function guardedConnect(...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const o = first && typeof first === 'object' ? first : { port: first, host: args[1] };
  if (!o.path && !LOOPBACK.test(String(o.host || o.hostname || ''))) {
    process.nextTick(() => this.destroy(Object.assign(new Error(`probe blocked outbound ${o.host || o.hostname}`), { code: 'ECONNREFUSED' })));
    return this;
  }
  return realConnect.apply(this, args);
}
beforeAll(() => { net.Socket.prototype.connect = guardedConnect; });
afterAll(() => { net.Socket.prototype.connect = realConnect; });

// ---- probing -----------------------------------------------------------------
async function withServer(app, fn) {
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { await new Promise((r) => server.close(r)); }
}

async function send(base, { method, tpl }, token) {
  const url = `/${tpl.replace(/:\w+(\([^)]*\))?\??/g, token).replace(/\*/g, 'x')}`.replace(/^\/\//, '/');
  global.__limiterHits.length = 0; global.__dbTouches = 0;
  const init = { method, redirect: 'manual', headers: { 'content-type': 'application/json' } };
  if (method !== 'GET' && method !== 'HEAD') init.body = '{}';
  init.signal = AbortSignal.timeout(20000);
  let status;
  try { status = (await fetch(base + url, init)).status; } catch (err) { throw new Error(`${method} ${url}: no HTTP response (${err.message})`); }
  return { status, hits: [...global.__limiterHits], db: global.__dbTouches };
}

const isDark404 = (r) => r.status === 404 && r.db === 0;

// `load(value)` boots the app with every gate "false" or "true" and returns { app, undo }.
// The env and the module registry stay as load left them while that app is probed: many
// gates are read when the request runs, and a lazy require() must see the same registry.
async function probeApp(load, value, work) {
  const { app, undo } = load(value);
  try { return await withServer(app, (base) => work(app, base)); } finally { undo(); }
}

// Routes whose dark answer is a counted, DB-free 404 that the live app does not give. The live app is
// probed first so a route mounted only when a gate is on is also sent to the dark app. Every token
// shape is compared: a 404 both modes give for one shape proves nothing about another.
async function findViolations(load) {
  const live = new Map(); const liveRoutes = [];
  await probeApp(load, 'true', async (app, base) => {
    for (const route of listRoutes(app).routes) {
      liveRoutes.push(route);
      for (const token of TOKENS) live.set(`${route.method} ${route.tpl} ${token}`, await send(base, route, token));
    }
  });
  const found = new Map();
  const routeCount = await probeApp(load, 'false', async (app, base) => {
    const routes = new Map([...liveRoutes, ...listRoutes(app).routes].map((r) => [`${r.method} ${r.tpl}`, r]));
    for (const [key, route] of routes) {
      for (const token of TOKENS) {
        const r = await send(base, route, token);
        const l = live.get(`${key} ${token}`);
        if (!isDark404(r) || !r.hits.length || (l && isDark404(l))) continue;
        if (found.get(key) !== BOTH) found.set(key, r.hits.length > 1 ? BOTH : GLOBAL);
      }
    }
    return routes.size;
  });
  return { found, routeCount };
}

// ---- the real app ------------------------------------------------------------
function gateNames() {
  const doc = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'gate-index.md'), 'utf8');
  return [...doc.matchAll(/^- `(GATE_[A-Z0-9_]+)`/gm)].map((m) => m[1]);
}

// Production semantics: some gates are open outside production (`isProd ? ... : true`).
function loadApp(value) {
  const fixed = { NODE_ENV: 'production', JWT_SECRET: 'c0'.repeat(32), DATABASE_URL: 'postgres://probe:probe@127.0.0.1:1/probe' };
  const names = [...Object.keys(fixed), ...gateNames()];
  const saved = new Map(names.map((g) => [g, process.env[g]]));
  names.forEach((g) => { process.env[g] = fixed[g] || value; });
  const undo = () => saved.forEach((v, g) => { if (v === undefined) delete process.env[g]; else process.env[g] = v; });
  jest.resetModules();
  return { app: require('../index'), undo };
}

const GLOBAL = 'the global /api/ limiter counts the dark request before the gate answers; needs an index.js PreGuard or an earlier gate.';
const BOTH = 'the global /api/ limiter and the route\'s own limiter both count the dark request before the gate answers.';
const KNOWN = {
  'GET /api/integrations/commitments-worker/open': GLOBAL,
  'GET /api/integrations/watchdog-worker/status': GLOBAL,
  'GET /api/photo-id/': GLOBAL,
  'GET /api/photo-id/:type/:id': GLOBAL,
  'PATCH /api/admin/roof-entry-read/:id/tech-count': GLOBAL,
  'POST /api/admin/roof-entry-read/': GLOBAL,
  'POST /api/estimates/:token/change-request': GLOBAL,
  'POST /api/estimates/:token/extension-request': GLOBAL,
  'POST /api/estimates/:token/measurement-review': GLOBAL,
  'POST /api/estimates/:token/promo-code': GLOBAL,
  'POST /api/estimates/:token/referral-link': GLOBAL,
  'POST /api/pay/:token/plan-choice': GLOBAL,
  'POST /api/photo-id/:type': GLOBAL,
  'POST /api/public/experiments/exposure': GLOBAL,
  'PUT /api/estimates/:token/service-opt-out': GLOBAL,
  'GET /api/estimates/:token/service-details/:serviceKey/pdf': BOTH,
  'GET /api/estimates/:token/warranty-comparison/pdf': BOTH,
  'POST /api/estimates/:token/service-details/send': BOTH,
  'POST /api/pay/:token/promo-code': BOTH,
  'POST /api/public/secure-card/:token/select-plan': BOTH,
};

describe('dark routes answer 404 before any limiter (real app)', () => {
  test('every violation on main is listed, and every listed one still exists', async () => {
    const { found, routeCount } = await findViolations(loadApp);
    expect(routeCount).toBeGreaterThan(1000); // the stack walk did not go blind
    expect(Object.fromEntries([...found].sort())).toEqual(KNOWN);
  }, 300000);
});

// ---- self-tests: the harness catches the broken shape and passes the good one --
describe('probe harness (fixtures)', () => {
  const build = (order, on) => {
    const app = express();
    const limiter = rateLimit({ message: { error: 'Too many' } });
    const gate = (req, res, next) => (on ? next() : res.status(404).json({ error: 'Not found' }));
    const handler = (req, res) => res.json({ ok: true });
    if (order === 'gate-first') app.use('/api/demo', gate);
    app.use('/api/', limiter);
    if (order === 'limiter-first') app.use('/api/demo', gate);
    app.get('/api/demo/:token', handler);
    app.get('/api/open/:token', handler);
    return app;
  };
  const run = async (order, bothDark) => (await findViolations((v) => ({ app: build(order, v === 'true' && !bothDark), undo() {} }))).found;

  test('FAILS: a limiter counts the dark request before the gate', async () => {
    expect([...(await run('limiter-first')).keys()]).toEqual(['GET /api/demo/:token']);
  });
  test('FAILS: a route that needs the second token shape is still compared', async () => {
    const build32 = (v) => {
      const app = express();
      const on = v === 'true';
      app.use('/api/', rateLimit({}));
      app.get('/api/demo/:token', (req, res) => (!on || !/^[a-f0-9]{32}$/.test(req.params.token)
        ? res.status(404).json({ error: 'Not found' }) : res.json({ ok: true })));
      return { app, undo() {} };
    };
    expect([...(await findViolations(build32)).found.keys()]).toEqual(['GET /api/demo/:token']);
  });
  test('FAILS: a router mounted only while the gate is on is probed in the dark app too', async () => {
    const buildLate = (v) => {
      const app = express();
      app.use('/api/', rateLimit({}));
      if (v === 'true') app.get('/api/late/:token', (req, res) => res.json({ ok: true }));
      return { app, undo() {} };
    };
    expect([...(await findViolations(buildLate)).found.keys()]).toEqual(['GET /api/late/:token']);
  });
  test('the socket guard refuses a remote host before dialing and allows loopback', async () => {
    const remote = net.connect({ host: '203.0.113.1', port: 80 });
    await expect(new Promise((resolve) => remote.on('error', resolve))).resolves.toMatchObject({ code: 'ECONNREFUSED' });
    const server = http.createServer((q, r) => r.end('ok'));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try { expect((await fetch(`http://127.0.0.1:${server.address().port}/`)).status).toBe(200); } finally { server.close(); }
  });
  test('passes: the gate answers before the limiter', async () => {
    expect((await run('gate-first')).size).toBe(0);
  });
  test('passes: a route that answers the same 404 live is not a dark gate', async () => {
    expect((await run('limiter-first', true)).size).toBe(0);
  });
  test('the stack walk finds nested routers with a param mount', () => {
    const app = express(); const r = express.Router(); const inner = express.Router();
    inner.post('/:id/go', (q, s) => s.end());
    r.use('/b', inner); app.use('/a/:token', r);
    expect(listRoutes(app).routes).toEqual([{ method: 'POST', tpl: '/a/:p/b/:id/go' }]);
  });
});
