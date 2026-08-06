// public-ranges must price every published service from engine constants
// alone (no DB) — a sweep error here means an engine signature changed and
// the agent-readable pricing surface would silently lose a service.
const { computePublicPricingRanges, _internals } = require('../services/pricing-engine/public-ranges');

const EXPECTED_KEYS = [
  'general_pest_quarterly',
  'german_roach_cleanout',
  'bed_bug_treatment',
  'mosquito_program',
  'wasp_hornet_removal',
  'flea_elimination',
  'rodent_bait_program',
  'rodent_trapping',
  'rodent_sanitation',
  'rodent_exclusion',
  'termite_bait_install',
  'termite_bait_monitoring',
  'termite_bond',
  'termite_trenching',
  'pre_slab_termiticide',
  'wdo_inspection',
  'lawn_care_program',
  'one_time_lawn',
  'one_time_pest',
  'one_time_mosquito',
  'lawn_plugging',
  'top_dressing',
  'tree_shrub_care',
  'palm_injection',
];

// Services that genuinely bill monthly — the only ones allowed a per-month unit.
const MONTHLY_BILLED_KEYS = new Set([
  'rodent_bait_program',
  'tree_shrub_care',
]);

describe('public pricing ranges', () => {
  let payload;

  beforeAll(() => {
    payload = computePublicPricingRanges();
  });

  test('every service sweeps without errors', () => {
    expect(payload.errors).toEqual([]);
  });

  test('all expected services are present exactly once', () => {
    const keys = payload.services.map((s) => s.key);
    expect(keys.sort()).toEqual([...EXPECTED_KEYS].sort());
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('every range is a positive low <= high pair', () => {
    for (const s of payload.services) {
      expect(Number.isFinite(s.low)).toBe(true);
      expect(Number.isFinite(s.high)).toBe(true);
      expect(s.low).toBeGreaterThan(0);
      expect(s.high).toBeGreaterThanOrEqual(s.low);
    }
  });

  test('units obey the owner copy rules', () => {
    for (const s of payload.services) {
      const text = `${s.name} ${s.unit} ${s.notes || ''}`;
      // "per visit" is banned customer-facing copy everywhere (owner rule;
      // only commercial is exempt, and commercial is not published here).
      // Visit COUNTS ("2-visit package") are fine; the unit phrasing is not.
      expect(text).not.toMatch(/per visit|\$\s*\d[\d,.]*\s*\/\s*visit/i);
      if (s.unit === 'per month') {
        expect(MONTHLY_BILLED_KEYS.has(s.key)).toBe(true);
      }
      // No per-year units: even the termite bond rides quarterly
      // applications (owner copy rule: no combined annual totals).
      expect(s.unit).not.toMatch(/per year/i);
      expect(text).toBeTruthy();
    }
    const pest = payload.services.find((s) => s.key === 'general_pest_quarterly');
    expect(pest.unit).toBe('per application');
    const lawn = payload.services.find((s) => s.key === 'lawn_care_program');
    expect(lawn.unit).toBe('per application');
  });

  test('no lawn or pest combined monthly totals are published', () => {
    const lawn = payload.services.find((s) => s.key === 'lawn_care_program');
    const pest = payload.services.find((s) => s.key === 'general_pest_quarterly');
    for (const s of [lawn, pest]) {
      expect(s.unit).not.toMatch(/month/i);
      expect(`${s.name} ${s.notes || ''}`).not.toMatch(/\$\d+\s*\/\s*mo/i);
    }
  });

  test('disclaimer points agents at the exact-quote calculator', () => {
    expect(payload.disclaimer).toContain('/pest-control-calculator/');
    expect(payload.currency).toBe('USD');
    expect(new Date(payload.generatedAt).getTime()).not.toBeNaN();
  });

  test('every call recomputes from current constants (no stale memoization)', () => {
    const again = computePublicPricingRanges();
    expect(again).not.toBe(payload);
    expect(again.services.map((s) => s.key)).toEqual(payload.services.map((s) => s.key));
  });

  test('buildRows exposes sweep errors instead of throwing', () => {
    const { rows, errors } = _internals.buildRows();
    expect(Array.isArray(rows)).toBe(true);
    expect(Array.isArray(errors)).toBe(true);
    expect(errors).toEqual([]);
  });
});
