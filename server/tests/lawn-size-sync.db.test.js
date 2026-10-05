const { randomUUID } = require('crypto');
const knexFactory = require('knex');
const migration = require('../models/migrations/20260927010000_property_service_areas');
// The customer fence takes the customers row lock and a property-preferences
// advisory lock; here the owned transaction is the whole contract under test.
jest.mock('../services/customer-pricing-ai', () => ({
  withTurfProfileFence: async (db, customerId, work) => db.transaction(async (trx) => {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))', ['property-preferences', String(customerId)]);
    await trx('customers').where({ id: customerId }).forUpdate().first('id');
    return work(trx);
  }),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const sync = require('../services/lawn-size-sync');
const script = require('../scripts/backfill-lawn-sqft-from-estimate');
// CI's DB-gated runner discovers suites by this exact SKIP line.
const SKIP = !process.env.DATABASE_URL;
const describeDb = SKIP ? describe.skip : describe;
jest.setTimeout(30000);

const lawnData = (sqft, basis = 'measuredTurfSf') => ({
  result: { recurring: { services: [{ name: 'Lawn Care', service: 'lawn_care', monthly: 60 }] } },
  engineResult: { lineItems: [{ service: 'lawn_care', lawnSqFt: sqft, turfBasis: basis, turfEstimated: basis !== 'measuredTurfSf' }] },
});

// Synthetic rows in an owned schema: no customer rows or public sequences.
describeDb('lawn size from the estimate (real PostgreSQL)', () => {
  let knex; let schema; let customerId; let primary; let reviewedAt;
  beforeAll(async () => {
    schema = `lawn_size_${randomUUID().replaceAll('-', '')}`;
    knex = knexFactory({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 4 } });
    await knex.raw('CREATE SCHEMA ??', [schema]);
    await knex.schema.createTable('customers', t => {
      t.uuid('id').primary(); t.string('address_line1'); t.string('address_line2'); t.string('city'); t.string('zip');
      t.integer('bed_sqft'); t.integer('property_sqft'); t.timestamp('updated_at'); t.string('state');
      t.timestamp('deleted_at'); t.boolean('active').defaultTo(true); t.string('pipeline_stage').defaultTo('active_customer');
    });
    await knex.schema.createTable('customer_properties', t => {
      t.string('address_key'); t.decimal('latitude', 10, 7); t.decimal('longitude', 10, 7);
      t.uuid('id').primary(); t.uuid('customer_id').references('id').inTable('customers');
      t.boolean('active').defaultTo(true); t.boolean('is_primary').defaultTo(false);
      for (const key of ['address_line1', 'address_line2', 'city', 'state', 'zip']) t.string(key);
      t.integer('bed_sqft'); t.integer('property_sqft'); t.timestamp('updated_at');
      t.uuid('neighborhood_id'); t.string('neighborhood_source'); t.string('county_subdivision'); t.timestamp('neighborhood_checked_at');
    });
    await knex.schema.createTable('scheduled_services', t => {
      t.uuid('id').primary(); t.uuid('customer_id').references('id').inTable('customers'); t.uuid('property_id').references('id').inTable('customer_properties');
      t.uuid('technician_id'); t.string('status').defaultTo('scheduled'); t.date('scheduled_date'); t.string('service_type');
      for (const key of ['service_address_line1', 'service_address_line2', 'service_address_city', 'service_address_zip']) t.string(key);
      t.uuid('source_estimate_id'); t.uuid('recurring_parent_id'); t.boolean('is_recurring'); t.boolean('is_callback'); t.boolean('followup_included');
      t.string('service_category_snapshot'); t.uuid('service_id');
    });
    await knex.schema.createTable('services', t => { t.uuid('id').primary(); t.string('category'); });
    await knex.schema.createTable('property_preferences', t => { t.uuid('customer_id').primary(); t.timestamp('irrigation_home_changed_at'); });
    await knex.schema.createTable('customer_turf_profiles', t => { t.uuid('customer_id').primary(); t.integer('lawn_sqft'); t.string('grass_type'); t.boolean('active').defaultTo(true); t.timestamp('updated_at'); });
    await knex.schema.createTable('estimates', t => {
      t.uuid('id').primary(); t.uuid('customer_id'); t.uuid('property_id'); t.string('address'); t.string('status');
      t.timestamp('accepted_at'); t.jsonb('estimate_data');
    });
    await knex.schema.createTable('audit_log', t => {
      t.increments('id'); t.string('actor_type'); t.uuid('actor_id'); t.string('action'); t.string('resource_type'); t.uuid('resource_id');
      t.jsonb('metadata'); t.string('ip_address'); t.string('user_agent');
    });
    await migration.up(knex);
    // audit-log.js writes through the trx it is handed; its module-level pool is never used.
  }, 30000);
  afterAll(async () => { if (knex) { await knex.raw('DROP SCHEMA ?? CASCADE', [schema]); await knex.destroy(); } });

  beforeEach(async () => {
    customerId = randomUUID();
    reviewedAt = '2026-09-01T00:00:00.000Z';
    await knex('customers').insert({ id: customerId, address_line1: '100 Fixture Street', city: 'Fixture City', zip: '34201', property_sqft: 3000 });
    [primary] = await knex('customer_properties').insert({
      id: randomUUID(), customer_id: customerId, address_line1: '100 Fixture Street', city: 'Fixture City', zip: '34201',
      is_primary: true, property_sqft: 3500,
    }).returning('*');
    await knex('customer_properties').where({ id: primary.id }).update({
      service_area_measurements: { addressKey: 'x', areas: { lawn: { sqft: 3500, source: 'field', reviewedAt, reviewedBy: 't1' }, beds: { sqft: 900, source: 'field', reviewedAt, reviewedBy: 't1' } } },
    });
    await knex('customer_turf_profiles').insert({ customer_id: customerId, lawn_sqft: 4000, grass_type: 'st_augustine' });
  });

  const estimateRow = (over = {}) => ({
    id: randomUUID(), customer_id: customerId, property_id: null, address: '100 Fixture Street, Fixture City, FL 34201',
    status: 'accepted', accepted_at: '2026-10-01T00:00:00Z', estimate_data: lawnData(5200), ...over,
  });
  const state = async () => ({
    turf: (await knex('customer_turf_profiles').where({ customer_id: customerId }).first()),
    customer: (await knex('customers').where({ id: customerId }).first()),
    property: (await knex('customer_properties').where({ id: primary.id }).first()),
  });

  test('acceptance write: the estimate wins in all three places, the lawn review stamp goes, one audit row with before/after', async () => {
    const estimate = estimateRow();
    await knex('estimates').insert(estimate);
    const out = await sync.applyEstimateLawnSqft(knex, { customerId, estimate, estimateData: estimate.estimate_data });
    expect(out.status).toBe('written');
    const s = await state();
    expect(s.turf.lawn_sqft).toBe(5200);
    expect(s.turf.grass_type).toBe('st_augustine');
    expect(s.customer.property_sqft).toBe(5200);
    expect(s.property.property_sqft).toBe(5200);
    expect(s.property.service_area_measurements.areas.lawn).toBeUndefined();
    expect(s.property.service_area_measurements.areas.beds.sqft).toBe(900);
    const audits = await knex('audit_log').where({ resource_id: customerId });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: 'customer.lawn_sqft.set_from_estimate', actor_type: 'system' });
    expect(audits[0].metadata).toMatchObject({
      estimate_id: estimate.id, sqft: 5200, trigger: 'acceptance',
      before: { turf_lawn_sqft: 4000, primary_property_sqft: 3500, customer_property_sqft: 3000 },
      after: { turf_lawn_sqft: 5200, primary_property_sqft: 5200, customer_property_sqft: 5200 },
    });
  });

  test('a second run is a no-op with no second audit row', async () => {
    const estimate = estimateRow();
    await sync.applyEstimateLawnSqft(knex, { customerId, estimate, estimateData: estimate.estimate_data });
    const again = await sync.applyEstimateLawnSqft(knex, { customerId, estimate, estimateData: estimate.estimate_data });
    expect(again.status).toBe('unchanged');
    expect(await knex('audit_log').where({ resource_id: customerId })).toHaveLength(1);
  });

  test('an AI estimate or another property writes nothing', async () => {
    const ai = estimateRow({ estimate_data: lawnData(5200, 'estimatedTurfSf') });
    const other = estimateRow({ address: '9 Elsewhere Road, Fixture City, FL 34201' });
    expect((await sync.applyEstimateLawnSqft(knex, { customerId, estimate: ai, estimateData: ai.estimate_data })).reason).toBe('unconfirmed_estimate');
    expect((await sync.applyEstimateLawnSqft(knex, { customerId, estimate: other, estimateData: other.estimate_data })).reason).toBe('other_property');
    const s = await state();
    expect([s.turf.lawn_sqft, s.customer.property_sqft, s.property.property_sqft]).toEqual([4000, 3000, 3500]);
    expect(await knex('audit_log').where({ resource_id: customerId })).toHaveLength(0);
  });

  test('a failed audit write rolls the size back (size and audit row commit together)', async () => {
    const estimate = estimateRow();
    await knex.raw('ALTER TABLE audit_log ADD CONSTRAINT audit_no_lawn CHECK (action <> \'customer.lawn_sqft.set_from_estimate\') NOT VALID');
    try {
      await expect(sync.applyEstimateLawnSqft(knex, { customerId, estimate, estimateData: estimate.estimate_data })).rejects.toThrow();
    } finally {
      await knex.raw('ALTER TABLE audit_log DROP CONSTRAINT audit_no_lawn');
    }
    const s = await state();
    expect([s.turf.lawn_sqft, s.customer.property_sqft, s.property.property_sqft]).toEqual([4000, 3000, 3500]);
  });

  test('a first profile is inserted; an estimate with no turf row still sets the mirrors', async () => {
    await knex('customer_turf_profiles').where({ customer_id: customerId }).del();
    const estimate = estimateRow();
    const out = await sync.applyEstimateLawnSqft(knex, { customerId, estimate, estimateData: estimate.estimate_data });
    expect(out.before.turf_lawn_sqft).toBeNull();
    expect((await state()).turf.lawn_sqft).toBe(5200);
  });

  test('backfill apply end to end: real loaders, only the differing customer is written, audit says backfill', async () => {
    const estimate = estimateRow();
    await knex('estimates').insert(estimate);
    const stubLoad = async () => [{ customer_id: customerId, estimate_ids: [estimate.id] }];
    const dry = await script.runBackfill({ knex, today: '2026-10-04' }, { loadLawnCustomers: stubLoad });
    expect(dry.rows).toHaveLength(1);
    expect(dry.rows[0]).toMatchObject({ class: 'differs', confirmed_sqft: 5200, turf_lawn_sqft: 4000, primary_property_sqft: 3500, customer_property_sqft: 3000, pct_diff: 30 });
    expect((await state()).turf.lawn_sqft).toBe(4000);
    const applied = await script.runBackfill({ knex, today: '2026-10-04', apply: true }, { loadLawnCustomers: stubLoad });
    expect(applied.applied).toEqual([expect.objectContaining({ customer_id: customerId, status: 'written', before_turf: 4000, after_turf: 5200 })]);
    expect((await state()).turf.lawn_sqft).toBe(5200);
    const audit = await knex('audit_log').where({ resource_id: customerId }).first();
    expect(audit.metadata.trigger).toBe('backfill');
    const rerun = await script.runBackfill({ knex, today: '2026-10-04', apply: true }, { loadLawnCustomers: stubLoad });
    expect(rerun.rows[0].class).toBe('same');
    expect(rerun.applied).toEqual([]);
  });
});

describeDb('mirror-only repair (real PostgreSQL)', () => {
  test('turf already matches the estimate but the mirrors do not: classified mirrors_differ, apply repairs only the mirrors', async () => {
    const schema = `lawn_size_m_${randomUUID().replaceAll('-', '')}`;
    const knex = knexFactory({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 2 } });
    try {
      await knex.raw('CREATE SCHEMA ??', [schema]);
      await knex.schema.createTable('customers', t => { t.uuid('id').primary(); for (const k of ['address_line1', 'address_line2', 'city', 'zip', 'state']) t.string(k); t.integer('bed_sqft'); t.integer('property_sqft'); t.timestamp('updated_at'); });
      await knex.schema.createTable('customer_properties', t => {
        t.uuid('id').primary(); t.uuid('customer_id'); t.boolean('active').defaultTo(true); t.boolean('is_primary').defaultTo(false);
        for (const k of ['address_line1', 'address_line2', 'city', 'state', 'zip']) t.string(k);
        t.integer('bed_sqft'); t.integer('property_sqft'); t.timestamp('updated_at'); t.jsonb('service_area_measurements');
      });
      await knex.schema.createTable('customer_turf_profiles', t => { t.uuid('customer_id').primary(); t.integer('lawn_sqft'); t.boolean('active').defaultTo(true); t.timestamp('updated_at'); });
      await knex.schema.createTable('estimates', t => { t.uuid('id').primary(); t.uuid('customer_id'); t.uuid('property_id'); t.string('address'); t.string('status'); t.timestamp('accepted_at'); t.jsonb('estimate_data'); });
      await knex.schema.createTable('audit_log', t => { t.increments('id'); t.string('actor_type'); t.uuid('actor_id'); t.string('action'); t.string('resource_type'); t.uuid('resource_id'); t.jsonb('metadata'); t.string('ip_address'); t.string('user_agent'); });
      const customerId = randomUUID();
      const addr = { address_line1: '100 Fixture Street', city: 'Fixture City', zip: '34201' };
      await knex('customers').insert({ id: customerId, ...addr, property_sqft: 3000 });
      await knex('customer_properties').insert({ id: randomUUID(), customer_id: customerId, ...addr, is_primary: true, property_sqft: 3500, service_area_measurements: {} });
      await knex('customer_turf_profiles').insert({ customer_id: customerId, lawn_sqft: 5200 });
      const estimate = { id: randomUUID(), customer_id: customerId, address: '100 Fixture Street, Fixture City, FL 34201', status: 'accepted', accepted_at: '2026-10-01T00:00:00Z', estimate_data: lawnData(5200) };
      await knex('estimates').insert(estimate);
      const stubLoad = async () => [{ customer_id: customerId, estimate_ids: [estimate.id] }];
      // The service-areas column is part of the mirror rule's gate.
      await knex.raw('ALTER TABLE customer_properties ADD COLUMN IF NOT EXISTS neighborhood_id uuid');
      const dry = await script.runBackfill({ knex, today: '2026-10-04' }, { loadLawnCustomers: stubLoad });
      expect(dry.rows[0]).toMatchObject({ class: 'mirrors_differ', turf_lawn_sqft: 5200, primary_property_sqft: 3500, customer_property_sqft: 3000 });
      const applied = await script.runBackfill({ knex, today: '2026-10-04', apply: true }, { loadLawnCustomers: stubLoad });
      expect(applied.applied).toEqual([expect.objectContaining({ status: 'written', before_property: 3500, after_property: 5200, before_customer: 3000, after_customer: 5200 })]);
      expect((await knex('customers').where({ id: customerId }).first()).property_sqft).toBe(5200);
      expect((await knex('customer_properties').where({ customer_id: customerId }).first()).property_sqft).toBe(5200);
      expect((await script.runBackfill({ knex, today: '2026-10-04' }, { loadLawnCustomers: stubLoad })).rows[0].class).toBe('same');
    } finally {
      await knex.raw('DROP SCHEMA ?? CASCADE', [schema]);
      await knex.destroy();
    }
  });
});

// The real candidate query (live recurring lawn visits -> customers + linked estimates).
describeDb('lawn customer candidate query (real PostgreSQL)', () => {
  let knex; let schema;
  beforeAll(async () => {
    schema = `lawn_size_q_${randomUUID().replaceAll('-', '')}`;
    knex = knexFactory({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 2 } });
    await knex.raw('CREATE SCHEMA ??', [schema]);
    await knex.schema.createTable('customers', t => { t.uuid('id').primary(); t.timestamp('deleted_at'); t.boolean('active').defaultTo(true); t.string('pipeline_stage').defaultTo('active_customer'); });
    await knex.schema.createTable('services', t => { t.uuid('id').primary(); t.string('category'); });
    await knex.schema.createTable('scheduled_services', t => {
      t.uuid('id').primary(); t.uuid('customer_id'); t.string('status'); t.date('scheduled_date'); t.string('service_type');
      t.uuid('source_estimate_id'); t.uuid('recurring_parent_id'); t.boolean('is_recurring'); t.boolean('is_callback'); t.boolean('followup_included');
      t.string('service_category_snapshot'); t.uuid('service_id');
    });
  });
  afterAll(async () => { if (knex) { await knex.raw('DROP SCHEMA ?? CASCADE', [schema]); await knex.destroy(); } });

  test('picks live recurring lawn customers, links the estimate from the row or its series parent', async () => {
    const [lawnA, lawnB, pestOnly, inactive, oneTime] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const [estA, estParent] = [randomUUID(), randomUUID()];
    await knex('customers').insert([{ id: lawnA }, { id: lawnB }, { id: pestOnly }, { id: inactive, active: false }, { id: oneTime }]);
    const parent = randomUUID();
    await knex('scheduled_services').insert([
      { id: randomUUID(), customer_id: lawnA, status: 'pending', scheduled_date: '2026-11-01', service_type: 'Lawn Care Service', is_recurring: true, source_estimate_id: estA },
      { id: parent, customer_id: lawnB, status: 'completed', scheduled_date: '2026-09-01', service_type: 'Lawn Care Service', is_recurring: true, source_estimate_id: estParent },
      { id: randomUUID(), customer_id: lawnB, status: 'confirmed', scheduled_date: '2026-11-05', service_type: 'Lawn Care Service', is_recurring: true, recurring_parent_id: parent },
      { id: randomUUID(), customer_id: pestOnly, status: 'pending', scheduled_date: '2026-11-01', service_type: 'Quarterly Pest Control', is_recurring: true },
      { id: randomUUID(), customer_id: inactive, status: 'pending', scheduled_date: '2026-11-01', service_type: 'Lawn Care Service', is_recurring: true },
      { id: randomUUID(), customer_id: oneTime, status: 'pending', scheduled_date: '2026-11-01', service_type: 'Lawn Care Service', is_recurring: false },
    ]);
    const rows = await script.loadLawnCustomers(knex, { today: '2026-10-04' });
    expect(rows.map((r) => r.customer_id).sort()).toEqual([lawnA, lawnB].sort());
    expect(rows.find((r) => r.customer_id === lawnA).estimate_ids).toEqual([estA]);
    expect(rows.find((r) => r.customer_id === lawnB).estimate_ids).toEqual([estParent]);
    expect((await script.loadLawnCustomers(knex, { today: '2026-10-04', only: lawnA })).map((r) => r.customer_id)).toEqual([lawnA]);
    expect(await script.loadLawnCustomers(knex, { today: '2026-10-04', limit: 1 })).toHaveLength(1);
  });
});
