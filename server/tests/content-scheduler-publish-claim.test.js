/**
 * content-scheduler crash-window hardening:
 *   - the 'publishing' claim is an atomic compare-and-set (0 rows updated
 *     → another instance owns the blog → skip it, never double-publish),
 *   - rows stranded at publish_status='publishing' (process died
 *     mid-publish) are swept after ~30 min — back to 'pending' (scheduler
 *     retries the publish) when the crash happened BEFORE an Astro PR
 *     existed (astro_status null; 'pending_review' is only re-selected when
 *     astro_status='live', so it would strand those rows permanently), and
 *     back to 'pending_review' when Astro state exists. Either way the sweep
 *     disarms pages-poll's pr_open+publishing auto-merge branch.
 *
 * Social rows get the same two protections (audit P1-11): a CAS claim so
 * overlapping ticks can't double-drive publishToAll (duplicate posts on
 * every platform), and a stale-'publishing' sweep to 'failed' — never a
 * retry, since the crash may have landed after some platforms posted.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/social-media', () => ({
  SOCIAL_FLAGS: { automationEnabled: false, scheduledPosts: false, newsletterAutoshare: false },
  isPausedByAdmin: jest.fn().mockResolvedValue(false),
  publishToAll: jest.fn(),
}));
jest.mock('../services/content-astro/astro-publisher', () => ({
  publishAstro: jest.fn(),
}));

let mockState;

jest.mock('../models/db', () => {
  const dbFn = jest.fn((table) => {
    const q = {
      _table: table,
      _filters: [],
      where: jest.fn(function (...args) {
        if (typeof args[0] === 'function') args[0].call(q);
        else q._filters.push(args);
        return q;
      }),
      orWhere: jest.fn(function (...args) {
        if (typeof args[0] === 'function') args[0].call(q);
        return q;
      }),
      whereNull: jest.fn(function (col) {
        q._filters.push(['whereNull', col]);
        return q;
      }),
      orWhereNull: jest.fn(() => q),
      whereIn: jest.fn(() => q),
      whereNotIn: jest.fn(() => q),
      orWhereNotIn: jest.fn(() => q),
      whereNotNull: jest.fn(function (col) {
        q._filters.push(['whereNotNull', col]);
        return q;
      }),
      orderBy: jest.fn(() => q),
      limit: jest.fn(() => Promise.resolve([])),
      update: jest.fn((updates) => {
        mockState.updates.push({ table, filters: q._filters.slice(), updates });
        return Promise.resolve(mockState.updateResult(table, q._filters, updates));
      }),
      // The pending queries are awaited directly (no .select()), so the
      // builder itself must be thenable — table-aware so the blog and
      // social loops each see their own rows.
      then: (resolve, reject) => Promise.resolve(
        table === 'social_media_posts' ? mockState.pendingSocials : mockState.pendingBlogs
      ).then(resolve, reject),
    };
    return q;
  });
  dbFn.raw = jest.fn((sql) => ({ __raw: sql }));
  return dbFn;
});

const ContentScheduler = require('../services/content-scheduler');
const AstroPublisher = require('../services/content-astro/astro-publisher');

function isClaimUpdate(u) {
  return u.table === 'blog_posts' && u.updates.publish_status === 'publishing';
}

function isStaleSweepUpdate(u) {
  return u.table === 'blog_posts'
    && ['pending', 'pending_review'].includes(u.updates.publish_status)
    && u.filters.some(([col, val]) => col === 'publish_status' && val === 'publishing');
}

beforeEach(() => {
  mockState = {
    pendingBlogs: [],
    pendingSocials: [],
    updates: [],
    updateResult: () => 1,
  };
  jest.clearAllMocks();
  const SocialMedia = require('../services/social-media');
  SocialMedia.SOCIAL_FLAGS.automationEnabled = false;
  SocialMedia.SOCIAL_FLAGS.scheduledPosts = false;
  SocialMedia.isPausedByAdmin.mockResolvedValue(false);
});

describe('stale-publishing sweep', () => {
  test('early-crash rows (no Astro state) go back to scheduler-selectable pending', async () => {
    mockState.updateResult = () => 1;
    const reset = await ContentScheduler.resetStalePublishingBlogs();

    expect(reset).toBe(2); // 1 retried + 1 parked
    const sweeps = mockState.updates.filter(isStaleSweepUpdate);
    expect(sweeps).toHaveLength(2);

    // crashed BEFORE publishAstro opened a PR (astro_status null): the
    // pending query never re-selects pending_review without astro_status
    // 'live', so these MUST return to 'pending' to be retried
    const retry = sweeps.find((u) => u.updates.publish_status === 'pending');
    expect(retry).toBeDefined();
    expect(retry.filters).toEqual(expect.arrayContaining([
      ['publish_status', 'publishing'],
      ['updated_at', '<', expect.any(Date)],
      ['whereNull', 'astro_status'],
    ]));

    // crashed AFTER Astro state existed: pending_review is the safe park
    const park = sweeps.find((u) => u.updates.publish_status === 'pending_review');
    expect(park).toBeDefined();
    expect(park.filters).toEqual(expect.arrayContaining([
      ['publish_status', 'publishing'],
      ['updated_at', '<', expect.any(Date)],
      ['whereNotNull', 'astro_status'],
    ]));

    // both guarded to stranded rows only: updated_at older than ~30 min
    for (const sweep of [retry, park]) {
      const cutoff = sweep.filters.find(([col]) => col === 'updated_at')[2];
      const ageMinutes = (Date.now() - cutoff.getTime()) / 60000;
      expect(ageMinutes).toBeGreaterThanOrEqual(29);
      expect(ageMinutes).toBeLessThanOrEqual(31);
    }
  });

  test('the pending reset never touches rows that already have Astro state (and vice versa)', async () => {
    await ContentScheduler.resetStalePublishingBlogs();
    const sweeps = mockState.updates.filter(isStaleSweepUpdate);
    const retry = sweeps.find((u) => u.updates.publish_status === 'pending');
    const park = sweeps.find((u) => u.updates.publish_status === 'pending_review');
    expect(retry.filters).not.toEqual(expect.arrayContaining([['whereNotNull', 'astro_status']]));
    expect(park.filters).not.toEqual(expect.arrayContaining([['whereNull', 'astro_status']]));
  });

  test('processScheduledPosts runs the sweep every tick', async () => {
    await ContentScheduler.processScheduledPosts();
    expect(mockState.updates.some(isStaleSweepUpdate)).toBe(true);
  });

  test('the sweep retries publish_failed rows with no opened PR too (Codex round 2)', async () => {
    await ContentScheduler.resetStalePublishingBlogs();
    const sweeps = mockState.updates.filter(isStaleSweepUpdate);
    const retry = sweeps.find((u) => u.updates.publish_status === 'pending');
    expect(retry.filters).toEqual(expect.arrayContaining([
      ['whereNull', 'astro_status'],
      ['astro_status', 'publish_failed'],
      ['whereNull', 'astro_pr_number'],
    ]));
    expect(retry.updates.astro_status).toBeNull();
  });
});

describe('atomic publishing claim', () => {
  const blog = {
    id: 7,
    title: 'Scheduled Post',
    content: '# body',
    publish_status: 'pending',
    astro_status: null,
  };

  test('claims with a compare-and-set guarded on the selected publish_status', async () => {
    mockState.pendingBlogs = [blog];
    await ContentScheduler.processScheduledPosts();

    const claim = mockState.updates.find(isClaimUpdate);
    expect(claim).toBeDefined();
    expect(claim.filters).toEqual(expect.arrayContaining([
      ['id', 7],
      ['publish_status', 'pending'],
    ]));
    expect(claim.updates.updated_at).toBeInstanceOf(Date);
    expect(AstroPublisher.publishAstro).toHaveBeenCalledWith(7);
  });

  test('skips the blog when another instance claimed it first (0 rows updated)', async () => {
    mockState.pendingBlogs = [blog];
    mockState.updateResult = (table, filters, updates) =>
      (updates.publish_status === 'publishing' ? 0 : 1);

    const result = await ContentScheduler.processScheduledPosts();

    expect(AstroPublisher.publishAstro).not.toHaveBeenCalled();
    expect(result.blogCount).toBe(0);
    expect(result.errors).toBe(0);
    // and the skip must NOT stomp the other instance's claim back to
    // pending_review — the only pending_review write allowed is the sweep's
    const stomps = mockState.updates.filter((u) =>
      u.table === 'blog_posts'
      && u.updates.publish_status === 'pending_review'
      && u.filters.some(([col, val]) => col === 'id' && val === 7));
    expect(stomps).toHaveLength(0);
  });

  test('publish failure with NO Astro state releases the row to PENDING for retry (Codex/audit: pending_review + null astro_status is never re-selected)', async () => {
    mockState.pendingBlogs = [blog];
    AstroPublisher.publishAstro.mockRejectedValue(new Error('GitHub down'));

    const result = await ContentScheduler.processScheduledPosts();

    expect(result.errors).toBe(1);
    // The release re-checks astro_status LIVE (whereNull guard on the same
    // update), releasing to 'pending' so the next tick retries a transient
    // GitHub blip — parking at pending_review would strand it permanently.
    const retry = mockState.updates.find((u) =>
      u.table === 'blog_posts'
      && u.updates.publish_status === 'pending'
      && u.filters.some(([col, val]) => col === 'id' && val === 7)
      && u.filters.some(([col, val]) => col === 'publish_status' && val === 'publishing')
      && u.filters.some(([kind, col]) => kind === 'whereNull' && col === 'astro_status'));
    expect(retry).toBeDefined();
  });

  test('publish failure where publishAstro stamped publish_failed pre-PR still retries (Codex round 2 — the whereNull-only branch was dead)', async () => {
    mockState.pendingBlogs = [blog];
    AstroPublisher.publishAstro.mockRejectedValue(new Error('GitHub down'));

    const result = await ContentScheduler.processScheduledPosts();

    expect(result.errors).toBe(1);
    const retry = mockState.updates.find((u) =>
      u.table === 'blog_posts'
      && u.updates.publish_status === 'pending'
      && u.filters.some(([col, val]) => col === 'id' && val === 7));
    expect(retry).toBeDefined();
    // publishAstro's own catch stamps astro_status='publish_failed' on
    // EVERY pre-PR throw before this handler sees the row, so the
    // retryable set must be (astro_status IS NULL) OR (publish_failed with
    // NO opened PR) — astro_pr_number is the opened-PR marker, and a row
    // with a PR out is never blind-retried (duplicate PR).
    expect(retry.filters).toEqual(expect.arrayContaining([
      ['whereNull', 'astro_status'],
      ['astro_status', 'publish_failed'],
      ['whereNull', 'astro_pr_number'],
    ]));
    // the failed marker is cleared so the pending query re-selects the row
    expect(retry.updates.astro_status).toBeNull();
  });

  test('a deterministic content-policy failure parks the post as failed instead of hot-looping the retry (Codex round 3)', async () => {
    mockState.pendingBlogs = [blog];
    const gateErr = new Error('content guardrails failed: P0 HARDCODED_PRICE');
    gateErr.code = 'BLOG_GUARDRAILS_FAILED';
    AstroPublisher.publishAstro.mockRejectedValue(gateErr);

    const result = await ContentScheduler.processScheduledPosts();

    expect(result.errors).toBe(1);
    // Content-property failures repeat identically every run — the 15-min
    // retry loop would re-burn the gates (fact check is an LLM call)
    // forever. Parked 'failed' like the no-content terminal case, claim-
    // guarded like every other branch.
    const parkedFailed = mockState.updates.find((u) =>
      u.table === 'blog_posts'
      && u.updates.publish_status === 'failed'
      && u.filters.some(([col, val]) => col === 'id' && val === 7)
      && u.filters.some(([col, val]) => col === 'publish_status' && val === 'publishing'));
    expect(parkedFailed).toBeDefined();
    // The park clears publishAstro's pre-PR 'publish_failed' stamp (Codex
    // round 4): scheduleBlogPost only sets publish_status, and the pending
    // query excludes publish_failed — without the clear, a fixed-and-
    // rescheduled post was never picked up again. Marker-guarded so a
    // publish_failed row with an opened PR keeps its state.
    expect(String(parkedFailed.updates.astro_status.__raw)).toMatch(/astro_pr_number IS NULL THEN NULL/);
    // (id-scoped: the tick's stale-publishing SWEEP also writes a 'pending'
    // retry update, but with the cutoff filter and no id — that one is fine)
    const retried = mockState.updates.find((u) =>
      u.table === 'blog_posts'
      && u.updates.publish_status === 'pending'
      && u.filters.some(([col, val]) => col === 'id' && val === 7));
    expect(retried).toBeUndefined();
  });

  test('publish failure WITH Astro state parks the row at pending_review (claim-guarded)', async () => {
    mockState.pendingBlogs = [blog];
    AstroPublisher.publishAstro.mockRejectedValue(new Error('boom after PR opened'));
    // Simulate publishAstro having set astro_status before throwing: the
    // whereNull-guarded pending release matches 0 rows, forcing the
    // pending_review fallback.
    mockState.updateResult = (table, filters, updates) =>
      (updates.publish_status === 'pending'
        && filters.some(([kind, col]) => kind === 'whereNull' && col === 'astro_status') ? 0 : 1);

    const result = await ContentScheduler.processScheduledPosts();

    expect(result.errors).toBe(1);
    const park = mockState.updates.find((u) =>
      u.table === 'blog_posts'
      && u.updates.publish_status === 'pending_review'
      && u.filters.some(([col, val]) => col === 'id' && val === 7)
      && u.filters.some(([col, val]) => col === 'publish_status' && val === 'publishing'));
    expect(park).toBeDefined();
  });
});

// ── social posts: CAS claim + stale sweep (audit P1-11) ─────────────────

describe('atomic SOCIAL publishing claim', () => {
  const social = {
    id: 'soc-1',
    title: 'Scheduled Social',
    description: 'd',
    source_url: 'https://wavespestcontrol.com/blog/x/',
    source_guid: 'g1',
    publish_status: 'pending',
    custom_content: null,
  };

  function enableSocial() {
    const SocialMedia = require('../services/social-media');
    SocialMedia.SOCIAL_FLAGS.automationEnabled = true;
    SocialMedia.SOCIAL_FLAGS.scheduledPosts = true;
    return SocialMedia;
  }

  test('claims with a compare-and-set guarded on the selected publish_status', async () => {
    const SocialMedia = enableSocial();
    SocialMedia.publishToAll.mockResolvedValue({ ok: true });
    mockState.pendingSocials = [social];

    const result = await ContentScheduler.processScheduledPosts();

    const claim = mockState.updates.find((u) =>
      u.table === 'social_media_posts' && u.updates.publish_status === 'publishing');
    expect(claim).toBeDefined();
    expect(claim.filters).toEqual(expect.arrayContaining([
      ['id', 'soc-1'],
      ['publish_status', 'pending'],
    ]));
    expect(SocialMedia.publishToAll).toHaveBeenCalledTimes(1);
    expect(result.socialCount).toBe(1);
  });

  test('skips the post when another instance claimed it first — no duplicate publishToAll', async () => {
    const SocialMedia = enableSocial();
    mockState.pendingSocials = [social];
    mockState.updateResult = (table, filters, updates) =>
      (table === 'social_media_posts' && updates.publish_status === 'publishing' ? 0 : 1);

    const result = await ContentScheduler.processScheduledPosts();

    expect(SocialMedia.publishToAll).not.toHaveBeenCalled();
    expect(result.socialCount).toBe(0);
    expect(result.errors).toBe(0);
    // the loser must not write ANY state for the contested row (the only
    // other social write this tick is the id-less stale sweep)
    const writes = mockState.updates.filter((u) =>
      u.table === 'social_media_posts'
      && u.updates.publish_status !== 'publishing'
      && u.filters.some(([col, val]) => col === 'id' && val === 'soc-1'));
    expect(writes).toHaveLength(0);
  });

  test('publishToAll failure marks failed only under the claim we hold', async () => {
    const SocialMedia = enableSocial();
    SocialMedia.publishToAll.mockRejectedValue(new Error('FB API down'));
    mockState.pendingSocials = [social];

    const result = await ContentScheduler.processScheduledPosts();

    expect(result.errors).toBe(1);
    // scope to the row-level error write — the tick-start stale sweep also
    // writes 'failed' but carries no id filter
    const failed = mockState.updates.find((u) =>
      u.table === 'social_media_posts'
      && u.updates.publish_status === 'failed'
      && u.filters.some(([col, val]) => col === 'id' && val === 'soc-1'));
    expect(failed).toBeDefined();
    expect(failed.filters).toEqual(expect.arrayContaining([
      ['id', 'soc-1'],
      ['publish_status', 'publishing'],
    ]));
  });
});

describe('stale SOCIAL publishing sweep', () => {
  test('stranded publishing rows are marked failed — never retried (platforms may have partially posted)', async () => {
    const reset = await ContentScheduler.resetStalePublishingSocials();

    expect(reset).toBe(1);
    const sweep = mockState.updates.find((u) =>
      u.table === 'social_media_posts' && u.updates.publish_status === 'failed');
    expect(sweep).toBeDefined();
    expect(sweep.updates.status).toBe('failed');
    expect(sweep.filters).toEqual(expect.arrayContaining([
      ['publish_status', 'publishing'],
      ['scheduled_for', '<', expect.any(Date)],
    ]));
    // staleness keys on scheduled_for (the table has no updated_at) with a
    // ~30 min margin
    const cutoff = sweep.filters.find(([col]) => col === 'scheduled_for')[2];
    const ageMinutes = (Date.now() - cutoff.getTime()) / 60000;
    expect(ageMinutes).toBeGreaterThanOrEqual(29);
    expect(ageMinutes).toBeLessThanOrEqual(31);
    // and it must never write a retriable state
    expect(mockState.updates.some((u) =>
      u.table === 'social_media_posts' && ['pending', 'dry_run'].includes(u.updates.publish_status))).toBe(false);
  });

  test('processScheduledPosts runs the social sweep every tick, even with social flags off', async () => {
    await ContentScheduler.processScheduledPosts();
    const sweep = mockState.updates.find((u) =>
      u.table === 'social_media_posts'
      && u.updates.publish_status === 'failed'
      && u.filters.some(([col]) => col === 'scheduled_for'));
    expect(sweep).toBeDefined();
  });
});
