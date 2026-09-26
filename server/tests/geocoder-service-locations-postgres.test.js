/**
 * Real PostgreSQL coverage for the appointment-coordinate recovery backstop.
 * Fixtures use connection-local TEMP copies of the migrated tables and roll
 * back after every test. All addresses and coordinates are synthetic SWFL
 * premises; the geocoding provider, sockets, and quality refresh are mocked.
 */
let mockConnection;
jest.mock('../models/db', () => {
  const proxy = (...args) => mockConnection(...args);
  for (const method of ['raw', 'transaction', 'queryBuilder', 'ref']) {
    proxy[method] = (...args) => mockConnection[method](...args);
  }
  for (const property of ['schema', 'fn']) {
    Object.defineProperty(proxy, property, { get: () => mockConnection[property] });
  }
  return proxy;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/geocoder', () => ({ geocodeAddressWithStatus: jest.fn() }));
jest.mock('../services/dispatch-assignment', () => ({ emitDispatchJobUpdate: jest.fn(async () => {}) }));
jest.mock('../services/scheduling/quality-after-change', () => ({ refreshScheduleQualityAfterChange: jest.fn(async () => {}) }));

const knex = require('knex');
const { randomUUID } = require('node:crypto');
const { geocodeAddressWithStatus } = require('../services/geocoder');
const { emitDispatchJobUpdate } = require('../services/dispatch-assignment');
const { refreshScheduleQualityAfterChange } = require('../services/scheduling/quality-after-change');
const { sweepUngeocodedServices } = require('../services/geocoder-service-locations');
const reviewMigration = require('../models/migrations/20260926000030_customer_geocode_reviews');

const connection = process.env.SERVICE_GEOCODE_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const NOW = new Date('2026-09-25T14:00:00Z');
const DAY = '2026-09-30';
const NEXT_DAY = '2026-10-01';
const OUTSIDE_DAY = '2026-10-26';
const CUSTOMER = '31000000-0000-4000-8000-000000000001';
const TECH = '32000000-0000-4000-8000-000000000001';
const PIN = { lat: 27.4981, lng: -82.5748 };

const id = suffix => `33000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;

postgres('service-location geocoder against isolated PostgreSQL', () => {
  let database;
  const routeGates = ['GATE_ROUTE_REORDER', 'GATE_ROUTE_REORDER_REPAIR'];
  const gates = [...routeGates, 'GATE_GEOCODE_REVIEW'];
  const savedGates = Object.fromEntries(gates.map(gate => [gate, process.env[gate]]));

  async function insertCustomer(overrides = {}) {
    await mockConnection('customers').insert({
      id: CUSTOMER,
      first_name: 'Synthetic',
      last_name: 'Fixture',
      address_line1: '100 Primary Fixture Way',
      address_line2: null,
      city: 'Bradenton',
      state: 'FL',
      zip: '34205',
      latitude: 27.497,
      longitude: -82.575,
      deleted_at: null,
      ...overrides,
    });
  }

  async function insertService(serviceId, overrides = {}) {
    await mockConnection('scheduled_services').insert({
      id: serviceId,
      customer_id: CUSTOMER,
      property_id: null,
      technician_id: TECH,
      scheduled_date: DAY,
      status: 'confirmed',
      visit_id: null,
      lat: null,
      lng: null,
      auto_dispatch_locked: false,
      auto_dispatch_excluded: false,
      reservation_expires_at: null,
      service_address_line1: `${Number(serviceId.slice(-4)) || 200} Divergent Fixture Way`,
      service_address_line2: null,
      service_address_city: 'Bradenton',
      service_address_state: 'FL',
      service_address_zip: '34205',
      window_start: '09:00',
      window_end: '10:00',
      ...overrides,
    });
  }

  async function enableReviewGate() {
    process.env.GATE_GEOCODE_REVIEW = 'true';
    // Trigger functions cannot live in pg_temp. Copy just the customer fixture
    // into a rollback-scoped schema, then run the real review migration there.
    const schema = `service_review_${randomUUID().replaceAll('-', '')}`;
    await mockConnection.raw('CREATE SCHEMA ??', [schema]);
    await mockConnection.raw('CREATE TABLE ??.customers (LIKE pg_temp.customers INCLUDING ALL)', [schema]);
    await mockConnection.raw('INSERT INTO ??.customers SELECT * FROM pg_temp.customers', [schema]);
    await mockConnection.raw('ALTER TABLE ??.customers ADD PRIMARY KEY (id)', [schema]);
    await mockConnection.raw('SET LOCAL search_path TO ??, pg_temp, public', [schema]);
    await reviewMigration.up(mockConnection);
  }

  async function insertReview(status, overrides = {}) {
    await mockConnection('customer_geocode_reviews').insert({
      customer_id: CUSTOMER,
      address_snapshot: JSON.stringify(['100 Primary Fixture Way', null, 'Bradenton', 'FL', '34205']),
      status,
      reason: status === 'verified' ? 'staff_verified' : 'fixture_review',
      source: status === 'verified' ? 'site_visit' : null,
      evidence: status === 'verified' ? 'Synthetic fixture evidence' : null,
      latitude: status === 'verified' ? PIN.lat : null,
      longitude: status === 'verified' ? PIN.lng : null,
      ...overrides,
    });
  }

  beforeAll(() => {
    const url = new URL(connection);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    const ciTest = process.env.CI === 'true'
      && ['localhost', '127.0.0.1'].includes(url.hostname)
      && url.pathname === '/waves_test';
    if (!privateQa && !ciTest) throw new Error('Use a task-private QA database or the isolated CI database');
    database = knex({ client: 'pg', connection, pool: { min: 0, max: 1 } });
  });

  afterAll(async () => {
    await database?.destroy();
    for (const gate of gates) {
      if (savedGates[gate] === undefined) delete process.env[gate];
      else process.env[gate] = savedGates[gate];
    }
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    routeGates.forEach(gate => { process.env[gate] = 'true'; });
    delete process.env.GATE_GEOCODE_REVIEW;
    geocodeAddressWithStatus.mockResolvedValue({ location: PIN, permanent: false });
    mockConnection = await database.transaction();
    for (const table of ['scheduled_services', 'customers', 'audit_log']) {
      await mockConnection.raw('CREATE TEMP TABLE ?? ON COMMIT DROP AS SELECT * FROM public.?? WITH NO DATA', [table, table]);
    }
    await insertCustomer();
  });

  afterEach(async () => {
    if (mockConnection && !mockConnection.isCompleted()) await mockConnection.rollback();
  });

  test('dry run lists only eligible upcoming stops without provider calls, writes, or broadcasts', async () => {
    const eligible = id(1);
    await insertService(eligible);
    await insertService(id(2), { status: 'completed' });
    await insertService(id(3), { auto_dispatch_locked: true });
    await insertService(id(4), { auto_dispatch_excluded: true });
    // Canonical estimate holds are unclaimed (customer_id NULL), so the
    // customer join excludes them independently of their expiry timestamp.
    await insertService(id(5), { customer_id: null, reservation_expires_at: '2026-09-25T15:00:00Z' });
    await insertService(id(6), { scheduled_date: OUTSIDE_DAY });
    delete process.env.GATE_ROUTE_REORDER;
    delete process.env.GATE_ROUTE_REORDER_REPAIR;

    const result = await sweepUngeocodedServices({ now: NOW, dryRun: true }, mockConnection);

    expect(result).toMatchObject({ status: 'dry_run', checked: 1, geocoded: 0 });
    expect(result.stops).toEqual([{ id: eligible, date: DAY, reason: 'missing_service_coordinates' }]);
    expect(geocodeAddressWithStatus).not.toHaveBeenCalled();
    expect(await mockConnection('scheduled_services').where({ id: eligible }).first('lat', 'lng')).toEqual({ lat: null, lng: null });
    expect(await mockConnection('audit_log')).toHaveLength(0);
    expect(emitDispatchJobUpdate).not.toHaveBeenCalled();
    expect(refreshScheduleQualityAfterChange).not.toHaveBeenCalled();
  });

  test('recovers a divergent service pin without changing the primary address or appointment fields', async () => {
    const serviceId = id(10);
    await insertService(serviceId, {
      property_id: '34000000-0000-4000-8000-000000000010',
      service_address_line1: '210 Divergent Fixture Way',
      scheduled_date: NEXT_DAY,
      status: 'pending',
      window_start: '13:00',
      window_end: '14:30',
    });
    const before = await mockConnection('scheduled_services').where({ id: serviceId }).first();
    const primaryBefore = await mockConnection('customers').where({ id: CUSTOMER }).first();

    const result = await sweepUngeocodedServices({ now: NOW, dryRun: false }, mockConnection);

    expect(result).toMatchObject({ status: 'completed', checked: 1, geocoded: 1, stale: 0, failed: 0 });
    expect(result.stops[0].reason).toBe('coordinates_recovered');
    const after = await mockConnection('scheduled_services').where({ id: serviceId }).first();
    expect({ lat: Number(after.lat), lng: Number(after.lng) }).toEqual(PIN);
    for (const column of ['customer_id', 'property_id', 'technician_id', 'scheduled_date', 'status', 'window_start', 'window_end',
      'service_address_line1', 'service_address_city', 'service_address_state', 'service_address_zip']) {
      expect(String(after[column])).toBe(String(before[column]));
    }
    expect(await mockConnection('customers').where({ id: CUSTOMER }).first()).toEqual(primaryBefore);
    const audit = await mockConnection('audit_log').where({ resource_id: serviceId }).first();
    expect(audit).toMatchObject({
      actor_type: 'system',
      action: 'service_coordinates_recovered',
      resource_type: 'scheduled_service',
      resource_id: serviceId,
    });
    expect(audit.metadata).toMatchObject({ source: 'verified_service_address_geocode', scheduled_date: NEXT_DAY });
    expect(emitDispatchJobUpdate).toHaveBeenCalledWith({ jobId: serviceId, qualityDates: new Set([NEXT_DAY]) });
    expect(refreshScheduleQualityAfterChange).toHaveBeenCalledTimes(1);
    expect(refreshScheduleQualityAfterChange.mock.calls[0][0]).toEqual({ dates: [NEXT_DAY], now: NOW });
  });

  test('a committed appointment with a stray reservation expiry remains eligible and preserves that snapshot field', async () => {
    const serviceId = id(11);
    await insertService(serviceId, {
      service_address_line1: '211 Committed Fixture Way',
      reservation_expires_at: '2026-09-25T15:00:00Z',
    });
    const before = await mockConnection('scheduled_services').where({ id: serviceId }).first();

    const result = await sweepUngeocodedServices({ now: NOW, dryRun: false }, mockConnection);

    expect(result).toMatchObject({ status: 'completed', checked: 1, geocoded: 1, stale: 0, failed: 0 });
    const after = await mockConnection('scheduled_services').where({ id: serviceId }).first();
    expect({ lat: Number(after.lat), lng: Number(after.lng) }).toEqual(PIN);
    expect(after.reservation_expires_at).toEqual(before.reservation_expires_at);
    const withoutCoordinateWrite = ({ lat: _lat, lng: _lng, updated_at: _updatedAt, ...row }) => row;
    expect(withoutCoordinateWrite(after)).toEqual(withoutCoordinateWrite(before));
  });

  test('matching primary-address coordinates are a valid shared fallback and are not geocoded', async () => {
    const serviceId = id(20);
    await insertService(serviceId, {
      service_address_line1: '100 Primary Fixture Way',
      service_address_city: 'Bradenton',
      service_address_state: 'FL',
      service_address_zip: '34205',
    });

    const result = await sweepUngeocodedServices({ now: NOW, dryRun: false }, mockConnection);

    expect(result).toMatchObject({ checked: 0, geocoded: 0 });
    expect(geocodeAddressWithStatus).not.toHaveBeenCalled();
    expect(await mockConnection('scheduled_services').where({ id: serviceId }).first('lat', 'lng')).toEqual({ lat: null, lng: null });
  });

  test.each([
    ['latitude only', id(21), { lat: 26.75, lng: null }],
    ['longitude only', id(22), { lat: null, lng: -81.75 }],
    ['zero-valued latitude half-pair', id(23), { lat: 0, lng: -81.5 }],
    ['zero-valued longitude half-pair', id(24), { lat: 26.5, lng: 0 }],
  ])('matching-primary %s is fully replaced instead of becoming a mixed fallback pin', async (_label, serviceId, stored) => {
    await insertService(serviceId, {
      ...stored,
      service_address_line1: '100 Primary Fixture Way',
      service_address_city: 'Bradenton',
      service_address_state: 'FL',
      service_address_zip: '34205',
    });

    const result = await sweepUngeocodedServices({ now: NOW, dryRun: false }, mockConnection);

    expect(result).toMatchObject({ checked: 1, geocoded: 1, stale: 0, failed: 0 });
    expect(geocodeAddressWithStatus).toHaveBeenCalledTimes(1);
    const recovered = await mockConnection('scheduled_services').where({ id: serviceId }).first('lat', 'lng');
    expect({ lat: Number(recovered.lat), lng: Number(recovered.lng) }).toEqual(PIN);
  });

  test('incomplete, provider-partial, and out-of-area service addresses are rejected without writes', async () => {
    const incomplete = id(30);
    const partial = id(31);
    const outside = id(32);
    await insertService(incomplete, { service_address_line1: '230 Incomplete Fixture Way', service_address_city: null });
    await insertService(partial, { service_address_line1: '231 Partial Fixture Way' });
    await insertService(outside, { service_address_line1: '232 Outside Fixture Way' });
    geocodeAddressWithStatus.mockImplementation(async address => {
      if (address.includes('Partial Fixture') || address.includes('Outside Fixture')) {
        return { location: null, permanent: true };
      }
      throw new Error(`Unexpected provider lookup for ${address}`);
    });

    const result = await sweepUngeocodedServices({ now: NOW, dryRun: false }, mockConnection);

    expect(result).toMatchObject({ checked: 3, geocoded: 0, unresolved: 3, stale: 0, failed: 0 });
    expect(result.stops).toEqual([
      { id: incomplete, date: DAY, reason: 'incomplete_service_address' },
      { id: partial, date: DAY, reason: 'service_address_unresolved' },
      { id: outside, date: DAY, reason: 'service_address_unresolved' },
    ]);
    expect(geocodeAddressWithStatus).toHaveBeenCalledTimes(2);
    expect(await mockConnection('scheduled_services').whereIn('id', [incomplete, partial, outside]).whereNotNull('lat')).toHaveLength(0);
    expect(await mockConnection('audit_log')).toHaveLength(0);
  });

  test('a transient geocoder failure remains eligible and succeeds on the next sweep', async () => {
    const serviceId = id(40);
    await insertService(serviceId, { service_address_line1: '240 Transient Fixture Way' });
    geocodeAddressWithStatus
      .mockResolvedValueOnce({ location: null, permanent: false })
      .mockResolvedValueOnce({ location: PIN, permanent: false });

    const first = await sweepUngeocodedServices({ limit: 1, now: NOW, dryRun: false }, mockConnection);
    const second = await sweepUngeocodedServices({ limit: 1, now: NOW, dryRun: false }, mockConnection);

    expect(first).toMatchObject({ checked: 1, geocoded: 0, unresolved: 1 });
    expect(first.stops[0].reason).toBe('geocode_temporarily_unavailable');
    expect(second).toMatchObject({ checked: 1, geocoded: 1, unresolved: 0 });
    expect(geocodeAddressWithStatus).toHaveBeenCalledTimes(2);
    const row = await mockConnection('scheduled_services').where({ id: serviceId }).first('lat', 'lng');
    expect({ lat: Number(row.lat), lng: Number(row.lng) }).toEqual(PIN);
  });

  test('a permanent failure cannot starve the next limit-one candidate and an address edit readmits it', async () => {
    const permanent = id(50);
    const next = id(51);
    await insertService(permanent, { service_address_line1: '250 Permanent Fixture Way' });
    await insertService(next, { service_address_line1: '251 Next Fixture Way' });
    geocodeAddressWithStatus.mockImplementation(async address => ({
      location: address.includes('Permanent Fixture') ? null : PIN,
      permanent: address.includes('Permanent Fixture'),
    }));

    const first = await sweepUngeocodedServices({ limit: 1, now: NOW, dryRun: false }, mockConnection);
    const second = await sweepUngeocodedServices({ limit: 1, now: NOW, dryRun: false }, mockConnection);
    await mockConnection('scheduled_services').where({ id: permanent }).update({ service_address_line1: '252 Edited Fixture Way' });
    const third = await sweepUngeocodedServices({ limit: 1, now: NOW, dryRun: false }, mockConnection);

    expect(first.stops).toEqual([{ id: permanent, date: DAY, reason: 'service_address_unresolved' }]);
    expect(second.stops).toEqual([{ id: next, date: DAY, reason: 'coordinates_recovered' }]);
    expect(third.stops).toEqual([{ id: permanent, date: DAY, reason: 'coordinates_recovered' }]);
    expect(geocodeAddressWithStatus).toHaveBeenCalledTimes(3);
    const rows = await mockConnection('scheduled_services').whereIn('id', [permanent, next]).orderBy('id').select('lat', 'lng');
    expect(rows.map(row => ({ lat: Number(row.lat), lng: Number(row.lng) }))).toEqual([PIN, PIN]);
  });

  test('compare-and-set refuses concurrent service-address, status, and coordinate edits', async () => {
    const addressChanged = id(60);
    const statusChanged = id(61);
    const pinChanged = id(62);
    await insertService(addressChanged, { service_address_line1: '260 Address Edit Fixture Way' });
    await insertService(statusChanged, { service_address_line1: '261 Status Edit Fixture Way' });
    await insertService(pinChanged, { service_address_line1: '262 Pin Edit Fixture Way' });
    geocodeAddressWithStatus.mockImplementation(async address => {
      if (address.includes('Address Edit')) {
        await mockConnection('scheduled_services').where({ id: addressChanged }).update({ service_address_city: 'Sarasota' });
      } else if (address.includes('Status Edit')) {
        await mockConnection('scheduled_services').where({ id: statusChanged }).update({ status: 'cancelled' });
      } else if (address.includes('Pin Edit')) {
        await mockConnection('scheduled_services').where({ id: pinChanged }).update({ lat: 27.61, lng: -82.46 });
      }
      return { location: PIN, permanent: false };
    });

    const result = await sweepUngeocodedServices({ now: NOW, dryRun: false }, mockConnection);

    expect(result).toMatchObject({ checked: 3, geocoded: 0, stale: 3, failed: 0 });
    expect(result.stops.map(stop => stop.reason)).toEqual(['appointment_changed', 'appointment_changed', 'appointment_changed']);
    expect((await mockConnection('scheduled_services').where({ id: addressChanged }).first()).service_address_city).toBe('Sarasota');
    expect((await mockConnection('scheduled_services').where({ id: statusChanged }).first()).status).toBe('cancelled');
    const manualPin = await mockConnection('scheduled_services').where({ id: pinChanged }).first('lat', 'lng');
    expect({ lat: Number(manualPin.lat), lng: Number(manualPin.lng) }).toEqual({ lat: 27.61, lng: -82.46 });
    expect(await mockConnection('audit_log')).toHaveLength(0);
    expect(emitDispatchJobUpdate).not.toHaveBeenCalled();
  });

  test('a gate kill after lookup is observed under the tech-day lock before any write', async () => {
    const serviceId = id(70);
    await insertService(serviceId, { service_address_line1: '270 Gate Kill Fixture Way' });
    geocodeAddressWithStatus.mockImplementation(async () => {
      delete process.env.GATE_ROUTE_REORDER_REPAIR;
      return { location: PIN, permanent: false };
    });

    const result = await sweepUngeocodedServices({ now: NOW, dryRun: false }, mockConnection);

    expect(result).toMatchObject({ checked: 1, geocoded: 0, stale: 1 });
    expect(result.stops[0].reason).toBe('appointment_changed');
    expect(await mockConnection('scheduled_services').where({ id: serviceId }).first('lat', 'lng')).toEqual({ lat: null, lng: null });
    expect(await mockConnection('audit_log')).toHaveLength(0);
    expect(emitDispatchJobUpdate).not.toHaveBeenCalled();
  });

  test('a critical audit failure rolls the coordinate update back atomically', async () => {
    const serviceId = id(80);
    await insertService(serviceId, { service_address_line1: '280 Audit Rollback Fixture Way' });
    await mockConnection.raw("ALTER TABLE audit_log ADD CONSTRAINT reject_coordinate_recovery CHECK (action <> 'service_coordinates_recovered')");

    const result = await sweepUngeocodedServices({ now: NOW, dryRun: false }, mockConnection);

    expect(result).toMatchObject({ checked: 1, geocoded: 0, failed: 1 });
    expect(result.stops[0].reason).toBe('recovery_failed');
    expect(await mockConnection('scheduled_services').where({ id: serviceId }).first('lat', 'lng')).toEqual({ lat: null, lng: null });
    expect(await mockConnection('audit_log')).toHaveLength(0);
    expect(emitDispatchJobUpdate).not.toHaveBeenCalled();
    expect(refreshScheduleQualityAfterChange).not.toHaveBeenCalled();
  });

  test('canonical review blocks are filtered in batches before limit without starving a secondary address', async () => {
    const blockedPrimary = id(90);
    const eligibleSecondary = id(91);
    const reviewedAddress = ['100 Primary Fixture Street', null, 'Bradenton', 'FL', '34205'];
    await mockConnection('customers').where({ id: CUSTOMER }).update({
      address_line1: reviewedAddress[0], latitude: null, longitude: null,
    });
    await enableReviewGate();
    await insertReview('needs_pin', {
      address_snapshot: JSON.stringify(reviewedAddress),
      reason: 'verification_revoked',
    });
    await insertService(blockedPrimary, {
      service_address_line1: '100 Primary Fixture St',
      service_address_zip: '34205-6789',
    });
    await insertService(eligibleSecondary, { service_address_line1: '291 Secondary Fixture Way' });

    const result = await sweepUngeocodedServices({ limit: 1, now: NOW, dryRun: false }, mockConnection);

    expect(result).toMatchObject({ checked: 1, geocoded: 1, unresolved: 0, stale: 0, failed: 0 });
    expect(result.stops).toEqual([{ id: eligibleSecondary, date: DAY, reason: 'coordinates_recovered' }]);
    expect(geocodeAddressWithStatus).toHaveBeenCalledTimes(1);
    expect(geocodeAddressWithStatus.mock.calls[0][0]).toContain('291 Secondary Fixture Way');
    expect(await mockConnection('scheduled_services').where({ id: blockedPrimary }).first('lat', 'lng')).toEqual({ lat: null, lng: null });
    const secondary = await mockConnection('scheduled_services').where({ id: eligibleSecondary }).first('lat', 'lng');
    expect({ lat: Number(secondary.lat), lng: Number(secondary.lng) }).toEqual(PIN);
  });

  test('an equivalently spelled verified review pin is reused without a provider lookup', async () => {
    const serviceId = id(92);
    const reviewedAddress = ['100 Primary Fixture Street', 'Apartment 4', 'Bradenton', 'FL', '34205'];
    await mockConnection('customers').where({ id: CUSTOMER }).update({
      address_line1: reviewedAddress[0], address_line2: reviewedAddress[1], latitude: null, longitude: null,
    });
    await enableReviewGate();
    await insertReview('verified', { address_snapshot: JSON.stringify(reviewedAddress) });
    await insertService(serviceId, {
      service_address_line1: '100 Primary Fixture St',
      service_address_line2: 'Unit 4',
      service_address_zip: '34205-6789',
    });

    const result = await sweepUngeocodedServices({ now: NOW, dryRun: false }, mockConnection);

    expect(result).toMatchObject({ checked: 1, geocoded: 1, unresolved: 0, stale: 0, failed: 0 });
    expect(geocodeAddressWithStatus).not.toHaveBeenCalled();
    const service = await mockConnection('scheduled_services').where({ id: serviceId }).first('lat', 'lng');
    expect({ lat: Number(service.lat), lng: Number(service.lng) }).toEqual(PIN);
    expect(await mockConnection('audit_log').where({ resource_id: serviceId }).first('metadata'))
      .toMatchObject({ metadata: expect.objectContaining({ source: 'staff_verified_pin' }) });
  });

  test('a reviewed primary does not block appointments with a different unit or state', async () => {
    const differentUnit = id(96);
    const differentState = id(97);
    const reviewedAddress = ['100 Primary Fixture Street', 'Apartment 4', 'Bradenton', 'FL', '34205'];
    await mockConnection('customers').where({ id: CUSTOMER }).update({
      address_line1: reviewedAddress[0], address_line2: reviewedAddress[1], latitude: null, longitude: null,
    });
    await enableReviewGate();
    await insertReview('needs_pin', {
      address_snapshot: JSON.stringify(reviewedAddress),
      reason: 'verification_revoked',
    });
    await insertService(differentUnit, {
      service_address_line1: '100 Primary Fixture St',
      service_address_line2: 'Unit 5',
    });
    await insertService(differentState, {
      service_address_line1: '100 Primary Fixture St',
      service_address_line2: 'Unit 4',
      service_address_state: 'GA',
    });

    const result = await sweepUngeocodedServices({ limit: 2, now: NOW, dryRun: false }, mockConnection);

    expect(result).toMatchObject({ checked: 2, geocoded: 2, unresolved: 0, stale: 0, failed: 0 });
    expect(result.stops.map(stop => stop.id)).toEqual([differentUnit, differentState]);
    expect(geocodeAddressWithStatus).toHaveBeenCalledTimes(2);
    const services = await mockConnection('scheduled_services').whereIn('id', [differentUnit, differentState]).orderBy('id');
    expect(services.map(service => ({ lat: Number(service.lat), lng: Number(service.lng) }))).toEqual([PIN, PIN]);
  });

  test.each([
    ['revoked', 'needs_pin', id(93)],
    ['withheld outside the service area', 'outside_area', id(94)],
  ])('a review changed to %s during the provider request prevents the stale pin commit', async (_label, status, serviceId) => {
    await mockConnection('customers').where({ id: CUSTOMER }).update({ latitude: null, longitude: null });
    await enableReviewGate();
    await insertReview('geocoded');
    await insertService(serviceId, { service_address_line1: '100 Primary Fixture Way' });
    geocodeAddressWithStatus.mockImplementation(async () => {
      await mockConnection('customer_geocode_reviews').where({ customer_id: CUSTOMER }).update({
        status,
        reason: status === 'needs_pin' ? 'verification_revoked' : 'staff_confirmed_outside_area',
        updated_at: mockConnection.fn.now(),
      });
      return { location: PIN, permanent: false };
    });

    const result = await sweepUngeocodedServices({ now: NOW, dryRun: false }, mockConnection);

    expect(result).toMatchObject({ checked: 1, geocoded: 0, unresolved: 0, stale: 1, failed: 0 });
    expect(result.stops).toEqual([{ id: serviceId, date: DAY, reason: 'appointment_changed' }]);
    expect(geocodeAddressWithStatus).toHaveBeenCalledTimes(1);
    expect(await mockConnection('scheduled_services').where({ id: serviceId }).first('lat', 'lng')).toEqual({ lat: null, lng: null });
    expect(await mockConnection('audit_log').where({ resource_id: serviceId })).toHaveLength(0);
  });

  test('a disabled review gate preserves recovery without requiring the review relation', async () => {
    const serviceId = id(95);
    process.env.GATE_GEOCODE_REVIEW = 'false';
    await insertService(serviceId, { service_address_line1: '295 Gate Off Fixture Way' });

    const result = await sweepUngeocodedServices({ now: NOW, dryRun: false }, mockConnection);

    expect(result).toMatchObject({ checked: 1, geocoded: 1, unresolved: 0, stale: 0, failed: 0 });
    expect(geocodeAddressWithStatus).toHaveBeenCalledTimes(1);
    const service = await mockConnection('scheduled_services').where({ id: serviceId }).first('lat', 'lng');
    expect({ lat: Number(service.lat), lng: Number(service.lng) }).toEqual(PIN);
  });
});
