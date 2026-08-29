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
  test('ungrouped row / not open visit / single live member ⇒ null (plain move)', async () => {
    expect(await moveVisitAsUnit({ rebooker: fakeRebooker(), serviceId: 'a', service: { id: 'a', visit_id: null }, newDate: '2026-09-02' })).toBe(null);
    db.__script = { service_visits: { first: () => ({ ...VISIT, status: 'closing' }) } };
    expect(await moveVisitAsUnit({ rebooker: fakeRebooker(), serviceId: 'a', service: SERVICE, newDate: '2026-09-02' })).toBe(null);
    db.__script = { service_visits: { first: () => VISIT }, scheduled_services: { select: () => [member('a')] } };
    expect(await moveVisitAsUnit({ rebooker: fakeRebooker(), serviceId: 'a', service: SERVICE, newDate: '2026-09-02' })).toBe(null);
  });

  test('date + window move: parent retargeted (new stop key + seq, shifted union), members moved with shifted windows, seam deferred, occupancy excludes the members', async () => {
    db.__script = {
      service_visits: { first: (ops) => (ops.some((o) => o[0] === 'max') ? { max: 0 } : VISIT) },
      scheduled_services: { select: () => [member('a'), member('b', { window_start: '10:00', window_end: '11:00' })] },
    };
    const rebooker = fakeRebooker();
    const out = await moveVisitAsUnit({ rebooker, serviceId: 'a', service: SERVICE, newDate: '2026-09-02', newWindow: '13:00-14:00', reason: 'rain', initiatedBy: 'admin', options: { allowLive: false } });
    expect(out.visitMove).toEqual({ visitId: 'v1', moved: ['a', 'b'], failed: [] });
    expect(out.success).toBe(true);
    // parent retarget under the OLD stop lock, then the NEW key locked too
    expect(db.__rawCalls.map((a) => a[1][1])).toEqual(expect.arrayContaining(['p1:2026-08-30', 'p1:2026-09-02']));
    const patch = db.__calls.find((c) => c.table === 'service_visits' && c.op === 'update');
    expect(patch.values).toMatchObject({ scheduled_date: '2026-09-02', window_start: '13:00', window_end: '15:00', stop_base_key: 'p1:2026-09-02', stop_seq: 1 });
    // primary first with the requested window, sibling shifted by the same +4h delta
    expect(rebooker.reschedule.mock.calls[0][0]).toBe('a');
    expect(rebooker.reschedule.mock.calls[0][2]).toBe('13:00-14:00');
    expect(rebooker.reschedule.mock.calls[1][0]).toBe('b');
    expect(rebooker.reschedule.mock.calls[1][2]).toBe('14:00-15:00');
    for (const call of rebooker.reschedule.mock.calls) {
      expect(call[5]).toMatchObject({ visitPolicy: 'single', skipVisitSeam: true, allowLive: false });
      expect(call[5].excludeServiceIds.sort()).toEqual(['a', 'b']);
    }
  });

  test('date-only move keeps every window and the parent window union', async () => {
    db.__script = { service_visits: { first: (ops) => (ops.some((o) => o[0] === 'max') ? { max: 2 } : VISIT) }, scheduled_services: { select: () => [member('a'), member('b')] } };
    const rebooker = fakeRebooker();
    await moveVisitAsUnit({ rebooker, serviceId: 'a', service: SERVICE, newDate: '2026-09-02' });
    const patch = db.__calls.find((c) => c.table === 'service_visits' && c.op === 'update');
    expect(patch.values).toEqual({ scheduled_date: '2026-09-02', stop_base_key: 'p1:2026-09-02', stop_seq: 3 });
    expect(rebooker.reschedule.mock.calls.every((c) => c[2] === null)).toBe(true);
  });

  test('one immovable member refuses the whole move before anything changes', async () => {
    db.__script = { service_visits: { first: () => VISIT }, scheduled_services: { select: () => [member('a'), member('b', { status: 'on_site' })] } };
    const rebooker = fakeRebooker();
    await expect(moveVisitAsUnit({ rebooker, serviceId: 'a', service: SERVICE, newDate: '2026-09-02' })).rejects.toMatchObject({ statusCode: 409, code: 'VISIT_MEMBER_NOT_MOVABLE', memberId: 'b' });
    expect(rebooker.reschedule).not.toHaveBeenCalled();
    expect(db.__calls.some((c) => c.table === 'service_visits' && c.op === 'update')).toBe(false);
  });

  test('a sibling failing mid-way is reported (visitMove.failed + warning); the primary failing rethrows', async () => {
    db.__script = { service_visits: { first: (ops) => (ops.some((o) => o[0] === 'max') ? { max: 0 } : VISIT) }, scheduled_services: { select: () => [member('a'), member('b')] } };
    const out = await moveVisitAsUnit({ rebooker: fakeRebooker({ b: 'throw' }), serviceId: 'a', service: SERVICE, newDate: '2026-09-02' });
    expect(out.visitMove).toEqual({ visitId: 'v1', moved: ['a'], failed: [{ id: 'b', reason: 'member b boom', code: 'SLOT_TAKEN' }] });
    expect(out.warnings[0]).toMatch(/1 grouped service\(s\) did not move/);
    await expect(moveVisitAsUnit({ rebooker: fakeRebooker({ a: 'throw' }), serviceId: 'a', service: SERVICE, newDate: '2026-09-02' })).rejects.toThrow('member a boom');
  });
});
