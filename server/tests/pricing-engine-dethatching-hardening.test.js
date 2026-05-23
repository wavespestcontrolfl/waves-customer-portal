const fs = require('fs');
const path = require('path');

const { generateEstimate, priceDethatching } = require('../services/pricing-engine');

describe('dethatching pricing hardening', () => {
  test('preserves base residential dethatching prices', () => {
    expect(priceDethatching(1500).estimatedPrice ?? priceDethatching(1500).price).toBe(150);
    expect(priceDethatching(3000).estimatedPrice ?? priceDethatching(3000).price).toBe(150);
    expect(priceDethatching(4500).estimatedPrice ?? priceDethatching(4500).price).toBe(166);
    expect(priceDethatching(6000).estimatedPrice ?? priceDethatching(6000).price).toBe(205);
    expect(priceDethatching(10000).estimatedPrice ?? priceDethatching(10000).price).toBe(315);
  });

  test('adds cleanup pricing and metadata in increasing order', () => {
    const base = priceDethatching(4500, {
      cleanupLevel: 'none',
      grassType: 'bermuda',
      thatchDepthInches: 0.75,
    });
    const light = priceDethatching(4500, {
      cleanupLevel: 'light',
      grassType: 'bermuda',
      thatchDepthInches: 0.75,
    });
    const moderate = priceDethatching(4500, {
      cleanupLevel: 'moderate',
      grassType: 'bermuda',
      thatchDepthInches: 0.75,
    });
    const heavy = priceDethatching(4500, {
      cleanupLevel: 'heavy',
      grassType: 'bermuda',
      thatchDepthInches: 0.75,
    });

    expect(base.price).toBe(166);
    expect(light.price).toBeGreaterThan(base.price);
    expect(moderate.price).toBeGreaterThan(light.price);
    expect(heavy.price).toBeGreaterThan(moderate.price);
    expect(heavy).toEqual(expect.objectContaining({
      cleanupLevel: 'heavy',
      debrisRemovalIncluded: true,
      cleanupMin: expect.any(Number),
      cleanupPriceAdder: expect.any(Number),
    }));
  });

  test('debris removal checkbox maps to priced light cleanup when no cleanup tier is selected', () => {
    const result = priceDethatching(4500, {
      cleanupLevel: 'none',
      debrisRemovalIncluded: true,
      grassType: 'bermuda',
      thatchDepthInches: 0.75,
    });

    expect(result.price).toBeGreaterThan(166);
    expect(result.cleanupLevel).toBe('light');
    expect(result.requestedCleanupLevel).toBe('none');
    expect(result.cleanupPriceAdder).toBeGreaterThan(0);
    expect(result.debrisRemovalIncluded).toBe(true);
    expect(result.detail).toContain('cleanup/debris removal included');
    expect(result.warnings).not.toContain('base_price_excludes_bagging_or_debris_hauling');
  });

  test('difficult access increases time and requires manual review', () => {
    const easy = priceDethatching(4500, {
      access: 'easy',
      grassType: 'bermuda',
      thatchDepthInches: 0.75,
    });
    const difficult = priceDethatching(4500, {
      access: 'difficult',
      grassType: 'bermuda',
      thatchDepthInches: 0.75,
    });

    expect(difficult.timeMin).toBeGreaterThan(easy.timeMin);
    expect(difficult.manualReviewReasons).toContain('difficult_access_dethatching');
    expect(difficult.requiresManualReview).toBe(true);
  });

  test('St. Augustine and Floratam require manager approval metadata while preserving preview price', () => {
    const result = priceDethatching(3000, {
      grassType: 'Floratam',
      thatchDepthInches: 0.8,
    });

    expect(result.price).toBeNull();
    expect(result.estimatedPrice).toBe(150);
    expect(result.requiresManagerApproval).toBe(true);
    expect(result.managerApprovalReason).toBe('st_augustine_dethatching');
    expect(result.managerApprovalSatisfied).toBe(false);
    expect(result.manualReviewReasons).toContain('st_augustine_dethatching_manager_approval_required');
    expect(result.warnings.join(' ')).toContain('St. Augustine / Floratam');
  });

  test('thatch probe recommendations differ by grass track', () => {
    const bermuda = priceDethatching(3000, {
      grassType: 'bermuda',
      thatchProbe1Inches: 0.6,
      thatchProbe2Inches: 0.7,
      thatchProbe3Inches: 0.65,
    });
    const zoysiaLow = priceDethatching(3000, {
      grassType: 'zoysia',
      thatchProbe1Inches: 0.25,
      thatchProbe2Inches: 0.3,
      thatchProbe3Inches: 0.4,
    });
    const stAugustine = priceDethatching(3000, {
      grassType: 'st_augustine',
      thatchProbe1Inches: 0.8,
      thatchProbe2Inches: 0.85,
      thatchProbe3Inches: 0.9,
    });

    expect(bermuda.dethatchingRecommended).toBe(true);
    expect(bermuda.recommendationReason).toBe('bermuda_zoysia_thatch_above_half_inch');
    expect(zoysiaLow.dethatchingRecommended).toBe(false);
    expect(zoysiaLow.manualReviewReasons).toContain('thatch_probe_threshold_not_met');
    expect(stAugustine.dethatchingRecommended).toBe(false);
    expect(stAugustine.requiresManagerApproval).toBe(true);
  });

  test('large and heavy cleanup jobs are marked for manual review', () => {
    const large = priceDethatching(10000, {
      grassType: 'bermuda',
      thatchDepthInches: 0.75,
    });
    const heavy = priceDethatching(6000, {
      cleanupLevel: 'heavy',
      grassType: 'zoysia',
      thatchDepthInches: 0.75,
    });

    expect(large.price).toBeNull();
    expect(large.estimatedPrice).toBe(315);
    expect(large.manualReviewReasons).toContain('large_lawn_dethatching_manual_review');
    expect(heavy.manualReviewReasons).toContain('heavy_cleanup_required');
  });

  test('commercial dethatching remains manual quote through estimate engine', () => {
    const estimate = generateEstimate({
      homeSqFt: 2500,
      lotSqFt: 10000,
      propertyType: 'commercial',
      services: { dethatching: true },
    });

    expect(estimate.lineItems).toEqual([
      expect.objectContaining({
        service: 'commercial_lawn',
        quoteRequired: true,
        requiresManualReview: true,
      }),
    ]);
  });

  test('tax config keeps current behavior but carries a Florida review TODO', () => {
    const migrationPath = path.join(__dirname, '../models/migrations/20260401000069_tax_intelligence.js');
    const migration = fs.readFileSync(migrationPath, 'utf8');

    expect(migration).toContain('Verify Florida tax treatment for dethatching/lawn-maintenance service');
    expect(migration).toContain("service_key: 'dethatching'");
    expect(migration).toContain("is_taxable: true");
    expect(migration).toContain("tax_category: 'lawn_maintenance'");
  });
});
