// GET /api/admin/protocols/completion-actions (the fallback the tech sheet uses when GATE_LAWN_COMPLETION_DEFAULTS is off) builds its chips from
// the visit the PLAN reads: a December visit at a lawn with a mapped large patch lists the LESCO Black Out 0-0-24 (not the 10-0-22) and states the
// same objective, through the shared decision (visitNutrientTargets). A non-qualifying lawn and the gate off give the recipe's own December
// exactly. Real handler and plan engine; synthetic fixtures.
jest.mock('../models/db', () => jest.fn());
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: jest.fn(), requireAdmin: jest.fn(), requireTechOrAdmin: jest.fn(),
}));
jest.mock('../services/lawn-protocol-operating-layer', () => ({
  getActiveLawnProtocol: jest.fn(),
  getProtocolWindowContext: jest.fn(),
  summarizeProtocolContext: jest.fn(),
  protocolReferenceSyncIssues: jest.fn(),
  lockDraftProtocol: jest.fn(),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const mockCheckLimits = jest.fn();
jest.mock('../services/application-limits', () => ({ checkLimits: (...args) => mockCheckLimits(...args) }));
// The trouble-area store: the property a visit works on, and its active areas.
const mockLoadActive = jest.fn();
jest.mock('../services/lawn-trouble-areas', () => ({
  propertyOf: jest.fn(async (knex, svc) => svc?.property_id || null),
  loadActive: (...args) => mockLoadActive(...args),
  // The rules ask for a LARGE PATCH area (loadActiveLargePatch); this store answers for it with the areas the test sets. The evidence itself
  // (the newest fungicide target at the place) is tested against real rows in lawn-v13-nov-large-patch-n.db.test.js and lawn-v13-dec-large-patch-k.plan.db.test.js.
  loadActiveLargePatch: (...args) => mockLoadActive(...args),
}));

const db = require('../models/db');
const operatingLayer = require('../services/lawn-protocol-operating-layer');
const adminProtocolsRouter = require('../routes/admin-protocols');
const { LAWN_V13_VERSION } = require('../services/lawn-program');
const { DEC_FROM, DEC_K_PRODUCT, V13_TROUBLE_PRODUCT_SWAPS } = require('../config/lawn-v13-trouble-product-swaps');

const CATALOG = [
  { id: 't22', name: DEC_FROM, aliases: [], analysis_n: 10, analysis_p: 0, analysis_k: 22, default_rate_per_1000: 4.5, rate_unit: 'lb', cost_per_unit: 1, cost_unit: 'lb' },
  { id: 'bo', name: DEC_K_PRODUCT, aliases: [], analysis_n: 0, analysis_p: 0, analysis_k: 24, default_rate_per_1000: 4.1, rate_unit: 'lb', unit_size_oz: 800, best_price: 30.06 },
];
// The December window as the staging and this PR's migration leave it: the 10-0-22 default row and the non-default 0-0-24 row.
const V13_SUMMARY = {
  version: LAWN_V13_VERSION,
  products: [
    { productId: 't22', ratePer1000: null, rateUnit: 'lb_n', defaultInPlan: true, gates: { targetN: '0.45 lb N/1000', targetK2O: '0.99 lb K2O/1000', blackoutSensitive: true } },
    { productId: 'bo', ratePer1000: null, rateUnit: 'lb_k', defaultInPlan: false, gates: { targetK: '0.99 lb K2O/1000', trigger: 'active_large_patch_mapped' } },
  ],
};
const PROPERTY = '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const VISIT = '3f2c1d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const NOTE = 'Active large patch mapped: potassium-only bag, no nitrogen (4.125 lb per 1,000 sq ft = 0.99 lb K2O). Used in place of the LESCO 10-0-22.';
const GATES = ['GATE_LAWN_V13', 'GATE_LAWN_SPOT_RULES', 'GATE_LAWN_TREATMENT_GUIDE', 'GATE_LAWN_TROUBLE_AREAS', 'GATE_LAWN_SPOT_TARGET', 'GATE_LAWN_DEC_LARGE_PATCH_K'];
const NORMAL_LINE = `${DEC_FROM} \u2014 4.5 lb per 1,000 sq ft (0.45 lb N, 0.99 lb K2O), spreader`;

const v13 = require('../config/lawn-protocol-v13.json');
const handler = adminProtocolsRouter.stack.find((layer) => layer.route?.path === '/completion-actions' && layer.route.methods.get).route.stack[0].handle;

function readQuery(rows) {
  const query = {};
  for (const method of ['where', 'orWhereNull', 'whereIn', 'join', 'select', 'orderByRaw', 'orderBy']) query[method] = jest.fn(() => query);
  query.first = jest.fn(async () => rows[0] || null);
  query.catch = (onRejected) => Promise.resolve(rows).catch(onRejected);
  return query;
}

async function actions(query = {}) {
  const res = { json: jest.fn(), status: jest.fn() };
  res.status.mockReturnValue(res);
  const next = jest.fn();
  await handler({ query: { serviceType: 'Lawn Care', track: 'bermuda', month: '12', scheduledServiceId: VISIT, ...query } }, res, next);
  expect(next).not.toHaveBeenCalled();
  expect(res.status).not.toHaveBeenCalled();
  return JSON.parse(JSON.stringify(res.json.mock.calls[0][0]));
}
const rawsOf = (body) => body.actions.map((action) => action.raw);
const namesOf = (body) => body.actions.map((action) => action.product?.name).filter(Boolean);
const OLD_PRIMARY = v13.bermuda.visits[11].primary;
const OLD_NOTES = v13.bermuda.visits[11].notes;

let visit;

beforeEach(() => {
  jest.clearAllMocks();
  visit = { id: VISIT, customer_id: 'cust-1', property_id: PROPERTY, scheduled_date: '2026-12-10', service_id: null, service_type: 'Lawn Care', recurring_pattern: null, recurring_interval_days: null };
  mockCheckLimits.mockReset().mockResolvedValue({ allowed: true, blocks: [], warnings: [] });
  mockLoadActive.mockReset().mockResolvedValue([{ id: 'a1', place: 'front', type: 'fungus' }]);
  for (const name of GATES) process.env[name] = 'true';
  operatingLayer.getProtocolWindowContext.mockResolvedValue({ protocol: { version: LAWN_V13_VERSION } });
  operatingLayer.summarizeProtocolContext.mockReturnValue(V13_SUMMARY);
  db.mockImplementation((table) => {
    if (table === 'equipment_calibrations as ec') {
      return readQuery([{ id: 'cal', equipment_system_id: 'tank', system_name: 'Tank', system_type: 'tank', carrier_gal_per_1000: 1, tank_capacity_gal: 110, expires_at: '2099-01-01T00:00:00Z' }]);
    }
    if (table === 'products_catalog') return readQuery(CATALOG);
    if (table === 'product_aliases') return readQuery([]);
    if (table === 'scheduled_services') return readQuery([visit]);
    if (table === 'customer_turf_profiles') return readQuery([]);
    if (table === 'customers') return readQuery([]);
    throw new Error(`Unexpected table: ${table}`);
  });
});
afterEach(() => { for (const name of [...GATES, 'GATE_LAWN_COMPLETION_DEFAULTS', 'GATE_LAWN_PROPERTY_HISTORY']) delete process.env[name]; });


describe('/completion-actions on a December visit', () => {
  test('qualifying lawn (mapped large patch, gate on): the chips list the Black Out line, not the 10-0-22, and the objective states the swap', async () => {
    const body = await actions();
    expect(rawsOf(body)).toContain(V13_TROUBLE_PRODUCT_SWAPS[0].line);
    expect(rawsOf(body)).not.toContain(OLD_PRIMARY);
    expect(namesOf(body)).toContain(DEC_K_PRODUCT);
    expect(namesOf(body)).not.toContain(DEC_FROM);
    expect(body.visit.objective).toMatch(/^N rate: 0 lb N \(active large patch mapped; normal 0\.45 lb N\)\. K rate: 0\.99 lb K\./);
    // The v13 fallback lists products with no amounts.
    expect(body.note).toMatch(/takes its amounts from the visit plan/);
    for (const action of body.actions.filter((entry) => entry.product)) expect(action.product.defaultRatePer1000 ?? null).toBeNull();
    // The same decision the tank sheet reads: it shows the same bag.
    expect(mockLoadActive).toHaveBeenCalledWith(db, PROPERTY, { asOf: '2026-12-10' });
  });

  test('every track gets the swap line', async () => {
    for (const track of ['st_augustine', 'zoysia']) expect(rawsOf(await actions({ track }))).toContain(V13_TROUBLE_PRODUCT_SWAPS[0].line);
  });

  test.each([
    ['no mapped area', () => mockLoadActive.mockResolvedValue([])],
    ['take-all and other types only', () => mockLoadActive.mockResolvedValue([{ id: 'a', type: 'take_all' }, { id: 'b', type: 'weeds' }])],
    ['the area read fails', () => mockLoadActive.mockRejectedValue(Object.assign(new Error('db down'), { code: 'ECONNRESET' }))],
  ])('non-qualifying lawn (%s): the recipe\'s own December, the 10-0-22 and the old objective', async (_label, arrange) => {
    arrange();
    const body = await actions();
    expect(rawsOf(body)).toContain(OLD_PRIMARY);
    expect(rawsOf(body).join('\n')).not.toContain('Black Out');
    expect(body.visit.objective).toBe(OLD_NOTES);
  });

  test('a visit with no property, and the reference (no scheduledServiceId): the recipe\'s own December', async () => {
    visit.property_id = null;
    expect(rawsOf(await actions())).toContain(OLD_PRIMARY);
    visit.property_id = PROPERTY;
    const reference = await actions({ scheduledServiceId: undefined });
    expect(rawsOf(reference)).toContain(OLD_PRIMARY);
    expect(reference.visit.objective).toBe(OLD_NOTES);
  });

  test.each(GATES.slice(1))('%s off: the payload is the recipe\'s own December, byte-identical to the gate-off payload, and no area is read', async (off) => {
    for (const name of GATES) process.env[name] = 'true';
    delete process.env[off];
    mockLoadActive.mockClear();
    const gated = await actions();
    expect(rawsOf(gated)).toContain(OLD_PRIMARY);
    expect(JSON.stringify(gated)).not.toContain('Black Out');
    expect(gated.visit.objective).toBe(OLD_NOTES);
    expect(mockLoadActive).not.toHaveBeenCalled();
    // And equal to the payload with every gate but GATE_LAWN_V13 off.
    for (const name of GATES.slice(1)) delete process.env[name];
    expect(await actions()).toEqual(gated);
  });

  test('another month is untouched, and reads no area', async () => {
    const body = await actions({ month: '11' });
    expect(rawsOf(body).join('\n')).not.toContain('Black Out');
    expect(mockLoadActive).not.toHaveBeenCalled();
  });

  test('a visit pinned to an older version, or to another month\'s window: no swap (the plan would not swap it either)', async () => {
    operatingLayer.getProtocolWindowContext.mockImplementation(async (knex, args) => (args.protocolKey
      ? { protocol: { version: '2026.05' }, windowMonth: 12 } : { protocol: { version: LAWN_V13_VERSION } }));
    operatingLayer.summarizeProtocolContext.mockImplementation((context) => (context?.protocol ? (context.protocol.version === LAWN_V13_VERSION ? V13_SUMMARY : { version: context.protocol.version, products: [], window: { month: context.windowMonth } }) : null));
    Object.assign(visit, { lawn_protocol_key: 'fixture_v13', lawn_protocol_version: '2026.05', lawn_protocol_window_key: 'dec_v13_spreader_feeding' });
    expect(rawsOf(await actions())).toContain(OLD_PRIMARY);
    expect(mockLoadActive).not.toHaveBeenCalled();
  });
});
