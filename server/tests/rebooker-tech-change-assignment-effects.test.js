/**
 * A single-row move that changes the technician (SmartRebooker.reschedule
 * with options.technicianId) has the same assignment side effects as
 * assignDispatchJob: an unassigned visit that gains a technician closes its
 * open unassigned_overdue alerts inside the move transaction, and every open
 * dispatch board gets one update after the commit. A move that keeps the
 * technician does neither; removing the technician updates the board and
 * resolves nothing.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/call-booking-catalog', () => ({
  ...jest.requireActual('../services/call-booking-catalog'),
  shiftCallFollowUpsForParentMove: jest.fn().mockResolvedValue(0),
  planCallFollowUpShift: jest.fn().mockResolvedValue([]),
}));
jest.mock('../services/tech-status', () => ({ clearTechCurrentJob: jest.fn().mockResolvedValue(null) }));
jest.mock('../services/tech-visit-notifications', () => ({
  notifyAssignmentChange: jest.fn().mockResolvedValue(undefined),
  notifyVisitRescheduled: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../services/scheduling/occupancy', () => ({
  findConflictingVisits: jest.fn().mockResolvedValue([]),
  acquireOccupancyLock: jest.fn().mockResolvedValue(undefined),
  acquireOccupancyLocks: jest.fn().mockResolvedValue(undefined),
  techScopedConfirmActive: jest.fn(() => false),
}));
jest.mock('../services/visit-groups', () => ({
  ...jest.requireActual('../services/visit-groups'),
  handleChildStopChanged: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../services/dispatch-assignment', () => ({
  ...jest.requireActual('../services/dispatch-assignment'),
  emitDispatchJobUpdate: jest.fn().mockResolvedValue(null),
}));
const mockIoEmit = jest.fn();
jest.mock('../sockets', () => ({ getIo: jest.fn(() => ({ to: jest.fn(() => ({ emit: mockIoEmit })) })) }));

const db = require('../models/db');
const SmartRebooker = require('../services/rebooker');
const { emitDispatchJobUpdate } = require('../services/dispatch-assignment');
const { parseETDateTime, addETDays, etDateString } = require('../utils/datetime-et');

// reschedule() rejects past dates against the real clock: dynamic fixtures.
const dayOffset = (n) => etDateString(addETDays(parseETDateTime(`${etDateString()}T12:00`), n));
const BASE = dayOffset(10);
const TARGET = dayOffset(12);

function chain(overrides = {}) {
  const builder = {};
  Object.assign(builder, {
    where: jest.fn((arg) => { if (typeof arg === 'function') arg.call(builder, builder); return builder; }),
    orWhere: jest.fn().mockReturnThis(),
    whereIn: jest.fn().mockReturnThis(),
    whereNot: jest.fn().mockReturnThis(),
    whereNotIn: jest.fn().mockReturnThis(),
    whereNull: jest.fn().mockReturnThis(),
    whereRaw: jest.fn().mockReturnThis(),
    orWhereRaw: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    first: jest.fn(),
    insert: jest.fn().mockResolvedValue(),
    count: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    orderByRaw: jest.fn().mockReturnThis(),
  });
  return Object.assign(builder, overrides);
}

// The CAS write resolves to its row count and answers `.returning` with the
// committed row.
function updateResult(technicianId) {
  const p = Promise.resolve(1);
  return { then: p.then.bind(p), catch: p.catch.bind(p), returning: jest.fn().mockResolvedValue([{ id: 'svc-1', technician_id: technicianId }]) };
}

// One single-row move: the visit (technician `from`) and one open
// unassigned_overdue alert. Returns the alert reads and resolves made on the
// move transaction, and each step's order.
function wireMove({ from, to }) {
  const service = {
    id: 'svc-1', customer_id: 'cust-1', technician_id: from, scheduled_date: BASE,
    window_start: '09:00:00', window_end: '11:00:00', status: 'confirmed',
  };
  const steps = [];
  const alertReads = [];
  const alertResolves = [];
  const trx = jest.fn((table) => {
    if (table === 'property_preferences') return chain({ forShare: jest.fn().mockReturnThis(), first: jest.fn().mockResolvedValue(null) });
    if (table === 'scheduled_services') return chain({ update: jest.fn(() => updateResult(to === undefined ? from : to)) });
    if (table === 'job_status_history' || table === 'reschedule_log' || table === 'series_moves' || table === 'technician_absences') return chain();
    if (table === 'technicians') return chain({ first: jest.fn().mockResolvedValue({ id: to, employment_status: 'active', field_dispatchable: true }) });
    if (table === 'dispatch_alerts') {
      const q = chain({
        select: jest.fn(async () => { alertReads.push(q.where.mock.calls.map((c) => c[0])); return [{ id: 'alert-1' }]; }),
        update: jest.fn(() => ({
          returning: jest.fn(async () => {
            steps.push('resolve');
            alertResolves.push({ where: q.where.mock.calls.map((c) => c[0]) });
            return [{ id: 'alert-1', type: 'unassigned_overdue', job_id: 'svc-1', payload: {} }];
          }),
        })),
      });
      return q;
    }
    throw new Error(`Unexpected trx table ${table}`);
  });
  trx.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  trx.fn = { now: jest.fn(() => 'NOW()') };
  db.transaction = jest.fn(async (callback) => { const out = await callback(trx); steps.push('commit'); return out; });
  db.fn = { now: jest.fn(() => 'NOW()') };
  db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  const dbQueries = [chain({ first: jest.fn().mockResolvedValue(service) }), chain({ first: jest.fn().mockResolvedValue({ count: '1' }) })];
  db.mockImplementation((table) => {
    if (table === 'scheduled_services' || table === 'reschedule_log') return dbQueries.shift() || chain();
    return chain();
  });
  emitDispatchJobUpdate.mockImplementation(async () => { steps.push('emit'); return null; });
  return { steps, alertReads, alertResolves };
}

const move = (options) => SmartRebooker.reschedule(
  'svc-1', TARGET, { start: '09:00', end: '11:00' }, 'auto_dispatch', 'auto_dispatch', { qualityDates: new Set(), ...options },
);

beforeEach(() => { jest.clearAllMocks(); });

test('an unassigned visit that gains a technician closes its open unassigned alert in the move, then updates the board once', async () => {
  const { steps, alertReads, alertResolves } = wireMove({ from: null, to: 'tech-2' });

  await expect(move({ technicianId: 'tech-2', actorId: 'staff-1' })).resolves.toMatchObject({ success: true, technicianId: 'tech-2' });

  expect(alertReads).toEqual([[{ type: 'unassigned_overdue', job_id: 'svc-1' }]]);
  expect(alertResolves).toEqual([{ where: [{ id: 'alert-1' }] }]);
  expect(emitDispatchJobUpdate).toHaveBeenCalledTimes(1);
  expect(emitDispatchJobUpdate).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'svc-1', actorId: 'staff-1' }));
  expect(steps).toEqual(['resolve', 'commit', 'emit']);
});

test('a visit that moves from one technician to another updates the board once and reads no unassigned alert', async () => {
  const { alertReads } = wireMove({ from: 'tech-1', to: 'tech-2' });

  await expect(move({ technicianId: 'tech-2' })).resolves.toMatchObject({ success: true });

  expect(alertReads).toEqual([]);
  expect(emitDispatchJobUpdate).toHaveBeenCalledTimes(1);
});

test.each([
  ['the same technician', { technicianId: 'tech-1' }],
  ['no technician option', {}],
])('a move with %s neither resolves an alert nor updates the board', async (_label, options) => {
  const { alertReads } = wireMove({ from: 'tech-1' });

  await expect(move(options)).resolves.toMatchObject({ success: true });

  expect(alertReads).toEqual([]);
  expect(emitDispatchJobUpdate).not.toHaveBeenCalled();
});

test('a move that removes the technician updates the board and resolves nothing', async () => {
  const { alertReads } = wireMove({ from: 'tech-1', to: null });

  await expect(move({ technicianId: null })).resolves.toMatchObject({ success: true });

  expect(alertReads).toEqual([]);
  expect(emitDispatchJobUpdate).toHaveBeenCalledTimes(1);
});
