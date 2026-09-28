/**
 * ai-citation-classifier — pure, deterministic classification of a cited URL
 * into the seven AEO discovery-feeder categories.
 */
const { classifyUrl, isLocallyRelevant, ENQUEUABLE_CATEGORIES } = require('../services/seo/ai-citation-classifier');

describe('classifyUrl', () => {
  test('owned: a wavespestcontrol.com citation is owned, never a discovery candidate', () => {
    expect(classifyUrl('https://www.wavespestcontrol.com/pest-control/bradenton').category).toBe('owned');
  });

  test('listing domains', () => {
    for (const url of [
      'https://www.bbb.org/us/fl/venice/profile/pest-control/waves-pest-control',
      'https://www.yelp.com/biz/waves-pest-control-venice',
      'https://www.angi.com/companylist/us/fl/venice/waves-pest-control-reviews.htm',
      'https://www.homeadvisor.com/rated.WavesPestControl.12345.html',
      'https://nextdoor.com/pages/waves-pest-control-venice-fl',
      'https://www.birdeye.com/waves-pest-control',
      'https://reviews.birdeye.com/waves-pest-control', // subdomain suffix match
      'https://www.thumbtack.com/fl/venice/pest-control/waves-pest-control',
      'https://www.yellowpages.com/venice-fl/mip/waves-pest-control',
      'https://www.yp.com/venice-fl/mip/waves-pest-control',
      'https://www.superpages.com/venice-fl/waves-pest-control',
      'https://www.mapquest.com/us/florida/waves-pest-control',
      'https://www.manta.com/c/waves-pest-control',
      'https://flpma.org/AF_MemberDirectory.asp', // owner correction: the real FPMA
      'https://npmapestworld.org/find-a-pro/waves-pest-control',
      'https://www.pestworld.org/find-a-pro/waves-pest-control',
      'https://www.qualitypro.com/directory/waves-pest-control',
      'https://www.chamberofcommerce.com/united-states/florida/venice/waves-pest-control',
      'https://www.manateechamber.com/list/member/waves-pest-control',
      'https://www.floridarealtors.org/directory/waves-pest-control',
      'https://www.expertise.com/fl/venice/pest-control',
      'https://www.threebestrated.com/pest-control-in-venice-fl',
      'https://bestprosintown.com/pest-control-venice-fl',
    ]) {
      expect(classifyUrl(url).category).toBe('listing');
    }
  });

  test('facebook.com: a business PAGE is listing, a post/photo/video is not', () => {
    expect(classifyUrl('https://www.facebook.com/WavesPestControlVenice').category).toBe('listing');
    expect(classifyUrl('https://www.facebook.com/WavesPestControlVenice/posts/12345').category).toBe('other');
    expect(classifyUrl('https://www.facebook.com/WavesPestControlVenice/photos/a.12345').category).toBe('other');
    expect(classifyUrl('https://www.facebook.com/watch/?v=12345').category).toBe('other');
  });

  test('editorial: SWFL local news and home-services listicles', () => {
    for (const url of [
      'https://www.heraldtribune.com/story/news/local/2026/09/01/pest-control-tips',
      'https://www.bradenton.com/news/local/article12345.html',
      'https://www.yourobserver.com/news/2026/sep/pest-control-tips',
      'https://patch.com/florida/venice/pest-control-tips',
      'https://www.mysuncoast.com/2026/09/01/pest-control-tips',
      'https://www.wfla.com/news/pest-control-tips',
      'https://www.fox13news.com/news/pest-control-tips',
      'https://www.winknews.com/2026/09/01/pest-control-tips',
      'https://www.todayshomeowner.com/pest-control/guides/best-pest-control-companies',
      'https://www.bobvila.com/articles/best-pest-control-companies',
      'https://www.thespruce.com/best-pest-control-companies-12345',
    ]) {
      expect(classifyUrl(url).category).toBe('editorial');
    }
  });

  test('forbes.com: /home-improvement is editorial, everything else is not', () => {
    expect(classifyUrl('https://www.forbes.com/home-improvement/pest-control/best-companies/').category).toBe('editorial');
    expect(classifyUrl('https://www.forbes.com/sites/someauthor/2026/09/01/pest-control-stocks/').category).toBe('other');
  });

  test('reference: .edu, .gov, wikipedia.org', () => {
    expect(classifyUrl('https://ifas.ufl.edu/publications/pest-control').category).toBe('reference');
    expect(classifyUrl('https://www.epa.gov/pesticides').category).toBe('reference');
    expect(classifyUrl('https://en.wikipedia.org/wiki/Pest_control').category).toBe('reference');
  });

  test('competitor: national chains + the owner-corrected flapest.com + hometeampestdefense.com', () => {
    for (const url of [
      'https://www.orkin.com/locations/fl/venice',
      'https://www.terminix.com/locations/fl/venice',
      'https://www.trugreen.com/locations/fl/venice',
      'https://www.trulynolen.com/locations/fl/venice',
      'https://www.masseyservices.com/locations/fl/venice',
      'https://www.hometeampestdefense.com/locations/fl/venice',
      // owner correction 2026-09-27: flapest.com is Florida Pest Control, a
      // company (since 1949), NOT the Florida Pest Management Association —
      // this must never regress to `listing`.
      'https://www.flapest.com/locations/venice',
    ]) {
      expect(classifyUrl(url).category).toBe('competitor');
    }
  });

  test('community_video: reddit, youtube, quora', () => {
    expect(classifyUrl('https://www.reddit.com/r/pestcontrol/comments/12345').category).toBe('community_video');
    expect(classifyUrl('https://www.youtube.com/watch?v=abc123').category).toBe('community_video');
    expect(classifyUrl('https://www.quora.com/Whats-the-best-pest-control-company').category).toBe('community_video');
  });

  test('other: an unmatched domain falls through', () => {
    expect(classifyUrl('https://www.random-blog-example.test/pest-control-tips').category).toBe('other');
  });

  test('unparseable URL returns null', () => {
    expect(classifyUrl('not a url')).toBeNull();
  });

  test('ENQUEUABLE_CATEGORIES is exactly listing + editorial', () => {
    expect(ENQUEUABLE_CATEGORIES).toEqual(['listing', 'editorial']);
  });
});

describe('isLocallyRelevant', () => {
  test('a known SWFL local-news host is relevant regardless of path', () => {
    expect(isLocallyRelevant('https://www.heraldtribune.com/anything')).toBe(true);
  });
  test('a geo term in the path makes a non-local host relevant', () => {
    expect(isLocallyRelevant('https://www.bbb.org/us/fl/venice/profile/pest-control/waves')).toBe(true);
    expect(isLocallyRelevant('https://www.expertise.com/fl/sarasota/pest-control')).toBe(true);
  });
  test('a national host with no geo signal is not locally relevant', () => {
    expect(isLocallyRelevant('https://www.forbes.com/sites/someauthor/2026/09/01/pest-control-stocks/')).toBe(false);
  });
  test('an unparseable URL is not relevant', () => {
    expect(isLocallyRelevant('not a url')).toBe(false);
  });
});
