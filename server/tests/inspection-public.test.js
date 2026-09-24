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
      dedupeLane: false,
      alertLabel: expect.stringContaining('Free consultation self-booked'),
    }));
    expect(isAssessmentServiceType(callArgs.callbackVisit.serviceType)).toBe(true);

    // The customer's own address already resolved — no address write-back.
    expect(updateCalls.some((c) => c.table === 'customers')).toBe(false);
  });

  // P1 :532/:544 — the two-phase per-lead advisory lock: both phases take
  // the SAME hashtext key (the coordinator's literal spec), and the whole
  // provisioning/booking critical section runs inside `db.transaction`.
  test('the commit takes a per-lead advisory lock (same key, twice) around provisioning + booking', async () => {
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

    // Two SHORT transactions (phase 1: provisioning, phase 2: the
    // eligibility re-check only — see the :834 test below for proof
    // createSelfBooking runs outside both), each taking the SAME
    // per-lead key.
    expect(db.transaction).toHaveBeenCalledTimes(2);
    const lockCalls = db.raw.mock.calls.filter(([sql]) => String(sql).includes('pg_advisory_xact_lock'));
    expect(lockCalls).toHaveLength(2);
    for (const [, args] of lockCalls) {
      expect(args).toEqual([`inspection_commit:${LEAD_ID}`]);
    }
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
    // creates) so the post-booking safety-net recheck sees its own booking,
    // not a false mismatch.
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

  // P1 :800 — two concurrent submissions for an addressless lead can each
  // resolve a DIFFERENT address before either takes the lock; without a
  // fresh re-check under the lock the second would overwrite the first's
  // just-persisted address with its own stale supplied one, and the
  // first's own createSelfBooking (which reloads the customer fresh) would
  // then book against the second's address. Simulated interleaving: the
  // SECOND commit's geocode call for its OWN supplied address ("222 B St")
  // is the moment (via a mockGeocode side effect) the FIRST commit's
  // address lands on the customer row — by the time phase 1 re-reads the
  // customer fresh under the lock, it sees A, not B.
  describe('address-resolution interleaving under the lock (P1 :800)', () => {
    const LOC_A = { lat: 27.55, lng: -82.55 };
    const LOC_B = { lat: 27.7, lng: -82.7 };
    const addresslessCustomer = () => ({
      id: 'cust-1', address_line1: null, address_line2: null, city: null, state: 'FL', zip: null, latitude: null, longitude: null,
    });

    test('the second commit sees the first\'s persisted address and books against it, never overwriting with its own supplied one', async () => {
      firstResults.leads = { ...LEAD_ROW, customer_id: 'cust-1' };
      firstResults.customers = addresslessCustomer();
      listResults.scheduled_services = [];
      firstResults.services = { id: 'svc-catalog-1', default_duration_minutes: 30 };
      mockGeocode.mockImplementation(async (addressStr) => {
        if (String(addressStr).includes('222 B St')) {
          // The interleaving: while resolving B, the first commit's address
          // lands on the customer row.
          firstResults.customers = {
            id: 'cust-1', address_line1: '111 A St', address_line2: null,
            city: 'Bradenton', state: 'FL', zip: '34209', latitude: LOC_A.lat, longitude: LOC_A.lng,
          };
          return { location: LOC_B };
        }
        if (String(addressStr).includes('111 A St')) return { location: LOC_A };
        return { location: null };
      });
      // Same valid slot at both locations — this test proves the address
      // choice and the no-overwrite, not the slot-mismatch branch (see the
      // 409 test below for that).
      mockBuildAvailability.mockImplementation(async () => ({
        days: [{ date: FUTURE_DATE, slots: [{ start_time: '09:00', end_time: '09:30', start_label: '9:00 AM', end_label: '9:30 AM', technician_id: 'tech-1' }] }],
      }));
      firstResults.scheduled_services = { id: 'ss-800', reschedule_token: 'tok-800' };

      const token = mintLeadConsultationToken(LEAD_ID);
      // First commit: address A, addressless customer — persists A.
      const first = await callPost(token, { date: FUTURE_DATE, time: '09:00', address: '111 A St, Bradenton, FL 34209' });
      expect(first.statusCode).toBe(200);
      expect(first.body.success).toBe(true);
      const firstUpdate = updateCalls.find((c) => c.table === 'customers');
      expect(firstUpdate.payload.address_line1).toMatch(/111 A St/);

      updateCalls.length = 0;
      mockCreateSelfBooking.mockClear();

      // Second commit: supplies B, but by the time phase 1 re-reads the
      // customer under the lock, A is already there (the mockGeocode side
      // effect above).
      const second = await callPost(token, { date: FUTURE_DATE, time: '09:00', address: '222 B St, Bradenton, FL 34209' });
      expect(second.statusCode).toBe(200);
      expect(second.body.success).toBe(true);
      // Books against A, not B — authedCustomer carries A's address.
      expect(mockCreateSelfBooking).toHaveBeenCalledTimes(1);
      expect(mockCreateSelfBooking.mock.calls[0][0].authedCustomer.address_line1).toBe('111 A St');
      expect(mockCreateSelfBooking.mock.calls[0][0].authedCustomer.latitude).toBe(LOC_A.lat);
      // Never overwrites the customer's now-persisted A with the supplied B.
      expect(updateCalls.find((c) => c.table === 'customers')).toBeUndefined();
    });

    test('on a slot mismatch between the supplied and the fresh stored address, 409s with fresh availability instead of booking the wrong location', async () => {
      firstResults.leads = { ...LEAD_ROW, customer_id: 'cust-1' };
      firstResults.customers = addresslessCustomer();
      listResults.scheduled_services = [];
      firstResults.services = { id: 'svc-catalog-1', default_duration_minutes: 30 };
      mockGeocode.mockImplementation(async (addressStr) => {
        if (String(addressStr).includes('222 B St')) {
          firstResults.customers = {
            id: 'cust-1', address_line1: '111 A St', address_line2: null,
            city: 'Bradenton', state: 'FL', zip: '34209', latitude: LOC_A.lat, longitude: LOC_A.lng,
          };
          return { location: LOC_B };
        }
        if (String(addressStr).includes('111 A St')) return { location: LOC_A };
        return { location: null };
      });
      // Call sequence: (1) first commit's own anti-forgery check at A —
      // succeeds; (2) second commit's pre-lock anti-forgery check at ITS
      // supplied B — succeeds; (3) second commit's phase-1 re-check at the
      // fresh stored A — this specific slot is gone there, forcing the 409.
      const openSlot = { days: [{ date: FUTURE_DATE, slots: [{ start_time: '09:00', end_time: '09:30', start_label: '9:00 AM', end_label: '9:30 AM', technician_id: 'tech-1' }] }] };
      mockBuildAvailability
        .mockResolvedValueOnce(openSlot)
        .mockResolvedValueOnce(openSlot)
        .mockResolvedValueOnce({ days: [{ date: FUTURE_DATE, slots: [] }] });
      firstResults.scheduled_services = { id: 'ss-800b', reschedule_token: 'tok-800b' };

      const token = mintLeadConsultationToken(LEAD_ID);
      const first = await callPost(token, { date: FUTURE_DATE, time: '09:00', address: '111 A St, Bradenton, FL 34209' });
      expect(first.statusCode).toBe(200);

      mockCreateSelfBooking.mockClear();
      const second = await callPost(token, { date: FUTURE_DATE, time: '09:00', address: '222 B St, Bradenton, FL 34209' });
      expect(second.statusCode).toBe(409);
      expect(second.body.code).toBe('SLOT_TAKEN');
      expect(mockCreateSelfBooking).not.toHaveBeenCalled();
    });
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
