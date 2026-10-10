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
const NOV_NOTES = v13.st_augustine.visits.find((visit) => visit.month === 'Nov').notes;
const targetsFor = (args = {}) => engine.visitNutrientTargets({}, service, { notes: NOV_NOTES, month: 'Nov', v13Active: true, ...args });

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
    expect((await engine.visitNutrientTargets({}, { id: 'x', property_id: null }, { notes: NOV_NOTES, month: 'Nov', v13Active: true })).nitrogenCut).toBeNull();
    expect((await engine.visitNutrientTargets({}, null, { notes: NOV_NOTES, month: 'Nov', v13Active: true })).nitrogenCut).toBeNull();
    expect(mockLoadActive).not.toHaveBeenCalled();
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
