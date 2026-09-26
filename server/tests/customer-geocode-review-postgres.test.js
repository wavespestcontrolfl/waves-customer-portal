/** Real PostgreSQL: private QA database only, synthetic schema rolled back per test. */
let mockConnection;
jest.mock('../models/db', () => {
  const proxy = (...args) => mockConnection(...args);
  for (const method of ['raw', 'transaction']) proxy[method] = (...args) => mockConnection[method](...args);
  return proxy;
});
jest.mock('../services/geocoder', () => ({ buildAddress: c => [c.address_line1, c.city, c.state, c.zip].join(', '), geocodeAddressWithStatus: jest.fn() }));
const knex = require('knex');
const { randomUUID } = require('node:crypto');
const migration = require('../models/migrations/20260926000030_customer_geocode_reviews');
const { geocodeAddressWithStatus } = require('../services/geocoder');
const { saveReview, getReviewDetail, listReviewQueue, attemptReviewedGeocode, excludeReviewedAddresses } = require('../services/customer-geocode-review');
const { etDateString, addETDays } = require('../utils/datetime-et');
const connection = process.env.SERVICE_GEOCODE_TEST_DATABASE_URL;
const CUSTOMER = '71000000-0000-4000-8000-000000000001';
const ACTOR = '72000000-0000-4000-8000-000000000001';
const PIN = { lat: 27.4981, lng: -82.5748 };
const postgres = connection ? describe : describe.skip;

postgres('durable customer geocode review in PostgreSQL', () => {
  let database;
  const previousGate = process.env.GATE_GEOCODE_REVIEW;
  beforeAll(() => {
    const url = new URL(connection);
    if (!/^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname) || url.search || url.hash) throw new Error('A private QA database is required');
    database = knex({ client: 'pg', connection, pool: { min: 0, max: 1 } });
    process.env.GATE_GEOCODE_REVIEW = 'true';
  });
  afterAll(async () => {
    if (previousGate === undefined) delete process.env.GATE_GEOCODE_REVIEW; else process.env.GATE_GEOCODE_REVIEW = previousGate;
    await database?.destroy();
  });
  beforeEach(async () => {
    process.env.GATE_GEOCODE_REVIEW = 'true';
    mockConnection = await database.transaction();
    const schema = `geocode_${randomUUID().replaceAll('-', '')}`;
    await mockConnection.raw('CREATE SCHEMA ??', [schema]);
    await mockConnection.raw('SET LOCAL search_path TO ??, public', [schema]);
    await mockConnection.schema.createTable('customers', t => {
      t.uuid('id').primary(); t.string('first_name'); t.string('last_name');
      for (const field of ['address_line1', 'address_line2', 'city', 'state', 'zip']) t.string(field);
      t.decimal('latitude', 10, 7); t.decimal('longitude', 10, 7); t.timestamp('updated_at', { useTz: true }); t.timestamp('deleted_at', { useTz: true });
    });
    await mockConnection.schema.createTable('customer_properties', t => {
      t.uuid('customer_id'); t.boolean('is_primary'); t.boolean('active');
      t.decimal('latitude', 10, 7); t.decimal('longitude', 10, 7); t.timestamp('updated_at', { useTz: true });
    });
    await mockConnection.schema.createTable('scheduled_services', t => {
      t.uuid('id').primary(); t.uuid('customer_id'); t.string('status'); t.date('scheduled_date');
    });
    await migration.up(mockConnection);
    await mockConnection('customers').insert({ id: CUSTOMER, first_name: 'Synthetic', last_name: 'Fixture',
      address_line1: '100 Fixture Way', city: 'Bradenton', state: 'FL', zip: '34205' });
    await mockConnection('customer_properties').insert({ customer_id: CUSTOMER, is_primary: true, active: true });
    geocodeAddressWithStatus.mockReset().mockResolvedValue({ location: PIN, permanent: false });
  });
  afterEach(async () => { await mockConnection?.rollback(); });
  const customer = () => mockConnection('customers').where({ id: CUSTOMER }).first();
  const eligible = () => excludeReviewedAddresses(mockConnection('customers').whereNull('latitude')).select('id');
  async function verify() {
    await mockConnection('customers').where({ id: CUSTOMER }).update({ latitude: PIN.lat, longitude: PIN.lng });
    await saveReview(mockConnection, await customer(), { status: 'verified', reason: 'staff_verified', reviewed_by: ACTOR,
      source: 'county_records', evidence: 'Synthetic parcel check', latitude: PIN.lat, longitude: PIN.lng });
  }

  test('migration is reversible and idempotent without changing customer pins', async () => {
    await migration.up(mockConnection);
    await migration.down(mockConnection);
    expect(await mockConnection.schema.hasTable('customer_geocode_reviews')).toBe(false);
    expect((await customer()).latitude).toBeNull();
    await migration.up(mockConnection);
  });
  test('incomplete addresses persist a reason and wait for correction without a provider call', async () => {
    await mockConnection('customers').where({ id: CUSTOMER }).update({ city: null });
    expect(await attemptReviewedGeocode(CUSTOMER, mockConnection)).toBeNull();
    expect(geocodeAddressWithStatus).not.toHaveBeenCalled();
    expect((await getReviewDetail(CUSTOMER, mockConnection)).review.status).toBe('needs_details');
    expect(await eligible()).toEqual([]);
    await mockConnection('customers').where({ id: CUSTOMER }).update({ city: 'Bradenton' });
    expect(await eligible()).toHaveLength(1);
  });
  test('transient failures retry, successful recovery mirrors the primary property', async () => {
    const onCoordinatesCommitted = jest.fn();
    geocodeAddressWithStatus.mockResolvedValueOnce({ location: null, permanent: false, reason: 'provider_unavailable' });
    await attemptReviewedGeocode(CUSTOMER, mockConnection, { onCoordinatesCommitted });
    expect(onCoordinatesCommitted).not.toHaveBeenCalled();
    expect((await getReviewDetail(CUSTOMER, mockConnection)).review.status).toBe('provider_unavailable');
    expect(await eligible()).toHaveLength(1);
    expect(await attemptReviewedGeocode(CUSTOMER, mockConnection, { onCoordinatesCommitted })).toEqual(PIN);
    expect(onCoordinatesCommitted).toHaveBeenCalledTimes(1);
    await attemptReviewedGeocode(CUSTOMER, mockConnection, { onCoordinatesCommitted });
    await verify();
    await attemptReviewedGeocode(CUSTOMER, mockConnection, { onCoordinatesCommitted });
    expect(onCoordinatesCommitted).toHaveBeenCalledTimes(1);
    const primary = await mockConnection('customer_properties').first();
    expect(Number(primary.latitude)).toBe(PIN.lat);
    expect(Number(primary.longitude)).toBe(PIN.lng);
    expect((await listReviewQueue({}, mockConnection)).total).toBe(0);
  });
  test('provider outside-area results stay visible until staff confirms disposition', async () => {
    geocodeAddressWithStatus.mockResolvedValueOnce({ location: null, permanent: true, reason: 'outside_service_area' });
    await attemptReviewedGeocode(CUSTOMER, mockConnection);
    expect(await eligible()).toEqual([]);
    expect((await listReviewQueue({}, mockConnection)).total).toBe(1);
    await saveReview(mockConnection, await customer(), { status: 'outside_area', reason: 'staff_confirmed_outside_area', reviewed_by: ACTOR });
    expect((await listReviewQueue({}, mockConnection)).total).toBe(0);
  });
  test('a failed coordinate transaction rolls back mirrors and never schedules a refresh', async () => {
    const onCoordinatesCommitted = jest.fn();
    await mockConnection.raw("ALTER TABLE customer_geocode_reviews ADD CONSTRAINT reject_test CHECK (status <> 'geocoded')");
    await expect(attemptReviewedGeocode(CUSTOMER, mockConnection, { onCoordinatesCommitted })).rejects.toThrow();
    expect(onCoordinatesCommitted).not.toHaveBeenCalled();
    expect((await customer()).latitude).toBeNull();
    expect((await mockConnection('customer_properties').first()).latitude).toBeNull();
  });
  test('verified pins survive coordinate writers and no-op address saves even with the gate disabled', async () => {
    await verify();
    process.env.GATE_GEOCODE_REVIEW = 'false';
    await mockConnection('customers').where({ id: CUSTOMER }).update({ latitude: 27.6, longitude: -82.4, address_line1: '100 Fixture Way' });
    expect(Number((await customer()).latitude)).toBe(PIN.lat);
    expect((await getReviewDetail(CUSTOMER, mockConnection)).review.status).toBe('verified');
  });
  test.each(['address_line1', 'address_line2', 'city', 'state', 'zip'])('changing %s invalidates verification and does not silently re-geocode', async field => {
    await verify();
    await mockConnection('customers').where({ id: CUSTOMER }).update({ [field]: 'Changed' });
    expect((await getReviewDetail(CUSTOMER, mockConnection)).review.reason).toBe('address_changed');
    expect(await eligible()).toEqual([]);
    expect(await attemptReviewedGeocode(CUSTOMER, mockConnection)).toBeNull();
    expect(geocodeAddressWithStatus).not.toHaveBeenCalled();
    expect((await listReviewQueue({}, mockConnection)).total).toBe(1);
  });
  test('address moves retain the writer\'s replacement point and unit edits keep the building point', async () => {
    await verify();
    await mockConnection('customers').where({ id: CUSTOMER }).update({ address_line2: 'Unit 2' });
    expect(Number((await customer()).latitude)).toBe(PIN.lat);
    await saveReview(mockConnection, await customer(), { status: 'verified', reason: 'staff_verified', latitude: PIN.lat, longitude: PIN.lng });
    await mockConnection('customers').where({ id: CUSTOMER }).update({ address_line1: '200 Fixture Way', latitude: 27.6, longitude: -82.4 });
    await require('../services/customer-properties').syncPrimaryCoordsFromCustomer(CUSTOMER, mockConnection);
    expect(Number((await customer()).latitude)).toBe(27.6);
    expect(Number((await mockConnection('customer_properties').first()).latitude)).toBe(27.6);
    expect((await getReviewDetail(CUSTOMER, mockConnection)).review.reason).toBe('address_changed');
  });
  test('a provider result cannot overwrite a review completed while it was in flight', async () => {
    const onCoordinatesCommitted = jest.fn();
    geocodeAddressWithStatus.mockImplementationOnce(async () => {
      await verify();
      return { location: { lat: 27.6, lng: -82.4 }, permanent: false };
    });
    expect(await attemptReviewedGeocode(CUSTOMER, mockConnection, { onCoordinatesCommitted })).toBeNull();
    expect(onCoordinatesCommitted).not.toHaveBeenCalled();
    expect((await getReviewDetail(CUSTOMER, mockConnection)).review.status).toBe('verified');
    expect(Number((await customer()).latitude)).toBe(PIN.lat);
  });
  test('a concurrent address edit or gate kill prevents a provider write', async () => {
    geocodeAddressWithStatus.mockImplementationOnce(async () => {
      await mockConnection('customers').where({ id: CUSTOMER }).update({ address_line1: '200 Fixture Way' });
      return { location: PIN, permanent: false };
    });
    expect(await attemptReviewedGeocode(CUSTOMER, mockConnection)).toBeNull();
    expect((await customer()).latitude).toBeNull();
    geocodeAddressWithStatus.mockImplementationOnce(async () => {
      process.env.GATE_GEOCODE_REVIEW = 'false';
      return { location: PIN, permanent: false };
    });
    expect(await attemptReviewedGeocode(CUSTOMER, mockConnection)).toBeNull();
    expect((await customer()).latitude).toBeNull();
  });
  test('queue pagination prioritizes future visits and shares the detail revision', async () => {
    await saveReview(mockConnection, await customer(), { status: 'needs_pin', reason: 'partial_match' });
    const another = randomUUID();
    await mockConnection('customers').insert({ id: another, address_line1: '200 Fixture Way', city: 'Bradenton', state: 'FL', zip: '34205' });
    await mockConnection('scheduled_services').insert({ id: randomUUID(), customer_id: CUSTOMER, status: 'confirmed', scheduled_date: etDateString(addETDays(new Date(), 1)) });
    const page = await listReviewQueue({ limit: 1, offset: 0 }, mockConnection);
    expect(page.total).toBe(2);
    expect(page.records[0].customer.id).toBe(CUSTOMER);
    expect(page.records[0].revision).toBe((await getReviewDetail(CUSTOMER, mockConnection)).revision);
    expect((await listReviewQueue({ limit: 1, offset: 1 }, mockConnection)).records[0].customer.id).toBe(another);
  });
});
