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
  // LIVE ETA send-time recheck (PR #5334) runs on every dispatchClaimedSend
  // call — an empty claims list here means "this reply never claims an
  // ETA", so it never reaches the DB/track-transitions leg. See
  // sms-eta-freshness.test.js for that check's own coverage.
  findEtaMinutesClaims: jest.fn(() => []),
  bodyMentionsArrival: jest.fn(() => false),
  // Round-41: with GATE_SMS_REAL_ANSWERS on, the send-time check classifies status wording
  // even without a snapshot, so it now reads this too — "never claims" here as well.
  bodyMentionsVisitStatus: jest.fn(() => false),
  bodyHasTimedArrivalPhrase: jest.fn(() => false),
  bodyHasUnclassifiedArrivalDigit: jest.fn(() => false),
  // Structural default-deny (Codex round-7 P2): sms-eta-freshness.js unions
  // this in whenever there's a snapshot/track link — empty here for the
  // same "never claims an ETA" reason as findEtaMinutesClaims above.
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
  sendCustomerMessage.mockResolvedValue({
    sent: true, deliveryOutcome: 'accepted', providerMessageId: `SM${'a'.repeat(32)}`,
  });
});

const OPEN_TIMES_SNAPSHOT = {
  lookup: { city: 'Venice', customerId: '00000000-0000-4000-8000-000000000002', estimateId: null },
  quotedWindows: [{ date: 'Tuesday, September 29', window: '9:00 AM - 11:00 AM' }],
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
    quotedWindows: [{ date: 'Tuesday, September 29', window: '9:00 AM - 11:00 AM' }],
  });
  expect(sendCustomerMessage).toHaveBeenCalled();
});

test('a scheduler-minted snapshot forwards scheduledServiceId to the recheck (GATE_SMS_OFFERS_SCHEDULER)', async () => {
  drafter.openTimesStillOffered.mockResolvedValue({ ok: true });
  const snap = { ...OPEN_TIMES_SNAPSHOT, lookup: { ...OPEN_TIMES_SNAPSHOT.lookup, scheduledServiceId: 'ss-1', source: 'scheduler' } };
  await expect(attempt({ openTimesSnapshot: snap })).resolves.toMatchObject({ sent: true });
  expect(drafter.openTimesStillOffered).toHaveBeenCalledWith(expect.objectContaining({ scheduledServiceId: 'ss-1' }));
});

test('the snapshot\'s serviceType is forwarded to the recheck when present (Codex r3 audit P1)', async () => {
  drafter.openTimesStillOffered.mockResolvedValue({ ok: true });
  const snap = { ...OPEN_TIMES_SNAPSHOT, lookup: { ...OPEN_TIMES_SNAPSHOT.lookup, serviceType: 'Lawn Fertilization' } };
  await expect(attempt({ openTimesSnapshot: snap })).resolves.toMatchObject({ sent: true });
  expect(drafter.openTimesStillOffered).toHaveBeenCalledWith(expect.objectContaining({ serviceType: 'Lawn Fertilization' }));
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

// PR #5119 Codex r3 P1: a reply that promises the follow-up SLA must be
// OWNED by an escalate action, or nobody works the promise. Deterministic at
// the autonomy boundary, independent of the prompt and the LLM verifier.
describe('auto-send refuses an unowned follow-up promise', () => {
  const priorGate = process.env.GATE_SMS_REAL_ANSWERS;
  beforeEach(() => { process.env.GATE_SMS_REAL_ANSWERS = 'true'; });
  afterEach(() => {
    if (priorGate === undefined) delete process.env.GATE_SMS_REAL_ANSWERS;
    else process.env.GATE_SMS_REAL_ANSWERS = priorGate;
  });

  test('gate OFF: the backstop does not run — auto-send is unchanged by this PR', async () => {
    delete process.env.GATE_SMS_REAL_ANSWERS;
    await expect(attempt({ reply: 'Your technician should arrive within the hour.', intendedActions: [] })).resolves.toMatchObject({ sent: true });
  });

  test('an SLA phrase with no escalate action → refused (unowned_followup), provider never called', async () => {
    await expect(attempt({ reply: "I'll check with the office and get back to you within the hour.", intendedActions: [] })).resolves.toMatchObject({
      sent: false, reason: 'unowned_followup',
    });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('the same phrase WITH an escalate action is past this check (stopped later by the action gate, never by this one)', async () => {
    const r = await attempt({ reply: "I'll check with the office and get back to you within the hour.", intendedActions: [{ type: 'escalate', note: 'followup_promised' }] });
    expect(r.reason).not.toBe('unowned_followup');
    expect(sendCustomerMessage).not.toHaveBeenCalled(); // an escalate action is never auto-send-safe
  });

  test('no SLA phrase → unaffected', async () => {
    await expect(attempt({ reply: 'Sounds good, thanks!' })).resolves.toMatchObject({ sent: true });
  });
});

// Codex round-41 P2 (PR #5334): the auto-send executor's ETA check also runs at the TRUE
// provider boundary, from the claim's in-memory snapshot.
describe('auto-send supplies the live-ETA provider-boundary check', () => {
  const sentArgs = () => sendCustomerMessage.mock.calls[0][0];

  test('the provider request carries a providerPreSendCheck that passes for a reply with nothing to recheck', async () => {
    await expect(attempt({ reply: 'Sounds good, thanks!' })).resolves.toMatchObject({ sent: true });
    const { providerPreSendCheck } = sentArgs();
    expect(typeof providerPreSendCheck).toBe('function');
    await expect(providerPreSendCheck({ channel: 'sms' })).resolves.toEqual({ ok: true });
  });

  test('...and refuses (terminal) when the ETA claim is no longer backed by the snapshot at the boundary', async () => {
    await attempt({ reply: 'Sounds good, thanks!' });
    const { providerPreSendCheck } = sentArgs();
    // The claim is now an ETA with no snapshot behind it: the shared check fails closed.
    drafter.findEtaMinutesClaims.mockReturnValue([{ minutes: 9, index: 0 }]);
    try {
      await expect(providerPreSendCheck({ channel: 'sms' })).resolves.toMatchObject({
        ok: false, code: 'LIVE_ETA_STALE_AT_BOUNDARY', reason: 'live ETA unsendable (eta_claim_no_snapshot)',
      });
    } finally {
      drafter.findEtaMinutesClaims.mockReturnValue([]);
    }
  });
});

// Codex round-42 P2 (PR #5334): the draft's technician first name(s) are persisted with the
// decision itself (input_snapshot.tech_names), independent of live entries.
describe('auto-send persists the draft\'s technician names with the claimed decision', () => {
  const insertedSnapshot = () => {
    const row = decisions.insert.mock.calls[0][0];
    return typeof row.input_snapshot === 'string' ? JSON.parse(row.input_snapshot) : row.input_snapshot;
  };
  test('tech_names rides in input_snapshot (names only) and in the claim used for the send-time check', async () => {
    await expect(attempt({ reply: 'Sounds good, thanks!', techNames: ['Sam'] })).resolves.toMatchObject({ sent: true });
    expect(insertedSnapshot().tech_names).toEqual(['Sam']);
  });
  test('no names -> the field is absent (older-decision shape)', async () => {
    await attempt({ reply: 'Sounds good, thanks!' });
    expect('tech_names' in insertedSnapshot()).toBe(false);
  });
});

// Codex round-44 P2 (PR #5334): an unreadable live-ETA recheck is NON-terminal at the auto-send
// executor — the claim is released (never failed), the reservation settled, parked cards reopen.
describe('auto-send: an unreadable ETA recheck releases the claim instead of failing it', () => {
  const SNAP = { entries: [{ minutes: 9, scheduledServiceIds: ['svc-1'], trackTokens: ['tok-1'], state: 'en_route' }] };
  afterEach(() => { drafter.findEtaMinutesClaims.mockReturnValue([]); });

  test('infrastructure failure -> sent:false, retryable, claim row released (deleted), NOT marked auto_send_failed, nothing sent', async () => {
    drafter.findEtaMinutesClaims.mockReturnValue([{ minutes: 9, index: 0 }]);
    // freshness reads scheduled_services through the same mocked db; an unusable handle makes the read throw
    const r = await attempt({ reply: 'The tech is 9 minutes away.', liveEtaSnapshot: SNAP, factsGeneratedAt: new Date() });
    expect(r).toMatchObject({ sent: false, reason: 'eta_claim_recheck_failed', retryable: true });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(decisions.del).toHaveBeenCalledTimes(1);
    expect(decisions.update.mock.calls.some(([patch]) => patch && patch.status === autoSend.FAILED_STATUS)).toBe(false);
    expect(suggest.settleReplyHoldingReservation).toHaveBeenCalledWith({ reservationId: '33333333-3333-4333-8333-333333333333' });
  });

  test('a real verdict (no snapshot behind an ETA claim) still FAILS the claim as before', async () => {
    drafter.findEtaMinutesClaims.mockReturnValue([{ minutes: 9, index: 0 }]);
    const r = await attempt({ reply: 'The tech is 9 minutes away.' });
    expect(r).toMatchObject({ sent: false, reason: 'eta_claim_no_snapshot' });
    expect(r.retryable).toBeUndefined();
    expect(decisions.del).not.toHaveBeenCalled();
    expect(decisions.update.mock.calls.some(([patch]) => patch && patch.status === autoSend.FAILED_STATUS)).toBe(true);
  });
});

// Codex round-46 P2 (PR #5334): a retryable provider-boundary refusal (LIVE_ETA_CHECK_FAILED_AT_BOUNDARY) is released,
// not failed — for BOTH invocations the sender makes (the pre-marker run and the post-marker `afterMarker` re-run).
describe('auto-send: a retryable ETA refusal at the provider boundary releases the claim', () => {
  const SNAP = { entries: [{ minutes: 9, scheduledServiceIds: ['svc-1'], trackTokens: ['tok-1'], state: 'en_route' }] };
  afterEach(() => { drafter.findEtaMinutesClaims.mockReset().mockReturnValue([]); });

  // Mimics twilio.js: turns a predicate verdict into the not-sent result sendCustomerMessage returns.
  const refusalFrom = (verdict) => ({ sent: false, success: false, deliveryOutcome: 'not_sent', preSendBlocked: true, code: verdict.code, reason: verdict.reason, retryable: verdict.retryable === true });
  const released = async (r) => {
    expect(r).toMatchObject({ sent: false, reason: 'LIVE_ETA_CHECK_FAILED_AT_BOUNDARY', retryable: true });
    expect(decisions.del).toHaveBeenCalledTimes(1);
    expect(decisions.update.mock.calls.some(([patch]) => patch && patch.status === autoSend.FAILED_STATUS)).toBe(false);
    expect(suggest.settleReplyHoldingReservation).toHaveBeenCalledWith({ reservationId: '33333333-3333-4333-8333-333333333333' });
  };

  test('pre-marker invocation: the predicate cannot read the state -> released (not auto_send_failed)', async () => {
    // executor's own check passes (no claim), the boundary predicate then sees a claim it cannot verify (db read throws)
    drafter.findEtaMinutesClaims.mockReturnValueOnce([]).mockReturnValue([{ minutes: 9, index: 0 }]);
    sendCustomerMessage.mockImplementationOnce(async (input) => refusalFrom(await input.providerPreSendCheck({ channel: 'sms' })));
    const r = await attempt({ reply: 'The tech is 9 minutes away.', liveEtaSnapshot: SNAP, factsGeneratedAt: new Date() });
    await released(r);
  });

  test('post-marker invocation (afterMarker re-run): the same refusal is released the same way', async () => {
    drafter.findEtaMinutesClaims.mockReturnValueOnce([]).mockReturnValueOnce([]).mockReturnValue([{ minutes: 9, index: 0 }]);
    sendCustomerMessage.mockImplementationOnce(async (input) => {
      const first = await input.providerPreSendCheck({ channel: 'sms' });
      expect(first).toEqual({ ok: true }); // passes before the marker
      expect(typeof input.providerPreSendCheck.afterMarker).toBe('function');
      return refusalFrom(await input.providerPreSendCheck.afterMarker({ channel: 'sms' })); // fails after it
    });
    const r = await attempt({ reply: 'The tech is 9 minutes away.', liveEtaSnapshot: SNAP, factsGeneratedAt: new Date() });
    await released(r);
  });

  test('a TERMINAL boundary refusal (real stale verdict) still fails the claim', async () => {
    sendCustomerMessage.mockImplementationOnce(async () => refusalFrom({ code: 'LIVE_ETA_STALE_AT_BOUNDARY', reason: 'live ETA unsendable (eta_claim_no_longer_en_route)', retryable: false }));
    const r = await attempt({ reply: 'Sounds good, thanks!' });
    expect(r).toMatchObject({ sent: false, reason: 'LIVE_ETA_STALE_AT_BOUNDARY' });
    expect(decisions.del).not.toHaveBeenCalled();
    expect(decisions.update.mock.calls.some(([patch]) => patch && patch.status === autoSend.FAILED_STATUS)).toBe(true);
  });

  test('other retryable refusals (consent lookup, quiet hours) are NOT released by this path — only the ETA boundary code', async () => {
    sendCustomerMessage.mockImplementationOnce(async () => ({ sent: false, deliveryOutcome: 'not_sent', code: 'QUIET_HOURS_HOLD', retryable: true }));
    const r = await attempt({ reply: 'Sounds good, thanks!' });
    expect(r).toMatchObject({ sent: false, reason: 'QUIET_HOURS_HOLD' });
    expect(decisions.del).not.toHaveBeenCalled();
    expect(decisions.update.mock.calls.some(([patch]) => patch && patch.status === autoSend.FAILED_STATUS)).toBe(true);
  });

  test('a refusal that may have reached the provider is never released', async () => {
    sendCustomerMessage.mockImplementationOnce(async () => ({ sent: false, deliveryOutcome: 'uncertain', code: 'LIVE_ETA_CHECK_FAILED_AT_BOUNDARY', retryable: true }));
    const r = await attempt({ reply: 'Sounds good, thanks!' });
    expect(decisions.del).not.toHaveBeenCalled();
    expect(r.reason).not.toBe('LIVE_ETA_CHECK_FAILED_AT_BOUNDARY');
  });
});
