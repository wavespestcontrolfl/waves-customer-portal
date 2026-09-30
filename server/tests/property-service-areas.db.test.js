const { randomUUID } = require('crypto');
const knexFactory = require('knex');
const { etDateString } = require('../utils/datetime-et');
const migration = require('../models/migrations/20260927010000_property_service_areas');
jest.mock('../routes/property-lookup-v2', () => ({ performPropertyLookup: jest.fn(async () => null) }));
const lookup = require('../routes/property-lookup-v2').performPropertyLookup;
const areas = require('../services/property-service-areas');
const describeDb = process.env.DATABASE_URL ? describe : describe.skip;
jest.setTimeout(30000);

// Synthetic rows in an owned schema. No customer rows or public sequences are
// used, and the actual migration, assignment predicate, locks and audit run.
describeDb('reviewed property service areas in PostgreSQL', () => {
  let knex; let schema; let admin; let tech; let customerId; let primary; let second; let visit;
  beforeAll(async () => {
    schema = `service_areas_${randomUUID().replaceAll('-', '')}`;
    knex = knexFactory({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 4 } });
    await knex.raw('CREATE SCHEMA ??', [schema]);
    await knex.schema.createTable('customers', t => {
      t.uuid('id').primary(); t.string('address_line1'); t.string('address_line2'); t.string('city'); t.string('zip');
      t.integer('bed_sqft'); t.integer('property_sqft'); t.timestamp('updated_at');
    });
    await knex.schema.createTable('customer_properties', t => {
      t.uuid('id').primary(); t.uuid('customer_id').references('id').inTable('customers');
      t.boolean('active').defaultTo(true); t.boolean('is_primary').defaultTo(false);
      for (const key of ['address_line1','address_line2','city','state','zip']) t.string(key);
      t.integer('bed_sqft'); t.integer('property_sqft'); t.timestamp('updated_at');
    });
    await knex.schema.createTable('scheduled_services', t => {
      t.uuid('id').primary(); t.uuid('customer_id').references('id').inTable('customers'); t.uuid('property_id').references('id').inTable('customer_properties');
      t.uuid('technician_id'); t.string('status').defaultTo('scheduled'); t.date('scheduled_date'); t.string('service_type');
      for (const key of ['service_address_line1','service_address_line2','service_address_city','service_address_zip']) t.string(key);
    });
    await knex.schema.createTable('property_preferences', t => { t.uuid('customer_id').primary(); t.timestamp('irrigation_home_changed_at'); });
    await knex.schema.createTable('customer_turf_profiles', t => { t.uuid('customer_id').primary(); t.integer('lawn_sqft'); t.string('grass_type'); t.timestamp('updated_at'); });
    await knex.schema.createTable('audit_log', t => {
      t.increments('id'); t.string('actor_type'); t.uuid('actor_id'); t.string('action'); t.string('resource_type'); t.uuid('resource_id');
      t.jsonb('metadata'); t.string('ip_address'); t.string('user_agent');
    });
    await migration.up(knex); await migration.up(knex);
  }, 30000);
  afterAll(async () => { if (knex) { await knex.raw('DROP SCHEMA ?? CASCADE', [schema]); await knex.destroy(); } });
  beforeEach(async () => {
    process.env.GATE_PROPERTY_SERVICE_AREAS = 'true'; lookup.mockReset().mockResolvedValue(null);
    customerId = randomUUID(); admin = { techRole: 'admin', technicianId: randomUUID() }; tech = { techRole: 'technician', technicianId: randomUUID() };
    await knex('customers').insert({ id: customerId, address_line1: '100 Fixture Street', city: 'Fixture City', zip: '34201', bed_sqft: 900 });
    [primary] = await knex('customer_properties').insert({ id: randomUUID(), customer_id: customerId, address_line1: '100 Fixture Street', city: 'Fixture City', zip: '34201', is_primary: true, bed_sqft: 900 }).returning('*');
    [second] = await knex('customer_properties').insert({ id: randomUUID(), customer_id: customerId, address_line1: '200 Fixture Street', city: 'Fixture City', zip: '34201' }).returning('*');
    [visit] = await knex('scheduled_services').insert({ id: randomUUID(), customer_id: customerId, property_id: primary.id, technician_id: tech.technicianId, scheduled_date: etDateString(), service_type: 'Tree & Shrub Care' }).returning('*');
  });
  afterEach(() => { delete process.env.GATE_PROPERTY_SERVICE_AREAS; });
  // The shared refresh cooldown has its own Postgres suite; here every refresh is granted.
  const read = (scope, actor = admin, options = {}) => areas.readAreaMeasurements(scope, actor, { knex, claimRefresh: async () => true, ...options });
  const save = (scope, version, changes, actor = admin) => areas.saveAreaMeasurements(scope, actor, { version, areas: changes }, { knex });
  const scope = () => ({ customerId, propertyId: primary.id });

  test('works without an estimate; preserves estimate provenance and saves only reviewed areas', async () => {
    lookup.mockResolvedValue({ enriched: { estimatedBedAreaSf: 1200, estimatedTurfSf: 4000, turfSource: 'vision' } });
    const first = await read(scope());
    expect(first.areas.beds).toMatchObject({ sqft: 900, source: 'recorded', reviewedAt: null });
    expect(first.areas.lawn).toMatchObject({ sqft: 4000, source: 'imagery', reviewedAt: null });
    const result = await save(scope(), first.version, { beds: { sqft: 1100, source: 'imagery', reviewedBy: 'spoof' } });
    expect(result.areas.beds).toMatchObject({ sqft: 1100, source: 'imagery', reviewedBy: admin.technicianId, reviewedAt: expect.any(String) });
    expect(result.areas.lawn.reviewedAt).toBeNull();
    expect((await knex('customers').where({ id: customerId }).first()).bed_sqft).toBe(1100);
    const audit = await knex('audit_log').where({ resource_id: primary.id }).first();
    expect(audit.metadata.after.beds.sqft).toBe(1100);
    expect(audit.metadata.after.lawn).toBeUndefined();
    const refreshed = await read(scope(), admin, { refresh: true });
    expect(refreshed.areas.beds).toEqual(result.areas.beds);
    expect(lookup).toHaveBeenLastCalledWith(expect.stringContaining('100 Fixture Street'), { refresh: true });
  });
  test('secondary areas never overwrite primary mirrors or borrow the primary turf profile', async () => {
    await knex('customer_turf_profiles').insert({ customer_id: customerId, lawn_sqft: 4200 });
    const target = { customerId, propertyId: second.id };
    const first = await read(target);
    expect(first.areas.lawn).toBeNull();
    const result = await save(target, first.version, { beds: { sqft: 300, source: 'field' }, lawn: { sqft: 1200, source: 'field' }, mosquito: { sqft: 700, source: 'field' } });
    expect(result.areas.mosquito.sqft).toBe(700);
    expect((await knex('customer_turf_profiles').where({ customer_id: customerId }).first()).lawn_sqft).toBe(4200);
    expect((await knex('customers').where({ id: customerId }).first()).bed_sqft).toBe(900);
    expect((await knex('customers').where({ id: customerId }).first()).property_sqft).toBeNull();
    expect((await knex('customer_properties').where({ id: second.id }).first()).property_sqft).toBe(1200);
  });
  test.each([0, 4800])('reviewed primary lawn mirrors the same area everywhere (%s)', async sqft => {
    const result = await save(scope(), (await read(scope())).version, { lawn: { sqft, source: 'field' } });
    expect(result.areas.lawn.sqft).toBe(sqft);
    expect((await knex('customer_properties').where({ id: primary.id }).first()).property_sqft).toBe(sqft);
    expect((await knex('customers').where({ id: customerId }).first()).property_sqft).toBe(sqft);
    expect((await knex('customer_turf_profiles').where({ customer_id: customerId }).first()).lawn_sqft).toBe(sqft);
  });
  test('a legacy turf edit invalidates an unreviewed value loaded in the shared editor', async () => {
    await knex('customer_turf_profiles').insert({ customer_id: customerId, lawn_sqft: 4000 });
    const first = await read(scope());
    expect(first.areas.lawn).toMatchObject({ sqft: 4000, reviewedAt: null });
    await knex('customer_turf_profiles').where({ customer_id: customerId }).update({ lawn_sqft: 4500 });
    await expect(save(scope(), first.version, { lawn: { sqft: 4000, source: 'recorded' } })).rejects.toMatchObject({ status: 409 });
    expect((await read(scope())).areas.lawn.sqft).toBe(4500);
    await expect(areas.snapshotVisitArea({ propertyId: primary.id, version: first.version, kind: 'beds', treatedSqft: 400 }, visit, tech, knex)).rejects.toMatchObject({ status: 409 });
  });
  test('concurrent saves reject stale versions instead of losing a correction', async () => {
    const first = await read(scope());
    const results = await Promise.allSettled([500, 600].map(sqft => save(scope(), first.version, { beds: { sqft, source: 'field' } })));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(r => r.status === 'rejected').reason.status).toBe(409);
  });
  test('checks assignment, completion, active property and customer ownership', async () => {
    const target = { serviceId: visit.id };
    const first = await read(target, tech);
    await expect(read({ customerId, propertyId: primary.id }, tech)).rejects.toMatchObject({ status: 404 });
    await expect(read({ customerId: randomUUID(), propertyId: primary.id })).rejects.toMatchObject({ status: 404 });
    await knex('scheduled_services').where({ id: visit.id }).update({ technician_id: randomUUID() });
    await expect(save(target, first.version, { beds: { sqft: 100, source: 'field' } }, tech)).rejects.toMatchObject({ status: 404 });
    await knex('scheduled_services').where({ id: visit.id }).update({ technician_id: tech.technicianId, status: 'completed' });
    await expect(save(target, first.version, { beds: { sqft: 100, source: 'field' } }, tech)).rejects.toMatchObject({ status: 403 });
    await knex('customer_properties').where({ id: primary.id }).update({ active: false });
    await expect(read(scope())).rejects.toMatchObject({ status: 404 });
  });
  test('does not adopt a primary property for an ambiguous unstamped visit', async () => {
    await knex('scheduled_services').where({ id: visit.id }).update({ property_id: null });
    await expect(read({ serviceId: visit.id }, tech)).rejects.toMatchObject({ status: 409 });
  });
  test('lookup cannot return an old property after reassignment or address correction', async () => {
    const result = read({ serviceId: visit.id }, tech, { refresh: true, lookup: async () => {
      await knex('scheduled_services').where({ id: visit.id }).update({ property_id: second.id });
      return { enriched: { estimatedBedAreaSf: 9000 } };
    } });
    await expect(result).rejects.toMatchObject({ status: 409 });
  });
  test('freezes partial coverage without altering the property, rejects the wrong kind/property', async () => {
    const first = await read(scope());
    const saved = await save(scope(), first.version, { beds: { sqft: 1200, source: 'field' } });
    const snapshot = await areas.snapshotVisitArea({ propertyId: primary.id, version: saved.version, kind: 'beds', treatedSqft: 450 }, visit, tech, knex);
    expect(snapshot).toMatchObject({ propertyId: primary.id, kind: 'beds', treatedSqft: 450, propertyAreaSqft: 1200, measurementSource: 'field' });
    expect((await read(scope())).areas.beds.sqft).toBe(1200);
    await expect(areas.snapshotVisitArea({ propertyId: primary.id, version: first.version, kind: 'beds', treatedSqft: 450 }, visit, tech, knex)).rejects.toMatchObject({ status: 409 });
    await expect(areas.snapshotVisitArea({ propertyId: second.id, kind: 'beds', treatedSqft: 450 }, visit, tech, knex)).rejects.toMatchObject({ status: 409 });
    await expect(areas.snapshotVisitArea({ propertyId: primary.id, kind: 'lawn', treatedSqft: 450 }, visit, tech, knex)).rejects.toMatchObject({ status: 400 });
  });
  test('an address change withdraws its old review and invalidates a stale save', async () => {
    const first = await read(scope());
    const saved = await save(scope(), first.version, { beds: { sqft: 500, source: 'field' } });
    await knex('customer_properties').where({ id: primary.id }).update({ address_line1: '300 New Fixture Street' });
    const moved = await read(scope());
    expect(moved.areas.beds.reviewedAt).toBeNull();
    await expect(save(scope(), saved.version, { beds: { sqft: 700, source: 'field' } })).rejects.toMatchObject({ status: 409 });
  });
  test('cache outage keeps saved data readable and review save succeeds', async () => {
    lookup.mockRejectedValue(new Error('fixture cache unavailable'));
    const first = await read(scope());
    expect((await save(scope(), first.version, { beds: { sqft: 0, source: 'field' } })).areas.beds.sqft).toBe(0);
  });
  test('legacy turf edits succeed while dark and withdraw only a changed primary lawn review', async () => {
    const first = await read(scope());
    await save(scope(), first.version, { lawn: { sqft: 4000, source: 'field' }, beds: { sqft: 900, source: 'field' } });
    const secondaryScope = { customerId, propertyId: second.id };
    await save(secondaryScope, (await read(secondaryScope)).version, { lawn: { sqft: 1200, source: 'field' } });
    delete process.env.GATE_PROPERTY_SERVICE_AREAS;
    let handler;
    jest.isolateModules(() => {
      jest.doMock('../models/db', () => knex);
      const router = require('../routes/admin-customer-turf-profile');
      handler = router.stack.find(layer => layer.route?.methods.put).route.stack.at(-1).handle;
    });
    jest.dontMock('../models/db');
    const res = { json: jest.fn() };
    const write = lawn_sqft => handler({ ...admin, params: { customerId }, body: { lawn_sqft } }, res, err => { throw err; });
    await write('4000');
    expect((await knex('customer_properties').where({ id: primary.id }).first()).service_area_measurements.areas.lawn.sqft).toBe(4000);
    await write(4500);
    expect(res.json).toHaveBeenLastCalledWith({ profile: expect.objectContaining({ lawn_sqft: 4500 }) });
    const saved = (await knex('customer_properties').where({ id: primary.id }).first()).service_area_measurements.areas;
    expect(saved.lawn).toBeUndefined();
    expect(saved.beds.sqft).toBe(900);
    // The mirrors the withdrawn review had set follow the legacy amount.
    expect((await knex('customer_properties').where({ id: primary.id }).first()).property_sqft).toBe(4500);
    expect((await knex('customers').where({ id: customerId }).first()).property_sqft).toBe(4500);
    expect((await knex('customer_properties').where({ id: second.id }).first()).property_sqft).toBe(1200);
    expect((await knex('customer_properties').where({ id: second.id }).first()).service_area_measurements.areas.lawn.sqft).toBe(1200);
  });
  test('rolls back the property and mirrors if the required audit fails', async () => {
    const first = await read(scope());
    await knex.schema.renameTable('audit_log', 'audit_log_saved');
    try { await expect(save(scope(), first.version, { beds: { sqft: 100, source: 'field' } })).rejects.toThrow(); }
    finally { await knex.schema.renameTable('audit_log_saved', 'audit_log'); }
    expect((await knex('customer_properties').where({ id: primary.id }).first()).bed_sqft).toBe(900);
    expect((await knex('customers').where({ id: customerId }).first()).bed_sqft).toBe(900);
  });
  test('migration down/up is repeatable on the owned schema', async () => {
    await migration.down(knex); await migration.down(knex);
    expect(await knex.schema.hasColumn('customer_properties', 'service_area_measurements')).toBe(false);
    await migration.up(knex);
    expect(await knex.schema.hasColumn('customer_properties', 'service_area_measurements')).toBe(true);
  });
});
