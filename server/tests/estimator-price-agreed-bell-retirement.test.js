/**
 * codex #4815 r3 P1: retirePriceAgreedEstimatorBell (call-recording-processor.js)
 * decides how to retire the earlier engine's "draft ready" bell (or the
 * deduped generic quote-promised bell) once a price_agreed_on_call
 * invalidation runs. Two bugs this pins:
 *
 *   1. It used to fire even when NOTHING was actually invalidated
 *      (invalidated:false — a fresh pass with no existing draft), falsely
 *      telling staff a draft was retired that never existed.
 *   2. It used to unconditionally say "No quote is owed" and set
 *      quote_promised:false, even when the call ALSO had a genuinely
 *      promised written quote (quotePromised:true) — silently clearing a
 *      real obligation and defeating quotePromisedAlreadyNotified's own
 *      metadata->>'quote_promised' = 'true' dedupe downstream.
 *
 * Mocks the whole estimator-engine module (its own notify() dedupe/
 * updateOnly behavior is separately covered end to end in
 * estimator-notify-update-only.test.js) so this test targets exactly the
 * DECISION — what gets passed to notify() and when it's skipped entirely.
 *
 * Fixtures fictitious (call-1); no real customer data.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/twilio-numbers', () => ({
  isInternalNumber: jest.fn(() => false),
  isOwnedNumber: jest.fn(() => false),
  findByNumber: jest.fn(() => null),
  getLeadSourceFromNumber: jest.fn(() => ({ source: 'phone_call' })),
}));

const mockNotify = jest.fn(async () => true);
// codex #4815 r8 P2: the bell's own state — null (no stale bell) unless a
// test says otherwise, so every pre-r8 test sees exactly the old behavior.
const mockStaleDraftBell = jest.fn(async () => null);
jest.mock('../services/estimator-engine', () => ({
  notify: (...args) => mockNotify(...args),
  staleDraftBellForCall: (...args) => mockStaleDraftBell(...args),
}));

const { _test } = require('../services/call-recording-processor');
const { retirePriceAgreedEstimatorBell } = _test;

const CALL = { id: 'call-1', twilio_call_sid: 'CA-price-agreed-1' };

function args(overrides = {}) {
  return {
    call: CALL,
    callSid: CALL.twilio_call_sid,
    callerName: 'Jane Doe',
    callAgreedPrice: { amount: 300 },
    callQuotePromised: false,
    invalidated: true,
    customerId: 'cust-1',
    logPrefix: 'test',
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockNotify.mockResolvedValue(true);
  mockStaleDraftBell.mockResolvedValue(null);
});

describe('retirePriceAgreedEstimatorBell', () => {
  test('promised + draft invalidated: keeps quote_promised TRUE, drops the estimate link, keeps the send-it instruction — never says "no quote is owed"', async () => {
    await retirePriceAgreedEstimatorBell(args({ callQuotePromised: true, invalidated: true }));

    expect(mockNotify).toHaveBeenCalledTimes(1);
    const call = mockNotify.mock.calls[0][0];
    expect(call.quotePromised).toBe(true);
    expect(call.estimateId).toBeNull();
    expect(call.body).toMatch(/written quote/i);
    expect(call.body).not.toMatch(/no quote is owed/i);
    expect(call.forceUpdate).toBe(true);
    expect(call.updateOnly).toBe(true);
    // codex #4815 r9 P2: the rewrite targets the bell(s) advertising the
    // draft the agreed price retired, not merely the newest bell.
    expect(call.retiredByReason).toBe('price_agreed_on_call');
  });

  test('promised + NO draft invalidated: never calls notify — nothing was actually retired', async () => {
    await retirePriceAgreedEstimatorBell(args({ callQuotePromised: true, invalidated: false }));

    expect(mockNotify).not.toHaveBeenCalled();
  });

  test('not-promised + draft invalidated: quote_promised FALSE, "No quote is owed" body (existing/unchanged behavior)', async () => {
    await retirePriceAgreedEstimatorBell(args({ callQuotePromised: false, invalidated: true }));

    expect(mockNotify).toHaveBeenCalledTimes(1);
    const call = mockNotify.mock.calls[0][0];
    expect(call.quotePromised).toBe(false);
    expect(call.body).toMatch(/No quote is owed/);
    expect(call.estimateId).toBeNull();
  });

  test('not-promised + NO draft invalidated: never calls notify', async () => {
    await retirePriceAgreedEstimatorBell(args({ callQuotePromised: false, invalidated: false }));

    expect(mockNotify).not.toHaveBeenCalled();
  });

  test('a falsy invalidated (undefined) is treated the same as false — never calls notify', async () => {
    await retirePriceAgreedEstimatorBell(args({ invalidated: undefined }));
    expect(mockNotify).not.toHaveBeenCalled();
  });

  test('a genuine RANGE price is reported as a range in the body, never collapsed to the low end', async () => {
    await retirePriceAgreedEstimatorBell(args({ callAgreedPrice: { amount: 90, amountMax: 100 } }));

    const call = mockNotify.mock.calls[0][0];
    expect(call.body).toContain('$90.00–$100.00');
  });

  test('link falls back to /admin/communications with no customerId', async () => {
    await retirePriceAgreedEstimatorBell(args({ customerId: null }));
    expect(mockNotify.mock.calls[0][0].link).toBe('/admin/communications');
  });

  test('a notify failure is caught and logged, never thrown', async () => {
    mockNotify.mockRejectedValueOnce(new Error('boom'));
    await expect(retirePriceAgreedEstimatorBell(args())).resolves.toBeUndefined();
  });

  // codex #4815 r8 P2: a retirement whose notification update failed
  // transiently was never retried — later reprocesses see the draft already
  // stamped (invalidated:false) and returned early, leaving the stale
  // "draft ready" bell, amount and link forever. The retry keys on the
  // BELL's own state instead.
  describe('retry from the bell\'s own state (codex #4815 r8 P2)', () => {
    test('invalidated:false BUT the live bell still points at a draft the agreed price retired → the bell is retired', async () => {
      mockStaleDraftBell.mockResolvedValue('est-stale');
      await retirePriceAgreedEstimatorBell(args({ invalidated: false }));
      expect(mockStaleDraftBell).toHaveBeenCalledWith('CA-price-agreed-1', { reason: 'price_agreed_on_call' });
      expect(mockNotify).toHaveBeenCalledTimes(1);
      const call = mockNotify.mock.calls[0][0];
      expect(call.estimateId).toBeNull();
      expect(call.forceUpdate).toBe(true);
      expect(call.updateOnly).toBe(true);
    });

    test('a failed first retirement is retried on the next pass, then stops once the bell no longer references the draft', async () => {
      mockNotify.mockResolvedValueOnce(false); // the transient update failure
      await retirePriceAgreedEstimatorBell(args({ invalidated: true }));
      mockStaleDraftBell.mockResolvedValueOnce('est-stale'); // still stale on the reprocess
      await retirePriceAgreedEstimatorBell(args({ invalidated: false }));
      expect(mockNotify).toHaveBeenCalledTimes(2);
      mockStaleDraftBell.mockResolvedValueOnce(null); // retired now — idempotent
      await retirePriceAgreedEstimatorBell(args({ invalidated: false }));
      expect(mockNotify).toHaveBeenCalledTimes(2);
    });

    test('a stale-bell lookup failure never retires anything and never throws', async () => {
      mockStaleDraftBell.mockRejectedValueOnce(new Error('db down'));
      await expect(retirePriceAgreedEstimatorBell(args({ invalidated: false }))).resolves.toBeUndefined();
      expect(mockNotify).not.toHaveBeenCalled();
    });

    test('a NEWLY invalidating pass never needs the lookup', async () => {
      await retirePriceAgreedEstimatorBell(args({ invalidated: true }));
      expect(mockStaleDraftBell).not.toHaveBeenCalled();
      expect(mockNotify).toHaveBeenCalledTimes(1);
    });
  });
});
