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
jest.mock('../services/content/fact-check-gate', () => ({
  evaluate: jest.fn().mockResolvedValue({ pass: true, findings: [], checked: false }),
}));

const db = require('../models/db');
const factCheckGate = require('../services/content/fact-check-gate');
const gh = require('../services/content-astro/github-client');
const authorService = require('../services/content-astro/author-service');
const { validateBlogFrontmatter } = require('../services/content-astro/schema-validator');
const PagesPoll = require('../services/content-astro/pages-poll');
const AstroPublisher = require('../services/content-astro/astro-publisher');
const ContentScheduler = require('../services/content-scheduler');
const heroImageGenerator = require('../services/content/image-generator');

// 1x1 transparent PNG — enough for the real sharp compressToWebp step that
// runs inside the autonomous hero pipeline.
const HERO_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// The autonomous publish path now generates + commits a hero whenever the
// post has no hero already committed on main, so publish tests must stub the
// image generator and the binary commit.
function mockHeroGeneration() {
  heroImageGenerator.generate.mockResolvedValue({
    dataUrl: `data:image/png;base64,${HERO_PNG_B64}`,
    model: 'test-model',
  });
  gh.putBinary.mockResolvedValue({});
}

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
    mockHeroGeneration();

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

  test('normalizes autonomous draft domains to the hub before committing markdown', async () => {
    jest.clearAllMocks();
    gh.createBranch.mockResolvedValue({});
    gh.getFile.mockResolvedValue(null);
    gh.putFile.mockResolvedValue({ commit: { sha: 'file-sha' } });
    gh.createPr.mockResolvedValue({ number: 123, html_url: 'https://github.com/wavespestcontrolfl/waves-astro/pull/123' });
    gh.createIssueComment.mockResolvedValue({});
    mockHeroGeneration();

    await AstroPublisher.publishOrUpdatePage(
      {
        type: 'draft',
        frontmatter: validFrontmatter({
          slug: '/ant-trails-bradenton/',
          domains: ['veniceflpestcontrol.com'],
          tracking: { domains: ['veniceflpestcontrol.com'] },
        }),
        body: 'Waves Pest Control guidance for Bradenton homeowners.',
      },
      { action_type: 'new_supporting_blog' }
    );

    const fmModule = require('../services/content-astro/frontmatter');
    const markdownCall = gh.putFile.mock.calls.find(([arg]) => String(arg.path || '').endsWith('/ant-trails-bradenton.mdx'));
    const parsed = fmModule.parse(markdownCall[0].content);
    expect(parsed.data.domains).toEqual(['wavespestcontrol.com']);
    expect(parsed.data.tracking).toEqual({ domains: ['wavespestcontrol.com'] });
    expect(parsed.data.canonical).toBe('https://www.wavespestcontrol.com/ant-trails-bradenton/');
  });

  test('adds FAQPage schema to autonomous draft frontmatter when body has FAQs', async () => {
    jest.clearAllMocks();
    gh.createBranch.mockResolvedValue({});
    gh.getFile.mockResolvedValue(null);
    gh.putFile.mockResolvedValue({ commit: { sha: 'file-sha' } });
    gh.createPr.mockResolvedValue({ number: 124, html_url: 'https://github.com/wavespestcontrolfl/waves-astro/pull/124' });
    gh.createIssueComment.mockResolvedValue({});
    mockHeroGeneration();

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
    factCheckGate.evaluate.mockResolvedValue({ pass: true, findings: [], checked: false });
  });

  test('blocks an autonomous publish when the fact-check finds a P0 error (no branch/PR opened)', async () => {
    factCheckGate.evaluate.mockResolvedValueOnce({
      pass: false,
      checked: true,
      findings: [{ severity: 'P0', code: 'FACTUAL_ERROR', message: 'wrong pathogen: C. jacksonii is cool-season' }],
    });
    const frontmatter = validFrontmatter({
      title: 'Autonomous Dollar Spot in Venice',
      slug: '/autonomous-dollar-spot-venice/',
      canonical: 'https://www.wavespestcontrol.com/autonomous-dollar-spot-venice/',
    });
    await expect(AstroPublisher.publishOrUpdatePage(
      { type: 'draft', frontmatter, body: 'Dollar spot guidance for Venice lawns.' },
      { action_type: 'new_supporting_blog' },
    )).rejects.toMatchObject({ code: 'BLOG_FACTCHECK_FAILED' });
    expect(gh.createBranch).not.toHaveBeenCalled();
    expect(gh.createPr).not.toHaveBeenCalled();
    // Hero generation runs AFTER the fact-check gate, so a factually-blocked
    // post never burns image-generation cost.
    expect(heroImageGenerator.generate).not.toHaveBeenCalled();
  });

  test('opens an Astro PR from a supported emitted blog draft', async () => {
    gh.createBranch.mockResolvedValue({});
    gh.getFile.mockResolvedValue(null);
    gh.putFile.mockResolvedValue({ commit: { sha: 'file-sha' } });
    gh.createPr.mockResolvedValue({ number: 42, html_url: 'https://github.com/wavespestcontrolfl/wavespestcontrol-astro/pull/42' });
    gh.createIssueComment.mockResolvedValue({});
    mockHeroGeneration();

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
    }));
    expect(gh.putFile.mock.calls[0][0].branch).toEqual(expect.stringMatching(/^content\/meta-services-pest-control-lakewood-ranch-fl-/));
    // Assert on parsed frontmatter, not raw YAML quoting style (js-yaml v3
    // quotes comma-containing scalars; v4 leaves them plain — both valid).
    const writtenMeta = require('../services/content-astro/frontmatter').parse(gh.putFile.mock.calls[0][0].content);
    expect(writtenMeta.data.title).toBe('Pest Control in Lakewood Ranch, FL | Waves');
    expect(writtenMeta.data.meta_description).toBe('Need pest control in Lakewood Ranch? Waves helps identify, treat, and prevent common Southwest Florida pest problems.');
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

describe('publishOrUpdatePage autonomous hero pipeline', () => {
  const fmModule = require('../services/content-astro/frontmatter');

  beforeEach(() => {
    jest.clearAllMocks();
    factCheckGate.evaluate.mockResolvedValue({ pass: true, findings: [], checked: false });
    gh.createBranch.mockResolvedValue({});
    gh.putFile.mockResolvedValue({ commit: { sha: 'file-sha' } });
    gh.createPr.mockResolvedValue({ number: 200, html_url: 'https://github.com/wavespestcontrolfl/wavespestcontrol-astro/pull/200' });
    gh.createIssueComment.mockResolvedValue({});
  });

  function heroDraft(fmOverrides = {}) {
    return {
      type: 'draft',
      frontmatter: validFrontmatter({
        slug: '/dollar-spot-venice/',
        title: 'Dollar Spot in Venice',
        canonical: 'https://www.wavespestcontrol.com/dollar-spot-venice/',
        // Agent-invented hero path — plausible-looking, but no such file was
        // ever committed to the Astro repo.
        hero_image: { src: '/images/blog/dollar-spot-venice/hero.png', alt: 'Dollar spot lesions on a Venice lawn' },
        og_image: '/images/blog/dollar-spot-venice/hero.png',
        ...fmOverrides,
      }),
      body: 'Dollar spot guidance for Venice lawns.',
    };
  }

  test('new post without a committed hero: generates, commits hero + markdown in ONE branch, stamps frontmatter', async () => {
    gh.getFile.mockResolvedValue(null); // nothing exists on main
    mockHeroGeneration();

    await AstroPublisher.publishOrUpdatePage(heroDraft(), { action_type: 'new_supporting_blog' });

    expect(heroImageGenerator.generate).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'blog-hero',
      title: 'Dollar Spot in Venice',
    }));
    expect(gh.putBinary).toHaveBeenCalledWith(expect.objectContaining({
      path: 'public/images/blog/dollar-spot-venice/hero.webp',
      branch: expect.stringMatching(/^content\/autonomous-dollar-spot-venice-/),
      sha: undefined,
    }));
    // Compressed to WebP (RIFF/WEBP container) before commit — LCP path.
    const committed = gh.putBinary.mock.calls[0][0].buffer;
    expect(committed.slice(0, 4).toString('ascii')).toBe('RIFF');
    expect(committed.slice(8, 12).toString('ascii')).toBe('WEBP');
    // Hero and markdown land on the SAME feature branch, branch cut first.
    expect(gh.putFile.mock.calls[0][0].branch).toBe(gh.putBinary.mock.calls[0][0].branch);
    expect(gh.createBranch.mock.invocationCallOrder[0]).toBeLessThan(gh.putBinary.mock.invocationCallOrder[0]);
    // Frontmatter stamped with the path that was actually committed.
    const parsed = fmModule.parse(gh.putFile.mock.calls[0][0].content);
    expect(parsed.data.hero_image).toEqual({
      src: '/images/blog/dollar-spot-venice/hero.webp',
      alt: 'Dollar spot lesions on a Venice lawn',
    });
    expect(parsed.data.og_image).toBe('/images/blog/dollar-spot-venice/hero.webp');
  });

  test('existing post with a committed hero: reuses it, no regeneration, no binary commit', async () => {
    const liveMdx = [
      '---',
      'title: Dollar Spot in Venice',
      'hero_image:',
      '  src: /images/blog/dollar-spot-venice/hero.webp',
      '  alt: Existing committed hero',
      '---',
      'old body',
    ].join('\n');
    gh.getFile.mockImplementation(async (path) => {
      if (path === 'src/content/blog/dollar-spot-venice.mdx') return { sha: 'mdx-sha', path, content: liveMdx };
      if (path === 'public/images/blog/dollar-spot-venice/hero.webp') return { sha: 'hero-sha', path };
      return null;
    });

    await AstroPublisher.publishOrUpdatePage(heroDraft(), { action_type: 'new_supporting_blog' });

    expect(heroImageGenerator.generate).not.toHaveBeenCalled();
    expect(gh.putBinary).not.toHaveBeenCalled();
    expect(gh.putFile).toHaveBeenCalledWith(expect.objectContaining({
      path: 'src/content/blog/dollar-spot-venice.mdx',
      sha: 'mdx-sha',
    }));
    const parsed = fmModule.parse(gh.putFile.mock.calls[0][0].content);
    expect(parsed.data.hero_image.src).toBe('/images/blog/dollar-spot-venice/hero.webp');
    expect(parsed.data.og_image).toBe('/images/blog/dollar-spot-venice/hero.webp');
  });

  test('hero generation failure fails CLOSED with a deterministic publish error and no orphan branch/PR', async () => {
    gh.getFile.mockResolvedValue(null);
    heroImageGenerator.generate.mockRejectedValue(new Error('image API down'));

    await expect(AstroPublisher.publishOrUpdatePage(heroDraft(), { action_type: 'new_supporting_blog' }))
      .rejects.toMatchObject({ code: 'BLOG_HERO_IMAGE_FAILED' });

    // Hero resolution runs before the branch is cut, so nothing is orphaned
    // and no hero-less markdown is ever committed.
    expect(gh.createBranch).not.toHaveBeenCalled();
    expect(gh.putFile).not.toHaveBeenCalled();
    expect(gh.createPr).not.toHaveBeenCalled();
  });

  test('agent-invented bogus hero path is overridden — never committed to frontmatter', async () => {
    gh.getFile.mockResolvedValue(null); // the agent's hero.png does not exist in the repo
    mockHeroGeneration();

    await AstroPublisher.publishOrUpdatePage(heroDraft(), { action_type: 'new_supporting_blog' });

    // The publisher probed the agent path before overriding it.
    expect(gh.getFile).toHaveBeenCalledWith('public/images/blog/dollar-spot-venice/hero.png');
    const content = gh.putFile.mock.calls[0][0].content;
    expect(content).not.toContain('hero.png');
    const parsed = fmModule.parse(content);
    expect(parsed.data.hero_image.src).toBe('/images/blog/dollar-spot-venice/hero.webp');
    expect(parsed.data.og_image).toBe('/images/blog/dollar-spot-venice/hero.webp');
  });

  test('an agent hero path that DOES exist in the repo is kept (no regeneration)', async () => {
    gh.getFile.mockImplementation(async (path) => (
      path === 'public/images/blog/dollar-spot-venice/hero.png' ? { sha: 'curated-hero-sha', path } : null
    ));

    await AstroPublisher.publishOrUpdatePage(heroDraft(), { action_type: 'new_supporting_blog' });

    expect(heroImageGenerator.generate).not.toHaveBeenCalled();
    expect(gh.putBinary).not.toHaveBeenCalled();
    const parsed = fmModule.parse(gh.putFile.mock.calls[0][0].content);
    expect(parsed.data.hero_image.src).toBe('/images/blog/dollar-spot-venice/hero.png');
  });

  test('schema-invalid drafts still fail before any fact-check or image spend', async () => {
    gh.getFile.mockResolvedValue(null);

    const draft = heroDraft({ meta_description: 'too short' });
    await expect(AstroPublisher.publishOrUpdatePage(draft, { action_type: 'new_supporting_blog' }))
      .rejects.toMatchObject({ code: 'BLOG_FRONTMATTER_INVALID' });

    expect(factCheckGate.evaluate).not.toHaveBeenCalled();
    expect(heroImageGenerator.generate).not.toHaveBeenCalled();
    expect(gh.createBranch).not.toHaveBeenCalled();
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

  test('empty target_sites still emits a hub-only blog post', async () => {
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
      target_sites: [],
      author_slug: 'adam',
      reviewer_slug: 'reviewer',
      technically_reviewed_at: '2026-05-08',
      fact_checked_by: 'Virginia Gelser',
      fact_checked_at: '2026-05-08',
      featured_image_url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      hero_image_alt: 'Ant trail near a Bradenton patio',
      content: '## What you are seeing\n\nWaves Pest Control keeps Bradenton homes pest-free with seasonal treatments.',
    };
    const read = chain({ first: jest.fn().mockResolvedValue(post) });
    const update = chain();
    const queries = [read, update];
    db.mockImplementation(() => queries.shift() || chain());

    await expect(AstroPublisher.publishAstro('post-1')).resolves.toMatchObject({ pr_number: 123 });
    const fmModule = require('../services/content-astro/frontmatter');
    const markdownCall = gh.putFile.mock.calls.find(([arg]) => String(arg.path || '').endsWith('/ant-trails-bradenton.md'));
    const parsed = fmModule.parse(markdownCall[0].content);
    expect(parsed.data.domains).toEqual(['wavespestcontrol.com']);
    expect(parsed.data.tracking).toEqual({ domains: ['wavespestcontrol.com'] });
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

describe('blog posts target the hub only', () => {
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

  test('a manual post with no target_sites also pins to wavespestcontrol.com', async () => {
    const data = await AstroPublisher.buildFrontmatter({ ...base, source: 'manual' });
    expect(data.domains).toEqual(['wavespestcontrol.com']);
    expect(data.tracking).toEqual({ domains: ['wavespestcontrol.com'] });
  });

  test('explicit spoke target_sites are ignored for blog frontmatter', async () => {
    const data = await AstroPublisher.buildFrontmatter({
      ...base, source: 'ai_generated', target_sites: ['wavespestcontrol.com', 'veniceflpestcontrol.com'],
    });
    expect(data.domains).toEqual(['wavespestcontrol.com']);
  });
});

describe('applyMergeEffect hero persistence (curated vs generated)', () => {
  const { applyMergeEffect } = AstroPublisher._internals;

  function mergePost(overrides = {}) {
    return {
      id: 'post-1',
      title: 'Dollar Spot in Venice',
      slug: 'dollar-spot-venice',
      target_sites: ['wavespestcontrol.com'],
      astro_commit_sha: 'sha-1',
      ...overrides,
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    gh.getFile.mockResolvedValue(null); // mergedHeroRef falls back
  });

  test('generated hero (no featured_image_url) persists the absolute hub hero.webp URL', async () => {
    const update = chain();
    db.mockImplementation(() => update);
    await applyMergeEffect('post-1', mergePost({ featured_image_url: null }), new Date(), false, 'sha-2');
    expect(update.update).toHaveBeenCalledWith(expect.objectContaining({
      featured_image_url: 'https://www.wavespestcontrol.com/images/blog/dollar-spot-venice/hero.webp',
    }));
  });

  test('curated hero source is PRESERVED (not overwritten with the Astro copy)', async () => {
    const update = chain();
    db.mockImplementation(() => update);
    await applyMergeEffect('post-1', mergePost({ featured_image_url: 'https://www.wavespestcontrol.com/images/2025/10/curated.webp' }), new Date(), false, 'sha-2');
    const args = update.update.mock.calls[0][0];
    expect('featured_image_url' in args).toBe(false);
  });

  test('unpublish clears a committed hero ref but preserves a curated source URL', async () => {
    for (const [value, shouldClear] of [
      ['https://www.wavespestcontrol.com/images/blog/dollar-spot-venice/hero.webp', true],
      ['/images/blog/dollar-spot-venice/hero.webp', true],
      ['https://www.wavespestcontrol.com/images/2025/10/curated.webp', false],
    ]) {
      const update = chain();
      db.mockImplementation(() => update);
      await applyMergeEffect('post-1', mergePost({ featured_image_url: value, astro_status: 'unpublish_pending' }), new Date(), true, 'sha-2');
      const args = update.update.mock.calls[0][0];
      if (shouldClear) expect(args.featured_image_url).toBeNull();
      else expect('featured_image_url' in args).toBe(false);
    }
  });
});

describe('publishRefresh fact-check (refreshed blog bodies)', () => {
  const fm = require('../services/content-astro/frontmatter');
  const BLOG_PATH = 'src/content/blog/dollar-spot-venice.mdx';

  beforeEach(() => {
    jest.clearAllMocks();
    factCheckGate.evaluate.mockResolvedValue({ pass: true, findings: [], checked: false });
    gh.createBranch.mockResolvedValue({});
    gh.putFile.mockResolvedValue({ commit: { sha: 'file-sha' } });
    gh.createPr.mockResolvedValue({ number: 50, html_url: 'https://github.example/pr/50' });
    gh.createIssueComment.mockResolvedValue({});
    const existing = fm.stringify(
      validFrontmatter({ slug: '/dollar-spot-venice/', canonical: 'https://www.wavespestcontrol.com/dollar-spot-venice/' }),
      'Old body about dollar spot in Venice.',
    );
    gh.getFile.mockImplementation(async (p) => (p === BLOG_PATH ? { sha: 'existing-sha', content: existing, path: p } : null));
  });

  const refreshDraft = (body) => ([
    { type: 'draft', file_path: BLOG_PATH, page_url: 'https://www.wavespestcontrol.com/dollar-spot-venice/', body, frontmatter: {} },
    { action_type: 'refresh_existing_page' },
  ]);

  test('blocks a refresh whose changed body fails the fact-check (no branch/PR opened)', async () => {
    factCheckGate.evaluate.mockResolvedValueOnce({
      pass: false, checked: true,
      findings: [{ severity: 'P0', code: 'FACTUAL_ERROR', message: 'wrong pathogen for warm-season turf' }],
    });
    await expect(AstroPublisher.publishRefresh(...refreshDraft('A NEW refreshed body naming the wrong pathogen.')))
      .rejects.toMatchObject({ code: 'BLOG_FACTCHECK_FAILED' });
    expect(gh.createBranch).not.toHaveBeenCalled();
    expect(gh.createPr).not.toHaveBeenCalled();
  });

  test('a clean refresh runs the fact-check and proceeds to open a PR', async () => {
    const result = await AstroPublisher.publishRefresh(...refreshDraft('A NEW, factually-clean refreshed body about dollar spot.'));
    expect(factCheckGate.evaluate).toHaveBeenCalledTimes(1);
    expect(gh.createBranch).toHaveBeenCalled();
    expect(result.pr_number).toBe(50);
  });
});

describe('post-merge internal-link planning', () => {
  const planner = require('../services/content/internal-link-planner');
  const linkExecutor = require('../services/content/internal-link-pr-executor');
  const { planInternalLinksForMergedPost, queueInternalLinkPlanning } = AstroPublisher._internals;

  const post = {
    id: 'post-1',
    slug: 'venice-dollar-spot-guide',
    title: 'Dollar Spot in Venice',
    keyword: 'venice dollar spot',
    city: 'Venice',
    target_sites: null,
  };

  beforeEach(() => jest.clearAllMocks());
  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.INTERNAL_LINK_PLAN_ON_BLOG_MERGE;
  });

  function mockTaskInsert(returnedIds) {
    const returning = jest.fn().mockResolvedValue(returnedIds.map((id) => ({ id })));
    const ignore = jest.fn().mockReturnValue({ returning });
    const onConflict = jest.fn().mockReturnValue({ ignore });
    const insert = jest.fn().mockReturnValue({ onConflict });
    db.mockImplementation((table) => {
      if (table === 'content_internal_link_tasks') return { insert };
      return chain();
    });
    return { insert, onConflict };
  }

  test('plans, queues, and dry-runs internal links for the merged hub URL', async () => {
    jest.spyOn(planner, 'loadAstroCorpusFromGitHub').mockResolvedValue([
      { file: 'src/content/blog/post-a.md', body: 'corpus page', url: '/blog/post-a/' },
    ]);
    const planSpy = jest.spyOn(planner, 'planForTarget').mockReturnValue([
      {
        source_file: 'src/content/blog/post-a.md',
        target_url: '/venice-dollar-spot-guide/',
        target_file: 'src/content/blog/venice-dollar-spot-guide.md',
        anchor_text: 'venice dollar spot',
      },
    ]);
    const dryRunSpy = jest.spyOn(linkExecutor, 'runDryRun').mockResolvedValue({
      results: [{ status: 'patch_candidate' }],
    });
    const { insert, onConflict } = mockTaskInsert(['task-1']);

    const result = await planInternalLinksForMergedPost(post);

    expect(planSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        url: expect.stringContaining('/venice-dollar-spot-guide/'),
        keyword: 'venice dollar spot',
        city: 'Venice',
      }),
      expect.objectContaining({ corpus: expect.any(Array) }),
    );
    expect(insert).toHaveBeenCalledTimes(1);
    expect(onConflict).toHaveBeenCalledWith(['source_file', 'target_url', 'anchor_text']);
    expect(dryRunSpy).toHaveBeenCalledWith({ taskIds: ['task-1'], limit: 1 });
    expect(result).toEqual(expect.objectContaining({ queued: 1, candidates: 1 }));
  });

  test('target_sites cannot move blog internal-link planning off the hub', async () => {
    jest.spyOn(planner, 'loadAstroCorpusFromGitHub').mockResolvedValue([
      { file: 'src/content/blog/post-a.md', body: 'Lawns with venice dollar spot rings need fungicide.', url: '/blog/post-a/' },
    ]);
    const planSpy = jest.spyOn(planner, 'planForTarget');
    const dryRunSpy = jest.spyOn(linkExecutor, 'runDryRun').mockResolvedValue({ results: [] });
    const { insert } = mockTaskInsert(['task-1']);

    const result = await planInternalLinksForMergedPost({
      ...post,
      target_sites: ['veniceflpestcontrol.com'],
    });

    expect(planSpy).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://www.wavespestcontrol.com/venice-dollar-spot-guide/' }),
      expect.objectContaining({ corpus: expect.any(Array) }),
    );
    expect(insert).toHaveBeenCalledTimes(1);
    expect(dryRunSpy).toHaveBeenCalledWith({ taskIds: ['task-1'], limit: 1 });
    expect(result).toEqual(expect.objectContaining({ queued: 1 }));
  });

  test('INTERNAL_LINK_PLAN_ON_BLOG_MERGE=false disables post-merge planning', async () => {
    process.env.INTERNAL_LINK_PLAN_ON_BLOG_MERGE = 'false';
    const corpusSpy = jest.spyOn(planner, 'loadAstroCorpusFromGitHub');
    const planSpy = jest.spyOn(planner, 'planForTarget');

    queueInternalLinkPlanning(post);
    await new Promise((resolve) => setImmediate(resolve));

    expect(corpusSpy).not.toHaveBeenCalled();
    expect(planSpy).not.toHaveBeenCalled();
  });

  test('kill switch honors normalized falsy values (0/no/off), not just the literal "false"', async () => {
    const { internalLinkPlanningDisabled } = AstroPublisher._internals;

    for (const value of ['false', 'FALSE', '0', 'no', 'off', ' Off ']) {
      process.env.INTERNAL_LINK_PLAN_ON_BLOG_MERGE = value;
      expect(internalLinkPlanningDisabled()).toBe(true);
    }
    for (const value of ['', 'true', '1', 'yes', 'on']) {
      process.env.INTERNAL_LINK_PLAN_ON_BLOG_MERGE = value;
      expect(internalLinkPlanningDisabled()).toBe(false);
    }
    delete process.env.INTERNAL_LINK_PLAN_ON_BLOG_MERGE;
    expect(internalLinkPlanningDisabled()).toBe(false);

    process.env.INTERNAL_LINK_PLAN_ON_BLOG_MERGE = '0';
    const corpusSpy = jest.spyOn(planner, 'loadAstroCorpusFromGitHub');
    queueInternalLinkPlanning(post);
    await new Promise((resolve) => setImmediate(resolve));
    expect(corpusSpy).not.toHaveBeenCalled();
  });

  test('a planner failure is swallowed (never fails the merge)', async () => {
    jest.spyOn(planner, 'loadAstroCorpusFromGitHub').mockRejectedValue(new Error('github down'));

    queueInternalLinkPlanning(post);
    await new Promise((resolve) => setImmediate(resolve));

    const logger = require('../services/logger');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('internal-link planning failed'));
  });
});

// ── publishMetadataRewrite casing-aware meta fields ──────────────────
//
// Bug: the rewrite unconditionally wrote `title` + `meta_description`.
// Service/location pages render fm.metaTitle || fm.title and
// fm.metaDescription, so on those pages the rewrite never rendered — yet the
// diff still bumped `modified` (fake sitemap freshness) and left dead
// snake_case duplicates behind. Fix mirrors publishRefresh's
// REFRESH_EDITABLE_META_FIELDS approach: write the casing variant that
// EXISTS on the live page, never create the dead duplicate, and only bump
// the freshness field when a rendered field actually changed.
describe('publishMetadataRewrite casing-aware meta fields', () => {
  const fmModule = require('../services/content-astro/frontmatter');

  const SERVICE_PAGE = [
    '---',
    'metaTitle: "Old Sarasota Service Meta Title"',
    'metaDescription: "Old Sarasota service meta description."',
    'slug: "pest-control-sarasota-fl"',
    'canonical: "https://www.wavespestcontrol.com/pest-control-sarasota-fl/"',
    'modified: "2026-01-01T12:00:00"',
    '---',
    'Service body that must not change.',
  ].join('\n');

  const SERVICE_BRIEF = {
    action_type: 'rewrite_title_meta',
    target_url: 'https://www.wavespestcontrol.com/pest-control-sarasota-fl/',
    city: 'Sarasota',
    service: 'pest',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    gh.createBranch.mockResolvedValue({});
    gh.putFile.mockResolvedValue({ commit: { sha: 'meta-commit-sha' } });
    gh.createPr.mockResolvedValue({ number: 91, html_url: 'https://github.com/wavespestcontrolfl/wavespestcontrol-astro/pull/91', head: { sha: 'h' } });
    gh.createIssueComment.mockResolvedValue({});
  });

  test('writes metaTitle/metaDescription on a camelCase service page and never adds title/meta_description duplicates', async () => {
    gh.getFile.mockResolvedValue({ sha: 'svc-sha', content: SERVICE_PAGE });

    const res = await AstroPublisher.publishMetadataRewrite({
      type: 'metadata',
      title: 'Pest Control Sarasota FL | Waves Pest Control',
      meta_description: 'New Sarasota service meta description that will actually render.',
    }, SERVICE_BRIEF);

    expect(res.status).toBe('pr_open');
    const { data, content } = fmModule.parse(gh.putFile.mock.calls[0][0].content);
    // Rendered fields updated…
    expect(data.metaTitle).toBe('Pest Control Sarasota FL | Waves Pest Control');
    expect(data.metaDescription).toBe('New Sarasota service meta description that will actually render.');
    // …and NO dead snake_case duplicates created.
    expect(data.title).toBeUndefined();
    expect(data.meta_description).toBeUndefined();
    // Body untouched; rendered change → legitimate `modified` bump.
    expect(content).toContain('Service body that must not change.');
    expect(data.modified).not.toBe('2026-01-01T12:00:00');
    expect(String(data.modified)).toMatch(/^\d{4}-\d{2}-\d{2}T12:00:00$/);
    // PR title/body reflect the field that was actually written.
    expect(gh.createPr).toHaveBeenCalledWith(expect.objectContaining({
      title: expect.stringContaining('SEO metadata: Pest Control Sarasota FL'),
      body: expect.stringContaining('| metaTitle |'),
    }));
  });

  test('no-op rewrite (values already match the rendered fields) returns no_changes and does not bump modified', async () => {
    gh.getFile.mockResolvedValue({ sha: 'svc-sha', content: SERVICE_PAGE });

    const res = await AstroPublisher.publishMetadataRewrite({
      type: 'metadata',
      title: 'Old Sarasota Service Meta Title',
      meta_description: 'Old Sarasota service meta description.',
    }, SERVICE_BRIEF);

    expect(res.status).toBe('no_changes');
    expect(gh.putFile).not.toHaveBeenCalled();
    expect(gh.createPr).not.toHaveBeenCalled();
  });

  test('snake_case blog page still writes title/meta_description (and bumps `updated`, not metaTitle)', async () => {
    const BLOG_PAGE = [
      '---',
      'title: "Drywood Termite Signs in Sarasota Homes"',
      'slug: "/blog/drywood-termite-signs-sarasota/"',
      'meta_description: "Spot drywood termite signs in your Sarasota home early: frass piles, blistered paint, and discarded wings. Here is what Waves techs look for."',
      'primary_keyword: "drywood termite signs"',
      'secondary_keywords:',
      '  - "termite frass"',
      'category: "termite"',
      'post_type: "diagnostic"',
      'service_areas_tag:',
      '  - "Sarasota"',
      'related_services: []',
      'spoke_links: []',
      'author:',
      '  name: "Adam Benetti"',
      '  role: "Lead Technician"',
      '  bio_url: "/about/authors/adam-benetti"',
      'technically_reviewed_by:',
      '  name: "Adam Benetti"',
      '  credential: "FDACS Certified Operator"',
      '  bio_url: "/about/authors/adam-benetti"',
      'fact_checked_by: "Waves Editorial"',
      'published: "2026-05-01"',
      'updated: "2026-05-01"',
      'technically_reviewed: "2026-05-01"',
      'fact_checked: "2026-05-01"',
      'review_cadence: "quarterly"',
      'reading_time_min: 5',
      'hero_image:',
      '  src: "/images/blog/drywood/hero.webp"',
      '  alt: "Drywood termite frass on a windowsill"',
      'og_image: "/images/blog/drywood/hero.webp"',
      'canonical: "https://www.wavespestcontrol.com/blog/drywood-termite-signs-sarasota/"',
      'schema_types:',
      '  - "Article"',
      'disclosure:',
      '  type: "none"',
      '---',
      'Original drywood termite body content for the live blog post.',
    ].join('\n');

    gh.getFile.mockImplementation(async (path) => (
      path === 'src/content/blog/drywood-termite-signs-sarasota.md'
        ? { sha: 'blog-sha', content: BLOG_PAGE }
        : null
    ));

    const res = await AstroPublisher.publishMetadataRewrite({
      type: 'metadata',
      title: 'Drywood Termite Signs Sarasota Homeowners Miss',
      meta_description: 'Drywood termite signs Sarasota homeowners miss: frass piles, blistered paint, discarded wings. Here is what Waves techs check before quoting treatment.',
    }, {
      action_type: 'rewrite_title_meta',
      target_url: '/blog/drywood-termite-signs-sarasota/',
    });

    expect(res.status).toBe('pr_open');
    const { data } = fmModule.parse(gh.putFile.mock.calls[0][0].content);
    expect(data.title).toBe('Drywood Termite Signs Sarasota Homeowners Miss');
    expect(data.meta_description).toContain('Drywood termite signs Sarasota homeowners miss');
    // No camelCase fields invented on a snake_case blog page.
    expect(data.metaTitle).toBeUndefined();
    expect(data.metaDescription).toBeUndefined();
    // Blog freshness field is `updated` — bumped because rendered fields changed.
    expect(data.updated).not.toBe('2026-05-01');
    expect(String(data.updated)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
