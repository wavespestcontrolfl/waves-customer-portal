// The compliance view judges a shared active-ingredient yearly amount (annual_max_rate, match_type 'active_ingredient') per lawn,
// and the lawns include one whose property row was deleted: property_application_history.property_id has no foreign key, so its id
// survives on the ledger. Runs on the migrated test database with synthetic rows (a unique ingredient key), removed afterwards.
const { randomUUID } = require('crypto');
const { etDateString } = require('../utils/datetime-et');
const db = require('../models/db');
const ComplianceService = require('../services/compliance');
const { fixture } = require('./helpers/lawn-history-db');

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

describeDb('compliance: ingredient cap lawns', () => {
  const key = `fixtureai${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const made = { customers: [], records: [], products: [], other: [], limits: [] };
  let product;
  let limit;

  // One customer: a current property, and ledger rows at the current lawn (through its visit) and at a deleted lawn (a bare id).
  async function customer({ current = 1, deleted = 1, product: forProduct = product } = {}) {
    const f = await fixture(db);
    made.customers.push(f.customerId);
    const deletedId = randomUUID();
    const today = etDateString();
    for (let index = 0; index < current; index += 1) {
      const [visit] = await db('scheduled_services').insert({ customer_id: f.customerId, property_id: f.property.id, scheduled_date: today, service_type: 'Lawn fixture' }).returning('*');
      const [record] = await db('service_records').insert({ customer_id: f.customerId, scheduled_service_id: visit.id, service_date: today, service_type: 'Lawn fixture' }).returning('*');
      made.records.push(record.id);
      await db('property_application_history').insert({ customer_id: f.customerId, product_id: forProduct.id, application_date: today, application_rate: 2, rate_unit: 'lb', service_record_id: record.id });
    }
    for (let index = 0; index < deleted; index += 1) {
      await db('property_application_history').insert({ customer_id: f.customerId, product_id: forProduct.id, application_date: today, application_rate: 2, rate_unit: 'lb', property_id: deletedId });
    }
    return { customerId: f.customerId, propertyId: f.property.id, deletedId };
  }
  const row = async (customerId) => (await ComplianceService.getProductLimits(customerId)).limits.find((l) => l.limitId === limit.id);

  beforeAll(async () => {
    [product] = await db('products_catalog').insert({ name: `Ingredient cap fixture ${key}`, category: 'insecticide', active_ingredient: `${key} 6.2%`, active: true }).returning('*');
    made.products.push(product.id);
    [limit] = await db('product_limits').insert({
      product_id: product.id, match_type: 'active_ingredient', match_value: key, limit_type: 'annual_max_rate', limit_value: 3, limit_unit: 'lb/1000sf/year', severity: 'hard_block', description: 'fixture',
    }).returning('*');
    made.limits.push(limit.id);
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

  test('the lawn list is the current properties plus the ledger lawns of the ingredient this year, sorted, once each', async () => {
    const c = await customer({ current: 1, deleted: 2 });
    const other = await customer({ current: 0, deleted: 1 });
    const scopes = await ComplianceService.lawnScopesFor(c.customerId, `${etDateString().slice(0, 4)}-01-01`, [key]);
    expect(scopes).toEqual([c.propertyId, c.deletedId].sort());
    // Another ingredient's key finds the current property only.
    expect(await ComplianceService.lawnScopesFor(c.customerId, `${etDateString().slice(0, 4)}-01-01`, ['noingredientlikethis'])).toEqual([c.propertyId]);
    expect(await ComplianceService.lawnScopesFor(other.customerId, `${etDateString().slice(0, 4)}-01-01`, [key])).toEqual([other.propertyId, other.deletedId].sort());
  });

  test('a deleted lawn is judged on its own: 2 lb at each of two lawns is under the 3 lb cap, not 4 lb merged', async () => {
    const c = await customer({ current: 1, deleted: 1 });
    expect(await row(c.customerId)).toMatchObject({ status: 'ok' });
  });

  test('the deleted lawn can be the one over the cap', async () => {
    const c = await customer({ current: 1, deleted: 2 });
    expect(await row(c.customerId)).toMatchObject({ status: 'exceeded' });
  });
});
