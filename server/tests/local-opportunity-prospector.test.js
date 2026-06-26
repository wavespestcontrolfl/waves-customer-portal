const { discoverLocalOpportunities, excludeOwned, isReliablyClassified, OPPORTUNITY_QUERIES, _internals } = require('../services/seo/local-opportunity-prospector');

// Inject a dfs whose serpOrganic returns canned items keyed by the keyword, so we
// can assert per-query routing + exclusion without any network.
function fakeDfs(byKeyword) {
  return {
    serpOrganic: async (keyword) => ({ tasks: [{ result: [{ items: byKeyword[keyword] || [] }] }] }),
    // never called by this module (organic-only), present so a stray call wouldn't throw
    serpMaps: async () => ({ tasks: [{ result: [{ items: [] }] }] }),
  };
}

describe('local-opportunity-prospector', () => {
  test('runs each query template per market and tags discovered domains by type', async () => {
    const markets = [{ label: 'Venice', location: 'v' }];
    const queries = [
      { type: 'sponsorship', tmpl: (c) => `${c} little league sponsors` },
      { type: 'chamber', tmpl: (c) => `${c} chamber of commerce member directory` },
    ];
    const dfs = fakeDfs({
      'Venice little league sponsors': [
        { type: 'organic', domain: 'veniceyouthbaseball.org', url: 'https://veniceyouthbaseball.org/sponsors', title: 'Our Sponsors', rank_absolute: 1 },
        { type: 'organic', domain: 'www.facebook.com', url: 'https://facebook.com/x', rank_absolute: 2 }, // platform → excluded
      ],
      'Venice chamber of commerce member directory': [
        { type: 'organic', domain: 'venicechamber.com', url: 'https://venicechamber.com/members', title: 'Member Directory', rank_absolute: 1 },
        { type: 'people_also_ask' }, // non-organic → ignored
      ],
    });

    const found = await discoverLocalOpportunities({ markets, queries, dfs });
    const domains = found.map((f) => f.domain);

    expect(domains).toContain('veniceyouthbaseball.org');
    expect(domains).toContain('venicechamber.com');
    expect(domains).not.toContain('facebook.com');

    const league = found.find((f) => f.domain === 'veniceyouthbaseball.org');
    expect(league.opportunity_type).toBe('sponsorship');
    expect(league.source_url).toBe('https://veniceyouthbaseball.org/sponsors'); // landing page preserved for the scorer
    expect(league.markets).toEqual(['Venice']);

    const chamber = found.find((f) => f.domain === 'venicechamber.com');
    expect(chamber.opportunity_type).toBe('chamber');
  });

  test('aggregates a domain across markets/queries and sorts most-cross-market first', async () => {
    const markets = [{ label: 'Bradenton', location: 'b' }, { label: 'Sarasota', location: 's' }];
    const queries = [
      { type: 'event', tmpl: (c) => `${c} 5k run sponsors` },
      { type: 'community', tmpl: (c) => `${c} community calendar` },
    ];
    // A regional outlet shows up for both queries in both markets (4 appearances);
    // a one-off league shows up once.
    const outlet = { type: 'organic', domain: 'mysuncoast.com', url: 'https://mysuncoast.com/events', title: 'Events', rank_absolute: 3 };
    const dfs = fakeDfs({
      'Bradenton 5k run sponsors': [outlet, { type: 'organic', domain: 'bradentonrunners.org', rank_absolute: 1 }],
      'Bradenton community calendar': [outlet],
      'Sarasota 5k run sponsors': [outlet],
      'Sarasota community calendar': [outlet],
    });

    const found = await discoverLocalOpportunities({ markets, queries, dfs });

    expect(found[0].domain).toBe('mysuncoast.com'); // 4 appearances → ranked first
    expect(found[0].appearances).toBe(4);
    expect(found[0].markets.sort()).toEqual(['Bradenton', 'Sarasota']);
    expect(found[0].opportunity_types.sort()).toEqual(['community', 'event']);

    const league = found.find((f) => f.domain === 'bradentonrunners.org');
    expect(league.appearances).toBe(1);
  });

  test('isExcludedHost drops platforms/own/national chains but KEEPS chambers, leagues, news, .org/.edu', () => {
    const f = _internals.isExcludedHost;
    // excluded
    expect(f('facebook.com')).toBe(true);
    expect(f('eventbrite.com')).toBe(true);          // event platform
    expect(f('open.spotify.com')).toBe(true);         // podcast platform (subdomain)
    expect(f('yelp.com')).toBe(true);
    expect(f('orkin.com')).toBe(true);                // national franchise
    expect(f('wavespestcontrol.com')).toBe(true);     // own
    expect(f('bradentonflpestcontrol.com')).toBe(true); // own spoke
    expect(f('localhost')).toBe(true);                // no dot
    // KEPT — these are the targets the competitor harvest filters OUT
    expect(f('manateechamber.com')).toBe(false);
    expect(f('venicechamber.com')).toBe(false);
    expect(f('veniceyouthbaseball.org')).toBe(false);
    expect(f('mysuncoast.com')).toBe(false);          // local news / community calendar
    expect(f('manateeschools.net')).toBe(false);      // high school athletics
    expect(f('scgov.net')).toBe(false);               // county community calendar
  });

  test('query catalog covers every requested opportunity category', () => {
    const types = new Set(OPPORTUNITY_QUERIES.map((q) => q.type));
    expect(types).toEqual(new Set(['sponsorship', 'event', 'chamber', 'community', 'podcast']));
  });

  test('fetches all market×query SERPs through a bounded concurrency pool', async () => {
    let inFlight = 0, maxInFlight = 0, calls = 0;
    const dfs = {
      serpOrganic: async () => {
        calls++; inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return { tasks: [{ result: [{ items: [] }] }] };
      },
      serpMaps: async () => ({ tasks: [{ result: [{ items: [] }] }] }),
    };
    const markets = [{ label: 'A', location: 'a' }, { label: 'B', location: 'b' }];
    const queries = Array.from({ length: 5 }, (_, i) => ({ type: 'community', tmpl: (c) => `${c} q${i}` }));
    await discoverLocalOpportunities({ markets, queries, concurrency: 3, dfs });
    expect(calls).toBe(10);                    // every market×query issued (2×5)
    expect(maxInFlight).toBeLessThanOrEqual(3); // never exceeds the pool size
    expect(maxInFlight).toBeGreaterThan(1);     // genuinely ran in parallel (not serial)
  });

  test('excludeOwned drops domains we already have an active link from', () => {
    const candidates = [
      { domain: 'veniceyouthbaseball.org' },
      { domain: 'mysuncoast.com' },   // already an active backlink
      { domain: 'wavespestcontrol.com' }, // ourselves
    ];
    const owned = new Set(['mysuncoast.com', 'wavespestcontrol.com']);
    expect(excludeOwned(candidates, owned).map((c) => c.domain)).toEqual(['veniceyouthbaseball.org']);
    // empty/absent owned set is a no-op
    expect(excludeOwned(candidates, new Set())).toBe(candidates);
    expect(excludeOwned(candidates, null)).toBe(candidates);
  });

  test('isReliablyClassified holds back heuristic-fallback rows (would mis-route to outreach)', () => {
    // A chamber under heuristic fallback classifies as intent 'unknown' → 'resource'
    // → outreach lane; we must NOT auto-promote that (the drafter would cold-email it).
    expect(isReliablyClassified({ classification: { reason: 'heuristic' } })).toBe(false);
    // An LLM-classified row (reason carries the model's text) is trustworthy.
    expect(isReliablyClassified({ classification: { reason: 'local chamber member directory' } })).toBe(true);
    expect(isReliablyClassified({ classification: { reason: 'llm' } })).toBe(true);
    // Only an explicit 'heuristic' reason holds a row back; a real scoreCandidates
    // result always carries a classification, so absence is theoretical → not held.
    expect(isReliablyClassified({})).toBe(true);
  });
});
