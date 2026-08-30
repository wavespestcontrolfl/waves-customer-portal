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
      orderBy() { chain._ops.push(['orderBy', ...arguments]); return chain; },
      max() { chain._ops.push(['max', ...arguments]); return chain; },
      first(...cols) { log.push({ table, op: 'first', ops: chain._ops, cols }); return Promise.resolve(script[table] && script[table].first ? script[table].first(chain._ops, cols) : null); },
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
jest.mock('../services/scheduling/occupancy', () => ({ findConflictingVisits: jest.fn().mockResolvedValue([]) }));
jest.mock('../services/dispatch-assignment', () => ({ assignDispatchJob: jest.fn().mockResolvedValue({ changed: true }) }));

const db = require('../models/db');
const AppointmentReminders = require('../services/appointment-reminders');
const { assignDispatchJob } = require('../services/dispatch-assignment');
const { moveVisitAsUnit, _test: { shiftClock, expectMatchesRow } } = require('../services/visit-groups');

const VISIT = { id: 'v1', status: 'open', stop_base_key: 'p1:2026-08-30', scheduled_date: '2026-08-30', customer_id: 'c1', property_id: 'p1', technician_id: 't1', window_start: '09:00', window_end: '11:00' };
const member = (id, over = {}) => ({ id, status: 'confirmed', technician_id: 't1', customer_id: 'c1', property_id: 'p1', scheduled_date: '2026-08-30', window_start: '09:00', window_end: '10:00', ...over });
const SERVICE = { id: 'a', visit_id: 'v1' };

function fakeRebooker(behaviour = {}) {
  const impl = async (id, date, win, reason, by, opts) => {
    if (behaviour[id] === 'throw') throw Object.assign(new Error(`member ${id} boom`), { code: 'SLOT_TAKEN' });
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
    scheduled_services: { select: (ops) => (ops.some((o) => o[0] === 'orderBy') ? (landed || members.map((m) => ({ ...m, scheduled_date: '2026-09-02' }))) // retarget read (FOR UPDATE + ORDER BY)
        : ops.some((o) => o[0] === 'forUpdate') ? members
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
    // each move hides only the OTHER participating rows from its probes (codex r6)
    expect(rebooker.reschedule.mock.calls[0][5].excludeServiceIds).toEqual(['b']);
    expect(rebooker.reschedule.mock.calls[1][5].excludeServiceIds).toEqual(['a']);
    // every moved SIBLING gets its reminder row synced (notice suppressed); the primary's is the caller's job
    expect(AppointmentReminders.handleReschedule).toHaveBeenCalledTimes(1);
    expect(AppointmentReminders.handleReschedule).toHaveBeenCalledWith('b', '2026-09-02T14:00', { sendNotification: false, keepPendingConfirmation: true, expectSchedule: { date: '2026-09-02', windowStart: '14:00' } });
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
    expect(rebooker.reschedule.mock.calls[0][5].expect).toEqual({ scheduled_date: '2026-08-30', window_start: '09:00', window_end: '10:00', visit_id: 'v1', technician_id: 't1', status: 'confirmed' });
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
    expect(AppointmentReminders.handleReschedule).toHaveBeenCalledWith('b', '2026-09-02T14:00', { sendNotification: false, keepPendingConfirmation: true, expectSchedule: { date: '2026-09-02', windowStart: '14:00' } });
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
    expect(rebooker.reschedule.mock.calls[0][5].excludeExpect).toEqual([{ id: 'b', visit_id: 'v1', scheduled_date: '2026-08-30', window_start: '10:00', window_end: '11:00', technician_id: 't1', status: 'confirmed' }]);
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

  test('a silently moved sibling keeps a still-pending creation confirmation pending (keepPendingConfirmation) — no supersede, no re-arm write', async () => {
    db.__script = script({ members: [member('a'), member('b')] });
    AppointmentReminders.handleReschedule.mockResolvedValueOnce({ id: 'rem-b', confirmation_sent: false });
    await moveVisitAsUnit({ rebooker: fakeRebooker(), serviceId: 'a', service: SERVICE, newDate: '2026-09-02' });
    expect(AppointmentReminders.handleReschedule.mock.calls[0][2]).toMatchObject({ sendNotification: false, keepPendingConfirmation: true });
    expect(db.__calls.some((c) => c.table === 'appointment_reminders' && c.op === 'update')).toBe(false);
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
    expect(rebooker.reschedule.mock.calls[1][5].excludeExpect).toEqual([{ id: 'a', visit_id: 'v1', scheduled_date: '2026-09-02', window_start: '09:00', window_end: '10:00' }]);
    // start-only landing: the end is the rebooker's derivation — left out of the contract, not asserted null
    db.__script = script({ members: [member('a', { window_start: null, window_end: null }), member('b', { window_start: '10:00', window_end: '11:00' })] });
    const rb2 = fakeRebooker();
    await moveVisitAsUnit({ rebooker: rb2, serviceId: 'a', service: SERVICE, newDate: '2026-09-02', newWindow: { start: '13:00', end: null } });
    expect(rb2.reschedule.mock.calls[1][5].excludeExpect[0]).toEqual({ id: 'a', visit_id: 'v1', scheduled_date: '2026-09-02', window_start: '13:00' });
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
    // landed on the date but a different window / another tech / another visit ⇒ not landed either
    for (const over of [{ window_start: '11:00:00' }, { technician_id: 't2' }, { visit_id: 'v2' }]) {
      db.__calls.length = 0;
      db.__script = script({ members: [member('a'), member('b')], landedRows: { a: landedRow(over) } });
      await expect(moveVisitAsUnit({ rebooker: fakeRebooker({ a: 'throw' }), serviceId: 'a', service: SERVICE, newDate: '2026-09-02', options: { technicianId: 't1' } })).rejects.toThrow('member a boom');
    }
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
    // the primary keeps the caller's technicianId (the caller's own contract); siblings get NO technicianId
    expect(rebooker.reschedule.mock.calls[0][5].technicianId).toBe('t9');
    expect(rebooker.reschedule.mock.calls[1][5]).not.toHaveProperty('technicianId');
    expect(rebooker.reschedule.mock.calls[2][5]).not.toHaveProperty('technicianId');
    // b (t1 → t9) re-pointed through the canonical writer on a transaction; c already on t9 is not touched
    expect(assignDispatchJob).toHaveBeenCalledTimes(1);
    // skipVisitSeam: the per-row seam must not run on a half-reassigned visit (codex r16 P1) — step 4 runs it per member after the retarget
    // expectTechnicianId = the PLANNED pre-move tech (local audit): a newer operator reassignment is never overwritten
    expect(assignDispatchJob).toHaveBeenCalledWith({ jobId: 'b', technicianId: 't9', actorId: null, emit: true, trx: expect.any(Function), skipVisitSeam: true, expectTechnicianId: 't1' });
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
      .mockRejectedValueOnce(Object.assign(new Error('deadlock'), { code: '40P01' }))
      .mockResolvedValueOnce({ changed: true });
    let out = await moveVisitAsUnit({ rebooker: fakeRebooker(), serviceId: 'a', service: SERVICE, newDate: '2026-09-02', options: { technicianId: 't9' } });
    expect(out.visitMove.failed).toEqual([]);
    expect(assignDispatchJob).toHaveBeenCalledTimes(2);
    jest.clearAllMocks(); db.__calls.length = 0;
    // b stays on t1 (its re-point failed): the retarget sees it diverged from the planned tech too
    db.__script = script({ members: [member('a'), member('b')], landed: [...onT9(['a']), { id: 'b', scheduled_date: '2026-09-02', window_start: '09:00', window_end: '10:00', technician_id: 't1' }] });
    assignDispatchJob.mockRejectedValueOnce(Object.assign(new Error('Technician is inactive'), { statusCode: 400 }));
    out = await moveVisitAsUnit({ rebooker: fakeRebooker(), serviceId: 'a', service: SERVICE, newDate: '2026-09-02', options: { technicianId: 't9' } });
    expect(out.visitMove.moved).toEqual(['a', 'b']);
    expect(out.visitMove.failed).toEqual([{ id: 'b', reason: 'moved but its technician reassignment failed: Technician is inactive', code: 'ASSIGNMENT_FAILED' }]);
    expect(out.warnings.some((w) => /did not move with this stop/.test(w))).toBe(true);
    // a concurrent operator reassignment (ASSIGNMENT_STALE) is a failed member, not retried, not overwritten
    jest.clearAllMocks(); db.__calls.length = 0;
    db.__script = script({ members: [member('a'), member('b')], landed: [...onT9(['a']), { id: 'b', scheduled_date: '2026-09-02', window_start: '09:00', window_end: '10:00', technician_id: 't1' }] });
    assignDispatchJob.mockRejectedValueOnce(Object.assign(new Error('Job was reassigned concurrently - the planned technician is stale'), { statusCode: 409, code: 'ASSIGNMENT_STALE' }));
    out = await moveVisitAsUnit({ rebooker: fakeRebooker(), serviceId: 'a', service: SERVICE, newDate: '2026-09-02', options: { technicianId: 't9' } });
    expect(assignDispatchJob).toHaveBeenCalledTimes(1);
    expect(out.visitMove.failed).toEqual([expect.objectContaining({ id: 'b', code: 'ASSIGNMENT_STALE' })]);
    // unassign (null) goes through the same writer
    jest.clearAllMocks(); db.__script = script({ members: [member('a'), member('b')] });
    await moveVisitAsUnit({ rebooker: fakeRebooker(), serviceId: 'a', service: SERVICE, newDate: '2026-09-02', options: { technicianId: null } });
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
    // a visit that is merely not open (closing/dissolved) is the mover's own null path, not the frozen refusal
    db.__script = script({ visit: { ...VISIT, status: 'closing' }, members: [] });
    expect(await moveVisitAsUnit({ rebooker: fakeRebooker(), serviceId: 'a', service: SERVICE, newDate: '2026-09-02' })).toBe(null);
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
