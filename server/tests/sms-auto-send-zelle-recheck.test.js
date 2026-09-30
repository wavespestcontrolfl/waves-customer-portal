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
  resolveEffectiveVoiceProfile: jest.fn(async () => ({ version: null })),
  openTimesStillOffered: jest.fn(async () => ({ ok: true })),
  // Independent-review P1 (round 5, finding 1): dispatchClaimedSend's new
  // amount-free status-claim recheck reads these two off the real drafter —
  // stubbed here since this suite exercises the ZELLE recheck specifically,
  // via its own amountFreeStatusClaimStale mock below.
  hasAffirmativePaymentAck: jest.fn(() => false),
  paymentStatusClaimKind: jest.fn(() => null),
}));
jest.mock('../services/sms-graduation', () => ({ evaluateAutoSendEligibility: jest.fn(async () => ({ eligible: true })) }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/sms-amount-recheck', () => ({
  outgoingZelleStale: jest.fn(),
  hasAffirmativeZelleMention: jest.fn(),
  zelleInvoiceStillEligible: jest.fn(),
  // Independent-review P1 (round 5, finding 1): dispatchClaimedSend's own
  // amount-free status-claim recheck, right alongside the Zelle recheck this
  // suite exercises. Defaults clean; the dedicated describe below overrides it.
  amountFreeStatusClaimStale: jest.fn(async () => ({ stale: false })),
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

beforeEach(() => {
  jest.clearAllMocks();
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
  amountRecheck.amountFreeStatusClaimStale.mockResolvedValue({ stale: false });
  sendCustomerMessage.mockResolvedValue({
    sent: true, deliveryOutcome: 'accepted', providerMessageId: `SM${'a'.repeat(32)}`,
  });
});

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

// Independent-review P1 (round 5, finding 1): dispatchClaimedSend's OWN
// amount-free payment-status recheck, right alongside the Zelle recheck
// above — a "You're paid up" reply carries no dollar figure and no Zelle
// mention, so it clears every OTHER guard in this file untouched.
describe('amount-free payment-status recheck (round 5, finding 1)', () => {
  test('a clean amount-free reply sends normally', async () => {
    await expect(attempt({ reply: "You're paid up!" })).resolves.toMatchObject({ sent: true });
    expect(amountRecheck.amountFreeStatusClaimStale).toHaveBeenCalledWith({
      customerId: '00000000-0000-4000-8000-000000000002', body: "You're paid up!", strict: true, inboundMessage: 'How do I pay?',
    });
    expect(sendCustomerMessage).toHaveBeenCalled();
  });

  test('a stale amount-free status claim blocks the send, fails the claim, reopens parked suggestions', async () => {
    amountRecheck.amountFreeStatusClaimStale.mockResolvedValue({ stale: true, reason: 'amount_no_longer_authorized' });
    await expect(attempt({ reply: "You're paid up!" })).resolves.toMatchObject({ sent: false, reason: 'amount_no_longer_authorized' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(decisions.update).toHaveBeenCalledWith(expect.objectContaining({ status: autoSend.FAILED_STATUS }));
    expect(suggest.reopenScheduledSuggestions).toHaveBeenCalledWith(expect.objectContaining({ decisionIds: ['parked-1'] }));
  });

  test('it runs even for a reply with an eligible Zelle mention (both rechecks apply)', async () => {
    amountRecheck.hasAffirmativeZelleMention.mockReturnValue(true);
    amountRecheck.outgoingZelleStale.mockReturnValue({ stale: false });
    amountRecheck.zelleInvoiceStillEligible.mockResolvedValue({ eligible: true });
    await expect(attempt({ zelleInvoiceId: 'inv-1' })).resolves.toMatchObject({ sent: true });
    expect(amountRecheck.amountFreeStatusClaimStale).toHaveBeenCalled();
  });
});

// Codex round-9 P1: the auto-send status recheck receives the customer's original inbound.
test('the amount-free status recheck is passed the original inbound message', async () => {
  await expect(attempt({ reply: "It isn't showing on our end yet.", inboundMessage: 'Did you get my $120 Zelle payment?' })).resolves.toMatchObject({ sent: true });
  expect(amountRecheck.amountFreeStatusClaimStale).toHaveBeenCalledWith(expect.objectContaining({
    strict: true, inboundMessage: 'Did you get my $120 Zelle payment?',
  }));
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

  test('amountFreeStatusClaimStale throws', async () => {
    amountRecheck.amountFreeStatusClaimStale.mockRejectedValue(new Error('billing down'));
    await expect(attempt({ reply: "You're paid up!" })).resolves.toMatchObject({ sent: false, reason: 'amount_recheck_failed' });
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
    amountRecheck.amountFreeStatusClaimStale.mockRejectedValue(new Error('billing down'));
    suggest.settleReplyHoldingReservation
      .mockResolvedValueOnce(true) // arm
      .mockRejectedValue(new Error('settle down')); // release
    await expect(attempt({ reply: "You're paid up!" })).resolves.toMatchObject({ sent: false, reason: 'amount_recheck_failed' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(decisions.update).toHaveBeenCalledWith(expect.objectContaining({ status: autoSend.FAILED_STATUS }));
  });
});
