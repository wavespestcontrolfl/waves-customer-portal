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
// Outstanding quotes are described from the bundle the PAGE is selling, and the
// page reconciles a lapsed membership before building it (#3120 r4/r6/r7).
const mockBuildPricingBundle = jest.fn();
const mockReconcileMembership = jest.fn();
const mockEstimateMakesNoGuaranteeClaim = jest.fn(() => false);
jest.mock('../routes/estimate-public', () => ({
  matchAcceptCustomerByPhone: mockMatchByPhone,
  buildPricingBundle: mockBuildPricingBundle,
  reconcileFrozenMembershipSnapshot: mockReconcileMembership,
  estimateMakesNoGuaranteeClaim: mockEstimateMakesNoGuaranteeClaim,
  // Real implementation — selected → recommended → first.
  defaultFrequencyFromList: (list = []) => list.find((f) => f?.selected || f?.isSelected)
    || list.find((f) => f?.recommended || f?.isRecommended)
    || list[0]
    || null,
}));
const REBUILT = { key: 'standard', annual: 540, perTreatment: 90, visitsPerYear: 6, recommended: true };
const LIVE_BUNDLE = { source: 'live_rebuild', frequencies: [REBUILT] };

const {
  estimateBillsPerApplication,
  estimateSoldAsAnnualPrepay,
  proposalCallbackTermsEligible,
  proposalCarriesPlanTerms,
  proposalMakesNoGuaranteeClaim,
  proposalRateReviewTermsEligible,
  documentCarriesRateReviewTerms,
  rateReviewTermsServedIsCurrent,
  recordRateReviewTermsServed,
  proposalRowTermsScope,
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

describe('proposalMakesNoGuaranteeClaim', () => {
  it('passes only the normalized rows the proposal document renders to the canonical route policy', () => {
    mockEstimateMakesNoGuaranteeClaim.mockReturnValueOnce(true);
    const proposal = {
      enabled: false,
      buildings: [{ name: 'Home', lineItems: [{ description: 'Termite trenching', amount: 1200 }] }],
      programs: [{ service: 'pest', label: 'Pest control' }],
      correctiveWork: [{ label: 'WDO inspection', amount: 175 }],
      terms: 'Authored terms stay outside service classification.',
    };
    expect(proposalMakesNoGuaranteeClaim(proposal, 'e1')).toBe(true);
    expect(mockEstimateMakesNoGuaranteeClaim).toHaveBeenCalledWith(
      {
        proposal: {
          enabled: true,
          buildings: proposal.buildings,
          programs: proposal.programs,
          correctiveWork: proposal.correctiveWork,
        },
      },
    );
  });

  it('fails closed when the canonical policy cannot classify the estimate', () => {
    mockEstimateMakesNoGuaranteeClaim.mockImplementationOnce(() => { throw new Error('classification unavailable'); });
    expect(proposalMakesNoGuaranteeClaim({ buildings: [] }, 'e1')).toBe(true);
  });
});

describe('proposalCallbackTermsEligible', () => {
  const building = (...descriptions) => ({ name: 'Home', lineItems: descriptions.map((description) => ({ description, amount: 55, frequency: 'quarterly' })) });

  it('allows the canned callback sentence only on an all-pest residential proposal', () => {
    mockEstimateMakesNoGuaranteeClaim.mockReturnValue(false);
    expect(proposalCallbackTermsEligible({ enabled: false, buildings: [building('Quarterly Pest Control')] }, 'e1')).toBe(true);
    expect(proposalCallbackTermsEligible({ enabled: false, buildings: [building('Rodent Bait Stations')] }, 'e1')).toBe(false);
    expect(proposalCallbackTermsEligible({ enabled: false, buildings: [building('Quarterly Pest Control', 'Rodent Bait Stations')] }, 'e1')).toBe(false);
    expect(proposalCallbackTermsEligible({ enabled: false, buildings: [] }, 'e1')).toBe(false);
    // An authored (enabled) proposal is commercial: terms-neutral.
    expect(proposalCallbackTermsEligible({ enabled: true, buildings: [building('Quarterly Pest Control')] }, 'e1')).toBe(false);
    mockEstimateMakesNoGuaranteeClaim.mockReset();
  });

  it('needs a scheduled recurring pest line: a one-time pest job has no visits to call back between', () => {
    mockEstimateMakesNoGuaranteeClaim.mockReturnValue(false);
    const oneTime = { enabled: false, buildings: [{ name: 'Home', lineItems: [{ description: 'Pest Control', frequency: 'one_time', amount: 150 }] }] };
    const recurring = { enabled: false, buildings: [{ name: 'Home', lineItems: [{ description: 'Pest Control', frequency: 'quarterly', amount: 120 }] }] };
    const pestLawn = { enabled: false, buildings: [{ name: 'Home', lineItems: [
      { description: 'Pest Control', frequency: 'quarterly', amount: 120 },
      { description: 'Lawn Care', frequency: 'monthly', amount: 60 },
    ] }] };
    expect(proposalCallbackTermsEligible(oneTime, 'e1')).toBe(false);
    expect(proposalCallbackTermsEligible(recurring, 'e1')).toBe(true);
    // Pest + lawn carries the plan terms, but the canned sentence is pest's.
    expect(proposalCarriesPlanTerms(pestLawn, 'e1')).toBe(true);
    expect(proposalCallbackTermsEligible(pestLawn, 'e1')).toBe(false);
    expect(proposalCarriesPlanTerms({ enabled: false, buildings: [{ name: 'Home', lineItems: [
      { description: 'Rodent Bait Stations', frequency: 'monthly', amount: 40 },
    ] }] }, 'e1')).toBe(false);
    mockEstimateMakesNoGuaranteeClaim.mockReset();
  });

  it('never allows it where the proposal makes no guarantee claim', () => {
    mockEstimateMakesNoGuaranteeClaim.mockReturnValueOnce(true);
    expect(proposalCallbackTermsEligible({ enabled: false, buildings: [building('Quarterly Pest Control')] }, 'e1')).toBe(false);
  });
});

describe('proposalRateReviewTermsEligible (annual rate review disclosure, owner ruling 2026-09-30)', () => {
  const building = (...lines) => ({ name: 'Home', lineItems: lines.map(([description, frequency]) => ({ description, amount: 55, frequency })) });

  it('prints on every recurring residential plan-terms document — pest, lawn, and a pest + lawn mix — not only all-pest', () => {
    mockEstimateMakesNoGuaranteeClaim.mockReturnValue(false);
    expect(proposalRateReviewTermsEligible({ enabled: false, buildings: [building(['Quarterly Pest Control', 'quarterly'])] }, 'e1')).toBe(true);
    expect(proposalRateReviewTermsEligible({ enabled: false, buildings: [building(['Lawn Care', 'monthly'])] }, 'e1')).toBe(true);
    expect(proposalRateReviewTermsEligible({ enabled: false, buildings: [building(['Mosquito Control', 'monthly'])] }, 'e1')).toBe(true);
    const pestLawn = { enabled: false, buildings: [building(['Pest Control', 'quarterly'], ['Lawn Care', 'monthly'])] };
    expect(proposalCallbackTermsEligible(pestLawn, 'e1')).toBe(false);
    expect(proposalRateReviewTermsEligible(pestLawn, 'e1')).toBe(true);
    mockEstimateMakesNoGuaranteeClaim.mockReset();
  });

  it('never prints on rodent, commercial (authored), empty or one-time-only documents', () => {
    mockEstimateMakesNoGuaranteeClaim.mockReturnValue(false);
    expect(proposalRateReviewTermsEligible({ enabled: false, buildings: [building(['Rodent Bait Stations', 'monthly'])] }, 'e1')).toBe(false);
    expect(proposalRateReviewTermsEligible({ enabled: false, buildings: [building(['Quarterly Pest Control', 'quarterly'], ['Rodent Bait Stations', 'monthly'])] }, 'e1')).toBe(false);
    expect(proposalRateReviewTermsEligible({ enabled: true, buildings: [building(['Quarterly Pest Control', 'quarterly'])] }, 'e1')).toBe(false);
    expect(proposalRateReviewTermsEligible({ enabled: false, buildings: [] }, 'e1')).toBe(false);
    // A one-time-only document has no rate to review.
    expect(proposalRateReviewTermsEligible({ enabled: false, buildings: [building(['Pest Control', 'one_time'])] }, 'e1')).toBe(false);
    mockEstimateMakesNoGuaranteeClaim.mockReset();
  });

  it('never prints where the proposal makes no guarantee claim (termite / unclassifiable work)', () => {
    mockEstimateMakesNoGuaranteeClaim.mockReturnValueOnce(true);
    expect(proposalRateReviewTermsEligible({ enabled: false, buildings: [building(['Quarterly Pest Control', 'quarterly'])] }, 'e1')).toBe(false);
  });

  // codex #5434 r2 P1: frozen documents keep their original terms.
  describe('frozen documents (accepted / declined) keep the terms the customer saw', () => {
    const { RATE_REVIEW_SENTENCE } = require('../services/acceptance-terms-text');
    const plan = { enabled: false, buildings: [building(['Quarterly Pest Control', 'quarterly'])] };
    const planAcceptance = { termsText: `Accepting authorizes these services at the price shown.\nServices — at the price and frequency shown, until you cancel. No contract. ${RATE_REVIEW_SENTENCE}` };
    const baseAcceptance = { termsText: 'Accepting authorizes these services at the price shown.\nServices — at the price and frequency shown, until you cancel. No contract.' };
    beforeEach(() => mockEstimateMakesNoGuaranteeClaim.mockReturnValue(false));
    afterEach(() => mockEstimateMakesNoGuaranteeClaim.mockReset());

    it('an open estimate prints (it is being sold under the current terms)', () => {
      expect(proposalRateReviewTermsEligible(plan, 'e1', { estimate: { status: 'sent' } })).toBe(true);
      expect(documentCarriesRateReviewTerms({ status: 'viewed', price_locked_at: null })).toBe(true);
    });

    it('an accepted estimate prints ONLY when its recorded acceptance carried the sentence', () => {
      expect(proposalRateReviewTermsEligible(plan, 'e1', { estimate: { status: 'accepted' }, acceptance: planAcceptance })).toBe(true);
      expect(proposalRateReviewTermsEligible(plan, 'e1', { estimate: { status: 'accepted' }, acceptance: baseAcceptance })).toBe(false);
      expect(proposalRateReviewTermsEligible(plan, 'e1', { estimate: { status: 'accepted' }, acceptance: null })).toBe(false);
      // price_locked_at alone freezes too (both accept flows stamp it).
      expect(proposalRateReviewTermsEligible(plan, 'e1', { estimate: { status: 'sent', price_locked_at: '2026-09-01T00:00:00Z' } })).toBe(false);
      // The raw ledger column shape is accepted as well.
      expect(documentCarriesRateReviewTerms({ status: 'accepted' }, { terms_text: planAcceptance.termsText })).toBe(true);
    });

    it('a declined estimate never acquires it', () => {
      expect(proposalRateReviewTermsEligible(plan, 'e1', { estimate: { status: 'declined' } })).toBe(false);
    });

    // codex #5434 r3 P1: an accept that records no drawer snapshot (gate off,
    // the annual prepay lane) stamps the document fact itself.
    it("an accepted estimate stamped rateReviewDisclosedAtAccept prints even with no acceptance row", () => {
      expect(proposalRateReviewTermsEligible(plan, 'e1', { estimate: { status: 'accepted', estimate_data: { rateReviewDisclosedAtAccept: true } }, acceptance: null })).toBe(true);
      expect(proposalRateReviewTermsEligible(plan, 'e1', { estimate: { status: 'accepted', estimate_data: JSON.stringify({ rateReviewDisclosedAtAccept: true }) }, acceptance: null })).toBe(true);
      expect(proposalRateReviewTermsEligible(plan, 'e1', { estimate: { status: 'accepted', estimate_data: { rateReviewDisclosedAtAccept: false } }, acceptance: null })).toBe(false);
      expect(proposalRateReviewTermsEligible(plan, 'e1', { estimate: { status: 'accepted', estimate_data: '{not json' }, acceptance: null })).toBe(false);
    });

    it('without the estimate row the plan-terms decision stands alone (legacy callers)', () => {
      expect(proposalRateReviewTermsEligible(plan, 'e1')).toBe(true);
    });
  });
});

// Owner ruling 2026-09-27: each service carries its own terms, so each
// printed line states its own service's terms.
describe('proposalRowTermsScope', () => {
  const residential = { enabled: false };
  it('a residential pest or lawn line carries the plan terms; a rodent line only satisfaction', () => {
    expect(proposalRowTermsScope(residential, { description: 'Quarterly Pest Control' })).toBe('all');
    expect(proposalRowTermsScope(residential, { description: 'Lawn Care' })).toBe('all');
    expect(proposalRowTermsScope(residential, { description: 'Rodent Bait Stations' })).toBe('satisfaction');
  });

  it('every line of an authored (commercial) proposal carries only satisfaction', () => {
    expect(proposalRowTermsScope({ enabled: true }, { description: 'Quarterly Pest Control' })).toBe('satisfaction');
  });

  it('no line of a no-guarantee document carries terms', () => {
    expect(proposalRowTermsScope(residential, { description: 'Quarterly Pest Control' }, true)).toBe('none');
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
      .toEqual({ billsPerApplication: false, livePricing: null });
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
      .toEqual({ billsPerApplication: false, livePricing: null });
  });

  // Pre-push r5: the customer's CURRENT lane does not carry over — a prepay
  // customer accepting a new standard estimate is stamped per_application.
  it('a prepay CUSTOMER with no term on this estimate still gets per-application copy', async () => {
    stubTables({ customer: { ...perAppCustomer, billing_mode: 'annual_prepay' }, prepayTerm: undefined });
    expect(await resolveProposalBillingContext({ id: 'e1', customer_id: 'c1' }))
      .toEqual({ billsPerApplication: true, livePricing: { bundle: LIVE_BUNDLE, defaultCandidate: REBUILT, snapshotHit: false } });
  });

  it('is status-blind — a refunded term still just means "leave the document alone"', async () => {
    stubTables({ customer: perAppCustomer, prepayTerm: { id: 't1', status: 'refunded' } });
    expect(await resolveProposalBillingContext({ id: 'e1', customer_id: 'c1' }))
      .toEqual({ billsPerApplication: false, livePricing: null });
  });
});

describe('resolveProposalBillingContext', () => {
  it('reports the lane', async () => {
    stubTables({ customer: { pipeline_stage: 'active_customer', monthly_rate: 0, billing_mode: 'per_application' } });
    expect(await resolveProposalBillingContext({ id: 'e1', customer_id: 'c1' }))
      .toEqual({ billsPerApplication: true, livePricing: { bundle: LIVE_BUNDLE, defaultCandidate: REBUILT, snapshotHit: false } });
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
      .toEqual({ billsPerApplication: false, livePricing: null });
  });
});


// #3120 r6/r7: the pricing authority depends on whether the price is locked.
describe('pricing authority', () => {
  const perAppCustomer = { pipeline_stage: 'lead', monthly_rate: 45 };

  it('resolves the live bundle for an OUTSTANDING quote', async () => {
    stubTables({ customer: perAppCustomer });
    const estimate = { id: 'e1', customer_id: 'c1', status: 'sent' };
    const ctx = await resolveProposalBillingContext(estimate);
    expect(ctx.livePricing).toEqual({ bundle: LIVE_BUNDLE, defaultCandidate: REBUILT, snapshotHit: false });
    expect(mockBuildPricingBundle).toHaveBeenCalledWith(estimate);
  });

  it('reconciles a lapsed membership BEFORE building the bundle', async () => {
    stubTables({ customer: perAppCustomer });
    const order = [];
    mockReconcileMembership.mockImplementation(async () => { order.push('reconcile'); });
    mockBuildPricingBundle.mockImplementation(async () => { order.push('build'); return LIVE_BUNDLE; });
    await resolveProposalBillingContext({ id: 'e1', customer_id: 'c1', status: 'sent' });
    expect(order).toEqual(['reconcile', 'build']);
  });

  it('never rebuilds or reconciles an ACCEPTED estimate', async () => {
    stubTables({ customer: perAppCustomer });
    const ctx = await resolveProposalBillingContext({ id: 'e1', customer_id: 'c1', status: 'accepted' });
    expect(ctx).toEqual({ billsPerApplication: true, livePricing: null });
    expect(mockBuildPricingBundle).not.toHaveBeenCalled();
    expect(mockReconcileMembership).not.toHaveBeenCalled();
  });

  it('never rebuilds a price_locked_at row whose status has not flipped', async () => {
    stubTables({ customer: perAppCustomer });
    const ctx = await resolveProposalBillingContext({
      id: 'e1', customer_id: 'c1', status: 'sent', price_locked_at: '2026-07-31T12:00:00Z',
    });
    expect(ctx.livePricing).toBeNull();
    expect(mockBuildPricingBundle).not.toHaveBeenCalled();
  });

  it('picks the recommended cadence as the default, not merely the first', async () => {
    stubTables({ customer: perAppCustomer });
    mockBuildPricingBundle.mockResolvedValue({ frequencies: [{ key: 'quarterly', annual: 240 }, REBUILT] });
    expect((await resolveProposalBillingContext({ id: 'e1', customer_id: 'c1' })).livePricing.defaultCandidate)
      .toEqual(REBUILT);
  });

  it('skips quote-required cadences when choosing the default', async () => {
    stubTables({ customer: perAppCustomer });
    mockBuildPricingBundle.mockResolvedValue({
      frequencies: [{ key: 'custom', quoteRequired: true, recommended: true }, REBUILT],
    });
    expect((await resolveProposalBillingContext({ id: 'e1', customer_id: 'c1' })).livePricing.defaultCandidate)
      .toEqual(REBUILT);
  });

  // #3120 r8: a failed rebuild must NOT read as "frozen" — that would quote the
  // very snapshot buildPricingBundle exists to reject.
  it('reports UNRESOLVED (not frozen) when the rebuild fails', async () => {
    stubTables({ customer: perAppCustomer });
    mockBuildPricingBundle.mockRejectedValue(new Error('pricing engine down'));
    expect(await resolveProposalBillingContext({ id: 'e1', customer_id: 'c1' }))
      .toEqual({ billsPerApplication: true, livePricing: { unresolved: true } });
  });

  it('marks a snapshot-served bundle so stale-total matching stays valid', async () => {
    stubTables({ customer: perAppCustomer });
    mockBuildPricingBundle.mockResolvedValue({ ...LIVE_BUNDLE, snapshotHit: true });
    expect((await resolveProposalBillingContext({ id: 'e1', customer_id: 'c1' })).livePricing.snapshotHit)
      .toBe(true);
  });

  // A DECLINED estimate is terminal but still downloadable — freeze it too.
  it('treats a declined estimate as frozen', async () => {
    stubTables({ customer: perAppCustomer });
    const ctx = await resolveProposalBillingContext({ id: 'e1', customer_id: 'c1', status: 'declined' });
    expect(ctx.livePricing).toBeNull();
    expect(mockBuildPricingBundle).not.toHaveBeenCalled();
  });

  it('does not rebuild at all for a legacy lane', async () => {
    stubTables({ customer: { pipeline_stage: 'active_customer', monthly_rate: 45, billing_mode: null } });
    expect(await resolveProposalBillingContext({ id: 'e1', customer_id: 'c1' }))
      .toEqual({ billsPerApplication: false, livePricing: null });
    expect(mockBuildPricingBundle).not.toHaveBeenCalled();
  });
});

// Served-disclosure evidence (pre-push Codex on #5434's merge head): the
// accept stamps the frozen document only on proof the customer was served
// the line — this marker (written by the /pdf download and the legacy page
// card) or the recorded 'plan' drawer snapshot.
describe('served-disclosure evidence (estimate_data.rateReviewTermsServed)', () => {
  const { RATE_REVIEW_TERMS_VERSION } = require('../../shared/estimate-copy-claims.cjs');

  test('rateReviewTermsServedIsCurrent: the current version only, string or object data', () => {
    expect(rateReviewTermsServedIsCurrent({ rateReviewTermsServed: RATE_REVIEW_TERMS_VERSION })).toBe(true);
    expect(rateReviewTermsServedIsCurrent(JSON.stringify({ rateReviewTermsServed: RATE_REVIEW_TERMS_VERSION }))).toBe(true);
    expect(rateReviewTermsServedIsCurrent({ rateReviewTermsServed: 'v2025-01' })).toBe(false);
    expect(rateReviewTermsServedIsCurrent({})).toBe(false);
    expect(rateReviewTermsServedIsCurrent(null)).toBe(false);
    expect(rateReviewTermsServedIsCurrent('not json')).toBe(false);
  });

  function stubEstimatesUpdate(update) {
    const chain = { where: jest.fn(() => chain), whereNull: jest.fn(() => chain), whereNotIn: jest.fn(() => chain), update };
    mockDb.mockImplementation((table) => {
      if (table === 'estimates') return chain;
      throw new Error(`unexpected table ${table}`);
    });
    mockDb.raw = jest.fn((sql, bindings) => ({ __raw: sql, bindings }));
    return chain;
  }

  test('an open estimate is stamped with the current version under the frozen-status guards', async () => {
    const update = jest.fn(async () => 1);
    const chain = stubEstimatesUpdate(update);
    await expect(recordRateReviewTermsServed({ id: 'e1', status: 'sent', price_locked_at: null, estimate_data: '{}' })).resolves.toBe(true);
    expect(chain.where).toHaveBeenCalledWith({ id: 'e1' });
    expect(chain.whereNull).toHaveBeenCalledWith('price_locked_at');
    expect(chain.whereNotIn).toHaveBeenCalledWith('status', expect.arrayContaining(['accepted', 'declined']));
    const [{ estimate_data }] = update.mock.calls[0];
    expect(estimate_data.__raw).toContain("'{rateReviewTermsServed}', to_jsonb(?::text)");
    expect(estimate_data.bindings).toEqual([RATE_REVIEW_TERMS_VERSION]);
  });

  test('a frozen estimate, or one already marked at the current version, is never written', async () => {
    const update = jest.fn(async () => 1);
    stubEstimatesUpdate(update);
    await expect(recordRateReviewTermsServed({ id: 'e2', status: 'accepted', price_locked_at: null, estimate_data: '{}' })).resolves.toBe(false);
    await expect(recordRateReviewTermsServed({ id: 'e3', status: 'sent', price_locked_at: '2026-09-01T00:00:00Z', estimate_data: '{}' })).resolves.toBe(false);
    await expect(recordRateReviewTermsServed({ id: 'e4', status: 'sent', price_locked_at: null, estimate_data: { rateReviewTermsServed: RATE_REVIEW_TERMS_VERSION } })).resolves.toBe(false);
    await expect(recordRateReviewTermsServed(null)).resolves.toBe(false);
    expect(update).not.toHaveBeenCalled();
  });

  test('a database failure is swallowed — the page or download never fails on the marker', async () => {
    stubEstimatesUpdate(jest.fn(async () => { throw new Error('db down'); }));
    await expect(recordRateReviewTermsServed({ id: 'e5', status: 'sent', price_locked_at: null, estimate_data: '{}' })).resolves.toBe(false);
  });
});
