// GATE_LAWN_REPORT_COPY_FIXES: six customer-copy fixes on the lawn report, all behind one
// dark gate (owner 2026-10-08/09). Gate off = the payload this report has always had; gate on =
// the new behaviour. Synthetic data only.
//
//   1. no active ingredient / catalog name in a sentence (category words instead)
//   2. the seasonal color line rule (cool month AND score did not rise)
//   3. "Weed Pressure" -> "Weed Cleanliness"
//   4. the pest re-service footer wording (payload flag; client tests cover the render)
//   5. stale Water Gap / Mowing Height charts
//   6. the water target source line

jest.mock('../services/lawn-assessment-history', () => ({
  installedForVisit: jest.fn(),
  historyForReport: jest.fn(),
  historyForAssessment: jest.fn(),
  restrictVisitHistory: (query) => query,
}));
jest.mock('../services/llm/call', () => {
  const actual = jest.requireActual('../services/llm/call');
  return { ...actual, dispatchWithFallback: jest.fn() };
});

const history = require('../services/lawn-assessment-history');
const featureGates = require('../config/feature-gates');
const { buildReportV1Data, resolveCanonicalLawnRender } = require('../services/service-report/report-data');
const { buildLawnReportV2 } = require('../services/service-report/lawn-report-v2');
const { lawnTreatmentNarrative, WATER_TARGET_NOTES } = require('../services/service-report/lawn-report-copy-fixes');
const { buildTreatmentSummary, buildCategoryTreatmentSummary } = require('../services/service-report/treatment-summary');
const { buildLawnCopyV6, resolveLawnCopyV6ForRender } = require('../services/service-report/lawn-copy-v6');
const treatmentNarrative = require('../services/service-report/treatment-narrative');
const { treatmentNarrativePdfSignature } = treatmentNarrative;
const { buildIrrigationAdvice, isKnownGrass } = require('../services/service-report/irrigation-advice');
const { seasonalColorLineAllowed } = require('../services/service-report/lawn-seasonality');
const tech = require('../services/service-report/lawn-tech-paragraph');
const { gatherTechParagraphInputs } = require('../services/service-report/lawn-tech-paragraph-inputs');
const { appliedCategoryPhrases, APPLIED_PHRASES } = require('../services/service-report/lawn-visit-summary');
const { customerCopyViolations } = require('../services/service-report/technician-report-copy');

const GATE = 'GATE_LAWN_REPORT_COPY_FIXES';
const saved = process.env[GATE];
const gateOn = () => { process.env[GATE] = 'true'; };
const gateOff = () => { delete process.env[GATE]; };
afterEach(() => { if (saved === undefined) gateOff(); else process.env[GATE] = saved; });

// ── products ────────────────────────────────────────────────────────────────
const STONEWALL = { name: 'LESCO Stonewall 0.43% 15-0-15 Pre-emergent Fertilizer with Micronutrients', activeIngredient: 'Prodiamine 0.43%', kind: 'pre_emergent', method: 'granular_broadcast', targets: ['crabgrass'] };
const CELSIUS = { name: 'Celsius WG Herbicide', activeIngredient: 'Thiencarbazone-methyl', kind: 'herbicide', method: 'granular_broadcast', targets: ['dollarweed'] };
const BIFEN = { name: 'Bifen XTS', activeIngredient: 'Bifenthrin 25.1%', kind: 'insecticide', method: 'broadcast_spray', targets: ['chinch bugs'] };
const NAMES = /prodiamine|thiencarbazone|bifenthrin|celsius|stonewall|lesco|bifen/i;

describe('the gate reader', () => {
  test('strict opt-in: only the exact string true', () => {
    gateOff();
    expect(featureGates.lawnReportCopyFixesLive()).toBe(false);
    for (const v of ['1', 'on', 'TRUE', 'True', 'yes', '']) {
      process.env[GATE] = v;
      expect(featureGates.lawnReportCopyFixesLive()).toBe(false);
    }
    gateOn();
    expect(featureGates.lawnReportCopyFixesLive()).toBe(true);
  });
});

describe('fix 1: no chemical or catalog name in a sentence', () => {
  const treatment = { products: [STONEWALL, CELSIUS, BIFEN] };

  test('default form is unchanged (names the active ingredients)', () => {
    const text = buildTreatmentSummary(treatment);
    expect(text).toMatch(/prodiamine/i);
    expect(text).toMatch(/bifenthrin/i);
  });

  test('category form names categories only, from the Visit Summary phrase table', () => {
    const text = buildCategoryTreatmentSummary(treatment);
    expect(text).not.toMatch(NAMES);
    expect(text).toContain(APPLIED_PHRASES.combo_pre_emergent);
    expect(text).toContain(APPLIED_PHRASES.herbicide);
    expect(text).toContain(APPLIED_PHRASES.insecticide);
    expect(text).toMatch(/^Today we applied /);
    expect(customerCopyViolations(text)).toEqual([]);
  });

  test('one product, one method says the method once; no names', () => {
    const text = buildCategoryTreatmentSummary({ products: [BIFEN] }, { noTiming: true });
    expect(text).toBe('Today we applied insect control (broadcast application), targeting chinch bugs.');
  });

  test('a wetting agent is still a support product, never a category', () => {
    const text = buildCategoryTreatmentSummary({ products: [BIFEN, { name: 'Nonionic Surfactant', kind: 'other', activeIngredient: 'alkylphenol ethoxylate' }] });
    expect(text).toMatch(/with a surfactant added/);
    expect(text).not.toMatch(/alkylphenol|nonionic/i);
  });

  test('buildLawnReportV2 snapshot.treatmentSummary follows the gate', () => {
    const assessment = baseAssessment();
    const applications = [{ product: { name: STONEWALL.name, active_ingredient: 'Prodiamine 0.43%', category: 'pre-emergent' }, targets: ['crabgrass'] }];
    gateOff();
    expect(buildLawnReportV2({ lawnAssessment: assessment, applications }).snapshot.treatmentSummary).toMatch(/prodiamine/i);
    gateOn();
    const on = buildLawnReportV2({ lawnAssessment: assessment, applications }).snapshot.treatmentSummary;
    expect(on).not.toMatch(NAMES);
    expect(on).toMatch(/pre-emergent weed barrier/);
  });

  test('the v6 "what we applied" field freezes the category form only while the gate is live', () => {
    const reportV2 = { snapshot: { statusHeadline: 'Looking healthy' }, treatment, insights: [] };
    gateOff();
    expect(buildLawnCopyV6(reportV2).fields.whatWeDid).toMatch(/prodiamine/i);
    gateOn();
    const { fields } = buildLawnCopyV6(reportV2);
    expect(fields.whatWeDid).not.toMatch(NAMES);
    expect(fields.whatWeDid).toMatch(/weed control/);
  });

  test('a v6 entry frozen BEFORE the gate replays word for word with the gate live', async () => {
    const frozenText = 'Today we applied prodiamine and bifenthrin.';
    const notes = { lawnCopyV6: { 'la-1': { v: 1, assessmentId: 'la-1', fields: { headline: 'H', whatWeDid: frozenText, whatToExpect: null, watching: null } } } };
    gateOn();
    const out = await resolveLawnCopyV6ForRender({ structuredNotes: notes, serviceRecordId: 's1', assessmentId: 'la-1', reportV2: { treatment: { products: [BIFEN] } }, knex: {} });
    expect(out.copy.whatWeDid).toBe(frozenText);
  });

  test('the lawn narrative hook: gate on = the fixed category sentence, no database, no model; gate off = the narrative builder as before', async () => {
    const { dispatchWithFallback } = require('../services/llm/call');
    const args = { serviceRecordId: 'svc-1', serviceLine: 'lawn', treatment: { products: [BIFEN] }, knex: () => { throw new Error('must not touch the database'); } };
    gateOn();
    const spy = jest.spyOn(treatmentNarrative, 'buildTreatmentNarrative');
    const out = await lawnTreatmentNarrative(args);
    expect(out.signature).toBeNull();
    expect(out.text).toBe('Today we applied insect control (broadcast application), targeting chinch bugs.');
    expect(spy).not.toHaveBeenCalled();
    expect(dispatchWithFallback).not.toHaveBeenCalled();
    gateOff();
    spy.mockResolvedValue({ text: 'AI text', signature: '-tnok1' });
    expect(await lawnTreatmentNarrative(args)).toEqual({ text: 'AI text', signature: '-tnok1' });
    expect(spy).toHaveBeenCalledWith(args);
    spy.mockRestore();
  });

  test('the narrative PDF key part is the sentinel for lawn under the gate, and unchanged otherwise', async () => {
    const row = { status: 'ok', generated_at: '2026-10-01T00:00:00Z' };
    const knex = () => ({ where() { return this; }, whereIn() { return this; }, orderBy() { return this; }, first: async () => row });
    gateOff();
    const stamp = new Date(row.generated_at).getTime();
    expect(await treatmentNarrativePdfSignature('svc-1', knex, { serviceLine: 'lawn' })).toBe(`-tnok${stamp}`);
    gateOn();
    expect(await treatmentNarrativePdfSignature('svc-1', knex, { serviceLine: 'lawn' })).toBe('-tn0');
    // tree & shrub never changes
    expect(await treatmentNarrativePdfSignature('svc-1', knex, { serviceLine: 'tree_shrub' })).toBe(`-tnok${stamp}`);
  });

  describe('the technician paragraph', () => {
    const rawProducts = [
      { name: 'LESCO High Manganese Combo AM 1% Mg 5.75% S 3% Fe 4% Mn Chelated Micronutrient Liquid Fertilizer', kind: 'supplement', activeIngredient: 'Iron' },
      STONEWALL,
    ];

    test('gate off: the normalized inputs have no new key and the sentence names the products', () => {
      const inputs = tech.normalizeInputs({ technicianNote: 'n', products: rawProducts, findings: [] });
      expect(Object.keys(inputs).sort()).toEqual(['findings', 'products', 'technicianNote']);
      const slots = tech.buildSlots(inputs, []);
      expect(Object.keys(slots).sort()).toEqual(['maybe', 'observed', 'products']);
      expect(tech.render(slots)).toMatch(/LESCO/);
    });

    test('category form: slots carry phrase ids, no name anywhere, the sentence uses the same table', () => {
      const inputs = tech.normalizeInputs({ technicianNote: '', products: rawProducts, findings: [], categoryOnly: true });
      expect(JSON.stringify(inputs)).not.toMatch(NAMES);
      const slots = tech.buildSlots(inputs, []);
      expect(slots.products).toEqual([]);
      expect(slots.categories).toEqual(['combo_pre_emergent', 'supplement']);
      const text = tech.render(slots);
      expect(text).toBe(`Today we applied ${APPLIED_PHRASES.combo_pre_emergent} and ${APPLIED_PHRASES.supplement}.`);
      expect(customerCopyViolations(text)).toEqual([]);
      // idempotent
      expect(tech.normalizeInputs(inputs)).toEqual(inputs);
    });

    test('a frozen category entry passes the read-time check; a frozen names entry from before still does', () => {
      const catInputs = tech.normalizeInputs({ technicianNote: '', products: rawProducts, findings: [], categoryOnly: true });
      const catSlots = tech.buildSlots(catInputs, []);
      expect(tech._test.frozenEntryProblem({ text: tech.render(catSlots), slots: catSlots })).toBeNull();
      const oldSlots = { observed: [], maybe: [], products: ['LESCO Stonewall'] };
      const oldText = tech.render(oldSlots);
      expect(oldText).toBe('Today we applied LESCO Stonewall.');
      expect(tech._test.frozenEntryProblem({ text: oldText, slots: oldSlots })).toBeNull();
    });

    test('a hand-edited category entry prints nothing (drift)', () => {
      const slots = { observed: [], maybe: [], products: [], categories: ['herbicide'] };
      expect(tech._test.frozenEntryProblem({ text: 'Today we applied LESCO Stonewall.', slots })).toBe('drift');
    });

    test('an unknown category id renders nothing', () => {
      expect(tech.render({ observed: [], maybe: [], products: [], categories: ['not_a_category'] })).toBe('');
    });

    test('gatherTechParagraphInputs hands the category form to the freeze only while the gate is live', async () => {
      const knex = () => ({ where() { return this; }, first: async () => null });
      const data = { reportV2: { treatment: { products: rawProducts } }, lawnAssessment: { assessmentId: 'la-1' } };
      const record = { technician_notes: '' };
      gateOff();
      const off = await gatherTechParagraphInputs({ record, data, knex });
      expect(off.categoryOnly).toBeUndefined();
      expect(off.products.map((p) => p.name)).toHaveLength(2);
      gateOn();
      const on = await gatherTechParagraphInputs({ record, data, knex });
      expect(on.categoryOnly).toBe(true);
      expect(on.products).toEqual([]);
      expect(JSON.stringify(on)).not.toMatch(/lesco/i);
    });
  });

  test('appliedCategoryPhrases is the Visit Summary table (one table, no second copy)', () => {
    expect(appliedCategoryPhrases([BIFEN, CELSIUS])).toEqual([APPLIED_PHRASES.herbicide, APPLIED_PHRASES.insecticide]);
  });
});

// ── fixtures for the report builder ─────────────────────────────────────────
function baseAssessment(overrides = {}) {
  return {
    assessmentDate: '2026-10-08',
    scores: { turfDensity: 73, weedSuppression: 88, colorHealth: 77, stressDamage: 80, fungusControl: 95, overallScore: 80, season: 'shoulder' },
    overwateringSignal: false,
    droughtStress: 'none',
    turfProfile: { grassType: 'st_augustine' },
    observations: '',
    waterContext: {
      rainfallInches7d: 0.9, irrigationInchesPerWeek: 0.7, effectiveInches7d: 1.6, targetInchesPerWeek: 0.75,
      irrigationAdvice: { status: 'balanced', rainKnown: true, profileMissing: false, recommendedInchesPerWeek: 0.75, targetBasis: 'evapotranspiration' },
    },
    trend: [
      { date: '2026-07-10', overallScore: 56, turfDensity: 60, weedSuppression: 70, colorHealth: 60, stressDamage: 40, season: 'peak' },
      { date: '2026-08-12', overallScore: 59, turfDensity: 62, weedSuppression: 72, colorHealth: 62, stressDamage: 42, season: 'peak' },
      { date: '2026-10-08', overallScore: 80, turfDensity: 73, weedSuppression: 88, colorHealth: 77, stressDamage: 80, season: 'shoulder' },
    ],
    beforeAfter: {
      before: { date: '2026-07-10', photoUrl: 'https://example.test/b.jpg', overallScore: 56 },
      after: { date: '2026-10-08', photoUrl: 'https://example.test/a.jpg', overallScore: 80 },
      improvement: 24,
    },
    ...overrides,
  };
}

describe('fix 2: the seasonal color line rule', () => {
  test('seasonalColorLineAllowed: cool month and not rising, nothing known = nothing', () => {
    // October is the shoulder season in the module the report already uses
    expect(seasonalColorLineAllowed({ month: 10, currentScore: 60, priorScore: 62 })).toBe(true);
    expect(seasonalColorLineAllowed({ month: 10, currentScore: 62, priorScore: 62 })).toBe(true);
    expect(seasonalColorLineAllowed({ month: 10, currentScore: 63, priorScore: 62 })).toBe(false);
    expect(seasonalColorLineAllowed({ month: 7, currentScore: 50, priorScore: 62 })).toBe(false); // peak
    expect(seasonalColorLineAllowed({ month: 12, currentScore: 50, priorScore: 62 })).toBe(true); // dormant
    expect(seasonalColorLineAllowed({ month: 10, currentScore: 60, priorScore: null })).toBe(false);
    expect(seasonalColorLineAllowed({ month: 10, currentScore: null, priorScore: 60 })).toBe(false);
    expect(seasonalColorLineAllowed({ month: null, currentScore: 60, priorScore: 62 })).toBe(false);
    // against a base visit too
    expect(seasonalColorLineAllowed({ month: 10, currentScore: 60, priorScore: 62, baseScore: 58 })).toBe(false);
    expect(seasonalColorLineAllowed({ month: 10, currentScore: 60, priorScore: 62, baseScore: 70 })).toBe(true);
    expect(seasonalColorLineAllowed({ month: 10, currentScore: 60, priorScore: 62, baseScore: null })).toBe(false);
  });

  // The failing report: October, score up 24 against the first visit (and up against the prior one).
  test('gate off: October, score up 24 -> the line prints (the defect)', () => {
    gateOff();
    const v2 = buildLawnReportV2({ lawnAssessment: baseAssessment() });
    expect(v2.progressionNote).toMatch(/colors off in the cooler months/);
    expect(v2.trends.seasonalNote).toMatch(/cooler months/);
    expect(v2.snapshot.seasonalNote).toMatch(/transitional stretch/);
  });

  test('gate on: October, score up -> nothing prints in its place', () => {
    gateOn();
    const v2 = buildLawnReportV2({ lawnAssessment: baseAssessment() });
    expect(v2.progressionNote).toBeNull();
    expect(v2.trends.seasonalNote).toBeUndefined();
    expect(v2.snapshot.seasonalNote).toBeNull();
  });

  test('gate on: October, score down against the prior visit and the base -> the lines print as before', () => {
    gateOn();
    const lawnAssessment = baseAssessment({
      scores: { turfDensity: 60, weedSuppression: 70, colorHealth: 55, stressDamage: 60, fungusControl: 90, overallScore: 52, season: 'shoulder' },
      trend: [
        { date: '2026-07-10', overallScore: 58, season: 'peak' },
        { date: '2026-08-12', overallScore: 60, season: 'peak' },
        { date: '2026-10-08', overallScore: 52, season: 'shoulder' },
      ],
      beforeAfter: {
        before: { date: '2026-07-10', photoUrl: 'https://example.test/b.jpg', overallScore: 58 },
        after: { date: '2026-10-08', photoUrl: 'https://example.test/a.jpg', overallScore: 52 },
      },
    });
    const v2 = buildLawnReportV2({ lawnAssessment });
    expect(v2.progressionNote).toMatch(/colors off in the cooler months/);
    expect(v2.trends.seasonalNote).toMatch(/cooler months/);
    expect(v2.snapshot.seasonalNote).toMatch(/transitional stretch/);
  });

  test('gate on: a peak-season visit never prints the cool-season lines, whatever the score does', () => {
    gateOn();
    const lawnAssessment = baseAssessment({
      assessmentDate: '2026-08-12',
      scores: { overallScore: 50, season: 'peak' },
      trend: [
        { date: '2026-04-10', overallScore: 60, season: 'shoulder' },
        { date: '2026-06-10', overallScore: 58, season: 'peak' },
        { date: '2026-08-12', overallScore: 50, season: 'peak' },
      ],
      beforeAfter: {
        before: { date: '2026-04-10', photoUrl: 'https://example.test/b.jpg', overallScore: 60 },
        after: { date: '2026-08-12', photoUrl: 'https://example.test/a.jpg', overallScore: 50 },
      },
    });
    const v2 = buildLawnReportV2({ lawnAssessment });
    expect(v2.progressionNote).toBeNull();
    expect(v2.trends.seasonalNote).toBeUndefined();
    // the peak-season hero note is not a cool-season line and is unchanged
    expect(v2.snapshot.seasonalNote).toMatch(/peak heat-and-pest season/);
  });

  test('gate on: no prior score known = no line (fail closed)', () => {
    gateOn();
    const lawnAssessment = baseAssessment({ trend: [{ date: '2026-10-08', overallScore: 52, season: 'shoulder' }], beforeAfter: null });
    expect(buildLawnReportV2({ lawnAssessment }).snapshot.seasonalNote).toBeNull();
  });
});

describe('fix 3: Weed Cleanliness', () => {
  const cardOf = (v2) => v2.diagnosis.find((c) => c.key === 'weed_pressure');

  test('gate off keeps Weed Pressure; gate on is Weed Cleanliness with the same status words and explanation at every level', () => {
    for (const weedSuppression of [95, 75, 60, 30, null]) {
      const a = baseAssessment({ scores: { turfDensity: 80, weedSuppression, colorHealth: 80, stressDamage: 80, fungusControl: 90, overallScore: 80, season: 'peak' } });
      gateOff();
      const off = cardOf(buildLawnReportV2({ lawnAssessment: a }));
      gateOn();
      const on = cardOf(buildLawnReportV2({ lawnAssessment: a }));
      expect(off.label).toBe('Weed Pressure');
      expect(on.label).toBe('Weed Cleanliness');
      const { label: _l1, ...restOff } = off;
      const { label: _l2, ...restOn } = on;
      expect(restOn).toEqual(restOff);
    }
  });
});

describe('fix 5: stale Water Gap and Mowing Height charts', () => {
  const gapJulAug = [
    { serviceDate: '2026-07-10', waterGapInches: -0.3 },
    { serviceDate: '2026-08-12', waterGapInches: 0.2 },
  ];
  const mowJulAug = { band: { min: 3.5, max: 4.0 }, trend: [{ heightIn: 3.75, measuredAt: '2026-08-12T14:00:00Z' }, { heightIn: 3.25, measuredAt: '2026-07-10T14:00:00Z' }] };

  test('gate off: the July and August points still chart on an October report (the defect)', () => {
    gateOff();
    const { trends } = buildLawnReportV2({ lawnAssessment: baseAssessment(), waterGapHistory: gapJulAug, mowingTrendFallback: mowJulAug });
    expect(trends.waterGap).toHaveLength(2);
    expect(trends.mowing).toHaveLength(2);
  });

  test('gate on: newest point 57 days before the visit -> neither chart, the band key goes too, other charts stay', () => {
    gateOn();
    const { trends } = buildLawnReportV2({ lawnAssessment: baseAssessment(), waterGapHistory: gapJulAug, mowingTrendFallback: mowJulAug });
    expect(trends.waterGap).toBeUndefined();
    expect(trends.mowing).toBeUndefined();
    expect(trends.mowingBand).toBeUndefined();
    expect(trends.overall).toBeDefined();
  });

  test('gate on: a newest point exactly 45 days before the visit still charts; 46 does not', () => {
    gateOn();
    const keep = buildLawnReportV2({ lawnAssessment: baseAssessment(), waterGapHistory: [{ serviceDate: '2026-08-01', waterGapInches: 0.1 }, { serviceDate: '2026-08-24', waterGapInches: 0.2 }] });
    expect(keep.trends.waterGap).toHaveLength(2); // 2026-08-24 -> 2026-10-08 = 45 days
    const drop = buildLawnReportV2({ lawnAssessment: baseAssessment(), waterGapHistory: [{ serviceDate: '2026-08-01', waterGapInches: 0.1 }, { serviceDate: '2026-08-23', waterGapInches: 0.2 }] });
    expect(drop.trends.waterGap).toBeUndefined(); // 46 days
  });

  test('gate on: a chart with a current point is never stale', () => {
    gateOn();
    const { trends } = buildLawnReportV2({
      lawnAssessment: baseAssessment(),
      waterGapHistory: [...gapJulAug, { serviceDate: '2026-10-08', waterGapInches: 0.05 }],
      mowingHeight: { heightIn: 3.5, status: 'in_range', band: { min: 3.5, max: 4.0 }, trend: [{ heightIn: 3.25, measuredAt: '2026-07-10T14:00:00Z' }, { heightIn: 3.5, measuredAt: '2026-10-08T14:00:00Z' }] },
    });
    expect(trends.waterGap).toHaveLength(3);
    expect(trends.mowing).toHaveLength(2);
  });

  test('gate on: stale charts were the only charts -> no trends block at all (no baseline card)', () => {
    gateOn();
    const lawnAssessment = baseAssessment({ trend: [{ date: '2026-10-08', overallScore: 80, season: 'shoulder' }], beforeAfter: null });
    const v2 = buildLawnReportV2({ lawnAssessment, waterGapHistory: gapJulAug });
    expect(v2.trends).toBeNull();
    gateOff();
    expect(buildLawnReportV2({ lawnAssessment, waterGapHistory: gapJulAug }).trends.waterGap).toHaveLength(2);
  });

  test('gate on with no visit date: leave the charts alone', () => {
    gateOn();
    const { trends } = buildLawnReportV2({ lawnAssessment: baseAssessment({ assessmentDate: undefined }), waterGapHistory: gapJulAug });
    expect(trends.waterGap).toHaveLength(2);
  });
});

describe('fix 6: the water target source line', () => {
  const build = (basis, { grass = 'st_augustine', waterSnapshot = null, rain = 0.5, target = 0.75 } = {}) => buildLawnReportV2({
    lawnAssessment: baseAssessment({
      turfProfile: { grassType: grass },
      waterContext: {
        rainfallInches7d: rain, irrigationInchesPerWeek: 0.5, effectiveInches7d: 1, targetInchesPerWeek: target,
        irrigationAdvice: { status: 'balanced', rainKnown: true, profileMissing: false, recommendedInchesPerWeek: target, targetBasis: basis },
      },
    }),
    waterSnapshot,
  });

  test('gate off: no targetNote key at all', () => {
    gateOff();
    expect('targetNote' in build('evapotranspiration').water).toBe(false);
  });

  test('gate on: the four fixed sentences, each a true statement of the inputs used', () => {
    gateOn();
    const notes = {
      weatherGrass: build('evapotranspiration').water.targetNote,
      weather: build('evapotranspiration', { grass: null }).water.targetNote,
      seasonGrass: build('seasonal').water.targetNote,
      season: build('seasonal', { grass: 'mystery grass' }).water.targetNote,
    };
    expect(notes).toEqual({
      weatherGrass: 'Based on the weather in your area for the week ending on this visit, your grass type and the time of year.',
      weather: 'Based on the weather in your area for the week ending on this visit and the time of year.',
      seasonGrass: 'Based on the usual weekly water need for your grass type at this time of year.',
      season: 'Based on the usual weekly water need for a lawn at this time of year.',
    });
    expect(Object.values(WATER_TARGET_NOTES).sort()).toEqual(Object.values(notes).sort());
    for (const note of Object.values(notes)) {
      expect(customerCopyViolations(note)).toEqual([]);
      expect(note).not.toMatch(/forecast|safe|minute|before this visit/i);
    }
  });

  test('the target number is untouched by the gate', () => {
    gateOff();
    const off = build('evapotranspiration').water.targetInches;
    gateOn();
    expect(build('evapotranspiration').water.targetInches).toBe(off);
  });

  test('a target read from the area snapshot gets no line (its basis is not recorded)', () => {
    gateOn();
    const snap = { status: 'balanced', interpretation: 'balanced', rain_7day_inches: 0.5, irrigation_inches_per_week: 0.5, total_water_7day_inches: 1, target_water_inches_per_week: 0.8 };
    const water = build('evapotranspiration', { rain: null, waterSnapshot: snap }).water;
    expect(water.source).toBe('area_snapshot');
    expect('targetNote' in water).toBe(false);
  });

  test('no target, no line', () => {
    gateOn();
    expect('targetNote' in build('seasonal', { target: null }).water).toBe(false);
  });

  test('an unknown target basis gets no line', () => {
    gateOn();
    expect('targetNote' in build(undefined).water).toBe(false);
  });

  test('the advice engine names its basis and isKnownGrass matches the tables', () => {
    expect(buildIrrigationAdvice({ grassType: 'st_augustine', month: 10, referenceEt0InchesWeek: 1.2 }).targetBasis).toBe('evapotranspiration');
    expect(buildIrrigationAdvice({ grassType: 'st_augustine', month: 10 }).targetBasis).toBe('seasonal');
    expect(isKnownGrass('St. Augustine')).toBe(true);
    expect(isKnownGrass('bermuda')).toBe(true);
    expect(isKnownGrass(null)).toBe(false);
    expect(isKnownGrass('mystery grass')).toBe(false);
  });
});

// ── the real report builder: payload flag and PDF key ───────────────────────
function makeKnex(fixtures) {
  const knex = (table) => {
    let rows = [...(fixtures[table] || [])];
    const sortKeys = [];
    const q = {};
    const applySort = () => {
      rows = [...rows].sort((a, b) => {
        for (const { col, dir } of sortKeys) {
          const cmp = String(a[col] ?? '').localeCompare(String(b[col] ?? ''));
          if (cmp !== 0) return dir === 'desc' ? -cmp : cmp;
        }
        return 0;
      });
    };
    Object.assign(q, {
      select: () => q,
      leftJoin: () => q,
      modify(fn) { fn(q); return q; },
      limit(n) { rows = rows.slice(0, n); return q; },
      where(a, b, c) {
        if (typeof a === 'function') return q;
        if (a && typeof a === 'object') {
          rows = rows.filter((r) => Object.entries(a).every(([k, v]) => r[k] === v));
        } else if (arguments.length === 2) {
          rows = rows.filter((r) => r[a] === b);
        } else if (arguments.length === 3) {
          rows = rows.filter((r) => {
            const left = String(r[a] ?? '');
            const right = String(c);
            if (b === '>') return left > right;
            if (b === '>=') return left >= right;
            if (b === '<') return left < right;
            if (b === '<=') return left <= right;
            return true;
          });
        }
        return q;
      },
      andWhere(a, b, c) {
        if (typeof a === 'function') {
          const likes = [];
          const sub = {
            whereRaw(_sql, params) { likes.push(String(params[0]).replace(/%/g, '').toLowerCase()); return sub; },
            orWhereRaw(_sql, params) { likes.push(String(params[0]).replace(/%/g, '').toLowerCase()); return sub; },
          };
          a(sub);
          if (likes.length) rows = rows.filter((r) => likes.some((needle) => String(r.service_type || '').toLowerCase().includes(needle)));
          return q;
        }
        return q.where(a, b, c);
      },
      whereIn(col, vals) { rows = rows.filter((r) => vals.includes(r[col])); return q; },
      whereNot(a, b) {
        if (a && typeof a === 'object') rows = rows.filter((r) => !Object.entries(a).every(([k, v]) => r[k] === v));
        else rows = rows.filter((r) => r[a] !== b);
        return q;
      },
      whereNotNull(col) { rows = rows.filter((r) => r[col] != null); return q; },
      whereNull(col) { rows = rows.filter((r) => r[col] == null); return q; },
      orderBy(col, dir = 'asc') { sortKeys.push({ col, dir }); applySort(); return q; },
      first() { return Promise.resolve(rows[0] || null); },
      columnInfo: () => Promise.resolve({}),
      catch: () => Promise.resolve(rows),
      then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject),
    });
    return q;
  };
  knex.raw = (sql) => sql;
  return knex;
}

const CUSTOMER = 'cust-lawn-copyfix';
const CUR = {
  id: 'la-cur', customer_id: CUSTOMER, service_record_id: 'svc-cur', confirmed_by_tech: true,
  service_date: '2026-10-08', visit_date: '2026-10-08', created_at: '2026-10-08T14:00:00Z', history_record_id: 'svc-cur',
  turf_density: 78, weed_suppression: 82, color_health: 75, stress_damage: 30,
};
const fixtures = () => ({
  service_products: [], property_geometries: [], property_zones: [], service_findings: [], service_photos: [],
  lawn_assessment_photos: [], lawn_water_intake_snapshots: [],
  scheduled_services: [{ id: 'ss-cur', customer_id: CUSTOMER, scheduled_date: '2026-10-08', status: 'completed', service_type: 'Lawn Care Treatment Program' }],
  property_preferences: [], service_records: [], lawn_assessments: [CUR],
});
const lawnService = () => ({
  id: 'svc-cur', scheduled_service_id: 'ss-cur', customer_id: CUSTOMER, service_line: 'lawn',
  service_type: 'Lawn Care Treatment Program', service_date: '2026-10-08', completed_at: '2026-10-08T18:40:00Z',
  first_name: 'Test', last_name: 'Customer', areas_serviced: JSON.stringify(['Front Lawn']),
  structured_notes: JSON.stringify({}), service_data: JSON.stringify({}),
});

describe('payload flag and PDF key (real report builder, in-memory reader)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    history.installedForVisit.mockResolvedValue(CUR);
    history.historyForReport.mockResolvedValue({ current: CUR, rows: [CUR], identity: 'h', eligibleVisitIds: [], isBaseline: true });
    history.historyForAssessment.mockResolvedValue({ current: CUR, rows: [CUR], identity: 'h', eligibleVisitIds: [], isBaseline: true });
    require('../services/llm/call').dispatchWithFallback.mockResolvedValue({ ok: false, reason: 'no_key' });
  });

  test('gate off: no lawnCopyFixes key, no targetNote; gate on: the lawn payload gains the flag', async () => {
    gateOff();
    const off = await buildReportV1Data(lawnService(), 'tok-copyfix', makeKnex(fixtures()), {});
    expect('lawnCopyFixes' in off).toBe(false);
    expect(off.reportV2.water && 'targetNote' in off.reportV2.water).toBeFalsy();
    gateOn();
    const on = await buildReportV1Data(lawnService(), 'tok-copyfix', makeKnex(fixtures()), {});
    expect(on.lawnCopyFixes).toBe(true);
  });

  test('gate on, a pest report: no flag', async () => {
    gateOn();
    const pest = { ...lawnService(), service_line: 'pest', service_type: 'Quarterly Pest Control' };
    const data = await buildReportV1Data(pest, 'tok-copyfix', makeKnex(fixtures()), {});
    expect('lawnCopyFixes' in data).toBe(false);
  });

  test('the lawn PDF cache signature moves only while the gate is live; a pest signature never moves', async () => {
    const sig = async (line) => (await resolveCanonicalLawnRender(
      { id: 'svc-cur', customer_id: CUSTOMER, service_line: line, service_date: '2026-10-08' },
      makeKnex(fixtures()),
    )).signature;
    gateOff();
    const off = await sig('lawn');
    expect(await sig('lawn')).toBe(off);
    gateOn();
    expect(await sig('lawn')).not.toBe(off);
    expect(await sig('pest')).toBe('');
    expect(await sig('tree_shrub')).toBe('');
    gateOff();
    expect(await sig('lawn')).toBe(off);
  });
});
