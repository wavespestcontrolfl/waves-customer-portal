const {
  estimateDataHasQuoteRequirement,
  estimateDataHasUnresolvedManagerApproval,
  normalizeEstimateDethatchingManagerApproval,
  validateEstimateDeliveryOptions,
} = require('../services/estimate-delivery-options');
const { generateEstimate } = require('../services/pricing-engine');
const { mapV1ToLegacyShape } = require('../services/pricing-engine/v1-legacy-mapper');

describe('admin estimate delivery option validation', () => {
  test('rejects one-time option when estimate has no one-time total', () => {
    expect(validateEstimateDeliveryOptions({
      showOneTimeOption: true,
      billByInvoice: false,
      onetimeTotal: 0,
      monthlyTotal: 89,
      annualTotal: 1068,
    })).toMatch(/one-time total/i);
  });

  test('allows one-time option when estimate has a one-time total', () => {
    expect(validateEstimateDeliveryOptions({
      showOneTimeOption: true,
      billByInvoice: false,
      onetimeTotal: 250,
      monthlyTotal: 89,
      annualTotal: 1068,
    })).toBeNull();
  });

  test('rejects one-time option for mixed recurring service estimates', () => {
    expect(validateEstimateDeliveryOptions({
      showOneTimeOption: true,
      billByInvoice: false,
      onetimeTotal: 250,
      monthlyTotal: 169,
      annualTotal: 2028,
      estimateData: {
        result: {
          recurring: {
            services: [
              { name: 'Pest Control', mo: 89 },
              { name: 'Lawn Care', mo: 80 },
            ],
          },
        },
      },
    })).toMatch(/pest-only/i);
  });

  test('allows one-time option for pest-only recurring estimates', () => {
    expect(validateEstimateDeliveryOptions({
      showOneTimeOption: true,
      billByInvoice: false,
      onetimeTotal: 250,
      monthlyTotal: 89,
      annualTotal: 1068,
      estimateData: {
        result: {
          recurring: {
            services: [{ name: 'Quarterly Pest Control', mo: 89 }],
          },
        },
      },
    })).toBeNull();
  });

  test('rejects invoice mode when estimate has no billable total', () => {
    expect(validateEstimateDeliveryOptions({
      showOneTimeOption: false,
      billByInvoice: true,
      onetimeTotal: 0,
      monthlyTotal: 0,
      annualTotal: 0,
    })).toMatch(/billable/i);
  });

  test('allows invoice mode for recurring or one-time totals', () => {
    expect(validateEstimateDeliveryOptions({
      showOneTimeOption: false,
      billByInvoice: true,
      onetimeTotal: 0,
      monthlyTotal: 89,
      annualTotal: 1068,
    })).toBeNull();

    expect(validateEstimateDeliveryOptions({
      showOneTimeOption: false,
      billByInvoice: true,
      onetimeTotal: 250,
      monthlyTotal: 0,
      annualTotal: 0,
    })).toBeNull();
  });

  test('detects unresolved St. Augustine dethatching manager approval', () => {
    expect(estimateDataHasUnresolvedManagerApproval({
      result: {
        oneTime: {
          items: [
            {
              service: 'dethatching',
              requiresManagerApproval: true,
              managerApprovalReason: 'st_augustine_dethatching',
              managerApprovalSatisfied: false,
            },
          ],
        },
      },
    })).toBe(true);
  });

  test('allows St. Augustine dethatching after trusted admin approval and reason are recorded', () => {
    expect(estimateDataHasUnresolvedManagerApproval({
      inputs: {
        dethatchingManagerApproved: true,
        dethatchingManagerApprovalReason: 'verified_thatch_probe',
        dethatchingManagerApprovalTrusted: true,
      },
      result: {
        oneTime: {
          items: [
            {
              service: 'dethatching',
              requiresManagerApproval: true,
              managerApprovalReason: 'st_augustine_dethatching',
            },
          ],
        },
      },
    })).toBe(false);

  });

  test('does not trust item-level approval without a server-trusted approval marker', () => {
    expect(estimateDataHasUnresolvedManagerApproval({
      result: {
        oneTime: {
          items: [
            {
              service: 'dethatching',
              requiresManagerApproval: true,
              managerApprovalReason: 'st_augustine_dethatching',
              managerApprovalSatisfied: true,
            },
          ],
        },
      },
    })).toBe(true);
  });

  test('detects legacy V2 St. Augustine dethatching inputs without line metadata', () => {
    expect(estimateDataHasUnresolvedManagerApproval({
      inputs: {
        svcDethatch: true,
        grassType: 'Floratam',
        dethatchingManagerApproved: true,
        dethatchingManagerApprovalReason: 'verified_thatch_probe',
      },
      result: {
        oneTime: {
          items: [
            {
              service: 'dethatching',
              name: 'Dethatching',
              price: 150,
            },
          ],
        },
      },
    })).toBe(true);
  });

  test('detects object-shaped St. Augustine dethatching selections without line metadata', () => {
    expect(estimateDataHasUnresolvedManagerApproval({
      engineInputs: {
        grassType: 'St. Augustine',
        services: {
          dethatching: {
            thatchDepthInches: 0.8,
          },
        },
      },
    })).toBe(true);

    expect(estimateDataHasUnresolvedManagerApproval({
      engineInputs: {
        grassType: 'St. Augustine',
        services: {
          dethatching: {
            selected: false,
            thatchDepthInches: 0.8,
          },
        },
      },
    })).toBe(false);
  });

  test('allows legacy V2 St. Augustine dethatching inputs after trusted approval', () => {
    expect(estimateDataHasUnresolvedManagerApproval({
      inputs: {
        svcDethatch: true,
        grassType: 'St. Augustine',
        dethatchingManagerApproved: true,
        dethatchingManagerApprovalReason: 'verified_thatch_probe',
        dethatchingManagerApprovalTrusted: true,
      },
      result: {
        oneTime: {
          items: [
            {
              service: 'dethatching',
              name: 'Dethatching',
              price: 150,
            },
          ],
        },
      },
    })).toBe(false);
  });

  test('normalizes server-mapped St. Augustine dethatching spec rows after trusted approval', () => {
    const mapped = mapV1ToLegacyShape(generateEstimate({
      homeSqFt: 2200,
      stories: 1,
      lotSqFt: 12000,
      measuredTurfSf: 4500,
      propertyType: 'single_family',
      grassType: 'st_augustine',
      services: {
        dethatching: {
          thatchDepthInches: 0.8,
        },
      },
    }));

    const mappedSpec = mapped.oneTime.specItems.find((item) => item.service === 'dethatching');
    expect(mappedSpec).toEqual(expect.objectContaining({
      price: null,
      estimatedPrice: expect.any(Number),
      requiresManagerApproval: true,
      managerApprovalReason: 'st_augustine_dethatching',
      quoteRequired: true,
    }));
    expect(mapped.quoteRequiredItems.find((item) => item.service === 'dethatching')).toEqual(expect.objectContaining({
      estimatedPrice: mappedSpec.estimatedPrice,
      requiresManagerApproval: true,
      managerApprovalReason: 'st_augustine_dethatching',
    }));

    const normalized = normalizeEstimateDethatchingManagerApproval({
      inputs: {
        svcDethatch: true,
        grassType: 'st_augustine',
        dethatchingManagerApproved: true,
        dethatchingManagerApprovalReason: 'verified_thatch_probe',
      },
      result: mapped,
    }, {
      technician: { id: 'admin-1', role: 'admin' },
      technicianId: 'admin-1',
      now: () => new Date('2026-05-22T12:00:00.000Z'),
    });
    const normalizedSpec = normalized.result.oneTime.specItems.find((item) => item.service === 'dethatching');

    expect(normalizedSpec).toEqual(expect.objectContaining({
      price: mappedSpec.estimatedPrice,
      estimatedPrice: mappedSpec.estimatedPrice,
      quoteRequired: false,
      requiresCustomQuote: false,
      managerApproved: true,
      managerApprovalSatisfied: true,
      managerApprovalOverrideReason: 'verified_thatch_probe',
    }));
    expect(normalizedSpec.manualReviewReasons).toEqual([]);
    expect(normalized.result.quoteRequired).toBe(false);
    expect(normalized.result.quoteRequiredItems).toEqual([]);
    expect(estimateDataHasQuoteRequirement(normalized)).toBe(false);
    expect(estimateDataHasUnresolvedManagerApproval(normalized)).toBe(false);
  });

  test('normalizes St. Augustine dethatching rows that only carry review-reason tokens', () => {
    const normalized = normalizeEstimateDethatchingManagerApproval({
      inputs: {
        dethatchingManagerApproved: true,
        dethatchingManagerApprovalReason: 'verified_thatch_probe',
      },
      result: {
        quoteRequired: true,
        quoteRequiredItems: [{
          service: 'dethatching',
          estimatedPrice: 180,
          manualReviewReasons: ['st_augustine_dethatching_manager_approval_required'],
          quoteRequired: true,
        }],
        oneTime: {
          specItems: [{
            service: 'dethatching',
            name: 'Dethatching',
            price: null,
            estimatedPrice: 180,
            manualReviewReasons: ['st_augustine_dethatching_manager_approval_required'],
            quoteRequired: true,
            requiresCustomQuote: true,
          }],
        },
      },
    }, {
      technician: { id: 'admin-1', role: 'admin' },
      technicianId: 'admin-1',
      now: () => new Date('2026-05-22T12:00:00.000Z'),
    });

    const normalizedSpec = normalized.result.oneTime.specItems.find((item) => item.service === 'dethatching');
    expect(normalizedSpec).toEqual(expect.objectContaining({
      price: 180,
      estimatedPrice: 180,
      quoteRequired: false,
      requiresCustomQuote: false,
      managerApproved: true,
      managerApprovalSatisfied: true,
      managerApprovalOverrideReason: 'verified_thatch_probe',
    }));
    expect(normalizedSpec.manualReviewReasons).toEqual([]);
    expect(normalized.result.quoteRequiredItems).toEqual([]);
    expect(estimateDataHasQuoteRequirement(normalized)).toBe(false);
    expect(estimateDataHasUnresolvedManagerApproval(normalized)).toBe(false);
  });

  test('does not treat aggregate review metadata as an unresolved approval after item approval', () => {
    expect(estimateDataHasUnresolvedManagerApproval({
      inputs: {
        dethatchingManagerApproved: true,
        dethatchingManagerApprovalReason: 'verified_thatch_probe',
        dethatchingManagerApprovalTrusted: true,
      },
      result: {
        pricingMetadata: {
          manualReviewReasons: ['st_augustine_dethatching'],
        },
        oneTime: {
          items: [
            {
              service: 'dethatching',
              requiresManagerApproval: true,
              managerApprovalReason: 'st_augustine_dethatching',
              managerApprovalSatisfied: true,
            },
          ],
        },
      },
    })).toBe(false);
  });
});
