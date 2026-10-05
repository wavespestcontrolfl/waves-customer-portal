// Lawn Fast Complete follow-up: (1) eligibility excludes Tree & Shrub (it shares the lawn_care
// category) and the three sheets partition the visits; (2) the context exposes the completion
// profile's findingsType; (3) planned products carry the treated area / planned rate from the
// same completion-defaults plan item the full form prefills, failing closed. Failures are
// injected at the QUERY level (the real profile resolver runs). Synthetic data only.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
// No grass track known here: the protocol-window read resolves nothing and reads nothing.
jest.mock('../services/waveguard-plan-engine', () => ({ buildPlanForService: jest.fn(), selectProtocolVisit: jest.fn(() => ({ trackKey: null, track: null, month: 'Oct', visit: null })), getAppointmentSubstitutions: jest.fn(async () => new Map()) }));

const { buildPlanForService } = require('../services/waveguard-plan-engine');
const {
  lawnFastIneligibleReason, buildLawnFastContext, preflightLawnFastCompletion,
} = require('../services/lawn-fast-complete');
const { treeShrubFastIneligibleReason } = require('../services/tree-shrub-fast-context');
const { lawnReserviceIneligibleReason, isLawnReserviceProfile } = require('../services/lawn-reservice-fast-context');

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const VISIT = uuid(1);
const ASSESSMENT = uuid(2);
const CATALOG = uuid(3);
const CUSTOMER = uuid(30);
const P_HERB = uuid(11);
const P_GRAN = uuid(12);

const readError = () => Object.assign(new Error('connection lost'), { code: '08006' });
const visit = (extra = {}) => ({
  id: VISIT, customer_id: CUSTOMER, property_id: null, service_type: 'Lawn Care', service_id: CATALOG,
  scheduled_date: '2026-10-05', status: 'confirmed', visit_id: null, technician_id: null, ...extra,
});
const herbicide = {
  id: P_HERB, name: 'Test Weed Spray', category: 'herbicide', product_type: 'pesticide', formulation: 'WG',
  epa_reg_number: '100-1', approved_for_service_report: true,
  post_application_watering: { mode: 'hold', hold_hours: 24, source: 'label' },
};

function fakeKnex(tables) {
  const knex = jest.fn((table) => {
    const data = tables[table];
    const chain = {};
    for (const m of ['where', 'whereIn', 'whereNot', 'leftJoin', 'join', 'orderBy', 'select']) chain[m] = () => chain;
    chain.first = async () => { if (data instanceof Error) throw data; return Array.isArray(data) ? data[0] : data; };
    const settle = () => (data instanceof Error ? Promise.reject(data) : Promise.resolve(Array.isArray(data) ? data : []));
    chain.then = (resolve, reject) => settle().then(resolve, reject);
    chain.catch = (reject) => settle().catch(reject);
    return chain;
  });
  knex.raw = (sql) => ({ sql });
  knex.schema = { hasTable: async () => true };
  return knex;
}

// The catalog service and the completion-profile row, as the real resolver reads them.
const world = ({ service = {}, profile = {}, extra = {} } = {}) => fakeKnex({
  scheduled_services: visit(),
  services: { service_key: 'lawn_care_monthly', name: 'Lawn Care', category: 'lawn_care', billing_type: 'recurring', ...service },
  service_completion_profiles: {
    service_key: 'lawn_care_monthly', category: 'lawn_care', billing_type: 'recurring', completion_mode: 'service_report',
    project_type: null, companion_types: null, active: true, ...profile,
  },
  customers: { billing_mode: null },
  lawn_assessments: { id: ASSESSMENT, confirmed_by_tech: true, service_date: '2026-10-05' },
  lawn_assessment_photos: [],
  products_catalog: [herbicide],
  ...extra,
});
const TREE_SHRUB = { service: { service_key: 'tree_shrub_program', name: 'Tree & Shrub', category: 'lawn_care' }, profile: { service_key: 'tree_shrub_program', category: 'lawn_care', project_type: 'tree_shrub' } };

const saved = {
  fast: process.env.GATE_LAWN_FAST_COMPLETE, defaults: process.env.GATE_LAWN_COMPLETION_DEFAULTS, history: process.env.GATE_LAWN_PROPERTY_HISTORY,
};
beforeEach(() => {
  process.env.GATE_LAWN_FAST_COMPLETE = 'true';
  delete process.env.GATE_LAWN_COMPLETION_DEFAULTS;
  delete process.env.GATE_LAWN_PROPERTY_HISTORY;
  buildPlanForService.mockReset();
});
afterAll(() => {
  const restore = (key, value) => { if (value === undefined) delete process.env[key]; else process.env[key] = value; };
  restore('GATE_LAWN_FAST_COMPLETE', saved.fast);
  restore('GATE_LAWN_COMPLETION_DEFAULTS', saved.defaults);
  restore('GATE_LAWN_PROPERTY_HISTORY', saved.history);
});

const profileOf = (extra = {}) => ({
  category: 'lawn_care', serviceKey: 'lawn_care_monthly', billingType: 'recurring', findingsType: null,
  projectBacked: false, requiresProject: false, companions: [], ...extra,
});

describe('Tree & Shrub is not a lawn Fast Complete visit', () => {
  test('refused by the eligibility function with the reason tree_shrub', () => {
    expect(lawnFastIneligibleReason({ svc: visit(), profile: profileOf({ serviceKey: 'tree_shrub_program', findingsType: 'tree_shrub' }) })).toBe('tree_shrub');
  });

  test('refused in the context (identity returned, no heavy reads) and at the submit preflight', async () => {
    const ctx = await buildLawnFastContext(VISIT, { knex: world(TREE_SHRUB) });
    expect(ctx).toMatchObject({ ok: true, eligible: false, reason: 'tree_shrub', service: { id: VISIT } });
    expect(ctx.plannedProducts).toBeUndefined();
    const expectedVisit = {
      propertyId: null, customerId: CUSTOMER, catalogServiceId: CATALOG, serviceType: 'Lawn Care', scheduledDate: '2026-10-05',
      isCallback: false, address: {}, technicianId: null,
    };
    expect(await preflightLawnFastCompletion({
      knex: world(TREE_SHRUB), svc: { id: VISIT, customer_id: CUSTOMER }, lawnAssessmentId: ASSESSMENT, expectedVisit, lawnFast: { visitType: 'other' },
    })).toMatchObject({ status: 409, payload: { code: 'lawn_fast_not_eligible', reason: 'tree_shrub' } });
  });

  test.each([
    ['a recurring program visit', profileOf()],
    ['a per-application / other recurring key', profileOf({ serviceKey: 'lawn_care_quarterly' })],
    ['a one-time lawn visit (typed findings)', profileOf({ serviceKey: 'lawn_care_one_time', billingType: 'one_time', findingsType: 'one_time_lawn_treatment' })],
    ['a one-time lawn visit (untyped)', profileOf({ serviceKey: 'lawn_care_one_time', billingType: 'one_time' })],
  ])('%s is still eligible', (_label, profile) => {
    expect(lawnFastIneligibleReason({ svc: visit(), profile })).toBeNull();
  });

  test.each([
    ['lawn re-service', profileOf({ serviceKey: 'lawn_re_service', findingsType: 'one_time_lawn_treatment' }), 'lawn_re_service'],
    ['assessment visit', profileOf({ serviceKey: 'lawn_inspection' }), 'assessment_visit'],
  ])('%s is still refused as before', (_label, profile, reason) => {
    expect(lawnFastIneligibleReason({ svc: visit(), profile })).toBe(reason);
  });
});

describe('the three sheets partition the visits', () => {
  // Each sheet's own eligibility, composed the way each builds it: lawn re-service needs its service key
  // AND its predicate's null; T&S its findings type; lawn fast its function. Nothing overlaps.
  const sheets = {
    lawnFast: async (svc, profile) => lawnFastIneligibleReason({ svc, profile }) === null,
    lawnReservice: async (svc, profile, knex) => isLawnReserviceProfile(profile) && (await lawnReserviceIneligibleReason(svc, profile, knex)) === null,
    treeShrub: async (svc, profile, knex) => (await treeShrubFastIneligibleReason(svc, profile, knex)) === null,
  };
  const FIXTURES = [
    ['recurring lawn program', profileOf(), ['lawnFast']],
    ['quarterly lawn program', profileOf({ serviceKey: 'lawn_care_quarterly' }), ['lawnFast']],
    ['one-time lawn (typed)', profileOf({ serviceKey: 'lawn_care_one_time', billingType: 'one_time', findingsType: 'one_time_lawn_treatment' }), ['lawnFast']],
    ['one-time lawn (untyped)', profileOf({ serviceKey: 'lawn_care_one_time', billingType: 'one_time' }), ['lawnFast']],
    ['lawn re-service', profileOf({ serviceKey: 'lawn_re_service', findingsType: 'one_time_lawn_treatment', billingType: 'one_time' }), ['lawnReservice']],
    ['tree & shrub', profileOf({ serviceKey: 'tree_shrub_program', findingsType: 'tree_shrub' }), ['treeShrub']],
    ['lawn inspection (assessment)', profileOf({ serviceKey: 'lawn_inspection' }), []],
    ['project-backed lawn', profileOf({ projectBacked: true, requiresProject: true }), []],
    ['pest control', profileOf({ category: 'pest_control', serviceKey: 'pest_general_quarterly' }), []],
  ];

  test.each(FIXTURES)('%s: eligible for exactly the expected sheet, and never two', async (_label, profile, expected) => {
    const knex = fakeKnex({});
    const eligible = [];
    for (const [name, decide] of Object.entries(sheets)) if (await decide(visit(), profile, knex)) eligible.push(name);
    expect(eligible).toEqual(expected);
    expect(eligible.length).toBeLessThanOrEqual(1);
  });
});

describe('the context exposes the completion profile\'s findingsType', () => {
  test('null for a regular program visit', async () => {
    expect((await buildLawnFastContext(VISIT, { knex: world() })).findingsType).toBeNull();
  });

  test('one_time_lawn_treatment for a one-time lawn visit (the sheet then sends lawn_condition)', async () => {
    const knex = world({
      service: { service_key: 'lawn_care_one_time', billing_type: 'one_time' },
      profile: { service_key: 'lawn_care_one_time', billing_type: 'one_time', project_type: 'one_time_lawn_treatment' },
    });
    const ctx = await buildLawnFastContext(VISIT, { knex });
    expect(ctx).toMatchObject({ eligible: true, visitType: 'one_time', findingsType: 'one_time_lawn_treatment' });
  });

  test('absent from an ineligible context', async () => {
    const ctx = await buildLawnFastContext(VISIT, { knex: world(TREE_SHRUB) });
    expect(ctx.findingsType).toBeUndefined();
  });
});

describe('planned products carry the treated area from the completion-defaults plan item', () => {
  beforeEach(() => {
    process.env.GATE_LAWN_COMPLETION_DEFAULTS = 'true';
    process.env.GATE_LAWN_PROPERTY_HISTORY = 'true';
  });
  const planWith = (items) => buildPlanForService.mockResolvedValue({ completionDefaults: { items } });
  const ctx = (extra) => buildLawnFastContext(VISIT, { knex: world({ extra }) });

  test('treatedSqft (sqft), the planned rate and unit ride each item, exactly as the plan item carries them', async () => {
    planWith([
      { product: { id: P_HERB, name: 'Test Weed Spray' }, applicationMethod: 'broadcast_spray', mix: { amount: 2, amountUnit: 'fl oz', treatedSqft: 5400, ratePer1000: 0.4, rateUnit: 'fl oz' } },
      { product: { id: P_GRAN, name: 'Test Feed Granular' }, applicationMethod: 'granular_broadcast', mix: { amount: 20, amountUnit: 'lb', treatedSqft: 5400, ratePer1000: 3.7, rateUnit: 'lb' } },
    ]);
    const { plannedProducts, plannedProductsUnavailable, readFailures } = await ctx({ products_catalog: [herbicide] });
    expect(plannedProductsUnavailable).toBeNull();
    expect(readFailures).toEqual([]);
    expect(plannedProducts.items[0]).toMatchObject({
      productId: P_HERB, amount: 2, amountUnit: 'fl oz', treatedSqft: 5400, areaUnit: 'sqft', ratePer1000: 0.4, rateUnit: 'fl oz',
    });
    expect(plannedProducts.items[1]).toMatchObject({ productId: P_GRAN, treatedSqft: 5400, areaUnit: 'sqft', ratePer1000: 3.7, rateUnit: 'lb' });
  });

  test('the plan item has no area: null, never invented (the sheet asks)', async () => {
    planWith([{ product: { id: P_HERB, name: 'Test Weed Spray' }, applicationMethod: 'broadcast_spray', mix: { amount: null, amountUnit: 'fl oz' } }]);
    const { plannedProducts } = await ctx({ products_catalog: [herbicide] });
    expect(plannedProducts.items[0]).toMatchObject({ treatedSqft: null, areaUnit: null, ratePer1000: null, rateUnit: null });
  });

  test('a plan item with no mix at all gets nulls', async () => {
    planWith([{ product: { id: P_HERB, name: 'Test Weed Spray' } }]);
    const { plannedProducts } = await ctx({ products_catalog: [herbicide] });
    expect(plannedProducts.items[0]).toMatchObject({ treatedSqft: null, areaUnit: null });
  });

  test('the plan read fails: no items, so no area, and the reason and read failure are named', async () => {
    buildPlanForService.mockRejectedValue(readError());
    const result = await ctx({});
    expect(result.plannedProducts).toEqual({ source: null, items: [] });
    expect(result.plannedProductsUnavailable).toBe('planned_products_lookup_failed');
    expect(result.readFailures).toContain('planned_products');
  });

  test('the catalog read for the rules fails (query level): no items, never an item without its rule', async () => {
    planWith([{ product: { id: P_HERB, name: 'Test Weed Spray' }, mix: { treatedSqft: 5400 } }]);
    const result = await ctx({ products_catalog: readError() });
    expect(result.plannedProducts.items).toEqual([]);
    expect(result.plannedProductsUnavailable).toBe('planned_products_lookup_failed');
    expect(result.readFailures).toContain('planned_products');
  });

  test('a non-recurring visit still starts blank (no area either)', async () => {
    planWith([{ product: { id: P_HERB, name: 'Test Weed Spray' }, mix: { treatedSqft: 5400 } }]);
    const knex = world({ extra: { customers: { billing_mode: 'per_application' } } });
    const result = await buildLawnFastContext(VISIT, { knex });
    expect(result.plannedProducts).toEqual({ source: null, items: [] });
    expect(buildPlanForService).not.toHaveBeenCalled();
  });
});
