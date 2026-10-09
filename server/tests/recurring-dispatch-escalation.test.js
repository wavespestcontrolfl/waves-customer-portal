jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-service', () => ({
  notifyAdmin: jest.fn(),
  // A system retire closes the card done (read is not done).
  _private: { doneColumns: jest.fn(({ by, resolution, at }) => ({ done_at: at, done_by: by, resolution, read_at: at })) },
}));

jest.mock('../services/auto-dispatch/eligibility', () => ({
  isRecurringPlanActive: jest.fn(async () => ({ active: true })),
}));

const db = require('../models/db');
const eligibility = require('../services/auto-dispatch/eligibility');
const notifications = require('../services/notification-service');
const { flagUnplacedVisits } = require('../services/auto-dispatch/audit');
const knex = require('knex')({ client: 'pg' });

const retire = jest.fn();
const retireStatements = [];
// dedupe keys of no-window notices that already exist in the notification store
let existingNoticeKeys = [];
// the same, but already closed: the retire rewrote their title to the resolved one
let resolvedNoticeKeys = [];
let rungLast24h = [];
// estimates with an open combined-booking bell that carries missing_time_tech
let combinedBells = [];
const combinedBellSql = [];
const budgetSql = [];
const budgetBindings = [];
const budgetWhere = [];
const query = {};
beforeEach(() => {
  jest.clearAllMocks();
  retireStatements.length = 0;
  existingNoticeKeys = [];
  resolvedNoticeKeys = [];
  rungLast24h = [];
  combinedBells = [];
  combinedBellSql.length = 0;
  budgetSql.length = 0;
  budgetBindings.length = 0;
  budgetWhere.length = 0;
  retire.mockResolvedValue(1);
  eligibility.isRecurringPlanActive.mockResolvedValue({ active: true });
  db.raw = jest.fn((sql) => sql);
  for (const method of ['join', 'whereNotNull', 'whereNull', 'whereIn', 'where', 'whereRaw', 'whereNotExists', 'forNoKeyUpdate']) {
    query[method] = jest.fn(() => query);
  }
  query.select = jest.fn(async () => []);
  query.first = jest.fn(async () => ({ id: 's1' }));
  db.transaction = jest.fn(async (run) => run(db));
  db.mockImplementation((table) => {
    if (table !== 'notifications') return query;
    // Compile the real PostgreSQL update, including the correlated subquery;
    // no connection is opened and no DB execution is claimed by this test.
    const cleanup = knex(table);
    const update = cleanup.update.bind(cleanup);
    cleanup.update = (values) => {
      retireStatements.push(update(values).toSQL());
      return retire(values);
    };
    // The standing-key read excludes rows by title, like the real query.
    let excludedTitle = null;
    const whereNot = cleanup.whereNot.bind(cleanup);
    cleanup.whereNot = (column, value) => { if (column === 'title') excludedTitle = value; return whereNot(column, value); };
    // The 24-hour budget read (recentBudgetKeys) is told apart by its SQL.
    let budgetRead = false;
    const whereRaw = cleanup.whereRaw.bind(cleanup);
    let firstWhere = null;
    const where = cleanup.where.bind(cleanup);
    cleanup.where = (...args) => { if (firstWhere === null) [firstWhere] = args; return where(...args); };
    let combinedRead = false;
    cleanup.whereRaw = (sql, bindings) => { if (/dedupeKey' = ANY|problemCodes/.test(sql)) { combinedRead = true; combinedBellSql.push({ sql, bindings }); } if (/interval '24 hours'/.test(sql)) { budgetRead = true; budgetSql.push(sql); budgetBindings.push(bindings); budgetWhere.push(firstWhere); } return whereRaw(sql, bindings); };
    cleanup.select = jest.fn(async () => (combinedRead ? combinedBells.map((estimate_id) => ({ estimate_id })) : budgetRead ? rungLast24h.map((dedupe_key) => ({ dedupe_key })) : [
      ...existingNoticeKeys.map((dedupe_key) => ({ dedupe_key })),
      ...(excludedTitle === 'Recurring visit time alert resolved' ? [] : resolvedNoticeKeys.map((dedupe_key) => ({ dedupe_key }))),
    ]));
    return cleanup;
  });
});

test('unplaced visits are escalated before the lock window through the existing deduped admin bell', async () => {
  // The no-window scan runs first and finds nothing; the next select is the due-date scan.
  query.select = jest.fn()
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ id: 's1', customer_id: 'c1', recurring_dispatch_due_date: '2026-08-20' }])
    .mockResolvedValue([]);
  notifications.notifyAdmin.mockResolvedValue({ id: 'notice1' });

  await flagUnplacedVisits({ lockWindowDays: 14 }, new Date('2026-08-05T16:00:00Z'));
  expect(query.where).toHaveBeenCalledWith('s.recurring_dispatch_due_date', '<=', '2026-08-23');
  expect(query.whereNull).toHaveBeenCalledWith('s.window_start');
  expect(notifications.notifyAdmin).toHaveBeenCalledWith(
    'schedule_conflict', expect.any(String), expect.stringContaining('2026-08-20'),
    expect.objectContaining({ bell: true, dedupeKey: 'recurring-dispatch:s1:2026-08-20', refreshOnDedupe: true, trx: db }),
  );
  // A failed notification must fail the pass, rather than reporting a clean run.
  notifications.notifyAdmin.mockResolvedValue(null);
  query.select = jest.fn()
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ id: 's1', customer_id: 'c1', recurring_dispatch_due_date: '2026-08-20' }])
    .mockResolvedValue([]);
  await expect(flagUnplacedVisits({ lockWindowDays: 14 })).rejects.toThrow('could not be recorded');
});

test('a visit placed after the scan raises no alert and is not counted as flagged', async () => {
  query.select.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 's1', customer_id: 'c1', recurring_dispatch_due_date: '2026-08-20' }]);
  query.first.mockResolvedValue(null);
  expect(await flagUnplacedVisits({ lockWindowDays: 14 })).toBe(0);
  expect(notifications.notifyAdmin).not.toHaveBeenCalled();
});

test('a pass with no pending placement still retires obsolete lane alerts', async () => {
  const now = new Date('2026-08-05T16:00:00Z');
  expect(await flagUnplacedVisits({ lockWindowDays: 14 }, now)).toBe(0);
  expect(retire).toHaveBeenCalledWith(expect.objectContaining({ done_at: now, done_by: 'auto-dispatch', title: 'Recurring placement alert resolved' }));
  expect(notifications.notifyAdmin).not.toHaveBeenCalled();
  const { sql, bindings } = retireStatements[0];
  expect(sql).toContain('not exists (select "s"."id" from "scheduled_services" as "s"');
  expect(sql).toContain("s.id::text = notifications.metadata->>'scheduledServiceId'");
  expect(sql).toContain("s.recurring_dispatch_due_date::text = notifications.metadata->>'dueDate'");
  expect(sql).toContain('"s"."window_start" is null');
  expect(sql).not.toContain('"read_at" is null');
  expect(sql).toContain('not "title" = ?');
  expect(bindings).toEqual(expect.arrayContaining(['admin', 'schedule_conflict', 'recurring-dispatch:%', 'pending', 'confirmed']));
});

test('retirement failure fails the pass and the next run retries it', async () => {
  retire.mockRejectedValueOnce(new Error('notification store unavailable'));
  await expect(flagUnplacedVisits({ lockWindowDays: 14 })).rejects.toThrow('notification store unavailable');
  await expect(flagUnplacedVisits({ lockWindowDays: 14 })).resolves.toBe(0);
  expect(retire).toHaveBeenCalledTimes(3); // the failed pass stops at the first retire; the retry runs both
});

// A recurring child with neither an arrival window nor a due date is invisible
// to the due-date scan above, so it gets its own notice family.
describe('recurring visit with no arrival time and no due date', () => {
  const now = new Date('2026-08-05T16:00:00Z');
  const windowless = { id: 's9', customer_id: 'c9', recurring_parent_id: 'p9', scheduled_date: '2026-08-20' };
  function scanFindsOnlyWindowless() {
    query.select = jest.fn().mockResolvedValueOnce([windowless]).mockResolvedValue([]);
  }

  test('raises one deduped notice that names the day and links to that day in dispatch', async () => {
    scanFindsOnlyWindowless();
    notifications.notifyAdmin.mockResolvedValue({ id: 'notice9' });
    expect(await flagUnplacedVisits({ lockWindowDays: 14 }, now)).toBe(1);
    // Shape: a recurring child, no window, no due date, pending/confirmed, today through +45 days.
    expect(query.whereNotNull).toHaveBeenCalledWith('s.recurring_parent_id');
    expect(query.whereNull).toHaveBeenCalledWith('s.recurring_dispatch_due_date');
    expect(query.where).toHaveBeenCalledWith('s.scheduled_date', '>=', '2026-08-05');
    expect(query.where).toHaveBeenCalledWith('s.scheduled_date', '<=', '2026-09-19');
    expect(notifications.notifyAdmin).toHaveBeenCalledTimes(1);
    expect(notifications.notifyAdmin).toHaveBeenCalledWith(
      'schedule_conflict', 'Schedule — set an arrival time for a recurring visit', expect.stringContaining('Aug 20'),
      expect.objectContaining({
        bell: true,
        link: '/admin/dispatch?tab=schedule&date=2026-08-20&appointment=s9',
        dedupeKey: 'recurring-no-window:s9:2026-08-20',
        refreshOnDedupe: true,
        metadata: expect.objectContaining({ scheduledServiceId: 's9', customerId: 'c9', scheduledDate: '2026-08-20' }),
        trx: db,
      }),
    );
  });

  test('re-checks the row under its lock: a visit given a time meanwhile raises nothing', async () => {
    scanFindsOnlyWindowless();
    query.first.mockResolvedValue(null);
    expect(await flagUnplacedVisits({ lockWindowDays: 14 }, now)).toBe(0);
    expect(query.forNoKeyUpdate).toHaveBeenCalledWith('s');
    expect(notifications.notifyAdmin).not.toHaveBeenCalled();
  });

  test('a notice that cannot be recorded fails the pass', async () => {
    scanFindsOnlyWindowless();
    notifications.notifyAdmin.mockResolvedValue(null);
    await expect(flagUnplacedVisits({ lockWindowDays: 14 }, now)).rejects.toThrow('no-window notice could not be recorded');
  });

  test('retires its own notices once the visit has a window, is cancelled, or changes date', async () => {
    expect(await flagUnplacedVisits({ lockWindowDays: 14 }, now)).toBe(0);
    expect(retire).toHaveBeenCalledTimes(2);
    expect(retire).toHaveBeenLastCalledWith(expect.objectContaining({
      done_at: now, done_by: 'auto-dispatch', title: 'Recurring visit time alert resolved',
    }));
    const { sql, bindings } = retireStatements[1];
    expect(sql).toContain('not exists (select "s"."id" from "scheduled_services" as "s"');
    expect(sql).toContain("s.id::text = notifications.metadata->>'scheduledServiceId'");
    expect(sql).toContain("s.scheduled_date::text = notifications.metadata->>'scheduledDate'");
    expect(sql).toContain('"s"."window_start" is null');
    expect(sql).toContain('"s"."recurring_dispatch_due_date" is null');
    expect(bindings).toEqual(expect.arrayContaining(['recurring-no-window:%', 'pending', 'confirmed', '2026-08-05']));
    // The due-date family keeps its own retire, untouched.
    expect(retireStatements[0].bindings).toContain('recurring-dispatch:%');
  });

  // "Covered" is read from the combined-booking check's own open bell, not
  // predicted from its candidate rules (Codex #6208 r20 P2).
  test('a visit whose booking has an open combined-booking bell for a missing time is left to that bell; any other visit gets the notice', async () => {
    combinedBells = ['e2'];
    const rows = [
      { id: 'one', customer_id: 'c1', recurring_parent_id: 'p1', scheduled_date: '2026-08-20', source_estimate_id: 'e1' },
      { id: 'two', customer_id: 'c2', recurring_parent_id: 'p2', scheduled_date: '2026-08-21', source_estimate_id: null, parent_estimate_id: 'e2' },
    ];
    query.select = jest.fn().mockResolvedValueOnce(rows).mockResolvedValue([]);
    notifications.notifyAdmin.mockResolvedValue({ id: 'notice9' });
    await flagUnplacedVisits({ lockWindowDays: 14 }, now);
    expect(notifications.notifyAdmin.mock.calls.map((call) => call[3].dedupeKey)).toEqual(['recurring-no-window:one:2026-08-20']);
    // An open bell (it keeps its dedupeKey) that names the missing time.
    expect(combinedBellSql[0]).toMatchObject({ bindings: [['combined-booking-check:e1', 'combined-booking-check:e2']] });
    expect(combinedBellSql[1].sql).toContain("'missing_time_tech'");
  });

  test('a combined booking with no open bell (check off, customer not scanned, not run yet) keeps its visit in this lane', async () => {
    const rows = [{ id: 'two', customer_id: 'c2', recurring_parent_id: 'p2', scheduled_date: '2026-08-21', source_estimate_id: 'e2' }];
    query.select = jest.fn().mockResolvedValueOnce(rows).mockResolvedValue([]);
    notifications.notifyAdmin.mockResolvedValue({ id: 'notice9' });
    await flagUnplacedVisits({ lockWindowDays: 14 }, now);
    expect(notifications.notifyAdmin.mock.calls.map((call) => call[3].dedupeKey)).toEqual(['recurring-no-window:two:2026-08-21']);
  });

  // scheduled_services has no catalog key column; the key comes from the
  // services row of the series root (Codex #6208 r18 P1).
  test('the series-root service key is read through the services catalog', async () => {
    await flagUnplacedVisits({ lockWindowDays: 14 }, now);
    const raws = db.raw.mock.calls.map((call) => call[0]).filter((sql) => /root_service_key/.test(sql));
    expect(raws.length).toBeGreaterThan(0);
    for (const sql of raws) {
      expect(sql).toContain('left join services as cat on cat.id = p.service_id');
      expect(sql).not.toContain('p.catalog_service_key');
    }
  });

  // The plan lapsed after the candidate read and before the locked recheck:
  // no notice (Codex #6208 r9 P2).
  test('a plan that lapses before the locked recheck raises nothing', async () => {
    query.select = jest.fn().mockResolvedValueOnce([{ id: 'n1', customer_id: 'c1', recurring_parent_id: 'p1', scheduled_date: '2026-08-20' }]).mockResolvedValue([]);
    eligibility.isRecurringPlanActive.mockResolvedValueOnce({ active: true }).mockResolvedValueOnce({ active: false });
    expect(await flagUnplacedVisits({ lockWindowDays: 14 }, new Date('2026-08-01T16:00:00Z'))).toBe(0);
    expect(notifications.notifyAdmin).not.toHaveBeenCalled();
  });

  // The soonest visit got a window after the scan: the locked recheck drops
  // it, and the eleventh visit takes the slot (Codex #6208 r10 P2).
  test('a candidate the locked recheck drops leaves its slot for the next visit', async () => {
    const rows = Array.from({ length: 11 }, (_, i) => ({ id: `n${i}`, customer_id: `c${i}`, recurring_parent_id: `p${i}`, scheduled_date: `2026-08-${String(10 + i).padStart(2, '0')}` }));
    query.select = jest.fn().mockResolvedValueOnce(rows).mockResolvedValue([]);
    query.first = jest.fn().mockResolvedValueOnce(undefined).mockResolvedValue({ id: 'live' });
    notifications.notifyAdmin.mockResolvedValue({ id: 'noticeX' });
    expect(await flagUnplacedVisits({ lockWindowDays: 14 }, new Date('2026-08-01T16:00:00Z'))).toBe(10);
    const keys = notifications.notifyAdmin.mock.calls.map((c) => c[3].dedupeKey);
    expect(keys).not.toContain('recurring-no-window:n0:2026-08-10');
    expect(keys).toContain('recurring-no-window:n10:2026-08-20');
  });

  // A failed no-window read must not stop the due-date notices; the failure
  // is thrown after they are out (Codex #6208 r13 P2).
  test('a no-window read failure still raises the due-date notices, then throws', async () => {
    query.select = jest.fn()
      .mockRejectedValueOnce(new Error('no-window scan timed out'))
      .mockResolvedValueOnce([{ id: 'd1', customer_id: 'c1', recurring_dispatch_due_date: '2026-08-03' }]);
    notifications.notifyAdmin.mockResolvedValue({ id: 'notice1' });
    await expect(flagUnplacedVisits({ lockWindowDays: 14 }, new Date('2026-08-01T16:00:00Z'))).rejects.toThrow('no-window scan timed out');
    expect(notifications.notifyAdmin.mock.calls.map((c) => c[3].dedupeKey)).toEqual(['recurring-dispatch:d1:2026-08-03']);
  });

  // The bell is read before anything is opened: the headline names the
  // customer (docs/admin-notifications.md; Codex #6208 r15 P2).
  test('the headline names the customer when the name can be read', async () => {
    query.select = jest.fn().mockResolvedValueOnce([{ id: 'n1', customer_id: 'c1', recurring_parent_id: 'p1', scheduled_date: '2026-08-20' }]).mockResolvedValue([]);
    query.first = jest.fn(async () => ({ id: 'n1', first_name: 'Sample', last_name: 'Tester' }));
    notifications.notifyAdmin.mockResolvedValue({ id: 'notice9' });
    await flagUnplacedVisits({ lockWindowDays: 14 }, new Date('2026-08-01T16:00:00Z'));
    expect(notifications.notifyAdmin.mock.calls[0][1]).toBe("Schedule — set an arrival time for Sample Tester's visit");
  });

  // A seasonal mosquito series has no time on purpose until the office routes
  // the season; it needs one once inside 14 days (Codex #6208 r15 P2).
  test('a seasonal mosquito visit beyond the 14-day routing horizon raises nothing; inside it, it does', async () => {
    const now = new Date('2026-08-01T16:00:00Z');
    const rows = [
      { id: 'far', customer_id: 'c1', recurring_parent_id: 'p1', scheduled_date: '2026-08-20', root_service_key: 'mosquito_seasonal', root_date: '2026-08-20', booking_first_day: '2026-07-01' },
      { id: 'near', customer_id: 'c2', recurring_parent_id: 'p2', scheduled_date: '2026-08-10', root_service_key: 'mosquito_seasonal', root_date: '2026-08-10', booking_first_day: '2026-07-01' },
      // A seasonal series whose root is the booking's first day did not roll:
      // it needs a time like any other series (Codex #6208 r20 P2).
      { id: 'sameday', customer_id: 'c3', recurring_parent_id: 'p3', scheduled_date: '2026-08-25', root_service_key: 'mosquito_seasonal', root_date: '2026-07-01', booking_first_day: '2026-07-01' },
      // The booking cannot be read: not exempt.
      { id: 'nobook', customer_id: 'c4', recurring_parent_id: 'p4', scheduled_date: '2026-08-26', root_service_key: 'mosquito_seasonal', root_date: '2026-08-05', booking_first_day: null },
    ];
    query.select = jest.fn().mockResolvedValueOnce(rows).mockResolvedValue([]);
    notifications.notifyAdmin.mockResolvedValue({ id: 'notice9' });
    await flagUnplacedVisits({ lockWindowDays: 14 }, now);
    expect(notifications.notifyAdmin.mock.calls.map((c) => c[3].dedupeKey)).toEqual(['recurring-no-window:near:2026-08-10', 'recurring-no-window:sameday:2026-08-25', 'recurring-no-window:nobook:2026-08-26']);
  });

  test('rings at most 10 new notices a run, soonest date first; the rest wait for the next run', async () => {
    const rows = Array.from({ length: 11 }, (_, i) => ({
      id: `n${i}`, customer_id: `c${i}`, recurring_parent_id: `p${i}`, scheduled_date: `2026-08-${String(30 - i).padStart(2, '0')}`,
    }));
    query.select = jest.fn().mockResolvedValueOnce(rows).mockResolvedValue([]);
    notifications.notifyAdmin.mockResolvedValue({ id: 'noticeX' });
    expect(await flagUnplacedVisits({ lockWindowDays: 14 }, now)).toBe(10);
    const keys = notifications.notifyAdmin.mock.calls.map((c) => c[3].dedupeKey);
    expect(keys).toHaveLength(10);
    // n0 is the latest date (Aug 30): the one left for the next run.
    expect(keys).not.toContain('recurring-no-window:n0:2026-08-30');
    expect(keys[0]).toBe('recurring-no-window:n10:2026-08-20');
  });

  test('a visit that already has its notice is refreshed and spends no budget', async () => {
    const rows = Array.from({ length: 11 }, (_, i) => ({
      id: `n${i}`, customer_id: `c${i}`, recurring_parent_id: `p${i}`, scheduled_date: `2026-08-${String(10 + i).padStart(2, '0')}`,
    }));
    // The FIRST row by date already has a notice: its write is deduped and
    // does not ring, so it spends nothing and the 10 others still ring.
    existingNoticeKeys = ['recurring-no-window:n0:2026-08-10'];
    query.select = jest.fn().mockResolvedValueOnce(rows).mockResolvedValue([]);
    notifications.notifyAdmin.mockImplementation(async (_c, _t, _b, opts) => ({ id: 'noticeX', deduped: opts.dedupeKey === 'recurring-no-window:n0:2026-08-10' }));
    expect(await flagUnplacedVisits({ lockWindowDays: 14 }, now)).toBe(11);
    const keys = notifications.notifyAdmin.mock.calls.map((c) => c[3].dedupeKey);
    expect(keys).toContain('recurring-no-window:n0:2026-08-10');
    expect(keys.filter((k) => k !== 'recurring-no-window:n0:2026-08-10')).toHaveLength(10);
  });

  // A standing notice whose refresh RINGS (its text changed) spends a slot,
  // and nothing is raised once the allowance is spent (Codex #6208 r16 P2).
  test('a standing notice that re-rings spends a slot', async () => {
    const rows = Array.from({ length: 11 }, (_, i) => ({
      id: `n${i}`, customer_id: `c${i}`, recurring_parent_id: `p${i}`, scheduled_date: `2026-08-${String(10 + i).padStart(2, '0')}`,
    }));
    existingNoticeKeys = ['recurring-no-window:n0:2026-08-10'];
    query.select = jest.fn().mockResolvedValueOnce(rows).mockResolvedValue([]);
    notifications.notifyAdmin.mockImplementation(async (_c, _t, _b, opts) => (opts.dedupeKey === 'recurring-no-window:n0:2026-08-10'
      ? { id: 'noticeX', deduped: true, refreshed: true, rung: true } : { id: 'noticeX', deduped: false }));
    await flagUnplacedVisits({ lockWindowDays: 14 }, now);
    expect(notifications.notifyAdmin).toHaveBeenCalledTimes(10);
  });

  // One allowance for every auto-dispatch notice lane and every run in 24
  // hours: four pin notices rung earlier leave six for this lane (pre-push P1).
  test('notices another lane or run rang in the last 24 hours come off the budget', async () => {
    const now = new Date('2026-08-01T16:00:00Z');
    const rows = Array.from({ length: 11 }, (_, i) => ({ id: `n${i}`, customer_id: `c${i}`, scheduled_date: `2026-08-${String(10 + i).padStart(2, '0')}` }));
    rungLast24h = ['auto-dispatch-missing-geo:a:2026-08-02', 'auto-dispatch-missing-geo:b:2026-08-02', 'auto-dispatch-reminder-sync:c:2026-08-02:08:00', 'recurring-no-window:z:2026-08-03'];
    // The watchdog's bell classes and the combined-booking check count too (r7 P1).
    const bindings = () => budgetBindings.flat();
    query.select = jest.fn().mockResolvedValueOnce(rows).mockResolvedValue([]);
    notifications.notifyAdmin.mockResolvedValue({ id: 'noticeX' });
    expect(await flagUnplacedVisits({ lockWindowDays: 14 }, now)).toBe(6);
    // A reopened notice keeps its created_at: the read counts the last ring
    // (metadata.rungAt), with created_at as the fallback.
    // No category filter: the watchdog rings under 'alert' (r8 P1).
    expect(budgetWhere).toEqual([{ recipient_type: 'admin' }]);
    expect(bindings()).toEqual(expect.arrayContaining(['unpriced-series:%', 'lawn-email-gap:%', 'prepay-coverage:%', 'accepted-schedule:%', 'churned-live-work:%', 'combined-booking-check:%', 'recurring-dispatch:%']));
    expect(budgetSql.join(' ')).toContain("COALESCE((metadata->>'rungAt')::timestamptz, created_at) >= now() - interval '24 hours'");
    // An Activity-only row never rings and takes no slot (r10 P2).
    expect(budgetSql.join(' ')).toContain("COALESCE(metadata->>'feed', '') <> 'activity'");
  });

  test('a resolved notice is not standing: reopening it spends budget (Codex #6208 r3)', async () => {
    const rows = Array.from({ length: 11 }, (_, i) => ({
      id: `n${i}`, customer_id: `c${i}`, recurring_parent_id: `p${i}`, scheduled_date: `2026-08-${String(10 + i).padStart(2, '0')}`,
    }));
    // n10 (the latest date) has a closed notice; refreshOnDedupe would reopen and ring it.
    resolvedNoticeKeys = ['recurring-no-window:n10:2026-08-20'];
    query.select = jest.fn().mockResolvedValueOnce(rows).mockResolvedValue([]);
    notifications.notifyAdmin.mockResolvedValue({ id: 'noticeX' });
    expect(await flagUnplacedVisits({ lockWindowDays: 14 }, now)).toBe(10);
    const keys = notifications.notifyAdmin.mock.calls.map((c) => c[3].dedupeKey);
    expect(keys).toHaveLength(10);
    expect(keys).not.toContain('recurring-no-window:n10:2026-08-20'); // counted as new, so it waits
  });

  test('a lapsed plan raises nothing, spends no budget, and its standing notice closes', async () => {
    scanFindsOnlyWindowless();
    eligibility.isRecurringPlanActive.mockResolvedValue({ active: false, reason_code: 'RECURRING_PLAN_INACTIVE' });
    expect(await flagUnplacedVisits({ lockWindowDays: 14 }, now)).toBe(0);
    expect(notifications.notifyAdmin).not.toHaveBeenCalled();
    const { sql, bindings } = retireStatements[1];
    expect(sql).toContain('and 1 = ?'); // no still-actionable id: nothing keeps the notice open
    expect(bindings).toContain(0);
    expect(bindings).not.toContain('s9');
  });

  test('the retire keeps a notice open only for a still-actionable visit', async () => {
    scanFindsOnlyWindowless();
    notifications.notifyAdmin.mockResolvedValue({ id: 'notice9' });
    await flagUnplacedVisits({ lockWindowDays: 14 }, now);
    expect(retireStatements[1].bindings).toContain('s9');
  });
});

describe('missing-geo notice close', () => {
  const { retireMissingGeoNotices } = require('../services/auto-dispatch/audit');
  const now = new Date('2026-08-05T16:00:00Z');

  test('closes a notice whose visit has a usable pin or is no longer live on that date; an unexamined visit keeps it', async () => {
    await retireMissingGeoNotices(new Set(['v1', 'v2']), now);
    expect(retire).toHaveBeenCalledWith(expect.objectContaining({
      done_at: now, done_by: 'auto-dispatch', title: 'Address pin alert resolved',
    }));
    const { sql, bindings } = retireStatements[0];
    expect(sql).toContain("s.scheduled_date::text = notifications.metadata->>'scheduledDate'");
    expect(sql).toContain('"s"."scheduled_date" >= ?');
    expect(sql).toContain('"s"."status" in (?, ?)');
    // Still open unless the run found the pin usable: NOT IN, never IN.
    expect(sql).toContain('"s"."id" not in (?, ?)');
    expect(bindings).toEqual(expect.arrayContaining(['auto-dispatch-missing-geo:%', '2026-08-05', 'pending', 'confirmed', 'v1', 'v2']));
  });

  test('with no usable pin found this run, a live visit keeps its notice', async () => {
    await retireMissingGeoNotices(new Set(), now);
    expect(retireStatements[0].sql).not.toContain('"s"."id" in');
  });
});

// A gate-off night has no placement run to evaluate pins: the upkeep reads
// the standing notices' own visits and passes the ones whose pin resolves to
// the retire (Codex #6208 r17 P2).
test('missing-pin upkeep closes a standing notice whose visit now has a pin', async () => {
  const audit = require('../services/auto-dispatch/audit');
  existingNoticeKeys = ['auto-dispatch-missing-geo:v1:2026-08-20', 'auto-dispatch-missing-geo:v2:2026-08-21'];
  query.select = jest.fn().mockResolvedValue([
    { id: 'v1', scheduled_date: '2026-08-20', customer_latitude: 27.4, customer_longitude: -82.5 },
    { id: 'v2', scheduled_date: '2026-08-21', customer_latitude: null, customer_longitude: null },
  ]);
  query.leftJoin = jest.fn(() => query);
  await audit.maintainMissingGeoNotices(new Date('2026-08-01T16:00:00Z'));
  expect(query.whereIn).toHaveBeenCalledWith('scheduled_services.id', ['v1', 'v2']);
  const retireSql = retireStatements[retireStatements.length - 1];
  expect(retireSql.bindings).toContain('auto-dispatch-missing-geo:%');
  expect(retireSql.bindings).toContain('v1');
  expect(retireSql.bindings).not.toContain('v2');
  // Only an explicit false is inactive in the retire predicate.
  expect(retireSql.sql).toContain('c.active IS NOT FALSE');
});

// A lapsed plan gets no placement, so its pin needs no fix (Codex #6208 r18 P2).
test('missing-pin upkeep closes a standing notice whose plan lapsed; an unreadable plan keeps it', async () => {
  const audit = require('../services/auto-dispatch/audit');
  existingNoticeKeys = ['auto-dispatch-missing-geo:v1:2026-08-20', 'auto-dispatch-missing-geo:v2:2026-08-21', 'auto-dispatch-missing-geo:v3:2026-08-22'];
  query.select = jest.fn().mockResolvedValue(['v1', 'v2', 'v3'].map((id) => ({ id, customer_latitude: null, customer_longitude: null })));
  query.leftJoin = jest.fn(() => query);
  eligibility.isRecurringPlanActive
    .mockResolvedValueOnce({ active: false })
    .mockResolvedValueOnce({ active: true })
    .mockRejectedValueOnce(new Error('read failed'));
  await audit.maintainMissingGeoNotices(new Date('2026-08-01T16:00:00Z'));
  const retireSql = retireStatements[retireStatements.length - 1];
  expect(retireSql.bindings).toContain('v1');
  expect(retireSql.bindings).not.toContain('v2');
  expect(retireSql.bindings).not.toContain('v3');
});

