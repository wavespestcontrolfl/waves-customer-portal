/**
 * Auto-send booked re-service callback recheck (Codex round-43 P2). A reply that REFERS to an already-booked callback carries no
 * escalate action, so it auto-sends; the booked snapshot rides the claim and is rechecked live before provider entry (and as the
 * ordinary lane's providerPreSendCheck). Harness copied from sms-auto-send-open-times.test.js.
 * (Original harness note: Auto-send OPEN TIMES send-time recheck (Codex P2). Same harness as
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
  // the amount pattern sms-amount-recheck reads off the drafter (bodyAmountCents); without it every body looks amount-bearing and
  // takes the billing-fingerprint boundary check (PR #5331 round 49)
  AMOUNT_MASK_RE: /\$\s?\d[\d,]*(?:\.\d{1,2})?/g,
  reserviceBookedReferenceBlock: jest.fn(async () => null),
  resolveEffectiveVoiceProfile: jest.fn(async () => ({ version: null })),
  openTimesStillOffered: jest.fn(async () => ({ ok: true })),
  // LIVE ETA send-time recheck (PR #5334) runs on every dispatchClaimedSend call — see
  // sms-auto-send-reservation.test.js's identical mock comment.
  findEtaMinutesClaims: jest.fn(() => []),
  bodyMentionsArrival: jest.fn(() => false),
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
  drafter.reserviceBookedReferenceBlock.mockReset();
  drafter.reserviceBookedReferenceBlock.mockResolvedValue(null);
  sendCustomerMessage.mockResolvedValue({
    sent: true, deliveryOutcome: 'accepted', providerMessageId: `SM${'a'.repeat(32)}`,
  });
});

const BOOKED = { pest: { date: '2026-10-08', windowStart: '09:00' } };
const REPLY = 'Your pest re-service is scheduled for Thursday, 9-11 AM.';

const attempt = (overrides = {}) => autoSend.maybeAutoSend({
  draftId: '00000000-0000-4000-8000-000000000001', customer: { id: '00000000-0000-4000-8000-000000000002' },
  smsLogId: '00000000-0000-4000-8000-000000000003', inboundMessage: 'The ants are back',
  reply: REPLY, reserviceBookedSnapshot: BOOKED,
  intent: 'general_customer_sms_needs_review', intendedActions: [], actionsVerifiedSafe: true,
  ...overrides,
});

test('the booked snapshot is persisted on the claim decision (input_snapshot.reservice_booked_snapshot)', async () => {
  await expect(attempt()).resolves.toMatchObject({ sent: true });
  const inserted = JSON.parse(decisions.insert.mock.calls[0][0].input_snapshot);
  expect(inserted.reservice_booked_snapshot).toEqual(BOOKED);
  // none booked → no key
  decisions.insert.mockClear();
  await attempt({ reserviceBookedSnapshot: {}, reply: 'Sounds good, thanks!' });
  expect(JSON.parse(decisions.insert.mock.calls[0][0].input_snapshot)).not.toHaveProperty('reservice_booked_snapshot');
});

test('a still-live booked callback sends normally; the live check gets the exact body, customer and snapshot', async () => {
  drafter.reserviceBookedReferenceBlock.mockResolvedValue(null);
  await expect(attempt()).resolves.toMatchObject({ sent: true });
  expect(drafter.reserviceBookedReferenceBlock).toHaveBeenCalledWith({ body: REPLY, customerId: '00000000-0000-4000-8000-000000000002', booked: BOOKED });
  expect(sendCustomerMessage).toHaveBeenCalled();
});

test('a cancelled / moved booked callback blocks the send BEFORE provider entry, fails the claim, reopens parked suggestions', async () => {
  drafter.reserviceBookedReferenceBlock.mockResolvedValue('reservice_booking_changed — the already-booked pest re-service appointment was cancelled, moved or never booked since this reply was drafted');
  await expect(attempt()).resolves.toMatchObject({ sent: false, reason: 'reservice_booking_changed' });
  expect(sendCustomerMessage).not.toHaveBeenCalled();
  expect(decisions.update).toHaveBeenCalledWith(expect.objectContaining({ status: autoSend.FAILED_STATUS }));
  expect(suggest.reopenScheduledSuggestions).toHaveBeenCalledWith(expect.objectContaining({ decisionIds: ['parked-1'] }));
});

test('the ordinary lane also hands the provider boundary a providerPreSendCheck that re-runs the live check (last await before the request)', async () => {
  drafter.reserviceBookedReferenceBlock.mockResolvedValue(null);
  await attempt();
  const input = sendCustomerMessage.mock.calls[0][0];
  expect(typeof input.providerPreSendCheck).toBe('function');
  await expect(input.providerPreSendCheck({ dbi: db })).resolves.toEqual({ ok: true });
  drafter.reserviceBookedReferenceBlock.mockResolvedValue('reservice_booking_changed — moved');
  await expect(input.providerPreSendCheck({ dbi: db })).resolves.toMatchObject({ ok: false, code: 'reservice_booking_changed' });
});

test('a live-check error fails the send closed (nothing reaches the provider)', async () => {
  drafter.reserviceBookedReferenceBlock.mockRejectedValue(new Error('db down'));
  await expect(attempt()).resolves.toMatchObject({ sent: false });
  expect(sendCustomerMessage).not.toHaveBeenCalled();
});

// Codex #5334 P2 (after the main merge): the booked-callback guard must be the LAST recheck. The live-ETA recheck is an async read, so booking
// state that changes while it is in flight has to still be caught — in dispatchClaimedSend and at the provider boundary (incl. the repeat after
// the durable attempt marker).
describe('booked-callback guard runs AFTER every async ETA recheck', () => {
  const eta = require('../services/sms-eta-freshness');
  const CHANGED = 'reservice_booking_changed — the already-booked pest re-service appointment was cancelled, moved or never booked since this reply was drafted';
  afterEach(() => jest.restoreAllMocks());

  test('dispatchClaimedSend: a booking cancelled DURING the ETA await still blocks the send before provider entry', async () => {
    drafter.reserviceBookedReferenceBlock.mockResolvedValue(null);
    jest.spyOn(eta, 'etaClaimBlockReason').mockImplementation(async () => {
      await new Promise((r) => setImmediate(r));
      drafter.reserviceBookedReferenceBlock.mockResolvedValue(CHANGED); // customer cancels while the ETA read is in flight
      return null;
    });
    await expect(attempt()).resolves.toMatchObject({ sent: false, reason: 'reservice_booking_changed' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(decisions.update).toHaveBeenCalledWith(expect.objectContaining({ status: autoSend.FAILED_STATUS }));
  });

  test('dispatchClaimedSend: an ETA infrastructure failure is still the retryable release (not a booked refusal)', async () => {
    drafter.reserviceBookedReferenceBlock.mockResolvedValue(CHANGED);
    jest.spyOn(eta, 'etaClaimBlockReason').mockResolvedValue('eta_recheck_failed');
    await expect(attempt()).resolves.toMatchObject({ sent: false, retryable: true });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('provider boundary: ETA runs first, the booked check last, and a cancellation during the ETA read is refused', async () => {
    drafter.reserviceBookedReferenceBlock.mockResolvedValue(null);
    await attempt();
    const input = sendCustomerMessage.mock.calls[0][0];
    const order = [];
    drafter.reserviceBookedReferenceBlock.mockImplementation(async () => { order.push('booked'); return null; });
    jest.spyOn(eta, 'etaClaimBlockReason').mockImplementation(async () => {
      order.push('eta');
      await new Promise((r) => setImmediate(r));
      return null;
    });
    await expect(input.providerPreSendCheck({ dbi: db })).resolves.toEqual({ ok: true });
    expect(order).toEqual(['eta', 'booked']);

    drafter.reserviceBookedReferenceBlock.mockImplementation(async () => CHANGED);
    await expect(input.providerPreSendCheck({ dbi: db })).resolves.toMatchObject({ ok: false, code: 'reservice_booking_changed' });
    // and an ETA failure still reports its own retryable boundary code, ahead of the booked verdict
    eta.etaClaimBlockReason.mockResolvedValue('eta_recheck_failed');
    await expect(input.providerPreSendCheck({ dbi: db })).resolves.toMatchObject({ ok: false, code: 'LIVE_ETA_CHECK_FAILED_AT_BOUNDARY', retryable: true });
  });

  test('provider boundary: the repeat after the attempt marker re-runs ETA then booked, so a cancellation after the first pass is still caught', async () => {
    drafter.reserviceBookedReferenceBlock.mockResolvedValue(null);
    await attempt();
    const input = sendCustomerMessage.mock.calls[0][0];
    expect(typeof input.providerPreSendCheck.afterMarker).toBe('function');
    const order = [];
    drafter.reserviceBookedReferenceBlock.mockImplementation(async () => { order.push('booked'); return null; });
    jest.spyOn(eta, 'etaClaimBlockReason').mockImplementation(async () => { order.push('eta'); return null; });
    await expect(input.providerPreSendCheck.afterMarker({ dbi: db })).resolves.toEqual({ ok: true });
    expect(order).toEqual(['eta', 'booked']);
    drafter.reserviceBookedReferenceBlock.mockImplementation(async () => CHANGED);
    await expect(input.providerPreSendCheck.afterMarker({ dbi: db })).resolves.toMatchObject({ ok: false, code: 'reservice_booking_changed' });
  });
});
