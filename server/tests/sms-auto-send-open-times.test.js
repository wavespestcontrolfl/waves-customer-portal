/**
 * Auto-send OPEN TIMES send-time recheck (Codex P2). Same harness as
 * sms-auto-send-reservation.test.js: full maybeAutoSend round trip with the
 * DB and provider mocked, exercising claimAutoSend -> dispatchClaimedSend's
 * new recheck of claim.openTimesSnapshot (threaded from the drafter through
 * draftShadowReply's maybeAutoSend params) immediately before the provider
 * call — the auto-send choke point, distinct from the /sms and /schedule-sms
 * choke point in admin-communications.js (verifyAgentDecisionForSend).
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
}));
jest.mock('../services/sms-graduation', () => ({ evaluateAutoSendEligibility: jest.fn(async () => ({ eligible: true })) }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));

const db = require('../models/db');
const suggest = require('../services/sms-suggest-mode');
const drafter = require('../services/sms-shadow-drafter');
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
  drafter.openTimesStillOffered.mockResolvedValue({ ok: true });
  sendCustomerMessage.mockResolvedValue({
    sent: true, deliveryOutcome: 'accepted', providerMessageId: `SM${'a'.repeat(32)}`,
  });
});

const OPEN_TIMES_SNAPSHOT = {
  lookup: { city: 'Venice', customerId: '00000000-0000-4000-8000-000000000002', estimateId: null },
  quotedWindows: ['9:00 AM - 11:00 AM'],
};

const attempt = (overrides = {}) => autoSend.maybeAutoSend({
  draftId: '00000000-0000-4000-8000-000000000001', customer: { id: '00000000-0000-4000-8000-000000000002' },
  smsLogId: '00000000-0000-4000-8000-000000000003', inboundMessage: 'Hello',
  reply: 'How about 9:00 AM - 11:00 AM?',
  intent: 'general_customer_sms_needs_review', intendedActions: [], actionsVerifiedSafe: true,
  ...overrides,
});

test('no openTimesSnapshot on the draft → recheck never runs, sends normally (no-times draft unaffected)', async () => {
  await expect(attempt({ reply: 'Sounds good, thanks!' })).resolves.toMatchObject({ sent: true });
  expect(drafter.openTimesStillOffered).not.toHaveBeenCalled();
  expect(sendCustomerMessage).toHaveBeenCalled();
});

test('a quoted slot that is STILL open sends normally', async () => {
  drafter.openTimesStillOffered.mockResolvedValue({ ok: true });
  await expect(attempt({ openTimesSnapshot: OPEN_TIMES_SNAPSHOT })).resolves.toMatchObject({ sent: true });
  expect(drafter.openTimesStillOffered).toHaveBeenCalledWith({
    city: 'Venice', customerId: '00000000-0000-4000-8000-000000000002', estimateId: null,
    quotedWindows: ['9:00 AM - 11:00 AM'],
  });
  expect(sendCustomerMessage).toHaveBeenCalled();
});

test('a quoted slot that is GONE blocks the send, fails the claim, reopens parked suggestions', async () => {
  drafter.openTimesStillOffered.mockResolvedValue({ ok: false, reason: 'open_times_no_longer_offered', goneWindows: ['9:00 AM - 11:00 AM'] });
  await expect(attempt({ openTimesSnapshot: OPEN_TIMES_SNAPSHOT })).resolves.toMatchObject({
    sent: false, reason: 'open_times_no_longer_offered',
  });
  expect(sendCustomerMessage).not.toHaveBeenCalled();
  expect(decisions.update).toHaveBeenCalledWith(expect.objectContaining({ status: autoSend.FAILED_STATUS }));
  expect(suggest.reopenScheduledSuggestions).toHaveBeenCalledWith(expect.objectContaining({ decisionIds: ['parked-1'] }));
});

test('an availability fetch error blocks the send (fail closed)', async () => {
  drafter.openTimesStillOffered.mockResolvedValue({ ok: false, reason: 'open_times_recheck_failed' });
  await expect(attempt({ openTimesSnapshot: OPEN_TIMES_SNAPSHOT })).resolves.toMatchObject({
    sent: false, reason: 'open_times_recheck_failed',
  });
  expect(sendCustomerMessage).not.toHaveBeenCalled();
});

test('an availability timeout blocks the send (fail closed) — same reason code as a fetch error, produced by the drafter primitive', async () => {
  drafter.openTimesStillOffered.mockResolvedValue({ ok: false, reason: 'open_times_recheck_failed' });
  await expect(attempt({ openTimesSnapshot: OPEN_TIMES_SNAPSHOT })).resolves.toMatchObject({
    sent: false, reason: 'open_times_recheck_failed',
  });
  expect(sendCustomerMessage).not.toHaveBeenCalled();
});

test('a reply that dropped every quoted window (edited before send) skips the recheck entirely', async () => {
  await expect(attempt({
    openTimesSnapshot: OPEN_TIMES_SNAPSHOT, reply: "I'll confirm a time and get right back to you.",
  })).resolves.toMatchObject({ sent: true });
  expect(drafter.openTimesStillOffered).not.toHaveBeenCalled();
});
