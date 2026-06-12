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
  validateNextStepChips,
  validateActivityScoreConsistency,
  findingsSchemaForType,
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
    expect(REQUIRED_FINDINGS_FIELDS.flea).toEqual(['evidence_level', 'treatment_completed', 'customer_prep']);
    expect(nextStepRequiredForType('flea')).toBe(true);
    for (const chip of TYPE_NEXT_STEP_CHIPS.flea) {
      expect({ chip, hasSentence: !!NEXT_STEP_CHIPS[chip] }).toEqual({ chip, hasSentence: true });
    }
  });

  test('conditional activity-areas requirement is served to the client (Codex P2 round 2)', () => {
    const slice = findingsSchemaForType('flea');
    const areas = slice.fields.find((f) => f.key === 'activity_areas');
    expect(areas.required).toBe(false);
    expect(areas.requiredUnless).toEqual({ field: 'evidence_level', value: 'None observed' });
    // Unconditional fields carry no rule — the client treats null as static.
    expect(slice.fields.find((f) => f.key === 'evidence_level').requiredUnless).toBeNull();
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

  test('a tech score of 1 on a confirmed finding never reads as "suspected" (Codex P2)', () => {
    const confirmed = buildTodaysResult({
      projectType: 'flea',
      reportTypeLabel: 'Flea Service Summary',
      values: FLEA_VALUES, // evidence_level: Moderate — confirmed activity
      chips: ['Monitor activity'],
      activity: { score: 1, source: 'technician' },
      visitSequence: 1,
    });
    expect(confirmed.headline).toBe('Flea activity was very low today.');
    expect(confirmed.headline).not.toContain('suspected');

    // A Suspected selection the tech re-scored away from 1 follows the score.
    const rescored = buildTodaysResult({
      projectType: 'flea',
      reportTypeLabel: 'Flea Service Summary',
      values: { ...FLEA_VALUES, evidence_level: 'Suspected' },
      chips: ['Monitor activity'],
      activity: { score: 3, source: 'technician' },
      visitSequence: 1,
    });
    expect(rescored.headline).toBe('Flea activity was moderate today.');
  });
});

describe('validation', () => {
  test('aftercare core enforced; full submission passes clean', () => {
    const empty = validateTypedFindings({ type: 'flea', values: {}, expectedType: 'flea', enforceRequired: true });
    expect(empty.ok).toBe(false);
    expect(empty.missing).toEqual(expect.arrayContaining(['evidence_level', 'treatment_completed', 'customer_prep']));

    const full = validateTypedFindings({ type: 'flea', values: FLEA_VALUES, expectedType: 'flea', enforceRequired: true });
    expect({ ok: full.ok, errors: full.errors, missing: full.missing }).toEqual({ ok: true, errors: [], missing: [] });
  });

  test('activity areas required exactly when there was activity to locate (Codex P2)', () => {
    const withActivity = validateTypedFindings({
      type: 'flea',
      values: { ...FLEA_VALUES, activity_areas: '' },
      expectedType: 'flea',
      enforceRequired: true,
    });
    expect(withActivity.ok).toBe(false);
    expect(withActivity.missing).toContain('activity_areas');

    // A truthful cleared visit has no activity area to name.
    const cleared = validateTypedFindings({
      type: 'flea',
      values: { ...FLEA_VALUES, evidence_level: 'None observed', activity_areas: '' },
      expectedType: 'flea',
      enforceRequired: true,
    });
    expect({ ok: cleared.ok, errors: cleared.errors, missing: cleared.missing })
      .toEqual({ ok: true, errors: [], missing: [] });

    // Areas left behind after flipping the level to 'None observed' are a
    // contradiction, not optional detail — the snapshot would render them
    // under a no-active-signs headline (Codex P2 round 3). Enforced even
    // pre-cutover (enforceRequired false): it is a contradiction either way.
    for (const enforceRequired of [true, false]) {
      const stale = validateTypedFindings({
        type: 'flea',
        values: { ...FLEA_VALUES, evidence_level: 'None observed' },
        expectedType: 'flea',
        enforceRequired,
      });
      expect({ enforceRequired, ok: stale.ok }).toEqual({ enforceRequired, ok: false });
      expect(stale.errors.join(' ')).toMatch(/Activity areas/);
    }
  });

  test('required chips with only empty parts count as missing (Codex P2)', () => {
    const result = validateTypedFindings({
      type: 'flea',
      values: { ...FLEA_VALUES, treatment_completed: ',', customer_prep: ' , ' },
      expectedType: 'flea',
      enforceRequired: true,
    });
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(expect.arrayContaining(['treatment_completed', 'customer_prep']));
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

describe('next-step chips vs recorded evidence (Codex P2 round 2)', () => {
  test('"No action needed" is rejected beside confirmed or suspected activity', () => {
    for (const level of ['Suspected', 'Light', 'Moderate', 'Heavy']) {
      const result = validateNextStepChips(['No action needed'], 'flea',
        { ...FLEA_VALUES, evidence_level: level });
      expect({ level, ok: result.ok }).toEqual({ level, ok: false });
      expect(result.error).toMatch(/No action needed/);
    }
  });

  test('"No action needed" stays available for truthful cleared visits', () => {
    const cleared = validateNextStepChips(['No action needed'], 'flea',
      { ...FLEA_VALUES, evidence_level: 'None observed', activity_areas: '' });
    expect(cleared).toEqual({ ok: true, chips: ['No action needed'] });
    // Aftercare chips are unaffected by the evidence level.
    expect(validateNextStepChips(['Vacuum daily for 2 weeks'], 'flea', FLEA_VALUES).ok).toBe(true);
    // Legacy callers without values keep the allowlist-only behavior.
    expect(validateNextStepChips(['No action needed'], 'flea').ok).toBe(true);
  });
});

describe('final score vs cleared evidence (Codex P2 round 4)', () => {
  test('pinned scores cannot cross the cleared boundary', () => {
    // Nonzero pin beside cleared evidence: headline would say activity was
    // present while the findings card says none was observed.
    const pinnedUp = validateActivityScoreConsistency('flea',
      { ...FLEA_VALUES, evidence_level: 'None observed', activity_areas: '' }, 2);
    expect(pinnedUp.ok).toBe(false);
    expect(pinnedUp.error).toMatch(/None observed/);

    // Zero pin beside positive evidence: cleared headline under a findings
    // card that records activity.
    const pinnedDown = validateActivityScoreConsistency('flea', FLEA_VALUES, 0);
    expect(pinnedDown.ok).toBe(false);
    expect(pinnedDown.error).toMatch(/Moderate/);
  });

  test('agreeing scores, in-range overrides, and non-gauge paths pass', () => {
    expect(validateActivityScoreConsistency('flea',
      { ...FLEA_VALUES, evidence_level: 'None observed', activity_areas: '' }, 0).ok).toBe(true);
    // Within the active range the tech override is legal — headline follows it.
    expect(validateActivityScoreConsistency('flea', FLEA_VALUES, 4).ok).toBe(true);
    expect(validateActivityScoreConsistency('flea', FLEA_VALUES, null).ok).toBe(true);
    // Types without a cleared-select rule are unaffected.
    expect(validateActivityScoreConsistency('pest_inspection', { severity: 'Low' }, 3).ok).toBe(true);
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
