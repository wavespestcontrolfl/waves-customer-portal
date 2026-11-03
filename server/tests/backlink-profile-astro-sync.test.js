/**
 * Backlink profile → astro sameAs sync: only pages that ARE a Waves listing ship.
 * Regression: astro #817 (2026-11-02) proposed 21 verified links for Bradenton's
 * sameAs; 16 were search/category pages, dead pages, blocked hosts or listings
 * with another address. The verifier rightly tracks them as backlinks, so the
 * sync itself must refuse them, or every weekly run re-proposes them.
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

// The 21 live_url values astro #817 proposed (all with no location → bradenton-fl).
const PR_817_KEPT = [
  'https://proofstories.io/directory/products/waves-pest-control/',
  'https://toolfio.com/item/waves-pest-control',
  'https://toolhub.me/listings/waves-pest-control/',
  'https://www.betterlaunch.co/product/waves-pest-control-2',
  'https://www.showmysites.com/wavespestcontrol/waves-pest-control-1/',
];
const PR_817_REFUSED = [
  'https://bizscoreai.com/business-search/florida/pest-control/',
  'https://dlmpropertygroup.com/directory/fl/englewood?page=2',
  'https://flokii.com/businesses/view/137994/north-port-pest-control',
  'https://weboworld.com/listings/Pest-Control/page/9',
  'https://www.enigma.com/directory/fl/all-cities/pest-control-service/',
  'https://www.enigma.com/directory/fl/sarasota/',
  'https://www.yellowpages.com/rotonda-west-fl/pest-control-services',
  'https://adsly.io/listings/waves-pest-control-7519',
  'https://leakdirectory.org/business/waves-pest-control-lakewood-ranch-bradenton/',
  'https://mybusinessplaces.com/listing/waves-pest-control-sarasota/',
  'https://mybusinessplaces.com/listing/waves-pest-control-venice/',
  'https://www.wildlifecontrol.io/listing/waves-pest-control-lakewood-ranch',
  'https://ajax-directory.com/listings810335/waves-pest-control-venice',
  'https://victordirectory.com/listings784135/waves-pest-control-venice',
  'https://kevsbest.com/listing/waves-pest-control/',
  'https://local-biz.directory/listing/waves-pest-control-sarasota/',
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
  test.each(PR_817_KEPT)('a single Waves listing page ships: %s', (url) => {
    expect(sameAsRejectReason(url)).toBeNull();
  });

  test('search, category and paginated pages are not profiles', () => {
    expect(sameAsRejectReason('https://www.yellowpages.com/rotonda-west-fl/pest-control-services')).toBe('not_profile');
    expect(sameAsRejectReason('https://dlmpropertygroup.com/directory/fl/englewood?page=2')).toBe('not_profile');
    expect(sameAsRejectReason('https://example.com/listing/waves-pest-control?sort=new')).toBe('not_profile');
    expect(sameAsRejectReason('https://example.com/search?q=waves+pest+control')).toBe('not_profile');
  });

  test('hand-refused hosts (with subdomains) and pages are excluded, ignoring www, case and trailing slash', () => {
    expect(sameAsRejectReason('https://listings.adsly.io/waves-pest-control')).toBe('excluded');
    expect(sameAsRejectReason('https://www.KEVSBEST.com/listing/Waves-Pest-Control')).toBe('excluded');
    expect(sameAsRejectReason('https://notadsly.io/listing/waves-pest-control')).toBeNull();
  });

  test('a non-https or unparseable URL is invalid', () => {
    expect(sameAsRejectReason('http://toolfio.com/item/waves-pest-control')).toBe('invalid');
    expect(sameAsRejectReason('not a url')).toBe('invalid');
  });
});

describe('getVerifiedProfilesByOffice', () => {
  test('the astro #817 rows reduce to the 5 real Waves listings', async () => {
    mockRows([...PR_817_KEPT, ...PR_817_REFUSED].map((live_url) => ({ live_url, location: null })));
    const offices = await getVerifiedProfilesByOffice();
    expect(offices['bradenton-fl']).toEqual([...PR_817_KEPT].sort());
    expect(offices['sarasota-fl']).toEqual([]);
    expect(offices['venice-fl']).toEqual([]);
    expect(offices['parrish-fl']).toEqual([]);
  });
});
