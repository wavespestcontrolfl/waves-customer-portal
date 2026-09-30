/**
 * Collections DISPUTE hold at the FINAL SMS/App provider boundary (Codex round 11 P1, structural).
 *
 * The gated billing-follow-up check (billingHoldBlock: purpose / dunning entry-point gate, the
 * customerInitiated and holdExempt exemptions, fail closed) runs at step 1.5 AND again inside
 * providerPreparationCheck - the last pre-provider callback the provider awaits right before
 * messages.create(). A dispute committed after step 1.5 (during policy / contact / consent /
 * caller checks) must therefore still stop the send there, with the same coded WAIT outcome.
 * Synthetic data only; the provider is a stub that runs the real hook.
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

jest.mock('../services/collections/collection-hold', () => {
  const actual = jest.requireActual('../services/collections/collection-hold');
  return { ...actual, messagingHeldByCollectionHold: jest.fn(async () => ({ held: false })) };
});

const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { persistAudit } = require('../services/messaging/audit');
const { sendViaTwilio } = require('../services/messaging/providers/twilio-sms');
const { disclaimedNumberBlocksSend } = require('../services/disclaimed-number-holds');
const Hold = require('../services/collections/collection-hold');

const BASE_INPUT = {
  to: '+19415550142',
  body: 'Your payment failed. Update your card: https://portal.example.test/billing',
  channel: 'sms',
  audience: 'customer',
  customerId: 'cust-1',
  purpose: 'payment_failure',
  entryPoint: 'monthly_billing_failure',
};

beforeEach(() => {
  jest.clearAllMocks();
  persistAudit.mockResolvedValue({ id: 'audit-1' });
  disclaimedNumberBlocksSend.mockResolvedValue(false);
  Hold.messagingHeldByCollectionHold.mockResolvedValue({ held: false });
  // Real Twilio awaits the preSendCheck hook immediately before messages.create().
  sendViaTwilio.mockImplementation(async (_input, hooks) => {
    const verdict = await hooks.preSendCheck();
    if (!verdict.ok) return { sent: false, provider: 'twilio', deliveryOutcome: 'not_sent' };
    return { sent: true, provider: 'twilio', deliveryOutcome: 'accepted', providerMessageId: 'SM-real' };
  });
});

describe('the hold is re-checked in providerPreparationCheck', () => {
  test('a hold committed AFTER step 1.5 stops a gated payment_failure text at the provider boundary, coded and audited', async () => {
    Hold.messagingHeldByCollectionHold.mockResolvedValueOnce({ held: false }).mockResolvedValueOnce({ held: true, reason: 'hold' });
    const result = await sendCustomerMessage({ ...BASE_INPUT });
    expect(result).toMatchObject({ sent: false, blocked: true, deliveryOutcome: 'not_sent', code: 'COLLECTION_HOLD_SUPPRESSED' });
    expect(Hold.messagingHeldByCollectionHold).toHaveBeenCalledTimes(2);
    expect(persistAudit).toHaveBeenCalledWith(expect.objectContaining({
      validatorsFailed: ['collection_hold_boundary'],
      blockedBy: expect.objectContaining({ code: 'COLLECTION_HOLD_SUPPRESSED' }),
    }));
  });

  test('a lookup failure at the boundary fails closed the same way', async () => {
    Hold.messagingHeldByCollectionHold.mockResolvedValueOnce({ held: false })
      .mockResolvedValueOnce({ held: true, reason: 'lookup_failed', error: new Error('db down') });
    expect(await sendCustomerMessage({ ...BASE_INPUT })).toMatchObject({ sent: false, blocked: true, code: 'COLLECTION_HOLD_SUPPRESSED' });
  });

  test('the machine-initiated dunning entry points (shared purposes) are gated at the boundary too', async () => {
    Hold.messagingHeldByCollectionHold.mockResolvedValueOnce({ held: false }).mockResolvedValueOnce({ held: true, reason: 'hold' });
    const result = await sendCustomerMessage({ ...BASE_INPUT, purpose: 'payment_link', entryPoint: 'invoice_followup_sequence' });
    expect(result).toMatchObject({ sent: false, blocked: true, code: 'COLLECTION_HOLD_SUPPRESSED' });
  });

  // A realistic predicate: a trusted exemption (ignoreDisputeHold) skips a plain DISPUTE row only; a
  // wrong-number / wrong-party FALLBACK row always holds (Codex #5424 r13).
  const holdKind = (kind) => Hold.messagingHeldByCollectionHold.mockImplementation(async (_id, _db, opts = {}) => (
    opts.ignoreDisputeHold && kind === 'dispute' ? { held: false } : { held: true, reason: 'hold' }));

  test.each([
    ['customerInitiated', { customerInitiated: true }],
    ['holdExempt customer', { holdExempt: 'customer' }],
    ['holdExempt operator', { holdExempt: 'operator' }],
  ])('%s skips a plain DISPUTE hold at both points (ignoreDisputeHold), the send goes out', async (_label, extra) => {
    holdKind('dispute');
    const result = await sendCustomerMessage({ ...BASE_INPUT, ...extra });
    expect(result.sent).toBe(true);
    expect(Hold.messagingHeldByCollectionHold).toHaveBeenCalledTimes(2);
    for (const call of Hold.messagingHeldByCollectionHold.mock.calls) expect(call[2]).toEqual({ ignoreDisputeHold: true });
  });

  test.each([
    ['customerInitiated', { customerInitiated: true }],
    ['holdExempt customer', { holdExempt: 'customer' }],
    ['holdExempt operator', { holdExempt: 'operator' }],
  ])('%s is NOT exempt from a wrong-number / wrong-party FALLBACK hold: the send waits, coded', async (_label, extra) => {
    holdKind('fallback');
    const result = await sendCustomerMessage({ ...BASE_INPUT, ...extra });
    expect(result).toMatchObject({ sent: false, blocked: true, code: 'COLLECTION_HOLD_SUPPRESSED' });
    expect(sendViaTwilio).not.toHaveBeenCalled();
  });

  test('the boundary re-read REUSES the provider handoff connection (handoffDb), never a root-pool read (Codex #5424 r13 P1)', async () => {
    const handoffTrx = { isTransaction: true, name: 'handoff-trx' };
    sendViaTwilio.mockImplementation(async (_input, hooks) => {
      const verdict = await hooks.preSendCheck({ database: handoffTrx });
      if (!verdict.ok) return { sent: false, provider: 'twilio', deliveryOutcome: 'not_sent' };
      return { sent: true, provider: 'twilio', deliveryOutcome: 'accepted', providerMessageId: 'SM-real' };
    });
    const result = await sendCustomerMessage({ ...BASE_INPUT });
    expect(result.sent).toBe(true);
    const calls = Hold.messagingHeldByCollectionHold.mock.calls;
    expect(calls).toHaveLength(2);
    // step 1.5 runs before any handoff exists: the root pool. The FINAL read is on the held handle.
    expect(calls[0][1]).toBeUndefined();
    expect(calls[1][1]).toBe(handoffTrx);
  });

  test('a non-gated purpose never reads the hold, at either point', async () => {
    Hold.messagingHeldByCollectionHold.mockResolvedValue({ held: true, reason: 'hold' });
    const result = await sendCustomerMessage({ ...BASE_INPUT, purpose: 'tech_en_route', entryPoint: 'tech_en_route' });
    expect(result.sent).toBe(true);
    expect(Hold.messagingHeldByCollectionHold).not.toHaveBeenCalled();
  });

  test('no hold at either point: the boundary passes and the notice goes out (two reads)', async () => {
    const result = await sendCustomerMessage({ ...BASE_INPUT });
    expect(result.sent).toBe(true);
    expect(Hold.messagingHeldByCollectionHold).toHaveBeenCalledTimes(2);
  });
});
