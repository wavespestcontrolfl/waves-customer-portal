jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const Engagement = require('../services/social-engagement');
const Studio = require('../services/social-content-studio');

describe('engagementTargets (platforms_posted → fetch targets)', () => {
  test('keeps successful FB/IG/LinkedIn entries with ids; drops GBP, failures, blanks, and dupes', () => {
    const post = {
      platforms_posted: [
        { platform: 'facebook', postId: '123_456', success: true, content: 'x' },
        { platform: 'instagram', postId: '17912345678901234', success: true, mediaType: 'reel' },
        { platform: 'linkedin', postId: null, success: true },            // LinkedIn can legitimately return no id
        { platform: 'gbp', postId: 'accounts/1/locations/2/localPosts/3', success: true, location: 'venice' },
        { platform: 'facebook', postId: '999', success: false, error: 'boom' },
        { platform: 'instagram', postId: 'dupe', success: true },          // second IG entry ignored
        'facebook',                                                        // legacy string entries
      ],
    };
    expect(Engagement.engagementTargets(post)).toEqual([
      { platform: 'facebook', platformPostId: '123_456', mediaType: null },
      { platform: 'instagram', platformPostId: '17912345678901234', mediaType: 'reel' },
    ]);
  });

  test('accepts the jsonb column as a JSON string and tolerates garbage', () => {
    expect(Engagement.engagementTargets({ platforms_posted: JSON.stringify([{ platform: 'facebook', postId: '1_2', success: true }]) }))
      .toEqual([{ platform: 'facebook', platformPostId: '1_2', mediaType: null }]);
    expect(Engagement.engagementTargets({ platforms_posted: 'not json' })).toEqual([]);
    expect(Engagement.engagementTargets({})).toEqual([]);
  });
});

describe('platform response parsers', () => {
  test('facebook: likes/comments summaries + shares count', () => {
    expect(Engagement.parseFacebookEngagement({
      likes: { summary: { total_count: 14 } }, comments: { summary: { total_count: 3 } }, shares: { count: 2 },
    })).toEqual({ likes: 14, comments: 3, shares: 2 });
    expect(Engagement.parseFacebookEngagement({})).toEqual({ likes: 0, comments: 0, shares: 0 });
  });

  test('instagram: like_count / comments_count; shares come from insights (null = not measured)', () => {
    expect(Engagement.parseInstagramEngagement({ like_count: 19, comments_count: 4 }))
      .toEqual({ likes: 19, comments: 4, shares: null });
    expect(Engagement.parseInstagramShares({ data: [{ name: 'shares', values: [{ value: 7 }] }] })).toBe(7);
    expect(Engagement.parseInstagramShares({ data: [{ name: 'shares', total_value: { value: 3 } }] })).toBe(3);
    expect(Engagement.parseInstagramShares({ data: [{ name: 'reach', values: [{ value: 900 }] }] })).toBeNull();
    expect(Engagement.parseInstagramShares({})).toBeNull();
  });

  test('linkedin: likesSummary / commentsSummary (aggregated preferred); reshares not exposed → shares null', () => {
    expect(Engagement.parseLinkedInEngagement({ likesSummary: { totalLikes: 5 }, commentsSummary: { aggregatedTotalComments: 2, totalFirstLevelComments: 1 } }))
      .toEqual({ likes: 5, comments: 2, shares: null });
    expect(Engagement.parseLinkedInEngagement({ likesSummary: { totalLikes: '7' }, commentsSummary: { totalFirstLevelComments: 1 } }))
      .toEqual({ likes: 7, comments: 1, shares: null });
    expect(Engagement.parseLinkedInEngagement({})).toEqual({ likes: 0, comments: 0, shares: null });
  });

  test('negative / non-numeric counts clamp to 0', () => {
    expect(Engagement.parseInstagramEngagement({ like_count: -3, comments_count: 'many' }))
      .toEqual({ likes: 0, comments: 0, shares: null });
  });
});

describe('scoreCounts', () => {
  test('matches the competitor swipe-file weights (likes + 3·comments + 5·shares; no views term)', () => {
    const counts = { likes: 10, comments: 4, shares: 2 };
    expect(Engagement.scoreCounts(counts)).toBe(32);
    expect(Engagement.scoreCounts(counts)).toBe(Studio.engagementScore({
      likesCount: counts.likes, commentsCount: counts.comments, sharesCount: counts.shares, viewsCount: 0,
    }));
  });
});

describe('fetchEngagement', () => {
  const prevToken = process.env.FACEBOOK_ACCESS_TOKEN;
  afterEach(() => {
    if (prevToken === undefined) delete process.env.FACEBOOK_ACCESS_TOKEN;
    else process.env.FACEBOOK_ACCESS_TOKEN = prevToken;
  });

  test('facebook: requests the summary fields and parses the counts; token never appears in errors', async () => {
    process.env.FACEBOOK_ACCESS_TOKEN = 'secret-token';
    const fetchFn = jest.fn(async (url) => {
      expect(url).toContain('https://graph.facebook.com/v25.0/123_456?fields=likes.summary(true),comments.summary(true),shares');
      return { ok: true, json: async () => ({ likes: { summary: { total_count: 8 } }, comments: { summary: { total_count: 1 } } }) };
    });
    await expect(Engagement.fetchEngagement({ platform: 'facebook', platformPostId: '123_456' }, { fetchFn }))
      .resolves.toEqual({ likes: 8, comments: 1, shares: 0 });

    const failing = jest.fn(async () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'Unsupported get request' } }) }));
    await expect(Engagement.fetchEngagement({ platform: 'instagram', platformPostId: '1' }, { fetchFn: failing }))
      .rejects.toThrow(/Graph 400: Unsupported get request/);
    await expect(Engagement.fetchEngagement({ platform: 'instagram', platformPostId: '1' }, { fetchFn: failing }))
      .rejects.not.toThrow(/secret-token/);
  });

  test('a 2xx with a malformed body is a fetch FAILURE, never an all-zero result', async () => {
    process.env.FACEBOOK_ACCESS_TOKEN = 't';
    const truncated = jest.fn(async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected end of JSON input'); } }));
    await expect(Engagement.fetchEngagement({ platform: 'facebook', platformPostId: '1_2' }, { fetchFn: truncated }))
      .rejects.toThrow(/malformed response body/);
  });

  test('facebook VIDEO targets omit the Post-only shares field and report shares as not measured', async () => {
    process.env.FACEBOOK_ACCESS_TOKEN = 't';
    const fetchFn = jest.fn(async (url) => {
      expect(url).toContain('/v25.0/987?fields=likes.summary(true),comments.summary(true)&');
      expect(url).not.toContain('shares');
      return { ok: true, status: 200, json: async () => ({ likes: { summary: { total_count: 5 } }, comments: { summary: { total_count: 2 } } }) };
    });
    await expect(Engagement.fetchEngagement({ platform: 'facebook', platformPostId: '987', mediaType: 'video' }, { fetchFn }))
      .resolves.toEqual({ likes: 5, comments: 2, shares: null });
  });

  test('instagram: media fields + insights shares; an unavailable insight leaves shares null', async () => {
    process.env.FACEBOOK_ACCESS_TOKEN = 't';
    const ok = jest.fn(async (url) => {
      if (url.includes('/insights?metric=shares')) return { ok: true, status: 200, json: async () => ({ data: [{ name: 'shares', values: [{ value: 4 }] }] }) };
      return { ok: true, status: 200, json: async () => ({ like_count: 19, comments_count: 3 }) };
    });
    await expect(Engagement.fetchEngagement({ platform: 'instagram', platformPostId: '17' }, { fetchFn: ok }))
      .resolves.toEqual({ likes: 19, comments: 3, shares: 4 });

    const noInsight = jest.fn(async (url) => {
      if (url.includes('/insights')) return { ok: false, status: 400, json: async () => ({ error: { message: 'Unsupported metric' } }) };
      return { ok: true, status: 200, json: async () => ({ like_count: 1, comments_count: 0 }) };
    });
    await expect(Engagement.fetchEngagement({ platform: 'instagram', platformPostId: '17' }, { fetchFn: noInsight }))
      .resolves.toEqual({ likes: 1, comments: 0, shares: null, sharesUnavailable: 'unsupported' });

    // A missing instagram_manage_insights scope is reported distinctly so the
    // sweep can surface it (the token procedure lists the scope).
    const denied = jest.fn(async (url) => {
      if (url.includes('/insights')) return { ok: false, status: 403, json: async () => ({ error: { message: '(#10) This endpoint requires the instagram_manage_insights permission', type: 'OAuthException' } }) };
      return { ok: true, status: 200, json: async () => ({ like_count: 1, comments_count: 0 }) };
    });
    await expect(Engagement.fetchEngagement({ platform: 'instagram', platformPostId: '17' }, { fetchFn: denied }))
      .resolves.toEqual({ likes: 1, comments: 0, shares: null, sharesUnavailable: 'permission' });

    // A TRANSIENT insights failure (5xx / timeout / malformed body) is NOT
    // "unsupported" — the whole target fails so last_error and job health see it.
    for (const bad of [
      { ok: false, status: 503, json: async () => ({ error: { message: 'Service temporarily unavailable' } }) },
      { ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected end of JSON input'); } },
    ]) {
      const flaky = jest.fn(async (url) => (url.includes('/insights') ? bad : { ok: true, status: 200, json: async () => ({ like_count: 1, comments_count: 0 }) }));
      await expect(Engagement.fetchEngagement({ platform: 'instagram', platformPostId: '17' }, { fetchFn: flaky })).rejects.toThrow(/Graph (503|200)/);
    }
    expect(Engagement.classifyInsightError(new Error('Graph 400: (#100) Unsupported metric shares'))).toBe('unsupported');
    expect(Engagement.classifyInsightError(new Error('Graph 400: Invalid parameter'))).toBeNull();
    expect(Engagement.classifyInsightError(new Error('The operation was aborted due to timeout'))).toBeNull();
  });

  test('facebook/instagram without a token fails that target only', async () => {
    delete process.env.FACEBOOK_ACCESS_TOKEN;
    await expect(Engagement.fetchEngagement({ platform: 'facebook', platformPostId: '1' }, { fetchFn: jest.fn() }))
      .rejects.toThrow(/FACEBOOK_ACCESS_TOKEN/);
  });

  test('linkedin: reads socialActions through the linkedin service', async () => {
    const linkedin = require('../services/linkedin');
    const spy = jest.spyOn(linkedin, 'fetchSocialActions').mockResolvedValue({ likesSummary: { totalLikes: 3 }, commentsSummary: { aggregatedTotalComments: 1 } });
    try {
      await expect(Engagement.fetchEngagement({ platform: 'linkedin', platformPostId: 'urn:li:share:99' }, { fetchFn: jest.fn() }))
        .resolves.toEqual({ likes: 3, comments: 1, shares: null });
      expect(spy).toHaveBeenCalledWith('urn:li:share:99');
    } finally {
      spy.mockRestore();
    }
  });

  test('unsupported platform rejects', async () => {
    await expect(Engagement.fetchEngagement({ platform: 'gbp', platformPostId: 'x' }, { fetchFn: jest.fn() })).rejects.toThrow(/no engagement source/);
  });
});

describe('reach and views (GATE_SOCIAL_REACH_INGEST)', () => {
  const prevToken = process.env.FACEBOOK_ACCESS_TOKEN;
  const prevGate = process.env.GATE_SOCIAL_REACH_INGEST;
  const logger = require('../services/logger');
  const ok = (body) => ({ ok: true, status: 200, json: async () => body });
  const refuse = (status, message) => ({ ok: false, status, json: async () => ({ error: { message } }) });
  const fbPost = { likes: { summary: { total_count: 8 } }, comments: { summary: { total_count: 1 } }, shares: { count: 2 } };
  const igMedia = { like_count: 19, comments_count: 3 };
  const igShares = { data: [{ name: 'shares', values: [{ value: 4 }] }] };

  // Routes a Graph URL to a canned reply; records every URL asked.
  function graph({ fbInsights, igInsights } = {}) {
    const urls = [];
    const fetchFn = jest.fn(async (url) => {
      urls.push(url);
      if (url.includes('/insights?metric=post_total_media_view_unique')) return fbInsights();
      if (url.includes('/insights?metric=reach,views')) return igInsights();
      if (url.includes('/insights?metric=shares')) return ok(igShares);
      return ok(url.includes('like_count') ? igMedia : fbPost);
    });
    return { fetchFn, urls };
  }
  const fbTarget = { platform: 'facebook', platformPostId: '123_456', mediaType: null };
  const igTarget = { platform: 'instagram', platformPostId: '17912345678901234', mediaType: 'image' };

  beforeEach(() => {
    process.env.FACEBOOK_ACCESS_TOKEN = 'secret-token';
    delete process.env.GATE_SOCIAL_REACH_INGEST;
    logger.warn.mockClear();
  });
  afterEach(() => {
    if (prevToken === undefined) delete process.env.FACEBOOK_ACCESS_TOKEN;
    else process.env.FACEBOOK_ACCESS_TOKEN = prevToken;
    if (prevGate === undefined) delete process.env.GATE_SOCIAL_REACH_INGEST;
    else process.env.GATE_SOCIAL_REACH_INGEST = prevGate;
  });

  test('parsers read the Meta metric names and treat a missing metric as not measured (null), a measured zero as 0', () => {
    expect(Engagement.parseFacebookReach({ data: [
      { name: 'post_total_media_view_unique', period: 'lifetime', values: [{ value: 940 }] },
      { name: 'post_media_view', period: 'lifetime', values: [{ value: 1310 }] },
    ] })).toEqual({ reach: 940, views: 1310 });
    expect(Engagement.parseFacebookReach({ data: [{ name: 'post_media_view', values: [{ value: 0 }] }] })).toEqual({ reach: null, views: 0 });
    expect(Engagement.parseInstagramReach({ data: [
      { name: 'reach', values: [{ value: 55 }] },
      { name: 'views', total_value: { value: 70 } },
    ] })).toEqual({ reach: 55, views: 70 });
    expect(Engagement.parseInstagramReach({})).toEqual({ reach: null, views: null });
    // the removed 2025 metrics are not read
    expect(Engagement.parseFacebookReach({ data: [{ name: 'post_impressions_unique', values: [{ value: 9 }] }] })).toEqual({ reach: null, views: null });
  });

  test('gate off: no reach insights call and the same result shape as before', async () => {
    const { fetchFn, urls } = graph();
    await expect(Engagement.fetchEngagement(fbTarget, { fetchFn })).resolves.toEqual({ likes: 8, comments: 1, shares: 2 });
    await expect(Engagement.fetchEngagement(igTarget, { fetchFn })).resolves.toEqual({ likes: 19, comments: 3, shares: 4 });
    // Facebook: the one counts call. Instagram: the media call + the shares insight. Nothing else.
    expect(urls).toHaveLength(3);
    expect(urls.some((u) => /reach|post_total_media_view_unique|post_media_view|views/.test(u))).toBe(false);
  });

  test('gate on: Facebook reach = post_total_media_view_unique, views = post_media_view; no removed impressions metric', async () => {
    process.env.GATE_SOCIAL_REACH_INGEST = 'true';
    const { fetchFn, urls } = graph({ fbInsights: () => ok({ data: [
      { name: 'post_total_media_view_unique', period: 'lifetime', values: [{ value: 940 }] },
      { name: 'post_media_view', period: 'lifetime', values: [{ value: 1310 }] },
    ] }) });
    await expect(Engagement.fetchEngagement(fbTarget, { fetchFn }))
      .resolves.toEqual({ likes: 8, comments: 1, shares: 2, reach: 940, views: 1310, reachUnavailable: null });
    const insights = urls.filter((u) => u.includes('/insights'));
    expect(insights).toHaveLength(1);
    expect(insights[0]).toContain('/v25.0/123_456/insights?metric=post_total_media_view_unique,post_media_view&access_token=secret-token');
    expect(insights[0]).not.toContain('impressions');
  });

  test('gate on: Instagram reach and views come from reach,views insights; the shares path is unchanged', async () => {
    process.env.GATE_SOCIAL_REACH_INGEST = 'true';
    const { fetchFn, urls } = graph({ igInsights: () => ok({ data: [
      { name: 'reach', values: [{ value: 55 }] },
      { name: 'views', values: [{ value: 70 }] },
    ] }) });
    await expect(Engagement.fetchEngagement(igTarget, { fetchFn }))
      .resolves.toEqual({ likes: 19, comments: 3, shares: 4, reach: 55, views: 70, reachUnavailable: null });
    expect(urls.filter((u) => u.includes('metric=reach,views'))).toHaveLength(1);
    expect(urls.join(' ')).not.toMatch(/impressions|plays|video_views/);
  });

  test('gate on: a Facebook video target is not measured and asks Graph nothing for reach', async () => {
    process.env.GATE_SOCIAL_REACH_INGEST = 'true';
    const { fetchFn, urls } = graph();
    const counts = await Engagement.fetchEngagement({ ...fbTarget, mediaType: 'video' }, { fetchFn });
    expect(counts).toMatchObject({ reach: null, views: null, reachUnavailable: null });
    expect(urls.some((u) => u.includes('/insights'))).toBe(false);
  });

  test('gate on: an unsupported metric or a permission error leaves reach and views null; likes and shares still sync', async () => {
    process.env.GATE_SOCIAL_REACH_INGEST = 'true';
    const unsupported = graph({ fbInsights: () => refuse(400, '(#100) The value must be a valid insights metric'), igInsights: () => refuse(400, 'Unsupported metric') });
    await expect(Engagement.fetchEngagement(fbTarget, { fetchFn: unsupported.fetchFn }))
      .resolves.toEqual({ likes: 8, comments: 1, shares: 2, reach: null, views: null, reachUnavailable: 'unsupported' });
    await expect(Engagement.fetchEngagement(igTarget, { fetchFn: unsupported.fetchFn }))
      .resolves.toMatchObject({ likes: 19, comments: 3, shares: 4, reach: null, views: null, reachUnavailable: 'unsupported' });

    const denied = graph({ fbInsights: () => refuse(403, '(#10) This endpoint requires the read_insights permission'), igInsights: () => refuse(403, '(#200) permission denied') });
    await expect(Engagement.fetchEngagement(fbTarget, { fetchFn: denied.fetchFn }))
      .resolves.toMatchObject({ likes: 8, reach: null, views: null, reachUnavailable: 'permission' });
    await expect(Engagement.fetchEngagement(igTarget, { fetchFn: denied.fetchFn }))
      .resolves.toMatchObject({ likes: 19, reach: null, views: null, reachUnavailable: 'permission' });
  });

  test('gate on: a transient reach error (5xx, malformed body) never fails the likes and comments fetch', async () => {
    process.env.GATE_SOCIAL_REACH_INGEST = 'true';
    const flaky = graph({
      fbInsights: () => refuse(503, 'Service temporarily unavailable'),
      igInsights: () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected end of JSON input'); } }),
    });
    await expect(Engagement.fetchEngagement(fbTarget, { fetchFn: flaky.fetchFn }))
      .resolves.toMatchObject({ likes: 8, comments: 1, reach: null, views: null, reachUnavailable: 'error' });
    await expect(Engagement.fetchEngagement(igTarget, { fetchFn: flaky.fetchFn }))
      .resolves.toMatchObject({ likes: 19, comments: 3, reach: null, views: null, reachUnavailable: 'error' });
  });

  describe('sweep and upsert', () => {
    const feature = require('../config/feature-gates');
    const db = require('../models/db');
    const linkedin = require('../services/linkedin');
    let stored; let inserts; let selects;

    function fakeDb(posts) {
      stored = {};
      inserts = [];
      selects = [];
      db.schema = { hasTable: async () => true };
      db.raw = (sql) => ({ sql });
      db.mockImplementation((table) => {
        const b = {};
        if (table === 'social_media_posts') {
          let served = false;
          ['where', 'modify', 'orderByRaw', 'limit'].forEach((m) => { b[m] = jest.fn(() => b); });
          b.select = jest.fn(async () => { const rows = served ? [] : posts; served = true; return rows; });
          return b;
        }
        let key = null;
        b.where = jest.fn((w) => { key = `${w.post_id}|${w.platform}`; return b; });
        b.first = jest.fn(async (...cols) => { selects.push(cols); return stored[key] || undefined; });
        b.insert = jest.fn((row) => { b.row = row; return b; });
        b.onConflict = jest.fn(() => b);
        b.merge = jest.fn(async () => {
          const k = `${b.row.post_id}|${b.row.platform}`;
          inserts.push(b.row);
          stored[k] = { ...(stored[k] || {}), ...b.row };
        });
        return b;
      });
    }
    const postsRow = [{ id: 'p1', platforms_posted: [
      { platform: 'facebook', postId: '123_456', success: true },
      { platform: 'instagram', postId: '17912345678901234', success: true, mediaType: 'image' },
    ] }];
    let skip;
    beforeEach(() => {
      skip = jest.spyOn(linkedin, 'linkedinEngagementReady').mockResolvedValue({ ready: false, reason: 'test' });
      logger.warn.mockClear();
    });
    afterEach(() => { skip.mockRestore(); db.mockReset(); });

    const reachWarnings = () => logger.warn.mock.calls.map((c) => c[0]).filter((m) => /reach\/views/.test(m));

    test('gate on: reach and views are upserted for Facebook and Instagram, and the readers agree with the gate', async () => {
      process.env.GATE_SOCIAL_REACH_INGEST = 'true';
      expect(feature.socialReachIngestLive()).toBe(true);
      fakeDb(postsRow);
      const { fetchFn } = graph({
        fbInsights: () => ok({ data: [{ name: 'post_total_media_view_unique', values: [{ value: 940 }] }, { name: 'post_media_view', values: [{ value: 1310 }] }] }),
        igInsights: () => ok({ data: [{ name: 'reach', values: [{ value: 55 }] }, { name: 'views', values: [{ value: 70 }] }] }),
      });
      const summary = await Engagement.syncRecentEngagement({ fetchFn });
      expect(summary).toMatchObject({ targets: 2, synced: 2, failed: 0 });
      expect(stored['p1|facebook']).toMatchObject({ likes_count: 8, shares_count: 2, reach: 940, views: 1310 });
      expect(stored['p1|instagram']).toMatchObject({ likes_count: 19, shares_count: 4, reach: 55, views: 70 });
      expect(reachWarnings()).toHaveLength(0);
    });

    test('gate off: the insert has no reach or views column and the prior values are never read', async () => {
      expect(feature.socialReachIngestLive()).toBe(false);
      fakeDb(postsRow);
      const { fetchFn, urls } = graph();
      const summary = await Engagement.syncRecentEngagement({ fetchFn });
      expect(summary).toEqual({ posts: 1, targets: 2, synced: 2, failed: 0, skippedTargets: 0, sharesPermissionDenied: 0 });
      expect(inserts).toHaveLength(2);
      for (const row of inserts) {
        expect(Object.keys(row)).not.toContain('reach');
        expect(Object.keys(row)).not.toContain('views');
      }
      expect(selects).toHaveLength(0);
      expect(urls.some((u) => /post_total_media_view_unique|metric=reach/.test(u))).toBe(false);
    });

    test('gate on: not measured is NULL, a later not-measured fetch keeps the prior value, and a permission error warns once per sweep naming the scope', async () => {
      process.env.GATE_SOCIAL_REACH_INGEST = 'true';
      fakeDb(postsRow);
      const denied = graph({
        fbInsights: () => refuse(403, '(#10) This endpoint requires the read_insights permission'),
        igInsights: () => refuse(403, '(#200) permission denied'),
      });
      const first = await Engagement.syncRecentEngagement({ fetchFn: denied.fetchFn });
      // the sweep and the likes path are unaffected
      expect(first).toMatchObject({ targets: 2, synced: 2, failed: 0 });
      expect(stored['p1|facebook']).toMatchObject({ likes_count: 8, reach: null, views: null });
      expect(stored['p1|instagram']).toMatchObject({ likes_count: 19, reach: null, views: null });
      const warnings = reachWarnings();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/read_insights and pages_read_engagement/);
      expect(warnings[0]).toMatch(/instagram_manage_insights/);
      expect(warnings[0]).not.toContain('secret-token');

      // A measured value, then a sweep where Meta gives nothing: the number stays.
      stored['p1|facebook'].reach = 940;
      stored['p1|facebook'].views = 1310;
      logger.warn.mockClear();
      const flaky = graph({ fbInsights: () => refuse(503, 'down'), igInsights: () => refuse(400, 'Unsupported metric') });
      const second = await Engagement.syncRecentEngagement({ fetchFn: flaky.fetchFn });
      expect(second).toMatchObject({ synced: 2, failed: 0 });
      expect(stored['p1|facebook']).toMatchObject({ reach: 940, views: 1310 });
      expect(stored['p1|instagram']).toMatchObject({ reach: null, views: null });
      expect(reachWarnings()).toHaveLength(1);
    });

    test('gate on: a measured zero is stored as 0, not null', async () => {
      process.env.GATE_SOCIAL_REACH_INGEST = 'true';
      fakeDb(postsRow);
      const { fetchFn } = graph({
        fbInsights: () => ok({ data: [{ name: 'post_total_media_view_unique', values: [{ value: 0 }] }, { name: 'post_media_view', values: [{ value: 0 }] }] }),
        igInsights: () => ok({ data: [{ name: 'reach', values: [{ value: 0 }] }] }),
      });
      await Engagement.syncRecentEngagement({ fetchFn });
      expect(stored['p1|facebook']).toMatchObject({ reach: 0, views: 0 });
      expect(stored['p1|instagram']).toMatchObject({ reach: 0, views: null });
    });
  });
});
