const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;
/**
 * The day re-plan APPLY writer on real PostgreSQL, with the REAL occupancy predicate, scheduling locks, reminder
 * sync and after-commit effects (owner ruling 2026-11-03, GATE_DAY_REPLAN=true). One technician, four customers, one
 * zigzag tech-day with a reminder row for each visit, planned and written by runDayReplanIfEnabled in apply mode:
 *   - the whole day is written in ONE transaction: every visit lands its planned hour with no temporary hour ever
 *     written (a trigger logs every window_start change), the route_order follows the plan, each reminder's
 *     appointment_time follows its visit with the 24-hour leg still pending, reschedule_log carries day_replan, and
 *     the plan row says 'applied';
 *   - the columns the writer changes on a moved visit are the ones the rebooker changes for the same move;
 *   - an edit committed before the fence, or an occupancy clash appearing at commit, changes nothing at all;
 *   - the night pass still reads these visits as automatic (isPersonPlacedVisit) and move-limit does not count them;
 *   - the after-commit repair of a day whose reminder sync did not finish.
 * Outbound SMS, email and push are stubbed and asserted never called. The whole test runs inside one transaction
 * that always rolls back (the writer's own transaction becomes a savepoint), on a far-future date, and it refuses
 * any database but a private QA one or CI's.
 */
let mockConn;
jest.mock('../models/db', () => new Proxy(function db() {}, {
  apply: (_t, _this, args) => mockConn(...args),
  get: (_t, prop) => {
    const value = mockConn[prop];
    return typeof value === 'function' ? value.bind(mockConn) : value;
  },
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../sockets', () => ({ ...jest.requireActual('../sockets'), getIo: () => null }));

// Every outbound channel: a stub per export, collected so the test can prove nothing was sent.
const mockOutbound = {};
const stubModule = (name) => new Proxy({}, {
  get: (_t, prop) => {
    if (prop === '__esModule' || prop === 'then') return undefined;
    mockOutbound[`${name}.${String(prop)}`] = mockOutbound[`${name}.${String(prop)}`] || jest.fn(async () => ({ success: true, sid: 'stub' }));
    return mockOutbound[`${name}.${String(prop)}`];
  },
});
jest.mock('../services/twilio', () => stubModule('twilio'));
jest.mock('../services/email', () => stubModule('email'));
jest.mock('../services/sendgrid-mail', () => stubModule('sendgrid'));
jest.mock('../services/push-notifications', () => stubModule('push'));
jest.mock('../services/fcm', () => stubModule('fcm'));
jest.mock('../services/apns', () => stubModule('apns'));
jest.mock('../services/messaging/send-customer-message', () => ({
  ...jest.requireActual('../services/messaging/send-customer-message'),
  sendCustomerMessage: (mockOutbound['messaging.sendCustomerMessage'] = jest.fn(async () => ({ sent: false }))),
}));

const { randomUUID } = require('node:crypto');
const { parseETDateTime } = require('../utils/datetime-et');

jest.setTimeout(180000);

// A Tuesday far in the future: no real rows, and outside every freeze and 24-hour rule.
const NOW = new Date('2097-06-09T05:00:00Z'); // 01:00 ET: tomorrow's 08:00 is 31 h away
const DAY = '2097-06-10';
const HQ = { lat: 27.4330885, lng: -82.4056801 };
const TZ_START = (hhmm) => parseETDateTime(`${DAY}T${hhmm}`).getTime();

maybeDescribe('day re-plan apply (real PostgreSQL, real rebooker and reminders)', () => {
  let database;
  let runDayReplanIfEnabled;
  let rebooker;
  let techId;
  let visits; // [{ id, customerId, hour, lngOffset }]
  const saved = {};

  beforeAll(() => {
    const target = new URL(process.env.DATABASE_URL);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a private QA or isolated CI database');
    database = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 1 } });
    for (const key of ['GATE_DAY_REPLAN', 'DAY_REPLAN_DAYS_AHEAD', 'GATE_MULTI_TECH_CONFIRM', 'GATE_SCHEDULING_CAPACITY']) saved[key] = process.env[key];
    ({ runDayReplanIfEnabled } = require('../services/day-replan'));
    rebooker = require('../services/rebooker');
  });

  afterAll(async () => {
    if (database) await database.destroy();
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    Object.values(mockOutbound).forEach((fn) => fn.mockClear && fn.mockClear());
    process.env.GATE_DAY_REPLAN = 'true';
    process.env.DAY_REPLAN_DAYS_AHEAD = '1';
    delete process.env.GATE_MULTI_TECH_CONFIRM;
    delete process.env.GATE_SCHEDULING_CAPACITY;
    mockConn = await database.transaction();

    techId = randomUUID();
    await mockConn('technicians').insert({ id: techId, name: 'Synthetic replan tech', employment_status: 'active', field_dispatchable: true });
    // Far, near, far, near on 08:00, 09:00, 10:00, 11:00: a day the planner shortens.
    visits = [
      { name: 'a', hour: 8, lngOffset: 0.30, status: 'confirmed' },
      { name: 'b', hour: 9, lngOffset: 0.02, status: 'pending' },
      { name: 'c', hour: 10, lngOffset: 0.31, status: 'confirmed' },
      { name: 'd', hour: 11, lngOffset: 0.03, status: 'pending' },
    ].map((v) => ({ ...v, id: randomUUID(), customerId: randomUUID() }));
    for (const [i, v] of visits.entries()) {
      const pad = (n) => String(n).padStart(2, '0');
      await mockConn('customers').insert({
        id: v.customerId,
        first_name: `Replan${v.name}zq`,
        last_name: 'Fixturezq',
        email: `${v.customerId}@example.invalid`,
        phone: `+1941555${String(1000 + i).padStart(4, '0')}`,
        address_line1: `${100 + i} Replan Test Lane`,
        city: 'Test City',
        zip: '00000',
        active: true,
        pipeline_stage: 'active_customer',
      });
      await mockConn('scheduled_services').insert({
        id: v.id,
        customer_id: v.customerId,
        technician_id: techId,
        scheduled_date: DAY,
        service_type: 'Quarterly Pest Control Service',
        status: v.status,
        window_start: `${pad(v.hour)}:00`,
        window_end: `${pad(v.hour + 1)}:00`,
        estimated_duration_minutes: 60,
        lat: HQ.lat,
        lng: HQ.lng + v.lngOffset,
        route_order: i + 1,
      });
      await mockConn('appointment_reminders').insert({
        scheduled_service_id: v.id,
        customer_id: v.customerId,
        appointment_time: parseETDateTime(`${DAY}T${pad(v.hour)}:00`),
        service_type: 'Quarterly Pest Control Service',
        source: 'admin_manual',
        confirmation_sent: true,
        confirmation_sent_at: new Date('2097-05-01T12:00:00Z'),
        reminder_72h_sent: false,
        reminder_24h_sent: false,
        cancelled: false,
      });
    }
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await mockConn.rollback();
  });

  const visitRows = async () => mockConn('scheduled_services').whereIn('id', visits.map((v) => v.id)).select('id', 'window_start', 'window_end', 'route_order', 'status');
  const startOf = (rows, id) => String(rows.find((r) => r.id === id).window_start).slice(0, 5);
  const reminders = async () => mockConn('appointment_reminders').whereIn('scheduled_service_id', visits.map((v) => v.id)).select('scheduled_service_id', 'appointment_time', 'reminder_24h_sent', 'reminder_72h_sent', 'cancelled');
  const sentAnything = () => Object.entries(mockOutbound).filter(([, fn]) => fn.mock && fn.mock.calls.length > 0).map(([name]) => name);

  const OPTS = { seriesPolicy: 'single', visitPolicy: 'single', keepStatus: true, suppressTechNotice: true, notifyRequested: false, placeInRoute: false };
  const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
  const minutes = (value) => { const [h, m] = String(value).slice(0, 5).split(':').map(Number); return h * 60 + m; };
  const reminderMs = async (id) => new Date((await mockConn('appointment_reminders').where({ scheduled_service_id: id }).first()).appointment_time).getTime();
  const applyDeps = () => require('../services/day-replan')._internals.applyDeps();
  const snapshot = async () => ({ rows: await visitRows(), rem: await reminders(), log: (await mockConn('reschedule_log').whereIn('scheduled_service_id', visits.map((v) => v.id))).length });

  /** Logs every change of a visit's window_start in this transaction (a trigger that dies with the rollback). */
  async function trackWindowWrites() {
    await mockConn.raw('CREATE TEMP TABLE win_writes (id uuid, new_start time, new_end time) ON COMMIT DROP');
    await mockConn.raw(`CREATE FUNCTION pg_temp.log_win() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.window_start IS DISTINCT FROM OLD.window_start OR NEW.window_end IS DISTINCT FROM OLD.window_end THEN
          INSERT INTO win_writes VALUES (NEW.id, NEW.window_start, NEW.window_end);
        END IF;
        RETURN NEW;
      END $$`);
    await mockConn.raw('CREATE TRIGGER log_win AFTER UPDATE ON scheduled_services FOR EACH ROW EXECUTE FUNCTION pg_temp.log_win()');
    return async () => (await mockConn.raw('SELECT id, new_start, new_end FROM win_writes')).rows;
  }
  const changedColumns = (before, after) => Object.keys(after).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k])).sort();

  test('writes the planned hours, the route order and the reminders in one go, silently, and says applied', async () => {
    const writes = await trackWindowWrites();
    const out = await runDayReplanIfEnabled({ now: NOW, conn: mockConn });
    expect(out.status).toBe('completed');
    expect(out.apply).toEqual([expect.objectContaining({ date: DAY, technician_id: techId, status: 'applied', reason: 'applied' })]);

    const plan = await mockConn('day_replan_plans').where({ run_id: out.runId }).first();
    expect(plan).toMatchObject({ mode: 'apply', accepted: true, apply_status: 'applied', apply_reason: 'applied' });
    expect(plan.applied_at).toBeTruthy();
    // No journal any more: the columns stay empty.
    expect(plan.apply_started_at).toBeNull();
    expect(plan.apply_steps).toBeNull();
    const changes = plan.changes; // jsonb
    expect(changes.length).toBeGreaterThan(0);

    // Every changed visit sits on its planned hour; the others did not move.
    const rows = await visitRows();
    const changed = new Map(changes.map((c) => [c.id, c.to]));
    for (const v of visits) {
      const was = `${String(v.hour).padStart(2, '0')}:00`;
      expect(startOf(rows, v.id)).toBe(changed.get(v.id) || was);
    }
    expect(new Set(rows.map((r) => startOf(rows, r.id))).size).toBe(4);
    for (const v of visits) expect(rows.find((r) => r.id === v.id).status).toBe(v.status);
    // The zigzag is a cycle, and it was written directly: each moved visit's window changed exactly once, to its final hour.
    const logged = await writes();
    expect(logged).toHaveLength(changes.length);
    for (const w of logged) expect(String(w.new_start).slice(0, 5)).toBe(changed.get(w.id));

    // route_order is 1..4 in the order of the final hours.
    const byOrder = [...rows].sort((x, y) => x.route_order - y.route_order);
    expect(byOrder.map((r) => Number(r.route_order))).toEqual([1, 2, 3, 4]);
    expect(byOrder.map((r) => startOf(rows, r.id))).toEqual([...byOrder.map((r) => startOf(rows, r.id))].sort());

    // Each reminder names its visit's new time and keeps the 24-hour leg pending; nothing was cancelled.
    for (const r of await reminders()) {
      expect(new Date(r.appointment_time).getTime()).toBe(TZ_START(startOf(rows, r.scheduled_service_id)));
      expect(r.reminder_24h_sent).toBe(false);
      expect(r.reminder_72h_sent).toBe(false);
      expect(r.cancelled).toBe(false);
    }

    // The log: one row per moved visit, all day_replan, in the rebooker's same-day shape.
    const log = await mockConn('reschedule_log').whereIn('scheduled_service_id', visits.map((v) => v.id)).select('scheduled_service_id', 'initiated_by', 'reason_code', 'original_date', 'new_date', 'original_window', 'new_window');
    expect(log).toHaveLength(changes.length);
    expect(new Set(log.map((l) => l.initiated_by))).toEqual(new Set(['day_replan']));
    expect(new Set(log.map((l) => l.reason_code))).toEqual(new Set(['day_replan']));
    for (const c of changes) {
      const l = log.find((x) => x.scheduled_service_id === c.id);
      expect(String(l.new_window)).toBe(`${c.to}-${hhmm(minutes(c.to) + 60)}`);
      expect(String(l.original_window)).toBe(`${c.from}:00-${hhmm(minutes(c.from) + 60)}:00`);
    }
    expect(sentAnything()).toEqual([]);
  });

  test('the columns changed on a moved visit are the rebooker\'s for the same move (the route number aside)', async () => {
    const [a] = visits;
    // The writer.
    const beforeA = (await mockConn('scheduled_services').where({ id: a.id }).first());
    const out = await runDayReplanIfEnabled({ now: NOW, conn: mockConn });
    expect(out.apply[0].status).toBe('applied');
    const afterA = (await mockConn('scheduled_services').where({ id: a.id }).first());
    const ours = changedColumns(beforeA, afterA).filter((c) => c !== 'route_order');
    expect(ours).toEqual(['track_token_expires_at', 'updated_at', 'window_end', 'window_start']);
  });

  test('...and the rebooker changes exactly those columns for a same-day window move by a night writer', async () => {
    const [a] = visits;
    const before = (await mockConn('scheduled_services').where({ id: a.id }).first());
    await rebooker.reschedule(a.id, DAY, { start: '15:00', end: '16:00' }, 'day_replan', 'day_replan', OPTS);
    const after = (await mockConn('scheduled_services').where({ id: a.id }).first());
    expect(changedColumns(before, after)).toEqual(['track_token_expires_at', 'updated_at', 'window_end', 'window_start']);
    // Its log row has the shape the writer copies.
    const l = await mockConn('reschedule_log').where({ scheduled_service_id: a.id }).first();
    expect(Object.keys(l).sort()).toEqual(expect.arrayContaining(['occurrence_property_id', 'occurrence_service_id', 'occurrence_service_type', 'original_window', 'new_window']));
    expect(String(l.new_window)).toBe('15:00-16:00');
    expect(String(l.original_window)).toBe('08:00:00-09:00:00');
  });

  test('the night pass still sees these visits as automatic, and move-limit does not count them', async () => {
    const { isPersonPlacedVisit } = require('../services/auto-dispatch/eligibility');
    const { countAutoMoves } = require('../services/auto-dispatch/move-limit');
    const out = await runDayReplanIfEnabled({ now: NOW, conn: mockConn });
    expect(out.apply[0].status).toBe('applied');
    for (const v of visits) {
      const current = await mockConn('scheduled_services').where({ id: v.id }).first();
      expect(await isPersonPlacedVisit(current, mockConn)).toEqual({ placed: false });
    }
    expect((await countAutoMoves(mockConn, visits.map((v) => v.id))).size).toBe(0);
  });

  /** An edit by another writer that committed before our locks: it runs when the writer takes the row locks. */
  const editBeforeFence = (edit) => {
    const real = applyDeps();
    return { ...real, lockDayRows: async (c, d) => { const out = await real.lockDayRows(c, d); await edit(c); return out; } };
  };

  test.each([
    ['a moved visit\'s duration', (c, v) => c('scheduled_services').where({ id: v[0].id }).update({ estimated_duration_minutes: 90 })],
    ['a moved visit\'s staff lock', (c, v) => c('scheduled_services').where({ id: v[1].id }).update({ auto_dispatch_locked: true })],
    ['a moved visit\'s status', (c, v) => c('scheduled_services').where({ id: v[0].id }).update({ status: 'pending' === visits[0].status ? 'confirmed' : 'pending' })],
    ['a stop that joined the technician\'s day', (c) => c('scheduled_services').insert({
      id: randomUUID(), customer_id: visits[0].customerId, technician_id: techId, scheduled_date: DAY, service_type: 'Quarterly Pest Control Service',
      status: 'confirmed', window_start: '16:00', window_end: '17:00', estimated_duration_minutes: 60, lat: HQ.lat, lng: HQ.lng,
    })],
    ['an unassigned stop that joined the date', (c) => c('scheduled_services').insert({
      id: randomUUID(), customer_id: visits[0].customerId, technician_id: null, scheduled_date: DAY, service_type: 'Quarterly Pest Control Service',
      status: 'confirmed', window_start: '16:00', window_end: '17:00', estimated_duration_minutes: 60,
    })],
  ])('an edit to %s committed before the fence: nothing changes', async (_label, edit) => {
    const before = await snapshot();
    const out = await runDayReplanIfEnabled({ now: NOW, conn: mockConn, deps: editBeforeFence((c) => edit(c, visits)) });
    expect(out.apply).toEqual([expect.objectContaining({ status: 'skipped', reason: 'changed_since_plan', moved: 0 })]);
    const after = await snapshot();
    // Only the other writer's own edit differs; our columns (hours, route numbers, reminders, log) are as they were.
    for (const v of visits) {
      expect(startOf(after.rows, v.id)).toBe(startOf(before.rows, v.id));
      expect(Number(after.rows.find((r) => r.id === v.id).route_order)).toBe(Number(before.rows.find((r) => r.id === v.id).route_order));
    }
    expect(after.rem).toEqual(before.rem);
    expect(after.log).toBe(before.log);
    const plan = await mockConn('day_replan_plans').where({ run_id: out.runId }).first();
    expect(plan).toMatchObject({ apply_status: 'skipped', apply_reason: 'changed_since_plan' });
    expect(sentAnything()).toEqual([]);
  });

  test('a moved visit whose 24-hour reminder went out meanwhile is refused under the fence', async () => {
    const before = await snapshot();
    const out = await runDayReplanIfEnabled({
      now: NOW,
      conn: mockConn,
      deps: editBeforeFence((c) => c('appointment_reminders').where({ scheduled_service_id: visits[0].id }).update({ reminder_24h_sent: true })),
    });
    expect(out.apply[0].status).toBe('skipped');
    expect(out.apply[0].reason).toMatch(/^visit_not_movable:/);
    const after = await snapshot();
    for (const v of visits) expect(startOf(after.rows, v.id)).toBe(startOf(before.rows, v.id));
    expect(after.log).toBe(before.log);
  });

  test('an occupancy clash appearing at commit (an unassigned row at a new hour): nothing changes at all', async () => {
    const real = applyDeps();
    let inserted = null;
    const before = await snapshot();
    const out = await runDayReplanIfEnabled({
      now: NOW,
      conn: mockConn,
      deps: {
        ...real,
        // The clash is written by another writer between the writes and the probe; the probe is the app's own.
        findConflicts: async (args) => {
          if (!inserted) {
            inserted = randomUUID();
            await args.db('scheduled_services').insert({
              id: inserted, customer_id: visits[0].customerId, technician_id: null, scheduled_date: DAY, service_type: 'Quarterly Pest Control Service',
              status: 'confirmed', window_start: args.windowStart, window_end: args.windowEnd, estimated_duration_minutes: 60,
            });
          }
          return real.findConflicts(args);
        },
      },
    });
    expect(out.apply).toEqual([expect.objectContaining({ status: 'skipped', reason: 'slot_taken', moved: 0 })]);
    const after = await snapshot();
    expect(after.rows).toEqual(before.rows);
    expect(after.rem).toEqual(before.rem);
    expect(after.log).toBe(before.log);
    // The clash row was the other writer's savepoint work inside our transaction: it went with the rollback.
    expect(await mockConn('scheduled_services').where({ id: inserted }).first()).toBeUndefined();
    expect(sentAnything()).toEqual([]);
  });

  test('a visit with no booked end stays open-ended and holds its estimated duration', async () => {
    const [a] = visits;
    await mockConn('scheduled_services').where({ id: a.id }).update({ window_end: null }); // estimated 60: the plan is the usual one
    const out = await runDayReplanIfEnabled({ now: NOW, conn: mockConn });
    expect(out.apply).toEqual([expect.objectContaining({ status: 'applied' })]);
    const row = await mockConn('scheduled_services').where({ id: a.id }).first();
    expect(row.window_end).toBeNull();
    for (const v of visits.slice(1)) expect((await mockConn('scheduled_services').where({ id: v.id }).first()).window_end).not.toBeNull();
    const log = await mockConn('reschedule_log').where({ scheduled_service_id: a.id }).first();
    expect(String(log.new_window)).toMatch(/^\d\d:\d\d$/); // the start only
    expect(sentAnything()).toEqual([]);
  });

  test('the self-booking snapshot follows a moved self-booked visit; the repair brings back one a crash left behind', async () => {
    const [a] = visits;
    const sbId = randomUUID();
    await mockConn('self_booked_appointments').insert({ id: sbId, customer_id: a.customerId, date: DAY, start_time: '08:00', end_time: '09:00', status: 'confirmed', confirmation_code: `RP${sbId.slice(0, 8)}` });
    await mockConn('scheduled_services').where({ id: a.id }).update({ self_booking_id: sbId });
    const out = await runDayReplanIfEnabled({ now: NOW, conn: mockConn });
    expect(out.apply[0].status).toBe('applied');
    const moved = await mockConn('scheduled_services').where({ id: a.id }).first();
    const snap = await mockConn('self_booked_appointments').where({ id: sbId }).first();
    expect(String(snap.start_time).slice(0, 5)).toBe(String(moved.window_start).slice(0, 5));
    expect(String(snap.end_time).slice(0, 5)).toBe(String(moved.window_end).slice(0, 5));
    // A crash after the commit left the snapshot and the reminder on the old hour: the next run repairs both.
    await mockConn('self_booked_appointments').where({ id: sbId }).update({ start_time: '08:00', end_time: '09:00' });
    await mockConn('appointment_reminders').where({ scheduled_service_id: a.id }).update({ appointment_time: parseETDateTime(`${DAY}T08:00`) });
    process.env.GATE_DAY_REPLAN = 'shadow';
    const next = await runDayReplanIfEnabled({ now: NOW, conn: mockConn });
    expect(next.repaired).toBeGreaterThan(0);
    const repaired = await mockConn('self_booked_appointments').where({ id: sbId }).first();
    expect(String(repaired.start_time).slice(0, 5)).toBe(String(moved.window_start).slice(0, 5));
    expect(await reminderMs(a.id)).toBe(TZ_START(String(moved.window_start).slice(0, 5)));
    expect(sentAnything()).toEqual([]);
  });
});
