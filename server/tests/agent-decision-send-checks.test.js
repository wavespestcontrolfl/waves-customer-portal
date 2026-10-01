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
jest.mock('../services/sms-eta-freshness', () => ({
  etaClaimBlockReason: jest.fn(async () => null),
  ETA_FRESHNESS_WINDOW_MS: 15 * 60 * 1000,
  // The ONE shared infrastructure-failure set (round-42 P2) is consulted by the wrappers.
  isEtaInfrastructureFailure: (reason) => jest.requireActual('../services/sms-eta-freshness').isEtaInfrastructureFailure(reason),
}));
jest.mock('../models/db', () => jest.fn());
const db = require('../models/db');
const drafter = require('../services/sms-shadow-drafter');
const { followupPromiseBlockReason } = require('../services/sms-followup-sla');
const { outgoingAmountsStale } = require('../services/sms-amount-recheck');
const { etaClaimBlockReason } = require('../services/sms-eta-freshness');
const { agentDecisionSendBlockReason, parseInputSnapshot, scheduledEtaBlockReason, etaProviderPreSendCheck, etaSnapshotProviderPreSendCheck, composeProviderPreSendChecks } = require('../services/agent-decision-send-checks');

const SNAP = { open_times_snapshot: { lookup: { city: 'Venice', customerId: 'c1', estimateId: null, serviceType: 'Lawn Care' }, quotedWindows: [{ date: 'Tuesday, September 29', window: '9:00 AM - 11:00 AM' }] } };
const decision = (over = {}) => ({ id: 'd1', customer_id: 'c1', suggested_message: 'How about Tuesday 9:00 AM - 11:00 AM?', input_snapshot: JSON.stringify(SNAP), prompt_version: 'house_voice_v12_real_answers', ...over });

beforeEach(() => {
  drafter.planOpenTimesRecheck.mockReset().mockReturnValue({ action: 'recheck', quotedWindows: SNAP.open_times_snapshot.quotedWindows });
  drafter.openTimesStillOffered.mockReset().mockResolvedValue({ ok: true });
  followupPromiseBlockReason.mockReset().mockReturnValue(null);
  outgoingAmountsStale.mockReset().mockResolvedValue({ stale: false });
  drafter.reservicePromiseStillEligible.mockReset().mockResolvedValue(null);
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

// Re-service runs BEFORE the ETA recheck (main's order, ETA appended): a failing re-service
// recheck short-circuits, and both checks run on a clean pass.
describe('re-service + LIVE ETA ordering on the same send path', () => {
  test('a re-service refusal short-circuits before the ETA recheck', async () => {
    drafter.reservicePromiseStillEligible.mockResolvedValue('no longer eligible for a free pest re-service');
    await expect(agentDecisionSendBlockReason({ decision: decision(), outgoingBody: 'x' })).resolves.toBe('re-service promise unsendable (no longer eligible for a free pest re-service)');
    expect(etaClaimBlockReason).not.toHaveBeenCalled();
  });

  test('a clean re-service recheck still reaches the ETA recheck', async () => {
    etaClaimBlockReason.mockResolvedValue('eta_claim_no_longer_en_route');
    await expect(agentDecisionSendBlockReason({ decision: decision(), outgoingBody: 'x' })).resolves.toBe('live ETA unsendable (eta_claim_no_longer_en_route)');
    expect(drafter.reservicePromiseStillEligible).toHaveBeenCalled();
  });
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

// Codex round-40 P2 (PR #5334): the same ETA check at the TRUE provider boundary.
describe('etaProviderPreSendCheck / composeProviderPreSendChecks — the provider-boundary predicate', () => {
  const rowFor = (row) => { db.mockImplementation(() => ({ where: () => ({ first: async () => row }) })); };

  test('a clean recheck lets the send through; the body is read lazily at call time', async () => {
    rowFor({ input_snapshot: { facts_generated_at: '2026-09-29T14:00:00.000Z' } });
    let body = 'Thanks!';
    const check = etaProviderPreSendCheck({ decisionId: 'd1', getBody: () => body });
    body = 'The tech is 9 minutes away.'; // rewritten after the check was built (spacing guard)
    await expect(check({ channel: 'sms' })).resolves.toEqual({ ok: true });
    expect(etaClaimBlockReason).toHaveBeenCalledWith(expect.objectContaining({ outgoingBody: 'The tech is 9 minutes away.' }));
  });

  test('a stale ETA at the boundary is a TERMINAL refusal', async () => {
    rowFor({ input_snapshot: { facts_generated_at: '2026-09-29T14:00:00.000Z' } });
    etaClaimBlockReason.mockResolvedValue('eta_claim_no_longer_en_route');
    const verdict = await etaProviderPreSendCheck({ decisionId: 'd1', getBody: () => 'The tech is 9 minutes away.' })();
    expect(verdict).toEqual({ ok: false, code: 'LIVE_ETA_STALE_AT_BOUNDARY', reason: 'live ETA unsendable (eta_claim_no_longer_en_route)' });
  });

  test('an unreadable recheck is RETRYABLE (never sent unverified, never terminal)', async () => {
    db.mockImplementation(() => { throw new Error('db down'); });
    const verdict = await etaProviderPreSendCheck({ decisionId: 'd1', getBody: () => 'x' })();
    expect(verdict).toMatchObject({ ok: false, code: 'LIVE_ETA_CHECK_FAILED_AT_BOUNDARY', retryable: true });
  });

  test('compose: undefined entries are skipped; nothing to run -> undefined; the first refusal wins and later checks do not run', async () => {
    expect(composeProviderPreSendChecks(undefined, undefined)).toBeUndefined();
    const only = jest.fn(async () => ({ ok: true }));
    expect(composeProviderPreSendChecks(undefined, only)).toBe(only);
    const first = jest.fn(async () => ({ ok: false, code: 'FIRST' }));
    const second = jest.fn(async () => ({ ok: true }));
    const both = composeProviderPreSendChecks(first, second);
    await expect(both({ dbi: 'trx' })).resolves.toEqual({ ok: false, code: 'FIRST' });
    expect(second).not.toHaveBeenCalled();
    const ok1 = jest.fn(async () => ({ ok: true }));
    const bad2 = jest.fn(async () => ({ ok: false, code: 'SECOND', retryable: true }));
    await expect(composeProviderPreSendChecks(ok1, bad2)({ dbi: 'trx' })).resolves.toEqual({ ok: false, code: 'SECOND', retryable: true });
    expect(ok1).toHaveBeenCalledWith({ dbi: 'trx' });
  });

  test('the scheduler composes it AFTER the entry point\'s own predicate, for decision-linked sends only', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../services/scheduler.js'), 'utf8');
    expect(src).toContain('if (claimMeta.agent_decision_id) {\n            const { etaProviderPreSendCheck, openLoopsDecisionProviderPreSendCheck, composeProviderPreSendChecks }');
    expect(src).toContain('replayInput.providerPreSendCheck,\n              etaProviderPreSendCheck({ decisionId: claimMeta.agent_decision_id, getBody: () => replayInput.body }),');
    // PR #5499: the open-loop recheck is composed at the same boundary
    expect(src).toContain('openLoopsDecisionProviderPreSendCheck({ decisionId: claimMeta.agent_decision_id, getBody: () => replayInput.body }),');
    // ...and its early queued-send recheck never retires a reply on an unreadable read
    expect(src).toContain("if (rawOpenLoopsReason === 'open_loops_recheck_failed') {");
    expect(src).toContain('} else if (rawOpenLoopsReason != null) {\n                openLoopsReason = rawOpenLoopsReason;\n                openLoopsStale = true;');
  });
});

// Codex round-41 P2: the in-memory-snapshot variant (auto-send executor).
describe('etaSnapshotProviderPreSendCheck', () => {
  test('hands the held snapshot + facts time to the shared check, body read lazily', async () => {
    let body = 'Thanks!';
    const snap = { entries: [{ minutes: 9, scheduledServiceIds: ['s1'] }] };
    const check = etaSnapshotProviderPreSendCheck({ liveEtaSnapshot: snap, factsGeneratedAt: '2026-09-29T14:00:00.000Z', getBody: () => body });
    body = 'The tech is 9 minutes away.';
    await expect(check()).resolves.toEqual({ ok: true });
    expect(etaClaimBlockReason).toHaveBeenCalledWith({ liveEtaSnapshot: snap, factsGeneratedAt: '2026-09-29T14:00:00.000Z', techNames: [], promptVersion: null, outgoingBody: 'The tech is 9 minutes away.' });
  });
  test('stale -> terminal refusal; a throwing recheck -> retryable', async () => {
    etaClaimBlockReason.mockResolvedValue('eta_claim_stale_facts');
    await expect(etaSnapshotProviderPreSendCheck({ liveEtaSnapshot: null, factsGeneratedAt: null, getBody: () => 'x' })()).resolves.toMatchObject({ ok: false, code: 'LIVE_ETA_STALE_AT_BOUNDARY' });
    etaClaimBlockReason.mockRejectedValue(new Error('db down'));
    await expect(etaSnapshotProviderPreSendCheck({ liveEtaSnapshot: null, factsGeneratedAt: null, getBody: () => 'x' })()).resolves.toMatchObject({ ok: false, code: 'LIVE_ETA_CHECK_FAILED_AT_BOUNDARY', retryable: true });
  });
});

// Codex round-42 P2 (PR #5334): ONE shared set of infrastructure-failure reasons.
describe('infrastructure failures are retryable at every wrapper, never permanently stale', () => {
  const { ETA_INFRASTRUCTURE_FAILURE_REASONS, isEtaInfrastructureFailure } = jest.requireActual('../services/sms-eta-freshness');
  const { blockReasonIsEtaInfrastructure } = require('../services/agent-decision-send-checks');

  test('the exported set names both codes; verdicts about the message are not in it', () => {
    expect([...ETA_INFRASTRUCTURE_FAILURE_REASONS].sort()).toEqual(['eta_claim_recheck_failed', 'eta_claim_recompute_unavailable', 'eta_recheck_failed']);
    for (const verdict of ['eta_claim_stale_facts', 'eta_claim_no_longer_en_route', 'eta_claim_no_snapshot', 'eta_claim_superseded_fix', 'eta_claim_visit_not_today']) {
      expect(isEtaInfrastructureFailure(verdict)).toBe(false);
    }
    expect(Object.isFrozen(ETA_INFRASTRUCTURE_FAILURE_REASONS)).toBe(true);
  });

  test.each(['eta_claim_recheck_failed', 'eta_recheck_failed'])('the provider-boundary predicate (row-reading variant) treats %p as RETRYABLE', async (reason) => {
    db.mockImplementation(() => ({ where: () => ({ first: async () => ({ input_snapshot: {} }) }) }));
    etaClaimBlockReason.mockResolvedValue(reason);
    await expect(etaProviderPreSendCheck({ decisionId: 'd1', getBody: () => 'x' })()).resolves.toMatchObject({ ok: false, code: 'LIVE_ETA_CHECK_FAILED_AT_BOUNDARY', retryable: true });
  });

  test.each(['eta_claim_recheck_failed', 'eta_recheck_failed'])('the provider-boundary predicate (in-memory snapshot variant) treats %p as RETRYABLE', async (reason) => {
    etaClaimBlockReason.mockResolvedValue(reason);
    await expect(etaSnapshotProviderPreSendCheck({ liveEtaSnapshot: null, factsGeneratedAt: null, getBody: () => 'x' })()).resolves.toMatchObject({ ok: false, code: 'LIVE_ETA_CHECK_FAILED_AT_BOUNDARY', retryable: true });
  });

  test('a real verdict stays terminal in both variants', async () => {
    db.mockImplementation(() => ({ where: () => ({ first: async () => ({ input_snapshot: {} }) }) }));
    etaClaimBlockReason.mockResolvedValue('eta_claim_no_longer_en_route');
    await expect(etaProviderPreSendCheck({ decisionId: 'd1', getBody: () => 'x' })()).resolves.toMatchObject({ ok: false, code: 'LIVE_ETA_STALE_AT_BOUNDARY' });
    await expect(etaSnapshotProviderPreSendCheck({ liveEtaSnapshot: null, factsGeneratedAt: null, getBody: () => 'x' })()).resolves.toMatchObject({ ok: false, code: 'LIVE_ETA_STALE_AT_BOUNDARY' });
  });

  test('the immediate Agent Review seam can tell an unreadable recheck from a stale verdict', async () => {
    etaClaimBlockReason.mockResolvedValue('eta_claim_recheck_failed');
    const unreadable = await agentDecisionSendBlockReason({ decision: decision({ input_snapshot: JSON.stringify({}) }), outgoingBody: 'The tech is on the way.' });
    expect(unreadable).toBe('live ETA unsendable (eta_claim_recheck_failed)');
    expect(blockReasonIsEtaInfrastructure(unreadable)).toBe(true);
    expect(blockReasonIsEtaInfrastructure('live ETA unsendable (eta_claim_stale_facts)')).toBe(false);
    expect(blockReasonIsEtaInfrastructure('amount no longer authorized (x)')).toBe(false);
    expect(blockReasonIsEtaInfrastructure(null)).toBe(false);
  });

  test('the persisted tech_names ride into the shared check; older decisions send an empty list', async () => {
    etaClaimBlockReason.mockResolvedValue(null);
    await agentDecisionSendBlockReason({ decision: decision({ input_snapshot: JSON.stringify({ tech_names: ['Sam'] }) }), outgoingBody: 'x' });
    expect(etaClaimBlockReason).toHaveBeenLastCalledWith(expect.objectContaining({ techNames: ['Sam'] }));
    await agentDecisionSendBlockReason({ decision: decision({ input_snapshot: JSON.stringify({}) }), outgoingBody: 'x' });
    expect(etaClaimBlockReason).toHaveBeenLastCalledWith(expect.objectContaining({ techNames: [] }));
  });

  test('the scheduler defers an unreadable early recheck to the provider-boundary check (source pin)', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../services/scheduler.js'), 'utf8');
    expect(src).toContain("isEtaInfrastructureFailure(rawEtaReason) ? null : rawEtaReason");
  });
  test('the Agent Review route does not retire a card over an unreadable recheck (source pin)', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../routes/admin-communications.js'), 'utf8');
    expect(src).toContain('blockReasonIsEtaInfrastructure(blockReason)');
  });
});

// Codex #5334 P1 (round after b8809beece): the boundary ETA predicates read through the HANDOFF's own connection (`dbi`).
describe('provider-boundary ETA predicates use the handoff connection (dbi)', () => {
  const trxFor = (row) => {
    const trx = jest.fn(() => ({ where: () => ({ first: async () => row }) }));
    return trx;
  };
  test('etaProviderPreSendCheck reads the decision row AND the freshness recheck through dbi, never the root pool', async () => {
    db.mockReset().mockImplementation(() => { throw new Error('root pool must not be touched'); });
    const trx = trxFor({ input_snapshot: { facts_generated_at: '2026-09-29T14:00:00.000Z' } });
    await expect(etaProviderPreSendCheck({ decisionId: 'd1', getBody: () => 'x' })({ channel: 'sms', dbi: trx })).resolves.toEqual({ ok: true });
    expect(trx).toHaveBeenCalledWith('agent_decisions');
    expect(db).not.toHaveBeenCalled();
    expect(etaClaimBlockReason).toHaveBeenCalledWith(expect.objectContaining({ dbh: trx }));
  });
  test('etaSnapshotProviderPreSendCheck hands dbi to the shared freshness check as dbh', async () => {
    const trx = jest.fn();
    await etaSnapshotProviderPreSendCheck({ liveEtaSnapshot: null, factsGeneratedAt: null, getBody: () => 'x' })({ dbi: trx });
    expect(etaClaimBlockReason).toHaveBeenCalledWith(expect.objectContaining({ dbh: trx }));
  });
  test('the repeatable afterMarker re-run also gets the connection', async () => {
    const trx = jest.fn();
    const check = etaSnapshotProviderPreSendCheck({ liveEtaSnapshot: null, factsGeneratedAt: null, getBody: () => 'x' });
    await check.afterMarker({ dbi: trx });
    expect(etaClaimBlockReason).toHaveBeenCalledWith(expect.objectContaining({ dbh: trx }));
  });
  test('composed: the context reaches every component', async () => {
    const trx = jest.fn();
    const lane = jest.fn(async () => ({ ok: true }));
    const composed = composeProviderPreSendChecks(etaSnapshotProviderPreSendCheck({ liveEtaSnapshot: null, factsGeneratedAt: null, getBody: () => 'x' }), lane);
    await composed({ dbi: trx });
    expect(etaClaimBlockReason).toHaveBeenCalledWith(expect.objectContaining({ dbh: trx }));
    expect(lane).toHaveBeenCalledWith({ dbi: trx });
  });
});

// PR #5499 r1: a reviewed reply grounded on an open promise is refused once that
// promise was fulfilled or dismissed elsewhere; a read error fails closed.
describe('open-loop commitments recheck', () => {
  const { openLoopsBlockReason, scheduledOpenLoopsBlockReason } = require('../services/agent-decision-send-checks');
  const withIds = (ids) => decision({ input_snapshot: JSON.stringify({ ...SNAP, visit_loop_commitment_ids: ids }) });
  const commitmentsDb = (rows) => (table) => {
    const q = { whereIn: () => q, whereRaw: (sql) => { q.raws = [...(q.raws || []), sql]; return q; }, select: async () => rows, where: () => q, first: async () => ({ input_snapshot: JSON.stringify({ visit_loop_commitment_ids: ['cc-1'] }) }) };
    return table === 'call_commitments as cc' || table === 'agent_decisions' ? q : null;
  };

  test('no ids on the snapshot: no read, no block', async () => {
    db.mockReset();
    await expect(openLoopsBlockReason({ decision: decision() })).resolves.toBeNull();
    expect(db).not.toHaveBeenCalled();
  });

  test('every id still open passes; a closed or missing one blocks', async () => {
    await expect(openLoopsBlockReason({ decision: withIds(['cc-1', 'cc-2']), dbh: commitmentsDb([{ id: 'cc-1', status: 'open' }, { id: 'cc-2', status: 'open' }]) })).resolves.toBeNull();
    await expect(openLoopsBlockReason({ decision: withIds(['cc-1', 'cc-2']), dbh: commitmentsDb([{ id: 'cc-1', status: 'open' }, { id: 'cc-2', status: 'fulfilled' }]) })).resolves.toBe('commitment_closed');
    await expect(openLoopsBlockReason({ decision: withIds(['cc-1']), dbh: commitmentsDb([]) })).resolves.toBe('commitment_closed');
  });

  test('the recheck applies the canonical readers\' stale-AI-row exclusion (a superseded row reads as closed)', async () => {
    let seen = null;
    const dbh = (table) => {
      const q = { whereIn: () => q, whereRaw: (sql) => { seen = sql; return q; }, select: async () => [] };
      return table === 'call_commitments as cc' ? q : null;
    };
    await expect(openLoopsBlockReason({ decision: withIds(['cc-1']), dbh })).resolves.toBe('commitment_closed');
    expect(seen).toMatch(/^NOT COALESCE\(\(cc\.human_state IS NULL AND cc\.source = 'ai'.*last_seen_generation/);
  });

  test('a read error fails closed', async () => {
    const broken = () => { throw new Error('db down'); };
    await expect(openLoopsBlockReason({ decision: withIds(['cc-1']), dbh: broken })).resolves.toBe('open_loops_recheck_failed');
    await expect(scheduledOpenLoopsBlockReason({ agentDecisionId: 'd1', dbh: broken })).resolves.toBe('open_loops_recheck_failed');
  });

  test('the immediate send path refuses with the open-loop reason', async () => {
    db.mockReset().mockImplementation(commitmentsDb([{ id: 'cc-1', status: 'dismissed' }]));
    await expect(agentDecisionSendBlockReason({ decision: withIds(['cc-1']), outgoingBody: 'How about Tuesday 9:00 AM - 11:00 AM?' }))
      .resolves.toBe('open-loop facts stale (commitment_closed)');
  });

  test('the scheduler form reads the decision row, then the commitments', async () => {
    await expect(scheduledOpenLoopsBlockReason({ agentDecisionId: 'd1', dbh: commitmentsDb([{ id: 'cc-1', status: 'open' }]) })).resolves.toBeNull();
    await expect(scheduledOpenLoopsBlockReason({ agentDecisionId: 'd1', dbh: commitmentsDb([{ id: 'cc-1', status: 'fulfilled' }]) })).resolves.toBe('commitment_closed');
  });

  test('provider-boundary form: no ids → no check; closed → refused; unreadable → refused retryably; repeatable', async () => {
    const { openLoopsProviderPreSendCheck } = require('../services/agent-decision-send-checks');
    expect(openLoopsProviderPreSendCheck({ commitmentIds: [] })).toBeUndefined();
    expect(openLoopsProviderPreSendCheck({ commitmentIds: null })).toBeUndefined();
    const check = openLoopsProviderPreSendCheck({ commitmentIds: ['cc-1'] });
    expect(check.afterMarker).toBe(check);
    await expect(check({ dbi: commitmentsDb([{ id: 'cc-1', status: 'open' }]) })).resolves.toEqual({ ok: true });
    await expect(check({ dbi: commitmentsDb([{ id: 'cc-1', status: 'fulfilled' }]) }))
      .resolves.toEqual({ ok: false, code: 'OPEN_LOOPS_STALE_AT_BOUNDARY', reason: 'open-loop facts stale (commitment_closed)' });
    await expect(check({ dbi: () => { throw new Error('down'); } }))
      .resolves.toEqual({ ok: false, code: 'OPEN_LOOPS_CHECK_FAILED_AT_BOUNDARY', reason: 'open-loop facts stale (open_loops_recheck_failed)', retryable: true });
  });

  describe('stop-count recount (visit_loop_status)', () => {
    const { etDateString } = require('../utils/datetime-et');
    const today = etDateString(new Date());
    const position = { visitId: 'v1', techId: 't1', stopsAhead: 2 };
    const fresh = () => new Date(Date.now() - 60000).toISOString();
    const withPos = decision({ input_snapshot: JSON.stringify({ ...SNAP, facts_generated_at: fresh(), visit_loop_status: { position } }) });
    const routeDb = ({ visit, ahead, recorded = null }) => {
      const conn = (table) => {
        const q = { where: () => q, whereNotIn: () => q, whereNotExists: () => q, modify: (fn) => { fn(q); return q; }, first: async (...cols) => (cols.includes('route_order') ? visit : { count: String(ahead) }) };
        if (table === 'service_records') return { where: () => ({ first: async () => recorded }) };
        return table === 'scheduled_services' ? q : null;
      };
      conn.raw = (sql) => ({ raw: sql });
      return conn;
    };
    const visit = (over = {}) => ({ id: 'v1', technician_id: 't1', route_order: 5, scheduled_date: today, status: 'confirmed', ...over });

    test('the count is recounted whatever the wording (a paraphrase carries it too)', async () => {
      const body = 'Sorry for the delay. Jamie has two jobs ahead of yours.';
      await expect(openLoopsBlockReason({ decision: withPos, outgoingBody: body, dbh: routeDb({ visit: visit(), ahead: 2 }) })).resolves.toBeNull();
      await expect(openLoopsBlockReason({ decision: withPos, outgoingBody: body, dbh: routeDb({ visit: visit(), ahead: 1 }) })).resolves.toBe('stop_count_stale');
    });

    test('an unreadable recheck reads as infrastructure, so the composer keeps the card', () => {
      const { blockReasonIsEtaInfrastructure } = require('../services/agent-decision-send-checks');
      expect(blockReasonIsEtaInfrastructure('open-loop facts stale (open_loops_recheck_failed)')).toBe(true);
      expect(blockReasonIsEtaInfrastructure('open-loop facts stale (commitment_closed)')).toBe(false);
    });

    test('same count passes; a moved count, a started visit, or a reassignment refuses', async () => {
      const body = 'Sorry for the delay. Sam has 2 stops before yours.';
      await expect(openLoopsBlockReason({ decision: withPos, outgoingBody: body, dbh: routeDb({ visit: visit(), ahead: 2 }) })).resolves.toBeNull();
      await expect(openLoopsBlockReason({ decision: withPos, outgoingBody: body, dbh: routeDb({ visit: visit(), ahead: 1 }) })).resolves.toBe('stop_count_stale');
      await expect(openLoopsBlockReason({ decision: withPos, outgoingBody: body, dbh: routeDb({ visit: visit({ status: 'on_site' }), ahead: 2 }) })).resolves.toBe('stop_count_stale');
      // the tracker can lead a lagging 'confirmed' status
      for (const trackState of ['en_route', 'on_property', 'complete']) {
        await expect(openLoopsBlockReason({ decision: withPos, outgoingBody: body, dbh: routeDb({ visit: visit({ track_state: trackState }), ahead: 2 }) })).resolves.toBe('stop_count_stale');
      }
      await expect(openLoopsBlockReason({ decision: withPos, outgoingBody: body, dbh: routeDb({ visit: visit({ technician_id: 't2' }), ahead: 2 }) })).resolves.toBe('stop_count_stale');
      await expect(openLoopsBlockReason({ decision: withPos, outgoingBody: body, dbh: routeDb({ visit: null, ahead: 2 }) })).resolves.toBe('stop_count_stale');
      await expect(openLoopsBlockReason({ decision: withPos, outgoingBody: body, dbh: routeDb({ visit: visit(), ahead: 2, recorded: { id: 'sr1' } }) })).resolves.toBe('stop_count_stale');
    });

    test('visit status is held to the 15-minute freshness window, whatever the body says; no stamp = expired', async () => {
      const at = (msAgo) => decision({ input_snapshot: JSON.stringify({ ...SNAP, facts_generated_at: new Date(Date.now() - msAgo).toISOString(), visit_loop_status: { position: null } }) });
      await expect(openLoopsBlockReason({ decision: at(14 * 60000), outgoingBody: 'Sorry for the delay.' })).resolves.toBeNull();
      await expect(openLoopsBlockReason({ decision: at(16 * 60000), outgoingBody: 'Sorry for the delay.' })).resolves.toBe('visit_status_expired');
      const noStamp = decision({ input_snapshot: JSON.stringify({ ...SNAP, visit_loop_status: { position: null } }) });
      await expect(openLoopsBlockReason({ decision: noStamp, outgoingBody: 'ok' })).resolves.toBe('visit_status_expired');
    });

    test('the provider-boundary form recounts from the in-memory position', async () => {
      const { openLoopsProviderPreSendCheck } = require('../services/agent-decision-send-checks');
      const check = openLoopsProviderPreSendCheck({ commitmentIds: null, status: { position }, factsGeneratedAt: new Date(), getBody: () => 'Two stops before yours now.' });
      await expect(check({ dbi: routeDb({ visit: visit(), ahead: 2 }) })).resolves.toEqual({ ok: true });
      await expect(check({ dbi: routeDb({ visit: visit(), ahead: 1 }) }))
        .resolves.toEqual({ ok: false, code: 'OPEN_LOOPS_STALE_AT_BOUNDARY', reason: 'open-loop facts stale (stop_count_stale)' });
    });
  });

  test('decision-row boundary form (composer / scheduled replay): reads through the handoff connection', async () => {
    const { openLoopsDecisionProviderPreSendCheck } = require('../services/agent-decision-send-checks');
    const check = openLoopsDecisionProviderPreSendCheck({ decisionId: 'd1', getBody: () => 'ok' });
    expect(check.afterMarker).toBe(check);
    await expect(check({ dbi: commitmentsDb([{ id: 'cc-1', status: 'open' }]) })).resolves.toEqual({ ok: true });
    await expect(check({ dbi: commitmentsDb([{ id: 'cc-1', status: 'fulfilled' }]) }))
      .resolves.toEqual({ ok: false, code: 'OPEN_LOOPS_STALE_AT_BOUNDARY', reason: 'open-loop facts stale (commitment_closed)' });
    await expect(check({ dbi: () => { throw new Error('down'); } }))
      .resolves.toMatchObject({ ok: false, code: 'OPEN_LOOPS_CHECK_FAILED_AT_BOUNDARY', retryable: true });
  });
});
