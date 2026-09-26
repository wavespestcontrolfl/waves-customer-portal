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
  runPostCancelSeriesReseed, plannedVisitsPerYearForSeries, termWindowContaining, termWindowAtIndex, assignPlanTerms, countTermVisits,
  isBoosterRow, isPlanSeriesRow, isCountingSourceStatus, cancelEpisodeSourceStatus, planPositionDate, hasUpcomingPlanRow, countUpcomingPlanRows, reseedAnchorFloor, laterCancelledPlanRowIds, isTrimTransitionNote, planReductionGroups,
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
    // cadence positions before the next anniversary = a CEILING (Codex r4): 14-day → 27 (days 0…364), 150-day → 3 (0, 150, 300)
    expect(plannedVisitsPerYearForSeries({ recurring_pattern: 'custom', recurring_interval_days: 14 }, seeder)).toBe(27);
    expect(plannedVisitsPerYearForSeries({ recurring_pattern: 'custom', recurring_interval_days: 150 }, seeder)).toBe(3);
    expect(plannedVisitsPerYearForSeries({ recurring_pattern: 'custom', recurring_interval_days: 365 }, seeder)).toBe(1);
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
    // a known index (a cancelled row an earlier reseed added — its stamp says which term it served)
    expect(termWindowAtIndex('2026-07-10', 0)).toEqual({ index: 0, start: '2026-07-10', end: '2027-07-10' });
    expect(termWindowAtIndex('2026-07-10', 2)).toEqual({ index: 2, start: '2028-07-10', end: '2029-07-10' });
    expect(termWindowAtIndex('2028-02-29', 1)).toEqual({ index: 1, start: '2029-02-28', end: '2030-02-28' });
    expect(termWindowAtIndex('2026-07-10', -1)).toBeNull();
    expect(termWindowAtIndex('2026-07-10', 1.5)).toBeNull();
    expect(termWindowAtIndex(null, 0)).toBeNull();
    expect(termWindowContaining('2026-07-10', 'not-a-date')).toBeNull();
  });

  const child = (r) => ({ is_recurring: true, recurring_parent_id: 'root', ...r });

  test('assignPlanTerms: the k-th plan occurrence (cadence order) is in term floor(k / expected); non-counting rows keep their slot', () => {
    // customer e887e3c6 after the Oct 5 cancel: 9 slots, one cancelled → 8 count in term 0
    const rows = [
      child({ id: 'root', scheduled_date: '2026-07-10', status: 'completed', recurring_parent_id: null }),
      child({ id: 'a', scheduled_date: '2026-09-28', status: 'pending' }),
      child({ id: 'b', scheduled_date: '2026-10-05', status: 'cancelled' }),
      child({ id: 'c', scheduled_date: '2026-11-13', status: 'pending' }),
      child({ id: 'd', scheduled_date: '2026-12-25', status: 'pending' }),
      child({ id: 'e', scheduled_date: '2027-02-05', status: 'pending' }),
      child({ id: 'f', scheduled_date: '2027-03-19', status: 'pending' }),
      child({ id: 'g', scheduled_date: '2027-04-30', status: 'confirmed' }),
      child({ id: 'h', scheduled_date: '2027-06-11', status: 'pending' }),
    ];
    const terms = assignPlanTerms(rows, 9);
    expect([...terms.values()]).toEqual(Array(9).fill(0));
    expect(countTermVisits(rows, 0, terms)).toBe(8);
    // a 10th occurrence opens term 1; it never counts toward term 0
    const more = [...rows, child({ id: 'i', scheduled_date: '2027-07-23', status: 'pending' })];
    const terms2 = assignPlanTerms(more, 9);
    expect(terms2.get('i')).toBe(1);
    expect(countTermVisits(more, 0, terms2)).toBe(8);
    expect(countTermVisits(more, 1, terms2)).toBe(1);
    // no-show/skipped/rescheduled occupy a slot and never count
    const gaps = [...rows, child({ id: 'x', scheduled_date: '2026-08-19', status: 'no_show' })];
    const terms3 = assignPlanTerms(gaps, 9);
    expect(terms3.get('x')).toBe(2 /* slot 2 by date */ === 2 ? 0 : 0);
    expect(terms3.get('h')).toBe(1); // pushed into term 1 by the extra slot
    expect(countTermVisits(gaps, 0, terms3)).toBe(7);
    expect(countTermVisits(rows, 0, null)).toBe(0);
    expect(countTermVisits(rows, 1.5, terms)).toBe(0);
    expect(assignPlanTerms(rows, 0).size).toBe(0);
    expect(assignPlanTerms([], 9).size).toBe(0);
  });

  test('ordinal-weekday monthly: the 13th occurrence a day before the anniversary is term 1, not term 0 (Codex r6)', () => {
    // first Saturday, rooted 2023-01-07; next January's first Saturday is 2024-01-06
    const dates = ['2023-01-07', '2023-02-04', '2023-03-04', '2023-04-01', '2023-05-06', '2023-06-03', '2023-07-01', '2023-08-05', '2023-09-02', '2023-10-07', '2023-11-04', '2023-12-02', '2024-01-06'];
    const rows = dates.map((d, i) => child({ id: `m${i}`, scheduled_date: d, status: i === 0 ? 'completed' : 'pending', recurring_parent_id: i === 0 ? null : 'root' }));
    const terms = assignPlanTerms(rows, 12);
    expect(terms.get('m12')).toBe(1);
    expect(countTermVisits(rows, 0, terms)).toBe(12);
    // cancelling one of the first twelve leaves term 0 short — the 13th cannot mask it
    const cancelled = rows.map((r) => (r.id === 'm5' ? { ...r, status: 'cancelled' } : r));
    expect(countTermVisits(cancelled, 0, assignPlanTerms(cancelled, 12))).toBe(11);
  });

  test('a visit an earlier reseed added counts in the term it served (stamp override), takes no slot, and a cancelled one never counts', () => {
    const rows = [
      child({ id: 'root', scheduled_date: '2026-07-10', status: 'completed', recurring_parent_id: null }),
      child({ id: 'a', scheduled_date: '2026-10-10', status: 'cancelled' }),
      child({ id: 'b', scheduled_date: '2027-01-10', status: 'pending' }),
      child({ id: 'c', scheduled_date: '2027-04-10', status: 'pending' }),
      child({ id: 'readded', scheduled_date: '2027-07-23', status: 'pending' }),
      child({ id: 't1', scheduled_date: '2027-09-03', status: 'pending' }),
    ];
    const overrides = new Map([['readded', 0]]);
    const plain = assignPlanTerms(rows, 4);
    expect(plain.get('readded')).toBe(1); // by slot it would open term 1 …
    const pinned = assignPlanTerms(rows, 4, overrides);
    expect(pinned.get('readded')).toBe(0); // … the stamp pins it to term 0
    expect(pinned.get('t1')).toBe(1);      // and it takes no slot: t1 is the 5th occurrence → term 1
    expect(countTermVisits(rows, 0, pinned)).toBe(4);
    expect(countTermVisits(rows, 1, pinned)).toBe(1);
    expect(countTermVisits(rows.map((r) => (r.id === 'readded' ? { ...r, status: 'cancelled' } : r)), 0, pinned)).toBe(3);
    // ids compare as strings
    expect(assignPlanTerms([child({ id: 42, scheduled_date: '2026-07-10', status: 'pending' })], 4, new Map([['42', 3]])).get('42')).toBe(3);
  });

  test('boosters never count toward the plan; legacy null-flagged children do (Codex #4814)', () => {
    const window = { index: 0, start: '2026-07-10', end: '2027-07-10' };
    const base = Array.from({ length: 8 }, (_, i) => ({ id: `b${i}`, scheduled_date: `2026-0${8}-${String(10 + i).padStart(2, '0')}`, status: 'pending', is_recurring: true, recurring_parent_id: 'root' }));
    const booster = { id: 'boost', scheduled_date: '2026-09-01', status: 'pending', is_recurring: false, recurring_parent_id: 'root' };
    const legacyChild = { id: 'legacy', scheduled_date: '2026-09-02', status: 'pending', is_recurring: null, recurring_parent_id: 'root' };
    const t1 = assignPlanTerms([...base, booster], 9);
    expect(t1.has(String(booster.id))).toBe(false);
    expect(countTermVisits([...base, booster], 0, t1)).toBe(8);
    const t2 = assignPlanTerms([...base, legacyChild], 9);
    expect(countTermVisits([...base, legacyChild], 0, t2)).toBe(9);
    expect(isBoosterRow(booster)).toBe(true);
    expect(isBoosterRow(legacyChild)).toBe(false);
    expect(isPlanSeriesRow(booster)).toBe(false);
    expect(isPlanSeriesRow(legacyChild)).toBe(true);
    expect(isPlanSeriesRow({ is_recurring: true, recurring_parent_id: null })).toBe(true); // the root
    expect(isPlanSeriesRow({ is_recurring: null, recurring_parent_id: null })).toBe(false); // a plain one-off
    expect(isPlanSeriesRow({ is_recurring: false, recurring_parent_id: null })).toBe(false);
    // free re-service callbacks / included follow-ups on a recurring root are never purchased applications (Codex r5)
    expect(isPlanSeriesRow({ is_recurring: true, recurring_parent_id: 'root', is_callback: true })).toBe(false);
    expect(isPlanSeriesRow({ is_recurring: true, recurring_parent_id: 'root', followup_included: true })).toBe(false);
    expect(isBoosterRow({ is_recurring: true, recurring_parent_id: 'root', is_callback: true })).toBe(false);
    const cbRows = [{ id: 'cb', scheduled_date: '2026-09-01', status: 'pending', is_recurring: true, recurring_parent_id: 'root', is_callback: true }];
    expect(assignPlanTerms(cbRows, 4).size).toBe(0);
    expect(countTermVisits(cbRows, 0, new Map([['cb', 0]]))).toBe(0);
    expect(hasUpcomingPlanRow([{ scheduled_date: '2099-01-01', status: 'pending', is_recurring: true, recurring_parent_id: 'root', followup_included: true }], '2026-09-25')).toBe(false);
    expect(COUNTING_SOURCE_STATUSES).toEqual(['pending', 'confirmed', 'en_route', 'on_site']);
    // a legacy NULL status counts as a source (Codex #4814 r2)
    expect(isCountingSourceStatus(null)).toBe(true);
    expect(isCountingSourceStatus(undefined)).toBe(true);
    expect(isCountingSourceStatus('confirmed')).toBe(true);
    expect(isCountingSourceStatus('rescheduled')).toBe(false);
    expect(isCountingSourceStatus('cancelled')).toBe(false);
  });

  test('cancelEpisodeSourceStatus: the newest unbroken run of cancelled rows is the episode; its entering row decides (Codex r7)', () => {
    const t = (from, to) => ({ from_status: from, to_status: to });
    // plain cancel
    expect(cancelEpisodeSourceStatus([t('confirmed', 'cancelled')])).toMatchObject({ fromStatus: 'confirmed' });
    // dispatch same-status retry on top of the real cancel
    expect(cancelEpisodeSourceStatus([t('cancelled', 'cancelled'), t('pending', 'cancelled'), t(null, 'pending')])).toMatchObject({ fromStatus: 'pending' });
    // an OLDER counting cancel compensated back to live, then a placeholder cancelled: only the new episode counts
    expect(cancelEpisodeSourceStatus([t('rescheduled', 'cancelled'), t('cancelled', 'pending'), t('confirmed', 'cancelled')])).toMatchObject({ fromStatus: 'rescheduled' });
    // legacy NULL source
    expect(cancelEpisodeSourceStatus([t(null, 'cancelled')])).toMatchObject({ fromStatus: null });
    // no current episode: newest row is not a cancel, or no history at all
    expect(cancelEpisodeSourceStatus([t('cancelled', 'pending'), t('confirmed', 'cancelled')])).toBeUndefined();
    expect(cancelEpisodeSourceStatus([])).toBeUndefined();
    // the episode key is the ENTERING row's id (else its timestamp): a batch decline recorded against it never outlives a re-cancel
    expect(cancelEpisodeSourceStatus([{ id: 9, ...t('cancelled', 'cancelled') }, { id: 7, ...t('pending', 'cancelled') }]).episodeKey).toBe('7');
    expect(cancelEpisodeSourceStatus([{ transitioned_at: new Date('2026-09-25T10:00:00Z'), ...t('pending', 'cancelled') }]).episodeKey).toBe('2026-09-25T10:00:00.000Z');
    expect(cancelEpisodeSourceStatus([t('pending', 'cancelled')]).episodeKey).toBeNull();
    expect(cancelEpisodeSourceStatus(undefined)).toBeUndefined();
    // the cap's population is the plan rows
    const today = '2026-09-25';
    expect(countUpcomingPlanRows([
      { scheduled_date: '2026-10-01', status: 'pending', is_recurring: null, recurring_parent_id: 'root' },
      { scheduled_date: '2026-10-02', status: 'pending', is_recurring: true, recurring_parent_id: 'root', is_callback: true },
      { scheduled_date: '2026-09-01', status: 'pending', is_recurring: true, recurring_parent_id: 'root' },
      { scheduled_date: '2026-10-03', status: 'cancelled', is_recurring: true, recurring_parent_id: 'root' },
      { scheduled_date: '2026-10-04', status: 'on_site', is_recurring: true, recurring_parent_id: 'root' },
    ], today)).toBe(2);
  });

  test('planReductionGroups: 2+ counting plan rows of one root in the request = a reduction; placeholders, boosters, callbacks and lone rows are not (pre-push audit P1)', () => {
    const rows = [
      { id: 'a1', status: 'pending', is_recurring: true, recurring_parent_id: 'A' },
      { id: 'a2', status: 'confirmed', is_recurring: null, recurring_parent_id: 'A' },  // legacy child counts
      { id: 'A', status: 'pending', is_recurring: true, recurring_parent_id: null },    // the root itself counts
      { id: 'b1', status: 'pending', is_recurring: true, recurring_parent_id: 'B' },
      { id: 'b2', status: 'rescheduled', is_recurring: true, recurring_parent_id: 'B' }, // placeholder: removes nothing
      { id: 'c1', status: 'pending', is_recurring: true, recurring_parent_id: 'C' },
      { id: 'c2', status: 'pending', is_recurring: false, recurring_parent_id: 'C' },   // booster
      { id: 'c3', status: 'pending', is_recurring: true, is_callback: true, recurring_parent_id: 'C' },
      { id: 'd1', status: 'cancelled', is_recurring: true, recurring_parent_id: 'D' },  // already cancelled
      { id: 'd2', status: 'pending', is_recurring: true, recurring_parent_id: 'D' },
    ];
    const out = planReductionGroups(rows);
    expect([...out.keys()].sort()).toEqual(['A', 'a1', 'a2']);
    expect(out.get('a1')).toEqual({ rootId: 'A', groupIds: ['a1', 'a2', 'A'] });
    expect(planReductionGroups([])).toEqual(new Map());
    expect(planReductionGroups(null)).toEqual(new Map());
  });

  test('reseedAnchorFloor: the series END — slot-holding rows, the cancelled row, and other cancelled occurrences unless they were a plan reduction; legacy children count, boosters/callbacks/placeholders do not', () => {
    const rows = [
      { id: 'root', status: 'completed', scheduled_date: '2026-07-10', is_recurring: true, recurring_parent_id: null },
      { id: 'oct', status: 'pending', scheduled_date: '2026-10-10', is_recurring: true, recurring_parent_id: 'root' },
      { id: 'jan', status: 'pending', scheduled_date: '2027-01-10', is_recurring: true, recurring_parent_id: 'root' },
      { id: 'apr', status: 'cancelled', scheduled_date: '2027-04-10', is_recurring: true, recurring_parent_id: 'root' },
    ];
    // cancelling the tail: the anchor is the cancelled April, so the add lands on July
    expect(reseedAnchorFloor(rows, 'apr')).toEqual({ scheduled_date: '2027-04-10' });
    // cancelling a middle visit while April is live: April anchors
    const midCancel = rows.map((r) => (r.id === 'apr' ? { ...r, status: 'pending' } : r.id === 'oct' ? { ...r, status: 'cancelled' } : r));
    expect(reseedAnchorFloor(midCancel, 'oct')).toEqual({ scheduled_date: '2027-04-10' });
    // a LATER occurrence cancelled without a replacement still marks the end (Codex r9 P1):
    // cancelling October after April was cancelled appends after April, never re-books April
    expect(reseedAnchorFloor(rows, 'oct')).toEqual({ scheduled_date: '2027-04-10' });
    // …unless April was a deliberate plan reduction: the plan now ends in January, and the kept count continues on the next slot
    expect(reseedAnchorFloor(rows, 'oct', new Set(['apr']))).toEqual({ scheduled_date: '2027-01-10' });
    // the reduction set never hides the row being reseeded, nor a live row
    expect(reseedAnchorFloor(rows, 'apr', new Set(['apr']))).toEqual({ scheduled_date: '2027-04-10' });
    expect(reseedAnchorFloor(rows, 'oct', new Set(['jan', 'apr']))).toEqual({ scheduled_date: '2027-01-10' });
    // a 'rescheduled' placeholder never anchors (the row it moved to does)
    expect(reseedAnchorFloor([...rows, { id: 'jul', status: 'rescheduled', scheduled_date: '2027-07-10', is_recurring: true, recurring_parent_id: 'root' }], 'apr')).toEqual({ scheduled_date: '2027-04-10' });
    // a legacy null-flagged child moved off its slot anchors by its cadence position
    const legacy = [
      rows[0],
      { id: 'mid', status: 'cancelled', scheduled_date: '2026-10-10', is_recurring: null, recurring_parent_id: 'root' },
      { id: 'tail', status: 'pending', scheduled_date: '2027-02-02', is_recurring: null, recurring_parent_id: 'root', date_exception: true, date_exception_cadence_date: '2027-01-10' },
      { id: 'boost', status: 'pending', scheduled_date: '2027-06-01', is_recurring: false, recurring_parent_id: 'root' },
      { id: 'cb', status: 'pending', scheduled_date: '2027-06-02', is_recurring: true, is_callback: true, recurring_parent_id: 'root' },
    ];
    expect(reseedAnchorFloor(legacy, 'mid')).toEqual({ scheduled_date: '2027-01-10' });
    expect(reseedAnchorFloor([], 'x')).toBeNull();
  });

  test('laterCancelledPlanRowIds: only OTHER cancelled plan rows past every slot-holding row and the cancelled row — the ledger is read for these alone', () => {
    const rows = [
      { id: 'root', status: 'completed', scheduled_date: '2026-07-10', is_recurring: true, recurring_parent_id: null },
      { id: 'oct', status: 'cancelled', scheduled_date: '2026-10-10', is_recurring: true, recurring_parent_id: 'root' },
      { id: 'early', status: 'cancelled', scheduled_date: '2026-08-10', is_recurring: true, recurring_parent_id: 'root' },
      { id: 'jan', status: 'pending', scheduled_date: '2027-01-10', is_recurring: true, recurring_parent_id: 'root' },
      { id: 'apr', status: 'cancelled', scheduled_date: '2027-04-10', is_recurring: true, recurring_parent_id: 'root' },
      { id: 'jul', status: 'cancelled', scheduled_date: '2027-07-10', is_recurring: null, recurring_parent_id: 'root' },
      { id: 'boost', status: 'cancelled', scheduled_date: '2027-09-10', is_recurring: false, recurring_parent_id: 'root' },
      { id: 'moved', status: 'rescheduled', scheduled_date: '2027-10-10', is_recurring: true, recurring_parent_id: 'root' },
    ];
    expect(laterCancelledPlanRowIds(rows, 'oct')).toEqual(['apr', 'jul']);
    // nothing cancelled after the tail → no ledger read at all
    expect(laterCancelledPlanRowIds(rows.filter((r) => !['apr', 'jul'].includes(r.id)), 'oct')).toEqual([]);
    expect(laterCancelledPlanRowIds([], 'x')).toEqual([]);
  });

  test("isTrimTransitionNote: the visit-count trim's own audit note, verbatim", () => {
    expect(isTrimTransitionNote('Recurring plan shortened to 3 visits from Edit appointment')).toBe(true);
    expect(isTrimTransitionNote('Recurring plan shortened to 1 visit from Edit appointment')).toBe(true);
    expect(isTrimTransitionNote('Bulk cancellation')).toBe(false);
    expect(isTrimTransitionNote('note: Recurring plan shortened to 3 visits from Edit appointment')).toBe(false);
    expect(isTrimTransitionNote(null)).toBe(false);
  });

  test('a moved exception keeps its cadence position: ordered (and termed) by its cadence date, not the appointment date (Codex #4814 r2)', () => {
    const moved = child({ id: 'moved', scheduled_date: '2027-07-20', status: 'pending', date_exception: true, date_exception_cadence_date: '2026-10-11' });
    expect(planPositionDate(moved)).toBe('2026-10-11');
    expect(planPositionDate({ scheduled_date: '2027-07-20', date_exception: false, date_exception_cadence_date: '2027-06-11' })).toBe('2027-07-20');
    expect(planPositionDate({ scheduled_date: new Date('2027-07-20T04:00:00Z') })).toBe('2027-07-20');
    expect(planPositionDate(null)).toBeNull();
    // an auto-dispatched row keeps its cadence due date while scheduled_date moved (Codex r8 P2); an exception still wins
    expect(planPositionDate({ scheduled_date: '2027-01-12', recurring_dispatch_due_date: '2027-01-10' })).toBe('2027-01-10');
    expect(planPositionDate({ scheduled_date: '2027-01-12', recurring_dispatch_due_date: '2027-01-10', date_exception: true, date_exception_cadence_date: '2027-01-03' })).toBe('2027-01-03');
    const rows = [
      child({ id: 'root', scheduled_date: '2026-07-10', status: 'completed', recurring_parent_id: null }),
      moved,
      child({ id: 'b', scheduled_date: '2027-01-10', status: 'pending' }),
      child({ id: 'c', scheduled_date: '2027-04-10', status: 'pending' }),
      child({ id: 'd', scheduled_date: '2027-07-10', status: 'pending' }),
    ];
    const terms = assignPlanTerms(rows, 4);
    expect(terms.get('moved')).toBe(0); // slot 1 by cadence date although its appointment sits after 'd'
    expect(terms.get('d')).toBe(1);
  });

  test('a visit an earlier reseed added, then cancelled, re-opens the term it served (fallback P1)', () => {
    const rows = [
      child({ id: 'root', scheduled_date: '2026-07-10', status: 'completed', recurring_parent_id: null }),
      child({ id: 'a', scheduled_date: '2026-10-10', status: 'pending' }),
      child({ id: 'b', scheduled_date: '2027-01-10', status: 'pending' }),
      child({ id: 'c', scheduled_date: '2027-04-10', status: 'cancelled' }),
      child({ id: 'readded', scheduled_date: '2027-07-23', status: 'cancelled' }),
    ];
    const terms = assignPlanTerms(rows, 4, new Map([['readded', 0]]));
    expect(terms.get('readded')).toBe(0);
    expect(countTermVisits(rows, 0, terms)).toBe(3);
  });

  test('hasUpcomingPlanRow reads the plan rows themselves, legacy null-flagged children included', () => {
    const today = '2026-09-25';
    expect(hasUpcomingPlanRow([{ scheduled_date: '2026-10-01', status: 'pending', is_recurring: null, recurring_parent_id: 'root' }], today)).toBe(true);
    expect(hasUpcomingPlanRow([{ scheduled_date: '2026-10-01', status: 'pending', is_recurring: false, recurring_parent_id: 'root' }], today)).toBe(false); // booster
    expect(hasUpcomingPlanRow([{ scheduled_date: '2026-09-01', status: 'pending', is_recurring: true, recurring_parent_id: 'root' }], today)).toBe(false); // past
    expect(hasUpcomingPlanRow([{ scheduled_date: '2026-10-01', status: 'cancelled', is_recurring: true, recurring_parent_id: 'root' }], today)).toBe(false);
    expect(hasUpcomingPlanRow([{ scheduled_date: '2026-09-25', status: 'confirmed', is_recurring: true, recurring_parent_id: null }], today)).toBe(true); // the root, today
    // every counting active state is live (Codex r4): en_route / on_site today, a legacy NULL status; terminal rows are not
    expect(hasUpcomingPlanRow([{ scheduled_date: '2026-09-25', status: 'en_route', is_recurring: true, recurring_parent_id: 'root' }], today)).toBe(true);
    expect(hasUpcomingPlanRow([{ scheduled_date: '2026-09-25', status: 'on_site', is_recurring: true, recurring_parent_id: 'root' }], today)).toBe(true);
    expect(hasUpcomingPlanRow([{ scheduled_date: '2026-10-01', status: null, is_recurring: null, recurring_parent_id: 'root' }], today)).toBe(true);
    expect(hasUpcomingPlanRow([{ scheduled_date: '2026-10-01', status: 'completed', is_recurring: true, recurring_parent_id: 'root' }], today)).toBe(false);
    expect(hasUpcomingPlanRow([{ scheduled_date: '2026-10-01', status: 'rescheduled', is_recurring: true, recurring_parent_id: 'root' }], today)).toBe(false);
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
  const addFn = () => slice('async function addOneReseedVisit(', 'async function reseedRecurringSeriesAfterCancelLocked(');
  const batchFn = () => slice('async function reseedRecurringSeriesAfterCancelBatch(', '// PUT /api/admin/schedule/:id/status');

  test('the four single-visit cancel surfaces call the bridge exactly once each', () => {
    const count = (src, rel) => (src.match(new RegExp(`require\\('${rel.replace(/[./]/g, '\\$&')}'\\)\\.runPostCancelSeriesReseed\\(`, 'g')) || []).length;
    expect(count(dispatch, '../services/recurring-series-cancel-reseed')).toBe(1);
    expect(count(schedule, '../services/recurring-series-cancel-reseed')).toBe(1);
    expect(count(services, '../services/recurring-series-cancel-reseed')).toBe(1);
    // the Intelligence Bar tool: the initial path AND its already-cancelled replay branch (Codex r7)
    expect(count(ib, '../recurring-series-cancel-reseed')).toBe(2);
    expect(ib).toMatch(/source: 'intelligence-bar-cancel-replay'/);
    expect(ib.indexOf("source: 'intelligence-bar-cancel-replay'")).toBeLessThan(ib.indexOf('already_cancelled: true'));
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

  test('bulk cancel: plan-reduction intent is read BEFORE the loop and each row\'s ledger row is written INSIDE its own cancel transaction, ungated (pre-push audit P1)', () => {
    const route = schedule.slice(schedule.indexOf("router.post('/bulk-action'"), schedule.indexOf("serviceIds: cancelReseedIds, source: 'admin-schedule-bulk-cancel'"));
    const intent = route.indexOf("? planReductionGroups(await db('scheduled_services').whereIn('id', serviceIds)");
    const loop = route.indexOf('for (const id of serviceIds) {');
    expect(intent).toBeGreaterThan(-1);
    expect(intent).toBeLessThan(loop);
    expect(route).toMatch(/const bulkPlanReductions = action === 'cancel'/);
    const cancelCase = route.indexOf("case 'cancel': {");
    const trxOpen = route.indexOf('await db.transaction(async (trx) => {', cancelCase);
    const transition = route.indexOf('await transitionJobStatus({', trxOpen);
    const ledger = route.indexOf('await recordReseedDeclines(trx, {', cancelCase);
    // the per-row transaction's own closing line (12-space indent) — the first one after the ledger write
    const trxClose = route.indexOf('\n            });', ledger);
    expect(ledger).toBeGreaterThan(transition);
    expect(ledger).toBeLessThan(route.indexOf('cancelReseedIds.push(id)'));
    expect(trxClose).toBeGreaterThan(ledger);
    expect(route.slice(transition, trxClose)).toMatch(/const reduction = bulkPlanReductions\.get\(String\(id\)\);\s*if \(reduction && isCountingSourceStatus\(fromStatus\)\) \{/);
    expect(route.slice(transition, trxClose)).toMatch(/batchIds: reduction\.groupIds,\s*reason: 'batch_series_cancel'/);
    // written whatever the reseed gate says
    expect(route).not.toMatch(/cancelReseedsRecurringLive/);
    // the post-commit batch no longer writes the ledger (it would duplicate the in-trx rows)
    const batch = schedule.slice(schedule.indexOf('async function reseedRecurringSeriesAfterCancelBatch('));
    expect(batch.slice(0, batch.indexOf('\n}\n'))).not.toMatch(/recordReseedDeclines/);
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

  test('PUT /api/admin/schedule/:id/status refuses cancel before any write, so it needs no hook (fallback auditor false positive on 652b7fda26)', () => {
    const route = schedule.slice(schedule.indexOf("router.put('/:id/status'"), schedule.indexOf("router.put('/:id/status'") + 20000);
    const refuse = route.indexOf("if (toStatus === 'cancelled') {");
    const code = route.indexOf("code: 'USE_DISPATCH_CANCEL'");
    const transition = route.indexOf('transitionJobStatus(');
    expect(refuse).toBeGreaterThan(-1);
    expect(code).toBeGreaterThan(refuse);
    // the refusal comes before this route's own status write
    expect(transition === -1 || transition > code).toBe(true);
    expect(route.slice(refuse, code)).toMatch(/return res\.status\(409\)/);
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
    // the CURRENT cancellation episode decides (Codex r7): full history, newest first, episode helper
    expect(c).toMatch(/\.where\(\{ job_id: cancelledServiceId \}\)[\s\S]*?\.orderBy\('transitioned_at', 'desc'\)[\s\S]*?\.select\('id', 'from_status', 'to_status', 'transitioned_at', 'notes'\)/);
    // a visit-count trim's own audit note refuses the candidate (pre-ledger trims; pre-push audit P1)
    expect(c).toMatch(/if \(isTrimTransitionNote\(episode\.notes\)\) return \{ skipped: 'visit_count_trim' \};/);
    expect(c).toMatch(/const episode = cancelEpisodeSourceStatus\(transitions\);/);
    expect(c).toMatch(/isCountingSourceStatus\(episode\.fromStatus\)/);
    expect(c).not.toMatch(/to_status: 'cancelled'/);
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
    const comms = body.indexOf('const fenced = await lockReseedOwner(trx, cancelledServiceId, cancelled);');
    const refusal = body.indexOf('await reseedRefusal(trx, { parent, parentId, cancelledServiceId, cols, episodeKey: fresh.episodeKey })');
    const term = body.indexOf('await reseedTermShortfall(trx, { parent, parentId, cancelled, cols })');
    const reconcile = body.indexOf('await addOneReseedVisit(trx, { parent, parentId, cols, upcomingPlanCount: term.upcomingPlanCount, anchorFloor: term.anchorFloor })');
    expect(addFn()).toMatch(/reconcileRecurringSeriesVisitCount\(trx, \{/);
    expect(lock).toBeGreaterThan(-1);
    expect(comms).toBeGreaterThan(lock);
    // rung-6 re-lock of a moved owner sits between the comms lock and every dependent read (mirrors the top-up wrapper)
    const fence = body.indexOf('const fenced = await lockReseedOwner(trx, cancelledServiceId, cancelled);');
    const parentRead = body.indexOf("let parent = await trx('scheduled_services').where({ id: parentId }).first();");
    expect(fence).toBeGreaterThan(lock);
    expect(parentRead).toBeGreaterThan(fence);
    expect(body).toMatch(/if \(fenced\.skipped\) return \{ added: \[\], skipped: fenced\.skipped, parentId \};/);
    // the whole row is re-read and re-validated UNDER the fences (Codex r7); a moved lineage/owner is transient
    const revalidate = body.indexOf('const fresh = await readReseedCandidate(trx, cancelledServiceId);');
    expect(revalidate).toBeGreaterThan(fence);
    expect(revalidate).toBeLessThan(parentRead);
    expect(body).toMatch(/String\(fresh\.cancelled\.recurring_parent_id \|\| fresh\.cancelled\.id\) !== String\(parentId\)/);
    expect(body).toMatch(/String\(fresh\.cancelled\.customer_id\) !== String\(fenced\.cancelled\.customer_id\)/);
    expect(body.slice(revalidate, parentRead)).toMatch(/skipped: 'series_changed_retry'/);
    expect(body.slice(revalidate, parentRead)).toMatch(/cancelled = fresh\.cancelled;/);
    const owner = schedule.slice(schedule.indexOf('async function lockReseedOwner('), schedule.indexOf('async function reseedRecurringSeriesAfterCancelLocked('));
    const commsFirst = owner.indexOf('await lockCustomerComms(trx, cancelled.customer_id);');
    const relock = owner.indexOf("first('customer_id')");
    const commsFresh = owner.indexOf('await lockCustomerComms(trx, relocked.customer_id);');
    const again = owner.indexOf("skipped: 'owner_changed_under_fence'");
    expect(commsFirst).toBeGreaterThan(-1);
    expect(relock).toBeGreaterThan(commsFirst);
    expect(commsFresh).toBeGreaterThan(relock);
    expect(again).toBeGreaterThan(commsFresh);
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

  test('term: membership by cadence SLOT over plan rows (exception + callback fields selected), stamps pin earlier re-adds, "nothing upcoming" read from the plan rows themselves', () => {
    const t = termFn();
    expect(t).toMatch(/'is_recurring', 'recurring_parent_id', 'date_exception', 'date_exception_cadence_date', 'is_callback', 'followup_included'\];/);
    // the auto-dispatch due date rides along when the column exists (Codex r8 P2)
    expect(t).toMatch(/if \(cols\.recurring_dispatch_due_date\) seriesCols\.push\('recurring_dispatch_due_date'\);/);
    expect(t).toMatch(/\.select\(seriesCols\);/);
    expect(lockedBody()).toMatch(/reseedTermShortfall\(trx, \{ parent, parentId, cancelled, cols \}\)/);
    // stamps → overrides → slot map → the cancelled row's term → count → liveness, in that order
    const stampsRead = t.indexOf("action: 'recurring_cancel_reseed' })");
    const slots = t.indexOf('assignPlanTerms(seriesRows, expected, termOverrides)');
    const own = t.indexOf("if (termIndex == null) return { skipped: 'not_in_plan_sequence' };");
    const count = t.indexOf('countTermVisits(seriesRows, termIndex, terms)');
    const whole = t.indexOf("skipped: 'term_still_whole'");
    // counted plans only — an ongoing plan is refilled after its final future cancel (Codex r8 P1)
    const guard = t.indexOf("if (!ongoing && !hasUpcomingPlanRow(seriesRows, todayET)) return { skipped: 'no_live_visits'");
    expect(t).toMatch(/const ongoing = parent\.recurring_ongoing === true;/);
    // the cap counts the same plan-row population (Codex r7)
    expect(t).toMatch(/const upcomingPlanCount = countUpcomingPlanRows\(seriesRows, todayET\);/);
    expect(t).toMatch(/const reductionIds = await readPlanReductionIds\(trx, \{\s*customerId: parent\.customer_id, parentId, candidateIds: laterCancelledPlanRowIds\(seriesRows, cancelled\.id\),\s*\}\);/);
    expect(t).toMatch(/return \{ window, counting, expected, upcomingPlanCount, anchorFloor: reseedAnchorFloor\(seriesRows, cancelled\.id, reductionIds\) \};/);
    const add = addFn();
    expect(add).toMatch(/if \(upcomingPlanCount >= MAX_SERIES_VISIT_COUNT\) return \{ skipped: 'at_max_visit_count' \};/);
    expect(add.indexOf('upcomingPlanCount >= MAX_SERIES_VISIT_COUNT')).toBeLessThan(add.indexOf('reconcileRecurringSeriesVisitCount(trx'));
    // no caller-side live read: its broader is_recurring population is what the reconciler clamp keyed on (Codex r8 P1)
    expect(add).not.toMatch(/liveUpcomingSeriesVisits/);
    expect(add).not.toMatch(/live\.length >= MAX_SERIES_VISIT_COUNT/);
    expect(lockedBody()).toMatch(/upcomingPlanCount: term\.upcomingPlanCount/);
    expect(stampsRead).toBeGreaterThan(-1);
    expect(slots).toBeGreaterThan(stampsRead);
    expect(own).toBeGreaterThan(slots);
    expect(count).toBeGreaterThan(own);
    expect(whole).toBeGreaterThan(count);
    expect(guard).toBeGreaterThan(whole);
    expect(t).toMatch(/whereRaw\("metadata->>'recurring_parent_id' = \?", \[String\(parentId\)\]\)/);
    expect(t).toMatch(/termOverrides\.set\(String\(id\), meta\.term_index\)/);
    // no date-window membership anywhere in the writer
    expect(t).not.toMatch(/termWindowContaining\(/);
    expect(t).toMatch(/termWindowAtIndex\(planPositionDate\(parent\), termIndex\)/);
    expect(lockedBody()).not.toMatch(/live\.length === 0/);
  });

  test("exactly one visit: extendByOne sets target = the reconciler's own live + 1, unclamped; a 409 refuses; no claim token", () => {
    const body = addFn();
    expect(body).toMatch(/extendByOne: true,/);
    // the cancelled row is the extend anchor's cadence floor (pre-push audit P1: cancelling the LAST visit re-booked its date)
    expect(body).toMatch(/cadenceFloorRow: anchorFloor,/);
    expect(lockedBody()).toMatch(/addOneReseedVisit\(trx, \{ parent, parentId, cols, upcomingPlanCount: term\.upcomingPlanCount, anchorFloor: term\.anchorFloor \}\)/);
    expect(body).not.toMatch(/targetCount:|baselineCount:/);
    expect(body).toMatch(/claimToken: null/);
    expect(body).toMatch(/if \(e\?\.statusCode === 409\) return \{ skipped: 'extension_unbillable', code: e\.code \|\| null \};/);
    // the reconciler: extendByOne reads live FIRST and skips the MAX_SERIES_VISIT_COUNT clamp (Codex r8 P1)
    const rec = schedule.slice(schedule.indexOf('async function reconcileRecurringSeriesVisitCount('));
    expect(rec).toMatch(/extendByOne = false,[\s\S]*?cadenceFloorRow = null,\s*\}\) \{\s*const live = await liveUpcomingSeriesVisits\(trx, parentId\);\s*const target = extendByOne\s*\? live\.length \+ 1\s*: Math\.min\(Math\.max\(parseInt\(targetCount, 10\) \|\| 0, 1\), MAX_SERIES_VISIT_COUNT\);/);
    // the wrapper retries the WHOLE locked transaction on that transient refusal (Codex r3), bounded
    const wrapper = schedule.slice(schedule.indexOf('async function reseedRecurringSeriesAfterCancel('), schedule.indexOf('async function reseedRecurringSeriesAfterCancelBatch('));
    expect(schedule).toMatch(/const RESEED_STALE_READ_ATTEMPTS = 3;/);
    expect(wrapper).toMatch(/for \(let attempt = 1; attempt <= RESEED_STALE_READ_ATTEMPTS; attempt \+= 1\) \{\s*result = await conn\.transaction\(\(trx\) => reseedRecurringSeriesAfterCancelLocked\(trx, cancelledServiceId\)\);\s*if \(!RESEED_TRANSIENT_SKIPS\.includes\(result\.skipped\)\) break;/);
    expect(schedule).toMatch(/const RESEED_TRANSIENT_SKIPS = \['series_changed_retry', 'owner_changed_under_fence'\];/);
  });

  test('legacy off-hour root windows are floored/validated like the top-up; each added row gets the advisory occupancy probe; then the stamp', () => {
    const add = addFn();
    const normalize = add.indexOf('normalizeTopUpWindow(parent.window_start, parent.estimated_duration_minutes, parent.window_end)');
    const unplaceable = add.indexOf("skipped: 'window_unplaceable'");
    const reconcile = add.indexOf('reconcileRecurringSeriesVisitCount(trx, {');
    expect(normalize).toBeGreaterThan(-1);
    expect(unplaceable).toBeGreaterThan(normalize);
    expect(reconcile).toBeGreaterThan(unplaceable);
    expect(add).toMatch(/parentId, parent: reconcileParent, cols,/);
    const body = lockedBody();
    const addCall = body.indexOf('await addOneReseedVisit(trx, { parent, parentId, cols })');
    const probe = body.indexOf('await probeReseedOverlaps(trx, { parent: add.reconcileParent, parentId, added: add.added })');
    const stamp = body.indexOf('await stampReseed(trx,');
    expect(probe).toBeGreaterThan(addCall);
    expect(stamp).toBeGreaterThan(probe);
    expect(body.slice(probe)).toMatch(/if \(add\.added\.length\) \{\s*await stampReseed\(trx,/);
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
    // a job qualifies when its CURRENT cancellation episode left a counting status (Codex r7)
    expect(b).toMatch(/\.whereIn\('job_id', ids\)[\s\S]*?\.select\('id', 'job_id', 'from_status', 'to_status', 'transitioned_at'\)/);
    expect(b).toMatch(/const episode = cancelEpisodeSourceStatus\(history\);\s*if \(episode && isCountingSourceStatus\(episode\.fromStatus\)\) countingCancel\.add\(key\);/);
    expect(b).toMatch(/if \(!countingCancel\.has\(String\(row\.id\)\)\) continue;/);
    expect(b).not.toMatch(/\.where\('to_status', 'cancelled'\)/);
    expect(b).toMatch(/if \(!isPlanSeriesRow\(row\)\) continue;/);
    expect(b).toMatch(/\.select\('id', 'is_recurring', 'recurring_parent_id', 'is_callback', 'followup_included'\)/);
    expect(b).not.toMatch(/row\.is_recurring !== true/);
    expect(b).toMatch(/if \(cancelledIds\.length > 1\) \{[\s\S]*?skipped: 'batch_series_cancel'/);
    // the decline ledger is written by the bulk route inside each row's cancel transaction, not here
    expect(b).not.toMatch(/recordReseedDeclines/);
    // …and the visit-count trim records the same ledger inside its own transaction, after its cancels
    const rec = schedule.slice(schedule.indexOf('async function reconcileRecurringSeriesVisitCount('));
    expect(rec).toMatch(/result\.cancelledIds\.push\(visit\.id\);\s*\}[\s\S]*?await recordReseedDeclines\(trx, \{\s*customerId: parent\.customer_id, rootId: parentId, cancelledIds: result\.cancelledIds, reason: 'visit_count_trim'/);
    expect(b).toMatch(/try \{\s*results\.push\(await reseedRecurringSeriesAfterCancel\([\s\S]*?\} catch \(e\) \{[\s\S]*?results\.push\(\{ added: \[\], skipped: 'error', parentId: rootId, error: e\.message \}\);/);
  });
});
