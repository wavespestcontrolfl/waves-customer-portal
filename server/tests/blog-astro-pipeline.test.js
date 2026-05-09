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

function chain(overrides = {}) {
  return {
    where: jest.fn().mockReturnThis(),
    whereIn: jest.fn().mockReturnThis(),
    whereNotNull: jest.fn().mockReturnThis(),
    select: jest.fn().mockResolvedValue([]),
    first: jest.fn(),
    update: jest.fn().mockResolvedValue(1),
    ...overrides,
  };
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
});

describe('Pages poll merged-to-live transition', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn().mockResolvedValue({ status: 200 });
  });

  afterEach(() => {
    delete global.fetch;
  });

  test('marks merged posts live when the expected live URL responds', async () => {
    const update = chain();
    db.mockReturnValue(update);

    const result = await PagesPoll.pollPost({
      id: 'post-1',
      slug: 'ant-trails-bradenton',
      astro_status: 'merged',
      astro_live_url: 'https://www.wavespestcontrol.com/ant-trails-bradenton/',
      publish_status: 'pending_review',
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
