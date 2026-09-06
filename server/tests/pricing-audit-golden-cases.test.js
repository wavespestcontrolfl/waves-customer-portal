/**
 * pricing-audit-golden-cases.test.js
 *
 * Golden and boundary cases from the 2026-09-02 estimator pricing audit
 * (docs/estimator-pricing-audit.md). Every expected number below is
 * reconstructed INDEPENDENTLY of the engine by scripts/audit-estimator-pricing.js
 * (constants + documented formula), so a test failure means the engine and the
 * documented formula have diverged — not that a baseline JSON was regenerated.
 *
 * Runs on in-code constants (no DB). Values that are DB-authoritative in prod
 * (pest floor = $79 in pricing_config vs $89 in constants.js at audit time) are
 * asserted through the constants object, never as literals.
 *
 * Two suites, deliberately distinct (codex r2 P1 on PR #3792):
 *   - formula parity (below): the independent calculator vs the engine, both
 *     reading the live constants — proves the engine implements the documented
 *     formula, NOT that today's prices are unchanged.
 *   - FROZEN GOLDEN PRICES (last block): reviewed literals captured from the
 *     in-code constants on 2026-09-03. A change to any constant, bracket or
 *     discount fails these on purpose; update the literal only with the price
 *     change that justifies it (pricing-config skill).
 */
const path = require('path');

const constants = require('../services/pricing-engine/constants');
const { generateEstimate } = require('../services/pricing-engine/estimate-engine');
const audit = require(path.join(__dirname, '..', '..', 'scripts', 'audit-estimator-pricing.js'));

const BASE = { homeSqFt: 2000, stories: 1, lotSqFt: 8000, lawnSqFt: 4500, propertyType: 'single_family' };
const line = (result, service) => result.lineItems.find((l) => l.service === service);
const close = (a, b, tol = 0.005) => Math.abs(a - b) <= tol;

describe('pricing audit — pest control golden + boundary cases', () => {
  const boundaries = constants.PEST.footprintBrackets.map((b) => b.sqft);
  const sizes = [...new Set([500, ...boundaries, ...boundaries.map((b) => b - 1), ...boundaries.map((b) => b + 1), 10000])].sort((a, b) => a - b);
  test.each(sizes.flatMap((sqft) => ['quarterly', 'bimonthly', 'monthly'].map((frequency) => [sqft, frequency])))(
    'footprint %s %s: perApp/annual/monthly match the documented bracket formula',
    (sqft, frequency) => {
      const exp = audit.expectPest({ homeSqFt: sqft, frequency });
      const li = line(generateEstimate({ ...BASE, homeSqFt: sqft, services: { pest: { frequency } } }), 'pest_control');
      expect(li.perApp).toBe(exp.perApp);
      expect(li.annual).toBe(exp.annual);
      expect(li.monthly).toBe(exp.monthly);
      expect(li.visitsPerYear).toBe(exp.visits);
      // cadence identity: perApp × visits = annual, monthly × 12 ≈ annual
      expect(close(li.perApp * li.visitsPerYear, li.annual)).toBe(true);
      expect(close(li.monthly * 12, li.annual, 0.06)).toBe(true);
    },
  );

  test('2,000 sf reference home prices at PEST.base with a $99 setup fee on the line', () => {
    const li = line(generateEstimate({ ...BASE, services: { pest: { frequency: 'quarterly' } } }), 'pest_control');
    expect(li.basePrice).toBe(constants.PEST.base);
    expect(li.initialFee).toBe(constants.PEST.initialFee);
  });

  test('the per-visit floor binds for a tiny condo and equals the live PEST.floor', () => {
    const li = line(generateEstimate({ ...BASE, homeSqFt: 600, propertyType: 'condo_upper', services: { pest: { frequency: 'quarterly' } } }), 'pest_control');
    expect(li.basePrice).toBe(constants.PEST.floor);
  });

  test('frequency multipliers follow the live v2 curve (quarterly 1.00 reference)', () => {
    const q = line(generateEstimate({ ...BASE, services: { pest: { frequency: 'quarterly' } } }), 'pest_control');
    const b = line(generateEstimate({ ...BASE, services: { pest: { frequency: 'bimonthly' } } }), 'pest_control');
    const m = line(generateEstimate({ ...BASE, services: { pest: { frequency: 'monthly' } } }), 'pest_control');
    expect(b.perApp).toBe(Math.round(q.basePrice * constants.PEST.frequencyDiscounts.v2.bimonthly * 100) / 100);
    expect(m.perApp).toBe(Math.round(q.basePrice * constants.PEST.frequencyDiscounts.v2.monthly * 100) / 100);
  });

  test('audit finding: an unsupported cadence (semiannual) silently prices as quarterly with a warning only', () => {
    const li = line(generateEstimate({ ...BASE, services: { pest: { frequency: 'semiannual' } } }), 'pest_control');
    expect(li.frequency).toBe('quarterly');
    expect(li.frequencyWasDefaulted).toBe(true);
  });
});

describe('pricing audit — lawn care golden + boundary cases', () => {
  const tracks = Object.keys(constants.LAWN_BRACKETS);
  const rowEdges = constants.LAWN_BRACKETS.st_augustine.map((r) => r[0]);
  const sizes = [...new Set([1000, ...rowEdges, ...rowEdges.map((x) => x - 1), ...rowEdges.map((x) => x + 1), 4250, 20001, 30000])].sort((a, b) => a - b);
  test.each(tracks.flatMap((track) => sizes.flatMap((sqft) => ['standard', 'enhanced', 'premium'].map((tier) => [track, sqft, tier]))))(
    '%s %s sf %s: bracket interpolation + cadence caps reproduce the engine',
    (track, sqft, tier) => {
      const exp = audit.expectLawn({ track, lawnSqFt: sqft, tier });
      const li = line(generateEstimate({ ...BASE, lawnSqFt: sqft, services: { lawn: { track, tier } } }), 'lawn_care');
      expect(li.perApp).toBe(exp.perApp);
      expect(li.annual).toBe(exp.annual);
      expect(li.monthly).toBe(exp.monthly);
      expect(li.customQuoteFlag).toBe(sqft > constants.LAWN_TABLE_MAX_SQFT);
    },
  );

  test('canonical anchor: 4,250 sf St. Augustine 9x = $64/app · $576/yr · $48/mo', () => {
    const li = line(generateEstimate({ ...BASE, lawnSqFt: 4250, services: { lawn: { track: 'st_augustine', tier: 'enhanced' } } }), 'lawn_care');
    expect(li.perApp).toBe(64);
    expect(li.annual).toBe(576);
    expect(li.monthly).toBe(48);
  });

  test('cadence ladder: per-application price never rises with more visits inside the table', () => {
    for (const track of tracks) {
      for (const sqft of [2000, 4500, 8000, 12000, 20000]) {
        const pa = ['standard', 'enhanced', 'premium'].map((tier) => line(generateEstimate({ ...BASE, lawnSqFt: sqft, services: { lawn: { track, tier } } }), 'lawn_care').perApp);
        expect(pa[1]).toBeLessThanOrEqual(pa[0] + 0.005);
        expect(pa[2]).toBeLessThanOrEqual(pa[1] + 0.005);
      }
    }
  });

  test('audit finding (documented): the engine cost model at list price is below the 35% floor for the reference lawn', () => {
    const li = line(generateEstimate({ ...BASE, services: { lawn: { track: 'st_augustine', tier: 'enhanced' } } }), 'lawn_care');
    expect(li.marginFloorOk).toBe(false);
    expect(li.margin).toBeLessThan(constants.GLOBAL.MARGIN_FLOOR);
  });
});

describe('pricing audit — mosquito, rodent bait, termite bait', () => {
  test.each([3000, 5000, 8000, 12000, 15000, 20000, 25000, 35000, 45000, 60000, 90000].flatMap((lot) => ['seasonal9', 'monthly12'].map((program) => [lot, program])))(
    'mosquito lot %s %s: treatable-area anchors reproduce the engine',
    (lot, program) => {
      const exp = audit.expectMosquito({ homeSqFt: 2000, lotSqFt: lot, program });
      const li = line(generateEstimate({ ...BASE, lotSqFt: lot, lawnSqFt: undefined, services: { mosquito: { tier: program } } }), 'mosquito');
      expect(li.perVisit).toBe(exp.perVisit);
      expect(li.annual).toBe(exp.annual);
      expect(li.visits).toBe(exp.visits);
    },
  );

  test('mosquito: monthly12 per-visit never exceeds seasonal9 per-visit at the same size', () => {
    for (const lot of [5000, 10000, 20000, 40000]) {
      const s = line(generateEstimate({ ...BASE, lotSqFt: lot, lawnSqFt: undefined, services: { mosquito: { tier: 'seasonal9' } } }), 'mosquito').perVisit;
      const m = line(generateEstimate({ ...BASE, lotSqFt: lot, lawnSqFt: undefined, services: { mosquito: { tier: 'monthly12' } } }), 'mosquito').perVisit;
      expect(m).toBeLessThanOrEqual(s);
    }
  });

  const rodentEdges = constants.RODENT.baitBrackets.map((b) => b.maxSqFt);
  test.each([...new Set([600, ...rodentEdges, ...rodentEdges.map((e) => e - 1), ...rodentEdges.map((e) => e + 1), 7750, 12000])].sort((a, b) => a - b))(
    'rodent bait footprint %s: bracket + ladder extension reproduce the engine',
    (sqft) => {
      const exp = audit.expectRodentBait({ homeSqFt: sqft });
      const li = line(generateEstimate({ ...BASE, homeSqFt: sqft, services: { rodentBait: {} } }), 'rodent_bait');
      expect(li.perVisit).toBe(exp.perVisit);
      expect(li.stations).toBe(exp.stations);
      expect(li.annual).toBe(exp.annual);
    },
  );

  test('rodent bait $99 setup fee applies stand-alone and is waived beside a qualifying recurring service', () => {
    const solo = generateEstimate({ ...BASE, services: { rodentBait: {} } });
    const bundled = generateEstimate({ ...BASE, services: { rodentBait: {}, pest: { frequency: 'quarterly' } } });
    // Literal, not the constant (codex r26 P2): an accidental edit to
    // RODENT.baitSetupFee must fail here rather than move both sides together.
    expect(solo.summary.rodentBaitSetupTotal).toBe(99);
    expect(solo.summary.rodentBaitSetupTotal).toBe(constants.RODENT.baitSetupFee);
    expect(bundled.summary.rodentBaitSetupTotal).toBe(0);
  });

  test.each([800, 1600, 2000, 3200, 6000])('termite bait footprint %s: perimeter → stations → install (1.45× material) + bracket monitoring', (sqft) => {
    const exp = audit.expectTermiteBait({ homeSqFt: sqft });
    const li = line(generateEstimate({ ...BASE, homeSqFt: sqft, services: { termite: { system: 'trelona' } } }), 'termite_bait');
    expect(li.installation.price).toBe(exp.installPrice);
    expect(li.monitoring.monthly).toBe(exp.monitoringMonthly);
  });
});

describe('pricing audit — one-time pest, discounts, tiers', () => {
  test.each([800, 1200, 2000, 3000, 5500].flatMap((sqft) => [false, true].map((rc) => [sqft, rc])))(
    'one-time pest %s sf recurringCustomer=%s: max(floor, 2.2×quarterly) with the strict visit-1 clamp',
    (sqft, rc) => {
      const exp = audit.expectOneTimePest({ homeSqFt: sqft, isRecurringCustomer: rc });
      const li = line(generateEstimate({ ...BASE, homeSqFt: sqft, recurringCustomer: rc, isRecurringCustomer: rc, services: { oneTimePest: {} } }), 'one_time_pest');
      expect(li.price).toBe(exp.price);
      expect(li.price).toBeGreaterThan(exp.visitOne);
    },
  );

  test('one-time pest stand-alone vs paired with recurring pest is a documented 15% perk, not an unexplained difference', () => {
    const solo = line(generateEstimate({ ...BASE, services: { oneTimePest: {} } }), 'one_time_pest');
    const paired = line(generateEstimate({ ...BASE, services: { oneTimePest: {}, pest: { frequency: 'quarterly' } } }), 'one_time_pest');
    const perk = audit.expectOneTimePest({ homeSqFt: 2000, isRecurringCustomer: true });
    expect(solo.price).toBe(audit.expectOneTimePest({ homeSqFt: 2000 }).price);
    expect(paired.price).toBe(perk.price);
  });

  const keyMap = { pest: 'pest_control', lawn: 'lawn_care', mosquito: 'mosquito', treeShrub: 'tree_shrub', rodentBait: 'rodent_bait', palmInjection: 'palm_injection', termite: 'termite_bait' };
  const serviceInput = (k) => (k === 'pest' ? { frequency: 'quarterly' } : k === 'lawn' ? { track: 'st_augustine', tier: 'enhanced' } : k === 'mosquito' ? { tier: 'seasonal9' } : k === 'treeShrub' ? { tier: 'standard', treeCount: 6 } : k === 'palmInjection' ? { treatmentType: 'nutrition', palmCount: 3 } : k === 'termite' ? { system: 'trelona' } : {});
  test.each([[['pest']], [['pest', 'lawn']], [['pest', 'lawn', 'mosquito']], [['pest', 'lawn', 'mosquito', 'treeShrub']], [['rodentBait']], [['rodentBait', 'pest']], [['palmInjection', 'pest', 'lawn', 'mosquito']], [['termite', 'pest']]])(
    'WaveGuard tier + per-line discount for %j',
    (combo) => {
      const services = Object.fromEntries(combo.map((k) => [k, serviceInput(k)]));
      const res = generateEstimate({ ...BASE, bedArea: 2000, services });
      const exp = audit.expectTier(combo.map((k) => keyMap[k]));
      expect(res.waveGuard.tier).toBe(exp.tier);
      expect(res.waveGuard.discount).toBe(exp.discount);
      for (const li of res.lineItems) {
        if (!Number.isFinite(li.annual) || li.annual <= 0) continue;
        const eligible = constants.WAVEGUARD.qualifyingServices.includes(li.service) && !constants.WAVEGUARD.excludedFromPercentDiscount[li.service];
        if (eligible) expect(close(li.annualAfterDiscount, Math.round(li.annual * (1 - exp.discount) * 100) / 100)).toBe(true);
        if (li.service === 'palm_injection') expect(li.discount.effectiveDiscount).toBe(0);
      }
      const afterLines = res.lineItems.filter((l) => Number.isFinite(l.annualAfterDiscount));
      const sumAfter = Math.round(afterLines.reduce((s, l) => s + l.annualAfterDiscount, 0) * 100) / 100;
      // cent-scale: one half-cent of rounding per summed line is the only legitimate slack
      expect(close(sumAfter, res.summary.recurringAnnualAfterDiscount, afterLines.length * 0.005 + 0.001)).toBe(true);
    },
  );

  test('palm injection is never tier-counted and never receives the percentage', () => {
    const res = generateEstimate({ ...BASE, services: { palmInjection: { treatmentType: 'nutrition', palmCount: 3 }, pest: { frequency: 'quarterly' } } });
    expect(res.waveGuard.qualifyingCount).toBe(1);
    expect(line(res, 'palm_injection').discount.effectiveDiscount).toBe(0);
  });

  test('Gold+ palm flat credit is capped at the palm annual (never negative)', () => {
    const res = generateEstimate({ ...BASE, bedArea: 2000, services: { palmInjection: { treatmentType: 'nutrition', palmCount: 1 }, pest: { frequency: 'quarterly' }, lawn: { tier: 'enhanced' }, mosquito: { tier: 'seasonal9' } } });
    const palm = line(res, 'palm_injection');
    expect(res.waveGuard.tier).toBe('gold');
    expect(palm.discount.flatCreditAnnual).toBeLessThanOrEqual(palm.annual);
    expect(palm.annualAfterDiscount).toBeGreaterThanOrEqual(0);
  });

  test('audit finding (documented): a FIXED manual discount can zero a whole estimate — no cap exists', () => {
    const res = generateEstimate({ ...BASE, bedArea: 2000, services: { pest: { frequency: 'quarterly' }, lawn: { tier: 'enhanced' } }, manualDiscount: { type: 'FIXED', value: 99999, label: 'audit', internalReason: 'audit' } });
    expect(Math.abs(res.summary.recurringAnnualAfterDiscount)).toBe(0); // engine returns -0 here (rounding of a negative remainder)
  });

  test('margin floors are report-only: Platinum stacking below 35% is surfaced, never enforced', () => {
    const res = generateEstimate({ ...BASE, bedArea: 2000, services: { pest: { frequency: 'quarterly' }, lawn: { tier: 'enhanced' }, mosquito: { tier: 'seasonal9' }, treeShrub: { tier: 'standard', treeCount: 6 } } });
    expect(res.waveGuard.tier).toBe('platinum');
    const lawn = line(res, 'lawn_care');
    expect(lawn.annualAfterDiscount).toBe(Math.round(lawn.annual * 0.8 * 100) / 100);
    expect(res.marginWarnings.some((w) => w.service === 'lawn_care' && w.margin < constants.GLOBAL.MARGIN_FLOOR)).toBe(true);
  });
});

describe('pricing audit — tree & shrub and palm count', () => {
  test.each([[500, 0, 0, 'light'], [1000, 3, 0, 'standard'], [2000, 6, 4, 'standard'], [4000, 10, 0, 'enhanced'], [8000, 15, 0, 'standard'], [14000, 20, 0, 'standard']])(
    'T&S bed %s sf, %s trees, %s palms, %s: cost buildup ÷ (1 − 0.45) reproduces the engine',
    (bedArea, treeCount, palmCount, tier) => {
      const exp = audit.expectTreeShrub({ bedArea, treeCount, palmCount, tier });
      const li = line(generateEstimate({ ...BASE, bedArea, services: { treeShrub: { tier, treeCount, ...(palmCount ? { palmCount } : {}), access: 'easy' } } }), 'tree_shrub');
      expect(li.monthly).toBe(exp.monthly);
      expect(li.annual).toBe(exp.annual);
      expect(li.onSiteMin).toBe(exp.onSiteMin);
    },
  );

  test('audit finding P1: palms supplied at PROPERTY level do not change the T&S price; the same palms on the service line do', () => {
    const noPalm = line(generateEstimate({ ...BASE, bedArea: 2000, services: { treeShrub: { tier: 'standard', treeCount: 6 } } }), 'tree_shrub');
    const propertyPalms = line(generateEstimate({ ...BASE, bedArea: 2000, palmCount: 30, services: { treeShrub: { tier: 'standard', treeCount: 6 } } }), 'tree_shrub');
    const linePalms = line(generateEstimate({ ...BASE, bedArea: 2000, services: { treeShrub: { tier: 'standard', treeCount: 6, palmCount: 30 } } }), 'tree_shrub');
    expect(propertyPalms.monthly).toBe(noPalm.monthly); // current behavior — the admin builder sends palms this way
    expect(linePalms.monthly).toBeGreaterThan(noPalm.monthly); // the public quote form sends palms this way
  });

  test('audit finding P2: explicit treeCount 0 suppresses the tree-density fallback with no review flag', () => {
    const zero = line(generateEstimate({ ...BASE, bedArea: 2000, treeDensity: 'heavy', features: { treeCount: 0 }, services: { treeShrub: { tier: 'standard' } } }), 'tree_shrub');
    const absent = line(generateEstimate({ ...BASE, bedArea: 2000, treeDensity: 'heavy', services: { treeShrub: { tier: 'standard' } } }), 'tree_shrub');
    expect(zero.treeCountSource).toBe('explicit');
    expect(absent.treeCountSource).toBe('density_estimate');
    expect(zero.monthly).toBeLessThan(absent.monthly);
    expect(zero.requiresManualReview).toBe(false);
  });

  test('bed area at/above the review threshold parks the line for manual review', () => {
    const below = line(generateEstimate({ ...BASE, bedArea: constants.BED_AREA_REVIEW_SQFT - 1, services: { treeShrub: { tier: 'standard', treeCount: 3 } } }), 'tree_shrub');
    const at = line(generateEstimate({ ...BASE, bedArea: constants.BED_AREA_REVIEW_SQFT, services: { treeShrub: { tier: 'standard', treeCount: 3 } } }), 'tree_shrub');
    expect(below.manualReviewReasons).not.toContain('bed_area_at_or_above_8000');
    expect(at.requiresManualReview).toBe(true);
  });

  test('palm injection requires a positive integer palm count and applies the $75 visit minimum', () => {
    expect(() => generateEstimate({ ...BASE, services: { palmInjection: { treatmentType: 'nutrition', palmCount: 0 } } })).toThrow();
    expect(() => generateEstimate({ ...BASE, services: { palmInjection: { treatmentType: 'nutrition', palmCount: 2.5 } } })).toThrow();
    const one = line(generateEstimate({ ...BASE, services: { palmInjection: { treatmentType: 'nutrition', palmCount: 1 } } }), 'palm_injection');
    expect(one.perVisit).toBe(constants.PALM.minPerVisit);
    const three = line(generateEstimate({ ...BASE, services: { palmInjection: { treatmentType: 'nutrition', palmCount: 3 } } }), 'palm_injection');
    expect(three.perVisit).toBe(3 * constants.PALM.treatments.nutrition.pricePerPalm);
  });
});

describe('pricing audit — specialty flat / cost-plus services', () => {
  test('WDO is a single flat bracket', () => {
    expect(line(generateEstimate({ ...BASE, services: { wdo: {} } }), 'wdo_inspection').price).toBe(constants.SPECIALTY.wdo.brackets[0].price);
  });
  test.each(['light', 'moderate', 'heavy', 'severe'])('German roach cleanout %s tier', (severity) => {
    const exp = audit.expectGermanRoach(severity);
    const li = line(generateEstimate({ ...BASE, services: { germanRoach: { severity } } }), 'german_roach');
    expect(li.price).toBe(exp.price);
    expect(li.visits).toBe(exp.visits);
  });
  test('audit finding P2: a missing German roach severity defaults to the cheapest tier with only a flag', () => {
    const li = line(generateEstimate({ ...BASE, services: { germanRoach: {} } }), 'german_roach');
    expect(li.severityWasDefaulted).toBe(true);
    expect(li.price).toBe(constants.SPECIALTY.germanRoach.tiers.light.price);
  });
  test.each([1, 5, 6, 10, 11, 15, 16, 20])('foam drill %s points: cost ÷ 0.45 (55%% target margin), no floor', (points) => {
    const exp = audit.expectFoamDrill(points);
    expect(line(generateEstimate({ ...BASE, services: { foam: { points } } }), 'foam_drill').price).toBe(exp.price);
  });
  test('foam drill above the 20-point maximum fails closed (throws) instead of pricing the top tier', () => {
    expect(() => generateEstimate({ ...BASE, services: { foam: { points: 25 } } })).toThrow(/exceeds the configured 20-point maximum/);
  });
  test.each([[2000, 'eighth'], [4500, 'quarter'], [8000, 'eighth']])('top dressing %s sf %s uses the 65%% treatable assumption when no recurring lawn', (sqft, depth) => {
    const exp = audit.expectTopDressing(sqft, depth, false);
    const li = line(generateEstimate({ ...BASE, lawnSqFt: sqft, services: { topDressing: { depth, area: sqft } } }), 'top_dressing');
    expect(li.price).toBe(exp.price);
    expect(li.lawnSqFt).toBe(exp.lawnEst);
  });
  test.each([[1000, 12], [4500, 9], [10000, 6]])('plugging %s sf at %s in spacing', (sqft, spacing) => {
    expect(line(generateEstimate({ ...BASE, lawnSqFt: sqft, services: { plugging: { area: sqft, spacing } } }), 'plugging').price).toBe(audit.expectPlugging(sqft, spacing).price);
  });
});

describe('pricing audit — margin vs markup and unit economics', () => {
  test('unit-economics helper distinguishes gross margin from markup', () => {
    const e = audit.unitEconomics({ revenuePerVisit: 100, visits: 4, onSiteMinutes: 40, driveMinutes: 20, materialPerVisit: 10, adminAnnual: 0 });
    // labor = 1h × $35 = 35; direct/visit = 45; annual direct 180; revenue 400
    expect(e.directPerVisit).toBe(45);
    expect(e.grossMargin).toBe(0.55);
    expect(e.markup).toBe(1.222);
    expect(e.targetPriceAnnualAt35).toBe(Math.round((180 / 0.65) * 100) / 100);
  });

  test('pest cost model: a 2,000 sf quarterly plan reports the engine margin at 25 on-site + 20 drive minutes; a 44-minute RECORDED span (includes drive, MON-004) fed with no extra drive lands beside it, and re-adding drive is the double count', () => {
    const li = line(generateEstimate({ ...BASE, services: { pest: { frequency: 'quarterly' } } }), 'pest_control');
    const modeled = audit.unitEconomics({ revenuePerVisit: li.perApp, visits: 4, onSiteMinutes: 25, materialPerVisit: li.costs.materialPerVisit });
    // Recorded spans are not on-site time (check-out often happens while
    // driving): the span already contains the drive, so it replaces
    // on-site + drive and driveMinutes is 0. No target price is derived from
    // it — the assertion only pins the honest relationship.
    const span = audit.RECORDED_VISIT_SPAN_MINUTES.pest_control_quarterly.median;
    const recordedSpan = audit.unitEconomics({ revenuePerVisit: li.perApp, visits: 4, onSiteMinutes: span, driveMinutes: 0, materialPerVisit: li.costs.materialPerVisit });
    const doubleCounted = audit.unitEconomics({ revenuePerVisit: li.perApp, visits: 4, onSiteMinutes: span, materialPerVisit: li.costs.materialPerVisit });
    expect(Math.abs(modeled.grossMargin - li.margin)).toBeLessThan(0.01);
    // 44 recorded minutes vs the engine's 25 + 20: within a few points.
    expect(Math.abs(recordedSpan.grossMargin - modeled.grossMargin)).toBeLessThan(0.03);
    // Re-adding the 20-minute drive on top of a span that contains it
    // understates the margin by ~10 points — the trap the relabel closes.
    expect(doubleCounted.grossMargin).toBeLessThan(recordedSpan.grossMargin - 0.05);
  });

  test('every markup site is catalogued with its margin equivalent', () => {
    const sites = audit.markupVsMarginAudit();
    expect(sites.find((s) => s.site.startsWith('TERMITE.installMultiplier')).equivalentMargin).toBe(Math.round((1 - 1 / constants.TERMITE.installMultiplier) * 100) / 100);
  });
});

describe('pricing audit — input integrity (documents current behavior for the remediation plan)', () => {
  test('a decimal story count prices a fabricated footprint with no review flag (P2)', () => {
    const li = line(generateEstimate({ ...BASE, stories: 2.7, services: { pest: { frequency: 'quarterly' } } }), 'pest_control');
    expect(li.footprintUsed).toBe(Math.round(2000 / 2.7));
    expect(li.requiresManualReview).toBe(false);
  });
  test('an absurd home size (1e9 sf) is priced at the top bracket with no review flag (P2)', () => {
    const li = line(generateEstimate({ ...BASE, homeSqFt: 1e9, services: { pest: { frequency: 'quarterly' } } }), 'pest_control');
    expect(li.perApp).toBeGreaterThan(0);
    expect(li.requiresManualReview).toBe(false);
  });
  test('a zero lawn area still prices the smallest bracket with no review flag (P2)', () => {
    const li = line(generateEstimate({ ...BASE, lawnSqFt: 0, services: { lawn: { tier: 'enhanced' } } }), 'lawn_care');
    expect(li.lawnSqFt).toBe(0);
    expect(li.perApp).toBeGreaterThan(0);
    expect(li.requiresManualReview).toBe(false);
  });
  test('rodent bait with no footprint prices the 2,500 sf bracket silently (P2)', () => {
    const li = line(generateEstimate({ ...BASE, homeSqFt: undefined, services: { rodentBait: {} } }), 'rodent_bait');
    expect(li.footprintUsed).toBe(2500);
    expect(li.requiresManualReview).toBeFalsy();
  });
});

describe("pricing audit — FROZEN golden prices (in-code constants, reviewed 2026-09-03)", () => {
  // Literals, not formulas: these pin today's list prices independently of the
  // constants object so an accidental constant edit cannot move both sides.
  const FROZEN = [
    ["pest quarterly 1,000 sf", { ...BASE, homeSqFt: 1000, services: { pest: { frequency: "quarterly" } } }, "pest_control", { perApp: 100, annual: 400, monthly: 33.33, visitsPerYear: 4, initialFee: 99 }],
    ["pest quarterly 2,000 sf", { ...BASE, services: { pest: { frequency: "quarterly" } } }, "pest_control", { perApp: 112, annual: 448, monthly: 37.33, visitsPerYear: 4, initialFee: 99 }],
    ["pest quarterly 3,500 sf", { ...BASE, homeSqFt: 3500, services: { pest: { frequency: "quarterly" } } }, "pest_control", { perApp: 120, annual: 480, monthly: 40, visitsPerYear: 4 }],
    ["pest quarterly 5,000 sf", { ...BASE, homeSqFt: 5000, services: { pest: { frequency: "quarterly" } } }, "pest_control", { perApp: 126, annual: 504, monthly: 42, visitsPerYear: 4 }],
    ["pest bimonthly 2,000 sf", { ...BASE, services: { pest: { frequency: "bimonthly" } } }, "pest_control", { perApp: 98.56, annual: 591.36, monthly: 49.28, visitsPerYear: 6 }],
    ["pest monthly 2,000 sf", { ...BASE, services: { pest: { frequency: "monthly" } } }, "pest_control", { perApp: 87.36, annual: 1048.32, monthly: 87.36, visitsPerYear: 12 }],
    ["lawn St. Augustine standard 4,250 sf", { ...BASE, lawnSqFt: 4250, services: { lawn: { track: "st_augustine", tier: "standard" } } }, "lawn_care", { perApp: 76, annual: 456, monthly: 38 }],
    ["lawn St. Augustine standard 8,000 sf", { ...BASE, lawnSqFt: 8000, services: { lawn: { track: "st_augustine", tier: "standard" } } }, "lawn_care", { perApp: 94, annual: 564, monthly: 47 }],
    ["lawn St. Augustine premium 4,500 sf", { ...BASE, services: { lawn: { track: "st_augustine", tier: "premium" } } }, "lawn_care", { perApp: 64, annual: 768, monthly: 64 }],
    ["lawn zoysia standard 4,500 sf", { ...BASE, services: { lawn: { track: "zoysia", tier: "standard" } } }, "lawn_care", { perApp: 84, annual: 504, monthly: 42 }],
    ["mosquito seasonal9 8,000 sf lot", { ...BASE, lawnSqFt: undefined, services: { mosquito: { tier: "seasonal9" } } }, "mosquito", { perVisit: 77, annual: 693, monthly: 57.75 }],
    ["mosquito monthly12 15,000 sf lot", { ...BASE, lotSqFt: 15000, lawnSqFt: undefined, services: { mosquito: { tier: "monthly12" } } }, "mosquito", { perVisit: 72, annual: 864, monthly: 72 }],
    ["rodent bait 2,000 sf", { ...BASE, services: { rodentBait: {} } }, "rodent_bait", { perVisit: 89, annual: 356, monthly: 29.67, visitsPerYear: 4 }],
    ["termite bait (Trelona) 2,000 sf monitoring", { ...BASE, services: { termite: { system: "trelona" } } }, "termite_bait", { perApp: 72, annual: 288, monthly: 24, visitsPerYear: 4 }],
    ["one-time pest 2,000 sf", { ...BASE, services: { oneTimePest: {} } }, "one_time_pest", { price: 246, priceAfterDiscount: 246, multiplier: 2.2, basePrice: 112, selectedFloor: 199 }],
    // The remaining independently audited customer-price families (codex r18 P2):
    // tree & shrub tiers, palm injection, German roach, WDO — an edit to
    // TREE_SHRUB.tiers, PALM or SPECIALTY moves the engine AND the formula-parity
    // helper together; only a literal catches it.
    ["tree & shrub standard 2,000 sf beds, 6 trees", { ...BASE, bedArea: 2000, services: { treeShrub: { tier: "standard", treeCount: 6 } } }, "tree_shrub", { perApp: 106.17, annual: 637, monthly: 53.08, visitsPerYear: 6 }],
    ["tree & shrub enhanced 1,000 sf beds, 3 trees", { ...BASE, bedArea: 1000, services: { treeShrub: { tier: "enhanced", treeCount: 3 } } }, "tree_shrub", { perApp: 70.22, annual: 632, monthly: 52.67, visitsPerYear: 9 }],
    ["tree & shrub light 4,000 sf beds, 10 trees, difficult access", { ...BASE, bedArea: 4000, services: { treeShrub: { tier: "light", treeCount: 10, access: "difficult" } } }, "tree_shrub", { perApp: 189, annual: 756, monthly: 63, visitsPerYear: 4 }],
    ["palm injection insecticide, 4 medium palms", { ...BASE, services: { palmInjection: { treatmentType: "insecticide", palmCount: 4, palmSize: "medium" } } }, "palm_injection", { pricePerPalm: 55, perVisit: 220, annual: 440, monthly: 36.67 }],
    ["palm injection Tree-Age, 1 palm at 12 in DBH", { ...BASE, services: { palmInjection: { treatmentType: "treeAge", palmCount: 1, dbhInches: 12 } } }, "palm_injection", { pricePerPalm: 85, perVisit: 85, annual: 42.5, monthly: 3.54 }],
    ["German roach moderate", { ...BASE, services: { germanRoach: { severity: "moderate" } } }, "german_roach", { price: 450, priceAfterDiscount: 450 }],
    ["German roach severe", { ...BASE, services: { germanRoach: { severity: "severe" } } }, "german_roach", { price: 550, priceAfterDiscount: 550 }],
    ["WDO inspection 2,000 sf", { ...BASE, services: { wdo: {} } }, "wdo_inspection", { price: 250, priceAfterDiscount: 250 }],
  ];
  test.each(FROZEN)("%s prices exactly as frozen", (_name, input, service, expected) => {
    const li = line(generateEstimate(input), service);
    expect(li).toBeDefined();
    for (const [k, v] of Object.entries(expected)) expect(li[k]).toBe(v);
  });
});

describe('pricing audit — FROZEN WaveGuard tier discounts (in-code constants, reviewed 2026-09-03)', () => {
  // Literal POST-discount amounts per line. Every FROZEN case above is a solo
  // Bronze quote asserting list price, and the bundle tests derive their
  // expectation from the live constants, so a reviewed percentage edit (e.g.
  // Silver 10% → 15%) passed both — it fails here (codex r9 P2).
  const S = { pest: { frequency: 'quarterly' }, lawn: { track: 'st_augustine', tier: 'enhanced' }, mosquito: { tier: 'seasonal9' }, treeShrub: { tier: 'standard', treeCount: 6 } };
  const FROZEN_TIERS = [
    ['silver: pest + lawn', ['pest', 'lawn'], 'silver', 0.1, { pest_control: [403.2, 33.6], lawn_care: [518.4, 43.2] }],
    ['gold: pest + lawn + mosquito', ['pest', 'lawn', 'mosquito'], 'gold', 0.15, { pest_control: [380.8, 31.73], lawn_care: [489.6, 40.8], mosquito: [589.05, 49.09] }],
    ['platinum: pest + lawn + mosquito + tree & shrub', ['pest', 'lawn', 'mosquito', 'treeShrub'], 'platinum', 0.2, { pest_control: [358.4, 29.87], lawn_care: [460.8, 38.4], mosquito: [554.4, 46.2], tree_shrub: [509.6, 42.47] }],
  ];
  test.each(FROZEN_TIERS)('%s prices exactly as frozen', (_name, keys, tier, pct, perLine) => {
    const res = generateEstimate({ ...BASE, bedArea: 2000, services: Object.fromEntries(keys.map((k) => [k, S[k]])) });
    expect(res.waveGuard.tier).toBe(tier);
    for (const [service, [annualAfterDiscount, monthlyAfterDiscount]] of Object.entries(perLine)) {
      const li = line(res, service);
      expect(li.discount.effectiveDiscount).toBe(pct);
      expect(li.annualAfterDiscount).toBe(annualAfterDiscount);
      expect(li.monthlyAfterDiscount).toBe(monthlyAfterDiscount);
    }
  });
});
