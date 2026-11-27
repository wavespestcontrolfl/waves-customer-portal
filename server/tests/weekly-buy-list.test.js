/**
 * Weekly buy list core (procurement/weekly-buy-list.js): the ET week, demand per
 * technician, the stock split, whole packs, the spare floor, the fertilizer
 * blackout, and the read wiring. Synthetic names and prices throughout.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/waveguard-inventory-forecast', () => ({ buildWaveGuardInventoryForecast: jest.fn() }));

const forecastModule = require('../services/waveguard-inventory-forecast');
const {
  buildWeeklyBuyList, weekBounds, deriveDemand, planGroups, toPlanProduct, UNASSIGNED,
} = require('../services/procurement/weekly-buy-list');
const { resolveHouseMix } = require('../services/procurement/pest-house-mix');

const visit = (id, tech, type, date = '2026-12-07', extra = {}) => ({ id, technician_id: tech, service_type: type, scheduled_date: date, ...extra });
const noMix = { matched: [], missing: [] };
// A plan product: stock in fl_oz, one 1-gal pack (128 fl oz) at 100.00.
const plan = (over = {}) => ({
  id: 'p1', name: 'Synthetic Liquid', unit: 'fl_oz', onHand: 0, hold: false,
  picked: { row: { vendor_name: 'Synthetic Supply', quantity: '1 gal' }, vendorName: 'Synthetic Supply' },
  pack: { pack: 128 }, countOrder: false, packLabel: '1 gal', price: 100, tax: 0, floorKey: null, ...over,
});
const demand = (qty, unit = 'fl_oz', reasons = ['lawn_plan']) => ({ qty, unit, reasons: new Set(reasons) });
const group = (entries, over = {}) => ({ demand: new Map(entries), firstDate: '2026-12-07', lawnNoPlan: 0, unplanned: 0, unitProblems: new Set(), ...over });
const techs = new Map([['a', { name: 'Alex Sample', supplyStore: 'Synthetic Supply North' }], ['b', { name: 'Blake Sample', supplyStore: null }]]);
const run = (groups, products) => planGroups({ groups, products: new Map(products.map((p) => [p.id, p])), techs });

describe('the ET week', () => {
  const week = (iso) => weekBounds(new Date(iso));
  test('a Monday 7:00 AM run is the whole Monday to Saturday week', () => {
    expect(week('2026-12-07T12:00:00Z')).toEqual({ weekStart: '2026-12-07', weekEnd: '2026-12-12', fromDate: '2026-12-07' });
  });
  test('a later day counts from today and keeps the same week', () => {
    expect(week('2026-12-09T12:00:00Z')).toEqual({ weekStart: '2026-12-07', weekEnd: '2026-12-12', fromDate: '2026-12-09' });
    expect(week('2026-12-12T12:00:00Z').fromDate).toBe('2026-12-12');
  });
  test('Sunday looks ahead to the coming week', () => {
    expect(week('2026-12-13T15:00:00Z')).toEqual({ weekStart: '2026-12-14', weekEnd: '2026-12-19', fromDate: '2026-12-14' });
  });
  test('spring forward (Mar 8 2026): Saturday 11:30 PM ET is still last week, Sunday 12:30 AM looks ahead, Monday is the week', () => {
    expect(week('2026-03-08T04:30:00Z')).toMatchObject({ weekStart: '2026-03-02', weekEnd: '2026-03-07' }); // 11:30 PM Saturday EST
    expect(week('2026-03-08T05:30:00Z').weekStart).toBe('2026-03-09'); // 12:30 AM Sunday EST
    expect(week('2026-03-09T11:00:00Z')).toEqual({ weekStart: '2026-03-09', weekEnd: '2026-03-14', fromDate: '2026-03-09' }); // 7:00 AM Monday EDT
    expect(week('2026-03-15T03:30:00Z')).toMatchObject({ weekStart: '2026-03-09', weekEnd: '2026-03-14' }); // 11:30 PM Saturday EDT
  });
  test('fall back (Nov 1 2026): the Monday after it, and the week that holds it', () => {
    expect(week('2026-11-02T12:00:00Z')).toEqual({ weekStart: '2026-11-02', weekEnd: '2026-11-07', fromDate: '2026-11-02' });
    expect(week('2026-10-26T11:00:00Z')).toMatchObject({ weekStart: '2026-10-26', weekEnd: '2026-10-31' });
    expect(week('2026-11-01T14:00:00Z').weekStart).toBe('2026-11-02');
  });
});

describe('demand per technician', () => {
  const lawnForecast = {
    serviceIds: ['v1', 'v2', 'v3', 'v4', 'v-skipped'],
    products: [{ productId: 'lawn-1', inventoryUnit: 'gal', appointments: [
      { serviceId: 'v1', inventoryAmount: 1.5 }, { serviceId: 'v2', inventoryAmount: 0.5 },
      { serviceId: 'v-skipped', inventoryAmount: 9 }, // a visit this list does not count (not in the booked set)
    ], mismatchAppointments: [] }],
    errors: [{ serviceId: 'v3', message: 'no plan' }],
    skippedNonProgram: [{ serviceId: 'v4' }],
  };
  const visits = [
    visit('v1', 'a', 'Lawn Care Treatment'), visit('v2', 'b', 'Lawn Care Treatment', '2026-12-08'),
    visit('v3', 'a', 'Lawn Care Treatment'), visit('v4', 'b', 'Lawn Care Treatment'), visit('v5', 'b', 'Lawn Care Treatment'),
  ];

  test('lawn: each forecast appointment lands on its visit\'s technician; a visit not booked is left out', () => {
    const groups = deriveDemand({ visits, forecast: lawnForecast, mix: noMix, kit: [] });
    expect(groups.get('a').demand.get('lawn-1')).toMatchObject({ qty: 1.5, unit: 'gal' });
    expect(groups.get('b').demand.get('lawn-1')).toMatchObject({ qty: 0.5, unit: 'gal' });
    expect(groups.get('a').firstDate).toBe('2026-12-07');
    expect(groups.get('b').firstDate).toBe('2026-12-07');
  });

  test('lawn: a visit with no plan, a non-program lane and a visit the forecast never read are counted, not dropped', () => {
    const groups = deriveDemand({ visits, forecast: lawnForecast, mix: noMix, kit: [] });
    expect(groups.get('a').lawnNoPlan).toBe(1);
    expect(groups.get('b').unplanned).toBe(2); // v4 (non-program) and v5 (not in the forecast)
    const out = run(groups, []).get('a');
    expect(out.warnings).toEqual(['1 lawn visit has no lawn plan']);
  });

  test('pest mix: each booked general-pest visit adds the three-product mix, in each product\'s stock unit', () => {
    const catalog = [
      { id: 'taurus', name: 'Taurus SC', inventory_unit: 'gal' },
      { id: 'cross', name: 'LESCO CrossCheck Plus', inventory_unit: 'fl_oz' },
      { id: 'surf', name: 'LESCO 90/10 Nonionic Surfactant', inventory_unit: 'fl_oz' },
    ];
    const pest = [visit('p1', 'a', 'Quarterly Pest Control'), visit('p2', 'a', 'Pest Control Re-service'), visit('p3', 'b', 'Quarterly Pest Control'), visit('p4', 'b', 'Cockroach Control')];
    const groups = deriveDemand({ visits: pest, forecast: { products: [], serviceIds: [] }, mix: resolveHouseMix(catalog), kit: [] });
    expect(groups.get('a').demand.get('cross')).toMatchObject({ qty: 5, unit: 'fl_oz' });
    expect(groups.get('a').demand.get('surf').qty).toBe(0.5);
    expect(groups.get('a').demand.get('taurus').qty).toBeCloseTo((1.6 * 2) / 128, 10);
    expect(groups.get('b').demand.get('cross').qty).toBe(2.5);
    expect([...groups.get('a').demand.get('cross').reasons]).toEqual(['pest_mix']);
    // A roach job is not planned: it only shows as a count.
    expect(groups.get('b').unplanned).toBe(1);
  });

  test('per-completion supplies: one per booked visit of a named line; an inspection leaves none', () => {
    const kit = [
      { id: 'sign', per_completion_usage: '1', per_completion_service_lines: ['pest'], inventory_unit: 'each' },
      { id: 'sticker', per_completion_usage: 1, per_completion_service_lines: null, inventory_unit: 'each' },
    ];
    const visitsKit = [visit('k1', 'a', 'Quarterly Pest Control'), visit('k2', 'a', 'Pest Inspection Service'), visit('k3', 'a', 'Lawn Care Treatment')];
    const groups = deriveDemand({ visits: visitsKit, forecast: { products: [], serviceIds: ['k3'] }, mix: noMix, kit });
    expect(groups.get('a').demand.get('sign').qty).toBe(1); // pest line, not the lawn visit, not the inspection
    expect(groups.get('a').demand.get('sticker').qty).toBe(2); // every line, not the inspection
    expect([...groups.get('a').demand.get('sign').reasons]).toEqual(['visit_supply']);
  });

  test('a visit with no technician goes to the unassigned list', () => {
    const groups = deriveDemand({ visits: [visit('u1', null, 'Quarterly Pest Control')], forecast: { products: [], serviceIds: [] }, mix: resolveHouseMix([{ id: 'cross', name: 'LESCO CrossCheck Plus', inventory_unit: 'fl_oz' }]), kit: [] });
    expect([...groups.keys()]).toEqual([UNASSIGNED]);
  });
});

describe('stock, packs and cost', () => {
  test('two lists share one company count, earliest first visit first', () => {
    const groups = new Map([
      ['b', group([['p1', demand(200)]], { firstDate: '2026-12-09' })],
      ['a', group([['p1', demand(200)]], { firstDate: '2026-12-07' })],
    ]);
    const out = run(groups, [plan({ onHand: 250 })]);
    expect(out.get('a').items).toEqual([]); // 250 covers a's 200 first
    expect(out.get('b').items[0]).toMatchObject({ needQty: 200, onHand: 250, shortQty: 150, packs: 2 });
    expect(out.get('b').notes.join(' ')).toMatch(/shared by 2 lists/);
    expect(out.get('a').notes.join(' ')).toMatch(/shared by 2 lists/);
  });

  test('ties on the first visit go to the lower technician id; unassigned visits come last', () => {
    const groups = new Map([
      [UNASSIGNED, group([['p1', demand(100)]])], ['b', group([['p1', demand(100)]])], ['a', group([['p1', demand(100)]])],
    ]);
    const out = run(groups, [plan({ onHand: 100 })]);
    expect(out.get('a').items).toEqual([]);
    expect(out.get('b').items[0].shortQty).toBe(100);
    expect(out.get(UNASSIGNED).items[0].shortQty).toBe(100);
  });

  test('whole packs round up; cost is packs x price, plus tax only when the row carries one', () => {
    const at = (qty, over) => run(new Map([['a', group([['p1', demand(qty)]])]]), [plan(over)]).get('a').items[0];
    expect(at(129)).toMatchObject({ shortQty: 129, packs: 2, packLabel: '1 gal', estCostCents: 20000, vendorName: 'Synthetic Supply' });
    expect(at(128)).toMatchObject({ packs: 1, estCostCents: 10000 });
    expect(at(10, { tax: 0.07 })).toMatchObject({ packs: 1, estCostCents: 10700 });
    expect(run(new Map([['a', group([['p1', demand(10)]])]]), [plan()]).get('a').estTotalCents).toBe(10000);
  });

  test('a need in another unit is converted to the stock unit', () => {
    const out = run(new Map([['a', group([['p1', demand(1.5, 'gal')]])]]), [plan()]).get('a');
    expect(out.items[0]).toMatchObject({ needQty: 192, shortQty: 192, packs: 2 });
  });

  test('no price on file: the shortage is listed with no packs and no cost, and the note says why', () => {
    const out = run(new Map([['a', group([['p1', demand(40)]])]]), [plan({ picked: { row: null, vendorName: null }, pack: null, packLabel: null, price: null })]).get('a');
    expect(out.items[0]).toMatchObject({ shortQty: 40, packs: null, estCostCents: null, vendorName: null });
    expect(out.notes).toContain('Synthetic Liquid: no price on file.');
    expect(out.estTotalCents).toBeNull();
  });

  test('an uncounted product is treated as none on hand, with a note; negative stock reads as none', () => {
    const uncounted = run(new Map([['a', group([['p1', demand(10)]])]]), [plan({ onHand: null })]).get('a');
    expect(uncounted.items[0]).toMatchObject({ onHand: 0, shortQty: 10 });
    expect(uncounted.notes[0]).toMatch(/stock not counted/);
    const negative = run(new Map([['a', group([['p1', demand(10)]])]]), [plan({ onHand: -20 })]).get('a');
    expect(negative.items[0]).toMatchObject({ onHand: 0, shortQty: 10 });
  });

  test('a count-ordered item (items, not packs) is listed by count with no cost', () => {
    const out = run(new Map([['a', group([['p1', demand(7.2, 'each', ['visit_supply'])]])]]), [plan({ unit: 'each', countOrder: true, pack: null, onHand: 2, price: 3 })]).get('a');
    expect(out.items[0]).toMatchObject({ shortQty: 5.2, packs: 6, packLabel: 'each', estCostCents: null });
  });
});

describe('spare floor (one unopened container of the everyday liquids)', () => {
  const liquid = (over) => plan({ floorKey: 'crosscheck_plus', ...over });
  const items = (qty, over, g = {}) => run(new Map([['a', group([['p1', demand(qty, 'fl_oz', ['pest_mix'])], ...(g.more || [])])]]), [liquid(over)]).get('a').items;

  test('adds one container when less than one would be left after the week', () => {
    expect(items(10, { onHand: 0 })[0]).toMatchObject({ shortQty: 10, packs: 2, reasons: ['pest_mix', 'spare_floor'] }); // 1 to cover, 1 to keep
    expect(items(10, { onHand: 100 })[0]).toMatchObject({ shortQty: 0, packs: 1, reasons: ['pest_mix', 'spare_floor'] }); // covered, but only 90 would be left
  });

  test('adds nothing when a full container would still be left', () => {
    expect(items(10, { onHand: 300 })).toEqual([]);
    expect(items(10, { onHand: 138 })).toEqual([]); // 128 left: exactly one container
  });

  test('adds it once across two lists, to the first technician with the need', () => {
    // 256 fl oz needed, two whole containers bought and none left over: one spare in total.
    const groups = new Map([
      ['a', group([['p1', demand(128, 'fl_oz', ['pest_mix'])]], { firstDate: '2026-12-07' })],
      ['b', group([['p1', demand(128, 'fl_oz', ['pest_mix'])]], { firstDate: '2026-12-08' })],
    ]);
    const out = run(groups, [liquid({ onHand: 0 })]);
    expect(out.get('a').items[0]).toMatchObject({ packs: 2, reasons: ['pest_mix', 'spare_floor'] });
    expect(out.get('b').items[0]).toMatchObject({ packs: 1, reasons: ['pest_mix'] });
  });

  test('never for the surfactant or a lawn product, and not when there is no pack size', () => {
    expect(items(0.5, { onHand: 0, floorKey: 'surfactant' })[0]).toMatchObject({ packs: 1, reasons: ['pest_mix'] });
    expect(run(new Map([['a', group([['p1', demand(10)]])]]), [plan({ onHand: 100 })]).get('a').items).toEqual([]);
    expect(items(10, { onHand: 100, pack: { error: 'no_pack_size', message: 'No pack size on the price row.' } })).toEqual([]);
  });
});

describe('N/P fertilizer blackout', () => {
  const row = { id: 'f1', name: 'Synthetic 24-0-11 Fertilizer', inventory_unit: 'lb', inventory_on_hand: 0, fertilizer_analysis: null };
  const pricing = [{ product_id: 'f1', vendor_id: 'v', vendor_name: 'Synthetic Supply', quantity: '50 lb', is_best_price: true, price: '40', price_amount: '40', tax_rate: null }];

  test('in season the product is listed with no packs and a note, not bought', () => {
    const product = toPlanProduct({ row, pricing, now: new Date('2026-07-06T11:00:00Z') });
    expect(product.hold).toBe(true);
    const out = run(new Map([['a', group([['f1', demand(60, 'lb')]])]]), [{ ...product, id: 'f1' }]).get('a');
    expect(out.items[0]).toMatchObject({ shortQty: 60, packs: 0, estCostCents: null });
    expect(out.notes[0]).toMatch(/held June 1 to Sept 30/);
    expect(out.estTotalCents).toBeNull();
  });

  test('out of season the same product is bought in whole packs', () => {
    const product = toPlanProduct({ row, pricing, now: new Date('2026-12-07T12:00:00Z') });
    expect(product.hold).toBe(false);
    const out = run(new Map([['a', group([['f1', demand(60, 'lb')]])]]), [{ ...product, id: 'f1' }]).get('a');
    expect(out.items[0]).toMatchObject({ packs: 2, packLabel: '50 lb', estCostCents: 8000 });
  });
});

describe('buildWeeklyBuyList read wiring', () => {
  // A knex stand-in: every builder method chains; awaiting it returns the next canned result for that table.
  function fakeKnex(results) {
    const calls = [];
    const make = (table) => {
      const chain = {};
      for (const m of ['whereBetween', 'where', 'whereNull', 'orWhereNotIn', 'whereIn', 'whereRaw', 'leftJoin', 'orderBy', 'select', 'orWhere', 'whereNotIn']) {
        chain[m] = jest.fn((...args) => { if (m === 'where' && typeof args[0] === 'function') args[0].call(chain, chain); return chain; });
      }
      chain.then = (res, rej) => Promise.resolve((results[table] || []).shift() ?? []).then(res, rej);
      calls.push({ table, chain });
      return chain;
    };
    const knex = jest.fn(make);
    knex.calls = calls;
    return knex;
  }

  test('reads the week, asks the forecast for the same range, and returns the list shape', async () => {
    forecastModule.buildWaveGuardInventoryForecast.mockResolvedValue({
      serviceIds: ['v1'], serviceCount: 1, errors: [], skippedNonProgram: [],
      products: [{ productId: 'cross', inventoryUnit: 'fl_oz', appointments: [{ serviceId: 'v1', inventoryAmount: 20 }], mismatchAppointments: [] }],
    });
    const knex = fakeKnex({
      'scheduled_services as ss': [[visit('v1', 'a', 'Lawn Care Treatment', '2026-12-09')]],
      technicians: [[{ id: 'a', name: 'Alex Sample', supply_store: 'Synthetic Supply North' }]],
      products_catalog: [[{ id: 'cross', name: 'LESCO CrossCheck Plus', inventory_unit: 'fl_oz' }], []],
      'products_catalog as pc': [[{ id: 'cross', name: 'LESCO CrossCheck Plus', inventory_unit: 'fl_oz', inventory_on_hand: '5' }]],
      vendor_pricing: [[{ product_id: 'cross', vendor_id: 'v', vendor_name: 'Synthetic Supply', quantity: '1 gal', is_best_price: true, price: '90', price_amount: '90', tax_rate: null }]],
    });
    const list = await buildWeeklyBuyList({ knex, now: new Date('2026-12-09T12:00:00Z') });
    expect(forecastModule.buildWaveGuardInventoryForecast).toHaveBeenCalledWith({ knex, startDate: '2026-12-09', endDate: '2026-12-12', limit: 300 });
    expect(knex.calls[0].chain.whereBetween).toHaveBeenCalledWith('ss.scheduled_date', ['2026-12-09', '2026-12-12']);
    expect(list).toMatchObject({ weekStart: '2026-12-07', weekEnd: '2026-12-12', fromDate: '2026-12-09', unassigned: { technicianId: null, items: [] } });
    // The fixture catalog holds only one of the three mix products: the other two are named, never skipped silently.
    expect(list.warnings).toEqual([expect.stringMatching(/taurus sc is not in the catalog/), expect.stringMatching(/surfactant is not in the catalog/)]);
    expect(list.technicians).toHaveLength(1);
    expect(list.technicians[0]).toMatchObject({
      technicianId: 'a', technicianName: 'Alex Sample', supplyStore: 'Synthetic Supply North',
      // 15 short is one container; 5 + 128 - 20 leaves 113, under a full container, so the house liquid keeps one spare.
      items: [{ productId: 'cross', needQty: 20, onHand: 5, shortQty: 15, packs: 2, estCostCents: 18000, vendorName: 'Synthetic Supply', reasons: ['lawn_plan', 'spare_floor'] }],
      estTotalCents: 18000, notes: [], warnings: [],
    });
  });

  test('a forecast that fails fails the list: lawn need is never left out silently', async () => {
    forecastModule.buildWaveGuardInventoryForecast.mockRejectedValue(new Error('forecast down'));
    const knex = fakeKnex({ 'scheduled_services as ss': [[]], technicians: [[]] });
    await expect(buildWeeklyBuyList({ knex, now: new Date('2026-12-07T12:00:00Z') })).rejects.toThrow('forecast down');
  });

  test('a forecast that hit its visit cap says so', async () => {
    forecastModule.buildWaveGuardInventoryForecast.mockResolvedValue({ serviceIds: [], serviceCount: 300, errors: [], skippedNonProgram: [], products: [] });
    const knex = fakeKnex({ 'scheduled_services as ss': [[]], products_catalog: [[], []] });
    const list = await buildWeeklyBuyList({ knex, now: new Date('2026-12-07T12:00:00Z') });
    expect(list.warnings).toContain('The lawn forecast stopped at 300 visits, so lawn needs may read low.');
    expect(list.warnings.join(' ')).toMatch(/house mix product taurus sc is not in the catalog/);
  });
});
