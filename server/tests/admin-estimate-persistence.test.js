jest.mock('../models/db', () => jest.fn());
// Mutable pricing-authority send gate (#3750): off by default, flipped by
// the scheduled-group-on-create tests below.
const mockGateState = { sendRequiresServerPricing: false };
jest.mock('../config/feature-gates', () => {
  const actual = jest.requireActual('../config/feature-gates');
  return {
    ...actual,
    isEnabled: (key) => (key === 'sendRequiresServerPricing' ? mockGateState.sendRequiresServerPricing : actual.isEnabled(key)),
  };
});
// Pass-through mock: every test keeps the real qualifying-services lookup;
// the lookup-failure test below overrides it once.
jest.mock('../services/waveguard-existing-services', () => {
  const actual = jest.requireActual('../services/waveguard-existing-services');
  return { ...actual, loadExistingQualifyingServiceKeys: jest.fn(actual.loadExistingQualifyingServiceKeys) };
});
const mockQualifyingLookup = require('../services/waveguard-existing-services').loadExistingQualifyingServiceKeys;
const actualQualifyingLookup = jest.requireActual('../services/waveguard-existing-services').loadExistingQualifyingServiceKeys;

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

function makeDatabase({ lead, estimate, customer = null, emptyEstimateUpdate = false, scheduledGroupMember = null }) {
  const updates = [];
  const inserts = [];
  let storedEstimate = estimate;

  const trx = (table) => ({
    // The setup-waiver evidence read is UNGATED since codex #3591 r73 P1
    // (planGate: false): it reaches the live rows even for a non-member
    // customer, so the fake serves an empty account (a real lookup failure
    // 503s the save by design). leftJoin serves the canonical catalog join
    // the waiver read runs regardless of the auto-tier gate (r79 P1).
    columnInfo: async () => ({ is_recurring: {} }),
    whereNotIn() { return this; },
    leftJoin() { return this; },
    select: async () => [],
    where(clause) {
      return {
        forUpdate() {
          return this;
        },
        whereNull() {
          return this;
        },
        where() {
          return this;
        },
        whereNotIn() {
          return this;
        },
        whereNot() {
          return this;
        },
        select: async () => [],
        first: async () => {
          // The scheduled-group guard's member lookups (#3750).
          if (table === 'estimates' && clause.estimate_group_id && clause.status === 'scheduled') return scheduledGroupMember;
          if (table === 'estimates' && clause.estimate_group_id && clause.status === 'sending') return null;
          if (table === 'leads' && clause.id === lead?.id) return lead;
          if (table === 'estimates' && clause.id === storedEstimate?.id) return storedEstimate;
          if (table === 'customers' && customer && clause.id === customer.id) return customer;
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
      // Upsert chain used by the learning-loop baseline capture; `then`
      // keeps plain awaited inserts working for other tables.
      const chain = {
        onConflict: () => chain,
        ignore: () => chain,
        returning: async () => [{ id: 'row-1' }],
        then: (resolve) => resolve([row]),
      };
      return chain;
    },
  });
  trx.fn = { now: () => 'NOW' };
  trx.raw = (sql) => sql;

  return {
    // Mirror real knex: callable as db(table) for direct reads (customer /
    // qualifying-services lookups) AND carrying .transaction for the write path.
    database: Object.assign((table) => trx(table), {
      transaction: async (callback) => callback(trx),
    }),
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
  test('a repeated create keeps the same draft and never rewrites it', async () => {
    const fixture = makeDatabase({});
    const body = { ...baseBody, leadId: null, clientDraftId: '01234567-89ab-4cde-8fab-0123456789ab' };
    const create = () => createOrReuseAdminEstimate({ database: fixture.database, body,
      technicianId: 'qa-admin', recompute: async () => ({ recomputed: false, reason: 'NO_INPUTS' }),
    });
    const first = await create();
    const retry = await create();
    expect(first.estimate.id).toBe(body.clientDraftId);
    expect(retry).toMatchObject({ reused: true, estimate: { id: first.estimate.id } });
    expect(fixture.inserts.filter((entry) => entry.table === 'estimates')).toHaveLength(1);
    expect(fixture.updates).toHaveLength(0);
  });

  test('a retried draft identity cannot overwrite a different form', async () => {
    const fixture = makeDatabase({});
    const body = { ...baseBody, leadId: null, clientDraftId: '01234567-89ab-4cde-8fab-0123456789ab' };
    const args = { database: fixture.database, body, technicianId: 'qa-admin', recompute: async () => ({ recomputed: false, reason: 'NO_INPUTS' }) };
    await createOrReuseAdminEstimate(args);
    await expect(createOrReuseAdminEstimate({ ...args, body: { ...body,
      estimateData: { ...body.estimateData, inputs: { address: 'A different synthetic property' } },
    } })).rejects.toMatchObject({ statusCode: 409 });
    expect(fixture.updates).toHaveLength(0);
  });

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

  test('pricing_version stamps only on SERVER authority - fallback rows keep the column default', () => {
    // On CLIENT_FALLBACK the estimateData blob is still the caller-supplied
    // payload; a stale engineVersion riding it (e.g. from an earlier server
    // price) must not claim the column (Codex #2667 r5).
    const bodyWithVersion = {
      ...baseBody,
      estimateData: {
        inputs: { address: '123 Palm Ave' },
        result: { engineVersion: 'LAWN_PRICING_V2_DENSE_35_FLOOR', total: 125 },
      },
    };
    const stamped = buildEstimatePersistenceFields(bodyWithVersion, { pricingAuthority: 'SERVER' });
    expect(stamped.pricing_version).toBe('LAWN_PRICING_V2_DENSE_35_FLOOR');
    // Non-SERVER writes RESET to the column default (updates spread these
    // fields over the existing row - omitting would preserve a stale stamp
    // from an earlier server-priced save).
    const fallback = buildEstimatePersistenceFields(bodyWithVersion, { pricingAuthority: 'CLIENT_FALLBACK' });
    expect(fallback.pricing_version).toBe('v4.2');
    const noAuthority = buildEstimatePersistenceFields(bodyWithVersion, {});
    expect(noAuthority.pricing_version).toBe('v4.2');
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

  test('reusing a lead-linked AI draft captures its baseline in the same transaction', async () => {
    // The builder wholesale-replaces the AI composition while `source`
    // survives (not part of the write payload) — without the capture the
    // later send would read this maximal rewrite as sent-unedited.
    const now = () => new Date('2026-05-15T12:00:00.000Z');
    const { database, inserts } = makeDatabase({
      lead: {
        id: 'lead-1',
        status: 'new',
        phone: '9415550101',
        estimate_id: 'estimate-draft',
      },
      estimate: {
        id: 'estimate-draft',
        status: 'draft',
        source: 'estimator_engine',
        token: 'existing-token',
        monthly_total: 99,
        estimate_data: JSON.stringify({ engineInputs: { services: { pest: {} } } }),
      },
    });

    const result = await createOrReuseAdminEstimate({
      database,
      body: { ...baseBody },
      technicianId: 'tech-1',
      now,
    });

    expect(result.reused).toBe(true);
    const capture = inserts.find((entry) => entry.table === 'estimate_draft_baselines');
    expect(capture).toBeTruthy();
    expect(capture.row.estimate_id).toBe('estimate-draft');
    expect(capture.row.source).toBe('estimator_engine');
    expect(JSON.parse(capture.row.baseline_fields).monthly_total).toBe(99);
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

  test('P1-2: forged priorQualifyingServices/recurringCustomer are stripped from the STORED engineInputs (no replay restore)', async () => {
    const now = () => new Date('2026-05-15T12:00:00.000Z');
    const { database, inserts } = makeDatabase({
      lead: { id: 'lead-1', status: 'new', phone: '9415550101' },
    });

    await createOrReuseAdminEstimate({
      database,
      body: {
        ...baseBody,
        customerId: null, // a lead → server-derived priors are empty
        // A forged blob claiming existing-customer priors + the recurring perk.
        estimateData: {
          engineInputs: {
            homeSqFt: 2000, lotSqFt: 10000, services: { mosquito: { tier: 'monthly12' } },
            priorQualifyingServices: ['pest_control', 'lawn_care', 'tree_shrub'],
            recurringCustomer: true,
            isRecurringCustomer: true,
          },
          result: { total: 125 },
        },
      },
      technicianId: 'tech-1',
      now,
      randomBytes: () => Buffer.from('1234567890abcdef1234567890abcdef', 'hex'),
    });

    const estimateInsert = inserts.find((e) => e.table === 'estimates');
    expect(estimateInsert).toBeTruthy();
    const stored = JSON.parse(estimateInsert.row.estimate_data);
    // extractEngineInputs replays from engineInputs on the public reprice — the
    // forged identity fields must be gone so accept/charge can't restore them.
    expect(stored.engineInputs.priorQualifyingServices).toBeUndefined();
    expect(stored.engineInputs.recurringCustomer).toBeUndefined();
    expect(stored.engineInputs.isRecurringCustomer).toBeUndefined();
    // And no forged top-level combined-tier value survives for a non-member.
    expect(stored.priorQualifyingServices).toBeUndefined();
  });

  test('a linked customer whose qualifying-services lookup FAILS refuses the save retryably (503) — never read as a non-member (codex #3591 r31 P1)', async () => {
    const now = () => new Date('2026-05-15T12:00:00.000Z');
    const { database, inserts } = makeDatabase({
      lead: { id: 'lead-1', status: 'new', phone: '9415550101' },
      customer: { id: 'cust-member', active: true, waveguard_tier: 'Silver' },
    });
    mockQualifyingLookup.mockRejectedValueOnce(new Error('db down'));
    await expect(createOrReuseAdminEstimate({
      database,
      body: {
        ...baseBody,
        customerId: 'cust-member',
        estimateData: {
          engineInputs: { homeSqFt: 2000, lotSqFt: 10000, services: { rodentBait: {} } },
          inputs: { homeSqFt: 2000 },
          result: { total: 89 },
        },
      },
      technicianId: 'tech-1',
      now,
      randomBytes: () => Buffer.from('1234567890abcdef1234567890abcdef', 'hex'),
    })).rejects.toMatchObject({ statusCode: 503 });
    expect(inserts.filter((i) => i.table === 'estimates')).toHaveLength(0);
  });

  test('a SECONDARY-property rodent add-on for a member: tier evidence is property-scoped, the setup waiver is account-wide (codex #3591 r34 P1)', async () => {
    const now = () => new Date('2026-05-15T12:00:00.000Z');
    const { database, inserts } = makeDatabase({
      lead: { id: 'lead-1', status: 'new', phone: '9415550101' },
      customer: { id: 'cust-member', active: true, waveguard_tier: 'Silver', address_line1: '100 Main St', city: 'Parrish', zip: '34219' },
    });
    // Account-wide: a pest plan somewhere on the account. Property-scoped
    // (streetScope passed): nothing active at the quoted property. Call
    // history cleared so the index assertions below read THIS save's calls.
    mockQualifyingLookup.mockClear();
    mockQualifyingLookup.mockImplementation(async (_db, _id, opts) => (opts?.streetScope ? [] : ['pest_control']));

    await createOrReuseAdminEstimate({
      database,
      body: {
        ...baseBody,
        customerId: 'cust-member',
        // A NON-primary street on the same account (the primary is 100 Main
        // St) — the per-property rule scopes the tier to this property.
        address: '12 Second St, Parrish, FL 34219',
        estimateData: {
          engineInputs: { homeSqFt: 2000, lotSqFt: 8000, services: { rodentBait: { frequency: 'quarterly' } } },
          inputs: { homeSqFt: 2000 },
          result: { total: 89 },
        },
      },
      technicianId: 'tech-1',
      now,
      randomBytes: () => Buffer.from('1234567890abcdef1234567890abcdef', 'hex'),
    });

    const estimateInsert = inserts.find((e) => e.table === 'estimates');
    const stored = JSON.parse(estimateInsert.row.estimate_data);
    // The first lookup is the account-wide one — waiver evidence, UNGATED
    // by the membership stamp (codex #3591 r73 P1: the owner's waiver rule
    // is qualifying families, not plan membership); the second is the
    // street-scoped one — tier evidence, which keeps the plan gate.
    expect(mockQualifyingLookup.mock.calls[0][1]).toBe('cust-member');
    expect(mockQualifyingLookup.mock.calls[0][2]).toEqual({ planGate: false, strict: true });
    expect(mockQualifyingLookup.mock.calls[1][2]).toMatchObject({ streetScope: expect.objectContaining({ estimateStreet: expect.any(String) }) });
    // Persisted for replay: the account-wide waiver list; NO property tier
    // list (nothing qualifies at this property → standalone tier).
    expect(stored.setupWaiverPriorQualifyingServices).toEqual(['pest_control']);
    expect(stored.priorQualifyingServices).toBeUndefined();
    // …and the engine honored it: no $99 setup row for a member.
    const setupRow = (stored.result?.specItems || []).find((it) => it.service === 'rodent_bait_setup');
    expect(setupRow).toBeUndefined();
    // The replay shapes never carry a client-claimable copy.
    expect(stored.engineInputs.setupWaiverPriorQualifyingServices).toBeUndefined();
    mockQualifyingLookup.mockImplementation(actualQualifyingLookup);
  });

  test('P1-2: a verified active-plan member with NO qualifying priors keeps recurring status on the STORED replay', async () => {
    const now = () => new Date('2026-05-15T12:00:00.000Z');
    const { database, inserts } = makeDatabase({
      lead: { id: 'lead-1', status: 'new', phone: '9415550101' },
      // Active WaveGuard member (Silver tier) — but their plan services aren't
      // WaveGuard-qualifying, so loadExistingQualifyingServiceKeys returns [].
      customer: { id: 'cust-member', active: true, waveguard_tier: 'Silver' },
    });
    // The fake database cannot serve the real lookup (it used to throw and be
    // swallowed as []); a failed lookup now refuses the save, so model the
    // documented "no qualifying priors" result explicitly.
    mockQualifyingLookup.mockResolvedValueOnce([]);

    await createOrReuseAdminEstimate({
      database,
      body: {
        ...baseBody,
        customerId: 'cust-member',
        estimateData: {
          engineInputs: { homeSqFt: 2000, lotSqFt: 10000, services: { oneTimePest: {} } },
          inputs: { homeSqFt: 2000, isRecurringCustomer: 'NO' },
          result: { total: 125 },
        },
      },
      technicianId: 'tech-1',
      now,
      randomBytes: () => Buffer.from('1234567890abcdef1234567890abcdef', 'hex'),
    });

    const estimateInsert = inserts.find((e) => e.table === 'estimates');
    const stored = JSON.parse(estimateInsert.row.estimate_data);
    // The server-verified recurring status is persisted so the public reprice
    // (extractEngineInputs → base engineInputs) reapplies the member perk even
    // though priorQualifyingServices is empty for this member.
    expect(stored.engineInputs.recurringCustomer).toBe(true);
    // The builder form snapshot gets the STRING toggle value edit mode seeds
    // from — a reopened member estimate must not show "NO" and price previews
    // as a non-member (even a client-claimed "NO" yields to the server check).
    expect(stored.inputs.isRecurringCustomer).toBe('YES');
    expect(stored.inputs.recurringCustomer).toBe(true);
  });

  test('P1-2: an authoritative admin reprice clears a stale membershipLapsedRequote flag', async () => {
    const now = () => new Date('2026-05-15T12:00:00.000Z');
    const { database, inserts } = makeDatabase({
      lead: { id: 'lead-1', status: 'new', phone: '9415550101' },
    });

    await createOrReuseAdminEstimate({
      database,
      body: {
        ...baseBody,
        estimateData: {
          engineInputs: { homeSqFt: 2000, lotSqFt: 10000, services: { oneTimePest: {} } },
          result: { total: 125 },
          // Left behind by a failed lapse reconcile that later persisted —
          // an authoritative save must supersede it or the estimate stays
          // permanently quote-required.
          membershipLapsedRequote: true,
        },
      },
      technicianId: 'tech-1',
      now,
      randomBytes: () => Buffer.from('1234567890abcdef1234567890abcdef', 'hex'),
    });

    const stored = JSON.parse(inserts.find((e) => e.table === 'estimates').row.estimate_data);
    expect(stored.membershipLapsedRequote).toBeUndefined();
  });

  test('P1-2: a NON-member does not gain a recurring flag in the stored engineInputs', async () => {
    const now = () => new Date('2026-05-15T12:00:00.000Z');
    const { database, inserts } = makeDatabase({
      lead: { id: 'lead-1', status: 'new', phone: '9415550101' },
      customer: { id: 'cust-lead', active: true, waveguard_tier: null, monthly_rate: 0 }, // no plan → not a member
    });

    await createOrReuseAdminEstimate({
      database,
      body: {
        ...baseBody,
        customerId: 'cust-lead',
        estimateData: {
          engineInputs: { homeSqFt: 2000, lotSqFt: 10000, services: { oneTimePest: {} }, recurringCustomer: true },
          result: { total: 125 },
        },
      },
      technicianId: 'tech-1',
      now,
      randomBytes: () => Buffer.from('1234567890abcdef1234567890abcdef', 'hex'),
    });

    const stored = JSON.parse(inserts.find((e) => e.table === 'estimates').row.estimate_data);
    // The forged client recurringCustomer was stripped and NOT re-added for a
    // non-member — no perk survives to replay.
    expect(stored.engineInputs.recurringCustomer).toBeUndefined();
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

describe('createOrReuseAdminEstimate — a linked COMMERCIAL PROPOSAL draft is never reused by the generic save (GH codex P2 r6 on #3750)', () => {
  test('refuses (409) instead of stripping the server-owned proposal and clobbering its totals', async () => {
    const now = () => new Date('2026-05-15T12:00:00.000Z');
    const { database, updates, inserts } = makeDatabase({
      lead: { id: 'lead-1', status: 'new', phone: '9415550101', estimate_id: 'estimate-proposal' },
      estimate: {
        id: 'estimate-proposal',
        status: 'draft',
        token: 'existing-token',
        category: 'COMMERCIAL',
        customer_phone: '(941) 555-0101',
        estimate_data: JSON.stringify({ proposal: { enabled: true, buildings: [{ name: 'Tower A', lineItems: [{ description: 'Interior', amount: 240 }] }] } }),
      },
    });
    await expect(createOrReuseAdminEstimate({
      database,
      body: { ...baseBody, address: '456 Revised St', monthlyTotal: 145 },
      technicianId: 'tech-1',
      now,
    })).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/Commercial proposal editor/i) });
    expect(inserts).toEqual([]);
    expect(updates.filter((u) => u.table === 'estimates')).toEqual([]);
  });
});

describe('createOrReuseAdminEstimate — a DISABLED authored proposal draft is protected too (pre-push codex P0)', () => {
  const { linkedDraftCarriesProposal } = require('../services/admin-estimate-persistence');

  test('the guard keys on any stored proposal object (not only enabled/scaffold) — never on the COMMERCIAL category alone', () => {
    // An engine / Agent Estimate commercial draft carries the category but
    // no proposal and must stay reusable (GH codex P2 r9).
    expect(linkedDraftCarriesProposal({ category: 'COMMERCIAL', estimate_data: '{}' })).toBe(false);
    expect(linkedDraftCarriesProposal({ category: 'RESIDENTIAL', estimate_data: JSON.stringify({ proposal: { enabled: false, buildings: [] } }) })).toBe(true);
    expect(linkedDraftCarriesProposal({ category: 'RESIDENTIAL', estimate_data: { proposal: { scaffold: true } } })).toBe(true);
    expect(linkedDraftCarriesProposal({ category: 'RESIDENTIAL', estimate_data: '{}' })).toBe(false);
    expect(linkedDraftCarriesProposal({ category: null, estimate_data: 'not json' })).toBe(false);
  });

  test('a linked draft whose authored proposal was saved disabled is refused (409) instead of overwritten', async () => {
    const now = () => new Date('2026-05-15T12:00:00.000Z');
    const { database, updates, inserts } = makeDatabase({
      lead: { id: 'lead-1', status: 'new', phone: '9415550101', estimate_id: 'estimate-proposal' },
      estimate: {
        id: 'estimate-proposal',
        status: 'draft',
        token: 'existing-token',
        category: 'COMMERCIAL',
        customer_phone: '(941) 555-0101',
        estimate_data: JSON.stringify({ proposal: { enabled: false, buildings: [{ name: 'Tower A', lineItems: [{ description: 'Interior', amount: 240 }] }] } }),
      },
    });
    await expect(createOrReuseAdminEstimate({
      database,
      body: { ...baseBody, address: '456 Revised St', monthlyTotal: 145 },
      technicianId: 'tech-1',
      now,
    })).rejects.toMatchObject({ statusCode: 409 });
    expect(inserts).toEqual([]);
    expect(updates.filter((u) => u.table === 'estimates')).toEqual([]);
  });
});

describe('createOrReuseAdminEstimate — a NEW property joining a SCHEDULED group is judged like a revision moving into it (uncapped codex P1 r13 on #3750)', () => {
  const engineError = async () => ({ recomputed: false, reason: 'ENGINE_ERROR', error: new Error('engine down') });
  const GROUP = '2f5e7a10-6c3b-4d9e-9a11-3b7c5d2e8f01';
  afterEach(() => { mockGateState.sendRequiresServerPricing = false; });

  test('gate on: a fallback-priced property cannot be created into a group whose anchor is scheduled — nothing inserted', async () => {
    mockGateState.sendRequiresServerPricing = true;
    const { database, inserts } = makeDatabase({ lead: null, estimate: null, scheduledGroupMember: { id: 'est-anchor' } });
    await expect(createOrReuseAdminEstimate({
      database,
      body: { ...baseBody, estimateGroupId: GROUP },
      technicianId: 'tech-1',
      recompute: engineError,
      now: () => new Date('2026-05-15T12:00:00.000Z'),
    })).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/group it would join is scheduled to send/i) });
    expect(inserts).toEqual([]);
  });

  test('controls: no scheduled member, or gate off, keeps the fail-open create', async () => {
    mockGateState.sendRequiresServerPricing = true;
    const open = makeDatabase({ lead: { id: 'lead-1', status: 'new', phone: '9415550101' }, estimate: null, scheduledGroupMember: null });
    await createOrReuseAdminEstimate({
      database: open.database, body: { ...baseBody, estimateGroupId: GROUP }, technicianId: 'tech-1', recompute: engineError, now: () => new Date('2026-05-15T12:00:00.000Z'),
    });
    expect(open.inserts.filter((i) => i.table === 'estimates')).toHaveLength(1);
    mockGateState.sendRequiresServerPricing = false;
    const gateOff = makeDatabase({ lead: { id: 'lead-1', status: 'new', phone: '9415550101' }, estimate: null, scheduledGroupMember: { id: 'est-anchor' } });
    await createOrReuseAdminEstimate({
      database: gateOff.database, body: { ...baseBody, estimateGroupId: GROUP }, technicianId: 'tech-1', recompute: engineError, now: () => new Date('2026-05-15T12:00:00.000Z'),
    });
    expect(gateOff.inserts.filter((i) => i.table === 'estimates')).toHaveLength(1);
  });
});

describe('createOrReuseAdminEstimate — reusing a lead\'s GROUPED draft is judged like a revision of it (pre-push codex P1 r18 on #3750)', () => {
  const engineError = async () => ({ recomputed: false, reason: 'ENGINE_ERROR', error: new Error('engine down') });
  const GROUP = '2f5e7a10-6c3b-4d9e-9a11-3b7c5d2e8f01';
  afterEach(() => { mockGateState.sendRequiresServerPricing = false; });

  test('gate on: a plain create (no grouping fields) that would reuse a grouped draft with a scheduled sibling is refused — nothing written', async () => {
    mockGateState.sendRequiresServerPricing = true;
    const { database, updates, inserts } = makeDatabase({
      lead: { id: 'lead-1', status: 'new', phone: '9415550101', estimate_id: 'estimate-draft' },
      estimate: { id: 'estimate-draft', status: 'draft', token: 'existing-token', customer_phone: '(941) 555-0101', estimate_group_id: GROUP },
      scheduledGroupMember: { id: 'est-anchor' },
    });
    await expect(createOrReuseAdminEstimate({
      database,
      body: { ...baseBody, address: '456 Revised St', monthlyTotal: 145 },
      technicianId: 'tech-1',
      recompute: engineError,
      now: () => new Date('2026-05-15T12:00:00.000Z'),
    })).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/scheduled to send/i) });
    expect(inserts).toEqual([]);
    expect(updates.filter((u) => u.table === 'estimates')).toEqual([]);
  });

  test('control: the same reuse with no scheduled sibling keeps the fail-open save', async () => {
    mockGateState.sendRequiresServerPricing = true;
    const { database, updates } = makeDatabase({
      lead: { id: 'lead-1', status: 'new', phone: '9415550101', estimate_id: 'estimate-draft' },
      estimate: { id: 'estimate-draft', status: 'draft', token: 'existing-token', customer_phone: '(941) 555-0101', estimate_group_id: GROUP },
      scheduledGroupMember: null,
    });
    const result = await createOrReuseAdminEstimate({
      database,
      body: { ...baseBody, address: '456 Revised St', monthlyTotal: 145 },
      technicianId: 'tech-1',
      recompute: engineError,
      now: () => new Date('2026-05-15T12:00:00.000Z'),
    });
    expect(result.reused).toBe(true);
    expect(updates.filter((u) => u.table === 'estimates')).toHaveLength(1);
  });
});
