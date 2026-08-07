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
const db = require('../models/db');
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

beforeEach(() => {
  db.mockReset();
});

function registryQuery(row, seen = []) {
  const query = {};
  query.select = jest.fn(() => query);
  query.whereNotNull = jest.fn(() => query);
  query.whereNot = jest.fn(() => query);
  query.whereRaw = jest.fn((sql, bindings) => {
    seen.push(['whereRaw', sql, bindings]);
    return query;
  });
  query.andWhere = jest.fn((callback) => {
    const whereScope = {
      where: jest.fn((column, value) => {
        seen.push([column, value]);
        return whereScope;
      }),
      orWhere: jest.fn((column, value) => {
        seen.push([column, value]);
        return whereScope;
      }),
    };
    callback.call(whereScope);
    return query;
  });
  query.orderByRaw = jest.fn(() => query);
  query.orderBy = jest.fn(() => query);
  query.limit = jest.fn(() => query);
  query.first = jest.fn(async () => row);
  return query;
}

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

    // PROTECTED (owner rule 2026-07-16) — service/location metaTitle is never
    // editable by a refresh; the draft's attempted rewrite is ignored.
    expect(data.metaTitle).toBe('Old meta title');
    // EDITABLE — applied.
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

  test('falls back to content_registry source path for canonical blog URLs outside /blog', async () => {
    const seen = [];
    db.mockReturnValue(registryQuery({ astro_source_path: 'src/content/blog/fertilizer-blackout-sarasota-county.md' }, seen));
    gh.getFile.mockImplementation(async (path) => {
      if (path === 'src/content/blog/fertilizer-blackout-sarasota-county.md') {
        return {
          content: '---\nslug: "/lawn-care/fertilizer-blackout-sarasota-county/"\ndomains:\n  - sarasotaflpestcontrol.com\n---\nbody',
          sha: 'registry-sha',
        };
      }
      return null;
    });
    const r = await pub.getLiveFrontmatter('/lawn-care/fertilizer-blackout-sarasota-county/');
    expect(r).not.toBeNull();
    expect(r.domains).toEqual(['sarasotaflpestcontrol.com']);
    expect(gh.getFile).toHaveBeenCalledWith('src/content/locations/lawn-care/fertilizer-blackout-sarasota-county.md');
    expect(gh.getFile).toHaveBeenCalledWith('src/content/blog/fertilizer-blackout-sarasota-county.mdx');
    expect(gh.getFile).toHaveBeenCalledWith('src/content/blog/fertilizer-blackout-sarasota-county.md');
    expect(seen).toContainEqual(['live_url', '/lawn-care/fertilizer-blackout-sarasota-county/']);
    expect(seen).not.toContainEqual(['canonical_url_normalized', '/lawn-care/fertilizer-blackout-sarasota-county/']);
  });

  test('preserves external host in content_registry lookup keys', async () => {
    const seen = [];
    db.mockReturnValue(registryQuery(null, seen));
    gh.getFile.mockResolvedValue(null);
    const r = await pub.getLiveFrontmatter('https://sarasotaflpestcontrol.com/lawn-care/fertilizer-blackout-sarasota-county/');
    expect(r).toBeNull();
    expect(seen).toContainEqual(['live_url', 'https://sarasotaflpestcontrol.com/lawn-care/fertilizer-blackout-sarasota-county/']);
    expect(seen).toContainEqual(['live_url', '/lawn-care/fertilizer-blackout-sarasota-county/']);
    expect(seen).toContainEqual(['whereRaw', 'metadata::text ILIKE ?', ['%sarasotaflpestcontrol.com%']]);
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

  test('publishes a refresh through registry source path when canonical blog URL is not under /blog', async () => {
    db.mockReturnValue(registryQuery({ astro_source_path: 'src/content/blog/fertilizer-blackout-sarasota-county.md' }));
    gh.getFile.mockImplementation(async (path) => {
      if (path === 'src/content/blog/fertilizer-blackout-sarasota-county.md') {
        return { content: VALID_BLOG, sha: 'blog-sha' };
      }
      return null;
    });
    const res = await pub.publishRefresh({
      type: 'draft',
      page_url: '/lawn-care/fertilizer-blackout-sarasota-county/',
      frontmatter: {
        meta_description: 'Spot Sarasota fertilizer blackout rules and lawn-care timing for Southwest Florida yards before summer restrictions change your treatment plan.',
      },
      body: 'Refreshed Sarasota fertilizer blackout content with local timing, customer questions, and careful lawn-care compliance guidance.',
    }, {
      action_type: 'refresh_existing_page',
      target_url: '/lawn-care/fertilizer-blackout-sarasota-county/',
    });
    expect(res.status).toBe('pr_open');
    expect(gh.putFile).toHaveBeenCalledWith(expect.objectContaining({
      path: 'src/content/blog/fertilizer-blackout-sarasota-county.md',
      sha: 'blog-sha',
    }));
  });
});

describe('publishMetadataRewrite protected metaTitle (owner rule 2026-07-16)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    gh.createBranch.mockResolvedValue({});
    gh.getFile.mockResolvedValue({ content: EXISTING, sha: 'existing-sha' });
    gh.putFile.mockResolvedValue({ commit: { sha: 'new-sha' } });
    gh.createPr.mockResolvedValue({ number: 78, html_url: 'https://github.com/x/y/pull/78', head: { sha: 'h' } });
    gh.createIssueComment.mockResolvedValue({});
  });

  const REWRITE_BRIEF = { action_type: 'rewrite_title_meta', target_url: '/pest-control-sarasota-fl/' };

  test('keeps the live metaTitle on a service page; meta description still applies', async () => {
    const res = await pub.publishMetadataRewrite({
      type: 'metadata',
      file_path: FILE_PATH,
      title: 'Short Rewritten Title | Waves',
      meta_description: 'A rewritten meta description for the Sarasota page.',
    }, REWRITE_BRIEF);
    expect(res.status).toBe('pr_open');
    const { data } = fm.parse(gh.putFile.mock.calls[0][0].content);
    expect(data.metaTitle).toBe('Old meta title'); // protected — rewrite ignored
    expect(data.metaDescription).toBe('A rewritten meta description for the Sarasota page.');
  });

  test('no_changes when only the protected metaTitle would have changed', async () => {
    const res = await pub.publishMetadataRewrite({
      type: 'metadata',
      file_path: FILE_PATH,
      title: 'Short Rewritten Title | Waves',
      meta_description: 'Old meta description',
    }, REWRITE_BRIEF);
    expect(res.status).toBe('no_changes');
    expect(gh.putFile).not.toHaveBeenCalled();
  });
});

// A LEGACY (pre-schema-v2) live blog post that never carried post_type /
// service_areas_tag. The refresh/metadata lanes freeze the live frontmatter,
// so without the backfill both fields re-validated as missing and every
// attempt hard-failed with "post_type is required; service_areas_tag is
// required" — a mechanical park (prod 2026-08-07), not a content problem.
const LEGACY_BLOG_FILE_PATH = 'src/content/blog/fall-lawn-mistakes-sarasota.md';
const LEGACY_BLOG = [
  '---',
  'title: "Fall Lawn Mistakes Sarasota Homeowners Make"',
  'slug: "/blog/fall-lawn-mistakes-sarasota/"',
  'meta_description: "Avoid the fall lawn mistakes Sarasota homeowners make most: late fertilizing, wrong mowing height, and fungus-friendly night watering habits."',
  'primary_keyword: "fall lawn mistakes"',
  'secondary_keywords:',
  '  - "fall lawn care"',
  'category: "lawn-care"',
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
  'published: "2026-05-01"',
  'updated: "2026-05-01"',
  'technically_reviewed: "2026-05-01"',
  'fact_checked: "2026-05-01"',
  'review_cadence: "quarterly"',
  'reading_time_min: 4',
  'hero_image:',
  '  src: "/images/blog/fall-lawn/hero.webp"',
  '  alt: "Sarasota lawn in autumn"',
  'og_image: "/images/blog/fall-lawn/hero.webp"',
  'canonical: "https://www.wavespestcontrol.com/blog/fall-lawn-mistakes-sarasota/"',
  'schema_types:',
  '  - "Article"',
  'disclosure:',
  '  type: "none"',
  '---',
  'Original legacy fall lawn body content.',
].join('\n');

describe('legacy blog frontmatter backfill (missing post_type + service_areas_tag self-heal)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    gh.createBranch.mockResolvedValue({});
    gh.getFile.mockResolvedValue({ content: LEGACY_BLOG, sha: 'legacy-sha' });
    gh.putFile.mockResolvedValue({ commit: { sha: 'new-sha' } });
    gh.createPr.mockResolvedValue({ number: 91, html_url: 'https://github.com/x/y/pull/91', head: { sha: 'h' } });
    gh.createIssueComment.mockResolvedValue({});
  });

  test('publishRefresh backfills the absent required fields instead of hard-failing the refresh', async () => {
    const res = await pub.publishRefresh({
      type: 'draft',
      file_path: LEGACY_BLOG_FILE_PATH,
      page_url: '/blog/fall-lawn-mistakes-sarasota/',
      frontmatter: {},
      body: 'Refreshed fall lawn guidance for Sarasota yards with updated fungicide timing and mowing-height advice for St. Augustine turf.',
    }, { action_type: 'refresh_existing_page', target_url: '/blog/fall-lawn-mistakes-sarasota/', city: 'Sarasota' });

    expect(res.status).toBe('pr_open');
    const { data } = fm.parse(gh.putFile.mock.calls[0][0].content);
    expect(data.post_type).toBe('location'); // deterministic default
    expect(data.service_areas_tag).toEqual(['Sarasota']); // inferred from title/brief haystack
    // Untouched live fields stay frozen.
    expect(data.canonical).toBe('https://www.wavespestcontrol.com/blog/fall-lawn-mistakes-sarasota/');
    expect(data.category).toBe('lawn-care');
  });

  test('publishRefresh leaves PRESENT valid post_type/service_areas_tag alone', async () => {
    const withFields = LEGACY_BLOG.replace(
      "category: \"lawn-care\"",
      ['category: "lawn-care"', 'post_type: "seasonal"', 'service_areas_tag:', '  - "Venice"'].join('\n'),
    );
    gh.getFile.mockResolvedValue({ content: withFields, sha: 'legacy-sha' });

    await pub.publishRefresh({
      type: 'draft',
      file_path: LEGACY_BLOG_FILE_PATH,
      page_url: '/blog/fall-lawn-mistakes-sarasota/',
      frontmatter: {},
      body: 'Refreshed fall lawn guidance for Sarasota yards with updated fungicide timing and mowing-height advice for St. Augustine turf.',
    }, { action_type: 'refresh_existing_page', target_url: '/blog/fall-lawn-mistakes-sarasota/', city: 'Sarasota' });

    const { data } = fm.parse(gh.putFile.mock.calls[0][0].content);
    expect(data.post_type).toBe('seasonal');
    expect(data.service_areas_tag).toEqual(['Venice']);
  });

  test('publishMetadataRewrite backfills the same absent fields on a legacy blog target', async () => {
    const res = await pub.publishMetadataRewrite({
      type: 'metadata',
      file_path: LEGACY_BLOG_FILE_PATH,
      title: 'Fall Lawn Mistakes Sarasota Homeowners Keep Making',
      meta_description: 'Avoid the fall lawn mistakes Sarasota homeowners make most, from late fertilizing to fungus-friendly night watering on St. Augustine turf.',
    }, { action_type: 'rewrite_title_meta', target_url: '/blog/fall-lawn-mistakes-sarasota/' });

    expect(res.status).toBe('pr_open');
    const { data } = fm.parse(gh.putFile.mock.calls[0][0].content);
    expect(data.post_type).toBe('location');
    expect(data.service_areas_tag).toEqual(['Sarasota']);
    expect(data.title).toBe('Fall Lawn Mistakes Sarasota Homeowners Keep Making');
  });
});
