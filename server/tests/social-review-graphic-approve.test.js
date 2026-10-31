/**
 * SOC-02 A: Approve on a Saved Graphic POSTS the graphic through the same
 * testimonial publish path an approved autonomous review run uses, and marks
 * it 'approved' (= consumed) only after a real post. Synthetic data only.
 *
 * The fake db below is a small stateful table store (where / whereNull /
 * whereRaw / first / update / returning) so the REAL publishWithReviewLivenessLock,
 * recordTestimonialPublished and approveReviewGraphic run end to end; only the
 * provider call (SocialMediaService.publishToAll) is faked.
 */

jest.mock('../models/db', () => {
  const tables = {};
  const matchers = (ctx) => (row) => ctx.filters.every((f) => f(row));
  const dbFn = (table) => {
    const ctx = { filters: [] };
    const rows = () => (tables[table] || []).filter(matchers(ctx));
    const builder = {
      where(a, b) {
        if (a && typeof a === 'object') {
          Object.entries(a).forEach(([k, v]) => ctx.filters.push((r) => r[k] === v));
        } else {
          ctx.filters.push((r) => r[a] === b);
        }
        return builder;
      },
      whereNull(col) { ctx.filters.push((r) => r[col] == null); return builder; },
      whereRaw(sql, [now]) {
        // The publish-claim acquisition: unclaimed or expired.
        ctx.filters.push((r) => r.publish_claimed_until == null || r.publish_claimed_until < now);
        return builder;
      },
      forUpdate() { return builder; },
      async first() { return rows()[0]; },
      update(patch) {
        const hit = rows();
        hit.forEach((r) => Object.assign(r, patch));
        const p = Promise.resolve(hit.length);
        p.returning = async () => hit.map((r) => ({ ...r }));
        return p;
      },
    };
    return builder;
  };
  dbFn.schema = { hasTable: async () => true, hasColumn: async () => true };
  dbFn.__tables = tables;
  return dbFn;
});

// Non-blocking per-name lock, like the Postgres advisory lock.
jest.mock('../utils/cron-lock', () => {
  const held = new Set();
  return {
    runExclusive: async (name, fn) => {
      if (held.has(name)) return { skipped: true };
      held.add(name);
      try { return await fn(); } finally { held.delete(name); }
    },
    isLocked: async () => false,
    recordJobStart: async () => {},
    recordJobEnd: async () => {},
  };
});

const db = require('../models/db');
const SocialMediaService = require('../services/social-media');
const Studio = require('../services/social-content-studio');

const REVIEW_ID = 'rev-1';
const GRAPHIC_ID = 'gfx-1';
const IMAGE = 'https://cdn.example.test/review-card.jpg';

function seed({ review = {}, graphic = {} } = {}) {
  db.__tables.google_reviews = [{
    id: REVIEW_ID,
    location_id: 'sarasota',
    missing_since: null,
    testimonial_published_at: null,
    testimonial_published_run: null,
    publish_claimed_until: null,
    ...review,
  }];
  db.__tables.review_graphics = [{
    id: GRAPHIC_ID,
    google_review_id: REVIEW_ID,
    status: 'draft',
    reviewer_display_name: 'Pat, Sarasota',
    location_id: 'sarasota',
    city: 'Sarasota',
    excerpt: 'Quick, friendly, and the ants are gone.',
    caption: 'A 5-star Google review from Pat, Sarasota.',
    image_url: IMAGE,
    channels: ['gbp', 'facebook', 'instagram'],
    approved_at: null,
    ...graphic,
  }];
}

const graphicRow = () => db.__tables.review_graphics[0];
const reviewRow = () => db.__tables.google_reviews[0];

let publishToAll;

beforeEach(() => {
  delete process.env.SOCIAL_DRY_RUN;
  global.fetch = jest.fn(async () => ({ status: 200 }));
  seed();
  // Like the real publishToAll: fire the first-success hook, then return.
  publishToAll = jest.spyOn(SocialMediaService, 'publishToAll').mockImplementation(async (args) => {
    const platforms = [{ platform: 'facebook', success: true }, { platform: 'instagram', success: true }];
    await args.onFirstPlatformSuccess?.(platforms[0]);
    return { success: true, dryRun: false, platforms };
  });
});

afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.SOCIAL_DRY_RUN;
});

describe('approveReviewGraphic', () => {
  test('posts the stored image + channels through publishToAll, stamps the review, then approves', async () => {
    const out = await Studio.approveReviewGraphic(GRAPHIC_ID);

    expect(out).toMatchObject({ ok: true, published: true, dryRun: false });
    expect(out.graphic.status).toBe('approved');
    expect(publishToAll).toHaveBeenCalledTimes(1);
    const args = publishToAll.mock.calls[0][0];
    expect(args.imageUrl).toBe(IMAGE);
    expect(args.channels).toEqual(['gbp', 'facebook', 'instagram']);
    expect(args.noAiImage).toBe(true);
    expect(args.gbpLocationIds).toEqual(['sarasota']);
    // Caption source: the same testimonial drafts an approved review run posts.
    expect(args.customContent.facebook).toContain('"Quick, friendly, and the ants are gone."');
    expect(args.customContent.facebook).toContain('A real 5-star Google review from Pat, Sarasota.');
    expect(args.customContent.gbp).toContain('A Sarasota customer left Waves a 5-star Google review');
    expect(typeof args.onFirstPlatformSuccess).toBe('function');
    // Durable stamp owned by the graphic token, claim released.
    expect(reviewRow().testimonial_published_at).toBeTruthy();
    expect(reviewRow().testimonial_published_run).toBe(`graphic:${GRAPHIC_ID}`);
    expect(reviewRow().publish_claimed_until).toBeNull();
    expect(graphicRow().status).toBe('approved');
    expect(graphicRow().approved_at).toBeInstanceOf(Date);
  });

  test('a removed source review is a 409: nothing posted, graphic not approved', async () => {
    seed({ review: { missing_since: '2026-10-30T00:00:00Z' } });
    const out = await Studio.approveReviewGraphic(GRAPHIC_ID);
    expect(out).toMatchObject({ ok: false, status: 409 });
    expect(out.error).toMatch(/removed from Google/);
    expect(publishToAll).not.toHaveBeenCalled();
    expect(graphicRow().status).toBe('draft');
  });

  test('a review already published by something else is a 409 consumed: nothing posted', async () => {
    seed({ review: { testimonial_published_at: '2026-10-20T12:00:00Z', testimonial_published_run: 'run-other' } });
    const out = await Studio.approveReviewGraphic(GRAPHIC_ID);
    expect(out).toMatchObject({ ok: false, status: 409 });
    expect(out.error).toMatch(/already published as a testimonial/);
    expect(publishToAll).not.toHaveBeenCalled();
    expect(graphicRow().status).toBe('draft');
    expect(reviewRow().publish_claimed_until).toBeNull();
  });

  test('another approved graphic for the same review also counts as consumed', async () => {
    db.__tables.review_graphics.push({ id: 'gfx-2', google_review_id: REVIEW_ID, status: 'approved' });
    const out = await Studio.approveReviewGraphic(GRAPHIC_ID);
    expect(out).toMatchObject({ ok: false, status: 409 });
    expect(publishToAll).not.toHaveBeenCalled();
    expect(graphicRow().status).toBe('draft');
  });

  test('no channel succeeded: 502, graphic stays unapproved, review stays available', async () => {
    publishToAll.mockResolvedValue({
      success: false,
      dryRun: false,
      platforms: [{ platform: 'facebook', success: false, error: 'token expired' }],
    });
    const out = await Studio.approveReviewGraphic(GRAPHIC_ID);
    expect(out).toMatchObject({ ok: false, status: 502 });
    expect(out.error).toMatch(/nothing was posted/);
    expect(out.error).toContain('facebook: token expired');
    expect(graphicRow().status).toBe('draft');
    expect(reviewRow().testimonial_published_at).toBeNull();
    expect(reviewRow().publish_claimed_until).toBeNull(); // claim released: review selectable again
  });

  test('dry-run: nothing is stamped or approved, and the response says dry-run', async () => {
    process.env.SOCIAL_DRY_RUN = 'true';
    publishToAll.mockImplementation(async (args) => {
      expect(args.onFirstPlatformSuccess).toBeNull();
      return { success: false, dryRun: true, platforms: [{ platform: 'facebook', success: false, dryRun: true }] };
    });
    const out = await Studio.approveReviewGraphic(GRAPHIC_ID);
    expect(out).toMatchObject({ ok: true, published: false, dryRun: true });
    expect(graphicRow().status).toBe('draft');
    expect(reviewRow().testimonial_published_at).toBeNull();
    expect(reviewRow().publish_claimed_until).toBeNull();
  });

  test('a double click publishes once; the second request is a 409', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    publishToAll.mockImplementation(async (args) => {
      await gate;
      await args.onFirstPlatformSuccess?.({ platform: 'facebook', success: true });
      return { success: true, dryRun: false, platforms: [{ platform: 'facebook', success: true }] };
    });
    const first = Studio.approveReviewGraphic(GRAPHIC_ID);
    await new Promise((resolve) => setImmediate(resolve));
    const second = await Studio.approveReviewGraphic(GRAPHIC_ID);
    expect(second).toMatchObject({ ok: false, status: 409 });
    expect(second.error).toMatch(/already in progress/);
    release();
    expect(await first).toMatchObject({ ok: true, published: true });
    expect(publishToAll).toHaveBeenCalledTimes(1);
  });

  test('an already-approved graphic is a 409 and never posts again', async () => {
    seed({ graphic: { status: 'approved' } });
    const out = await Studio.approveReviewGraphic(GRAPHIC_ID);
    expect(out).toMatchObject({ ok: false, status: 409 });
    expect(publishToAll).not.toHaveBeenCalled();
  });

  test('a graphic that posted but never flipped to approved finishes bookkeeping without posting again', async () => {
    seed({ review: { testimonial_published_at: '2026-10-31T12:00:00Z', testimonial_published_run: `graphic:${GRAPHIC_ID}` } });
    const out = await Studio.approveReviewGraphic(GRAPHIC_ID);
    expect(out).toMatchObject({ ok: true, published: true });
    expect(publishToAll).not.toHaveBeenCalled();
    expect(graphicRow().status).toBe('approved');
  });

  test('a graphic with no rendered image is a 400 and never posts', async () => {
    seed({ graphic: { image_url: null } });
    const out = await Studio.approveReviewGraphic(GRAPHIC_ID);
    expect(out).toMatchObject({ ok: false, status: 400 });
    expect(publishToAll).not.toHaveBeenCalled();
  });

  test('an unknown graphic is a 404', async () => {
    const out = await Studio.approveReviewGraphic('missing');
    expect(out).toMatchObject({ ok: false, status: 404 });
  });
});
