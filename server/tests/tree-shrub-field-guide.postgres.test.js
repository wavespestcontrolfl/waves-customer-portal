// Real PostgreSQL migration/prefill verification; all fixtures roll back.
jest.setTimeout(90000);
const { randomUUID } = require('crypto');
const url = process.env.TS_FIELD_TEST_DATABASE_URL;
const managed = url && process.env.WAVES_LOCAL_DEV === '1' && process.env.WAVES_WORKTREE_ID && url === process.env.DATABASE_URL &&
  new URL(url).pathname === `/waves_qa_${process.env.WAVES_WORKTREE_ID.replaceAll('-', '')}`;
const ci = url && process.env.CI === 'true' && url === process.env.DATABASE_URL &&
  ['localhost', '127.0.0.1'].includes(new URL(url).hostname) && new URL(url).pathname === '/waves_test';
if (url && !managed && !ci) throw new Error('T&S verification requires this worktree’s private QA database or isolated CI.');
const suite = managed || ci ? describe : describe.skip;

suite('T&S equipment and protocol defaults on PostgreSQL', () => {
  let db;
  const migration = require('../models/migrations/20260927020000_tree_shrub_owned_equipment');
  const { resolveCompletionProductDefaults } = require('../services/completion-product-defaults');
  beforeAll(() => { db = require('knex')({ client: 'pg', connection: url, pool: { min: 0, max: 2 } }); });
  afterAll(async () => { await db?.destroy(); await require('../models/db').destroy(); });
  afterEach(() => { delete process.env.GATE_TREE_SHRUB_FIELD_GUIDE; });
  async function rollback(run) {
    const trx = await db.transaction();
    try { await run(trx); } finally { await trx.rollback(); }
  }
  async function fixture(trx, month = '01') {
    const customerId = randomUUID(), propertyId = randomUUID(), serviceId = randomUUID();
    await trx('customers').insert({ id: customerId, first_name: 'Synthetic T&S QA', phone: `qa-${customerId.slice(0, 8)}` });
    await trx('customer_properties').insert({ id: propertyId, customer_id: customerId, address_line1: '100 Synthetic Lane', is_primary: true });
    await trx('scheduled_services').insert({ id: serviceId, customer_id: customerId, property_id: propertyId,
      service_type: 'Tree & Shrub Care', scheduled_date: `2028-${month}-01`, status: 'confirmed' });
    let snapshot = await trx('products_catalog').where({ name: 'Snapshot 2.5TG', active: true }).first('id');
    if (!snapshot) [snapshot] = await trx('products_catalog').insert({ name: 'Snapshot 2.5TG', active: true,
      category: 'herbicide', active_ingredient: 'Isoxaben + trifluralin', epa_reg_number: '62719-175', formulation: 'granular', rate_unit: 'lb', default_rate_per_1000: 2.3 }).returning('id');
    return { customerId, propertyId, serviceId, snapshotId: snapshot.id };
  }
  test('migration preserves edited assets, adds no guessed purchase data, and keeps bag costs pending', () => rollback(async trx => {
    await migration.up(trx);
    const asset = await trx('equipment').where({ model: 'N124-S' }).first();
    expect(asset.specs).toMatchObject({ tank_capacity_gal: 1, part_number: '11003500' });
    expect(asset.purchase_price).toBeNull();
    expect(asset.serial_number).toBeNull();
    await trx('equipment').where({ id: asset.id }).update({ notes: 'Synthetic admin edit', status: 'maintenance' });
    await migration.up(trx);
    expect(await trx('equipment').where({ id: asset.id }).first()).toMatchObject({ notes: 'Synthetic admin edit', status: 'maintenance' });
    expect(await trx('equipment').where({ model: 'N124-S' })).toHaveLength(1);
    const bag = await trx('products_catalog').whereILike('name', '%#511542%').first();
    expect(bag).toMatchObject({ needs_pricing: true, best_price: null, cost_per_unit: null, default_rate_per_1000: null });
    await migration.down(trx);
    expect(await trx('equipment').where({ id: asset.id }).first()).toBeTruthy();
  }));
  test('the same appointment yields no defaults while dark, then only routine identities with no manufactured quantities', () => rollback(async trx => {
    const f = await fixture(trx);
    expect((await resolveCompletionProductDefaults({ db: trx, serviceId: f.serviceId })).products).toEqual([]);
    process.env.GATE_TREE_SHRUB_FIELD_GUIDE = 'true';
    const result = await resolveCompletionProductDefaults({ db: trx, serviceId: f.serviceId });
    expect(result.error).toBeUndefined();
    expect(result.products.map(row => row.treeShrubKey)).toEqual(['snapshot', 'f8012']);
    expect(result.products.every(row => row.requiresDoseSelection && row.protocolAmount == null)).toBe(true);
    expect(await trx('property_application_history').where({ customer_id: f.customerId })).toHaveLength(0);
  }));
  test('property-scoped closeout history suppresses recent Snapshot; a retracted application does not', () => rollback(async trx => {
    const f = await fixture(trx, '07');
    const pastVisit = randomUUID(), record = randomUUID(), ledger = randomUUID();
    await trx('scheduled_services').insert({ id: pastVisit, customer_id: f.customerId, property_id: f.propertyId,
      service_type: 'Tree & Shrub Care', scheduled_date: '2028-06-15', status: 'completed' });
    await trx('service_records').insert({ id: record, customer_id: f.customerId, scheduled_service_id: pastVisit,
      service_type: 'Tree & Shrub Care', service_date: '2028-06-15', status: 'completed' });
    await trx('property_application_history').insert({ id: ledger, customer_id: f.customerId, product_id: f.snapshotId,
      service_record_id: record, application_date: '2028-06-15', application_rate: 2.3, rate_unit: 'lb' });
    process.env.GATE_TREE_SHRUB_FIELD_GUIDE = 'true';
    const read = () => resolveCompletionProductDefaults({ db: trx, serviceId: f.serviceId });
    const blocked = await read();
    expect(blocked.error).toBeUndefined();
    expect(blocked.products.map(row => row.treeShrubKey)).toEqual(['f0016']);
    expect(blocked.holds[0].reason).toMatch(/60 days/);
    await trx('property_application_history').where({ id: ledger }).update({ retracted_at: trx.fn.now() });
    expect((await read()).products.map(row => row.treeShrubKey)).toEqual(['snapshot', 'f0016']);
  }));
  test('an unavailable ledger fails closed instead of treating history as empty', () => rollback(async trx => {
    const f = await fixture(trx);
    process.env.GATE_TREE_SHRUB_FIELD_GUIDE = 'true';
    await trx.schema.renameTable('property_application_history', 'qa_unavailable_history');
    const result = await resolveCompletionProductDefaults({ db: trx, serviceId: f.serviceId });
    expect(result.products).toEqual([]);
    expect(result.error).toBeTruthy();
  }));
});
