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
const mockRows = { queue: [], updates: [] };
jest.mock('../models/db', () => {
  const dbh = () => ({
    where: () => ({
      first: async () => (mockRows.queue.length > 1 ? mockRows.queue.shift() : mockRows.queue[0]),
      update: async (payload) => { if (mockRows.updateThrows) throw new Error('db down'); mockRows.updates.push(payload); return 1; },
    }),
  });
  dbh.fn = { now: () => 'now' };
  dbh.raw = (sql, bindings) => ({ sql, bindings });
  return dbh;
});
const mockNotify = { calls: [] };
jest.mock('../services/notification-service', () => ({
  notifyAdmin: jest.fn(async (...args) => { mockNotify.calls.push(args); return { id: 'n-1' }; }),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const mockPlan = { active: false, throws: false };
jest.mock('../services/waveguard-existing-services', () => ({
  isActivePlanCustomer: jest.fn(async () => { if (mockPlan.throws) throw new Error('lookup down'); return mockPlan.active; }),
}));

const { applyLeadServiceForSend, revertLeadServiceForSend, markLeadServiceRevertPending } = require('../routes/admin-estimates');

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
  mockRows.updates.length = 0;
  mockRows.updateThrows = false;
  mockNotify.calls.length = 0;
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

const parkedRowWithEvent = { ...parkedRow, estimate_data: JSON.stringify({ serviceOptOut: { events: [{ serviceKey: 'lawn_care', included: false, actor: 'staff', at: 't1' }] } }) };

test('an undelivered send is compensated: the parked line is restored through the rail as actor staff, dry run then commit', async () => {
  mockRows.queue = [parkedRowWithEvent];
  expect(await revertLeadServiceForSend('est-1', 'lawn_care')).toBe(true);
  expect(mockMixCalls.map((c) => [c.actor, c.body.serviceKey, c.body.included, c.body.dryRun === true, c.body.previewBasis || null])).toEqual([
    ['staff', 'lawn_care', true, true, null],
    ['staff', 'lawn_care', true, false, 'digest-1'],
  ]);
  // Deep copies of the row (GH codex r3 P1), never the row object itself.
  for (const call of mockMixCalls) { expect(call.estimate).toEqual(parkedRowWithEvent); expect(call.estimate).not.toBe(parkedRowWithEvent); }
});

test('revert is idempotent: a line already back on the estimate is successful compensation with no rail call (pre-push codex P1)', async () => {
  const restoredRow = { ...parkedRow, estimate_data: JSON.stringify({ serviceOptOut: { events: [
    { serviceKey: 'lawn_care', included: false, actor: 'staff', at: 't1' },
    { serviceKey: 'lawn_care', included: true, actor: 'customer', at: 't2' },
  ] } }) };
  mockRows.queue = [restoredRow];
  expect(await revertLeadServiceForSend('est-1', 'lawn_care')).toBe(true);
  expect(mockMixCalls).toHaveLength(0);
});

test('a refused or throwing revert is logged, never thrown, and reports false', async () => {
  mockRows.queue = [parkedRowWithEvent];
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

describe('durable revert-pending state (pre-push codex P1)', () => {
  test('a failed compensation writes the marker and pages the office', async () => {
    await markLeadServiceRevertPending({ id: 'est-1', customer_name: 'Pat', customer_id: 'cust-1' }, 'lawn_care');
    expect(mockRows.updates).toHaveLength(1);
    expect(mockRows.updates[0].estimate_data.sql).toContain("'{leadServiceRevertPending}'");
    expect(JSON.parse(mockRows.updates[0].estimate_data.bindings[0])).toMatchObject({ serviceKey: 'lawn_care' });
    expect(mockNotify.calls).toHaveLength(1);
    expect(mockNotify.calls[0][0]).toBe('estimate');
    expect(mockNotify.calls[0][3]).toMatchObject({ bell: true, metadata: { estimateId: 'est-1', serviceKey: 'lawn_care' } });
  });

  test('the next send retries the restore first: success clears the marker and the full bundle goes out untouched', async () => {
    const row = newCustomerRow();
    const claimed = claimedRowFor(row);
    claimed.estimate_data = JSON.stringify({ ...JSON.parse(claimed.estimate_data), serviceOptOut: { events: [{ serviceKey: 'lawn_care', included: false, actor: 'staff', at: 't1' }] }, leadServiceRevertPending: { serviceKey: 'lawn_care', at: 't' } });
    const restoredRow = { ...claimed, monthly_total: 95, estimate_data: JSON.stringify({ serviceOptOut: { events: [] } }), updated_at: '2026-09-01T10:00:20.000Z' };
    mockRows.queue = [claimed, claimed, restoredRow];
    const out = await applyLeadServiceForSend(row);
    // The RESTORED row comes back (with the caller's in-flight status), never
    // the pre-restore object (pre-push codex P0).
    expect(out).toEqual({ estimate: { ...restoredRow, status: 'sending' }, parkedKey: null });
    expect(mockMixCalls.map((c) => [c.body.serviceKey, c.body.included, c.body.dryRun === true])).toEqual([['lawn_care', true, true], ['lawn_care', true, false]]);
    expect(mockRows.updates).toHaveLength(1);
    expect(mockRows.updates[0].estimate_data.sql).toContain("- 'leadServiceRevertPending'");
  });

  test('a retry that still fails aborts the send with a 409, nothing parked', async () => {
    const row = newCustomerRow();
    const claimed = claimedRowFor(row);
    claimed.estimate_data = JSON.stringify({ ...JSON.parse(claimed.estimate_data), serviceOptOut: { events: [{ serviceKey: 'lawn_care', included: false, actor: 'staff', at: 't1' }] }, leadServiceRevertPending: { serviceKey: 'lawn_care', at: 't' } });
    mockRows.queue = [claimed, claimed];
    mockMix.responder = () => ({ status: 409, body: { error: 'estimate_changed_since_preview' } });
    await expect(applyLeadServiceForSend(row)).rejects.toMatchObject({ statusCode: 409, leadServiceAbort: true });
    expect(mockRows.updates).toHaveLength(0);
  });
});

describe('fail-closed marker handling (GH codex r4 P1 x2)', () => {
  test('a marker write failure throws (the send already failed; the outage surfaces)', async () => {
    mockRows.updateThrows = true;
    await expect(markLeadServiceRevertPending({ id: 'est-1', customer_name: 'Pat' }, 'lawn_care')).rejects.toMatchObject({ statusCode: 503 });
    mockRows.updateThrows = false;
    // The office is still paged even when the marker could not persist.
    expect(mockNotify.calls).toHaveLength(1);
  });

  test('a staff-parked line on a never-delivered row is treated as pending even without the marker', async () => {
    const row = newCustomerRow();
    const claimed = claimedRowFor(row);
    claimed.estimate_data = JSON.stringify({ ...JSON.parse(claimed.estimate_data), serviceOptOut: { events: [{ serviceKey: 'lawn_care', included: false, actor: 'staff', at: 't1' }] } });
    const restoredRow = { ...claimed, estimate_data: JSON.stringify({ serviceOptOut: { events: [] } }) };
    mockRows.queue = [claimed, claimed, restoredRow];
    const out = await applyLeadServiceForSend(row);
    expect(out.parkedKey).toBeNull();
    expect(mockMixCalls.map((c) => [c.body.serviceKey, c.body.included])).toEqual([['lawn_care', true], ['lawn_care', true]]);
  });

  test('a delivered row with a staff-parked line (a resend) is NOT treated as pending', async () => {
    const row = newCustomerRow();
    const claimed = claimedRowFor(row);
    // A pre-witness park (no parkId) on a row with ANY handoff witness is a resend, not pending.
    claimed.estimate_data = JSON.stringify({ ...JSON.parse(claimed.estimate_data), leadServiceHandoffAt: '2026-09-01T00:00:00Z', serviceOptOut: { events: [{ serviceKey: 'lawn_care', included: false, actor: 'staff', at: 't1' }] } });
    mockRows.queue = [claimed, claimed];
    expect(await applyLeadServiceForSend(row)).toEqual({ estimate: row, parkedKey: null });
    expect(mockMixCalls).toHaveLength(0);
  });

  test('a marker-clear failure after a successful restore aborts the send', async () => {
    const row = newCustomerRow();
    const claimed = claimedRowFor(row);
    claimed.estimate_data = JSON.stringify({ ...JSON.parse(claimed.estimate_data), serviceOptOut: { events: [{ serviceKey: 'lawn_care', included: false, actor: 'staff', at: 't1' }] }, leadServiceRevertPending: { serviceKey: 'lawn_care', at: 't' } });
    mockRows.queue = [claimed, claimed];
    mockRows.updateThrows = true;
    await expect(applyLeadServiceForSend(row)).rejects.toMatchObject({ statusCode: 503, leadServiceAbort: true });
    mockRows.updateThrows = false;
  });
});

describe('round-five scope pins (GH codex r5)', () => {
  test('a frozen plan_restart quote is never reshaped', async () => {
    for (const row of [newCustomerRow({ source: 'plan_restart' }), newCustomerRow({ estimate_data: JSON.stringify({ planRestart: true, engineRequest: { profile: {}, selectedServices: ['PEST', 'LAWN'], options: {} } }) })]) {
      mockRows.queue = [claimedRowFor(row), parkedRow];
      expect(await applyLeadServiceForSend(row)).toEqual({ estimate: row, parkedKey: null });
    }
    expect(mockMixCalls).toHaveLength(0);
  });

  test('a durable handoff witness for THIS park makes a staff-parked row NOT structurally pending', async () => {
    const row = newCustomerRow();
    const claimed = claimedRowFor(row);
    claimed.estimate_data = JSON.stringify({ ...JSON.parse(claimed.estimate_data), leadServiceHandoffAt: '2026-09-01T00:00:00Z', leadServiceHandoffParkId: 'park-1', serviceOptOut: { events: [{ serviceKey: 'lawn_care', included: false, actor: 'staff', parkId: 'park-1', at: 't1' }] } });
    mockRows.queue = [claimed, claimed];
    expect(await applyLeadServiceForSend(row)).toEqual({ estimate: row, parkedKey: null });
    expect(mockMixCalls).toHaveLength(0);
  });

  test('a prior delivery of an EARLIER shape never hides an undelivered park: witness ids must match (pre-push codex P0)', async () => {
    const row = newCustomerRow();
    const claimed = claimedRowFor(row);
    claimed.estimate_data = JSON.stringify({ ...JSON.parse(claimed.estimate_data), deliveryState: { firstDeliveredAt: '2026-08-01T00:00:00Z' }, leadServiceHandoffAt: '2026-08-01T00:00:00Z', leadServiceHandoffParkId: 'park-old', serviceOptOut: { events: [{ serviceKey: 'lawn_care', included: false, actor: 'staff', parkId: 'park-new', at: 't2' }] } });
    const restoredRow = { ...claimed, estimate_data: JSON.stringify({ serviceOptOut: { events: [] } }) };
    mockRows.queue = [claimed, claimed, restoredRow];
    const out = await applyLeadServiceForSend(row);
    expect(out.parkedKey).toBeNull();
    expect(mockMixCalls.map((c) => [c.body.serviceKey, c.body.included])).toEqual([['lawn_care', true], ['lawn_care', true]]);
  });
});
