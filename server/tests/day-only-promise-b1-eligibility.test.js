// GATE_DAY_ONLY_PROMISE part B1 (owner 2026-11-05 "D2 a", 2026-11-06 "office"): who may be promised only the DAY.
// dayOnlyEligibility / dayOnlySendDecision / loadTimeDisplay in services/time-promise.js, and isCustomerPickedVisit in
// services/auto-dispatch/eligibility.js, run for real over a knex-shaped fake. Synthetic ids only; nothing is sent.
const timePromise = require('../services/time-promise');
const { isCustomerPickedVisit, CUSTOMER_INITIATORS } = require('../services/auto-dispatch/eligibility');

const {
  OFFICE_BOOKING_SOURCES, CUSTOMER_OR_UNKNOWN_SOURCES, dayOnlyEligibility, dayOnlySendDecision, loadTimeDisplay,
} = timePromise;

const NOW = new Date('2026-11-10T14:00:00Z');
const FAR = new Date('2026-11-15T14:00:00Z'); // 5 days out
const NEAR = new Date('2026-11-11T08:00:00Z'); // 18 h out: inside the 24.25 h cutoff
const SLOT = Date.parse('2026-11-15T14:00:00Z');

const svc = (id, over = {}) => ({
  id, visit_id: null, status: 'pending', scheduled_date: '2026-11-15', is_recurring: false, recurring_parent_id: null,
  date_exception: null, date_exception_source: null, date_exception_at: null, customer_asked_time: null, ...over,
});
const child = (id, over = {}) => svc(id, { is_recurring: true, recurring_parent_id: 'parent-1', ...over });

/** A knex-shaped fake over rows per table. `calls` counts how many reads each table got. */
function fakeConn({ services = [], reminders = [], moves = {}, messages = [], emails = [], failOn = null } = {}) {
  const calls = {};
  const conn = (table) => {
    calls[table] = (calls[table] || 0) + 1;
    const ins = [];
    const notIns = [];
    const eq = {};
    const chain = {};
    for (const m of ['join', 'leftJoin', 'whereRaw', 'whereBetween', 'whereNull', 'whereNotNull', 'distinct', 'orWhere', 'orderBy']) {
      chain[m] = () => chain;
    }
    chain.where = (col, val) => { if (typeof col === 'string') eq[col] = val; return chain; };
    chain.whereIn = (col, values) => { ins.push([col, (Array.isArray(values) ? values : []).map(String)]); return chain; };
    chain.whereNotIn = (col, values) => { notIns.push([col, values.map(String)]); return chain; };
    chain.select = async () => {
      if (failOn === table) throw new Error(`read failed: ${table}`);
      if (table === 'messaging_audit_log as a') return messages;
      if (table === 'customer_interactions as ci') return emails;
      if (table === 'reschedule_log') return moves[eq.scheduled_service_id] || [];
      const pick = (rows) => rows.filter((r) => ins.every(([col, vals]) => r[col] != null && vals.includes(String(r[col])))
        && notIns.every(([col, vals]) => !vals.includes(String(r[col]))));
      if (table === 'scheduled_services') return pick(services);
      if (table === 'appointment_reminders') return pick(reminders).filter((r) => r.cancelled !== true);
      return [];
    };
    return chain;
  };
  conn.raw = (sql, bindings) => ({ sql, bindings });
  conn.isTransaction = true;
  conn.calls = calls;
  return conn;
}

const office = (id, source = 'admin_manual') => ({ scheduled_service_id: id, source, cancelled: false, created_at: '2026-11-09T12:00:00Z' });
const verdict = async (conn, ids = ['s1']) => Object.fromEntries(await dayOnlyEligibility(conn, ids, NOW));

describe('the source lists', () => {
  test('are frozen, disjoint, and the office list is the spec list', () => {
    expect(Object.isFrozen(OFFICE_BOOKING_SOURCES)).toBe(true);
    expect(Object.isFrozen(CUSTOMER_OR_UNKNOWN_SOURCES)).toBe(true);
    expect(OFFICE_BOOKING_SOURCES).toEqual(['admin_manual', 'admin_ib', 'estimate_followup', 'health_alert_comp', 'ops_manual', 'admin']);
    expect(OFFICE_BOOKING_SOURCES.filter((s) => CUSTOMER_OR_UNKNOWN_SOURCES.includes(s))).toEqual([]);
  });
});

describe('dayOnlyEligibility: a first or one-time visit', () => {
  test.each(OFFICE_BOOKING_SOURCES)('office source %s: eligible', async (source) => {
    const conn = fakeConn({ services: [svc('s1')], reminders: [office('s1', source)] });
    expect(await verdict(conn)).toEqual({ s1: { eligible: true, level: 'none' } });
  });

  test.each([...CUSTOMER_OR_UNKNOWN_SOURCES, 'something_new', '', null])('source %p: not eligible (the customer picked, or the origin is unknown)', async (source) => {
    const conn = fakeConn({ services: [svc('s1')], reminders: [office('s1', source)] });
    expect((await verdict(conn)).s1.eligible).toBe(false);
  });

  test('no reminder row at all: not eligible', async () => {
    expect((await verdict(fakeConn({ services: [svc('s1')] }))).s1.eligible).toBe(false);
  });

  test('a cancelled reminder row does not count', async () => {
    const conn = fakeConn({ services: [svc('s1')], reminders: [{ ...office('s1'), cancelled: true }] });
    expect((await verdict(conn)).s1.eligible).toBe(false);
  });

  test('a row that is not found, or already over, is not eligible', async () => {
    expect((await verdict(fakeConn(), ['ghost'])).ghost.eligible).toBe(false);
    const done = fakeConn({ services: [svc('s1', { status: 'cancelled' })], reminders: [office('s1')] });
    expect((await verdict(done)).s1.eligible).toBe(false);
  });
});

describe('dayOnlyEligibility: a first or one-time visit also fails once the customer picked its slot', () => {
  const customerMove = { s1: [{ created_at: '2026-11-08T10:00:00Z', new_date: '2026-11-15', initiated_by: 'customer_self_serve' }] };
  const staffMove = { s1: [{ created_at: '2026-11-08T10:00:00Z', new_date: '2026-11-15', initiated_by: 'admin' }] };

  test('an office booking the customer then rescheduled themselves: not eligible (the hour is now theirs)', async () => {
    const conn = fakeConn({ services: [svc('s1')], reminders: [office('s1')], moves: customerMove });
    expect((await verdict(conn)).s1.eligible).toBe(false);
  });

  test('an office booking that only staff moved: eligible', async () => {
    const conn = fakeConn({ services: [svc('s1')], reminders: [office('s1')], moves: staffMove });
    expect((await verdict(conn)).s1.eligible).toBe(true);
  });

  test('an office booking with a customer date exception newer than the staff move: not eligible', async () => {
    const services = [svc('s1', { date_exception: true, date_exception_source: 'customer_portal', date_exception_at: '2026-11-09T10:00:00Z' })];
    const conn = fakeConn({ services, reminders: [office('s1')], moves: staffMove });
    expect((await verdict(conn)).s1.eligible).toBe(false);
  });

  test('the move history unreadable: not eligible (fail closed)', async () => {
    const conn = fakeConn({ services: [svc('s1')], reminders: [office('s1')], failOn: 'reschedule_log' });
    expect((await verdict(conn)).s1.eligible).toBe(false);
  });

  test('a customer source is rejected on the source alone: no move-history read at all', async () => {
    const conn = fakeConn({ services: [svc('s1')], reminders: [office('s1', 'booking_new')], moves: staffMove });
    expect((await verdict(conn)).s1.eligible).toBe(false);
    expect(conn.calls.reschedule_log).toBeUndefined();
  });

  test('customer_asked_time false (written with the move that placed the slot) still skips both the source rule and the customer-pick rule', async () => {
    // after_intent false: the newest slot change is not newer than the intent, so the intent holds (day-only-promise-b2-intent-stale.test.js
    // pins the stale cases).
    const own = { s1: customerMove.s1.map((r) => ({ ...r, after_intent: false })) };
    const conn = fakeConn({ services: [svc('s1', { customer_asked_time: false, customer_asked_time_at: '2026-11-09T12:00:00Z' })], reminders: [office('s1', 'booking_new')], moves: own });
    expect((await verdict(conn)).s1.eligible).toBe(true);
    expect(conn.calls.reschedule_log).toBe(1);
  });

  test('stop-wide: one member the customer rescheduled makes the whole stop ineligible', async () => {
    const services = [svc('s1', { visit_id: 'v1' }), svc('s2', { visit_id: 'v1' })];
    const moves = { s2: [{ created_at: '2026-11-08T10:00:00Z', new_date: '2026-11-15', initiated_by: 'customer_sms' }] };
    const conn = fakeConn({ services, reminders: [office('s1'), office('s2')], moves });
    expect((await verdict(conn, ['s1', 's2'])).s1.eligible).toBe(false);
  });
});

describe('dayOnlyEligibility: a recurring child is judged by who placed its slot, never by its source', () => {
  test('never moved: eligible (a system-placed recurring visit), even with an unknown source', async () => {
    const conn = fakeConn({ services: [child('s1')], reminders: [office('s1', 'cron_selfheal')] });
    expect(await verdict(conn)).toEqual({ s1: { eligible: true, level: 'none' } });
  });

  test('the newest slot-changing move was made by the customer: not eligible', async () => {
    const moves = { s1: [{ created_at: '2026-11-08T10:00:00Z', new_date: '2026-11-15', initiated_by: 'customer_self_serve' }] };
    expect((await verdict(fakeConn({ services: [child('s1')], moves }))).s1.eligible).toBe(false);
  });

  test.each(['auto_dispatch', 'day_replan', 'system', 'admin'])('the newest move was made by %s: eligible', async (by) => {
    const moves = { s1: [{ created_at: '2026-11-08T10:00:00Z', new_date: '2026-11-15', initiated_by: by }] };
    expect((await verdict(fakeConn({ services: [child('s1')], moves }))).s1.eligible).toBe(true);
  });

  test('a customer date exception newer than the newest move: not eligible; an office one: eligible', async () => {
    const moves = { s1: [{ created_at: '2026-11-08T10:00:00Z', new_date: '2026-11-15', initiated_by: 'auto_dispatch' }] };
    const exception = (source) => child('s1', { date_exception: true, date_exception_source: source, date_exception_at: '2026-11-09T10:00:00Z' });
    expect((await verdict(fakeConn({ services: [exception('customer_portal')], moves }))).s1.eligible).toBe(false);
    expect((await verdict(fakeConn({ services: [exception('admin')], moves }))).s1.eligible).toBe(true);
  });

  test('a read error on the move history counts as picked (fail closed)', async () => {
    const conn = fakeConn({ services: [child('s1')], failOn: 'reschedule_log' });
    expect((await verdict(conn)).s1.eligible).toBe(false);
  });
});

describe('isCustomerPickedVisit', () => {
  const row = { id: 's1', scheduled_date: '2026-11-15' };
  const dbWith = (rows) => () => ({
    where() { return this; }, whereNotNull() { return this; }, whereRaw() { return this; },
    select: async () => rows,
  });

  test('exports the customer initiator list on its own', () => {
    expect(CUSTOMER_INITIATORS).toBeInstanceOf(Set);
    expect(CUSTOMER_INITIATORS.has('customer_self_serve')).toBe(true);
    expect(CUSTOMER_INITIATORS.has('auto_dispatch')).toBe(false);
  });

  test('only customer sources count (staff are a person but not a customer)', async () => {
    const at = (by, date = '2026-11-15') => dbWith([{ created_at: '2026-11-08T10:00:00Z', new_date: date, initiated_by: by }]);
    expect((await isCustomerPickedVisit(row, at('customer_sms'))).picked).toBe(true);
    expect((await isCustomerPickedVisit(row, at('sms_offer_ai'))).picked).toBe(true);
    expect((await isCustomerPickedVisit(row, at('admin'))).picked).toBe(false);
    expect((await isCustomerPickedVisit(row, at('auto_dispatch'))).picked).toBe(false);
    // A customer move to a date the visit no longer holds is not the visit's current slot.
    expect((await isCustomerPickedVisit(row, at('customer', '2026-11-20'))).picked).toBe(false);
  });

  test('no history: not picked; an error: picked and degraded', async () => {
    expect(await isCustomerPickedVisit(row, dbWith([]))).toEqual({ picked: false });
    const broken = () => ({ where() { return this; }, whereNotNull() { return this; }, whereRaw() { return this; }, select: async () => { throw new Error('down'); } });
    expect(await isCustomerPickedVisit(row, broken)).toMatchObject({ picked: true, degraded: true });
  });
});

describe('dayOnlyEligibility: customer_asked_time is the explicit intent for the current slot', () => {
  test('true: never eligible, whatever the source or the move history', async () => {
    const asked = fakeConn({ services: [svc('s1', { customer_asked_time: true })], reminders: [office('s1')] });
    expect((await verdict(asked)).s1.eligible).toBe(false);
    const askedChild = fakeConn({ services: [child('s1', { customer_asked_time: true })] });
    expect((await verdict(askedChild)).s1.eligible).toBe(false);
  });

  test('false: eligible without the source rule and without the customer-pick rule', async () => {
    const onlineSource = fakeConn({ services: [svc('s1', { customer_asked_time: false })], reminders: [office('s1', 'booking_new')] });
    expect((await verdict(onlineSource)).s1.eligible).toBe(true);
    const moves = { s1: [{ created_at: '2026-11-08T10:00:00Z', new_date: '2026-11-15', initiated_by: 'customer_self_serve', after_intent: false }] };
    const pickedChild = fakeConn({ services: [child('s1', { customer_asked_time: false, customer_asked_time_at: '2026-11-08T10:00:00Z' })], moves });
    expect((await verdict(pickedChild)).s1.eligible).toBe(true);
    // The move history is read once, only to prove the intent is not stale; the pick check is not asked.
    expect(pickedChild.calls.reschedule_log).toBe(1);
  });

  test('false still obeys the level rule: an hour already told is never eligible', async () => {
    const hour = { id: 1, appointment_id: 's1', purpose: 'appointment_confirmation', sent_at: '2026-11-09T14:00:00Z', metadata: { rendered_slot_ms: SLOT } };
    const conn = fakeConn({ services: [svc('s1', { customer_asked_time: false })], reminders: [office('s1')], messages: [hour] });
    expect(await verdict(conn)).toEqual({ s1: { eligible: false, level: 'hour' } });
  });

  test('NULL infers (office source: eligible; customer source: not)', async () => {
    expect((await verdict(fakeConn({ services: [svc('s1')], reminders: [office('s1')] }))).s1.eligible).toBe(true);
    expect((await verdict(fakeConn({ services: [svc('s1')], reminders: [office('s1', 'booking_new')] }))).s1.eligible).toBe(false);
  });

  test('stop-wide: one member that asked for its time means none of the stop is eligible', async () => {
    const services = [svc('s1', { visit_id: 'v1' }), svc('s2', { visit_id: 'v1', customer_asked_time: true })];
    const conn = fakeConn({ services, reminders: [office('s1'), office('s2')] });
    expect((await verdict(conn)).s1.eligible).toBe(false);
  });
});

describe('dayOnlyEligibility: the level rule and stop-wide judging', () => {
  test('a latest promise that is an hour is never eligible; a day promise is', async () => {
    const hour = { id: 1, appointment_id: 's1', purpose: 'appointment_confirmation', sent_at: '2026-11-09T14:00:00Z', metadata: { rendered_slot_ms: SLOT } };
    const day = { id: 2, appointment_id: 's1', purpose: 'appointment_confirmation', sent_at: '2026-11-09T14:00:00Z', metadata: { promise_level: 'day' } };
    const base = { services: [svc('s1')], reminders: [office('s1')] };
    expect(await verdict(fakeConn({ ...base, messages: [hour] }))).toEqual({ s1: { eligible: false, level: 'hour' } });
    expect(await verdict(fakeConn({ ...base, messages: [day] }))).toEqual({ s1: { eligible: true, level: 'day' } });
  });

  test('stop-wide mix: one customer-source member makes the whole stop ineligible; all office makes it eligible', async () => {
    const services = [svc('s1', { visit_id: 'v1' }), svc('s2', { visit_id: 'v1' })];
    const mixed = fakeConn({ services, reminders: [office('s1'), office('s2', 'booking_new')] });
    expect((await verdict(mixed, ['s1', 's2']))).toEqual({ s1: { eligible: false, level: 'none' }, s2: { eligible: false, level: 'none' } });
    const allOffice = fakeConn({ services, reminders: [office('s1'), office('s2', 'admin_ib')] });
    expect(await verdict(allOffice, ['s1', 's2'])).toEqual({ s1: { eligible: true, level: 'none' }, s2: { eligible: true, level: 'none' } });
  });

  test('a cancelled member of the stop is not part of the stop the customer hears about', async () => {
    const services = [svc('s1', { visit_id: 'v1' }), svc('s2', { visit_id: 'v1', status: 'cancelled' })];
    const conn = fakeConn({ services, reminders: [office('s1'), office('s2', 'booking_new')] });
    expect((await verdict(conn)).s1.eligible).toBe(true);
  });

  test('one bulk read per fact, however many visits', async () => {
    const services = [svc('s1'), svc('s2'), svc('s3')];
    const conn = fakeConn({ services, reminders: [office('s1'), office('s2'), office('s3')] });
    await verdict(conn, ['s1', 's2', 's3']);
    expect(conn.calls.appointment_reminders).toBe(1);
    expect(conn.calls['messaging_audit_log as a']).toBe(1);
    expect(conn.calls.scheduled_services).toBeLessThanOrEqual(3); // stop members, own rows (+ mates only when grouped)
  });

  test.each(['scheduled_services', 'appointment_reminders', 'messaging_audit_log as a'])('a failed read of %s: nobody is eligible and the level is hour (fail closed)', async (table) => {
    const conn = fakeConn({ services: [svc('s1')], reminders: [office('s1')], failOn: table });
    // failed: true tells a read failure from a real "customer was told an hour" verdict (same eligible/level).
    expect(await verdict(conn)).toEqual({ s1: { eligible: false, level: 'hour', failed: true } });
  });

  test('no ids: empty map and no read', async () => {
    const conn = fakeConn();
    expect((await dayOnlyEligibility(conn, [], NOW)).size).toBe(0);
    expect(Object.keys(conn.calls)).toEqual([]);
  });
});

describe('dayOnlySendDecision', () => {
  const OLD = process.env.GATE_DAY_ONLY_PROMISE;
  beforeEach(() => { process.env.GATE_DAY_ONLY_PROMISE = 'true'; });
  afterEach(() => { if (OLD === undefined) delete process.env.GATE_DAY_ONLY_PROMISE; else process.env.GATE_DAY_ONLY_PROMISE = OLD; });
  const world = () => fakeConn({ services: [svc('s1')], reminders: [office('s1')] });
  const decide = (conn, over = {}) => dayOnlySendDecision(conn, { id: 's1', startAt: FAR, now: NOW, reminder24hEnabled: true, ...over });

  test('gate on, an office first visit 5 days out: day only', async () => {
    expect(await decide(world())).toEqual({ dayOnly: true, level: 'none', eligible: true });
  });

  test('gate off: false, and nothing is read', async () => {
    delete process.env.GATE_DAY_ONLY_PROMISE;
    const conn = world();
    expect((await decide(conn)).dayOnly).toBe(false);
    expect(Object.keys(conn.calls)).toEqual([]);
  });

  test('inside the 24.25 h cutoff: false, nothing read', async () => {
    const conn = world();
    expect((await decide(conn, { startAt: NEAR })).dayOnly).toBe(false);
    expect(Object.keys(conn.calls)).toEqual([]);
  });

  test('the customer turned the 24-hour reminder off: false, nothing read', async () => {
    const conn = world();
    expect((await decide(conn, { reminder24hEnabled: false })).dayOnly).toBe(false);
    expect(Object.keys(conn.calls)).toEqual([]);
  });

  test('a customer-picked visit, an hour already told, or a read failure: false', async () => {
    const picked = fakeConn({ services: [svc('s1')], reminders: [office('s1', 'booking_new')] });
    expect((await decide(picked)).dayOnly).toBe(false);
    const hour = { id: 1, appointment_id: 's1', purpose: 'appointment_confirmation', sent_at: '2026-11-09T14:00:00Z', metadata: { rendered_slot_ms: SLOT } };
    expect((await decide(fakeConn({ services: [svc('s1')], reminders: [office('s1')], messages: [hour] }))).dayOnly).toBe(false);
    expect((await decide(fakeConn({ services: [svc('s1')], reminders: [office('s1')], failOn: 'scheduled_services' }))).dayOnly).toBe(false);
  });

  test('recurring child 3 days out: day only; a customer-picked child: not', async () => {
    const free = fakeConn({ services: [child('s1')], reminders: [office('s1', 'recurring_auto_extend')] });
    expect((await decide(free, { startAt: new Date('2026-11-13T14:00:00Z') })).dayOnly).toBe(true);
    const moves = { s1: [{ created_at: '2026-11-08T10:00:00Z', new_date: '2026-11-15', initiated_by: 'customer_portal' }] };
    const picked = fakeConn({ services: [child('s1')], moves });
    expect((await decide(picked)).dayOnly).toBe(false);
  });

  test('a grouped stop: one ineligible member means window copy for the stop', async () => {
    const services = [svc('s1', { visit_id: 'v1' }), svc('s2', { visit_id: 'v1' })];
    const mixed = fakeConn({ services, reminders: [office('s1'), office('s2', 'booking_new')] });
    expect((await decide(mixed)).dayOnly).toBe(false);
    expect((await decide(mixed, { ids: ['s1', 's2'] })).dayOnly).toBe(false);
    const all = fakeConn({ services, reminders: [office('s1'), office('s2')] });
    expect((await decide(all, { ids: ['s1', 's2'] })).dayOnly).toBe(true);
  });

  test('no id: false', async () => {
    expect((await dayOnlySendDecision(world(), { startAt: FAR, now: NOW })).dayOnly).toBe(false);
  });
});

describe('loadTimeDisplay', () => {
  const OLD = process.env.GATE_DAY_ONLY_PROMISE;
  afterEach(() => { if (OLD === undefined) delete process.env.GATE_DAY_ONLY_PROMISE; else process.env.GATE_DAY_ONLY_PROMISE = OLD; });
  const row = (id, date, windowStart = '09:00:00') => ({ id, scheduled_date: date, window_start: windowStart });

  test('gate off: showHour true for every row and NO database read', async () => {
    delete process.env.GATE_DAY_ONLY_PROMISE;
    const conn = fakeConn();
    const out = await loadTimeDisplay(conn, [row('s1', '2026-11-20'), row('s2', '2026-11-21')], NOW);
    expect([...out.values()].every((v) => v.showHour === true)).toBe(true);
    expect(out.size).toBe(2);
    expect(Object.keys(conn.calls)).toEqual([]);
  });

  describe('gate on', () => {
    beforeEach(() => { process.env.GATE_DAY_ONLY_PROMISE = 'true'; });

    test('an eligible visit far out: the day only', async () => {
      const conn = fakeConn({ services: [svc('s1')], reminders: [office('s1')] });
      const out = await loadTimeDisplay(conn, [row('s1', '2026-11-20')], NOW);
      expect(out.get('s1')).toEqual({ showHour: false, level: 'none', eligible: true });
    });

    test('an eligible visit inside the cutoff: the hour', async () => {
      const conn = fakeConn({ services: [svc('s1')], reminders: [office('s1')] });
      const out = await loadTimeDisplay(conn, [row('s1', '2026-11-11', '08:00:00')], NOW); // 18 h out (ET 08:00 = 13:00Z)
      expect(out.get('s1')).toMatchObject({ showHour: true, eligible: true });
    });

    test('an ineligible visit: the hour', async () => {
      const conn = fakeConn({ services: [svc('s1')], reminders: [office('s1', 'booking_new')] });
      const out = await loadTimeDisplay(conn, [row('s1', '2026-11-20')], NOW);
      expect(out.get('s1')).toEqual({ showHour: true, level: 'none', eligible: false });
    });

    test('a missing or invalid start: the hour (the screen keeps its own rendering)', async () => {
      const conn = fakeConn({ services: [svc('s1'), svc('s2')], reminders: [office('s1'), office('s2')] });
      const out = await loadTimeDisplay(conn, [row('s1', '2026-11-20', null), row('s2', 'not a date')], NOW);
      expect(out.get('s1').showHour).toBe(true);
      expect(out.get('s2').showHour).toBe(true);
    });

    test('a failed read: showHour true for every row', async () => {
      const conn = fakeConn({ services: [svc('s1'), svc('s2')], reminders: [office('s1'), office('s2')], failOn: 'appointment_reminders' });
      const out = await loadTimeDisplay(conn, [row('s1', '2026-11-20'), row('s2', '2026-11-21')], NOW);
      expect(out.get('s1')).toEqual({ showHour: true, level: 'hour', eligible: false, failed: true });
      expect(out.get('s2')).toEqual({ showHour: true, level: 'hour', eligible: false, failed: true });
    });

    test('the failed marker is only on a failed read: a real hour verdict and a good read carry none', async () => {
      const hour = { id: 1, appointment_id: 's1', purpose: 'appointment_confirmation', sent_at: '2026-11-09T14:00:00Z', metadata: { rendered_slot_ms: SLOT } };
      const told = fakeConn({ services: [svc('s1')], reminders: [office('s1')], messages: [hour] });
      const out = await loadTimeDisplay(told, [row('s1', '2026-11-20')], NOW);
      expect(out.get('s1')).toEqual({ showHour: true, level: 'hour', eligible: false });
      expect('failed' in out.get('s1')).toBe(false);
      const good = fakeConn({ services: [svc('s2')], reminders: [office('s2')] });
      expect('failed' in (await loadTimeDisplay(good, [row('s2', '2026-11-20')], NOW)).get('s2')).toBe(false);
    });

    test('one bulk read for many rows', async () => {
      const ids = ['s1', 's2', 's3', 's4'];
      const conn = fakeConn({ services: ids.map((id) => svc(id)), reminders: ids.map((id) => office(id)) });
      const out = await loadTimeDisplay(conn, ids.map((id) => row(id, '2026-11-20')), NOW);
      expect([...out.values()].every((v) => v.showHour === false)).toBe(true);
      expect(conn.calls.appointment_reminders).toBe(1);
      expect(conn.calls['messaging_audit_log as a']).toBe(1);
    });

    test('rows without an id are ignored', async () => {
      const out = await loadTimeDisplay(fakeConn(), [{ scheduled_date: '2026-11-20' }, null], NOW);
      expect(out.size).toBe(0);
    });
  });
});
