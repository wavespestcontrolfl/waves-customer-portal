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

const { applyLeadServiceForSend, revertLeadServiceForSend } = require('../routes/admin-estimates');

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
  const { estimate: out, parkedKey } = await applyLeadServiceForSend(newCustomerRow());
  expect(parkedKey).toBe('lawn_care');
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
  expect(await applyLeadServiceForSend(row)).toEqual({ estimate: row, parkedKey: null });
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
    expect(await applyLeadServiceForSend(row)).toEqual({ estimate: row, parkedKey: null });
  }
  expect(mockMixCalls).toHaveLength(0);
});

test('member evidence in any carrier — the recurring-customer flag included — and a live active plan are never parked; a lookup failure fails CLOSED', async () => {
  const run = async (row) => { mockRows.queue = [claimedRowFor(row), parkedRow]; return applyLeadServiceForSend(row); };
  const flagged = newCustomerRow({ estimate_data: JSON.stringify({ engineRequest: { profile: {}, selectedServices: ['PEST', 'LAWN'], options: { recurringCustomer: 'yes' } } }) });
  expect(await run(flagged)).toEqual({ estimate: flagged, parkedKey: null });
  const flaggedInputs = newCustomerRow({ estimate_data: JSON.stringify({ engineInputs: { isRecurringCustomer: true, services: { pest: {}, lawn: {} } }, engineRequest: { profile: {}, selectedServices: ['PEST', 'LAWN'], options: {} } }) });
  expect(await run(flaggedInputs)).toEqual({ estimate: flaggedInputs, parkedKey: null });
  mockPlan.active = true;
  const live = newCustomerRow({ customer_id: 'cust-1' });
  expect(await run(live)).toEqual({ estimate: live, parkedKey: null });
  mockPlan.active = false;
  mockPlan.throws = true;
  const broken = newCustomerRow({ customer_id: 'cust-1' });
  expect(await run(broken)).toEqual({ estimate: broken, parkedKey: null });
  expect(mockMixCalls).toHaveLength(0);
  // A linked NON-member still gets the lead-service shape.
  mockPlan.throws = false;
  await run(newCustomerRow({ customer_id: 'cust-1' }));
  expect(mockMixCalls).toHaveLength(2);
});

test('a refused preview never blocks the send — the full bundle goes out as today, untouched object', async () => {
  mockMix.responder = () => ({ status: 409, body: { error: 'reprice_unavailable' } });
  const row = newCustomerRow();
  expect(await applyLeadServiceForSend(row)).toEqual({ estimate: row, parkedKey: null });
  expect(mockMixCalls).toHaveLength(1);
});

test('a three-line estimate is never shaped — one atomic park or nothing (pre-push codex P0)', async () => {
  const estimatePublic = require('../routes/estimate-public');
  estimatePublic.buildPricingBundle.mockResolvedValueOnce({
    services: [{ key: 'pest_control', isRecurring: true }, { key: 'lawn_care', isRecurring: true }, { key: 'mosquito', isRecurring: true }],
  });
  const row = newCustomerRow({ estimate_data: JSON.stringify({ engineRequest: { profile: {}, selectedServices: ['PEST', 'LAWN', 'MOSQUITO'], options: {} }, inputs: { services: { pest: {}, lawn: {}, mosquito: {} } } }) });
  mockRows.queue = [claimedRowFor(row), parkedRow];
  expect(await applyLeadServiceForSend(row)).toEqual({ estimate: row, parkedKey: null });
  expect(mockMixCalls).toHaveLength(0);
});

test('an archived or locked claimed row is left alone', async () => {
  const row = newCustomerRow();
  mockRows.queue = [{ ...claimedRowFor(row), archived_at: 'x' }, parkedRow];
  expect(await applyLeadServiceForSend(row)).toEqual({ estimate: row, parkedKey: null });
  expect(mockMixCalls).toHaveLength(0);
});

test('a throwing rail is swallowed, not surfaced to the send', async () => {
  mockMix.responder = () => { throw new Error('boom'); };
  const row = newCustomerRow();
  expect(await applyLeadServiceForSend(row)).toEqual({ estimate: row, parkedKey: null });
});

test('an undelivered send is compensated: the parked line is restored through the rail as actor staff, dry run then commit', async () => {
  mockRows.queue = [parkedRow];
  expect(await revertLeadServiceForSend('est-1', 'lawn_care')).toBe(true);
  expect(mockMixCalls.map((c) => [c.actor, c.body.serviceKey, c.body.included, c.body.dryRun === true, c.body.previewBasis || null])).toEqual([
    ['staff', 'lawn_care', true, true, null],
    ['staff', 'lawn_care', true, false, 'digest-1'],
  ]);
  // Deep copies of the row (GH codex r3 P1), never the row object itself.
  for (const call of mockMixCalls) { expect(call.estimate).toEqual(parkedRow); expect(call.estimate).not.toBe(parkedRow); }
});

test('a refused or throwing revert is logged, never thrown, and reports false', async () => {
  mockRows.queue = [parkedRow];
  mockMix.responder = () => ({ status: 409, body: { error: 'estimate_changed_since_preview' } });
  expect(await revertLeadServiceForSend('est-1', 'lawn_care')).toBe(false);
  mockMix.responder = () => { throw new Error('boom'); };
  expect(await revertLeadServiceForSend('est-1', 'lawn_care')).toBe(false);
  mockRows.queue = [{ ...parkedRow, archived_at: 'x' }];
  mockMix.responder = () => ({ status: 200, body: { previewBasis: 'd' } });
  expect(await revertLeadServiceForSend('est-1', 'lawn_care')).toBe(false);
});

test('a post-commit reread failure aborts the send with the parked key preserved for compensation (pre-push codex P1)', async () => {
  const row = newCustomerRow();
  // Claimed row first, then NO row on the post-park reread.
  mockRows.queue = [claimedRowFor(row), null];
  const leadShapeRef = { parkedKey: null };
  await expect(applyLeadServiceForSend(row, { leadShapeRef })).rejects.toMatchObject({ statusCode: 503, leadServiceParkedKey: 'lawn_care' });
  expect(leadShapeRef.parkedKey).toBe('lawn_care');
  expect(mockMixCalls).toHaveLength(2);
});

test('a pre-commit failure is still swallowed (nothing was parked)', async () => {
  const row = newCustomerRow();
  mockRows.queue = [claimedRowFor(row), parkedRow];
  const leadShapeRef = { parkedKey: null };
  mockMix.responder = ({ body }) => { if (body.dryRun) throw new Error('boom'); return { status: 200, body: {} }; };
  expect(await applyLeadServiceForSend(row, { leadShapeRef })).toEqual({ estimate: row, parkedKey: null });
  expect(leadShapeRef.parkedKey).toBeNull();
});

test('a row that became grouped or non-residential between the read and the claim is left alone', async () => {
  for (const patch of [{ estimate_group_id: 'g-late' }, { category: 'COMMERCIAL' }]) {
    const row = newCustomerRow();
    mockRows.queue = [{ ...claimedRowFor(row), ...patch }, parkedRow];
    expect(await applyLeadServiceForSend(row)).toEqual({ estimate: row, parkedKey: null });
  }
  expect(mockMixCalls).toHaveLength(0);
});

test('the rail never receives the row object itself: each dry run and commit gets its own deep copy (GH codex r3 P1)', async () => {
  const row = newCustomerRow();
  const claimed = claimedRowFor(row);
  // JSONB hydrated as an OBJECT — the shape that made the dry run mutate the row.
  claimed.estimate_data = JSON.parse(claimed.estimate_data);
  mockRows.queue = [claimed, parkedRow];
  await applyLeadServiceForSend(row);
  expect(mockMixCalls).toHaveLength(2);
  const [preview, commit] = mockMixCalls;
  expect(preview.estimate).not.toBe(claimed);
  expect(commit.estimate).not.toBe(claimed);
  expect(preview.estimate).not.toBe(commit.estimate);
  expect(preview.estimate.estimate_data).not.toBe(claimed.estimate_data);
  expect(commit.estimate.estimate_data).not.toBe(preview.estimate.estimate_data);
  expect(commit.estimate.estimate_data).toEqual(claimed.estimate_data);
});
