// GATE_LAWN_NOV_LARGE_PATCH_N (owner 2026-10-09) on the lawn tank sheet (GET /api/admin/protocols/lawn-mix): a v13 November visit
// at a lawn with an ACTIVE mapped fungus area sizes the 24-0-11 bag for 0.5 lb N (2.083 lb per 1,000, noted as 2.1) instead of the
// visit's 0.75 lb N (3.125); the yearly-limit read sees the same reduced rate. Real handler and plan engine; synthetic fixtures.
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

const F24 = 'LESCO 24-0-11 with PolyPlus OPTI';
const CATALOG = [
  { id: 'f24', name: F24, aliases: [], analysis_n: 24, analysis_k: 11, default_rate_per_1000: 4.2, rate_unit: 'lb', cost_per_unit: 1, cost_unit: 'lb' },
];
const V13_SUMMARY = { version: LAWN_V13_VERSION, products: [{ productId: 'f24', ratePer1000: null, rateUnit: 'lb_n', gates: {} }] };
const PROPERTY = '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const VISIT = '3f2c1d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const NOTE = 'Active fungus mapped: nitrogen reduced to 0.5 lb N (2.1 lb per 1,000). Close the spreader over the patch and 6 ft around it.';
const GATES = ['GATE_LAWN_V13', 'GATE_LAWN_SPOT_RULES', 'GATE_LAWN_TREATMENT_GUIDE', 'GATE_LAWN_TROUBLE_AREAS', 'GATE_LAWN_NOV_LARGE_PATCH_N'];

const handler = adminProtocolsRouter.stack.find((layer) => layer.route?.path === '/lawn-mix' && layer.route.methods.get).route.stack[0].handle;

function readQuery(rows) {
  const query = {};
  for (const method of ['where', 'orWhereNull', 'whereIn', 'join', 'select', 'orderByRaw', 'orderBy']) query[method] = jest.fn(() => query);
  query.first = jest.fn(async () => rows[0] || null);
  query.catch = (onRejected) => Promise.resolve(rows).catch(onRejected);
  return query;
}

async function lawnMix(query) {
  const res = { json: jest.fn(), status: jest.fn() };
  res.status.mockReturnValue(res);
  const next = jest.fn();
  await handler({ query: { track: 'bermuda', lawnSqft: '10000', ...query } }, res, next);
  expect(next).not.toHaveBeenCalled();
  return JSON.parse(JSON.stringify(res.json.mock.calls[0][0]));
}

const sheet = (extra = {}) => lawnMix({ month: '11', scheduledServiceId: VISIT, ...extra });
const bag = (body) => body.items.find((item) => item.product?.name === F24);
// The rate the limit reader was asked to judge for the bag.
const limitRate = () => mockCheckLimits.mock.calls.find((call) => call[1] === 'f24')?.[4]?.proposed?.ratePer1000;
let visit;

beforeEach(() => {
  jest.clearAllMocks();
  visit = { id: VISIT, customer_id: 'cust-1', property_id: PROPERTY, scheduled_date: '2026-11-10', service_id: null, service_type: 'Lawn Care', recurring_pattern: null, recurring_interval_days: null };
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

describe('active fungus mapped, gate on', () => {
  test('November 24-0-11 is sized for 0.5 lb N: 2.083 lb per 1,000, 20.83 lb on 10,000 sq ft, with the technician note', async () => {
    const body = await sheet();
    expect(bag(body).jobMix).toMatchObject({ rateSource: 'target_n_analysis', targetNPer1000: 0.5, amountUnit: 'lb' });
    expect(bag(body).jobMix.ratePer1000).toBeCloseTo(2.0833, 3);
    expect(bag(body).jobMix.amount).toBeCloseTo(20.833, 2);
    expect(bag(body).gateNotes).toContainEqual({ key: 'activeFungusNitrogen', severity: 'note', text: NOTE });
    expect(mockLoadActive).toHaveBeenCalledWith(db, PROPERTY);
  });

  test('the yearly-limit read judges the same reduced rate the sheet quotes', async () => {
    await sheet();
    expect(limitRate()).toBeCloseTo(2.0833, 3);
  });

  test('the planned mix of the line carries the reduced rate too', async () => {
    const body = await sheet();
    expect(bag(body).plannedMix.ratePer1000).toBeCloseTo(2.0833, 3);
  });
});

describe('the text staff read agrees with the cut (codex #6256 r1 P1)', () => {
  const STALE = 'LESCO 24-0-11 with PolyPlus OPTI \u2014 3.1 lb per 1,000 sq ft (0.75 lb N), spreader';

  test('cut: the line, the visit primary and the objective all state 0.5 lb N / 2.1 lb, none still says 3.1 lb or "N rate: 0.75"', async () => {
    const body = await sheet();
    const stated = 'LESCO 24-0-11 with PolyPlus OPTI \u2014 2.1 lb per 1,000 sq ft (0.5 lb N), spreader, active fungus mapped';
    expect(bag(body).raw).toBe(stated);
    expect(body.visit.primary).toBe(stated);
    expect(body.visit.objective).toMatch(/^N rate: 0\.5 lb N \(active fungus mapped; normal 0\.75 lb N\)\. Spreader visit\./);
    const text = JSON.stringify([body.items, body.selectedItems, body.visit]);
    expect(text).not.toContain('3.1 lb per 1,000');
    expect(text).not.toContain('N rate: 0.75 lb N.');
    // The product is still the same matched catalog row and still selected.
    expect(bag(body).product.name).toBe(F24);
    expect(body.selectedItems.map((item) => item.product.name)).toEqual([F24]);
  });

  test('not cut: the recipe text is the stale-free original, byte for byte', async () => {
    mockLoadActive.mockResolvedValue([]);
    const body = await sheet();
    expect(bag(body).raw).toBe(STALE);
    expect(body.visit.primary).toBe(STALE);
    expect(body.visit.objective).toMatch(/^N rate: 0\.75 lb N\. Spreader visit\./);
    delete process.env.GATE_LAWN_NOV_LARGE_PATCH_N;
    mockLoadActive.mockResolvedValue([{ type: 'fungus' }]);
    expect((await sheet()).visit.primary).toBe(STALE);
  });
});

describe('the cut follows the protocol the PLANNER resolves for the visit (codex #6256 r2 P1)', () => {
  const STALE = 'LESCO 24-0-11 with PolyPlus OPTI \u2014 3.1 lb per 1,000 sq ft (0.75 lb N), spreader';
  const pin = (version, windowMonth = 11) => { pinnedWindowMonth = windowMonth; return { lawn_protocol_key: 'fixture_v13', lawn_protocol_version: version, lawn_protocol_window_key: 'nov_v13_spreader_feeding' }; };
  // The same lookup the planner makes: a pin (protocolKey) resolves to the pinned version and the month of the window it is pinned
  // to (the visit's fixtureWindowMonth); no pin is the current v13 protocol.
  let pinnedWindowMonth;
  beforeEach(() => {
    pinnedWindowMonth = 11;
    operatingLayer.getProtocolWindowContext.mockImplementation(async (knex, args) => (args.protocolKey
      ? (args.protocolVersion === 'gone' ? null : { protocol: { version: args.protocolVersion }, windowMonth: pinnedWindowMonth })
      : { protocol: { version: LAWN_V13_VERSION } }));
    operatingLayer.summarizeProtocolContext.mockImplementation((context) => {
      if (!context?.protocol) return null;
      const window = context.windowMonth ? { month: context.windowMonth } : undefined;
      return context.protocol.version === LAWN_V13_VERSION ? { ...V13_SUMMARY, window } : { version: context.protocol.version, products: [], window };
    });
  });
  const pinnedCalls = () => operatingLayer.getProtocolWindowContext.mock.calls.filter((call) => call[1].protocolKey);

  test('pinned to an older version: no cut, the recipe text is untouched, and no area is read', async () => {
    Object.assign(visit, pin('2026.05'));
    const body = await sheet();
    expect(bag(body).jobMix.ratePer1000).toBeCloseTo(3.125, 3);
    expect(bag(body).raw).toBe(STALE);
    expect(body.visit.primary).toBe(STALE);
    expect(JSON.stringify(body)).not.toContain('activeFungusNitrogen');
    expect(limitRate()).toBeCloseTo(3.125, 3);
    expect(mockLoadActive).not.toHaveBeenCalled();
    expect(pinnedCalls()[0][1]).toMatchObject({ protocolKey: 'fixture_v13', protocolVersion: '2026.05', windowKey: 'nov_v13_spreader_feeding', planning: true });
  });

  test('a pin that cannot be resolved is not v13 either', async () => {
    Object.assign(visit, pin('gone'));
    expect(bag(await sheet()).jobMix.ratePer1000).toBeCloseTo(3.125, 3);
  });

  test('a protocol lookup that fails is not v13 (the normal target stands)', async () => {
    Object.assign(visit, pin(LAWN_V13_VERSION));
    operatingLayer.getProtocolWindowContext.mockImplementation(async (knex, args) => {
      if (args.protocolKey) throw new Error('db down');
      return { protocol: { version: LAWN_V13_VERSION } };
    });
    expect(bag(await sheet()).jobMix.ratePer1000).toBeCloseTo(3.125, 3);
  });

  test('the gate is off (or the trouble-areas gate is): a pinned visit makes NO protocol lookup of its own, and the sheet is unchanged', async () => {
    Object.assign(visit, pin(LAWN_V13_VERSION));
    for (const name of ['GATE_LAWN_NOV_LARGE_PATCH_N', 'GATE_LAWN_TROUBLE_AREAS']) {
      process.env.GATE_LAWN_NOV_LARGE_PATCH_N = 'true';
      process.env.GATE_LAWN_TROUBLE_AREAS = 'true';
      delete process.env[name];
      operatingLayer.getProtocolWindowContext.mockClear();
      const body = await sheet();
      expect(pinnedCalls()).toHaveLength(0);
      expect(bag(body).raw).toBe(STALE);
      expect(bag(body).jobMix.ratePer1000).toBeCloseTo(3.125, 3);
    }
    expect(mockLoadActive).not.toHaveBeenCalled();
  });

  test('pinned to v13: the cut applies', async () => {
    Object.assign(visit, pin(LAWN_V13_VERSION));
    const body = await sheet();
    expect(bag(body).jobMix.ratePer1000).toBeCloseTo(2.0833, 3);
    expect(bag(body).raw).toMatch(/2\.1 lb per 1,000 sq ft \(0\.5 lb N\), spreader, active fungus mapped$/);
    expect(pinnedCalls()).toHaveLength(1);
  });

  // The sheet shows the recipe of the REQUESTED month, the plan the month of the window the visit is pinned to: the cut applies
  // only when those are the same month (codex #6256 r4 P1).
  test('pinned to the November window, November asked: the cut applies', async () => {
    Object.assign(visit, pin(LAWN_V13_VERSION, 11));
    expect(bag(await sheet({ month: '11' })).jobMix.ratePer1000).toBeCloseTo(2.0833, 3);
  });

  test('pinned to the October window, November asked (completion defaults on): no cut, the recipe text is untouched, no area is read', async () => {
    process.env.GATE_LAWN_COMPLETION_DEFAULTS = 'true';
    process.env.GATE_LAWN_PROPERTY_HISTORY = 'true';
    Object.assign(visit, pin(LAWN_V13_VERSION, 10));
    const body = await sheet({ month: '11' });
    expect(bag(body).jobMix.ratePer1000).toBeCloseTo(3.125, 3);
    expect(bag(body).raw).toBe(STALE);
    expect(body.visit.primary).toBe(STALE);
    expect(JSON.stringify(body)).not.toContain('activeFungusNitrogen');
    expect(limitRate()).toBeCloseTo(3.125, 3);
    expect(mockLoadActive).not.toHaveBeenCalled();
  });

  test('pinned to the November window, October asked: no cut', async () => {
    process.env.GATE_LAWN_COMPLETION_DEFAULTS = 'true';
    process.env.GATE_LAWN_PROPERTY_HISTORY = 'true';
    Object.assign(visit, pin(LAWN_V13_VERSION, 11));
    const body = await sheet({ month: '10' });
    expect(JSON.stringify(body)).not.toContain('activeFungusNitrogen');
    expect(mockLoadActive).not.toHaveBeenCalled();
  });

  test('completion defaults off: the plan reads the month of the service date, so that is the month the cut follows', async () => {
    Object.assign(visit, pin(LAWN_V13_VERSION, 10)); // pinned to the October window; the visit is on 2026-11-10
    expect(bag(await sheet({ month: '11' })).jobMix.ratePer1000).toBeCloseTo(2.0833, 3);
    expect(JSON.stringify(await sheet({ month: '10' }))).not.toContain('activeFungusNitrogen');
  });

  test('pinned to v13 but the window month is unknown: not cut (fails closed)', async () => {
    Object.assign(visit, pin(LAWN_V13_VERSION, null));
    expect(bag(await sheet({ month: '11' })).jobMix.ratePer1000).toBeCloseTo(3.125, 3);
  });

  test('unpinned with v13 current: the cut applies, and no pinned lookup is made', async () => {
    const body = await sheet();
    expect(bag(body).jobMix.ratePer1000).toBeCloseTo(2.0833, 3);
    expect(pinnedCalls()).toHaveLength(0);
  });
});

describe('everything else keeps the visit\'s own 0.75 lb N (3.125 lb per 1,000), with no note', () => {
  const expectNormal = async (query = {}) => {
    const body = await sheet(query);
    expect(bag(body).jobMix.ratePer1000).toBeCloseTo(3.125, 3);
    expect(bag(body).jobMix.targetNPer1000).toBe(0.75);
    expect(JSON.stringify(bag(body).gateNotes)).not.toContain('activeFungusNitrogen');
    expect(limitRate()).toBeCloseTo(3.125, 3);
  };

  test('the gate is off', async () => {
    delete process.env.GATE_LAWN_NOV_LARGE_PATCH_N;
    await expectNormal();
    expect(mockLoadActive).not.toHaveBeenCalled();
  });

  test.each(['TRUE', '1', 'yes', ''])('the gate is %j (not exactly "true")', async (value) => {
    process.env.GATE_LAWN_NOV_LARGE_PATCH_N = value;
    await expectNormal();
  });

  test('the trouble-areas gate is off', async () => {
    delete process.env.GATE_LAWN_TROUBLE_AREAS;
    await expectNormal();
    expect(mockLoadActive).not.toHaveBeenCalled();
  });

  test('no active areas, or take-all and other types only', async () => {
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
    const body = await lawnMix({ month: '11' });
    expect(bag(body).jobMix.ratePer1000).toBeCloseTo(3.125, 3);
    expect(mockLoadActive).not.toHaveBeenCalled();
  });

  test.each(['10', '12', '4'])('month %s is not November', async (month) => {
    const body = await lawnMix({ month, scheduledServiceId: VISIT });
    expect(JSON.stringify(body)).not.toContain('activeFungusNitrogen');
    expect(mockLoadActive).not.toHaveBeenCalled();
  });

  test('the GATE_LAWN_V13 program is off: no reduction', async () => {
    delete process.env.GATE_LAWN_V13;
    const body = await sheet();
    expect(JSON.stringify(body)).not.toContain('activeFungusNitrogen');
    expect(mockLoadActive).not.toHaveBeenCalled();
  });
});
