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
  commitFiles: jest.fn(),
  createPr: jest.fn(),
  findOpenPrByHead: jest.fn(),
  createIssueComment: jest.fn(),
  listIssueComments: jest.fn(),
  listPrReviews: jest.fn(),
  getPr: jest.fn(),
  mergePr: jest.fn(),
  deleteFile: jest.fn(),
  closePr: jest.fn(),
  deleteRef: jest.fn(),
  getBlob: jest.fn(),
  listDir: jest.fn(),
  compareFiles: jest.fn(),
  getBranchSha: jest.fn(),
  env: jest.fn(() => ({ defaultBranch: 'main' })),
  retireBranch: jest.fn().mockResolvedValue(true),
}));
// publishAstro's topic-targeting gate (owner rulings 2026-08-27) loads the
// live blog corpus for NEW posts and fails closed without one — stub a
// benign corpus so the pipeline tests reach the publisher behavior under test.
// (The planner is an instance — mutate the actual module rather than
// spreading it, so its prototype methods stay spy-able below.)
jest.mock('../services/content/internal-link-planner', () => {
  const actual = jest.requireActual('../services/content/internal-link-planner');
  actual.loadAstroCorpusFromGitHub = jest.fn().mockResolvedValue([{
    file: 'src/content/blog/quokka-habitat-notes.md',
    url: '/quokka-habitat-notes/',
    body: '---\ntitle: Quokka Habitat Notes\nslug: /quokka-habitat-notes/\nprimary_keyword: quokka habitat\n---\n\n## Quokka basics\n',
  }]);
  return actual;
});
jest.mock('../services/content-astro/author-service', () => ({
  getAuthor: jest.fn(),
}));
jest.mock('../services/content/image-generator', () => ({
  generate: jest.fn(),
  planFor: jest.fn(() => ({ style: 'photo', setting: 'inside a residential garage', timeOfDay: 'late afternoon', vantage: 'eye level' })), retryStyleFor: jest.fn(() => 'illustration'), IMAGE_CHAIN_BUDGET_MS: 360000,
}));
jest.mock('../services/content/fact-check-gate', () => ({
  evaluate: jest.fn().mockResolvedValue({ pass: true, findings: [], checked: false }),
}));
jest.mock('../services/content/hero-alt-vision', () => ({
  describeHeroForAlt: jest.fn().mockResolvedValue(null),
  // The text/logo screen: clean by default (fail-open shape).
  screenGeneratedImage: jest.fn().mockResolvedValue({ ok: true, checked: true, readableText: [], logos: [], reasons: [] }),
}));

const db = require('../models/db');
// codex-remediation's terminal stamp runs db.raw() — a plain success here.
beforeEach(() => { db.raw = jest.fn().mockResolvedValue({ rowCount: 1 }); });
const factCheckGate = require('../services/content/fact-check-gate');
// Topic-gated merges run recheck → merge inside db.transaction under a
// Postgres advisory lock (topic-targeting-gate.withTopicMergeLock); the bare
// jest.fn() db needs a transaction that grants the lock by default.
function grantTopicMergeLock(locked = true) {
  db.transaction = jest.fn(async (fn) => fn({ raw: jest.fn().mockResolvedValue({ rows: [{ locked }] }) }));
}
beforeEach(() => grantTopicMergeLock(true));
const gh = require('../services/content-astro/github-client');
const authorService = require('../services/content-astro/author-service');
const { validateBlogFrontmatter } = require('../services/content-astro/schema-validator');
const PagesPoll = require('../services/content-astro/pages-poll');
const AstroPublisher = require('../services/content-astro/astro-publisher');
const ContentScheduler = require('../services/content-scheduler');
const heroImageGenerator = require('../services/content/image-generator');
const heroAltVision = require('../services/content/hero-alt-vision');

// 1x1 transparent PNG — enough for the real sharp compressToWebp step that
// runs inside the autonomous hero pipeline.
const HERO_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// publishAstro/publishAstroDraft write hero bytes + markdown (+ any legacy
// .md removal) as ONE git-data commit via gh.commitFiles — per-file Contents
// API commits raced Cloudflare's branch-deployment registration (PR #374).
// This fan-out shim forwards each committed entry to the legacy putFile /
// putBinary / deleteFile mocks so the content assertions below keep reading
// through them; the single-commit contract itself is asserted directly on
// gh.commitFiles where it matters. Installed once at module scope —
// jest.clearAllMocks() clears calls, not implementations.
beforeAll(() => {
  gh.commitFiles.mockImplementation(async ({ branch, message, files = [], deletes = [] }) => {
    let last = null;
    for (const f of files) {
      last = Buffer.isBuffer(f.buffer)
        ? await gh.putBinary({ path: f.path, buffer: f.buffer, message, branch, sha: undefined })
        : await gh.putFile({ path: f.path, content: f.content, message, branch, sha: undefined });
    }
    for (const path of deletes) await gh.deleteFile({ path, message, branch, sha: 'tree-delete' });
    return last || { commit: { sha: 'file-sha' } };
  });
});

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
    meta_description: 'Bradenton homeowners can use this guide to identify ant trails, reduce entry points, and spot trouble early. Learn more on the Waves blog.',
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

  test('service-area inference covers ONLY genuinely absent data — stored invalid values stay empty for validation to reject (Codex r2)', async () => {
    const base = {
      title: 'Ant Pressure Basics',
      slug: 'ant-pressure-basics',
      meta_description: 'A short guide to household ant pressure and what drives it.',
      keyword: 'ant control basics',
      tag: 'Ants',
      featured_image_url: '/images/blog/ant-pressure-basics/hero.png',
      hero_image_alt: 'Ant trail near a patio',
      content: 'Ant trails around patios often start with moisture and food access.',
    };
    // Absent → inferred (DEFAULT_SERVICE_AREAS fallback keeps the row alive).
    const absent = await AstroPublisher.buildFrontmatter({ ...base });
    expect(absent.service_areas_tag.length).toBeGreaterThan(0);
    // Present but invalid (mistyped / out-of-area) → NOT inferred over; the
    // empty result must reach assertValidBlogFrontmatter and reject the row.
    const invalid = await AstroPublisher.buildFrontmatter({ ...base, service_areas_tag: ['Tampa'] });
    expect(invalid.service_areas_tag).toEqual([]);
    // A valid city must NOT stand in for present-but-invalid stored areas
    // (Codex r3) — city substitution is for absent data only.
    const invalidWithCity = await AstroPublisher.buildFrontmatter({ ...base, service_areas_tag: ['Tampa'], city: 'Sarasota' });
    expect(invalidWithCity.service_areas_tag).toEqual([]);
    const absentWithCity = await AstroPublisher.buildFrontmatter({ ...base, city: 'Sarasota' });
    expect(absentWithCity.service_areas_tag).toEqual(['Sarasota']);
    // An explicit EMPTY array is an operator CLEARING the field via the
    // admin editor — present data, never inferred over (Codex r12); it
    // reaches validation empty and rejects, same contract as the backfill.
    const explicitEmpty = await AstroPublisher.buildFrontmatter({ ...base, service_areas_tag: [], city: 'Sarasota' });
    expect(explicitEmpty.service_areas_tag).toEqual([]);
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

  test('schemaTypesForContent preserves BlogPosting (allowed by blog-schema) and drops unknown types', () => {
    expect(AstroPublisher._internals.schemaTypesForContent('Some body.', ['BlogPosting', 'BreadcrumbList']))
      .toEqual(['BlogPosting', 'BreadcrumbList']);
    expect(AstroPublisher._internals.schemaTypesForContent('Some body.', ['Article', 'NotARealType']))
      .toEqual(['Article']);
  });

  describe('categoryRouteSlug (blog URL protocol /{category}/{slug}/)', () => {
    const { categoryRouteSlug } = AstroPublisher._internals;

    test('prefixes a flat writer slug with the category', () => {
      expect(categoryRouteSlug('plaster-bagworms-southwest-florida', 'pest-control'))
        .toBe('pest-control/plaster-bagworms-southwest-florida');
    });

    test('is idempotent on an already-correct {category}/{leaf}', () => {
      expect(categoryRouteSlug('lawn-care/chinch-bugs-bradenton', 'lawn-care'))
        .toBe('lawn-care/chinch-bugs-bradenton');
    });

    test('realigns a wrong-category prefix to the resolved category (keeps the leaf)', () => {
      expect(categoryRouteSlug('lawn-care/dangerous-ants-in-florida', 'pest-control'))
        .toBe('pest-control/dangerous-ants-in-florida');
    });

    test('uses the category for every supported vertical, not a hardcoded one', () => {
      expect(categoryRouteSlug('dollar-spot-venice', 'lawn-care')).toBe('lawn-care/dollar-spot-venice');
      expect(categoryRouteSlug('drywood-swarmers-venice', 'termite')).toBe('termite/drywood-swarmers-venice');
      expect(categoryRouteSlug('summer-mosquitoes', 'mosquito')).toBe('mosquito/summer-mosquitoes');
    });

    test('collapses a deeper-than-two-segment slug to {category}/{leaf}', () => {
      expect(categoryRouteSlug('/pest-control/sub/foo/', 'pest-control')).toBe('pest-control/foo');
    });

    test('falls back to the bare leaf when no category resolves', () => {
      expect(categoryRouteSlug('/foo/', '')).toBe('foo');
    });
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

  test('Codex verdict footer quoting "@codex review" is not a review request (astro #472 deadlock)', () => {
    const { codexReviewStatus, latestReviewRequestAt } = AstroPublisher._internals;
    const head = '43b0fc619a886544c7eade292b1a3126a1748914';
    const comments = [
      {
        user: { login: 'wavespestcontrolfl' },
        body: `@codex review\n\nAll posted findings are addressed on head \`${head}\`.`,
        created_at: '2026-08-22T01:33:59Z',
      },
      {
        user: { login: 'chatgpt-codex-connector[bot]' },
        body: "Codex Review: Didn't find any major issues. Swish!\n\n**Reviewed commit:** `43b0fc619a`\n\n<details><summary>About Codex in GitHub</summary>\n- Comment \"@codex review\".\n</details>",
        created_at: '2026-08-22T01:37:16Z',
      },
    ];
    expect(latestReviewRequestAt(comments, head)).toBe(Date.parse('2026-08-22T01:33:59Z'));
    expect(codexReviewStatus({ headSha: head, comments })).toEqual({ clean: true });
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

  test('accepts a comment-only clean verdict embedding an abbreviated (10-char) reviewed SHA', () => {
    // Real Codex shape (astro PR #357): the clean verdict is an ISSUE COMMENT
    // with "Reviewed commit: `<10 hex chars>`" and no review object at all.
    const { codexReviewStatus } = AstroPublisher._internals;
    const head = 'f20181fa400ef698a6b34f6247c9a45dc288a1bc';
    const request = {
      user: { login: 'wavespestcontrolfl' },
      body: `@codex review\n\nAddressed the review findings on head \`${head}\`. Please re-review.`,
      created_at: '2026-07-07T02:57:36Z',
    };
    expect(codexReviewStatus({
      headSha: head,
      comments: [request, {
        user: { login: 'chatgpt-codex-connector' },
        body: "Codex Review: Didn't find any major issues. Chef's kiss.\n\n**Reviewed commit:** `f20181fa40`",
        created_at: '2026-07-07T03:01:32Z',
      }],
    })).toEqual({ clean: true });

    // A reviewed SHA that is NOT a prefix of the head stays ineligible.
    expect(codexReviewStatus({
      headSha: head,
      comments: [request, {
        user: { login: 'chatgpt-codex-connector' },
        body: "Codex Review: Didn't find any major issues.\n\n**Reviewed commit:** `294aaa24da`",
        created_at: '2026-07-07T03:01:32Z',
      }],
    })).toMatchObject({ clean: false });
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

    expect(gh.createBranch).toHaveBeenCalledWith(expect.stringMatching(/^content\/autonomous-pest-control-ant-trails-bradenton-/));
    expect(gh.putFile).toHaveBeenCalledWith(expect.objectContaining({
      path: 'src/content/blog/pest-control/ant-trails-bradenton.mdx',
      content: expect.stringContaining('Waves Pest Control guidance'),
      message: 'feat(blog): publish pest-control/ant-trails-bradenton',
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
      url: 'https://www.wavespestcontrol.com/pest-control/ant-trails-bradenton/',
      status: 'pr_open',
      live: false,
      pr_number: 123,
      pr_url: 'https://github.com/wavespestcontrolfl/waves-astro/pull/123',
      commit_sha: 'file-sha',
    });
  });

  test('a spoke-routed draft with an OFF-SITE emitted canonical parks — spoke routing must not erase the canonical before the guard (Codex r5)', async () => {
    jest.clearAllMocks();
    gh.createBranch.mockResolvedValue({});
    gh.getFile.mockResolvedValue(null);
    gh.putFile.mockResolvedValue({ commit: { sha: 'file-sha' } });
    gh.createPr.mockResolvedValue({ number: 123, html_url: 'https://github.com/wavespestcontrolfl/waves-astro/pull/123' });
    gh.createIssueComment.mockResolvedValue({});
    mockHeroGeneration();

    const prev = process.env.SPOKE_BLOG_NETWORK_ENABLED;
    process.env.SPOKE_BLOG_NETWORK_ENABLED = 'true';
    try {
      await expect(AstroPublisher.publishOrUpdatePage(
        {
          type: 'draft',
          frontmatter: validFrontmatter({
            slug: '/ant-trails-bradenton/',
            canonical: 'https://competitor.example/post/',
          }),
          body: 'Waves Pest Control guidance for Bradenton homeowners.',
        },
        { action_type: 'new_supporting_blog', target_sites: ['veniceflpestcontrol.com'] }
      )).rejects.toThrow(/points off-site/);
    } finally {
      if (prev === undefined) delete process.env.SPOKE_BLOG_NETWORK_ENABLED;
      else process.env.SPOKE_BLOG_NETWORK_ENABLED = prev;
    }
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
          tracking: {
            number_key: 'venice_lawn',
            domains: ['veniceflpestcontrol.com'],
            robots: 'index, follow',
          },
        }),
        body: 'Waves Pest Control guidance for Bradenton homeowners.',
      },
      { action_type: 'new_supporting_blog' }
    );

    const fmModule = require('../services/content-astro/frontmatter');
    const markdownCall = gh.putFile.mock.calls.find(([arg]) => String(arg.path || '').endsWith('/ant-trails-bradenton.mdx'));
    const parsed = fmModule.parse(markdownCall[0].content);
    expect(parsed.data.domains).toEqual(['wavespestcontrol.com']);
    expect(parsed.data.tracking).toEqual({
      number_key: 'venice_lawn',
      domains: ['wavespestcontrol.com'],
      robots: 'index, follow',
    });
    expect(parsed.data.canonical).toBe('https://www.wavespestcontrol.com/pest-control/ant-trails-bradenton/');
  });

  test('normalizes raw autonomous blog frontmatter before schema validation', async () => {
    jest.clearAllMocks();
    gh.createBranch.mockResolvedValue({});
    gh.getFile.mockResolvedValue(null);
    gh.putFile.mockResolvedValue({ commit: { sha: 'file-sha' } });
    gh.createPr.mockResolvedValue({ number: 125, html_url: 'https://github.com/wavespestcontrolfl/waves-astro/pull/125' });
    gh.createIssueComment.mockResolvedValue({});
    mockHeroGeneration();

    await AstroPublisher.publishOrUpdatePage(
      {
        type: 'draft',
        frontmatter: {
          title: 'Orkin vs. a Local SWFL Pest Control Company',
          slug: '/pest-control/orkin-vs-local-pest-control-swfl/',
          canonical: '/pest-control/orkin-vs-local-pest-control-swfl/',
          meta_description: 'Fair Orkin versus local Southwest Florida pest control comparison covering scale, accountability, and switching. Learn more on the Waves blog.',
          primary_keyword: 'orkin vs local pest control',
          secondary_keywords: ['local pest control SWFL'],
          category: 'pest-library',
          page_type: 'supporting-blog',
          service: 'pest',
          publish_date: '2026-06-13',
          operator_brief_id: 'operator-brief-1',
          hero_image_alt: 'Technician checking a home exterior in Southwest Florida',
        },
        body: 'A comparison for Southwest Florida homeowners choosing between a national pest brand and local service.',
      },
      { action_type: 'new_supporting_blog', service: 'pest', target_keyword: 'orkin vs local pest control', schema_types: ['Article', 'BreadcrumbList', 'FAQPage'] }
    );

    const fmModule = require('../services/content-astro/frontmatter');
    const markdownCall = gh.putFile.mock.calls.find(([arg]) => String(arg.path || '').endsWith('/pest-control/orkin-vs-local-pest-control-swfl.mdx'));
    const parsed = fmModule.parse(markdownCall[0].content);
    expect(validateBlogFrontmatter(parsed.data)).toEqual({ ok: true, errors: [] });
    expect(parsed.data.slug).toBe('/pest-control/orkin-vs-local-pest-control-swfl/');
    expect(parsed.data.canonical).toBe('https://www.wavespestcontrol.com/pest-control/orkin-vs-local-pest-control-swfl/');
    expect(parsed.data.category).toBe('pest-control');
    expect(parsed.data.post_type).toBe('location');
    expect(parsed.data.schema_types).toEqual(['Article', 'BreadcrumbList']);
    expect(parsed.data.service_areas_tag).toContain('Sarasota');
    expect(parsed.data.related_services).toEqual([]);
    expect(parsed.data.domains).toEqual(['wavespestcontrol.com']);
    expect(parsed.data.tracking).toEqual({ domains: ['wavespestcontrol.com'] });
    expect(parsed.data).not.toHaveProperty('page_type');
    expect(parsed.data).not.toHaveProperty('service');
    expect(parsed.data).not.toHaveProperty('operator_brief_id');
  });

  test('stamps a missing autonomous canonical from the emitted slug', async () => {
    jest.clearAllMocks();
    gh.createBranch.mockResolvedValue({});
    gh.getFile.mockResolvedValue(null);
    gh.putFile.mockResolvedValue({ commit: { sha: 'file-sha' } });
    gh.createPr.mockResolvedValue({ number: 126, html_url: 'https://github.com/wavespestcontrolfl/waves-astro/pull/126' });
    gh.createIssueComment.mockResolvedValue({});
    mockHeroGeneration();

    const result = await AstroPublisher.publishOrUpdatePage(
      {
        type: 'draft',
        frontmatter: {
          title: 'Banana Spiders in Florida: What That Giant Golden Web Actually Is',
          slug: 'banana-spiders-in-florida',
          meta_description: 'That huge golden web on your lanai is usually a Florida banana spider. Learn what they are, whether they bite, and when to call a pro.',
          primary_keyword: 'banana spiders in florida',
          category: 'pest-library',
          publish_date: '2026-06-13',
          tags: ['spiders'],
        },
        body: 'Florida banana spider identification and practical guidance for homeowners.',
      },
      { action_type: 'new_supporting_blog', service: 'pest', target_keyword: 'banana spiders in florida' }
    );

    const fmModule = require('../services/content-astro/frontmatter');
    const markdownCall = gh.putFile.mock.calls.find(([arg]) => String(arg.path || '').endsWith('/banana-spiders-in-florida.mdx'));
    const parsed = fmModule.parse(markdownCall[0].content);
    expect(result.url).toBe('https://www.wavespestcontrol.com/pest-control/banana-spiders-in-florida/');
    expect(parsed.data.canonical).toBe('https://www.wavespestcontrol.com/pest-control/banana-spiders-in-florida/');
    // Blog URL protocol: the FLAT writer slug is realigned to /{category}/{slug}/
    // so the astro blog-slug-protocol guardrail (slug.first-segment === category)
    // passes instead of failing every Pages build.
    expect(parsed.data.slug).toBe('/pest-control/banana-spiders-in-florida/');
    expect(parsed.data.category).toBe('pest-control');
    // …and the committed markdown FILE lives at the category route path (1:1 with
    // the URL), so no flat/nested duplicate of the same route can be committed.
    expect(markdownCall[0].path).toBe('src/content/blog/pest-control/banana-spiders-in-florida.mdx');
    expect(validateBlogFrontmatter(parsed.data)).toEqual({ ok: true, errors: [] });
    expect(parsed.data).not.toHaveProperty('tags');
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
      url: 'https://www.wavespestcontrol.com/pest-control/yellow-lawn-sarasota/',
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

  test('rejects autonomous drafts whose canonical points to a DIFFERENT post (different leaf)', async () => {
    jest.clearAllMocks();
    const frontmatter = validFrontmatter({
      slug: '/ant-trails-bradenton/',
      canonical: 'https://www.wavespestcontrol.com/roach-trails-sarasota/',
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

describe('autonomous frontmatter normalization (Bucket A generator fixes)', () => {
  const { assertCanonicalMatchesSlug, canonicalUrlForSlug, clampMetaDescription } = AstroPublisher._internals;

  describe('assertCanonicalMatchesSlug — writer canonical is advisory', () => {
    test('derives canonical from slug when the draft omits it', () => {
      const fm = { slug: '/pest-control/ant-trails/', canonical: '' };
      const out = assertCanonicalMatchesSlug(fm, 'pest-control/ant-trails');
      expect(out).toBe(canonicalUrlForSlug('pest-control/ant-trails'));
      expect(fm.canonical).toBe(out);
    });

    test('accepts a category-prefix variant (flat slug + category canonical, same leaf) and normalizes to the slug', () => {
      const fm = { slug: '/ant-trails/', canonical: 'https://www.wavespestcontrol.com/pest-control/ant-trails/' };
      expect(() => assertCanonicalMatchesSlug(fm, 'ant-trails')).not.toThrow();
      expect(fm.canonical).toBe(canonicalUrlForSlug('ant-trails'));
    });

    test('accepts a malformed canonical (derives from slug instead of wasting the generation)', () => {
      const fm = { slug: '/ant-trails/', canonical: 'not a valid url' };
      expect(() => assertCanonicalMatchesSlug(fm, 'ant-trails')).not.toThrow();
      expect(fm.canonical).toBe(canonicalUrlForSlug('ant-trails'));
    });

    test('still rejects a canonical pointing to a genuinely different post (different leaf)', () => {
      const fm = { slug: '/ant-trails/', canonical: 'https://www.wavespestcontrol.com/roach-trails/' };
      expect(() => assertCanonicalMatchesSlug(fm, 'ant-trails')).toThrow(/canonical must match slug/);
    });

    test('repairs a RELATIVE canonical (derives from slug, keeps the generation)', () => {
      const fm = { slug: '/ant-trails/', canonical: '/pest-control/ant-trails/' };
      expect(() => assertCanonicalMatchesSlug(fm, 'pest-control/ant-trails')).not.toThrow();
      expect(fm.canonical).toBe(canonicalUrlForSlug('pest-control/ant-trails'));
    });

    test('repairs a same-leaf canonical on a FLEET (spoke) host — on-fleet drift is publisher-owned', () => {
      const fm = { slug: '/ant-trails/', canonical: 'https://sarasotaflpestcontrol.com/ant-trails/' };
      expect(() => assertCanonicalMatchesSlug(fm, 'ant-trails')).not.toThrow();
      expect(fm.canonical).toBe(canonicalUrlForSlug('ant-trails'));
    });

    test('REJECTS an off-site canonical even with a matching leaf — never repaired into a publish', () => {
      const fm = { slug: '/ant-trails/', canonical: 'https://evil.example.com/ant-trails/' };
      expect(() => assertCanonicalMatchesSlug(fm, 'ant-trails')).toThrow(/canonical points off-site/);
      // The rejection message is in the runner's deterministic-park list, so
      // the run parks for review instead of retry-looping.
      expect(fm.canonical).toBe('https://evil.example.com/ant-trails/'); // untouched — no silent repair
    });

    test('REJECTS a protocol-relative off-site canonical (//host/… carries a host of its own)', () => {
      const fm = { slug: '/ant-trails/', canonical: '//evil.example.com/ant-trails/' };
      expect(() => assertCanonicalMatchesSlug(fm, 'ant-trails')).toThrow(/canonical points off-site/);
    });

    test('REJECTS a slash-backslash off-site canonical — the WHATWG parser resolves /\\host/… as HOST-BEARING (Codex r9)', () => {
      // A raw "starts with a single slash" test would classify this as
      // path-relative and skip the fleet check; the parsed hostname is the
      // truth.
      const fm = { slug: '/ant-trails/', canonical: '/\\evil.example.com/ant-trails/' };
      expect(() => assertCanonicalMatchesSlug(fm, 'ant-trails')).toThrow(/canonical points off-site/);
      expect(fm.canonical).toBe('/\\evil.example.com/ant-trails/'); // untouched — no silent repair
    });

    test('REJECTS a network-path off-site canonical — \\\\host/… resolves host-bearing against the base (Codex r10)', () => {
      // A base-less parse THROWS on this form, and the old catch branch then
      // silently replaced the foreign canonical instead of parking it.
      const fm = { slug: '/ant-trails/', canonical: '\\\\evil.example.com/ant-trails/' };
      expect(() => assertCanonicalMatchesSlug(fm, 'ant-trails')).toThrow(/canonical points off-site/);
      expect(fm.canonical).toBe('\\\\evil.example.com/ant-trails/'); // untouched — no silent repair
    });
  });

  describe('clampMetaDescription — over-160 is normalized, not rejected', () => {
    test('leaves a within-limit meta unchanged', () => {
      const m = 'A clear, useful meta description about ant trails in Bradenton homes and when it is worth calling a pro for help.';
      expect(m.length).toBeLessThanOrEqual(160);
      expect(clampMetaDescription(m)).toBe(m);
    });

    test('clamps an over-160 single-sentence meta at a word boundary and closes it with a period', () => {
      const long = 'Ant trails in Bradenton homes can signal a much bigger colony nearby; here is exactly how to identify them, seal the entry points, and decide when a professional inspection is genuinely worth the cost this season.';
      expect(long.length).toBeGreaterThan(160);
      const out = clampMetaDescription(long);
      expect(out.length).toBeLessThanOrEqual(160);
      expect(out.length).toBeGreaterThanOrEqual(115);
      // No complete sentence fits in 160, so the clamp word-cuts, drops any
      // dangling connective, and closes the fragment with a period — the
      // shipped meta always reads as finished copy.
      expect(long.startsWith(out.slice(0, -1))).toBe(true);
      expect(out.endsWith('.')).toBe(true);
      expect(/[\s,;:–—-]\.$/u.test(out)).toBe(false);
    });

    test('clamps an over-160 multi-sentence meta at the last complete sentence', () => {
      const long = 'Ant trails in Bradenton homes can signal a much bigger colony nearby. Here is how to identify them and seal the entry points fast. A professional inspection is genuinely worth the cost this season.';
      expect(long.length).toBeGreaterThan(160);
      const out = clampMetaDescription(long);
      expect(out).toBe('Ant trails in Bradenton homes can signal a much bigger colony nearby. Here is how to identify them and seal the entry points fast.');
      expect(out.length).toBeGreaterThanOrEqual(115);
    });
  });
});

describe('autonomous draft length clamp (Bucket C)', () => {
  const { clampTitle, clampMetaDescription } = AstroPublisher._internals;
  const { evaluateTitleMetaSpam } = require('../services/content/title-meta-spam-gate');

  describe('clampTitle — over-90 is normalized, not rejected', () => {
    test('leaves a within-limit title unchanged', () => {
      const t = 'Ant Trails in Bradenton: How to Spot Them and When to Call a Pro';
      expect(t.length).toBeLessThanOrEqual(90);
      expect(clampTitle(t)).toBe(t);
    });

    test('clamps an over-90 title to <=90 at a word boundary with no trailing punctuation', () => {
      const long = 'Ant Trails in Bradenton Homes: How to Identify Them, Seal the Entry Points, and Decide When It Is Worth Calling a Professional';
      expect(long.length).toBeGreaterThan(90);
      const out = clampTitle(long);
      expect(out.length).toBeLessThanOrEqual(90);
      expect(long.startsWith(out)).toBe(true);
      expect(out.includes(' ')).toBe(true); // didn't collapse to one mangled word
      expect(/[\s.,;:–—-]$/u.test(out)).toBe(false);
    });
  });

  test('clamped title + meta satisfy the spam gate length checks that were hard-failing in prod', () => {
    // Reproduces the prod failure shapes: title_length_98_over_90 + meta_length_200_over_190.
    const longTitle = 'The Complete Bradenton Homeowner Guide to Spotting Ant Trails Early and Knowing Exactly When to Call a Pro Today';
    const longMeta = 'Ant trails in Bradenton homes can signal a much bigger colony hiding somewhere close, so here is exactly how to identify the trail, seal the entry points yourself, and decide when an inspection is truly worth it.';
    expect(longTitle.length).toBeGreaterThan(90);
    expect(longMeta.length).toBeGreaterThan(190);

    // Raw draft hard-fails the gate on length.
    const raw = evaluateTitleMetaSpam({ title: longTitle, meta_description: longMeta });
    expect(raw.ok).toBe(false);
    expect(raw.hard_failures.map((f) => f.reason).join(',')).toMatch(/title_length|meta_length/);

    // After the clamp the length hard-fails are gone — the draft publishes instead of being parked.
    const clamped = evaluateTitleMetaSpam({
      title: clampTitle(longTitle),
      meta_description: clampMetaDescription(longMeta),
    });
    expect(clamped.ok).toBe(true);
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
      url: 'https://www.wavespestcontrol.com/pest-control/autonomous-ant-control-bradenton/',
      pr_number: 42,
      pr_url: 'https://github.com/wavespestcontrolfl/wavespestcontrol-astro/pull/42',
    });
    expect(gh.putFile).toHaveBeenCalledWith(expect.objectContaining({
      path: 'src/content/blog/pest-control/autonomous-ant-control-bradenton.mdx',
      branch: expect.stringMatching(/^content\/autonomous-pest-control-autonomous-ant-control-bradenton-/),
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
    // .mdx does not exist yet; the legacy .md lives at the FLAT path (legacy
    // posts pre-date category subdirs). The route-first lookup must fall through
    // the nested category path and find it here.
    gh.getFile.mockImplementation(async (path) =>
      path === 'src/content/blog/legacy-ant-post.md'
        ? { sha: 'legacy-md-sha', path, content: '---\ntitle: Old\n---\nold body' }
        : null
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

    // Writes the .mdx at the category route path (no sha — it is a new file),
    // migrating the post off the flat legacy .md.
    expect(gh.putFile).toHaveBeenCalledWith(expect.objectContaining({
      path: 'src/content/blog/pest-control/legacy-ant-post.mdx',
      sha: undefined,
    }));
    // Deletes the superseded flat .md so we never leave both — in the SAME
    // single publish commit as the .mdx write (tree deletes need no sha).
    expect(gh.commitFiles).toHaveBeenCalledTimes(1);
    expect(gh.commitFiles.mock.calls[0][0].deletes).toEqual(['src/content/blog/legacy-ant-post.md']);
    expect(gh.deleteFile).toHaveBeenCalledWith(expect.objectContaining({
      path: 'src/content/blog/legacy-ant-post.md',
    }));
  });

  test('updates an existing category-path post in place for a flat draft slug (no duplicate route)', async () => {
    jest.clearAllMocks();
    gh.createBranch.mockResolvedValue({});
    // An existing post already lives at the NESTED category path and renders the
    // /pest-control/… route. A flat draft slug with the same leaf must update it
    // in place — not open a second flat file with the same Astro slug/canonical.
    gh.getFile.mockImplementation(async (path) =>
      path === 'src/content/blog/pest-control/drain-flies-sarasota-kitchens.mdx'
        ? { sha: 'existing-nested-sha', path, content: '---\ntitle: Old\nslug: /pest-control/drain-flies-sarasota-kitchens/\n---\nold body' }
        : null
    );
    gh.putFile.mockResolvedValue({ commit: { sha: 'file-sha' } });
    gh.createPr.mockResolvedValue({ number: 88, html_url: 'https://github.com/wavespestcontrolfl/wavespestcontrol-astro/pull/88' });
    gh.createIssueComment.mockResolvedValue({});
    mockHeroGeneration();

    await AstroPublisher.publishOrUpdatePage(
      {
        type: 'draft',
        frontmatter: validFrontmatter({
          slug: '/drain-flies-sarasota-kitchens/',
          canonical: 'https://www.wavespestcontrol.com/drain-flies-sarasota-kitchens/',
        }),
        body: 'Refreshed drain fly guidance for Sarasota kitchens.',
      },
      { action_type: 'new_supporting_blog' }
    );

    const fmModule = require('../services/content-astro/frontmatter');
    const markdownCall = gh.putFile.mock.calls.find(([arg]) => String(arg.path || '').endsWith('drain-flies-sarasota-kitchens.mdx'));
    // Writes the EXISTING nested path — an in-place update, not a new file.
    // (Tree commits replace the path unconditionally; no per-file sha.)
    expect(markdownCall[0].path).toBe('src/content/blog/pest-control/drain-flies-sarasota-kitchens.mdx');
    // Never opens a second flat file with the same route.
    expect(gh.putFile).not.toHaveBeenCalledWith(expect.objectContaining({
      path: 'src/content/blog/drain-flies-sarasota-kitchens.mdx',
    }));
    expect(fmModule.parse(markdownCall[0].content).data.slug).toBe('/pest-control/drain-flies-sarasota-kitchens/');
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
    heroAltVision.describeHeroForAlt.mockResolvedValue(null);
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
      path: 'public/images/blog/pest-control/dollar-spot-venice/hero.webp',
      branch: expect.stringMatching(/^content\/autonomous-pest-control-dollar-spot-venice-/),
      sha: undefined,
    }));
    // Compressed to WebP (RIFF/WEBP container) before commit — LCP path.
    const committed = gh.putBinary.mock.calls[0][0].buffer;
    expect(committed.slice(0, 4).toString('ascii')).toBe('RIFF');
    expect(committed.slice(8, 12).toString('ascii')).toBe('WEBP');
    // Hero and markdown land on the SAME feature branch, branch cut first.
    expect(gh.putFile.mock.calls[0][0].branch).toBe(gh.putBinary.mock.calls[0][0].branch);
    expect(gh.createBranch.mock.invocationCallOrder[0]).toBeLessThan(gh.putBinary.mock.invocationCallOrder[0]);
    // …and atomically, in ONE commit: a hero commit followed by a markdown
    // commit let Cloudflare register the branch deployment against the first
    // commit and starve the PR poller's head==deployment gate (PR #374).
    expect(gh.commitFiles).toHaveBeenCalledTimes(1);
    expect(gh.commitFiles.mock.calls[0][0].files.map((f) => f.path)).toEqual([
      'public/images/blog/pest-control/dollar-spot-venice/hero.webp',
      'src/content/blog/pest-control/dollar-spot-venice.mdx',
    ]);
    // Frontmatter stamped with the path that was actually committed.
    const parsed = fmModule.parse(gh.putFile.mock.calls[0][0].content);
    expect(parsed.data.hero_image).toEqual({
      src: '/images/blog/pest-control/dollar-spot-venice/hero.webp',
      alt: 'Dollar spot lesions on a Venice lawn',
    });
    expect(parsed.data.og_image).toBe('/images/blog/pest-control/dollar-spot-venice/hero.webp');
  });

  test('generated hero: vision-derived alt overrides the writer pre-image alt', async () => {
    gh.getFile.mockResolvedValue(null);
    mockHeroGeneration();
    heroAltVision.describeHeroForAlt.mockResolvedValue('Brown patch rings spreading across a St. Augustine lawn');

    await AstroPublisher.publishOrUpdatePage(heroDraft(), { action_type: 'new_supporting_blog' });

    // The vision pass sees the exact bytes we commit, plus the post context,
    // and runs inside what is left of the hero's slot deadline (Codex r9 P2 on #3964).
    expect(heroAltVision.describeHeroForAlt).toHaveBeenCalledWith(expect.objectContaining({
      buffer: gh.putBinary.mock.calls[0][0].buffer,
      title: 'Dollar Spot in Venice',
      timeoutMs: expect.any(Number),
    }));
    expect(heroAltVision.describeHeroForAlt.mock.calls[0][0].timeoutMs).toBeGreaterThan(0);
    const parsed = fmModule.parse(gh.putFile.mock.calls[0][0].content);
    expect(parsed.data.hero_image.alt).toBe('Brown patch rings spreading across a St. Augustine lawn');
  });

  test('vision alt failure falls back to the writer alt and never blocks the publish', async () => {
    gh.getFile.mockResolvedValue(null);
    mockHeroGeneration();
    heroAltVision.describeHeroForAlt.mockResolvedValue(null); // fail-open contract

    await AstroPublisher.publishOrUpdatePage(heroDraft(), { action_type: 'new_supporting_blog' });

    const parsed = fmModule.parse(gh.putFile.mock.calls[0][0].content);
    expect(parsed.data.hero_image.alt).toBe('Dollar spot lesions on a Venice lawn');
    expect(gh.createPr).toHaveBeenCalled();
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
    // Reused heroes keep their existing alt — no vision spend on refresh runs.
    expect(heroAltVision.describeHeroForAlt).not.toHaveBeenCalled();
    expect(gh.putFile).toHaveBeenCalledWith(expect.objectContaining({
      path: 'src/content/blog/dollar-spot-venice.mdx',
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
    expect(parsed.data.hero_image.src).toBe('/images/blog/pest-control/dollar-spot-venice/hero.webp');
    expect(parsed.data.og_image).toBe('/images/blog/pest-control/dollar-spot-venice/hero.webp');
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

  test('overwrites an already-published hero asset inside the single publish commit', async () => {
    const post = {
      id: 'post-1',
      title: 'Ant Trails in Bradenton',
      slug: 'ant-trails-bradenton',
      meta_description: 'Bradenton homeowners can use this guide to identify ant trails, reduce entry points, and spot trouble early. Learn more on the Waves blog.',
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

    const { screenGeneratedImage } = require('../services/content/hero-alt-vision');
    screenGeneratedImage.mockResolvedValueOnce({ ok: false, checked: true, readableText: ['ORKIN'], logos: ['Orkin logo'], reasons: ['logo or brand mark: Orkin logo'] });
    await AstroPublisher.publishAstro('post-1');

    // An admin-generated data: URL hero is screened again at publish time
    // and the PR body carries the verdict in bold (Codex r5 P2 on #3964).
    expect(screenGeneratedImage).toHaveBeenCalledWith(expect.objectContaining({ mimeType: 'image/png', buffer: expect.any(Buffer) }));
    const prBody = gh.createPr.mock.calls.at(-1)[0].body;
    expect(prBody).toContain('- hero: admin pre-generated (unplanned) — **screen flagged after retry: logo or brand mark: Orkin logo**');

    // The republish carries the fresh hero bytes in the single publish
    // commit — the tree write replaces the existing path unconditionally,
    // so no per-file sha handshake is needed (or possible) here.
    expect(gh.commitFiles).toHaveBeenCalledTimes(1);
    expect(gh.putBinary).toHaveBeenCalledWith(expect.objectContaining({
      path: 'public/images/blog/ant-trails-bradenton/hero.webp',
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
      meta_description: 'Bradenton homeowners can use this guide to identify ant trails, reduce entry points, and spot trouble early. Learn more on the Waves blog.',
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

  test('blocks a legacy-lane blog meta that violates the blog contract (phone/salesy) before opening a PR', async () => {
    // Owner rule 2026-07-29: blog metas carry NO phone and nothing salesy.
    // The BlogWriter/admin/calendar path runs ONLY guardrails (no
    // supporting-blog quality bundle), so publishAstro must declare
    // targetIsBlog for the contract to apply on this lane.
    const post = {
      id: 'post-1',
      title: 'Comparing Pest Control Options in Bradenton',
      slug: 'comparing-pest-control-options-bradenton',
      meta_description: 'Bradenton pest options compared for homeowners weighing plans this season. Call \u260e\ufe0f {{cityPhone}} now for a free estimate from Waves today.',
      keyword: 'pest control comparison Bradenton',
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
      hero_image_alt: 'Comparison of pest control options',
      content: 'Every option has trade-offs worth weighing before you pick a provider for your home.',
    };
    const read = chain({ first: jest.fn().mockResolvedValue(post) });
    const update = chain();
    const queries = [read, update];
    db.mockImplementation(() => queries.shift() || chain());

    await expect(AstroPublisher.publishAstro('post-1')).rejects.toThrow(/BLOG_META_CARRIES_PHONE/);
    expect(gh.createPr).not.toHaveBeenCalled();
  });

  test('blocks a post whose comparison table fails the named-competitor gate before opening a PR (manual lane previously skipped it)', async () => {
    const post = {
      id: 'post-1',
      title: 'Comparing Pest Control Options in Bradenton',
      slug: 'comparing-pest-control-options-bradenton',
      meta_description: 'A practical comparison of pest control options for Bradenton homeowners, covering service models and guarantees. Learn more on the Waves blog.',
      keyword: 'pest control comparison Bradenton',
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
      hero_image_alt: 'Comparison of pest control options',
      // A DEFINITE finding — a disparaging table cell ("Worst follow-up") is
      // a P0. The manual/calendar lane previously ran NO comparison scan at
      // all, so this could go fully live unattended via the scheduler
      // auto-merge.
      // Object-row shape only: ComparisonTable.astro reads row.label /
      // row.values[cIdx], so array rows crash the astro build and the
      // component schema rejects them by design (Codex round-10).
      content: '## How the options compare\n\n<ComparisonTable\n  caption="Pest control options in Bradenton"\n  columns={["What to weigh","National chains","DIY"]}\n  rows={[{ "label": "Follow-up", "values": ["Worst follow-up in the area","Your schedule"] }]}\n/>\n\nEvery option has trade-offs worth weighing.',
    };
    const read = chain({ first: jest.fn().mockResolvedValue(post) });
    const update = chain();
    const queries = [read, update];
    db.mockImplementation(() => queries.shift() || chain());

    await expect(AstroPublisher.publishAstro('post-1')).rejects.toThrow(/comparison\/named-competitor gate failed/);
    expect(gh.createBranch).not.toHaveBeenCalled();
    expect(gh.createPr).not.toHaveBeenCalled();
    expect(update.update).toHaveBeenCalledWith(expect.objectContaining({ astro_status: 'publish_failed' }));
  });

  test('a category-only comparison publishes — UNCLASSIFIED_OPTION ambiguity is advisory on the manual lane (Codex round 2)', async () => {
    const post = {
      id: 'post-1',
      title: 'Comparing Pest Control Options in Bradenton',
      slug: 'comparing-pest-control-options-bradenton',
      meta_description: 'A practical comparison of pest control options for Bradenton homeowners, covering service models and guarantees. Learn more on the Waves blog.',
      keyword: 'pest control comparison Bradenton',
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
      hero_image_alt: 'Comparison of pest control options',
      // No named competitor anywhere; the business-SHAPED title phrase
      // ("Comparing Pest Control") and generic category columns can only
      // produce fail-closed UNCLASSIFIED_OPTION ambiguity, which must not
      // strand a legitimate category comparison at publish_failed on a
      // human-initiated lane.
      content: '## How the options compare\n\n<ComparisonTable\n  caption="Pest control options in Bradenton"\n  columns={["What to weigh","National chains","Local pest control company","DIY"]}\n  rows={[{ "label": "Response time", "values": ["Call center queue","Same day","Your schedule"] }]}\n/>\n\nEvery option has trade-offs worth weighing before you choose.',
    };
    const read = chain({ first: jest.fn().mockResolvedValue(post) });
    const update = chain();
    const queries = [read, update];
    db.mockImplementation(() => queries.shift() || chain());

    await AstroPublisher.publishAstro('post-1');

    expect(gh.createPr).toHaveBeenCalled();
    expect(update.update).toHaveBeenCalledWith(expect.objectContaining({ astro_status: 'pr_open' }));
  });

  test('hub-only post with literal "Waves Pest Control" branding publishes (not treated as multi-domain)', async () => {
    const post = {
      id: 'post-1',
      title: 'Ant Trails in Bradenton',
      slug: 'ant-trails-bradenton',
      meta_description: 'Bradenton homeowners can use this guide to identify ant trails, reduce entry points, and spot trouble early. Learn more on the Waves blog.',
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
      meta_description: 'Bradenton homeowners can use this guide to spot early rodent activity and seal entry points before damage spreads. Learn more on the Waves blog.',
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
      meta_description: 'Bradenton homeowners can use this guide to identify ant trails, reduce entry points, and spot trouble early. Learn more on the Waves blog.',
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

describe('publishAstro stamps astro_requires_human_merge (audit lane 4b)', () => {
  beforeEach(() => { jest.clearAllMocks(); });
  afterEach(() => { jest.restoreAllMocks(); });

  function plainPost() {
    return {
      id: 'post-1',
      title: 'Ant Trails in Bradenton',
      slug: 'ant-trails-bradenton',
      meta_description: 'Bradenton homeowners can use this guide to identify ant trails, reduce entry points, and spot trouble early. Learn more on the Waves blog.',
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
      content: '## What you are seeing\n\nWaves Pest Control keeps Bradenton homes pest-free with seasonal treatments.',
    };
  }

  test('a competitor-free post stamps an explicit FALSE (a republish clears a stale stamp)', async () => {
    const read = chain({ first: jest.fn().mockResolvedValue(plainPost()) });
    const update = chain();
    const queries = [read, update];
    db.mockImplementation(() => queries.shift() || chain());

    await AstroPublisher.publishAstro('post-1');

    expect(update.update).toHaveBeenCalledWith(expect.objectContaining({
      astro_status: 'pr_open',
      astro_requires_human_merge: false,
    }));
  });

  test('a requiresHumanReview gate pass stamps TRUE from that exact evaluation', async () => {
    // A validated curated-competitor table passes the gate with
    // requiresHumanReview — pin the gate result rather than hand-building a
    // fully sourced curated table; the stamp must mirror the evaluation the
    // publish actually ran, and pages-poll withholds the scheduler
    // auto-merge on it.
    const gate = require('../services/content/comparison-table-gate');
    jest.spyOn(gate, 'evaluate').mockReturnValue({ pass: true, findings: [], requiresHumanReview: true });
    const read = chain({ first: jest.fn().mockResolvedValue(plainPost()) });
    const update = chain();
    const queries = [read, update];
    db.mockImplementation(() => queries.shift() || chain());

    await AstroPublisher.publishAstro('post-1');

    expect(update.update).toHaveBeenCalledWith(expect.objectContaining({
      astro_status: 'pr_open',
      astro_requires_human_merge: true,
    }));
  });

  test('namedCompetitorAutopublish never reaches this lane — the stamp stays TRUE even with the flag on (manual/calendar posts keep their human merge)', async () => {
    // Owner directive 2026-08-26 scopes autopublish to operator-intercept
    // runs; publishAstro serves manual/calendar posts with no such
    // provenance, so the human-merge stamp is unconditional here.
    const gate = require('../services/content/comparison-table-gate');
    jest.spyOn(gate, 'evaluate').mockReturnValue({ pass: true, findings: [], requiresHumanReview: true });
    const featureGates = require('../config/feature-gates');
    const realIsEnabled = featureGates.isEnabled;
    jest.spyOn(featureGates, 'isEnabled').mockImplementation((g) => (
      g === 'namedCompetitorAutopublish' ? true : realIsEnabled(g)));
    const read = chain({ first: jest.fn().mockResolvedValue(plainPost()) });
    const update = chain();
    const queries = [read, update];
    db.mockImplementation(() => queries.shift() || chain());

    await AstroPublisher.publishAstro('post-1');

    expect(update.update).toHaveBeenCalledWith(expect.objectContaining({
      astro_status: 'pr_open',
      astro_requires_human_merge: true,
    }));
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

  test('a republish while an earlier topic-blocked PR still owes its close settles it first; unsettled → refused (BLOG_PR_RETIRE_PENDING), no new PR (hook r23 P1)', async () => {
    const post = {
      id: 'post-1', title: 'Ant Trails', slug: 'ant-trails-bradenton',
      astro_status: 'publish_failed', astro_pr_number: 99, astro_branch_name: 'content/blog-ant-trails-bradenton-old1', astro_retire_pr_number: 98,
    };
    db.mockImplementation(() => chain({ first: jest.fn().mockResolvedValue(post) }));
    // GitHub keeps #98 open no matter what (the close is rejected).
    gh.getPr.mockImplementation(async (n) => ({ number: n, state: 'open', merged: false, head: { ref: `content/blog-old-${n}` } }));
    gh.closePr.mockRejectedValue(new Error('502'));
    await expect(AstroPublisher.publishAstro('post-1')).rejects.toMatchObject({ code: 'BLOG_PR_RETIRE_PENDING' });
    expect(gh.closePr).toHaveBeenCalledWith(98);
    expect(gh.createBranch).not.toHaveBeenCalled();
    expect(gh.createPr).not.toHaveBeenCalled();

    // The close lands → the debt settles and the republish proceeds (fails
    // later on this minimal post, but not with the retire refusal).
    jest.clearAllMocks();
    db.mockImplementation(() => chain({ first: jest.fn().mockResolvedValue(post) }));
    const closed = new Set();
    gh.getPr.mockImplementation(async (n) => ({ number: n, state: closed.has(n) ? 'closed' : 'open', merged: false, head: { ref: `content/blog-old-${n}` } }));
    gh.closePr.mockImplementation(async (n) => { closed.add(n); });
    await expect(AstroPublisher.publishAstro('post-1')).rejects.not.toMatchObject({ code: 'BLOG_PR_RETIRE_PENDING' });
    expect(gh.closePr).toHaveBeenCalledWith(98);
    expect(gh.closePr).toHaveBeenCalledWith(99);
  });

  test('the topic-gate failure stamp compare-and-sets on the lifecycle the gate ran against (a reconcile-discovered merge is never reverted) (codex r23 P1)', async () => {
    const post = { id: 'post-1', title: 'Ant Trails', slug: 'ant-trails-bradenton', astro_status: 'publish_failed', tag: 'pest-control' };
    const read = chain({ first: jest.fn().mockResolvedValue(post) });
    db.mockImplementation(() => read);
    const topicGate = require('../services/content/topic-targeting-gate');
    const spy = jest.spyOn(topicGate, 'evaluateBlogPostRow').mockRejectedValue(new Error('corpus unavailable'));
    try {
      await expect(AstroPublisher.publishAstro('post-1')).rejects.toThrow(/corpus unavailable/);
      expect(read.where).toHaveBeenCalledWith({ id: 'post-1', astro_status: 'publish_failed' });
      expect(read.update).toHaveBeenCalledWith(expect.objectContaining({ astro_status: 'publish_failed', astro_publish_error: expect.stringMatching(/could not run/) }));
    } finally { spy.mockRestore(); }
  });

  test('a deterministic topic block on a retry row records the debt for its existing PR and retires it; a transient gate error does not (hook r33 P1)', async () => {
    const post = { id: 'post-1', title: 'Ant Trails', slug: 'ant-trails-bradenton', astro_status: 'publish_failed', astro_pr_number: 99, astro_branch_name: 'content/blog-ant-trails-bradenton-old1', tag: 'pest-control' };
    const topicGate = require('../services/content/topic-targeting-gate');
    const spy = jest.spyOn(topicGate, 'evaluateBlogPostRow').mockResolvedValue({ ok: false, findings: [{ severity: 'P0', code: 'TOPIC_GEO_OUT_OF_AREA', message: 'Tampa' }] });
    try {
      const read = chain({ first: jest.fn().mockResolvedValue(post), update: jest.fn().mockResolvedValue(1) });
      db.mockImplementation(() => read);
      const closed = new Set();
      gh.getPr.mockImplementation(async (n) => ({ number: n, state: closed.has(n) ? 'closed' : 'open', merged: false, head: { ref: 'content/blog-ant-trails-bradenton-old1' } }));
      gh.closePr.mockImplementation(async (n) => { closed.add(n); });
      await expect(AstroPublisher.publishAstro('post-1')).rejects.toMatchObject({ code: 'BLOG_TOPIC_TARGETING_BLOCKED' });
      expect(read.update).toHaveBeenCalledWith(expect.objectContaining({ astro_status: 'publish_failed', astro_retire_pr_number: 99 }));
      expect(gh.closePr).toHaveBeenCalledWith(99);
      expect(gh.retireBranch).toHaveBeenCalledWith('content/blog-ant-trails-bradenton-old1');

      // Transient (corpus unavailable): no debt, nothing closed — the scheduler retries.
      jest.clearAllMocks();
      spy.mockRejectedValue(new Error('corpus unavailable'));
      const read2 = chain({ first: jest.fn().mockResolvedValue(post), update: jest.fn().mockResolvedValue(1) });
      db.mockImplementation(() => read2);
      await expect(AstroPublisher.publishAstro('post-1')).rejects.toThrow(/corpus unavailable/);
      expect(read2.update).toHaveBeenCalledWith(expect.not.objectContaining({ astro_retire_pr_number: expect.anything() }));
      expect(gh.closePr).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });

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

describe('Astro publisher merge guard', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  test('blocks stale spoke-targeted Astro PRs before merge', async () => {
    const post = {
      id: 'post-1',
      title: 'Ant Trails in Bradenton',
      slug: 'ant-trails-bradenton',
      astro_status: 'pr_open',
      astro_pr_number: 42,
      astro_branch_name: 'content/blog-ant-trails-old',
    };
    const read = chain({ first: jest.fn().mockResolvedValue(post) });
    const update = chain();
    const queries = [read, update];
    db.mockImplementation(() => queries.shift() || chain());
    gh.getPr.mockResolvedValue({
      number: 42,
      state: 'open',
      merged: false,
      head: { ref: 'content/blog-ant-trails-old', sha: 'head-sha' },
    });
    gh.getFile.mockImplementation(async (path, ref) => {
      if (path === 'src/content/blog/ant-trails-bradenton.md' && ref === 'content/blog-ant-trails-old') {
        return {
          content: [
            '---',
            'title: Ant Trails in Bradenton',
            'slug: /ant-trails-bradenton/',
            'domains:',
            '  - veniceflpestcontrol.com',
            'tracking:',
            '  domains:',
            '    - veniceflpestcontrol.com',
            '---',
            'Stale spoke-targeted branch.',
          ].join('\n'),
        };
      }
      return null;
    });

    await expect(AstroPublisher.mergeAstro('post-1')).rejects.toThrow(/republish the post before merge/);
    expect(gh.mergePr).not.toHaveBeenCalled();
    expect(gh.listIssueComments).not.toHaveBeenCalled();
    expect(update.update).toHaveBeenCalledWith(expect.objectContaining({
      astro_publish_error: expect.stringMatching(/non-hub blog publish targets/),
    }));
  });
});

describe('publishAstro catch persists an already-opened PR marker (Codex round 3)', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  function validPost(overrides = {}) {
    return {
      id: 'post-1',
      title: 'Ant Trails in Bradenton',
      slug: 'ant-trails-bradenton',
      meta_description: 'Bradenton homeowners can use this guide to identify ant trails, reduce entry points, and spot trouble early. Learn more on the Waves blog.',
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
      content: '## What you are seeing\n\nWaves Pest Control keeps Bradenton homes pest-free with seasonal treatments.',
      ...overrides,
    };
  }

  test('a failure AFTER PR creation keeps astro_pr_number — the scheduler must not retry into a duplicate PR', async () => {
    const updates = [];
    const q = chain({
      first: jest.fn().mockResolvedValue(validPost()),
      update: jest.fn((u) => {
        updates.push(u);
        // The pr_open stamp itself is the fallible step Codex flagged: the
        // PR exists on GitHub but the DB write recording it dies.
        if (u.astro_status === 'pr_open') return Promise.reject(new Error('db blip while stamping pr_open'));
        return Promise.resolve(1);
      }),
    });
    db.mockImplementation(() => q);

    await expect(AstroPublisher.publishAstro('post-1')).rejects.toThrow('db blip while stamping pr_open');

    const parked = updates.find((u) => u.astro_status === 'publish_failed');
    expect(parked).toBeDefined();
    expect(parked.astro_pr_number).toBe(123);
    expect(parked.astro_branch_name).toEqual(expect.stringMatching(/^content\/blog-ant-trails-bradenton-/));
    // The branch is PR-attached — it must survive the failure (the marker
    // routes the retry through the stale-PR close+delete path instead).
    expect(gh.deleteRef).not.toHaveBeenCalled();
  });

  test('a failure between branch creation and PR creation deletes the orphan branch before rethrowing (Codex round 5)', async () => {
    const updates = [];
    const q = chain({
      first: jest.fn().mockResolvedValue(validPost()),
      update: jest.fn((u) => { updates.push(u); return Promise.resolve(1); }),
    });
    db.mockImplementation(() => q);
    gh.createPr.mockRejectedValueOnce(new Error('create-PR outage'));

    await expect(AstroPublisher.publishAstro('post-1')).rejects.toThrow('create-PR outage');

    // Each retry cuts a FRESH shortId branch, so an undeleted pre-PR
    // branch (with its hero commit) is an orphan per 15-minute tick that
    // no later cleanup can locate. The lookup ran first (createPr was
    // attempted, so the PR may exist despite the throw) and found none.
    expect(gh.findOpenPrByHead).toHaveBeenCalledWith(expect.stringMatching(/^content\/blog-ant-trails-bradenton-/));
    expect(gh.deleteRef).toHaveBeenCalledWith(expect.stringMatching(/^content\/blog-ant-trails-bradenton-/));
    const parked = updates.find((u) => u.astro_status === 'publish_failed');
    expect(parked).toBeDefined();
    // Explicit NULLs, not omissions: a retried row must not keep the
    // previous attempt's stale marker.
    expect(parked.astro_pr_number).toBeNull();
    expect(parked.astro_branch_name).toBeNull();
  });

  test('createPr throw with the PR actually created recovers the marker instead of deleting a live head (Codex round 6)', async () => {
    const updates = [];
    const q = chain({
      first: jest.fn().mockResolvedValue(validPost()),
      update: jest.fn((u) => { updates.push(u); return Promise.resolve(1); }),
    });
    db.mockImplementation(() => q);
    // ghFetch retries POSTs on 5xx — a timeout after creation means the
    // call throws while the PR exists. The head-branch lookup finds it.
    gh.createPr.mockRejectedValueOnce(new Error('504 gateway timeout'));
    gh.findOpenPrByHead.mockResolvedValueOnce({ number: 777 });

    await expect(AstroPublisher.publishAstro('post-1')).rejects.toThrow('504 gateway timeout');

    expect(gh.deleteRef).not.toHaveBeenCalled();
    const parked = updates.find((u) => u.astro_status === 'publish_failed');
    expect(parked.astro_pr_number).toBe(777);
    expect(parked.astro_branch_name).toEqual(expect.stringMatching(/^content\/blog-ant-trails-bradenton-/));
  });

  test('retry of a stale-marker row that fails pre-PR again CLEARS the old marker after cleanup (Codex round 6)', async () => {
    // Old attempt left publish_failed + marker; cleanup closes/deletes the
    // old PR, then the new attempt dies at the guardrails (pre-branch).
    // Keeping the old marker would make the scheduler treat this pre-PR
    // failure as PR-backed and park the fixed post forever.
    const post = validPost({
      astro_status: 'publish_failed',
      astro_pr_number: 99,
      astro_branch_name: 'content/blog-ant-trails-bradenton-old1',
      tag: 'Rodents',
      content: '## Sealing entry points\n\nRats squeeze through dime-sized gaps.\n\n## Frequently Asked Questions\n\nQ: How fast can you help?',
    });
    const updates = [];
    const q = chain({
      first: jest.fn().mockResolvedValue(post),
      update: jest.fn((u) => { updates.push(u); return Promise.resolve(1); }),
    });
    db.mockImplementation(() => q);
    gh.getPr.mockResolvedValue({ number: 99, state: 'open', merged: false });

    await expect(AstroPublisher.publishAstro('post-1')).rejects.toThrow(/content guardrails failed/);

    expect(gh.closePr).toHaveBeenCalledWith(99);
    const parked = updates.find((u) => u.astro_status === 'publish_failed');
    expect(parked.astro_pr_number).toBeNull();
    expect(parked.astro_branch_name).toBeNull();
  });

  test('a permanently bad curated hero URL fails with BLOG_HERO_MEDIA_FAILED (Codex round 6 — parked, not hot-looped)', async () => {
    const savedFetch = global.fetch;
    global.fetch = jest.fn().mockRejectedValue(new Error('404 not found'));
    try {
      const q = chain({ first: jest.fn().mockResolvedValue(validPost({ featured_image_url: 'https://cdn.example.com/hero.jpg' })) });
      db.mockImplementation(() => q);

      await expect(AstroPublisher.publishAstro('post-1')).rejects.toMatchObject({ code: 'BLOG_HERO_MEDIA_FAILED' });
      // Pre-branch failure: nothing external to clean up.
      expect(gh.createBranch).not.toHaveBeenCalled();
    } finally {
      if (savedFetch === undefined) delete global.fetch;
      else global.fetch = savedFetch;
    }
  });

  test('a failure BEFORE PR creation stamps publish_failed with NO marker — provably retryable', async () => {
    // FAQ on a rodent post = a guardrails P0 thrown well before any PR.
    const post = validPost({
      tag: 'Rodents',
      content: '## Sealing entry points\n\nRats squeeze through dime-sized gaps.\n\n## Frequently Asked Questions\n\nQ: How fast can you help?',
    });
    const updates = [];
    const q = chain({
      first: jest.fn().mockResolvedValue(post),
      update: jest.fn((u) => { updates.push(u); return Promise.resolve(1); }),
    });
    db.mockImplementation(() => q);

    await expect(AstroPublisher.publishAstro('post-1')).rejects.toThrow(/content guardrails failed/);

    const parked = updates.find((u) => u.astro_status === 'publish_failed');
    expect(parked).toBeDefined();
    expect(parked.astro_pr_number).toBeNull();
    expect(gh.createPr).not.toHaveBeenCalled();
  });

  test('admin retry of publish_failed WITH a persisted marker cleans up the stale PR first (Codex round 4)', async () => {
    // The marker exists exactly because a PR opened before the failure —
    // without the same close+delete the build_failed retry gets, the
    // republish opened a SECOND PR and overwrote the marker, orphaning
    // the first.
    const post = validPost({
      astro_status: 'publish_failed',
      astro_pr_number: 99,
      astro_branch_name: 'content/blog-ant-trails-bradenton-old1',
    });
    const q = chain({ first: jest.fn().mockResolvedValue(post) });
    db.mockImplementation(() => q);
    gh.getPr.mockResolvedValue({ number: 99, state: 'open', merged: false });

    await AstroPublisher.publishAstro('post-1');

    expect(gh.closePr).toHaveBeenCalledWith(99);
    expect(gh.deleteRef).toHaveBeenCalledWith('content/blog-ant-trails-bradenton-old1');
    expect(gh.createPr).toHaveBeenCalled();
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

  test('a merge-time BLOG_TOPIC_TARGETING_BLOCKED parks the claim at pending_review instead of retrying every tick (PR #3549 codex r5)', async () => {
    const posts = [{ id: 'post-tg', slug: 'drifted-post', astro_status: 'pr_open', publish_status: 'publishing', astro_branch_name: 'tg-branch', astro_requires_human_merge: false }];
    const updates = [];
    db.mockImplementation(() => {
      const q = {
        _filters: [],
        whereIn: jest.fn().mockReturnThis(),
        whereNotNull: jest.fn().mockReturnThis(),
        where: jest.fn(function (...args) { q._filters.push(args); return q; }),
        select: jest.fn(() => Promise.resolve(posts)),
        update: jest.fn((u) => { updates.push({ filters: q._filters.slice(), updates: u }); return Promise.resolve(1); }),
      };
      return q;
    });
    mockCloudflareDeploymentList(posts.map((p) => previewDeployment(p.astro_branch_name)));
    const blocked = new Error('PR #7 cannot merge — topic-targeting gate is no longer clear against the live corpus: P0 TOPIC_CANNIBALIZES_EXISTING — …');
    blocked.code = 'BLOG_TOPIC_TARGETING_BLOCKED';
    jest.spyOn(AstroPublisher, 'mergeAstro').mockRejectedValue(blocked);

    const result = await PagesPoll.pollPending();

    const parked = result.results.find((r) => r.id === 'post-tg');
    expect(parked.topicTargetingBlocked).toBe(true);
    const park = updates.find((u) => u.updates.publish_status === 'pending_review');
    expect(park).toBeDefined();
    // CAS on the park mergeAstro stamped: a row its PR retirement moved to
    // astro_status='merged' (human merged it meanwhile) is never flipped back
    // to publish_failed here (hook r24 P1).
    expect(park.filters).toEqual(expect.arrayContaining([[{ id: 'post-tg', publish_status: 'publishing', astro_status: 'publish_failed' }]]));
    // Recoverable: publish_failed (not pr_open) is the state the admin Retry /
    // publish-astro path may claim; the markers stay for cleanupStaleAstroPr.
    expect(park.updates.astro_status).toBe('publish_failed');
    expect(park.updates).not.toHaveProperty('astro_pr_number');
    expect(park.updates).not.toHaveProperty('astro_branch_name');
  });

  test('a post stamped astro_requires_human_merge is parked for admin merge, never auto-merged (audit lane 4b)', async () => {
    const posts = [
      { id: 'post-hr', slug: 'named-competitor-post', astro_status: 'pr_open', publish_status: 'publishing', astro_branch_name: 'hr-branch', astro_requires_human_merge: true },
      { id: 'post-ok', slug: 'plain-post', astro_status: 'pr_open', publish_status: 'publishing', astro_branch_name: 'ok-branch', astro_requires_human_merge: false },
    ];
    const updates = [];
    const selects = [];
    db.mockImplementation(() => {
      const q = {
        _filters: [],
        whereIn: jest.fn().mockReturnThis(),
        whereNotNull: jest.fn().mockReturnThis(),
        where: jest.fn(function (...args) { q._filters.push(args); return q; }),
        select: jest.fn((...cols) => { selects.push(cols); return Promise.resolve(posts); }),
        update: jest.fn((u) => { updates.push({ filters: q._filters.slice(), updates: u }); return Promise.resolve(1); }),
      };
      return q;
    });
    mockCloudflareDeploymentList(posts.map((p) => previewDeployment(p.astro_branch_name)));
    const mergeSpy = jest.spyOn(AstroPublisher, 'mergeAstro').mockResolvedValue({ merged: true });

    const result = await PagesPoll.pollPending();

    // Only the unstamped post merges; the flagged one is withheld — the
    // scheduler's claim is not the human sign-off named-competitor content
    // publishes under (the admin's merge click is).
    expect(mergeSpy).toHaveBeenCalledTimes(1);
    expect(mergeSpy.mock.calls[0][0]).toBe('post-ok');
    const withheld = result.results.find((r) => r.id === 'post-hr');
    expect(withheld.humanMergeRequired).toBe(true);
    // The claim is parked pending_review (claim-guarded like the scheduler's
    // own CAS writes) so the auto-merge branch disarms instead of re-arming
    // every tick; the PR stays open for merge-astro.
    const park = updates.find((u) => u.updates.publish_status === 'pending_review');
    expect(park).toBeDefined();
    expect(park.filters).toEqual(expect.arrayContaining([
      [{ id: 'post-hr', publish_status: 'publishing' }],
    ]));
    // The pending select actually carries the flag — pollPost can only see
    // columns this query names.
    expect(selects[0]).toEqual(expect.arrayContaining(['astro_requires_human_merge']));
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

  test('decodes a provider-scale (multi-MB, whitespace-wrapped) data URL without regexing the payload', async () => {
    // The old /^data:...;base64,(.+)$/ ran V8's regex engine across the whole
    // multi-megabyte payload (the huge-input suspect behind the prod
    // "Maximum call stack size exceeded" hero failure) and outright FAILED on
    // wrapped base64 (newlines), falling through to a network fetch() of a
    // data: URL. The bounded header parse must decode both shapes locally.
    const wrapped = `data:image/png;base64,${(PNG_B64.match(/.{1,20}/g) || []).join('\n')}`;
    imageGenerator.generate.mockResolvedValue({ dataUrl: wrapped, model: 'test-model' });
    const img = await AstroPublisher._internals.generateHeroBuffer({ title: 'Wrapped' });
    expect(Buffer.isBuffer(img.buffer)).toBe(true);
    expect(img.buffer.length).toBeGreaterThan(0);
    expect(img.ext).toBe('png');
  });
});

describe('parseImageDataUrl (bounded data-URL header parse)', () => {
  const { parseImageDataUrl } = AstroPublisher._internals;

  test('parses mime + payload without touching the payload with a regex', () => {
    const big = 'A'.repeat(6 * 1024 * 1024);
    const parsed = parseImageDataUrl(`data:image/webp;base64,${big}`);
    expect(parsed.mime).toBe('image/webp');
    expect(parsed.base64).toBe(big);
  });

  test('rejects non-data and non-base64-image URLs', () => {
    expect(parseImageDataUrl('https://example.com/x.png')).toBeNull();
    expect(parseImageDataUrl('data:text/html;base64,PGI+')).toBeNull();
    expect(parseImageDataUrl('data:image/png,rawdata')).toBeNull();
    expect(parseImageDataUrl('')).toBeNull();
  });
});

describe('resolveAutonomousHero fallback (hero is schema-required — default asset or full-cause park)', () => {
  const imageGenerator = require('../services/content/image-generator');
  const frontmatter = {
    title: 'Fall Lawn Mistakes',
    meta_description: 'm',
    primary_keyword: 'fall lawn mistakes',
    category: 'lawn-care',
  };

  beforeEach(() => jest.clearAllMocks());

  test('on generation failure, reuses a COMMITTED category-default hero when one exists in the repo', async () => {
    const boom = new RangeError('Maximum call stack size exceeded');
    imageGenerator.generate.mockRejectedValue(boom);
    gh.getFile.mockImplementation(async (path) => (
      path === 'public/images/blog/defaults/lawn-care/hero.webp' ? { content: 'x', sha: 's' } : null
    ));

    const hero = await AstroPublisher._internals.resolveAutonomousHero({
      frontmatter, slug: 'lawn-care/fall-lawn-mistakes-swfl', existingFile: null,
    });

    // The fallback carries a GENERIC alt — the caller must never stamp the
    // agent's subject-specific draft alt over an image that was never
    // generated (Codex r1).
    expect(hero).toEqual({ src: '/images/blog/defaults/lawn-care/hero.webp', buffer: null, alt: 'Illustrative lawn care article header image' });
  });

  test('falls back to the site-wide default when no category default exists', async () => {
    imageGenerator.generate.mockRejectedValue(new Error('all providers failed'));
    gh.getFile.mockImplementation(async (path) => (
      path === 'public/images/blog/defaults/hero.webp' ? { content: 'x', sha: 's' } : null
    ));

    const hero = await AstroPublisher._internals.resolveAutonomousHero({
      frontmatter, slug: 'lawn-care/fall-lawn-mistakes-swfl', existingFile: null,
    });

    // The SITE-WIDE default is not guaranteed to depict the category, so
    // its alt stays category-NEUTRAL (Codex r16) — only the category asset
    // earns the category-specific text.
    expect(hero).toEqual({ src: '/images/blog/defaults/hero.webp', buffer: null, alt: 'Illustrative article header image' });
  });

  test('post-provider failure (generation succeeded, decode/compress failed) still carries the provider chain on the thrown error (Codex r1)', async () => {
    const attempts = [{ provider: 'gpt-image-2', result: { dataUrl: 'ok' } }];
    imageGenerator.generate.mockResolvedValue({
      dataUrl: 'data:image/png;base64,bm90IGFuIGltYWdl', // valid base64, NOT an image — sharp throws in compressToWebp
      mimeType: 'image/png',
      model: 'gpt-image-2',
      attempts,
      alt: 'a lawn',
    });
    gh.getFile.mockResolvedValue(null); // no committed default → parks

    let thrown;
    try {
      await AstroPublisher._internals.resolveAutonomousHero({
        frontmatter, slug: 'lawn-care/fall-lawn-mistakes-swfl', existingFile: null,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeTruthy();
    expect(thrown.code).toBe('BLOG_HERO_IMAGE_FAILED');
    // describeHeroFailure reads attempts off the cause chain — the provider
    // history from the SUCCESSFUL generate call must survive the
    // post-provider throw.
    expect(thrown.message).toContain('providers: gpt-image-2=ok');
  });

  test('with NO committed default, still parks — and the failure message carries the FULL root cause (error class + provider attempts)', async () => {
    const boom = new RangeError('Maximum call stack size exceeded');
    boom.attempts = [
      { provider: 'gpt-image-2', result: { retryable: true, status: 503 } },
      { provider: 'gemini', result: { fatal: true, status: 'no_image_in_response' } },
    ];
    imageGenerator.generate.mockRejectedValue(boom);
    gh.getFile.mockResolvedValue(null);

    let thrown;
    try {
      await AstroPublisher._internals.resolveAutonomousHero({
        frontmatter, slug: 'lawn-care/fall-lawn-mistakes-swfl', existingFile: null,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    expect(thrown.code).toBe('BLOG_HERO_IMAGE_FAILED');
    expect(thrown.message).toContain('autonomous blog hero image generation failed for lawn-care/fall-lawn-mistakes-swfl');
    expect(thrown.message).toContain('RangeError: Maximum call stack size exceeded');
    expect(thrown.message).toContain('gpt-image-2=503');
    expect(thrown.message).toContain('gemini=no_image_in_response');
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

describe('syncDraftPublishTarget mirrors publisher-normalized targeting', () => {
  test('canonical, domains AND tracking are written back to the persisted draft (PR #3508 r8 P1)', () => {
    const draft = { frontmatter: { canonical: 'https://hub/old/', tracking: { domains: ['stale.example'] } } };
    const resolved = {
      canonical: 'https://www.wavespestcontrol.com/blog/x/',
      domains: ['wavespestcontrol.com'],
      tracking: { domains: ['wavespestcontrol.com'] },
    };
    AstroPublisher._internals.syncDraftPublishTarget(draft, resolved);
    // The poller's merge gate compares the head against this persisted
    // draft — an unsynced tracking would flag the publisher's own
    // normalized head as drift and deadlock a green PR.
    expect(draft.frontmatter.canonical).toBe(resolved.canonical);
    expect(draft.frontmatter.domains).toEqual(['wavespestcontrol.com']);
    expect(draft.frontmatter.tracking).toEqual({ domains: ['wavespestcontrol.com'] });
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

describe('buildFrontmatter self-heals schema-required service_areas_tag (never undefined)', () => {
  const base = {
    title: 'Dollar Spot in Venice', slug: 'dollar-spot-venice',
    meta_description: 'A short guide to dollar spot on Venice lawns and how to actually treat it.',
    keyword: 'dollar spot Venice', tag: 'Lawn Disease',
    featured_image_url: '/images/blog/dollar-spot-venice/hero.webp',
    content: 'Dollar spot shows up as small bleached patches on warm-season turf.',
  };

  test('keeps stored valid service areas unchanged', async () => {
    const data = await AstroPublisher.buildFrontmatter({ ...base, service_areas_tag: ['Sarasota', 'Parrish'] });
    expect(data.service_areas_tag).toEqual(['Sarasota', 'Parrish']);
  });

  test('with no stored areas and no valid city, infers from the title/keyword haystack instead of emitting undefined', async () => {
    // The old `serviceAreas.length > 0 ? serviceAreas : undefined` dropped the
    // key entirely and hard-failed assertValidBlogFrontmatter
    // ("service_areas_tag is required") after the generation was spent.
    const data = await AstroPublisher.buildFrontmatter({ ...base, city: null });
    expect(data.service_areas_tag).toEqual(['Venice']);
  });

  test('a fully generic post falls back to the default service-area set (still schema-valid)', async () => {
    const data = await AstroPublisher.buildFrontmatter({
      ...base,
      title: 'How soil pH changes turf color',
      keyword: 'soil ph turf',
      city: null,
    });
    expect(Array.isArray(data.service_areas_tag)).toBe(true);
    expect(data.service_areas_tag.length).toBeGreaterThan(0);
    // post_type already defaults deterministically — both schema-required
    // fields are guaranteed present on this path now.
    expect(data.post_type).toBe('location');
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

  test('legacy .md refresh: a "<!--" inside a fenced sample is code, not a comment opener — a real component after the fence still fails the publish (Codex #3646 r33)', async () => {
    const MD_PATH = 'src/content/blog/dollar-spot-venice.md';
    const existing = fm.stringify(
      validFrontmatter({ slug: '/dollar-spot-venice/', canonical: 'https://www.wavespestcontrol.com/dollar-spot-venice/' }),
      'Old body about dollar spot in Venice.',
    );
    gh.getFile.mockImplementation(async (p) => (p === MD_PATH ? { sha: 'existing-sha', content: existing, path: p } : null));
    const body = 'Refreshed body.\n\n```html\n<!-- example only\n```\n<InlineCTA />\n-->\n\nMore prose.';
    await expect(AstroPublisher.publishRefresh(
      { type: 'draft', file_path: MD_PATH, page_url: 'https://www.wavespestcontrol.com/dollar-spot-venice/', body, frontmatter: {} },
      { action_type: 'refresh_existing_page' },
    )).rejects.toMatchObject({ statusCode: 422, message: expect.stringMatching(/legacy \.md file — an MDX component \(<InlineCTA>\)/) });
    expect(gh.createBranch).not.toHaveBeenCalled();
    // Quoted attribute text renders no component — the refresh proceeds (Codex #3646 r39).
    const attrText = 'Refreshed body.\n\n<div title="<InlineCTA />">text</div>\n\nMore prose.';
    expect((await AstroPublisher.publishRefresh(
      { type: 'draft', file_path: MD_PATH, page_url: 'https://www.wavespestcontrol.com/dollar-spot-venice/', body: attrText, frontmatter: {} },
      { action_type: 'refresh_existing_page' },
    )).pr_number).toBe(50);
    // The same component INSIDE the fence is a code sample — the refresh proceeds.
    const fenced = 'Refreshed body.\n\n```html\n<!-- example only -->\n<InlineCTA />\n```\n\nMore prose.';
    const result = await AstroPublisher.publishRefresh(
      { type: 'draft', file_path: MD_PATH, page_url: 'https://www.wavespestcontrol.com/dollar-spot-venice/', body: fenced, frontmatter: {} },
      { action_type: 'refresh_existing_page' },
    );
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
    // Once: mergeAstro's topic-targeting recheck loads this corpus in later tests.
    jest.spyOn(planner, 'loadAstroCorpusFromGitHub').mockRejectedValueOnce(new Error('github down'));

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

  test('keeps the protected service metaTitle, writes metaDescription, and never adds title/meta_description duplicates', async () => {
    gh.getFile.mockResolvedValue({ sha: 'svc-sha', content: SERVICE_PAGE });

    const res = await AstroPublisher.publishMetadataRewrite({
      type: 'metadata',
      title: 'Pest Control Sarasota FL | Waves Pest Control',
      meta_description: 'New Sarasota service meta description that will actually render.',
    }, SERVICE_BRIEF);

    expect(res.status).toBe('pr_open');
    const { data, content } = fmModule.parse(gh.putFile.mock.calls[0][0].content);
    // PROTECTED (owner rule 2026-07-16): service metaTitle is never rewritten
    // by automation — the live value is kept, only the description ships.
    expect(data.metaTitle).toBe('Old Sarasota Service Meta Title');
    expect(data.metaDescription).toBe('New Sarasota service meta description that will actually render.');
    // …and NO dead snake_case duplicates created.
    expect(data.title).toBeUndefined();
    expect(data.meta_description).toBeUndefined();
    // Body untouched; rendered change (description) → legitimate `modified` bump.
    expect(content).toContain('Service body that must not change.');
    expect(data.modified).not.toBe('2026-01-01T12:00:00');
    expect(String(data.modified)).toMatch(/^\d{4}-\d{2}-\d{2}T12:00:00$/);
    // PR title reflects the field that actually ships (the kept live title);
    // the body diff table shows the metaTitle row unchanged.
    expect(gh.createPr).toHaveBeenCalledWith(expect.objectContaining({
      title: expect.stringContaining('SEO metadata: Old Sarasota Service Meta Title'),
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

describe('mergeAstro head pinning (audit regression — merge was not sha-pinned)', () => {
  const HEAD_SHA = 'abcdef1234567890abcdef1234567890abcdef12';

  function hubOnlyPost() {
    return {
      id: 'post-pin-1',
      title: 'Ant Trails in Bradenton',
      slug: 'ant-trails-bradenton',
      astro_status: 'pr_open',
      astro_pr_number: 42,
      astro_branch_name: 'content/blog-ant-trails',
    };
  }

  function mockHubOnlyBranchFile() {
    gh.getFile.mockImplementation(async (path, ref) => {
      if (path === 'src/content/blog/ant-trails-bradenton.md' && ref === 'content/blog-ant-trails') {
        return {
          content: [
            '---',
            'title: Ant Trails in Bradenton',
            'slug: /ant-trails-bradenton/',
            'domains:',
            '  - wavespestcontrol.com',
            '---',
            'Hub-only branch.',
          ].join('\n'),
        };
      }
      return null;
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.INTERNAL_LINK_PLAN_ON_BLOG_MERGE = 'false';
  });
  afterEach(() => { delete process.env.INTERNAL_LINK_PLAN_ON_BLOG_MERGE; });

  test('a clean merge is pinned to the exact head the gates vetted (sha param)', async () => {
    const read = chain({ first: jest.fn().mockResolvedValue(hubOnlyPost()) });
    const queries = [read];
    db.mockImplementation(() => queries.shift() || chain());
    gh.getPr.mockResolvedValue({
      number: 42, state: 'open', merged: false,
      head: { ref: 'content/blog-ant-trails', sha: HEAD_SHA },
    });
    mockHubOnlyBranchFile();
    gh.listIssueComments.mockResolvedValue([{
      user: { login: 'wavespestcontrolfl' },
      body: `@codex review\n\nReady on head \`${HEAD_SHA}\`.`,
      created_at: '2026-07-02T12:00:00Z',
    }]);
    gh.listPrReviews.mockResolvedValue([{
      user: { login: 'chatgpt-codex-connector' },
      body: "Codex Review: Didn't find any major issues.",
      state: 'COMMENTED',
      commit_id: HEAD_SHA,
      submitted_at: '2026-07-02T12:05:00Z',
    }]);
    gh.mergePr.mockResolvedValue({ merged: true, sha: 'merge-commit-sha' });

    const result = await AstroPublisher.mergeAstro('post-pin-1');

    expect(result.merged).toBe(true);
    // GitHub 409s the merge if the head moved after the gates ran — the pin
    // is what makes the Codex/hub-only checks race-proof.
    expect(gh.mergePr).toHaveBeenCalledWith(42, expect.objectContaining({ sha: HEAD_SHA }));
  });

  test('expectHeadSha mismatch (green build of an older commit) refuses to merge', async () => {
    const read = chain({ first: jest.fn().mockResolvedValue(hubOnlyPost()) });
    const queries = [read];
    db.mockImplementation(() => queries.shift() || chain());
    gh.getPr.mockResolvedValue({
      number: 42, state: 'open', merged: false,
      head: { ref: 'content/blog-ant-trails', sha: HEAD_SHA },
    });

    await expect(AstroPublisher.mergeAstro('post-pin-1', { expectHeadSha: '1111111111111111111111111111111111111111' }))
      .rejects.toThrow(/no longer matches the verified build commit/);
    expect(gh.mergePr).not.toHaveBeenCalled();
  });

  test('expectBaseSha: the default-branch tip is re-read inside the merge lock right before the merge call — a moved base refuses (BLOG_BASE_MOVED), a still base merges (GH r25)', async () => {
    const setup = () => {
      const read = chain({ first: jest.fn().mockResolvedValue(hubOnlyPost()) });
      const queries = [read];
      db.mockImplementation(() => queries.shift() || chain());
      gh.getPr.mockResolvedValue({ number: 42, state: 'open', merged: false, head: { ref: 'content/blog-ant-trails', sha: HEAD_SHA } });
      mockHubOnlyBranchFile();
      gh.listIssueComments.mockResolvedValue([{ user: { login: 'wavespestcontrolfl' }, body: `@codex review\n\nReady on head \`${HEAD_SHA}\`.`, created_at: '2026-07-02T12:00:00Z' }]);
      gh.listPrReviews.mockResolvedValue([{ user: { login: 'chatgpt-codex-connector' }, body: "Codex Review: Didn't find any major issues.", state: 'COMMENTED', commit_id: HEAD_SHA, submitted_at: '2026-07-02T12:05:00Z' }]);
      gh.mergePr.mockResolvedValue({ merged: true, sha: 'merge-commit-sha' });
    };
    setup();
    gh.getBranchSha.mockResolvedValue('main-tip-2');
    let thrown;
    try { await AstroPublisher.mergeAstro('post-pin-1', { expectBaseSha: 'main-tip-1' }); } catch (err) { thrown = err; }
    expect(thrown?.code).toBe('BLOG_BASE_MOVED');
    expect(gh.mergePr).not.toHaveBeenCalled();

    jest.clearAllMocks();
    setup();
    gh.getBranchSha.mockResolvedValue('main-tip-1');
    const result = await AstroPublisher.mergeAstro('post-pin-1', { expectBaseSha: 'main-tip-1' });
    expect(result.merged).toBe(true);
    expect(gh.mergePr).toHaveBeenCalledWith(42, expect.objectContaining({ sha: HEAD_SHA }));
  });
});

describe('mergeAstro re-runs the topic-targeting gate on the branch frontmatter (PR #3549 codex r4)', () => {
  const HEAD_SHA = 'abcdef1234567890abcdef1234567890abcdef12';
  function prOpenPost(over = {}) {
    return { id: 'post-gate-1', title: 'Ant Trails in Bradenton', slug: 'ant-trails-bradenton', astro_status: 'pr_open', astro_pr_number: 43, astro_branch_name: 'content/blog-ant-trails', ...over };
  }
  function mockBranchFile(title) {
    gh.getFile.mockImplementation(async (path, ref) => (
      path === 'src/content/blog/ant-trails-bradenton.md' && ref === 'content/blog-ant-trails'
        ? { content: ['---', `title: ${title}`, 'slug: /ant-trails-bradenton/', 'domains:', '  - wavespestcontrol.com', '---', 'Body.'].join('\n') }
        : null));
  }
  // GitHub as it behaves: the PR reads open until closePr lands, closed after.
  function prLifecycle(number = 43, ref = 'content/blog-ant-trails') {
    let closed = false;
    gh.getPr.mockImplementation(async () => ({ number, state: closed ? 'closed' : 'open', merged: false, head: { ref, sha: HEAD_SHA } }));
    gh.closePr.mockImplementation(async () => { closed = true; });
  }
  function cleanReview() {
    gh.getPr.mockResolvedValue({ number: 43, state: 'open', merged: false, head: { ref: 'content/blog-ant-trails', sha: HEAD_SHA } });
    gh.listIssueComments.mockResolvedValue([{ user: { login: 'wavespestcontrolfl' }, body: `@codex review\n\nReady on head \`${HEAD_SHA}\`.`, created_at: '2026-07-02T12:00:00Z' }]);
    gh.listPrReviews.mockResolvedValue([{ user: { login: 'chatgpt-codex-connector' }, body: "Codex Review: Didn't find any major issues.", state: 'COMMENTED', commit_id: HEAD_SHA, submitted_at: '2026-07-02T12:05:00Z' }]);
    gh.mergePr.mockResolvedValue({ merged: true, sha: 'merge-commit-sha' });
  }
  beforeEach(() => { jest.clearAllMocks(); process.env.INTERNAL_LINK_PLAN_ON_BLOG_MERGE = 'false'; });
  afterEach(() => { delete process.env.INTERNAL_LINK_PLAN_ON_BLOG_MERGE; });

  test('branch targeting that drifted out of footprint during review cannot merge, even with a clean Codex round — and the row is left retryable', async () => {
    const stamps = [];
    const queries = [chain({ first: jest.fn().mockResolvedValue(prOpenPost()) })];
    db.mockImplementation(() => queries.shift() || chain({ update: jest.fn((patch) => { stamps.push(patch); return Promise.resolve(1); }) }));
    cleanReview();
    mockBranchFile('Ant Trails in Tampa');
    await expect(AstroPublisher.mergeAstro('post-gate-1')).rejects.toMatchObject({ code: 'BLOG_TOPIC_TARGETING_BLOCKED', message: expect.stringMatching(/TOPIC_GEO_OUT_OF_AREA/) });
    expect(gh.mergePr).not.toHaveBeenCalled();
    // publish_failed (not pr_open) so the admin Retry / publish-astro path can
    // rebuild the PR after an edit; the markers stay for cleanupStaleAstroPr.
    const stamp = stamps.find((p) => p.astro_status === 'publish_failed');
    expect(stamp).toBeDefined();
    expect(stamp.astro_publish_error).toMatch(/TOPIC_GEO_OUT_OF_AREA/);
    expect(stamp).not.toHaveProperty('astro_pr_number');
    // The blocked PR is retired (closed + branch deleted) so nobody can merge
    // the stale branch from GitHub while the row waits for a republish — and
    // only AFTER the park is durable (codex r20 P1).
    expect(gh.closePr).toHaveBeenCalledWith(43);
    expect(gh.deleteRef).toHaveBeenCalledWith('content/blog-ant-trails');
    // The close the row owes is recorded IN the park write; GitHub still
    // reports the PR open here, so the debt is not settled.
    expect(stamp.astro_retire_pr_number).toBe(43);
    expect(stamps.some((p) => p.astro_retire_pr_number === null)).toBe(false);
  });

  test('the owed close is settled only once GitHub confirms the PR closed (hook r21 P1)', async () => {
    const stamps = [];
    const queries = [chain({ first: jest.fn().mockResolvedValue(prOpenPost()) })];
    db.mockImplementation(() => queries.shift() || chain({ update: jest.fn((patch) => { stamps.push(patch); return Promise.resolve(1); }) }));
    cleanReview();
    prLifecycle();
    mockBranchFile('Ant Trails in Tampa');
    await expect(AstroPublisher.mergeAstro('post-gate-1')).rejects.toMatchObject({ code: 'BLOG_TOPIC_TARGETING_BLOCKED' });
    expect(gh.closePr).toHaveBeenCalledWith(43);
    const park = stamps.findIndex((p) => p.astro_status === 'publish_failed');
    const settle = stamps.findIndex((p) => p.astro_retire_pr_number === null);
    expect(park).toBeGreaterThanOrEqual(0);
    expect(settle).toBeGreaterThan(park);
  });

  describe('reconcileTopicBlockedPostPrs (every pages-poll tick)', () => {
    function owedRow(over = {}) {
      return { id: 'post-gate-1', title: 'Ant Trails in Bradenton', slug: 'ant-trails-bradenton', astro_status: 'publish_failed', astro_pr_number: 43, astro_branch_name: 'content/blog-ant-trails', astro_retire_pr_number: 43, ...over };
    }
    function reconcileDb(rows, stamps, { current = rows[0] } = {}) {
      db.mockImplementation(() => chain({
        orderByRaw: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        select: jest.fn().mockResolvedValue(rows),
        first: jest.fn().mockResolvedValue(current),
        update: jest.fn((patch) => { stamps.push(patch); return Promise.resolve(1); }),
      }));
    }

    test('a close that failed on the park tick is repeated until GitHub confirms it, then settled', async () => {
      const stamps = [];
      reconcileDb([owedRow()], stamps);
      prLifecycle();
      const res = await AstroPublisher.reconcileTopicBlockedPostPrs();
      expect(res).toMatchObject({ count: 1, retired: 1, merged: 0 });
      expect(gh.closePr).toHaveBeenCalledWith(43);
      expect(gh.deleteRef).toHaveBeenCalledWith('content/blog-ant-trails');
      expect(stamps.some((p) => p.astro_retire_pr_number === null)).toBe(true);
    });

    test('a closed PR whose terminal stamp fails keeps the debt (retried next tick) — settled once the stamp lands (codex r24)', async () => {
      const stamps = [];
      reconcileDb([owedRow()], stamps);
      gh.getPr.mockResolvedValue({ number: 43, state: 'closed', merged: false, head: { ref: 'content/blog-ant-trails' } });
      const rem = require('../services/content/codex-remediation');
      const spy = jest.spyOn(rem, 'markPrTerminal').mockResolvedValue({ updated: 0, error: 'db down' });
      try {
        const r1 = await AstroPublisher.reconcileTopicBlockedPostPrs();
        expect(r1).toMatchObject({ count: 1, retired: 0 });
        expect(stamps.some((p) => p.astro_retire_pr_number === null)).toBe(false);
        spy.mockResolvedValue({ updated: 1 });
        const r2 = await AstroPublisher.reconcileTopicBlockedPostPrs();
        expect(r2).toMatchObject({ count: 1, retired: 1 });
        expect(stamps.some((p) => p.astro_retire_pr_number === null)).toBe(true);
      } finally { spy.mockRestore(); }
    });

    test('a closed PR whose branch is not verified deleted keeps the debt; settled once retireBranch confirms it (hook r28 P1)', async () => {
      const stamps = [];
      reconcileDb([owedRow()], stamps);
      gh.getPr.mockResolvedValue({ number: 43, state: 'closed', merged: false, head: { ref: 'content/blog-ant-trails' } });
      gh.retireBranch.mockResolvedValueOnce(false);
      const r1 = await AstroPublisher.reconcileTopicBlockedPostPrs();
      expect(r1).toMatchObject({ count: 1, retired: 0 });
      expect(gh.retireBranch).toHaveBeenCalledWith('content/blog-ant-trails');
      expect(stamps.some((p) => p.astro_retire_pr_number === null)).toBe(false);
      gh.retireBranch.mockResolvedValueOnce(true);
      const r2 = await AstroPublisher.reconcileTopicBlockedPostPrs();
      expect(r2).toMatchObject({ count: 1, retired: 1 });
      expect(stamps.some((p) => p.astro_retire_pr_number === null)).toBe(true);
    });

    test('a PR reopened and merged between the read and the branch retirement takes the merged path (row follows the merge, never a closed stamp) (codex r32 P1)', async () => {
      const stamps = [];
      reconcileDb([owedRow()], stamps);
      gh.getPr
        .mockResolvedValueOnce({ number: 43, state: 'closed', merged: false, head: { ref: 'content/blog-ant-trails' } })
        .mockResolvedValue({ number: 43, state: 'closed', merged: true, merged_at: '2026-08-28T09:30:00Z', merge_commit_sha: 'm2', head: { ref: 'content/blog-ant-trails' } });
      const r = await AstroPublisher.reconcileTopicBlockedPostPrs();
      expect(r).toMatchObject({ count: 1, retired: 0, merged: 1 });
      expect(stamps.find((p) => p.astro_status === 'merged')).toMatchObject({ status: 'published' });
      expect(stamps.some((p) => p.astro_retire_pr_number === null)).toBe(true);
    });

    test('a close GitHub rejects leaves the debt in place (nothing settled, retried next tick)', async () => {
      const stamps = [];
      reconcileDb([owedRow()], stamps);
      gh.getPr.mockResolvedValue({ number: 43, state: 'open', merged: false, head: { ref: 'content/blog-ant-trails' } });
      gh.closePr.mockRejectedValue(new Error('502'));
      const res = await AstroPublisher.reconcileTopicBlockedPostPrs();
      expect(res).toMatchObject({ count: 1, retired: 0 });
      expect(stamps.some((p) => p.astro_retire_pr_number === null)).toBe(false);
    });

    test('a PR a human merged before the close: the row follows the merge (no longer parked) and the debt settles', async () => {
      const stamps = [];
      reconcileDb([owedRow()], stamps);
      gh.getPr.mockResolvedValue({ number: 43, state: 'closed', merged: true, merged_at: '2026-08-28T09:00:00Z', merge_commit_sha: 'm1', head: { ref: 'content/blog-ant-trails' } });
      const res = await AstroPublisher.reconcileTopicBlockedPostPrs();
      expect(res).toMatchObject({ count: 1, retired: 0, merged: 1 });
      expect(gh.closePr).not.toHaveBeenCalled();
      expect(stamps.find((p) => p.astro_status === 'merged')).toMatchObject({ status: 'published' });
      expect(stamps.some((p) => p.astro_retire_pr_number === null)).toBe(true);
    });

    test('a merge discovered during retirement queues internal-link planning like the mergeAstro merge paths (codex r26 P2)', async () => {
      const logger = require('../services/logger');
      process.env.INTERNAL_LINK_PLAN_ON_BLOG_MERGE = 'true';
      const stamps = [];
      reconcileDb([owedRow()], stamps);
      gh.getPr.mockResolvedValue({ number: 43, state: 'closed', merged: true, merged_at: '2026-08-28T09:00:00Z', merge_commit_sha: 'm1', head: { ref: 'content/blog-ant-trails' } });
      try {
        await AstroPublisher.reconcileTopicBlockedPostPrs();
        for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
        const lines = [...logger.info.mock.calls, ...logger.warn.mock.calls].map((c) => String(c[0]));
        expect(lines.some((l) => /internal-link planning/.test(l))).toBe(true);
      } finally { process.env.INTERNAL_LINK_PLAN_ON_BLOG_MERGE = 'false'; }
    });

    test('a row republished while GitHub was awaited (current PR #44) is NOT overwritten with the old merged PR #43 (codex r21 P1)', async () => {
      const stamps = [];
      reconcileDb([owedRow()], stamps, { current: owedRow({ astro_pr_number: 44, astro_branch_name: 'content/blog-ant-trails-v2', astro_status: 'pr_open' }) });
      gh.getPr.mockResolvedValue({ number: 43, state: 'closed', merged: true, merged_at: '2026-08-28T09:00:00Z', merge_commit_sha: 'm1', head: { ref: 'content/blog-ant-trails' } });
      const res = await AstroPublisher.reconcileTopicBlockedPostPrs();
      expect(res).toMatchObject({ count: 1, merged: 1 });
      expect(stamps.some((p) => p.astro_status === 'merged')).toBe(false);
      expect(stamps.some((p) => p.astro_retire_pr_number === null)).toBe(true);
    });

    test('pages-poll runs the reconcile BEFORE the Cloudflare config check (a Pages outage cannot disable the cleanup) (codex r22)', async () => {
      const saved = { CF_API_TOKEN: process.env.CF_API_TOKEN, CF_ACCOUNT_ID: process.env.CF_ACCOUNT_ID };
      delete process.env.CF_API_TOKEN;
      delete process.env.CF_ACCOUNT_ID;
      const spy = jest.spyOn(AstroPublisher, 'reconcileTopicBlockedPostPrs').mockResolvedValue({ count: 1, retired: 1, merged: 0 });
      try {
        const pagesPoll = require('../services/content-astro/pages-poll');
        const res = await pagesPoll.pollPending();
        expect(res).toMatchObject({ skipped: true, topicRetire: { retired: 1 } });
        expect(spy).toHaveBeenCalledTimes(1);
      } finally {
        spy.mockRestore();
        if (saved.CF_API_TOKEN !== undefined) process.env.CF_API_TOKEN = saved.CF_API_TOKEN;
        if (saved.CF_ACCOUNT_ID !== undefined) process.env.CF_ACCOUNT_ID = saved.CF_ACCOUNT_ID;
      }
    });

    test('a republished row (fresh PR #44) owes a close for #43 only — #44 and its branch are never touched', async () => {
      const stamps = [];
      reconcileDb([owedRow({ astro_pr_number: 44, astro_branch_name: 'content/blog-ant-trails-v2', astro_status: 'pr_open' })], stamps);
      prLifecycle();
      await AstroPublisher.reconcileTopicBlockedPostPrs();
      expect(gh.getPr.mock.calls.every((c) => c[0] === 43)).toBe(true);
      expect(gh.closePr).toHaveBeenCalledWith(43);
      expect(gh.closePr).not.toHaveBeenCalledWith(44);
      expect(gh.deleteRef).toHaveBeenCalledWith('content/blog-ant-trails');
      expect(gh.deleteRef).not.toHaveBeenCalledWith('content/blog-ant-trails-v2');
      expect(stamps.find((p) => p.astro_retire_pr_number === null)).toBeDefined();
      expect(stamps.some((p) => p.astro_status === 'merged')).toBe(false);
    });
  });

  test('a busy topic-merge lock defers the merge (TOPIC_MERGE_LOCK_BUSY), nothing merged', async () => {
    const queries = [chain({ first: jest.fn().mockResolvedValue(prOpenPost()) })];
    db.mockImplementation(() => queries.shift() || chain());
    cleanReview();
    mockBranchFile('Ant Trails in Bradenton');
    grantTopicMergeLock(false);
    await expect(AstroPublisher.mergeAstro('post-gate-1')).rejects.toMatchObject({ code: 'TOPIC_MERGE_LOCK_BUSY' });
    expect(gh.mergePr).not.toHaveBeenCalled();
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });

  test('a clear recheck merges; a refresh of a live post skips the recheck', async () => {
    const queries = [chain({ first: jest.fn().mockResolvedValue(prOpenPost()) })];
    db.mockImplementation(() => queries.shift() || chain());
    cleanReview();
    mockBranchFile('Ant Trails in Bradenton');
    expect((await AstroPublisher.mergeAstro('post-gate-1')).merged).toBe(true);

    jest.clearAllMocks();
    const planner = require('../services/content/internal-link-planner');
    planner.loadAstroCorpusFromGitHub.mockRejectedValueOnce(new Error('github_down'));
    const q2 = [chain({ first: jest.fn().mockResolvedValue(prOpenPost({ astro_live_url: 'https://www.wavespestcontrol.com/ant-trails-bradenton/' })) })];
    db.mockImplementation(() => q2.shift() || chain());
    cleanReview();
    mockBranchFile('Ant Trails in Tampa');
    expect((await AstroPublisher.mergeAstro('post-gate-1')).merged).toBe(true);
  });
});

describe('deploy-match window uses CREATION time, not completion (audit regression)', () => {
  test('a deploy created before the merge that COMPLETED after it does not match', () => {
    // Old code compared modified_on (completion): a 30–45 min build of the
    // PREVIOUS commit finishing after this merge matched the window.
    const deploy = {
      environment: 'production',
      latest_stage: { name: 'deploy', status: 'success' },
      stages: [{ name: 'deploy', status: 'success' }],
      created_on: '2026-05-08T12:40:00.000Z', // triggered pre-merge
      modified_on: '2026-05-08T13:10:00.000Z', // finished post-merge
      deployment_trigger: { metadata: { branch: 'main' } },
    };
    const post = { astro_merged_at: '2026-05-08T13:00:00.000Z' };
    expect(PagesPoll.deploymentMatchesMergedPost(deploy, post)).toBe(false);
  });
});

describe('frontmatter date stamping (ET)', () => {
  const { etDateString } = require('../utils/datetime-et');
  const base = {
    title: 'Date Stamp Test Post',
    slug: 'date-stamp-test-post',
    meta_description: 'A short guide used to exercise frontmatter date stamping.',
    keyword: 'date stamping',
    tag: 'Ants',
    content: 'Body copy for the date stamping tests.',
  };

  test('a corrupt epoch-zero publish_date falls back to today ET (a live post shipped dated 1970-01-01)', async () => {
    const data = await AstroPublisher.buildFrontmatter({ ...base, publish_date: new Date(0) });
    expect(data.published).toBe(etDateString());
    expect(data.updated).toBe(etDateString());
  });

  test('a future publish_date clamps to today ET (posts may not claim a future publish date)', async () => {
    const future = new Date(Date.now() + 7 * 24 * 3600 * 1000);
    const data = await AstroPublisher.buildFrontmatter({ ...base, publish_date: future });
    expect(data.published).toBe(etDateString());
  });

  test('a stored DATE-column value keeps its calendar day (pg returns midnight Date objects)', async () => {
    // pg parses DATE columns to local-midnight Dates — the stored calendar
    // day is read directly, never shifted through a timezone conversion.
    const data = await AstroPublisher.buildFrontmatter({ ...base, publish_date: new Date(2026, 4, 8) });
    expect(data.published).toBe('2026-05-08');
  });

  test('a date-only string publish_date passes through unshifted', async () => {
    const data = await AstroPublisher.buildFrontmatter({ ...base, publish_date: '2026-05-08' });
    expect(data.published).toBe('2026-05-08');
  });

  test('an epoch-zero review stamp heals to today ET (schema-required field — dropping it would block publish)', async () => {
    const data = await AstroPublisher.buildFrontmatter({ ...base, fact_checked_at: new Date(0) });
    expect(data.fact_checked).toBe(etDateString());
  });

  test('an absent review stamp stays absent (unchanged behavior)', async () => {
    const data = await AstroPublisher.buildFrontmatter({ ...base });
    expect(data.fact_checked).toBeUndefined();
  });
});

describe('Codex 2026-07 format change (review objects, no issue comments)', () => {
  test('a clean verdict delivered as a submitted REVIEW OBJECT is recognized', () => {
    const { codexReviewStatus } = AstroPublisher._internals;
    const head = 'abcdef1234567890abcdef1234567890abcdef12';
    expect(codexReviewStatus({
      headSha: head,
      comments: [{
        user: { login: 'wavespestcontrolfl' },
        body: `@codex review\n\nReady on head \`${head}\`.`,
        created_at: '2026-07-22T12:00:00Z',
      }],
      reviews: [{
        user: { login: 'chatgpt-codex-connector[bot]' },
        state: 'COMMENTED',
        commit_id: head,
        body: "### 💡 Codex Review\n\nDidn't find any major issues.\n\n**Reviewed commit:** `abcdef1234`",
        submitted_at: '2026-07-22T12:05:00Z',
      }],
    })).toEqual({ clean: true });
  });

  test('a findings review object ("automated review suggestions") is NOT clean', () => {
    const { codexReviewStatus } = AstroPublisher._internals;
    const head = 'abcdef1234567890abcdef1234567890abcdef12';
    expect(codexReviewStatus({
      headSha: head,
      comments: [{
        user: { login: 'wavespestcontrolfl' },
        body: `@codex review\n\nReady on head \`${head}\`.`,
        created_at: '2026-07-22T12:00:00Z',
      }],
      reviews: [{
        user: { login: 'chatgpt-codex-connector[bot]' },
        state: 'COMMENTED',
        commit_id: head,
        body: '### 💡 Codex Review\n\nHere are some automated review suggestions for this pull request.\n\n**Reviewed commit:** `abcdef1234`',
        submitted_at: '2026-07-22T12:05:00Z',
      }],
    })).toMatchObject({ clean: false });
  });
});

describe('latestDeploymentForBranch pagination (astro #396 wedge, 2026-07-22)', () => {
  const OLD_ENV = { ...process.env };
  afterEach(() => { process.env = { ...OLD_ENV }; global.fetch = undefined; });

  function deploysPage(items) {
    return { ok: true, json: async () => ({ result: items }) };
  }
  const deploy = (branch, id) => ({ id, deployment_trigger: { metadata: { branch } } });

  test('finds a branch deployment beyond page 1 and stops on a short page', async () => {
    process.env.CF_API_TOKEN = 't'; process.env.CF_ACCOUNT_ID = 'a';
    const pages = [
      deploysPage(Array.from({ length: 25 }, (_, i) => deploy(`other-${i}`, `p1-${i}`))),
      deploysPage([deploy('content/target-branch', 'the-one'), ...Array.from({ length: 10 }, (_, i) => deploy(`x-${i}`, `p2-${i}`))]),
    ];
    const calls = [];
    global.fetch = jest.fn(async (url) => { calls.push(url); return pages[calls.length - 1] || deploysPage([]); });
    const hit = await PagesPoll.latestDeploymentForBranch('content/target-branch');
    expect(hit).toMatchObject({ id: 'the-one' });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('page=1');
    expect(calls[1]).toContain('page=2');
  });

  test('returns null after a short page with no match (no infinite scan)', async () => {
    process.env.CF_API_TOKEN = 't'; process.env.CF_ACCOUNT_ID = 'a';
    global.fetch = jest.fn(async () => deploysPage([deploy('unrelated', 'z')]));
    const hit = await PagesPoll.latestDeploymentForBranch('content/target-branch');
    expect(hit).toBeNull();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('scans at most 4 pages of full results', async () => {
    process.env.CF_API_TOKEN = 't'; process.env.CF_ACCOUNT_ID = 'a';
    global.fetch = jest.fn(async () => deploysPage(Array.from({ length: 25 }, (_, i) => deploy(`other-${i}`, `d${i}`))));
    const hit = await PagesPoll.latestDeploymentForBranch('content/target-branch');
    expect(hit).toBeNull();
    expect(global.fetch).toHaveBeenCalledTimes(4);
  });
});

  test('clean markers split ACROSS artifacts do not combine into a false clean', () => {
    const { codexReviewStatus } = AstroPublisher._internals;
    const head = 'abcdef1234567890abcdef1234567890abcdef12';
    expect(codexReviewStatus({
      headSha: head,
      comments: [
        {
          user: { login: 'wavespestcontrolfl' },
          body: `@codex review\n\nReady on head \`${head}\`.`,
          created_at: '2026-07-22T12:00:00Z',
        },
        {
          user: { login: 'chatgpt-codex-connector' },
          body: `Follow-up on \`${head}\`: the last pass didn't find any major issues in the frontmatter, but the body review is below.`,
          created_at: '2026-07-22T12:06:00Z',
        },
      ],
      reviews: [{
        user: { login: 'chatgpt-codex-connector[bot]' },
        state: 'COMMENTED',
        commit_id: head,
        body: '### 💡 Codex Review\n\nHere are some automated review suggestions for this pull request.\n\n**Reviewed commit:** `abcdef1234`',
        submitted_at: '2026-07-22T12:05:00Z',
      }],
    })).toMatchObject({ clean: false });
  });

  test('a stale clean review object does not override a newer findings comment', () => {
    const { codexReviewStatus } = AstroPublisher._internals;
    const head = 'abcdef1234567890abcdef1234567890abcdef12';
    expect(codexReviewStatus({
      headSha: head,
      comments: [
        {
          user: { login: 'wavespestcontrolfl' },
          body: `@codex review\n\nRe-review requested on head \`${head}\`.`,
          created_at: '2026-07-22T12:10:00Z',
        },
        {
          user: { login: 'chatgpt-codex-connector' },
          body: `Codex Review: found 2 issues on \`${head}\` — see inline comments.`,
          created_at: '2026-07-22T12:20:00Z',
        },
      ],
      reviews: [{
        user: { login: 'chatgpt-codex-connector[bot]' },
        state: 'COMMENTED',
        commit_id: head,
        body: "### 💡 Codex Review\n\nDidn't find any major issues.\n\n**Reviewed commit:** `abcdef1234`",
        submitted_at: '2026-07-22T12:00:00Z',
      }],
    })).toMatchObject({ clean: false });
  });

  test('an old clean review does not satisfy a NEWER same-head re-request awaiting response', () => {
    const { codexReviewStatus } = AstroPublisher._internals;
    const head = 'abcdef1234567890abcdef1234567890abcdef12';
    expect(codexReviewStatus({
      headSha: head,
      comments: [{
        user: { login: 'wavespestcontrolfl' },
        body: `@codex review\n\nRe-review requested on head \`${head}\`.`,
        created_at: '2026-07-22T12:10:00Z',
      }],
      reviews: [{
        user: { login: 'chatgpt-codex-connector[bot]' },
        state: 'COMMENTED',
        commit_id: head,
        body: "### 💡 Codex Review\n\nDidn't find any major issues.\n\n**Reviewed commit:** `abcdef1234`",
        submitted_at: '2026-07-22T12:00:00Z',
      }],
    })).toMatchObject({ clean: false });
  });

describe('PR bodies disclose backfilled schema-required fields (Codex r1)', () => {
  const base = {
    filePath: 'src/content/blog/lawn-care/old-post.mdx',
    targetUrl: 'https://www.wavespestcontrol.com/lawn-care/old-post/',
    branch: 'content/autonomous-x',
    before: { title: 'Old', meta_description: 'Old meta' },
    after: { title: 'New', meta_description: 'New meta' },
    brief: { action_type: 'rewrite_title_meta' },
  };

  test('backfill covers genuinely absent post_type only — an explicit empty/whitespace value stays for validation to reject (Codex r5)', () => {
    const { backfillLegacyBlogRequiredFields } = AstroPublisher._internals;
    // A page_type that RELIABLY maps (how-to → protocol) is backfilled; the
    // consumed pre-v2 key is removed AND the removal is disclosed in the
    // healed list so PR bodies reflect the full migration (Codex r12).
    const absent = { page_type: 'how-to', service_areas_tag: ['Sarasota'] };
    const healed = backfillLegacyBlogRequiredFields(absent, {});
    expect(healed).toContain('post_type');
    expect(healed).toContain('page_type (legacy key consumed & removed)');
    expect(absent.post_type).toBe('protocol');
    expect(absent.page_type).toBeUndefined();
    const invalid = { post_type: '  ', page_type: 'how-to', service_areas_tag: ['Sarasota'] };
    expect(backfillLegacyBlogRequiredFields(invalid, {})).not.toContain('post_type');
    expect(invalid.post_type).toBe('  ');
  });

  test('backfill never defaults post_type to location — an unmappable legacy page_type parks for human classification (Codex r11)', () => {
    const { backfillLegacyBlogRequiredFields } = AstroPublisher._internals;
    // Legacy posts generally carry page_type 'blog' or nothing; the
    // 'location' fallback misclassifies seasonal/cost/comparison content
    // and post_type drives structural component requirements.
    for (const pageType of ['blog', undefined]) {
      const fm = { page_type: pageType, service_areas_tag: ['Sarasota'] };
      expect(backfillLegacyBlogRequiredFields(fm, {})).not.toContain('post_type');
      expect(fm.post_type).toBeUndefined();
    }
  });

  test('serviceAreasForCity is the one service-area mapping: served localities resolve to their office area, regions to their areas (PR #3549 codex r12)', () => {
    expect(AstroPublisher.serviceAreasForCity('Ruskin')).toEqual(['Parrish']);
    expect(AstroPublisher.serviceAreasForCity('Anna Maria')).toEqual(['Bradenton']);
    expect(AstroPublisher.serviceAreasForCity('Venice, FL')).toEqual(['Venice']);
    expect(AstroPublisher.serviceAreasForCity('Lakewood Ranch')).toEqual(['Lakewood Ranch']);
    expect(AstroPublisher.serviceAreasForCity('Charlotte County')).toEqual(['Port Charlotte']);
    // Qualified region forms are the same regions (PR codex r21 P2).
    expect(AstroPublisher.serviceAreasForCity('Manatee County, FL')).toEqual(['Bradenton', 'Lakewood Ranch', 'Palmetto', 'Parrish']);
    expect(AstroPublisher.serviceAreasForCity('Sarasota County, Florida')).toEqual(['Sarasota', 'Venice', 'North Port']);
    expect(AstroPublisher.serviceAreasForCity('Charlotte County, FL')).toEqual(['Port Charlotte']);
    for (const c of ['Southwest FL', 'SW FL', 'SW Fla.', 'Southwest Fla']) expect(AstroPublisher.serviceAreasForCity(c)).toHaveLength(8); // codex r30
    expect(AstroPublisher.serviceAreasForCity('Southwest Florida')).toHaveLength(8);
    for (const c of ['Tampa', 'Boise', 'Venice Beach', '']) expect(AstroPublisher.serviceAreasForCity(c)).toEqual([]);
    const { inferServiceAreas } = AstroPublisher._internals;
    expect(inferServiceAreas({ title: 'Ant trails', city: 'Ruskin' }, {})).toEqual(['Parrish']);
    expect(inferServiceAreas({ title: 'Ant trails', city: 'Apollo Beach' }, {})).toEqual(['Parrish']);
  });

  test('inferServiceAreas rejects an explicit out-of-area city — all-area fallback is for posts with NO city signal (Codex r11)', () => {
    const { inferServiceAreas } = AstroPublisher._internals;
    // Explicit invalid city → corrupt geography data → empty, so schema
    // validation parks the row instead of tagging every service area.
    expect(inferServiceAreas({ title: 'Lawn care guide', city: 'Tampa' }, {})).toEqual([]);
    expect(inferServiceAreas({ title: 'Lawn care guide' }, { city: 'Tampa' })).toEqual([]);
    // No city signal at all → haystack match, then the all-area fallback.
    expect(inferServiceAreas({ title: 'Sarasota lawn care guide' }, {})).toEqual(['Sarasota']);
    expect(inferServiceAreas({ title: 'Generic lawn care guide' }, {}).length).toBeGreaterThan(0);
  });

  test('inferServiceAreas scrubs Florida vernacular before the city match — "Palmetto bugs" is a roach, not the city (Codex r13)', () => {
    const { inferServiceAreas } = AstroPublisher._internals;
    // A generic palmetto-bug post gets the all-area fallback, NOT ['Palmetto'].
    const generic = inferServiceAreas({ title: 'How to keep Palmetto bugs out of your garage' }, {});
    expect(generic).not.toEqual(['Palmetto']);
    expect(generic.length).toBeGreaterThan(1);
    // The actual city still matches.
    expect(inferServiceAreas({ title: 'Palmetto lawn care schedule' }, {})).toEqual(['Palmetto']);
  });

  test('backfill covers genuinely absent service_areas_tag only — an explicit EMPTY array is present data and stays for validation to reject (Codex r11)', () => {
    const { backfillLegacyBlogRequiredFields } = AstroPublisher._internals;
    const absent = { post_type: 'location', page_type: 'blog', title: 'Sarasota lawn care' };
    expect(backfillLegacyBlogRequiredFields(absent, {})).toContain('service_areas_tag');
    expect(Array.isArray(absent.service_areas_tag) && absent.service_areas_tag.length > 0).toBe(true);
    const explicitEmpty = { post_type: 'location', page_type: 'blog', title: 'Sarasota lawn care', service_areas_tag: [] };
    expect(backfillLegacyBlogRequiredFields(explicitEmpty, {})).not.toContain('service_areas_tag');
    expect(explicitEmpty.service_areas_tag).toEqual([]); // inferring over it could publish wrong geography
  });

  test('metadata PR body lists inferred fields when backfilled, stays silent otherwise', () => {
    const withFields = AstroPublisher._internals.buildMetadataPrBody({ ...base, backfilledFields: ['post_type', 'service_areas_tag'] });
    expect(withFields).toContain('Backfilled schema-required fields');
    expect(withFields).toContain('`post_type`');
    expect(withFields).toContain('`service_areas_tag`');
    const without = AstroPublisher._internals.buildMetadataPrBody(base);
    expect(without).not.toContain('Backfilled schema-required fields');
  });

  test('refresh PR body lists inferred fields when backfilled, stays silent otherwise', () => {
    const withFields = AstroPublisher._internals.buildRefreshPrBody({ ...base, oldBody: 'a b', newBody: 'a b c', backfilledFields: ['post_type'] });
    expect(withFields).toContain('Backfilled schema-required fields');
    expect(withFields).toContain('`post_type`');
    const without = AstroPublisher._internals.buildRefreshPrBody({ ...base, oldBody: 'a b', newBody: 'a b c' });
    expect(without).not.toContain('Backfilled schema-required fields');
  });

  test('every PR body that commits generated images carries the "### Images" provenance, and a flagged screen is bold (Codex hook on the image lane)', () => {
    const { buildPrBody, buildDraftPrBody, buildRefreshPrBody, buildMetadataPrBody } = AstroPublisher._internals;
    const flagged = { model: 'gpt-image-2', plan: { style: 'cartoon', setting: 'inside a residential garage, tools on the wall', timeOfDay: 'dusk' }, screen: { checked: true, ok: false, reasons: ['logo or brand mark: Orkin'] } };
    const clean = { model: 'gemini-image-pro', plan: { style: 'photo', setting: 'a pool cage', timeOfDay: 'noon' }, screen: { checked: true, ok: true, reasons: [] } };
    const images = { hero: flagged, body: [clean] };
    const admin = buildPrBody({ post: { category: 'lawn-care' }, slug: 'x', branch: 'b', content: 'a b', images });
    const draft = buildDraftPrBody({ frontmatter: {}, slug: 'x', branch: 'b', content: 'a b', brief: {}, images });
    const refresh = buildRefreshPrBody({ ...base, oldBody: 'a b', newBody: 'a b c', images: { hero: null, body: [flagged] } });
    for (const body of [admin, draft, refresh]) {
      expect(body).toContain('### Images');
      expect(body).toContain('**screen flagged after retry: logo or brand mark: Orkin**');
      expect(body).toContain('gpt-image-2 (cartoon, inside a residential garage, dusk)');
    }
    expect(admin).toContain('- body-1: gemini-image-pro (photo, a pool cage, noon) — screen clean');
    // No images → no section; the metadata lane never commits images and takes no `images` at all.
    expect(buildPrBody({ post: {}, slug: 'x', branch: 'b', content: 'a' })).not.toContain('### Images');
    expect(buildRefreshPrBody({ ...base, oldBody: 'a', newBody: 'a b', images: { hero: null, body: [] } })).not.toContain('### Images');
    expect(() => buildMetadataPrBody(base)).not.toThrow();
    expect(buildMetadataPrBody(base)).not.toContain('### Images');
  });
});


describe('generatePlannedImage — one deadline per slot, safer candidate when both screens fail (Codex r6 P2 on #3964)', () => {
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const args = { title: 'T', keyword: 'K', mode: 'blog-hero', slug: 'x/y', index: 0 };

  test('the screen retry reuses the first call\'s deadline and, when both fail, the candidate without a logo ships with its warning', async () => {
    const imageGenerator = require('../services/content/image-generator');
    const { screenGeneratedImage } = require('../services/content/hero-alt-vision');
    imageGenerator.generate.mockReset().mockResolvedValue({ dataUrl: PNG, mimeType: 'image/png', model: 'gpt-image-2', attempts: [], alt: 'a' });
    screenGeneratedImage
      .mockResolvedValueOnce({ ok: false, checked: true, readableText: ['ZONE 5'], logos: [], reasons: ['readable text: ZONE 5'] })
      .mockResolvedValueOnce({ ok: false, checked: true, readableText: ['ZONE 5'], logos: ['Orkin'], reasons: ['logo or brand mark: Orkin', 'readable text: ZONE 5'] });
    const before = Date.now();
    const out = await AstroPublisher.generatePlannedImage(args);
    expect(imageGenerator.generate).toHaveBeenCalledTimes(2);
    const [first, second] = imageGenerator.generate.mock.calls.map((c) => c[0].deadlineAt);
    expect(first).toBe(second);
    expect(first).toBeGreaterThanOrEqual(before + 360000);
    // The screen is bounded by what is left of the same deadline (Codex r7 P2).
    for (const call of screenGeneratedImage.mock.calls) {
      expect(call[0].timeoutMs).toBeGreaterThan(0);
      expect(call[0].timeoutMs).toBeLessThanOrEqual(360000);
    }
    expect(out.screen.logos).toEqual([]);
    expect(out.screen.reasons).toEqual(['readable text: ZONE 5']);
    // The slot deadline rides on the result so the caller's alt pass shares it (Codex r9 P2).
    expect(out.deadlineAt).toBe(first);
  });

  test('with no logos on either side, the candidate with fewer detected strings ships (Codex r7 P2)', async () => {
    const imageGenerator = require('../services/content/image-generator');
    const { screenGeneratedImage } = require('../services/content/hero-alt-vision');
    imageGenerator.generate.mockReset().mockResolvedValue({ dataUrl: PNG, mimeType: 'image/png', model: 'gpt-image-2', attempts: [], alt: 'a' });
    screenGeneratedImage
      .mockResolvedValueOnce({ ok: false, checked: true, readableText: ['ZONE 5', 'SET TIME', 'RUN'], logos: [], reasons: ['readable text: ZONE 5, SET TIME, RUN'] })
      .mockResolvedValueOnce({ ok: false, checked: true, readableText: ['ON'], logos: [], reasons: ['readable text: ON'] });
    const out = await AstroPublisher.generatePlannedImage(args);
    expect(out.screen.readableText).toEqual(['ON']);
  });

  test('a caller-supplied deadline is honoured by both generate calls (near-duplicate re-framing shares the slot budget — Codex r8 P2)', async () => {
    const imageGenerator = require('../services/content/image-generator');
    const { screenGeneratedImage } = require('../services/content/hero-alt-vision');
    imageGenerator.generate.mockReset().mockResolvedValue({ dataUrl: PNG, mimeType: 'image/png', model: 'gpt-image-2', attempts: [], alt: 'a' });
    screenGeneratedImage.mockResolvedValueOnce({ ok: true, checked: true, readableText: [], logos: [], reasons: [] });
    const deadlineAt = Date.now() + 1234;
    await AstroPublisher.generatePlannedImage({ ...args, deadlineAt, avoidDepicting: ['irrigation repair scenes'] });
    expect(imageGenerator.generate.mock.calls[0][0].deadlineAt).toBe(deadlineAt);
    expect(screenGeneratedImage.mock.calls.at(-1)[0]).toMatchObject({ avoidDepicting: ['irrigation repair scenes'] });
  });

  test('a clean first image returns without a retry', async () => {
    const imageGenerator = require('../services/content/image-generator');
    const { screenGeneratedImage } = require('../services/content/hero-alt-vision');
    imageGenerator.generate.mockReset().mockResolvedValue({ dataUrl: PNG, mimeType: 'image/png', model: 'gemini-image-pro', attempts: [], alt: 'a' });
    screenGeneratedImage.mockResolvedValueOnce({ ok: true, checked: true, readableText: [], logos: [], reasons: [] });
    const out = await AstroPublisher.generatePlannedImage(args);
    expect(imageGenerator.generate).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ model: 'gemini-image-pro', screen: { ok: true } });
  });
});

describe('autonomous body images (owner rule 2026-08-27: ≥3 images per post)', () => {
  const fmModule = require('../services/content-astro/frontmatter');
  const featureGates = require('../config/feature-gates');
  const { bodyImageSlots, insertBodyImages, countBodyImages, BODY_IMAGE_MIN } = AstroPublisher._internals;
  const article = [
    'Intro paragraph about frass on a Venice window sill.',
    '',
    '## Reading the pellets',
    '',
    'Drywood frass is hexagonal in cross-section. See [our guide](/termite-control/) for more.',
    '',
    '- bullet one',
    '- bullet two',
    '',
    '## Where the colony sits',
    '',
    '<ComparisonTable rows={[["a","b"]]} />',
    '',
    'Follow the pile straight up to the window frame.',
    '',
    '```js',
    '## not a heading inside a fence',
    '```',
    '',
    '### Fascia boards',
    '',
    'Fascia galleries are the usual suspects in older homes.',
    '',
    '## What a quote covers',
    '',
    'A drywood treatment quote is per structure.',
    '',
    '## Frequently asked questions',
    '',
    '**Is frass dangerous?** No.',
  ].join('\n');

  // Real, visually DISTINCT pictures (the 1×1 HERO_PNG hashes identically to
  // any other flat image): 32×32 RGB patterns whose gradients differ per seed.
  const PATTERNS = [];
  async function patternPng(seed) {
    const sharp = require('sharp');
    const w = 32; const h = 32; const raw = Buffer.alloc(w * h * 3);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      const v = seed % 2 === 0 ? ((x * 8 * seed) + (y * 3)) % 256 : ((y * 8 * seed) + ((x * 7 * seed) % 5) * 40) % 256;
      raw[i] = v; raw[i + 1] = (v * 3 + seed * 40) % 256; raw[i + 2] = (255 - v + seed * 17) % 256;
    }
    const png = await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
    return `data:image/png;base64,${png.toString('base64')}`;
  }
  beforeAll(async () => { for (const seed of [1, 2, 3, 4, 5]) PATTERNS.push(await patternPng(seed)); });
  // Committed-file stub with REAL distinct bytes (the picture-level check
  // reads them): pattern index by path order.
  const committedStub = (paths) => {
    const b64 = (dataUrl) => dataUrl.split(',')[1];
    return async (path) => {
      const idx = paths.indexOf(path);
      return idx >= 0 ? { content: '', sha: `s${idx}`, raw: { content: b64(PATTERNS[(idx + 2) % PATTERNS.length]) } } : null;
    };
  };

  // Default generator: a different picture on every call, prompt-derived alt
  // for body images. Tests that need specific pictures override it.
  function mockRotatingGeneration() {
    let call = 0;
    heroImageGenerator.generate.mockImplementation(async ({ mode, keyword }) => ({
      dataUrl: PATTERNS[call++ % PATTERNS.length],
      model: 'test-model',
      alt: mode === 'blog-body' ? `Prompt alt for ${keyword}` : 'hero alt',
      attempts: [],
    }));
    gh.putBinary.mockResolvedValue({});
  }

  beforeEach(() => {
    gh.listDir.mockReset();
    gh.listDir.mockResolvedValue([]);
    // publishAstro's topic-targeting gate loads the live corpus — reset any
    // one-shot rejection a prior test left unconsumed and restore the benign
    // corpus the file-level mock provides.
    const planner = require('../services/content/internal-link-planner');
    planner.loadAstroCorpusFromGitHub.mockReset();
    planner.loadAstroCorpusFromGitHub.mockResolvedValue([{
      file: 'src/content/blog/quokka-habitat-notes.md',
      url: '/quokka-habitat-notes/',
      body: '---\ntitle: Quokka Habitat Notes\nslug: /quokka-habitat-notes/\nprimary_keyword: quokka habitat\n---\n\n## Quokka basics\n',
    }]);
    jest.clearAllMocks();
    jest.spyOn(featureGates, 'isEnabled').mockImplementation((g) => g === 'blogBodyImages');
    factCheckGate.evaluate.mockResolvedValue({ pass: true, findings: [], checked: false });
    heroAltVision.describeHeroForAlt.mockResolvedValue(null);
    gh.createBranch.mockResolvedValue({});
    gh.putFile.mockResolvedValue({ commit: { sha: 'file-sha' } });
    gh.commitFiles.mockResolvedValue({ commit: { sha: 'file-sha' } });
    gh.createPr.mockResolvedValue({ number: 201, html_url: 'https://github.com/wavespestcontrolfl/wavespestcontrol-astro/pull/201' });
    gh.createIssueComment.mockResolvedValue({});
    mockRotatingGeneration();
  });
  afterEach(() => featureGates.isEnabled.mockRestore());

  function draft(body = article, fmOverrides = {}) {
    return {
      type: 'draft',
      frontmatter: validFrontmatter({
        slug: '/drywood-frass-venice/',
        title: 'Drywood Termite Frass in Venice',
        canonical: 'https://www.wavespestcontrol.com/drywood-frass-venice/',
        hero_image: { src: '/images/blog/drywood-frass-venice/hero.png', alt: 'Frass on a sill' },
        og_image: '/images/blog/drywood-frass-venice/hero.png',
        ...fmOverrides,
      }),
      body,
    };
  }

  test('bodyImageSlots: spreads slots across H2 sections, skips FAQ, lists, MDX blocks and fences, inserts after prose', () => {
    const slots = bodyImageSlots(article, 2, { title: 'T' });
    expect(slots).toHaveLength(2);
    const lines = article.split('\n');
    // 1st slot: "Reading the pellets" — right after its prose paragraph, before the list.
    expect(slots[0].heading).toBe('Reading the pellets');
    expect(lines[slots[0].insertAt - 1]).toMatch(/^Drywood frass/);
    expect(slots[0].lead).toBe('Drywood frass is hexagonal in cross-section. See our guide for more.');
    // 2nd slot: spread to the 3rd eligible H2 (FAQ excluded) — after its prose.
    expect(slots[1].heading).toBe('What a quote covers');
    expect(lines[slots[1].insertAt - 1]).toMatch(/^A drywood treatment quote/);
    // A heading inside a fence is never a section.
    expect(slots.map((sl) => sl.heading)).not.toContain('not a heading inside a fence');
  });

  test('bodyImageSlots: headings inside comments, <pre> and fences (incl. shorter backtick runs inside a longer fence) are never sections; code is never prose (hook r6)', () => {
    const body = [
      '## Real section', '', 'Real prose.', '',
      '<!-- ## Commented heading', '', 'hidden prose -->', '',
      '<pre>', '## Pre heading', 'pre text', '</pre>', '',
      '````md', '## Fenced heading', '```', 'still inside the 4-backtick fence', '```', '````', '',
      '## Second real', '', 'More prose.',
    ].join('\n');
    const { sections } = AstroPublisher._internals.scanBodySections
      ? AstroPublisher._internals.scanBodySections(body, { title: 'T' })
      : { sections: [] };
    const slots = bodyImageSlots(body, 3, { title: 'T' });
    expect(slots.map((sl) => sl.heading)).toEqual(['Real section', 'Second real']);
    const lines = body.split('\n');
    expect(lines[slots[0].insertAt - 1]).toBe('Real prose.');
    expect(lines[slots[1].insertAt - 1]).toBe('More prose.');
    expect(sections.map((sec) => sec.heading)).not.toContain('Fenced heading');
  });

  test('bodyImageSlots: H3 prose rolls up into its H2 (slot after the last sub-section paragraph); an image under an H3 marks the H2 illustrated', () => {
    const body = [
      'Intro.', '',
      '## Colony locations', '',
      '### Window frames', '', 'Frames first.', '',
      '### Fascia boards', '', 'Fascia second.', '',
      '## Illustrated section', '',
      '### Sub', '', 'Text.', '', '![already](/images/x.webp)', '',
      '## Third', '', 'Third prose.',
    ].join('\n');
    const slots = bodyImageSlots(body, 2, { title: 'T' });
    expect(slots.map((sl) => sl.heading)).toEqual(['Colony locations', 'Third']);
    expect(body.split('\n')[slots[0].insertAt - 1]).toBe('Fascia second.');
    expect(slots[0].lead).toBe('Frames first.');
  });

  test('bodyImageSlots: sections that already carry an image are skipped; the intro backfills when sections run out', () => {
    const body = 'Intro prose here.\n\n## Only section\n\nProse.\n\n![existing](/images/x.webp)\n';
    const slots = bodyImageSlots(body, 2, { title: 'Title' });
    expect(slots).toHaveLength(1);
    expect(slots[0].heading).toBe('Title');
    expect(body.split('\n')[slots[0].insertAt - 1]).toBe('Intro prose here.');
  });

  test('insertBodyImages: each image lands on its own paragraph, brackets stripped from alt, no triple blank lines', () => {
    const body = 'One.\n\n## A\n\nTwo.\n\n## B\n\nThree.';
    const out = insertBodyImages(body, [
      { insertAt: 5, src: '/images/blog/s/body-1.webp', alt: 'Alt [one]' },
      { insertAt: 9, src: '/images/blog/s/body-2.webp', alt: 'Alt two' },
    ]);
    expect(out).toBe('One.\n\n## A\n\nTwo.\n\n![Alt one](/images/blog/s/body-1.webp)\n\n## B\n\nThree.\n\n![Alt two](/images/blog/s/body-2.webp)');
    expect(countBodyImages(out)).toBe(2);
  });

  test('insertBodyImages: blank lines inside fenced code are preserved; blanks added only where neighbours lack them (hook r4)', () => {
    const body = 'Prose.\n\n```js\nline1\n\n\n\nline2\n```\n\n## B\nThree.';
    const out = insertBodyImages(body, [{ insertAt: 2, src: '/i.webp', alt: 'A' }, { insertAt: 12, src: '/j.webp', alt: 'B' }]);
    expect(out).toBe('Prose.\n\n![A](/i.webp)\n\n```js\nline1\n\n\n\nline2\n```\n\n## B\nThree.\n\n![B](/j.webp)');
  });

  test('gate ON, new post: generates BODY_IMAGE_MIN blog-body images from section context, commits them beside the hero in ONE commit, inserts refs with vetted alts', async () => {
    gh.getFile.mockResolvedValue(null);
    heroAltVision.describeHeroForAlt.mockImplementation(async ({ keyword }) => (keyword === 'Reading the pellets' ? 'Hexagonal drywood termite pellets on a white window sill' : null));

    await AstroPublisher.publishOrUpdatePage(draft(), { action_type: 'new_supporting_blog', city: 'Venice' });

    const bodyCalls = heroImageGenerator.generate.mock.calls.filter(([a]) => a.mode === 'blog-body');
    expect(bodyCalls).toHaveLength(BODY_IMAGE_MIN);
    expect(bodyCalls[0][0]).toEqual(expect.objectContaining({ keyword: 'Reading the pellets', city: 'Venice', title: 'Drywood Termite Frass in Venice' }));
    expect(bodyCalls[0][0].topic).toMatch(/^Drywood frass is hexagonal/);
    expect(bodyCalls[1][0].keyword).toBe('What a quote covers');
    // Framing rotates per slot and every body prompt names the hero subject to differ from.
    expect(bodyCalls[0][0].shot).toBe('close-up');
    expect(bodyCalls[1][0].shot).toBe('action');
    expect(bodyCalls[0][0].avoid).toBe(draft().frontmatter.primary_keyword || 'Drywood Termite Frass in Venice');

    expect(gh.commitFiles).toHaveBeenCalledTimes(1);
    const files = gh.commitFiles.mock.calls[0][0].files;
    expect(files.map((f) => f.path)).toEqual([
      'public/images/blog/pest-control/drywood-frass-venice/hero.webp',
      'public/images/blog/pest-control/drywood-frass-venice/body-1.webp',
      'public/images/blog/pest-control/drywood-frass-venice/body-2.webp',
      'src/content/blog/pest-control/drywood-frass-venice.mdx',
    ]);
    for (const f of files.slice(1, 3)) {
      expect(f.buffer.slice(0, 4).toString('ascii')).toBe('RIFF');
      expect(f.buffer.slice(8, 12).toString('ascii')).toBe('WEBP');
    }
    const parsed = fmModule.parse(files[3].content);
    // Vision alt where available, prompt-derived alt otherwise; refs sit at the end of each section's prose.
    expect(parsed.content).toContain('See [our guide](/termite-control/) for more.\n\n![Hexagonal drywood termite pellets on a white window sill](/images/blog/pest-control/drywood-frass-venice/body-1.webp)\n\n- bullet one');
    expect(parsed.content).toContain('A drywood treatment quote is per structure.\n\n![Prompt alt for What a quote covers](/images/blog/pest-control/drywood-frass-venice/body-2.webp)\n\n## Frequently asked questions');
    expect(countBodyImages(parsed.content)).toBe(BODY_IMAGE_MIN);
    // The hero is never embedded in the body (layout renders it).
    expect(parsed.content).not.toContain('hero.webp');
  });

  test('gate OFF: body untouched, no blog-body generation', async () => {
    featureGates.isEnabled.mockImplementation(() => false);
    gh.getFile.mockResolvedValue(null);
    await AstroPublisher.publishOrUpdatePage(draft(), { action_type: 'new_supporting_blog' });
    expect(heroImageGenerator.generate.mock.calls.filter(([a]) => a.mode === 'blog-body')).toHaveLength(0);
    expect(gh.commitFiles.mock.calls[0][0].files.map((f) => f.path)).toEqual([
      'public/images/blog/pest-control/drywood-frass-venice/hero.webp',
      'src/content/blog/pest-control/drywood-frass-venice.mdx',
    ]);
  });

  test('update run: a body-N.webp already on main whose alt the live body carries is REUSED (no regeneration); the missing one is generated', async () => {
    // Live file carries the category route slug (what a prior publish wrote).
    const liveMd = fmModule.stringify(
      { ...draft().frontmatter, slug: '/pest-control/drywood-frass-venice/', hero_image: { src: '/images/blog/pest-control/drywood-frass-venice/hero.webp', alt: 'live hero' }, og_image: '/images/blog/pest-control/drywood-frass-venice/hero.webp' },
      'Old body.\n\n## Reading the pellets\n\nDrywood frass is hexagonal in cross-section. See [our guide](/termite-control/) for more.\n\n![Live alt for pellets](/images/blog/pest-control/drywood-frass-venice/body-1.webp)\n',
    );
    const b64 = (dataUrl) => dataUrl.split(',')[1];
    gh.getFile.mockImplementation(async (path) => {
      if (path === 'src/content/blog/pest-control/drywood-frass-venice.mdx') return { content: liveMd, sha: 'live-sha' };
      if (path === 'public/images/blog/pest-control/drywood-frass-venice/hero.webp') return { content: '', sha: 'h', raw: { content: b64(PATTERNS[0]) } };
      if (path === 'public/images/blog/pest-control/drywood-frass-venice/body-1.webp') return { content: '', sha: 'b1', raw: { content: b64(PATTERNS[1]) } };
      return null;
    });
    heroImageGenerator.generate.mockImplementation(async () => ({ dataUrl: PATTERNS[4], model: 'm', alt: 'Generated alt two' }));

    await AstroPublisher.publishOrUpdatePage(draft(), { action_type: 'new_supporting_blog' });

    const bodyCalls = heroImageGenerator.generate.mock.calls.filter(([a]) => a.mode === 'blog-body');
    expect(bodyCalls).toHaveLength(1);
    const files = gh.commitFiles.mock.calls[0][0].files;
    expect(files.map((f) => f.path)).toEqual([
      'public/images/blog/pest-control/drywood-frass-venice/body-2.webp',
      'src/content/blog/pest-control/drywood-frass-venice.mdx',
    ]);
    const parsed = fmModule.parse(files[1].content);
    expect(parsed.content).toContain('![Live alt for pellets](/images/blog/pest-control/drywood-frass-venice/body-1.webp)');
    expect(parsed.content).toContain('![Generated alt two](/images/blog/pest-control/drywood-frass-venice/body-2.webp)');
  });

  test('update run: a REUSED alt goes through the compliance second pass alongside generated alts (GH r2)', async () => {
    const complianceGate = require('../services/content/compliance-gate');
    const spy = jest.spyOn(complianceGate, 'evaluate');
    try {
      const liveMd = fmModule.stringify(
        { ...draft().frontmatter, slug: '/pest-control/drywood-frass-venice/', hero_image: { src: '/images/blog/pest-control/drywood-frass-venice/hero.webp', alt: 'live hero' }, og_image: '/images/blog/pest-control/drywood-frass-venice/hero.webp' },
        'Old body.\n\n## Reading the pellets\n\nDrywood frass is hexagonal in cross-section. See [our guide](/termite-control/) for more.\n\n![Live alt for pellets](/images/blog/pest-control/drywood-frass-venice/body-1.webp)\n',
      );
      const b64 = (dataUrl) => dataUrl.split(',')[1];
      gh.getFile.mockImplementation(async (path) => {
        if (path === 'src/content/blog/pest-control/drywood-frass-venice.mdx') return { content: liveMd, sha: 'live-sha' };
        if (path === 'public/images/blog/pest-control/drywood-frass-venice/hero.webp') return { content: '', sha: 'h', raw: { content: b64(PATTERNS[0]) } };
        if (path === 'public/images/blog/pest-control/drywood-frass-venice/body-1.webp') return { content: '', sha: 'b1', raw: { content: b64(PATTERNS[1]) } };
        return null;
      });
      heroImageGenerator.generate.mockImplementation(async () => ({ dataUrl: PATTERNS[4], model: 'm', alt: 'Generated alt two' }));
      await AstroPublisher.publishOrUpdatePage(draft(), { action_type: 'new_supporting_blog' });
      // The alts are folded into `body` after META_SECTION_MARKER (field-value marker).
      const altPass = spy.mock.calls.find(([arg]) => String(arg?.body || '').includes(complianceGate.META_SECTION_MARKER) && String(arg.body).includes('Live alt for pellets'));
      expect(altPass).toBeTruthy();
      expect(altPass[0].body).toContain('Generated alt two');
    } finally { spy.mockRestore(); }
  });

  test('update run: intro-slot reuse compares against the LIVE title — a retitled article does not inherit its old intro illustration (GH r2)', async () => {
    const { reusableLiveBodyImage } = AstroPublisher._internals;
    const live = { file: { content: fmModule.stringify({ title: 'Old Title' }, 'Intro prose.\n\n![Old intro pic](/images/blog/x/body-1.webp)\n\n## A\n\nProse.\n') } };
    // New slot heading = NEW title (intro pseudo-section) → live side is judged by the OLD title → no match.
    expect(reusableLiveBodyImage(live, '/images/blog/x/body-1.webp', 'New Title', { title: 'New Title', lead: 'Intro prose.' })).toBeNull();
    // Same title + same opening prose → reusable.
    expect(reusableLiveBodyImage(live, '/images/blog/x/body-1.webp', 'Old Title', { title: 'Old Title', lead: 'Intro prose.' })).toBe('Old intro pic');
  });

  test('update run: a REUSED committed body image is hashed too — one that duplicates the reused hero is regenerated instead of reused (hook r8)', async () => {
    const liveMd = fmModule.stringify(
      { ...draft().frontmatter, slug: '/pest-control/drywood-frass-venice/', hero_image: { src: '/images/blog/pest-control/drywood-frass-venice/hero.webp', alt: 'live hero' }, og_image: '/images/blog/pest-control/drywood-frass-venice/hero.webp' },
      'Old body.\n\n## Reading the pellets\n\nDrywood frass is hexagonal in cross-section. See [our guide](/termite-control/) for more.\n\n![Live alt for pellets](/images/blog/pest-control/drywood-frass-venice/body-1.webp)\n',
    );
    const b64 = (dataUrl) => dataUrl.split(',')[1];
    gh.getFile.mockImplementation(async (path) => {
      if (path === 'src/content/blog/pest-control/drywood-frass-venice.mdx') return { content: liveMd, sha: 'live-sha' };
      // Committed hero and body-1 are the SAME picture.
      if (path === 'public/images/blog/pest-control/drywood-frass-venice/hero.webp') return { content: '', sha: 'h', raw: { content: b64(PATTERNS[0]) } };
      if (path === 'public/images/blog/pest-control/drywood-frass-venice/body-1.webp') return { content: '', sha: 'b1', raw: { content: b64(PATTERNS[0]) } };
      return null;
    });
    let call = 0;
    heroImageGenerator.generate.mockImplementation(async () => ({ dataUrl: [PATTERNS[2], PATTERNS[3]][call++], model: 'm', alt: 'Regenerated' }));

    await AstroPublisher.publishOrUpdatePage(draft(), { action_type: 'new_supporting_blog' });

    expect(heroImageGenerator.generate.mock.calls.filter(([a]) => a.mode === 'blog-body')).toHaveLength(2);
    const files = gh.commitFiles.mock.calls[0][0].files.map((f) => f.path);
    // The duplicate committed body-1 is never overwritten — the replacement lands on the next free names (hook P0).
    expect(files).not.toContain('public/images/blog/pest-control/drywood-frass-venice/body-1.webp');
    expect(files).toEqual(expect.arrayContaining(['public/images/blog/pest-control/drywood-frass-venice/body-2.webp', 'public/images/blog/pest-control/drywood-frass-venice/body-3.webp']));
    expect(fmModule.parse(gh.commitFiles.mock.calls[0][0].files.at(-1).content).content).not.toContain('Live alt for pellets');
  });

  test('update run: a committed body image that now sits under a DIFFERENT heading is regenerated, not reused (hook r2)', async () => {
    const liveMd = fmModule.stringify(
      { ...draft().frontmatter, slug: '/pest-control/drywood-frass-venice/', hero_image: { src: '/images/blog/pest-control/drywood-frass-venice/hero.webp', alt: 'live hero' }, og_image: '/images/blog/pest-control/drywood-frass-venice/hero.webp' },
      'Old body.\n\n## Some other topic\n\nOld prose.\n\n![Live alt](/images/blog/pest-control/drywood-frass-venice/body-1.webp)\n',
    );
    const committed = committedStub(['public/images/blog/pest-control/drywood-frass-venice/hero.webp', 'public/images/blog/pest-control/drywood-frass-venice/body-1.webp']);
    gh.getFile.mockImplementation(async (path) => (path === 'src/content/blog/pest-control/drywood-frass-venice.mdx' ? { content: liveMd, sha: 'live-sha' } : committed(path)));

    await AstroPublisher.publishOrUpdatePage(draft(), { action_type: 'new_supporting_blog' });

    expect(heroImageGenerator.generate.mock.calls.filter(([a]) => a.mode === 'blog-body')).toHaveLength(2);
    // body-1 stays committed under its old heading; the new pictures take the next free names (hook P0: never overwrite).
    expect(gh.commitFiles.mock.calls[0][0].files.map((f) => f.path)).toEqual([
      'public/images/blog/pest-control/drywood-frass-venice/body-2.webp',
      'public/images/blog/pest-control/drywood-frass-venice/body-3.webp',
      'src/content/blog/pest-control/drywood-frass-venice.mdx',
    ]);
    expect(fmModule.parse(gh.commitFiles.mock.calls[0][0].files[2].content).content).not.toContain('Live alt');
  });

  test('draft-authored image refs count only when COMMITTED in the repo; fenced `![..]` is not an image', async () => {
    gh.getFile.mockImplementation(committedStub(['public/images/2026/08/a.webp', 'public/images/2026/08/b.webp']));
    const body = `${article}\n\n![a](/images/2026/08/a.webp)\n\n![b](/images/2026/08/b.webp)\n\n\`\`\`md\n![not an image](/images/2026/08/c.webp)\n\`\`\`\n`;
    expect(AstroPublisher._internals.bodyImageRefs(body).map((r) => r.src)).toEqual(['/images/2026/08/a.webp', '/images/2026/08/b.webp']);
    await AstroPublisher.publishOrUpdatePage(draft(body), { action_type: 'new_supporting_blog' });
    expect(heroImageGenerator.generate.mock.calls.filter(([a]) => a.mode === 'blog-body')).toHaveLength(0);
  });

  test('distinct sources count, not references; new body-N names skip ones the draft already references (hook r3)', async () => {
    gh.getFile.mockImplementation(committedStub(['public/images/blog/pest-control/drywood-frass-venice/body-2.webp']));
    // Two references to ONE committed file → one image → one more needed, and it must not be body-2.
    const body = `${article}\n\n![same](/images/blog/pest-control/drywood-frass-venice/body-2.webp)\n\n![same again](/images/blog/pest-control/drywood-frass-venice/body-2.webp)\n`;
    await AstroPublisher.publishOrUpdatePage(draft(body), { action_type: 'new_supporting_blog' });
    expect(heroImageGenerator.generate.mock.calls.filter(([a]) => a.mode === 'blog-body')).toHaveLength(1);
    const files = gh.commitFiles.mock.calls[0][0].files.map((f) => f.path);
    expect(files).toContain('public/images/blog/pest-control/drywood-frass-venice/body-1.webp');
    expect(files).not.toContain('public/images/blog/pest-control/drywood-frass-venice/body-2.webp');
  });

  test('bodyImageRefs: image syntax inside JSX/HTML attributes or MDX expressions is data, not an image (hook r7)', () => {
    const body = [
      '<Card note="![x](/images/2026/08/a.webp)" />',
      '<ComparisonTable',
      '  rows={[["![y](/images/2026/08/b.webp)", "z"]]}',
      '/>',
      '{"![z](/images/2026/08/c.webp)"}',
      '<span title="![w](/images/2026/08/d.webp)">t</span>',
      '<Card note="x > ![hidden](/images/2026/08/f.webp)" />',
      '{"a}" + "![g](/images/2026/08/g.webp)"}',
      '',
      '![real](/images/2026/08/e.webp)',
    ].join('\n');
    expect(AstroPublisher._internals.bodyImageRefs(body).map((r) => r.src)).toEqual(['/images/2026/08/e.webp']);
    expect(AstroPublisher._internals.bodyImageRefs(body)[0].line).toBe(9);
  });

  test('bodyImageRefs: reference definitions, "[ref]" tails and link titles are never rendered — image syntax inside them does not count (GH r5)', () => {
    const body = [
      '[ref]: /contact/ "![hidden](/images/blog/x/body-1.webp)"',
      '[Get a quote](/contact/ "![t](/images/blog/x/body-2.webp)")',
      '[label][![r](/images/blog/x/body-3.webp)]',
      '',
      '![real](/images/blog/x/body-4.webp)',
    ].join('\n');
    // `[label][![r](…)]` is NOT a full reference (a label may not contain an unescaped `[`, CommonMark 6.3): it renders as
    // literal `[label]` + bracketed text whose image DOES render — so body-3 counts (escape-aware tail, GH r15).
    expect(AstroPublisher._internals.bodyImageRefs(body).map((r) => r.src)).toEqual(['/images/blog/x/body-3.webp', '/images/blog/x/body-4.webp']);
  });

  test('imageDHash: an RGBA picture hashes like its opaque twin (alpha flattened, channel-aware indexing); undecodable bytes are a deterministic BLOG_BODY_IMAGES_FAILED (GH r5)', async () => {
    const { imageDHash, hammingDistance } = AstroPublisher._internals;
    const sharp = require('sharp');
    const w = 40; const h = 30;
    const rgb = Buffer.alloc(w * h * 3); const rgba = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const v = ((x * 255) / w) | 0; const u = ((y * 255) / h) | 0; const i = y * w + x;
      rgb[i * 3] = v; rgb[i * 3 + 1] = u; rgb[i * 3 + 2] = 128;
      rgba[i * 4] = v; rgba[i * 4 + 1] = u; rgba[i * 4 + 2] = 128; rgba[i * 4 + 3] = 255;
    }
    const opaque = await sharp(rgb, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
    const alpha = await sharp(rgba, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
    expect(hammingDistance(await imageDHash(opaque), await imageDHash(alpha))).toBe(0);
    let thrown;
    try { await imageDHash(Buffer.from('definitely not an image')); } catch (err) { thrown = err; }
    expect(thrown?.code).toBe('BLOG_BODY_IMAGES_FAILED');
  });

  test('fail-closed: a committed draft image Sharp cannot decode parks deterministically instead of retry-looping (GH r5)', async () => {
    gh.getFile.mockImplementation(async (path) => (path === 'public/images/2026/08/bad.webp' ? { content: '', sha: 'b', raw: { content: Buffer.from('corrupt bytes').toString('base64') } } : null));
    let thrown;
    try { await AstroPublisher.publishOrUpdatePage(draft(`${article}\n\n![bad](/images/2026/08/bad.webp)\n`), { action_type: 'new_supporting_blog' }); } catch (err) { thrown = err; }
    expect(thrown?.code).toBe('BLOG_BODY_IMAGES_FAILED');
    expect(thrown.message).toMatch(/could not be decoded/);
    expect(gh.createBranch).not.toHaveBeenCalled();
  });

  test('fail-closed: a raw <img> in the body parks — it cannot be counted or verified by the Markdown scan (hook r13)', async () => {
    gh.getFile.mockResolvedValue(null);
    let thrown;
    try { await AstroPublisher.publishOrUpdatePage(draft(`${article}\n\n<img src="/images/2026/08/raw.webp" alt="x">\n`), { action_type: 'new_supporting_blog' }); } catch (err) { thrown = err; }
    expect(thrown?.code).toBe('BLOG_BODY_IMAGES_FAILED');
    expect(thrown.message).toMatch(/raw <img> tag/);
    // Inside a code fence it is text, not a tag.
    const ok = await AstroPublisher._internals.validateBodyImageRefs({ body: '```html\n<img src="/x.webp">\n```\n', getFile: async () => null });
    expect(ok.ok).toBe(true);
  });

  test('bodyImageRefs: image syntax nested in a LINK destination is not an image; an image in a link LABEL renders and is (GH r6)', () => {
    const body = '[contact](/go/![hidden](/images/blog/x/body-1.webp)) and [![linked](/images/blog/x/body-2.webp)](/contact/)';
    expect(AstroPublisher._internals.bodyImageRefs(body).map((r) => r.src)).toEqual(['/images/blog/x/body-2.webp']);
  });

  test('bodyImageSlots: headings and prose inside blockquotes or list items are not top-level — never sections or slots (GH r6)', () => {
    const body = [
      '## Real section', '', 'Real prose.', '',
      '> ## Quoted heading', '>', '> Quoted testimonial prose.', '',
      '- item', '  ## Nested heading', '', '  Nested prose under the item.', '',
      '## Second real', '', 'Second prose.',
    ].join('\n');
    const { sections } = AstroPublisher._internals.scanBodySections(body, { title: 'T' });
    expect(sections.filter((sec) => !sec.intro).map((sec) => sec.heading)).toEqual(['Real section', 'Second real']);
    const slots = bodyImageSlots(body, 2, { title: 'T' });
    const lines = body.split('\n');
    expect(slots.map((sl) => lines[sl.insertAt - 1])).toEqual(['Real prose.', 'Second prose.']);
  });

  test('bodyImageRefs: images inside hidden containers (<script>, <template>, <div hidden>, closed <details>) are not rendered (GH r7)', () => {
    const body = [
      '<script>const x = "![s](/images/blog/x/body-1.webp)";</script>',
      '<template>![t](/images/blog/x/body-2.webp)</template>',
      '<div hidden>', '', '![h](/images/blog/x/body-3.webp)', '', '</div>',
      '<details>', '', '![d](/images/blog/x/body-4.webp)', '', '</details>',
      '',
      '![real](/images/blog/x/body-5.webp)',
    ].join('\n');
    expect(AstroPublisher._internals.bodyImageRefs(body).map((r) => r.src)).toEqual(['/images/blog/x/body-5.webp']);
  });

  test('imageDHash: an orientation-tagged JPEG hashes like its auto-oriented twin (GH r7)', async () => {
    const { imageDHash, hammingDistance, NEAR_DUPLICATE_MAX_DISTANCE } = AstroPublisher._internals;
    const sharp = require('sharp');
    const w = 96; const h = 64; const raw = Buffer.alloc(w * h * 3);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 3; raw[i] = (x * 255) / w; raw[i + 1] = (y * 255) / h; raw[i + 2] = 90; }
    const upright = await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
    // Store the raster rotated 90° CCW with EXIF orientation 6 → displays upright.
    const tagged = await sharp(upright).rotate(270).withMetadata({ orientation: 6 }).jpeg({ quality: 95 }).toBuffer();
    expect(hammingDistance(await imageDHash(upright), await imageDHash(tagged))).toBeLessThanOrEqual(NEAR_DUPLICATE_MAX_DISTANCE);
  });

  test('update run: reuse requires the same section CONTEXT — a kept heading over rewritten prose regenerates (GH r7)', () => {
    const { reusableLiveBodyImage } = AstroPublisher._internals;
    const live = { file: { content: fmModule.stringify({ title: 'T' }, '## What to expect\n\nThe technician sweeps eaves first.\n\n![old](/images/blog/x/body-1.webp)\n') } };
    expect(reusableLiveBodyImage(live, '/images/blog/x/body-1.webp', 'What to expect', { title: 'T', lead: 'The technician sweeps eaves first.' })).toBe('old');
    expect(reusableLiveBodyImage(live, '/images/blog/x/body-1.webp', 'What to expect', { title: 'T', lead: 'Bait stations go in along the foundation.' })).toBeNull();
  });

  test('assertBodyImagesAtHead: validates the post file on the PR branch — hero-only withholds, compliant passes, gate off is a no-op (GH r7)', async () => {
    const { assertBodyImagesAtHead, compressToWebp } = AstroPublisher._internals;
    const fmData = { ...draft().frontmatter, slug: '/pest-control/drywood-frass-venice/', hero_image: { src: '/images/blog/pest-control/drywood-frass-venice/hero.webp', alt: 'h' } };
    const heroOnly = fmModule.stringify(fmData, 'Body with no pictures.\n');
    const withImages = fmModule.stringify(fmData, 'Body.\n\n![a](/images/blog/pest-control/drywood-frass-venice/body-1.webp)\n\n## B\n\n![b](/images/blog/pest-control/drywood-frass-venice/body-2.webp)\n');
    const webp = async (i) => (await compressToWebp(Buffer.from(PATTERNS[i].split(',')[1], 'base64'), { width: 1200 })).toString('base64');
    const bytes = { hero: await webp(0), 'body-1': await webp(1), 'body-2': await webp(2) };
    const files = { content: heroOnly };
    gh.getFile.mockImplementation(async (path, ref) => {
      if (ref !== 'content/autonomous-x') return null;
      if (path === 'src/content/blog/pest-control/drywood-frass-venice.mdx') return { content: files.content, sha: 'f' };
      const m = path.match(/drywood-frass-venice\/(hero|body-1|body-2)\.webp$/);
      return m ? { content: '', sha: m[1], raw: { content: bytes[m[1]] } } : null;
    });
    const res = await assertBodyImagesAtHead({ frontmatter: fmData, branch: 'content/autonomous-x' });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/0 distinct in-article image\(s\) on content\/autonomous-x, minimum 2/);
    files.content = withImages;
    expect((await assertBodyImagesAtHead({ frontmatter: fmData, branch: 'content/autonomous-x' })).ok).toBe(true);
    // Unknown branch / missing file fail closed.
    expect((await assertBodyImagesAtHead({ frontmatter: fmData, branch: null })).ok).toBe(false);
    expect((await assertBodyImagesAtHead({ frontmatter: fmData, branch: 'content/other' })).reason).toMatch(/not found on content\/other/);
    // Gate off → no-op.
    featureGates.isEnabled.mockImplementation(() => false);
    expect(await assertBodyImagesAtHead({ frontmatter: fmData, branch: null })).toEqual({ ok: true, reason: 'gate_off' });
  });

  test('refresh lane: a blog refresh under the gate gains its body images in ONE commit; a live legacy post that repeats its hero in the body is grandfathered (hook r14)', async () => {
    const heroSrc = '/images/2025/12/shrub-diseases.webp';
    const liveFm = validFrontmatter({ slug: '/shrub-diseases-sarasota-fl/', title: 'Shrub Diseases', canonical: 'https://www.wavespestcontrol.com/blog/shrub-diseases-sarasota-fl/', hero_image: { src: heroSrc, alt: 'hero' }, og_image: heroSrc });
    // Legacy convention: hero repeated as the first body image.
    const liveBody = `![shrub diseases](${heroSrc})\n\n## Hibiscus\n\nHibiscus prose.\n\n## Oleander\n\nOleander prose.\n`;
    const liveMd = fmModule.stringify(liveFm, liveBody);
    // Hero bytes distinct from the rotating generator's first pictures (else the near-duplicate guard regenerates — correct, but not what this test measures).
    const heroWebp = await AstroPublisher._internals.compressToWebp(Buffer.from(PATTERNS[4].split(',')[1], 'base64'), { width: 1200 });
    gh.getFile.mockImplementation(async (path) => {
      if (path === 'src/content/blog/shrub-diseases-sarasota-fl.mdx') return null;
      if (path === 'src/content/blog/shrub-diseases-sarasota-fl.md') return { content: liveMd, sha: 'live' };
      if (path === `public${heroSrc}`) return { content: '', sha: 'h', raw: { content: heroWebp.toString('base64') } };
      return null;
    });
    gh.commitFiles.mockResolvedValue({ commit: { sha: 'multi' } });
    const draft = { type: 'draft', page_url: 'https://www.wavespestcontrol.com/blog/shrub-diseases-sarasota-fl/', frontmatter: {}, body: liveBody.replace('Oleander prose.', 'Oleander prose, refreshed with new guidance.') };
    const res = await AstroPublisher.publishRefresh(draft, { action_type: 'refresh_existing_page', target_url: draft.page_url });
    expect(res.status).toBe('pr_open');
    // Hero-in-body grandfathered (no park), two images generated and committed with the post.
    expect(heroImageGenerator.generate.mock.calls.filter(([a]) => a.mode === 'blog-body')).toHaveLength(2);
    expect(gh.putFile).not.toHaveBeenCalled();
    const files = gh.commitFiles.mock.calls[0][0].files.map((f) => f.path);
    expect(files).toEqual([
      'public/images/blog/shrub-diseases-sarasota-fl/body-1.webp',
      'public/images/blog/shrub-diseases-sarasota-fl/body-2.webp',
      'src/content/blog/shrub-diseases-sarasota-fl.md',
    ]);
    const written = fmModule.parse(gh.commitFiles.mock.calls[0][0].files[2].content).content;
    expect(written).toContain(`![shrub diseases](${heroSrc})`);
    expect(AstroPublisher._internals.countBodyImages(written)).toBe(3);
    // Only that exact legacy reference is grandfathered: a refresh that swaps it for another post's
    // hero (or a nonexistent /hero.webp) parks instead of shipping under the grandfather (GH r8).
    gh.commitFiles.mockClear();
    for (const swapped of ['/images/blog/other-post/hero.webp', '/images/blog/shrub-diseases-sarasota-fl/hero.webp']) {
      let thrown;
      try {
        await AstroPublisher.publishRefresh({ ...draft, body: draft.body.replace(`![shrub diseases](${heroSrc})`, `![shrub diseases](${swapped})`) }, { action_type: 'refresh_existing_page', target_url: draft.page_url });
      } catch (err) { thrown = err; }
      expect(thrown?.code).toBe('BLOG_BODY_IMAGES_FAILED');
      expect(thrown.message).toContain('embeds the hero image');
      expect(thrown.message).toContain(swapped);
    }
    expect(gh.commitFiles).not.toHaveBeenCalled();
  });

  test('assertBodyImagesAtHead: refresh targets resolve like publishRefresh; non-blog targets are exempt; a route-matched flat legacy file is what gets checked (hook r14)', async () => {
    const { assertBodyImagesAtHead, compressToWebp } = AstroPublisher._internals;
    const heroSrc = '/images/2025/12/shrub-diseases.webp';
    const liveFm = validFrontmatter({ slug: '/shrub-diseases-sarasota-fl/', title: 'Shrub Diseases', canonical: 'https://www.wavespestcontrol.com/blog/shrub-diseases-sarasota-fl/', hero_image: { src: heroSrc, alt: 'hero' }, og_image: heroSrc });
    const mainMd = fmModule.stringify(liveFm, `![h](${heroSrc})\n\n## A\n\nProse.\n`);
    const headMd = fmModule.stringify(liveFm, `![h](${heroSrc})\n\n## A\n\nProse.\n\n![a](/images/blog/shrub-diseases-sarasota-fl/body-1.webp)\n\n## B\n\n![b](/images/blog/shrub-diseases-sarasota-fl/body-2.webp)\n`);
    const webp = async (i) => (await compressToWebp(Buffer.from(PATTERNS[i].split(',')[1], 'base64'), { width: 1200 })).toString('base64');
    const bytes = { hero: await webp(0), 'body-1': await webp(1), 'body-2': await webp(2) };
    gh.getFile.mockImplementation(async (path, ref) => {
      if (path === 'src/content/blog/shrub-diseases-sarasota-fl.md') return { content: ref === 'content/refresh-x' ? headMd : mainMd, sha: 'f' };
      if (path === `public${heroSrc}`) return { content: '', sha: 'h', raw: { content: bytes.hero } };
      const m = path.match(/shrub-diseases-sarasota-fl\/(body-1|body-2)\.webp$/);
      return m ? { content: '', sha: m[1], raw: { content: bytes[m[1]] } } : null;
    });
    const refresh = { actionType: 'refresh_existing_page', targetUrl: 'https://www.wavespestcontrol.com/blog/shrub-diseases-sarasota-fl/', branch: 'content/refresh-x' };
    expect(await assertBodyImagesAtHead({ frontmatter: {}, ...refresh })).toMatchObject({ ok: true, reason: null });
    // The grandfather covers ONLY the exact hero ref the live body carries: a head that swaps it for
    // another post's hero (or an invented /hero.webp) is validated normally and withholds (GH r8).
    for (const swapped of ['/images/blog/other-post/hero.webp', '/images/blog/shrub-diseases-sarasota-fl/hero.webp']) {
      const swappedMd = headMd.replace(`![h](${heroSrc})`, `![h](${swapped})`);
      gh.getFile.mockImplementation(async (path, ref) => {
        if (path === 'src/content/blog/shrub-diseases-sarasota-fl.md') return { content: ref === 'content/refresh-x' ? swappedMd : mainMd, sha: 'f' };
        if (path === `public${heroSrc}`) return { content: '', sha: 'h', raw: { content: bytes.hero } };
        const m = path.match(/shrub-diseases-sarasota-fl\/(body-1|body-2)\.webp$/);
        return m ? { content: '', sha: m[1], raw: { content: bytes[m[1]] } } : null;
      });
      const res = await assertBodyImagesAtHead({ frontmatter: {}, ...refresh });
      expect(res.ok).toBe(false);
      expect(res.reason).toMatch(/embeds the hero image/);
      expect(res.reason).toContain(swapped);
    }
    expect(AstroPublisher._internals.legacyHeroRefs(`![h](${heroSrc})\n\n![x](/images/blog/a/hero.webp)\n\n![y](/images/blog/a/body-1.webp)\n\n![h2](${heroSrc})`, heroSrc)).toEqual([heroSrc, '/images/blog/a/hero.webp', heroSrc]); // occurrences, not unique (GH r13)
    gh.getFile.mockImplementation(async (path, ref) => {
      if (path === 'src/content/blog/shrub-diseases-sarasota-fl.md') return { content: ref === 'content/refresh-x' ? headMd : mainMd, sha: 'f' };
      if (path === `public${heroSrc}`) return { content: '', sha: 'h', raw: { content: bytes.hero } };
      const m = path.match(/shrub-diseases-sarasota-fl\/(body-1|body-2)\.webp$/);
      return m ? { content: '', sha: m[1], raw: { content: bytes[m[1]] } } : null;
    });
    // A non-blog target is exempt only once RESOLVED on the branch; unresolved fails closed (hook r15).
    gh.getFile.mockImplementationOnce(async (path, ref) => (ref === 'content/refresh-x' && path === 'src/content/services/pest-control-venice-fl.md' ? { content: '---\ntitle: S\n---\nService.', sha: 's' } : null));
    expect(await assertBodyImagesAtHead({ frontmatter: {}, actionType: 'refresh_existing_page', targetUrl: 'https://www.wavespestcontrol.com/pest-control-venice-fl/', branch: 'content/refresh-x' })).toEqual({ ok: true, reason: 'non_blog_target' });
    expect((await assertBodyImagesAtHead({ frontmatter: {}, actionType: 'refresh_existing_page', targetUrl: 'https://www.wavespestcontrol.com/pest-control-venice-fl/', branch: 'content/refresh-x' })).reason).toMatch(/not found on content\/refresh-x/);
    // New-post lane: a FLAT legacy .md that renders the same route is the file publication updated → it is what gets checked.
    const flatFm = validFrontmatter({ slug: '/pest-control/drywood-frass-venice/', title: 'Drywood', canonical: 'https://www.wavespestcontrol.com/pest-control/drywood-frass-venice/', hero_image: { src: '/images/blog/drywood-frass-venice/hero.webp', alt: 'h' }, og_image: '/images/blog/drywood-frass-venice/hero.webp' });
    const flatMd = fmModule.stringify(flatFm, 'Body without pictures.\n');
    gh.getFile.mockImplementation(async (path, ref) => (ref === 'content/autonomous-y' && path === 'src/content/blog/drywood-frass-venice.md' ? { content: flatMd, sha: 'flat' } : null));
    const res = await assertBodyImagesAtHead({ frontmatter: draft().frontmatter, branch: 'content/autonomous-y' });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/0 distinct in-article image\(s\)/);
  });

  test('bodyImageRefs: reference-style images (full, collapsed, shortcut) resolve through the body\'s definitions; undefined labels and definitions inside code are not images; reference LINKS still blank (GH r9)', () => {
    const body = [
      '![technician][body]',
      '![Collapsed Alt][]',
      '![shortcut]',
      '![nope][undefined]',
      '![in-fence][fenced]',
      '![multiline][multi]',
      '[a reference link][body] and [text](/x/) stay prose',
      '',
      '[body]: /images/blog/x/body-1.webp "Title"',
      '[ collapsed   alt ]: </images/blog/x/body-2.webp>',
      '[SHORTCUT]: /images/blog/x/body-3.webp',
      '[body]: /images/blog/x/ignored-second-definition.webp',
      '[multi]:',
      '  /images/blog/x/body-5.webp',
      '```',
      '[fenced]: /images/blog/x/body-4.webp',
      '```',
    ].join('\n');
    expect(AstroPublisher._internals.bodyImageRefs(body).map((r) => [r.alt, r.src])).toEqual([
      ['technician', '/images/blog/x/body-1.webp'],
      ['Collapsed Alt', '/images/blog/x/body-2.webp'],
      ['shortcut', '/images/blog/x/body-3.webp'],
      ['multiline', '/images/blog/x/body-5.webp'],
    ]);
    // The section scanner sees the same pictures: a reference-style image marks its section illustrated.
    const { sections } = AstroPublisher._internals.scanBodySections(`## A\n\nProse.\n\n![pic][body]\n\n## B\n\nMore.\n\n[body]: /images/blog/x/body-1.webp\n`, { title: 'T' });
    expect(sections.filter((sec) => !sec.intro).map((sec) => [sec.heading, sec.hasImage === true])).toEqual([['A', true], ['B', false]]);
  });

  test('refresh lane: the multi-file commit keeps the optimistic lock — a target whose SHA moved on the fresh branch throws a transient error and nothing is committed (hook P0)', async () => {
    const heroSrc = '/images/2025/12/shrub-diseases.webp';
    const liveFm = validFrontmatter({ slug: '/shrub-diseases-sarasota-fl/', title: 'Shrub Diseases', canonical: 'https://www.wavespestcontrol.com/blog/shrub-diseases-sarasota-fl/', hero_image: { src: heroSrc, alt: 'hero' }, og_image: heroSrc });
    const liveBody = '## Hibiscus\n\nHibiscus prose.\n\n## Oleander\n\nOleander prose.\n';
    const liveMd = fmModule.stringify(liveFm, liveBody);
    const heroWebp = await AstroPublisher._internals.compressToWebp(Buffer.from(PATTERNS[4].split(',')[1], 'base64'), { width: 1200 });
    gh.getFile.mockImplementation(async (path, ref) => {
      if (path === 'src/content/blog/shrub-diseases-sarasota-fl.mdx') return null;
      // main read → sha 'live'; the fresh branch already carries a newer edit → sha 'moved'.
      if (path === 'src/content/blog/shrub-diseases-sarasota-fl.md') return { content: liveMd, sha: ref ? 'moved' : 'live' };
      if (path === `public${heroSrc}`) return { content: '', sha: 'h', raw: { content: heroWebp.toString('base64') } };
      return null;
    });
    const draft = { type: 'draft', page_url: 'https://www.wavespestcontrol.com/blog/shrub-diseases-sarasota-fl/', frontmatter: {}, body: liveBody.replace('Oleander prose.', 'Oleander prose, refreshed.') };
    let thrown;
    try { await AstroPublisher.publishRefresh(draft, { action_type: 'refresh_existing_page', target_url: draft.page_url }); } catch (err) { thrown = err; }
    expect(thrown?.message).toMatch(/changed since it was read/);
    expect(thrown?.code).toBeUndefined();
    expect(gh.commitFiles).not.toHaveBeenCalled();
    // The just-cut branch is deleted (GH r11) — no orphan per retry.
    expect(gh.deleteRef).toHaveBeenCalledWith(expect.stringMatching(/^content\/refresh-/));
    expect(gh.putFile).not.toHaveBeenCalled();
    expect(gh.getFile).toHaveBeenCalledWith('src/content/blog/shrub-diseases-sarasota-fl.md', expect.stringMatching(/^content\/refresh-/));
  });

  test('refresh lane: the lock also covers generated asset paths — a body-N.webp that appeared on the fresh branch throws transient + deletes the branch (hook P0)', async () => {
    const heroSrc = '/images/2025/12/shrub-diseases.webp';
    const liveFm = validFrontmatter({ slug: '/shrub-diseases-sarasota-fl/', title: 'Shrub Diseases', canonical: 'https://www.wavespestcontrol.com/blog/shrub-diseases-sarasota-fl/', hero_image: { src: heroSrc, alt: 'hero' }, og_image: heroSrc });
    const liveBody = '## Hibiscus\n\nHibiscus prose.\n\n## Oleander\n\nOleander prose.\n';
    const liveMd = fmModule.stringify(liveFm, liveBody);
    const heroWebp = await AstroPublisher._internals.compressToWebp(Buffer.from(PATTERNS[4].split(',')[1], 'base64'), { width: 1200 });
    gh.getFile.mockImplementation(async (path, ref) => {
      if (path === 'src/content/blog/shrub-diseases-sarasota-fl.mdx') return null;
      if (path === 'src/content/blog/shrub-diseases-sarasota-fl.md') return { content: liveMd, sha: 'live' };
      if (path === `public${heroSrc}`) return { content: '', sha: 'h', raw: { content: heroWebp.toString('base64') } };
      // body-1 is free on main at allocation time but has appeared on the fresh branch by commit time.
      if (ref && path === 'public/images/blog/shrub-diseases-sarasota-fl/body-1.webp') return { content: '', sha: 'raced' };
      return null;
    });
    const draft = { type: 'draft', page_url: 'https://www.wavespestcontrol.com/blog/shrub-diseases-sarasota-fl/', frontmatter: {}, body: liveBody.replace('Oleander prose.', 'Oleander prose, refreshed.') };
    let thrown;
    try { await AstroPublisher.publishRefresh(draft, { action_type: 'refresh_existing_page', target_url: draft.page_url }); } catch (err) { thrown = err; }
    expect(thrown?.message).toMatch(/body-1\.webp \(appeared since it was allocated\)/);
    expect(thrown?.code).toBeUndefined();
    expect(gh.commitFiles).not.toHaveBeenCalled();
    expect(gh.deleteRef).toHaveBeenCalledWith(expect.stringMatching(/^content\/refresh-/));
  });

  test('resolveBodyImages: a committed body-N the run cannot reuse is never overwritten — the next free name is allocated (hook P0)', async () => {
    const heroSrc = '/images/2025/12/shrub-diseases.webp';
    const liveFm = validFrontmatter({ slug: '/shrub-diseases-sarasota-fl/', title: 'Shrub Diseases', canonical: 'https://www.wavespestcontrol.com/blog/shrub-diseases-sarasota-fl/', hero_image: { src: heroSrc, alt: 'hero' }, og_image: heroSrc });
    const liveBody = '## Hibiscus\n\nHibiscus prose.\n\n## Oleander\n\nOleander prose.\n';
    const liveMd = fmModule.stringify(liveFm, liveBody);
    const heroWebp = await AstroPublisher._internals.compressToWebp(Buffer.from(PATTERNS[4].split(',')[1], 'base64'), { width: 1200 });
    gh.getFile.mockImplementation(async (path) => {
      if (path === 'src/content/blog/shrub-diseases-sarasota-fl.mdx') return null;
      if (path === 'src/content/blog/shrub-diseases-sarasota-fl.md') return { content: liveMd, sha: 'live' };
      if (path === `public${heroSrc}`) return { content: '', sha: 'h', raw: { content: heroWebp.toString('base64') } };
      // An orphan body-1.webp sits on main; the live body does not reference it → not reusable, never overwritten.
      if (path === 'public/images/blog/shrub-diseases-sarasota-fl/body-1.webp') return { content: '', sha: 'orphan', raw: { content: heroWebp.toString('base64') } };
      return null;
    });
    gh.commitFiles.mockResolvedValue({ commit: { sha: 'multi' } });
    const draft = { type: 'draft', page_url: 'https://www.wavespestcontrol.com/blog/shrub-diseases-sarasota-fl/', frontmatter: {}, body: liveBody.replace('Oleander prose.', 'Oleander prose, refreshed.') };
    const res = await AstroPublisher.publishRefresh(draft, { action_type: 'refresh_existing_page', target_url: draft.page_url });
    expect(res.status).toBe('pr_open');
    expect(gh.commitFiles.mock.calls[0][0].files.map((f) => f.path)).toEqual([
      'public/images/blog/shrub-diseases-sarasota-fl/body-2.webp',
      'public/images/blog/shrub-diseases-sarasota-fl/body-3.webp',
      'src/content/blog/shrub-diseases-sarasota-fl.md',
    ]);
  });

  test('committedImageBuffer: a 404 (null) is a missing asset; an operational read error propagates so the runner retries instead of parking (hook P1)', async () => {
    const { committedImageBuffer, assertDistinctPictures } = AstroPublisher._internals;
    expect(await committedImageBuffer('public/images/blog/x/gone.webp', async () => null)).toBeNull();
    await expect(committedImageBuffer('public/images/blog/x/a.webp', async () => { throw new Error('GitHub 503'); })).rejects.toThrow('GitHub 503');
    await expect(assertDistinctPictures({ srcs: ['/images/blog/x/a.webp'], heroSrc: '/images/blog/x/hero.webp', getFile: async () => { throw new Error('GitHub 503'); } })).rejects.toThrow('GitHub 503');
    // Through the publisher: a draft-authored image whose bytes fail to READ (not a 404) is not BLOG_BODY_IMAGES_FAILED.
    gh.getFile.mockImplementation(async (path) => {
      if (path.startsWith('public/images/blog/pest-control/drywood-frass-venice/body-')) throw new Error('GitHub 502');
      return null;
    });
    let thrown;
    try { await AstroPublisher.publishOrUpdatePage(draft(`${article}\n\n![a](/images/blog/pest-control/drywood-frass-venice/body-1.webp)\n\n![b](/images/blog/pest-control/drywood-frass-venice/body-2.webp)\n`), { action_type: 'new_supporting_blog' }); } catch (err) { thrown = err; }
    expect(thrown?.message).toContain('GitHub 502');
    expect(thrown?.code).toBeUndefined();
    expect(gh.createBranch).not.toHaveBeenCalled();
  });

  test('bodyImageRefs: image labels with nested or escaped brackets are parsed whole (balanced scanner), so the picture is validated (GH r11)', async () => {
    const refs = AstroPublisher._internals.bodyImageRefs('![Technician [close-up]](/images/blog/x/hero.webp)\n![a \\] b](/images/blog/x/body-1.webp "t")\n![nested [ref]][r]\n\n[r]: /images/blog/x/body-2.webp');
    expect(refs.map((r) => [r.alt, r.src])).toEqual([['Technician [close-up]', '/images/blog/x/hero.webp'], ['a \\] b', '/images/blog/x/body-1.webp'], ['nested [ref]', '/images/blog/x/body-2.webp']]);
    const res = await AstroPublisher._internals.validateBodyImageRefs({ body: '![Technician [close-up]](/images/blog/x/hero.webp)', heroSrc: '/images/blog/x/hero.webp', getFile: async () => ({ content: 'x' }) });
    expect(res.reason).toMatch(/embeds the hero image/);
  });

  test('committedImageBuffer: a contents-API response without inline bytes (file over 1 MB) falls back to the blob by SHA (GH r11)', async () => {
    const { committedImageBuffer } = AstroPublisher._internals;
    const bytes = Buffer.from('big-picture');
    gh.getBlob.mockResolvedValueOnce({ content: bytes.toString('base64'), encoding: 'base64' });
    const buf = await committedImageBuffer('public/images/2024/big-hero.jpg', async () => ({ content: '', sha: 'blobsha', raw: { sha: 'blobsha', content: '', encoding: 'none', size: 2_000_000 } }));
    expect(buf.equals(bytes)).toBe(true);
    expect(gh.getBlob).toHaveBeenCalledWith('blobsha');
    // Still null when the blob has nothing either.
    gh.getBlob.mockResolvedValueOnce({ content: '', encoding: 'base64' });
    expect(await committedImageBuffer('public/images/2024/empty.jpg', async () => ({ content: '', sha: 'e', raw: { sha: 'e', content: '' } }))).toBeNull();
  });

  test('bodyImageRefs: an inline destination with trailing junk is literal text, not an image; a wrapped (multi-line) label is still one image on its first line (GH r12)', async () => {
    const { bodyImageRefs, validateBodyImageRefs } = AstroPublisher._internals;
    expect(bodyImageRefs('![alt](/images/blog/x/body-1.webp trailing-junk)\n![ok](/images/blog/x/body-2.webp "title")')).toEqual([{ alt: 'ok', src: '/images/blog/x/body-2.webp', line: 1 }]);
    const wrapped = '## A\n\nProse.\n\n![Technician\nworking](/images/blog/x/hero.webp)\n\n![b](/images/blog/x/body-2.webp)';
    expect(bodyImageRefs(wrapped)).toEqual([{ alt: 'Technician working', src: '/images/blog/x/hero.webp', line: 4 }, { alt: 'b', src: '/images/blog/x/body-2.webp', line: 7 }]);
    expect((await validateBodyImageRefs({ body: wrapped, heroSrc: '/images/blog/x/hero.webp', getFile: async () => ({ content: 'x' }) })).reason).toMatch(/embeds the hero image/);
    // The section scanner sees the wrapped image under its heading.
    const { sections } = AstroPublisher._internals.scanBodySections(wrapped, { title: 'T' });
    expect(sections.find((sec) => sec.heading === 'A').images).toEqual(['/images/blog/x/hero.webp', '/images/blog/x/body-2.webp']);
  });

  test('bodyImageSlots: a `---` nested in a quote or list under a paragraph is not a setext underline — no fabricated section (GH r12)', () => {
    const body = ['Intro one.', '> ---', '', 'Intro two.', '- ---', '', 'Intro three.', '', '## Real', '', 'Real prose.'].join('\n');
    const { sections } = AstroPublisher._internals.scanBodySections(body, { title: 'T' });
    expect(sections.filter((sec) => !sec.intro).map((sec) => sec.heading)).toEqual(['Real']);
    expect(bodyImageSlots(body, 1, { title: 'T' }).map((sl) => sl.heading)).toEqual(['Real']);
  });

  test('refresh lane: a REUSED body picture is pinned to its blob — a replacement on main by commit time throws transient and deletes the branch (GH r12)', async () => {
    const heroSrc = '/images/2025/12/shrub-diseases.webp';
    const bodySrc = '/images/blog/shrub-diseases-sarasota-fl/body-1.webp';
    const liveFm = validFrontmatter({ slug: '/shrub-diseases-sarasota-fl/', title: 'Shrub Diseases', canonical: 'https://www.wavespestcontrol.com/blog/shrub-diseases-sarasota-fl/', hero_image: { src: heroSrc, alt: 'hero' }, og_image: heroSrc });
    const liveBody = `## Hibiscus\n\nHibiscus prose.\n\n![Live hibiscus alt](${bodySrc})\n\n## Oleander\n\nOleander prose.\n`;
    const liveMd = fmModule.stringify(liveFm, liveBody);
    const heroWebp = await AstroPublisher._internals.compressToWebp(Buffer.from(PATTERNS[4].split(',')[1], 'base64'), { width: 1200 });
    const bodyWebp = await AstroPublisher._internals.compressToWebp(Buffer.from(PATTERNS[1].split(',')[1], 'base64'), { width: 1200 });
    gh.getFile.mockImplementation(async (path, ref) => {
      if (path === 'src/content/blog/shrub-diseases-sarasota-fl.mdx') return null;
      if (path === 'src/content/blog/shrub-diseases-sarasota-fl.md') return { content: liveMd, sha: 'live' };
      if (path === `public${heroSrc}`) return { content: '', sha: 'h', raw: { content: heroWebp.toString('base64') } };
      // body-1 on main is reusable (same heading + lead); the fresh branch already carries a REPLACED blob.
      if (path === `public${bodySrc}`) return { content: '', sha: ref ? 'b1-replaced' : 'b1', raw: { content: bodyWebp.toString('base64') } };
      return null;
    });
    // Draft keeps the Hibiscus section verbatim but drops the picture → the publisher REUSES body-1.
    const draft = { type: 'draft', page_url: 'https://www.wavespestcontrol.com/blog/shrub-diseases-sarasota-fl/', frontmatter: {}, body: liveBody.replace(`![Live hibiscus alt](${bodySrc})\n\n`, '').replace('Oleander prose.', 'Oleander prose, refreshed.') };
    let thrown;
    try { await AstroPublisher.publishRefresh(draft, { action_type: 'refresh_existing_page', target_url: draft.page_url }); } catch (err) { thrown = err; }
    expect(thrown?.message).toMatch(/body-1\.webp \(reused picture changed: expected b1, found b1-replaced\)/);
    expect(thrown?.code).toBeUndefined();
    expect(gh.commitFiles).not.toHaveBeenCalled();
    expect(gh.deleteRef).toHaveBeenCalledWith(expect.stringMatching(/^content\/refresh-/));
  });

  test('bodyImageRefs: an image on the line after a reference-looking prefix is still rendered and validated; hero grandfather is per OCCURRENCE (GH r13)', async () => {
    const { bodyImageRefs, validateBodyImageRefs, legacyHeroRefs } = AstroPublisher._internals;
    expect(bodyImageRefs('[ref]:\nProse ![bad](/images/blog/x/missing.webp)').map((r) => r.src)).toEqual(['/images/blog/x/missing.webp']);
    expect((await validateBodyImageRefs({ body: '[ref]:\nProse ![bad](/images/blog/x/missing.webp)', heroSrc: '/images/blog/x/hero.webp', getFile: async () => null })).reason).toMatch(/not committed/);
    const hero = '/images/2025/12/shrub.webp';
    expect(legacyHeroRefs(`![a](${hero})\n\n![b](${hero})`, hero)).toEqual([hero, hero]);
    const getFile = async () => ({ content: 'x' });
    // Live body carried the hero ONCE → one occurrence is exempt; a refresh that repeats it fails.
    expect(await validateBodyImageRefs({ body: `![a](${hero})\n\n![p](/images/blog/x/body-1.webp)\n\n![q](/images/blog/x/body-2.webp)`, heroSrc: hero, getFile, legacyHeroSrcs: [hero] })).toMatchObject({ ok: true, distinct: 2 });
    expect((await validateBodyImageRefs({ body: `![a](${hero})\n\n![again](${hero})\n\n![p](/images/blog/x/body-1.webp)`, heroSrc: hero, getFile, legacyHeroSrcs: [hero] })).reason).toMatch(/embeds the hero image/);
  });

  test('bodyImageSlots: a quote or list directly under prose (no blank line) closes the paragraph — the lead and slot exclude the nested block; a heading-embedded image marks its section illustrated (GH r13)', () => {
    const body = ['## A', '', 'Prose line.', '> quoted testimonial', '', '## B', '', 'B prose.', '- item', '', '## ![inspection](/images/blog/x/body-1.webp) What to inspect', '', 'C prose.', '', '## D', '', 'D prose.'].join('\n');
    const lines = body.split('\n');
    const { sections } = AstroPublisher._internals.scanBodySections(body, { title: 'T' });
    const byHeading = Object.fromEntries(sections.filter((sec) => !sec.intro).map((sec) => [sec.heading, { last: lines[sec.lastProse - 1], lead: sec.lead, img: !!sec.hasImage }]));
    expect(byHeading).toEqual({
      A: { last: 'Prose line.', lead: 'Prose line.', img: false },
      B: { last: 'B prose.', lead: 'B prose.', img: false },
      'What to inspect': { last: 'C prose.', lead: 'C prose.', img: true },
      D: { last: 'D prose.', lead: 'D prose.', img: false },
    });
    expect(bodyImageSlots(body, 3, { title: 'T' }).map((sl) => sl.heading)).toEqual(['A', 'B', 'D']);
  });

  test('update lane: draft-authored pictures are pinned to their blobs even when the draft already meets the minimum — a replacement on main by commit time throws transient and drops the branch (GH r13)', async () => {
    const webp = async (i) => (await AstroPublisher._internals.compressToWebp(Buffer.from(PATTERNS[i].split(',')[1], 'base64'), { width: 1200 })).toString('base64');
    const bytes = { 'body-1': await webp(1), 'body-2': await webp(2) };
    gh.getFile.mockImplementation(async (path, ref) => {
      const m = path.match(/drywood-frass-venice\/(body-1|body-2)\.webp$/);
      if (m) return { content: '', sha: ref ? `${m[1]}-replaced` : `${m[1]}-orig`, raw: { content: bytes[m[1]] } };
      return null;
    });
    let thrown;
    try {
      await AstroPublisher.publishOrUpdatePage(draft(`${article}\n\n![a](/images/blog/pest-control/drywood-frass-venice/body-1.webp)\n\n![b](/images/blog/pest-control/drywood-frass-venice/body-2.webp)\n`), { action_type: 'new_supporting_blog' });
    } catch (err) { thrown = err; }
    expect(heroImageGenerator.generate.mock.calls.filter(([a]) => a.mode === 'blog-body')).toHaveLength(0);
    expect(thrown?.message).toMatch(/body-1\.webp \(pinned picture changed: expected body-1-orig, found body-1-replaced\)/);
    expect(thrown?.code).toBeUndefined();
    expect(gh.commitFiles).not.toHaveBeenCalled();
    expect(gh.deleteRef).toHaveBeenCalledWith(expect.stringMatching(/^content\//));
  });

  test('bodyImageRefs: an empty destination renders (empty src) and is REJECTED; a picture inside a merely styled <div> is scanned, definitely-hidden containers still are not (GH r14)', async () => {
    const { bodyImageRefs, validateBodyImageRefs } = AstroPublisher._internals;
    expect(bodyImageRefs('![illustration]()\n![b](<>)')).toEqual([{ alt: 'illustration', src: '', line: 0 }, { alt: 'b', src: '', line: 1 }]);
    expect((await validateBodyImageRefs({ body: '![illustration]()\n\n![p](/images/blog/x/body-1.webp)', heroSrc: '/images/blog/x/hero.webp', getFile: async () => ({ content: 'x' }) })).reason).toMatch(/not committed.*empty src/);
    const styled = '<div class="figure" style="max-width:600px">\n\n![styled](/images/blog/x/hero.webp)\n\n</div>\n<div hidden>\n\n![gone](/images/blog/x/body-9.webp)\n\n</div>\n<div aria-hidden="true">\n\n![gone2](/images/blog/x/body-8.webp)\n\n</div>';
    expect(bodyImageRefs(styled).map((r) => r.src)).toEqual(['/images/blog/x/hero.webp']);
    expect((await validateBodyImageRefs({ body: styled, heroSrc: '/images/blog/x/hero.webp', getFile: async () => ({ content: 'x' }) })).reason).toMatch(/embeds the hero image/);
  });

  test('assertBodyImagesAtHead: assets the PR did not change are validated from the DEFAULT branch (what the merge carries), PR-changed ones from the head; the base tip is returned for the merge-time recheck (GH r14)', async () => {
    const { assertBodyImagesAtHead, compressToWebp } = AstroPublisher._internals;
    const fmData = draft().frontmatter;
    const md = fmModule.stringify({ ...fmData, hero_image: { src: '/images/blog/pest-control/drywood-frass-venice/hero.webp', alt: 'h' } }, '## A\n\nProse.\n\n![a](/images/blog/pest-control/drywood-frass-venice/body-1.webp)\n\n## B\n\nMore.\n\n![b](/images/blog/pest-control/drywood-frass-venice/body-2.webp)\n');
    const webp = async (i) => (await compressToWebp(Buffer.from(PATTERNS[i].split(',')[1], 'base64'), { width: 1200 })).toString('base64');
    const hero = await webp(0); const b1 = await webp(1); const b2 = await webp(2);
    // The PR changed the post + body-1 only. body-2 on the HEAD is distinct, but MAIN has since replaced body-2 with a hero duplicate.
    gh.compareFiles.mockResolvedValue({ files: ['src/content/blog/pest-control/drywood-frass-venice.mdx', 'public/images/blog/pest-control/drywood-frass-venice/body-1.webp'], mergeBaseSha: 'mb' });
    gh.getBranchSha.mockResolvedValue('main-tip-1');
    gh.getFile.mockImplementation(async (path, ref) => {
      if (path === 'src/content/blog/pest-control/drywood-frass-venice.mdx') return ref === 'content/autonomous-x' ? { content: md, sha: 'm' } : null;
      if (path.endsWith('/hero.webp')) return { content: '', sha: 'h', raw: { content: hero } };
      if (path.endsWith('/body-1.webp')) return { content: '', sha: 'b1', raw: { content: b1 } };
      if (path.endsWith('/body-2.webp')) return { content: '', sha: ref === 'content/autonomous-x' ? 'b2-head' : 'b2-main', raw: { content: ref === 'content/autonomous-x' ? b2 : hero } };
      return null;
    });
    const res = await assertBodyImagesAtHead({ frontmatter: fmData, branch: 'content/autonomous-x' });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/body-2\.webp.*near-duplicate of hero|near-duplicate/);
    // Unchanged assets are read AT the captured base tip (GH r29) — a base
    // push between the tip capture and the read cannot change what merges.
    expect(gh.getFile).toHaveBeenCalledWith('public/images/blog/pest-control/drywood-frass-venice/body-2.webp', 'main-tip-1');
    expect(gh.getFile).toHaveBeenCalledWith('public/images/blog/pest-control/drywood-frass-venice/body-1.webp', 'content/autonomous-x');
    // With main's body-2 distinct, the check passes and reports the base tip it validated against.
    gh.getFile.mockImplementation(async (path, ref) => {
      if (path === 'src/content/blog/pest-control/drywood-frass-venice.mdx') return ref === 'content/autonomous-x' ? { content: md, sha: 'm' } : null;
      if (path.endsWith('/hero.webp')) return { content: '', sha: 'h', raw: { content: hero } };
      if (path.endsWith('/body-1.webp')) return { content: '', sha: 'b1', raw: { content: b1 } };
      if (path.endsWith('/body-2.webp')) return { content: '', sha: 'b2', raw: { content: b2 } };
      return null;
    });
    expect(await assertBodyImagesAtHead({ frontmatter: fmData, branch: 'content/autonomous-x' })).toEqual({ ok: true, reason: null, baseSha: 'main-tip-1' });
  });

  test('bodyImageRefs: a reference definition inside a JSX attribute or a (multi-line) MDX expression defines nothing — the outside reference stays text (hook P1)', () => {
    const body = [
      '![a][jsx]',
      '![b][expr]',
      '![c][real]',
      '',
      '<Callout note="',
      '[jsx]: /images/blog/x/body-1.webp',
      '" />',
      '{',
      '  `[expr]: /images/blog/x/body-2.webp`',
      '}',
      '[real]: /images/blog/x/body-3.webp',
    ].join('\n');
    expect(AstroPublisher._internals.bodyImageRefs(body).map((r) => r.src)).toEqual(['/images/blog/x/body-3.webp']);
  });

  test('bodyImageSlots: an image in a setext H2 heading belongs to the section it opens, not the intro (GH r16)', () => {
    const body = ['Intro prose.', '', '![inspection](/images/blog/x/body-1.webp) Inspection', '---', '', 'Inspection prose.', '', '## B', '', 'B prose.'].join('\n');
    const { sections } = AstroPublisher._internals.scanBodySections(body, { title: 'T' });
    expect(sections.map((sec) => [sec.heading, !!sec.hasImage, sec.images])).toEqual([['T', false, []], ['Inspection', true, ['/images/blog/x/body-1.webp']], ['B', false, []]]);
    expect(bodyImageSlots(body, 1, { title: 'T' }).map((sl) => sl.heading)).toEqual(['B']);
  });

  test('update lane: the pre-commit lock covers the existing post SHA and the destination path of a legacy migration (GH r16)', async () => {
    const liveMd = fmModule.stringify(
      { ...draft().frontmatter, slug: '/pest-control/drywood-frass-venice/', hero_image: { src: '/images/blog/pest-control/drywood-frass-venice/hero.webp', alt: 'live hero' }, og_image: '/images/blog/pest-control/drywood-frass-venice/hero.webp' },
      'Old body.\n',
    );
    const committed = committedStub(['public/images/blog/pest-control/drywood-frass-venice/hero.webp']);
    // Existing legacy .md read on main with sha 'live-sha'; on the fresh branch it already moved.
    gh.getFile.mockImplementation(async (path, ref) => {
      if (path === 'src/content/blog/pest-control/drywood-frass-venice.md') return { content: liveMd, sha: ref ? 'moved' : 'live-sha' };
      return committed(path);
    });
    let thrown;
    try { await AstroPublisher.publishOrUpdatePage(draft(), { action_type: 'new_supporting_blog' }); } catch (err) { thrown = err; }
    expect(thrown?.message).toMatch(/drywood-frass-venice\.md \(post changed: expected live-sha, found moved\)/);
    expect(thrown?.code).toBeUndefined();
    expect(gh.commitFiles).not.toHaveBeenCalled();
    expect(gh.deleteRef).toHaveBeenCalledWith(expect.stringMatching(/^content\//));
    // Migration destination (.mdx) that appeared on the branch is a conflict too.
    gh.deleteRef.mockClear();
    gh.getFile.mockImplementation(async (path, ref) => {
      if (path === 'src/content/blog/pest-control/drywood-frass-venice.md') return { content: liveMd, sha: 'live-sha' };
      if (ref && path === 'src/content/blog/pest-control/drywood-frass-venice.mdx') return { content: 'x', sha: 'new' };
      return committed(path);
    });
    thrown = undefined;
    try { await AstroPublisher.publishOrUpdatePage(draft(), { action_type: 'new_supporting_blog' }); } catch (err) { thrown = err; }
    expect(thrown?.message).toMatch(/drywood-frass-venice\.mdx \(appeared since the route was resolved\)/);
    expect(gh.commitFiles).not.toHaveBeenCalled();
  });

  test('bodyImageRefs: a reference definition with an angle-bracket (spaced) destination is decoded like an inline one; escaped label punctuation matches its unescaped spelling (GH r17)', () => {
    const refs = AstroPublisher._internals.bodyImageRefs('![a][pic]\n![detail][shot!]\n\n[pic]: </images/blog/x/body 1.webp>\n[shot\\!]: /images/blog/x/body-2.webp');
    expect(refs.map((r) => r.src)).toEqual(['/images/blog/x/body 1.webp', '/images/blog/x/body-2.webp']);
  });

  test('publishAstro (calendar/scheduler lane): under the gate a hero-only post gets its two body images in the same commit; the PR body carries the illustrated body (GH r18 P1)', async () => {
    const post = {
      id: 'post-bi', title: 'Ant Trails in Bradenton', slug: 'ant-trails-bradenton',
      meta_description: 'Bradenton homeowners can use this guide to identify ant trails, reduce entry points, and spot trouble early. Learn more on the Waves blog.',
      keyword: 'ant control Bradenton', category: 'pest-control', post_type: 'location', service_areas_tag: ['Bradenton'], related_services: [], target_sites: ['wavespestcontrol.com'],
      author_slug: 'adam', reviewer_slug: 'reviewer', technically_reviewed_at: '2026-05-08', fact_checked_by: 'Virginia Gelser', fact_checked_at: '2026-05-08',
      featured_image_url: PATTERNS[4], hero_image_alt: 'Ant trail near a Bradenton patio',
      content: '## What you are seeing\n\nAnt trails follow scent lines along patio edges.\n\n## What to do first\n\nWipe the trail and seal the entry point.',
    };
    const read = chain({ first: jest.fn().mockResolvedValue(post) });
    db.mockImplementation(() => { const q = read; return q; });
    gh.getFile.mockResolvedValue(null);
    gh.commitFiles.mockResolvedValue({ commit: { sha: 'multi' } });
    gh.createPr.mockResolvedValue({ number: 77, html_url: 'https://github.com/x/pull/77', head: { sha: 'multi' } });

    await AstroPublisher.publishAstro('post-bi');

    expect(heroImageGenerator.generate.mock.calls.filter(([a]) => a.mode === 'blog-body')).toHaveLength(2);
    const files = gh.commitFiles.mock.calls[0][0].files.map((f) => f.path);
    expect(files).toEqual([
      'public/images/blog/ant-trails-bradenton/hero.webp',
      'public/images/blog/ant-trails-bradenton/body-1.webp',
      'public/images/blog/ant-trails-bradenton/body-2.webp',
      'src/content/blog/ant-trails-bradenton.md',
    ]);
    const written = fmModule.parse(gh.commitFiles.mock.calls[0][0].files[3].content).content;
    expect(AstroPublisher._internals.countBodyImages(written)).toBe(2);
  });

  test('publishAstro republish: the live post\'s body pictures are REUSED (no generation, no body-3/4) (GH r19)', async () => {
    const post = {
      id: 'post-re', title: 'Ant Trails in Bradenton', slug: 'ant-trails-bradenton',
      meta_description: 'Bradenton homeowners can use this guide to identify ant trails, reduce entry points, and spot trouble early. Learn more on the Waves blog.',
      keyword: 'ant control Bradenton', category: 'pest-control', post_type: 'location', service_areas_tag: ['Bradenton'], related_services: [], target_sites: ['wavespestcontrol.com'],
      author_slug: 'adam', reviewer_slug: 'reviewer', technically_reviewed_at: '2026-05-08', fact_checked_by: 'Virginia Gelser', fact_checked_at: '2026-05-08',
      featured_image_url: PATTERNS[4], hero_image_alt: 'Ant trail near a Bradenton patio',
      content: '## What you are seeing\n\nAnt trails follow scent lines along patio edges.\n\n## What to do first\n\nWipe the trail and seal the entry point.',
    };
    const liveBody = '## What you are seeing\n\nAnt trails follow scent lines along patio edges.\n\n![Live alt one](/images/blog/ant-trails-bradenton/body-1.webp)\n\n## What to do first\n\nWipe the trail and seal the entry point.\n\n![Live alt two](/images/blog/ant-trails-bradenton/body-2.webp)\n';
    const liveMd = fmModule.stringify(validFrontmatter({ slug: '/pest-control/ant-trails-bradenton/', title: post.title, hero_image: { src: '/images/blog/ant-trails-bradenton/hero.webp', alt: 'h' }, og_image: '/images/blog/ant-trails-bradenton/hero.webp' }), liveBody);
    const webp = async (i) => (await AstroPublisher._internals.compressToWebp(Buffer.from(PATTERNS[i].split(',')[1], 'base64'), { width: 1200 })).toString('base64');
    const bytes = { 'body-1': await webp(1), 'body-2': await webp(2) };
    const read = chain({ first: jest.fn().mockResolvedValue(post) });
    db.mockImplementation(() => read);
    gh.getFile.mockImplementation(async (path) => {
      if (path === 'src/content/blog/ant-trails-bradenton.md') return { content: liveMd, sha: 'live' };
      const m = path.match(/ant-trails-bradenton\/(body-1|body-2)\.webp$/);
      return m ? { content: '', sha: m[1], raw: { content: bytes[m[1]] } } : null;
    });
    gh.commitFiles.mockResolvedValue({ commit: { sha: 'multi' } });
    gh.createPr.mockResolvedValue({ number: 78, html_url: 'https://github.com/x/pull/78', head: { sha: 'multi' } });

    await AstroPublisher.publishAstro('post-re');

    expect(heroImageGenerator.generate.mock.calls.filter(([a]) => a.mode === 'blog-body')).toHaveLength(0);
    const files = gh.commitFiles.mock.calls[0][0].files.map((f) => f.path);
    expect(files).toEqual(['public/images/blog/ant-trails-bradenton/hero.webp', 'src/content/blog/ant-trails-bradenton.md']);
    const written = fmModule.parse(gh.commitFiles.mock.calls[0][0].files[1].content).content;
    expect(written).toContain('![Live alt one](/images/blog/ant-trails-bradenton/body-1.webp)');
    expect(written).toContain('![Live alt two](/images/blog/ant-trails-bradenton/body-2.webp)');
  });

  test('publishAstro republish: a live post that moved on main by commit time throws transient and drops the branch — never overwritten (hook P0)', async () => {
    const post = {
      id: 'post-lock', title: 'Ant Trails in Bradenton', slug: 'ant-trails-bradenton',
      meta_description: 'Bradenton homeowners can use this guide to identify ant trails, reduce entry points, and spot trouble early. Learn more on the Waves blog.',
      keyword: 'ant control Bradenton', category: 'pest-control', post_type: 'location', service_areas_tag: ['Bradenton'], related_services: [], target_sites: ['wavespestcontrol.com'],
      author_slug: 'adam', reviewer_slug: 'reviewer', technically_reviewed_at: '2026-05-08', fact_checked_by: 'Virginia Gelser', fact_checked_at: '2026-05-08',
      featured_image_url: PATTERNS[4], hero_image_alt: 'Ant trail near a Bradenton patio',
      content: '## What you are seeing\n\nAnt trails follow scent lines along patio edges.\n\n## What to do first\n\nWipe the trail and seal the entry point.',
    };
    const liveMd = fmModule.stringify(validFrontmatter({ slug: '/pest-control/ant-trails-bradenton/', title: post.title, hero_image: { src: '/images/blog/ant-trails-bradenton/hero.webp', alt: 'h' }, og_image: '/images/blog/ant-trails-bradenton/hero.webp' }), '## What you are seeing\n\nOld.\n');
    const read = chain({ first: jest.fn().mockResolvedValue(post) });
    const update = chain();
    db.mockImplementation(() => read);
    gh.getFile.mockImplementation(async (path, ref) => (path === 'src/content/blog/ant-trails-bradenton.md' ? { content: liveMd, sha: ref ? 'moved' : 'live' } : null));
    let thrown;
    try { await AstroPublisher.publishAstro('post-lock'); } catch (err) { thrown = err; }
    expect(thrown?.message).toMatch(/ant-trails-bradenton\.md \(post changed: expected live, found moved\)/);
    expect(thrown?.code).toBeUndefined();
    expect(gh.commitFiles).not.toHaveBeenCalled();
    expect(gh.createPr).not.toHaveBeenCalled();
    expect(gh.deleteRef).toHaveBeenCalledWith(expect.stringMatching(/^content\/blog-ant-trails-bradenton-/));
    void update;
  });

  test('unpublishAstro removes the generated body-N.webp assets with the hero (GH r19)', async () => {
    const read = chain({ first: jest.fn().mockResolvedValue({ id: 'post-un', astro_status: 'live', slug: 'ant-trails-bradenton', title: 'Ant Trails' }) });
    db.mockImplementation(() => read);
    gh.getFile.mockImplementation(async (path) => {
      if (path === 'src/content/blog/ant-trails-bradenton.md') return { content: '---\ntitle: x\n---\nbody', sha: 'md' };
      if (path === 'public/images/blog/ant-trails-bradenton/hero.webp') return { content: '', sha: 'h' };
      return null;
    });
    gh.listDir.mockResolvedValue([
      { type: 'file', name: 'hero.webp', path: 'public/images/blog/ant-trails-bradenton/hero.webp', sha: 'h' },
      { type: 'file', name: 'body-1.webp', path: 'public/images/blog/ant-trails-bradenton/body-1.webp', sha: 'b1' },
      { type: 'file', name: 'body-2.webp', path: 'public/images/blog/ant-trails-bradenton/body-2.webp', sha: 'b2' },
      { type: 'file', name: 'notes.txt', path: 'public/images/blog/ant-trails-bradenton/notes.txt', sha: 'n' },
    ]);
    gh.deleteFile.mockResolvedValue({});
    gh.createPr.mockResolvedValue({ number: 79, html_url: 'https://github.com/x/pull/79', head: { sha: 'u' } });

    await AstroPublisher.unpublishAstro('post-un');

    const deleted = gh.deleteFile.mock.calls.map(([a]) => a.path);
    expect(deleted).toEqual(expect.arrayContaining(['src/content/blog/ant-trails-bradenton.md', 'public/images/blog/ant-trails-bradenton/hero.webp', 'public/images/blog/ant-trails-bradenton/body-1.webp', 'public/images/blog/ant-trails-bradenton/body-2.webp']));
    expect(deleted).not.toContain('public/images/blog/ant-trails-bradenton/notes.txt');
    expect(gh.createPr.mock.calls[0][0].body).toContain('2 generated body image(s)');
  });

  test('refresh lane: a REUSED committed hero sibling is pinned — a hero replaced on main by commit time throws transient (GH r19)', async () => {
    const heroSrc = '/images/2025/12/shrub-diseases.webp';
    const liveFm = validFrontmatter({ slug: '/shrub-diseases-sarasota-fl/', title: 'Shrub Diseases', canonical: 'https://www.wavespestcontrol.com/blog/shrub-diseases-sarasota-fl/', hero_image: { src: heroSrc, alt: 'hero' }, og_image: heroSrc });
    const liveBody = '## Hibiscus\n\nHibiscus prose.\n\n## Oleander\n\nOleander prose.\n';
    const liveMd = fmModule.stringify(liveFm, liveBody);
    const heroWebp = await AstroPublisher._internals.compressToWebp(Buffer.from(PATTERNS[4].split(',')[1], 'base64'), { width: 1200 });
    gh.getFile.mockImplementation(async (path, ref) => {
      if (path === 'src/content/blog/shrub-diseases-sarasota-fl.mdx') return null;
      if (path === 'src/content/blog/shrub-diseases-sarasota-fl.md') return { content: liveMd, sha: 'live' };
      if (path === `public${heroSrc}`) return { content: '', sha: ref ? 'hero-replaced' : 'hero-orig', raw: { content: heroWebp.toString('base64') } };
      return null;
    });
    const draft = { type: 'draft', page_url: 'https://www.wavespestcontrol.com/blog/shrub-diseases-sarasota-fl/', frontmatter: {}, body: liveBody.replace('Oleander prose.', 'Oleander prose, refreshed.') };
    let thrown;
    try { await AstroPublisher.publishRefresh(draft, { action_type: 'refresh_existing_page', target_url: draft.page_url }); } catch (err) { thrown = err; }
    expect(thrown?.message).toMatch(/shrub-diseases\.webp \(pinned picture changed: expected hero-orig, found hero-replaced\)/);
    expect(gh.commitFiles).not.toHaveBeenCalled();
    expect(gh.deleteRef).toHaveBeenCalledWith(expect.stringMatching(/^content\/refresh-/));
  });

  test('assertBodyImagesAtHead: an operational read error is reported transient; a contract miss is not (hook P1)', async () => {
    const { assertBodyImagesAtHead } = AstroPublisher._internals;
    gh.getFile.mockImplementation(async () => { throw new Error('GitHub 503'); });
    const res = await assertBodyImagesAtHead({ frontmatter: {}, branch: 'content/blog-x', filePath: 'src/content/blog/ant-trails-bradenton.md' });
    expect(res).toMatchObject({ ok: false, transient: true });
    expect(res.reason).toContain('GitHub 503');
    const md = fmModule.stringify(validFrontmatter({ slug: '/pest-control/ant-trails-bradenton/', title: 'T', hero_image: { src: '/images/blog/ant-trails-bradenton/hero.webp', alt: 'h' }, og_image: '/images/blog/ant-trails-bradenton/hero.webp' }), '## A\n\nProse only.\n');
    gh.getFile.mockImplementation(async (path, ref) => (ref === 'content/blog-x' && path === 'src/content/blog/ant-trails-bradenton.md' ? { content: md, sha: 'm' } : null));
    const miss = await assertBodyImagesAtHead({ frontmatter: {}, branch: 'content/blog-x', filePath: 'src/content/blog/ant-trails-bradenton.md' });
    expect(miss.ok).toBe(false);
    expect(miss.transient).toBeFalsy();
  });

  test('assertBodyImagesAtHead: an explicit filePath (scheduler lane) is validated on the PR branch (GH r19)', async () => {
    const { assertBodyImagesAtHead } = AstroPublisher._internals;
    const md = fmModule.stringify(validFrontmatter({ slug: '/pest-control/ant-trails-bradenton/', title: 'T', hero_image: { src: '/images/blog/ant-trails-bradenton/hero.webp', alt: 'h' }, og_image: '/images/blog/ant-trails-bradenton/hero.webp' }), '## A\n\nProse only.\n');
    gh.getFile.mockImplementation(async (path, ref) => (ref === 'content/blog-x' && path === 'src/content/blog/ant-trails-bradenton.md' ? { content: md, sha: 'm' } : null));
    const res = await assertBodyImagesAtHead({ frontmatter: {}, branch: 'content/blog-x', filePath: AstroPublisher.scheduledBlogFilePath('ant-trails-bradenton') });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/0 distinct in-article image/);
    // EXACTLY the scheduler's .md is read — a stale .mdx sibling on the branch is never consulted (hook P1).
    expect(gh.getFile).not.toHaveBeenCalledWith('src/content/blog/ant-trails-bradenton.mdx', 'content/blog-x');
    expect(gh.getFile).toHaveBeenCalledWith('src/content/blog/ant-trails-bradenton.md', 'content/blog-x');
    expect((await assertBodyImagesAtHead({ frontmatter: {}, branch: 'content/blog-y', filePath: 'src/content/blog/ant-trails-bradenton.md' })).reason).toMatch(/not found on content\/blog-y/);
  });

  test('bodyImageRefs: a reference-looking line glued to prose defines nothing — the reference stays text (GH r20)', () => {
    expect(AstroPublisher._internals.bodyImageRefs('![a][pic]\n\nIntro prose\n[pic]: /images/blog/x/body-1.webp\n\n[ok]: /images/blog/x/body-2.webp\n\n![b][ok]').map((r) => r.src)).toEqual(['/images/blog/x/body-2.webp']);
  });

  test('isTransientImageError: a Gemini 429/5xx recorded as fatal is still transient; a 400 is not (GH r20 P1)', () => {
    const { isTransientImageError } = AstroPublisher._internals;
    const err = (attempts) => Object.assign(new Error('image-generator: all providers failed'), { attempts });
    expect(isTransientImageError(err([{ provider: 'gpt-image-2', result: { fatal: true, status: 400 } }, { provider: 'gemini', result: { fatal: true, status: 429 } }]))).toBe(true);
    expect(isTransientImageError(err([{ provider: 'gemini', result: { fatal: true, status: 503 } }]))).toBe(true);
    expect(isTransientImageError(err([{ provider: 'gemini', result: { fatal: true, status: 400 } }, { provider: 'gpt-image-2', result: { fatal: true, status: 'no_b64_in_response' } }]))).toBe(false);
    // A chain skipped for a spent slot budget (the near-duplicate re-framing after a slow first leg) is transient, not a park (Codex r10 P2 on #3964).
    expect(isTransientImageError(err([{ provider: 'gpt-image-2', result: { skipped: true, retryable: true, reason: 'chain budget exhausted (360000 ms)' } }]))).toBe(true);
  });

  test('publishAstro republish with a COMMITTED hero (absolute hub URL): the hero enters the duplicate check from its relative src (hook P1)', async () => {
    const post = {
      id: 'post-hub', title: 'Ant Trails in Bradenton', slug: 'ant-trails-bradenton',
      meta_description: 'Bradenton homeowners can use this guide to identify ant trails, reduce entry points, and spot trouble early. Learn more on the Waves blog.',
      keyword: 'ant control Bradenton', category: 'pest-control', post_type: 'location', service_areas_tag: ['Bradenton'], related_services: [], target_sites: ['wavespestcontrol.com'],
      author_slug: 'adam', reviewer_slug: 'reviewer', technically_reviewed_at: '2026-05-08', fact_checked_by: 'Virginia Gelser', fact_checked_at: '2026-05-08',
      featured_image_url: 'https://www.wavespestcontrol.com/images/blog/ant-trails-bradenton/hero.webp', hero_image_alt: 'Ant trail near a Bradenton patio',
      content: '## What you are seeing\n\nAnt trails follow scent lines along patio edges.\n\n## What to do first\n\nWipe the trail and seal the entry point.',
    };
    const heroWebp = (await AstroPublisher._internals.compressToWebp(Buffer.from(PATTERNS[4].split(',')[1], 'base64'), { width: 1200 })).toString('base64');
    const read = chain({ first: jest.fn().mockResolvedValue(post) });
    db.mockImplementation(() => read);
    gh.getFile.mockImplementation(async (path) => (path === 'public/images/blog/ant-trails-bradenton/hero.webp' ? { content: '', sha: 'h', raw: { content: heroWebp } } : null));
    gh.commitFiles.mockResolvedValue({ commit: { sha: 'multi' } });
    gh.createPr.mockResolvedValue({ number: 80, html_url: 'https://github.com/x/pull/80', head: { sha: 'multi' } });

    await AstroPublisher.publishAstro('post-hub');

    // The committed hero's bytes were read for the dHash sibling set (no fresh hero bytes on a committed-hero republish).
    expect(gh.getFile).toHaveBeenCalledWith('public/images/blog/ant-trails-bradenton/hero.webp');
    const files = gh.commitFiles.mock.calls[0][0].files.map((f) => f.path);
    expect(files).toEqual(['public/images/blog/ant-trails-bradenton/body-1.webp', 'public/images/blog/ant-trails-bradenton/body-2.webp', 'src/content/blog/ant-trails-bradenton.md']);
  });

  test('unpublishAstro aborts (branch dropped, no PR) when the body-asset listing fails (GH r20)', async () => {
    const read = chain({ first: jest.fn().mockResolvedValue({ id: 'post-un2', astro_status: 'live', slug: 'ant-trails-bradenton', title: 'Ant Trails' }) });
    db.mockImplementation(() => read);
    gh.getFile.mockImplementation(async (path) => (path === 'src/content/blog/ant-trails-bradenton.md' ? { content: '---\ntitle: x\n---\nbody', sha: 'md' } : null));
    gh.listDir.mockRejectedValue(new Error('GitHub 502'));
    let thrown;
    try { await AstroPublisher.unpublishAstro('post-un2'); } catch (err) { thrown = err; }
    expect(thrown?.message).toContain('GitHub 502');
    expect(gh.createPr).not.toHaveBeenCalled();
    // The listing happens BEFORE the branch is cut — no orphan ref per retry (hook P1).
    expect(gh.createBranch).not.toHaveBeenCalled();
  });

  test('assertBodyImagesAtHead: a post that changed on the default branch since the branch was cut is withheld (the merged body is not the PR-head copy) (GH r20)', async () => {
    const { assertBodyImagesAtHead, compressToWebp } = AstroPublisher._internals;
    const fmData = draft().frontmatter;
    const md = fmModule.stringify({ ...fmData, hero_image: { src: '/images/blog/pest-control/drywood-frass-venice/hero.webp', alt: 'h' } }, '## A\n\nProse.\n\n![a](/images/blog/pest-control/drywood-frass-venice/body-1.webp)\n\n## B\n\nMore.\n\n![b](/images/blog/pest-control/drywood-frass-venice/body-2.webp)\n');
    const webp = async (i) => (await compressToWebp(Buffer.from(PATTERNS[i].split(',')[1], 'base64'), { width: 1200 })).toString('base64');
    const hero = await webp(0); const b1 = await webp(1); const b2 = await webp(2);
    gh.compareFiles.mockResolvedValue({ files: ['src/content/blog/pest-control/drywood-frass-venice.mdx'], mergeBaseSha: 'mb' });
    gh.getBranchSha.mockResolvedValue('main-tip-1');
    gh.getFile.mockImplementation(async (path, ref) => {
      if (path === 'src/content/blog/pest-control/drywood-frass-venice.mdx') {
        if (ref === 'content/autonomous-x') return { content: md, sha: 'head' };
        if (ref === 'mb') return { content: md, sha: 'fork' };
        return { content: md, sha: 'main-moved' }; // default branch edited the post after the fork
      }
      if (path.endsWith('/hero.webp')) return { content: '', sha: 'h', raw: { content: hero } };
      if (path.endsWith('/body-1.webp')) return { content: '', sha: 'b1', raw: { content: b1 } };
      if (path.endsWith('/body-2.webp')) return { content: '', sha: 'b2', raw: { content: b2 } };
      return null;
    });
    const res = await assertBodyImagesAtHead({ frontmatter: fmData, branch: 'content/autonomous-x' });
    expect(res.ok).toBe(false);
    expect(res.transient).toBeFalsy();
    expect(res.reason).toMatch(/changed on the default branch since content\/autonomous-x was cut/);
    // Same blob at the fork and now → validated normally.
    gh.getFile.mockImplementation(async (path, ref) => {
      if (path === 'src/content/blog/pest-control/drywood-frass-venice.mdx') return { content: md, sha: ref === 'content/autonomous-x' ? 'head' : 'fork' };
      if (path.endsWith('/hero.webp')) return { content: '', sha: 'h', raw: { content: hero } };
      if (path.endsWith('/body-1.webp')) return { content: '', sha: 'b1', raw: { content: b1 } };
      if (path.endsWith('/body-2.webp')) return { content: '', sha: 'b2', raw: { content: b2 } };
      return null;
    });
    expect(await assertBodyImagesAtHead({ frontmatter: fmData, branch: 'content/autonomous-x' })).toEqual({ ok: true, reason: null, baseSha: 'main-tip-1' });
    // The divergence read of the post itself is pinned to the captured base
    // tip (GH r30) — a push after the capture is the tip comparison's
    // transient retry, never a deterministic withhold.
    expect(gh.getFile).toHaveBeenCalledWith('src/content/blog/pest-control/drywood-frass-venice.mdx', 'main-tip-1');
  });

  test('bodyImageRefs: an image used as a link label is scanned; an angle destination keeps its edge whitespace (GH r21)', async () => {
    const { bodyImageRefs, validateBodyImageRefs } = AstroPublisher._internals;
    expect(bodyImageRefs('[![linked alt](/images/blog/x/missing.webp)](/contact/)\n![p](</images/blog/x/body-1.webp >)').map((r) => [r.alt, r.src])).toEqual([['linked alt', '/images/blog/x/missing.webp'], ['p', '/images/blog/x/body-1.webp ']]);
    const getFile = async (path) => (path === 'public/images/blog/x/body-1.webp' ? { content: 'x' } : null);
    expect((await validateBodyImageRefs({ body: '[![linked alt](/images/blog/x/missing.webp)](/contact/)', heroSrc: '/images/blog/x/hero.webp', getFile })).reason).toMatch(/not committed.*missing\.webp/);
    expect((await validateBodyImageRefs({ body: '![p](</images/blog/x/body-1.webp >)', heroSrc: '/images/blog/x/hero.webp', getFile })).reason).toMatch(/not committed/);
  });

  test('refresh lane: a superseded body-N (section rewritten) is DELETED in the same commit, pinned to its blob; reused ones stay (GH r22)', async () => {
    const heroSrc = '/images/2025/12/shrub-diseases.webp';
    const b1 = '/images/blog/shrub-diseases-sarasota-fl/body-1.webp';
    const b2 = '/images/blog/shrub-diseases-sarasota-fl/body-2.webp';
    const liveFm = validFrontmatter({ slug: '/shrub-diseases-sarasota-fl/', title: 'Shrub Diseases', canonical: 'https://www.wavespestcontrol.com/blog/shrub-diseases-sarasota-fl/', hero_image: { src: heroSrc, alt: 'hero' }, og_image: heroSrc });
    const liveBody = `## Hibiscus\n\nHibiscus prose.\n\n![Live one](${b1})\n\n## Oleander\n\nOleander prose.\n\n![Live two](${b2})\n`;
    const liveMd = fmModule.stringify(liveFm, liveBody);
    const webp = async (i) => (await AstroPublisher._internals.compressToWebp(Buffer.from(PATTERNS[i].split(',')[1], 'base64'), { width: 1200 })).toString('base64');
    const bytes = { hero: await webp(4), 'body-1': await webp(1), 'body-2': await webp(2) };
    gh.getFile.mockImplementation(async (path) => {
      if (path === 'src/content/blog/shrub-diseases-sarasota-fl.mdx') return null;
      if (path === 'src/content/blog/shrub-diseases-sarasota-fl.md') return { content: liveMd, sha: 'live' };
      if (path === `public${heroSrc}`) return { content: '', sha: 'h', raw: { content: bytes.hero } };
      const m = path.match(/shrub-diseases-sarasota-fl\/(body-1|body-2)\.webp$/);
      return m ? { content: '', sha: `${m[1]}-sha`, raw: { content: bytes[m[1]] } } : null;
    });
    gh.commitFiles.mockResolvedValue({ commit: { sha: 'multi' } });
    // Hibiscus section REWRITTEN (different lead → body-1 not reusable); Oleander unchanged (body-2 reused). Draft drops both refs.
    const draft = { type: 'draft', page_url: 'https://www.wavespestcontrol.com/blog/shrub-diseases-sarasota-fl/', frontmatter: {}, body: '## Hibiscus\n\nCompletely new hibiscus guidance.\n\n## Oleander\n\nOleander prose.\n' };
    const res = await AstroPublisher.publishRefresh(draft, { action_type: 'refresh_existing_page', target_url: draft.page_url });
    expect(res.status).toBe('pr_open');
    const call = gh.commitFiles.mock.calls[0][0];
    expect(call.files.map((f) => f.path)).toEqual(['public/images/blog/shrub-diseases-sarasota-fl/body-3.webp', 'src/content/blog/shrub-diseases-sarasota-fl.md']);
    expect(call.deletes).toEqual(['public/images/blog/shrub-diseases-sarasota-fl/body-1.webp']);
    const written = fmModule.parse(call.files[1].content).content;
    expect(written).toContain(`![Live two](${b2})`);
    expect(written).not.toContain(b1);
    // The lock also covers the deleted path (pinned to the blob it was judged on).
    expect(gh.getFile).toHaveBeenCalledWith('public/images/blog/shrub-diseases-sarasota-fl/body-1.webp', expect.stringMatching(/^content\/refresh-/));
  });

  test('stripManagedBodyImages removes publisher-managed body-N references (and only those) from a body mirrored into blog_posts (GH r22)', () => {
    const body = '## A\n\nProse.\n\n![gen](/images/blog/x/body-1.webp)\n\n## B\n\n![authored](/images/2025/12/photo.webp)\n\nMore ![inline](/images/blog/x/body-2.webp) text.\n\n![gen2](/images/blog/x/body-2.webp)';
    expect(AstroPublisher.stripManagedBodyImages(body, 'x')).toBe('## A\n\nProse.\n\n## B\n\n![authored](/images/2025/12/photo.webp)\n\nMore text.');
    // Reference-style managed images and their definitions go too; a definition for a NON-managed path stays (hook P1).
    const ref = '## A\n\nProse.\n\n![gen][pic]\n\n![keep][photo]\n\n[pic]: </images/blog/x/body-1.webp>\n[photo]: /images/2025/12/photo.webp';
    expect(AstroPublisher.stripManagedBodyImages(ref, 'x')).toBe('## A\n\nProse.\n\n![keep][photo]\n\n[photo]: /images/2025/12/photo.webp');
    // Multi-line managed definitions (destination on the continuation line, title after) are removed whole (hook P1).
    const multi = '## A\n\nProse.\n\n![gen][pic]\n\n[pic]:\n  </images/blog/x/body-1.webp>\n  "title"\n[photo]: /images/2025/12/photo.webp';
    expect(AstroPublisher.stripManagedBodyImages(multi, 'x')).toBe('## A\n\nProse.\n\n[photo]: /images/2025/12/photo.webp');
    // Only RENDERED, publisher-OWNED occurrences: code/comments/expressions and authored `body-background.webp` stay (hook P1).
    const guarded = ['## A', '', 'Prose.', '', '![gen](/images/blog/x/body-1.webp)', '', '```', '![gen](/images/blog/x/body-1.webp)', '```', '', 'Inline `![gen](/images/blog/x/body-2.webp)` code.', '', '<!-- ![gen](/images/blog/x/body-2.webp) -->', '', '![bg](/images/blog/x/body-background.webp)', '', '![other post](/images/blog/y/body-1.webp)'].join('\n');
    expect(AstroPublisher.stripManagedBodyImages(guarded, 'x')).toBe(['## A', '', 'Prose.', '', '```', '![gen](/images/blog/x/body-1.webp)', '```', '', 'Inline `![gen](/images/blog/x/body-2.webp)` code.', '', '<!-- ![gen](/images/blog/x/body-2.webp) -->', '', '![bg](/images/blog/x/body-background.webp)', '', '![other post](/images/blog/y/body-1.webp)'].join('\n'));
    // Nullable slug → publishAstro's slugify(title) fallback.
    expect(AstroPublisher.stripManagedBodyImagesForPost('P.\n\n![g](/images/blog/ant-trails-in-bradenton/body-1.webp)', { slug: null, title: 'Ant Trails in Bradenton' })).toBe('P.');
    expect(AstroPublisher.scheduledBlogFilePathForPost({ slug: null, title: 'Ant Trails in Bradenton' })).toBe('src/content/blog/ant-trails-in-bradenton.md');
  });

  test('bodyImageRefs: a definition opening a blockquote after prose defines; a closed <details> summary image renders; escaped `\\>` inside an angle destination is honoured (GH r23)', async () => {
    const { bodyImageRefs } = AstroPublisher._internals;
    expect(bodyImageRefs('![a][pic]\n\nIntro\n> [pic]: /images/blog/x/body-1.webp').map((r) => r.src)).toEqual(['/images/blog/x/body-1.webp']);
    expect(bodyImageRefs('<details><summary>![preview](/images/blog/x/hero.webp)</summary>\n\n![gone](/images/blog/x/body-9.webp)\n\n</details>').map((r) => r.src)).toEqual(['/images/blog/x/hero.webp']);
    expect(bodyImageRefs('![a](</images/blog/x/body-\\>.webp>)').map((r) => r.src)).toEqual(['/images/blog/x/body->.webp']);
  });

  test('stripManagedBodyImages resolves rendered spans structurally — angle-destination and wrapped-alt managed images are stripped too (GH r23)', () => {
    const body = '## A\n\nProse.\n\n![gen](</images/blog/x/body-1.webp>)\n\n![wrapped\nalt](/images/blog/x/body-2.webp)\n\nMore.';
    expect(AstroPublisher.stripManagedBodyImages(body, 'x')).toBe('## A\n\nProse.\n\nMore.');
    // A code-span copy of the SAME managed image on the same line as a real one stays; only the rendered one goes (hook P1).
    expect(AstroPublisher.stripManagedBodyImages('See `![gen](/images/blog/x/body-1.webp)` then ![gen](/images/blog/x/body-1.webp) here.', 'x')).toBe('See `![gen](/images/blog/x/body-1.webp)` then here.');
    expect(AstroPublisher.stripManagedBodyImages('> ![gen](/images/blog/x/body-1.webp)\n> Quoted prose.', 'x')).toBe('>\n> Quoted prose.');
    // A definition inside a JSX attribute / MDX expression defines nothing — the outside reference and the tag stay (hook P1).
    const jsx = '![a][pic]\n\n<Callout note="\n[pic]: /images/blog/x/body-1.webp\n" />';
    expect(AstroPublisher.stripManagedBodyImages(jsx, 'x')).toBe(jsx);
    // A wrapped-alt removal must not shift later lines: a managed definition after it still goes, unrelated prose stays (hook P0).
    const shifted = '![wrapped\nalt][pic]\n\nKeep this prose.\n\n[pic]: /images/blog/x/body-1.webp\nAnd this line too.';
    expect(AstroPublisher.stripManagedBodyImages(shifted, 'x')).toBe('Keep this prose.\n\nAnd this line too.');
  });

  test('refresh lane: the managed-image directory is keyed by the PUBLISHED frontmatter route, not the source file path — a flat file rendering a nested route sweeps the route directory (GH r27)', async () => {
    const heroSrc = '/images/2025/12/shrub-diseases.webp';
    const liveFm = validFrontmatter({ slug: '/pest-control/shrub-diseases-sarasota-fl/', title: 'Shrub Diseases', canonical: 'https://www.wavespestcontrol.com/blog/shrub-diseases-sarasota-fl/', hero_image: { src: heroSrc, alt: 'hero' }, og_image: heroSrc });
    const a1 = '/images/2026/01/hibiscus-detail.webp';
    const a2 = '/images/2026/01/oleander-detail.webp';
    const liveBody = `## Hibiscus\n\nHibiscus prose.\n\n![Hibiscus detail](${a1})\n\n## Oleander\n\nOleander prose.\n\n![Oleander detail](${a2})\n`;
    const liveMd = fmModule.stringify(liveFm, liveBody);
    const heroWebp = await AstroPublisher._internals.compressToWebp(Buffer.from(PATTERNS[4].split(',')[1], 'base64'), { width: 1200 });
    const w = async (i) => (await AstroPublisher._internals.compressToWebp(Buffer.from(PATTERNS[i].split(',')[1], 'base64'), { width: 1200 })).toString('base64');
    const a1Webp = await w(1); const a2Webp = await w(2);
    gh.getFile.mockImplementation(async (path) => {
      if (path === 'src/content/blog/shrub-diseases-sarasota-fl.mdx') return null;
      if (path === 'src/content/blog/shrub-diseases-sarasota-fl.md') return { content: liveMd, sha: 'live' };
      if (path === `public${heroSrc}`) return { content: '', sha: 'h', raw: { content: heroWebp.toString('base64') } };
      if (path === `public${a1}`) return { content: '', sha: 'a1', raw: { content: a1Webp } };
      if (path === `public${a2}`) return { content: '', sha: 'a2', raw: { content: a2Webp } };
      return null;
    });
    gh.listDir.mockResolvedValue([]);
    gh.commitFiles.mockResolvedValue({ commit: { sha: 'multi' } });
    const draft = { type: 'draft', page_url: 'https://www.wavespestcontrol.com/blog/shrub-diseases-sarasota-fl/', frontmatter: {}, body: liveBody.replace('Oleander prose.', 'Oleander prose, refreshed.') };
    const res = await AstroPublisher.publishRefresh(draft, { action_type: 'refresh_existing_page', target_url: draft.page_url });
    expect(res.status).toBe('pr_open');
    // The sweep looked in the ROUTE directory the creating lane files under.
    expect(gh.listDir).toHaveBeenCalledWith('public/images/blog/pest-control/shrub-diseases-sarasota-fl');
  });

  test('refresh lane: a managed-image listing failure propagates as a transient error — no PR on a partial deletion set (GH r25)', async () => {
    const heroSrc = '/images/2025/12/shrub-diseases.webp';
    const liveFm = validFrontmatter({ slug: '/shrub-diseases-sarasota-fl/', title: 'Shrub Diseases', canonical: 'https://www.wavespestcontrol.com/blog/shrub-diseases-sarasota-fl/', hero_image: { src: heroSrc, alt: 'hero' }, og_image: heroSrc });
    const liveBody = '## Hibiscus\n\nHibiscus prose.\n\n## Oleander\n\nOleander prose.\n';
    const liveMd = fmModule.stringify(liveFm, liveBody);
    const heroWebp = await AstroPublisher._internals.compressToWebp(Buffer.from(PATTERNS[4].split(',')[1], 'base64'), { width: 1200 });
    gh.getFile.mockImplementation(async (path) => {
      if (path === 'src/content/blog/shrub-diseases-sarasota-fl.mdx') return null;
      if (path === 'src/content/blog/shrub-diseases-sarasota-fl.md') return { content: liveMd, sha: 'live' };
      if (path === `public${heroSrc}`) return { content: '', sha: 'h', raw: { content: heroWebp.toString('base64') } };
      return null;
    });
    gh.listDir.mockRejectedValue(new Error('GitHub 502'));
    const draft = { type: 'draft', page_url: 'https://www.wavespestcontrol.com/blog/shrub-diseases-sarasota-fl/', frontmatter: {}, body: liveBody.replace('Oleander prose.', 'Oleander prose, refreshed.') };
    let thrown;
    try { await AstroPublisher.publishRefresh(draft, { action_type: 'refresh_existing_page', target_url: draft.page_url }); } catch (err) { thrown = err; }
    expect(thrown?.message).toContain('could not list managed images');
    expect(thrown?.message).toContain('GitHub 502');
    expect(thrown?.code).toBeUndefined(); // transient, not BLOG_BODY_IMAGES_FAILED
    expect(gh.createPr).not.toHaveBeenCalled();
  });

  test('refresh lane: stale managed assets ABOVE the first free name are swept from the directory listing (GH r23)', async () => {
    const heroSrc = '/images/2025/12/shrub-diseases.webp';
    const liveFm = validFrontmatter({ slug: '/shrub-diseases-sarasota-fl/', title: 'Shrub Diseases', canonical: 'https://www.wavespestcontrol.com/blog/shrub-diseases-sarasota-fl/', hero_image: { src: heroSrc, alt: 'hero' }, og_image: heroSrc });
    const liveBody = '## Hibiscus\n\nHibiscus prose.\n\n## Oleander\n\nOleander prose.\n';
    const liveMd = fmModule.stringify(liveFm, liveBody);
    const heroWebp = await AstroPublisher._internals.compressToWebp(Buffer.from(PATTERNS[4].split(',')[1], 'base64'), { width: 1200 });
    gh.getFile.mockImplementation(async (path) => {
      if (path === 'src/content/blog/shrub-diseases-sarasota-fl.mdx') return null;
      if (path === 'src/content/blog/shrub-diseases-sarasota-fl.md') return { content: liveMd, sha: 'live' };
      if (path === `public${heroSrc}`) return { content: '', sha: 'h', raw: { content: heroWebp.toString('base64') } };
      if (path === 'public/images/blog/shrub-diseases-sarasota-fl/body-3.webp') return { content: '', sha: 'stale3' };
      return null; // body-1/body-2 free by name probe…
    });
    // …but the directory still holds a stale body-3 nobody references.
    gh.listDir.mockResolvedValue([{ type: 'file', name: 'body-3.webp', path: 'public/images/blog/shrub-diseases-sarasota-fl/body-3.webp', sha: 'stale3' }]);
    gh.commitFiles.mockResolvedValue({ commit: { sha: 'multi' } });
    const draft = { type: 'draft', page_url: 'https://www.wavespestcontrol.com/blog/shrub-diseases-sarasota-fl/', frontmatter: {}, body: liveBody.replace('Oleander prose.', 'Oleander prose, refreshed.') };
    const res = await AstroPublisher.publishRefresh(draft, { action_type: 'refresh_existing_page', target_url: draft.page_url });
    expect(res.status).toBe('pr_open');
    const call = gh.commitFiles.mock.calls[0][0];
    expect(call.files.map((f) => f.path)).toEqual(['public/images/blog/shrub-diseases-sarasota-fl/body-1.webp', 'public/images/blog/shrub-diseases-sarasota-fl/body-2.webp', 'src/content/blog/shrub-diseases-sarasota-fl.md']);
    expect(call.deletes).toEqual(['public/images/blog/shrub-diseases-sarasota-fl/body-3.webp']);
    expect(gh.getFile).toHaveBeenCalledWith('public/images/blog/shrub-diseases-sarasota-fl/body-3.webp', expect.stringMatching(/^content\/refresh-/));
  });

  test('bodyImageRefs: an angle-bracket destination keeps its parentheses; an escaped-bracket reference label resolves (GH r15)', () => {
    const refs = AstroPublisher._internals.bodyImageRefs('![a](</images/blog/x/a.webp)variant>)\n![detail][body\\]shot]\n\n[body\\]shot]: /images/blog/x/body-1.webp');
    expect(refs.map((r) => r.src)).toEqual(['/images/blog/x/a.webp)variant', '/images/blog/x/body-1.webp']);
  });

  test('refresh lane: an unchanged draft is NOT a no-op while the live blog body is short of its images — the refresh backfills them; a non-blog unchanged draft stays no_changes (GH r15)', async () => {
    const heroSrc = '/images/2025/12/shrub-diseases.webp';
    const liveFm = validFrontmatter({ slug: '/shrub-diseases-sarasota-fl/', title: 'Shrub Diseases', canonical: 'https://www.wavespestcontrol.com/blog/shrub-diseases-sarasota-fl/', hero_image: { src: heroSrc, alt: 'hero' }, og_image: heroSrc });
    const liveBody = `![shrub diseases](${heroSrc})\n\n## Hibiscus\n\nHibiscus prose.\n\n## Oleander\n\nOleander prose.\n`;
    const liveMd = fmModule.stringify(liveFm, liveBody);
    const heroWebp = await AstroPublisher._internals.compressToWebp(Buffer.from(PATTERNS[4].split(',')[1], 'base64'), { width: 1200 });
    gh.getFile.mockImplementation(async (path) => {
      if (path === 'src/content/blog/shrub-diseases-sarasota-fl.mdx') return null;
      if (path === 'src/content/blog/shrub-diseases-sarasota-fl.md') return { content: liveMd, sha: 'live' };
      if (path === `public${heroSrc}`) return { content: '', sha: 'h', raw: { content: heroWebp.toString('base64') } };
      if (path === 'src/content/services/pest-control-venice-fl.md') return { content: '---\ntitle: S\nmeta_description: d\n---\nService body.', sha: 's' };
      return null;
    });
    gh.commitFiles.mockResolvedValue({ commit: { sha: 'multi' } });
    // Identical body + meta: previously no_changes; under the gate the image-poor post gets its two pictures.
    const draft = { type: 'draft', page_url: 'https://www.wavespestcontrol.com/blog/shrub-diseases-sarasota-fl/', frontmatter: {}, body: liveBody };
    const res = await AstroPublisher.publishRefresh(draft, { action_type: 'refresh_existing_page', target_url: draft.page_url });
    expect(res.status).toBe('pr_open');
    expect(gh.commitFiles.mock.calls[0][0].files.map((f) => f.path)).toEqual([
      'public/images/blog/shrub-diseases-sarasota-fl/body-1.webp',
      'public/images/blog/shrub-diseases-sarasota-fl/body-2.webp',
      'src/content/blog/shrub-diseases-sarasota-fl.md',
    ]);
    // A live post whose two body paths hold the SAME picture (or a missing asset) is short of the contract too (hook P1):
    // the unchanged refresh runs — and parks, because the draft body carries the invalid pictures.
    const dupBody = `## Hibiscus\n\nHibiscus prose.\n\n![p](/images/blog/shrub-diseases-sarasota-fl/body-1.webp)\n\n## Oleander\n\nOleander prose.\n\n![q](/images/blog/shrub-diseases-sarasota-fl/body-2.webp)\n`;
    const dupMd = fmModule.stringify(liveFm, dupBody);
    const same = (await AstroPublisher._internals.compressToWebp(Buffer.from(PATTERNS[1].split(',')[1], 'base64'), { width: 1200 })).toString('base64');
    gh.getFile.mockImplementation(async (path) => {
      if (path === 'src/content/blog/shrub-diseases-sarasota-fl.mdx') return null;
      if (path === 'src/content/blog/shrub-diseases-sarasota-fl.md') return { content: dupMd, sha: 'live' };
      if (path === `public${heroSrc}`) return { content: '', sha: 'h', raw: { content: heroWebp.toString('base64') } };
      if (/shrub-diseases-sarasota-fl\/body-[12]\.webp$/.test(path)) return { content: '', sha: 'same', raw: { content: same } };
      if (path === 'src/content/services/pest-control-venice-fl.md') return { content: '---\ntitle: S\nmeta_description: d\n---\nService body.', sha: 's' };
      return null;
    });
    let thrown;
    try { await AstroPublisher.publishRefresh({ ...draft, body: dupBody }, { action_type: 'refresh_existing_page', target_url: draft.page_url }); } catch (err) { thrown = err; }
    expect(thrown?.code).toBe('BLOG_BODY_IMAGES_FAILED');
    expect(thrown.message).toMatch(/near-duplicate/);
    // Non-blog target, identical → still a no-op.
    const svc = await AstroPublisher.publishRefresh({ type: 'draft', page_url: 'https://www.wavespestcontrol.com/pest-control-venice-fl/', frontmatter: {}, body: 'Service body.' }, { action_type: 'refresh_existing_page', target_url: 'https://www.wavespestcontrol.com/pest-control-venice-fl/' });
    expect(svc.status).toBe('no_changes');
  });

  test('bodyImageRefs: an angle-bracket destination is normalized to the enclosed path (spaces allowed); validateBodyImageRefs accepts it when committed (GH r10)', async () => {
    const refs = AstroPublisher._internals.bodyImageRefs('![detail](</images/blog/foo/body-1.webp>)\n![spaced](</images/blog/foo/body 2.webp> "t")\n![plain](/images/blog/foo/body-3.webp)');
    expect(refs.map((r) => r.src)).toEqual(['/images/blog/foo/body-1.webp', '/images/blog/foo/body 2.webp', '/images/blog/foo/body-3.webp']);
    const getFile = async (path) => (path === 'public/images/blog/foo/body-1.webp' || path === 'public/images/blog/foo/body-3.webp' ? { content: 'x' } : null);
    expect(await AstroPublisher._internals.validateBodyImageRefs({ body: '![a](</images/blog/foo/body-1.webp>)\n\n![b](/images/blog/foo/body-3.webp)', heroSrc: '/images/blog/foo/hero.webp', getFile })).toMatchObject({ ok: true, distinct: 2 });
  });

  test('validateBodyImageRefs: an authored image with empty alt text fails closed — it never counts toward the minimum (GH r10)', async () => {
    const getFile = async () => ({ content: 'x' });
    for (const body of ['![](/images/blog/foo/body-1.webp)\n\n![b](/images/blog/foo/body-2.webp)', '![   ](/images/blog/foo/body-1.webp)\n\n![b](/images/blog/foo/body-2.webp)', '![][r]\n\n![b](/images/blog/foo/body-2.webp)\n\n[r]: /images/blog/foo/body-1.webp']) {
      const res = await AstroPublisher._internals.validateBodyImageRefs({ body, heroSrc: '/images/blog/foo/hero.webp', getFile });
      expect(res.ok).toBe(false);
      expect(res.reason).toMatch(/has no alt text/);
      expect(res.reason).toContain('/images/blog/foo/body-1.webp');
    }
    expect(await AstroPublisher._internals.validateBodyImageRefs({ body: '![a](/images/blog/foo/body-1.webp)\n\n![b](/images/blog/foo/body-2.webp)', heroSrc: '/images/blog/foo/hero.webp', getFile })).toMatchObject({ ok: true, distinct: 2 });
  });

  test('validateBodyImageRefs: a reference-style image is validated like an inline one — hero via reference fails, uncommitted via reference fails, committed counts (GH r9)', async () => {
    const { validateBodyImageRefs } = AstroPublisher._internals;
    const heroSrc = '/images/blog/x/hero.webp';
    const getFile = async (path) => (path === 'public/images/blog/x/body-1.webp' || path === 'public/images/blog/x/body-2.webp' ? { content: 'x' } : null);
    const viaRef = (label, dest) => `## A\n\n![p][${label}]\n\n![q](/images/blog/x/body-2.webp)\n\n[${label}]: ${dest}\n`;
    expect((await validateBodyImageRefs({ body: viaRef('h', heroSrc), heroSrc, getFile })).reason).toMatch(/embeds the hero image/);
    expect((await validateBodyImageRefs({ body: viaRef('r', 'https://example.com/pic.jpg'), heroSrc, getFile })).reason).toMatch(/not committed/);
    expect((await validateBodyImageRefs({ body: viaRef('m', '/images/blog/x/missing.webp'), heroSrc, getFile })).reason).toMatch(/not committed/);
    expect(await validateBodyImageRefs({ body: viaRef('ok', '/images/blog/x/body-1.webp'), heroSrc, getFile })).toMatchObject({ ok: true, distinct: 2 });
  });

  test('bodyImageSlots: top-level H2s and paragraphs with 1–3 leading spaces are still top-level; real list children are not (GH r9)', () => {
    const body = [
      '  ## Indented heading', '', '   Indented prose, still a paragraph.', '',
      '## Plain', '', 'Plain prose.', '',
      '- item', '  ## Nested heading', '', '  Nested prose under the item.', '',
      ' ## After list', '', ' After prose.',
    ].join('\n');
    const { sections } = AstroPublisher._internals.scanBodySections(body, { title: 'T' });
    expect(sections.filter((sec) => !sec.intro).map((sec) => sec.heading)).toEqual(['Indented heading', 'Plain', 'After list']);
    const slots = bodyImageSlots(body, 3, { title: 'T' });
    const lines = body.split('\n');
    expect(slots.map((sl) => lines[sl.insertAt - 1])).toEqual(['   Indented prose, still a paragraph.', 'Plain prose.', ' After prose.']);
  });

  test('bodyImageSlots: setext headings are sections — a `---` underline opens an H2 with its own slot, `===` is an H1 that closes the range; an underline under list/quoted text is not a setext heading (hook P1)', () => {
    const body = [
      'Intro prose.', '',
      'Setext Two', '---', '', 'Two prose.', '',
      'Setext One', '===', '', 'After-H1 prose.', '',
      '## ATX', '', 'ATX prose.', '',
      '- item', '  ---', '', 'Tail prose.',
    ].join('\n');
    const lines = body.split('\n');
    const { sections } = AstroPublisher._internals.scanBodySections(body, { title: 'T' });
    expect(sections.map((sec) => [sec.heading, !!sec.sub, sec.lastProse == null ? null : lines[sec.lastProse - 1]])).toEqual([
      ['T', false, 'Intro prose.'],
      ['Setext Two', false, 'Two prose.'],
      ['Setext Two', true, 'After-H1 prose.'],
      ['ATX', false, 'Tail prose.'],
    ]);
    expect(bodyImageSlots(body, 2, { title: 'T' }).map((sl) => sl.heading)).toEqual(['Setext Two', 'ATX']);
  });

  test('bodyImageSlots: thematic breaks are dividers, never prose — the slot stays above the break, a divider-only section is ineligible, "- - -" is not a list; a setext underline makes heading text, not prose (GH r9)', () => {
    const body = [
      '## A', '', 'A prose.', '', '---', '',
      '## Only divider', '', '***', '',
      '## B', '', 'B prose.', '- - -', '',
      '## C', '', 'Setext-looking text', '---', '',
      '## D', '', 'D prose.', '', '___',
    ].join('\n');
    const lines = body.split('\n');
    const { sections } = AstroPublisher._internals.scanBodySections(body, { title: 'T' });
    const byHeading = Object.fromEntries(sections.filter((sec) => !sec.intro).map((sec) => [sec.heading, sec.lastProse == null ? null : lines[sec.lastProse - 1]]));
    expect(byHeading).toEqual({ A: 'A prose.', 'Only divider': null, B: 'B prose.', C: null, 'Setext-looking text': null, D: 'D prose.' });
    const slots = bodyImageSlots(body, 3, { title: 'T' });
    expect(slots.map((sl) => sl.heading)).toEqual(['A', 'B', 'D']);
    // Insertion lands ABOVE the divider, inside the section.
    const out = insertBodyImages(body, slots.map((sl, i) => ({ ...sl, src: `/images/blog/x/body-${i + 1}.webp`, alt: sl.heading })));
    expect(out).toContain('A prose.\n\n![A](/images/blog/x/body-1.webp)\n\n---');
    expect(out).toContain('B prose.\n\n![B](/images/blog/x/body-2.webp)\n\n- - -');
  });

  test('bodyImageRefs: a destination with balanced parentheses is captured whole; a title after whitespace is ignored (GH r2)', () => {
    const refs = AstroPublisher._internals.bodyImageRefs('![d](/images/blog/foo/body-(detail).webp)\n![t](/images/2026/08/a.webp "Title (x)")');
    expect(refs.map((r) => r.src)).toEqual(['/images/blog/foo/body-(detail).webp', '/images/2026/08/a.webp']);
  });

  test('bodyImageRefs: comments, JSX comments, code spans and escaped syntax are not images; an escaped backslash before ! still renders (GH r1)', () => {
    const body = [
      '![real](/images/2026/08/a.webp)',
      '<!-- ![hidden](/images/2026/08/b.webp) -->',
      '{/* ![jsx](/images/2026/08/c.webp) */}',
      '`![span](/images/2026/08/d.webp)`',
      '\\![escaped](/images/2026/08/e.webp)',
      '\\\\![double-escaped renders](/images/2026/08/f.webp)',
    ].join('\n');
    expect(AstroPublisher._internals.bodyImageRefs(body).map((r) => r.src)).toEqual(['/images/2026/08/a.webp', '/images/2026/08/f.webp']);
    // The section scanner sees the same thing: a commented-out image does not mark a section illustrated.
    const slots = bodyImageSlots('## A\n\nProse.\n\n<!-- ![x](/i.webp) -->\n', 1);
    expect(slots.map((sl) => sl.heading)).toEqual(['A']);
  });

  test('fail-closed: a draft that embeds the HERO in its body parks — the hero never counts as a body image (GH r1)', async () => {
    gh.getFile.mockImplementation(async (path) => (path.startsWith('public/images/blog/pest-control/drywood-frass-venice/') ? { content: 'x', sha: 'h' } : null));
    let thrown;
    try {
      await AstroPublisher.publishOrUpdatePage(draft(`${article}\n\n![hero again](/images/blog/pest-control/drywood-frass-venice/hero.webp)\n`), { action_type: 'new_supporting_blog' });
    } catch (err) { thrown = err; }
    expect(thrown?.code).toBe('BLOG_BODY_IMAGES_FAILED');
    expect(thrown.message).toContain('embeds the hero image');
    expect(gh.createBranch).not.toHaveBeenCalled();
  });

  test('fail-closed: a draft image ref that is NOT committed (invented path / remote URL) parks instead of shipping a broken image (hook r2)', async () => {
    gh.getFile.mockResolvedValue(null);
    for (const ref of ['/images/2026/08/made-up.webp', 'https://example.com/pic.jpg']) {
      let thrown;
      try { await AstroPublisher.publishOrUpdatePage(draft(`${article}\n\n![x](${ref})\n`), { action_type: 'new_supporting_blog' }); } catch (err) { thrown = err; }
      expect(thrown?.code).toBe('BLOG_BODY_IMAGES_FAILED');
      expect(thrown.message).toContain(ref);
    }
    expect(gh.createBranch).not.toHaveBeenCalled();
  });

  test('fail-closed: body image generation failure throws with the provider chain before any branch is cut — a retryable provider failure stays TRANSIENT (no code), a non-retryable one is BLOG_BODY_IMAGES_FAILED (hook P1)', async () => {
    gh.getFile.mockResolvedValue(null);
    heroImageGenerator.generate.mockImplementation(async ({ mode }) => {
      if (mode === 'blog-hero') return { dataUrl: PATTERNS[0], model: 'm' };
      const err = new Error('image-generator: all providers failed');
      err.attempts = [{ provider: 'gpt-image-2', result: { retryable: true, status: 503 } }];
      throw err;
    });
    let thrown;
    try { await AstroPublisher.publishOrUpdatePage(draft(), { action_type: 'new_supporting_blog' }); } catch (err) { thrown = err; }
    expect(thrown?.code).toBeUndefined();
    expect(thrown.message).toContain('"Reading the pellets"');
    expect(thrown.message).toContain('gpt-image-2');
    expect(gh.createBranch).not.toHaveBeenCalled();
    expect(gh.commitFiles).not.toHaveBeenCalled();
    heroImageGenerator.generate.mockImplementation(async ({ mode }) => {
      if (mode === 'blog-hero') return { dataUrl: PATTERNS[0], model: 'm' };
      const err = new Error('image-generator: all providers failed');
      err.attempts = [{ provider: 'gpt-image-2', result: { retryable: false, status: 400 } }];
      throw err;
    });
    thrown = undefined;
    try { await AstroPublisher.publishOrUpdatePage(draft(), { action_type: 'new_supporting_blog' }); } catch (err) { thrown = err; }
    expect(thrown?.code).toBe('BLOG_BODY_IMAGES_FAILED');
    expect(gh.createBranch).not.toHaveBeenCalled();
  });

  test('variation: a generated body image must also differ from a DRAFT-authored committed image (hook r9)', async () => {
    // The committed file is what a publish commits: the WebP-compressed bytes.
    const committedWebp = await AstroPublisher._internals.compressToWebp(Buffer.from(PATTERNS[1].split(',')[1], 'base64'), { width: 1200 });
    gh.getFile.mockImplementation(async (path) => (path === 'public/images/2026/08/a.webp' ? { content: '', sha: 'a', raw: { content: committedWebp.toString('base64') } } : null));
    // hero = P0; body first try = P1 (same picture as the draft's a.webp) → regenerate → P2.
    const sequence = [PATTERNS[0], PATTERNS[1], PATTERNS[2]];
    let call = 0;
    heroImageGenerator.generate.mockImplementation(async ({ mode }) => ({ dataUrl: sequence[call++], model: 'm', alt: mode === 'blog-body' ? 'b' : 'h', attempts: [] }));
    await AstroPublisher.publishOrUpdatePage(draft(`${article}\n\n![a](/images/2026/08/a.webp)\n`), { action_type: 'new_supporting_blog' });
    const bodyCalls = heroImageGenerator.generate.mock.calls.filter(([a]) => a.mode === 'blog-body');
    expect(bodyCalls.map(([a]) => a.shot)).toEqual(['close-up', 'action']);
    expect(gh.commitFiles.mock.calls[0][0].files.map((f) => f.path)).toContain('public/images/blog/pest-control/drywood-frass-venice/body-1.webp');
  });

  test('variation: two draft-authored refs holding the SAME picture, or a draft image repeating the hero, park even when the count is met (hook r11)', async () => {
    const committedWebp = await AstroPublisher._internals.compressToWebp(Buffer.from(PATTERNS[1].split(',')[1], 'base64'), { width: 1200 });
    gh.getFile.mockImplementation(async (path) => (path.startsWith('public/images/2026/08/') ? { content: '', sha: 'x', raw: { content: committedWebp.toString('base64') } } : null));
    let thrown;
    try {
      await AstroPublisher.publishOrUpdatePage(draft(`${article}\n\n![a](/images/2026/08/a.webp)\n\n![b](/images/2026/08/b.webp)\n`), { action_type: 'new_supporting_blog' });
    } catch (err) { thrown = err; }
    expect(thrown?.code).toBe('BLOG_BODY_IMAGES_FAILED');
    expect(thrown.message).toMatch(/b\.webp, a near-duplicate of \/images\/2026\/08\/a\.webp/);
    expect(gh.createBranch).not.toHaveBeenCalled();

    // Draft image = the freshly generated hero's picture → parks too.
    jest.clearAllMocks();
    const heroWebp = await AstroPublisher._internals.compressToWebp(Buffer.from(PATTERNS[0].split(',')[1], 'base64'), { width: 1200 });
    gh.getFile.mockImplementation(async (path) => (path === 'public/images/2026/08/h.webp' ? { content: '', sha: 'x', raw: { content: heroWebp.toString('base64') } } : null));
    heroImageGenerator.generate.mockImplementation(async ({ mode }) => ({ dataUrl: PATTERNS[0], model: 'm', alt: mode === 'blog-body' ? 'b' : 'h', attempts: [] }));
    thrown = null;
    try {
      await AstroPublisher.publishOrUpdatePage(draft(`${article}\n\n![h](/images/2026/08/h.webp)\n`), { action_type: 'new_supporting_blog' });
    } catch (err) { thrown = err; }
    expect(thrown?.code).toBe('BLOG_BODY_IMAGES_FAILED');
    expect(thrown.message).toMatch(/near-duplicate of hero/);
  });

  test('fail-closed: unreadable bytes for a reused hero or a draft image park — an unverifiable picture never passes the distinctness check (hook r12)', async () => {
    // Reused hero (committed, but the contents API returned no bytes).
    const liveMd = fmModule.stringify(
      { ...draft().frontmatter, slug: '/pest-control/drywood-frass-venice/', hero_image: { src: '/images/blog/pest-control/drywood-frass-venice/hero.webp', alt: 'live hero' }, og_image: '/images/blog/pest-control/drywood-frass-venice/hero.webp' },
      'Old body.\n',
    );
    gh.getFile.mockImplementation(async (path) => {
      if (path === 'src/content/blog/pest-control/drywood-frass-venice.mdx') return { content: liveMd, sha: 'live-sha' };
      if (path === 'public/images/blog/pest-control/drywood-frass-venice/hero.webp') return { content: '', sha: 'h' };
      return null;
    });
    let thrown;
    try { await AstroPublisher.publishOrUpdatePage(draft(), { action_type: 'new_supporting_blog' }); } catch (err) { thrown = err; }
    expect(thrown?.code).toBe('BLOG_BODY_IMAGES_FAILED');
    expect(thrown.message).toMatch(/hero bytes unavailable/);

    // Draft image committed (path exists) but bytes unreadable.
    jest.clearAllMocks();
    gh.getFile.mockImplementation(async (path) => (path === 'public/images/2026/08/a.webp' ? { content: '', sha: 'a' } : null));
    thrown = null;
    try { await AstroPublisher.publishOrUpdatePage(draft(`${article}\n\n![a](/images/2026/08/a.webp)\n`), { action_type: 'new_supporting_blog' }); } catch (err) { thrown = err; }
    expect(thrown?.code).toBe('BLOG_BODY_IMAGES_FAILED');
    expect(thrown.message).toMatch(/bytes cannot be read/);
    expect(gh.createBranch).not.toHaveBeenCalled();
  });

  test('imageDHash: identical pictures hash identically, different patterns are far apart, recompression is tolerated', async () => {
    const { imageDHash, hammingDistance, NEAR_DUPLICATE_MAX_DISTANCE } = AstroPublisher._internals;
    const toBuf = (dataUrl) => Buffer.from(dataUrl.split(',')[1], 'base64');
    const a = await imageDHash(toBuf(PATTERNS[0]));
    const b = await imageDHash(toBuf(PATTERNS[1]));
    expect(hammingDistance(a, await imageDHash(toBuf(PATTERNS[0])))).toBe(0);
    expect(hammingDistance(a, b)).toBeGreaterThan(NEAR_DUPLICATE_MAX_DISTANCE);
    // Recompression/resizing of a photo-like (smooth) image keeps it a duplicate.
    const sharp = require('sharp');
    const w = 96; const h = 64; const raw = Buffer.alloc(w * h * 3);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 3; raw[i] = (x * 255) / w; raw[i + 1] = (y * 255) / h; raw[i + 2] = ((x + y) * 128) / (w + h); }
    const photo = await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
    const recompressed = await AstroPublisher._internals.compressToWebp(photo, { width: 48 });
    expect(hammingDistance(await imageDHash(photo), await imageDHash(recompressed))).toBeLessThanOrEqual(NEAR_DUPLICATE_MAX_DISTANCE);
  });

  test('variation: a body image that is a near-duplicate of the hero is regenerated once with the next framing; a still-duplicate sibling parks', async () => {
    gh.getFile.mockResolvedValue(null);
    // hero = P0; body-1 first try = P0 (dup of hero) → regenerate → P1; body-2 = P2.
    const sequence = [PATTERNS[0], PATTERNS[0], PATTERNS[1], PATTERNS[2]];
    let call = 0;
    heroImageGenerator.generate.mockImplementation(async ({ mode, keyword }) => ({ dataUrl: sequence[call++], model: 'm', alt: mode === 'blog-body' ? `Alt ${keyword}` : 'hero', attempts: [] }));
    await AstroPublisher.publishOrUpdatePage(draft(), { action_type: 'new_supporting_blog' });
    const bodyCalls = heroImageGenerator.generate.mock.calls.filter(([a]) => a.mode === 'blog-body');
    expect(bodyCalls.map(([a]) => a.shot)).toEqual(['close-up', 'action', 'action']);
    expect(gh.commitFiles.mock.calls[0][0].files.map((f) => f.path)).toContain('public/images/blog/pest-control/drywood-frass-venice/body-2.webp');

    // Same picture every time → after one regeneration the run parks.
    jest.clearAllMocks();
    gh.getFile.mockResolvedValue(null);
    gh.createPr.mockResolvedValue({ number: 202, html_url: 'x' });
    heroImageGenerator.generate.mockImplementation(async () => ({ dataUrl: PATTERNS[3], model: 'm', alt: 'same', attempts: [] }));
    let thrown;
    try { await AstroPublisher.publishOrUpdatePage(draft(), { action_type: 'new_supporting_blog' }); } catch (err) { thrown = err; }
    expect(thrown?.code).toBe('BLOG_BODY_IMAGES_FAILED');
    expect(thrown.message).toMatch(/near-duplicate of hero even after regenerating/);
    expect(gh.createBranch).not.toHaveBeenCalled();
  });

  test('fail-closed: too few prose sections to place the images parks instead of publishing short', async () => {
    gh.getFile.mockResolvedValue(null);
    let thrown;
    try { await AstroPublisher.publishOrUpdatePage(draft('![only](/images/x.webp)\n\n- a list\n- only'), { action_type: 'new_supporting_blog' }); } catch (err) { thrown = err; }
    expect(thrown?.code).toBe('BLOG_BODY_IMAGES_FAILED');
    expect(gh.createBranch).not.toHaveBeenCalled();
  });

  test('bodyImageRefs: a reference definition that OPENS a list item (`- [pic]: …`) defines its label — the reference image renders and is validated (GH r24)', () => {
    const body = '- Intro\n- [pic]: /images/blog/x/body-1.webp\n\n![Pellets][pic]\n\n1. [one]: /images/blog/x/body-2.webp\n\n![Sill][one]';
    expect(AstroPublisher._internals.bodyImageRefs(body).map((r) => [r.alt, r.src])).toEqual([['Pellets', '/images/blog/x/body-1.webp'], ['Sill', '/images/blog/x/body-2.webp']]);
    // A continuation line inside the item is paragraph text — no definition, no image.
    expect(AstroPublisher._internals.bodyImageRefs('- item\n  [pic]: /images/blog/x/body-1.webp\n\n![a][pic]')).toEqual([]);
  });

  test('bodyImageRefs: HTML character references in a destination are decoded before percent-decoding — inline and reference forms probe the path the browser requests (GH r24)', () => {
    const { bodyImageRefs } = AstroPublisher._internals;
    const body = '![Detail](/images/blog/x/body&amp;detail.webp)\n\n[ref]: /images/blog/x/sill&#x2F;close%20up.webp\n\n![Sill][ref]\n\n![Literal](/images/blog/x/no&bogus;entity&amp.webp)';
    expect(bodyImageRefs(body).map((r) => r.src)).toEqual([
      '/images/blog/x/body&detail.webp',
      '/images/blog/x/sill/close up.webp',
      // An unknown or unterminated reference is literal text (CommonMark: `;` mandatory).
      '/images/blog/x/no&bogus;entity&amp.webp',
    ]);
  });

  test('bodyImageRefs: a legacy .md renders CommonMark HTML blocks as raw text — Markdown images inside them do not count; .mdx parses JSX children as Markdown and they do (GH r24)', () => {
    const { bodyImageRefs, blankMarkdownHtmlBlocks } = AstroPublisher._internals;
    const body = [
      '<div>![a](/images/blog/x/body-1.webp)</div>', '',            // type 6, one line
      '<figure>', '![b](/images/blog/x/body-2.webp)', '',           // type 6, runs to the blank line
      '![c](/images/blog/x/body-3.webp)', '',                        // after the blank → rendered
      '<span>', '![d](/images/blog/x/body-4.webp)', '</span>', '',  // type 7 (complete tag alone, after a blank)
      'Prose <span>![e](/images/blog/x/body-5.webp)</span>', '',    // inline HTML inside a paragraph → rendered
      'Prose', '<span>', '![f](/images/blog/x/body-6.webp)', '',    // type 7 cannot interrupt a paragraph → rendered
      '<script>', 'const s = "![g](/images/blog/x/body-7.webp)";', '</script>', '', // type 1 runs to its closing tag
      '<div>', '', '![h](/images/blog/x/body-8.webp)',              // block ends at the blank line → rendered
    ].join('\n');
    expect(bodyImageRefs(body).map((r) => r.src)).toEqual([1, 2, 3, 4, 5, 6, 8].map((n) => `/images/blog/x/body-${n}.webp`));
    expect(bodyImageRefs(body, { mdx: false }).map((r) => r.src)).toEqual([3, 5, 6, 8].map((n) => `/images/blog/x/body-${n}.webp`));
    // Newline-preserving so line indices still address the original text.
    expect(blankMarkdownHtmlBlocks(body).split('\n')).toHaveLength(body.split('\n').length);
    // A reference definition inside an HTML block defines nothing in .md.
    expect(bodyImageRefs('<div>\n[pic]: /images/blog/x/body-1.webp\n\n![a][pic]', { mdx: false })).toEqual([]);
  });

  test('bodyImageRefs: .md raw HTML block types 3/4/5 (processing instruction, declaration, CDATA) hide the Markdown inside them; .mdx does not use HTML blocks (GH r26)', () => {
    const { bodyImageRefs } = AstroPublisher._internals;
    const body = '<?x\n![pi](/images/blog/x/body-1.webp)\n?>\n\n<![CDATA[\n![cd](/images/blog/x/body-2.webp)\n]]>\n\n<!DECL\n![decl](/images/blog/x/body-3.webp)\nattr>\n\n![real](/images/blog/x/body-4.webp)';
    expect(bodyImageRefs(body, { mdx: false }).map((r) => r.alt)).toEqual(['real']);
    // A same-line close ends the block on its own line.
    expect(bodyImageRefs('<?x ?>\n\n![a](/images/blog/x/body-1.webp)', { mdx: false }).map((r) => r.alt)).toEqual(['a']);
  });

  test('bodyImageRefs: ENTERING a would-be list inside an active raw HTML block is raw text — only the OPENING container ending terminates it (#3593 r2)', () => {
    const { bodyImageRefs } = AstroPublisher._internals;
    // No blank line: the list-looking line is raw text inside the div block.
    const body = '<div>\n- ![literal](/images/blog/x/body-1.webp)\n</div>\n\n![real](/images/blog/x/body-2.webp)';
    expect(bodyImageRefs(body, { mdx: false }).map((r) => r.alt)).toEqual(['real']);
    // Leaving the opening quote still terminates (regression from GH r30).
    const quote = '> <div>\n> ![in](/images/blog/x/body-1.webp)\n![out](/images/blog/x/body-2.webp)';
    expect(bodyImageRefs(quote, { mdx: false }).map((r) => r.alt)).toEqual(['out']);
  });

  test('bodyImageRefs: an INDENTED marker at content depth stays inside an active raw HTML block; only a sibling/outer marker terminates it (#3593 r1)', () => {
    const { bodyImageRefs } = AstroPublisher._internals;
    const body = '- <div>\n  - nested ![in](/images/blog/x/body-1.webp)\n  ![in2](/images/blog/x/body-2.webp)\n- ![next](/images/blog/x/body-3.webp)';
    expect(bodyImageRefs(body, { mdx: false }).map((r) => r.alt)).toEqual(['next']);
  });

  test('bodyImageRefs: leaving a container (or a sibling list item) TERMINATES an active raw HTML block in .md — the image outside renders (GH r30)', () => {
    const { bodyImageRefs } = AstroPublisher._internals;
    // The div opens inside the quote; the unquoted line leaves the quote —
    // the block ends there and the image renders.
    const quote = '> <div>\n> ![in](/images/blog/x/body-1.webp)\n![out](/images/blog/x/body-2.webp)';
    expect(bodyImageRefs(quote, { mdx: false }).map((r) => r.alt)).toEqual(['out']);
    // A sibling list item ends the block opened by the previous item.
    const list = '- <div>\n  ![in](/images/blog/x/body-1.webp)\n- ![next](/images/blog/x/body-2.webp)';
    expect(bodyImageRefs(list, { mdx: false }).map((r) => r.alt)).toEqual(['next']);
  });

  test('bodyImageRefs: entering a blockquote or list item is a block boundary in .md — `Intro` then `> <span>` opens a raw HTML block inside the quote (GH r29)', () => {
    const { bodyImageRefs } = AstroPublisher._internals;
    const body = 'Intro prose.\n> <span>\n> ![q](/images/blog/x/body-1.webp)\n> </span>\n\n![real](/images/blog/x/body-2.webp)';
    expect(bodyImageRefs(body, { mdx: false }).map((r) => r.alt)).toEqual(['real']);
    expect(bodyImageRefs(body, { mdx: true }).map((r) => r.alt)).toEqual(['q', 'real']);
  });

  test('bodyImageRefs: a type-7 HTML block opens at any BLOCK BOUNDARY in .md — directly after a heading, not only after a blank line (hook P1)', () => {
    const { bodyImageRefs } = AstroPublisher._internals;
    const body = '## H\n<span>\n![h7](/images/blog/x/body-1.webp)\n</span>\n\n![real](/images/blog/x/body-2.webp)';
    expect(bodyImageRefs(body, { mdx: false }).map((r) => r.alt)).toEqual(['real']);
    // …but a type-7 opener cannot interrupt a PARAGRAPH: the span line is
    // paragraph text and the image renders.
    const para = 'Prose line.\n<span>\n![kept](/images/blog/x/body-3.webp)';
    expect(bodyImageRefs(para, { mdx: false }).map((r) => r.alt)).toEqual(['kept']);
  });

  test('bodyImageRefs: a LIST ITEM may open a raw HTML block in .md (`- <div>`) — images inside it are literal text (GH r28)', () => {
    const { bodyImageRefs } = AstroPublisher._internals;
    const body = '- <div>\n  ![li](/images/blog/x/body-9.webp)\n</div>\n\n![real](/images/blog/x/body-1.webp)';
    expect(bodyImageRefs(body, { mdx: false }).map((r) => r.alt)).toEqual(['real']);
    expect(bodyImageRefs(body, { mdx: true }).map((r) => r.alt)).toEqual(['li', 'real']);
  });

  test('validateBodyImageRefs: a reference into ANOTHER post\'s managed namespace fails; the post\'s own namespace passes (GH r28)', async () => {
    const { validateBodyImageRefs } = AstroPublisher._internals;
    const getFile = async () => ({ sha: 'x' });
    const body = '![Borrowed](/images/blog/other-post/body-1.webp)\n\n![Fine](/images/2026/01/authored.webp)';
    const cross = await validateBodyImageRefs({ body, getFile, slug: 'pest-control/my-post' });
    expect(cross.ok).toBe(false);
    expect(cross.reason).toMatch(/another post's generated image/);
    const own = await validateBodyImageRefs({ body, getFile, slug: 'other-post' });
    expect(own.ok).toBe(true);
    // No slug provided → the namespace rule is not applied (callers without one).
    expect((await validateBodyImageRefs({ body, getFile })).ok).toBe(true);
  });

  test('resolveBodyImages: a RETAINED managed reference whose draft section no longer matches the live context is stripped and swept — it never ships under rewritten prose (GH r28)', async () => {
    // The suite's beforeEach already enables blogBodyImages.
    {
      const { resolveBodyImages, compressToWebp } = AstroPublisher._internals;
      const managedSrc = '/images/blog/pest-control/my-post/body-1.webp';
      const a1 = '/images/2026/01/detail-one.webp'; const a2 = '/images/2026/01/detail-two.webp';
      const liveBody = `## Alpha\n\nOld lead prose.\n\n![Old alt](${managedSrc})\n\n## Beta\n\nBeta prose.\n`;
      const draftBody = `## Alpha\n\nCompletely new lead.\n\n![Old alt](${managedSrc})\n\n## Beta\n\nBeta prose.\n\n![One](${a1})\n\n![Two](${a2})\n`;
      const w = async (i) => (await compressToWebp(Buffer.from(PATTERNS[i].split(',')[1], 'base64'), { width: 1200 })).toString('base64');
      const w1 = await w(1); const w2 = await w(2);
      gh.getFile.mockImplementation(async (path) => {
        if (path === `public${a1}`) return { content: '', sha: 'a1', raw: { content: w1 } };
        if (path === `public${a2}`) return { content: '', sha: 'a2', raw: { content: w2 } };
        if (path === `public${managedSrc}`) return { content: '', sha: 'b1', raw: { content: w1 } };
        return null;
      });
      gh.listDir.mockResolvedValue([{ type: 'file', name: 'body-1.webp', path: `public${managedSrc}`.replace('public/', 'public/').replace('public', 'public'), sha: 'b1' }].map((e) => ({ ...e, path: `public${managedSrc}` })));
      const res = await resolveBodyImages({
        frontmatter: { title: 'My Post' },
        slug: 'pest-control/my-post',
        body: draftBody,
        existingFile: { path: 'src/content/blog/pest-control/my-post.mdx', file: { content: `---\ntitle: My Post\n---\n${liveBody}` } },
      });
      expect(res.body).not.toContain(managedSrc);
      expect(res.body).toContain(a1);
      expect(res.deletes).toEqual([`public${managedSrc}`]);
    }
  });

  test('bodyImageRefs: a query or fragment on a local destination is resolved to its pathname — the committed file, not the suffixed URL, is what validates (GH r27)', () => {
    const { bodyImageRefs } = AstroPublisher._internals;
    const body = '![v](/images/blog/x/detail.webp?v=2)\n\n![f](/images/blog/x/other.webp#figure)\n\n![enc](/images/blog/x/what%3Fname.webp)';
    expect(bodyImageRefs(body).map((r) => r.src)).toEqual([
      '/images/blog/x/detail.webp',
      '/images/blog/x/other.webp',
      // A percent-encoded `?` is part of the FILENAME, not a query.
      '/images/blog/x/what?name.webp',
    ]);
  });

  test('reusableLiveBodyImage judges the live section in the live file\'s own flavour: a raw HTML block before the prose does not change the .md lead (GH r27)', () => {
    const { reusableLiveBodyImage } = AstroPublisher._internals;
    const src = '/images/blog/x/body-1.webp';
    const liveBody = `## Section\n\n<div>Noise text</div>\n\nActual lead prose here.\n\n![Live alt](${src})\n`;
    const existingFile = { path: 'src/content/blog/x.md', file: { content: `---\ntitle: T\n---\n${liveBody}` } };
    // .md: the div is a raw HTML block — lead = the real prose → context matches.
    expect(reusableLiveBodyImage(existingFile, src, 'Section', { title: 'T', lead: 'Actual lead prose here.', mdx: false })).toBe('Live alt');
    // .mdx: the div's inner text renders — the lead differs → no reuse.
    expect(reusableLiveBodyImage(existingFile, src, 'Section', { title: 'T', lead: 'Actual lead prose here.', mdx: true })).toBeNull();
  });

  test('bodyImageRefs: a reference label over 999 characters neither defines nor renders — the reference stays literal text (GH r26)', () => {
    const { bodyImageRefs } = AstroPublisher._internals;
    const long = 'x'.repeat(1000);
    const ok = 'y'.repeat(999);
    const body = `[${long}]: /images/blog/x/body-1.webp\n\n![alt][${long}]\n\n[${ok}]: /images/blog/x/body-2.webp\n\n![kept][${ok}]`;
    expect(bodyImageRefs(body).map((r) => [r.alt, r.src])).toEqual([['kept', '/images/blog/x/body-2.webp']]);
  });

  test('assertBodyImagesAtHead: a .md head whose two images sit inside raw HTML blocks withholds; the same body in .mdx passes (GH r24)', async () => {
    const { assertBodyImagesAtHead, compressToWebp } = AstroPublisher._internals;
    const heroSrc = '/images/2025/12/shrub-diseases.webp';
    const liveFm = validFrontmatter({ slug: '/shrub-diseases-sarasota-fl/', title: 'Shrub Diseases', canonical: 'https://www.wavespestcontrol.com/blog/shrub-diseases-sarasota-fl/', hero_image: { src: heroSrc, alt: 'hero' }, og_image: heroSrc });
    const wrapped = fmModule.stringify(liveFm, '## A\n\nProse.\n\n<div>![a](/images/blog/shrub-diseases-sarasota-fl/body-1.webp)</div>\n\n## B\n\n<figure>\n![b](/images/blog/shrub-diseases-sarasota-fl/body-2.webp)\n</figure>\n');
    const webp = async (i) => (await compressToWebp(Buffer.from(PATTERNS[i].split(',')[1], 'base64'), { width: 1200 })).toString('base64');
    const bytes = { hero: await webp(0), 'body-1': await webp(1), 'body-2': await webp(2) };
    const rig = (ext) => gh.getFile.mockImplementation(async (path, ref) => {
      if (path === `src/content/blog/shrub-diseases-sarasota-fl.${ext}`) return { content: wrapped, sha: 'f' };
      if (path === `public${heroSrc}`) return { content: '', sha: 'h', raw: { content: bytes.hero } };
      const m = path.match(/shrub-diseases-sarasota-fl\/(body-1|body-2)\.webp$/);
      return m ? { content: '', sha: m[1], raw: { content: bytes[m[1]] } } : null;
    });
    const refresh = { actionType: 'refresh_existing_page', targetUrl: 'https://www.wavespestcontrol.com/blog/shrub-diseases-sarasota-fl/', branch: 'content/refresh-x' };
    rig('md');
    const res = await assertBodyImagesAtHead({ frontmatter: {}, ...refresh });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/0 distinct in-article image\(s\) on content\/refresh-x, minimum 2/);
    rig('mdx');
    expect(await assertBodyImagesAtHead({ frontmatter: {}, ...refresh })).toMatchObject({ ok: true, reason: null });
  });

  test('refresh lane: a draft that replaces every managed picture with authored ones needs no generation — the dropped body-N assets are still swept (GH r24)', async () => {
    const { compressToWebp } = AstroPublisher._internals;
    const heroSrc = '/images/2025/12/shrub-diseases.webp';
    const liveFm = validFrontmatter({ slug: '/shrub-diseases-sarasota-fl/', title: 'Shrub Diseases', canonical: 'https://www.wavespestcontrol.com/blog/shrub-diseases-sarasota-fl/', hero_image: { src: heroSrc, alt: 'hero' }, og_image: heroSrc });
    const liveBody = '## Hibiscus\n\nHibiscus prose.\n\n![Managed one](/images/blog/shrub-diseases-sarasota-fl/body-1.webp)\n\n## Oleander\n\nOleander prose.\n\n![Managed two](/images/blog/shrub-diseases-sarasota-fl/body-2.webp)\n';
    const liveMd = fmModule.stringify(liveFm, liveBody);
    const webp = async (i) => (await compressToWebp(Buffer.from(PATTERNS[i].split(',')[1], 'base64'), { width: 1200 })).toString('base64');
    const bytes = { hero: await webp(0), 'authored-a': await webp(1), 'authored-b': await webp(2), 'body-1': await webp(3), 'body-2': await webp(4) };
    gh.getFile.mockImplementation(async (path) => {
      if (path === 'src/content/blog/shrub-diseases-sarasota-fl.mdx') return null;
      if (path === 'src/content/blog/shrub-diseases-sarasota-fl.md') return { content: liveMd, sha: 'live' };
      if (path === `public${heroSrc}`) return { content: '', sha: 'h', raw: { content: bytes.hero } };
      const m = path.match(/shrub-diseases-sarasota-fl\/(authored-a|authored-b|body-1|body-2)\.webp$/);
      return m ? { content: '', sha: m[1], raw: { content: bytes[m[1]] } } : null;
    });
    gh.listDir.mockResolvedValue(['body-1', 'body-2'].map((n) => ({ type: 'file', name: `${n}.webp`, path: `public/images/blog/shrub-diseases-sarasota-fl/${n}.webp`, sha: n })));
    gh.commitFiles.mockResolvedValue({ commit: { sha: 'multi' } });
    const draftBody = liveBody
      .replace('![Managed one](/images/blog/shrub-diseases-sarasota-fl/body-1.webp)', '![Authored one](/images/blog/shrub-diseases-sarasota-fl/authored-a.webp)')
      .replace('![Managed two](/images/blog/shrub-diseases-sarasota-fl/body-2.webp)', '![Authored two](/images/blog/shrub-diseases-sarasota-fl/authored-b.webp)');
    const draft = { type: 'draft', page_url: 'https://www.wavespestcontrol.com/blog/shrub-diseases-sarasota-fl/', frontmatter: {}, body: draftBody };
    const res = await AstroPublisher.publishRefresh(draft, { action_type: 'refresh_existing_page', target_url: draft.page_url });
    expect(res.status).toBe('pr_open');
    expect(heroImageGenerator.generate.mock.calls.filter(([a]) => a.mode === 'blog-body')).toHaveLength(0);
    const call = gh.commitFiles.mock.calls[0][0];
    expect(call.files.map((f) => f.path)).toEqual(['src/content/blog/shrub-diseases-sarasota-fl.md']);
    expect(call.deletes).toEqual(['public/images/blog/shrub-diseases-sarasota-fl/body-1.webp', 'public/images/blog/shrub-diseases-sarasota-fl/body-2.webp']);
    // The swept blobs are pinned: each was re-read on the fresh branch before the commit.
    for (const n of ['body-1', 'body-2']) expect(gh.getFile).toHaveBeenCalledWith(`public/images/blog/shrub-diseases-sarasota-fl/${n}.webp`, expect.stringMatching(/^content\/refresh-/));
  });

});
