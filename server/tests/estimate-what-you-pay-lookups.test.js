/**
 * The two live lookups the "What you pay" box needs from the accept side (owner 2026-11-23): the billing lane
 * and the paid-but-unconsumed deposit. An unresolved lookup must mean "no box", never a guess.
 */
const mockDbState = {
  customer: null,
  billingModeColumnExists: true,
  deposits: [],
  depositsError: null,
};

jest.mock('../models/db', () => {
  const handler = (table) => {
    const builder = {
      where: () => builder,
      whereIn: () => builder,
      whereNull: () => builder,
      whereNotNull: () => builder,
      andWhere: () => builder,
      join: () => builder,
      orderBy: () => builder,
      limit: () => builder,
      select: async () => {
        if (table === 'estimate_deposits' || table.startsWith('estimate_deposits')) {
          if (mockDbState.depositsError) throw mockDbState.depositsError;
          return mockDbState.deposits;
        }
        return [];
      },
      first: async () => {
        if (table === 'customers') {
          if (mockDbState.customer instanceof Error) throw mockDbState.customer;
          return mockDbState.customer;
        }
        return null;
      },
      then: (resolve) => resolve([]),
    };
    return builder;
  };
  handler.fn = { now: () => new Date() };
  handler.raw = async () => ({ rows: [] });
  handler.schema = { hasColumn: async () => mockDbState.billingModeColumnExists };
  return handler;
});

const {
  estimateMonthlyBillingLaneKnown,
  whatYouPayAcceptLookups,
  whatYouPayForData,
  whatYouPayForEstimate,
  estimateRendersMonthlyBilling,
  _resetPerApplicationColumnsProbeForTests,
} = require('../routes/estimate-public');

const linked = { id: 'est-lane-1', customer_id: 'cust-1', customer_phone: null };

beforeEach(() => {
  _resetPerApplicationColumnsProbeForTests();
  mockDbState.customer = null;
  mockDbState.billingModeColumnExists = true;
  mockDbState.deposits = [];
  mockDbState.depositsError = null;
});

describe('estimateMonthlyBillingLaneKnown', () => {
  test('a per-application customer resolves false', async () => {
    mockDbState.customer = { id: 'cust-1', pipeline_stage: 'active_customer', monthly_rate: 95, billing_mode: 'per_application' };
    expect(await estimateMonthlyBillingLaneKnown(linked)).toBe(false);
  });

  test('a current monthly member resolves true', async () => {
    mockDbState.customer = { id: 'cust-1', pipeline_stage: 'won', monthly_rate: 60, billing_mode: 'monthly_membership' };
    expect(await estimateMonthlyBillingLaneKnown(linked)).toBe(true);
  });

  test('no customer link and no phone resolves false (nothing to look up)', async () => {
    expect(await estimateMonthlyBillingLaneKnown({ id: 'est-lead', customer_id: null, customer_phone: null })).toBe(false);
  });

  test('a lookup that throws resolves null, while the display resolver still answers false', async () => {
    mockDbState.customer = new Error('connection refused');
    expect(await estimateMonthlyBillingLaneKnown(linked)).toBeNull();
    expect(await estimateRendersMonthlyBilling(linked)).toBe(false);
  });
});

describe('whatYouPayAcceptLookups', () => {
  test('a per-application customer with no deposit: { monthlyBilled: false, pendingDeposit: 0 }', async () => {
    mockDbState.customer = { id: 'cust-1', pipeline_stage: 'active_customer', monthly_rate: 95, billing_mode: 'per_application' };
    expect(await whatYouPayAcceptLookups(linked)).toEqual({ monthlyBilled: false, pendingDeposit: 0 });
  });

  test('a received, unconsumed deposit is reported as its open balance', async () => {
    mockDbState.customer = { id: 'cust-1', pipeline_stage: 'active_customer', monthly_rate: 95, billing_mode: 'per_application' };
    mockDbState.deposits = [{ id: 'd1', amount: '49.00', credited_amount: '0', refunded_amount: '0', estimate_id: 'est-lane-1' }];
    const out = await whatYouPayAcceptLookups(linked);
    expect(out.monthlyBilled).toBe(false);
    expect(out.pendingDeposit).toBeGreaterThan(0);
  });

  test('a deposit ledger that cannot be read: pendingDeposit is null', async () => {
    mockDbState.customer = { id: 'cust-1', pipeline_stage: 'active_customer', monthly_rate: 95, billing_mode: 'per_application' };
    mockDbState.depositsError = new Error('relation unavailable');
    expect((await whatYouPayAcceptLookups(linked)).pendingDeposit).toBeNull();
  });

  test('a billing lane that cannot be read: monthlyBilled is null', async () => {
    mockDbState.customer = new Error('connection refused');
    expect((await whatYouPayAcceptLookups(linked)).monthlyBilled).toBeNull();
  });
});

// The page payload and the texting AI's estimate facts (sms-staff-facts.js: the setup fee and the pay-for-the-year total) build the box
// through this ONE assembly, over the lookups whatYouPayAcceptLookups resolved, so the two can never hand whatYouPayForData different inputs.
// Synthetic estimate.
describe('whatYouPayForEstimate', () => {
  const estimate = { ...linked, token: 'a'.repeat(24), status: 'sent', show_one_time_option: false, bill_by_invoice: false, expires_at: new Date(Date.now() + 86400000) };
  const estData = { result: { recurring: { services: [{ service: 'pest_control', name: 'Pest Control', label: 'Pest Control' }] } } };
  const pricingBundle = {
    services: [{ key: 'pest_control', label: 'Pest Control', isRecurring: true, defaultFrequencyKey: 'quarterly', frequencies: [{ key: 'quarterly' }] }],
    frequencies: [{
      key: 'quarterly', monthly: 33, annual: 396, visitsPerYear: 4,
      perServiceTreatments: [{ service: 'pest_control', label: 'Pest Control', displayPrice: 99, perTreatment: 99, visitsPerYear: 4, monthly: 33 }],
    }],
    oneTimeBreakdown: { total: 99, items: [{ service: 'waveguard_setup', amount: 99 }] },
    firstVisitFees: [{ service: 'waveguard_setup', amount: 99, waivedWithPrepay: true }],
  };
  const perApplicationCustomer = { id: 'cust-1', pipeline_stage: 'active_customer', monthly_rate: 95, billing_mode: 'per_application' };
  const boxFor = async (row, bundle = pricingBundle) => whatYouPayForEstimate(row, estData, bundle, await whatYouPayAcceptLookups(row));

  test('over the resolved lane and deposit ledger: the same box whatYouPayForData builds from them', async () => {
    mockDbState.customer = perApplicationCustomer;
    const box = await boxFor(estimate);
    expect(box).toMatchObject({ selection: { frequency: 'quarterly' }, lines: [{ key: 'pest_control', perApplication: 99, applicationsPerYear: 4 }] });
    expect(box.setupFee).toBeGreaterThan(0);
    expect(box).toEqual(whatYouPayForData({
      estimate, estData, pricingBundle, invoiceMode: false, siteConfirmationHold: false, monthlyBilled: false, pendingDeposit: 0, quoteRequired: false,
    }));
  });

  test('a paid deposit, a ledger or a lane that cannot be read, invoice mode or a quote that needs review: no box', async () => {
    mockDbState.customer = perApplicationCustomer;
    mockDbState.deposits = [{ id: 'd1', amount: '49.00', credited_amount: '0', refunded_amount: '0', estimate_id: 'est-lane-1' }];
    expect(await boxFor(estimate)).toBeNull();
    mockDbState.deposits = [];
    mockDbState.depositsError = new Error('relation unavailable');
    expect(await boxFor(estimate)).toBeNull();
    mockDbState.depositsError = null;
    mockDbState.customer = new Error('connection refused');
    expect(await boxFor(estimate)).toBeNull();
    mockDbState.customer = perApplicationCustomer;
    expect(await boxFor({ ...estimate, bill_by_invoice: true })).toBeNull();
    expect(await boxFor(estimate, { ...pricingBundle, quoteRequired: true })).toBeNull();
    expect(await boxFor(estimate)).not.toBeNull();
  });

  test('the lookups it is handed decide, and it reads nothing itself', () => {
    // a lane that would fail, were it read here
    mockDbState.customer = new Error('connection refused');
    expect(whatYouPayForEstimate(estimate, estData, pricingBundle, { monthlyBilled: false, pendingDeposit: 0 })).not.toBeNull();
    expect(whatYouPayForEstimate(estimate, estData, pricingBundle, { monthlyBilled: false, pendingDeposit: 49 })).toBeNull();
    expect(whatYouPayForEstimate(estimate, estData, pricingBundle, { monthlyBilled: true, pendingDeposit: 0 })).toBeNull();
  });
});
