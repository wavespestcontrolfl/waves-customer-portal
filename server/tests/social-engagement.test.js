jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const Engagement = require('../services/social-engagement');
const Studio = require('../services/social-content-studio');

describe('engagementTargets (platforms_posted → fetch targets)', () => {
  test('keeps successful FB/IG entries with ids; drops LinkedIn/GBP, failures, blanks, and dupes', () => {
    const post = {
      platforms_posted: [
        { platform: 'facebook', postId: '123_456', success: true, content: 'x' },
        { platform: 'instagram', postId: '17912345678901234', success: true, mediaType: 'reel' },
        { platform: 'linkedin', postId: 'urn:li:share:1', success: true },  // LinkedIn: no metrics leg in v1
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

  test('unsupported platform rejects', async () => {
    await expect(Engagement.fetchEngagement({ platform: 'gbp', platformPostId: 'x' }, { fetchFn: jest.fn() })).rejects.toThrow(/no engagement source/);
  });
});
