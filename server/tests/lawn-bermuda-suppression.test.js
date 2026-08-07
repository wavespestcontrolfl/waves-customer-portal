/**
 * Bermuda-in-St.-Augustine suppression add-on — per-application adder baked
 * into the lawn per-app price (owner ruling 2026-08-07).
 *
 * Pins: (1) the adder math (base + per-1000 × turf sqft, applied per app on
 * every tier AFTER floor/minimum resolution), (2) St. Augustine-only
 * eligibility (other tracks price unchanged and say why), (3) the default
 * path is byte-identical to baseline (no drift for every existing quote),
 * and (4) the GATE_BERMUDA_SUPPRESSION dark default in the V2 translator.
 */

const { priceLawnCare } = require('../services/pricing-engine/service-pricing');
const { translateV2CallToV1Input } = require('../routes/property-lookup-v2');

const PROPERTY_5K = { turfSf: 5000 };
const PROPERTY_10K = { turfSf: 10000 };
// LAWN_PRICING_V2.bermudaSuppression in-code defaults: 15 + 2/1000 sqft.
const ADDER_5K = 25;
const ADDER_10K = 35;

describe('priceLawnCare bermudaSuppression adder', () => {
  // Gate enforcement lives in the pricer itself (deepest chokepoint), so
  // the adder tests run gate-on; the gate-off behavior is pinned below.
  const prevGate = process.env.GATE_BERMUDA_SUPPRESSION;
  beforeAll(() => { process.env.GATE_BERMUDA_SUPPRESSION = 'true'; });
  afterAll(() => {
    if (prevGate === undefined) delete process.env.GATE_BERMUDA_SUPPRESSION;
    else process.env.GATE_BERMUDA_SUPPRESSION = prevGate;
  });

  test('gate off: a selected add-on fails closed even on DIRECT pricer calls', () => {
    delete process.env.GATE_BERMUDA_SUPPRESSION;
    try {
      let thrown;
      try {
        priceLawnCare(PROPERTY_5K, { track: 'st_augustine', tier: 'enhanced', bermudaSuppression: true });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeTruthy();
      expect(thrown.code).toBe('BERMUDA_SUPPRESSION_GATED');
      expect(thrown.failClosed).toBe(true);
      // Unselected quotes are untouched by the gate.
      expect(priceLawnCare(PROPERTY_5K, { track: 'st_augustine', tier: 'enhanced' }).bermudaSuppression).toBeNull();
    } finally {
      process.env.GATE_BERMUDA_SUPPRESSION = 'true';
    }
  });
  test('bakes the adder into every tier per-app on St. Augustine', () => {
    const base = priceLawnCare(PROPERTY_5K, { track: 'st_augustine', tier: 'enhanced' });
    const withAddon = priceLawnCare(PROPERTY_5K, {
      track: 'st_augustine', tier: 'enhanced', bermudaSuppression: true,
    });

    // Cadence-independent provenance: perApp only — annual is always
    // perApp x the ACCEPTED tier's visits, so a stamped annual would go
    // stale on cadence selection.
    expect(withAddon.bermudaSuppression).toEqual({ perApp: ADDER_5K });
    for (const tier of withAddon.tiers) {
      const baseTier = base.tiers.find((t) => t.tier === tier.tier);
      expect(baseTier).toBeTruthy();
      expect(tier.bermudaSuppressionPerApp).toBe(ADDER_5K);
      expect(tier.perApp).toBeCloseTo(baseTier.perApp + ADDER_5K, 2);
      expect(tier.annual).toBeCloseTo(baseTier.annual + ADDER_5K * tier.freq, 2);
      expect(tier.monthly).toBeCloseTo(Math.round((tier.annual / 12) * 100) / 100, 2);
    }
    // Selected-tier scalars follow the raised ladder.
    expect(withAddon.perApp).toBeCloseTo(base.perApp + ADDER_5K, 2);
    expect(withAddon.annual).toBeCloseTo(base.annual + ADDER_5K * 9, 2);
  });

  test('adder scales with turf size', () => {
    const withAddon = priceLawnCare(PROPERTY_10K, {
      track: 'st_augustine', tier: 'premium', bermudaSuppression: true,
    });
    expect(withAddon.bermudaSuppression).toEqual({ perApp: ADDER_10K });
  });

  test('every supported gate representation enables pricing (1 / true / on, case-insensitive)', () => {
    for (const value of ['1', 'true', 'TRUE', 'on', 'On']) {
      process.env.GATE_BERMUDA_SUPPRESSION = value;
      const priced = priceLawnCare(PROPERTY_5K, {
        track: 'st_augustine', tier: 'enhanced', bermudaSuppression: true,
      });
      expect(priced.bermudaSuppression).toEqual({ perApp: ADDER_5K });
    }
    process.env.GATE_BERMUDA_SUPPRESSION = 'true';
  });

  test('invalid DB knobs FAIL the calculation for a selected add-on (never a silent $0)', () => {
    const { LAWN_PRICING_V2 } = require('../services/pricing-engine/constants');
    const saved = LAWN_PRICING_V2.bermudaSuppression;
    try {
      LAWN_PRICING_V2.bermudaSuppression = { perAppBase: 'oops' };
      let thrown;
      try {
        priceLawnCare(PROPERTY_5K, { track: 'st_augustine', tier: 'enhanced', bermudaSuppression: true });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeTruthy();
      expect(thrown.code).toBe('BERMUDA_SUPPRESSION_KNOBS_INVALID');
      expect(thrown.failClosed).toBe(true);
      // Unselected add-on is untouched by broken knobs — no drift for
      // every normal lawn quote even with a malformed config row.
      const plain = priceLawnCare(PROPERTY_5K, { track: 'st_augustine', tier: 'enhanced' });
      expect(plain.bermudaSuppression).toBeNull();
    } finally {
      LAWN_PRICING_V2.bermudaSuppression = saved;
    }
  });

  test('non-St.-Augustine tracks are ineligible: price unchanged + note', () => {
    const base = priceLawnCare(PROPERTY_5K, { track: 'zoysia', tier: 'enhanced' });
    const requested = priceLawnCare(PROPERTY_5K, {
      track: 'zoysia', tier: 'enhanced', bermudaSuppression: true,
    });
    expect(requested.bermudaSuppression).toBeNull();
    expect(requested.perApp).toBe(base.perApp);
    expect(requested.annual).toBe(base.annual);
    expect(requested.notes.join(' ')).toMatch(/St\. Augustine lawns only/);
  });

  test('default path is identical to baseline (no drift without the flag)', () => {
    const base = priceLawnCare(PROPERTY_5K, { track: 'st_augustine', tier: 'enhanced' });
    const explicitOff = priceLawnCare(PROPERTY_5K, {
      track: 'st_augustine', tier: 'enhanced', bermudaSuppression: false,
    });
    expect(explicitOff.perApp).toBe(base.perApp);
    expect(explicitOff.annual).toBe(base.annual);
    expect(explicitOff.bermudaSuppression).toBeNull();
    expect(base.bermudaSuppression).toBeNull();
    expect(base.tiers.every((t) => t.bermudaSuppressionPerApp === null)).toBe(true);
  });
});

describe('admin pricing-config validation of the suppression knobs', () => {
  const { validatePricingConfigData } = require('../routes/admin-pricing-config');
  const ok = (data) => validatePricingConfigData('lawn_pricing_v2', data, null);

  test('accepts valid knobs and rows without the key', () => {
    expect(ok({ bermudaSuppression: { perAppBase: 15, perAppPer1000Sqft: 2 } }).ok).toBe(true);
    expect(ok({ programMinimumMonthly: 0 }).ok).toBe(true);
  });

  test('rejects numeric strings, missing keys, sub-cent, out-of-bound, and would-be-zero knobs', () => {
    expect(ok({ bermudaSuppression: { perAppBase: '15', perAppPer1000Sqft: 2 } }).ok).toBe(false);
    expect(ok({ bermudaSuppression: { perAppBase: 15 } }).ok).toBe(false);
    expect(ok({ bermudaSuppression: { perAppBase: 15.001, perAppPer1000Sqft: 2 } }).ok).toBe(false);
    expect(ok({ bermudaSuppression: { perAppBase: 5000, perAppPer1000Sqft: 2 } }).ok).toBe(false);
    expect(ok({ bermudaSuppression: { perAppBase: 0, perAppPer1000Sqft: 0 } }).ok).toBe(false);
    expect(ok({ bermudaSuppression: [] }).ok).toBe(false);
  });
});

describe('save-replay failClosed propagation', () => {
  const { resolveServerAuthoritativePricing } = require('../services/admin-estimate-persistence');
  const clientPreview = { annualTotal: 500 };

  test('a failClosed policy rejection BLOCKS the save (no CLIENT_FALLBACK)', async () => {
    const gateErr = new Error('gated');
    gateErr.failClosed = true;
    await expect(resolveServerAuthoritativePricing({
      estimateData: { engineRequest: { profile: {} } },
      clientPreview,
      quoteRequired: false,
      now: new Date(),
      recompute: async () => { throw gateErr; },
    })).rejects.toBe(gateErr);
  });

  test('a gated engineInputs replay rejects via the REAL recompute path (no CLIENT_FALLBACK)', async () => {
    // The engine wraps its own errors as {reason:'ENGINE_ERROR'} inside
    // serverRecomputeFromEstimateData — this pins that a failClosed rejection
    // raised DEEP in priceLawnCare still blocks the save instead of riding
    // the fail-open rail (codex #3272 pre-push P0).
    const prev = process.env.GATE_BERMUDA_SUPPRESSION;
    delete process.env.GATE_BERMUDA_SUPPRESSION;
    try {
      const estimateData = {
        engineInputs: {
          turfSf: 5000,
          homeSqFt: 2000,
          services: { lawn: { track: 'st_augustine', tier: 'enhanced', bermudaSuppression: true } },
        },
      };
      await expect(resolveServerAuthoritativePricing({
        estimateData,
        clientPreview,
        quoteRequired: false,
        now: new Date(),
      })).rejects.toMatchObject({ code: 'BERMUDA_SUPPRESSION_GATED', failClosed: true });
    } finally {
      if (prev === undefined) delete process.env.GATE_BERMUDA_SUPPRESSION;
      else process.env.GATE_BERMUDA_SUPPRESSION = prev;
    }
  });

  test('an ordinary engine error still fails OPEN to CLIENT_FALLBACK', async () => {
    const { audit } = await resolveServerAuthoritativePricing({
      estimateData: { engineRequest: { profile: {} } },
      clientPreview,
      quoteRequired: false,
      now: new Date(),
      recompute: async () => { throw new Error('engine broke'); },
    });
    expect(audit.pricing_authority).toBe('CLIENT_FALLBACK');
  });
});

describe('translateV2CallToV1Input GATE_BERMUDA_SUPPRESSION', () => {
  const PROFILE = { homeSqFt: 2000, stories: 1, lotSqFt: 8000, turfSf: 5000 };
  const prevGate = process.env.GATE_BERMUDA_SUPPRESSION;
  afterEach(() => {
    if (prevGate === undefined) delete process.env.GATE_BERMUDA_SUPPRESSION;
    else process.env.GATE_BERMUDA_SUPPRESSION = prevGate;
  });

  test('dark by default: a gated selection FAILS CLOSED (400), never a silent unchanged price', () => {
    delete process.env.GATE_BERMUDA_SUPPRESSION;
    let thrown;
    try {
      translateV2CallToV1Input(PROFILE, ['LAWN'], { bermudaSuppression: true });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeTruthy();
    expect(thrown.statusCode).toBe(400);
    expect(thrown.code).toBe('BERMUDA_SUPPRESSION_GATED');
  });

  test('gate on: option threads through to services.lawn', () => {
    process.env.GATE_BERMUDA_SUPPRESSION = 'true';
    const input = translateV2CallToV1Input(PROFILE, ['LAWN'], { bermudaSuppression: true });
    expect(input.services.lawn.bermudaSuppression).toBe(true);
  });

  test('gate on without the operator selection stays off', () => {
    process.env.GATE_BERMUDA_SUPPRESSION = 'true';
    const input = translateV2CallToV1Input(PROFILE, ['LAWN'], {});
    expect(input.services.lawn.bermudaSuppression).toBeUndefined();
  });
});
