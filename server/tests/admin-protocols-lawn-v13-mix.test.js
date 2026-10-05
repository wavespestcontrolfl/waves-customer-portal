// Lawn tank sheet (GET /api/admin/protocols/lawn-mix) with GATE_LAWN_V13 on:
// the sheet uses the staged v13 protocol row's stated rate, not the catalog
// default, and derives a lb_n row from the visit's N target. Real handler and
// plan engine; stored protocol context, catalog and calibration are fixtures.
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

const db = require('../models/db');
const operatingLayer = require('../services/lawn-protocol-operating-layer');
const adminProtocolsRouter = require('../routes/admin-protocols');
const { LAWN_V13_VERSION } = require('../services/lawn-program');

const NUTRA = 'LESCO Nutra-TECH T&O Micronutrient Package';
const STONEWALL = 'LESCO Stonewall 4FL Prodiamine 40.7% Pre-Emergent Liquid Herbicide';
const F24 = 'LESCO 24-0-11 with PolyPlus OPTI';
const CATALOG = [
  { id: 'nt', name: NUTRA, aliases: [], default_rate_per_1000: 12, rate_unit: 'fl oz', cost_per_unit: 1, cost_unit: 'fl oz' },
  { id: 'stw', name: STONEWALL, aliases: [], default_rate_per_1000: null, rate_unit: 'fl oz', cost_per_unit: 1, cost_unit: 'fl oz' },
  { id: 'f24', name: F24, aliases: [], analysis_n: 24, analysis_k: 11, default_rate_per_1000: 4.2, rate_unit: 'lb', cost_per_unit: 1, cost_unit: 'lb' },
];
const V13_SUMMARY = {
  version: LAWN_V13_VERSION,
  products: [
    { productId: 'nt', ratePer1000: 6, rateUnit: 'fl oz', gates: {} },
    { productId: 'stw', ratePer1000: 0.5, rateUnit: 'fl oz', gates: {} },
    { productId: 'f24', ratePer1000: null, rateUnit: 'lb_n', gates: {} },
  ],
};

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
  expect(res.json).toHaveBeenCalledTimes(1);
  return JSON.parse(JSON.stringify(res.json.mock.calls[0][0]));
}

const itemFor = (body, name) => body.items.find((item) => item.product?.name === name);

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GATE_LAWN_V13 = 'true';
  operatingLayer.getProtocolWindowContext.mockResolvedValue({ protocol: { version: LAWN_V13_VERSION } });
  operatingLayer.summarizeProtocolContext.mockReturnValue(V13_SUMMARY);
  db.mockImplementation((table) => {
    if (table === 'equipment_calibrations as ec') {
      return readQuery([{ id: 'cal', equipment_system_id: 'tank', system_name: 'Tank', system_type: 'tank', carrier_gal_per_1000: 1, tank_capacity_gal: 110, expires_at: '2099-01-01T00:00:00Z' }]);
    }
    if (table === 'products_catalog') return readQuery(CATALOG);
    if (table === 'product_aliases') return readQuery([]);
    throw new Error(`Unexpected table: ${table}`);
  });
});

afterEach(() => { delete process.env.GATE_LAWN_V13; });

test('January tank sheet: Nutra-TECH is the v13 6 fl oz per 1,000, not the catalog 12; Stonewall 4FL gets its stated rate', async () => {
  const body = await lawnMix({ month: '1' });
  expect(operatingLayer.getProtocolWindowContext).toHaveBeenCalledWith(db, expect.objectContaining({ grassTrack: 'bermuda' }));
  const nutra = itemFor(body, NUTRA);
  expect(nutra.jobMix).toMatchObject({ ratePer1000: 6, rateSource: 'protocol_rate', amount: 60, amountUnit: 'fl oz' });
  const stonewall = itemFor(body, STONEWALL);
  expect(stonewall.jobMix).toMatchObject({ ratePer1000: 0.5, rateSource: 'protocol_rate', amount: 5 });
});

test('a lb_n month derives from the N target: April 24-0-11 is 2.083 lb per 1,000, not the 4.2 lb catalog default', async () => {
  const body = await lawnMix({ month: '4' });
  expect(itemFor(body, F24).jobMix).toMatchObject({ rateSource: 'target_n_analysis', amountUnit: 'lb' });
  expect(itemFor(body, F24).jobMix.ratePer1000).toBeCloseTo(2.0833, 3);
});

test('gate off: no structured read, the catalog rate answers for the old program', async () => {
  delete process.env.GATE_LAWN_V13;
  await lawnMix({ month: '1', track: 'st_augustine' });
  expect(operatingLayer.getProtocolWindowContext).not.toHaveBeenCalled();
});

test('gate on with no staged v13 protocol: 409, never a sheet priced at catalog defaults', async () => {
  operatingLayer.getProtocolWindowContext.mockResolvedValue({ protocol: { version: '2026.06' } });
  operatingLayer.summarizeProtocolContext.mockReturnValue({ version: '2026.06', products: [] });
  const res = { json: jest.fn(), status: jest.fn() };
  res.status.mockReturnValue(res);
  const next = jest.fn();
  await handler({ query: { track: 'bermuda', lawnSqft: '10000', month: '1' } }, res, next);
  expect(next).not.toHaveBeenCalled();
  expect(res.status).toHaveBeenCalledWith(409);
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'lawn_v13_protocol_missing' }));
});
