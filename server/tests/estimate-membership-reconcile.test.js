process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

// reconcileFrozenMembershipSnapshot: a lapsed member must lose EVERY frozen
// membership artifact — not just the snapshot + priorQualifyingServices, but
// also the SERVER-stamped recurring flags in the stored replay shapes
// (engineInputs/inputs/engineRequest.options). extractEngineInputs() replays
// those on every public reprice, so leaving them behind grants the recurring
// perk forever after the plan lapses — including for one-time-only members
// with no qualifying priors, whose snapshot may be absent entirely.
//
// Clearing flags alone still isn't enough: the member discount is BAKED INTO
// the stored result/totals, which buildPricingBundle's v1 path serves
// verbatim. The reconcile therefore reprices in-memory with non-member
// identity, and fails CLOSED (membershipLapsedRequote → quote-required, so
// accept refuses) when no trustworthy reprice is possible.

jest.mock('../services/waveguard-existing-services', () => ({
  ...jest.requireActual('../services/waveguard-existing-services'),
  isActivePlanCustomer: jest.fn(),
}));
jest.mock('../services/estimate-pricing-cache', () => ({
  ...jest.requireActual('../services/estimate-pricing-cache'),
  clearEstimatePricingCache: jest.fn(),
}));
jest.mock('../services/admin-estimate-persistence', () => ({
  ...jest.requireActual('../services/admin-estimate-persistence'),
  serverRecomputeFromEstimateData: jest.fn(),
}));

const { isActivePlanCustomer } = require('../services/waveguard-existing-services');
const { clearEstimatePricingCache } = require('../services/estimate-pricing-cache');
const { serverRecomputeFromEstimateData } = require('../services/admin-estimate-persistence');
const {
  reconcileFrozenMembershipSnapshot,
  resolveEstimateQuoteRequirement,
} = require('../routes/estimate-public');

const REPRICED_RESULT = {
  recurring: { services: [], grandTotal: 0, tier: 'Bronze', waveGuardTier: 'Bronze' },
  oneTime: { items: [{ name: 'One-Time Pest', price: 150 }], total: 150 },
};

function frozenEstData(extra = {}) {
  return {
    // priorQualifyingServices nested in the replay shape = legacy row that
    // predates the save-time sanitizer; it must be cleared too or the replay
    // restores the combined tier.
    engineInputs: { homeSqFt: 2000, services: { oneTimePest: {} }, recurringCustomer: true, priorQualifyingServices: ['pest_control'] },
    inputs: { homeSqFt: 2000, recurringCustomer: true, isRecurringCustomer: 'YES' },
    engineRequest: { options: { recurringCustomer: true } },
    // Member-discounted stored result — the undercharge the reprice replaces.
    result: { oneTime: { items: [{ name: 'One-Time Pest', price: 127.5 }], total: 127.5 } },
    ...extra,
  };
}

function estimateRow(estData, overrides = {}) {
  return {
    id: 'est-1',
    customer_id: 'cust-1',
    status: 'sent',
    price_locked_at: null,
    monthly_total: 0,
    annual_total: 0,
    onetime_total: 127.5,
    estimate_data: JSON.stringify(estData),
    ...overrides,
  };
}

beforeEach(() => {
  serverRecomputeFromEstimateData.mockResolvedValue({
    recomputed: true,
    source: 'ENGINE_INPUTS',
    serverResult: REPRICED_RESULT,
    serverTotals: { monthlyTotal: null, annualTotal: null, onetimeTotal: 150 },
  });
});

afterEach(() => {
  jest.clearAllMocks();
});

describe('reconcileFrozenMembershipSnapshot — frozen recurring flags', () => {
  test('a lapsed member with NO snapshot loses the stamped recurring flags from every replay shape', async () => {
    isActivePlanCustomer.mockResolvedValue(false);
    const estimate = estimateRow(frozenEstData());

    await reconcileFrozenMembershipSnapshot(estimate);

    const estData = JSON.parse(estimate.estimate_data);
    expect(estData.engineInputs.recurringCustomer).toBeUndefined();
    expect(estData.inputs.recurringCustomer).toBeUndefined();
    expect(estData.inputs.isRecurringCustomer).toBeUndefined();
    expect(estData.engineRequest.options.recurringCustomer).toBeUndefined();
    // The NESTED prior-service list is cleared too — extractEngineInputs
    // would replay it and restore the combined-tier discount otherwise.
    expect(estData.engineInputs.priorQualifyingServices).toBeUndefined();
    // Non-identity inputs survive.
    expect(estData.engineInputs.homeSqFt).toBe(2000);
    expect(clearEstimatePricingCache).toHaveBeenCalledWith('est-1');
  });

  test('the lapsed reprice replaces the stored member-priced result AND the row totals + tier', async () => {
    isActivePlanCustomer.mockResolvedValue(false);
    const estimate = estimateRow(frozenEstData({
      // A frozen per-tier discount rate map + a stale fail-closed flag from a
      // previous failed reconcile — both must clear on the successful pass.
      sendSnapshot: { tierDiscounts: { Platinum: 0.2 }, other: 'kept' },
      membershipLapsedRequote: true,
    }), { waveguard_tier: 'Platinum' });

    await reconcileFrozenMembershipSnapshot(estimate);

    const estData = JSON.parse(estimate.estimate_data);
    // The reprice ran on the SANITIZED estData (flags already stripped).
    const repricedArg = serverRecomputeFromEstimateData.mock.calls[0][0];
    expect(repricedArg.engineInputs.recurringCustomer).toBeUndefined();
    // Stored result is the non-member reprice, not the baked member price.
    expect(estData.result).toEqual(REPRICED_RESULT);
    // A successful authoritative reprice clears the fail-closed flag.
    expect(estData.membershipLapsedRequote).toBeUndefined();
    // Frozen member-context discount rates are gone; unrelated keys survive.
    expect(estData.sendSnapshot.tierDiscounts).toBeUndefined();
    expect(estData.sendSnapshot.other).toBe('kept');
    expect(estimate.onetime_total).toBe(150);
    expect(estimate.monthly_total).toBe(0);
    // Accept-time tier math reads the ROW column — it now matches the
    // repriced (non-member) result, not the stale Platinum.
    expect(estimate.waveguard_tier).toBe('Bronze');
  });

  test('no trustworthy reprice → fail closed: membershipLapsedRequote set, stored result untouched', async () => {
    isActivePlanCustomer.mockResolvedValue(false);
    serverRecomputeFromEstimateData.mockResolvedValue({ recomputed: false, reason: 'NO_INPUTS' });
    const estimate = estimateRow(frozenEstData());

    await reconcileFrozenMembershipSnapshot(estimate);

    const estData = JSON.parse(estimate.estimate_data);
    expect(estData.membershipLapsedRequote).toBe(true);
    // The stale result stays (nothing better exists) but the requote flag
    // gates accept/deposit through resolveEstimateQuoteRequirement.
    expect(estData.result.oneTime.total).toBe(127.5);
    expect(estimate.onetime_total).toBe(127.5);
  });

  test('an active member keeps the stamped flags untouched', async () => {
    isActivePlanCustomer.mockResolvedValue(true);
    const estimate = estimateRow(frozenEstData());
    const before = estimate.estimate_data;

    await reconcileFrozenMembershipSnapshot(estimate);

    expect(estimate.estimate_data).toBe(before);
    expect(serverRecomputeFromEstimateData).not.toHaveBeenCalled();
    expect(clearEstimatePricingCache).not.toHaveBeenCalled();
  });

  test('the snapshot path also clears the recurring flags, not just snapshot + priors', async () => {
    isActivePlanCustomer.mockResolvedValue(false);
    const estimate = estimateRow(frozenEstData({
      membershipSnapshot: { isExistingCustomer: true, tierLabel: 'Silver' },
      priorQualifyingServices: ['pest_control'],
    }));

    await reconcileFrozenMembershipSnapshot(estimate);

    const estData = JSON.parse(estimate.estimate_data);
    expect(estData.membershipSnapshot).toBeUndefined();
    expect(estData.priorQualifyingServices).toBeUndefined();
    expect(estData.engineInputs.recurringCustomer).toBeUndefined();
    expect(estData.inputs.isRecurringCustomer).toBeUndefined();
  });

  test('an accepted estimate is never reconciled — the committed deal keeps its terms', async () => {
    isActivePlanCustomer.mockResolvedValue(false);
    const estimate = estimateRow(frozenEstData(), { status: 'accepted' });
    const before = estimate.estimate_data;

    await reconcileFrozenMembershipSnapshot(estimate);

    expect(estimate.estimate_data).toBe(before);
    expect(isActivePlanCustomer).not.toHaveBeenCalled();
  });

  test('no linked customer means nothing to re-verify — untouched', async () => {
    const estimate = estimateRow(frozenEstData(), { customer_id: null });
    const before = estimate.estimate_data;

    await reconcileFrozenMembershipSnapshot(estimate);

    expect(estimate.estimate_data).toBe(before);
    expect(isActivePlanCustomer).not.toHaveBeenCalled();
  });

  test('top-level priorQualifyingServices ALONE (no snapshot, no flags) still arms the reconcile', async () => {
    isActivePlanCustomer.mockResolvedValue(false);
    const estimate = estimateRow({
      engineInputs: { homeSqFt: 2000, services: { oneTimePest: {} } },
      priorQualifyingServices: ['pest_control'],
      result: { oneTime: { items: [], total: 127.5 } },
    });

    await reconcileFrozenMembershipSnapshot(estimate);

    const estData = JSON.parse(estimate.estimate_data);
    expect(isActivePlanCustomer).toHaveBeenCalled();
    expect(estData.priorQualifyingServices).toBeUndefined();
  });

  test('a NESTED prior-service list alone arms the reconcile', async () => {
    isActivePlanCustomer.mockResolvedValue(false);
    const estimate = estimateRow({
      engineInputs: { homeSqFt: 2000, services: { oneTimePest: {} }, priorQualifyingServices: ['pest_control'] },
      result: { oneTime: { items: [], total: 127.5 } },
    });

    await reconcileFrozenMembershipSnapshot(estimate);

    const estData = JSON.parse(estimate.estimate_data);
    expect(isActivePlanCustomer).toHaveBeenCalled();
    expect(estData.engineInputs.priorQualifyingServices).toBeUndefined();
  });

  test('legacy truthy representations (boolean isRecurringCustomer, string recurringCustomer) arm the reconcile', async () => {
    isActivePlanCustomer.mockResolvedValue(false);
    const booleanLegacy = estimateRow({
      engineInputs: { homeSqFt: 2000, services: { oneTimePest: {} } },
      inputs: { homeSqFt: 2000, isRecurringCustomer: true },
      result: { oneTime: { items: [], total: 127.5 } },
    });
    await reconcileFrozenMembershipSnapshot(booleanLegacy);
    expect(JSON.parse(booleanLegacy.estimate_data).inputs.isRecurringCustomer).toBeUndefined();

    const stringLegacy = estimateRow({
      engineInputs: { homeSqFt: 2000, services: { oneTimePest: {} }, recurringCustomer: 'true' },
      result: { oneTime: { items: [], total: 127.5 } },
    });
    await reconcileFrozenMembershipSnapshot(stringLegacy);
    expect(JSON.parse(stringLegacy.estimate_data).engineInputs.recurringCustomer).toBeUndefined();
  });

  test('explicit negatives (isRecurringCustomer NO, recurringCustomer false) do NOT arm the reconcile', async () => {
    const estimate = estimateRow({
      engineInputs: { homeSqFt: 2000, services: { oneTimePest: {} }, recurringCustomer: false },
      inputs: { homeSqFt: 2000, isRecurringCustomer: 'NO' },
      result: { oneTime: { items: [], total: 127.5 } },
    });

    await reconcileFrozenMembershipSnapshot(estimate);

    expect(isActivePlanCustomer).not.toHaveBeenCalled();
  });

  test('an engineRequest.options recurring flag alone arms the reconcile', async () => {
    isActivePlanCustomer.mockResolvedValue(false);
    const estimate = estimateRow({
      engineInputs: { homeSqFt: 2000, services: { oneTimePest: {} } },
      engineRequest: { options: { recurringCustomer: true } },
      result: { oneTime: { items: [], total: 127.5 } },
    });

    await reconcileFrozenMembershipSnapshot(estimate);

    const estData = JSON.parse(estimate.estimate_data);
    expect(isActivePlanCustomer).toHaveBeenCalled();
    expect(estData.engineRequest.options.recurringCustomer).toBeUndefined();
  });

  test('an estimate with no frozen artifacts never hits the live plan check', async () => {
    const estimate = estimateRow({
      engineInputs: { homeSqFt: 2000, services: { pest: {} } },
      inputs: { homeSqFt: 2000, isRecurringCustomer: 'NO' },
      result: { total: 125 },
    });

    await reconcileFrozenMembershipSnapshot(estimate);

    expect(isActivePlanCustomer).not.toHaveBeenCalled();
  });
});

describe('resolveEstimateQuoteRequirement — membershipLapsedRequote', () => {
  test('the fail-closed flag makes the estimate quote-required with its own reason', () => {
    const state = resolveEstimateQuoteRequirement(null, { membershipLapsedRequote: true });
    expect(state.quoteRequired).toBe(true);
    expect(state.reason).toBe('membership_lapsed_requote');
  });

  test('without the flag nothing changes', () => {
    const state = resolveEstimateQuoteRequirement(null, {});
    expect(state.quoteRequired).toBe(false);
  });
});
