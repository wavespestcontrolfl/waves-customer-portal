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
  for (const method of ['where', 'whereIn', 'whereNull', 'whereNot', 'whereNotIn', 'orWhere', 'orWhereNot', 'orWhereNotIn', 'leftJoin', 'select', 'orderBy']) {
    chain[method] = jest.fn(() => chain);
  }
  chain.first = jest.fn(async () => rows[0]);
  chain.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
  return chain;
}

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/schedule', scheduleRouter);
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  const server = app.listen(0);
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe('GET /schedule hides staff notes from the customer payload', () => {
  beforeEach(() => jest.clearAllMocks());

  const row = {
    id: 'svc-1',
    scheduled_date: '2099-01-05',
    window_start: '08:00:00',
    window_end: '10:00:00',
    service_type: 'Pest Control',
    status: 'confirmed',
    technician_name: 'Adam',
    customer_confirmed: true,
    confirmed_at: '2098-12-30T12:00:00Z',
    notes: 'Square rebooking cleanup. $67.50 per visit. route_density: moved from 08:00. No SMS sent.',
    is_recurring: true,
    is_callback: false,
    reschedule_token: 'tok-1',
  };

  test('upcoming rows omit notes entirely while keeping the visit fields', async () => {
    db.mockReturnValueOnce(listChain([row]));

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/schedule`);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.upcoming).toHaveLength(1);
      const visit = body.upcoming[0];
      expect('notes' in visit).toBe(false);
      expect(JSON.stringify(body)).not.toContain('Square rebooking');
      expect(visit).toMatchObject({
        id: 'svc-1',
        date: '2099-01-05',
        status: 'confirmed',
        technician: 'Adam',
        customerConfirmed: true,
        rescheduleUrl: '/reschedule/tok-1',
      });
    });
  });

  test('the next-visit endpoint stays notes-free too', async () => {
    db.mockReturnValueOnce(listChain([row]));

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/schedule/next`);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect('notes' in body.next).toBe(false);
      expect(JSON.stringify(body)).not.toContain('Square rebooking');
    });
  });
});
