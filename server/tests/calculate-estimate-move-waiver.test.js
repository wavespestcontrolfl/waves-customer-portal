// POST /calculate-estimate previews a new-home estimate (moving PR B1,
// GATE_MOVING_ESTIMATE) with the $99 setup fee waived, the same way its save
// stamps it (owner Q2: waived for every move). A refused move answers its
// status before anything is priced; technicians cannot ask for the waiver; a
// reopened move estimate (moveEstimateId) previews waived only when the stored
// estimate really is one for this customer. Handler invoked off the router
// stack (repo has no supertest); the move check and the db are mocked.

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
let mockStored = null;
jest.mock('../models/db', () => jest.fn(() => {
  const b = {};
  b.where = jest.fn(() => b);
  b.first = jest.fn(async () => mockStored);
  return b;
}));
jest.mock('../services/pricing-engine', () => ({
  ...jest.requireActual('../services/pricing-engine'),
  needsSync: () => false,
}));
jest.mock('../services/area-addon-limits', () => ({
  attachQuoteAreaAddOnHistory: async (_db, v1Input) => v1Input,
}));
jest.mock('../services/pricing-engine/trusted-catalog-pricing', () => ({
  withTrustedCatalogPricing: async (v1Input) => v1Input,
}));
// A new street: no existing services there, so a pest-only quote carries the $99.
jest.mock('../services/waveguard-existing-services', () => ({
  ...jest.requireActual('../services/waveguard-existing-services'),
  resolveCustomerQualifyingEvidence: jest.fn(async () => ({
    tierKeys: [], setupWaiverKeys: [], groupedEstimate: true, perPropertyStreetScope: null,
  })),
}));
jest.mock('../services/estimate-membership-context', () => ({
  ...jest.requireActual('../services/estimate-membership-context'),
  currentServiceTierOffer: jest.fn(),
}));
jest.mock('../services/customer-moves', () => {
  class MoveError extends Error {
    constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
  }
  return { MoveError, verifyMoveForEstimate: jest.fn(async () => ({ id: 'move-1' })) };
});

const db = require('../models/db');
const Moves = require('../services/customer-moves');
const router = require('../routes/property-lookup-v2');

function invoke(body, techRole = 'admin') {
  const layer = router.stack.find((l) => l.route?.path === '/calculate-estimate' && l.route.methods.post);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(payload) { resolve({ status: this.statusCode, payload }); },
    };
    handler({ body, techRole }, res);
  });
}

const ESTIMATE_ID = '5d6e7f80-1a2b-4c3d-8e9f-0a1b2c3d4e5f';
const quote = (options = {}) => ({
  profile: { homeSqFt: 2000, lotSqFt: 8000, stories: 1, propertyType: 'Single Family' },
  selectedServices: ['PEST'],
  options: { address: '40 Sample Road, Venice, FL 34285', pestFreq: 4, existingCustomerId: 'cust-1', ...options },
});

beforeEach(() => {
  jest.clearAllMocks();
  mockStored = null;
});

test('a new-home estimate previews without the $99 and says so', async () => {
  const plain = await invoke(quote());
  expect(plain.status).toBe(200);
  expect(plain.payload.oneTime.membershipFee).toBe(99);
  expect(plain.payload.moveSetupFeeWaived).toBeUndefined();

  const moving = await invoke(quote({ moveId: 'move-1' }));
  expect(moving.status).toBe(200);
  expect(Moves.verifyMoveForEstimate).toHaveBeenCalledWith({
    moveId: 'move-1', customerId: 'cust-1', address: '40 Sample Road, Venice, FL 34285',
  });
  expect(moving.payload.moveSetupFeeWaived).toBe(true);
  expect(moving.payload.oneTime.membershipFee).toBe(0);
  expect(moving.payload.oneTime.total).toBe(plain.payload.oneTime.total - 99);
  expect(moving.payload.totals.year1).toBe(plain.payload.totals.year1 - 99);
  // Recurring prices are untouched.
  expect(moving.payload.totals.year2).toBe(plain.payload.totals.year2);
});

test('a refused move answers its status and prices nothing; a technician is refused', async () => {
  Moves.verifyMoveForEstimate.mockRejectedValueOnce(new Moves.MoveError('prepay', 'This customer prepays for the year.', 409));
  const refused = await invoke(quote({ moveId: 'move-1' }));
  expect(refused).toEqual({ status: 409, payload: { error: 'This customer prepays for the year.', code: 'prepay' } });

  const tech = await invoke(quote({ moveId: 'move-1' }), 'technician');
  expect(tech.status).toBe(403);
  expect(Moves.verifyMoveForEstimate).toHaveBeenCalledTimes(1);
});

test('a reopened move estimate previews waived only when it is this customer\'s move estimate', async () => {
  mockStored = { customer_id: 'cust-1', estimate_data: JSON.stringify({ move: { moveId: 'move-1' } }) };
  expect((await invoke(quote({ moveEstimateId: ESTIMATE_ID }))).payload).toMatchObject({ moveSetupFeeWaived: true, oneTime: { membershipFee: 0 } });

  mockStored = { customer_id: 'cust-2', estimate_data: { move: { moveId: 'move-1' } } };
  expect((await invoke(quote({ moveEstimateId: ESTIMATE_ID }))).payload.oneTime.membershipFee).toBe(99);

  mockStored = { customer_id: 'cust-1', estimate_data: { inputs: {} } };
  expect((await invoke(quote({ moveEstimateId: ESTIMATE_ID }))).payload.oneTime.membershipFee).toBe(99);

  db.mockClear();
  expect((await invoke(quote({ moveEstimateId: 'not-a-uuid' }))).payload.oneTime.membershipFee).toBe(99);
  expect(db).not.toHaveBeenCalled();
  expect((await invoke(quote({ moveEstimateId: ESTIMATE_ID }), 'technician')).status).toBe(403);
});
