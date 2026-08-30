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
    notes: 'Legacy rebooking cleanup. $67.50 per visit. route_density: moved from 08:00. No SMS sent.',
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
      expect(JSON.stringify(body)).not.toContain('Legacy rebooking');
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
      expect(JSON.stringify(body)).not.toContain('Legacy rebooking');
    });
  });
});

test('a GROUPED upcoming visit carries no rescheduleUrl (the self-serve page would refuse it, codex #3609 r25 P2); an ungrouped row keeps its link', async () => {
  const rows = [
    { id: 'svc-g', scheduled_date: '2099-01-15', window_start: '09:00:00', window_end: '10:00:00', status: 'confirmed', reschedule_token: 'tok-g', visit_id: 'visit-1' },
    { id: 'svc-u', scheduled_date: '2099-01-16', window_start: '09:00:00', window_end: '10:00:00', status: 'confirmed', reschedule_token: 'tok-u', visit_id: null },
  ];
  const listChainRows = listChain(rows);
  const countChain = { where: jest.fn(() => countChain), whereNotIn: jest.fn(() => countChain), count: jest.fn(() => countChain), first: jest.fn(async () => ({ n: 2 })) };
  // openMembers (groupedCalendarBlocked): a sibling awaiting rebook ⇒ the ICS route would 404 ⇒ no calendar link either
  const membersChain = { where: jest.fn(() => membersChain), whereNotIn: jest.fn(() => membersChain), select: jest.fn(async () => [{ id: 'svc-g', status: 'confirmed' }, { id: 'svc-s', status: 'rescheduled' }]) };
  let calls = 0;
  db.mockImplementation(() => { calls += 1; return calls === 1 ? listChainRows : calls === 2 ? countChain : membersChain; });
  const prevGate = process.env.GATE_APPOINTMENT_PAGE;
  process.env.GATE_APPOINTMENT_PAGE = 'true';
  try {
    await withServer(async (base) => {
      const res = await fetch(`${base}/schedule`);
      const body = await res.json();
      expect(res.status).toBe(200);
      const g = body.upcoming.find((v) => v.id === 'svc-g');
      const u = body.upcoming.find((v) => v.id === 'svc-u');
      expect(g.rescheduleUrl).toBe(null);
      expect(g.calendarUrl).toBe(null);
      expect(g.calendarExpiresAt).toBe(null);
      expect(u.rescheduleUrl).toBe('/reschedule/tok-u');
      expect(u.calendarUrl).toBe('/api/public/appointment/tok-u/calendar.ics');
    });
  } finally {
    if (prevGate === undefined) delete process.env.GATE_APPOINTMENT_PAGE; else process.env.GATE_APPOINTMENT_PAGE = prevGate;
  }
});
