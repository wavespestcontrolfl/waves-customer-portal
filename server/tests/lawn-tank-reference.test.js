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
    expect(ref.volumeChecks).toEqual([{ use: 'mapped large patch', sprayerName: 'FlowZone fixture backpack', labelGalPer1000: 2, sprayerGalPer1000: 1.33 }]);
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
  test('Arena at 4 gal per 1,000 sq ft on a tank at 2 and a FlowZone at 1.33: one check per sprayer number, no pass counts, the amounts stay', () => {
    const item = { raw: 'Arena 50 WDG — chinch, 0.147 oz per 1,000 sq ft in 4 gal per 1,000 sq ft', role: 'base', conditional: false };
    const ref = tankReference({ product: arena, item, rig: TANK, backpack: BACKPACK });
    // One check per sprayer, with its name and number; never a pass count (owner 2026-11-27).
    expect(ref.volumeChecks).toEqual([
      { use: null, sprayerName: 'Fixture tank', labelGalPer1000: 4, sprayerGalPer1000: 2 },
      { use: null, sprayerName: 'FlowZone fixture backpack', labelGalPer1000: 4, sprayerGalPer1000: 1.33 },
    ]);
    expect(tankReference({ product: arena, item: { ...item, raw: 'Arena — 0.147 oz per 1,000 sq ft in 1 gal per 1,000 sq ft' }, rig: TANK }).volumeChecks)
      .toEqual([{ use: null, sprayerName: 'Fixture tank', labelGalPer1000: 1, sprayerGalPer1000: 2 }]);
    expect(ref).toMatchObject({ per100Gal: { amount: 3.675, carrierSource: 'line' }, backpack4Gal: { amount: 0.147 } });
    // The sprayer's own volume needs no check; neither does a line volume the sprayer was tested at.
    expect(tankReference({ product: arena, item: { ...item, raw: 'Arena — 0.147 oz per 1,000 sq ft' }, rig: TANK, backpack: BACKPACK }).volumeChecks).toEqual([]);
    expect(tankReference({ product: arena, item: { ...item, raw: 'Arena — 0.147 oz per 1,000 sq ft in 2 gal per 1,000 sq ft' }, rig: TANK }).volumeChecks).toEqual([]);
  });
  test('a spot product with a per-gallon label rate fills the FlowZone at that rate x 4, never on its gal per 1,000 (owner 2026-11-27)', () => {
    const spotItem = conditional('Spot product — spot spray the trouble spots');
    const perGallon = { name: 'Spot product', default_rate: '0.2-0.8', default_unit: 'fl_oz/gal', mixing_order_category: 'liquid_ec' };
    const ref = tankReference({ product: perGallon, item: spotItem, rig: TANK, backpack: { ...BACKPACK, carrier_gal_per_1000: 2 } });
    expect(ref.backpack4Gal).toMatchObject({ gallons: 4, amount: 0.8, amountMax: 3.2, amountUnit: 'fl_oz', carrierSource: 'label_per_gallon', carrierGalPer1000: null, sprayerName: null });
    // The line's own declared label rate per gallon wins (lineMeta, for the product's EPA number).
    const declared = { ...perGallon, epa_reg_number: '100-1' };
    const lineMeta = { labelRatePerGallon: { amount: 0.5, unit: 'fl_oz', epa: '100-1' } };
    const viaMeta = tankReference({ product: declared, item: spotItem, rig: TANK, backpack: BACKPACK, lineMeta });
    expect(viaMeta.backpack4Gal).toMatchObject({ amount: 2, amountMax: null, carrierSource: 'label_per_gallon' });
    // A weaker-mix line held for this product (another EPA number) gets no FlowZone dose at all, with the hold's reason.
    const weaker = { labelRatePerGallon: { amount: 0.66, unit: 'fl_oz', epa: '100-1', weakerMix: true } };
    const held = tankReference({ product: { ...perGallon, epa_reg_number: '200-2' }, item: spotItem, rig: TANK, backpack: BACKPACK, lineMeta: weaker });
    expect(held).toMatchObject({ backpack4Gal: null, backpackMissing: false, volumeChecks: [] });
    expect(held.labelRateHold).toMatch(/^The card's rate is for EPA 100-1\..*read the bottle's label before mixing$/);
    expect(tankReference({ product: declared, item: spotItem, rig: TANK, backpack: BACKPACK, lineMeta: { labelRatePerGallon: { ...weaker.labelRatePerGallon } } }))
      .toMatchObject({ labelRateHold: null, backpack4Gal: { amount: 2.64, carrierSource: 'label_per_gallon' } });
    // The hold covers a big-tank line too: no 100 gal, full-tank or per-use fill, only the hold's reason.
    const broadcast = { raw: 'Spot product — 0.5 fl oz per 1,000 sq ft', role: 'base', conditional: false };
    const heldTank = tankReference({ product: { name: 'Spot product', default_rate_per_1000: 0.5, rate_unit: 'fl oz', mixing_order_category: 'liquid_ec', epa_reg_number: '200-2' }, item: broadcast, rig: TANK, backpack: BACKPACK, lineMeta: weaker });
    expect(heldTank).toMatchObject({ per100Gal: null, fullTank: null, backpack4Gal: null, useFills: [], volumeChecks: [], labelRateHold: held.labelRateHold });
    expect(tankReference({ product: { name: 'Spot product', default_rate_per_1000: 0.5, rate_unit: 'fl oz', mixing_order_category: 'liquid_ec' }, item: broadcast, rig: TANK }).per100Gal).toMatchObject({ amount: expect.any(Number) });
    // A label rate stated over its own spray volume keeps it: the FlowZone fill names it, and a FlowZone on another number gets a check.
    const withVolume = { labelRatePerGallon: { amount: 2, unit: 'fl_oz', epa: '100-1', carrierGalPer1000: 1 } };
    const stated = tankReference({ product: declared, item: spotItem, rig: TANK, backpack: { ...BACKPACK, carrier_gal_per_1000: 2 }, lineMeta: withVolume });
    expect(stated.backpack4Gal).toMatchObject({ amount: 8, carrierGalPer1000: 1, carrierSource: 'label_per_gallon' });
    expect(stated.volumeChecks).toEqual([{ use: null, sprayerName: 'FlowZone fixture backpack', labelGalPer1000: 1, sprayerGalPer1000: 2 }]);
    // A small band shows no metric (one figure would read as the whole band); a small single rate converts.
    const smallBand = tankReference({ product: { ...perGallon, default_rate: '0.05-0.1' }, item: spotItem, rig: TANK, backpack: BACKPACK }).backpack4Gal;
    expect(smallBand).toMatchObject({ amount: 0.2, amountMax: 0.4 });
    expect(smallBand.metricAmount).toBeUndefined();
    expect(tankReference({ product: { ...perGallon, default_rate: '0.05' }, item: spotItem, rig: TANK, backpack: BACKPACK }).backpack4Gal)
      .toMatchObject({ amount: 0.2, amountMax: null, metricAmount: 5.9, metricUnit: 'mL' });
    // A line with a rate per 1,000 sq ft keeps the area math on the FlowZone's number.
    const area = tankReference({ product: { ...perGallon, default_rate_per_1000: 0.085, rate_unit: 'oz' }, item: conditional('Spot product — 0.085 oz per 1,000 sq ft'), rig: TANK, backpack: BACKPACK });
    expect(area.backpack4Gal).toMatchObject({ carrierSource: 'calibration', carrierGalPer1000: 1.33 });
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
  test('a number with no expiry (owner 2026-11-27) is a neutral note, never "overdue" or "test again"; an old past expiry still warns', () => {
    const tank1 = { ...TANK, system_name: '110-Gallon Spray Tank #1', calibration_status: 'field_verified', expires_at: null, verification_notes: 'Set from Tank Counts over 3 fills.' };
    expect(sprayerTestWarning(tank1, { code: 'x', noteCode: 'n', now })).toEqual({ code: 'n', severity: 'note', equipmentSystemId: 'tank', message: '110-Gallon Spray Tank #1: 2 gal per 1,000 sq ft, from tank counts.' });
    // "From tank counts" only when the row's notes record tank counts; another field test with no expiry says field test, at its own number.
    expect(sprayerTestWarning({ ...tank1, carrier_gal_per_1000: '1.750', verification_notes: 'Measured over a 1,000 sq ft test area.' }, { code: 'x', noteCode: 'n', now }).message)
      .toBe('110-Gallon Spray Tank #1: 1.75 gal per 1,000 sq ft, field test.');
    expect(sprayerTestWarning({ ...tank1, verification_notes: null }, { code: 'x', noteCode: 'n', now }).message).toBe('110-Gallon Spray Tank #1: 2 gal per 1,000 sq ft, field test.');
    const flowZone = { ...BACKPACK, system_name: 'FlowZone Typhoon 3.0 #1', carrier_gal_per_1000: '2.000', calibration_status: 'owner_estimate', expires_at: null };
    expect(sprayerTestWarning(flowZone, { code: 'x', noteCode: 'n', now }).message).toBe('FlowZone Typhoon 3.0 #1: 2 gal per 1,000 sq ft, owner estimate.');
    // Tank #2 after 20261127290000 (owner 2026-11-27): the line reads the row's own number.
    const tank2 = { ...TANK, system_name: 'Udor KAPPA-18/12V-HP + 110-gal tank #2 - Lawn Gun', carrier_gal_per_1000: '4.000', calibration_status: 'owner_estimate', expires_at: null };
    expect(sprayerTestWarning(tank2, { code: 'x', noteCode: 'n', now }).message).toBe('Udor KAPPA-18/12V-HP + 110-gal tank #2 - Lawn Gun: 4 gal per 1,000 sq ft, owner estimate.');
    for (const status of ['field_verified', 'owner_estimate', 'estimated', null]) {
      expect(sprayerTestWarning({ ...TANK, calibration_status: status, expires_at: null }, { code: 'x', now })?.message || '').not.toMatch(/overdue|again/i);
    }
    expect(sprayerTestWarning({ ...flowZone, expires_at: '2026-10-07T14:00:00Z' }, { code: 'x', now }).message).toMatch(/^Sprayer test overdue: .*Test the sprayer again\.$/);
  });
  test('a current field-verified test, no calibration and a zero carrier warn nothing', () => {
    expect(sprayerTestWarning({ ...TANK, calibration_status: 'field_verified', expires_at: '2026-12-07T14:00:00Z' }, { code: 'x', now })).toBeNull();
    expect(sprayerTestWarning(null, { code: 'x', now })).toBeNull();
    expect(sprayerTestWarning({ ...TANK, carrier_gal_per_1000: 0, expires_at: '2026-10-07T14:00:00Z' }, { code: 'x', now })).toBeNull();
  });
});
