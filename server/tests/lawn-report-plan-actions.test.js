/**
 * With a weekly watering plan on the card, every actionable watering
 * statement defers to the plan (codex #3565 gh-r27): insight-card actions,
 * the root-cause sentence, the surplus watering-in aftercare clause.
 */
const { buildLawnInsightCards } = require('../services/service-report/lawn-report-insights');
const {
  buildLawnReportV2,
  buildRootCause,
  buildAftercare,
  NEUTRAL_AFTERCARE_WITH_PLAN,
} = require('../services/service-report/lawn-report-v2');
const { answerServiceReportQuestion } = require('../services/service-report/report-assistant');

const PLAN = { title: 'This week: check the rain before you water', detail: '…', action: 'run', conditionalOnForecast: true };
const RUN_PLAN = { title: 'This week: 25 minutes per turf zone', detail: '…', action: 'run', conditionalOnForecast: false };
const HOLD_PLAN = { title: 'This week: skip your turf watering', detail: '…', action: 'hold', conditionalOnForecast: false };

const WATER_ASSESSMENT = {
  scores: {
    turfDensity: 80, weedSuppression: 80, colorHealth: 80,
    stressDamage: 80, fungusControl: 80, overallScore: 80, season: 'peak',
  },
  overwateringSignal: true,
  droughtStress: 'none',
  turfProfile: { grassType: 'st_augustine' },
  waterContext: {
    rainfallInches7d: 2,
    irrigationInchesPerWeek: 1,
    effectiveInches7d: 3,
    targetInchesPerWeek: 1.25,
    irrigationAdvice: {
      status: 'surplus', rainKnown: true, profileMissing: false,
      recommendedInchesPerWeek: 1.25,
    },
    weekPlan: RUN_PLAN,
  },
};

function combinedWaterReport(applications, assessmentOverrides = {}) {
  return buildLawnReportV2({
    lawnAssessment: { ...WATER_ASSESSMENT, ...assessmentOverrides },
    applications,
  });
}

function combinedWaterCard(report) {
  return report.insights.find((card) => card.category === 'water');
}

describe('insight cards defer to the plan', () => {
  const waterCard = (water, extra = {}) => buildLawnInsightCards({ categories: [], water, grassLabel: 'St. Augustine', ...extra }).find((c) => c.category === 'water');
  test('deficit: no "add irrigation time" when a plan is present', () => {
    expect(waterCard({ status: 'deficit' }).customerAction).toMatch(/Add a little irrigation time/);
    const withPlan = waterCard({ status: 'deficit', weekPlan: PLAN });
    expect(withPlan.customerAction).toMatch(/Follow this week’s watering plan below/);
    expect(withPlan.customerAction).not.toMatch(/irrigation time/);
    expect(withPlan.nextVisitPlan).not.toMatch(/added water/);
    expect(withPlan.wavesAction).toMatch(/this week’s watering plan/);
  });
  test('surplus: no "ease back by one cycle" when a plan is present (watering-in variant included)', () => {
    expect(waterCard({ status: 'surplus' }).customerAction).toMatch(/Ease back on irrigation by one cycle/);
    expect(waterCard({ status: 'surplus', weekPlan: PLAN }).customerAction).toMatch(/Follow this week’s watering plan below — it already accounts for the extra water/);
    expect(waterCard({ status: 'surplus', weekPlan: PLAN }, { waterInRequired: true }).customerAction).toMatch(/^Water in today’s application as directed, then follow this week’s watering plan below/);
  });
});

describe('combined report gives product aftercare priority over water insights', () => {
  const confirmFirst = 'Confirm the product watering directions with your technician before changing irrigation.';

  test.each([
    ['missing', [{ product: { irrigation_required: true } }], {}],
    ['incomplete', [{ product: { irrigation_required: true, irrigation_notes: 'Water in.' } }], {
      waterContext: {
        ...WATER_ASSESSMENT.waterContext,
        irrigationAdvice: { ...WATER_ASSESSMENT.waterContext.irrigationAdvice, status: 'balanced' },
      },
    }],
    ['opposing', [
      { product: { irrigation_required: true, irrigation_notes: 'Water after service.' } },
      { product: { irrigation_required: false, irrigation_notes: 'Do not water for 24 hours after service.' } },
    ], {}],
  ])('%s product directions require confirmation before the water-card action', (_name, applications, assessmentOverrides) => {
    const report = combinedWaterReport(applications, assessmentOverrides);
    expect(report.aftercare).toMatchObject({ needsReview: true, creditableWaterIn: false });
    expect(combinedWaterCard(report).customerAction).toBe(confirmFirst);
  });

  test('an explicit hold controls the water card even when water-in is not required', () => {
    const report = combinedWaterReport([{
      product: { irrigation_required: false, irrigation_notes: 'Do not water for 24 hours after service.' },
    }]);
    expect(report.aftercare).toMatchObject({
      wateringHold: true,
      waterInRequired: false,
      needsReview: false,
    });
    expect(combinedWaterCard(report).customerAction).toBe(
      'Follow the product-specific watering restriction in Aftercare before making any other irrigation changes.',
    );
  });

  test('a complete supported water-in keeps the existing plan-aware action', () => {
    const report = combinedWaterReport([{
      product: { irrigation_required: true, irrigation_notes: 'Water in with 0.25 inches within 24 hours.' },
    }]);
    expect(report.aftercare).toMatchObject({
      wateringHold: false,
      needsReview: false,
      creditableWaterIn: true,
    });
    expect(combinedWaterCard(report).customerAction).toBe(
      'Water in today’s application as directed, then follow this week’s watering plan below — it already accounts for the extra water.',
    );
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
  test('source pin: only a recorded instruction points at the plan, never a reduced schedule', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'services', 'service-report', 'lawn-report-v2.js'), 'utf8');
    expect(src).toMatch(/After completing that product-specific instruction, follow this week’s approved watering plan\.'/);
    expect(src).not.toMatch(/return to the reduced schedule/);
    expect(src).toMatch(/weekPlan: water \? water\.weekPlan : null \}\);/);
  });
});

describe('neutral aftercare defers to the plan (codex gh-r28)', () => {
  test('buildAftercare flags its non-label fallback; label copy is never flagged', () => {
    expect(buildAftercare([])).toMatchObject({ neutral: true, waterInRequired: null });
    expect(buildAftercare([{ product: { irrigation_required: true } }])).toMatchObject({ neutral: false, waterInRequired: true });
    expect(buildAftercare([{ product: { irrigation_notes: 'Do not water for 24 hours.' } }])).toMatchObject({ neutral: false, watering: 'Do not water for 24 hours.' });
  });
  test('a circular catalog note cannot credit required watering against the plan', () => {
    for (const irrigationNotes of [
      'Watering or rainfall may be needed after application when directed by the service report.',
      'Follow the service report for any watering instructions after application.',
    ]) {
      expect(buildAftercare([{ product: { irrigation_required: true, irrigation_notes: irrigationNotes } }]))
        .toMatchObject({
          watering: expect.stringMatching(/does not include a specific amount or timing/i),
          waterInRequired: true,
          evidenceSource: 'incomplete_product_instruction',
          needsReview: true,
        });
    }
  });
  test('specific amount and timing survive an otherwise deferred "as directed" qualifier', () => {
    const watering = 'Water in with 0.25 inches within 24 hours as directed by your technician.';
    expect(buildAftercare([{ product: { irrigation_required: true, irrigation_notes: watering } }]))
      .toMatchObject({
        watering,
        waterInRequired: true,
        evidenceSource: 'product_instruction',
        needsReview: false,
        creditableWaterIn: true,
      });
  });
  test('numbers and timing words do not turn conditional report references into instructions', () => {
    for (const irrigationNotes of [
      'Watering may be needed within 24 hours when directed by the service report.',
      'Follow the service report for watering instructions within 24 hours.',
      'Follow the service report for watering instructions today.',
    ]) {
      expect(buildAftercare([{ product: { irrigation_required: true, irrigation_notes: irrigationNotes } }]))
        .toMatchObject({
          waterInRequired: true,
          evidenceSource: 'incomplete_product_instruction',
          needsReview: true,
          creditableWaterIn: false,
        });
    }
  });
  test('required watering needs a positive amount or timing before it can be credited', () => {
    for (const irrigationNotes of ['Water in.', 'Do not water for 24 hours.']) {
      expect(buildAftercare([{ product: { irrigation_required: true, irrigation_notes: irrigationNotes } }]))
        .toMatchObject({
          waterInRequired: true,
          evidenceSource: 'incomplete_product_instruction',
          needsReview: true,
        });
    }
    expect(buildAftercare([{ product: { irrigation_required: true, irrigation_notes: 'Water after service.' } }]))
      .toMatchObject({ evidenceSource: 'product_instruction', needsReview: false, creditableWaterIn: true });
    expect(buildAftercare([{ product: { irrigation_required: false, irrigation_notes: 'Do not water for 24 hours.' } }]))
      .toMatchObject({ evidenceSource: 'product_instruction', needsReview: false, creditableWaterIn: false });
  });
  test('source pin: with a plan the neutral copy is rewritten, label copy untouched', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'services', 'service-report', 'lawn-report-v2.js'), 'utf8');
    expect(src).toMatch(/if \(aftercare\.neutral && water && water\.weekPlan && water\.weekPlan\.title\) \{\s*aftercare\.watering = NEUTRAL_AFTERCARE_WITH_PLAN;/);
    expect(NEUTRAL_AFTERCARE_WITH_PLAN).toMatch(/Follow this week’s approved watering plan/);
    expect(NEUTRAL_AFTERCARE_WITH_PLAN).not.toMatch(/normal schedule/);
  });
});

describe('multi-product aftercare keeps compatible catalog constraints (codex PR4892 r5)', () => {
  const aceleprynRainPrecaution = 'Avoid application when rainfall is forecast within 48 hours to reduce runoff.';
  const driveWateringHold = 'For best results, do not water or irrigate for 24 hours after application.';

  test('Acelepryn plus Drive retains both constraints and records the explicit no-water hold', () => {
    const aftercare = buildAftercare([
      { product: { name: 'Acelepryn Xtra', epa_reg_number: '100-1680', irrigation_notes: aceleprynRainPrecaution } },
      { product: { name: 'Drive XLR8', epa_reg_number: '7969-272', irrigation_notes: driveWateringHold } },
    ]);
    expect(aftercare).toMatchObject({ wateringHold: true, evidenceSource: 'product_instruction', needsReview: false });
    expect(aftercare.watering).toContain(aceleprynRainPrecaution);
    expect(aftercare.watering).toContain(driveWateringHold);
  });

  test('a standalone explicit rainfall precaution survives while circular placeholders remain review copy', () => {
    expect(buildAftercare([{ product: { irrigation_notes: aceleprynRainPrecaution } }])).toMatchObject({
      watering: aceleprynRainPrecaution,
      wateringHold: false,
      evidenceSource: 'product_instruction',
      needsReview: false,
    });
  });

  test('different positive water-in directions require review before earning plan credit', () => {
    const first = 'Water within 1 hour after application.';
    const second = 'Water only after 24 hours have passed.';
    const aftercare = buildAftercare([
      { product: { irrigation_required: true, irrigation_notes: first } },
      { product: { irrigation_required: true, irrigation_notes: second } },
    ]);
    expect(aftercare).toMatchObject({
      wateringHold: false,
      waterInRequired: true,
      evidenceSource: 'conflicting_product_instructions',
      needsReview: true,
    });
    expect(aftercare.watering).toContain(first);
    expect(aftercare.watering).toContain(second);
  });

  test('the same complete instruction on two required products stays creditable', () => {
    const product = { irrigation_required: true, irrigation_notes: 'Water in with 0.25 inches within 24 hours.' };
    expect(buildAftercare([{ product }, { product }])).toMatchObject({
      watering: product.irrigation_notes,
      evidenceSource: 'product_instruction',
      needsReview: false,
      wateringHold: false,
      creditableWaterIn: true,
    });
  });

  test('keep watering is a positive instruction rather than a prohibition', () => {
    expect(buildAftercare([{ product: { irrigation_required: true, irrigation_notes: 'Keep watering for 20 minutes after application.' } }])).toMatchObject({
      wateringHold: false,
      evidenceSource: 'product_instruction',
      needsReview: false,
    });
  });

  test('a circular follow-up sentence does not discard an explicit hold or its duration', () => {
    expect(buildAftercare([{ product: { irrigation_notes: 'Do not water for 24 hours. Follow the service report for further instructions.' } }])).toMatchObject({
      watering: 'Do not water for 24 hours.',
      wateringHold: true,
      evidenceSource: 'product_instruction',
      needsReview: false,
    });
  });

  test('opposing positive and hold directions preserve both constraints but require review', () => {
    const positive = 'Water after service.';
    const hold = 'Do not water for 24 hours after service.';
    const aftercare = buildAftercare([
      { product: { irrigation_required: true, irrigation_notes: positive } },
      { product: { irrigation_required: false, irrigation_notes: hold } },
    ]);
    expect(aftercare).toMatchObject({ wateringHold: true, evidenceSource: 'conflicting_product_instructions', needsReview: true });
    expect(aftercare.watering).toContain(positive);
    expect(aftercare.watering).toContain(hold);
    expect(aftercare.watering).toMatch(/Confirm the directions/);
  });

  test.each([true, false])('the assistant conditions the full plan on the recorded restriction ending (visitInPlanWeek=%s)', (visitInPlanWeek) => {
    const aftercare = buildAftercare([
      { product: { name: 'Acelepryn Xtra', epa_reg_number: '100-1680', irrigation_notes: aceleprynRainPrecaution } },
      { product: { name: 'Drive XLR8', epa_reg_number: '7969-272', irrigation_notes: driveWateringHold } },
    ]);
    const data = { reportV2: { aftercare, water: { weekPlan: {
      title: 'This week: run once', detail: 'Run each turf zone for 20 minutes tonight.',
      visitInPlanWeek, prescribesRun: true,
    } } } };
    for (const question of ['Should I water after today’s treatment?', 'How should I water this week?']) {
      const answer = answerServiceReportQuestion({ question, data });
      expect(answer).toContain(driveWateringHold);
      expect(answer).toMatch(/only after that restriction has ended/);
      expect(answer).toMatch(/only within the plan’s listed days and watering windows/);
      expect(answer).toContain('This week: run once');
      expect(answer.indexOf(driveWateringHold)).toBeLessThan(answer.indexOf('This week: run once'));
    }
  });

  test('review-required watering directions need confirmation before the full plan applies', () => {
    const aftercare = buildAftercare([
      { product: { irrigation_required: true, irrigation_notes: 'Water within 1 hour after application.' } },
      { product: { irrigation_required: true, irrigation_notes: 'Water only after 24 hours have passed.' } },
    ]);
    const answer = answerServiceReportQuestion({ question: 'How should I water this week?', data: { reportV2: {
      aftercare,
      water: { weekPlan: { title: 'This week: run once', detail: 'Run for 20 minutes.', visitInPlanWeek: true, prescribesRun: true,
        afterTreatment: { title: 'No further turf runs this week', detail: 'Already covered.' } } },
    } } });
    expect(answer).toContain('Confirm the product watering directions with your technician before applying the plan below');
    expect(answer).toContain('This week: run once');
    expect(answer).not.toContain('No further turf runs');
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
    expect(card({ status: 'balanced', overwatering: true, weekPlan: PLAN }, { waterInRequired: true }).customerAction).toMatch(/^Water in today’s application as directed first.*this week’s watering plan below already accounts for it/);
  });
});
