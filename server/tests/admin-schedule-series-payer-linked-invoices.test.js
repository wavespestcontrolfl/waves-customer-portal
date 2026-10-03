process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.setTimeout(30000);

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/admin-auth', () => {
  const actual = jest.requireActual('../middleware/admin-auth');
  return {
    ...actual,
    adminAuthenticate: (req, _res, next) => {
      req.technician = { id: 'staff-1', role: 'admin' };
      req.technicianId = 'staff-1';
      req.techRole = 'admin';
      return next();
    },
  };
});
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/dispatch-assignment', () => ({
  ...jest.requireActual('../services/dispatch-assignment'),
  assignDispatchJob: jest.fn(),
  emitDispatchJobUpdate: jest.fn(),
}));
jest.mock('../services/scheduling/occupancy', () => {
  const actual = jest.requireActual('../services/scheduling/occupancy');
  const mocked = {
    ...actual,
    acquireOccupancyLock: jest.fn().mockResolvedValue(undefined),
    findConflictingVisits: jest.fn().mockResolvedValue([]),
  };
  mocked.acquireOccupancyLocks = jest.fn(async (trx, dates) => {
    const sorted = [...new Set((dates || []).filter(Boolean).map((d) => String(d).split('T')[0]))].sort();
    for (const d of sorted) await mocked.acquireOccupancyLock(trx, d);
  });
  return mocked;
});
jest.mock('../utils/customer-comms-lock', () => ({
  lockCustomerComms: jest.fn().mockResolvedValue(undefined),
  withCustomerCommsLock: jest.fn(async (db, customerId, fn) => db.transaction(async (trx) => fn(trx))),
}));
jest.mock('../sockets', () => ({
  getIo: jest.fn(() => ({ to: jest.fn(() => ({ emit: jest.fn() })) })),
}));

const db = require('../models/db');
jest.mock('../services/call-booking-catalog', () => ({
  ...jest.requireActual('../services/call-booking-catalog'),
  shiftCallFollowUpsForParentMove: jest.fn().mockResolvedValue(0),
}));
const { acquireOccupancyLock, findConflictingVisits } = require('../services/scheduling/occupancy');
const { lockCustomerComms } = require('../utils/customer-comms-lock');
const express = require('express');
const adminScheduleRouter = require('../routes/admin-schedule');
const { NOT_ASSIGNABLE } = require('../services/technician-eligibility');
const { assignDispatchJob } = require('../services/dispatch-assignment');

jest.mock('../services/visit-linked-invoice-withdrawal', () => ({
  linkedInvoiceChargeInFlight: jest.fn().mockResolvedValue(false),
  withdrawLinkedInvoicesForOwner: jest.fn().mockResolvedValue([]),
  reconcileLinkedInvoices: jest.fn().mockResolvedValue(0),
  linkedVisitIdsForCustomers: jest.fn().mockResolvedValue([]),
  visitOwnerTransitions: jest.fn().mockResolvedValue([{ visitId: 'svc-1', beforeOwner: null, afterOwner: '7', moved: true }]),
}));
jest.mock('../services/visit-completion-packets', () => ({
  ...jest.requireActual('../services/visit-completion-packets'),
  packetInvoiceSendInFlight: jest.fn().mockResolvedValue(false),
  reconcileWithdrawnPacketInvoices: jest.fn().mockResolvedValue(0),
  withdrawPacketInvoicesForOwner: jest.fn().mockResolvedValue([]),
}));
jest.mock('../services/pay-combined', () => ({
  ...jest.requireActual('../services/pay-combined'),
  lockCombinedCustomers: jest.fn().mockResolvedValue(undefined),
  releaseUnconfirmedCombinedSessionsForScheduledServices: jest.fn().mockResolvedValue({ released: 0, inFlight: 0 }),
}));

const Linked = require('../services/visit-linked-invoice-withdrawal');

const parent = { id: 'svc-1', customer_id: 'cust-1', scheduled_date: '2099-07-01', day: '2099-07-01', window_start: '09:00:00', window_end: '10:00:00',
  status: 'confirmed', technician_id: null, service_type: 'General Pest Control', is_recurring: true, recurring_parent_id: null, payer_id: null };

function chain(row) {
  const builder = {};
  const self = () => builder;
  for (const m of ['where', 'whereIn', 'whereNotIn', 'whereNull', 'whereNotNull', 'whereRaw', 'orWhereRaw', 'orderBy', 'orderByRaw', 'limit', 'select', 'forUpdate', 'forShare', 'forNoKeyUpdate', 'returning', 'leftJoin', 'join', 'groupBy', 'distinct', 'andWhere', 'orWhere', 'modify', 'clone']) {
    builder[m] = jest.fn(self);
  }
  builder.first = jest.fn().mockResolvedValue(row);
  builder.pluck = jest.fn().mockResolvedValue([]);
  builder.count = jest.fn().mockResolvedValue([{ count: '0' }]);
  builder.update = jest.fn().mockResolvedValue(1);
  builder.insert = jest.fn(() => ({ returning: jest.fn().mockResolvedValue([{ ...row, id: 'new-1' }]), onConflict: jest.fn(() => ({ ignore: jest.fn().mockResolvedValue([]) })) }));
  builder.del = jest.fn().mockResolvedValue(0);
  builder.columnInfo = jest.fn().mockResolvedValue({ payer_id: {}, self_pay_override: {}, po_number: {}, source_action: {} });
  builder.then = (resolve, reject) => Promise.resolve(row === undefined ? [] : [row]).then(resolve, reject);
  return builder;
}

let server;
let baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/schedule', adminScheduleRouter);
  app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ error: err.message, code: err.code }));
  server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.close(done); });

const scheduledChains = [];
let statusReads = 0;

function setup(parentPayerId = null) {
  scheduledChains.length = 0;
  statusReads = 0;
  const parentRow = { ...parent, payer_id: parentPayerId };
  db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  db.fn = { now: jest.fn(() => 'now()') };
  db.mockImplementation((table) => chain(table === 'scheduled_services' ? { ...parentRow } : undefined));
  const trx = jest.fn((table) => {
    if (table === 'technicians') return chain({ id: 'any-tech', role: 'technician', employment_status: 'active', field_dispatchable: true, active: true });
    const c = chain(table === 'scheduled_services' ? { ...parentRow } : (table === 'customers' ? { id: 'cust-1' } : undefined));
    if (table === 'scheduled_services') {
      // Children of the series: one still pending, one already completed.
      scheduledChains.push(c);
      c.pluck = jest.fn(async (col) => {
        if (col !== 'id') return [];
        const byStatus = c.whereIn.mock.calls.some(([column]) => column === 'status');
        if (!byStatus) return ['child-pending', 'child-completed'];
        // A later re-read of the pending/confirmed children would see one more (it flipped after the snapshot).
        statusReads += 1;
        return statusReads === 1 ? ['child-pending'] : ['child-pending', 'child-late'];
      });
      c.update = jest.fn(() => Object.assign(Promise.resolve(1), { returning: jest.fn(async () => [{ id: 'child-pending' }]) }));
    }
    return c;
  });
  trx.raw = jest.fn(async (sql, bindings) => ({ sql, bindings, rows: [] }));
  trx.fn = { now: jest.fn(() => 'now()') };
  trx.transaction = jest.fn(async (cb) => cb(trx));
  db.transaction = jest.fn(async (cb) => cb(trx));
}

beforeEach(() => { jest.clearAllMocks(); setup(); });
const PayCombined = require('../services/pay-combined');
const Packets = require('../services/visit-completion-packets');

test('series Bill-To change fences, and withdraws for, only the children it rewrites (pending / confirmed), not completed ones', async () => {
  const res = await fetch(`${baseUrl}/api/admin/schedule/svc-1/update-details`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ payerId: 7 }),
  });
  expect(res.status).toBe(200);
  expect(Linked.linkedInvoiceChargeInFlight).toHaveBeenCalledWith(expect.anything(), { scheduledServiceIds: ['child-pending'] }, expect.anything());
  expect(Linked.withdrawLinkedInvoicesForOwner).toHaveBeenCalledWith(expect.anything(), { scheduledServiceIds: ['child-pending'] });
});

test('a send in flight on a rewritten child refuses the series Bill-To change with the 409', async () => {
  Linked.linkedInvoiceChargeInFlight.mockResolvedValueOnce(true);
  const res = await fetch(`${baseUrl}/api/admin/schedule/svc-1/update-details`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ payerId: 7 }),
  });
  expect(res.status).toBe(409);
  expect((await res.json()).code).toBe('invoice_send_in_flight');
  expect(Linked.withdrawLinkedInvoicesForOwner).not.toHaveBeenCalled();
});

test('clearing a series payer that reveals the customer default runs the packet AND the linked pipelines from the same moved-to-a-payer answer', async () => {
  setup(7); // the parent names an inactive payer 7 today; the edit clears it and the active default takes over
  Linked.visitOwnerTransitions.mockResolvedValueOnce([
    { visitId: 'svc-1', beforeOwner: null, afterOwner: '9', moved: true },
    { visitId: 'child-pending', beforeOwner: null, afterOwner: '9', moved: true },
  ]);
  const res = await fetch(`${baseUrl}/api/admin/schedule/svc-1/update-details`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ payerId: null }),
  });
  expect(res.status).toBe(200);
  const pending = { visitPatch: { visitIds: ['svc-1', 'child-pending'], payer_id: null } };
  expect(Linked.visitOwnerTransitions).toHaveBeenCalledWith(expect.anything(), ['svc-1', 'child-pending'], { pending, lock: true });
  // Fenced and checkout-invalidated on the pending write, not on a submitted payer id.
  expect(Linked.linkedInvoiceChargeInFlight).toHaveBeenCalledWith(expect.anything(), { scheduledServiceIds: ['child-pending'] }, { pending });
  // The combined packet checkout is released (no linked-only narrowing)...
  expect(PayCombined.releaseUnconfirmedCombinedSessionsForScheduledServices).toHaveBeenCalledWith(
    expect.anything(), expect.arrayContaining(['svc-1', 'child-pending']),
    expect.objectContaining({ pending, invalidateVisitIds: ['svc-1', 'child-pending'] }),
  );
  expect(PayCombined.releaseUnconfirmedCombinedSessionsForScheduledServices.mock.calls[0][2]).not.toHaveProperty('linkedOnly');
  // ...the packet withdrawal runs for the visit, and the linked one for the rewritten children.
  expect(Packets.withdrawPacketInvoicesForOwner).toHaveBeenCalledWith(expect.anything(), { scheduledServiceId: 'svc-1' });
  expect(Linked.withdrawLinkedInvoicesForOwner).toHaveBeenCalledWith(expect.anything(), { scheduledServiceIds: ['child-pending'] });
});

test('a payer edit that moves nobody to a payer (an inactive payer assigned) releases and withdraws nothing', async () => {
  Linked.visitOwnerTransitions.mockResolvedValueOnce([{ visitId: 'svc-1', beforeOwner: null, afterOwner: null, moved: false }]);
  const res = await fetch(`${baseUrl}/api/admin/schedule/svc-1/update-details`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ payerId: 7 }),
  });
  expect(res.status).toBe(200);
  expect(PayCombined.releaseUnconfirmedCombinedSessionsForScheduledServices).not.toHaveBeenCalled();
  expect(Packets.withdrawPacketInvoicesForOwner).not.toHaveBeenCalled();
});

test('a PO-only series edit propagates the PO and runs no Bill-To pipeline for the children', async () => {
  const res = await fetch(`${baseUrl}/api/admin/schedule/svc-1/update-details`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ poNumber: 'PO-FIXTURE-1' }),
  });
  expect(res.status).toBe(200);
  expect(Linked.linkedInvoiceChargeInFlight).not.toHaveBeenCalled();
  expect(Linked.reconcileLinkedInvoices).not.toHaveBeenCalled();
  expect(Linked.withdrawLinkedInvoicesForOwner).not.toHaveBeenCalled();
  // The PO still reaches the pinned (locked) children, by id.
  const updateChain = scheduledChains.find((c) => c.update.mock.calls.some(([data]) => data && Object.keys(data).join() === 'po_number') && c.whereIn.mock.calls.some(([column]) => column === 'id'));
  expect(updateChain.whereIn).toHaveBeenCalledWith('id', ['child-pending']);
});

test('the series propagation, fence, checkout release and withdrawal all use ONE locked, pinned child set', async () => {
  const res = await fetch(`${baseUrl}/api/admin/schedule/svc-1/update-details`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ payerId: 7 }),
  });
  expect(res.status).toBe(200);
  // The pending/confirmed children were read once, under FOR UPDATE...
  const statusReadChains = scheduledChains.filter((c) => c.whereIn.mock.calls.some(([column]) => column === 'status'));
  expect(statusReadChains).toHaveLength(1);
  expect(statusReadChains[0].forUpdate).toHaveBeenCalled();
  expect(statusReads).toBe(1);
  // ...the UPDATE names those ids (a child that flipped to pending since is not rewritten)...
  const updateChain = scheduledChains.find((c) => c.update.mock.calls.length && c.whereIn.mock.calls.some(([column]) => column === 'id'));
  expect(updateChain.whereIn).toHaveBeenCalledWith('id', ['child-pending']);
  expect(updateChain.whereIn.mock.calls.some(([column]) => column === 'status')).toBe(false);
  // ...and the fence, the checkout release and the withdrawal see the same set, never 'child-late'.
  const pinned = ['child-pending'];
  expect(Linked.linkedInvoiceChargeInFlight).toHaveBeenCalledWith(expect.anything(), { scheduledServiceIds: pinned }, expect.anything());
  expect(PayCombined.releaseUnconfirmedCombinedSessionsForScheduledServices).toHaveBeenCalledWith(
    expect.anything(), expect.anything(), expect.objectContaining({ invalidateVisitIds: ['svc-1', ...pinned] }),
  );
  expect(Linked.withdrawLinkedInvoicesForOwner).toHaveBeenCalledWith(expect.anything(), { scheduledServiceIds: pinned });
  expect(JSON.stringify(Linked.withdrawLinkedInvoicesForOwner.mock.calls)).not.toContain('child-late');
});
