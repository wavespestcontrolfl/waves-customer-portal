/**
 * Customer move limits for the public reschedule page
 * (GATE_RESCHEDULE_MOVE_LIMITS, owner rulings 2026-10-09): late-move limit by
 * plan, 2 online moves of a never-serviced customer's visit, and no rule may
 * empty the picker.
 */
const limits = require('../services/scheduling/customer-move-limits');

const {
  loadMoveLimit, lateLimitApplies, withinLimit, noTimeSoon, customerMovesSince, countedMoves, moveLimitsEnabled,
} = limits;

const move = (overrides = {}) => ({
  initiated_by: 'customer_self_serve',
  original_date: '2026-10-15', new_date: '2026-10-22',
  original_window: '09:00-11:00', new_window: '09:00-11:00',
  created_at: '2026-10-01T14:00:00Z',
  ...overrides,
});

// reschedule_log rows, the newest office-sent link, and the completed-visit probe.
function dbFor({ rows = [], officeLinkAt = null, completed = null, fail = false } = {}) {
  const calls = [];
  const database = (table) => {
    calls.push(table);
    if (fail) throw new Error('db down');
    const chain = {};
    for (const m of ['where', 'whereNotNull', 'orderBy', 'max']) chain[m] = () => chain;
    chain.select = async () => rows;
    chain.first = async () => (table === 'outbox_messages' ? { at: officeLinkAt } : completed);
    return chain;
  };
  database.calls = calls;
  return database;
}

const visit = (overrides = {}) => ({
  id: 'svc-1', customer_id: 'cust-1', scheduled_date: '2026-10-15', recurring_pattern: 'quarterly', ...overrides,
});
const NOW = new Date('2026-10-05T16:00:00Z');

beforeEach(() => { process.env.GATE_RESCHEDULE_MOVE_LIMITS = 'true'; });
afterEach(() => { delete process.env.GATE_RESCHEDULE_MOVE_LIMITS; });

describe('gate', () => {
  test('off: nothing is read and no limit applies', async () => {
    delete process.env.GATE_RESCHEDULE_MOVE_LIMITS;
    const database = dbFor();
    expect(moveLimitsEnabled()).toBe(false);
    expect(await loadMoveLimit(visit(), { database, now: NOW })).toBeNull();
    expect(database.calls).toEqual([]);
  });

  test('a missed visit is a rebook: no limit, nothing read', async () => {
    const database = dbFor();
    expect(await loadMoveLimit(visit(), { database, missed: true, now: NOW })).toBeNull();
    expect(database.calls).toEqual([]);
  });

  test('an unreadable history applies no limit', async () => {
    expect(await loadMoveLimit(visit(), { database: dbFor({ fail: true }), now: NOW })).toBeNull();
  });
});

describe('late-move limit', () => {
  test.each([
    ['quarterly', '2026-11-05'],
    ['bimonthly', '2026-10-29'],
    ['every_6_weeks', '2026-10-25'],
    ['monthly', '2026-10-22'],
  ])('%s: the last date is the due date plus the plan allowance', async (pattern, lastDate) => {
    const limit = await loadMoveLimit(visit({ recurring_pattern: pattern }), { database: dbFor(), now: NOW });
    expect(limit).toEqual({ dueDate: '2026-10-15', lastDate, firstVisitBlocked: false });
  });

  test('a visit with no plan allowance has no last date', async () => {
    const limit = await loadMoveLimit(visit({ recurring_pattern: null }), { database: dbFor(), now: NOW });
    expect(limit.lastDate).toBeNull();
  });

  test('the due date is the date before the customer\'s first move, not the date the visit is on now', async () => {
    const rows = [move(), move({ original_date: '2026-10-22', new_date: '2026-10-30', created_at: '2026-10-03T14:00:00Z' })];
    const limit = await loadMoveLimit(visit({ scheduled_date: '2026-10-30' }), { database: dbFor({ rows, completed: { id: 'x' } }), now: NOW });
    expect(limit.dueDate).toBe('2026-10-15');
    expect(limit.lastDate).toBe('2026-11-05');
  });

  test('a move by Waves starts the history again: the date Waves chose is the due date', async () => {
    const rows = [
      move(),
      move({ initiated_by: 'weather_auto', original_date: '2026-10-22', new_date: '2026-10-24', created_at: '2026-10-02T14:00:00Z' }),
    ];
    const limit = await loadMoveLimit(visit({ scheduled_date: '2026-10-24' }), { database: dbFor({ rows }), now: NOW });
    expect(limit.dueDate).toBe('2026-10-24');
  });

  test('a reschedule link the office sent after the moves starts the history again', async () => {
    const rows = [move(), move({ original_date: '2026-10-22', new_date: '2026-10-30', created_at: '2026-10-03T14:00:00Z' })];
    const limit = await loadMoveLimit(
      visit({ scheduled_date: '2026-10-30' }),
      { database: dbFor({ rows, officeLinkAt: '2026-10-04T12:00:00Z' }), now: NOW },
    );
    expect(limit).toEqual({ dueDate: '2026-10-30', lastDate: '2026-11-20', firstVisitBlocked: false });
  });
});

describe('first visit: 2 online moves', () => {
  const twoMoves = [move(), move({ original_date: '2026-10-22', new_date: '2026-10-30', created_at: '2026-10-03T14:00:00Z' })];

  test('a customer with no completed visit is handed to the office after 2 moves', async () => {
    const limit = await loadMoveLimit(visit({ scheduled_date: '2026-10-30' }), { database: dbFor({ rows: twoMoves }), now: NOW });
    expect(limit.firstVisitBlocked).toBe(true);
  });

  test('a customer with a completed visit is not', async () => {
    const limit = await loadMoveLimit(visit({ scheduled_date: '2026-10-30' }), { database: dbFor({ rows: twoMoves, completed: { id: 'done' } }), now: NOW });
    expect(limit.firstVisitBlocked).toBe(false);
  });

  test('one move does not block, and the completed-visit probe is not run', async () => {
    const database = dbFor({ rows: [move()] });
    const limit = await loadMoveLimit(visit({ scheduled_date: '2026-10-22' }), { database, now: NOW });
    expect(limit.firstVisitBlocked).toBe(false);
    expect(database.calls).not.toContain('scheduled_services');
  });

  test('a pick inside 15 minutes of the one before it is the same move', () => {
    expect(countedMoves([
      move({ created_at: '2026-10-01T14:00:00Z' }),
      move({ created_at: '2026-10-01T14:10:00Z' }),
      move({ created_at: '2026-10-03T14:00:00Z' }),
    ])).toBe(2);
  });

  test('inside 15 minutes of the second move the customer can still correct it', async () => {
    const now = new Date('2026-10-03T14:10:00Z');
    const limit = await loadMoveLimit(visit({ scheduled_date: '2026-10-30' }), { database: dbFor({ rows: twoMoves }), now });
    expect(limit.firstVisitBlocked).toBe(false);
  });

  test('rows that changed no date or time are not moves', () => {
    expect(customerMovesSince([move({ new_date: '2026-10-15' })], null)).toHaveLength(0);
  });
});

describe('the picker is never emptied', () => {
  const day = (date, n, nearby = false) => ({ date, nearby, slots: Array.from({ length: n }, (_, i) => ({ date, start_time: `${9 + i}:00` })) });
  const availability = {
    days: [day('2026-11-04', 2, true), day('2026-11-05', 1), day('2026-11-06', 4)],
    slots: [{ date: '2026-11-04' }, { date: '2026-11-06' }],
    nearby: true,
  };
  const limit = { dueDate: '2026-10-15', lastDate: '2026-11-05', firstVisitBlocked: false };

  test('3 or more times inside the limit: the limit applies and later days are dropped', () => {
    expect(lateLimitApplies(limit, availability)).toBe(true);
    const kept = withinLimit(availability, limit.lastDate);
    expect(kept.days.map((d) => d.date)).toEqual(['2026-11-04', '2026-11-05']);
    expect(kept.slots).toEqual([{ date: '2026-11-04' }]);
    expect(kept.nearby).toBe(true);
    expect(availability.days).toHaveLength(3);
  });

  test('fewer than 3 times inside the limit: the limit is not applied', () => {
    expect(lateLimitApplies({ ...limit, lastDate: '2026-11-04' }, availability)).toBe(false);
    expect(lateLimitApplies({ ...limit, lastDate: '2026-10-20' }, availability)).toBe(false);
  });

  test('no plan allowance, or no limit: never applied', () => {
    expect(lateLimitApplies({ ...limit, lastDate: null }, availability)).toBe(false);
    expect(lateLimitApplies(null, availability)).toBe(false);
  });
});

describe('no time in the next 7 days', () => {
  const now = new Date('2026-10-05T16:00:00Z');
  test('true when the first open time is later than 7 days, or nothing is open', () => {
    expect(noTimeSoon({ days: [{ date: '2026-10-13', slots: [{}] }] }, now)).toBe(true);
    expect(noTimeSoon({ days: [] }, now)).toBe(true);
    expect(noTimeSoon(null, now)).toBe(true);
    expect(noTimeSoon({ days: [{ date: '2026-10-08', slots: [] }] }, now)).toBe(true);
  });
  test('false when a time is open inside 7 days', () => {
    expect(noTimeSoon({ days: [{ date: '2026-10-12', slots: [{}] }] }, now)).toBe(false);
  });
});

describe('reschedule-public wiring', () => {
  jest.resetModules();
  jest.doMock('../models/db', () => jest.fn());
  jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
  const router = require('../routes/reschedule-public');
  const { applyMoveLimit } = router._test;
  const src = require('fs').readFileSync(require.resolve('../routes/reschedule-public'), 'utf8');

  const day = (date, n) => ({ date, nearby: false, slots: Array.from({ length: n }, () => ({ date })) });
  const full = { days: [day('2026-11-04', 3), day('2026-11-09', 2)], slots: [{ date: '2026-11-04' }, { date: '2026-11-09' }], nearby: false };
  const limit = { dueDate: '2026-10-15', lastDate: '2026-11-05', firstVisitBlocked: false };

  test('no limit: the list is returned as built and the payload key is absent', () => {
    expect(applyMoveLimit(null, full, full)).toEqual({ availability: full, moveLimit: null });
  });

  test('limit applies: later days are dropped and the page is told the last date', () => {
    const out = applyMoveLimit(limit, full, full);
    expect(out.availability.days.map((d) => d.date)).toEqual(['2026-11-04']);
    expect(out.moveLimit.lastDate).toBe('2026-11-05');
  });

  test('fewer than 3 times inside the limit: nothing is dropped and no last date is named', () => {
    const thin = { ...full, days: [day('2026-11-04', 2), day('2026-11-09', 2)] };
    const out = applyMoveLimit(limit, thin, thin);
    expect(out.availability).toBe(thin);
    expect(out.moveLimit.lastDate).toBeNull();
  });

  test('GET hands a first visit past its moves to the office before any availability build', () => {
    const get = src.slice(src.indexOf("router.get('/:token'"), src.indexOf("router.post('/:token/find-slots'"));
    const blocked = get.indexOf("reason: 'move_limit'");
    expect(blocked).toBeGreaterThan(-1);
    expect(blocked).toBeLessThan(get.indexOf('buildAvailabilityForService(svc'));
  });

  test('Confirm checks the limits after the idempotent replay and refuses MOVE_LIMIT', () => {
    const commit = src.slice(src.indexOf("router.post('/:token', commitLimiter"));
    const replay = commit.indexOf('replayed: true');
    const check = commit.indexOf("code: 'MOVE_LIMIT'");
    expect(replay).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(replay);
    expect(commit.slice(check - 400, check)).toMatch(/date > limit\.lastDate && await lateLimitActive\(svc, limit, range, config\)/);
    expect(commit.slice(check - 400, check)).toMatch(/limit\?\.firstVisitBlocked/);
  });

  test('the search drops the same days GET drops', () => {
    const search = src.slice(src.indexOf("router.post('/:token/find-slots'"), src.indexOf("router.post('/:token', commitLimiter"));
    expect(search).toMatch(/await lateLimitActive\(svc, limit, range, config\)\) \{\s*availability = moveLimits\.withinLimit\(availability, limit\.lastDate\);/);
    expect(search).toMatch(/reason: 'move_limit'/);
  });
});
