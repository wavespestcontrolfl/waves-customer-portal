/**
 * callback_number_needed hold at the canonical sender — keyed on the
 * DESTINATION NUMBER (codex round 6 on PR #4807, structural).
 *
 * Rounds 2–5 keyed this chokepoint on visit metadata (appointmentId /
 * metadata.scheduled_service_id / metadata.visit_id) and each round found a
 * sender with none: estimate and invoice follow-ups text customers.phone —
 * for a call-created customer, the very number the caller disclaimed —
 * carrying only an estimate/invoice id (round-6 P1 #1). The check now reads
 * disclaimed_number_holds for the send's own `to`, for EVERY SMS.
 *
 * Round-6 P1 #2: step 6.45 runs before preDispatchCheck and the provider's
 * own async preparation — a hold committed in between must still stop the
 * send, so the same predicate is re-run inside providerPreparationCheck
 * (the preSendCheck hook the provider awaits immediately before
 * messages.create()), exactly like the move-hold guard.
 *
 * disclaimed-number-holds.js's own row/normalization/fail-closed behavior is
 * covered by callback-number-hold-boundary.test.js; this file tests the
 * WIRING: which sends consult the predicate, with what, and what the block
 * looks like at each point.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => {
  const actual = jest.requireActual('../config/feature-gates');
  return { ...actual, isEnabled: jest.fn(() => false) };
});
jest.mock('../services/messaging/validators/consent', () => ({
  loadContactState: jest.fn(async () => ({})),
  checkConsentForPurpose: jest.fn(() => ({ ok: true })),
}));
jest.mock('../services/messaging/validators/suppression', () => ({
  loadSuppressionState: jest.fn(async (_input, contactState) => contactState),
  checkSuppression: jest.fn(() => ({ ok: true })),
}));
jest.mock('../services/messaging/validators/line-type', () => ({
  checkLineType: jest.fn(() => ({ ok: true })),
}));
jest.mock('../services/messaging/validators/identity', () => ({
  validateRequiredIds: jest.fn(() => ({ ok: true })),
  validateIdentityTrust: jest.fn(() => ({ ok: true })),
  resolveTrustLevel: jest.fn(() => 'phone_matches_customer'),
}));
jest.mock('../services/messaging/validators/voice', () => ({
  validateNoCustomerEmoji: jest.fn(() => ({ ok: true })),
}));
jest.mock('../services/messaging/compliance-contact-checks', () => ({
  checkContactCompliance: jest.fn(() => ({ ok: true })),
}));
jest.mock('../services/messaging/audit', () => ({
  persistAudit: jest.fn(async () => ({ id: 'audit-1' })),
}));
jest.mock('../services/messaging/providers/twilio-sms', () => ({
  sendViaTwilio: jest.fn(async () => ({ sent: true, deliveryOutcome: 'accepted', providerMessageId: 'SM-real' })),
  mapPurposeToMessageType: jest.fn(() => 'manual'),
}));
jest.mock('../services/estimate-annual-guard', () => ({
  annualHandoffGuard: jest.fn(() => async () => ({ blocked: false, reason: null, estimateId: null })),
  rewriteWithheldEstimateLinks: jest.fn(async ({ text }) => ({ html: undefined, text, rewrittenIds: [] })),
  withheldLinkPolicyForSmsPurpose: jest.fn(() => 'refuse'),
}));
jest.mock('../services/disclaimed-number-holds', () => ({
  disclaimedNumberBlocksSend: jest.fn(async () => false),
}));

const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { persistAudit } = require('../services/messaging/audit');
const { sendViaTwilio } = require('../services/messaging/providers/twilio-sms');
const { disclaimedNumberBlocksSend } = require('../services/disclaimed-number-holds');

const BASE_INPUT = {
  to: '+19415550142',
  body: 'Your tech is on the way.',
  channel: 'sms',
  audience: 'customer',
  customerId: 'cust-1',
  purpose: 'tech_en_route',
};

beforeEach(() => {
  jest.clearAllMocks();
  sendViaTwilio.mockResolvedValue({ sent: true, deliveryOutcome: 'accepted', providerMessageId: 'SM-real' });
  persistAudit.mockResolvedValue({ id: 'audit-1' });
  disclaimedNumberBlocksSend.mockResolvedValue(false);
});

const expectAuditedHold = (validator) => expect(persistAudit).toHaveBeenCalledWith(expect.objectContaining({
  validatorsFailed: [validator],
  blockedBy: { code: 'CALLBACK_NUMBER_HOLD', reason: 'Caller disclaimed this number (callback_number_needed)' },
}));

describe('round-6 P1 #1 — every SMS is checked by destination number, visit metadata or not', () => {
  test('an estimate follow-up (estimate id only, no visit) to a disclaimed number is blocked — no provider call, audited, retryable', async () => {
    disclaimedNumberBlocksSend.mockResolvedValueOnce(true);
    const result = await sendCustomerMessage({
      ...BASE_INPUT, purpose: 'estimate_followup', estimateId: 'est-1', body: 'Following up on your estimate.',
    });
    expect(result).toMatchObject({
      sent: false, blocked: true, deliveryOutcome: 'not_sent', code: 'CALLBACK_NUMBER_HOLD', retryable: true,
    });
    expect(disclaimedNumberBlocksSend).toHaveBeenCalledWith({ to: '+19415550142' });
    expect(sendViaTwilio).not.toHaveBeenCalled();
    expectAuditedHold('callback_number_hold');
  });

  test('an invoice follow-up (invoice id only) to a disclaimed number is blocked the same way', async () => {
    disclaimedNumberBlocksSend.mockResolvedValueOnce(true);
    const result = await sendCustomerMessage({
      ...BASE_INPUT, purpose: 'payment_link', invoiceId: 'inv-1', body: 'Your invoice is ready.',
    });
    expect(result).toMatchObject({ sent: false, blocked: true, code: 'CALLBACK_NUMBER_HOLD', retryable: true });
    expect(sendViaTwilio).not.toHaveBeenCalled();
  });

  test('the key is the normalized destination the provider would dial, not any visit id', async () => {
    disclaimedNumberBlocksSend.mockResolvedValueOnce(true);
    await sendCustomerMessage({ ...BASE_INPUT, to: '(941) 555-0142', appointmentId: 'svc-1' });
    expect(disclaimedNumberBlocksSend).toHaveBeenCalledWith({ to: '+19415550142' });
  });

  test('not held → dispatches normally', async () => {
    const result = await sendCustomerMessage({ ...BASE_INPUT, purpose: 'estimate_followup', estimateId: 'est-1' });
    expect(result.sent).toBe(true);
    expect(sendViaTwilio).toHaveBeenCalledTimes(1);
  });

  test('push channel (App routing) never consults the hold — the disclaimed number is never dialed', async () => {
    await sendCustomerMessage({ ...BASE_INPUT, channel: 'push', appointmentId: 'svc-1' });
    expect(disclaimedNumberBlocksSend).not.toHaveBeenCalled();
  });
});

describe('round-6 P1 #2 — re-checked at the provider boundary (providerPreparationCheck)', () => {
  // Real Twilio awaits the preSendCheck hook immediately before
  // messages.create(); the mock does the same so the boundary runs.
  const runViaProviderHook = () => sendViaTwilio.mockImplementationOnce(async (_providerInput, hooks) => {
    const verdict = await hooks.preSendCheck();
    if (!verdict.ok) return { sent: false, provider: 'twilio', deliveryOutcome: 'not_sent' };
    return { sent: true, provider: 'twilio', deliveryOutcome: 'accepted', providerMessageId: 'SM-real' };
  });

  test('a hold committed AFTER step 6.45 (during preDispatchCheck / provider preparation) still stops the send at the handoff', async () => {
    // 6.45 sees no hold; by the time the provider calls its preSendCheck,
    // the call pipeline's booking transaction has committed one.
    disclaimedNumberBlocksSend.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    runViaProviderHook();
    const result = await sendCustomerMessage({
      ...BASE_INPUT, purpose: 'estimate_followup', estimateId: 'est-1',
      preDispatchCheck: async () => ({ ok: true }),
    });
    expect(result).toMatchObject({
      sent: false, blocked: true, deliveryOutcome: 'not_sent', code: 'CALLBACK_NUMBER_HOLD', retryable: true,
    });
    expect(disclaimedNumberBlocksSend).toHaveBeenCalledTimes(2);
    expectAuditedHold('callback_number_hold_boundary');
  });

  test('no hold at either point → the provider hook passes and the send goes out', async () => {
    runViaProviderHook();
    const result = await sendCustomerMessage({ ...BASE_INPUT, purpose: 'estimate_followup', estimateId: 'est-1' });
    expect(result.sent).toBe(true);
    expect(disclaimedNumberBlocksSend).toHaveBeenCalledTimes(2);
  });
});
