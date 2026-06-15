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
