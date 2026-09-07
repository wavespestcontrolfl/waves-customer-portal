const { acceptedScheduleFindings } = require('../services/recurring-schedule-audit');
const { buildRecurringFollowUpRows } = require('../services/recurring-appointment-seeder');

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
