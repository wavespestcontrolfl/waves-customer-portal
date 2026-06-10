jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/content-astro/github-client', () => ({
  createBranch: jest.fn(),
  getFile: jest.fn(),
  putBinary: jest.fn(),
  putFile: jest.fn(),
  createPr: jest.fn(),
  createIssueComment: jest.fn(),
  listIssueComments: jest.fn(),
  listPrReviews: jest.fn(),
  getPr: jest.fn(),
  mergePr: jest.fn(),
  deleteFile: jest.fn(),
  closePr: jest.fn(),
  deleteRef: jest.fn(),
}));
jest.mock('../services/content-astro/author-service', () => ({
  getAuthor: jest.fn(),
}));
jest.mock('../services/content/image-generator', () => ({
  generate: jest.fn(),
}));

const db = require('../models/db');
const gh = require('../services/content-astro/github-client');
const authorService = require('../services/content-astro/author-service');
const { validateBlogFrontmatter } = require('../services/content-astro/schema-validator');
const PagesPoll = require('../services/content-astro/pages-poll');
const AstroPublisher = require('../services/content-astro/astro-publisher');
const ContentScheduler = require('../services/content-scheduler');

function chain(overrides = {}) {
  return {
    insert: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    whereIn: jest.fn().mockReturnThis(),
    whereNotNull: jest.fn().mockReturnThis(),
    select: jest.fn().mockResolvedValue([]),
    first: jest.fn(),
    update: jest.fn().mockResolvedValue(1),
    returning: jest.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function productionDeployment(overrides = {}) {
  return {
    environment: 'production',
    url: 'https://prod.wavespestcontrol-astro.pages.dev',
    created_on: '2026-05-08T13:05:00.000Z',
    latest_stage: { name: 'deploy', status: 'success' },
    stages: [{ name: 'deploy', status: 'success' }],
    deployment_trigger: {
      metadata: {
        branch: 'main',
        commit_hash: 'merge-sha',
      },
    },
    ...overrides,
  };
}

function mockCloudflareDeploymentList(deployments) {
  global.fetch = jest.fn().mockImplementation(async (url) => {
    if (String(url).includes('api.cloudflare.com')) {
      return {
        ok: true,
        json: async () => ({ result: deployments }),
        text: async () => '',
      };
    }
    return { status: 200 };
  });
}

function calendarQuery(result = []) {
  const calls = [];
  const builder = {
    calls,
    where: jest.fn(function (...args) {
      calls.push(['where', ...args]);
      if (typeof args[0] === 'function') args[0].call(builder);
      return builder;
    }),
    orWhere: jest.fn(function (...args) {
      calls.push(['orWhere', ...args]);
      if (typeof args[0] === 'function') args[0].call(builder);
      return builder;
    }),
    select: jest.fn().mockResolvedValue(result),
  };
  return builder;
}

function validFrontmatter(overrides = {}) {
  return {
    title: 'Ant Trails in Bradenton',
    slug: '/ant-trails-bradenton/',
    meta_description: 'Bradenton homeowners can use this guide to identify ant trails, reduce entry points, and know when a professional inspection is worth it.',
    primary_keyword: 'ant control Bradenton',
    secondary_keywords: [],
    category: 'pest-control',
    post_type: 'location',
    service_areas_tag: ['Bradenton'],
    related_services: [],
    spoke_links: [],
    author: {
      name: 'Adam Benetti',
      role: 'Owner',
      fdacs_license: 'JB1234',
      years_swfl: 10,
      bio_url: '/about/authors/adam-benetti',
    },
    technically_reviewed_by: {
      name: 'Virginia Gelser',
      credential: 'Certified Operator',
      fdacs_license: 'JB5678',
      bio_url: '/about/authors/virginia-gelser',
    },
    fact_checked_by: 'Virginia Gelser',
    published: '2026-05-08',
    updated: '2026-05-08',
    technically_reviewed: '2026-05-08',
    fact_checked: '2026-05-08',
    review_cadence: 'quarterly',
    reading_time_min: 3,
    hero_image: {
      src: '/images/blog/ant-trails-bradenton/hero.png',
      alt: 'Ant trail near a Bradenton patio',
    },
    og_image: '/images/blog/ant-trails-bradenton/hero.png',
    canonical: 'https://www.wavespestcontrol.com/ant-trails-bradenton/',
    schema_types: ['Article'],
    disclosure: { type: 'pricing-transparency' },
    domains: ['wavespestcontrol.com'],
    tracking: { domains: ['wavespestcontrol.com'] },
    ...overrides,
  };
}

describe('blog Astro frontmatter validation', () => {
  test('accepts schema-valid frontmatter with the emitted domains extension', () => {
    const result = validateBlogFrontmatter(validFrontmatter());
    expect(result).toEqual({ ok: true, errors: [] });
  });

  test('rejects old admin category and post_type values', () => {
    const result = validateBlogFrontmatter(validFrontmatter({
      category: 'pest',
      post_type: 'article',
    }));
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/category must be one of/);
    expect(result.errors.join('\n')).toMatch(/post_type must be one of/);
  });

  // The validator is ajv-backed (draft-2020); these lock the human-readable
  // error contract callers/UX depend on through the ajv→message mapping.
  test('reports a missing required field', () => {
    const fm = validFrontmatter();
    delete fm.title;
    const result = validateBlogFrontmatter(fm);
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/title is required/);
  });

  test('rejects an unknown top-level field (additionalProperties:false)', () => {
    const result = validateBlogFrontmatter(validFrontmatter({ bogus_field: 'x' }));
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/bogus_field is not allowed/);
  });

  test('reports a meta_description over the max length', () => {
    const result = validateBlogFrontmatter(validFrontmatter({ meta_description: 'x'.repeat(200) }));
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/meta_description must be at most \d+ characters/);
  });

  test('reports a nested field error with a dotted path (author.bio_url)', () => {
    const result = validateBlogFrontmatter(validFrontmatter({
      author: { name: 'Adam Benetti', role: 'Owner', fdacs_license: 'JB1234', years_swfl: 10, bio_url: 12345 },
    }));
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/author\.bio_url must be string/);
  });

  test('maps pest-family legacy tags to the required pest-control category', async () => {
    const data = await AstroPublisher.buildFrontmatter({
      title: 'Ant Pressure in Palmetto',
      slug: 'ant-pressure-palmetto',
      meta_description: 'A short guide to ant pressure around Palmetto homes.',
      keyword: 'ant control Palmetto',
      tag: 'Ants',
      featured_image_url: '/images/blog/ant-pressure-palmetto/hero.png',
      hero_image_alt: 'Ant trail near a Palmetto patio',
      content: 'Ant trails around patios often start with moisture and food access.',
    });

    expect(data.category).toBe('pest-control');
  });

  test('adds FAQPage schema when published markdown contains a visible FAQ section', async () => {
    const data = await AstroPublisher.buildFrontmatter({
      title: 'Yellow Lawn in Sarasota',
      slug: 'yellow-lawn-sarasota',
      meta_description: 'A short guide to yellow St. Augustine lawns around Sarasota.',
      keyword: 'yellow lawn Sarasota',
      tag: 'Lawn Care',
      city: 'Sarasota',
      featured_image_url: '/images/blog/yellow-lawn-sarasota/hero.png',
      hero_image_alt: 'Yellow St. Augustine lawn in Sarasota',
      content: [
        'Sarasota lawns yellow for a few common reasons.',
        '',
        '## Frequently Asked Questions',
        '',
        '### Why is my lawn yellow after fertilizer?',
        '',
        'The problem may be micronutrients, pH, irrigation, or root stress.',
      ].join('\n'),
    });

    expect(data.schema_types).toEqual(['Article', 'FAQPage']);
  });

  test('does not build live URLs from unsupported target_sites hosts', () => {
    expect(AstroPublisher.liveUrlForPost({
      title: 'Bad host',
      slug: 'bad-host',
      target_sites: ['https://example.com/blog'],
    })).toBe('https://www.wavespestcontrol.com/bad-host/');
  });

  test('recognizes only supported autonomous draft briefs for direct Astro publish', () => {
    const draft = {
      type: 'draft',
      frontmatter: validFrontmatter(),
      body: 'Waves Pest Control guidance for Bradenton homeowners.',
    };

    expect(AstroPublisher.canPublishDraftBrief(draft, { action_type: 'new_supporting_blog' })).toBe(true);
    expect(AstroPublisher.canPublishDraftBrief(draft, { action_type: 'create_customer_question_page' })).toBe(false);
    expect(AstroPublisher.canPublishDraftBrief(draft, { action_type: 'refresh_existing_page' })).toBe(false);
    expect(AstroPublisher.canPublishDraftBrief({ ...draft, body: '   ' }, { action_type: 'new_supporting_blog' })).toBe(false);
  });

  test('recognizes clean Codex review comments and usage-limit failures', () => {
    const { codexReviewStatus } = AstroPublisher._internals;
    expect(codexReviewStatus({
      comments: [{
        user: { login: 'chatgpt-codex-connector' },
        body: "Codex Review: Didn't find any major issues.",
        created_at: '2026-05-24T12:00:00Z',
      }],
    })).toEqual({ clean: true });
    expect(codexReviewStatus({
      comments: [{
        user: { login: 'chatgpt-codex-connector' },
        body: 'You have reached your Codex usage limits for code reviews.',
        created_at: '2026-05-24T12:00:00Z',
      }],
    })).toMatchObject({ clean: false, reason: expect.stringMatching(/usage limits/) });
  });

  test('requires Codex review evidence for the current PR head', () => {
    const { codexReviewStatus } = AstroPublisher._internals;
    const head = 'abcdef1234567890abcdef1234567890abcdef12';
    expect(codexReviewStatus({
      headSha: head,
      comments: [
        {
          user: { login: 'wavespestcontrolfl' },
          body: '@codex review\n\nReady on head `oldsha`.',
          created_at: '2026-05-24T12:00:00Z',
        },
        {
          user: { login: 'chatgpt-codex-connector' },
          body: "Codex Review: Didn't find any major issues.",
          created_at: '2026-05-24T12:05:00Z',
        },
      ],
    })).toMatchObject({ clean: false, reason: expect.stringMatching(/current PR head/) });

    expect(codexReviewStatus({
      headSha: head,
      comments: [
        {
          user: { login: 'wavespestcontrolfl' },
          body: `@codex review\n\nReady on head \`${head}\`.`,
          created_at: '2026-05-24T12:00:00Z',
        },
        {
          user: { login: 'chatgpt-codex-connector' },
          body: "Codex Review: Didn't find any major issues.",
          created_at: '2026-05-24T12:05:00Z',
        },
      ],
    })).toMatchObject({ clean: false, reason: expect.stringMatching(/required/) });

    expect(codexReviewStatus({
      headSha: head,
      comments: [
        {
          user: { login: 'wavespestcontrolfl' },
          body: `@codex review\n\nReady on head \`${head}\`.`,
          created_at: '2026-05-24T12:00:00Z',
        },
      ],
      reviews: [{
        user: { login: 'chatgpt-codex-connector' },
        body: "Codex Review: Didn't find any major issues.",
        state: 'COMMENTED',
        commit_id: head,
        submitted_at: '2026-05-24T12:05:00Z',
      }],
    })).toEqual({ clean: true });
  });

  test('only trusts the Codex connector bot as reviewer', () => {
    const { isCodexAuthor } = AstroPublisher._internals;
    expect(isCodexAuthor('chatgpt-codex-connector')).toBe(true);
    expect(isCodexAuthor('chatgpt-codex-connector[bot]')).toBe(true);
    expect(isCodexAuthor('my-codex-test')).toBe(false);
    expect(isCodexAuthor('codex')).toBe(false);
  });

  test('opens an Astro PR for supported autonomous draft briefs', async () => {
    jest.clearAllMocks();
    gh.createBranch.mockResolvedValue({});
    gh.getFile.mockResolvedValue(null);
    gh.putFile.mockResolvedValue({ commit: { sha: 'file-sha' } });
    gh.createPr.mockResolvedValue({ number: 123, html_url: 'https://github.com/wavespestcontrolfl/waves-astro/pull/123' });
    gh.createIssueComment.mockResolvedValue({});

    const frontmatter = validFrontmatter({ slug: '/ant-trails-bradenton/' });
    const result = await AstroPublisher.publishOrUpdatePage(
      {
        type: 'draft',
        frontmatter,
        body: 'Waves Pest Control guidance for Bradenton homeowners.',
      },
      { action_type: 'new_supporting_blog' }
    );

    expect(gh.createBranch).toHaveBeenCalledWith(expect.stringMatching(/^content\/autonomous-ant-trails-bradenton-/));
    expect(gh.putFile).toHaveBeenCalledWith(expect.objectContaining({
      path: 'src/content/blog/ant-trails-bradenton.mdx',
      content: expect.stringContaining('Waves Pest Control guidance'),
      message: 'feat(blog): publish ant-trails-bradenton',
      sha: undefined,
    }));
    expect(gh.createPr).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Blog: Ant Trails in Bradenton',
      body: expect.stringContaining('**Autonomous content publish**'),
    }));
    expect(gh.createPr).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.stringContaining('## Autonomous Blog SEO Review'),
    }));
    expect(gh.createIssueComment).toHaveBeenCalledWith(123, expect.stringContaining('@codex review'));
    expect(result).toMatchObject({
      url: 'https://www.wavespestcontrol.com/ant-trails-bradenton/',
      status: 'pr_open',
      live: false,
      pr_number: 123,
      pr_url: 'https://github.com/wavespestcontrolfl/waves-astro/pull/123',
      commit_sha: 'file-sha',
    });
  });

  test('adds FAQPage schema to autonomous draft frontmatter when body has FAQs', async () => {
    jest.clearAllMocks();
    gh.createBranch.mockResolvedValue({});
    gh.getFile.mockResolvedValue(null);
    gh.putFile.mockResolvedValue({ commit: { sha: 'file-sha' } });
    gh.createPr.mockResolvedValue({ number: 124, html_url: 'https://github.com/wavespestcontrolfl/waves-astro/pull/124' });
    gh.createIssueComment.mockResolvedValue({});

    const result = await AstroPublisher.publishOrUpdatePage(
      {
        type: 'draft',
        frontmatter: validFrontmatter({
          slug: '/yellow-lawn-sarasota/',
          title: 'Yellow Lawn in Sarasota',
          canonical: 'https://www.wavespestcontrol.com/yellow-lawn-sarasota/',
          schema_types: ['Article', 'BreadcrumbList'],
        }),
        body: [
          'Sarasota lawns yellow for a few common reasons.',
          '',
          '## Frequently Asked Questions',
          '',
          '### Why is my lawn yellow after fertilizer?',
          '',
          'The problem may be micronutrients, pH, irrigation, or root stress.',
        ].join('\n'),
      },
      { action_type: 'new_supporting_blog' }
    );

    expect(gh.putFile).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('FAQPage'),
    }));
    expect(result).toMatchObject({
      url: 'https://www.wavespestcontrol.com/yellow-lawn-sarasota/',
      status: 'pr_open',
    });
  });

  test('includes SEO completion findings and recommended links in autonomous PR body', () => {
    const { buildSeoReviewSection } = AstroPublisher._internals;
    const body = buildSeoReviewSection({
      frontmatter: validFrontmatter({ schema_types: ['Article', 'BreadcrumbList'] }),
      brief: {
        seo_completion_gate_result: {
          passed: true,
          score: 88,
          summary: { p0: 0, p1: 1, p2: 0 },
          findings: [
            { severity: 'P1', code: 'P1_MISSING_SERVICE_LINK', message: 'Required service link is missing.' },
          ],
          contract: {
            internalLinkRecommendations: [
              { url: '/pest-control-bradenton-fl/', anchorText: 'Bradenton pest control', reason: 'city', required: true },
              { url: '/contact/', anchorText: 'request a pest control quote', reason: 'conversion', required: true },
            ],
          },
        },
      },
    });

    expect(body).toContain('## Autonomous Blog SEO Review');
    expect(body).toContain('P0/P1/P2 findings: 0/1/0');
    expect(body).toContain('P1 P1_MISSING_SERVICE_LINK');
    expect(body).toContain('/pest-control-bradenton-fl/');
    expect(body).toContain('Codex review completed');
  });

  test('rejects autonomous drafts whose canonical does not match the emitted slug', async () => {
    jest.clearAllMocks();
    const frontmatter = validFrontmatter({
      slug: '/ant-trails-bradenton/',
      canonical: 'https://example.com/ant-trails-bradenton/',
    });

    await expect(AstroPublisher.publishOrUpdatePage(
      {
        type: 'draft',
        frontmatter,
        body: 'Waves Pest Control guidance for Bradenton homeowners.',
      },
      { action_type: 'new_supporting_blog' }
    )).rejects.toThrow(/canonical must match slug/);
    expect(gh.createBranch).not.toHaveBeenCalled();
  });
});

describe('Astro publisher autonomous draft adapter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('opens an Astro PR from a supported emitted blog draft', async () => {
    gh.createBranch.mockResolvedValue({});
    gh.getFile.mockResolvedValue(null);
    gh.putFile.mockResolvedValue({ commit: { sha: 'file-sha' } });
    gh.createPr.mockResolvedValue({ number: 42, html_url: 'https://github.com/wavespestcontrolfl/wavespestcontrol-astro/pull/42' });
    gh.createIssueComment.mockResolvedValue({});

    const frontmatter = validFrontmatter({
      title: 'Autonomous Ant Control in Bradenton',
      slug: '/autonomous-ant-control-bradenton/',
      canonical: 'https://www.wavespestcontrol.com/autonomous-ant-control-bradenton/',
    });
    const result = await AstroPublisher.publishOrUpdatePage({
      type: 'draft',
      frontmatter,
      body: 'Ant control guidance for Bradenton homeowners.',
    }, {
      action_type: 'new_supporting_blog',
    });

    expect(result).toMatchObject({
      url: 'https://www.wavespestcontrol.com/autonomous-ant-control-bradenton/',
      pr_number: 42,
      pr_url: 'https://github.com/wavespestcontrolfl/wavespestcontrol-astro/pull/42',
    });
    expect(gh.putFile).toHaveBeenCalledWith(expect.objectContaining({
      path: 'src/content/blog/autonomous-ant-control-bradenton.mdx',
      branch: expect.stringMatching(/^content\/autonomous-autonomous-ant-control-bradenton-/),
      sha: undefined,
    }));
    expect(gh.createPr).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Blog: Autonomous Ant Control in Bradenton',
    }));
    expect(gh.createIssueComment).toHaveBeenCalledWith(42, expect.stringContaining('@codex review'));
  });

  test('migrates a legacy .md post to .mdx instead of writing components into Markdown', async () => {
    jest.clearAllMocks();
    gh.createBranch.mockResolvedValue({});
    // .mdx does not exist yet; the legacy .md does.
    gh.getFile.mockImplementation(async (path) =>
      path.endsWith('.mdx')
        ? null
        : { sha: 'legacy-md-sha', path, content: '---\ntitle: Old\n---\nold body' }
    );
    gh.putFile.mockResolvedValue({ commit: { sha: 'file-sha' } });
    gh.deleteFile.mockResolvedValue({});
    gh.createPr.mockResolvedValue({ number: 77, html_url: 'https://github.com/wavespestcontrolfl/wavespestcontrol-astro/pull/77' });
    gh.createIssueComment.mockResolvedValue({});

    await AstroPublisher.publishOrUpdatePage(
      {
        type: 'draft',
        frontmatter: validFrontmatter({
          slug: '/legacy-ant-post/',
          canonical: 'https://www.wavespestcontrol.com/legacy-ant-post/',
        }),
        body: 'Updated guidance.\n\n<SeasonalPressureChart />',
      },
      { action_type: 'new_supporting_blog' }
    );

    // Writes the .mdx (no sha — it is a new file), not the legacy .md.
    expect(gh.putFile).toHaveBeenCalledWith(expect.objectContaining({
      path: 'src/content/blog/legacy-ant-post.mdx',
      sha: undefined,
    }));
    // Deletes the superseded .md so we never leave both.
    expect(gh.deleteFile).toHaveBeenCalledWith(expect.objectContaining({
      path: 'src/content/blog/legacy-ant-post.md',
      sha: 'legacy-md-sha',
    }));
  });

  test('declines unsupported autonomous action types', () => {
    expect(AstroPublisher.canPublishDraftBrief({
      type: 'draft',
      frontmatter: validFrontmatter(),
      body: 'Body',
    }, {
      action_type: 'refresh_existing_page',
    })).toBe(false);
  });

  test('opens a frontmatter-only Astro PR for metadata rewrites', async () => {
    gh.createBranch.mockResolvedValue({});
    gh.getFile.mockResolvedValue({
      sha: 'existing-sha',
      content: [
        '---',
        'title: Old Lakewood Ranch Title',
        'slug: /pest-control-lakewood-ranch-fl/',
        'meta_description: Old meta description.',
        'canonical: https://www.wavespestcontrol.com/pest-control-lakewood-ranch-fl/',
        '---',
        '## Existing body',
        '',
        'Do not change this body.',
      ].join('\n'),
    });
    gh.putFile.mockResolvedValue({ commit: { sha: 'metadata-sha' } });
    gh.createPr.mockResolvedValue({
      number: 55,
      html_url: 'https://github.com/wavespestcontrolfl/wavespestcontrol-astro/pull/55',
      head: { sha: 'metadata-head-sha' },
    });
    gh.createIssueComment.mockResolvedValue({});

    const result = await AstroPublisher.publishMetadataRewrite({
      type: 'metadata',
      title: 'Pest Control in Lakewood Ranch, FL | Waves',
      meta_description: 'Need pest control in Lakewood Ranch? Waves helps identify, treat, and prevent common Southwest Florida pest problems.',
    }, {
      action_type: 'rewrite_title_meta',
      target_url: 'https://www.wavespestcontrol.com/pest-control-lakewood-ranch-fl/',
      target_keyword: 'pest control lakewood ranch fl',
      city: 'Lakewood Ranch',
      service: 'pest',
    });

    expect(gh.getFile).toHaveBeenCalledWith('src/content/services/pest-control-lakewood-ranch-fl.md');
    expect(gh.putFile).toHaveBeenCalledWith(expect.objectContaining({
      path: 'src/content/services/pest-control-lakewood-ranch-fl.md',
      sha: 'existing-sha',
      content: expect.stringContaining('title: Pest Control in Lakewood Ranch, FL | Waves'),
    }));
    expect(gh.putFile.mock.calls[0][0].branch).toEqual(expect.stringMatching(/^content\/meta-services-pest-control-lakewood-ranch-fl-/));
    expect(gh.putFile.mock.calls[0][0].content).toContain('meta_description: Need pest control in Lakewood Ranch? Waves helps identify, treat, and prevent common Southwest Florida pest problems.');
    expect(gh.putFile.mock.calls[0][0].content).toContain('Do not change this body.');
    expect(gh.createPr).toHaveBeenCalledWith(expect.objectContaining({
      title: 'SEO metadata: Pest Control in Lakewood Ranch, FL | Waves',
      body: expect.stringContaining('Body, slug, canonical, and schema are intentionally unchanged.'),
    }));
    expect(gh.createIssueComment).toHaveBeenCalledWith(55, expect.stringContaining('@codex review'));
    expect(result).toMatchObject({
      status: 'pr_open',
      live: false,
      pr_url: 'https://github.com/wavespestcontrolfl/wavespestcontrol-astro/pull/55',
      url: 'https://www.wavespestcontrol.com/pest-control-lakewood-ranch-fl/',
    });
  });
});

describe('Pages poll merged-to-live transition', () => {
  const originalEnv = {
    CF_API_TOKEN: process.env.CF_API_TOKEN,
    CF_ACCOUNT_ID: process.env.CF_ACCOUNT_ID,
    CF_PAGES_PROJECT: process.env.CF_PAGES_PROJECT,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CF_API_TOKEN = 'test-token';
    process.env.CF_ACCOUNT_ID = 'test-account';
    process.env.CF_PAGES_PROJECT = 'test-project';
    mockCloudflareDeploymentList([productionDeployment()]);
  });

  afterEach(() => {
    delete global.fetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test('marks merged posts live when the production deployment and expected live URL are ready', async () => {
    const update = chain();
    db.mockReturnValue(update);

    const result = await PagesPoll.pollPost({
      id: 'post-1',
      slug: 'ant-trails-bradenton',
      astro_status: 'merged',
      astro_live_url: 'https://www.wavespestcontrol.com/ant-trails-bradenton/',
      publish_status: 'pending_review',
      astro_merged_at: '2026-05-08T13:00:00.000Z',
      astro_commit_sha: 'merge-sha',
      astro_published_at: null,
    });

    expect(result).toMatchObject({ live: true, url: 'https://www.wavespestcontrol.com/ant-trails-bradenton/' });
    expect(update.where).toHaveBeenCalledWith({ id: 'post-1' });
    expect(update.update).toHaveBeenCalledWith(expect.objectContaining({
      astro_status: 'live',
      status: 'published',
      astro_live_url: 'https://www.wavespestcontrol.com/ant-trails-bradenton/',
    }));
  });

  test('does not mark an existing URL live before the matching production deployment finishes', async () => {
    const update = chain();
    db.mockReturnValue(update);
    mockCloudflareDeploymentList([
      productionDeployment({
        created_on: '2026-05-08T12:00:00.000Z',
        deployment_trigger: { metadata: { branch: 'main', commit_hash: 'old-sha' } },
      }),
    ]);

    const result = await PagesPoll.pollPost({
      id: 'post-1',
      slug: 'ant-trails-bradenton',
      astro_status: 'merged',
      astro_live_url: 'https://www.wavespestcontrol.com/ant-trails-bradenton/',
      publish_status: 'pending_review',
      astro_merged_at: '2026-05-08T13:00:00.000Z',
      astro_commit_sha: 'merge-sha',
      astro_published_at: null,
    });

    expect(result).toMatchObject({
      pending: true,
      url: 'https://www.wavespestcontrol.com/ant-trails-bradenton/',
      reason: 'production deployment pending',
    });
    expect(update.update).not.toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('Pages poll deploy-match window (deploymentMatchesMergedPost)', () => {
  // No commit SHA on either side → the timestamp-window fallback applies.
  const noShaDeploy = (createdOn) => ({
    environment: 'production',
    latest_stage: { name: 'deploy', status: 'success' },
    stages: [{ name: 'deploy', status: 'success' }],
    created_on: createdOn,
    deployment_trigger: { metadata: { branch: 'main' } }, // no commit hash
  });
  const post = { astro_merged_at: '2026-05-08T13:00:00.000Z' }; // no astro_commit_sha

  test('matches a production deploy shortly after the merge', () => {
    expect(PagesPoll.deploymentMatchesMergedPost(noShaDeploy('2026-05-08T13:05:00.000Z'), post)).toBe(true);
  });

  test('does NOT match a production deploy hours after the merge (upper-bounded window)', () => {
    // Previously this matched (lower-bound-only) and could flip a post live off
    // an unrelated later merge's deployment.
    expect(PagesPoll.deploymentMatchesMergedPost(noShaDeploy('2026-05-08T15:00:00.000Z'), post)).toBe(false);
  });

  test('does NOT match a production deploy well before the merge', () => {
    expect(PagesPoll.deploymentMatchesMergedPost(noShaDeploy('2026-05-08T12:00:00.000Z'), post)).toBe(false);
  });

  test('still matches strictly by commit SHA when both sides have one (window irrelevant)', () => {
    const deploy = {
      environment: 'production',
      latest_stage: { name: 'deploy', status: 'success' },
      stages: [{ name: 'deploy', status: 'success' }],
      created_on: '2026-05-09T20:00:00.000Z', // hours later — but SHA matches
      deployment_trigger: { metadata: { branch: 'main', commit_hash: 'merge-sha' } },
    };
    expect(PagesPoll.deploymentMatchesMergedPost(deploy, { astro_merged_at: '2026-05-08T13:00:00.000Z', astro_commit_sha: 'merge-sha' })).toBe(true);
  });
});

describe('Content scheduler scheduling timezone handling', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('expands date-only calendar ranges to an exclusive next ET day', async () => {
    const blogQuery = calendarQuery([{
      id: 'date-blog',
      title: 'Date-only blog',
      status: 'draft',
      publish_date: new Date('2026-05-01T00:00:00.000Z'),
    }]);
    const socialQuery = calendarQuery([]);
    db.mockImplementation((table) => (table === 'blog_posts' ? blogQuery : socialQuery));

    const calendar = await ContentScheduler.getCalendar('2026-04-01', '2026-04-30');

    const blogEnd = blogQuery.calls.find((call) => call[1] === 'scheduled_publish_at' && call[2] === '<')?.[3];
    const socialEnd = socialQuery.calls.find((call) => call[1] === 'scheduled_for' && call[2] === '<')?.[3];

    expect(ContentScheduler.normalizeCalendarRange('2026-04-01', '2026-04-30')).toMatchObject({
      start: expect.any(Date),
      end: expect.any(Date),
    });
    expect(blogEnd.toISOString()).toBe('2026-05-01T04:00:00.000Z');
    expect(socialEnd.toISOString()).toBe('2026-05-01T04:00:00.000Z');
    expect(calendar[0].scheduledDate).toBe('2026-05-01');
  });

  test('stores naive blog schedule times as Eastern Time instants', async () => {
    const read = chain({ first: jest.fn().mockResolvedValue({ id: 'post-1' }) });
    const write = chain({
      update: jest.fn().mockReturnThis(),
      returning: jest.fn().mockResolvedValue([{ id: 'post-1', title: 'Scheduled blog' }]),
    });
    const queries = [read, write];
    db.mockImplementation(() => queries.shift() || chain());

    await ContentScheduler.scheduleBlogPost('post-1', '2026-07-01T09:00:00', true);

    expect(write.update).toHaveBeenCalledWith(expect.objectContaining({
      scheduled_publish_at: expect.any(Date),
    }));
    expect(write.update.mock.calls[0][0].scheduled_publish_at.toISOString()).toBe('2026-07-01T13:00:00.000Z');
  });

  test('stores naive social schedule times as Eastern Time instants', async () => {
    const write = chain({
      insert: jest.fn().mockReturnThis(),
      returning: jest.fn().mockResolvedValue([{ id: 'social-1', title: 'Scheduled social' }]),
    });
    db.mockReturnValue(write);

    await ContentScheduler.scheduleSocialPost({
      title: 'Scheduled social',
      description: 'Post body',
      link: 'https://www.wavespestcontrol.com/blog/',
      platforms: ['facebook'],
      scheduledFor: '2026-07-01T09:00:00',
    });

    expect(write.insert).toHaveBeenCalledWith(expect.objectContaining({
      scheduled_for: expect.any(Date),
    }));
    expect(write.insert.mock.calls[0][0].scheduled_for.toISOString()).toBe('2026-07-01T13:00:00.000Z');
  });
});

describe('Astro publisher hero image republish', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    authorService.getAuthor.mockImplementation(async (slug) => ({
      name: slug === 'reviewer' ? 'Virginia Gelser' : 'Adam Benetti',
      role: slug === 'reviewer' ? 'Certified Operator' : 'Owner',
      credentials: slug === 'reviewer' ? ['Certified Operator'] : [],
      fdacs_license: slug === 'reviewer' ? 'JB5678' : 'JB1234',
      years_swfl: slug === 'reviewer' ? undefined : 10,
      bio_url: slug === 'reviewer' ? '/about/authors/virginia-gelser' : '/about/authors/adam-benetti',
    }));
    gh.createBranch.mockResolvedValue({});
    gh.getFile.mockImplementation(async (path) => (
      path.endsWith('/hero.webp') ? { sha: 'existing-hero-sha' } : null
    ));
    gh.putBinary.mockResolvedValue({});
    gh.putFile.mockResolvedValue({ commit: { sha: 'file-commit-sha' } });
    gh.createPr.mockResolvedValue({ number: 123, html_url: 'https://github.example/pr/123' });
    gh.createIssueComment.mockResolvedValue({});
  });

  test('passes the existing hero SHA when updating an already-published hero asset', async () => {
    const post = {
      id: 'post-1',
      title: 'Ant Trails in Bradenton',
      slug: 'ant-trails-bradenton',
      meta_description: 'Bradenton homeowners can use this guide to identify ant trails, reduce entry points, and know when a professional inspection is worth it.',
      keyword: 'ant control Bradenton',
      category: 'pest-control',
      post_type: 'location',
      service_areas_tag: ['Bradenton'],
      related_services: [],
      target_sites: ['wavespestcontrol.com'],
      author_slug: 'adam',
      reviewer_slug: 'reviewer',
      technically_reviewed_at: '2026-05-08',
      fact_checked_by: 'Virginia Gelser',
      fact_checked_at: '2026-05-08',
      featured_image_url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      hero_image_alt: 'Ant trail near a Bradenton patio',
      content: '## What you are seeing\n\nAnt trails around Bradenton patios usually start with moisture, food access, and tiny exterior gaps.',
    };
    const read = chain({ first: jest.fn().mockResolvedValue(post) });
    const update = chain();
    const queries = [read, update];
    db.mockImplementation(() => queries.shift() || chain());

    await AstroPublisher.publishAstro('post-1');

    expect(gh.putBinary).toHaveBeenCalledWith(expect.objectContaining({
      path: 'public/images/blog/ant-trails-bradenton/hero.webp',
      sha: 'existing-hero-sha',
    }));
    expect(update.update).toHaveBeenCalledWith(expect.objectContaining({
      astro_status: 'pr_open',
      astro_pr_number: 123,
    }));
  });

  test('blocks a legacy post that ships a hardcoded price (P0 guardrail) before opening a PR', async () => {
    const post = {
      id: 'post-1',
      title: 'Ant Trails in Bradenton',
      slug: 'ant-trails-bradenton',
      meta_description: 'Bradenton homeowners can use this guide to identify ant trails, reduce entry points, and know when a professional inspection is worth it.',
      keyword: 'ant control Bradenton',
      category: 'pest-control',
      post_type: 'location',
      service_areas_tag: ['Bradenton'],
      related_services: [],
      target_sites: ['wavespestcontrol.com'],
      author_slug: 'adam',
      reviewer_slug: 'reviewer',
      technically_reviewed_at: '2026-05-08',
      fact_checked_by: 'Virginia Gelser',
      fact_checked_at: '2026-05-08',
      featured_image_url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      hero_image_alt: 'Ant trail near a Bradenton patio',
      // Hardcoded monthly price with no calculator/quote framing — a P0 the
      // legacy publish path previously shipped (only schema validation ran).
      content: '## Pricing\n\nOur pest control plan is just $39/month for year-round protection. Sign up today and never see an ant again.',
    };
    const read = chain({ first: jest.fn().mockResolvedValue(post) });
    const update = chain();
    const queries = [read, update];
    db.mockImplementation(() => queries.shift() || chain());

    await expect(AstroPublisher.publishAstro('post-1')).rejects.toThrow(/content guardrails failed/);
    expect(gh.createBranch).not.toHaveBeenCalled();
    expect(gh.createPr).not.toHaveBeenCalled();
    // Marked publish_failed (consistent with schema-invalid handling) so the
    // author can fix the body and retry.
    expect(update.update).toHaveBeenCalledWith(expect.objectContaining({ astro_status: 'publish_failed' }));
  });

  test('hub-only post with literal "Waves Pest Control" branding publishes (not treated as multi-domain)', async () => {
    const post = {
      id: 'post-1',
      title: 'Ant Trails in Bradenton',
      slug: 'ant-trails-bradenton',
      meta_description: 'Bradenton homeowners can use this guide to identify ant trails, reduce entry points, and know when a professional inspection is worth it.',
      keyword: 'ant control Bradenton',
      category: 'pest-control',
      post_type: 'location',
      service_areas_tag: ['Bradenton'],
      related_services: [],
      target_sites: ['wavespestcontrol.com'], // sole hub domain — hub-only
      author_slug: 'adam',
      reviewer_slug: 'reviewer',
      technically_reviewed_at: '2026-05-08',
      fact_checked_by: 'Virginia Gelser',
      fact_checked_at: '2026-05-08',
      featured_image_url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      hero_image_alt: 'Ant trail near a Bradenton patio',
      content: '## What you are seeing\n\nWaves Pest Control keeps Bradenton homes pest-free with seasonal treatments and exterior sealing.',
    };
    const read = chain({ first: jest.fn().mockResolvedValue(post) });
    const update = chain();
    const queries = [read, update];
    db.mockImplementation(() => queries.shift() || chain());

    await AstroPublisher.publishAstro('post-1');

    // Literal brand on a hub-only post is allowed — it must NOT be blocked.
    expect(gh.createPr).toHaveBeenCalled();
    expect(update.update).toHaveBeenCalledWith(expect.objectContaining({ astro_status: 'pr_open' }));
  });

  test('blocks a legacy rodent post (topic on `tag`) that ships an FAQ section', async () => {
    const post = {
      id: 'post-1',
      title: 'Keeping Rats Out of Bradenton Homes',
      slug: 'rats-out-of-bradenton-homes',
      meta_description: 'Bradenton homeowners can use this guide to spot early rodent activity, seal entry points, and know when professional rodent control is worth calling.',
      keyword: 'rodent control Bradenton',
      category: 'pest-control', // broad Astro category…
      tag: 'Rodents', // …real topic lives on `tag`
      post_type: 'location',
      service_areas_tag: ['Bradenton'],
      related_services: [],
      target_sites: ['wavespestcontrol.com'],
      author_slug: 'adam',
      reviewer_slug: 'reviewer',
      technically_reviewed_at: '2026-05-08',
      fact_checked_by: 'Virginia Gelser',
      fact_checked_at: '2026-05-08',
      featured_image_url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      hero_image_alt: 'Rodent exclusion around a Bradenton home',
      content: '## Sealing entry points\n\nRats squeeze through dime-sized gaps.\n\n## Frequently Asked Questions\n\nQ: How fast can you help?',
    };
    const read = chain({ first: jest.fn().mockResolvedValue(post) });
    const update = chain();
    const queries = [read, update];
    db.mockImplementation(() => queries.shift() || chain());

    await expect(AstroPublisher.publishAstro('post-1')).rejects.toThrow(/content guardrails failed/);
    expect(gh.createBranch).not.toHaveBeenCalled();
    expect(update.update).toHaveBeenCalledWith(expect.objectContaining({ astro_status: 'publish_failed' }));
  });

  test('blocks a literal-brand post with empty target_sites (renders on ALL spokes, not hub-only)', async () => {
    const post = {
      id: 'post-1',
      title: 'Ant Trails in Bradenton',
      slug: 'ant-trails-bradenton',
      meta_description: 'Bradenton homeowners can use this guide to identify ant trails, reduce entry points, and know when a professional inspection is worth it.',
      keyword: 'ant control Bradenton',
      category: 'pest-control',
      post_type: 'location',
      service_areas_tag: ['Bradenton'],
      related_services: [],
      target_sites: [], // empty → publishes to ALL 15 domains (backward-compat)
      author_slug: 'adam',
      reviewer_slug: 'reviewer',
      technically_reviewed_at: '2026-05-08',
      fact_checked_by: 'Virginia Gelser',
      fact_checked_at: '2026-05-08',
      featured_image_url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      hero_image_alt: 'Ant trail near a Bradenton patio',
      // Literal brand would leak across every spoke domain — must use {{brandName}}.
      content: '## What you are seeing\n\nWaves Pest Control keeps Bradenton homes pest-free with seasonal treatments.',
    };
    const read = chain({ first: jest.fn().mockResolvedValue(post) });
    const update = chain();
    const queries = [read, update];
    db.mockImplementation(() => queries.shift() || chain());

    await expect(AstroPublisher.publishAstro('post-1')).rejects.toThrow(/content guardrails failed/);
    expect(gh.createBranch).not.toHaveBeenCalled();
    expect(update.update).toHaveBeenCalledWith(expect.objectContaining({ astro_status: 'publish_failed' }));
  });
});

describe('Astro publisher idempotency guard', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  test.each(['pr_open', 'unpublish_pending'])(
    'refuses to open a second PR when one is already in flight (status %s)',
    async (status) => {
      const post = {
        id: 'post-1', title: 'Ant Trails', slug: 'ant-trails-bradenton',
        astro_status: status, astro_pr_number: 99,
      };
      const read = chain({ first: jest.fn().mockResolvedValue(post) });
      db.mockImplementation(() => read);

      await expect(AstroPublisher.publishAstro('post-1')).rejects.toThrow(/already in flight/);
      // No fresh branch/PR cut, and no status write — so the existing PR isn't orphaned.
      expect(gh.createBranch).not.toHaveBeenCalled();
      expect(gh.createPr).not.toHaveBeenCalled();
      expect(read.update).not.toHaveBeenCalled();
    },
  );

  test('build_failed retry closes + deletes the stale PR/branch before republishing (no orphan)', async () => {
    const post = {
      id: 'post-1', title: 'Ant Trails', slug: 'ant-trails-bradenton',
      astro_status: 'build_failed', astro_pr_number: 99, astro_branch_name: 'content/blog-ant-trails-bradenton-old1',
    };
    const read = chain({ first: jest.fn().mockResolvedValue(post) });
    db.mockImplementation(() => read);
    gh.getPr.mockResolvedValue({ number: 99, state: 'open', merged: false });

    // Fails later (minimal post isn't schema-valid, no gh publish mocks), but
    // NOT with the in-flight error — the retry is allowed and cleanup runs first.
    await expect(AstroPublisher.publishAstro('post-1')).rejects.not.toThrow(/already in flight/);
    expect(gh.closePr).toHaveBeenCalledWith(99);
    expect(gh.deleteRef).toHaveBeenCalledWith('content/blog-ant-trails-bradenton-old1');
  });

  test('build_failed retry does not close an already-merged/closed PR', async () => {
    const post = {
      id: 'post-1', title: 'Ant Trails', slug: 'ant-trails-bradenton',
      astro_status: 'build_failed', astro_pr_number: 99, astro_branch_name: 'content/blog-ant-trails-bradenton-old1',
    };
    const read = chain({ first: jest.fn().mockResolvedValue(post) });
    db.mockImplementation(() => read);
    gh.getPr.mockResolvedValue({ number: 99, state: 'closed', merged: true });

    await expect(AstroPublisher.publishAstro('post-1')).rejects.not.toThrow(/already in flight/);
    expect(gh.closePr).not.toHaveBeenCalled();
    // The branch is still deleted (a stale ref left from the failed build).
    expect(gh.deleteRef).toHaveBeenCalledWith('content/blog-ant-trails-bradenton-old1');
  });

  test('allows republish from a non-in-flight status (e.g. publish_failed)', async () => {
    const post = {
      id: 'post-1', title: 'Ant Trails', slug: 'ant-trails-bradenton',
      astro_status: 'publish_failed', astro_pr_number: null,
    };
    const read = chain({ first: jest.fn().mockResolvedValue(post) });
    db.mockImplementation(() => read);
    // It fails downstream (this minimal post isn't schema-valid and no gh mocks
    // are set up), but crucially NOT with the in-flight guard error — proving a
    // publish_failed post is allowed to retry rather than being blocked.
    await expect(AstroPublisher.publishAstro('post-1')).rejects.not.toThrow(/already in flight/);
  });
});

describe('Pages poll auto-merge per-tick cap', () => {
  const originalEnv = {
    CF_API_TOKEN: process.env.CF_API_TOKEN,
    CF_ACCOUNT_ID: process.env.CF_ACCOUNT_ID,
    CF_PAGES_PROJECT: process.env.CF_PAGES_PROJECT,
    cap: process.env.AUTONOMOUS_CONTENT_MAX_AUTO_MERGES_PER_POLL,
  };

  function previewDeployment(branch) {
    return {
      environment: 'preview',
      url: `https://${branch.replace(/[^a-z0-9]/gi, '-')}.preview.pages.dev`,
      latest_stage: { name: 'deploy', status: 'success' },
      stages: [{ name: 'deploy', status: 'success' }],
      deployment_trigger: { metadata: { branch } },
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CF_API_TOKEN = 'test-token';
    process.env.CF_ACCOUNT_ID = 'test-account';
    process.env.CF_PAGES_PROJECT = 'test-project';
    delete process.env.AUTONOMOUS_CONTENT_MAX_AUTO_MERGES_PER_POLL; // default = 2
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete global.fetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (key === 'cap') continue;
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
    if (originalEnv.cap == null) delete process.env.AUTONOMOUS_CONTENT_MAX_AUTO_MERGES_PER_POLL;
    else process.env.AUTONOMOUS_CONTENT_MAX_AUTO_MERGES_PER_POLL = originalEnv.cap;
  });

  test('merges only up to the cap per tick and defers the rest to the next tick', async () => {
    const posts = ['b1', 'b2', 'b3'].map((b, i) => ({
      id: `post-${i + 1}`, slug: `slug-${i + 1}`,
      astro_status: 'pr_open', publish_status: 'publishing', astro_branch_name: b,
    }));
    // Every db() call: the pending select returns all three; per-post updates no-op.
    db.mockImplementation(() => chain({ select: jest.fn().mockResolvedValue(posts) }));
    mockCloudflareDeploymentList(posts.map((p) => previewDeployment(p.astro_branch_name)));
    const mergeSpy = jest.spyOn(AstroPublisher, 'mergeAstro').mockResolvedValue({ merged: true });

    const result = await PagesPoll.pollPending();

    // Default cap = 2: first two merge, third defers.
    expect(mergeSpy).toHaveBeenCalledTimes(2);
    expect(result.autoMerges).toBe(2);
    expect(result.deferred).toBe(1);
    const deferred = result.results.filter((r) => r.mergeDeferred);
    expect(deferred).toHaveLength(1);
  });
});

describe('generateHeroBuffer (publish-time AI hero)', () => {
  const imageGenerator = require('../services/content/image-generator');
  // 1x1 transparent PNG
  const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  beforeEach(() => jest.clearAllMocks());

  test('decodes a generated data: URL into image bytes + ext, with blog-hero mode', async () => {
    imageGenerator.generate.mockResolvedValue({ dataUrl: `data:image/png;base64,${PNG_B64}`, model: 'test-model' });
    const img = await AstroPublisher._internals.generateHeroBuffer({
      title: 'Dollar Spot', meta_description: 'm', keyword: 'k', slug: 's',
    });
    expect(Buffer.isBuffer(img.buffer)).toBe(true);
    expect(img.buffer.length).toBeGreaterThan(0);
    expect(img.ext).toBe('png');
    expect(imageGenerator.generate).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'blog-hero', title: 'Dollar Spot', keyword: 'k' })
    );
  });

  test('throws when generation yields no usable image (so publish fails loudly, not hero-less)', async () => {
    imageGenerator.generate.mockResolvedValue({ dataUrl: 'not-a-data-url', model: 'x' });
    await expect(
      AstroPublisher._internals.generateHeroBuffer({ title: 'T' })
    ).rejects.toThrow(/no usable image/);
  });
});

describe('compressToWebp (hero LCP optimization)', () => {
  test('converts an image buffer to a smaller WebP (RIFF/WEBP magic)', async () => {
    const sharp = require('sharp');
    // a 2000x2000 red PNG — larger than the 1600px hero cap
    const png = await sharp({ create: { width: 2000, height: 2000, channels: 3, background: { r: 200, g: 30, b: 30 } } })
      .png().toBuffer();
    const webp = await AstroPublisher._internals.compressToWebp(png);
    // WebP container: "RIFF"...."WEBP"
    expect(webp.slice(0, 4).toString('ascii')).toBe('RIFF');
    expect(webp.slice(8, 12).toString('ascii')).toBe('WEBP');
    expect(webp.length).toBeLessThan(png.length);
    const meta = await sharp(webp).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBeLessThanOrEqual(1600);
  });
});

describe('automated blog posts target the hub only', () => {
  const base = {
    title: 'Dollar Spot in Venice', slug: 'dollar-spot-venice',
    meta_description: 'A short guide to dollar spot on Venice lawns and how to actually treat it.',
    keyword: 'dollar spot Venice', tag: 'Lawn Disease',
    featured_image_url: '/images/blog/dollar-spot-venice/hero.webp',
    content: 'Dollar spot shows up as small bleached patches on warm-season turf.',
  };

  test('an automated (ai_generated) post with no target_sites pins to wavespestcontrol.com', async () => {
    const data = await AstroPublisher.buildFrontmatter({ ...base, source: 'ai_generated' });
    expect(data.domains).toEqual(['wavespestcontrol.com']);
    expect(data.tracking).toEqual({ domains: ['wavespestcontrol.com'] });
  });

  test('demand_mined and calendar sources also pin to the hub', async () => {
    for (const source of ['demand_mined', 'calendar']) {
      const data = await AstroPublisher.buildFrontmatter({ ...base, source });
      expect(data.domains).toEqual(['wavespestcontrol.com']);
    }
  });

  test('a manual post with no target_sites keeps the empty/astro-default (undefined domains)', async () => {
    const data = await AstroPublisher.buildFrontmatter({ ...base, source: 'manual' });
    expect(data.domains).toBeUndefined();
  });

  test('an explicit target_sites is always respected, even for automated posts', async () => {
    const data = await AstroPublisher.buildFrontmatter({
      ...base, source: 'ai_generated', target_sites: ['wavespestcontrol.com', 'example-spoke.com'],
    });
    expect(data.domains).toContain('wavespestcontrol.com');
  });
});
