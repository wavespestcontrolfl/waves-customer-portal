/**
 * Backlink profile → astro sameAs sync: only verified per-office Waves pages on
 * allowlisted hosts ship, routed to their matching office bucket.
 */
jest.mock('../models/db', () => {
  const db = jest.fn();
  db.raw = jest.fn((sql) => sql);
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/content-astro/github-client', () => ({}));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => false) }));

const db = require('../models/db');
const { getVerifiedProfilesByOffice, sameAsRejectReason } = require('../services/backlink-profile-astro-sync');

const ALLOWED_OFFICE_PAGES = [
  'https://citysquares.com/b/waves-pest-control-lakewood-ranch-26663854',
  'https://citysquares.com/b/waves-pest-control-parrish-26468506',
  'https://citysquares.com/b/waves-pest-control-sarasota-26347392',
  'https://citysquares.com/b/waves-pest-control-venice-26858800',
  'https://www.n49.com/biz/6597767/waves-pest-control-sarasota-fl-sarasota-1450-pine-warbler-place/',
  'https://nextdoor.com/pages/waves-pest-control-sarasota-sarasota-fl/',
  'https://nextdoor.com/pages/waves-pest-control-venice-venice-fl-9crfqd/',
  'https://reviews.birdeye.com/waves-pest-control-parrish-176686921044177',
  'https://reviews.birdeye.com/waves-pest-control-sarasota-175373465862437',
  'https://reviews.birdeye.com/waves-pest-control-venice-176686916548706',
];

const SAAS_DIRECTORIES = [
  'https://proofstories.io/directory/products/waves-pest-control/',
  'https://toolfio.com/item/waves-pest-control',
  'https://toolhub.me/listings/waves-pest-control/',
  'https://www.betterlaunch.co/product/waves-pest-control-2',
  'https://www.showmysites.com/wavespestcontrol/waves-pest-control-1/',
  'https://www.saashub.com/waves-lawn-watering-calculator',
  'https://mcpservers.org/servers/www-wavespestcontrol-com',
  'https://glama.ai/mcp/connectors/com.wavespestcontrol/pest-control',
];

const NON_ALLOWLISTED_OR_BAD = [
  'https://angeloxmbp14703.blogadvize.com/46847483/waves-pest-control-venice',
  'https://damienbzxs26150.bloggerbags.com/44266969/waves-pest-control-venice',
  'https://nearspotusa.com/business/waves-pest-control-englewood',
  'https://www.loc8nearme.com/florida/englewood/waves-pest-control/9302390/',
  'https://www.hotfrog.com/company/ARaKID9jeQC5gaWYQ5I5Tw/waves-pest-control/englewood/pest-control',
  'https://www.trustpilot.com/review/wavespestcontrol.com',
  'https://www.facebook.com/wavespestcontrol',
  'https://www.bbb.org/us/fl/lakewood-ranch/profile/pest-control/waves-pest-control-0653-90447425',
  'https://www.swflinc.com/business-directory/waves-pest-control/',
  'https://www.pinterest.com/wavespestcontrol/',
  'https://reviews.birdeye.com/waves-pest-control-lakewood-ranch-171362376431312',
  'https://adsly.io/listings/waves-pest-control-7519',
  'https://www.yellowpages.com/rotonda-west-fl/pest-control-services',
];

function mockRows(rows) {
  const chain = {
    whereIn: jest.fn(() => chain),
    whereNotNull: jest.fn(() => chain),
    select: jest.fn(async () => rows),
  };
  db.mockReturnValue(chain);
}

describe('sameAsRejectReason', () => {
  test.each(ALLOWED_OFFICE_PAGES)('allowlisted per-office profile ships: %s', (url) => {
    expect(sameAsRejectReason(url)).toBeNull();
  });

  test.each(SAAS_DIRECTORIES)('SaaS/tool/MCP directory is excluded: %s', (url) => {
    expect(sameAsRejectReason(url)).toBe('excluded');
  });

  test.each(NON_ALLOWLISTED_OR_BAD)('PBN, Englewood, corporate, or bad-phone listing is excluded: %s', (url) => {
    expect(sameAsRejectReason(url)).toBe('excluded');
  });

  test('query strings or non-profile paths on allowlisted hosts are not profiles', () => {
    expect(sameAsRejectReason('https://citysquares.com/b/waves-pest-control-venice-26858800?ref=x')).toBe('not_profile');
    expect(sameAsRejectReason('https://nextdoor.com/pages/other-pest-control-sarasota-fl/')).toBe('not_profile');
    expect(sameAsRejectReason('https://nextdoor.com/p/waves-pest-control-sarasota-fl/')).toBe('not_profile');
    expect(sameAsRejectReason('https://citysquares.com/articles/waves-pest-control-sarasota')).toBe('not_profile');
  });

  test('non-https or unparseable URL is invalid', () => {
    expect(sameAsRejectReason('http://citysquares.com/b/waves-pest-control-venice-26858800')).toBe('invalid');
    expect(sameAsRejectReason('not a url')).toBe('invalid');
  });
});

describe('getVerifiedProfilesByOffice', () => {
  test('filters out SaaS/PBN/corporate/bad listings and routes unscoped URLs to their exact office', async () => {
    mockRows([
      ...ALLOWED_OFFICE_PAGES.map((live_url) => ({ live_url, location: null })),
      ...SAAS_DIRECTORIES.map((live_url) => ({ live_url, location: null })),
      ...NON_ALLOWLISTED_OR_BAD.map((live_url) => ({ live_url, location: null })),
      // Ambiguous, HQ-only lakewood-ranch, or non-office city on allowlisted host -> dropped
      { live_url: 'https://citysquares.com/b/waves-pest-control-englewood-1234', location: null },
      { live_url: 'https://citysquares.com/b/waves-pest-control-englewood-1234', location: 'venice' },
      { live_url: 'https://nextdoor.com/pages/waves-pest-control-sarasota-bradenton-fl/', location: null },
      { live_url: 'https://citysquares.com/b/waves-pest-control-99999', location: null },
      { live_url: 'https://citysquares.com/b/waves-pest-control-lakewood-ranch-99999', location: null },
      // Stored default 'bradenton' with unmapped Lakewood Ranch HQ URL or conflicting Sarasota URL -> dropped
      { live_url: 'https://citysquares.com/b/waves-pest-control-lakewood-ranch-99999', location: 'bradenton' },
      { live_url: 'https://citysquares.com/b/waves-pest-control-sarasota-99999', location: 'bradenton' },
      // Non-profile Nextdoor post mentioning waves and sarasota -> rejected
      { live_url: 'https://nextdoor.com/p/waves-pest-control-sarasota-fl/', location: null },
      // Explicit non-default location on allowlisted host with non-conflicting URL
      { live_url: 'https://citysquares.com/b/waves-pest-control-99999', location: 'venice' },
    ]);

    const offices = await getVerifiedProfilesByOffice();
    expect(offices['bradenton-fl']).toEqual([
      'https://citysquares.com/b/waves-pest-control-lakewood-ranch-26663854',
    ]);
    expect(offices['parrish-fl']).toEqual([
      'https://citysquares.com/b/waves-pest-control-parrish-26468506',
      'https://reviews.birdeye.com/waves-pest-control-parrish-176686921044177',
    ]);
    expect(offices['sarasota-fl']).toEqual([
      'https://citysquares.com/b/waves-pest-control-sarasota-26347392',
      'https://nextdoor.com/pages/waves-pest-control-sarasota-sarasota-fl/',
      'https://reviews.birdeye.com/waves-pest-control-sarasota-175373465862437',
      'https://www.n49.com/biz/6597767/waves-pest-control-sarasota-fl-sarasota-1450-pine-warbler-place/',
    ]);
    expect(offices['venice-fl']).toEqual([
      'https://citysquares.com/b/waves-pest-control-99999',
      'https://citysquares.com/b/waves-pest-control-venice-26858800',
      'https://nextdoor.com/pages/waves-pest-control-venice-venice-fl-9crfqd/',
      'https://reviews.birdeye.com/waves-pest-control-venice-176686916548706',
    ]);
  });
});
