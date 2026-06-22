const { discoverCompetitors, _internals } = require('../services/seo/competitor-discovery');

function fakeDfs(organic, maps) {
  return {
    serpOrganic: async () => ({ tasks: [{ result: [{ items: organic }] }] }),
    serpMaps: async () => ({ tasks: [{ result: [{ items: maps }] }] }),
  };
}

describe('competitor-discovery', () => {
  test('filters directories/gov/own, keeps service businesses, aggregates across markets+sources', async () => {
    const dfs = fakeDfs(
      [
        { type: 'organic', domain: 'www.turnerpest.com', rank_absolute: 1 },
        { type: 'organic', domain: 'www.yelp.com', rank_absolute: 2 },        // directory
        { type: 'organic', domain: 'fdacs.gov', rank_absolute: 3 },           // gov
        { type: 'organic', domain: 'www.wavespestcontrol.com', rank_absolute: 4 }, // own
        { type: 'organic', domain: 'goodnewspestsolutions.com', rank_absolute: 5 },
        { type: 'organic', domain: 'www.orkin.com', rank_absolute: 6 },       // national franchise → tagged, sorted last
        { type: 'people_also_ask' },                                          // non-organic, ignored
      ],
      [
        { domain: 'turnerpest.com', rank_absolute: 1 },
        { domain: 'facebook.com', rank_absolute: 2 },                         // social
      ],
    );
    const markets = [{ label: 'Bradenton', location: 'x' }, { label: 'Sarasota', location: 'y' }];
    const found = await discoverCompetitors({ markets, keywords: ['pest control'], dfs });
    const domains = found.map((f) => f.domain);

    expect(domains).toContain('turnerpest.com');
    expect(domains).toContain('goodnewspestsolutions.com');
    expect(domains).not.toContain('yelp.com');
    expect(domains).not.toContain('fdacs.gov');
    expect(domains).not.toContain('wavespestcontrol.com');
    expect(domains).not.toContain('facebook.com');

    // turnerpest: organic+maps × 2 markets = 4 appearances, best pos 1 → ranked first
    expect(found[0].domain).toBe('turnerpest.com');
    expect(found[0].appearances).toBe(4);
    expect(found[0].markets.sort()).toEqual(['Bradenton', 'Sarasota']);
    expect(found[0].sources.sort()).toEqual(['maps', 'organic']);

    // orkin is tagged national and sorted after the local independents
    const orkin = found.find((f) => f.domain === 'orkin.com');
    expect(orkin.national).toBe(true);
    expect(found[found.length - 1].domain).toBe('orkin.com');
    expect(found.filter((f) => !f.national).every((f, i, arr) => true)).toBe(true);
  });

  test('isNationalChain tags franchises incl. subdomains', () => {
    expect(_internals.isNationalChain('orkin.com')).toBe(true);
    expect(_internals.isNationalChain('locations.trulynolen.com')).toBe(true);
    expect(_internals.isNationalChain('turnerpest.com')).toBe(false);
  });

  test('isNonCompetitor classification', () => {
    const f = _internals.isNonCompetitor;
    expect(f('yelp.com')).toBe(true);
    expect(f('fdacs.gov')).toBe(true);
    expect(f('wavespestcontrol.com')).toBe(true);
    expect(f('bradenton.wavespestcontrol.com')).toBe(true); // brand substring
    expect(f('localhost')).toBe(true);                      // no dot
    expect(f('turnerpest.com')).toBe(false);
    expect(f('goodnewspestsolutions.com')).toBe(false);
  });

  test('excludes the canonical Waves spoke fleet (own sites, not competitors)', () => {
    const f = _internals.isNonCompetitor;
    expect(f('bradentonflpestcontrol.com')).toBe(true);
    expect(f('sarasotafllawncare.com')).toBe(true);
    expect(f('waveslawncare.com')).toBe(true);
    expect(f('veniceexterminator.com')).toBe(true);
    expect(f('www.parrishpestcontrol.com'.replace(/^www\./, ''))).toBe(true);
  });

  test('normHost strips www/m and scheme', () => {
    expect(_internals.normHost('https://www.Foo.com/x')).toBe('foo.com');
    expect(_internals.normHost('m.yelp.com')).toBe('yelp.com');
  });
});
