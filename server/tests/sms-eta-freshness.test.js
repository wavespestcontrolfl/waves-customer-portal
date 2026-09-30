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

describe('round 5 (Codex P2): vague/approximate duration wording is a TIMED claim, never status-only', () => {
  const drafter = require('../services/sms-shadow-drafter');
  const real = jest.requireActual('../services/sms-shadow-drafter');
  beforeEach(() => {
    drafter.findEtaMinutesClaims.mockReset().mockImplementation(real.findEtaMinutesClaims);
    drafter.bodyMentionsArrival.mockReset().mockImplementation(real.bodyMentionsArrival);
    drafter.bodyHasTimedArrivalPhrase.mockReset().mockImplementation(real.bodyHasTimedArrivalPhrase);
  });
  const liveEtaSnapshot = { entries: [{ minutes: 12, scheduledServiceIds: ['svc-1'] }] };
  const dbWith = (rows) => () => ({ whereIn: () => ({ select: async () => rows }) });

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
  const dbWith = (rows) => () => ({ whereIn: () => ({ select: async () => rows }) });

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
  const dbWith = (rows) => () => ({ whereIn: () => ({ select: async () => rows }) });

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
  const dbWith = (rows) => () => ({ whereIn: () => ({ select: async () => rows }) });

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
    for (const name of ['findEtaMinutesClaims', 'bodyMentionsArrival', 'bodyHasTimedArrivalPhrase', 'bodyHasUnclassifiedArrivalDigit', 'findGroundedMinutesFigures']) {
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
    for (const name of ['findEtaMinutesClaims', 'bodyMentionsArrival', 'bodyHasTimedArrivalPhrase', 'bodyHasUnclassifiedArrivalDigit', 'findGroundedMinutesFigures']) {
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
    for (const name of ['findEtaMinutesClaims', 'bodyMentionsArrival', 'bodyHasTimedArrivalPhrase', 'bodyHasUnclassifiedArrivalDigit', 'findGroundedMinutesFigures']) {
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
  test('"ur tech ≈ 15 klicks out 🚚" is held to the status checks: passes fresh+en_route, blocked when terminal, on site, stale, or GPS-expired', async () => {
    const body = 'ur tech ≈ 15 klicks out 🚚';
    expect(await run(body, rowsBy.en_route)).toBeNull();
    expect(await run(body, rowsBy.completed)).toBe('eta_claim_unclassified');
    expect(await run(body, rowsBy.on_site)).toBe('eta_claim_unclassified');
    expect(await run(body, rowsBy.en_route, STALE)).toBe('eta_claim_unclassified');
    expect(await run(body, rowsBy.en_route, FRESH, { entries: [{ ...snapshot.entries[0], fixExpiresAtMs: NOW.getTime() - 1000 }] })).toBe('eta_claim_unclassified');
  });

  test('"tech: 15 min" with a terminal or stale entry is blocked', async () => {
    expect(await run('tech: 15 min', rowsBy.en_route)).toBeNull();
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
    for (const name of ['findEtaMinutesClaims', 'bodyMentionsArrival', 'bodyHasTimedArrivalPhrase', 'bodyHasUnclassifiedArrivalDigit', 'findGroundedMinutesFigures']) {
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
