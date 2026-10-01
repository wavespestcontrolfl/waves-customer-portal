/**
 * Auto-send Zelle send-time recheck (pre-push audit P1, finding 2). Same
 * harness as sms-auto-send-open-times.test.js: full maybeAutoSend round trip
 * with the DB and provider mocked, exercising claimAutoSend's threading of
 * zelleInvoiceId onto the claim and dispatchClaimedSend's pre-send recheck
 * of it — the auto-send choke point, distinct from the /sms and
 * /schedule-sms choke point (agent-decision-send-checks.js) and the
 * scheduler's queued-send fire-time recheck, which cover the same fact via
 * the same sms-amount-recheck.js primitives.
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
  outgoingZelleStale: jest.fn(),
  hasAffirmativeZelleMention: jest.fn(),
  zelleInvoiceStillEligible: jest.fn(),
  hasNegativeZelleAvailabilityClaim: jest.fn(() => false),
  zelleDenialStale: jest.fn(async () => ({ stale: false })),
  // PR #5331: dispatchClaimedSend's payment-status recheck (real-answers replies), right alongside the Zelle recheck this suite
  // exercises. Defaults clean; the dedicated describe below overrides it.
  paymentStatusSendBlockReason: jest.fn(async () => null),
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
  amountRecheck.hasAffirmativeZelleMention.mockReturnValue(false);
  amountRecheck.outgoingZelleStale.mockReturnValue({ stale: false });
  amountRecheck.zelleInvoiceStillEligible.mockResolvedValue({ eligible: true });
  amountRecheck.hasNegativeZelleAvailabilityClaim.mockReturnValue(false);
  amountRecheck.zelleDenialStale.mockResolvedValue({ stale: false });
  amountRecheck.paymentStatusSendBlockReason.mockResolvedValue(null);
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

test('a reply with no affirmative Zelle mention never triggers the recheck', async () => {
  amountRecheck.hasAffirmativeZelleMention.mockReturnValue(false);
  await expect(attempt({ reply: 'Sounds good, thanks!' })).resolves.toMatchObject({ sent: true });
  expect(amountRecheck.outgoingZelleStale).not.toHaveBeenCalled();
  expect(amountRecheck.zelleInvoiceStillEligible).not.toHaveBeenCalled();
  expect(sendCustomerMessage).toHaveBeenCalled();
});

// Independent-review P1 (round 3, PR #5331, finding 1): a negated mention
// ("we don't take Zelle") must never trigger the recheck either — this
// function trusts hasAffirmativeZelleMention's own negation handling, so the
// unit coverage for that distinction lives in sms-shadow-drafter.test.js;
// here it's enough to prove the auto-send seam gates on that one function.
test('a reply with a negated Zelle mention never triggers the recheck', async () => {
  amountRecheck.hasAffirmativeZelleMention.mockReturnValue(false);
  await expect(attempt({ reply: "Sorry, we don't take Zelle anymore." })).resolves.toMatchObject({ sent: true });
  expect(amountRecheck.outgoingZelleStale).not.toHaveBeenCalled();
  expect(amountRecheck.zelleInvoiceStillEligible).not.toHaveBeenCalled();
  expect(sendCustomerMessage).toHaveBeenCalled();
});

test('a Zelle reply with a CURRENT recipient and an ELIGIBLE invoice sends normally', async () => {
  amountRecheck.hasAffirmativeZelleMention.mockReturnValue(true);
  amountRecheck.outgoingZelleStale.mockReturnValue({ stale: false });
  amountRecheck.zelleInvoiceStillEligible.mockResolvedValue({ eligible: true });
  await expect(attempt({ zelleInvoiceId: 'inv-1' })).resolves.toMatchObject({ sent: true });
  expect(amountRecheck.zelleInvoiceStillEligible).toHaveBeenCalledWith({
    customerId: '00000000-0000-4000-8000-000000000002', zelleInvoiceId: 'inv-1',
  });
  expect(sendCustomerMessage).toHaveBeenCalled();
});

// Independent-review P1 (round 3, PR #5331, finding 1): an affirmative offer
// with NO specific contact ("Yes, you can use Zelle") still needs the
// recipient-enabled + invoice-eligibility recheck — the prior gate ran only
// when the body named a specific contact.
test('an affirmative Zelle mention with NO contact still runs the recipient + eligibility recheck', async () => {
  amountRecheck.hasAffirmativeZelleMention.mockReturnValue(true);
  amountRecheck.outgoingZelleStale.mockReturnValue({ stale: false });
  amountRecheck.zelleInvoiceStillEligible.mockResolvedValue({ eligible: false, reason: 'zelle_recipient_stale' });
  await expect(attempt({ reply: 'Yes, you can use Zelle.', zelleInvoiceId: 'inv-1' }))
    .resolves.toMatchObject({ sent: false, reason: 'zelle_recipient_stale' });
  expect(amountRecheck.outgoingZelleStale).toHaveBeenCalledWith('Yes, you can use Zelle.');
  expect(amountRecheck.zelleInvoiceStillEligible).toHaveBeenCalledWith({
    customerId: '00000000-0000-4000-8000-000000000002', zelleInvoiceId: 'inv-1',
  });
  expect(sendCustomerMessage).not.toHaveBeenCalled();
});

test('a stale Zelle recipient blocks the send, fails the claim, reopens parked suggestions — eligibility never even checked', async () => {
  amountRecheck.hasAffirmativeZelleMention.mockReturnValue(true);
  amountRecheck.outgoingZelleStale.mockReturnValue({ stale: true, reason: 'zelle_recipient_stale' });
  await expect(attempt({ zelleInvoiceId: 'inv-1' })).resolves.toMatchObject({ sent: false, reason: 'zelle_recipient_stale' });
  expect(amountRecheck.zelleInvoiceStillEligible).not.toHaveBeenCalled();
  expect(sendCustomerMessage).not.toHaveBeenCalled();
  expect(decisions.update).toHaveBeenCalledWith(expect.objectContaining({ status: autoSend.FAILED_STATUS }));
  expect(suggest.reopenScheduledSuggestions).toHaveBeenCalledWith(expect.objectContaining({ decisionIds: ['parked-1'] }));
});

test('a recipient still current but the invoice was paid off / charge started since the draft blocks the send', async () => {
  amountRecheck.hasAffirmativeZelleMention.mockReturnValue(true);
  amountRecheck.outgoingZelleStale.mockReturnValue({ stale: false });
  amountRecheck.zelleInvoiceStillEligible.mockResolvedValue({ eligible: false, reason: 'zelle_invoice_ineligible' });
  await expect(attempt({ zelleInvoiceId: 'inv-1' })).resolves.toMatchObject({ sent: false, reason: 'zelle_invoice_ineligible' });
  expect(sendCustomerMessage).not.toHaveBeenCalled();
});

test('no zelleInvoiceId on the claim (missing snapshot) blocks the send — fail closed', async () => {
  amountRecheck.hasAffirmativeZelleMention.mockReturnValue(true);
  amountRecheck.outgoingZelleStale.mockReturnValue({ stale: false });
  amountRecheck.zelleInvoiceStillEligible.mockResolvedValue({ eligible: false, reason: 'zelle_invoice_unresolved' });
  await expect(attempt({})).resolves.toMatchObject({ sent: false, reason: 'zelle_invoice_unresolved' });
  expect(amountRecheck.zelleInvoiceStillEligible).toHaveBeenCalledWith({
    customerId: '00000000-0000-4000-8000-000000000002', zelleInvoiceId: null,
  });
  expect(sendCustomerMessage).not.toHaveBeenCalled();
});

// PR #5331 (owner ruling 2026-10-01): dispatchClaimedSend's payment-status recheck for real-answers (v12) replies, right
// alongside the Zelle recheck above. A status sentence with no figure ("Your account has no balance due.") clears the
// price-quote guard, so it must be re-rendered from live data before the provider is entered.
describe('payment-status recheck (PR #5331)', () => {
  const V12 = 'house_voice_v12_real_answers5_cfl_p';
  const SNAP = { customer_id: '00000000-0000-4000-8000-000000000002', sentences: ['Your account has no balance due.'] };
  test('a real-answers reply is rechecked against its snapshot and the customer inbound, and sends when clean', async () => {
    await expect(attempt({ reply: 'Your account has no balance due.', promptVersion: V12, paymentStatusSnapshot: SNAP })).resolves.toMatchObject({ sent: true });
    expect(amountRecheck.paymentStatusSendBlockReason).toHaveBeenCalledWith({
      customerId: '00000000-0000-4000-8000-000000000002', body: 'Your account has no balance due.', snapshot: SNAP, inboundMessage: 'How do I pay?', autoSend: true,
    });
    expect(sendCustomerMessage).toHaveBeenCalled();
  });

  test('a stale / unauthorized status blocks the send, fails the claim, reopens parked suggestions', async () => {
    amountRecheck.paymentStatusSendBlockReason.mockResolvedValue('payment_status_changed');
    await expect(attempt({ reply: 'Your account has no balance due.', promptVersion: V12, paymentStatusSnapshot: SNAP })).resolves.toMatchObject({ sent: false, reason: 'payment_status_changed' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(decisions.update).toHaveBeenCalledWith(expect.objectContaining({ status: autoSend.FAILED_STATUS }));
    expect(suggest.reopenScheduledSuggestions).toHaveBeenCalledWith(expect.objectContaining({ decisionIds: ['parked-1'] }));
  });

  test('a snapshot-less real-answers reply is still rechecked (an unsanctioned status is held by the reply guard)', async () => {
    amountRecheck.paymentStatusSendBlockReason.mockResolvedValue('payment_status_unauthorized');
    await expect(attempt({ reply: "You're paid up!", promptVersion: V12 })).resolves.toMatchObject({ sent: false, reason: 'payment_status_unauthorized' });
    expect(amountRecheck.paymentStatusSendBlockReason).toHaveBeenCalledWith(expect.objectContaining({ snapshot: null }));
  });

  test('a pre-v12 (gate-off) draft is never put through it - byte-identical to main', async () => {
    await expect(attempt({ reply: "You're paid up!", promptVersion: 'house_voice_v11' })).resolves.toMatchObject({ sent: true });
    expect(amountRecheck.paymentStatusSendBlockReason).not.toHaveBeenCalled();
  });

  test('it runs even for a reply with an eligible Zelle mention (both rechecks apply)', async () => {
    amountRecheck.hasAffirmativeZelleMention.mockReturnValue(true);
    amountRecheck.outgoingZelleStale.mockReturnValue({ stale: false });
    amountRecheck.zelleInvoiceStillEligible.mockResolvedValue({ eligible: true });
    await expect(attempt({ zelleInvoiceId: 'inv-1', promptVersion: V12 })).resolves.toMatchObject({ sent: true });
    expect(amountRecheck.paymentStatusSendBlockReason).toHaveBeenCalled();
  });
});

// Codex round-13 P1: a THROWING recheck fails closed with its own reason and
// RELEASES the claim (failClaim + reservation settled + parked reopened).
describe('a throwing recheck releases the claim (fail closed)', () => {
  test('zelleInvoiceStillEligible throws', async () => {
    amountRecheck.hasAffirmativeZelleMention.mockReturnValue(true);
    amountRecheck.outgoingZelleStale.mockReturnValue({ stale: false });
    amountRecheck.zelleInvoiceStillEligible.mockRejectedValue(new Error('pg down'));
    await expect(attempt({ zelleInvoiceId: 'inv-1' })).resolves.toMatchObject({ sent: false, reason: 'zelle_recheck_failed' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(decisions.update).toHaveBeenCalledWith(expect.objectContaining({ status: autoSend.FAILED_STATUS }));
    expect(suggest.settleReplyHoldingReservation).toHaveBeenCalledWith({ reservationId: '33333333-3333-4333-8333-333333333333' });
    expect(suggest.reopenScheduledSuggestions).toHaveBeenCalledWith(expect.objectContaining({ decisionIds: ['parked-1'] }));
  });

  test('outgoingZelleStale throws', async () => {
    amountRecheck.hasAffirmativeZelleMention.mockReturnValue(true);
    amountRecheck.outgoingZelleStale.mockImplementation(() => { throw new Error('env read failed'); });
    await expect(attempt({ zelleInvoiceId: 'inv-1' })).resolves.toMatchObject({ sent: false, reason: 'zelle_recheck_failed' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(decisions.update).toHaveBeenCalledWith(expect.objectContaining({ status: autoSend.FAILED_STATUS }));
  });

  test('paymentStatusSendBlockReason throws', async () => {
    amountRecheck.paymentStatusSendBlockReason.mockRejectedValue(new Error('billing down'));
    await expect(attempt({ reply: "You're paid up!", promptVersion: 'house_voice_v12_real_answers5_cfl_p' })).resolves.toMatchObject({ sent: false, reason: 'payment_status_recheck_failed' });
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
    amountRecheck.paymentStatusSendBlockReason.mockRejectedValue(new Error('billing down'));
    suggest.settleReplyHoldingReservation
      .mockResolvedValueOnce(true) // arm
      .mockRejectedValue(new Error('settle down')); // release
    await expect(attempt({ reply: "You're paid up!", promptVersion: 'house_voice_v12_real_answers5_cfl_p' })).resolves.toMatchObject({ sent: false, reason: 'payment_status_recheck_failed' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(decisions.update).toHaveBeenCalledWith(expect.objectContaining({ status: autoSend.FAILED_STATUS }));
  });
});

// Codex round-18 P2: a Zelle DENIAL is rechecked on the autonomous lane too.
describe('a stale Zelle denial is held by auto-send', () => {
  test('Zelle became available since the draft => not sent, claim released, siblings reopened', async () => {
    amountRecheck.hasAffirmativeZelleMention.mockReturnValue(false);
    amountRecheck.hasNegativeZelleAvailabilityClaim.mockReturnValue(true);
    amountRecheck.zelleDenialStale.mockResolvedValue({ stale: true, reason: 'zelle_now_available' });
    await expect(attempt({ reply: "Zelle isn't available right now, but your pay link works." })).resolves.toMatchObject({ sent: false, reason: 'zelle_now_available' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(decisions.update).toHaveBeenCalledWith(expect.objectContaining({ status: autoSend.FAILED_STATUS }));
    expect(suggest.reopenScheduledSuggestions).toHaveBeenCalledWith(expect.objectContaining({ decisionIds: ['parked-1'] }));
  });
  test('a throwing denial recheck fails closed; a still-true denial sends', async () => {
    amountRecheck.hasAffirmativeZelleMention.mockReturnValue(false);
    amountRecheck.hasNegativeZelleAvailabilityClaim.mockReturnValue(true);
    amountRecheck.zelleDenialStale.mockRejectedValue(new Error('pg down'));
    await expect(attempt({ reply: "Zelle isn't available right now." })).resolves.toMatchObject({ sent: false, reason: 'zelle_recheck_failed' });
    amountRecheck.zelleDenialStale.mockResolvedValue({ stale: false });
    await expect(attempt({ reply: "Zelle isn't available right now." })).resolves.toMatchObject({ sent: true });
  });
});

// Codex round-32 P2: auto-send rechecks the denial even when the reply also holds an offer.
describe('an offer AND a stale denial in one reply (round 32)', () => {
  test('offer passes, denial stale => not sent, claim released, siblings reopened', async () => {
    amountRecheck.hasAffirmativeZelleMention.mockReturnValue(true);
    amountRecheck.outgoingZelleStale.mockReturnValue({ stale: false });
    amountRecheck.zelleInvoiceStillEligible.mockResolvedValue({ eligible: true });
    amountRecheck.hasNegativeZelleAvailabilityClaim.mockReturnValue(true);
    amountRecheck.zelleDenialStale.mockResolvedValue({ stale: true, reason: 'zelle_now_available' });
    await expect(attempt({ reply: "Zelle isn't available for invoice A. You can Zelle invoice B.", zelleInvoiceId: 'inv-1' })).resolves.toMatchObject({ sent: false, reason: 'zelle_now_available' });
    expect(amountRecheck.zelleInvoiceStillEligible).toHaveBeenCalled(); // the offer branch ran
    expect(amountRecheck.zelleDenialStale).toHaveBeenCalled(); // and so did the denial branch
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(decisions.update).toHaveBeenCalledWith(expect.objectContaining({ status: autoSend.FAILED_STATUS }));
  });
  test('offer passes and the denial still holds => sends', async () => {
    amountRecheck.hasAffirmativeZelleMention.mockReturnValue(true);
    amountRecheck.outgoingZelleStale.mockReturnValue({ stale: false });
    amountRecheck.zelleInvoiceStillEligible.mockResolvedValue({ eligible: true });
    amountRecheck.hasNegativeZelleAvailabilityClaim.mockReturnValue(true);
    amountRecheck.zelleDenialStale.mockResolvedValue({ stale: false });
    await expect(attempt({ reply: "Zelle isn't available for invoice A. You can Zelle invoice B.", zelleInvoiceId: 'inv-1' })).resolves.toMatchObject({ sent: true });
  });
});
