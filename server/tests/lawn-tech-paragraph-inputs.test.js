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
function fakeKnex({ assessments = {}, runs = {}, catalog = [{ name: 'Arena 50 WDG' }, { name: 'Celsius WG' }], fail = null } = {}) {
  const knex = (table) => {
    const q = { criteria: {} };
    q.where = (c) => { q.criteria = c; return q; };
    q.first = async () => {
      if (fail === table) throw new Error(`${table} read failed`);
      if (table === 'lawn_assessments') return assessments[q.criteria.id] || null;
      if (table === 'lawn_assessment_runs') return runs[q.criteria.assessment_id] || null;
      return null;
    };
    q.select = async () => { if (fail === table) throw new Error(`${table} read failed`); return catalog; };
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

  test('builds the inputs from the finished report: note verbatim, applied products only, findings, headline, watering', async () => {
    const inputs = await gatherTechParagraphInputs({
      record: RECORD, data: REPORT(), instruction: { lines: ['Water in today’s treatment.', 'Run each zone briefly.', 'third'] }, knex: knex(),
    });
    expect(inputs.technicianNote).toBe(RECORD.technician_notes);
    expect(inputs).not.toHaveProperty('firstName');
    expect(inputs.products.map((p) => p.name)).toEqual(['Arena 50 WDG']); // the support product makes no claim
    expect(inputs.products[0]).toMatchObject({ method: 'broadcast spray', targets: ['Southern chinch bugs'] });
    expect(inputs.scores.overall).toBe(94);
    expect(inputs.findings.map((f) => f.label)).toEqual(['thinning turf', 'color stress', 'general lawn stress']);
    expect(inputs.facts).toEqual({ headline: 'Looking great', watering: 'Water in today’s treatment. Run each zone briefly.' });
    expect(inputs.knownProductNames).toEqual(['Arena 50 WDG', 'Celsius WG']);
    expect(JSON.stringify(inputs)).not.toMatch(/RAW FREE TEXT|Example Street|Example\b/);
  });

  test('the last visit: date, products, watched topics (not the banner-owned ones) and its kept findings', async () => {
    const sinceLast = {
      priorDate: '2026-08-16', priorAssessmentId: 70,
      applied: [{ name: 'Prior Fertilizer', kind: 'fertilizer', targets: [] }],
      checks: [{ key: 'weeds', status: 'watch' }, { key: 'water', status: 'watch' }, { key: 'coverage', status: 'watch' }],
    };
    const k = fakeKnex({
      assessments: { 77: ASSESSMENT(), 70: ASSESSMENT({ id: 70 }) },
      runs: { 77: RUN(), 70: RUN({ assessment_id: 70, added_details: [], reviewed_findings: [{ label: 'weed pressure', confidence: 'moderate' }] }) },
    });
    const inputs = await gatherTechParagraphInputs({ record: RECORD, data: REPORT({ sinceLast }), knex: k });
    expect(inputs.prior).toEqual({
      date: '2026-08-16',
      products: [expect.objectContaining({ name: 'Prior Fertilizer' })],
      watched: ['weeds'],
      findings: [{ label: 'weed pressure', confidence: 'moderate' }],
    });
  });

  test('progress lines are the fixed density / weed / stress sentences only: never color, never the overall line', async () => {
    const sinceLast = { priorDate: '2026-08-16', priorAssessmentId: 70, applied: [{ name: 'Prior Fertilizer', kind: 'fertilizer', targets: [] }], checks: [] };
    const sinceCopy = require('../services/service-report/lawn-since-last-copy');
    const k = fakeKnex({ assessments: { 77: ASSESSMENT(), 70: ASSESSMENT({ id: 70 }) }, runs: {} });
    // The module destructures at load: re-require it over a stubbed builder.
    jest.resetModules();
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    jest.doMock('../services/service-report/lawn-since-last-copy', () => ({ ...sinceCopy, buildSinceLastCopy: () => ({ priorDate: '2026-08-16', lines: ['Last visit we applied fertilizer.', 'Your overall lawn score is up since then.', 'Color is ahead of schedule.', 'Thickness is on track.', 'Weed pressure is holding steady.'] }) }));
    const fresh = require('../services/service-report/lawn-tech-paragraph-inputs');
    const data = REPORT({ sinceLast });
    data.reportV2.progress = { eligible: true };
    const inputs = await fresh.gatherTechParagraphInputs({ record: RECORD, data, knex: k });
    expect(inputs.progressLines).toEqual(['Thickness is on track.', 'Weed pressure is holding steady.']);
    jest.dontMock('../services/service-report/lawn-since-last-copy');
  });

  test('a degraded build, no assessment, or no report writes no inputs', async () => {
    const degraded = REPORT();
    degraded.lawnAssessment.lawnCopyV6Unfrozen = true;
    expect(await gatherTechParagraphInputs({ record: RECORD, data: degraded, knex: knex() })).toBeNull();
    expect(await gatherTechParagraphInputs({ record: RECORD, data: { reportV2: REPORT().reportV2 }, knex: knex() })).toBeNull();
    expect(await gatherTechParagraphInputs({ record: RECORD, data: null, knex: knex() })).toBeNull();
  });

  test('fail closed: a failed findings or catalog read propagates (the step stores no paragraph)', async () => {
    await expect(gatherTechParagraphInputs({ record: RECORD, data: REPORT(), knex: fakeKnex({ assessments: { 77: ASSESSMENT() }, runs: { 77: RUN() }, fail: 'lawn_assessment_runs' }) })).rejects.toThrow('read failed');
    await expect(gatherTechParagraphInputs({ record: RECORD, data: REPORT(), knex: fakeKnex({ assessments: { 77: ASSESSMENT() }, runs: { 77: RUN() }, fail: 'products_catalog' }) })).rejects.toThrow('read failed');
  });
});
