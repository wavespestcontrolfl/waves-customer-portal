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
  isBoosterRow, isPlanSeriesRow, isCountingSourceStatus, planPositionDate, hasUpcomingPlanRow,
  COUNTING_SOURCE_STATUSES,
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
    // Codex #4814 r2: the nth-weekday monthly spelling is a monthly cadence, 12 a year (never the 4 default)
    expect(plannedVisitsPerYearForSeries({ recurring_pattern: 'monthly_nth_weekday' }, { ...seeder, normalizeRecurringPattern: () => null })).toBe(12);
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
    // Codex #4814 P2: the CLAMPED anniversary (Feb 28 in a non-leap year) opens the new term
    expect(termWindowContaining('2028-02-29', '2029-02-28')).toEqual({ index: 1, start: '2029-02-28', end: '2030-02-28' });
    expect(termWindowContaining('2028-02-29', '2029-02-27')).toEqual({ index: 0, start: '2028-02-29', end: '2029-02-28' });
    expect(termWindowContaining('2028-02-29', '2032-02-29')).toEqual({ index: 4, start: '2032-02-29', end: '2033-02-28' });
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

  test('boosters never count toward the plan; legacy null-flagged children do (Codex #4814)', () => {
    const window = { index: 0, start: '2026-07-10', end: '2027-07-10' };
    const base = Array.from({ length: 8 }, (_, i) => ({ scheduled_date: `2026-0${8}-${String(10 + i).padStart(2, '0')}`, status: 'pending', is_recurring: true, recurring_parent_id: 'root' }));
    const booster = { scheduled_date: '2026-09-01', status: 'pending', is_recurring: false, recurring_parent_id: 'root' };
    const legacyChild = { scheduled_date: '2026-09-02', status: 'pending', is_recurring: null, recurring_parent_id: 'root' };
    expect(countTermVisits([...base, booster], window)).toBe(8);
    expect(countTermVisits([...base, legacyChild], window)).toBe(9);
    expect(isBoosterRow(booster)).toBe(true);
    expect(isBoosterRow(legacyChild)).toBe(false);
    expect(isPlanSeriesRow(booster)).toBe(false);
    expect(isPlanSeriesRow(legacyChild)).toBe(true);
    expect(isPlanSeriesRow({ is_recurring: true, recurring_parent_id: null })).toBe(true); // the root
    expect(isPlanSeriesRow({ is_recurring: null, recurring_parent_id: null })).toBe(false); // a plain one-off
    expect(isPlanSeriesRow({ is_recurring: false, recurring_parent_id: null })).toBe(false);
    expect(COUNTING_SOURCE_STATUSES).toEqual(['pending', 'confirmed', 'en_route', 'on_site']);
    // a legacy NULL status counts as a source (Codex #4814 r2)
    expect(isCountingSourceStatus(null)).toBe(true);
    expect(isCountingSourceStatus(undefined)).toBe(true);
    expect(isCountingSourceStatus('confirmed')).toBe(true);
    expect(isCountingSourceStatus('rescheduled')).toBe(false);
    expect(isCountingSourceStatus('cancelled')).toBe(false);
  });

  test('a moved exception keeps its cadence position for term selection and counting (Codex #4814 r2)', () => {
    const window = { index: 0, start: '2026-07-10', end: '2027-07-10' };
    const moved = { scheduled_date: '2027-07-20', status: 'pending', date_exception: true, date_exception_cadence_date: '2027-06-11', is_recurring: true, recurring_parent_id: 'root' };
    expect(planPositionDate(moved)).toBe('2027-06-11');
    expect(planPositionDate({ scheduled_date: '2027-07-20', date_exception: false, date_exception_cadence_date: '2027-06-11' })).toBe('2027-07-20');
    expect(planPositionDate({ scheduled_date: new Date('2027-07-20T04:00:00Z') })).toBe('2027-07-20');
    expect(planPositionDate(null)).toBeNull();
    // counts in the ORIGINAL term although its appointment sits in the next one
    expect(countTermVisits([moved], window)).toBe(1);
    expect(countTermVisits([moved], { index: 1, start: '2027-07-10', end: '2028-07-10' })).toBe(0);
    // and the term is chosen by that position
    expect(termWindowContaining('2026-07-10', planPositionDate(moved)).index).toBe(0);
  });

  test('a visit an earlier reseed added counts in the term it replaced a visit in, not where its date falls (fallback P1)', () => {
    const term0 = { index: 0, start: '2026-07-10', end: '2027-07-10' };
    const term1 = { index: 1, start: '2027-07-10', end: '2028-07-10' };
    const readded = { id: 'readded', scheduled_date: '2027-07-23', status: 'pending', is_recurring: true, recurring_parent_id: 'root' };
    const term1Visit = { id: 't1', scheduled_date: '2027-09-03', status: 'pending', is_recurring: true, recurring_parent_id: 'root' };
    const overrides = new Map([['readded', 0]]);
    // by date it sits in term 1 …
    expect(countTermVisits([readded, term1Visit], term1)).toBe(2);
    expect(countTermVisits([readded, term1Visit], term0)).toBe(0);
    // … with the stamp it counts in term 0 only
    expect(countTermVisits([readded, term1Visit], term1, overrides)).toBe(1);
    expect(countTermVisits([readded, term1Visit], term0, overrides)).toBe(1);
    // a cancelled re-added visit never counts anywhere
    expect(countTermVisits([{ ...readded, status: 'cancelled' }], term0, overrides)).toBe(0);
    // ids compare as strings
    expect(countTermVisits([{ ...readded, id: 42 }], term0, new Map([['42', 0]]))).toBe(1);
  });

  test('hasUpcomingPlanRow reads the plan rows themselves, legacy null-flagged children included', () => {
    const today = '2026-09-25';
    expect(hasUpcomingPlanRow([{ scheduled_date: '2026-10-01', status: 'pending', is_recurring: null, recurring_parent_id: 'root' }], today)).toBe(true);
    expect(hasUpcomingPlanRow([{ scheduled_date: '2026-10-01', status: 'pending', is_recurring: false, recurring_parent_id: 'root' }], today)).toBe(false); // booster
    expect(hasUpcomingPlanRow([{ scheduled_date: '2026-09-01', status: 'pending', is_recurring: true, recurring_parent_id: 'root' }], today)).toBe(false); // past
    expect(hasUpcomingPlanRow([{ scheduled_date: '2026-10-01', status: 'cancelled', is_recurring: true, recurring_parent_id: 'root' }], today)).toBe(false);
    expect(hasUpcomingPlanRow([{ scheduled_date: '2026-09-25', status: 'confirmed', is_recurring: true, recurring_parent_id: null }], today)).toBe(true); // the root, today
    expect(hasUpcomingPlanRow([], today)).toBe(false);
  });
});

describe('cancel surfaces wire the hook (source guards)', () => {
  const dispatch = read('../routes/admin-dispatch.js');
  const schedule = read('../routes/admin-schedule.js');
  const services = read('../routes/admin-services.js');
  const ib = read('../services/intelligence-bar/tools.js');
  // Slices of the split writer in admin-schedule.js: each helper runs from
  // its `function <name>(` to the next marker.
  const slice = (startMarker, endMarker) => {
    const a = schedule.indexOf(startMarker);
    const b = schedule.indexOf(endMarker, a + 1);
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    return schedule.slice(a, b);
  };
  const candidateFn = () => slice('async function readReseedCandidate(', 'async function reseedRefusal(');
  const refusalFn = () => slice('async function reseedRefusal(', 'async function reseedTermShortfall(');
  const termFn = () => slice('async function reseedTermShortfall(', 'async function probeReseedOverlaps(');
  const probeFn = () => slice('async function probeReseedOverlaps(', 'function stampReseed(');
  const stampFn = () => slice('function stampReseed(', 'async function reseedRecurringSeriesAfterCancelLocked(');
  const lockedBody = () => slice('async function reseedRecurringSeriesAfterCancelLocked(', 'async function reseedRecurringSeriesAfterCancel(');
  const batchFn = () => slice('async function reseedRecurringSeriesAfterCancelBatch(', '// PUT /api/admin/schedule/:id/status');

  test('the four single-visit cancel surfaces call the bridge exactly once each', () => {
    const count = (src, rel) => (src.match(new RegExp(`require\\('${rel.replace(/[./]/g, '\\$&')}'\\)\\.runPostCancelSeriesReseed\\(`, 'g')) || []).length;
    expect(count(dispatch, '../services/recurring-series-cancel-reseed')).toBe(1);
    expect(count(schedule, '../services/recurring-series-cancel-reseed')).toBe(1);
    expect(count(services, '../services/recurring-series-cancel-reseed')).toBe(1);
    expect(count(ib, '../recurring-series-cancel-reseed')).toBe(1);
  });

  test('bulk cancel: collects real transitions right after the commit (before fallible post-commit work) and calls the bridge ONCE after the batch settled', () => {
    const route = schedule.slice(schedule.indexOf("router.post('/bulk-action'"));
    const collect = route.indexOf("if (fromStatus !== 'cancelled') cancelReseedIds.push(id);");
    const cancelCase = route.indexOf("case 'cancel': {");
    const notify = route.indexOf('AppointmentReminders.handleCancellation(id, {', cancelCase);
    const voidCall = route.indexOf('await voidOpenInvoicesForCancelledService(id);', cancelCase);
    expect(route.split('cancelReseedIds.push(id)').length - 1).toBe(1);
    expect(collect).toBeGreaterThan(cancelCase);
    expect(collect).toBeLessThan(notify);
    expect(collect).toBeLessThan(voidCall);
    const flush = route.indexOf('await flushDispatchQualityDates(qualityDates);');
    const call = route.indexOf("serviceIds: cancelReseedIds, source: 'admin-schedule-bulk-cancel'");
    const respond = route.indexOf('res.json({');
    expect(flush).toBeGreaterThan(collect);
    expect(call).toBeGreaterThan(flush);
    expect(respond).toBeGreaterThan(call);
    expect(route.slice(0, flush)).not.toMatch(/runPostCancelSeriesReseed/);
  });

  test('dispatch: the hook sits in the single-visit cancelled branch, not the series-scope cancel', () => {
    const hook = dispatch.indexOf("source: 'admin-dispatch-status-cancel'");
    const branch = dispatch.lastIndexOf("} else if (toStatus === 'cancelled') {", hook);
    const seriesStop = dispatch.indexOf('recordRecurringSeriesStops(');
    expect(hook).toBeGreaterThan(branch);
    expect(branch).toBeGreaterThan(-1);
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

  test('the writers are exported from admin-schedule and the single writer refuses a caller-open transaction', () => {
    expect(schedule).toMatch(/module\.exports\.reseedRecurringSeriesAfterCancel = reseedRecurringSeriesAfterCancel;/);
    expect(schedule).toMatch(/module\.exports\.reseedRecurringSeriesAfterCancelBatch = reseedRecurringSeriesAfterCancelBatch;/);
    const fn = schedule.slice(schedule.indexOf('async function reseedRecurringSeriesAfterCancel('));
    expect(fn.slice(0, 600)).toMatch(/if \(conn\.isTransaction\) \{\s*throw new Error/);
  });

  test('candidate read: only an audited counting→cancelled transition of a plan row earns a replacement (legacy NULL status counts), before any lock', () => {
    const c = candidateFn();
    const planRow = c.indexOf("if (!isPlanSeriesRow(cancelled)) return { skipped: 'not_plan_visit' };");
    const history = c.indexOf("trx('job_status_history')");
    const noRecord = c.indexOf("skipped: 'no_transition_record'");
    const nonCounting = c.indexOf("skipped: 'non_counting_transition'");
    expect(planRow).toBeGreaterThan(-1);
    expect(history).toBeGreaterThan(planRow);
    expect(noRecord).toBeGreaterThan(history);
    expect(nonCounting).toBeGreaterThan(noRecord);
    expect(c).toMatch(/\.where\(\{ job_id: cancelledServiceId, to_status: 'cancelled' \}\)[\s\S]*?\.orderBy\('transitioned_at', 'desc'\)/);
    expect(c).toMatch(/isCountingSourceStatus\(transition\.from_status\)/);
    const body = lockedBody();
    const candidate = body.indexOf('await readReseedCandidate(trx, cancelledServiceId)');
    const lock = body.indexOf('acquireRecurringSeriesMaintenanceLock(trx, parentId)');
    expect(candidate).toBeGreaterThan(-1);
    expect(lock).toBeGreaterThan(candidate);
    expect(body).not.toMatch(/cancelled\.is_recurring !== true/);
  });

  test('locked body: maintenance lock → comms lock → refusals (stopped ledger → stamp → customers FOR UPDATE → prepay TRY-lock → series rules) → term → reconcile', () => {
    const body = lockedBody();
    const lock = body.indexOf('acquireRecurringSeriesMaintenanceLock(trx, parentId)');
    const comms = body.indexOf('lockCustomerComms(trx, cancelled.customer_id)');
    const refusal = body.indexOf('await reseedRefusal(trx, { parent, parentId, cancelledServiceId, cols })');
    const term = body.indexOf('await reseedTermShortfall(trx, { parent, parentId, cancelled })');
    const reconcile = body.indexOf('reconcileRecurringSeriesVisitCount(trx, {');
    expect(lock).toBeGreaterThan(-1);
    expect(comms).toBeGreaterThan(lock);
    expect(refusal).toBeGreaterThan(comms);
    expect(term).toBeGreaterThan(refusal);
    expect(reconcile).toBeGreaterThan(term);
    const r = refusalFn();
    const stopped = r.indexOf('readStoppedRecurringRoots(trx, [parent.customer_id])');
    const stamp = r.indexOf("action: 'recurring_cancel_reseed' })");
    const forUpdate = r.indexOf('.forUpdate()');
    const prepay = r.indexOf('pg_try_advisory_xact_lock(?, hashtext(?))');
    const series = r.indexOf('topupSeriesSkipReason(trx, parent, parentId, cols)');
    expect(stopped).toBeGreaterThan(-1);
    expect(stamp).toBeGreaterThan(stopped);
    expect(forUpdate).toBeGreaterThan(stamp);
    expect(prepay).toBeGreaterThan(forUpdate);
    expect(series).toBeGreaterThan(prepay);
    expect(r).toMatch(/ANNUAL_PREPAY_LOCK_NS/);
    expect(r).toMatch(/if \(!advisoryTryLockAcquired\(prepayLockResult\)\) return 'annual_prepay_busy';/);
    expect(r).toMatch(/topupCustomerSkipReason\(customer\)/);
    expect(r).toMatch(/whereRaw\("metadata->>'cancelled_service_id' = \?", \[String\(cancelledServiceId\)\]\)/);
  });

  test('term: chosen by the cancelled row\'s PLAN position, counted by plan position over plan rows (exception fields selected), and "nothing upcoming" read from the plan rows themselves', () => {
    const t = termFn();
    expect(t).toMatch(/termWindowContaining\(parent\.scheduled_date, planPositionDate\(cancelled\)\)/);
    expect(t).toMatch(/'is_recurring', 'recurring_parent_id', 'date_exception', 'date_exception_cadence_date'\)/);
    const count = t.indexOf('countTermVisits(seriesRows, window, termOverrides)');
    const whole = t.indexOf("skipped: 'term_still_whole'");
    // earlier reseeds' stamps pin their added rows to the term they served
    expect(t).toMatch(/whereRaw\("metadata->>'recurring_parent_id' = \?", \[String\(parentId\)\]\)/);
    expect(t).toMatch(/termOverrides\.set\(String\(id\), meta\.term_index\)/);
    expect(t.indexOf("action: 'recurring_cancel_reseed' })")).toBeLessThan(count);
    const guard = t.indexOf("if (!hasUpcomingPlanRow(seriesRows, etDateString())) return { skipped: 'no_live_visits'");
    expect(count).toBeGreaterThan(-1);
    expect(whole).toBeGreaterThan(count);
    expect(guard).toBeGreaterThan(whole);
    expect(lockedBody()).not.toMatch(/live\.length === 0/);
  });

  test('exactly one visit: target = live + 1 fenced by baselineCount = live; a 409 refuses instead of over-adding; no claim token', () => {
    const body = lockedBody();
    expect(body).toMatch(/targetCount: live\.length \+ 1,\s*baselineCount: live\.length,/);
    expect(body).toMatch(/claimToken: null/);
    expect(body).toMatch(/if \(e\?\.statusCode === 409\) return \{ added: \[\], skipped: 'series_changed_retry'/);
  });

  test('legacy off-hour root windows are floored/validated like the top-up; each added row gets the advisory occupancy probe; then the stamp', () => {
    const body = lockedBody();
    const normalize = body.indexOf('normalizeTopUpWindow(parent.window_start, parent.estimated_duration_minutes, parent.window_end)');
    const unplaceable = body.indexOf("skipped: 'window_unplaceable'");
    const reconcile = body.indexOf('reconcileRecurringSeriesVisitCount(trx, {');
    const probe = body.indexOf('await probeReseedOverlaps(trx, { parent: reconcileParent, parentId, added: result.added })');
    const stamp = body.indexOf('await stampReseed(trx,');
    expect(normalize).toBeGreaterThan(-1);
    expect(unplaceable).toBeGreaterThan(normalize);
    expect(reconcile).toBeGreaterThan(unplaceable);
    expect(body).toMatch(/parentId, parent: reconcileParent, cols,/);
    expect(probe).toBeGreaterThan(reconcile);
    expect(stamp).toBeGreaterThan(probe);
    expect(body.slice(probe)).toMatch(/if \(result\.added\.length\) \{\s*await stampReseed\(trx,/);
    const p = probeFn();
    expect(p).toMatch(/findConflictingVisits\(\{/);
    expect(p).toMatch(/excludeServiceIds: \[child\.id\], excludeStatuses: ADMIN_OCCUPANCY_EXCLUDE_STATUSES,/);
    expect(p).not.toMatch(/throw /);
    const s = stampFn();
    expect(s).toMatch(/action: 'recurring_cancel_reseed',/);
    expect(s).toMatch(/cancelled_service_id: String\(cancelledServiceId\)/);
    expect(s).toMatch(/overlap_dates: overlapDates/);
  });

  test('batch writer: only audited counting→cancelled transitions take part; 2+ of one plan = plan reduction, never a refill; per-root isolation', () => {
    const b = batchFn();
    expect(b).toMatch(/conn\('job_status_history'\)[\s\S]*?\.whereIn\('job_id', ids\)\.where\('to_status', 'cancelled'\)/);
    expect(b).toMatch(/if \(!sourceStatus\.has\(String\(row\.id\)\) \|\| !isCountingSourceStatus\(sourceStatus\.get\(String\(row\.id\)\)\)\) continue;/);
    expect(b).toMatch(/if \(!isPlanSeriesRow\(row\)\) continue;/);
    expect(b).not.toMatch(/row\.is_recurring !== true/);
    expect(b).toMatch(/if \(cancelledIds\.length > 1\) \{[\s\S]*?skipped: 'batch_series_cancel'/);
    expect(b).toMatch(/try \{\s*results\.push\(await reseedRecurringSeriesAfterCancel\([\s\S]*?\} catch \(e\) \{[\s\S]*?results\.push\(\{ added: \[\], skipped: 'error', parentId: rootId, error: e\.message \}\);/);
  });
});
