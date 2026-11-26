// POST /calculate-estimate previews a new-home estimate (moving PR B1,
// GATE_MOVING_ESTIMATE) with the $99 setup fee waived, the same way its save
// stamps it (owner Q2: waived for every move). A refused move answers its
// status before anything is priced; technicians cannot ask for the waiver; a
// reopened move estimate (moveEstimateId) previews waived only when the stored
// estimate really is one for this customer. Handler invoked off the router
// stack (repo has no supertest); the move check and the db are mocked.

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
let mockStored = null;
// Rows by table for the lead lookup (leads, customers); every other read gets mockStored.
let mockByTable = {};
jest.mock('../models/db', () => jest.fn((table) => {
  const b = {};
  b.where = jest.fn(() => b);
  b.whereNull = jest.fn(() => b);
  b.first = jest.fn(async () => (table in mockByTable ? mockByTable[table] : mockStored));
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
// The returning-customer rule's history read (GATE_RETURNING_SETUP_FEE_GAP): null = gate off or no history.
jest.mock('../services/returning-setup-fee-waiver', () => ({
  ...jest.requireActual('../services/returning-setup-fee-waiver'),
  loadReturningVisitHistory: jest.fn(async () => null),
}));
jest.mock('../services/customer-moves', () => {
  class MoveError extends Error {
    constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
  }
  return { MoveError, verifyMoveForEstimate: jest.fn(async () => ({ id: 'move-1' })) };
});

const db = require('../models/db');
const Moves = require('../services/customer-moves');
const Returning = require('../services/returning-setup-fee-waiver');
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
  mockByTable = {};
});
afterEach(() => { delete process.env.GATE_RETURNING_SETUP_FEE_GAP; });

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

// Returning-customer rule: the preview prices through the decision the save makes, so the two agree. Regressions
// this would show: staff see a $99 the save drops (or the reverse), a technician is shown a visit date, a failed
// history read prices as "no history".
test('a returning customer inside the window previews without the $99, and the tool gets the reason', async () => {
  const backAfter95Days = { todayKey: '2026-11-24', lastByFamily: { pest_control: { lastVisitKey: '2026-08-21', cycleDays: 91 } } };
  const plain = await invoke(quote());
  Returning.loadReturningVisitHistory.mockResolvedValueOnce(backAfter95Days);
  const back = await invoke(quote());
  expect(Returning.loadReturningVisitHistory).toHaveBeenLastCalledWith(db, { customerId: 'cust-1' });
  expect(back.payload.returningSetupFeeWaiver).toEqual(expect.objectContaining({ lastCompletedVisitDate: '2026-08-21', gapDays: 95, windowDays: 121 }));
  expect(back.payload.oneTime.membershipFee).toBe(0);
  expect(back.payload.oneTime.total).toBe(plain.payload.oneTime.total - 99);
  expect(back.payload.totals.year1).toBe(plain.payload.totals.year1 - 99);
  expect(back.payload.totals.year2).toBe(plain.payload.totals.year2);

  // A technician gets the price and the rule's name, never the visit date.
  Returning.loadReturningVisitHistory.mockResolvedValueOnce(backAfter95Days);
  const tech = await invoke(quote(), 'technician');
  expect(tech.payload.oneTime.membershipFee).toBe(0);
  expect(tech.payload.returningSetupFeeWaiver).toEqual({ rule: 'returning_customer_gap' });

  // A move's own waiver already covers the fee: the rule adds nothing to it.
  Returning.loadReturningVisitHistory.mockResolvedValueOnce(backAfter95Days);
  const moving = await invoke(quote({ moveId: 'move-1' }));
  expect(moving.payload.moveSetupFeeWaived).toBe(true);
  expect(moving.payload.returningSetupFeeWaiver).toBeUndefined();
});

test('a failed visit-history read refuses the preview for a retry', async () => {
  Returning.loadReturningVisitHistory.mockRejectedValueOnce(new Error('db down'));
  expect(await invoke(quote())).toEqual({
    status: 503,
    payload: expect.objectContaining({ code: 'PRIOR_SERVICES_UNAVAILABLE', retryable: true }),
  });
});

// A builder that holds only a lead (picking one clears its customer) is saved for the lead's customer
// (leadCustomerIdForEstimate). Regression (pre-push audit 2026-11-25): the preview read no visit history for it,
// so staff saw a $99 the save then waived, with no banner.
test('a lead-only builder previews for the lead\'s customer, by the save\'s own rule', async () => {
  const LEAD_ID = '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
  const typed = { leadId: LEAD_ID, customerPhone: '(941) 555-0100', customerEmail: '' };
  const leadOnly = (lead) => ({ ...quote({ existingCustomerId: null }), lead });
  const readFor = () => Returning.loadReturningVisitHistory.mock.calls.at(-1)[1].customerId;
  mockByTable = {
    leads: { id: LEAD_ID, customer_id: 'cust-9', status: 'new', phone: '+19415550100', email: null },
    customers: { id: 'cust-9' },
  };

  // Gate off: the lead is never read.
  await invoke(leadOnly(typed));
  expect(db).not.toHaveBeenCalledWith('leads');
  expect(readFor()).toBeNull();

  process.env.GATE_RETURNING_SETUP_FEE_GAP = 'true';
  await invoke(leadOnly(typed));
  expect(readFor()).toBe('cust-9');
  // As at the save: no customer when the typed contact is not the lead's, the lead is closed, or the id is no lead id.
  await invoke(leadOnly({ ...typed, customerPhone: '(941) 555-0199' }));
  expect(readFor()).toBeNull();
  mockByTable.leads = { ...mockByTable.leads, status: 'lost' };
  await invoke(leadOnly(typed));
  expect(readFor()).toBeNull();
  db.mockClear();
  await invoke(leadOnly({ ...typed, leadId: 'not-a-lead-id' }));
  expect(db).not.toHaveBeenCalledWith('leads');
  expect(readFor()).toBeNull();
  // The builder's own customer wins over a lead.
  await invoke({ ...quote(), lead: typed });
  expect(readFor()).toBe('cust-1');
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
