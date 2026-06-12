const {
  geoBucket, isBrandQuery, classifyService, coveredBySitemap, keywordTokens,
  singular, scoreGap, dedupeKeyFor, parseRankedKeywords,
} = require('../services/seo/competitor-gap-miner')._internals;

function slugSets(slugs) {
  return slugs.map((slug) => new Set(slug.split(/[/-]/).filter(Boolean).map(singular)));
}

describe('competitor-gap-miner internals', () => {
  test('geoBucket: palmetto-the-bug is generic, Palmetto-the-city is our geo', () => {
    expect(geoBucket('palmetto bugs vs cockroaches')).toBe('generic');
    expect(geoBucket('palmetto roach')).toBe('generic');
    expect(geoBucket('pest control palmetto')).toBe('our_geo');
    expect(geoBucket('lawn care sarasota')).toBe('our_geo');
    expect(geoBucket('englewood pest control')).toBe('our_geo');
    expect(geoBucket('pest control jacksonville')).toBe('other_metro');
    expect(geoBucket('sand fleas')).toBe('generic');
  });

  test('isBrandQuery catches tracked and national competitor brands', () => {
    expect(isBrandQuery('good news pest control venice')).toBe(true);
    expect(isBrandQuery('turner pest control sarasota')).toBe(true);
    expect(isBrandQuery('orkin prices')).toBe(true);
    expect(isBrandQuery('banana spiders in florida')).toBe(false);
  });

  test('classifyService maps keywords to engine service ids', () => {
    expect(classifyService('rats in florida')).toBe('rodent');
    expect(classifyService('chinch bug damage')).toBe('lawn');
    expect(classifyService('termite swarm season')).toBe('termite');
    expect(classifyService('mosquito bites at dusk')).toBe('mosquito');
    expect(classifyService('palmetto bugs vs cockroaches')).toBe('pest');
  });

  test('coveredBySitemap: whole-segment matching, no substring false positives', () => {
    const sets = slugSets([
      'cockroach-control-palmetto-fl',
      'pest-control/get-rid-of-fruit-flies',
      'lawn-care-sarasota-fl',
    ]);
    // 'roach' must NOT match inside the 'cockroach' segment
    expect(coveredBySitemap('palmetto roaches', sets)).toBe(false);
    expect(coveredBySitemap('palmetto bugs vs cockroaches', sets)).toBe(false);
    // plural/singular equivalence: flies → fly on both sides
    expect(coveredBySitemap('how to get rid of fruit flies', sets)).toBe(true);
    expect(coveredBySitemap('lawn care sarasota', sets)).toBe(true);
    expect(coveredBySitemap('sand fleas', sets)).toBe(false);
  });

  test('coveredBySitemap never suppresses single-token topics', () => {
    // "rats in florida" collapses to ['rat'] after stopword removal — a
    // rat how-to slug must not suppress the distinct species-guide intent
    const sets = slugSets(['get-rid-of-rats-bradenton', 'rodent-control-sarasota-fl']);
    expect(coveredBySitemap('rats in florida', sets)).toBe(false);
    // zero meaningful tokens still drops (can't dedupe)
    expect(coveredBySitemap('the in of', sets)).toBe(true);
  });

  test('keywordTokens drops stopwords and singularizes', () => {
    expect(keywordTokens('what do cockroach eggs look like')).toEqual(['cockroach', 'egg', 'look', 'like']);
    expect(keywordTokens('brown widow vs black widow')).toEqual(['brown', 'widow', 'black', 'widow']);
  });

  test('scoreGap: real gaps clear the 45 blog floor, thin ones do not', () => {
    // 12k volume, competitor top-10 → well above floor
    expect(scoreGap({ volume: 12000, competitorPosition: 5, geo: 'generic' }).score).toBeGreaterThanOrEqual(45);
    // 1k volume, top-10 → just clears
    expect(scoreGap({ volume: 1000, competitorPosition: 9, geo: 'generic' }).score).toBeGreaterThanOrEqual(45);
    // low volume, page-2 competitor, no FL angle → under the floor
    expect(scoreGap({ volume: 200, competitorPosition: 14, geo: 'generic' }).score).toBeLessThan(45);
    // never reaches the 75 non-blog floor by construction
    expect(scoreGap({ volume: 200000, competitorPosition: 1, geo: 'our_geo' }).score).toBeLessThan(75);
  });

  test('dedupeKeyFor is stable and service-aware', () => {
    expect(dedupeKeyFor('rats in florida')).toBe('competitor_gap::rodent::_::rats in florida');
    expect(dedupeKeyFor('sand fleas')).toBe(dedupeKeyFor('sand fleas'));
  });

  test('parseRankedKeywords tolerates missing/empty Labs payloads', () => {
    expect(parseRankedKeywords(null)).toEqual([]);
    expect(parseRankedKeywords({ tasks: [{ result: null }] })).toEqual([]);
    const parsed = parseRankedKeywords({
      tasks: [{ result: [{ items: [{
        keyword_data: { keyword: 'sand fleas', keyword_info: { search_volume: 110000 } },
        ranked_serp_element: { serp_item: { type: 'organic', rank_group: 8, relative_url: '/blog/sand-fleas-what-are-they/' } },
      }] }] }],
    });
    expect(parsed).toEqual([{ keyword: 'sand fleas', volume: 110000, position: 8, url: '/blog/sand-fleas-what-are-they/' }]);
  });

  test('parseRankedKeywords drops paid rows — only organic counts as evidence', () => {
    const parsed = parseRankedKeywords({
      tasks: [{ result: [{ items: [
        {
          keyword_data: { keyword: 'pest control ad term', keyword_info: { search_volume: 5000 } },
          ranked_serp_element: { serp_item: { type: 'paid', rank_group: 1, relative_url: '/landing/' } },
        },
        {
          keyword_data: { keyword: 'plaster bagworms', keyword_info: { search_volume: 1000 } },
          ranked_serp_element: { serp_item: { type: 'organic', rank_group: 11, relative_url: '/plaster-bagworms/' } },
        },
      ] }] }],
    });
    expect(parsed).toEqual([{ keyword: 'plaster bagworms', volume: 1000, position: 11, url: '/plaster-bagworms/' }]);
  });
});
