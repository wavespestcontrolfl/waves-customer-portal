/** Real PostgreSQL: private QA database only, synthetic schema rolled back per test. */
jest.setTimeout(15000);
let mockConnection;
jest.mock('../models/db', () => {
  const proxy = (...args) => mockConnection(...args);
  for (const method of ['raw', 'transaction']) proxy[method] = (...args) => mockConnection[method](...args);
  return proxy;
});
jest.mock('../services/geocoder', () => ({
  buildAddress: customer => [customer.address_line1, customer.city, customer.state, customer.zip].join(', '),
  clearGeocodeMemo: jest.fn(),
  ensureCustomerGeocoded: jest.fn(),
}));
jest.mock('../services/scheduling/quality-after-change', () => ({
  refreshScheduleQualityAfterChange: jest.fn().mockResolvedValue({ status: 'checked' }),
}));
jest.mock('../services/appointment-address', () => ({
  refreshAppointmentAddressBriefs: jest.fn().mockResolvedValue(),
}));

const knex = require('knex');
const { randomUUID } = require('node:crypto');
const migration = require('../models/migrations/20260926000030_customer_geocode_reviews');
const reviewStore = require('../services/customer-geocode-review');
const { addressKey } = require('../services/customer-properties');
const { resolveCustomerGeocodeReview } = require('../services/customer-geocode-review-actions');
const { recurringServiceAddress } = require('../services/booking/visit-financial-stamps');
const { etDateString, addETDays } = require('../utils/datetime-et');
const appointmentAddress = require('../services/appointment-address');

const connection = process.env.SERVICE_GEOCODE_TEST_DATABASE_URL;
const CUSTOMER = '71000000-0000-4000-8000-000000000011';
const PRIMARY = '71000000-0000-4000-8000-000000000012';
const SECONDARY = '71000000-0000-4000-8000-000000000013';
const ACTOR = '72000000-0000-4000-8000-000000000011';
const PIN = { latitude: 27.4981234, longitude: -82.5748123 };
const HALF_PIN = { latitude: 27.4981235, longitude: -82.5748125 };
const ADDRESS = { address_line1: '100 Fixture Way', address_line2: null, city: 'Bradenton', state: 'FL', zip: '34205' };
const SECONDARY_ADDRESS = { address_line1: '900 Other Ave', address_line2: null, city: 'Sarasota', state: 'FL', zip: '34236' };
const postgres = connection ? describe : describe.skip;

postgres('customer geocode review actions in PostgreSQL', () => {
  let database;
  let visitIds;
  const previousGate = process.env.GATE_GEOCODE_REVIEW;

  beforeAll(() => {
    const url = new URL(connection);
    if (!/^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname) || url.search || url.hash) {
      throw new Error('A private QA database is required');
    }
    database = knex({ client: 'pg', connection, pool: { min: 0, max: 1 } });
    process.env.GATE_GEOCODE_REVIEW = 'true';
  });

  afterAll(async () => {
    if (previousGate === undefined) delete process.env.GATE_GEOCODE_REVIEW;
    else process.env.GATE_GEOCODE_REVIEW = previousGate;
    await database?.destroy();
  });

  beforeEach(async () => {
    appointmentAddress.refreshAppointmentAddressBriefs.mockClear();
    process.env.GATE_GEOCODE_REVIEW = 'true';
    mockConnection = await database.transaction();
    const schema = `geocode_actions_${randomUUID().replaceAll('-', '')}`;
    await mockConnection.raw('CREATE SCHEMA ??', [schema]);
    await mockConnection.raw('SET LOCAL search_path TO ??, public', [schema]);
    await mockConnection.schema.createTable('customers', table => {
      table.uuid('id').primary();
      table.string('first_name'); table.string('last_name');
      table.string('profile_label'); table.string('contact_role');
      table.string('address_line1', 200); table.string('address_line2', 100);
      table.string('city', 50); table.string('state', 2); table.string('zip', 10);
      table.decimal('latitude', 10, 7); table.decimal('longitude', 10, 7);
      table.string('property_type'); table.string('lawn_type'); table.integer('property_sqft'); table.integer('lot_sqft');
      table.integer('bed_sqft'); table.integer('linear_ft_perimeter'); table.integer('palm_count'); table.string('canopy_type');
      table.timestamp('updated_at', { useTz: true }); table.timestamp('deleted_at', { useTz: true });
    });
    await mockConnection.schema.createTable('customer_properties', table => {
      table.uuid('id').primary().defaultTo(mockConnection.raw('gen_random_uuid()'));
      table.uuid('customer_id'); table.boolean('is_primary'); table.boolean('active');
      table.string('label'); table.string('occupancy_type'); table.string('relationship'); table.string('source');
      table.string('address_line1', 200); table.string('address_line2', 100);
      table.string('city', 50); table.string('state', 2); table.string('zip', 10); table.string('address_key');
      table.string('property_type'); table.string('lawn_type'); table.integer('property_sqft'); table.integer('lot_sqft');
      table.integer('bed_sqft'); table.integer('linear_ft_perimeter'); table.integer('palm_count'); table.string('canopy_type');
      table.decimal('latitude', 10, 7); table.decimal('longitude', 10, 7); table.timestamp('updated_at', { useTz: true });
    });
    await mockConnection.raw('CREATE UNIQUE INDEX customer_properties_customer_address_uniq ON customer_properties (customer_id, address_key) WHERE active');
    await mockConnection.schema.createTable('scheduled_services', table => {
      table.uuid('id').primary(); table.uuid('customer_id'); table.uuid('property_id'); table.uuid('technician_id');
      table.string('status'); table.date('scheduled_date');
      table.string('service_address_line1', 200); table.string('service_address_line2', 100);
      table.string('service_address_city', 50); table.string('service_address_state', 2); table.string('service_address_zip', 10);
      table.decimal('lat', 10, 6); table.decimal('lng', 10, 6);
      table.string('zone'); table.integer('route_order');
      table.text('pre_service_brief'); table.string('pre_service_brief_type');
      table.timestamp('pre_service_brief_generated_at', { useTz: true });
      table.boolean('is_recurring').defaultTo(false); table.uuid('recurring_parent_id');
      table.boolean('recurring_ongoing').defaultTo(false); table.jsonb('recurring_template_overrides');
      table.boolean('auto_dispatch_locked').defaultTo(false); table.boolean('auto_dispatch_excluded').defaultTo(false);
      table.timestamp('updated_at', { useTz: true });
    });
    await mockConnection.schema.createTable('property_preferences', table => {
      table.uuid('customer_id').primary(); table.timestamp('irrigation_home_changed_at', { useTz: true });
      table.jsonb('irrigation_confirmed_fields');
    });
    await mockConnection.schema.createTable('leads', table => {
      table.uuid('id').primary(); table.uuid('customer_id'); table.string('status');
      table.string('address', 255); table.string('city'); table.string('zip'); table.timestamp('updated_at', { useTz: true });
    });
    await mockConnection.schema.createTable('estimates', table => {
      table.uuid('id').primary(); table.uuid('customer_id'); table.string('status'); table.string('address', 300);
      table.jsonb('estimate_data'); table.timestamp('archived_at', { useTz: true }); table.timestamp('updated_at', { useTz: true });
    });
    await mockConnection.schema.createTable('audit_log', table => {
      table.increments('id'); table.string('actor_type'); table.uuid('actor_id'); table.string('action');
      table.string('resource_type'); table.string('resource_id'); table.jsonb('metadata');
      table.string('ip_address'); table.string('user_agent'); table.timestamp('created_at', { useTz: true }).defaultTo(mockConnection.fn.now());
    });
    await migration.up(mockConnection);
    await mockConnection('customers').insert({ id: CUSTOMER, first_name: 'Synthetic', last_name: 'Fixture', ...ADDRESS });
    await mockConnection('customer_properties').insert([
      { id: PRIMARY, customer_id: CUSTOMER, is_primary: true, active: true,
        ...ADDRESS, address_key: addressKey(ADDRESS) },
      { id: SECONDARY, customer_id: CUSTOMER, is_primary: false, active: true,
        ...SECONDARY_ADDRESS, address_key: addressKey(SECONDARY_ADDRESS) },
    ]);
    visitIds = Object.fromEntries([
      'matching', 'started', 'completed', 'independentRoot', 'frozen', 'excluded', 'divergent', 'individual',
      'zeroLatitude', 'zeroLongitude', 'zeroBoth',
    ]
      .map(name => [name, randomUUID()]));
    const tomorrow = etDateString(addETDays(new Date(), 1));
    const baseVisit = { customer_id: CUSTOMER, property_id: PRIMARY, status: 'confirmed', scheduled_date: tomorrow,
      service_address_line1: ADDRESS.address_line1, service_address_line2: ADDRESS.address_line2,
      service_address_city: ADDRESS.city, service_address_state: ADDRESS.state, service_address_zip: ADDRESS.zip };
    await mockConnection('scheduled_services').insert([
      { ...baseVisit, id: visitIds.matching, recurring_parent_id: visitIds.completed,
        zone: 'legacy-zone', route_order: 7, pre_service_brief: 'Old location brief',
        pre_service_brief_type: 'route', pre_service_brief_generated_at: new Date() },
      { ...baseVisit, id: visitIds.started, status: 'en_route' },
      { ...baseVisit, id: visitIds.completed, status: 'completed', is_recurring: true, recurring_ongoing: true,
        recurring_template_overrides: { visit_count: 4, appointment_address: {
          property_id: PRIMARY, service_address_line1: ADDRESS.address_line1,
          service_address_line2: ADDRESS.address_line2, service_address_city: ADDRESS.city,
          service_address_state: ADDRESS.state, service_address_zip: ADDRESS.zip, lat: null, lng: null,
          zone: 'legacy-zone',
        } } },
      { ...baseVisit, id: visitIds.independentRoot, status: 'completed', is_recurring: true, recurring_ongoing: true,
        recurring_template_overrides: { appointment_address: {
          property_id: PRIMARY, service_address_line1: ADDRESS.address_line1,
          service_address_line2: ADDRESS.address_line2, service_address_city: ADDRESS.city,
          service_address_state: ADDRESS.state, service_address_zip: ADDRESS.zip, lat: 27.4, lng: -82.4,
        } } },
      { ...baseVisit, id: visitIds.frozen, auto_dispatch_locked: true },
      { ...baseVisit, id: visitIds.excluded, auto_dispatch_excluded: true },
      { ...baseVisit, id: visitIds.divergent, property_id: SECONDARY, service_address_line1: '900 Other Ave',
        service_address_city: 'Sarasota', service_address_zip: '34236' },
      { ...baseVisit, id: visitIds.individual, lat: 27.4, lng: -82.4 },
      { ...baseVisit, id: visitIds.zeroLatitude, lat: 0, lng: -82.4 },
      { ...baseVisit, id: visitIds.zeroLongitude, lat: 27.4, lng: 0 },
      { ...baseVisit, id: visitIds.zeroBoth, lat: 0, lng: 0 },
    ]);
  });

  afterEach(async () => { await mockConnection?.rollback(); });

  const customer = () => mockConnection('customers').where({ id: CUSTOMER }).first();
  const primary = () => mockConnection('customer_properties').where({ id: PRIMARY }).first();
  const review = () => mockConnection('customer_geocode_reviews').where({ customer_id: CUSTOMER }).first();
  const visit = id => mockConnection('scheduled_services').where({ id }).first();
  const detail = () => reviewStore.getReviewDetail(CUSTOMER, mockConnection);

  async function verify({ address, pin = PIN } = {}) {
    return resolveCustomerGeocodeReview(CUSTOMER, {
      revision: (await detail()).revision,
      action: 'verify_pin',
      ...(address ? { address } : {}),
      ...pin,
      source: 'site_visit',
      evidence: 'Synthetic marker observation',
      confirmed: true,
    }, ACTOR, mockConnection);
  }

  test('verify atomically saves the protected pin, primary mirror, audit and only eligible visit snapshots', async () => {
    const corrected = { address_line1: '101 Fixture Way', address_line2: '', city: 'Bradenton', state: 'FL', zip: '34205' };
    const canonical = { ...corrected, address_line2: null };
    await verify({ address: corrected });

    const savedCustomer = await customer();
    const savedPrimary = await primary();
    const savedReview = await review();
    expect(savedCustomer).toMatchObject(canonical);
    expect(Number(savedCustomer.latitude)).toBe(PIN.latitude);
    expect(Number(savedPrimary.latitude)).toBe(PIN.latitude);
    expect(savedPrimary).toMatchObject(canonical);
    expect(savedReview).toMatchObject({ status: 'verified', reason: 'staff_verified', reviewed_by: ACTOR });
    expect(Number(savedReview.longitude)).toBe(PIN.longitude);

    const matching = await visit(visitIds.matching);
    expect(matching).toMatchObject({
      property_id: PRIMARY, service_address_line1: corrected.address_line1,
      zone: null, route_order: null, pre_service_brief: null,
      pre_service_brief_type: null, pre_service_brief_generated_at: null,
    });
    expect(Number(matching.lat)).toBe(Number(PIN.latitude.toFixed(6)));
    expect(appointmentAddress.refreshAppointmentAddressBriefs).toHaveBeenCalledWith(
      mockConnection,
      expect.arrayContaining([visitIds.matching, visitIds.zeroLatitude, visitIds.zeroLongitude, visitIds.zeroBoth]),
    );
    expect(appointmentAddress.refreshAppointmentAddressBriefs.mock.calls[0][1]).toHaveLength(4);
    for (const name of ['started', 'completed', 'independentRoot', 'frozen', 'excluded', 'divergent']) {
      expect((await visit(visitIds[name])).lat).toBeNull();
    }
    const recurringParent = await visit(visitIds.completed);
    expect(recurringParent.service_address_line1).toBe(ADDRESS.address_line1);
    expect(recurringParent.recurring_template_overrides.visit_count).toBe(4);
    expect(recurringServiceAddress(recurringParent)).toMatchObject({
      property_id: PRIMARY, service_address_line1: corrected.address_line1,
      service_address_line2: null, lat: PIN.latitude, lng: PIN.longitude, zone: null,
    });
    expect(recurringServiceAddress(await visit(visitIds.independentRoot))).toMatchObject({ lat: 27.4, lng: -82.4 });
    expect(Number((await visit(visitIds.individual)).lat)).toBe(27.4);
    for (const name of ['zeroLatitude', 'zeroLongitude', 'zeroBoth']) {
      expect(Number((await visit(visitIds[name])).lat)).toBe(Number(PIN.latitude.toFixed(6)));
      expect(Number((await visit(visitIds[name])).lng)).toBe(Number(PIN.longitude.toFixed(6)));
    }
    expect(await mockConnection('audit_log').where({ action: 'customer_geocode_review.verify_pin' }).count('* as count').first())
      .toMatchObject({ count: '1' });

    await mockConnection('customers').where({ id: CUSTOMER }).update({ latitude: 27.6, longitude: -82.3 });
    expect(Number((await customer()).latitude)).toBe(PIN.latitude);
  });

  test('revoke retains provenance while guarded-clearing only matching live primary pins', async () => {
    await verify();
    await mockConnection('scheduled_services').whereIn('id', [visitIds.frozen, visitIds.excluded])
      .update({ lat: PIN.latitude, lng: PIN.longitude, route_order: 8 });
    await mockConnection('scheduled_services').where({ id: visitIds.matching }).update({ route_order: 7 });
    await mockConnection('scheduled_services').where({ id: visitIds.individual }).update({ route_order: 6 });
    await mockConnection('scheduled_services').where({ id: visitIds.completed })
      .update({ lat: PIN.latitude, lng: PIN.longitude, route_order: 5 });
    await resolveCustomerGeocodeReview(CUSTOMER, {
      revision: (await detail()).revision, action: 'revoke',
    }, ACTOR, mockConnection);

    expect((await customer()).latitude).toBeNull();
    expect((await primary()).latitude).toBeNull();
    expect(await visit(visitIds.matching)).toMatchObject({ lat: null, route_order: null });
    expect(await visit(visitIds.frozen)).toMatchObject({ lat: null, route_order: null });
    expect(await visit(visitIds.excluded)).toMatchObject({ lat: null, route_order: null });
    expect(Number((await visit(visitIds.individual)).lat)).toBe(27.4);
    expect((await visit(visitIds.individual)).route_order).toBe(6);
    const recurringParent = await visit(visitIds.completed);
    expect(recurringParent.service_address_line1).toBe(ADDRESS.address_line1);
    expect(Number(recurringParent.lat)).toBe(Number(PIN.latitude.toFixed(6)));
    expect(recurringParent.route_order).toBe(5);
    expect(recurringServiceAddress(recurringParent)).toMatchObject({ lat: null, lng: null });
    expect(recurringServiceAddress(await visit(visitIds.independentRoot))).toMatchObject({ lat: 27.4, lng: -82.4 });
    const saved = await review();
    expect(saved).toMatchObject({ status: 'needs_pin', reason: 'verification_revoked', reviewed_by: null });
    expect(Number(saved.latitude)).toBe(PIN.latitude);
  });

  test('halfway coordinates use PostgreSQL rounding for repeat verification and revoke clearing', async () => {
    await verify({ pin: HALF_PIN });
    expect(await visit(visitIds.matching)).toMatchObject({ lat: '27.498124', lng: '-82.574813' });

    await mockConnection('scheduled_services').where({ id: visitIds.matching }).update({
      zone: 'stale-zone', route_order: 8,
    });
    await verify({ pin: HALF_PIN });
    expect(await visit(visitIds.matching)).toMatchObject({
      lat: '27.498124', lng: '-82.574813', zone: null, route_order: null,
    });

    await resolveCustomerGeocodeReview(CUSTOMER, {
      revision: (await detail()).revision, action: 'revoke',
    }, ACTOR, mockConnection);
    expect(await visit(visitIds.matching)).toMatchObject({ lat: null, lng: null });
    expect((await customer()).latitude).toBeNull();
    expect((await primary()).latitude).toBeNull();
  });

  test('an empty optional unit on unchanged-address verification permits the next review action', async () => {
    await verify({ address: { ...ADDRESS, address_line2: '' } });

    await expect(resolveCustomerGeocodeReview(CUSTOMER, {
      revision: (await detail()).revision, action: 'revoke',
    }, ACTOR, mockConnection)).resolves.toEqual(expect.objectContaining({
      review: expect.objectContaining({ status: 'needs_pin' }),
    }));
    expect((await customer()).address_line2).toBeNull();
    expect((await primary()).address_line2).toBeNull();
  });

  test('an omitted unit and unrelated customer fields are preserved while an address correction is applied', async () => {
    const withUnit = { ...ADDRESS, address_line2: 'Unit 7' };
    await mockConnection('customers').where({ id: CUSTOMER }).update({ address_line2: withUnit.address_line2 });
    await mockConnection('customer_properties').where({ id: PRIMARY }).update({
      address_line2: withUnit.address_line2, address_key: addressKey(withUnit),
    });
    await verify({ address: {
      address_line1: '102 Fixture Way', city: ADDRESS.city, state: ADDRESS.state, zip: ADDRESS.zip,
      first_name: 'Unexpected overwrite', deleted_at: new Date(),
    } });

    expect(await customer()).toMatchObject({
      first_name: 'Synthetic', deleted_at: null, address_line1: '102 Fixture Way', address_line2: 'Unit 7',
    });
    expect(await primary()).toMatchObject({ address_line1: '102 Fixture Way', address_line2: 'Unit 7' });
  });

  test('a review lazily initializes a missing primary property under the customer lock', async () => {
    await mockConnection('customer_properties').where({ id: PRIMARY }).del();
    await resolveCustomerGeocodeReview(CUSTOMER, {
      revision: (await detail()).revision, action: 'retry',
    }, ACTOR, mockConnection);

    const rows = await mockConnection('customer_properties')
      .where({ customer_id: CUSTOMER, active: true, is_primary: true });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ...ADDRESS, source: 'backfill' });
  });

  test('a complete first-address verification creates the missing primary and resolves the blank customer', async () => {
    await mockConnection('customer_properties').where({ id: PRIMARY }).del();
    await mockConnection('customers').where({ id: CUSTOMER }).update({
      address_line1: null, address_line2: null, city: null, state: null, zip: null,
    });
    await mockConnection('scheduled_services').update({ property_id: null });
    const recurringParent = await visit(visitIds.completed);
    await mockConnection('scheduled_services').where({ id: visitIds.completed }).update({
      recurring_template_overrides: {
        ...recurringParent.recurring_template_overrides,
        appointment_address: {
          ...recurringParent.recurring_template_overrides.appointment_address, property_id: null,
        },
      },
    });

    await verify({ address: ADDRESS });

    const savedCustomer = await customer();
    const rows = await mockConnection('customer_properties')
      .where({ customer_id: CUSTOMER, active: true, is_primary: true });
    expect(savedCustomer).toMatchObject(ADDRESS);
    expect(Number(savedCustomer.latitude)).toBe(PIN.latitude);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject(ADDRESS);
    expect(Number(rows[0].latitude)).toBe(PIN.latitude);
    expect(await visit(visitIds.matching)).toMatchObject({ property_id: rows[0].id });
  });

  test('a corrected address matches old customer stamps while creating a missing primary', async () => {
    await mockConnection('customer_properties').where({ id: PRIMARY }).del();
    await mockConnection('scheduled_services')
      .whereIn('id', [visitIds.matching, visitIds.frozen, visitIds.individual])
      .update({ property_id: null });
    for (const name of ['completed', 'independentRoot']) {
      const parent = await visit(visitIds[name]);
      await mockConnection('scheduled_services').where({ id: visitIds[name] }).update({
        property_id: null,
        recurring_template_overrides: {
          ...parent.recurring_template_overrides,
          appointment_address: {
            ...parent.recurring_template_overrides.appointment_address, property_id: null,
          },
        },
      });
    }
    const corrected = { ...ADDRESS, address_line1: '104 Fixture Way' };

    await verify({ address: corrected });

    const [savedPrimary] = await mockConnection('customer_properties')
      .where({ customer_id: CUSTOMER, active: true, is_primary: true });
    expect(savedPrimary).toMatchObject(corrected);
    expect(await visit(visitIds.matching)).toMatchObject({
      property_id: savedPrimary.id, service_address_line1: corrected.address_line1,
    });
    expect(recurringServiceAddress(await visit(visitIds.completed))).toMatchObject({
      property_id: savedPrimary.id, service_address_line1: corrected.address_line1,
    });
    expect(await visit(visitIds.frozen)).toMatchObject({
      property_id: null, service_address_line1: ADDRESS.address_line1,
    });
    expect(await visit(visitIds.individual)).toMatchObject({
      property_id: null, service_address_line1: ADDRESS.address_line1,
    });
    expect(await visit(visitIds.divergent)).toMatchObject({
      property_id: SECONDARY, service_address_line1: SECONDARY_ADDRESS.address_line1,
    });
  });

  test('verify corrects an ongoing completed root even when it has no eligible future child', async () => {
    await mockConnection('scheduled_services').where({ id: visitIds.matching }).del();
    const corrected = { ...ADDRESS, address_line1: '103 Fixture Way' };

    await verify({ address: corrected });

    const parent = await visit(visitIds.completed);
    expect(parent.service_address_line1).toBe(ADDRESS.address_line1);
    expect(recurringServiceAddress(parent)).toMatchObject({
      property_id: PRIMARY, service_address_line1: corrected.address_line1,
      lat: PIN.latitude, lng: PIN.longitude,
    });
  });

  test('a duplicate active property address is an operational conflict and rolls back verification', async () => {
    await expect(verify({ address: SECONDARY_ADDRESS })).rejects.toMatchObject({
      statusCode: 409, code: 'address_matches_existing_property', isOperational: true,
    });
    expect(await customer()).toMatchObject({ ...ADDRESS, latitude: null, longitude: null });
    expect(await review()).toBeUndefined();
    expect((await mockConnection('audit_log').count('* as count').first()).count).toBe('0');
  });

  test('outside-area confirmation snapshots a revision-bound legacy pin before clearing every matching mirror', async () => {
    await mockConnection('customers').where({ id: CUSTOMER }).update(PIN);
    await mockConnection('customer_properties').where({ id: PRIMARY }).update(PIN);
    await mockConnection('scheduled_services').where({ id: visitIds.matching })
      .update({ lat: PIN.latitude, lng: PIN.longitude, route_order: 7 });
    await mockConnection('scheduled_services').where({ id: visitIds.frozen })
      .update({ lat: PIN.latitude, lng: PIN.longitude, route_order: 8 });
    await mockConnection('scheduled_services').where({ id: visitIds.individual }).update({ route_order: 6 });
    const recurringParent = await visit(visitIds.completed);
    await mockConnection('scheduled_services').where({ id: visitIds.completed }).update({
      recurring_template_overrides: {
        ...recurringParent.recurring_template_overrides,
        appointment_address: {
          ...recurringParent.recurring_template_overrides.appointment_address,
          lat: PIN.latitude, lng: PIN.longitude,
        },
      },
    });
    await resolveCustomerGeocodeReview(CUSTOMER, {
      revision: (await detail()).revision, action: 'outside_service_area', source: 'county_records',
      evidence: 'Synthetic county boundary confirmation', confirmed: true,
    }, ACTOR, mockConnection);

    expect((await customer()).latitude).toBeNull();
    expect((await primary()).latitude).toBeNull();
    expect(await visit(visitIds.matching)).toMatchObject({ lat: null, route_order: null });
    expect(await visit(visitIds.frozen)).toMatchObject({ lat: null, route_order: null });
    expect((await visit(visitIds.individual)).route_order).toBe(6);
    expect(recurringServiceAddress(await visit(visitIds.completed))).toMatchObject({ lat: null, lng: null });
    const saved = await review();
    expect(saved).toMatchObject({ status: 'outside_area', reason: 'staff_confirmed_outside_area', reviewed_by: ACTOR });
    expect(Number(saved.latitude)).toBe(PIN.latitude);
  });

  test('stale revisions change nothing and a critical audit failure rolls the entire action back', async () => {
    const stale = (await detail()).revision;
    await mockConnection('customers').where({ id: CUSTOMER }).update({ city: 'Sarasota' });
    await mockConnection('customer_properties').where({ id: PRIMARY }).update({ city: 'Sarasota' });
    await expect(resolveCustomerGeocodeReview(CUSTOMER, {
      revision: stale, action: 'verify_pin', ...PIN, source: 'site_visit', evidence: 'Synthetic evidence', confirmed: true,
    }, ACTOR, mockConnection)).rejects.toMatchObject({ statusCode: 409, code: 'review_changed' });
    expect(await review()).toBeUndefined();
    expect((await mockConnection('audit_log').count('* as count').first()).count).toBe('0');

    await mockConnection.raw("ALTER TABLE audit_log ADD CONSTRAINT reject_verify_audit CHECK (action <> 'customer_geocode_review.verify_pin')");
    await expect(verify()).rejects.toThrow();
    expect((await customer()).latitude).toBeNull();
    expect((await primary()).latitude).toBeNull();
    expect((await visit(visitIds.matching)).lat).toBeNull();
    expect(await review()).toBeUndefined();
    expect((await mockConnection('audit_log').count('* as count').first()).count).toBe('0');
  });
});
