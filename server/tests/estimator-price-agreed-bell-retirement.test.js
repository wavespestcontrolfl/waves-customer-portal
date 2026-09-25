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
jest.mock('../services/estimator-engine', () => ({ notify: (...args) => mockNotify(...args) }));

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
});
