/**
 * Round-21 hardening of the testimonial publish path:
 *  1. rejectConsumed FAIL CLOSED — a DB failure on either consumed-lookup
 *     (review_graphics row OR the durable published stamp) aborts the
 *     publish instead of being read as "not consumed".
 *  2. Durable published stamp — recordTestimonialPublished writes a
 *     first-win marker on google_reviews the moment any external post
 *     succeeds; the consumed check rejects foreign stamps but lets the
 *     OWNING run retry its remaining channels (partial-publish ownership).
 *  3. Claim retention — when the stamp cannot be written after a live
 *     publish, the claim is retained and holdClaimUntilPublishRecorded
 *     owns its release: release only once the durable record lands or the
 *     review is removed; on exhaustion ABANDON (self-expiring) rather than
 *     actively clearing the claim.
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

const LIVE_REVIEW = { id: 'rev-1', location_id: 'loc-1', missing_since: null, testimonial_published_at: null };

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

  test('a durable published stamp from ANOTHER run blocks even with no review_graphics row', async () => {
    db.__state.firstHandlers.google_reviews = async () => ({
      ...LIVE_REVIEW,
      testimonial_published_at: '2026-08-07T12:00:00Z',
      testimonial_published_run: 'run-other',
    });
    db.__state.firstHandlers.review_graphics = async () => undefined;
    const publishFn = jest.fn();
    const out = await Studio.publishWithReviewLivenessLock('rev-1', publishFn, {
      rejectConsumed: true,
      allowConsumedByRunId: 'run-mine',
    });
    expect(out).toEqual({ blocked: true, consumed: true });
    expect(publishFn).not.toHaveBeenCalled();
  });

  test('the OWNING run passes its own stamp and publishes its remaining channels', async () => {
    db.__state.firstHandlers.google_reviews = async () => ({
      ...LIVE_REVIEW,
      testimonial_published_at: '2026-08-07T12:00:00Z',
      testimonial_published_run: 'run-mine',
    });
    db.__state.firstHandlers.review_graphics = async () => undefined;
    db.__state.updateHandlers.google_reviews = async () => 1; // claim acquired
    const publishFn = jest.fn(async () => 'ok');
    const out = await Studio.publishWithReviewLivenessLock('rev-1', publishFn, {
      rejectConsumed: true,
      allowConsumedByRunId: 'run-mine',
    });
    expect(out.blocked).toBe(false);
    expect(out.result).toBe('ok');
    expect(publishFn).toHaveBeenCalledTimes(1);
    out.abandonClaim(); // stop the heartbeat for test hygiene
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

describe('recordTestimonialPublished', () => {
  test('stamps first-win with the owning run token', async () => {
    db.__state.updateHandlers.google_reviews = async (ctx, patch) => {
      expect(ctx.whereNull).toContain('testimonial_published_at');
      expect(patch.testimonial_published_run).toBe('run-1');
      expect(typeof patch.testimonial_published_at).toBe('string');
      return 1;
    };
    await Studio.recordTestimonialPublished('rev-1', 'run-1');
    expect(updateCalls('google_reviews')).toHaveLength(1);
  });

  test('an existing own-run stamp is idempotent success (no throw)', async () => {
    db.__state.updateHandlers.google_reviews = async () => 0;
    db.__state.firstHandlers.google_reviews = async () => ({
      ...LIVE_REVIEW,
      testimonial_published_at: '2026-08-07T12:00:00Z',
      testimonial_published_run: 'run-1',
    });
    await expect(Studio.recordTestimonialPublished('rev-1', 'run-1')).resolves.toBeUndefined();
  });

  test('a DB failure propagates (caller retains the claim)', async () => {
    db.__state.updateHandlers.google_reviews = async () => { throw new Error('db down'); };
    await expect(Studio.recordTestimonialPublished('rev-1', 'run-1')).rejects.toThrow('db down');
  });
});

describe('holdClaimUntilPublishRecorded', () => {
  const makeClaim = () => ({ releaseClaim: jest.fn(async () => {}), abandonClaim: jest.fn() });

  test('retries the record and releases the claim once it lands', async () => {
    db.__state.firstHandlers.google_reviews = async () => ({ ...LIVE_REVIEW });
    const claim = makeClaim();
    const record = jest.fn()
      .mockRejectedValueOnce(new Error('db hiccup'))
      .mockResolvedValueOnce(undefined);
    await Studio.holdClaimUntilPublishRecorded({
      googleReviewId: 'rev-1', record, claim, delayMs: 1, attempts: 5,
    });
    expect(record).toHaveBeenCalledTimes(2);
    expect(claim.releaseClaim).toHaveBeenCalledTimes(1);
    expect(claim.abandonClaim).not.toHaveBeenCalled();
  });

  test('releases without recording when the review was stamped removed (no reselection risk)', async () => {
    db.__state.firstHandlers.google_reviews = async () => ({ ...LIVE_REVIEW, missing_since: '2026-08-07T12:00:00Z' });
    const claim = makeClaim();
    const record = jest.fn();
    await Studio.holdClaimUntilPublishRecorded({
      googleReviewId: 'rev-1', record, claim, delayMs: 1, attempts: 5,
    });
    expect(record).not.toHaveBeenCalled();
    expect(claim.releaseClaim).toHaveBeenCalledTimes(1);
    expect(claim.abandonClaim).not.toHaveBeenCalled();
  });

  test('releases without recording when the review row is gone entirely', async () => {
    db.__state.firstHandlers.google_reviews = async () => undefined;
    const claim = makeClaim();
    const record = jest.fn();
    await Studio.holdClaimUntilPublishRecorded({
      googleReviewId: 'rev-1', record, claim, delayMs: 1, attempts: 5,
    });
    expect(record).not.toHaveBeenCalled();
    expect(claim.releaseClaim).toHaveBeenCalledTimes(1);
  });

  test('exhaustion ABANDONS the claim (self-expiring) instead of releasing it', async () => {
    db.__state.firstHandlers.google_reviews = async () => ({ ...LIVE_REVIEW });
    const claim = makeClaim();
    const record = jest.fn().mockRejectedValue(new Error('still down'));
    await Studio.holdClaimUntilPublishRecorded({
      googleReviewId: 'rev-1', record, claim, delayMs: 1, attempts: 3,
    });
    expect(record).toHaveBeenCalledTimes(3);
    expect(claim.releaseClaim).not.toHaveBeenCalled();
    expect(claim.abandonClaim).toHaveBeenCalledTimes(1);
  });

  test('an unreadable review never records blind and never releases blind — holds, then abandons', async () => {
    db.__state.firstHandlers.google_reviews = async () => { throw new Error('db down'); };
    const claim = makeClaim();
    const record = jest.fn();
    await Studio.holdClaimUntilPublishRecorded({
      googleReviewId: 'rev-1', record, claim, delayMs: 1, attempts: 3,
    });
    expect(record).not.toHaveBeenCalled();
    expect(claim.releaseClaim).not.toHaveBeenCalled();
    expect(claim.abandonClaim).toHaveBeenCalledTimes(1);
  });
});

describe('durable stamp at FIRST provider success (r22)', () => {
  // publishToAll posts providers sequentially; the multi-provider call can
  // stall or die between providers, and the expiring claim alone would let a
  // later run republish. Source contracts pin the wiring — the posting
  // functions are lexical module-privates, so the loops aren't unit-hookable
  // without a service refactor.
  const fs = require('fs');
  const path = require('path');
  const studioSource = fs.readFileSync(path.join(__dirname, '../services/social-content-studio.js'), 'utf8');
  const socialSource = fs.readFileSync(path.join(__dirname, '../services/social-media.js'), 'utf8');

  test('both testimonial publishToAll call sites wire onFirstPlatformSuccess to the durable stamp', () => {
    const wirings = studioSource.split('onFirstPlatformSuccess:').slice(1);
    expect(wirings).toHaveLength(2);
    for (const wiring of wirings) {
      expect(wiring.slice(0, 300)).toContain('recordTestimonialPublished');
    }
  });

  test('publishToAll awaits the hook inside BOTH posting loops, once, on a success result only', () => {
    expect(socialSource.split('await fireFirstPlatformSuccess()')).toHaveLength(3); // platform loop + GBP loop
    expect(socialSource).toContain("if (firstSuccessFired || typeof onFirstPlatformSuccess !== 'function') return;");
    expect(socialSource).toContain('platformResults.find((r) => r.success === true)');
  });
});
