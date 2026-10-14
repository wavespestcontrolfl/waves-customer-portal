// POST /api/admin/compliance/check-limits checks PROPOSED products but names no dose. Under GATE_LAWN_V13 the Arena yearly
// amount (0.294 oz per 1,000 sq ft) must count the program's dose (the staged v13 row's 0.147 oz) for such a check, so a
// proposal after an old 0.29 oz pass reads as over the cap; the compliance page summary stays a status read (no phantom dose).
// Runs on the migrated test database with synthetic rows, removed afterwards; self-skips without DATABASE_URL.
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => next(),
  requireAdmin: (req, res, next) => next(),
  requireTechOrAdmin: (req, res, next) => next(),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

describeDb('compliance check-limits: the Arena yearly amount in a proposal check', () => {
  const saved = process.env.GATE_LAWN_V13;
  const made = { customers: [], records: [] };
  let db;
  let router;
  let ComplianceService;
  let fixture;
  let arena;

  beforeAll(async () => {
    db = require('../models/db');
    router = require('../routes/admin-compliance');
    ComplianceService = require('../services/compliance');
    ({ fixture } = require('./helpers/lawn-history-db'));
    arena = await db('products_catalog').where({ name: 'Arena 50 WDG' }).first();
  });
  afterAll(async () => {
    await db('property_application_history').whereIn('customer_id', made.customers).del();
    await db('service_records').whereIn('id', made.records).del();
    await db('scheduled_services').whereIn('customer_id', made.customers).del();
    await db('customer_properties').whereIn('customer_id', made.customers).del();
    await db('customers').whereIn('id', made.customers).del();
    if (saved === undefined) delete process.env.GATE_LAWN_V13; else process.env.GATE_LAWN_V13 = saved;
    await db.destroy();
  });

  // The calendar day the prior pass is dated: Jan 1 of this Eastern year (inside the year the cap judges).
  const yearStartDay = () => `${new Date().toLocaleString('en-CA', { timeZone: 'America/New_York' }).slice(0, 4)}-01-01`;
  const daysSinceJan1 = () => Math.floor((Date.now() - Date.parse(`${yearStartDay()}T12:00:00Z`)) / 86400000);

  async function customerWith(rates) {
    const f = await fixture(db);
    made.customers.push(f.customerId);
    for (const rate of rates) {
      const date = yearStartDay();
      const [visit] = await db('scheduled_services').insert({ customer_id: f.customerId, property_id: f.property.id, scheduled_date: date, service_type: 'Lawn fixture' }).returning('*');
      const [record] = await db('service_records').insert({ customer_id: f.customerId, scheduled_service_id: visit.id, service_date: date, service_type: 'Lawn fixture' }).returning('*');
      made.records.push(record.id);
      await db('property_application_history').insert({ customer_id: f.customerId, product_id: arena.id, application_date: date, application_rate: rate, rate_unit: 'oz', service_record_id: record.id });
    }
    return f;
  }

  async function post(body) {
    const layer = router.stack.find((l) => l.route && l.route.path === '/check-limits' && l.route.methods.post);
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(payload) { this.body = payload; return this; } };
    await handler({ body }, res, (err) => { throw err; });
    return res;
  }
  const amountBlocks = (res) => res.body.results[0].blocks.filter((b) => b.type === 'annual_max_rate');

  test('after a prior 0.29 oz pass the proposal is not allowed: a hard block at 148.6%', async () => {
    process.env.GATE_LAWN_V13 = 'true';
    const f = await customerWith([0.29]);
    const res = await post({ customerId: f.customerId, propertyId: f.property.id, products: [{ productId: arena.id, name: 'Arena 50 WDG' }] });
    expect(res.body.allowed).toBe(false);
    expect(amountBlocks(res)).toHaveLength(1);
    expect(amountBlocks(res)[0].message).toMatch(/total 98\.6%.*brings it to 148\.6% — THIS APPLICATION WOULD EXCEED IT/);
  });

  test('after a prior 0.147 oz pass the amount fits (50% + the 0.147 dose = 100%): no amount block; allowed unless the 56-day gap still holds', async () => {
    process.env.GATE_LAWN_V13 = 'true';
    const f = await customerWith([0.147]);
    const res = await post({ customerId: f.customerId, propertyId: f.property.id, products: [{ productId: arena.id, name: 'Arena 50 WDG' }] });
    expect(amountBlocks(res)).toEqual([]);
    const types = res.body.results[0].blocks.map((b) => b.type);
    if (daysSinceJan1() >= 56) expect(res.body.allowed).toBe(true); else expect(types).toEqual(['min_interval_days']);
  });

  test('two prior 0.147 passes: the amount is full, the proposal is blocked', async () => {
    process.env.GATE_LAWN_V13 = 'true';
    const f = await customerWith([0.147, 0.147]);
    const res = await post({ customerId: f.customerId, propertyId: f.property.id, products: [{ productId: arena.id, name: 'Arena 50 WDG' }] });
    expect(res.body.allowed).toBe(false);
    expect(amountBlocks(res)).toHaveLength(1);
  });

  test('gate off: no amount cap in the proposal check', async () => {
    delete process.env.GATE_LAWN_V13;
    const f = await customerWith([0.29]);
    const res = await post({ customerId: f.customerId, propertyId: f.property.id, products: [{ productId: arena.id, name: 'Arena 50 WDG' }] });
    expect(amountBlocks(res)).toEqual([]);
  });

  test('the compliance page summary stays a status read: the same customer reads 0.29 used (a warning), with no phantom dose, before and after the route ran', async () => {
    process.env.GATE_LAWN_V13 = 'true';
    const f = await customerWith([0.29]);
    const row = async () => (await ComplianceService.getProductLimits(f.customerId)).limits.find((l) => l.productId === arena.id && l.limitType === 'annual_max_rate');
    expect(await row()).toMatchObject({ currentUsage: 0.29, status: 'warning' });
    await post({ customerId: f.customerId, propertyId: f.property.id, products: [{ productId: arena.id }] });
    expect(await row()).toMatchObject({ currentUsage: 0.29, status: 'warning' });
    const status = await require('../services/application-limits').getPropertyComplianceStatus(f.customerId);
    const arenaStatus = status.products.find((p) => p.productId === arena.id);
    expect(arenaStatus.limits.blocks.filter((b) => b.type === 'annual_max_rate')).toEqual([]);
  });
});
