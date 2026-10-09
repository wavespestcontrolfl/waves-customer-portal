// The compliance page reads the Celsius yearly count over the last 365 days (v13 cap entry `yearWindow: 'rolling365'`) and a
// calendar-year product over the calendar year, the way application-limits enforces them. Runs on the migrated test database with
// synthetic rows, removed afterwards. Only Date is faked (2026-01-12), so the database driver keeps real timers.
const { randomUUID } = require('crypto');
const db = require('../models/db');
const ComplianceService = require('../services/compliance');
const applicationLimits = require('../services/application-limits');
const { resetV13CapIdentity } = require('../config/lawn-v13-count-caps');
const { fixture } = require('./helpers/lawn-history-db');

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;
const NOT_DATE = ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback',
  'cancelIdleCallback', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'];

describeDb('compliance page: the yearly count window', () => {
  const made = { customers: [], products: [], limits: [], records: [] };
  const saved = process.env.GATE_LAWN_V13;
  let celsius;
  let calendarProduct;
  let calendarLimit;

  async function lawnWith(product, dates) {
    const f = await fixture(db);
    made.customers.push(f.customerId);
    for (const date of dates) {
      const [visit] = await db('scheduled_services').insert({ customer_id: f.customerId, property_id: f.property.id, scheduled_date: date, service_type: 'Lawn fixture' }).returning('*');
      const [record] = await db('service_records').insert({ customer_id: f.customerId, scheduled_service_id: visit.id, service_date: date, service_type: 'Lawn fixture' }).returning('*');
      made.records.push(record.id);
      await db('property_application_history').insert({ customer_id: f.customerId, product_id: product.id, application_date: date, application_rate: 0.085, rate_unit: 'oz', service_record_id: record.id, property_id: f.property.id });
    }
    return f.customerId;
  }
  const countRow = async (customerId, productId) => (await ComplianceService.getProductLimits(customerId)).limits
    .find((limit) => limit.limitType === 'annual_max_apps' && limit.productId === productId);

  beforeAll(async () => {
    celsius = await db('products_catalog').where({ name: 'Celsius WG' }).first();
    [calendarProduct] = await db('products_catalog').insert({ name: `Calendar cap fixture ${randomUUID()}`, category: 'herbicide', active: true }).returning('*');
    made.products.push(calendarProduct.id);
    [calendarLimit] = await db('product_limits').insert({ product_id: calendarProduct.id, match_type: 'product', limit_type: 'annual_max_apps', limit_value: 2, limit_unit: 'applications', severity: 'hard_block', description: 'fixture' }).returning('*');
    made.limits.push(calendarLimit.id);
  });
  beforeEach(() => {
    process.env.GATE_LAWN_V13 = 'true';
    resetV13CapIdentity();
    jest.useFakeTimers({ now: new Date('2026-01-12T17:00:00Z'), doNotFake: NOT_DATE });
  });
  afterEach(() => {
    jest.useRealTimers();
    if (saved === undefined) delete process.env.GATE_LAWN_V13; else process.env.GATE_LAWN_V13 = saved;
  });
  afterAll(async () => {
    await db('property_application_history').whereIn('customer_id', made.customers).del();
    await db('service_records').whereIn('id', made.records).del();
    await db('scheduled_services').whereIn('customer_id', made.customers).del();
    await db('customer_properties').whereIn('customer_id', made.customers).del();
    await db('customers').whereIn('id', made.customers).del();
    await db('product_limits').whereIn('id', made.limits).del();
    await db('products_catalog').whereIn('id', made.products).del();
    await db.destroy();
  });

  test('two December Celsius applications read 2 of 2 (exceeded) on 12 January; a calendar-year product with the same dates reads 0', async () => {
    const customerId = await lawnWith(celsius, ['2025-12-05', '2025-12-20']);
    expect(await countRow(customerId, celsius.id)).toMatchObject({ currentUsage: 2, status: 'exceeded' });
    const other = await lawnWith(calendarProduct, ['2025-12-05', '2025-12-20']);
    expect(await countRow(other, calendarProduct.id)).toMatchObject({ currentUsage: 0, status: 'ok' });
  });

  test('an application 365 days back is out of the window', async () => {
    const customerId = await lawnWith(celsius, ['2025-01-12', '2025-12-20']);
    expect(await countRow(customerId, celsius.id)).toMatchObject({ currentUsage: 1, status: 'warning' });
  });

  test('getPropertyComplianceStatus lists Celsius with its two December passes (and the block) on 12 January; a calendar-year product with the same dates is not listed', async () => {
    const customerId = await lawnWith(celsius, ['2025-12-05', '2025-12-20']);
    const status = await applicationLimits.getPropertyComplianceStatus(customerId);
    expect(status.products.map((p) => p.productId)).toEqual([celsius.id]);
    expect(status.products[0]).toMatchObject({ applicationsThisYear: 2 });
    expect(status.products[0].limits.blocks.map((b) => b.type)).toEqual(['annual_max_apps']);
    expect(status.blocks).toBe(1);
    expect(status.totalApplications).toBe(0); // the calendar-year total and the nitrogen budget still start on 1 January
    const other = await lawnWith(calendarProduct, ['2025-12-05', '2025-12-20']);
    expect((await applicationLimits.getPropertyComplianceStatus(other)).products).toEqual([]);
  });

  test('gate off: the stored row and the calendar year (nothing counted on 12 January)', async () => {
    delete process.env.GATE_LAWN_V13;
    resetV13CapIdentity();
    const customerId = await lawnWith(celsius, ['2025-12-05', '2025-12-20']);
    expect(await countRow(customerId, celsius.id)).toMatchObject({ currentUsage: 0, status: 'ok' });
  });
});
