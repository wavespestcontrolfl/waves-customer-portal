// GATE_DAY_ONLY_PROMISE part B2: an explicit customer_asked_time holds only for the move it was written with. One read rule
// (time-promise.js currentIntent, through memberEligible and dayOnlyReplayDecision) over the one move-history read
// (eligibility.js loadNewestSlotRows). Fake knex; synthetic ids; nothing is sent.
const timePromise = require('../services/time-promise');
const eligibility = require('../services/auto-dispatch/eligibility');

const {
  currentIntent, dayOnlyEligibility, dayOnlyReplayDecision, recordCustomerAskedTime,
} = timePromise;

const NOW = new Date('2026-11-10T14:00:00Z');
const FAR = new Date('2026-11-15T14:00:00Z');
const VISIT_DATE = '2026-11-15';

const svc = (over = {}) => ({
  id: 's1', visit_id: null, status: 'pending', scheduled_date: VISIT_DATE, is_recurring: false, recurring_parent_id: null,
  date_exception: null, date_exception_source: null, date_exception_at: null, customer_asked_time: null, customer_asked_time_at: null, ...over,
});
// The newest slot-changing reschedule_log row, as loadNewestSlotRows(withIntent) returns it. `afterIntent` is the SQL answer
// to "is this row newer than customer_asked_time_at" (false for the intent's own move, including the same-transaction tie).
const logRow = (initiatedBy, afterIntent, over = {}) => ({ created_at: '2026-11-09T12:00:00Z', new_date: VISIT_DATE, initiated_by: initiatedBy, after_intent: afterIntent, ...over });

/** A knex-shaped fake: scheduled_services, appointment_reminders and the newest reschedule_log rows. Records every read. */
function fakeConn({ services = [svc()], source = 'admin_manual', log = [] } = {}) {
  const reads = [];
  const updates = [];
  const conn = (table) => {
    reads.push(table);
    const ins = [];
    const chain = {};
    for (const m of ['where', 'whereNotIn', 'whereNotNull', 'whereNull', 'whereRaw', 'whereBetween', 'orderBy', 'join', 'leftJoin', 'distinct', 'orWhere', 'andWhere']) chain[m] = () => chain;
    chain.whereIn = (_c, values) => { ins.push(values.map(String)); return chain; };
    chain.select = async () => {
      if (table === 'scheduled_services') return services.filter((r) => !ins.length || ins[0].includes(String(r.id)) || ins[0].includes(String(r.visit_id)));
      if (table === 'appointment_reminders') return services.map((r) => ({ scheduled_service_id: r.id, source }));
      if (table === 'reschedule_log') return log;
      return []; // no messages, emails or calls: no promise at all
    };
    chain.first = async () => services[0];
    chain.update = async (payload) => { updates.push({ table, payload }); return 1; };
    return chain;
  };
  conn.raw = (sql) => ({ raw: sql });
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

const eligible = async (conn) => (await dayOnlyEligibility(conn, ['s1'], NOW, { ignoreLevel: true })).get('s1').eligible;
const AT = '2026-11-09T11:00:00Z';

describe('currentIntent (the one read rule)', () => {
  test('no explicit value, or no slot change logged: the value holds as written', () => {
    expect(currentIntent({ customer_asked_time: null }, logRow('admin', true))).toBeNull();
    expect(currentIntent({ customer_asked_time: undefined }, null)).toBeNull();
    expect(currentIntent({ customer_asked_time: false, customer_asked_time_at: AT }, null)).toBe(false);
    expect(currentIntent({ customer_asked_time: true, customer_asked_time_at: null }, null)).toBe(true);
  });

  test('a slot change logged AFTER the write makes the value stale (null); the move\'s own row, including the same-transaction tie, does not', () => {
    expect(currentIntent({ customer_asked_time: false, customer_asked_time_at: AT }, logRow('customer_sms', true))).toBeNull();
    expect(currentIntent({ customer_asked_time: false, customer_asked_time_at: AT }, logRow('admin', false))).toBe(false);
    expect(currentIntent({ customer_asked_time: true, customer_asked_time_at: AT }, logRow('admin', false))).toBe(true);
  });

  test('written at booking (no time): holds only while no slot change is logged at all', () => {
    expect(currentIntent({ customer_asked_time: true, customer_asked_time_at: null }, logRow('admin', null))).toBeNull();
    expect(currentIntent({ customer_asked_time: false }, logRow('admin', null))).toBeNull();
  });
});

describe('memberEligible through dayOnlyEligibility', () => {
  test('an explicit false with no later move is still day only (and reads the history once, with the intent)', withGate('true', async () => {
    const conn = fakeConn({ services: [svc({ customer_asked_time: false, customer_asked_time_at: AT })], log: [] });
    expect(await eligible(conn)).toBe(true);
    expect(conn.reads.filter((t) => t === 'reschedule_log')).toHaveLength(1);
  }));

  test('office false, then a later customer move with NO intent write: inferred as picked, so the window copy (every customer initiator)', withGate('true', async () => {
    for (const who of ['customer_sms', 'ai_call_pipeline', 'customer_self_serve', 'sms_offer_ai']) {
      const conn = fakeConn({ services: [svc({ customer_asked_time: false, customer_asked_time_at: AT })], log: [logRow(who, true)] });
      expect(await eligible(conn)).toBe(false);
      expect(conn.reads.filter((t) => t === 'reschedule_log')).toHaveLength(1); // the pick check reuses the rows
    }
  }));

  test('a stale false followed by an OFFICE move is inferred: office source, not picked, day only', withGate('true', async () => {
    const conn = fakeConn({ services: [svc({ customer_asked_time: false, customer_asked_time_at: AT })], log: [logRow('admin', true)] });
    expect(await eligible(conn)).toBe(true);
    expect(await eligible(fakeConn({ services: [svc({ customer_asked_time: false, customer_asked_time_at: AT })], source: 'booking_new', log: [logRow('admin', true)] }))).toBe(false);
  }));

  test('the same-transaction case: the intent and its own move\'s log row share now(), so it holds (a set time stays a window)', withGate('true', async () => {
    const tie = fakeConn({ services: [svc({ customer_asked_time: false, customer_asked_time_at: AT })], log: [logRow('admin', false)] });
    expect(await eligible(tie)).toBe(true);
    const asked = fakeConn({ services: [svc({ customer_asked_time: true, customer_asked_time_at: AT })], log: [logRow('admin', false)] });
    expect(await eligible(asked)).toBe(false);
  }));

  test('a booking intent (no time) followed by a move is inferred; with no move it holds', withGate('true', async () => {
    const moved = fakeConn({ services: [svc({ customer_asked_time: true })], log: [logRow('admin', null)] });
    expect(await eligible(moved)).toBe(true); // inferred: office source, an office move
    const picked = fakeConn({ services: [svc({ customer_asked_time: true })], log: [logRow('customer_sms', null)] });
    expect(await eligible(picked)).toBe(false);
    expect(await eligible(fakeConn({ services: [svc({ customer_asked_time: true })], log: [] }))).toBe(false); // holds: a set time
    expect(await eligible(fakeConn({ services: [svc({ customer_asked_time: false })], log: [] }))).toBe(true);
  }));

  test('an unrecorded intent reads no history up front (the pick check does, as before); a failed history read is not eligible', withGate('true', async () => {
    const conn = fakeConn({ services: [svc()], log: [] });
    expect(await eligible(conn)).toBe(true);
    expect(conn.reads.filter((t) => t === 'reschedule_log')).toHaveLength(1);
    const broken = fakeConn({ services: [svc({ customer_asked_time: false, customer_asked_time_at: AT })] });
    const real = broken;
    const failing = (table) => { if (table === 'reschedule_log') throw new Error('read failed'); return real(table); };
    failing.raw = real.raw;
    expect(await eligible(failing)).toBe(false);
  }));
});

describe('dayOnlyReplayDecision uses the same rule', () => {
  const replay = (conn) => dayOnlyReplayDecision(conn, { id: 's1', startAt: FAR, now: NOW, reminder24hEnabled: true });

  test('a fresh explicit false: the day row again; a stale false (a later customer move): false', withGate('true', async () => {
    expect(await replay(fakeConn({ services: [svc({ customer_asked_time: false, customer_asked_time_at: AT })], log: [logRow('admin', false)] }))).toBe(true);
    expect(await replay(fakeConn({ services: [svc({ customer_asked_time: false, customer_asked_time_at: AT })], log: [logRow('customer_sms', true)] }))).toBe(false);
  }));

  test('a booking false (no time) with a move logged since is stale: not an explicit false', withGate('true', async () => {
    expect(await replay(fakeConn({ services: [svc({ customer_asked_time: false })], log: [logRow('admin', null)] }))).toBe(false);
    expect(await replay(fakeConn({ services: [svc({ customer_asked_time: false })], log: [] }))).toBe(true);
  }));
});

describe('the writes and the shared history read', () => {
  test('every intent write also stamps customer_asked_time_at with the database clock; gate off writes nothing', async () => {
    await withGate('true', async () => {
      const conn = fakeConn();
      await recordCustomerAskedTime(conn, ['s1'], false);
      expect(conn.updates[0].payload).toEqual({ customer_asked_time: false, customer_asked_time_at: { raw: 'now()' } });
    })();
    await withGate(undefined, async () => {
      const conn = fakeConn();
      expect(await recordCustomerAskedTime(conn, ['s1'], true)).toBe(0);
      expect(conn.updates).toEqual([]);
    })();
  });

  test('loadNewestSlotRows adds the after_intent column only when asked (the auto-dispatch pick check stays byte for byte)', async () => {
    const selects = [];
    const mk = () => {
      const chain = {};
      for (const m of ['where', 'whereNotNull', 'whereRaw']) chain[m] = () => chain;
      chain.select = (...cols) => { selects.push(cols); return Promise.resolve([]); };
      return chain;
    };
    const db = Object.assign(() => mk(), { raw: (sql) => ({ raw: sql }) });
    await eligibility.loadNewestSlotRows(db, 's1');
    await eligibility.loadNewestSlotRows(db, 's1', { withIntent: true });
    expect(selects[0]).toEqual(['created_at', 'new_date', 'initiated_by']);
    expect(selects[1].slice(0, 3)).toEqual(['created_at', 'new_date', 'initiated_by']);
    expect(selects[1][3].raw).toMatch(/customer_asked_time_at.*AS after_intent/s);
  });

  test('isCustomerPickedVisit still answers from rows handed to it, and from its own read without them', async () => {
    const rows = [logRow('customer_sms', true)];
    expect((await eligibility.isCustomerPickedVisit(svc(), () => { throw new Error('no read expected'); }, rows)).picked).toBe(true);
    expect((await eligibility.isCustomerPickedVisit(svc(), fakeConn({ log: [logRow('admin', true)] }))).picked).toBe(false);
  });
});

describe('Intelligence Bar move_stops_to_day declares the office box', () => {
  test('input_schema carries customer_asked_time (boolean, described); the preview key exists only with the gate on', async () => {
    jest.doMock('../models/db', () => jest.fn());
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    const { SCHEDULE_TOOLS } = require('../services/intelligence-bar/schedule-tools');
    const tool = SCHEDULE_TOOLS.find((t) => t.name === 'move_stops_to_day');
    expect(tool.input_schema.properties.customer_asked_time).toMatchObject({ type: 'boolean' });
    expect(tool.input_schema.properties.customer_asked_time.description).toMatch(/customer asked for this exact time/);
    expect(tool.input_schema.required).toEqual(['service_ids', 'new_date']);
  });
});
