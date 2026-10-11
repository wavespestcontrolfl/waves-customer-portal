process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

/**
 * ONE table over every public endpoint of an estimate token x every OTHER refusal that endpoint can give for a viewable
 * estimate, with and without the B18 phone park. It exists to end a class of review findings (the fifth ORDERING finding
 * in a row: an older shortcut or early return answering before the shared blocking-state check).
 *
 * Documented precedence (docs/public-route-contracts.md):
 *   quote_required  >  termite trenching review  >  contact_review (the park)  >  every no-booking shortcut / the suppression gate
 *   and only true viewability / terminal / inactive refusals stay ahead of all of them.
 *
 * Real routers (estimate-public + estimate-slots-public) over a chain-mock db, ephemeral port, fetch. Cells that cannot be
 * driven through HTTP in this harness are covered by the source-order assertions at the bottom (and listed there); the accept
 * endpoint's HTTP cells live in estimate-public-accept-atomicity.test.js (its fake-knex harness runs the whole transaction).
 */

jest.mock('../models/db', () => {
  const mock = jest.fn();
  mock.fn = { now: jest.fn(() => 'NOW') };
  mock.raw = jest.fn((sql) => sql);
  return mock;
});
jest.mock('express-rate-limit', () => () => (_req, _res, next) => next());
jest.mock('../config/feature-gates', () => ({
  ...jest.requireActual('../config/feature-gates'),
  isEnabled: jest.fn(() => false),
  gateEnvValue: jest.fn(() => false), // GATE_BERMUDA_SUPPRESSION off: a suppression-shaped estimate is gated
  gates: {},
}));
jest.mock('../services/property-lookup/lookup-cache', () => ({ getCachedLookup: jest.fn().mockResolvedValue(null) }));
jest.mock('../services/estimate-membership-context', () => ({
  buildEstimateMembershipContext: jest.fn().mockResolvedValue(null),
  publicMembershipView: jest.fn((snapshot) => snapshot ?? null),
}));
jest.mock('../services/estimate-deposits', () => ({
  ensureDepositSatisfied: jest.fn(),
  resolveDepositPolicyForEstimate: jest.fn().mockResolvedValue({ enforced: false, required: false, slotRequired: false }),
  computeDepositAmount: jest.fn(() => 0),
  pendingDepositCredit: jest.fn(),
  consumeDepositCredit: jest.fn(),
  refundUnconsumedDeposits: jest.fn(),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const mockRaiseAdminAlert = jest.fn(async () => ({ id: 'alert-1' }));
jest.mock('../services/admin-alert-compose', () => ({
  ...jest.requireActual('../services/admin-alert-compose'),
  raiseAdminAlert: (...a) => mockRaiseAdminAlert(...a),
}));
const mockReleaseEstimateHolds = jest.fn(async () => ({ released: 1 }));
const mockReserveSlot = jest.fn(async () => ({ scheduledServiceId: 'ss-1', expiresAt: null }));
const mockExtendReservation = jest.fn(async () => ({ scheduledServiceId: 'ss-1', expiresAt: null }));
jest.mock('../services/slot-reservation', () => ({
  ...jest.requireActual('../services/slot-reservation'),
  releaseEstimateHolds: (...a) => mockReleaseEstimateHolds(...a),
  reserveSlot: (...a) => mockReserveSlot(...a),
  extendReservation: (...a) => mockExtendReservation(...a),
}));
const mockGetAvailableSlots = jest.fn(async () => ({ primary: [{ slotId: 's1' }], expander: [], availableSlots: [], summary: null }));
const mockFindEstimateSlots = jest.fn(async () => ({ primary: [{ slotId: 's1' }], summary: 'ok' }));
jest.mock('../services/estimate-slot-availability', () => ({
  getAvailableSlots: (...a) => mockGetAvailableSlots(...a),
  findEstimateSlots: (...a) => mockFindEstimateSlots(...a),
  MAX_SLOT_HORIZON_DAYS: 90,
}));

const fs = require('fs');
const path = require('path');
const express = require('express');
const db = require('../models/db');
const estimatePublicRouter = require('../routes/estimate-public');
// find-slots needs the signed ask token; stand in for the verifier (before the slot router captures it).
jest.spyOn(estimatePublicRouter, 'verifyEstimateAskToken').mockImplementation(() => true);
const slotsRouter = require('../routes/estimate-slots-public');

let estimateRow;
let phoneCandidates;
function chainFor(result) {
  const chain = {
    where: jest.fn(() => chain), whereIn: jest.fn(() => chain), whereNull: jest.fn(() => chain), whereRaw: jest.fn(() => chain),
    andWhere: jest.fn(() => chain), orWhere: jest.fn(() => chain), orWhereRaw: jest.fn(() => chain), leftJoin: jest.fn(() => chain),
    select: jest.fn(() => chain), orderBy: jest.fn(() => chain), orderByRaw: jest.fn(() => chain),
    forUpdate: jest.fn(() => chain), forShare: jest.fn(() => chain), noWait: jest.fn(() => chain),
    whereNot: jest.fn(() => chain), whereNotNull: jest.fn(() => chain),
    first: jest.fn().mockResolvedValue(result),
    update: jest.fn().mockResolvedValue(1),
    insert: jest.fn().mockResolvedValue([1]),
  };
  return chain;
}
let candidateQueue = []; // one-shot answers for the next PLAIN candidate reads (then `phoneCandidates`)
let customerRowBusy = false; // another writer holds the candidate row: a FOR SHARE NOWAIT read raises 55P03
db.mockImplementation((table) => {
  if (table === 'customers') {
    const c = chainFor(null);
    let locked = false;
    c.noWait = jest.fn(() => { locked = true; return c; });
    c.then = (resolve, reject) => (locked && customerRowBusy
      ? Promise.reject(Object.assign(new Error('could not obtain lock on row in relation "customers"'), { code: '55P03' })).then(resolve, reject)
      : Promise.resolve(!locked && candidateQueue.length ? candidateQueue.shift() : phoneCandidates).then(resolve, reject));
    return c;
  }
  return chainFor(table === 'estimates' ? estimateRow : undefined);
});
db.transaction = jest.fn(async (fn) => fn(db));

const BOB = { id: 'cust-bob', first_name: 'Bob', last_name: 'Example', phone: '(941) 555-0123', email: 'bob@example.com', address_line1: '9 Other St' };
const SNAPSHOT = { pricingBundle: { frequencies: [{ key: 'quarterly', label: 'Quarterly', monthly: 88, annual: 1056 }], waveGuardTier: 'Bronze', source: 'send_snapshot_fixture' } };
const PEST_RESULT = { recurring: { discount: 0, services: [{ name: 'Pest Control', mo: 88 }] }, oneTime: { items: [], membershipFee: 0 } };
const TRENCH_RESULT = { recurring: { services: [] }, oneTime: { items: [{ service: 'trenching', name: 'Termite Trenching', price: 2210 }], specItems: [] } };
const GUARANTEE_RESULT = { recurring: { services: [] }, oneTime: { items: [{ service: 'rodent_guarantee', name: 'Rodent Guarantee', price: 199 }], specItems: [] } };

let seq = 0;
function makeEstimate(estimateData, rowOverrides = {}) {
  seq += 1;
  return {
    id: `est-matrix-${seq}`, token: `matrixtoken0123456789abcdef${seq}`,
    status: 'sent', sent_at: '2026-09-01T00:00:00.000Z', viewed_at: null,
    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), archived_at: null,
    customer_id: null, customer_name: 'Pat Tester', customer_phone: '(941) 555-0123', customer_email: 'pat@example.com',
    address: '123 Palm Ave, Bradenton, FL 34203',
    satellite_url: null, waveguard_tier: 'Bronze', bill_by_invoice: false,
    monthly_total: 88, annual_total: 1056, onetime_total: 0, show_one_time_option: false,
    estimate_data: { sendSnapshot: SNAPSHOT, result: PEST_RESULT, ...estimateData },
    ...rowOverrides,
  };
}

// The OTHER refusal / shortcut each condition stands for.
const CONDITIONS = {
  bermuda: () => makeEstimate({ engineRequest: { options: { bermudaSuppression: true } } }),
  // A persisted area add-on (GATE_AREA_ADDONS off in this harness): same rail as the Bermuda shape, its own code.
  areaAddOn: () => makeEstimate({ engineInputs: { services: { areaAddOns: [{ key: 'web_sweep', visitContext: 'standalone' }] } } }),
  commercial: () => makeEstimate({ commercialEstimatedPricing: true }),
  // a one-time-only renewal whose only line is the rodent guarantee (no recurring totals, no recurring snapshot)
  guarantee: () => makeEstimate({ result: GUARANTEE_RESULT, sendSnapshot: undefined }, { monthly_total: 0, annual_total: 0, onetime_total: 199 }),
  trenching: () => makeEstimate({ result: TRENCH_RESULT }),
  quote: () => makeEstimate({ proposal: { enabled: true } }),
};

const BERMUDA_409 = { error: 'This estimate includes an option that is temporarily unavailable. Please contact our office and we will refresh your quote.', code: 'BERMUDA_SUPPRESSION_GATED' };
const AREA_ADDON_409 = { error: 'This estimate includes an option that is temporarily unavailable. Please contact our office and we will refresh your quote.', code: 'AREA_ADDONS_GATED' };
const INACTIVE_409 = { error: 'Estimate is no longer active' };
const TRENCH_409 = { error: 'A Waves specialist will confirm your termite trenching treatment path and schedule your visit — this quote can’t be booked online.', reviewBeforeBooking: true, reason: 'termite_trenching_review' };
const TRENCH_BROWSE = { primary: [], expander: [], availableSlots: [], summary: null, reviewBeforeBooking: true, message: 'A Waves specialist will confirm your termite trenching treatment path and schedule your visit.' };
const COMMERCIAL_BROWSE = { primary: [], expander: [], availableSlots: [], summary: null, commercialManualScheduling: true, message: 'A Waves team member will reach out to schedule your commercial service.' };
const COMMERCIAL_409 = { error: 'Commercial service is scheduled by our team — no self-booking.', commercialManualScheduling: true };
const GUARANTEE_BROWSE = { primary: [], expander: [], availableSlots: [], summary: null, invoiceOnlyAcceptance: true, message: 'No appointment is needed — this renewal is accepted with an invoice.' };
const GUARANTEE_409 = { error: 'No appointment is needed for this renewal — accept without booking.', invoiceOnlyAcceptance: true };
const PARK_WRITE = { code: 'ACCEPT_NEEDS_OFFICE_REVIEW', reviewBeforeBooking: true, reason: 'contact_review' };
const PARK_BROWSE = { reviewBeforeBooking: true, reason: 'contact_review', primary: [], availableSlots: [] };

let server;
let base;
const HOLD = '11111111-1111-4111-8111-111111111111';
const SLOT = '2030-01-01_09-00_unassigned';

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/estimates', estimatePublicRouter);
  app.use('/slots', slotsRouter);
  app.use((err, _req, res, _next) => { res.status(err.status || 500).json({ error: err.message }); });
  server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.close(done); });
beforeEach(() => {
  phoneCandidates = [];
  customerRowBusy = false;
  candidateQueue = [];
  [mockRaiseAdminAlert, mockReleaseEstimateHolds, mockReserveSlot, mockExtendReservation, mockGetAvailableSlots, mockFindEstimateSlots].forEach((m) => m.mockClear());
  process.env.ALERT_EPISODES = 'off';
});

const slot = (leg, init) => fetch(`${base}/slots/${estimateRow.token}/${leg}`, init);
const post = (leg, body = {}) => slot(leg, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const json = async (res) => ({ status: res.status, body: await res.json() });
const run = {
  'available-slots': () => slot('available-slots').then(json),
  'find-slots': () => post('find-slots', { query: 'next week please' }).then(json),
  reserve: () => post('reserve', { slotId: SLOT }).then(json),
  extend: () => slot(`reserve/${HOLD}/extend`, { method: 'POST' }).then(json),
  'card-hold-intent': () => post('card-hold-intent').then(json),
  'recurring-card-intent': () => post('recurring-card-intent').then(json),
  data: () => fetch(`${base}/estimates/${estimateRow.token}/data`).then(json),
};

// [endpoint, condition, expected when PARKED, expected when NOT parked]. `expect` functions take {status, body}.
const is = (status, body) => (r) => { expect([r.status, r.body]).toEqual([status, body]); };
const like = (status, body) => (r) => { expect(r.status).toBe(status); expect(r.body).toMatchObject(body); };
const proceeds = (spy) => (r) => { expect(r.status).toBeLessThan(300); expect(spy).toHaveBeenCalled(); };

const SLOT_CELLS = [
  // available-slots / find-slots (browse shapes)
  ['available-slots', 'bermuda', like(200, PARK_BROWSE), is(409, BERMUDA_409)],
  ['available-slots', 'areaAddOn', like(200, PARK_BROWSE), is(409, AREA_ADDON_409)],
  ['available-slots', 'commercial', like(200, PARK_BROWSE), is(200, COMMERCIAL_BROWSE)],
  ['available-slots', 'guarantee', like(200, PARK_BROWSE), is(200, GUARANTEE_BROWSE)],
  ['available-slots', 'trenching', is(200, TRENCH_BROWSE), is(200, TRENCH_BROWSE)],
  ['available-slots', 'quote', is(409, INACTIVE_409), proceeds(mockGetAvailableSlots)],
  ['find-slots', 'bermuda', like(200, PARK_BROWSE), is(409, BERMUDA_409)],
  ['find-slots', 'areaAddOn', like(200, PARK_BROWSE), is(409, AREA_ADDON_409)],
  ['find-slots', 'commercial', like(200, PARK_BROWSE), is(200, COMMERCIAL_BROWSE)],
  ['find-slots', 'guarantee', like(200, PARK_BROWSE), is(200, GUARANTEE_BROWSE)],
  ['find-slots', 'trenching', is(200, TRENCH_BROWSE), is(200, TRENCH_BROWSE)],
  ['find-slots', 'quote', is(409, INACTIVE_409), proceeds(mockFindEstimateSlots)],
  // reserve / extend (write shapes)
  ['reserve', 'bermuda', like(409, PARK_WRITE), is(409, BERMUDA_409)],
  ['reserve', 'areaAddOn', like(409, PARK_WRITE), is(409, AREA_ADDON_409)],
  ['reserve', 'commercial', like(409, PARK_WRITE), is(409, COMMERCIAL_409)],
  ['reserve', 'guarantee', like(409, PARK_WRITE), is(409, GUARANTEE_409)],
  ['reserve', 'trenching', is(409, TRENCH_409), is(409, TRENCH_409)],
  ['reserve', 'quote', is(409, INACTIVE_409), (r) => { expect(r.status).toBe(201); expect(mockReserveSlot).toHaveBeenCalled(); }],
  ['extend', 'bermuda', like(409, PARK_WRITE), is(409, BERMUDA_409)],
  ['extend', 'areaAddOn', like(409, PARK_WRITE), is(409, AREA_ADDON_409)],
  ['extend', 'commercial', like(409, PARK_WRITE), is(409, COMMERCIAL_409)],
  ['extend', 'guarantee', like(409, PARK_WRITE), is(409, GUARANTEE_409)],
  ['extend', 'trenching', is(409, TRENCH_409), is(409, TRENCH_409)],
  ['extend', 'quote', is(409, INACTIVE_409), (r) => { expect(r.status).toBe(200); expect(mockExtendReservation).toHaveBeenCalled(); }],
  // the card intents (their commercial / guarantee-only answers are policy EXEMPTIONS, not refusals: only the parked cells apply)
  ['card-hold-intent', 'bermuda', like(409, PARK_WRITE), is(409, BERMUDA_409)],
  ['card-hold-intent', 'areaAddOn', like(409, PARK_WRITE), is(409, AREA_ADDON_409)],
  ['card-hold-intent', 'commercial', like(409, PARK_WRITE), null],
  ['card-hold-intent', 'guarantee', like(409, PARK_WRITE), null],
  ['card-hold-intent', 'trenching', is(409, TRENCH_409), is(409, TRENCH_409)],
  ['card-hold-intent', 'quote', is(409, INACTIVE_409), is(409, INACTIVE_409)],
  ['recurring-card-intent', 'bermuda', like(409, PARK_WRITE), is(409, BERMUDA_409)],
  ['recurring-card-intent', 'areaAddOn', like(409, PARK_WRITE), is(409, AREA_ADDON_409)],
  ['recurring-card-intent', 'commercial', like(409, PARK_WRITE), null],
  ['recurring-card-intent', 'guarantee', like(409, PARK_WRITE), null],
  ['recurring-card-intent', 'trenching', is(409, TRENCH_409), is(409, TRENCH_409)],
  ['recurring-card-intent', 'quote', is(409, INACTIVE_409), is(409, INACTIVE_409)],
];

// The locked recheck inside extendReservation, driven as the real service drives it: it hands the route's predicate the LOCKED
// estimate row and a transaction handle. A busy candidate row (55P03) may only cost the contact_review verdict.
describe('extend, locked recheck, customer row BUSY (55P03): contention only ever costs contact_review (r12)', () => {
  const trx = Object.assign((...a) => db(...a), { isTransaction: true, raw: db.raw, fn: db.fn });
  let extended;
  beforeEach(() => {
    extended = false;
    mockExtendReservation.mockImplementation(async (args) => {
      const refusal = await args.revalidateEstimate(estimateRow, trx);
      if (refusal) throw Object.assign(new Error('estimate cannot be self-booked'), { code: 'ESTIMATE_NO_BOOKING', response: refusal });
      extended = true;
      return { scheduledServiceId: 'ss-1', expiresAt: null };
    });
  });
  afterEach(() => mockExtendReservation.mockImplementation(async () => ({ scheduledServiceId: 'ss-1', expiresAt: null })));
  // Each case queues one clean answer for the pre-transaction read (the staff edit that makes the candidate contradictory is what
  // holds its row), so only the LOCKED recheck can decide: the plain read it starts with sees the committed contradictory candidate.
  const extendLocked = async () => {
    const res = await fetch(`${base}/slots/${estimateRow.token}/reserve/${HOLD}/extend`, { method: 'POST' });
    return { status: res.status, body: await res.json() };
  };

  test('quote-required AND parked, candidate row busy -> quote_required (the hold is NOT extended, no park alert)', async () => {
    estimateRow = CONDITIONS.quote();
    phoneCandidates = [BOB];
    candidateQueue = [[]]; // the pre-transaction read saw no contradictory candidate yet: only the locked recheck can decide
    customerRowBusy = true;
    const res = await extendLocked();
    expect([res.status, res.body]).toEqual([409, INACTIVE_409]);
    expect(extended).toBe(false);
    expect(mockRaiseAdminAlert).not.toHaveBeenCalled();
  });

  test('trenching, candidate row busy -> trenching (it never needs the candidate); the hold is NOT extended', async () => {
    estimateRow = CONDITIONS.trenching();
    phoneCandidates = [BOB];
    customerRowBusy = true;
    const res = await extendLocked();
    expect([res.status, res.body]).toEqual([409, TRENCH_409]);
    expect(extended).toBe(false);
  });

  test('parked only (no higher state), candidate row busy -> the contact_review verdict is the only thing lost: extended as before (skipOnBusy)', async () => {
    estimateRow = makeEstimate({});
    phoneCandidates = [BOB];
    candidateQueue = [[]];
    customerRowBusy = true;
    const res = await extendLocked();
    expect(res.status).toBe(200);
    expect(extended).toBe(true);
  });

  test('clean estimate, candidate row busy -> extended exactly as now, with no pricing work for it', async () => {
    estimateRow = makeEstimate({});
    phoneCandidates = [];
    customerRowBusy = true;
    const res = await extendLocked();
    expect(res.status).toBe(200);
    expect(extended).toBe(true);
    expect(mockRaiseAdminAlert).not.toHaveBeenCalled();
  });

  test('not busy: the same quote-required + parked estimate is still quote_required (the order is not what decides it)', async () => {
    estimateRow = CONDITIONS.quote();
    phoneCandidates = [BOB];
    candidateQueue = [[]];
    const res = await extendLocked();
    expect([res.status, res.body]).toEqual([409, INACTIVE_409]);
    expect(extended).toBe(false);
  });
});

describe('blocking-state precedence matrix: endpoint x condition x parked / not parked (HTTP-driven)', () => {
  describe.each(SLOT_CELLS)('%s x %s', (endpoint, condition, whenParked, whenNotParked) => {
    test('PARKED (phone contradicted): the documented precedence answer', async () => {
      estimateRow = CONDITIONS[condition]();
      phoneCandidates = [BOB];
      const res = await run[endpoint]();
      whenParked(res);
      // Park side effects only where the park is the answer; quote_required / trenching never alert.
      const parkAnswer = res.body && res.body.reason === 'contact_review';
      expect(mockRaiseAdminAlert.mock.calls.length > 0).toBe(parkAnswer && !['available-slots', 'find-slots'].includes(endpoint));
    });
    if (whenNotParked) {
      test('NOT parked: main\'s answer', async () => {
        estimateRow = CONDITIONS[condition]();
        phoneCandidates = [];
        whenNotParked(await run[endpoint]());
        expect(mockRaiseAdminAlert).not.toHaveBeenCalled();
      });
    }
  });

  describe('GET /data', () => {
    const reasonOf = (r) => r.body.cta.reviewReason;
    test.each([
      ['bermuda', 'contact_review'],
      ['areaAddOn', 'contact_review'],
      ['commercial', 'contact_review'],
      ['guarantee', 'contact_review'],
      ['trenching', 'termite_trenching_review'], // trenching outranks the park
    ])('%s AND parked: %s', async (condition, reason) => {
      estimateRow = CONDITIONS[condition]();
      phoneCandidates = [BOB];
      const res = await run.data();
      expect(res.status).toBe(200);
      expect(reasonOf(res)).toBe(reason);
    });
    test('quote-required AND parked: quote_required wins (a terminal quote state, never the park, no alert)', async () => {
      estimateRow = CONDITIONS.quote();
      phoneCandidates = [BOB];
      const res = await run.data();
      expect(res.status).toBe(200);
      expect(res.body.cta.terminalState).toBe('quote_required');
      expect(reasonOf(res)).not.toBe('contact_review');
      expect(mockRaiseAdminAlert).not.toHaveBeenCalled();
    });
    test.each(Object.keys(CONDITIONS))('%s, NOT parked: never contact_review (main\'s state)', async (condition) => {
      estimateRow = CONDITIONS[condition]();
      phoneCandidates = [];
      const res = await run.data();
      expect(res.status).toBe(200);
      expect(reasonOf(res)).not.toBe('contact_review');
    });
  });
});

// Cells that cannot be driven through HTTP in this harness, covered by source order instead:
//  - PUT /accept: every cell lives in estimate-public-accept-atomicity.test.js (HTTP, whole transaction), plus the source-order
//    pin there that the blocking decision precedes the Bermuda gate and the hold / slot / one-time shortcuts.
//  - card-hold-intent / recurring-card-intent x {commercial, guarantee-only} NOT parked: those are policy exemptions answered by the
//    card policy (exemptReason), not refusals; their NOT-parked behavior is main's and unchanged, their parked behavior is above.
describe('source order (the cells above that HTTP cannot reach, and a guard against a new shortcut being added ahead of the check)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'estimate-slots-public.js'), 'utf8');
  const strip = (text) => text.replace(/^\s*\/\/.*$/gm, '');
  const routeSlice = (startNeedle, endNeedle) => strip(src.slice(src.indexOf(startNeedle), src.indexOf(endNeedle)));

  test.each([
    ["router.post('/:token/find-slots'", "router.post('/:token/reserve'"],
    ["router.post('/:token/reserve'", "router.post('/:token/card-hold-intent'"],
  ])('%s: the one blocking-state call is the first refusal after the viewability gates', (start, end) => {
    const route = routeSlice(start, end);
    const guard = route.indexOf('slotBlockingRefusal(estimate');
    expect(guard).toBeGreaterThan(0);
    // Every shortcut / alternative payload comes after it.
    for (const needle of ['rejectGatedSuppressionEstimate(res, estimate', 'isCommercialAutoEstimate(estimate)', 'isRodentGuaranteeOnlyEstimate(estimate']) {
      expect([needle, route.indexOf(needle) > guard]).toEqual([needle, true]);
    }
    // ... and only viewability refusals precede it.
    const before = route.slice(0, guard);
    expect(before).toContain('rejectCallSideBlockedEstimate');
    expect(before).toContain('rejectIneligibleEstimate(res, estimate, { deferSuppressionGate: true })');
    expect(before).not.toMatch(/commercialManualScheduling|invoiceOnlyAcceptance|BERMUDA/);
  });

  test('slotBrowseRefusal (available-slots and the texting scheduler gate): viewability, then the blocking state, then the shortcuts', () => {
    const fn = strip(src.slice(src.indexOf('async function slotBrowseRefusal'), src.indexOf("router.get('/:token/available-slots'")));
    const guard = fn.indexOf('slotBlockingRefusal(estimate');
    expect(guard).toBeGreaterThan(0);
    for (const needle of ['rejectGatedSuppressionEstimate(sink, estimate)', 'isCommercialAutoEstimate(estimate)', 'isRodentGuaranteeOnlyEstimate(estimate']) {
      expect([needle, fn.indexOf(needle) > guard]).toEqual([needle, true]);
    }
    expect(fn.slice(0, guard)).not.toMatch(/commercialManualScheduling|invoiceOnlyAcceptance|BERMUDA/);
  });

  test('extend: the shared check is the first thing the predicate does; no shortcut ahead of it on the pre-transaction or the locked read', () => {
    const route = routeSlice("router.post('/:token/reserve/:scheduledServiceId/extend'", 'module.exports');
    const predicate = route.slice(route.indexOf('const noBookingRefusal ='));
    const guard = predicate.indexOf('lockedContactReviewRefusal(row, trx');
    expect(guard).toBeGreaterThan(0);
    for (const needle of ['gatedAddOnRefusal(row)', 'isCommercialAutoEstimate(row)', 'isRodentGuaranteeOnlyEstimate(row']) {
      expect([needle, predicate.indexOf(needle) > guard]).toEqual([needle, true]);
    }
    expect(route.slice(0, route.indexOf('const noBookingRefusal =')))
      .toContain('rejectIneligibleEstimate(res, estimate, { deferSuppressionGate: true })');
  });

  test.each([
    ["router.post('/:token/card-hold-intent'", "router.post('/:token/recurring-card-intent'"],
    ["router.post('/:token/recurring-card-intent'", "router.delete('/:token/reserve/:scheduledServiceId'"],
  ])('%s: viewability / accepted / inactive, then the blocking decision, then the Bermuda gate, then pricing, quote, trenching, policy', (start, end) => {
    const route = routeSlice(start, end);
    const at = (needle) => route.indexOf(needle);
    expect(at('rejectCallSideBlockedEstimate')).toBeLessThan(at("estimate.status === 'accepted'"));
    expect(at('isEstimateAcceptActive(estimate)')).toBeLessThan(at('if (isSuppressionGatedEstimate(estimate)) {'));
    expect(at('if (isSuppressionGatedEstimate(estimate)) {')).toBeLessThan(at('rejectGatedSuppressionEstimate(res, estimate)'));
    expect(at('rejectGatedSuppressionEstimate(res, estimate)')).toBeLessThan(at('buildPricingBundle(estimate)'));
    // quote_required, trenching, then the park: the helper's own precedence, in order.
    expect(at('quoteRequirement.quoteRequired')).toBeLessThan(at('estimateTrenchingReviewRequired(estData)'));
    expect(at('estimateTrenchingReviewRequired(estData)')).toBeLessThan(at('contactReviewState(estimate, { estData, quoteRequirement })'));
    // ... and the park decision precedes every policy / exemption answer.
    expect(at('contactReviewState(estimate, { estData, quoteRequirement })')).toBeLessThan(at('sendRecheckedIntentResponse('));
  });

  test('PUT /accept: only viewability / terminal / inactive stay ahead of the blocking decision; the Bermuda gate, validations and shortcuts follow it', () => {
    const estSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'estimate-public.js'), 'utf8');
    const accept = estSrc.slice(estSrc.indexOf("res.status(zeroRowStatus).json(zeroRowMutationBody(zeroRowStatus));\n    }\n    // ORDER (the same as /data"));
    const at = (needle) => accept.indexOf(needle);
    const park = at("estimatePublicBlockingState(estimate, { suppressionGated: !!gatedAddOn })");
    expect(park).toBeGreaterThan(0);
    for (const needle of ['if (gatedAddOn) return res.status(409).json(gatedAddOn);', 'contactLastNameError', 'HOLD_EXPIRED_409', 'No appointment is needed for this renewal', 'quoteRequirement.quoteRequired', 'estimateTrenchingReviewRequired(estData)']) {
      expect([needle, at(needle) > park]).toEqual([needle, true]);
    }
    // The Bermuda gate no longer answers ahead of the accepted / inactive refusals.
    const head = estSrc.slice(estSrc.indexOf("router.put('/:token/accept'") > 0 ? estSrc.indexOf("router.put('/:token/accept'") : 0, estSrc.indexOf('// ORDER (the same as /data'));
    expect(head).not.toContain("code: 'BERMUDA_SUPPRESSION_GATED'");
  });
});
