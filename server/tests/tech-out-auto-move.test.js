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
jest.mock('../services/dispatch-alerts', () => ({ resolveAlert: jest.fn(), emitAlert: jest.fn() }));
jest.mock('../services/dispatch-assignment', () => ({
  emitDispatchJobUpdate: jest.fn().mockResolvedValue(null),
  flushDispatchQualityDates: jest.fn().mockResolvedValue(null),
}));
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
const { resolveAlert, emitAlert } = require('../services/dispatch-alerts');
const { emitDispatchJobUpdate, flushDispatchQualityDates } = require('../services/dispatch-assignment');
const { assertAssignableTechnician, NOT_ASSIGNABLE } = require('../services/technician-eligibility');
const { inactiveCapabilitiesForServices } = require('../services/technician-capabilities');
const { ALERT_TYPE } = require('../services/tech-out');
const {
  autoMoveEnabled, autoAssignParkedAlert, autoAssignTechDay,
} = require('../services/tech-out-auto-move');

const { OFFICE_REVIEW_PENDING_SOURCE_ACTIONS } = require('../services/call-booking-source-actions');

const REVIEW_SOURCE = OFFICE_REVIEW_PENDING_SOURCE_ACTIONS[0];
const ABSENT_TECH = 'tech-absent';
const CANDIDATE = { id: 'tech-2', name: 'Tech Two' };
const ALERT_ID = 'alert-1';
const JOB_ID = 'job-1';
const DATE = '2026-09-24';

function query(result) {
  const self = {};
  ['where', 'whereNot', 'whereNull', 'whereIn', 'whereNotIn', 'whereRaw', 'select', 'orderBy', 'orderByRaw', 'leftJoin', 'forShare', 'whereExists']
    .forEach((m) => { self[m] = jest.fn(() => self); });
  self.first = jest.fn(async () => (Array.isArray(result) ? (result[0] ?? null) : result));
  self.update = jest.fn(() => {
    const updated = Promise.resolve(1);
    updated.returning = jest.fn(async () => [{ id: ALERT_ID, payload: {} }]);
    return updated;
  });
  self.then = (resolve, reject) => Promise.resolve(
    Array.isArray(result) ? result : (result == null ? [] : [result]),
  ).then(resolve, reject);
  return self;
}

// The conditional annotation matching no row: the stop left the absent day
// (or the card resolved) between the read and the write.
function staleUpdate() {
  const q = query({});
  q.update = jest.fn(() => {
    const updated = Promise.resolve(0);
    updated.returning = jest.fn(async () => []);
    return updated;
  });
  return q;
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
    track_state: 'scheduled',
    source_action: null,
    customer_confirmed: true,
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
    const queue = [query(baseAlert({ payload: { date: DATE, visit_member_ids: [JOB_ID, 'job-2'] } })), query(baseStop({ visit_id: 'v1' })), query({})];
    db.mockImplementation(() => queue.shift() || query({}));

    const res = await autoAssignParkedAlert({ alertId: ALERT_ID, actorId: 'staff-1' });

    expect(res).toEqual({ moved: false, alert_id: ALERT_ID, reason: 'grouped_visit_manual' });
    expect(SmartRebooker.reschedule).not.toHaveBeenCalled();
    // The still-open card is re-broadcast so open boards show the reason.
    expect(emitAlert).toHaveBeenCalledWith(expect.objectContaining({ id: ALERT_ID }));
    // Annotated via a direct (non-transactional) payload merge.
    const rawCall = db.raw.mock.calls.find(([sql]) => /COALESCE\(payload/.test(sql));
    expect(JSON.parse(rawCall[1][0])).toMatchObject({ auto_attempt: { reason: 'grouped_visit_manual' } });
  });

  test('a grouped card whose own stop already left the absent day is closed, not refused as grouped', async () => {
    const queue = [
      query(baseAlert({ payload: { date: DATE, visit_member_ids: [JOB_ID, 'job-2'] } })),
      query(baseStop({ visit_id: 'v1', technician_id: 'someone-else' })),
    ];
    db.mockImplementation(() => queue.shift() || query({}));

    const res = await autoAssignParkedAlert({ alertId: ALERT_ID });

    expect(res).toEqual({ moved: false, alert_id: ALERT_ID, skipped: 'already_resolved' });
    expect(resolveAlert).toHaveBeenCalledWith(expect.objectContaining({ id: ALERT_ID, auto: true }));
    expect(db.raw).not.toHaveBeenCalled();
  });

  test('a stop already grouped since it was parked (visit_id set now): same manual-decision reason', async () => {
    const queue = [query(baseAlert()), query(baseStop({ visit_id: 'visit-9' }))];
    db.mockImplementation(() => queue.shift() || query({}));

    const res = await autoAssignParkedAlert({ alertId: ALERT_ID });

    expect(res.reason).toBe('grouped_visit_manual');
    expect(SmartRebooker.reschedule).not.toHaveBeenCalled();
  });

  test('en_route status: out of scope, left parked with reason live_status', async () => {
    const queue = [query(baseAlert()), query(baseStop({ status: 'en_route' }))];
    db.mockImplementation(() => queue.shift() || query({}));

    const res = await autoAssignParkedAlert({ alertId: ALERT_ID });

    expect(res).toEqual({ moved: false, alert_id: ALERT_ID, reason: 'live_status' });
    expect(SmartRebooker.reschedule).not.toHaveBeenCalled();
  });

  test.each(['en_route', 'on_property'])('confirmed status but live tracker state %s: left parked as live_status', async (trackState) => {
    const queue = [query(baseAlert()), query(baseStop({ status: 'confirmed', track_state: trackState })), query({})];
    db.mockImplementation(() => queue.shift() || query({}));

    const res = await autoAssignParkedAlert({ alertId: ALERT_ID });

    expect(res).toEqual({ moved: false, alert_id: ALERT_ID, reason: 'live_status' });
    expect(SmartRebooker.reschedule).not.toHaveBeenCalled();
  });

  test.each([
    ['status pending', { status: 'pending' }],
    ['a call-review source not yet customer-confirmed', { status: 'confirmed', source_action: REVIEW_SOURCE, customer_confirmed: false }],
  ])('office review pending (%s): left parked, the mover is never called', async (_label, overrides) => {
    const queue = [query(baseAlert()), query(baseStop(overrides)), query({})];
    db.mockImplementation(() => queue.shift() || query({}));

    const res = await autoAssignParkedAlert({ alertId: ALERT_ID });

    expect(res).toEqual({ moved: false, alert_id: ALERT_ID, reason: 'office_review_pending' });
    expect(SmartRebooker.reschedule).not.toHaveBeenCalled();
  });

  test.each(['completed', 'cancelled', 'skipped', 'no_show', 'on_site'])('a %s stop no longer needs reassigning: stale, card closed, never annotated', async (status) => {
    const queue = [query(baseAlert()), query(baseStop({ status }))];
    db.mockImplementation(() => queue.shift() || query({}));

    const res = await autoAssignParkedAlert({ alertId: ALERT_ID });

    expect(res).toEqual({ moved: false, alert_id: ALERT_ID, skipped: 'already_resolved' });
    expect(resolveAlert).toHaveBeenCalledWith(expect.objectContaining({ id: ALERT_ID, auto: true }));
    expect(db.raw).not.toHaveBeenCalled();
  });

  test('a CAS miss because a dispatcher reassigned the stop mid-run closes the stale card instead of trying more techs', async () => {
    SmartRebooker.reschedule.mockRejectedValue(Object.assign(new Error('concurrently'), { statusCode: 409 }));
    const second = { id: 'tech-3', name: 'Tech Three' };
    const queue = [
      query(baseAlert()), query(baseStop()), query([CANDIDATE, second]),
      query([]), query([]), query([]), query([]),
      staleUpdate(), // the conditional annotation finds the stop gone
    ];
    db.mockImplementation(() => queue.shift() || query({}));

    const res = await autoAssignParkedAlert({ alertId: ALERT_ID });

    expect(res).toEqual({ moved: false, alert_id: ALERT_ID, skipped: 'already_resolved' });
    expect(SmartRebooker.reschedule).toHaveBeenCalledTimes(1);
    expect(resolveAlert).toHaveBeenCalledWith(expect.objectContaining({ id: ALERT_ID, auto: true }));
  });

  test('a tracker-complete stop (geofence auto-completion, status still confirmed) is stale: closed, never moved', async () => {
    const queue = [query(baseAlert()), query(baseStop({ status: 'confirmed', track_state: 'complete' }))];
    db.mockImplementation(() => queue.shift() || query({}));

    const res = await autoAssignParkedAlert({ alertId: ALERT_ID });

    expect(res).toEqual({ moved: false, alert_id: ALERT_ID, skipped: 'already_resolved' });
    expect(SmartRebooker.reschedule).not.toHaveBeenCalled();
    expect(resolveAlert).toHaveBeenCalledWith(expect.objectContaining({ id: ALERT_ID, auto: true }));
  });

  test('a superseded (rescheduled) row is stale: no move, and its card is closed as a systemic resolution', async () => {
    const queue = [query(baseAlert()), query(baseStop({ status: 'rescheduled' }))];
    db.mockImplementation(() => queue.shift() || query({}));

    const res = await autoAssignParkedAlert({ alertId: ALERT_ID });

    expect(res).toEqual({ moved: false, alert_id: ALERT_ID, skipped: 'already_resolved' });
    expect(SmartRebooker.reschedule).not.toHaveBeenCalled();
    expect(resolveAlert).toHaveBeenCalledWith(expect.objectContaining({ id: ALERT_ID, auto: true }));
  });

  test('idempotent: the stop already moved off the absent tech — no-op skip, no mover call, no re-annotation', async () => {
    const queue = [query(baseAlert()), query(baseStop({ technician_id: 'someone-else' }))];
    db.mockImplementation(() => queue.shift() || query({}));

    const res = await autoAssignParkedAlert({ alertId: ALERT_ID });

    expect(res).toEqual({ moved: false, alert_id: ALERT_ID, skipped: 'already_resolved' });
    expect(SmartRebooker.reschedule).not.toHaveBeenCalled();
    expect(db.raw).not.toHaveBeenCalled();
    // The card would otherwise keep counting as parked: closed, systemically.
    expect(resolveAlert).toHaveBeenCalledWith(expect.objectContaining({ id: ALERT_ID, auto: true }));
  });

  test('idempotent: an already-resolved alert is a no-op', async () => {
    const queue = [query(baseAlert({ resolved_at: new Date().toISOString() }))];
    db.mockImplementation(() => queue.shift() || query({}));

    const res = await autoAssignParkedAlert({ alertId: ALERT_ID });
    expect(res).toEqual({ moved: false, alert_id: ALERT_ID, skipped: 'already_resolved' });
  });

  test('no eligible candidate: every tech fails the dated eligibility check', async () => {
    assertAssignableTechnician.mockRejectedValue(Object.assign(new Error('out'), { code: NOT_ASSIGNABLE }));
    const queue = [query(baseAlert()), query(baseStop()), query([CANDIDATE]), query({}), query({})];
    db.mockImplementation(() => queue.shift() || query({}));

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
      query([CANDIDATE]),        // technicians crew list
      query([]),                 // fitsWindow fallback: other visits that day
      query([]),                 // fitsWindow fallback: tech_schedule_blocks
    ];
    db.mockImplementation(() => queue.shift() || query({}));

    const res = await autoAssignParkedAlert({ alertId: ALERT_ID, actorId: 'staff-1' });

    expect(res).toEqual({ moved: true, alert_id: ALERT_ID, job_id: JOB_ID, to_technician_id: CANDIDATE.id });

    expect(SmartRebooker.reschedule).toHaveBeenCalledTimes(1);
    const [serviceId, newDate, newWindow, reason, initiatedBy, options] = SmartRebooker.reschedule.mock.calls[0];
    expect(serviceId).toBe(JOB_ID);
    expect(newDate).toBe(DATE);
    expect(newWindow).toEqual({ start: '09:00', end: '11:00' });
    expect(reason).toBe('tech_out_auto_move');
    expect(initiatedBy).toBe('admin');
    expect(options).toMatchObject({
      technicianId: CANDIDATE.id,
      keepStatus: true,
      seriesPolicy: 'single',
      actorId: 'staff-1',
      expect: {
        technician_id: ABSENT_TECH, scheduled_date: DATE, window_start: '09:00', window_end: '11:00', status: 'confirmed',
        track_state: 'scheduled',
        customer_confirmed: true,
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

    // The alert resolves inside the move's own transaction (beforeMove) —
    // never in a second transaction after the move commits.
    expect(resolveAlert).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
    expect(emitDispatchJobUpdate).toHaveBeenCalledWith({ jobId: JOB_ID, actorId: 'staff-1', qualityDates: expect.any(Set) });
    // A lone call owns its flush: one refresh after the move, not two.
    expect(flushDispatchQualityDates).toHaveBeenCalledTimes(1);
  });

  test('the mover refuses every attempt: alert stays open, annotated, no resolve', async () => {
    SmartRebooker.reschedule.mockRejectedValue(Object.assign(new Error('conflicts with another job'), { statusCode: 409 }));
    const queue = [
      query(baseAlert()),
      query(baseStop()),
      query([CANDIDATE]),
      query([]),
      query([]),
      query({}),
    ];
    db.mockImplementation(() => queue.shift() || query({}));

    const res = await autoAssignParkedAlert({ alertId: ALERT_ID });

    expect(res.moved).toBe(false);
    expect(res.reason).toMatch(/^move_failed:/);
    expect(resolveAlert).not.toHaveBeenCalled();
    const rawCall = db.raw.mock.calls.find(([sql]) => /COALESCE\(payload/.test(sql));
    expect(JSON.parse(rawCall[1][0]).auto_attempt.reason).toMatch(/^move_failed:/);
  });

  test('a membership-change CAS miss reports the grouped-visit reason, not a generic failure', async () => {
    SmartRebooker.reschedule.mockRejectedValue(Object.assign(new Error('grouped concurrently'), { code: 'VISIT_MEMBERSHIP_CHANGED' }));
    const queue = [query(baseAlert()), query(baseStop()), query([CANDIDATE]), query([]), query([]), query({}), query({})];
    db.mockImplementation(() => queue.shift() || query({}));

    const res = await autoAssignParkedAlert({ alertId: ALERT_ID });
    expect(res.reason).toBe('grouped_visit_manual');
  });
});

describe('selection matches the commit policy', () => {
  test('the mover\'s own commit probe finds the window occupied: parked as window_occupied, no candidate tried', async () => {
    SmartRebooker.previewMoveConflicts.mockResolvedValue([{ id: 'other-stop' }]);
    const queue = [query(baseAlert()), query(baseStop()), query({}), query({})];
    db.mockImplementation(() => queue.shift() || query({}));

    const res = await autoAssignParkedAlert({ alertId: ALERT_ID });

    expect(res).toEqual({ moved: false, alert_id: ALERT_ID, reason: 'window_occupied' });
    expect(SmartRebooker.reschedule).not.toHaveBeenCalled();
    // No exclusions: every live stop — the absent tech's others too — occupies its window.
    expect(SmartRebooker.previewMoveConflicts).toHaveBeenCalledWith(JOB_ID, DATE, { start: '09:00', end: '11:00' });
  });

  test('a stop reassigned by hand while the probe ran: the early refusal closes the stale card instead of annotating it', async () => {
    SmartRebooker.previewMoveConflicts.mockResolvedValue([{ id: 'other-stop' }]);
    const annotate = staleUpdate();
    const queue = [query(baseAlert()), query(baseStop()), annotate, query({})];
    db.mockImplementation(() => queue.shift() || query({}));

    const res = await autoAssignParkedAlert({ alertId: ALERT_ID });

    expect(res).toEqual({ moved: false, alert_id: ALERT_ID, skipped: 'already_resolved' });
    expect(resolveAlert).toHaveBeenCalledWith(expect.objectContaining({ id: ALERT_ID, auto: true }));
    // One statement: annotate only while the stop is still on the absent day.
    expect(annotate.whereExists).toHaveBeenCalledTimes(1);
    expect(emitAlert).not.toHaveBeenCalled();
  });

  test('the move passes no excludeServiceIds and pins the duration it fitted', async () => {
    SmartRebooker.reschedule.mockResolvedValue({ success: true });
    const queue = [query(baseAlert()), query(baseStop()), query([CANDIDATE]), query([]), query([])];
    db.mockImplementation(() => queue.shift() || query({}));

    await autoAssignParkedAlert({ alertId: ALERT_ID });

    const options = SmartRebooker.reschedule.mock.calls[0][5];
    expect(options).not.toHaveProperty('excludeServiceIds');
    expect(options.expect.estimated_duration_minutes).toBe(60);
    expect(options.expect.service_type).toBe('general_pest');
  });

  test('a lapsed estimate hold on the candidate\'s day does not count as a conflict', async () => {
    const { _test: { fitsWindow } } = require('../services/tech-out-auto-move');
    const others = query([]);
    const queue = [others, query([])];
    db.mockImplementation(() => queue.shift() || query({}));

    const fit = await fitsWindow(baseStop(), CANDIDATE, DATE);

    expect(fit).toEqual({ fits: true });
    const predicate = others.where.mock.calls.find(([arg]) => typeof arg === 'function')[0];
    const q = { whereNull: jest.fn(() => q), orWhereRaw: jest.fn(() => q) };
    predicate(q);
    expect(q.whereNull).toHaveBeenCalledWith('reservation_expires_at');
    expect(q.orWhereRaw).toHaveBeenCalledWith('reservation_expires_at > NOW()');
  });

  test('lapsed estimate holds neither count as stops nor anchor the detour', async () => {
    const { dayStopsQuery } = require('../services/scheduling/day-stops');
    const past = new Date(Date.now() - 3600e3).toISOString();
    const future = new Date(Date.now() + 3600e3).toISOString();
    dayStopsQuery.mockResolvedValueOnce([
      { id: 'lapsed', window_start: '08:00', reservation_expires_at: past },
      { id: 'live-hold', window_start: '12:00', reservation_expires_at: future },
      { id: 'visit', window_start: '14:00', reservation_expires_at: null },
    ]);
    const { _test: { detourForTech } } = require('../services/tech-out-auto-move');

    const res = await detourForTech(baseStop(), CANDIDATE.id, DATE);

    expect(res.stops_that_day).toBe(3); // live-hold + visit + the stop itself
  });

  test('a candidate\'s completed visit occupies nothing — the same status set as the rebooker\'s commit probe', async () => {
    const { _test: { fitsWindow } } = require('../services/tech-out-auto-move');
    const others = query([]);
    const queue = [others, query([])];
    db.mockImplementation(() => queue.shift() || query({}));

    await fitsWindow(baseStop(), CANDIDATE, DATE);

    const excluded = others.whereNotIn.mock.calls.find(([col]) => col === 'status')[1];
    expect(excluded).toEqual(expect.arrayContaining(['completed', 'cancelled', 'skipped', 'no_show', 'rescheduled']));
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

describe('in-transaction fit recheck (moveGuard)', () => {
  async function capturedMoveGuard() {
    SmartRebooker.reschedule.mockResolvedValue({ success: true });
    const queue = [query(baseAlert()), query(baseStop()), query([CANDIDATE]), query([]), query([])];
    db.mockImplementation(() => queue.shift() || query({}));
    await autoAssignParkedAlert({ alertId: ALERT_ID });
    return SmartRebooker.reschedule.mock.calls[0][5].moveGuard;
  }

  test('an assignment that landed on the candidate after ranking refuses the move on the move transaction', async () => {
    const guard = await capturedMoveGuard();
    const trxRows = [query([{ window_start: '10:00', window_end: '11:30' }]), query([])];
    const trx = jest.fn(() => trxRows.shift());

    await expect(guard({ trx, technicianId: CANDIDATE.id, service: baseStop() }))
      .rejects.toMatchObject({ code: 'TECH_OUT_AUTO_MOVE_NO_FIT' });
    expect(trx).toHaveBeenCalledWith('scheduled_services');
  });

  test('candidate still fits on the move transaction: the move proceeds', async () => {
    const guard = await capturedMoveGuard();
    const trxRows = [query([]), query([])];
    const trx = jest.fn(() => trxRows.shift());

    await expect(guard({ trx, technicianId: CANDIDATE.id, service: baseStop() })).resolves.toBeUndefined();
  });
});

describe('in-transaction still-parked recheck (beforeMove)', () => {
  async function capturedGuard() {
    SmartRebooker.reschedule.mockResolvedValue({ success: true });
    const queue = [query(baseAlert()), query(baseStop()), query([CANDIDATE]), query([]), query([])];
    db.mockImplementation(() => queue.shift() || query({}));
    await autoAssignParkedAlert({ alertId: ALERT_ID });
    return SmartRebooker.reschedule.mock.calls[0][5].beforeMove;
  }
  function asTrx(fn) {
    fn.raw = db.raw;
    return fn;
  }
  function trxReturning(absence, alert, claim = null) {
    const rows = [claim, absence, alert, {}];
    return asTrx(jest.fn(() => query(rows.shift())));
  }

  test('a completion already claimed the visit: refuses inside the move transaction, alert untouched', async () => {
    const guard = await capturedGuard();
    await expect(guard(trxReturning({ id: 'abs-1' }, { id: ALERT_ID }, { id: 'claim-1' })))
      .rejects.toMatchObject({ code: 'TECH_OUT_COMPLETION_IN_FLIGHT' });
    expect(resolveAlert).not.toHaveBeenCalled();
  });

  test('absence cleared ("Tech is back") after the read: refuses inside the move transaction', async () => {
    const guard = await capturedGuard();
    await expect(guard(trxReturning(null, { id: ALERT_ID }))).rejects.toMatchObject({ code: 'TECH_OUT_CLEARED' });
  });

  test('alert resolved or dismissed after the read: refuses inside the move transaction', async () => {
    const guard = await capturedGuard();
    await expect(guard(trxReturning({ id: 'abs-1' }, null))).rejects.toMatchObject({ code: 'TECH_OUT_ALERT_RESOLVED' });
  });

  test('absence still active and alert still open: the move proceeds and the alert resolves on the SAME transaction', async () => {
    const guard = await capturedGuard();
    const trx = trxReturning({ id: 'abs-1' }, { id: ALERT_ID });
    await expect(guard(trx)).resolves.toBeUndefined();
    expect(resolveAlert).toHaveBeenCalledWith(expect.objectContaining({ id: ALERT_ID, trx, auto: true }));
    const rawCall = db.raw.mock.calls.find(([sql, bindings]) => /COALESCE\(payload/.test(sql) && /auto_moved/.test(bindings[0]));
    expect(JSON.parse(rawCall[1][0])).toMatchObject({ auto_moved: { to_technician_id: CANDIDATE.id } });
  });

  test('a stale refusal from the mover is a quiet no-op: no further candidates, no annotation', async () => {
    SmartRebooker.reschedule.mockRejectedValue(Object.assign(new Error('cleared'), { code: 'TECH_OUT_CLEARED' }));
    const second = { id: 'tech-3', name: 'Tech Three' };
    const queue = [query(baseAlert()), query(baseStop()), query([CANDIDATE, second]), query([]), query([]), query([]), query([])];
    db.mockImplementation(() => queue.shift() || query({}));

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
      // alert-a: dispatch_alerts by id, scheduled_services, technicians, others, blocks
      query(baseAlert({ id: 'alert-a', job_id: 'job-a' })),
      query(baseStop({ id: 'job-a' })),
      query([CANDIDATE]),
      query([]),
      query([]),
      // alert-b: no eligible candidate
      query(baseAlert({ id: 'alert-b', job_id: 'job-b' })),
      query(baseStop({ id: 'job-b' })),
      query([]),
      query({}), // exists-subquery builder for the conditional annotation
      query({}),
    ];
    db.mockImplementation(() => queue.shift() || query({}));
    SmartRebooker.reschedule.mockResolvedValue({ success: true });

    const res = await autoAssignTechDay({ technicianId: ABSENT_TECH, date: DATE, actorId: 'staff-1' });

    expect(res.moved).toHaveLength(1);
    expect(res.moved[0]).toMatchObject({ alert_id: 'alert-a', job_id: 'job-a' });
    expect(res.left_parked).toHaveLength(1);
    expect(res.left_parked[0]).toMatchObject({ alert_id: 'alert-b', reason: 'no_eligible_candidate' });

    // One schedule-quality Set shared by every move, flushed ONCE after the run.
    const passed = SmartRebooker.reschedule.mock.calls[0][5].qualityDates;
    expect(passed).toBeInstanceOf(Set);
    expect(emitDispatchJobUpdate).toHaveBeenCalledWith(expect.objectContaining({ qualityDates: passed }));
    expect(flushDispatchQualityDates).toHaveBeenCalledTimes(1);
    expect(flushDispatchQualityDates).toHaveBeenCalledWith(passed);
  });

  test('an unexpected per-alert failure is annotated with a safe reason and reported as failed, not as a clean zero', async () => {
    const alertsList = query([{ id: 'alert-a' }]);
    const boom = query({});
    boom.first = jest.fn(async () => { throw new Error('connection reset'); });
    const annotate = query({});
    const queue = [alertsList, boom, annotate];
    db.mockImplementation(() => queue.shift() || query({}));

    const res = await autoAssignTechDay({ technicianId: ABSENT_TECH, date: DATE });

    expect(res.failed).toEqual([{ alert_id: 'alert-a', reason: 'auto_move_error' }]);
    expect(res.moved).toEqual([]);
    const rawCall = db.raw.mock.calls.find(([sql]) => /COALESCE\(payload/.test(sql));
    expect(JSON.parse(rawCall[1][0]).auto_attempt.reason).toBe('auto_move_error');
  });

  test('orders cards most-protected first by re-scoring their stops, not by batch-local bump_order', async () => {
    // alert-late came from a sweep batch (bump_order restarted at 1) but is a
    // confirmed one-time visit; alert-early is a recurring unconfirmed one.
    const alertsList = query([
      { id: 'alert-early', job_id: 'job-early' },
      { id: 'alert-late', job_id: 'job-late' },
    ]);
    const stopsRead = query([
      { id: 'job-early', is_recurring: true, status: 'pending', window_start: '09:00' },
      { id: 'job-late', is_recurring: false, status: 'confirmed', window_start: '09:00' },
    ]);
    const processed = [];
    const queue = [alertsList, stopsRead];
    db.mockImplementation((table) => {
      const next = queue.shift();
      if (next) return next;
      const q = query({});
      if (table === 'dispatch_alerts') {
        q.first = jest.fn(async () => { processed.push(q.where.mock.calls[0][0].id); return null; });
      }
      return q;
    });

    await autoAssignTechDay({ technicianId: ABSENT_TECH, date: DATE });

    expect(processed).toEqual(['alert-late', 'alert-early']);
  });
});
