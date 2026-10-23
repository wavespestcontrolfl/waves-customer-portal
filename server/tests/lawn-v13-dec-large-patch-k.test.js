// GATE_LAWN_DEC_LARGE_PATCH_K (owner 2026-10-23): the gate reader, the swap rule, and visitNutrientTargets, the one place the plan
// and the tank sheet read a visit's nutrient targets and bag from. A lawn with an ACTIVE mapped large patch gets LESCO Black Out
// 0-0-24 (4.1 lb per 1,000 = 0.99 lb K2O, 0 N) in December instead of the LESCO 10-0-22 (4.5 lb = 0.45 lb N, 0.99 lb K2O). Synthetic
// knex and trouble-area store; no database.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const mockLoadActive = jest.fn();
jest.mock('../services/lawn-trouble-areas', () => ({
  propertyOf: jest.fn(async (knex, svc) => svc?.property_id || null),
  loadActive: (...args) => mockLoadActive(...args),
  // The rules ask for a LARGE PATCH area (loadActiveLargePatch); this store answers for it with the areas the test sets. The evidence itself
  // (the newest fungicide target at the place) is tested against real rows in lawn-v13-nov-large-patch-n.db.test.js and lawn-v13-dec-large-patch-k.plan.db.test.js.
  loadActiveLargePatch: (...args) => mockLoadActive(...args),
}));

const featureGates = require('../config/feature-gates');
const { V13_TROUBLE_PRODUCT_SWAPS, PRODUCT_SWAP_NOTE_KEY, DEC_FROM, DEC_K_PRODUCT, SWAP_KEY, swapRecipeProblems } = require('../config/lawn-v13-trouble-product-swaps');
const engine = require('../services/waveguard-plan-engine');
const v13 = require('../config/lawn-protocol-v13.json');
const { validateRule } = require('../services/service-report/lawn-watering-rule');
const { approvedReportProductFacts } = require('../services/service-report/report-data');
const migration = require('../models/migrations/20261023121000_lawn_v13_dec_large_patch_potassium_v2');

const GATES = ['GATE_LAWN_V13', 'GATE_LAWN_SPOT_RULES', 'GATE_LAWN_TREATMENT_GUIDE', 'GATE_LAWN_TROUBLE_AREAS', 'GATE_LAWN_DEC_LARGE_PATCH_K'];
const saved = Object.fromEntries(GATES.map((name) => [name, process.env[name]]));
const allOn = () => { for (const name of GATES) process.env[name] = 'true'; };
beforeEach(() => { jest.clearAllMocks(); allOn(); mockLoadActive.mockResolvedValue([{ id: 'a', type: 'fungus' }]); });
afterEach(() => { for (const name of GATES) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; } });

const service = { id: 'svc-1', property_id: '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d' };
const TRACKS = Object.keys(v13);
const decOf = (track) => v13[track].visits.find((visit) => visit.month === 'Dec');
const DEC = decOf('st_augustine');
const run = (args = {}) => {
  const { visit = DEC, ...rest } = args;
  return engine.visitNutrientTargets({}, service, { visit, month: 'Dec', v13Active: true, ...rest });
};

// The catalog rows as the migration writes them (the 10-0-22 as the December potash migration left it).
const BLACK_OUT = { id: 'bo', name: DEC_K_PRODUCT, category: 'fertilizer', formulation: 'granular', analysis_n: 0, analysis_p: 0, analysis_k: 24, default_rate_per_1000: 4.1, rate_unit: 'lb', unit_size_oz: 800, container_size: '50 lb' };
const TEN_22 = { id: 't22', name: DEC_FROM, category: 'fertilizer', formulation: 'granular', analysis_n: 10, analysis_p: 0, analysis_k: 22, default_rate_per_1000: 4.5, rate_unit: 'lb', unit_size_oz: 800, container_size: '50 lb', best_price: 31.81 };
const BO_ROW = { rateUnit: 'lb_k', ratePer1000: null, gates: { ...migration.NEW_GATES } };
const TEN_ROW = { rateUnit: 'lb_n', ratePer1000: null, gates: { targetN: '0.45 lb N/1000', targetK2O: '0.99 lb K2O/1000' } };

describe('lawnDecLargePatchKLive', () => {
  test.each([[undefined, false], ['', false], ['1', false], ['TRUE', false], ['false', false], ['true', true]])('the variable %j gives %s, read at call time', (value, expected) => {
    if (value === undefined) delete process.env.GATE_LAWN_DEC_LARGE_PATCH_K; else process.env.GATE_LAWN_DEC_LARGE_PATCH_K = value;
    expect(featureGates.lawnDecLargePatchKLive()).toBe(expected);
  });

  test.each(GATES.slice(0, 4))('is off when %s is off (fail closed: the rule reads the mapped areas)', (name) => {
    delete process.env[name];
    expect(featureGates.lawnDecLargePatchKLive()).toBe(false);
  });
});

describe('the rule and the recipe', () => {
  test('one entry: December, fungus, the 10-0-22 out, the 0-0-24 in, 0 lb N; frozen', () => {
    expect(V13_TROUBLE_PRODUCT_SWAPS).toHaveLength(1);
    expect(V13_TROUBLE_PRODUCT_SWAPS[0]).toMatchObject({ month: 12, troubleType: 'fungus', evidence: 'large_patch', gate: 'lawnDecLargePatchKLive', from: DEC_FROM, to: DEC_K_PRODUCT, targetN: 0 });
    expect(Object.isFrozen(V13_TROUBLE_PRODUCT_SWAPS)).toBe(true);
    expect(Object.isFrozen(V13_TROUBLE_PRODUCT_SWAPS[0])).toBe(true);
    expect(migration.NEW_NAME).toBe(DEC_K_PRODUCT);
    expect(migration.FROM_NAME).toBe(DEC_FROM);
  });

  test('every track: the recipe December line is the 10-0-22 at 4.5 lb (0.45 lb N, 0.99 lb K2O); the 0-0-24 appears only inside the conditional swaps block', () => {
    for (const track of TRACKS) {
      const dec = decOf(track);
      expect(dec.primary).toBe(`${DEC_FROM} \u2014 4.5 lb per 1,000 sq ft (0.45 lb N, 0.99 lb K2O), spreader`);
      expect(engine.parseVisitNutrientTargets(dec.notes)).toEqual({ targetNPer1000: 0.45, targetKPer1000: 0.99 });
      // Not a line the plan parses: the secondary list and the notes do not name the bag.
      expect(dec.secondary).not.toContain('Black Out');
      expect(dec.notes).not.toContain('Black Out');
      expect(Object.keys(dec.swaps)).toEqual([SWAP_KEY]);
    }
    // Every other visit of every track is free of it.
    for (const track of TRACKS) for (const visit of v13[track].visits.filter((entry) => entry.month !== 'Dec')) expect(JSON.stringify(visit)).not.toContain('Black Out');
  });

  test('the recipe block and the overlay agree on all three tracks (they cannot drift): swapRecipeProblems() is empty', () => {
    expect(swapRecipeProblems()).toEqual([]);
    const block = decOf('zoysia').swaps[SWAP_KEY];
    expect(block).toMatchObject({
      gate: 'GATE_LAWN_DEC_LARGE_PATCH_K', replaces: DEC_FROM, targetN: 0, trigger: { troubleType: 'fungus', evidence: 'large_patch' },
      primary: `${DEC_K_PRODUCT} \u2014 4.1 lb per 1,000 sq ft (0 lb N, 0.99 lb K2O), spreader, active patch mapped`,
    });
    expect(block.summary).toContain(`${DEC_K_PRODUCT} \u2014 4.1 lb per 1,000 sq ft (0 N, 0.99 lb K2O) in place of the LESCO 10-0-22`);
    // The three tracks carry the same block.
    expect(decOf('bermuda').swaps).toEqual(decOf('st_augustine').swaps);
    expect(decOf('zoysia').swaps).toEqual(decOf('st_augustine').swaps);
  });

  test.each([
    ['one track loses the block', (r) => { delete r.bermuda.visits[11].swaps; }, /bermuda: the December visit has no swaps/],
    ['one track names another bag to replace', (r) => { r.zoysia.visits[11].swaps[SWAP_KEY].replaces = 'LESCO 24-0-11 with PolyPlus OPTI'; }, /zoysia: replaces/],
    ['the line names another product', (r) => { r.st_augustine.visits[11].swaps[SWAP_KEY].primary = r.st_augustine.visits[11].swaps[SWAP_KEY].primary.replace('Black Out 0-0-24', 'Black Out 0-0-25'); }, /the line names/],
    ['the nitrogen target changes', (r) => { r.bermuda.visits[11].swaps[SWAP_KEY].targetN = 0.1; }, /targetN 0\.1/],
    ['the line states other nitrogen', (r) => { r.zoysia.visits[11].swaps[SWAP_KEY].primary = r.zoysia.visits[11].swaps[SWAP_KEY].primary.replace('(0 lb N,', '(0.2 lb N,'); }, /the line does not state 0 lb N|the line differs/],
    ['the December primary is no longer the replaced bag', (r) => { r.st_augustine.visits[11].primary = 'LESCO 24-0-11 with PolyPlus OPTI \u2014 2.1 lb per 1,000 sq ft (0.5 lb N), spreader'; }, /not the bag the swap replaces/],
    ['the trigger changes', (r) => { r.bermuda.visits[11].swaps[SWAP_KEY].trigger.evidence = 'any'; }, /the trigger differs/],
    ['the technician note changes', (r) => { r.zoysia.visits[11].swaps[SWAP_KEY].note = 'Other.'; }, /the technician note differs/],
  ])('drift is caught: %s', (_label, mutate, expected) => {
    const copy = JSON.parse(JSON.stringify(v13));
    mutate(copy);
    expect(swapRecipeProblems(copy).join('\n')).toMatch(expected);
  });

  test('the shared reader hands out the block only while the swap gate is live; gate off, the recipe readers see the old December exactly', () => {
    const { lawnProtocols } = require('../services/lawn-program');
    const names = [...GATES, 'GATE_LAWN_BERMUDA_REMOVAL'];
    try {
      process.env.GATE_LAWN_DEC_LARGE_PATCH_K = 'true';
      expect(lawnProtocols().zoysia.visits[11].swaps[SWAP_KEY]).toBeDefined();
      delete process.env.GATE_LAWN_DEC_LARGE_PATCH_K;
      for (const track of TRACKS) {
        const dec = lawnProtocols()[track].visits[11];
        expect(dec).not.toHaveProperty('swaps');
        const { swaps, ...old } = decOf(track);
        expect(dec).toEqual(old);
        expect(JSON.stringify(dec)).not.toContain('Black Out');
      }
    } finally {
      for (const name of names) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; }
    }
  });

  test('the swapped line classifies like the line it replaces (no disease-gated condition flag, whole-lawn scope): the wording never says "large patch" inline', () => {
    const rule = V13_TROUBLE_PRODUCT_SWAPS[0];
    expect(engine.classifyProtocolLine(rule.line, 'base')).toEqual(engine.classifyProtocolLine(rule.from, 'base'));
    expect(engine.classifyProtocolLine(rule.line, 'base')).toMatchObject({ scope: 'BROADCAST_FULL', conditionFlag: 'none' });
  });

  test('the figures: 4.1 lb of a 24% bag is 0.984 lb K2O (the 10-0-22 gives 0.99); the plan derives 4.125 lb; no nitrogen', () => {
    expect(4.5 * 0.22).toBeCloseTo(0.99, 2);
    expect(4.1 * 0.24).toBeCloseTo(0.99, 1);
    expect(0.99 / 0.24).toBeCloseTo(4.125, 3);
    expect(V13_TROUBLE_PRODUCT_SWAPS[0].line).toBe(`${DEC_K_PRODUCT} — 4.1 lb per 1,000 sq ft (0 lb N, 0.99 lb K2O), spreader, active patch mapped`);
    expect(migration.CATALOG).toMatchObject({ analysis_n: 0, analysis_p: 0, analysis_k: 24, default_rate_per_1000: 4.1 });
  });
});

describe('visitNutrientTargets in December', () => {
  test.each(TRACKS)('%s: active fungus swaps the bag, sets 0 lb N and keeps 0.99 lb K', async (track) => {
    const found = await run({ visit: decOf(track) });
    expect(found.targets).toEqual({ targetNPer1000: 0, targetKPer1000: 0.99 });
    expect(found.nitrogenCut).toBeNull();
    expect(found.productSwap).toBe(V13_TROUBLE_PRODUCT_SWAPS[0]);
    expect(found.visit.primary).toBe(V13_TROUBLE_PRODUCT_SWAPS[0].line);
    // The notes state the new target, keep the normal one in view, and keep every other sentence (fertilizer safety).
    expect(found.visit.notes).toMatch(/^N rate: 0 lb N \(active large patch mapped; normal 0\.45 lb N\)\. K rate: 0\.99 lb K\. Spreader visit\. Fertilizer safety: deflector on/);
    expect(found.visit.secondary).toBe(decOf(track).secondary);
    expect(mockLoadActive).toHaveBeenCalledWith({}, service.property_id);
  });

  test('the swap changes a copy: the recipe visit itself is untouched', async () => {
    const before = JSON.stringify(DEC);
    await run();
    expect(JSON.stringify(DEC)).toBe(before);
  });

  test('gate off: the very same visit object, the same targets, no productSwap key, no area read', async () => {
    delete process.env.GATE_LAWN_DEC_LARGE_PATCH_K;
    const found = await run();
    expect(found).toEqual({ visit: DEC, targets: { targetNPer1000: 0.45, targetKPer1000: 0.99 }, nitrogenCut: null });
    expect(found.visit).toBe(DEC);
    expect(Object.keys(found)).toEqual(['visit', 'targets', 'nitrogenCut']);
    expect(mockLoadActive).not.toHaveBeenCalled();
  });

  test.each(GATES.slice(1))('%s off: unchanged, no read', async (name) => {
    delete process.env[name];
    const found = await run();
    expect(found.productSwap).toBeUndefined();
    expect(found.visit).toBe(DEC);
    expect(mockLoadActive).not.toHaveBeenCalled();
  });

  test('not a v13 plan: unchanged, no read', async () => {
    expect((await run({ v13Active: false })).visit).toBe(DEC);
    expect(mockLoadActive).not.toHaveBeenCalled();
  });

  test.each(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', undefined])('month %s is not December: no swap, no area read', async (month) => {
    const found = await run({ month });
    expect(found.productSwap).toBeUndefined();
    expect(found.visit).toBe(DEC);
    expect(mockLoadActive).not.toHaveBeenCalled();
  });

  test.each([
    ['no mapped area (a resolved area is not returned by the store)', []],
    ['take-all only', [{ type: 'take_all' }]],
    ['weeds, chinch, insects and dry spot', [{ type: 'weeds' }, { type: 'chinch' }, { type: 'other_insect' }, { type: 'dry_spot' }]],
  ])('%s: the 10-0-22 stays, same object', async (_label, areas) => {
    mockLoadActive.mockResolvedValue(areas);
    const found = await run();
    expect(found).toEqual({ visit: DEC, targets: { targetNPer1000: 0.45, targetKPer1000: 0.99 }, nitrogenCut: null });
    expect(found.visit).toBe(DEC);
  });

  test('a failed read, a visit with no property and no visit at all: unchanged; the failure is logged by code only', async () => {
    mockLoadActive.mockRejectedValue(Object.assign(new Error('secret detail 555-0100'), { code: 'ECONNRESET' }));
    expect((await run()).productSwap).toBeUndefined();
    const logged = require('../services/logger').warn.mock.calls.map((call) => call[0]).join(' ');
    expect(logged).toContain('ECONNRESET');
    expect(logged).not.toContain('secret detail');
    mockLoadActive.mockReset().mockResolvedValue([{ type: 'fungus' }]);
    expect((await engine.visitNutrientTargets({}, { id: 'x', property_id: null }, { visit: DEC, month: 'Dec', v13Active: true })).productSwap).toBeUndefined();
    expect((await engine.visitNutrientTargets({}, null, { visit: DEC, month: 'Dec', v13Active: true })).productSwap).toBeUndefined();
    expect((await engine.visitNutrientTargets({}, service, { visit: null, month: 'Dec', v13Active: true })).productSwap).toBeUndefined();
    expect(mockLoadActive).not.toHaveBeenCalled();
  });

  test('a strict read (the brief) throws on a failed area read instead of keeping the 10-0-22', async () => {
    mockLoadActive.mockRejectedValue(Object.assign(new Error('db down'), { code: 'ECONNRESET' }));
    await expect(run({ strict: true })).rejects.toThrow('db down');
  });

  test('a recipe whose December line is not the 10-0-22 is never half-swapped, and reads no area', async () => {
    const other = { ...DEC, primary: 'LESCO 24-0-11 with PolyPlus OPTI — 2.1 lb per 1,000 sq ft (0.5 lb N), spreader' };
    expect((await run({ visit: other })).visit).toBe(other);
    expect(mockLoadActive).not.toHaveBeenCalled();
  });

  test('the November rule is independent: the Dec gate does not cut November, and the Nov gate does not swap December', async () => {
    const nov = v13.st_augustine.visits.find((visit) => visit.month === 'Nov');
    expect((await run({ visit: nov, month: 'Nov' })).nitrogenCut).toBeNull();
    delete process.env.GATE_LAWN_DEC_LARGE_PATCH_K;
    process.env.GATE_LAWN_NOV_LARGE_PATCH_N = 'true';
    try {
      expect((await run()).productSwap).toBeUndefined();
      expect((await run({ visit: nov, month: 'Nov' })).nitrogenCut).toBe(0.5);
    } finally {
      delete process.env.GATE_LAWN_NOV_LARGE_PATCH_N;
    }
  });
});

describe('the swapped line: the amount, the cost, the ordinance checks and the note', () => {
  const swapped = async () => run();
  const mixOf = async (product, row, visitInfo) => engine.calculateProductAmount({
    product, lawnSqft: 10000, areaFactor: 1, ...visitInfo.targets, ...engine.v13RateOptions(row),
  });

  test('the 0-0-24 is sized from the 0.99 lb K2O target: 4.125 lb per 1,000, 41.25 lb on 10,000 sq ft, 0 lb N', async () => {
    const mix = await mixOf(BLACK_OUT, BO_ROW, await swapped());
    expect(mix).toMatchObject({ rateSource: 'target_k_analysis', rateUnit: 'lb', targetKPer1000: 0.99, amountUnit: 'lb' });
    expect(mix.ratePer1000).toBeCloseTo(4.125, 3);
    expect(mix.amount).toBeCloseTo(41.25, 2);
    expect(mix.ratePer1000 * BLACK_OUT.analysis_n / 100).toBe(0);
    expect(mix.ratePer1000 * BLACK_OUT.analysis_k / 100).toBeCloseTo(0.99, 3);
  });

  test('the normal December: the 10-0-22 is sized from the 0.45 lb N target, 4.5 lb per 1,000, the same 0.99 lb K2O', async () => {
    const mix = await mixOf(TEN_22, TEN_ROW, await run({ month: 'Dec', v13Active: false }));
    expect(mix).toMatchObject({ rateSource: 'target_n_analysis', targetNPer1000: 0.45 });
    expect(mix.ratePer1000).toBeCloseTo(4.5, 3);
    expect(mix.ratePer1000 * TEN_22.analysis_k / 100).toBeCloseTo(0.99, 3);
  });

  test('cost: unpriced reads null and counts as missing; once SiteOne $30.06 / 50 lb is entered the 41.25 lb costs $24.80 against $28.63 for the 10-0-22', async () => {
    const found = await swapped();
    const unpriced = await mixOf(BLACK_OUT, BO_ROW, found);
    expect(unpriced).toMatchObject({ materialCost: null, materialCostSource: null });
    expect(engine.summarizeMaterialCost([{ selected: true, product: BLACK_OUT, mix: unpriced }])).toMatchObject({ pricedLineCount: 0, total: 0, missingPriceCount: 1 });

    const priced = { ...BLACK_OUT, best_price: 30.06 };
    const mix = await mixOf(priced, BO_ROW, found);
    expect(mix.materialCost).toBeCloseTo((41.25 * 16 / 800) * 30.06, 1);
    expect(mix.materialCost).toBeCloseTo(24.8, 1);
    expect(engine.summarizeMaterialCost([{ selected: true, product: priced, mix }])).toMatchObject({ pricedLineCount: 1, missingPriceCount: 0 });
    const ten = await mixOf(TEN_22, TEN_ROW, await run({ v13Active: false }));
    expect(ten.materialCost).toBeCloseTo(28.63, 1);
    expect(mix.materialCost).toBeLessThan(ten.materialCost);
  });

  test('North Port and the county windows: the 0-0-24 carries no nitrogen, so the nitrogen block never reads it; the 10-0-22 still does', () => {
    const northPort = { jurisdiction_name: 'North Port', restricted_nitrogen: true, restricted_phosphorus: true, restricted_start_month: 4, restricted_start_day: 1, restricted_end_month: 9, restricted_end_day: 30 };
    const county = { jurisdiction_name: 'Sarasota County', restricted_nitrogen: true, restricted_phosphorus: true, restricted_start_month: 6, restricted_start_day: 1, restricted_end_month: 9, restricted_end_day: 30 };
    const bo = { product: BLACK_OUT };
    const ten = { product: TEN_22 };
    for (const date of [new Date('2027-07-15T16:00:00Z'), new Date('2026-12-15T16:00:00Z')]) {
      for (const rule of [northPort, county]) {
        expect(engine.summarizeOrdinanceStatus({ date, ordinances: [rule], candidateItems: [bo] }).blocks).toEqual([]);
      }
    }
    // The 10-0-22 inside a window is a nitrogen block (December itself is outside every window).
    expect(engine.summarizeOrdinanceStatus({ date: new Date('2027-07-15T16:00:00Z'), ordinances: [northPort], candidateItems: [ten] }).blocks.map((b) => b.code)).toEqual(['nitrogen_blackout']);
    expect(engine.summarizeOrdinanceStatus({ date: new Date('2026-12-15T16:00:00Z'), ordinances: [northPort, county], candidateItems: [ten] }).blocks).toEqual([]);
  });

  test('the staged row has no North Port hold and no nitrogen gate keys; its trigger names the condition', () => {
    expect(migration.NEW_GATES).toEqual({ targetK: '0.99 lb K2O/1000', trigger: 'active_large_patch_mapped' });
    expect(engine.v13GateNotes(BO_ROW.gates, { municipality: 'North Port' })).toEqual([]);
    expect(engine.v13RowCalculates({ applicationMode: 'broadcast', ratePer1000: null, rateUnit: 'lb_k' })).toBe(true);
  });

  test('productSwapNotes: the note rides the swapped product only, and nothing for a lawn that was not swapped', async () => {
    const { productSwap } = await swapped();
    expect(engine.productSwapNotes(BLACK_OUT, productSwap)).toEqual([{ key: PRODUCT_SWAP_NOTE_KEY, severity: 'note', text: productSwap.note }]);
    expect(productSwap.note).toBe('Active large patch mapped: potassium-only bag, no nitrogen (4.1 lb per 1,000 sq ft = 0.99 lb K2O). Used in place of the LESCO 10-0-22.');
    expect(engine.productSwapNotes(TEN_22, productSwap)).toEqual([]);
    expect(engine.productSwapNotes(BLACK_OUT, undefined)).toEqual([]);
    expect(engine.productSwapNotes(null, productSwap)).toEqual([]);
  });
});

describe('the customer watering text still goes out', () => {
  const RULES = require('./fixtures/lawn-watering-rules-v13-2026-10-22.json');
  const { rulesForTargets } = require('../services/service-report/lawn-watering-rule');
  const { buildWateringInstruction } = require('../services/service-report/lawn-watering-instruction');

  test('the rule is the granular fertilizer rule (0.25 inch within 24 hours), valid and owner-sourced; the fixture carries the same rule', () => {
    const checked = validateRule(migration.WATERING_RULE);
    expect(checked.errors).toEqual([]);
    expect(checked.rule).toMatchObject({ mode: 'water_in', water_in_inches: 0.25, water_in_by_hours: 24, source: 'owner' });
    expect(migration.WATERING).toEqual([{ name: DEC_K_PRODUCT, rule: migration.WATERING_RULE }]);
    const { mode, water_in_inches: inches, water_in_by_hours: hours, source } = migration.WATERING_RULE;
    expect(RULES[DEC_K_PRODUCT]).toEqual({ mode, water_in_inches: inches, water_in_by_hours: hours, source });
    // The same rule as the 10-0-22 it replaces on this visit.
    expect(RULES[DEC_K_PRODUCT]).toEqual({ mode: RULES[DEC_FROM].mode, water_in_inches: RULES[DEC_FROM].water_in_inches, water_in_by_hours: RULES[DEC_FROM].water_in_by_hours, source: RULES[DEC_FROM].source });
  });

  test('the report freezes the product as an approved fertilizer with its watering rule and customer copy', () => {
    const facts = approvedReportProductFacts({ ...migration.CATALOG, post_application_watering: migration.WATERING_RULE });
    expect(facts).toMatchObject({ productType: 'fertilizer', name: DEC_K_PRODUCT, epaRegNumber: null, serviceReportSummary: migration.SUMMARY, precautionSummary: migration.PRECAUTION });
    expect(facts.wateringRule).toMatchObject({ mode: 'water_in', water_in_inches: 0.25, water_in_by_hours: 24 });
  });

  test('the swapped December visit (0-0-24 alone, and with any of the visit\'s other products) gets a watering text at a daytime completion', () => {
    const others = [...new Set(DEC.secondary.split('\n').map((line) => line.split(' \u2014 ')[0].trim()).filter(Boolean))];
    expect(others.length).toBeGreaterThan(2);
    for (const extra of [[], ...others.map((name) => [name]), others]) {
      const rules = [DEC_K_PRODUCT, ...extra].flatMap((name) => rulesForTargets(validateRule(RULES[name]).rule, []).map((rule) => ({ name, rule })));
      for (const completedAt of ['2026-12-15T15:00:00Z', '2026-12-15T21:00:00Z']) {
        const ins = buildWateringInstruction({ rules, completedAt, plainWhenNoSetup: true, labelFirst: true });
        expect(ins.state).toBeTruthy();
        expect(ins.lines.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('a skipped swapped-in bag is recorded like a skipped default (lawn-protocol-completion)', () => {
  const { partitionSkippedProducts } = require('../services/lawn-protocol-completion');
  const structured = { products: [{ productId: 't22', defaultInPlan: true }, { productId: 'bo', defaultInPlan: false }] };
  const skipped = { skippedProducts: [{ productId: 'bo', productName: DEC_K_PRODUCT }] };
  const planWith = (item) => ({ mixCalculator: { items: [item] } });

  test('the swapped-in bag the plan selected is a visit default, so its skip is a skipped actual', () => {
    const result = partitionSkippedProducts(skipped, planWith({ selected: true, product: { id: 'bo' }, productSwapIn: true }), structured, true);
    expect(result.skipped).toHaveLength(1);
    expect(result.unlisted).toEqual([]);
  });

  test('the same non-default row without the swap flag is still not a default: its skip stays unlisted (nothing loosened)', () => {
    const result = partitionSkippedProducts(skipped, planWith({ selected: true, product: { id: 'bo' } }), structured, true);
    expect(result.skipped).toEqual([]);
    expect(result.unlisted).toEqual([{ productId: 'bo', productName: DEC_K_PRODUCT }]);
  });
});
