/**
 * Auto-send LABEL FACTS send-time recheck (exact-sentence contract, D). Same
 * harness as sms-auto-send-open-times.test.js: a reply that copied a LABEL
 * FACTS sentence carries a label_facts_snapshot from the drafter; the claim
 * persists it on the decision and dispatchClaimedSend re-verifies it against
 * the customer's CURRENT latest performed visit immediately before the provider
 * call, refusing the same way the open-times recheck does. The recheck itself
 * (visit changed / today guard / changed label) is tested in sms-label-facts.test.js.
 */
jest.mock('../services/sms-label-facts', () => ({ labelFactsSendBlockReason: jest.fn(async () => null) }));
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
  // LIVE ETA send-time recheck (PR #5334) runs on every dispatchClaimedSend call; same
  // "this reply never claims an ETA" defaults as sms-auto-send-open-times.test.js.
  findEtaMinutesClaims: jest.fn(() => []),
  bodyMentionsArrival: jest.fn(() => false),
  bodyMentionsVisitStatus: jest.fn(() => false),
  bodyHasTimedArrivalPhrase: jest.fn(() => false),
  bodyHasUnclassifiedArrivalDigit: jest.fn(() => false),
  findGroundedMinutesFigures: jest.fn(() => []),
}));
jest.mock('../services/sms-graduation', () => ({ evaluateAutoSendEligibility: jest.fn(async () => ({ eligible: true })) }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));

const db = require('../models/db');
const suggest = require('../services/sms-suggest-mode');
const drafter = require('../services/sms-shadow-drafter');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const autoSend = require('../services/sms-auto-send');
const labelFacts = require('../services/sms-label-facts');
let decisions;

function chain(overrides = {}) {
  const q = {};
  for (const method of ['where', 'whereRaw', 'leftJoin', 'insert', 'onConflict', 'ignore']) q[method] = jest.fn(() => q);
  q.first = jest.fn(async () => null);
  q.returning = jest.fn(async () => [{ id: 'claim-1' }]);
  q.update = jest.fn(async () => 1);
  q.del = jest.fn(async () => 1);
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
  labelFacts.labelFactsSendBlockReason.mockResolvedValue(null);
  sendCustomerMessage.mockResolvedValue({
    sent: true, deliveryOutcome: 'accepted', providerMessageId: `SM${'a'.repeat(32)}`,
  });
});

const REPLY = "For the products applied at your Sep 29 visit, the label says to keep people and pets off treated areas for 4 hours.";
const LABEL_SNAPSHOT = {
  customer_id: '00000000-0000-4000-8000-000000000002', visit_date: '2026-09-29', record_ids: ['r2'], sentences: [REPLY],
};

const attempt = (overrides = {}) => autoSend.maybeAutoSend({
  draftId: '00000000-0000-4000-8000-000000000001', customer: { id: '00000000-0000-4000-8000-000000000002' },
  smsLogId: '00000000-0000-4000-8000-000000000003', inboundMessage: 'How long until the dogs can go out?',
  reply: REPLY,
  intent: 'general_customer_sms_needs_review', intendedActions: [], actionsVerifiedSafe: true,
  ...overrides,
});

test('the label source is persisted on the claimed decision next to the other send-time snapshots', async () => {
  await attempt({ labelFactsSnapshot: LABEL_SNAPSHOT });
  const inserted = decisions.insert.mock.calls[0][0];
  expect(JSON.parse(inserted.input_snapshot).label_facts_snapshot).toEqual(LABEL_SNAPSHOT);
  decisions.insert.mockClear();
  await attempt({});
  expect(JSON.parse(decisions.insert.mock.calls[0][0].input_snapshot)).not.toHaveProperty('label_facts_snapshot');
});

test('a snapshot that is still current sends normally; the recheck reads the body that will go out', async () => {
  await expect(attempt({ labelFactsSnapshot: LABEL_SNAPSHOT })).resolves.toMatchObject({ sent: true });
  expect(labelFacts.labelFactsSendBlockReason).toHaveBeenCalledWith({ snapshot: LABEL_SNAPSHOT, body: REPLY, inbound: 'How long until the dogs can go out?' });
  expect(sendCustomerMessage).toHaveBeenCalled();
});

test('no label snapshot (the reply copies no label sentence) -> the recheck never runs', async () => {
  await expect(attempt({ reply: 'Sounds good, thanks!' })).resolves.toMatchObject({ sent: true });
  expect(labelFacts.labelFactsSendBlockReason).not.toHaveBeenCalled();
});

test.each(['label_facts_visit_changed', 'label_facts_no_longer_current', 'label_facts_changed'])(
  'a recheck that refuses (%s) blocks the send, fails the claim and reopens parked suggestions',
  async (reason) => {
    labelFacts.labelFactsSendBlockReason.mockResolvedValue(reason);
    await expect(attempt({ labelFactsSnapshot: LABEL_SNAPSHOT })).resolves.toMatchObject({ sent: false, reason });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(decisions.update).toHaveBeenCalledWith(expect.objectContaining({ status: autoSend.FAILED_STATUS }));
    expect(suggest.reopenScheduledSuggestions).toHaveBeenCalledWith(expect.objectContaining({ decisionIds: ['parked-1'] }));
  },
);

describe('r29: EVERY real-answers auto-send dispatch runs the label reply guard, with the customer\'s own text', () => {
  const REAL = 'house_voice_v12_x';
  const actual = () => jest.requireActual('../services/sms-label-facts').labelFactsSendBlockReason;
  test('no snapshot: a bare "Yes, they can go out." to a label question is blocked at dispatch', async () => {
    labelFacts.labelFactsSendBlockReason.mockImplementation((args) => actual()({ ...args, conn: () => { throw new Error('must not read'); } }));
    await expect(attempt({ reply: 'Yes, they can go out.', promptVersion: REAL, inboundMessage: 'Can the dogs go out now?' })).resolves.toMatchObject({ sent: false, reason: 'label_facts_unauthorized_claim' });
    expect(labelFacts.labelFactsSendBlockReason).toHaveBeenCalledWith({ snapshot: null, body: 'Yes, they can go out.', inbound: 'Can the dogs go out now?' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(decisions.update).toHaveBeenCalledWith(expect.objectContaining({ status: autoSend.FAILED_STATUS }));
    expect(suggest.reopenScheduledSuggestions).toHaveBeenCalledWith(expect.objectContaining({ decisionIds: ['parked-1'] }));
  });
  test('no snapshot: a hand-off, or any reply to a non-label question, still sends; the guard reads the claim\'s inbound', async () => {
    labelFacts.labelFactsSendBlockReason.mockImplementation((args) => actual()({ ...args, conn: () => { throw new Error('must not read'); } }));
    await expect(attempt({ reply: "I'll have the office confirm and get back to you.", promptVersion: REAL, inboundMessage: 'Can the dogs go out now?' })).resolves.toMatchObject({ sent: true });
    await expect(attempt({ reply: 'Yes, Tuesday works.', promptVersion: REAL, inboundMessage: 'Can you come Tuesday?' })).resolves.toMatchObject({ sent: true });
  });
  test('an older-prompt draft with no snapshot still never runs the recheck (unchanged)', async () => {
    await expect(attempt({ reply: 'Yes, they can go out.', promptVersion: 'house_voice_v8', inboundMessage: 'Can the dogs go out now?' })).resolves.toMatchObject({ sent: true });
    expect(labelFacts.labelFactsSendBlockReason).not.toHaveBeenCalled();
  });
});

// Codex #5416 r31 P2: an unreadable latest visit says nothing about the message - the claim is RELEASED, never failed.
test('a recheck that could not read the visit releases the claim (retryable), reopens parked suggestions, and never fails the decision', async () => {
  labelFacts.labelFactsSendBlockReason.mockResolvedValue('label_facts_recheck_failed');
  await expect(attempt({ labelFactsSnapshot: LABEL_SNAPSHOT })).resolves.toEqual({ sent: false, reason: 'label_facts_recheck_failed', retryable: true });
  expect(sendCustomerMessage).not.toHaveBeenCalled();
  expect(decisions.update).not.toHaveBeenCalledWith(expect.objectContaining({ status: autoSend.FAILED_STATUS }));
  expect(suggest.settleReplyHoldingReservation).toHaveBeenCalled();
  expect(suggest.reopenScheduledSuggestions).toHaveBeenCalledWith(expect.objectContaining({ decisionIds: ['parked-1'] }));
});

// #5520 r1 P2: the label boundary recheck's unreadable-visit refusal releases the claim like the live-ETA one.
test('a LABEL_FACTS_CHECK_FAILED_AT_BOUNDARY provider refusal releases the claim instead of failing it', async () => {
  sendCustomerMessage.mockResolvedValue({ sent: false, deliveryOutcome: 'not_sent', retryable: true, code: 'LABEL_FACTS_CHECK_FAILED_AT_BOUNDARY' });
  await attempt({ labelFactsSnapshot: LABEL_SNAPSHOT });
  expect(decisions.update).not.toHaveBeenCalledWith(expect.objectContaining({ status: autoSend.FAILED_STATUS }));
});

// Codex round-63 P2: a billing / Zelle change at the provider boundary is retryable too - released, never a failed auto-send
test.each(['BILLING_CHANGED_AT_BOUNDARY', 'ZELLE_CHANGED_AT_BOUNDARY'])('a %s provider refusal releases the claim instead of failing it', async (code) => {
  sendCustomerMessage.mockResolvedValue({ sent: false, deliveryOutcome: 'not_sent', retryable: true, code });
  await attempt({ labelFactsSnapshot: LABEL_SNAPSHOT });
  expect(decisions.update).not.toHaveBeenCalledWith(expect.objectContaining({ status: autoSend.FAILED_STATUS }));
});

