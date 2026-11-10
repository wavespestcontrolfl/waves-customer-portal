/**
 * GATE_DAY_ONLY_PROMISE part C1: the customer app/portal schedule payloads (routes/schedule.js).
 * loadTimeDisplay (part B1) is mocked: it is the one decision. Each payload asks it ONCE.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const mockLoadTimeDisplay = jest.fn();
jest.mock('../services/time-promise', () => ({ loadTimeDisplay: (...args) => mockLoadTimeDisplay(...args) }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({ id: 'notif-1' })) }));
jest.mock('../services/request-app-notifications', () => ({ send: jest.fn(async () => ({})) }));
jest.mock('../services/cancellation-eligibility', () => ({ hasCancellableWork: jest.fn(async () => true) }));
jest.mock('../services/account-properties', () => ({
  ...jest.requireActual('../services/account-properties'),
  accountPropertyIds: jest.fn(async () => ['cust-1', 'cust-2']),
}));
jest.mock('../middleware/auth', () => ({
  ...jest.requireActual('../middleware/auth'),
  authenticate: (req, _res, next) => {
    req.customerId = 'cust-1';
    req.customer = { id: 'cust-1', account_id: 'cust-1', active: true };
    next();
  },
}));

const express = require('express');
const db = require('../models/db');
const scheduleRouter = require('../routes/schedule');

function chain(rows) {
  const c = {};
  for (const m of ['where', 'whereIn', 'whereNull', 'whereNot', 'whereNotIn', 'orWhere', 'orWhereNot', 'orWhereNotIn', 'orWhereNotNull', 'whereRaw', 'leftJoin', 'select', 'orderBy', 'limit', 'forUpdate']) {
    c[m] = jest.fn((arg) => { if (typeof arg === 'function') arg.call(c, c); return c; });
  }
  c.first = jest.fn(async () => rows[0]);
  c.update = jest.fn(async () => 1);
  c.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
  return c;
}

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/schedule', scheduleRouter);
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  const server = app.listen(0);
  try { await fn(`http://127.0.0.1:${server.address().port}`); } finally { await new Promise((r) => server.close(r)); }
}

const get = async (path) => {
  let body;
  await withServer(async (base) => { body = await (await fetch(`${base}/schedule${path}`)).json(); });
  if (body && body.error) throw new Error(`route answered: ${body.error}`);
  return body;
};

const visit = (id, overrides = {}) => ({
  id,
  customer_id: 'cust-1',
  scheduled_date: '2099-01-12',
  window_start: '09:00:00',
  window_end: '11:00:00',
  service_type: 'Pest Control',
  status: 'pending',
  customer_confirmed: false,
  reschedule_token: `tok-${id}`,
  customer_pick_by: null,
  ...overrides,
});

// loadTimeDisplay's answer: ids listed are day-only (showHour false), every other row shows its hour.
function dayOnly(...ids) {
  mockLoadTimeDisplay.mockImplementation(async (_conn, rows) => new Map(rows.map((r) => [
    r.id, { showHour: !ids.includes(r.id), level: 'none', eligible: ids.includes(r.id) },
  ])));
}

const NOTE = 'Arrival window texted the day before';
const prevGate = process.env.GATE_APPOINTMENT_PAGE;

describe('customer schedule payloads, day-only', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.GATE_APPOINTMENT_PAGE = 'true';
  });
  afterAll(() => {
    if (prevGate === undefined) delete process.env.GATE_APPOINTMENT_PAGE; else process.env.GATE_APPOINTMENT_PAGE = prevGate;
  });

  describe('GET /schedule', () => {
    const rows = () => [visit('svc-day'), visit('svc-picked')];

    test('gate on: the day-only visit has no hour and carries the note; a customer-picked visit keeps its hour; ONE bulk call', async () => {
      dayOnly('svc-day');
      db.mockReturnValueOnce(chain(rows()));
      const body = await get('');
      expect(mockLoadTimeDisplay).toHaveBeenCalledTimes(1);
      expect(mockLoadTimeDisplay.mock.calls[0][1].map((r) => r.id)).toEqual(['svc-day', 'svc-picked']);
      const [day, picked] = body.upcoming;
      expect(day).toMatchObject({ id: 'svc-day', date: '2099-01-12', windowStart: null, windowEnd: null, day_only: true, arrival_note: NOTE });
      expect(JSON.stringify(day)).not.toMatch(/09:00|11:00/);
      expect(picked).toMatchObject({ id: 'svc-picked', windowStart: '09:00:00', windowEnd: '11:00:00' });
      expect(picked).not.toHaveProperty('day_only');
      expect(picked).not.toHaveProperty('arrival_note');
    });

    test('the calendar link stays offered, and its expiry carries the end of the day, not the window end', async () => {
      dayOnly('svc-day');
      db.mockReturnValueOnce(chain(rows()));
      const [day, picked] = (await get('')).upcoming;
      expect(day.calendarUrl).toBe('/api/public/appointment/tok-svc-day/calendar.ics');
      // 2099-01-12 23:59 ET (EST) = 2099-01-13 04:59 UTC.
      expect(day.calendarExpiresAt).toBe('2099-01-13T04:59:00.000Z');
      expect(picked.calendarExpiresAt).toBe('2099-01-12T16:00:00.000Z');
    });

    test('gate off (every row shows its hour): byte-for-byte today, no new key', async () => {
      dayOnly();
      db.mockReturnValueOnce(chain(rows()));
      const body = await get('');
      for (const v of body.upcoming) {
        expect(v.windowStart).toBe('09:00:00');
        expect(v.windowEnd).toBe('11:00:00');
        expect(Object.keys(v)).not.toEqual(expect.arrayContaining(['day_only']));
        expect(Object.keys(v)).not.toEqual(expect.arrayContaining(['arrival_note']));
      }
      expect(body.upcoming[0].calendarExpiresAt).toBe('2099-01-12T16:00:00.000Z');
    });

    test('inside the cutoff (loadTimeDisplay says show the hour): the hour is shown', async () => {
      dayOnly();
      db.mockReturnValueOnce(chain([visit('svc-soon')]));
      expect((await get('')).upcoming[0]).toMatchObject({ windowStart: '09:00:00' });
    });

    test('a loadTimeDisplay failure shows the hour and the list still answers', async () => {
      mockLoadTimeDisplay.mockRejectedValue(new Error('db down'));
      db.mockReturnValueOnce(chain(rows()));
      const body = await get('');
      expect(body.upcoming.map((v) => v.windowStart)).toEqual(['09:00:00', '09:00:00']);
    });

    test('the coverage-only projection (allProperties) is blanked the same way, with one call', async () => {
      dayOnly('svc-day');
      db.mockReturnValueOnce(chain(rows()));
      const body = await get('?allProperties=true');
      expect(mockLoadTimeDisplay).toHaveBeenCalledTimes(1);
      expect(body.coverageOnly).toBe(true);
      expect(body.upcoming[0]).toMatchObject({ windowStart: null, windowEnd: null, day_only: true, arrival_note: NOTE });
      expect(body.upcoming[1]).toMatchObject({ windowStart: '09:00:00' });
    });
  });

  describe('GET /schedule/next', () => {
    test('day-only: no hour, note, one call', async () => {
      dayOnly('svc-day');
      db.mockReturnValueOnce(chain([visit('svc-day')]));
      const { next } = await get('/next');
      expect(mockLoadTimeDisplay).toHaveBeenCalledTimes(1);
      expect(next).toMatchObject({ id: 'svc-day', windowStart: null, windowEnd: null, day_only: true, arrival_note: NOTE });
      expect(next.calendarExpiresAt).toBe('2099-01-13T04:59:00.000Z');
    });

    test('customer-picked or gate off: the hour stays and nothing is added', async () => {
      dayOnly();
      db.mockReturnValueOnce(chain([visit('svc-picked')]));
      const { next } = await get('/next');
      expect(next).toMatchObject({ windowStart: '09:00:00', windowEnd: '11:00:00' });
      expect(next).not.toHaveProperty('day_only');
    });

    test('the coverage-only /next is blanked too', async () => {
      dayOnly('svc-day');
      db.mockReturnValueOnce(chain([visit('svc-day')]));
      const { next } = await get('/next?allProperties=true');
      expect(next).toMatchObject({ windowStart: null, windowEnd: null, day_only: true });
    });
  });

  describe('GET /schedule/account-next', () => {
    test('one bulk call for the visits shown; the day-only one has no hour', async () => {
      dayOnly('svc-a');
      db.mockImplementation((table) => {
        if (table === 'customers') return chain([
          { id: 'cust-1', profile_label: 'Home', is_primary_profile: true }, { id: 'cust-2', profile_label: 'Rental', is_primary_profile: false },
        ]);
        return chain([visit('svc-a', { customer_id: 'cust-1' }), visit('svc-b', { customer_id: 'cust-2' })]);
      });
      const body = await get('/account-next');
      expect(mockLoadTimeDisplay).toHaveBeenCalledTimes(1);
      const [home, rental] = body.properties;
      expect(home.next).toMatchObject({ id: 'svc-a', windowStart: null, windowEnd: null, day_only: true, arrival_note: NOTE });
      expect(rental.next).toMatchObject({ id: 'svc-b', windowStart: '09:00:00' });
      expect(rental.next).not.toHaveProperty('day_only');
    });
  });

  describe('POST /schedule/:id/confirm of a day-only visit', () => {
    const row = {
      id: 'svc-day', status: 'pending', source_action: null, customer_confirmed: false,
      scheduled_date: new Date('2099-01-12T00:00:00.000Z'), window_start: '09:00:00',
    };
    const post = async (body) => {
      let out;
      await withServer(async (base) => {
        const res = await fetch(`${base}/schedule/svc-day/confirm`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        });
        out = { status: res.status, body: await res.json() };
      });
      return out;
    };

    test('the blank hour the day-only app echoes still confirms the visit\'s current slot', async () => {
      dayOnly('svc-day');
      const update = chain([]);
      db.mockReturnValueOnce(chain([row])).mockReturnValueOnce(update);
      const out = await post({ date: '2099-01-12T00:00:00.000Z', windowStart: null });
      expect(out).toEqual({ status: 200, body: { success: true, message: 'Appointment confirmed' } });
      expect(update.where).toHaveBeenCalledWith(expect.objectContaining({ id: 'svc-day', window_start: '09:00:00' }));
    });

    test('a blank hour for a visit that now shows its hour (past the cutoff) is refused, so the app reloads', async () => {
      dayOnly();
      db.mockReturnValueOnce(chain([row]));
      const out = await post({ date: '2099-01-12T00:00:00.000Z', windowStart: null });
      expect(out.status).toBe(409);
    });

    test('a blank hour on another day is refused', async () => {
      dayOnly('svc-day');
      db.mockReturnValueOnce(chain([row]));
      const out = await post({ date: '2099-01-13T00:00:00.000Z', windowStart: null });
      expect(out.status).toBe(409);
    });
  });
});
