/**
 * Phase 2C-1 (P1-18): public /api/booking/* endpoint hardening:
 *   1. GET /api/booking/sources requires admin auth + valid integer days (1..365)
 *      and is removed from public-route-allowlist.json.
 *   2. GET /api/booking/customer-lookup carries noStore privacy headers and a /64
 *      IP-collapsed rate limiter (30/15m).
 *   3. GET /api/booking/availability enforces strict YYYY-MM-DD calendar date
 *      validation on date_from/date_to (400 before DB reads) and a /64 limiter (60/15m).
 *   4. POST /api/booking/capture-intent suppresses bare intents when
 *      GATE_BOOKING_CUSTOMERS_ONLY is enabled and no verified portal customer
 *      bearer is present (failing closed), while keeping constant 200 { ok: true }.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'booking-sec-test-secret';
process.env.CAPTURE_TOKEN_SECRET = process.env.CAPTURE_TOKEN_SECRET || 'booking-sec-capture-secret';
process.env.ESTIMATE_HANDOFF_SECRET = process.env.ESTIMATE_HANDOFF_SECRET || 'booking-sec-handoff-secret';

const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const jwt = require('jsonwebtoken');

const { etDateString, addETDays } = require('../utils/datetime-et');

jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
const logger = require('../services/logger');

const gateState = { selfBooking: true, bookingCustomersOnly: true, bookingPreferTime: false };
jest.mock('../config/feature-gates', () => ({
  ...jest.requireActual('../config/feature-gates'),
  isEnabled: jest.fn((name) => (name in gateState ? gateState[name] : true)),
  bookPreferredTimeLive: jest.fn(() => false),
  bookCapacityCommitLive: jest.fn(() => false),
  bookArrivalGraceLive: jest.fn(() => false),
  reserviceRankAfterNewLive: jest.fn(() => false),
  multiTechConfirmLive: jest.fn(() => false),
}));

const insertedRows = [];
const updatedRows = [];
const firstResults = {
  booking_config: null,
  customers: null,
  estimates: null,
  booking_intents: null,
  self_booked_appointments: null,
  technicians: {
    id: 'tech-admin-1',
    role: 'admin',
    employment_status: 'active',
    active: true,
    auth_token_version: 1,
    mfa_enrolled_at: null,
  },
};
const listResults = {
  self_booked_appointments: [{ source: 'website', count: '4' }],
  booking_intents: [],
  customers: [],
};

const dbCalls = [];
const rawCalls = [];
jest.mock('../models/db', () => {
  const mkChain = (table) => {
    const q = {};
    const whereObj = {};
    const gtFilters = [];
    const whereNullCols = new Set();
    const whereNotNullCols = new Set();
    const passthrough = [
      'whereIn', 'whereNot', 'whereNotIn', 'whereRaw',
      'andWhere', 'orWhere', 'orWhereIn', 'orWhereRaw', 'orderBy', 'orderByRaw', 'limit',
      'offset', 'select', 'join', 'leftJoin', 'groupBy', 'count', 'modify',
      'returning', 'forShare', 'forUpdate', 'distinct',
    ];
    for (const m of passthrough) q[m] = () => q;
    q.whereNull = (col) => { whereNullCols.add(col); return q; };
    q.whereNotNull = (col) => { whereNotNullCols.add(col); return q; };
    q.where = (cond, opOrVal, maybeVal) => {
      if (cond && typeof cond === 'object') Object.assign(whereObj, cond);
      else if (typeof cond === 'string' && opOrVal === '>' && maybeVal !== undefined) gtFilters.push([cond, maybeVal]);
      else if (typeof cond === 'string' && opOrVal !== undefined && maybeVal === undefined) whereObj[cond] = opOrVal;
      return q;
    };
    q.update = (payload) => {
      updatedRows.push({ table, where: { ...whereObj }, payload });
      return Promise.resolve(1);
    };
    q.insert = (row) => {
      insertedRows.push({ table, row });
      return {
        returning: async () => [{ id: 'intent-1', ...(Array.isArray(row) ? row[0] : row) }],
        then: (onOk, onErr) => Promise.resolve([{ id: 'intent-1', ...(Array.isArray(row) ? row[0] : row) }]).then(onOk, onErr),
      };
    };
    q.first = async () => {
      const row = firstResults[table] !== undefined ? firstResults[table] : null;
      if (row && whereObj.id !== undefined && String(row.id) !== String(whereObj.id)) return null;
      if (row && whereObj.customer_id !== undefined && row.customer_id !== undefined && String(row.customer_id) !== String(whereObj.customer_id)) return null;
      if (row && gtFilters.some(([col, min]) => row[col] !== undefined && !(Number(row[col]) > Number(min)))) return null;
      if (table === 'booking_intents' && row) {
        if (whereNotNullCols.has('converted_at') && row.converted_at == null) return null;
        if (whereNullCols.has('converted_at') && row.converted_at != null) return null;
      }
      return row;
    };
    q.then = (onOk, onErr) => Promise.resolve(listResults[table] || []).then(onOk, onErr);
    q.catch = (fn) => Promise.resolve(listResults[table] || []).catch(fn);
    return q;
  };
  const dbFn = jest.fn((table) => {
    dbCalls.push(table);
    return mkChain(table);
  });
  dbFn.raw = (...args) => {
    rawCalls.push(args);
    return args[0];
  };
  dbFn.fn = { now: () => 'NOW()' };
  dbFn.transaction = async (fn) => fn(dbFn);
  return dbFn;
});

const mockSlotDate = etDateString(addETDays(new Date(), 3));
jest.mock('../services/scheduling/find-time', () => ({
  findAvailableSlots: jest.fn(async () => ({
    slots: [{
      date: mockSlotDate,
      start_time: '09:00',
      end_time: '10:00',
      technician: { id: 'tech-1', name: 'Tech One' },
      detour_minutes: 0,
      rank: 1,
      score: 1,
      stops_that_day: 0,
    }],
  })),
}));
jest.mock('../services/scheduling/occupancy', () => ({
  listOccupiedWindows: jest.fn(async () => []),
}));

const bookingRouter = require('../routes/booking');
const { mintCaptureToken } = bookingRouter._internals;
const { generateToken } = require('../middleware/auth');
const { mintEstimateHandoffToken } = require('../utils/estimate-handoff-token');

function buildApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use('/api/booking', bookingRouter);
  return app;
}

async function httpRequest(app, method, url, { headers = {}, body } = {}) {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* ignore */ }
    return { status: res.status, headers: res.headers, body: json, text };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function makeAdminToken(overrides = {}) {
  return jwt.sign(
    {
      technicianId: 'tech-admin-1',
      role: 'admin',
      type: 'access',
      tokenVersion: 1,
      ...overrides,
    },
    process.env.JWT_SECRET,
    { expiresIn: '1h' },
  );
}

describe('Phase 2C-1 P1-18 booking route security & privacy', () => {
  beforeEach(() => {
    insertedRows.length = 0;
    updatedRows.length = 0;
    dbCalls.length = 0;
    logger.debug.mockClear();
    logger.warn.mockClear();
    logger.error.mockClear();
    gateState.selfBooking = true;
    gateState.bookingCustomersOnly = true;
    firstResults.estimates = null;
    firstResults.booking_intents = null;
    firstResults.customers = null;
    firstResults.technicians = {
      id: 'tech-admin-1',
      role: 'admin',
      employment_status: 'active',
      active: true,
      auth_token_version: 1,
      mfa_enrolled_at: null,
    };
  });

  describe('GET /api/booking/sources', () => {
    test('is removed from public-route-allowlist.json', () => {
      const allowlist = JSON.parse(
        fs.readFileSync(path.join(__dirname, '../config/public-route-allowlist.json'), 'utf8'),
      );
      const bookingEntry = allowlist.mounts.find((r) => r.router === 'server/routes/booking.js');
      expect(bookingEntry.routes).not.toContain('GET /api/booking/sources');
    });

    test('rejects unauthenticated requests with 401', async () => {
      const app = buildApp();
      const res = await httpRequest(app, 'GET', '/api/booking/sources');
      expect(res.status).toBe(401);
    });

    test('rejects non-admin technician bearer with 403', async () => {
      firstResults.technicians = {
        id: 'tech-field-1',
        role: 'technician',
        employment_status: 'active',
        active: true,
        auth_token_version: 1,
      };
      const app = buildApp();
      const token = makeAdminToken({ technicianId: 'tech-field-1', role: 'technician' });
      const res = await httpRequest(app, 'GET', '/api/booking/sources', {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(403);
    });

    test('validates days integer in 1..365 for authenticated admins', async () => {
      const app = buildApp();
      const headers = { Authorization: `Bearer ${makeAdminToken()}` };
      for (const badDays of ['0', '366', '-5', '1.5', 'abc']) {
        const res = await httpRequest(app, 'GET', `/api/booking/sources?days=${badDays}`, { headers });
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'days must be an integer between 1 and 365' });
      }
      const ok = await httpRequest(app, 'GET', '/api/booking/sources?days=14', { headers });
      expect(ok.status).toBe(200);
      expect(ok.body.sources).toEqual([{ source: 'website', count: '4' }]);
    });
  });

  describe('GET /api/booking/customer-lookup', () => {
    test('sets noStore privacy headers', async () => {
      const app = buildApp();
      const res = await httpRequest(app, 'GET', '/api/booking/customer-lookup?phone=9415551234', {
        headers: { 'X-Forwarded-For': '198.51.100.10' },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toContain('no-store');
      expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    });

    test('rate limits per /64-collapsed IPv6 prefix (30 requests per 15m)', async () => {
      const app = buildApp();
      for (let i = 1; i <= 30; i += 1) {
        const res = await httpRequest(app, 'GET', '/api/booking/customer-lookup?phone=invalid', {
          headers: { 'X-Forwarded-For': `2001:db8:cafe:0001::${i.toString(16)}` },
        });
        expect({ status: res.status, text: res.text }).toEqual({ status: 200, text: expect.any(String) });
      }
      const limited = await httpRequest(app, 'GET', '/api/booking/customer-lookup?phone=invalid', {
        headers: { 'X-Forwarded-For': '2001:db8:cafe:0001::ffff' },
      });
      expect(limited.status).toBe(429);
    });
  });

  describe('GET /api/booking/availability', () => {
    test('rejects invalid, impossible, or empty YYYY-MM-DD date_from/date_to with 400 before DB reads', async () => {
      const app = buildApp();
      for (const qs of [
        'date_from=2026-02-31&date_to=2026-03-05',
        'date_from=not-a-date',
        'date_to=2026-7-1',
        'date_from=',
        'date_to=',
      ]) {
        dbCalls.length = 0;
        const res = await httpRequest(app, 'GET', `/api/booking/availability?${qs}`, {
          headers: { 'X-Forwarded-For': '198.51.100.20' },
        });
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'date_from and date_to must be YYYY-MM-DD' });
        expect(dbCalls).toEqual([]);
      }
    });

    test('checks selfBooking gate before rate limiter and date validation (preserves 503 without consuming quota)', async () => {
      gateState.selfBooking = false;
      const app = buildApp();
      const headers = { 'X-Forwarded-For': '2001:db8:cafe:0099::1' };
      for (let i = 1; i <= 65; i += 1) {
        const res = await httpRequest(app, 'GET', '/api/booking/availability?date_from=bad-date', { headers });
        expect(res.status).toBe(503);
        expect(res.body).toEqual({ error: 'Self-scheduling coming soon' });
      }
    });

    test('rate limits per /64-collapsed IPv6 prefix (60 requests per 15m)', async () => {
      const app = buildApp();
      for (let i = 1; i <= 60; i += 1) {
        const res = await httpRequest(app, 'GET', '/api/booking/availability?date_from=2026-07-01', {
          headers: { 'X-Forwarded-For': `2001:db8:beef:0002::${i.toString(16)}` },
        });
        expect({ status: res.status, error: res.body?.error, text: res.text }).toEqual({
          status: 400,
          error: 'address, lat/lng, or city required',
          text: expect.any(String),
        });
      }
      const limited = await httpRequest(app, 'GET', '/api/booking/availability?date_from=2026-07-01', {
        headers: { 'X-Forwarded-For': '2001:db8:beef:0002::aaaa' },
      });
      expect(limited.status).toBe(429);
    });
  });

  describe('POST /api/booking/capture-intent bare customers-only suppression', () => {
    const validBody = (ip, overrides = {}) => ({
      capture_token: mintCaptureToken(bookingRouter._internals.captureIpKey({ headers: {}, ip })),
      phone: '9415550199',
      email: 'pat@example.com',
      address_line1: '100 Main St',
      city: 'Bradenton',
      lat: 27.49,
      lng: -82.57,
      slot_date: mockSlotDate,
      slot_start: '09:00',
      service_id: 'pest_control',
      ...overrides,
    });

    test('suppresses bare unauthenticated capture when GATE_BOOKING_CUSTOMERS_ONLY is on and returns 200 ok', async () => {
      const app = buildApp();
      const ip = '198.51.100.31';
      const res = await httpRequest(app, 'POST', '/api/booking/capture-intent', {
        headers: { 'X-Forwarded-For': ip },
        body: validBody(ip),
      });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      const insert = insertedRows.find((r) => r.table === 'booking_intents');
      expect(insert).toBeTruthy();
      expect(insert.row.suppressed).toBe(true);
    });

    test('keeps bare capture unsuppressed when authenticated with a matching portal customer bearer & contact', async () => {
      firstResults.customers = {
        id: 'cust-auth-1',
        phone: '+19415550199',
        email: 'Pat@Example.com',
        pipeline_stage: 'active_customer',
        active: true,
        deleted_at: null,
        auth_token_version: 1,
      };
      const customerToken = generateToken('cust-auth-1');
      const app = buildApp();
      const ip = '198.51.100.32';
      const res = await httpRequest(app, 'POST', '/api/booking/capture-intent', {
        headers: { 'X-Forwarded-For': ip, Authorization: `Bearer ${customerToken}` },
        body: validBody(ip),
      });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      const insert = insertedRows.find((r) => r.table === 'booking_intents');
      expect(insert).toBeTruthy();
      expect(insert.row.suppressed).toBeUndefined();
      expect(insert.row.customer_id).toBe('cust-auth-1');
    });

    test('suppresses bare capture when bearer customer is pre-customer stage (new_lead) under customers-only gate', async () => {
      firstResults.customers = {
        id: 'cust-lead-bearer',
        phone: '+19415550199',
        email: 'pat@example.com',
        pipeline_stage: 'new_lead',
        active: true,
        deleted_at: null,
      };
      const leadToken = generateToken('cust-lead-bearer');
      const app = buildApp();
      const ip = '198.51.100.37';
      const res = await httpRequest(app, 'POST', '/api/booking/capture-intent', {
        headers: { 'X-Forwarded-For': ip, Authorization: `Bearer ${leadToken}` },
        body: validBody(ip),
      });
      expect(res.status).toBe(200);
      expect(insertedRows.at(-1).row.suppressed).toBe(true);
      expect(insertedRows.at(-1).row.customer_id).toBe('cust-lead-bearer');
    });

    test('skips stale matching capture when a newer suppressed edit already ran in the session', async () => {
      firstResults.customers = {
        id: 'cust-auth-1',
        phone: '+19415550199',
        email: 'pat@example.com',
        pipeline_stage: 'active_customer',
        active: true,
        deleted_at: null,
      };
      firstResults.booking_intents = { id: 'intent-newer', converted_at: null, customer_id: 'cust-auth-1' };
      const customerToken = generateToken('cust-auth-1');
      const app = buildApp();
      const ip = '198.51.100.38';
      const res = await httpRequest(app, 'POST', '/api/booking/capture-intent', {
        headers: { 'X-Forwarded-For': ip, Authorization: `Bearer ${customerToken}` },
        body: validBody(ip, { session_id: 'sess-race-1', capture_client_ts: 100 }),
      });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(updatedRows.filter((u) => u.table === 'booking_intents')).toHaveLength(0);
      expect(insertedRows).toHaveLength(0);
    });

    test('scopes bearer intent updates to customer_id and retires prior session intent when corrected capture hits unavailable slot', async () => {
      firstResults.customers = {
        id: 'cust-auth-1',
        phone: '+19415550199',
        email: 'pat@example.com',
        pipeline_stage: 'active_customer',
        active: true,
        deleted_at: null,
      };
      firstResults.booking_intents = { id: 'intent-own', converted_at: null, customer_id: 'cust-auth-1', capture_client_ts: 100 };
      const customerToken = generateToken('cust-auth-1');
      const app = buildApp();
      const ip = '198.51.100.39';
      const okRes = await httpRequest(app, 'POST', '/api/booking/capture-intent', {
        headers: { 'X-Forwarded-For': ip, Authorization: `Bearer ${customerToken}` },
        body: validBody(ip, { session_id: 'sess-scope-1', capture_client_ts: 200 }),
      });
      expect(okRes.status).toBe(200);
      expect(updatedRows).toContainEqual(expect.objectContaining({
        table: 'booking_intents',
        where: expect.objectContaining({ id: 'intent-own', customer_id: 'cust-auth-1' }),
      }));

      updatedRows.length = 0;
      const earlyRes = await httpRequest(app, 'POST', '/api/booking/capture-intent', {
        headers: { 'X-Forwarded-For': '198.51.100.44', Authorization: `Bearer ${customerToken}` },
        body: validBody('198.51.100.44', {
          session_id: 'sess-scope-1',
          capture_client_ts: 300,
          phone: '9415559999',
          slot_start: '19:00',
        }),
      });
      expect(earlyRes.status).toBe(200);
      expect(updatedRows).toContainEqual(expect.objectContaining({
        table: 'booking_intents',
        where: expect.objectContaining({ session_id: 'sess-scope-1', customer_id: 'cust-auth-1', suppressed: false }),
        payload: expect.objectContaining({ suppressed: true, capture_client_ts: 300 }),
      }));
    });

    test('suppresses bare capture when bearer token ID does not resolve in DB', async () => {
      firstResults.customers = {
        id: 'cust-auth-1',
        phone: '+19415550199',
        email: 'pat@example.com',
        pipeline_stage: 'active_customer',
        active: true,
        deleted_at: null,
      };
      const unknownToken = generateToken('cust-unknown');
      const app = buildApp();
      const ip = '198.51.100.36';
      const res = await httpRequest(app, 'POST', '/api/booking/capture-intent', {
        headers: { 'X-Forwarded-For': ip, Authorization: `Bearer ${unknownToken}` },
        body: validBody(ip),
      });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      const insert = insertedRows.find((r) => r.table === 'booking_intents');
      expect(insert).toBeTruthy();
      expect(insert.row.suppressed).toBe(true);
    });

    test('suppresses authenticated bare capture when submitted phone does not match bearer customer and retires prior session intent', async () => {
      firstResults.customers = {
        id: 'cust-auth-1',
        phone: '+19415550199',
        email: 'pat@example.com',
        pipeline_stage: 'active_customer',
        active: true,
        deleted_at: null,
        auth_token_version: 1,
      };
      const customerToken = generateToken('cust-auth-1');
      const app = buildApp();
      const ip = '198.51.100.34';
      const res = await httpRequest(app, 'POST', '/api/booking/capture-intent', {
        headers: { 'X-Forwarded-For': ip, Authorization: `Bearer ${customerToken}` },
        body: validBody(ip, { session_id: 'sess-edit-1', capture_client_ts: 500, phone: '9415559999' }),
      });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      const insert = insertedRows.find((r) => r.table === 'booking_intents');
      expect(insert).toBeTruthy();
      expect(insert.row.suppressed).toBe(true);
      expect(updatedRows).toContainEqual(expect.objectContaining({
        table: 'booking_intents',
        where: expect.objectContaining({ session_id: 'sess-edit-1', customer_id: 'cust-auth-1', suppressed: false }),
        payload: expect.objectContaining({ suppressed: true }),
      }));
    });

    test('suppresses authenticated bare capture when submitted email does not match bearer customer', async () => {
      firstResults.customers = {
        id: 'cust-auth-1',
        phone: '+19415550199',
        email: 'pat@example.com',
        pipeline_stage: 'active_customer',
        active: true,
        deleted_at: null,
        auth_token_version: 1,
      };
      const customerToken = generateToken('cust-auth-1');
      const app = buildApp();
      const ip = '198.51.100.35';
      const res = await httpRequest(app, 'POST', '/api/booking/capture-intent', {
        headers: { 'X-Forwarded-For': ip, Authorization: `Bearer ${customerToken}` },
        body: validBody(ip, { email: 'stranger@example.com' }),
      });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      const insert = insertedRows.find((r) => r.table === 'booking_intents');
      expect(insert).toBeTruthy();
      expect(insert.row.suppressed).toBe(true);
    });

    test('provisional handoff requires live eligible draft and matching phone/email', async () => {
      firstResults.customers = {
        id: 'cust-lead-1',
        phone: '+19415550199',
        email: 'pat@example.com',
        pipeline_stage: 'new_lead',
        deleted_at: null,
      };
      firstResults.estimates = {
        id: 'est-prov-1',
        customer_id: 'cust-lead-1',
        source: 'quote_wizard',
        status: 'draft',
        archived_at: null,
        customer_phone: '9415550199',
        customer_email: 'pat@example.com',
        estimate_data: { annual: 0, oneTimeTotal: 150 },
      };
      const app = buildApp();
      const handoff = { pricing_estimate_id: 'est-prov-1', estimate_token: mintEstimateHandoffToken('est-prov-1') };

      const okRes = await httpRequest(app, 'POST', '/api/booking/capture-intent', {
        headers: { 'X-Forwarded-For': '198.51.100.40' },
        body: validBody('198.51.100.40', handoff),
      });
      expect(okRes.status).toBe(200);
      expect(insertedRows.at(-1).row.suppressed).toBeUndefined();

      updatedRows.length = 0;
      rawCalls.length = 0;
      const badPhoneRes = await httpRequest(app, 'POST', '/api/booking/capture-intent', {
        headers: { 'X-Forwarded-For': '198.51.100.41' },
        body: validBody('198.51.100.41', { ...handoff, session_id: 'sess-handoff-1', capture_client_ts: 400, phone: '9415558888' }),
      });
      expect(badPhoneRes.status).toBe(200);
      expect(insertedRows.at(-1).row.suppressed).toBe(true);
      expect(rawCalls.some(([sql, params]) => String(sql).includes('booking-handoff-session')
        && Array.isArray(params) && params[0] === 'est-prov-1:sess-handoff-1')).toBe(true);
      expect(updatedRows).toContainEqual(expect.objectContaining({
        table: 'booking_intents',
        where: expect.objectContaining({ session_id: 'sess-handoff-1', pricing_estimate_id: 'est-prov-1', suppressed: false }),
        payload: expect.objectContaining({ suppressed: true, capture_client_ts: 400 }),
      }));

      // Early exit on contact-corrected handoff also acquires the handoff-session lock and persists timestamp.
      updatedRows.length = 0;
      rawCalls.length = 0;
      const earlyHandoffRes = await httpRequest(app, 'POST', '/api/booking/capture-intent', {
        headers: { 'X-Forwarded-For': '198.51.100.46' },
        body: validBody('198.51.100.46', {
          ...handoff,
          session_id: 'sess-handoff-1',
          capture_client_ts: 500,
          phone: '9415558888',
          slot_start: '19:00',
        }),
      });
      expect(earlyHandoffRes.status).toBe(200);
      expect(rawCalls.some(([sql, params]) => String(sql).includes('booking-handoff-session')
        && Array.isArray(params) && params[0] === 'est-prov-1:sess-handoff-1')).toBe(true);
      expect(updatedRows).toContainEqual(expect.objectContaining({
        table: 'booking_intents',
        where: expect.objectContaining({ session_id: 'sess-handoff-1', pricing_estimate_id: 'est-prov-1', suppressed: false }),
        payload: expect.objectContaining({ suppressed: true, capture_client_ts: 500 }),
      }));

      // Out-of-order delayed matching handoff capture is skipped as stale once a newer suppressed edit ran.
      firstResults.booking_intents = {
        id: 'intent-handoff-sup',
        converted_at: null,
        pricing_estimate_id: 'est-prov-1',
        session_id: 'sess-handoff-1',
        capture_client_ts: 400,
      };
      const countBefore = insertedRows.length;
      const staleOkRes = await httpRequest(app, 'POST', '/api/booking/capture-intent', {
        headers: { 'X-Forwarded-For': '198.51.100.45' },
        body: validBody('198.51.100.45', { ...handoff, session_id: 'sess-handoff-1', capture_client_ts: 200 }),
      });
      expect(staleOkRes.status).toBe(200);
      expect(insertedRows).toHaveLength(countBefore);
      firstResults.booking_intents = null;

      const badEmailRes = await httpRequest(app, 'POST', '/api/booking/capture-intent', {
        headers: { 'X-Forwarded-For': '198.51.100.42' },
        body: validBody('198.51.100.42', { ...handoff, email: 'other@example.com' }),
      });
      expect(badEmailRes.status).toBe(200);
      expect(insertedRows.at(-1).row.suppressed).toBe(true);

      // Expired draft retires prior open recovery intents and triggers send-time worker skip.
      firstResults.estimates = {
        ...firstResults.estimates,
        expires_at: '2020-01-01T00:00:00.000Z',
      };
      const expiredRes = await httpRequest(app, 'POST', '/api/booking/capture-intent', {
        headers: { 'X-Forwarded-For': '198.51.100.43' },
        body: validBody('198.51.100.43', handoff),
      });
      expect(expiredRes.status).toBe(200);
      expect(insertedRows.at(-1).row.suppressed).toBe(true);
      expect(updatedRows).toContainEqual(expect.objectContaining({
        table: 'booking_intents',
        where: expect.objectContaining({ pricing_estimate_id: 'est-prov-1' }),
        payload: expect.objectContaining({ suppressed: true }),
      }));

      const { _internals: recoveryInternals } = require('../services/booking-abandon-recovery');
      expect(await recoveryInternals.blockedByContactLinkedHandoff({
        id: 'bi-expired',
        pricing_estimate_id: 'est-prov-1',
        phone: '9415550199',
        email: 'pat@example.com',
      })).toBe(true);

      // Mismatched live draft contact (email or phone changed) suppresses recovery at send time.
      firstResults.estimates = {
        id: 'est-prov-1',
        customer_id: 'cust-lead-1',
        source: 'quote_wizard',
        status: 'draft',
        archived_at: null,
        customer_phone: '9415550199',
        customer_email: 'updated@example.com',
        estimate_data: { annual: 0, oneTimeTotal: 150 },
      };
      expect(await recoveryInternals.blockedByContactLinkedHandoff({
        id: 'bi-stale-email',
        pricing_estimate_id: 'est-prov-1',
        phone: '9415550199',
        email: 'pat@example.com',
      })).toBe(true);

      // Missing draft suppresses recovery at send time.
      firstResults.estimates = null;
      expect(await recoveryInternals.blockedByContactLinkedHandoff({
        id: 'bi-missing-draft',
        pricing_estimate_id: 'est-prov-1',
        phone: '9415550199',
      })).toBe(true);
    });

    test('keeps bare capture unsuppressed when GATE_BOOKING_CUSTOMERS_ONLY is off', async () => {
      gateState.bookingCustomersOnly = false;
      const app = buildApp();
      const ip = '198.51.100.33';
      const res = await httpRequest(app, 'POST', '/api/booking/capture-intent', {
        headers: { 'X-Forwarded-For': ip },
        body: validBody(ip),
      });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      const insert = insertedRows.find((r) => r.table === 'booking_intents');
      expect(insert).toBeTruthy();
      expect(insert.row.suppressed).toBeUndefined();
    });
  });
});
