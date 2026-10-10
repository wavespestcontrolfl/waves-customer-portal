// GATE_LAWN_NOV_LARGE_PATCH_N (owner 2026-10-09): the gate reader, the rule's config, and visitNutrientTargets, the one place the
// plan and the tank sheet read a visit's nutrient targets from. Synthetic knex and trouble-area store; no database.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const mockLoadActive = jest.fn();
jest.mock('../services/lawn-trouble-areas', () => ({
  propertyOf: jest.fn(async (knex, svc) => svc?.property_id || null),
  loadActive: (...args) => mockLoadActive(...args),
}));

const featureGates = require('../config/feature-gates');
const { V13_TROUBLE_N_TARGETS, FUNGUS_NITROGEN_NOTE_KEY } = require('../config/lawn-v13-nitrogen-targets');
const engine = require('../services/waveguard-plan-engine');
const v13 = require('../config/lawn-protocol-v13.json');
const { TYPES } = jest.requireActual('../services/lawn-trouble-areas');

const GATES = ['GATE_LAWN_V13', 'GATE_LAWN_SPOT_RULES', 'GATE_LAWN_TREATMENT_GUIDE', 'GATE_LAWN_TROUBLE_AREAS', 'GATE_LAWN_NOV_LARGE_PATCH_N'];
const saved = Object.fromEntries(GATES.map((name) => [name, process.env[name]]));
const allOn = () => { for (const name of GATES) process.env[name] = 'true'; };
beforeEach(() => { jest.clearAllMocks(); allOn(); mockLoadActive.mockResolvedValue([{ id: 'a', type: 'fungus' }]); });
afterEach(() => { for (const name of GATES) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; } });

const service = { id: 'svc-1', property_id: '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d' };
const NOV_VISIT = v13.st_augustine.visits.find((visit) => visit.month === 'Nov');
const NOV_NOTES = NOV_VISIT.notes;
// `notes` overrides the recipe's notes; the returned visit is dropped unless a test asks for it (the targets and the cut are the contract).
const run = (args = {}) => {
  const notes = 'notes' in args ? args.notes : NOV_NOTES;
  const { visit = { ...NOV_VISIT, notes }, notes: _notes, ...rest } = args;
  return engine.visitNutrientTargets({}, service, { visit, month: 'Nov', v13Active: true, ...rest });
};
const targetsFor = async (args = {}) => { const { visit: _visit, ...found } = await run(args); return found; };

describe('lawnNovLargePatchNLive', () => {
  test.each([[undefined, false], ['', false], ['1', false], ['TRUE', false], ['false', false], ['true', true]])('the variable %j gives %s, read at call time', (value, expected) => {
    if (value === undefined) delete process.env.GATE_LAWN_NOV_LARGE_PATCH_N; else process.env.GATE_LAWN_NOV_LARGE_PATCH_N = value;
    expect(featureGates.lawnNovLargePatchNLive()).toBe(expected);
  });

  test.each(GATES.slice(0, 4))('is off when %s is off (fail closed: the rule reads the mapped areas)', (name) => {
    delete process.env[name];
    expect(featureGates.lawnNovLargePatchNLive()).toBe(false);
  });
});

describe('the rule', () => {
  test('one entry: November, fungus, 0.5 lb N; the closed type list names fungus and keeps take-all separate', () => {
    expect(V13_TROUBLE_N_TARGETS).toEqual([{ month: 11, troubleType: 'fungus', targetNPer1000: 0.5 }]);
    expect(TYPES.map((type) => type.id)).toEqual(expect.arrayContaining(['fungus', 'take_all']));
    expect(() => { V13_TROUBLE_N_TARGETS.push({}); }).toThrow();
  });

  test('the recipe November notes state 0.75 lb N and no K target, so only nitrogen moves', () => {
    expect(engine.parseVisitNutrientTargets(NOV_NOTES)).toEqual({ targetNPer1000: 0.75, targetKPer1000: null });
  });
});

describe('visitNutrientTargets', () => {
  test('active fungus in November lowers only the nitrogen target', async () => {
    expect(await targetsFor()).toEqual({ targets: { targetNPer1000: 0.5, targetKPer1000: null }, nitrogenCut: 0.5 });
    expect(mockLoadActive).toHaveBeenCalledWith({}, service.property_id);
  });

  test('potassium is untouched when the visit states one', async () => {
    const found = await targetsFor({ notes: 'N rate: 0.75 lb N. K rate: 0.4 lb K.' });
    expect(found.targets).toEqual({ targetNPer1000: 0.5, targetKPer1000: 0.4 });
  });

  test.each([['Oct'], ['Dec'], ['Apr'], [undefined]])('month %s keeps the visit\'s target and reads no area', async (month) => {
    expect(await targetsFor({ month })).toEqual({ targets: { targetNPer1000: 0.75, targetKPer1000: null }, nitrogenCut: null });
    expect(mockLoadActive).not.toHaveBeenCalled();
  });

  test.each([['0.5'], ['0.45'], ['0.25']])('a target of %s lb N is already at or below the cut: never raised, no read', async (n) => {
    const found = await targetsFor({ notes: `N rate: ${n} lb N.` });
    expect(found).toEqual({ targets: { targetNPer1000: Number(n), targetKPer1000: null }, nitrogenCut: null });
    expect(mockLoadActive).not.toHaveBeenCalled();
  });

  test('a visit with no nitrogen target at all stays without one', async () => {
    expect(await targetsFor({ notes: 'Spreader visit.' })).toEqual({ targets: { targetNPer1000: null, targetKPer1000: null }, nitrogenCut: null });
    expect(await targetsFor({ notes: undefined })).toEqual({ targets: { targetNPer1000: null, targetKPer1000: null }, nitrogenCut: null });
  });

  test('not a v13 plan: unchanged, no read', async () => {
    expect((await targetsFor({ v13Active: false })).nitrogenCut).toBeNull();
    expect(mockLoadActive).not.toHaveBeenCalled();
  });

  test.each(GATES.slice(1))('%s off: unchanged, no read', async (name) => {
    delete process.env[name];
    expect((await targetsFor()).nitrogenCut).toBeNull();
    expect(mockLoadActive).not.toHaveBeenCalled();
  });

  test.each([
    ['no area', []],
    ['take-all', [{ type: 'take_all' }]],
    ['weeds, chinch, insects and dry spot', [{ type: 'weeds' }, { type: 'chinch' }, { type: 'other_insect' }, { type: 'dry_spot' }]],
  ])('%s: unchanged', async (_label, areas) => {
    mockLoadActive.mockResolvedValue(areas);
    expect((await targetsFor()).nitrogenCut).toBeNull();
  });

  test('a failed read, a visit with no property and no visit at all: unchanged, and the failure is logged by code only', async () => {
    mockLoadActive.mockRejectedValue(Object.assign(new Error('secret detail 555-0100'), { code: 'ECONNRESET' }));
    expect((await targetsFor()).nitrogenCut).toBeNull();
    const logged = require('../services/logger').warn.mock.calls.map((call) => call[0]).join(' ');
    expect(logged).toContain('ECONNRESET');
    expect(logged).not.toContain('secret detail');
    mockLoadActive.mockReset().mockResolvedValue([{ type: 'fungus' }]);
    expect((await engine.visitNutrientTargets({}, { id: 'x', property_id: null }, { visit: NOV_VISIT, month: 'Nov', v13Active: true })).nitrogenCut).toBeNull();
    expect((await engine.visitNutrientTargets({}, null, { visit: NOV_VISIT, month: 'Nov', v13Active: true })).nitrogenCut).toBeNull();
    expect((await engine.visitNutrientTargets({}, service, { visit: null, month: 'Nov', v13Active: true })).nitrogenCut).toBeNull();
    expect(mockLoadActive).not.toHaveBeenCalled();
  });
});

describe('the visit text staff read agrees with the cut (codex #6256 r1 P1)', () => {
  const PRIMARY = 'LESCO 24-0-11 with PolyPlus OPTI \u2014 3.1 lb per 1,000 sq ft (0.75 lb N), spreader';

  test('the November recipe line is the shape the rewrite expects, in every track', () => {
    for (const track of Object.values(v13)) expect(track.visits.find((visit) => visit.month === 'Nov').primary).toBe(PRIMARY);
  });

  test('cut: the primary line states 2.1 lb per 1,000 and 0.5 lb N and why; the notes state 0.5 lb N and the normal figure; the rest is untouched', async () => {
    const found = await run();
    expect(found.visit.primary).toBe('LESCO 24-0-11 with PolyPlus OPTI \u2014 2.1 lb per 1,000 sq ft (0.5 lb N), spreader, active fungus mapped');
    expect(found.visit.notes).toBe(NOV_NOTES.replace('N rate: 0.75 lb N', 'N rate: 0.5 lb N (active fungus mapped; normal 0.75 lb N)'));
    expect(found.visit.notes).toContain('Spreader visit. Fertilizer safety:');
    expect(found.visit.secondary).toBe(NOV_VISIT.secondary);
    expect(found.visit.tiers).toBe(NOV_VISIT.tiers);
    // The adjusted notes alone yield the cut target, and the recipe object itself is not mutated.
    expect(engine.parseVisitNutrientTargets(found.visit.notes)).toEqual({ targetNPer1000: 0.5, targetKPer1000: null });
    expect(NOV_VISIT.primary).toBe(PRIMARY);
    expect(found.visit).not.toBe(NOV_VISIT);
  });

  test('the rewritten line classifies the same and still matches the same catalog product (raw is no identity key)', async () => {
    const { visit } = await run({ visit: NOV_VISIT });
    expect(visit.primary).not.toBe(PRIMARY);
    expect(engine.classifyProtocolLine(visit.primary, 'base')).toEqual(engine.classifyProtocolLine(PRIMARY, 'base'));
    const catalog = [{ id: 'f24', name: 'LESCO 24-0-11 with PolyPlus OPTI', aliases: [], analysis_n: 24 }, { id: 'f10', name: 'LESCO 10-0-22', aliases: [], analysis_n: 10 }];
    expect(engine.matchCatalogProduct({ raw: PRIMARY, exactName: true }, catalog)?.id).toBe('f24');
    expect(engine.matchCatalogProduct({ raw: visit.primary, exactName: true }, catalog)?.id).toBe('f24');
  });

  test('nothing is rewritten when the cut does not apply: the same visit object comes back', async () => {
    mockLoadActive.mockResolvedValue([]);
    expect((await run({ visit: NOV_VISIT })).visit).toBe(NOV_VISIT);
    delete process.env.GATE_LAWN_NOV_LARGE_PATCH_N;
    expect((await run({ visit: NOV_VISIT })).visit).toBe(NOV_VISIT);
  });

  test('text the pattern does not match stays as written, and the cut and the target still apply (no silent half override)', async () => {
    const odd = { ...NOV_VISIT, primary: 'LESCO 24-0-11 with PolyPlus OPTI \u2014 about 3 lb, spreader', notes: 'Spreader visit. N rate 0.75 pounds.' };
    // The notes still state a target the parser reads, but the wording is not the recipe's: the target is forced to the cut.
    const found = await engine.visitNutrientTargets({}, service, { visit: { ...odd, notes: 'N app @ 0.75 lb N/1K. Spreader visit.' }, month: 'Nov', v13Active: true });
    expect(found.nitrogenCut).toBe(0.5);
    expect(found.targets.targetNPer1000).toBe(0.5);
    expect(found.visit.primary).toBe(odd.primary);
    expect(found.visit.notes).toBe('N app @ 0.75 lb N/1K. Spreader visit.');
  });

  test('a line already at or under the cut is left alone', () => {
    return engine.visitNutrientTargets({}, service, { visit: { ...NOV_VISIT, primary: 'Bag \u2014 2.1 lb per 1,000 sq ft (0.5 lb N), spreader', notes: 'N rate: 0.75 lb N.' }, month: 'Nov', v13Active: true }).then((found) => {
      expect(found.visit.primary).toBe('Bag \u2014 2.1 lb per 1,000 sq ft (0.5 lb N), spreader');
    });
  });
});

describe('the property read and the trouble-area read share one savepoint (codex #6256 r1 P2)', () => {
  const areas = require('../services/lawn-trouble-areas');
  const transaction = (log) => ({ isTransaction: true, raw: jest.fn(async (sql) => { log.push(sql.replace(/fail_soft_[0-9a-f]+/, 'SP')); }) });

  test('on a transaction the property resolution runs INSIDE the savepoint, before the area read', async () => {
    const log = [];
    areas.propertyOf.mockImplementationOnce(async () => { log.push('propertyOf'); return service.property_id; });
    mockLoadActive.mockImplementationOnce(async () => { log.push('loadActive'); return [{ type: 'fungus' }]; });
    const found = await engine.visitNutrientTargets(transaction(log), service, { visit: NOV_VISIT, month: 'Nov', v13Active: true });
    expect(found.nitrogenCut).toBe(0.5);
    expect(log).toEqual(['SAVEPOINT SP', 'propertyOf', 'loadActive', 'RELEASE SAVEPOINT SP']);
  });

  test('a property query that fails rolls the savepoint back, so the transaction stays usable; the normal target stands', async () => {
    const log = [];
    areas.propertyOf.mockImplementationOnce(async () => { log.push('propertyOf'); throw Object.assign(new Error('aborted'), { code: '25P02' }); });
    const found = await engine.visitNutrientTargets(transaction(log), service, { visit: NOV_VISIT, month: 'Nov', v13Active: true });
    expect(found.nitrogenCut).toBeNull();
    expect(found.visit).toBe(NOV_VISIT);
    expect(log).toEqual(['SAVEPOINT SP', 'propertyOf', 'ROLLBACK TO SAVEPOINT SP', 'RELEASE SAVEPOINT SP']);
    expect(mockLoadActive).not.toHaveBeenCalled();
  });

  test('a failure in the area read rolls back the same way', async () => {
    const log = [];
    mockLoadActive.mockRejectedValueOnce(Object.assign(new Error('boom'), { code: 'ECONNRESET' }));
    const found = await engine.visitNutrientTargets(transaction(log), service, { visit: NOV_VISIT, month: 'Nov', v13Active: true });
    expect(found.nitrogenCut).toBeNull();
    expect(log).toEqual(['SAVEPOINT SP', 'ROLLBACK TO SAVEPOINT SP', 'RELEASE SAVEPOINT SP']);
  });
});

describe('fungusNitrogenNotes', () => {
  const f24 = { id: 'f24', analysis_n: 24, analysis_k: 11, default_rate_per_1000: 4.2, rate_unit: 'lb' };
  const mixFor = async () => {
    const { targets } = await targetsFor();
    return engine.calculateProductAmount({ product: f24, lawnSqft: 10000, areaFactor: 1, ...targets, ...engine.v13RateOptions({ ratePer1000: null, rateUnit: 'lb_n' }) });
  };

  test('24-0-11 at the cut is 2.0833 lb per 1,000, 0.5 lb N, and the note says 2.1', async () => {
    const mix = await mixFor();
    expect(mix.ratePer1000).toBeCloseTo(2.0833, 4);
    expect(mix.ratePer1000 * 0.24).toBeCloseTo(0.5, 4);
    expect(engine.fungusNitrogenNotes(mix, 0.5)).toEqual([{
      key: FUNGUS_NITROGEN_NOTE_KEY, severity: 'note',
      text: 'Active fungus mapped: nitrogen reduced to 0.5 lb N (2.1 lb per 1,000). Close the spreader over the patch and 6 ft around it.',
    }]);
  });

  test('no note when the cut did not size the line', async () => {
    const mix = await mixFor();
    expect(engine.fungusNitrogenNotes(mix, null)).toEqual([]);
    expect(engine.fungusNitrogenNotes({ ...mix, rateSource: 'protocol_rate' }, 0.5)).toEqual([]);
    expect(engine.fungusNitrogenNotes({ ...mix, targetNPer1000: 0.75 }, 0.5)).toEqual([]);
    expect(engine.fungusNitrogenNotes(null, 0.5)).toEqual([]);
  });
});

describe('the recipe text', () => {
  test('no track states the rule in its November notes or lines (the text would be false with the gate off)', () => {
    for (const track of Object.values(v13)) {
      const nov = track.visits.find((visit) => visit.month === 'Nov');
      expect(`${nov.primary}\n${nov.notes}`).not.toMatch(/0\.5 lb N|fungus is (mapped|active)|reduced/i);
    }
  });
});
