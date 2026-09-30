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
jest.mock('../services/dispatch-assignment', () => ({
  emitDispatchJobUpdate: jest.fn(async ({ jobId, qualityDates }) => {
    qualityDates.add(`date-${jobId}`);
    return { id: jobId };
  }),
  flushDispatchQualityDates: jest.fn(async () => null),
}));
const knex = require('knex');
const { randomUUID } = require('node:crypto');
const createActionSchema = require('./fixtures/customer-geocode-review-actions-postgres');
const { CUSTOMER_ID, PRIMARY_ID, ACTOR_ID, TECH_ID, ADDRESS, CORRECTED, seedLocation, visitRow } = require('./fixtures/customer-geocode-review-visits-postgres');
const reviewStore = require('../services/customer-geocode-review');
const { addressKey } = require('../services/customer-properties');
const { resolveCustomerGeocodeReview } = require('../services/customer-geocode-review-actions');
const dispatch = require('../services/dispatch-assignment');
const { buildDispatchJobUpdatePayload } = jest.requireActual('../services/dispatch-assignment');
const { sweepUngeocodedServices } = require('../services/geocoder-service-locations');
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
    jest.clearAllMocks();
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

  test('outside-area clears the live primary pin, recurring template, and visits when the customer mirror is missing', async () => {
    const parentId = randomUUID();
    const independentId = randomUUID();
    await mockConnection('customer_properties').update(PIN);
    await mockConnection('scheduled_services').where({ id: visitId })
      .update({ lat: PIN.latitude, lng: PIN.longitude, route_order: 7 });
    await mockConnection('scheduled_services').insert([
      visitRow(parentId, {
        property_id: PRIMARY_ID, status: 'completed', is_recurring: true, recurring_ongoing: true,
        recurring_template_overrides: { appointment_address: {
          property_id: PRIMARY_ID,
          service_address_line1: ADDRESS.address_line1,
          service_address_line2: ADDRESS.address_line2,
          service_address_city: ADDRESS.city,
          service_address_state: ADDRESS.state,
          service_address_zip: ADDRESS.zip,
          lat: PIN.latitude, lng: PIN.longitude, zone: 'legacy',
        } },
      }),
      visitRow(independentId, { property_id: null, lat: 27.4, lng: -82.4, route_order: 8 }),
    ]);

    await act({ action: 'outside_service_area', source: 'county_records' });

    expect(await review()).toMatchObject({ status: 'outside_area', latitude: String(PIN.latitude), longitude: String(PIN.longitude) });
    expect((await customer()).latitude).toBeNull();
    expect((await primary()).latitude).toBeNull();
    expect(await visit()).toMatchObject({ lat: null, lng: null, route_order: null });
    expect(require('../services/booking/visit-financial-stamps')
      .recurringServiceAddress(await mockConnection('scheduled_services').where({ id: parentId }).first()))
      .toMatchObject({ lat: null, lng: null, zone: null });
    expect(await mockConnection('scheduled_services').where({ id: independentId }).first()).toMatchObject({
      lat: '27.400000', lng: '-82.400000', route_order: 8,
    });
  });

  test('outside-area chooses the live primary pin over stale customer and review mirrors', async () => {
    const staleCustomerPin = { latitude: 27.41, longitude: -82.41 };
    const staleReviewPin = { latitude: 27.42, longitude: -82.42 };
    const legacyVisitId = randomUUID();
    const legacyParentId = randomUUID();
    await mockConnection('customers').update(staleCustomerPin);
    await mockConnection('customer_properties').update(PIN);
    await mockConnection('scheduled_services').update({ lat: PIN.latitude, lng: PIN.longitude, route_order: 6 });
    await mockConnection('scheduled_services').insert([
      visitRow(legacyVisitId, {
        property_id: null, lat: staleCustomerPin.latitude, lng: staleCustomerPin.longitude, route_order: 7,
      }),
      visitRow(legacyParentId, {
        property_id: null, status: 'completed', is_recurring: true, recurring_ongoing: true,
        recurring_template_overrides: { appointment_address: {
          property_id: null,
          service_address_line1: ADDRESS.address_line1,
          service_address_line2: ADDRESS.address_line2,
          service_address_city: ADDRESS.city,
          service_address_state: ADDRESS.state,
          service_address_zip: ADDRESS.zip,
          lat: staleCustomerPin.latitude, lng: staleCustomerPin.longitude, zone: 'legacy',
        } },
      }),
    ]);
    await reviewStore.saveReview(mockConnection, await customer(), {
      status: 'needs_pin', reason: 'pin_changed', source: 'county_records', evidence: 'Stale fixture evidence',
      ...staleReviewPin,
    });

    await act({ action: 'outside_service_area', source: 'county_records' });

    expect(Number((await review()).latitude)).toBe(PIN.latitude);
    expect((await customer()).latitude).toBeNull();
    expect((await customer()).longitude).toBeNull();
    expect((await primary()).latitude).toBeNull();
    expect(await visit()).toMatchObject({ lat: null, lng: null, route_order: null });
    expect(await mockConnection('scheduled_services').where({ id: legacyVisitId }).first())
      .toMatchObject({ lat: null, lng: null, route_order: null });
    expect(require('../services/booking/visit-financial-stamps')
      .recurringServiceAddress(await mockConnection('scheduled_services').where({ id: legacyParentId }).first()))
      .toMatchObject({ lat: null, lng: null, zone: null });
    await expect(buildDispatchJobUpdatePayload(visitId, ACTOR_ID)).resolves.toMatchObject({
      lat: null, lng: null,
    });
  });

  test('outside-area does not bind a previous address review pin to the current address', async () => {
    await reviewStore.saveReview(mockConnection, await customer(), {
      status: 'needs_pin', reason: 'pin_changed', source: 'county_records', evidence: 'Previous address evidence',
      ...PIN,
    });
    await mockConnection('customers').update({ ...CORRECTED, latitude: null, longitude: null });
    await mockConnection('customer_properties').update({
      ...CORRECTED, address_key: addressKey(CORRECTED), latitude: null, longitude: null,
    });
    await mockConnection('scheduled_services').update({ lat: PIN.latitude, lng: PIN.longitude, route_order: 6 });

    await act({ action: 'outside_service_area', source: 'county_records' });

    expect(await review()).toMatchObject({ status: 'outside_area', latitude: null, longitude: null });
    expect((await review()).address_snapshot).toEqual([
      CORRECTED.address_line1, CORRECTED.address_line2, CORRECTED.city, CORRECTED.state, CORRECTED.zip,
    ]);
    expect(await visit()).toMatchObject({ lat: null, lng: null, route_order: null });

    const priorRouteGate = process.env.GATE_ROUTE_REORDER;
    const priorRepairGate = process.env.GATE_ROUTE_REORDER_REPAIR;
    process.env.GATE_ROUTE_REORDER = 'true';
    process.env.GATE_ROUTE_REORDER_REPAIR = 'true';
    try {
      await expect(sweepUngeocodedServices({
        dryRun: false, now: new Date('2099-09-30T16:00:00.000Z'),
      }, mockConnection)).resolves.toMatchObject({ checked: 0, geocoded: 0 });
    } finally {
      if (priorRouteGate === undefined) delete process.env.GATE_ROUTE_REORDER;
      else process.env.GATE_ROUTE_REORDER = priorRouteGate;
      if (priorRepairGate === undefined) delete process.env.GATE_ROUTE_REORDER_REPAIR;
      else process.env.GATE_ROUTE_REORDER_REPAIR = priorRepairGate;
    }
  });

  test('retry rejects while the customer mirror is empty and the primary location retains a pin', async () => {
    await mockConnection('customer_properties').update(PIN);

    await expect(act({ action: 'retry' })).rejects.toMatchObject({
      statusCode: 409, code: 'pin_present',
    });

    expect((await customer()).latitude).toBeNull();
    expect(await primary()).toMatchObject({ latitude: String(PIN.latitude), longitude: String(PIN.longitude) });
    expect(await review()).toBeUndefined();
    expect(await audits()).toEqual([]);
    expect(require('../services/geocoder').ensureCustomerGeocoded).not.toHaveBeenCalled();
  });

  test('a primary-only pin change after detail load invalidates the decision revision', async () => {
    const staleRevision = (await reviewStore.getReviewDetail(CUSTOMER_ID, mockConnection)).revision;
    await mockConnection('customer_properties').update(PIN);

    await expect(act({
      revision: staleRevision, action: 'outside_service_area', source: 'county_records',
    })).rejects.toMatchObject({ statusCode: 409, code: 'review_changed' });

    expect((await customer()).latitude).toBeNull();
    expect(await primary()).toMatchObject({ latitude: String(PIN.latitude), longitude: String(PIN.longitude) });
    expect(await review()).toBeUndefined();
    expect(await audits()).toEqual([]);
  });

  test('revoke clears a primary mirror that diverged from the reviewed customer pin', async () => {
    const divergentPrimary = { latitude: 27.4887654, longitude: -82.5887654 };
    await act();
    await mockConnection('customer_properties').update(divergentPrimary);

    await act({ action: 'revoke' });

    expect(await customer()).toMatchObject({ latitude: null, longitude: null });
    expect(await primary()).toMatchObject({ latitude: null, longitude: null });
    expect(await visit()).toMatchObject({ lat: null, lng: null, route_order: null });
    expect(await review()).toMatchObject({ status: 'needs_pin', reason: 'verification_revoked' });
  });

  test.each(['outside_service_area', 'revoke'])('%s broadcasts every cleared visit after commit', async action => {
    await act();
    dispatch.emitDispatchJobUpdate.mockClear();
    dispatch.flushDispatchQualityDates.mockClear();

    await act({ action, source: 'county_records' });

    expect(dispatch.emitDispatchJobUpdate).toHaveBeenCalledWith(expect.objectContaining({
      jobId: visitId, actorId: ACTOR_ID,
    }));
    expect(dispatch.flushDispatchQualityDates).toHaveBeenCalledTimes(1);
  });

  test('verify broadcasts standalone and recurring visit changes through one shared batch', async () => {
    const parentId = randomUUID();
    const childId = randomUUID();
    await mockConnection('scheduled_services').insert([
      visitRow(parentId, {
        property_id: PRIMARY_ID, status: 'completed', is_recurring: true, recurring_ongoing: true,
        recurring_template_overrides: { appointment_address: {
          property_id: PRIMARY_ID,
          service_address_line1: ADDRESS.address_line1,
          service_address_line2: ADDRESS.address_line2,
          service_address_city: ADDRESS.city,
          service_address_state: ADDRESS.state,
          service_address_zip: ADDRESS.zip,
          lat: null, lng: null, zone: null,
        } },
      }),
      visitRow(childId, { property_id: PRIMARY_ID, recurring_parent_id: parentId }),
    ]);

    await act();

    const calls = dispatch.emitDispatchJobUpdate.mock.calls.map(([options]) => options);
    expect(calls.map(options => options.jobId).sort()).toEqual([childId, visitId].sort());
    expect(calls.every(options => options.actorId === ACTOR_ID)).toBe(true);
    expect(calls[0].qualityDates).toBe(calls[1].qualityDates);
    expect(dispatch.flushDispatchQualityDates).toHaveBeenCalledTimes(1);
    expect(dispatch.flushDispatchQualityDates).toHaveBeenCalledWith(calls[0].qualityDates);
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

(connection ? describe : describe.skip)('geocode decisions concurrent with a primary-address editor', () => {
  let database;
  const schema = `geocode_lock_order_${randomUUID().replaceAll('-', '')}`;
  const previousGate = process.env.GATE_GEOCODE_REVIEW;
  beforeAll(async () => {
    const url = new URL(connection);
    if (!/^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname) || url.search || url.hash) throw new Error('Private QA database required');
    database = knex({ client: 'pg', connection, searchPath: [schema, 'public'], pool: { min: 0, max: 3 } });
    await database.raw('CREATE SCHEMA ??', [schema]);
    await createActionSchema(database);
    await seedLocation(database, { customerPin: {}, propertyPin: {}, propertyAddress: ADDRESS });
    mockConnection = database;
    process.env.GATE_GEOCODE_REVIEW = 'true';
  });
  afterAll(async () => {
    if (previousGate === undefined) delete process.env.GATE_GEOCODE_REVIEW;
    else process.env.GATE_GEOCODE_REVIEW = previousGate;
    if (database) {
      await database.raw('DROP SCHEMA IF EXISTS ?? CASCADE', [schema]);
      await database.destroy();
    }
  });

  test('a decision that cannot take a visit day\'s slot lock refuses at once with a retryable conflict', async () => {
    const visitId = randomUUID();
    await database('scheduled_services').insert(visitRow(visitId, { property_id: PRIMARY_ID }));
    const holder = await database.transaction();
    try {
      // A slot reservation on the visit's tech-day holds the lock that
      // prelockVisitContext only TRIES (NOWAIT): the decision must refuse
      // immediately instead of queueing behind the reservation.
      await holder.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
        ['slot-reserve', `${TECH_ID}:2099-10-01`]);
      const snapshot = async () => ({
        customer: await database('customers').where({ id: CUSTOMER_ID }).first(),
        review: await database('customer_geocode_reviews').where({ customer_id: CUSTOMER_ID }).first(),
        visit: await database('scheduled_services').where({ id: visitId }).first(),
      });
      const before = await snapshot();
      await expect(resolveCustomerGeocodeReview(CUSTOMER_ID, {
        revision: (await reviewStore.getReviewDetail(CUSTOMER_ID, database)).revision,
        action: 'verify_pin', ...PIN, confirmed: true,
        source: 'site_visit', evidence: 'Synthetic contended review',
      }, ACTOR_ID, database)).rejects.toMatchObject({ statusCode: 409, code: 'visit_changed', isOperational: true });
      expect(await snapshot()).toEqual(before);
    } finally {
      await holder.rollback();
      await database('scheduled_services').where({ id: visitId }).del();
    }
  });

  test('an editor holding the preference lock can lock the customer while a decision waits', async () => {
    const revision = (await reviewStore.getReviewDetail(CUSTOMER_ID, database)).revision;
    const editor = await database.transaction();
    let resolution;
    try {
      await editor.raw("SELECT set_config('lock_timeout', '1s', true)");
      await editor.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
        ['property-preferences', String(CUSTOMER_ID)]);
      resolution = resolveCustomerGeocodeReview(CUSTOMER_ID, {
        revision, action: 'verify_pin', ...PIN, confirmed: true,
        source: 'site_visit', evidence: 'Synthetic concurrent review', address: CORRECTED,
      }, ACTOR_ID, database).then(value => ({ value }), error => ({ error }));
      // Observe the real PostgreSQL wait, so a slow runner cannot pass this
      // merely because the review transaction has not begun yet.
      let waiting = false;
      for (let attempt = 0; attempt < 100 && !waiting; attempt += 1) {
        const { rows } = await database.raw(`SELECT 1 FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
          AND query LIKE 'SELECT pg_advisory_xact_lock%'`);
        waiting = rows.length > 0;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(waiting).toBe(true);
      // The old customer-first order times out here: the review owns this
      // row while waiting for the editor's advisory lock.
      expect(await editor('customers').where({ id: CUSTOMER_ID }).forUpdate().first('id'))
        .toEqual({ id: CUSTOMER_ID });
      await editor.commit();
      const result = await resolution;
      if (result.error) throw result.error;
      expect(result.value.review.status).toBe('verified');
      expect(await database('customers').where({ id: CUSTOMER_ID }).first())
        .toMatchObject(CORRECTED);
    } finally {
      if (!editor.isCompleted()) await editor.rollback();
      if (resolution) await resolution;
    }
  });
});
