jest.mock('../models/db', () => {
  const db = jest.fn(() => chain);
  const chain = { where: jest.fn().mockReturnThis(), whereNotIn: jest.fn().mockReturnThis(),
    modify: fn => { fn(chain); return chain; }, first: jest.fn() };
  db.chain = chain;
  return db;
});
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: function adminAuthenticate(req, res, next) { next(); },
  requireTechOrAdmin: function requireTechOrAdmin(req, res, next) { next(); },
}));
jest.mock('../services/waveguard-plan-engine', () => ({ buildPlanForService: jest.fn() }));
const db = require('../models/db');
const { buildPlanForService } = require('../services/waveguard-plan-engine');
const router = require('../routes/admin-treatment-plans');

async function run({ body = {}, query = {}, tech = false, post = false } = {}) {
  const route = router.stack.find(layer => layer.route?.methods[post ? 'post' : 'get']);
  const res = { statusCode: 200, set: jest.fn(), status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
  await route.route.stack.at(-1).handle({ body, query, params: { serviceId: 'visit' }, techRole: tech ? 'technician' : 'admin', technicianId: 'tech' }, res, error => { throw error; });
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GATE_LAWN_COMPLETION_DEFAULTS = 'true';
  process.env.GATE_LAWN_PROPERTY_HISTORY = 'true';
  db.chain.first.mockResolvedValue({ id: 'visit' });
  buildPlanForService.mockResolvedValue({ completionDefaults: { enabled: true } });
});
afterEach(() => { delete process.env.GATE_LAWN_COMPLETION_DEFAULTS; delete process.env.GATE_LAWN_PROPERTY_HISTORY; });

test('the existing router retains both authentication and staff role guards', () => {
  expect(router.stack.slice(0, 2).map(layer => layer.handle.name)).toEqual(['adminAuthenticate', 'requireTechOrAdmin']);
});
test.each([4000, null])('visit area %s reaches the read-only builder without coercion', async lawnSqft => {
  const response = await run({ post: true, body: { completionDefaults: true, lawnSqft } });
  expect(buildPlanForService).toHaveBeenCalledWith('visit', expect.objectContaining({ lawnSqft, includeCompletionDefaults: true, completionDefaultsEnabled: true }));
  expect(response.set).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
});
test.each(['4000', '', false, 0, -1, 10000001, 2500.5])('invalid visit area %j is rejected before building', async lawnSqft => {
  await expect(run({ post: true, body: { completionDefaults: true, lawnSqft } })).rejects.toMatchObject({ statusCode: 400 });
  expect(buildPlanForService).not.toHaveBeenCalled();
});
test('gate-off cannot accept a visit-area override', async () => {
  delete process.env.GATE_LAWN_PROPERTY_HISTORY;
  await expect(run({ post: true, body: { completionDefaults: true, lawnSqft: 4000 } })).rejects.toMatchObject({ statusCode: 400 });
  await run({ query: { completionDefaults: '1' } });
  expect(buildPlanForService).toHaveBeenCalledWith('visit', expect.objectContaining({ completionDefaultsEnabled: false }));
});
test.each([false, true])('tech assignment is enforced before and after the plan read (post=%s)', async post => {
  const request = { post, tech: true, query: { completionDefaults: '1' } };
  db.chain.first.mockResolvedValueOnce(null);
  expect((await run(request)).statusCode).toBe(404);
  expect(buildPlanForService).not.toHaveBeenCalled();
  db.chain.first.mockResolvedValueOnce({ id: 'visit' }).mockResolvedValueOnce(null);
  expect((await run(request)).statusCode).toBe(404);
  expect(db.chain.where).toHaveBeenCalledWith('scheduled_services.technician_id', 'tech');
  expect(db.chain.whereNotIn).toHaveBeenCalled();
});

test.each([true, false])('the plan response never carries propertyGate.billingMode (technician=%s) — office-only, attribution reads the server-built plan (codex #4365 P2)', async (tech) => {
  buildPlanForService.mockResolvedValue({ serviceId: 'visit', propertyGate: { serviceTier: 'Silver', billingMode: 'one_time', trackKey: 'st_augustine' }, completionDefaults: { enabled: true } });
  for (const post of [false, true]) {
    const res = await run({ tech, post, body: post ? { completionDefaults: true } : {}, query: post ? {} : { completionDefaults: '1' } });
    expect(res.statusCode).toBe(200);
    expect(res.body.plan.propertyGate).toEqual({ serviceTier: 'Silver', trackKey: 'st_augustine' });
    expect(res.body.plan.propertyGate).not.toHaveProperty('billingMode');
    expect(res.body.plan.completionDefaults).toEqual({ enabled: true });
  }
});

test('a technician is pinned to an assigned visit for EVERY plan read, not only completion-default requests (codex #5568 r2 P1)', async () => {
  db.chain.first.mockResolvedValue(null);
  const response = await run({ tech: true, query: {} });
  expect(response.statusCode).toBe(404);
  expect(buildPlanForService).not.toHaveBeenCalled();
  db.chain.first.mockResolvedValue({ id: 'visit' });
  const ok = await run({ tech: true, query: {} });
  expect(ok.statusCode).toBe(200);
  expect(buildPlanForService).toHaveBeenCalledTimes(1);
});

test.each([
  ['Lawn Care', true],
  ['Tree & Shrub Care', true],
  ['Pest Control', false],
])('a %s plan carries stockAdvisory only when a lawn or tree & shrub visit is advisory (%s)', async (service, advisory) => {
  buildPlanForService.mockResolvedValue({ serviceId: 'visit', propertyGate: { service, serviceTier: 'Commercial' } });
  const res = await run({ query: {} });
  if (advisory) expect(res.body.plan.stockAdvisory).toBe(true);
  else expect(res.body.plan).not.toHaveProperty('stockAdvisory');
});

// Technician visibility audit A3: a technician gets no vendor price or job cost, at every depth the plan repeats a product or a mix.
const costedPlan = () => ({
  serviceId: 'visit',
  propertyGate: { service: 'Lawn Care', billingMode: 'one_time' },
  protocol: {
    base: [{ raw: 'K-Flow 0-0-25 ($2.18)', product: { name: 'K-Flow', bestPrice: 41.5, costPerUnit: 0.2, costUnit: 'oz', needsPricing: false, labelRate: '2 oz' }, mix: { amount: 2, materialCost: 0.4, materialCostSource: 'cost_per_unit', materialCostDetail: { costPerUnit: 0.2 } } }],
    conditional: [{ raw: 'Optional - $15', product: { name: 'Fungicide', bestPrice: 90 }, mix: { materialCost: 3 } }],
  },
  mixCalculator: {
    materialCostSummary: { total: 3.4, pricedCount: 2 },
    items: [{ product: { name: 'K-Flow', bestPrice: 41.5, costPerUnit: 0.2, costUnit: 'oz', needsPricing: true }, mix: { materialCost: 0.4, materialCostSource: 'cost_per_unit', materialCostDetail: { bestPrice: 41.5 }, amount: 2 } }],
    conditionalOptions: [{ product: { name: 'Fungicide', bestPrice: 90 }, mix: { materialCost: 3 } }],
  },
});
const OWNER_ONLY = /bestPrice|costPerUnit|costUnit|needsPricing|materialCost/;

test('a technician plan has no vendor price, unit cost or material cost anywhere, and keeps the recipe', async () => {
  buildPlanForService.mockResolvedValue(costedPlan());
  for (const post of [false, true]) {
    const res = await run({ tech: true, post, body: post ? {} : {}, query: {} });
    const json = JSON.stringify(res.body.plan);
    expect(json).not.toMatch(OWNER_ONLY);
    expect(json).not.toMatch(/\$\d/);
    expect(res.body.plan.protocol.base[0].product.name).toBe('K-Flow');
    expect(res.body.plan.protocol.base[0].product.labelRate).toBe('2 oz');
    expect(res.body.plan.mixCalculator.items[0].mix.amount).toBe(2);
    expect(res.body.plan.protocol.base[0].raw).toBe('K-Flow 0-0-25');
  }
});

test('an admin plan keeps every price and cost field', async () => {
  buildPlanForService.mockResolvedValue(costedPlan());
  const res = await run({ query: {} });
  const json = JSON.stringify(res.body.plan);
  for (const key of ['bestPrice', 'costPerUnit', 'costUnit', 'needsPricing', 'materialCost', 'materialCostSource', 'materialCostDetail', 'materialCostSummary']) {
    expect(json).toContain(`"${key}"`);
  }
  expect(res.body.plan.protocol.base[0].raw).toBe('K-Flow 0-0-25 ($2.18)');
});

// The Plan tab shows each protocol line's `description`, the Job tab's own text rule: no rate and no price, for every viewer.
test.each([true, false])('every protocol line carries a description with no rate and no price (technician=%s); raw stays', async tech => {
  const raw = 'Stonewall 4FL 0.5 fl oz per 1,000 ($3.51)';
  buildPlanForService.mockResolvedValue({
    propertyGate: { service: 'Lawn Care' },
    protocol: { base: [{ raw, matched: true }], conditional: [{ raw: 'If needed: Fungicide 2 oz/1000 sq ft ($15.00)', matched: false }] },
  });
  const { protocol } = (await run({ tech })).body.plan;
  expect(protocol.base[0].description).toBe('Stonewall 4FL');
  expect(protocol.conditional[0].description).toBe('If needed: Fungicide');
  for (const item of [...protocol.base, ...protocol.conditional]) expect(item.description).not.toMatch(/\$|0\.5|1,000|fl oz| oz|15\.00/);
  expect(protocol.base[0].raw).toBe(tech ? 'Stonewall 4FL 0.5 fl oz per 1,000' : raw);
});

// The Plan tab's notice text: a stock block names no planned quantity and an unmatched line is described, not raw.
// `message` stays as the engine writes it (summarizeInventoryStatus) for the completion form, which reads these lists.
test.each([true, false])('a stock block and an unmatched line carry a description with no planned amount, rate or price (technician=%s); message stays', async tech => {
  const stock = { productId: 'p1', productName: 'Fixture Granule', code: 'inventory_insufficient_stock', severity: 'block', message: 'Fixture Granule requires 12.5 lb, but only 4 lb is on hand.' };
  const unmatched = { code: 'inventory_product_unmatched', severity: 'warning', message: 'Protocol line is not mapped to inventory: Fixture Liquid 0.5 fl oz per 1,000 ($1.91+$21.79)' };
  const blackout = { code: 'nitrogen_blackout', severity: 'block', message: 'Fixture County restricts nitrogen during this visit window.' };
  buildPlanForService.mockResolvedValue({ propertyGate: { service: 'Lawn Care', blocks: [stock, blackout], warnings: [unmatched] }, protocol: { base: [], conditional: [] } });
  const { propertyGate } = (await run({ tech })).body.plan;
  expect(propertyGate.blocks[0].description).toBe('Fixture Granule: not enough on hand for this visit.');
  expect(propertyGate.warnings[0].description).toBe('Protocol line is not mapped to inventory: Fixture Liquid');
  expect(propertyGate.blocks[1]).not.toHaveProperty('description');
  expect(propertyGate.blocks[0].message).toBe(stock.message);
  expect(propertyGate.warnings[0].message).toContain('Fixture Liquid 0.5 fl oz per 1,000');
});

// The engine copies the visit's notes into protocol.objective, and a June lawn note names an Advion rate and a price can ride in a note too.
test.each([true, false])('the plan objective carries a description with no rate and no price, from the real June lawn note (technician=%s)', async tech => {
  const protocols = require('../config/protocols.json');
  const note = JSON.stringify(protocols).match(/"notes": ?"([^"]*Advion Insect Granule bait, 3 lb per 1,000 sq ft[^"]*)"/)?.[1];
  expect(note).toBeTruthy();
  buildPlanForService.mockResolvedValue({ propertyGate: { service: 'Lawn Care' }, protocol: { objective: `${note} ($4.20)`, base: [], conditional: [] } });
  const { protocol } = (await run({ tech })).body.plan;
  expect(protocol.objectiveDescription).toContain('Advion Insect Granule bait');
  expect(protocol.objectiveDescription).not.toMatch(/\$|3 lb|1,000|\blb\b/);
  expect(protocol.objective).toContain('3 lb per 1,000 sq ft');
});
