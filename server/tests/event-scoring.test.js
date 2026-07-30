/**
 * Deterministic editorial scoring (owner spec 2026-07-28). Pure pieces:
 * clamping, penalty math, derived penalties, thresholds, decision tiers.
 */

const {
  FACTOR_MAXES,
  PENALTY_VALUES,
  DERIVED_PENALTY_VALUES,
  REJECTION_CODES,
  isMalformedAssessment,
  malformedAssessmentReason,
  resolveScoreThresholds,
  normalizeAssessment,
  derivedPenalties,
  computeEditorialScore,
  featureScoreFloor,
  heroScoreFloor,
  shortlistScoreFloor,
  assessEvent,
} = require('../services/event-scoring');

const PERFECT_SCORES = {
  specialness: 25,
  reader_pull: 20,
  audience_fit: 15,
  planning_value: 15,
  local_relevance: 10,
  source_confidence: 10,
  accessibility: 5,
};

// A row that trips no data-derived penalties: far-future, priced, known age fit.
const CLEAN_EVENT = {
  id: 'e1',
  start_at: new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString(),
  is_free: true,
  price_text: 'Free',
  family_friendly: true,
};

describe('factor clamping', () => {
  test('caps every factor at its maximum and floors at zero', () => {
    const normalized = normalizeAssessment({
      scores: { specialness: 99, reader_pull: -5, audience_fit: 'nonsense' },
    });
    expect(normalized.scores.specialness).toBe(25);
    expect(normalized.scores.reader_pull).toBe(0);
    expect(normalized.scores.audience_fit).toBe(0);
    expect(normalized.scores.planning_value).toBe(0);
  });

  test('factor maxima sum to exactly 100', () => {
    expect(Object.values(FACTOR_MAXES).reduce((a, b) => a + b, 0)).toBe(100);
  });

  test('normalize drops unknown values, but the malformed gate refuses them FIRST — a typo cannot become approval', () => {
    // normalizeAssessment (post-gate) still allowlists, so a hallucinated
    // code can't invent policy…
    const normalized = normalizeAssessment({
      penalty_flags: ['generic_class', 'made_up_flag'],
      rejection_codes: ['webinar_virtual', 'not_a_real_code'],
    });
    expect(normalized.penaltyFlags).toEqual(['generic_class']);
    expect(normalized.rejectionCodes).toEqual(['webinar_virtual']);
    // …and the structural gate refuses the assessment outright before it
    // ever reaches normalize: silently dropping "government_civics" would
    // turn a policy rejection into a policy-clean approval.
    expect(malformedAssessmentReason({
      scores: PERFECT_SCORES, penalty_flags: [], rejection_codes: ['government_civics'],
    })).toContain('government_civics');
    expect(malformedAssessmentReason({
      scores: PERFECT_SCORES, penalty_flags: ['retail_promotion_event'], rejection_codes: [],
    })).toContain('retail_promotion_event');
    expect(malformedAssessmentReason({
      scores: PERFECT_SCORES, penalty_flags: ['generic_class'], rejection_codes: ['webinar_virtual'],
    })).toBeNull();
  });

  test('spec penalty values hold: class -15, retail -25, screening -10', () => {
    expect(PENALTY_VALUES).toEqual({ generic_class: 15, retail_promo: 25, ordinary_screening: 10 });
    expect(DERIVED_PENALTY_VALUES).toEqual({ short_notice: 10, missing_price: 8, unclear_age: 5 });
  });
});

describe('derived penalties', () => {
  test('clean row derives none', () => {
    expect(derivedPenalties(CLEAN_EVENT)).toEqual([]);
  });

  test('under 12 hours of notice → short_notice', () => {
    const soon = { ...CLEAN_EVENT, start_at: new Date(Date.now() + 2 * 3600 * 1000).toISOString() };
    expect(derivedPenalties(soon)).toContain('short_notice');
  });

  test('no price signal → missing_price; explicit free or price_text clears it', () => {
    expect(derivedPenalties({ ...CLEAN_EVENT, is_free: null, price_text: null })).toContain('missing_price');
    expect(derivedPenalties({ ...CLEAN_EVENT, is_free: false, price_text: '$20/day' })).not.toContain('missing_price');
    expect(derivedPenalties({ ...CLEAN_EVENT, is_free: true, price_text: null })).not.toContain('missing_price');
  });

  test('unknown family suitability → unclear_age; an explicit false is still known', () => {
    expect(derivedPenalties({ ...CLEAN_EVENT, family_friendly: null })).toContain('unclear_age');
    expect(derivedPenalties({ ...CLEAN_EVENT, family_friendly: false })).not.toContain('unclear_age');
  });
});

describe('computeEditorialScore', () => {
  test('perfect factors, no penalties = 100', () => {
    const normalized = normalizeAssessment({ scores: PERFECT_SCORES });
    expect(computeEditorialScore(normalized, [])).toBe(100);
  });

  test('subtracts model and derived penalties, floors at 0', () => {
    const normalized = normalizeAssessment({
      scores: { specialness: 10 },
      penalty_flags: ['retail_promo'],
    });
    // 10 - 25 - 8 → floored at 0
    expect(computeEditorialScore(normalized, ['missing_price'])).toBe(0);
  });

  test('a strong event with one penalty lands where the arithmetic says', () => {
    const normalized = normalizeAssessment({
      scores: { ...PERFECT_SCORES, specialness: 20 },
      penalty_flags: ['ordinary_screening'],
    });
    // 95 - 10 = 85: feature, not hero
    expect(computeEditorialScore(normalized, [])).toBe(85);
  });
});

describe('thresholds', () => {
  const OLD_ENV = { ...process.env };
  afterEach(() => { process.env = { ...OLD_ENV }; });

  test('defaults: 75 feature / 88 hero / 65 shortlist', () => {
    delete process.env.NEWSLETTER_MIN_FEATURE_SCORE;
    delete process.env.NEWSLETTER_MIN_HERO_SCORE;
    delete process.env.NEWSLETTER_SHORTLIST_SCORE;
    expect(featureScoreFloor()).toBe(75);
    expect(heroScoreFloor()).toBe(88);
    expect(shortlistScoreFloor()).toBe(65);
  });

  test('env overrides apply; junk values fall back', () => {
    process.env.NEWSLETTER_MIN_FEATURE_SCORE = '80';
    process.env.NEWSLETTER_MIN_HERO_SCORE = 'not-a-number';
    expect(featureScoreFloor()).toBe(80);
    expect(heroScoreFloor()).toBe(88);
  });

  test('a blank env var means unset, never a zero floor (Number("") === 0 trap)', () => {
    process.env.NEWSLETTER_MIN_FEATURE_SCORE = '';
    process.env.NEWSLETTER_MIN_HERO_SCORE = '   ';
    expect(featureScoreFloor()).toBe(75);
    expect(heroScoreFloor()).toBe(88);
  });

  test('an incoherent threshold set falls back to the defaults wholesale', () => {
    // feature above hero would tier an 85-point event "hero" while
    // refusing to approve it — the set is only valid ordered.
    process.env.NEWSLETTER_MIN_FEATURE_SCORE = '90';
    process.env.NEWSLETTER_MIN_HERO_SCORE = '80';
    expect(resolveScoreThresholds()).toEqual({ shortlist: 65, feature: 75, hero: 88 });
    // A coherent override set is honored.
    process.env.NEWSLETTER_MIN_FEATURE_SCORE = '70';
    process.env.NEWSLETTER_MIN_HERO_SCORE = '85';
    process.env.NEWSLETTER_SHORTLIST_SCORE = '60';
    expect(resolveScoreThresholds()).toEqual({ shortlist: 60, feature: 70, hero: 85 });
  });
});

describe('isMalformedAssessment (fail-closed structure gate)', () => {
  test('missing or scalar rejection_codes is malformed — never policy-clean', () => {
    expect(isMalformedAssessment({ scores: PERFECT_SCORES })).toBe(true);
    expect(isMalformedAssessment({ scores: PERFECT_SCORES, rejection_codes: 'none' })).toBe(true);
    expect(isMalformedAssessment({ scores: PERFECT_SCORES, rejection_codes: null })).toBe(true);
  });

  test('missing or scalar penalty_flags is malformed — the fixed penalties cannot be skipped', () => {
    expect(isMalformedAssessment({ scores: PERFECT_SCORES, rejection_codes: [] })).toBe(true);
    expect(isMalformedAssessment({ scores: PERFECT_SCORES, rejection_codes: [], penalty_flags: 'none' })).toBe(true);
  });

  test('missing or non-object scores is malformed', () => {
    expect(isMalformedAssessment({ rejection_codes: [], penalty_flags: [] })).toBe(true);
    expect(isMalformedAssessment({ rejection_codes: [], penalty_flags: [], scores: [1, 2] })).toBe(true);
    expect(isMalformedAssessment(null)).toBe(true);
  });

  test('a well-formed assessment passes', () => {
    expect(isMalformedAssessment({ scores: PERFECT_SCORES, rejection_codes: [], penalty_flags: [] })).toBe(false);
    expect(isMalformedAssessment({ scores: {}, rejection_codes: ['webinar_virtual'], penalty_flags: ['retail_promo'] })).toBe(false);
  });
});

describe('assessEvent decision', () => {
  test('hero-grade event with no codes auto-approves at tier hero', () => {
    const decision = assessEvent(CLEAN_EVENT, { scores: PERFECT_SCORES, evidence: ['Official page confirms one-night date.'] });
    expect(decision).toMatchObject({ approve: true, tier: 'hero', score: 100 });
    expect(decision.breakdown.factors.specialness).toBe(25);
    expect(decision.evidence).toHaveLength(1);
    // family_status has no dedicated column — the breakdown jsonb is
    // where the audit trail and the portfolio selector read it from.
    expect(decision.breakdown.family_status).toBe('unknown');
  });

  test('feature-floor boundary: 75 approves, 74 stays pending', () => {
    const at75 = assessEvent(CLEAN_EVENT, {
      scores: { ...PERFECT_SCORES, specialness: 0 },
    });
    expect(at75.score).toBe(75);
    expect(at75.approve).toBe(true);
    expect(at75.tier).toBe('feature');

    const at74 = assessEvent(CLEAN_EVENT, {
      scores: { ...PERFECT_SCORES, specialness: 0, accessibility: 4 },
    });
    expect(at74.score).toBe(74);
    expect(at74.approve).toBe(false);
    expect(at74.tier).toBe('shortlist');
  });

  test('any hard-policy rejection code blocks approval regardless of score', () => {
    const decision = assessEvent(CLEAN_EVENT, {
      scores: PERFECT_SCORES,
      rejection_codes: ['retail_promotion'],
    });
    expect(decision.approve).toBe(false);
    expect(decision.tier).toBe('rejected_policy');
    expect(decision.rejectionCodes).toEqual(['retail_promotion']);
  });

  test('below-shortlist tier under 65', () => {
    const decision = assessEvent(CLEAN_EVENT, { scores: { specialness: 10, reader_pull: 10 } });
    expect(decision.score).toBe(20);
    expect(decision.tier).toBe('below_shortlist');
    expect(decision.approve).toBe(false);
  });

  test('every spec rejection code is representable', () => {
    for (const code of [
      'routine_recurring', 'ordinary_market', 'recurring_live_music', 'happy_hour',
      'webinar_virtual', 'business_open_house', 'retail_promotion', 'ordinary_class',
      'unverifiable_source', 'cancelled_or_sold_out', 'outside_corridor',
      'not_attendable', 'government_civic',
    ]) {
      expect(REJECTION_CODES).toContain(code);
    }
  });
});
