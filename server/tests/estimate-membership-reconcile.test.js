process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

// reconcileFrozenMembershipSnapshot: a lapsed member must lose EVERY frozen
// membership artifact — not just the snapshot + priorQualifyingServices, but
// also the SERVER-stamped recurring flags in the stored replay shapes
// (engineInputs/inputs/engineRequest.options). extractEngineInputs() replays
// those on every public reprice, so leaving them behind grants the recurring
// perk forever after the plan lapses — including for one-time-only members
// with no qualifying priors, whose snapshot may be absent entirely.

jest.mock('../services/waveguard-existing-services', () => ({
  ...jest.requireActual('../services/waveguard-existing-services'),
  isActivePlanCustomer: jest.fn(),
}));
jest.mock('../services/estimate-pricing-cache', () => ({
  ...jest.requireActual('../services/estimate-pricing-cache'),
  clearEstimatePricingCache: jest.fn(),
}));

const { isActivePlanCustomer } = require('../services/waveguard-existing-services');
const { clearEstimatePricingCache } = require('../services/estimate-pricing-cache');
const { reconcileFrozenMembershipSnapshot } = require('../routes/estimate-public');

function frozenEstData(extra = {}) {
  return {
    engineInputs: { homeSqFt: 2000, services: { oneTimePest: {} }, recurringCustomer: true },
    inputs: { homeSqFt: 2000, recurringCustomer: true, isRecurringCustomer: 'YES' },
    engineRequest: { options: { recurringCustomer: true } },
    result: { total: 125 },
    ...extra,
  };
}

function estimateRow(estData, overrides = {}) {
  return {
    id: 'est-1',
    customer_id: 'cust-1',
    status: 'sent',
    price_locked_at: null,
    estimate_data: JSON.stringify(estData),
    ...overrides,
  };
}

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
    // Non-identity inputs survive.
    expect(estData.engineInputs.homeSqFt).toBe(2000);
    expect(clearEstimatePricingCache).toHaveBeenCalledWith('est-1');
  });

  test('an active member keeps the stamped flags untouched', async () => {
    isActivePlanCustomer.mockResolvedValue(true);
    const estimate = estimateRow(frozenEstData());
    const before = estimate.estimate_data;

    await reconcileFrozenMembershipSnapshot(estimate);

    expect(estimate.estimate_data).toBe(before);
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
