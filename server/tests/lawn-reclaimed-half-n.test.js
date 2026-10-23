// GATE_LAWN_RECLAIMED_HALF_N (owner 2026-10-05, 2026-10-23): the gate reader, the property read, and the plan engine's one nitrogen decision
// (nitrogenDecision / visitNutrientTargets) that the plan, the tank sheet and the previsit brief share. Synthetic knex and stores; no database.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const mockLoadActive = jest.fn();
jest.mock('../services/lawn-trouble-areas', () => ({
  propertyOf: jest.fn(async (knex, svc) => svc?.property_id || null),
  loadActive: (...args) => mockLoadActive(...args),
}));

const featureGates = require('../config/feature-gates');
const { RECLAIMED_N_FRACTION, RECLAIMED_NITROGEN_NOTE_KEY, FUNGUS_NITROGEN_NOTE_KEY } = require('../config/lawn-v13-nitrogen-targets');
const engine = require('../services/waveguard-plan-engine');
const reclaimed = require('../services/lawn-reclaimed-water');
const v13 = require('../config/lawn-protocol-v13.json');

const GATES = ['GATE_LAWN_V13', 'GATE_LAWN_SPOT_RULES', 'GATE_LAWN_TREATMENT_GUIDE', 'GATE_LAWN_TROUBLE_AREAS', 'GATE_LAWN_NOV_LARGE_PATCH_N', 'GATE_LAWN_RECLAIMED_HALF_N'];
const saved = Object.fromEntries(GATES.map((name) => [name, process.env[name]]));
const PROPERTY = '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const service = { id: 'svc-1', property_id: PROPERTY };

// A knex whose customer_properties read answers `row`; every call is recorded.
function fakeKnex(row) {
  const calls = [];
  const knex = (table) => {
    calls.push(table);
    return { where: () => ({ first: async () => { if (row instanceof Error) throw row; return row; } }) };
  };
  knex.calls = calls;
  return knex;
}
const REC = () => fakeKnex({ reclaimed_water: true });
const NOT_REC = () => fakeKnex({ reclaimed_water: false });

beforeEach(() => {
  jest.clearAllMocks();
  for (const name of GATES) process.env[name] = 'true';
  mockLoadActive.mockResolvedValue([]);
});
afterEach(() => { for (const name of GATES) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; } });

const visitOf = (month, track = 'st_augustine') => v13[track].visits.find((visit) => visit.month === month);
const run = (knex, month, extra = {}) => engine.visitNutrientTargets(knex, service, { visit: visitOf(month), month, v13Active: true, ...extra });

describe('lawnReclaimedHalfNLive', () => {
  test.each([[undefined, false], ['', false], ['1', false], ['TRUE', false], ['false', false], ['true', true]])('the variable %j gives %s, read at call time', (value, expected) => {
    if (value === undefined) delete process.env.GATE_LAWN_RECLAIMED_HALF_N; else process.env.GATE_LAWN_RECLAIMED_HALF_N = value;
    expect(featureGates.lawnReclaimedHalfNLive()).toBe(expected);
  });
});

describe('every N visit of a reclaimed lawn is halved (all three tracks)', () => {
  test.each([
    ['Feb', 0.75, 0.375],
    ['Nov', 0.75, 0.375],
  ])('%s: %s lb N becomes %s lb N, the visit text states it, potassium is untouched', async (month, normal, half) => {
    for (const track of Object.keys(v13)) {
      const found = await run(REC(), month, { visit: visitOf(month, track) });
      expect(found.nitrogenCut).toBe(half);
      expect(found.reclaimedWater).toBe('half');
      expect(found.targets.targetNPer1000).toBe(half);
      expect(found.targets.targetKPer1000).toBe(engine.parseVisitNutrientTargets(visitOf(month, track).notes).targetKPer1000);
      expect(found.visit.notes).toContain(`N rate: ${half} lb N (reclaimed water, half; normal ${normal} lb N)`);
      expect(found.visit.primary).toContain(`(${half} lb N)`);
      expect(found.visit.primary).toContain(', reclaimed water, half');
      expect(engine.parseVisitNutrientTargets(found.visit.notes).targetNPer1000).toBe(half);
    }
  });

  test('April, the 12x plan, is the 44-0-0 bag (1.0 lb N): half of it, 0.5 lb N', async () => {
    const found = await run(REC(), 'Apr');
    expect(found.nitrogenCut).toBe(0.5);
    expect(found.visit.primary).toContain('1.1 lb per 1,000 sq ft (0.5 lb N)');
  });

  test('the fraction is one half and nothing else', () => {
    expect(RECLAIMED_N_FRACTION).toBe(0.5);
  });

  test('24-0-11 at the halved target is 1.5625 lb per 1,000 (0.375 lb N), the note says 1.6, and the note key is the reclaimed one', async () => {
    const found = await run(REC(), 'Nov');
    const f24 = { id: 'f24', analysis_n: 24, analysis_k: 11, default_rate_per_1000: 4.2, rate_unit: 'lb' };
    const mix = engine.calculateProductAmount({ product: f24, lawnSqft: 10000, areaFactor: 1, ...found.targets, ...engine.v13RateOptions({ ratePer1000: null, rateUnit: 'lb_n' }) });
    expect(mix.ratePer1000).toBeCloseTo(1.5625, 4);
    expect(mix.ratePer1000 * 0.24).toBeCloseTo(0.375, 4);
    expect(engine.nitrogenCutNotes(mix, f24, found)).toEqual([{
      key: RECLAIMED_NITROGEN_NOTE_KEY, severity: 'note', text: 'Reclaimed water: half nitrogen today (0.375 lb N, 1.6 lb per 1,000).',
    }]);
    expect(RECLAIMED_NITROGEN_NOTE_KEY).not.toBe(FUNGUS_NITROGEN_NOTE_KEY);
  });

  test('a bag the halved target did not size gets no note', async () => {
    const found = await run(REC(), 'Nov');
    expect(engine.nitrogenCutNotes({ rateSource: 'protocol_rate', targetNPer1000: 0.375, ratePer1000: 4 }, { name: 'Bag' }, found)).toEqual([]);
    expect(engine.nitrogenCutNotes({ rateSource: 'target_n_analysis', targetNPer1000: 0.75, ratePer1000: 3 }, { name: 'Bag' }, found)).toEqual([]);
  });
});

describe('the gate off, or a lawn that is not reclaimed, changes nothing', () => {
  test('gate off: the answer is the old shape exactly and nothing is read, not even the property', async () => {
    delete process.env.GATE_LAWN_RECLAIMED_HALF_N;
    const knex = REC();
    const found = await run(knex, 'Nov');
    expect(found).toEqual({ visit: visitOf('Nov'), targets: { targetNPer1000: 0.75, targetKPer1000: null }, nitrogenCut: null });
    expect(found.visit).toBe(visitOf('Nov'));
    expect(knex.calls).toEqual([]);
  });

  test.each([['not reclaimed', NOT_REC()], ['no property row', fakeKnex(undefined)], ['unknown (NULL)', fakeKnex({ reclaimed_water: null })]])('%s: the normal target stands', async (_label, knex) => {
    const found = await run(knex, 'Nov');
    expect(found).toEqual({ visit: visitOf('Nov'), targets: { targetNPer1000: 0.75, targetKPer1000: null }, nitrogenCut: null });
  });

  test('not a v13 plan: unchanged, no read', async () => {
    const knex = REC();
    expect((await run(knex, 'Nov', { v13Active: false })).nitrogenCut).toBeNull();
    expect(knex.calls).toEqual([]);
  });

  test.each([['Jan'], ['May'], ['Jun'], ['Jul'], ['Aug'], ['Sep']])('%s states 0 lb N: no cut and no read', async (month) => {
    const knex = REC();
    const found = await run(knex, month);
    expect(found.nitrogenCut).toBeNull();
    expect(found.reclaimedWater).toBeUndefined();
    expect(knex.calls).toEqual([]);
  });

  test('a visit with no stated target, a visit with no property, and no visit at all: unchanged', async () => {
    const knex = REC();
    expect((await run(knex, 'Nov', { visit: { ...visitOf('Nov'), notes: 'Spreader visit.' } })).nitrogenCut).toBeNull();
    expect((await engine.visitNutrientTargets(knex, { id: 'x', property_id: null }, { visit: visitOf('Nov'), month: 'Nov', v13Active: true })).nitrogenCut).toBeNull();
    expect((await engine.visitNutrientTargets(knex, null, { visit: visitOf('Nov'), month: 'Nov', v13Active: true })).nitrogenCut).toBeNull();
    expect((await engine.visitNutrientTargets(knex, service, { visit: null, month: 'Nov', v13Active: true })).nitrogenCut).toBeNull();
  });
});

describe('the pre-emergent plus fertilizer bags keep their rate (the pre-emergent rate matters)', () => {
  const OCT = () => visitOf('Oct');
  const APRIL_9X = () => visitOf('Apr').cadenceVariants[9];

  test.each([['October Dimension 18-0-10 at 4.04 lb', OCT], ['the 9x April Dimension at 2.78 lb', APRIL_9X]])('%s: not halved, the visit is returned as it is, and it says so', async (_label, pick) => {
    const knex = REC();
    const visit = pick();
    expect(visit.primary).toMatch(/Pre-Emergent Plus Fertilizer/);
    const found = await engine.visitNutrientTargets(knex, service, { visit, month: visit === OCT() ? 'Oct' : 'Apr', v13Active: true });
    expect(found.nitrogenCut).toBeNull();
    expect(found.reclaimedWater).toBe('kept');
    expect(found.keptFor).toBe('pre_emergent');
    expect(found.visit).toBe(visit);
    expect(found.targets.targetNPer1000).toBe(engine.parseVisitNutrientTargets(visit.notes).targetNPer1000);
    const dimension = { analysis_k: 10, name: 'LESCO Dimension 0.21% 18-0-10 50% PolyPlus OPTI45 MOP Pre-Emergent Plus Fertilizer' };
    expect(engine.nitrogenCutNotes({ rateSource: 'protocol_rate' }, dimension, found)).toEqual([{
      key: RECLAIMED_NITROGEN_NOTE_KEY, severity: 'note', text: 'Reclaimed water: this bag carries the pre-emergent, so its full rate stays today.',
    }]);
    // A plain fertilizer line on the same visit gets no such note.
    expect(engine.nitrogenCutNotes({ rateSource: 'target_n_analysis' }, { name: 'LESCO 24-0-11 with PolyPlus OPTI' }, found)).toEqual([]);
  });

  test('a not-reclaimed lawn gets no "kept" note either', async () => {
    const found = await engine.visitNutrientTargets(NOT_REC(), service, { visit: OCT(), month: 'Oct', v13Active: true });
    expect(found.reclaimedWater).toBeUndefined();
  });

  test('the previsit brief names the same bag from its catalog name', async () => {
    const decide = (keep) => engine.nitrogenDecision(REC(), service, { targetN: 0.73, monthNumber: 10, v13Active: true, keep });
    expect(await decide('pre_emergent')).toEqual({ cut: null, why: 'fungus', reclaimed: 'kept', keptFor: 'pre_emergent' });
    expect(await decide(null)).toEqual({ cut: 0.365, why: 'reclaimed', reclaimed: 'half' });
  });
});

describe('the winter potash bag keeps its rate (reclaimed water adds N, not K)', () => {
  const DEC = (track = 'st_augustine') => visitOf('Dec', track);

  test.each(['st_augustine', 'bermuda', 'zoysia'])('%s December 10-0-22 (0.45 lb N, 0.99 lb K2O): not halved, the visit is returned as it is, and it says so', async (track) => {
    const visit = DEC(track);
    expect(engine.parseVisitNutrientTargets(visit.notes)).toEqual({ targetNPer1000: 0.45, targetKPer1000: 0.99 });
    const found = await engine.visitNutrientTargets(REC(), service, { visit, month: 'Dec', v13Active: true });
    expect(found).toEqual({ visit, targets: { targetNPer1000: 0.45, targetKPer1000: 0.99 }, nitrogenCut: null, reclaimedWater: 'kept', keptFor: 'potash' });
    expect(found.visit).toBe(visit);
    const bag = { name: 'LESCO 10-0-22 50% PolyPlus OPTI45 50% YaraRega 2% Fe 2% Mg KMAG MOP SOP Turfgrass Granular Fertilizer', analysis_n: 10, analysis_k: 22 };
    expect(engine.nitrogenCutNotes({ rateSource: 'target_n_analysis' }, bag, found)).toEqual([{
      key: RECLAIMED_NITROGEN_NOTE_KEY, severity: 'note', text: 'Reclaimed water: this bag carries the winter potash, so its full rate stays today.',
    }]);
    // A line with no potassium in it gets no such note.
    expect(engine.nitrogenCutNotes({ rateSource: 'target_n_analysis' }, { name: 'Bag', analysis_n: 24, analysis_k: 0 }, found)).toEqual([]);
  });

  test('a pre-emergent bag that also states K2O (October) keeps the pre-emergent reason, not the potash one', async () => {
    const found = await engine.visitNutrientTargets(REC(), service, { visit: visitOf('Oct'), month: 'Oct', v13Active: true });
    expect(found.keptFor).toBe('pre_emergent');
  });

  test('a not-reclaimed lawn, or the gate off, leaves December exactly as it was', async () => {
    expect(await engine.visitNutrientTargets(NOT_REC(), service, { visit: DEC(), month: 'Dec', v13Active: true })).toEqual({ visit: DEC(), targets: { targetNPer1000: 0.45, targetKPer1000: 0.99 }, nitrogenCut: null });
    delete process.env.GATE_LAWN_RECLAIMED_HALF_N;
    const knex = REC();
    expect(await engine.visitNutrientTargets(knex, service, { visit: DEC(), month: 'Dec', v13Active: true })).toEqual({ visit: DEC(), targets: { targetNPer1000: 0.45, targetKPer1000: 0.99 }, nitrogenCut: null });
    expect(knex.calls).toEqual([]);
  });

  test('an ordinary N bag (no potassium target, no pre-emergent) is still halved: February and November', async () => {
    for (const month of ['Feb', 'Nov']) expect(engine.parseVisitNutrientTargets(visitOf(month).notes).targetKPer1000).toBeNull();
  });

  test('the previsit brief keeps a bag that states K2O, and halves one that does not', async () => {
    const decide = (keep) => engine.nitrogenDecision(REC(), service, { targetN: 0.45, monthNumber: 12, v13Active: true, keep });
    expect(await decide('potash')).toEqual({ cut: null, why: 'fungus', reclaimed: 'kept', keptFor: 'potash' });
    expect(await decide(null)).toEqual({ cut: 0.225, why: 'reclaimed', reclaimed: 'half' });
  });
});

describe('with the November large patch cut too: the smaller target wins, not both', () => {
  beforeEach(() => { mockLoadActive.mockResolvedValue([{ id: 'a', type: 'fungus' }]); });

  test('reclaimed + active fungus in November is 0.375, not 0.25 and not 0.5', async () => {
    const found = await run(REC(), 'Nov');
    expect(found.nitrogenCut).toBe(0.375);
    expect(found.reclaimedWater).toBe('half');
    expect(found.visit.notes).toContain('reclaimed water, half');
    expect(found.visit.notes).not.toContain('fungus');
  });

  test('fungus alone still cuts to 0.5 with the fungus wording and no reclaimed key', async () => {
    const found = await run(NOT_REC(), 'Nov');
    expect(found.nitrogenCut).toBe(0.5);
    expect(found.reclaimedWater).toBeUndefined();
    expect(found.visit.notes).toContain('active fungus mapped; normal 0.75 lb N');
  });

  test('reclaimed with the large patch gate off is the half cut and reads no area', async () => {
    delete process.env.GATE_LAWN_NOV_LARGE_PATCH_N;
    const found = await run(REC(), 'Nov');
    expect(found.nitrogenCut).toBe(0.375);
    expect(mockLoadActive).not.toHaveBeenCalled();
  });

  test('the archived-recipe check admits the halved target for this visit only', () => {
    const { archivedLawnRecipeMatches } = require('../services/lawn-completion-defaults');
    const row = { productId: 'f24', defaultInPlan: true, ratePer1000: null, rateUnit: 'lb_n', applicationMode: 'broadcast', gates: { targetN: '0.75 lb N/1000' } };
    const item = (target) => ({ selected: true, product: { id: 'f24' }, scope: 'BROADCAST_FULL', mix: { rateSource: 'target_n_analysis', ratePer1000: target / 0.24, targetNPer1000: target } });
    expect(archivedLawnRecipeMatches({ status: 'archived', products: [row] }, [item(0.375)], { from: 0.75, to: 0.375 })).toBe(true);
    expect(archivedLawnRecipeMatches({ status: 'archived', products: [row] }, [item(0.375)], null)).toBe(false);
  });
});

describe('the property read (isReclaimedService)', () => {
  test('true only for a property marked reclaimed, whatever its source', async () => {
    expect(await reclaimed.isReclaimedService(fakeKnex({ reclaimed_water: true }), service)).toBe(true);
    expect(await reclaimed.isReclaimedService(fakeKnex({ reclaimed_water: false }), service)).toBe(false);
    expect(await reclaimed.isReclaimedService(fakeKnex({ reclaimed_water: null }), service)).toBe(false);
  });

  test('a failed read keeps the normal target and logs the code only; strict throws', async () => {
    const err = Object.assign(new Error('secret detail 555-0100'), { code: 'ECONNRESET' });
    expect(await reclaimed.isReclaimedService(fakeKnex(err), service)).toBe(false);
    const logged = require('../services/logger').warn.mock.calls.map((call) => call[0]).join(' ');
    expect(logged).toContain('ECONNRESET');
    expect(logged).not.toContain('secret detail');
    await expect(reclaimed.isReclaimedService(fakeKnex(err), service, { strict: true })).rejects.toThrow('secret detail');
    await expect(engine.nitrogenDecision(fakeKnex(err), service, { targetN: 0.75, monthNumber: 11, v13Active: true, strict: true })).rejects.toThrow();
  });

  test('on a transaction the read runs inside a savepoint that is released', async () => {
    const log = [];
    const trx = (table) => { log.push(table); return { where: () => ({ first: async () => ({ reclaimed_water: true }) }) }; };
    trx.isTransaction = true;
    trx.raw = jest.fn(async (sql) => { log.push(sql.replace(/fail_soft_[0-9a-f]+/, 'SP')); });
    expect(await reclaimed.isReclaimedService(trx, service)).toBe(true);
    expect(log).toEqual(['SAVEPOINT SP', 'customer_properties', 'RELEASE SAVEPOINT SP']);
  });
});

describe('the recipe text', () => {
  test('all three tracks say the amount is set by the app when the property is marked reclaimed (true with the gate off or on: it names the line note, not the property mark), and no track says the app does not adjust it', () => {
    for (const track of Object.values(v13)) {
      const exact = 'get half the N at every N visit, except bags that carry the pre-emergent or the winter potassium, which keep their full rate. A line that shows "Reclaimed water: half nitrogen today" is already halved by the app; otherwise the tech logs half.';
      expect(track.notes.join(' ')).toContain(`Reclaimed-water lawns (purple pipes or caps) ${exact}`);
      expect(track.safety_rules[6]).toContain(`reclaimed-water lawns ${exact}`);
      expect(JSON.stringify(track)).not.toContain('does not adjust it yet');
    }
  });
});
