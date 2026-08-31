'use strict';

// C4 (GATE_CANCEL_FLOW_V2): a CANCELLED customer (active=false,
// pipeline_stage 'churned') keeps READ-ONLY portal access — login, session
// refresh, and exactly the routes in CANCELLED_READ_ROUTES. Everything else
// stays 401 for them; every inactive row that is NOT churned stays 401
// everywhere; with the gate off, today's behavior is unchanged.
//
// Real listen + fetch through the REAL middleware and the REAL /api/auth
// router; the other routers are stand-ins mounted at their production
// prefixes (the allowance keys on method + mounted path, and the routers
// themselves only ever call `authenticate`).

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('express-rate-limit', () => () => (_req, _res, next) => next());
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('@sentry/node', () => ({ captureException: jest.fn() }));
jest.mock('../services/twilio', () => ({
  sendVerificationCode: jest.fn().mockResolvedValue({}),
  checkVerificationCode: jest.fn().mockResolvedValue({ success: true }),
}));
jest.mock('../services/customer-credit', () => ({
  getLedger: jest.fn().mockResolvedValue([]),
  portalCreditsFromLedger: jest.fn(() => []),
  round2: (n) => Math.round(Number(n || 0) * 100) / 100,
}));
// The gate read is the real cancellation-resolution export; keep the heavy
// engine modules out of this suite.
jest.mock('../services/cancellation-resolution', () => ({
  cancelFlowV2Enabled: () => process.env.GATE_CANCEL_FLOW_V2 === 'true',
}));

const express = require('express');
const db = require('../models/db');
const auth = require('../middleware/auth');
const authRouter = require('../routes/auth');

// ── in-memory db ──────────────────────────────────────────────────────────
let tables;
const norm = (col) => String(col).replace(/^[a-z]+\./, '');
function builder(table) {
  const conds = [];
  const b = {};
  const rows = () => (tables[table] || []).filter((r) => conds.every((c) => c(r)));
  b.where = (a, op, val) => {
    if (typeof a === 'object') Object.entries(a).forEach(([k, v]) => conds.push((r) => String(r[norm(k)]) === String(v)));
    else if (val === undefined) conds.push((r) => String(r[norm(a)]) === String(op));
    else if (op === '>=') conds.push((r) => r[norm(a)] >= val);
    else conds.push((r) => String(r[norm(a)]) === String(val));
    return b;
  };
  b.whereNull = (col) => { conds.push((r) => r[norm(col)] == null); return b; };
  b.whereIn = (col, vals) => { conds.push((r) => vals.map(String).includes(String(r[norm(col)]))); return b; };
  b.whereRaw = (sql, params) => {
    if (/regexp_replace/.test(sql)) {
      const like = String(params[0]).replace(/%/g, '');
      conds.push((r) => String(r.phone || '').replace(/\D/g, '').endsWith(like));
    }
    return b;
  };
  // Multi-key sort, applied over the filtered rows like SQL — NOT one
  // in-place sort per call (last key would win) and with a TOTAL comparator:
  // undefined/NULL sorts last on asc / first on desc (Postgres), so a
  // missing created_at cannot flip the order between environments.
  const orders = [];
  b.orderBy = (col, dir) => { orders.push([norm(col), dir === 'desc' ? 'desc' : 'asc']); return b; };
  const sorted = () => {
    const list = rows();
    if (!orders.length) return list;
    const rank = (v) => (v === true ? 1 : v === false ? 0 : v);
    return [...list].sort((x, y) => {
      for (const [col, dir] of orders) {
        const a = rank(x[col]); const c = rank(y[col]);
        const aNull = a === undefined || a === null;
        const cNull = c === undefined || c === null;
        let cmp = 0;
        if (aNull && cNull) cmp = 0;
        else if (aNull) cmp = 1; // NULLS LAST on asc
        else if (cNull) cmp = -1;
        else cmp = a > c ? 1 : a < c ? -1 : 0;
        if (cmp !== 0) return dir === 'desc' ? -cmp : cmp;
      }
      return 0;
    });
  };
  b.orderByRaw = () => b;
  b.leftJoin = () => b;
  b.select = () => b;
  b.limit = () => b;
  b.forUpdate = () => b;
  b.first = async () => sorted()[0] || null;
  b.update = async (patch) => { const hit = rows(); hit.forEach((r) => Object.assign(r, patch)); return hit.length; };
  b.insert = (row) => {
    const list = (tables[table] ||= []);
    const inserted = { ...row };
    list.push(inserted);
    const ret = { returning: async () => [inserted] };
    return Object.assign(Promise.resolve([inserted]), ret, { onConflict: () => ({ ignore: () => ret }) });
  };
  b.then = (resolve, reject) => Promise.resolve(sorted()).then(resolve, reject);
  return b;
}
function installDb() {
  db.mockImplementation((table) => builder(table));
  db.transaction = async (fn) => fn((table) => builder(table));
  db.schema = { hasTable: async () => false };
  db.fn = { now: () => new Date() };
}

const CHURNED = {
  id: 'cust-churned', account_id: 'cust-churned', active: false, pipeline_stage: 'churned', churned_at: '2026-08-22',
  first_name: 'Pat', last_name: 'Former', phone: '+19415550101', email: 'pat@example.com', deleted_at: null,
  is_primary_profile: true, profile_label: 'Primary', monthly_rate: null, waveguard_tier: null,
};
const DEACTIVATED = { ...CHURNED, id: 'cust-deact', account_id: 'cust-deact', pipeline_stage: 'active_customer', phone: '+19415550102' };
const ACTIVE = { ...CHURNED, id: 'cust-active', account_id: 'cust-active', active: true, pipeline_stage: 'active_customer', phone: '+19415550103' };

// ── app: real /api/auth + stand-in routers at their production prefixes ────
const ECHO = (req, res) => res.json({ ok: true, inactive: req.customerInactive === true, id: req.customerId });
function standIn(paths) {
  const r = express.Router();
  r.use(auth.authenticate);
  for (const [method, path] of paths) r[method.toLowerCase()](path, ECHO);
  return r;
}
let server;
let baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  // /api/billing/autopay is its own router in production (index.js) — the
  // billing router has no /autopay route, so the request falls through.
  app.use('/api/billing/autopay', standIn([['GET', '/'], ['PUT', '/'], ['POST', '/pause']]));
  app.use('/api/billing', standIn([['GET', '/'], ['GET', '/balance'], ['GET', '/cards'], ['POST', '/cards'], ['POST', '/cards/setup-intent'], ['DELETE', '/cards/:id'], ['PUT', '/cards/:id/default']]));
  app.use('/api/schedule', standIn([['GET', '/'], ['GET', '/next'], ['POST', '/:id/confirm'], ['POST', '/:id/reschedule']]));
  app.use('/api/services', standIn([['GET', '/'], ['GET', '/stats/summary']]));
  app.use('/api/documents', standIn([['GET', '/'], ['GET', '/service-report/:id'], ['GET', '/:id/download'], ['POST', '/share/:id']]));
  app.use('/api/property', standIn([['GET', '/termite-bond'], ['GET', '/preferences'], ['PUT', '/preferences'], ['GET', '/station-map']]));
  app.use('/api/notifications', standIn([['GET', '/preferences'], ['PUT', '/preferences'], ['GET', '/property-preferences'], ['PUT', '/property-preferences/:id']]));
  app.use('/api/requests', standIn([['POST', '/restart-plan'], ['POST', '/cancel-resolution'], ['GET', '/']]));
  app.use('/api/referrals', standIn([['GET', '/'], ['POST', '/']]));
  app.use('/api/ai', standIn([['POST', '/chat']]));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  server = app.listen(0, '127.0.0.1', () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});
afterAll((done) => { server.close(done); });

beforeEach(() => {
  tables = {
    customers: [{ ...CHURNED }, { ...DEACTIVATED }, { ...ACTIVE }],
    customer_accounts: [{ id: 'cust-churned' }, { id: 'cust-deact' }, { id: 'cust-active' }],
    customer_refresh_tokens: [],
    notification_prefs: [],
  };
  installDb();
  process.env.GATE_CANCEL_FLOW_V2 = 'true';
});
afterEach(() => { delete process.env.GATE_CANCEL_FLOW_V2; });

const bearer = (id) => ({ Authorization: `Bearer ${auth.generateToken(id, id)}` });
async function call(method, path, headers = {}, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* none */ }
  return { status: res.status, body: json || {} };
}

const WIDENED_READS = [
  ['GET', '/api/auth/me'], ['GET', '/api/auth/properties'],
  ['GET', '/api/billing'], ['GET', '/api/billing?limit=100&cursor=0'], ['GET', '/api/billing/balance'], ['GET', '/api/billing/cards'],
  ['GET', '/api/billing/autopay'],
  ['GET', '/api/schedule?days=365'], ['GET', '/api/schedule/next'],
  ['GET', '/api/services?limit=50'], ['GET', '/api/services/stats/summary'],
  ['GET', '/api/documents'], ['GET', '/api/documents/service-report/svc-1'], ['GET', '/api/documents/doc-1/download'],
  ['GET', '/api/property/termite-bond'],
  ['GET', '/api/notifications/preferences'], ['GET', '/api/notifications/property-preferences'],
  ['POST', '/api/requests/restart-plan'],
];
const STILL_BLOCKED = [
  ['PUT', '/api/billing/autopay'], ['POST', '/api/billing/autopay/pause'],
  ['POST', '/api/billing/cards'], ['POST', '/api/billing/cards/setup-intent'], ['DELETE', '/api/billing/cards/pm-1'], ['PUT', '/api/billing/cards/pm-1/default'],
  ['POST', '/api/schedule/svc-1/confirm'], ['POST', '/api/schedule/svc-1/reschedule'],
  ['POST', '/api/documents/share/doc-1'],
  ['GET', '/api/property/preferences'], ['PUT', '/api/property/preferences'], ['GET', '/api/property/station-map'],
  ['PUT', '/api/notifications/preferences'], ['PUT', '/api/notifications/property-preferences/cust-churned'],
  ['POST', '/api/requests/cancel-resolution'], ['GET', '/api/requests'],
  ['GET', '/api/referrals'], ['POST', '/api/referrals'],
  ['POST', '/api/ai/chat'],
  ['POST', '/api/auth/select-property'], ['PUT', '/api/auth/credit-preference'], ['DELETE', '/api/auth/account'],
];

describe('cancelled customer — read allowance (gate on)', () => {
  test.each(WIDENED_READS)('%s %s admits the churned customer as inactive', async (method, path) => {
    const res = await call(method, path, bearer('cust-churned'), method === 'POST' ? {} : undefined);
    expect(res.status).toBe(200);
    if (path.startsWith('/api/auth/me')) {
      expect(res.body.cancelled).toBe(true);
      expect(res.body.cancelledAt).toBe('2026-08-22');
    } else if (path.startsWith('/api/auth/properties')) {
      expect(res.body.properties.map((p) => p.id)).toEqual(['cust-churned']);
    } else {
      expect(res.body).toEqual({ ok: true, inactive: true, id: 'cust-churned' });
    }
  });

  test.each(STILL_BLOCKED)('%s %s stays 401 for the churned customer', async (method, path) => {
    const res = await call(method, path, bearer('cust-churned'), ['POST', 'PUT'].includes(method) ? {} : undefined);
    expect(res.status).toBe(401);
  });

  test('an inactive row that is NOT churned is still refused on every widened read', async () => {
    for (const [method, path] of WIDENED_READS) {
      const res = await call(method, path, bearer('cust-deact'), method === 'POST' ? {} : undefined);
      expect([method, path, res.status]).toEqual([method, path, 401]);
    }
  });

  test('an active customer is unaffected: reads and writes both pass, /me says not cancelled', async () => {
    const me = await call('GET', '/api/auth/me', bearer('cust-active'));
    expect(me.status).toBe(200);
    expect(me.body.cancelled).toBe(false);
    expect(me.body.cancelledAt).toBeNull();
    const write = await call('POST', '/api/billing/cards', bearer('cust-active'), {});
    expect(write.status).toBe(200);
    expect(write.body.inactive).toBe(false);
  });
});

describe('cancelled customer — gate off = today\'s behavior', () => {
  test('every widened read is 401 for the churned customer when GATE_CANCEL_FLOW_V2 is unset', async () => {
    delete process.env.GATE_CANCEL_FLOW_V2;
    for (const [method, path] of WIDENED_READS) {
      const res = await call(method, path, bearer('cust-churned'), method === 'POST' ? {} : undefined);
      expect([method, path, res.status]).toEqual([method, path, 401]);
    }
  });
});

describe('cancelled customer — login + session refresh', () => {
  test('verify-code logs a churned customer in (gate on) and the refresh token rotates', async () => {
    const login = await call('POST', '/api/auth/verify-code', {}, { phone: '+19415550101', code: '123456' });
    expect(login.status).toBe(200);
    expect(login.body.customer.id).toBe('cust-churned');
    expect(login.body.properties.map((p) => p.id)).toEqual(['cust-churned']);

    const refreshed = await call('POST', '/api/auth/refresh', {}, { refreshToken: login.body.refreshToken });
    expect(refreshed.status).toBe(200);
    expect(typeof refreshed.body.token).toBe('string');

    const me = await call('GET', '/api/auth/me', { Authorization: `Bearer ${refreshed.body.token}` });
    expect(me.status).toBe(200);
    expect(me.body.cancelled).toBe(true);
  });

  test('verify-code refuses a churned customer with the gate off, and a deactivated (non-churned) row always', async () => {
    delete process.env.GATE_CANCEL_FLOW_V2;
    const dark = await call('POST', '/api/auth/verify-code', {}, { phone: '+19415550101', code: '123456' });
    expect(dark.status).toBe(401);
    process.env.GATE_CANCEL_FLOW_V2 = 'true';
    const deact = await call('POST', '/api/auth/verify-code', {}, { phone: '+19415550102', code: '123456' });
    expect(deact.status).toBe(401);
  });

  test('an ACTIVE profile on the same phone wins over a churned one', async () => {
    tables.customers.push({ ...ACTIVE, id: 'cust-active-2', account_id: 'cust-active-2', phone: '+19415550101', created_at: '2026-01-01' });
    tables.customer_accounts.push({ id: 'cust-active-2' });
    const login = await call('POST', '/api/auth/verify-code', {}, { phone: '+19415550101', code: '123456' });
    expect(login.status).toBe(200);
    expect(login.body.customer.id).toBe('cust-active-2');
  });

  test('a churned customer\'s refresh token is rejected once the gate is off', async () => {
    const login = await call('POST', '/api/auth/verify-code', {}, { phone: '+19415550101', code: '123456' });
    delete process.env.GATE_CANCEL_FLOW_V2;
    const refreshed = await call('POST', '/api/auth/refresh', {}, { refreshToken: login.body.refreshToken });
    expect(refreshed.status).toBe(401);
  });
});

describe('CANCELLED_READ_ROUTES', () => {
  test('is exact on paths (a sibling route is not admitted by prefix)', () => {
    const { cancelledReadRoute } = auth._test;
    expect(cancelledReadRoute({ method: 'GET', baseUrl: '/api/billing', path: '/' })).toBe(true);
    expect(cancelledReadRoute({ method: 'GET', baseUrl: '/api/billing', path: '/balance' })).toBe(true);
    expect(cancelledReadRoute({ method: 'GET', baseUrl: '/api/billing', path: '/balance/extra' })).toBe(false);
    expect(cancelledReadRoute({ method: 'GET', baseUrl: '/api/documents', path: '/doc-1/download' })).toBe(true);
    expect(cancelledReadRoute({ method: 'GET', baseUrl: '/api/documents', path: '/shared/tok' })).toBe(false);
    expect(cancelledReadRoute({ method: 'POST', baseUrl: '/api/billing', path: '/' })).toBe(false);
  });
});
