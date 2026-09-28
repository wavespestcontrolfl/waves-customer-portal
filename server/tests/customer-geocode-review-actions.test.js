jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ warn: jest.fn() }));
jest.mock('../services/customer-geocode-review', () => ({
  reviewEnabled: jest.fn(() => true), reviewRevision: jest.fn(() => 'current'),
  saveReview: jest.fn(), getReviewDetail: jest.fn(async () => ({ revision: 'saved' })),
}));
jest.mock('../services/customer-properties', () => ({
  syncPrimaryAddress: jest.fn(), syncPrimaryCoordsFromCustomer: jest.fn(),
}));
jest.mock('../services/customer-geocode-review-visits', () => ({
  pinAtScale: jest.requireActual('../services/customer-geocode-review-visits').pinAtScale,
  prelockVisitContext: jest.fn(async () => ({})), lockVisitContext: jest.fn(async () => ({})),
  updatePrimaryVisits: jest.fn(async () => ['visit-1', 'visit-2']), clearMatchingPins: jest.fn(),
}));
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn() }));
jest.mock('../services/geocoder', () => ({
  buildAddress: jest.fn(() => 'synthetic address'), clearGeocodeMemo: jest.fn(), ensureCustomerGeocoded: jest.fn(),
}));
jest.mock('../services/scheduling/quality-after-change', () => ({ refreshScheduleQualityAfterChange: jest.fn() }));
jest.mock('../services/appointment-address', () => ({ refreshAppointmentAddressBriefs: jest.fn() }));
jest.mock('../services/dispatch-assignment', () => ({
  emitDispatchJobUpdate: jest.fn(async ({ jobId, qualityDates }) => {
    qualityDates.add(`date-${jobId}`);
    return { id: jobId };
  }),
  flushDispatchQualityDates: jest.fn(async () => null),
}));

const { resolveCustomerGeocodeReview } = require('../services/customer-geocode-review-actions');
const review = require('../services/customer-geocode-review');
const visits = require('../services/customer-geocode-review-visits');
const audit = require('../services/audit-log');
const logger = require('../services/logger');
const geocoder = require('../services/geocoder');
const quality = require('../services/scheduling/quality-after-change');
const briefs = require('../services/appointment-address');
const dispatch = require('../services/dispatch-assignment');
const customer = { id: 'customer-1', address_line1: '100 Fixture Way', city: 'Bradenton', state: 'FL', zip: '34205' };
const input = { action: 'verify_pin', revision: 'current', latitude: 27.4, longitude: -82.4,
  confirmed: true, source: 'site_visit', evidence: 'Synthetic observation' };

function connection() {
  const state = { committed: false };
  const conn = table => {
    const row = table === 'customers' ? customer : table === 'customer_properties'
      ? { ...customer, id: 'property-1', customer_id: customer.id } : null;
    const query = {
      where: () => query, forUpdate: () => query, first: async () => row,
      select: async () => [row], update: async () => 1,
    };
    return query;
  };
  conn.raw = jest.fn().mockResolvedValue({ rows: [] });
  conn.transaction = async callback => { await callback(conn); state.committed = true; };
  return { conn, state };
}

beforeEach(() => {
  jest.clearAllMocks();
  review.reviewEnabled.mockReturnValue(true);
  review.reviewRevision.mockReturnValue('current');
  quality.refreshScheduleQualityAfterChange.mockResolvedValue({ status: 'gate_off' });
  briefs.refreshAppointmentAddressBriefs.mockResolvedValue();
  visits.clearMatchingPins.mockResolvedValue({ visitIds: [] });
});

test.each(['throw', 'reject'])('brief refresh %s is observable after commit without failing the saved review', async kind => {
  const { conn, state } = connection();
  const privateError = new Error('private address and provider response must not be logged');
  briefs.refreshAppointmentAddressBriefs.mockImplementationOnce(() => {
    expect(state.committed).toBe(true);
    if (kind === 'throw') throw privateError;
    return Promise.reject(privateError);
  });
  await expect(resolveCustomerGeocodeReview(customer.id, input, 'actor-1', conn))
    .resolves.toEqual({ revision: 'saved' });
  await new Promise(resolve => setImmediate(resolve));
  expect(briefs.refreshAppointmentAddressBriefs).toHaveBeenCalledWith(conn, ['visit-1', 'visit-2']);
  expect(logger.warn).toHaveBeenCalledWith(expect.any(String), {
    code: 'address_brief_refresh_failed', customerId: customer.id, visitCount: 2,
  });
  expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(privateError.message);
});

test('broadcasts every updated visit after commit and flushes one shared quality-date batch', async () => {
  const { conn, state } = connection();
  const sets = [];
  dispatch.emitDispatchJobUpdate.mockImplementation(async ({ jobId, actorId, qualityDates }) => {
    expect(state.committed).toBe(true);
    expect(actorId).toBe('actor-1');
    sets.push(qualityDates);
    qualityDates.add(`date-${jobId}`);
    return { id: jobId };
  });

  await expect(resolveCustomerGeocodeReview(customer.id, input, 'actor-1', conn))
    .resolves.toEqual({ revision: 'saved' });

  expect(dispatch.emitDispatchJobUpdate.mock.calls.map(([options]) => options.jobId))
    .toEqual(['visit-1', 'visit-2']);
  expect(sets).toHaveLength(2);
  expect(sets[0]).toBe(sets[1]);
  expect(dispatch.flushDispatchQualityDates).toHaveBeenCalledTimes(1);
  expect(dispatch.flushDispatchQualityDates).toHaveBeenCalledWith(sets[0]);
  expect([...sets[0]]).toEqual(['date-visit-1', 'date-visit-2']);
  expect(dispatch.flushDispatchQualityDates.mock.invocationCallOrder[0])
    .toBeGreaterThan(dispatch.emitDispatchJobUpdate.mock.invocationCallOrder[1]);
  expect(quality.refreshScheduleQualityAfterChange).not.toHaveBeenCalled();
});

test('a rejected dispatch broadcast stays post-commit and does not skip the shared quality flush', async () => {
  const { conn, state } = connection();
  const privateError = new Error('private provider response');
  dispatch.emitDispatchJobUpdate.mockImplementationOnce(async ({ qualityDates }) => {
    expect(state.committed).toBe(true);
    qualityDates.add('2040-10-01');
    throw privateError;
  });

  await expect(resolveCustomerGeocodeReview(customer.id, input, 'actor-1', conn))
    .resolves.toEqual({ revision: 'saved' });
  expect(dispatch.emitDispatchJobUpdate).toHaveBeenCalledTimes(2);
  expect(dispatch.flushDispatchQualityDates).toHaveBeenCalledTimes(1);
  expect(logger.warn).toHaveBeenCalledWith(expect.any(String), {
    code: 'dispatch_refresh_failed', customerId: customer.id, visitCount: 2,
  });
  expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(privateError.message);
});

test.each(['outside_service_area', 'revoke'])('%s broadcasts cleared visits after commit', async action => {
  const reviewedPin = { latitude: 27.4, longitude: -82.4 };
  const addressSnapshot = [customer.address_line1, null, customer.city, customer.state, customer.zip];
  const customerWithPin = { ...customer, ...reviewedPin };
  const { conn, state } = connection();
  visits.clearMatchingPins.mockResolvedValueOnce({ visitIds: ['visit-3'] });
  review.saveReview.mockResolvedValue();
  const inputForAction = {
    action, revision: 'current', confirmed: true, source: 'site_visit', evidence: 'Synthetic observation',
  };
  const actionConn = table => {
    const row = table === 'customers' ? customerWithPin : table === 'customer_properties'
      ? { ...customerWithPin, id: 'property-1', customer_id: customer.id }
      : { ...reviewedPin, address_snapshot: addressSnapshot, source: 'site_visit', evidence: 'Synthetic observation' };
    const query = { where: () => query, forUpdate: () => query, first: async () => row, select: async () => [row], update: async () => 1 };
    return query;
  };
  actionConn.raw = conn.raw;
  actionConn.transaction = async callback => { await callback(actionConn); state.committed = true; };

  await resolveCustomerGeocodeReview(customer.id, inputForAction, 'actor-1', actionConn);

  if (action === 'outside_service_area') {
    expect(visits.clearMatchingPins).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), expect.anything(), expect.anything(), expect.anything(),
      expect.objectContaining({
        clearMirrors: true,
        additionalPins: [expect.objectContaining(reviewedPin), expect.objectContaining(reviewedPin)],
      }),
    );
  } else {
    expect(visits.clearMatchingPins).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), expect.anything(), expect.anything(), expect.anything(),
      expect.objectContaining({
        clearMirrors: true,
        additionalPins: [expect.objectContaining(reviewedPin), expect.objectContaining(reviewedPin)],
      }),
    );
  }
  expect(dispatch.emitDispatchJobUpdate).toHaveBeenCalledWith(expect.objectContaining({
    jobId: 'visit-3', actorId: 'actor-1',
  }));
  expect(state.committed).toBe(true);
});

test('rejected-pin fallback normalizes a blank customer field against a null review snapshot value', async () => {
  const storedReviewPin = { latitude: 27.51, longitude: -82.51 };
  const customerNoPin = { ...customer, address_line2: '', latitude: null, longitude: null };
  const addressSnapshot = [customer.address_line1, null, customer.city, customer.state, customer.zip];
  const { conn, state } = connection();
  visits.clearMatchingPins.mockResolvedValueOnce({ visitIds: ['visit-3'] });
  review.saveReview.mockResolvedValue();
  const inputForAction = {
    action: 'outside_service_area', revision: 'current', confirmed: true, source: 'site_visit', evidence: 'Synthetic observation',
  };
  const actionConn = table => {
    const row = table === 'customers' ? customerNoPin : table === 'customer_properties'
      ? { ...customerNoPin, id: 'property-1', customer_id: customer.id, latitude: null, longitude: null }
      : { ...storedReviewPin, address_snapshot: addressSnapshot, source: 'site_visit', evidence: 'Synthetic observation' };
    const query = { where: () => query, forUpdate: () => query, first: async () => row, select: async () => [row], update: async () => 1 };
    return query;
  };
  actionConn.raw = conn.raw;
  actionConn.transaction = async callback => { await callback(actionConn); state.committed = true; };

  await resolveCustomerGeocodeReview(customer.id, inputForAction, 'actor-1', actionConn);

  // The stored review's address (line2: null) still describes this customer (line2: ''), so the
  // rejected-pin fallback must recover the review's evidence pin instead of dropping it to null.
  expect(review.saveReview).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({
    latitude: storedReviewPin.latitude, longitude: storedReviewPin.longitude,
  }));
  expect(visits.clearMatchingPins).toHaveBeenCalledWith(
    expect.anything(), expect.anything(), expect.anything(),
    expect.objectContaining({ latitude: storedReviewPin.latitude, longitude: storedReviewPin.longitude }),
    expect.anything(), expect.anything(),
  );
});

test('audit rejection prevents commit and all post-commit work', async () => {
  const { conn, state } = connection();
  audit.recordAuditEvent.mockRejectedValueOnce(new Error('audit unavailable'));
  await expect(resolveCustomerGeocodeReview(customer.id, input, 'actor-1', conn)).rejects.toThrow('audit unavailable');
  expect(state.committed).toBe(false);
  expect(briefs.refreshAppointmentAddressBriefs).not.toHaveBeenCalled();
  expect(quality.refreshScheduleQualityAfterChange).not.toHaveBeenCalled();
  expect(dispatch.emitDispatchJobUpdate).not.toHaveBeenCalled();
});

test('unrelated uniqueness failures retain their original cause', async () => {
  const error = Object.assign(new Error('unrelated unique failure'), { code: '23505', constraint: 'other_constraint' });
  require('../services/customer-properties').syncPrimaryAddress.mockRejectedValueOnce(error);
  await expect(resolveCustomerGeocodeReview(customer.id, input, 'actor-1', connection().conn)).rejects.toBe(error);
});

test.each([
  ['gate disabled', () => review.reviewEnabled.mockReturnValue(false), 'review_disabled'],
  ['stale revision', () => review.reviewRevision.mockReturnValue('newer'), 'review_changed'],
])('%s prevents resolution and post-commit work', async (_name, arrange, code) => {
  arrange();
  await expect(resolveCustomerGeocodeReview(customer.id, input, 'actor-1', connection().conn))
    .rejects.toMatchObject({ code });
  expect(visits.updatePrimaryVisits).not.toHaveBeenCalled();
  expect(review.saveReview).not.toHaveBeenCalled();
  expect(briefs.refreshAppointmentAddressBriefs).not.toHaveBeenCalled();
  expect(dispatch.emitDispatchJobUpdate).not.toHaveBeenCalled();
});

test('retry clears the address memo and invokes lookup only after commit', async () => {
  const { conn, state } = connection();
  geocoder.ensureCustomerGeocoded.mockImplementationOnce(async () => expect(state.committed).toBe(true));
  await resolveCustomerGeocodeReview(customer.id, { action: 'retry', revision: 'current' }, 'actor-1', conn);
  expect(geocoder.clearGeocodeMemo).toHaveBeenCalledWith('synthetic address');
  expect(geocoder.ensureCustomerGeocoded).toHaveBeenCalledWith(customer.id);
  expect(visits.prelockVisitContext).not.toHaveBeenCalled();
  expect(briefs.refreshAppointmentAddressBriefs).not.toHaveBeenCalled();
});

test('retry rejects while only the primary location retains a usable pin', async () => {
  const { conn } = connection();
  const primaryPin = { latitude: 27.41, longitude: -82.41 };
  const actionConn = table => {
    const row = table === 'customers' ? customer : table === 'customer_properties'
      ? { ...customer, ...primaryPin, id: 'property-1', customer_id: customer.id }
      : null;
    const query = {
      where: () => query, forUpdate: () => query, first: async () => row,
      select: async () => [row], update: async () => 1,
    };
    return query;
  };
  actionConn.raw = conn.raw;
  actionConn.transaction = async callback => callback(actionConn);

  await expect(resolveCustomerGeocodeReview(
    customer.id, { action: 'retry', revision: 'current' }, 'actor-1', actionConn,
  )).rejects.toMatchObject({ statusCode: 409, code: 'pin_present' });
  expect(review.saveReview).not.toHaveBeenCalled();
  expect(geocoder.ensureCustomerGeocoded).not.toHaveBeenCalled();
});
