jest.mock('../models/db', () => ({}));
const { summarizeDurationReferences } = require('../services/scheduling/duration-priors');
const { recordedTiming } = require('../services/scheduling/route-performance');
const { buildCloseoutRequirementsSnapshot } = require('../services/service-closeout-requirements');
const { parseETDateTime } = require('../utils/datetime-et');

const serviceId = 'e09b4aaf-ad28-4c62-a4cf-383d2b72b7e5';
function completed(minutes = 45, date = '2026-09-01', extra = {}) {
  const start = parseETDateTime(`${date}T08:00`);
  const end = new Date(start.getTime() + minutes * 60000);
  return { scheduled_date: date, status: 'completed', actual_start_time: start, actual_end_time: end,
    completionNotes: { closeoutRequirements: buildCloseoutRequirementsSnapshot({
      serviceId, requiresServiceReport: false, source: 'catalog',
    }, { now: end }) },
    statusHistory: [
      { from_status: 'confirmed', to_status: 'on_site', transitioned_at: start },
      { from_status: 'on_site', to_status: 'completed', transitioned_at: end },
    ], ...extra };
}
const summarize = rows => summarizeDurationReferences(rows, recordedTiming);

test('insufficient samples cannot become a shorter scheduling estimate', () => {
  const result = summarize([completed(10), completed(20), completed(30), completed(40)]);
  expect(result).toMatchObject({ acceptedVisits: 4, minimumReferenceSamples: 5, automaticApplication: false,
    byService: [{ serviceId, samples: 4, serviceDays: 1, status: 'insufficient_samples',
      medianMinutes: null, p80Minutes: null, observedMinimumMinutes: 10, observedMaximumMinutes: 40,
      earlierDayEvaluation: { visits: 0, meanAbsoluteErrorMinutes: null, overrunRate: null } }] });
  expect(summarize([])).toMatchObject({ acceptedVisits: 0, byService: [], excluded: {} });
});

test('enough samples yield only provisional references and no same-day evaluation', () => {
  expect(summarize([50, 20, 10, 40, 30].map(value => completed(value))).byService).toEqual([
    expect.objectContaining({ samples: 5, status: 'provisional_reference', medianMinutes: 30, p80Minutes: 40,
      serviceDays: 1, firstDate: '2026-09-01', lastDate: '2026-09-01',
      earlierDayEvaluation: { basis: 'p80_of_earlier_service_days', visits: 0,
        meanAbsoluteErrorMinutes: null, overrunRate: null } }),
  ]);
});

test('each error uses only earlier days in its service cohort, including the minimum sample floor', () => {
  const rows = [10, 20, 30, 40, 50].map(value => completed(value));
  rows.push(completed(100, '2026-09-02'), completed(20, '2026-09-02'), completed(30, '2026-09-03'));
  const before = JSON.stringify(rows);
  const result = summarize([...rows].reverse());
  expect(result.byService[0]).toMatchObject({ samples: 8, serviceDays: 3, medianMinutes: 30, p80Minutes: 50,
    earlierDayEvaluation: { visits: 3, meanAbsoluteErrorMinutes: 100 / 3, overrunRate: 1 / 3 } });
  expect(JSON.stringify(rows)).toBe(before);
  expect(summarize(rows.slice(0, 7)).byService[0].earlierDayEvaluation).toMatchObject({
    visits: 2, meanAbsoluteErrorMinutes: 40, overrunRate: 0.5,
  });
  expect(summarize([...rows.slice(0, 4), completed(50, '2026-09-02')]).byService[0].earlierDayEvaluation.visits).toBe(0);
});

test('the completion-time catalog identity survives a changed live service and separates cohorts', () => {
  const row = completed(45, '2026-09-01', { service_id: 'later-service', service_type: 'Later service name' });
  const other = completed(90);
  other.completionNotes.closeoutRequirements.serviceId = '5fd452a7-0725-4a20-a27b-76f2c87deca0';
  row.completionNotes = JSON.stringify(row.completionNotes);
  expect(summarize([row, other]).byService).toEqual([
    expect.objectContaining({ serviceId: '5fd452a7-0725-4a20-a27b-76f2c87deca0', samples: 1, observedMinimumMinutes: 90 }),
    expect.objectContaining({ serviceId, samples: 1, observedMinimumMinutes: 45 }),
  ]);
});

test.each([
  ['missing', snapshot => { delete snapshot.frozenAt; }],
  ['late', snapshot => { snapshot.frozenAt = '2026-09-01T13:00:00Z'; }],
  ['backfilled', snapshot => { snapshot.source = 'backfilled_from_live_catalog'; }],
  ['missing identity', snapshot => { snapshot.serviceId = null; }],
  ['malformed identity', snapshot => { snapshot.serviceId = {}; }],
  ['malformed snapshot', snapshot => { delete snapshot.requiresServiceReport; }],
])('%s service identity is excluded instead of falling back to the current catalog', (_label, change) => {
  const row = completed();
  change(row.completionNotes.closeoutRequirements);
  expect(summarize([row])).toMatchObject({ acceptedVisits: 0, byService: [],
    excluded: { service_identity_not_frozen_at_completion: 1 } });
});

test('grouped work, callbacks and included follow-ups cannot dilute a standard service cohort', () => {
  expect(summarize([completed(45, '2026-09-01', { visit_id: 'group' }),
    completed(5, '2026-09-01', { is_callback: true }), completed(5, '2026-09-01', { followup_included: true })]))
    .toMatchObject({ acceptedVisits: 0, byService: [], excluded: { grouped_work: 1, callback_or_included_followup: 2 } });
});

test('operator corrections, reports, backfills, inferred and invalid intervals remain excluded by source', () => {
  const backfill = completed();
  backfill.completionNotes.backfill = true;
  backfill.completionNotes.timeOnSite = 30;
  const report = completed();
  report.completionNotes.timeOnSite = 30;
  const inferred = completed(45, '2026-09-01', { statusHistory: [] });
  expect(summarize([backfill, report, inferred, completed(45, '2026-09-01', { time_on_site_adjusted_minutes: 20 }),
    completed(-20), completed(721)]))
    .toMatchObject({ acceptedVisits: 0, excluded: { backfill_reported: 1, operator_reported: 1,
      operator_corrected: 1, unverified_timing: 3 } });
});

test('unfinished work cannot count as a sample or a rejected completion', () => {
  expect(summarize([completed(10, '2026-09-02', { status: 'pending' }), completed()]))
    .toMatchObject({ acceptedVisits: 1, excluded: {}, byService: [expect.objectContaining({ samples: 1 })] });
});

test('an Eastern service day remains eligible when its completion is on the following UTC date', () => {
  const row = completed(30);
  row.actual_start_time = new Date('2026-09-02T03:00:00Z');
  row.actual_end_time = new Date('2026-09-02T03:30:00Z');
  row.statusHistory[0].transitioned_at = row.actual_start_time;
  row.statusHistory[1].transitioned_at = row.actual_end_time;
  row.completionNotes.closeoutRequirements.frozenAt = row.actual_end_time.toISOString();
  expect(summarize([row]).byService[0])
    .toMatchObject({ firstDate: '2026-09-01', lastDate: '2026-09-01', observedMinimumMinutes: 30 });
});
