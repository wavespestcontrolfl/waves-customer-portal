jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/seo/sitemap-manager', () => ({ listUrls: jest.fn() }));

const db = require('../models/db');
const SitemapManager = require('../services/seo/sitemap-manager');
const SitemapValidator = require('../services/seo/sitemap-validator');
const UrlIntelligence = require('../services/seo/url-intelligence');

afterEach(() => {
  db.mockReset();
  SitemapManager.listUrls.mockReset();
  jest.restoreAllMocks();
});

function makeQueryBuilder(rows) {
  const builder = {
    select: jest.fn(() => builder),
    where: jest.fn(() => builder),
    groupBy: jest.fn(() => builder),
    then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject),
  };
  return builder;
}

describe('UrlIntelligence sitemap membership', () => {
  test('refreshDomain rejects unsupported domains before sitemap fetch', async () => {
    await expect(UrlIntelligence.refreshDomain('http://127.0.0.1/admin'))
      .rejects
      .toThrow(/Unsupported SEO domain/);

    expect(SitemapManager.listUrls).not.toHaveBeenCalled();
    expect(db).not.toHaveBeenCalled();
  });

  test('sitemap validation rejects unsupported domains before sitemap fetch', async () => {
    await expect(SitemapValidator.validateDomain('http://169.254.169.254/latest/meta-data'))
      .rejects
      .toThrow(/Unsupported SEO domain/);

    expect(SitemapManager.listUrls).not.toHaveBeenCalled();
    expect(db).not.toHaveBeenCalled();
  });

  test('supported domain helpers accept bare www hostnames', () => {
    expect(UrlIntelligence._internals.supportedSeoDomain('www.wavespestcontrol.com'))
      .toBe('wavespestcontrol.com');
    expect(SitemapValidator._internals.supportedSeoDomain('www.wavespestcontrol.com'))
      .toBe('wavespestcontrol.com');
  });

  test('sitemapMembershipForUrl prefers the live sitemap set over stale index status', () => {
    const { sitemapMembershipForUrl } = UrlIntelligence._internals;
    const sitemapUrlSet = new Set(['wavespestcontrol.com/in-sitemap']);

    expect(sitemapMembershipForUrl(
      'wavespestcontrol.com/in-sitemap',
      { in_sitemap: false },
      sitemapUrlSet,
    )).toBe(true);
    expect(sitemapMembershipForUrl(
      'wavespestcontrol.com/not-in-sitemap',
      { in_sitemap: true },
      sitemapUrlSet,
    )).toBe(false);
    expect(sitemapMembershipForUrl(
      'wavespestcontrol.com/from-index-status',
      { in_sitemap: true },
      null,
    )).toBe(true);
  });

  test('refreshDomain includes sitemap-only URLs and passes sitemap membership to refreshUrl', async () => {
    SitemapManager.listUrls.mockResolvedValue([
      'https://www.wavespestcontrol.com/sitemap-only/',
      'https://www.wavespestcontrol.com/a/',
    ]);

    db.mockImplementation((table) => {
      if (table === 'seo_page_audits') {
        return makeQueryBuilder([{ url: 'https://www.wavespestcontrol.com/a/' }]);
      }
      if (table === 'content_index_status') {
        return makeQueryBuilder([{ url: 'https://www.wavespestcontrol.com/b/' }]);
      }
      if (table === 'gsc_pages') {
        return makeQueryBuilder([{ page_url: 'https://www.wavespestcontrol.com/c/' }]);
      }
      throw new Error(`Unexpected table ${table}`);
    });

    const refreshSpy = jest.spyOn(UrlIntelligence, 'refreshUrl').mockResolvedValue({});

    const result = await UrlIntelligence.refreshDomain('wavespestcontrol.com');

    expect(SitemapManager.listUrls).toHaveBeenCalledWith({
      sitemapUrl: 'https://wavespestcontrol.com/sitemap.xml',
    });
    expect(refreshSpy.mock.calls.map(([url]) => url).sort()).toEqual([
      'wavespestcontrol.com/a',
      'wavespestcontrol.com/b',
      'wavespestcontrol.com/c',
      'wavespestcontrol.com/sitemap-only',
    ]);
    const sitemapUrlSet = refreshSpy.mock.calls[0][1].sitemapUrlSet;
    expect(sitemapUrlSet.has('wavespestcontrol.com/sitemap-only')).toBe(true);
    expect(sitemapUrlSet.has('wavespestcontrol.com/c')).toBe(false);
    expect(result.urls_total).toBe(4);
    expect(result.urls_refreshed).toBe(4);
  });
});
