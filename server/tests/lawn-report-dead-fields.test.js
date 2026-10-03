/**
 * P6 of the lawn report rebuild: retire the unrendered payload fields and the
 * placeholder photo caption.
 *  - snapshot.mainWatch and the top-level seasonalNote left the payload
 *    (the hero reads snapshot.seasonalNote and never read mainWatch).
 *  - photoSummary is null for the stock NO_OBSERVATIONS placeholder.
 *  - the narrative model no longer writes mainWatch / treatmentSummary, and an
 *    old model response (or cached output) that still carries them is ignored.
 */

const { buildLawnReportV2 } = require('../services/service-report/lawn-report-v2');
const { _test } = require('../services/service-report/lawn-report-narrative');
const { NO_OBSERVATIONS } = require('../services/lawn-visit-customer-copy');

function assessment(overrides = {}) {
  return {
    scores: { turfDensity: 73, weedSuppression: 81, colorHealth: 77, stressDamage: 35, fungusControl: 95, overallScore: 68, season: 'peak' },
    overwateringSignal: false,
    droughtStress: 'minor',
    turfProfile: { grassType: 'st_augustine' },
    observations: 'Mild drought stress in the mid-lawn zone.',
    waterContext: {
      rainfallInches7d: 0.9, irrigationInchesPerWeek: 0.7, effectiveInches7d: 1.6, targetInchesPerWeek: 1.25,
      irrigationAdvice: { status: 'balanced', rainKnown: true, profileMissing: false, recommendedInchesPerWeek: 1.25 },
    },
    ...overrides,
  };
}

describe('lawn report payload — retired fields', () => {
  test('snapshot has no mainWatch and the payload has no top-level seasonalNote', () => {
    const v2 = buildLawnReportV2({ lawnAssessment: assessment() });
    expect(v2.snapshot).not.toHaveProperty('mainWatch');
    expect(v2).not.toHaveProperty('seasonalNote');
  });

  test('snapshot.seasonalNote (rendered by the hero) and snapshot.treatmentSummary stay', () => {
    const v2 = buildLawnReportV2({ lawnAssessment: assessment() });
    expect(v2.snapshot).toHaveProperty('seasonalNote');
    expect(v2.snapshot).toHaveProperty('treatmentSummary');
  });
});

describe('lawn report photoSummary — placeholder caption', () => {
  test('the NO_OBSERVATIONS placeholder becomes null', () => {
    expect(buildLawnReportV2({ lawnAssessment: assessment({ observations: NO_OBSERVATIONS }) }).photoSummary).toBeNull();
    expect(buildLawnReportV2({ lawnAssessment: assessment({ observations: `  ${NO_OBSERVATIONS}  ` }) }).photoSummary).toBeNull();
  });

  test('real copy is unchanged and empty stays null', () => {
    expect(buildLawnReportV2({ lawnAssessment: assessment() }).photoSummary).toBe('Mild drought stress in the mid-lawn zone.');
    expect(buildLawnReportV2({ lawnAssessment: assessment({ observations: '' }) }).photoSummary).toBeNull();
  });

  test('copy that merely contains the placeholder wording is kept', () => {
    const text = `${NO_OBSERVATIONS} Edge near the driveway is thin.`;
    expect(buildLawnReportV2({ lawnAssessment: assessment({ observations: text }) }).photoSummary).toBe(text);
  });
});

describe('lawn narrative — dead model outputs removed', () => {
  const facts = { diagnosis: [{ key: 'turf_density' }] };

  test('JSON schema no longer lists or requires mainWatch / treatmentSummary', () => {
    const schema = _test.narrativeSchema(facts);
    expect(schema.properties).not.toHaveProperty('mainWatch');
    expect(schema.properties).not.toHaveProperty('treatmentSummary');
    expect(schema.required).not.toContain('mainWatch');
    expect(schema.required).not.toContain('treatmentSummary');
    expect(schema.required).toEqual(expect.arrayContaining(['statusHeadline', 'customerAction', 'categories', 'water', 'mowing', 'insights']));
    expect(Object.keys(schema.properties).sort()).toEqual([...schema.required].sort());
  });

  test('OUTPUT prompt no longer asks for either field', () => {
    expect(_test.SYSTEM_PROMPT).not.toMatch(/mainWatch/);
    expect(_test.SYSTEM_PROMPT).not.toMatch(/treatmentSummary/);
  });

  test('PROMPT_VERSION was bumped so cached narratives regenerate', () => {
    expect(_test.PROMPT_VERSION).toBe('lawn_report_v2_narrative_v11_no_dead_fields');
  });

  test('an old response that still carries the keys merges without writing them', () => {
    const v2 = buildLawnReportV2({ lawnAssessment: assessment() });
    v2.treatment = { focus: ['Weed control'], products: [] };
    const before = JSON.parse(JSON.stringify(v2));
    const merged = _test.mergeNarrative(v2, {
      statusHeadline: 'A steady lawn with one spot to watch',
      mainWatch: 'Watch the mid-lawn zone this week.',
      treatmentSummary: 'We applied a fertilizer to feed the turf.',
    });
    expect(merged.snapshot).not.toHaveProperty('mainWatch');
    expect(merged.treatment).toEqual(before.treatment);
    expect(merged.treatment).not.toHaveProperty('summary');
    expect(merged.snapshot.treatmentSummary).toBe(before.snapshot.treatmentSummary);
    expect(merged.snapshot.statusHeadline).toBe('A steady lawn with one spot to watch');
  });
});

describe('lawn report seasonal-dip card — P16 routes the approved row sentence', () => {
  const { ISSUE_ROWS } = require('../config/lawn-expectations');
  test('a seasonally muted color card prints the seasonal-dip row, with no hand-written regrowth promise', () => {
    const v2 = buildLawnReportV2({
      lawnAssessment: assessment({
        assessmentDate: '2026-01-15',
        scores: { turfDensity: 73, weedSuppression: 81, colorHealth: 60, stressDamage: 80, fungusControl: 95, overallScore: 70, season: 'dormant' },
      }),
    });
    const color = v2.diagnosis.find((c) => c.key === 'color_vigor');
    expect(color.seasonal).toBe(true);
    expect(color.customerExplanation).toBe(ISSUE_ROWS.seasonal_dip.visibleChange);
    expect(color.explanation).toBe(ISSUE_ROWS.seasonal_dip.visibleChange);
    expect(color.customerExplanation).not.toMatch(/should green back up/i);
  });
});
