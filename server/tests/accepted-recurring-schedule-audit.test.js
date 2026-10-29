const { acceptedScheduleFindings } = require('../services/recurring-schedule-audit');
const { buildRecurringFollowUpRows } = require('../services/recurring-appointment-seeder');
const { addETDays, etDateString, etParts, parseETDateTime } = require('../utils/datetime-et');

const TODAY = '2040-01-01';
function estimate(overrides = {}) {
  return { id: 'estimate-1', customer_id: 'customer-1', accepted_service_mode: 'recurring',
    monthly_total: 100, annual_total: 1200, estimate_data: {
      customerSelection: { frequency: 'monthly' },
      result: { recurring: { services: [{ service: 'pest_control', name: 'Pest Control', frequency: 'quarterly', visitsPerYear: 4 }] } },
    }, ...overrides };
}
function parent(overrides = {}) {
  return { id: 'visit-1', customer_id: 'customer-1', status: 'pending', scheduled_date: '2040-01-03',
    service_type: 'Monthly Pest Control Service', catalog_service_key: 'pest_general_monthly',
    source_estimate_id: 'estimate-1', is_recurring: true, recurring_pattern: 'monthly', ...overrides };
}
function series(pattern = 'monthly', count = 12) {
  const root = parent({ recurring_pattern: pattern });
  const children = buildRecurringFollowUpRows(root, { pattern, plannedCount: count });
  return [root, ...children.map((row, index) => ({ ...row, id: `child-${index}` }))];
}
function check(e = estimate(), rows = [], stopped = new Set()) {
  return acceptedScheduleFindings(e, rows, stopped, { todayET: TODAY });
}

test('finds a successful acceptance with no schedule at all', () => {
  expect(check()).toEqual([expect.objectContaining({ pattern: 'monthly', expectedVisits: 12, issues: ['missing_schedule'] })]);
});

test('finds a completed initial reservation that never became recurring', () => {
  const [gap] = check(estimate(), [parent({ status: 'completed', is_recurring: false, recurring_pattern: null })]);
  expect(gap.issues).toEqual(expect.arrayContaining(['missing_recurrence', 'missing_applications']));
});

test('a paid booster off a complete series is not audited as a missing-recurrence plan visit', () => {
  const rows = series('monthly', 12);
  const booster = { ...rows[1], id: 'booster-1', is_recurring: false, recurring_pattern: null,
    recurring_parent_id: 'visit-1', scheduled_date: '2040-01-20' };
  expect(check(estimate(), [...rows, booster])).toEqual([]);
});

test('a booster cannot stand in for the recurring applications it rides alongside', () => {
  const rows = series('monthly', 12);
  const booster = { ...rows[1], id: 'booster-1', is_recurring: false, recurring_pattern: null,
    recurring_parent_id: 'visit-1', scheduled_date: '2040-01-20' };
  const [gap] = check(estimate(), [...rows.slice(0, 11), booster]);
  expect(gap.issues).toEqual(['missing_applications']);
  expect(gap.appointmentIds).not.toContain('booster-1');
});

test('a child whose is_recurring is NULL is a plan visit, not a booster — its missing recurrence is still reported', () => {
  const rows = series('monthly', 12).map((row, index) => (index === 0 ? row : { ...row, is_recurring: null }));
  const [gap] = check(estimate(), rows);
  expect(gap.issues).toContain('missing_recurrence');
  expect(gap.appointmentIds).toEqual(expect.arrayContaining(['child-0']));
});

test('accepted pest selection outranks the stale quarterly engine line', () => {
  const [gap] = check(estimate(), series('quarterly', 4));
  expect(gap).toMatchObject({ pattern: 'monthly', expectedVisits: 12, recordedVisits: 4 });
  expect(gap.issues).toContain('cadence_differs_from_acceptance');
});

test('a complete monthly series agrees even when the accepted engine line was quarterly', () => {
  expect(check(estimate(), series())).toEqual([]);
});

test('lawn cadence comes from its sold applications, not monthly billing selection', () => {
  const e = estimate({ estimate_data: { customerSelection: { frequency: 'monthly' },
    result: { recurring: { services: [{ service: 'lawn_care', name: 'Lawn Care', visitsPerYear: 6 }] } } } });
  const rows = series('every_6_weeks', 9).map((row) => ({ ...row, service_type: 'Lawn Care', catalog_service_key: 'lawn_program', service_key_snapshot: 'lawn_program' }));
  const [gap] = check(e, rows);
  expect(gap).toMatchObject({ pattern: 'bimonthly', expectedVisits: 6 });
  expect(gap.issues).toContain('cadence_differs_from_acceptance');
});

// Lawn 9x rounds: the same plan as every_6_weeks, dated by nine fixed rounds.
const lawn9x = () => estimate({ estimate_data: { customerSelection: { frequency: 'monthly' },
  result: { recurring: { services: [{ service: 'lawn_care', name: 'Lawn Care', frequency: 'every_6_weeks', visitsPerYear: 9 }] } } } });
const roundsSeries = () => series('lawn_rounds_9', 9)
  .map((row) => ({ ...row, service_type: 'Lawn Care', catalog_service_key: 'lawn_program', service_key_snapshot: 'lawn_program' }));

test('a correct lawn rounds series accepted as every_6_weeks is the same plan, with no cadence or spacing finding', () => {
  const rows = roundsSeries();
  expect(rows.every((row) => row.recurring_pattern === 'lawn_rounds_9')).toBe(true);
  expect(check(lawn9x(), rows)).toEqual([]);
});

test('a lawn rounds series with a visit outside its round still raises the spacing issue, and only that', () => {
  const rows = roundsSeries();
  rows[4] = { ...rows[4], scheduled_date: etDateString(addETDays(parseETDateTime(`${rows[4].scheduled_date}T12:00`), 60)) };
  const [gap] = check(lawn9x(), rows);
  expect(gap.expectedVisits).toBe(9);
  expect(gap.issues).toEqual(['application_spacing_needs_review']);
});

test('monthly metadata cannot disguise quarterly dates', () => {
  const rows = series('quarterly', 12).map((row) => ({ ...row, recurring_pattern: 'monthly' }));
  expect(check(estimate(), rows)[0].issues).toContain('application_spacing_needs_review');
});

test('a year of applications cannot be compressed into weekly dates', () => {
  const rows = series('weekly', 12).map((row) => ({ ...row, recurring_pattern: 'monthly' }));
  expect(check(estimate(), rows)[0].issues).toContain('application_spacing_needs_review');
});

test('monthly metadata cannot disguise a year stretched across six-week dates', () => {
  const rows = series('every_6_weeks', 12).map((row) => ({ ...row, recurring_pattern: 'monthly' }));
  expect(check(estimate(), rows)[0].issues).toContain('application_spacing_needs_review');
});

// Seeded the converter's way: a Saturday or Sunday first visit puts every
// follow-up on that nth weekend day, shifted to the Monday after (or the
// Friday before). Near a month end the shift crosses into another month.
function weekendSeries(firstDate, pattern, count, weekendShift = 'forward') {
  const root = parent({ scheduled_date: firstDate, recurring_pattern: pattern, skip_weekends: true, weekend_shift: weekendShift });
  const children = buildRecurringFollowUpRows(root, { pattern, plannedCount: count, skipWeekends: true, weekendShift });
  return [root, ...children.map((row, index) => ({ ...row, id: `child-${index}` }))];
}
const quarterlyPest = () => estimate({ estimate_data: { customerSelection: { frequency: 'quarterly' },
  result: { recurring: { services: [{ service: 'pest_control', name: 'Pest Control', frequency: 'quarterly', visitsPerYear: 4 }] } } } });

test.each([
  ['monthly', 'Sun 2040-01-29', 'forward', '2040-10-01', estimate],
  ['quarterly', 'Sat 2040-03-31', 'forward', '2040-07-02', quarterlyPest],
  ['quarterly', 'Sun 2040-01-01', 'back', '2040-03-30', quarterlyPest],
])('a %s plan first visited %s is not flagged when a %s weekend shift crosses a month end', (pattern, first, weekendShift, crossed, makeEstimate) => {
  const rows = weekendSeries(first.slice(4), pattern, pattern === 'monthly' ? 12 : 4, weekendShift);
  expect(rows.map((row) => row.scheduled_date)).toContain(crossed);
  expect(check(makeEstimate(), rows)).toEqual([]);
});

test('no weekend first visit of a year is flagged for its seeded follow-ups', () => {
  const start = parseETDateTime('2040-01-01T12:00');
  for (let day = 0; day < 366; day++) {
    const first = etDateString(addETDays(start, day));
    if (![0, 6].includes(etParts(parseETDateTime(`${first}T12:00`)).dayOfWeek)) continue;
    for (const weekendShift of ['forward', 'back']) {
      expect([first, weekendShift, check(estimate(), weekendSeries(first, 'monthly', 12, weekendShift))]).toEqual([first, weekendShift, []]);
      expect([first, weekendShift, check(quarterlyPest(), weekendSeries(first, 'quarterly', 4, weekendShift))]).toEqual([first, weekendShift, []]);
    }
  }
});

test('a weekend first visit cannot disguise quarterly dates as monthly', () => {
  const rows = weekendSeries('2040-03-31', 'quarterly', 12).map((row) => ({ ...row, recurring_pattern: 'monthly' }));
  expect(check(estimate(), rows)[0].issues).toContain('application_spacing_needs_review');
});

test('a weekday first visit with an office-set weekend anchor is walked from its own date', () => {
  const root = parent({ scheduled_date: '2040-10-01', recurring_pattern: 'quarterly', recurring_nth: 1, recurring_weekday: 0, skip_weekends: true });
  const children = buildRecurringFollowUpRows(root, { pattern: 'quarterly', plannedCount: 4 });
  expect(children.map((row) => row.scheduled_date)).toEqual(['2041-01-07', '2041-04-08', '2041-07-08']);
  expect(check(quarterlyPest(), [root, ...children.map((row, index) => ({ ...row, id: `child-${index}` }))])).toEqual([]);
});

test.each([
  { recurring: { rodentBaitMo: 25 } },
  { result: { results: { rodBaitMo: 25 } } },
  { recurring: { rodentBaitMo: 25, services: [{ service: 'rodent_bait', name: 'Rodent Bait Stations' }] } },
])('scalar and duplicate line rodent plans use the scheduling unit cadence: %j', (estimate_data) => {
  const e = estimate({ estimate_data });
  expect(check(e)).toEqual([expect.objectContaining({ serviceFamily: 'rodent_bait', pattern: 'quarterly', expectedVisits: 4, issues: ['missing_schedule'] })]);
  const rows = series('quarterly', 4).map((row) => ({ ...row, service_type: 'Quarterly Rodent Bait Station Service',
    catalog_service_key: 'rodent_bait_quarterly', service_key_snapshot: 'rodent_bait_quarterly' }));
  expect(check(e, rows)).toEqual([]);
});

test.each([1, 5, 10])('resolved bait plus %i-year bond schedules are audited without a phantom rider visit', (years) => {
  const previousGate = process.env.GATE_SEPARATE_COMBO_VISITS;
  process.env.GATE_SEPARATE_COMBO_VISITS = 'true';
  try {
    const e = estimate({ estimate_data: { customerSelection: { frequency: 'quarterly' }, result: { recurring: { services: [
      { service: 'termite_bait', name: 'Termite Bait', frequency: 'quarterly' },
      { service: `termite_bond_${years}yr`, name: `Termite Bond (${years}-Year Term)`, frequency: 'quarterly' },
    ] } } } });
    expect(check(e)).toEqual([expect.objectContaining({ serviceFamily: 'termite_bait', pattern: 'quarterly', expectedVisits: 4, issues: ['missing_schedule'] })]);
    const rows = series('quarterly', 4).map((row) => ({ ...row, catalog_service_key: 'termite_bait',
      service_type: `Quarterly Termite Bait Station + Termite Bond Service (${years}-Year Term)` }));
    expect(check(e, rows)).toEqual([]);
  } finally {
    if (previousGate === undefined) delete process.env.GATE_SEPARATE_COMBO_VISITS;
    else process.env.GATE_SEPARATE_COMBO_VISITS = previousGate;
  }
});

test.each(['result', 'engineResult', 'root', 'duplicate'])('scalar palm programs are audited from the %s container', (shape) => {
  const result = { recurring: { palmInjectionMo: 25, palmInjectionAnn: 300 }, results: { injection: { appsPerYear: 2 } } };
  if (shape === 'duplicate') result.recurring.services = [{ service: 'palm_injection', name: 'Palm Injection', visitsPerYear: 2 }];
  const estimate_data = shape === 'root' ? result : { [shape === 'duplicate' ? 'result' : shape]: result };
  const e = estimate({ estimate_data });
  expect(check(e)).toEqual([expect.objectContaining({ serviceFamily: 'palm_injection', pattern: 'semiannual', expectedVisits: 2, issues: ['missing_schedule'] })]);
  const rows = series('semiannual', 2).map((row) => ({ ...row, service_type: 'Semiannual Palm Injection',
    catalog_service_key: 'palm_injection_semiannual' }));
  expect(check(e, rows)).toEqual([]);
});

test('a complete pest series cannot hide its unscheduled scalar palm supplement', () => {
  const e = estimate();
  e.estimate_data.result.recurring.palmInjectionMo = 25;
  e.estimate_data.result.results = { injection: { appsPerYear: 2 } };
  expect(check(e, series())).toEqual([expect.objectContaining({ serviceFamily: 'palm_injection', issues: ['missing_schedule'] })]);
});

test('a combined lawn and tree plan still requires schedule coverage for both families', () => {
  const previousGate = process.env.GATE_SEPARATE_COMBO_VISITS;
  delete process.env.GATE_SEPARATE_COMBO_VISITS;
  try {
    const e = estimate({ estimate_data: { result: { recurring: { services: [
      { service: 'lawn_care', name: 'Lawn Care', visitsPerYear: 6 },
      { service: 'tree_shrub', name: 'Tree and Shrub', visitsPerYear: 6 },
    ] } } } });
    const rows = series('bimonthly', 6).map((row) => ({ ...row, catalog_service_key: 'lawn_tree_shrub_combo', service_type: 'Lawn + Tree & Shrub Service' }));
    expect(check(e, rows)).toEqual([]);
    const lawnOnly = rows.map((row) => ({ ...row, catalog_service_key: 'lawn_program', service_type: 'Lawn Care' }));
    expect(check(e, lawnOnly)).toEqual([expect.objectContaining({ serviceFamily: 'tree_shrub', issues: ['missing_schedule'] })]);
  } finally {
    if (previousGate === undefined) delete process.env.GATE_SEPARATE_COMBO_VISITS;
    else process.env.GATE_SEPARATE_COMBO_VISITS = previousGate;
  }
});

test('a one-time catalog treatment does not count as a recurring application', () => {
  const [gap] = check(estimate(), [parent({ catalog_billing_type: 'one_time' })]);
  expect(gap.issues).toEqual(['missing_schedule']);
});

test('explicit date exceptions do not become inferred spacing errors', () => {
  const rows = series('quarterly', 12).map((row) => ({ ...row, recurring_pattern: 'monthly', date_exception: true }));
  expect(check(estimate(), rows)).toEqual([]);
});

test('a moved exception keeps its canonical position without masking later cadence drift', () => {
  const rows = series();
  const cadenceDate = rows[1].scheduled_date;
  rows[1] = { ...rows[1], scheduled_date: '2040-06-20', date_exception: true, date_exception_cadence_date: cadenceDate };
  expect(check(estimate(), rows)).toEqual([]);
  const drifted = series('every_6_weeks', 12).map((row) => ({ ...row, recurring_pattern: 'monthly' }));
  drifted[1] = { ...drifted[1], scheduled_date: '2040-06-20', date_exception: true,
    date_exception_cadence_date: drifted[1].scheduled_date };
  expect(check(estimate(), drifted)[0].issues).toContain('application_spacing_needs_review');
});

test('an old exception without a stored cadence position does not disable later span checks', () => {
  const rows = series('every_6_weeks', 12).map((row) => ({ ...row, recurring_pattern: 'monthly' }));
  rows[0].date_exception = true;
  expect(check(estimate(), rows)[0].issues).toContain('application_spacing_needs_review');
});

test('one-time acceptance and explicit series stops create no recurring obligation', () => {
  expect(check(estimate({ accepted_service_mode: 'one_time' }))).toEqual([]);
  expect(check(estimate(), [parent()], new Set(['visit-1']))).toEqual([]);
});

test('an active family hold defers the schedule check until the resume date', () => {
  expect(acceptedScheduleFindings(estimate(), [], new Set(), { todayET: TODAY, heldFamilies: new Set(['pest_control']) })).toEqual([]);
});

test('a held or stopped family is reported back as skipped, so a caller never reads it as judged', () => {
  const held = new Set();
  const onHold = new Set();
  acceptedScheduleFindings(estimate(), [], new Set(), { todayET: TODAY, heldFamilies: new Set(['pest_control']), skippedFamilies: held, onHoldFamilies: onHold });
  expect([...held]).toEqual(['pest_control']);
  expect([...onHold]).toEqual(['pest_control']); // a plan hold is the one temporary reason
  const stopped = new Set();
  const stoppedOnHold = new Set();
  acceptedScheduleFindings(estimate(), [parent()], new Set(['visit-1']), { todayET: TODAY, skippedFamilies: stopped, onHoldFamilies: stoppedOnHold });
  expect([...stopped]).toEqual(['pest_control']);
  expect([...stoppedOnHold]).toEqual([]); // a stopped series is skipped for good, not on hold
  const judged = new Set();
  acceptedScheduleFindings(estimate(), series('quarterly', 4), new Set(), { todayET: TODAY, skippedFamilies: judged });
  expect([...judged]).toEqual([]);
});

test('legacy custom 42-day lawn recurrence agrees with the accepted nine-application plan', () => {
  const e = estimate({ estimate_data: { result: { recurring: { services: [{ service: 'lawn_care', name: 'Lawn Care', visitsPerYear: 9 }] } } } });
  const rows = series('every_6_weeks', 9).map((row) => ({ ...row, service_type: 'Lawn Care', catalog_service_key: 'lawn_program',
    service_key_snapshot: 'lawn_program', recurring_pattern: 'custom', recurring_interval_days: 42 }));
  expect(check(e, rows)).toEqual([]);
});

test('cancelled initial visits ask for intent review instead of asserting an active obligation', () => {
  expect(check(estimate(), [parent({ status: 'cancelled' })])[0].issues).toEqual(['cancelled_schedule_needs_review']);
});

test('a different property cannot silently satisfy the accepted property', () => {
  expect(check(estimate({ property_id: 'property-1' }), series())[0].issues).toContain('property_link_needs_review');
});

test('stale labels cannot replace the catalog service identity', () => {
  const rows = series().map((row) => ({ ...row, service_type: 'Lawn Care', catalog_service_key: 'pest_general_monthly' }));
  expect(check(estimate(), rows)).toEqual([]);
});

test('the same evidence dedupes and a repaired-then-regressed schedule gets a new key', () => {
  const before = check(estimate(), [parent()])[0];
  expect(check(estimate(), [parent()])[0].evidenceKey).toBe(before.evidenceKey);
  expect(check(estimate(), [parent({ id: 'replacement-1' })])[0].evidenceKey).not.toBe(before.evidenceKey);
});

test('cadence-only repairs and later regressions on the same rows refresh alert evidence', () => {
  const e = estimate({ estimate_data: { result: { recurring: { services: [{ service: 'lawn_care', name: 'Lawn Care', visitsPerYear: 9 }] } } } });
  const rows = series('every_6_weeks', 9).map((row) => ({ ...row, service_type: 'Lawn Care', catalog_service_key: 'lawn_program',
    service_key_snapshot: 'lawn_program', recurring_pattern: 'custom', recurring_interval_days: 60,
    updated_at: '2040-01-01T12:00:00Z', row_revision: '100' }));
  const before = check(e, rows)[0];
  expect(check(e, rows)[0].evidenceKey).toBe(before.evidenceKey);
  const repaired = rows.map((row) => ({ ...row, recurring_interval_days: 42, row_revision: '101' }));
  expect(check(e, repaired)).toEqual([]);
  const regressed = repaired.map((row) => ({ ...row, recurring_interval_days: 60, row_revision: '102' }));
  expect(check(e, regressed)[0].evidenceKey).not.toBe(before.evidenceKey);
  expect(check(e, rows.map((row) => ({ ...row, recurring_interval_days: 61 })))[0].evidenceKey).not.toBe(before.evidenceKey);
  expect(check(e, rows.map((row) => ({ ...row, date_exception: true })))[0].evidenceKey).not.toBe(before.evidenceKey);
});

test('the finding key stays put on routine row edits and moves when the finding does (GATE_ACCEPTED_PLAN_RING_ON_CHANGE)', () => {
  const e = estimate({ estimate_data: { result: { recurring: { services: [{ service: 'lawn_care', name: 'Lawn Care', visitsPerYear: 9 }] } } } });
  const rows = series('every_6_weeks', 9).map((row) => ({ ...row, service_type: 'Lawn Care', catalog_service_key: 'lawn_program',
    service_key_snapshot: 'lawn_program', recurring_pattern: 'custom', recurring_interval_days: 60, row_revision: '100' }));
  const before = check(e, rows)[0];
  // Any UPDATE to a visit moves its xmin: new evidence, same finding.
  const touched = check(e, rows.map((row) => ({ ...row, row_revision: '101' })))[0];
  expect(touched.evidenceKey).not.toBe(before.evidenceKey);
  expect(touched.findingKey).toBe(before.findingKey);
  // A different wrong interval states the same issues and counts: still the same finding.
  const otherInterval = check(e, rows.map((row) => ({ ...row, recurring_interval_days: 61 })))[0];
  expect(otherInterval.issues).toEqual(before.issues);
  expect(otherInterval.findingKey).toBe(before.findingKey);
  // A lost application changes the recorded count and the issues: a new finding.
  const fewer = check(e, rows.slice(0, 8))[0];
  expect(fewer.recordedVisits).toBe(before.recordedVisits - 1);
  expect(fewer.findingKey).not.toBe(before.findingKey);
});

// Lawn rounds: a rounds series whose most recently ENDED round passed with no completed visit never took that round's step (owner 2026-10-29,
// PR 4b of the rounds build). The finding names the round and its dates, covers only the latest ended round (so it clears itself once the next
// round ends with a completed visit), counts no booster, and leaves every other pattern as it was.
describe('a lawn round that passed with no completed visit', () => {
  const { createHash } = require('node:crypto');
  const MISSED_ROUND_3 = 'Round 3 (Mar 15-Apr 23) passed with no completed visit; that round\'s step was not applied.';
  const roundsRow = (id, date, status, extra = {}) => ({
    ...parent({ id, scheduled_date: date, status, recurring_pattern: 'lawn_rounds_9', service_type: 'Lawn Care', catalog_service_key: 'lawn_program', service_key_snapshot: 'lawn_program', recurring_parent_id: id === 'r2' ? null : 'r2' }),
    ...extra,
  });
  // Round 2 (Feb 10) done, round 3 (Mar 20) cancelled, round 4 (May 5) and round 5 (Jun 10) ahead.
  const base = (round4 = 'scheduled') => [
    roundsRow('r2', '2027-02-10', 'completed'), roundsRow('r3', '2027-03-20', 'cancelled'),
    roundsRow('r4', '2027-05-05', round4), roundsRow('r5', '2027-06-10', 'scheduled'),
  ];
  const on = (todayET, rows, pattern = lawn9x()) => acceptedScheduleFindings(pattern, rows, new Set(), { todayET });
  const missedIssues = (findings) => (findings[0]?.issues || []).filter((issue) => /^Round \d/.test(issue));

  test('round 3 ended with only a cancelled visit: the issue names round 3 and its dates and says its step was not applied', () => {
    const [finding] = on('2027-04-30', base());
    expect(finding.issues).toContain(MISSED_ROUND_3);
    expect(missedIssues([finding])).toEqual([MISSED_ROUND_3]);
  });

  test('it stays while round 4 is running, and clears once round 4 ends with a completed visit', () => {
    expect(missedIssues(on('2027-05-20', base()))).toEqual([MISSED_ROUND_3]);
    // Round 4 ended Jun 2: its visit was completed, so the latest ended round is fine and the finding is gone.
    expect(missedIssues(on('2027-06-05', base('completed')))).toEqual([]);
  });

  test('only the latest ended round: if round 4 also ends with no completed visit the issue names round 4, not round 3', () => {
    const findings = on('2027-06-05', base('cancelled'));
    expect(missedIssues(findings)).toEqual(['Round 4 (Apr 24-Jun 2) passed with no completed visit; that round\'s step was not applied.']);
  });

  test('a visit that was scheduled in the round but never completed is a missed round too', () => {
    const rows = [roundsRow('r2', '2027-02-10', 'completed'), roundsRow('r3', '2027-03-20', 'scheduled'), roundsRow('r4', '2027-05-05', 'scheduled')];
    expect(missedIssues(on('2027-05-01', rows))).toEqual([MISSED_ROUND_3]);
  });

  test('a completed visit anywhere in the round (moved to Apr 10) counts', () => {
    const rows = base().map((row) => (row.id === 'r3' ? { ...row, status: 'completed', scheduled_date: '2027-04-10' } : row));
    expect(missedIssues(on('2027-04-30', rows))).toEqual([]);
  });

  test('a completed booster in the round does not count as the round\'s visit', () => {
    const booster = roundsRow('b3', '2027-03-25', 'completed', { is_recurring: false, recurring_pattern: null });
    expect(missedIssues(on('2027-04-30', [...base(), booster]))).toEqual([MISSED_ROUND_3]);
  });

  test('a round before the series\' first visit, and a round past its last row, are not missed rounds', () => {
    // The series starts in round 4: round 3 is not its round. Today is in round 4, so no round of the series has ended.
    const startsAtRound4 = [roundsRow('r2', '2027-05-05', 'scheduled'), roundsRow('r5', '2027-06-10', 'scheduled')];
    expect(missedIssues(on('2027-05-20', startsAtRound4))).toEqual([]);
    // The last row is in round 4 and round 5 has ended: the series has no row there, so it is past its term (the other issues cover it).
    const ended = [roundsRow('r2', '2027-02-10', 'completed'), roundsRow('r4', '2027-05-05', 'completed')];
    expect(missedIssues(on('2027-07-20', ended))).toEqual([]);
  });

  test('a 12x series, and a legacy 9x series (every_6_weeks, custom 42 days), get no such issue', () => {
    const twelveX = ['2027-02-10', '2027-03-20', '2027-04-20', '2027-05-20'].map((date, index) => parent({ id: `m${index}`, scheduled_date: date, status: index === 1 ? 'cancelled' : 'completed', recurring_pattern: 'monthly' }));
    expect(missedIssues(on('2027-04-30', twelveX, estimate()))).toEqual([]);
    for (const [pattern, interval] of [['every_6_weeks', null], ['custom', 42]]) {
      const legacy = base().map((row) => ({ ...row, recurring_pattern: pattern, recurring_interval_days: interval }));
      expect(missedIssues(on('2027-04-30', legacy))).toEqual([]);
    }
  });

  test('the finding key carries the round: a new missed round changes it, the same round on another day does not', () => {
    const keyOn = (todayET, rows) => on(todayET, rows)[0].findingKey;
    expect(keyOn('2027-04-30', base())).toBe(keyOn('2027-05-20', base()));
    expect(keyOn('2027-06-05', base('cancelled'))).not.toBe(keyOn('2027-05-20', base()));
    // The same round of the NEXT year is a different incident: the ordinal runs on, though the words repeat.
    const nextYear = base().map((row) => ({ ...row, scheduled_date: `2028${row.scheduled_date.slice(4)}` }));
    expect(on('2028-04-30', nextYear)[0].issues).toContain(MISSED_ROUND_3);
    expect(keyOn('2028-04-30', nextYear)).not.toBe(keyOn('2027-04-30', base()));
  });

  test('every other finding keeps the key it always had (no round field in it)', () => {
    const [finding] = check(estimate(), series('monthly', 12).slice(0, 11));
    expect(finding.findingKey).toBe(createHash('sha256').update(JSON.stringify({ issues: finding.issues, pattern: finding.pattern, expectedVisits: finding.expectedVisits, recordedVisits: finding.recordedVisits })).digest('hex').slice(0, 20));
  });
});
