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

  // Every ET fire day (day % 4 === 2) of the given month.
  const fireDays = (yearMonth) =>
    [2, 6, 10, 14, 18, 22, 26, 30].map((d) => etNoon(`${yearMonth}-${String(d).padStart(2, '0')}`));

  test('the same card never publishes twice in one month (pair AND city both rotate)', () => {
    process.env.SOCIAL_AUTONOMOUS_INCLUDE_VERSUS = 'true';
    // Aug 2026 was the regression: day % 4 aliased city to Sarasota on every
    // fire and hid half the pair bank, publishing the identical termite-swarmer
    // card on Aug 6, 18, and 30. June exercises the ungated (6-pair) bank.
    for (const yearMonth of ['2026-08', '2026-06']) {
      // Out-of-season slots yield null (the campaign lane takes those days).
      const plans = fireDays(yearMonth).map((d) => Studio.selectAutonomousVersusPlan(d)).filter(Boolean);
      const cards = plans.map((p) => `${p.versusPair.key}|${p.city}`);
      expect(new Set(cards).size).toBe(cards.length);
      expect(new Set(plans.map((p) => p.city)).size).toBeGreaterThan(1);
      // No pair repeats inside a month either (8 fires against a 24-pair bank).
      expect(new Set(plans.map((p) => p.versusPair.key)).size).toBe(plans.length);
    }
  });

  test('every pair+city combination is walked before any card repeats, across short months', () => {
    process.env.SOCIAL_AUTONOMOUS_INCLUDE_VERSUS = 'true';
    // The sequence counts days that actually fire, not a fixed 8 slots/month:
    // February has no 30th, so reserving a phantom slot skipped a sequence
    // value and shortened the cycle — 2026-02-02 and 2026-05-02 both produced
    // chinch-bug|Sarasota, 23 fires apart instead of 24 (Codex finding).
    // Walk two full years of real fire days, ignoring the season gate so the
    // underlying rotation is measured rather than the gated subset.
    const cards = [];
    for (let y = 2026; y <= 2027; y++) {
      for (let m = 1; m <= 12; m++) {
        const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
        for (const d of [2, 6, 10, 14, 18, 22, 26, 30].filter((x) => x <= lastDay)) {
          const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
          const plan = Studio.selectAutonomousVersusPlan(etNoon(iso));
          // Out-of-season slots return null but still consume a sequence step.
          cards.push(plan ? `${plan.versusPair.key}|${plan.city}` : null);
        }
      }
    }
    const combos = Studio.SHOWDOWN_BANK.length * 4; // 44 cards x 4 cities
    const lastSeen = new Map();
    let minGap = Infinity;
    cards.forEach((c, i) => {
      if (c === null) return;
      if (lastSeen.has(c)) minGap = Math.min(minGap, i - lastSeen.get(c));
      lastSeen.set(c, i);
    });
    expect(minGap).toBe(combos); // 96 fires between identical cards, never fewer
  });

  test('cards stay unique across a season boundary (fixed modulus, no remapping)', () => {
    process.env.SOCIAL_AUTONOMOUS_INCLUDE_VERSUS = 'true';
    // Regression per Codex review: filtering the bank before the modulo
    // shifted the surviving indices in July, replaying June's exact cards
    // within 14 days (2027-06-18 and 2027-07-02 both gave chinch-bug for
    // Lakewood Ranch). The swarmer's July slot must yield to the campaign
    // lane, not remap the sequence.
    // With a 24-pair bank a gated pair's slot lands roughly once a quarter,
    // so walk a whole year: every season boundary is crossed, at least one
    // out-of-season slot yields, and no card repeats inside the year (a year
    // has ~95 fires, under the 96-fire cycle).
    const plans = [];
    for (let m = 1; m <= 12; m++) {
      const lastDay = new Date(Date.UTC(2027, m, 0)).getUTCDate(); // Feb has no 30th
      for (const d of [2, 6, 10, 14, 18, 22, 26, 30].filter((x) => x <= lastDay)) {
        plans.push(Studio.selectAutonomousVersusPlan(etNoon(`2027-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`)));
      }
    }
    expect(plans.some((p) => p === null)).toBe(true); // out-of-season slots skipped
    const cards = plans.filter(Boolean).map((p) => `${p.versusPair.key}|${p.city}`);
    expect(new Set(cards).size).toBe(cards.length);
  });

  test('season-gated pairs stay out of off-season months, at selection AND approval', () => {
    process.env.SOCIAL_AUTONOMOUS_INCLUDE_VERSUS = 'true';
    // Gated pairs (swarmer Feb–Jun, webworm May–Oct) never surface outside
    // their months, and each is still reachable in season — checked across
    // two years so every gated pair's slot lands both in and out of season.
    const gated = Studio.PEST_VERSUS_PAIRS.filter((p) => Array.isArray(p.months));
    expect(gated.map((p) => p.key)).toContain('termite_swarmer_vs_winged_ant');
    const inSeasonHits = new Set();
    for (let y = 2026; y <= 2027; y++) {
      for (let m = 1; m <= 12; m++) {
        for (const plan of fireDays(`${y}-${String(m).padStart(2, '0')}`).map((d) => Studio.selectAutonomousVersusPlan(d)).filter(Boolean)) {
          const pair = gated.find((p) => p.key === plan.versusPair.key);
          if (!pair) continue;
          expect({ key: pair.key, month: m, inSeason: pair.months.includes(m) }).toEqual({ key: pair.key, month: m, inSeason: true });
          inSeasonHits.add(pair.key);
        }
      }
    }
    expect([...inSeasonHits].sort()).toEqual(gated.map((p) => p.key).sort());

    // A draft created in season must not be APPROVABLE out of season — the
    // stored versusPair is re-checked against the current ET month.
    const swarmer = Studio.PEST_VERSUS_PAIRS.find((p) => p.key === 'termite_swarmer_vs_winged_ant');
    expect(Studio.versusPublishBlocker({ versusPair: swarmer }, etNoon('2026-08-14'))).toMatch(/out of season/);
    expect(Studio.versusPublishBlocker({ versusPair: swarmer }, etNoon('2026-03-14'))).toBeNull();
    // Ungated pairs and non-versus drafts are never blocked.
    expect(Studio.versusPublishBlocker({ versusPair: Studio.PEST_VERSUS_PAIRS[0] }, etNoon('2026-08-14'))).toBeNull();
    expect(Studio.versusPublishBlocker({}, etNoon('2026-08-14'))).toBeNull();
  });

  test('approval gate reads seasonality from the canonical bank, not the stored snapshot', () => {
    // run.input is a JSON snapshot frozen at selection: a draft created before
    // `months` existed stores a pair object WITHOUT it. Trusting that snapshot
    // let a June swarmer draft publish in August (Codex finding); the guard
    // resolves the pair by key against PEST_VERSUS_PAIRS instead.
    const legacyDraft = {
      versusPair: {
        key: 'termite_swarmer_vs_winged_ant',
        service: 'termite',
        left: { name: 'Termite Swarmer', points: ['Straight antennae'] },
        right: { name: 'Winged Ant', points: ['Bent antennae'] },
        verdict: 'Wings on the windowsill? Check the waist first.',
      },
    };
    expect(legacyDraft.versusPair.months).toBeUndefined(); // pre-`months` snapshot
    expect(Studio.versusPublishBlocker(legacyDraft, etNoon('2026-08-14'))).toMatch(/out of season/);
    expect(Studio.versusPublishBlocker(legacyDraft, etNoon('2026-03-14'))).toBeNull();
    // A snapshot claiming a season the bank does not grant cannot self-approve.
    const forgedDraft = { versusPair: { key: 'termite_swarmer_vs_winged_ant', months: [8] } };
    expect(Studio.versusPublishBlocker(forgedDraft, etNoon('2026-08-14'))).toMatch(/out of season/);
    // An unrecognized key (pair retired from the bank) is not blocked here.
    expect(Studio.versusPublishBlocker({ versusPair: { key: 'gone_from_bank' } }, etNoon('2026-08-14'))).toBeNull();
  });

  test('the season is evaluated at publish time, so a run crossing ET midnight is caught', () => {
    // Direct-publish mode renders and uploads between selection and publish
    // (Codex finding): a run selected at 23:58 ET Jun 30 can reach the
    // pre-publish gate after ET midnight, and must not post a swarmer card
    // in July. The blocker takes `now` so both call sites evaluate the
    // CURRENT month rather than the selection month.
    const swarmer = Studio.PEST_VERSUS_PAIRS.find((p) => p.key === 'termite_swarmer_vs_winged_ant');
    const plan = { versusPair: swarmer };
    // 23:58 ET Jun 30 2026 = 03:58 UTC Jul 1 — still June in ET, publishable.
    expect(Studio.versusPublishBlocker(plan, new Date('2026-07-01T03:58:00Z'))).toBeNull();
    // 00:02 ET Jul 1 2026 = 04:02 UTC — now July in ET, blocked.
    expect(Studio.versusPublishBlocker(plan, new Date('2026-07-01T04:02:00Z'))).toMatch(/out of season/);
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

  test('milestoneClaimDisposition: publish → published; nothing attempted → release; attempted failure → retain', () => {
    const d = Studio.milestoneClaimDisposition;
    expect(d({ success: true, platforms: [{ platform: 'facebook', success: true }] })).toBe('published');
    expect(d({ success: false, platforms: [{ platform: 'gbp', success: false, error: 'x' }, { platform: 'instagram', success: true }] })).toBe('published');
    // Empty channel set (blank SOCIAL_AUTONOMOUS_CHANNELS) → nothing reached a provider.
    expect(d({ success: false, platforms: [] })).toBe('release');
    expect(d(undefined)).toBe('release');
    // Every entry skipped before an external call (paused / disabled / judge).
    expect(d({ success: false, platforms: [{ platform: 'all', skipped: 'Automation is paused' }] })).toBe('release');
    expect(d({ success: false, platforms: [{ platform: 'facebook', success: false, skipped: true, error: 'Compliance judge: x' }] })).toBe('release');
    // Attempted and failed (or lost response) → keep ownership.
    expect(d({ success: false, platforms: [{ platform: 'facebook', success: false, error: 'ETIMEDOUT' }] })).toBe('retain');
    expect(d({ success: false, platforms: [{ platform: 'gbp', skipped: 'Disabled' }, { platform: 'facebook', success: false, error: '500' }] })).toBe('retain');
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
    expect(plan.preview.suggestedLink).toBe('https://www.wavespestcontrol.com/pest-control-reviews/');
    expect(plan.preview.sources[0].label).toContain('312 Google-reported reviews');
    const card = Studio.buildMilestoneCardInput(plan);
    expect(card).toMatchObject({ variant: 'milestone', count: 300, averageRating: 4.9 });
  });
});

describe('studio link gate (live-only, topic-matched, probed)', () => {
  const live = { title: 'Your Parrish Garage Door Seal Is Letting In More Roaches', slug: 'parrish-garage-door-seal-roach-entry', astro_live_url: 'https://www.wavespestcontrol.com/pest-control/garage-door-seal-roaches-parrish-fl/' };
  const legacy = { title: 'Legacy row', slug: 'parrish-garage-door-seal-roach-entry', astro_status: 'draft', astro_live_url: null };

  test('liveUrlForRow never rebuilds a URL from slug — only the pages-poll live URL counts', () => {
    // The 2026-08-29 regression: a status=published row with a planned-era
    // slug and no astro_live_url produced /parrish-garage-door-seal-roach-entry/ → 404.
    expect(Studio.liveUrlForRow(legacy)).toBeNull();
    expect(Studio.liveUrlForRow(live)).toBe(live.astro_live_url);
    expect(Studio.liveUrlForRow({ astro_live_url: 'javascript:alert(1)' })).toBeNull();
  });

  test('suggestedLink / suggestedLinkTitle read the chosen link page, and are empty without one', () => {
    expect(Studio.suggestedLink({ content: [legacy], linkPage: null })).toBe('');
    expect(Studio.suggestedLinkTitle({ content: [legacy], linkPage: null })).toBe('');
    expect(Studio.suggestedLink({ content: [live], linkPage: live })).toBe(live.astro_live_url);
    expect(Studio.suggestedLinkTitle({ content: [live], linkPage: live })).toBe(live.title);
  });

  test('firstLivePage skips dead pages, is bounded, and fails closed to no link', async () => {
    const dead = { ...live, astro_live_url: 'https://www.wavespestcontrol.com/retired-post/' };
    const probed = [];
    const probe = async (url) => { probed.push(url); return url === live.astro_live_url; };
    expect(await Studio.firstLivePage([legacy, dead, live], probe)).toBe(live);
    expect(probed.sort()).toEqual([dead.astro_live_url, live.astro_live_url].sort()); // legacy row never probed (no live URL); probes run in parallel
    // Rank order wins even when a later candidate answers first.
    const slowLive = { ...live, astro_live_url: 'https://www.wavespestcontrol.com/slow-but-first/' };
    const raced = async (url) => { if (url === slowLive.astro_live_url) await new Promise((r) => setTimeout(r, 20)); return true; };
    expect(await Studio.firstLivePage([slowLive, live], raced)).toBe(slowLive);
    // Four dead candidates: only the first three are probed, result is null.
    const many = [1, 2, 3, 4].map((n) => ({ ...live, astro_live_url: `https://www.wavespestcontrol.com/dead-${n}/` }));
    probed.length = 0;
    expect(await Studio.firstLivePage(many, async (url) => { probed.push(url); return false; })).toBeNull();
    expect(probed).toHaveLength(3);
  });

  test('linkIsLive probes only wavespestcontrol.com and treats any failure as dead', async () => {
    const ok = async (url) => ({ ok: true, status: 200, url });
    const notFound = async () => ({ ok: false, status: 404 });
    const boom = async () => { throw new Error('ECONNRESET'); };
    expect(await Studio.linkIsLive('https://www.wavespestcontrol.com/book/', ok)).toBe(true);
    expect(await Studio.linkIsLive('https://www.wavespestcontrol.com/parrish-garage-door-seal-roach-entry/', notFound)).toBe(false);
    expect(await Studio.linkIsLive('https://www.wavespestcontrol.com/book/', boom)).toBe(false);
    expect(await Studio.linkIsLive('https://evil.example.com/', ok)).toBe(false); // never probed off-domain
    expect(await Studio.linkIsLive('', ok)).toBe(false);
  });

  test('linkIsLive never follows redirects — a retired path that 301s elsewhere is dead', async () => {
    const page = 'https://www.wavespestcontrol.com/pest-control/garage-door-seal-roaches-parrish-fl/';
    const calls = [];
    // With redirect:'manual' a 301 comes back as a non-ok response — the
    // server never requests the Location target (homepage, another post, or
    // an off-domain host).
    const redirecting = async (url, opts) => { calls.push(opts.redirect); return { ok: false, status: 301, headers: new Map([['location', 'https://evil.example.com/']]) }; };
    expect(await Studio.linkIsLive('https://www.wavespestcontrol.com/retired-post/', redirecting)).toBe(false);
    expect(calls).toEqual(['manual']);
    expect(await Studio.linkIsLive(page, async () => ({ ok: true, status: 200 }))).toBe(true);
    // The response body is released (socket returned to the pool) once the status is read.
    const cancel = jest.fn(async () => {});
    expect(await Studio.linkIsLive(page, async () => ({ ok: true, status: 200, body: { cancel } }))).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

describe('studio link relevance + legacy-card alert predicates', () => {
  test('rowMatchesIntentKeywords matches pest names as word prefixes, not bare substrings', () => {
    const kws = Studio.serviceIntentKeywords({ topic: 'ants and roaches after heavy rain', service: 'general pest' });
    expect(kws).toEqual(expect.arrayContaining(['ant', 'ants', 'roach']));
    expect(Studio.rowMatchesIntentKeywords({ title: 'Your Parrish Garage Door Seal Is Letting In More Roaches' }, kws)).toBe(true);
    expect(Studio.rowMatchesIntentKeywords({ title: 'Ant-proofing a Sarasota kitchen' }, kws)).toBe(true);
    // The wrong-topic regression: 'important', 'plant', 'giant' must not count as "ant".
    expect(Studio.rowMatchesIntentKeywords({ title: 'Important plant care for giant palms' }, kws)).toBe(false);
    expect(Studio.rowMatchesIntentKeywords({ title: 'Antenna and antique shop pests' }, kws)).toBe(false);
    // Derivational suffixes still count for stem keywords like 'fertil'.
    const lawn = Studio.serviceIntentKeywords({ service: 'lawn care' });
    expect(Studio.rowMatchesIntentKeywords({ title: 'October fertilization for Sarasota lawns' }, lawn)).toBe(true);
    expect(Studio.rowMatchesIntentKeywords({ title: 'anything' }, [])).toBe(false);
    // Plural only — derivational suffixes never turn marketing words into pests.
    const rodent = Studio.serviceIntentKeywords({ service: 'rodent' });
    expect(Studio.rowMatchesIntentKeywords({ title: 'Rats in a Bradenton attic' }, rodent)).toBe(true);
    expect(Studio.rowMatchesIntentKeywords({ title: 'Top rated pest control, five star rating, best rates' }, rodent)).toBe(false);
    expect(Studio.serviceIntentKeywords({ topic: 'top rated pest control in Parrish' })).not.toContain('rat');
    expect(Studio.rowMatchesIntentKeywords({ title: 'Mosquitoes after the storm' }, Studio.serviceIntentKeywords({ service: 'mosquito' }))).toBe(true);
    expect(Studio.rowMatchesIntentKeywords({ title: 'Spring fertilizer schedule' }, lawn)).toBe(true);
  });

  test('serviceIntentKeywords is boundary-aware on the REQUESTED topic and covers unlisted-until-now pests', () => {
    // False positive: 'important' / 'plant' must not activate the ant group.
    expect(Studio.serviceIntentKeywords({ topic: 'important plant care update', service: 'general pest' })).toEqual([]);
    // Previously-unlisted intents now resolve, so an exact live post can be linked.
    expect(Studio.serviceIntentKeywords({ topic: 'black widow vs brown widow', service: 'general pest' })).toEqual(expect.arrayContaining(['spider']));
    expect(Studio.serviceIntentKeywords({ topic: 'wasps nesting under eaves' })).toEqual(expect.arrayContaining(['wasp', 'hornet']));
    // Mud daubers stand alone (Codex r3 on #3990): a bee or yellowjacket page is not a mud-dauber guide.
    const dauber = Studio.serviceIntentKeywords({ topic: 'mud daubers on the lanai ceiling', service: 'general pest' });
    expect(dauber).toEqual(expect.arrayContaining(['mud dauber']));
    expect(dauber).not.toContain('wasp');
    expect(dauber).not.toContain('bee');
    expect(Studio.rowMatchesIntentKeywords({ title: 'Yellowjackets around the pool deck' }, dauber)).toBe(false);
    expect(Studio.rowMatchesIntentKeywords({ title: 'Mud dauber nests on lanai ceilings' }, dauber)).toBe(true);
    // Damp-area arthropods keep separate intents (Codex r5 on #3990).
    const damp = Studio.serviceIntentKeywords({ topic: 'earwigs and springtails after downpours', service: 'general pest' });
    expect(damp).toEqual(expect.arrayContaining(['earwig', 'springtail']));
    expect(damp).not.toContain('silverfish');
    expect(damp).not.toContain('millipede');
    expect(Studio.rowMatchesIntentKeywords({ title: 'Silverfish in the bathroom' }, damp)).toBe(false);
    expect(Studio.serviceIntentKeywords({ topic: 'palmetto bugs in the garage' })).toEqual(expect.arrayContaining(['roach']));
    // End-to-end: the resolved keywords select the right row and reject the look-alike.
    const kws = Studio.serviceIntentKeywords({ topic: 'summer roaches moving indoors', service: 'general pest' });
    expect(Studio.rowMatchesIntentKeywords({ title: 'How to get rid of German cockroaches' }, kws)).toBe(true);
    expect(Studio.rowMatchesIntentKeywords({ title: 'Approaching hurricane season lawn prep' }, kws)).toBe(false);
  });

  test('captionContentRows never lets a city-only row feed the caption; probed link page leads', () => {
    const roach = { id: 1, title: 'Roaches after Parrish rain' };
    const roachOld = { id: 2, title: 'Garage door seal roach entry' };
    const venice = { id: 3, title: 'Waves opens Venice office (termite)' };
    const ranked = [
      { row: roachOld, index: 0, relevant: true },
      { row: roach, index: 1, relevant: true },
      { row: venice, index: 2, relevant: false },
    ];
    // Probed page leads, other relevant rows follow, city-only row dropped.
    expect(Studio.captionContentRows(ranked, roach)).toEqual([roach, roachOld]);
    // No probe winner → relevant rows in rank order, still no city-only row.
    expect(Studio.captionContentRows(ranked, null)).toEqual([roachOld, roach]);
    // Only city-only rows → nothing to quote (content[0] must not be Venice/termite).
    expect(Studio.captionContentRows([{ row: venice, index: 0, relevant: false }], null)).toEqual([]);
  });

  test('creativeStateSummary names the actual engine state, never a phantom provider failure', () => {
    expect(Studio.creativeStateSummary({ enabled: false })).toMatch(/engine off/);
    expect(Studio.creativeStateSummary({ enabled: true, eligible: false })).toMatch(/not eligible/);
    expect(Studio.creativeStateSummary({ enabled: true, eligible: true, produced: true })).toMatch(/produced the Meta image/);
    expect(Studio.creativeStateSummary({ enabled: true, eligible: true, produced: false })).toMatch(/returned no image/);
  });

  test('legacyCardShipped is true only for a successful platform result that retained a card URL', () => {
    const card = 'https://cdn.example.com/social-media/parrish-card.jpg';
    const gbpCard = 'https://cdn.example.com/social-media/parrish-card-gbp.jpg';
    const cards = new Set([card, gbpCard]);
    // Facebook posted the card photo.
    expect(Studio.legacyCardShipped([{ platform: 'facebook', success: true, imageUrl: card }], cards, card)).toBe(true);
    // GBP image rejected → text-only retry succeeded WITHOUT imageUrl: no card shipped.
    expect(Studio.legacyCardShipped([{ platform: 'gbp', success: true }], cards, card)).toBe(false);
    // LinkedIn thumbnail upload missed → success without imageUrl: no card shipped.
    expect(Studio.legacyCardShipped([{ platform: 'linkedin', success: true }], cards, card)).toBe(false);
    // Instagram has no text fallback: success with the shared card = card shipped…
    expect(Studio.legacyCardShipped([{ platform: 'instagram', success: true }], cards, card)).toBe(true);
    // …but not when the shared image was a creative scene and only GBP had a card that failed.
    expect(Studio.legacyCardShipped([{ platform: 'instagram', success: true }, { platform: 'gbp', success: false }], new Set([gbpCard]), 'https://cdn.example.com/scene.jpg')).toBe(false);
    // Unrelated Meta success + GBP card success: true via the GBP imageUrl.
    expect(Studio.legacyCardShipped([{ platform: 'facebook', success: true, imageUrl: 'https://cdn.example.com/scene.jpg' }, { platform: 'gbp', success: true, imageUrl: gbpCard }], new Set([gbpCard]), 'https://cdn.example.com/scene.jpg')).toBe(true);
    // Nothing rendered → never alerts.
    expect(Studio.legacyCardShipped([{ platform: 'facebook', success: true, imageUrl: card }], new Set(), card)).toBe(false);
  });
});

describe('content bank refill (2026-09-06)', () => {
  test('every month carries six campaign topics, each with a known angle/cta and a service line', () => {
    const angles = new Set(['signs to check', 'what we are seeing', 'new Florida homeowner', 'do not ignore this', 'myth/fact']);
    const ctas = new Set(['book inspection', 'request estimate', 'read guide']);
    for (let m = 1; m <= 12; m++) {
      const topics = Studio.SEASONAL_AUTONOMOUS_TOPICS[m];
      expect({ month: m, count: topics.length }).toEqual({ month: m, count: 6 });
      expect(new Set(topics.map((t) => t.topic)).size).toBe(6);
      for (const t of topics) {
        expect(angles.has(t.angle)).toBe(true);
        expect(ctas.has(t.cta)).toBe(true);
        expect(t.service).toMatch(/^(general pest|lawn care|termite|mosquito|rodent|tree & shrub)$/);
      }
    }
  });

  test('the versus bank holds 24 unique pairs with the original six first (rotation order stable)', () => {
    expect(Studio.PEST_VERSUS_PAIRS).toHaveLength(24);
    expect(new Set(Studio.PEST_VERSUS_PAIRS.map((p) => p.key)).size).toBe(24);
    expect(Studio.PEST_VERSUS_PAIRS.slice(0, 6).map((p) => p.key)).toEqual([
      'carpenter_ant_vs_ghost_ant', 'subterranean_vs_drywood_termite', 'termite_swarmer_vs_winged_ant',
      'paper_wasp_vs_mud_dauber', 'chinch_bug_vs_drought_stress', 'roof_rat_vs_norway_rat',
    ]);
    for (const pair of Studio.PEST_VERSUS_PAIRS) {
      expect(pair.left.points).toHaveLength(3);
      expect(pair.right.points).toHaveLength(3);
      expect(pair.verdict.length).toBeLessThanOrEqual(90);
      if (pair.months) expect(pair.months.every((m) => m >= 1 && m <= 12)).toBe(true);
    }
  });

  test('every seasonal topic builds compliant campaign drafts', () => {
    const context = {
      location: { city: 'Sarasota', id: 'sarasota', name: 'Sarasota' },
      services: [],
      content: [],
      recentSocials: [],
      pestPressure: { explanation: 'Pest Pressure is a 0-5 score that estimates the current level of pest activity at your property.' },
      reviews: [],
      competitorPatterns: Studio.DEFAULT_COMPETITOR_PATTERNS,
    };
    for (let m = 1; m <= 12; m++) {
      for (const t of Studio.SEASONAL_AUTONOMOUS_TOPICS[m]) {
        const drafts = Studio.buildCampaignDrafts({ ...t, city: 'Sarasota', channels: ['facebook', 'instagram', 'linkedin', 'gbp'] }, context);
        const validation = Studio.validateDrafts(drafts);
        for (const [platform, result] of Object.entries(validation)) {
          expect({ topic: t.topic, platform, issues: result.issues || [], valid: result.valid })
            .toEqual({ topic: t.topic, platform, issues: [], valid: true });
        }
      }
    }
  });
});

describe('campaign lane rotation walks the slot sequence (Codex r1 + r2 on #3990)', () => {
  const etNoonLocal = (iso) => new Date(`${iso}T16:00:00Z`);
  const days = (ym, count) => [...Array(count)].map((_, i) => `${ym}-${String(i + 1).padStart(2, '0')}`);
  let prev;
  beforeEach(() => { prev = process.env.SOCIAL_AUTONOMOUS_INCLUDE_VERSUS; });
  afterEach(() => {
    if (prev === undefined) delete process.env.SOCIAL_AUTONOMOUS_INCLUDE_VERSUS;
    else process.env.SOCIAL_AUTONOMOUS_INCLUDE_VERSUS = prev;
  });

  test('versus lane on: the 16 odd-day slots of a month reach every topic and city with no topic+city repeat', () => {
    process.env.SOCIAL_AUTONOMOUS_INCLUDE_VERSUS = 'true';
    const slots = days('2026-07', 31).filter((iso) => Number(iso.slice(8)) % 2 === 1);
    const plans = slots.map((iso) => Studio.selectAutonomousCampaign(etNoonLocal(iso)));
    expect(new Set(plans.map((p) => p.topic)).size).toBe(6);
    expect(new Set(plans.map((p) => p.city)).size).toBe(4);
    const combos = plans.map((p) => `${p.topic}|${p.city}`);
    expect(new Set(combos).size).toBe(combos.length);
  });

  test('versus lane off (default): the 24 slots of a 31-day month are exactly the full topic×city bank', () => {
    delete process.env.SOCIAL_AUTONOMOUS_INCLUDE_VERSUS;
    const slots = days('2026-07', 31).filter((iso) => Number(iso.slice(8)) % 4 !== 0);
    expect(slots).toHaveLength(24);
    const combos = slots.map((iso) => { const p = Studio.selectAutonomousCampaign(etNoonLocal(iso)); return `${p.topic}|${p.city}`; });
    expect(new Set(combos).size).toBe(24);
  });

  test('across months the walk never repeats a combination inside 24 slots (bank size 6 × 4)', () => {
    process.env.SOCIAL_AUTONOMOUS_INCLUDE_VERSUS = 'true';
    // Compare by bank position (topic index + city) since the topic LIST
    // changes at the month boundary; the walk itself must be gap-24.
    const seen = new Map();
    let minGap = Infinity;
    let i = 0;
    for (const ym of ['2026-07', '2026-08', '2026-09', '2026-10']) {
      const len = new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5)), 0)).getUTCDate();
      for (const iso of days(ym, len).filter((d) => Number(d.slice(8)) % 2 === 1)) {
        const p = Studio.selectAutonomousCampaign(etNoonLocal(iso));
        const bank = Studio.SEASONAL_AUTONOMOUS_TOPICS[Number(ym.slice(5))];
        const key = `${bank.findIndex((t) => t.topic === p.topic)}|${p.city}`;
        if (seen.has(key)) minGap = Math.min(minGap, i - seen.get(key));
        seen.set(key, i);
        i += 1;
      }
    }
    expect(minGap).toBe(24);
  });

  test('a yielded even day (review had no candidate) never duplicates the slot before or after it', () => {
    process.env.SOCIAL_AUTONOMOUS_INCLUDE_VERSUS = 'true';
    for (const d of [4, 8, 12, 16, 20, 24, 28]) {
      const pick = (day) => { const p = Studio.selectAutonomousCampaign(etNoonLocal(`2026-07-${String(day).padStart(2, '0')}`)); return `${p.topic}|${p.city}`; };
      expect(pick(d)).not.toBe(pick(d - 1));
      expect(pick(d)).not.toBe(pick(d + 1));
    }
  });
});

describe('campaign lane skips recently published cards (Codex r3 on #3990)', () => {
  const etNoonLocal = (iso) => new Date(`${iso}T16:00:00Z`);

  test('a yielded review day whose card was published is not replayed when the walk reaches it', () => {
    process.env.SOCIAL_AUTONOMOUS_INCLUDE_VERSUS = 'true';
    const yielded = Studio.selectAutonomousCampaign(etNoonLocal('2026-07-04')); // review day, no candidate
    const recent = new Set([`${yielded.topic}|${yielded.city}`]);
    // Every owned slot in the following month walks past that state instead of repeating it.
    for (let d = 5; d <= 31; d += 2) {
      const p = Studio.selectAutonomousCampaign(etNoonLocal(`2026-07-${String(d).padStart(2, '0')}`), { recent });
      expect(`${p.topic}|${p.city}`).not.toBe(`${yielded.topic}|${yielded.city}`);
    }
    delete process.env.SOCIAL_AUTONOMOUS_INCLUDE_VERSUS;
  });

  test('a yielded day changes the topic, not just the city, against both neighbouring owned slots', () => {
    process.env.SOCIAL_AUTONOMOUS_INCLUDE_VERSUS = 'true';
    // 2026-07-04 (review day) and 2026-07-06 (versus day) are not slots; 3/5/7 are.
    for (const [before, yielded, after] of [[3, 4, 5], [5, 6, 7], [7, 8, 9]]) {
      const topicOn = (d) => Studio.selectAutonomousCampaign(etNoonLocal(`2026-07-${String(d).padStart(2, '0')}`)).topic;
      expect(topicOn(yielded)).not.toBe(topicOn(before));
      expect(topicOn(yielded)).not.toBe(topicOn(after));
    }
    delete process.env.SOCIAL_AUTONOMOUS_INCLUDE_VERSUS;
  });

  test('when every state is recent, the walk still never repeats the subject that posted last (Codex r4 on #3990)', () => {
    // 24 daily campaign fires (reviews/versus dark) fill the whole July cycle.
    const seasonal = Studio.SEASONAL_AUTONOMOUS_TOPICS[7];
    const all = [];
    for (let slot = 0; slot < 24; slot += 1) {
      const c = Studio.campaignCardAt(seasonal, slot);
      all.push(`${c.topic.topic}|${c.city}`);
    }
    for (let d = 20; d <= 30; d += 1) {
      const last = Studio.selectAutonomousCampaign(etNoonLocal(`2026-07-${d}`), { recent: new Set(all) });
      // The next day's recent window starts with what just posted.
      const recent = new Set([`${last.topic}|${last.city}`, ...all]);
      const next = Studio.selectAutonomousCampaign(etNoonLocal(`2026-07-${d + 1}`), { recent });
      expect(next.topic).not.toBe(last.topic);
      expect(seasonal.some((t) => t.topic === next.topic)).toBe(true);
    }
  });

  test('the skip walks forward to the next unpublished state and never leaves the month bank', () => {
    const first = Studio.selectAutonomousCampaign(etNoonLocal('2026-07-01'));
    const next = Studio.selectAutonomousCampaign(etNoonLocal('2026-07-01'), { recent: new Set([`${first.topic}|${first.city}`]) });
    expect(`${next.topic}|${next.city}`).not.toBe(`${first.topic}|${first.city}`);
    expect(Studio.SEASONAL_AUTONOMOUS_TOPICS[7].some((t) => t.topic === next.topic)).toBe(true);
  });
});

describe('showdown bank formats: myth vs fact + three signs (PR 3)', () => {
  const etNoon = (iso) => new Date(`${iso}T16:00:00Z`);
  const V = require('../services/social-media').validateContent;

  test('the bank holds the 24 pairs plus 10 myths and 10 signs, unique keys, pairs in their original order, no two format cards adjacent', () => {
    expect(Studio.PEST_MYTHS).toHaveLength(10);
    expect(Studio.PEST_SIGNS).toHaveLength(10);
    expect(Studio.SHOWDOWN_BANK).toHaveLength(44);
    expect(new Set(Studio.SHOWDOWN_BANK.map((e) => e.key)).size).toBe(44);
    expect(Studio.SHOWDOWN_BANK.filter((e) => !e.format).map((e) => e.key)).toEqual(Studio.PEST_VERSUS_PAIRS.map((p) => p.key));
    const marks = Studio.SHOWDOWN_BANK.map((e) => (e.format ? 'F' : 'P')).join('');
    expect(marks).not.toContain('FF');
    expect(marks.slice(0, 8)).toContain('F'); // a follower sees a format change within the first month
    for (const m of Studio.PEST_MYTHS) {
      expect(m.format).toBe('myth');
      expect(m.myth.length).toBeLessThanOrEqual(95);
      expect(m.fact.length).toBeLessThanOrEqual(100);
      expect(m.verdict.length).toBeLessThanOrEqual(90);
    }
    for (const g of Studio.PEST_SIGNS) {
      expect(g.format).toBe('signs');
      expect(g.signs).toHaveLength(3);
      expect(g.verdict.length).toBeLessThanOrEqual(90);
    }
  });

  test('every format card is grounded: verified facts-bank ids and/or a named public reference, surfaced in the plan sources', () => {
    for (const entry of [...Studio.PEST_MYTHS, ...Studio.PEST_SIGNS]) {
      const g = entry.grounding || {};
      const facts = Array.isArray(g.facts) ? g.facts : [];
      const refs = Array.isArray(g.refs) ? g.refs : [];
      expect({ key: entry.key, grounded: facts.length + refs.length > 0 }).toEqual({ key: entry.key, grounded: true });
      for (const id of facts) expect(id).toMatch(/^service_[a-z_]+_\d{2}$/);
      const line = Studio.showdownGrounding(entry);
      for (const id of facts) expect(line).toContain(id);
      for (const ref of refs) expect(line).toContain(ref);
    }
    expect(Studio.showdownGrounding(Studio.PEST_VERSUS_PAIRS[0])).toBeNull();
    // Spring-only wasp advice is season-gated like the swarmer pair.
    expect(Studio.PEST_SIGNS.find((g) => g.key === 'signs_paper_wasps').months).toEqual([2, 3, 4, 5]);
    expect(Studio.PEST_MYTHS.find((m) => m.key === 'myth_dryer_sheets_wasps').months).toEqual([2, 3, 4, 5]);
    expect(Studio.versusPublishBlocker({ versusPair: { key: 'signs_paper_wasps' } }, etNoon('2026-11-30'))).toMatch(/out of season/);
    expect(Studio.versusPublishBlocker({ versusPair: { key: 'signs_paper_wasps' } }, etNoon('2026-03-30'))).toBeNull();
  });

  test('the lane steps past recently published showdown keys, so a grown bank does not replay last month', () => {
    process.env.SOCIAL_AUTONOMOUS_INCLUDE_VERSUS = 'true';
    const day = etNoon('2026-09-10');
    const natural = Studio.selectAutonomousVersusPlan(day);
    const skipped = Studio.selectAutonomousVersusPlan(day, { recent: new Set([natural.versusPair.key]) });
    expect(skipped.versusPair.key).not.toBe(natural.versusPair.key);
    // The next bank entry, not a random one; the city is still the day's city.
    const idx = Studio.SHOWDOWN_BANK.findIndex((e) => e.key === natural.versusPair.key);
    expect(skipped.versusPair.key).toBe(Studio.SHOWDOWN_BANK[(idx + 1) % Studio.SHOWDOWN_BANK.length].key);
    expect(skipped.city).toBe(natural.city);
    // Every key recent → the plain sequence (never a dead lane).
    const all = new Set(Studio.SHOWDOWN_BANK.map((e) => e.key));
    expect(Studio.selectAutonomousVersusPlan(day, { recent: all }).versusPair.key).toBe(natural.versusPair.key);
    // A month of fires with last month's cards in the window never repeats one of them.
    const lastMonth = new Set([2, 6, 10, 14, 18, 22, 26, 30].map((d) => Studio.selectAutonomousVersusPlan(etNoon(`2026-08-${String(d).padStart(2, '0')}`))?.versusPair.key).filter(Boolean));
    for (const d of [2, 6, 10, 14, 18, 22, 26, 30]) {
      const plan = Studio.selectAutonomousVersusPlan(etNoon(`2026-09-${String(d).padStart(2, '0')}`), { recent: lastMonth });
      if (plan) expect(lastMonth.has(plan.versusPair.key)).toBe(false);
    }
    delete process.env.SOCIAL_AUTONOMOUS_INCLUDE_VERSUS;
  });

  test('every format draft passes the publish validator and carries the copy without the card', () => {
    for (const entry of [...Studio.PEST_MYTHS, ...Studio.PEST_SIGNS]) {
      const drafts = Studio.buildVersusDrafts(entry, 'Bradenton');
      for (const [platform, text] of Object.entries(drafts)) {
        expect({ key: entry.key, platform, issues: V(text, platform).issues }).toEqual({ key: entry.key, platform, issues: [] });
        expect(text).toContain(entry.verdict);
        if (entry.format === 'myth') expect(text).toContain(entry.myth);
        else for (const sign of entry.signs) expect(text).toContain(sign);
      }
      expect(drafts.gbp).toContain('Bradenton');
      expect(drafts.gbp).toContain('Schedule an inspection');
      expect(drafts.instagram).toContain('#wavespestcontrol');
    }
  });

  test('the lane fires format cards through the same plan shape: topic, sources, booking link, never season-gated', () => {
    process.env.SOCIAL_AUTONOMOUS_INCLUDE_VERSUS = 'true';
    const seen = { myth: null, signs: null };
    for (let m = 1; m <= 12 && !(seen.myth && seen.signs); m++) {
      for (const d of [2, 6, 10, 14, 18, 22, 26, 30]) {
        if (m === 2 && d === 30) continue;
        const plan = Studio.selectAutonomousVersusPlan(etNoon(`2026-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`));
        if (plan?.versusPair?.format && !seen[plan.versusPair.format]) seen[plan.versusPair.format] = plan;
      }
    }
    expect(seen.myth).not.toBeNull();
    expect(seen.signs).not.toBeNull();
    expect(seen.myth.topic).toBe(`Myth vs fact: ${seen.myth.versusPair.title}`);
    expect(seen.signs.topic).toBe(seen.signs.versusPair.title);
    for (const plan of [seen.myth, seen.signs]) {
      expect(plan.angle).toBe('pest showdown');
      expect(plan.preview.suggestedLink).toBe('https://www.wavespestcontrol.com/book/');
      expect(plan.preview.sources[0].detail).toContain(plan.versusPair.verdict);
      if (!plan.versusPair.months) {
        expect(Studio.versusPublishBlocker({ versusPair: plan.versusPair }, etNoon('2026-01-02'))).toBeNull();
        expect(Studio.versusPublishBlocker({ versusPair: plan.versusPair }, etNoon('2026-08-02'))).toBeNull();
      }
      expect(plan.preview.sources.find((src) => src.type === 'reference').detail).toBe(Studio.showdownGrounding(plan.versusPair));
    }
    const card = Studio.buildVersusCardInput(seen.signs.versusPair, seen.signs);
    expect(card.variant).toBe('versus');
    expect(card.format).toBe('signs');
    expect(card.signs).toHaveLength(3);
    delete process.env.SOCIAL_AUTONOMOUS_INCLUDE_VERSUS;
  });
});

describe('versus card label (Codex r3 on #3990)', () => {
  test('general-pest pairs render a neutral Pest ID label; service pairs keep their service', () => {
    const roach = Studio.PEST_VERSUS_PAIRS.find((p) => p.key === 'german_roach_vs_american_roach');
    expect(Studio.buildVersusCardInput(roach, { city: 'Venice', service: roach.service }).service).toBe('Pest ID');
    // No-see-ums are separate scope: the pair keeps the mosquito scene bank but never the Mosquito label (Codex r6 on #3990).
    const nsu = Studio.PEST_VERSUS_PAIRS.find((p) => p.key === 'no_see_um_vs_mosquito');
    expect(Studio.buildVersusCardInput(nsu, { city: 'Venice', service: nsu.service }).service).toBe('Pest ID');
    const lawn = Studio.PEST_VERSUS_PAIRS.find((p) => p.key === 'chinch_bug_vs_drought_stress');
    expect(Studio.buildVersusCardInput(lawn, { city: 'Venice', service: lawn.service }).service).toBe('Lawn Care');
  });
});

describe('RUN_KINDS / runKindFor (2026-09-06: every run kind on the creative engine)', () => {
  const pair = Studio.PEST_VERSUS_PAIRS.find((p) => p.key === 'paper_wasp_vs_mud_dauber');

  test('versus plans classify as versus and hand the engine the versus overlay input', () => {
    const plan = { versusPair: pair, city: 'Sarasota', service: pair.service, topic: 'Paper Wasp vs Mud Dauber' };
    const kind = Studio.runKindFor(plan);
    expect(kind).toBe(Studio.RUN_KINDS.versus);
    expect(kind.variant).toBe('versus');
    expect(kind.cardInput(plan, {})).toMatchObject({ variant: 'versus', city: 'Sarasota', left: pair.left, right: pair.right, verdict: pair.verdict });
    expect(kind.photoTemplateKey).toBe('waves_photo_versus_v1');
    expect(kind.cardTemplateKey).toBe('waves_versus_square');
  });

  test('milestone plans classify as milestone (company-wide: no city on the card)', () => {
    const plan = { milestone: 300, averageRating: 4.8, city: 'Venice' };
    const kind = Studio.runKindFor(plan);
    expect(kind).toBe(Studio.RUN_KINDS.milestone);
    expect(kind.cardInput(plan, {})).toMatchObject({ variant: 'milestone', count: 300, averageRating: 4.8, city: null });
    expect(kind.photoTemplateKey).toBe('waves_photo_milestone_v1');
  });

  test('a review plan wins over any other payload; everything else is a campaign', () => {
    const review = Studio.runKindFor({ reviewGraphic: { googleReviewId: 'r1', city: 'Venice', excerpt: 'Great', reviewerDisplayName: 'K.' }, versusPair: pair });
    expect(review).toBe(Studio.RUN_KINDS.review);
    expect(review.cardInput({ reviewGraphic: { googleReviewId: 'r1', city: 'Venice', excerpt: 'Great', reviewerDisplayName: 'K.' } }).variant).toBe('review');
    // A review payload WITHOUT a source id is not a review run (liveness rule).
    expect(Studio.runKindFor({ reviewGraphic: { city: 'Venice' } })).toBe(Studio.RUN_KINDS.campaign);
    const campaign = Studio.runKindFor({ city: 'Parrish', topic: 'ants moving around lanais', service: 'general pest', cta: 'book inspection' });
    expect(campaign.variant).toBe('campaign');
    expect(campaign.cardInput({ city: 'Parrish', topic: 'ants', service: 'general pest' }, { inputs: {} }).variant).toBe('campaign');
    expect(campaign.cardTemplateKey).toBe('waves_campaign_square');
  });

  test('every kind renders its card through the shared uploader signature', () => {
    for (const kind of Object.values(Studio.RUN_KINDS)) {
      expect(typeof kind.renderCard).toBe('function');
      expect(kind.renderCard.length).toBe(3); // (plan, preview, platform)
    }
  });
});

describe('fixedCardIsFallback (Codex r3 on #3987: alert scope)', () => {
  test('campaign: the fixed card is always the fallback (hero or scene expected), even beside a successful scene', () => {
    expect(Studio.fixedCardIsFallback({ isCampaignRun: true, engineProduced: true, creativeEligible: true, engineEnabled: true })).toBe(true);
    expect(Studio.fixedCardIsFallback({ isCampaignRun: true, engineProduced: false, creativeEligible: false, engineEnabled: false })).toBe(true);
  });

  test('versus/milestone/review: the GBP card beside a successful scene is the designed visual, never an alert', () => {
    expect(Studio.fixedCardIsFallback({ isCampaignRun: false, engineProduced: true, creativeEligible: true, engineEnabled: true })).toBe(false);
  });

  test('versus/milestone/review: the card is a fallback only when the engine was on and eligible yet produced nothing', () => {
    expect(Studio.fixedCardIsFallback({ isCampaignRun: false, engineProduced: false, creativeEligible: true, engineEnabled: true })).toBe(true);
    expect(Studio.fixedCardIsFallback({ isCampaignRun: false, engineProduced: false, creativeEligible: true, engineEnabled: false })).toBe(false); // engine off = designed
    expect(Studio.fixedCardIsFallback({ isCampaignRun: false, engineProduced: false, creativeEligible: false, engineEnabled: true })).toBe(false); // GBP-only run
  });
});
