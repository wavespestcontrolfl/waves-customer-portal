/**
 * Flea typed flow (owner spec 2026-06-12, Phase 2 §5): tap-to-fill form
 * with required aftercare, owner vocabulary scoring (Suspected between
 * cleared and Light), deterministic cooperation line in every report body,
 * and score-aligned headlines.
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
  buildTodaysResult,
  buildTypedReportSnapshot,
} = require('../services/service-report/activity-indicators');
const { PROJECT_TYPES } = require('../services/project-types');

const FLEA_VALUES = {
  evidence_level: 'Moderate',
  activity_areas: 'Exterior lawn, Pet resting area, Shaded yard',
  treatment_completed: 'Exterior flea treatment, Growth regulator',
  contributing_conditions: 'Pets present, Shaded / moist yard',
  customer_prep: 'Vacuum daily for 2 weeks, Wash pet bedding, Treat pets through veterinarian',
};

describe('flea schema', () => {
  test('owner vocabularies with required aftercare core', () => {
    const byKey = Object.fromEntries(PROJECT_TYPES.flea.findingsFields.map((f) => [f.key, f]));
    expect(byKey.evidence_level.options).toEqual(['None observed', 'Suspected', 'Light', 'Moderate', 'Heavy']);
    expect(byKey.customer_prep.options).toContain('Treat pets through veterinarian');
    expect(REQUIRED_FINDINGS_FIELDS.flea).toEqual(['evidence_level', 'activity_areas', 'treatment_completed', 'customer_prep']);
    expect(nextStepRequiredForType('flea')).toBe(true);
    for (const chip of TYPE_NEXT_STEP_CHIPS.flea) {
      expect({ chip, hasSentence: !!NEXT_STEP_CHIPS[chip] }).toEqual({ chip, hasSentence: true });
    }
  });

  test('owner scoring: Suspected sits between cleared and Light', () => {
    expect(ACTIVITY_INDICATORS.flea.indicatorKey).toBe('flea_activity');
    expect(deriveActivityScore('flea', { evidence_level: 'None observed' }).score).toBe(0);
    expect(deriveActivityScore('flea', { evidence_level: 'Suspected' }).score).toBe(1);
    expect(deriveActivityScore('flea', { evidence_level: 'Light' }).score).toBe(2);
    expect(deriveActivityScore('flea', { evidence_level: 'Heavy' }).score).toBe(4);
  });
});

describe('flea report', () => {
  test('cooperation line is deterministic; areas + composed treatments tell the story', () => {
    const result = buildTodaysResult({
      projectType: 'flea',
      reportTypeLabel: 'Flea Service Summary',
      values: FLEA_VALUES,
      chips: ['Vacuum daily for 2 weeks', 'Coordinate vet flea control'],
      activity: { score: 3 },
      visitSequence: 1,
    });
    expect(result.headline).toBe('Flea activity was moderate today.');
    expect(result.body).toContain('Completed your flea service with attention to the exterior lawn, pet resting area and shaded yard.');
    expect(result.body).toContain('completed a targeted exterior flea treatment');
    expect(result.body).toContain('applied an insect growth regulator');
    expect(result.body).toContain('Flea control works best when treatment and home care happen together');
    expect(result.body).toContain('Vacuum daily for the next two weeks');
    expect(findBannedCustomerCopy(JSON.stringify(result))).toEqual([]);
  });

  test('cleared and suspected states stay observational', () => {
    const cleared = buildTodaysResult({
      projectType: 'flea',
      reportTypeLabel: 'Flea Service Summary',
      values: { ...FLEA_VALUES, evidence_level: 'None observed' },
      chips: ['Monitor activity'],
      activity: { score: 0 },
      visitSequence: 1,
    });
    expect(cleared.headline).toBe('No active signs of flea activity observed today.');
    expect(cleared.body).toContain('Flea control works best when treatment and home care happen together');

    const suspected = buildTodaysResult({
      projectType: 'flea',
      reportTypeLabel: 'Flea Service Summary',
      values: { ...FLEA_VALUES, evidence_level: 'Suspected' },
      chips: ['Monitor activity'],
      activity: { score: 1 },
      visitSequence: 1,
    });
    expect(suspected.headline).toBe('Flea activity is suspected — no live activity was confirmed today.');
  });

  test('trend headline wins on later visits but the cooperation line survives', () => {
    const result = buildTodaysResult({
      projectType: 'flea',
      reportTypeLabel: 'Flea Program — Progress Visit',
      values: FLEA_VALUES,
      chips: ['Monitor activity'],
      activity: { score: 2, trend: 'improving', trendWord: 'decreased since the last visit' },
      visitSequence: 2,
    });
    expect(result.headline).toBe('Flea activity has decreased since our last visit.');
    expect(result.body).toContain('Flea control works best when treatment and home care happen together');
  });

  test('headline follows the final gauge score when the tech overrides it', () => {
    const result = buildTodaysResult({
      projectType: 'flea',
      reportTypeLabel: 'Flea Service Summary',
      values: { ...FLEA_VALUES, evidence_level: 'Light' },
      chips: ['Follow-up recommended'],
      activity: { score: 4, source: 'technician' },
      visitSequence: 1,
    });
    expect(result.headline).toBe('Flea activity was high today.');
    expect(result.headline).not.toContain('light');
  });
});

describe('validation', () => {
  test('aftercare core enforced; full submission passes clean', () => {
    const empty = validateTypedFindings({ type: 'flea', values: {}, expectedType: 'flea', enforceRequired: true });
    expect(empty.ok).toBe(false);
    expect(empty.missing).toEqual(expect.arrayContaining(['evidence_level', 'activity_areas', 'treatment_completed', 'customer_prep']));

    const full = validateTypedFindings({ type: 'flea', values: FLEA_VALUES, expectedType: 'flea', enforceRequired: true });
    expect({ ok: full.ok, errors: full.errors, missing: full.missing }).toEqual({ ok: true, errors: [], missing: [] });
  });

  test('"Inspection only" cannot ride with applied treatments', () => {
    const result = validateTypedFindings({
      type: 'flea',
      values: { ...FLEA_VALUES, treatment_completed: 'Inspection only, Lawn treatment' },
      expectedType: 'flea',
      enforceRequired: true,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/Inspection only/);
  });
});

describe('snapshot', () => {
  test('value labels render and the whole snapshot is copy-safe', () => {
    expect(customerLabelForValue('evidence_level', 'Suspected')).toBe('Activity suspected — not confirmed today');
    const snapshot = buildTypedReportSnapshot({
      projectType: 'flea',
      values: FLEA_VALUES,
      nextStepChips: ['Vacuum daily for 2 weeks', 'Wash pet bedding'],
      serviceKey: 'flea_tick',
      serviceLabel: 'Flea & Tick Service',
      visitSequence: 1,
      activity: { indicatorKey: 'flea_activity', label: 'Flea Activity', score: 3, source: 'derived' },
    });
    expect(findBannedCustomerCopy(JSON.stringify(snapshot))).toEqual([]);
    expect(snapshot.activity.score).toBe(3);
  });
});
