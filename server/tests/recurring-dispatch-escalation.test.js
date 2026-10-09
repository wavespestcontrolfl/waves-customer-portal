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
const query = {};
beforeEach(() => {
  jest.clearAllMocks();
  retireStatements.length = 0;
  existingNoticeKeys = [];
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
    cleanup.select = jest.fn(async () => existingNoticeKeys.map((dedupe_key) => ({ dedupe_key })));
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
    expect(sql).toContain('"s"."source_estimate_id" is null');
    expect(bindings).toEqual(expect.arrayContaining(['recurring-no-window:%', 'pending', 'confirmed', '2026-08-05']));
    // The due-date family keeps its own retire, untouched.
    expect(retireStatements[0].bindings).toContain('recurring-dispatch:%');
  });

  test('leaves an estimate-linked visit to the combined-booking check, in the scan and in the retire', async () => {
    scanFindsOnlyWindowless();
    notifications.notifyAdmin.mockResolvedValue({ id: 'notice9' });
    await flagUnplacedVisits({ lockWindowDays: 14 }, now);
    // The scan excludes a row linked to an estimate directly or through its plan parent.
    expect(query.whereNull).toHaveBeenCalledWith('s.source_estimate_id');
    expect(query.whereNotExists).toHaveBeenCalledTimes(2); // raise-time re-check shares the scan's rule
    const { sql } = retireStatements[1];
    expect(sql).toContain('"s"."source_estimate_id" is null');
    expect(sql).toMatch(/not exists \(select "p"\."id" from "scheduled_services" as "p" where p\.id = s\.recurring_parent_id and "p"\."source_estimate_id" is not null\)/);
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
    // The LAST row by date already has a notice: it is refreshed besides the 10 new ones.
    existingNoticeKeys = ['recurring-no-window:n10:2026-08-20'];
    query.select = jest.fn().mockResolvedValueOnce(rows).mockResolvedValue([]);
    notifications.notifyAdmin.mockResolvedValue({ id: 'noticeX' });
    expect(await flagUnplacedVisits({ lockWindowDays: 14 }, now)).toBe(11);
    const keys = notifications.notifyAdmin.mock.calls.map((c) => c[3].dedupeKey);
    expect(keys).toContain('recurring-no-window:n10:2026-08-20');
    expect(keys.filter((k) => k !== 'recurring-no-window:n10:2026-08-20')).toHaveLength(10);
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

  test('closes every missing-geo notice whose visit this run did not skip, matching the date', async () => {
    await retireMissingGeoNotices(new Set(['v1', 'v2']), now);
    expect(retire).toHaveBeenCalledWith(expect.objectContaining({
      done_at: now, done_by: 'auto-dispatch', title: 'Address pin alert resolved',
    }));
    const { sql, bindings } = retireStatements[0];
    expect(sql).toContain("s.scheduled_date::text = notifications.metadata->>'scheduledDate'");
    expect(sql).toContain('"s"."id" in (?, ?)');
    expect(bindings).toEqual(expect.arrayContaining(['auto-dispatch-missing-geo:%', 'v1', 'v2']));
  });

  test('with no flagged visit every standing missing-geo notice closes', async () => {
    await retireMissingGeoNotices(new Set(), now);
    expect(retireStatements[0].sql).toContain('and 1 = ?');
    expect(retireStatements[0].bindings).toContain(0);
  });
});
