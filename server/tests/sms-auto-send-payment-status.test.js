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
  remainderAmountsUngrounded: jest.fn(() => false),
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

const V12 = 'house_voice_v12_real_answers5_cf_pf';
const COPY = 'We received your $120.00 card payment on Sep 12, 2026.';
const SNAP = { customer_id: '00000000-0000-4000-8000-000000000002', sentences: [COPY] };
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
  await expect(attempt({ reply: "You're all paid up!", paymentStatusSnapshot: null })).resolves.toMatchObject({ sent: false, reason: 'payment_status_unauthorized' });
  await expect(attempt({ reply: 'We got your payment on Sep 12, 2026.' })).resolves.toMatchObject({ sent: false, reason: 'payment_status_unauthorized' });
  expect(ContextAggregator.getContextForCustomer).not.toHaveBeenCalled();
  expect(sendCustomerMessage).not.toHaveBeenCalled();
});

test('another customer\'s snapshot, unavailable billing and a throwing read all fail closed', async () => {
  ContextAggregator.getContextForCustomer.mockResolvedValue(live());
  await expect(attempt({ paymentStatusSnapshot: { ...SNAP, customer_id: '99999999-9999-4999-8999-999999999999' } })).resolves.toMatchObject({ sent: false, reason: 'payment_status_changed' });
  ContextAggregator.getContextForCustomer.mockResolvedValue({ billing: { unavailable: true } });
  await expect(attempt()).resolves.toMatchObject({ sent: false, reason: 'payment_status_changed' });
  ContextAggregator.getContextForCustomer.mockRejectedValue(new Error('billing down'));
  await expect(attempt()).resolves.toMatchObject({ sent: false, reason: 'payment_status_recheck_failed' });
  expect(sendCustomerMessage).not.toHaveBeenCalled();
});

test('a reply that states no status needs no billing read; a pre-v12 (gate-off) draft is never put through the contract', async () => {
  await expect(attempt({ reply: 'Here is your pay link.', paymentStatusSnapshot: null })).resolves.toMatchObject({ sent: true });
  expect(ContextAggregator.getContextForCustomer).not.toHaveBeenCalled();
  sendCustomerMessage.mockClear();
  await expect(attempt({ reply: "You're all paid up!", paymentStatusSnapshot: null, promptVersion: 'house_voice_v11' })).resolves.toMatchObject({ sent: true });
  expect(ContextAggregator.getContextForCustomer).not.toHaveBeenCalled();
});
