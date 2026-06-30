const {
  inferEstimateServiceInterest,
  inferEstimateServiceLines,
  serviceKeysFromText,
} = require('../services/estimate-service-lines');

describe('estimate service line inference', () => {
  test('infers priced commercial lines from engineResult.lineItems (public quote save shape)', () => {
    // Public quote persists priced commercial programs under
    // engineResult.lineItems with no recurring.services block — they must be
    // classified with their commercial key + metadata, not as residential.
    const estimate = {
      estimate_data: {
        engineResult: {
          lineItems: [
            {
              service: 'commercial_lawn', name: 'Commercial Lawn Treatment',
              monthly: 391, annual: 4689, quoteRequired: false, isCommercial: true,
              commercialPricingMode: 'auto_estimate', taxable: false,
              taxCategory: 'lawn_spraying_or_treatment', pricingConfidence: 'LOW',
            },
            {
              service: 'commercial_tree_shrub', name: 'Commercial Tree & Shrub',
              monthly: 201, annual: 2412, quoteRequired: false, isCommercial: true,
            },
          ],
        },
      },
    };
    const lines = inferEstimateServiceLines(estimate);
    const byKey = Object.fromEntries(lines.map((l) => [l.key, l]));
    expect(byKey.commercial_lawn).toBeTruthy();
    expect(byKey.commercial_lawn.isCommercial).toBe(true);
    expect(byKey.commercial_lawn.commercialPricingMode).toBe('auto_estimate');
    expect(byKey.commercial_lawn.amount).toBe(391);
    expect(byKey.commercial_tree_shrub).toBeTruthy();
    expect(byKey.commercial_tree_shrub.isCommercial).toBe(true);
    // Not misclassified as residential lawn / tree_shrub.
    expect(byKey.lawn).toBeUndefined();
    expect(byKey.tree_shrub).toBeUndefined();
  });

  test('classifies explicit service-interest text without defaulting blanks to pest', () => {
    expect(serviceKeysFromText('General Pest Control')).toEqual(['pest']);
    expect(serviceKeysFromText('General Pest Control + Lawn Care')).toEqual(['lawn', 'pest']);
    expect(serviceKeysFromText('Commercial Pest Control')).toEqual(['commercial_pest']);
    expect(serviceKeysFromText('Commercial Lawn Treatment')).toEqual(['commercial_lawn']);
    expect(serviceKeysFromText('Commercial Pest Control + Commercial Lawn')).toEqual(['commercial_pest', 'commercial_lawn']);
    // Commercial pest-family text must NOT also emit its residential counterpart
    // (the commercial patterns are a superset of the residential ones).
    expect(serviceKeysFromText('Commercial Mosquito')).toEqual(['commercial_mosquito']);
    expect(serviceKeysFromText('Commercial Termite Bait Monitoring')).toEqual(['commercial_termite_bait']);
    expect(serviceKeysFromText('Commercial Rodent Bait Stations')).toEqual(['commercial_rodent_bait']);
    expect(serviceKeysFromText('Palm Injection')).toEqual(['palm_injection']);
    expect(serviceKeysFromText('Palms to treat')).toEqual(['palm_injection']);
    expect(serviceKeysFromText('Native / Palmetto / American roaches')).toEqual(['pest']);
    expect(serviceKeysFromText('Initial Palmetto Knockdown')).toEqual(['pest']);
    expect(serviceKeysFromText('palmettoexterminator.com lead')).toEqual(['pest']);
    expect(serviceKeysFromText('')).toEqual([]);
  });

  test('extracts actual recurring services and prorates bundle discounts', () => {
    const lines = inferEstimateServiceLines({
      estimateData: {
        result: {
          recurring: {
            grandTotal: 119.1,
            services: [
              { service: 'lawn_care', name: 'Lawn Care', mo: 84 },
              { service: 'pest_control', name: 'Pest Control', mo: 48.33 },
            ],
          },
        },
      },
      monthlyTotal: 119.1,
    });

    expect(lines).toEqual([
      { key: 'lawn', amount: 75.6, amountBasis: 'monthly' },
      { key: 'pest', amount: 43.5, amountBasis: 'monthly' },
    ]);
    expect(inferEstimateServiceInterest({ estimateData: { result: { recurring: { services: [{ service: 'pest_control', mo: 30 }] } } } }))
      .toBe('Pest Control');
  });

  test('surfaces palm injection count metadata from saved legacy estimate results', () => {
    const lines = inferEstimateServiceLines({
      estimateData: {
        result: {
          recurring: {
            palmInjectionMo: 31.25,
            services: [],
          },
          results: {
            injection: {
              palms: 5,
              mo: 31.25,
              measurements: {
                palmCount: { value: 5, source: 'service_manual_override' },
              },
              palmCountSource: 'service_manual_override',
              palmCountWasManualOverride: true,
              servicePalmCountDiffersFromPropertyPalmCount: true,
              measurementWarnings: ['service_palm_count_differs_from_property_palm_count'],
            },
          },
        },
      },
    });

    expect(lines).toEqual([
      expect.objectContaining({
        key: 'palm_injection',
        amount: 31.25,
        amountBasis: 'monthly',
        measurements: {
          palmCount: { value: 5, source: 'service_manual_override' },
        },
        palmCountSource: 'service_manual_override',
        palmCountWasManualOverride: true,
        servicePalmCountDiffersFromPropertyPalmCount: true,
        measurementWarnings: ['service_palm_count_differs_from_property_palm_count'],
      }),
    ]);
    expect(inferEstimateServiceInterest({ estimateData: { inputs: { svcInjection: true } } })).toBe('Palm Injection');
  });

  test('surfaces unknown service data instead of assigning pest', () => {
    expect(inferEstimateServiceLines({ monthlyTotal: 99 })).toEqual([
      { key: 'unknown', amount: null, amountBasis: 'unknown' },
    ]);
    expect(inferEstimateServiceInterest({ monthlyTotal: 99 })).toBeNull();
  });

  test('preserves commercial manual quote metadata from saved estimate data', () => {
    const estimate = {
      estimateData: {
        result: {
          specItems: [
            {
              service: 'commercial_pest',
              name: 'Commercial Pest Control',
              price: null,
              commercialPricingMode: 'manual_quote',
              isCommercial: true,
              commercialSubtype: 'office_retail',
              originalRequestedService: 'pest_control',
              quoteRequired: true,
              requiresManualReview: true,
              autoQuoteRequiresAdminApproval: true,
              manualReviewReasons: ['commercial_property_manual_quote_required'],
              taxable: true,
              taxCategory: 'nonresidential_pest_control',
              pricingConfidence: 'LOW',
              reason: 'Commercial pest requires manual quote or commercial pilot pricing.',
            },
          ],
        },
      },
    };

    expect(inferEstimateServiceLines(estimate)).toEqual([
      {
        key: 'commercial_pest',
        service: 'commercial_pest',
        amount: null,
        amountBasis: 'manual_quote',
        commercialPricingMode: 'manual_quote',
        isCommercial: true,
        commercialSubtype: 'office_retail',
        originalRequestedService: 'pest_control',
        quoteRequired: true,
        requiresManualReview: true,
        autoQuoteRequiresAdminApproval: true,
        manualReviewReasons: ['commercial_property_manual_quote_required'],
        taxable: true,
        taxCategory: 'nonresidential_pest_control',
        pricingConfidence: 'LOW',
        reason: 'Commercial pest requires manual quote or commercial pilot pricing.',
      },
    ]);
    expect(inferEstimateServiceInterest(estimate)).toBe('Commercial Pest Control');
  });

  test('preserves public quote wizard commercial manual quote lines', () => {
    const estimate = {
      service_interest: 'Pest Control + Lawn Care',
      monthly_total: 0,
      estimate_data: {
        quoteRequired: true,
        manualQuoteLines: [
          {
            service: 'commercial_pest',
            name: 'Commercial Pest Control',
            price: null,
            commercialPricingMode: 'manual_quote',
            isCommercial: true,
            originalRequestedService: 'pest_control',
            quoteRequired: true,
            requiresManualReview: true,
            autoQuoteRequiresAdminApproval: true,
            manualReviewReasons: ['commercial_property_manual_quote_required'],
            taxable: true,
            taxCategory: 'nonresidential_pest_control',
            pricingConfidence: 'LOW',
            reason: 'Commercial pest requires manual quote or commercial pilot pricing.',
          },
          {
            service: 'commercial_lawn',
            name: 'Commercial Lawn Treatment',
            price: null,
            commercialPricingMode: 'manual_quote',
            isCommercial: true,
            originalRequestedService: 'lawn_care',
            quoteRequired: true,
            requiresManualReview: true,
            autoQuoteRequiresAdminApproval: true,
            manualReviewReasons: ['commercial_property_manual_quote_required'],
            taxable: false,
            taxCategory: 'lawn_spraying_or_treatment',
            pricingConfidence: 'LOW',
            reason: 'Commercial lawn treatment requires manual quote or commercial pilot pricing.',
          },
        ],
      },
    };

    expect(inferEstimateServiceLines(estimate)).toEqual([
      expect.objectContaining({
        key: 'commercial_pest',
        service: 'commercial_pest',
        quoteRequired: true,
        taxable: true,
        taxCategory: 'nonresidential_pest_control',
      }),
      expect.objectContaining({
        key: 'commercial_lawn',
        service: 'commercial_lawn',
        quoteRequired: true,
        taxable: false,
        taxCategory: 'lawn_spraying_or_treatment',
      }),
    ]);
    expect(inferEstimateServiceLines(estimate)).not.toContainEqual(expect.objectContaining({ key: 'pest' }));
    expect(inferEstimateServiceLines(estimate)).not.toContainEqual(expect.objectContaining({ key: 'lawn' }));
  });

  test('keeps priced public quote services with commercial manual quote rows', () => {
    const estimate = {
      service_interest: 'Pest Control + Mosquito Control',
      monthly_total: 0,
      estimate_data: {
        quoteRequired: true,
        manualQuoteLines: [
          {
            service: 'commercial_pest',
            name: 'Commercial Pest Control',
            price: null,
            commercialPricingMode: 'manual_quote',
            isCommercial: true,
            originalRequestedService: 'pest_control',
            quoteRequired: true,
            requiresManualReview: true,
          },
        ],
        result: {
          lineItems: [
            {
              service: 'commercial_pest',
              name: 'Commercial Pest Control',
              price: null,
              commercialPricingMode: 'manual_quote',
              isCommercial: true,
              originalRequestedService: 'pest_control',
              quoteRequired: true,
              requiresManualReview: true,
            },
            {
              service: 'mosquito',
              name: 'Mosquito',
              monthlyAfterDiscount: 103.5,
              annualAfterDiscount: 1242,
            },
          ],
          specItems: [
            {
              service: 'commercial_pest',
              name: 'Commercial Pest Control',
              price: null,
              commercialPricingMode: 'manual_quote',
              isCommercial: true,
              originalRequestedService: 'pest_control',
              quoteRequired: true,
              requiresManualReview: true,
            },
          ],
          recurring: {
            grandTotal: 103.5,
            services: [
              { service: 'mosquito', name: 'Mosquito', mo: 103.5 },
            ],
          },
          oneTime: {
            total: 0,
            specItems: [
              {
                service: 'commercial_pest',
                name: 'Commercial Pest Control',
                price: null,
                commercialPricingMode: 'manual_quote',
                isCommercial: true,
                originalRequestedService: 'pest_control',
                quoteRequired: true,
                requiresManualReview: true,
              },
            ],
          },
        },
      },
    };

    expect(inferEstimateServiceLines(estimate)).toEqual([
      expect.objectContaining({
        key: 'commercial_pest',
        service: 'commercial_pest',
        amountBasis: 'manual_quote',
        quoteRequired: true,
      }),
      { key: 'mosquito', amount: 103.5, amountBasis: 'monthly' },
    ]);
  });

  test('keeps priced one-time service lines with commercial manual quote rows', () => {
    const estimate = {
      serviceInterest: 'Commercial Pest Control + Termite Trenching + Top Dressing',
      onetimeTotal: 2714,
      estimateData: {
        inputs: {
          svcPest: true,
          svcTrenching: true,
          svcTopdress: true,
        },
        result: {
          specItems: [
            {
              service: 'commercial_pest',
              name: 'Commercial Pest Control',
              price: null,
              commercialPricingMode: 'manual_quote',
              isCommercial: true,
              originalRequestedService: 'pest_control',
              quoteRequired: true,
              requiresManualReview: true,
              autoQuoteRequiresAdminApproval: true,
              manualReviewReasons: ['commercial_property_manual_quote_required'],
              taxable: true,
              taxCategory: 'nonresidential_pest_control',
              pricingConfidence: 'LOW',
              reason: 'Commercial pest requires manual quote or commercial pilot pricing.',
            },
          ],
          oneTime: {
            items: [
              { service: 'trenching', name: 'Trenching', price: 2464 },
              { service: 'top_dressing', name: 'Top Dressing', price: 250 },
            ],
          },
        },
      },
    };

    expect(inferEstimateServiceLines(estimate)).toEqual([
      expect.objectContaining({
        key: 'commercial_pest',
        service: 'commercial_pest',
        amountBasis: 'manual_quote',
        quoteRequired: true,
      }),
      { key: 'termite', amount: 2464, amountBasis: 'one_time' },
      { key: 'lawn', amount: 250, amountBasis: 'one_time' },
    ]);
  });

  test('keeps priced specialty spec items with commercial manual quote rows', () => {
    const estimate = {
      estimateData: {
        result: {
          specItems: [
            {
              service: 'commercial_pest',
              name: 'Commercial Pest Control',
              price: null,
              commercialPricingMode: 'manual_quote',
              isCommercial: true,
              originalRequestedService: 'pest_control',
              quoteRequired: true,
            },
            { service: 'flea', name: 'Flea Treatment', price: 350 },
          ],
          oneTime: {
            specItems: [
              {
                service: 'commercial_pest',
                name: 'Commercial Pest Control',
                price: null,
                commercialPricingMode: 'manual_quote',
                isCommercial: true,
                originalRequestedService: 'pest_control',
                quoteRequired: true,
              },
              { service: 'flea', name: 'Flea Treatment', price: 350 },
            ],
          },
        },
      },
    };

    expect(inferEstimateServiceLines(estimate)).toEqual([
      expect.objectContaining({
        key: 'commercial_pest',
        service: 'commercial_pest',
        amountBasis: 'manual_quote',
        quoteRequired: true,
      }),
      { key: 'pest', amount: 350, amountBasis: 'one_time' },
    ]);
  });

  test('deduplicates mapped specialty rows that use det/detail aliases', () => {
    const estimate = {
      estimateData: {
        result: {
          specItems: [
            {
              service: 'commercial_pest',
              name: 'Commercial Pest Control',
              price: null,
              commercialPricingMode: 'manual_quote',
              isCommercial: true,
              originalRequestedService: 'pest_control',
              quoteRequired: true,
            },
            {
              service: 'flea_package',
              name: 'Flea Treatment Package - 2 visits',
              price: 365,
              det: '$235 initial + $130 follow-up',
            },
          ],
          oneTime: {
            specItems: [
              {
                service: 'commercial_pest',
                name: 'Commercial Pest Control',
                price: null,
                commercialPricingMode: 'manual_quote',
                isCommercial: true,
                originalRequestedService: 'pest_control',
                quoteRequired: true,
              },
              {
                service: 'flea_package',
                name: 'Flea Treatment Package - 2 visits',
                price: 365,
                detail: '$235 initial + $130 follow-up',
              },
            ],
          },
        },
      },
    };

    expect(inferEstimateServiceLines(estimate)).toEqual([
      expect.objectContaining({
        key: 'commercial_pest',
        service: 'commercial_pest',
        amountBasis: 'manual_quote',
        quoteRequired: true,
      }),
      { key: 'pest', amount: 365, amountBasis: 'one_time' },
    ]);
  });
});
