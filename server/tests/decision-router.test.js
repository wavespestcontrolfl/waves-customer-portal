/**
 * Unit tests for decision-router. Pure function — no DB.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { route, derivePageType } = require('../services/content/decision-router');
const { WEIGHTS, THRESHOLDS } = require('../services/content/scoring-config');

// Fixture helpers.
function opp(overrides = {}) {
  return {
    id: 'opp-1',
    bucket: 'striking_distance',
    action_type: 'new_supporting_blog',
    query: 'pest control bradenton',
    page_url: null,
    service: 'pest',
    city: 'Bradenton',
    score: 80,
    signal_metadata: {},
    ...overrides,
  };
}
function serp(overrides = {}) {
  return {
    dominant_intent: 'transactional-local',
    dominant_page_type: 'city-service',
    recommended_asset_type: 'create_or_refresh_city_service_page',
    local_pack_present: true,
    ai_overview_present: false,
    directory_saturation: 0.2,
    confidence: 0.85,
    payload: {},
    ...overrides,
  };
}

// ── intent-based hard blocks ────────────────────────────────────────

describe('public-health intent blocks publication', () => {
  test('blocks + requires human review', () => {
    const r = route(opp(), { serp_profile: serp({ dominant_intent: 'public-health' }) });
    expect(r.action_type).toBe('do_not_publish');
    expect(r.human_review_required).toBe(true);
    expect(r.human_review_reason).toMatch(/public-health/i);
    expect(r.score_breakdown.serpMismatch).toBeLessThan(0);
  });
});

describe('navigational intent blocks publication', () => {
  test('blocks + flags review', () => {
    const r = route(opp(), { serp_profile: serp({ dominant_intent: 'navigational' }) });
    expect(r.action_type).toBe('do_not_publish');
    expect(r.human_review_required).toBe(true);
  });
});

describe('SERP profiler explicit do_not_publish', () => {
  test('honors the recommendation', () => {
    const r = route(opp(), { serp_profile: serp({ recommended_asset_type: 'do_not_publish' }) });
    expect(r.action_type).toBe('do_not_publish');
    expect(r.human_review_required).toBe(true);
  });
});

// ── SERP recommendation overrides miner action ──────────────────────

describe('router upgrades action to match SERP recommendation', () => {
  test('miner says new_supporting_blog, SERP says city-service → city-service', () => {
    const r = route(
      opp({ action_type: 'new_supporting_blog' }),
      { serp_profile: serp({ recommended_asset_type: 'create_or_refresh_city_service_page' }) }
    );
    expect(r.action_type).toBe('create_or_refresh_city_service_page');
    expect(r.router_notes).toMatch(/upgraded action/);
  });
  test('does NOT override rewrite_title_meta (metadata is its own concern)', () => {
    const r = route(
      opp({ action_type: 'rewrite_title_meta', page_url: '/some-page/' }),
      { serp_profile: serp({ recommended_asset_type: 'create_or_refresh_city_service_page' }) }
    );
    expect(r.action_type).toBe('rewrite_title_meta');
  });
});

describe('terminal near-me guard (operator directive 2026-06-11)', () => {
  test('profiler recommendation cannot resurrect a blog action for a near-me query', () => {
    const r = route(
      opp({ action_type: 'do_not_publish', query: 'exterminator near me' }),
      { serp_profile: serp({ dominant_intent: 'mixed', dominant_page_type: 'blog', recommended_asset_type: 'new_supporting_blog' }) }
    );
    expect(r.action_type).toBe('do_not_publish');
    expect(r.human_review_required).toBe(true);
    expect(r.human_review_reason).toMatch(/never blog material/);
    expect(r.router_notes).toMatch(/transactional query routed away from blog lane/);
  });
  test('miner-emitted blog action on a near-me query is demoted even with no SERP profile', () => {
    const r = route(opp({ action_type: 'new_supporting_blog', query: 'rat removal near me' }), {});
    expect(r.action_type).toBe('do_not_publish');
    expect(r.human_review_required).toBe(true);
  });
  test('informational queries are untouched by the guard', () => {
    const r = route(opp({ action_type: 'new_supporting_blog', query: 'how to read a termite bond' }), {});
    expect(r.action_type).toBe('new_supporting_blog');
  });
  test('near-me queries upgraded to PAGE actions stay upgraded (guard is blog-specific)', () => {
    const r = route(
      opp({ action_type: 'new_supporting_blog', query: 'pest control near me' }),
      { serp_profile: serp({ recommended_asset_type: 'create_or_refresh_city_service_page' }) }
    );
    expect(r.action_type).toBe('create_or_refresh_city_service_page');
  });
});

// ── mismatch penalty ────────────────────────────────────────────────

describe('page-type mismatch penalty', () => {
  test('city-service action with informational SERP → partial penalty', () => {
    const r = route(
      opp({ action_type: 'create_or_refresh_city_service_page' }),
      { serp_profile: serp({ dominant_page_type: 'blog', recommended_asset_type: null }) }
    );
    expect(r.score_breakdown.serpMismatch).toBeLessThan(0);
    expect(r.router_notes).toMatch(/partial mismatch/);
  });
});

// ── serp_fit bonus for directory-saturated SERPs ────────────────────

describe('directory-saturated SERP grants serpFit bonus', () => {
  test('bonus applied when directory_saturation ≥ 0.5', () => {
    const r = route(opp(), { serp_profile: serp({ directory_saturation: 0.7 }) });
    expect(r.score_breakdown.serpFit).toBe(WEIGHTS.serpFit);
    expect(r.router_notes).toMatch(/serp_fit bonus/);
  });
});

// ── ai_overview penalty for informational actions ───────────────────

describe('AI Overview reduces informational uplift', () => {
  test('penalty applied to new_supporting_blog', () => {
    const r = route(
      opp({ action_type: 'new_supporting_blog' }),
      { serp_profile: serp({
          ai_overview_present: true,
          recommended_asset_type: null,
          dominant_page_type: 'blog',
        }),
      }
    );
    expect(r.score_breakdown.serpMismatch).toBeLessThan(0);
  });
});

// ── customer demand uplift ──────────────────────────────────────────

describe('customer signal bonuses', () => {
  test('full bonus at threshold', () => {
    const r = route(opp(), {
      customer_signal: { total_count: THRESHOLDS.customerClusterMinSize, funnel_stage: 'post-service' },
    });
    expect(r.score_breakdown.customerDemand).toBe(WEIGHTS.customerDemand);
  });
  test('partial bonus below threshold', () => {
    const r = route(opp(), {
      customer_signal: { total_count: Math.floor(THRESHOLDS.customerClusterMinSize / 2), funnel_stage: 'post-service' },
    });
    expect(r.score_breakdown.customerDemand).toBeGreaterThan(0);
    expect(r.score_breakdown.customerDemand).toBeLessThan(WEIGHTS.customerDemand);
  });
  test('reroutes supporting_blog → customer_question_page when pre-sale demand strong', () => {
    const r = route(
      opp({ action_type: 'new_supporting_blog' }),
      { customer_signal: { total_count: THRESHOLDS.customerClusterMinSize * 2, funnel_stage: 'pre-sale' } }
    );
    expect(r.action_type).toBe('create_customer_question_page');
    expect(r.router_notes).toMatch(/customer_question/);
  });
});

// ── conversion-feedback scoring ─────────────────────────────────────

describe('conversion feedback scores flow through', () => {
  test('all three scores added to breakdown', () => {
    const r = route(opp(), {
      conversion_feedback: {
        lead_quality_score: 15,
        close_rate_score: 8,
        revenue_realization_score: 12,
      },
    });
    expect(r.score_breakdown.leadQuality).toBe(15);
    expect(r.score_breakdown.closeRate).toBe(8);
    expect(r.score_breakdown.revenueRealization).toBe(12);
  });
});

// ── redundancy penalty for repeat briefs ────────────────────────────

describe('redundancy penalty for prior brief versions', () => {
  test('penalty proportional to version count', () => {
    const r1 = route(opp(), { existing_brief_versions: 1 });
    const r3 = route(opp(), { existing_brief_versions: 3 });
    expect(Math.abs(r3.score_breakdown.redundancy)).toBeGreaterThan(Math.abs(r1.score_breakdown.redundancy));
  });
  test('3+ versions triggers human review', () => {
    const r = route(opp(), { existing_brief_versions: 3 });
    expect(r.human_review_required).toBe(true);
    expect(r.human_review_reason).toMatch(/loop/);
  });
});

// ── bucket-specific always-human-review ─────────────────────────────

describe('cannibalization + page_type_mismatch buckets always human-review', () => {
  test('cannibalization', () => {
    const r = route(opp({ bucket: 'cannibalization' }), {});
    expect(r.human_review_required).toBe(true);
  });
  test('page_type_mismatch', () => {
    const r = route(opp({ bucket: 'page_type_mismatch' }), {});
    expect(r.human_review_required).toBe(true);
  });
});

// ── derivePageType ──────────────────────────────────────────────────

describe('derivePageType', () => {
  test.each([
    ['create_or_refresh_city_service_page', null, 'city-service'],
    ['create_customer_question_page', null, 'customer-question'],
    ['new_supporting_blog', null, 'supporting-blog'],
    ['rewrite_title_meta', null, 'metadata'],
    ['add_internal_links', null, 'links'],
    ['gbp_post', null, 'gbp'],
    ['do_not_publish', null, 'none'],
  ])('%s → %s', (action, profile, expected) => {
    expect(derivePageType(action, profile)).toBe(expected);
  });
  test('refresh_existing_page maps SERP dominant_page_type to brief template keys', () => {
    // Direct matches.
    expect(derivePageType('refresh_existing_page', { dominant_page_type: 'city-service' })).toBe('city-service');
    // SERP → brief template normalization.
    expect(derivePageType('refresh_existing_page', { dominant_page_type: 'blog' })).toBe('supporting-blog');
    expect(derivePageType('refresh_existing_page', { dominant_page_type: 'faq' })).toBe('customer-question');
    expect(derivePageType('refresh_existing_page', { dominant_page_type: 'service' })).toBe('city-service');
    // Unknown / non-brief types fall back to generic 'refresh' template.
    expect(derivePageType('refresh_existing_page', { dominant_page_type: 'directory' })).toBe('refresh');
    expect(derivePageType('refresh_existing_page', { dominant_page_type: 'home' })).toBe('refresh');
    expect(derivePageType('refresh_existing_page', null)).toBe('refresh');
  });
});

// ── no-signals fallback path ────────────────────────────────────────

describe('routes safely when no signals are available', () => {
  test('returns miner action + base score unchanged + no review', () => {
    const r = route(opp(), {});
    expect(r.action_type).toBe('new_supporting_blog');
    expect(r.final_score).toBe(80);
    expect(r.human_review_required).toBe(false);
  });
});

// ── final_score = sum of breakdown ─────────────────────────────────

describe('final_score equals sum of breakdown entries', () => {
  test('matches across realistic mixed signals', () => {
    const r = route(opp(), {
      serp_profile: serp({ directory_saturation: 0.7 }),
      customer_signal: { total_count: 15, funnel_stage: 'post-service' },
      conversion_feedback: { lead_quality_score: 18, close_rate_score: 10, revenue_realization_score: 14 },
    });
    const sum = Object.values(r.score_breakdown).reduce((a, b) => a + b, 0);
    expect(r.final_score).toBe(sum);
  });
});
