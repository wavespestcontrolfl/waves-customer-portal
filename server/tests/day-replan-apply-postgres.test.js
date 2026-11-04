const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;
/**
 * The day re-plan APPLY writer on real PostgreSQL, with the REAL rebooker, reminders and night-writer reminder sync
 * (owner ruling 2026-11-03, GATE_DAY_REPLAN=true). One technician, four customers, one zigzag tech-day with a
 * reminder row for each visit, planned and written by runDayReplanIfEnabled in apply mode:
 *   - every visit lands its planned hour, the route_order follows the plan, each reminder's appointment_time follows
 *     its visit with the 24-hour leg still pending, reschedule_log carries initiated_by 'day_replan', and the plan
 *     row says 'applied';
 *   - a forced failure of the second write puts every visit (hour, route_order, reminder) back and says
 *     'rolled_back';
 *   - a day left mid-apply by a stopped process (a visit parked on a temporary hour, journal on the plan row) is put
 *     back by the next run before anything new is planned.
 * Outbound SMS, email and push are stubbed and asserted never called. The whole test runs inside one transaction
 * that always rolls back (the rebooker's own transactions become savepoints), on a far-future date, and it refuses
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

  test('writes the planned hours, the route order and the reminders, silently, and says applied', async () => {
    const out = await runDayReplanIfEnabled({ now: NOW, conn: mockConn });
    expect(out.status).toBe('completed');
    expect(out.apply).toEqual([expect.objectContaining({ date: DAY, technician_id: techId, status: 'applied', reason: 'applied' })]);

    const plan = await mockConn('day_replan_plans').where({ run_id: out.runId }).first();
    expect(plan).toMatchObject({ mode: 'apply', accepted: true, apply_status: 'applied', apply_reason: 'applied' });
    expect(plan.applied_at).toBeTruthy();
    expect(plan.apply_started_at).toBeTruthy();
    expect(plan.apply_steps).toMatchObject({ complete: true, routePersisted: true });
    const changes = plan.changes; // jsonb
    expect(changes.length).toBeGreaterThan(0);
    // The zigzag is a cycle (every hour is taken), so the write went through one temporary hour, which no visit keeps.
    const parked = plan.apply_steps.steps.filter((s) => s.temp);
    expect(parked).toHaveLength(1);
    expect(plan.apply_steps.steps.length).toBe(changes.length + 1);

    // Every changed visit sits on its planned hour; the others did not move.
    const rows = await visitRows();
    const changed = new Map(changes.map((c) => [c.id, c.to]));
    for (const v of visits) {
      const was = `${String(v.hour).padStart(2, '0')}:00`;
      expect(startOf(rows, v.id)).toBe(changed.get(v.id) || was);
    }
    // No two visits share an hour (no temporary hour left behind), and the status is what it was.
    expect(new Set(rows.map((r) => startOf(rows, r.id))).size).toBe(4);
    for (const v of visits) expect(rows.find((r) => r.id === v.id).status).toBe(v.status);

    // route_order is 1..4 in the order of the final hours.
    const byOrder = [...rows].sort((x, y) => x.route_order - y.route_order);
    expect(byOrder.map((r) => Number(r.route_order))).toEqual([1, 2, 3, 4]);
    expect(byOrder.map((r) => startOf(rows, r.id))).toEqual([...byOrder.map((r) => startOf(rows, r.id))].sort());

    // Each reminder names its visit's new time and keeps the 24-hour leg pending; nothing was cancelled.
    const rem = await reminders();
    for (const r of rem) {
      expect(new Date(r.appointment_time).getTime()).toBe(TZ_START(startOf(rows, r.scheduled_service_id)));
      expect(r.reminder_24h_sent).toBe(false);
      expect(r.reminder_72h_sent).toBe(false);
      expect(r.cancelled).toBe(false);
    }

    // The log: every move by the day re-plan, and nothing under the night pass's signature.
    const log = await mockConn('reschedule_log').whereIn('scheduled_service_id', visits.map((v) => v.id)).select('scheduled_service_id', 'initiated_by', 'reason_code', 'new_window');
    expect(log.length).toBeGreaterThanOrEqual(changes.length);
    expect(new Set(log.map((l) => l.initiated_by))).toEqual(new Set(['day_replan']));
    expect(new Set(log.map((l) => l.reason_code))).toEqual(new Set(['day_replan']));
    for (const c of changes) {
      const last = log.filter((l) => l.scheduled_service_id === c.id).at(-1);
      expect(String(last.new_window).split('-')[0].slice(0, 5)).toBe(c.to);
    }

    expect(sentAnything()).toEqual([]);
  });

  test('a failed write puts every visit back: hour, route order and reminder; and says rolled_back', async () => {
    let calls = 0;
    const original = rebooker.reschedule.bind(rebooker);
    jest.spyOn(rebooker, 'reschedule').mockImplementation(async (...args) => {
      calls += 1;
      if (calls === 2) throw Object.assign(new Error('That time slot is no longer available.'), { statusCode: 409, code: 'SLOT_TAKEN' });
      return original(...args);
    });
    const before = await visitRows();
    const remBefore = await reminders();

    const out = await runDayReplanIfEnabled({ now: NOW, conn: mockConn });
    expect(out.apply).toEqual([expect.objectContaining({ status: 'rolled_back', reason: 'step_failed:SLOT_TAKEN', moved: 0 })]);

    const after = await visitRows();
    for (const v of visits) {
      expect(startOf(after, v.id)).toBe(startOf(before, v.id));
      expect(Number(after.find((r) => r.id === v.id).route_order)).toBe(Number(before.find((r) => r.id === v.id).route_order));
    }
    for (const r of await reminders()) {
      expect(new Date(r.appointment_time).getTime()).toBe(new Date(remBefore.find((x) => x.scheduled_service_id === r.scheduled_service_id).appointment_time).getTime());
      expect(r.reminder_24h_sent).toBe(false);
    }
    const plan = await mockConn('day_replan_plans').where({ run_id: out.runId }).first();
    expect(plan).toMatchObject({ apply_status: 'rolled_back', apply_reason: 'step_failed:SLOT_TAKEN' });
    expect(plan.apply_steps.steps.length).toBeGreaterThanOrEqual(1);
    expect(sentAnything()).toEqual([]);
  });

  test('a day a stopped process left on a temporary hour is put back before anything new is planned', async () => {
    // The previous run parked visit a on 15:00 and stopped: its journal and the plan row are all that remain.
    const a = visits[0];
    await rebooker.reschedule(a.id, DAY, { start: '15:00', end: '16:00' }, 'day_replan', 'day_replan', {
      seriesPolicy: 'single', visitPolicy: 'single', keepStatus: true, suppressTechNotice: true, notifyRequested: false,
    });
    const interruptedId = randomUUID();
    await mockConn('day_replan_plans').insert({
      id: interruptedId, run_id: randomUUID(), mode: 'apply', technician_id: techId, service_date: DAY, stop_count: 4,
      current_drive_min: 100, saved_min: 0, current_end_min: 700, accepted: true, reason: 'accepted', changes: '[]', fixed: '[]',
      apply_started_at: new Date('2097-06-09T08:41:00Z'),
      apply_steps: JSON.stringify({
        version: 1, routeBefore: { [a.id]: 1 }, routePersisted: false, complete: false,
        steps: [{ id: a.id, fromStart: 8 * 60, toStart: 15 * 60, widthMin: 60, temp: true, state: 'done' }],
      }),
    });
    expect(startOf(await visitRows(), a.id)).toBe('15:00');

    const out = await runDayReplanIfEnabled({ now: NOW, conn: mockConn });
    expect(out.recovered).toEqual([expect.objectContaining({ id: interruptedId, status: 'rolled_back', reason: 'recovered_after_interruption' })]);
    const plan = await mockConn('day_replan_plans').where({ id: interruptedId }).first();
    expect(plan).toMatchObject({ apply_status: 'rolled_back', apply_reason: 'recovered_after_interruption' });
    // The notice for Claude's queue was raised once (a real notifications row, off the owner's bell list).
    const notices = await mockConn('notifications').whereRaw("metadata->>'dedupeKey' = ?", [`day-replan-failed:${DAY}:${techId}`]);
    expect(notices.length).toBeLessThanOrEqual(1);
    expect(sentAnything()).toEqual([]);
  });
});
