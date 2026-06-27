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
  test('residential golden master remains unchanged for pest and lawn', () => {
    const estimate = generateEstimate(baseInput());
    const pest = estimate.lineItems.find((line) => line.service === 'pest_control');
    const lawn = estimate.lineItems.find((line) => line.service === 'lawn_care');

    expect(pest).toMatchObject({ monthly: 39, annual: 468, perApp: 117 });
    expect(lawn).toMatchObject({ monthly: 51.75, annual: 621, perApp: 69 });
    expect(estimate.summary).toMatchObject({
      recurringAnnualBeforeDiscount: 1089,
      recurringAnnualAfterDiscount: 980.1,
      recurringMonthlyAfterDiscount: 81.68,
      year1Total: 980,
      year2Annual: 980,
      year2Monthly: 81.68,
    });
    expect(estimate.waveGuard).toMatchObject({
      tier: 'silver',
      qualifyingCount: 2,
      activeServices: ['pest_control', 'lawn_care'],
    });
  });

  test('commercial property plus pest and lawn returns manual quote lines instead of residential pricing', () => {
    const estimate = generateEstimate(baseInput({ propertyType: 'commercial' }));

    expect(estimate.lineItems.map((line) => line.service)).toEqual([
      'commercial_pest',
      'commercial_lawn',
    ]);
    expect(estimate.lineItems).not.toContainEqual(expect.objectContaining({ service: 'pest_control' }));
    expect(estimate.lineItems).not.toContainEqual(expect.objectContaining({ service: 'lawn_care' }));
    expect(estimate.lineItems[0]).toMatchObject({
      quoteRequired: true,
      requiresManualReview: true,
      taxable: true,
      taxCategory: 'nonresidential_pest_control',
      manualReviewReasons: expect.arrayContaining(['commercial_property_manual_quote_required']),
    });
    expect(estimate.lineItems[1]).toMatchObject({
      quoteRequired: true,
      requiresManualReview: true,
      taxable: false,
      taxCategory: 'lawn_spraying_or_treatment',
      manualReviewReasons: expect.arrayContaining(['commercial_property_manual_quote_required']),
    });
    expect(estimate.summary.recurringAnnualAfterDiscount).toBe(0);
    expect(estimate.waveGuard.activeServices).toEqual([]);
  });

  test('commercial manual pest does not unlock recurring pest add-on inclusions', () => {
    const estimate = generateEstimate(baseInput({
      propertyType: 'commercial',
      services: {
        pest: { frequency: 'quarterly' },
        stinging: { species: 'PAPER_WASP', tier: 1, removal: 'NONE' },
      },
    }));
    const stinging = estimate.lineItems.find((line) => line.service === 'stinging_insect');

    expect(estimate.lineItems).toContainEqual(expect.objectContaining({ service: 'commercial_pest' }));
    expect(estimate.waveGuard.activeServices).toEqual([]);
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
      { rodentBait: true },
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
      { mosquito: { tier: 'monthly12' } },
      { oneTimeMosquito: true },
      { termite: { system: 'advance' } },
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

  test('commercial out-of-scope lawn-adjacent services return manual quote instead of residential pricing', () => {
    const lawnRequests = [
      { treeShrub: true },
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

  test('commercialPest and commercialLawn selected payload style returns manual quote lines', () => {
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
    expect(estimate.lineItems.every((line) => line.quoteRequired)).toBe(true);
  });

  test('small-commercial pilot flag suggests a pest price but never falls through to residential pricing', () => {
    const estimate = generateEstimate(baseInput({
      propertyType: 'commercial',
      services: {
        pest: { frequency: 'monthly', commercialPricingMode: 'small_commercial_pilot' },
        lawn: { track: 'bermuda', tier: 'premium', commercialPricingMode: 'small_commercial_pilot' },
      },
    }));

    expect(estimate.lineItems.map((line) => line.service)).toEqual([
      'commercial_pest',
      'commercial_lawn',
    ]);
    // The pilot suggests a pest price with the commercial service key — never the
    // residential pricer — and lawn has no pilot, so it stays a manual quote.
    expect(estimate.lineItems).not.toContainEqual(expect.objectContaining({ service: 'pest_control' }));
    expect(estimate.lineItems).not.toContainEqual(expect.objectContaining({ service: 'lawn_care' }));
    const pest = estimate.lineItems.find((line) => line.service === 'commercial_pest');
    expect(pest).toMatchObject({
      commercialPricingMode: 'small_commercial_pilot',
      // Manual-review line: blocks self-serve accept / membership fee until an
      // operator approves and sends a formal quote.
      quoteRequired: true,
      requiresManualReview: true,
      autoQuoteRequiresAdminApproval: true,
      taxable: true,
      taxCategory: 'nonresidential_pest_control',
    });
    expect(pest.annual).toBeNull();
    expect(pest.suggestedAnnual).toBeGreaterThan(0);
    expect(estimate.lineItems.find((line) => line.service === 'commercial_lawn')).toMatchObject({
      quoteRequired: true,
      commercialPricingMode: 'manual_quote',
    });
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
    expect(titlecase.lineItems).toEqual([
      expect.objectContaining({ service: 'commercial_pest', quoteRequired: true }),
    ]);
    expect(lowercase.lineItems).toEqual([
      expect.objectContaining({ service: 'commercial_pest', quoteRequired: true }),
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
        service: 'commercial_pest',
        quoteRequired: true,
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
  test('commercial v2 payload WITHOUT the pilot flag maps to manual quote spec items', () => {
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
    );

    expect(input).toMatchObject({
      propertyType: 'commercial',
      isCommercial: true,
      commercialSubtype: 'office_retail',
    });

    const mapped = mapV1ToLegacyShape(generateEstimate(input));

    expect(mapped.recurring.services).toEqual([]);
    expect(mapped.specItems).toContainEqual(expect.objectContaining({
      service: 'commercial_pest',
      name: 'Commercial Pest Control',
      quoteRequired: true,
      requiresManualReview: true,
      isCommercial: true,
      taxable: true,
      taxCategory: 'nonresidential_pest_control',
      manualReviewReasons: expect.arrayContaining(['commercial_property_manual_quote_required']),
    }));
    expect(mapped.specItems).toContainEqual(expect.objectContaining({
      service: 'commercial_lawn',
      name: 'Commercial Lawn Treatment',
      quoteRequired: true,
      requiresManualReview: true,
      isCommercial: true,
      taxable: false,
      taxCategory: 'lawn_spraying_or_treatment',
      manualReviewReasons: expect.arrayContaining(['commercial_property_manual_quote_required']),
    }));
    expect(mapped.oneTime.specItems).toContainEqual(expect.objectContaining({
      service: 'commercial_pest',
      quoteRequired: true,
      autoQuoteRequiresAdminApproval: true,
      pricingConfidence: 'LOW',
    }));
  });

  test('commercial v2 payload WITH the pilot flag suggests a pest price as a manual-review spec item', () => {
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
      { commercialPricingMode: 'small_commercial_pilot' }
    );

    const mapped = mapV1ToLegacyShape(generateEstimate(input));

    // Pilot pest is a manual-review line, NOT a recurring self-serve plan — so it
    // never lands in recurring.services (no membership fee / auto-accept).
    expect(mapped.recurring.services).toEqual([]);
    // It surfaces as a quote-required spec item carrying the SUGGESTED price for
    // the operator + proposal (5,000 sqft → $165/visit quarterly → $660/yr).
    expect(mapped.oneTime.specItems).toContainEqual(expect.objectContaining({
      service: 'commercial_pest',
      quoteRequired: true,
      requiresManualReview: true,
      isCommercial: true,
      commercialPricingMode: 'small_commercial_pilot',
      taxable: true,
      taxCategory: 'nonresidential_pest_control',
      autoQuoteRequiresAdminApproval: true,
      suggestedAnnual: 660,
      suggestedQuarterlyPerVisit: 165,
    }));
    // Lawn has no pilot pricer — it stays a plain manual quote.
    expect(mapped.specItems).toContainEqual(expect.objectContaining({
      service: 'commercial_lawn',
      quoteRequired: true,
      requiresManualReview: true,
      isCommercial: true,
    }));
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

  test('legacy mapper marks mixed commercial manual quote estimates and suppresses partial recurring totals', () => {
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
      },
      ['PEST', 'MOSQUITO'],
      {}
    );

    const mapped = mapV1ToLegacyShape(generateEstimate(input));

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
