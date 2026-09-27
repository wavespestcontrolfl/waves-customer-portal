/** Real PostgreSQL regression for review-decision vs enrichment lock ordering. */
let mockConnection;
jest.mock('../models/db', () => {
  const proxy = (...args) => mockConnection(...args);
  for (const method of ['raw', 'transaction']) proxy[method] = (...args) => mockConnection[method](...args);
  return proxy;
});

const knex = require('knex');
const { randomUUID } = require('node:crypto');
const review = require('../services/customer-geocode-review');
const { _private: { withReviewWriteFence } } = require('../services/call-property-lookup');

const connection = process.env.SERVICE_GEOCODE_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;

postgres('geocode review enrichment serialization in PostgreSQL', () => {
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
    schema = `geocode_enrichment_${randomUUID().replaceAll('-', '')}`;
    await admin.raw('CREATE SCHEMA ??', [schema]);
    mockConnection = knex({ client: 'pg', connection, searchPath: [schema, 'public'], pool: { min: 0, max: 4 } });
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
    await mockConnection('customers').insert({ id: customerId, ...address, address_line2: '', latitude: 27.5, longitude: -82.5 });
    await mockConnection('customer_properties').insert({
      id: propertyId, customer_id: customerId, active: true, is_primary: true, ...address, address_line2: null,
      latitude: 27.5, longitude: -82.5,
    });
    await mockConnection('scheduled_services').insert({
      id: visitId, customer_id: customerId, property_id: propertyId, lat: 27.5, lng: -82.5,
    });
  });

  afterEach(async () => {
    await mockConnection('customer_geocode_reviews').del();
    await mockConnection('scheduled_services').del();
    await mockConnection('customer_properties').del();
    await mockConnection('customers').del();
  });

  test('an enrichment started behind a held outside-area decision cannot restore its pin', async () => {
    let releaseDecision;
    let decisionLocked;
    const locked = new Promise(resolve => { decisionLocked = resolve; });
    const release = new Promise(resolve => { releaseDecision = resolve; });
    const decision = mockConnection.transaction(async (trx) => {
      const customer = await trx('customers').where({ id: customerId }).forUpdate().first();
      await trx('customer_properties').where({ id: propertyId }).forUpdate().first();
      await review.saveReview(trx, customer, {
        status: 'outside_area', reason: 'staff_confirmed_outside_area', reviewed_by: randomUUID(),
      });
      await trx('customer_properties').where({ id: propertyId }).update({ latitude: null, longitude: null });
      await trx('customers').where({ id: customerId }).update({ latitude: null, longitude: null });
      await trx('scheduled_services').where({ id: visitId }).update({ lat: null, lng: null });
      decisionLocked();
      await release;
    });
    await locked;

    let enrichmentSettled = false;
    const enrichment = withReviewWriteFence({ propertyId, customerId }, async (conn) => {
      const attempts = [];
      for (const [table, where, values] of [
        ['customer_properties', { id: propertyId }, { latitude: 27.6, longitude: -82.4 }],
        ['customers', { id: customerId }, { latitude: 27.6, longitude: -82.4 }],
        ['scheduled_services', { id: visitId }, { lat: 27.6, lng: -82.4 }],
      ]) {
        let update = conn(table).where(where);
        update = review.excludePrimaryPropertyReviewForId(update, propertyId);
        attempts.push(await update.update(values));
      }
      return attempts;
    }).finally(() => { enrichmentSettled = true; });
    await new Promise(resolve => setImmediate(resolve));
    expect(enrichmentSettled).toBe(false);
    releaseDecision();
    await decision;
    expect(await enrichment).toEqual([0, 0, 0]);
    expect(await mockConnection('customer_properties').where({ id: propertyId }).first()).toMatchObject({
      latitude: null, longitude: null,
    });
    expect(await mockConnection('customers').where({ id: customerId }).first()).toMatchObject({
      latitude: null, longitude: null,
    });
    expect(await mockConnection('scheduled_services').where({ id: visitId }).first()).toMatchObject({
      lat: null, lng: null,
    });
  });
});
