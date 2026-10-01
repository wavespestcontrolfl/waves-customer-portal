// T&S Fast Complete context: eligibility reasons, per-product compliance
// flags, month products with last-visit amounts, last visit, and the rotation /
// palm-spacing warnings. Synthetic data; a table-keyed fake knex (filters are
// not interpreted — the SQL scoping is exercised by the Postgres lane).
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/service-completion-profiles', () => ({
  resolveCompletionProfileForScheduledService: jest.fn(),
}));

const { resolveCompletionProfileForScheduledService } = require('../services/service-completion-profiles');
const {
  buildTreeShrubFastContext,
  treeShrubFastIneligibleReason,
  treeShrubProductFlags,
  buildTreeShrubWarnings,
  lastAmountsByProduct,
  buildLastVisit,
} = require('../services/tree-shrub-fast-context');

const TS_PROFILE = { category: 'tree_shrub', serviceKey: 'tree_shrub_program', findingsType: 'tree_shrub', projectBacked: false, requiresProject: false, companions: [] };

const visit = (extra = {}) => ({
  id: 'visit-1', customer_id: 'cust-1', property_id: 'prop-1', service_type: 'Tree & Shrub Care',
  service_id: 'cat-1', scheduled_date: '2026-10-01', status: 'confirmed', visit_id: null,
  cust_address_line1: '100 Example Court', cust_city: 'Bradenton', cust_state: 'FL', cust_zip: '34201',
  ...extra,
});

// Rows the fake serves per table name. A value that is an Error rejects.
function fakeKnex(tables) {
  const knex = jest.fn((table) => {
    const data = tables[table];
    const chain = {};
    for (const m of ['where', 'whereNot', 'whereIn', 'whereNull', 'whereRaw', 'leftJoin', 'join', 'orderBy', 'limit', 'select']) chain[m] = () => chain;
    const settle = () => (data instanceof Error ? Promise.reject(data) : Promise.resolve(Array.isArray(data) ? data : []));
    chain.first = async () => {
      if (data instanceof Error) throw data;
      return Array.isArray(data) ? data[0] : data;
    };
    chain.then = (resolve, reject) => settle().then(resolve, reject);
    chain.catch = (reject) => settle().catch(reject);
    return chain;
  });
  knex.raw = (sql) => ({ sql });
  return knex;
}

const cat = (id, name, extra = {}) => ({ id, name, category: null, active_ingredient: null, moa_group: null, ...extra });

describe('treeShrubFastIneligibleReason', () => {
  const knex = (visitRow) => fakeKnex({ service_visits: visitRow });

  test('an eligible visit has no reason', async () => {
    expect(await treeShrubFastIneligibleReason(visit(), TS_PROFILE, knex())).toBeNull();
  });
  test('a lookup failure and a non-T&S profile are reasons', async () => {
    expect(await treeShrubFastIneligibleReason(visit(), null, knex())).toBe('profile_unavailable');
    expect(await treeShrubFastIneligibleReason(visit(), { ...TS_PROFILE, findingsType: 'pest' }, knex())).toBe('not_tree_shrub');
    expect(await treeShrubFastIneligibleReason(visit(), { ...TS_PROFILE, findingsType: null }, knex())).toBe('not_tree_shrub');
  });
  test('project-backed profiles are ineligible', async () => {
    expect(await treeShrubFastIneligibleReason(visit(), { ...TS_PROFILE, projectBacked: true }, knex())).toBe('project_backed');
    expect(await treeShrubFastIneligibleReason(visit(), { ...TS_PROFILE, requiresProject: true }, knex())).toBe('project_backed');
  });
  test('the retired lawn + T&S companion path is ineligible', async () => {
    expect(await treeShrubFastIneligibleReason(visit(), { ...TS_PROFILE, companions: [{ type: 'lawn', delivery: 'auto_send' }] }, knex())).toBe('has_companions');
  });
  test('a live visit group, or an orphaned pointer, is ineligible; a dissolved one is not', async () => {
    expect(await treeShrubFastIneligibleReason(visit({ visit_id: 'v' }), TS_PROFILE, knex({ status: 'open' }))).toBe('grouped_visit');
    expect(await treeShrubFastIneligibleReason(visit({ visit_id: 'v' }), TS_PROFILE, knex(undefined))).toBe('grouped_visit');
    expect(await treeShrubFastIneligibleReason(visit({ visit_id: 'v' }), TS_PROFILE, knex({ status: 'dissolved' }))).toBeNull();
  });
  test.each(['completed', 'cancelled', 'skipped', 'no_show', 'incomplete', 'rescheduled'])('terminal status %s is ineligible', async (status) => {
    expect(await treeShrubFastIneligibleReason(visit({ status }), TS_PROFILE, knex())).toBe('terminal_status');
  });
  test.each(['pending', 'confirmed', 'en_route', 'on_site'])('live status %s is eligible', async (status) => {
    expect(await treeShrubFastIneligibleReason(visit({ status }), TS_PROFILE, knex())).toBeNull();
  });
});

describe('treeShrubProductFlags', () => {
  const ctx = { serviceDate: '2026-07-10', zone: 'manatee_parrish' };
  test('N/P fertilizer is blackout in summer for a blackout zone, never otherwise', () => {
    const fert = cat('f', 'LESCO 13-0-13 60% PolyPlus Landscape');
    expect(treeShrubProductFlags(fert, ctx).npBlackout).toBe(true);
    expect(treeShrubProductFlags(fert, { ...ctx, serviceDate: '2026-10-01' }).npBlackout).toBe(false);
    expect(treeShrubProductFlags(fert, { ...ctx, zone: 'north_port' }).npBlackout).toBe(false);
    // A structured 0-N 0-P analysis wins over a fertilizer category, as at /complete.
    const zeroNp = cat('s', 'Summer Blend', { category: 'fertilizer', fertilizer_analysis: { n: 0, p: 0, k: 16 } });
    expect(treeShrubProductFlags(zeroNp, ctx).npBlackout).toBe(false);
    expect(treeShrubProductFlags(cat('k', 'Kontos Insecticide/Miticide'), ctx).npBlackout).toBe(false);
  });
  test('an N/P-free blend is not blackout', () => {
    expect(treeShrubProductFlags(cat('z', 'LESCO 0-0-16 Summer Blend'), ctx).npBlackout).toBe(false);
  });
  test('insect products and the rotation-logged families carry the closeout classifiers', () => {
    const kontos = treeShrubProductFlags(cat('k', 'Kontos Insecticide/Miticide', { category: 'insecticide' }), ctx);
    expect(kontos).toMatchObject({ insectFamily: true, needsIracFrac: true, injection: false });
    const kphite = treeShrubProductFlags(cat('p', 'KPHITE 7LP Systemic Fungicide', { category: 'fungicide' }), ctx);
    expect(kphite).toMatchObject({ insectFamily: false, needsIracFrac: true });
    const cytogro = treeShrubProductFlags(cat('c', 'Cytogro Liquid Biostimulant'), ctx);
    expect(cytogro).toMatchObject({ insectFamily: false, needsIracFrac: false, npBlackout: false, injection: false });
  });
  test('a category-only insecticide row is still the insect family', () => {
    expect(treeShrubProductFlags(cat('x', 'House Brand Spray', { category: 'insecticide' }), ctx).insectFamily).toBe(true);
  });
  test('a catalog IRAC group alone requires the rotation log', () => {
    expect(treeShrubProductFlags(cat('g', 'Unlabeled Product', { irac_group: '28' }), ctx).needsIracFrac).toBe(true);
  });
  test('injection products are flagged', () => {
    expect(treeShrubProductFlags(cat('i', 'Arborjet IMA-jet'), ctx).injection).toBe(true);
  });
});

describe('buildTreeShrubWarnings', () => {
  const visitDate = '2026-10-01';
  const kontos = cat('kontos', 'Kontos Insecticide/Miticide', { irac_group: '23' });
  const mainspring = cat('mainspring', 'Mainspring GNL Insecticide', { irac_group: '28' });
  const kphite = cat('kphite', 'KPHITE 7LP Systemic Fungicide', { frac_group: 'P07' });
  const palm = cat('palm', 'LESCO 8-2-12 Palm & Tropical Ornamental Granular Fertilizer', { category: 'fertilizer' });
  const orn = cat('orn', 'LESCO 13-0-13 60% PolyPlus Landscape', { category: 'fertilizer' });
  const plain = cat('plain', 'Cytogro Liquid Biostimulant');
  const catalogRows = [kontos, mainspring, kphite, palm, orn, plain];

  const app = (daysAgo, row, extra = {}) => ({
    application_date: new Date(Date.UTC(2026, 9, 1 - daysAgo)).toISOString().slice(0, 10),
    product_id: row.id, product_name: row.name, category: row.category, active_ingredient: null,
    irac_group: row.irac_group ?? null, frac_group: row.frac_group ?? null, moa_group: row.moa_group ?? null,
    analysis_n: null, analysis_p: null, history_moa_group: null, ...extra,
  });

  test('no history, no warnings', () => {
    expect(buildTreeShrubWarnings({ catalogRows, applications: [], visitDate })).toEqual([]);
  });

  test('the same IRAC group within 60 days warns with the product name and days ago', () => {
    const warnings = buildTreeShrubWarnings({ catalogRows, applications: [app(21, kontos)], visitDate });
    expect(warnings).toEqual([{
      type: 'rotation', productId: 'kontos', productName: 'Kontos Insecticide/Miticide', group: 'IRAC 23',
      daysAgo: 21, appliedProductName: 'Kontos Insecticide/Miticide', appliedOn: '2026-09-10',
    }]);
  });

  test('the window is inclusive at 60 days and silent at 61; a different group never warns', () => {
    expect(buildTreeShrubWarnings({ catalogRows, applications: [app(60, kontos)], visitDate })).toHaveLength(1);
    expect(buildTreeShrubWarnings({ catalogRows, applications: [app(61, kontos)], visitDate })).toEqual([]);
    expect(buildTreeShrubWarnings({ catalogRows, applications: [app(10, mainspring)], visitDate }).map((w) => w.productId)).toEqual(['mainspring']);
  });

  test('a different product in the same group warns the candidate, naming what was applied', () => {
    const sibling = cat('sib', 'Another IRAC 23 Product', { irac_group: '23' });
    const warnings = buildTreeShrubWarnings({ catalogRows, applications: [app(5, sibling)], visitDate });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ productId: 'kontos', appliedProductName: 'Another IRAC 23 Product', daysAgo: 5 });
  });

  test('the most recent matching application is the one named', () => {
    const warnings = buildTreeShrubWarnings({ catalogRows, applications: [app(40, kontos), app(12, kontos)], visitDate });
    expect(warnings[0].daysAgo).toBe(12);
  });

  test('a ledger row with no catalog row falls back to its own moa_group', () => {
    const legacy = cat('legacy', 'Legacy Product', { moa_group: 'Group 3A' });
    const candidate = cat('cand', 'Candidate', { moa_group: '3A' });
    const warnings = buildTreeShrubWarnings({
      catalogRows: [candidate],
      applications: [app(9, legacy, { product_id: null, product_name: null, moa_group: null, history_moa_group: 'Group 3A' })],
      visitDate,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ type: 'rotation', productId: 'cand', group: 'MOA 3A' });
  });

  test('a combination product shares each of its groups: IRAC 28+4A warns a group-28 candidate', () => {
    const acelepryn = cat('acx', 'Acelepryn Xtra', { irac_group: '28+4A' });
    const warnings = buildTreeShrubWarnings({ catalogRows, applications: [app(14, acelepryn)], visitDate });
    expect(warnings).toEqual([expect.objectContaining({ type: 'rotation', productId: 'mainspring', group: 'IRAC 28', appliedProductName: 'Acelepryn Xtra' })]);
  });

  test('a single-group application warns a combination candidate on the shared group', () => {
    const temprid = cat('tfx', 'Temprid FX', { category: 'insecticide', moa_group: 'Group 3A + 4A' });
    const bifen = cat('bif', 'Bifenthrin', { category: 'insecticide', moa_group: 'Group 3A' });
    const warnings = buildTreeShrubWarnings({ catalogRows: [temprid], applications: [app(7, bifen)], visitDate });
    expect(warnings).toEqual([expect.objectContaining({ productId: 'tfx', group: 'IRAC 3A' })]);
  });

  test('moa_group takes its family from the category: a herbicide group 3 never matches a fungicide group 3', () => {
    const snapshot = cat('snap', 'Snapshot 2.5TG', { category: 'herbicide', moa_group: 'Group 3 + 29' });
    const headway = cat('head', 'Headway Fungicide', { category: 'fungicide', moa_group: 'Group 11 + 3' });
    const pillar = cat('pil', 'Pillar G Intrinsic', { category: 'fungicide', moa_group: 'Group 11 + 3' });
    expect(buildTreeShrubWarnings({ catalogRows: [snapshot], applications: [app(5, headway)], visitDate })).toEqual([]);
    expect(buildTreeShrubWarnings({ catalogRows: [pillar], applications: [app(5, headway)], visitDate }))
      .toEqual([expect.objectContaining({ productId: 'pil', group: 'FRAC 11, FRAC 3' })]);
  });

  test('a combination herbicide shares its secondary HRAC group', () => {
    const celsius = cat('cel', 'Celsius WG', { category: 'herbicide', hrac_group: '2', hrac_group_secondary: '4' });
    const speedzone = cat('spz', 'SpeedZone Southern', { category: 'herbicide', hrac_group: '4' });
    expect(buildTreeShrubWarnings({ catalogRows: [speedzone], applications: [app(6, celsius, { hrac_group: '2', hrac_group_secondary: '4' })], visitDate }))
      .toEqual([expect.objectContaining({ productId: 'spz', group: 'HRAC 4' })]);
  });

  test('an unlinked ledger row keeps its own category, so its moa_group keeps its family', () => {
    const snapshot = cat('snap', 'Snapshot 2.5TG', { category: 'herbicide', moa_group: 'Group 3 + 29' });
    const fungicideRow = { product_id: null, product_name: null, category: 'fungicide', moa_group: null, history_moa_group: 'Group 3' };
    expect(buildTreeShrubWarnings({ catalogRows: [snapshot], applications: [app(5, cat('x', 'x'), fungicideRow)], visitDate })).toEqual([]);
  });

  test('an unlinked palm fertilizer application (named through its service product) still warns on spacing', () => {
    const palmCandidate = cat('palm', 'LESCO 8-2-12 100% Poly Plus Palm & Tropical Ornamental Granular Fertilizer', { category: 'fertilizer' });
    const unlinked = {
      application_date: '2026-08-12', product_id: null, category: 'fertilizer',
      product_name: 'LESCO 8-2-12 Palm & Tropical Ornamental Granular Fertilizer', moa_group: null, history_moa_group: null,
    };
    expect(buildTreeShrubWarnings({ catalogRows: [palmCandidate], applications: [unlinked], visitDate }))
      .toEqual([expect.objectContaining({ type: 'palm_fertilizer_spacing', productId: 'palm', daysAgo: 50 })]);
  });

  test('an IRAC code never matches a FRAC code of the same text', () => {
    const fungicide = cat('fung', 'Some Fungicide', { frac_group: '23' });
    expect(buildTreeShrubWarnings({ catalogRows: [fungicide], applications: [app(5, kontos)], visitDate })).toEqual([]);
  });

  test('a palm fertilizer within 75 days warns on palm fertilizer candidates only', () => {
    const warnings = buildTreeShrubWarnings({ catalogRows, applications: [app(70, palm)], visitDate });
    expect(warnings).toEqual([{
      type: 'palm_fertilizer_spacing', productId: 'palm', productName: palm.name, windowDays: 75,
      daysAgo: 70, appliedProductName: palm.name, appliedOn: '2026-07-23',
    }]);
    expect(buildTreeShrubWarnings({ catalogRows, applications: [app(76, palm)], visitDate })).toEqual([]);
  });

  test('an ornamental (non-palm) fertilizer does not trigger the palm spacing warning', () => {
    expect(buildTreeShrubWarnings({ catalogRows, applications: [app(10, orn)], visitDate })).toEqual([]);
  });

  test('applications dated after the visit are ignored', () => {
    expect(buildTreeShrubWarnings({ catalogRows, applications: [app(-3, kontos)], visitDate })).toEqual([]);
  });
});

describe('lastAmountsByProduct', () => {
  test('the most recent actual amount per product wins; blank / zero / unitless rows are not amounts', () => {
    const history = [
      { service_date: '2026-09-01', products: [
        { product_id: 'a', total_amount: '0', amount_unit: 'oz' },
        { product_id: 'b', total_amount: '3', amount_unit: '' },
        { product_id: 'c', total_amount: '4.5', amount_unit: 'lb' },
      ] },
      { service_date: new Date('2026-06-01T00:00:00Z'), products: [
        { product_id: 'a', total_amount: '2', amount_unit: 'oz' },
        { product_id: 'c', total_amount: '9', amount_unit: 'lb' },
        { product_id: null, total_amount: '1', amount_unit: 'oz' },
      ] },
    ];
    const map = lastAmountsByProduct(history);
    expect(map.get('a')).toEqual({ totalAmount: 2, amountUnit: 'oz', serviceDate: '2026-06-01' });
    expect(map.has('b')).toBe(false);
    expect(map.get('c')).toEqual({ totalAmount: 4.5, amountUnit: 'lb', serviceDate: '2026-09-01' });
    expect(map.size).toBe(2);
  });
});

describe('per-area rate units never pre-fill', () => {
  test('a lb/1000sf row is skipped and an older real amount is used', () => {
    const history = [
      { id: 'r2', service_date: '2026-09-02', products: [{ product_id: 'snap', total_amount: '2.3', amount_unit: 'lb/1000sf' }] },
      { id: 'r1', service_date: '2026-07-01', products: [{ product_id: 'snap', total_amount: '25', amount_unit: 'lb' }] },
    ];
    expect(lastAmountsByProduct(history).get('snap')).toEqual({ totalAmount: 25, amountUnit: 'lb', serviceDate: '2026-07-01' });
  });

  test('the last visit lists a rate row with no amount', () => {
    const last = buildLastVisit([{ id: 'r2', status: 'completed', service_date: '2026-09-02', typed_values: {}, products: [{ product_id: 'snap', product_name: 'Snapshot 2.5TG', total_amount: '2.3', amount_unit: 'lb/1000sf' }] }]);
    expect(last.products).toEqual([{ productId: 'snap', productName: 'Snapshot 2.5TG', totalAmount: null, amountUnit: null }]);
  });
});

describe('buildTreeShrubFastContext', () => {
  const catalog = [
    cat('snapshot', 'Snapshot 2.5TG', { category: 'herbicide' }),
    cat('palm', 'LESCO 8-2-12 100% Poly Plus Palm & Tropical Ornamental Granular Fertilizer', { category: 'fertilizer' }),
    cat('orn', 'LESCO 13-0-13 60% PolyPlus Landscape', { category: 'fertilizer' }),
    cat('kphite', 'KPHITE 7LP Systemic Fungicide', { category: 'fungicide', frac_group: 'P07' }),
  ];

  beforeEach(() => {
    resolveCompletionProfileForScheduledService.mockReset();
    resolveCompletionProfileForScheduledService.mockResolvedValue(TS_PROFILE);
  });

  test('a missing visit is not_found', async () => {
    expect(await buildTreeShrubFastContext('nope', fakeKnex({ scheduled_services: undefined }))).toEqual({ ok: false, reason: 'not_found' });
  });

  test('an ineligible visit answers the reason and identity only', async () => {
    resolveCompletionProfileForScheduledService.mockResolvedValue({ ...TS_PROFILE, findingsType: 'pest' });
    const ctx = await buildTreeShrubFastContext('visit-1', fakeKnex({ scheduled_services: visit() }));
    expect(ctx).toMatchObject({ ok: true, eligible: false, reason: 'not_tree_shrub', service: { id: 'visit-1', propertyId: 'prop-1', serviceKey: 'tree_shrub_program' } });
    expect(ctx.products).toBeUndefined();
  });

  test('no T&S history (prod today): month products carry no amount, lastVisit is null, nothing throws', async () => {
    const ctx = await buildTreeShrubFastContext('visit-1', fakeKnex({
      scheduled_services: visit(), products_catalog: catalog, 'service_records as sr': [], property_application_history: [],
      'property_application_history as pah': [],
    }));
    expect(ctx).toMatchObject({ ok: true, eligible: true, reason: null, lastVisit: null, warnings: [] });
    expect(ctx.warningsUnavailable).toBeUndefined();
    expect(ctx.service).toMatchObject({ id: 'visit-1', customerId: 'cust-1', propertyId: 'prop-1', catalogServiceId: 'cat-1', serviceKey: 'tree_shrub_program' });
    // October protocol: Snapshot, 8-2-12, 13-0-13, KPHITE — suggestions, no amounts invented.
    expect(ctx.monthProducts).toEqual([
      { productId: 'snapshot', method: 'granular_broadcast' },
      { productId: 'palm', method: 'granular_broadcast' },
      { productId: 'orn', method: 'granular_broadcast' },
      { productId: 'kphite', method: 'foliar_spray' },
    ]);
    expect(ctx.products.map((p) => p.id)).toEqual(['snapshot', 'palm', 'orn', 'kphite']);
    expect(ctx.products.find((p) => p.id === 'kphite').tsFlags).toMatchObject({ needsIracFrac: true });
    expect(ctx.products.find((p) => p.id === 'palm').tsFlags.npBlackout).toBe(false);
  });

  test('a summer visit in a blackout zone flags N/P fertilizer on the catalog rows', async () => {
    const ctx = await buildTreeShrubFastContext('visit-1', fakeKnex({
      scheduled_services: visit({ scheduled_date: '2026-07-10' }), products_catalog: catalog,
    }));
    expect(ctx.products.find((p) => p.id === 'orn').tsFlags.npBlackout).toBe(true);
    expect(ctx.products.find((p) => p.id === 'snapshot').tsFlags.npBlackout).toBe(false);
  });

  test('last visit values and per-product last amounts come from the typed snapshot and service_products', async () => {
    const records = [
      { id: 'rec-2', status: 'completed', service_date: '2026-09-02', typed_values: { plant_groups: 'Palms, Shrubs', areas_treated: 'Front landscape, Foundation beds', landscape_condition: 'Good' } },
      { id: 'rec-1', status: 'completed', service_date: '2026-07-01', typed_values: { plant_groups: 'Hedges' } },
    ];
    const ctx = await buildTreeShrubFastContext('visit-1', fakeKnex({
      scheduled_services: visit(), products_catalog: catalog, 'service_records as sr': records,
      service_products: [
        { service_record_id: 'rec-2', product_id: 'kphite', product_name: 'KPHITE 7LP Systemic Fungicide', total_amount: '2.000', amount_unit: 'qt' },
        { service_record_id: 'rec-1', product_id: 'snapshot', product_name: 'Snapshot 2.5TG', total_amount: '25.5', amount_unit: 'lb' },
        { service_record_id: 'rec-1', product_id: 'kphite', product_name: 'KPHITE 7LP Systemic Fungicide', total_amount: '1', amount_unit: 'qt' },
      ],
    }));
    expect(ctx.lastVisit).toEqual({
      serviceRecordId: 'rec-2', serviceDate: '2026-09-02',
      plantGroups: ['Palms', 'Shrubs'], areasTreated: ['Front landscape', 'Foundation beds'],
      products: [{ productId: 'kphite', productName: 'KPHITE 7LP Systemic Fungicide', totalAmount: 2, amountUnit: 'qt' }],
    });
    const byId = Object.fromEntries(ctx.monthProducts.map((m) => [m.productId, m]));
    expect(byId.kphite.lastAmount).toEqual({ totalAmount: 2, amountUnit: 'qt', serviceDate: '2026-09-02' });
    // Snapshot is quarterly: its amount comes from the earlier visit that applied it.
    expect(byId.snapshot.lastAmount).toEqual({ totalAmount: 25.5, amountUnit: 'lb', serviceDate: '2026-07-01' });
    expect(byId.palm.lastAmount).toBeUndefined();
  });

  test('a failed history read degrades to blank pre-fill; a failed ledger read is warningsUnavailable', async () => {
    const ctx = await buildTreeShrubFastContext('visit-1', fakeKnex({
      scheduled_services: visit(), products_catalog: catalog,
      'service_records as sr': new Error('boom'), 'property_application_history as pah': new Error('boom'),
    }));
    expect(ctx).toMatchObject({ ok: true, eligible: true, lastVisit: null, warnings: [], warningsUnavailable: true });
    expect(ctx.monthProducts.every((m) => m.lastAmount === undefined)).toBe(true);
  });

  test('a catalog that fails to load (the shared loader answers []) sends the visit to the full form', async () => {
    const ctx = await buildTreeShrubFastContext('visit-1', fakeKnex({ scheduled_services: visit(), products_catalog: new Error('db down') }));
    expect(ctx).toMatchObject({ ok: true, eligible: false, reason: 'catalog_unavailable', service: { id: 'visit-1' } });
    expect(ctx.products).toBeUndefined();
  });

  test('an unresolved property pre-fills nothing from history', async () => {
    const records = [{ id: 'rec-9', status: 'completed', service_date: '2026-09-02', typed_values: { plant_groups: 'Palms' } }];
    const ctx = await buildTreeShrubFastContext('visit-1', fakeKnex({
      scheduled_services: visit({ property_id: null }), products_catalog: catalog, 'service_records as sr': records,
      service_products: [{ service_record_id: 'rec-9', product_id: 'kphite', total_amount: '2', amount_unit: 'qt' }],
    }));
    expect(ctx).toMatchObject({ ok: true, eligible: true, lastVisit: null });
    expect(ctx.monthProducts.every((m) => m.lastAmount === undefined)).toBe(true);
  });

  test.each([
    ['a Bradenton property for a North Port customer', 'North Port', 'Bradenton'],
    ['a North Port property for a Bradenton customer', 'Bradenton', 'North Port'],
  ])('%s takes the full form (the server checks the customer-city zone)', async (_label, custCity, visitCity) => {
    const ctx = await buildTreeShrubFastContext('visit-1', fakeKnex({
      scheduled_services: visit({
        scheduled_date: '2026-07-10', cust_city: custCity,
        service_address_line1: '200 Sample Lane', service_address_city: visitCity, service_address_state: 'FL', service_address_zip: '34203',
      }),
      products_catalog: catalog,
    }));
    expect(ctx).toMatchObject({ ok: true, eligible: false, reason: 'zone_mismatch', service: { address: { city: visitCity } } });
    expect(ctx.products).toBeUndefined();
  });

  test('history: incomplete records feed amounts but never become the last visit', async () => {
    const records = [
      { id: 'rec-inc', status: 'incomplete', service_date: '2026-09-20', typed_values: { plant_groups: 'Hedges' } },
      { id: 'rec-ok', status: 'completed', service_date: '2026-09-02', typed_values: { plant_groups: 'Palms' } },
    ];
    const ctx = await buildTreeShrubFastContext('visit-1', fakeKnex({
      scheduled_services: visit(), products_catalog: catalog, 'service_records as sr': records,
      service_products: [
        { service_record_id: 'rec-inc', product_id: 'kphite', total_amount: '3', amount_unit: 'qt' },
        { service_record_id: 'rec-ok', product_id: 'kphite', total_amount: '2', amount_unit: 'qt' },
      ],
    }));
    expect(ctx.lastVisit).toMatchObject({ serviceRecordId: 'rec-ok', plantGroups: ['Palms'] });
    expect(ctx.monthProducts.find((m) => m.productId === 'kphite').lastAmount).toEqual({ totalAmount: 3, amountUnit: 'qt', serviceDate: '2026-09-20' });
  });

  test('recent ledger rows produce warnings on the context', async () => {
    const ctx = await buildTreeShrubFastContext('visit-1', fakeKnex({
      scheduled_services: visit({ scheduled_date: '2026-10-01' }), products_catalog: catalog,
      'property_application_history as pah': [{
        application_date: '2026-09-21', product_id: 'kphite', product_name: 'KPHITE 7LP Systemic Fungicide',
        category: 'fungicide', frac_group: 'P07', irac_group: null, moa_group: null, history_moa_group: null,
      }],
    }));
    expect(ctx.warnings).toEqual([expect.objectContaining({ type: 'rotation', productId: 'kphite', daysAgo: 10, group: 'FRAC P07' })]);
  });
});
