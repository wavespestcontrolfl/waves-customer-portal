/**
 * Customer move limits for the public reschedule page
 * (GATE_RESCHEDULE_MOVE_LIMITS, owner rulings 2026-10-09): late-move limit by
 * plan, 2 online moves of a never-serviced customer's visit, and no rule may
 * empty the picker.
 */
const limits = require('../services/scheduling/customer-move-limits');

const {
  loadMoveLimit, lateLimitApplies, applyLimit, withinLimit, noTimeSoon, customerMovesSince, countedMoves, moveLimitsEnabled, allowanceDays,
} = limits;

const move = (overrides = {}) => ({
  initiated_by: 'customer_self_serve',
  original_date: '2026-10-15', new_date: '2026-10-22',
  original_window: '09:00-11:00', new_window: '09:00-11:00',
  created_at: '2026-10-01T14:00:00Z',
  ...overrides,
});

// reschedule_log rows and the completed-visit probe.
function dbFor({ rows = [], completed = null, fail = false } = {}) {
  const calls = [];
  const database = (table) => {
    calls.push(table);
    if (fail) throw new Error('db down');
    const chain = {};
    for (const m of ['where', 'orderBy']) chain[m] = () => chain;
    chain.select = async () => rows;
    chain.first = async () => completed;
    return chain;
  };
  database.calls = calls;
  return database;
}

const visit = (overrides = {}) => ({
  id: 'svc-1', customer_id: 'cust-1', scheduled_date: '2026-10-15', window_start: '09:00:00',
  recurring_pattern: 'quarterly', recurring_interval_days: null, is_recurring: true, ...overrides,
});
const NOW = new Date('2026-10-05T16:00:00Z');
// Two standing moves: Oct 15 → Oct 22 → Oct 30.
const twoMoves = [move(), move({ original_date: '2026-10-22', new_date: '2026-10-30', created_at: '2026-10-03T14:00:00Z' })];
const onOct30 = (overrides = {}) => visit({ scheduled_date: '2026-10-30', ...overrides });

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
    ['quarterly', null, '2026-11-05'],
    ['bimonthly', null, '2026-10-29'],
    ['every_6_weeks', null, '2026-10-25'],
    ['monthly', null, '2026-10-22'],
    ['monthly_nth_weekday', null, '2026-10-22'],
    ['bi-monthly', null, '2026-10-29'],
    ['Quarterly', null, '2026-11-05'],
    ['custom', 42, '2026-10-25'],
    ['custom', 60, '2026-10-29'],
    ['custom', 30, '2026-10-22'],
    ['custom', 90, '2026-11-05'],
  ])('%s (interval %s): the last date is the due date plus the plan allowance', async (pattern, interval, lastDate) => {
    const limit = await loadMoveLimit(
      visit({ recurring_pattern: pattern, recurring_interval_days: interval }), { database: dbFor(), now: NOW },
    );
    expect(limit).toEqual({ dueDate: '2026-10-15', lastDate, firstVisitBlocked: false });
  });

  test.each([
    [null, null], ['one_time', null], ['seasonal_feb_oct', null], ['semiannual', null], ['annual', null],
    ['weekly', null], ['biweekly', null], ['custom', 14], ['custom', 180],
  ])('%s (interval %s): no plan allowance, no last date', async (pattern, interval) => {
    expect(allowanceDays({ recurring_pattern: pattern, recurring_interval_days: interval })).toBeNull();
  });

  test.each([
    ['custom', 'monthly', 7], [null, 'monthly', 7], [null, 'quarterly', 21], ['custom', 'bimonthly', 14],
    ['custom', 'every_6_weeks', 10], [null, 'seasonal_feb_oct', null], [null, 'one_time', null], [null, null, null],
  ])('legacy plan row (%s, no interval) reads the catalog cadence %s', (pattern, frequency, days) => {
    expect(allowanceDays({
      recurring_pattern: pattern, recurring_interval_days: null, is_recurring: true, catalog_frequency: frequency,
    })).toBe(days);
  });

  test('the catalog cadence is not read for a one-time visit, a stored pattern or a stored interval', () => {
    expect(allowanceDays({ recurring_pattern: null, is_recurring: false, recurring_parent_id: null, catalog_frequency: 'monthly' })).toBeNull();
    expect(allowanceDays({ recurring_pattern: 'quarterly', is_recurring: true, catalog_frequency: 'monthly' })).toBe(21);
    expect(allowanceDays({ recurring_pattern: 'custom', recurring_interval_days: 60, is_recurring: true, catalog_frequency: 'monthly' })).toBe(14);
    expect(allowanceDays({ recurring_pattern: null, is_recurring: null, recurring_parent_id: 'p-1', catalog_frequency: 'monthly' })).toBe(7);
  });

  test('a one-time visit that stores a cadence has no plan allowance', () => {
    expect(allowanceDays({ recurring_pattern: 'quarterly', is_recurring: false, recurring_parent_id: null })).toBeNull();
    expect(allowanceDays({ recurring_pattern: 'monthly' })).toBeNull();
    expect(allowanceDays({ recurring_pattern: 'quarterly', is_recurring: null, recurring_parent_id: 'p-1' })).toBe(21);
  });

  test('a visit staff placed or hold (auto-dispatch lock): the customer\'s earlier moves do not stand', async () => {
    const database = dbFor({ rows: twoMoves });
    const limit = await loadMoveLimit(onOct30({ auto_dispatch_locked: true }), { database, now: NOW });
    expect(limit).toEqual({ dueDate: '2026-10-30', lastDate: '2026-11-20', firstVisitBlocked: false });
    expect(customerMovesSince(twoMoves, onOct30({ auto_dispatch_locked: true }))).toEqual([]);
    expect(customerMovesSince(twoMoves, onOct30())).toHaveLength(2);
  });

  test('the due date is the date before the customer\'s first move, not the date the visit is on now', async () => {
    const limit = await loadMoveLimit(onOct30(), { database: dbFor({ rows: twoMoves, completed: { id: 'x' } }), now: NOW });
    expect(limit.dueDate).toBe('2026-10-15');
    expect(limit.lastDate).toBe('2026-11-05');
  });

  test('a logged move by Waves starts the history again: the date Waves chose is the due date', async () => {
    const rows = [
      move(),
      move({ initiated_by: 'weather_auto', original_date: '2026-10-22', new_date: '2026-10-24', created_at: '2026-10-02T14:00:00Z' }),
    ];
    const limit = await loadMoveLimit(visit({ scheduled_date: '2026-10-24' }), { database: dbFor({ rows }), now: NOW });
    expect(limit.dueDate).toBe('2026-10-24');
  });

  test('a staff edit writes no log row: a visit that is not where the last move put it starts again', async () => {
    const moved = await loadMoveLimit(visit({ scheduled_date: '2026-11-02' }), { database: dbFor({ rows: twoMoves }), now: NOW });
    expect(moved).toEqual({ dueDate: '2026-11-02', lastDate: '2026-11-23', firstVisitBlocked: false });
    const retimed = await loadMoveLimit(onOct30({ window_start: '13:00:00' }), { database: dbFor({ rows: twoMoves }), now: NOW });
    expect(retimed).toEqual({ dueDate: '2026-10-30', lastDate: '2026-11-20', firstVisitBlocked: false });
  });

  test('a correction inside 15 minutes of a missed rebook belongs to the rebook', async () => {
    // Missed Oct 1. Rebooked Oct 2 14:00 to Oct 15, corrected 14:05 to Oct 16, then one real move to Oct 22.
    const rows = [
      move({ original_date: '2026-10-01', new_date: '2026-10-15', created_at: '2026-10-02T14:00:00Z' }),
      move({ original_date: '2026-10-15', new_date: '2026-10-16', created_at: '2026-10-02T14:05:00Z' }),
      move({ original_date: '2026-10-16', new_date: '2026-10-22', created_at: '2026-10-04T14:00:00Z' }),
    ];
    const v = visit({ scheduled_date: '2026-10-22' });
    expect(customerMovesSince(rows, v)).toHaveLength(1);
    const limit = await loadMoveLimit(v, { database: dbFor({ rows }), now: NOW });
    expect(limit).toEqual({ dueDate: '2026-10-16', lastDate: '2026-11-06', firstVisitBlocked: false });
    // A later pick is a move, not a correction.
    const late = [rows[0], move({ original_date: '2026-10-15', new_date: '2026-10-22', created_at: '2026-10-02T15:00:00Z' })];
    expect(customerMovesSince(late, v)).toHaveLength(1);
  });

  test('a Waves row that keeps the date and time (logged with other precision) is not a placement', async () => {
    // auto-dispatch re-assigns the technician: same slot, '09:00:00-11:00:00' vs '09:00-11:00'.
    const rows = [
      ...twoMoves,
      move({
        initiated_by: 'auto_dispatch', original_date: '2026-10-30', new_date: '2026-10-30',
        original_window: '09:00:00-11:00:00', new_window: '09:00-11:00', created_at: '2026-10-04T08:10:00Z',
      }),
    ];
    const limit = await loadMoveLimit(onOct30(), { database: dbFor({ rows }), now: NOW });
    expect(limit).toEqual({ dueDate: '2026-10-15', lastDate: '2026-11-05', firstVisitBlocked: true });
  });

  test('a Waves row that changes only the end (a duration correction) is not a placement', async () => {
    const rows = [
      ...twoMoves,
      move({
        initiated_by: 'admin', original_date: '2026-10-30', new_date: '2026-10-30',
        original_window: '09:00-10:00', new_window: '09:00-10:30', created_at: '2026-10-04T08:10:00Z',
      }),
    ];
    const limit = await loadMoveLimit(onOct30(), { database: dbFor({ rows }), now: NOW });
    expect(limit).toEqual({ dueDate: '2026-10-15', lastDate: '2026-11-05', firstVisitBlocked: true });
  });

  test('staff cleared the window after the customer\'s moves: the visit is unplaced and the history starts again', async () => {
    const limit = await loadMoveLimit(onOct30({ window_start: null }), { database: dbFor({ rows: twoMoves }), now: NOW });
    expect(limit).toEqual({ dueDate: '2026-10-30', lastDate: '2026-11-20', firstVisitBlocked: false });
  });

  test('a staff edit BETWEEN two customer moves: the history starts at the move after it', async () => {
    // Customer: Oct 15 → Oct 22. Staff (no log row): Oct 22 → Oct 26. Customer: Oct 26 → Oct 30.
    const rows = [move(), move({ original_date: '2026-10-26', new_date: '2026-10-30', created_at: '2026-10-03T14:00:00Z' })];
    const database = dbFor({ rows });
    const limit = await loadMoveLimit(onOct30(), { database, now: NOW });
    expect(limit).toEqual({ dueDate: '2026-10-26', lastDate: '2026-11-16', firstVisitBlocked: false });
    expect(database.calls).not.toContain('scheduled_services');
    // A staff re-time on the same date breaks the chain too.
    const retimed = [move(), move({ original_date: '2026-10-22', original_window: '13:00-15:00', new_date: '2026-10-30', created_at: '2026-10-03T14:00:00Z' })];
    expect(customerMovesSince(retimed, onOct30())).toHaveLength(1);
  });

  test('a missed-visit rebook is not a move: its new date is the due date and it uses no first-visit move', async () => {
    // The Oct 1 visit passed; the customer rebooked it on Oct 2 to Oct 15, then moved it once.
    const rows = [
      move({ original_date: '2026-10-01', new_date: '2026-10-15', created_at: '2026-10-02T14:00:00Z' }),
      move({ original_date: '2026-10-15', new_date: '2026-10-22', created_at: '2026-10-04T14:00:00Z' }),
    ];
    const database = dbFor({ rows });
    const limit = await loadMoveLimit(visit({ scheduled_date: '2026-10-22' }), { database, now: NOW });
    expect(limit).toEqual({ dueDate: '2026-10-15', lastDate: '2026-11-05', firstVisitBlocked: false });
    expect(database.calls).not.toContain('scheduled_services');
    expect(customerMovesSince(rows, visit({ scheduled_date: '2026-10-22' }))).toHaveLength(1);
  });
});

describe('first visit: 2 online moves', () => {
  test('a customer with no completed visit is handed to the office after 2 moves', async () => {
    const limit = await loadMoveLimit(onOct30(), { database: dbFor({ rows: twoMoves }), now: NOW });
    expect(limit.firstVisitBlocked).toBe(true);
  });

  test('a customer with a completed visit is not', async () => {
    const limit = await loadMoveLimit(onOct30(), { database: dbFor({ rows: twoMoves, completed: { id: 'done' } }), now: NOW });
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
    const limit = await loadMoveLimit(onOct30(), { database: dbFor({ rows: twoMoves }), now });
    expect(limit.firstVisitBlocked).toBe(false);
  });

  test('rows that changed no date or time are not moves', () => {
    expect(customerMovesSince([move({ new_date: '2026-10-15' })], visit())).toHaveLength(0);
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

  test('a limit at or past the end of the booking range drops nothing: not applied, no date named', () => {
    expect(lateLimitApplies(limit, availability, '2026-11-05')).toBe(false);
    expect(lateLimitApplies(limit, availability, '2026-11-04')).toBe(false);
    expect(lateLimitApplies(limit, availability, '2026-11-06')).toBe(true);
    const out = applyLimit(limit, availability, availability, { rangeTo: '2026-11-05', now: new Date('2026-11-01T16:00:00Z') });
    expect(out.availability).toBe(availability);
    expect(out.payload).toEqual({ moveLimit: { laterByOffice: false, noTimeSoon: false } });
  });

  test('no whole-range list (the limit date is not inside the range): nothing is dropped and no 7-day flag is sent', () => {
    expect(applyLimit(limit, null, availability, { rangeTo: '2026-11-20' })).toEqual({ availability, payload: { moveLimit: { laterByOffice: false } } });
    expect(applyLimit(null, null, availability, { rangeTo: '2026-11-20' })).toEqual({ availability, payload: {} });
    expect(lateLimitApplies(limit, null, '2026-11-20')).toBe(false);
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
  const range = { rangeFrom: '2026-10-28', rangeTo: '2026-11-10' };

  test('no limit: the list is returned as built and the payload key is absent', () => {
    expect(applyMoveLimit(null, full, full, range)).toEqual({ availability: full, payload: {} });
  });

  test('limit applies: later days are dropped and the page is told later dates go through the office (no date)', () => {
    const out = applyMoveLimit(limit, full, full, range);
    expect(out.availability.days.map((d) => d.date)).toEqual(['2026-11-04']);
    expect(out.payload.moveLimit).toEqual({ laterByOffice: true, noTimeSoon: expect.any(Boolean) });
  });

  test('fewer than 3 times inside the limit: nothing is dropped and no hand-off line is sent', () => {
    const thin = { ...full, days: [day('2026-11-04', 2), day('2026-11-09', 2)] };
    const out = applyMoveLimit(limit, thin, thin, range);
    expect(out.availability).toBe(thin);
    expect(out.payload.moveLimit.laterByOffice).toBe(false);
  });

  test('cadenceChangedSince: a changed pattern or interval on the locked row is a change, only with the gate set', () => {
    const { cadenceChangedSince } = router._test;
    const svc = { recurring_pattern: 'quarterly', recurring_interval_days: null, is_recurring: true };
    const prev = process.env.GATE_RESCHEDULE_MOVE_LIMITS;
    try {
      process.env.GATE_RESCHEDULE_MOVE_LIMITS = 'true';
      expect(cadenceChangedSince(svc, { recurring_pattern: 'quarterly', recurring_interval_days: null, is_recurring: true })).toBe(false);
      expect(cadenceChangedSince(svc, { recurring_pattern: 'monthly', recurring_interval_days: null, is_recurring: true })).toBe(true);
      expect(cadenceChangedSince({ recurring_pattern: 'custom', recurring_interval_days: 42, is_recurring: true },
        { recurring_pattern: 'custom', recurring_interval_days: '42', is_recurring: true })).toBe(false);
      expect(cadenceChangedSince({ recurring_pattern: 'custom', recurring_interval_days: 42, is_recurring: true },
        { recurring_pattern: 'custom', recurring_interval_days: 30, is_recurring: true })).toBe(true);
      delete process.env.GATE_RESCHEDULE_MOVE_LIMITS;
      expect(cadenceChangedSince(svc, { recurring_pattern: 'monthly' })).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.GATE_RESCHEDULE_MOVE_LIMITS; else process.env.GATE_RESCHEDULE_MOVE_LIMITS = prev;
    }
    // Both movers run the guard that holds the pin.
    expect(src).toMatch(/'service_id', 'is_recurring', 'recurring_parent_id'\);\n[\s\S]{0,700}if \(cadenceChangedSince\(svc, await withCatalogCadence\(locked, trx\)\)\)/);
  });

  test('the search rechecks the visit after its availability build and before it applies the limit', () => {
    const start = src.indexOf("router.post('/:token/find-slots'");
    const body = src.slice(start, src.indexOf("router.post('/:token',", start));
    const recheck = body.indexOf('if (moveLimits.moveLimitsEnabled() && await visitChangedSince(svc)) {');
    expect(recheck).toBeGreaterThan(body.indexOf('buildAvailabilityForService(svc'));
    expect(body.indexOf('applyMoveLimit(')).toBeGreaterThan(recheck);
    expect(body.slice(recheck, recheck + 300)).toMatch(/code: 'SCOPE_CHANGED'/);
  });

  test('a failed whole-range build inside a limit is a retry (503), not "no limit"', async () => {
    const { fullRangeForLimit } = router._test;
    // No coordinates and a db mock that returns nothing: the build gives no list.
    const svc = { id: 'svc-1', customer_id: 'c-1', scheduled_date: '2026-10-15', window_start: '09:00:00' };
    await expect(fullRangeForLimit(svc, limit, range, {})).rejects.toMatchObject({
      statusCode: 503, isOperational: true, code: 'LIMIT_UNAVAILABLE',
    });
    // A limit at or past the end of the range drops nothing: no refusal.
    await expect(fullRangeForLimit(svc, { ...limit, lastDate: '2026-11-10' }, range, {})).resolves.toBeNull();
    await expect(fullRangeForLimit(svc, { ...limit, lastDate: null }, range, {})).resolves.toBeNull();
    // No list is built when the limit date is not inside the range.
    // A limit date before the range: no time can be inside it, so no refusal.
    await expect(fullRangeForLimit(svc, { ...limit, lastDate: '2026-10-20' }, range, {})).resolves.toBeNull();
    // No limit: nothing is built.
    await expect(fullRangeForLimit(svc, null, range, {})).resolves.toBeNull();
  });

  test('a legacy plan row: a changed service or catalog cadence is a cadence change', async () => {
    const { cadenceChangedSince, withCatalogCadence } = router._test;
    const legacy = { recurring_pattern: 'custom', recurring_interval_days: null, is_recurring: true, service_id: 'sv-1' };
    const trx = (frequency) => () => ({ where: () => ({ first: async () => (frequency ? { frequency } : undefined) }) });
    const loaded = { ...legacy, catalog_frequency: 'quarterly' };
    expect(cadenceChangedSince(loaded, await withCatalogCadence(legacy, trx('quarterly')))).toBe(false);
    expect(cadenceChangedSince(loaded, await withCatalogCadence(legacy, trx('monthly')))).toBe(true);
    // The same allowance from another stored form is not a change.
    expect(cadenceChangedSince(loaded, { recurring_pattern: 'custom', recurring_interval_days: 90, is_recurring: true })).toBe(false);
  });

  test('visitChangedSince: another date, start or status, or an unreadable visit, is a change', async () => {
    const { visitChangedSince } = router._test;
    const svc = { id: 'svc-1', scheduled_date: '2026-10-15', window_start: '09:00:00', status: 'confirmed' };
    let row;
    const database = () => {
      const chain = { leftJoin: () => chain, where: () => chain, first: async () => row };
      return chain;
    };
    database.raw = (sql) => sql;
    const answer = (next) => { row = next; };
    answer({ ...svc, window_start: '09:00' });
    expect(await visitChangedSince(svc, database)).toBe(false);
    answer({ ...svc, scheduled_date: '2026-10-22' });
    expect(await visitChangedSince(svc, database)).toBe(true);
    answer({ ...svc, window_start: '13:00:00' });
    expect(await visitChangedSince(svc, database)).toBe(true);
    answer({ ...svc, status: 'cancelled' });
    expect(await visitChangedSince(svc, database)).toBe(true);
    answer({ ...svc, recurring_pattern: 'monthly', is_recurring: true });
    expect(await visitChangedSince({ ...svc, recurring_pattern: 'quarterly', is_recurring: true }, database)).toBe(true);
    answer(undefined);
    expect(await visitChangedSince(svc, database)).toBe(true);
    expect(await visitChangedSince(svc, () => { throw new Error('db down'); })).toBe(true);
  });

  test('GET and the search read one verdict: a blocked first visit is not reschedulable (move_limit) before any build', () => {
    const fold = src.slice(src.indexOf('async function pageEligibilityWithLimit(svc) {'));
    expect(fold.slice(0, 500)).toMatch(/blocked \? \{ ok: false, reason: 'move_limit', code: 'MOVE_LIMIT' \} : elig/);
    const get = src.slice(src.indexOf("router.get('/:token'"), src.indexOf("router.post('/:token/find-slots'"));
    const verdict = get.indexOf('await pageEligibilityWithLimit(svc)');
    expect(verdict).toBeGreaterThan(-1);
    expect(verdict).toBeLessThan(get.indexOf('buildAvailabilityForService(svc'));
    expect(get).toMatch(/applyMoveLimit\(limit, availability, availability, range\)/);
    expect(get).toMatch(/\.\.\.limited\.payload/);
  });

  test('Confirm checks the limits after the idempotent replay and refuses MOVE_LIMIT', () => {
    const commit = src.slice(src.indexOf("router.post('/:token', commitLimiter"));
    const replay = commit.indexOf('replayed: true');
    const check = commit.indexOf('await moveLimitRefuses(svc, elig, range, config, date)');
    expect(replay).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(replay);
    expect(commit.slice(check, check + 200)).toMatch(/code: 'MOVE_LIMIT'/);
    const refuses = src.slice(src.indexOf('async function moveLimitRefuses('));
    const body = refuses.slice(0, refuses.indexOf('\n}\n'));
    expect(body).toMatch(/if \(blocked\) return true;/);
    expect(body).toMatch(/date <= limit\.lastDate\) return false;/);
    expect(body).toMatch(/lateLimitApplies\(limit, await fullRangeForLimit\(svc, limit, range, config\), range\.rangeTo\)/);
  });

  test('the search and the slot-taken refresh decide over the whole range and return the limit they applied', () => {
    const search = src.slice(src.indexOf("router.post('/:token/find-slots'"), src.indexOf("router.post('/:token', commitLimiter"));
    expect(search).toMatch(/applyMoveLimit\(limit, await fullRangeForLimit\(svc, limit, range, config\), availability, range\)/);
    expect(search).toMatch(/\.\.\.limited\.payload/);
    expect(search).toMatch(/reason: elig\.reason, code: elig\.code/);
    const taken = src.slice(src.indexOf('const slotTakenResponse = async () => {'));
    const body = taken.slice(0, taken.indexOf('// Anti-forgery'));
    expect(body).toMatch(/applyMoveLimit\(limit, refreshed, refreshed, range\)/);
    // Another tab may have changed the visit: the refresh reads it again and
    // answers SCOPE_CHANGED (the page reloads) before it uses any old state.
    const changed = body.indexOf('if (moveLimits.moveLimitsEnabled() && await visitChangedSince(svc)) {');
    const limitRead = body.indexOf('await loadMoveLimit(svc, elig)');
    expect(changed).toBeGreaterThan(-1);
    expect(body.slice(changed, changed + 400)).toMatch(/code: 'SCOPE_CHANGED'/);
    expect(limitRead).toBeGreaterThan(changed);
    expect(body).toMatch(/if \(blocked\) return res\.status\(409\)\.json\(\{ error: MOVE_LIMIT_MESSAGE, code: 'MOVE_LIMIT' \}\);/);
  });
});
