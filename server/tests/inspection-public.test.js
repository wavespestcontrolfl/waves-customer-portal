/**
 * Public lead consultation-booking link — /api/public/inspection/:token.
 * Gate off/expired/garbage token handling, GET state shapes, the idempotent
 * already_booked short-circuit, out-of-area refusal (no booking), slot_taken,
 * waitlist idempotency, and the createSelfBooking `callbackVisit` contract
 * (isCallback:false / dedupeLane:false, no lead_id, never converts).
 *
 * Codex pre-push audit 2026-09-24 (1 P0, 6 P1) added: the router-level
 * dark-gate middleware runs before every rate limiter; resolveServiceAddress
 * (stored address wins only when it actually resolves, supplied wins
 * otherwise, address_unresolved vs out_of_area is never conflated); the
 * find-slots address parameter; the address write-back onto an addressless/
 * unresolvable customer; and the two-phase per-lead advisory lock around
 * customer provisioning + booking (concurrent-commit dedupe, converted-lead
 * refusal under the lock).
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

const mockParseWhen = jest.fn(async () => ({ dateFrom: '2027-01-01', dateTo: '2027-01-14', timeOfDay: 'any', understood: true }));
const mockSummarizeWindow = jest.fn(() => 'Here is what is open.');
jest.mock('../services/scheduling/parse-when', () => ({
  parseWhen: (...args) => mockParseWhen(...args),
  summarizeWindow: (...args) => mockSummarizeWindow(...args),
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

// ensureCustomerAccount is admin-customers.js's own phone/email matching —
// exercising the REAL implementation here would drag in that whole module
// (and its own SQL, tested by its own suite). Mocked at this seam so tests
// below control its return directly and exercise inspection-public's OWN
// logic (matchExistingAccountProfile / resolveOrLinkCustomerForLead, P1
// :585, 2026-09-24) instead. Default: no existing customer, matching the
// old unconditional-create behavior for every test that never overrides it.
const mockEnsureCustomerAccount = jest.fn(async () => ({ accountId: 'acct-default', existingCustomer: null, matchType: null }));
jest.mock('../routes/admin-customers', () => ({
  ensureCustomerAccount: (...args) => mockEnsureCustomerAccount(...args),
}));

// Universal query-chain mock: chain methods return the chain; `.first()`
// resolves firstResults[table]; the chain itself (list terminal, via `.then`)
// resolves listResults[table]; `.insert(...).returning('*')` resolves
// insertResults[table]; `.update()` records its payload in `updateCalls` and
// resolves 1; `db.transaction(fn)` runs `fn` against this SAME mock object
// (standing in for `trx` — the mock doesn't distinguish connections, so a
// re-read inside a "transaction" sees whatever `firstResults`/`listResults`
// hold at that moment, same as a plain `db` read would).
const firstResults = {};
const listResults = {};
const insertResults = {};
const updateCalls = [];
const insertCalls = [];
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
    q.update = async (payload) => { updateCalls.push({ table, payload }); return 1; };
    q.del = async () => 1;
    q.ignore = async () => [];
    q.merge = async () => [];
    q.insert = (payload) => { insertCalls.push({ table, payload }); return q; };
    q.returning = async () => (insertResults[table] || [{ id: 'new-cust-1' }]);
    q.then = (onOk, onErr) => Promise.resolve(listResults[table] || []).then(onOk, onErr);
    q.catch = (fn) => Promise.resolve(listResults[table] || []).catch(fn);
    return q;
  };
  const dbFn = jest.fn((table) => mkChain(table));
  dbFn.raw = jest.fn((sql) => sql);
  // Tracks whether a db.transaction() call is currently open (its callback
  // has started but not yet returned) — Codex pre-push P1, 2026-09-24:
  // proves createSelfBooking never runs while one of OUR transactions is
  // still open (it opens its own, on a separate pooled connection; holding
  // ours open across that call risks pool exhaustion under concurrency).
  dbFn._openTransactions = 0;
  dbFn.transaction = jest.fn(async (fn) => {
    dbFn._openTransactions += 1;
    try {
      return await fn(dbFn);
    } finally {
      dbFn._openTransactions -= 1;
    }
  });
  return dbFn;
});

const { mintLeadConsultationToken } = require('../utils/lead-consultation-token');
const { ASSESSMENT_SERVICE_KEY, isAssessmentServiceType } = require('../services/assessment-booking');
const { etDateString, addETDays } = require('../utils/datetime-et');
const db = require('../models/db');
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

async function callAvailability(token, body = {}) {
  const handler = findHandler('/:token/availability', 'post');
  const res = mkRes();
  const next = jest.fn();
  await handler({ params: { token }, body }, res, next);
  expect(next).not.toHaveBeenCalled();
  return res;
}

async function callFindSlots(token, body = {}) {
  const handler = findHandler('/:token/find-slots', 'post');
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
  updateCalls.length = 0;
  insertCalls.length = 0;
  gateState.live = true;
  mockGeocode.mockClear();
  mockGeocode.mockImplementation(async () => ({ location: { lat: 27.4, lng: -82.5 } }));
  mockCounty.mockClear();
  mockCounty.mockImplementation(async () => 'Manatee');
  mockRescheduleLink.mockClear();
  mockBookingConfig.mockClear();
  mockBuildAvailability.mockClear();
  mockBuildAvailability.mockImplementation(async () => ({ slots: [], days: [] }));
  mockCreateSelfBooking.mockClear();
  mockCreateSelfBooking.mockImplementation(async () => ({ ok: true, body: { booking: { id: 'sb-1' } } }));
  mockEnsureCustomerAccount.mockClear();
  mockEnsureCustomerAccount.mockImplementation(async () => ({ accountId: 'acct-default', existingCustomer: null, matchType: null }));
  mockParseWhen.mockClear();
  mockSummarizeWindow.mockClear();
  db.transaction.mockClear();
  db.raw.mockClear();
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

  // Codex pre-push P0, 2026-09-24: the gate check must be the router's FIRST
  // middleware — before noStore and every rate limiter — so a prober
  // hammering the route while dark always sees a uniform 404, never a 429
  // that would leak "this route exists and is rate-limited" (a dark route
  // must be unobservable). Verified two ways: (1) the gate layer really is
  // `router.stack[0]`, ahead of every other `router.use`; (2) calling it
  // directly 20 times in a row while dark always short-circuits with 404
  // and never calls `next()` — so the rate-limiter layers behind it are
  // categorically unreachable no matter how many requests arrive.
  test('the dark-gate check is the router\'s first middleware, ahead of every rate limiter', () => {
    const useLayers = inspectionPublicRouter.stack.filter((l) => !l.route);
    expect(useLayers.length).toBeGreaterThan(1);
    expect(useLayers[0]).toBe(inspectionPublicRouter.stack[0]);
  });

  test('20 rapid hits while dark all 404 — the limiter is never reached', () => {
    gateState.live = false;
    const gateLayer = inspectionPublicRouter.stack[0];
    for (let i = 0; i < 20; i += 1) {
      const res = mkRes();
      const next = jest.fn();
      gateLayer.handle({}, res, next);
      expect(res.statusCode).toBe(404);
      expect(res.body).toEqual({ error: 'not_found' });
      expect(next).not.toHaveBeenCalled();
    }
  });
});

describe('token verification', () => {
  test('a garbage token 404s', async () => {
    const res = await callGet('not-a-real-token');
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'not_found' });
  });

  // Codex #4737 r1 P0: every POST checks the token BEFORE validating the
  // body — an invalid token with an empty body is the generic 404, never a
  // 400 that reveals the route's validation rules.
  test.each(['/:token/availability', '/:token/find-slots', '/:token', '/:token/waitlist'])(
    'POST %s with a garbage token and an empty body → 404, not 400',
    async (route) => {
      const handler = findHandler(route, 'post');
      const res = mkRes();
      await handler({ params: { token: 'not-a-real-token' }, body: {} }, res, jest.fn());
      expect(res.statusCode).toBe(404);
      expect(res.body).toEqual({ error: 'not_found' });
    },
  );

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

  test('out_of_area: a stored address resolves outside the service area (P1 :638)', async () => {
    firstResults.leads = { ...LEAD_ROW, customer_id: 'cust-1' };
    firstResults.customers = {
      id: 'cust-1', address_line1: '1 Somewhere Rd', city: 'Wauchula', state: 'FL', zip: '33873',
      latitude: 27.5, longitude: -81.8,
    };
    listResults.scheduled_services = [];
    mockCounty.mockResolvedValueOnce('Hardee');
    const token = mintLeadConsultationToken(LEAD_ID);
    const res = await callGet(token);
    expect(res.body.state).toBe('out_of_area');
    expect(res.body.county).toBe('Hardee');
    expect(res.body.availability).toBeUndefined();
    expect(mockBuildAvailability).not.toHaveBeenCalled();
  });

  test('service_area_unavailable: county lookup fails on an otherwise-resolved stored address (P1 :638)', async () => {
    firstResults.leads = { ...LEAD_ROW, customer_id: 'cust-1' };
    firstResults.customers = {
      id: 'cust-1', address_line1: '123 Palm Ave', city: 'Bradenton', state: 'FL', zip: '34209',
      latitude: 27.4, longitude: -82.5,
    };
    listResults.scheduled_services = [];
    mockCounty.mockResolvedValueOnce(null);
    const token = mintLeadConsultationToken(LEAD_ID);
    const res = await callGet(token);
    expect(res.body.state).toBe('ok');
    expect(res.body.service_area_unavailable).toBe(true);
    expect(res.body.needs_address).toBe(false);
    expect(res.body.availability).toBe(null);
    expect(mockBuildAvailability).not.toHaveBeenCalled();
  });
});

describe('POST /:token/availability — address resolution (P1 :219)', () => {
  test('a geocode failure answers address_unresolved, never out_of_area', async () => {
    firstResults.leads = LEAD_ROW;
    mockGeocode.mockResolvedValueOnce({ location: null });
    const token = mintLeadConsultationToken(LEAD_ID);
    const res = await callAvailability(token, { address: 'not a real place' });
    expect(res.statusCode).toBe(422);
    expect(res.body).toEqual({ error: 'address_unresolved' });
  });

  test('a resolved location outside the service area answers out_of_area', async () => {
    firstResults.leads = LEAD_ROW;
    mockCounty.mockResolvedValueOnce('Hardee');
    const token = mintLeadConsultationToken(LEAD_ID);
    const res = await callAvailability(token, { address: '1 Somewhere Rd, Wauchula, FL 33873' });
    expect(res.statusCode).toBe(422);
    expect(res.body).toEqual({ error: 'out_of_area', county: 'Hardee' });
  });

  test('a resolved in-area location returns availability', async () => {
    firstResults.leads = LEAD_ROW;
    mockBuildAvailability.mockResolvedValueOnce({ slots: [], days: [{ date: '2027-01-10', slots: [] }] });
    const token = mintLeadConsultationToken(LEAD_ID);
    const res = await callAvailability(token, { address: '123 Palm Ave, Bradenton, FL 34209' });
    expect(res.statusCode).toBe(200);
    expect(res.body.needs_address).toBe(false);
  });
});

describe('POST /:token/find-slots (P1 :457)', () => {
  test('an addressless lead with no supplied address is asked for one', async () => {
    firstResults.leads = LEAD_ROW;
    const token = mintLeadConsultationToken(LEAD_ID);
    const res = await callFindSlots(token, { query: 'this weekend' });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/address/i);
    expect(mockParseWhen).not.toHaveBeenCalled();
  });

  test('a supplied address resolves the search for an addressless lead', async () => {
    firstResults.leads = LEAD_ROW;
    mockBuildAvailability.mockResolvedValueOnce({ slots: [], days: [{ date: '2027-01-10', slots: [{ start_time: '09:00' }] }] });
    const token = mintLeadConsultationToken(LEAD_ID);
    const res = await callFindSlots(token, { query: 'this weekend', address: '123 Palm Ave, Bradenton, FL 34209' });
    expect(res.statusCode).toBe(200);
    expect(mockGeocode).toHaveBeenCalledWith(expect.stringContaining('123 Palm Ave'), expect.any(Object));
    expect(res.body.availability.days[0].date).toBe('2027-01-10');
  });

  test('an unresolvable supplied address is reported distinctly', async () => {
    firstResults.leads = LEAD_ROW;
    mockGeocode.mockResolvedValueOnce({ location: null });
    const token = mintLeadConsultationToken(LEAD_ID);
    const res = await callFindSlots(token, { query: 'this weekend', address: 'gibberish text' });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/couldn.t find that address/i);
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
    expect(db.transaction).not.toHaveBeenCalled();
  });

  // P1 :544 — POST for a converted lead must answer the same shape GET
  // does and book nothing, not just an already-open-assessment lead.
  test('converted: a direct POST for a converted lead books nothing', async () => {
    firstResults.leads = { ...LEAD_ROW, converted_at: new Date() };
    firstResults.customers = null;
    listResults.scheduled_services = [];
    const token = mintLeadConsultationToken(LEAD_ID);
    const res = await callPost(token, okBody());
    expect(res.statusCode).toBe(200);
    expect(res.body.state).toBe('converted');
    expect(mockCreateSelfBooking).not.toHaveBeenCalled();
    expect(mockGeocode).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  test('address_unresolved: nothing on file resolves and the supplied address fails too (P1 :219)', async () => {
    firstResults.leads = LEAD_ROW;
    listResults.scheduled_services = [];
    mockGeocode.mockResolvedValueOnce({ location: null });
    const token = mintLeadConsultationToken(LEAD_ID);
    const res = await callPost(token, { date: FUTURE_DATE, time: '09:00', address: 'gibberish' });
    expect(res.statusCode).toBe(422);
    expect(res.body).toEqual({ error: 'address_unresolved' });
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

  // P1 :300 — the geocode call itself must not discard an out-of-box result
  // as if it were unresolvable; the area verdict belongs to checkServiceArea
  // alone. Pin the actual contract: inspection-public.js's tryGeocode calls
  // geocodeAddressWithStatus with requireInServiceArea:false (street-level
  // quality filtering stays on via serviceAddress:true).
  test('geocodes with requireInServiceArea:false — an out-of-box address reaches checkServiceArea, never silently "unresolved"', async () => {
    firstResults.leads = { ...LEAD_ROW, customer_id: 'cust-1' };
    firstResults.customers = { id: 'cust-1', address_line1: '1 Rooftop Rd', city: 'Fort Worth', state: 'TX', zip: '76102' };
    listResults.scheduled_services = [];
    mockCounty.mockResolvedValueOnce('Tarrant'); // real county, not in SERVICE_AREA_COUNTIES
    const token = mintLeadConsultationToken(LEAD_ID);
    const res = await callPost(token, okBody());
    expect(res.statusCode).toBe(422);
    expect(res.body.error).toBe('out_of_area'); // never address_unresolved
    expect(mockGeocode).toHaveBeenCalledWith(
      expect.stringContaining('1 Rooftop Rd'),
      expect.objectContaining({ serviceAddress: true, requireInServiceArea: false }),
    );
  });

  test('a garbage/unparseable address still answers address_unresolved (unaffected by the requireInServiceArea change)', async () => {
    firstResults.leads = LEAD_ROW;
    listResults.scheduled_services = [];
    mockGeocode.mockResolvedValueOnce({ location: null });
    const token = mintLeadConsultationToken(LEAD_ID);
    const res = await callPost(token, { date: FUTURE_DATE, time: '09:00', address: 'asdkjhasdkjh' });
    expect(res.statusCode).toBe(422);
    expect(res.body).toEqual({ error: 'address_unresolved' });
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
    expect(db.transaction).not.toHaveBeenCalled();
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
      alertLabel: expect.stringContaining('Free consultation self-booked'),
    }));
    // dedupeLane is left at its TRUE default (round 5, Codex pre-push P1,
    // 2026-09-24) — createSelfBooking's own atomic 'assessment' lane is
    // what closes the double-booking race now, not an outer lock of ours.
    expect(callArgs.callbackVisit.dedupeLane).not.toBe(false);
    expect(isAssessmentServiceType(callArgs.callbackVisit.serviceType)).toBe(true);

    // The customer's own address already resolved — no address write-back.
    expect(updateCalls.some((c) => c.table === 'customers')).toBe(false);
  });

  // P1 :532/:544 (round 4) / round 5 restructure — phase 1 takes a per-lead
  // advisory lock (customer provisioning + address-race fix), commits, and
  // releases it. The double-assessment dedupe that phase 1's lock does NOT
  // cover is now createSelfBooking's own atomic 'assessment' lane (see the
  // callbackVisit.dedupeLane test above and the round-5 tests below) — no
  // second lock of ours wraps the booking call.
  test('the commit takes ONE per-lead advisory lock, for provisioning only — the booking itself is NOT wrapped in a lock of ours', async () => {
    firstResults.leads = { ...LEAD_ROW, customer_id: 'cust-1' };
    const custRow = { id: 'cust-1', address_line1: '123 Palm Ave', city: 'Bradenton', state: 'FL', zip: '34209', latitude: 27.4, longitude: -82.5 };
    firstResults.customers = custRow;
    listResults.scheduled_services = [];
    firstResults.services = { id: 'svc-catalog-1', default_duration_minutes: 30 };
    mockBuildAvailability.mockResolvedValueOnce({
      days: [{ date: FUTURE_DATE, slots: [{ start_time: '09:00', end_time: '09:30', start_label: '9:00 AM', end_label: '9:30 AM', technician_id: 'tech-1' }] }],
    });
    firstResults.scheduled_services = { id: 'ss-1', reschedule_token: 'tok-lock' };

    const token = mintLeadConsultationToken(LEAD_ID);
    const res = await callPost(token, okBody());
    expect(res.statusCode).toBe(200);

    expect(db.transaction).toHaveBeenCalledTimes(1);
    const lockCalls = db.raw.mock.calls.filter(([sql]) => String(sql).includes('pg_advisory_xact_lock'));
    expect(lockCalls).toHaveLength(1);
    expect(lockCalls[0][1]).toEqual([`inspection_commit:${LEAD_ID}`]);
  });

  // P1 :834 — phase 2 used to hold a lock-owning transaction (one pooled
  // connection) OPEN while createSelfBooking opened its OWN transaction on
  // a SECOND pooled connection — under concurrent commits every pool slot
  // could end up occupied by lock-waiters plus lock-holders waiting on a
  // second connection, risking pool exhaustion. createSelfBooking's own
  // payload has no `trx`/knex-handle param (confirmed against its
  // signature in booking.js), so it cannot join an existing transaction —
  // fixed by never holding one open while it runs: prove createSelfBooking
  // is invoked only once NO db.transaction() call is currently open.
  test('createSelfBooking runs only after every one of our transactions has committed — never nested inside one (P1 :834)', async () => {
    firstResults.leads = { ...LEAD_ROW, customer_id: 'cust-1' };
    const custRow = { id: 'cust-1', address_line1: '123 Palm Ave', city: 'Bradenton', state: 'FL', zip: '34209', latitude: 27.4, longitude: -82.5 };
    firstResults.customers = custRow;
    listResults.scheduled_services = [];
    firstResults.services = { id: 'svc-catalog-1', default_duration_minutes: 30 };
    mockBuildAvailability.mockResolvedValueOnce({
      days: [{ date: FUTURE_DATE, slots: [{ start_time: '09:00', end_time: '09:30', start_label: '9:00 AM', end_label: '9:30 AM', technician_id: 'tech-1' }] }],
    });
    firstResults.scheduled_services = { id: 'ss-834', reschedule_token: 'tok-834' };

    let openTransactionsAtCreateSelfBooking = null;
    mockCreateSelfBooking.mockImplementationOnce(async () => {
      openTransactionsAtCreateSelfBooking = db._openTransactions;
      return { ok: true, body: { booking: { id: 'sb-834' } } };
    });

    const token = mintLeadConsultationToken(LEAD_ID);
    const res = await callPost(token, okBody());
    expect(res.statusCode).toBe(200);
    expect(mockCreateSelfBooking).toHaveBeenCalledTimes(1);
    expect(openTransactionsAtCreateSelfBooking).toBe(0);
  });

  // P1 :532 — createSelfBooking's own dedupe only catches an exact repeat
  // customer/date/time (skipped here via dedupeLane:false); the route's own
  // eligibility re-check under the lock is what stops a SECOND commit for
  // the same lead (any slot) once the first has actually booked.
  test('concurrent-commit dedupe: a second commit after the first booked short-circuits instead of double-booking', async () => {
    firstResults.leads = { ...LEAD_ROW, customer_id: 'cust-1' };
    const custRow = { id: 'cust-1', address_line1: '123 Palm Ave', city: 'Bradenton', state: 'FL', zip: '34209', latitude: 27.4, longitude: -82.5 };
    firstResults.customers = custRow;
    listResults.scheduled_services = [];
    firstResults.services = { id: 'svc-catalog-1', default_duration_minutes: 30 };
    mockBuildAvailability.mockResolvedValue({
      days: [{ date: FUTURE_DATE, slots: [{ start_time: '09:00', end_time: '09:30', start_label: '9:00 AM', end_label: '9:30 AM', technician_id: 'tech-1' }] }],
    });
    // Same row id in both fixtures (as the real DB would be — the self_
    // booking_id lookup and findOpenVisit both read the ONE row the commit
    // creates).
    firstResults.scheduled_services = { id: 'ss-1', reschedule_token: 'tok-1' };

    // The first booking's side effect: the lead's customer now has an open
    // assessment, same as a real commit would leave behind.
    mockCreateSelfBooking.mockImplementationOnce(async () => {
      listResults.scheduled_services = [
        { id: 'ss-1', scheduled_date: FUTURE_DATE, window_start: '09:00', window_end: '09:30', service_type: 'Waves Assessment', reschedule_token: 'tok-1' },
      ];
      return { ok: true, body: { booking: { id: 'sb-1' } } };
    });

    const token = mintLeadConsultationToken(LEAD_ID);
    const first = await callPost(token, okBody());
    expect(first.statusCode).toBe(200);
    expect(first.body.success).toBe(true);
    expect(mockCreateSelfBooking).toHaveBeenCalledTimes(1);

    const second = await callPost(token, okBody());
    expect(second.statusCode).toBe(200);
    expect(second.body.state).toBe('already_booked');
    expect(second.body.code).toBe('ALREADY_BOOKED');
    // Still just the one booking — the second commit never reaches createSelfBooking.
    expect(mockCreateSelfBooking).toHaveBeenCalledTimes(1);
  });

  // Round 5, Codex pre-push P1 :911, 2026-09-24 — the STRUCTURAL fix: two
  // truly overlapping commits at DIFFERENT slots, where NEITHER commit's
  // cheap pre-check sees the other (both read an empty listResults.
  // scheduled_services at pre-check time — genuine concurrency, unlike the
  // test above, which relies on the fast path). What actually stops the
  // second is createSelfBooking's own atomic 'assessment'-lane dedupe,
  // simulated here via the mock's own ALREADY_BOOKED failure shape (real
  // booking.js throws this from inside its insert transaction — see
  // reservice-scheduler.js's laneForCallbackRow/openCallbackExistsForLane).
  test('two overlapping commits at different slots: exactly one createSelfBooking insert succeeds, the other maps ALREADY_BOOKED to already_booked with the survivor', async () => {
    firstResults.leads = { ...LEAD_ROW, customer_id: 'cust-1' };
    const custRow = { id: 'cust-1', address_line1: '123 Palm Ave', city: 'Bradenton', state: 'FL', zip: '34209', latitude: 27.4, longitude: -82.5 };
    firstResults.customers = custRow;
    listResults.scheduled_services = []; // BOTH commits' pre-checks see this — neither observes the other first
    firstResults.services = { id: 'svc-catalog-1', default_duration_minutes: 30 };
    mockBuildAvailability.mockResolvedValue({
      days: [{ date: FUTURE_DATE, slots: [
        { start_time: '09:00', end_time: '09:30', start_label: '9:00 AM', end_label: '9:30 AM', technician_id: 'tech-1' },
        { start_time: '10:00', end_time: '10:30', start_label: '10:00 AM', end_label: '10:30 AM', technician_id: 'tech-1' },
      ] }],
    });
    firstResults.scheduled_services = { id: 'ss-first', reschedule_token: 'tok-first' };

    // First commit (09:00): createSelfBooking's own insert succeeds.
    mockCreateSelfBooking.mockImplementationOnce(async () => (
      { ok: true, body: { booking: { id: 'sb-first' } } }
    ));
    // Second commit (10:00, a DIFFERENT slot): createSelfBooking's own
    // atomic lane dedupe — inside ITS insert transaction, under the
    // reservice-lane advisory lock keyed on this customer+ASSESSMENT_
    // SERVICE_KEY — finds the first's row and refuses BEFORE inserting a
    // second one. The survivor becomes visible to a subsequent read as a
    // side effect of that same atomic check having run.
    mockCreateSelfBooking.mockImplementationOnce(async () => {
      listResults.scheduled_services = [
        { id: 'ss-first', scheduled_date: FUTURE_DATE, window_start: '09:00', window_end: '09:30', service_type: 'Waves Assessment', reschedule_token: 'tok-first' },
      ];
      return { ok: false, status: 409, error: 'You already have a re-service visit on the books.', code: 'ALREADY_BOOKED' };
    });

    const token = mintLeadConsultationToken(LEAD_ID);
    const first = await callPost(token, { date: FUTURE_DATE, time: '09:00' });
    expect(first.statusCode).toBe(200);
    expect(first.body.success).toBe(true);

    const second = await callPost(token, { date: FUTURE_DATE, time: '10:00' });
    expect(second.statusCode).toBe(200);
    expect(second.body.state).toBe('already_booked');
    expect(second.body.visit.date).toBe(FUTURE_DATE);
    expect(second.body.visit.window.start).toBe('09:00'); // the SURVIVOR's slot, not the second commit's own 10:00

    // Exactly one insert attempt on each side — the second never wrote a
    // second row (it got the atomic refusal instead), and neither commit's
    // cheap pre-check is what caught this.
    expect(mockCreateSelfBooking).toHaveBeenCalledTimes(2);
  });

  // P1 :546/:597 — a stored address that fails to geocode must not block a
  // supplied one, and the address that DOES resolve gets written back onto
  // the customer row so the lead isn't asked for it again.
  test('a supplied address wins when the stored one fails to geocode, and gets persisted onto the customer', async () => {
    firstResults.leads = { ...LEAD_ROW, customer_id: 'cust-1' };
    const custRow = { id: 'cust-1', address_line1: '1 Bad Rd', city: 'Nowhere', state: 'FL', zip: '00000', latitude: null, longitude: null };
    firstResults.customers = custRow;
    listResults.scheduled_services = [];
    firstResults.services = { id: 'svc-catalog-1', default_duration_minutes: 30 };

    mockGeocode.mockImplementation(async (addressStr) => (
      String(addressStr).startsWith('1 Bad Rd') ? { location: null } : { location: { lat: 27.5, lng: -82.6 } }
    ));
    mockBuildAvailability.mockResolvedValueOnce({
      days: [{ date: FUTURE_DATE, slots: [{ start_time: '09:00', end_time: '09:30', start_label: '9:00 AM', end_label: '9:30 AM', technician_id: 'tech-1' }] }],
    });
    firstResults.scheduled_services = { id: 'ss-2', reschedule_token: 'tok-2' };

    const token = mintLeadConsultationToken(LEAD_ID);
    const res = await callPost(token, { date: FUTURE_DATE, time: '09:00', address: '456 Good Ave, Bradenton, FL 34209' });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockCreateSelfBooking).toHaveBeenCalledTimes(1);
    expect(mockCreateSelfBooking.mock.calls[0][0].authedCustomer.address_line1).toMatch(/456 Good Ave/);

    const customerUpdate = updateCalls.find((c) => c.table === 'customers');
    expect(customerUpdate).toBeTruthy();
    expect(customerUpdate.payload.address_line1).toMatch(/456 Good Ave/);
    expect(customerUpdate.payload.latitude).toBe(27.5);
    expect(customerUpdate.payload.longitude).toBe(-82.6);
  });

  // Round 13 (Codex pre-push P1 :845, 2026-09-24) replaced the OLD
  // re-resolve-under-the-lock design these three tests pinned (P1 :800,
  // :872) — re-geocoding a fresh customer row while holding the per-lead
  // advisory lock + a pooled connection was exactly the network-I/O-
  // under-lock risk the rule now forbids. The new design never re-resolves
  // under the lock at all: it compares the fresh row's stored-address
  // fields against the PRE-LOCK snapshot the pre-lock resolution was
  // computed against, and fails closed (recoverable) on ANY difference —
  // simulated interleaving below is the SAME mockGeocode side-effect
  // trick, now proving the abort instead of a seamless address adoption.
  describe('a stored-address change detected under the lock (P1 :845, round 13)', () => {
    const LOC_A = { lat: 27.55, lng: -82.55 };
    const addresslessCustomer = () => ({
      id: 'cust-1', address_line1: null, address_line2: null, city: null, state: 'FL', zip: null, latitude: null, longitude: null,
    });

    test('another commit\'s address landing on the row between the pre-lock read and the lock aborts recoverably — never adopts it, never overwrites it, never re-geocodes under the lock', async () => {
      firstResults.leads = { ...LEAD_ROW, customer_id: 'cust-1' };
      firstResults.customers = addresslessCustomer();
      listResults.scheduled_services = [];
      firstResults.services = { id: 'svc-catalog-1', default_duration_minutes: 30 };
      mockGeocode.mockImplementation(async (addressStr) => {
        if (String(addressStr).includes('222 B St')) {
          // The interleaving: while resolving B pre-lock, ANOTHER commit's
          // address lands on the row — by the time phase 1 re-reads it
          // under the lock, it no longer matches the addressless snapshot
          // the pre-lock resolution of B was computed against.
          firstResults.customers = {
            id: 'cust-1', address_line1: '111 A St', address_line2: null,
            city: 'Bradenton', state: 'FL', zip: '34209', latitude: LOC_A.lat, longitude: LOC_A.lng,
          };
          return { location: { lat: 27.7, lng: -82.7 } };
        }
        return { location: null };
      });
      mockBuildAvailability.mockImplementation(async () => ({
        days: [{ date: FUTURE_DATE, slots: [{ start_time: '09:00', end_time: '09:30', start_label: '9:00 AM', end_label: '9:30 AM', technician_id: 'tech-1' }] }],
      }));

      const token = mintLeadConsultationToken(LEAD_ID);
      const res = await callPost(token, { date: FUTURE_DATE, time: '09:00', address: '222 B St, Bradenton, FL 34209' });

      expect(res.statusCode).toBe(422);
      expect(res.body).toEqual({ error: 'address_unresolved' });
      expect(mockCreateSelfBooking).not.toHaveBeenCalled();
      // Never overwrites the now-persisted A with the supplied B.
      expect(updateCalls.find((c) => c.table === 'customers')).toBeUndefined();
      // Exactly ONE geocode call, the pre-lock resolution of B — nothing
      // under the lock ever re-geocodes the fresh row.
      expect(mockGeocode).toHaveBeenCalledTimes(1);
    });

    // P1 :872's rule (the booking must use the REFRESHED slot's own
    // technician_id/end_time when the final location differs from the
    // pre-lock one, never the original pre-lock slot's) still applies —
    // just via the ONE remaining way `location` can differ post-phase-1
    // now: a verified unlinked lead reusing an existing property whose own
    // stored coordinates differ from the lead's pre-lock resolution (round
    // 11/13), re-validated AFTER the transaction commits.
    test('a verified lead reusing a matched profile at a different stored location books the REFRESHED slot\'s own technician, never the pre-lock one', async () => {
      firstResults.leads = { ...LEAD_ROW, customer_id: null, first_contact_channel: 'call', twilio_call_sid: 'CA-test' };
      firstResults.call_log = { from_phone: '+19415550101' };
      firstResults.services = { id: 'svc-catalog-1', default_duration_minutes: 30 };
      const slotAtSupplied = { days: [{ date: FUTURE_DATE, slots: [{ start_time: '09:00', end_time: '09:30', start_label: '9:00 AM', end_label: '9:30 AM', technician_id: 'tech-pre' }] }] };
      const slotAtMatched = { days: [{ date: FUTURE_DATE, slots: [{ start_time: '09:00', end_time: '09:45', start_label: '9:00 AM', end_label: '9:45 AM', technician_id: 'tech-matched' }] }] };
      mockBuildAvailability
        .mockResolvedValueOnce(slotAtSupplied) // pre-lock anti-forgery check
        .mockResolvedValueOnce(slotAtMatched); // post-phase-1 re-validation at the matched row's own location
      const existingCustomer = {
        id: 'cust-9', account_id: 'acct-9', is_primary_profile: true,
        address_line1: '123 Palm Ave', city: 'Bradenton', state: 'FL', zip: '34209', phone: '9415550101',
        latitude: 27.1, longitude: -82.2, // in the service box but far from the default mockGeocode location — matched via zip, not coords
      };
      mockEnsureCustomerAccount.mockResolvedValueOnce({ accountId: 'acct-9', existingCustomer, matchType: 'phone' });
      listResults.scheduled_services = [];
      firstResults.scheduled_services = { id: 'ss-refresh', reschedule_token: 'tok-refresh' };

      const token = mintLeadConsultationToken(LEAD_ID);
      const res = await callPost(token, { date: FUTURE_DATE, time: '09:00', address: '123 Palm Ave, Bradenton, FL 34209' });

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockCreateSelfBooking).toHaveBeenCalledTimes(1);
      const bookingArgs = mockCreateSelfBooking.mock.calls[0][0];
      expect(bookingArgs.technician_id).toBe('tech-matched');
      expect(bookingArgs.slot_end).toBe('09:45');
      expect(res.body.visit.window.end).toBe('09:45');
      expect(res.body.endLabel).toBe('9:45 AM');
    });
  });

  // Round 13 (Codex pre-push P1 :845, 2026-09-24) — phase 1 no longer
  // re-resolves a customer's address under the lock at all (that would be
  // a geocode network call while the lock + a pooled connection are held).
  // When the fresh row's stored-address fields are UNCHANGED from the
  // pre-lock snapshot, the pre-lock resolution (`resolved` — already
  // geocoded + area-checked) is reused outright, regardless of whether it
  // came from an empty stored address or one that simply failed to
  // geocode: either way `resolved.source !== 'customer'` and the validated
  // resolution is written back, fixing up the missing/bad address so it
  // isn't asked for again (this file's own header contract).
  describe('address write-back when the stored row is unchanged under the lock (P1 :845, round 13)', () => {
    test('stored address absent: the pre-lock validated supplied address is persisted, booking proceeds at that location', async () => {
      firstResults.leads = { ...LEAD_ROW, customer_id: 'cust-1' };
      firstResults.customers = { id: 'cust-1', address_line1: null, address_line2: null, city: null, state: 'FL', zip: null, latitude: null, longitude: null };
      listResults.scheduled_services = [];
      firstResults.services = { id: 'svc-catalog-1', default_duration_minutes: 30 };
      const LOC = { lat: 27.55, lng: -82.55 };
      mockGeocode.mockResolvedValueOnce({ location: LOC }); // pre-lock: supplied address resolves
      mockBuildAvailability.mockResolvedValueOnce({
        days: [{ date: FUTURE_DATE, slots: [{ start_time: '09:00', end_time: '09:30', start_label: '9:00 AM', end_label: '9:30 AM', technician_id: 'tech-1' }] }],
      });
      firstResults.scheduled_services = { id: 'ss-858a', reschedule_token: 'tok-858a' };

      const token = mintLeadConsultationToken(LEAD_ID);
      const res = await callPost(token, { date: FUTURE_DATE, time: '09:00', address: '123 Any St, Bradenton, FL 34209' });

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockCreateSelfBooking).toHaveBeenCalledTimes(1);
      // The customer row passed to createSelfBooking carries the SAME
      // location the slot was validated against.
      expect(mockCreateSelfBooking.mock.calls[0][0].authedCustomer.latitude).toBe(LOC.lat);
      expect(mockCreateSelfBooking.mock.calls[0][0].authedCustomer.longitude).toBe(LOC.lng);
      // Exactly ONE geocode call — nothing under the lock re-resolves.
      expect(mockGeocode).toHaveBeenCalledTimes(1);

      const customerUpdate = updateCalls.find((c) => c.table === 'customers');
      expect(customerUpdate).toBeTruthy();
      expect(customerUpdate.payload.latitude).toBe(LOC.lat);
      expect(customerUpdate.payload.longitude).toBe(LOC.lng);
    });

    test('stored address present but unresolvable, unchanged under the lock: the validated supplied replacement wins and is written back, fixing up the bad stored address', async () => {
      firstResults.leads = { ...LEAD_ROW, customer_id: 'cust-1' };
      firstResults.customers = {
        id: 'cust-1', address_line1: '999 Existing Rd', address_line2: null,
        city: 'Bradenton', state: 'FL', zip: '34209', latitude: null, longitude: null,
      };
      listResults.scheduled_services = [];
      firstResults.services = { id: 'svc-catalog-1', default_duration_minutes: 30 };
      const LOC = { lat: 27.55, lng: -82.55 };
      mockGeocode
        .mockResolvedValueOnce({ location: null }) // pre-lock: stored "999 Existing Rd" fails
        .mockResolvedValueOnce({ location: LOC });  // pre-lock: supplied replacement resolves
      mockBuildAvailability.mockResolvedValueOnce({
        days: [{ date: FUTURE_DATE, slots: [{ start_time: '09:00', end_time: '09:30', start_label: '9:00 AM', end_label: '9:30 AM', technician_id: 'tech-1' }] }],
      });
      firstResults.scheduled_services = { id: 'ss-858b', reschedule_token: 'tok-858b' };

      const token = mintLeadConsultationToken(LEAD_ID);
      const res = await callPost(token, { date: FUTURE_DATE, time: '09:00', address: '456 Replacement Ave, Bradenton, FL 34209' });

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockCreateSelfBooking).toHaveBeenCalledTimes(1);
      expect(mockCreateSelfBooking.mock.calls[0][0].authedCustomer.latitude).toBe(LOC.lat);
      // Exactly TWO geocode calls (the stored address's own failed attempt,
      // then the supplied replacement) — nothing under the lock re-tries
      // either one.
      expect(mockGeocode).toHaveBeenCalledTimes(2);

      const customerUpdate = updateCalls.find((c) => c.table === 'customers');
      expect(customerUpdate).toBeTruthy();
      expect(customerUpdate.payload.address_line1).toBe('456 Replacement Ave');
      expect(customerUpdate.payload.latitude).toBe(LOC.lat);
    });
  });

  // Codex pre-push P1 :839, round 7, 2026-09-24 — checkServiceArea used to
  // run only ONCE, on the pre-lock location; under the OLD lock-protected
  // re-resolve, a fresh attempt could replace it with a NEW location that
  // was never checked against the service area at all. Round 13 (P1 :845)
  // closes this even more strongly than the round-7 fix did: phase 1 no
  // longer re-resolves ANY address under the lock, so the exact race this
  // test originally pinned — the customer's own stored address failing
  // pre-lock, then resolving to something out-of-area on a SECOND attempt
  // moments later, under the lock — can no longer happen at all. The
  // pre-lock resolution (already geocoded + area-checked before the lock
  // was ever taken) is what wins, unconditionally, once the fresh row is
  // confirmed unchanged.
  test('stored address unresolvable pre-lock, unchanged under the lock: the pre-lock in-area supplied resolution wins, books successfully (P1 :839, :845)', async () => {
    firstResults.leads = { ...LEAD_ROW, customer_id: 'cust-1' };
    firstResults.customers = {
      id: 'cust-1', address_line1: '1 Rooftop Rd', address_line2: null,
      city: 'Fort Worth', state: 'TX', zip: '76102', latitude: null, longitude: null,
    };
    listResults.scheduled_services = [];
    firstResults.services = { id: 'svc-catalog-1', default_duration_minutes: 30 };
    const IN_AREA = { lat: 27.4989, lng: -82.5748 }; // Bradenton
    mockGeocode
      .mockResolvedValueOnce({ location: null })    // pre-lock: stored "1 Rooftop Rd" fails to geocode
      .mockResolvedValueOnce({ location: IN_AREA }); // pre-lock: supplied replacement resolves, in area
    mockCounty.mockResolvedValueOnce('Manatee'); // checkServiceArea for the pre-lock (supplied) location — served
    mockBuildAvailability.mockResolvedValueOnce({
      days: [{ date: FUTURE_DATE, slots: [{ start_time: '09:00', end_time: '09:30', start_label: '9:00 AM', end_label: '9:30 AM', technician_id: 'tech-1' }] }],
    });
    firstResults.scheduled_services = { id: 'ss-839', reschedule_token: 'tok-839' };

    const token = mintLeadConsultationToken(LEAD_ID);
    const res = await callPost(token, { date: FUTURE_DATE, time: '09:00', address: '123 Palm Ave, Bradenton, FL 34209' });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockCreateSelfBooking).toHaveBeenCalledTimes(1);
    // Exactly ONE county lookup — nothing under the lock re-checks the
    // service area either.
    expect(mockCounty).toHaveBeenCalledTimes(1);
    const customerUpdate = updateCalls.find((c) => c.table === 'customers');
    expect(customerUpdate.payload.latitude).toBe(IN_AREA.lat);
  });

  // P1 :355 — a null county (provider timeout/outage) must never silently
  // pass a booking through, including for a customer's STORED coordinates
  // (which never touch the geocoder's own box test at all — checkServiceArea
  // is the only place they're ever checked against the service area).
  describe('service-area verification failures (P1 :355)', () => {
    test('a Google key configured + reverseGeocodeCounty returns null: recoverable 503, no booking', async () => {
      firstResults.leads = { ...LEAD_ROW, customer_id: 'cust-1' };
      firstResults.customers = { id: 'cust-1', address_line1: '123 Palm Ave', city: 'Bradenton', state: 'FL', zip: '34209', latitude: 27.4, longitude: -82.5 };
      listResults.scheduled_services = [];
      mockCounty.mockResolvedValueOnce(null); // provider timeout/outage — not "fine"
      const token = mintLeadConsultationToken(LEAD_ID);
      const res = await callPost(token, okBody());
      expect(res.statusCode).toBe(503);
      expect(res.body).toEqual({ error: 'service_area_unavailable' });
      expect(mockCreateSelfBooking).not.toHaveBeenCalled();
    });

    test('no Google key configured + in-box STORED coordinates: books successfully', async () => {
      delete process.env.GOOGLE_API_KEY;
      delete process.env.GOOGLE_MAPS_API_KEY;
      try {
        firstResults.leads = { ...LEAD_ROW, customer_id: 'cust-1' };
        firstResults.customers = { id: 'cust-1', address_line1: '123 Palm Ave', city: 'Bradenton', state: 'FL', zip: '34209', latitude: 27.4989, longitude: -82.5748 };
        listResults.scheduled_services = [];
        firstResults.services = { id: 'svc-catalog-1', default_duration_minutes: 30 };
        mockBuildAvailability.mockResolvedValueOnce({
          days: [{ date: FUTURE_DATE, slots: [{ start_time: '09:00', end_time: '09:30', start_label: '9:00 AM', end_label: '9:30 AM', technician_id: 'tech-1' }] }],
        });
        firstResults.scheduled_services = { id: 'ss-nokey', reschedule_token: 'tok-nokey' };
        const token = mintLeadConsultationToken(LEAD_ID);
        const res = await callPost(token, okBody());
        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
        expect(mockCreateSelfBooking).toHaveBeenCalledTimes(1);
        expect(mockCounty).not.toHaveBeenCalled(); // no key — box test only
      } finally {
        process.env.GOOGLE_API_KEY = 'test-google-key';
      }
    });

    test('no Google key configured + out-of-box STORED coordinates: out_of_area, no booking', async () => {
      delete process.env.GOOGLE_API_KEY;
      delete process.env.GOOGLE_MAPS_API_KEY;
      try {
        firstResults.leads = { ...LEAD_ROW, customer_id: 'cust-1' };
        // Fort Worth, TX — a real rooftop, just nowhere near SW Florida.
        firstResults.customers = { id: 'cust-1', address_line1: '1 Rooftop Rd', city: 'Fort Worth', state: 'TX', zip: '76102', latitude: 32.7555, longitude: -97.3308 };
        listResults.scheduled_services = [];
        const token = mintLeadConsultationToken(LEAD_ID);
        const res = await callPost(token, okBody());
        expect(res.statusCode).toBe(422);
        expect(res.body).toEqual({ error: 'out_of_area', county: null });
        expect(mockCreateSelfBooking).not.toHaveBeenCalled();
      } finally {
        process.env.GOOGLE_API_KEY = 'test-google-key';
      }
    });
  });

  // Round 10, Codex pre-push P1, 2026-09-24 (inspection-public.js:585): an
  // unlinked lead whose phone matches an existing customer used to get a
  // WHOLE SECOND property profile unconditionally — eligibility and dedupe
  // never even looked at the matched customer's own visits. Round 11 (same
  // P1, next audit round) tightened this: round 10's reuse ran for ANY
  // unlinked lead, but an unlinked lead's phone/email come straight off a
  // public form and are unverified — reusing on a bare match let someone
  // submit a victim's phone, receive the link at their own contact info,
  // and read the victim's visit date / get a bearer reschedule URL / book
  // on the victim's account. Reuse now requires leadContactVerified: the
  // lead itself came from an inbound call (leads.first_contact_channel),
  // or the token's own `channel` claim says it was delivered by SMS.
  // ensureCustomerAccount itself is mocked (see the top of this file) so
  // each test controls the phone-match result directly.
  describe('unlinked lead, phone matches an existing customer (P1 :585)', () => {
    const MATCH_ADDRESS = '123 Palm Ave, Bradenton, FL 34209';
    const existingCustomerAt = (line1, extra = {}) => ({
      id: 'cust-9', account_id: 'acct-9', is_primary_profile: true,
      address_line1: line1, city: 'Bradenton', state: 'FL', zip: '34209', phone: '9415550101',
      ...extra,
    });
    const mockOneSlot = () => mockBuildAvailability.mockResolvedValueOnce({
      days: [{ date: FUTURE_DATE, slots: [{ start_time: '09:00', end_time: '09:30', start_label: '9:00 AM', end_label: '9:30 AM', technician_id: 'tech-1' }] }],
    });

    describe('verified (inbound-call lead)', () => {
      // The originating call's caller ID still matches the lead's phone.
      beforeEach(() => { firstResults.call_log = { from_phone: '+19415550101' }; });

      test('an open assessment on the matched profile → already_booked, no new profile, nothing linked', async () => {
        firstResults.leads = { ...LEAD_ROW, customer_id: null, first_contact_channel: 'call', twilio_call_sid: 'CA-test' };
        firstResults.services = { id: 'svc-catalog-1', default_duration_minutes: 30 };
        mockOneSlot();
        const existingCustomer = existingCustomerAt('123 Palm Ave');
        mockEnsureCustomerAccount.mockResolvedValueOnce({ accountId: 'acct-9', existingCustomer, matchType: 'phone' });
        listResults.scheduled_services = [
          { id: 'ss-9', scheduled_date: FUTURE_DATE, window_start: '09:00', window_end: '09:30', service_type: 'Waves Assessment', reschedule_token: 'tok9' },
        ];

        const token = mintLeadConsultationToken(LEAD_ID);
        const res = await callPost(token, { date: FUTURE_DATE, time: '09:00', address: MATCH_ADDRESS });

        expect(res.statusCode).toBe(200);
        expect(res.body.state).toBe('already_booked');
        expect(res.body.rescheduleUrl).toBe('/reschedule/abc123');
        expect(mockCreateSelfBooking).not.toHaveBeenCalled();
        expect(insertCalls.some((c) => c.table === 'customers')).toBe(false);
        expect(updateCalls.some((c) => c.table === 'leads')).toBe(false);
        expect(mockEnsureCustomerAccount).toHaveBeenCalledWith(expect.anything(), expect.not.objectContaining({ forceNewAccount: true }));
      });

      test('same address (street + zip), no open visits → reuses the existing property profile, never a new one', async () => {
        firstResults.leads = { ...LEAD_ROW, customer_id: null, first_contact_channel: 'call', twilio_call_sid: 'CA-test' };
        firstResults.services = { id: 'svc-catalog-1', default_duration_minutes: 30 };
        mockOneSlot();
        const existingCustomer = existingCustomerAt('123 Palm Ave');
        mockEnsureCustomerAccount.mockResolvedValueOnce({ accountId: 'acct-9', existingCustomer, matchType: 'phone' });
        listResults.scheduled_services = [];
        firstResults.scheduled_services = { id: 'ss-reuse', reschedule_token: 'tok-reuse' };

        const token = mintLeadConsultationToken(LEAD_ID);
        const res = await callPost(token, { date: FUTURE_DATE, time: '09:00', address: MATCH_ADDRESS });

        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
        expect(mockCreateSelfBooking).toHaveBeenCalledTimes(1);
        expect(mockCreateSelfBooking.mock.calls[0][0].authedCustomer).toEqual(existingCustomer);
        expect(insertCalls.some((c) => c.table === 'customers')).toBe(false);
        expect(updateCalls.some((c) => c.table === 'leads' && c.payload.customer_id === 'cust-9')).toBe(true);
      });

      test('a genuinely new address → a new profile under the SAME account, never a new customer_accounts row', async () => {
        firstResults.leads = { ...LEAD_ROW, customer_id: null, first_contact_channel: 'call', twilio_call_sid: 'CA-test' };
        firstResults.services = { id: 'svc-catalog-1', default_duration_minutes: 30 };
        mockOneSlot();
        // The matched account's existing property is a DIFFERENT street —
        // MATCH_ADDRESS below matches none of it.
        const existingCustomer = existingCustomerAt('9 Other Rd');
        mockEnsureCustomerAccount.mockResolvedValueOnce({ accountId: 'acct-9', existingCustomer, matchType: 'phone' });
        listResults.scheduled_services = [];
        listResults.customers = [existingCustomer];
        insertResults.customers = [{ id: 'new-cust-2', account_id: 'acct-9' }];
        firstResults.scheduled_services = { id: 'ss-new2', reschedule_token: 'tok-new2' };

        const token = mintLeadConsultationToken(LEAD_ID);
        const res = await callPost(token, { date: FUTURE_DATE, time: '09:00', address: MATCH_ADDRESS });

        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
        const customerInsert = insertCalls.find((c) => c.table === 'customers');
        expect(customerInsert).toBeTruthy();
        expect(customerInsert.payload.account_id).toBe('acct-9'); // same account — never a new customer_accounts row
        expect(customerInsert.payload.profile_label).toBe('Additional property');
        expect(customerInsert.payload.address_line1).toBe('123 Palm Ave');
        expect(mockCreateSelfBooking.mock.calls[0][0].authedCustomer.id).toBe('new-cust-2');
        expect(updateCalls.some((c) => c.table === 'leads' && c.payload.customer_id === 'new-cust-2')).toBe(true);
      });

      test('coords mismatch on the matched row → re-validates the slot against ITS stored location and fails closed (SLOT_TAKEN), never books', async () => {
        firstResults.leads = { ...LEAD_ROW, customer_id: null, first_contact_channel: 'call', twilio_call_sid: 'CA-test' };
        firstResults.services = { id: 'svc-catalog-1', default_duration_minutes: 30 };
        mockOneSlot(); // satisfies the pre-lock anti-forgery day check only
        // Matches by full address (street + zip) — the OR branch that never
        // required coordinate agreement — but its OWN stored coordinates
        // are nowhere near the freshly geocoded MATCH_ADDRESS location
        // (default mockGeocode: {lat:27.4, lng:-82.5}), so the matched
        // row's location must win and be re-validated, not the pre-lock one.
        const existingCustomer = existingCustomerAt('123 Palm Ave', { latitude: 27.1, longitude: -82.2 }); // in the box, far from MATCH_ADDRESS's geocode
        mockEnsureCustomerAccount.mockResolvedValueOnce({ accountId: 'acct-9', existingCustomer, matchType: 'phone' });
        listResults.scheduled_services = [];
        // No second mockBuildAvailability value queued — the re-validation
        // call at the matched row's own (far-away) location falls back to
        // afterEach's default { slots: [], days: [] }, so no slot survives.

        const token = mintLeadConsultationToken(LEAD_ID);
        const res = await callPost(token, { date: FUTURE_DATE, time: '09:00', address: MATCH_ADDRESS });

        expect(res.statusCode).toBe(409);
        expect(res.body.code).toBe('SLOT_TAKEN');
        expect(mockCreateSelfBooking).not.toHaveBeenCalled();
        expect(insertCalls.some((c) => c.table === 'customers')).toBe(false);
        // buildAvailabilityForLead: [0] the pre-lock day check at the lead's
        // OWN resolved location, [1] phase 1's re-validation at the MATCHED
        // row's own (far-away) location — not the pre-lock one — and [2]
        // the SLOT_TAKEN handler's refreshed-availability call.
        expect(mockBuildAvailability).toHaveBeenCalledTimes(3);
        expect(mockBuildAvailability.mock.calls[1][0]).toEqual(expect.objectContaining({ lat: 27.1, lng: -82.2 }));
      });
    });

    describe('unverified (public-form lead)', () => {
      test('victim phone matches an existing customer WITH an open assessment → a new prospect profile, no visit data, no reschedule URL, booking lands on the prospect', async () => {
        firstResults.leads = { ...LEAD_ROW, customer_id: null }; // no first_contact_channel — a plain web-form lead
        firstResults.services = { id: 'svc-catalog-1', default_duration_minutes: 30 };
        mockOneSlot();
        const victim = existingCustomerAt('123 Palm Ave');
        mockEnsureCustomerAccount.mockResolvedValueOnce({ accountId: 'acct-victim', existingCustomer: null, matchType: null });
        // The victim's own open assessment sits in the mock's shared table —
        // if resolveOrLinkCustomerForLead ever reused the victim, THIS is
        // what it would surface as already_booked.
        listResults.scheduled_services = [
          { id: 'ss-victim', scheduled_date: FUTURE_DATE, window_start: '09:00', window_end: '09:30', service_type: 'Waves Assessment', reschedule_token: 'tok-victim' },
        ];
        insertResults.customers = [{ id: 'prospect-1', account_id: 'acct-victim' }];
        firstResults.scheduled_services = { id: 'ss-prospect', reschedule_token: 'tok-prospect' };

        const token = mintLeadConsultationToken(LEAD_ID); // no channel — unverified delivery
        const res = await callPost(token, { date: FUTURE_DATE, time: '09:00', address: MATCH_ADDRESS });

        // Never the victim's data: no already_booked short-circuit, no
        // victim visit/rescheduleUrl anywhere in the response.
        expect(res.statusCode).toBe(200);
        expect(res.body.state).not.toBe('already_booked');
        expect(JSON.stringify(res.body)).not.toContain('tok-victim');
        // ensureCustomerAccount was told to bypass phone matching entirely.
        expect(mockEnsureCustomerAccount).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({ forceNewAccount: true, ignorePhoneMatch: true }),
        );
        // The booking lands on the freshly created PROSPECT, never the victim.
        expect(mockCreateSelfBooking).toHaveBeenCalledTimes(1);
        expect(mockCreateSelfBooking.mock.calls[0][0].authedCustomer.id).toBe('prospect-1');
        expect(mockCreateSelfBooking.mock.calls[0][0].authedCustomer.id).not.toBe(victim.id);
        const customerInsert = insertCalls.find((c) => c.table === 'customers');
        expect(customerInsert).toBeTruthy();
        expect(customerInsert.payload.profile_label).toBe('Primary'); // a genuinely separate account, not "Additional property"
        expect(updateCalls.some((c) => c.table === 'leads' && c.payload.customer_id === 'prospect-1')).toBe(true);
      });

      test('an SMS-channel token still counts as verified even though the lead itself is a form lead', async () => {
        firstResults.leads = { ...LEAD_ROW, customer_id: null }; // form lead
        firstResults.services = { id: 'svc-catalog-1', default_duration_minutes: 30 };
        mockOneSlot();
        const existingCustomer = existingCustomerAt('123 Palm Ave');
        mockEnsureCustomerAccount.mockResolvedValueOnce({ accountId: 'acct-9', existingCustomer, matchType: 'phone' });
        listResults.scheduled_services = [];
        firstResults.scheduled_services = { id: 'ss-sms', reschedule_token: 'tok-sms' };

        const token = mintLeadConsultationToken(LEAD_ID, undefined, require('../utils/lead-consultation-token').smsChannelFor(LEAD_ROW.phone)); // this exact link was texted to the lead's current phone
        const res = await callPost(token, { date: FUTURE_DATE, time: '09:00', address: MATCH_ADDRESS });

        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
        expect(mockCreateSelfBooking.mock.calls[0][0].authedCustomer).toEqual(existingCustomer);
        expect(mockEnsureCustomerAccount).toHaveBeenCalledWith(expect.anything(), expect.not.objectContaining({ forceNewAccount: true }));
      });
    });
  });
});

describe('leadContactVerified unit coverage (P1 :585, round 11; phone-bound Codex #4737 r1 P1)', () => {
  const { leadContactVerified } = inspectionPublicRouter._test;
  const { smsChannelFor } = require('../utils/lead-consultation-token');
  const CALL_LEAD = { first_contact_channel: 'call', twilio_call_sid: 'CA-1', phone: '9415550101' };

  test('no lead → false', async () => {
    expect(await leadContactVerified(null, { channel: smsChannelFor('9415550101') }, db)).toBe(false);
  });

  test('an inbound-call lead whose phone still equals the call\'s caller ID → true', async () => {
    firstResults.call_log = { from_phone: '+19415550101' };
    expect(await leadContactVerified(CALL_LEAD, undefined, db)).toBe(true);
  });

  test('an inbound-call lead whose phone was corrected since the call → false', async () => {
    firstResults.call_log = { from_phone: '+19415550999' };
    expect(await leadContactVerified(CALL_LEAD, undefined, db)).toBe(false);
  });

  test('an inbound-call lead with no call record to corroborate → false', async () => {
    firstResults.call_log = null;
    expect(await leadContactVerified(CALL_LEAD, undefined, db)).toBe(false);
    expect(await leadContactVerified({ ...CALL_LEAD, twilio_call_sid: null }, undefined, db)).toBe(false);
  });

  test('an sms claim bound to the lead\'s CURRENT phone → true, even for a form lead', async () => {
    const lead = { first_contact_channel: 'form', phone: '9415550101' };
    expect(await leadContactVerified(lead, { leadId: 'x', channel: smsChannelFor('+1 (941) 555-0101') }, db)).toBe(true);
  });

  test('an sms claim for a DIFFERENT phone (lead phone corrected after the text), or a bare "sms" → false', async () => {
    const lead = { first_contact_channel: 'form', phone: '9415550101' };
    expect(await leadContactVerified(lead, { leadId: 'x', channel: smsChannelFor('9415550999') }, db)).toBe(false);
    expect(await leadContactVerified(lead, { leadId: 'x', channel: 'sms' }, db)).toBe(false);
  });

  test('a form lead with no channel claim, or an email claim → false', async () => {
    const lead = { first_contact_channel: 'form', phone: '9415550101' };
    expect(await leadContactVerified(lead, { leadId: 'x' }, db)).toBe(false);
    expect(await leadContactVerified(lead, { leadId: 'x', channel: 'email' }, db)).toBe(false);
  });
});

describe('matchExistingAccountProfile unit coverage (P1 :585, round 11 tightening)', () => {
  const { matchExistingAccountProfile } = inspectionPublicRouter._test;

  test('no existingCustomer on the account → null (ordinary new-account create applies)', async () => {
    expect(await matchExistingAccountProfile(db, { accountId: 'acct-1', existingCustomer: null }, { line1: '123 Palm Ave' }, null)).toBe(null);
  });

  test('no address to compare at all (address:null) → falls back to the primary/only live property', async () => {
    const primary = { id: 'cust-1', is_primary_profile: true, address_line1: '1 Main St' };
    listResults.customers = [primary, { id: 'cust-2', is_primary_profile: false, address_line1: '2 Main St' }];
    const account = { accountId: 'acct-1', existingCustomer: primary };
    expect(await matchExistingAccountProfile(db, account, null, null)).toEqual(primary);
  });

  // Round 13, Codex pre-push P1, 2026-09-24 (:520): a SUPPLIED address that
  // simply doesn't normalize to a street key (unlike no address at ALL)
  // must never fall back to the primary profile — `address?.line1` is
  // always populated on this path (finalizeBookingLocation only ever
  // succeeds with a real line1), so the old `!key` check silently matched
  // the primary profile for an un-normalizable address and dispatched the
  // visit to the wrong property.
  test('an address WAS supplied but streetKey yields no key → null (a new profile), never the primary-fallback', async () => {
    const primary = { id: 'cust-1', is_primary_profile: true, address_line1: '1 Main St' };
    listResults.customers = [primary];
    const account = { accountId: 'acct-1', existingCustomer: primary };
    // Punctuation-only line1 — streetKey strips every non-alphanumeric
    // character, leaving an empty key.
    expect(await matchExistingAccountProfile(db, account, { line1: '---', zip: '34209' }, null)).toBe(null);
  });

  test('an address with NO line1 but a truthy zip still falls back to the primary — only line1 gates the fallback', async () => {
    const primary = { id: 'cust-1', is_primary_profile: true, address_line1: '1 Main St' };
    listResults.customers = [primary];
    const account = { accountId: 'acct-1', existingCustomer: primary };
    expect(await matchExistingAccountProfile(db, account, { line1: '', zip: '34209' }, null)).toEqual(primary);
  });

  test('street + zip both match (streetKey, suffix-normalized) → that profile, coordinates never checked', async () => {
    const match = { id: 'cust-2', is_primary_profile: false, address_line1: '2 Main Street', zip: '34209' };
    listResults.customers = [{ id: 'cust-1', is_primary_profile: true, address_line1: '1 Elsewhere Rd', zip: '34209' }, match];
    const account = { accountId: 'acct-1', existingCustomer: { id: 'cust-1' } };
    expect(await matchExistingAccountProfile(db, account, { line1: '2 Main St', zip: '34209' }, null)).toEqual(match);
  });

  // Round 11 (Codex pre-push P1, 2026-09-24): a bare street-name match used
  // to be enough — "123 Main St" in one zip is not the same property as
  // "123 Main St" in another.
  test('street matches but zip differs AND stored coordinates are far from the validated location → null, never reused', async () => {
    const wrongZip = { id: 'cust-2', is_primary_profile: false, address_line1: '2 Main Street', zip: '99999', latitude: 40.0, longitude: -100.0 };
    listResults.customers = [wrongZip];
    const account = { accountId: 'acct-1', existingCustomer: { id: 'cust-1' } };
    const validated = { lat: 27.4, lng: -82.5 };
    expect(await matchExistingAccountProfile(db, account, { line1: '2 Main St', zip: '34209' }, validated)).toBe(null);
  });

  test('street matches, zip differs, but stored coordinates ARE within tolerance of the validated location → matches anyway (stale zip on file)', async () => {
    const staleZip = { id: 'cust-2', is_primary_profile: false, address_line1: '2 Main Street', zip: '99999', latitude: 27.401, longitude: -82.501 };
    listResults.customers = [staleZip];
    const account = { accountId: 'acct-1', existingCustomer: { id: 'cust-1' } };
    const validated = { lat: 27.4, lng: -82.5 };
    expect(await matchExistingAccountProfile(db, account, { line1: '2 Main St', zip: '34209' }, validated)).toEqual(staleZip);
  });

  test('street matches, zip differs, stored coordinates JUST outside tolerance → null', async () => {
    const farRow = { id: 'cust-2', is_primary_profile: false, address_line1: '2 Main Street', zip: '99999', latitude: 27.41, longitude: -82.51 };
    listResults.customers = [farRow];
    const account = { accountId: 'acct-1', existingCustomer: { id: 'cust-1' } };
    const validated = { lat: 27.4, lng: -82.5 };
    expect(await matchExistingAccountProfile(db, account, { line1: '2 Main St', zip: '34209' }, validated)).toBe(null);
  });

  test('address matches no live profile at all → null, a genuinely new property', async () => {
    listResults.customers = [{ id: 'cust-1', is_primary_profile: true, address_line1: '1 Elsewhere Rd', zip: '34209' }];
    const account = { accountId: 'acct-1', existingCustomer: { id: 'cust-1' } };
    expect(await matchExistingAccountProfile(db, account, { line1: '99 Nowhere Ave', zip: '34209' }, null)).toBe(null);
  });

  test('local audit P1: same street + zip but a DIFFERENT unit → not that profile', async () => {
    const unit4 = { id: 'cust-2', is_primary_profile: false, address_line1: '2 Main St', address_line2: 'Apt 4', zip: '34209' };
    listResults.customers = [unit4];
    const account = { accountId: 'acct-1', existingCustomer: { id: 'cust-1' } };
    expect(await matchExistingAccountProfile(db, account, { line1: '2 Main St', line2: 'Apt 7', zip: '34209' }, null)).toBe(null);
    expect(await matchExistingAccountProfile(db, account, { line1: '2 Main St Apt 4', zip: '34209' }, null)).toEqual(unit4);
    expect(await matchExistingAccountProfile(db, account, { line1: '2 Main St', zip: '34209' }, null)).toBe(null);
  });

  test('no live profiles come back from the query → falls back to the existingCustomer row itself', async () => {
    const existingCustomer = { id: 'cust-1', address_line1: '5 Palm Ave', zip: '34209' };
    listResults.customers = [];
    const account = { accountId: 'acct-1', existingCustomer };
    expect(await matchExistingAccountProfile(db, account, { line1: '5 Palm Ave', zip: '34209' }, null)).toEqual(existingCustomer);
  });
});

describe('checkServiceArea unit coverage (P1 :355)', () => {
  const { checkServiceArea } = inspectionPublicRouter._test;

  test('no location → not ok, no county', async () => {
    expect(await checkServiceArea(null)).toEqual({ ok: false, county: null });
  });

  test('key configured, county resolves and IS served → ok', async () => {
    mockCounty.mockResolvedValueOnce('Manatee');
    expect(await checkServiceArea({ lat: 27.4989, lng: -82.5748 })).toEqual({ ok: true, county: 'Manatee' });
  });

  test('key configured, county resolves and is NOT served → out_of_area shape', async () => {
    mockCounty.mockResolvedValueOnce('Hardee');
    expect(await checkServiceArea({ lat: 27.4, lng: -81.8 })).toEqual({ ok: false, county: 'Hardee' });
  });

  test('key configured, county lookup throws → treated the same as a null county (unavailable, not a silent pass)', async () => {
    mockCounty.mockRejectedValueOnce(new Error('timeout'));
    expect(await checkServiceArea({ lat: 27.4989, lng: -82.5748 })).toEqual({ ok: false, county: null, unavailable: true });
  });

  // Local audit P1: a same-named county in another state (Charlotte County,
  // VA) must never pass on the name alone — the box guards both modes.
  test('outside the service-area box → out of area even when the county NAME is a served one, no lookup', async () => {
    mockCounty.mockClear();
    mockCounty.mockResolvedValueOnce('Charlotte');
    expect(await checkServiceArea({ lat: 36.9, lng: -78.6 })).toEqual({ ok: false, county: null });
    expect(mockCounty).not.toHaveBeenCalled();
    mockCounty.mockReset();
  });
});

// Structural invariant (Codex pre-push P1, 2026-09-24, round 9): a "booking
// location" is only ever allowed to reach a caller after passing the area
// check. That's only guaranteed if EVERY caller resolves through
// finalizeBookingLocation — a raw resolveServiceAddress or checkServiceArea
// call anywhere else in this file is exactly the bug GET's :638 had (a
// stored address resolved but was never area-checked). Read the file's own
// source rather than re-deriving line numbers by hand, so this fails loudly
// the moment a new call site is added anywhere but inside
// finalizeBookingLocation's own body.
describe('structural: finalizeBookingLocation is the sole producer of a booking location', () => {
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(path.join(__dirname, '../routes/inspection-public.js'), 'utf8');

  function bodyOf(fnName) {
    const start = source.indexOf(`async function ${fnName}(`);
    expect(start).toBeGreaterThan(-1);
    // Balance braces from the function's opening `{` to find its own close.
    const openBrace = source.indexOf('{', start);
    let depth = 0;
    for (let i = openBrace; i < source.length; i += 1) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}') {
        depth -= 1;
        if (depth === 0) return { start, end: i + 1 };
      }
    }
    throw new Error(`unbalanced braces reading ${fnName}`);
  }

  function callSitesOutside(fnPattern, ownerFn) {
    const owner = bodyOf(ownerFn);
    const re = new RegExp(fnPattern, 'g');
    const sites = [];
    let m;
    while ((m = re.exec(source))) {
      const isDefinition = source.slice(Math.max(0, m.index - 20), m.index).includes('function');
      if (isDefinition) continue; // skip the `async function x(` declaration itself
      if (m.index >= owner.start && m.index < owner.end) continue; // inside the owner's own body
      sites.push(m.index);
    }
    return sites;
  }

  test('resolveServiceAddress( is called only from finalizeBookingLocation', () => {
    expect(callSitesOutside('resolveServiceAddress\\(', 'finalizeBookingLocation')).toEqual([]);
  });

  test('checkServiceArea( is called only from serviceAreaFailure', () => {
    expect(callSitesOutside('checkServiceArea\\(', 'serviceAreaFailure')).toEqual([]);
  });

  // The only location not produced by finalizeBookingLocation is a verified
  // lead's adopted property (local audit P1); it is area-checked through the
  // same helper, never a bare checkServiceArea call.
  test('serviceAreaFailure( is called from finalizeBookingLocation and the commit route only', () => {
    const sites = callSitesOutside('serviceAreaFailure\\(', 'finalizeBookingLocation');
    expect(sites).toHaveLength(1);
  });
});

// Round 12, Codex pre-push P1, 2026-09-24: loadLead's own select list
// omitted `first_contact_channel`, silently making leadContactVerified's
// inbound-call branch dead in production — every test still passed because
// the mocked lead row was hand-built with the field already on it, never
// routed through the real loadLead select. Fixed by making loadLead's
// select BUILT FROM the exported LEAD_ROW_FIELDS constant (single source
// of truth) instead of a separately hand-written column list; these tests
// keep the constant itself honest by sweeping the three functions' own
// source for every `lead.<field>` / `freshLead.<field>` access.
describe('structural: loadLead selects every field these functions read off the lead row (P1 :585, round 12)', () => {
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(path.join(__dirname, '../routes/inspection-public.js'), 'utf8');
  const { LEAD_ROW_FIELDS, loadLead } = inspectionPublicRouter._test;

  function bodyOf(fnName) {
    const start = source.indexOf(`function ${fnName}(`);
    expect(start).toBeGreaterThan(-1);
    const openBrace = source.indexOf('{', start);
    let depth = 0;
    for (let i = openBrace; i < source.length; i += 1) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}') {
        depth -= 1;
        if (depth === 0) return source.slice(start, i + 1);
      }
    }
    throw new Error(`unbalanced braces reading ${fnName}`);
  }

  function leadFieldsReadIn(fnName) {
    const body = bodyOf(fnName);
    const fields = new Set();
    const re = /\b(?:lead|freshLead)\??\.([a-zA-Z_][a-zA-Z0-9_]*)/g;
    let m;
    while ((m = re.exec(body))) fields.add(m[1]);
    return fields;
  }

  test('LEAD_ROW_FIELDS is a superset of every lead.<field>/freshLead.<field> access in leadContactVerified, resolveOrLinkCustomerForLead, and matchExistingAccountProfile', () => {
    const swept = new Set([
      ...leadFieldsReadIn('leadContactVerified'),
      ...leadFieldsReadIn('resolveOrLinkCustomerForLead'),
      ...leadFieldsReadIn('matchExistingAccountProfile'),
    ]);
    // Sanity: the sweep must actually find fields, and specifically the
    // exact one this round's audit found missing — an empty/incomplete
    // sweep would make this test pass for the wrong reason.
    expect(swept.has('first_contact_channel')).toBe(true);
    expect(swept.has('first_name')).toBe(true);
    for (const field of swept) {
      expect(LEAD_ROW_FIELDS).toContain(field);
    }
  });

  test("loadLead's actual select call carries every LEAD_ROW_FIELDS column — not a separately hand-written list that could drift from it again", async () => {
    let capturedFields = null;
    const spyChain = {
      where: () => spyChain,
      whereNull: () => spyChain,
      first: async (...fields) => { capturedFields = fields; return null; },
    };
    await loadLead(() => spyChain, 'any-id');
    expect(capturedFields).toEqual(LEAD_ROW_FIELDS);
  });

  test('first_contact_channel is present in LEAD_ROW_FIELDS — the exact column this round\'s audit found missing from production', () => {
    expect(LEAD_ROW_FIELDS).toContain('first_contact_channel');
  });
});

// Round 13, Codex pre-push P1 :845, 2026-09-24: phase 1 holds the per-lead
// advisory lock AND a pooled connection for its whole duration — nothing in
// there may do network I/O (a Google geocode/county lookup,
// buildAvailabilityForLead's own DB+weather work) or open a SECOND
// connection (resolveEligibility's rescheduleUrlFor, hardwired to the
// global `db`), either of which stalling while the lock is held risks
// exhausting the connection pool against itself under load. This reads the
// route file's own source, brace-balances phase 1's `db.transaction(async
// (trx) => {...})` callback to isolate its exact body, and asserts none of
// the network/second-connection call sites appear inside it — fails loudly
// the moment a future edit reintroduces one.
describe('structural: phase 1 never does network I/O or opens a second connection while holding the lock (P1 :845, round 13)', () => {
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(path.join(__dirname, '../routes/inspection-public.js'), 'utf8');

  function phase1TransactionBody() {
    const marker = 'db.transaction(async (trx) => {';
    const start = source.indexOf(marker);
    expect(start).toBeGreaterThan(-1);
    const openBrace = start + marker.length - 1; // the callback's own '{'
    expect(source[openBrace]).toBe('{');
    let depth = 0;
    for (let i = openBrace; i < source.length; i += 1) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}') {
        depth -= 1;
        if (depth === 0) return source.slice(openBrace, i + 1);
      }
    }
    throw new Error('unbalanced braces reading phase 1\'s transaction callback');
  }

  const body = phase1TransactionBody();

  test('sanity: the phase-1 body was actually captured, not an empty/truncated slice', () => {
    expect(body).toContain('pg_advisory_xact_lock');
    expect(body).toContain('resolveOrLinkCustomerForLead');
    expect(body.length).toBeGreaterThan(200);
  });

  test('never calls finalizeBookingLocation / resolveServiceAddress / geocodeAddressWithStatus (Google geocode)', () => {
    expect(body).not.toMatch(/\bfinalizeBookingLocation\(/);
    expect(body).not.toMatch(/\bresolveServiceAddress\(/);
    expect(body).not.toMatch(/\bgeocodeAddressWithStatus\(/);
  });

  test('never calls checkServiceArea / reverseGeocodeCounty (Google county lookup)', () => {
    expect(body).not.toMatch(/\bcheckServiceArea\(/);
    expect(body).not.toMatch(/\breverseGeocodeCounty\(/);
  });

  test('never calls buildAvailabilityForLead / buildBookingAvailability (global-db connection + a gated weather network call)', () => {
    expect(body).not.toMatch(/\bbuildAvailabilityForLead\(/);
    expect(body).not.toMatch(/\bbuildBookingAvailability\(/);
  });

  test('never references the global `db` connection — every read/write in here is trx-scoped', () => {
    // Bare `db(` or `db.`, never part of another identifier (dbConn,
    // freshCustRow, etc.) and never `trx(`/`trx.`.
    expect(body).not.toMatch(/(?<![A-Za-z0-9_.])db\s*[(.]/);
  });

  test('never calls rescheduleUrlFor / buildRescheduleLink directly — resolveEligibility is given includeRescheduleUrl:false instead', () => {
    expect(body).not.toMatch(/\brescheduleUrlFor\(/);
    expect(body).not.toMatch(/\bbuildRescheduleLink\(/);
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

  // Codex pre-push P1, 2026-09-24: NOT 'active' (enrols in ordinary
  // newsletter sends — see newsletter.test.js's buildSubscriberQuery
  // exact-equality pin) and NOT 'pending' (that status has its own live
  // double-opt-in meaning — a future admin CSV import matching this email
  // would queue it a real confirmation email).
  test('inserts at status "waitlist", never "active" or "pending" — never enrols in the newsletter', async () => {
    firstResults.leads = LEAD_ROW;
    const token = mintLeadConsultationToken(LEAD_ID);
    const res = await callWaitlist(token, { email: 'someone@example.com', county: 'Hardee' });
    expect(res.statusCode).toBe(200);
    const insert = insertCalls.find((c) => c.table === 'newsletter_subscribers');
    expect(insert).toBeTruthy();
    expect(insert.payload.status).toBe('waitlist');
    expect(insert.payload.status).not.toBe('active');
    expect(insert.payload.status).not.toBe('pending');
    expect(insert.payload.source).toBe('expansion_waitlist:Hardee');
  });
});

describe('assessment-not-a-win invariant backstop', () => {
  test('promoteCustomerOnBooking short-circuits for a Waves Assessment (the shared guard this route relies on)', async () => {
    const { promoteCustomerOnBooking } = require('../services/customer-stages');
    const result = await promoteCustomerOnBooking(require('../models/db'), 'any-customer-id', { serviceType: 'Waves Assessment' });
    expect(result).toBe(false);
  });
});
