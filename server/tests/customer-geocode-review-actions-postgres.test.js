/** Private QA database only; each synthetic schema rolls back after its test. */
jest.setTimeout(20000);
let mockConnection;
jest.mock('../models/db', () => {
  const proxy = (...args) => mockConnection(...args);
  for (const method of ['raw', 'transaction']) proxy[method] = (...args) => mockConnection[method](...args);
  return proxy;
});
jest.mock('../services/geocoder', () => ({
  buildAddress: () => 'synthetic address', clearGeocodeMemo: jest.fn(), ensureCustomerGeocoded: jest.fn(),
}));
jest.mock('../services/scheduling/quality-after-change', () => ({
  refreshScheduleQualityAfterChange: jest.fn().mockResolvedValue({ status: 'checked' }),
}));
jest.mock('../services/appointment-address', () => ({
  ...jest.requireActual('../services/appointment-address'), refreshAppointmentAddressBriefs: jest.fn().mockResolvedValue(),
}));
const knex = require('knex');
const { randomUUID } = require('node:crypto');
const createActionSchema = require('./fixtures/customer-geocode-review-actions-postgres');
const { CUSTOMER_ID, PRIMARY_ID, ACTOR_ID, ADDRESS, CORRECTED, seedLocation, visitRow } = require('./fixtures/customer-geocode-review-visits-postgres');
const reviewStore = require('../services/customer-geocode-review');
const { addressKey } = require('../services/customer-properties');
const { resolveCustomerGeocodeReview } = require('../services/customer-geocode-review-actions');
const PIN = { latitude: 27.4981235, longitude: -82.5748125 };
const connection = process.env.SERVICE_GEOCODE_TEST_DATABASE_URL;

(connection ? describe : describe.skip)('staff geocode decisions in PostgreSQL', () => {
  let database;
  let visitId;
  const previousGate = process.env.GATE_GEOCODE_REVIEW;
  beforeAll(() => {
    const url = new URL(connection);
    if (!/^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname) || url.search || url.hash) throw new Error('Private QA database required');
    database = knex({ client: 'pg', connection, pool: { min: 0, max: 1 } });
    process.env.GATE_GEOCODE_REVIEW = 'true';
  });
  afterAll(async () => {
    if (previousGate === undefined) delete process.env.GATE_GEOCODE_REVIEW;
    else process.env.GATE_GEOCODE_REVIEW = previousGate;
    await database?.destroy();
  });
  beforeEach(async () => {
    mockConnection = await database.transaction();
    const schema = `geocode_decisions_${randomUUID().replaceAll('-', '')}`;
    await mockConnection.raw('CREATE SCHEMA ??', [schema]);
    await mockConnection.raw('SET LOCAL search_path TO ??, public', [schema]);
    await createActionSchema(mockConnection);
    await seedLocation(mockConnection, { customerPin: {}, propertyPin: {}, propertyAddress: ADDRESS });
    await mockConnection('customers').where({ id: CUSTOMER_ID }).update({ first_name: 'Synthetic' });
    visitId = randomUUID();
    await mockConnection('scheduled_services').insert(visitRow(visitId, { property_id: PRIMARY_ID }));
  });
  afterEach(async () => { await mockConnection?.rollback(); });
  const customer = () => mockConnection('customers').where({ id: CUSTOMER_ID }).first();
  const primary = () => mockConnection('customer_properties').where({ customer_id: CUSTOMER_ID, active: true, is_primary: true }).first();
  const review = () => mockConnection('customer_geocode_reviews').where({ customer_id: CUSTOMER_ID }).first();
  const visit = () => mockConnection('scheduled_services').where({ id: visitId }).first();
  const audits = () => mockConnection('audit_log').orderBy('id');
  async function act(overrides = {}) {
    return resolveCustomerGeocodeReview(CUSTOMER_ID, {
      revision: (await reviewStore.getReviewDetail(CUSTOMER_ID, mockConnection)).revision,
      action: 'verify_pin', ...PIN, confirmed: true, source: 'site_visit', evidence: 'Synthetic observation', ...overrides,
    }, ACTOR_ID, mockConnection);
  }

  test('address corrections allowlist fields, preserve omitted units, and explicit clears remain revocable', async () => {
    const withUnit = { ...ADDRESS, address_line2: 'Unit 7' };
    await mockConnection('customers').update({ address_line2: withUnit.address_line2 });
    await mockConnection('customer_properties').update({ address_line2: withUnit.address_line2, address_key: addressKey(withUnit) });
    const { address_line2: _unit, ...withoutUnit } = CORRECTED;
    await act({ address: { ...withoutUnit, first_name: 'Overwrite', deleted_at: new Date() } });
    expect(await customer()).toMatchObject({ first_name: 'Synthetic', deleted_at: null, ...withoutUnit, address_line2: 'Unit 7' });
    expect(await primary()).toMatchObject({ ...withoutUnit, address_line2: 'Unit 7' });
    await act({ address: { address_line2: '' } });
    await act({ action: 'revoke' });
    expect(await customer()).toMatchObject({ address_line2: null, latitude: null, longitude: null });
    expect(await primary()).toMatchObject({ address_line2: null, latitude: null, longitude: null });
    expect(await review()).toMatchObject({ status: 'needs_pin', evidence: 'Synthetic observation' });
  });

  test.each(['unchanged', 'corrected', 'first address'])('lazy primary creation preserves eligible visits for %s', async scenario => {
    await mockConnection('customer_properties').where({ id: PRIMARY_ID }).del();
    await mockConnection('scheduled_services').update({ property_id: null });
    if (scenario === 'first address') await mockConnection('customers').update({
      address_line1: null, address_line2: null, city: null, state: null, zip: null,
    });
    const address = scenario === 'corrected' ? CORRECTED : ADDRESS;
    await act({ address });
    const saved = await primary();
    expect(saved).toMatchObject({ ...address, source: 'backfill' });
    expect(Number(saved.latitude)).toBe(PIN.latitude);
    expect(await visit()).toMatchObject({ property_id: saved.id, service_address_line1: address.address_line1 });
    expect((await audits()).map(row => row.action)).toEqual(['customer_geocode_review.verify_pin']);
  });

  test.each([false, true])('duplicate existing address returns a specific conflict with lazy primary=%s', async lazy => {
    if (lazy) await mockConnection('customer_properties').where({ id: PRIMARY_ID }).del();
    await mockConnection('customer_properties').insert({
      id: randomUUID(), customer_id: CUSTOMER_ID, active: true, is_primary: false,
      ...CORRECTED, address_key: addressKey(CORRECTED),
    });
    await expect(act({ address: CORRECTED })).rejects.toMatchObject({
      statusCode: 409, code: 'address_matches_existing_property', isOperational: true,
    });
    expect(await customer()).toMatchObject({ ...ADDRESS, latitude: null });
    expect(await review()).toBeUndefined();
    expect(await audits()).toEqual([]);
  });

  test.each([false, true])('lazy primary and the entire grouped visit commit together, issued link=%s', async frozen => {
    const groupId = randomUUID();
    await mockConnection('customer_properties').where({ id: PRIMARY_ID }).del();
    await mockConnection('service_visits').insert({
      id: groupId, customer_id: CUSTOMER_ID, property_id: null, status: 'open',
      scheduled_date: '2099-10-01', stop_base_key: `${CUSTOMER_ID}:2099-10-01`, stop_seq: 1,
      summary_token_issued_at: frozen ? new Date() : null,
    });
    await mockConnection('scheduled_services').update({ property_id: null, visit_id: groupId });
    await mockConnection('scheduled_services').insert(visitRow(randomUUID(), { visit_id: groupId }));
    if (frozen) {
      await expect(act({ address: CORRECTED })).rejects.toMatchObject({ statusCode: 409, reason: 'link_issued' });
      expect(await primary()).toBeUndefined();
      expect(await review()).toBeUndefined();
      expect(await audits()).toEqual([]);
      expect((await visit()).property_id).toBeNull();
      expect((await customer()).address_line1).toBe(ADDRESS.address_line1);
    } else {
      await act({ address: CORRECTED });
      const saved = await primary();
      expect(await mockConnection('scheduled_services').where({ visit_id: groupId }).pluck('property_id')).toEqual([saved.id, saved.id]);
      expect(await mockConnection('service_visits').where({ id: groupId }).first()).toMatchObject({
        property_id: saved.id, stop_base_key: `${saved.id}:2099-10-01`,
      });
      expect((await audits()).map(row => row.action)).toEqual(['appointment_address_changed', 'customer_geocode_review.verify_pin']);
    }
  });

  test.each([
    [{ confirmed: false }, 'confirmation_required'], [{ source: 'google' }, 'review_evidence_required'],
    [{ evidence: ' ' }, 'review_evidence_required'], [{ latitude: 10 }, 'invalid_verified_pin'],
    [{ address: { address_line1: '' } }, 'incomplete_service_address'],
    [{ action: 'outside_service_area', source: 'google' }, 'review_evidence_required'],
    [{ action: 'revoke' }, 'review_pin_missing'],
  ])('invalid decision %j cannot write review state', async (input, code) => {
    await expect(act(input)).rejects.toMatchObject({ code });
    expect(await review()).toBeUndefined();
    expect(await audits()).toEqual([]);
    expect((await customer()).latitude).toBeNull();
  });

  test('outside-area decisions preserve the rejected legacy pin as evidence and clear its live mirrors', async () => {
    await mockConnection('customers').update(PIN);
    await mockConnection('customer_properties').update(PIN);
    await mockConnection('scheduled_services').update({ lat: PIN.latitude, lng: PIN.longitude, route_order: 7 });
    await act({ action: 'outside_service_area', source: 'county_records' });
    expect(await review()).toMatchObject({ status: 'outside_area', reviewed_by: ACTOR_ID, source: 'county_records' });
    expect(Number((await review()).latitude)).toBe(PIN.latitude);
    expect((await customer()).latitude).toBeNull();
    expect((await primary()).latitude).toBeNull();
    expect(await visit()).toMatchObject({ lat: null, lng: null, route_order: null });
  });

  test('stale revisions and a failed critical audit preserve the complete previously verified state', async () => {
    await act();
    const before = { customer: await customer(), primary: await primary(), review: await review(), visit: await visit(), audits: await audits() };
    await expect(act({ revision: 'stale' })).rejects.toMatchObject({ code: 'review_changed' });
    await mockConnection.raw("ALTER TABLE audit_log ADD CONSTRAINT reject_verify_audit CHECK (action <> 'customer_geocode_review.verify_pin') NOT VALID");
    await expect(act({ address: CORRECTED })).rejects.toThrow();
    expect({ customer: await customer(), primary: await primary(), review: await review(), visit: await visit(), audits: await audits() }).toEqual(before);
  });
});
