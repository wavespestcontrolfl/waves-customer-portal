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
