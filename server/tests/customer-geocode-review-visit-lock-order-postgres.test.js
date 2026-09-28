/** Real PostgreSQL regression: withReviewWriteFence must lock a scheduled_services
 * visit BEFORE the customer row when the caller will write that visit, matching the
 * annual-prepay switch's order (admin-schedule.js: visit, then customer). Reversing
 * it opens an ABBA lock cycle against that switch and Postgres aborts one side. */
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

  test('a visit-then-customer holder (the annual-prepay switch order) never deadlocks against this fence', async () => {
    let visitLocked;
    let releaseHolder;
    const locked = new Promise(resolve => { visitLocked = resolve; });
    const release = new Promise(resolve => { releaseHolder = resolve; });
    // Mimics admin-schedule.js's annual-prepay switch transaction: lock the visit
    // (scheduled_services), THEN the customer.
    const holder = mockConnection.transaction(async (trx) => {
      await trx('scheduled_services').where({ id: visitId }).forUpdate().first('id');
      visitLocked();
      await release;
      await trx('customers').where({ id: customerId }).forUpdate().first('id');
    });
    await locked;

    let fenceSettled = false;
    const fence = withReviewWriteFence({ propertyId, customerId, visitIds: [visitId] }, async (conn) => (
      conn('scheduled_services').where({ id: visitId }).update({ lat: 27.6, lng: -82.4 })
    )).finally(() => { fenceSettled = true; });

    const deadline = Date.now() + 5000;
    let blocked = false;
    while (!blocked && Date.now() < deadline) {
      const waiting = await admin('pg_stat_activity')
        .where({ application_name: 'geocode-lock-order' })
        .where({ state: 'active', wait_event_type: 'Lock' })
        .count('* as count').first();
      blocked = Number(waiting?.count || 0) > 0;
      if (!blocked) await new Promise(resolve => setImmediate(resolve));
    }
    try {
      // The fence must be the one waiting — on the VISIT lock the holder already
      // has — not off acquiring the customer row out of order.
      expect(blocked).toBe(true);
      expect(fenceSettled).toBe(false);
    } finally {
      releaseHolder();
    }
    // No deadlock: both transactions complete; Postgres never has to abort one
    // to break an ABBA cycle (which would reject one of these with a 40P01 error).
    await expect(holder).resolves.toBeUndefined();
    await expect(fence).resolves.toBe(1);
    const visit = await mockConnection('scheduled_services').where({ id: visitId }).first();
    expect(Number(visit.lat)).toBeCloseTo(27.6);
    expect(Number(visit.lng)).toBeCloseTo(-82.4);
  });

  test('a multi-visit lock is acquired in ascending id order regardless of the caller\'s array order', async () => {
    // Fixed ids so the sort order is known independent of insertion order.
    // Inserted HIGH-then-LOW (reversed from id order): an unindexed/unordered
    // lock query returns Postgres's physical (heap/insertion) order here, so
    // this insertion order is what makes an unordered lock disagree with the
    // ascending convention below -- inserting ascending would happen to
    // "accidentally" match it and hide the bug this test exists to catch.
    const lowId = '00000000-0000-4000-8000-000000000001';
    const highId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    await mockConnection('scheduled_services').insert([
      { id: highId, customer_id: customerId, property_id: propertyId, lat: null, lng: null },
      { id: lowId, customer_id: customerId, property_id: propertyId, lat: null, lng: null },
    ]);

    let lowLocked;
    let releaseHolder;
    const locked = new Promise(resolve => { lowLocked = resolve; });
    const release = new Promise(resolve => { releaseHolder = resolve; });
    // Mimics prelockVisitContext's own ascending-id FOR UPDATE convention
    // (customer-geocode-review-visits.js: .orderBy('id').forUpdate()): lock
    // the LOW id, then the HIGH id.
    const holder = mockConnection.transaction(async (trx) => {
      await trx('scheduled_services').where({ id: lowId }).forUpdate().first('id');
      lowLocked();
      await release;
      await trx('scheduled_services').where({ id: highId }).forUpdate().first('id');
    });
    await locked;

    // Pass the ids in DESCENDING order. Without an explicit ORDER BY, a plain
    // `whereIn` locks rows in the order Postgres returns them for this
    // predicate shape, which follows the literal array order supplied here
    // (confirmed against this database) -- so an unordered fence would lock
    // HIGH (uncontested) then LOW, the reverse of the holder above, and
    // deadlock. With the fix, the fence always locks LOW then HIGH no matter
    // what order the caller's array is in, so it simply waits its turn.
    let fenceSettled = false;
    const fence = withReviewWriteFence({
      propertyId, customerId, visitIds: [highId, lowId],
    }, async (conn) => conn('scheduled_services').whereIn('id', [highId, lowId]).update({ lat: 1, lng: 1 }))
      .finally(() => { fenceSettled = true; });

    const deadline = Date.now() + 5000;
    let blocked = false;
    while (!blocked && Date.now() < deadline) {
      const waiting = await admin('pg_stat_activity')
        .where({ application_name: 'geocode-lock-order' })
        .where({ state: 'active', wait_event_type: 'Lock' })
        .count('* as count').first();
      blocked = Number(waiting?.count || 0) > 0;
      if (!blocked) await new Promise(resolve => setImmediate(resolve));
    }
    try {
      // The fence must be the one waiting on LOW (the holder's first lock),
      // not off holding HIGH while the holder waits on it.
      expect(blocked).toBe(true);
      expect(fenceSettled).toBe(false);
    } finally {
      releaseHolder();
    }
    await expect(holder).resolves.toBeUndefined();
    await expect(fence).resolves.toBe(2);
  });
});
