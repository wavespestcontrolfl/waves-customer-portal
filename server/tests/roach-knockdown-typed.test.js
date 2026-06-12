/**
 * Cockroach knockdown typed flows (owner spec 2026-06-12, Phase 2 §8):
 * two DISTINCT checklists (German interior bait/IGR program vs palmetto
 * large-roach perimeter program), shared roach_activity trend line,
 * mandatory German cooperation language, and the palmetto flush disclosure.
 */
const {
  ACTIVITY_INDICATORS,
  REQUIRED_FINDINGS_FIELDS,
  TYPE_NEXT_STEP_CHIPS,
  NEXT_STEP_CHIPS,
  customerLabelForValue,
  deriveActivityScore,
  findBannedCustomerCopy,
  nextStepRequiredForType,
  validateTypedFindings,
  validateNextStepChips,
  validateActivityScoreConsistency,
  findingsSchemaForType,
  buildTodaysResult,
  buildTypedReportSnapshot,
} = require('../services/service-report/activity-indicators');
const { PROJECT_TYPES } = require('../services/project-types');

const GERMAN_VALUES = {
  activity_level: 'Moderate',
  rooms_treated: 'Kitchen and adjacent areas',
  primary_harborage: 'Behind refrigerator, Under sink, Cabinet hinges',
  live_roaches_observed: 'Yes',
  droppings_egg_cases: 'Yes',
  sanitation_issue: 'Yes',
  moisture_leak_issue: 'No',
  prep_status: 'Partial',
  treatment_completed: 'Gel bait, Insect growth regulator, Crack & crevice treatment',
  monitors_placed: 'Yes',
  followup_required: 'Yes',
  followup_window: '10–14 days',
};

const PALMETTO_VALUES = {
  roach_type: 'Palmetto',
  activity_level: 'Moderate',
  activity_locations: 'Kitchen, Garage, Exterior perimeter',
  interior_activity: 'Yes',
  exterior_harborage: 'Yes',
  moisture_issue: 'Yes',
  entry_points_observed: 'Yes',
  treatment_completed: 'Interior crack & crevice, Garage treatment, Exterior perimeter treatment',
  customer_recommendations: 'Keep garage seals tight, Reduce moisture near entry points',
  followup_needed: 'No',
};

describe('knockdown schemas', () => {
  test('two distinct checklists — German interior program vs palmetto perimeter program', () => {
    const german = Object.fromEntries(PROJECT_TYPES.german_roach_knockdown.findingsFields.map((f) => [f.key, f]));
    const palmetto = Object.fromEntries(PROJECT_TYPES.palmetto_roach_knockdown.findingsFields.map((f) => [f.key, f]));
    // German-only machinery: prep, monitors, structured follow-up window.
    expect(german.prep_status).toBeTruthy();
    expect(german.monitors_placed).toBeTruthy();
    expect(german.followup_window.options).toContain('10–14 days');
    expect(palmetto.prep_status).toBeUndefined();
    // Palmetto-only machinery: species + exterior pressure trio.
    expect(palmetto.roach_type.options).toEqual(['Palmetto', 'American', 'Smoky brown', 'Unknown large roach']);
    expect(palmetto.exterior_harborage).toBeTruthy();
    expect(german.roach_type).toBeUndefined();
    // German runs multi-visit; palmetto does not force one.
    expect(PROJECT_TYPES.german_roach_knockdown.requiresFollowup).toBe(true);
    expect(PROJECT_TYPES.palmetto_roach_knockdown.requiresFollowup).toBe(false);
  });

  test('owner-required cores enforced; both types require a next step', () => {
    expect(REQUIRED_FINDINGS_FIELDS.german_roach_knockdown).toContain('prep_status');
    expect(REQUIRED_FINDINGS_FIELDS.palmetto_roach_knockdown).toContain('roach_type');
    expect(nextStepRequiredForType('german_roach_knockdown')).toBe(true);
    expect(nextStepRequiredForType('palmetto_roach_knockdown')).toBe(true);
    for (const type of ['german_roach_knockdown', 'palmetto_roach_knockdown']) {
      for (const chip of TYPE_NEXT_STEP_CHIPS[type]) {
        expect({ type, chip, hasSentence: !!NEXT_STEP_CHIPS[chip] }).toEqual({ type, chip, hasSentence: true });
      }
    }
  });

  test('both knockdowns extend the shared roach trend line', () => {
    expect(ACTIVITY_INDICATORS.german_roach_knockdown.indicatorKey).toBe('roach_activity');
    expect(ACTIVITY_INDICATORS.palmetto_roach_knockdown.indicatorKey).toBe('roach_activity');
    expect(ACTIVITY_INDICATORS.cockroach.indicatorKey).toBe('roach_activity');
    expect(deriveActivityScore('german_roach_knockdown', { activity_level: 'Light' }).score).toBe(1);
    expect(deriveActivityScore('german_roach_knockdown', { activity_level: 'Severe' }).score).toBe(5);
    expect(deriveActivityScore('palmetto_roach_knockdown', { activity_level: 'Heavy' }).score).toBe(4);
  });
});

describe('German knockdown report', () => {
  test('cooperation language is mandatory and deterministic (owner critical warning)', () => {
    const result = buildTodaysResult({
      projectType: 'german_roach_knockdown',
      reportTypeLabel: 'German Roach Knockdown Summary',
      values: GERMAN_VALUES,
      chips: ['Follow-up in 10–14 days', 'No store-bought sprays'],
      activity: { score: 3 },
      visitSequence: 1,
    });
    expect(result.headline).toBe('German cockroach activity was moderate today.');
    expect(result.body).toContain('Completed your initial German cockroach knockdown service in the kitchen and adjacent areas.');
    expect(result.body).toContain('placed targeted gel bait');
    expect(result.body).toContain('avoid over-the-counter sprays');
    expect(result.body).toContain('keep bait placements undisturbed');
    expect(result.body).toContain('Follow-up service is recommended in 10–14 days.');
    expect(findBannedCustomerCopy(JSON.stringify(result))).toEqual([]);
  });

  test('cooperation language survives even a minimal submission', () => {
    const result = buildTodaysResult({
      projectType: 'german_roach_knockdown',
      reportTypeLabel: 'German Roach Knockdown Summary',
      values: { activity_level: 'Heavy', followup_required: 'No' },
      chips: ['No store-bought sprays'],
      activity: { score: 4 },
      visitSequence: 1,
    });
    expect(result.body).toContain('keep bait placements undisturbed');
    expect(result.body).not.toContain('Follow-up service is recommended');
  });

  test('cleared-state revisit stays observational AND keeps the cooperation language (Codex P2)', () => {
    const result = buildTodaysResult({
      projectType: 'german_roach_knockdown',
      reportTypeLabel: 'German Roach Knockdown Summary',
      values: { ...GERMAN_VALUES, activity_level: 'None observed', followup_required: 'No' },
      chips: ['Keep treated areas undisturbed'],
      activity: { score: 0 },
      visitSequence: 1,
    });
    expect(result.headline).toBe('No live German cockroach activity was observed today.');
    expect(result.headline).not.toContain('was none');
    expect(result.body).toContain('keep bait placements undisturbed');
    expect(findBannedCustomerCopy(JSON.stringify(result))).toEqual([]);
  });

  test('trend headline wins on the follow-up visit but the required copy survives (Codex P2)', () => {
    const result = buildTodaysResult({
      projectType: 'german_roach_knockdown',
      reportTypeLabel: 'Roach Program — Progress Visit',
      values: { ...GERMAN_VALUES, activity_level: 'Light' },
      chips: ['Keep treated areas undisturbed'],
      activity: { score: 1, trend: 'improving', trendWord: 'decreased since the last visit' },
      visitSequence: 2,
    });
    expect(result.headline).toBe('Roach activity has decreased since our last visit.');
    expect(result.body).toContain('keep bait placements undisturbed');
    expect(result.body).not.toContain('initial');

    const palmetto = buildTodaysResult({
      projectType: 'palmetto_roach_knockdown',
      reportTypeLabel: 'Roach Program — Progress Visit',
      values: { ...PALMETTO_VALUES, activity_level: 'Light' },
      chips: ['Monitor activity'],
      activity: { score: 1, trend: 'stable', trendWord: 'about the same as the last visit' },
      visitSequence: 2,
    });
    expect(palmetto.headline).toBe('Roach activity is about the same as our last visit.');
    expect(palmetto.body).toContain('flushed from hiding areas');
  });

  test('headline follows the final gauge score when the tech overrides it (Codex P2)', () => {
    const result = buildTodaysResult({
      projectType: 'german_roach_knockdown',
      reportTypeLabel: 'German Roach Knockdown Summary',
      values: { ...GERMAN_VALUES, activity_level: 'Light' },
      chips: ['No store-bought sprays'],
      activity: { score: 4, source: 'technician' },
      visitSequence: 1,
    });
    expect(result.headline).toBe('German cockroach activity was high today.');
    expect(result.headline).not.toContain('light');
  });
});

describe('palmetto knockdown report', () => {
  test('flush disclosure + moisture context are deterministic', () => {
    const result = buildTodaysResult({
      projectType: 'palmetto_roach_knockdown',
      reportTypeLabel: 'Palmetto Roach Knockdown Summary',
      values: PALMETTO_VALUES,
      chips: ['Seal entry gaps', 'Reduce moisture'],
      activity: { score: 3 },
      visitSequence: 1,
    });
    expect(result.headline).toBe('Large-roach activity was moderate today.');
    expect(result.body).toContain('Completed your initial large-roach knockdown service.');
    expect(result.body).toContain('treated the garage edges');
    expect(result.body).toContain('Some activity may be seen temporarily as roaches are flushed from hiding areas.');
    expect(result.body).toContain('Moisture and exterior entry points can contribute');
    expect(findBannedCustomerCopy(JSON.stringify(result))).toEqual([]);
  });
});

describe('validation', () => {
  test('owner-required cores enforce as missing', () => {
    const german = validateTypedFindings({
      type: 'german_roach_knockdown',
      values: { activity_level: 'Moderate' },
      expectedType: 'german_roach_knockdown',
      enforceRequired: true,
    });
    expect(german.ok).toBe(false);
    expect(german.missing).toEqual(expect.arrayContaining(['rooms_treated', 'prep_status', 'treatment_completed', 'followup_required']));

    const palmetto = validateTypedFindings({
      type: 'palmetto_roach_knockdown',
      values: { activity_level: 'Light' },
      expectedType: 'palmetto_roach_knockdown',
      enforceRequired: true,
    });
    expect(palmetto.ok).toBe(false);
    expect(palmetto.missing).toEqual(expect.arrayContaining(['roach_type', 'exterior_harborage', 'customer_recommendations']));
  });

  test('follow-up window required only when a follow-up is required', () => {
    const withoutWindow = validateTypedFindings({
      type: 'german_roach_knockdown',
      values: { ...GERMAN_VALUES, followup_window: '' },
      expectedType: 'german_roach_knockdown',
      enforceRequired: true,
    });
    expect(withoutWindow.ok).toBe(false);
    expect(withoutWindow.missing).toContain('followup_window');

    const noFollowup = validateTypedFindings({
      type: 'german_roach_knockdown',
      values: { ...GERMAN_VALUES, followup_required: 'No', followup_window: '' },
      expectedType: 'german_roach_knockdown',
      enforceRequired: true,
    });
    expect(noFollowup.ok).toBe(true);
  });

  test('required chips with only empty parts count as missing (Codex P2)', () => {
    const result = validateTypedFindings({
      type: 'german_roach_knockdown',
      values: { ...GERMAN_VALUES, primary_harborage: ' , ', treatment_completed: ',' },
      expectedType: 'german_roach_knockdown',
      enforceRequired: true,
    });
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(expect.arrayContaining(['primary_harborage', 'treatment_completed']));
  });

  test('"None observed" cannot contradict recorded live evidence (Codex P2 round 3)', () => {
    for (const extra of [
      { live_roaches_observed: 'Yes', droppings_egg_cases: 'No' },
      { live_roaches_observed: 'No', droppings_egg_cases: 'Yes' },
    ]) {
      const result = validateTypedFindings({
        type: 'german_roach_knockdown',
        values: { ...GERMAN_VALUES, activity_level: 'None observed', followup_required: 'No', ...extra },
        expectedType: 'german_roach_knockdown',
        enforceRequired: true,
      });
      expect(result.ok).toBe(false);
      expect(result.errors.join(' ')).toMatch(/None observed/);
    }
    // A truthful cleared revisit passes (window cleared with the "No" —
    // a stale window is its own rejection, tested below).
    const cleared = validateTypedFindings({
      type: 'german_roach_knockdown',
      values: { ...GERMAN_VALUES, activity_level: 'None observed', live_roaches_observed: 'No', droppings_egg_cases: 'No', followup_required: 'No', followup_window: '' },
      expectedType: 'german_roach_knockdown',
      enforceRequired: true,
    });
    expect(cleared.ok).toBe(true);

    const palmetto = validateTypedFindings({
      type: 'palmetto_roach_knockdown',
      values: { ...PALMETTO_VALUES, activity_level: 'None observed', interior_activity: 'Yes' },
      expectedType: 'palmetto_roach_knockdown',
      enforceRequired: true,
    });
    expect(palmetto.ok).toBe(false);
    expect(palmetto.errors.join(' ')).toMatch(/Interior activity/);
  });

  test('cleared palmetto visits: activity locations conditional + contradiction-guarded (Codex P2 round 5)', () => {
    // Locations recorded beside "None observed" contradict the zero claim.
    const contradicted = validateTypedFindings({
      type: 'palmetto_roach_knockdown',
      values: { ...PALMETTO_VALUES, activity_level: 'None observed', interior_activity: 'No' },
      expectedType: 'palmetto_roach_knockdown',
      enforceRequired: true,
    });
    expect(contradicted.ok).toBe(false);
    expect(contradicted.errors.join(' ')).toMatch(/Activity locations/);

    // A truthful cleared revisit passes without naming any location.
    const cleared = validateTypedFindings({
      type: 'palmetto_roach_knockdown',
      values: { ...PALMETTO_VALUES, activity_level: 'None observed', interior_activity: 'No', activity_locations: '' },
      expectedType: 'palmetto_roach_knockdown',
      enforceRequired: true,
    });
    expect(cleared.ok).toBe(true);

    // Active visits still require the locations.
    const active = validateTypedFindings({
      type: 'palmetto_roach_knockdown',
      values: { ...PALMETTO_VALUES, activity_locations: ' , ' },
      expectedType: 'palmetto_roach_knockdown',
      enforceRequired: true,
    });
    expect(active.ok).toBe(false);
    expect(active.missing).toContain('activity_locations');
  });

  test('full owner submissions validate clean', () => {
    for (const [type, values] of [
      ['german_roach_knockdown', GERMAN_VALUES],
      ['palmetto_roach_knockdown', PALMETTO_VALUES],
    ]) {
      const result = validateTypedFindings({ type, values, expectedType: type, enforceRequired: true });
      expect({ type, ok: result.ok, errors: result.errors, missing: result.missing })
        .toEqual({ type, ok: true, errors: [], missing: [] });
    }
  });
});

describe('conditional requirement served to the client (flea precedent)', () => {
  test('palmetto activity_locations carries requiredUnless in the schema slice', () => {
    const slice = findingsSchemaForType('palmetto_roach_knockdown');
    const locations = slice.fields.find((f) => f.key === 'activity_locations');
    expect(locations.required).toBe(false);
    expect(locations.requiredUnless).toEqual({ field: 'activity_level', value: 'None observed' });
    expect(slice.fields.find((f) => f.key === 'activity_level').requiredUnless).toBeNull();
  });

  test('German followup_window carries requiredUnless in the schema slice (Codex P2 round 6)', () => {
    const slice = findingsSchemaForType('german_roach_knockdown');
    const window = slice.fields.find((f) => f.key === 'followup_window');
    expect(window.required).toBe(false);
    expect(window.requiredUnless).toEqual({ field: 'followup_required', value: 'No' });
  });
});

describe('cross-field contradictions (Codex P2 round 6)', () => {
  test('a stale follow-up window is rejected once the answer is No', () => {
    for (const enforceRequired of [true, false]) {
      const stale = validateTypedFindings({
        type: 'german_roach_knockdown',
        values: { ...GERMAN_VALUES, followup_required: 'No' },
        expectedType: 'german_roach_knockdown',
        enforceRequired,
      });
      expect({ enforceRequired, ok: stale.ok }).toEqual({ enforceRequired, ok: false });
      expect(stale.errors.join(' ')).toMatch(/follow-up window/i);
    }
  });

  test('the monitor treatment chip cannot ride with "Monitors placed: No"', () => {
    const contradicted = validateTypedFindings({
      type: 'german_roach_knockdown',
      values: {
        ...GERMAN_VALUES,
        treatment_completed: 'Gel bait, Monitors / glue boards',
        monitors_placed: 'No',
      },
      expectedType: 'german_roach_knockdown',
      enforceRequired: true,
    });
    expect(contradicted.ok).toBe(false);
    expect(contradicted.errors.join(' ')).toMatch(/Monitors/);

    const agreeing = validateTypedFindings({
      type: 'german_roach_knockdown',
      values: { ...GERMAN_VALUES, treatment_completed: 'Gel bait, Monitors / glue boards' },
      expectedType: 'german_roach_knockdown',
      enforceRequired: true,
    });
    expect({ ok: agreeing.ok, errors: agreeing.errors }).toEqual({ ok: true, errors: [] });
  });

  test('palmetto "No action needed" chip requires a truly settled visit', () => {
    const activeVisit = validateNextStepChips(['No action needed'], 'palmetto_roach_knockdown', PALMETTO_VALUES);
    expect(activeVisit.ok).toBe(false);
    expect(activeVisit.error).toMatch(/activity level/);

    const wantsFollowup = validateNextStepChips(['No action needed'], 'palmetto_roach_knockdown',
      { ...PALMETTO_VALUES, activity_level: 'None observed', interior_activity: 'No', activity_locations: '', followup_needed: 'Yes' });
    expect(wantsFollowup.ok).toBe(false);
    expect(wantsFollowup.error).toMatch(/Follow-up needed: Yes/);

    const settled = validateNextStepChips(['No action needed'], 'palmetto_roach_knockdown',
      { ...PALMETTO_VALUES, activity_level: 'None observed', interior_activity: 'No', activity_locations: '' });
    expect(settled).toEqual({ ok: true, chips: ['No action needed'] });
  });
});

describe('final score vs cleared boundary (flea precedent)', () => {
  test('pinned knockdown scores cannot cross the cleared boundary', () => {
    for (const type of ['german_roach_knockdown', 'palmetto_roach_knockdown']) {
      const values = type === 'german_roach_knockdown' ? GERMAN_VALUES : PALMETTO_VALUES;
      const pinnedUp = validateActivityScoreConsistency(type,
        { ...values, activity_level: 'None observed' }, 2);
      expect({ type, ok: pinnedUp.ok }).toEqual({ type, ok: false });
      const pinnedDown = validateActivityScoreConsistency(type, values, 0);
      expect({ type, ok: pinnedDown.ok }).toEqual({ type, ok: false });
      // Agreement and in-range overrides stay legal.
      expect(validateActivityScoreConsistency(type,
        { ...values, activity_level: 'None observed' }, 0).ok).toBe(true);
      expect(validateActivityScoreConsistency(type, values, 4).ok).toBe(true);
    }
  });
});

describe('next-step chips vs structured follow-up answers (Codex P2 round 5)', () => {
  test('German follow-up chips must agree with followup_required and the selected window', () => {
    for (const chip of ['Follow-up recommended', 'Follow-up in 10–14 days']) {
      const result = validateNextStepChips([chip], 'german_roach_knockdown',
        { ...GERMAN_VALUES, followup_required: 'No', followup_window: '' });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/Follow-up required: No/);
    }
    for (const window of ['2–3 weeks', 'As needed']) {
      const result = validateNextStepChips(['Follow-up in 10–14 days'], 'german_roach_knockdown',
        { ...GERMAN_VALUES, followup_window: window });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/follow-up window/);
    }
    // The generic chip is window-agnostic; the dated chip matches its window.
    expect(validateNextStepChips(['Follow-up recommended'], 'german_roach_knockdown',
      { ...GERMAN_VALUES, followup_window: '2–3 weeks' }).ok).toBe(true);
    expect(validateNextStepChips(['Follow-up in 10–14 days'], 'german_roach_knockdown', GERMAN_VALUES).ok).toBe(true);
  });

  test('palmetto "Follow-up recommended" chip requires followup_needed Yes', () => {
    const rejected = validateNextStepChips(['Follow-up recommended'], 'palmetto_roach_knockdown', PALMETTO_VALUES);
    expect(rejected.ok).toBe(false);
    expect(rejected.error).toMatch(/Follow-up needed: No/);
    expect(validateNextStepChips(['Follow-up recommended'], 'palmetto_roach_knockdown',
      { ...PALMETTO_VALUES, followup_needed: 'Yes' }).ok).toBe(true);
    // Non-follow-up chips are unaffected by the answer.
    expect(validateNextStepChips(['Monitor activity'], 'palmetto_roach_knockdown', PALMETTO_VALUES).ok).toBe(true);
  });

  test('without values (legacy callers) chip validation is unchanged', () => {
    expect(validateNextStepChips(['Follow-up recommended'], 'palmetto_roach_knockdown').ok).toBe(true);
  });
});

describe('snapshot', () => {
  test('Yes/No selects render as findings sentences; whole snapshot is copy-safe', () => {
    expect(customerLabelForValue('live_roaches_observed', 'No')).toBe('No live roaches observed today');
    expect(customerLabelForValue('exterior_harborage', 'Yes')).toBe('Exterior harborage areas were identified');
    expect(customerLabelForValue('roach_type', 'Palmetto')).toContain('Palmetto bugs');

    for (const [type, values, key] of [
      ['german_roach_knockdown', GERMAN_VALUES, 'pest_initial_german_knockdown'],
      ['palmetto_roach_knockdown', PALMETTO_VALUES, 'pest_initial_palmetto_knockdown'],
    ]) {
      const snapshot = buildTypedReportSnapshot({
        projectType: type,
        values,
        nextStepChips: ['Monitor activity'],
        serviceKey: key,
        serviceLabel: PROJECT_TYPES[type].label,
        visitSequence: 1,
        activity: { indicatorKey: 'roach_activity', label: 'Roach Activity', score: 3, source: 'derived' },
      });
      expect(findBannedCustomerCopy(JSON.stringify(snapshot))).toEqual([]);
      expect(snapshot.activity.score).toBe(3);
    }
  });
});
