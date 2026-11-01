process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({ id: 'notif-1' })) }));
jest.mock('../services/cancellation-eligibility', () => ({ hasCancellableWork: jest.fn(async () => true) }));
jest.mock('../middleware/auth', () => ({
  authenticate: (req, _res, next) => {
    req.customerId = 'cust-1';
    req.customer = { id: 'cust-1', first_name: 'Pat', last_name: 'Customer' };
    next();
  },
}));

const express = require('express');
const db = require('../models/db');
const scheduleRouter = require('../routes/schedule');

// Awaitable knex-style chain: every builder call returns the chain, and
// awaiting it resolves to the supplied rows.
function listChain(rows) {
  const chain = {};
  for (const method of ['where', 'whereIn', 'whereNull', 'whereNot', 'whereNotIn', 'orWhere', 'orWhereNot', 'orWhereNotIn', 'whereRaw', 'leftJoin', 'select', 'orderBy']) {
    chain[method] = jest.fn(() => chain);
  }
  chain.first = jest.fn(async () => rows[0]);
  chain.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
  return chain;
}

async function withServer(fn) {
  const app = express();
  app.use('/schedule', scheduleRouter);
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  const server = app.listen(0);
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const PICK_BY = new Date('2099-01-07T01:00:00Z');

function visit(overrides) {
  return {
    id: 'svc-1',
    scheduled_date: '2099-01-12',
    window_start: null,
    window_end: null,
    service_type: 'Pest Control',
    status: 'pending',
    customer_confirmed: false,
    reschedule_token: 'tok-1',
    customer_pick_by: null,
    ...overrides,
  };
}

describe('customerPickBy on the customer schedule payload', () => {
  beforeEach(() => jest.clearAllMocks());

  test('GET /schedule sets it only for a visit waiting on the customer pick', async () => {
    const rows = [
      visit({ id: 'svc-wait', customer_pick_by: PICK_BY }),
      // Auto-Dispatch placed it after the pick-by: the marker stays, the window is set.
      visit({ id: 'svc-placed', customer_pick_by: PICK_BY, window_start: '09:00:00', window_end: '11:00:00' }),
      // An ordinary windowless visit, and an ordinary timed one.
      visit({ id: 'svc-plain' }),
      visit({ id: 'svc-timed', window_start: '09:00:00', window_end: '11:00:00' }),
    ];
    db.mockReturnValueOnce(listChain(rows));
    await withServer(async (base) => {
      const body = await (await fetch(`${base}/schedule`)).json();
      const byId = Object.fromEntries(body.upcoming.map((v) => [v.id, v]));
      expect(byId['svc-wait'].customerPickBy).toBe('2099-01-07T01:00:00.000Z');
      expect(byId['svc-wait'].rescheduleUrl).toBe('/reschedule/tok-1');
      expect(byId['svc-placed'].customerPickBy).toBeNull();
      expect(byId['svc-plain'].customerPickBy).toBeNull();
      expect(byId['svc-timed'].customerPickBy).toBeNull();
    });
  });

  test('accepts an ISO string marker too', async () => {
    db.mockReturnValueOnce(listChain([visit({ customer_pick_by: '2099-01-07T01:00:00.000Z' })]));
    await withServer(async (base) => {
      const body = await (await fetch(`${base}/schedule`)).json();
      expect(body.upcoming[0].customerPickBy).toBe('2099-01-07T01:00:00.000Z');
    });
  });

  test('GET /schedule/next follows the same rule', async () => {
    db.mockReturnValueOnce(listChain([visit({ customer_pick_by: PICK_BY })]));
    await withServer(async (base) => {
      const body = await (await fetch(`${base}/schedule/next`)).json();
      expect(body.next.customerPickBy).toBe('2099-01-07T01:00:00.000Z');
    });
    db.mockReturnValueOnce(listChain([visit({ customer_pick_by: PICK_BY, window_start: '09:00:00' })]));
    await withServer(async (base) => {
      const body = await (await fetch(`${base}/schedule/next`)).json();
      expect(body.next.customerPickBy).toBeNull();
    });
  });
});
