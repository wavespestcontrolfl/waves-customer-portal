process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({ id: 'notif-1' })) }));
jest.mock('../services/cancellation-eligibility', () => ({ hasCancellableWork: jest.fn(async () => true) }));
jest.mock('../services/account-properties', () => ({ accountPropertyIds: jest.fn(async () => ['cust-1', 'cust-2', 'cust-3']) }));
jest.mock('../middleware/auth', () => ({
  authenticate: (req, _res, next) => {
    req.customerId = 'cust-2';
    req.customer = { id: 'cust-2', account_id: 'cust-1' };
    next();
  },
}));

const express = require('express');
const db = require('../models/db');
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

const PROPERTIES = [
  { id: 'cust-1', profile_label: 'Home', is_primary_profile: true, address_line1: '1200 Palm Row Ct', address_line2: null, city: 'Parrish', state: 'FL', zip: '34219' },
  { id: 'cust-2', profile_label: 'Rental - Oak Ave', is_primary_profile: false, address_line1: '418 Oak Ave', address_line2: null, city: 'Bradenton', state: 'FL', zip: '34205' },
  { id: 'cust-3', profile_label: null, is_primary_profile: false, address_line1: '77 Pine Ct', address_line2: null, city: 'Palmetto', state: 'FL', zip: '34221' },
];
// Ordered the way the route asks the DB for them (date asc, window asc):
// cust-1 has two rows → only the first counts; cust-3 has none.
const VISITS = [
  { id: 'svc-a', customer_id: 'cust-1', scheduled_date: '2099-01-05', window_start: '09:00:00', window_end: '11:00:00', service_type: 'Quarterly Pest Control', status: 'confirmed', customer_confirmed: true },
  { id: 'svc-b', customer_id: 'cust-2', scheduled_date: '2099-01-20', window_start: '13:00:00', window_end: '15:00:00', service_type: 'Lawn Care Program', status: 'pending', customer_confirmed: false },
  { id: 'svc-c', customer_id: 'cust-1', scheduled_date: '2099-02-01', window_start: '09:00:00', window_end: '11:00:00', service_type: 'Lawn Care Program', status: 'pending', customer_confirmed: false },
];

describe('GET /schedule/account-next — every property on the account with its next visit', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.mockImplementation((table) => {
      if (table === 'customers') return chain(PROPERTIES);
      if (table === 'scheduled_services') return chain(VISITS);
      throw new Error(`unexpected table ${table}`);
    });
  });

  test('one row per property, primary first, earliest visit wins, null when nothing is scheduled', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/schedule/account-next`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.properties.map((p) => p.id)).toEqual(['cust-1', 'cust-2', 'cust-3']);
      const [home, oak, pine] = body.properties;
      expect(home.isPrimaryProfile).toBe(true);
      expect(home.profileLabel).toBe('Home');
      expect(home.address).toEqual({ line1: '1200 Palm Row Ct', line2: null, city: 'Parrish', state: 'FL', zip: '34219' });
      expect(home.next).toMatchObject({ id: 'svc-a', date: '2099-01-05', windowStart: '09:00:00', windowEnd: '11:00:00', status: 'confirmed', customerConfirmed: true });
      expect(oak.next).toMatchObject({ id: 'svc-b', date: '2099-01-20', customerConfirmed: false });
      expect(pine.profileLabel).toBe('Service property');
      expect(pine.next).toBeNull();
    });
  });

  test('reads only the account\'s property ids and only live upcoming statuses', async () => {
    await withServer(async (base) => {
      await fetch(`${base}/schedule/account-next`);
      const calls = db.mock.calls.map((c) => c[0]);
      expect(calls).toEqual(expect.arrayContaining(['customers', 'scheduled_services']));
      const visitsChain = db.mock.results.find((r, i) => calls[i] === 'scheduled_services').value;
      expect(visitsChain.whereIn).toHaveBeenCalledWith('scheduled_services.customer_id', ['cust-1', 'cust-2', 'cust-3']);
      expect(visitsChain.whereIn).toHaveBeenCalledWith('scheduled_services.status', ['pending', 'confirmed']);
      // Same horizon as GET / — a lower AND an upper date bound.
      const dateBounds = visitsChain.where.mock.calls.filter((c) => c[0] === 'scheduled_services.scheduled_date').map((c) => c[1]);
      expect(dateBounds.sort()).toEqual(['<=', '>=']);
    });
  });

  test('rejects a horizon outside the list route\'s bounds', async () => {
    await withServer(async (base) => {
      expect((await fetch(`${base}/schedule/account-next?days=0`)).status).toBe(400);
      expect((await fetch(`${base}/schedule/account-next?days=400`)).status).toBe(400);
    });
  });

  test('the payload carries no staff-only columns', async () => {
    await withServer(async (base) => {
      const body = await (await fetch(`${base}/schedule/account-next`)).json();
      for (const p of body.properties) {
        expect(Object.keys(p).sort()).toEqual(['address', 'id', 'isPrimaryProfile', 'next', 'profileLabel']);
        if (p.next) expect(Object.keys(p.next).sort()).toEqual(['customerConfirmed', 'date', 'id', 'serviceType', 'status', 'windowEnd', 'windowStart']);
      }
    });
  });
});
