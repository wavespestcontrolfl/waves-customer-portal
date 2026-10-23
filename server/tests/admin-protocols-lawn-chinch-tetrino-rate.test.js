// GATE_LAWN_CHINCH_TETRINO_RATE (owner 2026-10-22) on the lawn tank sheet (GET /api/admin/protocols/lawn-mix): a v13 May visit at a
// lawn with a chinch area mapped (active, or resolved within 365 days) sizes Tetrino for 0.735 fl oz per 1,000 sq ft instead of 0.367;
// the yearly-limit read judges the same rate; the gate off leaves the whole payload byte-identical. Real handler and plan engine;
// synthetic fixtures.
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
const mockHasArea = jest.fn();
const mockPropertyOf = jest.fn();
jest.mock('../services/lawn-trouble-areas', () => ({
  propertyOf: (...args) => mockPropertyOf(...args),
  loadActive: jest.fn(async () => []),
  hasAreaOfType: (...args) => mockHasArea(...args),
}));

const db = require('../models/db');
const operatingLayer = require('../services/lawn-protocol-operating-layer');
const adminProtocolsRouter = require('../routes/admin-protocols');
const { LAWN_V13_VERSION } = require('../services/lawn-program');

const TET = 'Tetrino Insecticide';
const CATALOG = [
  { id: 'tet', name: TET, aliases: [], default_rate_per_1000: 0.367, rate_unit: 'fl oz', cost_per_unit: 1, cost_unit: 'fl oz' },
];
const V13_SUMMARY = {
  version: LAWN_V13_VERSION,
  products: [{
    productId: 'tet', productName: TET, protocolProductName: TET, ratePer1000: 0.367, rateUnit: 'fl oz', applicationMode: 'broadcast',
    gates: { sunnyTurfOnly: true, minDistanceFromWaterFt: 25, applyAlone: true },
  }],
};
const PROPERTY = '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const VISIT = '3f2c1d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const NOTE = "Chinch bugs mapped here: Tetrino at the label's high rate, 0.735 fl oz per 1,000 sq ft.";
const GATES = ['GATE_LAWN_V13', 'GATE_LAWN_SPOT_RULES', 'GATE_LAWN_TREATMENT_GUIDE', 'GATE_LAWN_TROUBLE_AREAS', 'GATE_LAWN_CHINCH_TETRINO_RATE'];

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
  await handler({ query: { track: 'st_augustine', lawnSqft: '10000', ...query } }, res, next);
  expect(next).not.toHaveBeenCalled();
  return JSON.parse(JSON.stringify(res.json.mock.calls[0][0]));
}

const sheet = (extra = {}) => lawnMix({ month: '5', scheduledServiceId: VISIT, ...extra });
const tetrino = (body) => body.items.find((item) => item.product?.name === TET);
const limitRate = () => mockCheckLimits.mock.calls.find((call) => call[1] === 'tet')?.[4]?.proposed?.ratePer1000;
let visit;

beforeEach(() => {
  jest.clearAllMocks();
  visit = { id: VISIT, customer_id: 'cust-1', property_id: PROPERTY, scheduled_date: '2027-05-10', service_id: null, service_type: 'Lawn Care', recurring_pattern: null, recurring_interval_days: null };
  mockCheckLimits.mockReset().mockResolvedValue({ allowed: true, blocks: [], warnings: [] });
  mockPropertyOf.mockReset().mockImplementation(async (knex, svc) => svc?.property_id || null);
  mockHasArea.mockReset().mockResolvedValue(true);
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

describe('chinch mapped, gate on', () => {
  test('May Tetrino is sized at 0.735 fl oz per 1,000 sq ft on the sunny half, with the technician note', async () => {
    const body = await sheet();
    // The sheet has no turf profile, so sunny-turf-only takes half of 10,000 sq ft: 5 treated thousands.
    expect(tetrino(body).jobMix).toMatchObject({ rateSource: 'protocol_rate', ratePer1000: 0.735, rateUnit: 'fl oz', amountUnit: 'fl oz' });
    expect(tetrino(body).jobMix.amount).toBeCloseTo(3.675, 3);
    expect(tetrino(body).plannedMix.ratePer1000).toBe(0.735);
    expect(tetrino(body).gateNotes).toContainEqual({ key: 'chinchTetrinoRate', severity: 'note', text: NOTE });
    expect(mockHasArea).toHaveBeenCalledWith(db, PROPERTY, 'chinch', { withinDays: 365 });
  });

  test('the yearly-limit read judges the same raised rate the sheet quotes', async () => {
    await sheet();
    expect(limitRate()).toBe(0.735);
  });

  test('the text staff read agrees: the line and the visit primary state 0.735, none still says 0.367', async () => {
    const body = await sheet();
    expect(tetrino(body).raw).toMatch(/^Tetrino Insecticide — 0\.735 fl oz per 1,000 sq ft, sunny turf only.*, chinch bugs mapped$/);
    expect(body.visit.primary).toMatch(/^Tetrino Insecticide — 0\.735 fl oz per 1,000 sq ft/);
    expect(JSON.stringify([body.items, body.visit])).not.toContain('0.367 fl oz per 1,000');
  });
});

describe('no raise', () => {
  const normal = async () => {
    const body = await sheet();
    expect(tetrino(body).jobMix.ratePer1000).toBe(0.367);
    expect(limitRate()).toBe(0.367);
    expect(tetrino(body).gateNotes.map((note) => note.key)).not.toContain('chinchTetrinoRate');
    return body;
  };

  test('no chinch area mapped keeps 0.367', async () => {
    mockHasArea.mockResolvedValue(false);
    await normal();
  });

  test('another month at a chinch lawn keeps its recipe and reads no area', async () => {
    const body = await lawnMix({ month: '6', scheduledServiceId: VISIT });
    expect(body.items.find((item) => item.product?.name === TET)?.jobMix?.ratePer1000 ?? 0.367).toBe(0.367);
    expect(mockHasArea).not.toHaveBeenCalled();
  });

  test('a failed area read keeps 0.367', async () => {
    mockHasArea.mockRejectedValue(Object.assign(new Error('boom'), { code: '57014' }));
    await normal();
  });

  test('the reference sheet (no visit) keeps 0.367 and reads no area', async () => {
    const body = await lawnMix({ month: '5' });
    expect(tetrino(body).jobMix.ratePer1000).toBe(0.367);
    expect(mockHasArea).not.toHaveBeenCalled();
  });
});

describe('gate off is byte-identical', () => {
  test.each(GATES.slice(3))('with %s unset the whole payload equals the payload of a lawn with no chinch area, and no area is read', async (name) => {
    mockHasArea.mockResolvedValue(false);
    const baseline = await sheet();
    mockHasArea.mockReset().mockResolvedValue(true);
    delete process.env[name];
    const off = await sheet();
    expect(off).toEqual(baseline);
    expect(JSON.stringify(off)).toBe(JSON.stringify(baseline));
    expect(mockHasArea).not.toHaveBeenCalled();
  });

  test('a variable that is not exactly true is off', async () => {
    mockHasArea.mockResolvedValue(false);
    const baseline = await sheet();
    mockHasArea.mockReset().mockResolvedValue(true);
    process.env.GATE_LAWN_CHINCH_TETRINO_RATE = 'TRUE';
    expect(await sheet()).toEqual(baseline);
    expect(mockHasArea).not.toHaveBeenCalled();
  });
});
