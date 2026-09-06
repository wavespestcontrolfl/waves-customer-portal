const { generateEstimate } = require('../services/pricing-engine');
const {
  normalizeCommercialString,
  normalizePropertyType,
  isCommercialProperty,
  buildCommercialManualQuoteResult,
} = require('../services/pricing-engine/commercial-helpers');
const {
  translateV2CallToV1Input,
  needsTurfManualConfirmation,
  buildEnrichedProfile,
} = require('../routes/property-lookup-v2');
const publicQuoteRouter = require('../routes/public-quote');
const { mapV1ToLegacyShape } = require('../services/pricing-engine/v1-legacy-mapper');

function baseInput(overrides = {}) {
  return {
    homeSqFt: 2000,
    stories: 1,
    lotSqFt: 10000,
    propertyType: 'single_family',
    features: { shrubs: 'moderate', trees: 'moderate', complexity: 'standard' },
    services: {
      pest: { frequency: 'quarterly' },
      lawn: { track: 'st_augustine', tier: 'enhanced' },
    },
    paymentMethod: 'card',
    ...overrides,
  };
}

describe('commercial helper PR1 safety behavior', () => {
  test('normalizes commercial and residential property type strings', () => {
    expect(normalizeCommercialString(' Commercial-Property ')).toBe('commercial_property');
    expect(normalizePropertyType('Commercial Property')).toBe('commercial');
    expect(normalizePropertyType('Commercial Office')).toBe('commercial');
    expect(normalizePropertyType('Commercial Retail')).toBe('commercial');
    expect(normalizePropertyType('Commercial/Industrial')).toBe('commercial');
    expect(normalizePropertyType('Office/Retail')).toBe('commercial');
    expect(normalizePropertyType('Warehouse/Office')).toBe('commercial');
    expect(normalizePropertyType('Warehouse')).toBe('commercial');
    expect(normalizePropertyType('warehouse-light')).toBe('commercial');
    expect(normalizePropertyType('Restaurant')).toBe('commercial');
    expect(normalizePropertyType('Food Service')).toBe('commercial');
    expect(normalizePropertyType('School')).toBe('commercial');
    expect(normalizePropertyType('Daycare')).toBe('commercial');
    expect(normalizePropertyType('Government Municipal')).toBe('commercial');
    expect(normalizePropertyType('Medical Office')).toBe('commercial');
    expect(normalizePropertyType('Clinic')).toBe('commercial');
    expect(normalizePropertyType('HOA Common Area')).toBe('commercial');
    expect(normalizePropertyType('Residential HOA Common Area')).toBe('commercial');
    expect(normalizePropertyType('Commercial HOA / Business Park Common Area')).toBe('commercial');
    expect(normalizePropertyType('Apartment')).toBe('commercial');
    expect(normalizePropertyType('Apartments')).toBe('commercial');
    expect(normalizePropertyType('Multi Family')).toBe('commercial');
    expect(normalizePropertyType('Multi-family')).toBe('commercial');
    expect(normalizePropertyType('Multifamily')).toBe('commercial');
    expect(normalizePropertyType('Multi Story Home')).toBe('single_family');
    expect(normalizePropertyType('single family multi story')).toBe('single_family');
    expect(normalizePropertyType('Multi Story')).not.toBe('commercial');
    expect(normalizePropertyType('business')).toBe('commercial');
    expect(normalizePropertyType('office')).toBe('commercial');
    expect(normalizePropertyType('residential')).toBe('single_family');
    expect(normalizePropertyType('Townhome Interior')).toBe('townhome_interior');
    expect(normalizePropertyType('Townhome Interior Unit')).toBe('townhome_interior');
    expect(normalizePropertyType('Duplex Residential')).toBe('duplex');
    expect(normalizePropertyType('Residential Condo')).toBe('condo_ground');
    expect(normalizePropertyType('Condo Upper')).toBe('condo_upper');
  });

  test('detects commercial from property, options, subtype, or commercial service selection', () => {
    expect(isCommercialProperty({ propertyType: 'commercial' })).toBe(true);
    expect(isCommercialProperty({ category: 'COMMERCIAL' })).toBe(true);
    expect(isCommercialProperty({}, { isCommercial: true })).toBe(true);
    expect(isCommercialProperty({ commercialSubtype: 'office_retail' })).toBe(true);
    expect(isCommercialProperty({}, { services: { commercialPest: { selected: true } } })).toBe(true);
    expect(isCommercialProperty({}, { services: { commercialLawn: { selected: true } } })).toBe(true);
    expect(isCommercialProperty({
      propertyType: 'Single Family',
      category: 'COMMERCIAL',
      isCommercial: false,
    })).toBe(false);
    expect(isCommercialProperty({
      propertyType: 'Single Family',
      category: 'COMMERCIAL',
    })).toBe(false);
    expect(isCommercialProperty({ propertyType: 'single_family' })).toBe(false);
  });

  test('explicit residential request wins over stale commercial subtype', () => {
    for (const isCommercial of [false, 'NO']) {
      expect(isCommercialProperty({
        propertyType: 'Single Family',
        isCommercial,
        commercialSubtype: 'office_retail',
      })).toBe(false);
      expect(isCommercialProperty({
        isCommercial,
        commercialSubtype: 'office_retail',
      })).toBe(false);
    }
  });

  test('public quote detection lets enriched commercial category beat wizard default property type', () => {
    const { isPublicCommercialQuote } = publicQuoteRouter._internals;

    expect(isPublicCommercialQuote(
      { propertyType: 'Single Family' },
      { category: 'COMMERCIAL' }
    )).toBe(true);
    expect(isPublicCommercialQuote(
      { propertyType: 'Single Family' },
      { propertyType: 'Single Family', category: 'COMMERCIAL' }
    )).toBe(false);
    expect(isPublicCommercialQuote(
      { isCommercial: false, commercialSubtype: 'office_retail' },
      {}
    )).toBe(false);
  });

  test('property lookup enriched profile carries commercial signals for public quote gating', () => {
    const fromPropertyRecord = buildEnrichedProfile(
      {
        formattedAddress: '100 Main St',
        propertyType: 'Commercial',
        squareFootage: 5000,
        lotSize: 20000,
        stories: 1,
      },
      null,
      null,
      null
    );
    const fromSatelliteUse = buildEnrichedProfile(
      {
        formattedAddress: '200 Main St',
        propertyType: null,
        squareFootage: 0,
        lotSize: 30000,
        stories: 1,
      },
      {
        propertyUse: 'COMMERCIAL',
        commercialUseType: 'OFFICE_RETAIL',
      },
      null,
      null
    );

    expect(fromPropertyRecord).toMatchObject({
      category: 'COMMERCIAL',
      propertyType: 'Commercial',
      isCommercial: true,
    });
    expect(fromSatelliteUse).toMatchObject({
      category: 'COMMERCIAL',
      propertyType: 'Commercial',
      isCommercial: true,
      commercialSubtype: 'office_retail',
    });
    expect(publicQuoteRouter._internals.isPublicCommercialQuote(
      { propertyType: 'Single Family' },
      fromSatelliteUse
    )).toBe(true);
  });

  test('property lookup treats structured OTHER commercial use as commercial', () => {
    const profile = buildEnrichedProfile(
      {
        formattedAddress: '250 Plaza Dr',
        propertyType: null,
        squareFootage: 0,
        lotSize: 24000,
        stories: 1,
      },
      {
        propertyUse: 'UNKNOWN',
        commercialUseType: 'OTHER',
      },
      null,
      null
    );

    expect(profile).toMatchObject({
      category: 'COMMERCIAL',
      propertyType: 'Commercial',
      isCommercial: true,
    });
  });

  test('property lookup preserves specific commercial subtype labels from AI record text', () => {
    const profile = buildEnrichedProfile(
      {
        formattedAddress: '88 Bistro Row',
        propertyType: 'Restaurant',
        squareFootage: 3000,
        lotSize: 12000,
        stories: 1,
      },
      null,
      null,
      null
    );

    expect(profile).toMatchObject({
      category: 'COMMERCIAL',
      propertyType: 'Commercial',
      isCommercial: true,
      commercialSubtype: 'restaurant_food_service',
    });
  });

  test('property lookup ignores negative commercial wording in free-form AI notes', () => {
    const residentialProfile = buildEnrichedProfile(
      {
        formattedAddress: '300 Main St',
        propertyType: 'Single Family',
        squareFootage: 2000,
        lotSize: 10000,
        stories: 1,
      },
      {
        propertyUse: 'RESIDENTIAL',
        commercialUseType: 'NONE',
        analysisNotes: 'No commercial use visible; single-family home.',
      },
      null,
      null
    );

    expect(residentialProfile).toMatchObject({
      category: 'RESIDENTIAL',
      propertyType: 'Single Family',
      isCommercial: false,
      commercialSubtype: null,
      commercialDetectionSource: null,
    });
  });

  test('builds expected pest and lawn manual quote metadata', () => {
    expect(buildCommercialManualQuoteResult('pest_control')).toMatchObject({
      service: 'commercial_pest',
      originalRequestedService: 'pest_control',
      propertyType: 'commercial',
      isCommercial: true,
      commercialPricingMode: 'manual_quote',
      quoteRequired: true,
      requiresManualReview: true,
      autoQuoteRequiresAdminApproval: true,
      manualReviewReasons: ['commercial_property_manual_quote_required'],
      price: null,
      monthly: null,
      annual: null,
      taxable: true,
      taxCategory: 'nonresidential_pest_control',
      pricingConfidence: 'LOW',
    });
    expect(buildCommercialManualQuoteResult('lawn_care')).toMatchObject({
      service: 'commercial_lawn',
      originalRequestedService: 'lawn_care',
      taxable: false,
      taxCategory: 'lawn_spraying_or_treatment',
    });
  });
});

describe('commercial safety gate in generateEstimate', () => {
  test('residential golden master pins floors-disarmed pricing for pest and lawn (owner 2026-07-17)', () => {
    const estimate = generateEstimate(baseInput());
    const pest = estimate.lineItems.find((line) => line.service === 'pest_control');
    const lawn = estimate.lineItems.find((line) => line.service === 'lawn_care');

    expect(pest).toMatchObject({ monthly: 37.33, annual: 448, perApp: 112 });
    // Lawn prices off the market bracket ($588/yr here — the 2026-08-04
    // 500-sqft re-grid floors the old half-round interpolation at this
    // size) with the 35% cost floor disarmed (owner 2026-07-17 "forget all
    // pricing floors"; the floor basis would have lifted this quote).
    expect(lawn).toMatchObject({
      monthly: 49,
      annual: 588,
      perApp: 65.33,
      costFloorApplied: false,
      programMinimumApplied: false,
    });
    // Silver 10% applies IN FULL on both lines — no post-discount caps since
    // the 2026-07-17 owner ruling (the $600/yr lawn program minimum and the
    // pest per-visit program floor are both disarmed).
    expect(pest).toMatchObject({
      annualAfterDiscount: 403.2,
      discountCapped: false,
      marginGuardApplied: false,
      programFloorApplied: false,
    });
    expect(lawn).toMatchObject({ annualAfterDiscount: 529.2, monthlyAfterDiscount: 44.1 });
    expect(estimate.summary).toMatchObject({
      recurringAnnualBeforeDiscount: 1036,
      // Silver 10% applies in full: pest 448 → 403.20, lawn 588 → 529.20;
      // 403.20 + 529.20 = 932.40 (pest base 112 owner 2026-08-03; lawn
      // 500-sqft re-grid owner 2026-08-04). (Re-armed — useLawnCostFloor —
      // the margin guard binds at the reserve-folded floor and the monthly
      // CEILs; pinned in lawn-pricing-followup.test.js.)
      recurringAnnualAfterDiscount: 932.4,
      recurringMonthlyAfterDiscount: 77.7,
      year1Total: 932.4,
      year2Annual: 932.4,
      year2Monthly: 77.7,
    });
    expect(estimate.waveGuard).toMatchObject({
      tier: 'silver',
      qualifyingCount: 2,
      activeServices: ['pest_control', 'lawn_care'],
    });
  });

  test('commercial property auto-prices BOTH pest and lawn (owner directive: ALL commercial auto)', () => {
    const estimate = generateEstimate(baseInput({ propertyType: 'commercial' }));

    expect(estimate.lineItems.map((line) => line.service)).toEqual([
      'commercial_pest',
      'commercial_lawn',
    ]);
    expect(estimate.lineItems).not.toContainEqual(expect.objectContaining({ service: 'pest_control' }));
    expect(estimate.lineItems).not.toContainEqual(expect.objectContaining({ service: 'lawn_care' }));
    // Commercial pest now auto-prices too, shown instantly. FL-taxed.
    expect(estimate.lineItems[0]).toMatchObject({
      service: 'commercial_pest',
      quoteRequired: false,
      requiresManualReview: false,
      commercialPricingMode: 'auto_estimate',
      estimatedPricing: true,
      taxable: true,
      taxCategory: 'nonresidential_pest_control',
    });
    expect(estimate.lineItems[0].annual).toBeGreaterThan(0);
    expect(estimate.lineItems[0].monthly).toBeGreaterThan(0);
    // Commercial lawn auto-prices, shown to the lead instantly.
    expect(estimate.lineItems[1]).toMatchObject({
      service: 'commercial_lawn',
      quoteRequired: false,
      requiresManualReview: false,
      commercialPricingMode: 'auto_estimate',
      estimatedPricing: true,
      taxable: false,
      taxCategory: 'lawn_spraying_or_treatment',
    });
    expect(estimate.lineItems[1].annual).toBeGreaterThan(0);
    expect(estimate.lineItems[1].monthly).toBeGreaterThan(0);
    // Both priced commercial lines roll into the recurring total.
    expect(estimate.summary.recurringAnnualAfterDiscount).toBeCloseTo(
      estimate.lineItems[0].annual + estimate.lineItems[1].annual, 1);
    // Commercial lines are not WaveGuard-qualifying (no tier discount), but they
    // are active services.
    expect(estimate.waveGuard.activeServices).toEqual(['commercial_pest', 'commercial_lawn']);
  });

  test('commercial auto-priced pest does not unlock residential pest add-on inclusions', () => {
    const estimate = generateEstimate(baseInput({
      propertyType: 'commercial',
      services: {
        pest: { frequency: 'quarterly' },
        stinging: { species: 'PAPER_WASP', tier: 1, removal: 'NONE' },
      },
    }));
    const stinging = estimate.lineItems.find((line) => line.service === 'stinging_insect');

    // Commercial pest auto-prices via the commercial cost-buildup pricer — it
    // does NOT pull in residential pest add-ons (roach knockdown, stinging).
    expect(estimate.lineItems).toContainEqual(expect.objectContaining({
      service: 'commercial_pest', quoteRequired: false,
    }));
    expect(estimate.waveGuard.activeServices).toEqual(['commercial_pest']);
    expect(stinging).toBeUndefined();
  });

  test('commercial property plus one-time pest and lawn returns manual quote lines instead of residential pricing', () => {
    const estimate = generateEstimate(baseInput({
      propertyType: 'commercial',
      services: {
        oneTimePest: {},
        oneTimeLawn: { treatmentType: 'weed' },
      },
    }));
    const services = estimate.lineItems.map((line) => line.service);

    expect(services).toEqual(['commercial_pest', 'commercial_lawn']);
    expect(services).not.toContain('one_time_pest');
    expect(services).not.toContain('one_time_lawn');
    expect(estimate.lineItems[0]).toMatchObject({
      quoteRequired: true,
      taxCategory: 'nonresidential_pest_control',
    });
    expect(estimate.lineItems[1]).toMatchObject({
      quoteRequired: true,
      taxCategory: 'lawn_spraying_or_treatment',
    });
  });

  test('isCommercial flag and commercialSubtype also trigger the manual quote gate', () => {
    const byFlag = generateEstimate(baseInput({ isCommercial: true }));
    const byStringFlag = generateEstimate(baseInput({ isCommercial: 'YES' }));
    const bySubtype = generateEstimate(baseInput({ commercialSubtype: 'office_retail' }));

    expect(byFlag.lineItems.map((line) => line.service)).toEqual(['commercial_pest', 'commercial_lawn']);
    expect(byStringFlag.lineItems.map((line) => line.service)).toEqual(['commercial_pest', 'commercial_lawn']);
    expect(bySubtype.lineItems.map((line) => line.service)).toEqual(['commercial_pest', 'commercial_lawn']);
    expect(bySubtype.lineItems[0].commercialSubtype).toBe('office_retail');
  });

  test('commercial labels and category values trigger the manual quote gate', () => {
    for (const overrides of [
      { propertyType: 'Commercial Office' },
      { propertyType: 'Commercial Retail' },
      { propertyType: 'Office/Retail' },
      { propertyType: 'Warehouse' },
      { propertyType: 'Warehouse/Office' },
      { propertyType: 'Restaurant' },
      { propertyType: 'Food Service' },
      { propertyType: 'School' },
      { propertyType: 'Daycare' },
      { propertyType: 'Government Municipal' },
      { propertyType: 'Medical Office' },
      { propertyType: 'Clinic' },
      { propertyType: 'HOA Common Area' },
      { propertyType: 'Residential HOA Common Area' },
      { propertyType: 'Commercial HOA / Business Park Common Area' },
      { propertyType: 'Apartment' },
      { propertyType: 'Multi Family' },
      { propertyType: 'Multi-family' },
      { propertyType: 'Multifamily' },
      { propertyType: undefined, category: 'COMMERCIAL' },
    ]) {
      const estimate = generateEstimate(baseInput(overrides));

      expect(estimate.lineItems.map((line) => line.service)).toEqual([
        'commercial_pest',
        'commercial_lawn',
      ]);
    }
  });

  test('unset commercial flags do not override commercial category detection', () => {
    for (const isCommercial of [null, '']) {
      const estimate = generateEstimate(baseInput({
        propertyType: undefined,
        category: 'COMMERCIAL',
        isCommercial,
      }));

      expect(estimate.lineItems.map((line) => line.service)).toEqual([
        'commercial_pest',
        'commercial_lawn',
      ]);
    }
  });

  test('concrete residential property type wins over stale commercial category', () => {
    const estimate = generateEstimate(baseInput({
      propertyType: 'single_family',
      category: 'COMMERCIAL',
    }));

    expect(estimate.lineItems.map((line) => line.service)).toEqual([
      'pest_control',
      'lawn_care',
    ]);
  });

  test('explicit residential request still prices normally with stale commercial subtype', () => {
    for (const isCommercial of [false, 'NO']) {
      const estimate = generateEstimate(baseInput({
        propertyType: undefined,
        isCommercial,
        commercialSubtype: 'office_retail',
      }));
      const services = estimate.lineItems.map((line) => line.service);

      expect(services).toEqual(expect.arrayContaining(['pest_control', 'lawn_care']));
      expect(services).not.toContain('commercial_pest');
      expect(services).not.toContain('commercial_lawn');
    }
  });

  test('commercial out-of-scope pest specialty services return manual quote instead of residential pricing', () => {
    // NOTE: commercial mosquito / termite-bait / rodent-bait now AUTO-PRICE (own
    // lane) — these are the remaining specialty/one-time services with no
    // commercial pricer, which still collapse to a manual commercial_pest quote.
    const pestSpecialtyRequests = [
      { germanRoach: true },
      { pestInitialRoach: { roachType: 'regular' } },
      { germanRoachInitial: true },
      { flea: true },
      { fleaExterior: true },
      { stinging: true },
      { bedBug: true },
      { wdo: true },
      { exclusion: true },
      { rodentTrapping: true },
      { rodentInspection: true },
      { rodentGuarantee: true },
      { rodentPlugging: true },
      { rodentGuaranteeCombo: true },
      { sanitation: true },
      { trenching: true },
      { boraCare: true },
      { preSlab: true },
      { foam: true },
      { termiteFoam: true },
      { stingingV2: true },
      { exclusionV2: true },
      { oneTimeMosquito: true },
    ];

    for (const services of pestSpecialtyRequests) {
      const estimate = generateEstimate(baseInput({
        propertyType: 'commercial',
        services,
      }));

      expect(estimate.lineItems).toEqual([
        expect.objectContaining({
          service: 'commercial_pest',
          quoteRequired: true,
          requiresManualReview: true,
        }),
      ]);
    }
  });

  test('commercial tree & shrub auto-prices as a standalone ornamental program', () => {
    const estimate = generateEstimate(baseInput({
      propertyType: 'commercial',
      services: { treeShrub: true },
    }));

    expect(estimate.lineItems).toEqual([
      expect.objectContaining({
        service: 'commercial_tree_shrub',
        quoteRequired: false,
        requiresManualReview: false,
        commercialPricingMode: 'auto_estimate',
        taxable: false,
        taxCategory: 'lawn_spraying_or_treatment',
      }),
    ]);
    expect(estimate.lineItems[0].annual).toBeGreaterThan(0);
    expect(estimate.lineItems).not.toContainEqual(expect.objectContaining({ service: 'tree_shrub' }));
    expect(estimate.lineItems).not.toContainEqual(expect.objectContaining({ service: 'commercial_lawn' }));
  });

  test('manual commercial lawn-adjacent add-ons survive the legacy mapper as spec items', () => {
    // Commercial palm / top-dressing / etc route to a manual commercial_lawn
    // quote (annual:null). Adding commercial_lawn to RECURRING_SERVICES must NOT
    // make the mapper drop these unpriced manual lines. (Regression for Codex P1.)
    const estimate = generateEstimate(baseInput({
      propertyType: 'commercial',
      services: { palm: true },
    }));
    const mapped = mapV1ToLegacyShape(estimate);

    expect(mapped.recurring.services.some((s) => s.service === 'commercial_lawn')).toBe(false);
    expect(mapped.specItems).toContainEqual(expect.objectContaining({
      service: 'commercial_lawn',
      quoteRequired: true,
    }));
  });

  test('priced commercial lawn and a manual lawn-adjacent add-on coexist (add-on not dropped)', () => {
    // lawn auto-prices (commercial_lawn priced); palm is out of scope and routes
    // to a manual commercial_lawn quote. The two share a service key but must
    // both survive — the manual add-on must not be silently deduped away.
    // (Regression for Codex R2 P1-A.)
    const estimate = generateEstimate(baseInput({
      propertyType: 'commercial',
      services: { lawn: { track: 'st_augustine' }, palm: true },
    }));
    const lawnLines = estimate.lineItems.filter((l) => l.service === 'commercial_lawn');
    expect(lawnLines).toHaveLength(2);
    expect(lawnLines.some((l) => l.quoteRequired === false && l.annual > 0)).toBe(true);
    expect(lawnLines.some((l) => l.quoteRequired === true)).toBe(true);
  });

  test('commercial out-of-scope lawn-adjacent one-time services still return a manual quote', () => {
    // Palm / top-dressing / dethatching / plugging are one-time lawn-adjacent
    // add-ons — not in scope for the commercial auto-pricer, so they stay manual.
    const lawnRequests = [
      { palm: true },
      { topDressing: true },
      { dethatching: true },
      { plugging: true },
    ];

    for (const services of lawnRequests) {
      const estimate = generateEstimate(baseInput({
        propertyType: 'commercial',
        services,
      }));

      expect(estimate.lineItems).toEqual([
        expect.objectContaining({
          service: 'commercial_lawn',
          quoteRequired: true,
          requiresManualReview: true,
        }),
      ]);
    }
  });

  test('commercialPest + commercialLawn selected BOTH auto-price', () => {
    const estimate = generateEstimate(baseInput({
      services: {
        commercialPest: { selected: true },
        commercialLawn: { selected: true },
      },
    }));

    expect(estimate.lineItems.map((line) => line.service)).toEqual([
      'commercial_pest',
      'commercial_lawn',
    ]);
    const pest = estimate.lineItems.find((line) => line.service === 'commercial_pest');
    const lawn = estimate.lineItems.find((line) => line.service === 'commercial_lawn');
    expect(pest.quoteRequired).toBe(false);
    expect(pest.annual).toBeGreaterThan(0);
    expect(lawn.quoteRequired).toBe(false);
    expect(lawn.annual).toBeGreaterThan(0);
  });

  test('commercial lawn auto-prices regardless of any commercialPricingMode flag', () => {
    // The old small_commercial_pilot gate is retired — all commercial lawn
    // auto-prices now; pest still routes to a manual quote.
    const estimate = generateEstimate(baseInput({
      propertyType: 'commercial',
      services: {
        pest: { frequency: 'monthly' },
        lawn: { track: 'bermuda', tier: 'premium' },
      },
    }));

    expect(estimate.lineItems.map((line) => line.service)).toEqual([
      'commercial_pest',
      'commercial_lawn',
    ]);
    expect(estimate.lineItems).not.toContainEqual(expect.objectContaining({ service: 'pest_control' }));
    expect(estimate.lineItems).not.toContainEqual(expect.objectContaining({ service: 'lawn_care' }));
    const lawn = estimate.lineItems.find((line) => line.service === 'commercial_lawn');
    expect(lawn.quoteRequired).toBe(false);
    expect(lawn.annual).toBeGreaterThan(0);
  });

  test('commercial property type casing keeps commercial property profile for manual-quoted services', () => {
    const base = {
      homeSqFt: 5000,
      stories: 1,
      lotSqFt: 25000,
      isCommercial: true,
      services: { mosquito: { tier: 'monthly12' } },
    };
    const lowercase = generateEstimate({ ...base, propertyType: 'commercial' });
    const titlecase = generateEstimate({ ...base, propertyType: 'Commercial' });

    expect(titlecase.property.propertyType).toBe('commercial');
    expect(titlecase.property.hardscape).toBe(lowercase.property.hardscape);
    expect(titlecase.property.mosquitoTreatableSqFt).toBe(lowercase.property.mosquitoTreatableSqFt);
    // Commercial mosquito now auto-prices (treatable area is lot-derivable).
    expect(titlecase.lineItems).toEqual([
      expect.objectContaining({ service: 'commercial_mosquito', quoteRequired: false }),
    ]);
    expect(lowercase.lineItems).toEqual([
      expect.objectContaining({ service: 'commercial_mosquito', quoteRequired: false }),
    ]);
  });

  test('commercial flags and category apply before property profile is calculated for manual-quoted services', () => {
    for (const overrides of [
      { isCommercial: true },
      { isCommercial: 'YES' },
      { propertyType: undefined, category: 'COMMERCIAL' },
      { commercialSubtype: 'office_retail' },
    ]) {
      const estimate = generateEstimate({
        homeSqFt: 5000,
        stories: 1,
        lotSqFt: 25000,
        services: { mosquito: { tier: 'monthly12' } },
        ...overrides,
      });

      expect(estimate.property.propertyType).toBe('commercial');
      expect(estimate.property.isCommercial).toBe(true);
      expect(estimate.property.hardscape).toBe(3750);
      expect(estimate.property.mosquitoTreatableSqFt).toBe(16250);
      expect(estimate.lineItems[0]).toMatchObject({
        service: 'commercial_mosquito',
        quoteRequired: false,
      });
    }
  });

  test('concrete residential property type still prevents stale commercial category from changing profile sizing', () => {
    const estimate = generateEstimate({
      homeSqFt: 5000,
      stories: 1,
      lotSqFt: 25000,
      propertyType: 'single_family',
      category: 'COMMERCIAL',
      services: { mosquito: { tier: 'monthly12' } },
    });

    expect(estimate.property.propertyType).toBe('single_family');
    expect(estimate.property.isCommercial).toBeUndefined();
    expect(estimate.property.hardscape).toBe(1525);
    expect(estimate.property.mosquitoTreatableSqFt).toBe(18475);
  });

  test('commercial recurring pest and lawn do not invoke residential pricers', () => {
    jest.resetModules();
    const actualPricing = jest.requireActual('../services/pricing-engine/service-pricing');
    const pricePestControl = jest.fn(() => {
      throw new Error('residential pest pricer should not be called for commercial property');
    });
    const priceLawnCare = jest.fn(() => {
      throw new Error('residential lawn pricer should not be called for commercial property');
    });
    jest.doMock('../services/pricing-engine/service-pricing', () => ({
      ...actualPricing,
      pricePestControl,
      priceLawnCare,
    }));

    const { generateEstimate: isolatedGenerateEstimate } = require('../services/pricing-engine/estimate-engine');
    const estimate = isolatedGenerateEstimate(baseInput({ propertyType: 'commercial' }));

    expect(estimate.lineItems.map((line) => line.service)).toEqual([
      'commercial_pest',
      'commercial_lawn',
    ]);
    expect(pricePestControl).not.toHaveBeenCalled();
    expect(priceLawnCare).not.toHaveBeenCalled();

    jest.dontMock('../services/pricing-engine/service-pricing');
    jest.resetModules();
  });
});

describe('commercial safety metadata survives the admin v2 adapter', () => {
  test('commercial v2 payload prices BOTH lawn and pest as recurring services', () => {
    const input = translateV2CallToV1Input(
      {
        propertyType: 'Commercial',
        isCommercial: true,
        commercialSubtype: 'office_retail',
        homeSqFt: 5000,
        lotSqFt: 12000,
        stories: 1,
        pool: 'NO',
        poolCage: 'NO',
        shrubDensity: 'MODERATE',
        treeDensity: 'MODERATE',
        landscapeComplexity: 'MODERATE',
        nearWater: 'NO',
      },
      ['PEST', 'LAWN'],
      {}
    );

    expect(input).toMatchObject({
      propertyType: 'commercial',
      isCommercial: true,
      commercialSubtype: 'office_retail',
    });

    const mapped = mapV1ToLegacyShape(generateEstimate(input));

    // Commercial lawn auto-prices → surfaces as a recurring service, not a manual line.
    const recurringLawn = mapped.recurring.services.find((s) => s.service === 'commercial_lawn');
    expect(recurringLawn).toBeTruthy();
    expect(recurringLawn.name).toBe('Commercial Turf Treatment Program');
    expect(recurringLawn.mo).toBeGreaterThan(0);
    expect(mapped.specItems).not.toContainEqual(expect.objectContaining({ service: 'commercial_lawn' }));

    // Commercial pest now ALSO auto-prices → recurring service, not a spec item.
    const recurringPest = mapped.recurring.services.find((s) => s.service === 'commercial_pest');
    expect(recurringPest).toBeTruthy();
    expect(recurringPest.name).toBe('Commercial Pest Control');
    expect(recurringPest.mo).toBeGreaterThan(0);
    expect(recurringPest.taxable).toBe(true);
    expect(recurringPest.taxCategory).toBe('nonresidential_pest_control');
    expect(mapped.specItems).not.toContainEqual(expect.objectContaining({ service: 'commercial_pest' }));
    expect(mapped.oneTime.specItems).not.toContainEqual(expect.objectContaining({ service: 'commercial_pest' }));
  });

  test('v2 adapter does not treat string NO as commercial', () => {
    const input = translateV2CallToV1Input(
      {
        propertyType: 'Single Family',
        isCommercial: 'NO',
        homeSqFt: 2000,
        lotSqFt: 10000,
        stories: 1,
        pool: 'NO',
        poolCage: 'NO',
      },
      ['PEST', 'LAWN'],
      {}
    );
    const estimate = generateEstimate(input);
    const services = estimate.lineItems.map((line) => line.service);

    expect(input.isCommercial).toBe(false);
    expect(services).toEqual(expect.arrayContaining(['pest_control', 'lawn_care']));
    expect(services).not.toContain('commercial_pest');
    expect(services).not.toContain('commercial_lawn');
  });

  test('v2 adapter honors explicit residential override when lookup category is stale commercial', () => {
    for (const isCommercial of [false, 'NO']) {
      const input = translateV2CallToV1Input(
        {
          propertyType: 'Single Family',
          category: 'COMMERCIAL',
          isCommercial,
          homeSqFt: 2000,
          lotSqFt: 10000,
          stories: 1,
          pool: 'NO',
          poolCage: 'NO',
        },
        ['PEST', 'LAWN'],
        {}
      );
      const estimate = generateEstimate(input);
      const services = estimate.lineItems.map((line) => line.service);

      expect(input.propertyType).toBe('single_family');
      expect(input.isCommercial).toBe(false);
      expect(services).toEqual(expect.arrayContaining(['pest_control', 'lawn_care']));
      expect(services).not.toContain('commercial_pest');
      expect(services).not.toContain('commercial_lawn');
    }
  });

  test('v2 adapter clears stale commercial subtype when form is explicitly residential', () => {
    const input = translateV2CallToV1Input(
      {
        propertyType: 'Single Family',
        isCommercial: false,
        commercialSubtype: 'office_retail',
        homeSqFt: 2000,
        lotSqFt: 10000,
        stories: 1,
        pool: 'NO',
        poolCage: 'NO',
      },
      ['PEST', 'LAWN'],
      { commercialSubtype: 'office_retail' }
    );
    const estimate = generateEstimate(input);
    const services = estimate.lineItems.map((line) => line.service);

    expect(input.propertyType).toBe('single_family');
    expect(input.isCommercial).toBe(false);
    expect(input.commercialSubtype).toBeNull();
    expect(input.services.pest).not.toHaveProperty('commercialSubtype');
    expect(input.services.lawn).not.toHaveProperty('commercialSubtype');
    expect(services).toEqual(expect.arrayContaining(['pest_control', 'lawn_care']));
    expect(services).not.toContain('commercial_pest');
    expect(services).not.toContain('commercial_lawn');
  });

  test('v2 adapter honors explicit residential override without property type', () => {
    const input = translateV2CallToV1Input(
      {
        isCommercial: false,
        commercialSubtype: 'office_retail',
        homeSqFt: 2000,
        lotSqFt: 10000,
        stories: 1,
        pool: 'NO',
        poolCage: 'NO',
      },
      ['PEST'],
      { commercialSubtype: 'office_retail' }
    );
    const estimate = generateEstimate(input);
    const services = estimate.lineItems.map((line) => line.service);

    expect(input.propertyType).toBe('single_family');
    expect(input.isCommercial).toBe(false);
    expect(input.commercialSubtype).toBeNull();
    expect(services).toEqual(expect.arrayContaining(['pest_control']));
    expect(services).not.toContain('commercial_pest');
  });

  test('v2 adapter lets concrete residential property type win over stale commercial category', () => {
    const input = translateV2CallToV1Input(
      {
        propertyType: 'Single Family',
        category: 'COMMERCIAL',
        homeSqFt: 2000,
        lotSqFt: 10000,
        stories: 1,
        pool: 'NO',
        poolCage: 'NO',
      },
      ['PEST', 'LAWN'],
      {}
    );
    const estimate = generateEstimate(input);
    const services = estimate.lineItems.map((line) => line.service);

    expect(input.propertyType).toBe('single_family');
    expect(input.isCommercial).toBe(false);
    expect(services).toEqual(expect.arrayContaining(['pest_control', 'lawn_care']));
    expect(services).not.toContain('commercial_pest');
    expect(services).not.toContain('commercial_lawn');
  });

  test('v2 adapter treats office and business property aliases as commercial', () => {
    for (const profile of [
      { propertyType: 'Office' },
      { propertyType: 'business' },
      { propertyType: 'Commercial Office' },
      { propertyType: 'Commercial Retail' },
      { propertyType: 'Warehouse' },
      { propertyType: 'Restaurant' },
      { propertyType: 'School' },
      { propertyType: 'HOA Common Area' },
      { propertyType: 'Government Municipal' },
      { propertyType: 'Medical Office' },
      { propertyType: 'Apartment' },
      { propertyType: 'Multi Family' },
      { propertyType: 'Multi-family' },
      { propertyType: 'Multifamily' },
    ]) {
      const input = translateV2CallToV1Input(
        {
          ...profile,
          homeSqFt: 2000,
          lotSqFt: 10000,
          stories: 1,
          pool: 'NO',
          poolCage: 'NO',
        },
        ['PEST', 'LAWN'],
        {}
      );
      const estimate = generateEstimate(input);

      expect(input.propertyType).toBe('commercial');
      expect(input.isCommercial).toBe(true);
      expect(estimate.lineItems.map((line) => line.service)).toEqual(['commercial_pest', 'commercial_lawn']);
    }
  });

  test('legacy mapper zeroes recurring totals for an all-manual commercial estimate', () => {
    // A specialty service (flea) has no commercial pricer — it collapses to a
    // manual commercial_pest quote. With no priced recurring line, the recurring
    // totals are suppressed and the estimate is quote-required.
    const mapped = mapV1ToLegacyShape(generateEstimate(baseInput({
      propertyType: 'commercial',
      services: { flea: true },
    })));

    expect(mapped.recurring.services).toEqual([]);
    expect(mapped.quoteRequired).toBe(true);
    expect(mapped.quoteRequiredItems).toContainEqual(expect.objectContaining({
      service: 'commercial_pest',
      quoteRequired: true,
    }));
    expect(mapped.recurring.grandTotal).toBe(0);
    expect(mapped.recurring.monthlyTotal).toBe(0);
    expect(mapped.totals.year2mo).toBe(0);
  });

  test('legacy mapper preserves priced recurring totals when a manual line coexists', () => {
    // Mixed: commercial lawn (auto-priced) + a specialty (flea, no pricer →
    // manual commercial_pest quote). The priced lawn total must survive — only
    // the manual flea row is quote-required. (Regression for Codex R5 — mixed
    // quotes were zeroing priced totals.)
    const estimate = generateEstimate(baseInput({
      propertyType: 'commercial',
      turfSf: 20000,
      services: { lawn: { track: 'st_augustine' }, flea: true },
    }));
    const mapped = mapV1ToLegacyShape(estimate);

    expect(mapped.recurring.services.some((s) => s.service === 'commercial_lawn')).toBe(true);
    expect(mapped.recurring.monthlyTotal).toBeGreaterThan(0);
    expect(mapped.totals.year2mo).toBeGreaterThan(0);
    // The manual mosquito quote surfaces as a quote-required commercial_pest spec.
    expect(mapped.quoteRequired).toBe(true);
    expect(mapped.specItems).toContainEqual(expect.objectContaining({
      service: 'commercial_pest',
      quoteRequired: true,
    }));
  });

  test('v2 adapter preserves compound residential property labels', () => {
    for (const [propertyType, expected] of [
      ['Residential Condo', 'condo_ground'],
      ['Townhome Interior Unit', 'townhome_interior'],
      ['Duplex Residential', 'duplex'],
    ]) {
      const input = translateV2CallToV1Input(
        {
          propertyType,
          homeSqFt: 2000,
          lotSqFt: 10000,
          stories: 1,
          pool: 'NO',
          poolCage: 'NO',
        },
        ['PEST', 'LAWN'],
        {}
      );

      expect(input.propertyType).toBe(expected);
      expect(input.isCommercial).toBe(false);
    }
  });

  test('v2 turf confirmation precheck lets commercial lawn reach the manual quote gate', () => {
    const commercialConfirmation = needsTurfManualConfirmation(
      {
        propertyType: 'Commercial',
        isCommercial: true,
        estimatedTurfSf: 25000,
        lotSqFt: 50000,
      },
      ['LAWN'],
      {}
    );
    const commercialOneTimeConfirmation = needsTurfManualConfirmation(
      {
        propertyType: 'Commercial',
        estimatedTurfSf: 25000,
        lotSqFt: 50000,
      },
      ['OT_LAWN'],
      {}
    );
    const residentialConfirmation = needsTurfManualConfirmation(
      {
        propertyType: 'Single Family',
        estimatedTurfSf: 25000,
        lotSqFt: 50000,
      },
      ['LAWN'],
      {}
    );

    expect(commercialConfirmation).toBeNull();
    expect(commercialOneTimeConfirmation).toBeNull();
    expect(residentialConfirmation).toMatchObject({
      field: 'measuredTurfSf',
      estimatedTurfSf: 25000,
    });
  });

  test('v2 turf confirmation precheck ignores commercial lawn-adjacent manual quote services', () => {
    const commercialPluggingConfirmation = needsTurfManualConfirmation(
      {
        propertyType: 'Commercial',
        estimatedTurfSf: 25000,
        lotSqFt: 50000,
      },
      ['LAWN', 'PLUGGING'],
      {}
    );
    const commercialTopdressConfirmation = needsTurfManualConfirmation(
      {
        propertyType: 'Commercial',
        estimatedTurfSf: 25000,
        lotSqFt: 50000,
      },
      ['LAWN', 'TOPDRESS'],
      {}
    );
    const commercialDethatchConfirmation = needsTurfManualConfirmation(
      {
        propertyType: 'Commercial',
        estimatedTurfSf: 25000,
        lotSqFt: 50000,
      },
      ['DETHATCH'],
      {}
    );

    expect(commercialPluggingConfirmation).toBeNull();
    expect(commercialTopdressConfirmation).toBeNull();
    expect(commercialDethatchConfirmation).toBeNull();
  });
});

describe('GATE_COMMERCIAL_ONETIME_SCOPED — scoped one-time commercial auto-pricing', () => {
  const GATE = 'GATE_COMMERCIAL_ONETIME_SCOPED';
  const priorGate = process.env[GATE];
  afterEach(() => {
    if (priorGate === undefined) delete process.env[GATE];
    else process.env[GATE] = priorGate;
  });

  const scopedRequests = [
    { services: { preSlab: true }, input: { slabSqFt: 1500 }, service: 'pre_slab_termiticide' },
    { services: { trenching: { perimeterLF: 200 } }, service: 'trenching' },
    { services: { boraCare: { surfaceLinearFt: 120, surfaceHeightFt: 8 } }, service: 'bora_care' },
    // Live V2 exclusion shape (property-lookup-v2 sends services.exclusion
    // with pricingVersion:'v2') — emits per-section 'rodent_exclusion' rows.
    { services: { exclusion: { pricingVersion: 'v2', standardWireMeshPoints: 4 } }, service: 'rodent_exclusion' },
    { services: { bedBug: { method: 'CHEMICAL', rooms: 3, severity: 'light', prepStatus: 'ready', occupancyType: 'hotel' } }, service: 'bed_bug' },
    { services: { stinging: { species: 'PAPER_WASP' } }, service: 'stinging_insect' },
    { services: { stingingV2: { nestType: 'wasp', nestCount: 2 } }, service: 'stinging_insect_v2' },
    { services: { rodentWireMesh: { meshLinearFeet: 20 } }, service: 'rodent_wire_mesh' },
    { services: { rodentBirdBoxes: { birdBoxType: 'standard_bird_box', birdBoxQuantity: 2 } }, service: 'rodent_bird_box' },
    { services: { sanitation: { tier: 'standard', affectedSqFt: 400 } }, service: 'rodent_sanitation' },
    { services: { rodentInspection: true }, service: 'rodent_inspection' },
    { services: { foam: { points: 6 } }, service: 'foam_drill' },
    { services: { termiteFoam: { applicationPoints: 6 } }, service: 'termite_foam' },
  ];

  test('gate OFF: every scoped one-time still collapses to the commercial manual quote', () => {
    delete process.env[GATE];
    for (const req of scopedRequests) {
      const estimate = generateEstimate(baseInput({
        propertyType: 'commercial',
        services: req.services,
        ...(req.input || {}),
      }));
      const manualFamily = req.service === 'palm_injection' ? 'commercial_lawn' : 'commercial_pest';
      expect(estimate.lineItems).toEqual([
        expect.objectContaining({
          service: manualFamily,
          quoteRequired: true,
          requiresManualReview: true,
        }),
      ]);
    }
  });

  test('gate ON: scoped one-times price with commercial marking instead of a manual quote', () => {
    process.env[GATE] = 'true';
    for (const req of scopedRequests) {
      const estimate = generateEstimate(baseInput({
        propertyType: 'commercial',
        services: req.services,
        ...(req.input || {}),
      }));
      const line = estimate.lineItems.find((l) => l.service === req.service);
      expect(line).toBeDefined();
      expect(line.quoteRequired).not.toBe(true);
      expect(line.isCommercial).toBe(true);
      expect(line.propertyType).toBe('commercial');
      expect(line.commercialPricingMode).toBe('auto_estimate');
      expect(line.discountable).toBe(false);
      expect(line.excludeFromPctDiscount).toBe(true);
      const amount = line.price ?? line.total ?? line.annual;
      expect(Number.isFinite(amount)).toBe(true);
      expect(amount).toBeGreaterThan(0);
    }
  });

  test('gate ON: commercial price equals the residential price for the same scoped inputs', () => {
    process.env[GATE] = 'true';
    for (const req of scopedRequests) {
      const commercial = generateEstimate(baseInput({
        propertyType: 'commercial',
        services: req.services,
        ...(req.input || {}),
      })).lineItems.find((l) => l.service === req.service);
      const residential = generateEstimate(baseInput({
        services: req.services,
        ...(req.input || {}),
      })).lineItems.find((l) => l.service === req.service);
      expect(residential).toBeDefined();
      expect(commercial.price ?? commercial.total ?? commercial.annual)
        .toBe(residential.price ?? residential.total ?? residential.annual);
    }
  });

  test('gate ON: FL tax family — every scoped one-time taxed, rodent_inspection included', () => {
    process.env[GATE] = 'true';
    const taxed = generateEstimate(baseInput({
      propertyType: 'commercial',
      services: { preSlab: true },
      slabSqFt: 1500,
    })).lineItems.find((l) => l.service === 'pre_slab_termiticide');
    expect(taxed.taxable).toBe(true);
    expect(taxed.taxCategory).toBe('nonresidential_pest_control');

    const inspection = generateEstimate(baseInput({
      propertyType: 'commercial',
      services: { rodentInspection: true },
    })).lineItems.find((l) => l.service === 'rodent_inspection');
    // Canonical service_taxability exempts only wdo/termite inspections;
    // rodent_inspection falls to the commercial-taxable default in both
    // TaxCalculator and estimate-proposal-generate — the estimate must agree
    // with the invoice (codex #3594 r2 P1).
    expect(inspection.taxable).toBe(true);
    expect(inspection.taxCategory).toBe('nonresidential_pest_control');
  });

  test('gate ON: WaveGuard/recurring-customer discounts never touch commercial-marked lines', () => {
    process.env[GATE] = 'true';
    // Trenching's key is NOT in the excludedFromPercentDiscount list, so a
    // residential recurring customer earns the 15% one-time perk on it —
    // the commercial-marked line must not (codex #3594 P1: getEffectiveDiscount
    // resolves by key + customer status and cannot see line flags).
    const commercial = generateEstimate(baseInput({
      propertyType: 'commercial',
      isRecurringCustomer: true,
      services: { trenching: { perimeterLF: 200 } },
    })).lineItems.find((l) => l.service === 'trenching');
    expect(commercial.discount.effectiveDiscount).toBe(0);
    expect(commercial.discount.appliedDiscounts).toEqual([]);
    expect(commercial.priceAfterDiscount).toBe(commercial.price);

    const residential = generateEstimate(baseInput({
      isRecurringCustomer: true,
      services: { trenching: { perimeterLF: 200 } },
    })).lineItems.find((l) => l.service === 'trenching');
    expect(residential.discount.effectiveDiscount).toBeGreaterThan(0);
  });

  test('gate ON: home-size-bracket, WDO, and palm one-times STAY manual', () => {
    process.env[GATE] = 'true';
    const stillManual = [
      { oneTimePest: true },
      { germanRoach: true },
      { pestInitialRoach: { roachType: 'regular' } },
      { flea: true },
      // V1 exclusion shapes (bare flag and object WITHOUT pricingVersion v2)
      // keep the manual quote — home-sqft minimum floors.
      { exclusion: true },
      { exclusion: { simple: 2, moderate: 1 } },
      // Alternate services.exclusionV2 spelling: calculateExclusionPrice is
      // sqft-tiered off property.footprint — stays manual (codex #3594 r2 P1).
      { exclusionV2: { meshPoints: 4 } },
      // Unit-scoped services WITHOUT their unit (codex #3594 r3 P1): the admin
      // V2 adapter permits an absent mesh length / a 0 affected area — a
      // footprint-derived or "0 LF" minimum must not become a firm quote.
      { rodentWireMesh: {} },
      { rodentWireMesh: { meshLinearFeet: 0, meshSubstrate: 'stucco' } },
      { sanitation: { tier: 'standard' } },
      { sanitation: { tier: 'heavy', affectedSqFt: 0 } },
      // Bird boxes with no/zero quantity (V2 adapter emits 0 when cleared) —
      // the pricer returns null for 0, so the bypass would DROP the line
      // (codex #3594 r4 P1).
      { rodentBirdBoxes: { birdBoxType: 'standard_bird_box' } },
      { rodentBirdBoxes: { birdBoxType: 'standard_bird_box', birdBoxQuantity: 0 } },
      // Bed bug without explicit commercial scope: single-family occupancy
      // (the public-quote default → 1.00× instead of hotel 1.30×) or no rooms
      // (codex #3594 r4 P1).
      { bedBug: { method: 'CHEMICAL', rooms: 3, severity: 'light', prepStatus: 'ready', occupancyType: 'singleFamily' } },
      { bedBug: { method: 'CHEMICAL', rooms: 0, severity: 'light', prepStatus: 'ready', occupancyType: 'hotel' } },
      // Foam defaults to 5 points when absent; termite foam bills ≥1 can at 0
      // points; an all-zero exclusion V2 still prices floor + inspection —
      // each needs a positive explicit unit to bypass.
      { foam: {} },
      { foam: { points: 0 } },
      { termiteFoam: {} },
      { termiteFoam: { applicationPoints: 0 } },
      { exclusion: { pricingVersion: 'v2' } },
      { exclusion: { pricingVersion: 'v2', standardWireMeshPoints: 0, meshSoftLF: 0 } },
      // stingingV2 defaults nestCount to 1 and scales by it (codex #3594 r5 P1).
      { stingingV2: { nestType: 'wasp' } },
      { stingingV2: { nestType: 'hornet', nestCount: 0 } },
      { rodentTrapping: true },
      { rodentGuarantee: true },
      { oneTimeMosquito: true },
      // WDO: footprint-bracketed + synthetic-footprint hazard (codex #3594 P1).
      { wdo: true },
      // Palm: legacy mapper drops commercial identity → residential recurring
      // seeding hazard (codex #3594 P1).
      { palmInjection: { palmCount: 4, treatmentType: 'nutrition' } },
      { dethatching: true },
      { topDressing: true },
      { plugging: true },
    ];
    for (const services of stillManual) {
      const estimate = generateEstimate(baseInput({
        propertyType: 'commercial',
        services,
      }));
      const family = ('dethatching' in services || 'topDressing' in services
        || 'plugging' in services || 'palmInjection' in services)
        ? 'commercial_lawn' : 'commercial_pest';
      expect(estimate.lineItems).toEqual([
        expect.objectContaining({
          service: family,
          quoteRequired: true,
          requiresManualReview: true,
        }),
      ]);
    }
  });

  test('gate ON: commercial bed bug stays manual when the building size is the public synthetic default', () => {
    process.env[GATE] = 'true';
    const unmeasured = generateEstimate(baseInput({
      propertyType: 'commercial',
      buildingSizeMeasured: false,
      services: { bedBug: { method: 'CHEMICAL', rooms: 3, severity: 'light', prepStatus: 'ready', occupancyType: 'hotel' } },
    }));
    expect(unmeasured.lineItems).toEqual([
      expect.objectContaining({ service: 'commercial_pest', quoteRequired: true, requiresManualReview: true }),
    ]);
    const measured = generateEstimate(baseInput({
      propertyType: 'commercial',
      buildingSizeMeasured: true,
      services: { bedBug: { method: 'CHEMICAL', rooms: 3, severity: 'light', prepStatus: 'ready', occupancyType: 'hotel' } },
    }));
    expect(measured.lineItems.find((l) => l.service === 'bed_bug')).toMatchObject({ isCommercial: true, commercialPricingMode: 'auto_estimate' });
  });

  test('gate ON: residential estimates are untouched (no commercial marking)', () => {
    process.env[GATE] = 'true';
    const estimate = generateEstimate(baseInput({
      services: { preSlab: true },
      slabSqFt: 1500,
    }));
    const line = estimate.lineItems.find((l) => l.service === 'pre_slab_termiticide');
    expect(line).toBeDefined();
    expect(line.isCommercial).not.toBe(true);
    expect(line.propertyType).not.toBe('commercial');
  });
});

describe('estimateHasCommercialOneTime — commercial stamp signal for one-time-only accepts', () => {
  const { estimateHasCommercialOneTime } = require('../services/estimate-converter');
  const GATE = 'GATE_COMMERCIAL_ONETIME_SCOPED';
  const priorGate = process.env[GATE];
  afterEach(() => {
    if (priorGate === undefined) delete process.env[GATE];
    else process.env[GATE] = priorGate;
  });

  test('true only for a PRICED commercial auto_estimate one-time row', () => {
    expect(estimateHasCommercialOneTime({
      result: { oneTime: { items: [{ service: 'pre_slab_termiticide', price: 705, isCommercial: true, commercialPricingMode: 'auto_estimate' }] } },
    })).toBe(true);
    // Manual commercial QUOTE row — nothing priced, must NOT stamp.
    expect(estimateHasCommercialOneTime({
      result: { oneTime: { specItems: [{ service: 'commercial_pest', price: null, isCommercial: true, commercialPricingMode: 'manual_quote', quoteRequired: true }] } },
    })).toBe(false);
    // Residential one-time — no commercial identity.
    expect(estimateHasCommercialOneTime({
      result: { oneTime: { items: [{ service: 'pre_slab_termiticide', price: 705 }] } },
    })).toBe(false);
    expect(estimateHasCommercialOneTime({})).toBe(false);
  });

  test('quote-wizard envelope: engineResult.lineItems one-time rows count, recurring commercial rows do not', () => {
    // POST /public/quote/calculate persists the markers ONLY under
    // engineResult.lineItems (codex #3594 r3 P1).
    const wizard = (lineItems) => ({ engineResult: { summary: {}, lineItems } });
    expect(estimateHasCommercialOneTime(wizard([{
      service: 'pre_slab_termiticide', price: 640, total: 640, annual: null, monthly: null,
      isCommercial: true, commercialPricingMode: 'auto_estimate', taxable: true,
    }]))).toBe(true);
    // Recurring commercial auto-pricers carry the SAME markers plus an annual
    // amount + estimatedPricing — they belong to the recurring stamp, not this one.
    expect(estimateHasCommercialOneTime(wizard([{
      service: 'commercial_pest', annual: 2400, monthly: 200, price: null,
      isCommercial: true, commercialPricingMode: 'auto_estimate', estimatedPricing: true,
    }]))).toBe(false);
    // A manual commercial quote row never counts.
    expect(estimateHasCommercialOneTime(wizard([{
      service: 'commercial_pest', quoteRequired: true, requiresManualReview: true,
      isCommercial: true, commercialPricingMode: 'auto_estimate',
    }]))).toBe(false);
    expect(estimateHasCommercialOneTime(wizard([]))).toBe(false);
    // A measurement-required commercial row (trenching, no perimeter) is not
    // a PRICED row — no stamp signal.
    expect(estimateHasCommercialOneTime({ result: { oneTime: { items: [{
      service: 'trenching', price: null, requiresMeasurement: true,
      isCommercial: true, commercialPricingMode: 'auto_estimate',
    }] } } })).toBe(false);
  });

  test('round trip: gate-on commercial trenching keeps its identity through the legacy mapper (ONE_TIME_SERVICES path)', () => {
    // Trenching maps via v1OtItems, not the specialty branch pre-slab uses —
    // the admin save persists ONLY the mapped result (codex #3594 r4 P1).
    process.env[GATE] = 'true';
    const mapped = mapV1ToLegacyShape(generateEstimate(baseInput({
      propertyType: 'commercial',
      services: { trenching: { perimeterLF: 200 } },
    })));
    const row = (mapped.oneTime?.items || []).find((i) => i.service === 'trenching');
    expect(row).toMatchObject({ isCommercial: true, commercialPricingMode: 'auto_estimate', taxable: true });
    expect(estimateHasCommercialOneTime({ result: mapped })).toBe(true);
    // Residential trenching carries no commercial fields at all.
    delete process.env[GATE];
    const resRow = (mapV1ToLegacyShape(generateEstimate(baseInput({
      propertyType: 'residential',
      services: { trenching: { perimeterLF: 200 } },
    }))).oneTime?.items || []).find((i) => i.service === 'trenching');
    expect(resRow).toBeDefined();
    expect(resRow.isCommercial).toBeUndefined();
  });

  test('round trip: gate-on commercial pre-slab survives the legacy mapper as a stampable signal', () => {
    process.env[GATE] = 'true';
    const engineResult = generateEstimate(baseInput({
      propertyType: 'commercial',
      services: { preSlab: true },
      slabSqFt: 1500,
    }));
    const mapped = mapV1ToLegacyShape(engineResult);
    expect(estimateHasCommercialOneTime({ result: mapped })).toBe(true);

    // Gate off: the same request maps to a manual quote — no stamp signal.
    delete process.env[GATE];
    const manualMapped = mapV1ToLegacyShape(generateEstimate(baseInput({
      propertyType: 'commercial',
      services: { preSlab: true },
      slabSqFt: 1500,
    })));
    expect(estimateHasCommercialOneTime({ result: manualMapped })).toBe(false);

    // Residential estimates never produce the signal.
    const residentialMapped = mapV1ToLegacyShape(generateEstimate(baseInput({
      services: { preSlab: true },
      slabSqFt: 1500,
    })));
    expect(estimateHasCommercialOneTime({ result: residentialMapped })).toBe(false);
  });
});

describe('codex #3594 r2 — public one-time accept stamp + display-only copy flag (source guards)', () => {
  const fs = require('fs');
  const path = require('path');
  const routeSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'estimate-public.js'), 'utf8');
  const clientSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'src', 'pages', 'EstimateViewPage.jsx'), 'utf8');

  test('the one-time accept path stamps commercial identity inside the accept transaction', () => {
    // The converter is skipped whenever treatAsOneTime — the route must carry
    // the same one-way stamp itself, keyed on estimateHasCommercialOneTime.
    expect(routeSrc).toMatch(
      /if \(customerId && treatAsOneTime\s*\n\s*&& require\('\.\.\/services\/estimate-converter'\)\.estimateHasCommercialOneTime\(estData\)\) \{\s*\n\s*await trx\('customers'\)\s*\n\s*\.where\(\{ id: customerId \}\)\s*\n\s*\.whereRaw\("coalesce\(property_type, ''\) <> 'commercial'"\)\s*\n\s*\.update\(\{ property_type: 'commercial' \}\);/
    );
    // …and it lands BEFORE the converter bypass, i.e. inside the trx.
    const stampAt = routeSrc.indexOf("estimateHasCommercialOneTime(estData)");
    const bypassAt = routeSrc.indexOf('if (customerId && !treatAsOneTime && !annualPrepaySelected) {');
    expect(stampAt).toBeGreaterThan(0);
    expect(bypassAt).toBeGreaterThan(stampAt);
  });

  test('the manual Mark Won path stamps commercial identity for one-time wins', () => {
    const manualSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'estimate-manual-acceptance.js'), 'utf8');
    expect(manualSrc).toMatch(
      /if \(updatedEstimate\.customer_id\s*\n\s*&& EstimateConverter\.estimateHasCommercialOneTime\(parseEstimateData\(updatedEstimate\.estimate_data\)\)\) \{\s*\n\s*await trx\('customers'\)\s*\n\s*\.where\(\{ id: updatedEstimate\.customer_id \}\)\s*\n\s*\.whereRaw\("coalesce\(property_type, ''\) <> 'commercial'"\)\s*\n\s*\.update\(\{ property_type: 'commercial' \}\);/
    );
    // …inside the win transaction, before the audit log.
    expect(manualSrc.indexOf('estimateHasCommercialOneTime(parseEstimateData(updatedEstimate.estimate_data))'))
      .toBeLessThan(manualSrc.indexOf('await logManualAcceptance(trx, {'));
  });

  test('scoped one-time commercial rows feed the COPY flag, never the approval-only classifier', () => {
    const { isCommercialAutoAcceptEstimate, isCommercialOneTimePricedEstimate } = require('../routes/estimate-public');
    const priced = {
      estimate_data: JSON.stringify({
        result: {
          oneTime: {
            items: [{
              service: 'pre_slab_termiticide', price: 640, isCommercial: true,
              propertyType: 'commercial', commercialPricingMode: 'auto_estimate',
            }],
          },
        },
      }),
    };
    expect(isCommercialOneTimePricedEstimate(priced)).toBe(true);
    // Approval-only lane (no slot / no deposit / manual billing) stays
    // recurring-commercial-specific.
    expect(isCommercialAutoAcceptEstimate(priced)).toBe(false);
    expect(isCommercialOneTimePricedEstimate({ estimate_data: '{}' })).toBe(false);
    expect(routeSrc).toMatch(/commercialOneTimePriced: isCommercialOneTimePricedEstimate\(estimate\),/);
  });

  test('client folds the flag into the copy-pack detector only', () => {
    expect(clientSrc).toMatch(/\|\| cta\?\.commercialOneTimePriced === true\s*\n\s*\|\| cta\?\.quoteRequiredReason === 'commercial_proposal'/);
    expect(clientSrc).toMatch(/const isCommercialEstimate = isCommercialProposal \|\| cta\?\.commercialAutoPriced === true;/);
    expect(clientSrc).not.toMatch(/isCommercialEstimate = [^\n]*commercialOneTimePriced/);
  });
});
