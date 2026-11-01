/**
 * Away Watch dates on the customer's Property tab routes (GATE_AWAY_WATCH): GET carries the gate flag and the two days,
 * PUT saves the pair whole or not at all, and with the gate off neither route accepts or returns them.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

// Away Watch is a member perk: the logged-in customer is a WaveGuard member unless a test says otherwise.
const MEMBER = { id: 'cust-1', waveguard_tier: 'Gold', lawn_type: null };
const mockSession = { customer: MEMBER };
jest.mock('../middleware/auth', () => ({
  authenticate: (req, _res, next) => {
    req.customerId = 'cust-1';
    req.customer = mockSession.customer;
    next();
  },
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/account-membership-email', () => ({ sendAccountUpdated: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/termite-stations', () => ({}));
jest.mock('../services/irrigation-weekly-email', () => ({ hasLawnServiceEvidence: jest.fn(), hasIrrigationEmailOptIn: jest.fn(async () => false) }));
jest.mock('../services/irrigation-app-plan', () => ({ appPlanEnabled: jest.fn(() => false), loadCustomerWateringPlan: jest.fn() }));

// Minimal fake `property_preferences` table backed by one in-memory row.
// None of the fields exercised here (parkingNotes/hoaEmail/accessNotes) are
// irrigation sizing fields, so the confirmation-ledger jsonb union branch
// never runs and this fake never needs to emulate `trx.raw`'s SQL — it only
// has to resolve the advisory-lock `await trx.raw(...)` call.
jest.mock('../models/db', () => {
  const state = { row: null };
  const propertyPreferencesTable = () => {
    const q = {};
    q.where = jest.fn(() => q);
    q.first = jest.fn(async () => state.row);
    q.update = jest.fn(async (patch) => {
      state.row = { ...state.row, ...patch, updated_at: new Date().toISOString() };
      return 1;
    });
    q.insert = jest.fn(async (data) => {
      state.row = { id: 'pref-1', customer_id: 'cust-1', created_at: new Date().toISOString(), ...data };
      return [1];
    });
    return q;
  };
  const dbFn = jest.fn((table) => {
    if (table !== 'property_preferences') throw new Error(`Unexpected table ${table}`);
    return propertyPreferencesTable();
  });
  dbFn.transaction = jest.fn(async (cb) => cb(dbFn));
  dbFn.raw = jest.fn(async () => undefined);
  dbFn.fn = { now: jest.fn(() => new Date().toISOString()) };
  dbFn._state = state;
  return dbFn;
});

const express = require('express');
const db = require('../models/db');
const { etDateString, addETDays } = require('../utils/datetime-et');

const app = express();
app.use('/api/property', require('../routes/property'));
app.use((_err, _req, res, _next) => res.status(500).json({ error: 'Unavailable' }));

const day = (offset) => etDateString(addETDays(new Date(), offset));
let server;
let base;
beforeAll(async () => {
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });
beforeEach(() => {
  jest.clearAllMocks();
  db._state.row = null;
});
afterEach(() => { delete process.env.GATE_AWAY_WATCH; });

async function call(method, body) {
  const response = await fetch(`${base}/api/property/preferences`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json() };
}
const stored = () => ({ id: 'pref-1', customer_id: 'cust-1', created_at: 'x', parking_notes: 'Driveway', away_watch_from: new Date(`${day(1)}T00:00:00Z`), away_watch_until: day(30) });

describe('gate off', () => {
  test('GET never returns the dates or the flag, with or without a row', async () => {
    db._state.row = stored();
    const { body } = await call('GET');
    expect(body.preferences).toMatchObject({ parkingNotes: 'Driveway' });
    expect(body.preferences).not.toHaveProperty('awayWatchFrom');
    expect(body.preferences).not.toHaveProperty('awayWatchUntil');
    expect(body).not.toHaveProperty('awayWatchEnabled');
    db._state.row = null;
    expect(await call('GET')).toMatchObject({ body: { preferences: expect.not.objectContaining({ awayWatchFrom: expect.anything() }) } });
    expect((await call('GET')).body).not.toHaveProperty('awayWatchEnabled');
  });

  test('PUT ignores the dates like an unknown field: alone it is a 400 with nothing stored, beside a valid field only that one saves', async () => {
    expect(await call('PUT', { awayWatchFrom: day(1), awayWatchUntil: day(30) })).toMatchObject({ status: 400, body: { error: 'No valid fields to update' } });
    expect(db._state.row).toBeNull();
    const { status, body } = await call('PUT', { awayWatchFrom: day(1), awayWatchUntil: day(30), parkingNotes: 'Driveway' });
    expect(status).toBe(200);
    expect(body.rejected).toBeUndefined();
    expect(body.preferences).not.toHaveProperty('awayWatchFrom');
    expect(db._state.row.away_watch_from).toBeUndefined();
    expect(db._state.row.parking_notes).toBe('Driveway');
  });
});

describe('gate on', () => {
  beforeEach(() => { process.env.GATE_AWAY_WATCH = 'true'; });

  test('GET carries the flag (also with no row) and the days as plain ET day strings', async () => {
    db._state.row = stored();
    const { body } = await call('GET');
    expect(body.awayWatchEnabled).toBe(true);
    expect(body.preferences).toMatchObject({ awayWatchFrom: day(1), awayWatchUntil: day(30) });
    db._state.row = null;
    expect((await call('GET')).body.awayWatchEnabled).toBe(true);
  });

  test('PUT saves the pair together, and a clear stores two nulls', async () => {
    const saved = await call('PUT', { awayWatchFrom: day(1), awayWatchUntil: day(30) });
    expect(saved.status).toBe(200);
    expect(saved.body.preferences).toMatchObject({ awayWatchFrom: day(1), awayWatchUntil: day(30) });
    expect(db._state.row).toMatchObject({ away_watch_from: day(1), away_watch_until: day(30) });
    expect((await call('PUT', { awayWatchFrom: null, awayWatchUntil: null })).status).toBe(200);
    expect(db._state.row).toMatchObject({ away_watch_from: null, away_watch_until: null });
  });

  test('a lone date is refused with a message on awayWatchUntil; the rest of the batch still saves and no date is stored', async () => {
    const { status, body } = await call('PUT', { awayWatchFrom: day(1), parkingNotes: 'Driveway' });
    expect(status).toBe(200);
    expect(body.rejected).toEqual([{ field: 'awayWatchFrom', message: 'Away dates must be set or cleared together.' }, { field: 'awayWatchUntil', message: 'Away dates must be set or cleared together.' }]);
    expect(db._state.row.parking_notes).toBe('Driveway');
    expect(db._state.row.away_watch_from).toBeUndefined();
  });

  test('a batch of only a bad pair is a 400 with the reason and nothing stored', async () => {
    const { status, body } = await call('PUT', { awayWatchFrom: day(10), awayWatchUntil: day(5) });
    expect(status).toBe(400);
    // Both dates are named, so the app never re-queues one of them alone.
    expect(body.rejected.map((r) => r.field)).toEqual(['awayWatchFrom', 'awayWatchUntil']);
    expect(db._state.row).toBeNull();
  });

  test('a non-member gets no flag and no days, and a non-member\'s dates are stripped, never stored', async () => {
    mockSession.customer = { id: 'cust-1', waveguard_tier: null, monthly_rate: 0, lawn_type: null };
    try {
      const get = await call('GET');
      expect(get.body).not.toHaveProperty('awayWatchEnabled');
      expect(get.body.preferences || {}).not.toHaveProperty('awayWatchFrom');
      const put = await call('PUT', { awayWatchFrom: day(1), awayWatchUntil: day(30), parkingNotes: 'Driveway' });
      expect(put.status).toBe(200);
      expect(db._state.row.away_watch_from).toBeUndefined();
      expect(db._state.row.away_watch_until).toBeUndefined();
      expect(put.body.preferences).not.toHaveProperty('awayWatchFrom');
    } finally { mockSession.customer = MEMBER; }
  });
});
