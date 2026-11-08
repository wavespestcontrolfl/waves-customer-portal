/**
 * GATE_RESCHEDULE_CAP_ALL (dark; security audit run 3, owner 2026-11-05):
 * the day cap on customer moves of one visit and the repeat-move test that
 * coalesces reschedule notices, in services/scheduling/customer-move-limits.js.
 * Both rules hold for every customer, with or without GATE_RESCHEDULE_MOVE_LIMITS.
 */
const limits = require('../services/scheduling/customer-move-limits');

const { dayCapReached, repeatMoveInWindow, loadMoveLimit, DAY_MOVE_CAP } = limits;

const NOW = new Date('2026-10-05T16:00:00Z'); // 12:00 ET
const minutesAgo = (n) => new Date(NOW.getTime() - n * 60 * 1000);

const pick = (createdAt, overrides = {}) => ({
  initiated_by: 'customer_self_serve',
  original_date: '2026-10-15', new_date: '2026-10-22',
  original_window: '09:00-10:00', new_window: '13:00-14:00',
  created_at: createdAt,
  ...overrides,
});

// A reschedule_log fake that honors the two filters the code sends: the
// equality object and the `created_at >= since` bound.
function dbFor(rows, { fail = false } = {}) {
  const calls = [];
  const database = (table) => {
    calls.push(table);
    if (fail) throw new Error('db down');
    const eq = {};
    let since = null;
    const chain = {};
    chain.where = (arg, op, val) => {
      if (typeof arg === 'object') Object.assign(eq, arg);
      else if (op === '>=') since = val;
      return chain;
    };
    chain.select = async () => rows.filter((row) => (!since || new Date(row.created_at) >= since)
      && Object.entries(eq).every(([key, value]) => key === 'scheduled_service_id' || row[key] === value));
    return chain;
  };
  database.calls = calls;
  return database;
}

const visit = { id: 'svc-1', customer_id: 'cust-1', scheduled_date: '2026-10-22', window_start: '13:00:00' };

beforeEach(() => { process.env.GATE_RESCHEDULE_CAP_ALL = 'true'; });
afterEach(() => {
  delete process.env.GATE_RESCHEDULE_CAP_ALL;
  delete process.env.GATE_RESCHEDULE_MOVE_LIMITS;
});

describe('gate', () => {
  test('off: neither rule reads anything', async () => {
    delete process.env.GATE_RESCHEDULE_CAP_ALL;
    const database = dbFor([pick(NOW), pick(NOW), pick(NOW)]);
    expect(await dayCapReached(visit, { database, now: NOW })).toBe(false);
    expect(await repeatMoveInWindow(visit, { database, now: NOW })).toBe(false);
    expect(database.calls).toEqual([]);
  });

  test('only the exact string true turns it on', async () => {
    process.env.GATE_RESCHEDULE_CAP_ALL = '1';
    expect(limits.moveCapAllEnabled()).toBe(false);
    process.env.GATE_RESCHEDULE_CAP_ALL = 'true';
    expect(limits.moveCapAllEnabled()).toBe(true);
  });
});

describe('dayCapReached', () => {
  test('the cap is 3 moves', () => {
    expect(DAY_MOVE_CAP).toBe(3);
  });

  test('two moves today: not reached', async () => {
    const database = dbFor([pick(minutesAgo(90)), pick(minutesAgo(30))]);
    expect(await dayCapReached(visit, { database, now: NOW })).toBe(false);
  });

  test('three moves today: reached, with no GATE_RESCHEDULE_MOVE_LIMITS and for a customer with a completed visit', async () => {
    const database = dbFor([pick(minutesAgo(200)), pick(minutesAgo(90)), pick(minutesAgo(30))]);
    expect(limits.moveLimitsEnabled()).toBe(false);
    expect(await dayCapReached(visit, { database, now: NOW })).toBe(true);
    expect(database.calls).toEqual(['reschedule_log']);
  });

  test('picks seconds apart each count: the first-visit 15-minute fold does not apply', async () => {
    const database = dbFor([pick(minutesAgo(1)), pick(minutesAgo(0.5)), pick(minutesAgo(0.1))]);
    expect(await dayCapReached(visit, { database, now: NOW })).toBe(true);
  });

  test('yesterday (ET) does not count, midnight ET is the edge', async () => {
    const database = dbFor([
      pick(new Date('2026-10-05T03:59:59Z')), // 23:59:59 ET on Oct 4
      pick(new Date('2026-10-05T04:00:00Z')), // 00:00:00 ET on Oct 5
      pick(minutesAgo(30)),
    ]);
    expect(await dayCapReached(visit, { database, now: NOW })).toBe(false);
  });

  test('moves by Waves (staff, weather, dispatch) do not count', async () => {
    const database = dbFor([
      pick(minutesAgo(200), { initiated_by: 'admin' }),
      pick(minutesAgo(90), { initiated_by: 'weather' }),
      pick(minutesAgo(30)),
    ]);
    expect(await dayCapReached(visit, { database, now: NOW })).toBe(false);
  });

  test('a row that changed only the technician is not a move', async () => {
    const database = dbFor([
      pick(minutesAgo(200), { new_date: '2026-10-15', new_window: '09:00:00-10:00:00' }),
      pick(minutesAgo(90)),
      pick(minutesAgo(30)),
    ]);
    expect(await dayCapReached(visit, { database, now: NOW })).toBe(false);
  });

  test('an unreadable history fails open', async () => {
    expect(await dayCapReached(visit, { database: dbFor([], { fail: true }), now: NOW })).toBe(false);
  });

  test('no visit id: false and nothing read', async () => {
    const database = dbFor([]);
    expect(await dayCapReached({}, { database, now: NOW })).toBe(false);
    expect(database.calls).toEqual([]);
  });
});

describe('repeatMoveInWindow', () => {
  test('the commit\'s own row alone is not a repeat', async () => {
    const database = dbFor([pick(minutesAgo(0.1))]);
    expect(await repeatMoveInWindow(visit, { database, now: NOW })).toBe(false);
  });

  test('another customer move inside 15 minutes makes it a repeat', async () => {
    const database = dbFor([pick(minutesAgo(10)), pick(minutesAgo(0.1))]);
    expect(await repeatMoveInWindow(visit, { database, now: NOW })).toBe(true);
  });

  test('an earlier move 16 minutes back is not inside the window', async () => {
    const database = dbFor([pick(minutesAgo(16)), pick(minutesAgo(0.1))]);
    expect(await repeatMoveInWindow(visit, { database, now: NOW })).toBe(false);
  });

  test('a staff move inside the window is not a customer repeat', async () => {
    const database = dbFor([pick(minutesAgo(10), { initiated_by: 'admin' }), pick(minutesAgo(0.1))]);
    expect(await repeatMoveInWindow(visit, { database, now: NOW })).toBe(false);
  });

  test('an unreadable history fails open: the notice goes as before', async () => {
    expect(await repeatMoveInWindow(visit, { database: dbFor([], { fail: true }), now: NOW })).toBe(false);
  });
});

describe('GATE_RESCHEDULE_MOVE_LIMITS is untouched', () => {
  test('loadMoveLimit still returns null with that gate off, even with the cap gate on', async () => {
    const database = dbFor([pick(NOW), pick(NOW), pick(NOW)]);
    expect(await loadMoveLimit(visit, { database, now: NOW })).toBeNull();
    expect(database.calls).toEqual([]);
  });
});
