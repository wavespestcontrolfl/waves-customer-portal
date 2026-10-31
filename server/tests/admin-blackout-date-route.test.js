/**
 * POST /admin/schedule/blackout-dates: Settings → Scheduling "Block day".
 * A day the calendar does not have (2026-02-31, 2026-13-01) is a 400 before
 * any write. The old shape-only check let it reach the date insert, and the
 * Postgres date error came back as a 500 (settings audit SET-02). DELETE
 * /blackout-dates/:id answers a malformed id with the not-found 404 instead
 * of the uuid column's 500. Drives the handlers on router.stack against a
 * mocked db, like admin-departure-time-route.test.js.
 */
const mockState = { transactions: 0, inserts: [], existing: null, deletes: 0 };
const mockDb = jest.fn(() => {
  const q = {};
  q.where = jest.fn(() => q);
  q.first = jest.fn(async () => undefined);
  return q;
});
mockDb.fn = { now: jest.fn(() => 'NOW') };
mockDb.transaction = jest.fn(async (work) => {
  mockState.transactions += 1;
  const trx = jest.fn((table) => {
    const q = {};
    q.insert = jest.fn((row) => { mockState.inserts.push({ table, row }); return q; });
    q.onConflict = jest.fn(() => q);
    q.merge = jest.fn(() => q);
    q.returning = jest.fn(async () => {
      const { row } = mockState.inserts[mockState.inserts.length - 1];
      return [{ id: 'blackout-1', date: row.date, reason: row.reason }];
    });
    q.where = jest.fn(() => q);
    q.first = jest.fn(async () => mockState.existing);
    q.del = jest.fn(async () => {
      if (!mockState.existing) return 0;
      mockState.deletes += 1;
      return 1;
    });
    return q;
  });
  trx.raw = jest.fn(async () => undefined);
  trx.isTransaction = true;
  return work(trx);
});
jest.mock('../models/db', () => mockDb);
jest.mock('../services/estimate-slot-availability', () => ({ invalidateAllEstimates: jest.fn() }));
jest.mock('../services/scheduling/quality-after-change', () => ({
  refreshScheduleQualityAfterChange: jest.fn(async () => undefined),
}));

const adminScheduleRouter = require('../routes/admin-schedule');

function handlerFor(method, path) {
  const layer = adminScheduleRouter.stack.find(
    (l) => l.route && l.route.path === path && l.route.methods[method],
  );
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

async function call(method, path, { body = {}, params = {} } = {}) {
  const req = { body, params, query: {}, headers: {} };
  const res = {
    statusCode: 200,
    body: undefined,
    status: jest.fn(function status(c) { this.statusCode = c; return this; }),
    json: jest.fn(function json(b) { this.body = b; return this; }),
  };
  const next = jest.fn();
  await handlerFor(method, path)(req, res, next);
  return { res, next };
}

const post = (body) => call('post', '/blackout-dates', { body });
const remove = (id) => call('delete', '/blackout-dates/:id', { params: { id } });

beforeEach(() => {
  mockState.transactions = 0;
  mockState.inserts = [];
  mockState.existing = null;
  mockState.deletes = 0;
  jest.clearAllMocks();
});

describe('POST /blackout-dates date check', () => {
  it.each([
    ['February 31', '2026-02-31'],
    ['month 13', '2026-13-01'],
    ['February 29 in a common year', '2026-02-29'],
    ['month 00', '2026-00-10'],
    ['day 00', '2026-03-00'],
    ['year 0000', '0000-01-01'],
    ['an unpadded date', '2026-2-3'],
    ['a timestamp', '2026-02-28T00:00:00Z'],
    ['an empty string', ''],
    ['a number', 20260228],
    ['missing', undefined],
  ])('refuses %s with a 400 and writes nothing', async (_label, date) => {
    const { res, next } = await post(date === undefined ? {} : { date });
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'date must be a calendar date (YYYY-MM-DD)' });
    expect(next).not.toHaveBeenCalled();
    expect(mockState.transactions).toBe(0);
    expect(mockState.inserts).toHaveLength(0);
  });

  it('blocks a real day, trimmed, with its reason', async () => {
    const { res, next } = await post({ date: ' 2026-02-28 ', reason: 'Vacation' });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, blackout: { id: 'blackout-1', date: '2026-02-28', reason: 'Vacation' } });
    expect(mockState.inserts).toEqual([
      { table: 'schedule_blackout_dates', row: { date: '2026-02-28', reason: 'Vacation' } },
    ]);
  });

  it('accepts February 29 in a leap year', async () => {
    const { res } = await post({ date: '2028-02-29' });
    expect(res.statusCode).toBe(200);
    expect(res.body.blackout).toEqual({ id: 'blackout-1', date: '2028-02-29', reason: null });
  });
});

describe('DELETE /blackout-dates/:id', () => {
  it.each([
    ['a word', 'not-a-uuid'],
    ['a number', '42'],
    ['a uuid with a trailing character', '0b9f2a4e-6c1d-4f7a-9e3b-2d5c8a1f6e40x'],
  ])('answers %s with the not-found 404 and opens no transaction', async (_label, id) => {
    const { res, next } = await remove(id);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
    expect(mockState.transactions).toBe(0);
  });

  it('removes a stored day', async () => {
    mockState.existing = { date: '2026-02-28' };
    const { res, next } = await remove('0b9f2a4e-6c1d-4f7a-9e3b-2d5c8a1f6e40');
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(mockState.deletes).toBe(1);
  });

  it('answers an unknown well-formed id with 404', async () => {
    const { res } = await remove('0b9f2a4e-6c1d-4f7a-9e3b-2d5c8a1f6e40');
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
    expect(mockState.transactions).toBe(1);
  });
});
