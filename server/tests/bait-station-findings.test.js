/**
 * Bait station typed flows (owner spec 2026-06-12): termite_bait_station +
 * rodent_bait_station schema shape, consumption-derived activity scores,
 * required next steps, composed station sentences, and the owner's risk
 * wording rules (accessible-stations-scoped termite claims, exterior-pressure
 * rodent claims, no property-wide "no termites" copy).
 */
const {
  ACTIVITY_INDICATORS,
  REQUIRED_FINDINGS_FIELDS,
  deriveActivityScore,
  findBannedCustomerCopy,
  nextStepRequiredForType,
  chipsForType,
  customerLabelForValue,
  validateTypedFindings,
  buildTodaysResult,
  buildTypedReportSnapshot,
  findingsSchemaForType,
} = require('../services/service-report/activity-indicators');
const { PROJECT_TYPES } = require('../services/project-types');

describe('bait station schemas', () => {
  test('both types registered with sectioned fields and station counts', () => {
    for (const type of ['termite_bait_station', 'rodent_bait_station']) {
      const config = PROJECT_TYPES[type];
      expect(config).toBeTruthy();
      const byKey = Object.fromEntries(config.findingsFields.map((f) => [f.key, f]));
      expect(byKey.stations_checked.type).toBe('count');
      expect(byKey.stations_inaccessible.type).toBe('count');
      expect(byKey.bait_consumption.type).toBe('select');
      expect(config.findingsFields.every((f) => f.section)).toBe(true);
    }
  });

  test('required cores stay small (60-second completion budget)', () => {
    expect(REQUIRED_FINDINGS_FIELDS.termite_bait_station).toEqual(['stations_checked', 'termite_activity', 'bait_consumption']);
    expect(REQUIRED_FINDINGS_FIELDS.rodent_bait_station).toEqual(['stations_checked', 'bait_consumption']);
  });

  test('every station report requires a next step', () => {
    expect(nextStepRequiredForType('termite_bait_station')).toBe(true);
    expect(nextStepRequiredForType('rodent_bait_station')).toBe(true);
    for (const type of ['termite_bait_station', 'rodent_bait_station']) {
      const schema = findingsSchemaForType(type);
      expect(schema.nextStepRequired).toBe(true);
      expect(schema.nextStepChips.length).toBeGreaterThanOrEqual(5);
    }
  });

  test('bait consumption value sets stay disjoint between the two types', () => {
    const termiteOptions = PROJECT_TYPES.termite_bait_station.findingsFields
      .find((f) => f.key === 'bait_consumption').options;
    const rodentOptions = PROJECT_TYPES.rodent_bait_station.findingsFields
      .find((f) => f.key === 'bait_consumption').options;
    // Shared field key + shared global copy map: an overlapping value would
    // put one program's wording on the other's reports.
    expect(termiteOptions.filter((o) => rodentOptions.includes(o))).toEqual([]);
  });
});

describe('consumption-derived activity scores', () => {
  test('rodent: consumption level drives the gauge', () => {
    expect(deriveActivityScore('rodent_bait_station', { bait_consumption: 'None' }).score).toBe(0);
    expect(deriveActivityScore('rodent_bait_station', { bait_consumption: 'Moderate' }).score).toBe(3);
    expect(deriveActivityScore('rodent_bait_station', { bait_consumption: 'Empty' }).score).toBe(5);
  });

  test('termite: activity status drives the gauge', () => {
    expect(deriveActivityScore('termite_bait_station', { termite_activity: 'None observed' }).score).toBe(0);
    expect(deriveActivityScore('termite_bait_station', { termite_activity: 'Previous feeding noted' }).score).toBe(1);
    expect(deriveActivityScore('termite_bait_station', { termite_activity: 'Active termites present' }).score).toBe(4);
  });

  test('indicator keys: termite shares the program trend, rodent stations stay separate from trapping', () => {
    expect(ACTIVITY_INDICATORS.termite_bait_station.indicatorKey).toBe('termite_activity');
    expect(ACTIVITY_INDICATORS.termite_inspection.indicatorKey).toBe('termite_activity');
    expect(ACTIVITY_INDICATORS.rodent_bait_station.indicatorKey).toBe('rodent_bait_activity');
    expect(ACTIVITY_INDICATORS.rodent_trapping.indicatorKey).not.toBe('rodent_bait_activity');
  });
});

describe('owner risk wording', () => {
  test('property-wide termite absence claims are banned copy', () => {
    expect(findBannedCustomerCopy('No termites on the property.')).not.toEqual([]);
    expect(findBannedCustomerCopy('There are no termites at your home today.')).not.toEqual([]);
    // The approved scoped phrasing passes.
    expect(findBannedCustomerCopy('No termite activity was observed in the accessible bait stations during today’s inspection.')).toEqual([]);
  });

  test('broader property-wide absence phrasings are caught too (Codex P2)', () => {
    expect(findBannedCustomerCopy('No termites were found on the property.')).not.toEqual([]);
    expect(findBannedCustomerCopy('No termite activity on the property.')).not.toEqual([]);
    expect(findBannedCustomerCopy('We saw no signs of termites at your home.')).not.toEqual([]);
    expect(findBannedCustomerCopy('No evidence of termite activity throughout the home today.')).not.toEqual([]);
    // Station-scoped sentences stay legal even when they name the property.
    expect(findBannedCustomerCopy('No termite feeding was observed in the stations on your property.')).toEqual([]);
  });

  test('termite zero state scopes to accessible stations', () => {
    const result = buildTodaysResult({
      projectType: 'termite_bait_station',
      reportTypeLabel: 'Termite Bait Station Service Summary',
      values: { stations_checked: '18', termite_activity: 'None observed' },
      chips: ['Continue scheduled monitoring'],
      activity: { score: 0 },
      visitSequence: 1,
    });
    expect(result.headline).toBe('No termite activity was observed in the accessible bait stations today.');
    expect(result.body).toContain('We inspected 18 termite bait stations around the exterior perimeter today.');
  });

  test('rodent consumption renders as exterior pressure, never interior claims', () => {
    expect(customerLabelForValue('bait_consumption', 'Heavy')).toContain('exterior');
    expect(customerLabelForValue('bait_consumption', 'Moderate')).toContain('exterior');
    // Termite values keep colony-feeding wording.
    expect(customerLabelForValue('bait_consumption', 'Moderate feeding')).toContain('termite feeding');
  });

  test('rodent zero state uses the owner sentence', () => {
    const result = buildTodaysResult({
      projectType: 'rodent_bait_station',
      reportTypeLabel: 'Quarterly Rodent Bait Station Service Summary',
      values: { stations_checked: '4', bait_consumption: 'None', station_actions: 'Secured' },
      chips: ['Continue bait station service'],
      activity: { score: 0 },
      visitSequence: 1,
    });
    expect(result.headline).toBe('No bait consumption or visible rodent evidence was observed today.');
    expect(result.body).toContain('We checked and serviced 4 exterior rodent bait stations today.');
  });

  test('rodent zero score with evidence chips never claims "no evidence" (hook P1)', () => {
    const result = buildTodaysResult({
      projectType: 'rodent_bait_station',
      reportTypeLabel: 'Quarterly Rodent Bait Station Service Summary',
      values: { stations_checked: '4', bait_consumption: 'None', evidence_observed: 'Droppings, Gnaw marks' },
      chips: ['Rodent inspection recommended'],
      activity: { score: 0 },
      visitSequence: 1,
    });
    expect(result.headline).toBe('No bait consumption was observed today, but rodent evidence was noted nearby.');
    expect(result.headline).not.toContain('no visible rodent evidence');
  });

  test('termite zero score with live-activity signs never claims "no activity"', () => {
    const result = buildTodaysResult({
      projectType: 'termite_bait_station',
      reportTypeLabel: 'Termite Bait Station Service Summary',
      values: { stations_checked: '18', termite_activity: 'None observed', activity_signs: 'Mud tubing in station' },
      chips: ['Recheck active station sooner'],
      activity: { score: 0 },
      visitSequence: 1,
    });
    expect(result.headline).toBe('Termite activity signs were observed in the bait stations today — see the details below.');
    // Round 2: stations_with_activity count, active station location, and
    // feeding-level consumption each contradict the zero claim on their own.
    for (const values of [
      { stations_checked: '18', termite_activity: 'None observed', stations_with_activity: '1' },
      { stations_checked: '18', termite_activity: 'None observed', active_station_location: 'Station #7, rear wall' },
      { stations_checked: '18', termite_activity: 'None observed', bait_consumption: 'Moderate feeding' },
    ]) {
      const r = buildTodaysResult({
        projectType: 'termite_bait_station',
        reportTypeLabel: 'Termite Bait Station Service Summary',
        values,
        chips: ['Recheck active station sooner'],
        activity: { score: 0 },
        visitSequence: 1,
      });
      expect(r.headline).toBe('Termite activity signs were observed in the bait stations today — see the details below.');
    }
    // A named highest-activity location contradicts the rodent zero claim too.
    const rodentLocation = buildTodaysResult({
      projectType: 'rodent_bait_station',
      reportTypeLabel: 'Quarterly Rodent Bait Station Service Summary',
      values: { stations_checked: '4', bait_consumption: 'None', highest_activity_location: 'Rear fence line' },
      chips: ['Monitor activity'],
      activity: { score: 0 },
      visitSequence: 1,
    });
    expect(rodentLocation.headline).toBe('No bait consumption was observed today, but rodent evidence was noted nearby.');
    // Non-live signs (conducive conditions, previous feeding) do NOT trip it.
    const benign = buildTodaysResult({
      projectType: 'termite_bait_station',
      reportTypeLabel: 'Termite Bait Station Service Summary',
      values: { stations_checked: '18', termite_activity: 'None observed', activity_signs: 'Favorable moisture / soil conditions, Previous feeding evidence' },
      chips: ['Continue scheduled monitoring'],
      activity: { score: 0 },
      visitSequence: 1,
    });
    expect(benign.headline).toBe('No termite activity was observed in the accessible bait stations today.');
  });

  test('trend headlines still win on progress visits', () => {
    const result = buildTodaysResult({
      projectType: 'rodent_bait_station',
      reportTypeLabel: 'Rodent Bait Station Program — Progress Visit',
      values: { stations_checked: '4', bait_consumption: 'None' },
      chips: ['Continue bait station service'],
      activity: { score: 0, trend: 'improving', trendWord: 'decreased since our last visit' },
      visitSequence: 2,
    });
    expect(result.headline).toBe('Bait station activity has decreased since our last visit.');
  });
});

describe('station sentence composition', () => {
  test('inaccessible stations get their own sentence', () => {
    const result = buildTodaysResult({
      projectType: 'termite_bait_station',
      reportTypeLabel: 'Termite Bait Station Service Summary',
      values: { stations_checked: '17', stations_inaccessible: '1', termite_activity: 'None observed' },
      chips: ['Return when access available'],
      activity: { score: 0 },
      visitSequence: 1,
    });
    expect(result.body).toContain('1 station was not accessible and will be checked when access is available.');
  });

  test('no station count falls back to the generic sentence', () => {
    const result = buildTodaysResult({
      projectType: 'rodent_bait_station',
      reportTypeLabel: 'Quarterly Rodent Bait Station Service Summary',
      values: { bait_consumption: 'Light' },
      chips: ['Monitor activity'],
      activity: { score: 2 },
      visitSequence: 1,
    });
    expect(result.body).toContain('We completed the scheduled service.');
  });
});

describe('validation', () => {
  test('required fields enforced for both types', () => {
    const result = validateTypedFindings({
      type: 'rodent_bait_station',
      values: { station_actions: 'Cleaned' },
      expectedType: 'rodent_bait_station',
      enforceRequired: true,
    });
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(expect.arrayContaining(['stations_checked', 'bait_consumption']));
  });

  test('off-list chips and bogus counts rejected', () => {
    const result = validateTypedFindings({
      type: 'termite_bait_station',
      values: {
        stations_checked: '1e3',
        termite_activity: 'None observed',
        bait_consumption: 'None — bait intact',
        station_issues: 'Station vaporized',
      },
      expectedType: 'termite_bait_station',
      enforceRequired: true,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/stations_checked/);
    expect(result.errors.join(' ')).toMatch(/Station vaporized/);
  });

  test('termite "None observed" with positive evidence is rejected (Codex P2)', () => {
    // The gauge derives from termite_activity alone — these combos would
    // persist a zero score into the shared termite trend while the findings
    // list shows feeding. Each evidence field trips the contradiction alone.
    const base = { stations_checked: '18', termite_activity: 'None observed' };
    for (const extra of [
      { bait_consumption: 'Moderate feeding' },
      { bait_consumption: 'None — bait intact', stations_with_activity: '2' },
      { bait_consumption: 'None — bait intact', active_station_location: 'Station #7, rear wall' },
      { bait_consumption: 'None — bait intact', activity_signs: 'Bait feeding' },
    ]) {
      const result = validateTypedFindings({
        type: 'termite_bait_station',
        values: { ...base, ...extra },
        expectedType: 'termite_bait_station',
        enforceRequired: true,
      });
      expect(result.ok).toBe(false);
      expect(result.errors.join(' ')).toMatch(/None observed/);
    }
    // Coherent zero state passes: bait intact + non-live signs only.
    const clean = validateTypedFindings({
      type: 'termite_bait_station',
      values: {
        ...base,
        bait_consumption: 'None — bait intact',
        activity_signs: 'Previous feeding evidence, Favorable moisture / soil conditions',
      },
      expectedType: 'termite_bait_station',
      enforceRequired: true,
    });
    expect(clean.ok).toBe(true);
  });

  test('live termites require the "Active termites present" selection', () => {
    const understated = validateTypedFindings({
      type: 'termite_bait_station',
      values: {
        stations_checked: '18',
        termite_activity: 'Previous feeding noted',
        bait_consumption: 'Light feeding',
        activity_signs: 'Live termites in station',
      },
      expectedType: 'termite_bait_station',
      enforceRequired: true,
    });
    expect(understated.ok).toBe(false);
    expect(understated.errors.join(' ')).toMatch(/Active termites present/);

    const active = validateTypedFindings({
      type: 'termite_bait_station',
      values: {
        stations_checked: '18',
        termite_activity: 'Active termites present',
        bait_consumption: 'Heavy feeding',
        activity_signs: 'Live termites in station',
        stations_with_activity: '1',
      },
      expectedType: 'termite_bait_station',
      enforceRequired: true,
    });
    expect(active.ok).toBe(true);
  });

  test('snapshot includes derived gauge and customer value labels', () => {
    const snapshot = buildTypedReportSnapshot({
      projectType: 'rodent_bait_station',
      values: { stations_checked: '4', bait_consumption: 'Heavy', bait_replaced: 'Yes' },
      nextStepChips: ['Recheck high-consumption station'],
      serviceKey: 'rodent_bait_quarterly',
      serviceLabel: 'Quarterly Rodent Bait Station Service',
      visitSequence: 1,
      activity: { indicatorKey: 'rodent_bait_activity', label: 'Bait Station Activity', score: 4, source: 'derived' },
    });
    const consumption = snapshot.findings.find((f) => f.fieldKey === 'bait_consumption');
    expect(consumption.customerValueLabel).toBe('Heavy consumption — indicates strong exterior rodent pressure');
    expect(snapshot.activity.score).toBe(4);
    const allCopy = JSON.stringify(snapshot);
    expect(findBannedCustomerCopy(allCopy)).toEqual([]);
  });
});
