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
  getPr: jest.fn(),
  mergePr: jest.fn(),
  deleteFile: jest.fn(),
}));
jest.mock('../services/content-astro/author-service', () => ({
  getAuthor: jest.fn(),
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

  test('opens an Astro PR for supported autonomous draft briefs', async () => {
    jest.clearAllMocks();
    gh.createBranch.mockResolvedValue({});
    gh.getFile.mockResolvedValue(null);
    gh.putFile.mockResolvedValue({ commit: { sha: 'file-sha' } });
    gh.createPr.mockResolvedValue({ number: 123, html_url: 'https://github.com/wavespestcontrolfl/waves-astro/pull/123' });

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
      path: 'src/content/blog/ant-trails-bradenton.md',
      content: expect.stringContaining('Waves Pest Control guidance'),
      message: 'feat(blog): publish ant-trails-bradenton',
      sha: undefined,
    }));
    expect(gh.createPr).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Blog: Ant Trails in Bradenton',
      body: expect.stringContaining('**Autonomous content publish**'),
    }));
    expect(result).toMatchObject({
      url: 'https://www.wavespestcontrol.com/ant-trails-bradenton/',
      status: 'pr_open',
      live: false,
      pr_number: 123,
      pr_url: 'https://github.com/wavespestcontrolfl/waves-astro/pull/123',
      commit_sha: 'file-sha',
    });
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
      path: 'src/content/blog/autonomous-ant-control-bradenton.md',
      branch: expect.stringMatching(/^content\/autonomous-autonomous-ant-control-bradenton-/),
      sha: undefined,
    }));
    expect(gh.createPr).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Blog: Autonomous Ant Control in Bradenton',
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
      path.endsWith('/hero.png') ? { sha: 'existing-hero-sha' } : null
    ));
    gh.putBinary.mockResolvedValue({});
    gh.putFile.mockResolvedValue({ commit: { sha: 'file-commit-sha' } });
    gh.createPr.mockResolvedValue({ number: 123, html_url: 'https://github.example/pr/123' });
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
      featured_image_url: 'data:image/png;base64,eA==',
      hero_image_alt: 'Ant trail near a Bradenton patio',
      content: '## What you are seeing\n\nAnt trails around Bradenton patios usually start with moisture, food access, and tiny exterior gaps.',
    };
    const read = chain({ first: jest.fn().mockResolvedValue(post) });
    const update = chain();
    const queries = [read, update];
    db.mockImplementation(() => queries.shift() || chain());

    await AstroPublisher.publishAstro('post-1');

    expect(gh.putBinary).toHaveBeenCalledWith(expect.objectContaining({
      path: 'public/images/blog/ant-trails-bradenton/hero.png',
      sha: 'existing-hero-sha',
    }));
    expect(update.update).toHaveBeenCalledWith(expect.objectContaining({
      astro_status: 'pr_open',
      astro_pr_number: 123,
    }));
  });
});
