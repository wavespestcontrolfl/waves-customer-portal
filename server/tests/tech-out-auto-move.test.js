/**
 * services/tech-out-auto-move.js — PR B chokepoint. Every dependency that
 * would otherwise touch real Postgres or the real canonical mover is
 * mocked; this file pins the CHOKEPOINT'S OWN decisions (gate check, scope
 * exclusions, candidate handling, idempotency, and what it hands the
 * mover), not the mover's or the eligibility module's internals — those
 * have their own test files.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/rebooker', () => ({ reschedule: jest.fn(), previewMoveConflicts: jest.fn() }));
jest.mock('../services/dispatch-alerts', () => ({ resolveAlert: jest.fn() }));
jest.mock('../services/dispatch-assignment', () => ({ emitDispatchJobUpdate: jest.fn().mockResolvedValue(null) }));
jest.mock('../services/technician-capabilities', () => ({
  assertCapabilitiesActive: jest.fn().mockResolvedValue(undefined),
  inactiveCapabilitiesForServices: jest.fn().mockResolvedValue([]),
}));
jest.mock('../services/technician-eligibility', () => {
  const actual = jest.requireActual('../services/technician-eligibility');
  return { ...actual, assertAssignableTechnician: jest.fn().mockResolvedValue({}) };
});
jest.mock('../services/scheduling/arrival-route', () => ({
  arrivalWindowRoutingEnabled: jest.fn(() => false),
  checkArrivalPlacement: jest.fn(),
}));
jest.mock('../services/scheduling/day-stops', () => ({
  dayStopsQuery: jest.fn().mockResolvedValue([]),
  guardedCoordSelects: jest.fn(() => []),
}));
jest.mock('../services/scheduling/tech-day-lock', () => ({ lockTechDays: jest.fn().mockResolvedValue(['k']) }));
jest.mock('../sockets', () => ({ getIo: jest.fn() }));
jest.mock('../services/estimate-slot-availability', () => ({ invalidateAllEstimates: jest.fn() }));

const db = require('../models/db');
const SmartRebooker = require('../services/rebooker');
const { resolveAlert } = require('../services/dispatch-alerts');
const { emitDispatchJobUpdate } = require('../services/dispatch-assignment');
const { assertAssignableTechnician, NOT_ASSIGNABLE } = require('../services/technician-eligibility');
const { inactiveCapabilitiesForServices } = require('../services/technician-capabilities');
const { ALERT_TYPE } = require('../services/tech-out');
const {
  autoMoveEnabled, autoAssignParkedAlert, autoAssignTechDay,
} = require('../services/tech-out-auto-move');

const ABSENT_TECH = 'tech-absent';
const CANDIDATE = { id: 'tech-2', name: 'Tech Two' };
const ALERT_ID = 'alert-1';
const JOB_ID = 'job-1';
const DATE = '2026-09-24';

function query(result) {
  const self = {};
  ['where', 'whereNot', 'whereNull', 'whereIn', 'whereNotIn', 'whereRaw', 'select', 'orderBy', 'orderByRaw', 'leftJoin', 'forShare']
    .forEach((m) => { self[m] = jest.fn(() => self); });
  self.first = jest.fn(async () => (Array.isArray(result) ? (result[0] ?? null) : result));
  self.update = jest.fn().mockResolvedValue(1);
  self.then = (resolve, reject) => Promise.resolve(
    Array.isArray(result) ? result : (result == null ? [] : [result]),
  ).then(resolve, reject);
  return self;
}

function baseAlert(overrides = {}) {
  return {
    id: ALERT_ID,
    type: ALERT_TYPE,
    tech_id: ABSENT_TECH,
    job_id: JOB_ID,
    resolved_at: null,
    payload: { date: DATE, window_start: '09:00', window_end: '11:00' },
    ...overrides,
  };
}

function baseStop(overrides = {}) {
  return {
    id: JOB_ID,
    status: 'confirmed',
    service_type: 'general_pest',
    window_start: '09:00',
    window_end: '11:00',
    estimated_duration_minutes: 60,
    visit_id: null,
    technician_id: ABSENT_TECH,
    scheduled_date: DATE,
    customer_id: 'cust-1',
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  db.transaction = jest.fn(async (fn) => {
    const trxTable = () => ({ where: jest.fn(function w() { return this; }), update: jest.fn().mockResolvedValue(1) });
    const trx = jest.fn(trxTable);
    trx.raw = db.raw;
    return fn(trx);
  });
  process.env.GATE_TECH_OUT_REDISTRIBUTE = 'true';
  process.env.GATE_TECH_OUT_AUTO_MOVE = 'true';
  assertAssignableTechnician.mockResolvedValue({});
  inactiveCapabilitiesForServices.mockResolvedValue([]);
  SmartRebooker.previewMoveConflicts.mockResolvedValue([]);
});

afterEach(() => {
  delete process.env.GATE_TECH_OUT_REDISTRIBUTE;
  delete process.env.GATE_TECH_OUT_AUTO_MOVE;
});

describe('autoMoveEnabled', () => {
  test('requires BOTH gates on', () => {
    expect(autoMoveEnabled()).toBe(true);
    process.env.GATE_TECH_OUT_AUTO_MOVE = 'false';
    expect(autoMoveEnabled()).toBe(false);
    process.env.GATE_TECH_OUT_AUTO_MOVE = 'true';
    process.env.GATE_TECH_OUT_REDISTRIBUTE = 'false';
    expect(autoMoveEnabled()).toBe(false);
  });
});

describe('autoAssignParkedAlert', () => {
  test('gate off: skips without touching the db', async () => {
    process.env.GATE_TECH_OUT_AUTO_MOVE = 'false';
    const res = await autoAssignParkedAlert({ alertId: ALERT_ID, actorId: 'staff-1' });
    expect(res).toEqual({ moved: false, alert_id: ALERT_ID, skipped: 'gate_off' });
    expect(db).not.toHaveBeenCalled();
  });

  test('grouped alert (visit_member_ids > 1): left parked, annotated, never calls the mover', async () => {
    const queue = [query(baseAlert({ payload: { date: DATE, visit_member_ids: [JOB_ID, 'job-2'] } })), query({})];
    db.mockImplementation(() => queue.shift());

    const res = await autoAssignParkedAlert({ alertId: ALERT_ID, actorId: 'staff-1' });

    expect(res).toEqual({ moved: false, alert_id: ALERT_ID, reason: 'grouped_visit_manual' });
    expect(SmartRebooker.reschedule).not.toHaveBeenCalled();
    // Annotated via a direct (non-transactional) payload merge.
    const rawCall = db.raw.mock.calls.find(([sql]) => /COALESCE\(payload/.test(sql));
    expect(JSON.parse(rawCall[1][0])).toMatchObject({ auto_attempt: { reason: 'grouped_visit_manual' } });
  });

  test('a stop already grouped since it was parked (visit_id set now): same manual-decision reason', async () => {
    const queue = [query(baseAlert()), query(baseStop({ visit_id: 'visit-9' }))];
    db.mockImplementation(() => queue.shift());

    const res = await autoAssignParkedAlert({ alertId: ALERT_ID });

    expect(res.reason).toBe('grouped_visit_manual');
    expect(SmartRebooker.reschedule).not.toHaveBeenCalled();
  });

  test('en_route status: out of scope, left parked with reason live_status', async () => {
    const queue = [query(baseAlert()), query(baseStop({ status: 'en_route' }))];
    db.mockImplementation(() => queue.shift());

    const res = await autoAssignParkedAlert({ alertId: ALERT_ID });

    expect(res).toEqual({ moved: false, alert_id: ALERT_ID, reason: 'live_status' });
    expect(SmartRebooker.reschedule).not.toHaveBeenCalled();
  });

  test('idempotent: the stop already moved off the absent tech — no-op skip, no mover call, no re-annotation', async () => {
    const queue = [query(baseAlert()), query(baseStop({ technician_id: 'someone-else' }))];
    db.mockImplementation(() => queue.shift());

    const res = await autoAssignParkedAlert({ alertId: ALERT_ID });

    expect(res).toEqual({ moved: false, alert_id: ALERT_ID, skipped: 'already_resolved' });
    expect(SmartRebooker.reschedule).not.toHaveBeenCalled();
    expect(db.raw).not.toHaveBeenCalled();
  });

  test('idempotent: an already-resolved alert is a no-op', async () => {
    const queue = [query(baseAlert({ resolved_at: new Date().toISOString() }))];
    db.mockImplementation(() => queue.shift());

    const res = await autoAssignParkedAlert({ alertId: ALERT_ID });
    expect(res).toEqual({ moved: false, alert_id: ALERT_ID, skipped: 'already_resolved' });
  });

  test('no eligible candidate: every tech fails the dated eligibility check', async () => {
    assertAssignableTechnician.mockRejectedValue(Object.assign(new Error('out'), { code: NOT_ASSIGNABLE }));
    const queue = [query(baseAlert()), query(baseStop()), query([]), query([CANDIDATE])];
    db.mockImplementation(() => queue.shift());

    const res = await autoAssignParkedAlert({ alertId: ALERT_ID });

    expect(res).toEqual({ moved: false, alert_id: ALERT_ID, reason: 'no_eligible_candidate' });
    expect(SmartRebooker.reschedule).not.toHaveBeenCalled();
  });

  test('success: moves via the canonical mover, pins the expect CAS, resolves the alert, broadcasts', async () => {
    SmartRebooker.reschedule.mockResolvedValue({ success: true });
    const stopQuery = query(baseStop());
    const queue = [
      query(baseAlert()),        // dispatch_alerts by id
      stopQuery,                 // scheduled_services by id
      query([]),                 // the absent tech's open stops that day (excludeServiceIds)
      query([CANDIDATE]),        // technicians crew list
      query([]),                 // fitsWindow fallback: other visits that day
      query([]),                 // fitsWindow fallback: tech_schedule_blocks
    ];
    db.mockImplementation(() => queue.shift());

    const res = await autoAssignParkedAlert({ alertId: ALERT_ID, actorId: 'staff-1' });

    expect(res).toEqual({ moved: true, alert_id: ALERT_ID, job_id: JOB_ID, to_technician_id: CANDIDATE.id });

    expect(SmartRebooker.reschedule).toHaveBeenCalledTimes(1);
    const [serviceId, newDate, newWindow, reason, initiatedBy, options] = SmartRebooker.reschedule.mock.calls[0];
    expect(serviceId).toBe(JOB_ID);
    expect(newDate).toBe(DATE);
    expect(newWindow).toEqual({ start: '09:00', end: '11:00' });
    expect(reason).toBe('tech_out_auto_move');
    expect(initiatedBy).toBe('system');
    expect(options).toMatchObject({
      technicianId: CANDIDATE.id,
      keepStatus: true,
      seriesPolicy: 'single',
      actorId: 'staff-1',
      expect: {
        technician_id: ABSENT_TECH, scheduled_date: DATE, window_start: '09:00', window_end: '11:00', status: 'confirmed',
      },
    });
    expect(typeof options.moveGuard).toBe('function');
    // Never the whole-visit mover, and a stop grouped after the read misses the CAS.
    expect(options.visitPolicy).toBe('single');
    expect(options.expect).toHaveProperty('visit_id', null);
    expect(typeof options.beforeMove).toBe('function');
    // The stop read joins customers: guardedCoordSelects falls back to
    // customers.latitude/longitude and Postgres rejects it without the join.
    expect(stopQuery.leftJoin).toHaveBeenCalledWith('customers', 'customers.id', 'scheduled_services.customer_id');

    // Never customer-facing: the mover mock proves nothing beyond "reschedule was
    // called with no notify/SMS-shaped option"; the header comment documents why
    // that call itself sends nothing (SmartRebooker.reschedule never touches
    // SMS/email — that lives in the ROUTE layer, which this module never calls).
    expect(options.notifyCustomer).toBeUndefined();
    expect(options.notifyRequested).toBeUndefined();

    expect(resolveAlert).toHaveBeenCalledWith(expect.objectContaining({ id: ALERT_ID, resolvedBy: 'staff-1', auto: true }));
    const rawCall = db.raw.mock.calls.find(([sql, bindings]) => /COALESCE\(payload/.test(sql) && /auto_moved/.test(bindings[0]));
    expect(JSON.parse(rawCall[1][0])).toMatchObject({ auto_moved: { to_technician_id: CANDIDATE.id } });
    expect(emitDispatchJobUpdate).toHaveBeenCalledWith({ jobId: JOB_ID, actorId: 'staff-1' });
  });

  test('the mover refuses every attempt: alert stays open, annotated, no resolve', async () => {
    SmartRebooker.reschedule.mockRejectedValue(Object.assign(new Error('conflicts with another job'), { statusCode: 409 }));
    const queue = [
      query(baseAlert()),
      query(baseStop()),
      query([]),
      query([CANDIDATE]),
      query([]),
      query([]),
      query({}),
    ];
    db.mockImplementation(() => queue.shift());

    const res = await autoAssignParkedAlert({ alertId: ALERT_ID });

    expect(res.moved).toBe(false);
    expect(res.reason).toMatch(/^move_failed:/);
    expect(resolveAlert).not.toHaveBeenCalled();
    const rawCall = db.raw.mock.calls.find(([sql]) => /COALESCE\(payload/.test(sql));
    expect(JSON.parse(rawCall[1][0]).auto_attempt.reason).toMatch(/^move_failed:/);
  });

  test('a membership-change CAS miss reports the grouped-visit reason, not a generic failure', async () => {
    SmartRebooker.reschedule.mockRejectedValue(Object.assign(new Error('grouped concurrently'), { code: 'VISIT_MEMBERSHIP_CHANGED' }));
    const queue = [query(baseAlert()), query(baseStop()), query([]), query([CANDIDATE]), query([]), query([]), query({})];
    db.mockImplementation(() => queue.shift());

    const res = await autoAssignParkedAlert({ alertId: ALERT_ID });
    expect(res.reason).toBe('grouped_visit_manual');
  });
});

describe('selection matches the commit policy', () => {
  test('the mover\'s own commit probe finds the window occupied: parked as window_occupied, no candidate tried', async () => {
    SmartRebooker.previewMoveConflicts.mockResolvedValue([{ id: 'other-stop' }]);
    const queue = [query(baseAlert()), query(baseStop()), query([{ id: JOB_ID }, { id: 'job-sib' }]), query({})];
    db.mockImplementation(() => queue.shift());

    const res = await autoAssignParkedAlert({ alertId: ALERT_ID });

    expect(res).toEqual({ moved: false, alert_id: ALERT_ID, reason: 'window_occupied' });
    expect(SmartRebooker.reschedule).not.toHaveBeenCalled();
    // Probe and commit carry the same exclusion: the absent tech's own stops that day.
    expect(SmartRebooker.previewMoveConflicts).toHaveBeenCalledWith(
      JOB_ID, DATE, { start: '09:00', end: '11:00' }, { excludeServiceIds: [JOB_ID, 'job-sib'] },
    );
  });

  test('the move passes the same excludeServiceIds the probe used', async () => {
    SmartRebooker.reschedule.mockResolvedValue({ success: true });
    const queue = [query(baseAlert()), query(baseStop()), query([{ id: JOB_ID }]), query([CANDIDATE]), query([]), query([])];
    db.mockImplementation(() => queue.shift());

    await autoAssignParkedAlert({ alertId: ALERT_ID });

    expect(SmartRebooker.reschedule.mock.calls[0][5].excludeServiceIds).toEqual([JOB_ID]);
  });

  test('schedule blocks refuse a candidate on the arrival-routing path too', async () => {
    const { arrivalWindowRoutingEnabled, checkArrivalPlacement } = require('../services/scheduling/arrival-route');
    arrivalWindowRoutingEnabled.mockReturnValue(true);
    checkArrivalPlacement.mockResolvedValue({ feasible: true });
    const { _test: { fitsWindow } } = require('../services/tech-out-auto-move');
    db.mockImplementation(() => query([{ start_time: '10:00', end_time: '12:00' }]));

    const fit = await fitsWindow(baseStop(), CANDIDATE, DATE);

    expect(fit).toEqual({ fits: false, conflict_reason: 'schedule_block' });
    arrivalWindowRoutingEnabled.mockReturnValue(false);
  });
});

describe('in-transaction still-parked recheck (beforeMove)', () => {
  async function capturedGuard() {
    SmartRebooker.reschedule.mockResolvedValue({ success: true });
    const queue = [query(baseAlert()), query(baseStop()), query([]), query([CANDIDATE]), query([]), query([])];
    db.mockImplementation(() => queue.shift());
    await autoAssignParkedAlert({ alertId: ALERT_ID });
    return SmartRebooker.reschedule.mock.calls[0][5].beforeMove;
  }
  function trxReturning(absence, alert) {
    const rows = [absence, alert];
    return jest.fn(() => query(rows.shift()));
  }

  test('absence cleared ("Tech is back") after the read: refuses inside the move transaction', async () => {
    const guard = await capturedGuard();
    await expect(guard(trxReturning(null, { id: ALERT_ID }))).rejects.toMatchObject({ code: 'TECH_OUT_CLEARED' });
  });

  test('alert resolved or dismissed after the read: refuses inside the move transaction', async () => {
    const guard = await capturedGuard();
    await expect(guard(trxReturning({ id: 'abs-1' }, null))).rejects.toMatchObject({ code: 'TECH_OUT_ALERT_RESOLVED' });
  });

  test('absence still active and alert still open: the move proceeds', async () => {
    const guard = await capturedGuard();
    await expect(guard(trxReturning({ id: 'abs-1' }, { id: ALERT_ID }))).resolves.toBeUndefined();
  });

  test('a stale refusal from the mover is a quiet no-op: no further candidates, no annotation', async () => {
    SmartRebooker.reschedule.mockRejectedValue(Object.assign(new Error('cleared'), { code: 'TECH_OUT_CLEARED' }));
    const second = { id: 'tech-3', name: 'Tech Three' };
    const queue = [query(baseAlert()), query(baseStop()), query([]), query([CANDIDATE, second]), query([]), query([]), query([]), query([])];
    db.mockImplementation(() => queue.shift());

    const res = await autoAssignParkedAlert({ alertId: ALERT_ID });

    expect(res).toEqual({ moved: false, alert_id: ALERT_ID, skipped: 'already_resolved' });
    expect(SmartRebooker.reschedule).toHaveBeenCalledTimes(1);
    expect(db.raw.mock.calls.some(([sql]) => /COALESCE\(payload/.test(sql))).toBe(false);
  });
});

describe('autoAssignTechDay', () => {
  test('gate off: skips without reading alerts', async () => {
    process.env.GATE_TECH_OUT_AUTO_MOVE = 'false';
    const res = await autoAssignTechDay({ technicianId: ABSENT_TECH, date: DATE });
    expect(res).toEqual({ skipped: 'gate_off', moved: [], left_parked: [] });
    expect(db).not.toHaveBeenCalled();
  });

  test('processes open alerts most-protected first and separates moved from left_parked', async () => {
    // Two alerts already resolved-or-open list read; then each alert flows
    // through its own autoAssignParkedAlert call — stub the module's own
    // export indirectly isn't possible (same module), so this test drives
    // it through the real per-alert path with two simple, independent
    // stops: one that moves, one that has no candidate.
    const alertsList = query([{ id: 'alert-a' }, { id: 'alert-b' }]);
    const queue = [
      alertsList, // the open-alerts read, ordered by bump_order DESC
      // alert-a: dispatch_alerts by id, scheduled_services, absent-day ids, technicians, others, blocks
      query(baseAlert({ id: 'alert-a', job_id: 'job-a' })),
      query(baseStop({ id: 'job-a' })),
      query([]),
      query([CANDIDATE]),
      query([]),
      query([]),
      // alert-b: no eligible candidate
      query(baseAlert({ id: 'alert-b', job_id: 'job-b' })),
      query(baseStop({ id: 'job-b' })),
      query([]),
      query([]),
    ];
    db.mockImplementation(() => queue.shift());
    SmartRebooker.reschedule.mockResolvedValue({ success: true });

    const res = await autoAssignTechDay({ technicianId: ABSENT_TECH, date: DATE, actorId: 'staff-1' });

    expect(res.moved).toHaveLength(1);
    expect(res.moved[0]).toMatchObject({ alert_id: 'alert-a', job_id: 'job-a' });
    expect(res.left_parked).toHaveLength(1);
    expect(res.left_parked[0]).toMatchObject({ alert_id: 'alert-b', reason: 'no_eligible_candidate' });
  });
});
