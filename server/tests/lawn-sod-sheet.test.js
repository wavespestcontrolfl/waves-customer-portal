// Lawn Fast Complete applies the new-sod holds (GATE_LAWN_NEW_SOD_NOTE): which product lines the holds
// cover, the banner, the part-of-lawn notes, the October bag swap, the all-held message, a visit at another
// home, and the rooted tick's write. The hold RULES are lawn-sod-holds.js's own tests; this file proves the
// sheet reads them. Synthetic data; a table-keyed fake knex.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/service-completion-profiles', () => ({
  resolveCompletionProfileForScheduledService: jest.fn(),
}));
jest.mock('../services/waveguard-plan-engine', () => ({ buildPlanForService: jest.fn(), v13VisitLimits: jest.fn(), v13ProtocolRows: jest.fn(() => new Map()), v13GateNotes: jest.fn(() => []) }));

const { resolveCompletionProfileForScheduledService } = require('../services/service-completion-profiles');
const { buildPlanForService } = require('../services/waveguard-plan-engine');
const { buildLawnFastContext } = require('../services/lawn-fast-complete');
const sodSheet = require('../services/lawn-sod-sheet');
const { SOD_SWAP_BAG } = require('../services/lawn-sod-holds');

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const VISIT = uuid(1);
const P_BAG24 = uuid(21);
const P_DIM_BAG = uuid(22);
const P_NUTRA = uuid(23);
const P_STONEWALL = uuid(24);
const P_DIM_LIQ = uuid(25);
const P_TETRINO = uuid(26);
const P_CELSIUS = uuid(27);
const P_CERTAINTY = uuid(28);
const P_SURFACTANT = uuid(29);
const P_DYLOX = uuid(30);
const P_GRAVEX = uuid(31);
const P_ARTAVIA = uuid(32);
const P_HEADWAY = uuid(33);
const P_VELISTA = uuid(34);

const CATALOG = [
  { id: P_BAG24, name: SOD_SWAP_BAG.name, category: 'fertilizer', formulation: 'granular', analysis_n: 24, active: true },
  { id: P_DIM_BAG, name: 'LESCO Dimension 0.21% 18-0-10 50% PolyPlus OPTI45 MOP Pre-Emergent Plus Fertilizer', category: 'herbicide', active_ingredient: 'Dithiopyr', formulation: 'granular', analysis_n: 18, active: true },
  { id: P_NUTRA, name: 'LESCO Nutra-TECH T&O Micronutrient Package', category: 'fertilizer', formulation: 'liquid', analysis_n: null, active: true },
  { id: P_STONEWALL, name: 'LESCO Stonewall 4FL Prodiamine 40.7% Pre-Emergent Liquid Herbicide', category: 'herbicide', active_ingredient: 'Prodiamine', formulation: 'liquid', active: true },
  { id: P_DIM_LIQ, name: 'Dimension 2EW Dithiopyr 24% Pre-Emergent Liquid Herbicide', category: 'herbicide', active_ingredient: 'Dithiopyr', formulation: 'liquid', active: true },
  { id: P_TETRINO, name: 'Tetrino Insecticide', category: 'insecticide', active_ingredient: 'Tetraniliprole', formulation: 'liquid', active: true },
  { id: P_CELSIUS, name: 'Celsius WG', category: 'herbicide', formulation: 'dry', active: true },
  { id: P_CERTAINTY, name: 'Certainty Turf Herbicide', category: 'herbicide', formulation: 'dry', active: true },
  { id: P_SURFACTANT, name: 'LESCO 90/10 Nonionic Surfactant', category: 'adjuvant', formulation: 'liquid', active: true },
  { id: P_DYLOX, name: 'Dylox 6.2 G Granular Insecticide', category: 'insecticide', active_ingredient: 'Trichlorfon', formulation: 'granular', active: true },
  { id: P_GRAVEX, name: 'Gravex 20 EW', category: 'fungicide', formulation: 'liquid', active: true },
  { id: P_ARTAVIA, name: 'Artavia 2 SC (Azoxy)', category: 'fungicide', active_ingredient: 'Azoxystrobin', formulation: 'liquid', active: true },
  { id: P_HEADWAY, name: 'Headway Fungicide', category: 'fungicide', formulation: 'liquid', active: true },
  { id: P_VELISTA, name: 'Velista', category: 'fungicide', active_ingredient: 'Penthiopyrad', formulation: 'dry', active: true },
];

const planItem = (productId, name, extra = {}) => ({
  productId, name, applicationMethod: 'granular_broadcast', amount: 20, amountUnit: 'lb', treatedSqft: 5000, areaUnit: 'sqft', ...extra,
});

// A premises that matches the customer's own address, so the sod home is proven by the visit's property link.
const HOME = { address_line1: '100 Example Court', address_line2: null, city: 'Bradenton', zip: '34201' };
const visitRow = (extra = {}) => ({
  id: VISIT, customer_id: 'cust-1', property_id: 'prop-1', service_type: 'Lawn Care', service_id: 'cat-1',
  scheduled_date: '2026-10-05', status: 'confirmed', visit_id: null,
  cust_address_line1: '100 Example Court', cust_city: 'Bradenton', cust_state: 'FL', cust_zip: '34201', ...extra,
});

function fakeKnex(tables) {
  return jest.fn((table) => {
    const data = tables[table];
    const chain = {};
    for (const m of ['where', 'whereIn', 'whereNot', 'whereNotNull', 'whereRaw', 'leftJoin', 'join', 'orderBy', 'orderByRaw', 'select']) chain[m] = () => chain;
    chain.first = async () => {
      if (data instanceof Error) throw data;
      return Array.isArray(data) ? data[0] : data;
    };
    const settle = () => (data instanceof Error ? Promise.reject(data) : Promise.resolve(Array.isArray(data) ? data : []));
    chain.then = (resolve, reject) => settle().then(resolve, reject);
    chain.catch = (reject) => settle().catch(reject);
    return chain;
  });
}

const ruleFor = () => ({ approvedForReport: true, rule: null, ruleSummary: 'No watering instruction', mowHoldDays: null });
const prefs = (extra) => ({ sod_laid_on: '2026-10-01', sod_covers: 'whole', sod_area: null, sod_rooted_on: null, ...extra });

async function load({ record, visit = visitRow(), planned, catalog = CATALOG, extraTables = {} }) {
  const readFailures = new Set();
  const out = await sodSheet.loadSodForContext({
    svc: visit,
    knex: fakeKnex({ property_preferences: record, customer_properties: HOME, customers: { has_multi_home: false }, customer_turf_profiles: { track_key: null, grass_type: 'st_augustine' }, products_catalog: catalog, ...extraTables }),
    readFailures,
    plannedProducts: planned,
    ruleFor,
  });
  return { ...out, readFailures };
}

const lineOf = (out, id) => out.newSod.lines[id.toLowerCase()];

describe('classesOf: which hold class a catalog product belongs to', () => {
  const by = (id, extra) => sodSheet.classesOf(CATALOG.find((row) => row.id === id), extra);

  test.each([
    ['the 24-0-11 bag', P_BAG24, ['fertilizer']],
    ['the Dimension 18-0-10 bag is a pre-emergent AND a fertilizer', P_DIM_BAG, ['fertilizer', 'preEmergent']],
    ['Nutra-TECH (liquid micronutrient) is not held', P_NUTRA, []],
    ['a liquid pre-emergent', P_STONEWALL, ['preEmergent']],
    ['Dimension 2EW liquid', P_DIM_LIQ, ['preEmergent']],
    ['Tetrino', P_TETRINO, ['tetrino']],
    ['Celsius', P_CELSIUS, ['weedKiller']],
    ['Certainty', P_CERTAINTY, ['weedKiller']],
    ['the surfactant is not a weed killer on its own', P_SURFACTANT, []],
    ['Dylox', P_DYLOX, ['dylox']],
    ['Gravex (the catalog row carries no active ingredient: the brand name decides)', P_GRAVEX, ['fungicideGravex']],
    ['Artavia is not held', P_ARTAVIA, []],
    ['Headway is not held', P_HEADWAY, []],
    ['Velista is not held', P_VELISTA, []],
  ])('%s', (_label, id, expected) => {
    expect(by(id)).toEqual(expected);
  });

  test('the surfactant is a weed killer line when it belongs to the Weed spots group', () => {
    expect(by(P_SURFACTANT, { inWeedGroup: true })).toEqual(['weedKiller']);
  });
});

describe('loadSodForContext', () => {
  const planned = () => ({
    items: [planItem(P_BAG24, SOD_SWAP_BAG.name), planItem(P_NUTRA, 'LESCO Nutra-TECH T&O Micronutrient Package', { applicationMethod: 'broadcast_spray', amountUnit: 'fl oz' })],
    addOns: [
      planItem(P_CELSIUS, 'Celsius WG', { applicationMethod: 'spot_treatment' }),
      planItem(P_CERTAINTY, 'Certainty Turf Herbicide', { applicationMethod: 'spot_treatment' }),
      planItem(P_SURFACTANT, 'LESCO 90/10 Nonionic Surfactant', { applicationMethod: 'spot_treatment' }),
      planItem(P_DYLOX, 'Dylox 6.2 G Granular Insecticide'),
      planItem(P_GRAVEX, 'Gravex 20 EW', { applicationMethod: 'spot_treatment' }),
      planItem(P_ARTAVIA, 'Artavia 2 SC (Azoxy)', { applicationMethod: 'spot_treatment' }),
      planItem(P_VELISTA, 'Velista', { applicationMethod: 'spot_treatment' }),
    ],
    weedMix: { productIds: [P_CELSIUS, P_CERTAINTY, P_SURFACTANT], groupProductIds: [P_CELSIUS, P_CERTAINTY, P_SURFACTANT] },
  });

  test('whole lawn, day 5: the banner, and every covered line held with its plain reason', async () => {
    const out = await load({ record: prefs(), planned: planned() });
    expect(out.newSod).toMatchObject({
      v: 1, day: 5, sodLaidOn: '2026-10-01', covers: 'whole', area: null,
      headline: 'New sod, day 5. Laid Oct 1, 2026.',
      where: 'Whole lawn.',
      heldLine: 'Held: fertilizer, weed killer, pre-emergent, Tetrino, Dylox, Gravex.',
      largePatch: 'Watch for large patch.',
      swap: null,
      noWholeLawn: null,
    });
    expect(lineOf(out, P_BAG24)).toEqual({ held: true, kinds: ['fertilizer'], reason: 'Held: new sod. Fertilizer starts Oct 31, 2026.' });
    // Nutra-TECH is not held: it stays a whole-lawn product, so the all-held message is not shown.
    expect(lineOf(out, P_NUTRA)).toBeUndefined();
    expect(lineOf(out, P_DYLOX).reason).toBe('Held: new sod. Dylox starts Oct 31, 2026.');
    // The weed killer and Gravex wait for the rooted check; the whole Weed spots group, surfactant included.
    for (const id of [P_CELSIUS, P_CERTAINTY, P_SURFACTANT]) {
      expect(lineOf(out, id)).toMatchObject({ held: true, kinds: ['weedKiller'] });
      expect(lineOf(out, id).reason).toBe('Held: new sod. Weed killer starts Oct 31, 2026, once the sod has been mowed twice and does not lift.');
    }
    expect(lineOf(out, P_GRAVEX).reason).toBe('Held: new sod. Gravex starts Oct 31, 2026, once the sod has been mowed twice and does not lift.');
    // Fungicides the owner did not hold stay clear.
    expect(lineOf(out, P_ARTAVIA)).toBeUndefined();
    expect(lineOf(out, P_VELISTA)).toBeUndefined();
    // Not inside the 30 days: no rooted tick yet.
    expect(out.newSod.rooted).toBeNull();
    expect(out.plannedProducts.items).toHaveLength(2);
  });

  test('day 31, not rooted: the weed lines wait for the tick, and the banner offers it for THIS sod date', async () => {
    const out = await load({ record: prefs({ sod_laid_on: '2026-09-05' }), planned: planned() });
    expect(out.newSod.day).toBe(31);
    expect(out.newSod.rooted).toEqual({ sodLaidOn: '2026-09-05', label: 'Sod mowed twice and does not lift' });
    expect(lineOf(out, P_CELSIUS).reason).toBe('Held: new sod. Weed killer waits until the sod has been mowed twice and does not lift.');
    // Fertilizer and Dylox are over (day 31).
    expect(lineOf(out, P_DYLOX)).toBeUndefined();
    expect(lineOf(out, P_BAG24)).toBeUndefined();
  });

  test('day 31, rooted: the weed lines are not held and there is no tick', async () => {
    const out = await load({ record: prefs({ sod_laid_on: '2026-09-05', sod_rooted_on: '2026-10-03' }), planned: planned() });
    expect(lineOf(out, P_CELSIUS)).toBeUndefined();
    expect(lineOf(out, P_GRAVEX)).toBeUndefined();
    expect(out.newSod.rooted).toBeNull();
    // The pre-emergent hold (one full summer) still runs, so the banner still shows.
    expect(out.newSod.heldLine).toBe('Held: pre-emergent.');
  });

  test('part of the lawn: lines stay on; weed, pre-emergent, Tetrino, Dylox and Gravex lines carry the skip note; fertilizer is kept off the sod', async () => {
    const items = [
      planItem(P_BAG24, SOD_SWAP_BAG.name),
      planItem(P_DIM_LIQ, 'Dimension 2EW Dithiopyr 24% Pre-Emergent Liquid Herbicide', { applicationMethod: 'broadcast_spray' }),
      planItem(P_TETRINO, 'Tetrino Insecticide', { applicationMethod: 'broadcast_spray' }),
    ];
    const out = await load({ record: prefs({ sod_covers: 'part', sod_area: 'Back left corner' }), planned: { ...planned(), items } });
    expect(out.newSod).toMatchObject({
      covers: 'part', area: 'Back left corner', where: 'Part of the lawn: Back left corner.',
      heldLine: 'Skip the new sod area for: fertilizer, weed killer, pre-emergent, Tetrino, Dylox, Gravex.',
    });
    const skip = { held: false, kinds: [], note: 'Skip the new sod: Back left corner' };
    for (const id of [P_DIM_LIQ, P_TETRINO, P_CELSIUS, P_CERTAINTY, P_SURFACTANT, P_GRAVEX, P_DYLOX]) expect(lineOf(out, id)).toEqual(skip);
    // Fertilizer is never held on a part, but inside the first 30 days it is kept off the new sod. Artavia is not a held class.
    expect(lineOf(out, P_BAG24)).toEqual({ held: false, kinds: [], note: 'Keep fertilizer off the new sod: Back left corner.' });
    expect(lineOf(out, P_ARTAVIA)).toBeUndefined();
    // Nothing is held, so nothing is "all held" and no swap happens.
    expect(out.newSod.noWholeLawn).toBeNull();
    expect(out.newSod.swap).toBeNull();
  });

  test('part of the lawn after day 30: the fertilizer line carries no note', async () => {
    const out = await load({ record: prefs({ sod_laid_on: '2026-09-05', sod_covers: 'part', sod_area: 'Back left corner' }), planned: planned() });
    expect(lineOf(out, P_BAG24)).toBeUndefined();
    expect(lineOf(out, P_DYLOX)).toBeUndefined();
  });

  describe('the October bag swap (fertilizer hold over, pre-emergent hold on)', () => {
    const OCT = () => ({
      items: [planItem(P_DIM_BAG, 'LESCO Dimension 0.21% 18-0-10 50% PolyPlus OPTI45 MOP Pre-Emergent Plus Fertilizer', { amount: 20.2, ratePer1000: 4.04, rateUnit: 'lb' })],
      addOns: [],
    });
    const record = prefs({ sod_laid_on: '2026-08-01' });

    test('LESCO 24-0-11 at 2.5 lb per 1,000 sq ft takes the Dimension bag\'s place, from the catalog row', async () => {
      const out = await load({ record, planned: OCT() });
      expect(out.newSod.swap).toEqual({
        resolved: true, forProductId: P_DIM_BAG, productId: P_BAG24, name: SOD_SWAP_BAG.name, lbPer1000: 2.5, reason: 'New sod: no pre-emergent yet.',
      });
      const [bag, swap] = out.plannedProducts.items;
      expect(bag.productId).toBe(P_DIM_BAG);
      expect(swap).toMatchObject({
        productId: P_BAG24, name: SOD_SWAP_BAG.name, applicationMethod: 'granular_broadcast',
        amount: 12.5, amountUnit: 'lb', treatedSqft: 5000, ratePer1000: 2.5, rateUnit: 'lb',
        sodSwap: { forProductId: P_DIM_BAG, reason: 'New sod: no pre-emergent yet.' },
      });
      expect(lineOf(out, P_DIM_BAG).held).toBe(true);
      expect(lineOf(out, P_DIM_BAG).reason).toBe(`Held: new sod. Pre-emergent starts Oct 1, 2027. Use ${SOD_SWAP_BAG.name} instead.`);
      // The swap bag is a line that is not held: the visit has a whole-lawn product.
      expect(lineOf(out, P_BAG24)).toBeUndefined();
      expect(out.newSod.noWholeLawn).toBeNull();
    });

    test('April on the 9-visit plan: the same bag at 2.1 lb per 1,000 sq ft (it replaces a 0.5 lb N pass)', async () => {
      const out = await load({ record: prefs({ sod_laid_on: '2026-01-02' }), visit: visitRow({ scheduled_date: '2026-04-14' }), planned: OCT() });
      expect(out.newSod.swap).toMatchObject({ resolved: true, lbPer1000: 2.1 });
      expect(out.plannedProducts.items[1]).toMatchObject({ amount: 10.5, ratePer1000: 2.1 });
    });

    test('a swap bag the catalog cannot resolve is never invented: the bag is held with "by hand" words', async () => {
      const out = await load({ record, planned: OCT(), catalog: CATALOG.filter((row) => row.id !== P_BAG24) });
      expect(out.newSod.swap).toEqual({ resolved: false, forProductId: P_DIM_BAG, reason: 'Use LESCO 24-0-11 by hand.' });
      expect(out.plannedProducts.items).toHaveLength(1);
      expect(lineOf(out, P_DIM_BAG).reason).toBe('Held: new sod. Pre-emergent starts Oct 1, 2027. Use LESCO 24-0-11 by hand.');
      // The only primary line is held and no replacement exists: the all-held message.
      expect(out.newSod.noWholeLawn).toBe('No whole-lawn product today. Spot work only.');
    });

    test('inside the fertilizer hold there is no swap: the combination bag is held for both', async () => {
      const out = await load({ record: prefs({ sod_laid_on: '2026-10-01' }), planned: OCT() });
      expect(out.newSod.swap).toBeNull();
      expect(out.plannedProducts.items).toHaveLength(1);
      expect(lineOf(out, P_DIM_BAG).reason).toBe('Held: new sod. Fertilizer starts Oct 31, 2026. Pre-emergent starts Oct 1, 2027.');
    });
  });

  test('a spreader visit where every primary line is held says there is no whole-lawn product', async () => {
    const out = await load({ record: prefs(), planned: { items: [planItem(P_BAG24, SOD_SWAP_BAG.name)], addOns: [] } });
    expect(out.newSod.noWholeLawn).toBe(sodSheet.NO_PRODUCT_TEXT);
    expect(out.newSod.noWholeLawn).toBe('No whole-lawn product today. Spot work only. If there is no spot work, complete the visit with no product.');
    expect(out.newSod.noProductAllowed).toBe(true);
    expect(out.newSod.noProductNote).toBe('No product applied: new sod is rooting (laid Oct 1, 2026). Held: fertilizer until Oct 31, 2026.');
  });

  describe('noProductAllowed: set only when the holds took EVERY planned line and nothing is left to spread by hand', () => {
    test('a part-of-lawn record keeps its lines on: never set', async () => {
      const out = await load({ record: prefs({ sod_covers: 'part', sod_area: 'front yard' }), planned: { items: [planItem(P_BAG24, SOD_SWAP_BAG.name)], addOns: [] } });
      expect(out.newSod.noProductAllowed).toBeUndefined();
      expect(out.newSod.noProductNote).toBeUndefined();
      expect(out.newSod.noWholeLawn).toBeNull();
    });

    test('one planned line that is not held (Nutra-TECH): never set, and no whole-lawn message either', async () => {
      const out = await load({ record: prefs(), planned: { items: [planItem(P_BAG24, SOD_SWAP_BAG.name), planItem(P_NUTRA, 'LESCO Nutra-TECH T&O Micronutrient Package', { applicationMethod: 'broadcast_spray', amountUnit: 'fl oz' })], addOns: [] } });
      expect(out.newSod.noProductAllowed).toBeUndefined();
      expect(out.newSod.noWholeLawn).toBeNull();
    });

    test('no planned products at all: never set', async () => {
      const out = await load({ record: prefs(), planned: { source: null, items: [], addOns: [] } });
      expect(out.newSod.noProductAllowed).toBeUndefined();
    });

    test('a swap bag the technician spreads by hand is a product applied: the message stays, the flag is not set', async () => {
      const dim = planItem(P_DIM_BAG, 'LESCO Dimension 0.21% 18-0-10 50% PolyPlus OPTI45 MOP Pre-Emergent Plus Fertilizer');
      const out = await load({ record: prefs({ sod_laid_on: '2026-08-01' }), catalog: CATALOG.filter((row) => row.id !== P_BAG24), planned: { items: [dim], addOns: [] } });
      expect(out.newSod.swap).toMatchObject({ resolved: false });
      expect(out.newSod.noWholeLawn).toBe(sodSheet.NO_WHOLE_LAWN_TEXT);
      expect(out.newSod.noProductAllowed).toBeUndefined();
    });

    test('a resolved swap adds a line that is not held: never set', async () => {
      const dim = planItem(P_DIM_BAG, 'LESCO Dimension 0.21% 18-0-10 50% PolyPlus OPTI45 MOP Pre-Emergent Plus Fertilizer');
      const out = await load({ record: prefs({ sod_laid_on: '2026-08-01' }), planned: { items: [dim], addOns: [] } });
      expect(out.newSod.swap).toMatchObject({ resolved: true });
      expect(out.newSod.noProductAllowed).toBeUndefined();
    });

    test('the note names each held class and when it ends (a weed killer waits for the rooted check too)', async () => {
      const out = await load({ record: prefs(), planned: { items: [planItem(P_BAG24, SOD_SWAP_BAG.name), planItem(P_CELSIUS, 'Celsius WG', { applicationMethod: 'broadcast_spray' })], addOns: [] } });
      expect(out.newSod.noProductAllowed).toBe(true);
      expect(out.newSod.noProductNote).toMatch(/^No product applied: new sod is rooting \(laid Oct 1, 2026\)\. Held: fertilizer until Oct 31, 2026, weed killer until Oct 31, 2026\.$/);
    });
  });

  test('a visit with no planned products never claims the message', async () => {
    const out = await load({ record: prefs(), planned: { source: null, items: [], addOns: [] } });
    expect(out.newSod.noWholeLawn).toBeNull();
  });

  describe('a visit that is not at the home the sod record belongs to gets no holds', () => {
    test('the visit is stamped with another address', async () => {
      const out = await load({
        record: prefs(),
        visit: visitRow({ property_id: null, service_address_line1: '200 Other Lane', service_address_city: 'Parrish', service_address_zip: '34219' }),
        planned: planned(),
      });
      expect(out.newSod).toBeNull();
      expect(out.plannedProducts.items).toHaveLength(2);
    });

    test('the visit\'s property is another premises of the customer', async () => {
      const out = await load({
        record: prefs(),
        planned: planned(),
        extraTables: { customer_properties: { address_line1: '200 Other Lane', address_line2: null, city: 'Parrish', zip: '34219' } },
      });
      expect(out.newSod).toBeNull();
    });

    test('a visit with no address evidence on a multi-home account is unproven: no holds', async () => {
      const out = await load({
        record: prefs(),
        visit: visitRow({ property_id: null }),
        planned: planned(),
        extraTables: { customers: { has_multi_home: true } },
      });
      expect(out.newSod).toBeNull();
    });
  });

  test('no sod record, a sod date after the visit, or a hold that is over: no newSod', async () => {
    expect((await load({ record: undefined, planned: planned() })).newSod).toBeNull();
    expect((await load({ record: prefs({ sod_laid_on: null }), planned: planned() })).newSod).toBeNull();
    expect((await load({ record: prefs({ sod_laid_on: '2026-10-20' }), planned: planned() })).newSod).toBeNull();
    // Laid January 2025: every hold is over by October 2026.
    expect((await load({ record: prefs({ sod_laid_on: '2025-01-10', sod_rooted_on: '2025-02-20' }), planned: planned() })).newSod).toBeNull();
  });

  test('a failed sod read says so (never silently no holds) and records the read failure', async () => {
    const out = await load({ record: new Error('boom'), planned: planned() });
    expect(out.newSod).toEqual({ v: 1, unavailable: true, message: sodSheet.UNAVAILABLE_TEXT });
    expect(out.readFailures.has('new_sod')).toBe(true);
    expect(out.plannedProducts.items).toHaveLength(2);
  });
});

describe('buildLawnFastContext: the gate', () => {
  const GATES = ['GATE_LAWN_NEW_SOD_NOTE', 'GATE_LAWN_COMPLETION_DEFAULTS', 'GATE_LAWN_PROPERTY_HISTORY'];
  const saved = Object.fromEntries(GATES.map((name) => [name, process.env[name]]));
  beforeEach(() => {
    resolveCompletionProfileForScheduledService.mockReset().mockResolvedValue({
      category: 'lawn_care', serviceKey: 'lawn_care_monthly', billingType: 'recurring', findingsType: null, projectBacked: false, requiresProject: false, companions: [],
    });
    buildPlanForService.mockReset().mockResolvedValue({
      completionDefaults: { items: [{ product: { id: P_BAG24, name: SOD_SWAP_BAG.name }, applicationMethod: 'granular_broadcast', mix: { amount: 20, amountUnit: 'lb' } }] },
    });
    process.env.GATE_LAWN_COMPLETION_DEFAULTS = 'true';
    process.env.GATE_LAWN_PROPERTY_HISTORY = 'true';
    delete process.env.GATE_LAWN_NEW_SOD_NOTE;
  });
  afterAll(() => {
    for (const name of GATES) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; }
  });

  const tables = (record) => ({
    scheduled_services: visitRow(), customers: { billing_mode: null, has_multi_home: false }, products_catalog: CATALOG,
    property_preferences: record, customer_properties: HOME, customer_turf_profiles: { grass_type: 'st_augustine' },
  });

  test('off: a sod customer\'s context is byte-for-byte the one without a sod record, and the record is never read', async () => {
    const withSod = fakeKnex(tables(prefs()));
    const withoutSod = fakeKnex(tables(undefined));
    const a = await buildLawnFastContext(VISIT, { knex: withSod });
    const b = await buildLawnFastContext(VISIT, { knex: withoutSod });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.newSod).toBeUndefined();
    expect(withSod.mock.calls.map(([table]) => table)).not.toContain('property_preferences');
    expect(a.plannedProducts.items[0]).not.toHaveProperty('sodSwap');
  });

  test('on: the context carries newSod, and a customer with no sod record is unchanged', async () => {
    process.env.GATE_LAWN_NEW_SOD_NOTE = 'true';
    const ctx = await buildLawnFastContext(VISIT, { knex: fakeKnex(tables(prefs())), sodAware: true });
    expect(ctx.newSod).toMatchObject({ headline: 'New sod, day 5. Laid Oct 1, 2026.', noWholeLawn: sodSheet.NO_PRODUCT_TEXT, noProductAllowed: true });
    expect(ctx.newSod.lines[P_BAG24]).toMatchObject({ held: true });
    expect(ctx.readFailures).toEqual([]);

    const off = await buildLawnFastContext(VISIT, { knex: fakeKnex(tables(undefined)), sodAware: true });
    expect(off.newSod).toBeUndefined();
  });

  describe('the capability signal: only a sod-aware sheet gets the hold-adjusted context', () => {
    // An October visit on the Dimension combination bag, sod laid in August: the swap bag would be appended.
    const DIM_NAME = 'LESCO Dimension 0.21% 18-0-10 50% PolyPlus OPTI45 MOP Pre-Emergent Plus Fertilizer';
    const dimTables = () => tables(prefs({ sod_laid_on: '2026-08-01' }));
    beforeEach(() => {
      buildPlanForService.mockReset().mockResolvedValue({
        completionDefaults: { items: [{ product: { id: P_DIM_BAG, name: DIM_NAME }, applicationMethod: 'granular_broadcast', mix: { amount: 20, amountUnit: 'lb' } }] },
      });
    });

    test('gate on, no signal: byte-for-byte the gate-off context (no swap bag appended, nothing removed, no newSod), sod record never read', async () => {
      delete process.env.GATE_LAWN_NEW_SOD_NOTE;
      const legacy = await buildLawnFastContext(VISIT, { knex: fakeKnex(dimTables()) });
      process.env.GATE_LAWN_NEW_SOD_NOTE = 'true';
      const knex = fakeKnex(dimTables());
      const unsignalled = await buildLawnFastContext(VISIT, { knex });
      expect(JSON.stringify(unsignalled)).toBe(JSON.stringify(legacy));
      expect(unsignalled.plannedProducts.items.map((i) => i.productId)).toEqual([P_DIM_BAG]);
      expect(unsignalled.newSod).toBeUndefined();
      expect(knex.mock.calls.map(([table]) => table)).not.toContain('property_preferences');
      // Anything but the explicit boolean is no signal.
      const truthy = await buildLawnFastContext(VISIT, { knex: fakeKnex(dimTables()), sodAware: 'yes' });
      expect(JSON.stringify(truthy)).toBe(JSON.stringify(legacy));
    });

    test('gate on, signal sent: the Dimension bag is held and the swap bag is appended', async () => {
      process.env.GATE_LAWN_NEW_SOD_NOTE = 'true';
      const aware = await buildLawnFastContext(VISIT, { knex: fakeKnex(dimTables()), sodAware: true });
      expect(aware.plannedProducts.items.map((i) => i.productId)).toEqual([P_DIM_BAG, P_BAG24]);
      expect(aware.newSod.lines[P_DIM_BAG]).toMatchObject({ held: true });
    });

    test('gate off, signal sent: still the legacy context', async () => {
      delete process.env.GATE_LAWN_NEW_SOD_NOTE;
      const legacy = await buildLawnFastContext(VISIT, { knex: fakeKnex(dimTables()) });
      const signalled = await buildLawnFastContext(VISIT, { knex: fakeKnex(dimTables()), sodAware: true });
      expect(JSON.stringify(signalled)).toBe(JSON.stringify(legacy));
    });
  });
});

// ── completing with no product ──────────────────────────────────────────────

describe('preflightLawnFastCompletion: an empty product list', () => {
  const { preflightLawnFastCompletion } = require('../services/lawn-fast-complete');
  const GATES = ['GATE_LAWN_NEW_SOD_NOTE', 'GATE_LAWN_FAST_COMPLETE', 'GATE_LAWN_COMPLETION_DEFAULTS', 'GATE_LAWN_PROPERTY_HISTORY'];
  const saved = Object.fromEntries(GATES.map((name) => [name, process.env[name]]));
  const ASSESSMENT = uuid(40);
  const IDENTITY = {
    propertyId: 'prop-1', customerId: 'cust-1', catalogServiceId: 'cat-1', serviceType: 'Lawn Care',
    scheduledDate: '2026-10-05', isCallback: false,
    address: { line1: '100 Example Court', line2: null, city: 'Bradenton', state: 'FL', zip: '34201' },
    technicianId: null,
  };
  const NOTE = 'No product applied: new sod is rooting (laid Oct 1, 2026). Held: fertilizer until Oct 31, 2026.';
  let plan;
  beforeEach(() => {
    resolveCompletionProfileForScheduledService.mockReset().mockResolvedValue({
      category: 'lawn_care', serviceKey: 'lawn_care_monthly', billingType: 'recurring', findingsType: null, projectBacked: false, requiresProject: false, companions: [],
    });
    plan = { completionDefaults: { items: [{ product: { id: P_BAG24, name: SOD_SWAP_BAG.name }, applicationMethod: 'granular_broadcast', mix: { amount: 20, amountUnit: 'lb' } }] } };
    buildPlanForService.mockReset().mockImplementation(async () => plan);
    process.env.GATE_LAWN_FAST_COMPLETE = 'true';
    process.env.GATE_LAWN_COMPLETION_DEFAULTS = 'true';
    process.env.GATE_LAWN_PROPERTY_HISTORY = 'true';
    process.env.GATE_LAWN_NEW_SOD_NOTE = 'true';
    // The assessment is this visit's own, on this property (the preflight's property-scope check).
    const history = require('../services/lawn-assessment-history');
    jest.spyOn(history, 'installedForVisit').mockResolvedValue({ id: ASSESSMENT });
    jest.spyOn(history, 'historyForAssessment').mockResolvedValue({ current: { id: ASSESSMENT } });
  });
  afterEach(() => { jest.restoreAllMocks(); });
  afterAll(() => {
    for (const name of GATES) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; }
  });

  const run = ({ record = prefs(), products = [], technicianNotes = '' } = {}) => {
    const knex = fakeKnex({
      scheduled_services: visitRow(), customers: { billing_mode: null, has_multi_home: false }, products_catalog: CATALOG,
      property_preferences: record, customer_properties: HOME, customer_turf_profiles: { grass_type: 'st_augustine' },
      lawn_assessments: { id: ASSESSMENT, confirmed_by_tech: true }, lawn_assessment_photos: [],
    });
    return preflightLawnFastCompletion({
      knex, svc: { id: VISIT, customer_id: 'cust-1', property_id: 'prop-1' }, lawnAssessmentId: ASSESSMENT,
      expectedVisit: IDENTITY, lawnFast: { visitType: 'recurring' }, products, technicianNotes,
    });
  };

  const STALE = { status: 409, payload: { code: 'lawn_sod_no_product_stale', error: 'The new sod record changed. Reopen the visit.' } };

  test('every planned product held and the note the server generates is on the record: accepted with no product', async () => {
    expect(await run({ technicianNotes: NOTE })).toBeNull();
    expect(await run({ technicianNotes: `Dog in the yard. ${NOTE}`, products: undefined })).toBeNull();
  });

  test('an empty list WITHOUT the sentence keeps today\'s behavior (accepted), all held or not', async () => {
    expect(await run({ technicianNotes: '' })).toBeNull();
    expect(await run({ technicianNotes: 'Nothing to spread.' })).toBeNull();
    expect(await run({ record: null, technicianNotes: '' })).toBeNull();
  });

  test('the sentence on a visit the rebuilt context does not allow: 409 lawn_sod_no_product_stale', async () => {
    // The sod record was cleared since the sheet opened.
    expect(await run({ record: null, technicianNotes: NOTE })).toEqual(STALE);
    // It was changed to part of the lawn: the lines stay on, nothing is allowed empty.
    expect(await run({ record: prefs({ sod_covers: 'part', sod_area: 'front yard' }), technicianNotes: NOTE })).toEqual(STALE);
    // The holds on the plan's bag ended (sod laid in August): the line is no longer held.
    expect(await run({ record: prefs({ sod_laid_on: '2026-08-01' }), technicianNotes: NOTE })).toEqual(STALE);
  });

  test('the sentence is on the record but the generated note differs from the one sent: stale', async () => {
    // The sheet was opened when the sod was laid on another day.
    const old = 'No product applied: new sod is rooting (laid Sep 28, 2026). Held: fertilizer until Oct 28, 2026.';
    expect(await run({ technicianNotes: old })).toEqual(STALE);
    // A hand-typed prefix alone is not the generated sentence.
    expect(await run({ technicianNotes: 'No product applied: new sod.' })).toEqual(STALE);
  });

  test('a failed sod read, or a failed rebuild, is stale too (never accepted on the sheet\'s word)', async () => {
    expect(await run({ record: new Error('read failed'), technicianNotes: NOTE })).toEqual(STALE);
  });

  test('the gate off: the sentence is stale (nothing authorizes it), the sod record is never read', async () => {
    delete process.env.GATE_LAWN_NEW_SOD_NOTE;
    const knex = fakeKnex({
      scheduled_services: visitRow(), customers: { billing_mode: null, has_multi_home: false }, products_catalog: CATALOG,
      property_preferences: prefs(), customer_properties: HOME, lawn_assessments: { id: ASSESSMENT, confirmed_by_tech: true }, lawn_assessment_photos: [],
    });
    const out = await preflightLawnFastCompletion({ knex, svc: { id: VISIT, customer_id: 'cust-1' }, lawnAssessmentId: ASSESSMENT, expectedVisit: IDENTITY, lawnFast: { visitType: 'recurring' }, products: [], technicianNotes: NOTE });
    expect(out).toEqual(STALE);
    expect(knex.mock.calls.map(([table]) => table)).not.toContain('property_preferences');
  });

  test('gate off and no sentence: an empty list is judged exactly as before', async () => {
    delete process.env.GATE_LAWN_NEW_SOD_NOTE;
    const knex = fakeKnex({
      scheduled_services: visitRow(), customers: { billing_mode: null, has_multi_home: false }, products_catalog: CATALOG,
      property_preferences: prefs(), customer_properties: HOME, lawn_assessments: { id: ASSESSMENT, confirmed_by_tech: true }, lawn_assessment_photos: [],
    });
    const out = await preflightLawnFastCompletion({ knex, svc: { id: VISIT, customer_id: 'cust-1' }, lawnAssessmentId: ASSESSMENT, expectedVisit: IDENTITY, lawnFast: { visitType: 'recurring' }, products: [], technicianNotes: '' });
    expect(out).toBeNull();
    expect(knex.mock.calls.map(([table]) => table)).not.toContain('property_preferences');
  });

  test('a product on the list is never touched by this path', async () => {
    expect(await run({ products: [{ productId: P_BAG24 }], technicianNotes: '' })).toBeNull();
    // A list with a product that still carries the sentence is a normal completion: nothing to authorize.
    expect(await run({ products: [{ productId: P_BAG24 }], technicianNotes: NOTE })).toBeNull();
  });
});

// ── the rooted tick ─────────────────────────────────────────────────────────

describe('confirmSodRooted', () => {
  // A transaction fake over one preferences row; `update` applies the guards the route's SQL carries.
  function fakeTrx(state) {
    const trx = jest.fn((table) => {
      const filters = {};
      let guardNullRooted = false;
      let guardLaid = null;
      const chain = {};
      chain.where = (cond) => { Object.assign(filters, cond); return chain; };
      chain.whereNull = (col) => { if (col === 'sod_rooted_on') guardNullRooted = true; return chain; };
      chain.whereRaw = (_sql, [day]) => { guardLaid = day; return chain; };
      chain.forShare = () => chain;
      chain.forUpdate = () => chain;
      chain.first = async () => {
        if (table === 'customers') return state.customer === undefined ? { id: 'cust-1' } : state.customer;
        if (table === 'property_preferences') return state.prefs;
        if (table === 'customer_properties') return HOME;
        return undefined;
      };
      chain.update = async (patch) => {
        state.updates.push(patch);
        if (!state.prefs || (guardNullRooted && state.prefs.sod_rooted_on) || (guardLaid && state.prefs.sod_laid_on !== guardLaid) || state.updateMisses) return 0;
        Object.assign(state.prefs, patch);
        return 1;
      };
      return chain;
    });
    trx.fn = { now: () => 'NOW' };
    return trx;
  }
  const run = (state, extra = {}) => sodSheet.confirmSodRooted(fakeTrx(state), { svc: visitRow(extra.visit), expectedLaidOn: 'laid' in extra ? extra.laid : '2026-09-05' });
  const fresh = (prefsExtra) => ({ updates: [], prefs: prefs({ sod_laid_on: '2026-09-05', ...prefsExtra }) });

  test('day 31: saves the visit\'s ET day on the record the sheet rendered', async () => {
    const state = fresh();
    const out = await run(state);
    expect(out).toEqual({ status: 200, body: { sodRootedOn: '2026-10-05', changed: true } });
    expect(state.prefs.sod_rooted_on).toBe('2026-10-05');
    expect(state.updates).toEqual([{ sod_rooted_on: '2026-10-05', updated_at: 'NOW' }]);
  });

  test('a visit on a later ET day than today is refused: nothing is saved, not even an idempotent read', async () => {
    const state = fresh();
    const out = await run(state, { visit: { scheduled_date: '2099-01-01' } });
    expect(out.status).toBe(409);
    expect(out.body).toEqual({ code: 'sod_rooted_future_visit', error: 'This visit is on a later day. Confirm the sod on the day of the visit.' });
    expect(state.updates).toEqual([]);
    expect(state.prefs.sod_rooted_on).toBeNull();
  });

  test('idempotent: a second tick returns the saved day and writes nothing; a saved day is never moved or cleared', async () => {
    const state = fresh({ sod_rooted_on: '2026-10-02' });
    const out = await run(state);
    expect(out).toEqual({ status: 200, body: { sodRootedOn: '2026-10-02', changed: false } });
    expect(state.updates).toEqual([]);
    expect(state.prefs.sod_rooted_on).toBe('2026-10-02');
  });

  test('a changed sod date is refused with a plain message and nothing is written', async () => {
    const state = fresh({ sod_laid_on: '2026-09-20' });
    const out = await run(state);
    expect(out.status).toBe(409);
    expect(out.body).toEqual({ code: 'sod_record_changed', error: 'The sod record changed. Close this sheet and open the visit again.' });
    expect(state.updates).toEqual([]);
  });

  test('a record cleared since the sheet rendered is refused the same way', async () => {
    const out = await run({ updates: [], prefs: undefined });
    expect(out.status).toBe(409);
    expect(out.body.code).toBe('sod_record_changed');
  });

  test('a write that loses the SQL guard (the record changed between the read and the write) is refused', async () => {
    const state = { ...fresh(), updateMisses: true };
    const out = await run(state);
    expect(out.status).toBe(409);
    expect(out.body.code).toBe('sod_record_changed');
  });

  test('inside the first 30 days there is nothing to confirm yet', async () => {
    const state = fresh({ sod_laid_on: '2026-09-20' });
    const out = await run(state, { laid: '2026-09-20' });
    expect(out.status).toBe(409);
    expect(out.body).toEqual({ code: 'sod_rooted_too_early', error: 'The sod is still inside its first 30 days. Confirm it after day 30.' });
    expect(state.updates).toEqual([]);
  });

  test('a visit at another home of the customer cannot confirm the primary home\'s sod', async () => {
    const state = fresh();
    const out = await run(state, { visit: { property_id: null, service_address_line1: '200 Other Lane', service_address_city: 'Parrish', service_address_zip: '34219' } });
    expect(out.status).toBe(409);
    expect(out.body.code).toBe('sod_not_this_home');
    expect(state.updates).toEqual([]);
  });

  test.each([[undefined], [''], ['next week'], [20260905]])('the sod date must be sent (%p)', async (laid) => {
    const out = await run(fresh(), { laid });
    expect(out.status).toBe(400);
    expect(out.body.code).toBe('sod_date_required');
  });
});
