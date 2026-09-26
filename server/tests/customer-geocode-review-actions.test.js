jest.mock('../models/db', () => jest.fn());
jest.mock('../services/customer-geocode-review', () => ({
  reviewEnabled: jest.fn(),
  addressSnapshot: row => [row.address_line1, row.address_line2 || null, row.city, row.state, row.zip],
  reviewRevision: jest.fn(),
  saveReview: jest.fn(),
  getReviewDetail: jest.fn(),
}));
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn() }));
jest.mock('../services/customer-address-fanout', () => {
  const actual = jest.requireActual('../services/customer-address-fanout');
  return { ...actual, propagateCustomerAddressChange: jest.fn() };
});
jest.mock('../services/customer-properties', () => ({
  ...jest.requireActual('../services/customer-properties'),
  syncPrimaryAddress: jest.fn(),
  syncPrimaryCoordsFromCustomer: jest.fn(),
}));
jest.mock('../services/scheduling/tech-day-lock', () => ({ lockTechDays: jest.fn() }));
jest.mock('../services/geocoder', () => ({
  buildAddress: jest.fn(() => 'synthetic service address'),
  clearGeocodeMemo: jest.fn(),
  ensureCustomerGeocoded: jest.fn(),
}));
jest.mock('../services/scheduling/quality-after-change', () => ({
  refreshScheduleQualityAfterChange: jest.fn(),
}));

const {
  resolveCustomerGeocodeReview,
  visitMatchesPrimary,
  visitPinIsSafeToReplace,
} = require('../services/customer-geocode-review-actions');
const reviewStore = require('../services/customer-geocode-review');
const auditLog = require('../services/audit-log');
const addressFanout = require('../services/customer-address-fanout');
const customerProperties = require('../services/customer-properties');
const geocoder = require('../services/geocoder');
const scheduleQuality = require('../services/scheduling/quality-after-change');

const customer = {
  id: 'customer-1', address_line1: '100 Main Street', address_line2: 'Apt 4',
  city: 'Sarasota', state: 'FL', zip: '34236', latitude: 27.3364, longitude: -82.5307,
};
const primary = { id: 'property-1' };

function visit(overrides = {}) {
  return {
    property_id: 'property-1',
    service_address_line1: '100 Main St', service_address_line2: 'Unit 4',
    service_address_city: 'Sarasota', service_address_state: 'FL', service_address_zip: '34236',
    lat: 27.3364, lng: -82.5307,
    ...overrides,
  };
}

function fakeConnection({ reviewStatus = 'verified', customerOverrides = {}, primaryOverrides = {}, reviewOverrides = {} } = {}) {
  const customerRow = { ...customer, ...customerOverrides };
  const primaryRow = {
    ...customerRow, id: 'property-1', customer_id: customer.id, active: true, is_primary: true, ...primaryOverrides,
  };
  const reviewRow = {
    customer_id: customer.id, status: reviewStatus, reason: 'prior', source: 'site_visit', evidence: 'prior evidence',
    latitude: customer.latitude, longitude: customer.longitude, updated_at: new Date('2026-09-25T12:00:00Z'),
    ...reviewOverrides,
  };
  const updates = [];
  function conn(table) {
    const state = { table, where: [] };
    const builder = {
      where(...args) { state.where.push(args); return builder; },
      whereIn(...args) { state.where.push(['whereIn', ...args]); return builder; },
      whereRaw(...args) { state.where.push(['whereRaw', ...args]); return builder; },
      select() { return builder; },
      forUpdate() { return builder; },
      first() { state.first = true; return builder; },
      update(patch) { updates.push({ table, where: state.where, patch }); return Promise.resolve(1); },
      then(resolve, reject) {
        let value;
        if (table === 'customers') value = state.first ? { ...customerRow } : [{ ...customerRow }];
        else if (table === 'customer_properties') value = state.first ? primaryRow : [primaryRow];
        else if (table === 'customer_geocode_reviews') value = state.first ? reviewRow : [reviewRow];
        else if (table === 'scheduled_services') value = [];
        return Promise.resolve(value).then(resolve, reject);
      },
    };
    return builder;
  }
  conn.transaction = async callback => callback(conn);
  conn.fn = { now: jest.fn(() => new Date('2026-09-25T12:00:00Z')) };
  return { conn, updates, reviewRow };
}

beforeEach(() => {
  jest.clearAllMocks();
  reviewStore.reviewEnabled.mockReturnValue(true);
  scheduleQuality.refreshScheduleQualityAfterChange.mockResolvedValue({ status: 'gate_off' });
  reviewStore.reviewRevision.mockReturnValue('rev-1');
  reviewStore.getReviewDetail.mockResolvedValue({ customer, review: { status: 'verified' }, revision: 'rev-2' });
});

test('write path rechecks the gate after locks before making changes', async () => {
  const { conn } = fakeConnection({ customerOverrides: { latitude: null, longitude: null } });
  reviewStore.reviewEnabled.mockReturnValue(false);
  await expect(resolveCustomerGeocodeReview(customer.id, {
    revision: 'rev-1', action: 'retry',
  }, 'actor-1', conn)).rejects.toMatchObject({ statusCode: 404, code: 'review_disabled' });
  expect(reviewStore.saveReview).not.toHaveBeenCalled();
  expect(auditLog.recordAuditEvent).not.toHaveBeenCalled();
});

test('visit matching accepts the primary or an unstamped legacy row and rejects divergent ownership/address', () => {
  expect(visitMatchesPrimary(visit(), customer, primary)).toBe(true);
  expect(visitMatchesPrimary(visit({ property_id: null, service_address_line1: null }), customer, primary)).toBe(true);
  expect(visitMatchesPrimary(visit({
    property_id: null, service_address_line1: null, service_address_city: 'Fort Myers',
  }), customer, primary)).toBe(false);
  expect(visitMatchesPrimary(visit({ service_address_state: 'GA' }), customer, primary)).toBe(false);
  expect(visitMatchesPrimary(visit({ property_id: 'property-2' }), customer, primary)).toBe(false);
  expect(visitMatchesPrimary(visit({
    property_id: null, service_address_line1: '900 Other Ave', service_address_line2: null,
  }), customer, primary)).toBe(false);
  expect(visitMatchesPrimary(visit({ service_address_zip: '33901' }), customer, primary)).toBe(false);
});

test('verified fanout only replaces an empty pin or the customer prior pin', () => {
  expect(visitPinIsSafeToReplace(visit({ lat: null, lng: null }), customer)).toBe(true);
  expect(visitPinIsSafeToReplace(visit(), customer)).toBe(true);
  expect(visitPinIsSafeToReplace(visit({ lat: 27.3364, lng: -82.5307 }), {
    ...customer, latitude: 27.3364004, longitude: -82.5307004,
  })).toBe(true);
  expect(visitPinIsSafeToReplace(visit({ lat: 27.1, lng: -82.1 }), customer)).toBe(false);
  expect(visitPinIsSafeToReplace(visit(), { ...customer, latitude: null, longitude: null })).toBe(false);
});

test('verify releases a protected review before atomically saving address, pin, mirrors, fanout and audit', async () => {
  const { conn, updates } = fakeConnection();
  const corrected = {
    address_line1: '101 Main St', address_line2: '', city: 'Sarasota', state: 'FL', zip: '34236',
  };
  const canonical = { ...corrected, address_line2: null };

  const detail = await resolveCustomerGeocodeReview(customer.id, {
    revision: 'rev-1', action: 'verify_pin', address: corrected,
    latitude: 27.4, longitude: -82.4, source: 'site_visit', evidence: 'Marker observed', confirmed: true,
  }, 'actor-1', conn);

  expect(reviewStore.saveReview).toHaveBeenNthCalledWith(1, conn, expect.objectContaining({ id: customer.id }),
    expect.objectContaining({ status: 'pending', reason: 'manual_verification_in_progress' }));
  expect(updates).toContainEqual(expect.objectContaining({
    table: 'customers',
    patch: expect.objectContaining({ ...canonical, latitude: 27.4, longitude: -82.4 }),
  }));
  expect(customerProperties.syncPrimaryAddress).toHaveBeenCalledWith(
    expect.objectContaining({ ...canonical, latitude: 27.4, longitude: -82.4 }), conn, { explicitLine2: true },
  );
  expect(customerProperties.syncPrimaryCoordsFromCustomer).toHaveBeenCalledWith(customer.id, conn);
  expect(addressFanout.propagateCustomerAddressChange).toHaveBeenCalledWith(expect.objectContaining({
    before: expect.objectContaining({ id: customer.id }), after: expect.objectContaining(canonical),
  }), conn);
  expect(reviewStore.saveReview).toHaveBeenNthCalledWith(2, conn, expect.objectContaining(canonical),
    expect.objectContaining({ status: 'verified', reason: 'staff_verified', reviewed_by: 'actor-1' }));
  expect(auditLog.recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
    action: 'customer_geocode_review.verify_pin', critical: true, trx: conn,
  }));
  expect(detail.revision).toBe('rev-2');
});

test('pre-existing null and empty mirror fields are equivalent without hiding nonempty differences', async () => {
  const equivalent = fakeConnection({
    customerOverrides: { address_line2: null, city: null, state: null, zip: null, latitude: null, longitude: null },
    primaryOverrides: { address_line2: '', city: '', state: '', zip: '' },
    reviewStatus: 'provider_unavailable', reviewOverrides: { latitude: null, longitude: null },
  });
  await expect(resolveCustomerGeocodeReview(customer.id, {
    revision: 'rev-1', action: 'retry',
  }, 'actor-1', equivalent.conn)).resolves.toEqual(expect.objectContaining({ revision: 'rev-2' }));

  const divergent = fakeConnection({ primaryOverrides: { city: 'Bradenton' } });
  await expect(resolveCustomerGeocodeReview(customer.id, {
    revision: 'rev-1', action: 'revoke',
  }, 'actor-1', divergent.conn)).rejects.toMatchObject({ statusCode: 409, code: 'primary_location_mismatch' });
});

test('revoke preserves the review pin as evidence and only clears exact matching live mirrors', async () => {
  const { conn, updates, reviewRow } = fakeConnection();

  await resolveCustomerGeocodeReview(customer.id, {
    revision: 'rev-1', action: 'revoke',
  }, 'actor-1', conn);

  expect(reviewStore.saveReview).toHaveBeenCalledWith(conn, expect.objectContaining({ id: customer.id }), {
    status: 'needs_pin', reason: 'verification_revoked', source: reviewRow.source,
    evidence: reviewRow.evidence, latitude: reviewRow.latitude, longitude: reviewRow.longitude,
  });
  const clears = updates.filter(update => ['customers', 'customer_properties'].includes(update.table));
  expect(clears).toHaveLength(2);
  expect(clears.every(update => update.where.some(args => (
    typeof args[0] === 'object' && args[0].latitude === customer.latitude && args[0].longitude === customer.longitude
  )))).toBe(true);
  expect(clears.every(update => update.patch.latitude === null && update.patch.longitude === null)).toBe(true);
  expect(auditLog.recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
    action: 'customer_geocode_review.revoke', critical: true, trx: conn,
  }));
});

test('outside-area confirmation snapshots a revision-bound legacy pin before guarded clearing', async () => {
  const { conn, updates } = fakeConnection({
    reviewStatus: 'pending', reviewOverrides: { latitude: null, longitude: null },
  });

  await resolveCustomerGeocodeReview(customer.id, {
    revision: 'rev-1', action: 'outside_service_area', source: 'county_records',
    evidence: 'County record confirms the service location', confirmed: true,
  }, 'actor-1', conn);

  expect(reviewStore.saveReview).toHaveBeenCalledWith(conn, expect.objectContaining({ id: customer.id }),
    expect.objectContaining({
      status: 'outside_area', reviewed_by: 'actor-1',
      latitude: customer.latitude, longitude: customer.longitude,
    }));
  expect(updates).toEqual(expect.arrayContaining([
    expect.objectContaining({ table: 'customers', patch: expect.objectContaining({ latitude: null, longitude: null }) }),
    expect.objectContaining({ table: 'customer_properties', patch: expect.objectContaining({ latitude: null, longitude: null }) }),
  ]));
});

test('retry refuses to strand an existing pin in pending and revoke refuses a pin with no provenance', async () => {
  const pinned = fakeConnection();
  await expect(resolveCustomerGeocodeReview(customer.id, {
    revision: 'rev-1', action: 'retry',
  }, 'actor-1', pinned.conn)).rejects.toMatchObject({ statusCode: 409, code: 'pin_present' });
  expect(reviewStore.saveReview).not.toHaveBeenCalled();

  const unproven = fakeConnection({ reviewOverrides: { latitude: null, longitude: null } });
  await expect(resolveCustomerGeocodeReview(customer.id, {
    revision: 'rev-1', action: 'revoke',
  }, 'actor-1', unproven.conn)).rejects.toMatchObject({ statusCode: 409, code: 'review_pin_missing' });
  expect(reviewStore.saveReview).not.toHaveBeenCalled();
});

test('retry without a pin commits pending before clearing the memo and invoking the reviewed geocoder', async () => {
  const { conn } = fakeConnection({
    reviewStatus: 'provider_unavailable',
    customerOverrides: { latitude: null, longitude: null },
    reviewOverrides: { latitude: null, longitude: null },
  });

  await resolveCustomerGeocodeReview(customer.id, {
    revision: 'rev-1', action: 'retry',
  }, 'actor-1', conn);

  expect(reviewStore.saveReview).toHaveBeenCalledWith(conn, expect.objectContaining({ id: customer.id }),
    expect.objectContaining({ status: 'pending', reason: 'retry_requested' }));
  expect(reviewStore.saveReview.mock.calls[0][2]).not.toHaveProperty('reviewed_by');
  expect(geocoder.clearGeocodeMemo).toHaveBeenCalledWith('synthetic service address');
  expect(geocoder.ensureCustomerGeocoded).toHaveBeenCalledWith(customer.id);
  expect(scheduleQuality.refreshScheduleQualityAfterChange).toHaveBeenCalledWith(
    { customerIds: [customer.id] }, conn,
  );
});

test('a post-commit schedule-quality failure does not report the committed review as failed', async () => {
  const { conn } = fakeConnection({
    reviewStatus: 'provider_unavailable',
    customerOverrides: { latitude: null, longitude: null },
    reviewOverrides: { latitude: null, longitude: null },
  });
  scheduleQuality.refreshScheduleQualityAfterChange.mockRejectedValue(new Error('quality unavailable'));

  await expect(resolveCustomerGeocodeReview(customer.id, {
    revision: 'rev-1', action: 'retry',
  }, 'actor-1', conn)).resolves.toEqual(expect.objectContaining({ revision: 'rev-2' }));
});
