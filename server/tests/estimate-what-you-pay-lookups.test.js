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
