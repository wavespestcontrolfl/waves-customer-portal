/**
 * Auto-send payment-status send-time recheck (PR #5331, owner ruling 2026-10-01). Same harness as
 * sms-auto-send-zelle-recheck.test.js, but with the REAL sms-amount-recheck: claimAutoSend persists the payment_status_snapshot
 * on the decision and the claim, and dispatchClaimedSend re-renders the copied sentences from live billing before the provider.
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
  // what the real sms-amount-recheck reads off the drafter
  AMOUNT_MASK_RE: /\$\s?\d[\d,]*(?:\.\d{1,2})?/g,
  PAYMENT_ACK_RE: /\bpayment\b/i,
  billingAmountCents: jest.fn(() => ({ owed: new Set(), paid: new Set() })),
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
jest.mock('../services/context-aggregator', () => ({ getContextForCustomer: jest.fn() }));

const db = require('../models/db');
const suggest = require('../services/sms-suggest-mode');
const drafter = require('../services/sms-shadow-drafter');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const ContextAggregator = require('../services/context-aggregator');
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
  ContextAggregator.getContextForCustomer.mockReset();
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
    if (table === 'customers') return chain({ first: jest.fn(async () => ({ id: 'cust' })) });
    return chain();
  });
  db.trx.raw = jest.fn(async () => undefined);
  suggest.createReplyHoldingReservation.mockResolvedValue('33333333-3333-4333-8333-333333333333');
  suggest.settleReplyHoldingReservation.mockResolvedValue(true);
  suggest.ignoreParkedSuggestions.mockResolvedValue(1);
  drafter.openTimesStillOffered.mockResolvedValue({ ok: true });
  sendCustomerMessage.mockResolvedValue({
    sent: true, deliveryOutcome: 'accepted', providerMessageId: `SM${'a'.repeat(32)}`,
  });
});

const V12 = 'house_voice_v12_real_answers5_cflvp';
const COPY = 'We received your $120.00 card payment on Sep 12, 2026.';
const SNAP = { customer_id: '00000000-0000-4000-8000-000000000002', sentences: [COPY], family_counts: { payment: 1 } };
const live = (over = {}) => ({ billing: { outstandingBalance: 0, hasProcessingPayment: false, recentPayments: [{ id: 'p1', amount: 120, status: 'paid', payment_date: '2026-09-12', payment_method_type: 'card' }], ...over } });
const attempt = (overrides = {}) => autoSend.maybeAutoSend({
  draftId: '00000000-0000-4000-8000-000000000001', customer: { id: '00000000-0000-4000-8000-000000000002' },
  smsLogId: '00000000-0000-4000-8000-000000000003', inboundMessage: 'Did you get my payment?',
  reply: COPY, intent: 'general_customer_sms_needs_review', intendedActions: [], actionsVerifiedSafe: true,
  promptVersion: V12, paymentStatusSnapshot: SNAP, ...overrides,
});

test('claimAutoSend persists the snapshot on the decision; a sentence the records still render goes out', async () => {
  ContextAggregator.getContextForCustomer.mockResolvedValue(live());
  await expect(attempt()).resolves.toMatchObject({ sent: true });
  expect(JSON.parse(decisions.insert.mock.calls[0][0].input_snapshot).payment_status_snapshot).toEqual(SNAP);
  expect(sendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({ body: COPY }));
});

test('the payment was refunded / re-dated since the draft: not sent, claim failed, parked suggestions reopened', async () => {
  ContextAggregator.getContextForCustomer.mockResolvedValue(live({ recentPayments: [{ id: 'p1', amount: 120, status: 'refunded', refund_status: 'full', refund_amount: 120, payment_date: '2026-09-12', payment_method_type: 'card' }] }));
  await expect(attempt()).resolves.toMatchObject({ sent: false, reason: 'payment_status_changed' });
  expect(sendCustomerMessage).not.toHaveBeenCalled();
  expect(decisions.update).toHaveBeenCalledWith(expect.objectContaining({ status: autoSend.FAILED_STATUS }));
  expect(suggest.reopenScheduledSuggestions).toHaveBeenCalledWith(expect.objectContaining({ decisionIds: ['parked-1'] }));
});

test('a paraphrase / invented status (no snapshot, or not the snapshotted words) is held without a billing read', async () => {
  // (the payment-scoped copy-only rule now refuses these before the claim; the dispatch-time detector is the second line)
  await expect(attempt({ reply: "You're all paid up!", paymentStatusSnapshot: null })).resolves.toMatchObject({ sent: false, reason: 'payment_status_not_auto_sendable' });
  await expect(attempt({ reply: 'We got your payment on Sep 12, 2026.' })).resolves.toMatchObject({ sent: false, reason: 'payment_status_not_auto_sendable' });
  expect(ContextAggregator.getContextForCustomer).not.toHaveBeenCalled();
  expect(sendCustomerMessage).not.toHaveBeenCalled();
});

test('another customer\'s snapshot, unavailable billing and a throwing read all fail closed', async () => {
  ContextAggregator.getContextForCustomer.mockResolvedValue(live());
  await expect(attempt({ paymentStatusSnapshot: { ...SNAP, customer_id: '99999999-9999-4999-8999-999999999999' } })).resolves.toMatchObject({ sent: false, reason: 'payment_status_changed' });
  ContextAggregator.getContextForCustomer.mockResolvedValue({ billing: { unavailable: true } });
  await expect(attempt()).resolves.toMatchObject({ sent: false, reason: 'payment_status_recheck_failed' });
  ContextAggregator.getContextForCustomer.mockRejectedValue(new Error('billing down'));
  await expect(attempt()).resolves.toMatchObject({ sent: false, reason: 'payment_status_recheck_failed' });
  expect(sendCustomerMessage).not.toHaveBeenCalled();
});

test('a reply that states no status needs no billing read; a pre-v12 (gate-off) draft is never put through the contract', async () => {
  // (payment-scoped by the customer's message, so it must be inert text to auto-send: see the structural tests below)
  await expect(attempt({ reply: 'Hi Sam, let us know if you have any questions.', paymentStatusSnapshot: null })).resolves.toMatchObject({ sent: true });
  expect(ContextAggregator.getContextForCustomer).not.toHaveBeenCalled();
  sendCustomerMessage.mockClear();
  await expect(attempt({ reply: "You're all paid up!", paymentStatusSnapshot: null, promptVersion: 'house_voice_v11' })).resolves.toMatchObject({ sent: true });
  expect(ContextAggregator.getContextForCustomer).not.toHaveBeenCalled();
  sendCustomerMessage.mockClear();
  // a pre-v12 draft that is payment-scoped and not copy-only is unchanged too (gate off == main)
  await expect(attempt({ reply: 'Here is your pay link.', paymentStatusSnapshot: null, promptVersion: 'house_voice_v11' })).resolves.toMatchObject({ sent: true });
});

// Independent review of PR #5331 (STRUCTURAL): the detector is a net with holes, so a payment-scoped v12 reply auto-sends only as
// verbatim copies plus inert text. Anything else is routed to Agent Review - before the claim, so nothing is parked or reserved.
describe('a payment-scoped reply that is not copy-only never auto-sends', () => {
  test.each([
    ['P1-1: pronoun-only confirmation, no payment word anywhere', 'Did it go through?', "Yes, it went through \u2014 you're all set!"],
    ['P1-2: pronoun receipt', 'Did you get it?', 'Yes, I see it on our end \u2014 thank you!'],
    ['P1-2: pronoun receipt after a copied sentence', 'Did my payment go through?', `${COPY} And the one from Sep 30 too.`],
    ['an invented extra clause after a copy', 'Did my payment go through?', `${COPY} A teammate will text you the details.`],
    ['an ordinary answer in a payment thread', 'How can I pay?', 'Here is your pay link.'],
  ])('%s', async (_name, inboundMessage, reply) => {
    ContextAggregator.getContextForCustomer.mockResolvedValue(live());
    await expect(attempt({ inboundMessage, reply })).resolves.toEqual({ sent: false, reason: 'payment_status_not_auto_sendable' });
    expect(decisions.insert).not.toHaveBeenCalled(); // no claim, nothing parked
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('copies plus inert text (greeting, thanks, "let us know if you have questions") still auto-send', async () => {
    ContextAggregator.getContextForCustomer.mockResolvedValue(live());
    await expect(attempt({ reply: `Hi Sam, ${COPY} Let us know if you have any questions.` })).resolves.toMatchObject({ sent: true });
  });

  test('the thread alone makes a draft payment-scoped (snapshot.scoped), even when the reply and the latest message are bare', async () => {
    const scoped = { customer_id: SNAP.customer_id, sentences: [], scoped: true };
    await expect(attempt({ inboundMessage: 'ok thanks', reply: 'Sounds good, see you Tuesday!', paymentStatusSnapshot: scoped })).resolves.toEqual({ sent: false, reason: 'payment_status_not_auto_sendable' });
    await expect(attempt({ inboundMessage: 'ok thanks', reply: 'Sounds good, see you Tuesday!', paymentStatusSnapshot: null })).resolves.toMatchObject({ sent: true });
  });

  test('dispatch-time recheck: a snapshot-scoped body that slipped past readiness is held with the claim failed', async () => {
    // readiness sees no snapshot; the claim's own snapshot (what the decision persisted) says scoped - the executor re-judges it
    const { paymentStatusSendBlockReason } = require('../services/sms-amount-recheck');
    await expect(paymentStatusSendBlockReason({ customerId: 'c', body: 'Sounds good, see you Tuesday!', snapshot: { sentences: [], scoped: true }, inboundMessage: 'ok thanks', autoSend: true })).resolves.toBe('payment_status_not_auto_sendable');
    // ...a human review (no autoSend) judges the same body by the detector only
    await expect(paymentStatusSendBlockReason({ customerId: 'c', body: 'Sounds good, see you Tuesday!', snapshot: { sentences: [], scoped: true }, inboundMessage: 'ok thanks' })).resolves.toBeNull();
  });
});

// Owner ruling 2026-10-01 (staff edits): auto-send never carries an edit, so it never asks the contract to stand down.
test('auto-send is always strict: the dispatch recheck never passes humanEditedBody, and a paraphrase never goes out', async () => {
  const src = require('fs').readFileSync(require.resolve('../services/sms-auto-send'), 'utf8');
  expect(src).not.toMatch(/humanEditedBody/);
  const { paymentStatusSendBlockReason } = require('../services/sms-amount-recheck');
  await expect(paymentStatusSendBlockReason({ customerId: 'c', body: "Yes, we got your payment - you're all set!", snapshot: null, inboundMessage: 'Did I pay?', autoSend: true })).resolves.not.toBeNull();
  await expect(attempt({ reply: "Yes, we got your payment - you're all set!", paymentStatusSnapshot: null })).resolves.toMatchObject({ sent: false });
  expect(sendCustomerMessage).not.toHaveBeenCalled();
});

// Codex round-49 P1: the autonomous send's billing claims are guarded at the provider boundary too - the billing fingerprint is
// taken BEFORE the dispatch-time recheck and re-read on the handoff connection right before the provider request
describe('auto-send billing fingerprint at the provider boundary', () => {
  afterEach(() => { delete db.raw; });
  test('a payment-status reply: unchanged billing passes the boundary; a payment landing after the recheck refuses (retryable)', async () => {
    ContextAggregator.getContextForCustomer.mockResolvedValue(live());
    const order = [];
    db.raw = jest.fn(async () => { order.push('fingerprint'); return { rows: [{ fingerprint: 'fp-a' }] }; });
    ContextAggregator.getContextForCustomer.mockImplementation(async () => { order.push('recheck'); return live(); });
    await expect(attempt()).resolves.toMatchObject({ sent: true });
    expect(order[0]).toBe('fingerprint'); // BEFORE the full recheck's billing read
    const check = sendCustomerMessage.mock.calls[0][0].providerPreSendCheck;
    const dbiWith = (fp) => ({ raw: async () => ({ rows: [{ fingerprint: fp }] }) });
    await expect(check({ dbi: dbiWith('fp-a') })).resolves.toMatchObject({ ok: true });
    await expect(check({ dbi: dbiWith('fp-b') })).resolves.toMatchObject({ ok: false, code: 'BILLING_CHANGED_AT_BOUNDARY', retryable: true });
    await expect(check.afterMarker({ dbi: dbiWith('fp-b') })).resolves.toMatchObject({ ok: false, code: 'BILLING_CHANGED_AT_BOUNDARY' });
  });
});

// Codex round-60 P1: the lane predicate reads the DB too, so the billing fingerprint is read once more after it (the last read)
test('autoSendMessage composes the billing fingerprint again AFTER the lane predicate', () => {
  const src = require('fs').readFileSync(require.resolve('../services/sms-auto-send'), 'utf8');
  const lane = src.indexOf('        laneFields.providerPreSendCheck,\n');
  const again = src.indexOf("billingUnchangedProviderPreSendCheck({ customerId, fingerprint: billingFingerprint, zelle })", lane);
  expect(lane).toBeGreaterThan(-1);
  expect(again).toBeGreaterThan(lane);
});

// Codex round-72 P2: the REAL price-quote matcher (the harness mock always says no) must not block a verbatim copied receipt - the
// copy carries the record's own figure - while any figure the model wrote itself is still a price quote
describe('price-quote rung reads only what the model wrote (real hasPriceQuote)', () => {
  const realHasPriceQuote = jest.requireActual('../services/sms-suggest-mode').hasPriceQuote;
  beforeEach(() => { require('../services/sms-suggest-mode').hasPriceQuote.mockImplementation(realHasPriceQuote); });
  afterEach(() => { require('../services/sms-suggest-mode').hasPriceQuote.mockImplementation(() => false); });
  test('a copied receipt (with its $ figure) auto-sends', async () => {
    expect(realHasPriceQuote(COPY)).toBe(true); // the matcher alone would refuse it
    ContextAggregator.getContextForCustomer.mockResolvedValue(live());
    await expect(attempt()).resolves.toMatchObject({ sent: true });
  });
  test('a figure outside the copy is still a price quote; a non-v12 draft is unchanged', async () => {
    ContextAggregator.getContextForCustomer.mockResolvedValue(live());
    await expect(attempt({ reply: `${COPY} The next one is $45.` })).resolves.toEqual({ sent: false, reason: 'price_quote' });
    await expect(attempt({ promptVersion: 'house_voice_v11' })).resolves.toEqual({ sent: false, reason: 'price_quote' });
    await expect(attempt({ paymentStatusSnapshot: null })).resolves.toEqual({ sent: false, reason: 'price_quote' });
  });
});

test('round-74: a copied plan-price line is still a price quote at the auto-send rung (real hasPriceQuote)', async () => {
  const suggest = require('../services/sms-suggest-mode');
  suggest.hasPriceQuote.mockImplementation(jest.requireActual('../services/sms-suggest-mode').hasPriceQuote);
  try {
    const PLAN = 'Your monthly plan price is $99.00.';
    ContextAggregator.getContextForCustomer.mockResolvedValue(live());
    await expect(attempt({ inboundMessage: "What's my monthly price?", reply: PLAN, paymentStatusSnapshot: { customer_id: SNAP.customer_id, sentences: [PLAN] } }))
      .resolves.toEqual({ sent: false, reason: 'price_quote' });
  } finally { suggest.hasPriceQuote.mockImplementation(() => false); }
});
