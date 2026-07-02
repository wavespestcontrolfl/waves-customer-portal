jest.mock('../models/db', () => jest.fn());

const {
  buildEstimatePersistenceFields,
  createOrReuseAdminEstimate,
  estimateViewUrl,
} = require('../services/admin-estimate-persistence');
const {
  clearAllEstimatePricingCache,
  getEstimatePricingCache,
  setEstimatePricingCache,
} = require('../services/estimate-pricing-cache');
const { generateEstimate } = require('../services/pricing-engine');
const { mapV1ToLegacyShape } = require('../services/pricing-engine/v1-legacy-mapper');

function makeDatabase({ lead, estimate, emptyEstimateUpdate = false }) {
  const updates = [];
  const inserts = [];
  let storedEstimate = estimate;

  const trx = (table) => ({
    where(clause) {
      return {
        forUpdate() {
          return this;
        },
        whereNull() {
          return this;
        },
        first: async () => {
          if (table === 'leads' && clause.id === lead?.id) return lead;
          if (table === 'estimates' && clause.id === storedEstimate?.id) return storedEstimate;
          return null;
        },
        update(patch) {
          updates.push({ table, clause, patch });
          if (table === 'estimates' && clause.id === storedEstimate?.id) {
            if (emptyEstimateUpdate) return { returning: async () => [] };
            storedEstimate = { ...storedEstimate, ...patch };
            return { returning: async () => [storedEstimate] };
          }
          return Promise.resolve(1);
        },
      };
    },
    insert(row) {
      inserts.push({ table, row });
      if (table === 'estimates') {
        storedEstimate = { id: 'estimate-new', status: 'draft', ...row };
        return { returning: async () => [storedEstimate] };
      }
      return Promise.resolve([row]);
    },
  });

  return {
    database: {
      transaction: async (callback) => callback(trx),
    },
    updates,
    inserts,
    getEstimate: () => storedEstimate,
  };
}

const baseBody = {
  address: '123 Palm Ave',
  customerName: 'Van Lee',
  customerPhone: '(941) 555-0101',
  customerEmail: 'van@example.com',
  leadId: 'lead-1',
  customerId: null,
  estimateData: { inputs: { address: '123 Palm Ave' }, result: { total: 125 } },
  monthlyTotal: 125,
  annualTotal: 1500,
  onetimeTotal: 0,
  waveguardTier: 'Gold',
  notes: 'Initial note',
  satelliteUrl: null,
  showOneTimeOption: false,
  billByInvoice: false,
};

describe('admin estimate persistence', () => {
  beforeEach(() => {
    clearAllEstimatePricingCache();
  });

  test('persists service_interest inferred from quoted service lines', () => {
    const fields = buildEstimatePersistenceFields({
      ...baseBody,
      serviceInterest: '',
      estimateData: {
        result: {
          recurring: {
            services: [
              { service: 'lawn_care', name: 'Lawn Care', mo: 84 },
              { service: 'pest_control', name: 'Pest Control', mo: 48.33 },
            ],
          },
        },
      },
    });

    expect(fields.service_interest).toBe('Lawn Care + Pest Control');
  });

  test('preserves full recurring annual totals when legacy annualAfterDiscount excludes add-ons', () => {
    const fields = buildEstimatePersistenceFields({
      ...baseBody,
      monthlyTotal: 0,
      annualTotal: 0,
      estimateData: {
        result: {
          recurring: {
            grandTotal: 140,
            monthlyTotal: 140,
            annualAfterDiscount: 1320,
            services: [
              { service: 'lawn_care', name: 'Lawn Care', mo: 110 },
              { service: 'rodent_bait', name: 'Rodent Bait', mo: 30 },
            ],
          },
          totals: {
            year2mo: 140,
            year2: 1680,
          },
        },
      },
    });

    const data = JSON.parse(fields.estimate_data);
    expect(fields.monthly_total).toBe(140);
    expect(fields.annual_total).toBe(1680);
    expect(data.result.totals.year2).toBe(1680);
    expect(data.result.recurring.annualAfterDiscount).toBe(1320);
  });

  test('derives full recurring annual totals from monthly total before annualAfterDiscount', () => {
    const fields = buildEstimatePersistenceFields({
      ...baseBody,
      monthlyTotal: 0,
      annualTotal: 0,
      estimateData: {
        result: {
          recurring: {
            grandTotal: 140,
            monthlyTotal: 140,
            annualAfterDiscount: 1320,
            services: [
              { service: 'lawn_care', name: 'Lawn Care', mo: 110 },
              { service: 'rodent_bait', name: 'Rodent Bait', mo: 30 },
            ],
          },
        },
      },
    });

    const data = JSON.parse(fields.estimate_data);
    expect(fields.monthly_total).toBe(140);
    expect(fields.annual_total).toBe(1680);
    expect(data.result.recurring.annualAfterDiscount).toBe(1320);
  });

  test('preserves signed one-time discounts when deriving persisted totals', () => {
    const fields = buildEstimatePersistenceFields({
      ...baseBody,
      monthlyTotal: 0,
      annualTotal: 0,
      onetimeTotal: 0,
      estimateData: {
        result: {
          oneTime: {
            total: 275,
            items: [
              { service: 'one_time_pest', name: 'One-Time Pest', price: 300 },
              { service: 'bundle_discount', name: 'Bundle Discount', price: -25 },
            ],
          },
        },
      },
    });

    const data = JSON.parse(fields.estimate_data);
    expect(fields.onetime_total).toBe(275);
    expect(data.result.oneTime.total).toBe(275);
  });

  test('preserves explicit discounted one-time totals below row sum', () => {
    const fields = buildEstimatePersistenceFields({
      ...baseBody,
      monthlyTotal: 0,
      annualTotal: 0,
      onetimeTotal: 0,
      estimateData: {
        result: {
          oneTime: {
            total: 250,
            items: [
              { service: 'one_time_pest', name: 'One-Time Pest', price: 300 },
            ],
          },
        },
      },
    });

    const data = JSON.parse(fields.estimate_data);
    expect(fields.onetime_total).toBe(250);
    expect(data.result.oneTime.total).toBe(250);
  });

  test('preserves explicit free one-time totals below row sum', () => {
    const fields = buildEstimatePersistenceFields({
      ...baseBody,
      monthlyTotal: 0,
      annualTotal: 0,
      onetimeTotal: 0,
      estimateData: {
        result: {
          oneTime: {
            total: 0,
            items: [
              { service: 'one_time_pest', name: 'One-Time Pest', price: 300 },
            ],
          },
        },
      },
    });

    const data = JSON.parse(fields.estimate_data);
    expect(fields.onetime_total).toBe(0);
    expect(data.result.oneTime.total).toBe(0);
  });

  test('falls back to top-level spec rows when one-time rows are absent', () => {
    const fields = buildEstimatePersistenceFields({
      ...baseBody,
      monthlyTotal: 0,
      annualTotal: 0,
      onetimeTotal: 425,
      estimateData: {
        result: {
          specItems: [
            { service: 'rodent_trapping', name: 'Rodent Trapping', price: 425 },
          ],
        },
      },
    });

    expect(fields.onetime_total).toBe(425);
  });

  test('excludes recurring-program spec rows from top-level one-time fallback', () => {
    const fields = buildEstimatePersistenceFields({
      ...baseBody,
      monthlyTotal: 0,
      annualTotal: 0,
      onetimeTotal: 425,
      estimateData: {
        result: {
          specItems: [
            { service: 'general_pest', name: 'General Pest', price: 99, onProg: true },
            { service: 'mosquito', name: 'Mosquito', price: 75, includedOnProgram: true },
            { service: 'rodent_trapping', name: 'Rodent Trapping', price: 425 },
          ],
        },
      },
    });

    expect(fields.onetime_total).toBe(425);
  });

  test('derives one-time total from membership fee without one-time rows', () => {
    const fields = buildEstimatePersistenceFields({
      ...baseBody,
      monthlyTotal: 0,
      annualTotal: 0,
      onetimeTotal: 0,
      estimateData: {
        result: {
          oneTime: {
            membershipFee: 49,
          },
        },
      },
    });

    expect(fields.onetime_total).toBe(49);
  });

  test('zeros persisted totals when estimate data contains quote-required lines', () => {
    const fields = buildEstimatePersistenceFields({
      ...baseBody,
      monthlyTotal: 115,
      annualTotal: 1380,
      onetimeTotal: 250,
      estimateData: {
        result: {
          quoteRequired: true,
          specItems: [
            {
              service: 'commercial_pest',
              name: 'Commercial Pest Control',
              quoteRequired: true,
              isCommercial: true,
            },
          ],
          recurring: {
            grandTotal: 115,
            services: [{ service: 'mosquito', name: 'Mosquito', mo: 115 }],
          },
        },
      },
    });

    expect(fields.monthly_total).toBe(0);
    expect(fields.annual_total).toBe(0);
    expect(fields.onetime_total).toBe(0);
    expect(fields.service_interest).toBe('Commercial Pest Control + Mosquito');
  });

  test('strips client-supplied dethatching manager approval from non-admin saves', () => {
    const fields = buildEstimatePersistenceFields({
      ...baseBody,
      estimateData: {
        inputs: {
          dethatchingManagerApproved: true,
          dethatchingManagerApprovalReason: 'verified_thatch_probe',
          dethatchingManagerApprovalTrusted: true,
        },
        result: {
          quoteRequired: true,
          quoteRequiredItems: [
            {
              service: 'dethatching',
              requiresManagerApproval: true,
              managerApprovalReason: 'st_augustine_dethatching',
              managerApprovalSatisfied: false,
              price: null,
              estimatedPrice: 166,
              quoteRequired: true,
              requiresCustomQuote: true,
              manualReviewReasons: ['st_augustine_dethatching_manager_approval_required'],
            },
          ],
          oneTime: {
            items: [
              {
                service: 'dethatching',
                requiresManagerApproval: true,
                managerApprovalReason: 'st_augustine_dethatching',
                managerApprovalSatisfied: true,
                price: 166,
                estimatedPrice: 166,
                quoteRequired: false,
                requiresCustomQuote: false,
                manualReviewReasons: [],
              },
            ],
          },
        },
      },
    }, {
      technicianId: 'tech-1',
      technician: { id: 'tech-1', role: 'technician' },
      now: () => new Date('2026-05-22T12:00:00.000Z'),
    });

    const data = JSON.parse(fields.estimate_data);
    expect(data.inputs.dethatchingManagerApproved).toBe(false);
    expect(data.inputs.dethatchingManagerApprovalTrusted).toBe(false);
    expect(data.inputs.dethatchingManagerApprovalReason).toBe('');
    expect(data.result.oneTime.items[0].managerApproved).toBe(false);
    expect(data.result.oneTime.items[0].managerApprovalSatisfied).toBe(false);
    expect(data.result.oneTime.items[0]).toEqual(expect.objectContaining({
      price: null,
      estimatedPrice: 166,
      quoteRequired: true,
      requiresCustomQuote: true,
      customQuoteReason: expect.stringMatching(/Manager approval is required/),
    }));
    expect(data.result.oneTime.items[0].manualReviewReasons).toContain('st_augustine_dethatching_manager_approval_required');
    expect(fields.monthly_total).toBe(0);
    expect(fields.annual_total).toBe(0);
    expect(fields.onetime_total).toBe(0);
  });

  test('persists trusted dethatching manager approval only for admin saves', () => {
    const fields = buildEstimatePersistenceFields({
      ...baseBody,
      estimateData: {
        inputs: {
          dethatchingManagerApproved: true,
          dethatchingManagerApprovalReason: 'verified_thatch_probe',
        },
        result: {
          quoteRequired: true,
          quoteRequiredItems: [
            {
              service: 'dethatching',
              requiresManagerApproval: true,
              managerApprovalReason: 'st_augustine_dethatching',
              managerApprovalSatisfied: false,
              price: null,
              estimatedPrice: 166,
              quoteRequired: true,
              requiresCustomQuote: true,
              manualReviewReasons: ['st_augustine_dethatching_manager_approval_required'],
            },
          ],
          oneTime: {
            items: [
              {
                service: 'dethatching',
                requiresManagerApproval: true,
                managerApprovalReason: 'st_augustine_dethatching',
                managerApprovalSatisfied: false,
                price: null,
                estimatedPrice: 166,
                quoteRequired: true,
                requiresCustomQuote: true,
                manualReviewReasons: ['st_augustine_dethatching_manager_approval_required'],
                customQuoteReason: 'Manager approval is required before St. Augustine / Floratam dethatching can be quoted.',
              },
            ],
          },
        },
      },
    }, {
      technicianId: 'admin-1',
      technician: { id: 'admin-1', role: 'admin' },
      now: () => new Date('2026-05-22T12:00:00.000Z'),
    });

    const data = JSON.parse(fields.estimate_data);
    expect(data.inputs).toEqual(expect.objectContaining({
      dethatchingManagerApproved: true,
      dethatchingManagerApprovalTrusted: true,
      dethatchingManagerApprovalReason: 'verified_thatch_probe',
      dethatchingManagerApprovedBy: 'admin-1',
      dethatchingManagerApprovedByRole: 'admin',
      dethatchingManagerApprovedAt: '2026-05-22T12:00:00.000Z',
    }));
    expect(data.result.oneTime.items[0]).toEqual(expect.objectContaining({
      managerApproved: true,
      managerApprovalSatisfied: true,
      managerApprovalOverrideReason: 'verified_thatch_probe',
      managerApprovalApprovedBy: 'admin-1',
      price: 166,
      estimatedPrice: 166,
      quoteRequired: false,
      requiresCustomQuote: false,
      customQuoteReason: null,
    }));
    expect(data.result.oneTime.items[0].manualReviewReasons).toEqual([]);
    expect(data.result.quoteRequired).toBe(false);
    expect(data.result.quoteRequiredItems).toEqual([]);
    expect(fields.monthly_total).toBe(baseBody.monthlyTotal);
  });

  test('trusted dethatching approval does not turn missing prices into zero-dollar quotes', () => {
    const fields = buildEstimatePersistenceFields({
      ...baseBody,
      estimateData: {
        inputs: {
          dethatchingManagerApproved: true,
          dethatchingManagerApprovalReason: 'verified_thatch_probe',
        },
        result: {
          oneTime: {
            items: [
              {
                service: 'dethatching',
                requiresManagerApproval: true,
                managerApprovalReason: 'st_augustine_dethatching',
                managerApprovalSatisfied: false,
                price: null,
                quoteRequired: true,
                requiresCustomQuote: true,
                manualReviewReasons: ['st_augustine_dethatching_manager_approval_required'],
              },
            ],
          },
        },
      },
    }, {
      technicianId: 'admin-1',
      technician: { id: 'admin-1', role: 'admin' },
      now: () => new Date('2026-05-22T12:00:00.000Z'),
    });

    const data = JSON.parse(fields.estimate_data);
    expect(data.result.oneTime.items[0]).toEqual(expect.objectContaining({
      price: null,
      quoteRequired: true,
      requiresCustomQuote: true,
      managerApprovalSatisfied: true,
    }));
    expect(data.result.oneTime.items[0].estimatedPrice).toBeUndefined();
    expect(data.result.oneTime.items[0].manualReviewReasons).toContain('dethatching_price_not_recorded');
    expect(fields.monthly_total).toBe(0);
    expect(fields.annual_total).toBe(0);
    expect(fields.onetime_total).toBe(0);
  });

  test('recomputes one-time total when trusted approval clears server-mapped dethatching quote', () => {
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
    expect(mappedSpec.price).toBeNull();
    expect(mappedSpec.estimatedPrice).toBeGreaterThan(0);
    mapped.oneTime.items.push({
      service: 'one_time_pest',
      name: 'One-Time Pest',
      price: 200,
    });
    mapped.oneTime.total = 200;
    mapped.oneTime.otSubtotal = 200;
    const approvedOneTimeTotal = 200 + mappedSpec.estimatedPrice;

    const fields = buildEstimatePersistenceFields({
      ...baseBody,
      monthlyTotal: 0,
      annualTotal: 0,
      onetimeTotal: 0,
      estimateData: {
        inputs: {
          svcDethatch: true,
          grassType: 'st_augustine',
          dethatchingManagerApproved: true,
          dethatchingManagerApprovalReason: 'verified_thatch_probe',
        },
        result: mapped,
      },
    }, {
      technicianId: 'admin-1',
      technician: { id: 'admin-1', role: 'admin' },
      now: () => new Date('2026-05-22T12:00:00.000Z'),
    });

    const data = JSON.parse(fields.estimate_data);
    const normalizedSpec = data.result.oneTime.specItems.find((item) => item.service === 'dethatching');
    expect(normalizedSpec).toEqual(expect.objectContaining({
      price: mappedSpec.estimatedPrice,
      estimatedPrice: mappedSpec.estimatedPrice,
      quoteRequired: false,
      requiresCustomQuote: false,
    }));
    expect(data.result.quoteRequired).toBe(false);
    expect(data.result.quoteRequiredItems).toEqual([]);
    expect(data.result.oneTime.total).toBe(approvedOneTimeTotal);
    expect(data.result.oneTime.otSubtotal).toBe(approvedOneTimeTotal);
    expect(fields.monthly_total).toBe(0);
    expect(fields.annual_total).toBe(0);
    expect(fields.onetime_total).toBe(approvedOneTimeTotal);
  });

  test('trusted dethatching approval rejects malformed price fields before clearing quote-required', () => {
    const fields = buildEstimatePersistenceFields({
      ...baseBody,
      estimateData: {
        inputs: {
          dethatchingManagerApproved: true,
          dethatchingManagerApprovalReason: 'verified_thatch_probe',
        },
        result: {
          oneTime: {
            items: [
              {
                service: 'dethatching',
                requiresManagerApproval: true,
                managerApprovalReason: 'st_augustine_dethatching',
                managerApprovalSatisfied: false,
                price: null,
                estimatedPrice: [],
                baseEstimatePrice: true,
                quoteRequired: true,
                requiresCustomQuote: true,
                manualReviewReasons: ['st_augustine_dethatching_manager_approval_required'],
              },
            ],
          },
        },
      },
    }, {
      technicianId: 'admin-1',
      technician: { id: 'admin-1', role: 'admin' },
      now: () => new Date('2026-05-22T12:00:00.000Z'),
    });

    const data = JSON.parse(fields.estimate_data);
    expect(data.result.oneTime.items[0]).toEqual(expect.objectContaining({
      price: null,
      quoteRequired: true,
      requiresCustomQuote: true,
      managerApprovalSatisfied: true,
    }));
    expect(data.result.oneTime.items[0].estimatedPrice).toEqual([]);
    expect(data.result.oneTime.items[0].baseEstimatePrice).toBe(true);
    expect(data.result.oneTime.items[0].manualReviewReasons).toContain('dethatching_price_not_recorded');
    expect(fields.monthly_total).toBe(0);
    expect(fields.annual_total).toBe(0);
    expect(fields.onetime_total).toBe(0);
  });

  test('rejects invalid admin manager approval reasons during persistence normalization', () => {
    const fields = buildEstimatePersistenceFields({
      ...baseBody,
      estimateData: {
        inputs: {
          dethatchingManagerApproved: true,
          dethatchingManagerApprovalReason: 'anything truthy',
        },
        result: {
          oneTime: {
            items: [
              {
                service: 'dethatching',
                requiresManagerApproval: true,
                managerApprovalReason: 'st_augustine_dethatching',
                managerApprovalSatisfied: false,
                price: null,
                estimatedPrice: 166,
                quoteRequired: true,
                requiresCustomQuote: true,
                manualReviewReasons: ['st_augustine_dethatching_manager_approval_required'],
              },
            ],
          },
        },
      },
    }, {
      technicianId: 'admin-1',
      technician: { id: 'admin-1', role: 'admin' },
      now: () => new Date('2026-05-22T12:00:00.000Z'),
    });

    const data = JSON.parse(fields.estimate_data);
    expect(data.inputs.dethatchingManagerApproved).toBe(false);
    expect(data.inputs.dethatchingManagerApprovalTrusted).toBe(false);
    expect(data.inputs.dethatchingManagerApprovalReason).toBe('');
    expect(data.result.oneTime.items[0]).toEqual(expect.objectContaining({
      price: null,
      estimatedPrice: 166,
      quoteRequired: true,
      requiresCustomQuote: true,
      managerApprovalSatisfied: false,
    }));
    expect(data.result.oneTime.items[0].manualReviewReasons).toContain('st_augustine_dethatching_manager_approval_required');
    expect(fields.monthly_total).toBe(0);
    expect(fields.annual_total).toBe(0);
    expect(fields.onetime_total).toBe(0);
  });

  test('reuses an existing lead-linked draft instead of creating a second estimate', async () => {
    const now = () => new Date('2026-05-15T12:00:00.000Z');
    const { database, updates, inserts } = makeDatabase({
      lead: {
        id: 'lead-1',
        status: 'new',
        phone: '9415550101',
        estimate_id: 'estimate-draft',
      },
      estimate: {
        id: 'estimate-draft',
        status: 'draft',
        token: 'existing-token',
        customer_phone: '(941) 555-0101',
      },
    });
    setEstimatePricingCache('estimate-draft', { frequencies: [{ monthly: 99 }] });
    expect(getEstimatePricingCache('estimate-draft')).toEqual({ frequencies: [{ monthly: 99 }] });

    const result = await createOrReuseAdminEstimate({
      database,
      body: { ...baseBody, address: '456 Revised St', monthlyTotal: 145 },
      technicianId: 'tech-1',
      now,
    });

    expect(result).toMatchObject({
      reused: true,
      estimate: {
        id: 'estimate-draft',
        token: 'existing-token',
        address: '456 Revised St',
        monthly_total: 145,
      },
    });
    expect(inserts).toEqual([]);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      table: 'estimates',
      clause: { id: 'estimate-draft', status: 'draft' },
      patch: {
        address: '456 Revised St',
        monthly_total: 145,
        updated_at: now(),
      },
    });
    expect(updates[0].patch.expires_at.toISOString()).toBe('2026-05-22T12:00:00.000Z');
    expect(estimateViewUrl(result.estimate.token)).toBe('https://portal.wavespestcontrol.com/estimate/existing-token');
    expect(getEstimatePricingCache('estimate-draft')).toBeNull();
  });

  test('creates a new estimate when the lead-linked prior estimate is archived', async () => {
    const now = () => new Date('2026-05-15T12:00:00.000Z');
    const { database, updates, inserts } = makeDatabase({
      lead: {
        id: 'lead-1',
        status: 'estimate_sent',
        phone: '9415550101',
        estimate_id: 'estimate-old',
      },
      estimate: {
        id: 'estimate-old',
        status: 'sent',
        archived_at: '2026-05-14T15:00:00.000Z',
        customer_phone: '(941) 555-0101',
      },
    });

    const result = await createOrReuseAdminEstimate({
      database,
      body: { ...baseBody, monthlyTotal: 155 },
      technicianId: 'tech-1',
      technician: { first_name: 'Ava', last_name: 'Tech' },
      now,
      randomBytes: () => Buffer.from('1234567890abcdef1234567890abcdef', 'hex'),
    });

    expect(result.reused).toBe(false);
    expect(result.estimate).toMatchObject({
      id: 'estimate-new',
      customer_phone: '(941) 555-0101',
      monthly_total: 155,
    });
    expect(inserts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        table: 'estimates',
        row: expect.objectContaining({ token: '1234567890abcdef1234567890abcdef' }),
      }),
      expect.objectContaining({
        table: 'lead_activities',
        row: expect.objectContaining({
          lead_id: 'lead-1',
          activity_type: 'estimate_created',
        }),
      }),
    ]));
    expect(updates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        table: 'leads',
        clause: { id: 'lead-1' },
        patch: expect.objectContaining({ estimate_id: 'estimate-new' }),
      }),
    ]));
  });

  test('rejects a new estimate when the linked prior estimate is still active', async () => {
    const { database, updates, inserts } = makeDatabase({
      lead: {
        id: 'lead-1',
        status: 'estimate_sent',
        phone: '9415550101',
        estimate_id: 'estimate-active',
      },
      estimate: {
        id: 'estimate-active',
        status: 'sent',
        archived_at: null,
        customer_phone: '(941) 555-0101',
      },
    });

    await expect(createOrReuseAdminEstimate({
      database,
      body: baseBody,
      technicianId: 'tech-1',
      now: () => new Date('2026-05-15T12:00:00.000Z'),
    })).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining('Archive or delete'),
    });

    expect(updates).toEqual([]);
    expect(inserts).toEqual([]);
  });

  test('rejects a reused draft when the current lead contact no longer matches', async () => {
    const { database, updates, inserts } = makeDatabase({
      lead: {
        id: 'lead-1',
        status: 'new',
        phone: '9415550101',
        email: 'van@example.com',
        estimate_id: 'estimate-draft',
      },
      estimate: {
        id: 'estimate-draft',
        status: 'draft',
        token: 'existing-token',
      },
    });

    await expect(createOrReuseAdminEstimate({
      database,
      body: {
        ...baseBody,
        customerPhone: '941-555-9999',
        customerEmail: 'other@example.com',
      },
      technicianId: 'tech-1',
      now: () => new Date('2026-05-15T12:00:00.000Z'),
    })).rejects.toMatchObject({ statusCode: 409 });

    expect(updates).toEqual([]);
    expect(inserts).toEqual([]);
  });

  test('rejects a one-time choice on a mixed recurring-service estimate', async () => {
    const { database, updates, inserts } = makeDatabase({
      lead: {
        id: 'lead-1',
        status: 'new',
        phone: '9415550101',
        estimate_id: null,
      },
    });

    await expect(createOrReuseAdminEstimate({
      database,
      body: {
        ...baseBody,
        showOneTimeOption: true,
        onetimeTotal: 250,
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
      },
      technicianId: 'tech-1',
      now: () => new Date('2026-05-15T12:00:00.000Z'),
    })).rejects.toMatchObject({ statusCode: 400 });

    expect(updates).toEqual([]);
    expect(inserts).toEqual([]);
  });

  test('does not overwrite a draft that changed status during reuse', async () => {
    const { database, updates } = makeDatabase({
      emptyEstimateUpdate: true,
      lead: {
        id: 'lead-1',
        status: 'new',
        phone: '9415550101',
        estimate_id: 'estimate-draft',
      },
      estimate: {
        id: 'estimate-draft',
        status: 'draft',
        token: 'existing-token',
        customer_phone: '(941) 555-0101',
      },
    });

    await expect(createOrReuseAdminEstimate({
      database,
      body: baseBody,
      technicianId: 'tech-1',
      now: () => new Date('2026-05-15T12:00:00.000Z'),
    })).rejects.toMatchObject({ statusCode: 409 });

    expect(updates).toHaveLength(1);
    expect(updates[0].clause).toEqual({ id: 'estimate-draft', status: 'draft' });
  });
});
