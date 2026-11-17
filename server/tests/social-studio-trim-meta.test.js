/**
 * Studio trim (owner 2026-11-01): the AUTONOMOUS studio never drafts or posts
 * to Facebook and Instagram; LinkedIn and Google Business stay. Manual paths
 * (previewCampaign / Publish All / testimonial graphics) are never filtered.
 */

jest.mock('../models/db', () => {
  const state = { run: null, inserted: [], updated: [] };
  const dbFn = (table) => {
    const builder = {
      _table: table,
      _op: null,
      where() { return builder; },
      whereIn() { return builder; },
      whereNull() { return builder; },
      orderBy() { return builder; },
      select() { return builder; },
      limit() { return builder; },
      async first() {
        return table === 'social_content_studio_runs' ? state.run : undefined;
      },
      insert(row) { state.inserted.push({ table, row }); builder._op = 'insert'; return builder; },
      update(patch) { state.updated.push({ table, patch }); builder._op = 'update'; return builder; },
      async returning() {
        if (builder._op === 'insert') return [{ id: 'run-new', ...state.inserted[state.inserted.length - 1].row }];
        if (builder._op === 'update') return [{ ...(state.run || {}), ...state.updated[state.updated.length - 1].patch }];
        return [];
      },
      catch() { return Promise.resolve(null); },
      then(resolve, reject) { return Promise.resolve([]).then(resolve, reject); },
    };
    return builder;
  };
  dbFn.schema = { hasTable: async () => true, hasColumn: async () => true };
  dbFn.raw = jest.fn();
  dbFn.__state = state;
  return dbFn;
});

jest.mock('../utils/cron-lock', () => ({
  runExclusive: async (name, fn) => fn(),
  isLocked: async () => false,
  recordJobStart: async () => {},
  recordJobEnd: async () => {},
}));

jest.mock('../services/social-media', () => ({
  SOCIAL_FLAGS: {
    automationEnabled: true,
    dryRun: false,
    facebookEnabled: true,
    instagramEnabled: true,
  },
  isPausedByAdmin: jest.fn(async () => false),
  validateContent: jest.fn(() => ({ valid: true, issues: [] })),
  normalizeUrl: (u) => u,
  assertSocialPublishingReady: jest.fn(async () => ({ ready: true })),
  publishToAll: jest.fn(async () => ({
    success: true,
    platforms: [{ platform: 'gbp', success: true }, { platform: 'linkedin', success: true }],
  })),
}));

jest.mock('../services/social-card-renderer', () => ({
  renderCampaignImageUrl: jest.fn(),
}));

const db = require('../models/db');
const SocialMediaService = require('../services/social-media');
const Studio = require('../services/social-content-studio');

const ENV_KEYS = ['SOCIAL_AUTONOMOUS_CHANNELS', 'SOCIAL_AUTONOMOUS_STUDIO_ENABLED', 'SOCIAL_AUTONOMOUS_INCLUDE_VERSUS'];
const saved = {};
beforeAll(() => { ENV_KEYS.forEach((k) => { saved[k] = process.env[k]; }); });
afterAll(() => {
  ENV_KEYS.forEach((k) => {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  });
});
beforeEach(() => {
  ENV_KEYS.forEach((k) => { delete process.env[k]; });
  db.__state.run = null;
  db.__state.inserted.length = 0;
  db.__state.updated.length = 0;
  SocialMediaService.publishToAll.mockClear();
});

const etNoon = (iso) => new Date(`${iso}T16:00:00Z`);

describe('AUTONOMOUS_FLAGS.channels under the studio trim', () => {
  test('facebook and instagram drop, linkedin and gbp stay', () => {
    expect(Studio.AUTONOMOUS_FLAGS.channels).toEqual(['gbp']);
    process.env.SOCIAL_AUTONOMOUS_CHANNELS = 'gbp,facebook,instagram,linkedin';
    expect(Studio.AUTONOMOUS_FLAGS.channels).toEqual(['gbp', 'linkedin']);
    process.env.SOCIAL_AUTONOMOUS_CHANNELS = 'facebook,instagram';
    expect(Studio.AUTONOMOUS_FLAGS.channels).toEqual([]);
  });

  test('autonomousStatus reports the trimmed list', async () => {
    process.env.SOCIAL_AUTONOMOUS_CHANNELS = 'gbp,facebook,instagram,linkedin';
    const status = await Studio.autonomousStatus();
    expect(status.channels).toEqual(['gbp', 'linkedin']);
  });

  test('the manual paths still know every channel', () => {
    expect(Studio.CHANNELS).toEqual(['facebook', 'instagram', 'linkedin', 'gbp']);
    expect(Studio.normalizeChannels(['facebook', 'instagram', 'gbp'])).toEqual(['facebook', 'instagram', 'gbp']);
    expect(Studio.normalizeChannels(null)).toEqual(['facebook', 'instagram', 'linkedin', 'gbp']);
  });
});

describe('autonomous plans under the studio trim', () => {
  test('versus plan: drops Meta channels and Meta drafts', () => {
    process.env.SOCIAL_AUTONOMOUS_INCLUDE_VERSUS = 'true';
    process.env.SOCIAL_AUTONOMOUS_CHANNELS = 'gbp,facebook,instagram,linkedin';
    const day = etNoon('2026-06-10'); // versus fire day
    const on = Studio.selectAutonomousVersusPlan(day);
    expect(on.channels).toEqual(['gbp', 'linkedin']);
    expect(on.preview.inputs.channels).toEqual(['gbp', 'linkedin']);
    expect(Object.keys(on.preview.drafts).sort()).toEqual(['gbp', 'linkedin']);
  });

  test('milestone plan: carries no Meta channel or draft', () => {
    process.env.SOCIAL_AUTONOMOUS_CHANNELS = 'gbp,facebook,instagram,linkedin';
    const plan = Studio.planMilestone({
      threshold: 300, count: 312, average: 4.9, city: 'Venice', channels: Studio.AUTONOMOUS_FLAGS.channels,
    });
    expect(plan.channels).toEqual(['gbp', 'linkedin']);
    expect(Object.keys(plan.preview.drafts)).not.toEqual(expect.arrayContaining(['facebook']));
    expect(Object.keys(plan.preview.drafts)).not.toEqual(expect.arrayContaining(['instagram']));
  });

  test('campaign drafts and previewCampaign still serve Meta when a caller asks (manual path)', () => {
    const context = {
      location: { city: 'Sarasota', id: 'sarasota', name: 'Sarasota' },
      services: [], content: [], recentSocials: [], pestPressure: null, reviews: [],
      competitorPatterns: Studio.DEFAULT_COMPETITOR_PATTERNS,
    };
    const drafts = Studio.buildCampaignDrafts({
      topic: 'ants after rain', city: 'Sarasota', service: 'pest', angle: 'signs', cta: 'book inspection',
      channels: ['facebook', 'instagram', 'linkedin', 'gbp'],
    }, context);
    expect(Object.keys(drafts).sort()).toEqual(['facebook', 'gbp', 'instagram', 'linkedin']);
  });
});

describe('runAutonomous under the studio trim', () => {
  beforeEach(() => {
    process.env.SOCIAL_AUTONOMOUS_STUDIO_ENABLED = 'true';
  });

  test('only Meta channels requested: skipped and logged, nothing rendered or published', async () => {
    process.env.SOCIAL_AUTONOMOUS_CHANNELS = 'facebook,instagram';
    const out = await Studio.runAutonomous({ force: true });
    expect(out.skipped).toBe(true);
    expect(out.reason).toMatch(/studio trim removed every autonomous channel/);
    expect(SocialMediaService.publishToAll).not.toHaveBeenCalled();
    const logged = db.__state.inserted.filter((i) => i.table === 'social_content_studio_runs');
    expect(logged).toHaveLength(1);
    expect(logged[0].row.status).toBe('skipped');
    expect(JSON.parse(logged[0].row.channels)).toEqual([]);
  });
});

describe('approveAutonomousRun under the studio trim', () => {
  const draftRun = (extra = {}) => ({
    id: 'run-1',
    run_type: 'autonomous',
    status: 'draft_created',
    topic: 'Ant season',
    city: 'Sarasota',
    channels: JSON.stringify(['gbp', 'facebook', 'instagram', 'linkedin']),
    input: JSON.stringify({}),
    preview: JSON.stringify({
      inputs: { channels: ['gbp', 'facebook', 'instagram', 'linkedin'], city: 'Sarasota' },
      drafts: { gbp: 'g', facebook: 'f', instagram: 'i', linkedin: 'l' },
      visual: {
        imageUrl: 'https://cdn.example.com/a.png',
        variants: [{ type: 'image', imageUrl: 'https://cdn.example.com/a.png' }],
      },
    }),
    publish_result: null,
    ...extra,
  });

  test('a queued draft publishes to gbp and linkedin only', async () => {
    db.__state.run = draftRun();
    await Studio.approveAutonomousRun('run-1');
    const call = SocialMediaService.publishToAll.mock.calls[0][0];
    expect(call.channels).toEqual(['gbp', 'linkedin']);
  });

  test('a draft queued for Meta only has nothing to publish', async () => {
    db.__state.run = draftRun({ channels: JSON.stringify(['facebook', 'instagram']) });
    const out = await Studio.approveAutonomousRun('run-1');
    expect(out.ok).toBe(false);
    expect(out.status).toBe(400);
    expect(SocialMediaService.publishToAll).not.toHaveBeenCalled();
  });

  test('a queued video variant is refused (it can only post to Meta)', async () => {
    const run = draftRun();
    const preview = JSON.parse(run.preview);
    preview.visual.variants = [{ type: 'video', videoUrl: 'https://cdn.example.com/v.mp4' }, ...preview.visual.variants];
    run.preview = JSON.stringify(preview);
    db.__state.run = run;
    const out = await Studio.approveAutonomousRun('run-1', { variantIndex: 0 });
    expect(out.ok).toBe(false);
    expect(out.status).toBe(409);
    expect(SocialMediaService.publishToAll).not.toHaveBeenCalled();
  });
});
