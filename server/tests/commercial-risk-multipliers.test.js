process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

// Commercial RISK multipliers (owner-locked risk-type lane, decision 5). Rep-set
// Tree & Shrub plant-density + mosquito-pressure levels scale the commercial cost
// buildup (target margin preserved); the top tier (very_high / severe) escapes to
// a manual quote. Empty/unset → Normal (1.0×) — backward compatible.

const {
  resolveTreeShrubDensityMultiplier,
  resolveMosquitoPressureMultiplier,
} = require('../services/pricing-engine/commercial-risk-multipliers');
const { generateEstimate } = require('../services/pricing-engine');

describe('resolve*Multiplier', () => {
  test('T&S density levels', () => {
    expect(resolveTreeShrubDensityMultiplier('low')).toEqual({ multiplier: 0.75, forceManual: false });
    expect(resolveTreeShrubDensityMultiplier('normal')).toEqual({ multiplier: 1.0, forceManual: false });
    expect(resolveTreeShrubDensityMultiplier('high')).toEqual({ multiplier: 1.5, forceManual: false });
    expect(resolveTreeShrubDensityMultiplier('very_high')).toEqual({ multiplier: 1, forceManual: true });
  });
  test('mosquito pressure levels', () => {
    expect(resolveMosquitoPressureMultiplier('low')).toEqual({ multiplier: 0.85, forceManual: false });
    expect(resolveMosquitoPressureMultiplier('normal')).toEqual({ multiplier: 1.0, forceManual: false });
    expect(resolveMosquitoPressureMultiplier('high')).toEqual({ multiplier: 1.35, forceManual: false });
    expect(resolveMosquitoPressureMultiplier('severe')).toEqual({ multiplier: 1, forceManual: true });
  });
  test('empty / unrecognized → Normal (1.0, no manual); case-insensitive', () => {
    expect(resolveTreeShrubDensityMultiplier('')).toEqual({ multiplier: 1, forceManual: false });
    expect(resolveTreeShrubDensityMultiplier(undefined)).toEqual({ multiplier: 1, forceManual: false });
    expect(resolveTreeShrubDensityMultiplier('nonsense')).toEqual({ multiplier: 1, forceManual: false });
    expect(resolveMosquitoPressureMultiplier('HIGH')).toEqual({ multiplier: 1.35, forceManual: false });
  });
});

describe('multipliers through generateEstimate', () => {
  const base = { propertyType: 'commercial', isCommercial: true, lotSqFt: 40000, footprintSqFt: 8000 };
  const line = (extra, svc) => generateEstimate({
    ...base, services: { treeShrub: {}, mosquito: { tier: 'monthly12' } }, ...extra,
  }).lineItems.find((l) => l.service === svc);

  test('T&S density scales the price and preserves the ~45% target margin', () => {
    const norm = line({}, 'commercial_tree_shrub');
    const high = line({ treeShrubDensity: 'high' }, 'commercial_tree_shrub');
    const low = line({ treeShrubDensity: 'low' }, 'commercial_tree_shrub');
    expect(norm.treeShrubDensityMultiplier).toBe(1);
    expect(high.treeShrubDensityMultiplier).toBe(1.5);
    expect(high.annual).toBeGreaterThan(norm.annual);
    expect(low.annual).toBeLessThanOrEqual(norm.annual);
    [norm, high, low].forEach((r) => expect(r.margin).toBeCloseTo(0.45, 2));
  });

  test('T&S very_high → manual quote, NOT counted as an active/priced service', () => {
    const est = generateEstimate({ ...base, services: { treeShrub: {} }, treeShrubDensity: 'very_high' });
    const r = est.lineItems.find((l) => l.service === 'commercial_tree_shrub');
    expect(r).toMatchObject({ service: 'commercial_tree_shrub', quoteRequired: true, annual: null });
    expect(r.manualReviewReasons).toContain('commercial_tree_shrub_very_high_density_manual_quote');
    // The manual line must not be marked active (mirrors pest/mosquito/etc.).
    expect(est.waveGuard.activeServices).not.toContain('commercial_tree_shrub');
    // …a normal-density T&S IS active.
    const normal = generateEstimate({ ...base, services: { treeShrub: {} }, treeShrubDensity: 'normal' });
    expect(normal.waveGuard.activeServices).toContain('commercial_tree_shrub');
  });

  test('mosquito pressure scales the price and preserves margin', () => {
    const norm = line({}, 'commercial_mosquito');
    const high = line({ mosquitoPressure: 'high' }, 'commercial_mosquito');
    const low = line({ mosquitoPressure: 'low' }, 'commercial_mosquito');
    expect(high.annual).toBeGreaterThan(norm.annual);
    expect(low.annual).toBeLessThanOrEqual(norm.annual);
    [norm, high, low].forEach((r) => expect(r.margin).toBeCloseTo(0.45, 2));
  });

  test('mosquito severe → manual quote', () => {
    const r = line({ mosquitoPressure: 'severe' }, 'commercial_mosquito');
    expect(r).toMatchObject({ service: 'commercial_mosquito', quoteRequired: true, annual: null });
    expect(r.manualReviewReasons).toContain('commercial_mosquito_severe_pressure_manual_quote');
  });

  test('no multiplier set → identical to Normal (backward compatible)', () => {
    expect(line({}, 'commercial_tree_shrub').annual)
      .toBe(line({ treeShrubDensity: 'normal' }, 'commercial_tree_shrub').annual);
    expect(line({}, 'commercial_mosquito').annual)
      .toBe(line({ mosquitoPressure: 'normal' }, 'commercial_mosquito').annual);
  });
});
