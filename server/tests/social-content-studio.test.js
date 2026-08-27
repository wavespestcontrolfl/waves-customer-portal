const Studio = require('../services/social-content-studio');

describe('social content studio', () => {
  test('campaign drafts include local context without phone numbers in GBP copy', () => {
    const context = {
      location: { city: 'Sarasota', id: 'sarasota', name: 'Sarasota' },
      services: [{
        name: 'Termite Control',
        short_name: 'Termite',
        description: 'Termite swarmers are active in warm, humid Florida weather and can show up around windows, doors, and lights.',
      }],
      content: [{
        title: 'Termite swarm season in Sarasota',
        meta_description: 'Watch for discarded wings, mud tubes, and swarmers after humid evenings.',
      }],
      recentSocials: [],
      pestPressure: {
        explanation: 'Pest Pressure is a 0-5 score that estimates the current level of pest activity at your property.',
      },
      reviews: [],
      competitorPatterns: Studio.DEFAULT_COMPETITOR_PATTERNS,
    };

    const drafts = Studio.buildCampaignDrafts({
      topic: 'termite swarm season',
      city: 'Sarasota',
      service: 'termite',
      angle: 'what we are seeing',
      cta: 'book inspection',
      channels: ['facebook', 'instagram', 'linkedin', 'gbp'],
    }, context);

    expect(drafts.facebook).toContain('Sarasota');
    expect(drafts.gbp).toContain('Sarasota');
    expect(drafts.gbp).not.toMatch(/\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/);
    expect(Studio.validateDrafts(drafts).gbp.valid).toBe(true);
  });

  test('campaign drafts do not use unrelated service-library facts', () => {
    const context = {
      location: { city: 'Sarasota', id: 'sarasota', name: 'Sarasota' },
      services: [{
        name: 'Cockroach Control',
        short_name: 'Cockroach',
        description: 'Two-treatment cockroach control program.',
      }],
      content: [{
        title: 'Lawn fungus after rain in Sarasota',
        meta_description: 'Rain and humidity can increase turf disease pressure in Florida lawns.',
      }],
      recentSocials: [],
      pestPressure: null,
      reviews: [],
      competitorPatterns: Studio.DEFAULT_COMPETITOR_PATTERNS,
    };

    const drafts = Studio.buildCampaignDrafts({
      topic: 'lawn fungus after rain',
      city: 'Sarasota',
      service: 'lawn care',
      angle: 'signs to check',
      cta: 'read guide',
      channels: ['gbp', 'facebook'],
    }, context);

    expect(drafts.facebook).toContain('turf disease pressure');
    expect(drafts.facebook).not.toContain('cockroach');
    expect(drafts.gbp).not.toContain('cockroach');
  });

  test('campaignFactPack builds a grounded bullet list from context only', () => {
    const context = {
      location: { city: 'Sarasota', id: 'sarasota', name: 'Sarasota' },
      services: [{ name: 'Mosquito Control', short_name: 'Mosquito', description: 'Targeted mosquito control treats shady, humid resting spots.' }],
      content: [{ title: 'Mosquitoes after rain', meta_description: 'Standing water breeds mosquitoes fast.' }],
      recentSocials: [],
      pestPressure: { explanation: 'Pest Pressure estimates current activity (0-5).' },
      reviews: [],
      competitorPatterns: Studio.DEFAULT_COMPETITOR_PATTERNS,
    };
    const pack = Studio.campaignFactPack(context, { topic: 'mosquitoes after rain', service: 'mosquito', city: 'Sarasota' });
    expect(pack).toMatch(/^- /m);
    expect(pack).toContain('Targeted mosquito control treats shady, humid resting spots.');
    expect(pack).toContain('Pest Pressure estimates current activity (0-5).');
  });

  test('buildCampaignDraftsAI falls back to the deterministic template when AI is unavailable', async () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY; // force the no-AI path
    try {
      const context = {
        location: { city: 'Sarasota', id: 'sarasota', name: 'Sarasota' },
        services: [{ name: 'Cockroach Control', short_name: 'Cockroach', description: 'Two-treatment cockroach control program.' }],
        content: [{ title: 'Lawn fungus after rain in Sarasota', meta_description: 'Rain and humidity raise turf disease pressure.' }],
        recentSocials: [], pestPressure: null, reviews: [],
        competitorPatterns: Studio.DEFAULT_COMPETITOR_PATTERNS,
      };
      const input = { topic: 'lawn fungus after rain', city: 'Sarasota', service: 'lawn care', angle: 'signs to check', cta: 'read guide', channels: ['gbp', 'facebook'] };
      const ai = await Studio.buildCampaignDraftsAI(input, context);
      expect(ai).toEqual(Studio.buildCampaignDrafts(input, context));
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
  });

  test('review graphic candidate defaults to first name and city only', () => {
    const candidate = Studio.buildReviewGraphicCandidate({
      id: 'review-1',
      location_id: 'sarasota',
      reviewer_name: 'Jessica Smith',
      star_rating: 5,
      review_text: 'The Waves technician was helpful, explained the treatment, and took care of our ant issue quickly.',
      review_created_at: '2026-06-01T12:00:00Z',
    });

    expect(candidate.reviewerDisplayName).toBe('Jessica, Sarasota');
    expect(candidate.reviewerDisplayName).not.toContain('Smith');
    expect(candidate.reviewerPhotoAllowed).toBe(false);
    expect(candidate.caption).toContain('Google review');
  });

  test('anonymous and initials privacy modes do not expose full reviewer names', () => {
    expect(Studio.privacyDisplayName('Michael Johnson', 'Bradenton', 'anonymous')).toBe('Waves customer in Bradenton');
    expect(Studio.privacyDisplayName('Michael Johnson', 'Bradenton', 'initials')).toBe('M.J., Bradenton');
  });

  test('engagement score weights comments and shares above likes', () => {
    const score = Studio.engagementScore({
      likesCount: 10,
      commentsCount: 4,
      sharesCount: 3,
      viewsCount: 200,
    });

    expect(score).toBe(39);
  });

  test('fastest riser seeds include the direct Sarasota competitor', () => {
    const prodigy = Studio.FASTEST_RISER_PROFILES.find((profile) => profile.companyName === 'Prodigy Pest Solutions');
    expect(prodigy).toMatchObject({
      city: 'Sarasota',
      state: 'FL',
      growthPct: 52,
    });
  });

  test('campaign card payload uses source facts and CTA text', () => {
    const card = Studio.buildCampaignCardInput({
      topic: 'mosquito surge after afternoon storms',
      city: 'Bradenton',
      service: 'mosquito',
      cta: 'request estimate',
    }, {
      inputs: {
        topic: 'mosquito surge after afternoon storms',
        city: 'Bradenton',
        service: 'mosquito',
        cta: 'request estimate',
      },
      sources: [{
        type: 'service',
        label: 'Mosquito Control',
        detail: 'Mosquito pressure can climb after rain when standing water is left behind.',
      }],
      drafts: {},
    });

    expect(card).toMatchObject({
      variant: 'campaign',
      city: 'Bradenton',
      topic: 'mosquito surge after afternoon storms',
      cta: 'Request an estimate',
    });
    expect(card.detail).toContain('standing water');
  });

  test('autonomous run serializer exposes preview image and platform results', () => {
    const run = Studio.serializeAutonomousRun({
      id: 'run-1',
      run_type: 'autonomous',
      status: 'dry_run',
      mode: 'publish',
      topic: 'lawn fungus after rain',
      city: 'Sarasota',
      service: 'lawn care',
      channels: '["gbp","facebook"]',
      preview: JSON.stringify({
        inputs: { channels: ['gbp', 'facebook'], topic: 'lawn fungus after rain' },
        visual: { imageUrl: 'https://cdn.example.com/social-card.jpg' },
      }),
      publish_result: JSON.stringify({
        platforms: [{ platform: 'facebook', dryRun: true, content: 'Draft copy' }],
      }),
      social_media_post_id: 'post-1',
      post_title: 'lawn fungus after rain',
      post_status: 'dry_run',
      post_image_url: 'https://cdn.example.com/fallback.jpg',
      started_at: '2026-06-14T06:00:00Z',
      finished_at: '2026-06-14T06:00:02Z',
    });

    expect(run).toMatchObject({
      id: 'run-1',
      status: 'dry_run',
      topic: 'lawn fungus after rain',
      imageUrl: 'https://cdn.example.com/social-card.jpg',
      socialMediaPostId: 'post-1',
      post: {
        id: 'post-1',
        status: 'dry_run',
      },
    });
    expect(run.channels).toEqual(expect.arrayContaining(['gbp', 'facebook']));
    expect(run.platformResults[0]).toMatchObject({ platform: 'facebook', dryRun: true });
  });

  test('service intent keywords cover tree & shrub so campaign content ranks correctly', () => {
    // Regression for the missing tree/shrub group: a tree & shrub campaign
    // must be able to rank an ornamental/palm blog post ahead of city-only
    // matches in getCampaignContext.
    const kws = Studio.serviceIntentKeywords({ service: 'tree and shrub' });
    expect(kws).toEqual(expect.arrayContaining(['tree', 'shrub', 'ornamental', 'palm']));
    // A topic phrasing should resolve the same group.
    expect(Studio.serviceIntentKeywords({ topic: 'palm tree fungus' }))
      .toEqual(expect.arrayContaining(['tree', 'palm']));
    // Unrelated services must not pull in the tree group.
    expect(Studio.serviceIntentKeywords({ service: 'mosquito' })).not.toContain('shrub');
  });

  test('normalizeChannels fails closed: omitted → all, explicit-empty/invalid → none', () => {
    expect(Studio.normalizeChannels(undefined).sort()).toEqual([...Studio.CHANNELS].sort());
    expect(Studio.normalizeChannels(null).sort()).toEqual([...Studio.CHANNELS].sort());
    expect(Studio.normalizeChannels(['gbp', 'facebook'])).toEqual(['gbp', 'facebook']);
    expect(Studio.normalizeChannels(['GBP ', 'Instagram'])).toEqual(['gbp', 'instagram']);
    expect(Studio.normalizeChannels([])).toEqual([]);                 // explicit empty → none, not all
    expect(Studio.normalizeChannels(['myspace'])).toEqual([]);        // all-invalid → none
    expect(Studio.normalizeChannels('facebook')).toEqual([]);         // non-array → none
  });

  test('AUTONOMOUS_FLAGS.channels: unset → defaults, blank → none (fail closed)', () => {
    const orig = process.env.SOCIAL_AUTONOMOUS_CHANNELS;
    try {
      delete process.env.SOCIAL_AUTONOMOUS_CHANNELS;
      expect(Studio.AUTONOMOUS_FLAGS.channels.slice().sort()).toEqual(['facebook', 'gbp', 'instagram']);
      process.env.SOCIAL_AUTONOMOUS_CHANNELS = '   ';        // blanked to stop output
      expect(Studio.AUTONOMOUS_FLAGS.channels).toEqual([]);
      process.env.SOCIAL_AUTONOMOUS_CHANNELS = 'gbp, facebook';
      expect(Studio.AUTONOMOUS_FLAGS.channels).toEqual(['gbp', 'facebook']);
    } finally {
      if (orig === undefined) delete process.env.SOCIAL_AUTONOMOUS_CHANNELS;
      else process.env.SOCIAL_AUTONOMOUS_CHANNELS = orig;
    }
  });

  test('AUTONOMOUS_FLAGS.intervalHours clamps to 22h (below the spring-forward ET tick gap)', () => {
    const orig = process.env.SOCIAL_AUTONOMOUS_INTERVAL_HOURS;
    try {
      delete process.env.SOCIAL_AUTONOMOUS_INTERVAL_HOURS;
      expect(Studio.AUTONOMOUS_FLAGS.intervalHours).toBe(20); // default
      process.env.SOCIAL_AUTONOMOUS_INTERVAL_HOURS = '24';
      expect(Studio.AUTONOMOUS_FLAGS.intervalHours).toBe(22); // stale 24 -> capped (DST-safe)
      process.env.SOCIAL_AUTONOMOUS_INTERVAL_HOURS = '23';
      expect(Studio.AUTONOMOUS_FLAGS.intervalHours).toBe(22); // 23 would skip the spring-forward day
      process.env.SOCIAL_AUTONOMOUS_INTERVAL_HOURS = '12';
      expect(Studio.AUTONOMOUS_FLAGS.intervalHours).toBe(12); // under cap preserved
    } finally {
      if (orig === undefined) delete process.env.SOCIAL_AUTONOMOUS_INTERVAL_HOURS;
      else process.env.SOCIAL_AUTONOMOUS_INTERVAL_HOURS = orig;
    }
  });

  test('httpUrlOrNull accepts only http(s) absolute URLs', () => {
    expect(Studio.httpUrlOrNull('https://example.com/post/123')).toBe('https://example.com/post/123');
    expect(Studio.httpUrlOrNull('http://example.com')).toBe('http://example.com');
    // XSS / non-web schemes and junk fail closed to null.
    expect(Studio.httpUrlOrNull('javascript:alert(1)')).toBeNull();
    expect(Studio.httpUrlOrNull('data:text/html,<script>')).toBeNull();
    expect(Studio.httpUrlOrNull('/relative/path')).toBeNull();
    expect(Studio.httpUrlOrNull('not a url')).toBeNull();
    expect(Studio.httpUrlOrNull('')).toBeNull();
    expect(Studio.httpUrlOrNull(null)).toBeNull();
  });

  test('normalizePublishMode fails closed: invalid mode → draft, blank → default', () => {
    expect(Studio.normalizePublishMode('publish')).toBe('publish');
    expect(Studio.normalizePublishMode('Draft ')).toBe('draft');           // trim + lowercase
    expect(Studio.normalizePublishMode('blast', 'publish')).toBe('draft');  // typo → fail closed
    expect(Studio.normalizePublishMode('', 'publish')).toBe('publish');     // blank → default
    expect(Studio.normalizePublishMode(undefined, 'draft')).toBe('draft');  // unset → fallback
  });
});

describe('assessApprovalPublish (approval retry semantics)', () => {
  const CHANNELS = ['gbp', 'facebook', 'instagram'];

  test('image approval: any platform success is complete (unchanged rule)', () => {
    const a = Studio.assessApprovalPublish({
      isVideoVariant: false,
      channels: CHANNELS,
      priorPlatforms: [],
      current: { success: true, platforms: [{ platform: 'gbp', location: 'sarasota', success: true }] },
    });
    expect(a.complete).toBe(true);
  });

  test('video approval: GBP-only success does not finalize (no video posted)', () => {
    const a = Studio.assessApprovalPublish({
      isVideoVariant: true,
      channels: CHANNELS,
      priorPlatforms: [],
      current: {
        success: true,
        platforms: [
          { platform: 'gbp', location: 'sarasota', success: true },
          { platform: 'facebook', success: false, error: 'video API 500' },
          { platform: 'instagram', success: false, error: 'container timeout' },
        ],
      },
    });
    expect(a.videoPosted).toBe(false);
    expect(a.complete).toBe(false);
  });

  test('video approval: FB video posted but IG failed stays incomplete (retryable for IG)', () => {
    const a = Studio.assessApprovalPublish({
      isVideoVariant: true,
      channels: CHANNELS,
      priorPlatforms: [],
      current: {
        success: true,
        platforms: [
          { platform: 'facebook', success: true, mediaType: 'video' },
          { platform: 'instagram', success: false, error: 'container timeout' },
        ],
      },
    });
    expect(a.videoPosted).toBe(true);
    expect(a.videoBlocked).toBe(true);
    expect(a.complete).toBe(false);
  });

  test('video approval: a SKIPPED (unconfigured) Meta channel does not block', () => {
    const a = Studio.assessApprovalPublish({
      isVideoVariant: true,
      channels: CHANNELS,
      priorPlatforms: [],
      current: {
        success: true,
        platforms: [
          { platform: 'facebook', success: true, mediaType: 'video' },
          { platform: 'instagram', skipped: 'Disabled' },
        ],
      },
    });
    expect(a.complete).toBe(true);
  });

  test('retry merge: prior FB video success + current IG Reel success completes', () => {
    const a = Studio.assessApprovalPublish({
      isVideoVariant: true,
      channels: CHANNELS,
      priorPlatforms: [
        { platform: 'facebook', success: true, mediaType: 'video' },
        { platform: 'instagram', success: false, error: 'container timeout' },
        { platform: 'gbp', location: 'sarasota', success: true },
      ],
      current: { success: true, platforms: [{ platform: 'instagram', success: true, mediaType: 'reel' }] },
    });
    expect(a.complete).toBe(true);
    // merged record carries the prior successes plus this attempt
    const merged = a.mergedPublishResult.platforms;
    expect(merged.filter((p) => p.success)).toHaveLength(3);
    // prior FAILURES are not re-recorded (only successes carry forward)
    expect(merged.some((p) => p.error === 'container timeout')).toBe(false);
  });

  test('prior dry-run entries never count as posted', () => {
    const a = Studio.assessApprovalPublish({
      isVideoVariant: true,
      channels: CHANNELS,
      priorPlatforms: [
        { platform: 'facebook', success: false, dryRun: true },
        { platform: 'instagram', success: false, dryRun: true },
      ],
      current: { success: false, platforms: [] },
    });
    expect(a.success).toBe(false);
    expect(a.complete).toBe(false);
  });
});

describe('assessApprovalPublish (round 5: unresolved channels block)', () => {
  const CHANNELS = ['gbp', 'facebook', 'instagram'];

  test('a global-skip retry (automation paused) cannot finalize a half-posted video', () => {
    const a = Studio.assessApprovalPublish({
      isVideoVariant: true,
      channels: CHANNELS,
      priorPlatforms: [
        { platform: 'facebook', success: true, mediaType: 'video' },
        { platform: 'instagram', success: false, error: 'container timeout' },
      ],
      // publishToAll under a paused/disabled gate returns ONE global row —
      // no per-channel entries — and prior failures are not carried forward.
      current: { success: false, platforms: [{ platform: 'all', skipped: 'Automation is paused' }] },
    });
    expect(a.success).toBe(true); // the FB video is genuinely live
    expect(a.videoPosted).toBe(true);
    expect(a.videoBlocked).toBe(true); // instagram is unresolved, not skipped
    expect(a.complete).toBe(false);
  });

  test('a requested Meta channel with no entry at all keeps the run retryable', () => {
    const a = Studio.assessApprovalPublish({
      isVideoVariant: true,
      channels: CHANNELS,
      priorPlatforms: [{ platform: 'facebook', success: true, mediaType: 'video' }],
      current: { success: false, platforms: [] },
    });
    expect(a.complete).toBe(false);
  });
});

describe('autonomous versus lane (pest showdown)', () => {
  // ET noon on the given date keeps the ET calendar day equal to the UTC day.
  const etNoon = (iso) => new Date(`${iso}T16:00:00Z`);

  // Snapshot/restore the flag so a caller running with
  // SOCIAL_AUTONOMOUS_INCLUDE_VERSUS=true (e.g. validating an enabled deploy)
  // neither fails the dark-by-default test nor loses its setting.
  let prevVersusFlag;
  beforeAll(() => {
    prevVersusFlag = process.env.SOCIAL_AUTONOMOUS_INCLUDE_VERSUS;
  });
  beforeEach(() => {
    delete process.env.SOCIAL_AUTONOMOUS_INCLUDE_VERSUS;
  });
  afterAll(() => {
    if (prevVersusFlag === undefined) delete process.env.SOCIAL_AUTONOMOUS_INCLUDE_VERSUS;
    else process.env.SOCIAL_AUTONOMOUS_INCLUDE_VERSUS = prevVersusFlag;
  });

  test('lane is dark by default (flag unset -> no versus plan)', () => {
    expect(Studio.selectAutonomousVersusPlan(etNoon('2026-06-10'))).toBeNull();
  });

  test('fires only on ET days with day % 4 === 2 when enabled', () => {
    process.env.SOCIAL_AUTONOMOUS_INCLUDE_VERSUS = 'true';
    expect(Studio.selectAutonomousVersusPlan(etNoon('2026-06-08'))).toBeNull(); // review lane day
    expect(Studio.selectAutonomousVersusPlan(etNoon('2026-06-09'))).toBeNull();
    const plan = Studio.selectAutonomousVersusPlan(etNoon('2026-06-10'));
    expect(plan).not.toBeNull();
    expect(plan.versusPair).toBeDefined();
    expect(plan.angle).toBe('pest showdown');
    expect(plan.topic).toBe(`${plan.versusPair.left.name} vs ${plan.versusPair.right.name}`);
    expect(plan.preview.drafts.gbp).toContain(plan.city);
    expect(plan.preview.drafts.gbp).not.toMatch(/\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/);
    // "Schedule an inspection" CTA → the booking flow, never the blog index.
    expect(plan.preview.suggestedLink).toBe('https://www.wavespestcontrol.com/book/');
  });

  test('every pair in the bank produces drafts that pass the compliance validators', () => {
    for (const pair of Studio.PEST_VERSUS_PAIRS) {
      const drafts = Studio.buildVersusDrafts(pair, 'Sarasota');
      const validation = Studio.validateDrafts(drafts);
      for (const [platform, result] of Object.entries(validation)) {
        expect({ pair: pair.key, platform, issues: result.issues || [], valid: result.valid })
          .toEqual({ pair: pair.key, platform, issues: [], valid: true });
      }
      expect(drafts.facebook).toContain(pair.left.name);
      expect(drafts.facebook).toContain(pair.right.name);
      // GBP may publish text-only (media retry), so BOTH pests' facts must be in the copy.
      expect(drafts.gbp).toContain(`${pair.left.name}: `);
      expect(drafts.gbp).toContain(`${pair.right.name}: `);
      expect(drafts.instagram).toContain('#wavespestcontrol');
    }
  });

  test('versus card input renders through the split-panel variant', () => {
    const pair = Studio.PEST_VERSUS_PAIRS[0];
    const card = Studio.buildVersusCardInput(pair, { city: 'Venice', service: pair.service });
    expect(card.variant).toBe('versus');
    expect(card.left.name).toBe(pair.left.name);
    expect(card.verdict).toBe(pair.verdict);
  });
});

describe('autonomous review-milestone lane', () => {
  let prevFlag;
  beforeAll(() => { prevFlag = process.env.SOCIAL_AUTONOMOUS_INCLUDE_MILESTONES; });
  beforeEach(() => { delete process.env.SOCIAL_AUTONOMOUS_INCLUDE_MILESTONES; });
  afterAll(() => {
    if (prevFlag === undefined) delete process.env.SOCIAL_AUTONOMOUS_INCLUDE_MILESTONES;
    else process.env.SOCIAL_AUTONOMOUS_INCLUDE_MILESTONES = prevFlag;
  });

  test('threshold ladder: 50s to 500, 250s to 2000, 500s to 5000, then 1000s', () => {
    expect(Studio.milestoneThresholdFor(0)).toBeNull();
    expect(Studio.milestoneThresholdFor(49)).toBeNull();
    expect(Studio.milestoneThresholdFor(50)).toBe(50);
    expect(Studio.milestoneThresholdFor(149)).toBe(100);
    expect(Studio.milestoneThresholdFor(499)).toBe(450);
    expect(Studio.milestoneThresholdFor(500)).toBe(500);
    expect(Studio.milestoneThresholdFor(1999)).toBe(1750);
    expect(Studio.milestoneThresholdFor(2000)).toBe(2000);
    expect(Studio.milestoneThresholdFor(4999)).toBe(4500);
    expect(Studio.milestoneThresholdFor(15250)).toBe(15000);
    expect(Studio.MILESTONE_WINDOW).toBe(30);
  });

  test('lane is dark by default (flag unset -> no plan, no DB read)', async () => {
    await expect(Studio.selectAutonomousMilestonePlan(new Date('2026-06-10T16:00:00Z'))).resolves.toBeNull();
  });

  test('milestone drafts pass the compliance validators, with and without an average', () => {
    for (const [threshold, average] of [[50, 5], [300, 4.9], [1000, null], [2500, 4.7]]) {
      const drafts = Studio.buildMilestoneDrafts({ threshold, average });
      const validation = Studio.validateDrafts(drafts);
      for (const [platform, result] of Object.entries(validation)) {
        expect({ threshold, platform, issues: result.issues, valid: result.valid })
          .toEqual({ threshold, platform, issues: [], valid: true });
      }
      const label = threshold.toLocaleString('en-US');
      expect(drafts.facebook).toContain(`${label} Google reviews`);
      expect(drafts.gbp).toContain(label);
      if (average) expect(drafts.gbp).toContain(`${average.toFixed(1)} stars`);
      else expect(drafts.gbp).not.toContain('Average rating');
    }
  });

  test('fleetReviewStats: authoritative Places totals, fail closed on a partial/stale fleet', () => {
    const now = Date.parse('2026-06-10T16:00:00Z');
    const fresh = new Date(now - 60 * 60 * 1000).toISOString();
    const stale = new Date(now - 30 * 60 * 60 * 1000).toISOString();
    const locs = [{ id: 'sarasota' }, { id: 'venice' }];
    const row = (location_id, payload, synced_at = fresh) => ({ location_id, review_text: JSON.stringify(payload), synced_at });

    // Complete + fresh: sum of totals, rating WEIGHTED by review count.
    expect(Studio.fleetReviewStats([row('sarasota', { rating: 4.9, totalReviews: 200 }), row('venice', { rating: 4.7, totalReviews: 112 })], locs, now))
      .toEqual({ count: 312, average: 4.8 });
    // A tiny 5.0 location cannot lift a large 4.0 one (unweighted would say 4.5).
    expect(Studio.fleetReviewStats([row('sarasota', { rating: 4.0, totalReviews: 300 }), row('venice', { rating: 5.0, totalReviews: 10 })], locs, now))
      .toEqual({ count: 310, average: 4.0 });
    // Missing location → null (never a partial total).
    expect(Studio.fleetReviewStats([row('sarasota', { rating: 4.9, totalReviews: 200 })], locs, now)).toBeNull();
    // Stale row → null.
    expect(Studio.fleetReviewStats([row('sarasota', { rating: 4.9, totalReviews: 200 }), row('venice', { rating: 4.7, totalReviews: 112 }, stale)], locs, now)).toBeNull();
    // Corrupt / rating-only payload does not count the location complete.
    expect(Studio.fleetReviewStats([row('sarasota', { rating: 4.9, totalReviews: 200 }), { location_id: 'venice', review_text: '"corrupt"', synced_at: fresh }], locs, now)).toBeNull();
    expect(Studio.fleetReviewStats([row('sarasota', { rating: 4.9, totalReviews: 200 }), row('venice', { rating: 4.7 })], locs, now)).toBeNull();
    // Rows for unconfigured locations are ignored; no ratings → average null, never an invented 5.0.
    expect(Studio.fleetReviewStats([row('sarasota', { totalReviews: 50 }), row('venice', { totalReviews: 10 }), row('retired', { rating: 5, totalReviews: 999 })], locs, now))
      .toEqual({ count: 60, average: null });
    // A location WITH reviews but no rating hides the whole average (a partial
    // "5.0" from the other location would not describe the fleet)...
    expect(Studio.fleetReviewStats([row('sarasota', { totalReviews: 300 }), row('venice', { rating: 5.0, totalReviews: 10 })], locs, now))
      .toEqual({ count: 310, average: null });
    // ...while a zero-review location without a rating does not.
    expect(Studio.fleetReviewStats([row('sarasota', { totalReviews: 0 }), row('venice', { rating: 4.6, totalReviews: 10 })], locs, now))
      .toEqual({ count: 10, average: 4.6 });
  });

  test('milestoneDrift blocks a stored plan the current stats no longer support', () => {
    const plan = { milestone: 300, averageRating: 4.9 };
    expect(Studio.milestoneDrift(plan, { count: 312, average: 4.9 })).toBeNull();
    expect(Studio.milestoneDrift(plan, null)).toMatch(/unavailable/);
    expect(Studio.milestoneDrift(plan, { count: 298, average: 4.9 })).toMatch(/no longer matches/); // reviews removed
    expect(Studio.milestoneDrift(plan, { count: 330, average: 4.9 })).toMatch(/past the 300 milestone window/);
    expect(Studio.milestoneDrift(plan, { count: 355, average: 4.9 })).toMatch(/no longer matches/); // next rung
    expect(Studio.milestoneDrift(plan, { count: 312, average: 4.8 })).toMatch(/average rating changed/);
    expect(Studio.milestoneDrift({ milestone: 300, averageRating: null }, { count: 312, average: null })).toBeNull();
  });

  test('planMilestone carries the claim key and a grounded source', () => {
    const plan = Studio.planMilestone({ threshold: 300, count: 312, average: 4.9, city: 'Venice', channels: ['gbp', 'facebook'] });
    expect(plan.milestone).toBe(300);
    expect(plan.angle).toBe('review milestone');
    expect(plan.topic).toBe('300 Google reviews');
    expect(Object.keys(plan.preview.drafts).sort()).toEqual(['facebook', 'gbp']);
    expect(plan.preview.suggestedLink).toBe('https://www.wavespestcontrol.com/reviews/');
    expect(plan.preview.sources[0].label).toContain('312 Google-reported reviews');
    const card = Studio.buildMilestoneCardInput(plan);
    expect(card).toMatchObject({ variant: 'milestone', count: 300, averageRating: 4.9 });
  });
});
