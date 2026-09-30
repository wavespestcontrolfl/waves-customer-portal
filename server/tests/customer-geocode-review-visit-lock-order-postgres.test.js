/** Real PostgreSQL regression: withReviewWriteFence guards background enrichment
 * writes, so it never WAITS for a lock a staff transaction holds. Any lock order a
 * staff path uses (the annual-prepay switch: visit, customer, then the rest of its
 * series; a staff geocode decision: prefs advisory lock, customer, then visits)
 * therefore cannot form a deadlock cycle with it: the fence backs off with
 * review_fence_busy, and the staff transaction always completes. */
let mockConnection;
jest.mock('../models/db', () => {
  const proxy = (...args) => mockConnection(...args);
  for (const method of ['raw', 'transaction']) proxy[method] = (...args) => mockConnection[method](...args);
  return proxy;
});

const knex = require('knex');
const { randomUUID } = require('node:crypto');
const { _private: { withReviewWriteFence } } = require('../services/call-property-lookup');

const connection = process.env.SERVICE_GEOCODE_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;

postgres('geocode enrichment visit-then-customer lock order', () => {
  let admin;
  let schema;
  let customerId;
  let propertyId;
  let visitId;
  const previousGate = process.env.GATE_GEOCODE_REVIEW;

  beforeAll(async () => {
    const url = new URL(connection);
    if (!/^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname) || url.search || url.hash) throw new Error('Private QA database required');
    process.env.GATE_GEOCODE_REVIEW = 'true';
    admin = knex({ client: 'pg', connection, pool: { min: 0, max: 2 } });
    schema = `geocode_lock_order_${randomUUID().replaceAll('-', '')}`;
    await admin.raw('CREATE SCHEMA ??', [schema]);
    mockConnection = knex({
      client: 'pg', connection: { connectionString: connection, application_name: 'geocode-lock-order' },
      searchPath: [schema, 'public'], pool: { min: 0, max: 4 },
    });
    await mockConnection.schema.createTable('customers', (t) => {
      t.uuid('id').primary();
      for (const field of ['address_line1', 'address_line2', 'city', 'state', 'zip']) t.string(field);
      t.decimal('latitude', 10, 7); t.decimal('longitude', 10, 7);
    });
    await mockConnection.schema.createTable('customer_properties', (t) => {
      t.uuid('id').primary(); t.uuid('customer_id'); t.boolean('active'); t.boolean('is_primary');
      for (const field of ['address_line1', 'address_line2', 'city', 'state', 'zip']) t.string(field);
      t.decimal('latitude', 10, 7); t.decimal('longitude', 10, 7);
    });
    await mockConnection.schema.createTable('customer_geocode_reviews', (t) => {
      t.uuid('customer_id').primary(); t.jsonb('address_snapshot'); t.string('status'); t.string('reason');
      t.string('source'); t.text('evidence'); t.uuid('reviewed_by'); t.timestamp('reviewed_at', { useTz: true });
      t.decimal('latitude', 10, 7); t.decimal('longitude', 10, 7); t.timestamp('updated_at', { useTz: true });
    });
    await mockConnection.schema.createTable('scheduled_services', (t) => {
      t.uuid('id').primary(); t.uuid('customer_id'); t.uuid('property_id');
      t.decimal('lat', 10, 7); t.decimal('lng', 10, 7);
    });
  });

  afterAll(async () => {
    await mockConnection?.destroy();
    if (schema) await admin.raw('DROP SCHEMA ?? CASCADE', [schema]);
    await admin?.destroy();
    if (previousGate === undefined) delete process.env.GATE_GEOCODE_REVIEW;
    else process.env.GATE_GEOCODE_REVIEW = previousGate;
  });

  beforeEach(async () => {
    customerId = randomUUID();
    propertyId = randomUUID();
    visitId = randomUUID();
    const address = { address_line1: '100 Fixture Way', city: 'Bradenton', state: 'FL', zip: '34205' };
    await mockConnection('customers').insert({ id: customerId, ...address, latitude: 27.5, longitude: -82.5 });
    await mockConnection('customer_properties').insert({
      id: propertyId, customer_id: customerId, active: true, is_primary: true, ...address,
      latitude: 27.5, longitude: -82.5,
    });
    await mockConnection('scheduled_services').insert({
      id: visitId, customer_id: customerId, property_id: propertyId, lat: null, lng: null,
    });
  });

  afterEach(async () => {
    await mockConnection('customer_geocode_reviews').del();
    await mockConnection('scheduled_services').del();
    await mockConnection('customer_properties').del();
    await mockConnection('customers').del();
  });

  const isBusy = err => ['review_fence_busy', '55P03'].includes(err?.code);
  const fenceWrite = (visitIds, values = { lat: 27.6, lng: -82.4 }) => withReviewWriteFence(
    { propertyId, customerId, visitIds },
    async conn => conn('scheduled_services').whereIn('id', visitIds).update(values),
  );

  // Runs `hold` in a staff-shaped transaction, tries the fence while it holds its
  // first locks, then lets it finish the rest of its lock sequence.
  async function againstHolder(hold, finish, visitIds) {
    let held;
    let release;
    const holding = new Promise(resolve => { held = resolve; });
    const released = new Promise(resolve => { release = resolve; });
    const holder = mockConnection.transaction(async (trx) => {
      await hold(trx);
      held();
      await released;
      await finish(trx);
    });
    await holding;
    const fence = await fenceWrite(visitIds).then(value => ({ value }), error => ({ error }));
    release();
    // No deadlock: the staff transaction completes its whole sequence.
    await expect(holder).resolves.toBeUndefined();
    return fence;
  }

  test('the annual-prepay switch order (visit, then customer) makes the fence back off, never wait', async () => {
    const fence = await againstHolder(
      trx => trx('scheduled_services').where({ id: visitId }).forUpdate().first('id'),
      trx => trx('customers').where({ id: customerId }).forUpdate().first('id'),
      [visitId],
    );
    expect(isBusy(fence.error)).toBe(true);
    expect((await mockConnection('scheduled_services').where({ id: visitId }).first()).lat).toBeNull();
    // Once the switch commits, the retry writes.
    await expect(fenceWrite([visitId])).resolves.toBe(1);
  });

  test('a staff geocode decision (prefs lock, customer, then visits) makes the fence back off', async () => {
    const fence = await againstHolder(
      async (trx) => {
        await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
          ['property-preferences', String(customerId)]);
        await trx('customers').where({ id: customerId }).forUpdate().first('id');
      },
      trx => trx('scheduled_services').where({ id: visitId }).forUpdate().first('id'),
      [visitId],
    );
    expect(isBusy(fence.error)).toBe(true);
    await expect(fenceWrite([visitId])).resolves.toBe(1);
  });

  test('the prepay series sweep (target, customer, then an earlier sibling) cannot trap a fence holding the sibling', async () => {
    // Fixed ids: the sibling sorts BEFORE the target, so the fence's ordered
    // scan reaches the free sibling first and only then meets the held target.
    const siblingId = '00000000-0000-4000-8000-000000000001';
    const targetId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    await mockConnection('scheduled_services').insert([
      { id: targetId, customer_id: customerId, property_id: propertyId, lat: null, lng: null },
      { id: siblingId, customer_id: customerId, property_id: propertyId, lat: null, lng: null },
    ]);
    const fence = await againstHolder(
      async (trx) => {
        await trx('scheduled_services').where({ id: targetId }).forUpdate().first('id');
        await trx('customers').where({ id: customerId }).forUpdate().first('id');
      },
      // Mirrors admin-schedule.js locking the rest of the series after the customer.
      trx => trx('scheduled_services').where({ id: siblingId }).forUpdate().first('id'),
      [targetId, siblingId],
    );
    expect(isBusy(fence.error)).toBe(true);
    // The busy fence rolled back its sibling lock and wrote nothing.
    expect(await mockConnection('scheduled_services').whereIn('id', [siblingId, targetId]).whereNotNull('lat'))
      .toEqual([]);
    await expect(fenceWrite([targetId, siblingId])).resolves.toBe(2);
  });

  test('an uncontended fence locks and writes as before', async () => {
    await expect(fenceWrite([visitId])).resolves.toBe(1);
    const visit = await mockConnection('scheduled_services').where({ id: visitId }).first();
    expect(Number(visit.lat)).toBeCloseTo(27.6);
    expect(Number(visit.lng)).toBeCloseTo(-82.4);
  });
});
