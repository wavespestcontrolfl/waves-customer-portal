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
  async function lawnRows(customerId, product, dates) {
    const property = await db('customer_properties').where({ customer_id: customerId }).first();
    for (const date of dates) {
      const [visit] = await db('scheduled_services').insert({ customer_id: customerId, property_id: property.id, scheduled_date: date, service_type: 'Lawn fixture' }).returning('*');
      const [record] = await db('service_records').insert({ customer_id: customerId, scheduled_service_id: visit.id, service_date: date, service_type: 'Lawn fixture' }).returning('*');
      made.records.push(record.id);
      await db('property_application_history').insert({ customer_id: customerId, product_id: product.id, application_date: date, application_rate: 0.085, rate_unit: 'oz', service_record_id: record.id, property_id: property.id });
    }
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

  // Both directions of the history read in getPropertyComplianceStatus: it starts at the earlier of 1 January and the rolling start,
  // and each product is then judged over its own window.
  test('early January: a calendar-year product ignores last year\'s rows, Celsius counts them, the totals stay on this year', async () => {
    const customerId = await lawnWith(celsius, ['2025-12-05', '2025-12-20', '2026-01-05']);
    await lawnRows(customerId, calendarProduct, ['2025-12-05', '2025-12-20', '2026-01-05']);
    const status = await applicationLimits.getPropertyComplianceStatus(customerId);
    const byId = Object.fromEntries(status.products.map((p) => [p.productId, p.applicationsThisYear]));
    expect(byId).toEqual({ [celsius.id]: 3, [calendarProduct.id]: 1 });
    expect(status.totalApplications).toBe(2); // the two 2026 rows, one per product
  });

  test('30-31 December of a leap year: the rolling start is 2 January, later than 1 January, yet the calendar-year product still counts 1 January', async () => {
    jest.setSystemTime(new Date('2028-12-31T17:00:00Z'));
    expect(applicationLimits.windowFor('2028-12-31', 'rolling365').start).toBe('2028-01-02');
    expect(applicationLimits.windowFor('2027-12-31', 'rolling365').start).toBe('2027-01-01');
    const customerId = await lawnWith(calendarProduct, ['2028-01-01', '2028-06-01']);
    await lawnRows(customerId, celsius, ['2028-01-01', '2028-06-01']);
    const status = await applicationLimits.getPropertyComplianceStatus(customerId);
    const byId = Object.fromEntries(status.products.map((p) => [p.productId, p.applicationsThisYear]));
    expect(byId).toEqual({ [celsius.id]: 1, [calendarProduct.id]: 2 }); // Celsius: 1 January is outside its 365 days; the calendar product keeps it
    expect(status.totalApplications).toBe(4); // calendar-year total: all four rows
  });

  test('late December, ordinary year: both kinds count what they should and the totals are the calendar year', async () => {
    jest.setSystemTime(new Date('2026-12-15T17:00:00Z'));
    const customerId = await lawnWith(celsius, ['2025-12-20', '2026-03-01']);
    await lawnRows(customerId, calendarProduct, ['2025-12-20', '2026-03-01']);
    const status = await applicationLimits.getPropertyComplianceStatus(customerId);
    const byId = Object.fromEntries(status.products.map((p) => [p.productId, p.applicationsThisYear]));
    expect(byId).toEqual({ [celsius.id]: 2, [calendarProduct.id]: 1 });
    expect(status.totalApplications).toBe(2);
  });

  test('getProductLimits on 31 December of a leap year: the calendar-year product counts 1 January, Celsius does not', async () => {
    jest.setSystemTime(new Date('2028-12-31T17:00:00Z'));
    const customerId = await lawnWith(calendarProduct, ['2028-01-01', '2028-06-01']);
    await lawnRows(customerId, celsius, ['2028-01-01', '2028-06-01']);
    expect(await countRow(customerId, calendarProduct.id)).toMatchObject({ currentUsage: 2, status: 'exceeded' });
    expect(await countRow(customerId, celsius.id)).toMatchObject({ currentUsage: 1 });
  });

  test('gate off: the stored row and the calendar year (nothing counted on 12 January)', async () => {
    delete process.env.GATE_LAWN_V13;
    resetV13CapIdentity();
    const customerId = await lawnWith(celsius, ['2025-12-05', '2025-12-20']);
    expect(await countRow(customerId, celsius.id)).toMatchObject({ currentUsage: 0, status: 'ok' });
  });
});
