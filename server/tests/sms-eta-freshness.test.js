/**
 * sms-eta-freshness — LIVE ETA send-time freshness (independent review +
 * Codex round-1 finding, PR #5334; bound-per-claim, pre-push audit P1 round
 * 2). Shared by the immediate /sms send (agent-decision-send-checks.js),
 * the scheduler's queued-send path, and the auto-send executor's pre-send
 * check.
 *
 * Conditions, all required: the draft's facts are still fresh (within
 * ETA_FRESHNESS_WINDOW_MS); the snapshot is the current grouped shape
 * ({ entries: [{ minutes, scheduledServiceIds }] }); every distinct minutes
 * figure claimed in the outgoing body binds to EXACTLY ONE snapshot entry;
 * and THAT entry's own visit(s) — never some other entry's — are still
 * customer-facing en_route. No GPS/Distance Matrix call of its own. Fails
 * closed on any missing evidence, an old flat-shape snapshot, an unbound
 * claim, or an ambiguous one.
 */
jest.mock('../services/sms-shadow-drafter', () => ({
  findEtaMinutesClaims: jest.fn(),
  bodyMentionsArrival: jest.fn(() => false),
}));
jest.mock('../services/track-transitions', () => ({
  customerTrackState: jest.fn((row) => row?.track_state || null),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { findEtaMinutesClaims } = require('../services/sms-shadow-drafter');
const { customerTrackState } = require('../services/track-transitions');
const { etaClaimBlockReason, ETA_FRESHNESS_WINDOW_MS } = require('../services/sms-eta-freshness');

function fakeDb(rows) {
  return () => ({
    whereIn: () => ({ select: async () => rows }),
  });
}

function claim(minutes) {
  return { minutes, index: 0 };
}

const NOW = new Date('2026-09-29T14:30:00.000Z');
const FRESH = new Date(NOW.getTime() - 5 * 60 * 1000).toISOString(); // 5 min ago
const STALE = new Date(NOW.getTime() - 20 * 60 * 1000).toISOString(); // 20 min ago

beforeEach(() => {
  findEtaMinutesClaims.mockReset().mockReturnValue([claim(12)]);
  customerTrackState.mockReset().mockImplementation((row) => row?.track_state || null);
});

test('the outgoing body makes no ETA claim: passes with no snapshot/DB lookup at all', async () => {
  findEtaMinutesClaims.mockReturnValue([]);
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

test('an ETA claim with an empty entries array fails closed', async () => {
  const reason = await etaClaimBlockReason({
    liveEtaSnapshot: { entries: [] }, factsGeneratedAt: FRESH, outgoingBody: 'The tech is 12 minutes away.', now: NOW,
  });
  expect(reason).toBe('eta_claim_no_snapshot');
});

test('the OLD flat scheduledServiceIds shape (no `entries`) fails closed — that shape never shipped to prod', async () => {
  const reason = await etaClaimBlockReason({
    liveEtaSnapshot: { scheduledServiceIds: ['svc-1'] }, factsGeneratedAt: FRESH, outgoingBody: 'The tech is 12 minutes away.', now: NOW,
  });
  expect(reason).toBe('eta_claim_no_snapshot');
});

test('an ETA claim with a snapshot but no facts_generated_at fails closed', async () => {
  const reason = await etaClaimBlockReason({
    liveEtaSnapshot: { entries: [{ minutes: 12, scheduledServiceIds: ['svc-1'] }] }, factsGeneratedAt: null, outgoingBody: 'The tech is 12 minutes away.', now: NOW,
  });
  expect(reason).toBe('eta_claim_no_facts_time');
});

test('facts older than the freshness window fail closed', async () => {
  const reason = await etaClaimBlockReason({
    liveEtaSnapshot: { entries: [{ minutes: 12, scheduledServiceIds: ['svc-1'] }] }, factsGeneratedAt: STALE, outgoingBody: 'The tech is 12 minutes away.', now: NOW,
    dbh: fakeDb([{ id: 'svc-1', status: 'en_route', track_state: 'en_route' }]),
  });
  expect(reason).toBe('eta_claim_stale_facts');
});

test('facts exactly at the window boundary still pass (boundary is exclusive of "over")', async () => {
  const atBoundary = new Date(NOW.getTime() - ETA_FRESHNESS_WINDOW_MS).toISOString();
  const reason = await etaClaimBlockReason({
    liveEtaSnapshot: { entries: [{ minutes: 12, scheduledServiceIds: ['svc-1'] }] }, factsGeneratedAt: atBoundary, outgoingBody: 'The tech is 12 minutes away.', now: NOW,
    dbh: fakeDb([{ id: 'svc-1', status: 'en_route', track_state: 'en_route' }]),
  });
  expect(reason).toBeNull();
});

test('fresh facts but the visit is no longer customer-facing en_route: fails closed', async () => {
  const reason = await etaClaimBlockReason({
    liveEtaSnapshot: { entries: [{ minutes: 12, scheduledServiceIds: ['svc-1'] }] }, factsGeneratedAt: FRESH, outgoingBody: 'The tech is 12 minutes away.', now: NOW,
    dbh: fakeDb([{ id: 'svc-1', status: 'on_site', track_state: 'on_property' }]),
  });
  expect(reason).toBe('eta_claim_no_longer_en_route');
  expect(customerTrackState).toHaveBeenCalledWith({ id: 'svc-1', status: 'on_site', track_state: 'on_property' });
});

test('status="en_route" but a STALE track_state (Codex round-1 finding): fails closed — mirrors track-public.js, never raw status', async () => {
  customerTrackState.mockReturnValue('scheduled'); // the tracker flip never landed
  const reason = await etaClaimBlockReason({
    liveEtaSnapshot: { entries: [{ minutes: 12, scheduledServiceIds: ['svc-1'] }] }, factsGeneratedAt: FRESH, outgoingBody: 'The tech is 12 minutes away.', now: NOW,
    dbh: fakeDb([{ id: 'svc-1', status: 'en_route', track_state: 'scheduled' }]),
  });
  expect(reason).toBe('eta_claim_no_longer_en_route');
});

test('fresh facts and still en_route: passes (any one of a grouped entry\'s own sibling ids counts)', async () => {
  const reason = await etaClaimBlockReason({
    liveEtaSnapshot: { entries: [{ minutes: 12, scheduledServiceIds: ['svc-1', 'svc-2'] }] }, factsGeneratedAt: FRESH, outgoingBody: 'The tech is 12 minutes away.', now: NOW,
    dbh: fakeDb([{ id: 'svc-1', status: 'completed', track_state: 'complete' }, { id: 'svc-2', status: 'en_route', track_state: 'en_route' }]),
  });
  expect(reason).toBeNull();
});

test('a DB failure during the recheck fails closed', async () => {
  const throwingDb = () => ({ whereIn: () => ({ select: async () => { throw new Error('db down'); } }) });
  const reason = await etaClaimBlockReason({
    liveEtaSnapshot: { entries: [{ minutes: 12, scheduledServiceIds: ['svc-1'] }] }, factsGeneratedAt: FRESH, outgoingBody: 'The tech is 12 minutes away.', now: NOW,
    dbh: throwingDb,
  });
  expect(reason).toBe('eta_claim_recheck_failed');
});

describe('per-claim binding (pre-push audit P1): two distinct stops must never cross-validate', () => {
  test('a claim matching NO entry fails closed (unbound)', async () => {
    const reason = await etaClaimBlockReason({
      liveEtaSnapshot: { entries: [{ minutes: 9, scheduledServiceIds: ['svc-1'] }] }, factsGeneratedAt: FRESH, outgoingBody: 'The tech is 12 minutes away.', now: NOW,
      dbh: fakeDb([{ id: 'svc-1', status: 'en_route', track_state: 'en_route' }]),
    });
    expect(reason).toBe('eta_claim_unbound');
  });

  test('a claim matching TWO entries (two distinct stops that happen to share a minutes figure) fails closed (ambiguous)', async () => {
    const reason = await etaClaimBlockReason({
      liveEtaSnapshot: { entries: [{ minutes: 12, scheduledServiceIds: ['svc-1'] }, { minutes: 12, scheduledServiceIds: ['svc-2'] }] },
      factsGeneratedAt: FRESH, outgoingBody: 'The tech is 12 minutes away.', now: NOW,
      dbh: fakeDb([{ id: 'svc-1', status: 'en_route', track_state: 'en_route' }, { id: 'svc-2', status: 'en_route', track_state: 'en_route' }]),
    });
    expect(reason).toBe('eta_claim_ambiguous');
  });

  test('the exact bug this round fixes: reply quotes the COMPLETED stop\'s number while a DIFFERENT stop is still en_route — fails closed, never passes on the other stop', async () => {
    // Snapshot from a two-stop draft: svc-1 (9 min, now completed) and svc-2
    // (20 min, still en_route). The outgoing body claims 9 — svc-1's number.
    findEtaMinutesClaims.mockReturnValue([claim(9)]);
    const reason = await etaClaimBlockReason({
      liveEtaSnapshot: {
        entries: [
          { minutes: 9, scheduledServiceIds: ['svc-1'] },
          { minutes: 20, scheduledServiceIds: ['svc-2'] },
        ],
      },
      factsGeneratedAt: FRESH,
      outgoingBody: 'The tech is 9 minutes away.',
      now: NOW,
      dbh: fakeDb([
        { id: 'svc-1', status: 'completed', track_state: 'complete' },
        { id: 'svc-2', status: 'en_route', track_state: 'en_route' },
      ]),
    });
    // Codex r3: two distinct live ETAs fail closed before any binding.
    expect(reason).toBe('eta_claim_ambiguous');
  });

  test('two distinct live ETAs: even the correctly-quoted stop fails closed (Codex r3)', async () => {
    findEtaMinutesClaims.mockReturnValue([claim(20)]);
    const reason = await etaClaimBlockReason({
      liveEtaSnapshot: {
        entries: [
          { minutes: 9, scheduledServiceIds: ['svc-1'] },
          { minutes: 20, scheduledServiceIds: ['svc-2'] },
        ],
      },
      factsGeneratedAt: FRESH,
      outgoingBody: 'The tech is 20 minutes away.',
      now: NOW,
      dbh: fakeDb([
        { id: 'svc-1', status: 'completed', track_state: 'complete' },
        { id: 'svc-2', status: 'en_route', track_state: 'en_route' },
      ]),
    });
    // Codex r3: with two distinct live ETAs even the right number fails closed.
    expect(reason).toBe('eta_claim_ambiguous');
  });
});

describe('round 4 (audit P1): written-out minutes and unparsed arrival wording still get the freshness check', () => {
  const drafter = require('../services/sms-shadow-drafter');
  const real = jest.requireActual('../services/sms-shadow-drafter');
  beforeEach(() => {
    drafter.findEtaMinutesClaims.mockReset().mockImplementation(real.findEtaMinutesClaims);
    drafter.bodyMentionsArrival.mockReset().mockImplementation(real.bodyMentionsArrival);
  });
  const liveEtaSnapshot = { entries: [{ minutes: 12, scheduledServiceIds: ['svc-1'] }] };
  const dbWith = (rows) => () => ({ whereIn: () => ({ select: async () => rows }) });

  test('"twelve minutes away" is bound like "12 minutes" and blocked once the visit is done', async () => {
    const reason = await etaClaimBlockReason({
      liveEtaSnapshot, factsGeneratedAt: new Date().toISOString(),
      outgoingBody: 'The tech is twelve minutes away.',
      dbh: dbWith([{ id: 'svc-1', status: 'completed', track_state: 'complete' }]),
    });
    expect(reason).toBe('eta_claim_no_longer_en_route');
  });

  // Codex round-4 P2 (PR #5334): a status-only claim carries no minutes
  // figure to go stale, so it is rechecked against the CURRENT tracker state
  // only — never the draft-time freshness window, however old the draft is.
  test('arrival wording with no readable figure never ages out on draft time alone — checked against the CURRENT tracker state', async () => {
    const reason = await etaClaimBlockReason({
      liveEtaSnapshot, factsGeneratedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      outgoingBody: 'He is on the way and should be there in a few.',
      dbh: dbWith([{ id: 'svc-1', status: 'en_route', track_state: 'en_route' }]),
    });
    expect(reason).toBeNull();
  });

  test('arrival wording with no readable figure still fails closed once the tracker is no longer en_route, whatever the draft age', async () => {
    const reason = await etaClaimBlockReason({
      liveEtaSnapshot, factsGeneratedAt: new Date().toISOString(),
      outgoingBody: 'He is on the way and should be there in a few.',
      dbh: dbWith([{ id: 'svc-1', status: 'completed', track_state: 'complete' }]),
    });
    expect(reason).toBe('eta_claim_no_longer_en_route');
  });

  test('ordinary text with no arrival wording is untouched', async () => {
    const reason = await etaClaimBlockReason({ liveEtaSnapshot: null, factsGeneratedAt: null, outgoingBody: 'Thanks, see you next quarter!' });
    expect(reason).toBeNull();
  });
});

describe('range claims (Codex round-2 P2): every bound is bound and rechecked, not just one', () => {
  const drafter = require('../services/sms-shadow-drafter');
  const real = jest.requireActual('../services/sms-shadow-drafter');
  beforeEach(() => {
    drafter.findEtaMinutesClaims.mockReset().mockImplementation(real.findEtaMinutesClaims);
    drafter.bodyMentionsArrival.mockReset().mockImplementation(real.bodyMentionsArrival);
  });

  test('"10-12 minutes away" with only the 12 entry live and the 10 entry no longer en_route: fails closed', async () => {
    const reason = await etaClaimBlockReason({
      liveEtaSnapshot: {
        entries: [
          { minutes: 10, scheduledServiceIds: ['svc-1'] },
          { minutes: 12, scheduledServiceIds: ['svc-2'] },
        ],
      },
      factsGeneratedAt: FRESH,
      outgoingBody: 'The tech is 10-12 minutes away.',
      now: NOW,
      dbh: fakeDb([
        { id: 'svc-1', status: 'completed', track_state: 'complete' },
        { id: 'svc-2', status: 'en_route', track_state: 'en_route' },
      ]),
    });
    expect(reason).toBe('eta_claim_ambiguous');
  });

  test('"10-12 minutes away" with no snapshot entry for either bound at all: fails closed unbound', async () => {
    const reason = await etaClaimBlockReason({
      liveEtaSnapshot: { entries: [{ minutes: 9, scheduledServiceIds: ['svc-1'] }] },
      factsGeneratedAt: FRESH,
      outgoingBody: 'The tech is 10-12 minutes away.',
      now: NOW,
      dbh: fakeDb([{ id: 'svc-1', status: 'en_route', track_state: 'en_route' }]),
    });
    expect(reason).toBe('eta_claim_unbound');
  });

  test('"10-12 minutes away" across two live entries: fails closed as ambiguous (Codex r3)', async () => {
    const reason = await etaClaimBlockReason({
      liveEtaSnapshot: {
        entries: [
          { minutes: 10, scheduledServiceIds: ['svc-1'] },
          { minutes: 12, scheduledServiceIds: ['svc-2'] },
        ],
      },
      factsGeneratedAt: FRESH,
      outgoingBody: 'The tech is 10-12 minutes away.',
      now: NOW,
      dbh: fakeDb([
        { id: 'svc-1', status: 'en_route', track_state: 'en_route' },
        { id: 'svc-2', status: 'en_route', track_state: 'en_route' },
      ]),
    });
    expect(reason).toBe('eta_claim_ambiguous');
  });
});

describe('tracking-link-only replies (Codex round-4 P2): a reply sharing ONLY the /track/ link used to skip every check', () => {
  const drafter = require('../services/sms-shadow-drafter');
  const real = jest.requireActual('../services/sms-shadow-drafter');
  beforeEach(() => {
    drafter.findEtaMinutesClaims.mockReset().mockImplementation(real.findEtaMinutesClaims);
    drafter.bodyMentionsArrival.mockReset().mockImplementation(real.bodyMentionsArrival);
  });

  test('a link-only reply with no snapshot at all fails closed', async () => {
    const reason = await etaClaimBlockReason({
      liveEtaSnapshot: null, factsGeneratedAt: null,
      outgoingBody: 'Here you go: wavespestcontrol.com/track/abc123',
    });
    expect(reason).toBe('eta_claim_no_snapshot');
  });

  test('a link whose token belongs to NO snapshot entry (stray/old link) fails closed', async () => {
    const reason = await etaClaimBlockReason({
      liveEtaSnapshot: { entries: [{ minutes: 12, scheduledServiceIds: ['svc-1'], trackTokens: ['other-token'] }] },
      factsGeneratedAt: FRESH,
      outgoingBody: 'Track your tech here: wavespestcontrol.com/track/abc123',
      dbh: fakeDb([{ id: 'svc-1', status: 'en_route', track_state: 'en_route' }]),
    });
    expect(reason).toBe('eta_claim_untracked_link');
  });

  test('a link whose token matches a snapshot entry that is still en_route passes, with no freshness-window check', async () => {
    const reason = await etaClaimBlockReason({
      liveEtaSnapshot: { entries: [{ minutes: 12, scheduledServiceIds: ['svc-1'], trackTokens: ['abc123'] }] },
      factsGeneratedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(), // an hour old — irrelevant to a link-only share
      outgoingBody: 'Track your tech here: wavespestcontrol.com/track/abc123',
      dbh: fakeDb([{ id: 'svc-1', status: 'en_route', track_state: 'en_route' }]),
    });
    expect(reason).toBeNull();
  });

  test('a link whose visit has since gone on_site still passes (link-only accepts en_route OR on_site)', async () => {
    const reason = await etaClaimBlockReason({
      liveEtaSnapshot: { entries: [{ minutes: 12, scheduledServiceIds: ['svc-1'], trackTokens: ['abc123'] }] },
      factsGeneratedAt: FRESH,
      outgoingBody: 'Track your tech here: wavespestcontrol.com/track/abc123',
      dbh: fakeDb([{ id: 'svc-1', status: 'on_site', track_state: 'on_property' }]),
    });
    expect(reason).toBeNull();
  });

  test('a link whose visit has gone fully terminal fails closed', async () => {
    const reason = await etaClaimBlockReason({
      liveEtaSnapshot: { entries: [{ minutes: 12, scheduledServiceIds: ['svc-1'], trackTokens: ['abc123'] }] },
      factsGeneratedAt: FRESH,
      outgoingBody: 'Track your tech here: wavespestcontrol.com/track/abc123',
      dbh: fakeDb([{ id: 'svc-1', status: 'completed', track_state: 'complete' }]),
    });
    expect(reason).toBe('eta_claim_no_longer_en_route');
  });

  test('a minutes claim carrying a MISMATCHED link fails closed even though the minutes figure itself is bound and live', async () => {
    const reason = await etaClaimBlockReason({
      liveEtaSnapshot: { entries: [{ minutes: 12, scheduledServiceIds: ['svc-1'], trackTokens: ['abc123'] }] },
      factsGeneratedAt: FRESH,
      outgoingBody: 'The tech is 12 minutes away: wavespestcontrol.com/track/stale-token',
      now: NOW,
      dbh: fakeDb([{ id: 'svc-1', status: 'en_route', track_state: 'en_route' }]),
    });
    expect(reason).toBe('eta_claim_untracked_link');
  });

  test('a minutes claim whose link DOES match its own bound entry passes normally', async () => {
    const reason = await etaClaimBlockReason({
      liveEtaSnapshot: { entries: [{ minutes: 12, scheduledServiceIds: ['svc-1'], trackTokens: ['abc123'] }] },
      factsGeneratedAt: FRESH,
      outgoingBody: 'The tech is 12 minutes away: wavespestcontrol.com/track/abc123',
      now: NOW,
      dbh: fakeDb([{ id: 'svc-1', status: 'en_route', track_state: 'en_route' }]),
    });
    expect(reason).toBeNull();
  });
});

