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

  test('noticeActorId names the card\'s actor while actorId (resolved_by / broadcast) stays the staff row or null', async () => {
    await assignDispatchJob({ jobId: 'job-1', technicianId: 't-new', actorId: null, noticeActorId: 'customer_self_serve' });
    expect(mockNotifyAssignmentChange).toHaveBeenCalledWith(expect.objectContaining({ actorId: 'customer_self_serve' }));
    // Only an explicit noticeActorId overrides — an omitted one falls back to the staff actor.
    mockNotifyAssignmentChange.mockClear();
    await assignDispatchJob({ jobId: 'job-1', technicianId: 't-new', actorId: 'adam' });
    expect(mockNotifyAssignmentChange).toHaveBeenCalledWith(expect.objectContaining({ actorId: 'adam' }));
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
      // The status it transitioned FROM: a pending voice-agent booking cancelled
      // before its office confirm stays silent (the row reads cancelled by now).
      previousStatus: 'confirmed',
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

describe('direct creators tell the tech (source order)', () => {
  const fs = require('fs');
  const path = require('path');
  const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');

  test('IB create_appointment queues the "new visit" card right after commit, with the acting staff row', () => {
    const src = read('../services/intelligence-bar/tools.js');
    expect(src).toContain("case 'create_appointment': return await createAppointment(input, actionContext);");
    const fn = src.slice(src.indexOf('async function createAppointment(input, actionContext = {})'), src.indexOf('async function rescheduleAppointment('));
    const notice = fn.indexOf("notifyTechVisitChange({\n      visitId: appointment.id, kind: 'assigned', technicianId: technician_id, actorId: actionContext.technicianId || null,");
    expect(notice).toBeGreaterThan(-1);
    // Before the awaited redemption and reminder registration.
    expect(notice).toBeLessThan(fn.indexOf('redeemInspectionCreditForBooking('));
    expect(notice).toBeLessThan(fn.indexOf("require('../appointment-reminders')"));
  });

  test('a phone booking announces the fresh primary and a fresh follow-up child, never a reused row', () => {
    const src = read('../services/call-recording-processor.js');
    const at = src.indexOf('scheduledServiceId = svc.id;');
    const block = src.slice(at, at + 1500);
    expect(block).toContain("...(!reusedExistingSchedule || (reuseAssignedTechId && String(svc.technician_id) === String(reuseAssignedTechId)) ? [svc] : []),");
    expect(block).toContain('...(followUpCreated && followUpCreated.id ? [followUpCreated] : [])');
    expect(block).toContain("kind: 'assigned', technicianId: row.technician_id, actorId: null,");
  });

  test('IB assign_technician and swap_tech_assignments snapshot the COMMITTED schedule (UPDATE RETURNING), and move_stops_to_day names the committed holder', () => {
    const src = read('../services/intelligence-bar/schedule-tools.js');
    // assign: the notice loop walks the rows the UPDATE reassigned.
    expect(src).toContain("committedAssignRows = await trx('scheduled_services')");
    expect(src).toContain(".returning(['id', 'scheduled_date', 'window_start', 'window_end']);");
    expect(src).toContain("for (const row of committedAssignRows) {");
    expect(src).toContain("snapshot: { date: row.scheduled_date, windowStart: row.window_start || null, windowEnd: row.window_end || null },");
    // swap: both reassigning updates return the committed rows the snapshots use.
    expect(src).toContain("const swapRows = new Map(committedSwapRows.map((r) => [String(r.id), r]));");
    expect((src.match(/\.returning\(swapReturning\)/g) || []).length).toBe(2);
    expect(src).toContain(".returning(['id', 'technician_id']);\n      if (committedRows.length === 0) {");
    expect(src).toContain('technicianId: c.committedTechId,');
  });
});

describe('cancel-flow plan hold (source order)', () => {
  test('every per-move notice is suppressed (forward AND revert); startHold RETURNS the notices and the action emits them only once every family + Away Mode stand', () => {
    const fs = require('fs');
    const path = require('path');
    const holds = fs.readFileSync(path.join(__dirname, '../services/cancellation-resolution/holds.js'), 'utf8');
    expect(holds).toContain("}, 'plan_hold', 'customer', { suppressTechNotice: true });");
    expect(holds).toContain("'plan_hold_revert', 'customer', { suppressTechNotice: true });");
    // startHold never emits: the notices are built after the last
    // compensation point and handed back to the caller.
    expect(holds).not.toContain('void techNotices.notifyVisitRescheduled(');
    const compensate = holds.indexOf("throw codedError('hold_setup_failed'");
    const built = holds.indexOf('const techNotices = moved');
    expect(built).toBeGreaterThan(compensate);
    expect(holds).toContain('moved: moved.length, techNotices };');
    // The recipient is the holder on the COMMITTED move (rebooker result).
    expect(holds).toContain("movedTechIds.set(String(visit.id), moveResult?.technicianId || null);");
    // The action emits after its own compensation catch (multi-family) …
    const actions = fs.readFileSync(path.join(__dirname, '../services/cancellation-resolution/actions.js'), 'utf8');
    const holdCatch = actions.indexOf("try { await cancelHold(done.holdId, { compensateVisits: true }); }");
    const holdEmit = actions.indexOf('if (!deferTechNotices) emitHoldTechNotices(techNotices);');
    expect(holdEmit).toBeGreaterThan(holdCatch);
    // … and the away pairing defers past Away Mode's own compensation catch.
    expect(actions).toContain('await executeHold({ ...ctx, deferTechNotices: true });');
    const awayCatch = actions.indexOf("try { await cancelHold(holdId, { compensateVisits: true }); }");
    const awayEmit = actions.indexOf("require('./holds').emitHoldTechNotices(techNotices);");
    expect(awayEmit).toBeGreaterThan(awayCatch);
  });
});

describe('Codex r9 writers (source order)', () => {
  const fs = require('fs');
  const path = require('path');
  const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');

  test('both voice-confirm hooks name the holder from the COMMITTED transition payload, not the pre-transaction read', () => {
    for (const rel of ['../routes/admin-dispatch.js', '../routes/admin-schedule.js']) {
      const src = read(rel);
      const hook = src.indexOf("const confirmedRow = transition?.adminPayload || null;");
      expect(hook).toBeGreaterThan(-1);
      expect(src.lastIndexOf('transition = await transitionJobStatus({', hook)).toBeGreaterThan(src.lastIndexOf('let transition = null;', hook));
      expect(src.slice(hook, hook + 900)).toContain('snapshot: { date: confirmedRow.scheduled_date, windowStart: confirmedRow.window_start || null, windowEnd: confirmedRow.window_end || null },');
      expect(src.slice(hook, hook + 900)).not.toContain('technicianId: svc.technician_id');
    }
  });

  test('a same-trip parent promoted during estimate acceptance is announced on the seeding transaction; its seeded children are not', () => {
    const src = read('../services/estimate-converter.js');
    const hook = src.indexOf("visitId: parentRow.id, kind: 'assigned', technicianId: parentRow.technician_id, actorId: 'customer_estimate_accept',");
    expect(hook).toBeGreaterThan(-1);
    expect(src.slice(hook, hook + 400)).toContain('trx,');
    // Announced before the follow-up seeding, on the same trx.
    expect(src.indexOf('seedResult = await seedRecurringFollowUpsForParent(trx, parentRow', hook)).toBeGreaterThan(hook);
    expect(src.match(/notifyTechVisitChange\(/g)).toHaveLength(1);
  });

  test('the call follow-up cancel cascade carries the acting staff row from both callers (child card + history)', () => {
    const track = read('../services/track-transitions.js');
    expect(track).toContain('async function cascadeCallFollowUpCancel(serviceId, actorId = null) {');
    expect(track).toContain("await cancelCallFollowUpsForParentCancel({ conn: db, parentServiceId: serviceId, actorId });");
    expect(track.match(/cascadeCallFollowUpCancel\(serviceId, actorId\)/g)).toHaveLength(3);
    expect(track).not.toContain('cascadeCallFollowUpCancel(serviceId);');
    const offboarding = read('../services/customer-offboarding.js');
    expect(offboarding).toContain("await cancelCallFollowUpsForParentCancel({ conn: db, parentServiceId: visit.id, actorId: actorId || null });");
    const bulk = read('../routes/admin-schedule.js');
    expect(bulk).toContain("await cancelCallFollowUpsForParentCancel({ conn: db, parentServiceId: id, actorId: req.technicianId || null });");
    expect(bulk).not.toContain("cancelCallFollowUpsForParentCancel({ conn: db, parentServiceId: id })");
  });

  test('a grouped move re-pointed to another technician names the customer on the card, never on dispatch_alerts.resolved_by', () => {
    const src = read('../services/visit-groups.js');
    expect(src).toContain("actorId: options.actorId || null,\n              // The card's actor");
    expect(src).toContain('noticeActorId: options.actorId || initiatedBy || null,');
    expect(src).toContain("...(noticeActorId !== undefined ? { noticeActorId } : {}),");
  });
});

describe('Codex r7 writers (source order)', () => {
  const fs = require('fs');
  const path = require('path');
  const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');

  test('the admin-schedule status route confirms voice-agent bookings too and sends the same assigned card, post-commit', () => {
    const src = read('../routes/admin-schedule.js');
    const hook = src.indexOf("if (isOfficeReviewConfirm && fromStatus === 'pending' && confirmedRow?.tech_id");
    expect(hook).toBeGreaterThan(-1);
    expect(src.slice(hook, hook + 700)).toContain("visitId: svc.id, kind: 'assigned', technicianId: confirmedRow.tech_id, actorId: req.technicianId || null,");
    // After the status transaction's catch block, before the activation helper.
    expect(src.lastIndexOf('await transitionJobStatus({', hook)).toBeGreaterThan(-1);
    expect(src.lastIndexOf('// ===== Post-success side effects =====', hook)).toBeGreaterThan(-1);
    expect(src.indexOf("runOfficeConfirmActivation(db, svc, 'admin-schedule'", hook)).toBeGreaterThan(hook);
  });

  test('the cancellation processor names its actor (customer label or the acting staff row), never null', () => {
    const src = read('../services/cancellation-processor.js');
    expect(src).toContain("visitId: svc.id, actorId: actorType === 'customer' ? 'customer' : (actor?.userId || null), previousStatus: svc.status,");
    expect(src).not.toContain("notifyVisitCancelled({ visitId: svc.id, actorId: null })");
  });

  test('offboarding skips the cancel card on a same-status repair (row already cancelled when re-read)', () => {
    const src = read('../services/customer-offboarding.js');
    expect(src).toContain("if (String(fresh.status) !== 'cancelled') {\n    void require('./tech-visit-notifications').notifyVisitCancelled({ visitId: visit.id, actorId: actorId || null, previousStatus: fresh.status });");
  });

  test('Office Combine suppresses every tentative move (forward and rollback) and tells the holders after tryGroup() stands', () => {
    const src = read('../services/visit-combine.js');
    expect(src).toContain('    suppressTechNotice: true,\n    expect,');
    const group = src.indexOf('const visit = await tryGroup();');
    const notice = src.indexOf('void techNotices.notifyVisitRescheduled({');
    expect(notice).toBeGreaterThan(group);
    expect(src.indexOf('} catch (err) {', group)).toBeGreaterThan(notice);
  });
});

describe('Codex r6 writers (source order)', () => {
  const fs = require('fs');
  const path = require('path');
  const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');

  test('a phone-booking reuse that ASSIGNED the reused row announces it', () => {
    const src = read('../services/call-recording-processor.js');
    expect(src).toContain('if (reuseTechId && updatedExisting) reuseAssignedTechId = reuseTechId;');
    expect(src).toContain("...(!reusedExistingSchedule || (reuseAssignedTechId && String(svc.technician_id) === String(reuseAssignedTechId)) ? [svc] : []),");
  });

  test('office confirm of a voice-agent booking (pending → confirmed) sends the assigned card, post-commit', () => {
    const src = read('../routes/admin-dispatch.js');
    const hook = src.indexOf("if (isOfficeReviewConfirm && fromStatus === 'pending' && confirmedRow?.tech_id");
    expect(hook).toBeGreaterThan(-1);
    expect(src.slice(hook, hook + 700)).toContain("visitId: svc.id, kind: 'assigned', technicianId: confirmedRow.tech_id, actorId: req.technicianId || null,");
    // After the status transaction's catch block, before the activation helper.
    expect(src.lastIndexOf('await transitionJobStatus({', hook)).toBeGreaterThan(-1);
    expect(src.indexOf("runOfficeConfirmActivation(db, svc, 'admin-dispatch'", hook)).toBeGreaterThan(hook);
  });

  test('graduating a reserved estimate slot into a booking announces it on the accept transaction', () => {
    const src = read('../services/slot-reservation.js');
    const hook = src.indexOf("visitId: updated.id, kind: 'assigned', technicianId: updated.technician_id, actorId: 'customer_estimate_accept',");
    expect(hook).toBeGreaterThan(-1);
    expect(src.slice(hook, hook + 400)).toContain('trx: client,');
  });

  test('bulk-action reschedule names the committed holder and queues the move card right after commit', () => {
    const src = read('../routes/admin-schedule.js');
    expect(src).toContain(".returning(['id', 'technician_id']);\n              if (bulkCommittedRows.length === 0) {");
    const notice = src.indexOf('if (bulkTechMoveNotice) {');
    expect(notice).toBeGreaterThan(-1);
    const trxClose = src.lastIndexOf('            });\n', notice);
    expect(src.slice(trxClose, notice)).not.toMatch(/await /);
    expect(src.indexOf('applyLiveMovePostCommitEffects(liveMoveRow', notice)).toBeGreaterThan(notice);
  });

  test('call-created follow-ups that shift with a parent move get their own card; compensated callers keep them quiet', () => {
    const src = read('../services/call-booking-catalog.js');
    expect(src).toContain('noticeActorId = null, suppressTechNotice = false })');
    expect(src).toContain("if (k.technician_id) noticeRows.push({ id: k.id, technicianId: k.technician_id, fromDay: k.day, toDay: k.new_day,");
    expect(src).toContain('trx: conn.isTransaction ? conn : null,');
    const rebooker = read('../services/rebooker.js');
    expect(rebooker).toContain('noticeActorId: options.actorId || initiatedBy || null,\n        suppressTechNotice: options.suppressTechNotice === true,');
    expect((read('../routes/admin-schedule.js').match(/noticeActorId: req\.technicianId \|\| null,/g) || []).length).toBe(2);
  });
});
