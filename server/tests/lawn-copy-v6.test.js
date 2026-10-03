// Lawn report v6 copy (P14, GATE_LAWN_REPORT_COPY_V6): fixed sentences built
// from the visit's facts, no model (owner ruling 2026-10-02). Pure unit tests;
// the freeze's SQL runs in lawn-copy-v6.db.test.js, the report wiring in
// lawn-copy-v6-report-data.test.js. Synthetic data only.

jest.mock('../services/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));

const {
  buildLawnCopyV6, resolveLawnCopyV6ForRender, storedLawnCopyV6For, FIELD_CAPS, _test,
} = require('../services/service-report/lawn-copy-v6');
const { buildTreatmentSummary } = require('../services/service-report/treatment-summary');

const herbicide = { name: 'Test Herbicide B', kind: 'herbicide', activeIngredient: 'Testazone 10%', targets: ['broadleaf weeds'] };
const insecticide = { name: 'Test Insecticide D', kind: 'insecticide', activeIngredient: 'Testathrin 5%', targets: ['chinch bugs'] };

const reportV2 = (over = {}) => ({
  snapshot: { status: 'watch', statusHeadline: 'Stable — watching weed pressure', treatmentSummary: 'An AI narrative paragraph about actives and timing.' },
  treatment: { products: [herbicide] },
  insights: [{ category: 'weeds', status: 'watch', priority: 1 }],
  ...over,
});

const row = (id, sentences, approved = true) => ({ id, approved, sentences: sentences.map(([key, text]) => ({ key, text })) });
const expectationsReturning = (rows) => ({ buildExpectations: jest.fn(() => ({ rows })) });

describe('buildLawnCopyV6: every field is a fixed sentence from the facts', () => {
  test('headline is the snapshot status sentence; whatWeDid is the deterministic treatment summary, never the AI narrative', () => {
    const { fields } = buildLawnCopyV6(reportV2(), {}, expectationsReturning([]));
    expect(fields.headline).toBe('Stable — watching weed pressure');
    expect(fields.whatWeDid).toBe(buildTreatmentSummary({ products: [herbicide] }));
    expect(fields.whatWeDid).not.toContain('AI narrative');
  });

  test('whatWeDid names only what was applied: an insect-only visit never says feed or weed control', () => {
    const { fields } = buildLawnCopyV6(reportV2({ treatment: { products: [insecticide] } }), {}, expectationsReturning([]));
    expect(fields.whatWeDid).toBe(buildTreatmentSummary({ products: [insecticide] }));
    expect(fields.whatWeDid).not.toMatch(/feed|fertili|weed/i);
  });

  test('no products: whatWeDid and whatToExpect are null', () => {
    const deps = expectationsReturning([row('r1', [['visibleChange', 'Weeds fade.']])]);
    const { fields } = buildLawnCopyV6(reportV2({ treatment: { products: [] } }), {}, deps);
    expect(fields.whatWeDid).toBeNull();
    expect(fields.whatToExpect).toBeNull();
    expect(deps.buildExpectations).not.toHaveBeenCalled();
  });

  test('watching lists the watched topics after the first (the headline names the top one), in rank order', () => {
    const insights = [
      { category: 'mowing', status: 'watch', priority: 3 },
      { category: 'weeds', status: 'needs_attention', priority: 1 },
      { category: 'coverage', status: 'watch', priority: 2 },
      { category: 'overall', status: 'healthy', priority: 9 },
    ];
    expect(_test.buildWatching(reportV2({ insights }))).toBe('We are also keeping an eye on thin areas and mowing height.');
  });

  test('watching is null with one or no watched issue, and skips categories with no topic', () => {
    expect(_test.buildWatching(reportV2())).toBeNull();
    expect(_test.buildWatching(reportV2({ insights: [] }))).toBeNull();
    const insights = [{ category: 'weeds', status: 'watch', priority: 1 }, { category: 'unknown_kind', status: 'watch', priority: 2 }];
    expect(_test.buildWatching(reportV2({ insights }))).toBeNull();
  });

  test('watching names at most three topics, each once', () => {
    const insights = ['weeds', 'coverage', 'coverage', 'mowing', 'damage', 'customer_concern'].map((category, i) => ({ category, status: 'watch', priority: i + 1 }));
    expect(_test.buildWatching(reportV2({ insights }))).toBe('We are also keeping an eye on thin areas, mowing height and a few stress areas.');
  });
});

describe('whatToExpect: approved rows only, their own sentences word for word', () => {
  test('unapproved rows are never used (today\'s table): whatToExpect is null', () => {
    const deps = expectationsReturning([row('r1', [['visibleChange', 'Weeds fade.']], false)]);
    expect(buildLawnCopyV6(reportV2(), {}, deps).fields.whatToExpect).toBeNull();
  });

  test('each row\'s visible-change then by-next-visit sentence, verbatim, ids recorded; the gap is handed to the engine', () => {
    const deps = expectationsReturning([
      row('r1', [['visibleChange', 'Treated weeds curl and fade.'], ['limit1', 'Some weeds need a second pass.'], ['byNextVisit', 'Most should be gone by your next visit.']]),
      row('r2', [['limit1', 'Results vary by weed.']]),
      row('r3', [['visibleChange', 'Color deepens.']]),
      row('r4', [['visibleChange', 'Never reached.']]),
    ]);
    const out = buildLawnCopyV6(reportV2(), { visitDate: '2026-09-30', nextVisitGapDays: 42 }, deps);
    expect(out.fields.whatToExpect).toBe('Treated weeds curl and fade. Most should be gone by your next visit. Color deepens.');
    expect(out.expectRows).toEqual([{ id: 'r1', keys: ['visibleChange', 'byNextVisit'] }, { id: 'r3', keys: ['visibleChange'] }]);
    expect(deps.buildExpectations).toHaveBeenCalledWith(expect.objectContaining({ visitDate: '2026-09-30', nextVisitGapDays: 42 }));
  });

  test('an unknown gap is not handed on (the engine then materializes no by-next-visit sentence)', () => {
    const deps = expectationsReturning([row('r1', [['visibleChange', 'Treated weeds curl and fade.']])]);
    buildLawnCopyV6(reportV2(), { visitDate: '2026-09-30', nextVisitGapDays: null }, deps);
    expect(deps.buildExpectations.mock.calls[0][0].nextVisitGapDays).toBeUndefined();
  });

  test('a sentence that would pass the 42-word cap is left out whole, never cut', () => {
    const long = Array.from({ length: FIELD_CAPS.whatToExpect }, () => 'word').join(' ');
    const deps = expectationsReturning([row('r1', [['visibleChange', 'Short first.']]), row('r2', [['visibleChange', long]])]);
    expect(buildLawnCopyV6(reportV2(), {}, deps).fields.whatToExpect).toBe('Short first.');
  });

  test('an expectations failure leaves whatToExpect null and the other fields standing', () => {
    const deps = { buildExpectations: () => { throw new Error('boom'); } };
    const { fields } = buildLawnCopyV6(reportV2(), {}, deps);
    expect(fields.whatToExpect).toBeNull();
    expect(fields.headline).toBe('Stable — watching weed pressure');
  });
});

describe('resolveLawnCopyV6ForRender', () => {
  const knexStub = (result) => {
    const chain = { where: () => chain, whereRaw: () => chain, update: jest.fn(async () => result), first: async () => null };
    const knex = () => chain;
    knex.raw = (sql, bindings) => ({ sql, bindings });
    return { knex, chain };
  };

  test('a stored entry replays and builds nothing', async () => {
    const deps = expectationsReturning([]);
    const stored = { v: 1, assessmentId: 'a1', fields: { headline: 'Frozen', whatWeDid: null, whatToExpect: null, watching: null } };
    const out = await resolveLawnCopyV6ForRender({ structuredNotes: { lawnCopyV6: { a1: stored } }, assessmentId: 'a1', reportV2: reportV2(), deps });
    expect(out).toEqual({ copy: { headline: 'Frozen', whatWeDid: null, whatToExpect: null, watching: null }, unfrozen: false });
    expect(deps.buildExpectations).not.toHaveBeenCalled();
  });

  test('a degraded read creates no freeze and carries nothing', async () => {
    const { knex, chain } = knexStub(1);
    const out = await resolveLawnCopyV6ForRender({ structuredNotes: {}, serviceRecordId: 's1', assessmentId: 'a1', reportV2: reportV2(), degraded: true, knex });
    expect(out).toEqual({ copy: null, unfrozen: true });
    expect(chain.update).not.toHaveBeenCalled();
  });

  test('a healthy first render freezes the built fields', async () => {
    const { knex, chain } = knexStub(1);
    const out = await resolveLawnCopyV6ForRender({
      structuredNotes: {}, serviceRecordId: 's1', assessmentId: 'a1', reportV2: reportV2(), knex, deps: { ...expectationsReturning([]), now: () => new Date('2026-09-30T18:00:00Z') },
    });
    expect(out.unfrozen).toBe(false);
    expect(out.copy.headline).toBe('Stable — watching weed pressure');
    const written = JSON.parse(chain.update.mock.calls[0][0].structured_notes.bindings[0]).a1;
    expect(written).toMatchObject({ v: 1, copyVersion: 'lawn_report_v6_fixed_1', assessmentId: 'a1', frozenAt: '2026-09-30T18:00:00.000Z', expectRows: [] });
  });

  test('entries for another assessment or an unknown shape never replay', () => {
    const entry = { v: 1, assessmentId: 'a1', fields: {} };
    expect(storedLawnCopyV6For({ lawnCopyV6: { a1: entry } }, 'a2')).toBeNull();
    expect(storedLawnCopyV6For({ lawnCopyV6: { a1: { ...entry, v: 2 } } }, 'a1')).toBeNull();
    expect(storedLawnCopyV6For(JSON.stringify({ lawnCopyV6: { a1: entry } }), 'a1')).toEqual(entry);
  });
});
