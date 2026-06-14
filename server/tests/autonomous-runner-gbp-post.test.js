/**
 * Unit tests for the autonomous gbp_post distributor
 * (_handleGbpPostAction + gbpLocationIdForCity).
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/social-media', () => ({
  generateContent: jest.fn(),
  validateContent: jest.fn(),
  postToGBP: jest.fn(),
  generateImage: jest.fn(),
  uploadImageToS3: jest.fn(),
  assertSocialPublishingReady: jest.fn(),
  SOCIAL_FLAGS: { dryRun: false },
}));

const db = require('../models/db');
const social = require('../services/social-media');
const runner = require('../services/content/autonomous-runner');
const { gbpLocationIdForCity } = runner._internals;

const ORIGINAL_ENV = { ...process.env };

// db('autonomous_runs') serves both the daily-cap count and the
// trust-build select; db('social_media_posts') absorbs the audit insert.
function mockDb({ publishedToday = 0, trustBuildRows = [] } = {}) {
  const inserts = [];
  db.mockImplementation((table) => {
    if (table === 'autonomous_runs') {
      return {
        where() { return this; },
        whereIn() { return this; },
        count: async () => [{ count: String(publishedToday) }],
        select: async () => trustBuildRows,
      };
    }
    if (table === 'social_media_posts') {
      return { insert: async (row) => { inserts.push(row); return [1]; } };
    }
    throw new Error(`Unexpected table: ${table}`);
  });
  return inserts;
}

function baseBrief(overrides = {}) {
  return {
    action_type: 'gbp_post',
    city: 'sarasota',
    service: 'pest',
    target_keyword: 'pest control sarasota',
    target_url: 'https://www.wavespestcontrol.com/pest-control-sarasota-fl/',
    customer_signal: { normalized_question: 'are ghost ants seasonal in sarasota?' },
    router_notes: 'gbp_post routed from aeo_gap',
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...ORIGINAL_ENV };
  delete process.env.AUTONOMOUS_GBP_POST_DAILY_CAP;
  delete process.env.AUTO_PUBLISH_GBP_POST;
  social.SOCIAL_FLAGS.dryRun = false;
  social.generateContent.mockResolvedValue('Sarasota ghost ants are peaking. Schedule an inspection.');
  social.validateContent.mockReturnValue({ valid: true, issues: [] });
  // Default: image generation yields nothing → posts go out text-only (the
  // pre-existing behavior). The image-attached path is covered explicitly below.
  social.generateImage.mockResolvedValue(null);
  social.uploadImageToS3.mockResolvedValue(null);
  social.assertSocialPublishingReady.mockResolvedValue({ ready: true });
  social.postToGBP.mockResolvedValue({ platform: 'gbp', location: 'sarasota', success: true, postId: 'accounts/1/locations/2/localPosts/3' });
});

afterAll(() => { process.env = ORIGINAL_ENV; });

describe('gbpLocationIdForCity', () => {
  test('maps cities to their covering GBP location (canonical CITY_TO_LOCATION)', () => {
    expect(gbpLocationIdForCity('bradenton')).toBe('bradenton');
    expect(gbpLocationIdForCity('lakewood-ranch')).toBe('bradenton');
    expect(gbpLocationIdForCity('Lakewood Ranch')).toBe('bradenton');
    expect(gbpLocationIdForCity('palmetto')).toBe('parrish');
    expect(gbpLocationIdForCity('siesta-key')).toBe('sarasota');
    expect(gbpLocationIdForCity('north-port')).toBe('venice');
    expect(gbpLocationIdForCity('port-charlotte')).toBe('venice');
    expect(gbpLocationIdForCity('Port Charlotte')).toBe('venice');
    expect(gbpLocationIdForCity('englewood')).toBe('venice');
  });
  test('unmapped or missing city → null', () => {
    expect(gbpLocationIdForCity('tampa')).toBeNull();
    expect(gbpLocationIdForCity(null)).toBeNull();
    expect(gbpLocationIdForCity('')).toBeNull();
  });
});

describe('_handleGbpPostAction', () => {
  test('shadow mode: generates copy, parks for review, never posts', async () => {
    mockDb();
    const run = { shadow_mode: true };
    const result = await runner._handleGbpPostAction(baseBrief(), run);

    expect(result.claim).toBe('pending');
    expect(result.patch.outcome).toBe('skipped_shadow_mode');
    expect(result.patch.skip_reason).toBe('gbp_post_shadow');
    expect(result.patch.reviewer_notes).toContain('Sarasota ghost ants');
    expect(social.postToGBP).not.toHaveBeenCalled();
    expect(run.draft_payload.gbp_post.location_id).toBe('sarasota');
  });

  test('live mode (auto-publish enabled): posts to the single covering location and completes', async () => {
    process.env.AUTO_PUBLISH_GBP_POST = 'true';
    const inserts = mockDb();
    const run = { shadow_mode: false };
    const result = await runner._handleGbpPostAction(baseBrief(), run);

    expect(social.postToGBP).toHaveBeenCalledTimes(1);
    expect(social.postToGBP).toHaveBeenCalledWith(
      'sarasota',
      'Sarasota ghost ants are peaking. Schedule an inspection.',
      'https://www.wavespestcontrol.com/pest-control-sarasota-fl/',
      null
    );
    expect(result.claim).toBe('complete');
    expect(result.patch.outcome).toBe('completed_published');
    // published_url must stay null — impact-tracker sweeps non-null rows as pages.
    expect(result.patch.published_url).toBeNull();
    expect(inserts).toHaveLength(1);
    expect(inserts[0].source_type).toBe('content_engine');
  });

  test('live mode default: parks under the trust-build ramp before posting', async () => {
    mockDb();
    const run = { shadow_mode: false };
    const result = await runner._handleGbpPostAction(baseBrief(), run);

    expect(result.claim).toBe('pending');
    expect(result.patch.outcome).toBe('completed_pending_review');
    expect(result.patch.skip_reason).toMatch(/^trust_build_0_of_\d+$/);
    expect(result.patch.reviewer_notes).toContain('Sarasota ghost ants');
    expect(social.postToGBP).not.toHaveBeenCalled();
    expect(run.trust_build_count_after).toBe(1);
  });

  test('router human_review_required parks before posting even with auto-publish on', async () => {
    process.env.AUTO_PUBLISH_GBP_POST = 'true';
    mockDb();
    const result = await runner._handleGbpPostAction(
      baseBrief({ human_review_required: true, human_review_reason: 'repeated_brief_versions' }),
      { shadow_mode: false }
    );

    expect(result.claim).toBe('pending');
    expect(result.patch.skip_reason).toBe('gbp_post_human_review');
    expect(result.patch.reviewer_notes).toContain('repeated_brief_versions');
    expect(social.postToGBP).not.toHaveBeenCalled();
  });

  test('SOCIAL_DRY_RUN parks instead of posting even with auto-publish on', async () => {
    process.env.AUTO_PUBLISH_GBP_POST = 'true';
    mockDb();
    social.SOCIAL_FLAGS.dryRun = true;
    const result = await runner._handleGbpPostAction(baseBrief(), { shadow_mode: false });

    expect(result.claim).toBe('pending');
    expect(result.patch.skip_reason).toBe('gbp_post_social_dry_run');
    expect(social.postToGBP).not.toHaveBeenCalled();
  });

  test('satellite city: copy localizes to the brief city, post goes to the covering profile', async () => {
    process.env.AUTO_PUBLISH_GBP_POST = 'true';
    mockDb();
    await runner._handleGbpPostAction(baseBrief({ city: 'north-port' }), { shadow_mode: false });

    expect(social.generateContent).toHaveBeenCalledWith('gbp', expect.objectContaining({
      locationName: 'North Port',
    }));
    expect(social.postToGBP).toHaveBeenCalledWith('venice', expect.any(String), expect.anything(), null);
  });

  test('unmapped city parks for manual routing without generating', async () => {
    mockDb();
    const result = await runner._handleGbpPostAction(baseBrief({ city: 'tampa' }), { shadow_mode: true });

    expect(result.claim).toBe('pending');
    expect(result.patch.skip_reason).toBe('gbp_post_no_location');
    expect(social.generateContent).not.toHaveBeenCalled();
  });

  test('daily cap parks instead of posting', async () => {
    mockDb({ publishedToday: 1 });
    const result = await runner._handleGbpPostAction(baseBrief(), { shadow_mode: false });

    expect(result.claim).toBe('pending');
    expect(result.patch.skip_reason).toBe('gbp_post_daily_cap');
    expect(social.postToGBP).not.toHaveBeenCalled();
  });

  test('non-hub target_url is dropped from the CTA', async () => {
    process.env.AUTO_PUBLISH_GBP_POST = 'true';
    mockDb();
    const run = { shadow_mode: false };
    await runner._handleGbpPostAction(
      baseBrief({ target_url: 'https://sarasotaexterminator.com/some-page/' }),
      run
    );
    expect(social.postToGBP).toHaveBeenCalledWith('sarasota', expect.any(String), null, null);
  });

  test('attaches a generated CDN image to the GBP post when image generation succeeds', async () => {
    process.env.AUTO_PUBLISH_GBP_POST = 'true';
    mockDb();
    social.generateImage.mockResolvedValue({ base64: 'ZmFrZQ==', mimeType: 'image/jpeg' });
    social.uploadImageToS3.mockResolvedValue('https://cdn.example.com/social-media/gbp.jpg');
    await runner._handleGbpPostAction(baseBrief(), { shadow_mode: false });

    expect(social.uploadImageToS3).toHaveBeenCalledTimes(1);
    expect(social.postToGBP).toHaveBeenCalledWith(
      'sarasota',
      expect.any(String),
      'https://www.wavespestcontrol.com/pest-control-sarasota-fl/',
      'https://cdn.example.com/social-media/gbp.jpg'
    );
  });

  test('image generation failure still posts (text-only), does not block publish', async () => {
    process.env.AUTO_PUBLISH_GBP_POST = 'true';
    mockDb();
    social.generateImage.mockRejectedValue(new Error('image provider down'));
    const result = await runner._handleGbpPostAction(baseBrief(), { shadow_mode: false });

    expect(result.claim).toBe('complete');
    expect(result.patch.outcome).toBe('completed_published');
    expect(social.postToGBP).toHaveBeenCalledWith('sarasota', expect.any(String), expect.any(String), null);
  });

  test('validation failure parks with the rejected copy in notes', async () => {
    mockDb();
    social.validateContent.mockReturnValue({ valid: false, issues: ['exceeds 1500 char limit'] });
    const result = await runner._handleGbpPostAction(baseBrief(), { shadow_mode: false });

    expect(result.claim).toBe('pending');
    expect(result.patch.skip_reason).toBe('gbp_post_validation_failed');
    expect(social.postToGBP).not.toHaveBeenCalled();
  });

  test('social kill switch parks the post in live mode', async () => {
    process.env.AUTO_PUBLISH_GBP_POST = 'true';
    mockDb();
    social.assertSocialPublishingReady.mockResolvedValue({ ready: false, reason: 'Automation paused by admin' });
    const result = await runner._handleGbpPostAction(baseBrief(), { shadow_mode: false });

    expect(result.claim).toBe('pending');
    expect(result.patch.skip_reason).toBe('gbp_post_social_not_ready');
    expect(result.patch.reviewer_notes).toContain('paused by admin');
    expect(social.postToGBP).not.toHaveBeenCalled();
  });

  test('post failure releases the claim for retry (failed_publish)', async () => {
    process.env.AUTO_PUBLISH_GBP_POST = 'true';
    mockDb();
    social.postToGBP.mockResolvedValue({ platform: 'gbp', location: 'sarasota', success: false, error: 'HTTP 503' });
    const result = await runner._handleGbpPostAction(baseBrief(), { shadow_mode: false });

    expect(result.claim).toBe('release');
    expect(result.patch.outcome).toBe('failed_publish');
    expect(result.patch.failure_message).toContain('HTTP 503');
  });

  test('audit insert failure does not fail the publish', async () => {
    process.env.AUTO_PUBLISH_GBP_POST = 'true';
    db.mockImplementation((table) => {
      if (table === 'autonomous_runs') {
        return { where() { return this; }, whereIn() { return this; }, count: async () => [{ count: '0' }], select: async () => [] };
      }
      if (table === 'social_media_posts') {
        return { insert: async () => { throw new Error('relation missing'); } };
      }
      throw new Error(`Unexpected table: ${table}`);
    });
    const result = await runner._handleGbpPostAction(baseBrief(), { shadow_mode: false });

    expect(result.claim).toBe('complete');
    expect(result.patch.outcome).toBe('completed_published');
  });
});
