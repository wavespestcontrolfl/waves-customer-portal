/**
 * agent-decision-send-checks — the one send-time verdict over an Agent
 * Review decision's content (PR #5119 follow-up #6): open-times plan +
 * recheck, follow-up promise, billing amounts. The route only orchestrates.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/sms-shadow-drafter', () => ({
  planOpenTimesRecheck: jest.fn(),
  openTimesStillOffered: jest.fn(),
}));
// slaDraftedAt is kept REAL (only followupPromiseBlockReason is mocked) so
// this suite proves the actual facts_generated_at → created_at fallback the
// seam relies on (Codex #5194 P2), not a stand-in.
jest.mock('../services/sms-followup-sla', () => ({
  ...jest.requireActual('../services/sms-followup-sla'),
  followupPromiseBlockReason: jest.fn(() => null),
}));
jest.mock('../services/sms-amount-recheck', () => ({ outgoingAmountsStale: jest.fn(async () => ({ stale: false })) }));
jest.mock('../services/sms-eta-freshness', () => ({ etaClaimBlockReason: jest.fn(async () => null) }));
jest.mock('../models/db', () => jest.fn());
const db = require('../models/db');
const drafter = require('../services/sms-shadow-drafter');
const { followupPromiseBlockReason } = require('../services/sms-followup-sla');
const { outgoingAmountsStale } = require('../services/sms-amount-recheck');
const { etaClaimBlockReason } = require('../services/sms-eta-freshness');
const { agentDecisionSendBlockReason, parseInputSnapshot, scheduledEtaBlockReason } = require('../services/agent-decision-send-checks');

const SNAP = { open_times_snapshot: { lookup: { city: 'Venice', customerId: 'c1', estimateId: null, serviceType: 'Lawn Care' }, quotedWindows: [{ date: 'Tuesday, September 29', window: '9:00 AM - 11:00 AM' }] } };
const decision = (over = {}) => ({ id: 'd1', customer_id: 'c1', suggested_message: 'How about Tuesday 9:00 AM - 11:00 AM?', input_snapshot: JSON.stringify(SNAP), prompt_version: 'house_voice_v12_real_answers', ...over });

beforeEach(() => {
  drafter.planOpenTimesRecheck.mockReset().mockReturnValue({ action: 'recheck', quotedWindows: SNAP.open_times_snapshot.quotedWindows });
  drafter.openTimesStillOffered.mockReset().mockResolvedValue({ ok: true });
  followupPromiseBlockReason.mockReset().mockReturnValue(null);
  outgoingAmountsStale.mockReset().mockResolvedValue({ stale: false });
  etaClaimBlockReason.mockReset().mockResolvedValue(null);
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

// LIVE ETA (independent review + Codex round-1 finding, PR #5334): checked
// last, after open times/follow-up/amounts all pass, and fed the decision's
// own live_eta_snapshot + facts_generated_at straight from its snapshot.
describe('LIVE ETA send-time recheck', () => {
  test('a stale/blocked LIVE ETA refuses the send with its reason', async () => {
    etaClaimBlockReason.mockResolvedValue('eta_claim_no_longer_en_route');
    await expect(agentDecisionSendBlockReason({ decision: decision(), outgoingBody: 'The tech is 12 minutes away.' }))
      .resolves.toBe('live ETA unsendable (eta_claim_no_longer_en_route)');
  });

  test('a clean LIVE ETA recheck falls through to null like every other passing check', async () => {
    await expect(agentDecisionSendBlockReason({ decision: decision(), outgoingBody: 'The tech is 12 minutes away.' })).resolves.toBeNull();
  });

  test('the recheck receives the decision\'s own live_eta_snapshot and facts_generated_at', async () => {
    await agentDecisionSendBlockReason({
      decision: decision({
        input_snapshot: JSON.stringify({ ...SNAP, live_eta_snapshot: { entries: [{ minutes: 12, scheduledServiceIds: ['svc-1'] }] }, facts_generated_at: '2026-09-29T14:00:00.000Z' }),
      }),
      outgoingBody: 'The tech is 12 minutes away.',
    });
    expect(etaClaimBlockReason).toHaveBeenCalledWith(expect.objectContaining({
      liveEtaSnapshot: { entries: [{ minutes: 12, scheduledServiceIds: ['svc-1'] }] },
      factsGeneratedAt: '2026-09-29T14:00:00.000Z',
      outgoingBody: 'The tech is 12 minutes away.',
    }));
  });

  test('an earlier failing check (open times) short-circuits before the ETA recheck ever runs', async () => {
    drafter.planOpenTimesRecheck.mockReturnValue({ action: 'refuse', reason: 'edited_offer_text' });
    await agentDecisionSendBlockReason({ decision: decision(), outgoingBody: 'x' });
    expect(etaClaimBlockReason).not.toHaveBeenCalled();
  });
});

// The scheduler's queued-send path (Codex round-10 P2, PR #5334): one flat
// call into this same ETA check, reading the claimed decision row itself.
describe('scheduledEtaBlockReason — the scheduler seam over the same ETA check', () => {
  const rowFor = (row) => { db.mockImplementation(() => ({ where: () => ({ first: async () => row }) })); };

  test('reads the decision row and hands its live_eta_snapshot + facts_generated_at to the shared check', async () => {
    rowFor({ input_snapshot: { live_eta_snapshot: { entries: [{ minutes: 12, scheduledServiceIds: ['svc-1'] }] }, facts_generated_at: '2026-09-29T14:00:00.000Z' } });
    etaClaimBlockReason.mockResolvedValue('eta_claim_stale_facts');
    await expect(scheduledEtaBlockReason({ decisionId: 'd1', outgoingBody: 'The tech is 12 minutes away.' })).resolves.toBe('eta_claim_stale_facts');
    expect(etaClaimBlockReason).toHaveBeenCalledWith(expect.objectContaining({
      liveEtaSnapshot: { entries: [{ minutes: 12, scheduledServiceIds: ['svc-1'] }] },
      factsGeneratedAt: '2026-09-29T14:00:00.000Z',
    }));
  });

  test('a JSON-string snapshot is parsed; a clean recheck returns null', async () => {
    rowFor({ input_snapshot: JSON.stringify({ facts_generated_at: '2026-09-29T14:00:00.000Z' }) });
    await expect(scheduledEtaBlockReason({ decisionId: 'd1', outgoingBody: 'Thanks!' })).resolves.toBeNull();
  });

  test('skip: an earlier revalidation already blocked — no read, no recheck', async () => {
    db.mockClear();
    await expect(scheduledEtaBlockReason({ decisionId: 'd1', outgoingBody: 'x', skip: true })).resolves.toBeNull();
    expect(db).not.toHaveBeenCalled();
    expect(etaClaimBlockReason).not.toHaveBeenCalled();
  });

  test('fails CLOSED when the row read throws', async () => {
    db.mockImplementation(() => { throw new Error('db down'); });
    await expect(scheduledEtaBlockReason({ decisionId: 'd1', outgoingBody: 'x' })).resolves.toBe('eta_recheck_failed');
  });
});
