// GATE_LAWN_RECLAIMED_HALF_N on the lawn tank sheet (GET /api/admin/protocols/lawn-mix), next to GATE_LAWN_NOV_LARGE_PATCH_N (Codex r1 on #6511):
// each nitrogen gate activates its OWN adjustment, decided with the planner's own v13 eligibility, so the sheet never shows the full N while the
// planner and Fast Complete halve it. Real handler and plan engine; synthetic fixtures; the property read is the only stub.
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
const water = require('../services/lawn-reclaimed-water');
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
const FUNGUS_NOTE = 'Active fungus mapped: nitrogen reduced to 0.5 lb N (2.1 lb per 1,000). Close the spreader over the patch and 6 ft around it.';
const HALF_NOTE = 'Reclaimed water: half nitrogen today (0.375 lb N, 1.6 lb per 1,000).';
const GATES = ['GATE_LAWN_V13', 'GATE_LAWN_SPOT_RULES', 'GATE_LAWN_TREATMENT_GUIDE', 'GATE_LAWN_TROUBLE_AREAS', 'GATE_LAWN_NOV_LARGE_PATCH_N', 'GATE_LAWN_RECLAIMED_HALF_N'];

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

let reclaimed;
beforeEach(() => { reclaimed = jest.spyOn(water, 'isReclaimedService').mockImplementation(async (_knex, svc) => !!svc); });
afterEach(() => { reclaimed.mockRestore(); });

// The nitrogen gates are set exactly as listed; the program gates large patch needs (v13, spot rules, treatment guide) stay on.
const PROGRAM = ['GATE_LAWN_V13', 'GATE_LAWN_SPOT_RULES', 'GATE_LAWN_TREATMENT_GUIDE'];
const only = (...on) => { for (const name of GATES) { if (PROGRAM.includes(name) || on.includes(name)) process.env[name] = 'true'; else delete process.env[name]; } };
const rate = async () => bag(await sheet()).jobMix.ratePer1000;

describe('each nitrogen gate alone activates its own adjustment on the tank sheet', () => {
  test('reclaimed gate alone (large patch and trouble areas OFF): half nitrogen, 1.5625 lb per 1,000, with the note, and the limit read agrees', async () => {
    only('GATE_LAWN_RECLAIMED_HALF_N');
    const body = await sheet();
    expect(bag(body).jobMix).toMatchObject({ rateSource: 'target_n_analysis', targetNPer1000: 0.375 });
    expect(bag(body).jobMix.ratePer1000).toBeCloseTo(1.5625, 4);
    expect(bag(body).gateNotes).toContainEqual({ key: 'reclaimedNitrogen', severity: 'note', text: HALF_NOTE });
    expect(bag(body).raw).toBe('LESCO 24-0-11 with PolyPlus OPTI \u2014 1.6 lb per 1,000 sq ft (0.375 lb N), spreader, reclaimed water, half');
    expect(limitRate()).toBeCloseTo(1.5625, 4);
    expect(mockLoadActive).not.toHaveBeenCalled();
  });

  test('large patch gate alone (reclaimed OFF): 0.5 lb N with the fungus note, no property read', async () => {
    only('GATE_LAWN_TROUBLE_AREAS', 'GATE_LAWN_NOV_LARGE_PATCH_N');
    const body = await sheet();
    expect(bag(body).jobMix.ratePer1000).toBeCloseTo(2.0833, 3);
    expect(bag(body).gateNotes).toContainEqual({ key: 'activeFungusNitrogen', severity: 'note', text: FUNGUS_NOTE });
    expect(reclaimed).not.toHaveBeenCalled();
  });

  test('both on, a reclaimed lawn with fungus: the smaller target (0.375), only the reclaimed note', async () => {
    only('GATE_LAWN_TROUBLE_AREAS', 'GATE_LAWN_NOV_LARGE_PATCH_N', 'GATE_LAWN_RECLAIMED_HALF_N');
    const body = await sheet();
    expect(bag(body).jobMix.ratePer1000).toBeCloseTo(1.5625, 4);
    // Both notes: the half-nitrogen note and the fungus spreader instruction (without the fungus rule's own, larger, figures).
    expect(bag(body).gateNotes).toEqual(expect.arrayContaining([
      { key: 'reclaimedNitrogen', severity: 'note', text: HALF_NOTE },
      { key: 'activeFungusNitrogen', severity: 'note', text: 'Active fungus mapped. Close the spreader over the patch and 6 ft around it.' },
    ]));
    expect(JSON.stringify(bag(body).gateNotes)).not.toContain('reduced to 0.5');
    expect(bag(body).raw).toContain('reclaimed water, half; active fungus mapped');
  });

  test('both on but the lawn is not reclaimed: the fungus cut alone; large patch without trouble areas + reclaimed on: the half alone', async () => {
    only('GATE_LAWN_TROUBLE_AREAS', 'GATE_LAWN_NOV_LARGE_PATCH_N', 'GATE_LAWN_RECLAIMED_HALF_N');
    reclaimed.mockResolvedValue(false);
    expect(await rate()).toBeCloseTo(2.0833, 3);
    reclaimed.mockResolvedValue(true);
    only('GATE_LAWN_NOV_LARGE_PATCH_N', 'GATE_LAWN_RECLAIMED_HALF_N'); // large patch needs trouble areas: it is off by itself, the half is not
    expect(await rate()).toBeCloseTo(1.5625, 4);
  });

  test('neither gate: the visit\'s 0.75 lb N, the old sheet, and neither the property nor an area is read', async () => {
    only();
    const body = await sheet();
    expect(bag(body).jobMix.ratePer1000).toBeCloseTo(3.125, 3);
    expect(bag(body).raw).toBe('LESCO 24-0-11 with PolyPlus OPTI \u2014 3.1 lb per 1,000 sq ft (0.75 lb N), spreader');
    expect(JSON.stringify(body)).not.toMatch(/reclaimedNitrogen|activeFungusNitrogen/);
    expect(reclaimed).not.toHaveBeenCalled();
    expect(mockLoadActive).not.toHaveBeenCalled();
  });

  test('a lawn that is not reclaimed, an unresolved property, and a failed read keep the normal target', async () => {
    only('GATE_LAWN_RECLAIMED_HALF_N');
    reclaimed.mockResolvedValue(false);
    expect(await rate()).toBeCloseTo(3.125, 3);
    reclaimed.mockRejectedValue(new Error('strict only')); // a lenient reader never rejects: the real one logs the code and answers false
    reclaimed.mockResolvedValue(false);
    expect(await rate()).toBeCloseTo(3.125, 3);
  });
});

describe('v13 eligibility is the planner\'s, for the reclaimed rule too', () => {
  const pin = (version) => ({ lawn_protocol_key: 'fixture_v13', lawn_protocol_version: version, lawn_protocol_window_key: 'nov_v13_spreader_feeding' });
  beforeEach(() => {
    only('GATE_LAWN_RECLAIMED_HALF_N');
    operatingLayer.getProtocolWindowContext.mockImplementation(async (knex, args) => (args.protocolKey
      ? { protocol: { version: args.protocolVersion }, windowMonth: 11 } : { protocol: { version: LAWN_V13_VERSION } }));
    operatingLayer.summarizeProtocolContext.mockImplementation((context) => (context?.protocol
      ? (context.protocol.version === LAWN_V13_VERSION ? { ...V13_SUMMARY, window: { month: context.windowMonth } } : { version: context.protocol.version, products: [], window: { month: context.windowMonth } })
      : null));
  });

  test('pinned to an older version: no halving, no property read', async () => {
    Object.assign(visit, pin('2026.05'));
    expect(await rate()).toBeCloseTo(3.125, 3);
    expect(reclaimed).not.toHaveBeenCalled();
  });

  test('pinned to v13: halved', async () => {
    Object.assign(visit, pin(LAWN_V13_VERSION));
    expect(await rate()).toBeCloseTo(1.5625, 4);
  });

  test('GATE_LAWN_V13 off: no halving', async () => {
    delete process.env.GATE_LAWN_V13;
    const body = await sheet();
    expect(JSON.stringify(body)).not.toContain('reclaimedNitrogen');
    expect(reclaimed).not.toHaveBeenCalled();
  });

  test('no visit (the reference tab): the normal target', async () => {
    expect(bag(await lawnMix({ month: '11' })).jobMix.ratePer1000).toBeCloseTo(3.125, 3);
  });
});
