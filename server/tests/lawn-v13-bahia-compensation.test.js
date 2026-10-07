// GATE_LAWN_V13: when a resend of an already-issued Pest + Bahia estimate delivers on no channel, the
// staff compensation restore (revertLeadServiceForSend -> applyServiceMixChange, actor 'staff') puts
// the parked line back as the sold replay, never as an addition. The customer taking a staff-parked
// offer is an addition and keeps the bahia review.
// Read once at module load by the feature-gates table.
process.env.GATE_ESTIMATE_SERVICE_ADD = 'true';
jest.mock('../models/db', () => jest.fn());
const mockRecompute = jest.fn();
jest.mock('../services/admin-estimate-persistence', () => ({
  ...jest.requireActual('../services/admin-estimate-persistence'),
  serverRecomputeFromEstimateData: (...args) => mockRecompute(...args),
}));

jest.mock('../services/waveguard-existing-services', () => ({
  ...jest.requireActual('../services/waveguard-existing-services'),
  isActivePlanCustomer: jest.fn(async () => false),
}));

const OptOut = require('../services/estimate-service-opt-out');
const { applyServiceMixChange } = require('../routes/estimate-public');

const BASE = { homeSqFt: 1800, lotSqFt: 8783, stories: 1, estimatedTurfSf: 4500 };

// A Pest + Bahia estimate whose lawn line staff parked at send time (the lead-service send).
function parkedEstimate(overrides = {}) {
  const data = {
    engineInputs: { ...BASE, services: { pest: { apps: 4 }, lawn: { track: 'bahia', tier: 'enhanced' } } },
    result: { recurring: { services: [
      { service: 'pest_control', name: 'Pest Control', mo: 60, ann: 720, visitsPerYear: 4 },
      { service: 'lawn_care', name: 'Lawn Care', mo: 66.75, ann: 801, visitsPerYear: 9 },
    ], monthlyTotal: 126.75, annualAfterDiscount: 1521, discount: 0 } },
  };
  const baseline = JSON.parse(JSON.stringify(data));
  const applied = OptOut.applyServiceOptOutToEstimateData(data, { serviceKey: 'lawn_care', included: false, actor: 'staff' });
  OptOut.recordServiceOptOutEvent(data, {
    serviceKey: 'lawn_care', label: 'Lawn Care', included: false, mode: 'remove', actor: 'staff', parkId: 'park-1',
    removedInputs: applied.removedInputs, at: '2026-10-06T12:00:00.000Z',
  }, baseline);
  return {
    id: 'est-1', token: 'tok', status: 'sent', customer_id: null, sent_at: new Date('2026-09-01T12:00:00Z'),
    updated_at: new Date('2026-10-06T12:00:00Z'), estimate_data: data, ...overrides,
  };
}

const restore = (estimate, actor) => applyServiceMixChange({ estimate, body: { serviceKey: 'lawn_care', included: true, dryRun: true }, actor });
const depsOfLastRecompute = () => mockRecompute.mock.calls[mockRecompute.mock.calls.length - 1][1];

beforeEach(() => {
  process.env.GATE_LAWN_V13 = 'true';
  process.env.GATE_ESTIMATE_SERVICE_OPT_OUT = 'true';
  mockRecompute.mockReset().mockResolvedValue({ recomputed: false });
});
afterEach(() => {
  delete process.env.GATE_LAWN_V13;
  delete process.env.GATE_ESTIMATE_SERVICE_OPT_OUT;
});

test('the staff compensation restore replays the sold bahia line: nothing is added', async () => {
  await restore(parkedEstimate(), 'staff');
  expect(mockRecompute).toHaveBeenCalledTimes(1);
  expect(depsOfLastRecompute()).toMatchObject({ replaySavedPricingKnobs: true, addedServiceKeys: [] });
});

test('the customer taking the staff-parked offer is an addition and keeps the review', async () => {
  await restore(parkedEstimate({ customer_id: 'cust-1' }), 'customer');
  expect(mockRecompute).toHaveBeenCalledTimes(1);
  expect(depsOfLastRecompute()).toMatchObject({ replaySavedPricingKnobs: true, addedServiceKeys: ['lawn_care'] });
});
