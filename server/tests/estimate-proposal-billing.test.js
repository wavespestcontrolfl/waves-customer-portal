/**
 * The live billing lane behind the estimate PDF (codex #3120 r2): persisted
 * snapshot flags freeze at send time, so the document must ask the same
 * question the estimate page asks on every render.
 */
const mockDb = jest.fn();
mockDb.schema = { hasTable: jest.fn() };
jest.mock('../models/db', () => mockDb);
jest.mock('../services/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));
// An unlinked estimate links at accept through the SAME phone matcher, so an
// existing monthly member can sit behind one (codex #3120 r3).
const mockMatchByPhone = jest.fn();
jest.mock('../routes/estimate-public', () => ({ matchAcceptCustomerByPhone: mockMatchByPhone }));

const {
  estimateBillsPerApplication,
  estimateSoldAsAnnualPrepay,
  resolveProposalBillingContext,
} = require('../services/estimate-proposal-billing');

// db('customers').where({...}).first() / db('annual_prepay_terms')...
function stubTables({ customer, prepayTerm, customersThrow = false }) {
  mockDb.mockImplementation((table) => {
    if (table === 'customers') {
      return { where: () => ({ first: async () => { if (customersThrow) throw new Error('boom'); return customer; } }) };
    }
    if (table === 'annual_prepay_terms') {
      return { where: () => ({ first: async () => prepayTerm }) };
    }
    throw new Error(`unexpected table ${table}`);
  });
  mockDb.schema.hasTable.mockResolvedValue(true);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockMatchByPhone.mockResolvedValue({ match: null });
});

describe('estimateBillsPerApplication', () => {
  it('is true for an unlinked estimate the phone matcher cannot resolve', async () => {
    stubTables({});
    expect(await estimateBillsPerApplication({ id: 'e1' })).toBe(true);
  });

  it('is FALSE for an unlinked estimate whose phone matches a monthly member', async () => {
    stubTables({});
    mockMatchByPhone.mockResolvedValue({
      match: { pipeline_stage: 'active_customer', monthly_rate: 45, billing_mode: null },
    });
    expect(await estimateBillsPerApplication({ id: 'e1', customer_phone: '+19415551234' })).toBe(false);
    expect(mockMatchByPhone).toHaveBeenCalled();
  });

  it('is FALSE for a customer who preserves monthly membership', async () => {
    stubTables({ customer: { pipeline_stage: 'active_customer', monthly_rate: 45, billing_mode: null } });
    expect(await estimateBillsPerApplication({ id: 'e1', customer_id: 'c1' })).toBe(false);
  });

  it('is true for an explicit per_application customer even with a legacy monthly_rate', async () => {
    // The 2026-07-31 caller's own row: Bronze tier + monthly_rate 45, but an
    // explicit per_application lane.
    stubTables({ customer: { pipeline_stage: 'active_customer', monthly_rate: 45, billing_mode: 'per_application' } });
    expect(await estimateBillsPerApplication({ id: 'e1', customer_id: 'c1' })).toBe(true);
  });

  it('is true for a lead-stage row (no membership to preserve)', async () => {
    stubTables({ customer: { pipeline_stage: 'lead', monthly_rate: 45, billing_mode: null } });
    expect(await estimateBillsPerApplication({ id: 'e1', customer_id: 'c1' })).toBe(true);
  });

  it('keeps the monthly description when the lane lookup fails', async () => {
    stubTables({ customersThrow: true });
    expect(await estimateBillsPerApplication({ id: 'e1', customer_id: 'c1' })).toBe(false);
  });
});


// Codex #3120 r4: a refunded term describes no coverage — lockstep with the
// canonical logic in annual-prepay-renewals.js, which rejects refunded
// invoices and payments.

// Annual prepay is deliberately NOT re-derived here: coverage semantics belong
// to annual-prepay-renewals.js. Reading the LANE is enough — a prepaid plan
// simply keeps the legacy rendering (codex #3120 r4 + pre-push r5).
describe('annual prepay is a per-ESTIMATE fact, not the customer lane', () => {
  const perAppCustomer = { pipeline_stage: 'active_customer', monthly_rate: 45, billing_mode: 'per_application' };

  it('an estimate sold as prepay keeps the legacy document', async () => {
    stubTables({ customer: perAppCustomer, prepayTerm: { id: 't1', status: 'active' } });
    expect(await estimateSoldAsAnnualPrepay({ id: 'e1' })).toBe(true);
    expect(await resolveProposalBillingContext({ id: 'e1', customer_id: 'c1' }))
      .toEqual({ billsPerApplication: false });
  });

  // Pre-push r5: the customer's CURRENT lane does not carry over — a prepay
  // customer accepting a new standard estimate is stamped per_application.
  it('a prepay CUSTOMER with no term on this estimate still gets per-application copy', async () => {
    stubTables({ customer: { ...perAppCustomer, billing_mode: 'annual_prepay' }, prepayTerm: undefined });
    expect(await resolveProposalBillingContext({ id: 'e1', customer_id: 'c1' }))
      .toEqual({ billsPerApplication: true });
  });

  it('is status-blind — a refunded term still just means "leave the document alone"', async () => {
    stubTables({ customer: perAppCustomer, prepayTerm: { id: 't1', status: 'refunded' } });
    expect(await resolveProposalBillingContext({ id: 'e1', customer_id: 'c1' }))
      .toEqual({ billsPerApplication: false });
  });
});

describe('resolveProposalBillingContext', () => {
  it('reports the lane', async () => {
    stubTables({ customer: { pipeline_stage: 'active_customer', monthly_rate: 0, billing_mode: 'per_application' } });
    expect(await resolveProposalBillingContext({ id: 'e1', customer_id: 'c1' }))
      .toEqual({ billsPerApplication: true });
  });
});
