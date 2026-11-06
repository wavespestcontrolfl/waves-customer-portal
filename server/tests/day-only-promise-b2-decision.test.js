// GATE_DAY_ONLY_PROMISE part B2: the move decision (dayOnlyMoveDecision), the held/merged re-send decision
// (dayOnlyReplayDecision) and the intent write (recordCustomerAskedTime) in services/time-promise.js, run for real over a
// knex-shaped fake. Synthetic ids only; nothing is sent.
const timePromise = require('../services/time-promise');

const {
  dayOnlyMoveDecision, dayOnlyReplayDecision, recordCustomerAskedTime, officeMoveIntent, DAY_PROMISE_CUTOFF_HOURS,
} = timePromise;

const NOW = new Date('2026-11-10T14:00:00Z');
const FAR = new Date('2026-11-15T14:00:00Z'); // 5 days out
const NEAR = new Date('2026-11-11T08:00:00Z'); // 18 h out: inside the 24.25 h cutoff

const svc = (id, over = {}) => ({
  id, visit_id: null, status: 'pending', scheduled_date: '2026-11-15', is_recurring: false, recurring_parent_id: null,
  date_exception: null, date_exception_source: null, date_exception_at: null, customer_asked_time: null, ...over,
});
const child = (id, over = {}) => svc(id, { is_recurring: true, recurring_parent_id: 'parent-1', ...over });
const office = (id, source = 'admin_manual') => ({ scheduled_service_id: id, source, cancelled: false, created_at: '2026-11-09T12:00:00Z' });

/** A knex-shaped fake over rows per table; records every read and update. */
function fakeConn({ services = [], reminders = [], moves = {}, messages = [], failOn = null } = {}) {
  const reads = [];
  const updates = [];
  const conn = (table) => {
    reads.push(table);
    const ins = [];
    const notIns = [];
    const eq = {};
    const chain = {};
    for (const m of ['join', 'leftJoin', 'whereRaw', 'whereBetween', 'whereNull', 'whereNotNull', 'distinct', 'orWhere', 'orderBy']) {
      chain[m] = () => chain;
    }
    chain.where = (col, val) => { if (typeof col === 'string') eq[col] = val; else if (col && typeof col === 'object') Object.assign(eq, col); return chain; };
    chain.whereIn = (col, values) => { ins.push([col, (Array.isArray(values) ? values : []).map(String)]); return chain; };
    chain.whereNotIn = (col, values) => { notIns.push([col, values.map(String)]); return chain; };
    const pick = (rows) => rows.filter((r) => ins.every(([col, vals]) => r[col] != null && vals.includes(String(r[col])))
      && notIns.every(([col, vals]) => !vals.includes(String(r[col]))));
    chain.select = async () => {
      if (failOn === table) throw new Error(`read failed: ${table}`);
      if (table === 'messaging_audit_log as a') return messages;
      if (table === 'reschedule_log') return moves[eq.scheduled_service_id] || [];
      if (table === 'scheduled_services') return pick(services);
      if (table === 'appointment_reminders') return pick(reminders).filter((r) => r.cancelled !== true);
      return [];
    };
    chain.first = async (...cols) => {
      if (failOn === table) throw new Error(`read failed: ${table}`);
      const rows = table === 'scheduled_services' ? services.filter((r) => String(r.id) === String(eq.id)) : [];
      return rows[0] && cols.length ? Object.fromEntries(cols.map((c) => [c, rows[0][c]])) : rows[0];
    };
    chain.update = async (payload) => { updates.push({ table, ins: [...ins], payload }); return ins.length ? ins[0][1].length : 1; };
    return chain;
  };
  conn.raw = (sql, bindings) => ({ sql, bindings });
  conn.isTransaction = true;
  conn.reads = reads;
  conn.updates = updates;
  return conn;
}

const withGate = (value, fn) => async () => {
  const prior = process.env.GATE_DAY_ONLY_PROMISE;
  if (value === undefined) delete process.env.GATE_DAY_ONLY_PROMISE; else process.env.GATE_DAY_ONLY_PROMISE = value;
  try { await fn(); } finally {
    if (prior === undefined) delete process.env.GATE_DAY_ONLY_PROMISE; else process.env.GATE_DAY_ONLY_PROMISE = prior;
  }
};

const base = (over = {}) => ({
  id: 's1', newStartAt: FAR, oldDate: '2026-11-12', newDate: '2026-11-15', now: NOW, reminder24hEnabled: true, ...over,
});
const decide = (conn, over) => dayOnlyMoveDecision(conn, base(over));
const ok = () => fakeConn({ services: [svc('s1')], reminders: [office('s1')] });

describe('officeMoveIntent', () => {
  test('only exactly true is a set time; anything else chooses the day only', () => {
    expect(officeMoveIntent(true)).toBe('set_time');
    for (const v of [false, undefined, null, 'true', 1, 0]) expect(officeMoveIntent(v)).toBe('day');
  });
});

describe('dayOnlyMoveDecision: every condition alone', () => {
  test('gate off: false and nothing is read', withGate(undefined, async () => {
    const conn = ok();
    expect(await decide(conn, { intent: 'day' })).toBe(false);
    expect(conn.reads).toEqual([]);
  }));

  test('the happy path: explicit day intent, date changes, far out, 24-hour reminder on', withGate('true', async () => {
    expect(await decide(ok(), { intent: 'day' })).toBe(true);
  }));

  test('a same-day re-time always names the window', withGate('true', async () => {
    expect(await decide(ok(), { intent: 'day', oldDate: '2026-11-15', newDate: '2026-11-15' })).toBe(false);
  }));

  test('a missing or invalid date: false', withGate('true', async () => {
    for (const over of [{ oldDate: undefined }, { oldDate: null }, { newDate: undefined }, { oldDate: 'garbage' }]) {
      expect(await decide(ok(), { intent: 'day', ...over })).toBe(false);
    }
  }));

  test('a Date object for the old date works (a pg DATE value)', withGate('true', async () => {
    expect(await decide(ok(), { intent: 'day', oldDate: new Date('2026-11-12T05:00:00Z') })).toBe(true);
  }));

  test('inside the 24.25 h cutoff: false', withGate('true', async () => {
    expect(await decide(ok(), { intent: 'day', newStartAt: NEAR, newDate: '2026-11-11' })).toBe(false);
  }));

  test('the cutoff boundary is exact', withGate('true', async () => {
    const at = (h) => new Date(NOW.getTime() + h * 3600000);
    expect(await decide(ok(), { intent: 'day', newStartAt: at(DAY_PROMISE_CUTOFF_HOURS) })).toBe(false);
    expect(await decide(ok(), { intent: 'day', newStartAt: at(DAY_PROMISE_CUTOFF_HOURS + 0.01) })).toBe(true);
  }));

  test('a missing or invalid start: false', withGate('true', async () => {
    for (const v of [null, undefined, 'not a time']) expect(await decide(ok(), { intent: 'day', newStartAt: v })).toBe(false);
  }));

  test('the 24-hour reminder will not go out: false', withGate('true', async () => {
    expect(await decide(ok(), { intent: 'day', reminder24hEnabled: false })).toBe(false);
  }));

  test('intent set_time: false even when everything else holds, and nothing is read', withGate('true', async () => {
    const conn = ok();
    expect(await decide(conn, { intent: 'set_time' })).toBe(false);
    expect(conn.reads).toEqual([]);
  }));

  test('intent day: true without reading anything', withGate('true', async () => {
    const conn = ok();
    expect(await decide(conn, { intent: 'day' })).toBe(true);
    expect(conn.reads).toEqual([]);
  }));
});

describe('dayOnlyMoveDecision: no intent named (rain, series): the recorded intent decides, the old promise does not', () => {
  test('column true: window (even for an office-booked first visit)', withGate('true', async () => {
    const conn = fakeConn({ services: [svc('s1', { customer_asked_time: true })], reminders: [office('s1')] });
    expect(await decide(conn)).toBe(false);
  }));

  test('column false: day (even for a customer-source first visit)', withGate('true', async () => {
    const conn = fakeConn({ services: [svc('s1', { customer_asked_time: false })], reminders: [office('s1', 'booking_new')] });
    expect(await decide(conn)).toBe(true);
  }));

  test('column NULL, first visit: the booking source decides', withGate('true', async () => {
    expect(await decide(fakeConn({ services: [svc('s1')], reminders: [office('s1', 'admin_manual')] }))).toBe(true);
    expect(await decide(fakeConn({ services: [svc('s1')], reminders: [office('s1', 'booking_new')] }))).toBe(false);
    expect(await decide(fakeConn({ services: [svc('s1')], reminders: [office('s1', 'call_recording')] }))).toBe(false);
    expect(await decide(fakeConn({ services: [svc('s1')] }))).toBe(false);
  }));

  test('column NULL, recurring child: day unless the customer picked its slot', withGate('true', async () => {
    expect(await decide(fakeConn({ services: [child('s1')], reminders: [office('s1', 'cron_selfheal')] }))).toBe(true);
    const picked = { s1: [{ created_at: '2026-11-08T10:00:00Z', new_date: '2026-11-15', initiated_by: 'customer_self_serve' }] };
    expect(await decide(fakeConn({ services: [child('s1')], moves: picked }))).toBe(false);
  }));

  test('the OLD promise is not read: a child whose latest promise is an hour is still day-only after a move', withGate('true', async () => {
    const hour = { id: 1, appointment_id: 's1', purpose: 'appointment_confirmation', sent_at: '2026-11-09T14:00:00Z', metadata: { rendered_slot_ms: Date.parse('2026-11-12T14:00:00Z') } };
    const conn = fakeConn({ services: [child('s1')], messages: [hour] });
    expect(await decide(conn)).toBe(true);
    expect(conn.reads).not.toContain('messaging_audit_log as a');
  }));

  test('a stop is judged as a whole: one set-time member makes the notice a window', withGate('true', async () => {
    const services = [
      svc('s1', { visit_id: 'v1', customer_asked_time: false }),
      svc('s2', { visit_id: 'v1', customer_asked_time: true }),
    ];
    const conn = fakeConn({ services, reminders: [office('s1'), office('s2')] });
    expect(await decide(conn)).toBe(false);
    const allDay = fakeConn({ services: services.map((s) => ({ ...s, customer_asked_time: false })), reminders: [office('s1'), office('s2')] });
    expect(await decide(allDay)).toBe(true);
  }));

  test('several ids (a series): every one must be day-only', withGate('true', async () => {
    const services = [child('a'), child('b', { customer_asked_time: true })];
    expect(await decide(fakeConn({ services }), { id: null, ids: ['a', 'b'] })).toBe(false);
    expect(await decide(fakeConn({ services }), { id: null, ids: ['a'] })).toBe(true);
  }));

  test('no id at all: false', withGate('true', async () => {
    expect(await decide(ok(), { id: null, ids: [] })).toBe(false);
  }));

  test('any read failure: false (the window text is the safe side)', withGate('true', async () => {
    for (const table of ['scheduled_services', 'appointment_reminders']) {
      const conn = fakeConn({ services: [svc('s1')], reminders: [office('s1')], failOn: table });
      expect(await decide(conn)).toBe(false);
    }
    const history = fakeConn({ services: [child('s1')], failOn: 'reschedule_log' });
    expect(await decide(history)).toBe(false);
  }));
});

describe('dayOnlyReplayDecision: a held or merged move notice re-sent as a confirmation keeps the recorded intent', () => {
  const FAR_SLOT = Date.parse('2026-11-15T14:00:00Z');
  const hourFor = (date) => ({ id: 1, appointment_id: 's1', purpose: 'appointment_confirmation', sent_at: '2026-11-09T14:00:00Z', metadata: { rendered_slot_ms: Date.parse(`${date}T14:00:00Z`) } });
  const replay = (conn, over) => dayOnlyReplayDecision(conn, { id: 's1', startAt: FAR, now: NOW, reminder24hEnabled: true, ...over });

  test('gate off: false and nothing is read', withGate(undefined, async () => {
    const conn = fakeConn({ services: [svc('s1', { customer_asked_time: false })] });
    expect(await replay(conn)).toBe(false);
    expect(conn.reads).toEqual([]);
  }));

  test('a day intent (false) with an OLD hour promise for another date: the day row again', withGate('true', async () => {
    const conn = fakeConn({ services: [svc('s1', { customer_asked_time: false })], messages: [hourFor('2026-11-12')] });
    expect(await replay(conn)).toBe(true);
  }));

  test('a day intent whose latest promise is a window for THIS date (newer, known): the window stands', withGate('true', async () => {
    const conn = fakeConn({ services: [svc('s1', { customer_asked_time: false })], messages: [hourFor('2026-11-15')] });
    expect(await replay(conn)).toBe(false);
    expect(FAR_SLOT).toBeGreaterThan(0);
  }));

  test('a day intent with no promise at all, or a day promise: the day row', withGate('true', async () => {
    expect(await replay(fakeConn({ services: [svc('s1', { customer_asked_time: false })] }))).toBe(true);
    const day = { id: 2, appointment_id: 's1', purpose: 'appointment_confirmation', sent_at: '2026-11-09T14:00:00Z', metadata: { promise_level: 'day', window_unknown: true } };
    expect(await replay(fakeConn({ services: [svc('s1', { customer_asked_time: false })], messages: [day] }))).toBe(true);
  }));

  test('a set time (true) stays a window; an unrecorded intent (NULL) is today\'s rules, not this one', withGate('true', async () => {
    expect(await replay(fakeConn({ services: [svc('s1', { customer_asked_time: true })] }))).toBe(false);
    expect(await replay(fakeConn({ services: [svc('s1')] }))).toBe(false);
  }));

  test('inside the cutoff, 24-hour reminder off, an unknown-window promise, or a read failure: false', withGate('true', async () => {
    const day = fakeConn({ services: [svc('s1', { customer_asked_time: false })] });
    expect(await replay(day, { startAt: NEAR })).toBe(false);
    expect(await replay(day, { reminder24hEnabled: false })).toBe(false);
    const unknown = { id: 3, appointment_id: 's1', purpose: 'appointment_confirmation', sent_at: '2026-11-09T14:00:00Z', metadata: { window_unknown: true } };
    expect(await replay(fakeConn({ services: [svc('s1', { customer_asked_time: false })], messages: [unknown] }))).toBe(false);
    expect(await replay(fakeConn({ services: [svc('s1', { customer_asked_time: false })], failOn: 'scheduled_services' }))).toBe(false);
  }));
});

describe('recordCustomerAskedTime', () => {
  test('gate off: no write at all (the UPDATE payloads stay today\'s)', withGate(undefined, async () => {
    const conn = fakeConn();
    expect(await recordCustomerAskedTime(conn, ['s1'], true)).toBe(0);
    expect(conn.updates).toEqual([]);
    expect(conn.reads).toEqual([]);
  }));

  test('gate on: true only for exactly true; ids de-duplicated; empty is a no-op', withGate('true', async () => {
    const conn = fakeConn();
    await recordCustomerAskedTime(conn, ['s1', 's1', 's2', null], true);
    await recordCustomerAskedTime(conn, ['s3'], false);
    await recordCustomerAskedTime(conn, ['s4'], 'yes');
    await recordCustomerAskedTime(conn, [], true);
    expect(conn.updates.map((u) => [u.table, u.ins[0][1], u.payload])).toEqual([
      ['scheduled_services', ['s1', 's2'], { customer_asked_time: true }],
      ['scheduled_services', ['s3'], { customer_asked_time: false }],
      ['scheduled_services', ['s4'], { customer_asked_time: false }],
    ]);
  }));

  test('a failed write throws, so a caller inside a transaction fails the move with it', withGate('true', async () => {
    const conn = () => ({ whereIn: () => ({ update: async () => { throw new Error('write failed'); } }) });
    await expect(recordCustomerAskedTime(conn, ['s1'], true)).rejects.toThrow('write failed');
  }));
});
