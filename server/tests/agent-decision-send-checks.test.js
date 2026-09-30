/**
 * agent-decision-send-checks — the one send-time verdict over an Agent
 * Review decision's content (PR #5119 follow-up #6): open-times plan +
 * recheck, follow-up promise, billing amounts. The route only orchestrates.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/sms-shadow-drafter', () => ({
  planOpenTimesRecheck: jest.fn(),
  openTimesStillOffered: jest.fn(),
  reservicePromiseStillEligible: jest.fn(),
}));
// slaDraftedAt is kept REAL (only followupPromiseBlockReason is mocked) so
// this suite proves the actual facts_generated_at → created_at fallback the
// seam relies on (Codex #5194 P2), not a stand-in.
jest.mock('../services/sms-followup-sla', () => ({
  ...jest.requireActual('../services/sms-followup-sla'),
  followupPromiseBlockReason: jest.fn(() => null),
}));
jest.mock('../services/sms-amount-recheck', () => ({ outgoingAmountsStale: jest.fn(async () => ({ stale: false })) }));
const drafter = require('../services/sms-shadow-drafter');
const { followupPromiseBlockReason } = require('../services/sms-followup-sla');
const { outgoingAmountsStale } = require('../services/sms-amount-recheck');
const { agentDecisionSendBlockReason, parseInputSnapshot } = require('../services/agent-decision-send-checks');

const SNAP = { open_times_snapshot: { lookup: { city: 'Venice', customerId: 'c1', estimateId: null, serviceType: 'Lawn Care' }, quotedWindows: [{ date: 'Tuesday, September 29', window: '9:00 AM - 11:00 AM' }] } };
const decision = (over = {}) => ({ id: 'd1', customer_id: 'c1', suggested_message: 'How about Tuesday 9:00 AM - 11:00 AM?', input_snapshot: JSON.stringify(SNAP), prompt_version: 'house_voice_v12_real_answers', ...over });

beforeEach(() => {
  drafter.planOpenTimesRecheck.mockReset().mockReturnValue({ action: 'recheck', quotedWindows: SNAP.open_times_snapshot.quotedWindows });
  drafter.openTimesStillOffered.mockReset().mockResolvedValue({ ok: true });
  followupPromiseBlockReason.mockReset().mockReturnValue(null);
  outgoingAmountsStale.mockReset().mockResolvedValue({ stale: false });
  drafter.reservicePromiseStillEligible.mockReset().mockResolvedValue(null);
});

test('parseInputSnapshot: string, object, malformed, absent', () => {
  expect(parseInputSnapshot(JSON.stringify({ a: 1 }))).toEqual({ a: 1 });
  expect(parseInputSnapshot({ a: 1 })).toEqual({ a: 1 });
  expect(parseInputSnapshot('{nope')).toBeNull();
  expect(parseInputSnapshot(null)).toBeNull();
});

test('everything passes → null; the recheck carries the snapshot lookup including serviceType', async () => {
  await expect(agentDecisionSendBlockReason({ decision: decision(), outgoingBody: 'How about Tuesday 9:00 AM - 11:00 AM?' })).resolves.toBeNull();
  expect(drafter.openTimesStillOffered).toHaveBeenCalledWith(expect.objectContaining({ city: 'Venice', customerId: 'c1', serviceType: 'Lawn Care' }));
  expect(outgoingAmountsStale).toHaveBeenCalledWith({ customerId: 'c1', body: 'How about Tuesday 9:00 AM - 11:00 AM?', promptVersion: 'house_voice_v12_real_answers' });
});

test('a scheduler-minted snapshot forwards its scheduledServiceId to the recheck (GATE_SMS_OFFERS_SCHEDULER)', async () => {
  const snap = { open_times_snapshot: { ...SNAP.open_times_snapshot, lookup: { ...SNAP.open_times_snapshot.lookup, scheduledServiceId: 'ss-1', source: 'scheduler' } } };
  await agentDecisionSendBlockReason({ decision: decision({ input_snapshot: JSON.stringify(snap) }), outgoingBody: 'How about Tuesday 9:00 AM - 11:00 AM?' });
  expect(drafter.openTimesStillOffered).toHaveBeenCalledWith(expect.objectContaining({ city: 'Venice', scheduledServiceId: 'ss-1' }));
  // a legacy snapshot carries no such key at all
  drafter.openTimesStillOffered.mockClear();
  await agentDecisionSendBlockReason({ decision: decision(), outgoingBody: 'How about Tuesday 9:00 AM - 11:00 AM?' });
  expect(drafter.openTimesStillOffered.mock.calls[0][0]).not.toHaveProperty('scheduledServiceId');
});

test('a /book or estimate snapshot forwards its source (+ serviceKey) to the recheck; a legacy snapshot carries neither', async () => {
  const withLookup = (extra) => JSON.stringify({ open_times_snapshot: { ...SNAP.open_times_snapshot, lookup: { ...SNAP.open_times_snapshot.lookup, ...extra } } });
  await agentDecisionSendBlockReason({ decision: decision({ input_snapshot: withLookup({ source: 'book', serviceKey: 'lawn_care' }) }), outgoingBody: 'How about Tuesday 9:00 AM - 11:00 AM?' });
  expect(drafter.openTimesStillOffered).toHaveBeenCalledWith(expect.objectContaining({ source: 'book', serviceKey: 'lawn_care' }));
  drafter.openTimesStillOffered.mockClear();
  await agentDecisionSendBlockReason({ decision: decision({ input_snapshot: withLookup({ estimateId: 'est-1', source: 'estimate' }) }), outgoingBody: 'How about Tuesday 9:00 AM - 11:00 AM?' });
  expect(drafter.openTimesStillOffered).toHaveBeenCalledWith(expect.objectContaining({ source: 'estimate', estimateId: 'est-1' }));
  drafter.openTimesStillOffered.mockClear();
  await agentDecisionSendBlockReason({ decision: decision(), outgoingBody: 'How about Tuesday 9:00 AM - 11:00 AM?' });
  expect(drafter.openTimesStillOffered.mock.calls[0][0]).not.toHaveProperty('source');
  expect(drafter.openTimesStillOffered.mock.calls[0][0]).not.toHaveProperty('serviceKey');
});

test('an unverifiable edit refuses before any availability call', async () => {
  drafter.planOpenTimesRecheck.mockReturnValue({ action: 'refuse', reason: 'edited_offer_text' });
  await expect(agentDecisionSendBlockReason({ decision: decision(), outgoingBody: 'x' })).resolves.toBe('open-times unverifiable after edit (edited_offer_text)');
  expect(drafter.openTimesStillOffered).not.toHaveBeenCalled();
});

test('the follow-up check receives the decision\'s draft time so a passed deadline can refuse', async () => {
  await agentDecisionSendBlockReason({ decision: decision({ created_at: '2026-09-28T14:00:00Z' }), outgoingBody: 'x' });
  expect(followupPromiseBlockReason).toHaveBeenCalledWith(expect.objectContaining({ draftedAt: '2026-09-28T14:00:00Z' }));
});

// Codex #5194 P2: the SLA phrase is rendered off the drafter's OWN
// facts-generated instant, which can predate created_at (the row lands only
// after the full draft→verify→revise loop) — slaDraftedAt prefers it.
test('a decision carrying facts_generated_at anchors the follow-up check on it, not on created_at', async () => {
  await agentDecisionSendBlockReason({
    decision: decision({
      created_at: '2026-09-28T14:00:00Z',
      input_snapshot: JSON.stringify({ ...SNAP, facts_generated_at: '2026-09-28T13:45:00.000Z' }),
    }),
    outgoingBody: 'x',
  });
  expect(followupPromiseBlockReason).toHaveBeenCalledWith(
    expect.objectContaining({ draftedAt: new Date('2026-09-28T13:45:00.000Z') })
  );
});

// A legacy row (drafted before this change) or one whose caller predates the
// field carries no facts_generated_at at all — the check still runs off
// created_at exactly as before.
test('a decision with no facts_generated_at (legacy row) falls back to created_at', async () => {
  await agentDecisionSendBlockReason({
    decision: decision({ created_at: '2026-09-28T14:00:00Z', input_snapshot: JSON.stringify(SNAP) }),
    outgoingBody: 'x',
  });
  expect(followupPromiseBlockReason).toHaveBeenCalledWith(expect.objectContaining({ draftedAt: '2026-09-28T14:00:00Z' }));
});

test('a gone slot, a stale/edited follow-up promise, or a stale amount each refuse with its reason', async () => {
  drafter.openTimesStillOffered.mockResolvedValue({ ok: false, reason: 'open_times_no_longer_offered' });
  await expect(agentDecisionSendBlockReason({ decision: decision(), outgoingBody: 'x' })).resolves.toBe('open-times stale (open_times_no_longer_offered)');
  drafter.openTimesStillOffered.mockResolvedValue({ ok: true });
  followupPromiseBlockReason.mockReturnValue('sla_phrase_edited');
  await expect(agentDecisionSendBlockReason({ decision: decision(), outgoingBody: 'x' })).resolves.toBe('follow-up promise unsendable (sla_phrase_edited)');
  followupPromiseBlockReason.mockReturnValue(null);
  outgoingAmountsStale.mockResolvedValue({ stale: true, reason: 'amount_no_longer_authorized' });
  await expect(agentDecisionSendBlockReason({ decision: decision(), outgoingBody: 'x' })).resolves.toBe('amount no longer authorized (amount_no_longer_authorized)');
});

test('no snapshot → no availability call; an older-prompt decision skips the amount recheck', async () => {
  await expect(agentDecisionSendBlockReason({ decision: decision({ input_snapshot: JSON.stringify({}), prompt_version: 'house_voice_v11' }), outgoingBody: 'You owe $5.' })).resolves.toBeNull();
  expect(drafter.openTimesStillOffered).not.toHaveBeenCalled();
  expect(outgoingAmountsStale).not.toHaveBeenCalled();
});

// Codex round-3 P2: a reviewed card can promise a free re-service and then
// sit long enough for the customer's eligibility to change before it fires
// — reservicePromiseStillEligible revalidates against LIVE eligibility,
// keyed on the lane(s) recorded at draft time.
describe('re-service promise revalidation (Codex round-3 P2)', () => {
  const reserviceSnapshot = { reservice_lanes_snapshot: ['pest'] };

  test('a reservice-eligible send passes the recorded lane(s) + customer through to the live check', async () => {
    await expect(agentDecisionSendBlockReason({
      decision: decision({ input_snapshot: JSON.stringify({ ...SNAP, ...reserviceSnapshot }) }),
      outgoingBody: "Good news — we'll send your free re-service link now.",
    })).resolves.toBeNull();
    expect(drafter.reservicePromiseStillEligible).toHaveBeenCalledWith({
      outgoingBody: "Good news — we'll send your free re-service link now.",
      customerId: 'c1',
      promisedLanes: ['pest'],
      decisionMeta: { promptVersion: 'house_voice_v12_real_answers', draftId: null, intendedActions: null, bookedCallbacks: null, inboundMessage: null },
    });
  });

  test('no longer eligible → refuses with the reason', async () => {
    drafter.reservicePromiseStillEligible.mockResolvedValue('no longer eligible for a free pest re-service');
    await expect(agentDecisionSendBlockReason({
      decision: decision({ input_snapshot: JSON.stringify({ ...SNAP, ...reserviceSnapshot }) }),
      outgoingBody: "Good news — we'll send your free re-service link now.",
    })).resolves.toBe('re-service promise unsendable (no longer eligible for a free pest re-service)');
  });

  test('runs only after open-times/follow-up/amounts already passed (fail-fast ordering)', async () => {
    drafter.openTimesStillOffered.mockResolvedValue({ ok: false, reason: 'open_times_no_longer_offered' });
    drafter.reservicePromiseStillEligible.mockResolvedValue('no longer eligible for a free pest re-service');
    await expect(agentDecisionSendBlockReason({
      decision: decision({ input_snapshot: JSON.stringify({ ...SNAP, ...reserviceSnapshot }) }),
      outgoingBody: 'x',
    })).resolves.toBe('open-times stale (open_times_no_longer_offered)');
    expect(drafter.reservicePromiseStillEligible).not.toHaveBeenCalled();
  });

  test('an ordinary body with no re-service promise and no snapshot still resolves the live check (no-op) with promisedLanes null', async () => {
    await expect(agentDecisionSendBlockReason({ decision: decision(), outgoingBody: 'You owe $5.' })).resolves.toBeNull();
    expect(drafter.reservicePromiseStillEligible).toHaveBeenCalledWith({
      outgoingBody: 'You owe $5.',
      customerId: 'c1',
      promisedLanes: null,
      decisionMeta: { promptVersion: 'house_voice_v12_real_answers', draftId: null, intendedActions: null, bookedCallbacks: null, inboundMessage: null },
    });
  });
});
