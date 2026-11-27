// The tank sheet's fill amounts (lawn-tank-reference.js): amount = rate per 1,000 sq ft x (tank gallons / carrier gal per
// 1,000 sq ft), the carrier from the line's own spray volume, else the sprayer's last calibration. Pure functions, no database.
const { tankReference, sprayerTestWarning, lineCarrierGalPer1000 } = require('../services/lawn-tank-reference');

const TANK = { equipment_system_id: 'tank', system_name: 'Fixture tank', system_type: 'tank', carrier_gal_per_1000: 2, tank_capacity_gal: 110 };
const BACKPACK = { equipment_system_id: 'bp', system_name: 'Fixture backpack', system_type: 'backpack', carrier_gal_per_1000: 1.33, tank_capacity_gal: 4 };
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

describe('the sprayer test warning', () => {
  const now = new Date('2026-11-27T15:00:00Z');
  test('overdue and estimated: one line naming the sprayer, the last test date and its carrier', () => {
    expect(sprayerTestWarning({ ...TANK, calibration_status: 'estimated', calibrated_at: '2026-09-07T14:00:00Z', expires_at: '2026-10-07T14:00:00Z' }, { code: 'x', now }).message)
      .toBe('Sprayer test overdue: Fixture tank last tested 2026-09-07 at 2 gal per 1,000 sq ft (estimated, not field tested). Amounts below assume that. Test the sprayer again.');
  });
  test('a current field-verified test, no calibration and a zero carrier warn nothing', () => {
    expect(sprayerTestWarning({ ...TANK, calibration_status: 'field_verified', expires_at: '2026-12-07T14:00:00Z' }, { code: 'x', now })).toBeNull();
    expect(sprayerTestWarning(null, { code: 'x', now })).toBeNull();
    expect(sprayerTestWarning({ ...TANK, carrier_gal_per_1000: 0, expires_at: '2026-10-07T14:00:00Z' }, { code: 'x', now })).toBeNull();
  });
});
