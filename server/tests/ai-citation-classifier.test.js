/**
 * ai-citation-classifier — pure, deterministic classification of a cited URL
 * into the seven AEO discovery-feeder categories.
 */
const { classifyUrl, isLocallyRelevant, isProviderIntentQuestion, ENQUEUABLE_CATEGORIES } = require('../services/seo/ai-citation-classifier');

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
      // owner review 2026-09-28: local directory / "best of" marketplaces
      // cited on real provider questions ("best pest control in Sarasota")
      'https://www.cityvetted.com/fl/sarasota/pest-control',
      'https://www.exterminatorguild.com/directory/waves-pest-control',
      'https://www.homversa.com/best-pest-control-sarasota-fl',
      'https://www.lawnstarter.com/fl/sarasota-fl/pest-control',
      'https://www.lawnlove.com/lawn-care/fl/sarasota',
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
      // owner review 2026-09-28: cited local-recommendation editorial sites
      'https://www.floridist.com/best-pest-control-sarasota',
      'https://www.smarfle.com/sarasota-fl/pest-control',
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

  // Owner review 2026-09-28: real cited domains from competitor-gap-miner.js's
  // DEFAULT_COMPETITOR_DOMAINS (imported live via its `competitorDomains`
  // getter, never re-typed) were falling through to `other` — Turner is the
  // #1 competitor AI engines name (48x) and was among them.
  test('competitor-gap-miner.js\'s tracked local independents classify as competitor', () => {
    for (const url of [
      'https://www.turnerpest.com/locations/sarasota-fl',
      'https://www.westfallspestcontrol.com/service-area/sarasota',
      'https://www.farrowpestservices.com/sarasota-fl',
      'https://www.hughes-exterminators.com/sarasota',
      'https://www.kellerspestcontrol.com/sarasota-fl',
      'https://www.nativepestmanagement.com/sarasota-fl',
    ]) {
      expect(classifyUrl(url).category).toBe('competitor');
    }
  });

  test('an env override to COMPETITOR_GAP_DOMAINS is picked up live (the getter, read fresh per call — never cached at module load)', () => {
    const prev = process.env.COMPETITOR_GAP_DOMAINS;
    // Baseline: unrelated to any tracked list, so it starts as `other`.
    expect(classifyUrl('https://someneweditorcompetitor.example/sarasota').category).toBe('other');
    try {
      process.env.COMPETITOR_GAP_DOMAINS = 'someneweditorcompetitor.example';
      expect(classifyUrl('https://someneweditorcompetitor.example/sarasota').category).toBe('competitor');
    } finally {
      if (prev === undefined) delete process.env.COMPETITOR_GAP_DOMAINS; else process.env.COMPETITOR_GAP_DOMAINS = prev;
    }
    // and it reverts once the override is gone
    expect(classifyUrl('https://someneweditorcompetitor.example/sarasota').category).toBe('other');
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

  // Owner review 2026-09-28: real cited local "best-of"/directory pages
  // (cityvetted.com, exterminatorguild.com, homversa.com, smarfle.com,
  // floridist.com and unlisted peers) mostly showed up on PROVIDER-intent
  // questions ("best pest control in Sarasota"). Domains named explicitly
  // above already classify without the heuristic; this covers the LONG TAIL
  // no static list will ever fully enumerate.
  describe('provider-intent listicle heuristic (subtype: listicle_candidate)', () => {
    const PROVIDER_BENCHMARK = { intent: 'provider', query: 'Who is the best pest control company in Sarasota FL?' };
    const PROVIDER_TEXT_ONLY = { intent: null, query: 'What is the top rated pest control company near Bradenton?' };
    const NON_PROVIDER = { intent: 'identify', query: 'How can I tell ghost ants from other small ants in Sarasota?' };

    test('an otherwise-other, non-competitor URL with a LOCAL token, cited on a provider question, becomes editorial/listicle_candidate', () => {
      const r = classifyUrl('https://www.unknownlocaldirectory.example/best-pest-control-sarasota-fl', { providerIntent: true });
      expect(r).toMatchObject({ category: 'editorial', subtype: 'listicle_candidate' });
      expect(r.rule).toMatch(/^heuristic:listicle_candidate:/);
    });

    test('an otherwise-other URL with a BEST/TOP/RATED/NEAR-ME token (no local geo term), cited on a provider question, also qualifies', () => {
      for (const url of [
        'https://www.unknownlocaldirectory.example/best-pest-control-companies',
        'https://www.unknownlocaldirectory.example/top-pest-control-companies',
        'https://www.unknownlocaldirectory.example/rated-pest-control',
        'https://www.unknownlocaldirectory.example/pest-control-near-me',
      ]) {
        expect(classifyUrl(url, { providerIntent: true })).toMatchObject({ category: 'editorial', subtype: 'listicle_candidate' });
      }
    });

    test('isProviderIntentQuestion: benchmark intent OR who/best/top/company in the query text', () => {
      expect(isProviderIntentQuestion(PROVIDER_BENCHMARK)).toBe(true);
      expect(isProviderIntentQuestion(PROVIDER_TEXT_ONLY)).toBe(true);
      expect(isProviderIntentQuestion(NON_PROVIDER)).toBe(false);
      expect(isProviderIntentQuestion(null)).toBe(false);
    });

    test('negative: a non-provider question leaves an otherwise-other URL as other, even with local/best tokens', () => {
      const r = classifyUrl('https://www.unknownlocaldirectory.example/best-pest-control-sarasota-fl', { providerIntent: false });
      expect(r).toEqual({ category: 'other', host: 'unknownlocaldirectory.example', rule: 'unmatched' });
      expect(r.subtype).toBeUndefined();
    });

    test('negative: a provider question with NO local or best/top/rated/near-me token stays other', () => {
      const r = classifyUrl('https://www.unknownlocaldirectory.example/pest-control-companies', { providerIntent: true });
      expect(r.category).toBe('other');
      expect(r.subtype).toBeUndefined();
    });

    test('the heuristic NEVER overrides owned, competitor, reference, or community_video — even with a local/best token and providerIntent true', () => {
      expect(classifyUrl('https://www.wavespestcontrol.com/best-pest-control-sarasota', { providerIntent: true }).category).toBe('owned');
      expect(classifyUrl('https://www.orkin.com/best-pest-control-sarasota', { providerIntent: true }).category).toBe('competitor');
      expect(classifyUrl('https://en.wikipedia.org/wiki/Best_pest_control', { providerIntent: true }).category).toBe('reference');
      expect(classifyUrl('https://www.reddit.com/r/pestcontrol/best-pest-control-sarasota', { providerIntent: true }).category).toBe('community_video');
    });

    test('the heuristic never touches a host that already matched a domain-list category', () => {
      // bbb.org is `listing` by domain match regardless of providerIntent — never carries subtype
      const r = classifyUrl('https://www.bbb.org/us/fl/sarasota/profile/pest-control/waves', { providerIntent: true });
      expect(r).toMatchObject({ category: 'listing', rule: 'listing_domain' });
      expect(r.subtype).toBeUndefined();
    });

    test('a facebook.com post (excluded path) still gets the heuristic on a provider question with a local token', () => {
      const r = classifyUrl('https://www.facebook.com/somegroup/posts/12345?text=best+pest+control+sarasota', { providerIntent: true });
      expect(r).toMatchObject({ category: 'editorial', subtype: 'listicle_candidate' });
    });

    test('providerIntent defaults to false when omitted — byte-identical to pre-heuristic behavior', () => {
      const r = classifyUrl('https://www.unknownlocaldirectory.example/best-pest-control-sarasota-fl');
      expect(r).toEqual({ category: 'other', host: 'unknownlocaldirectory.example', rule: 'unmatched' });
    });
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
