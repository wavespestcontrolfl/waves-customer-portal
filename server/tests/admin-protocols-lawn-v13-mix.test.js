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
const TETRINO = 'Tetrino Insecticide';
const CATALOG = [
  { id: 'nt', name: NUTRA, aliases: [], default_rate_per_1000: 12, rate_unit: 'fl oz', cost_per_unit: 1, cost_unit: 'fl oz' },
  { id: 'stw', name: STONEWALL, aliases: [], default_rate_per_1000: null, rate_unit: 'fl oz', cost_per_unit: 1, cost_unit: 'fl oz' },
  { id: 'tet', name: TETRINO, aliases: [], default_rate_per_1000: 0.367, rate_unit: 'fl oz', cost_per_unit: 1, cost_unit: 'fl oz' },
  { id: 'are', name: 'Arena 50 WDG', aliases: [], default_rate_per_1000: 0.29, rate_unit: 'oz', cost_per_unit: 1, cost_unit: 'oz' },
  { id: 'cel', name: 'Celsius WG', aliases: [], default_rate_per_1000: 0.085, rate_unit: 'oz', cost_per_unit: 1, cost_unit: 'oz' },
  { id: 'nis', name: 'LESCO 90/10 Nonionic Surfactant', aliases: [], default_rate_per_1000: 0.25, rate_unit: 'fl oz', cost_per_unit: 1, cost_unit: 'fl oz' },
  { id: 'f24', name: F24, aliases: [], analysis_n: 24, analysis_k: 11, default_rate_per_1000: 4.2, rate_unit: 'lb', cost_per_unit: 1, cost_unit: 'lb' },
];
const V13_SUMMARY = {
  version: LAWN_V13_VERSION,
  products: [
    { productId: 'nt', ratePer1000: 6, rateUnit: 'fl oz', gates: {} },
    { productId: 'stw', ratePer1000: 0.5, rateUnit: 'fl oz', gates: {} },
    { productId: 'f24', ratePer1000: null, rateUnit: 'lb_n', gates: {} },
    { productId: 'are', applicationMode: 'spot', ratePer1000: null, rateUnit: 'label_rate', gates: { trigger: 'chinch_20_to_25_per_sqft' } },
    { productId: 'cel', applicationMode: 'spot', ratePer1000: 0.085, rateUnit: 'oz', gates: { annualCounter: 'celsius_oz_per_1000' } },
    { productId: 'nis', applicationMode: 'spot', ratePer1000: null, rateUnit: 'label_rate', gates: { concentration: '0.25% v/v', tankMixWith: 'Celsius WG' } },
    { productId: 'tet', ratePer1000: 0.367, rateUnit: 'fl oz', gates: { sunnyTurfOnly: true, minDistanceFromWaterFt: 25, applyAlone: true } },
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

test('May Tetrino is sunny-turf-only: 10,000 sq ft with no turf profile is the half, 1.835 fl oz, not 3.67', async () => {
  const body = await lawnMix({ month: '5' });
  expect(itemFor(body, TETRINO).jobMix).toMatchObject({ ratePer1000: 0.367, rateSource: 'protocol_rate', amount: 1.835 });
  // A row without the flag is whole-lawn: January Nutra-TECH is still the full 60.
  expect(itemFor(await lawnMix({ month: '1' }), NUTRA).jobMix.amount).toBe(60);
});

test('May Tetrino alone: its gate notes ride the item, the water-distance warning shows, no block, a mixing order stands', async () => {
  const body = await lawnMix({ month: '5' });
  const item = itemFor(body, TETRINO);
  expect(item.gates).toEqual({ sunnyTurfOnly: true, minDistanceFromWaterFt: 25, applyAlone: true });
  expect(item.gateNotes.map((n) => `${n.severity}:${n.key}`)).toEqual(['required:minDistanceFromWaterFt', 'note:applyAlone', 'note:sunnyTurfOnly']);
  expect(body.warnings.find((w) => w.code === 'lawn_v13_product_gate')).toMatchObject({ gate: 'minDistanceFromWaterFt', message: 'Tetrino Insecticide: Keep 25 ft from ponds, lakes and canals; skip that strip.' });
  expect(body.blocks).toEqual([]);
  expect(body.mixingOrder).toHaveLength(1);
});

test('May Tetrino with Arena selected beside it: the plan engine\'s apply-alone rule, a block and no combined mixing order', async () => {
  const body = await lawnMix({ month: '5', selectedConditionalProductNames: 'Arena 50 WDG' });
  expect(body.selectedItems.map((i) => i.product.name).sort()).toEqual(['Arena 50 WDG', TETRINO]);
  expect(body.blocks).toHaveLength(1);
  expect(body.blocks[0]).toMatchObject({ code: 'lawn_v13_apply_alone', productName: TETRINO });
  expect(body.mixingOrder).toEqual([]);
});

test('gate off: no gate notes, no blocks, the mixing order is built as before', async () => {
  delete process.env.GATE_LAWN_V13;
  const body = await lawnMix({ month: '5', track: 'st_augustine' });
  expect(body.blocks).toEqual([]);
  expect(body.items.every((i) => i.gates === null && i.gateNotes.length === 0)).toBe(true);
});

test('spot rows get no quantity anywhere on the sheet: no job, planned or full-tank amount, a label-rate reference and the note', async () => {
  const body = await lawnMix({ month: '5', selectedConditionalProductNames: 'Arena 50 WDG, Celsius WG, LESCO 90/10 Nonionic Surfactant' });
  for (const name of ['Arena 50 WDG', 'Celsius WG', 'LESCO 90/10 Nonionic Surfactant']) {
    const item = itemFor(body, name);
    expect(item.selected).toBe(true);
    expect({ name, mixes: [item.jobMix, item.plannedMix, item.fullTankMix, item.plannedFullTankMix] }).toEqual({ name, mixes: [null, null, null, null] });
    expect(item.spot.note).toBe('Spot: enter the area treated and the amount used.');
  }
  expect(itemFor(body, 'Arena 50 WDG').spot.reference).toBe('Label rate 0.29 oz per 1,000 sq ft');
  expect(itemFor(body, 'Celsius WG').spot.reference).toBe('Label rate 0.085 oz per 1,000 sq ft');
  // The surfactant is a concentration of the tank, never a per-1,000 rate.
  expect(itemFor(body, 'LESCO 90/10 Nonionic Surfactant').spot.reference).toBe('Label concentration 0.25% v/v');
});

test('a blocked sheet withholds every quantity of the selected products, spot or not, and keeps the reason', async () => {
  const body = await lawnMix({ month: '5', selectedConditionalProductNames: 'Arena 50 WDG' });
  expect(body.blocks).toHaveLength(1);
  for (const item of body.items.filter((i) => i.selected)) {
    expect({ name: item.product?.name, mixes: [item.jobMix, item.plannedMix, item.fullTankMix, item.plannedFullTankMix] })
      .toEqual({ name: item.product?.name, mixes: [null, null, null, null] });
  }
  expect(body.materialCostSummary?.pricedLineCount ?? 0).toBe(0);
  expect(body.mixingOrder).toEqual([]);
});

test('whole-lawn rows keep their amounts beside the spot rows (a window with no apply-alone product): January Nutra-TECH and Stonewall 4FL', async () => {
  const body = await lawnMix({ month: '1', selectedConditionalProductNames: 'Celsius WG' });
  expect(body.blocks).toEqual([]);
  expect(itemFor(body, NUTRA).jobMix.amount).toBe(60);
  expect(itemFor(body, STONEWALL).jobMix.amount).toBe(5);
  expect(itemFor(body, 'Celsius WG').jobMix).toBeNull();
});
