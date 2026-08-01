/**
 * The live billing lane behind the estimate PDF (codex #3120 r2): persisted
 * snapshot flags freeze at send time, so the document must ask the same
 * question the estimate page asks on every render.
 */
const mockDb = jest.fn();
mockDb.schema = { hasTable: jest.fn() };
jest.mock('../models/db', () => mockDb);
jest.mock('../services/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));

const {
  estimateBillsPerApplication,
  estimateHasAnnualPrepayTerm,
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

beforeEach(() => { jest.clearAllMocks(); });

describe('estimateBillsPerApplication', () => {
  it('is true for an unlinked estimate — an unmatched accept converts per-application', async () => {
    stubTables({});
    expect(await estimateBillsPerApplication({ id: 'e1' })).toBe(true);
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

describe('estimateHasAnnualPrepayTerm', () => {
  it('is true for a live term on this estimate', async () => {
    stubTables({ prepayTerm: { id: 't1', status: 'active' } });
    expect(await estimateHasAnnualPrepayTerm({ id: 'e1' })).toBe(true);
  });

  it('is false for a cancelled term', async () => {
    stubTables({ prepayTerm: { id: 't1', status: 'cancelled' } });
    expect(await estimateHasAnnualPrepayTerm({ id: 'e1' })).toBe(false);
  });

  it('is false with no term and on a database without the table', async () => {
    stubTables({ prepayTerm: undefined });
    expect(await estimateHasAnnualPrepayTerm({ id: 'e1' })).toBe(false);
    mockDb.schema.hasTable.mockResolvedValue(false);
    expect(await estimateHasAnnualPrepayTerm({ id: 'e1' })).toBe(false);
  });
});

describe('resolveProposalBillingContext', () => {
  it('reports both facts together', async () => {
    stubTables({
      customer: { pipeline_stage: 'active_customer', monthly_rate: 0, billing_mode: 'per_application' },
      prepayTerm: { status: 'active' },
    });
    expect(await resolveProposalBillingContext({ id: 'e1', customer_id: 'c1' }))
      .toEqual({ billsPerApplication: true, annualPrepay: true });
  });
});
