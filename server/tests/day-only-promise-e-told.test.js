/**
 * GATE_DAY_ONLY_PROMISE part E: what the office sees. time-promise.loadOfficeToldFields reads what each customer was told
 * (ONE bulk loadPromiseLevels read for the open visits of the next 14 days) and the stored "customer asked for this time"
 * choice (ONE bulk read); routes/admin-schedule.js attachOfficeToldFields stamps `told` and `customerAskedTime` on the
 * payload rows. Gate off: no read, no field. Synthetic ids only; nothing is sent.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.setTimeout(30000);

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/auto-dispatch/told-visits', () => ({
  loadPromiseLevels: jest.fn(),
  resolvePromises: jest.fn(),
  loadToldVisitIds: jest.fn(),
}));

const db = require('../models/db');
const { loadPromiseLevels } = require('../services/auto-dispatch/told-visits');
const { loadOfficeToldFields, TOLD_HORIZON_DAYS } = require('../services/time-promise');
const { attachOfficeToldFields } = require('../routes/admin-schedule');

const NOW = new Date('2026-11-10T14:00:00Z'); // Tue 9 AM ET
const row = (id, date, over = {}) => ({ id, scheduled_date: date, status: 'confirmed', ...over });

/** A knex-shaped fake for the one stored-intent read. */
function fakeConn({ stored = [], fail = false } = {}) {
  const calls = [];
  const conn = jest.fn((table) => {
    calls.push(table);
    const chain = {
      whereIn: (col, ids) => { chain.ids = ids.map(String); return chain; },
      select: async () => {
        if (fail) throw new Error('read failed');
        return stored.filter((r) => chain.ids.includes(String(r.id)));
      },
    };
    return chain;
  });
  conn.raw = (sql) => ({ raw: sql });
  conn.calls = calls;
  return conn;
}

const withGate = (value, fn) => async () => {
  const prior = process.env.GATE_DAY_ONLY_PROMISE;
  if (value === undefined) delete process.env.GATE_DAY_ONLY_PROMISE; else process.env.GATE_DAY_ONLY_PROMISE = value;
  try { await fn(); } finally {
    if (prior === undefined) delete process.env.GATE_DAY_ONLY_PROMISE; else process.env.GATE_DAY_ONLY_PROMISE = prior;
  }
};

beforeEach(() => {
  loadPromiseLevels.mockReset();
  loadPromiseLevels.mockImplementation(async (conn, ids) => new Map(ids.map((id) => [id, 'none'])));
});

describe('loadOfficeToldFields', () => {
  test('gate off: an empty map and no read at all', withGate(undefined, async () => {
    const conn = fakeConn();
    const out = await loadOfficeToldFields(conn, [row('s1', '2026-11-12')], NOW);
    expect(out.size).toBe(0);
    expect(conn).not.toHaveBeenCalled();
    expect(loadPromiseLevels).not.toHaveBeenCalled();
  }));

  test('gate on: ONE bulk level read and ONE bulk intent read for the whole payload, levels day/hour/none mapped', withGate('true', async () => {
    loadPromiseLevels.mockResolvedValue(new Map([['s1', 'day'], ['s2', 'hour'], ['s3', 'none']]));
    const conn = fakeConn({ stored: [
      { id: 's1', customer_asked_time: false }, { id: 's2', customer_asked_time: true }, { id: 's3', customer_asked_time: null },
    ] });
    const out = await loadOfficeToldFields(conn, [row('s1', '2026-11-12'), row('s2', '2026-11-13'), row('s3', '2026-11-14')], NOW);
    expect(loadPromiseLevels).toHaveBeenCalledTimes(1);
    expect(loadPromiseLevels.mock.calls[0][1]).toEqual(['s1', 's2', 's3']);
    expect(conn.calls).toEqual(['scheduled_services']);
    expect(out.get('s1')).toEqual({ customerAskedTime: false, told: { level: 'day', dayOnly: true } });
    expect(out.get('s2')).toEqual({ customerAskedTime: true, told: { level: 'hour', dayOnly: false } });
    expect(out.get('s3')).toEqual({ customerAskedTime: null, told: { level: 'none', dayOnly: false } });
  }));

  test('the told horizon is the next 14 days; ended and moved visits are skipped; the intent still comes for every row', withGate('true', async () => {
    expect(TOLD_HORIZON_DAYS).toBe(14);
    const conn = fakeConn({ stored: [{ id: 'far', customer_asked_time: true }, { id: 'past', customer_asked_time: false }] });
    const rows = [
      row('in', '2026-11-24'), row('far', '2026-11-25'), row('past', '2026-11-09'),
      row('done', '2026-11-12', { status: 'completed' }), row('cx', '2026-11-12', { status: 'cancelled' }), row('rs', '2026-11-12', { status: 'rescheduled' }),
      row('camel', undefined, { scheduledDate: '2026-11-11' }),
    ];
    const out = await loadOfficeToldFields(conn, rows, NOW);
    expect(loadPromiseLevels.mock.calls[0][1]).toEqual(['in', 'camel']);
    expect(out.get('far')).toEqual({ customerAskedTime: true });
    expect(out.get('past')).toEqual({ customerAskedTime: false });
    expect(out.get('done')).toBeUndefined();
  }));

  test('the stored choice is judged by the current-intent rule: a newer slot change makes it stale (null)', withGate('true', async () => {
    const conn = fakeConn({ stored: [
      { id: 'held', customer_asked_time: true, customer_asked_time_at: '2026-11-01T00:00:00Z', has_slot_change: true, slot_after_intent: false },
      { id: 'stale', customer_asked_time: true, customer_asked_time_at: '2026-11-01T00:00:00Z', has_slot_change: true, slot_after_intent: true },
      { id: 'nolog', customer_asked_time: false, customer_asked_time_at: null, has_slot_change: false, slot_after_intent: false },
      { id: 'booked-then-moved', customer_asked_time: true, customer_asked_time_at: null, has_slot_change: true, slot_after_intent: false },
    ] });
    const out = await loadOfficeToldFields(conn, ['held', 'stale', 'nolog', 'booked-then-moved'].map((id) => row(id, '2026-11-12')), NOW);
    expect(out.get('held').customerAskedTime).toBe(true);
    expect(out.get('stale').customerAskedTime).toBeNull();
    expect(out.get('nolog').customerAskedTime).toBe(false);
    expect(out.get('booked-then-moved').customerAskedTime).toBeNull();
    expect(conn.calls).toEqual(['scheduled_services']);
  }));

  test('a failed level read leaves no badge (never a guessed hour); the intent still comes', withGate('true', async () => {
    loadPromiseLevels.mockRejectedValue(new Error('boom'));
    const conn = fakeConn({ stored: [{ id: 's1', customer_asked_time: true }] });
    const out = await loadOfficeToldFields(conn, [row('s1', '2026-11-12')], NOW);
    expect(out.get('s1')).toEqual({ customerAskedTime: true });
  }));

  test('a failed intent read leaves the box unset; the badge still comes', withGate('true', async () => {
    loadPromiseLevels.mockResolvedValue(new Map([['s1', 'day']]));
    const out = await loadOfficeToldFields(fakeConn({ fail: true }), [row('s1', '2026-11-12')], NOW);
    expect(out.get('s1')).toEqual({ told: { level: 'day', dayOnly: true } });
  }));

  test('no rows: no read', withGate('true', async () => {
    const conn = fakeConn();
    expect((await loadOfficeToldFields(conn, [], NOW)).size).toBe(0);
    expect(conn).not.toHaveBeenCalled();
    expect(loadPromiseLevels).not.toHaveBeenCalled();
  }));
});

describe('attachOfficeToldFields (the admin schedule payload)', () => {
  const today = new Date();
  const soon = (n) => { const d = new Date(today.getTime() + n * 86400000); return d.toISOString().slice(0, 10); };

  beforeEach(() => {
    db.mockReset();
    db.raw = (sql) => ({ raw: sql });
    db.mockImplementation(() => {
      const chain = {
        whereIn: (col, ids) => { chain.ids = ids; return chain; },
        select: async () => chain.ids.map((id) => ({ id, customer_asked_time: id === 'a' })),
      };
      return chain;
    });
  });

  test('gate on: stamps told and customerAskedTime on the rows with one bulk level read', withGate('true', async () => {
    loadPromiseLevels.mockResolvedValue(new Map([['a', 'day'], ['b', 'hour']]));
    const rows = [{ id: 'a', scheduledDate: soon(3), status: 'confirmed' }, { id: 'b', scheduledDate: soon(4), status: 'confirmed' }];
    await attachOfficeToldFields({ techRole: 'admin' }, rows);
    expect(loadPromiseLevels).toHaveBeenCalledTimes(1);
    expect(rows[0]).toMatchObject({ customerAskedTime: true, told: { level: 'day', dayOnly: true } });
    expect(rows[1]).toMatchObject({ customerAskedTime: false, told: { level: 'hour', dayOnly: false } });
  }));

  test('gate off: no field, no read', withGate(undefined, async () => {
    const rows = [{ id: 'a', scheduledDate: soon(3), status: 'confirmed' }];
    await attachOfficeToldFields({ techRole: 'admin' }, rows);
    expect(rows[0]).toEqual({ id: 'a', scheduledDate: soon(3), status: 'confirmed' });
    expect(loadPromiseLevels).not.toHaveBeenCalled();
    expect(db).not.toHaveBeenCalled();
  }));

  test('a technician feed gets neither field and no read', withGate('true', async () => {
    const rows = [{ id: 'a', scheduledDate: soon(3), status: 'confirmed' }];
    await attachOfficeToldFields({ techRole: 'technician' }, rows);
    expect(rows[0]).not.toHaveProperty('told');
    expect(rows[0]).not.toHaveProperty('customerAskedTime');
    expect(loadPromiseLevels).not.toHaveBeenCalled();
  }));

  test('a read that throws leaves the payload as it was', withGate('true', async () => {
    db.mockImplementation(() => { throw new Error('db down'); });
    loadPromiseLevels.mockRejectedValue(new Error('boom'));
    const rows = [{ id: 'a', scheduledDate: soon(3), status: 'confirmed' }];
    await expect(attachOfficeToldFields({ techRole: 'admin' }, rows)).resolves.toBeUndefined();
    expect(rows[0]).not.toHaveProperty('told');
  }));
});
