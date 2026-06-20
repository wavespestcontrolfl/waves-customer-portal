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
          oneTime: {
            total: 250,
            items: [{ service: 'one_time_pest', name: 'One-Time Pest', price: 250 }],
          },
        },
      },
    })).toBeNull();
  });

  test('allows one-time option from recurring pest pricing without a saved one-time total', () => {
    expect(validateEstimateDeliveryOptions({
      showOneTimeOption: true,
      billByInvoice: false,
      onetimeTotal: 0,
      monthlyTotal: 30.67,
      annualTotal: 368.04,
      estimateData: {
        result: {
          results: {
            pestTiers: [{ label: 'Quarterly', mo: 30.67, ann: 368.04, pa: 92, apps: 4 }],
          },
          recurring: {
            services: [{ name: 'Quarterly Pest Control', mo: 30.67 }],
          },
          oneTime: {
            total: 99,
            membershipFee: 99,
            items: [],
          },
        },
      },
    })).toBeNull();
  });

  test('allows one-time option for agent draft engineResult recurring pest pricing', () => {
    expect(validateEstimateDeliveryOptions({
      showOneTimeOption: true,
      billByInvoice: false,
      onetimeTotal: 0,
      monthlyTotal: 30.67,
      annualTotal: 368.04,
      estimateData: {
        engineInputs: {
          services: { pest: { frequency: 'quarterly' } },
        },
        engineResult: {
          monthlyTotal: 30.67,
          annualTotal: 368.04,
          lineItems: [{
            service: 'pest_control',
            name: 'Pest Control',
            monthly: 30.67,
            annual: 368.04,
            basePrice: 92,
            perApp: 92,
            visitsPerYear: 4,
          }],
        },
        agentDraft: true,
      },
    })).toBeNull();
  });

  test('rejects one-time option when pest recurring row lacks derivable choice pricing and no fallback total exists', () => {
    expect(validateEstimateDeliveryOptions({
      showOneTimeOption: true,
      billByInvoice: false,
      onetimeTotal: 0,
      monthlyTotal: 89,
      annualTotal: 1068,
      estimateData: {
        result: {
          recurring: {
            services: [{ name: 'Quarterly Pest Control', mo: 89 }],
          },
          oneTime: {
            total: 0,
            items: [],
          },
        },
      },
    })).toMatch(/per-application pricing/i);
  });

  test('rejects one-time option when only setup fee supplies the one-time total', () => {
    expect(validateEstimateDeliveryOptions({
      showOneTimeOption: true,
      billByInvoice: false,
      onetimeTotal: 99,
      monthlyTotal: 89,
      annualTotal: 1068,
      estimateData: {
        result: {
          recurring: {
            services: [{ name: 'Quarterly Pest Control', mo: 89 }],
          },
          oneTime: {
            total: 99,
            membershipFee: 99,
            items: [],
          },
        },
      },
    })).toMatch(/per-application pricing|priced one-time pest row/i);
  });

  test('rejects one-time option when estimate data has no recurring pest pricing', () => {
    expect(validateEstimateDeliveryOptions({
      showOneTimeOption: true,
      billByInvoice: false,
      onetimeTotal: 250,
      monthlyTotal: 0,
      annualTotal: 0,
      estimateData: {
        result: {
          recurring: { services: [] },
          oneTime: {
            total: 250,
            items: [{ service: 'one_time_pest', name: 'One-Time Pest', price: 250 }],
          },
        },
      },
    })).toMatch(/recurring pest pricing/i);
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

  test('allows invoice mode for a commercial proposal with billable lines (#1917)', () => {
    // A proposal carries its pricing in estimate_data.proposal — top-level
    // totals stay 0 — so the proposal lines are the billable basis.
    expect(validateEstimateDeliveryOptions({
      showOneTimeOption: false,
      billByInvoice: true,
      onetimeTotal: 0,
      monthlyTotal: 0,
      annualTotal: 0,
      estimateData: {
        proposal: {
          enabled: true,
          buildings: [{ name: 'Tower A', lineItems: [{ description: 'Pest', quantity: 1, unitPrice: 260 }] }],
        },
      },
    })).toBeNull();
  });

  test('still rejects invoice mode for a proposal with no priced lines', () => {
    expect(validateEstimateDeliveryOptions({
      showOneTimeOption: false,
      billByInvoice: true,
      onetimeTotal: 0,
      monthlyTotal: 0,
      annualTotal: 0,
      estimateData: {
        proposal: { enabled: true, buildings: [{ name: 'Tower A', lineItems: [{ description: 'TBD', quantity: 1, unitPrice: 0 }] }] },
      },
    })).toMatch(/billable/i);
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

  test('allows approval stored in result inputs when top-level inputs are partial', () => {
    expect(estimateDataHasUnresolvedManagerApproval({
      inputs: {
        svcDethatch: true,
        grassType: 'St. Augustine',
      },
      result: {
        inputs: {
          dethatchingManagerApproved: true,
          dethatchingManagerApprovalReason: 'verified_thatch_probe',
          dethatchingManagerApprovalTrusted: true,
        },
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

  test('rejects trusted approval markers with invalid reasons', () => {
    expect(estimateDataHasUnresolvedManagerApproval({
      result: {
        inputs: {
          dethatchingManagerApproved: true,
          dethatchingManagerApprovalReason: 'bogus',
          dethatchingManagerApprovalTrusted: true,
        },
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
    })).toBe(true);
  });

  test('does not trust engine input approval markers', () => {
    const item = {
      service: 'dethatching',
      requiresManagerApproval: true,
      managerApprovalReason: 'st_augustine_dethatching',
    };
    const engineInputs = {
      dethatchingManagerApproved: true,
      dethatchingManagerApprovalReason: 'verified_thatch_probe',
      dethatchingManagerApprovalTrusted: true,
    };

    expect(estimateDataHasUnresolvedManagerApproval({
      engineInputs,
      result: {
        oneTime: { items: [item] },
      },
    })).toBe(true);

    expect(estimateDataHasUnresolvedManagerApproval({
      result: {
        engineInputs,
        oneTime: { items: [item] },
      },
    })).toBe(true);
  });

  test('top-level approval revocation overrides nested trusted approval', () => {
    expect(estimateDataHasUnresolvedManagerApproval({
      inputs: {
        dethatchingManagerApproved: false,
        dethatchingManagerApprovalReason: '',
      },
      result: {
        inputs: {
          dethatchingManagerApproved: true,
          dethatchingManagerApprovalReason: 'verified_thatch_probe',
          dethatchingManagerApprovalTrusted: true,
        },
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
    })).toBe(true);
  });

  test('preserves result inputs approval during normalization', () => {
    const normalized = normalizeEstimateDethatchingManagerApproval({
      inputs: {
        svcDethatch: true,
        grassType: 'St. Augustine',
      },
      result: {
        inputs: {
          dethatchingManagerApproved: true,
          dethatchingManagerApprovalReason: 'verified_thatch_probe',
          dethatchingManagerApprovalTrusted: true,
          dethatchingManagerApprovedBy: 'admin-2',
          dethatchingManagerApprovedByRole: 'admin',
          dethatchingManagerApprovedAt: '2026-05-22T11:00:00.000Z',
        },
        oneTime: {
          items: [
            {
              service: 'dethatching',
              price: null,
              estimatedPrice: 180,
              requiresManagerApproval: true,
              managerApprovalReason: 'st_augustine_dethatching',
              manualReviewReasons: ['st_augustine_dethatching_manager_approval_required'],
              quoteRequired: true,
              requiresCustomQuote: true,
            },
          ],
        },
      },
    }, {
      technician: { id: 'admin-2', role: 'admin' },
      technicianId: 'admin-2',
      now: () => new Date('2026-05-22T12:00:00.000Z'),
    });

    expect(normalized.inputs).toEqual(expect.objectContaining({
      dethatchingManagerApproved: true,
      dethatchingManagerApprovalReason: 'verified_thatch_probe',
      dethatchingManagerApprovalTrusted: true,
      dethatchingManagerApprovedBy: 'admin-2',
      dethatchingManagerApprovedByRole: 'admin',
      dethatchingManagerApprovedAt: '2026-05-22T11:00:00.000Z',
    }));
    expect(normalized.result.oneTime.items[0]).toEqual(expect.objectContaining({
      price: 180,
      quoteRequired: false,
      managerApproved: true,
      managerApprovalSatisfied: true,
      managerApprovalOverrideReason: 'verified_thatch_probe',
      managerApprovalApprovedBy: 'admin-2',
    }));
    expect(estimateDataHasUnresolvedManagerApproval(normalized)).toBe(false);
  });

  test('normalization keeps explicit top-level revocation over nested approval', () => {
    const normalized = normalizeEstimateDethatchingManagerApproval({
      inputs: {
        dethatchingManagerApproved: false,
        dethatchingManagerApprovalReason: '',
      },
      result: {
        inputs: {
          dethatchingManagerApproved: true,
          dethatchingManagerApprovalReason: 'verified_thatch_probe',
          dethatchingManagerApprovalTrusted: true,
        },
        oneTime: {
          items: [
            {
              service: 'dethatching',
              price: 180,
              estimatedPrice: 180,
              requiresManagerApproval: true,
              managerApprovalReason: 'st_augustine_dethatching',
              manualReviewReasons: [],
              quoteRequired: false,
              requiresCustomQuote: false,
            },
          ],
        },
      },
    }, {
      technician: { id: 'admin-1', role: 'admin' },
      technicianId: 'admin-1',
      now: () => new Date('2026-05-22T12:00:00.000Z'),
    });

    expect(normalized.inputs).toEqual(expect.objectContaining({
      dethatchingManagerApproved: false,
      dethatchingManagerApprovalReason: '',
      dethatchingManagerApprovalTrusted: false,
    }));
    expect(normalized.result.oneTime.items[0]).toEqual(expect.objectContaining({
      price: null,
      quoteRequired: true,
      managerApproved: false,
      managerApprovalSatisfied: false,
    }));
    expect(estimateDataHasUnresolvedManagerApproval(normalized)).toBe(true);
  });

  test('preserves approver metadata across repeated normalization', () => {
    const firstPass = normalizeEstimateDethatchingManagerApproval({
      inputs: {
        svcDethatch: true,
        grassType: 'St. Augustine',
      },
      result: {
        inputs: {
          dethatchingManagerApproved: true,
          dethatchingManagerApprovalReason: 'verified_thatch_probe',
          dethatchingManagerApprovalTrusted: true,
          dethatchingManagerApprovedBy: 'admin-2',
          dethatchingManagerApprovedByRole: 'admin',
          dethatchingManagerApprovedAt: '2026-05-22T11:00:00.000Z',
        },
        oneTime: {
          items: [
            {
              service: 'dethatching',
              price: null,
              estimatedPrice: 180,
              requiresManagerApproval: true,
              managerApprovalReason: 'st_augustine_dethatching',
              manualReviewReasons: ['st_augustine_dethatching_manager_approval_required'],
              quoteRequired: true,
              requiresCustomQuote: true,
            },
          ],
        },
      },
    }, {
      technician: { id: 'admin-3', role: 'admin' },
      technicianId: 'admin-3',
      now: () => new Date('2026-05-22T12:00:00.000Z'),
    });

    const secondPass = normalizeEstimateDethatchingManagerApproval(firstPass, {
      technician: { id: 'admin-4', role: 'admin' },
      technicianId: 'admin-4',
      now: () => new Date('2026-05-22T13:00:00.000Z'),
    });

    expect(secondPass.inputs).toEqual(expect.objectContaining({
      dethatchingManagerApprovedBy: 'admin-2',
      dethatchingManagerApprovedByRole: 'admin',
      dethatchingManagerApprovedAt: '2026-05-22T11:00:00.000Z',
    }));
    expect(secondPass.result.oneTime.items[0]).toEqual(expect.objectContaining({
      managerApprovalApprovedBy: 'admin-2',
      managerApprovalApprovedByRole: 'admin',
      managerApprovalApprovedAt: '2026-05-22T11:00:00.000Z',
    }));
  });

  test('strips result input approval markers from non-admin normalization', () => {
    const normalized = normalizeEstimateDethatchingManagerApproval({
      inputs: {
        svcDethatch: true,
        grassType: 'St. Augustine',
      },
      result: {
        inputs: {
          dethatchingManagerApproved: true,
          dethatchingManagerApprovalReason: 'verified_thatch_probe',
          dethatchingManagerApprovalTrusted: true,
        },
        oneTime: {
          items: [
            {
              service: 'dethatching',
              price: null,
              estimatedPrice: 180,
              requiresManagerApproval: true,
              managerApprovalReason: 'st_augustine_dethatching',
              manualReviewReasons: [],
              quoteRequired: false,
              requiresCustomQuote: false,
            },
          ],
        },
      },
    }, {
      technician: { id: 'tech-1', role: 'technician' },
      technicianId: 'tech-1',
      now: () => new Date('2026-05-22T12:00:00.000Z'),
    });

    expect(normalized.result.inputs).toEqual(expect.objectContaining({
      dethatchingManagerApproved: false,
      dethatchingManagerApprovalReason: '',
      dethatchingManagerApprovalTrusted: false,
    }));
    expect(normalized.result.oneTime.items[0]).toEqual(expect.objectContaining({
      price: null,
      quoteRequired: true,
      managerApproved: false,
      managerApprovalSatisfied: false,
    }));
    expect(estimateDataHasUnresolvedManagerApproval(normalized)).toBe(true);
  });

  test('does not combine approval fields from different input payloads', () => {
    expect(estimateDataHasUnresolvedManagerApproval({
      inputs: {
        dethatchingManagerApproved: true,
        dethatchingManagerApprovalReason: 'verified_thatch_probe',
      },
      result: {
        inputs: {
          dethatchingManagerApprovalTrusted: true,
        },
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
    })).toBe(true);
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

  test('normalizes malformed manual review reason payloads without throwing', () => {
    const normalized = normalizeEstimateDethatchingManagerApproval({
      inputs: {
        dethatchingManagerApproved: true,
        dethatchingManagerApprovalReason: 'verified_thatch_probe',
      },
      result: {
        oneTime: {
          items: [{
            service: 'dethatching',
            name: 'Dethatching',
            price: null,
            estimatedPrice: 180,
            requiresManagerApproval: true,
            managerApprovalReason: 'st_augustine_dethatching',
            manualReviewReasons: 'st_augustine_dethatching_manager_approval_required',
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

    expect(normalized.result.oneTime.items[0]).toEqual(expect.objectContaining({
      price: 180,
      quoteRequired: false,
      managerApproved: true,
      managerApprovalSatisfied: true,
    }));
    expect(normalized.result.oneTime.items[0].manualReviewReasons).toEqual([]);
  });

  test('preserves scalar non-dethatching manual review reasons during approval normalization', () => {
    const normalized = normalizeEstimateDethatchingManagerApproval({
      inputs: {
        dethatchingManagerApproved: true,
        dethatchingManagerApprovalReason: 'verified_thatch_probe',
      },
      result: {
        oneTime: {
          items: [{
            service: 'dethatching',
            name: 'Dethatching',
            price: null,
            estimatedPrice: 180,
            requiresManagerApproval: true,
            managerApprovalReason: 'st_augustine_dethatching',
            manualReviewReasons: 'field_measurement_needed',
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

    expect(normalized.result.oneTime.items[0]).toEqual(expect.objectContaining({
      price: null,
      quoteRequired: true,
      managerApproved: true,
      managerApprovalSatisfied: true,
    }));
    expect(normalized.result.oneTime.items[0].manualReviewReasons).toEqual([
      'field_measurement_needed',
    ]);
  });

  test('propagates trusted St. Augustine dethatching approval into engine inputs', () => {
    const normalized = normalizeEstimateDethatchingManagerApproval({
      inputs: {
        dethatchingManagerApproved: true,
        dethatchingManagerApprovalReason: 'verified_thatch_probe',
      },
      engineInputs: {
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
      },
    }, {
      technician: { id: 'admin-1', role: 'admin' },
      technicianId: 'admin-1',
      now: () => new Date('2026-05-22T12:00:00.000Z'),
    });

    expect(normalized.engineInputs).toEqual(expect.objectContaining({
      dethatchingManagerApproved: true,
      dethatchingManagerApprovalTrusted: true,
      dethatchingManagerApprovalReason: 'verified_thatch_probe',
    }));
    expect(normalized.engineInputs.services.dethatching).toEqual(expect.objectContaining({
      managerApproved: true,
      managerApprovalReason: 'verified_thatch_probe',
    }));

    const regenerated = generateEstimate(normalized.engineInputs);
    const dethatching = regenerated.lineItems.find((item) => item.service === 'dethatching');
    expect(dethatching).toEqual(expect.objectContaining({
      quoteRequired: false,
      managerApprovalSatisfied: true,
      managerApproved: true,
      managerApprovalOverrideReason: 'verified_thatch_probe',
    }));
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
