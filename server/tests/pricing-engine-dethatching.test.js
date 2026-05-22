const { generateEstimate, priceDethatching } = require('../services/pricing-engine');
const { translateV2CallToV1Input } = require('../routes/property-lookup-v2');

function legacyDethatchingPrice(lawnSqFt) {
  const timeMin = lawnSqFt / 100 + lawnSqFt / 200 + 30;
  const cost = 35 * (timeMin / 60) + (lawnSqFt / 1000) * 2.10;
  return Math.max(150, Math.round(cost / 0.40));
}

describe('dethatching pricing hardening', () => {
  test('keeps default no-cleanup/easy-access price compatible with the legacy formula', () => {
    const result = priceDethatching(4500, {
      cleanupLevel: 'none',
      access: 'easy',
      grassType: 'bermuda',
      thatchDepthInches: 0.75,
    });

    expect(result.price).toBe(legacyDethatchingPrice(4500));
    expect(result.cleanupLevel).toBe('none');
    expect(result.access).toBe('easy');
    expect(result.basePrice).toBe(result.price);
  });

  test('adds cleanup and access pricing metadata without losing the base service line', () => {
    const base = priceDethatching(4500, {
      cleanupLevel: 'none',
      access: 'easy',
      grassType: 'bermuda',
      thatchDepthInches: 0.75,
    });
    const adjusted = priceDethatching(4500, {
      cleanupLevel: 'moderate',
      access: 'moderate',
      debrisRemovalIncluded: true,
      grassType: 'bermuda',
      thatchProbe1Inches: 0.6,
      thatchProbe2Inches: 0.8,
      thatchProbe3Inches: 0.7,
    });

    expect(adjusted.service).toBe('dethatching');
    expect(adjusted.price).toBeGreaterThan(base.price);
    expect(adjusted.cleanupLevel).toBe('moderate');
    expect(adjusted.cleanupPriceAdder).toBeGreaterThan(0);
    expect(adjusted.access).toBe('moderate');
    expect(adjusted.accessMin).toBe(10);
    expect(adjusted.debrisRemovalIncluded).toBe(true);
    expect(adjusted.thatchDepthInches).toBe(0.7);
    expect(adjusted.quoteRequired).toBe(false);
  });

  test('debris removal checkbox maps no-cleanup requests to paid light cleanup', () => {
    const base = priceDethatching(4500, {
      cleanupLevel: 'none',
      access: 'easy',
      grassType: 'bermuda',
      thatchDepthInches: 0.75,
    });
    const withDebrisRemoval = priceDethatching(4500, {
      cleanupLevel: 'none',
      debrisRemovalIncluded: true,
      access: 'easy',
      grassType: 'bermuda',
      thatchDepthInches: 0.75,
    });

    expect(withDebrisRemoval.price).toBeGreaterThan(base.price);
    expect(withDebrisRemoval.cleanupLevel).toBe('light');
    expect(withDebrisRemoval.requestedCleanupLevel).toBe('none');
    expect(withDebrisRemoval.debrisRemovalIncluded).toBe(true);
    expect(withDebrisRemoval.warnings).not.toContain('base_price_excludes_bagging_or_debris_hauling');
  });

  test('manual-review dethatching conditions block customer-facing quote', () => {
    const difficult = priceDethatching(4500, {
      cleanupLevel: 'none',
      access: 'difficult',
      grassType: 'bermuda',
      thatchDepthInches: 0.75,
    });

    expect(difficult.manualReviewReasons).toContain('difficult_access_dethatching');
    expect(difficult.quoteRequired).toBe(true);
    expect(difficult.requiresCustomQuote).toBe(true);
    expect(difficult.price).toBeNull();
    expect(difficult.estimatedPrice).toBeGreaterThan(0);
    expect(difficult.customQuoteReason).toContain('difficult_access_dethatching');
  });

  test('requires St. Augustine manager approval and clears the blocker when approved with a reason', () => {
    const needsApproval = priceDethatching(4500, {
      grassType: 'st_augustine',
      thatchDepthInches: 0.8,
    });
    const approved = priceDethatching(4500, {
      grassType: 'st_augustine',
      thatchDepthInches: 0.8,
      managerApproved: true,
      managerApprovalReason: 'verified_thatch_probe',
    });

    expect(needsApproval.requiresManagerApproval).toBe(true);
    expect(needsApproval.managerApprovalSatisfied).toBe(false);
    expect(needsApproval.quoteRequired).toBe(true);
    expect(needsApproval.requiresCustomQuote).toBe(true);
    expect(needsApproval.price).toBeNull();
    expect(needsApproval.estimatedPrice).toBeGreaterThan(0);
    expect(needsApproval.manualReviewReasons).toContain('st_augustine_dethatching_manager_approval_required');
    expect(approved.requiresManagerApproval).toBe(true);
    expect(approved.managerApprovalSatisfied).toBe(true);
    expect(approved.quoteRequired).toBe(false);
    expect(approved.price).toBe(approved.estimatedPrice);
    expect(approved.manualReviewReasons).not.toContain('st_augustine_dethatching_manager_approval_required');
    expect(approved.managerApprovalOverrideReason).toBe('verified_thatch_probe');
  });

  test('rejects non-allowlisted manager approval reasons', () => {
    const invalidApprovalReason = priceDethatching(4500, {
      grassType: 'st_augustine',
      thatchDepthInches: 0.8,
      managerApproved: true,
      managerApprovalReason: 'anything truthy',
    });

    expect(invalidApprovalReason.managerApprovalOverrideReason).toBeNull();
    expect(invalidApprovalReason.managerApprovalSatisfied).toBe(false);
    expect(invalidApprovalReason.quoteRequired).toBe(true);
    expect(invalidApprovalReason.manualReviewReasons).toContain('st_augustine_dethatching_manager_approval_reason_missing');
  });

  test('generateEstimate propagates dethatching manual review and routing warnings', () => {
    const estimate = generateEstimate({
      homeSqFt: 2200,
      stories: 1,
      lotSqFt: 12000,
      measuredTurfSf: 6500,
      propertyType: 'single_family',
      grassType: 'st_augustine',
      services: {
        dethatching: {
          cleanupLevel: 'heavy',
          access: 'difficult',
          debrisRemovalIncluded: true,
          thatchDepthInches: 0.9,
        },
      },
    });
    const line = estimate.lineItems.find(item => item.service === 'dethatching');

    expect(line).toEqual(expect.objectContaining({
      service: 'dethatching',
      lawnSqFt: 6500,
      cleanupLevel: 'heavy',
      access: 'difficult',
      requiresManagerApproval: true,
      quoteRequired: true,
      requiresCustomQuote: true,
      price: null,
    }));
    expect(line.manualReviewReasons).toEqual(expect.arrayContaining([
      'heavy_cleanup_required',
      'difficult_access_dethatching',
      'st_augustine_dethatching_manager_approval_required',
    ]));
    expect(estimate.pricingMetadata.manualReviewReasons).toEqual(expect.arrayContaining(line.manualReviewReasons));
    expect(estimate.pricingMetadata.warnings).toContain(
      'Dethatching St. Augustine / Floratam can damage stolons. Manager approval required.'
    );
  });

  test('v2 adapter does not treat string false as manager approval', () => {
    const v1Input = translateV2CallToV1Input(
      {
        homeSqFt: 2200,
        stories: 1,
        lotSqFt: 12000,
        measuredTurfSf: 4500,
        propertyType: 'single_family',
      },
      ['DETHATCH'],
      {
        grassType: 'st_augustine',
        dethatchingManagerApproved: 'false',
        dethatchingManagerApprovalReason: 'verified_thatch_probe',
        thatchDepthInches: 0.9,
      }
    );
    const estimate = generateEstimate(v1Input);
    const line = estimate.lineItems.find(item => item.service === 'dethatching');

    expect(v1Input.services.dethatching.managerApproved).toBe('false');
    expect(line.managerApproved).toBe(false);
    expect(line.managerApprovalSatisfied).toBe(false);
    expect(line.quoteRequired).toBe(true);
    expect(line.manualReviewReasons).toContain('st_augustine_dethatching_manager_approval_required');
  });
});
