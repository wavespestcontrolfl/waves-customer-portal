/**
 * Round-21 claim hardening on the testimonial publish path:
 *  1. rejectConsumed FAIL CLOSED — a DB failure on the review_graphics
 *     consumed-lookup aborts the publish instead of being read as "not
 *     consumed" (which would re-publish a testimonial another run posted).
 *  2. Claim retention — when a live publish can't get its candidate
 *     consumption recorded, the claim is retained and the detached recovery
 *     loop (holdClaimUntilCandidateConsumed) owns its release: release only
 *     once consumption is recorded or the review is removed; on exhaustion
 *     ABANDON (self-expiring) rather than actively clearing the claim.
 */

jest.mock('../models/db', () => {
  const state = { firstHandlers: {}, updateHandlers: {}, calls: [] };
  const dbFn = (table) => {
    const ctx = { table, where: [], whereNull: [], whereRaw: [] };
    const builder = {
      where(...args) { ctx.where.push(args); return builder; },
      whereNull(col) { ctx.whereNull.push(col); return builder; },
      whereRaw(...args) { ctx.whereRaw.push(args); return builder; },
      async first() {
        state.calls.push({ op: 'first', table, ctx });
        const handler = state.firstHandlers[table];
        return handler ? handler(ctx) : undefined;
      },
      async update(patch) {
        state.calls.push({ op: 'update', table, ctx, patch });
        const handler = state.updateHandlers[table];
        return handler ? handler(ctx, patch) : 0;
      },
    };
    return builder;
  };
  dbFn.__state = state;
  return dbFn;
});

jest.mock('../utils/cron-lock', () => ({
  runExclusive: async (name, fn) => fn(),
  isLocked: async () => false,
  recordJobStart: async () => {},
  recordJobEnd: async () => {},
}));

const db = require('../models/db');
const Studio = require('../services/social-content-studio');

const LIVE_REVIEW = { id: 'rev-1', location_id: 'loc-1', missing_since: null };

const updateCalls = (table) => db.__state.calls.filter((c) => c.op === 'update' && c.table === table);

beforeEach(() => {
  db.__state.firstHandlers = {};
  db.__state.updateHandlers = {};
  db.__state.calls.length = 0;
});

describe('publishWithReviewLivenessLock — rejectConsumed fails closed', () => {
  test('a DB failure on the consumed lookup aborts the publish (no publish, no claim)', async () => {
    db.__state.firstHandlers.google_reviews = async () => ({ ...LIVE_REVIEW });
    db.__state.firstHandlers.review_graphics = async () => { throw new Error('connection reset'); };
    const publishFn = jest.fn();
    await expect(
      Studio.publishWithReviewLivenessLock('rev-1', publishFn, { rejectConsumed: true })
    ).rejects.toThrow('connection reset');
    expect(publishFn).not.toHaveBeenCalled();
    expect(updateCalls('google_reviews')).toHaveLength(0); // claim never written
  });

  test('an existing approved graphic still blocks with consumed:true', async () => {
    db.__state.firstHandlers.google_reviews = async () => ({ ...LIVE_REVIEW });
    db.__state.firstHandlers.review_graphics = async () => ({ id: 'g1' });
    const publishFn = jest.fn();
    const out = await Studio.publishWithReviewLivenessLock('rev-1', publishFn, { rejectConsumed: true });
    expect(out).toEqual({ blocked: true, consumed: true });
    expect(publishFn).not.toHaveBeenCalled();
  });
});

describe('publishWithReviewLivenessLock — abandonClaim', () => {
  test('abandon stops the claim lifecycle WITHOUT clearing it, and a later release stays a no-op', async () => {
    db.__state.firstHandlers.google_reviews = async () => ({ ...LIVE_REVIEW });
    db.__state.updateHandlers.google_reviews = async () => 1;
    const out = await Studio.publishWithReviewLivenessLock('rev-1', async () => 'ok');
    expect(out.blocked).toBe(false);
    expect(typeof out.abandonClaim).toBe('function');
    const updatesBefore = updateCalls('google_reviews').length; // the claim acquisition
    out.abandonClaim();
    await out.releaseClaim(); // released flag already set — must NOT clear the claim
    expect(updateCalls('google_reviews')).toHaveLength(updatesBefore);
  });
});

describe('holdClaimUntilCandidateConsumed', () => {
  const makeClaim = () => ({ releaseClaim: jest.fn(async () => {}), abandonClaim: jest.fn() });

  test('retries persistence and releases the claim once consumption is recorded', async () => {
    db.__state.firstHandlers.google_reviews = async () => ({ ...LIVE_REVIEW });
    const claim = makeClaim();
    const persist = jest.fn()
      .mockRejectedValueOnce(new Error('review sync in progress'))
      .mockResolvedValueOnce({ id: 'g1' });
    await Studio.holdClaimUntilCandidateConsumed({
      googleReviewId: 'rev-1',
      persistInput: { googleReviewId: 'rev-1' },
      claim,
      persist,
      delayMs: 1,
      attempts: 5,
    });
    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenCalledWith({ googleReviewId: 'rev-1' });
    expect(claim.releaseClaim).toHaveBeenCalledTimes(1);
    expect(claim.abandonClaim).not.toHaveBeenCalled();
  });

  test('releases without persisting when the review was stamped removed (no reselection risk)', async () => {
    db.__state.firstHandlers.google_reviews = async () => ({ ...LIVE_REVIEW, missing_since: '2026-08-07T12:00:00Z' });
    const claim = makeClaim();
    const persist = jest.fn();
    await Studio.holdClaimUntilCandidateConsumed({
      googleReviewId: 'rev-1', persistInput: {}, claim, persist, delayMs: 1, attempts: 5,
    });
    expect(persist).not.toHaveBeenCalled();
    expect(claim.releaseClaim).toHaveBeenCalledTimes(1);
    expect(claim.abandonClaim).not.toHaveBeenCalled();
  });

  test('releases without persisting when the review row is gone entirely', async () => {
    db.__state.firstHandlers.google_reviews = async () => undefined;
    const claim = makeClaim();
    const persist = jest.fn();
    await Studio.holdClaimUntilCandidateConsumed({
      googleReviewId: 'rev-1', persistInput: {}, claim, persist, delayMs: 1, attempts: 5,
    });
    expect(persist).not.toHaveBeenCalled();
    expect(claim.releaseClaim).toHaveBeenCalledTimes(1);
  });

  test('exhaustion ABANDONS the claim (self-expiring) instead of releasing it', async () => {
    db.__state.firstHandlers.google_reviews = async () => ({ ...LIVE_REVIEW });
    const claim = makeClaim();
    const persist = jest.fn().mockRejectedValue(new Error('review_graphics table is not available'));
    await Studio.holdClaimUntilCandidateConsumed({
      googleReviewId: 'rev-1', persistInput: {}, claim, persist, delayMs: 1, attempts: 3,
    });
    expect(persist).toHaveBeenCalledTimes(3);
    expect(claim.releaseClaim).not.toHaveBeenCalled();
    expect(claim.abandonClaim).toHaveBeenCalledTimes(1);
  });

  test('an unreadable review never persists blind and never releases blind — holds, then abandons', async () => {
    db.__state.firstHandlers.google_reviews = async () => { throw new Error('db down'); };
    const claim = makeClaim();
    const persist = jest.fn();
    await Studio.holdClaimUntilCandidateConsumed({
      googleReviewId: 'rev-1', persistInput: {}, claim, persist, delayMs: 1, attempts: 3,
    });
    expect(persist).not.toHaveBeenCalled();
    expect(claim.releaseClaim).not.toHaveBeenCalled();
    expect(claim.abandonClaim).toHaveBeenCalledTimes(1);
  });
});
