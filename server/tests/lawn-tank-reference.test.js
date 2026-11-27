// The tank sheet's fill amounts (lawn-tank-reference.js): amount = rate per 1,000 sq ft x (tank gallons / carrier gal per
// 1,000 sq ft), the carrier from the line's own spray volume, else the sprayer's last calibration. Pure functions, no database.
const { tankReference, sprayerTestWarning, lineCarrierGalPer1000 } = require('../services/lawn-tank-reference');

const TANK = { equipment_system_id: 'tank', system_name: 'Fixture tank', system_type: 'tank', carrier_gal_per_1000: 2, tank_capacity_gal: 110 };
const BACKPACK = { equipment_system_id: 'bp', system_name: 'FlowZone fixture backpack', system_type: 'backpack', carrier_gal_per_1000: 1.33, tank_capacity_gal: 4 };
const conditional = (raw) => ({ raw, role: 'conditional', conditional: true });

describe('the spray volume a protocol line fixes', () => {
  test.each([
    ['Arena 50 WDG — chinch, 0.147 oz per 1,000 sq ft (6.4 oz per acre) in 4 gal per 1,000 sq ft into the thatch', 4],
    ['Velista — mapped large patch at 2 gal per 1,000 sq ft, with Artavia', 2],
    ['Headway Fungicide — take-all, 3 fl oz per 1,000 sq ft in 5 gal of water, 30 days after the first', 5],
    ['Arena — 0.29 oz per 1,000 sq ft in 4 gal of water per 1,000 sq ft', 4],
    ['Celsius WG — weed spots, 0.085 oz per 1,000 sq ft in the weed mix, mornings', null],
    [null, null],
  ])('%s', (raw, gallons) => {
    expect(lineCarrierGalPer1000(raw)).toBe(gallons);
  });
});

describe('fill amounts', () => {
  test('a small dry amount is also in grams, a small liquid amount also in mL', () => {
    const certainty = tankReference({ product: { name: 'Certainty', default_rate_per_1000: 0.028, rate_unit: 'oz', mixing_order_category: 'dry_wg_wdg_wp_df' }, item: conditional('Certainty — weed spots'), backpack: BACKPACK });
    expect(certainty.backpack4Gal).toMatchObject({ amount: 0.084, amountUnit: 'oz', metricAmount: 2.4, metricUnit: 'g' });
    const acelepryn = tankReference({ product: { name: 'Acelepryn', default_rate_per_1000: 0.046, rate_unit: 'fl oz', mixing_order_category: 'liquid_flowable_sc' }, item: conditional('Acelepryn — caterpillars'), backpack: BACKPACK });
    expect(acelepryn.backpack4Gal).toMatchObject({ amount: 0.138, amountUnit: 'fl oz', metricAmount: 4.1, metricUnit: 'mL' });
  });

  test('a 2.5 gal jug goes in the big tank even on a conditional line: 100 gal, the full 110 gal tank, and the FlowZone', () => {
    const jug = tankReference({ product: { name: 'Jug fungicide', container_size: '2.5 gal', default_rate_per_1000: 0.77, rate_unit: 'fl oz', mixing_order_category: 'liquid_flowable_sc' }, item: conditional('Jug fungicide — spots'), rig: TANK, backpack: BACKPACK });
    expect(jug).toMatchObject({
      bigTank: true,
      per100Gal: { gallons: 100, amount: 38.5, carrierGalPer1000: 2 },
      fullTank: { gallons: 110, amount: 42.35 },
      backpack4Gal: { gallons: 4, amount: 2.316 },
    });
  });

  test('a backpack picked as the rig gives no 100 gal amount; a missing FlowZone test is named', () => {
    const product = { name: 'Liquid', default_rate_per_1000: 1, rate_unit: 'fl oz', mixing_order_category: 'liquid_fertilizer' };
    const onBackpack = tankReference({ product, item: { raw: 'Liquid', role: 'base' }, rig: BACKPACK, backpack: BACKPACK });
    expect(onBackpack).toMatchObject({ bigTank: true, per100Gal: null, fullTank: null, backpack4Gal: { amount: 3.008 } });
    expect(tankReference({ product, item: conditional('Liquid'), rig: TANK, backpack: null })).toMatchObject({ backpack4Gal: null, backpackMissing: true });
  });
});

describe('the rate a recipe line states', () => {
  const arena = { name: 'Arena 50 WDG', default_rate_per_1000: 0.29, rate_unit: 'oz', mixing_order_category: 'dry_wg_wdg_wp_df' };
  const raw = 'Arena 50 WDG — chinch bugs found at the edge of a damaged patch (count first), 0.147 oz per 1,000 sq ft (6.4 oz per acre) in 4 gal per 1,000 sq ft into the thatch';
  test('a label-rate row or no row takes the recipe line\'s rate, not the catalog default', () => {
    for (const v13Line of [{ row: { applicationMode: 'spot', ratePer1000: null, rateUnit: 'label_rate', gates: {} }, state: 'spot' }, undefined]) {
      expect(tankReference({ product: arena, item: conditional(raw), v13Line, backpack: BACKPACK })).toMatchObject({
        ratePer1000: 0.147, rateSource: 'recipe_line_rate', backpack4Gal: { amount: 0.147, carrierGalPer1000: 4 },
      });
    }
  });
  test('a staged row rate outranks the line, and a range states no one rate', () => {
    const row = { applicationMode: 'spot', ratePer1000: 0.2, rateUnit: 'oz', gates: {} };
    expect(tankReference({ product: arena, item: conditional(raw), v13Line: { row, state: 'spot' } })).toMatchObject({ ratePer1000: 0.2, rateSource: 'protocol_rate' });
    const velista = { name: 'Velista', default_rate_per_1000: 0.5, rate_unit: 'oz', mixing_order_category: 'dry_wg_wdg_wp_df' };
    expect(tankReference({ product: velista, item: conditional('Velista — fairy ring, 0.5 to 0.7 oz per 1,000 sq ft every 14 to 21 days') }))
      .toMatchObject({ ratePer1000: 0.5, rateSource: 'catalog_default_rate' });
  });
});

describe('a several-use line and a hand-shaker bait', () => {
  const VELISTA_OCT = 'Velista — mapped large patch at 2 gal per 1,000 sq ft, with Artavia on a lawn mapped for large patch alone; fairy ring, 0.5 to 0.7 oz per 1,000 sq ft every 14 to 21 days, with a wetting agent; dollar spot on bermuda and zoysia, 0.3 to 0.5 oz per 1,000 sq ft';
  const velista = { name: 'Velista', default_rate_per_1000: 0.5, rate_unit: 'oz', mixing_order_category: 'dry_wg_wdg_wp_df' };
  test('October Velista: 2 gal per 1,000 sq ft is the large patch use\'s own fill; the other uses take the sprayer\'s volume', () => {
    const ref = tankReference({ product: velista, item: conditional(VELISTA_OCT), backpack: BACKPACK });
    expect(ref).toMatchObject({ fixedCarrierGalPer1000: null, backpack4Gal: { amount: 1.504, carrierGalPer1000: 1.33, carrierSource: 'calibration' } });
    expect(ref.useFills).toEqual([expect.objectContaining({ use: 'mapped large patch', carrierGalPer1000: 2, backpack4Gal: expect.objectContaining({ amount: 1, carrierSource: 'line' }) })]);
    // The volume check names the use it applies to; the general fill on the sprayer's own volume gets none.
    expect(ref.volumeChecks).toEqual([{ use: 'mapped large patch', sprayerName: 'FlowZone fixture backpack', labelGalPer1000: 2, testedGalPer1000: 1.33, passes: null, otherSprayerName: null }]);
  });
  test('a one-use line keeps its volume for the whole line (Arena: the clause after it is a note)', () => {
    const arena = { name: 'Arena', default_rate_per_1000: 0.29, rate_unit: 'oz', mixing_order_category: 'dry_wg_wdg_wp_df' };
    const ref = tankReference({ product: arena, item: conditional('Arena 50 WDG — chinch, 0.147 oz per 1,000 sq ft in 4 gal per 1,000 sq ft, recheck at 5 and 12 days; a second application no sooner than 8 weeks later'), backpack: BACKPACK });
    expect(ref).toMatchObject({ fixedCarrierGalPer1000: 4, useFills: [], backpack4Gal: { amount: 0.147 } });
  });
  test('a SKIP line (the plan\'s inspection-only scope) gets no fill at all', () => {
    const kflow = { name: 'K-Flow', default_rate_per_1000: 3, rate_unit: 'fl oz', mixing_order_category: 'liquid_fertilizer', container_size: '2.5 gal' };
    const ref = tankReference({ product: kflow, item: { raw: 'IF soil K >80 ppm: SKIP K-Flow', role: 'conditional', conditional: true, scope: 'INSPECTION_ONLY' }, rig: TANK, backpack: BACKPACK });
    expect(ref).toMatchObject({ skipped: true, per100Gal: null, fullTank: null, backpack4Gal: null, useFills: [], volumeChecks: [], backpackMissing: false });
  });
  test('a bait the line puts down by hand shaker is a hand-shaker card; another granular is a spreader', () => {
    const advion = { name: 'Advion Insect Granule', default_rate_per_1000: 3, rate_unit: 'lb' };
    expect(tankReference({ product: advion, item: conditional('Advion Insect Granule — mole cricket spots, 3 lb per 1,000 sq ft of treated area by hand shaker') }))
      .toMatchObject({ application: 'spreader', applicator: 'hand_shaker', ratePer1000: 3 });
    expect(tankReference({ product: advion, item: conditional('Topchoice — 2 lb per 1,000 sq ft with a spreader') })).toMatchObject({ applicator: 'spreader' });
  });
});

describe('a fixed volume the sprayer test does not put out, and the Celsius heat rule', () => {
  const arena = { name: 'Arena', default_rate_per_1000: 0.29, rate_unit: 'oz', mixing_order_category: 'dry_wg_wdg_wp_df' };
  test('Arena at 4 gal per 1,000 sq ft on a tank tested at 2 and a FlowZone at 1.33: one check per sprayer, the amounts stay', () => {
    const item = { raw: 'Arena 50 WDG — chinch, 0.147 oz per 1,000 sq ft in 4 gal per 1,000 sq ft', role: 'base', conditional: false };
    const ref = tankReference({ product: arena, item, rig: TANK, backpack: BACKPACK });
    // Whole passes at or under the label volume, within 5% below it (3 x 1.33 = 3.99 of 4).
    expect(ref.volumeChecks).toEqual([
      { use: null, sprayerName: 'Fixture tank', labelGalPer1000: 4, testedGalPer1000: 2, passes: 2, otherSprayerName: null },
      { use: null, sprayerName: 'FlowZone fixture backpack', labelGalPer1000: 4, testedGalPer1000: 1.33, passes: 3, otherSprayerName: null },
    ]);
    // Passes only when that many land within 5% of the label volume; a sprayer that puts out more never gets one.
    const passes = (label, tested) => tankReference({ product: arena, item: { ...item, raw: `Arena — 0.147 oz per 1,000 sq ft in ${label} gal per 1,000 sq ft` },
      rig: { ...TANK, carrier_gal_per_1000: tested } }).volumeChecks[0].passes;
    // Never over the label volume (4 on 2.09: two passes put down 4.18), never far under (2 on 1.33).
    expect([passes(4, 2), passes(4, 1.33), passes(2, 1.33), passes(2, 4), passes(4, 2.09), passes(4, 1.9)]).toEqual([2, 3, null, null, null, 2]);
    // The other sprayer is named only when its test puts out the label volume.
    const atTwo = tankReference({ product: arena, item: { ...item, raw: 'Arena — 0.147 oz per 1,000 sq ft in 2 gal per 1,000 sq ft' }, rig: TANK, backpack: BACKPACK });
    expect(atTwo.volumeChecks).toEqual([expect.objectContaining({ sprayerName: 'FlowZone fixture backpack', passes: null, otherSprayerName: 'Fixture tank' })]);
    expect(tankReference({ product: arena, item: { ...item, raw: 'Arena — 0.147 oz per 1,000 sq ft in 1 gal per 1,000 sq ft' }, rig: TANK }).volumeChecks)
      .toEqual([{ use: null, sprayerName: 'Fixture tank', labelGalPer1000: 1, testedGalPer1000: 2, passes: null, otherSprayerName: null }]);
    expect(ref).toMatchObject({ per100Gal: { amount: 3.675, carrierSource: 'line' }, backpack4Gal: { amount: 0.147 } });
    // The sprayer's own volume needs no check; neither does a line volume the sprayer was tested at.
    expect(tankReference({ product: arena, item: { ...item, raw: 'Arena — 0.147 oz per 1,000 sq ft' }, rig: TANK, backpack: BACKPACK }).volumeChecks).toEqual([]);
    expect(tankReference({ product: arena, item: { ...item, raw: 'Arena — 0.147 oz per 1,000 sq ft in 2 gal per 1,000 sq ft' }, rig: TANK }).volumeChecks).toEqual([]);
  });
  test('a surfactant in the Celsius mix carries the Celsius label rule from the weed mix; another adjuvant does not', () => {
    const { SURFACTANT_CHECK_NOTE } = require('../services/lawn-weed-mix');
    const nis = { name: 'Surfactant', default_rate_per_1000: 0.25, rate_unit: 'fl oz', mixing_order_category: 'adjuvant_last' };
    const row = { applicationMode: 'spot', gates: { tankMixWith: 'Celsius WG', concentration: '0.25% v/v' } };
    const ref = tankReference({ product: nis, item: conditional('Surfactant — with Celsius'), v13Line: { row, state: 'spot' }, backpack: BACKPACK });
    expect(ref.surfactantNote).toBe(SURFACTANT_CHECK_NOTE);
    expect(SURFACTANT_CHECK_NOTE).toMatch(/90°F/);
    const other = tankReference({ product: nis, item: conditional('Surfactant'), v13Line: { row: { ...row, gates: { ...row.gates, tankMixWith: 'Talak' } }, state: 'spot' }, backpack: BACKPACK });
    expect(other.surfactantNote).toBeNull();
  });
});

describe('the carrier the job calculation already uses', () => {
  const dimension = { name: 'Dimension 2EW', default_rate_per_1000: 0.5, rate_unit: 'fl oz', mixing_order_category: 'ec_ew' };
  test('the spring catch-up hose pass sizes on its row carrier (1 gal), not the rig at 2 gal, as roundsCatchUp.carrierFor does', () => {
    const item = { raw: 'Dimension 2EW — spring pre-emergent catch-up, hose', role: 'conditional', conditional: true, roundsCatchUp: true };
    const row = { applicationMode: 'broadcast', ratePer1000: 0.5, rateUnit: 'fl oz', carrierGalPer1000: 1 };
    const ref = tankReference({ product: dimension, item, v13Line: { row, state: 'calculate' }, rig: TANK, backpack: BACKPACK });
    // A fill sized on the row names no sprayer; one sized on a test names that unit.
    expect(ref.backpack4Gal.sprayerName).toBeNull();
    expect(ref).toMatchObject({
      fixedCarrierGalPer1000: 1, fixedCarrierSource: 'row',
      per100Gal: { amount: 50, carrierGalPer1000: 1, carrierSource: 'row' },
      fullTank: { gallons: 110, amount: 55 },
      backpack4Gal: { amount: 2, carrierSource: 'row' },
    });
    // The same line off the catch-up takes the rig: half the fill.
    const plain = tankReference({ product: dimension, item: { ...item, roundsCatchUp: false }, v13Line: { row, state: 'calculate' }, rig: TANK, backpack: BACKPACK });
    expect(plain.per100Gal).toMatchObject({ amount: 25, carrierSource: 'calibration' });
  });

  test('a spot row with its own rate sizes on its row carrier (as the job card doses it); a label-rate spot row takes the sprayer', () => {
    const talak = { name: 'Talak', default_rate_per_1000: 0.5, rate_unit: 'fl oz', mixing_order_category: 'liquid_flowable_sc' };
    const item = conditional('Talak — chinch second product');
    const stated = tankReference({ product: talak, item, v13Line: { row: { applicationMode: 'spot', ratePer1000: 1, rateUnit: 'fl oz', carrierGalPer1000: 4 }, state: 'spot' }, rig: TANK, backpack: BACKPACK });
    expect(stated).toMatchObject({ fixedCarrierSource: 'row', backpack4Gal: { amount: 1, carrierGalPer1000: 4, carrierSource: 'row' } });
    const labelRate = tankReference({ product: talak, item, v13Line: { row: { applicationMode: 'spot', ratePer1000: null, rateUnit: 'label_rate', carrierGalPer1000: 4 }, state: 'spot' }, rig: TANK, backpack: BACKPACK });
    expect(labelRate).toMatchObject({ fixedCarrierSource: null, backpack4Gal: { amount: 1.504, carrierGalPer1000: 1.33, carrierSource: 'calibration' } });
  });

  test('a limit or a hold on that spot row changes only the plan state, never its carrier or dose', () => {
    const talak = { name: 'Talak', default_rate_per_1000: 0.5, rate_unit: 'fl oz', mixing_order_category: 'liquid_flowable_sc' };
    const row = { applicationMode: 'spot', ratePer1000: 1, rateUnit: 'fl oz', carrierGalPer1000: 4 };
    const fills = ['spot', 'capped', 'held'].map((state) => tankReference({ product: talak, item: conditional('Talak — chinch'), v13Line: { row, state }, rig: TANK, backpack: BACKPACK }));
    for (const ref of fills) expect(ref).toMatchObject({ fixedCarrierSource: 'row', backpack4Gal: { amount: 1, carrierGalPer1000: 4 } });
    expect(fills.map((ref) => ref.planState)).toEqual(['spot', 'capped', 'held']);
  });

  test('a backpack picked as the rig gives no 100 gal fill even when the line fixes the volume or is a percent of the spray', () => {
    const product = { name: 'Jug fungicide', container_size: '2.5 gal', default_rate_per_1000: 3, rate_unit: 'fl oz', mixing_order_category: 'liquid_flowable_sc' };
    const fixed = tankReference({ product, item: conditional('Jug fungicide — 3 fl oz per 1,000 sq ft in 5 gal of water'), rig: BACKPACK, backpack: BACKPACK });
    expect(fixed).toMatchObject({ bigTank: true, per100Gal: null, fullTank: null, backpack4Gal: { amount: 2.4, carrierSource: 'line' } });
    const nis = { name: 'Surfactant', default_rate_per_1000: 0.25, rate_unit: 'fl oz', mixing_order_category: 'adjuvant_last', container_size: '2.5 gal' };
    const percent = tankReference({ product: nis, item: conditional('Surfactant — 0.25% of the spray volume'), rig: BACKPACK, backpack: BACKPACK });
    expect(percent).toMatchObject({ per100Gal: null, fullTank: null, backpack4Gal: { amount: 1.28, carrierSource: 'concentration' } });
  });
});

describe('the sprayer test warning', () => {
  const now = new Date('2026-11-27T15:00:00Z');
  test('overdue and estimated: one line naming the sprayer, the last test date and its carrier', () => {
    expect(sprayerTestWarning({ ...TANK, calibration_status: 'estimated', calibrated_at: '2026-09-07T14:00:00Z', expires_at: '2026-10-07T14:00:00Z' }, { code: 'x', now }).message)
      .toBe('Sprayer test overdue: Fixture tank last tested 2026-09-07 at 2 gal per 1,000 sq ft (estimated, not field tested). Amounts below assume that. Test the sprayer again.');
  });
  test('no status on file warns that the field test is not on file', () => {
    expect(sprayerTestWarning({ ...TANK, calibration_status: null, expires_at: '2026-12-07T14:00:00Z' }, { code: 'x', now }).message)
      .toBe('Sprayer not field tested: Fixture tank at 2 gal per 1,000 sq ft (field test not on file). Amounts below assume that. Test the sprayer.');
  });
  test('a current field-verified test, no calibration and a zero carrier warn nothing', () => {
    expect(sprayerTestWarning({ ...TANK, calibration_status: 'field_verified', expires_at: '2026-12-07T14:00:00Z' }, { code: 'x', now })).toBeNull();
    expect(sprayerTestWarning(null, { code: 'x', now })).toBeNull();
    expect(sprayerTestWarning({ ...TANK, carrier_gal_per_1000: 0, expires_at: '2026-10-07T14:00:00Z' }, { code: 'x', now })).toBeNull();
  });
});
