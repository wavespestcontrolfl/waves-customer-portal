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

// The application-limit reader the plan and the sheet share (v13Limits calls it per selected product).
const mockCheckLimits = jest.fn();
jest.mock('../services/application-limits', () => ({ checkLimits: (...args) => mockCheckLimits(...args) }));

const db = require('../models/db');
const operatingLayer = require('../services/lawn-protocol-operating-layer');
const adminProtocolsRouter = require('../routes/admin-protocols');
const { LAWN_V13_VERSION } = require('../services/lawn-program');

const NUTRA = 'LESCO Nutra-TECH T&O Micronutrient Package';
const STONEWALL = 'LESCO Stonewall 4FL Prodiamine 40.7% Pre-Emergent Liquid Herbicide';
const F24 = 'LESCO 24-0-11 with PolyPlus OPTI';
const TETRINO = 'Tetrino Insecticide';
const ATRAZINE = 'LESCO Atrazine 1.05% 18-0-10 56% PolyPlus OPTI45 2%Fe 0.5%Mn 0.5%Mg AS MOP';
const DIMENSION = 'LESCO Dimension 0.21% 18-0-10 50% PolyPlus OPTI45 MOP Pre-Emergent Plus Fertilizer';
const CATALOG = [
  { id: 'nt', name: NUTRA, aliases: [], default_rate_per_1000: 12, rate_unit: 'fl oz', cost_per_unit: 1, cost_unit: 'fl oz' },
  { id: 'stw', name: STONEWALL, aliases: [], default_rate_per_1000: null, rate_unit: 'fl oz', cost_per_unit: 1, cost_unit: 'fl oz' },
  { id: 'tet', name: TETRINO, aliases: [], default_rate_per_1000: 0.367, rate_unit: 'fl oz', cost_per_unit: 1, cost_unit: 'fl oz' },
  { id: 'are', name: 'Arena 50 WDG', aliases: [], default_rate_per_1000: 0.29, rate_unit: 'oz', cost_per_unit: 1, cost_unit: 'oz' },
  { id: 'cel', name: 'Celsius WG', aliases: [], default_rate_per_1000: 0.085, rate_unit: 'oz', cost_per_unit: 1, cost_unit: 'oz' },
  { id: 'nis', name: 'LESCO 90/10 Nonionic Surfactant', aliases: [], default_rate_per_1000: 0.25, rate_unit: 'fl oz', cost_per_unit: 1, cost_unit: 'fl oz' },
  { id: 'f24', name: F24, aliases: [], analysis_n: 24, analysis_k: 11, default_rate_per_1000: 4.2, rate_unit: 'lb', cost_per_unit: 1, cost_unit: 'lb' },
  { id: 'atz', name: ATRAZINE, aliases: [], analysis_n: 18, analysis_k: 10, default_rate_per_1000: 4, rate_unit: 'lb', cost_per_unit: 1, cost_unit: 'lb' },
  { id: 'dim', name: DIMENSION, aliases: [], analysis_n: 18, analysis_k: 10, default_rate_per_1000: 2.78, rate_unit: 'lb', cost_per_unit: 1, cost_unit: 'lb' },
];
const V13_SUMMARY = {
  version: LAWN_V13_VERSION,
  products: [
    { productId: 'nt', ratePer1000: 6, rateUnit: 'fl oz', gates: {} },
    { productId: 'stw', ratePer1000: 0.5, rateUnit: 'fl oz', gates: {} },
    { productId: 'f24', protocolProductName: F24, ratePer1000: null, rateUnit: 'lb_n', gates: {} },
    { productId: 'dim', ratePer1000: null, rateUnit: 'lb_n', gates: {} },
    { productId: 'atz', protocolProductName: ATRAZINE, ratePer1000: 4, rateUnit: 'lb', gates: { turfOnly: ['st_augustine', 'centipede'], wholeLawn: true, replacesProduct: F24 } },
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

async function lawnMix(query, reqExtra = {}) {
  const res = { json: jest.fn(), status: jest.fn() };
  res.status.mockReturnValue(res);
  const next = jest.fn();
  await handler({ query: { track: 'bermuda', lawnSqft: '10000', ...query }, ...reqExtra }, res, next);
  expect(next).not.toHaveBeenCalled();
  expect(res.json).toHaveBeenCalledTimes(1);
  return JSON.parse(JSON.stringify(res.json.mock.calls[0][0]));
}

const itemFor = (body, name) => body.items.find((item) => item.product?.name === name);

let visitRows = [];
let turfRows = [];
beforeEach(() => {
  jest.clearAllMocks();
  visitRows = [];
  turfRows = [];
  mockCheckLimits.mockReset().mockResolvedValue({ allowed: true, blocks: [], warnings: [] });
  process.env.GATE_LAWN_V13 = 'true';
  operatingLayer.getProtocolWindowContext.mockResolvedValue({ protocol: { version: LAWN_V13_VERSION } });
  operatingLayer.summarizeProtocolContext.mockReturnValue(V13_SUMMARY);
  db.mockImplementation((table) => {
    if (table === 'equipment_calibrations as ec') {
      return readQuery([{ id: 'cal', equipment_system_id: 'tank', system_name: 'Tank', system_type: 'tank', carrier_gal_per_1000: 1, tank_capacity_gal: 110, expires_at: '2099-01-01T00:00:00Z' }]);
    }
    if (table === 'products_catalog') return readQuery(CATALOG);
    if (table === 'product_aliases') return readQuery([]);
    if (table === 'scheduled_services') return readQuery(visitRows);
    if (table === 'customer_turf_profiles') return readQuery(turfRows);
    if (table === 'customers') return readQuery([{ lawn_type: null }]);
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

test('April on a 9x plan (?visitsPerYear=9): Dimension 18-0-10 at 2.778 lb per 1,000 (0.5 lb N), no 24-0-11, no cadence warning', async () => {
  const body = await lawnMix({ month: '4', visitsPerYear: '9' });
  expect(body.selectedItems.map((item) => item.product.name)).toEqual([DIMENSION]);
  expect(itemFor(body, DIMENSION).jobMix).toMatchObject({ rateSource: 'target_n_analysis', amountUnit: 'lb' });
  expect(itemFor(body, DIMENSION).jobMix.ratePer1000).toBeCloseTo(2.7778, 3);
  expect(itemFor(body, F24)).toBeUndefined();
  expect(body.warnings.map((w) => w.code)).not.toContain('lawn_v13_plan_cadence_unknown');
});

test('April on a 12x plan keeps the 24-0-11; with no plan given it keeps it too and warns, naming the 9x product', async () => {
  const twelve = await lawnMix({ month: '4', visitsPerYear: '12' });
  expect(twelve.selectedItems.map((item) => item.product.name)).toEqual([F24]);
  expect(twelve.warnings.map((w) => w.code)).not.toContain('lawn_v13_plan_cadence_unknown');
  const unknown = await lawnMix({ month: '4' });
  expect(unknown.selectedItems.map((item) => item.product.name)).toEqual([F24]);
  expect(unknown.warnings.find((w) => w.code === 'lawn_v13_plan_cadence_unknown').message).toContain(DIMENSION);
  // Months with one step never ask.
  expect((await lawnMix({ month: '1' })).warnings.map((w) => w.code)).not.toContain('lawn_v13_plan_cadence_unknown');
});

describe('the sheet opened from a visit applies the plan\'s application limits (v13Limits)', () => {
  const VISIT = '3f2c1d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
  const visit = { id: VISIT, customer_id: 'cust-1', property_id: 'prop-A', scheduled_date: '2026-01-12', service_id: null, service_type: 'Lawn Care', recurring_pattern: null, recurring_interval_days: null };
  const capBlock = { type: 'annual_max_rate', matchType: 'active_ingredient', message: `${STONEWALL}: prodiamine across all products this year is 96.4% of the yearly label cap; this application brings it to 141.8% — THIS APPLICATION WOULD EXCEED IT.` };

  test('a visit whose customer is at the prodiamine cap: the Stonewall line has no amount, says why, and the sheet carries the limit message; the rest of the mix stays', async () => {
    visitRows = [visit];
    mockCheckLimits.mockImplementation(async (customerId, productId) => (productId === 'stw' ? { allowed: false, blocks: [capBlock], warnings: [] } : { allowed: true, blocks: [], warnings: [] }));
    const body = await lawnMix({ month: '1', scheduledServiceId: VISIT });
    const stonewall = itemFor(body, STONEWALL);
    expect(stonewall.jobMix).toBeNull();
    expect(stonewall.unavailable.reason).toMatch(/application limit is reached/);
    expect(body.blocks).toEqual([expect.objectContaining({ code: 'lawn_v13_annual_limit', productName: STONEWALL, message: capBlock.message })]);
    // Nutra-TECH (a different line) still computes.
    expect(itemFor(body, NUTRA).jobMix).toMatchObject({ amount: 60 });
    // The same call the plan makes: the visit's customer, product, date, the line's staged rate, the visit's property.
    expect(mockCheckLimits).toHaveBeenCalledWith('cust-1', 'stw', expect.any(Date), db,
      { proposed: { ratePer1000: 0.5, unit: 'fl oz' }, excludeScheduledServiceId: VISIT, propertyId: 'prop-A' });
  });

  test('a capped product has no step in the mixing order; the rest of the mix keeps its steps', async () => {
    visitRows = [visit];
    mockCheckLimits.mockImplementation(async (customerId, productId) => (productId === 'stw' ? { allowed: false, blocks: [capBlock], warnings: [] } : { allowed: true, blocks: [], warnings: [] }));
    const capped = await lawnMix({ month: '1', scheduledServiceId: VISIT });
    expect(capped.mixingOrder.map((step) => step.productName)).toEqual([NUTRA]);
    mockCheckLimits.mockResolvedValue({ allowed: true, blocks: [], warnings: [] });
    const clear = await lawnMix({ month: '1', scheduledServiceId: VISIT });
    expect(clear.mixingOrder.map((step) => step.productName).sort()).toEqual([NUTRA, STONEWALL].sort());
  });

  test('a warning-level limit is a sheet warning and leaves the dose', async () => {
    visitRows = [visit];
    mockCheckLimits.mockImplementation(async (customerId, productId) => (productId === 'stw'
      ? { allowed: true, blocks: [], warnings: [{ type: 'annual_max_rate', message: 'Stonewall: 95.7% of the yearly label cap.' }] } : { allowed: true, blocks: [], warnings: [] }));
    const body = await lawnMix({ month: '1', scheduledServiceId: VISIT });
    expect(body.warnings).toContainEqual(expect.objectContaining({ code: 'lawn_v13_limit_warning', message: 'Stonewall: 95.7% of the yearly label cap.' }));
    expect(itemFor(body, STONEWALL).jobMix).toMatchObject({ amount: 5 });
    expect(body.blocks).toEqual([]);
  });

  test('no visit, an unknown visit and a malformed id check no limits (no customer to check)', async () => {
    mockCheckLimits.mockResolvedValue({ allowed: false, blocks: [capBlock], warnings: [] });
    for (const query of [{ month: '1' }, { month: '1', scheduledServiceId: 'not-a-uuid' }, { month: '1', scheduledServiceId: VISIT }]) {
      visitRows = [];
      const body = await lawnMix(query);
      expect(itemFor(body, STONEWALL).jobMix).toMatchObject({ amount: 5 });
      expect(body.blocks).toEqual([]);
    }
    expect(mockCheckLimits).not.toHaveBeenCalled();
  });

  test('gate off: no limit check at all', async () => {
    delete process.env.GATE_LAWN_V13;
    visitRows = [visit];
    await lawnMix({ month: '1', track: 'st_augustine', scheduledServiceId: VISIT });
    expect(mockCheckLimits).not.toHaveBeenCalled();
  });
});

describe('the April step follows the visit the sheet is opened from (?scheduledServiceId=)', () => {
  const VISIT = '3f2c1d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
  const selected = (body) => body.selectedItems.map((item) => item.product.name);

  test('a visit whose series runs every 6 weeks (9x) gets Dimension without the caller sending a cadence', async () => {
    visitRows = [{ service_id: null, service_type: 'Lawn Care', recurring_pattern: 'every_6_weeks', recurring_interval_days: null }];
    const body = await lawnMix({ month: '4', scheduledServiceId: VISIT });
    expect(selected(body)).toEqual([DIMENSION]);
    expect(body.warnings.map((w) => w.code)).not.toContain('lawn_v13_plan_cadence_unknown');
  });

  test('a monthly visit keeps the 24-0-11; an explicit ?visitsPerYear outranks the visit', async () => {
    visitRows = [{ service_id: null, service_type: 'Lawn Care', recurring_pattern: 'monthly', recurring_interval_days: null }];
    expect(selected(await lawnMix({ month: '4', scheduledServiceId: VISIT }))).toEqual([F24]);
    expect(selected(await lawnMix({ month: '4', scheduledServiceId: VISIT, visitsPerYear: '9' }))).toEqual([DIMENSION]);
  });

  test('a technician opening another technician\'s visit gets nothing from it: the read is scoped to their own assignments', async () => {
    // Codex r6 on #5998: the visit read must apply technicianCurrentVisitFilter like the job card.
    const row = { service_id: null, service_type: 'Lawn Care', recurring_pattern: 'every_6_weeks', recurring_interval_days: null, technician_id: 'tech-A' };
    const scopedFirst = jest.fn();
    db.mockImplementation((table) => {
      if (table !== 'scheduled_services') return readQuery(table === 'products_catalog' ? CATALOG : table === 'equipment_calibrations as ec'
        ? [{ id: 'cal', equipment_system_id: 'tank', system_name: 'Tank', system_type: 'tank', carrier_gal_per_1000: 1, tank_capacity_gal: 110, expires_at: '2099-01-01T00:00:00Z' }] : []);
      const conds = [];
      const q = { where: jest.fn((k, v) => { if (typeof k === 'string') conds.push([k, v]); return q; }), whereNotIn: jest.fn(() => q) };
      q.first = scopedFirst.mockImplementation(async () => (conds.every(([k, v]) => k !== 'scheduled_services.technician_id' || row.technician_id === v) ? row : null));
      return q;
    });
    const other = await lawnMix({ month: '4', scheduledServiceId: VISIT }, { techRole: 'technician', technicianId: 'tech-B' });
    expect(selected(other)).toEqual([F24]);
    expect(other.warnings.map((w) => w.code)).toContain('lawn_v13_plan_cadence_unknown');
    const own = await lawnMix({ month: '4', scheduledServiceId: VISIT }, { techRole: 'technician', technicianId: 'tech-A' });
    expect(selected(own)).toEqual([DIMENSION]);
    const staff = await lawnMix({ month: '4', scheduledServiceId: VISIT });
    expect(selected(staff)).toEqual([DIMENSION]);
  });

  test('a visit that states no plan, an unknown id and a malformed id all keep the 24-0-11 and warn', async () => {
    visitRows = [{ service_id: null, service_type: 'Lawn Care', recurring_pattern: null, recurring_interval_days: null }];
    for (const scheduledServiceId of [VISIT, 'not-a-uuid']) {
      const body = await lawnMix({ month: '4', scheduledServiceId });
      expect(selected(body)).toEqual([F24]);
      expect(body.warnings.map((w) => w.code)).toContain('lawn_v13_plan_cadence_unknown');
    }
    visitRows = [];
    expect((await lawnMix({ month: '4', scheduledServiceId: VISIT })).warnings.map((w) => w.code)).toContain('lawn_v13_plan_cadence_unknown');
  });
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

test('gate off: no v13 field on any item, no blocks, the mixing order is built as before', async () => {
  delete process.env.GATE_LAWN_V13;
  const body = await lawnMix({ month: '5', track: 'st_augustine' });
  expect(body.blocks).toEqual([]);
  for (const item of body.items) {
    for (const field of ['gates', 'gateNotes', 'spot', 'unavailable']) expect(field in item).toBe(false);
  }
});

test('an unlinked v13 line (matched product, no staged row) gets no quantity and says why, never the catalog default', async () => {
  operatingLayer.summarizeProtocolContext.mockReturnValue({ ...V13_SUMMARY, products: V13_SUMMARY.products.filter((row) => row.productId !== 'nt') });
  const body = await lawnMix({ month: '1' });
  const item = itemFor(body, NUTRA);
  expect([item.jobMix, item.plannedMix, item.fullTankMix, item.plannedFullTankMix]).toEqual([null, null, null, null]);
  expect(item.unavailable.reason).toMatch(/No protocol row is linked/);
});

test('/completion-actions with the gate on: products carry no amounts (January Nutra-TECH is never the catalog 12, Arena has none); the plan is the single source', async () => {
  const completionActions = adminProtocolsRouter.stack.find((layer) => layer.route?.path === '/completion-actions' && layer.route.methods.get).route.stack[0].handle;
  const call = async (query) => {
    const res = { json: jest.fn(), status: jest.fn() };
    res.status.mockReturnValue(res);
    await completionActions({ query: { serviceType: 'Lawn Care', track: 'bermuda', ...query } }, res, jest.fn());
    return JSON.parse(JSON.stringify(res.json.mock.calls[0][0]));
  };
  const body = await call({ month: '1' });
  const nutra = body.actions.find((a) => a.product?.name === NUTRA);
  expect(nutra.product).toMatchObject({ defaultRatePer1000: null, defaultRate: null, maxLabelRatePer1000: null });
  expect(body.note).toMatch(/amounts from the visit plan/);
  expect(JSON.stringify(body.actions)).not.toMatch(/"defaultRatePer1000":\s*[1-9]/);
  const may = await call({ month: '5' });
  expect(may.actions.find((a) => a.product?.name === 'Arena 50 WDG').product.defaultRatePer1000).toBeNull();
  // Gate off: the catalog default answers as before.
  delete process.env.GATE_LAWN_V13;
  const off = await call({ month: '1', track: 'st_augustine' });
  expect('note' in off).toBe(false);
  expect(off.actions.some((a) => a.product && a.product.defaultRatePer1000 != null)).toBe(true);
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

describe('the February atrazine option on the sheet follows the lawn the sheet is opened for', () => {
  const VISIT = '3f2c1d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
  const visit = { id: VISIT, customer_id: 'cust-1', property_id: 'prop-A', scheduled_date: '2026-02-12', service_id: null, service_type: 'Lawn Care', recurring_pattern: null, recurring_interval_days: null };
  const febQuery = { month: '2', track: 'st_augustine', selectedConditionalProductNames: ATRAZINE };

  test('the reference tab (no lawn): atrazine is unsized, says why, a block names it, and the default bag stays', async () => {
    const body = await lawnMix(febQuery);
    const atrazine = itemFor(body, ATRAZINE);
    expect(atrazine.selected).toBe(true);
    expect(atrazine.jobMix).toBeNull();
    expect(atrazine.unavailable.reason).toMatch(/certain grasses only/);
    expect(atrazine.gateNotes.map((note) => note.key)).toContain('turfOnly');
    expect(body.blocks).toEqual([expect.objectContaining({ code: 'lawn_v13_turf_species', productName: ATRAZINE })]);
    expect(itemFor(body, F24).selected).toBe(true);
    expect(itemFor(body, F24).jobMix).toBeTruthy();
  });

  test.each(['st_augustine', 'centipede'])('a visit on a %s lawn: atrazine is sized for the whole lawn and the 24-0-11 is off the sheet', async (grass) => {
    visitRows = [visit];
    turfRows = [{ grass_type: grass, track_key: null }];
    const body = await lawnMix({ ...febQuery, scheduledServiceId: VISIT });
    expect(itemFor(body, ATRAZINE).jobMix).toMatchObject({ amount: 40, amountUnit: 'lb' });
    expect(body.blocks).toEqual([]);
    expect(body.selectedItems.map((item) => item.product.name)).toEqual([ATRAZINE]);
    // An allowed lawn gets no species warning (the plan's own gate context carries the grass).
    expect(body.warnings.filter((w) => w.gate === 'turfOnly')).toEqual([]);
    expect(itemFor(body, ATRAZINE).gateNotes.map((note) => note.key)).not.toContain('turfOnly');
  });

  test.each(['mixed', 'unknown', 'bahia', 'bermuda', 'zoysia'])('a visit on a %s lawn: no atrazine amount, a block, the default bag stays', async (grass) => {
    visitRows = [visit];
    turfRows = [{ grass_type: grass, track_key: null }];
    const body = await lawnMix({ ...febQuery, scheduledServiceId: VISIT });
    expect(itemFor(body, ATRAZINE).jobMix).toBeNull();
    expect(body.blocks.map((block) => block.code)).toEqual(['lawn_v13_turf_species']);
    expect(body.warnings.filter((w) => w.gate === 'turfOnly')).toHaveLength(1);
    expect(body.selectedItems.map((item) => item.product.name).sort()).toEqual([ATRAZINE, F24].sort());
    expect(itemFor(body, F24).jobMix).toBeTruthy();
  });
});
