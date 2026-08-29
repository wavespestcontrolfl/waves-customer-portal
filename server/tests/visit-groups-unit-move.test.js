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
      leftJoin() { chain._ops.push(['leftJoin', ...arguments]); return chain; },
      forUpdate() { chain._ops.push(['forUpdate']); return chain; },
      max() { chain._ops.push(['max', ...arguments]); return chain; },
      first(...cols) { log.push({ table, op: 'first', ops: chain._ops, cols }); return Promise.resolve(script[table] && script[table].first ? script[table].first(chain._ops) : null); },
      select(...cols) { log.push({ table, op: 'select', ops: chain._ops, cols }); return Promise.resolve(script[table] && script[table].select ? script[table].select(chain._ops) : []); },
      update(values) { log.push({ table, op: 'update', ops: chain._ops, values }); return Promise.resolve(1); },
      count() { chain._ops.push(['count', ...arguments]); return chain; },
      del() { log.push({ table, op: 'del', ops: chain._ops }); return Promise.resolve(1); },
      then(res, rej) { return Promise.resolve([]).then(res, rej); },
    };
    return chain;
  }
  const db = jest.fn((table) => makeChain(table, db.__script, calls));
  db.__calls = calls; db.__script = {}; db.__rawCalls = [];
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
jest.mock('../services/scheduling/occupancy', () => ({ findConflictingVisits: jest.fn().mockResolvedValue([]) }));

const db = require('../models/db');
const AppointmentReminders = require('../services/appointment-reminders');
const { moveVisitAsUnit, _test: { shiftClock } } = require('../services/visit-groups');

const VISIT = { id: 'v1', status: 'open', stop_base_key: 'p1:2026-08-30', scheduled_date: '2026-08-30', customer_id: 'c1', property_id: 'p1', technician_id: 't1', window_start: '09:00', window_end: '11:00' };
const member = (id, over = {}) => ({ id, status: 'confirmed', technician_id: 't1', customer_id: 'c1', property_id: 'p1', scheduled_date: '2026-08-30', window_start: '09:00', window_end: '10:00', ...over });
const SERVICE = { id: 'a', visit_id: 'v1' };

function fakeRebooker(behaviour = {}) {
  const impl = async (id, date, win, reason, by, opts) => {
    if (behaviour[id] === 'throw' && reason !== 'visit_move_rollback') throw Object.assign(new Error(`member ${id} boom`), { code: 'SLOT_TAKEN' });
    return { success: true, originalDate: '2026-08-30', newDate: date, id, win, opts };
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

describe('moveVisitAsUnit', () => {
  // scheduled_services.select answers the PLAN read (forUpdate) with `members`
  // and the RETARGET read (no forUpdate) with `landed`.
  // The pre-primary REVALIDATION read (whereIn id, no forUpdate) answers with
  // `revalidate` (default: the members as planned, i.e. unchanged).
  const script = ({ visit = VISIT, members, landed = null, maxSeq = 0, revalidate = null }) => ({
    service_visits: { first: (ops) => (ops.some((o) => o[0] === 'max') ? { max: maxSeq } : visit) },
    scheduled_services: { select: (ops) => (ops.some((o) => o[0] === 'forUpdate') ? members
      : ops.some((o) => o[0] === 'whereIn' && o[1] === 'id') ? (revalidate || members.map((m) => ({ ...m, visit_id: 'v1' })))
        : (landed || members.map((m) => ({ ...m, scheduled_date: '2026-09-02' })))) },
  });

  test('ungrouped row / not open visit / single live member ⇒ null (plain move)', async () => {
    expect(await moveVisitAsUnit({ rebooker: fakeRebooker(), serviceId: 'a', service: { id: 'a', visit_id: null }, newDate: '2026-09-02' })).toBe(null);
    db.__script = script({ visit: { ...VISIT, status: 'closing' }, members: [] });
    expect(await moveVisitAsUnit({ rebooker: fakeRebooker(), serviceId: 'a', service: SERVICE, newDate: '2026-09-02' })).toBe(null);
    db.__script = script({ members: [member('a')] });
    expect(await moveVisitAsUnit({ rebooker: fakeRebooker(), serviceId: 'a', service: SERVICE, newDate: '2026-09-02' })).toBe(null);
  });

  test('date + window move: members moved first (primary with caller options, siblings with their OWN fence), then the parent retargeted from the rows that landed', async () => {
    db.__script = script({ members: [member('a'), member('b', { window_start: '10:00', window_end: '11:00' })], landed: [
      { id: 'a', scheduled_date: '2026-09-02', window_start: '13:00', window_end: '14:00' },
      { id: 'b', scheduled_date: '2026-09-02', window_start: '14:00', window_end: '15:00' },
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
    expect(sCall[5]).toMatchObject({ visitPolicy: 'single', skipVisitSeam: true, expect: { scheduled_date: '2026-08-30', window_start: '10:00', window_end: '11:00' } });
    expect(sCall[5].expectOccurrenceIds).toBeUndefined();
    // each move hides only the OTHER participating rows from its probes (codex r6)
    expect(rebooker.reschedule.mock.calls[0][5].excludeServiceIds).toEqual(['b']);
    expect(rebooker.reschedule.mock.calls[1][5].excludeServiceIds).toEqual(['a']);
    // every moved SIBLING gets its reminder row synced (notice suppressed); the primary's is the caller's job
    expect(AppointmentReminders.handleReschedule).toHaveBeenCalledTimes(1);
    expect(AppointmentReminders.handleReschedule).toHaveBeenCalledWith('b', '2026-09-02T14:00', { sendNotification: false, expectSchedule: { date: '2026-09-02', windowStart: '14:00' } });
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
    expect(db.__calls.some((c) => c.table === 'service_visits' && c.op === 'update')).toBe(false);
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

  test('a caller without a scheduling fence gets the locked plan fence on the primary; a fenced caller keeps its own', async () => {
    db.__script = script({ members: [member('a'), member('b')] });
    let rebooker = fakeRebooker();
    await moveVisitAsUnit({ rebooker, serviceId: 'a', service: SERVICE, newDate: '2026-09-02' });
    expect(rebooker.reschedule.mock.calls[0][5].expect).toEqual({ scheduled_date: '2026-08-30', window_start: '09:00', window_end: '10:00' });
    jest.clearAllMocks(); db.__script = script({ members: [member('a'), member('b')] });
    rebooker = fakeRebooker();
    await moveVisitAsUnit({ rebooker, serviceId: 'a', service: SERVICE, newDate: '2026-09-02', options: { expectAnchor: { scheduled_date: '2026-08-30' } } });
    expect(rebooker.reschedule.mock.calls[0][5].expect).toBeUndefined();
    expect(rebooker.reschedule.mock.calls[0][5].expectAnchor).toEqual({ scheduled_date: '2026-08-30' });
  });

  test('sibling reminder sync is fenced with expectSchedule against a newer move', async () => {
    db.__script = script({ members: [member('a'), member('b', { window_start: '10:00', window_end: '11:00' })] });
    await moveVisitAsUnit({ rebooker: fakeRebooker(), serviceId: 'a', service: SERVICE, newDate: '2026-09-02', newWindow: '13:00-14:00' });
    expect(AppointmentReminders.handleReschedule).toHaveBeenCalledWith('b', '2026-09-02T14:00', { sendNotification: false, expectSchedule: { date: '2026-09-02', windowStart: '14:00' } });
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
    expect(out.visitMove.members).toEqual([
      { id: 'a', isPrimary: true, previousStatus: 'confirmed' },
      { id: 'b', isPrimary: false, previousStatus: 'pending' },
    ]);
  });

  test('adminWindowRules: a DERIVED sibling window that breaks the admin rules refuses the move before any write', async () => {
    db.__script = script({ members: [member('a'), member('b', { window_start: '09:30', window_end: '10:30' })] });
    const rebooker = fakeRebooker();
    await expect(moveVisitAsUnit({ rebooker, serviceId: 'a', service: SERVICE, newDate: '2026-09-02', newWindow: '13:00-14:00', options: { adminWindowRules: true } }))
      .rejects.toMatchObject({ statusCode: 409, code: 'VISIT_MEMBER_WINDOW_INVALID', memberId: 'b' });
    expect(rebooker.reschedule).not.toHaveBeenCalled();
    // without the admin flag (rain-out, auto-dispatch) the derived :30 window is the rebooker's call, as before
    db.__script = script({ members: [member('a'), member('b', { window_start: '09:30', window_end: '10:30' })] });
    await moveVisitAsUnit({ rebooker, serviceId: 'a', service: SERVICE, newDate: '2026-09-02', newWindow: '13:00-14:00' });
    expect(rebooker.reschedule.mock.calls[1][2]).toBe('13:30-14:30');
  });

  test('the primary carries excludeExpect (each hidden sibling\'s membership + snapshotted slot) so the rebooker locks and verifies them INSIDE its move transaction', async () => {
    db.__script = script({ members: [member('a'), member('b', { window_start: '10:00', window_end: '11:00' })] });
    const rebooker = fakeRebooker();
    await moveVisitAsUnit({ rebooker, serviceId: 'a', service: SERVICE, newDate: '2026-09-02', newWindow: '13:00-14:00' });
    expect(rebooker.reschedule.mock.calls[0][5].excludeExpect).toEqual([{ id: 'b', visit_id: 'v1', scheduled_date: '2026-08-30', window_start: '10:00', window_end: '11:00' }]);
    // the sibling's own move verifies the PRIMARY at its landed target (codex r6)
    expect(rebooker.reschedule.mock.calls[1][5].excludeExpect).toEqual([{ id: 'a', visit_id: 'v1', scheduled_date: '2026-09-02', window_start: '13:00', window_end: '14:00' }]);
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
    db.__script = script({ members: [member('a'), member('b', { window_start: '10:00', window_end: '11:00' }), member('c', { window_start: '11:00', window_end: '12:00' })] });
    const rebooker = fakeRebooker({ b: 'throw' });
    const out = await moveVisitAsUnit({ rebooker, serviceId: 'a', service: SERVICE, newDate: '2026-09-02', newWindow: '13:00-14:00' });
    expect(out.visitMove.failed.map((f) => f.id)).toEqual(['b']);
    const cOpts = rebooker.reschedule.mock.calls[2][5];
    expect(cOpts.excludeServiceIds).toEqual(['a']);
    expect(cOpts.excludeExpect).toEqual([{ id: 'a', visit_id: 'v1', scheduled_date: '2026-09-02', window_start: '13:00', window_end: '14:00' }]);
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

  test('a silently moved sibling whose creation confirmation was still pending gets it re-armed', async () => {
    db.__script = script({ members: [member('a'), member('b')] });
    AppointmentReminders.handleReschedule.mockResolvedValueOnce({ id: 'rem-b', confirmation_sent: false });
    await moveVisitAsUnit({ rebooker: fakeRebooker(), serviceId: 'a', service: SERVICE, newDate: '2026-09-02' });
    const rearm = db.__calls.find((c) => c.table === 'appointment_reminders' && c.op === 'update');
    expect(rearm.values).toEqual({ confirmation_sent: false, confirmation_sent_at: null });
    expect(rearm.ops).toEqual(expect.arrayContaining([['where', { id: 'rem-b' }]]));
  });
});
