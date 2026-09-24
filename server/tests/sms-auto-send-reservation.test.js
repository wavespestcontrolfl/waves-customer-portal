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
jest.mock('../services/sms-shadow-drafter', () => ({ resolveEffectiveVoiceProfile: jest.fn(async () => ({ version: null })) }));
jest.mock('../services/sms-graduation', () => ({ evaluateAutoSendEligibility: jest.fn(async () => ({ eligible: true })) }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));

const db = require('../models/db');
const suggest = require('../services/sms-suggest-mode');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
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
  sendCustomerMessage.mockResolvedValue({
    sent: true, deliveryOutcome: 'accepted', providerMessageId: `SM${'a'.repeat(32)}`,
  });
});

const attempt = () => autoSend.maybeAutoSend({
  draftId: '00000000-0000-4000-8000-000000000001', customer: { id: '00000000-0000-4000-8000-000000000002' },
  smsLogId: '00000000-0000-4000-8000-000000000003', inboundMessage: 'Hello', reply: 'Hi there',
  intent: 'general_customer_sms_needs_review', intendedActions: [], actionsVerifiedSafe: true,
});

test('an atomic reservation failure prevents provider entry', async () => {
  suggest.createReplyHoldingReservation.mockRejectedValueOnce(new Error('reservation unavailable'));
  await expect(attempt()).resolves.toMatchObject({ sent: false, reason: 'error' });
  expect(sendCustomerMessage).not.toHaveBeenCalled();
});

test('an uncertainty-arm failure prevents provider entry', async () => {
  suggest.settleReplyHoldingReservation.mockResolvedValueOnce(false);
  await expect(attempt()).resolves.toMatchObject({ sent: false, reason: 'reservation_failed' });
  expect(sendCustomerMessage).not.toHaveBeenCalled();
});

test('accepted bookkeeping failure preserves the accepted reservation for recovery', async () => {
  suggest.ignoreParkedSuggestions.mockResolvedValueOnce(0);
  await expect(attempt()).resolves.toMatchObject({ sent: true, providerMessageId: expect.stringMatching(/^SM/) });
  const borrowed = sendCustomerMessage.mock.calls[0][0].providerHandoffReservation;
  expect(require('../services/messaging/provider-handoff-reservation').isProviderHandoffHandle(borrowed)).toBe(true);
  expect(borrowed.context).toMatchObject({
    to: '+12025550101', fromNumber: expect.any(String), body: 'Hi there', messageType: 'ai_autosent',
  });
  expect(suggest.settleReplyHoldingReservation).toHaveBeenNthCalledWith(1, { reservationId: '33333333-3333-4333-8333-333333333333', uncertain: true });
  expect(suggest.settleReplyHoldingReservation).toHaveBeenNthCalledWith(2, expect.objectContaining({
    reservationId: '33333333-3333-4333-8333-333333333333', acceptedResult: expect.objectContaining({ deliveryOutcome: 'accepted' }),
  }));
  expect(suggest.settleReplyHoldingReservation).toHaveBeenCalledTimes(2);
});

test('accepted promotion failure leaves the claim and parked decisions held', async () => {
  suggest.settleReplyHoldingReservation
    .mockResolvedValueOnce(true)
    .mockResolvedValueOnce(false);

  await expect(attempt()).resolves.toMatchObject({
    sent: true, providerMessageId: expect.stringMatching(/^SM/),
  });
  expect(decisions.update).not.toHaveBeenCalled();
  expect(suggest.ignoreParkedSuggestions).not.toHaveBeenCalled();
  expect(suggest.settleReplyHoldingReservation).toHaveBeenCalledTimes(2);
});
