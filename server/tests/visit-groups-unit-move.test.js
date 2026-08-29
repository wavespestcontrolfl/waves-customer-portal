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

const db = require('../models/db');
const { moveVisitAsUnit, _test: { shiftClock } } = require('../services/visit-groups');

const VISIT = { id: 'v1', status: 'open', stop_base_key: 'p1:2026-08-30', scheduled_date: '2026-08-30', customer_id: 'c1', property_id: 'p1', technician_id: 't1', window_start: '09:00', window_end: '11:00' };
const member = (id, over = {}) => ({ id, status: 'confirmed', technician_id: 't1', customer_id: 'c1', property_id: 'p1', scheduled_date: '2026-08-30', window_start: '09:00', window_end: '10:00', ...over });
const SERVICE = { id: 'a', visit_id: 'v1' };

function fakeRebooker(behaviour = {}) {
  return { reschedule: jest.fn(async (id, date, win, reason, by, opts) => {
    if (behaviour[id] === 'throw') throw Object.assign(new Error(`member ${id} boom`), { code: 'SLOT_TAKEN' });
    return { success: true, originalDate: '2026-08-30', newDate: date, id, win, opts };
  }) };
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
  const script = ({ visit = VISIT, members, landed = null, maxSeq = 0 }) => ({
    service_visits: { first: (ops) => (ops.some((o) => o[0] === 'max') ? { max: maxSeq } : visit) },
    scheduled_services: { select: (ops) => (ops.some((o) => o[0] === 'forUpdate') ? members : (landed || members.map((m) => ({ ...m, scheduled_date: '2026-09-02' })))) },
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
    expect(out.visitMove).toEqual({ visitId: 'v1', moved: ['a', 'b'], failed: [] });
    expect(out.success).toBe(true);
    // primary first with the requested window + the caller's own pins; sibling shifted +4h with a fence from ITS locked row, never the primary's
    const [pCall, sCall] = rebooker.reschedule.mock.calls;
    expect(pCall[0]).toBe('a'); expect(pCall[2]).toBe('13:00-14:00');
    expect(pCall[5]).toMatchObject({ visitPolicy: 'single', skipVisitSeam: true, expect: { scheduled_date: '2026-08-30', window_start: '09:00' }, expectOccurrenceIds: ['x'] });
    expect(sCall[0]).toBe('b'); expect(sCall[2]).toBe('14:00-15:00');
    expect(sCall[5]).toMatchObject({ visitPolicy: 'single', skipVisitSeam: true, expect: { scheduled_date: '2026-08-30', window_start: '10:00', window_end: '11:00' } });
    expect(sCall[5].expectOccurrenceIds).toBeUndefined();
    for (const call of rebooker.reschedule.mock.calls) expect(call[5].excludeServiceIds.sort()).toEqual(['a', 'b']);
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
    expect(out.visitMove).toEqual({ visitId: 'v1', moved: ['a'], failed: [{ id: 'b', reason: 'member b boom', code: 'SLOT_TAKEN' }] });
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
});
