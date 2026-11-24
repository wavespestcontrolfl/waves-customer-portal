/**
 * moveVisitAsUnit — R3: moving one grouped row moves the whole visit
 * (visit-group-scope.md §2). Fake db (scripted tables + transaction) and a
 * fake rebooker; the contract under test is the plan (validation, parent
 * retarget, shifted windows) and the member orchestration.
 */
jest.mock('../models/db', () => {
  const calls = [];
  function makeChain(table, script, log) {
    const chain = {
      _ops: [],
      where() { chain._ops.push(['where', ...arguments]); return chain; },
      whereIn() { chain._ops.push(['whereIn', ...arguments]); return chain; },
      whereNot() { chain._ops.push(['whereNot', ...arguments]); return chain; },
      whereNotIn() { chain._ops.push(['whereNotIn', ...arguments]); return chain; },
      whereNull() { chain._ops.push(['whereNull', ...arguments]); return chain; },
      whereRaw() { chain._ops.push(['whereRaw', ...arguments]); return chain; },
      orWhereRaw() { chain._ops.push(['orWhereRaw', ...arguments]); return chain; },
      leftJoin() { chain._ops.push(['leftJoin', ...arguments]); return chain; },
      forUpdate() { chain._ops.push(['forUpdate']); return chain; },
      forShare() { chain._ops.push(['forShare']); return chain; },
      orderBy() { chain._ops.push(['orderBy', ...arguments]); return chain; },
      max() { chain._ops.push(['max', ...arguments]); return chain; },
      first(...cols) {
        log.push({ table, op: 'first', ops: chain._ops, cols });
        if (script[table] && script[table].first) return Promise.resolve(script[table].first(chain._ops, cols));
        // Save-time eligibility read (technician-eligibility.js): every tech a
        // test assigns is on staff and field-dispatchable unless scripted.
        if (table === 'technicians') return Promise.resolve({ id: 't9', employment_status: 'active', field_dispatchable: true });
        return Promise.resolve(null);
      },
      select(...cols) { log.push({ table, op: 'select', ops: chain._ops, cols }); return Promise.resolve(script[table] && script[table].select ? script[table].select(chain._ops) : []); },
      update(values) { log.push({ table, op: 'update', ops: chain._ops, values }); return Promise.resolve(1); },
      count() { chain._ops.push(['count', ...arguments]); return chain; },
      del() { log.push({ table, op: 'del', ops: chain._ops }); return Promise.resolve(1); },
      insert(values) { log.push({ table, op: 'insert', ops: chain._ops, values }); return Promise.resolve([{}]); },
      then(res, rej) { return Promise.resolve([]).then(res, rej); },
    };
    return chain;
  }
  const db = jest.fn((table) => makeChain(table, db.__script, calls));
  db.__calls = calls; db.__script = {}; db.__rawCalls = [];
  db.fn = { now: () => 'now()' };
  db.transaction = jest.fn(async (fn) => {
    const trx = jest.fn((table) => makeChain(table, db.__script, calls));
    trx.raw = jest.fn(async (...a) => { db.__rawCalls.push(a); return { rows: [] }; });
    trx.fn = { now: () => 'now()' };
    trx.isTransaction = true;
    return fn(trx);
  });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/job-status', () => ({ transitionJobStatus: jest.fn().mockResolvedValue({}) }));
jest.mock('../services/appointment-reminders', () => ({ handleReschedule: jest.fn().mockResolvedValue({}) }));
jest.mock('../services/scheduling/occupancy', () => ({ findConflictingVisits: jest.fn().mockResolvedValue([]), acquireOccupancyLock: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/dispatch-assignment', () => ({ assignDispatchJob: jest.fn().mockResolvedValue({ changed: true }) }));
jest.mock('../services/tech-visit-notifications', () => ({ notifyVisitRescheduled: jest.fn(), notifyTechVisitChange: jest.fn(), notifyAssignmentChange: jest.fn() }));

const db = require('../models/db');
const AppointmentReminders = require('../services/appointment-reminders');
const { assignDispatchJob } = require('../services/dispatch-assignment');
const { findConflictingVisits } = require('../services/scheduling/occupancy');
const { moveVisitAsUnit, visitSummaryForService, _test: { shiftClock, expectMatchesRow } } = require('../services/visit-groups');

const VISIT = { id: 'v1', status: 'open', stop_base_key: 'p1:2026-08-30', scheduled_date: '2026-08-30', customer_id: 'c1', property_id: 'p1', technician_id: 't1', window_start: '09:00', window_end: '11:00' };
const member = (id, over = {}) => ({ id, status: 'confirmed', technician_id: 't1', customer_id: 'c1', property_id: 'p1', scheduled_date: '2026-08-30', window_start: '09:00', window_end: '10:00', ...over });
const SERVICE = { id: 'a', visit_id: 'v1' };

function fakeRebooker(behaviour = {}) {
  const impl = async (id, date, win, reason, by, opts) => {
    if (behaviour[id] === 'throw') throw Object.assign(new Error(`member ${id} boom`), { code: 'SLOT_TAKEN' });
    // An object behaviour is merged into the result (e.g. the committed holder the rebooker reports).
    return { success: true, originalDate: '2026-08-30', newDate: date, id, win, opts, ...(behaviour[id] && typeof behaviour[id] === 'object' ? behaviour[id] : {}) };
  };
  return { reschedule: jest.fn(impl), rescheduleSeries: jest.fn(impl) };
}

beforeEach(() => { db.__calls.length = 0; db.__rawCalls.length = 0; db.__script = {}; jest.clearAllMocks(); });

describe('shiftClock', () => {
  test('shifts HH:MM by minutes, wrapping the day', () => {
    expect(shiftClock('09:00', 90)).toBe('10:30');
    expect(shiftClock('23:30', 60)).toBe('00:30');
    expect(shiftClock(null, 60)).toBe(null);
  });
});

describe('visitSummaryForService', () => {
  test('an ungrouped or unknown row has no summary; a grouped row gets the full membership with its live count', async () => {
    db.__script = { scheduled_services: { first: () => null } };
    expect(await visitSummaryForService(db, 'a')).toBe(null);
    db.__script = { scheduled_services: { first: () => ({ visit_id: null }) } };
    expect(await visitSummaryForService(db, 'a')).toBe(null);
    db.__script = { scheduled_services: {
      first: () => ({ visit_id: 'v1' }),
      select: () => [
        { id: 'a', visit_id: 'v1', status: 'confirmed', service_type: 'Lawn Care', estimated_duration_minutes: 30 },
        { id: 'b', visit_id: 'v1', status: 'pending', service_type: 'Pest Control', estimated_duration_minutes: 45 },
        { id: 'c', visit_id: 'v1', status: 'cancelled', service_type: 'Mosquito', estimated_duration_minutes: 20 },
      ],
    } };
    expect(await visitSummaryForService(db, 'a')).toMatchObject({
      id: 'v1', serviceCount: 3, liveCount: 2, memberIds: ['a', 'b', 'c'], liveMemberIds: ['a', 'b'], serviceTypes: ['Lawn Care', 'Pest Control', 'Mosquito'],
    });
  });
});

describe('moveVisitAsUnit', () => {
  // scheduled_services.select answers the PLAN read (forUpdate) with `members`
  // and the RETARGET read (no forUpdate) with `landed`.
  // The pre-primary REVALIDATION read (whereIn id, no forUpdate) answers with
  // `revalidate` (default: the members as planned, i.e. unchanged).
  const script = ({ visit = VISIT, members, landed = null, maxSeq = 0, revalidate = null, first = null }) => ({
    service_visits: { first: (ops) => (ops.some((o) => o[0] === 'max') ? { max: maxSeq } : visit) },
    scheduled_services: { select: (ops) => (ops.some((o) => o[0] === 'orderBy') ? (landed || members.map((m) => ({ ...m, scheduled_date: '2026-09-02' }))) // retarget read (FOR UPDATE + ORDER BY)
        : ops.some((o) => o[0] === 'forUpdate') ? members
      : ops.some((o) => o[0] === 'whereIn' && o[1] === 'id') ? (revalidate || members.map((m) => ({ ...m, visit_id: 'v1' })))
        : (landed || members.map((m) => ({ ...m, scheduled_date: '2026-09-02' })))),
      first: (ops, cols) => (first ? first(ops, cols) : null),
    },
  });

  test('ungrouped row / dissolved visit / single live member ⇒ null (plain move); a non-open non-dissolved visit REFUSES (P0 r36)', async () => {
    expect(await moveVisitAsUnit({ rebooker: fakeRebooker(), serviceId: 'a', service: { id: 'a', visit_id: null }, newDate: '2026-09-02' })).toBe(null);
    db.__script = script({ visit: { ...VISIT, status: 'dissolved' }, members: [] });
    expect(await moveVisitAsUnit({ rebooker: fakeRebooker(), serviceId: 'a', service: SERVICE, newDate: '2026-09-02' })).toBe(null);
    db.__script = script({ members: [member('a')] });
    expect(await moveVisitAsUnit({ rebooker: fakeRebooker(), serviceId: 'a', service: SERVICE, newDate: '2026-09-02' })).toBe(null);
  });

  test('options.moveGuard runs for EVERY member in the assignment transaction with the destination tech, before assignDispatchJob; a refusal leaves that member on its old tech and reported failed', async () => {
    // landed rows: a re-pointed to t2 by the (mocked) assignment; b refused, so it stays on t1
    db.__script = script({ members: [member('a'), member('b', { window_start: '10:00', window_end: '11:00' })], landed: [
      { id: 'a', scheduled_date: '2026-09-02', window_start: '13:00', window_end: '14:00', technician_id: 't2' },
      { id: 'b', scheduled_date: '2026-09-02', window_start: '14:00', window_end: '15:00', technician_id: 't1' },
    ] });
    const seen = [];
    const moveGuard = jest.fn(async ({ trx, technicianId, service }) => {
      seen.push({ trxIsFn: typeof trx === 'function', technicianId, id: service.id, assignsSoFar: assignDispatchJob.mock.calls.length });
      if (service.id === 'b') throw Object.assign(new Error('deactivated for lawn'), { statusCode: 409, code: 'VISIT_AUTO_DISPATCH_CAPABILITY_GUARD' });
    });
    const out = await moveVisitAsUnit({ rebooker: fakeRebooker(), serviceId: 'a', service: SERVICE, newDate: '2026-09-02', newWindow: '13:00-14:00', reason: 'auto_dispatch', initiatedBy: 'auto_dispatch', options: { technicianId: 't2', moveGuard } });
    // both members checked against the DESTINATION (t2), each before its own assignment write
    expect(seen).toEqual([
      { trxIsFn: true, technicianId: 't2', id: 'a', assignsSoFar: 0 },
      { trxIsFn: true, technicianId: 't2', id: 'b', assignsSoFar: 1 },
    ]);
    // a assigned; b refused → never assigned, reported failed
    expect(assignDispatchJob).toHaveBeenCalledTimes(1);
    expect(assignDispatchJob.mock.calls[0][0]).toMatchObject({ jobId: 'a', technicianId: 't2' });
    // b's row DID move (its rebooker call committed) but stays on its old tech: reported
    // "moved but unassigned", never silently split-tech; a is clean.
    expect(out.visitMove.moved).toEqual(['a', 'b']);
    expect(out.visitMove.failed).toEqual([
      expect.objectContaining({ id: 'b', movedButUnassigned: true, code: 'VISIT_AUTO_DISPATCH_CAPABILITY_GUARD' }),
    ]);
  });

  test('a v2 allocation appearing after the time move is read FOR UPDATE and refuses technician assignment', async () => {
    const allocation = { version: 2, allocatedServiceIds: ['b', 'capacity-peer'] };
    const members = [member('a'), member('b', { window_start: '10:00', window_end: '11:00' })];
    db.__script = script({ members, landed: [
      { id: 'a', scheduled_date: '2026-09-02', window_start: '13:00', window_end: '14:00', technician_id: 't2' },
      { id: 'b', scheduled_date: '2026-09-02', window_start: '14:00', window_end: '15:00', technician_id: 't1' },
    ], first: (ops) => {
      const where = ops.find((op) => op[0] === 'where' && op[1]?.id);
      if (!ops.some((op) => op[0] === 'forUpdate') || !where) return null;
      return {
        window_start: where[1].id === 'a' ? '13:00' : '14:00', window_end: where[1].id === 'a' ? '14:00' : '15:00',
        estimated_duration_minutes: 60, service_type: 'Pest Control',
        reservation_service_mix: where[1].id === 'b' ? allocation : null,
      };
    } });
    const moveGuard = jest.fn(async ({ service }) => {
      if (service.reservation_service_mix?.version === 2) {
        throw Object.assign(new Error('allocation must move as one unit'), { statusCode: 409, code: 'VISIT_AUTO_DISPATCH_CAPABILITY_GUARD' });
      }
    });

    const out = await moveVisitAsUnit({
      rebooker: fakeRebooker(), serviceId: 'a', service: SERVICE, newDate: '2026-09-02', newWindow: '13:00-14:00',
      initiatedBy: 'auto_dispatch', options: { technicianId: 't2', moveGuard },
    });

    const bRead = db.__calls.find((call) => call.table === 'scheduled_services' && call.op === 'first'
      && call.ops.some((op) => op[0] === 'where' && op[1]?.id === 'b')
      && call.cols.includes('reservation_service_mix'));
    expect(bRead.ops).toContainEqual(['forUpdate']);
    expect(bRead.cols).toContain('reservation_service_mix');
    expect(moveGuard).toHaveBeenCalledWith(expect.objectContaining({ service: expect.objectContaining({ id: 'b', reservation_service_mix: allocation }) }));
    expect(assignDispatchJob).toHaveBeenCalledTimes(1);
    expect(out.visitMove.failed).toEqual([expect.objectContaining({ id: 'b', movedButUnassigned: true })]);
  });

  test('date + window move: members moved first (primary with caller options, siblings with their OWN fence), then the parent retargeted from the rows that landed', async () => {
    db.__script = script({ members: [member('a'), member('b', { window_start: '10:00', window_end: '11:00' })], landed: [
      { id: 'a', scheduled_date: '2026-09-02', window_start: '13:00', window_end: '14:00', technician_id: 't1' },
      { id: 'b', scheduled_date: '2026-09-02', window_start: '14:00', window_end: '15:00', technician_id: 't1' },
    ] });
    const rebooker = fakeRebooker();
    const out = await moveVisitAsUnit({ rebooker, serviceId: 'a', service: SERVICE, newDate: '2026-09-02', newWindow: '13:00-14:00', reason: 'rain', initiatedBy: 'admin', options: { allowLive: false, expect: { scheduled_date: '2026-08-30', window_start: '09:00' }, expectOccurrenceIds: ['x'], technicianId: 't1' } });
    expect(out.visitMove).toMatchObject({ visitId: 'v1', moved: ['a', 'b'], failed: [] });
    expect(out.success).toBe(true);
    // primary first with the requested window + the caller's own pins; sibling shifted +4h with a fence from ITS locked row, never the primary's
    const [pCall, sCall] = rebooker.reschedule.mock.calls;
    expect(pCall[0]).toBe('a'); expect(pCall[2]).toBe('13:00-14:00');
    expect(pCall[5]).toMatchObject({ visitPolicy: 'single', skipVisitSeam: true, expect: { scheduled_date: '2026-08-30', window_start: '09:00' }, expectOccurrenceIds: ['x'] });
    expect(sCall[0]).toBe('b'); expect(sCall[2]).toBe('14:00-15:00');
    expect(sCall[5]).toMatchObject({ visitPolicy: 'single', skipVisitSeam: true, expect: { scheduled_date: '2026-08-30', window_start: '10:00', window_end: '11:00', visit_id: 'v1', technician_id: 't1' } });
    expect(sCall[5].expectOccurrenceIds).toBeUndefined();
    // Second technician: a unit move that NAMES a technician strips it from the member calls and
    // re-points the rows after, so the members' occupancy probes stay tech-blind (alignMember's
    // own destination probe is) — never scoped to the technician the row is about to leave.
    expect(pCall[5]).toMatchObject({ occupancyTechBlind: true });
    expect(sCall[5]).toMatchObject({ occupancyTechBlind: true });
    // each move hides only the OTHER participating rows from its probes (codex r6)
    expect(rebooker.reschedule.mock.calls[0][5].excludeServiceIds).toEqual(['b']);
    expect(rebooker.reschedule.mock.calls[1][5].excludeServiceIds).toEqual(['a']);
    // every moved SIBLING gets its reminder row synced (notice suppressed); the primary's is the caller's job
    expect(AppointmentReminders.handleReschedule).toHaveBeenCalledTimes(1);
    expect(AppointmentReminders.handleReschedule).toHaveBeenCalledWith('b', '2026-09-02T14:00', { sendNotification: false, keepPendingConfirmation: true, preserveMoveHold: true, expectSchedule: { date: '2026-09-02', windowStart: '14:00' } });
    // parent retarget AFTER the moves: both stop keys locked in sorted order, patch from the landed rows, lifecycle reset + tracker effects re-armed on the date change, technician carried
    const rawKeys = db.__rawCalls.map((a) => a[1][1]);
    const pairIdx = rawKeys.findIndex((k, i) => k === 'p1:2026-08-30' && rawKeys[i + 1] === 'p1:2026-09-02');
    expect(pairIdx).toBeGreaterThan(0); // after the plan lock: both keys, sorted
    const patch = db.__calls.find((c) => c.table === 'service_visits' && c.op === 'update' && c.values.scheduled_date);
    expect(patch.values).toMatchObject({ scheduled_date: '2026-09-02', window_start: '13:00', window_end: '15:00', stop_base_key: 'p1:2026-09-02', stop_seq: 1, technician_id: 't1', en_route_at: null, arrived_at: null });
    const effDel = db.__calls.find((c) => c.table === 'visit_effects' && c.op === 'del');
    expect(effDel.ops).toEqual(expect.arrayContaining([['whereIn', 'effect_type', ['tracker_en_route', 'tracker_arrived']]]));
    // every parent write happened AFTER the member moves
    const firstPatchIdx = db.__calls.findIndex((c) => c.table === 'service_visits' && c.op === 'update');
    expect(rebooker.reschedule.mock.calls.length).toBe(2);
    expect(firstPatchIdx).toBeGreaterThan(-1);
  });

  test('the day-only intent (customerAskedTime, sourceSurface) reaches EVERY member\'s own rebooker call, so each member\'s UPDATE records it', async () => {
    db.__script = script({ members: [member('a'), member('b', { window_start: '10:00', window_end: '11:00' })], landed: [
      { id: 'a', scheduled_date: '2026-09-02', window_start: '13:00', window_end: '14:00' },
      { id: 'b', scheduled_date: '2026-09-02', window_start: '14:00', window_end: '15:00' },
    ] });
    const rebooker = fakeRebooker();
    await moveVisitAsUnit({ rebooker, serviceId: 'a', service: SERVICE, newDate: '2026-09-02', newWindow: '13:00-14:00', reason: 'rain', initiatedBy: 'admin', options: { allowLive: false, sourceSurface: 'dispatch_board', customerAskedTime: false } });
    const [pCall, sCall] = rebooker.reschedule.mock.calls;
    expect(pCall[5]).toMatchObject({ customerAskedTime: false, sourceSurface: 'dispatch_board' });
    expect(sCall[5]).toMatchObject({ customerAskedTime: false, sourceSurface: 'dispatch_board' });
  });

  test('date-only move keeps every member window; explicit technicianId null unassigns the visit', async () => {
    db.__script = script({ members: [member('a'), member('b')], maxSeq: 2, landed: [
      { id: 'a', scheduled_date: '2026-09-02', window_start: '09:00', window_end: '10:00' },
      { id: 'b', scheduled_date: '2026-09-02', window_start: '09:00', window_end: '10:00' },
    ] });
    const rebooker = fakeRebooker();
    await moveVisitAsUnit({ rebooker, serviceId: 'a', service: SERVICE, newDate: '2026-09-02', options: { technicianId: null } });
    expect(rebooker.reschedule.mock.calls.every((c) => c[2] === null)).toBe(true);
    const patch = db.__calls.find((c) => c.table === 'service_visits' && c.op === 'update' && c.values.scheduled_date);
    expect(patch.values).toMatchObject({ scheduled_date: '2026-09-02', window_start: '09:00', window_end: '10:00', stop_base_key: 'p1:2026-09-02', stop_seq: 3, technician_id: null });
  });

  test('a visit already at the target (route-wide batch reaching it through a second member) is a no-op', async () => {
    // the first member's move already retargeted the parent to the new stop
    db.__script = script({ visit: { ...VISIT, scheduled_date: '2026-09-02', stop_base_key: 'p1:2026-09-02' }, members: [member('a', { scheduled_date: '2026-09-02' }), member('b', { scheduled_date: '2026-09-02' })] });
    const rebooker = fakeRebooker();
    const out = await moveVisitAsUnit({ rebooker, serviceId: 'b', service: { id: 'b', visit_id: 'v1' }, newDate: '2026-09-02' });
    expect(out.visitMove).toMatchObject({ moved: [], failed: [], alreadyAtTarget: true });
    expect(rebooker.reschedule).not.toHaveBeenCalled();
    // The no-op REPAIRS a stale parent in place (codex r37): the fixture's
    // visit record still names the old stop while every member sits at the
    // target — the re-save retargets it and releases any retained hold.
    const parentPatch = db.__calls.find((c) => c.table === 'service_visits' && c.op === 'update');
    expect(parentPatch.values).toMatchObject({ scheduled_date: '2026-09-02' });

  });

  test('one immovable member refuses the whole move before anything changes', async () => {
    db.__script = script({ members: [member('a'), member('b', { status: 'on_site' })] });
    const rebooker = fakeRebooker();
    await expect(moveVisitAsUnit({ rebooker, serviceId: 'a', service: SERVICE, newDate: '2026-09-02' })).rejects.toMatchObject({ statusCode: 409, code: 'VISIT_MEMBER_NOT_MOVABLE', memberId: 'b' });
    expect(rebooker.reschedule).not.toHaveBeenCalled();
    expect(db.__calls.some((c) => c.table === 'service_visits' && c.op === 'update')).toBe(false);
  });

  test('the primary failing rethrows with NOTHING changed; a sibling failing is reported and the parent still retargets to the rows that landed', async () => {
    db.__script = script({ members: [member('a'), member('b')] });
    await expect(moveVisitAsUnit({ rebooker: fakeRebooker({ a: 'throw' }), serviceId: 'a', service: SERVICE, newDate: '2026-09-02' })).rejects.toThrow('member a boom');
    expect(db.__calls.some((c) => c.table === 'service_visits' && c.op === 'update')).toBe(false);
    db.__calls.length = 0;
    db.__script = script({ members: [member('a'), member('b')], landed: [{ id: 'a', scheduled_date: '2026-09-02', window_start: '09:00', window_end: '10:00' }, { id: 'b', scheduled_date: '2026-08-30', window_start: '09:00', window_end: '10:00' }] });
    const out = await moveVisitAsUnit({ rebooker: fakeRebooker({ b: 'throw' }), serviceId: 'a', service: SERVICE, newDate: '2026-09-02' });
    expect(out.visitMove).toMatchObject({ visitId: 'v1', moved: ['a'], failed: [{ id: 'b', reason: 'member b boom', code: 'SLOT_TAKEN' }] });
    expect(out.warnings.some((w) => /1 grouped service\(s\) did not move/.test(w))).toBe(true);
    const patch = db.__calls.find((c) => c.table === 'service_visits' && c.op === 'update' && c.values.scheduled_date);
    expect(patch.values).toMatchObject({ scheduled_date: '2026-09-02', window_start: '09:00', window_end: '10:00' });
  });

  test('warnings from every moved member are aggregated', async () => {
    db.__script = script({ members: [member('a'), member('b')] });
    const rebooker = { reschedule: jest.fn(async (id) => ({ success: true, warnings: id === 'b' ? ['b overlaps another job'] : [] })) };
    const out = await moveVisitAsUnit({ rebooker, serviceId: 'a', service: SERVICE, newDate: '2026-09-02' });
    expect(out.warnings).toEqual(['b overlaps another job']);
  });

  test('no-op requires the END and the explicit technician to match too — a technician-only resubmit still moves', async () => {
    db.__script = script({ visit: { ...VISIT, scheduled_date: '2026-09-02', stop_base_key: 'p1:2026-09-02' }, members: [member('a', { scheduled_date: '2026-09-02' }), member('b', { scheduled_date: '2026-09-02' })] });
    const rebooker = fakeRebooker();
    const out = await moveVisitAsUnit({ rebooker, serviceId: 'a', service: SERVICE, newDate: '2026-09-02', options: { technicianId: 't9' } });
    expect(out.visitMove.alreadyAtTarget).toBeUndefined();
    expect(rebooker.reschedule).toHaveBeenCalledTimes(2);
    db.__calls.length = 0; jest.clearAllMocks();
    db.__script = script({ visit: { ...VISIT, scheduled_date: '2026-09-02', stop_base_key: 'p1:2026-09-02' }, members: [member('a', { scheduled_date: '2026-09-02' }), member('b', { scheduled_date: '2026-09-02' })] });
    const out2 = await moveVisitAsUnit({ rebooker: fakeRebooker(), serviceId: 'a', service: SERVICE, newDate: '2026-09-02', newWindow: '09:00-10:30' });
    expect(out2.visitMove.alreadyAtTarget).toBeUndefined(); // end changed 10:00 → 10:30
  });

  test('SCOPE: a customer self-serve move and an explicit series-scoped move of a grouped visit are refused before anything is written', async () => {
    db.__script = script({ members: [member('a'), member('b')] });
    const rebooker = fakeRebooker();
    await expect(moveVisitAsUnit({ rebooker, serviceId: 'a', service: SERVICE, newDate: '2026-09-02', initiatedBy: 'customer_self_serve' }))
      .rejects.toMatchObject({ statusCode: 409, code: 'VISIT_CUSTOMER_MOVE_UNSUPPORTED' });
    await expect(moveVisitAsUnit({ rebooker, serviceId: 'a', service: SERVICE, newDate: '2026-09-02', initiatedBy: 'admin', options: { primaryViaSeries: true } }))
      .rejects.toMatchObject({ statusCode: 409, code: 'VISIT_SERIES_MOVE_UNSUPPORTED' });
    expect(rebooker.reschedule).not.toHaveBeenCalled();
    expect(rebooker.rescheduleSeries).not.toHaveBeenCalled();
    expect(db.__calls.some((c) => c.op === 'update')).toBe(false);
  });

  test('a windowless tapped row takes the requested slot; a windowless sibling stays windowless', async () => {
    db.__script = script({ members: [member('a', { window_start: null, window_end: null }), member('b', { window_start: null, window_end: null })] });
    const rebooker = fakeRebooker();
    await moveVisitAsUnit({ rebooker, serviceId: 'a', service: SERVICE, newDate: '2026-09-02', newWindow: '13:00-14:00' });
    expect(rebooker.reschedule.mock.calls[0][2]).toBe('13:00-14:00');
    expect(rebooker.reschedule.mock.calls[1][2]).toBe(null);
  });

  test('a grouped cadence anchor never widens into a collective series move (gate on, date change, no explicit single scope) — this-visit-only proceeds (local audit)', async () => {
    const prevGate = process.env.GATE_ADMIN_COLLECTIVE_MOVE;
    process.env.GATE_ADMIN_COLLECTIVE_MOVE = 'true';
    try {
      db.__script = script({ members: [member('a', { is_recurring: true }), member('b')] });
      const rb = fakeRebooker();
      await expect(moveVisitAsUnit({ rebooker: rb, serviceId: 'a', service: SERVICE, newDate: '2026-09-02', initiatedBy: 'admin' }))
        .rejects.toMatchObject({ statusCode: 409, code: 'VISIT_SERIES_MOVE_UNSUPPORTED' });
      expect(rb.reschedule).not.toHaveBeenCalled();
      db.__script = script({ members: [member('a', { is_recurring: true }), member('b')] });
      const out = await moveVisitAsUnit({ rebooker: rb, serviceId: 'a', service: SERVICE, newDate: '2026-09-02', initiatedBy: 'admin', options: { seriesPolicy: 'single' } });
      expect(out.visitMove.moved).toEqual(['a', 'b']);
      // a same-day window move of a cadence anchor never widens (no date change) ⇒ allowed
      db.__script = script({ visit: { ...VISIT, scheduled_date: '2026-08-30' }, members: [member('a', { is_recurring: true }), member('b')], landed: [
        { id: 'a', scheduled_date: '2026-08-30', window_start: '13:00', window_end: '14:00', technician_id: 't1' },
        { id: 'b', scheduled_date: '2026-08-30', window_start: '13:00', window_end: '14:00', technician_id: 't1' },
      ] });
      const same = await moveVisitAsUnit({ rebooker: fakeRebooker(), serviceId: 'a', service: SERVICE, newDate: '2026-08-30', newWindow: '13:00-14:00', initiatedBy: 'admin' });
      expect(same.visitMove.moved).toEqual(['a', 'b']);
    } finally {
      if (prevGate === undefined) delete process.env.GATE_ADMIN_COLLECTIVE_MOVE; else process.env.GATE_ADMIN_COLLECTIVE_MOVE = prevGate;
    }
  });

  test('lawn rounds size rule: a grouped one-off moves the whole visit as a unit; a bigger move still refuses the implicit series move', async () => {
    const prevGate = process.env.GATE_ADMIN_COLLECTIVE_MOVE;
    process.env.GATE_ADMIN_COLLECTIVE_MOVE = 'true';
    const rounds = { is_recurring: true, recurring_pattern: 'lawn_rounds_9' };
    try {
      // Aug 30 -> Sep 2: 3 days, both in round 7 (Aug 22 - Sep 30): a one-off, no series move.
      db.__script = script({ members: [member('a', rounds), member('b')] });
      const out = await moveVisitAsUnit({ rebooker: fakeRebooker(), serviceId: 'a', service: SERVICE, newDate: '2026-09-02', initiatedBy: 'admin' });
      expect(out.visitMove.moved).toEqual(['a', 'b']);
      // Aug 30 -> Sep 25: 26 days re-anchors the series, which this mover cannot carry.
      db.__script = script({ members: [member('a', rounds), member('b')] });
      const rb = fakeRebooker();
      await expect(moveVisitAsUnit({ rebooker: rb, serviceId: 'a', service: SERVICE, newDate: '2026-09-25', initiatedBy: 'admin' }))
        .rejects.toMatchObject({ statusCode: 409, code: 'VISIT_SERIES_MOVE_UNSUPPORTED' });
      expect(rb.reschedule).not.toHaveBeenCalled();
    } finally {
      if (prevGate === undefined) delete process.env.GATE_ADMIN_COLLECTIVE_MOVE; else process.env.GATE_ADMIN_COLLECTIVE_MOVE = prevGate;
    }
  });

  test('a windowless tapped row anchors the sibling offset on the VISIT start; no anchor at all with windowed siblings is refused (local audit)', async () => {
    // visit start 09:00 (VISIT), tapped row windowless, sibling 10:00-11:00, request 13:00 ⇒ +4h ⇒ sibling 14:00-15:00
    db.__script = script({ members: [member('a', { window_start: null, window_end: null }), member('b', { window_start: '10:00', window_end: '11:00' })] });
    let rebooker = fakeRebooker();
    await moveVisitAsUnit({ rebooker, serviceId: 'a', service: SERVICE, newDate: '2026-09-02', newWindow: '13:00-14:00' });
    expect(rebooker.reschedule.mock.calls[0][2]).toBe('13:00-14:00');
    expect(rebooker.reschedule.mock.calls[1][2]).toBe('14:00-15:00');
    // no visit start either ⇒ ambiguous ⇒ refused before any write
    db.__script = script({ visit: { ...VISIT, window_start: null, window_end: null }, members: [member('a', { window_start: null, window_end: null }), member('b', { window_start: '10:00', window_end: '11:00' })] });
    rebooker = fakeRebooker();
    await expect(moveVisitAsUnit({ rebooker, serviceId: 'a', service: SERVICE, newDate: '2026-09-02', newWindow: '13:00-14:00' }))
      .rejects.toMatchObject({ statusCode: 409, code: 'VISIT_WINDOWLESS_ANCHOR_MOVE_UNSUPPORTED' });
    expect(rebooker.reschedule).not.toHaveBeenCalled();
  });

  test('a caller without a scheduling fence gets the locked plan fence on the primary; a fenced caller keeps its own', async () => {
    db.__script = script({ members: [member('a'), member('b')] });
    let rebooker = fakeRebooker();
    await moveVisitAsUnit({ rebooker, serviceId: 'a', service: SERVICE, newDate: '2026-09-02' });
    expect(rebooker.reschedule.mock.calls[0][5].expect).toEqual({ scheduled_date: '2026-08-30', window_start: '09:00', window_end: '10:00', visit_id: 'v1', technician_id: 't1', status: 'confirmed', reservation_service_mix: null });
    jest.clearAllMocks(); db.__script = script({ members: [member('a'), member('b')] });
    rebooker = fakeRebooker();
    await moveVisitAsUnit({ rebooker, serviceId: 'a', service: SERVICE, newDate: '2026-09-02', options: { expectAnchor: { scheduled_date: '2026-08-30' } } });
    // a caller fencing via expectAnchor keeps it AND still gets the unit fence on expect (codex r8)
    expect(rebooker.reschedule.mock.calls[0][5].expect).toEqual({ visit_id: 'v1', technician_id: 't1' });
    expect(rebooker.reschedule.mock.calls[0][5].expectAnchor).toEqual({ scheduled_date: '2026-08-30' });
    // a caller's own expect fields are merged ON TOP of the unit fence, never replace it
    jest.clearAllMocks(); db.__script = script({ members: [member('a'), member('b')] });
    rebooker = fakeRebooker();
    await moveVisitAsUnit({ rebooker, serviceId: 'a', service: SERVICE, newDate: '2026-09-02', options: { expect: { auto_dispatch_locked: false, status: 'confirmed' } } });
    expect(rebooker.reschedule.mock.calls[0][5].expect).toEqual({ visit_id: 'v1', technician_id: 't1', auto_dispatch_locked: false, status: 'confirmed' });
  });

  test('sibling reminder sync is fenced with expectSchedule against a newer move', async () => {
    db.__script = script({ members: [member('a'), member('b', { window_start: '10:00', window_end: '11:00' })] });
    await moveVisitAsUnit({ rebooker: fakeRebooker(), serviceId: 'a', service: SERVICE, newDate: '2026-09-02', newWindow: '13:00-14:00' });
    expect(AppointmentReminders.handleReschedule).toHaveBeenCalledWith('b', '2026-09-02T14:00', { sendNotification: false, keepPendingConfirmation: true, preserveMoveHold: true, expectSchedule: { date: '2026-09-02', windowStart: '14:00' } });
  });

  test('exact retry of a committed move on a recurring primary re-enters the rebooker (series replay contract) ONLY when the request could have created a series operation', async () => {
    const committed = () => script({ visit: { ...VISIT, scheduled_date: '2026-09-02', stop_base_key: 'p1:2026-09-02' }, members: [member('a', { scheduled_date: '2026-09-02', is_recurring: true }), member('b', { scheduled_date: '2026-09-02' })] });
    const replayer = () => ({ reschedule: jest.fn(async () => ({ success: true, replayed: true, seriesMoveId: 'sm1', rescheduledOccurrences: [{ id: 'a' }] })), rescheduleSeries: jest.fn() });
    process.env.GATE_ADMIN_COLLECTIVE_MOVE = 'true';
    try {
      db.__script = committed();
      let rebooker = replayer();
      const out = await moveVisitAsUnit({ rebooker, serviceId: 'a', service: SERVICE, newDate: '2026-09-02' });
      expect(rebooker.reschedule).toHaveBeenCalledTimes(1);
      expect(rebooker.reschedule.mock.calls[0][5]).toMatchObject({ visitPolicy: 'single', skipVisitSeam: true });
      expect(out).toMatchObject({ replayed: true, seriesMoveId: 'sm1', visitMove: { alreadyAtTarget: true } });
      // explicit single policy (Quick Move fallback / auto-dispatch): plain no-op, no re-entry
      db.__script = committed(); rebooker = replayer();
      const single = await moveVisitAsUnit({ rebooker, serviceId: 'a', service: SERVICE, newDate: '2026-09-02', options: { seriesPolicy: 'single' } });
      expect(rebooker.reschedule).not.toHaveBeenCalled();
      expect(single).toMatchObject({ success: true, visitMove: { alreadyAtTarget: true } });
      // a committed lawn rounds one-off (the primary carries its date exception): no series operation to replay
      db.__script = script({ visit: { ...VISIT, scheduled_date: '2026-09-02', stop_base_key: 'p1:2026-09-02' }, members: [
        member('a', { scheduled_date: '2026-09-02', is_recurring: true, recurring_pattern: 'lawn_rounds_9', date_exception: true, date_exception_cadence_date: '2026-08-30' }),
        member('b', { scheduled_date: '2026-09-02' }),
      ] });
      rebooker = replayer();
      const oneOff = await moveVisitAsUnit({ rebooker, serviceId: 'a', service: SERVICE, newDate: '2026-09-02' });
      expect(rebooker.reschedule).not.toHaveBeenCalled();
      expect(oneOff).toMatchObject({ success: true, visitMove: { alreadyAtTarget: true } });
    } finally { delete process.env.GATE_ADMIN_COLLECTIVE_MOVE; }
    // collective gate dark: no series operation could exist → plain no-op
    db.__script = committed();
    const rebooker = replayer();
    await moveVisitAsUnit({ rebooker, serviceId: 'a', service: SERVICE, newDate: '2026-09-02' });
    expect(rebooker.reschedule).not.toHaveBeenCalled();
  });

  test('siblings are always single-row moves (seriesPolicy single), and visitMove.members carries each moved row\'s pre-move status', async () => {
    db.__script = script({ members: [member('a'), member('b', { status: 'pending', is_recurring: true })] });
    const rebooker = fakeRebooker();
    const out = await moveVisitAsUnit({ rebooker, serviceId: 'a', service: SERVICE, newDate: '2026-09-02', options: { seriesPolicy: 'auto' } });
    expect(rebooker.reschedule.mock.calls[1][5]).toMatchObject({ seriesPolicy: 'single', visitPolicy: 'single' });
    // No technician named: each member keeps its own, so its probe is scoped to it (rebooker.probeMoveConflicts).
    expect(rebooker.reschedule.mock.calls.every((c) => c[5].occupancyTechBlind === undefined)).toBe(true);
    const landed = { scheduled_date: '2026-09-02', window_start: '09:00', window_end: '10:00' };
    expect(out.visitMove.members).toEqual([
      { id: 'a', isPrimary: true, previousStatus: 'confirmed', landed },
      { id: 'b', isPrimary: false, previousStatus: 'pending', landed },
    ]);
  });

  test('a DERIVED sibling window that breaks the admin window rules refuses the move before any write — for every caller', async () => {
    for (const options of [{ adminWindowRules: true }, {}]) {
      db.__script = script({ members: [member('a'), member('b', { window_start: '09:30', window_end: '10:30' })] });
      const rebooker = fakeRebooker();
      await expect(moveVisitAsUnit({ rebooker, serviceId: 'a', service: SERVICE, newDate: '2026-09-02', newWindow: '13:00-14:00', options }))
        .rejects.toMatchObject({ statusCode: 409, code: 'VISIT_MEMBER_WINDOW_INVALID', memberId: 'b' });
      expect(rebooker.reschedule).not.toHaveBeenCalled();
    }
    // an on-hour sibling shifts cleanly
    db.__script = script({ members: [member('a'), member('b', { window_start: '10:00', window_end: '11:00' })] });
    const rebooker = fakeRebooker();
    await moveVisitAsUnit({ rebooker, serviceId: 'a', service: SERVICE, newDate: '2026-09-02', newWindow: '13:00-14:00' });
    expect(rebooker.reschedule.mock.calls[1][2]).toBe('14:00-15:00');
  });

  test('the primary carries excludeExpect (each hidden sibling\'s membership + snapshotted slot) so the rebooker locks and verifies them INSIDE its move transaction', async () => {
    db.__script = script({ members: [member('a'), member('b', { window_start: '10:00', window_end: '11:00' })] });
    const rebooker = fakeRebooker();
    await moveVisitAsUnit({ rebooker, serviceId: 'a', service: SERVICE, newDate: '2026-09-02', newWindow: '13:00-14:00' });
    // status rides in the contract too (local audit): a sibling gone en_route/terminal after the plan aborts the primary's move
    expect(rebooker.reschedule.mock.calls[0][5].excludeExpect).toEqual([{ id: 'b', visit_id: 'v1', scheduled_date: '2026-08-30', window_start: '10:00', window_end: '11:00', technician_id: 't1', status: 'confirmed', reservation_service_mix: null }]);
    // the sibling's own move verifies the PRIMARY at its landed target (codex r6)
    expect(rebooker.reschedule.mock.calls[1][5].excludeExpect).toEqual([{ id: 'a', visit_id: 'v1', scheduled_date: '2026-09-02', window_start: '13:00', window_end: '14:00', reservation_service_mix: null }]);
    expect(rebooker.reschedule.mock.calls[1][5].excludeServiceIds).toEqual(['a']);
    // a stale snapshot is the rebooker's 409 (VISIT_PLAN_STALE) — the primary never commits, nothing moved
    db.__script = script({ members: [member('a'), member('b')] });
    const stale = { reschedule: jest.fn(async () => { throw Object.assign(new Error('stale'), { statusCode: 409, code: 'VISIT_PLAN_STALE' }); }), rescheduleSeries: jest.fn() };
    await expect(moveVisitAsUnit({ rebooker: stale, serviceId: 'a', service: SERVICE, newDate: '2026-09-02' })).rejects.toMatchObject({ code: 'VISIT_PLAN_STALE' });
    expect(stale.reschedule).toHaveBeenCalledTimes(1);
  });

  test('auto-dispatch: a grouped member locked or excluded from auto-dispatch fails the whole unit move before any write', async () => {
    db.__script = script({ members: [member('a'), member('b', { auto_dispatch_locked: true })] });
    const rebooker = fakeRebooker();
    await expect(moveVisitAsUnit({ rebooker, serviceId: 'a', service: SERVICE, newDate: '2026-09-02', initiatedBy: 'auto_dispatch' }))
      .rejects.toMatchObject({ statusCode: 409, code: 'VISIT_MEMBER_AUTO_DISPATCH_OPT_OUT', memberId: 'b' });
    db.__script = script({ members: [member('a'), member('b', { auto_dispatch_excluded: true })] });
    await expect(moveVisitAsUnit({ rebooker, serviceId: 'a', service: SERVICE, newDate: '2026-09-02', initiatedBy: 'auto_dispatch' }))
      .rejects.toMatchObject({ code: 'VISIT_MEMBER_AUTO_DISPATCH_OPT_OUT' });
    expect(rebooker.reschedule).not.toHaveBeenCalled();
    // staff moves ignore the auto-dispatch flags
    db.__script = script({ members: [member('a'), member('b', { auto_dispatch_locked: true })] });
    await moveVisitAsUnit({ rebooker, serviceId: 'a', service: SERVICE, newDate: '2026-09-02', initiatedBy: 'admin' });
    expect(rebooker.reschedule).toHaveBeenCalledTimes(2);
  });

  test('auto-dispatch preflights every grouped member allocation before the first write', async () => {
    db.__script = script({ members: [
      member('a'),
      member('b', { reservation_service_mix: { version: 2, allocatedServiceIds: ['b', 'c'] } }),
    ] });
    const rebooker = fakeRebooker();

    await expect(moveVisitAsUnit({
      rebooker, serviceId: 'a', service: SERVICE, newDate: '2026-09-02', initiatedBy: 'auto_dispatch',
    })).rejects.toMatchObject({
      statusCode: 409, code: 'VISIT_MEMBER_AUTO_DISPATCH_GUARD', memberId: 'b',
    });

    expect(rebooker.reschedule).not.toHaveBeenCalled();
    expect(db.__calls.some((call) => call.op === 'update')).toBe(false);
  });

  test('a conflict unique to a later sibling rejects before the primary write', async () => {
    db.__script = script({ members: [
      member('a', { window_start: '09:00', window_end: '10:00' }),
      member('b', { window_start: '10:00', window_end: '11:00' }),
    ] });
    findConflictingVisits
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'outside-job' }]);
    const rebooker = fakeRebooker();

    await expect(moveVisitAsUnit({
      rebooker, serviceId: 'a', service: SERVICE, newDate: '2026-09-02', initiatedBy: 'auto_dispatch',
    })).rejects.toMatchObject({
      statusCode: 409, code: 'SLOT_TAKEN', memberId: 'b', conflictId: 'outside-job',
    });

    expect(rebooker.reschedule).not.toHaveBeenCalled();
    expect(db.__calls.some((call) => call.op === 'update')).toBe(false);
  });

  test('rejecting a clear-end-only move does not count the unchanged end as a landed move', async () => {
    const before = member('a', { window_start: '09:00', window_end: '10:00' });
    db.__script = script({ members: [before, member('b')], landed: [before, member('b')] });
    const rebooker = fakeRebooker({ a: 'throw' });
    await expect(moveVisitAsUnit({ rebooker, serviceId: 'a', service: SERVICE,
      newDate: before.scheduled_date, newWindow: { start: '09:00', end: null },
      initiatedBy: 'admin', options: { clearWindowEnd: true },
    })).rejects.toThrow('member a boom');
    expect(rebooker.reschedule).toHaveBeenCalledTimes(1);
  });

  test('null-end preflight honors the writer rollback switch and clearWindowEnd reaches the primary write', async () => {
    process.env.REBOOKER_NULL_END_OCCUPANCY = 'off';
    try {
      db.__script = script({ members: [
        member('a', { window_end: '10:00' }),
        member('b', { window_start: null, window_end: null }),
      ] });
      findConflictingVisits.mockResolvedValue([{ id: 'outside-job' }]);
      const rebooker = fakeRebooker();

      await moveVisitAsUnit({
        rebooker, serviceId: 'a', service: SERVICE, newDate: '2026-09-02',
        newWindow: { start: '13:00', end: null }, initiatedBy: 'admin',
        options: { clearWindowEnd: true },
      });

      expect(findConflictingVisits).not.toHaveBeenCalled();
      expect(rebooker.reschedule.mock.calls[0].slice(0, 3)).toEqual(['a', '2026-09-02', { start: '13:00', end: null }]);
    } finally {
      delete process.env.REBOOKER_NULL_END_OCCUPANCY;
    }
  });

  test('a cleared preflight advisory is absent from the final committed-writer report', async () => {
    db.__script = script({ members: [member('a'), member('b')] });
    findConflictingVisits
      .mockResolvedValueOnce([{ id: 'a', warning: 'The promised arrival window cannot be reached in route order.' }])
      .mockResolvedValue([]);

    const out = await moveVisitAsUnit({
      rebooker: fakeRebooker(), serviceId: 'a', service: SERVICE, newDate: '2026-09-02',
      initiatedBy: 'admin', options: { overlapAdvisory: true, adminWindowRules: true },
    });

    expect(out.warnings).toBeUndefined();
  });

  test('a persistent advisory is reported once from the committed member writer, not duplicated from preflight', async () => {
    const warning = 'The promised arrival window cannot be reached in route order.';
    db.__script = script({ members: [member('a'), member('b')] });
    findConflictingVisits
      .mockResolvedValueOnce([{ id: 'outside-job', warning }])
      .mockResolvedValue([]);
    const rebooker = fakeRebooker({ a: { warnings: [warning] } });

    const out = await moveVisitAsUnit({
      rebooker, serviceId: 'a', service: SERVICE, newDate: '2026-09-02',
      initiatedBy: 'admin', options: { overlapAdvisory: true, adminWindowRules: true },
    });

    expect(out.warnings).toEqual([warning]);
  });

  test('auto-dispatch cross-day groups fail closed when atomic unit commit is required; same-day and manual moves remain', async () => {
    db.__script = script({ members: [member('a'), member('b')] });
    const automatic = fakeRebooker();
    await expect(moveVisitAsUnit({
      rebooker: automatic, serviceId: 'a', service: SERVICE, newDate: '2026-09-02',
      initiatedBy: 'auto_dispatch', options: { requireAtomicUnit: true },
    })).rejects.toMatchObject({ code: 'VISIT_MEMBER_AUTO_DISPATCH_GUARD', memberId: 'a' });
    expect(automatic.reschedule).not.toHaveBeenCalled();

    db.__script = script({ members: [member('a'), member('b')] });
    const sameDay = fakeRebooker();
    await moveVisitAsUnit({
      rebooker: sameDay, serviceId: 'a', service: SERVICE, newDate: '2026-08-30',
      newWindow: '13:00-14:00', initiatedBy: 'auto_dispatch', options: { requireAtomicUnit: true },
    });
    expect(sameDay.reschedule).toHaveBeenCalledTimes(2);

    db.__script = script({ members: [member('a'), member('b')] });
    const manual = fakeRebooker();
    await moveVisitAsUnit({
      rebooker: manual, serviceId: 'a', service: SERVICE, newDate: '2026-09-02',
      initiatedBy: 'admin', options: { requireAtomicUnit: true },
    });
    expect(manual.reschedule).toHaveBeenCalledTimes(2);
  });

  test('a row that joined the visit after the plan snapshot is detached at retarget, with a warning — by the full target stop, not the date alone', async () => {
    db.__script = script({ members: [member('a'), member('b')], landed: [
      { id: 'a', scheduled_date: '2026-09-02', window_start: '09:00', window_end: '10:00' },
      { id: 'b', scheduled_date: '2026-09-02', window_start: '09:00', window_end: '10:00' },
      { id: 'late', scheduled_date: '2026-08-30', window_start: '09:00', window_end: '10:00' },
    ] });
    const out = await moveVisitAsUnit({ rebooker: fakeRebooker(), serviceId: 'a', service: SERVICE, newDate: '2026-09-02' });
    const detach = db.__calls.find((c) => c.table === 'scheduled_services' && c.op === 'update' && c.values.visit_id === null);
    expect(detach.ops).toEqual(expect.arrayContaining([['whereIn', 'id', ['late']]]));
    expect(out.warnings.some((w) => /joined this stop during the move/.test(w))).toBe(true);
    // same-day WINDOW move: a late row still at the old 09-10 window never landed at the 13-14 target
    db.__calls.length = 0;
    db.__script = script({ visit: VISIT, members: [member('a'), member('b')], landed: [
      { id: 'a', scheduled_date: '2026-08-30', window_start: '13:00', window_end: '14:00' },
      { id: 'b', scheduled_date: '2026-08-30', window_start: '13:00', window_end: '14:00' },
      { id: 'late', scheduled_date: '2026-08-30', window_start: '09:00', window_end: '10:00' },
    ] });
    await moveVisitAsUnit({ rebooker: fakeRebooker(), serviceId: 'a', service: SERVICE, newDate: '2026-08-30', newWindow: '13:00-14:00' });
    const detach2 = db.__calls.find((c) => c.table === 'scheduled_services' && c.op === 'update' && c.values.visit_id === null);
    expect(detach2.ops).toEqual(expect.arrayContaining([['whereIn', 'id', ['late']]]));
  });

  test('a stop key that changes between the peek and the lock is retried', async () => {
    let reads = 0;
    db.__script = script({ members: [member('a'), member('b')] });
    db.__script.service_visits.first = (ops) => {
      if (ops.some((o) => o[0] === 'max')) return { max: 0 };
      reads += 1;
      return reads === 2 ? { ...VISIT, stop_base_key: 'p1:2026-08-31' } : VISIT; // 2nd read (post-lock) differs once
    };
    const out = await moveVisitAsUnit({ rebooker: fakeRebooker(), serviceId: 'a', service: SERVICE, newDate: '2026-09-02' });
    expect(out.visitMove.moved).toEqual(['a', 'b']);
    expect(db.transaction.mock.calls.length).toBeGreaterThanOrEqual(3); // plan retried once + retarget + recompute
  });

  test('three members: each sibling move excludes only rows still participating — a failed sibling is real occupancy again, a moved one is verified at its target', async () => {
    db.__script = script({ members: [member('a'), member('b', { window_start: '10:00', window_end: '11:00' }), member('c', { window_start: '11:00', window_end: '12:00' })], landed: [
      { id: 'a', scheduled_date: '2026-09-02', window_start: '13:00', window_end: '14:00', technician_id: 't1' },
      { id: 'b', scheduled_date: '2026-08-30', window_start: '10:00', window_end: '11:00', technician_id: 't1' },
      { id: 'c', scheduled_date: '2026-09-02', window_start: '15:00', window_end: '16:00', technician_id: 't1' },
    ] });
    const rebooker = fakeRebooker({ b: 'throw' });
    const out = await moveVisitAsUnit({ rebooker, serviceId: 'a', service: SERVICE, newDate: '2026-09-02', newWindow: '13:00-14:00' });
    expect(out.visitMove.failed.map((f) => f.id)).toEqual(['b']);
    const cOpts = rebooker.reschedule.mock.calls[2][5];
    expect(cOpts.excludeServiceIds).toEqual(['a']);
    expect(cOpts.excludeExpect).toEqual([{ id: 'a', visit_id: 'v1', scheduled_date: '2026-09-02', window_start: '13:00', window_end: '14:00', reservation_service_mix: null }]);
  });

  test('auto-dispatch: the opt-out flags ride in every exclusion contract and in each sibling CAS; previousStatus follows the status the rebooker actually matched', async () => {
    db.__script = script({ members: [member('a'), member('b', { status: 'pending' })] });
    const rebooker = { reschedule: jest.fn(async (id) => ({ success: true, previousStatus: id === 'b' ? 'confirmed' : 'confirmed' })), rescheduleSeries: jest.fn() };
    const out = await moveVisitAsUnit({ rebooker, serviceId: 'a', service: SERVICE, newDate: '2026-09-02', initiatedBy: 'auto_dispatch', options: { expect: { auto_dispatch_locked: false } } });
    expect(rebooker.reschedule.mock.calls[0][5].excludeExpect[0]).toMatchObject({ id: 'b', auto_dispatch_locked: false, auto_dispatch_excluded: false });
    expect(rebooker.reschedule.mock.calls[1][5].expect).toMatchObject({ scheduled_date: '2026-08-30', auto_dispatch_locked: false, auto_dispatch_excluded: false });
    // planned 'pending' but the CAS matched 'confirmed' (operator confirmed in between) → not reported as pending
    expect(out.visitMove.members.find((m) => m.id === 'b').previousStatus).toBe('confirmed');
  });

  test('each moved member carries the status its own rebooker move wrote (landedStatus)', async () => {
    db.__script = script({ members: [member('a'), member('b', { status: 'pending' })] });
    const rebooker = { reschedule: jest.fn(async (id) => ({ success: true, previousStatus: id === 'b' ? 'pending' : 'confirmed', landedStatus: id === 'b' ? 'pending' : 'confirmed' })), rescheduleSeries: jest.fn() };
    const out = await moveVisitAsUnit({ rebooker, serviceId: 'a', service: SERVICE, newDate: '2026-09-02', initiatedBy: 'auto_dispatch', options: { keepStatus: true } });
    expect(out.landedStatus).toBe('confirmed');
    expect(out.visitMove.members.find((m) => m.id === 'b')).toMatchObject({ previousStatus: 'pending', landedStatus: 'pending' });
  });

  test('a silently moved sibling keeps a still-pending creation confirmation pending (keepPendingConfirmation) — no supersede, no re-arm write', async () => {
    db.__script = script({ members: [member('a'), member('b')] });
    AppointmentReminders.handleReschedule.mockResolvedValueOnce({ id: 'rem-b', confirmation_sent: false });
    await moveVisitAsUnit({ rebooker: fakeRebooker(), serviceId: 'a', service: SERVICE, newDate: '2026-09-02' });
    expect(AppointmentReminders.handleReschedule.mock.calls[0][2]).toMatchObject({ sendNotification: false, keepPendingConfirmation: true });
    // the only reminder writes are the move-hold stamp/re-stamp/release — never a confirmation supersede/re-arm
    expect(db.__calls.filter((c) => c.table === 'appointment_reminders' && c.op === 'update' && !('move_hold_until' in c.values)).length).toBe(0);
  });

  test('each member\'s own CAS carries its planned visit membership and technician', async () => {
    db.__script = script({ members: [member('a'), member('b', { technician_id: 't2' })] });
    const rebooker = fakeRebooker();
    await moveVisitAsUnit({ rebooker, serviceId: 'a', service: SERVICE, newDate: '2026-09-02' });
    expect(rebooker.reschedule.mock.calls[1][5].expect).toMatchObject({ visit_id: 'v1', technician_id: 't2' });
  });

  test('maxUnitSize: a locked plan larger than the caller\'s remaining change budget is refused before any write', async () => {
    db.__script = script({ members: [member('a'), member('b'), member('c')] });
    const rebooker = fakeRebooker();
    await expect(moveVisitAsUnit({ rebooker, serviceId: 'a', service: SERVICE, newDate: '2026-09-02', options: { maxUnitSize: 2 } }))
      .rejects.toMatchObject({ statusCode: 409, code: 'VISIT_UNIT_OVER_CAP', memberCount: 3 });
    expect(rebooker.reschedule).not.toHaveBeenCalled();
    db.__script = script({ members: [member('a'), member('b'), member('c')] });
    await moveVisitAsUnit({ rebooker, serviceId: 'a', service: SERVICE, newDate: '2026-09-02', options: { maxUnitSize: 3 } });
    expect(rebooker.reschedule).toHaveBeenCalledTimes(3);
  });

  test('expectVisitMembership: a stop whose live services differ from the ones the operator was shown is refused before any write', async () => {
    const shown = { id: 'v1', memberIds: ['a', 'b'], liveCount: 2 };
    const refused = { statusCode: 409, code: 'VISIT_MEMBERSHIP_CHANGED' };
    const rebooker = fakeRebooker();
    const move = (options) => moveVisitAsUnit({ rebooker, serviceId: 'a', service: SERVICE, newDate: '2026-09-02', options });
    // A service joined.
    db.__script = script({ members: [member('a'), member('b'), member('c')] });
    await expect(move({ expectVisitMembership: shown })).rejects.toMatchObject(refused);
    // A service left or closed (the plan read returns live members only).
    db.__script = script({ members: [member('a')] });
    await expect(move({ expectVisitMembership: shown })).rejects.toMatchObject(refused);
    // The row now belongs to a different visit.
    db.__script = script({ members: [member('a'), member('b')] });
    await expect(move({ expectVisitMembership: { ...shown, id: 'v0' } })).rejects.toMatchObject(refused);
    expect(rebooker.reschedule).not.toHaveBeenCalled();
    expect(db.__calls.some((c) => c.table === 'service_visits' && c.op === 'update')).toBe(false);
    // Unchanged: the move runs. A closed member the operator saw is not required to be live.
    db.__script = script({ members: [member('a'), member('b')] });
    await move({ expectVisitMembership: { id: 'v1', memberIds: ['a', 'b', 'closed'], liveCount: 2 } });
    expect(rebooker.reschedule).toHaveBeenCalledTimes(2);
    // Same count, different live set (b closed while c reopened): refused when the live ids were shown.
    db.__script = script({ members: [member('a'), member('c')] });
    await expect(move({ expectVisitMembership: { id: 'v1', memberIds: ['a', 'b', 'c'], liveCount: 2, liveMemberIds: ['a', 'b'] } })).rejects.toMatchObject(refused);
    expect(rebooker.reschedule).toHaveBeenCalledTimes(2);
  });

  test('expectVisitMembership is re-checked inside the primary\'s own move transaction: a service that joined after the plan refuses the move there', async () => {
    const shown = { id: 'v1', memberIds: ['a', 'b'], liveCount: 2 };
    db.__script = script({ members: [member('a'), member('b')] });
    const rebooker = fakeRebooker();
    const callerBeforeMove = jest.fn();
    await moveVisitAsUnit({ rebooker, serviceId: 'a', service: SERVICE, newDate: '2026-09-02', options: { expectVisitMembership: shown, beforeMove: callerBeforeMove } });
    const primaryCall = rebooker.reschedule.mock.calls.find((c) => c[0] === 'a');
    const siblingCall = rebooker.reschedule.mock.calls.find((c) => c[0] === 'b');
    expect(typeof primaryCall[5].beforeMove).toBe('function');
    expect(siblingCall[5].beforeMove).toBe(callerBeforeMove);
    const trxWith = (live) => {
      const trx = jest.fn(() => {
        const chain = {};
        for (const m of ['where', 'whereNotIn', 'whereNull', 'orderBy', 'forUpdate']) chain[m] = () => chain;
        chain.first = async () => ({ id: 'a', visit_id: 'v1', stop_base_key: 'p1:2026-08-30', customer_id: 'c1', property_id: 'p1', scheduled_date: '2026-08-30' });
        chain.select = async () => live;
        chain.then = (res, rej) => Promise.resolve(live).then(res, rej);
        return chain;
      });
      trx.raw = jest.fn(async () => ({ rows: [] }));
      return trx;
    };
    await expect(primaryCall[5].beforeMove(trxWith([member('a'), member('b'), member('c')]))).rejects.toMatchObject({ statusCode: 409, code: 'VISIT_MEMBERSHIP_CHANGED' });
    await expect(primaryCall[5].beforeMove(trxWith([member('a')]))).rejects.toMatchObject({ code: 'VISIT_MEMBERSHIP_CHANGED' });
    callerBeforeMove.mockClear();
    await primaryCall[5].beforeMove(trxWith([member('a'), member('b')]));
    expect(callerBeforeMove).toHaveBeenCalledTimes(1);
    // No expectVisitMembership: the primary's options are untouched.
    db.__script = script({ members: [member('a'), member('b')] });
    const plain = fakeRebooker();
    await moveVisitAsUnit({ rebooker: plain, serviceId: 'a', service: SERVICE, newDate: '2026-09-02' });
    expect(plain.reschedule.mock.calls.find((c) => c[0] === 'a')[5].beforeMove).toBeUndefined();
  });

  test('a technician-only change (same date and window) still runs every member through the rebooker, and keepStatus rides to each one', async () => {
    db.__script = script({ members: [member('a', { status: 'pending' }), member('b')], landed: [member('a', { technician_id: 't9' }), member('b', { technician_id: 't9' })] });
    const rebooker = fakeRebooker();
    await moveVisitAsUnit({ rebooker, serviceId: 'a', service: SERVICE, newDate: '2026-08-30', options: { technicianId: 't9', keepStatus: true, adminWindowRules: false } });
    expect(rebooker.reschedule).toHaveBeenCalledTimes(2);
    for (const call of rebooker.reschedule.mock.calls) {
      expect(call[1]).toBe('2026-08-30');
      expect(call[5]).toMatchObject({ keepStatus: true, adminWindowRules: false });
    }
  });

  test('a reassignment detaches a late joiner still on another technician instead of keeping a split-tech visit', async () => {
    db.__script = script({ members: [member('a'), member('b')], landed: [
      { id: 'a', scheduled_date: '2026-09-02', window_start: '09:00', window_end: '10:00', technician_id: 't2' },
      { id: 'b', scheduled_date: '2026-09-02', window_start: '09:00', window_end: '10:00', technician_id: 't2' },
      { id: 'late', scheduled_date: '2026-09-02', window_start: '09:00', window_end: '10:00', technician_id: 't1' },
    ] });
    await moveVisitAsUnit({ rebooker: fakeRebooker(), serviceId: 'a', service: SERVICE, newDate: '2026-09-02', options: { technicianId: 't2' } });
    const detach = db.__calls.find((c) => c.table === 'scheduled_services' && c.op === 'update' && c.values.visit_id === null);
    expect(detach.ops).toEqual(expect.arrayContaining([['whereIn', 'id', ['late']]]));
  });

  test('date-only move: the landed contract keeps BOTH window bounds (the rebooker preserves them), so the sibling never trips VISIT_PLAN_STALE on a null end', async () => {
    db.__script = script({ members: [member('a'), member('b', { window_start: '10:00', window_end: '11:00' })] });
    const rebooker = fakeRebooker();
    await moveVisitAsUnit({ rebooker, serviceId: 'a', service: SERVICE, newDate: '2026-09-02' });
    expect(rebooker.reschedule.mock.calls[1][5].excludeExpect).toEqual([{ id: 'a', visit_id: 'v1', scheduled_date: '2026-09-02', window_start: '09:00', window_end: '10:00', reservation_service_mix: null }]);
    // start-only landing: the end is the rebooker's derivation — left out of the contract, not asserted null
    db.__script = script({ members: [member('a', { window_start: null, window_end: null }), member('b', { window_start: '10:00', window_end: '11:00' })] });
    const rb2 = fakeRebooker();
    await moveVisitAsUnit({ rebooker: rb2, serviceId: 'a', service: SERVICE, newDate: '2026-09-02', newWindow: { start: '13:00', end: null } });
    expect(rb2.reschedule.mock.calls[1][5].excludeExpect[0]).toEqual({ id: 'a', visit_id: 'v1', scheduled_date: '2026-09-02', window_start: '13:00', reservation_service_mix: null });
  });

  test('date-only move: a sibling whose own window breaks the admin rules cannot ride it onto the new date', async () => {
    db.__script = script({ members: [member('a'), member('b', { window_start: '09:30', window_end: '10:30' })] });
    const rebooker = fakeRebooker();
    await expect(moveVisitAsUnit({ rebooker, serviceId: 'a', service: SERVICE, newDate: '2026-09-02' }))
      .rejects.toMatchObject({ statusCode: 409, code: 'VISIT_MEMBER_WINDOW_INVALID', memberId: 'b' });
    expect(rebooker.reschedule).not.toHaveBeenCalled();
  });
});

describe('moveVisitAsUnit — codex #3609 r13', () => {
  const LANDED_COLS = ['scheduled_date', 'window_start', 'window_end', 'visit_id', 'technician_id'];
  // Like `script` above, plus scheduled_services.first answering the
  // post-error LANDED re-read (its 5-column projection) from `landedRows`.
  const script = ({ members, landed = null, landedRows = {} }) => ({
    service_visits: { first: (ops) => (ops.some((o) => o[0] === 'max') ? { max: 0 } : VISIT) },
    scheduled_services: {
      select: (ops) => (ops.some((o) => o[0] === 'orderBy') ? (landed || members.map((m) => ({ ...m, scheduled_date: '2026-09-02' }))) // retarget read (FOR UPDATE + ORDER BY)
        : ops.some((o) => o[0] === 'forUpdate') ? members
        : ops.some((o) => o[0] === 'whereIn' && o[1] === 'id') ? members.map((m) => ({ ...m, visit_id: 'v1' }))
          : (landed || members.map((m) => ({ ...m, scheduled_date: '2026-09-02' })))),
      first: (ops, cols) => {
        if (cols.length !== LANDED_COLS.length || !LANDED_COLS.every((c) => cols.includes(c))) return null;
        const w = ops.find((o) => o[0] === 'where' && o[1] && o[1].id);
        return (w && landedRows[w[1].id]) || null;
      },
    },
  });
  const landedRow = (over = {}) => ({ scheduled_date: '2026-09-02', window_start: '09:00:00', window_end: '10:00:00', visit_id: 'v1', technician_id: 't1', ...over });

  test('memberGuard runs under the plan lock on EVERY locked member and its refusal aborts before any write (P1)', async () => {
    db.__script = script({ members: [member('a'), member('b')] });
    const rebooker = fakeRebooker();
    const memberGuard = jest.fn(async () => { throw Object.assign(new Error('grouped service b is frozen'), { statusCode: 409, code: 'VISIT_MEMBER_AUTO_DISPATCH_GUARD', memberId: 'b' }); });
    await expect(moveVisitAsUnit({ rebooker, serviceId: 'a', service: SERVICE, newDate: '2026-09-02', initiatedBy: 'auto_dispatch', options: { memberGuard } }))
      .rejects.toMatchObject({ statusCode: 409, code: 'VISIT_MEMBER_AUTO_DISPATCH_GUARD', memberId: 'b' });
    expect(memberGuard).toHaveBeenCalledTimes(1);
    const arg = memberGuard.mock.calls[0][0];
    expect(arg.members.map((m) => m.id)).toEqual(['a', 'b']);
    expect(arg).toMatchObject({ primaryId: 'a', visitId: 'v1' });
    expect(typeof arg.trx).toBe('function');
    // the guard sees each member's DERIVED target (codex r16 P1)
    expect(arg.targets.map((t) => [t.id, t.isPrimary, t.startHHMM])).toEqual([['a', true, '09:00'], ['b', false, '09:00']]);
    // the guard ran AFTER the stop lock (a trx.raw lock call precedes it) and nothing was written
    expect(db.__rawCalls.length).toBeGreaterThan(0);
    expect(rebooker.reschedule).not.toHaveBeenCalled();
    expect(db.__calls.some((c) => c.op === 'update')).toBe(false);
    // a passing guard lets the move proceed; siblings never receive the guard in their own single-row options
    jest.clearAllMocks(); db.__calls.length = 0;
    db.__script = script({ members: [member('a'), member('b')] });
    const ok = jest.fn(async () => {});
    const out = await moveVisitAsUnit({ rebooker, serviceId: 'a', service: SERVICE, newDate: '2026-09-02', initiatedBy: 'auto_dispatch', options: { memberGuard: ok } });
    expect(out.visitMove.moved).toEqual(['a', 'b']);
    expect(rebooker.reschedule.mock.calls[1][5].memberGuard).toBeUndefined();
  });

  test('primary rejected AFTER its move committed (post-commit rebooker work) is reconciled as MOVED: siblings follow, parent retargets, warning carried (P1)', async () => {
    db.__script = script({ members: [member('a'), member('b')], landedRows: { a: landedRow() }, landed: [
      { id: 'a', scheduled_date: '2026-09-02', window_start: '09:00', window_end: '10:00' },
      { id: 'b', scheduled_date: '2026-09-02', window_start: '09:00', window_end: '10:00' },
    ] });
    const rebooker = fakeRebooker({ a: 'throw' });
    const out = await moveVisitAsUnit({ rebooker, serviceId: 'a', service: SERVICE, newDate: '2026-09-02' });
    expect(out.success).toBe(true);
    expect(out.visitMove).toMatchObject({ moved: ['a', 'b'], failed: [] });
    expect(out.warnings.some((w) => /the tapped service moved but its post-move cleanup failed: member a boom/.test(w))).toBe(true);
    expect(rebooker.reschedule).toHaveBeenCalledTimes(2);
    // the sibling's contract carries the primary at its LANDED target
    expect(rebooker.reschedule.mock.calls[1][5].excludeExpect[0]).toMatchObject({ id: 'a', scheduled_date: '2026-09-02' });
    const patch = db.__calls.find((c) => c.table === 'service_visits' && c.op === 'update' && c.values.scheduled_date);
    expect(patch.values).toMatchObject({ scheduled_date: '2026-09-02', stop_base_key: 'p1:2026-09-02' });
  });

  test('a primary that rejected and did NOT land still rethrows with nothing changed; a landed sibling that rejected counts as moved and gets its reminder sync', async () => {
    db.__script = script({ members: [member('a'), member('b')], landedRows: { a: landedRow({ scheduled_date: '2026-08-30' }) } });
    await expect(moveVisitAsUnit({ rebooker: fakeRebooker({ a: 'throw' }), serviceId: 'a', service: SERVICE, newDate: '2026-09-02' })).rejects.toThrow('member a boom');
    expect(db.__calls.some((c) => c.table === 'service_visits' && c.op === 'update')).toBe(false);
    // landed on the date but a different window / another visit ⇒ not landed either
    for (const over of [{ window_start: '11:00:00' }, { visit_id: 'v2' }]) {
      db.__calls.length = 0;
      db.__script = script({ members: [member('a'), member('b')], landedRows: { a: landedRow(over) } });
      await expect(moveVisitAsUnit({ rebooker: fakeRebooker({ a: 'throw' }), serviceId: 'a', service: SERVICE, newDate: '2026-09-02', options: { technicianId: 't1' } })).rejects.toThrow('member a boom');
    }
    // the technician is NOT part of the landing (local codex audit P1): on a
    // tech-changing move (t1 → t9) a correctly landed primary still carries
    // t1 — alignMember re-points it AFTER the verdict; treating it as "not
    // moved" would rethrow and skip the siblings, the retarget and the seams
    jest.clearAllMocks(); db.__calls.length = 0;
    db.__script = script({ members: [member('a'), member('b')], landedRows: { a: landedRow({ technician_id: 't1' }) }, landed: [
      { id: 'a', scheduled_date: '2026-09-02', window_start: '09:00', window_end: '10:00', technician_id: 't9' },
      { id: 'b', scheduled_date: '2026-09-02', window_start: '09:00', window_end: '10:00', technician_id: 't9' },
    ] });
    const techMove = await moveVisitAsUnit({ rebooker: fakeRebooker({ a: 'throw' }), serviceId: 'a', service: SERVICE, newDate: '2026-09-02', options: { technicianId: 't9' } });
    expect(techMove.visitMove).toMatchObject({ moved: ['a', 'b'], failed: [] });
    expect(assignDispatchJob).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'a', technicianId: 't9', expectTechnicianId: 't1' }));
    expect(assignDispatchJob).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'b', technicianId: 't9', expectTechnicianId: 't1' }));
    expect(db.__calls.some((c) => c.table === 'service_visits' && c.op === 'update')).toBe(true);
    // a row reassigned concurrently (t2) is still LANDED by placement; alignMember's own fence is the technician verdict
    jest.clearAllMocks(); db.__calls.length = 0;
    db.__script = script({ members: [member('a'), member('b')], landedRows: { a: landedRow({ technician_id: 't2' }) }, landed: [
      { id: 'a', scheduled_date: '2026-09-02', window_start: '09:00', window_end: '10:00', technician_id: 't2' }, // a: newer operator reassignment wins
      { id: 'b', scheduled_date: '2026-09-02', window_start: '09:00', window_end: '10:00', technician_id: 't9' },
    ] });
    assignDispatchJob.mockRejectedValueOnce(Object.assign(new Error('Job was reassigned concurrently - the planned technician is stale'), { statusCode: 409, code: 'ASSIGNMENT_STALE' }));
    const staleTech = await moveVisitAsUnit({ rebooker: fakeRebooker({ a: 'throw' }), serviceId: 'a', service: SERVICE, newDate: '2026-09-02', options: { technicianId: 't9' } });
    expect(staleTech.visitMove.moved).toEqual(['a', 'b']);
    expect(staleTech.visitMove.failed).toEqual([expect.objectContaining({ id: 'a', code: 'ASSIGNMENT_STALE' })]);
    // The holder's fallback "visit moved" card (its rebooker card was suppressed for the pair): the plan
    // asserts date + start; a member with no end time gets an object-shaped window whose end the rebooker
    // derives, so the snapshot must NOT assert `windowEnd: null` or the write-time check drops the card.
    const { notifyVisitRescheduled } = require('../services/tech-visit-notifications');
    expect(notifyVisitRescheduled).toHaveBeenCalledTimes(1);
    const fallback = notifyVisitRescheduled.mock.calls[0][0];
    expect(fallback).toMatchObject({ visitId: 'a', technicianId: 't1', snapshot: { date: '2026-09-02', windowStart: '09:00', windowEnd: '10:00' } });
    jest.clearAllMocks(); db.__calls.length = 0;
    db.__script = script({ members: [member('a', { window_end: null }), member('b')], landed: [
      { id: 'a', scheduled_date: '2026-09-02', window_start: '09:00', window_end: '10:00', technician_id: 't1' },
      { id: 'b', scheduled_date: '2026-09-02', window_start: '09:00', window_end: '10:00', technician_id: 't9' },
    ] });
    assignDispatchJob.mockRejectedValueOnce(Object.assign(new Error('stale'), { statusCode: 409, code: 'ASSIGNMENT_STALE' }));
    const openEndedOut = await moveVisitAsUnit({ rebooker: fakeRebooker(), serviceId: 'a', service: SERVICE, newDate: '2026-09-02', initiatedBy: 'admin', options: { technicianId: 't9' } });
    expect(openEndedOut.visitMove.failed).toEqual([expect.objectContaining({ id: 'a', code: 'ASSIGNMENT_STALE', movedButUnassigned: true })]);
    expect(notifyVisitRescheduled).toHaveBeenCalledTimes(1);
    const openEnded = notifyVisitRescheduled.mock.calls[0][0];
    expect(openEnded.actorId).toBe('admin');
    expect(openEnded.snapshot).toEqual({ date: '2026-09-02', windowStart: '09:00' });
    expect('windowEnd' in openEnded.snapshot).toBe(false);
    // The fallback card goes to the holder the COMMITTED move reported (a raced reassignment landed t3 —
    // the very reason the stale fence failed), never to the plan's expected technician.
    jest.clearAllMocks(); db.__calls.length = 0;
    db.__script = script({ members: [member('a'), member('b')], landed: [
      { id: 'a', scheduled_date: '2026-09-02', window_start: '09:00', window_end: '10:00', technician_id: 't3' },
      { id: 'b', scheduled_date: '2026-09-02', window_start: '09:00', window_end: '10:00', technician_id: 't9' },
    ] });
    assignDispatchJob.mockRejectedValueOnce(Object.assign(new Error('stale'), { statusCode: 409, code: 'ASSIGNMENT_STALE' }));
    await moveVisitAsUnit({ rebooker: fakeRebooker({ a: { technicianId: 't3' } }), serviceId: 'a', service: SERVICE, newDate: '2026-09-02', initiatedBy: 'admin', options: { technicianId: 't9' } });
    expect(notifyVisitRescheduled).toHaveBeenCalledTimes(1);
    expect(notifyVisitRescheduled.mock.calls[0][0]).toMatchObject({ visitId: 'a', technicianId: 't3' });
    jest.clearAllMocks(); db.__calls.length = 0;
    db.__script = script({ members: [member('a'), member('b')], landedRows: { b: landedRow() } });
    const out = await moveVisitAsUnit({ rebooker: fakeRebooker({ b: 'throw' }), serviceId: 'a', service: SERVICE, newDate: '2026-09-02' });
    expect(out.visitMove).toMatchObject({ moved: ['a', 'b'], failed: [] });
    expect(out.warnings.some((w) => /service b moved but its post-move cleanup failed/.test(w))).toBe(true);
    expect(AppointmentReminders.handleReschedule).toHaveBeenCalledWith('b', '2026-09-02T09:00', expect.objectContaining({ sendNotification: false }));
  });
});

describe('moveVisitAsUnit — codex #3609 r15 + local audit', () => {
  const script = ({ members, landed = null, first = null }) => ({
    service_visits: { first: (ops) => (ops.some((o) => o[0] === 'max') ? { max: 0 } : VISIT) },
    scheduled_services: {
      select: (ops) => (ops.some((o) => o[0] === 'orderBy') ? (landed || members.map((m) => ({ ...m, scheduled_date: '2026-09-02' }))) // retarget read (FOR UPDATE + ORDER BY)
        : ops.some((o) => o[0] === 'forUpdate') ? members
        : ops.some((o) => o[0] === 'whereIn' && o[1] === 'id') ? members.map((m) => ({ ...m, visit_id: 'v1' }))
          : (landed || members.map((m) => ({ ...m, scheduled_date: '2026-09-02' })))),
      first: (ops, cols) => (first ? first(ops, cols) : null),
    },
  });

  test('a technician change re-points every moved SIBLING through assignDispatchJob (own trx), never through the rebooker (P1)', async () => {
    const onT9 = (ids) => ids.map((id) => ({ id, scheduled_date: '2026-09-02', window_start: '09:00', window_end: '10:00', technician_id: 't9' }));
    db.__script = script({ members: [member('a'), member('b'), member('c', { technician_id: 't9' })], landed: onT9(['a', 'b', 'c']) });
    const rebooker = fakeRebooker();
    const out = await moveVisitAsUnit({ rebooker, serviceId: 'a', service: SERVICE, newDate: '2026-09-02', initiatedBy: 'admin', options: { technicianId: 't9' } });
    expect(out.visitMove).toMatchObject({ moved: ['a', 'b', 'c'], failed: [] });
    // NO member's rebooker call carries technicianId — the primary too goes through the canonical writer (local audit)
    for (const c of rebooker.reschedule.mock.calls) expect(c[5]).not.toHaveProperty('technicianId');
    // a and b (t1 → t9) re-pointed through the canonical writer on a transaction; c already on t9 is not touched
    expect(assignDispatchJob).toHaveBeenCalledTimes(2);
    expect(assignDispatchJob).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'a', technicianId: 't9', expectTechnicianId: 't1', skipVisitSeam: true }));
    // skipVisitSeam: the per-row seam must not run on a half-reassigned visit (codex r16 P1) — step 4 runs it per member after the retarget
    // expectTechnicianId = the PLANNED pre-move tech (local audit): a newer operator reassignment is never overwritten
    // noticeActorId: the card names the rebooker's initiatedBy when no staff row was given; actorId (resolved_by) stays null
    expect(assignDispatchJob).toHaveBeenCalledWith({ jobId: 'b', technicianId: 't9', actorId: null, emit: true, trx: expect.any(Function), skipVisitSeam: true, expectTechnicianId: 't1', noticeActorId: 'admin',
      // the member's slot before the unit move: the cards' previous day (Codex #5786 P2)
      noticePrevious: { date: '2026-08-30', windowStart: '09:00', windowEnd: '10:00' } });
    // every moved member reports the slot it landed on, for the caller's fenced bookkeeping
    expect(out.visitMove.members.find((m) => m.id === 'b').landed).toEqual({ scheduled_date: '2026-09-02', window_start: '09:00', window_end: '10:00' });
    // and the parent still carries the technician
    const patch = db.__calls.find((c) => c.table === 'service_visits' && c.op === 'update' && c.values.scheduled_date);
    expect(patch.values).toMatchObject({ technician_id: 't9' });
  });

  test('a sibling whose reassignment fails is reported as a failed member (moved, wrong tech) — deadlocks retry', async () => {
    const onT9 = (ids) => ids.map((id) => ({ id, scheduled_date: '2026-09-02', window_start: '09:00', window_end: '10:00', technician_id: 't9' }));
    db.__script = script({ members: [member('a'), member('b')], landed: onT9(['a', 'b']) });
    assignDispatchJob
      .mockResolvedValueOnce({ changed: true })                                               // a
      .mockRejectedValueOnce(Object.assign(new Error('deadlock'), { code: '40P01' }))         // b
      .mockResolvedValueOnce({ changed: true });                                              // b retry
    let out = await moveVisitAsUnit({ rebooker: fakeRebooker(), serviceId: 'a', service: SERVICE, newDate: '2026-09-02', options: { technicianId: 't9' } });
    expect(out.visitMove.failed).toEqual([]);
    expect(assignDispatchJob).toHaveBeenCalledTimes(3); // a, then b (deadlock) + b retry
    jest.clearAllMocks(); db.__calls.length = 0;
    // b stays on t1 (its re-point failed): the retarget sees it diverged from the planned tech too
    db.__script = script({ members: [member('a'), member('b')], landed: [...onT9(['a']), { id: 'b', scheduled_date: '2026-09-02', window_start: '09:00', window_end: '10:00', technician_id: 't1' }] });
    assignDispatchJob
      .mockResolvedValueOnce({ changed: true })                                                             // a
      .mockRejectedValueOnce(Object.assign(new Error('Technician is inactive'), { statusCode: 400 }));    // b
    out = await moveVisitAsUnit({ rebooker: fakeRebooker(), serviceId: 'a', service: SERVICE, newDate: '2026-09-02', options: { technicianId: 't9' } });
    expect(out.visitMove.moved).toEqual(['a', 'b']);
    expect(out.visitMove.failed).toEqual([{ id: 'b', reason: 'moved but its technician reassignment failed: Technician is inactive', code: 'ASSIGNMENT_FAILED', movedButUnassigned: true }]);
    expect(out.warnings.some((w) => /did not move with this stop/.test(w))).toBe(true);
    // a concurrent operator reassignment (ASSIGNMENT_STALE) is a failed member, not retried, not overwritten
    jest.clearAllMocks(); db.__calls.length = 0;
    db.__script = script({ members: [member('a'), member('b')], landed: [...onT9(['a']), { id: 'b', scheduled_date: '2026-09-02', window_start: '09:00', window_end: '10:00', technician_id: 't1' }] });
    assignDispatchJob
      .mockResolvedValueOnce({ changed: true })                                                                                                   // a
      .mockRejectedValueOnce(Object.assign(new Error('Job was reassigned concurrently - the planned technician is stale'), { statusCode: 409, code: 'ASSIGNMENT_STALE' })); // b
    out = await moveVisitAsUnit({ rebooker: fakeRebooker(), serviceId: 'a', service: SERVICE, newDate: '2026-09-02', options: { technicianId: 't9' } });
    expect(assignDispatchJob).toHaveBeenCalledTimes(2);
    expect(out.visitMove.failed).toEqual([expect.objectContaining({ id: 'b', code: 'ASSIGNMENT_STALE' })]);
    // unassign (null) goes through the same writer
    jest.clearAllMocks(); db.__script = script({ members: [member('a'), member('b')] });
    await moveVisitAsUnit({ rebooker: fakeRebooker(), serviceId: 'a', service: SERVICE, newDate: '2026-09-02', options: { technicianId: null } });
    expect(assignDispatchJob).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'a', technicianId: null }));
    expect(assignDispatchJob).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'b', technicianId: null }));
  });

  test('an all-at-target no-op still honours the caller\'s expect fence on the live row (local audit)', async () => {
    const atTarget = { visit: { ...VISIT, scheduled_date: '2026-09-02', stop_base_key: 'p1:2026-09-02' }, members: [member('a', { scheduled_date: '2026-09-02' }), member('b', { scheduled_date: '2026-09-02' })] };
    const live = { id: 'a', scheduled_date: '2026-09-02', window_start: '09:00:00', window_end: '10:00:00', status: 'confirmed', technician_id: 't1', auto_dispatch_locked: false, auto_dispatch_excluded: false };
    // auto-dispatch pinned the ORIGINAL date: a staff move that landed first is stale, not this run's success
    db.__script = { ...script({ ...atTarget, first: () => live }), service_visits: { first: (ops) => (ops.some((o) => o[0] === 'max') ? { max: 0 } : atTarget.visit) } };
    const rebooker = fakeRebooker();
    await expect(moveVisitAsUnit({ rebooker, serviceId: 'a', service: SERVICE, newDate: '2026-09-02', initiatedBy: 'auto_dispatch', options: { seriesPolicy: 'single', expect: { scheduled_date: '2026-08-30', status: 'pending', auto_dispatch_locked: false } } }))
      .rejects.toMatchObject({ statusCode: 409, code: 'VISIT_EXPECT_STALE' });
    expect(rebooker.reschedule).not.toHaveBeenCalled();
    // a fence the live row satisfies keeps the no-op
    const out = await moveVisitAsUnit({ rebooker, serviceId: 'a', service: SERVICE, newDate: '2026-09-02', options: { seriesPolicy: 'single', expect: { scheduled_date: '2026-09-02', window_start: '09:00', status: 'confirmed', technician_id: 't1' } } });
    expect(out.visitMove).toMatchObject({ moved: [], alreadyAtTarget: true });
    // unreadable row fails closed; no expect ⇒ no read
    db.__script = { ...script({ ...atTarget, first: () => null }), service_visits: { first: (ops) => (ops.some((o) => o[0] === 'max') ? { max: 0 } : atTarget.visit) } };
    await expect(moveVisitAsUnit({ rebooker, serviceId: 'a', service: SERVICE, newDate: '2026-09-02', options: { seriesPolicy: 'single', expect: { status: 'confirmed' } } })).rejects.toMatchObject({ code: 'VISIT_EXPECT_STALE' });
    expect((await moveVisitAsUnit({ rebooker, serviceId: 'a', service: SERVICE, newDate: '2026-09-02', options: { seriesPolicy: 'single' } })).visitMove.alreadyAtTarget).toBe(true);
  });

  test('expectMatchesRow: day / HH:MM / null-safe string semantics, unknown key fails closed', () => {
    const row = { scheduled_date: new Date('2026-09-02T04:00:00Z'), window_start: '09:00:00', window_end: null, status: 'confirmed', technician_id: null, auto_dispatch_locked: false };
    expect(expectMatchesRow(row, { scheduled_date: '2026-09-02', window_start: '09:00', window_end: null, status: 'confirmed', technician_id: null, auto_dispatch_locked: false })).toBe(true);
    expect(expectMatchesRow(row, { window_start: '10:00' })).toBe(false);
    expect(expectMatchesRow(row, { technician_id: 't1' })).toBe(false);
    expect(expectMatchesRow(row, { auto_dispatch_locked: true })).toBe(false);
    expect(expectMatchesRow(row, { estimated_duration_minutes: 60 })).toBe(false);
    expect(expectMatchesRow({ ...row, reservation_service_mix: { version: 1, services: ['pest', 'lawn'] } }, {
      reservation_service_mix: { services: ['pest', 'lawn'], version: 1 },
    })).toBe(true);
    expect(expectMatchesRow({ ...row, reservation_service_mix: { version: 2 } }, {
      reservation_service_mix: { version: 1 },
    })).toBe(false);
    expect(expectMatchesRow(null, {})).toBe(false);
    expect(expectMatchesRow(row, {})).toBe(true);
  });
});

describe('moveVisitAsUnit — frozen visits are refused (local codex audit P0)', () => {
  const FROZEN = { ...VISIT, summary_token_issued_at: '2026-08-28T12:00:00Z' }; // issued link ⇒ membership frozen
  const script = ({ visit = VISIT, members, landed = null }) => ({
    service_visits: { first: (ops) => (ops.some((o) => o[0] === 'max') ? { max: 0 } : visit) },
    scheduled_services: {
      select: (ops) => (ops.some((o) => o[0] === 'orderBy') ? (landed || members.map((m) => ({ ...m, scheduled_date: '2026-09-02' }))) // retarget read (FOR UPDATE + ORDER BY)
        : ops.some((o) => o[0] === 'forUpdate') ? members
          : ops.some((o) => o[0] === 'whereIn' && o[1] === 'id') ? members.map((m) => ({ ...m, visit_id: 'v1' }))
            : (landed || members.map((m) => ({ ...m, scheduled_date: '2026-09-02' })))),
    },
  });

  test('a visit with an issued link / packet / records / payment is refused before any write — members move in separate transactions, so no compensation could make it atomic', async () => {
    for (const [visit, expectReason] of [[FROZEN, 'link_issued'], [{ ...VISIT, payment_intent_id: 'pi_1' }, 'payment_attempted']]) {
      jest.clearAllMocks(); db.__calls.length = 0;
      db.__script = script({ visit, members: [member('a'), member('b')] });
      const rebooker = fakeRebooker();
      await expect(moveVisitAsUnit({ rebooker, serviceId: 'a', service: SERVICE, newDate: '2026-09-02', initiatedBy: 'admin' }))
        .rejects.toMatchObject({ statusCode: 409, code: 'VISIT_FROZEN_MOVE_UNSUPPORTED', reason: expectReason, isOperational: true });
      expect(rebooker.reschedule).not.toHaveBeenCalled();
      expect(db.__calls.some((c) => c.op === 'update' || c.op === 'insert')).toBe(false);
    }
    // a CLOSING visit is REFUSED (local gate P0 r36): its packet/link/records still describe this stop and the seam ignores non-open visits
    db.__script = script({ visit: { ...VISIT, status: 'closing' }, members: [] });
    await expect(moveVisitAsUnit({ rebooker: fakeRebooker(), serviceId: 'a', service: SERVICE, newDate: '2026-09-02' }))
      .rejects.toMatchObject({ statusCode: 409, code: 'VISIT_FROZEN_MOVE_UNSUPPORTED', reason: 'visit_not_open', visitStatus: 'closing' });
    // a DISSOLVED visit (rows freed; a stale pointer) is the mover's own null path — the single row moves alone
    db.__script = script({ visit: { ...VISIT, status: 'dissolved' }, members: [] });
    expect(await moveVisitAsUnit({ rebooker: fakeRebooker(), serviceId: 'a', service: SERVICE, newDate: '2026-09-02' })).toBe(null);
    // ONE live member beside a terminal one on a FROZEN visit is refused too (local audit r30): the single-row path's seam
    // would preserve the frozen membership — the child at the new stop, the visit and its artifacts at the old one
    db.__script = script({ visit: FROZEN, members: [member('a')] });
    await expect(moveVisitAsUnit({ rebooker: fakeRebooker(), serviceId: 'a', service: SERVICE, newDate: '2026-09-02', initiatedBy: 'admin' }))
      .rejects.toMatchObject({ statusCode: 409, code: 'VISIT_FROZEN_MOVE_UNSUPPORTED', reason: 'link_issued' });
    // an UNFROZEN lone member still declines to the rebooker's single-row path
    db.__script = script({ members: [member('a')] });
    expect(await moveVisitAsUnit({ rebooker: fakeRebooker(), serviceId: 'a', service: SERVICE, newDate: '2026-09-02', initiatedBy: 'admin' })).toBe(null);
  });

  test('destination technician occupancy (local codex audit r24): every derived member window is checked against the NEW tech under the plan lock — hard clash refuses the unit (SLOT_TAKEN), advisory warns; alignMember repeats it under the tech slot-reserve lock', async () => {
    const clashQueries = [];
    const onTech = (tech) => [
      { id: 'a', scheduled_date: '2026-09-02', window_start: '09:00', window_end: '10:00', technician_id: tech },
      { id: 'b', scheduled_date: '2026-09-02', window_start: '10:00', window_end: '11:00', technician_id: tech },
    ];
    const withClash = (hit, landed = null) => ({
      ...script({ members: [member('a'), member('b', { window_start: '10:00', window_end: '11:00' })], landed }),
      scheduled_services: {
        ...script({ members: [member('a'), member('b', { window_start: '10:00', window_end: '11:00' })], landed }).scheduled_services,
        first: (ops, cols) => {
          if (ops.some((o) => o[0] === 'whereRaw')) { clashQueries.push(ops); return hit ? { id: 'other-job' } : null; }
          return null;
        },
      },
    });
    // hard (dispatch / auto-dispatch): refused before any write, the callers' SLOT_TAKEN handling unchanged
    db.__script = withClash(true);
    const rebooker = fakeRebooker();
    await expect(moveVisitAsUnit({ rebooker, serviceId: 'a', service: SERVICE, newDate: '2026-09-02', newWindow: '13:00-14:00', initiatedBy: 'admin', options: { technicianId: 't9' } }))
      .rejects.toMatchObject({ statusCode: 409, code: 'SLOT_TAKEN', memberId: 'a', conflictId: 'other-job', isOperational: true });
    expect(rebooker.reschedule).not.toHaveBeenCalled();
    expect(assignDispatchJob).not.toHaveBeenCalled();
    expect(db.__calls.some((c) => c.op === 'update' || c.op === 'insert')).toBe(false);
    // the probe targets the DESTINATION tech on the new date, the derived window, excluding the visit's own members
    expect(clashQueries[0]).toEqual(expect.arrayContaining([['where', 'scheduled_date', '2026-09-02'], ['where', 'technician_id', 't9'], ['whereNotIn', 'id', ['a', 'b']]]));
    expect(clashQueries[0].find((o) => o[0] === 'whereRaw')[2]).toEqual(['14:00', '13:00']);
    // no destination tech (a plain move / an unassign) ⇒ no probe at all
    clashQueries.length = 0; jest.clearAllMocks(); db.__calls.length = 0;
    db.__script = withClash(true);
    await moveVisitAsUnit({ rebooker: fakeRebooker(), serviceId: 'a', service: SERVICE, newDate: '2026-09-02', options: { technicianId: null } });
    expect(clashQueries).toEqual([]);
    // advisory (rain-out staff surface): warned, moved, and re-pointed — the plan probe, then per-member probes under the tech-day lock
    clashQueries.length = 0; jest.clearAllMocks(); db.__calls.length = 0; db.__rawCalls.length = 0;
    db.__script = withClash(true, onTech('t9'));
    const out = await moveVisitAsUnit({ rebooker: fakeRebooker(), serviceId: 'a', service: SERVICE, newDate: '2026-09-02', options: { technicianId: 't9', overlapAdvisory: true } });
    expect(out.visitMove).toMatchObject({ moved: ['a', 'b'], failed: [] });
    expect(out.warnings.filter((w) => /overlaps another job on the destination technician/.test(w)).length).toBe(2);
    expect(assignDispatchJob).toHaveBeenCalledTimes(2);
    expect(db.__rawCalls.filter((c) => c[1] && c[1][0] === 'slot-reserve' && c[1][1] === 't9:2026-09-02').length).toBe(2);
    // a FAILED member is real occupancy again: it is NOT hidden from the assignment probes (local audit r32)
    clashQueries.length = 0; jest.clearAllMocks(); db.__calls.length = 0;
    const three = [member('a'), member('b', { window_start: '10:00', window_end: '11:00' }), member('c', { window_start: '11:00', window_end: '12:00' })];
    db.__script = { ...script({ members: three, landed: [...onTech('t9'), { id: 'c', scheduled_date: '2026-09-02', window_start: '11:00', window_end: '12:00', technician_id: 't9' }] }) };
    const { findConflictingVisits } = require('../services/scheduling/occupancy');
    await moveVisitAsUnit({ rebooker: fakeRebooker({ b: 'throw' }), serviceId: 'a', service: SERVICE, newDate: '2026-09-02', options: { technicianId: 't9' } });
    const excl = findConflictingVisits.mock.calls.filter((c) => c[0] && c[0].excludeServiceIds).map((c) => c[0].excludeServiceIds);
    expect(excl[0]).toEqual(['a', 'b', 'c']);   // a aligned first: every participant still represented
    expect(excl[excl.length - 1]).toEqual(['a', 'c']); // c aligned after b FAILED ⇒ b is real occupancy again, not hidden
    // hard clash discovered only at assignment (a booking landed after the plan): the row stays moved on its old tech, reported — never double-booked
    clashQueries.length = 0; jest.clearAllMocks(); db.__calls.length = 0;
    let probes = 0;
    db.__script = withClash(false, onTech('t1')); // both stayed on t1: their re-point was refused
    db.__script.scheduled_services.first = (ops) => (ops.some((o) => o[0] === 'whereRaw') ? (probes += 1, probes > 2 ? { id: 'late-job' } : null) : null); // plan probes a,b clean; alignment probes clash
    const late = await moveVisitAsUnit({ rebooker: fakeRebooker(), serviceId: 'a', service: SERVICE, newDate: '2026-09-02', options: { technicianId: 't9' } });
    expect(late.visitMove.moved).toEqual(['a', 'b']);
    expect(late.visitMove.failed).toEqual([
      expect.objectContaining({ id: 'a', code: 'SLOT_TAKEN' }), expect.objectContaining({ id: 'b', code: 'SLOT_TAKEN' }),
    ]);
    expect(assignDispatchJob).not.toHaveBeenCalled();
  });

  test('an unchanged member keeps its advisory destination warning while changed members use their assignment writer', async () => {
    const members = [
      member('a'),
      member('b', { technician_id: 't9', window_start: '10:00', window_end: '11:00' }),
    ];
    const base = script({ members, landed: [
      { id: 'a', scheduled_date: '2026-08-30', window_start: '09:00', window_end: '10:00', technician_id: 't9' },
      { id: 'b', scheduled_date: '2026-08-30', window_start: '10:00', window_end: '11:00', technician_id: 't9' },
    ] });
    db.__script = {
      ...base,
      scheduled_services: {
        ...base.scheduled_services,
        first: (ops) => (ops.some((op) => op[0] === 'whereRaw') ? { id: 'outside-job' } : null),
      },
    };

    const rebooker = fakeRebooker();
    const out = await moveVisitAsUnit({
      rebooker, serviceId: 'a', service: SERVICE, newDate: '2026-08-30',
      initiatedBy: 'admin', options: { technicianId: 't9', overlapAdvisory: true },
    });

    expect(out.visitMove).toMatchObject({ moved: ['a'], unchanged: ['b'], failed: [] });
    expect(rebooker.reschedule).toHaveBeenCalledTimes(1);
    expect(assignDispatchJob).toHaveBeenCalledTimes(1);
    expect(out.warnings.filter((warning) => /service a overlaps/.test(warning))).toHaveLength(1);
    expect(out.warnings.filter((warning) => /service b overlaps/.test(warning))).toHaveLength(1);
  });

  test('an all-unchanged manual no-op still reports each advisory destination clash once', async () => {
    const members = [
      member('a', { technician_id: 't9' }),
      member('b', { technician_id: 't9', window_start: '10:00', window_end: '11:00' }),
    ];
    const base = script({ members, landed: members });
    db.__script = {
      ...base,
      scheduled_services: {
        ...base.scheduled_services,
        first: (ops) => (ops.some((op) => op[0] === 'whereRaw') ? { id: 'outside-job' } : null),
      },
    };
    const rebooker = fakeRebooker();

    const out = await moveVisitAsUnit({
      rebooker, serviceId: 'a', service: SERVICE, newDate: '2026-08-30',
      initiatedBy: 'admin', options: { technicianId: 't9', overlapAdvisory: true, seriesPolicy: 'single' },
    });

    expect(out.visitMove).toMatchObject({ moved: [], unchanged: ['a', 'b'], alreadyAtTarget: true });
    expect(rebooker.reschedule).not.toHaveBeenCalled();
    expect(assignDispatchJob).not.toHaveBeenCalled();
    expect(out.warnings).toEqual([
      'service a overlaps another job on the destination technician\'s route (outside-job)',
      'service b overlaps another job on the destination technician\'s route (outside-job)',
    ]);
  });

  test('a durable move_hold_until is stamped on every member reminder row before the first write, released only on full success, kept on a partial, and its failure ABORTS the move (owner ruling; codex r28/r29)', async () => {
    const reminders = { select: () => [{ id: 'rem-a', scheduled_service_id: 'a' }, { id: 'rem-b', scheduled_service_id: 'b' }] };
    // PARTIAL: the hold is stamped and NOT released
    db.__script = { ...script({ members: [member('a'), member('b')], landed: [
      { id: 'a', scheduled_date: '2026-09-02', window_start: '09:00', window_end: '10:00', technician_id: 't1' },
      { id: 'b', scheduled_date: '2026-08-30', window_start: '09:00', window_end: '10:00', technician_id: 't1' },
    ] }), appointment_reminders: reminders };
    const out = await moveVisitAsUnit({ rebooker: fakeRebooker({ b: 'throw' }), serviceId: 'a', service: SERVICE, newDate: '2026-09-02' });
    expect(out.visitMove.failed).toEqual([expect.objectContaining({ id: 'b' })]);
    let rem = db.__calls.filter((c) => c.table === 'appointment_reminders' && c.op === 'update');
    expect(rem.length).toBe(2); // claim + the moved member a's re-stamp (a late row inherits the quiet) — NO release on a partial
    expect(rem[0].values.move_hold_until instanceof Date).toBe(true);
    expect(rem[0].values.move_hold_until.getTime()).toBeGreaterThan(Date.now() + 23 * 3600 * 1000); // self-expiring ~24h stamp
    expect(rem[0].ops).toEqual(expect.arrayContaining([['whereIn', 'id', ['rem-a', 'rem-b']]]));
    expect(rem[1].ops).toEqual(expect.arrayContaining([['where', { scheduled_service_id: 'a' }]])); // re-stamp
    expect(rem[1].values).toEqual({ move_hold_until: rem[0].values.move_hold_until, move_hold_token: rem[0].values.move_hold_token });
    expect(rem[0].values.move_hold_token).toMatch(/^[0-9a-f]{32}$/); // unique cohort token (codex r35)
    // FULL success: claim + per-member re-stamps — the mover RETAINS the
    // hold (codex on-merge round): releasing before the caller's own
    // reminder sync opened a sweep-vs-notice duplicate window; the
    // caller's handleReschedule repair-release (token-keyed, one-stop +
    // parent verified) is the finalizer, with the healthy no-op repair
    // and the 24h TTL as backstops.
    db.__calls.length = 0; jest.clearAllMocks();
    db.__script = { ...script({ members: [member('a'), member('b')] }), appointment_reminders: reminders };
    await moveVisitAsUnit({ rebooker: fakeRebooker(), serviceId: 'a', service: SERVICE, newDate: '2026-09-02' });
    rem = db.__calls.filter((c) => c.table === 'appointment_reminders' && c.op === 'update');
    expect(rem.length).toBe(3); // claim + 2 re-stamps — NO release inside the mover
    expect(rem.every((c) => c.values.move_hold_until instanceof Date)).toBe(true);
    // ABORT (primary never moved): the hold is released before rethrow
    db.__calls.length = 0; jest.clearAllMocks();
    db.__script = { ...script({ members: [member('a'), member('b')], landed: [member('a'), member('b', { window_start: '10:00', window_end: '11:00' })] }), appointment_reminders: reminders };
    await expect(moveVisitAsUnit({ rebooker: fakeRebooker({ a: 'throw' }), serviceId: 'a', service: SERVICE, newDate: '2026-09-02' })).rejects.toThrow('member a boom');
    rem = db.__calls.filter((c) => c.table === 'appointment_reminders' && c.op === 'update');
    expect(rem[rem.length - 1].values).toEqual({ move_hold_until: null, move_hold_token: null });
    // a PARENT-RETARGET failure keeps the hold too (codex r29): the members landed but the visit record describes the old stop
    db.__calls.length = 0; jest.clearAllMocks();
    db.__script = { ...script({ members: [member('a'), member('b')] }), appointment_reminders: reminders };
    db.__script.service_visits = { first: (ops) => (ops.some((o) => o[0] === 'max') ? { max: 0 } : (db.__calls.filter((c) => c.table === 'service_visits' && c.op === 'first').length > 2 ? { ...VISIT, status: 'closing' } : VISIT)) };
    const retargetOut = await moveVisitAsUnit({ rebooker: fakeRebooker(), serviceId: 'a', service: SERVICE, newDate: '2026-09-02' });
    expect(retargetOut.visitMove.parentRetargetFailed).toBe(true);
    expect(db.__calls.filter((c) => c.table === 'appointment_reminders' && c.op === 'update' && c.values.move_hold_until === null).length).toBe(0); // hold KEPT
    // a LIVE foreign hold (another mover mid-move, stamped inside the takeover grace) is never overwritten — the move refuses (lease, codex r30)
    db.__calls.length = 0; jest.clearAllMocks();
    db.__script = { ...script({ members: [member('a'), member('b')] }), appointment_reminders: { select: () => [{ id: 'rem-a', move_hold_until: new Date(Date.now() + 24 * 3600000) }] } };
    await expect(moveVisitAsUnit({ rebooker: fakeRebooker(), serviceId: 'a', service: SERVICE, newDate: '2026-09-02' }))
      .rejects.toMatchObject({ statusCode: 503, code: 'VISIT_MOVE_HOLD_FAILED', reason: 'hold_active' });
    expect(db.__calls.filter((c) => c.table === 'appointment_reminders' && c.op === 'update').length).toBe(0);
    // a RETAINED foreign hold (active but stamped beyond the takeover grace — a partial move awaiting repair)
    // is taken over by the repair move instead of 503ing until the 24h expiry (codex r30 P1)
    db.__calls.length = 0; jest.clearAllMocks();
    db.__script = { ...script({ members: [member('a'), member('b')] }), appointment_reminders: { select: (ops) => (ops.some((o) => o[0] === 'forUpdate') ? [{ id: 'rem-a', move_hold_until: new Date(Date.now() + 24 * 3600000 - 10 * 60000) }] : []) } };
    await moveVisitAsUnit({ rebooker: fakeRebooker(), serviceId: 'a', service: SERVICE, newDate: '2026-09-02' });
    expect(db.__calls.filter((c) => c.table === 'appointment_reminders' && c.op === 'update' && c.values.move_hold_until instanceof Date).length).toBe(3); // takeover claim + 2 per-member re-stamps (retained — the caller's sync releases)
    // an EXPIRED foreign hold (abandoned partial) is claimable
    db.__calls.length = 0; jest.clearAllMocks();
    db.__script = { ...script({ members: [member('a'), member('b')] }), appointment_reminders: { select: (ops) => (ops.some((o) => o[0] === 'forUpdate') ? [{ id: 'rem-a', move_hold_until: new Date(Date.now() - 60000) }] : []) } };
    await moveVisitAsUnit({ rebooker: fakeRebooker(), serviceId: 'a', service: SERVICE, newDate: '2026-09-02' });
    expect(db.__calls.filter((c) => c.table === 'appointment_reminders' && c.op === 'update' && c.values.move_hold_until instanceof Date).length).toBe(3); // claim over the expired hold + 2 per-member re-stamps
    // an unclaimable hold ABORTS before anything moves
    db.__calls.length = 0; jest.clearAllMocks();
    db.__script = { ...script({ members: [member('a'), member('b')] }), appointment_reminders: { select: () => { throw new Error('ledger down'); } } };
    const rebooker = fakeRebooker();
    await expect(moveVisitAsUnit({ rebooker, serviceId: 'a', service: SERVICE, newDate: '2026-09-02' }))
      .rejects.toMatchObject({ statusCode: 503, code: 'VISIT_MOVE_HOLD_FAILED' });
    expect(rebooker.reschedule).not.toHaveBeenCalled();
    expect(db.__calls.some((c) => c.op === 'update' && c.table === 'scheduled_services')).toBe(false);
    // the SENDERS honor the hold (source contract): deferred recheck + the 72h/24h sweep
    const src = require('fs').readFileSync(require.resolve('../services/appointment-reminders'), 'utf8');
    expect(src.match(/move_hold_until/g).length).toBeGreaterThanOrEqual(5);
    // the shared chokepoint every leg passes (inline confirmations included) re-checks the hold at the last moment
    const choke = src.slice(src.indexOf('async function deliverAppointmentNotice'), src.indexOf('const ch = apptChannel(channel);'));
    expect(choke).toMatch(/move_hold_until/);
    expect(src).toMatch(/whereNull\('move_hold_until'\)\.orWhere\('move_hold_until', '<', new Date\(\)\)/);
    // repair-release (uncapped audit + r33 P1s): a successful reschedule of a
    // held row releases the WHOLE partial-move cohort — every row still
    // carrying the SAME stamp (the equality is the fence: a re-grouped row
    // carries a newer mover's stamp) whose service is UNGROUPED. Runs only
    // after the guarded sync committed.
    // the finalizer is the SHARED releaseMoveHoldIfRepaired (codex on-merge
    // r2): handleReschedule delegates after its guarded sync, and the
    // canonical assignment writer invokes the same mechanism post-commit
    // for tech-only repairs.
    // Search for the end marker AFTER handleReschedule: module-level cancellation helpers above it hold the same text.
    const reschedAt = src.indexOf('async handleReschedule');
    const resched = src.slice(reschedAt, src.indexOf('if (!sendNotification)', reschedAt));
    expect(resched).toMatch(/record\.move_hold_until && record\.move_hold_token && syncedRows > 0/);
    expect(resched).toMatch(/options\.preserveMoveHold !== true/);
    expect(resched).toMatch(/AppointmentReminders\.releaseMoveHoldIfRepaired\(scheduledServiceId\)/);
    const releaseSrc = src.slice(src.indexOf('async releaseMoveHoldIfRepaired'), src.indexOf('async handleReschedule'));
    expect(releaseSrc).toMatch(/\.where\(\{ 'ar\.move_hold_token': record\.move_hold_token \}\)/);
    // one-stop verification before release (local gate P1): a partial move's
    // own post-move primary sync must keep the hold while siblings sit split
    expect(releaseSrc).toMatch(/windowedMembersConnected\(liveRows\)/);
    const assignSrc = require('fs').readFileSync(require.resolve('../services/dispatch-assignment'), 'utf8');
    expect(assignSrc).toMatch(/releaseMoveHoldIfRepaired\(jobId\)/);
  });

  test('a live completion claim on ANY member freezes the move under the plan lock (local codex audit P0) — canSplit cannot see service_completion_attempts', async () => {
    const { LIVE_COMPLETION_CLAIM_STATUSES } = require('../services/visit-groups');
    expect(LIVE_COMPLETION_CLAIM_STATUSES).toEqual(['pending', 'side_effects_pending', 'side_effects_running', 'succeeded']);
    let claimQuery = null;
    db.__script = {
      ...script({ members: [member('a'), member('b')] }),
      service_completion_attempts: { first: (ops) => { claimQuery = ops; return { id: 'att1', service_id: 'b' }; } },
    };
    const rebooker = fakeRebooker();
    await expect(moveVisitAsUnit({ rebooker, serviceId: 'a', service: SERVICE, newDate: '2026-09-02', initiatedBy: 'admin' }))
      .rejects.toMatchObject({ statusCode: 409, code: 'VISIT_FROZEN_MOVE_UNSUPPORTED', reason: 'completion_in_flight', memberId: 'b', isOperational: true });
    expect(rebooker.reschedule).not.toHaveBeenCalled();
    expect(db.__calls.some((c) => c.op === 'update' || c.op === 'insert')).toBe(false);
    // the ledger read spans EVERY locked member and exactly the live statuses
    expect(claimQuery).toEqual(expect.arrayContaining([['whereIn', 'service_id', ['a', 'b']], ['whereIn', 'status', LIVE_COMPLETION_CLAIM_STATUSES]]));
    // an unreadable ledger fails the move (never opens it)
    db.__script = { ...script({ members: [member('a'), member('b')] }), service_completion_attempts: { first: () => { throw new Error('ledger down'); } } };
    await expect(moveVisitAsUnit({ rebooker, serviceId: 'a', service: SERVICE, newDate: '2026-09-02', initiatedBy: 'admin' })).rejects.toThrow('ledger down');
    expect(rebooker.reschedule).not.toHaveBeenCalled();
    // the rebooker repeats the check under each member's own row locks (a claim that lands after the plan): source contract
    const src = require('fs').readFileSync(require.resolve('../services/rebooker'), 'utf8');
    const block = src.slice(src.indexOf("options.excludeExpect) && options.excludeExpect.length"), src.indexOf("code: 'VISIT_PLAN_STALE'"));
    expect(block).toMatch(/service_completion_attempts'\)\.whereIn\('service_id', ids\)/);
    expect(block).toMatch(/LIVE_COMPLETION_CLAIM_STATUSES/);
    expect(block).toMatch(/code: 'VISIT_COMPLETION_IN_FLIGHT'/);
  });

  test('same-day window move: a failed sibling still on the date at its OLD window never feeds the parent retarget (local audit)', async () => {
    db.__script = script({ visit: { ...VISIT, scheduled_date: '2026-08-30', stop_base_key: 'p1:2026-08-30' }, members: [member('a'), member('b', { window_start: '10:00', window_end: '11:00' })], landed: [
      { id: 'a', scheduled_date: '2026-08-30', window_start: '13:00', window_end: '14:00', technician_id: 't1' },
      { id: 'b', scheduled_date: '2026-08-30', window_start: '10:00', window_end: '11:00', technician_id: 't1' }, // b failed: same day, old window
    ] });
    const out = await moveVisitAsUnit({ rebooker: fakeRebooker({ b: 'throw' }), serviceId: 'a', service: SERVICE, newDate: '2026-08-30', newWindow: '13:00-14:00' });
    expect(out.visitMove).toMatchObject({ moved: ['a'], failed: [expect.objectContaining({ id: 'b' })] });
    const patch = db.__calls.find((c) => c.table === 'service_visits' && c.op === 'update' && c.values.window_start);
    expect(patch.values).toMatchObject({ scheduled_date: '2026-08-30', window_start: '13:00', window_end: '14:00' }); // from a only — never 10:00–14:00
  });

  test('a member that left the visit or moved again before the retarget is reported as failed, never as moved (codex r17)', async () => {
    const base = { ...VISIT };
    db.__script = {
      service_visits: { first: (ops) => (ops.some((o) => o[0] === 'max') ? { max: 0 } : base) },
      scheduled_services: {
        // at retarget (FOR UPDATE + ORDER BY): b is GONE from the visit (a newer assignment's seam detached it), c moved again to another window
        select: (ops) => (ops.some((o) => o[0] === 'orderBy')
          ? [{ id: 'a', scheduled_date: '2026-09-02', window_start: '09:00', window_end: '10:00', technician_id: 't1' },
            { id: 'c', scheduled_date: '2026-09-02', window_start: '14:00', window_end: '15:00', technician_id: 't1' }]
          : ops.some((o) => o[0] === 'forUpdate') ? [member('a'), member('b'), member('c')]
            : [member('a'), member('b'), member('c')].map((m) => ({ ...m, visit_id: 'v1' }))),
      },
    };
    const out = await moveVisitAsUnit({ rebooker: fakeRebooker(), serviceId: 'a', service: SERVICE, newDate: '2026-09-02' });
    expect(out.visitMove.moved).toEqual(['a']);
    expect(out.visitMove.failed).toEqual([
      { id: 'b', reason: 'left the visit before the visit record was retargeted', code: 'VISIT_MEMBER_DIVERGED' },
      { id: 'c', reason: 'moved again before the visit record was retargeted', code: 'VISIT_MEMBER_DIVERGED' },
    ]);
    expect(out.visitMove.members.map((m) => m.id)).toEqual(['a']);
    expect(out.warnings.some((w) => /2 grouped service\(s\) did not move with this stop/.test(w))).toBe(true);
  });

  test('members the plan found already at the target are reported as unchanged (covered by this visit\'s move), never as moved (codex r19)', async () => {
    db.__script = script({ visit: VISIT, members: [member('a'), member('b', { window_start: null, window_end: null })], landed: [
      { id: 'a', scheduled_date: '2026-08-30', window_start: '13:00', window_end: '14:00', technician_id: 't1' },
      { id: 'b', scheduled_date: '2026-08-30', window_start: null, window_end: null, technician_id: 't1' },
    ] });
    const out = await moveVisitAsUnit({ rebooker: fakeRebooker(), serviceId: 'a', service: SERVICE, newDate: '2026-08-30', newWindow: '13:00-14:00' });
    expect(out.visitMove.moved).toEqual(['a']);
    expect(out.visitMove.unchanged).toEqual(['b']); // windowless sibling stays windowless on a same-day window move
    db.__script = script({ visit: { ...VISIT, scheduled_date: '2026-09-02', stop_base_key: 'p1:2026-09-02' }, members: [member('a', { scheduled_date: '2026-09-02' }), member('b', { scheduled_date: '2026-09-02' })] });
    const noop = await moveVisitAsUnit({ rebooker: fakeRebooker(), serviceId: 'a', service: SERVICE, newDate: '2026-09-02' });
    expect(noop.visitMove).toMatchObject({ alreadyAtTarget: true, unchanged: ['a', 'b'] });
  });
});

// GATE_TECH_SHIFT_HOURS (D4 part 3b-2b). The shift loader is stubbed here: the
// real one, over real rows, is in tech-shift-hours-move-postgres.test.js.
describe('shift hours: a grouped stop is judged as one unit', () => {
  const eligibility = require('../services/technician-eligibility');
  const vg = require('../services/visit-groups');
  const script = ({ visit = VISIT, members, landed = null }) => ({
    service_visits: { first: (ops) => (ops.some((o) => o[0] === 'max') ? { max: 0 } : visit) },
    scheduled_services: {
      select: (ops) => (ops.some((o) => o[0] === 'orderBy') ? (landed || members.map((m) => ({ ...m, scheduled_date: '2026-09-02' })))
        : ops.some((o) => o[0] === 'forUpdate') ? members
          : ops.some((o) => o[0] === 'whereIn' && o[1] === 'id') ? members.map((m) => ({ ...m, visit_id: 'v1' }))
            : (landed || members.map((m) => ({ ...m, scheduled_date: '2026-09-02' })))),
    },
  });
  // Minutes after midnight: t1 works 08:00 to 15:00, t9 08:00 to 12:00.
  let shifts;
  let loadTechShifts;
  beforeEach(() => {
    shifts = { t1: { startMin: 480, endMin: 900 }, t9: { startMin: 480, endMin: 720 } };
    loadTechShifts = jest.spyOn(eligibility, 'loadTechShifts')
      .mockImplementation(async (conn, { technicianIds }) => (id) => (technicianIds.map(String).includes(String(id)) ? shifts[id] || null : null));
  });
  afterEach(() => { loadTechShifts.mockRestore(); delete process.env.GATE_TECH_SHIFT_HOURS; });

  const pair = (b = {}, a = {}) => [member('a', a), member('b', { window_start: '10:00', window_end: '11:00', ...b })];
  const landed = (aStart, bStart, tech = 't1') => [
    { id: 'a', scheduled_date: '2026-09-02', window_start: aStart, window_end: `${String(Number(aStart.slice(0, 2)) + 1).padStart(2, '0')}:00`, technician_id: tech },
    { id: 'b', scheduled_date: '2026-09-02', window_start: bStart, window_end: `${String(Number(bStart.slice(0, 2)) + 1).padStart(2, '0')}:00`, technician_id: tech },
  ];
  const unit = (rebooker, newWindow, initiatedBy = 'tech', options = {}) => moveVisitAsUnit({
    rebooker, serviceId: 'a', service: SERVICE, newDate: '2026-09-02', newWindow, reason: 'weather_rain', initiatedBy, options,
  });
  const refusedFor = (memberId) => ({ statusCode: 409, status: 409, code: 'SLOT_TAKEN', isOperational: true, memberId });
  const nothingWritten = (rebooker) => {
    expect(rebooker.reschedule).not.toHaveBeenCalled();
    expect(assignDispatchJob).not.toHaveBeenCalled();
    expect(db.__calls.some((c) => c.op === 'update' || c.op === 'insert' || c.op === 'del')).toBe(false);
  };

  describe('moveVisitAsUnit', () => {
    test('a technician\'s move: a sibling that would end after the shift refuses the whole stop before any write; a stop that fits moves', async () => {
      // a 14:00 to 15:00 fits; its sibling follows an hour later and ends at 16:00.
      db.__script = script({ members: pair() });
      const refused = fakeRebooker();
      await expect(unit(refused, '14:00-15:00')).rejects.toMatchObject(refusedFor('b'));
      nothingWritten(refused);
      expect(loadTechShifts.mock.calls[0][1]).toEqual({ technicianIds: ['t1'] });

      db.__script = script({ members: pair({ estimated_duration_minutes: 45 }), landed: landed('13:00', '14:00') });
      const moved = fakeRebooker();
      expect((await unit(moved, '13:00-14:00')).visitMove).toMatchObject({ moved: ['a', 'b'], failed: [] });
      expect(moved.reschedule).toHaveBeenCalledTimes(2);
      // Each judged member's own write pins the length the verdict used (a has none stored), beside its technician.
      const [aCall, bCall] = moved.reschedule.mock.calls;
      expect(aCall[5].expect).toMatchObject({ technician_id: 't1', estimated_duration_minutes: null });
      expect(bCall[5].expect).toMatchObject({ technician_id: 't1', estimated_duration_minutes: 45 });
      // The other members' contract carries no length: the rebooker's own read of them does not select it.
      expect(aCall[5].excludeExpect.every((x) => !('estimated_duration_minutes' in x))).toBe(true);
    });

    test('a member is judged where its own write leaves it: a range the rebooker cannot read (a time sent with seconds) keeps the stored hours, and those are judged', async () => {
      // The rebooker reads a range in minutes only. For "13:00:00-14:00:00" the first service keeps 09:00 to 10:00 on the
      // new day, as on main, while its sibling shifts to 14:00. The shift starts at 10:00: the requested hours fit, the write's do not.
      shifts.t1 = { startMin: 600, endMin: 900 };
      db.__script = script({ members: pair() });
      const refused = fakeRebooker();
      await expect(unit(refused, { start: '13:00:00', end: '14:00:00' })).rejects.toMatchObject(refusedFor('a'));
      nothingWritten(refused);
      // The same request in minutes is written as asked, and judged as asked.
      db.__script = script({ members: pair(), landed: landed('13:00', '14:00') });
      const moved = fakeRebooker();
      expect((await unit(moved, { start: '13:00', end: '14:00' })).visitMove).toMatchObject({ moved: ['a', 'b'], failed: [] });
      // Stored hours the shift holds: the move goes on, and the range goes to the rebooker as it came, as on main.
      shifts.t1 = { startMin: 480, endMin: 900 };
      db.__script = script({ members: pair() });
      const asOnMain = fakeRebooker();
      await unit(asOnMain, { start: '13:00:00', end: '14:00:00' }).catch(() => null);
      expect(asOnMain.reschedule.mock.calls[0][2]).toBe('13:00:00-14:00:00');
      // A start-only window goes to the rebooker as an object, which it takes as given: judged at the asked start.
      shifts.t1 = { startMin: 480, endMin: 870 }; // 08:00 to 14:30
      jest.clearAllMocks(); db.__calls.length = 0;
      db.__script = script({ members: pair({ window_start: null, window_end: null }, { window_end: null, estimated_duration_minutes: 60 }) });
      const startOnly = fakeRebooker();
      await expect(unit(startOnly, { start: '14:00', end: null })).rejects.toMatchObject(refusedFor('a'));
      nothingWritten(startOnly);
    });

    test('a requested start that is no clock time is not judged, so it is refused for a member a shift judges; with no shift to judge, the move goes on as before', async () => {
      // A start-only request beside a sibling with no window (the planner refuses a windowed sibling itself). The
      // rebooker takes the start as given, and the shift check cannot read a block from it.
      db.__script = script({ members: pair({ window_start: null, window_end: null }, { window_end: null }) });
      const badStart = fakeRebooker();
      await expect(unit(badStart, { start: '13:00x', end: null })).rejects.toMatchObject(refusedFor('a'));
      nothingWritten(badStart);
      await expect(unit(badStart, { start: '25:00', end: null })).rejects.toMatchObject(refusedFor('a'));
      nothingWritten(badStart);
      // A stored end of 24:00:00 is a clock time for an end, not for a start.
      const allDay = () => ({ startMin: 0, endMin: 1440 });
      expect(vg._test.memberOutsideShift(allDay, '2026-09-02', [{ id: 'a', technicianId: 't1', start: '23:00', end: '24:00:00', durationMinutes: 60 }])).toBe(null);
      expect(vg._test.memberOutsideShift(allDay, '2026-09-02', [{ id: 'a', technicianId: 't1', start: '24:00:00', end: null, durationMinutes: 60 }])).toBe('a');
      expect(vg._test.memberOutsideShift(allDay, '2026-09-02', [{ id: 'a', technicianId: 't1', start: '09:00', end: '10:00x', durationMinutes: 60 }])).toBe('a');
      // No bound at all is a member with no window: not judged, as before.
      expect(vg._test.memberOutsideShift(allDay, '2026-09-02', [{ id: 'a', technicianId: 't1', start: null, end: null, durationMinutes: 60 }])).toBe(null);
      // No technician with set hours: nothing judges the request, and the mover hands it on as on main.
      delete shifts.t1;
      db.__script = script({ members: pair({ window_start: null, window_end: null }, { window_end: null }) });
      const unjudged = fakeRebooker();
      await unit(unjudged, { start: '13:00x', end: null }).catch(() => null);
      expect(unjudged.reschedule.mock.calls[0][2]).toEqual({ start: '13:00x', end: null });
    });

    test('a member\'s block is the later of its window end and its stored length', async () => {
      // The sibling is a two-hour job in a one-hour window.
      const members = pair({ estimated_duration_minutes: 120 });
      db.__script = script({ members });
      const refused = fakeRebooker();
      // 14:00 + 120 minutes = 16:00, after the 15:00 shift end.
      await expect(unit(refused, '13:00-14:00')).rejects.toMatchObject(refusedFor('b'));
      nothingWritten(refused);
      // 13:00 + 120 minutes = 15:00, the shift end.
      db.__script = script({ members, landed: landed('12:00', '13:00') });
      expect((await unit(fakeRebooker(), '12:00-13:00')).visitMove).toMatchObject({ moved: ['a', 'b'], failed: [] });
    });

    test('a move of the day only keeps each member\'s own window, and a start before the shift is refused', async () => {
      shifts.t1 = { startMin: 600, endMin: 900 }; // 10:00 to 15:00
      db.__script = script({ members: pair() });
      const refused = fakeRebooker();
      await expect(unit(refused, undefined)).rejects.toMatchObject(refusedFor('a'));
      nothingWritten(refused);
      // A start at the shift start, and an end at the shift end, fit.
      shifts.t1 = { startMin: 540, endMin: 660 }; // 09:00 to 11:00
      db.__script = script({ members: pair(), landed: landed('09:00', '10:00') });
      expect((await unit(fakeRebooker(), undefined)).visitMove).toMatchObject({ moved: ['a', 'b'], failed: [] });
    });

    test('the office\'s own move is not judged, and no shift is read', async () => {
      db.__script = script({ members: pair(), landed: landed('14:00', '15:00') });
      const rebooker = fakeRebooker();
      expect((await unit(rebooker, '14:00-15:00', 'admin')).visitMove).toMatchObject({ moved: ['a', 'b'], failed: [] });
      expect(loadTechShifts).not.toHaveBeenCalled();
      expect(rebooker.reschedule.mock.calls.every((c) => !('estimated_duration_minutes' in c[5].expect))).toBe(true);
    });

    test('a unit that names a technician is judged on that technician, not on the one each member leaves', async () => {
      // t9 stops at 12:00. The sibling lands 12:00 to 13:00: inside t1's shift, outside t9's.
      db.__script = script({ members: pair() });
      const refused = fakeRebooker();
      await expect(unit(refused, '11:00-12:00', 'auto_dispatch', { technicianId: 't9' })).rejects.toMatchObject(refusedFor('b'));
      nothingWritten(refused);
      expect(loadTechShifts.mock.calls[0][1]).toEqual({ technicianIds: ['t9'] });
      // The members' own technician stops at 10:00, and t9 holds both landings.
      shifts.t1 = { startMin: 480, endMin: 600 };
      db.__script = script({ members: pair(), landed: landed('10:00', '11:00', 't9') });
      expect((await unit(fakeRebooker(), '10:00-11:00', 'auto_dispatch', { technicianId: 't9' })).visitMove).toMatchObject({ moved: ['a', 'b'], failed: [] });
    });

    test('the caller\'s own fence on the first service must agree with what the plan read: another technician, or another length than a verdict used, is a stale request, refused before any write', async () => {
      process.env.GATE_TECH_SHIFT_HOURS = 'true';
      // A technician's rain-out pins the technician whose request it is. The plan reads t1 under the lock and judges t1's hours.
      db.__script = script({ members: pair() });
      const stale = fakeRebooker();
      await expect(unit(stale, '13:00-14:00', 'tech', { expect: { technician_id: 't9' } })).rejects.toMatchObject({ statusCode: 409, code: 'SLOT_TAKEN', isOperational: true });
      nothingWritten(stale);
      await expect(unit(stale, '13:00-14:00', 'tech', { expect: { estimated_duration_minutes: 30 } })).rejects.toMatchObject({ statusCode: 409, code: 'SLOT_TAKEN' });
      nothingWritten(stale);
      // A fence that agrees rides the write, as before.
      db.__script = script({ members: pair(), landed: landed('13:00', '14:00') });
      const agrees = fakeRebooker();
      expect((await unit(agrees, '13:00-14:00', 'tech', { expect: { technician_id: 't1', estimated_duration_minutes: null } })).visitMove).toMatchObject({ moved: ['a', 'b'], failed: [] });
      // A caller's fence drops the plan's own fence of the first service. The stored hours the verdict used are pinned
      // all the same: a move of the day alone carries them to the new day.
      expect(agrees.reschedule.mock.calls[0][5].expect).toMatchObject({ window_start: '09:00', window_end: '10:00', technician_id: 't1', estimated_duration_minutes: null });
      // A caller fence on other stored hours than the plan read is stale too; the same hours in another form are not.
      db.__script = script({ members: pair() });
      await expect(unit(fakeRebooker(), undefined, 'tech', { expect: { window_start: '08:00' } })).rejects.toMatchObject({ statusCode: 409, code: 'SLOT_TAKEN' });
      await expect(unit(fakeRebooker(), undefined, 'tech', { expect: { window_end: '10:30' } })).rejects.toMatchObject({ statusCode: 409, code: 'SLOT_TAKEN' });
      db.__script = script({ members: pair(), landed: landed('09:00', '10:00') });
      expect((await unit(fakeRebooker(), undefined, 'tech', { expect: { window_start: '9:00', window_end: '10:00:00' } })).visitMove).toMatchObject({ moved: ['a', 'b'], failed: [] });
      // The office's own move keeps the caller's fence for the write to judge, as before: no key is added.
      db.__script = script({ members: pair(), landed: landed('13:00', '14:00') });
      const office = fakeRebooker();
      expect((await unit(office, '13:00-14:00', 'admin', { expect: { technician_id: 't9' } })).visitMove).toMatchObject({ moved: ['a', 'b'], failed: [] });
      expect(office.reschedule.mock.calls[0][5].expect).toMatchObject({ technician_id: 't9' });
      expect('window_start' in office.reschedule.mock.calls[0][5].expect).toBe(false);
      // A first service no shift judged (its technician has no set hours): another technician is still stale, because
      // no verdict was for that technician. Another length is not: no verdict used a length.
      delete shifts.t1;
      jest.clearAllMocks(); db.__calls.length = 0;
      db.__script = script({ members: pair() });
      const unjudged = fakeRebooker();
      await expect(unit(unjudged, '13:00-14:00', 'tech', { expect: { technician_id: 't9' } })).rejects.toMatchObject({ statusCode: 409, code: 'SLOT_TAKEN' });
      nothingWritten(unjudged);
      db.__script = script({ members: pair(), landed: landed('13:00', '14:00') });
      expect((await unit(unjudged, '13:00-14:00', 'tech', { expect: { estimated_duration_minutes: 30 } })).visitMove).toMatchObject({ moved: ['a', 'b'], failed: [] });
      // A first service the move does not change has no write for the fence to ride: not refused.
      jest.clearAllMocks(); db.__calls.length = 0;
      const members = pair({ window_start: '13:00', window_end: '14:00' });
      db.__script = script({ members, landed: [{ id: 'a', scheduled_date: '2026-08-30', window_start: '09:00', window_end: '10:00', technician_id: 't1' }, { id: 'b', scheduled_date: '2026-08-30', window_start: '13:00', window_end: '14:00', technician_id: 't1' }] });
      const same = await moveVisitAsUnit({ rebooker: fakeRebooker(), serviceId: 'a', service: SERVICE, newDate: '2026-08-30', reason: 'weather_rain', initiatedBy: 'tech', options: { expect: { technician_id: 't9' } } }).catch((e) => e);
      expect(same.code).not.toBe('SLOT_TAKEN');
      // The same when another service of the stop does change: the unit names t9, the first service is on t9 already
      // at these hours, and only b (on t1) changes. The caller's fence has no write to ride, so it refuses nothing.
      shifts.t1 = { startMin: 480, endMin: 900 };
      const onlyB = pair({}, { technician_id: 't9' });
      db.__script = script({ members: onlyB, landed: onlyB.map((m) => ({ id: m.id, scheduled_date: '2026-08-30', window_start: m.window_start, window_end: m.window_end, technician_id: 't9' })) });
      const sibling = await moveVisitAsUnit({ rebooker: fakeRebooker(), serviceId: 'a', service: SERVICE, newDate: '2026-08-30', reason: 'auto_dispatch', initiatedBy: 'auto_dispatch', options: { technicianId: 't9', expect: { technician_id: 't1' } } });
      expect(sibling.visitMove).toMatchObject({ moved: ['b'], unchanged: ['a'], failed: [] });
      // Gate off: the fence rides the write, as before.
      delete process.env.GATE_TECH_SHIFT_HOURS;
      db.__script = script({ members: pair(), landed: landed('13:00', '14:00') });
      const off = fakeRebooker();
      expect((await unit(off, '13:00-14:00', 'tech', { expect: { technician_id: 't9' } })).visitMove).toMatchObject({ moved: ['a', 'b'], failed: [] });
      expect(off.reschedule.mock.calls[0][5].expect).toMatchObject({ technician_id: 't9' });
    });

    // A unit that names a technician assigns each member in a later write of its own, after the member's move.
    // The plan's verdict and the move's pins do not reach that write, so an automatic move asks the assignment's own
    // locked re-check to judge the row as it now is (assignDispatchJob `shiftHours`: its cases are in
    // dispatch-assignment-eligibility.test.js and, on real rows, in tech-shift-hours-move-postgres.test.js).
    test('a unit that names a technician: an automatic move asks each assignment to judge the shift; the office\'s own move does not', async () => {
      process.env.GATE_TECH_SHIFT_HOURS = 'true';
      const shiftAsked = () => assignDispatchJob.mock.calls.map((c) => [c[0].jobId, c[0].shiftHours]);
      db.__script = script({ members: pair(), landed: landed('10:00', '11:00', 't9') });
      expect((await unit(fakeRebooker(), '10:00-11:00', 'auto_dispatch', { technicianId: 't9' })).visitMove).toMatchObject({ moved: ['a', 'b'], failed: [] });
      expect(shiftAsked()).toEqual([['a', true], ['b', true]]);
      jest.clearAllMocks(); db.__calls.length = 0;
      db.__script = script({ members: pair(), landed: landed('13:00', '14:00', 't9') });
      expect((await unit(fakeRebooker(), '13:00-14:00', 'admin', { technicianId: 't9' })).visitMove).toMatchObject({ moved: ['a', 'b'], failed: [] });
      expect(assignDispatchJob.mock.calls.map((c) => [c[0].jobId, 'shiftHours' in c[0]])).toEqual([['a', false], ['b', false]]);
    });

    test('a member with no technician is not judged', async () => {
      db.__script = script({ members: pair({ technician_id: null }), landed: [landed('14:00', '15:00')[0], { ...landed('14:00', '15:00')[1], technician_id: null }] });
      const rebooker = fakeRebooker();
      expect((await unit(rebooker, '14:00-15:00')).visitMove).toMatchObject({ moved: ['a', 'b'], failed: [] });
      // No verdict used its length, so its write pins none.
      expect('estimated_duration_minutes' in rebooker.reschedule.mock.calls[1][5].expect).toBe(false);
    });

    test('a member the move does not change is not judged', async () => {
      // The unit names t9 on the same day and hours. b is on t9 already and ends after t9's shift; only a changes, and a fits.
      shifts.t9 = { startMin: 480, endMin: 630 }; // 08:00 to 10:30
      const members = pair({ technician_id: 't9' });
      db.__script = script({ members, landed: members.map((m) => ({ id: m.id, scheduled_date: '2026-08-30', window_start: m.window_start, window_end: m.window_end, technician_id: 't9' })) });
      const rebooker = fakeRebooker();
      const out = await moveVisitAsUnit({ rebooker, serviceId: 'a', service: SERVICE, newDate: '2026-08-30', reason: 'auto_dispatch', initiatedBy: 'auto_dispatch', options: { technicianId: 't9' } });
      expect(out.visitMove).toMatchObject({ moved: ['a'], unchanged: ['b'], failed: [] });
      // Had b changed too, the same plan is refused: both members on t1, moved to t9.
      jest.clearAllMocks(); db.__calls.length = 0;
      db.__script = script({ members: pair() });
      const refused = fakeRebooker();
      await expect(moveVisitAsUnit({ rebooker: refused, serviceId: 'a', service: SERVICE, newDate: '2026-08-30', reason: 'auto_dispatch', initiatedBy: 'auto_dispatch', options: { technicianId: 't9' } }))
        .rejects.toMatchObject(refusedFor('b'));
      nothingWritten(refused);
    });

    test('gate off: the real loader reads nothing, and the stop moves as before', async () => {
      loadTechShifts.mockRestore();
      db.__script = script({ members: pair(), landed: landed('14:00', '15:00') });
      const rebooker = fakeRebooker();
      expect((await unit(rebooker, '14:00-15:00')).visitMove).toMatchObject({ moved: ['a', 'b'], failed: [] });
      expect(db.__calls.some((c) => c.table === 'technicians' && c.op === 'select')).toBe(false);
      expect(db.__calls.some((c) => c.table === 'time_entries')).toBe(false);
      expect(rebooker.reschedule.mock.calls.every((c) => !('estimated_duration_minutes' in c[5].expect))).toBe(true);
    });
  });

  // The read-only twin for a list whose pick commits as that move (the tech app's rain-out sheets).
  describe('unitShiftTest', () => {
    const GROUPED = { id: 'a', visit_id: 'v1' };
    const wire = (members, visit = VISIT) => {
      db.__script = { service_visits: { first: () => visit }, scheduled_services: { select: () => members } };
    };

    test('no test when there is no unit to judge: gate off (no read), an ungrouped visit, a stop that is not open, one live member, a service that left the stop', async () => {
      wire(pair());
      expect(await vg.unitShiftTest(db, GROUPED)).toBe(null);
      expect(db.__calls).toEqual([]);
      process.env.GATE_TECH_SHIFT_HOURS = 'true';
      expect(await vg.unitShiftTest(db, { id: 'a', visit_id: null })).toBe(null);
      expect(db.__calls).toEqual([]);
      wire(pair(), { ...VISIT, status: 'dissolved' });
      expect(await vg.unitShiftTest(db, GROUPED)).toBe(null);
      wire([member('a')]);
      expect(await vg.unitShiftTest(db, GROUPED)).toBe(null);
      wire([member('b'), member('c')]);
      expect(await vg.unitShiftTest(db, GROUPED)).toBe(null);
      expect(loadTechShifts).not.toHaveBeenCalled();
    });

    test('it refuses the placements the mover refuses: every member\'s landing, on that member\'s own technician, with its stored length', async () => {
      process.env.GATE_TECH_SHIFT_HOURS = 'true';
      // The live members only: the read leaves out a cancelled or completed row.
      wire(pair());
      const refuses = await vg.unitShiftTest(db, GROUPED);
      const read = db.__calls.find((c) => c.table === 'scheduled_services' && c.op === 'select');
      expect(read.ops).toEqual(expect.arrayContaining([['where', { visit_id: 'v1' }], ['whereNotIn', 'status', expect.arrayContaining(['cancelled', 'completed'])]]));
      expect(loadTechShifts.mock.calls[0][1]).toEqual({ technicianIds: ['t1'] });
      expect(refuses('2026-09-02', '13:00', '14:00')).toBe(false); // b lands 14:00 to 15:00
      expect(refuses('2026-09-02', '14:00', '15:00')).toBe(true);  // b lands 15:00 to 16:00
      expect(refuses('2026-09-02', '07:00', '08:00')).toBe(true);  // a starts before 08:00

      // b is t9's (08:00 to 12:00): a fits t1 at 11:00, b lands 12:00 to 13:00.
      wire(pair({ technician_id: 't9' }));
      const mixed = await vg.unitShiftTest(db, GROUPED);
      expect(loadTechShifts.mock.calls[1][1]).toEqual({ technicianIds: ['t1', 't9'] });
      expect(mixed('2026-09-02', '11:00', '12:00')).toBe(true);
      expect(mixed('2026-09-02', '10:00', '11:00')).toBe(false);

      wire(pair({ estimated_duration_minutes: 120 }));
      const long = await vg.unitShiftTest(db, GROUPED);
      expect(long('2026-09-02', '13:00', '14:00')).toBe(true);  // b: 14:00 + 120 minutes
      expect(long('2026-09-02', '12:00', '13:00')).toBe(false); // b: 13:00 + 120 minutes = 15:00
    });

    test('a member the placement leaves where it is is not judged; a plan the mover refuses for another reason is not dropped, but the tapped service keeps to its own shift', async () => {
      process.env.GATE_TECH_SHIFT_HOURS = 'true';
      // The stop as it stands: b already ends after the shift (the office placed it). The same day and hours change nothing.
      shifts.t1 = { startMin: 480, endMin: 630 }; // 08:00 to 10:30
      wire(pair());
      const refuses = await vg.unitShiftTest(db, GROUPED);
      expect(refuses('2026-08-30', '09:00', '10:00')).toBe(false);
      expect(refuses('2026-09-02', '09:00', '10:00')).toBe(true); // another day: b moves, and is judged
      // A sibling pushed across midnight: the mover's own refusal (VISIT_MEMBER_WINDOW_INVALID), not a shift verdict.
      // The pick's answer stays the mover's. The tapped service is then judged alone at the asked hours, as an ungrouped visit is.
      shifts.t1 = { startMin: 0, endMin: 1380 }; // 00:00 to 23:00
      wire(pair({ window_start: '11:00', window_end: '12:00' }));
      const late = await vg.unitShiftTest(db, GROUPED);
      expect(late('2026-09-02', '22:00', '23:00')).toBe(false);
      shifts.t1 = { startMin: 0, endMin: 1350 }; // 00:00 to 22:30: a would end after its own shift
      expect(late('2026-09-02', '22:00', '23:00')).toBe(true);
      // With its stored length: 22:00 for 90 minutes ends at 23:30.
      shifts.t1 = { startMin: 0, endMin: 1380 };
      wire(pair({ window_start: '11:00', window_end: '12:00' }, { estimated_duration_minutes: 90 }));
      expect((await vg.unitShiftTest(db, GROUPED))('2026-09-02', '22:00', '23:00')).toBe(true);
      // The asked end counts when it is later than the stored length: 22:00 to 23:00 for a 30-minute job ends at 23:00.
      shifts.t1 = { startMin: 0, endMin: 1365 }; // 00:00 to 22:45
      wire(pair({ window_start: '11:00', window_end: '12:00' }, { estimated_duration_minutes: 30 }));
      expect((await vg.unitShiftTest(db, GROUPED))('2026-09-02', '22:00', '23:00')).toBe(true);
      // The tapped service is another technician's than its sibling: it is judged on its own.
      shifts.t9 = { startMin: 0, endMin: 1380 };
      shifts.t1 = { startMin: 0, endMin: 600 };
      wire(pair({ window_start: '11:00', window_end: '12:00' }, { technician_id: 't9' }));
      expect((await vg.unitShiftTest(db, GROUPED))('2026-09-02', '22:00', '23:00')).toBe(false);
    });
  });
});

describe('the member assignment transaction locks both tech-days before it locks the row', () => {
  test('lockTechDays comes first and a failed row lock (a deadlock) is not swallowed', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'services', 'visit-groups.js'), 'utf8');
    const at = src.indexOf("await acquireOccupancyLock(t, newDateStr);");
    expect(at).toBeGreaterThan(0);
    const block = src.slice(at, src.indexOf('const windowStart = (row && row.window_start)', at));
    expect(block.indexOf('lockTechDays')).toBeGreaterThan(0);
    expect(block.indexOf('lockTechDays')).toBeLessThan(block.indexOf('.forUpdate()'));
    expect(block).toContain('techId: options.technicianId');
    // The locked row must still sit on the day whose tech-days were locked.
    expect(block).toContain('dateOnly(row.scheduled_date) !== newDateStr');
    expect(block).not.toContain('.catch(');
  });
});
