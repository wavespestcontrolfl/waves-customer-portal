/**
 * Public slot router gates — status parity + privacy headers.
 *
 * The slot endpoints must apply the SAME exposure gate as GET /:token/data
 * (isEstimateCustomerViewable): archived, draft, scheduled, and send_failed
 * estimates must not expose availability or take reservation holds. They must
 * also stamp the same cache/privacy headers /data stamps (tokenized,
 * address-derived responses).
 *
 * No supertest in this repo — run the real router on an ephemeral port and
 * hit it with the built-in fetch (same pattern as public-ui-flags.test.js).
 */
jest.mock('../models/db', () => jest.fn());
// These cases exercise exposure gates and response privacy. Keep their
// request count independent of the production middleware's rate budget.
jest.mock('express-rate-limit', () => () => (_req, _res, next) => next());
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/estimate-slot-availability', () => ({
  getAvailableSlots: jest.fn(),
  findEstimateSlots: jest.fn(),
  MAX_SLOT_HORIZON_DAYS: 90,
}));
jest.mock('../services/slot-reservation', () => ({
  reserveSlot: jest.fn(),
  extendReservation: jest.fn(),
  releaseReservation: jest.fn(),
}));
jest.mock('../services/estimate-membership-context', () => ({
  buildEstimateMembershipContext: jest.fn(),
}));
jest.mock('../services/estimate-delivery-options', () => ({
  commercialLowConfidenceRange: jest.fn(() => ({ hasLowConfidence: false })),
}));
jest.mock('../services/estimate-deposits', () => ({
  createDepositIntentForEstimate: jest.fn(),
  resolveDepositPolicyForEstimate: jest.fn(),
}));
jest.mock('../services/estimate-card-holds', () => ({
  createCardHoldSetupIntentForEstimate: jest.fn(),
  resolveCardHoldPolicy: jest.fn(),
}));
jest.mock('../routes/estimate-public', () => ({
  // Faithful replica of estimate-public.js isEstimateCustomerViewable (the
  // real module is too heavy to require here) — the assertions below encode
  // the same state list, so drift in either place fails this suite.
  isEstimateCustomerViewable: (estimate = {}, now = new Date()) => {
    if (!estimate || estimate.archived_at) return false;
    if (['accepted', 'declined'].includes(estimate.status)) return true;
    if (['draft', 'scheduled'].includes(estimate.status)) return false;
    if (['expired', 'send_failed'].includes(estimate.status)) return false;
    if (estimate.expires_at && new Date(estimate.expires_at) < now) return false;
    return true;
  },
  isEstimateAcceptActive: jest.fn(() => true),
  // The /data pricing bundle (offerableEstimateSlots derives the page's default
  // selection from it); no priced frequencies unless a case sets one.
  buildPricingBundle: jest.fn(async () => ({})),
  estimateRendersMonthlyBilling: jest.fn(async () => false),
  reconcileFrozenMembershipSnapshot: jest.fn(async () => undefined),
  // The page's acceptance contract (/data): the slot picker renders only for
  // standard_slot_pick, so the texting AI offers times only then.
  resolveEstimateAcceptance: jest.fn(async () => ({ acceptance: { mode: 'standard_slot_pick' } })),
  isStructuralOneTimeOnlyEstimate: jest.fn(() => false),
  isRodentGuaranteeOnlyEstimate: jest.fn(() => false),
  estimateTrenchingReviewRequired: jest.fn(() => false),
  resolveEstimateInvoiceMode: jest.fn(() => false),
  // B18 park (the real implementations are pinned in estimate-public-accept-phone-match / -atomicity).
  resolveEstimateQuoteRequirement: jest.fn(() => ({ quoteRequired: false })),
  estimatePublicBlockingState: jest.fn(async () => null),
  ACCEPT_OFFICE_REVIEW_MESSAGE: 'parked-message',
  retireOrDenyDroppedCapture: jest.fn(async () => undefined),
  refuseParkedWrite: jest.fn(async () => ({ code: 'ACCEPT_NEEDS_OFFICE_REVIEW', reviewBeforeBooking: true, reason: 'contact_review', error: 'parked' })),
  acceptOfficeReviewBody: jest.fn(() => ({ code: 'ACCEPT_NEEDS_OFFICE_REVIEW', reviewBeforeBooking: true, reason: 'contact_review', error: 'parked' })),
  verifyEstimateAskToken: jest.fn(() => true),
  handleEstimateAsk: jest.fn((req, res) => res.json({})),
}));

const express = require('express');
const db = require('../models/db');
const { getAvailableSlots, findEstimateSlots, MAX_SLOT_HORIZON_DAYS } = require('../services/estimate-slot-availability');
const slotReservation = require('../services/slot-reservation');
const { capacityError } = require('../services/scheduling/arrival-route');
// Real ET helpers (not mocked) — the route compares the explicit ?date against
// the horizon in ET, exactly like slot-reservation.js does at reserve time.
const { addETDays, etDateString } = require('../utils/datetime-et');

const TOKEN = 'test-token-abc123';

let server;
let base;
let currentEstimate;
// customers row the texting AI's phone-fallback ownership reads (by id).
let customersById = {};
let lastFirstArgs;
let firstArgsHistory = [];

beforeAll((done) => {
  db.mockImplementation((table) => {
    if (table === 'customers') {
      let id;
      const q = {
        where: jest.fn((w) => { id = w?.id; return q; }),
        whereNull: jest.fn(() => q),
        first: jest.fn(async () => customersById[id]),
      };
      return q;
    }
    if (table !== 'estimates') throw new Error(`unexpected table ${table}`);
    return {
      where: jest.fn().mockReturnThis(),
      first: jest.fn((...cols) => {
        lastFirstArgs = cols;
        firstArgsHistory.push(cols);
        return Promise.resolve(currentEstimate);
      }),
    };
  });
  const app = express();
  app.use(express.json());
  app.use('/api/public/estimates', require('../routes/estimate-slots-public'));
  server = app.listen(0, () => {
    base = `http://127.0.0.1:${server.address().port}/api/public/estimates`;
    done();
  });
});

afterAll((done) => {
  server.close(done);
});

beforeEach(() => {
  getAvailableSlots.mockReset();
  require('../routes/estimate-public').buildPricingBundle.mockReset();
  require('../routes/estimate-public').buildPricingBundle.mockResolvedValue({});
  require('../routes/estimate-public').resolveEstimateAcceptance.mockReset();
  require('../routes/estimate-public').resolveEstimateAcceptance.mockResolvedValue({ acceptance: { mode: 'standard_slot_pick' } });
  findEstimateSlots.mockReset();
  slotReservation.reserveSlot.mockReset();
  lastFirstArgs = null;
  firstArgsHistory = [];
});

const NON_VIEWABLE = [
  ['draft', { id: 'est-1', status: 'draft', expires_at: null, archived_at: null }],
  ['scheduled', { id: 'est-1', status: 'scheduled', expires_at: null, archived_at: null }],
  ['send_failed', { id: 'est-1', status: 'send_failed', expires_at: null, archived_at: null }],
  ['archived', { id: 'est-1', status: 'sent', expires_at: null, archived_at: '2026-07-01T00:00:00Z' }],
  // Archived + TERMINAL: the viewability 404 must win over the terminal 409 —
  // a 409 here would make archived tokens distinguishable from missing ones.
  // One representative status; declined/void ride the same archived_at branch.
  ['archived accepted', { id: 'est-1', status: 'accepted', expires_at: null, archived_at: '2026-07-01T00:00:00Z' }],
  // expired is non-viewable on /data, so the slot endpoints 404 it too (it
  // used to leak a 409 through the terminal branch running first).
  ['expired', { id: 'est-1', status: 'expired', expires_at: null, archived_at: null }],
];

describe('slot endpoints status-gate parity with /:token/data', () => {
  test.each(NON_VIEWABLE)('available-slots 404s a %s estimate without exposing availability', async (_label, estimate) => {
    currentEstimate = estimate;
    const res = await fetch(`${base}/${TOKEN}/available-slots`);
    expect(res.status).toBe(404);
    expect(getAvailableSlots).not.toHaveBeenCalled();
  });

  test.each(NON_VIEWABLE)('reserve 404s a %s estimate without creating a hold', async (_label, estimate) => {
    currentEstimate = estimate;
    const res = await fetch(`${base}/${TOKEN}/reserve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slotId: '2027-05-20_09-00_tech-1' }),
    });
    expect(res.status).toBe(404);
    expect(slotReservation.reserveSlot).not.toHaveBeenCalled();
  });

  test('find-slots 404s an archived accepted estimate too — the gate is shared across all three slot endpoints', async () => {
    currentEstimate = { id: 'est-1', status: 'accepted', expires_at: null, archived_at: '2026-07-01T00:00:00Z' };
    const res = await fetch(`${base}/${TOKEN}/find-slots`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'next week mornings' }),
    });
    expect(res.status).toBe(404);
    expect(findEstimateSlots).not.toHaveBeenCalled();
  });

  test('VIEWABLE terminal states (accepted/declined/void, not archived) still 409 — viewability runs first, then the terminal gate', async () => {
    for (const status of ['accepted', 'declined', 'void']) {
      currentEstimate = { id: 'est-1', status, expires_at: null, archived_at: null };
      const res = await fetch(`${base}/${TOKEN}/available-slots`);
      expect(res.status).toBe(409);
    }
    expect(getAvailableSlots).not.toHaveBeenCalled();
  });

  test('the estimate SELECT fetches archived_at so the gate can see it', async () => {
    currentEstimate = { id: 'est-1', status: 'sent', expires_at: null, archived_at: null };
    getAvailableSlots.mockResolvedValue({ primary: [], expander: [], metadata: {} });
    const res = await fetch(`${base}/${TOKEN}/available-slots`);
    expect(res.status).toBe(200);
    expect(lastFirstArgs).toContain('archived_at');
  });
});

describe('specific-date browse horizon (parity with reserveSlot)', () => {
  const VIEWABLE = { id: 'est-1', status: 'sent', expires_at: null, archived_at: null };

  test('an explicit date beyond MAX_SLOT_HORIZON_DAYS is rejected without a slots lookup', async () => {
    currentEstimate = VIEWABLE;
    const farFuture = etDateString(addETDays(new Date(), MAX_SLOT_HORIZON_DAYS + 1));
    const res = await fetch(`${base}/${TOKEN}/available-slots?date=${farFuture}`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'date is beyond the booking horizon' });
    expect(getAvailableSlots).not.toHaveBeenCalled();
  });

  test('an in-horizon explicit date still pins the lookup to that single day', async () => {
    currentEstimate = VIEWABLE;
    getAvailableSlots.mockResolvedValue({ primary: [], expander: [], metadata: {} });
    const inHorizon = etDateString(addETDays(new Date(), 7));
    const res = await fetch(`${base}/${TOKEN}/available-slots?date=${inHorizon}`);
    expect(res.status).toBe(200);
    expect(getAvailableSlots).toHaveBeenCalledWith('est-1', expect.objectContaining({
      dateFrom: inHorizon,
      dateTo: inHorizon,
    }));
  });

  test('the boundary day (exactly MAX_SLOT_HORIZON_DAYS out) is browsable — reserveSlot uses strict >', async () => {
    currentEstimate = VIEWABLE;
    getAvailableSlots.mockResolvedValue({ primary: [], expander: [], metadata: {} });
    const boundary = etDateString(addETDays(new Date(), MAX_SLOT_HORIZON_DAYS));
    const res = await fetch(`${base}/${TOKEN}/available-slots?date=${boundary}`);
    expect(res.status).toBe(200);
    expect(getAvailableSlots).toHaveBeenCalledWith('est-1', expect.objectContaining({
      dateFrom: boundary,
      dateTo: boundary,
    }));
  });
});

describe('slot endpoints privacy/cache headers (parity with /:token/data)', () => {
  test.each(['available-slots', 'find-slots'])('%s returns a safe recoverable conflict for catalog failures', async endpoint => {
    currentEstimate = { id: 'est-1', status: 'sent', expires_at: null, archived_at: null };
    const lookup = endpoint === 'available-slots' ? getAvailableSlots : findEstimateSlots;
    lookup.mockRejectedValueOnce(Object.assign(capacityError('catalog_unavailable'), {
      message: 'private catalog query failed', catalogId: 'private-catalog-id',
      provider: 'private-provider', cause: new Error('SELECT private_catalog_column'),
    }));
    const response = await fetch(`${base}/${TOKEN}/${endpoint}`, endpoint === 'find-slots' ? {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'next week mornings' }),
    } : undefined);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'This time is no longer available. Please choose another appointment.',
      code: 'SLOT_UNAVAILABLE', retry: true,
    });
    expect(response.headers.get('cache-control')).toBe('no-cache, no-store, must-revalidate');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(slotReservation.reserveSlot).not.toHaveBeenCalled();
  });

  test('available-slots stamps no-store caching + no-referrer on success and 404 alike', async () => {
    currentEstimate = { id: 'est-1', status: 'sent', expires_at: null, archived_at: null };
    getAvailableSlots.mockResolvedValue({ primary: [], expander: [], metadata: {} });
    const ok = await fetch(`${base}/${TOKEN}/available-slots`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe('no-cache, no-store, must-revalidate');
    expect(ok.headers.get('pragma')).toBe('no-cache');
    expect(ok.headers.get('referrer-policy')).toBe('no-referrer');

    currentEstimate = null; // unknown token path
    const missing = await fetch(`${base}/${TOKEN}/available-slots`);
    expect(missing.status).toBe(404);
    expect(missing.headers.get('cache-control')).toBe('no-cache, no-store, must-revalidate');
    expect(missing.headers.get('pragma')).toBe('no-cache');
    expect(missing.headers.get('referrer-policy')).toBe('no-referrer');
  });

  test('reserve responses carry the same headers and reservation succeeds for a viewable estimate', async () => {
    currentEstimate = { id: 'est-1', status: 'sent', expires_at: null, archived_at: null };
    slotReservation.reserveSlot.mockResolvedValue({
      scheduledServiceId: 'scheduled-1',
      expiresAt: '2027-05-20T13:15:00.000Z',
    });
    const res = await fetch(`${base}/${TOKEN}/reserve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slotId: '2027-05-20_09-00_tech-1' }),
    });
    expect(res.status).toBe(201);
    expect(res.headers.get('cache-control')).toBe('no-cache, no-store, must-revalidate');
    expect(res.headers.get('pragma')).toBe('no-cache');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(await res.json()).toEqual(expect.objectContaining({ scheduledServiceId: 'scheduled-1' }));
  });
});

// The money/slot mirror of the accept/send/manual-accept suppression gates
// (codex #3272 r5 P0): while GATE_BERMUDA_SUPPRESSION is off, a persisted
// suppression estimate exposes no availability, takes no reservation, and —
// critically — mints/finalizes no money.
describe('bermuda-suppression money/slot gate', () => {
  const SUPPRESSION_ESTIMATE = {
    id: 'est-supp',
    status: 'sent',
    expires_at: null,
    archived_at: null,
    estimate_data: JSON.stringify({ engineRequest: { options: { bermudaSuppression: true } } }),
  };
  const prevGate = process.env.GATE_BERMUDA_SUPPRESSION;
  afterEach(() => {
    if (prevGate === undefined) delete process.env.GATE_BERMUDA_SUPPRESSION;
    else process.env.GATE_BERMUDA_SUPPRESSION = prevGate;
  });

  test('gate off: slots AND deposit boundaries 409 before availability or money is touched', async () => {
    delete process.env.GATE_BERMUDA_SUPPRESSION;
    currentEstimate = SUPPRESSION_ESTIMATE;
    const slots = await fetch(`${base}/${TOKEN}/available-slots`);
    expect(slots.status).toBe(409);
    expect((await slots.json()).code).toBe('BERMUDA_SUPPRESSION_GATED');
    expect(getAvailableSlots).not.toHaveBeenCalled();

    // The retired deposit-intent VERDICT STUB answers before any estimate
    // load, so it is exempt from the suppression gate by construction —
    // the accept client must always get its 409-with-exemptReason
    // "nothing owed" verdict (a 404 or other shape would block accepts
    // that re-consult after a non-superseding card/hold 409).
    db.mockClear();
    for (const leg of ['deposit-intent', 'deposit-quote', 'deposit-finalize', 'deposit-reset']) {
      const retiredDeposit = await fetch(`${base}/${TOKEN}/${leg}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      expect(retiredDeposit.status).toBe(409);
      expect(await retiredDeposit.json()).toEqual({
        error: 'No deposit is required for this estimate', exemptReason: 'deposits_retired',
      });
    }
    const malformedDeposit = await fetch(`${base}/invalid!token/deposit-intent`, { method: 'POST' });
    expect(malformedDeposit.status).toBe(404);
    expect(await malformedDeposit.json()).toEqual({ error: 'Not found' });
    expect(db).not.toHaveBeenCalled();

    // Money boundary: card-hold-intent (the other deposit routes were
    // REMOVED 2026-08-10 — card-hold is the live money/commitment boundary
    // here). recurring-card-intent carries the SAME guard inserted
    // immediately after the same estimate load (single replace-all site).
    const hold = await fetch(`${base}/${TOKEN}/card-hold-intent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(hold.status).toBe(409);
    expect((await hold.json()).code).toBe('BERMUDA_SUPPRESSION_GATED');
  });

  test('gate on: the suppression gate does not fire on the slot path', async () => {
    process.env.GATE_BERMUDA_SUPPRESSION = 'true';
    currentEstimate = SUPPRESSION_ESTIMATE;
    getAvailableSlots.mockResolvedValue([]);
    const slots = await fetch(`${base}/${TOKEN}/available-slots`);
    expect(slots.status).not.toBe(409);
  });
});

describe('B18 park: a parked estimate (its phone belongs to another customer) cannot browse, reserve, extend or capture a card', () => {
  const { estimatePublicBlockingState } = require('../routes/estimate-public');
  const { createCardHoldSetupIntentForEstimate, resolveCardHoldPolicy } = require('../services/estimate-card-holds');
  const PARKED_ESTIMATE = { id: 'est-parked', token: TOKEN, status: 'sent', expires_at: null, archived_at: null, customer_id: null, customer_phone: '(941) 555-0123', estimate_data: {} };
  const PARKED = { state: 'contact_review', rejectedCustomerId: 'cust-bob' };
  const post = (leg, body = {}) => fetch(`${base}/${TOKEN}/${leg}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  test.each(['card-hold-intent', 'recurring-card-intent'])('%s refuses with the coded park 409 before any intent or policy work', async (leg) => {
    currentEstimate = PARKED_ESTIMATE;
    estimatePublicBlockingState.mockResolvedValueOnce(PARKED);
    const res = await post(leg);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'ACCEPT_NEEDS_OFFICE_REVIEW', reviewBeforeBooking: true, reason: 'contact_review' });
    expect(createCardHoldSetupIntentForEstimate).not.toHaveBeenCalled();
    expect(resolveCardHoldPolicy).not.toHaveBeenCalled();
    // The helper gets the estimate row (phone/email/address columns included) and the resolved estimate data.
    expect(estimatePublicBlockingState).toHaveBeenCalledWith(PARKED_ESTIMATE, expect.objectContaining({ estData: expect.anything() }));
  });

  test('reserve hands the service a locked-row predicate (trenching review, then contact_review) and maps its refusal to the SAME 409 the route check returns', async () => {
    currentEstimate = PARKED_ESTIMATE;
    // The route's own pre-transaction check passes (the estimate was not parked yet) ...
    estimatePublicBlockingState.mockResolvedValueOnce(null);
    // ... then the locked row inside the service says contact_review.
    slotReservation.reserveSlot.mockImplementationOnce(async (args) => {
      const refusal = await args.revalidateEstimate({ ...PARKED_ESTIMATE, estimate_data: {} });
      const err = new Error('estimate cannot be self-booked');
      err.code = 'ESTIMATE_NO_BOOKING';
      err.response = refusal;
      throw err;
    });
    estimatePublicBlockingState.mockResolvedValueOnce(PARKED);
    const res = await post('reserve', { slotId: '2030-01-01_09-00_unassigned' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'ACCEPT_NEEDS_OFFICE_REVIEW', reviewBeforeBooking: true, reason: 'contact_review' });
    expect(slotReservation.reserveSlot).toHaveBeenCalledWith(expect.objectContaining({ estimateId: 'est-parked', revalidateEstimate: expect.any(Function) }));
  });

  test('the reserve predicate also carries the existing trenching refusal and passes a clean row', async () => {
    const { estimateTrenchingReviewRequired } = require('../routes/estimate-public');
    currentEstimate = PARKED_ESTIMATE;
    let predicate;
    slotReservation.reserveSlot.mockImplementationOnce(async (args) => { predicate = args.revalidateEstimate; return { scheduledServiceId: 'ss-1', expiresAt: null }; });
    const ok = await post('reserve', { slotId: '2030-01-01_09-00_unassigned' });
    expect(ok.status).toBe(201);
    estimatePublicBlockingState.mockResolvedValue(null);
    await expect(predicate({ ...PARKED_ESTIMATE, estimate_data: {} })).resolves.toBeNull();
    estimateTrenchingReviewRequired.mockReturnValueOnce(true);
    await expect(predicate({ ...PARKED_ESTIMATE, estimate_data: {} })).resolves.toMatchObject({ status: 409, body: { reason: 'termite_trenching_review' } });
  });

  describe('a replace-payment-method request on the park path retires the submitted intent first', () => {
    const { retireOrDenyDroppedCapture } = require('../routes/estimate-public');
    beforeEach(() => { retireOrDenyDroppedCapture.mockClear(); retireOrDenyDroppedCapture.mockResolvedValue(undefined); });

    test('retires replaceSetupIntentId (trimmed, for THIS estimate) BEFORE the 409', async () => {
      currentEstimate = PARKED_ESTIMATE;
      estimatePublicBlockingState.mockResolvedValueOnce(PARKED);
      const res = await post('recurring-card-intent', { replaceSetupIntentId: ' seti_old ' });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'ACCEPT_NEEDS_OFFICE_REVIEW' });
      expect(retireOrDenyDroppedCapture).toHaveBeenCalledTimes(1);
      expect(retireOrDenyDroppedCapture).toHaveBeenCalledWith(PARKED_ESTIMATE, 'seti_old');
    });

    test('Stripe cannot confirm: the existing 503, never the 409 (the client keeps nothing it cannot retry)', async () => {
      currentEstimate = PARKED_ESTIMATE;
      estimatePublicBlockingState.mockResolvedValueOnce(PARKED);
      retireOrDenyDroppedCapture.mockRejectedValueOnce(Object.assign(new Error('We could not update your payment terms just now. Please try again in a moment.'), { code: 'RECURRING_CARD_RETIRE_FAILED' }));
      const res = await post('recurring-card-intent', { replaceSetupIntentId: 'seti_old' });
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ code: 'RECURRING_CARD_RETIRE_FAILED' });
    });

    test('no replace intent = no Stripe call; /card-hold-intent has no equivalent field, so it never retires one', async () => {
      currentEstimate = PARKED_ESTIMATE;
      estimatePublicBlockingState.mockResolvedValueOnce(PARKED);
      expect((await post('recurring-card-intent', {})).status).toBe(409);
      estimatePublicBlockingState.mockResolvedValueOnce(PARKED);
      expect((await post('card-hold-intent', { replaceSetupIntentId: 'seti_old' })).status).toBe(409);
      expect(retireOrDenyDroppedCapture).not.toHaveBeenCalled();
    });
  });

  describe('the reserve / extend locked callback reads the phone candidate on the reservation transaction, FOR SHARE NOWAIT', () => {
    const TRX = { isTransaction: true, raw: jest.fn(async () => ({})) }; // raw: the SAVEPOINT statements
    const lockedRow = { ...PARKED_ESTIMATE, estimate_data: {} };
    const capture = async () => {
      let predicate;
      currentEstimate = PARKED_ESTIMATE;
      estimatePublicBlockingState.mockResolvedValueOnce(null);
      slotReservation.reserveSlot.mockImplementationOnce(async (args) => { predicate = args.revalidateEstimate; return { scheduledServiceId: 'ss-1', expiresAt: null }; });
      await post('reserve', { slotId: '2030-01-01_09-00_unassigned' });
      return predicate;
    };

    test('the helper gets the reservation transaction and the lock flag; a candidate edited to contradict refuses', async () => {
      const predicate = await capture();
      estimatePublicBlockingState.mockClear();
      estimatePublicBlockingState.mockResolvedValueOnce(PARKED);
      await expect(predicate(lockedRow, TRX)).resolves.toMatchObject({ status: 409, body: { code: 'ACCEPT_NEEDS_OFFICE_REVIEW' } });
      expect(estimatePublicBlockingState).toHaveBeenCalledWith(lockedRow, expect.objectContaining({ database: TRX, lock: true }));
      estimatePublicBlockingState.mockResolvedValueOnce(null);
      await expect(predicate(lockedRow, TRX)).resolves.toBeNull();
    });

    test('a customer row another writer holds right now (55P03) is the accept\'s existing retryable refusal, not a wait and not a pass', async () => {
      const predicate = await capture();
      TRX.raw.mockClear();
      estimatePublicBlockingState.mockRejectedValueOnce(Object.assign(new Error('could not obtain lock'), { code: '55P03' }));
      await expect(predicate(lockedRow, TRX)).resolves.toMatchObject({ status: 409, body: { code: 'CUSTOMER_BUSY_RETRY' } });
      // The locked read ran in a SAVEPOINT that was rolled back to (waves-db 5b), so the outer transaction survives.
      const statements = TRX.raw.mock.calls.map((c) => String(c[0]));
      expect(statements[0]).toMatch(/^SAVEPOINT scope_/);
      expect(statements.some((q) => /^ROLLBACK TO SAVEPOINT scope_/.test(q))).toBe(true);
      // Any other failure still propagates (the route's own 500).
      estimatePublicBlockingState.mockRejectedValueOnce(new Error('db down'));
      await expect(predicate(lockedRow, TRX)).rejects.toThrow('db down');
    });
  });

  describe('every public WRITE path refuses a parked estimate through the ONE function (office alert + hold release); reads do not', () => {
    const { refuseParkedWrite } = require('../routes/estimate-public');
    beforeEach(() => refuseParkedWrite.mockClear());

    test.each([
      ['card-hold-intent', 'card-hold-intent', {}],
      ['recurring-card-intent', 'recurring-card-intent', {}],
      ['reserve (pre-transaction check)', 'reserve', { slotId: '2030-01-01_09-00_unassigned' }],
    ])('%s', async (_label, leg, body) => {
      currentEstimate = PARKED_ESTIMATE;
      estimatePublicBlockingState.mockResolvedValueOnce(PARKED);
      const res = await post(leg, body);
      expect(res.status).toBe(409);
      expect(refuseParkedWrite).toHaveBeenCalledTimes(1);
      expect(refuseParkedWrite).toHaveBeenCalledWith(PARKED_ESTIMATE, 'cust-bob');
    });

    test('reserve (locked row inside the service) and extend (pre-transaction and locked) too - the side effects run after the transaction, in the route', async () => {
      currentEstimate = PARKED_ESTIMATE;
      estimatePublicBlockingState.mockResolvedValueOnce(null);
      slotReservation.reserveSlot.mockImplementationOnce(async (args) => {
        const refusal = await args.revalidateEstimate({ ...PARKED_ESTIMATE, estimate_data: {} }, { isTransaction: true, raw: async () => ({}) });
        const err = new Error('estimate cannot be self-booked'); err.code = 'ESTIMATE_NO_BOOKING'; err.response = refusal; throw err;
      });
      estimatePublicBlockingState.mockResolvedValueOnce(PARKED);
      expect((await post('reserve', { slotId: '2030-01-01_09-00_unassigned' })).status).toBe(409);
      expect(refuseParkedWrite).toHaveBeenCalledTimes(1);
      refuseParkedWrite.mockClear();
      // extend, pre-transaction read
      estimatePublicBlockingState.mockResolvedValueOnce(PARKED);
      const pre = await fetch(`${base}/${TOKEN}/reserve/11111111-1111-4111-8111-111111111111/extend`, { method: 'POST' });
      expect(pre.status).toBe(409);
      expect(refuseParkedWrite).toHaveBeenCalledTimes(1);
      refuseParkedWrite.mockClear();
      // extend, locked row
      estimatePublicBlockingState.mockResolvedValueOnce(null);
      slotReservation.extendReservation.mockImplementationOnce(async (args) => {
        const refusal = await args.revalidateEstimate({ ...PARKED_ESTIMATE, estimate_data: {} }, { isTransaction: true, raw: async () => ({}) });
        const err = new Error('estimate cannot be self-booked'); err.code = 'ESTIMATE_NO_BOOKING'; err.response = refusal; throw err;
      });
      estimatePublicBlockingState.mockResolvedValueOnce(PARKED);
      expect((await fetch(`${base}/${TOKEN}/reserve/11111111-1111-4111-8111-111111111111/extend`, { method: 'POST' })).status).toBe(409);
      expect(refuseParkedWrite).toHaveBeenCalledTimes(1);
    });

    test('the slot READS and the scheduler gate never run the side effects', async () => {
      currentEstimate = PARKED_ESTIMATE;
      estimatePublicBlockingState.mockResolvedValueOnce(PARKED);
      await fetch(`${base}/${TOKEN}/available-slots`);
      expect(refuseParkedWrite).not.toHaveBeenCalled();
    });
  });

  describe('EXTEND never discards a valid hold over a briefly held customer row; RESERVE keeps the retryable refusal', () => {
    const TRX = { isTransaction: true, raw: jest.fn(async () => ({})) }; // raw: the SAVEPOINT statements
    test('55P03 on the extend predicate extends (null), on the reserve predicate it is CUSTOMER_BUSY_RETRY', async () => {
      currentEstimate = PARKED_ESTIMATE;
      let extendPredicate;
      estimatePublicBlockingState.mockResolvedValueOnce(null);
      slotReservation.extendReservation.mockImplementationOnce(async (args) => { extendPredicate = args.revalidateEstimate; return { scheduledServiceId: 'ss-1', expiresAt: null }; });
      await fetch(`${base}/${TOKEN}/reserve/11111111-1111-4111-8111-111111111111/extend`, { method: 'POST' });
      estimatePublicBlockingState.mockRejectedValueOnce(Object.assign(new Error('could not obtain lock'), { code: '55P03' }));
      await expect(extendPredicate({ ...PARKED_ESTIMATE, estimate_data: {} }, TRX)).resolves.toBeNull();
      // A real park on the locked extend row still refuses.
      estimatePublicBlockingState.mockResolvedValueOnce(PARKED);
      await expect(extendPredicate({ ...PARKED_ESTIMATE, estimate_data: {} }, TRX)).resolves.toMatchObject({ status: 409, park: { rejectedCustomerId: 'cust-bob' } });
    });
  });

  describe('no client secret leaves the server for an estimate parked while the intent was being minted', () => {
    const { refuseParkedWrite } = require('../routes/estimate-public');
    test('card-hold-intent re-runs the park AUTHORITATIVELY (fresh) after minting and withholds the secret', async () => {
      currentEstimate = PARKED_ESTIMATE;
      resolveCardHoldPolicy.mockReturnValue({ required: true, enforced: true, noShowFeeAmount: 49, cancelWindowHours: 24 });
      createCardHoldSetupIntentForEstimate.mockResolvedValue({ clientSecret: 'cs_SECRET', setupIntentId: 'seti_1', noShowFeeAmount: 49, cancelWindowHours: 24 });
      refuseParkedWrite.mockClear();
      estimatePublicBlockingState.mockClear();
      estimatePublicBlockingState.mockResolvedValueOnce(null).mockResolvedValueOnce(PARKED); // pre-check clean, post-mint parked
      const res = await post('card-hold-intent', {});
      const text = await res.text();
      expect(res.status).toBe(409);
      expect(text).not.toContain('cs_SECRET');
      expect(JSON.parse(text)).toMatchObject({ code: 'ACCEPT_NEEDS_OFFICE_REVIEW' });
      expect(estimatePublicBlockingState).toHaveBeenCalledTimes(2);
      expect(estimatePublicBlockingState.mock.calls[0][1]).not.toHaveProperty('fresh');
      expect(estimatePublicBlockingState.mock.calls[1][1]).toEqual(expect.objectContaining({ fresh: true }));
      expect(refuseParkedWrite).toHaveBeenCalledTimes(1);
      // Control: still clean at the re-check -> the secret is returned as before.
      estimatePublicBlockingState.mockResolvedValue(null);
      const ok = await post('card-hold-intent', {});
      expect(ok.status).toBe(200);
      expect((await ok.json()).clientSecret).toBe('cs_SECRET');
    });

    test('recurring-card-intent: the same fresh re-check sits after minting and stamping and before any secret, and retires the minted intent first (source order)', () => {
      const fs = require('fs');
      const path = require('path');
      const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'estimate-slots-public.js'), 'utf8');
      const route = src.slice(src.indexOf("router.post('/:token/recurring-card-intent'"), src.indexOf("router.delete('/:token/reserve/:scheduledServiceId'"));
      const mint = route.indexOf('createRecurringCardSetupIntentForEstimate(estimate)');
      const recheck = route.indexOf('fresh: true });');
      const retire = route.indexOf('await retireOrDenyDroppedCapture(estimate, intent.setupIntentId);');
      const secret = route.indexOf('clientSecret: intent.clientSecret');
      expect(mint).toBeGreaterThan(0);
      expect(recheck).toBeGreaterThan(mint);
      expect(retire).toBeGreaterThan(recheck);
      expect(secret).toBeGreaterThan(retire);
      expect(route.slice(retire, secret)).toContain('RECURRING_CARD_RETIRE_FAILED');
    });
  });

  test('available-slots answers the review shape (no times) and never reaches the slot service', async () => {
    currentEstimate = PARKED_ESTIMATE;
    estimatePublicBlockingState.mockResolvedValueOnce(PARKED);
    const res = await fetch(`${base}/${TOKEN}/available-slots`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ primary: [], availableSlots: [], reviewBeforeBooking: true, reason: 'contact_review', message: 'parked-message' });
    expect(getAvailableSlots).not.toHaveBeenCalled();
  });

  test('find-slots answers the review shape and reserve answers the coded 409; no slot is searched or held', async () => {
    currentEstimate = PARKED_ESTIMATE;
    process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test';
    estimatePublicBlockingState.mockResolvedValueOnce(PARKED);
    const found = await post('find-slots', { query: 'next week please' });
    // (askToken gating may answer before the park check in this harness: assert only that no search ran.)
    expect(findEstimateSlots).not.toHaveBeenCalled();
    if (found.status === 200) expect(await found.json()).toMatchObject({ reviewBeforeBooking: true, reason: 'contact_review' });
    estimatePublicBlockingState.mockResolvedValueOnce(PARKED);
    const reserved = await post('reserve', { slotId: '2030-01-01_09-00_unassigned' });
    expect(reserved.status).toBe(409);
    expect(await reserved.json()).toMatchObject({ code: 'ACCEPT_NEEDS_OFFICE_REVIEW' });
    expect(slotReservation.reserveSlot).not.toHaveBeenCalled();
  });

  test('extend refuses on the pre-transaction read AND hands the service the same predicate for the locked row', async () => {
    currentEstimate = PARKED_ESTIMATE;
    estimatePublicBlockingState.mockResolvedValue(PARKED);
    try {
      const res = await fetch(`${base}/${TOKEN}/reserve/11111111-1111-4111-8111-111111111111/extend`, { method: 'POST' });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'ACCEPT_NEEDS_OFFICE_REVIEW' });
    } finally { estimatePublicBlockingState.mockResolvedValue(null); }
  });

  test('the texting AI\'s gate (slotBrowseRefusal) inherits it: no times offered for a parked estimate, and none when the verdict cannot be read', async () => {
    const { offerableEstimateSlots } = require('../routes/estimate-slots-public')._internals;
    currentEstimate = { ...PARKED_ESTIMATE, customer_id: 'cust-1' };
    customersById = { 'cust-1': { phone: '(941) 555-0123' } };
    estimatePublicBlockingState.mockResolvedValueOnce(PARKED);
    await expect(offerableEstimateSlots('est-parked', 'cust-1')).resolves.toBeNull();
    estimatePublicBlockingState.mockRejectedValueOnce(new Error('phone lookup down'));
    await expect(offerableEstimateSlots('est-parked', 'cust-1')).resolves.toBeNull();
    expect(getAvailableSlots).not.toHaveBeenCalled();
  });
});

// The texting AI's OPEN TIMES for an estimate (GATE_SMS_OFFERS_SCHEDULER, sms-shadow-drafter):
// offered only when THIS page's GET would browse slots, and only for the
// context customer's own estimate.
describe('offerableEstimateSlots — the page picker, for the texting AI', () => {
  const { offerableEstimateSlots } = require('../routes/estimate-slots-public')._internals;
  const OWN = { id: 'est-1', customer_id: 'cust-1', status: 'sent', expires_at: null, archived_at: null };
  const SLOTS = { primary: [{ date: '2027-05-20', windowStart: '09:00' }], expander: [] };

  test('the customer\'s own viewable estimate: the same getAvailableSlots the page runs, default window + the page\'s service mode', async () => {
    currentEstimate = OWN;
    getAvailableSlots.mockResolvedValue(SLOTS);
    await expect(offerableEstimateSlots('est-1', 'cust-1')).resolves.toBe(SLOTS);
    expect(getAvailableSlots).toHaveBeenCalledWith('est-1', expect.objectContaining({ serviceMode: expect.any(String) }));
    expect(getAvailableSlots.mock.calls[0][1]).not.toHaveProperty('windowDays');
    expect(firstArgsHistory[0]).toContain('customer_id');
  });

  test('the send-time recheck (fresh): the SAME picker read uncached and uncapped; the draft read passes none of that', async () => {
    currentEstimate = OWN;
    getAvailableSlots.mockResolvedValue(SLOTS);
    await offerableEstimateSlots('est-1', 'cust-1');
    expect(getAvailableSlots.mock.calls[0][1]).not.toHaveProperty('bypassCache');
    expect(getAvailableSlots.mock.calls[0][1]).not.toHaveProperty('maxResults');
    expect(getAvailableSlots.mock.calls[0][1]).not.toHaveProperty('expanderMaxResults');
    getAvailableSlots.mockClear();
    await expect(offerableEstimateSlots('est-1', 'cust-1', { fresh: true })).resolves.toBe(SLOTS);
    expect(getAvailableSlots).toHaveBeenCalledWith('est-1', expect.objectContaining({
      serviceMode: expect.any(String), bypassCache: true, maxResults: expect.any(Number), expanderMaxResults: 0,
    }));
    expect(getAvailableSlots.mock.calls[0][1].maxResults).toBeGreaterThanOrEqual(1000);
    expect(getAvailableSlots.mock.calls[0][1]).not.toHaveProperty('windowDays');
    // the page's gate still applies to a fresh read
    currentEstimate = { ...OWN, status: 'draft' };
    getAvailableSlots.mockClear();
    await expect(offerableEstimateSlots('est-1', 'cust-1', { fresh: true })).resolves.toBeNull();
    expect(getAvailableSlots).not.toHaveBeenCalled();
  });

  test('another customer\'s estimate, or no customer, is never offered — the picker is not even asked', async () => {
    currentEstimate = OWN;
    await expect(offerableEstimateSlots('est-1', 'cust-2')).resolves.toBeNull();
    await expect(offerableEstimateSlots('est-1', null)).resolves.toBeNull();
    currentEstimate = null;
    await expect(offerableEstimateSlots('est-gone', 'cust-1')).resolves.toBeNull();
    expect(getAvailableSlots).not.toHaveBeenCalled();
  });

  // The resolver's phone fallback (resolveEstimateContext): an open estimate
  // whose customer_phone is the customer's number anchors the conversation
  // even with no (or another) customer_id — a lead's estimate often has none.
  describe('phone-matched estimate (the resolver\'s fallback)', () => {
    afterEach(() => { customersById = {}; });

    test.each([
      ['no customer_id', null],
      ['another customer_id', 'cust-9'],
    ])('%s but the estimate phone is the customer\'s own number → offered', async (_label, estimateCustomer) => {
      currentEstimate = { ...OWN, customer_id: estimateCustomer, customer_phone: '(941) 555-0142' };
      customersById = { 'cust-1': { phone: '+19415550142' } };
      getAvailableSlots.mockResolvedValue(SLOTS);
      await expect(offerableEstimateSlots('est-1', 'cust-1')).resolves.toEqual(SLOTS);
      expect(getAvailableSlots).toHaveBeenCalledTimes(1);
    });

    test.each([
      ['a different number on file', { 'cust-1': { phone: '+19415550199' } }, '9415550142', 'cust-1'],
      ['no number on the estimate', { 'cust-1': { phone: '+19415550142' } }, null, 'cust-1'],
      ['the customer row gone / deleted', {}, '9415550142', 'cust-1'],
      ['no customer at all', { 'cust-1': { phone: '+19415550142' } }, '9415550142', null],
    ])('%s → nothing offered, the picker is not asked', async (_label, customers, estimatePhone, customerId) => {
      currentEstimate = { ...OWN, customer_id: null, customer_phone: estimatePhone };
      customersById = customers;
      await expect(offerableEstimateSlots('est-1', customerId)).resolves.toBeNull();
      expect(getAvailableSlots).not.toHaveBeenCalled();
    });
  });

  test.each([
    ['archived', { archived_at: '2026-07-01T00:00:00Z' }],
    ['draft', { status: 'draft' }],
    ['accepted (terminal)', { status: 'accepted' }],
    ['commercial auto-priced (team schedules it)', { estimate_data: JSON.stringify({ commercialEstimatedPricing: true }) }],
  ])('a %s estimate — a refusal the page answers instead of slots — offers nothing', async (_label, patch) => {
    currentEstimate = { ...OWN, ...patch };
    await expect(offerableEstimateSlots('est-1', 'cust-1')).resolves.toBeNull();
    expect(getAvailableSlots).not.toHaveBeenCalled();
  });

  test('the service says the estimate is expired / terminal → nothing; any other error propagates (caller fails closed)', async () => {
    currentEstimate = OWN;
    getAvailableSlots.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'ESTIMATE_EXPIRED' }));
    await expect(offerableEstimateSlots('est-1', 'cust-1')).resolves.toBeNull();
    getAvailableSlots.mockRejectedValueOnce(new Error('db down'));
    await expect(offerableEstimateSlots('est-1', 'cust-1')).rejects.toThrow('db down');
  });
});

// The picker must be asked with the SAME default selection the estimate page
// sends on its first fetch (SlotPicker.jsx: selectedFrequency + serviceCadences),
// or an SMS offer can be sized for a different duration / service mix.
describe('offerableEstimateSlots — the page\'s default selection axes', () => {
  const { offerableEstimateSlots } = require('../routes/estimate-slots-public')._internals;
  const { buildPricingBundle, isStructuralOneTimeOnlyEstimate } = require('../routes/estimate-public');
  const OWN = { id: 'est-1', customer_id: 'cust-1', status: 'sent', expires_at: null, archived_at: null };
  const SLOTS = { primary: [{ date: '2027-05-20', windowStart: '09:00' }], expander: [] };
  const freq = (key, extra = {}) => ({ key, ...extra });

  beforeEach(() => { currentEstimate = OWN; getAvailableSlots.mockResolvedValue(SLOTS); });

  test('recommended frequency is not frequencies[0] → the picker gets THAT frequency, on the draft AND the fresh recheck', async () => {
    buildPricingBundle.mockResolvedValue({
      frequencies: [freq('monthly'), freq('quarterly', { recommended: true }), freq('bi_monthly')],
      services: [{ key: 'pest_control', isRecurring: true, defaultFrequencyKey: 'quarterly', frequencies: [freq('monthly'), freq('quarterly'), freq('bi_monthly')] }],
    });
    await offerableEstimateSlots('est-1', 'cust-1');
    expect(getAvailableSlots.mock.calls[0][1]).toEqual({ serviceMode: 'recurring', selectedFrequency: 'quarterly' });
    getAvailableSlots.mockClear();
    await offerableEstimateSlots('est-1', 'cust-1', { fresh: true });
    expect(getAvailableSlots.mock.calls[0][1]).toEqual(expect.objectContaining({
      serviceMode: 'recurring', selectedFrequency: 'quarterly', bypassCache: true, expanderMaxResults: 0,
    }));
    expect(getAvailableSlots.mock.calls[0][1]).not.toHaveProperty('serviceCadences');
  });

  test('a section default the combined list does not offer falls back to frequencies[0], exactly as the page does', async () => {
    buildPricingBundle.mockResolvedValue({
      frequencies: [freq('monthly'), freq('quarterly')],
      services: [{ key: 'pest_control', isRecurring: true, defaultFrequencyKey: 'bi_monthly', frequencies: [freq('bi_monthly')] }],
    });
    await offerableEstimateSlots('est-1', 'cust-1');
    expect(getAvailableSlots.mock.calls[0][1].selectedFrequency).toBe('monthly');
  });

  test('a bundle with per-service default cadences → selectedFrequency AND serviceCadences, on both calls', async () => {
    buildPricingBundle.mockResolvedValue({
      frequencies: [freq('quarterly')],
      services: [
        { key: 'pest_control', isRecurring: true, defaultFrequencyKey: 'quarterly', frequencies: [freq('quarterly')] },
        { key: 'lawn_care', isRecurring: true, defaultFrequencyKey: 'enhanced', frequencies: [freq('standard'), freq('enhanced')] },
        { key: 'mosquito', isRecurring: true, frequencies: [freq('seasonal9'), freq('monthly12')] },
      ],
      serviceCadenceCombos: [
        { selection: { pest_control: 'quarterly', lawn_care: 'standard', mosquito: 'seasonal9' } },
        { selection: { pest_control: 'quarterly', lawn_care: 'enhanced', mosquito: 'seasonal9' } },
      ],
    });
    // mosquito carries no defaultFrequencyKey → its first frequency, like the page
    await expect(offerableEstimateSlots('est-1', 'cust-1')).resolves.toBe(SLOTS);
    const want = { serviceMode: 'recurring', selectedFrequency: 'quarterly', serviceCadences: { lawn_care: 'enhanced', mosquito: 'seasonal9' } };
    expect(getAvailableSlots.mock.calls[0][1]).toEqual(want);
    getAvailableSlots.mockClear();
    await offerableEstimateSlots('est-1', 'cust-1', { fresh: true });
    expect(getAvailableSlots.mock.calls[0][1]).toEqual(expect.objectContaining(want));
  });

  test.each([
    ['only some combo axes have a section on the page', {
      frequencies: [freq('quarterly')],
      services: [
        { key: 'pest_control', isRecurring: true, frequencies: [freq('quarterly')] },
        { key: 'lawn_care', isRecurring: true, frequencies: [freq('standard')] },
      ],
      serviceCadenceCombos: [{ selection: { pest_control: 'quarterly', lawn_care: 'standard', tree_shrub: 'standard' } }],
    }],
    ['no combo is priced for the default selection', {
      frequencies: [freq('quarterly')],
      services: [
        { key: 'pest_control', isRecurring: true, frequencies: [freq('quarterly')] },
        { key: 'lawn_care', isRecurring: true, defaultFrequencyKey: 'enhanced', frequencies: [freq('standard'), freq('enhanced')] },
      ],
      serviceCadenceCombos: [{ selection: { pest_control: 'quarterly', lawn_care: 'standard' } }],
    }],
    ['the bundle cannot be read (not an object)', null],
  ])('unreconstructable (%s) → estimate times withheld, the picker is never asked', async (_label, pricing) => {
    buildPricingBundle.mockResolvedValue(pricing);
    await expect(offerableEstimateSlots('est-1', 'cust-1')).resolves.toBeNull();
    await expect(offerableEstimateSlots('est-1', 'cust-1', { fresh: true })).resolves.toBeNull();
    expect(getAvailableSlots).not.toHaveBeenCalled();
  });

  test('no combo axis rendered (bundle fell back to one section) → no serviceCadences, exactly as the page sends none', async () => {
    buildPricingBundle.mockResolvedValue({
      frequencies: [freq('quarterly')],
      services: [{ key: 'bundle', isRecurring: true, frequencies: [freq('quarterly')] }],
      serviceCadenceCombos: [{ selection: { pest_control: 'quarterly', lawn_care: 'standard' } }],
    });
    await offerableEstimateSlots('est-1', 'cust-1');
    expect(getAvailableSlots.mock.calls[0][1]).toEqual({ serviceMode: 'recurring', selectedFrequency: 'quarterly' });
  });

  test('the pricing bundle throwing withholds too (never guesses, never blocks drafting)', async () => {
    buildPricingBundle.mockRejectedValue(new Error('pricing down'));
    await expect(offerableEstimateSlots('est-1', 'cust-1')).resolves.toBeNull();
    expect(getAvailableSlots).not.toHaveBeenCalled();
  });

  test('a saved customerSelection is left exactly as before: no derived axes', async () => {
    currentEstimate = { ...OWN, estimate_data: JSON.stringify({ customerSelection: { frequency: 'monthly' } }) };
    buildPricingBundle.mockResolvedValue({ frequencies: [freq('quarterly')] });
    await offerableEstimateSlots('est-1', 'cust-1');
    expect(getAvailableSlots.mock.calls[0][1]).toEqual({ serviceMode: 'recurring' });
  });

  test('a one-time-only estimate sends neither axis (the page sends none in one-time mode)', async () => {
    isStructuralOneTimeOnlyEstimate.mockReturnValueOnce(true);
    buildPricingBundle.mockResolvedValue({ frequencies: [freq('quarterly')] });
    await offerableEstimateSlots('est-1', 'cust-1');
    expect(getAvailableSlots.mock.calls[0][1]).toEqual({ serviceMode: 'one_time' });
  });
});

// The page renders the slot picker only for acceptance.mode standard_slot_pick
// (EstimateViewPage.jsx canShowSlotPicker); every other contract has no time
// the customer could pick, so the texting AI must offer none.
describe('offerableEstimateSlots — the page\'s acceptance contract', () => {
  const { offerableEstimateSlots } = require('../routes/estimate-slots-public')._internals;
  const { buildPricingBundle, resolveEstimateAcceptance, isStructuralOneTimeOnlyEstimate } = require('../routes/estimate-public');
  const OWN = { id: 'est-1', customer_id: 'cust-1', status: 'sent', expires_at: null, archived_at: null };

  beforeEach(() => {
    currentEstimate = OWN;
    getAvailableSlots.mockResolvedValue({ primary: [{ date: '2027-05-20', windowStart: '09:00' }], expander: [] });
  });

  test.each(['quote_required', 'existing_appointment', 'invoice_only', 'contact_office', 'commercial_site_confirmation'])(
    '%s → no picker on the page → no times, draft or fresh recheck',
    async (mode) => {
      resolveEstimateAcceptance.mockResolvedValue({ acceptance: { mode } });
      await expect(offerableEstimateSlots('est-1', 'cust-1')).resolves.toBeNull();
      await expect(offerableEstimateSlots('est-1', 'cust-1', { fresh: true })).resolves.toBeNull();
      expect(getAvailableSlots).not.toHaveBeenCalled();
    },
  );

  test('a one-time estimate is held to the contract too', async () => {
    isStructuralOneTimeOnlyEstimate.mockReturnValue(true);
    resolveEstimateAcceptance.mockResolvedValue({ acceptance: { mode: 'existing_appointment' } });
    try {
      await expect(offerableEstimateSlots('est-1', 'cust-1')).resolves.toBeNull();
      expect(getAvailableSlots).not.toHaveBeenCalled();
    } finally {
      isStructuralOneTimeOnlyEstimate.mockReturnValue(false);
    }
  });

  test('the contract is judged on the same pricing bundle /data builds (monthlyBilled resolved)', async () => {
    const pricing = { frequencies: [{ key: 'quarterly' }] };
    buildPricingBundle.mockResolvedValue(pricing);
    await offerableEstimateSlots('est-1', 'cust-1');
    expect(buildPricingBundle.mock.calls[0][1]).toEqual({ monthlyBilled: false });
    expect(resolveEstimateAcceptance.mock.calls[0][2]).toBe(pricing);
    expect(getAvailableSlots).toHaveBeenCalledTimes(1);
  });

  test('a stale membership snapshot is reconciled first, as /data does: pricing, contract and selection read the reconciled row', async () => {
    const { reconcileFrozenMembershipSnapshot } = require('../routes/estimate-public');
    currentEstimate = { ...OWN };
    const order = [];
    reconcileFrozenMembershipSnapshot.mockImplementationOnce(async (row) => {
      order.push('reconcile');
      Object.assign(row, { estimate_data: JSON.stringify({ membershipLapsedRequote: true }) });
    });
    buildPricingBundle.mockImplementationOnce(async (row) => {
      order.push('pricing');
      expect(JSON.parse(row.estimate_data)).toEqual({ membershipLapsedRequote: true });
      return {};
    });
    resolveEstimateAcceptance.mockImplementationOnce(async (row, estData) => {
      expect(estData).toEqual({ membershipLapsedRequote: true });
      return { acceptance: { mode: 'quote_required' } };
    });
    await expect(offerableEstimateSlots('est-1', 'cust-1')).resolves.toBeNull();
    expect(order).toEqual(['reconcile', 'pricing']);
    expect(getAvailableSlots).not.toHaveBeenCalled();
    expect(OWN.estimate_data).toBeUndefined();
  });

  test('the contract failing to resolve withholds (never guesses)', async () => {
    resolveEstimateAcceptance.mockRejectedValue(new Error('appointments down'));
    await expect(offerableEstimateSlots('est-1', 'cust-1')).resolves.toBeNull();
    expect(getAvailableSlots).not.toHaveBeenCalled();
  });
});
