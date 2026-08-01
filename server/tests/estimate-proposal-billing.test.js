/**
 * The live billing lane behind the estimate PDF (codex #3120 r2): persisted
 * snapshot flags freeze at send time, so the document must ask the same
 * question the estimate page asks on every render.
 */
const mockDb = jest.fn();
mockDb.schema = { hasTable: jest.fn(), hasColumn: jest.fn() };
jest.mock('../models/db', () => mockDb);
jest.mock('../services/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));
// An unlinked estimate links at accept through the SAME phone matcher, so an
// existing monthly member can sit behind one (codex #3120 r3).
const mockMatchByPhone = jest.fn();
// The PDF must quote the bundle the PAGE is selling, not the frozen send
// snapshot, so the context resolves it through the route (codex #3120 r4).
const mockBuildPricingBundle = jest.fn();
jest.mock('../routes/estimate-public', () => ({
  matchAcceptCustomerByPhone: mockMatchByPhone,
  buildPricingBundle: mockBuildPricingBundle,
}));
const LIVE_BUNDLE = { source: 'live_rebuild', frequencies: [{ key: 'standard', perTreatment: 90, visitsPerYear: 6 }] };

const {
  estimateBillsPerApplication,
  estimateSoldAsAnnualPrepay,
  resolveProposalBillingContext,
  _resetPerApplicationColumnsProbeForTests,
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
  // Default to a migrated database; the pre-migration suite overrides it. The
  // module caches a true probe, so the cache has to be dropped between tests.
  _resetPerApplicationColumnsProbeForTests();
  mockDb.schema.hasColumn.mockResolvedValue(true);
  mockBuildPricingBundle.mockResolvedValue(LIVE_BUNDLE);
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


// Codex #3120 r5: before migration 20260709000010 the converter keeps the
// legacy update shape, so every accept bills monthly and there is no
// per-application lane to describe — the PDF must not advertise one.
describe('pre-migration database (no customers.billing_mode)', () => {
  beforeEach(() => {
    mockDb.schema.hasColumn.mockResolvedValue(false);
  });

  it('is FALSE for a lead-stage row that would otherwise bill per application', async () => {
    stubTables({ customer: { pipeline_stage: 'lead', monthly_rate: 45 } });
    expect(await estimateBillsPerApplication({ id: 'e1', customer_id: 'c1' })).toBe(false);
  });

  it('is FALSE for an unlinked estimate, and never reaches the phone matcher', async () => {
    stubTables({});
    expect(await estimateBillsPerApplication({ id: 'e1', customer_phone: '+19415551234' })).toBe(false);
    expect(mockMatchByPhone).not.toHaveBeenCalled();
  });

  it('keeps the legacy document through resolveProposalBillingContext', async () => {
    stubTables({ customer: { pipeline_stage: 'lead', monthly_rate: 45 } });
    expect(await resolveProposalBillingContext({ id: 'e1', customer_id: 'c1' }))
      .toEqual({ billsPerApplication: false, pricingBundle: null });
  });

  it('keeps the legacy document when the column probe itself errors', async () => {
    stubTables({ customer: { pipeline_stage: 'lead', monthly_rate: 45 } });
    mockDb.schema.hasColumn.mockRejectedValue(new Error('boom'));
    expect(await estimateBillsPerApplication({ id: 'e1', customer_id: 'c1' })).toBe(false);
  });

  it('re-probes while absent, then caches once the columns land', async () => {
    stubTables({ customer: { pipeline_stage: 'lead', monthly_rate: 45 } });
    await estimateBillsPerApplication({ id: 'e1', customer_id: 'c1' });
    await estimateBillsPerApplication({ id: 'e1', customer_id: 'c1' });
    expect(mockDb.schema.hasColumn).toHaveBeenCalledTimes(2);

    mockDb.schema.hasColumn.mockResolvedValue(true);
    expect(await estimateBillsPerApplication({ id: 'e1', customer_id: 'c1' })).toBe(true);
    await estimateBillsPerApplication({ id: 'e1', customer_id: 'c1' });
    expect(mockDb.schema.hasColumn).toHaveBeenCalledTimes(3);
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
      .toEqual({ billsPerApplication: false, pricingBundle: null });
  });

  // Pre-push r5: the customer's CURRENT lane does not carry over — a prepay
  // customer accepting a new standard estimate is stamped per_application.
  it('a prepay CUSTOMER with no term on this estimate still gets per-application copy', async () => {
    stubTables({ customer: { ...perAppCustomer, billing_mode: 'annual_prepay' }, prepayTerm: undefined });
    expect(await resolveProposalBillingContext({ id: 'e1', customer_id: 'c1' }))
      .toEqual({ billsPerApplication: true, pricingBundle: LIVE_BUNDLE });
  });

  it('is status-blind — a refunded term still just means "leave the document alone"', async () => {
    stubTables({ customer: perAppCustomer, prepayTerm: { id: 't1', status: 'refunded' } });
    expect(await resolveProposalBillingContext({ id: 'e1', customer_id: 'c1' }))
      .toEqual({ billsPerApplication: false, pricingBundle: null });
  });
});

// Codex #3120 r4: buildPricingBundleInner refuses to fast-path a snapshot with
// a retired cadence or a below-floor lawn price and rebuilds it, so the frozen
// snapshot can describe a plan no outstanding link can sell. The PDF asks the
// route for the same bundle the page renders instead of reading the snapshot.
describe('the live pricing bundle', () => {
  const perAppCustomer = { pipeline_stage: 'lead', monthly_rate: 45 };

  it('is resolved through the route for a per-application lane', async () => {
    stubTables({ customer: perAppCustomer });
    const estimate = { id: 'e1', customer_id: 'c1' };
    const ctx = await resolveProposalBillingContext(estimate);
    expect(ctx.pricingBundle).toEqual(LIVE_BUNDLE);
    expect(mockBuildPricingBundle).toHaveBeenCalledWith(estimate);
  });

  it('is not rebuilt at all for a legacy lane — that document never quotes one', async () => {
    stubTables({ customer: { pipeline_stage: 'active_customer', monthly_rate: 45, billing_mode: null } });
    const ctx = await resolveProposalBillingContext({ id: 'e1', customer_id: 'c1' });
    expect(ctx).toEqual({ billsPerApplication: false, pricingBundle: null });
    expect(mockBuildPricingBundle).not.toHaveBeenCalled();
  });

  it('lands on the legacy document when the rebuild fails', async () => {
    stubTables({ customer: perAppCustomer });
    mockBuildPricingBundle.mockRejectedValue(new Error('pricing engine down'));
    expect(await resolveProposalBillingContext({ id: 'e1', customer_id: 'c1' }))
      .toEqual({ billsPerApplication: true, pricingBundle: null });
  });

  it('treats a non-object bundle as unresolved', async () => {
    stubTables({ customer: perAppCustomer });
    mockBuildPricingBundle.mockResolvedValue(null);
    expect((await resolveProposalBillingContext({ id: 'e1', customer_id: 'c1' })).pricingBundle).toBeNull();
  });
});

describe('resolveProposalBillingContext', () => {
  it('reports the lane', async () => {
    stubTables({ customer: { pipeline_stage: 'active_customer', monthly_rate: 0, billing_mode: 'per_application' } });
    expect(await resolveProposalBillingContext({ id: 'e1', customer_id: 'c1' }))
      .toEqual({ billsPerApplication: true, pricingBundle: LIVE_BUNDLE });
  });
});

// Pre-push r6: an unknown prepay state must not read as "not prepaid".
describe('fail-closed on an inconclusive lookup', () => {
  it('keeps the legacy document when the prepay lookup errors', async () => {
    mockDb.mockImplementation((table) => {
      if (table === 'customers') {
        return { where: () => ({ first: async () => ({ pipeline_stage: 'active_customer', monthly_rate: 45, billing_mode: 'per_application' }) }) };
      }
      return { where: () => ({ first: async () => { throw new Error('boom'); } }) };
    });
    mockDb.schema.hasTable.mockResolvedValue(true);
    expect(await estimateSoldAsAnnualPrepay({ id: 'e1' })).toBeNull();
    expect(await resolveProposalBillingContext({ id: 'e1', customer_id: 'c1' }))
      .toEqual({ billsPerApplication: false, pricingBundle: null });
  });
});
