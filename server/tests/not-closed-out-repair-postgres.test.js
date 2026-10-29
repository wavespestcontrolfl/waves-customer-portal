// GATE_NOT_CLOSED_OUT_QUEUE: the nightly repair's new SQL, on PostgreSQL (owner ruling
// 2026-10-03, the five known limits of #5769). The unit suites prove the logic on fakes;
// this one proves the queries parse and pick the right rows:
//   - the pending-task look-back (90 days, gap 1) and the legacy-task match (no
//     metadata.source + the old subject, gap 4) in reconcileOutreach;
//   - the no-show Quick Move read (reason customer_noshow + new_date set, gap 2);
//   - the job_status_history lookup behind reopenUnconfirmedNoShows (gap 5).
// Gate off touches nothing. Admin-side only: the alert writer is mocked and nothing can
// reach a customer. CI's DATABASE_URL pass runs this; fixture rows live in a unique
// schema that is removed after the suite. Synthetic data only.
const SKIP = !process.env.DATABASE_URL;
const knex = require('knex');
const { randomUUID } = require('crypto');
let mockConn;
jest.mock('../models/db', () => {
  const proxy = (...args) => mockConn(...args);
  proxy.raw = (...args) => mockConn.raw(...args);
  proxy.transaction = (...args) => mockConn.transaction(...args);
  return proxy;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
// The card writer is not under test here (its SQL has its own suites).
const mockCreateAlertOnce = jest.fn(async () => ({ created: true, row: { id: 'alert-new' } }));
jest.mock('../services/dispatch-alerts', () => ({
  createAlertOnce: (...a) => mockCreateAlertOnce(...a),
  resolveAlert: jest.fn(async ({ id }) => ({ id })),
}));

const { gates } = require('../config/feature-gates');
const notClosedOut = require('../services/not-closed-out');
const missedAppointment = require('../services/workflows/missed-appointment');

jest.setTimeout(30000);
(SKIP ? describe.skip : describe)('not-closed-out nightly repair, retry gaps, on PostgreSQL', () => {
  let database;
  const schema = `nco_repair_${randomUUID().replaceAll('-', '')}`;
  const tables = ['customers', 'scheduled_services', 'reschedule_log', 'customer_interactions', 'job_status_history', 'dispatch_alerts'];
  const savedGate = gates.notClosedOutQueue;

  const daysAgo = (n) => new Date(Date.now() - n * 86400000);
  const STAFF = randomUUID();
  const SLOT = { date: '2026-09-29', start: '09:00:00', end: '10:00:00' };
  const LEGACY_SUBJECT = 'Recommended outreach: 3 missed appointments in 90 days';

  beforeAll(async () => {
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 3 } });
    await database.raw('CREATE SCHEMA ??', [schema]);
    // no foreign keys are copied, so fixtures need no parent rows beyond what the code reads
    for (const table of tables) await database.raw('CREATE TABLE ??.?? (LIKE public.?? INCLUDING DEFAULTS)', [schema, table, table]);
    mockConn = database;
  });
  beforeEach(() => {
    mockCreateAlertOnce.mockClear();
    gates.notClosedOutQueue = true;
  });
  afterEach(async () => {
    for (const table of tables) await database.raw('TRUNCATE TABLE ??.??', [schema, table]);
  });
  afterAll(async () => {
    gates.notClosedOutQueue = savedGate;
    await database.raw('DROP SCHEMA ?? CASCADE', [schema]);
    await database.destroy();
  });

  const customer = async () => {
    const id = randomUUID();
    await database('customers').insert({ id, first_name: 'Pat', last_name: 'Synthetic', phone: `+1941555${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}` });
    return id;
  };
  const visit = async (customerId, over = {}) => {
    const id = randomUUID();
    await database('scheduled_services').insert({
      id, customer_id: customerId, status: 'pending', service_type: 'Pest Control',
      scheduled_date: SLOT.date, window_start: SLOT.start, window_end: SLOT.end, ...over,
    });
    return id;
  };
  // a flagged row; each call is its own visit unless `visitId` is given (distinct occurrences count apart)
  const miss = async (customerId, over = {}) => {
    const id = randomUUID();
    await database('reschedule_log').insert({
      id, customer_id: customerId, scheduled_service_id: over.scheduled_service_id || await visit(customerId),
      reason_code: 'customer_noshow', initiated_by: 'system', original_date: SLOT.date,
      original_window: `${SLOT.start}-${SLOT.end}`, created_at: daysAgo(1), ...over,
    });
    return id;
  };
  const confirmedMiss = (customerId, over = {}) => miss(customerId, { miss_confirmed_at: daysAgo(1), miss_confirmed_by: 'dispatch', ...over });
  const task = async (customerId, over = {}) => {
    const id = randomUUID();
    await database('customer_interactions').insert({
      id, customer_id: customerId, interaction_type: 'task', channel: 'internal', status: 'pending',
      subject: 'Recommended outreach: 2 missed appointments in 90 days', body: 'Recommend a phone call.',
      metadata: JSON.stringify({ source: 'missed_appointment_threshold' }), created_at: daysAgo(1), ...over,
    });
    return id;
  };
  const taskRow = (id) => database('customer_interactions').where({ id }).first();
  const taskCount = async (customerId) => Number((await database('customer_interactions').where({ customer_id: customerId, interaction_type: 'task' }).count('* as n').first()).n);

  describe('gap 1: the withdrawal look-back is the 90-day count window', () => {
    test('a pending task of a customer with no misses left is cancelled up to 90 days old, not beyond; a second run does nothing', async () => {
      const c30 = await customer();
      const c120 = await customer();
      const t30 = await task(c30, { created_at: daysAgo(30) });
      const t120 = await task(c120, { created_at: daysAgo(120) });
      expect(await missedAppointment.reconcileOutreach()).toEqual({ withdrawn: 1, raised: 0 });
      expect((await taskRow(t30)).status).toBe('cancelled');
      expect((await taskRow(t30)).body).toMatch(/^Withdrawn: /);
      expect((await taskRow(t120)).status).toBe('pending');
      expect(await missedAppointment.reconcileOutreach()).toEqual({ withdrawn: 0, raised: 0 });
    });

    test('a task whose customer still has two person-marked misses stays', async () => {
      const c = await customer();
      const t = await task(c, { created_at: daysAgo(30) });
      await confirmedMiss(c, { created_at: daysAgo(40), miss_confirmed_at: daysAgo(40) });
      await confirmedMiss(c, { created_at: daysAgo(35), miss_confirmed_at: daysAgo(35) });
      expect(await missedAppointment.reconcileOutreach()).toEqual({ withdrawn: 0, raised: 0 });
      expect((await taskRow(t)).status).toBe('pending');
    });
  });

  describe('gap 4: a pending task from before the queue (no metadata.source)', () => {
    test('retired only when it matches the old subject and fewer than 2 person-marked misses remain', async () => {
      const cGone = await customer();
      const cOther = await customer();
      const cTwo = await customer();
      const cSourced = await customer();
      const legacyGone = await task(cGone, { metadata: null, subject: LEGACY_SUBJECT, created_at: daysAgo(200) });
      const otherKind = await task(cOther, { metadata: null, subject: 'Call back about the gate code' });
      const legacyKept = await task(cTwo, { metadata: null, subject: LEGACY_SUBJECT });
      // two person-marked misses, confirmed more than 7 days ago (so the confirmed-miss read does not apply)
      await confirmedMiss(cTwo, { created_at: daysAgo(20), miss_confirmed_at: daysAgo(20) });
      await confirmedMiss(cTwo, { created_at: daysAgo(19), miss_confirmed_at: daysAgo(19) });
      // a one-off task with an empty metadata object and the old subject is legacy too; one with a source is not
      const emptyMeta = await task(cGone, { metadata: JSON.stringify({}), subject: LEGACY_SUBJECT });
      const sourced = await task(cSourced, { subject: LEGACY_SUBJECT, created_at: daysAgo(200) });
      expect(await missedAppointment.reconcileOutreach()).toEqual({ withdrawn: 2, raised: 0 });
      expect(await taskRow(legacyGone)).toMatchObject({ status: 'cancelled' });
      expect((await taskRow(legacyGone)).body).toMatch(/^Retired: /);
      expect((await taskRow(emptyMeta)).status).toBe('cancelled');
      expect((await taskRow(otherKind)).status).toBe('pending');
      expect((await taskRow(legacyKept)).status).toBe('pending');
      // beyond 90 days and carrying a source: outside the pending look-back, and not legacy
      expect((await taskRow(sourced)).status).toBe('pending');
      expect(await missedAppointment.reconcileOutreach()).toEqual({ withdrawn: 0, raised: 0 });
    });
  });

  describe('gap 2: a no-show Quick Move whose immediate evaluation failed', () => {
    test('a recent Quick Move row (customer_noshow + new_date) gets its task, once; other rows are skipped', async () => {
      const cMove = await customer();
      const cOld = await customer();
      const cWeather = await customer();
      const cHasTask = await customer();
      // the customer's first miss is a confirmed one outside the 7-day read; the Quick Move is the second
      await confirmedMiss(cMove, { created_at: daysAgo(20), miss_confirmed_at: daysAgo(20) });
      const quickMove = await miss(cMove, { new_date: '2026-10-30', initiated_by: 'admin', created_at: daysAgo(2) });
      // a Quick Move older than 7 days is not read
      await confirmedMiss(cOld, { created_at: daysAgo(20), miss_confirmed_at: daysAgo(20) });
      await miss(cOld, { new_date: '2026-10-30', initiated_by: 'admin', created_at: daysAgo(10) });
      // new_date set but not a no-show: not a candidate (and does not count)
      await confirmedMiss(cWeather, { created_at: daysAgo(20), miss_confirmed_at: daysAgo(20) });
      await miss(cWeather, { reason_code: 'weather_rain', new_date: '2026-10-30', created_at: daysAgo(2) });
      // a task already in the window: no second one
      await confirmedMiss(cHasTask, { created_at: daysAgo(20), miss_confirmed_at: daysAgo(20) });
      await miss(cHasTask, { new_date: '2026-10-30', initiated_by: 'admin', created_at: daysAgo(2) });
      await task(cHasTask, { created_at: daysAgo(1) });

      expect(await missedAppointment.reconcileOutreach()).toEqual({ withdrawn: 0, raised: 1 });
      const created = await database('customer_interactions').where({ customer_id: cMove, interaction_type: 'task' });
      expect(created).toHaveLength(1);
      expect(created[0].metadata).toEqual({ source: 'missed_appointment_threshold', log_id: quickMove });
      expect(await taskCount(cOld)).toBe(0);
      expect(await taskCount(cWeather)).toBe(0);
      expect(await taskCount(cHasTask)).toBe(1);
      // idempotent: the task now stands in the window
      expect(await missedAppointment.reconcileOutreach()).toEqual({ withdrawn: 0, raised: 0 });
      expect(await taskCount(cMove)).toBe(1);
    });
  });

  describe('gap 5: a dispatch no-show whose reopen failed', () => {
    // a row settled earlier whose visit a person then marked no_show in the same slot
    const settledNoShow = async (cust, { resolution = 'backlog', resolvedDaysAgo = 5, history } = {}) => {
      const visitId = await visit(cust, { status: 'no_show' });
      const logId = await miss(cust, { scheduled_service_id: visitId, resolved_at: daysAgo(resolvedDaysAgo), resolution, resolved_by: 'migration' });
      if (history) await database('job_status_history').insert({ id: randomUUID(), job_id: visitId, from_status: 'confirmed', to_status: 'no_show', ...history });
      return { visitId, logId };
    };
    const logRow = (id) => database('reschedule_log').where({ id }).first();

    test('reopened only when a person marked the no-show, within 14 days, after the row settled; a second run does nothing', async () => {
      const cOk = await customer();
      const cSystem = await customer();
      const cOld = await customer();
      const cBefore = await customer();
      const ok = await settledNoShow(cOk, { history: { transitioned_by: STAFF, transitioned_at: daysAgo(2) } });
      const system = await settledNoShow(cSystem, { history: { transitioned_by: null, transitioned_at: daysAgo(2) } });
      const old = await settledNoShow(cOld, { resolvedDaysAgo: 40, history: { transitioned_by: STAFF, transitioned_at: daysAgo(20) } });
      // "Not a miss" given AFTER the mark stands
      const before = await settledNoShow(cBefore, { resolution: 'not_a_miss', resolvedDaysAgo: 1, history: { transitioned_by: STAFF, transitioned_at: daysAgo(3) } });

      expect(await notClosedOut.reopenUnconfirmedNoShows()).toEqual({ reopened: 1 });
      expect(await logRow(ok.logId)).toMatchObject({ resolved_at: null, resolution: null, miss_confirmed_by: 'dispatch' });
      expect((await logRow(ok.logId)).miss_confirmed_at).toBeInstanceOf(Date);
      expect(mockCreateAlertOnce).toHaveBeenCalledTimes(1);
      expect(mockCreateAlertOnce.mock.calls[0][0]).toMatchObject({ jobId: ok.visitId, payload: expect.objectContaining({ log_id: ok.logId, miss_confirmed: true }) });
      for (const left of [system, old, before]) {
        const row = await logRow(left.logId);
        expect(row.resolved_at).not.toBeNull();
        expect(row.miss_confirmed_at).toBeNull();
      }
      expect((await logRow(before.logId)).resolution).toBe('not_a_miss');
      expect(await notClosedOut.reopenUnconfirmedNoShows()).toEqual({ reopened: 0 });
      expect(mockCreateAlertOnce).toHaveBeenCalledTimes(1);
    });

    test('reconcileOpenRows runs it with the gate on and counts the replacement card in raised', async () => {
      const c = await customer();
      await settledNoShow(c, { history: { transitioned_by: STAFF, transitioned_at: daysAgo(1) } });
      expect(await notClosedOut.reconcileOpenRows()).toEqual({ raised: 1, settled: 0 });
    });
  });

  describe('gate off: nothing is touched', () => {
    test('legacy tasks, old sourced tasks, Quick Moves and reopenable rows are all left as they are', async () => {
      gates.notClosedOutQueue = false;
      const cLegacy = await customer();
      const cOld = await customer();
      const cMove = await customer();
      const cReopen = await customer();
      const legacy = await task(cLegacy, { metadata: null, subject: LEGACY_SUBJECT });
      const old = await task(cOld, { created_at: daysAgo(30) });
      await confirmedMiss(cMove, { created_at: daysAgo(20), miss_confirmed_at: daysAgo(20) });
      await miss(cMove, { new_date: '2026-10-30', initiated_by: 'admin', created_at: daysAgo(2) });
      const visitId = await visit(cReopen, { status: 'no_show' });
      const logId = await miss(cReopen, { scheduled_service_id: visitId, resolved_at: daysAgo(5), resolution: 'backlog', resolved_by: 'migration' });
      await database('job_status_history').insert({ id: randomUUID(), job_id: visitId, from_status: 'confirmed', to_status: 'no_show', transitioned_by: STAFF, transitioned_at: daysAgo(1) });

      expect(await missedAppointment.reconcileOutreach()).toEqual({ withdrawn: 0, raised: 0 });
      expect(await notClosedOut.reconcileOpenRows()).toEqual({ raised: 0, settled: 0 });
      expect((await taskRow(legacy)).status).toBe('pending');
      expect((await taskRow(old)).status).toBe('pending');
      expect(await taskCount(cMove)).toBe(0);
      const row = await database('reschedule_log').where({ id: logId }).first();
      expect(row.resolved_at).not.toBeNull();
      expect(row.miss_confirmed_at).toBeNull();
      expect(mockCreateAlertOnce).not.toHaveBeenCalled();
    });
  });
});
