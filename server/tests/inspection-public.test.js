/**
 * Public lead consultation-booking link — /api/public/inspection/:token.
 * Gate off/expired/garbage token handling, GET state shapes, the idempotent
 * already_booked short-circuit, out-of-area refusal (no booking), slot_taken,
 * waitlist idempotency, and the createSelfBooking `callbackVisit` contract
 * (isCallback:false / dedupeLane:false, no lead_id, never converts).
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'inspection-test-secret';
process.env.GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || 'test-google-key';

jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const gateState = { live: true };
jest.mock('../config/feature-gates', () => ({
  leadInspectionLinkLive: jest.fn(() => gateState.live),
}));

const mockGeocode = jest.fn(async () => ({ location: { lat: 27.4, lng: -82.5 } }));
jest.mock('../services/geocoder', () => ({
  geocodeAddressWithStatus: (...args) => mockGeocode(...args),
}));

const mockCounty = jest.fn(async () => 'Manatee');
jest.mock('../services/address-validation', () => ({
  reverseGeocodeCounty: (...args) => mockCounty(...args),
}));

const mockRescheduleLink = jest.fn(async () => ({ url: '/reschedule/abc123' }));
jest.mock('../services/reschedule-link', () => ({
  buildRescheduleLink: (...args) => mockRescheduleLink(...args),
}));

const mockBookingConfig = jest.fn(async () => ({}));
const mockBuildAvailability = jest.fn(async () => ({ slots: [], days: [] }));
const mockCreateSelfBooking = jest.fn(async () => ({ ok: true, body: { booking: { id: 'sb-1' } } }));
jest.mock('../routes/booking', () => ({
  _internals: {
    loadBookingConfig: (...args) => mockBookingConfig(...args),
    buildBookingAvailability: (...args) => mockBuildAvailability(...args),
    createSelfBooking: (...args) => mockCreateSelfBooking(...args),
  },
}));

// Universal query-chain mock: chain methods return the chain; `.first()`
// resolves firstResults[table]; the chain itself (list terminal, via `.then`)
// resolves listResults[table]; `.insert(...).returning('*')` resolves
// insertResults[table]; `.update()` / `.onConflict().ignore()` are no-ops.
const firstResults = {};
const listResults = {};
const insertResults = {};
jest.mock('../models/db', () => {
  const mkChain = (table) => {
    const q = {};
    const passthrough = [
      'where', 'whereIn', 'whereNot', 'whereNotIn', 'whereNull', 'whereNotNull',
      'whereRaw', 'andWhere', 'orWhere', 'orderBy', 'orderByRaw', 'limit', 'offset',
      'select', 'join', 'leftJoin', 'groupBy', 'modify', 'onConflict',
    ];
    for (const m of passthrough) q[m] = () => q;
    q.first = async () => (firstResults[table] !== undefined ? firstResults[table] : null);
    q.update = async () => 1;
    q.del = async () => 1;
    q.ignore = async () => [];
    q.merge = async () => [];
    q.insert = () => q;
    q.returning = async () => (insertResults[table] || [{ id: 'new-cust-1' }]);
    q.then = (onOk, onErr) => Promise.resolve(listResults[table] || []).then(onOk, onErr);
    q.catch = (fn) => Promise.resolve(listResults[table] || []).catch(fn);
    return q;
  };
  const dbFn = jest.fn((table) => mkChain(table));
  dbFn.raw = (sql) => sql;
  dbFn.transaction = async () => { throw new Error('transaction should not be reached in these tests'); };
  return dbFn;
});

const { mintLeadConsultationToken } = require('../utils/lead-consultation-token');
const { ASSESSMENT_SERVICE_KEY, isAssessmentServiceType } = require('../services/assessment-booking');
const { etDateString, addETDays } = require('../utils/datetime-et');
const inspectionPublicRouter = require('../routes/inspection-public');

const LEAD_ID = '5b8d1c9e-4a2f-4b6e-9c3d-8e7f6a5b4c3d';
// Inside the default booking window (config mock returns {} → advance_days
// 1..14) regardless of when this suite runs.
const FUTURE_DATE = etDateString(addETDays(new Date(), 3));

function findHandler(pathPattern, method = 'get') {
  const layer = inspectionPublicRouter.stack.find(
    (l) => l.route?.path === pathPattern && l.route.methods[method]
  );
  return layer.route.stack.at(-1).handle;
}

function mkRes() {
  const res = { statusCode: 200, body: null };
  res.status = jest.fn((code) => { res.statusCode = code; return res; });
  res.json = jest.fn((payload) => { res.body = payload; return res; });
  return res;
}

async function callGet(token, query = {}) {
  const handler = findHandler('/:token', 'get');
  const res = mkRes();
  const next = jest.fn();
  await handler({ params: { token }, query }, res, next);
  expect(next).not.toHaveBeenCalled();
  return res;
}

async function callPost(token, body = {}) {
  const handler = findHandler('/:token', 'post');
  const res = mkRes();
  const next = jest.fn();
  await handler({ params: { token }, body }, res, next);
  expect(next).not.toHaveBeenCalled();
  return res;
}

async function callWaitlist(token, body = {}) {
  const handler = findHandler('/:token/waitlist', 'post');
  const res = mkRes();
  const next = jest.fn();
  await handler({ params: { token }, body }, res, next);
  expect(next).not.toHaveBeenCalled();
  return res;
}

afterEach(() => {
  for (const key of Object.keys(firstResults)) delete firstResults[key];
  for (const key of Object.keys(listResults)) delete listResults[key];
  for (const key of Object.keys(insertResults)) delete insertResults[key];
  gateState.live = true;
  mockGeocode.mockClear();
  mockCounty.mockClear();
  mockRescheduleLink.mockClear();
  mockBookingConfig.mockClear();
  mockBuildAvailability.mockClear();
  mockCreateSelfBooking.mockClear();
});

const LEAD_ROW = {
  id: LEAD_ID, first_name: 'Pat', last_name: 'Lee', phone: '9415550101', email: null,
  address: null, city: null, zip: null, status: 'new', customer_id: null, converted_at: null,
};

describe('gate off', () => {
  test('every route 404s while GATE_LEAD_INSPECTION_LINK is off', async () => {
    gateState.live = false;
    const token = mintLeadConsultationToken(LEAD_ID);
    expect((await callGet(token)).statusCode).toBe(404);
    expect((await callPost(token, { date: '2027-01-01', time: '09:00' })).statusCode).toBe(404);
    expect((await callWaitlist(token, { email: 'a@b.com' })).statusCode).toBe(404);
  });
});

describe('token verification', () => {
  test('a garbage token 404s', async () => {
    const res = await callGet('not-a-real-token');
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'not_found' });
  });

  test('a well-formed but expired token answers 200 { state: "expired" }', async () => {
    // Minted with nowSec far in the past — the mint's own TTL math makes exp
    // long gone by the time the handler checks it.
    const longAgo = 1000;
    const token = mintLeadConsultationToken(LEAD_ID, longAgo);
    const res = await callGet(token);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ state: 'expired' });
  });
});

describe('GET /:token state shapes', () => {
  test('gone: lead missing/deleted', async () => {
    firstResults.leads = null;
    const token = mintLeadConsultationToken(LEAD_ID);
    const res = await callGet(token);
    expect(res.body).toEqual({ state: 'gone' });
  });

  test('already_booked: an open non-terminal Waves Assessment visit exists', async () => {
    firstResults.leads = { ...LEAD_ROW, customer_id: 'cust-1' };
    firstResults.customers = { id: 'cust-1', address_line1: '123 Palm Ave', city: 'Bradenton', state: 'FL', zip: '34209', latitude: 27.4, longitude: -82.5 };
    listResults.scheduled_services = [
      { id: 'svc-1', scheduled_date: '2027-01-05', window_start: '09:00', window_end: '09:30', service_type: 'Waves Assessment', reschedule_token: 'tok' },
    ];
    const token = mintLeadConsultationToken(LEAD_ID);
    const res = await callGet(token);
    expect(res.body.state).toBe('already_booked');
    expect(res.body.visit.date).toBe('2027-01-05');
    expect(res.body.rescheduleUrl).toBe('/reschedule/abc123');
    expect(mockRescheduleLink).toHaveBeenCalledWith('svc-1', expect.objectContaining({ reuseExisting: true }));
  });

  test('converted: the lead already converted (no customer visit needed)', async () => {
    firstResults.leads = { ...LEAD_ROW, converted_at: new Date() };
    firstResults.customers = null;
    listResults.scheduled_services = [];
    const token = mintLeadConsultationToken(LEAD_ID);
    const res = await callGet(token);
    expect(res.body.state).toBe('converted');
    expect(res.body.visit).toBe(null);
  });

  test('converted: a future booked NON-assessment visit exists', async () => {
    firstResults.leads = { ...LEAD_ROW, customer_id: 'cust-1' };
    firstResults.customers = { id: 'cust-1' };
    listResults.scheduled_services = [
      { id: 'svc-2', scheduled_date: '2099-01-05', window_start: '10:00', window_end: '11:00', service_type: 'General Pest Control', reschedule_token: 'tok2' },
    ];
    const token = mintLeadConsultationToken(LEAD_ID);
    const res = await callGet(token);
    expect(res.body.state).toBe('converted');
    expect(res.body.visit.serviceType).toBe('General Pest Control');
  });

  test('ok + needs_address: no customer, no address on file, no coords resolvable', async () => {
    firstResults.leads = LEAD_ROW; // no address, no customer_id
    listResults.scheduled_services = [];
    const token = mintLeadConsultationToken(LEAD_ID);
    const res = await callGet(token);
    expect(res.body.state).toBe('ok');
    expect(res.body.needs_address).toBe(true);
    expect(res.body.availability).toBe(null);
    expect(res.body.lead.has_address).toBe(false);
    expect(mockGeocode).not.toHaveBeenCalled();
  });

  test('ok: coords resolve from the linked customer row — availability built, phone masked', async () => {
    firstResults.leads = { ...LEAD_ROW, customer_id: 'cust-1' };
    firstResults.customers = { id: 'cust-1', address_line1: '123 Palm Ave', city: 'Bradenton', state: 'FL', zip: '34209', latitude: 27.4, longitude: -82.5 };
    listResults.scheduled_services = [];
    mockBuildAvailability.mockResolvedValueOnce({ slots: [], days: [{ date: '2027-01-10', slots: [{ start_time: '09:00' }] }] });
    const token = mintLeadConsultationToken(LEAD_ID);
    const res = await callGet(token);
    expect(res.body.state).toBe('ok');
    expect(res.body.needs_address).toBe(false);
    expect(res.body.availability.days[0].date).toBe('2027-01-10');
    expect(res.body.lead.phone_masked).toBe('***0101');
    expect(res.body.lead.has_address).toBe(true);
    // Stored coords short-circuit the geocode.
    expect(mockGeocode).not.toHaveBeenCalled();
  });
});

describe('POST /:token commit', () => {
  const okBody = () => ({ date: FUTURE_DATE, time: '09:00' });

  test('idempotent: an already-open assessment short-circuits BEFORE geocoding or booking', async () => {
    firstResults.leads = { ...LEAD_ROW, customer_id: 'cust-1' };
    firstResults.customers = { id: 'cust-1', address_line1: '123 Palm Ave' };
    listResults.scheduled_services = [
      { id: 'svc-1', scheduled_date: '2027-01-05', window_start: '09:00', window_end: '09:30', service_type: 'Waves Assessment', reschedule_token: 'tok' },
    ];
    const token = mintLeadConsultationToken(LEAD_ID);
    const res = await callPost(token, okBody());
    expect(res.statusCode).toBe(200);
    expect(res.body.state).toBe('already_booked');
    expect(res.body.code).toBe('ALREADY_BOOKED');
    expect(mockGeocode).not.toHaveBeenCalled();
    expect(mockCreateSelfBooking).not.toHaveBeenCalled();
  });

  test('out of area: 422, no booking', async () => {
    firstResults.leads = { ...LEAD_ROW, customer_id: 'cust-1' };
    firstResults.customers = { id: 'cust-1', address_line1: '123 Somewhere Rd', city: 'Wauchula', state: 'FL', zip: '33873' };
    listResults.scheduled_services = [];
    mockCounty.mockResolvedValueOnce('Hardee'); // not in SERVICE_AREA_COUNTIES
    const token = mintLeadConsultationToken(LEAD_ID);
    const res = await callPost(token, okBody());
    expect(res.statusCode).toBe(422);
    expect(res.body).toEqual({ error: 'out_of_area', county: 'Hardee' });
    expect(mockCreateSelfBooking).not.toHaveBeenCalled();
  });

  test('address required when neither the lead nor its customer has one on file', async () => {
    firstResults.leads = LEAD_ROW;
    listResults.scheduled_services = [];
    const token = mintLeadConsultationToken(LEAD_ID);
    const res = await callPost(token, okBody());
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/address/i);
    expect(mockGeocode).not.toHaveBeenCalled();
  });

  test('slot_taken: the requested time is no longer in the fresh single-day rebuild', async () => {
    firstResults.leads = { ...LEAD_ROW, customer_id: 'cust-1' };
    firstResults.customers = { id: 'cust-1', address_line1: '123 Palm Ave', city: 'Bradenton', state: 'FL', zip: '34209' };
    listResults.scheduled_services = [];
    firstResults.services = { id: 'svc-catalog-1', default_duration_minutes: 30 };
    // Day rebuild has no matching start_time.
    mockBuildAvailability.mockResolvedValueOnce({ days: [{ date: FUTURE_DATE, slots: [] }] });
    mockBuildAvailability.mockResolvedValueOnce({ slots: [], days: [] }); // the refresh call
    const token = mintLeadConsultationToken(LEAD_ID);
    const res = await callPost(token, okBody());
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('SLOT_TAKEN');
    expect(mockCreateSelfBooking).not.toHaveBeenCalled();
  });

  test('happy path: books through createSelfBooking with the assessment callbackVisit contract — never converts, no lead_id', async () => {
    firstResults.leads = { ...LEAD_ROW, customer_id: 'cust-1' };
    const custRow = { id: 'cust-1', address_line1: '123 Palm Ave', city: 'Bradenton', state: 'FL', zip: '34209', latitude: 27.4, longitude: -82.5 };
    firstResults.customers = custRow;
    listResults.scheduled_services = [];
    firstResults.services = { id: 'svc-catalog-1', default_duration_minutes: 30 };
    mockBuildAvailability.mockResolvedValueOnce({
      days: [{ date: FUTURE_DATE, slots: [{ start_time: '09:00', end_time: '09:30', start_label: '9:00 AM', end_label: '9:30 AM', technician_id: 'tech-1' }] }],
    });
    firstResults.scheduled_services = { id: 'ss-1', reschedule_token: 'new-reschedule-token' };

    const token = mintLeadConsultationToken(LEAD_ID);
    const res = await callPost(token, { date: FUTURE_DATE, time: '09:00', notes: 'ants in the kitchen' });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.visit).toEqual({ date: FUTURE_DATE, window: { start: '09:00', end: '09:30' } });
    expect(res.body.rescheduleUrl).toBe('/reschedule/new-reschedule-token');

    expect(mockCreateSelfBooking).toHaveBeenCalledTimes(1);
    const callArgs = mockCreateSelfBooking.mock.calls[0][0];
    expect(callArgs.source).toBe('inspection_link');
    expect(callArgs.authedCustomer).toEqual(custRow);
    expect(callArgs.customer_notes).toBe(null); // free text never rides the customer-visible `notes` column
    expect(callArgs.lead_id).toBeUndefined(); // never triggers booking.js's lead-conversion path
    expect(callArgs.callbackVisit).toEqual(expect.objectContaining({
      serviceKey: ASSESSMENT_SERVICE_KEY,
      serviceId: 'svc-catalog-1',
      serviceType: 'Waves Assessment',
      isCallback: false,
      dedupeLane: false,
      alertLabel: expect.stringContaining('Free consultation self-booked'),
    }));
    expect(isAssessmentServiceType(callArgs.callbackVisit.serviceType)).toBe(true);
  });
});

describe('POST /:token/waitlist', () => {
  test('idempotent insert on email — no error on a repeat submit', async () => {
    firstResults.leads = LEAD_ROW;
    const token = mintLeadConsultationToken(LEAD_ID);
    const res1 = await callWaitlist(token, { email: 'someone@example.com', county: 'Hardee' });
    expect(res1.statusCode).toBe(200);
    expect(res1.body).toEqual({ ok: true });
    const res2 = await callWaitlist(token, { email: 'someone@example.com', county: 'Hardee' });
    expect(res2.statusCode).toBe(200);
    expect(res2.body).toEqual({ ok: true });
  });

  test('rejects a missing/invalid email', async () => {
    firstResults.leads = LEAD_ROW;
    const token = mintLeadConsultationToken(LEAD_ID);
    const res = await callWaitlist(token, { email: 'not-an-email' });
    expect(res.statusCode).toBe(400);
  });
});

describe('assessment-not-a-win invariant backstop', () => {
  test('promoteCustomerOnBooking short-circuits for a Waves Assessment (the shared guard this route relies on)', async () => {
    const { promoteCustomerOnBooking } = require('../services/customer-stages');
    const result = await promoteCustomerOnBooking(require('../models/db'), 'any-customer-id', { serviceType: 'Waves Assessment' });
    expect(result).toBe(false);
  });
});
