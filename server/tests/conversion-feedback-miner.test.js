/**
 * Unit tests for conversion-feedback-miner pure helpers.
 *
 * The async miner methods (mineWindow, persist, lookup) read multiple
 * tables and are exercised by the CLI smoke test.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const {
  normalizeCity,
  normalizeService,
  leadQualityScore,
  closeRateScore,
  revenueRealizationScore,
  sentinelize,
  desentinelize,
} = require('../services/seo/conversion-feedback-miner')._internals;

const { WEIGHTS } = require('../services/content/scoring-config');

// ── normalizeCity ────────────────────────────────────────────────────

describe('normalizeCity', () => {
  test.each([
    ['bradenton', 'Bradenton'],
    ['Bradenton', 'Bradenton'],
    ['lakewood ranch', 'Lakewood Ranch'],
    ['lakewood_ranch', 'Lakewood Ranch'],
    ['Bradenton, FL', 'Bradenton'],
    ['Sarasota Florida', 'Sarasota'],
    ['VENICE FL', 'Venice'],
  ])('%j → %j', (input, expected) => {
    expect(normalizeCity(input)).toBe(expected);
  });

  test.each([
    [null, null],
    [undefined, null],
    ['', null],
    ['Tampa', null],
    ['Miami', null],
  ])('rejects non-service-area input %j', (input, expected) => {
    expect(normalizeCity(input)).toBe(expected);
  });
});

// ── normalizeService ─────────────────────────────────────────────────

describe('normalizeService', () => {
  test.each([
    ['termite inspection', 'termite'],
    ['Termite Treatment', 'termite'],
    ['WDO report', 'termite'],
    ['rat control', 'rodent'],
    ['mice in attic', 'rodent'],
    ['mosquito service', 'mosquito'],
    ['Lawn Care', 'lawn'],
    ['chinch bugs', 'lawn'],
    ['weed control', 'lawn'],
    ['tree & shrub', 'tree-shrub'],
    ['palm fertilizing', 'tree-shrub'],
    ['bed bug treatment', 'specialty'],
    ['pest control', 'pest'],
    ['exterminator', 'pest'],
    ['cockroach', 'pest'],
  ])('%j → %j', (input, expected) => {
    expect(normalizeService(input)).toBe(expected);
  });

  test('returns null for unmatched', () => {
    expect(normalizeService('something else')).toBeNull();
    expect(normalizeService('')).toBeNull();
    expect(normalizeService(null)).toBeNull();
  });
});

// ── sentinel ─────────────────────────────────────────────────────────

describe('sentinelize / desentinelize', () => {
  test('null/empty → _global', () => {
    expect(sentinelize(null)).toBe('_global');
    expect(sentinelize(undefined)).toBe('_global');
    expect(sentinelize('')).toBe('_global');
  });
  test('non-empty value passes through', () => {
    expect(sentinelize('Bradenton')).toBe('Bradenton');
  });
  test('roundtrip: desentinelize(sentinelize(null)) === null', () => {
    expect(desentinelize(sentinelize(null))).toBe(null);
    expect(desentinelize(sentinelize('Bradenton'))).toBe('Bradenton');
  });
});

// ── leadQualityScore ─────────────────────────────────────────────────

describe('leadQualityScore', () => {
  test('zero volume → 0', () => {
    expect(leadQualityScore({ leads_total: 0, form_submissions: 0, calls_handled: 0 })).toBe(0);
  });
  test('caps at WEIGHTS.leadQuality', () => {
    const score = leadQualityScore({ leads_total: 1000, form_submissions: 1000, calls_handled: 1000 });
    expect(score).toBeLessThanOrEqual(WEIGHTS.leadQuality);
  });
  test('monotonic increase with volume', () => {
    const low = leadQualityScore({ leads_total: 1, form_submissions: 0, calls_handled: 0 });
    const mid = leadQualityScore({ leads_total: 5, form_submissions: 0, calls_handled: 0 });
    const high = leadQualityScore({ leads_total: 25, form_submissions: 0, calls_handled: 0 });
    expect(mid).toBeGreaterThan(low);
    expect(high).toBeGreaterThan(mid);
  });
  test('forms and calls contribute at half-weight of leads', () => {
    const onlyLeads = leadQualityScore({ leads_total: 10, form_submissions: 0, calls_handled: 0 });
    const onlyForms = leadQualityScore({ leads_total: 0, form_submissions: 10, calls_handled: 0 });
    expect(onlyLeads).toBeGreaterThan(onlyForms);
  });
});

// ── closeRateScore ───────────────────────────────────────────────────

describe('closeRateScore', () => {
  test('insufficient sample → 0', () => {
    expect(closeRateScore({ estimates_sent: 0, estimates_accepted: 0 })).toBe(0);
    expect(closeRateScore({ estimates_sent: 2, estimates_accepted: 2 })).toBe(0);
  });
  test('50% close rate → full score', () => {
    const s = closeRateScore({ estimates_sent: 10, estimates_accepted: 5 });
    expect(s).toBe(WEIGHTS.closeRate);
  });
  test('100% close rate clipped to full', () => {
    const s = closeRateScore({ estimates_sent: 10, estimates_accepted: 10 });
    expect(s).toBe(WEIGHTS.closeRate);
  });
  test('10% close rate → ~20% of full', () => {
    const s = closeRateScore({ estimates_sent: 10, estimates_accepted: 1 });
    expect(s).toBeCloseTo(WEIGHTS.closeRate * 0.2, 0);
  });
});

// ── revenueRealizationScore ──────────────────────────────────────────

describe('revenueRealizationScore', () => {
  test('zero leads or revenue → 0', () => {
    expect(revenueRealizationScore({ estimated_revenue: 0, leads_total: 10 })).toBe(0);
    expect(revenueRealizationScore({ estimated_revenue: 1000, leads_total: 0 })).toBe(0);
  });
  test('monotonic with $/lead', () => {
    const low = revenueRealizationScore({ estimated_revenue: 500, leads_total: 10 });   // $50/lead
    const mid = revenueRealizationScore({ estimated_revenue: 5000, leads_total: 10 });  // $500/lead
    const high = revenueRealizationScore({ estimated_revenue: 20000, leads_total: 10 }); // $2000/lead
    expect(mid).toBeGreaterThan(low);
    expect(high).toBeGreaterThan(mid);
  });
  test('capped at WEIGHTS.revenueRealization', () => {
    const huge = revenueRealizationScore({ estimated_revenue: 1_000_000, leads_total: 1 });
    expect(huge).toBeLessThanOrEqual(WEIGHTS.revenueRealization);
  });
});
