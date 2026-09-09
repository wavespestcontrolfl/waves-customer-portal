/**
 * GET /schedule/properties-next (GATE_APP_PROPERTY_SCOPE) — one row per
 * unified (profile, saved property) entry with that entry's next visit,
 * assigned by the visit rule; 404 while the gate is off.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({ id: 'notif-1' })) }));
jest.mock('../services/cancellation-eligibility', () => ({ hasCancellableWork: jest.fn(async () => true) }));
jest.mock('../services/account-properties', () => {
  const actual = jest.requireActual('../services/account-properties');
  return {
    ...actual,
    appPropertyScopeEnabled: jest.fn(() => true),
    accountSavedProperties: jest.fn(async () => ({ properties: global.__ENTRIES__, selected: null })),
    resolveSessionScope: jest.fn(async () => ({ customerId: 'cust-1', enabled: false, multi: false, property: null })),
  };
});
jest.mock('../middleware/auth', () => ({
  authenticate: (req, _res, next) => {
    req.customerId = 'cust-1';
    req.customer = { id: 'cust-1', account_id: 'acct-1', active: true };
    next();
  },
}));

const express = require('express');
const db = require('../models/db');
const { appPropertyScopeEnabled } = require('../services/account-properties');
const scheduleRouter = require('../routes/schedule');

function chain(rows) {
  const c = {};
  for (const m of ['where', 'whereIn', 'whereNull', 'whereNot', 'whereNotIn', 'orWhere', 'orWhereNot', 'orWhereNotIn', 'leftJoin', 'select', 'orderBy', 'limit']) {
    c[m] = jest.fn((arg) => { if (typeof arg === 'function') arg.call(c, c); return c; });
  }
  c.first = jest.fn(async () => rows[0]);
  c.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
  return c;
}

async function withServer(fn) {
  const app = express();
  app.use('/schedule', scheduleRouter);
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  const server = app.listen(0);
  try { await fn(`http://127.0.0.1:${server.address().port}`); } finally { await new Promise((r) => server.close(r)); }
}

// One profile with three saved properties + a sibling rental profile with one.
const ENTRIES = [
  { key: 'cust-1:prop-a', customerId: 'cust-1', propertyId: 'prop-a', isPrimaryProfile: true, isPrimaryProperty: true },
  { key: 'cust-1:prop-b', customerId: 'cust-1', propertyId: 'prop-b', isPrimaryProfile: true, isPrimaryProperty: false },
  { key: 'cust-1:prop-c', customerId: 'cust-1', propertyId: 'prop-c', isPrimaryProfile: true, isPrimaryProperty: false },
  { key: 'cust-9:prop-z', customerId: 'cust-9', propertyId: 'prop-z', isPrimaryProfile: false, isPrimaryProperty: true },
];
// Ordered as the route asks (date asc, window asc).
const VISITS = [
  { id: 'svc-unstamped', customer_id: 'cust-1', property_id: null, scheduled_date: '2099-01-05', window_start: '09:00:00', window_end: '11:00:00', service_type: 'Quarterly Pest Control', status: 'confirmed', customer_confirmed: true },
  { id: 'svc-b', customer_id: 'cust-1', property_id: 'prop-b', scheduled_date: '2099-01-12', window_start: '13:00:00', window_end: '15:00:00', service_type: 'Mosquito Treatment', status: 'pending', customer_confirmed: false },
  { id: 'svc-a-later', customer_id: 'cust-1', property_id: 'prop-a', scheduled_date: '2099-02-01', window_start: '09:00:00', window_end: '11:00:00', service_type: 'Quarterly Pest Control', status: 'confirmed', customer_confirmed: false },
  { id: 'svc-retired', customer_id: 'cust-1', property_id: 'prop-retired', scheduled_date: '2099-02-03', window_start: '09:00:00', window_end: '11:00:00', service_type: 'Lawn', status: 'pending', customer_confirmed: true },
  { id: 'svc-z', customer_id: 'cust-9', property_id: null, scheduled_date: '2099-03-01', window_start: '09:00:00', window_end: '11:00:00', service_type: 'Lawn Care Program', status: 'confirmed', customer_confirmed: true },
];

describe('GET /schedule/properties-next', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.__ENTRIES__ = ENTRIES;
    appPropertyScopeEnabled.mockReturnValue(true);
    db.mockImplementation((table) => {
      if (table === 'scheduled_services') return chain(VISITS);
      throw new Error(`unexpected table ${table}`);
    });
  });

  test('assigns by the visit rule: unstamped → primary entry, stamped → that entry, retired stamp → nobody; lone-entry profile owns its visits', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/schedule/properties-next`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.properties.map((p) => p.key)).toEqual(['cust-1:prop-a', 'cust-1:prop-b', 'cust-1:prop-c', 'cust-9:prop-z']);
      const [a, b, c, z] = body.properties;
      // The primary's FIRST visit is the unstamped 01-05 row, not its own later stamped one.
      expect(a.next).toMatchObject({ id: 'svc-unstamped', date: '2099-01-05', windowStart: '09:00:00', serviceType: 'Pest Control', status: 'confirmed', customerConfirmed: true }); // normalizeServiceType canonical label
      expect(b.next).toMatchObject({ id: 'svc-b', customerConfirmed: false });
      expect(c.next).toBeNull(); // the retired-property visit belongs to no listed entry
      expect(z.next).toMatchObject({ id: 'svc-z' });
      expect(a).toMatchObject({ customerId: 'cust-1', propertyId: 'prop-a' });
    });
  });

  test('queries every profile on the account once, live statuses only, within the list horizon', async () => {
    await withServer(async (base) => {
      await fetch(`${base}/schedule/properties-next?days=30`);
      const visitsChain = db.mock.results.find((r, i) => db.mock.calls[i][0] === 'scheduled_services').value;
      expect(visitsChain.whereIn).toHaveBeenCalledWith('scheduled_services.customer_id', ['cust-1', 'cust-9']);
      expect(visitsChain.whereIn).toHaveBeenCalledWith('scheduled_services.status', ['pending', 'confirmed']);
      const dateBounds = visitsChain.where.mock.calls.filter((c) => c[0] === 'scheduled_services.scheduled_date').map((c) => c[1]);
      expect(dateBounds.sort()).toEqual(['<=', '>=']);
      // property_id is selected — it drives the assignment.
      expect(visitsChain.select.mock.calls[0]).toEqual(expect.arrayContaining(['scheduled_services.property_id']));
    });
  });

  test('the payload carries only key, ids and the lean next shape', async () => {
    await withServer(async (base) => {
      const body = await (await fetch(`${base}/schedule/properties-next`)).json();
      for (const p of body.properties) {
        expect(Object.keys(p).sort()).toEqual(['customerId', 'key', 'next', 'propertyId']);
        if (p.next) expect(Object.keys(p.next).sort()).toEqual(['customerConfirmed', 'date', 'id', 'serviceType', 'status', 'windowEnd', 'windowStart']);
      }
    });
  });

  test('gate off → 404 and no read at all; a bad horizon → 400', async () => {
    await withServer(async (base) => {
      appPropertyScopeEnabled.mockReturnValue(false);
      expect((await fetch(`${base}/schedule/properties-next`)).status).toBe(404);
      expect(db).not.toHaveBeenCalled();
      appPropertyScopeEnabled.mockReturnValue(true);
      expect((await fetch(`${base}/schedule/properties-next?days=0`)).status).toBe(400);
    });
  });
});
