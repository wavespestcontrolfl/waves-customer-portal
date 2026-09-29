/**
 * sms-eta-freshness — LIVE ETA send-time freshness (independent review +
 * Codex round-1 finding, PR #5334). Shared by the immediate /sms send
 * (agent-decision-send-checks.js), the scheduler's queued-send path, and
 * the auto-send executor's pre-send check.
 *
 * Two conditions, both required: the SAME visit(s) the draft's LIVE ETA
 * fact was drawn from are still customer-facing en_route, AND the draft's
 * facts are still fresh (within ETA_FRESHNESS_WINDOW_MS). No GPS/Distance
 * Matrix call of its own. Fails closed on any missing evidence.
 */
jest.mock('../services/sms-shadow-drafter', () => ({
  replyClaimsEtaMinutes: jest.fn(),
}));
jest.mock('../services/track-transitions', () => ({
  customerTrackState: jest.fn((row) => row?.track_state || null),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { replyClaimsEtaMinutes } = require('../services/sms-shadow-drafter');
const { customerTrackState } = require('../services/track-transitions');
const { etaClaimBlockReason, ETA_FRESHNESS_WINDOW_MS } = require('../services/sms-eta-freshness');

function fakeDb(rows) {
  return () => ({
    whereIn: () => ({ select: async () => rows }),
  });
}

const NOW = new Date('2026-09-29T14:30:00.000Z');
const FRESH = new Date(NOW.getTime() - 5 * 60 * 1000).toISOString(); // 5 min ago
const STALE = new Date(NOW.getTime() - 20 * 60 * 1000).toISOString(); // 20 min ago

beforeEach(() => {
  replyClaimsEtaMinutes.mockReset().mockReturnValue(true);
  customerTrackState.mockReset().mockImplementation((row) => row?.track_state || null);
});

test('the outgoing body makes no ETA claim: passes with no snapshot/DB lookup at all', async () => {
  replyClaimsEtaMinutes.mockReturnValue(false);
  const reason = await etaClaimBlockReason({
    liveEtaSnapshot: null, factsGeneratedAt: null, outgoingBody: 'Thanks!', now: NOW,
  });
  expect(reason).toBeNull();
});

test('an ETA claim with no live_eta_snapshot fails closed', async () => {
  const reason = await etaClaimBlockReason({
    liveEtaSnapshot: null, factsGeneratedAt: FRESH, outgoingBody: 'The tech is 12 minutes away.', now: NOW,
  });
  expect(reason).toBe('eta_claim_no_snapshot');
});

test('an ETA claim with an empty scheduledServiceIds array fails closed', async () => {
  const reason = await etaClaimBlockReason({
    liveEtaSnapshot: { scheduledServiceIds: [] }, factsGeneratedAt: FRESH, outgoingBody: 'The tech is 12 minutes away.', now: NOW,
  });
  expect(reason).toBe('eta_claim_no_snapshot');
});

test('an ETA claim with a snapshot but no facts_generated_at fails closed', async () => {
  const reason = await etaClaimBlockReason({
    liveEtaSnapshot: { scheduledServiceIds: ['svc-1'] }, factsGeneratedAt: null, outgoingBody: 'The tech is 12 minutes away.', now: NOW,
  });
  expect(reason).toBe('eta_claim_no_facts_time');
});

test('facts older than the freshness window fail closed', async () => {
  const reason = await etaClaimBlockReason({
    liveEtaSnapshot: { scheduledServiceIds: ['svc-1'] }, factsGeneratedAt: STALE, outgoingBody: 'The tech is 12 minutes away.', now: NOW,
    dbh: fakeDb([{ status: 'en_route', track_state: 'en_route' }]),
  });
  expect(reason).toBe('eta_claim_stale_facts');
});

test('facts exactly at the window boundary still pass (boundary is exclusive of "over")', async () => {
  const atBoundary = new Date(NOW.getTime() - ETA_FRESHNESS_WINDOW_MS).toISOString();
  const reason = await etaClaimBlockReason({
    liveEtaSnapshot: { scheduledServiceIds: ['svc-1'] }, factsGeneratedAt: atBoundary, outgoingBody: 'The tech is 12 minutes away.', now: NOW,
    dbh: fakeDb([{ status: 'en_route', track_state: 'en_route' }]),
  });
  expect(reason).toBeNull();
});

test('fresh facts but the visit is no longer customer-facing en_route: fails closed', async () => {
  const reason = await etaClaimBlockReason({
    liveEtaSnapshot: { scheduledServiceIds: ['svc-1'] }, factsGeneratedAt: FRESH, outgoingBody: 'The tech is 12 minutes away.', now: NOW,
    dbh: fakeDb([{ status: 'on_site', track_state: 'on_property' }]),
  });
  expect(reason).toBe('eta_claim_no_longer_en_route');
  expect(customerTrackState).toHaveBeenCalledWith({ status: 'on_site', track_state: 'on_property' });
});

test('status="en_route" but a STALE track_state (Codex round-1 finding): fails closed — mirrors track-public.js, never raw status', async () => {
  customerTrackState.mockReturnValue('scheduled'); // the tracker flip never landed
  const reason = await etaClaimBlockReason({
    liveEtaSnapshot: { scheduledServiceIds: ['svc-1'] }, factsGeneratedAt: FRESH, outgoingBody: 'The tech is 12 minutes away.', now: NOW,
    dbh: fakeDb([{ status: 'en_route', track_state: 'scheduled' }]),
  });
  expect(reason).toBe('eta_claim_no_longer_en_route');
});

test('fresh facts and still en_route: passes (any one of several ids counts)', async () => {
  const reason = await etaClaimBlockReason({
    liveEtaSnapshot: { scheduledServiceIds: ['svc-1', 'svc-2'] }, factsGeneratedAt: FRESH, outgoingBody: 'The tech is 12 minutes away.', now: NOW,
    dbh: fakeDb([{ status: 'completed', track_state: 'complete' }, { status: 'en_route', track_state: 'en_route' }]),
  });
  expect(reason).toBeNull();
});

test('a DB failure during the recheck fails closed', async () => {
  const throwingDb = () => ({ whereIn: () => ({ select: async () => { throw new Error('db down'); } }) });
  const reason = await etaClaimBlockReason({
    liveEtaSnapshot: { scheduledServiceIds: ['svc-1'] }, factsGeneratedAt: FRESH, outgoingBody: 'The tech is 12 minutes away.', now: NOW,
    dbh: throwingDb,
  });
  expect(reason).toBe('eta_claim_recheck_failed');
});
