/**
 * Owner rule 2026-07-30 (the spelled-email bounce incident): a call whose extracted email this
 * run flagged for read-back (open email_unverified / email_invalid review
 * card) must NOT be enrolled in the new_lead email drip — the address is a
 * transcription guess, and the first drip send hard-bounced within a minute,
 * minting a SendGrid suppression on a wrong address. Lookup failure holds
 * (bounces burn sender reputation; a held drip is recoverable).
 */

let mockFirstResult = null;
let mockTriageLookupError = null;
let mockInsertError = null;
let mockUpdateError = null;
let mockHoldRows = [];
jest.mock('../models/db', () => {
  const chain = {
    where: jest.fn(() => chain),
    whereIn: jest.fn(() => chain),
    // The r48 invalidation splits into two disjoint predicates — the
    // uncertain-send ('releasing' + unmarked) rows keep a force-resend
    // ticket, everything else re-pends plain.
    whereNull: jest.fn(() => chain),
    // The r2/r3 P1 fixes read a hold's `corrected_at` marker (mid-run
    // correction preservation) and reconcile a stale disagreement card —
    // both add a plain whereNotNull filter alongside the existing whereNull.
    whereNotNull: jest.fn(() => chain),
    whereNot: jest.fn(() => chain),
    // Table-scoped (r56): the recovery path now reads first_touch_holds
    // and the call_log ownership row inside the fenced mint — a failure
    // injected on the TRIAGE lookup must not also fail those.
    first: jest.fn(() => {
      if (chain._table === 'triage_items' && mockTriageLookupError) return Promise.reject(mockTriageLookupError);
      if (chain._table === 'call_log') return Promise.resolve({ id: 'call-1' });
      return Promise.resolve(mockFirstResult);
    }),
    forUpdate: jest.fn(() => chain),
    select: jest.fn(() => chain),
    insert: jest.fn(() => { if (mockInsertError) throw mockInsertError; return chain; }),
    onConflict: jest.fn(() => chain),
    ignore: jest.fn(async () => 1),
    // The r43/r44 fresh-review claim invalidation runs after the recovery
    // marker insert — a plain fence-bumping hold update.
    update: jest.fn(() => (mockUpdateError ? Promise.reject(mockUpdateError) : Promise.resolve(1))),
    // Awaited bare selects (the holds evidence read) resolve rows.
    then: (resolve, reject) => Promise.resolve(chain._table === 'first_touch_holds' ? mockHoldRows : []).then(resolve, reject),
  };
  const db = jest.fn((table) => { chain._table = table; return chain; });
  db._chain = chain;
  db.raw = jest.fn((x) => x);
  db.schema = { hasTable: jest.fn(async () => true) };
  // The r48 invalidation runs its two writes in ONE transaction so the
  // split can never leave a row half-invalidated; the stub hands back the
  // same connection.
  db.transaction = jest.fn(async (fn) => fn(db));
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/call-routing-gates', () => ({ buildTriageItem: (x) => x }));

const db = require('../models/db');
const { _test } = require('../services/call-recording-processor');

const { shouldHoldLeadEmailEnrollment, mintEmailReviewCardsFenced } = _test;

beforeEach(() => {
  mockFirstResult = null;
  mockTriageLookupError = null;
  mockInsertError = null;
  mockUpdateError = null;
  mockHoldRows = [];
  jest.clearAllMocks();
});

describe('shouldHoldLeadEmailEnrollment', () => {
  test('open email read-back card holds enrollment', async () => {
    mockFirstResult = { id: 'triage-1' };
    await expect(shouldHoldLeadEmailEnrollment('call-1')).resolves.toBe(true);
    expect(db._chain.where).toHaveBeenCalledWith({ call_log_id: 'call-1' });
    // in_progress counts as live — the canonical open-review set.
    expect(db._chain.whereIn).toHaveBeenCalledWith('status', ['open', 'in_progress']);
    expect(db._chain.whereIn).toHaveBeenCalledWith('reason_code', ['email_unverified', 'email_invalid']);
  });

  test('no open card → enrollment proceeds', async () => {
    mockFirstResult = null;
    await expect(shouldHoldLeadEmailEnrollment('call-1')).resolves.toBe(false);
  });

  test('lookup failure fails toward HOLD and persists a recovery marker WITH the held address as evidence (r56)', async () => {
    mockTriageLookupError = new Error('db down');
    mockHoldRows = [{ held_email: 'held.target@example.com' }];
    await expect(shouldHoldLeadEmailEnrollment('call-1', { procToken: 'tok', callSid: 'CA1' })).resolves.toBe(true);
    // The marker is what a later resume path releases — a silent hold with
    // no card would strand the lead outside the drip forever. It rides the
    // fenced mint (card + claim invalidation in ONE transaction) and must
    // SHOW the held address it would release (the r53 evidence contract).
    expect(db._chain.insert).toHaveBeenCalled();
    const card = db._chain.insert.mock.calls.find((c) => Array.isArray(c[0]) && c[0][0])?.[0]?.[0]
      || db._chain.insert.mock.calls[db._chain.insert.mock.calls.length - 1][0];
    const payloadCard = Array.isArray(card) ? card[0] : card;
    const evidence = payloadCard.extraPayload || payloadCard;
    expect(evidence.email_as_heard || evidence.extraPayload?.email_as_heard).toBe('held.target@example.com');
    // One fenced transaction wrapped the card + invalidation.
    expect(db.transaction).toHaveBeenCalled();
  });

  test('FIRST-failure recovery card (no hold row yet) carries the current extraction as evidence (r57)', async () => {
    // recordFirstTouchHoldOwned runs AFTER this helper — on the first
    // Step-6 failure the ledger is empty, but the run will record
    // extracted.email as the held target, so that address must be what
    // the card displays.
    mockTriageLookupError = new Error('db down');
    mockHoldRows = [];
    await expect(shouldHoldLeadEmailEnrollment('call-1', {
      procToken: 'tok', callSid: 'CA1', extractedEmail: 'fresh.extracted@example.com',
    })).resolves.toBe(true);
    const card = db._chain.insert.mock.calls[db._chain.insert.mock.calls.length - 1][0];
    const payloadCard = Array.isArray(card) ? card[0] : card;
    const evidence = payloadCard.extraPayload || payloadCard;
    expect(evidence.email_as_heard || evidence.extraPayload?.email_as_heard).toBe('fresh.extracted@example.com');
  });

  test('lookup + marker failure fails the run — never a silent, invisible hold', async () => {
    mockTriageLookupError = new Error('db down');
    mockInsertError = new Error('still down');
    await expect(shouldHoldLeadEmailEnrollment('call-1')).rejects.toMatchObject({
      emailReviewStateUnavailable: true,
    });
  });

  test('marker persisted but claim invalidation failing fails the run too (r44)', async () => {
    // The recovery card is a live review — with the card durably inserted
    // and an in-flight claimant's fence NOT invalidated, that claimant
    // could send the unreviewed address (Codex #3084 r44). The failure
    // routes into the extraction_failed retry, which re-runs both writes.
    mockTriageLookupError = new Error('db down');
    mockUpdateError = new Error('write down');
    await expect(shouldHoldLeadEmailEnrollment('call-1')).rejects.toMatchObject({
      emailReviewStateUnavailable: true,
    });
    expect(db._chain.insert).toHaveBeenCalled();
  });
});

describe('mintEmailReviewCardsFenced (r55)', () => {
  const CARD = { call_log_id: 'call-1', reason_code: 'email_unverified' };

  test('takes the shared per-call advisory lock BEFORE the hold lookup', async () => {
    // With no hold rows yet — the normal early-processing state — the
    // FOR UPDATE locks nothing, and an unserialized mint would take
    // call_log before triage_items while fanout/admin-triage writers
    // hold cards and then update call_log: AB-BA deadlock. The advisory
    // lock must be the transaction's first acquisition.
    mockFirstResult = { id: 'call-1' }; // ownership check passes
    await mintEmailReviewCardsFenced({
      callLogId: 'call-1', procToken: 'tok', cards: [CARD], callSid: 'CA1', invalidateClaims: false,
    });
    const advisoryCall = db.raw.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('pg_advisory_xact_lock'),
    );
    expect(advisoryCall).toBeDefined();
    expect(advisoryCall[1]).toEqual(['triage-call-review', 'call-1']);
    const advisoryOrder = db.raw.mock.invocationCallOrder[
      db.raw.mock.calls.findIndex((c) => typeof c[0] === 'string' && c[0].includes('pg_advisory_xact_lock'))
    ];
    expect(advisoryOrder).toBeLessThan(db._chain.forUpdate.mock.invocationCallOrder[0]);
  });

  test('ANY mint failure fails the run retryably — never warn-and-continue', async () => {
    // Continuing without the card leaves the fresh hold with no live
    // current-cycle card: a RESOLVED card from an older cycle reads as
    // approval to the ledger sweep, releasing the unreviewed extraction
    // before the end-of-run recovery files its card.
    mockFirstResult = { id: 'call-1' };
    mockInsertError = new Error('card insert down');
    await expect(mintEmailReviewCardsFenced({
      callLogId: 'call-1', procToken: 'tok', cards: [CARD], callSid: 'CA1', invalidateClaims: false,
    })).rejects.toMatchObject({ emailReviewStateUnavailable: true });
  });
});

// V1/V2 email disagreement (owner ruling 2026-09-25): a force-reprocess
// whose call already has a LIVE email_unverified/invalid card must not have
// its two-candidate evidence silently dropped by the ordinary
// .onConflict(...).ignore() insert — the office would keep reading an
// earlier cycle's single-address guess (codex P1). Fixtures use synthetic
// example.com addresses shaped like the real miss (one letter dropped from
// a spelled email) — never a real customer's name or address.
describe('mintEmailReviewCardsFenced — V1/V2 email disagreement refresh (codex P1)', () => {
  const DISAGREEMENT_CARD = {
    call_log_id: 'call-1',
    reason_code: 'email_unverified',
    payload: JSON.stringify({
      flag: 'email_unverified',
      email_candidates: [{ value: 'janedoee@example.com' }, { value: 'janedoe@example.com' }],
      email_as_heard: 'janedoee@example.com',
      confirmation_question: 'Which spelling is right — janedoee@example.com or janedoe@example.com?',
      email_disagreement: { v1: 'janedoee@example.com', v2: 'janedoe@example.com' },
    }),
  };

  test('an existing open card is refreshed in place with both candidates — insert is skipped, held target cleared', async () => {
    mockFirstResult = {
      id: 'existing-card-1',
      payload: JSON.stringify({ flag: 'email_unverified', email_candidates: [{ value: 'stale@example.com' }] }),
    };
    await mintEmailReviewCardsFenced({
      callLogId: 'call-1', procToken: 'tok', cards: [DISAGREEMENT_CARD], callSid: 'CA1', invalidateClaims: false,
    });
    // The stale single-address card was UPDATED (merged), not replaced
    // wholesale and not silently ignored.
    const payloadUpdateCall = db._chain.update.mock.calls.find((c) => c[0] && typeof c[0].payload === 'string');
    expect(payloadUpdateCall).toBeDefined();
    const mergedPayload = JSON.parse(payloadUpdateCall[0].payload);
    expect(mergedPayload.email_candidates).toEqual([
      { value: 'janedoee@example.com' }, { value: 'janedoe@example.com' },
    ]);
    expect(mergedPayload.email_disagreement).toEqual({ v1: 'janedoee@example.com', v2: 'janedoe@example.com' });
    expect(mergedPayload.flag).toBe('email_unverified'); // merged, not replaced
    // No single confirmed address survives a disagreement — the hold's held
    // target is cleared under the same advisory-locked transaction.
    const heldClearCall = db._chain.update.mock.calls.find((c) => c[0] && c[0].held_email === '');
    expect(heldClearCall).toBeDefined();
    // The ordinary insert path never ran for this reason_code — the office
    // never sees a duplicate or a silently-ignored insert.
    expect(db._chain.insert).not.toHaveBeenCalled();
  });

  test('no existing open card → inserts normally, still clears any held target', async () => {
    mockFirstResult = null; // no live email_unverified/invalid card yet
    await mintEmailReviewCardsFenced({
      callLogId: 'call-1', procToken: 'tok', cards: [DISAGREEMENT_CARD], callSid: 'CA1', invalidateClaims: false,
    });
    expect(db._chain.insert).toHaveBeenCalledWith(DISAGREEMENT_CARD);
    const heldClearCall = db._chain.update.mock.calls.find((c) => c[0] && c[0].held_email === '');
    expect(heldClearCall).toBeDefined();
  });

  test('a card with no disagreement evidence is unaffected — normal insert, no held-target clear', async () => {
    const PLAIN_CARD = { call_log_id: 'call-1', reason_code: 'email_unverified' };
    mockFirstResult = { id: 'call-1' };
    await mintEmailReviewCardsFenced({
      callLogId: 'call-1', procToken: 'tok', cards: [PLAIN_CARD], callSid: 'CA1', invalidateClaims: false,
    });
    expect(db._chain.insert).toHaveBeenCalledWith(PLAIN_CARD);
    const heldClearCall = db._chain.update.mock.calls.find((c) => c[0] && c[0].held_email === '');
    expect(heldClearCall).toBeUndefined();
  });

  // Codex r1 P1 (round 2): a stale DECISIVE arbiter verdict from an earlier
  // cycle's existing card must never survive the refresh — the whole point
  // of applyEmailDisagreementHold is that no heuristic (including a prior
  // cycle's arbiter) settles a disagreement. The refresh's ...existingPayload
  // spread previously let the OLD row's arbiter field ride through untouched.
  test('a stale decisive arbiter verdict on the EXISTING card does not survive the refresh', async () => {
    mockFirstResult = {
      id: 'existing-card-1',
      payload: JSON.stringify({
        flag: 'email_unverified',
        email_candidates: [{ value: 'stale@example.com' }],
        // An earlier cycle's arbiter decisively adopted one address —
        // exactly the class of bug (a heuristic silently settling a
        // disagreement) this whole feature exists to prevent.
        arbiter: { verdict: 'adopt', chosen_value: 'stale@example.com', confidence: 0.95 },
      }),
    };
    // This cycle's fresh card carries NO arbiter evidence at all (the
    // dictation decoder did not run this pass) — the refresh must not
    // fall back to the stale row's decisive verdict.
    await mintEmailReviewCardsFenced({
      callLogId: 'call-1', procToken: 'tok', cards: [DISAGREEMENT_CARD], callSid: 'CA1', invalidateClaims: false,
    });
    const payloadUpdateCall = db._chain.update.mock.calls.find((c) => c[0] && typeof c[0].payload === 'string');
    const mergedPayload = JSON.parse(payloadUpdateCall[0].payload);
    expect(mergedPayload.arbiter).toBeUndefined();
  });

  test('a demoted arbiter verdict from THIS cycle overwrites a stale decisive one on the existing card', async () => {
    mockFirstResult = {
      id: 'existing-card-1',
      payload: JSON.stringify({
        flag: 'email_unverified',
        arbiter: { verdict: 'adopt', chosen_value: 'stale@example.com', confidence: 0.95 },
      }),
    };
    const CARD_WITH_DEMOTED_ARBITER = {
      call_log_id: 'call-1',
      reason_code: 'email_unverified',
      payload: JSON.stringify({
        flag: 'email_unverified',
        email_candidates: [{ value: 'janedoee@example.com' }, { value: 'janedoe@example.com' }],
        email_disagreement: { v1: 'janedoee@example.com', v2: 'janedoe@example.com' },
        // applyEmailDisagreementHold already demoted this cycle's arbiter.
        arbiter: { verdict: 'review', chosen_value: 'janedoee@example.com', confidence: 0.95 },
      }),
    };
    await mintEmailReviewCardsFenced({
      callLogId: 'call-1', procToken: 'tok', cards: [CARD_WITH_DEMOTED_ARBITER], callSid: 'CA1', invalidateClaims: false,
    });
    const payloadUpdateCall = db._chain.update.mock.calls.find((c) => c[0] && typeof c[0].payload === 'string');
    const mergedPayload = JSON.parse(payloadUpdateCall[0].payload);
    expect(mergedPayload.arbiter.verdict).toBe('review');
  });

  // Codex r3 P1 (round 3): same staleness class as arbiter — a stale
  // email_release_target from the existing row must not survive the
  // refresh either, even on a fixture where this cycle's own card never
  // set the field at all.
  test('a stale email_release_target on the EXISTING card does not survive the refresh', async () => {
    mockFirstResult = {
      id: 'existing-card-1',
      payload: JSON.stringify({
        flag: 'email_unverified',
        email_release_target: 'stale@example.com',
      }),
    };
    // DISAGREEMENT_CARD's payload never sets email_release_target — this
    // cycle carries none, so the refresh must clear the existing row's
    // stale copy rather than preserve it.
    await mintEmailReviewCardsFenced({
      callLogId: 'call-1', procToken: 'tok', cards: [DISAGREEMENT_CARD], callSid: 'CA1', invalidateClaims: false,
    });
    const payloadUpdateCall = db._chain.update.mock.calls.find((c) => c[0] && typeof c[0].payload === 'string');
    const mergedPayload = JSON.parse(payloadUpdateCall[0].payload);
    expect(mergedPayload.email_release_target).toBeUndefined();
  });

  test('a fresh email_release_target from THIS cycle overwrites a stale one on the existing card', async () => {
    mockFirstResult = {
      id: 'existing-card-1',
      payload: JSON.stringify({ flag: 'email_unverified', email_release_target: 'stale@example.com' }),
    };
    const CARD_WITH_RELEASE_TARGET = {
      call_log_id: 'call-1',
      reason_code: 'email_unverified',
      payload: JSON.stringify({
        flag: 'email_unverified',
        email_candidates: [{ value: 'janedoee@example.com' }, { value: 'janedoe@example.com' }],
        email_disagreement: { v1: 'janedoee@example.com', v2: 'janedoe@example.com' },
        // A disagreement card's own release target is always null (no
        // single confirmed address), matching the real minting call sites.
        email_release_target: null,
      }),
    };
    await mintEmailReviewCardsFenced({
      callLogId: 'call-1', procToken: 'tok', cards: [CARD_WITH_RELEASE_TARGET], callSid: 'CA1', invalidateClaims: false,
    });
    const payloadUpdateCall = db._chain.update.mock.calls.find((c) => c[0] && typeof c[0].payload === 'string');
    const mergedPayload = JSON.parse(payloadUpdateCall[0].payload);
    expect(mergedPayload.email_release_target).toBeNull();
  });
});
