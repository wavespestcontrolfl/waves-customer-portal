/**
 * Send-time "lead with one service" (GATE_ESTIMATE_LEAD_SERVICE_SEND).
 * Scope pins: gate off / member / grouped / commercial / single-line / already-
 * shaped rows are untouched; a new residential customer's two-line estimate
 * parks the non-lead line through the shared rail as actor 'staff', dry run
 * then commit bound to that preview, and returns the fresh row. A refusal
 * never blocks the send.
 */
const mockGates = { estimateLeadServiceSend: true, estimateServiceOptOut: true, estimateServiceAdd: true };
jest.mock('../config/feature-gates', () => ({ isEnabled: (k) => mockGates[k] === true }));

const mockMixCalls = [];
const mockMix = { responder: null };
jest.mock('../routes/estimate-public', () => ({
  buildPricingBundle: jest.fn(async () => ({
    services: [{ key: 'pest_control', isRecurring: true }, { key: 'lawn_care', isRecurring: true }],
  })),
  applyServiceMixChange: jest.fn(async (args) => { mockMixCalls.push(args); return mockMix.responder(args); }),
}));
// The db read returns the CLAIMED row (post send-claim version) first, then
// the parked row after each commit — so the test can prove the rail is
// handed the claimed version, never the caller's stale object.
const mockRows = { queue: [] };
jest.mock('../models/db', () => {
  const dbh = () => ({ where: () => ({ first: async () => (mockRows.queue.length > 1 ? mockRows.queue.shift() : mockRows.queue[0]) }) });
  dbh.fn = { now: () => 'now' };
  return dbh;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const mockPlan = { active: false, throws: false };
jest.mock('../services/waveguard-existing-services', () => ({
  isActivePlanCustomer: jest.fn(async () => { if (mockPlan.throws) throw new Error('lookup down'); return mockPlan.active; }),
}));

const { applyLeadServiceForSend } = require('../routes/admin-estimates');

const newCustomerRow = (overrides = {}) => ({
  id: 'est-1',
  status: 'sending',
  category: 'RESIDENTIAL',
  waveguard_tier: 'Silver',
  // Stale: the route's send claim rewrote updated_at after this object was read.
  updated_at: '2026-09-01T10:00:00.000Z',
  estimate_data: JSON.stringify({
    engineRequest: { profile: { homeSqFt: 2000 }, selectedServices: ['PEST', 'LAWN'], options: {} },
    inputs: { services: { pest: {}, lawn: {} } },
  }),
  ...overrides,
});
const CLAIMED_AT = '2026-09-01T10:00:05.000Z';
const claimedRowFor = (row) => ({ ...row, status: 'sending', updated_at: CLAIMED_AT });
const parkedRow = { id: 'est-1', status: 'viewed', monthly_total: 40, updated_at: '2026-09-01T10:00:09.000Z', estimate_data: '{}' };

beforeEach(() => {
  mockMixCalls.length = 0;
  mockRows.queue = [claimedRowFor(newCustomerRow()), parkedRow];
  mockPlan.active = false;
  mockPlan.throws = false;
  mockGates.estimateLeadServiceSend = true;
  mockMix.responder = ({ body }) => (body.dryRun
    ? { status: 200, body: { success: true, dryRun: true, previewBasis: 'digest-1' } }
    : { status: 200, body: { success: true } });
});

test('parks the non-lead line as actor staff — dry run, then commit bound to that preview, on the CLAIMED row version — and returns the fresh row with the send status kept', async () => {
  const out = await applyLeadServiceForSend(newCustomerRow());
  expect(mockMixCalls.map((c) => [c.actor, c.body.serviceKey, c.body.included, c.body.dryRun === true, c.body.previewBasis || null])).toEqual([
    ['staff', 'lawn_care', false, true, null],
    ['staff', 'lawn_care', false, false, 'digest-1'],
  ]);
  // The rail's CAS compares updated_at: it must see the post-claim version,
  // never the caller's stale object (pre-push codex P1).
  for (const call of mockMixCalls) expect(call.estimate.updated_at).toBe(CLAIMED_AT);
  expect(mockMixCalls[0].estimate.status).toBe('sending');
  expect(out.monthly_total).toBe(40);
  expect(out.status).toBe('sending');
});

test('lead follows the estimator\'s selection order', async () => {
  const row = newCustomerRow();
  const data = JSON.parse(row.estimate_data);
  data.engineRequest.selectedServices = ['LAWN', 'PEST'];
  row.estimate_data = JSON.stringify(data);
  mockRows.queue = [claimedRowFor(row), parkedRow];
  await applyLeadServiceForSend(row);
  expect(mockMixCalls[0].body.serviceKey).toBe('pest_control');
});

test('gate off → untouched, no rail call', async () => {
  mockGates.estimateLeadServiceSend = false;
  const row = newCustomerRow();
  expect(await applyLeadServiceForSend(row)).toBe(row);
  expect(mockMixCalls).toHaveLength(0);
});

test('members, grouped, commercial, locked, already-shaped and single-line rows are untouched', async () => {
  const cases = [
    newCustomerRow({ estimate_group_id: 'g1' }),
    newCustomerRow({ category: 'COMMERCIAL' }),
    newCustomerRow({ price_locked_at: 'x' }),
    newCustomerRow({ estimate_data: JSON.stringify({ membershipSnapshot: { isExistingCustomer: true }, engineRequest: { profile: {}, selectedServices: ['PEST', 'LAWN'], options: {} } }) }),
    newCustomerRow({ estimate_data: JSON.stringify({ priorQualifyingServices: ['pest_control'], engineRequest: { profile: {}, selectedServices: ['PEST', 'LAWN'], options: {} } }) }),
    newCustomerRow({ estimate_data: JSON.stringify({ serviceOptOut: { events: [] }, engineRequest: { profile: {}, selectedServices: ['PEST', 'LAWN'], options: {} } }) }),
    newCustomerRow({ estimate_data: JSON.stringify({ engineRequest: { profile: {}, selectedServices: ['PEST'], options: {} }, inputs: { services: { pest: {} } } }) }),
  ];
  for (const row of cases) {
    mockRows.queue = [claimedRowFor(row), parkedRow];
    expect(await applyLeadServiceForSend(row)).toBe(row);
  }
  expect(mockMixCalls).toHaveLength(0);
});

test('member evidence in any carrier — the recurring-customer flag included — and a live active plan are never parked; a lookup failure fails CLOSED', async () => {
  const run = async (row) => { mockRows.queue = [claimedRowFor(row), parkedRow]; return applyLeadServiceForSend(row); };
  const flagged = newCustomerRow({ estimate_data: JSON.stringify({ engineRequest: { profile: {}, selectedServices: ['PEST', 'LAWN'], options: { recurringCustomer: 'yes' } } }) });
  expect(await run(flagged)).toBe(flagged);
  const flaggedInputs = newCustomerRow({ estimate_data: JSON.stringify({ engineInputs: { isRecurringCustomer: true, services: { pest: {}, lawn: {} } }, engineRequest: { profile: {}, selectedServices: ['PEST', 'LAWN'], options: {} } }) });
  expect(await run(flaggedInputs)).toBe(flaggedInputs);
  mockPlan.active = true;
  const live = newCustomerRow({ customer_id: 'cust-1' });
  expect(await run(live)).toBe(live);
  mockPlan.active = false;
  mockPlan.throws = true;
  const broken = newCustomerRow({ customer_id: 'cust-1' });
  expect(await run(broken)).toBe(broken);
  expect(mockMixCalls).toHaveLength(0);
  // A linked NON-member still gets the lead-service shape.
  mockPlan.throws = false;
  await run(newCustomerRow({ customer_id: 'cust-1' }));
  expect(mockMixCalls).toHaveLength(2);
});

test('a refused preview never blocks the send — the full bundle goes out as today, untouched object', async () => {
  mockMix.responder = () => ({ status: 409, body: { error: 'reprice_unavailable' } });
  const row = newCustomerRow();
  expect(await applyLeadServiceForSend(row)).toBe(row);
  expect(mockMixCalls).toHaveLength(1);
});

test('a three-line estimate is never shaped — one atomic park or nothing (pre-push codex P0)', async () => {
  const estimatePublic = require('../routes/estimate-public');
  estimatePublic.buildPricingBundle.mockResolvedValueOnce({
    services: [{ key: 'pest_control', isRecurring: true }, { key: 'lawn_care', isRecurring: true }, { key: 'mosquito', isRecurring: true }],
  });
  const row = newCustomerRow({ estimate_data: JSON.stringify({ engineRequest: { profile: {}, selectedServices: ['PEST', 'LAWN', 'MOSQUITO'], options: {} }, inputs: { services: { pest: {}, lawn: {}, mosquito: {} } } }) });
  mockRows.queue = [claimedRowFor(row), parkedRow];
  expect(await applyLeadServiceForSend(row)).toBe(row);
  expect(mockMixCalls).toHaveLength(0);
});

test('an archived or locked claimed row is left alone', async () => {
  const row = newCustomerRow();
  mockRows.queue = [{ ...claimedRowFor(row), archived_at: 'x' }, parkedRow];
  expect(await applyLeadServiceForSend(row)).toBe(row);
  expect(mockMixCalls).toHaveLength(0);
});

test('a throwing rail is swallowed, not surfaced to the send', async () => {
  mockMix.responder = () => { throw new Error('boom'); };
  const row = newCustomerRow();
  expect(await applyLeadServiceForSend(row)).toBe(row);
});
