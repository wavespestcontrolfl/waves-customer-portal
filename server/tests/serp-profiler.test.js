/**
 * Unit tests for serp-profiler pure helpers. No DataForSEO calls.
 *
 * Fixtures are minimal hand-crafted SERP item arrays in the shape that
 * DataForSEO returns (organic, local_pack, people_also_ask, ai_overview).
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/seo/dataforseo', () => ({ configured: true, serpOrganic: jest.fn() }));

const {
  classifyResultPageType,
  getDominantPageType,
  classifyIntent,
  recommendAssetType,
  extractCtaPatterns,
  extractReviewPatterns,
  extractProofPatterns,
  computeDirectorySaturation,
  detectSerpGap,
  confidenceScore,
  extractTopOrganic,
  extractLocalPack,
  extractPaaQuestions,
  extractAiOverview,
  hasLocalPack,
  brandedMatch,
  resolveLocation,
} = require('../services/seo/serp-profiler')._internals;

// ── classifyResultPageType ───────────────────────────────────────────

describe('classifyResultPageType', () => {
  test.each([
    [{ url: 'https://www.example.com/pest-control-bradenton-fl/', domain: 'example.com' }, 'city-service'],
    [{ url: 'https://www.example.com/lawn-care-lakewood-ranch-fl/', domain: 'example.com' }, 'city-service'],
    [{ url: 'https://www.example.com/services/pest-control/', domain: 'example.com' }, 'service'],
    [{ url: 'https://www.example.com/blog/get-rid-of-ants/', domain: 'example.com' }, 'blog'],
    [{ url: 'https://www.yelp.com/biz/something', domain: 'yelp.com' }, 'directory'],
    [{ url: 'https://www.angi.com/companylist/x', domain: 'angi.com' }, 'directory'],
    [{ url: 'https://sfyl.ifas.ufl.edu/manatee/', domain: 'sfyl.ifas.ufl.edu' }, 'public-health'],
    [{ url: 'https://www.cdc.gov/healthypets/', domain: 'cdc.gov' }, 'public-health'],
    [{ url: 'https://www.example.com/faq/', domain: 'example.com' }, 'faq'],
    [{ url: 'https://www.example.com/', domain: 'example.com' }, 'home'],
    [{ url: 'https://www.example.com/about/', domain: 'example.com' }, 'page'],
  ])('%j → %s', (input, expected) => {
    expect(classifyResultPageType(input)).toBe(expected);
  });

  test('handles missing url gracefully', () => {
    expect(classifyResultPageType(null)).toBe('unknown');
    expect(classifyResultPageType({})).toBe('unknown');
  });
});

// ── getDominantPageType ──────────────────────────────────────────────

describe('getDominantPageType', () => {
  test('returns most-frequent type + share', () => {
    const types = ['blog', 'blog', 'blog', 'city-service', 'directory'];
    expect(getDominantPageType(types)).toEqual({ type: 'blog', share: 0.6 });
  });
  test('handles single type', () => {
    expect(getDominantPageType(['city-service'])).toEqual({ type: 'city-service', share: 1 });
  });
  test('handles empty', () => {
    expect(getDominantPageType([])).toEqual({ type: 'unknown', share: 0 });
  });
});

// ── classifyIntent ───────────────────────────────────────────────────

describe('classifyIntent', () => {
  test('emergency keyword in query wins', () => {
    expect(classifyIntent({
      query: 'emergency pest control bradenton',
      localPackPresent: true, topPageTypes: ['city-service'], aiOverviewPresent: false, hasBrandedMatch: false,
    })).toBe('emergency');
  });
  test('comparison signals (vs, best, top N)', () => {
    expect(classifyIntent({
      query: 'best pest control company bradenton',
      localPackPresent: false, topPageTypes: ['blog'], aiOverviewPresent: false, hasBrandedMatch: false,
    })).toBe('comparison');
  });
  test('branded match → navigational', () => {
    expect(classifyIntent({
      query: 'waves pest control bradenton',
      localPackPresent: true, topPageTypes: ['city-service'], aiOverviewPresent: false, hasBrandedMatch: true,
    })).toBe('navigational');
  });
  test('majority public-health → public-health', () => {
    expect(classifyIntent({
      query: 'palmetto bug bite symptoms',
      localPackPresent: false,
      topPageTypes: ['public-health', 'public-health', 'public-health', 'blog', 'blog'],
      aiOverviewPresent: false, hasBrandedMatch: false,
    })).toBe('public-health');
  });
  test('local pack present → transactional-local', () => {
    expect(classifyIntent({
      query: 'pest control bradenton',
      localPackPresent: true,
      topPageTypes: ['directory', 'city-service'],
      aiOverviewPresent: false, hasBrandedMatch: false,
    })).toBe('transactional-local');
  });
  test('majority blogs → informational', () => {
    expect(classifyIntent({
      query: 'how to identify a termite',
      localPackPresent: false,
      topPageTypes: ['blog', 'blog', 'blog', 'blog', 'faq', 'page'],
      aiOverviewPresent: true, hasBrandedMatch: false,
    })).toBe('informational');
  });
  test('mixed signals fall back to mixed', () => {
    expect(classifyIntent({
      query: 'exterminator near me',
      localPackPresent: false,
      topPageTypes: ['city-service', 'service', 'directory'],
      aiOverviewPresent: false, hasBrandedMatch: false,
    })).toBe('mixed');
  });
});

// ── recommendAssetType ───────────────────────────────────────────────

describe('recommendAssetType', () => {
  test.each([
    [{ intent: 'public-health', dominantPageType: 'public-health', localPackPresent: false }, 'do_not_publish'],
    [{ intent: 'navigational', dominantPageType: 'home', localPackPresent: true }, 'do_not_publish'],
    [{ intent: 'emergency', dominantPageType: 'directory', localPackPresent: true }, 'create_or_refresh_city_service_page'],
    [{ intent: 'transactional-local', dominantPageType: 'city-service', localPackPresent: true }, 'create_or_refresh_city_service_page'],
    [{ intent: 'informational', dominantPageType: 'faq', localPackPresent: false }, 'create_customer_question_page'],
    [{ intent: 'informational', dominantPageType: 'blog', localPackPresent: false }, 'new_supporting_blog'],
    [{ intent: 'comparison', dominantPageType: 'blog', localPackPresent: false }, 'new_supporting_blog'],
    [{ intent: 'mixed', dominantPageType: 'city-service', localPackPresent: true }, 'create_or_refresh_city_service_page'],
    [{ intent: 'mixed', dominantPageType: 'blog', localPackPresent: false }, 'new_supporting_blog'],
  ])('%j → %s', (input, expected) => {
    expect(recommendAssetType(input)).toBe(expected);
  });
});

// ── pattern extractors ───────────────────────────────────────────────

describe('extractCtaPatterns', () => {
  test('detects standard CTA copy', () => {
    const results = [
      { title: 'Free Inspection Today', description: 'Same-day pest control bradenton' },
      { title: 'Family-Safe Pest Control', description: 'Pet-safe, licensed and insured.' },
    ];
    const found = extractCtaPatterns(results);
    expect(found).toEqual(expect.arrayContaining([
      'free inspection', 'same-day', 'pet/family safe', 'licensed/insured',
    ]));
  });
  test('empty input', () => {
    expect(extractCtaPatterns([])).toEqual([]);
  });
});

describe('extractReviewPatterns', () => {
  test('counts ratings and review counts', () => {
    const results = [
      { title: 'Acme Pest ★ 4.8', description: 'Trusted by 500+ reviews' },
      { title: 'XYZ Co', description: '★★★★★ 1200 reviews' },
      { title: 'No reviews here', description: 'Plain description' },
    ];
    const r = extractReviewPatterns(results);
    expect(r.results_with_rating).toBe(2);
    expect(r.results_with_review_count).toBe(2);
    expect(r.review_count_samples).toEqual([500, 1200]);
  });
});

describe('extractProofPatterns', () => {
  test('finds quantified, family-owned, licensing claims', () => {
    const results = [
      { title: 'Since 1985', description: 'Family-owned. BBB accredited. 5000+ customers.' },
    ];
    const out = extractProofPatterns(results);
    expect(out).toEqual(expect.arrayContaining([
      'established date', 'family-owned', 'BBB accreditation', 'quantified claim',
    ]));
  });
});

describe('computeDirectorySaturation', () => {
  test('share of directory results', () => {
    expect(computeDirectorySaturation(['directory', 'directory', 'directory', 'city-service'])).toBe(0.75);
    expect(computeDirectorySaturation(['city-service'])).toBe(0);
    expect(computeDirectorySaturation([])).toBe(0);
  });
});

// ── detectSerpGap ────────────────────────────────────────────────────

describe('detectSerpGap', () => {
  test('flags directory-saturated SERPs', () => {
    const gap = detectSerpGap({
      topResults: [
        { url: 'https://yelp.com/x', domain: 'yelp.com' },
        { url: 'https://angi.com/x', domain: 'angi.com' },
        { url: 'https://thumbtack.com/x', domain: 'thumbtack.com' },
      ],
      dominantPageType: 'directory',
      intent: 'transactional-local',
    });
    expect(gap).toMatch(/aggregator directories/i);
  });
  test('flags transactional-local without city-service winner', () => {
    const gap = detectSerpGap({
      topResults: [{ url: 'https://example.com/blog/' }],
      dominantPageType: 'blog',
      intent: 'transactional-local',
    });
    expect(gap).toMatch(/transactional-local intent but top 10 lacks/i);
  });
  test('warns when public-health dominates informational SERP', () => {
    const gap = detectSerpGap({
      topResults: [{ url: 'https://cdc.gov/x' }],
      dominantPageType: 'public-health',
      intent: 'informational',
    });
    expect(gap).toMatch(/cannot displace \.gov/i);
  });
  test('returns null on healthy SERP', () => {
    const gap = detectSerpGap({
      topResults: [{ url: 'https://example.com/pest-control-bradenton-fl/' }],
      dominantPageType: 'city-service',
      intent: 'transactional-local',
    });
    expect(gap).toBeNull();
  });
});

// ── confidenceScore ──────────────────────────────────────────────────

describe('confidenceScore', () => {
  test('strong dominant + full results → high confidence', () => {
    const conf = confidenceScore({
      topPageTypes: Array(10).fill('city-service'),
      shareOfDominant: 1,
      totalItems: 10,
    });
    expect(conf).toBeGreaterThan(0.85);
  });
  test('few results + scattered types → low confidence', () => {
    const conf = confidenceScore({
      topPageTypes: ['blog', 'city-service'],
      shareOfDominant: 0.5,
      totalItems: 2,
    });
    expect(conf).toBeLessThan(0.7);
  });
  test('zero items → 0', () => {
    expect(confidenceScore({ topPageTypes: [], shareOfDominant: 0, totalItems: 0 })).toBe(0);
  });
});

// ── DataForSEO response parsing ──────────────────────────────────────

describe('extractTopOrganic', () => {
  test('filters to type=organic only and caps to limit', () => {
    const fixture = {
      items: [
        { type: 'paid', url: 'https://ad' },
        { type: 'organic', url: 'https://a', domain: 'www.a.com', title: 'A', rank_absolute: 1 },
        { type: 'organic', url: 'https://b', domain: 'www.b.com', title: 'B', rank_absolute: 2 },
        { type: 'people_also_ask' },
        { type: 'organic', url: 'https://c', domain: 'c.com', title: 'C', rank_absolute: 3 },
      ],
    };
    const out = extractTopOrganic(fixture, 2);
    expect(out).toHaveLength(2);
    expect(out[0].domain).toBe('a.com'); // www. stripped
    expect(out[1].domain).toBe('b.com');
  });
});

describe('extractLocalPack', () => {
  test('returns business list when present', () => {
    const fixture = {
      items: [
        { type: 'local_pack', items: [
          { title: 'Acme Pest', rating: { value: 4.8, votes_count: 500 }, domain: 'acme.com' },
          { title: 'XYZ', rating: { value: 4.5, votes_count: 200 } },
        ]},
      ],
    };
    const out = extractLocalPack(fixture);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ name: 'Acme Pest', rating: 4.8, review_count: 500 });
  });
  test('returns empty when no local_pack', () => {
    expect(extractLocalPack({ items: [] })).toEqual([]);
  });
});

describe('extractPaaQuestions', () => {
  test('extracts question titles', () => {
    const fixture = {
      items: [
        { type: 'people_also_ask', items: [
          { type: 'people_also_ask_element', title: 'Q1?' },
          { type: 'people_also_ask_element', title: 'Q2?' },
        ]},
      ],
    };
    expect(extractPaaQuestions(fixture)).toEqual(['Q1?', 'Q2?']);
  });
});

describe('extractAiOverview', () => {
  test('returns present + sources when AI Overview block exists', () => {
    const fixture = {
      items: [
        { type: 'ai_overview', items: [
          { url: 'https://a.com', domain: 'www.a.com', title: 'A' },
          { url: 'https://b.com', domain: 'b.com', title: 'B' },
        ]},
      ],
    };
    const out = extractAiOverview(fixture);
    expect(out.present).toBe(true);
    expect(out.sources).toHaveLength(2);
    expect(out.sources[0].domain).toBe('a.com');
  });
  test('returns present=false when absent', () => {
    expect(extractAiOverview({ items: [] })).toEqual({ present: false, sources: [] });
  });
});

describe('hasLocalPack + brandedMatch', () => {
  test('hasLocalPack reflects item type', () => {
    expect(hasLocalPack({ items: [{ type: 'organic' }] })).toBe(false);
    expect(hasLocalPack({ items: [{ type: 'local_pack' }, { type: 'organic' }] })).toBe(true);
  });
  test('brandedMatch detects waves brand match', () => {
    expect(brandedMatch('waves pest control bradenton', [{ domain: 'wavespestcontrol.com' }])).toBe(true);
    expect(brandedMatch('waves pest control bradenton', [{ domain: 'someoneelse.com' }])).toBe(false);
    expect(brandedMatch('pest control bradenton', [{ domain: 'wavespestcontrol.com' }])).toBe(false);
  });
});

// ── resolveLocation ──────────────────────────────────────────────────

describe('resolveLocation', () => {
  test('canonical city → DataForSEO format', () => {
    expect(resolveLocation('Bradenton')).toBe('Bradenton,Florida,United States');
    expect(resolveLocation('lakewood ranch')).toBe('Lakewood Ranch,Florida,United States');
  });
  test('unknown city falls back to Bradenton', () => {
    expect(resolveLocation('Tampa')).toBe('Bradenton,Florida,United States');
    expect(resolveLocation(null)).toBe('Bradenton,Florida,United States');
  });
});
