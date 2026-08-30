// Link Library service: slug naming, category rules, manual-row validation,
// the live office review rows, and the sitemap sync's upsert/delete behavior
// (sitemap fetching itself is sitemap-manager's, mocked here).
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/seo/sitemap-manager', () => ({
  invalidate: jest.fn(),
  listUrls: jest.fn(),
}));

// Callable knex mock: db('link_library') returns the current table builder.
let mockBuilders = {};
const mockDb = jest.fn((table) => mockBuilders[table]);
jest.mock('../models/db', () => mockDb);

const sitemapManager = require('../services/seo/sitemap-manager');
const {
  nameForSiteUrl,
  categoryForSiteUrl,
  isSiteUrl,
  validateManualLink,
  officeReviewLinks,
  syncSitemapLinks,
} = require('../services/link-library');

describe('nameForSiteUrl', () => {
  it('title-cases the slug and uppercases the FL suffix', () => {
    expect(nameForSiteUrl('https://www.wavespestcontrol.com/cockroach-control-sarasota-fl/'))
      .toBe('Cockroach Control Sarasota FL');
    expect(nameForSiteUrl('https://www.wavespestcontrol.com/faqs/')).toBe('FAQs');
  });

  it('names the root Homepage and uses the LAST path segment for nested URLs', () => {
    expect(nameForSiteUrl('https://www.wavespestcontrol.com/')).toBe('Homepage');
    // Blog protocol is /{category}/{slug}/ — the slug names the page.
    expect(nameForSiteUrl('https://www.wavespestcontrol.com/pest-control/quarterly-pest-control/'))
      .toBe('Quarterly Pest Control');
  });
});

describe('categoryForSiteUrl / isSiteUrl', () => {
  it('routes the booking-funnel pages to booking, the rest to website', () => {
    expect(categoryForSiteUrl('https://www.wavespestcontrol.com/quote/')).toBe('booking');
    expect(categoryForSiteUrl('https://www.wavespestcontrol.com/book/')).toBe('booking');
    expect(categoryForSiteUrl('https://www.wavespestcontrol.com/pest-control-calculator/')).toBe('booking');
    expect(categoryForSiteUrl('https://www.wavespestcontrol.com/pest-library/')).toBe('website');
  });

  it('isSiteUrl admits only http(s) marketing-site URLs (www or bare)', () => {
    expect(isSiteUrl('https://www.wavespestcontrol.com/quote/')).toBe(true);
    expect(isSiteUrl('https://wavespestcontrol.com/')).toBe(true);
    expect(isSiteUrl('https://portal.wavespestcontrol.com/login')).toBe(false);
    expect(isSiteUrl('https://example.com/quote/')).toBe(false);
    expect(isSiteUrl('not a url')).toBe(false);
  });
});

describe('validateManualLink', () => {
  it('accepts a clean row and trims/normalizes', () => {
    const { value, error } = validateManualLink({
      name: '  Spring special  ',
      url: 'https://www.wavespestcontrol.com/pest-control-deals/',
      category: 'website',
      clause: 'See our current deals',
    });
    expect(error).toBeUndefined();
    expect(value.name).toBe('Spring special');
    expect(value.clause).toBe('See our current deals');
  });

  it('rejects a missing name, a non-URL, a non-http scheme, and an unknown category', () => {
    expect(validateManualLink({ name: '', url: 'https://x.com' }).error).toBeTruthy();
    expect(validateManualLink({ name: 'X', url: 'not a url' }).error).toBeTruthy();
    expect(validateManualLink({ name: 'X', url: 'javascript:alert(1)' }).error).toBeTruthy();
    expect(validateManualLink({ name: 'X', url: 'https://x.com', category: 'customer' }).error).toBeTruthy();
  });
});

describe('officeReviewLinks', () => {
  it('mirrors WAVES_LOCATIONS with a g.page write-review URL per office', () => {
    const links = officeReviewLinks();
    expect(links.length).toBeGreaterThanOrEqual(4);
    for (const link of links) {
      expect(link.category).toBe('reviews');
      expect(link.source).toBe('office');
      expect(link.url).toMatch(/^https:\/\/g\.page\/r\/.+\/review$/);
    }
    const names = links.map((l) => l.name).join(' ');
    for (const office of ['Sarasota', 'Venice', 'Parrish', 'Lakewood Ranch']) {
      expect(names).toContain(office);
    }
  });
});

describe('syncSitemapLinks', () => {
  const SITE = 'https://www.wavespestcontrol.com';
  // Enough pages to clear the sanity floor.
  const PAGES = [
    `${SITE}/`,
    `${SITE}/quote/`,
    `${SITE}/book/`,
    `${SITE}/pest-library/`,
    `${SITE}/service-areas/`,
    `${SITE}/faqs/`,
    `${SITE}/contact/`,
    `${SITE}/pest-control-sarasota-fl/`,
    `${SITE}/ant-control-venice-fl/`,
    `${SITE}/cockroach-control-sarasota-fl/`,
    `${SITE}/flea-treatment-sarasota-fl/`,
  ];

  function makeLinkLibraryBuilder(existingRows) {
    const builder = {
      inserted: [],
      updated: [],
      deletedIds: [],
      where: jest.fn(() => builder),
      whereIn: jest.fn((col, ids) => {
        builder._pendingIds = ids;
        return builder;
      }),
      select: jest.fn(async () => existingRows),
      insert: jest.fn(async (row) => {
        builder.inserted.push(row);
      }),
      update: jest.fn(async (patch) => {
        builder.updated.push(patch);
      }),
      del: jest.fn(async () => {
        builder.deletedIds.push(...(builder._pendingIds || []));
      }),
    };
    return builder;
  }

  // The last-sync bookkeeping (recordSyncOutcome) upserts one system_config row.
  function makeSystemConfigBuilder(firstRow = null) {
    const builder = { inserted: [], updated: [] };
    builder.where = jest.fn(() => builder);
    builder.first = jest.fn(async () => firstRow);
    builder.insert = jest.fn(async (row) => { builder.inserted.push(row); });
    builder.update = jest.fn(async (patch) => { builder.updated.push(patch); });
    return builder;
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('inserts new pages, renames drifted ones, deletes removed ones — manual rows untouched', async () => {
    const existing = [
      // Still in the sitemap but with a stale name → updated.
      { id: 1, url: `${SITE}/quote/`, name: 'Old Quote Name', category: 'booking', source: 'sitemap' },
      // No longer in the sitemap → deleted.
      { id: 2, url: `${SITE}/retired-page/`, name: 'Retired Page', category: 'website', source: 'sitemap' },
      // Manual off-site row — must never be considered for deletion.
      { id: 3, url: 'https://instagram.com/wavespestcontrol', name: 'Instagram', category: 'social', source: 'manual' },
    ];
    const builder = makeLinkLibraryBuilder(existing);
    const systemConfig = makeSystemConfigBuilder();
    mockBuilders = { link_library: builder, system_config: systemConfig };
    sitemapManager.listUrls.mockResolvedValue([
      ...PAGES,
      `${SITE}/quote/`, // duplicate — deduped
      'https://portal.wavespestcontrol.com/login', // off-site — filtered
    ]);

    const result = await syncSitemapLinks();

    expect(sitemapManager.invalidate).toHaveBeenCalled();
    expect(result.fetched).toBe(PAGES.length);
    expect(result.added).toBe(PAGES.length - 1); // /quote/ already existed
    expect(result.updated).toBe(1);
    expect(result.removed).toBe(1);
    expect(builder.deletedIds).toEqual([2]);
    for (const row of builder.inserted) {
      expect(row.source).toBe('sitemap');
      expect(row.url.startsWith(SITE)).toBe(true);
    }
    expect(builder.updated[0].name).toBe('Quote');
    // A successful sync records its own timestamp (never inferred from rows).
    expect(systemConfig.inserted).toHaveLength(1);
    expect(JSON.parse(systemConfig.inserted[0].value).fetched).toBe(PAGES.length);
  });

  it('skips a site URL an owner already added manually — never a duplicate insert', async () => {
    const existing = [
      // Hand-added before the page reached the sitemap. url is globally
      // unique, so a blind sitemap insert would fail this and every later
      // sync — the manual row wins instead.
      { id: 7, url: `${SITE}/pest-library/`, name: 'My Pest Library', category: 'website', source: 'manual' },
    ];
    const builder = makeLinkLibraryBuilder(existing);
    mockBuilders = { link_library: builder, system_config: makeSystemConfigBuilder() };
    sitemapManager.listUrls.mockResolvedValue(PAGES);

    const result = await syncSitemapLinks();

    expect(result.added).toBe(PAGES.length - 1); // the manual URL is skipped
    expect(builder.inserted.some((r) => r.url === `${SITE}/pest-library/`)).toBe(false);
    expect(builder.updated).toHaveLength(0);
    expect(builder.deletedIds).toEqual([]);
  });

  it('refuses to overwrite the library from a suspiciously tiny fetch', async () => {
    mockBuilders = { link_library: makeLinkLibraryBuilder([]) };
    sitemapManager.listUrls.mockResolvedValue([`${SITE}/quote/`]);
    await expect(syncSitemapLinks()).rejects.toThrow(/refusing to overwrite/);
    expect(mockDb).not.toHaveBeenCalled();
  });
});
