// What the completion step feeds the tech paragraph. Synthetic data only.

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { gatherTechParagraphInputs, keptFindings } = require('../services/service-report/lawn-tech-paragraph-inputs');

const RUN = (over = {}) => ({
  assessment_id: 77, customer_id: 9, reviewed_at: '2026-10-05T10:00:00Z',
  reviewed_findings: [
    { label: 'thinning turf', confidence: 'low', keep: true },
    { label: 'chinch bug activity', confidence: 'high', keep: true }, // a cause label: not on the allowlist
    { label: 'weed pressure', confidence: 'moderate', keep: false }, // rejected by the technician
    { label: 'color stress', confidence: 'moderate' },
  ],
  added_details: [{ label: 'general lawn stress', confidence: 'moderate', negated: false }, { label: 'weed pressure', negated: true }],
  ...over,
});
const ASSESSMENT = (over = {}) => ({ id: 77, customer_id: 9, confirmed_by_tech: true, ...over });

// A table-keyed fake: knex('t').where(...).first(...) / .select(...)
function fakeKnex({ assessments = {}, runs = {}, fail = null } = {}) {
  const knex = (table) => {
    const q = { criteria: {} };
    q.where = (c) => { q.criteria = c; return q; };
    q.first = async () => {
      if (fail === table) throw new Error(`${table} read failed`);
      if (table === 'lawn_assessments') return assessments[q.criteria.id] || null;
      if (table === 'lawn_assessment_runs') return runs[q.criteria.assessment_id] || null;
      return null;
    };
    return q;
  };
  return knex;
}

const REPORT = (over = {}) => ({
  lawnAssessment: { assessmentId: 77 },
  reportV2: {
    snapshot: { overallScore: 94, statusHeadline: 'Looking great', observations: 'RAW FREE TEXT' },
    diagnosis: [{ label: 'Color & Vigor', score: 97 }, { label: 'Turf Density', score: 88 }],
    treatment: { products: [
      { name: 'Arena 50 WDG', activeIngredient: 'clothianidin', kind: 'insecticide', method: 'broadcast_spray', targets: ['Southern chinch bugs'] },
      { name: 'Wetting Agent', kind: 'other', activeIngredient: 'surfactant blend' },
    ] },
    ...over,
  },
});
const RECORD = { id: 's1', first_name: 'Sam', last_name: 'Example', technician_notes: 'We applied Arena. There are chinch bugs.', address_line1: '123 Example Street' };

describe('keptFindings', () => {
  test('only technician-kept, allowlisted symptom labels, with the read\'s confidence', () => {
    expect(keptFindings(RUN(), ASSESSMENT())).toEqual([
      { label: 'thinning turf', confidence: 'low' },
      { label: 'color stress', confidence: 'moderate' },
      { label: 'general lawn stress', confidence: 'moderate' },
    ]);
  });

  test('nothing from an unconfirmed assessment, an unreviewed run, or another customer\'s run', () => {
    expect(keptFindings(RUN(), ASSESSMENT({ confirmed_by_tech: false }))).toEqual([]);
    expect(keptFindings(RUN({ reviewed_at: null }), ASSESSMENT())).toEqual([]);
    expect(keptFindings(RUN({ customer_id: 10 }), ASSESSMENT())).toEqual([]);
    expect(keptFindings(RUN({ assessment_id: 78 }), ASSESSMENT())).toEqual([]);
    expect(keptFindings(null, ASSESSMENT())).toEqual([]);
  });
});

describe('gatherTechParagraphInputs', () => {
  const knex = () => fakeKnex({ assessments: { 77: ASSESSMENT() }, runs: { 77: RUN() } });

  test('builds the fixed-sentence inputs: note verbatim, applied product names only, low-confidence findings by key', async () => {
    const inputs = await gatherTechParagraphInputs({ record: RECORD, data: REPORT(), knex: knex() });
    expect(inputs).toEqual({
      technicianNote: RECORD.technician_notes,
      products: [{ name: 'Arena 50 WDG' }], // the support product makes no claim; no ingredient, target or method
      findings: [{ key: 'thinning_turf' }], // only the LOW-confidence kept finding; moderate ones print in the report's own block
    });
    expect(JSON.stringify(inputs)).not.toMatch(/RAW FREE TEXT|Example Street|Example\b|Sam|clothianidin|Looking great|94/);
  });

  test('both color labels map to nutrient stress, the generic monitoring label to nothing, unknown confidence counts as low', async () => {
    const run = RUN({
      reviewed_findings: [
        { label: 'color stress', confidence: 'low' },
        { label: 'color and nutrient stress', confidence: 'unknown' },
        { label: 'a lawn condition we are monitoring', confidence: 'low' },
        { label: 'general lawn stress', confidence: 'high' },
      ],
      added_details: [],
    });
    const inputs = await gatherTechParagraphInputs({ record: RECORD, data: REPORT(), knex: fakeKnex({ assessments: { 77: ASSESSMENT() }, runs: { 77: run } }) });
    expect(inputs.findings).toEqual([{ key: 'nutrient_stress' }]);
  });

  test('a degraded build, no assessment, or no report writes no inputs', async () => {
    const degraded = REPORT();
    degraded.lawnAssessment.lawnCopyV6Unfrozen = true;
    expect(await gatherTechParagraphInputs({ record: RECORD, data: degraded, knex: knex() })).toBeNull();
    expect(await gatherTechParagraphInputs({ record: RECORD, data: { reportV2: REPORT().reportV2 }, knex: knex() })).toBeNull();
    expect(await gatherTechParagraphInputs({ record: RECORD, data: null, knex: knex() })).toBeNull();
  });

  test('fail closed: a failed findings read propagates (the step stores no paragraph)', async () => {
    await expect(gatherTechParagraphInputs({ record: RECORD, data: REPORT(), knex: fakeKnex({ assessments: { 77: ASSESSMENT() }, runs: { 77: RUN() }, fail: 'lawn_assessment_runs' }) })).rejects.toThrow('read failed');
  });
});
