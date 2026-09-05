// The three writers every schedule change passes through hang the tech
// notice AFTER commit with the right sides: assignDispatchJob (previous +
// new tech), transitionJobStatus → cancelled (assigned tech + actor). The
// rebooker's hook is asserted in rebooker-live-reschedule-override.test.js.
const mockNotifyAssignmentChange = jest.fn().mockReturnValue(null);
const mockNotifyVisitCancelled = jest.fn().mockReturnValue(null);

jest.mock('../models/db', () => jest.fn());
jest.mock('../sockets', () => ({ getIo: jest.fn(() => null) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/stamped-address', () => ({ stampedDivergesSql: () => 'FALSE', stampedLine2Sql: () => 'NULL' }));
jest.mock('../services/scheduling/tech-day-lock', () => ({ lockTechDays: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/visit-groups', () => ({
  handleChildStopChanged: jest.fn().mockResolvedValue(undefined),
  handleChildTerminal: jest.fn().mockResolvedValue(undefined),
  maybeGroupRow: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../services/appointment-reminders', () => ({
  releaseMoveHoldIfRepaired: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../services/tech-visit-notifications', () => ({
  notifyAssignmentChange: (...args) => mockNotifyAssignmentChange(...args),
  notifyVisitCancelled: (...args) => mockNotifyVisitCancelled(...args),
  notifyVisitRescheduled: jest.fn(),
}));

const db = require('../models/db');

const JOB = { id: 'job-1', status: 'confirmed', technician_id: 't-old', scheduled_date: '2026-09-10' };
const ASSIGNABLE = { id: 't-new', name: 'Tech Two', employment_status: 'active', field_dispatchable: true };

// A transaction whose scheduled_services update returns the moved row.
function assignmentTrx() {
  const trx = jest.fn((table) => {
    const c = {};
    for (const m of ['where', 'whereNotIn', 'whereRaw', 'whereNull', 'modify', 'forShare']) c[m] = jest.fn(() => c);
    if (table === 'technicians') { c.first = jest.fn(async () => ASSIGNABLE); return c; }
    if (table === 'scheduled_services') {
      // Bare first() is the pre-row read (caller-trx path); first(raw) is the day key.
      c.first = jest.fn(async (arg) => (arg === undefined ? JOB : { day: '2026-09-10' }));
      c.update = jest.fn(() => c);
      c.returning = jest.fn(async () => [{ ...JOB, technician_id: 't-new', route_order: null }]);
      return c;
    }
    if (table === 'dispatch_alerts') { c.select = jest.fn(async () => []); return c; }
    throw new Error(`unexpected trx table ${table}`);
  });
  trx.raw = jest.fn((sql) => sql);
  trx.fn = { now: () => new Date() };
  trx.isTransaction = true;
  return trx;
}

describe('assignDispatchJob → tech notice', () => {
  let assignDispatchJob;
  beforeEach(() => {
    jest.clearAllMocks();
    const jobChain = { where: jest.fn(() => jobChain), first: jest.fn(async () => JOB) };
    const techChain = { where: jest.fn(() => techChain), first: jest.fn(async () => ASSIGNABLE) };
    db.mockImplementation((table) => (table === 'scheduled_services' ? jobChain : techChain));
    db.transaction = jest.fn(async (cb) => cb(assignmentTrx()));
    ({ assignDispatchJob } = require('../services/dispatch-assignment'));
  });

  test('hands the writer both sides, the actor, and the caller trx (post-commit hook lives in the service)', async () => {
    const out = await assignDispatchJob({ jobId: 'job-1', technicianId: 't-new', actorId: 'adam' });
    expect(out.changed).not.toBe(false);
    expect(mockNotifyAssignmentChange).toHaveBeenCalledTimes(1);
    expect(mockNotifyAssignmentChange).toHaveBeenCalledWith({
      visitId: 'job-1', fromTechId: 't-old', toTechId: 't-new', actorId: 'adam', trx: null,
      // The committed schedule rides along so the card never re-reads a later move.
      snapshot: { date: '2026-09-10', windowStart: undefined, windowEnd: undefined },
    });
  });

  test('a caller that will rewrite the schedule in the same trx overrides the row snapshot (edit modal: tech + date)', async () => {
    const trx = assignmentTrx();
    await assignDispatchJob({
      jobId: 'job-1', technicianId: 't-new', actorId: 'adam', trx,
      noticeSnapshot: { date: '2026-09-14', windowStart: '13:00', windowEnd: undefined },
    });
    expect(mockNotifyAssignmentChange).toHaveBeenCalledWith(expect.objectContaining({
      snapshot: { date: '2026-09-14', windowStart: '13:00', windowEnd: undefined },
    }));
  });

  test('a caller-owned trx is passed through so the notice waits for THAT commit', async () => {
    const trx = assignmentTrx();
    await assignDispatchJob({ jobId: 'job-1', technicianId: null, actorId: 'adam', trx });
    expect(mockNotifyAssignmentChange).toHaveBeenCalledWith(expect.objectContaining({ fromTechId: 't-old', toTechId: null, trx }));
  });

  test('a no-op assignment (same tech) never notifies', async () => {
    const jobChain = { where: jest.fn(() => jobChain), first: jest.fn(async () => ({ ...JOB, technician_id: 't-new' })) };
    const techChain = { where: jest.fn(() => techChain), first: jest.fn(async () => ASSIGNABLE) };
    db.mockImplementation((table) => (table === 'scheduled_services' ? jobChain : techChain));
    const out = await assignDispatchJob({ jobId: 'job-1', technicianId: 't-new', actorId: 'adam' });
    expect(out.changed).toBe(false);
    expect(mockNotifyAssignmentChange).not.toHaveBeenCalled();
  });
});

describe('transitionJobStatus → cancelled tech notice', () => {
  // A permissive knex double: every builder method chains, awaits resolve to
  // [] / a row, so the cancel write path runs end to end without a DB.
  function permissiveTrx(row) {
    const make = () => {
      const c = {};
      const handler = {
        get(_t, prop) {
          if (prop === 'then') return (res, rej) => Promise.resolve([]).then(res, rej);
          if (prop === 'first') return async () => row;
          if (prop === 'pluck' || prop === 'select') return () => proxy;
          if (prop === 'count') return () => ({ first: async () => ({ count: 0 }) });
          if (prop === 'returning') return async () => [row];
          if (prop === 'columnInfo') return async () => ({});
          return () => proxy;
        },
      };
      const proxy = new Proxy(c, handler);
      return proxy;
    };
    const trx = jest.fn(() => make());
    trx.raw = jest.fn((sql) => sql);
    trx.fn = { now: () => new Date() };
    trx.schema = { hasTable: async () => true, hasColumn: async () => true };
    trx.transaction = jest.fn(async (cb) => cb(trx));
    return trx;
  }

  test('the assigned tech is told, with the transitioning staff member as actor, once the write is committed', async () => {
    jest.resetModules();
    jest.doMock('../models/db', () => jest.fn());
    const db2 = require('../models/db');
    const ROW = {
      id: 'job-1', job_id: 'job-1', status: 'confirmed', customer_id: 'c-1', tech_id: 't-1', technician_id: 't-1',
      service_type: 'Pest Control', scheduled_date: '2026-09-10', window_start: '09:00', window_end: '11:00',
      tech_full_name: 'Tech One', cust_first_name: 'Ana',
    };
    const trx = permissiveTrx(ROW);
    db2.mockImplementation(() => trx());
    db2.transaction = jest.fn(async (cb) => cb(trx));
    db2.raw = trx.raw;
    db2.schema = trx.schema;
    const { transitionJobStatus } = require('../services/job-status');

    await transitionJobStatus({ jobId: 'job-1', fromStatus: 'confirmed', toStatus: 'cancelled', transitionedBy: 'virginia' });
    await new Promise((r) => setImmediate(r));

    expect(mockNotifyVisitCancelled).toHaveBeenCalledWith({
      visitId: 'job-1', technicianId: 't-1', actorId: 'virginia',
      snapshot: { date: '2026-09-10', windowStart: '09:00', windowEnd: '11:00' },
      trx: null,
    });
  });

  test('under a caller trx the notice is handed that trx so it waits for the OUTERMOST commit', async () => {
    jest.resetModules();
    jest.doMock('../models/db', () => jest.fn());
    const db2 = require('../models/db');
    const ROW = { id: 'job-1', job_id: 'job-1', status: 'confirmed', customer_id: 'c-1', tech_id: 't-1', technician_id: 't-1' };
    const trx = permissiveTrx(ROW);
    trx.executionPromise = Promise.resolve();
    db2.mockImplementation(() => trx());
    db2.raw = trx.raw;
    db2.schema = trx.schema;
    const { transitionJobStatus } = require('../services/job-status');
    mockNotifyVisitCancelled.mockClear();

    await transitionJobStatus({ jobId: 'job-1', fromStatus: 'confirmed', toStatus: 'cancelled', transitionedBy: 'virginia', trx });
    await new Promise((r) => setImmediate(r));

    expect(mockNotifyVisitCancelled).toHaveBeenCalledWith(expect.objectContaining({ visitId: 'job-1', technicianId: 't-1', trx }));
  });

  test.each([
    ['a caller that may still compensate the cancel (suppressTechNotice)', { fromStatus: 'confirmed', toStatus: 'cancelled', suppressTechNotice: true }],
    ['a cancelled → cancelled retry (idempotent side-effect repair, not a new cancel)', { fromStatus: 'cancelled', toStatus: 'cancelled' }],
  ])('%s never fires the cancel notice', async (_label, args) => {
    jest.resetModules();
    jest.doMock('../models/db', () => jest.fn());
    const db2 = require('../models/db');
    const ROW = { id: 'job-1', job_id: 'job-1', status: args.fromStatus, customer_id: 'c-1', tech_id: 't-1', technician_id: 't-1' };
    const trx = permissiveTrx(ROW);
    db2.mockImplementation(() => trx());
    db2.transaction = jest.fn(async (cb) => cb(trx));
    db2.raw = trx.raw;
    db2.schema = trx.schema;
    const { transitionJobStatus } = require('../services/job-status');
    mockNotifyVisitCancelled.mockClear();

    await transitionJobStatus({ jobId: 'job-1', transitionedBy: 'virginia', ...args });
    await new Promise((r) => setImmediate(r));

    expect(mockNotifyVisitCancelled).not.toHaveBeenCalled();
  });

  test('a non-cancel transition never fires the cancel notice', async () => {
    jest.resetModules();
    jest.doMock('../models/db', () => jest.fn());
    const db2 = require('../models/db');
    const ROW = { id: 'job-1', job_id: 'job-1', status: 'confirmed', customer_id: 'c-1', tech_id: 't-1', technician_id: 't-1' };
    const trx = permissiveTrx(ROW);
    db2.mockImplementation(() => trx());
    db2.transaction = jest.fn(async (cb) => cb(trx));
    db2.raw = trx.raw;
    db2.schema = trx.schema;
    const { transitionJobStatus } = require('../services/job-status');
    mockNotifyVisitCancelled.mockClear();

    await transitionJobStatus({ jobId: 'job-1', fromStatus: 'pending', toStatus: 'confirmed', transitionedBy: 'virginia' });
    await new Promise((r) => setImmediate(r));

    expect(mockNotifyVisitCancelled).not.toHaveBeenCalled();
  });
});

describe('admin-schedule update-details (source order)', () => {
  test('the same-tech move notice is queued right after commit, before the awaited seam / reminder / broadcast / prepay steps', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '../routes/admin-schedule.js'), 'utf8');
    const notice = src.indexOf("if (techMoveForNotice && techMoveForNotice.technicianId && !assignmentNeedsChange) {");
    expect(notice).toBeGreaterThan(-1);
    // The transaction that wrote the edit closes just above the notice…
    const trxClose = src.lastIndexOf('    });\n', notice);
    expect(src.slice(trxClose, notice)).not.toMatch(/await /);
    // …and every awaited post-commit step comes after it.
    for (const step of ['handleChildStopChanged(', 'registerSpawnedVisitReminder(', 'refreshAnnualPrepayTermsForCustomer(']) {
      const idx = src.indexOf(step, trxClose);
      expect(idx).toBeGreaterThan(notice);
    }
  });
});
