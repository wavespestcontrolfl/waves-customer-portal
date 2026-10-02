/**
 * Auto-send money send-time recheck (pre-push audit P1, finding 2; owner ruling 2026-10-01 ~23:58Z: the money-sentence contract).
 * Same harness as sms-auto-send-open-times.test.js: full maybeAutoSend round trip with the DB and provider mocked, exercising
 * claimAutoSend's threading of zelleInvoiceId / the payment-status snapshot onto the claim and dispatchClaimedSend's pre-send recheck
 * (autoSendBillingRecheck) - the auto-send choke point, distinct from the /sms and /schedule-sms choke point
 * (agent-decision-send-checks.js) and the scheduler's queued-send fire-time recheck, which cover the same facts via the same
 * sms-amount-recheck.js primitives. A real-answers (v12) reply is judged by the contract only (paymentStatusVerdict, which re-renders a
 * copied Zelle sentence from the live Zelle facts); an older prompt's reply that mentions Zelle takes the staff-contact path
 * (outgoingAmountsStale with trustOwedAmounts).
 */
jest.mock('../models/db', () => {
  const db = jest.fn((table) => db.trx(table));
  db.transaction = jest.fn(async (work) => work(db.trx));
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true) }));
jest.mock('../services/sms-suggest-mode', () => ({
  suggestionEligible: jest.fn(() => true), getIntentMode: jest.fn(async () => 'auto_send'),
  hasRedactionPlaceholder: jest.fn(() => false), hasPriceQuote: jest.fn(() => false),
  lockSuggestThread: jest.fn(async () => {}), threadHasLiveAnswer: jest.fn(async () => null),
  parkThreadSuggestions: jest.fn(async () => ['parked-1']),
  createReplyHoldingReservation: jest.fn(async () => '33333333-3333-4333-8333-333333333333'),
  settleReplyHoldingReservation: jest.fn(async () => true),
  reopenScheduledSuggestions: jest.fn(async () => 1),
  ignoreParkedSuggestions: jest.fn(async () => 1),
}));
jest.mock('../services/sms-shadow-drafter', () => ({
  reserviceBookedReferenceBlock: jest.fn(async () => null),
  resolveEffectiveVoiceProfile: jest.fn(async () => ({ version: null })),
  openTimesStillOffered: jest.fn(async () => ({ ok: true })),
  // LIVE ETA send-time recheck (PR #5334) runs on every dispatchClaimedSend call - "never claims an ETA" here, so it never
  // reaches the DB/track-transitions leg (see sms-auto-send-open-times.test.js, sms-eta-freshness.test.js).
  findEtaMinutesClaims: jest.fn(() => []),
  bodyMentionsArrival: jest.fn(() => false),
  bodyMentionsVisitStatus: jest.fn(() => false),
  bodyHasTimedArrivalPhrase: jest.fn(() => false),
  bodyHasUnclassifiedArrivalDigit: jest.fn(() => false),
  findGroundedMinutesFigures: jest.fn(() => []),
}));
jest.mock('../services/sms-graduation', () => ({ evaluateAutoSendEligibility: jest.fn(async () => ({ eligible: true })) }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/sms-amount-recheck', () => ({
  // PR #5331: dispatchClaimedSend's money recheck. v12 replies: the contract verdict { reason, zelle }; older prompts that mention Zelle:
  // the staff-contact path (outgoingAmountsStale). Defaults clean.
  paymentStatusVerdict: jest.fn(async () => ({ reason: null, zelle: null })),
  outgoingAmountsStale: jest.fn(async () => ({ stale: false })),
}));

const db = require('../models/db');
const suggest = require('../services/sms-suggest-mode');
const drafter = require('../services/sms-shadow-drafter');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const amountRecheck = require('../services/sms-amount-recheck');
const autoSend = require('../services/sms-auto-send');
let decisions;

function chain(overrides = {}) {
  const q = {};
  for (const method of ['where', 'whereRaw', 'leftJoin', 'insert', 'onConflict', 'ignore']) q[method] = jest.fn(() => q);
  q.first = jest.fn(async () => null);
  q.returning = jest.fn(async () => [{ id: 'claim-1' }]);
  q.update = jest.fn(async () => 1);
  return Object.assign(q, overrides);
}

// This file tests the DISPATCH-time seams (Zelle / payment-status rechecks) with the amount-recheck module mocked. The READINESS-time rule
// that keeps a payment-scoped v12 reply that is not copy-only off the autonomous rung is covered in sms-auto-send-payment-status.test.js
// and payment-status-contract.test.js; it is switched off here so these cases still reach dispatchClaimedSend with their v12 replies.
let scopeBlockSpy;
beforeEach(() => {
  jest.clearAllMocks();
  scopeBlockSpy = jest.spyOn(require('../services/payment-status-contract'), 'autoSendScopeBlock').mockReturnValue(null);
  const inbound = chain({ first: jest.fn(async () => ({
    created_at: new Date(), from_phone: '+12025550101', to_phone: '+19413529161',
  })) });
  const activeClaim = chain();
  decisions = chain();
  const drafts = chain();
  db.trx = jest.fn((table) => {
    if (table === 'sms_log') return inbound;
    if (table === 'agent_decisions as ad') return activeClaim;
    if (table === 'agent_decisions') return decisions;
    if (table === 'message_drafts') return drafts;
    return chain();
  });
  db.trx.raw = jest.fn(async () => undefined);
  suggest.createReplyHoldingReservation.mockResolvedValue('33333333-3333-4333-8333-333333333333');
  suggest.settleReplyHoldingReservation.mockResolvedValue(true);
  suggest.ignoreParkedSuggestions.mockResolvedValue(1);
  drafter.openTimesStillOffered.mockResolvedValue({ ok: true });
  amountRecheck.paymentStatusVerdict.mockResolvedValue({ reason: null, zelle: null });
  amountRecheck.outgoingAmountsStale.mockResolvedValue({ stale: false });
  sendCustomerMessage.mockResolvedValue({
    sent: true, deliveryOutcome: 'accepted', providerMessageId: `SM${'a'.repeat(32)}`,
  });
});
afterEach(() => { scopeBlockSpy.mockRestore(); });

const attempt = (overrides = {}) => autoSend.maybeAutoSend({
  draftId: '00000000-0000-4000-8000-000000000001', customer: { id: '00000000-0000-4000-8000-000000000002' },
  smsLogId: '00000000-0000-4000-8000-000000000003', inboundMessage: 'How do I pay?',
  reply: 'You can Zelle to payments@wavespestcontrol.com.',
  intent: 'general_customer_sms_needs_review', intendedActions: [], actionsVerifiedSafe: true,
  ...overrides,
});

const V12 = 'house_voice_v12_real_answers5_cflvp';
const CUSTOMER = '00000000-0000-4000-8000-000000000002';
const ZELLE_FACTS = { state: 'offer', invoiceId: 'inv-1', invoiceNumber: 'WPC-2026-0001', recipient: 'payments@wavespestcontrol.com' };

test('a reply that never mentions Zelle (older prompt) triggers no money recheck', async () => {
  await expect(attempt({ reply: 'Sounds good, thanks!' })).resolves.toMatchObject({ sent: true });
  expect(amountRecheck.outgoingAmountsStale).not.toHaveBeenCalled();
  expect(amountRecheck.paymentStatusVerdict).not.toHaveBeenCalled();
  expect(sendCustomerMessage).toHaveBeenCalled();
});

// Older prompts (not v12): a Zelle mention takes the STAFF-CONTACT path - a contact must be the current recipient and the decision's
// target invoice must still take Zelle (outgoingAmountsStale decides; the autonomous rung trusts the owed figures, which it never sends).
describe('older prompt: a Zelle mention takes the staff-contact recheck', () => {
  test('a Zelle reply with a CURRENT recipient and an ELIGIBLE invoice sends normally', async () => {
    amountRecheck.outgoingAmountsStale.mockResolvedValue({ stale: false, zelle: ZELLE_FACTS });
    await expect(attempt({ zelleInvoiceId: 'inv-1', promptVersion: 'house_voice_v11' })).resolves.toMatchObject({ sent: true });
    expect(amountRecheck.outgoingAmountsStale).toHaveBeenCalledWith(expect.objectContaining({
      customerId: CUSTOMER, body: 'You can Zelle to payments@wavespestcontrol.com.', promptVersion: 'house_voice_v11', zelleInvoiceId: 'inv-1',
      inboundMessage: 'How do I pay?', trustOwedAmounts: true,
    }));
    expect(amountRecheck.paymentStatusVerdict).not.toHaveBeenCalled();
    expect(sendCustomerMessage).toHaveBeenCalled();
  });

  test('a contact-free Zelle mention is rechecked too (the verdict is the recheck module\'s)', async () => {
    amountRecheck.outgoingAmountsStale.mockResolvedValue({ stale: true, reason: 'zelle_invoice_ineligible' });
    await expect(attempt({ reply: 'Yes, you can use Zelle.', zelleInvoiceId: 'inv-1', promptVersion: 'house_voice_v11' }))
      .resolves.toMatchObject({ sent: false, reason: 'zelle_invoice_ineligible' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('a stale Zelle recipient blocks the send, fails the claim, reopens parked suggestions', async () => {
    amountRecheck.outgoingAmountsStale.mockResolvedValue({ stale: true, reason: 'zelle_recipient_stale' });
    await expect(attempt({ zelleInvoiceId: 'inv-1', promptVersion: 'house_voice_v11' })).resolves.toMatchObject({ sent: false, reason: 'zelle_recipient_stale' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(decisions.update).toHaveBeenCalledWith(expect.objectContaining({ status: autoSend.FAILED_STATUS }));
    expect(suggest.reopenScheduledSuggestions).toHaveBeenCalledWith(expect.objectContaining({ decisionIds: ['parked-1'] }));
  });

  test('the invoice was paid off / a charge started since the draft blocks the send', async () => {
    amountRecheck.outgoingAmountsStale.mockResolvedValue({ stale: true, reason: 'zelle_invoice_ineligible' });
    await expect(attempt({ zelleInvoiceId: 'inv-1', promptVersion: 'house_voice_v11' })).resolves.toMatchObject({ sent: false, reason: 'zelle_invoice_ineligible' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('no zelleInvoiceId on the claim (missing snapshot) is handed on as null - the recheck fails it closed', async () => {
    amountRecheck.outgoingAmountsStale.mockResolvedValue({ stale: true, reason: 'zelle_invoice_ineligible' });
    await expect(attempt({ promptVersion: 'house_voice_v11' })).resolves.toMatchObject({ sent: false, reason: 'zelle_invoice_ineligible' });
    expect(amountRecheck.outgoingAmountsStale).toHaveBeenCalledWith(expect.objectContaining({ customerId: CUSTOMER, zelleInvoiceId: null }));
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });
});

// PR #5331 (owner ruling 2026-10-01): dispatchClaimedSend's payment-status recheck for real-answers (v12) replies, right
// alongside the Zelle recheck above. A status sentence with no figure ("Your account has no balance due.") clears the
// price-quote guard, so it must be re-rendered from live data before the provider is entered.
describe('payment-status recheck (PR #5331)', () => {
  const SNAP = { customer_id: '00000000-0000-4000-8000-000000000002', sentences: ['Your account has no balance due.'] };
  test('a real-answers reply is rechecked against its snapshot and the customer inbound, and sends when clean', async () => {
    await expect(attempt({ reply: 'Your account has no balance due.', promptVersion: V12, paymentStatusSnapshot: SNAP })).resolves.toMatchObject({ sent: true });
    expect(amountRecheck.paymentStatusVerdict).toHaveBeenCalledWith({
      customerId: '00000000-0000-4000-8000-000000000002', body: 'Your account has no balance due.', snapshot: SNAP, inboundMessage: 'How do I pay?', autoSend: true,
    });
    expect(sendCustomerMessage).toHaveBeenCalled();
  });

  test('a stale / unauthorized status blocks the send, fails the claim, reopens parked suggestions', async () => {
    amountRecheck.paymentStatusVerdict.mockResolvedValue({ reason: 'payment_status_changed', zelle: null });
    await expect(attempt({ reply: 'Your account has no balance due.', promptVersion: V12, paymentStatusSnapshot: SNAP })).resolves.toMatchObject({ sent: false, reason: 'payment_status_changed' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(decisions.update).toHaveBeenCalledWith(expect.objectContaining({ status: autoSend.FAILED_STATUS }));
    expect(suggest.reopenScheduledSuggestions).toHaveBeenCalledWith(expect.objectContaining({ decisionIds: ['parked-1'] }));
  });

  test('a snapshot-less real-answers reply is still rechecked (an unsanctioned status is held by the reply guard)', async () => {
    amountRecheck.paymentStatusVerdict.mockResolvedValue({ reason: 'payment_status_unauthorized', zelle: null });
    await expect(attempt({ reply: "You're paid up!", promptVersion: V12 })).resolves.toMatchObject({ sent: false, reason: 'payment_status_unauthorized' });
    expect(amountRecheck.paymentStatusVerdict).toHaveBeenCalledWith(expect.objectContaining({ snapshot: null }));
  });

  test('a pre-v12 (gate-off) draft is never put through it - byte-identical to main', async () => {
    await expect(attempt({ reply: "You're paid up!", promptVersion: 'house_voice_v11' })).resolves.toMatchObject({ sent: true });
    expect(amountRecheck.paymentStatusVerdict).not.toHaveBeenCalled();
  });

  test('a copied Zelle sentence is judged by the contract ONLY (no staff-contact path)', async () => {
    const SENT = 'You can pay invoice WPC-2026-0001 by Zelle to payments@wavespestcontrol.com, with your name or the invoice number in the Zelle memo.';
    amountRecheck.paymentStatusVerdict.mockResolvedValue({ reason: null, zelle: ZELLE_FACTS });
    await expect(attempt({ reply: SENT, zelleInvoiceId: 'inv-1', promptVersion: V12, paymentStatusSnapshot: { customer_id: CUSTOMER, sentences: [SENT], zelle: { invoice_id: 'inv-1' } } })).resolves.toMatchObject({ sent: true });
    expect(amountRecheck.paymentStatusVerdict).toHaveBeenCalledWith(expect.objectContaining({ body: SENT, autoSend: true }));
    expect(amountRecheck.outgoingAmountsStale).not.toHaveBeenCalled();
    expect(sendCustomerMessage).toHaveBeenCalled();
  });

  test('Zelle prose the draft did not copy (uncopied Zelle in a real-answers reply) is held with the contract\'s reason', async () => {
    amountRecheck.paymentStatusVerdict.mockResolvedValue({ reason: 'payment_status_unauthorized', zelle: null });
    await expect(attempt({ reply: 'Yes, you can use Zelle.', promptVersion: V12, zelleInvoiceId: 'inv-1' })).resolves.toMatchObject({ sent: false, reason: 'payment_status_unauthorized' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(decisions.update).toHaveBeenCalledWith(expect.objectContaining({ status: autoSend.FAILED_STATUS }));
  });

  test('a copied Zelle sentence whose invoice stopped taking Zelle (or recipient rotated) is held: payment_status_changed', async () => {
    amountRecheck.paymentStatusVerdict.mockResolvedValue({ reason: 'payment_status_changed', zelle: null });
    await expect(attempt({ reply: 'x', promptVersion: V12, zelleInvoiceId: 'inv-1' })).resolves.toMatchObject({ sent: false, reason: 'payment_status_changed' });
    expect(suggest.reopenScheduledSuggestions).toHaveBeenCalledWith(expect.objectContaining({ decisionIds: ['parked-1'] }));
  });
});

// Codex round-13 P1: a THROWING recheck fails closed with its own reason and
// RELEASES the claim (failClaim + reservation settled + parked reopened).
describe('a throwing recheck releases the claim (fail closed)', () => {
  test('the staff-contact recheck (older prompt, Zelle mention) throws', async () => {
    amountRecheck.outgoingAmountsStale.mockRejectedValue(new Error('pg down'));
    await expect(attempt({ zelleInvoiceId: 'inv-1', promptVersion: 'house_voice_v11' })).resolves.toMatchObject({ sent: false, reason: 'payment_status_recheck_failed' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(decisions.update).toHaveBeenCalledWith(expect.objectContaining({ status: autoSend.FAILED_STATUS }));
    expect(suggest.settleReplyHoldingReservation).toHaveBeenCalledWith({ reservationId: '33333333-3333-4333-8333-333333333333' });
    expect(suggest.reopenScheduledSuggestions).toHaveBeenCalledWith(expect.objectContaining({ decisionIds: ['parked-1'] }));
  });

  test('the contract verdict (real answers) throws', async () => {
    amountRecheck.paymentStatusVerdict.mockRejectedValue(new Error('billing down'));
    await expect(attempt({ reply: "You're paid up!", promptVersion: V12 })).resolves.toMatchObject({ sent: false, reason: 'payment_status_recheck_failed' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(decisions.update).toHaveBeenCalledWith(expect.objectContaining({ status: autoSend.FAILED_STATUS }));
    expect(suggest.settleReplyHoldingReservation).toHaveBeenCalled();
    expect(suggest.reopenScheduledSuggestions).toHaveBeenCalledWith(expect.objectContaining({ decisionIds: ['parked-1'] }));
  });
});

describe('the claim is released on every other pre-send error path', () => {
  test('the arming write (uncertain reservation settle) throws => claim failed, siblings reopened, nothing sent', async () => {
    suggest.settleReplyHoldingReservation.mockRejectedValueOnce(new Error('pg down'));
    await expect(attempt({ reply: 'Sounds good, thanks!' })).resolves.toMatchObject({ sent: false, reason: 'reservation_failed' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(decisions.update).toHaveBeenCalledWith(expect.objectContaining({ status: autoSend.FAILED_STATUS }));
    expect(suggest.reopenScheduledSuggestions).toHaveBeenCalledWith(expect.objectContaining({ decisionIds: ['parked-1'] }));
  });

  test('a recheck throws AND the reservation release throws => the claim is STILL failed', async () => {
    amountRecheck.paymentStatusVerdict.mockRejectedValue(new Error('billing down'));
    suggest.settleReplyHoldingReservation
      .mockResolvedValueOnce(true) // arm
      .mockRejectedValue(new Error('settle down')); // release
    await expect(attempt({ reply: "You're paid up!", promptVersion: 'house_voice_v12_real_answers5_cflvp' })).resolves.toMatchObject({ sent: false, reason: 'payment_status_recheck_failed' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(decisions.update).toHaveBeenCalledWith(expect.objectContaining({ status: autoSend.FAILED_STATUS }));
  });
});
