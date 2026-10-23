// GATE_LAWN_DEC_LARGE_PATCH_K (owner 2026-10-23) on the lawn tank sheet (GET /api/admin/protocols/lawn-mix): a v13 December visit
// at a lawn with an ACTIVE mapped fungus area puts down LESCO Black Out 0-0-24 (4.125 lb per 1,000 from the 0.99 lb K2O target, noted
// as 4.1, 0 lb N) instead of the LESCO 10-0-22 (4.5 lb, 0.45 lb N); the yearly-limit read sees the swapped bag. Real handler and plan
// engine; synthetic fixtures.
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
}));

const db = require('../models/db');
const operatingLayer = require('../services/lawn-protocol-operating-layer');
const adminProtocolsRouter = require('../routes/admin-protocols');
const { LAWN_V13_VERSION } = require('../services/lawn-program');
const { DEC_FROM, DEC_K_PRODUCT } = require('../config/lawn-v13-trouble-product-swaps');

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
const NOTE = 'Active large patch mapped: potassium-only bag, no nitrogen (4.1 lb per 1,000 sq ft = 0.99 lb K2O). Used in place of the LESCO 10-0-22.';
const GATES = ['GATE_LAWN_V13', 'GATE_LAWN_SPOT_RULES', 'GATE_LAWN_TREATMENT_GUIDE', 'GATE_LAWN_TROUBLE_AREAS', 'GATE_LAWN_DEC_LARGE_PATCH_K'];
const NORMAL_LINE = `${DEC_FROM} \u2014 4.5 lb per 1,000 sq ft (0.45 lb N, 0.99 lb K2O), spreader`;

const handler = adminProtocolsRouter.stack.find((layer) => layer.route?.path === '/lawn-mix' && layer.route.methods.get).route.stack[0].handle;

function readQuery(rows) {
  const query = {};
  for (const method of ['where', 'orWhereNull', 'whereIn', 'join', 'select', 'orderByRaw', 'orderBy']) query[method] = jest.fn(() => query);
  query.first = jest.fn(async () => rows[0] || null);
  query.catch = (onRejected) => Promise.resolve(rows).catch(onRejected);
  return query;
}

async function lawnMix(query, track = 'bermuda') {
  const res = { json: jest.fn(), status: jest.fn() };
  res.status.mockReturnValue(res);
  const next = jest.fn();
  await handler({ query: { track, lawnSqft: '10000', ...query } }, res, next);
  expect(next).not.toHaveBeenCalled();
  return JSON.parse(JSON.stringify(res.json.mock.calls[0][0]));
}

const sheet = (extra = {}, track) => lawnMix({ month: '12', scheduledServiceId: VISIT, ...extra }, track);
const itemOf = (body, name) => body.items.find((item) => item.product?.name === name);
const selectedNames = (body) => body.selectedItems.map((item) => item.product?.name).filter(Boolean);
// The rate the limit reader was asked to judge for a product.
const limitRate = (id) => mockCheckLimits.mock.calls.find((call) => call[1] === id)?.[4]?.proposed?.ratePer1000;
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

describe('active large patch mapped, gate on', () => {
  test.each(['bermuda', 'st_augustine', 'zoysia'])('%s: the December bag is the 0-0-24 at 4.125 lb per 1,000, 41.25 lb on 10,000 sq ft, 0 lb N, with the technician note', async (track) => {
    const body = await sheet({}, track);
    const bag = itemOf(body, DEC_K_PRODUCT);
    expect(bag).toMatchObject({ selected: true, raw: expect.stringMatching(/^LESCO Black Out 0-0-24 AM Spar-TECH \u2014 4\.1 lb per 1,000 sq ft \(0 lb N, 0\.99 lb K2O\), spreader, active large patch mapped$/) });
    expect(bag.jobMix).toMatchObject({ rateSource: 'target_k_analysis', targetKPer1000: 0.99, amountUnit: 'lb', targetNPer1000: null });
    expect(bag.jobMix.ratePer1000).toBeCloseTo(4.125, 3);
    expect(bag.jobMix.amount).toBeCloseTo(41.25, 2);
    expect(bag.gateNotes).toContainEqual({ key: 'activeLargePatchPotassium', severity: 'note', text: NOTE });
    // The 10-0-22 is not on the sheet as a selected line, and no line still states its rate.
    expect(selectedNames(body)).toEqual([DEC_K_PRODUCT]);
    expect(itemOf(body, DEC_FROM)).toBeUndefined();
    expect(JSON.stringify([body.items, body.selectedItems, body.visit])).not.toContain('4.5 lb per 1,000');
    expect(body.visit.primary).toBe(bag.raw);
    expect(body.visit.objective).toMatch(/^N rate: 0 lb N \(active large patch mapped; normal 0\.45 lb N\)\. K rate: 0\.99 lb K\. Spreader visit\./);
    expect(mockLoadActive).toHaveBeenCalledWith(db, PROPERTY);
  });

  test('no nitrogen ordinance warning or block comes from the swapped bag; the cost line is priced from the stored SiteOne figure', async () => {
    const body = await sheet();
    expect(JSON.stringify([body.blocks, body.warnings])).not.toMatch(/nitrogen/i);
    const bag = itemOf(body, DEC_K_PRODUCT);
    expect(bag.jobMix.materialCost).toBeCloseTo((41.25 * 16 / 800) * 30.06, 1);
  });

  test('the yearly-limit read judges the swapped bag at the rate the sheet quotes', async () => {
    await sheet();
    expect(limitRate('bo')).toBeCloseTo(4.125, 3);
    expect(limitRate('t22')).toBeUndefined();
  });

  test('the planned mix of the line carries the same rate', async () => {
    expect(itemOf(await sheet(), DEC_K_PRODUCT).plannedMix.ratePer1000).toBeCloseTo(4.125, 3);
  });
});

describe('everything else keeps the 10-0-22 at 4.5 lb per 1,000 (0.45 lb N), byte for byte, with no note', () => {
  const expectNormal = async (query = {}) => {
    const body = await sheet(query);
    const bag = itemOf(body, DEC_FROM);
    expect(bag.raw).toBe(NORMAL_LINE);
    expect(body.visit.primary).toBe(NORMAL_LINE);
    expect(bag.jobMix.ratePer1000).toBeCloseTo(4.5, 3);
    expect(bag.jobMix).toMatchObject({ rateSource: 'target_n_analysis', targetNPer1000: 0.45 });
    expect(selectedNames(body)).toEqual([DEC_FROM]);
    expect(itemOf(body, DEC_K_PRODUCT)).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('activeLargePatchPotassium');
    expect(limitRate('t22')).toBeCloseTo(4.5, 3);
    return body;
  };

  test('the gate is off: the sheet equals the sheet with no gate flipped, and no area is read', async () => {
    const baseline = await (async () => { for (const name of GATES) delete process.env[name]; process.env.GATE_LAWN_V13 = 'true'; return sheet(); })();
    for (const name of GATES) process.env[name] = 'true';
    delete process.env.GATE_LAWN_DEC_LARGE_PATCH_K;
    mockLoadActive.mockClear();
    const body = await expectNormal();
    expect(body).toEqual(baseline);
    expect(mockLoadActive).not.toHaveBeenCalled();
  });

  test.each(['TRUE', '1', 'yes', ''])('the gate is %j (not exactly "true")', async (value) => {
    process.env.GATE_LAWN_DEC_LARGE_PATCH_K = value;
    await expectNormal();
  });

  test('the trouble-areas gate is off', async () => {
    delete process.env.GATE_LAWN_TROUBLE_AREAS;
    await expectNormal();
    expect(mockLoadActive).not.toHaveBeenCalled();
  });

  test('no active areas (a resolved area is not returned by the store), or take-all and other types only', async () => {
    mockLoadActive.mockResolvedValue([]);
    await expectNormal();
    mockLoadActive.mockResolvedValue([{ id: 'a2', type: 'take_all' }, { id: 'a3', type: 'weeds' }, { id: 'a4', type: 'chinch' }, { id: 'a5', type: 'dry_spot' }]);
    await expectNormal();
  });

  test('the trouble-area read fails', async () => {
    mockLoadActive.mockRejectedValue(Object.assign(new Error('db down'), { code: 'ECONNRESET' }));
    await expectNormal();
  });

  test('a visit with no property, and the reference tab (no visit)', async () => {
    visit.property_id = null;
    await expectNormal();
    const body = await lawnMix({ month: '12' });
    expect(itemOf(body, DEC_FROM).jobMix.ratePer1000).toBeCloseTo(4.5, 3);
    expect(itemOf(body, DEC_K_PRODUCT)).toBeUndefined();
    expect(mockLoadActive).not.toHaveBeenCalled();
  });

  test.each(['10', '11', '1'])('month %s is not December', async (month) => {
    const body = await lawnMix({ month, scheduledServiceId: VISIT });
    expect(JSON.stringify(body)).not.toContain('activeLargePatchPotassium');
    expect(JSON.stringify(body)).not.toContain(DEC_K_PRODUCT);
    expect(mockLoadActive).not.toHaveBeenCalled();
  });

  test('the GATE_LAWN_V13 program is off: no swap', async () => {
    delete process.env.GATE_LAWN_V13;
    const body = await sheet();
    expect(JSON.stringify(body)).not.toContain('activeLargePatchPotassium');
    expect(mockLoadActive).not.toHaveBeenCalled();
  });
});

describe('the swap follows the protocol the PLANNER resolves for the visit', () => {
  const pin = (version, windowMonth = 12) => { pinnedWindowMonth = windowMonth; return { lawn_protocol_key: 'fixture_v13', lawn_protocol_version: version, lawn_protocol_window_key: 'dec_v13_spreader_feeding' }; };
  let pinnedWindowMonth;
  beforeEach(() => {
    pinnedWindowMonth = 12;
    operatingLayer.getProtocolWindowContext.mockImplementation(async (knex, args) => (args.protocolKey
      ? { protocol: { version: args.protocolVersion }, windowMonth: pinnedWindowMonth }
      : { protocol: { version: LAWN_V13_VERSION } }));
    operatingLayer.summarizeProtocolContext.mockImplementation((context) => {
      if (!context?.protocol) return null;
      const window = context.windowMonth ? { month: context.windowMonth } : undefined;
      return context.protocol.version === LAWN_V13_VERSION ? { ...V13_SUMMARY, window } : { version: context.protocol.version, products: [], window };
    });
  });

  test('pinned to an older version: no swap and no area read', async () => {
    Object.assign(visit, pin('2026.05'));
    const body = await sheet();
    expect(JSON.stringify(body)).not.toContain('activeLargePatchPotassium');
    expect(mockLoadActive).not.toHaveBeenCalled();
  });

  test('pinned to v13 and the December window: the swap applies', async () => {
    Object.assign(visit, pin(LAWN_V13_VERSION, 12));
    expect(itemOf(await sheet(), DEC_K_PRODUCT)).toBeTruthy();
  });

  test('pinned to the November window, December asked (completion defaults on): no swap, no area read', async () => {
    process.env.GATE_LAWN_COMPLETION_DEFAULTS = 'true';
    process.env.GATE_LAWN_PROPERTY_HISTORY = 'true';
    Object.assign(visit, pin(LAWN_V13_VERSION, 11));
    const body = await sheet({ month: '12' });
    expect(JSON.stringify(body)).not.toContain('activeLargePatchPotassium');
    expect(mockLoadActive).not.toHaveBeenCalled();
  });
});
