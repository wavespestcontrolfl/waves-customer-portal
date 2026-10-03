/**
 * Customer self-serve re-service scheduler — lane eligibility classification,
 * booking-window range parity with the reschedule page, the reservice-link
 * SMS clause contract, and the createSelfBooking `callbackVisit` trust
 * boundary (internal callers skip the signed-offer gate; a crafted /confirm
 * body must NOT).
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'reservice-test-secret';

jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

// Gate switchboard — reservice code lazy-requires feature-gates per call, so
// flipping this map flips the gate per test.
const gateState = { reserviceSelfServe: true, selfBooking: true, bookingCustomersOnly: false, reservicePestChips: false };
jest.mock('../config/feature-gates', () => ({
  gateEnvValue: jest.requireActual('../config/feature-gates').gateEnvValue,
  isEnabled: jest.fn((name) => (name in gateState ? gateState[name] : true)),
  // GATE_BOOK_CAPACITY_COMMIT (owner 2026-09-28, PR #5231 rounds 1-2):
  // routes/booking.js is NOT mocked in this file, so buildAvailabilityFor
  // Customer's real capacityPlacement: bookInsertionOffersLive() call runs
  // the real booking.js function, which reads this mock (bookCapacityCommitLive
  // && capacityEnabled() — the AND short-circuits here without needing
  // capacityEnabled mocked too). Off by default — this file is not about
  // that gate, and false matches this route's pre-existing (append-only)
  // behavior for every test that doesn't override it.
  bookCapacityCommitLive: jest.fn(() => false),
  // GATE_BOOK_ARRIVAL_GRACE (2026-09-29): routes/booking.js reads this
  // canonical reader; off here — it only ever runs behind
  // bookInsertionOffersLive() anyway (also off).
  bookArrivalGraceLive: jest.fn(() => false),
  // GATE_RESERVICE_DETAILS_REQUIRED canonical reader, driven by gateState.
  reserviceDetailsRequiredLive: jest.fn(() => gateState.reserviceDetailsRequired === true),
  // GATE_RESERVICE_PHOTOS canonical reader (already ANDed with
  // GATE_VISIT_PREP_PHOTOS in the real module), driven by gateState.
  reservicePhotosLive: jest.fn(() => gateState.reservicePhotos === true),
}));

// Re-service photos reuse appointment-public.js's visit-prep helpers and
// visit-prep.js's summary; both are stubbed here (this file tests the
// re-service identity rule and wiring, visit-prep has its own suites).
jest.mock('../routes/appointment-public', () => ({
  deriveVisitPrepEligibility: jest.fn(async () => ({ eligible: true, reason: null })),
  reloadEligibleVisitPrepRowCore: jest.fn(async (svc) => svc),
  notifyOfficeVisitPrepSubmission: jest.fn(async () => {}),
}));
jest.mock('../services/visit-prep', () => ({
  VISIT_PREP_LIMITS: { photosPerSubmission: 3 },
  visitPrepSummary: jest.fn(async () => ({ photoCount: 0, photosRemaining: 6, submissionCount: 0 })),
  createVisitPrepSubmission: jest.fn(async () => ({
    created: false, stored: 0, summary: { photoCount: 1, photosRemaining: 5 }, svc: {},
  })),
}));

// Universal query-chain mock (same shape booking-customers-only-gate.test.js
// uses): chain methods return the chain, .first() resolves firstResults,
// list terminals resolve listResults.
const firstResults = {};
const listResults = {};
const mockDbFailures = new Set(); // tables whose list reads reject (a dependency outage)
const mockCallbackReadFailure = { on: false }; // only the open-CALLBACK read rejects (coverage read still works)
jest.mock('../models/db', () => {
  const mkChain = (table) => {
    const q = {};
    let callbackOnly = false;
    const passthrough = [
      'where', 'whereIn', 'whereNot', 'whereNotIn', 'whereNull', 'whereNotNull',
      'whereRaw', 'andWhere', 'orWhere', 'orWhereIn', 'orWhereRaw', 'orderBy',
      'orderByRaw', 'limit', 'offset', 'select', 'join', 'leftJoin', 'groupBy',
      'count', 'modify', 'forShare', 'forUpdate',
    ];
    for (const m of passthrough) q[m] = () => q;
    q.where = (key, value) => {
      if (typeof key === 'function') key.call(q, q);
      if (key === 's.is_callback' && value === true) callbackOnly = true;
      return q;
    };
    q.first = async () => (firstResults[table] !== undefined ? firstResults[table] : null);
    q.then = (onOk, onErr) => (mockDbFailures.has(table) || (mockCallbackReadFailure.on && callbackOnly)
      ? Promise.reject(new Error(`db down: ${table}`)).then(onOk, onErr)
      : Promise.resolve(callbackOnly ? [] : (listResults[table] || [])).then(onOk, onErr));
    q.catch = (fn) => Promise.resolve(listResults[table] || []).catch(fn);
    return q;
  };
  const dbFn = jest.fn((table) => mkChain(table));
  dbFn.raw = (sql) => sql;
  dbFn.transaction = async () => { throw new Error('transaction should not be reached in these tests'); };
  return dbFn;
});

jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: jest.fn(async (longUrl) => longUrl),
}));

const fs = require('fs');
const path = require('path');
const { etDateString, addETDays } = require('../utils/datetime-et');
const {
  RESERVICE_LANES,
  OPEN_CALLBACK_STATUSES,
  NON_COVERAGE_STATUSES,
  laneForCoverageRow,
  laneForCallbackRow,
  reserviceLanesForCustomer,
} = require('../services/reservice-scheduler');
const { buildReserviceLink, reserviceSmsLineFor } = require('../services/reservice-link');
const db = require('../models/db');
const reservicePublicRouter = require('../routes/reservice-public');
const { createSelfBooking } = require('../routes/booking')._internals;

const { TOKEN_RE, bookingRange, searchParseOpts } = reservicePublicRouter._test;

// Fixed "now": 2026-07-02 12:00 ET (16:00 UTC, EDT).
const NOW = new Date('2026-07-02T16:00:00.000Z');
const CUST_ID = '5b8d1c9e-4a2f-4b6e-9c3d-8e7f6a5b4c3d';

afterEach(() => {
  for (const key of Object.keys(firstResults)) delete firstResults[key];
  for (const key of Object.keys(listResults)) delete listResults[key];
  gateState.reserviceSelfServe = true;
  gateState.reservicePestChips = false;
});

describe('lane classification', () => {
  test('coverage rows: catalog category wins, label regex is the fallback, other families get no lane', () => {
    expect(laneForCoverageRow({ category: 'lawn_care' })).toBe('lawn');
    expect(laneForCoverageRow({ category: 'pest_control' })).toBe('pest');
    // Category present but out-of-lane → null even with a pest-ish label.
    expect(laneForCoverageRow({ category: 'mosquito', serviceType: 'Pest Control' })).toBe(null);
    // No category: free-text label decides.
    expect(laneForCoverageRow({ serviceType: 'Monthly Lawn Care Program' })).toBe('lawn');
    expect(laneForCoverageRow({ serviceType: 'Turf Treatment' })).toBe('lawn');
    expect(laneForCoverageRow({ serviceType: 'General Pest Control' })).toBe('pest');
    expect(laneForCoverageRow({ serviceType: 'WaveGuard Quarterly' })).toBe('pest');
    expect(laneForCoverageRow({ serviceType: 'Mosquito Control' })).toBe(null);
    expect(laneForCoverageRow({ serviceType: 'Termite Bait Monitoring' })).toBe(null);
    // Rodent-led labels contain "pest" ("Rodent Pest Control" is
    // rodent_general_one_time's canonical label) but rodent work stays
    // office-handled — same carve-out toQualifyingKeys makes (codex P2).
    expect(laneForCoverageRow({ serviceType: 'Rodent Pest Control' })).toBe(null);
    expect(laneForCoverageRow({ serviceType: 'Commercial Pest Program' })).toBe(null);
    expect(laneForCoverageRow({ serviceType: 'One-Time Pest Control' })).toBe(null);
    // Exclusions beat the LAWN fallback too — a combined label from an
    // excluded family must not become a self-bookable lawn lane (codex r2 P2).
    expect(laneForCoverageRow({ serviceType: 'Commercial Turf Treatment Program' })).toBe(null);
    expect(laneForCoverageRow({ serviceType: 'One-Time Lawn Care' })).toBe(null);
    expect(laneForCoverageRow({ serviceType: 'Tree & Shrub + Lawn Bundle' })).toBe(null);
    expect(laneForCoverageRow({})).toBe(null);
  });

  test('callback rows: catalog key is authoritative, lawn label regex splits the rest, default pest', () => {
    expect(laneForCallbackRow({ serviceKey: 'lawn_re_service' })).toBe('lawn');
    expect(laneForCallbackRow({ serviceKey: 'pest_re_service', serviceType: 'Lawn Care Re-Service' })).toBe('pest');
    expect(laneForCallbackRow({ serviceType: 'Lawn Care Re-Service' })).toBe('lawn');
    expect(laneForCallbackRow({ serviceType: 'Pest Control Re-Service' })).toBe('pest');
    // Office-flagged retreat on a regular row with no re-service naming
    // still blocks the pest lane (one open free visit per lane).
    expect(laneForCallbackRow({ serviceType: 'General Pest Control' })).toBe('pest');
  });

  test('a WaveGuard membership grants the pest lane across seeded-extension gaps — but only PEST-BACKED (codex r2 P1)', async () => {
    // No upcoming coverage rows (between seeded extensions)…
    listResults['scheduled_services as s'] = [];
    // …but completed recurring pest history backs the membership.
    listResults['scheduled_services as hist'] = [
      { service_type: 'General Pest Control', is_callback: false, service_key: null, category: null },
    ];
    expect(await reserviceLanesForCustomer({ id: CUST_ID, waveguard_tier: 'Silver' })).toEqual(['pest']);

    // Auto tier enrollment can stamp waveguard_tier from ANY qualifying
    // family — a mosquito-only member's history classifies to no lane, so
    // the tier label alone must not unlock a free pest callback.
    listResults['scheduled_services as hist'] = [
      { service_type: 'Mosquito Control', is_callback: false, service_key: null, category: 'mosquito' },
    ];
    expect(await reserviceLanesForCustomer({ id: CUST_ID, waveguard_tier: 'Silver' })).toEqual([]);

    // A free callback in the history is not coverage evidence either.
    listResults['scheduled_services as hist'] = [
      { service_type: 'Pest Control Re-Service', is_callback: true, service_key: 'pest_re_service', category: 'pest_control' },
    ];
    expect(await reserviceLanesForCustomer({ id: CUST_ID, waveguard_tier: 'Silver' })).toEqual([]);

    // Tier with zero service history: conservative no-lane (office-handled).
    listResults['scheduled_services as hist'] = [];
    expect(await reserviceLanesForCustomer({ id: CUST_ID, waveguard_tier: 'Silver' })).toEqual([]);
  });

  test('membership pest evidence counts only LIVE coverage — cancelled/no-show/skipped/rescheduled rows are excluded, completed stays (codex r3 P2)', () => {
    // The db mock passes filters through, so the contract is pinned on the
    // constant + the query source: every terminal status EXCEPT completed is
    // excluded from evidence.
    expect([...NON_COVERAGE_STATUSES].sort()).toEqual(['cancelled', 'no_show', 'rescheduled', 'skipped']);
    const schedulerSrc = fs.readFileSync(path.join(__dirname, '../services/reservice-scheduler.js'), 'utf8');
    const evidenceIdx = schedulerSrc.indexOf('async function membershipPestEvidence(');
    const statusFilterIdx = schedulerSrc.indexOf(".whereNotIn('hist.status', NON_COVERAGE_STATUSES)", evidenceIdx);
    const evidenceEndIdx = schedulerSrc.indexOf('async function reserviceLanesForCustomer(', evidenceIdx);
    expect(evidenceIdx).toBeGreaterThan(-1);
    expect(statusFilterIdx).toBeGreaterThan(evidenceIdx);
    expect(statusFilterIdx).toBeLessThan(evidenceEndIdx);
  });

  test('coverage rows add lanes; callback and re-service rows never count as coverage', async () => {
    // The service aliases the table ('scheduled_services as s') — the mock
    // keys on the literal string knex receives.
    listResults['scheduled_services as s'] = [
      { service_type: 'Monthly Lawn Care Program', is_callback: false, service_key: null, category: null },
      // A booked free callback must not entitle the next one on its own.
      { service_type: 'Pest Control Re-Service', is_callback: true, service_key: 'pest_re_service', category: 'pest_control' },
    ];
    const lanes = await reserviceLanesForCustomer({ id: CUST_ID, waveguard_tier: null, monthly_rate: 0 });
    expect(lanes).toEqual(['lawn']);
  });

  test('no membership + no coverage = not eligible', async () => {
    listResults.scheduled_services = [];
    const lanes = await reserviceLanesForCustomer({ id: CUST_ID, waveguard_tier: null, monthly_rate: 0 });
    expect(lanes).toEqual([]);
  });
});

describe('reservice-public token + booking window', () => {
  test('token format: 64-char lowercase hex only', () => {
    expect(TOKEN_RE.test('a'.repeat(64))).toBe(true);
    expect(TOKEN_RE.test('A'.repeat(64))).toBe(false);
    expect(TOKEN_RE.test('a'.repeat(63))).toBe(false);
    expect(TOKEN_RE.test('')).toBe(false);
  });

  test('booking window mirrors the /book funnel and reschedule-page config range', () => {
    expect(bookingRange({ advance_days_min: 1, advance_days_max: 14 }, NOW))
      .toEqual({ rangeFrom: '2026-07-03', rangeTo: '2026-07-16' });
    expect(bookingRange({}, NOW))
      .toEqual({ rangeFrom: '2026-07-03', rangeTo: '2026-07-16' });
  });

  test('AI search opts clamp BOTH ends to the booking window — no 90-day reach', () => {
    expect(searchParseOpts({ advance_days_min: 2, advance_days_max: 21 }, NOW))
      .toEqual({ now: NOW, minDaysOut: 2, maxDaysOut: 21, defaultWindowDays: 21 });
    expect(searchParseOpts({}, NOW).maxDaysOut).toBe(14);
  });
});

describe('reservice-link SMS clause', () => {
  test('renders the embed clause for a URL and empty string for none', () => {
    expect(reserviceSmsLineFor('https://portal.wavespestcontrol.com/l/abc12'))
      .toBe('Book your free re-service here: https://portal.wavespestcontrol.com/l/abc12\n\n');
    expect(reserviceSmsLineFor(null)).toBe('');
    expect(reserviceSmsLineFor('')).toBe('');
  });

  test('gate off mints nothing — no dark-launch links in texts', async () => {
    gateState.reserviceSelfServe = false;
    firstResults.customers = { id: CUST_ID, reservice_token: 'a'.repeat(64) };
    expect(await buildReserviceLink(CUST_ID)).toEqual({ url: null, line: '' });
  });

  test('gate on: builds the portal URL from the customer token', async () => {
    firstResults.customers = { id: CUST_ID, reservice_token: 'a'.repeat(64) };
    const { url, line } = await buildReserviceLink(CUST_ID);
    expect(url).toContain(`/reservice/${'a'.repeat(64)}`);
    expect(line).toContain('free re-service');
  });

  test('a pre-backfill row without a token yields no link', async () => {
    firstResults.customers = { id: CUST_ID, reservice_token: null };
    expect(await buildReserviceLink(CUST_ID)).toEqual({ url: null, line: '' });
  });
});

describe('createSelfBooking callbackVisit trust boundary', () => {
  const SLOT_DATE = etDateString(addETDays(new Date(), 3));

  // An internal-caller payload: identity via authedCustomer (the reservice
  // token already proved it), a valid future whole-hour slot, no slot_sig.
  const internalPayload = () => ({
    slot_date: SLOT_DATE,
    slot_start: '09:00',
    customer_notes: 'Re-service request: ants are back',
    source: 'reservice_link',
    authedCustomer: { id: CUST_ID, active: true, account_id: null },
    payAtVisit: false,
    customersOnly: false,
    callbackVisit: {
      serviceKey: RESERVICE_LANES.pest.serviceKey,
      serviceId: 'svc-row-1',
      serviceType: 'Pest Control Re-Service',
      durationMinutes: 45,
    },
  });

  test('an internal callbackVisit passes the signed-offer gate without a sig (offer proof = caller availability rebuild)', async () => {
    // Sentinel: the full-row customer lookup sits AFTER the signature gate —
    // reaching its 404 proves the gate was (legitimately) skipped.
    firstResults.customers = null;
    const result = await createSelfBooking(internalPayload());
    expect(result).toEqual({ ok: false, status: 404, error: 'Customer not found' });
  });

  test('the SAME payload without callbackVisit dies at the signed-offer gate — the skip is the option, not the surface', async () => {
    const payload = internalPayload();
    delete payload.callbackVisit;
    payload.service_type = 'Pest Control';
    const result = await createSelfBooking(payload);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(409);
    expect(result.error).toMatch(/no longer available/);
  });

  test('POST /confirm pins callbackVisit null — a crafted body cannot skip the gate or mint a free callback', async () => {
    // Drive the /confirm handler directly (no supertest in this repo): the
    // final layer of the route is the handler; the rate limiters ahead of it
    // are irrelevant to the trust boundary under test.
    const bookingRouter = require('../routes/booking');
    const layer = bookingRouter.stack.find((l) => l.route?.path === '/confirm' && l.route.methods.post);
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;

    const req = {
      body: {
        slot_date: SLOT_DATE,
        slot_start: '09:00',
        service_type: 'Pest Control',
        new_customer: {
          first_name: 'Pat', last_name: 'Lee', phone: '941-555-0101',
          address_line1: '123 Palm Ave', zip: '34231', lat: 27.34, lng: -82.53,
        },
        // The forgery under test: if the spread let this through, the sig
        // gate would be skipped and the request would proceed past 409.
        callbackVisit: {
          serviceKey: 'pest_re_service',
          serviceId: 'svc-row-1',
          serviceType: 'Pest Control Re-Service',
          durationMinutes: 45,
        },
      },
      get: () => null,
    };
    const res = {
      statusCode: 200,
      body: null,
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.body = payload; return this; },
    };
    await handler(req, res, (err) => { throw err; });

    expect(res.statusCode).toBe(409);
    expect(res.body.error).toMatch(/no longer available/);
  });
});

describe('lane dedupe atomicity (source guards, codex P1 #3194)', () => {
  const bookingSrc = fs.readFileSync(path.join(__dirname, '../routes/booking.js'), 'utf8');

  test('the commit transaction takes the customer+lane advisory lock and re-checks the open callback INSIDE it', () => {
    const txIdx = bookingSrc.indexOf('txResult = await db.transaction');
    const laneLockIdx = bookingSrc.indexOf("['reservice-lane', `${custId}:${callbackVisit.serviceKey}`]");
    const recheckIdx = bookingSrc.indexOf('await openCallbackExistsForLane(trx, custId, lane)');
    const insertIdx = bookingSrc.indexOf("await trx('self_booked_appointments').insert({");
    expect(txIdx).toBeGreaterThan(-1);
    // Lock, then re-check, both inside the transaction and before the insert.
    expect(laneLockIdx).toBeGreaterThan(txIdx);
    expect(recheckIdx).toBeGreaterThan(laneLockIdx);
    expect(recheckIdx).toBeLessThan(insertIdx);
    // The dedupe answers with its own code so the route can distinguish it
    // from a slot race.
    expect(bookingSrc).toMatch(/code: 'ALREADY_BOOKED',/);
    expect(bookingSrc).toMatch(/txErr\.code === 'SLOT_TAKEN' \|\| txErr\.code === 'DAY_FULL' \|\| txErr\.code === 'ALREADY_BOOKED'/);
  });

  test('a callback commit only replays ITS OWN service — a parallel other-lane or paid booking at the same start falls through to the real checks (codex r3 P2)', () => {
    const replayIdx = bookingSrc.indexOf("const replayQuery = trx('self_booked_appointments')");
    const laneQualifierIdx = bookingSrc.indexOf("if (callbackVisit) replayQuery.where('service_type', resolvedServiceType);");
    // Round-10 P2 :1593 replaced the unconditional replay return with a
    // linked-visit liveness gate — `if (replayIsLive) return { existing };`
    // is the new terminal marker for "the replay decision is settled".
    const replayReturnIdx = bookingSrc.indexOf('if (replayIsLive) return { existing };');
    const recheckIdx = bookingSrc.indexOf('await openCallbackExistsForLane(trx, custId, lane)');
    expect(replayIdx).toBeGreaterThan(-1);
    // The service qualifier applies to the replay lookup, before its return,
    // and the lane dedupe still runs after a non-matching replay.
    expect(laneQualifierIdx).toBeGreaterThan(replayIdx);
    expect(laneQualifierIdx).toBeLessThan(replayReturnIdx);
    expect(recheckIdx).toBeGreaterThan(replayReturnIdx);
  });

  test('live callbacks (en_route/on_site) still block the lane — dedupe uses the open-status set (codex P2)', () => {
    expect(OPEN_CALLBACK_STATUSES).toEqual(['pending', 'confirmed', 'en_route', 'on_site']);
  });

  test('a $0 re-service callback never converts abandoned-booking intents — both marks carve out callbackVisit (codex r2 P2)', () => {
    // In-transaction mark: gated on !callbackVisit.
    expect(bookingSrc).toMatch(/if \(!callbackVisit && bookedTen\.length === 10\) \{/);
    // Replay-path helper: early-returns for callbackVisit before touching
    // booking_intents.
    const helperIdx = bookingSrc.indexOf('const markBookingIntentsConverted = async (bookingId) => {');
    const carveOutIdx = bookingSrc.indexOf('if (callbackVisit) return;', helperIdx);
    const helperUpdateIdx = bookingSrc.indexOf("await db('booking_intents')", helperIdx);
    expect(helperIdx).toBeGreaterThan(-1);
    expect(carveOutIdx).toBeGreaterThan(helperIdx);
    expect(carveOutIdx).toBeLessThan(helperUpdateIdx);
  });
});


test.each([[['pest'], 'pest_control'], [['lawn'], 'lawn_care'], [['pest', 'lawn'], 'pest_control+lawn_care']])(
  're-service availability forwards requested lanes %j to capability filtering', async (lanes, serviceKey) => {
    const booking = require('../routes/booking')._internals;
    const build = jest.spyOn(booking, 'buildBookingAvailability').mockResolvedValue({ days: [] });
    try {
      await reservicePublicRouter._test.buildAvailabilityForCustomer({ latitude: 27.4, longitude: -82.4 }, {
        rangeFrom: '2027-05-20', rangeTo: '2027-05-20', config: {}, duration: 30, lanes,
      });
      expect(build).toHaveBeenCalledWith(expect.objectContaining({ serviceKey }));
    } finally { build.mockRestore(); }
  },
);

test('re-service availability opts every buildAvailabilityForCustomer call into the reservice rank profile (GATE_RESERVICE_RANK_AFTER_NEW)', async () => {
  // buildAvailabilityForCustomer is the ONE shared helper behind browse (GET),
  // find-slots, the commit-time single-day revalidation, and both SLOT_TAKEN
  // refreshes — passing rankProfile here covers every one of them.
  const booking = require('../routes/booking')._internals;
  const build = jest.spyOn(booking, 'buildBookingAvailability').mockResolvedValue({ days: [] });
  try {
    await reservicePublicRouter._test.buildAvailabilityForCustomer({ latitude: 27.4, longitude: -82.4 }, {
      rangeFrom: '2027-05-20', rangeTo: '2027-05-20', config: {}, duration: 30, lanes: ['pest'],
    });
    expect(build).toHaveBeenCalledWith(expect.objectContaining({ rankProfile: 'reservice' }));
  } finally { build.mockRestore(); }
});


describe('selected-lane availability for a customer with both plans', () => {
  let build;
  let config;
  const oldGate = process.env.GATE_SCHEDULING_CAPACITY;
  beforeEach(() => {
    process.env.GATE_SCHEDULING_CAPACITY = 'true';
    firstResults.customers = { id: CUST_ID, latitude: 27.4, longitude: -82.4 };
    listResults.services = [
      { id: 'pest-service', service_key: 'pest_re_service', default_duration_minutes: 20 },
      { id: 'lawn-service', service_key: 'lawn_re_service', default_duration_minutes: 30 },
    ];
    listResults['scheduled_services as s'] = [
      { category: 'pest_control', service_type: 'General Pest Control' },
      { category: 'lawn_care', service_type: 'Monthly Lawn Care Program' },
    ];
    const booking = require('../routes/booking')._internals;
    config = jest.spyOn(booking, 'loadBookingConfig').mockResolvedValue({});
    build = jest.spyOn(booking, 'buildBookingAvailability').mockImplementation(async ({ serviceKey }) => ({
      slots: [], days: [{ date: '2027-05-20', slots: [{ technician_id: serviceKey === 'pest_control' ? 'pest-only' : 'lawn-only' }] }],
    }));
  });
  afterEach(() => {
    config.mockRestore(); build.mockRestore();
    if (oldGate === undefined) delete process.env.GATE_SCHEDULING_CAPACITY;
    else process.env.GATE_SCHEDULING_CAPACITY = oldGate;
  });
  async function browse(query) {
    const handler = reservicePublicRouter.stack.find(layer => layer.route?.path === '/:token' && layer.route.methods.get).route.stack[0].handle;
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    const next = jest.fn();
    await handler({ params: { token: 'a'.repeat(64) }, query }, res, next);
    expect(next).not.toHaveBeenCalled();
    return res;
  }
  test('waits for selection instead of requiring a technician eligible for both plans', async () => {
    const res = await browse({});
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ state: 'bookable', availability: null }));
    expect(build).not.toHaveBeenCalled();
  });
  test.each([['pest', 'pest_control', 20, 'pest-only'], ['lawn', 'lawn_care', 30, 'lawn-only']])(
    'offers the %s lane with its own duration and technician capability', async (lane, serviceKey, duration, technician) => {
      const res = await browse({ lane });
      expect(build).toHaveBeenCalledWith(expect.objectContaining({ serviceKey, duration }));
      expect(res.json.mock.calls[0][0].availability.days[0].slots[0].technician_id).toBe(technician);
    },
  );
  test('legacy browse keeps shared longest-duration behavior with capacity disabled', async () => {
    process.env.GATE_SCHEDULING_CAPACITY = 'false';
    await browse({});
    expect(build).toHaveBeenCalledWith(expect.objectContaining({ duration: 30 }));
  });
  test('search requires a lane for dual-plan capacity and forwards the selected lane', async () => {
    const parser = require('../services/scheduling/parse-when');
    const parse = jest.spyOn(parser, 'parseWhen').mockResolvedValue({ dateFrom: '2027-05-20', dateTo: '2027-05-20', timeOfDay: 'afternoon' });
    const summary = jest.spyOn(parser, 'summarizeWindow').mockReturnValue('Available times');
    const handler = reservicePublicRouter.stack.find(layer => layer.route?.path === '/:token/find-slots').route.stack.at(-1).handle;
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    const next = jest.fn();
    try {
      await handler({ params: { token: 'a'.repeat(64) }, body: { query: 'afternoon' } }, res, next);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(parse).not.toHaveBeenCalled();
      await handler({ params: { token: 'a'.repeat(64) }, body: { query: 'afternoon', lane: 'lawn' } }, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(build).toHaveBeenCalledWith(expect.objectContaining({ duration: 30, serviceKey: 'lawn_care', timeOfDay: 'afternoon' }));
    } finally { parse.mockRestore(); summary.mockRestore(); }
  });
  test('a stale selected lane refreshes eligibility and the remaining lane can be browsed', async () => {
    listResults['scheduled_services as s'] = [{ category: 'lawn_care', service_type: 'Monthly Lawn Care Program' }];
    const stale = await browse({ lane: 'pest' });
    expect(stale.status).not.toHaveBeenCalled();
    expect(stale.json).toHaveBeenCalledWith(expect.objectContaining({ state: 'bookable', availability: null,
      lanes: [expect.objectContaining({ key: 'lawn', alreadyBooked: null })] }));
    expect(build).not.toHaveBeenCalled();
    await browse({});
    expect(build).toHaveBeenCalledWith(expect.objectContaining({ serviceKey: 'lawn_care', duration: 30 }));
  });
  // Codex round-36 P2: the unconditional open-callback read must not turn a dependency outage into a 500 on the PUBLIC page —
  // the non-strict path fails closed to the friendly not-eligible state it always rendered.
  test('a failing eligibility + callback read renders not_eligible (200), never a 500 / next(err)', async () => {
    mockDbFailures.add('scheduled_services as s');
    try {
      const res = await browse({});
      expect(res.status).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ state: 'not_eligible', lanes: [] }));
      expect(build).not.toHaveBeenCalled();
    } finally {
      mockDbFailures.delete('scheduled_services as s');
    }
  });

  // Codex round-39 P2: a failed CALLBACK read (coverage read fine) must not make every covered lane bookable — the page would
  // offer a lane that already holds a booked re-service. It fails closed to the friendly unavailable state.
  test('a failing callback-only read (coverage OK) offers NO lane: not_eligible, no availability built', async () => {
    listResults['scheduled_services as s'] = [{ category: 'pest_control', service_type: 'Quarterly Pest Control' }];
    mockCallbackReadFailure.on = true;
    try {
      const res = await browse({});
      expect(res.status).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ state: 'not_eligible', lanes: [], availability: null }));
      expect(build).not.toHaveBeenCalled();
      const { reserviceLaneAvailability } = require('../services/reservice-scheduler');
      await expect(reserviceLaneAvailability({ id: CUST_ID, active: true }, require('../models/db'))).resolves.toMatchObject({ eligible: [], bookable: [], callbackReadFailed: true });
      await expect(reserviceLaneAvailability({ id: CUST_ID, active: true }, require('../models/db'), { strict: true })).rejects.toThrow(/db down/);
    } finally {
      mockCallbackReadFailure.on = false;
    }
  });

  test('the STRICT availability read (SMS facts / rechecks) still rethrows a failed callback read', async () => {
    const { reserviceLaneAvailability } = require('../services/reservice-scheduler');
    mockDbFailures.add('scheduled_services as s');
    try {
      await expect(reserviceLaneAvailability({ id: CUST_ID, active: true }, require('../models/db'), { strict: true })).rejects.toThrow(/db down/);
      await expect(reserviceLaneAvailability({ id: CUST_ID, active: true }, require('../models/db'))).resolves.toMatchObject({ eligible: [], open: {}, bookable: [] });
    } finally {
      mockDbFailures.delete('scheduled_services as s');
    }
  });

  test('rejects an unavailable service without building offers', async () => {
    const res = await browse({ lane: 'termite' });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(build).not.toHaveBeenCalled();
  });
});

describe('GATE_RESERVICE_PEST_CHIPS', () => {
  const POST_SLOT_DATE = etDateString(addETDays(new Date(), 3));
  let config;
  let build;

  beforeEach(() => {
    firstResults.customers = {
      id: CUST_ID, first_name: 'Jamie', active: true,
      latitude: 27.4, longitude: -82.4,
      address_line1: '123 Palm Ave', city: 'Bradenton', state: 'FL', zip: '34205', phone: '9415550101',
    };
    listResults.services = [
      { id: 'pest-service', service_key: 'pest_re_service', name: 'Pest Control Re-Service', default_duration_minutes: 20 },
      { id: 'lawn-service', service_key: 'lawn_re_service', name: 'Lawn Care Re-Service', default_duration_minutes: 30 },
    ];
    listResults['scheduled_services as s'] = [
      { category: 'pest_control', service_type: 'General Pest Control' },
      { category: 'lawn_care', service_type: 'Monthly Lawn Care Program' },
    ];
    const booking = require('../routes/booking')._internals;
    config = jest.spyOn(booking, 'loadBookingConfig').mockResolvedValue({});
    build = jest.spyOn(booking, 'buildBookingAvailability').mockResolvedValue({
      slots: [],
      days: [{ date: POST_SLOT_DATE, slots: [{ start_time: '09:00', end_time: '10:00', technician_id: 'tech-1' }] }],
    });
  });

  afterEach(() => {
    config.mockRestore();
    build.mockRestore();
  });

  function getHandler() {
    return reservicePublicRouter.stack.find((layer) => layer.route?.path === '/:token' && layer.route.methods.get).route.stack[0].handle;
  }
  function postHandler() {
    return reservicePublicRouter.stack.find((layer) => layer.route?.path === '/:token' && layer.route.methods.post).route.stack.at(-1).handle;
  }
  async function callHandler(handler, req) {
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    const next = jest.fn((err) => { if (err) throw err; });
    await handler(req, res, next);
    return res;
  }
  // POST helper: spies on createSelfBooking and returns the arg it was
  // called with, so each test below only states its body + assertions.
  async function postAndCapture(body) {
    const csb = jest.spyOn(require('../routes/booking')._internals, 'createSelfBooking').mockResolvedValue({
      ok: true, body: { booking: { id: 'booking-1' }, confirmationCode: 'ABC123' },
    });
    try {
      await callHandler(postHandler(), { params: { token: 'a'.repeat(64) }, body });
      return csb.mock.calls[0]?.[0];
    } finally {
      csb.mockRestore();
    }
  }

  test('gate off: GET carries no pestChoices key', async () => {
    gateState.reservicePestChips = false;
    const res = await callHandler(getHandler(), { params: { token: 'a'.repeat(64) }, query: {} });
    const payload = res.json.mock.calls[0][0];
    expect(payload).not.toHaveProperty('pestChoices');
  });

  test('gate on: GET includes pestChoices for both eligible/bookable lanes', async () => {
    gateState.reservicePestChips = true;
    const res = await callHandler(getHandler(), { params: { token: 'a'.repeat(64) }, query: {} });
    const payload = res.json.mock.calls[0][0];
    expect(Object.keys(payload.pestChoices).sort()).toEqual(['lawn', 'pest']);
    expect(payload.pestChoices.pest.map((c) => c.key)).toEqual(['ants', 'roaches', 'spiders', 'wasps', 'other']);
    expect(payload.pestChoices.lawn.map((c) => c.key)).toEqual(['weeds', 'lawn_insects', 'brown_patches', 'other']);
  });

  test('gate on: pestChoices is limited to the customer\'s eligible lanes (pest-only coverage)', async () => {
    gateState.reservicePestChips = true;
    listResults['scheduled_services as s'] = [{ category: 'pest_control', service_type: 'General Pest Control' }];
    const res = await callHandler(getHandler(), { params: { token: 'a'.repeat(64) }, query: {} });
    const payload = res.json.mock.calls[0][0];
    expect(Object.keys(payload.pestChoices)).toEqual(['pest']);
  });

  test('gate off: POST ignores posted pests — legacy customer_notes, pests dropped from the callbackVisit', async () => {
    gateState.reservicePestChips = false;
    const arg = await postAndCapture({
      date: POST_SLOT_DATE, start_time: '09:00', lane: 'pest', details: 'ants back', pests: ['ants', 'roaches'],
    });
    expect(arg.customer_notes).toBe('Re-service request: ants back');
    expect(arg.callbackVisit.customerRequest).toEqual({ text: 'ants back', source: 'picker', pests: null });
  });

  test('gate on: normalizes pests for the chosen lane, drops invalid/wrong-lane keys, and formats customer_notes with details', async () => {
    gateState.reservicePestChips = true;
    const arg = await postAndCapture({
      date: POST_SLOT_DATE, start_time: '09:00', lane: 'pest', details: 'ants are back',
      // 'weeds' is a lawn-only key, 'made_up' is not a real key — both dropped.
      pests: ['wasps', 'ants', 'ants', 'weeds', 'made_up'],
    });
    expect(arg.callbackVisit.customerRequest).toEqual({ text: 'ants are back', source: 'picker', pests: ['ants', 'wasps'] });
    expect(arg.customer_notes).toBe('Re-service request (Ants, Wasps): ants are back');
  });

  test('gate on: pests present with no details uses the pests-only customer_notes form', async () => {
    gateState.reservicePestChips = true;
    const arg = await postAndCapture({ date: POST_SLOT_DATE, start_time: '09:00', lane: 'pest', pests: ['roaches'] });
    expect(arg.customer_notes).toBe('Re-service request: Roaches');
    expect(arg.callbackVisit.customerRequest).toEqual({ text: null, source: 'picker', pests: ['roaches'] });
  });

  test.each([[false], [true]])('the existing no-details, no-pests fallback is unchanged (gate %s)', async (on) => {
    gateState.reservicePestChips = on;
    const arg = await postAndCapture({ date: POST_SLOT_DATE, start_time: '09:00', lane: 'pest' });
    expect(arg.customer_notes).toBe('Re-service requested via self-serve link');
    expect(arg.callbackVisit.customerRequest).toBeUndefined();
  });
  // GATE_RESERVICE_DETAILS_REQUIRED (owner 2026-10-02: any text counts; a
  // pest chip alone does not replace the box).
  describe('GATE_RESERVICE_DETAILS_REQUIRED', () => {
    afterEach(() => { delete gateState.reserviceDetailsRequired; });

    test('gate off: GET carries no detailsRequired key', async () => {
      const res = await callHandler(getHandler(), { params: { token: 'a'.repeat(64) }, query: {} });
      expect(res.json.mock.calls[0][0]).not.toHaveProperty('detailsRequired');
    });

    test('gate on: GET carries detailsRequired', async () => {
      gateState.reserviceDetailsRequired = true;
      const res = await callHandler(getHandler(), { params: { token: 'a'.repeat(64) }, query: {} });
      expect(res.json.mock.calls[0][0].detailsRequired).toBe(true);
    });

    test.each([
      ['missing', {}],
      ['whitespace only', { details: '   ' }],
      ['pest chip only', { pests: ['ants'] }],
    ])('gate on: POST with %s details is refused before any booking', async (_label, extra) => {
      gateState.reserviceDetailsRequired = true;
      gateState.reservicePestChips = true;
      const csb = jest.spyOn(require('../routes/booking')._internals, 'createSelfBooking');
      try {
        const res = await callHandler(postHandler(), {
          params: { token: 'a'.repeat(64) },
          body: { date: POST_SLOT_DATE, start_time: '09:00', lane: 'pest', ...extra },
        });
        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json.mock.calls[0][0].code).toBe('DETAILS_REQUIRED');
        expect(csb).not.toHaveBeenCalled();
      } finally {
        csb.mockRestore();
      }
    });

    test('gate on: an unknown token with a blank box is still the generic 404', async () => {
      gateState.reserviceDetailsRequired = true;
      const saved = firstResults.customers;
      firstResults.customers = null;
      try {
        const res = await callHandler(postHandler(), {
          params: { token: 'a'.repeat(64) },
          body: { date: POST_SLOT_DATE, start_time: '09:00', lane: 'pest' },
        });
        expect(res.status).toHaveBeenCalledWith(404);
      } finally {
        firstResults.customers = saved;
      }
    });

    test('gate on: any text books', async () => {
      gateState.reserviceDetailsRequired = true;
      const arg = await postAndCapture({ date: POST_SLOT_DATE, start_time: '09:00', lane: 'pest', details: 'ants' });
      expect(arg.customer_notes).toBe('Re-service request: ants');
    });
  });

  // GATE_RESERVICE_PHOTOS (owner 2026-10-02: photos optional).
  describe('GATE_RESERVICE_PHOTOS', () => {
    const VISIT_ID = '11111111-2222-4333-8444-555555555555';
    const CALLBACK_ROW = {
      id: VISIT_ID, customer_id: CUST_ID, status: 'confirmed', is_callback: true,
      service_type: 'Pest Control Re-Service', service_key: 'pest_re_service', property_id: 'prop-1',
    };
    const appointmentPublic = require('../routes/appointment-public');

    afterEach(() => {
      delete gateState.reservicePhotos;
      delete firstResults['scheduled_services as s'];
      delete firstResults.scheduled_services;
      appointmentPublic.deriveVisitPrepEligibility.mockClear();
      appointmentPublic.reloadEligibleVisitPrepRowCore.mockClear();
    });

    async function commit() {
      const csb = jest.spyOn(require('../routes/booking')._internals, 'createSelfBooking').mockResolvedValue({
        ok: true, body: { booking: { id: 'booking-1' }, confirmationCode: 'ABC123' },
      });
      try {
        return (await callHandler(postHandler(), {
          params: { token: 'a'.repeat(64) },
          body: { date: POST_SLOT_DATE, start_time: '09:00', lane: 'pest', details: 'ants' },
        })).json.mock.calls[0][0];
      } finally {
        csb.mockRestore();
      }
    }

    test('gate off: the commit response carries no prepPhotos key', async () => {
      firstResults.scheduled_services = { id: VISIT_ID, reschedule_token: 'b'.repeat(64) };
      firstResults['scheduled_services as s'] = CALLBACK_ROW;
      const payload = await commit();
      expect(payload.success).toBe(true);
      expect(payload).not.toHaveProperty('prepPhotos');
      expect(appointmentPublic.deriveVisitPrepEligibility).not.toHaveBeenCalled();
    });

    test('gate on: the commit response offers photos for the visit just booked', async () => {
      gateState.reservicePhotos = true;
      firstResults.scheduled_services = { id: VISIT_ID, reschedule_token: 'b'.repeat(64) };
      firstResults['scheduled_services as s'] = CALLBACK_ROW;
      const payload = await commit();
      expect(payload.prepPhotos).toEqual({ visitId: VISIT_ID, photosRemaining: 6 });
      expect(appointmentPublic.deriveVisitPrepEligibility)
        .toHaveBeenCalledWith(expect.objectContaining({ id: VISIT_ID, customer_active: true }), { reserviceCallback: true });
    });

    test('gate on: an ineligible visit gets no offer, and the booking still succeeds', async () => {
      gateState.reservicePhotos = true;
      firstResults.scheduled_services = { id: VISIT_ID, reschedule_token: 'b'.repeat(64) };
      firstResults['scheduled_services as s'] = CALLBACK_ROW;
      appointmentPublic.deriveVisitPrepEligibility.mockResolvedValueOnce({ eligible: false, reason: 'not_upcoming' });
      const payload = await commit();
      expect(payload.success).toBe(true);
      expect(payload).not.toHaveProperty('prepPhotos');
    });

    test('only a pest/lawn re-service callback qualifies', async () => {
      const { loadReservicePhotoVisit } = reservicePublicRouter._test;
      firstResults['scheduled_services as s'] = CALLBACK_ROW;
      expect(await loadReservicePhotoVisit(VISIT_ID, CUST_ID)).toEqual(CALLBACK_ROW);
      firstResults['scheduled_services as s'] = { ...CALLBACK_ROW, is_callback: false, service_key: 'pest_quarterly', service_type: 'General Pest Control' };
      expect(await loadReservicePhotoVisit(VISIT_ID, CUST_ID)).toBeNull();
      firstResults['scheduled_services as s'] = { ...CALLBACK_ROW, service_key: null, service_type: 'Rodent Follow-Up' };
      expect(await loadReservicePhotoVisit(VISIT_ID, CUST_ID)).toBeNull();
      delete firstResults['scheduled_services as s'];
      expect(await loadReservicePhotoVisit(VISIT_ID, CUST_ID)).toBeNull();
    });

    test('locked recheck: token customer, unchanged property, then the shared core with the waiver', async () => {
      const { reloadReservicePhotoVisit } = reservicePublicRouter._test;
      const trx = require('../models/db');
      firstResults['scheduled_services as s'] = CALLBACK_ROW;
      expect(await reloadReservicePhotoVisit('a'.repeat(64), VISIT_ID, CUST_ID, 'prop-1', trx))
        .toEqual(expect.objectContaining({ id: VISIT_ID, customer_active: true }));
      expect(appointmentPublic.reloadEligibleVisitPrepRowCore).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: VISIT_ID }), trx, { reserviceCallback: true },
      );
      // The visit moved to another property since the pre-check.
      expect(await reloadReservicePhotoVisit('a'.repeat(64), VISIT_ID, CUST_ID, 'prop-2', trx)).toBeNull();
      // The token's customer row is gone (token rotated / customer deleted).
      const saved = firstResults.customers;
      firstResults.customers = null;
      try {
        expect(await reloadReservicePhotoVisit('a'.repeat(64), VISIT_ID, CUST_ID, 'prop-1', trx)).toBeNull();
      } finally {
        firstResults.customers = saved;
      }
    });

    test('upload forwards photos + note only — never a posted locationOnProperty', async () => {
      gateState.reservicePhotos = true;
      const { createVisitPrepSubmission } = require('../services/visit-prep');
      createVisitPrepSubmission.mockClear();
      const layer = reservicePublicRouter.stack.find((l) => l.route?.path === '/:token/visits/:visitId/photos');
      const handler = layer.route.stack.at(-1).handle;
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
      await handler({
        params: { token: 'a'.repeat(64), visitId: VISIT_ID },
        visitPrepSvc: { ...CALLBACK_ROW },
        files: [],
        body: { note: 'by the sink', locationOnProperty: 'backyard', topic: 'lawn' },
      }, res, jest.fn());
      const arg = createVisitPrepSubmission.mock.calls[0][0];
      expect(arg.note).toBe('by the sink');
      expect(arg.locationOnProperty).toBeNull();
      expect(arg.topic).toBe('pest');
      expect(arg.entry).toBe('reservice_page');
    });

    test.each([
      ['gate off', { gate: false }],
      ['a non-multipart body', { multipart: false }],
      ['a malformed visit id', { path: `/${'a'.repeat(64)}/visits/not-a-uuid/photos` }],
      ['a malformed token', { path: `/bad/visits/${VISIT_ID}/photos` }],
    ])('pre-parser guard: %s is the generic 404', (_label, opts) => {
      gateState.reservicePhotos = opts.gate !== false;
      const { reservicePhotosPreParserGuard } = require('../routes/reservice-public');
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
      const next = jest.fn();
      reservicePhotosPreParserGuard({
        path: opts.path || `/${'a'.repeat(64)}/visits/${VISIT_ID}/photos`,
        is: () => opts.multipart !== false,
      }, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(404);
    });

    test('pre-parser guard: a valid multipart upload, and every other path, pass through', () => {
      gateState.reservicePhotos = true;
      const { reservicePhotosPreParserGuard } = require('../routes/reservice-public');
      for (const path of [`/${'a'.repeat(64)}/visits/${VISIT_ID}/photos`, `/${'a'.repeat(64)}`, `/${'a'.repeat(64)}/find-slots`]) {
        const next = jest.fn();
        reservicePhotosPreParserGuard({ path, is: () => path.endsWith('/photos') }, {}, next);
        expect(next).toHaveBeenCalled();
      }
    });
  });
});

describe('staff geocode review blocks coordinate-less re-service offers', () => {
  const token = 'a'.repeat(64);
  const slotDate = etDateString(addETDays(new Date(), 3));
  const address = {
    address_line1: '123 Test Ave', address_line2: null, city: 'Sarasota', state: 'FL', zip: '34236',
  };
  const customer = (overrides = {}) => ({
    id: CUST_ID, first_name: 'Pat', active: true, waveguard_tier: null, monthly_rate: 0,
    latitude: null, longitude: null, phone: '9415550101', ...address, ...overrides,
  });
  const review = (status) => ({
    customer_id: CUST_ID,
    status,
    address_snapshot: [address.address_line1, address.address_line2, address.city, address.state, address.zip],
    latitude: null,
    longitude: null,
  });
  // The review store reads reviews as a list (with each customer's primary
  // property, #5035), so the fixture lands on the list result.
  const setReview = (row) => { listResults.customer_geocode_reviews = row ? [row] : []; };
  const response = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() });
  const getHandler = () => reservicePublicRouter.stack
    .find(layer => layer.route?.path === '/:token' && layer.route.methods.get).route.stack.at(-1).handle;
  const findHandler = () => reservicePublicRouter.stack
    .find(layer => layer.route?.path === '/:token/find-slots').route.stack.at(-1).handle;
  const commitHandler = () => reservicePublicRouter.stack
    .find(layer => layer.route?.path === '/:token' && layer.route.methods.post).route.stack.at(-1).handle;
  let oldReviewGate;

  beforeEach(() => {
    oldReviewGate = process.env.GATE_GEOCODE_REVIEW;
    process.env.GATE_GEOCODE_REVIEW = 'true';
    firstResults.customers = customer();
    listResults.services = [{
      id: 'pest-service', service_key: 'pest_re_service', name: 'Pest Control Re-Service', default_duration_minutes: 20,
    }];
    listResults['scheduled_services as s'] = [{ category: 'pest_control', service_type: 'General Pest Control' }];
  });

  afterEach(() => {
    if (oldReviewGate === undefined) delete process.env.GATE_GEOCODE_REVIEW;
    else process.env.GATE_GEOCODE_REVIEW = oldReviewGate;
    jest.restoreAllMocks();
  });

  test.each(['needs_pin', 'needs_details', 'outside_area'])(
    'a matching %s review blocks a coordinate-less customer',
    async (status) => {
      setReview(review(status));
      await expect(reservicePublicRouter._test.reserviceLocationReviewRequired(customer())).resolves.toBe(true);
    },
  );

  test('the portal reader keeps its customer, catalog, coverage, and callback reads on the supplied executor', async () => {
    const database = jest.fn((table) => db(table));

    await expect(reservicePublicRouter._internals.pageLaneState(token, database)).resolves.toEqual(expect.objectContaining({
      customer: expect.objectContaining({ id: CUST_ID }),
      bookableLanes: ['pest'],
    }));

    expect(database).toHaveBeenCalledWith('customers');
    expect(database).toHaveBeenCalledWith('services');
    expect(database).toHaveBeenCalledWith('scheduled_services as s');
  });

  test('the location-review reader forwards the supplied executor', async () => {
    const database = jest.fn();
    const reviewedServiceLocation = jest.spyOn(require('../services/customer-geocode-review'), 'reviewedServiceLocation')
      .mockResolvedValue({ location: null, permanent: true, reason: 'address_review_required' });

    await expect(reservicePublicRouter._test.reserviceLocationReviewRequired(customer(), database)).resolves.toBe(true);

    expect(reviewedServiceLocation).toHaveBeenCalledWith(expect.objectContaining({ customer_id: CUST_ID }), database);
  });

  test('a complete stored pair and a dark review gate preserve the existing offer path', async () => {
    setReview(review('needs_pin'));
    await expect(reservicePublicRouter._test.reserviceLocationReviewRequired(customer({ latitude: 27.34, longitude: -82.53 })))
      .resolves.toBe(false);
    process.env.GATE_GEOCODE_REVIEW = 'false';
    await expect(reservicePublicRouter._test.reserviceLocationReviewRequired(customer())).resolves.toBe(false);
  });

  // Offers are built on the pin the re-service commit books at (Codex #4992
  // P1): createSelfBooking's stored pin → staff-verified pin → canonical
  // geocode, never a different geocoder's answer.
  const buildOffers = (who) => reservicePublicRouter._test.buildAvailabilityForCustomer(who, {
    rangeFrom: slotDate, rangeTo: slotDate, config: {}, duration: 20, lanes: ['pest'],
  });

  test('a coordinate-less customer\'s offers are built at the matching staff-verified pin, not a provider geocode', async () => {
    const reviewedPin = { lat: 27.40123, lng: -82.50123 };
    setReview({ ...review('verified'), latitude: reviewedPin.lat, longitude: reviewedPin.lng });
    const geocode = jest.spyOn(require('../services/geocoder'), 'geocodeAddress').mockResolvedValue({ lat: 27.34999, lng: -82.53999 });
    const build = jest.spyOn(require('../routes/booking')._internals, 'buildBookingAvailability')
      .mockResolvedValue({ slots: [], days: [], nearby: false });

    const res = response();
    await getHandler()({ params: { token }, query: {} }, res, jest.fn());

    expect(build).toHaveBeenCalledWith(expect.objectContaining(reviewedPin));
    expect(geocode).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ state: 'bookable', availability: expect.objectContaining({ days: [] }) }));
  });

  test('a review for a different address is out of scope: the canonical geocode of the customer\'s own address is used', async () => {
    setReview({ ...review('verified'), latitude: 27.40123, longitude: -82.50123 });
    const providerPin = { lat: 27.34999, lng: -82.53999 };
    const geocode = jest.spyOn(require('../services/geocoder'), 'geocodeAddress').mockResolvedValue(providerPin);
    const build = jest.spyOn(require('../routes/booking')._internals, 'buildBookingAvailability')
      .mockResolvedValue({ slots: [], days: [], nearby: false });

    await buildOffers(customer({ address_line1: '999 Different Road' }));

    expect(geocode).toHaveBeenCalledWith('999 Different Road, Sarasota, FL, 34236', expect.anything());
    expect(build).toHaveBeenCalledWith(expect.objectContaining(providerPin));
  });

  test('a stored pin wins over any review, as it does at commit', async () => {
    const storedPin = { lat: 27.34, lng: -82.53 };
    setReview({ ...review('verified'), latitude: 27.40123, longitude: -82.50123 });
    const geocode = jest.spyOn(require('../services/geocoder'), 'geocodeAddress');
    const build = jest.spyOn(require('../routes/booking')._internals, 'buildBookingAvailability')
      .mockResolvedValue({ slots: [], days: [], nearby: false });

    await buildOffers(customer({ latitude: storedPin.lat, longitude: storedPin.lng }));

    expect(build).toHaveBeenCalledWith(expect.objectContaining(storedPin));
    expect(geocode).not.toHaveBeenCalled();
  });

  test('a held (unresolved) review with no stored pin builds no offers at all', async () => {
    setReview(review('needs_pin'));
    const geocode = jest.spyOn(require('../services/geocoder'), 'geocodeAddress');
    const build = jest.spyOn(require('../routes/booking')._internals, 'buildBookingAvailability');

    await expect(buildOffers(customer())).resolves.toBeNull();
    expect(build).not.toHaveBeenCalled();
    expect(geocode).not.toHaveBeenCalled();
  });

  test('browse and search suppress offers while the matching review is unresolved', async () => {
    setReview(review('needs_pin'));
    const booking = require('../routes/booking')._internals;
    const build = jest.spyOn(booking, 'buildBookingAvailability');

    const browseRes = response();
    await getHandler()({ params: { token }, query: {} }, browseRes, jest.fn());
    expect(browseRes.json).toHaveBeenCalledWith(expect.objectContaining({
      state: 'bookable', availability: null, location_review_required: true,
    }));

    const searchRes = response();
    await findHandler()({ params: { token }, body: { query: 'Tuesday', lane: 'pest' } }, searchRes, jest.fn());
    expect(searchRes.status).toHaveBeenCalledWith(409);
    expect(searchRes.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'LOCATION_REVIEW_REQUIRED', error: expect.stringMatching(/confirm your service address/i),
    }));
    expect(build).not.toHaveBeenCalled();
  });

  test('a review recorded during commit is not remapped to a slot race or refreshed into another offer', async () => {
    setReview(null);
    const booking = require('../routes/booking')._internals;
    const config = jest.spyOn(booking, 'loadBookingConfig').mockResolvedValue({ advance_days_min: 1, advance_days_max: 14 });
    const coords = jest.spyOn(booking, 'customerBookingLocation').mockResolvedValue({ lat: 27.34, lng: -82.53 });
    const build = jest.spyOn(booking, 'buildBookingAvailability').mockResolvedValue({
      slots: [], nearby: false,
      days: [{
        date: slotDate,
        slots: [{ start_time: '09:00', end_time: '09:20', technician_id: 'tech-1', start_label: '9:00 AM', end_label: '9:20 AM' }],
      }],
    });
    const create = jest.spyOn(booking, 'createSelfBooking').mockResolvedValue({
      ok: false, status: 409, code: 'LOCATION_CHANGED_RETRY', error: 'Your address just changed — please pick a time again.',
    });

    const res = response();
    await commitHandler()({
      params: { token }, body: { lane: 'pest', date: slotDate, start_time: '09:00' },
    }, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'LOCATION_REVIEW_REQUIRED', error: expect.stringMatching(/confirm your service address/i),
    }));
    expect(build).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(config).toHaveBeenCalledTimes(1);
    expect(coords).toHaveBeenCalled();
  });

  test('a customer change during commit reloads the token and never refreshes slots from the stale row', async () => {
    setReview(null);
    const booking = require('../routes/booking')._internals;
    jest.spyOn(booking, 'loadBookingConfig').mockResolvedValue({ advance_days_min: 1, advance_days_max: 14 });
    jest.spyOn(booking, 'customerBookingLocation').mockResolvedValue({ lat: 27.34, lng: -82.53 });
    const build = jest.spyOn(booking, 'buildBookingAvailability').mockResolvedValue({
      slots: [], nearby: false,
      days: [{
        date: slotDate,
        slots: [{ start_time: '09:00', end_time: '09:20', technician_id: 'tech-1', start_label: '9:00 AM', end_label: '9:20 AM' }],
      }],
    });
    jest.spyOn(booking, 'createSelfBooking').mockImplementation(async () => {
      firstResults.customers = customer({ address_line1: '456 Changed Avenue' });
      return {
        ok: false, status: 409, code: 'CUSTOMER_CHANGED_RETRY',
        error: 'Your account details just changed — please refresh and book again.',
      };
    });
    const mockedDb = require('../models/db');
    const customerReadsBefore = mockedDb.mock.calls.filter(([table]) => table === 'customers').length;

    const res = response();
    await commitHandler()({
      params: { token }, body: { lane: 'pest', date: slotDate, start_time: '09:00' },
    }, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'LOCATION_REVIEW_REQUIRED', error: expect.stringMatching(/confirm your service address/i),
    }));
    expect(build).toHaveBeenCalledTimes(1);
    const customerReadsAfter = mockedDb.mock.calls.filter(([table]) => table === 'customers').length;
    expect(customerReadsAfter - customerReadsBefore).toBeGreaterThanOrEqual(2);
  });

  test('a contact-only customer change refreshes current availability instead of entering address recovery', async () => {
    setReview(null);
    const booking = require('../routes/booking')._internals;
    jest.spyOn(booking, 'loadBookingConfig').mockResolvedValue({ advance_days_min: 1, advance_days_max: 14 });
    const coords = jest.spyOn(booking, 'customerBookingLocation').mockResolvedValue({ lat: 27.34, lng: -82.53 });
    const replacement = {
      slots: [], nearby: false,
      days: [{
        date: slotDate,
        slots: [{ start_time: '14:00', end_time: '14:20', technician_id: 'tech-2', start_label: '2:00 PM', end_label: '2:20 PM' }],
      }],
    };
    const build = jest.spyOn(booking, 'buildBookingAvailability')
      .mockResolvedValueOnce({ ...replacement, days: [{ ...replacement.days[0], slots: [{ ...replacement.days[0].slots[0], start_time: '09:00' }] }] })
      .mockResolvedValueOnce(replacement);
    jest.spyOn(booking, 'createSelfBooking').mockImplementation(async () => {
      firstResults.customers = customer({ phone: '9415550199' });
      return { ok: false, status: 409, code: 'CUSTOMER_CHANGED_RETRY', error: 'changed' };
    });

    const res = response();
    await commitHandler()({
      params: { token }, body: { lane: 'pest', date: slotDate, start_time: '09:00' },
    }, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'SLOT_TAKEN',
      availability: expect.objectContaining({
        days: [expect.objectContaining({ slots: [expect.objectContaining({ start_time: '14:00' })] })],
      }),
    }));
    expect(build).toHaveBeenCalledTimes(2);
    expect(coords.mock.calls[1][0]).toEqual(expect.objectContaining({ phone: '9415550199' }));
  });

  test('a customer change that retires the token stays a generic 404 without stale slots', async () => {
    setReview(null);
    const booking = require('../routes/booking')._internals;
    jest.spyOn(booking, 'loadBookingConfig').mockResolvedValue({ advance_days_min: 1, advance_days_max: 14 });
    jest.spyOn(booking, 'customerBookingLocation').mockResolvedValue({ lat: 27.34, lng: -82.53 });
    const build = jest.spyOn(booking, 'buildBookingAvailability').mockResolvedValue({
      slots: [], nearby: false,
      days: [{ date: slotDate, slots: [{ start_time: '09:00', end_time: '09:20', technician_id: 'tech-1' }] }],
    });
    jest.spyOn(booking, 'createSelfBooking').mockImplementation(async () => {
      firstResults.customers = null;
      return { ok: false, status: 409, code: 'CUSTOMER_CHANGED_RETRY', error: 'changed' };
    });

    const res = response();
    await commitHandler()({
      params: { token }, body: { lane: 'pest', date: slotDate, start_time: '09:00' },
    }, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'Not found' });
    expect(build).toHaveBeenCalledTimes(1);
  });

  test('an ordinary DAY_FULL race still refreshes and returns SLOT_TAKEN', async () => {
    firstResults.customers = customer({ latitude: 27.34, longitude: -82.53 });
    setReview(review('needs_pin'));
    const booking = require('../routes/booking')._internals;
    jest.spyOn(booking, 'loadBookingConfig').mockResolvedValue({ advance_days_min: 1, advance_days_max: 14 });
    const build = jest.spyOn(booking, 'buildBookingAvailability').mockResolvedValue({
      slots: [], nearby: false,
      days: [{
        date: slotDate,
        slots: [{ start_time: '09:00', end_time: '09:20', technician_id: 'tech-1', start_label: '9:00 AM', end_label: '9:20 AM' }],
      }],
    });
    jest.spyOn(booking, 'createSelfBooking').mockResolvedValue({
      ok: false, status: 409, code: 'DAY_FULL', error: 'That day just filled.',
    });

    const res = response();
    await commitHandler()({
      params: { token }, body: { lane: 'pest', date: slotDate, start_time: '09:00' },
    }, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'SLOT_TAKEN', error: 'That day just filled.', availability: expect.objectContaining({ days: expect.any(Array) }),
    }));
    expect(build).toHaveBeenCalledTimes(2);
  });
});
