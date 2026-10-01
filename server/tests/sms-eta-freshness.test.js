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
  bodyMentionsVisitStatus: jest.fn(() => false),
  bodyHasTimedArrivalPhrase: jest.fn(() => false),
  bodyHasUnclassifiedArrivalDigit: jest.fn(() => false),
  // Structural default-deny (Codex round-7 P2): unioned into `claims`
  // whenever the snapshot has entries or the body carries a /track/ link.
  // Defaults to empty so every pre-existing test (which drives the mocked
  // findEtaMinutesClaims directly) is unaffected; the dedicated describe
  // block below swaps in the real implementation.
  findGroundedMinutesFigures: jest.fn(() => []),
}));
jest.mock('../services/track-transitions', () => ({
  customerTrackState: jest.fn((row) => row?.track_state || null),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
// Round-24: the send-time recompute of a superseded fix reuses the aggregator's own
// uncached resolver; tests script its answer.
jest.mock('../services/context-aggregator', () => ({ resolveLiveEtaMinutesUncached: jest.fn() }));

const { findEtaMinutesClaims } = require('../services/sms-shadow-drafter');
const { customerTrackState } = require('../services/track-transitions');
const { etaClaimBlockReason, ETA_FRESHNESS_WINDOW_MS } = require('../services/sms-eta-freshness');

// Round-24 auditor P1: the send-time visit read now includes scheduled_date and
// requires it to be TODAY (ET). Fixture rows default to today unless they say so.
const { etDateString } = require('../utils/datetime-et');
const dated = (rows) => rows.map((r) => ({ scheduled_date: etDateString(), ...r }));

function fakeDb(rows) {
  return () => ({
    whereIn: () => ({ select: async () => dated(rows) }),
  });
}

function claim(minutes) {
  return { minutes, index: 0 };
}

const NOW = new Date('2026-09-29T14:30:00.000Z');
const FRESH = new Date(NOW.getTime() - 5 * 60 * 1000).toISOString(); // 5 min ago
const STALE = new Date(NOW.getTime() - 20 * 60 * 1000).toISOString(); // 20 min ago
// track_token_expires_at fixtures (Codex round-5 P2): sendTimeTrackTokenLive
// reads the REAL wall clock (Date.now()), never the `now` override some
// tests pass for the draft-freshness window, so these are relative to real
// time regardless of what NOW/FRESH/STALE simulate.
const FUTURE = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // well past any token TTL
const PAST = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(); // already expired

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
  expect(customerTrackState).toHaveBeenCalledWith(expect.objectContaining({ id: 'svc-1', status: 'on_site', track_state: 'on_property' }));
});

test('status="en_route" but a STALE track_state (Codex round-1 finding): fails closed — mirrors track-public.js, never raw status', async () => {
  customerTrackState.mockReturnValue('scheduled'); // the tracker flip never landed
  const reason = await etaClaimBlockReason({
    liveEtaSnapshot: { entries: [{ minutes: 12, scheduledServiceIds: ['svc-1'] }] }, factsGeneratedAt: FRESH, outgoingBody: 'The tech is 12 minutes away.', now: NOW,
    dbh: fakeDb([{ id: 'svc-1', status: 'en_route', track_state: 'scheduled' }]),
  });
  expect(reason).toBe('eta_claim_no_longer_en_route');
});

// Codex round-7 P2: a minutes/status claim about a grouped entry implicitly
// covers EVERY sibling, so ONE sibling going terminal (here, completed)
// fails the whole entry closed even though another sibling sharing the
// physical stop is still en route — this used to pass on `some()` semantics
// (see the superseded test this replaces, pre-round-7: "any one of a
// grouped entry's own sibling ids counts").
test('fresh facts but ONE sibling of a grouped entry has gone terminal: fails closed — a minutes/status claim covers every sibling', async () => {
  const reason = await etaClaimBlockReason({
    liveEtaSnapshot: { entries: [{ minutes: 12, scheduledServiceIds: ['svc-1', 'svc-2'] }] }, factsGeneratedAt: FRESH, outgoingBody: 'The tech is 12 minutes away.', now: NOW,
    dbh: fakeDb([{ id: 'svc-1', status: 'completed', track_state: 'complete' }, { id: 'svc-2', status: 'en_route', track_state: 'en_route' }]),
  });
  expect(reason).toBe('eta_claim_no_longer_en_route');
});

test('fresh facts and EVERY sibling of a grouped entry still en_route: passes', async () => {
  const reason = await etaClaimBlockReason({
    liveEtaSnapshot: { entries: [{ minutes: 12, scheduledServiceIds: ['svc-1', 'svc-2'] }] }, factsGeneratedAt: FRESH, outgoingBody: 'The tech is 12 minutes away.', now: NOW,
    dbh: fakeDb([{ id: 'svc-1', status: 'en_route', track_state: 'en_route' }, { id: 'svc-2', status: 'en_route', track_state: 'en_route' }]),
  });
  expect(reason).toBeNull();
});

// Lawn+Pest grouped scenario named in the PR (owner-facing wording): a
// combined-stop reply quoting one shared minutes figure must block once
// EITHER service line has gone terminal, not just when both have.
test('grouped Lawn+Pest stop: Lawn leg cancelled blocks a shared minutes claim even though Pest is still en_route', async () => {
  findEtaMinutesClaims.mockReturnValue([claim(9)]);
  const reason = await etaClaimBlockReason({
    liveEtaSnapshot: { entries: [{ minutes: 9, scheduledServiceIds: ['svc-pest', 'svc-lawn'] }] }, factsGeneratedAt: FRESH, outgoingBody: 'Your tech is about 9 minutes away.', now: NOW,
    dbh: fakeDb([
      { id: 'svc-pest', status: 'en_route', track_state: 'en_route' },
      { id: 'svc-lawn', status: 'cancelled', track_state: null },
    ]),
  });
  expect(reason).toBe('eta_claim_no_longer_en_route');
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
  const dbWith = (rows) => () => ({ whereIn: () => ({ select: async () => dated(rows) }) });

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

describe('round 5 (Codex P2): vague/approximate duration wording is a TIMED claim, never status-only', () => {
  const drafter = require('../services/sms-shadow-drafter');
  const real = jest.requireActual('../services/sms-shadow-drafter');
  beforeEach(() => {
    drafter.findEtaMinutesClaims.mockReset().mockImplementation(real.findEtaMinutesClaims);
    drafter.bodyMentionsArrival.mockReset().mockImplementation(real.bodyMentionsArrival);
    drafter.bodyHasTimedArrivalPhrase.mockReset().mockImplementation(real.bodyHasTimedArrivalPhrase);
  });
  const liveEtaSnapshot = { entries: [{ minutes: 12, scheduledServiceIds: ['svc-1'] }] };
  const dbWith = (rows) => () => ({ whereIn: () => ({ select: async () => dated(rows) }) });

  test.each([
    'He is about half an hour away.',
    'He is an hour out.',
    'He should be there in a few minutes.',
    'He should be there in a couple minutes.',
    'He is a quarter hour out.',
    'He is on the way and should be there shortly.',
    'He is on the way and should be there any minute now.',
    'He is on the way and should be there soon.',
  ])('within the freshness window, %p still fails closed as unbound — no number here can ever match the snapshot', async (outgoingBody) => {
    const reason = await etaClaimBlockReason({
      liveEtaSnapshot, factsGeneratedAt: FRESH, outgoingBody, now: NOW,
      dbh: dbWith([{ id: 'svc-1', status: 'en_route', track_state: 'en_route' }]),
    });
    expect(reason).toBe('eta_claim_unbound');
  });

  test('a timed phrase past the 15-minute freshness window fails closed as stale, not unbound', async () => {
    const reason = await etaClaimBlockReason({
      liveEtaSnapshot, factsGeneratedAt: STALE, outgoingBody: 'He is about half an hour away.', now: NOW,
      dbh: dbWith([{ id: 'svc-1', status: 'en_route', track_state: 'en_route' }]),
    });
    expect(reason).toBe('eta_claim_stale_facts');
  });

  test('a timed phrase with no facts_generated_at at all fails closed', async () => {
    const reason = await etaClaimBlockReason({
      liveEtaSnapshot, factsGeneratedAt: null, outgoingBody: 'He is about half an hour away.', now: NOW,
      dbh: dbWith([{ id: 'svc-1', status: 'en_route', track_state: 'en_route' }]),
    });
    expect(reason).toBe('eta_claim_no_facts_time');
  });

  test('pure status copy with NO duration wording at all stays status-only — untouched by round 5', async () => {
    const reason = await etaClaimBlockReason({
      liveEtaSnapshot, factsGeneratedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      outgoingBody: 'He is on the way.', now: NOW,
      dbh: dbWith([{ id: 'svc-1', status: 'en_route', track_state: 'en_route' }]),
    });
    expect(reason).toBeNull();
  });

  test('a duration phrase in an unrelated sentence (treatment dry time, not arrival) never false-positives', async () => {
    const reason = await etaClaimBlockReason({
      liveEtaSnapshot, factsGeneratedAt: FRESH, now: NOW,
      outgoingBody: 'Please let the dog out — the treatment needs about half an hour to dry.',
      dbh: dbWith([{ id: 'svc-1', status: 'en_route', track_state: 'en_route' }]),
    });
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
      outgoingBody: 'Here you go: portal.wavespestcontrol.com/track/abc123',
    });
    expect(reason).toBe('eta_claim_no_snapshot');
  });

  test('a link whose token belongs to NO snapshot entry (stray/old link) fails closed', async () => {
    const reason = await etaClaimBlockReason({
      liveEtaSnapshot: { entries: [{ minutes: 12, scheduledServiceIds: ['svc-1'], trackTokens: ['other-token'] }] },
      factsGeneratedAt: FRESH,
      outgoingBody: 'Track your tech here: portal.wavespestcontrol.com/track/abc123',
      dbh: fakeDb([{ id: 'svc-1', status: 'en_route', track_state: 'en_route' }]),
    });
    expect(reason).toBe('eta_claim_untracked_link');
  });

  test('a link whose token matches a snapshot entry that is still en_route passes, with no freshness-window check', async () => {
    const reason = await etaClaimBlockReason({
      liveEtaSnapshot: { entries: [{ minutes: 12, scheduledServiceIds: ['svc-1'], trackTokens: ['abc123'] }] },
      factsGeneratedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(), // an hour old — irrelevant to a link-only share
      outgoingBody: 'Track your tech here: portal.wavespestcontrol.com/track/abc123',
      dbh: fakeDb([{ id: 'svc-1', status: 'en_route', track_state: 'en_route', track_view_token: 'abc123', track_token_expires_at: FUTURE }]),
    });
    expect(reason).toBeNull();
  });

  test('a link whose visit has since gone on_site still passes (link-only accepts en_route OR on_site)', async () => {
    const reason = await etaClaimBlockReason({
      liveEtaSnapshot: { entries: [{ minutes: 12, scheduledServiceIds: ['svc-1'], trackTokens: ['abc123'] }] },
      factsGeneratedAt: FRESH,
      outgoingBody: 'Track your tech here: portal.wavespestcontrol.com/track/abc123',
      dbh: fakeDb([{ id: 'svc-1', status: 'on_site', track_state: 'on_property', track_view_token: 'abc123', track_token_expires_at: FUTURE }]),
    });
    expect(reason).toBeNull();
  });

  test('a link whose visit has gone fully terminal fails closed', async () => {
    const reason = await etaClaimBlockReason({
      liveEtaSnapshot: { entries: [{ minutes: 12, scheduledServiceIds: ['svc-1'], trackTokens: ['abc123'] }] },
      factsGeneratedAt: FRESH,
      outgoingBody: 'Track your tech here: portal.wavespestcontrol.com/track/abc123',
      dbh: fakeDb([{ id: 'svc-1', status: 'completed', track_state: 'complete' }]),
    });
    expect(reason).toBe('eta_claim_no_longer_en_route');
  });

  test('a minutes claim carrying a MISMATCHED link fails closed even though the minutes figure itself is bound and live', async () => {
    const reason = await etaClaimBlockReason({
      liveEtaSnapshot: { entries: [{ minutes: 12, scheduledServiceIds: ['svc-1'], trackTokens: ['abc123'] }] },
      factsGeneratedAt: FRESH,
      outgoingBody: 'The tech is 12 minutes away: portal.wavespestcontrol.com/track/stale-token',
      now: NOW,
      dbh: fakeDb([{ id: 'svc-1', status: 'en_route', track_state: 'en_route' }]),
    });
    expect(reason).toBe('eta_claim_untracked_link');
  });

  test('a minutes claim whose link DOES match its own bound entry passes normally', async () => {
    const reason = await etaClaimBlockReason({
      liveEtaSnapshot: { entries: [{ minutes: 12, scheduledServiceIds: ['svc-1'], trackTokens: ['abc123'] }] },
      factsGeneratedAt: FRESH,
      outgoingBody: 'The tech is 12 minutes away: portal.wavespestcontrol.com/track/abc123',
      now: NOW,
      dbh: fakeDb([{ id: 'svc-1', status: 'en_route', track_state: 'en_route', track_view_token: 'abc123', track_token_expires_at: FUTURE }]),
    });
    expect(reason).toBeNull();
  });
});

describe('round 6 (Codex P2): an arrival sentence with a digit findEtaMinutesClaims could not classify fails closed like a timed phrase', () => {
  const drafter = require('../services/sms-shadow-drafter');
  const liveEtaSnapshot = { entries: [{ minutes: 12, scheduledServiceIds: ['svc-1'] }] };
  const dbWith = (rows) => () => ({ whereIn: () => ({ select: async () => dated(rows) }) });

  beforeEach(() => {
    findEtaMinutesClaims.mockReset().mockReturnValue([]);
    drafter.bodyHasUnclassifiedArrivalDigit.mockReset().mockReturnValue(true);
  });

  test('within the freshness window it fails closed as unbound — never waved through as status-only copy', async () => {
    const reason = await etaClaimBlockReason({
      liveEtaSnapshot, factsGeneratedAt: FRESH, outgoingBody: 'ETA: 20', now: NOW,
      dbh: dbWith([{ id: 'svc-1', status: 'en_route', track_state: 'en_route' }]),
    });
    expect(reason).toBe('eta_claim_unbound');
  });

  test('past the freshness window it fails closed as stale, not unbound', async () => {
    const reason = await etaClaimBlockReason({
      liveEtaSnapshot, factsGeneratedAt: STALE, outgoingBody: 'ETA: 20', now: NOW,
      dbh: dbWith([{ id: 'svc-1', status: 'en_route', track_state: 'en_route' }]),
    });
    expect(reason).toBe('eta_claim_stale_facts');
  });

  test('with no facts_generated_at at all it fails closed', async () => {
    const reason = await etaClaimBlockReason({
      liveEtaSnapshot, factsGeneratedAt: null, outgoingBody: 'ETA: 20', now: NOW,
    });
    expect(reason).toBe('eta_claim_no_facts_time');
  });

  test('an ordinary reply with no unclassified digit is unaffected', async () => {
    drafter.bodyHasUnclassifiedArrivalDigit.mockReturnValue(false);
    const reason = await etaClaimBlockReason({
      liveEtaSnapshot: null, factsGeneratedAt: null, outgoingBody: 'Thanks, see you soon!', now: NOW,
    });
    expect(reason).toBeNull();
  });
});

describe('round 7 (Codex P2): structural default-deny — a plain minutes figure with NO trigger word is still a claim once there is a snapshot/link to check it against', () => {
  const drafter = require('../services/sms-shadow-drafter');
  const real = jest.requireActual('../services/sms-shadow-drafter');
  beforeEach(() => {
    drafter.findEtaMinutesClaims.mockReset().mockImplementation(real.findEtaMinutesClaims);
    drafter.bodyMentionsArrival.mockReset().mockImplementation(real.bodyMentionsArrival);
    drafter.bodyHasTimedArrivalPhrase.mockReset().mockImplementation(real.bodyHasTimedArrivalPhrase);
    drafter.bodyHasUnclassifiedArrivalDigit.mockReset().mockImplementation(real.bodyHasUnclassifiedArrivalDigit);
    drafter.findGroundedMinutesFigures.mockReset().mockImplementation(real.findGroundedMinutesFigures);
  });
  const liveEtaSnapshot = { entries: [{ minutes: 20, scheduledServiceIds: ['svc-1'] }] };
  const dbWith = (rows) => () => ({ whereIn: () => ({ select: async () => dated(rows) }) });

  test.each([
    '20 minutes to go.',
    '20 min left.',
    'Due in 20.',
    'Be with you in 20 minutes.',
    'Reach you in about 20.',
  ])('%p is bound and blocked once the visit is done, with no trigger-list match required', async (outgoingBody) => {
    const reason = await etaClaimBlockReason({
      liveEtaSnapshot, factsGeneratedAt: FRESH, outgoingBody, now: NOW,
      dbh: dbWith([{ id: 'svc-1', status: 'completed', track_state: 'complete' }]),
    });
    expect(reason).toBe('eta_claim_no_longer_en_route');
  });

  test.each([
    '20 minutes to go.',
    '20 min left.',
    'Due in 20.',
    'Be with you in 20 minutes.',
    'Reach you in about 20.',
  ])('%p passes when the visit is still en_route', async (outgoingBody) => {
    const reason = await etaClaimBlockReason({
      liveEtaSnapshot, factsGeneratedAt: FRESH, outgoingBody, now: NOW,
      dbh: dbWith([{ id: 'svc-1', status: 'en_route', track_state: 'en_route' }]),
    });
    expect(reason).toBeNull();
  });

  test.each([
    'Allow 30 minutes to dry.',
    'The service takes about 45 minutes.',
  ])('explicit non-arrival duration %p is never treated as a claim, even with a live snapshot present', async (outgoingBody) => {
    const reason = await etaClaimBlockReason({
      liveEtaSnapshot, factsGeneratedAt: FRESH, outgoingBody, now: NOW,
    });
    expect(reason).toBeNull();
  });

  // The whole point of the structural fix: a bare minutes figure with NO
  // trigger word anywhere in the sentence still binds once there's a
  // snapshot to check it against — no future phrasing needs its own
  // trigger-word addition here.
  test('a bare "20 minutes." with no arrival wording at all is still a claim when a snapshot is present', async () => {
    const reason = await etaClaimBlockReason({
      liveEtaSnapshot, factsGeneratedAt: FRESH, outgoingBody: '20 minutes.', now: NOW,
      dbh: dbWith([{ id: 'svc-1', status: 'completed', track_state: 'complete' }]),
    });
    expect(reason).toBe('eta_claim_no_longer_en_route');
  });

  test('the same bare "20 minutes." with NO snapshot and NO link is untouched (nothing to check it against)', async () => {
    const reason = await etaClaimBlockReason({
      liveEtaSnapshot: null, factsGeneratedAt: null, outgoingBody: '20 minutes.', now: NOW,
    });
    expect(reason).toBeNull();
  });
});

describe('round 8 (Codex P2): bare-integer default-deny — "The tech should make it in 20" matches neither IMPLICIT_MINUTES_ARRIVAL_RE nor a strong trigger', () => {
  const drafter = require('../services/sms-shadow-drafter');
  const real = jest.requireActual('../services/sms-shadow-drafter');
  beforeEach(() => {
    drafter.findEtaMinutesClaims.mockReset().mockImplementation(real.findEtaMinutesClaims);
    drafter.bodyMentionsArrival.mockReset().mockImplementation(real.bodyMentionsArrival);
    drafter.bodyHasTimedArrivalPhrase.mockReset().mockImplementation(real.bodyHasTimedArrivalPhrase);
    drafter.bodyHasUnclassifiedArrivalDigit.mockReset().mockImplementation(real.bodyHasUnclassifiedArrivalDigit);
    drafter.findGroundedMinutesFigures.mockReset().mockImplementation(real.findGroundedMinutesFigures);
  });
  const liveEtaSnapshot = { entries: [{ minutes: 20, scheduledServiceIds: ['svc-1'] }] };
  const dbWith = (rows) => () => ({ whereIn: () => ({ select: async () => dated(rows) }) });

  test.each([
    'The tech should make it in 20.',
    "He'll be by in 20.",
    '20ish.',
  ])('%p is bound and blocked once the visit is done, with no unit word or fixed phrase required', async (outgoingBody) => {
    const reason = await etaClaimBlockReason({
      liveEtaSnapshot, factsGeneratedAt: FRESH, outgoingBody, now: NOW,
      dbh: dbWith([{ id: 'svc-1', status: 'completed', track_state: 'complete' }]),
    });
    expect(reason).toBe('eta_claim_no_longer_en_route');
  });

  test.each([
    'The tech should make it in 20.',
    "He'll be by in 20.",
    '20ish.',
  ])('%p passes when the visit is still en_route', async (outgoingBody) => {
    const reason = await etaClaimBlockReason({
      liveEtaSnapshot, factsGeneratedAt: FRESH, outgoingBody, now: NOW,
      dbh: dbWith([{ id: 'svc-1', status: 'en_route', track_state: 'en_route' }]),
    });
    expect(reason).toBeNull();
  });

  // Codex round-9 P2 (PR #5334): "about 2 hours out" is 120 MINUTES, not a
  // raw "2" — it binds to a snapshot entry reading 120, and a snapshot that
  // reads 2 (a contrived 2-minute live fact) no longer matches it.
  test('"About 2 hours out." is bound (as 120 minutes) and blocked once the visit is done', async () => {
    const reason = await etaClaimBlockReason({
      liveEtaSnapshot: { entries: [{ minutes: 120, scheduledServiceIds: ['svc-1'] }] },
      factsGeneratedAt: FRESH, outgoingBody: 'About 2 hours out.', now: NOW,
      dbh: dbWith([{ id: 'svc-1', status: 'completed', track_state: 'complete' }]),
    });
    expect(reason).toBe('eta_claim_no_longer_en_route');
  });

  test('"About 2 hours out." does NOT bind to a live ETA of 2 minutes — off by nearly two hours (round 9)', async () => {
    const reason = await etaClaimBlockReason({
      liveEtaSnapshot: { entries: [{ minutes: 2, scheduledServiceIds: ['svc-1'] }] },
      factsGeneratedAt: FRESH, outgoingBody: 'About 2 hours out.', now: NOW,
      dbh: dbWith([{ id: 'svc-1', status: 'en_route', track_state: 'en_route' }]),
    });
    expect(reason).toBe('eta_claim_unbound');
  });

  test.each([
    'He is 1 hr 20 min out.',
    'He is about an hour out, 2 minutes.',
    'He is a couple hours away.',
  ])('%p never passes against a live ETA of 2 minutes', async (outgoingBody) => {
    const reason = await etaClaimBlockReason({
      liveEtaSnapshot: { entries: [{ minutes: 2, scheduledServiceIds: ['svc-1'] }] },
      factsGeneratedAt: FRESH, outgoingBody, now: NOW,
      dbh: dbWith([{ id: 'svc-1', status: 'en_route', track_state: 'en_route' }]),
    });
    expect(reason).not.toBeNull();
  });

  // The "no-snapshot trigger path" fix: findEtaMinutesClaims itself now
  // recognizes these phrasings, so an ungrounded claim fails closed even
  // with NO snapshot and NO /track/ link at all — it must never be silently
  // waved through as status copy just because findGroundedMinutesFigures
  // never ran (there's no snapshot to run it against).
  test.each([
    'The tech should make it in 20.',
    "He'll be by in 20.",
  ])('%p with NO snapshot and NO link fails closed as ungrounded', async (outgoingBody) => {
    const reason = await etaClaimBlockReason({
      liveEtaSnapshot: null, factsGeneratedAt: null, outgoingBody, now: NOW,
    });
    expect(reason).toBe('eta_claim_no_snapshot');
  });

  // Visit left en_route (matching the snapshot) so a genuine arrival-status
  // word elsewhere in a couple of these sentences ("be there", "on the way")
  // never itself blocks the send — the point under test is narrower: the
  // number sitting nearby is never misread as a mismatched/unbound MINUTES
  // figure of its own.
  test.each([
    '$20 is due at the visit.',
    'He should be there at 2:30.',
    "He's on the way to 123 Main St.",
    'You have 2 visits left this year.',
    'Your renewal lands on the 20th.',
    'Battery is at 100% right now.',
  ])('negative: %p is never parsed as a bare-integer ETA claim, even with a live snapshot present', async (outgoingBody) => {
    const reason = await etaClaimBlockReason({
      liveEtaSnapshot, factsGeneratedAt: FRESH, outgoingBody, now: NOW,
      dbh: dbWith([{ id: 'svc-1', status: 'en_route', track_state: 'en_route' }]),
    });
    expect(reason).toBeNull();
  });
});

describe('round 6 (Codex P2): a token\'s OWNING row must itself be live — a grouped-stop sibling\'s liveness never covers it', () => {
  const drafter = require('../services/sms-shadow-drafter');
  const real = jest.requireActual('../services/sms-shadow-drafter');
  beforeEach(() => {
    drafter.findEtaMinutesClaims.mockReset().mockImplementation(real.findEtaMinutesClaims);
    drafter.bodyMentionsArrival.mockReset().mockImplementation(real.bodyMentionsArrival);
    drafter.bodyHasUnclassifiedArrivalDigit.mockReset().mockReturnValue(false);
  });

  test('a cancelled sibling\'s own token is blocked even though another sibling sharing the stop is still en route', async () => {
    const reason = await etaClaimBlockReason({
      liveEtaSnapshot: {
        entries: [{ minutes: 9, scheduledServiceIds: ['svc-cancelled', 'svc-live'], trackTokens: ['cancelled-token', 'live-token'] }],
      },
      factsGeneratedAt: FRESH,
      outgoingBody: 'Track your tech here: portal.wavespestcontrol.com/track/cancelled-token',
      now: NOW,
      dbh: fakeDb([
        { id: 'svc-cancelled', status: 'cancelled', track_state: null, track_view_token: 'cancelled-token', track_token_expires_at: FUTURE },
        { id: 'svc-live', status: 'en_route', track_state: 'en_route', track_view_token: 'live-token', track_token_expires_at: FUTURE },
      ]),
    });
    // The entry-level check passes on svc-live alone; the fix requires the
    // TOKEN'S OWN row (svc-cancelled) to be live, which it is not.
    expect(reason).toBe('eta_claim_link_expired');
  });

  test('the SAME grouped entry\'s still-live sibling token passes normally', async () => {
    const reason = await etaClaimBlockReason({
      liveEtaSnapshot: {
        entries: [{ minutes: 9, scheduledServiceIds: ['svc-cancelled', 'svc-live'], trackTokens: ['cancelled-token', 'live-token'] }],
      },
      factsGeneratedAt: FRESH,
      outgoingBody: 'Track your tech here: portal.wavespestcontrol.com/track/live-token',
      now: NOW,
      dbh: fakeDb([
        { id: 'svc-cancelled', status: 'cancelled', track_state: null, track_view_token: 'cancelled-token', track_token_expires_at: FUTURE },
        { id: 'svc-live', status: 'en_route', track_state: 'en_route', track_view_token: 'live-token', track_token_expires_at: FUTURE },
      ]),
    });
    expect(reason).toBeNull();
  });
});

describe('round 5 (Codex P2): a /track/ link\'s own token expiry is re-checked, never inferred from status/track_state alone', () => {
  const drafter = require('../services/sms-shadow-drafter');
  const real = jest.requireActual('../services/sms-shadow-drafter');
  beforeEach(() => {
    drafter.findEtaMinutesClaims.mockReset().mockImplementation(real.findEtaMinutesClaims);
    drafter.bodyMentionsArrival.mockReset().mockImplementation(real.bodyMentionsArrival);
  });

  test('link-only: a still-en_route row whose token has already expired blocks the send', async () => {
    const reason = await etaClaimBlockReason({
      liveEtaSnapshot: { entries: [{ minutes: 12, scheduledServiceIds: ['svc-1'], trackTokens: ['abc123'] }] },
      factsGeneratedAt: FRESH,
      outgoingBody: 'Track your tech here: portal.wavespestcontrol.com/track/abc123',
      dbh: fakeDb([{ id: 'svc-1', status: 'en_route', track_state: 'en_route', track_view_token: 'abc123', track_token_expires_at: PAST }]),
    });
    expect(reason).toBe('eta_claim_link_expired');
  });

  test('link-only: a still-en_route row with NO expiry stamped at all fails closed (the schema normally sets one)', async () => {
    const reason = await etaClaimBlockReason({
      liveEtaSnapshot: { entries: [{ minutes: 12, scheduledServiceIds: ['svc-1'], trackTokens: ['abc123'] }] },
      factsGeneratedAt: FRESH,
      outgoingBody: 'Track your tech here: portal.wavespestcontrol.com/track/abc123',
      dbh: fakeDb([{ id: 'svc-1', status: 'en_route', track_state: 'en_route', track_view_token: 'abc123', track_token_expires_at: null }]),
    });
    expect(reason).toBe('eta_claim_link_expired');
  });

  test('link-only: an on_site row whose token has expired still blocks — a live track_state is not enough', async () => {
    const reason = await etaClaimBlockReason({
      liveEtaSnapshot: { entries: [{ minutes: 12, scheduledServiceIds: ['svc-1'], trackTokens: ['abc123'] }] },
      factsGeneratedAt: FRESH,
      outgoingBody: 'Track your tech here: portal.wavespestcontrol.com/track/abc123',
      dbh: fakeDb([{ id: 'svc-1', status: 'on_site', track_state: 'on_property', track_view_token: 'abc123', track_token_expires_at: PAST }]),
    });
    expect(reason).toBe('eta_claim_link_expired');
  });

  test('a minutes claim carrying a link whose OWN token has expired blocks, even though the minutes figure itself is bound and live', async () => {
    const reason = await etaClaimBlockReason({
      liveEtaSnapshot: { entries: [{ minutes: 12, scheduledServiceIds: ['svc-1'], trackTokens: ['abc123'] }] },
      factsGeneratedAt: FRESH,
      outgoingBody: 'The tech is 12 minutes away: portal.wavespestcontrol.com/track/abc123',
      now: NOW,
      dbh: fakeDb([{ id: 'svc-1', status: 'en_route', track_state: 'en_route', track_view_token: 'abc123', track_token_expires_at: PAST }]),
    });
    expect(reason).toBe('eta_claim_link_expired');
  });

  test('a status-only claim carrying a link whose OWN token has expired blocks the send', async () => {
    const reason = await etaClaimBlockReason({
      liveEtaSnapshot: { entries: [{ minutes: 12, scheduledServiceIds: ['svc-1'], trackTokens: ['abc123'] }] },
      factsGeneratedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      outgoingBody: 'He is on the way and should be there in a few: portal.wavespestcontrol.com/track/abc123',
      dbh: fakeDb([{ id: 'svc-1', status: 'en_route', track_state: 'en_route', track_view_token: 'abc123', track_token_expires_at: PAST }]),
    });
    expect(reason).toBe('eta_claim_link_expired');
  });

  test('a minutes claim with NO link at all is unaffected by expiry — never queried for a token that was never sent', async () => {
    const reason = await etaClaimBlockReason({
      liveEtaSnapshot: { entries: [{ minutes: 12, scheduledServiceIds: ['svc-1'], trackTokens: ['abc123'] }] },
      factsGeneratedAt: FRESH,
      outgoingBody: 'The tech is 12 minutes away.',
      now: NOW,
      dbh: fakeDb([{ id: 'svc-1', status: 'en_route', track_state: 'en_route', track_view_token: 'abc123', track_token_expires_at: PAST }]),
    });
    expect(reason).toBeNull();
  });
});


describe('round 10 (Codex P2, PR #5334): decimal ETAs, status+link with two live visits, case-insensitive /Track/ links', () => {
  const drafter = require('../services/sms-shadow-drafter');
  const real = jest.requireActual('../services/sms-shadow-drafter');
  beforeEach(() => {
    drafter.findEtaMinutesClaims.mockReset().mockImplementation(real.findEtaMinutesClaims);
    drafter.bodyMentionsArrival.mockReset().mockImplementation(real.bodyMentionsArrival);
    drafter.bodyHasTimedArrivalPhrase.mockReset().mockImplementation(real.bodyHasTimedArrivalPhrase);
    drafter.bodyHasUnclassifiedArrivalDigit.mockReset().mockImplementation(real.bodyHasUnclassifiedArrivalDigit);
    drafter.findGroundedMinutesFigures.mockReset().mockImplementation(real.findGroundedMinutesFigures);
  });
  const twoEntrySnapshot = {
    entries: [
      { minutes: 5, scheduledServiceIds: ['svc-pest'], trackTokens: ['pest-token'] },
      { minutes: 9, scheduledServiceIds: ['svc-lawn'], trackTokens: ['lawn-token'] },
    ],
  };
  const liveRows = [
    { id: 'svc-pest', status: 'en_route', track_state: 'en_route', track_view_token: 'pest-token', track_token_expires_at: FUTURE },
    { id: 'svc-lawn', status: 'en_route', track_state: 'en_route', track_view_token: 'lawn-token', track_token_expires_at: FUTURE },
  ];

  test('"12.5 minutes away" is one decimal claim — never matched as "5" against a live 5-minute entry', async () => {
    const reason = await etaClaimBlockReason({
      liveEtaSnapshot: { entries: [{ minutes: 5, scheduledServiceIds: ['svc-1'] }] },
      factsGeneratedAt: FRESH, outgoingBody: 'The tech is 12.5 minutes away.', now: NOW,
      dbh: fakeDb([{ id: 'svc-1', status: 'en_route', track_state: 'en_route' }]),
    });
    expect(reason).toBe('eta_claim_unbound');
  });

  test('status + link with TWO live visits binds to the entry the link token names, not ambiguous', async () => {
    const reason = await etaClaimBlockReason({
      liveEtaSnapshot: twoEntrySnapshot, factsGeneratedAt: FRESH, now: NOW,
      outgoingBody: 'Your pest tech is on the way: portal.wavespestcontrol.com/track/pest-token',
      dbh: fakeDb(liveRows),
    });
    expect(reason).toBeNull();
  });

  test('status + link with two live visits still fails closed when the named visit is no longer en_route', async () => {
    const reason = await etaClaimBlockReason({
      liveEtaSnapshot: twoEntrySnapshot, factsGeneratedAt: FRESH, now: NOW,
      outgoingBody: 'Your pest tech is on the way: portal.wavespestcontrol.com/track/pest-token',
      dbh: fakeDb([{ ...liveRows[0], status: 'completed', track_state: 'complete' }, liveRows[1]]),
    });
    expect(reason).toBe('eta_claim_no_longer_en_route');
  });

  test('status with two live visits and NO link (or a stray one) is still ambiguous', async () => {
    const noLink = await etaClaimBlockReason({
      liveEtaSnapshot: twoEntrySnapshot, factsGeneratedAt: FRESH, now: NOW,
      outgoingBody: 'Your tech is on the way, about a few minutes out.', dbh: fakeDb(liveRows),
    });
    expect(noLink).toBe('eta_claim_ambiguous');
    const stray = await etaClaimBlockReason({
      liveEtaSnapshot: twoEntrySnapshot, factsGeneratedAt: FRESH, now: NOW,
      outgoingBody: 'Your tech is on the way: portal.wavespestcontrol.com/track/stray-token', dbh: fakeDb(liveRows),
    });
    expect(stray).toBe('eta_claim_ambiguous');
  });

  test('a capitalised /Track/<token> link is validated like /track/<token> — a stray one is refused', async () => {
    const reason = await etaClaimBlockReason({
      liveEtaSnapshot: { entries: [{ minutes: 12, scheduledServiceIds: ['svc-1'], trackTokens: ['abc123'] }] },
      factsGeneratedAt: FRESH, now: NOW,
      outgoingBody: 'Track your tech here: portal.wavespestcontrol.com/Track/stray-token',
      dbh: fakeDb([{ id: 'svc-1', status: 'en_route', track_state: 'en_route' }]),
    });
    expect(reason).toBe('eta_claim_untracked_link');
  });

  test('a capitalised /TRACK/<own token> link whose visit is terminal is blocked, and a live one passes', async () => {
    const snapshot = { entries: [{ minutes: 12, scheduledServiceIds: ['svc-1'], trackTokens: ['abc123'] }] };
    const blocked = await etaClaimBlockReason({
      liveEtaSnapshot: snapshot, factsGeneratedAt: FRESH, now: NOW,
      outgoingBody: 'Track your tech here: portal.wavespestcontrol.com/TRACK/abc123',
      dbh: fakeDb([{ id: 'svc-1', status: 'completed', track_state: 'complete' }]),
    });
    expect(blocked).toBe('eta_claim_no_longer_en_route');
    const passed = await etaClaimBlockReason({
      liveEtaSnapshot: snapshot, factsGeneratedAt: FRESH, now: NOW,
      outgoingBody: 'Track your tech here: portal.wavespestcontrol.com/TRACK/abc123',
      dbh: fakeDb([{ id: 'svc-1', status: 'en_route', track_state: 'en_route', track_view_token: 'abc123', track_token_expires_at: FUTURE }]),
    });
    expect(passed).toBeNull();
  });

  // Codex pre-push P1 (round 11): no snapshot, no link — hours must read as
  // minutes on this path too.
  test.each([
    'The tech is 2 hours away.',
    'He is 1 hr 20 min out.',
  ])('%p with NO snapshot at all is blocked like its minutes equivalent', async (outgoingBody) => {
    const reason = await etaClaimBlockReason({ liveEtaSnapshot: null, factsGeneratedAt: null, outgoingBody, now: NOW });
    expect(reason).toBe('eta_claim_no_snapshot');
  });

  test.each([
    'Your 2 hour arrival window starts at 9.',
    'The treatment takes about 2 hours.',
    'Your arrival window is 2 hours.',
  ])('%p with no snapshot is untouched (an appointment window / duration, not an ETA)', async (outgoingBody) => {
    const reason = await etaClaimBlockReason({ liveEtaSnapshot: null, factsGeneratedAt: null, outgoingBody, now: NOW });
    expect(reason).toBeNull();
  });

  // Codex round-11 P2 (PR #5334): a snapshot entry carries the instant its
  // GPS fix goes stale to the public tracker; a minutes claim expires at
  // min(15-minute draft window, that instant).
  describe('GPS-fix expiry rides in the snapshot entry (round 11 P2)', () => {
    const rows = [{ id: 'svc-1', status: 'en_route', track_state: 'en_route' }];
    const entry = (extra) => ({ entries: [{ minutes: 12, scheduledServiceIds: ['svc-1'], ...extra }] });

    test('a minutes claim inside the 15-minute draft window is refused once the GPS fix has expired', async () => {
      const reason = await etaClaimBlockReason({
        liveEtaSnapshot: entry({ fixExpiresAtMs: NOW.getTime() - 1000 }),
        factsGeneratedAt: FRESH, outgoingBody: 'The tech is 12 minutes away.', now: NOW, dbh: fakeDb(rows),
      });
      expect(reason).toBe('eta_claim_stale_facts');
    });

    test('a vague timed claim expires with the fix too', async () => {
      const reason = await etaClaimBlockReason({
        liveEtaSnapshot: entry({ fixExpiresAtMs: NOW.getTime() - 1000 }),
        factsGeneratedAt: FRESH, outgoingBody: 'He is about half an hour away.', now: NOW, dbh: fakeDb(rows),
      });
      expect(reason).toBe('eta_claim_stale_facts');
    });

    test('a still-fresh fix leaves the claim to the normal checks (passes while en_route)', async () => {
      const reason = await etaClaimBlockReason({
        liveEtaSnapshot: entry({ fixExpiresAtMs: NOW.getTime() + 60 * 1000 }),
        factsGeneratedAt: FRESH, outgoingBody: 'The tech is 12 minutes away.', now: NOW, dbh: fakeDb(rows),
      });
      expect(reason).toBeNull();
    });

    test('an older entry with no fixExpiresAtMs keeps the draft-window-only rule', async () => {
      const ok = await etaClaimBlockReason({
        liveEtaSnapshot: entry({}), factsGeneratedAt: FRESH, outgoingBody: 'The tech is 12 minutes away.', now: NOW, dbh: fakeDb(rows),
      });
      expect(ok).toBeNull();
      const stale = await etaClaimBlockReason({
        liveEtaSnapshot: entry({}), factsGeneratedAt: new Date(NOW.getTime() - 16 * 60 * 1000).toISOString(),
        outgoingBody: 'The tech is 12 minutes away.', now: NOW, dbh: fakeDb(rows),
      });
      expect(stale).toBe('eta_claim_stale_facts');
    });

    test('the draft window still applies when the fix expiry is later than it', async () => {
      const reason = await etaClaimBlockReason({
        liveEtaSnapshot: entry({ fixExpiresAtMs: NOW.getTime() + 60 * 60 * 1000 }),
        factsGeneratedAt: new Date(NOW.getTime() - 16 * 60 * 1000).toISOString(),
        outgoingBody: 'The tech is 12 minutes away.', now: NOW, dbh: fakeDb(rows),
      });
      expect(reason).toBe('eta_claim_stale_facts');
    });

    test('status-only copy is NOT aged out by the fix expiry (rechecked against the tracker state instead)', async () => {
      const reason = await etaClaimBlockReason({
        liveEtaSnapshot: entry({ fixExpiresAtMs: NOW.getTime() - 1000 }),
        factsGeneratedAt: FRESH, outgoingBody: 'He is on the way and should be there in a few.', now: NOW, dbh: fakeDb(rows),
      });
      expect(reason).toBeNull();
    });
  });

  test('an unconvertible number word ("a thousand minutes away") with no snapshot is blocked (round 11 P2)', async () => {
    const reason = await etaClaimBlockReason({ liveEtaSnapshot: null, factsGeneratedAt: null, outgoingBody: 'The tech is a thousand minutes away.', now: NOW });
    expect(reason).toBe('eta_claim_no_snapshot');
  });

  test('"one hundred twenty minutes away" binds as 120 — unbound against a live 20', async () => {
    const reason = await etaClaimBlockReason({
      liveEtaSnapshot: { entries: [{ minutes: 20, scheduledServiceIds: ['svc-1'] }] },
      factsGeneratedAt: FRESH, outgoingBody: 'The tech is one hundred twenty minutes away.', now: NOW,
      dbh: fakeDb([{ id: 'svc-1', status: 'en_route', track_state: 'en_route' }]),
    });
    expect(reason).toBe('eta_claim_unbound');
  });

  // Codex pre-push P1 (round 12): with a live snapshot, window-hour copy must
  // not be rejected as an unbound/unread ETA.
  test.each([
    'Your arrival window is 2 hours.',
    'Your 2 hour arrival window starts at 9.',
  ])('%p with a live snapshot is not an ETA claim', async (outgoingBody) => {
    const reason = await etaClaimBlockReason({
      liveEtaSnapshot: { entries: [{ minutes: 2, scheduledServiceIds: ['svc-1'] }] },
      factsGeneratedAt: FRESH, outgoingBody, now: NOW,
      dbh: fakeDb([{ id: 'svc-1', status: 'en_route', track_state: 'en_route' }]),
    });
    expect(reason).toBeNull();
  });

  test('"The tech is 2 hours away." against a live 2 is still unbound', async () => {
    const reason = await etaClaimBlockReason({
      liveEtaSnapshot: { entries: [{ minutes: 2, scheduledServiceIds: ['svc-1'] }] },
      factsGeneratedAt: FRESH, outgoingBody: 'The tech is 2 hours away.', now: NOW,
      dbh: fakeDb([{ id: 'svc-1', status: 'en_route', track_state: 'en_route' }]),
    });
    expect(reason).toBe('eta_claim_unbound');
  });

  // Codex pre-push P1 (round 13): office follow-up timing is not a tech ETA.
  test.each([
    "I'll confirm your arrival window within the hour.",
    "I'll get back to you within the hour about your arrival.",
  ])('%p with a live snapshot is not an unbound ETA claim', async (outgoingBody) => {
    const reason = await etaClaimBlockReason({
      liveEtaSnapshot: { entries: [{ minutes: 2, scheduledServiceIds: ['svc-1'] }] },
      factsGeneratedAt: FRESH, outgoingBody, now: NOW,
      dbh: fakeDb([{ id: 'svc-1', status: 'en_route', track_state: 'en_route' }]),
    });
    expect(reason).toBeNull();
  });

  test('"The tech will arrive within the hour." against a live 2 is still unbound', async () => {
    const reason = await etaClaimBlockReason({
      liveEtaSnapshot: { entries: [{ minutes: 2, scheduledServiceIds: ['svc-1'] }] },
      factsGeneratedAt: FRESH, outgoingBody: 'The tech will arrive within the hour.', now: NOW,
      dbh: fakeDb([{ id: 'svc-1', status: 'en_route', track_state: 'en_route' }]),
    });
    expect(reason).toBe('eta_claim_unbound');
  });

  // Codex round-13 P2 (PR #5334) — seconds/days, the canonical link host, and
  // completed arrivals.
  describe('round 13 P2s', () => {
    const snap = { entries: [{ minutes: 2, scheduledServiceIds: ['svc-1'], trackTokens: ['tok-1'] }] };
    const enRoute = [{ id: 'svc-1', status: 'en_route', track_state: 'en_route', track_view_token: 'tok-1', track_token_expires_at: FUTURE }];
    const onSite = [{ id: 'svc-1', status: 'on_site', track_state: 'on_property', track_view_token: 'tok-1', track_token_expires_at: FUTURE }];
    const check = (outgoingBody, rows = enRoute, liveEtaSnapshot = snap) => etaClaimBlockReason({
      liveEtaSnapshot, factsGeneratedAt: FRESH, outgoingBody, now: NOW, dbh: fakeDb(rows),
    });

    test.each([
      'The tech is 90 seconds away.',
      'The tech is a few seconds away.',
      'The tech is 2 days away.',
    ])('%p is a timed claim that cannot bind (never status-only)', async (body) => {
      expect(await check(body)).toBe('eta_claim_unbound');
    });

    test('"60 seconds away" binds to an entry of exactly 1 minute', async () => {
      expect(await check('The tech is 60 seconds away.', enRoute, { entries: [{ minutes: 1, scheduledServiceIds: ['svc-1'] }] })).toBeNull();
    });

    describe('tracking links must be the canonical origin + exact token path', () => {
      test.each([
        'Track: evil.example/track/tok-1',
        'Track: https://evil.example/track/tok-1',
        'Track: portal.wavespestcontrol.com.evil.example/track/tok-1',
        'Track: evil.example/portal.wavespestcontrol.com/track/tok-1',
        'Track: portal.wavespestcontrol.com/track/tok-1/extra',
        'Track: portal.wavespestcontrol.com/track/tok-1?ref=x',
        'Track: portal.wavespestcontrol.com/track/tok-1#frag',
        'Track: /track/tok-1',
      ])('%p is refused', async (body) => {
        expect(await check(body)).toBe('eta_claim_link_untrusted');
      });

      test('a foreign link is refused even with no snapshot at all', async () => {
        expect(await etaClaimBlockReason({ liveEtaSnapshot: null, factsGeneratedAt: null, outgoingBody: 'Track: evil.example/track/tok-1', now: NOW })).toBe('eta_claim_link_untrusted');
      });

      test.each([
        'Track: portal.wavespestcontrol.com/track/tok-1',
        'Track: https://portal.wavespestcontrol.com/track/tok-1.',
        'Track: PORTAL.WAVESPESTCONTROL.COM/Track/tok-1',
        '(portal.wavespestcontrol.com/track/tok-1)',
      ])('%p is trusted (host compared case-insensitively, punctuation tolerated)', async (body) => {
        expect(await check(body)).toBeNull();
      });

      // Codex round-14 P2: a single-label host with a port (a CLIENT_URL of
      // http://localhost:5173) is a real host, compared as host:port.
      test('a localhost:port configured origin is recognized; other ports/hosts and a truly hostless link are refused', async () => {
        const prior = process.env.PUBLIC_PORTAL_URL;
        process.env.PUBLIC_PORTAL_URL = 'http://localhost:5173';
        try {
          expect(await check('Track: localhost:5173/track/tok-1')).toBeNull();
          expect(await check('Track: http://localhost:5173/track/tok-1')).toBeNull();
          expect(await check('Track: LOCALHOST:5173/Track/tok-1.')).toBeNull();
          expect(await check('Track: localhost:5174/track/tok-1')).toBe('eta_claim_link_untrusted');
          expect(await check('Track: http://localhost/track/tok-1')).toBe('eta_claim_link_untrusted');
          expect(await check('Track: portal.wavespestcontrol.com/track/tok-1')).toBe('eta_claim_link_untrusted');
          expect(await check('Track: evil:5173/track/tok-1')).toBe('eta_claim_link_untrusted');
          expect(await check('Track: /track/tok-1')).toBe('eta_claim_link_untrusted');
          expect(await check('Track: localhost:5173/track/tok-1/extra')).toBe('eta_claim_link_untrusted');
        } finally {
          if (prior === undefined) delete process.env.PUBLIC_PORTAL_URL; else process.env.PUBLIC_PORTAL_URL = prior;
        }
      });

      test('the configured portal origin is what is trusted (PUBLIC_PORTAL_URL)', async () => {
        const prior = process.env.PUBLIC_PORTAL_URL;
        process.env.PUBLIC_PORTAL_URL = 'https://portal.example.test';
        try {
          expect(await check('Track: portal.example.test/track/tok-1')).toBeNull();
          expect(await check('Track: portal.wavespestcontrol.com/track/tok-1')).toBe('eta_claim_link_untrusted');
        } finally {
          if (prior === undefined) delete process.env.PUBLIC_PORTAL_URL; else process.env.PUBLIC_PORTAL_URL = prior;
        }
      });
    });

    describe('a completed arrival requires the on-site tracker state', () => {
      test.each([
        'The technician has arrived.',
        'The tech is here.',
        'The tech pulled up.',
      ])('%p is blocked while the visit is still en_route', async (body) => {
        expect(await check(body, enRoute)).toBe('eta_claim_no_longer_en_route');
      });
      test('...and passes once the visit is on_property', async () => {
        expect(await check('The technician has arrived.', onSite)).toBeNull();
      });
      test.each([
        'The tech will arrive in a bit.',
        'The tech is on the way.',
      ])('%p stays en-route status: passes en_route, blocked once on site', async (body) => {
        // "on the way" is en-route-only copy; "will arrive" mentions arrival without minutes
        expect(await check(`${body} About 2 minutes.`, enRoute)).toBeNull();
      });
      test('a completed arrival beside a minutes claim contradicts itself — refused', async () => {
        expect(await check('The tech has arrived, about 2 minutes ago.', enRoute)).not.toBeNull();
        expect(await check('The tech has arrived and is 2 minutes away.', onSite)).toBe('eta_claim_unbound');
      });
      test('with no snapshot and no link, an arrival sentence is untouched', async () => {
        expect(await etaClaimBlockReason({ liveEtaSnapshot: null, factsGeneratedAt: null, outgoingBody: 'The technician has arrived.', now: NOW })).toBeNull();
      });
    });
  });
});

// Codex pre-push P1 (round 14, PR #5334): the status fallback needs an
// AFFIRMATIVE en-route claim, not a broad arrival trigger word — non-claims
// like "arrival window" / "visits left" must not be rechecked against the
// tracker (and blocked once the visit is on site or done).
describe('round 14 P1: status-only recheck requires an affirmative en-route claim', () => {
  const drafter = require('../services/sms-shadow-drafter');
  const real = jest.requireActual('../services/sms-shadow-drafter');
  beforeEach(() => {
    for (const name of ['findEtaMinutesClaims', 'bodyMentionsArrival', 'bodyMentionsVisitStatus', 'bodyHasTimedArrivalPhrase', 'bodyHasUnclassifiedArrivalDigit', 'findGroundedMinutesFigures']) {
      drafter[name].mockReset().mockImplementation(real[name]);
    }
  });
  const snapshot = { entries: [{ minutes: 12, scheduledServiceIds: ['svc-1'] }] };
  const rowsBy = {
    en_route: [{ id: 'svc-1', status: 'en_route', track_state: 'en_route' }],
    on_site: [{ id: 'svc-1', status: 'on_site', track_state: 'on_property' }],
    completed: [{ id: 'svc-1', status: 'completed', track_state: 'complete' }],
  };
  const run = (outgoingBody, rows) => etaClaimBlockReason({ liveEtaSnapshot: snapshot, factsGeneratedAt: FRESH, outgoingBody, now: NOW, dbh: fakeDb(rows) });

  test.each([
    "I'll confirm your arrival window within the hour.",
    'Your arrival window is 2 hours.',
    'You have 2 visits left this year.',
    "I'll text you once he's on the way.",
    'Your arrival window opens at 9.',
  ])('%p is not a status claim — null on en_route, on_site and completed rows alike', async (body) => {
    for (const rows of Object.values(rowsBy)) expect(await run(body, rows)).toBeNull();
  });

  test.each([
    'The tech is on the way.',
    'Your tech is en route.',
    'The tech has left for your place.',
    'The tech is close.',
    'He will be there.',
    'He is heading over now.',
  ])('%p is still a status claim — passes en_route, blocked once on site or done', async (body) => {
    expect(await run(body, rowsBy.en_route)).toBeNull();
    expect(await run(body, rowsBy.on_site)).toBe('eta_claim_no_longer_en_route');
    expect(await run(body, rowsBy.completed)).toBe('eta_claim_no_longer_en_route');
  });
});

// Codex round 15 (PR #5334) — at the send seam.
describe('round 15: corrections pass on done visits, coming/headed still recheck', () => {
  const drafter = require('../services/sms-shadow-drafter');
  const real = jest.requireActual('../services/sms-shadow-drafter');
  beforeEach(() => {
    for (const name of ['findEtaMinutesClaims', 'bodyMentionsArrival', 'bodyMentionsVisitStatus', 'bodyHasTimedArrivalPhrase', 'bodyHasUnclassifiedArrivalDigit', 'findGroundedMinutesFigures']) {
      drafter[name].mockReset().mockImplementation(real[name]);
    }
  });
  const snapshot = { entries: [{ minutes: 12, scheduledServiceIds: ['svc-1'] }] };
  const rowsBy = {
    en_route: [{ id: 'svc-1', status: 'en_route', track_state: 'en_route' }],
    on_site: [{ id: 'svc-1', status: 'on_site', track_state: 'on_property' }],
    completed: [{ id: 'svc-1', status: 'completed', track_state: 'complete' }],
  };
  const run = (outgoingBody, rows) => etaClaimBlockReason({ liveEtaSnapshot: snapshot, factsGeneratedAt: FRESH, outgoingBody, now: NOW, dbh: fakeDb(rows) });

  test.each([
    'He is no longer en route.', 'The tech is not on the way yet.', 'The tech has not arrived yet.', "The tech isn't here yet.",
  ])('%p (accurate correction) passes on en_route, on_site and completed rows', async (body) => {
    for (const rows of Object.values(rowsBy)) expect(await run(body, rows)).toBeNull();
  });

  test.each([
    'The tech is on the way.', 'The tech is coming now.', 'The tech is headed your way.',
  ])('%p still blocks once on site or done', async (body) => {
    expect(await run(body, rowsBy.en_route)).toBeNull();
    expect(await run(body, rowsBy.on_site)).toBe('eta_claim_no_longer_en_route');
    expect(await run(body, rowsBy.completed)).toBe('eta_claim_no_longer_en_route');
  });

  test('"ETA is 20 or so" against a live 12 is unbound', async () => {
    expect(await run('ETA is 20 or so.', rowsBy.en_route)).toBe('eta_claim_unbound');
  });
});

// Codex pre-push P1 (round 16, PR #5334): structural backstop for ETA phrasing
// no parser reads.
describe('round 16 P1: unclassified ETA backstop', () => {
  const drafter = require('../services/sms-shadow-drafter');
  const real = jest.requireActual('../services/sms-shadow-drafter');
  beforeEach(() => {
    for (const name of ['findEtaMinutesClaims', 'bodyMentionsArrival', 'bodyMentionsVisitStatus', 'bodyHasTimedArrivalPhrase', 'bodyHasUnclassifiedArrivalDigit', 'findGroundedMinutesFigures']) {
      drafter[name].mockReset().mockImplementation(real[name]);
    }
  });
  const snapshot = { entries: [{ minutes: 15, scheduledServiceIds: ['svc-1'] }] };
  const rowsBy = {
    en_route: [{ id: 'svc-1', status: 'en_route', track_state: 'en_route' }],
    on_site: [{ id: 'svc-1', status: 'on_site', track_state: 'on_property' }],
    completed: [{ id: 'svc-1', status: 'completed', track_state: 'complete' }],
  };
  const STALE = new Date(NOW.getTime() - 30 * 60 * 1000).toISOString();
  const run = (outgoingBody, rows, factsGeneratedAt = FRESH, liveEtaSnapshot = snapshot) => etaClaimBlockReason({ liveEtaSnapshot, factsGeneratedAt, outgoingBody, now: NOW, dbh: fakeDb(rows) });

  // "15 klicks out" reads no claim at all, so the backstop is what holds it; "tech: 15
  // min" is read as an ordinary minutes claim (blocked by that path instead).
  // Codex round-17 P2: an unparsed NUMERIC signal never passes on freshness +
  // liveness alone — it must parse and bind exactly, and it did not.
  test.each(['ur tech ≈ 15 klicks out 🚚', 'Tech ETA ≈ 99 mn'])('%p (an unparsed numeric signal) is blocked on every row state, fresh or not', async (body) => {
    for (const rows of Object.values(rowsBy)) expect(await run(body, rows)).toBe('eta_claim_unclassified');
    expect(await run(body, rowsBy.en_route, STALE)).toBe('eta_claim_unclassified');
  });

  test('"tech: 15 min" with a terminal or stale entry is blocked', async () => {
    expect(await run('tech: 15 min', rowsBy.en_route)).toBeNull(); // parses + binds exactly
    expect(await run('tech: 15 min', rowsBy.completed)).not.toBeNull();
    expect(await run('tech: 15 min', rowsBy.en_route, STALE)).not.toBeNull();
  });

  test.each([
    'Your 2 visits left this year.', 'Your arrival window 9-11.', 'Your arrival window is 2 hours.',
    '$20 is due at the visit.', 'Your renewal lands on the 20th.', 'Thanks, 5 stars!',
  ])('normal non-ETA copy %p with a snapshot is untouched even on terminal or stale rows', async (body) => {
    for (const rows of Object.values(rowsBy)) expect(await run(body, rows)).toBeNull();
    expect(await run(body, rowsBy.en_route, STALE)).toBeNull();
  });

  test('with no snapshot and no link the backstop never fires', async () => {
    expect(await etaClaimBlockReason({ liveEtaSnapshot: null, factsGeneratedAt: null, outgoingBody: 'tech: 15 min', now: NOW })).toBeNull();
  });

  test('with two live entries and no token to select one it is refused', async () => {
    const two = { entries: [{ minutes: 15, scheduledServiceIds: ['svc-1'] }, { minutes: 9, scheduledServiceIds: ['svc-2'] }] };
    expect(await run('ur tech ≈ 15 klicks out', [...rowsBy.en_route, { id: 'svc-2', status: 'en_route', track_state: 'en_route' }], FRESH, two)).toBe('eta_claim_unclassified');
  });
});

// Codex round-16 P2 (PR #5334): a status-only snapshot entry (minutes null)
// so status copy is rechecked even when GPS/Distance Matrix failed.
describe('round 16 P2: minutes-null (status-only) snapshot entries', () => {
  const drafter = require('../services/sms-shadow-drafter');
  const real = jest.requireActual('../services/sms-shadow-drafter');
  beforeEach(() => {
    for (const name of ['findEtaMinutesClaims', 'bodyMentionsArrival', 'bodyMentionsVisitStatus', 'bodyHasTimedArrivalPhrase', 'bodyHasUnclassifiedArrivalDigit', 'findGroundedMinutesFigures']) {
      drafter[name].mockReset().mockImplementation(real[name]);
    }
  });
  const snapshot = { entries: [{ minutes: null, scheduledServiceIds: ['svc-1'], trackTokens: ['tok-1'] }] };
  const rowsBy = {
    en_route: [{ id: 'svc-1', status: 'en_route', track_state: 'en_route', track_view_token: 'tok-1', track_token_expires_at: FUTURE }],
    completed: [{ id: 'svc-1', status: 'completed', track_state: 'complete', track_view_token: 'tok-1', track_token_expires_at: FUTURE }],
  };
  const run = (outgoingBody, rows) => etaClaimBlockReason({ liveEtaSnapshot: snapshot, factsGeneratedAt: FRESH, outgoingBody, now: NOW, dbh: fakeDb(rows) });

  test('status copy binds to it: passes while en route, blocked once the visit is done', async () => {
    expect(await run('The tech is on the way.', rowsBy.en_route)).toBeNull();
    expect(await run('The tech is on the way.', rowsBy.completed)).toBe('eta_claim_no_longer_en_route');
  });
  test('a numeric or timed claim against a minutes-null entry is unbound', async () => {
    expect(await run('The tech is 12 minutes away.', rowsBy.en_route)).toBe('eta_claim_unbound');
    expect(await run('The tech is about half an hour away.', rowsBy.en_route)).toBe('eta_claim_unbound');
  });
  test('non-ETA copy stays untouched', async () => {
    expect(await run('Thanks, see you soon!', rowsBy.completed)).toBeNull();
  });
  test('"1/2 hour away" against a live 120 entry is unbound (not "1/120")', async () => {
    expect(await etaClaimBlockReason({
      liveEtaSnapshot: { entries: [{ minutes: 120, scheduledServiceIds: ['svc-1'] }] }, factsGeneratedAt: FRESH,
      outgoingBody: 'The tech is 1/2 hour away.', now: NOW, dbh: fakeDb(rowsBy.en_route),
    })).toBe('eta_claim_unbound');
  });
});

// Codex round-17 P2s (PR #5334).
describe('round 17 P2s: link URL parsing, on-site wording, long durations on every path', () => {
  const drafter = require('../services/sms-shadow-drafter');
  const real = jest.requireActual('../services/sms-shadow-drafter');
  beforeEach(() => {
    for (const name of ['findEtaMinutesClaims', 'bodyMentionsArrival', 'bodyMentionsVisitStatus', 'bodyHasTimedArrivalPhrase', 'bodyHasUnclassifiedArrivalDigit', 'findGroundedMinutesFigures']) {
      drafter[name].mockReset().mockImplementation(real[name]);
    }
  });
  const snap = { entries: [{ minutes: 2, scheduledServiceIds: ['svc-1'], trackTokens: ['tok-1'] }] };
  const rowsBy = {
    en_route: [{ id: 'svc-1', status: 'en_route', track_state: 'en_route', track_view_token: 'tok-1', track_token_expires_at: FUTURE }],
    on_site: [{ id: 'svc-1', status: 'on_site', track_state: 'on_property', track_view_token: 'tok-1', track_token_expires_at: FUTURE }],
  };
  const check = (outgoingBody, rows = rowsBy.en_route) => etaClaimBlockReason({ liveEtaSnapshot: snap, factsGeneratedAt: FRESH, outgoingBody, now: NOW, dbh: fakeDb(rows) });

  test.each([
    'Track: https://evil.example/?next=portal.wavespestcontrol.com/track/tok-1',
    'Track: evil.example/?next=https://portal.wavespestcontrol.com/track/tok-1',
    'Track: https://evil.example/#portal.wavespestcontrol.com/track/tok-1',
    'Track: https://portal.wavespestcontrol.com@evil.example/track/tok-1',
    'Track: https://portal.wavespestcontrol.com:pw@evil.example/track/tok-1',
    'Track: https://portal.wavespestcontrol.com/track/tok-1#frag',
    'Track: https://portal.wavespestcontrol.com/track/tok-1?x=1',
    'Track: https://portal.wavespestcontrol.com/x/track/tok-1',
    'Track: https://portal.wavespestcontrol.com/track/tok-1%2Fmore',
  ])('%p is untrusted (parsed as a URL: host + exact pathname, no query/fragment/userinfo)', async (body) => {
    expect(await check(body)).toBe('eta_claim_link_untrusted');
  });
  test('the canonical link, with sentence punctuation or parens, still passes', async () => {
    expect(await check('Track: https://portal.wavespestcontrol.com/track/tok-1.')).toBeNull();
    expect(await check('(portal.wavespestcontrol.com/track/tok-1)')).toBeNull();
  });

  test.each([
    'The technician is on site.', 'The tech is on the property.', 'The tech is at your property.', 'The crew is on-site.',
  ])('%p is a completed arrival: blocked while en route, passes on property', async (body) => {
    expect(await check(body, rowsBy.en_route)).toBe('eta_claim_no_longer_en_route');
    expect(await check(body, rowsBy.on_site)).toBeNull();
  });
  test('a negated on-site correction passes en route', async () => {
    expect(await check('He is not on site yet.', rowsBy.en_route)).toBeNull();
  });

  test.each(['The tech is 2 days away.', 'The tech will arrive in 3 weeks.'])('%p with NO snapshot fails closed', async (body) => {
    expect(await etaClaimBlockReason({ liveEtaSnapshot: null, factsGeneratedAt: null, outgoingBody: body, now: NOW })).toBe('eta_claim_no_snapshot');
  });

  // Follow-up: day/week/month durations are a TECH-arrival claim only with a
  // tech subject; ordinary scheduling copy is never a claim, on any path.
  test.each([
    'Your visit is 2 days away.', "We'll see you in 2 weeks.", 'Your next treatment is in 3 weeks.', 'Your appointment is 3 weeks away.',
  ])('%p is ordinary scheduling copy: no claim with no snapshot, and none with a live snapshot', async (body) => {
    expect(await etaClaimBlockReason({ liveEtaSnapshot: null, factsGeneratedAt: null, outgoingBody: body, now: NOW })).toBeNull();
    expect(await check(body, rowsBy.on_site)).toBeNull();
  });
  test.each(['The tech is 2 days away.', 'He will arrive in 3 weeks.', 'The technician will arrive in a few days.'])('%p is still a tech claim: eta_claim_no_snapshot with no snapshot', async (body) => {
    expect(await etaClaimBlockReason({ liveEtaSnapshot: null, factsGeneratedAt: null, outgoingBody: body, now: NOW })).toBe('eta_claim_no_snapshot');
  });
});

// Codex round-18 P2s (PR #5334).
describe('round 18 P2s: on-site arrival recheck, technician reassignment', () => {
  const drafter = require('../services/sms-shadow-drafter');
  const real = jest.requireActual('../services/sms-shadow-drafter');
  beforeEach(() => {
    for (const name of ['findEtaMinutesClaims', 'bodyMentionsArrival', 'bodyMentionsVisitStatus', 'bodyHasTimedArrivalPhrase', 'bodyHasUnclassifiedArrivalDigit', 'findGroundedMinutesFigures']) {
      drafter[name].mockReset().mockImplementation(real[name]);
    }
  });
  const row = (over) => ({ id: 'svc-1', status: 'on_site', track_state: 'on_property', technician_id: 'tech-1', track_view_token: 'tok-1', track_token_expires_at: FUTURE, ...over });
  const onSiteSnapshot = { entries: [{ minutes: null, scheduledServiceIds: ['svc-1'], trackTokens: ['tok-1'], state: 'on_property', technicianId: 'tech-1' }] };
  const run = (body, rows, snapshot) => etaClaimBlockReason({ liveEtaSnapshot: snapshot, factsGeneratedAt: FRESH, outgoingBody: body, now: NOW, dbh: fakeDb(rows) });

  test('an on-site status group rechecks "has arrived": still on_property passes; completed / cancelled block', async () => {
    expect(await run('The technician has arrived.', [row()], onSiteSnapshot)).toBeNull();
    expect(await run('The technician has arrived.', [row({ status: 'completed', track_state: 'complete' })], onSiteSnapshot)).toBe('eta_claim_no_longer_en_route');
    expect(await run('The technician has arrived.', [row({ status: 'cancelled', track_state: 'cancelled' })], onSiteSnapshot)).toBe('eta_claim_no_longer_en_route');
  });

  const enRouteSnapshot = { entries: [{ minutes: 9, scheduledServiceIds: ['svc-1'], trackTokens: ['tok-1'], technicianId: 'tech-1' }] };
  const enRoute = (over) => row({ status: 'en_route', track_state: 'en_route', ...over });
  test('a reassigned en-route visit (technician_id changed) is refused for both a minutes claim and status copy', async () => {
    expect(await run('The tech is 9 minutes away.', [enRoute()], enRouteSnapshot)).toBeNull();
    expect(await run('The tech is 9 minutes away.', [enRoute({ technician_id: 'tech-2' })], enRouteSnapshot)).toBe('eta_claim_tech_changed');
    expect(await run('The tech is on the way.', [enRoute({ technician_id: 'tech-2' })], enRouteSnapshot)).toBe('eta_claim_tech_changed');
    expect(await run('The tech is on the way.', [enRoute({ technician_id: null })], enRouteSnapshot)).toBe('eta_claim_tech_changed');
  });
  test('an older snapshot entry without technicianId keeps the previous behavior', async () => {
    const old = { entries: [{ minutes: 9, scheduledServiceIds: ['svc-1'], trackTokens: ['tok-1'] }] };
    expect(await run('The tech is 9 minutes away.', [enRoute({ technician_id: 'tech-2' })], old)).toBeNull();
  });
  test('a link-only share is not a claim about the technician', async () => {
    expect(await run('Track: portal.wavespestcontrol.com/track/tok-1', [enRoute({ technician_id: 'tech-2' })], enRouteSnapshot)).toBeNull();
  });
});

// Numeric ambiguity counts only en-route entries (on_property can't be the subject of an ETA figure).
describe('numeric binding ignores on-site entries; status claims still see them', () => {
  const drafter = require('../services/sms-shadow-drafter');
  const real = jest.requireActual('../services/sms-shadow-drafter');
  beforeEach(() => {
    for (const name of ['findEtaMinutesClaims', 'bodyMentionsArrival', 'bodyMentionsVisitStatus', 'bodyHasTimedArrivalPhrase', 'bodyHasUnclassifiedArrivalDigit', 'findGroundedMinutesFigures']) {
      drafter[name].mockReset().mockImplementation(real[name]);
    }
  });
  const enRoute = { minutes: 12, scheduledServiceIds: ['svc-a'], trackTokens: ['tok-a'], state: 'en_route' };
  const onSite = { minutes: null, scheduledServiceIds: ['svc-b'], trackTokens: ['tok-b'], state: 'on_property' };
  const rows = [
    { id: 'svc-a', status: 'en_route', track_state: 'en_route', track_view_token: 'tok-a', track_token_expires_at: FUTURE },
    { id: 'svc-b', status: 'on_site', track_state: 'on_property', track_view_token: 'tok-b', track_token_expires_at: FUTURE },
  ];
  const run = (body, entries, dbRows = rows) => etaClaimBlockReason({ liveEtaSnapshot: { entries }, factsGeneratedAt: FRESH, outgoingBody: body, now: NOW, dbh: fakeDb(dbRows) });

  test('en-route(12) + on-site: "12 minutes away" binds to the en-route stop; a wrong figure is unbound', async () => {
    expect(await run('The tech is 12 minutes away.', [enRoute, onSite])).toBeNull();
    expect(await run('The tech is 9 minutes away.', [enRoute, onSite])).toBe('eta_claim_unbound');
  });
  test('two en-route stops are still ambiguous for a numeric claim', async () => {
    const other = { ...enRoute, scheduledServiceIds: ['svc-c'], trackTokens: ['tok-c'] };
    expect(await run('The tech is 12 minutes away.', [enRoute, other], [...rows, { id: 'svc-c', status: 'en_route', track_state: 'en_route' }])).toBe('eta_claim_ambiguous');
  });
  test('only on-site entries: a numeric claim has nothing to bind to', async () => {
    expect(await run('The tech is 12 minutes away.', [onSite])).toBe('eta_claim_unbound');
  });
  // Round 43 (supersedes the older "every group is ambiguous" expectation): candidates are narrowed by
  // the CLAIMED state first — one en-route group beside one on-property group leaves exactly one.
  test('status claims narrow by claimed state: en-route + on-site with no link -> "on the way" binds the en-route group, "has arrived" the on-site group', async () => {
    expect(await run('The tech is on the way.', [enRoute, onSite])).toBeNull();
    expect(await run('The technician has arrived.', [enRoute, onSite])).toBeNull();
    expect(await run('The tech is on the way: portal.wavespestcontrol.com/track/tok-a', [enRoute, onSite])).toBeNull();
    expect(await run('The technician has arrived: portal.wavespestcontrol.com/track/tok-b', [enRoute, onSite])).toBeNull();
  });
  test('...and each claim is held to ITS group: the en-route group gone while only the on-site one is live blocks "on the way"', async () => {
    const goneEnRoute = [{ id: 'svc-a', status: 'completed', track_state: 'completed', track_view_token: 'tok-a', track_token_expires_at: FUTURE }, rows[1]];
    expect(await run('The tech is on the way.', [enRoute, onSite], goneEnRoute)).toBe('eta_claim_no_longer_en_route');
    const goneOnSite = [rows[0], { id: 'svc-b', status: 'completed', track_state: 'completed', track_view_token: 'tok-b', track_token_expires_at: FUTURE }];
    expect(await run('The technician has arrived.', [enRoute, onSite], goneOnSite)).toBe('eta_claim_no_longer_en_route');
  });
  test('two groups of the SAME claimed state with no link are still ambiguous (singular claim)', async () => {
    const otherEn = { ...enRoute, scheduledServiceIds: ['svc-c'], trackTokens: ['tok-c'] };
    const otherOn = { ...onSite, scheduledServiceIds: ['svc-d'], trackTokens: ['tok-d'] };
    const extra = [{ id: 'svc-c', status: 'en_route', track_state: 'en_route', track_view_token: 'tok-c', track_token_expires_at: FUTURE }, { id: 'svc-d', status: 'on_site', track_state: 'on_property', track_view_token: 'tok-d', track_token_expires_at: FUTURE }];
    expect(await run('The tech is on the way.', [enRoute, otherEn, onSite], [...rows, extra[0]])).toBe('eta_claim_ambiguous');
    expect(await run('The technician has arrived.', [enRoute, onSite, otherOn], [...rows, extra[1]])).toBe('eta_claim_ambiguous');
    // a link still selects among same-state candidates
    expect(await run('The tech is on the way: portal.wavespestcontrol.com/track/tok-c', [enRoute, otherEn, onSite], [...rows, extra[0]])).toBeNull();
  });
  test('no state-compatible group at all keeps the old handling: the liveness check refuses it', async () => {
    expect(await run('The technician has arrived.', [enRoute, { ...enRoute, scheduledServiceIds: ['svc-c'], trackTokens: ['tok-c'] }], [...rows, { id: 'svc-c', status: 'en_route', track_state: 'en_route' }])).toBe('eta_claim_ambiguous');
  });
});

// Codex round-19 P2 (PR #5334): an explicit link scheme must be the canonical one.
describe('round 19 P2: explicit link scheme', () => {
  const drafter = require('../services/sms-shadow-drafter');
  const real = jest.requireActual('../services/sms-shadow-drafter');
  beforeEach(() => {
    for (const name of ['findEtaMinutesClaims', 'bodyMentionsArrival', 'bodyMentionsVisitStatus', 'bodyHasTimedArrivalPhrase', 'bodyHasUnclassifiedArrivalDigit', 'findGroundedMinutesFigures']) {
      drafter[name].mockReset().mockImplementation(real[name]);
    }
  });
  const snap = { entries: [{ minutes: 2, scheduledServiceIds: ['svc-1'], trackTokens: ['tok-1'] }] };
  const rows = [{ id: 'svc-1', status: 'en_route', track_state: 'en_route', track_view_token: 'tok-1', track_token_expires_at: FUTURE }];
  const check = (body) => etaClaimBlockReason({ liveEtaSnapshot: snap, factsGeneratedAt: FRESH, outgoingBody: body, now: NOW, dbh: fakeDb(rows) });

  test.each(['http://portal.wavespestcontrol.com/track/tok-1', 'ftp://portal.wavespestcontrol.com/track/tok-1', 'javascript://portal.wavespestcontrol.com/track/tok-1'])('%p is untrusted', async (link) => {
    expect(await check(`Track: ${link}`)).toBe('eta_claim_link_untrusted');
  });
  test('https:// and schemeless canonical links pass; a configured http origin accepts http', async () => {
    expect(await check('Track: https://portal.wavespestcontrol.com/track/tok-1')).toBeNull();
    expect(await check('Track: portal.wavespestcontrol.com/track/tok-1')).toBeNull();
    const prior = process.env.PUBLIC_PORTAL_URL;
    process.env.PUBLIC_PORTAL_URL = 'http://localhost:5173';
    try {
      expect(await check('Track: http://localhost:5173/track/tok-1')).toBeNull();
      expect(await check('Track: https://localhost:5173/track/tok-1')).toBe('eta_claim_link_untrusted');
    } finally {
      if (prior === undefined) delete process.env.PUBLIC_PORTAL_URL; else process.env.PUBLIC_PORTAL_URL = prior;
    }
  });
  test('a link ending in a digit is not read as a minutes figure at send time', async () => {
    const digitSnap = { entries: [{ minutes: 2, scheduledServiceIds: ['svc-1'], trackTokens: ['abcdef9'] }] };
    const r = [{ ...rows[0], track_view_token: 'abcdef9' }];
    expect(await etaClaimBlockReason({ liveEtaSnapshot: digitSnap, factsGeneratedAt: FRESH, outgoingBody: 'Track your tech: portal.wavespestcontrol.com/track/abcdef9', now: NOW, dbh: fakeDb(r) })).toBeNull();
  });
});

// Codex round-20 P2s (PR #5334): wording gaps ("The technician arrived.",
// "en-route") and destination identity. STRUCTURAL: a draft carrying a live
// snapshot whose body touches visit status is ALWAYS rechecked (state, tech,
// destination) even when no narrower classifier reads the wording.
describe('round 20 P2s: always-recheck on visit-status wording, destination identity', () => {
  const drafter = require('../services/sms-shadow-drafter');
  const real = jest.requireActual('../services/sms-shadow-drafter');
  const NAMES = ['findEtaMinutesClaims', 'bodyMentionsArrival', 'bodyMentionsVisitStatus', 'bodyHasTimedArrivalPhrase', 'bodyHasUnclassifiedArrivalDigit', 'findGroundedMinutesFigures'];
  beforeEach(() => { for (const name of NAMES) drafter[name].mockReset().mockImplementation(real[name]); });

  const dest = { id: 'svc-1', propertyId: 'prop-1', lat: 27.4, lng: -82.5, line1: '1 Test St', zip: '34285' };
  const row = (extra = {}) => ({ id: 'svc-1', status: 'en_route', track_state: 'en_route', technician_id: 'tech-1', property_id: 'prop-1', lat: '27.4', lng: '-82.5', service_address_line1: '1 TEST St ', service_address_zip: '34285', track_view_token: 'tok-1', track_token_expires_at: FUTURE, ...extra });
  const snap = (extra = {}) => ({ entries: [{ minutes: 9, scheduledServiceIds: ['svc-1'], trackTokens: ['tok-1'], technicianId: 'tech-1', state: 'en_route', destinations: [dest], ...extra }] });
  const run = (body, rows, snapshot = snap()) => etaClaimBlockReason({ liveEtaSnapshot: snapshot, factsGeneratedAt: FRESH, outgoingBody: body, now: NOW, dbh: fakeDb(rows) });

  test.each(['Your technician is en-route.', 'Your technician is en route.'])('%p is a status claim: passes en route, blocked once completed', async (body) => {
    expect(await run(body, [row()])).toBeNull();
    expect(await run(body, [row({ status: 'completed', track_state: 'completed' })])).toBe('eta_claim_no_longer_en_route');
  });

  test('"The technician arrived." (on-site snapshot): recheck runs; blocked after the visit completes or is cancelled, passes while on site', async () => {
    const onSite = snap({ minutes: null, state: 'on_property' });
    expect(await run('The technician arrived.', [row({ status: 'on_site', track_state: 'on_property' })], onSite)).toBeNull();
    expect(await run('The technician arrived.', [row({ status: 'completed', track_state: 'completed' })], onSite)).toBe('eta_claim_no_longer_en_route');
    expect(await run('The technician arrived.', [row({ status: 'cancelled', track_state: 'scheduled' })], onSite)).toBe('eta_claim_no_longer_en_route');
  });

  test('novel wording the classifiers never heard of still triggers the state recheck through the broad vocabulary gate', async () => {
    // No numeric / timed / completed-arrival / en-route-phrase classifier reads this.
    const body = 'Our driver is at your door.';
    expect(await run(body, [row({ status: 'completed', track_state: 'completed' })])).toBe('eta_claim_no_longer_en_route');
  });

  test('a recorded en-route entry whose visit is now on site blocks (status changed), same technician or not', async () => {
    expect(await run('Your technician is en-route.', [row({ status: 'on_site', track_state: 'on_property' })])).toBe('eta_claim_no_longer_en_route');
  });

  test('non-status copy and accurate corrections are untouched by the recheck (even on a completed visit)', async () => {
    const done = [row({ status: 'completed', track_state: 'completed' })];
    for (const body of ['Thanks, 5 stars!', "The technician hasn't arrived yet.", "I'll text you once he's on the way."]) expect(await run(body, done)).toBeNull();
  });

  test('technician reassignment blocks the recorded-state recheck', async () => {
    expect(await run('The technician arrived.', [row({ status: 'on_site', track_state: 'on_property', technician_id: 'tech-2' })], snap({ minutes: null, state: 'on_property' }))).toBe('eta_claim_tech_changed');
  });

  describe('destination identity', () => {
    test('same destination (numeric strings, case/space folding) passes a minutes claim', async () => {
      expect(await run('The tech is 9 minutes away.', [row()])).toBeNull();
    });
    test.each([
      ['property moved', { property_id: 'prop-2' }],
      ['coordinates moved', { lat: '27.9' }],
      ['coordinates cleared', { lat: null, lng: null }],
      ['street changed', { service_address_line1: '9 Other Ave' }],
      ['zip changed', { service_address_zip: '34292' }],
    ])('%s blocks a minutes claim, a status claim, and a link-only share', async (_n, extra) => {
      expect(await run('The tech is 9 minutes away.', [row(extra)])).toBe('eta_claim_destination_changed');
      expect(await run('Your technician is en-route.', [row(extra)])).toBe('eta_claim_destination_changed');
      expect(await run('Track: portal.wavespestcontrol.com/track/tok-1', [row(extra)])).toBe('eta_claim_destination_changed');
    });
    describe('customer-coordinate fallback (visit has no pin)', () => {
      const customerDest = { id: 'svc-1', propertyId: 'prop-1', lat: null, lng: null, line1: '1 Test St', zip: '34285', resolved: { source: 'customer', lat: 27.1, lng: -82.2 }, customerId: 'cust-1' };
      const noPinRow = (extra = {}) => row({ lat: null, lng: null, ...extra });
      const cSnap = () => snap({ destinations: [customerDest] });
      // fakeDb with a customers table for the fallback re-read.
      const dbWith = (rows, customer) => (table) => (table === 'customers'
        ? { where: () => ({ first: async () => customer }) }
        : { whereIn: () => ({ select: async () => dated(rows) }) });
      const runC = (customer, rows = [noPinRow()]) => etaClaimBlockReason({ liveEtaSnapshot: cSnap(), factsGeneratedAt: FRESH, outgoingBody: 'The tech is 9 minutes away.', now: NOW, dbh: dbWith(rows, customer) });
      const cust = (extra = {}) => ({ latitude: '27.1', longitude: '-82.2', address_line1: '1 Test St', zip: '34285', city: 'Venice', ...extra });
      test('same customer coordinates pass', async () => { expect(await runC(cust())).toBeNull(); });
      test('a re-geocoded customer address blocks', async () => {
        expect(await runC(cust({ latitude: '27.9' }))).toBe('eta_claim_destination_changed');
        expect(await runC(cust({ longitude: '-82.9' }))).toBe('eta_claim_destination_changed');
      });
      test('customer coordinates cleared, or the customer row unreadable, block', async () => {
        expect(await runC(cust({ latitude: null }))).toBe('eta_claim_destination_changed');
        expect(await runC(null)).toBe('eta_claim_destination_changed');
      });
      // Round 29: a half-stamped visit resolves per coordinate like the tracker.
      describe('mixed destination (visit latitude + customer longitude)', () => {
        const mixedDest = { id: 'svc-1', propertyId: 'prop-1', lat: 27.4, lng: null, line1: '1 Test St', zip: '34285', resolved: { source: 'mixed', lat: 27.4, lng: -82.2 }, customerId: 'cust-1' };
        const mSnap = () => snap({ destinations: [mixedDest] });
        const halfRow = (extra = {}) => row({ lat: '27.4', lng: null, ...extra });
        const runM = (customer, rows = [halfRow()]) => etaClaimBlockReason({ liveEtaSnapshot: mSnap(), factsGeneratedAt: FRESH, outgoingBody: 'The tech is 9 minutes away.', now: NOW, dbh: dbWith(rows, customer) });
        test('unchanged half + customer coordinate passes', async () => { expect(await runM(cust())).toBeNull(); });
        test('a re-geocoded customer longitude blocks; the visit later completing its pair blocks', async () => {
          expect(await runM(cust({ longitude: '-82.9' }))).toBe('eta_claim_destination_changed');
          expect(await runM(cust(), [row({ lat: '27.4', lng: '-82.2' })])).toBe('eta_claim_destination_changed');
        });
        test('the customer row unreadable blocks', async () => { expect(await runM(null)).toBe('eta_claim_destination_changed'); });
      });
      test('the visit later getting its own pin changes the source and blocks', async () => {
        expect(await runC(cust(), [row({ lat: '27.1', lng: '-82.2' })])).toBe('eta_claim_destination_changed');
      });
    });
    describe('tracker device identity (round 22)', () => {
      const { deviceFingerprint } = require('../services/live-eta-destination');
      const FP = deviceFingerprint('356938035643809');
      const dSnap = () => snap({ deviceImei: FP });
      const dbWithTech = (rows, tech) => (table) => (table === 'technicians'
        ? { where: () => ({ first: async () => tech }) }
        : { whereIn: () => ({ select: async () => dated(rows) }) });
      const runD = (tech, body = 'The tech is 9 minutes away.', snapshot = dSnap()) => etaClaimBlockReason({ liveEtaSnapshot: snapshot, factsGeneratedAt: FRESH, outgoingBody: body, now: NOW, dbh: dbWithTech([row()], tech) });
      test('same device passes', async () => { expect(await runD({ bouncie_imei: '356938035643809' })).toBeNull(); });
      test('a re-pointed, cleared or unreadable technician device blocks', async () => {
        expect(await runD({ bouncie_imei: '999999999999999' })).toBe('eta_claim_device_changed');
        expect(await runD({ bouncie_imei: null })).toBe('eta_claim_device_changed');
        expect(await runD(undefined)).toBe('eta_claim_device_changed');
      });
      test('also enforced on the recorded-state recheck ("The technician is en-route.")', async () => {
        expect(await runD({ bouncie_imei: '999999999999999' }, 'Your technician is en-route.')).toBe('eta_claim_device_changed');
      });
      test('a link-only share names no vehicle: device is not compared', async () => {
        expect(await runD({ bouncie_imei: '999999999999999' }, 'Track: portal.wavespestcontrol.com/track/tok-1')).toBeNull();
      });
      test('an entry that recorded no device keeps the previous behavior', async () => {
        expect(await runD({ bouncie_imei: '999999999999999' }, 'The tech is 9 minutes away.', snap())).toBeNull();
      });
    });
    describe('superseded GPS fix (round 24): recompute on a newer ping', () => {
      const { resolveLiveEtaMinutesUncached } = require('../services/context-aggregator');
      const FIX = Date.parse('2026-09-29T14:28:00.000Z');
      const fDest = { ...dest, resolved: { source: 'visit', lat: 27.4, lng: -82.5 } };
      const fSnap = () => snap({ fixAtMs: FIX, destinations: [fDest] });
      const TECH = { bouncie_imei: '356938035643809', bouncie_imei_changed_at: new Date('2026-09-01T00:00:00Z') };
      const dbWithStatus = (rows, status, tech = TECH) => (table) => {
        if (table === 'tech_status') return { where: () => ({ first: async () => status }) };
        if (table === 'technicians') return { where: () => ({ first: async () => tech }) };
        return { whereIn: () => ({ select: async () => dated(rows) }) };
      };
      const runF = (status, body = 'The tech is 9 minutes away.', snapshot = fSnap()) => etaClaimBlockReason({ liveEtaSnapshot: snapshot, factsGeneratedAt: FRESH, outgoingBody: body, now: NOW, dbh: dbWithStatus([row()], status) });
      beforeEach(() => resolveLiveEtaMinutesUncached.mockReset());

      test('the same fix (or an older one): no recompute, current behavior', async () => {
        expect(await runF({ location_updated_at: new Date(FIX) })).toBeNull();
        expect(await runF({ location_updated_at: new Date(FIX - 60e3) })).toBeNull();
        expect(resolveLiveEtaMinutesUncached).not.toHaveBeenCalled();
      });
      test('a newer ping + the recomputed minutes still match the claim: sends, recomputed for the same device and destination', async () => {
        resolveLiveEtaMinutesUncached.mockResolvedValue({ minutes: 9, fixAtMs: FIX + 30e3 });
        expect(await runF({ location_updated_at: new Date(FIX + 30e3) })).toBeNull();
        expect(resolveLiveEtaMinutesUncached).toHaveBeenCalledWith(
          expect.objectContaining({ technician_id: 'tech-1', tech_bouncie_imei: '356938035643809', tech_mapping_changed_at: TECH.bouncie_imei_changed_at }),
          { lat: 27.4, lng: -82.5 },
          expect.objectContaining({ dbh: expect.any(Function) }),
        );
      });
      test('the recompute rides the caller connection (Codex #5334 P1): the very dbh handed to etaClaimBlockReason', async () => {
        resolveLiveEtaMinutesUncached.mockResolvedValue({ minutes: 9, fixAtMs: FIX + 30e3 });
        const handoff = dbWithStatus([row()], { location_updated_at: new Date(FIX + 30e3) });
        await etaClaimBlockReason({ liveEtaSnapshot: fSnap(), factsGeneratedAt: FRESH, outgoingBody: 'The tech is 9 minutes away.', now: NOW, dbh: handoff });
        expect(resolveLiveEtaMinutesUncached.mock.calls[0][2].dbh).toBe(handoff);
      });
      test('a newer ping + different recomputed minutes: blocked', async () => {
        resolveLiveEtaMinutesUncached.mockResolvedValue({ minutes: 14, fixAtMs: FIX + 30e3 });
        expect(await runF({ location_updated_at: new Date(FIX + 30e3) })).toBe('eta_claim_superseded_fix');
      });
      test('a newer ping + recomputed minutes drifted within tolerance (max 2 min / 20%): sends; just outside: blocked', async () => {
        const newer = { location_updated_at: new Date(FIX + 30e3) };
        for (const m of [7, 8, 10, 11]) {
          resolveLiveEtaMinutesUncached.mockResolvedValue({ minutes: m, fixAtMs: FIX + 30e3 });
          expect(await runF(newer)).toBeNull();
        }
        for (const m of [6, 12]) {
          resolveLiveEtaMinutesUncached.mockResolvedValue({ minutes: m, fixAtMs: FIX + 30e3 });
          expect(await runF(newer)).toBe('eta_claim_superseded_fix');
        }
      });
      // Round 45: a provider / database outage is an INFRASTRUCTURE reason (retryable, in the shared set);
      // only a recompute that SUCCEEDED and differs — or one that is impossible for the entry — is the
      // terminal superseded-fix verdict.
      test('a newer ping + recompute UNAVAILABLE (provider null / throws): retryable infrastructure reason, not a permanent verdict', async () => {
        const { isEtaInfrastructureFailure } = require('../services/sms-eta-freshness');
        const newer = { location_updated_at: new Date(FIX + 30e3) };
        resolveLiveEtaMinutesUncached.mockResolvedValue(null);
        const nullReason = await runF(newer);
        expect(nullReason).toBe('eta_claim_recompute_unavailable');
        resolveLiveEtaMinutesUncached.mockRejectedValue(new Error('provider down'));
        expect(await runF(newer)).toBe('eta_claim_recompute_unavailable');
        expect(isEtaInfrastructureFailure(nullReason)).toBe(true);
      });
      test('a newer ping + recompute IMPOSSIBLE for the entry (no technician row, no recorded destination): terminal superseded', async () => {
        const newer = { location_updated_at: new Date(FIX + 30e3) };
        resolveLiveEtaMinutesUncached.mockResolvedValue({ minutes: 9 });
        expect(await etaClaimBlockReason({ liveEtaSnapshot: fSnap(), factsGeneratedAt: FRESH, outgoingBody: 'The tech is 9 minutes away.', now: NOW, dbh: dbWithStatus([row()], newer, null) })).toBe('eta_claim_superseded_fix');
        expect(await runF(newer, 'The tech is 9 minutes away.', snap({ fixAtMs: FIX }))).toBe('eta_claim_superseded_fix');
      });
      // Round 27: the direct-Bouncie fallback path leaves no fresh tech_status row
      // (its cache write is async and may never land) — that is not proof of a
      // newer fix, so the ETA is recomputed instead of the send being refused.
      test.each([['no tech_status row', undefined], ['null timestamp', { location_updated_at: null }], ['garbage timestamp', { location_updated_at: 'not a date' }]])('%s + recompute matches (within tolerance): sends', async (_n, status) => {
        resolveLiveEtaMinutesUncached.mockResolvedValue({ minutes: 10 }); // claim 9: within max(2 min, 20%)
        expect(await runF(status)).toBeNull();
        expect(resolveLiveEtaMinutesUncached).toHaveBeenCalledTimes(1);
      });
      test.each([['no tech_status row', undefined], ['null timestamp', { location_updated_at: null }]])('%s + recompute differs beyond tolerance: blocked', async (_n, status) => {
        resolveLiveEtaMinutesUncached.mockResolvedValue({ minutes: 20 });
        expect(await runF(status)).toBe('eta_claim_superseded_fix');
      });
      test.each([['no tech_status row', undefined], ['null timestamp', { location_updated_at: null }]])('%s + recompute unavailable (null / throws): blocked', async (_n, status) => {
        resolveLiveEtaMinutesUncached.mockResolvedValue(null);
        expect(await runF(status)).toBe('eta_claim_recompute_unavailable');
        resolveLiveEtaMinutesUncached.mockRejectedValue(new Error('provider down'));
        expect(await runF(status)).toBe('eta_claim_recompute_unavailable');
      });
      test('a status-only claim (no minutes figure) is not held to the fix and never recomputes', async () => {
        expect(await runF({ location_updated_at: new Date(FIX + 30e3) }, 'Your technician is en-route.')).toBeNull();
        expect(resolveLiveEtaMinutesUncached).not.toHaveBeenCalled();
      });
      test('an entry with no recorded fix keeps the previous behavior', async () => {
        expect(await etaClaimBlockReason({ liveEtaSnapshot: snap(), factsGeneratedAt: FRESH, outgoingBody: 'The tech is 9 minutes away.', now: NOW, dbh: dbWithStatus([row()], { location_updated_at: new Date(FIX + 30e3) }) })).toBeNull();
        expect(resolveLiveEtaMinutesUncached).not.toHaveBeenCalled();
      });
    });
    test('a recorded destination whose visit row cannot be read blocks', async () => {
      expect(await run('The tech is 9 minutes away.', [row({ id: 'svc-other' })])).toBe('eta_claim_no_longer_en_route');
      const two = snap({ scheduledServiceIds: ['svc-1'], destinations: [dest, { ...dest, id: 'svc-ghost' }] });
      expect(await run('The tech is 9 minutes away.', [row()], two)).toBe('eta_claim_destination_changed');
    });
  });
});

// Auditor P1 (PR #5334): every claim kind is about a visit happening TODAY (ET).
// Status-only claims skip the draft-freshness window, so yesterday's still-en_route
// visit must not let a queued "The tech is on the way" send the NEXT day.
describe('visit must be scheduled today (ET) for every claim kind', () => {
  const drafter = require('../services/sms-shadow-drafter');
  const real = jest.requireActual('../services/sms-shadow-drafter');
  const NAMES = ['findEtaMinutesClaims', 'bodyMentionsArrival', 'bodyMentionsVisitStatus', 'bodyHasTimedArrivalPhrase', 'bodyHasUnclassifiedArrivalDigit', 'findGroundedMinutesFigures'];
  beforeEach(() => { for (const name of NAMES) drafter[name].mockReset().mockImplementation(real[name]); });

  const today = etDateString();
  const yesterday = (() => { const [y, m, d] = today.split('-').map(Number); const dt = new Date(Date.UTC(y, m - 1, d - 1)); return dt.toISOString().slice(0, 10); })();
  const tomorrow = (() => { const [y, m, d] = today.split('-').map(Number); const dt = new Date(Date.UTC(y, m - 1, d + 1)); return dt.toISOString().slice(0, 10); })();
  const snapFor = (extra = {}) => ({ entries: [{ minutes: 9, scheduledServiceIds: ['svc-1'], trackTokens: ['tok-1'], state: 'en_route', ...extra }] });
  const enRoute = (extra = {}) => ({ id: 'svc-1', status: 'en_route', track_state: 'en_route', track_view_token: 'tok-1', track_token_expires_at: FUTURE, ...extra });
  const run = (body, rows, snapshot = snapFor()) => etaClaimBlockReason({ liveEtaSnapshot: snapshot, factsGeneratedAt: FRESH, outgoingBody: body, now: NOW, dbh: fakeDb(rows) });

  test('today passes for status-only, minutes, link-only and recorded-state bodies', async () => {
    const rows = [enRoute({ scheduled_date: today })];
    expect(await run('The tech is on the way.', rows)).toBeNull();
    expect(await run('The tech is 9 minutes away.', rows)).toBeNull();
    expect(await run('Track: portal.wavespestcontrol.com/track/tok-1', rows)).toBeNull();
    expect(await run('The technician showed up.', rows)).toBeNull(); // recorded-state recheck (no narrower classifier)
  });
  test.each([['yesterday', yesterday], ['tomorrow', tomorrow]])('a visit dated %s that still reads en_route blocks every claim kind', async (_n, day) => {
    const rows = [enRoute({ scheduled_date: day })];
    // status-only (skips draft freshness), stale-day minutes, a bare link, and a recorded-state recheck
    for (const body of ['The tech is on the way.', 'The tech is 9 minutes away.', 'Track: portal.wavespestcontrol.com/track/tok-1', 'The technician showed up.']) {
      expect(await run(body, rows)).toBe('eta_claim_visit_not_today');
    }
  });
  test('a status-only claim on yesterday\'s en_route visit is blocked even with stale facts skipped', async () => {
    expect(await etaClaimBlockReason({ liveEtaSnapshot: snapFor({ minutes: null }), factsGeneratedAt: STALE, outgoingBody: 'The technician is on the way.', now: NOW, dbh: fakeDb([enRoute({ scheduled_date: yesterday })]) })).toBe('eta_claim_visit_not_today');
  });
  test('a missing or unreadable scheduled_date blocks', async () => {
    for (const bad of [null, undefined, 'not-a-date', '']) {
      expect(await etaClaimBlockReason({ liveEtaSnapshot: snapFor(), factsGeneratedAt: FRESH, outgoingBody: 'The tech is on the way.', now: NOW, dbh: () => ({ whereIn: () => ({ select: async () => [enRoute({ scheduled_date: bad })] }) }) })).toBe('eta_claim_visit_not_today');
    }
  });
  test('a Date-typed DATE value (pg) for today passes; one sibling on another day blocks the group', async () => {
    const [y, m, d] = today.split('-').map(Number);
    expect(await run('The tech is on the way.', [enRoute({ scheduled_date: new Date(y, m - 1, d) })])).toBeNull();
    const two = { entries: [{ minutes: 9, scheduledServiceIds: ['svc-1', 'svc-2'], trackTokens: ['tok-1'], state: 'en_route' }] };
    expect(await run('The tech is on the way.', [enRoute({ scheduled_date: today }), enRoute({ id: 'svc-2', track_view_token: 'tok-2', scheduled_date: yesterday })], two)).toBe('eta_claim_visit_not_today');
  });
});

// CI regression (PR #5334, admin-communications-sms "within the hour is ordinary
// English"): an approved follow-up SLA phrase is not an unverifiable timed claim
// when the draft carries NO live ETA context; it is still held to one when it does.
describe('"within the hour" (approved SLA phrase) with no live context', () => {
  const drafter = require('../services/sms-shadow-drafter');
  const real = jest.requireActual('../services/sms-shadow-drafter');
  const NAMES = ['findEtaMinutesClaims', 'bodyMentionsArrival', 'bodyMentionsVisitStatus', 'bodyHasTimedArrivalPhrase', 'bodyHasUnclassifiedArrivalDigit', 'findGroundedMinutesFigures'];
  beforeEach(() => { for (const name of NAMES) drafter[name].mockReset().mockImplementation(real[name]); });
  const noSnap = (body) => etaClaimBlockReason({ liveEtaSnapshot: null, factsGeneratedAt: null, outgoingBody: body, now: NOW, dbh: fakeDb([]) });

  test.each([
    'Your technician is nearby and should arrive within the hour.',
    'Sorry about that — someone will follow up within the hour.',
    'The tech should be there within the hour.',
  ])('%p sends with no snapshot and no link', async (body) => {
    expect(await noSnap(body)).toBeNull();
  });
  test.each([
    'The tech will arrive in 2 hours.', 'The tech should arrive within 2 hours.', 'The tech will arrive in an hour.', 'The tech will arrive in 3 days.',
  ])('other hour/day durations are still unverifiable without a snapshot: %p', async (body) => {
    expect(await noSnap(body)).toBe('eta_claim_no_snapshot');
  });
  test('with a live snapshot the SLA-phrase arrival claim is still held to it (unbound, not waved through)', async () => {
    const snapshot = { entries: [{ minutes: 9, scheduledServiceIds: ['svc-1'], trackTokens: ['tok-1'] }] };
    expect(await etaClaimBlockReason({
      liveEtaSnapshot: snapshot, factsGeneratedAt: FRESH, outgoingBody: 'Your technician is nearby and should arrive within the hour.', now: NOW,
      dbh: fakeDb([{ id: 'svc-1', status: 'en_route', track_state: 'en_route', track_view_token: 'tok-1', track_token_expires_at: FUTURE }]),
    })).toBe('eta_claim_unbound');
  });
  test('a body carrying a /track/ link is a live context: the phrase is held (no snapshot -> fails closed)', async () => {
    expect(await noSnap('The tech should arrive within the hour: portal.wavespestcontrol.com/track/tok-1')).not.toBeNull();
  });
});

// Codex round-31 P2 (PR #5334): a status clause naming an explicit future day is a
// scheduling statement, so the send-time classifier does not hold it to today's stop.
describe('future-day status copy is not live status at send time', () => {
  const drafter = require('../services/sms-shadow-drafter');
  const real = jest.requireActual('../services/sms-shadow-drafter');
  const NAMES = ['findEtaMinutesClaims', 'bodyMentionsArrival', 'bodyMentionsVisitStatus', 'bodyHasTimedArrivalPhrase', 'bodyHasUnclassifiedArrivalDigit', 'findGroundedMinutesFigures'];
  beforeEach(() => { for (const name of NAMES) drafter[name].mockReset().mockImplementation(real[name]); });
  const snapshot = { entries: [{ minutes: 9, scheduledServiceIds: ['svc-1'], trackTokens: ['tok-1'], state: 'en_route' }] };
  const done = [{ id: 'svc-1', status: 'completed', track_state: 'completed', track_view_token: 'tok-1', track_token_expires_at: FUTURE }];
  const run = (body) => etaClaimBlockReason({ liveEtaSnapshot: snapshot, factsGeneratedAt: FRESH, outgoingBody: body, now: NOW, dbh: fakeDb(done) });
  test.each(['Your technician is coming tomorrow.', 'We will be there next week.', 'Our team will be there on the 5th.'])('%p sends even though today\'s visit is done', async (body) => {
    expect(await run(body)).toBeNull();
  });
  test.each(['Your technician is coming today.', 'Our team is on the way.', 'The team is en route now.'])('%p is live status: blocked once the visit is done', async (body) => {
    expect(await run(body)).toBe('eta_claim_no_longer_en_route');
  });
});

// Codex round-32 P2 (PR #5334): "running late/ahead" are prompt-sanctioned live
// status, so they are rechecked at send time like "on the way".
describe('running late / ahead are live status at send time', () => {
  const drafter = require('../services/sms-shadow-drafter');
  const real = jest.requireActual('../services/sms-shadow-drafter');
  const NAMES = ['findEtaMinutesClaims', 'bodyMentionsArrival', 'bodyMentionsVisitStatus', 'bodyHasTimedArrivalPhrase', 'bodyHasUnclassifiedArrivalDigit', 'findGroundedMinutesFigures'];
  beforeEach(() => { for (const name of NAMES) drafter[name].mockReset().mockImplementation(real[name]); });
  const snapshot = { entries: [{ minutes: 9, scheduledServiceIds: ['svc-1'], trackTokens: ['tok-1'], state: 'en_route' }] };
  const row = (extra) => [{ id: 'svc-1', status: 'en_route', track_state: 'en_route', track_view_token: 'tok-1', track_token_expires_at: FUTURE, ...extra }];
  const run = (body, rows) => etaClaimBlockReason({ liveEtaSnapshot: snapshot, factsGeneratedAt: FRESH, outgoingBody: body, now: NOW, dbh: fakeDb(rows) });
  test.each(['Your technician is running late.', 'The crew is running ahead of schedule.', 'Your tech is running a bit behind.'])('%p: passes while en route, blocked once the visit is done', async (body) => {
    expect(await run(body, row())).toBeNull();
    expect(await run(body, row({ status: 'completed', track_state: 'completed' }))).toBe('eta_claim_no_longer_en_route');
  });
  test('a status clause with a trailing future-day clause is still rechecked', async () => {
    expect(await run("Your technician is on the way, and we'll follow up tomorrow.", row({ status: 'completed', track_state: 'completed' }))).toBe('eta_claim_no_longer_en_route');
  });
});

// Codex round-33 (PR #5334): a recorded technician name is a status subject at send
// time, read from the persisted snapshot (no extra DB read). Synthetic names.
describe('recorded technician names are status subjects at send time', () => {
  const drafter = require('../services/sms-shadow-drafter');
  const real = jest.requireActual('../services/sms-shadow-drafter');
  const NAMES = ['findEtaMinutesClaims', 'bodyMentionsArrival', 'bodyMentionsVisitStatus', 'bodyHasTimedArrivalPhrase', 'bodyHasUnclassifiedArrivalDigit', 'findGroundedMinutesFigures'];
  beforeEach(() => { for (const name of NAMES) drafter[name].mockReset().mockImplementation(real[name]); });
  const named = { entries: [{ minutes: null, scheduledServiceIds: ['svc-1'], trackTokens: ['tok-1'], state: 'en_route', technicianNames: ['Sam'] }] };
  const unnamed = { entries: [{ minutes: null, scheduledServiceIds: ['svc-1'], trackTokens: ['tok-1'], state: 'en_route' }] };
  const rows = (extra) => [{ id: 'svc-1', status: 'en_route', track_state: 'en_route', track_view_token: 'tok-1', track_token_expires_at: FUTURE, ...extra }];
  const done = { status: 'completed', track_state: 'completed' };
  const run = (body, snapshot, extra) => etaClaimBlockReason({ liveEtaSnapshot: snapshot, factsGeneratedAt: FRESH, outgoingBody: body, now: NOW, dbh: fakeDb(rows(extra)) });
  test.each(['Sam is on the way.', 'Sam is running late.', "Sam's en route."])('%p is rechecked: passes en route, blocked once the visit is done', async (body) => {
    expect(await run(body, named)).toBeNull();
    expect(await run(body, named, done)).toBe('eta_claim_no_longer_en_route');
  });
  test('"Sam has arrived." is a completed-arrival claim: needs the on-site state', async () => {
    expect(await run('Sam has arrived.', named)).toBe('eta_claim_no_longer_en_route'); // still en route, not on property
    expect(await run('Sam has arrived.', named, { status: 'on_site', track_state: 'on_property' })).toBeNull();
  });
  test('an older snapshot without names keeps the current behavior (the name is not a subject)', async () => {
    expect(await run('Sam is on the way.', unnamed, done)).toBeNull();
  });
  test('another first name is not a status subject: "Dana\'s order is on the way." is untouched', async () => {
    expect(await run("Dana's order is on the way.", named, done)).toBeNull();
    expect(await run('Dana is on the way to the store.', named, done)).toBeNull();
  });
});

// Codex round-34 P2s (PR #5334): send-time recheck for first-person route claims and
// for technicians whose first name is an auxiliary (synthetic: Will, Mark).
describe('"we" route claims and auxiliary-named technicians at send time', () => {
  const drafter = require('../services/sms-shadow-drafter');
  const real = jest.requireActual('../services/sms-shadow-drafter');
  const NAMES = ['findEtaMinutesClaims', 'bodyMentionsArrival', 'bodyMentionsVisitStatus', 'bodyHasTimedArrivalPhrase', 'bodyHasUnclassifiedArrivalDigit', 'findGroundedMinutesFigures'];
  beforeEach(() => { for (const name of NAMES) drafter[name].mockReset().mockImplementation(real[name]); });
  const snap = (technicianNames) => ({ entries: [{ minutes: null, scheduledServiceIds: ['svc-1'], trackTokens: ['tok-1'], state: 'en_route', ...(technicianNames ? { technicianNames } : {}) }] });
  const rows = (extra) => [{ id: 'svc-1', status: 'en_route', track_state: 'en_route', track_view_token: 'tok-1', track_token_expires_at: FUTURE, ...extra }];
  const done = { status: 'completed', track_state: 'completed' };
  const run = (body, snapshot, extra) => etaClaimBlockReason({ liveEtaSnapshot: snapshot, factsGeneratedAt: FRESH, outgoingBody: body, now: NOW, dbh: fakeDb(rows(extra)) });
  test.each(["We're on our way.", "We're en route.", 'We are running late.'])('%p: passes en route, blocked once the visit is done', async (body) => {
    expect(await run(body, snap())).toBeNull();
    expect(await run(body, snap(), done)).toBe('eta_claim_no_longer_en_route');
  });
  test('"We will be there shortly." is a vague timed claim as well: it needs an exact figure to bind (unbound), never waved through', async () => {
    expect(await run('We will be there shortly.', snap())).toBe('eta_claim_unbound');
  });
  test.each(["We're here to help.", 'We will be there Tuesday.', 'We will be there tomorrow.'])('%p is untouched even on a done visit', async (body) => {
    expect(await run(body, snap(), done)).toBeNull();
  });
  test.each([['Will', 'Will is on the way.'], ['Mark', 'Mark is running late.'], ['Will', 'Will has arrived.']])('tech %p: %p is rechecked', async (name, body) => {
    expect(await run(body, snap([name]), done)).toBe('eta_claim_no_longer_en_route');
  });
  test('a genuine question is still not a claim for a tech named Will', async () => {
    expect(await run('Will your technician be there?', snap(['Will']), done)).toBeNull();
    expect(await run('Has Mark arrived yet?', snap(['Mark']), done)).toBeNull();
  });
});

// Codex round-35 P2 (PR #5334): a plural subject speaks for every stop.
describe('plural route claims bind every snapshot entry, link or not', () => {
  const drafter = require('../services/sms-shadow-drafter');
  const real = jest.requireActual('../services/sms-shadow-drafter');
  const NAMES = ['findEtaMinutesClaims', 'bodyMentionsArrival', 'bodyMentionsVisitStatus', 'bodyHasTimedArrivalPhrase', 'bodyHasUnclassifiedArrivalDigit', 'findGroundedMinutesFigures'];
  beforeEach(() => { for (const name of NAMES) drafter[name].mockReset().mockImplementation(real[name]); });
  const entry = (id, tok, extra) => ({ minutes: null, scheduledServiceIds: [id], trackTokens: [tok], state: 'en_route', ...extra });
  const snapshot = { entries: [entry('svc-1', 'tok-1'), entry('svc-2', 'tok-2')] };
  const row = (id, tok, extra) => ({ id, status: 'en_route', track_state: 'en_route', track_view_token: tok, track_token_expires_at: FUTURE, ...extra });
  const run = (body, rows, snap = snapshot) => etaClaimBlockReason({ liveEtaSnapshot: snap, factsGeneratedAt: FRESH, outgoingBody: body, now: NOW, dbh: fakeDb(rows) });
  const both = [row('svc-1', 'tok-1'), row('svc-2', 'tok-2')];
  const secondDone = [row('svc-1', 'tok-1'), row('svc-2', 'tok-2', { status: 'completed', track_state: 'completed' })];

  test.each(['Your techs are on the way.', 'Our team is en route.', "We're on our way.", 'Your technicians are running late.'])('%p with NO link: bound to every entry (was ambiguous)', async (body) => {
    expect(await run(body, both)).toBeNull();
    expect(await run(body, secondDone)).toBe('eta_claim_no_longer_en_route');
  });
  test('with ONE linked entry the plural claim still covers the OTHER stop', async () => {
    const body = 'Your techs are on the way: portal.wavespestcontrol.com/track/tok-1';
    expect(await run(body, both)).toBeNull();
    expect(await run(body, secondDone)).toBe('eta_claim_no_longer_en_route'); // the unlinked stop went terminal
  });
  test('a SINGULAR claim with one link binds only the linked entry (unchanged)', async () => {
    const body = 'Your tech is on the way: portal.wavespestcontrol.com/track/tok-1';
    expect(await run(body, secondDone)).toBeNull();
  });
  test('a singular claim with no link and several entries stays ambiguous (unchanged)', async () => {
    expect(await run('Your tech is on the way.', both)).toBe('eta_claim_ambiguous');
  });
  test('an arrived claim in the plural binds every on-site entry; en-route entries are not required to be on site', async () => {
    const mixed = { entries: [entry('svc-1', 'tok-1', { state: 'on_property' }), entry('svc-2', 'tok-2')] };
    const onSite = [row('svc-1', 'tok-1', { status: 'on_site', track_state: 'on_property' }), row('svc-2', 'tok-2')];
    expect(await run('Our team has arrived.', onSite, mixed)).toBeNull();
    expect(await run('Our team has arrived.', [row('svc-1', 'tok-1'), row('svc-2', 'tok-2')], mixed)).toBe('eta_claim_no_longer_en_route');
  });
  test('a plural en-route claim ignores an on-site entry (only en-route stops can be on the way)', async () => {
    const mixed = { entries: [entry('svc-1', 'tok-1', { state: 'on_property' }), entry('svc-2', 'tok-2')] };
    expect(await run('Your techs are on the way.', [row('svc-1', 'tok-1', { status: 'on_site', track_state: 'on_property' }), row('svc-2', 'tok-2')], mixed)).toBe(null);
  });
});

// Codex round-36 P2s (PR #5334): coordinated predicates / past-tense history at send time.
describe('coordinated predicates and route history at send time', () => {
  const drafter = require('../services/sms-shadow-drafter');
  const real = jest.requireActual('../services/sms-shadow-drafter');
  const NAMES = ['findEtaMinutesClaims', 'bodyMentionsArrival', 'bodyMentionsVisitStatus', 'bodyHasTimedArrivalPhrase', 'bodyHasUnclassifiedArrivalDigit', 'findGroundedMinutesFigures'];
  beforeEach(() => { for (const name of NAMES) drafter[name].mockReset().mockImplementation(real[name]); });
  const snapshot = { entries: [{ minutes: null, scheduledServiceIds: ['svc-1'], trackTokens: ['tok-1'], state: 'en_route' }] };
  const rows = (extra) => [{ id: 'svc-1', status: 'en_route', track_state: 'en_route', track_view_token: 'tok-1', track_token_expires_at: FUTURE, ...extra }];
  const done = { status: 'completed', track_state: 'completed' };
  const run = (body, extra) => etaClaimBlockReason({ liveEtaSnapshot: snapshot, factsGeneratedAt: FRESH, outgoingBody: body, now: NOW, dbh: fakeDb(rows(extra)) });
  test.each(["The technician isn't there yet, but is on the way.", "The technician hasn't arrived, but is en route."])('%p is rechecked: blocked once the visit is done', async (body) => {
    expect(await run(body)).toBeNull();
    expect(await run(body, done)).toBe('eta_claim_no_longer_en_route');
  });
  test('past-tense route history is not a live claim (sends even on a done visit)', async () => {
    expect(await run('The technician was on the way earlier.', done)).toBeNull();
  });
  test('"was on the way earlier, but has now arrived" needs the on-property state', async () => {
    const body = 'The technician was on the way earlier, but has now arrived.';
    expect(await run(body)).toBe('eta_claim_no_longer_en_route'); // still en route, not on property
    expect(await run(body, { status: 'on_site', track_state: 'on_property' })).toBeNull();
  });
});

// Codex round-37 P2 (PR #5334): a link-only share names ONE visit — the token owner —
// so an unrelated grouped sibling that moved or was rescheduled cannot reject it.
describe('link-only rechecks are scoped to the token-owning visit', () => {
  const drafter = require('../services/sms-shadow-drafter');
  const real = jest.requireActual('../services/sms-shadow-drafter');
  const NAMES = ['findEtaMinutesClaims', 'bodyMentionsArrival', 'bodyMentionsVisitStatus', 'bodyHasTimedArrivalPhrase', 'bodyHasUnclassifiedArrivalDigit', 'findGroundedMinutesFigures'];
  beforeEach(() => { for (const name of NAMES) drafter[name].mockReset().mockImplementation(real[name]); });
  const dest = (id) => ({ id, propertyId: 'prop-1', lat: 27.4, lng: -82.5, line1: '1 Test St', zip: '34285', resolved: { source: 'visit', lat: 27.4, lng: -82.5 } });
  const snapshot = { entries: [{ minutes: null, scheduledServiceIds: ['svc-1', 'svc-2'], trackTokens: ['tok-1', 'tok-2'], state: 'en_route', destinations: [dest('svc-1'), dest('svc-2')] }] };
  const row = (id, tok, extra) => ({ id, status: 'en_route', track_state: 'en_route', track_view_token: tok, track_token_expires_at: FUTURE, property_id: 'prop-1', lat: '27.4', lng: '-82.5', service_address_line1: '1 Test St', service_address_zip: '34285', ...extra });
  const link = 'Track: portal.wavespestcontrol.com/track/tok-1';
  const run = (rows, body = link) => etaClaimBlockReason({ liveEtaSnapshot: snapshot, factsGeneratedAt: FRESH, outgoingBody: body, now: NOW, dbh: fakeDb(rows) });
  const yesterday = (() => { const [y, m, d] = etDateString().split('-').map(Number); return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10); })();

  test('both live: passes', async () => { expect(await run([row('svc-1', 'tok-1'), row('svc-2', 'tok-2')])).toBeNull(); });
  test('an unrelated sibling rescheduled to another day does not reject the live token owner\'s link', async () => {
    expect(await run([row('svc-1', 'tok-1'), row('svc-2', 'tok-2', { scheduled_date: yesterday })])).toBeNull();
  });
  test('an unrelated sibling moved to another property does not reject it either', async () => {
    expect(await run([row('svc-1', 'tok-1'), row('svc-2', 'tok-2', { property_id: 'prop-9', lat: '28.1' })])).toBeNull();
  });
  test('an unrelated sibling that went terminal still does not reject the owner (some() semantics, unchanged)', async () => {
    expect(await run([row('svc-1', 'tok-1'), row('svc-2', 'tok-2', { status: 'completed', track_state: 'completed' })])).toBeNull();
  });
  test('the OWNER rescheduled / moved / terminal still blocks', async () => {
    expect(await run([row('svc-1', 'tok-1', { scheduled_date: yesterday }), row('svc-2', 'tok-2')])).toBe('eta_claim_visit_not_today');
    expect(await run([row('svc-1', 'tok-1', { property_id: 'prop-9' }), row('svc-2', 'tok-2')])).toBe('eta_claim_destination_changed');
    expect(await run([row('svc-1', 'tok-1', { status: 'completed', track_state: 'completed' }), row('svc-2', 'tok-2')])).toBe('eta_claim_link_expired');
  });
  test('a claim WITH a link is still about the whole entry: a moved sibling blocks it', async () => {
    const snap1 = { entries: [{ ...snapshot.entries[0], minutes: null }] };
    const reason = await etaClaimBlockReason({ liveEtaSnapshot: snap1, factsGeneratedAt: FRESH, outgoingBody: `Your techs are on the way: portal.wavespestcontrol.com/track/tok-1`, now: NOW, dbh: fakeDb([row('svc-1', 'tok-1'), row('svc-2', 'tok-2', { scheduled_date: yesterday })]) });
    expect(reason).toBe('eta_claim_visit_not_today');
  });
});

// Codex round-38 P2 (PR #5334): first-person on-site claims and retrospective durations at send time.
describe('first-person arrival claims and elapsed durations at send time', () => {
  const drafter = require('../services/sms-shadow-drafter');
  const real = jest.requireActual('../services/sms-shadow-drafter');
  const NAMES = ['findEtaMinutesClaims', 'bodyMentionsArrival', 'bodyMentionsVisitStatus', 'bodyHasTimedArrivalPhrase', 'bodyHasUnclassifiedArrivalDigit', 'findGroundedMinutesFigures'];
  beforeEach(() => { for (const name of NAMES) drafter[name].mockReset().mockImplementation(real[name]); });
  const onSiteSnap = { entries: [{ minutes: null, scheduledServiceIds: ['svc-1'], trackTokens: ['tok-1'], state: 'on_property' }] };
  const rows = (extra) => [{ id: 'svc-1', status: 'on_site', track_state: 'on_property', track_view_token: 'tok-1', track_token_expires_at: FUTURE, ...extra }];
  const done = { status: 'completed', track_state: 'completed' };
  const run = (body, extra) => etaClaimBlockReason({ liveEtaSnapshot: onSiteSnap, factsGeneratedAt: FRESH, outgoingBody: body, now: NOW, dbh: fakeDb(rows(extra)) });
  test.each(["We're on site.", "We've arrived.", "We're at your door.", 'We just got there.'])('%p: passes while on property, blocked once the visit is done', async (body) => {
    expect(await run(body)).toBeNull();
    expect(await run(body, done)).toBe('eta_claim_no_longer_en_route');
  });
  test.each(["We're here to help.", 'We have on-site inspections available.'])('%p is untouched even on a done visit', async (body) => {
    expect(await run(body, done)).toBeNull();
  });
  test.each(['I emailed it 10 minutes ago.', 'We sent the invoice 20 minutes ago.', 'No news for the last 20 minutes.'])('%p is elapsed time, not an ETA: sends against an on-site snapshot', async (body) => {
    expect(await run(body)).toBeNull();
  });
});

// Codex round-39 P2s (PR #5334): send-time classification sees what the customer receives; "is there".
describe('smart punctuation and "is there" at send time', () => {
  const drafter = require('../services/sms-shadow-drafter');
  const real = jest.requireActual('../services/sms-shadow-drafter');
  const NAMES = ['findEtaMinutesClaims', 'bodyMentionsArrival', 'bodyMentionsVisitStatus', 'bodyHasTimedArrivalPhrase', 'bodyHasUnclassifiedArrivalDigit', 'findGroundedMinutesFigures'];
  beforeEach(() => { for (const name of NAMES) drafter[name].mockReset().mockImplementation(real[name]); });
  const enRouteSnap = { entries: [{ minutes: null, scheduledServiceIds: ['svc-1'], trackTokens: ['tok-1'], state: 'en_route' }] };
  const rows = (extra) => [{ id: 'svc-1', status: 'en_route', track_state: 'en_route', track_view_token: 'tok-1', track_token_expires_at: FUTURE, ...extra }];
  const done = { status: 'completed', track_state: 'completed' };
  const run = (body, extra) => etaClaimBlockReason({ liveEtaSnapshot: enRouteSnap, factsGeneratedAt: FRESH, outgoingBody: body, now: NOW, dbh: fakeDb(rows(extra)) });
  test.each(['They’re on the way.', 'Your technician’s running late.', 'The tech isn’t there yet, but is on the way.'])('%p is rechecked like its straight-quote form', async (body) => {
    expect(await run(body)).toBeNull();
    expect(await run(body, done)).toBe('eta_claim_no_longer_en_route');
  });
  test('"The technician is there." needs the on-property state (not just "still en route")', async () => {
    expect(await run('The technician is there.')).toBe('eta_claim_no_longer_en_route');
    expect(await run('The technician is there.', { status: 'on_site', track_state: 'on_property' })).toBeNull();
  });
  test('"The technician is there to help." is untouched', async () => {
    expect(await run('The technician is there to help.', done)).toBeNull();
  });
});

// Codex round-41 P2 (PR #5334): the mapping GENERATION is compared at send time, so A->B->A blocks.
describe('tracker-mapping generation at send time (A->B->A)', () => {
  const drafter = require('../services/sms-shadow-drafter');
  const real = jest.requireActual('../services/sms-shadow-drafter');
  beforeEach(() => {
    for (const name of ['findEtaMinutesClaims', 'bodyMentionsArrival', 'bodyMentionsVisitStatus', 'bodyHasTimedArrivalPhrase', 'bodyHasUnclassifiedArrivalDigit', 'findGroundedMinutesFigures']) drafter[name].mockReset().mockImplementation(real[name]);
  });
  const { deviceFingerprint } = require('../services/live-eta-destination');
  const FP = deviceFingerprint('356938035643809');
  const entry = (extra) => ({ minutes: null, scheduledServiceIds: ['svc-1'], trackTokens: ['tok-1'], state: 'en_route', technicianId: 'tech-1', deviceImei: FP, ...extra });
  const dbWithTech = (tech) => (table) => (table === 'technicians'
    ? { where: () => ({ first: async () => tech }) }
    : { whereIn: () => ({ select: async () => dated([{ id: 'svc-1', status: 'en_route', track_state: 'en_route', track_view_token: 'tok-1', track_token_expires_at: FUTURE, technician_id: 'tech-1' }]) }) });
  const run = (e, tech) => etaClaimBlockReason({ liveEtaSnapshot: { entries: [e] }, factsGeneratedAt: FRESH, outgoingBody: 'The tech is on the way.', now: NOW, dbh: dbWithTech(tech) });
  const d = (iso) => new Date(iso);

  test('same device, same generation (null/null and equal instants) passes', async () => {
    expect(await run(entry({ mappingChangedAt: null }), { bouncie_imei: '356938035643809', bouncie_imei_changed_at: null })).toBeNull();
    expect(await run(entry({ mappingChangedAt: '2026-09-30T16:00:00.000Z' }), { bouncie_imei: '356938035643809', bouncie_imei_changed_at: d('2026-09-30T16:00:00.000Z') })).toBeNull();
  });
  test('A->B->A: the device fingerprint matches again but the generation advanced -> blocked', async () => {
    expect(await run(entry({ mappingChangedAt: null }), { bouncie_imei: '356938035643809', bouncie_imei_changed_at: d('2026-09-30T16:05:00.000Z') })).toBe('eta_claim_device_changed');
    expect(await run(entry({ mappingChangedAt: '2026-09-30T16:00:00.000Z' }), { bouncie_imei: '356938035643809', bouncie_imei_changed_at: d('2026-09-30T16:05:00.000Z') })).toBe('eta_claim_device_changed');
  });
  test('a generation recorded but later cleared to NULL also blocks; an entry that recorded no generation keeps the device-only check', async () => {
    expect(await run(entry({ mappingChangedAt: '2026-09-30T16:00:00.000Z' }), { bouncie_imei: '356938035643809', bouncie_imei_changed_at: null })).toBe('eta_claim_device_changed');
    expect(await run(entry({}), { bouncie_imei: '356938035643809', bouncie_imei_changed_at: d('2026-09-30T16:05:00.000Z') })).toBeNull();
  });
  test('an entry with NO technician (generic status, Codex #5334 P2) never looks up a technician: a null generation is not a device change', async () => {
    const lookups = jest.fn();
    const dbNoTech = (table) => (table === 'technicians'
      ? { where: (cond) => { lookups(cond); return { first: async () => null }; } }
      : { whereIn: () => ({ select: async () => dated([{ id: 'svc-1', status: 'en_route', track_state: 'en_route', track_view_token: 'tok-1', track_token_expires_at: FUTURE, technician_id: null }]) }) });
    const e = entry({ technicianId: undefined, deviceImei: undefined, mappingChangedAt: null });
    const out = await etaClaimBlockReason({ liveEtaSnapshot: { entries: [e] }, factsGeneratedAt: FRESH, outgoingBody: 'Your technician is on the way.', now: NOW, dbh: dbNoTech });
    expect(out).toBeNull();
    expect(lookups).not.toHaveBeenCalled();
  });
  test('an entry with only a generation (no device fingerprint) is still checked; a missing technician row blocks', async () => {
    expect(await run(entry({ deviceImei: undefined, mappingChangedAt: null }), { bouncie_imei: null, bouncie_imei_changed_at: d('2026-09-30T16:05:00.000Z') })).toBe('eta_claim_device_changed');
    expect(await run(entry({ mappingChangedAt: null }), null)).toBe('eta_claim_device_changed');
  });
});

// Codex round-41 P2 (PR #5334): recognizable CURRENT status wording with no snapshot to bind
// it is an ungrounded assertion — gate-on only; the approved SLA wording keeps its exemption.
describe('status wording with no snapshot (GATE_SMS_REAL_ANSWERS on)', () => {
  const drafter = require('../services/sms-shadow-drafter');
  const real = jest.requireActual('../services/sms-shadow-drafter');
  const NAMES = ['findEtaMinutesClaims', 'bodyMentionsArrival', 'bodyMentionsVisitStatus', 'bodyHasTimedArrivalPhrase', 'bodyHasUnclassifiedArrivalDigit', 'findGroundedMinutesFigures'];
  let prior;
  beforeEach(() => { for (const name of NAMES) drafter[name].mockReset().mockImplementation(real[name]); prior = process.env.GATE_SMS_REAL_ANSWERS; process.env.GATE_SMS_REAL_ANSWERS = 'true'; });
  afterEach(() => { if (prior === undefined) delete process.env.GATE_SMS_REAL_ANSWERS; else process.env.GATE_SMS_REAL_ANSWERS = prior; });
  const noSnap = (body, gate = true) => {
    if (!gate) delete process.env.GATE_SMS_REAL_ANSWERS;
    return etaClaimBlockReason({ liveEtaSnapshot: null, factsGeneratedAt: null, outgoingBody: body, now: NOW, dbh: fakeDb([]) });
  };

  test.each([
    'The technician is on the way.', 'The technician has arrived.', 'Our team is en route.', "We're on our way.", "We've arrived.", 'Your tech is running late.',
    'The technician is there.', 'He just got there.', 'Your technician is nearby.', 'They’re on the way.',
  ])('%p: fails closed as eta_claim_no_snapshot', async (body) => {
    expect(await noSnap(body)).toBe('eta_claim_no_snapshot');
  });
  test('gate OFF: unchanged (legacy / human flows send)', async () => {
    expect(await noSnap('The technician is on the way.', false)).toBeNull();
    expect(await noSnap('The technician has arrived.', false)).toBeNull();
  });
  test.each([
    'Thanks, 5 stars!', 'We are here to help.', "The technician hasn't arrived yet.", 'Has your technician arrived yet?', "I'll text you once he's on the way.",
    'Your technician is coming tomorrow.', 'Your receipt is on the way.', 'We will be there Tuesday.', 'The technician was on the way earlier.',
  ])('%p is not current status wording: untouched', async (body) => {
    expect(await noSnap(body)).toBeNull();
  });
  test('the approved SLA wording keeps its exemption', async () => {
    expect(await noSnap('Your technician is nearby and should arrive within the hour.')).toBeNull();
    expect(await noSnap('Sorry about that — someone will follow up within the hour.')).toBeNull();
  });
  test('a snapshot-backed status claim is still bound by the snapshot (unchanged)', async () => {
    const snapshot = { entries: [{ minutes: null, scheduledServiceIds: ['svc-1'], trackTokens: ['tok-1'], state: 'en_route' }] };
    const rows = [{ id: 'svc-1', status: 'en_route', track_state: 'en_route', track_view_token: 'tok-1', track_token_expires_at: FUTURE }];
    expect(await etaClaimBlockReason({ liveEtaSnapshot: snapshot, factsGeneratedAt: FRESH, outgoingBody: 'The technician is on the way.', now: NOW, dbh: fakeDb(rows) })).toBeNull();
  });
  test('a bare minutes claim with no snapshot was already blocked on any gate (unchanged)', async () => {
    expect(await noSnap('The tech is 9 minutes away.', false)).toBe('eta_claim_no_snapshot');
  });
});

// Codex round-42 P2 (PR #5334): technician names persisted with the decision itself.
describe('persisted tech_names classify name-subjected status wording with no snapshot', () => {
  const drafter = require('../services/sms-shadow-drafter');
  const real = jest.requireActual('../services/sms-shadow-drafter');
  const NAMES = ['findEtaMinutesClaims', 'bodyMentionsArrival', 'bodyMentionsVisitStatus', 'bodyHasTimedArrivalPhrase', 'bodyHasUnclassifiedArrivalDigit', 'findGroundedMinutesFigures'];
  let prior;
  beforeEach(() => { for (const name of NAMES) drafter[name].mockReset().mockImplementation(real[name]); prior = process.env.GATE_SMS_REAL_ANSWERS; process.env.GATE_SMS_REAL_ANSWERS = 'true'; });
  afterEach(() => { if (prior === undefined) delete process.env.GATE_SMS_REAL_ANSWERS; else process.env.GATE_SMS_REAL_ANSWERS = prior; });
  const run = (body, techNames, gate = true) => {
    if (!gate) delete process.env.GATE_SMS_REAL_ANSWERS;
    return etaClaimBlockReason({ liveEtaSnapshot: null, factsGeneratedAt: null, outgoingBody: body, techNames, now: NOW, dbh: fakeDb([]) });
  };

  test.each(['Sam is on the way.', 'Sam has arrived.', "Sam's en route.", 'Sam is running late.', 'Sam just got there.', 'Sam isn’t there yet, but is on the way.'])('%p with Sam persisted: fails closed (eta_claim_no_snapshot)', async (body) => {
    expect(await run(body, ['Sam'])).toBe('eta_claim_no_snapshot');
  });
  test('older decisions without the field keep current behavior (the name is not a subject)', async () => {
    expect(await run('Sam is on the way.', undefined)).toBeNull();
    expect(await run('Sam is on the way.', [])).toBeNull();
  });
  test("another first name is not a status subject: \"Dana's order is on the way.\" is untouched", async () => {
    expect(await run("Dana's order is on the way.", ['Sam'])).toBeNull();
    expect(await run('Samuel is on the way.', ['Sam'])).toBeNull();
  });
  test('gate off: unchanged', async () => {
    expect(await run('Sam is on the way.', ['Sam'], false)).toBeNull();
  });
  test('questions, negations and the SLA wording keep their exemptions', async () => {
    expect(await run('Is Sam on the way?', ['Sam'])).toBeNull();
    expect(await run("Sam isn't on the way yet.", ['Sam'])).toBeNull();
    expect(await run('Sam should arrive within the hour.', ['Sam'])).toBeNull();
  });
  test('names persisted beside a snapshot union with the entries\' own names', async () => {
    const snapshot = { entries: [{ minutes: null, scheduledServiceIds: ['svc-1'], trackTokens: ['tok-1'], state: 'en_route', technicianNames: ['Alex'] }] };
    const rows = [{ id: 'svc-1', status: 'completed', track_state: 'completed', track_view_token: 'tok-1', track_token_expires_at: FUTURE }];
    for (const name of ['Sam', 'Alex']) {
      expect(await etaClaimBlockReason({ liveEtaSnapshot: snapshot, factsGeneratedAt: FRESH, outgoingBody: `${name} is on the way.`, techNames: ['Sam'], now: NOW, dbh: fakeDb(rows) })).toBe('eta_claim_no_longer_en_route');
    }
  });
  test('the retryable-reason set is exported from this module', () => {
    const mod = require('../services/sms-eta-freshness');
    expect(mod.isEtaInfrastructureFailure('eta_claim_recheck_failed')).toBe(true);
    expect(mod.isEtaInfrastructureFailure('eta_claim_stale_facts')).toBe(false);
  });
  test('a real recheck query failure returns a reason in that set', async () => {
    const snapshot = { entries: [{ minutes: null, scheduledServiceIds: ['svc-1'], trackTokens: ['tok-1'], state: 'en_route' }] };
    const reason = await etaClaimBlockReason({ liveEtaSnapshot: snapshot, factsGeneratedAt: FRESH, outgoingBody: 'The technician is on the way.', now: NOW, dbh: () => { throw new Error('db down'); } });
    expect(reason).toBe('eta_claim_recheck_failed');
    expect(require('../services/sms-eta-freshness').isEtaInfrastructureFailure(reason)).toBe(true);
  });
});

// Codex round-45 P2 (PR #5334): strictness comes from the PERSISTED prompt version; future on-site wording with a
// vague time is a timed claim.
describe('no-snapshot strictness follows the persisted prompt version', () => {
  const drafter = require('../services/sms-shadow-drafter');
  const real = jest.requireActual('../services/sms-shadow-drafter');
  const NAMES = ['findEtaMinutesClaims', 'bodyMentionsArrival', 'bodyMentionsVisitStatus', 'bodyHasTimedArrivalPhrase', 'bodyHasUnclassifiedArrivalDigit', 'findGroundedMinutesFigures'];
  let prior;
  beforeEach(() => { for (const name of NAMES) drafter[name].mockReset().mockImplementation(real[name]); prior = process.env.GATE_SMS_REAL_ANSWERS; });
  afterEach(() => { if (prior === undefined) delete process.env.GATE_SMS_REAL_ANSWERS; else process.env.GATE_SMS_REAL_ANSWERS = prior; });
  const run = (promptVersion, gate, body = 'The technician is on the way.') => {
    if (gate) process.env.GATE_SMS_REAL_ANSWERS = 'true'; else delete process.env.GATE_SMS_REAL_ANSWERS;
    return etaClaimBlockReason({ liveEtaSnapshot: null, factsGeneratedAt: null, outgoingBody: body, promptVersion, now: NOW, dbh: fakeDb([]) });
  };
  test.each(['house_voice_v12_real_answers3_cf', 'house_voice_v12_real_answers', 'house_voice_v12_real_answers3_cf+bclm'])('v12 identity %p stays strict with the gate ROLLED BACK (off)', async (version) => {
    expect(await run(version, false)).toBe('eta_claim_no_snapshot');
    expect(await run(version, true)).toBe('eta_claim_no_snapshot');
  });
  test('a pre-real-answers version (v11) is never strict, even with the gate on now', async () => {
    expect(await run('house_voice_v11', true)).toBeNull();
    expect(await run('house_voice_v11', false)).toBeNull();
  });
  test('no version at all: the runtime gate is the fallback (unchanged)', async () => {
    expect(await run(null, true)).toBe('eta_claim_no_snapshot');
    expect(await run(undefined, false)).toBeNull();
    expect(await run('  ', true)).toBe('eta_claim_no_snapshot');
  });
  test('the SLA wording keeps its exemption for v12 decisions', async () => {
    expect(await run('house_voice_v12_real_answers', false, 'Your technician is nearby and should arrive within the hour.')).toBeNull();
  });
  test('non-status copy is untouched for v12', async () => {
    expect(await run('house_voice_v12_real_answers', false, 'Thanks, 5 stars!')).toBeNull();
  });
  test('the agent-decision seam hands the persisted version through (source pin)', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../services/agent-decision-send-checks.js'), 'utf8');
    expect(src).toContain('promptVersion: decision.prompt_version ?? null');
    expect(src).toContain("first('input_snapshot', 'prompt_version')");
  });
});

describe('future on-site wording with a vague time is a timed claim -> unbound', () => {
  const drafter = require('../services/sms-shadow-drafter');
  const real = jest.requireActual('../services/sms-shadow-drafter');
  const NAMES = ['findEtaMinutesClaims', 'bodyMentionsArrival', 'bodyMentionsVisitStatus', 'bodyHasTimedArrivalPhrase', 'bodyHasUnclassifiedArrivalDigit', 'findGroundedMinutesFigures'];
  beforeEach(() => { for (const name of NAMES) drafter[name].mockReset().mockImplementation(real[name]); });
  const snapshot = { entries: [{ minutes: null, scheduledServiceIds: ['svc-1'], trackTokens: ['tok-1'], state: 'en_route' }] };
  const rows = [{ id: 'svc-1', status: 'en_route', track_state: 'en_route', track_view_token: 'tok-1', track_token_expires_at: FUTURE }];
  const run = (body) => etaClaimBlockReason({ liveEtaSnapshot: snapshot, factsGeneratedAt: FRESH, outgoingBody: body, now: NOW, dbh: fakeDb(rows) });
  test.each([
    'The technician will be on site soon.', 'The tech should be on-site any minute.', 'The technician will arrive on site shortly.', 'He will be on the property soon.',
    'The tech will be at your door momentarily.',
  ])('%p is unbound (an unsupported arrival promise), not ordinary en-route status', async (body) => {
    expect(await run(body)).toBe('eta_claim_unbound');
  });
  test.each(['The technician will be on site.', 'The on-site inspection will be done soon.', 'We will be on site Tuesday.'])('%p is not a timed arrival claim', async (body) => {
    expect(await run(body)).not.toBe('eta_claim_unbound');
  });
});

// Codex round-47 P2 (PR #5334): "made it" arrivals at send time.
describe('"made it" completed-arrival claims at send time', () => {
  const drafter = require('../services/sms-shadow-drafter');
  const real = jest.requireActual('../services/sms-shadow-drafter');
  const NAMES = ['findEtaMinutesClaims', 'bodyMentionsArrival', 'bodyMentionsVisitStatus', 'bodyHasTimedArrivalPhrase', 'bodyHasUnclassifiedArrivalDigit', 'findGroundedMinutesFigures'];
  beforeEach(() => { for (const name of NAMES) drafter[name].mockReset().mockImplementation(real[name]); });
  const snapshot = (extra) => ({ entries: [{ minutes: null, scheduledServiceIds: ['svc-1'], trackTokens: ['tok-1'], state: 'en_route', ...extra }] });
  const rows = (extra) => [{ id: 'svc-1', status: 'en_route', track_state: 'en_route', track_view_token: 'tok-1', track_token_expires_at: FUTURE, ...extra }];
  const onSite = { status: 'on_site', track_state: 'on_property' };
  const done = { status: 'completed', track_state: 'completed' };
  const run = (body, snap, extra) => etaClaimBlockReason({ liveEtaSnapshot: snap, factsGeneratedAt: FRESH, outgoingBody: body, now: NOW, dbh: fakeDb(rows(extra)) });

  test.each(['The technician made it to your house.', 'He made it.', "We've made it."])('%p needs the on-property state: blocked while still en route', async (body) => {
    expect(await run(body, snapshot())).toBe('eta_claim_no_longer_en_route');
  });
  test.each(['The technician made it to your house.', 'He made it.'])('%p passes once the visit is on property, blocked again once it is done', async (body) => {
    const onProp = snapshot({ state: 'on_property' });
    expect(await run(body, onProp, onSite)).toBeNull();
    expect(await run(body, onProp, done)).toBe('eta_claim_no_longer_en_route');
  });
  test('a recorded technician name works; with no snapshot and the gate on it fails closed', async () => {
    expect(await run('Sam made it there.', snapshot({ technicianNames: ['Sam'] }))).toBe('eta_claim_no_longer_en_route');
    const prior = process.env.GATE_SMS_REAL_ANSWERS; process.env.GATE_SMS_REAL_ANSWERS = 'true';
    try {
      expect(await etaClaimBlockReason({ liveEtaSnapshot: null, factsGeneratedAt: null, outgoingBody: 'Sam made it there.', techNames: ['Sam'], now: NOW, dbh: fakeDb([]) })).toBe('eta_claim_no_snapshot');
      expect(await etaClaimBlockReason({ liveEtaSnapshot: null, factsGeneratedAt: null, outgoingBody: 'The technician made it to your house.', now: NOW, dbh: fakeDb([]) })).toBe('eta_claim_no_snapshot');
    } finally { if (prior === undefined) delete process.env.GATE_SMS_REAL_ANSWERS; else process.env.GATE_SMS_REAL_ANSWERS = prior; }
  });
  test.each(["The technician hasn't made it yet.", 'Has he made it?', 'Once the tech made it there I will text you.', 'The tech made it there tomorrow.'])('%p keeps its exemption: untouched even on a done visit', async (body) => {
    expect(await run(body, snapshot(), done)).toBeNull();
  });
});

// Codex round-48 P2 (PR #5334): "reached your property" arrivals at send time.
describe('"reached" completed-arrival claims at send time', () => {
  const drafter = require('../services/sms-shadow-drafter');
  const real = jest.requireActual('../services/sms-shadow-drafter');
  const NAMES = ['findEtaMinutesClaims', 'bodyMentionsArrival', 'bodyMentionsVisitStatus', 'bodyHasTimedArrivalPhrase', 'bodyHasUnclassifiedArrivalDigit', 'findGroundedMinutesFigures'];
  beforeEach(() => { for (const name of NAMES) drafter[name].mockReset().mockImplementation(real[name]); });
  const snapshot = (extra) => ({ entries: [{ minutes: null, scheduledServiceIds: ['svc-1'], trackTokens: ['tok-1'], state: 'en_route', ...extra }] });
  const rows = (extra) => [{ id: 'svc-1', status: 'en_route', track_state: 'en_route', track_view_token: 'tok-1', track_token_expires_at: FUTURE, ...extra }];
  const onSite = { status: 'on_site', track_state: 'on_property' };
  const done = { status: 'completed', track_state: 'completed' };
  const run = (body, snap, extra) => etaClaimBlockReason({ liveEtaSnapshot: snap, factsGeneratedAt: FRESH, outgoingBody: body, now: NOW, dbh: fakeDb(rows(extra)) });
  test.each(['The technician has reached your property.', 'He reached the house.', 'We have reached your place.'])('%p needs the on-property state: blocked while en route', async (body) => {
    expect(await run(body, snapshot())).toBe('eta_claim_no_longer_en_route');
  });
  test('passes once on property, blocked again once the visit is done; a recorded name works', async () => {
    const onProp = snapshot({ state: 'on_property' });
    expect(await run('The technician has reached your property.', onProp, onSite)).toBeNull();
    expect(await run('The technician has reached your property.', onProp, done)).toBe('eta_claim_no_longer_en_route');
    expect(await run('Sam reached your address.', snapshot({ technicianNames: ['Sam'] }))).toBe('eta_claim_no_longer_en_route');
  });
  test.each(['The tech has not reached your property yet.', 'Has he reached the house?', 'The tech reached your home tomorrow.'])('%p keeps its exemption', async (body) => {
    expect(await run(body, snapshot(), done)).toBeNull();
  });
});
