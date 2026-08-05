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
const gateState = { reserviceSelfServe: true, selfBooking: true, bookingCustomersOnly: false };
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn((name) => (name in gateState ? gateState[name] : true)),
}));

// Universal query-chain mock (same shape booking-customers-only-gate.test.js
// uses): chain methods return the chain, .first() resolves firstResults,
// list terminals resolve listResults.
const firstResults = {};
const listResults = {};
jest.mock('../models/db', () => {
  const mkChain = (table) => {
    const q = {};
    const passthrough = [
      'where', 'whereIn', 'whereNot', 'whereNotIn', 'whereNull', 'whereNotNull',
      'whereRaw', 'andWhere', 'orWhere', 'orWhereIn', 'orWhereRaw', 'orderBy',
      'orderByRaw', 'limit', 'offset', 'select', 'join', 'leftJoin', 'groupBy',
      'count', 'modify',
    ];
    for (const m of passthrough) q[m] = () => q;
    q.first = async () => (firstResults[table] !== undefined ? firstResults[table] : null);
    q.then = (onOk, onErr) => Promise.resolve(listResults[table] || []).then(onOk, onErr);
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
  laneForCoverageRow,
  laneForCallbackRow,
  reserviceLanesForCustomer,
} = require('../services/reservice-scheduler');
const { buildReserviceLink, reserviceSmsLineFor } = require('../services/reservice-link');
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
