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
  recurring_pattern: 'quarterly', recurring_interval_days: null, ...overrides,
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

  test('no whole-range list (the build failed): the list is returned as built with no key', () => {
    expect(applyLimit(limit, null, availability, { rangeTo: '2026-11-20' })).toEqual({ availability, payload: {} });
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
    expect(body).toMatch(/\.\.\.limited\.payload/);
  });
});
