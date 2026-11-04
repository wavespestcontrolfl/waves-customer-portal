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
 *   - a day left mid-apply by a stopped process is put back by the next run before anything new is planned: after a
 *     forward step, with only an intent journaled, in the middle of a rollback (an undo that landed is not repeated,
 *     the one that did not is finished), and with the reminder of an undone visit re-synced to its hour;
 *   - the rollback is fenced: a visit a person moved after our step is left alone, the plan says 'failed' and ONE
 *     notice for Claude's queue is raised, while the other visits are put back.
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

  // ---- a stopped process: the journal is hand-built, every move is the real rebooker's ----------------------------

  const OPTS = { seriesPolicy: 'single', visitPolicy: 'single', keepStatus: true, suppressTechNotice: true, notifyRequested: false };
  const minutes = (value) => { const [h, m] = String(value).slice(0, 5).split(':').map(Number); return h * 60 + m; };
  const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
  const moveTo = (id, start, by = 'day_replan') => rebooker.reschedule(id, DAY, { start, end: hhmm(minutes(start) + 60) }, by, by, OPTS);
  const setReminder = (id, start) => mockConn('appointment_reminders').where({ scheduled_service_id: id }).update({ appointment_time: parseETDateTime(`${DAY}T${start}`) });
  const reminderMs = async (id) => new Date((await mockConn('appointment_reminders').where({ scheduled_service_id: id }).first()).appointment_time).getTime();

  /** Makes one journaled step AND performs it for real: the fingerprints are those of the rows before and after. */
  async function forwardStepFor(v, start, extra = {}) {
    const { _internals: internals } = require('../services/day-replan/apply');
    const deps = require('../services/day-replan')._internals.applyDeps();
    const row = await mockConn('scheduled_services').where({ id: v.id }).first();
    const step = { id: v.id, fromStart: minutes(row.window_start), toStart: minutes(start), widthMin: 60, state: 'done', ...extra };
    step.before = internals.fingerprintOf(row, deps);
    step.after = internals.fingerprintOf(internals.afterStep(row, step), deps);
    await moveTo(v.id, start);
    await setReminder(v.id, start); // the silent reminder sync of that step
    return step;
  }

  async function stoppedPlan(steps, extra = {}) {
    const id = randomUUID();
    await mockConn('day_replan_plans').insert({
      id, run_id: randomUUID(), mode: 'apply', technician_id: techId, service_date: DAY, stop_count: 4,
      current_drive_min: 100, saved_min: 0, current_end_min: 700, accepted: true, reason: 'accepted', changes: '[]', fixed: '[]',
      apply_started_at: new Date('2097-06-09T08:41:00Z'),
      apply_steps: JSON.stringify({ version: 1, routeBefore: Object.fromEntries(visits.map((v, i) => [v.id, i + 1])), routePersisted: false, complete: false, steps, ...extra }),
    });
    return id;
  }

  // Recovery runs first in shadow mode too; a shadow run then writes nothing but its own plan rows.
  const recover = async () => {
    process.env.GATE_DAY_REPLAN = 'shadow';
    return runDayReplanIfEnabled({ now: NOW, conn: mockConn });
  };
  const noticeCount = async () => (await mockConn('notifications').whereRaw("metadata->>'dedupeKey' = ?", [`day-replan-failed:${DAY}:${techId}`])).length;

  test('crash after a forward step: recovery undoes it, the reminder and the plan row follow, one notice', async () => {
    const [a] = visits;
    const step = await forwardStepFor(a, '15:00');
    expect(startOf(await visitRows(), a.id)).toBe('15:00');
    const id = await stoppedPlan([step]);

    const out = await recover();
    expect(out.recovered).toEqual([expect.objectContaining({ id, status: 'rolled_back', reason: 'recovered_after_interruption' })]);
    expect(startOf(await visitRows(), a.id)).toBe('08:00');
    expect(await reminderMs(a.id)).toBe(TZ_START('08:00'));
    expect(await mockConn('day_replan_plans').where({ id }).first()).toMatchObject({ apply_status: 'rolled_back', apply_reason: 'recovered_after_interruption' });
    expect(await noticeCount()).toBe(1);
    const journal = (await mockConn('day_replan_plans').where({ id }).first()).apply_steps;
    expect(journal.steps[0]).toMatchObject({ state: 'done', undo: 'done' });
    expect(sentAnything()).toEqual([]);
  });

  test('crash with only an intent journaled (the step never landed): nothing moves and the plan closes', async () => {
    const [a] = visits;
    const { _internals: internals } = require('../services/day-replan/apply');
    const deps = require('../services/day-replan')._internals.applyDeps();
    const row = await mockConn('scheduled_services').where({ id: a.id }).first();
    const step = { id: a.id, fromStart: 8 * 60, toStart: 15 * 60, widthMin: 60, state: 'intent' };
    step.before = internals.fingerprintOf(row, deps);
    step.after = internals.fingerprintOf(internals.afterStep(row, step), deps);
    const spy = jest.spyOn(rebooker, 'reschedule');
    const id = await stoppedPlan([step]);

    const out = await recover();
    expect(out.recovered).toEqual([expect.objectContaining({ id, status: 'rolled_back' })]);
    expect(spy).not.toHaveBeenCalled();
    expect(startOf(await visitRows(), a.id)).toBe('08:00');
  });

  test('crash mid-rollback: the undo that landed is not repeated, the one that did not is finished, and the reminders follow', async () => {
    const [a, b] = visits;
    const stepA = await forwardStepFor(a, '15:00');
    const stepB = await forwardStepFor(b, '16:00');
    // The rollback undid b (the move landed, its reminder sync never ran, the journal still says intent).
    await moveTo(b.id, '09:00');
    await setReminder(b.id, '16:00'); // the process stopped before the reminder followed the undo
    const logBefore = (await mockConn('reschedule_log').where({ scheduled_service_id: b.id })).length;
    expect(await reminderMs(b.id)).toBe(TZ_START('16:00'));
    const id = await stoppedPlan([stepA, { ...stepB, undo: 'intent' }], { rollback: true });
    const spy = jest.spyOn(rebooker, 'reschedule');

    const out = await recover();
    expect(out.recovered).toEqual([expect.objectContaining({ id, status: 'rolled_back' })]);
    // Only a was moved; b was not written again.
    expect(spy.mock.calls.map(([visit]) => visit)).toEqual([a.id]);
    expect((await mockConn('reschedule_log').where({ scheduled_service_id: b.id })).length).toBe(logBefore);
    const rows = await visitRows();
    expect([startOf(rows, a.id), startOf(rows, b.id)]).toEqual(['08:00', '09:00']);
    // Both reminders follow their visits' hours again, with the 24-hour leg still pending.
    expect(await reminderMs(a.id)).toBe(TZ_START('08:00'));
    expect(await reminderMs(b.id)).toBe(TZ_START('09:00'));
    for (const r of await reminders()) expect(r.reminder_24h_sent).toBe(false);
    expect(sentAnything()).toEqual([]);
  });

  test('a person moves a visit after our step: it is left alone, the other visits go back, the plan says failed, one notice', async () => {
    const [a, b] = visits;
    const stepA = await forwardStepFor(a, '15:00');
    const stepB = await forwardStepFor(b, '16:00');
    await moveTo(a.id, '14:00', 'admin'); // a person's move, after our step
    await setReminder(a.id, '14:00');
    const id = await stoppedPlan([stepA, stepB]);
    const spy = jest.spyOn(rebooker, 'reschedule');

    const out = await recover();
    expect(out.status).toBe('completed_with_errors');
    expect(out.recovered).toEqual([expect.objectContaining({ id, status: 'failed', reason: 'rollback_failed:DIVERGED' })]);
    expect(spy.mock.calls.map(([visit]) => visit)).toEqual([b.id]);
    const rows = await visitRows();
    expect([startOf(rows, a.id), startOf(rows, b.id)]).toEqual(['14:00', '09:00']);
    // The person's move keeps its own reminder time; b's was put back.
    expect(await reminderMs(a.id)).toBe(TZ_START('14:00'));
    expect(await reminderMs(b.id)).toBe(TZ_START('09:00'));
    // The route numbers are not rewritten under a day a person changed.
    expect((await visitRows()).map((r) => Number(r.route_order)).sort()).toEqual([1, 2, 3, 4]);
    expect(await mockConn('day_replan_plans').where({ id }).first()).toMatchObject({ apply_status: 'failed' });
    expect(await noticeCount()).toBe(1);
    expect(sentAnything()).toEqual([]);
  });

  test('a finished day whose last reminder sync was cut short is re-synced to the final hour and recorded applied', async () => {
    const [a] = visits;
    const step = await forwardStepFor(a, '15:00');
    await setReminder(a.id, '08:00'); // the sync never ran
    const id = await stoppedPlan([step], { complete: true, routePersisted: true });
    const spy = jest.spyOn(rebooker, 'reschedule');

    const out = await recover();
    expect(out.recovered).toEqual([expect.objectContaining({ id, status: 'applied', reason: 'applied_recovered' })]);
    expect(spy).not.toHaveBeenCalled();
    expect(startOf(await visitRows(), a.id)).toBe('15:00');
    expect(await reminderMs(a.id)).toBe(TZ_START('15:00'));
    expect(await noticeCount()).toBe(0);
    expect(sentAnything()).toEqual([]);
  });
});
