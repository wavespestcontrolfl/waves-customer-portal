'use strict';

// Mix help of the lawn Fast Complete sheet (GATE_LAWN_MIX_HELP): the tank arithmetic, the staged-row rules, the context block, and the
// gallons-sprayed step of /complete. Pure; the real-Postgres checks are in lawn-mix-help.db.test.js. Synthetic data only.

const help = require('../services/lawn-mix-help');
const reportFacts = require('../services/service-report/lawn-report-facts');

const GATES = ['GATE_LAWN_MIX_HELP', 'GATE_LAWN_SPOT_RULES', 'GATE_LAWN_V13'];
const saved = Object.fromEntries(GATES.map((name) => [name, process.env[name]]));
const gates = (on) => { for (const name of GATES) { if (on) process.env[name] = 'true'; else delete process.env[name]; } };
afterEach(() => { for (const name of GATES) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; } });

const P_CEL = 'aaaaaaaa-0000-4000-8000-000000000001';
const P_CER = 'aaaaaaaa-0000-4000-8000-000000000002';
const P_NIS = 'aaaaaaaa-0000-4000-8000-000000000003';
const P_ARENA = 'aaaaaaaa-0000-4000-8000-000000000004';
const P_ARTAVIA = 'aaaaaaaa-0000-4000-8000-000000000005';

describe('the arithmetic (the staged row\'s rate over its carrier, times the tank)', () => {
  test('Celsius at 0.085 oz per 1,000 sq ft over 1 gal per 1,000: the label\'s own middle-rate table for 2 and 4 gallons', () => {
    // Celsius WG label (EPA 432-1507), measuring cone table, Middle rate: 2 gallons 0.17 oz, 4 gallons 0.34 oz.
    const doses = help.tankDoses({ ratePer1000: 0.085, rateUnit: 'oz', carrierGalPer1000: 1 });
    expect(doses[1]).toEqual({ text: '0.09 oz (2.41 g)', coversSqft: 1000 });
    expect(doses[2]).toEqual({ text: '0.17 oz (4.82 g)', coversSqft: 2000 });
    expect(doses[4]).toEqual({ text: '0.34 oz (9.64 g)', coversSqft: 4000 });
  });

  test('Certainty 0.028 oz per 1,000 over 1 gal: grams carry the precision two decimals of an ounce lose', () => {
    expect(help.tankDoses({ ratePer1000: 0.028, rateUnit: 'oz', carrierGalPer1000: 1 })[2].text).toBe('0.06 oz (1.59 g)');
  });

  test('the surfactant is a share of the finished tank (0.25% v/v), not an amount per area: fl oz and mL, no area covered', () => {
    const doses = help.tankDoses({ concentration: '0.25% v/v', carrierGalPer1000: 1 });
    expect(doses[1]).toEqual({ text: '0.32 fl oz (9.5 mL)', coversSqft: null });
    expect(doses[2].text).toBe('0.64 fl oz (18.9 mL)');
    expect(doses[4].text).toBe('1.28 fl oz (37.9 mL)');
  });

  test('a row with its own carrier (Arena 0.147 oz over 4 gal per 1,000): a 4 gallon fill covers 1,000 sq ft', () => {
    const doses = help.tankDoses({ ratePer1000: 0.147, rateUnit: 'oz', carrierGalPer1000: 4 });
    expect(doses[4]).toEqual({ text: '0.15 oz (4.17 g)', coversSqft: 1000 });
    expect(doses[1].coversSqft).toBe(250);
  });

  test('a liquid is shown in fl oz and mL; a pound rate is shown in oz and grams', () => {
    expect(help.tankDoses({ ratePer1000: 1, rateUnit: 'fl oz', carrierGalPer1000: 4 })[2].text).toBe('0.50 fl oz (14.8 mL)');
    expect(help.tankDoses({ ratePer1000: 1, rateUnit: 'fl_oz', carrierGalPer1000: 4 })[2].text).toBe('0.50 fl oz (14.8 mL)');
    expect(help.tankDoses({ ratePer1000: 0.01, rateUnit: 'lb', carrierGalPer1000: 1 })[1].text).toBe('0.16 oz (4.54 g)');
  });

  test.each([
    ['no rate', { ratePer1000: null, rateUnit: 'oz', carrierGalPer1000: 1 }],
    ['a label_rate row', { ratePer1000: null, rateUnit: 'label_rate', carrierGalPer1000: 2 }],
    ['an unsupported unit', { ratePer1000: 1, rateUnit: 'lb_n', carrierGalPer1000: 1 }],
    ['no carrier', { ratePer1000: 0.085, rateUnit: 'oz', carrierGalPer1000: null }],
    ['a zero carrier', { ratePer1000: 0.085, rateUnit: 'oz', carrierGalPer1000: 0 }],
    ['an unreadable concentration', { concentration: 'a splash', carrierGalPer1000: 1 }],
    ['a concentration over a hundred percent', { concentration: '120% v/v' }],
  ])('%s: no tank amount (never a guess)', (_name, staged) => {
    expect(help.tankDoses(staged)).toBeNull();
  });
});

describe('entryFor', () => {
  test('no carrier on file: the per-1,000 dose and the plain reason, no tank amount', () => {
    const entry = help.entryFor({ ratePer1000: 0.085, rateUnit: 'oz', carrierGalPer1000: null }, { name: 'Celsius WG' });
    expect(entry).toMatchObject({ name: 'Celsius WG', perTank: null, per1000: '0.09 oz (2.41 g)', carrierGalPer1000: null, note: 'The carrier volume is not on file for this product, so there is no tank amount.' });
  });

  test('no rate and no concentration: nothing to show', () => {
    expect(help.entryFor({ ratePer1000: null, rateUnit: 'label_rate', carrierGalPer1000: 2 }, { name: 'Artavia' })).toBeNull();
  });

  test('the Celsius label lines ride the EPA registration number, not the name', () => {
    const staged = { ratePer1000: 0.085, rateUnit: 'oz', carrierGalPer1000: 1 };
    const celsius = help.entryFor(staged, { name: 'Renamed in the catalog', epa_reg_number: '432-1507' });
    expect(celsius.labelLines).toEqual([
      { text: 'Prepare only as much spray mixture as needed for application on the same day.', source: 'Celsius WG label, Mixing Instructions' },
      { text: 'Apply spray mixtures of this product within 5 days of mixing to avoid product degradation.', source: 'Celsius WG label, Precautions, item 3' },
    ]);
    expect(help.entryFor(staged, { name: 'Celsius WG', epa_reg_number: '59639-226' })).not.toHaveProperty('labelLines');
    expect(help.entryFor(staged, { name: 'Celsius WG' })).not.toHaveProperty('labelLines');
  });

  test('the surfactant entry has a concentration and no carrier of its own', () => {
    expect(help.entryFor({ ratePer1000: null, rateUnit: 'label_rate', carrierGalPer1000: 1, concentration: '0.25% v/v' }, { name: 'NIS' }))
      .toMatchObject({ carrierGalPer1000: null, per1000: null, concentration: '0.25% v/v', note: null });
  });
});

describe('areaFromGallons', () => {
  test.each([
    [2, 1, 2000], [1, 4, 250], [0.5, 1, 500], [3, 2, 1500], [0.0001, 1, 1],
  ])('%s gallons at %s gal per 1,000 sq ft -> %s sq ft', (gallons, carrier, expected) => {
    expect(help.areaFromGallons(gallons, carrier)).toBe(expected);
  });
  test.each([[0, 1], [-1, 1], ['x', 1], [null, 1], [2, 0], [2, null], [2, 'x']])('%s gallons, carrier %s -> null', (gallons, carrier) => {
    expect(help.areaFromGallons(gallons, carrier)).toBeNull();
  });
});

describe('agreedRow', () => {
  const row = (month, extra = {}) => ({ month, application_mode: 'spot', rate_per_1000: 0.085, rate_unit: 'oz', carrier_gal_per_1000: 1, gates: {}, ...extra });
  test('the visit month\'s own window wins over the others', () => {
    expect(help.agreedRow([row(1), row(10, { rate_per_1000: 0.1 })], 10)).toMatchObject({ ratePer1000: 0.1 });
  });
  test('without a window of the month, all windows must agree', () => {
    expect(help.agreedRow([row(1), row(2)], 10)).toMatchObject({ mode: 'spot', ratePer1000: 0.085, rateUnit: 'oz', carrierGalPer1000: 1, concentration: null });
    expect(help.agreedRow([row(1), row(2, { carrier_gal_per_1000: 4 })], 10)).toBeNull();
  });
  test('two rows of the month that disagree are not a guess to pick from', () => {
    expect(help.agreedRow([row(10), row(10, { rate_per_1000: 0.1 })], 10)).toBeNull();
  });
  test('the concentration comes from the gates, a string or an object', () => {
    expect(help.agreedRow([row(10, { rate_per_1000: null, gates: '{"concentration":"0.25% v/v"}' })], 10)).toMatchObject({ concentration: '0.25% v/v' });
  });
  test('no rows: null', () => { expect(help.agreedRow([], 10)).toBeNull(); });
});

describe('weedOrder', () => {
  const catalog = (entries) => new Map(Object.entries(entries).map(([id, mixing_order_category]) => [id, { name: id, mixing_order_category }]));
  test('products whose category the plan engine orders are listed in its order (dry first, adjuvant last)', () => {
    expect(help.weedOrder([P_NIS, P_CER, P_CEL], catalog({ [P_CEL]: 'dry_wg_wdg_wp_df', [P_CER]: 'liquid_flowable_sc', [P_NIS]: 'adjuvant_last' }))).toEqual([P_CEL, P_CER, P_NIS]);
  });
  test('a product with no category is left out of the list, so the sheet can tell the order does not cover the tank', () => {
    expect(help.weedOrder([P_CEL, P_CER, P_NIS], catalog({ [P_CEL]: 'dry_wg_wdg_wp_df', [P_CER]: null, [P_NIS]: 'adjuvant_last' }))).toEqual([P_CEL, P_NIS]);
  });
  test('fewer than two classified products: no order', () => {
    expect(help.weedOrder([P_CEL, P_CER], catalog({ [P_CEL]: 'dry_wg_wdg_wp_df', [P_CER]: null }))).toBeNull();
    expect(help.weedOrder([P_CEL], catalog({ [P_CEL]: 'dry_wg_wdg_wp_df' }))).toBeNull();
  });
});

describe('contextBlock', () => {
  const spotRow = (productId, extra = {}) => ({ product_id: productId, application_mode: 'spot', rate_per_1000: 0.085, rate_unit: 'oz', carrier_gal_per_1000: 1, gates: {}, month: 10, ...extra });
  const STAGED = new Map([
    [P_CEL, [spotRow(P_CEL)]],
    [P_CER, [spotRow(P_CER, { rate_per_1000: 0.028 })]],
    [P_NIS, [spotRow(P_NIS, { rate_per_1000: null, rate_unit: 'label_rate', gates: { concentration: '0.25% v/v' } })]],
    [P_ARTAVIA, [spotRow(P_ARTAVIA, { rate_per_1000: null, rate_unit: 'label_rate', carrier_gal_per_1000: 2 })]],
    [P_ARENA, [spotRow(P_ARENA, { rate_per_1000: 0.147, carrier_gal_per_1000: 4 }), spotRow(P_ARENA, { month: 5, rate_per_1000: 0.147, carrier_gal_per_1000: 4 })]],
  ]);
  const CATALOG = new Map([
    [P_CEL, { name: 'Celsius WG', epa_reg_number: '432-1507', mixing_order_category: 'dry_wg_wdg_wp_df' }],
    [P_CER, { name: 'Certainty', epa_reg_number: '59639-226', mixing_order_category: 'liquid_flowable_sc' }],
    [P_NIS, { name: 'Surfactant', epa_reg_number: null, mixing_order_category: 'adjuvant_last' }],
    [P_ARTAVIA, { name: 'Artavia' }],
    [P_ARENA, { name: 'Arena 50 WDG' }],
  ]);
  const loaded = { plan: { protocol: { structured: { id: 'protocol-1' } } }, items: [], addOns: [P_CEL, P_CER, P_NIS, P_ARTAVIA].map((id) => ({ product: { id } })) };
  const weed = { weedMix: { groupProductIds: [P_CEL, P_CER, P_NIS] } };
  const chinch = { chinch: { rungIds: [P_ARENA] } };
  const readers = () => ({ readStaged: jest.fn(async () => STAGED), readCatalog: jest.fn(async () => CATALOG) });

  test('gate off: nothing, and nothing is read', async () => {
    const r = readers();
    expect(await help.contextBlock({ loaded, weed, chinch, month: 10, knex: {}, isLive: () => false, ...r })).toEqual({});
    expect(r.readStaged).not.toHaveBeenCalled();
    gates(false);
    expect(await help.contextBlock({ loaded, weed, chinch, month: 10, knex: {}, ...r })).toEqual({});
  });

  test('the gate reader needs the spot rules and the v13 program too', () => {
    const featureGates = require('../config/feature-gates');
    process.env.GATE_LAWN_MIX_HELP = 'true';
    expect(featureGates.lawnMixHelpLive()).toBe(false);
    process.env.GATE_LAWN_SPOT_RULES = 'true';
    expect(featureGates.lawnMixHelpLive()).toBe(false);
    process.env.GATE_LAWN_V13 = 'true';
    expect(featureGates.lawnMixHelpLive()).toBe(true);
    process.env.GATE_LAWN_MIX_HELP = 'TRUE';
    expect(featureGates.lawnMixHelpLive()).toBe(false);
  });

  test('on: every spot product of the program and the chinch ladder, the rungs by their own carrier, the weed order and the label lines', async () => {
    const out = await help.contextBlock({ loaded, weed, chinch, month: 10, knex: {}, isLive: () => true, ...readers() });
    expect(out.mixHelp.v).toBe(1);
    expect(out.mixHelp.tanks).toEqual([1, 2, 4]);
    expect(Object.keys(out.mixHelp.rows).sort()).toEqual([P_CEL, P_CER, P_NIS, P_ARENA].sort());
    expect(out.mixHelp.rows[P_CEL].perTank['2'].text).toBe('0.17 oz (4.82 g)');
    expect(out.mixHelp.rows[P_CEL].labelLines).toHaveLength(2);
    expect(out.mixHelp.rows[P_CER].perTank['2'].text).toBe('0.06 oz (1.59 g)');
    expect(out.mixHelp.rows[P_NIS].perTank['2'].text).toBe('0.64 fl oz (18.9 mL)');
    expect(out.mixHelp.rows[P_ARENA]).toMatchObject({ carrierGalPer1000: 4 });
    expect(out.mixHelp.weedOrder).toEqual([P_CEL, P_CER, P_NIS]);
    // A label_rate row (Artavia) has nothing to size: it is not listed.
    expect(out.mixHelp.rows[P_ARTAVIA]).toBeUndefined();
  });

  test('a whole-lawn product has no mix help (the plan keeps its own amount)', async () => {
    const staged = new Map([[P_CEL, [{ ...spotRow(P_CEL), application_mode: 'broadcast' }]]]);
    expect(await help.contextBlock({ loaded, weed: {}, chinch: {}, month: 10, knex: {}, isLive: () => true, readStaged: async () => staged, readCatalog: async () => CATALOG })).toEqual({});
  });

  test('staged rows that disagree give no entry; a failed read gives no block (the sheet works as before)', async () => {
    const staged = new Map([[P_CEL, [spotRow(P_CEL, { month: 1 }), spotRow(P_CEL, { month: 2, carrier_gal_per_1000: 2 })]]]);
    expect(await help.contextBlock({ loaded, weed: {}, chinch: {}, month: 10, knex: {}, isLive: () => true, readStaged: async () => staged, readCatalog: async () => CATALOG })).toEqual({});
    expect(await help.contextBlock({ loaded, weed, chinch, month: 10, knex: {}, isLive: () => true, readStaged: async () => { throw new Error('down'); }, readCatalog: async () => CATALOG })).toEqual({});
  });

  test('no staged protocol: no block', async () => {
    expect(await help.contextBlock({ loaded: { plan: null, items: [], addOns: loaded.addOns }, weed, chinch, month: 10, knex: {}, isLive: () => true, ...readers() })).toEqual({});
  });
});

describe('gallons sprayed at completion', () => {
  const SVC = { id: 'svc-1', scheduled_date: '2026-10-09' };
  const staged = (over = {}) => new Map([
    [P_CEL, [{ month: 10, application_mode: 'spot', rate_per_1000: 0.085, rate_unit: 'oz', carrier_gal_per_1000: 1, gates: {} }]],
    [P_ARENA, [{ month: 10, application_mode: 'spot', rate_per_1000: 0.147, rate_unit: 'oz', carrier_gal_per_1000: 4, gates: {} }]],
    [P_NIS, [{ month: 10, application_mode: 'spot', rate_per_1000: null, rate_unit: 'label_rate', carrier_gal_per_1000: 1, gates: { concentration: '0.25% v/v' } }]],
    [P_CER, [{ month: 10, application_mode: 'broadcast', rate_per_1000: 0.028, rate_unit: 'oz', carrier_gal_per_1000: 1, gates: {} }]],
    ...Object.entries(over),
  ]);
  const run = (products, extra = {}) => help.applyGallons({
    knex: {}, svc: SVC, products, loadPlan: async () => ({ plan: { protocol: { structured: { id: 'protocol-1' } } } }), isLive: () => true, readStaged: async () => staged(),
    // The completion's own method resolution, stood in for: a row with no method rides the spot default, as persistence resolves it.
    readSpotRows: async (knex, rows) => rows.filter((row) => (row.applicationMethod || 'spot_treatment') === 'spot_treatment'), ...extra,
  });

  test('gallons become the spot area with the product\'s STAGED carrier, replacing whatever area the sheet sent', async () => {
    const products = [{ productId: P_CEL, sprayedGallons: 2, areaValue: 99999, areaUnit: 'sqft' }, { productId: P_ARENA, sprayedGallons: '4' }];
    expect(await run(products)).toBeNull();
    expect(products[0]).toMatchObject({ areaValue: 2000, areaUnit: 'sqft' });
    expect(products[1]).toMatchObject({ areaValue: 1000, areaUnit: 'sqft' });
    expect(help.sprayedGallonsFreeze(products)).toEqual({
      lawnSprayedGallons: { v: 1, rows: [
        { productId: P_CEL, gallons: 2, carrierGalPer1000: 1, areaSqft: 2000 },
        { productId: P_ARENA, gallons: 4, carrierGalPer1000: 4, areaSqft: 1000 },
      ] },
    });
  });

  test('a row without gallons is untouched and not marked', async () => {
    const products = [{ productId: P_CEL, areaValue: 500, areaUnit: 'sqft' }];
    expect(await run(products)).toBeNull();
    expect(products[0]).toEqual({ productId: P_CEL, areaValue: 500, areaUnit: 'sqft' });
    expect(help.sprayedGallonsFreeze(products)).toEqual({});
  });

  test('a request cannot claim a conversion the server did not make', async () => {
    const forged = { productId: P_CEL, areaValue: 500, areaUnit: 'sqft', lawnAreaFromGallons: { gallons: 9 }, [Symbol.for('lawnAreaFromGallons')]: { gallons: 9 } };
    expect(await run([forged])).toBeNull();
    expect(help.sprayedGallonsFreeze([forged])).toEqual({});
    // A mark from an earlier pass is cleared when the step runs again without gallons.
    const again = { productId: P_CEL, sprayedGallons: 1 };
    await run([again]);
    expect(help.sprayedGallonsFreeze([again])).not.toEqual({});
    delete again.sprayedGallons;
    await run([again]);
    expect(help.sprayedGallonsFreeze([again])).toEqual({});
  });

  test.each([[0], [-2], ['abc'], [{}], [Infinity], [NaN], ['1e400'], ['Infinity'], [true], [[5]], ['5 gal']])('gallons %j: refused as invalid (400)', async (gallons) => {
    expect(await run([{ productId: P_CEL, sprayedGallons: gallons }])).toMatchObject({ status: 400, payload: { code: 'lawn_gallons_invalid', productId: P_CEL } });
  });

  test('the bound: ten fills of the largest tank (40 gallons) is the most a spot job can state; a finite overflow is refused, never stored as a null area', async () => {
    expect(help.MAX_GALLONS).toBe(40);
    const atBound = [{ productId: P_CEL, sprayedGallons: 40 }];
    expect(await run(atBound)).toBeNull();
    expect(atBound[0].areaValue).toBe(40000);
    for (const sprayedGallons of [40.01, 41, 1e6, 1e308, '1e308', '99999999999999999999999999999999999999999999']) {
      const row = { productId: P_CEL, sprayedGallons, areaValue: 10, areaUnit: 'sqft' };
      expect(await run([row])).toMatchObject({ status: 400, payload: { code: 'lawn_gallons_invalid', productId: P_CEL } });
      expect(row.areaValue).toBe(10);
    }
    // The one conversion never returns a non-finite or null-stored area.
    expect(help.areaFromGallons(1e308, 1)).toBeNull();
    expect(help.areaFromGallons(40.5, 1)).toBeNull();
    expect(help.areaFromGallons(40, 1e-320)).toBeNull();
    expect(help.areaFromGallons(1, 1e-320)).toBeNull();
  });

  test('a row SUBMITTED with a non-spot method keeps its own area: gallons never overwrite it (refused, enter the area instead)', async () => {
    for (const applicationMethod of ['broadcast_spray', 'granular_broadcast', 'soil_drench']) {
      const row = { productId: P_CEL, applicationMethod, sprayedGallons: 2, areaValue: 700, areaUnit: 'sqft' };
      expect(await run([row])).toMatchObject({ status: 400, payload: { code: 'lawn_gallons_unavailable', productId: P_CEL } });
      expect(row.areaValue).toBe(700);
      expect(help.sprayedGallonsFreeze([row])).toEqual({});
    }
    const spot = { productId: P_CEL, applicationMethod: 'spot_treatment', sprayedGallons: 2 };
    expect(await run([spot])).toBeNull();
    expect(spot.areaValue).toBe(2000);
  });

  test('one non-spot row refuses the whole step before any row is converted', async () => {
    const good = { productId: P_CEL, sprayedGallons: 2 };
    const moved = { productId: P_ARENA, applicationMethod: 'broadcast_spray', sprayedGallons: 1 };
    expect(await run([good, moved])).toMatchObject({ status: 400, payload: { code: 'lawn_gallons_unavailable', productId: P_ARENA } });
    expect(good).not.toHaveProperty('areaValue');
  });

  test('a failed method read is the correctable "could not check" refusal, nothing converted', async () => {
    const good = { productId: P_CEL, sprayedGallons: 2 };
    expect(await run([good], { readSpotRows: async () => { throw new Error('down'); } })).toMatchObject({ status: 400, payload: { code: 'lawn_gallons_unavailable_now' } });
    expect(good).not.toHaveProperty('areaValue');
  });

  test('a product with no carrier on file, a whole-lawn product, the surfactant and an unknown product are refused (enter the area instead)', async () => {
    const noCarrier = staged({ [P_ARENA]: [{ month: 10, application_mode: 'spot', rate_per_1000: 0.147, rate_unit: 'oz', carrier_gal_per_1000: null, gates: {} }] });
    expect(await run([{ productId: P_ARENA, sprayedGallons: 1 }], { readStaged: async () => noCarrier })).toMatchObject({ status: 400, payload: { code: 'lawn_gallons_unavailable' } });
    for (const productId of [P_CER, P_NIS, P_ARTAVIA]) {
      expect(await run([{ productId, sprayedGallons: 1 }])).toMatchObject({ status: 400, payload: { code: 'lawn_gallons_unavailable', productId } });
    }
  });

  test('withSprayedGallons runs the places check only when the gallons step did not refuse', async () => {
    const next = jest.fn(async () => null);
    const loadPlan = async () => ({ plan: { protocol: { structured: { id: 'p' } } } });
    // Gate off: the step is skipped and the places check runs.
    expect(await help.withSprayedGallons({ knex: {}, svc: SVC, products: [{ productId: P_CEL, sprayedGallons: 2 }], loadPlan }, next)).toBeNull();
    expect(next).toHaveBeenCalledTimes(1);
    // Gate on, a refused row: the refusal comes back and the places check never runs.
    gates(true);
    const refused = await help.withSprayedGallons({ knex: {}, svc: SVC, products: [{ productId: P_CEL, sprayedGallons: 0 }], loadPlan }, next);
    expect(refused).toMatchObject({ status: 400, payload: { code: 'lawn_gallons_invalid' } });
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('a plan or staged read that fails is a correctable 400 (never a 5xx the submit hook would lock), never a converted area', async () => {
    const products = [{ productId: P_CEL, sprayedGallons: 2, areaValue: 10, areaUnit: 'sqft' }];
    expect(await run(products, { readStaged: async () => { throw new Error('down'); } })).toMatchObject({ status: 400, payload: { code: 'lawn_gallons_unavailable_now' } });
    expect(products[0].areaValue).toBe(10);
  });

  test('the derived area reaches the customer card as a recorded spot area, word for word as a typed area does', async () => {
    const card = (area) => {
      const rows = [{ id: 'sp-1', product_id: P_CEL, application_method: 'spot_treatment', area_value: area, area_unit: 'sqft' }];
      const facts = reportFacts.buildReportFacts({ rows, run: null, assessment: null, techFindings: [], withTies: false, recordedSpotAreas: new Set([P_CEL]) });
      return reportFacts.frozenProductUseTexts({ lawnReportFacts: facts });
    };
    const products = [{ productId: P_CEL, sprayedGallons: 2 }];
    await run(products);
    expect(products[0].areaValue).toBe(2000);
    expect(card(products[0].areaValue)).toEqual(card(2000));
    expect(card(2000)).toEqual({ 'sp-1': 'Spot treatment, about 2,000 sq ft' });
  });

  test('gate off: the field is ignored and the row is exactly what the sheet sent', async () => {
    const products = [{ productId: P_CEL, sprayedGallons: 2, areaValue: 700, areaUnit: 'sqft' }];
    expect(await run(products, { isLive: () => false })).toBeNull();
    expect(products[0]).toMatchObject({ areaValue: 700 });
    expect(help.sprayedGallonsFreeze(products)).toEqual({});
  });
});
