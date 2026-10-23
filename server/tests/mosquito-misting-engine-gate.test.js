/**
 * GATE_MOSQUITO_MISTING: the estimate engine, the legacy mapper and the public
 * price ranges all stay byte-identical while the gate is off, and show the
 * misting system line, the plan row, the one-time install item and the two
 * range rows while it is on.
 */
const { generateEstimate } = require('../services/pricing-engine/estimate-engine');
const { mapV1ToLegacyShape } = require('../services/pricing-engine/v1-legacy-mapper');
const { computePublicPricingRanges } = require('../services/pricing-engine/public-ranges');
const { mosquitoMistingLive } = require('../config/feature-gates');

const PROPERTY = { homeSqFt: 2200, stories: 1, lotSqFt: 12000, propertyType: 'single_family' };
const MISTING = { tier: 'essential', nozzles: 40, risers: 12, solution: 'natural' };

function withMisting(extra = {}) {
  return { ...PROPERTY, services: { pest: { frequency: 'quarterly' }, mosquitoMisting: MISTING, ...extra } };
}
const without = () => ({ ...PROPERTY, services: { pest: { frequency: 'quarterly' } } });

// generateEstimate stamps a time; strip it so two runs compare deep-equal.
function stable(value) {
  return JSON.parse(JSON.stringify(value, (key, v) => (/^(generatedAt|calculatedAt|timestamp|createdAt)$/.test(key) ? undefined : v)));
}

const savedGate = process.env.GATE_MOSQUITO_MISTING;
afterEach(() => {
  if (savedGate === undefined) delete process.env.GATE_MOSQUITO_MISTING;
  else process.env.GATE_MOSQUITO_MISTING = savedGate;
});

describe('gate off (default)', () => {
  beforeEach(() => { delete process.env.GATE_MOSQUITO_MISTING; });

  test('the reader is false', () => {
    expect(mosquitoMistingLive()).toBe(false);
  });

  test('services.mosquitoMisting is ignored: output deep-equals the same input without it', () => {
    expect(stable(generateEstimate(withMisting()))).toEqual(stable(generateEstimate(without())));
  });

  test('the snake_case key is ignored too, and a misting-only input does not throw', () => {
    const snake = { ...PROPERTY, services: { pest: { frequency: 'quarterly' }, mosquito_misting: MISTING } };
    expect(stable(generateEstimate(snake))).toEqual(stable(generateEstimate(without())));
    expect(() => generateEstimate({ ...PROPERTY, services: { mosquitoMisting: MISTING } })).not.toThrow();
  });

  test('mapper output is unchanged', () => {
    expect(stable(mapV1ToLegacyShape(generateEstimate(withMisting()))))
      .toEqual(stable(mapV1ToLegacyShape(generateEstimate(without()))));
  });

  test('public ranges list neither misting row', () => {
    const keys = computePublicPricingRanges({ refresh: true }).services.map((r) => r.key);
    expect(keys).not.toContain('mosquito_misting_install');
    expect(keys).not.toContain('mosquito_misting_plan');
  });
});

describe('gate on', () => {
  beforeEach(() => { process.env.GATE_MOSQUITO_MISTING = 'true'; });

  const install = 3795 + 5 * 75 + 2 * 45; // essential, 40 nozzles, 12 risers

  test('the reader is true', () => {
    expect(mosquitoMistingLive()).toBe(true);
  });

  test('the line is priced and its install lands in year 1', () => {
    const base = generateEstimate(without());
    const est = generateEstimate(withMisting());
    const line = est.lineItems.find((l) => l.service === 'mosquito_misting');
    expect(line).toBeDefined();
    expect(line.installation.price).toBe(install);
    expect(line.annual).toBe(708);
    expect(est.summary.installationTotal).toBe(install);
    expect(est.summary.year1Total).toBeCloseTo(base.summary.year1Total + 708 + install, 2);
  });

  test('misting does not count toward the WaveGuard tier or take a percent discount', () => {
    const base = generateEstimate(without());
    const est = generateEstimate(withMisting());
    expect(est.waveGuard.tier).toBe(base.waveGuard.tier);
    const line = est.lineItems.find((l) => l.service === 'mosquito_misting');
    expect(line.annualAfterDiscount).toBe(708);
    expect(line.discount.effectiveDiscount).toBe(0);
  });

  test('a misting-only estimate prices and adds the install to year 1', () => {
    const est = generateEstimate({ ...PROPERTY, services: { mosquito_misting: MISTING } });
    expect(est.summary.installationTotal).toBe(install);
    expect(est.summary.year1Total).toBeCloseTo(708 + install, 2);
  });

  test('an oversize request is a manual quote and adds nothing to the totals', () => {
    const est = generateEstimate({ ...PROPERTY, services: { mosquitoMisting: { nozzles: 120 } } });
    const line = est.lineItems.find((l) => l.service === 'mosquito_misting');
    expect(line.quoteRequired).toBe(true);
    expect(est.summary.installationTotal).toBe(0);
    expect(est.summary.year1Total).toBe(0);
    // The requested work stays visible in the mapped shape as an unpriced,
    // quote-required row (pre-push audit P1), and no install item is emitted.
    const mapped = mapV1ToLegacyShape(est);
    const row = mapped.recurring.services.find((s) => s.service === 'mosquito_misting');
    expect(row).toMatchObject({ quoteRequired: true, monthly: 0, annual: null });
    expect(row.manualReviewReasons).toContain('mosquito_misting_oversize');
    expect(mapped.oneTime.items.find((i) => i.service === 'mosquito_misting_installation')).toBeUndefined();
    expect(mapped.quoteRequired).toBe(true);
  });

  test('an oversize layout beside pest keeps the solo pest setup fee and year 1 (the unpriced row is not a second plan)', () => {
    const solo = mapV1ToLegacyShape(generateEstimate(without()));
    expect(solo.oneTime.membershipFee).toBeGreaterThan(0);
    for (const oversize of [{ nozzles: 120 }, { risers: 200 }]) {
      const mapped = mapV1ToLegacyShape(generateEstimate(withMisting({ mosquitoMisting: oversize })));
      expect(mapped.recurring.services.find((s) => s.service === 'mosquito_misting')).toMatchObject({ quoteRequired: true });
      expect(mapped.oneTime.membershipFee).toBe(solo.oneTime.membershipFee);
      expect(mapped.totals.year1).toBe(solo.totals.year1);
    }
  });

  test('mapper emits the plan line and the one-time install item', () => {
    const mapped = mapV1ToLegacyShape(generateEstimate(withMisting()));
    const plan = mapped.recurring.services.find((s) => s.service === 'mosquito_misting');
    expect(plan).toMatchObject({
      name: 'Mosquito Misting Service Plan',
      monthly: 59,
      perTreatment: 59,
      visitsPerYear: 12,
      discountable: false,
      countsTowardWaveGuardTier: false,
    });
    expect(plan.detail).toBe('40 nozzles · 12 applications/yr · $59 per application · Natural (botanical) refill $219 per refill application');
    const item = mapped.oneTime.items.find((i) => i.service === 'mosquito_misting_installation');
    expect(item).toMatchObject({
      name: 'Essential system (drum) Installation',
      price: install,
    });
    expect(item.detail).toBe('40 nozzles · 12 risers · Natural (botanical) refill $219 per refill application');
    // Year 1 = the pest year + the plan + the install. The solo pest $99 setup
    // fee drops because pest + misting is a multi-service mix (the existing
    // bundle rule in estimate-converter, unchanged by this lane).
    const base = mapV1ToLegacyShape(generateEstimate(without()));
    expect(base.oneTime.membershipFee).toBeGreaterThan(0);
    expect(mapped.oneTime.membershipFee).toBe(0);
    expect(mapped.totals.year1).toBeCloseTo(base.totals.year1 - base.oneTime.membershipFee + 708 + install, 2);
    // A misting-only estimate carries no setup fee and year 1 is plan + install.
    const solo = mapV1ToLegacyShape(generateEstimate({ ...PROPERTY, services: { mosquitoMisting: MISTING } }));
    expect(solo.oneTime.membershipFee).toBe(0);
    expect(solo.totals.year1).toBeCloseTo(708 + install, 2);
  });

  test('public ranges add the two rows', () => {
    const rows = computePublicPricingRanges({ refresh: true }).services;
    const inst = rows.find((r) => r.key === 'mosquito_misting_install');
    const plan = rows.find((r) => r.key === 'mosquito_misting_plan');
    expect(inst.name).toBe('Mosquito Misting System Installation');
    // essential 20 nozzles (below included, no credit) to smart 50 nozzles.
    expect(inst.low).toBe(3795);
    expect(inst.high).toBe(4595 + 15 * 75);
    expect(plan.name).toBe('Mosquito Misting Service Plan (monthly application)');
    expect(plan.unit).toBe('per application');
    expect(`${plan.notes} ${inst.notes}`).not.toMatch(/per month|per visit|\/mo/i);
    expect(plan.low).toBe(59);
    expect(plan.high).toBe(59);
  });
});

describe('gate on: commercial property', () => {
  beforeAll(() => { process.env.GATE_MOSQUITO_MISTING = 'true'; });
  afterAll(() => { delete process.env.GATE_MOSQUITO_MISTING; });

  test('a commercial input takes the commercial manual-quote rail, never the residential misting price', () => {
    const est = generateEstimate({ ...PROPERTY, propertyType: 'commercial', isCommercial: true, services: { mosquitoMisting: { tier: 'essential', nozzles: 40 } } });
    const priced = est.lineItems.find((l) => l.service === 'mosquito_misting' && l.quoteRequired === false);
    expect(priced).toBeUndefined();
    expect(est.summary.installationTotal).toBe(0);
    const manual = JSON.stringify(est);
    expect(manual).toMatch(/commercial/i);
    expect(manual).not.toMatch(/4170/);
  });
});
