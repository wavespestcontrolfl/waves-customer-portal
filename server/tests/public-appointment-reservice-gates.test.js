// Exercise the actual index.js registrations in source order without
// starting the application's DB, integrations, sockets, or scheduled jobs.
jest.mock('../config', () => ({ jwt: { secret: 'public-gate-test-secret' } }));
jest.mock('../models/db', () => jest.fn(() => { throw new Error('Unexpected DB access'); }));
jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../services/weather-forecast', () => ({ getDailyRainOutlookBounded: jest.fn() }));
jest.mock('../services/tech-photo', () => ({ resolveTechPhotoUrl: jest.fn() }));

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const { parse } = require('@babel/parser');
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const db = require('../models/db');
const { gates } = require('../config/feature-gates');

const PREFIXES = ['/api/public/appointment', '/api/public/reservice'];
const TOKEN = 'a'.repeat(64);
const SURFACES = [
  ['appointment summary', 0, 'GET', '', 60],
  ['appointment calendar', 0, 'GET', '/calendar.ics', 60],
  ['appointment confirm', 0, 'POST', '/confirm', 10],
  ['re-service summary', 1, 'GET', '', 60],
  ['re-service search', 1, 'POST', '/find-slots', 15],
  ['re-service commit', 1, 'POST', '', 10],
];
const ENV_KEYS = ['NODE_ENV', 'GATE_APPOINTMENT_PAGE', 'GATE_RESERVICE_SELF_SERVE', 'STAFF_MAINTENANCE_MODE'];
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const originalReserviceGate = gates.reserviceSelfServe;
const servers = [];
let composedOrigin;
let routerOrigin;
let requestIp;
let ipSequence = 0;

function setGate(family, value) {
  const key = ENV_KEYS[family + 1];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  if (family === 1) {
    // Re-service uses a startup-snapshot gate. Resolve a fresh registry as
    // a restarted process would, then update the registry used by the app.
    jest.isolateModules(() => {
      gates.reserviceSelfServe = require('../config/feature-gates').isEnabled('reserviceSelfServe');
    });
  }
}

function mountFromIndex(app) {
  const source = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
  const declarations = new Set(['allowedOrigins', 'staffMaintenance', 'rateLimitKey', 'limiter']);
  const statements = parse(source).program.body.filter((node) => {
    if (node.type === 'VariableDeclaration') {
      return node.declarations.some(({ id }) => id.type === 'Identifier'
        ? declarations.has(id.name)
        : id.properties?.some(({ key }) => declarations.has(key.name)));
    }
    const call = node.type === 'ExpressionStatement' && node.expression;
    if (call?.type !== 'CallExpression' || call.callee.object?.name !== 'app'
      || call.callee.property?.name !== 'use') return false;
    const first = call.arguments[0];
    if (first.type === 'StringLiteral') return [...PREFIXES, '/api/'].includes(first.value);
    if (first.type === 'Identifier') return first.name === 'staffMaintenance';
    return first.type === 'CallExpression' && (first.callee.name === 'cors'
      || (first.callee.object?.name === 'express'
        && ['json', 'urlencoded'].includes(first.callee.property?.name)));
  });
  vm.runInNewContext(statements.map((node) => source.slice(node.start, node.end)).join('\n'), {
    app, express, cors, rateLimit, process,
    // Use the real limiter with a short test budget. Its production-only
    // skip predicate and key generator are evaluated unchanged from index.
    config: { rateLimit: { windowMs: 60000, max: 2 } },
    require: (id) => require(path.resolve(__dirname, '..', id)),
  }, { filename: 'index-public-gate-composition.js' });
}

async function listen(app) {
  app.set('trust proxy', 1);
  app.get('/api/test-budget', (_req, res) => res.json({ ok: true }));
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.type || err.message }));
  const server = http.createServer(app);
  servers.push(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function request(origin, url, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(`${origin}${url}`, {
    method,
    headers: { 'X-Forwarded-For': requestIp, 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body }),
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
}

function expectPrivate404(response) {
  expect(response.status).toBe(404);
  expect(response.body).toEqual({ error: 'Not found' });
  expect(response.headers.get('cache-control')).toContain('no-store');
  expect(response.headers.get('x-robots-tag')).toContain('noindex');
  expect(response.headers.get('referrer-policy')).toBe('no-referrer');
}

beforeAll(async () => {
  const app = express();
  mountFromIndex(app);
  composedOrigin = await listen(app);
  const routers = express();
  routers.use(express.json());
  routers.use(PREFIXES[0], require('../routes/appointment-public'));
  routers.use(PREFIXES[1], require('../routes/reservice-public'));
  routerOrigin = await listen(routers);
});

beforeEach(() => {
  process.env.NODE_ENV = 'production';
  setGate(0, 'true');
  setGate(1, 'true');
  delete process.env.STAFF_MAINTENANCE_MODE;
  requestIp = `192.0.2.${++ipSequence}`;
  db.mockClear();
});

afterEach(() => {
  gates.reserviceSelfServe = originalReserviceGate;
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

afterAll(async () => {
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
});

test.each(SURFACES)('%s stays private and dark after the global budget is exhausted', async (_name, family, method, suffix) => {
  for (let i = 0; i < 2; i += 1) {
    expect((await request(composedOrigin, '/api/test-budget')).status).toBe(200);
  }
  expect((await request(composedOrigin, '/api/test-budget')).status).toBe(429);
  setGate(family, 'false');
  const url = `${PREFIXES[family]}/${TOKEN}${suffix}`;
  expectPrivate404(await request(composedOrigin, url, { method }));
  setGate(family, 'true');
  const enabled = await request(composedOrigin, url, { method });
  expect(enabled.status).toBe(429);
  expect(enabled.headers.get('cache-control')).toContain('no-store');
  expect(enabled.headers.get('x-robots-tag')).toContain('noindex');
  expect(enabled.headers.get('referrer-policy')).toBe('no-referrer');
  expect(db).not.toHaveBeenCalled();
});

test.each(SURFACES.filter(([, , method]) => method === 'POST'))(
  '%s rejects dark requests before malformed or oversized JSON is parsed',
  async (_name, family, method, suffix) => {
    const url = `${PREFIXES[family]}/${TOKEN}${suffix}`;
    for (const [body, status] of [['{', 400], [JSON.stringify({ data: 'x'.repeat(1024 * 1024) }), 413]]) {
      setGate(family, undefined);
      expectPrivate404(await request(composedOrigin, url, { method, body }));
      setGate(family, 'true');
      expect((await request(composedOrigin, url, { method, body })).status).toBe(status);
    }
    expect(db).not.toHaveBeenCalled();
  },
);

test.each(SURFACES)('%s retains its local budget while enabled and bypasses it while dark', async (_name, family, method, suffix, budget) => {
  const invalidUrl = `${PREFIXES[family]}/invalid${suffix}`;
  for (let i = 0; i < budget; i += 1) {
    expect((await request(routerOrigin, invalidUrl, { method })).status).toBe(404);
  }
  expect((await request(routerOrigin, invalidUrl, { method })).status).toBe(429);
  setGate(family, 'false');
  expectPrivate404(await request(routerOrigin, `${PREFIXES[family]}/${TOKEN}${suffix}`, { method }));
  setGate(family, 'true');
  expect((await request(routerOrigin, invalidUrl, { method })).status).toBe(429);
  expect(db).not.toHaveBeenCalled();
});

test.each(PREFIXES)('%s preserves CORS and Staff maintenance precedence', async (prefix) => {
  setGate(0, 'false');
  setGate(1, 'false');
  process.env.STAFF_MAINTENANCE_MODE = 'true';
  const url = `${prefix}/${TOKEN}`;
  expect((await request(composedOrigin, url, { method: 'OPTIONS' })).status).toBe(204);
  const token = jwt.sign({ technicianId: 'staff-test' }, 'public-gate-test-secret');
  const staff = await request(composedOrigin, url, { headers: { Authorization: `Bearer ${token}` } });
  expect(staff.status).toBe(503);
  expect(staff.body.code).toBe('STAFF_MAINTENANCE');
  expectPrivate404(await request(composedOrigin, url));
  expect(db).not.toHaveBeenCalled();
});

test.each([undefined, '', 'false', 'TRUE', '1', ' true '])('both gates fail closed for %p without consuming the global budget', async (value) => {
  setGate(0, value);
  setGate(1, value);
  for (let i = 0; i < 3; i += 1) {
    for (const prefix of PREFIXES) {
      expectPrivate404(await request(composedOrigin, `${prefix}/${TOKEN}`));
    }
  }
  expect((await request(composedOrigin, '/api/test-budget')).status).toBe(200);
  expect(db).not.toHaveBeenCalled();
});
