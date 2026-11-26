// GATE_RETURNING_SETUP_FEE_GAP: a service change on the estimate page (applyServiceMixChange) re-prices the
// quote, so the returning-customer rule decides again. It never carries the stored answer to the new plan.
// Regression (pre-push audit, 2026-11-25): an answer decided for a solo pest plan rode a service change onto
// another plan, whose $99 setup fee was then never shown or billed.
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
const mockHistoryRead = jest.fn();
jest.mock('../services/returning-setup-fee-waiver', () => ({
  ...jest.requireActual('../services/returning-setup-fee-waiver'),
  loadReturningVisitHistory: (...args) => mockHistoryRead(...args),
}));

const db = require('../models/db');
const OptOut = require('../services/estimate-service-opt-out');
const Returning = require('../services/returning-setup-fee-waiver');
const { applyServiceMixChange } = require('../routes/estimate-public');

const PEST_ANSWER = { rule: 'returning_customer_gap', family: 'pest_control', lastCompletedVisitDate: '2026-08-21', decidedOn: '2026-11-24', gapDays: 95, windowDays: 121 };

// A Pest + Lawn estimate whose lawn line staff parked at send time: the quote the customer holds is a solo
// pest plan, the one mix that carries the fee and so the one the rule can have answered.
function soloPestQuote(operatorPriceAdjustment) {
  const data = {
    engineInputs: { homeSqFt: 1800, lotSqFt: 8783, stories: 1, estimatedTurfSf: 4500, services: { pest: { apps: 4 }, lawn: { track: 'st_augustine', tier: 'enhanced' } } },
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
  if (operatorPriceAdjustment) data.operatorPriceAdjustment = operatorPriceAdjustment;
  return {
    id: 'est-1', token: 'tok', status: 'sent', customer_id: 'cust-1', sent_at: new Date('2026-09-01T12:00:00Z'),
    updated_at: new Date('2026-10-06T12:00:00Z'), estimate_data: data,
  };
}

// The customer takes the parked lawn line: the plan after the change is Pest + Lawn.
const addLawn = (estimate) => applyServiceMixChange({ estimate, body: { serviceKey: 'lawn_care', included: true, dryRun: true }, actor: 'customer' });

// The re-price double records the data as it was handed over (the writer stores the new answer on it after).
let handedToReprice;
const repriceAnswers = (returningSetupFeeWaiver) => mockRecompute.mockImplementation(async (data) => {
  handedToReprice = JSON.parse(JSON.stringify(data));
  return {
    recomputed: true,
    returningSetupFeeWaiver,
    serverResult: { recurring: { services: [
      { service: 'pest_control', name: 'Pest Control', mo: 60, ann: 720 },
      { service: 'lawn_care', name: 'Lawn Care', mo: 66.75, ann: 801 },
    ] }, monthlyTotal: 126.75, annualTotal: 1521 },
    serverTotals: { monthlyTotal: 126.75, annualTotal: 1521, onetimeTotal: 0 },
    rawEngineResult: { lineItems: [{ service: 'lawn_care', requiresManualReview: false }] },
  };
});
const dataAfterChange = () => mockRecompute.mock.calls[0][0];

beforeEach(() => {
  process.env.GATE_ESTIMATE_SERVICE_OPT_OUT = 'true';
  handedToReprice = null;
  mockRecompute.mockReset();
  mockHistoryRead.mockReset().mockResolvedValue(null);
});
afterEach(() => { delete process.env.GATE_ESTIMATE_SERVICE_OPT_OUT; });

test('the stored answer is dropped before the re-price, and the customer\'s visit history decides for the new plan', async () => {
  const history = { todayKey: '2026-11-24', lastByFamily: {} };
  mockHistoryRead.mockResolvedValue(history);
  repriceAnswers(null);
  await addLawn(soloPestQuote(Returning.withReturningSetupWaiver(null, PEST_ANSWER)));
  expect(mockHistoryRead).toHaveBeenCalledWith(db, { customerId: 'cust-1' });
  expect(handedToReprice).not.toHaveProperty('operatorPriceAdjustment');
  expect(mockRecompute.mock.calls[0][1].returningVisitHistory).toBe(history);
  // The rule has no answer for the new plan: nothing is stored on it.
  expect(dataAfterChange().operatorPriceAdjustment).toBeUndefined();
});

test('the rule\'s answer for the plan after the change is stored where the page and the accept read a waiver', async () => {
  repriceAnswers(PEST_ANSWER);
  await addLawn(soloPestQuote());
  expect(dataAfterChange().operatorPriceAdjustment).toEqual(expect.objectContaining({ waiveSetupFee: true, returningCustomerGap: PEST_ANSWER }));
});

test('a staff waiver is not the rule\'s: the change keeps it', async () => {
  repriceAnswers(null);
  const staffWaiver = { waiveSetupFee: true, internalReason: 'owner said so' };
  await addLawn(soloPestQuote(staffWaiver));
  expect(handedToReprice.operatorPriceAdjustment).toEqual(staffWaiver);
  expect(dataAfterChange().operatorPriceAdjustment).toEqual(staffWaiver);
});

test('a failed history read refuses the change before any price is made', async () => {
  mockHistoryRead.mockRejectedValue(new Error('db down'));
  repriceAnswers(null);
  await expect(addLawn(soloPestQuote(Returning.withReturningSetupWaiver(null, PEST_ANSWER))))
    .resolves.toEqual({ status: 409, body: { error: 'reprice_unavailable' } });
  expect(mockRecompute).not.toHaveBeenCalled();
});
