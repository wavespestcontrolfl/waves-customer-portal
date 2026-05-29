/**
 * publishRefresh frontmatter-freeze tests. The refresh path must preserve
 * canonical / slug / schema / tracking / domains and change only the editable
 * meta fields + body + freshness date — even if the agent draft tries to
 * change protected fields.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/content-astro/github-client', () => ({
  createBranch: jest.fn(),
  getFile: jest.fn(),
  putFile: jest.fn(),
  createPr: jest.fn(),
  createIssueComment: jest.fn(),
}));

const gh = require('../services/content-astro/github-client');
const fm = require('../services/content-astro/frontmatter');
const pub = require('../services/content-astro/astro-publisher');

const FILE_PATH = 'src/content/services/pest-control-sarasota-fl.md';
const EXISTING = [
  '---',
  'metaTitle: "Old meta title"',
  'metaDescription: "Old meta description"',
  'slug: "pest-control-sarasota-fl"',
  'canonical: "https://www.wavespestcontrol.com/pest-control-sarasota-fl/"',
  'trackingNumberKey: "sarasota_pest_main"',
  'cityPhone: "(941) 297-2606"',
  'pageType: "city-hub"',
  'robots: "index, follow"',
  'domains:',
  '  - sarasotaflpestcontrol.com',
  'modified: "2026-01-01T12:00:00"',
  '---',
  'Old body content about Sarasota pest control.',
].join('\n');

function refreshDraft(overrides = {}) {
  return {
    type: 'draft',
    file_path: FILE_PATH,
    page_url: '/pest-control-sarasota-fl/',
    frontmatter: {
      // The agent tries to change protected fields — these must be ignored.
      canonical: 'https://evil.example.com/hacked/',
      slug: 'hacked-slug',
      trackingNumberKey: 'attacker_number',
      // Editable fields — these should take effect.
      metaTitle: 'New Sarasota meta title',
      metaDescription: 'New Sarasota meta description',
      ...overrides.frontmatter,
    },
    body: overrides.body || 'Fresh Sarasota pest control content mentioning the Laurel Park neighborhood and drywood termites.',
  };
}
const BRIEF = { action_type: 'refresh_existing_page', target_url: '/pest-control-sarasota-fl/', city: 'Sarasota', service: 'pest' };

describe('publishRefresh frontmatter freeze', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    gh.createBranch.mockResolvedValue({});
    gh.getFile.mockResolvedValue({ content: EXISTING, sha: 'existing-sha' });
    gh.putFile.mockResolvedValue({ commit: { sha: 'new-sha' } });
    gh.createPr.mockResolvedValue({ number: 77, html_url: 'https://github.com/x/y/pull/77', head: { sha: 'h' } });
    gh.createIssueComment.mockResolvedValue({});
  });

  test('preserves protected frontmatter and changes only meta + body + modified', async () => {
    const res = await pub.publishRefresh(refreshDraft(), BRIEF);
    expect(res.status).toBe('pr_open');
    expect(gh.putFile).toHaveBeenCalledTimes(1);

    const written = gh.putFile.mock.calls[0][0].content;
    const { data, content } = fm.parse(written);

    // FROZEN — agent's attempted changes ignored.
    expect(data.canonical).toBe('https://www.wavespestcontrol.com/pest-control-sarasota-fl/');
    expect(data.slug).toBe('pest-control-sarasota-fl');
    expect(data.trackingNumberKey).toBe('sarasota_pest_main');
    expect(data.cityPhone).toBe('(941) 297-2606');
    expect(data.pageType).toBe('city-hub');
    expect(data.domains).toEqual(['sarasotaflpestcontrol.com']);

    // EDITABLE — applied.
    expect(data.metaTitle).toBe('New Sarasota meta title');
    expect(data.metaDescription).toBe('New Sarasota meta description');
    expect(content.trim()).toMatch(/Laurel Park/);

    // Freshness bumped (body changed). Not the old date.
    expect(data.modified).not.toBe('2026-01-01T12:00:00');
    expect(String(data.modified)).toMatch(/^\d{4}-\d{2}-\d{2}T12:00:00$/);
  });

  test('no_changes when body and meta are identical to live', async () => {
    const draft = {
      type: 'draft',
      file_path: FILE_PATH,
      page_url: '/pest-control-sarasota-fl/',
      frontmatter: { metaTitle: 'Old meta title', metaDescription: 'Old meta description' },
      body: 'Old body content about Sarasota pest control.',
    };
    const res = await pub.publishRefresh(draft, BRIEF);
    expect(res.status).toBe('no_changes');
    expect(gh.putFile).not.toHaveBeenCalled();
  });

  test('does not introduce a meta field the live page does not use', async () => {
    // Live page has no `title`; a draft `title` must not be added.
    const res = await pub.publishRefresh(refreshDraft({ frontmatter: { title: 'Sneaky Title' } }), BRIEF);
    expect(res.status).toBe('pr_open');
    const { data } = fm.parse(gh.putFile.mock.calls[0][0].content);
    expect(data.title).toBeUndefined();
  });
});

describe('canPublishRefresh', () => {
  test('accepts a refresh_existing_page draft with a target', () => {
    expect(pub.canPublishRefresh({ type: 'draft', body: 'x', page_url: '/p/' }, { action_type: 'refresh_existing_page' })).toBe(true);
  });
  test('rejects other action types', () => {
    expect(pub.canPublishRefresh({ type: 'draft', body: 'x', page_url: '/p/' }, { action_type: 'new_supporting_blog' })).toBe(false);
  });
  test('rejects a draft with no body', () => {
    expect(pub.canPublishRefresh({ type: 'draft', body: '', page_url: '/p/' }, { action_type: 'refresh_existing_page' })).toBe(false);
  });
});

describe('getLiveFrontmatter', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  test('returns null when the file is not found (so callers can fail closed)', async () => {
    gh.getFile.mockResolvedValue(null);
    const r = await pub.getLiveFrontmatter('src/content/services/pest-control-venice-fl.md');
    expect(r).toBeNull();
  });

  test('returns parsed frontmatter (with domains) when the page exists', async () => {
    gh.getFile.mockResolvedValue({ content: '---\nslug: "x"\ndomains:\n  - veniceflpestcontrol.com\n---\nbody', sha: 's' });
    const r = await pub.getLiveFrontmatter('src/content/services/termite-control-venice-fl.md');
    expect(r).not.toBeNull();
    expect(r.domains).toEqual(['veniceflpestcontrol.com']);
  });
});

describe('loadExistingPageBody', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  test('returns null when the file is not found (callers fail closed)', async () => {
    gh.getFile.mockResolvedValue(null);
    const r = await pub.loadExistingPageBody('/pest-control-venice-fl/');
    expect(r).toBeNull();
  });

  test('returns the body and word_count of the live page', async () => {
    gh.getFile.mockResolvedValue({ content: EXISTING, sha: 's' });
    const r = await pub.loadExistingPageBody('/pest-control-sarasota-fl/');
    expect(r).not.toBeNull();
    expect(r.body).toContain('Old body content about Sarasota pest control.');
    expect(r.word_count).toBe(7);
  });
});

// A live blog post whose frontmatter is valid per packages/blog-schema/schema.json.
const BLOG_FILE_PATH = 'src/content/blog/drywood-termite-signs-sarasota.md';
const VALID_BLOG = [
  '---',
  'title: "Drywood Termite Signs in Sarasota Homes"',
  'slug: "/blog/drywood-termite-signs-sarasota/"',
  'meta_description: "Spot drywood termite signs in your Sarasota home early: frass piles, blistered paint, and discarded wings. Here is what Waves techs look for first."',
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
const BLOG_BRIEF = { action_type: 'refresh_existing_page', target_url: '/blog/drywood-termite-signs-sarasota/' };

function blogRefreshDraft(overrides = {}) {
  return {
    type: 'draft',
    file_path: BLOG_FILE_PATH,
    page_url: '/blog/drywood-termite-signs-sarasota/',
    frontmatter: { ...(overrides.frontmatter || {}) },
    body: overrides.body || 'Refreshed drywood termite body content mentioning frass and discarded wings near window sills around Laurel Park.',
  };
}

describe('publishRefresh blog-schema validation gate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    gh.createBranch.mockResolvedValue({});
    gh.getFile.mockResolvedValue({ content: VALID_BLOG, sha: 'blog-sha' });
    gh.putFile.mockResolvedValue({ commit: { sha: 'new-sha' } });
    gh.createPr.mockResolvedValue({ number: 88, html_url: 'https://github.com/x/y/pull/88', head: { sha: 'h' } });
    gh.createIssueComment.mockResolvedValue({});
  });

  test('publishes a blog refresh when the merged frontmatter stays schema-valid', async () => {
    const res = await pub.publishRefresh(blogRefreshDraft(), BLOG_BRIEF);
    expect(res.status).toBe('pr_open');
    expect(gh.putFile).toHaveBeenCalledTimes(1);
    const { data } = fm.parse(gh.putFile.mock.calls[0][0].content);
    expect(data.meta_description.length).toBeGreaterThanOrEqual(115);
    expect(data.meta_description.length).toBeLessThanOrEqual(160);
  });

  test('blocks a blog refresh that pushes meta_description out of the 115-160 bound', async () => {
    const tooLong = `Drywood termite signs ${'x'.repeat(180)}`;
    await expect(
      pub.publishRefresh(blogRefreshDraft({ frontmatter: { meta_description: tooLong } }), BLOG_BRIEF),
    ).rejects.toMatchObject({ code: 'BLOG_FRONTMATTER_INVALID' });
    expect(gh.putFile).not.toHaveBeenCalled();
  });

  test('does NOT blog-validate a non-blog (service) page refresh', async () => {
    // Service pages use metaDescription (not meta_description) and other fields
    // the blog schema forbids; a too-short metaDescription must NOT be rejected.
    gh.getFile.mockResolvedValue({ content: EXISTING, sha: 'svc-sha' });
    const res = await pub.publishRefresh(
      refreshDraft({ frontmatter: { metaDescription: 'short' }, body: 'Updated Sarasota service body near Laurel Park.' }),
      BRIEF,
    );
    expect(res.status).toBe('pr_open');
    expect(gh.putFile).toHaveBeenCalledTimes(1);
  });
});
