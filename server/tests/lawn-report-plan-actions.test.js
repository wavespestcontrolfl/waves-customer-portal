/**
 * With a weekly watering plan on the card, every actionable watering
 * statement defers to the plan (codex #3565 gh-r27): insight-card actions,
 * the root-cause sentence, the surplus watering-in aftercare clause.
 */
const { buildLawnInsightCards } = require('../services/service-report/lawn-report-insights');
const { buildRootCause, buildAftercare, NEUTRAL_AFTERCARE_WITH_PLAN } = require('../services/service-report/lawn-report-v2');

const PLAN = { title: 'This week: check the rain before you water', detail: '…', action: 'run', conditionalOnForecast: true };
const RUN_PLAN = { title: 'This week: 25 minutes per turf zone', detail: '…', action: 'run', conditionalOnForecast: false };
const HOLD_PLAN = { title: 'This week: skip your turf watering', detail: '…', action: 'hold', conditionalOnForecast: false };
const RECORDED_WATER_IN = {
  watering: 'Water in with 0.25 inches today.',
  waterInRequired: true,
  creditableWaterIn: true,
  evidenceSource: 'product_instruction',
  wateringHold: false,
  needsReview: false,
};

describe('insight cards defer to the plan', () => {
  const waterCard = (water, extra = {}) => buildLawnInsightCards({ categories: [], water, grassLabel: 'St. Augustine', ...extra }).find((c) => c.category === 'water');
  test('deficit: no "add irrigation time" when a plan is present', () => {
    expect(waterCard({ status: 'deficit' }).customerAction).toMatch(/Add a little irrigation time/);
    const withPlan = waterCard({ status: 'deficit', weekPlan: PLAN });
    expect(withPlan.customerAction).toMatch(/Follow this week’s watering plan below/);
    expect(withPlan.customerAction).not.toMatch(/irrigation time/);
    expect(withPlan.nextVisitPlan).not.toMatch(/added water/);
    // Gate off (this suite): the stock line stays. GATE_LAWN_REPORT_LEAD nulls it (lawn-report-card-diet.test.js).
    expect(withPlan.wavesAction).toMatch(/this week’s watering plan/);
  });
  test('surplus: no "ease back by one cycle" when a plan is present (watering-in variant included)', () => {
    expect(waterCard({ status: 'surplus' }).customerAction).toMatch(/Ease back on irrigation by one cycle/);
    expect(waterCard({ status: 'surplus', weekPlan: PLAN }).customerAction).toMatch(/Follow this week’s watering plan below — it already accounts for the extra water/);
    expect(waterCard({ status: 'surplus', weekPlan: PLAN }, { aftercare: RECORDED_WATER_IN }).customerAction).toMatch(/^Water in today’s application as directed, then follow this week’s watering plan below/);
    expect(waterCard({ status: 'surplus', weekPlan: PLAN }, { waterInRequired: true }).customerAction).not.toMatch(/^Water in today’s application/);
  });
});

describe('root cause defers to the plan', () => {
  test('surplus and deficit name the plan; other stories unchanged', () => {
    expect(buildRootCause({ effectiveWaterStatus: 'deficit' })).toMatch(/a bit more even watering/);
    // gh-r37: the sentence agrees with the card's ACTION — never "sets the runs" beside a hold, never "eases back" beside a run.
    expect(buildRootCause({ effectiveWaterStatus: 'deficit', weekPlan: RUN_PLAN })).toMatch(/this week’s watering plan below sets the runs/);
    expect(buildRootCause({ effectiveWaterStatus: 'deficit', weekPlan: HOLD_PLAN })).toMatch(/weighs that against the week’s rain, so follow it as written/);
    expect(buildRootCause({ effectiveWaterStatus: 'deficit', weekPlan: PLAN })).toMatch(/weighs that against the week’s rain/); // conditional ≠ a promise of runs
    expect(buildRootCause({ effectiveWaterStatus: 'deficit', weekPlan: { title: 'x' } })).toMatch(/weighs that against the week’s rain/); // legacy card without an action = neutral
    expect(buildRootCause({ effectiveWaterStatus: 'surplus', weekPlan: HOLD_PLAN })).toMatch(/this week’s watering plan below already eases back/);
    expect(buildRootCause({ effectiveWaterStatus: 'surplus', weekPlan: RUN_PLAN })).toMatch(/already accounts for it/);
    expect(buildRootCause({ effectiveWaterStatus: 'surplus', weekPlan: RUN_PLAN })).not.toMatch(/eases back/);
    expect(buildRootCause({ effectiveWaterStatus: 'balanced', coverageWatch: true, weekPlan: PLAN })).toMatch(/uneven sprinkler coverage/);
  });
});

describe('surplus aftercare clause', () => {
  test('source pin: with a plan the watering-in exception points at the plan, not "the reduced schedule"', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'services', 'service-report', 'lawn-report-v2.js'), 'utf8');
    expect(src).toMatch(/after it, follow this week’s watering plan\.'/);
    expect(src).toMatch(/weekPlan: water \? water\.weekPlan : null \}\);/);
  });
});

describe('neutral aftercare defers to the plan (codex gh-r28)', () => {
  test('buildAftercare flags its non-label fallback; label copy is never flagged', () => {
    expect(buildAftercare([])).toEqual({
      watering: 'No special watering is needed because of today’s treatment — keep your normal schedule unless your technician advised otherwise.',
      reentry: null,
      waterInRequired: null,
      neutral: true,
    });
    expect(buildAftercare([{ product: { irrigation_required: true } }])).toMatchObject({ neutral: false, waterInRequired: true, needsReview: true, creditableWaterIn: false });
    expect(buildAftercare([{ product: { irrigation_notes: 'Do not water for 24 hours.' } }])).toMatchObject({
      neutral: false,
      evidenceSource: 'legacy_unverified_instruction',
      needsReview: true,
      creditableWaterIn: false,
    });
  });
  test('source pin: with a plan the neutral copy is rewritten, label copy untouched', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'services', 'service-report', 'lawn-report-v2.js'), 'utf8');
    expect(src).toMatch(/if \(aftercare\.neutral && water && water\.weekPlan && water\.weekPlan\.title\) \{\s*aftercare\.watering = NEUTRAL_AFTERCARE_WITH_PLAN;/);
    expect(NEUTRAL_AFTERCARE_WITH_PLAN).toMatch(/follow this week’s watering plan/);
    expect(NEUTRAL_AFTERCARE_WITH_PLAN).not.toMatch(/normal schedule/);
  });
});

describe('generic moisture card defers to the plan (codex gh-r29)', () => {
  const cats = [{ key: 'water_moisture_stress', status: 'watch', customerExplanation: 'Mixed read.' }];
  const card = (water, extra = {}) => buildLawnInsightCards({ categories: cats, water, grassLabel: 'lawn', ...extra }).find((c) => c.category === 'water');
  test('no "keep your current schedule" / "ease back a cycle" under a plan', () => {
    expect(card({ status: 'balanced', scheduleOnFile: true }).customerAction).toMatch(/Keep your current watering schedule/);
    expect(card({ status: 'balanced', scheduleOnFile: true, weekPlan: PLAN }).customerAction).toMatch(/Follow this week’s watering plan below/);
    expect(card({ status: 'balanced', overwatering: true }).customerAction).toMatch(/ease back an irrigation cycle/);
    expect(card({ status: 'balanced', overwatering: true, weekPlan: PLAN }).customerAction).toMatch(/follow this week’s watering plan below rather than adding cycles/);
    expect(card({ status: 'balanced', overwatering: true, weekPlan: PLAN }, { aftercare: RECORDED_WATER_IN }).customerAction).toMatch(/^Water in today’s application as directed first.*this week’s watering plan below already accounts for it/);
  });
});

describe('aftercare evidence guards', () => {
  test('replaces the inferred 24-hour instruction with confirmation', () => {
    const aftercare = buildAftercare([{ product: { irrigation_required: true } }]);
    expect(aftercare.watering).toMatch(/^Today’s application is recorded as requiring water-in/);
    expect(aftercare.watering).toMatch(/Confirm the directions with your technician/);
    expect(aftercare.watering).not.toMatch(/normal watering|within the next 24 hours/);
  });

  test('preserves every recorded note beside confirmation until classification', () => {
    const aftercare = buildAftercare([
      { product: { irrigation_required: true, irrigation_notes: 'Use the product label direction.' } },
      { product: { irrigation_notes: 'Keep the marked zone dry.' } },
    ]);
    expect(aftercare.watering).toContain('Use the product label direction.');
    expect(aftercare.watering).toContain('Keep the marked zone dry.');
    expect(aftercare.watering).toMatch(/Confirm the directions with your technician/);
    expect(aftercare).toMatchObject({ needsReview: true, creditableWaterIn: false });
  });

  test('does not deny an amount or timing that the retained product note records', () => {
    const aftercare = buildAftercare([{
      product: {
        irrigation_required: true,
        irrigation_notes: 'Apply 0.25 inches within 24 hours.',
      },
    }]);
    expect(aftercare.watering).toContain('Apply 0.25 inches within 24 hours.');
    expect(aftercare.watering).toMatch(/Confirm the directions with your technician/);
    expect(aftercare.watering).not.toMatch(/amount and timing are not recorded|not recorded in this report/);
  });

  test('review and hold evidence override irrigation-changing insight copy', () => {
    const water = { status: 'deficit', weekPlan: RUN_PLAN };
    const card = (aftercare) => buildLawnInsightCards({ categories: [], water, grassLabel: 'St. Augustine', aftercare })
      .find((insight) => insight.category === 'water');
    expect(card({ watering: 'Recorded note.', needsReview: true, evidenceSource: 'legacy_unverified_instruction' }).customerAction)
      .toMatch(/Confirm the product watering directions/);
    expect(card({ watering: 'Do not water for 24 hours.', wateringHold: true, evidenceSource: 'product_instruction' }).customerAction)
      .toMatch(/Follow the product-specific watering restriction/);
  });
});
