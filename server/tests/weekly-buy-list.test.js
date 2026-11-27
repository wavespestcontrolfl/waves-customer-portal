/**
 * Weekly buy list core (procurement/weekly-buy-list.js): the ET week, demand per
 * technician, the stock split, whole packs, the spare floor, the fertilizer
 * blackout, and the read wiring. Synthetic names and prices throughout.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/waveguard-inventory-forecast', () => ({ buildWaveGuardInventoryForecast: jest.fn() }));
jest.mock('../services/taurus-yearly-count', () => ({ projectTaurusEligibility: jest.fn() }));
jest.mock('../services/service-completion-profiles', () => ({
  resolveCompletionProfileForScheduledService: jest.fn(),
  resolveCompletionDeliveryPosture: jest.requireActual('../services/service-completion-profiles').resolveCompletionDeliveryPosture,
}));

const forecastModule = require('../services/waveguard-inventory-forecast');
const profiles = require('../services/service-completion-profiles');
const taurusModule = require('../services/taurus-yearly-count');
const {
  buildWeeklyBuyList, weekBounds, deriveDemand, planGroups, toPlanProduct, UNASSIGNED,
} = require('../services/procurement/weekly-buy-list');
const { resolveHouseMix } = require('../services/procurement/pest-house-mix');

const visit = (id, tech, type, date = '2026-12-07', extra = {}) => ({ id, technician_id: tech, service_type: type, scheduled_date: date, ...extra });
const noMix = { matched: [], missing: [] };
// A plan product: stock in fl_oz, one 1-gal pack (128 fl oz) at 100.00.
const plan = (over = {}) => ({
  id: 'p1', name: 'Synthetic Liquid', unit: 'fl_oz', onHand: 0, onOrder: 0, hold: false,
  picked: { row: { vendor_name: 'Synthetic Supply', quantity: '1 gal' }, vendorName: 'Synthetic Supply' },
  pack: { pack: 128 }, countOrder: false, packLabel: '1 gal', price: 100, packCents: 10000, plusShipping: false, floorKey: null, catalogRow: {}, pricingRows: [], ...over,
});
const demand = (qty, unit = 'fl_oz', reasons = ['lawn_plan']) => ({ qty, unit, reasons: new Set(reasons) });
const group = (entries, over = {}) => ({ demand: new Map(entries), firstAt: '2026-12-07', lawnNoPlan: 0, unplanned: 0, unitProblems: new Set(), mixMissing: new Set(), extra: new Set(), lawnMismatch: new Set(), ...over });
const techs = new Map([['a', { name: 'Alex Sample', supplyStore: 'Synthetic Supply North' }], ['b', { name: 'Blake Sample', supplyStore: null }]]);
const run = (groups, products, techMap = techs) => planGroups({ groups, products: new Map(products.map((p) => [p.id, p])), techs: techMap });

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
    expect(groups.get('a').firstAt).toBe('2026-12-07T99'); // no window start: sorts after every time that day
    expect(groups.get('b').firstAt).toBe('2026-12-07T99'); // v2 is Tuesday, v4 and v5 Monday
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

  test('per-completion supplies follow the close-out: an internal-only consultation leaves none, the WDO inspection project still leaves its notice', () => {
    const kit = [{ id: 'notice', per_completion_usage: 1, per_completion_service_lines: ['termite'], inventory_unit: 'each' }];
    const visitsKit = [
      visit('w1', 'a', 'WDO Inspection', '2026-12-07', { project_type: 'wdo_inspection' }),
      visit('w2', 'a', 'Termite Inspection Service'), // a plain inspection: no notice
      visit('w3', 'a', 'Termite Bait Check', '2026-12-07', { internal_only: true }), // internal-only profile
      visit('w4', 'a', 'Termite Bait Check'),
    ];
    const groups = deriveDemand({ visits: visitsKit, forecast: { products: [], serviceIds: [] }, mix: noMix, kit });
    expect(groups.get('a').demand.get('notice').qty).toBe(2); // w1 and w4
    // an inspection or an internal-only visit applies nothing, so it is not an unplanned gap either; only w4 is
    expect(groups.get('a').unplanned).toBe(1);
  });

  test('Taurus SC is left off the visits whose home has no label room, and the list says so', () => {
    const mix = resolveHouseMix([
      { id: 'taurus', name: 'Taurus SC', inventory_unit: 'fl_oz' }, { id: 'cross', name: 'LESCO CrossCheck Plus', inventory_unit: 'fl_oz' },
      { id: 'surf', name: 'LESCO 90/10 Nonionic Surfactant', inventory_unit: 'fl_oz' },
    ]);
    const visitsTaurus = [
      visit('t1', 'a', 'Quarterly Pest Control', '2026-12-07', { taurus_ok: true }),
      visit('t2', 'a', 'Quarterly Pest Control', '2026-12-08', { taurus_ok: false }),
      visit('t3', 'b', 'Quarterly Pest Control', '2026-12-08', { taurus_ok: false }),
    ];
    const groups = deriveDemand({ visits: visitsTaurus, forecast: { products: [], serviceIds: [] }, mix, kit: [] });
    expect(groups.get('a').demand.get('taurus').qty).toBe(1.6); // one visit of two
    expect(groups.get('a').demand.get('cross').qty).toBe(5);
    expect(groups.get('b').demand.has('taurus')).toBe(false);
    const out = planGroups({ groups, products: new Map(), techs }); // the note rides the plan loop, whatever the catalog holds
    expect(out.get('a').notes.join(' ')).toMatch(/Taurus SC is left out of 1 visit: the home reached the label's yearly limit, or its count is unavailable/);
    expect(out.get('b').notes.join(' ')).toMatch(/left out of 1 visit/);
  });

  test('a bare pest label that resolves to the one-time pest service gets the mix; one that resolves to nothing is unplanned', () => {
    const mix = resolveHouseMix([{ id: 'cross', name: 'LESCO CrossCheck Plus', inventory_unit: 'fl_oz' }]);
    const groups = deriveDemand({
      visits: [
        visit('b1', 'a', 'Pest Control Service', '2026-12-07', { profile_service_key: 'one_time_pest_control' }),
        visit('b2', 'a', 'Pest Control Service', '2026-12-07', { profile_service_key: null }),
        visit('b3', 'a', 'Quarterly Pest Control', '2026-12-07', { typed_findings: true }),
      ],
      forecast: { products: [], serviceIds: [] }, mix, kit: [],
    });
    expect(groups.get('a').demand.get('cross').qty).toBe(2.5);
    expect(groups.get('a').unplanned).toBe(2);
  });

  test('a lawn visit whose plan gave no usable amounts is counted on that technician\'s list: its need is unknown, not zero', () => {
    const groups = deriveDemand({
      visits: [visit('n1', 'a', 'Lawn Care Treatment'), visit('n2', 'a', 'Lawn Care Treatment'), visit('n3', 'b', 'Lawn Care Treatment')],
      forecast: { products: [], serviceIds: ['n1', 'n2', 'n3'], noUsablePlan: ['n1', 'n3'], errors: [], skippedNonProgram: [] }, mix: noMix, kit: [],
    });
    const out = planGroups({ groups, products: new Map(), techs });
    expect(out.get('a').warnings).toEqual(['1 lawn visit has no usable plan, so its need is unknown']);
    expect(out.get('b').warnings).toEqual(['1 lawn visit has no usable plan, so its need is unknown']);
  });

  test('lawn demand counts only for visits read as lawn: a planned visit of another line is warned about, never counted or doubled', () => {
    const forecast = {
      serviceIds: ['m1', 'm2'], noUsablePlan: ['m1'], partialPlan: [], errors: [], skippedNonProgram: [],
      products: [{ productId: 'lawn-1', inventoryUnit: 'gal', appointments: [{ serviceId: 'm1', inventoryAmount: 3 }, { serviceId: 'm2', inventoryAmount: 1 }], mismatchAppointments: [] }],
    };
    const groups = deriveDemand({ visits: [visit('m1', 'a', 'Tree & Shrub Fertilization'), visit('m2', 'a', 'Lawn Care Treatment')], forecast, mix: noMix, kit: [] });
    expect(groups.get('a').demand.get('lawn-1').qty).toBe(1); // only the lawn visit
    const out = planGroups({ groups, products: new Map(), techs });
    expect(out.get('a').warnings).toContain('1 visit the lawn forecast planned is not read as lawn here, so its lawn products are left out');
    // its other lawn findings do not count against the lawn list either: it is a tree and shrub visit, counted once as unplanned
    expect(out.get('a').warnings).not.toContain('1 lawn visit has no usable plan, so its need is unknown');
    expect(out.get('a').warnings).toContain('1 visit of types this list does not plan yet');
  });

  test('a lawn visit planned for only some of its lines is warned about', () => {
    const groups = deriveDemand({
      visits: [visit('p1', 'a', 'Lawn Care Treatment'), visit('p2', 'b', 'Lawn Care Treatment')],
      forecast: { serviceIds: ['p1', 'p2'], partialPlan: ['p1'], noUsablePlan: [], errors: [], skippedNonProgram: [], products: [] }, mix: noMix, kit: [],
    });
    const out = planGroups({ groups, products: new Map(), techs });
    expect(out.get('a').warnings).toEqual(['1 lawn visit has a product with no amount, so that product is missing from its need']);
    expect(out.get('b').warnings).toEqual([]);
  });

  test('stock goes to the technician who is at the first stop earlier that day; an unset start time sorts last', () => {
    const visitsDay = [
      visit('d1', 'a', 'Quarterly Pest Control', '2026-12-07', { window_start: '13:00:00' }),
      visit('d2', 'b', 'Quarterly Pest Control', '2026-12-07', { window_start: '08:00:00' }),
      visit('d3', 'c', 'Quarterly Pest Control', '2026-12-07', { window_start: null }),
    ];
    const groups = deriveDemand({ visits: visitsDay, forecast: { products: [], serviceIds: [] }, mix: resolveHouseMix([{ id: 'cross', name: 'LESCO CrossCheck Plus', inventory_unit: 'fl_oz' }]), kit: [] });
    expect(['a', 'b', 'c'].map((k) => groups.get(k).firstAt)).toEqual(['2026-12-07T13:00:00', '2026-12-07T08:00:00', '2026-12-07T99']);
    const out = run(groups, [plan({ id: 'cross', onHand: 2.5 })]);
    expect(out.get('b').items).toEqual([]); // 08:00 takes the 2.5 fl oz
    expect(out.get('a').items[0].shortQty).toBe(2.5);
    expect(out.get('c').items[0].shortQty).toBe(2.5);
  });

  test('a house-mix product missing from the catalog is a warning on each list whose visits need the mix', () => {
    const mix = resolveHouseMix([{ id: 'cross', name: 'LESCO CrossCheck Plus', inventory_unit: 'fl_oz' }]);
    const groups = deriveDemand({
      visits: [visit('p1', 'a', 'Quarterly Pest Control'), visit('p2', 'b', 'Lawn Care Treatment')],
      forecast: { products: [], serviceIds: ['p2'] }, mix, kit: [],
    });
    const out = planGroups({ groups, products: new Map(), techs });
    expect(out.get('a').warnings).toEqual(['The pest house mix is missing from the catalog (surfactant, taurus sc), so it is left out']);
    expect(out.get('b').warnings).toEqual([]); // no pest visit, no mix needed
  });

  test('a visit with no technician goes to the unassigned list', () => {
    const groups = deriveDemand({ visits: [visit('u1', null, 'Quarterly Pest Control')], forecast: { products: [], serviceIds: [] }, mix: resolveHouseMix([{ id: 'cross', name: 'LESCO CrossCheck Plus', inventory_unit: 'fl_oz' }]), kit: [] });
    expect([...groups.keys()]).toEqual([UNASSIGNED]);
  });
});

describe('stock, packs and cost', () => {
  test('two lists share one company count, earliest first visit first', () => {
    const groups = new Map([
      ['b', group([['p1', demand(200)]], { firstAt: '2026-12-09' })],
      ['a', group([['p1', demand(200)]], { firstAt: '2026-12-07' })],
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

  test('an unassigned visit on Monday never takes stock ahead of an assigned technician whose first visit is Tuesday', () => {
    const groups = new Map([
      [UNASSIGNED, group([['p1', demand(100)]], { firstAt: '2026-12-07' })],
      ['b', group([['p1', demand(100)]], { firstAt: '2026-12-08' })],
    ]);
    const out = run(groups, [plan({ onHand: 100 })]);
    expect(out.get('b').items).toEqual([]);
    expect(out.get(UNASSIGNED).items[0]).toMatchObject({ shortQty: 100, packs: 1 });
  });

  test('whole packs round up; cost is packs x price, plus tax only when the row carries one', () => {
    const at = (qty, over) => run(new Map([['a', group([['p1', demand(qty)]])]]), [plan(over)]).get('a').items[0];
    expect(at(129)).toMatchObject({ shortQty: 129, packs: 2, packLabel: '1 gal', estCostCents: 20000, vendorName: 'Synthetic Supply' });
    expect(at(128)).toMatchObject({ packs: 1, estCostCents: 10000 });
    expect(at(10, { packCents: 10700 })).toMatchObject({ packs: 1, estCostCents: 10700 });
    expect(run(new Map([['a', group([['p1', demand(10)]])]]), [plan()]).get('a').estTotalCents).toBe(10000);
  });

  test('what is already ordered counts as supply: the line shows it and buys only the rest', () => {
    const out = run(new Map([['a', group([['p1', demand(300)]])]]), [plan({ onHand: 50, onOrder: 200 })]).get('a');
    expect(out.items[0]).toMatchObject({ needQty: 300, onHand: 50, onOrder: 200, shortQty: 50, packs: 1 });
    const covered = run(new Map([['a', group([['p1', demand(200)]])]]), [plan({ onHand: 50, onOrder: 200 })]).get('a');
    expect(covered.items).toEqual([]);
  });

  test('two technicians split one stock and one open order, first visit first', () => {
    const groups = new Map([
      ['a', group([['p1', demand(150)]], { firstAt: '2026-12-07' })],
      ['b', group([['p1', demand(150)]], { firstAt: '2026-12-08' })],
    ]);
    const out = run(groups, [plan({ onHand: 100, onOrder: 100 })]);
    expect(out.get('a').items).toEqual([]); // 100 + 50 of the 200 supply
    expect(out.get('b').items[0]).toMatchObject({ needQty: 150, onOrder: 100, shortQty: 100, packs: 1 }); // the remaining 50, then 100 to buy
  });

  describe('no rounding before the pack ceiling', () => {
    const gal = (over) => plan({ unit: 'gal', pack: { pack: 1 }, packLabel: '1 gal', ...over });
    const shortOf = (need, over) => run(new Map([['a', group([['p1', demand(need, 'gal')]])]]), [gal(over)]).get('a').items[0];

    test('a hair over one pack buys two: 1.00003 gal short is 2 one-gallon packs', () => {
      expect(shortOf(1.00003)).toMatchObject({ shortQty: 1.00003, needQty: 1.00003, packs: 2 });
      expect(shortOf(1.000001).packs).toBe(2);
      expect(shortOf(0.00003).packs).toBe(1);
    });

    test('float noise is not a real amount: a need that is a pack plus 1e-10 buys one pack, and 0.1 + 0.2 meets 0.3', () => {
      expect(shortOf(1 + 1e-10).packs).toBe(1);
      expect(shortOf(0.1 + 0.2, { pack: { pack: 0.3 } }).packs).toBe(1);
      // stock of 0.3 covers a need of 0.30000000000000004 exactly: nothing to buy
      expect(run(new Map([['a', group([['p1', demand(0.1 + 0.2, 'gal')]])]]), [gal({ onHand: 0.3 })]).get('a').items).toEqual([]);
    });

    test('allocation, on-order and the spare floor keep the small amount too', () => {
      // 0.00003 gal short after stock and an order, still one whole pack to buy
      const small = run(new Map([['a', group([['p1', demand(2.00003, 'gal')]])]]), [gal({ onHand: 1, onOrder: 1 })]).get('a').items[0];
      expect(small.packs).toBe(1);
      expect(small.shortQty).toBeCloseTo(0.00003, 10);
      // floor: 2.00003 gal left after the week is over one pack; 0.99997 left is under one
      const liquid = (over) => gal({ floorKey: 'crosscheck_plus', ...over });
      expect(run(new Map([['a', group([['p1', demand(1, 'gal', ['pest_mix'])]])]]), [liquid({ onHand: 3.00003 })]).get('a').items).toEqual([]);
      expect(run(new Map([['a', group([['p1', demand(1, 'gal', ['pest_mix'])]])]]), [liquid({ onHand: 1.99997 })]).get('a').items[0]).toMatchObject({ packs: 1, reasons: ['pest_mix', 'spare_floor'] });
    });
  });

  test('a need in another unit is converted to the stock unit', () => {
    const out = run(new Map([['a', group([['p1', demand(1.5, 'gal')]])]]), [plan()]).get('a');
    expect(out.items[0]).toMatchObject({ needQty: 192, shortQty: 192, packs: 2 });
  });

  test('no price on file: the shortage is listed with no packs and no cost, and the note says why', () => {
    const out = run(new Map([['a', group([['p1', demand(40)]])]]), [plan({ picked: { row: null, vendorName: null }, pack: null, packLabel: null, price: null, packCents: null })]).get('a');
    expect(out.items[0]).toMatchObject({ shortQty: 40, packs: null, estCostCents: null, vendorName: null });
    expect(out.notes).toContain('Synthetic Liquid: no price on file.');
    expect(out.estTotalCents).toBeNull();
    expect(out.unpricedLines).toBe(1);
  });

  test('a priced line beside an unpriced one: the total is partial and the group says how many lines it leaves out', () => {
    const unpriced = plan({ id: 'p2', name: 'Unpriced Liquid', picked: { row: null, vendorName: null }, pack: null, packLabel: null, price: null, packCents: null });
    const out = run(new Map([['a', group([['p1', demand(10)], ['p2', demand(10)]])]]), [plan(), unpriced]).get('a');
    expect(out).toMatchObject({ estTotalCents: 10000, unpricedLines: 1 });
    // a fertilizer hold is not an unpriced line to buy
    const held = run(new Map([['a', group([['p1', demand(10)]])]]), [plan({ hold: true })]).get('a');
    expect(held.unpricedLines).toBe(0);
  });

  describe('the cost of a pack is resolved the way the Inventory price comparison resolves a row', () => {
    const NOW = new Date('2026-12-09T12:00:00Z');
    const packOf = (over) => toPlanProduct({
      row: { id: 'p1', name: 'Synthetic Liquid', inventory_unit: 'fl_oz', inventory_on_hand: '0' }, now: NOW,
      pricing: [{ product_id: 'p1', vendor_id: 'v', quantity: '1 gal', is_best_price: true, price: '90', price_amount: '90', ...over }],
    });

    test('stated shipping and tax: the catalog landed cost; a delivery or hazmat estimate on top reads "plus shipping"', () => {
      expect(packOf({ shipping_cost: '10', tax_rate: '0.1' })).toMatchObject({ packCents: 11000, plusShipping: false });
      expect(packOf({ shipping_cost: '10', hazmat_fee_estimate: '5' })).toMatchObject({ packCents: 10000, plusShipping: true });
    });

    test('a price-sync row with only a landed unit price (per ounce) costs the pack at that delivered price', () => {
      const row = { landed_unit_price: '0.8', unit_normalized: 'oz', normalized_unit_price: '0.703125', source_type: 'price_report' };
      expect(packOf(row)).toMatchObject({ packCents: 10240, plusShipping: false }); // 0.80 x 128 oz
    });

    test('delivery in a form that gives no pack cost: the line has no price, never the sticker', () => {
      expect(packOf({ landed_unit_price: '0.8', unit_normalized: 'lot', source_type: 'price_report' }).packCents).toBeNull();
      expect(packOf({ hazmat_fee_estimate: '5' }).packCents).toBeNull();
      const list = run(new Map([['a', group([['p1', demand(10)]])]]), [{ ...packOf({ hazmat_fee_estimate: '5' }), id: 'p1' }]).get('a');
      expect(list.items[0]).toMatchObject({ packs: 1, estCostCents: null });
      expect(list).toMatchObject({ estTotalCents: null, unpricedLines: 1 });
      expect(list.notes).toContain('Synthetic Liquid: the price row\'s delivery cost cannot be worked out, so the line has no price.');
    });

    test('a row with no delivery information is its sticker price', () => {
      expect(packOf({}).packCents).toBe(9000);
    });

    test('a priced line that carries an estimate marks the group', () => {
      const shipped = run(new Map([['a', group([['p1', demand(10)]])]]), [plan({ plusShipping: true })]).get('a');
      expect(shipped.items[0]).toMatchObject({ estCostCents: 10000, plusShipping: true });
      expect(shipped.shippingLines).toBe(1);
    });
  });

  describe('the technician\'s branch decides the price row', () => {
    const NOW = new Date('2026-12-09T12:00:00Z');
    const rowOf = (over) => ({ product_id: 'p1', vendor_id: 'v1', vendor_name: 'SiteOne', branch_name: null, quantity: '1 gal', is_best_price: false, price: '90', price_amount: '90', ...over });
    const productOf = (rows) => ({ ...toPlanProduct({ row: { id: 'p1', name: 'Synthetic Liquid', inventory_unit: 'fl_oz', inventory_on_hand: '0' }, now: NOW, pricing: rows }), id: 'p1' });
    const listFor = (store, rows) => run(new Map([['a', group([['p1', demand(10)]])]]), [productOf(rows)], new Map([['a', { name: 'Alex Sample', supplyStore: store }]])).get('a');
    const rows = [
      rowOf({ branch_name: 'Bradenton', price: '80', price_amount: '80', is_best_price: true }),
      rowOf({ branch_name: 'Sarasota', price: '95', price_amount: '95' }),
      rowOf({ vendor_id: 'v2', vendor_name: 'Other Supply', branch_name: 'Sarasota', price: '85', price_amount: '85' }),
    ];

    test('the store\'s branch row wins over the best-price row; a whole word of the store text, case and spacing ignored', () => {
      expect(listFor('SiteOne Sarasota', rows).items[0]).toMatchObject({ estCostCents: 9500, otherBranch: false });
      expect(listFor('  siteone   SARASOTA ', rows).items[0]).toMatchObject({ estCostCents: 9500 });
      // no supplier in the text: the lower sticker price of the branch rows wins (85.00 + the comparison's 15.00 estimate for a vendor with no rule)
      expect(listFor('Sarasota', rows).items[0]).toMatchObject({ estCostCents: 10000 });
    });

    test('no match: the current pick, and the line says it is not from the store\'s branch', () => {
      const out = listFor('SiteOne Venice', rows);
      expect(out.items[0]).toMatchObject({ estCostCents: 8000, otherBranch: true });
      expect(listFor('Sarasotan Supply', rows).items[0]).toMatchObject({ estCostCents: 8000, otherBranch: true }); // a part of a word is not a match
    });

    test('no store: the current pick and no note', () => {
      expect(listFor(null, rows).items[0]).toMatchObject({ estCostCents: 8000, otherBranch: false });
      expect(listFor('   ', rows).items[0]).toMatchObject({ estCostCents: 8000, otherBranch: false });
    });

    test('a branch row of another vendor than the product\'s set vendor is not used', () => {
      const own = { ...productOf(rows), catalogRow: { auto_reorder_vendor_id: 'v2' } };
      const out = run(new Map([['a', group([['p1', demand(10)]])]]), [own], new Map([['a', { name: 'Alex Sample', supplyStore: 'SiteOne Sarasota' }]])).get('a');
      expect(out.items[0]).toMatchObject({ estCostCents: 10000 }); // Other Supply's Sarasota row (85.00 + 15.00 estimate), not SiteOne's 95.00
    });
  });

  describe('a pack sold by item count is costed with its delivery', () => {
    const NOW = new Date('2026-12-09T12:00:00Z');
    const countPack = (over) => toPlanProduct({
      row: { id: 'p1', name: 'Synthetic Sign', inventory_unit: 'each', inventory_on_hand: '0' }, now: NOW,
      pricing: [{ product_id: 'p1', vendor_id: 'v', quantity: '25 ea', is_best_price: true, price: '50', price_amount: '50', ...over }],
    });

    test('stated shipping and tax, a per-item landed price, or a shipping estimate is in the pack cost; unresolvable delivery is unpriced', () => {
      expect(countPack({ shipping_cost: '5' }).packCents).toBe(5500);
      expect(countPack({ landed_unit_price: '2.4', unit_normalized: 'each', source_type: 'price_report' }).packCents).toBe(6000); // 25 x 2.40
      expect(countPack({ shipping_estimate: '10' }).packCents).toBe(6000);
      expect(countPack({ landed_unit_price: '2.4', unit_normalized: 'lot', source_type: 'price_report' }).packCents).toBeNull();
      expect(countPack({}).packCents).toBe(5000);
      // free delivery: a landed per-item price equal to the sticker per-item price (50 / 25) is a valid quote, not an unknown
      expect(countPack({ landed_unit_price: '2', unit_normalized: 'each', source_type: 'price_report' }).packCents).toBe(5000);
    });
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

describe('spare floor (one container\'s worth of the everyday liquids, as a volume)', () => {
  const liquid = (over) => plan({ floorKey: 'crosscheck_plus', ...over });
  const items = (qty, over, g = {}) => run(new Map([['a', group([['p1', demand(qty, 'fl_oz', ['pest_mix'])], ...(g.more || [])])]]), [liquid(over)]).get('a').items;
  const noteOf = (qty, over) => run(new Map([['a', group([['p1', demand(qty, 'fl_oz', ['pest_mix'])]])]]), [liquid({ packLabel: '1 gal', ...over })]).get('a');

  test('adds one container when less than one container would be left after the week', () => {
    expect(items(10, { onHand: 0 })[0]).toMatchObject({ shortQty: 10, packs: 2, reasons: ['pest_mix', 'spare_floor'] }); // 1 to cover, 118 left: 1 more
    expect(items(10, { onHand: 100 })[0]).toMatchObject({ shortQty: 0, packs: 1, reasons: ['pest_mix', 'spare_floor'] }); // covered, but only 90 would be left
    expect(items(100, { onHand: 200 })[0]).toMatchObject({ shortQty: 0, packs: 1, reasons: ['pest_mix', 'spare_floor'] }); // 100 left
  });

  test('adds nothing, and says nothing, when one container or more would be left', () => {
    for (const onHand of [138, 200, 266, 300, 400]) { // 128, 190, 256, 290 and 390 left
      const out = noteOf(10, { onHand });
      expect(out.items).toEqual([]);
      expect(out.warnings).toEqual([]);
      expect(out.notes).toEqual([]);
    }
  });

  test('stock on order and the volume bought both count as left over', () => {
    expect(items(10, { onHand: 0, onOrder: 256 })).toEqual([]); // 246 left
    expect(items(10, { onHand: 0, onOrder: 128 })[0]).toMatchObject({ shortQty: 0, packs: 1, reasons: ['pest_mix', 'spare_floor'] }); // 118 left
  });

  test('adds it once across two lists, to the first technician with the need', () => {
    const groups = new Map([
      ['a', group([['p1', demand(128, 'fl_oz', ['pest_mix'])]], { firstAt: '2026-12-07' })],
      ['b', group([['p1', demand(128, 'fl_oz', ['pest_mix'])]], { firstAt: '2026-12-08' })],
    ]);
    const out = run(groups, [liquid({ onHand: 0 })]);
    expect(out.get('a').items[0]).toMatchObject({ packs: 2, reasons: ['pest_mix', 'spare_floor'] });
    expect(out.get('b').items[0]).toMatchObject({ packs: 1, reasons: ['pest_mix'] });
  });

  test('it is worked out company-wide: two technicians with small needs each buy a pack, and the volume left is already enough', () => {
    const groups = new Map([
      ['a', group([['p1', demand(10, 'fl_oz', ['pest_mix'])]], { firstAt: '2026-12-07' })],
      ['b', group([['p1', demand(10, 'fl_oz', ['pest_mix'])]], { firstAt: '2026-12-08' })],
    ]);
    const out = run(groups, [liquid({ onHand: 0 })]);
    expect(out.get('a').items[0]).toMatchObject({ packs: 1, reasons: ['pest_mix'] });
    expect(out.get('b').items[0]).toMatchObject({ packs: 1, reasons: ['pest_mix'] });
  });

  test('two opened jugs read as one volume: 0.75 gal + 0.75 gal on hand with 0.1 gal used leaves 1.4 gal, so nothing', () => {
    const gal = (over) => plan({ unit: 'gal', pack: { pack: 1 }, packLabel: '1 gal', floorKey: 'crosscheck_plus', onHand: 1.5, ...over });
    const out = run(new Map([['a', group([['p1', demand(0.1, 'gal', ['pest_mix'])]])]]), [gal()]).get('a');
    expect(out.items).toEqual([]);
    expect(out.warnings).toEqual([]);
  });

  test('the live example buys one: 1.34 gal on hand, 0.55 gal needed, 1 gal packs leaves 0.79 gal', () => {
    const gal = plan({ unit: 'gal', pack: { pack: 1 }, packLabel: '1 gal', floorKey: 'crosscheck_plus', onHand: 1.34 });
    const out = run(new Map([['a', group([['p1', demand(0.55, 'gal', ['pest_mix'])]])]]), [gal]).get('a');
    expect(out.items[0]).toMatchObject({ shortQty: 0, packs: 1, reasons: ['pest_mix', 'spare_floor'] });
  });

  test('packs bought to cover a shortage count in the volume left', () => {
    expect(noteOf(300, { onHand: 0 }).items[0]).toMatchObject({ packs: 4, reasons: ['pest_mix', 'spare_floor'] }); // 3 packs leave 84: one more
    expect(noteOf(256, { onHand: 0 }).items[0].packs).toBe(3); // two packs leave none: one more
    expect(noteOf(200, { onHand: 0 }).items[0]).toMatchObject({ packs: 3, reasons: ['pest_mix', 'spare_floor'] }); // 2 packs leave 56: one more
    expect(noteOf(100, { onHand: 0 }).items[0]).toMatchObject({ packs: 2, reasons: ['pest_mix', 'spare_floor'] }); // 1 pack leaves 28: one more
  });

  describe('two technicians on different pack sizes (a branch row can carry another size)', () => {
    const NOW = new Date('2026-12-09T12:00:00Z');
    const rowOf = (branch, quantity) => ({ product_id: 'p1', vendor_id: 'v1', vendor_name: 'SiteOne', branch_name: branch, quantity, is_best_price: branch === 'North', price: '90', price_amount: '90', shipping_cost: '0' });
    const product = () => ({ ...toPlanProduct({ row: { id: 'p1', name: 'Synthetic Liquid', inventory_unit: 'fl_oz', inventory_on_hand: '0' }, now: NOW, floorKey: 'crosscheck_plus', pricing: [rowOf('North', '1 gal'), rowOf('South', '2.5 gal')] }), id: 'p1' });
    const stores = new Map([['a', { name: 'Alex Sample', supplyStore: 'North' }], ['b', { name: 'Blake Sample', supplyStore: 'South' }]]);
    const lists = (aNeed, bNeed) => run(new Map([
      ['a', group([['p1', demand(aNeed, 'fl_oz', ['pest_mix'])]], { firstAt: '2026-12-07' })],
      ['b', group([['p1', demand(bNeed, 'fl_oz', ['pest_mix'])]], { firstAt: '2026-12-08' })],
    ]), [product()], stores);

    test('each line\'s packs are summed in its own pack size: a 1 gal pack and a 2.5 gal pack leave exactly one pack of the first, so no spare', () => {
      const out = lists(10, 310); // 128 + 320 bought, 320 needed: 128 left = one 1 gal pack
      expect(out.get('a').items[0]).toMatchObject({ packs: 1, packLabel: '1 gal', reasons: ['pest_mix'] });
      expect(out.get('b').items[0]).toMatchObject({ packs: 1, packLabel: '2.5 gal', reasons: ['pest_mix'] });
    });

    test('under one pack of the spare-taker\'s size left: it buys one more pack of ITS size', () => {
      const out = lists(130, 300); // 256 + 320 bought, 430 needed: 146 left, over one 1 gal pack (128)
      expect(out.get('a').items[0].reasons).toEqual(['pest_mix']);
      const short = lists(200, 300); // 256 + 320 bought, 500 needed: 76 left, under 128
      expect(short.get('a').items[0]).toMatchObject({ packs: 3, packLabel: '1 gal', reasons: ['pest_mix', 'spare_floor'] });
      expect(short.get('b').items[0]).toMatchObject({ packs: 1, packLabel: '2.5 gal' });
    });
  });

  test('never for the surfactant or a lawn product', () => {
    expect(items(0.5, { onHand: 0, floorKey: 'surfactant' })[0]).toMatchObject({ packs: 1, reasons: ['pest_mix'] });
    expect(run(new Map([['a', group([['p1', demand(10)]])]]), [plan({ onHand: 100 })]).get('a').items).toEqual([]);
  });

  test('no pack size on file: the spare cannot be worked out, and the list says so', () => {
    const out = run(new Map([['a', group([['p1', demand(10, 'fl_oz', ['pest_mix'])]])]]), [liquid({ onHand: 100, pack: { error: 'no_pack_size', message: 'No pack size on the price row.' } })]).get('a');
    expect(out.items).toEqual([]);
    expect(out.warnings).toEqual(['No pack size on file for Synthetic Liquid, so the spare cannot be worked out.']);
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
    // the comparison adds its freight estimate for a vendor it has no rule for: 40.00 + 40.00 per pack
    expect(out.items[0]).toMatchObject({ packs: 2, packLabel: '50 lb', estCostCents: 16000 });
  });
});

describe('buildWeeklyBuyList read wiring', () => {
  beforeEach(() => {
    profiles.resolveCompletionProfileForScheduledService.mockReset();
    profiles.resolveCompletionProfileForScheduledService.mockResolvedValue({ completionMode: 'service_report', findingsType: null, projectType: null });
  });

  // A knex stand-in: every builder method chains; awaiting it returns the next canned result for that table.
  function fakeKnex(results) {
    const calls = [];
    const make = (table) => {
      const chain = {};
      for (const m of ['whereBetween', 'where', 'whereNull', 'orWhereNotIn', 'whereIn', 'whereRaw', 'leftJoin', 'orderBy', 'select', 'orWhere', 'whereNotIn', 'whereNotNull', 'orWhereNull']) {
        chain[m] = jest.fn((...args) => { if (m === 'where' && typeof args[0] === 'function') args[0].call(chain, chain); return chain; });
      }
      chain.then = (res, rej) => Promise.resolve((results[table] || []).shift() ?? []).then(res, rej);
      calls.push({ table, chain });
      return chain;
    };
    const knex = jest.fn(make);
    knex.calls = calls;
    knex.raw = jest.fn(() => 'RAW');
    // the supply reads run in one snapshot transaction: the fake runs them on itself
    knex.transaction = jest.fn(async (read, options) => read(knex, options));
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
    expect(forecastModule.buildWaveGuardInventoryForecast).toHaveBeenCalledWith({ knex, startDate: '2026-12-09', endDate: '2026-12-12', limit: 300, narrow: { excludeStatuses: ['completed', 'cancelled', 'canceled', 'void', 'rescheduled', 'skipped', 'no_show'], bookedOnly: true } });
    expect(knex.calls[0].chain.whereBetween).toHaveBeenCalledWith('ss.scheduled_date', ['2026-12-09', '2026-12-12']);
    expect(list).toMatchObject({ weekStart: '2026-12-07', weekEnd: '2026-12-12', fromDate: '2026-12-09', unassigned: { technicianId: null, items: [] } });
    expect(list.warnings).toEqual([]);
    expect(list.technicians).toHaveLength(1);
    expect(list.technicians[0]).toMatchObject({
      technicianId: 'a', technicianName: 'Alex Sample', supplyStore: 'Synthetic Supply North',
      // 15 short is one container; 5 + 128 - 20 leaves 113, under a full container, so the house liquid keeps one spare.
      items: [{ productId: 'cross', needQty: 20, onHand: 5, shortQty: 15, packs: 2, estCostCents: 21000, vendorName: 'Synthetic Supply', reasons: ['lawn_plan', 'spare_floor'] }], // 90.00 + the comparison's 15.00 estimate for an unknown vendor, per pack
      estTotalCents: 21000, notes: [], warnings: [],
    });
  });

  test('each visit\'s close-out kind is read from its completion profile and the booking read drops slot holds', async () => {
    profiles.resolveCompletionProfileForScheduledService.mockImplementation(async (v) => (
      v.service_type === 'Waves Assessment' ? { completionMode: 'internal_only', findingsType: null, projectType: null } : { completionMode: 'service_report', findingsType: null, projectType: null }));
    forecastModule.buildWaveGuardInventoryForecast.mockResolvedValue({ serviceIds: [], serviceCount: 0, errors: [], skippedNonProgram: [], products: [] });
    const knex = fakeKnex({
      'scheduled_services as ss': [[visit('s1', 'a', 'Waves Assessment', '2026-12-09', { service_id: 'svc-1' }), visit('s2', 'a', 'Termite Bait Check', '2026-12-09', { service_id: 'svc-2' })]],
      technicians: [[{ id: 'a', name: 'Alex Sample', supply_store: null }]],
      products_catalog: [[], [{ id: 'notice', per_completion_usage: 1, per_completion_service_lines: ['termite', 'pest'], inventory_unit: 'each' }]],
      'products_catalog as pc': [[{ id: 'notice', name: 'Notice Card', inventory_unit: 'each', inventory_on_hand: 0 }]],
    });
    const list = await buildWeeklyBuyList({ knex, now: new Date('2026-12-09T12:00:00Z') });
    expect(profiles.resolveCompletionProfileForScheduledService).toHaveBeenCalledTimes(2);
    // the assessment leaves no notice card; the bait check leaves one
    expect(list.technicians[0].items).toMatchObject([{ productId: 'notice', needQty: 1 }]);
    const holdFilter = knex.calls[0].chain.where.mock.calls.map(([f]) => f).filter((f) => typeof f === 'function');
    expect(holdFilter).toHaveLength(2);
  });

  test('the pest mix asks for Taurus once for the whole week, and an unknown answer leaves it off with a warning', async () => {
    forecastModule.buildWaveGuardInventoryForecast.mockResolvedValue({ serviceIds: [], serviceCount: 0, errors: [], skippedNonProgram: [], products: [] });
    taurusModule.projectTaurusEligibility.mockResolvedValue({ fits: new Map([['q1', true], ['q2', false]]), failed: true });
    const mixRows = [
      { id: 'taurus', name: 'Taurus SC', inventory_unit: 'fl_oz' }, { id: 'cross', name: 'LESCO CrossCheck Plus', inventory_unit: 'fl_oz' },
      { id: 'surf', name: 'LESCO 90/10 Nonionic Surfactant', inventory_unit: 'fl_oz' },
    ];
    const knex = fakeKnex({
      'scheduled_services as ss': [[
        visit('q1', 'a', 'Quarterly Pest Control', '2026-12-09', { customer_id: 'c1', property_id: 'h1' }),
        visit('q2', 'a', 'Quarterly Pest Control', '2026-12-10', { customer_id: 'c1', property_id: 'h1' }),
        visit('q3', 'a', 'Cockroach Control', '2026-12-10', { customer_id: 'c1', property_id: 'h1' }),
      ]],
      technicians: [[{ id: 'a', name: 'Alex Sample', supply_store: null }]],
      products_catalog: [mixRows, []],
      'products_catalog as pc': [mixRows.map((r) => ({ ...r, inventory_on_hand: 0 }))],
      vendor_pricing: [['taurus', 'cross'].map((id) => ({ product_id: id, vendor_id: 'v', vendor_name: 'Synthetic Supply', quantity: '1 gal', is_best_price: true, price: '90', price_amount: '90', tax_rate: null }))],
    });
    const list = await buildWeeklyBuyList({ knex, now: new Date('2026-12-09T12:00:00Z') });
    // only the general-pest visits are asked about, once
    expect(taurusModule.projectTaurusEligibility).toHaveBeenCalledTimes(1);
    expect(taurusModule.projectTaurusEligibility.mock.calls[0][0].map((v) => v.id)).toEqual(['q1', 'q2']);
    expect(list.warnings).toEqual(['Taurus SC yearly counts could not be read, so Taurus is left out of every pest visit this week.']);
    const taurus = list.technicians[0].items.find((i) => i.productId === 'taurus');
    expect(taurus.needQty).toBe(1.6); // q1 fits, q2 does not
  });

  test('an order already placed or marked ordered is read once for the week and shown on the line', async () => {
    forecastModule.buildWaveGuardInventoryForecast.mockResolvedValue({
      serviceIds: ['v1'], serviceCount: 1, errors: [], skippedNonProgram: [],
      products: [{ productId: 'cross', inventoryUnit: 'fl_oz', appointments: [{ serviceId: 'v1', inventoryAmount: 400 }], mismatchAppointments: [] }],
    });
    const knex = fakeKnex({
      'scheduled_services as ss': [[visit('v1', 'a', 'Lawn Care Treatment', '2026-12-09')]],
      technicians: [[{ id: 'a', name: 'Alex Sample', supply_store: null }]],
      products_catalog: [[], []],
      'products_catalog as pc': [[{ id: 'cross', name: 'Synthetic Liquid', inventory_unit: 'fl_oz', inventory_on_hand: '50' }]],
      vendor_pricing: [[{ product_id: 'cross', vendor_id: 'v', vendor_name: 'Synthetic Supply', quantity: '1 gal', is_best_price: true, price: '90', price_amount: '90', tax_rate: null }]],
      'product_restock_requests as prr': [[
        { product_id: 'cross', requested_quantity: '100', unit: 'fl_oz', request_payload: JSON.stringify({ orderedQuantity: 128 }) }, // dispatched order: what the packages hold
        { product_id: 'cross', requested_quantity: '1', unit: 'gal', request_payload: null }, // marked ordered by hand: 1 gal = 128 fl oz
        { product_id: 'cross', requested_quantity: '1', unit: 'lb', request_payload: null }, // does not convert: reported, not counted
        { product_id: 'cross', requested_quantity: '20', unit: null, request_payload: null }, // no unit: read in the stock unit, as Receive does
      ]],
    });
    const list = await buildWeeklyBuyList({ knex, now: new Date('2026-12-09T12:00:00Z') });
    expect(knex.calls.filter((c) => c.table === 'product_restock_requests as prr')).toHaveLength(1);
    // 50 on hand + 276 on order cover 326 of the 400 needed: 74 fl oz to buy, one 1 gal pack
    expect(list.technicians[0].items).toMatchObject([{ needQty: 400, onHand: 50, onOrder: 276, shortQty: 74, packs: 1 }]);
    expect(list.warnings).toEqual(['An order already placed is in a unit that does not convert to its stock unit, so it is not counted as on order.']);
  });

  test('every read of the list (visits, forecast, Taurus ledger, catalog, prices, on order) runs in one REPEATABLE READ read-only snapshot, opened first; a caller\'s own transaction is kept', async () => {
    forecastModule.buildWaveGuardInventoryForecast.mockResolvedValue({ serviceIds: ['v1'], serviceCount: 1, errors: [], skippedNonProgram: [],
      products: [{ productId: 'cross', inventoryUnit: 'fl_oz', appointments: [{ serviceId: 'v1', inventoryAmount: 20 }], mismatchAppointments: [] }] });
    const results = () => ({
      'scheduled_services as ss': [[visit('v1', 'a', 'Lawn Care Treatment', '2026-12-09')]],
      technicians: [[{ id: 'a', name: 'Alex Sample', supply_store: null }]],
      products_catalog: [[], []],
      'products_catalog as pc': [[{ id: 'cross', name: 'Synthetic Liquid', inventory_unit: 'fl_oz', inventory_on_hand: '5' }]],
    });
    const knex = fakeKnex(results());
    await buildWeeklyBuyList({ knex, now: new Date('2026-12-09T12:00:00Z') });
    expect(knex.transaction).toHaveBeenCalledTimes(1);
    expect(knex.transaction.mock.calls[0][1]).toEqual({ isolationLevel: 'repeatable read', readOnly: true });
    // the snapshot opened before the first read of anything, and the forecast and Taurus ledger were handed the snapshot
    const opened = knex.transaction.mock.invocationCallOrder[0];
    expect(Math.min(...knex.mock.invocationCallOrder)).toBeGreaterThan(opened);
    expect(knex.calls[0].table).toBe('scheduled_services as ss');
    expect(forecastModule.buildWaveGuardInventoryForecast.mock.calls.at(-1)[0].knex).toBe(knex);
    expect(forecastModule.buildWaveGuardInventoryForecast.mock.invocationCallOrder.at(-1)).toBeGreaterThan(opened);
    const own = fakeKnex(results());
    own.isTransaction = true;
    await buildWeeklyBuyList({ knex: own, now: new Date('2026-12-09T12:00:00Z') });
    expect(own.transaction).not.toHaveBeenCalled();
  });

  test('a warning about the whole list is attached to every list it affects, so a list with nothing short still carries it', async () => {
    taurusModule.projectTaurusEligibility.mockResolvedValue({ fits: new Map([['w1', false]]), failed: true });
    forecastModule.buildWaveGuardInventoryForecast.mockResolvedValue({ serviceIds: [], serviceCount: 300, errors: [], skippedNonProgram: [], products: [] });
    const mixRows = [
      { id: 'taurus', name: 'Taurus SC', inventory_unit: 'fl_oz' }, { id: 'cross', name: 'LESCO CrossCheck Plus', inventory_unit: 'fl_oz' },
      { id: 'surf', name: 'LESCO 90/10 Nonionic Surfactant', inventory_unit: 'fl_oz' },
    ];
    const knex = fakeKnex({
      'scheduled_services as ss': [[
        visit('w1', 'a', 'Quarterly Pest Control', '2026-12-09'), // a pest visit: the Taurus warning
        visit('w2', 'b', 'Lawn Care Treatment', '2026-12-09'), // a lawn visit not read by the capped forecast: the cap warning
        visit('w3', 'c', 'Quarterly Pest Control', '2026-12-09'), // a pest visit with plenty on hand: nothing short, still carries the warning
      ]],
      technicians: [[{ id: 'a', name: 'Alex Sample' }, { id: 'b', name: 'Blake Sample' }, { id: 'c', name: 'Casey Sample' }]],
      products_catalog: [mixRows, []],
      'products_catalog as pc': [mixRows.map((r) => ({ ...r, inventory_on_hand: 100000 }))],
    });
    const list = await buildWeeklyBuyList({ knex, now: new Date('2026-12-09T12:00:00Z') });
    const warningsOf = (id) => list.technicians.find((t) => t.technicianId === id).warnings;
    expect(warningsOf('a')).toContain('Taurus SC yearly counts could not be read, so Taurus is left out of every pest visit this week.');
    expect(warningsOf('c')).toContain('Taurus SC yearly counts could not be read, so Taurus is left out of every pest visit this week.');
    expect(list.technicians.find((t) => t.technicianId === 'c').items).toEqual([]); // nothing short, and still an alert's worth of content
    expect(warningsOf('b')).toContain('The lawn forecast stopped at 300 visits, so lawn needs may read low.');
    expect(warningsOf('b')).not.toContain('Taurus SC yearly counts could not be read, so Taurus is left out of every pest visit this week.'); // no pest visit
    expect(warningsOf('a')).not.toContain('The lawn forecast stopped at 300 visits, so lawn needs may read low.'); // no lawn visit
  });

  test('a product with need that left the catalog is a warning on the lists that need it', async () => {
    forecastModule.buildWaveGuardInventoryForecast.mockResolvedValue({ serviceIds: ['v1'], serviceCount: 1, errors: [], skippedNonProgram: [],
      products: [{ productId: 'gone', inventoryUnit: 'gal', appointments: [{ serviceId: 'v1', inventoryAmount: 1 }], mismatchAppointments: [] }] });
    const knex = fakeKnex({
      'scheduled_services as ss': [[visit('v1', 'a', 'Lawn Care Treatment', '2026-12-09')]],
      technicians: [[{ id: 'a', name: 'Alex Sample' }]], products_catalog: [[], []], 'products_catalog as pc': [[]],
    });
    const list = await buildWeeklyBuyList({ knex, now: new Date('2026-12-09T12:00:00Z') });
    expect(list.technicians[0].warnings).toEqual(['A product with scheduled need is no longer in the catalog, so its need is left out.']);
  });

  describe('an order that is not settled yet is counted, and the list says so', () => {
    const UNSETTLED = 'An order is being placed or waiting for review and is not confirmed yet: it is counted as on order for now.';
    async function listWith(orderStatus) {
      forecastModule.buildWaveGuardInventoryForecast.mockResolvedValue({
        serviceIds: ['v1'], serviceCount: 1, errors: [], skippedNonProgram: [],
        products: [{ productId: 'cross', inventoryUnit: 'fl_oz', appointments: [{ serviceId: 'v1', inventoryAmount: 400 }], mismatchAppointments: [] }],
      });
      const knex = fakeKnex({
        'scheduled_services as ss': [[visit('v1', 'a', 'Lawn Care Treatment', '2026-12-09')]],
        technicians: [[{ id: 'a', name: 'Alex Sample', supply_store: null }]],
        products_catalog: [[], []],
        'products_catalog as pc': [[{ id: 'cross', name: 'Synthetic Liquid', inventory_unit: 'fl_oz', inventory_on_hand: '0' }]],
        'product_restock_requests as prr': [[{ product_id: 'cross', requested_quantity: '400', unit: 'fl_oz', request_payload: null, order_status: orderStatus }]],
      });
      return buildWeeklyBuyList({ knex, now: new Date('2026-12-09T12:00:00Z') });
    }

    test.each(['placing', 'needs_review'])('%s: subtracted (no duplicate buy) and the list keeps a warning, so its alert stays open', async (status) => {
      const list = await listWith(status);
      expect(list.technicians[0].items).toEqual([]); // 400 on order covers the 400 needed
      expect(list.technicians[0].warnings).toEqual([UNSETTLED]);
    });

    test.each(['placed', null])('%s: settled, no warning', async (status) => {
      const list = await listWith(status);
      expect(list.technicians[0].warnings).toEqual([]);
    });
  });

  test('a per-visit supply whose service lines are corrupt is a warning on every list, never silently no need', async () => {
    forecastModule.buildWaveGuardInventoryForecast.mockResolvedValue({ serviceIds: [], serviceCount: 0, errors: [], skippedNonProgram: [], products: [] });
    const knex = fakeKnex({
      'scheduled_services as ss': [[visit('k1', 'a', 'Quarterly Pest Control', '2026-12-09')]],
      technicians: [[{ id: 'a', name: 'Alex Sample' }]],
      products_catalog: [[], [{ id: 'sign', per_completion_usage: 1, per_completion_service_lines: 'not-a-list', inventory_unit: 'each' }]],
    });
    const list = await buildWeeklyBuyList({ knex, now: new Date('2026-12-09T12:00:00Z') });
    expect(list.technicians[0].warnings).toContain('A per-visit supply has service lines that are not a list, so its need is left out.');
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
    expect(list.warnings).toEqual(['The lawn forecast stopped at 300 visits, so lawn needs may read low.']); // also kept at list level
  });
});
