/**
 * Single-visit cancel → counted-plan reseed (owner ruling 2026-09-24).
 *
 * A cancel inside a counted plan (9 lawn applications a year) used to
 * shorten the plan silently: no cancel path touched the series, the
 * completion auto-extend only fires with <2 upcoming, and the nightly
 * top-up is horizon-based. The bridge service
 * (recurring-series-cancel-reseed) is failure-isolated by contract and
 * DARK behind GATE_CANCEL_RESEEDS_RECURRING.
 *
 * Unit tests cover the bridge + the pure term/count math; source-pattern
 * guards (house style, see recurring-series-extend-hook.test.js) pin the
 * four single-visit cancel surfaces so a refactor can't silently drop one,
 * and pin that the plan-level cancel paths do NOT call it.
 */
const fs = require('fs');
const path = require('path');

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../routes/admin-schedule', () => ({
  reseedRecurringSeriesAfterCancelBatch: jest.fn(),
}));

const adminSchedule = require('../routes/admin-schedule');
const gates = require('../config/feature-gates');
const {
  runPostCancelSeriesReseed, plannedVisitsPerYearForSeries, termWindowContaining, countTermVisits,
} = require('../services/recurring-series-cancel-reseed');

const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');

describe('runPostCancelSeriesReseed bridge', () => {
  const env = process.env.GATE_CANCEL_RESEEDS_RECURRING;
  beforeEach(() => { jest.clearAllMocks(); process.env.GATE_CANCEL_RESEEDS_RECURRING = 'true'; });
  afterAll(() => { if (env === undefined) delete process.env.GATE_CANCEL_RESEEDS_RECURRING; else process.env.GATE_CANCEL_RESEEDS_RECURRING = env; });

  test('gate is read live and ships dark: off unless exactly "true"', () => {
    for (const v of [undefined, '', '1', 'on', 'TRUE', 'false']) {
      if (v === undefined) delete process.env.GATE_CANCEL_RESEEDS_RECURRING; else process.env.GATE_CANCEL_RESEEDS_RECURRING = v;
      expect(gates.cancelReseedsRecurringLive()).toBe(false);
    }
    process.env.GATE_CANCEL_RESEEDS_RECURRING = 'true';
    expect(gates.cancelReseedsRecurringLive()).toBe(true);
  });

  test('gate off → never touches the writer', async () => {
    process.env.GATE_CANCEL_RESEEDS_RECURRING = 'false';
    await runPostCancelSeriesReseed({ db: () => {}, serviceId: 'svc-1', source: 'test' });
    expect(adminSchedule.reseedRecurringSeriesAfterCancelBatch).not.toHaveBeenCalled();
  });

  test('gate on → delegates to the shared batch writer with (db, [ids], { source })', async () => {
    adminSchedule.reseedRecurringSeriesAfterCancelBatch.mockResolvedValue({ results: [{ added: [{ id: 'new' }], skipped: null }], skippedRoots: [] });
    const db = () => {};
    await runPostCancelSeriesReseed({ db, serviceId: 'svc-1', source: 'admin-dispatch-status-cancel' });
    expect(adminSchedule.reseedRecurringSeriesAfterCancelBatch).toHaveBeenCalledTimes(1);
    expect(adminSchedule.reseedRecurringSeriesAfterCancelBatch).toHaveBeenCalledWith(db, ['svc-1'], { source: 'admin-dispatch-status-cancel' });
  });

  test('bulk form hands the whole batch over once, deduped', async () => {
    adminSchedule.reseedRecurringSeriesAfterCancelBatch.mockResolvedValue({ results: [], skippedRoots: [] });
    const db = () => {};
    await runPostCancelSeriesReseed({ db, serviceIds: ['a', 'b', 'a', null], source: 'admin-schedule-bulk-cancel' });
    expect(adminSchedule.reseedRecurringSeriesAfterCancelBatch).toHaveBeenCalledTimes(1);
    expect(adminSchedule.reseedRecurringSeriesAfterCancelBatch).toHaveBeenCalledWith(db, ['a', 'b'], { source: 'admin-schedule-bulk-cancel' });
  });

  test('NEVER throws — a failed reseed must not fail the committed cancel', async () => {
    adminSchedule.reseedRecurringSeriesAfterCancelBatch.mockRejectedValue(new Error('db exploded'));
    await expect(runPostCancelSeriesReseed({ db: () => {}, serviceId: 'svc-1', source: 'test' })).resolves.toBeUndefined();
  });

  test('no-ops without a db or a service id', async () => {
    await runPostCancelSeriesReseed({ db: null, serviceId: 'svc-1' });
    await runPostCancelSeriesReseed({ db: () => {}, serviceId: null });
    await runPostCancelSeriesReseed({ db: () => {}, serviceIds: [] });
    await runPostCancelSeriesReseed();
    expect(adminSchedule.reseedRecurringSeriesAfterCancelBatch).not.toHaveBeenCalled();
  });
});

describe('term / count math (pure)', () => {
  const seeder = {
    normalizeRecurringPattern: (v) => (v === 'every 6 weeks' ? 'every_6_weeks' : v),
    plannedVisitCountForPattern: (p) => ({ monthly: 12, every_6_weeks: 9, quarterly: 4, bimonthly: 6 })[p] || 4,
  };

  test('plannedVisitsPerYearForSeries follows the pattern; custom uses its interval days', () => {
    expect(plannedVisitsPerYearForSeries({ recurring_pattern: 'quarterly' }, seeder)).toBe(4);
    expect(plannedVisitsPerYearForSeries({ recurring_pattern: 'every 6 weeks' }, seeder)).toBe(9);
    // customer e887e3c6's shape: custom / 42-day interval = 9 a year
    expect(plannedVisitsPerYearForSeries({ recurring_pattern: 'custom', recurring_interval_days: 42 }, seeder)).toBe(9);
    expect(plannedVisitsPerYearForSeries({ recurring_pattern: 'custom', recurring_interval_days: 14 }, seeder)).toBe(26);
    expect(plannedVisitsPerYearForSeries({ recurring_pattern: 'custom', recurring_interval_days: null }, seeder)).toBeNull();
    expect(plannedVisitsPerYearForSeries({ recurring_pattern: null }, seeder)).toBeNull();
    expect(plannedVisitsPerYearForSeries(null, seeder)).toBeNull();
  });

  test('termWindowContaining anchors 365-day terms on the series root', () => {
    expect(termWindowContaining('2026-07-10', '2026-10-05')).toEqual({ index: 0, start: '2026-07-10', end: '2027-07-10' });
    expect(termWindowContaining('2026-07-10', '2027-07-10')).toEqual({ index: 1, start: '2027-07-10', end: '2028-07-10' });
    expect(termWindowContaining('2026-07-10', '2028-01-01').index).toBe(1);
    // a cancelled row dated before its root (data oddity) still resolves to term 0
    expect(termWindowContaining('2026-07-10', '2026-07-01').index).toBe(0);
    expect(termWindowContaining(null, '2026-07-01')).toBeNull();
    expect(termWindowContaining('2026-07-10', undefined)).toBeNull();
    expect(termWindowContaining(new Date('2026-07-10T04:00:00Z'), '2026-08-01').start).toBe('2026-07-10');
    // calendar years, not 365-day blocks: no leap-year drift across 2028
    expect(termWindowContaining('2027-07-10', '2028-07-09')).toEqual({ index: 0, start: '2027-07-10', end: '2028-07-10' });
    expect(termWindowContaining('2028-02-29', '2029-03-01')).toEqual({ index: 1, start: '2029-02-28', end: '2030-02-28' });
    expect(termWindowContaining('2026-07-10', 'not-a-date')).toBeNull();
  });

  test('countTermVisits counts only rows inside the term that can still happen', () => {
    const window = { index: 0, start: '2026-07-10', end: '2027-07-10' };
    // customer e887e3c6 after the Oct 5 cancel: 9 rows, one cancelled → 8 count
    const rows = [
      { scheduled_date: '2026-07-10', status: 'completed' },
      { scheduled_date: '2026-09-28', status: 'pending' },
      { scheduled_date: '2026-10-05', status: 'cancelled' },
      { scheduled_date: '2026-11-13', status: 'pending' },
      { scheduled_date: '2026-12-25', status: 'pending' },
      { scheduled_date: '2027-02-05', status: 'pending' },
      { scheduled_date: '2027-03-19', status: 'pending' },
      { scheduled_date: '2027-04-30', status: 'confirmed' },
      { scheduled_date: '2027-06-11', status: 'pending' },
    ];
    expect(countTermVisits(rows, window)).toBe(8);
    // a re-added visit at the end of the term restores 9
    expect(countTermVisits([...rows, { scheduled_date: '2027-07-09', status: 'pending' }], window)).toBe(9);
    // next-term rows and no-show/skipped/rescheduled rows never count
    expect(countTermVisits([
      ...rows,
      { scheduled_date: '2027-07-23', status: 'pending' },
      { scheduled_date: '2026-08-19', status: 'no_show' },
      { scheduled_date: '2026-08-20', status: 'skipped' },
      { scheduled_date: '2026-08-21', status: 'rescheduled' },
    ], window)).toBe(8);
    expect(countTermVisits(rows, null)).toBe(0);
    expect(countTermVisits([], window)).toBe(0);
  });
});

describe('cancel surfaces wire the hook (source guards)', () => {
  const dispatch = read('../routes/admin-dispatch.js');
  const schedule = read('../routes/admin-schedule.js');
  const services = read('../routes/admin-services.js');
  const ib = read('../services/intelligence-bar/tools.js');

  test('the four single-visit cancel surfaces call the bridge exactly once each', () => {
    const count = (src, rel) => (src.match(new RegExp(`require\\('${rel.replace(/[./]/g, '\\$&')}'\\)\\.runPostCancelSeriesReseed\\(`, 'g')) || []).length;
    expect(count(dispatch, '../services/recurring-series-cancel-reseed')).toBe(1);
    expect(count(schedule, '../services/recurring-series-cancel-reseed')).toBe(1);
    expect(count(services, '../services/recurring-series-cancel-reseed')).toBe(1);
    expect(count(ib, '../recurring-series-cancel-reseed')).toBe(1);
  });

  test('bulk cancel: collects real transitions during the loop and calls the bridge ONCE after the batch settled', () => {
    const route = schedule.slice(schedule.indexOf("router.post('/bulk-action'"));
    const collect = route.indexOf("if (fromStatus !== 'cancelled') cancelReseedIds.push(id);");
    const flush = route.indexOf('await flushDispatchQualityDates(qualityDates);');
    const call = route.indexOf("serviceIds: cancelReseedIds, source: 'admin-schedule-bulk-cancel'");
    const respond = route.indexOf('res.json({');
    expect(collect).toBeGreaterThan(-1);
    expect(flush).toBeGreaterThan(collect);
    expect(call).toBeGreaterThan(flush);
    expect(respond).toBeGreaterThan(call);
    // no per-row call remains inside the loop
    expect(route.slice(0, flush)).not.toMatch(/runPostCancelSeriesReseed/);
  });

  test('batch writer: several cancels of one plan in a batch = plan reduction, never a refill', () => {
    const body = schedule.slice(
      schedule.indexOf('async function reseedRecurringSeriesAfterCancelBatch('),
      schedule.indexOf('// PUT /api/admin/schedule/:id/status'),
    );
    expect(body).toMatch(/if \(cancelledIds\.length > 1\) \{[\s\S]*?skipped: 'batch_series_cancel'/);
    expect(body).toMatch(/results\.push\(await reseedRecurringSeriesAfterCancel\(conn, cancelledIds\[0\], \{ source \}\)\)/);
    expect(schedule).toMatch(/module\.exports\.reseedRecurringSeriesAfterCancelBatch = reseedRecurringSeriesAfterCancelBatch;/);
    // per-root isolation: one failing series never aborts the rest of the batch
    expect(body).toMatch(/try \{\s*results\.push\(await reseedRecurringSeriesAfterCancel\([\s\S]*?\} catch \(e\) \{[\s\S]*?results\.push\(\{ added: \[\], skipped: 'error', parentId: rootId, error: e\.message \}\);/);
  });

  test('locked body: a plan with nothing left upcoming ended — no lone visit is added', () => {
    const body = schedule.slice(
      schedule.indexOf('async function reseedRecurringSeriesAfterCancelLocked('),
      schedule.indexOf('async function reseedRecurringSeriesAfterCancel('),
    );
    const live = body.indexOf('const live = await liveUpcomingSeriesVisits(trx, parentId);');
    const guard = body.indexOf("if (live.length === 0) return { added: [], skipped: 'no_live_visits'");
    const reconcile = body.indexOf('reconcileRecurringSeriesVisitCount(trx, {');
    expect(live).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(live);
    expect(reconcile).toBeGreaterThan(guard);
  });

  test('dispatch: the hook sits in the single-visit cancelled branch, not the series-scope cancel', () => {
    const hook = dispatch.indexOf("source: 'admin-dispatch-status-cancel'");
    const branch = dispatch.lastIndexOf("} else if (toStatus === 'cancelled') {", hook);
    const seriesStop = dispatch.indexOf('recordRecurringSeriesStops(');
    expect(hook).toBeGreaterThan(branch);
    expect(branch).toBeGreaterThan(-1);
    // the series-scope branch (which records the plan stop) comes earlier and returns before this branch
    expect(seriesStop).toBeGreaterThan(-1);
    expect(seriesStop).toBeLessThan(branch);
  });

  test('plan-level cancel paths never call the bridge', () => {
    for (const rel of [
      '../services/cancellation-processor.js',
      '../services/customer-offboarding.js',
      '../services/track-transitions.js',
      '../services/job-status.js',
    ]) {
      expect(read(rel)).not.toMatch(/recurring-series-cancel-reseed/);
    }
  });

  test('the writer is exported from admin-schedule and refuses a caller-open transaction', () => {
    expect(schedule).toMatch(/module\.exports\.reseedRecurringSeriesAfterCancel = reseedRecurringSeriesAfterCancel;/);
    const fn = schedule.slice(schedule.indexOf('async function reseedRecurringSeriesAfterCancel('));
    expect(fn.slice(0, 600)).toMatch(/if \(conn\.isTransaction\) \{\s*throw new Error/);
  });

  test('the locked body takes the maintenance lock, then the comms lock, before any customer/scheduled_services write', () => {
    const body = schedule.slice(
      schedule.indexOf('async function reseedRecurringSeriesAfterCancelLocked('),
      schedule.indexOf('async function reseedRecurringSeriesAfterCancel('),
    );
    const lock = body.indexOf('acquireRecurringSeriesMaintenanceLock(trx, parentId)');
    const comms = body.indexOf('lockCustomerComms(trx, cancelled.customer_id)');
    const forUpdate = body.indexOf('.forUpdate()');
    const reconcile = body.indexOf('reconcileRecurringSeriesVisitCount(trx, {');
    expect(lock).toBeGreaterThan(-1);
    expect(comms).toBeGreaterThan(lock);
    expect(forUpdate).toBeGreaterThan(comms);
    expect(reconcile).toBeGreaterThan(forUpdate);
    // stopped-plan ledger + the top-up's customer/series eligibility rules gate the add
    expect(body).toMatch(/readStoppedRecurringRoots\(trx, \[parent\.customer_id\]\)/);
    expect(body).toMatch(/topupCustomerSkipReason\(customer\)/);
    expect(body).toMatch(/topupSeriesSkipReason\(trx, parent, parentId, cols\)/);
    // extend-only: target = live + 1, no claim token needed
    expect(body).toMatch(/targetCount: live\.length \+ 1/);
    expect(body).toMatch(/claimToken: null/);
  });

  test('idempotent per cancelled visit: the stamp is read under the lock and written in the adding transaction', () => {
    const body = schedule.slice(
      schedule.indexOf('async function reseedRecurringSeriesAfterCancelLocked('),
      schedule.indexOf('async function reseedRecurringSeriesAfterCancel('),
    );
    const lock = body.indexOf('acquireRecurringSeriesMaintenanceLock(trx, parentId)');
    const read = body.indexOf("action: 'recurring_cancel_reseed' })");
    const skip = body.indexOf("skipped: 'already_reseeded'");
    const reconcile = body.indexOf('reconcileRecurringSeriesVisitCount(trx, {');
    const stamp = body.indexOf("action: 'recurring_cancel_reseed',");
    expect(lock).toBeGreaterThan(-1);
    expect(read).toBeGreaterThan(lock);
    expect(skip).toBeGreaterThan(read);
    expect(reconcile).toBeGreaterThan(skip);
    expect(stamp).toBeGreaterThan(reconcile);
    // the stamp keys on the cancelled row, is written on `trx` (same commit as the insert), and only when a row was added
    expect(body).toMatch(/whereRaw\("metadata->>'cancelled_service_id' = \?", \[String\(cancelledServiceId\)\]\)/);
    expect(body.slice(reconcile)).toMatch(/if \(result\.added\.length\) \{\s*\/\/[^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*await trx\('activity_log'\)\.insert\(\{/);
    expect(body.slice(stamp)).toMatch(/cancelled_service_id: String\(cancelledServiceId\)/);
  });
});
