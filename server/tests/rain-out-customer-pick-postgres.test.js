// Quick Move "let the customer pick a day" (GATE_QUICKMOVE_CUSTOMER_PICK):
// RainOut.handOffToCustomer's transaction on PostgreSQL. CI's DB-gated step
// discovers this suite. Temporary tables copy the migrated column types,
// hold synthetic records only, and roll back. The real rebooker stamps,
// plan-taken-hour fields, reminder pre-close, consent and suppression
// validators and template renderer run; the link builder, the send, the
// technician notice and Auto-Dispatch's fallback switch are stubs.
const SKIP = !process.env.DATABASE_URL;
const describeWithDatabase = SKIP ? describe.skip : describe;
jest.mock('../models/db', () => {
  const db = (...args) => db.connection(...args);
  db.transaction = (run) => db.connection.transaction(run);
  db.raw = (...args) => db.connection.raw(...args);
  Object.defineProperty(db, 'schema', { get: () => db.connection.schema });
  Object.defineProperty(db, 'fn', { get: () => db.connection.fn });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/reschedule-link', () => ({ buildRescheduleLink: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(),
  normalizeRecipient: (phone) => phone,
}));
jest.mock('../services/tech-visit-notifications', () => ({ notifyVisitRescheduled: jest.fn().mockResolvedValue(null) }));
jest.mock('../services/auto-dispatch/config', () => ({
  ...jest.requireActual('../services/auto-dispatch/config'),
  isCustomerRecurringDispatchEnabled: jest.fn(() => true),
}));

describeWithDatabase('Quick Move customer-pick hand-off on PostgreSQL', () => {
  const { randomUUID } = require('crypto');
  const db = require('../models/db');
  const { buildRescheduleLink } = require('../services/reschedule-link');
  const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
  const SmartRebooker = require('../services/rebooker');
  const { etDateString, addETDays } = require('../utils/datetime-et');
  const { BODY } = require('../models/migrations/20261101164500_rain_out_customer_pick')._test;
  const RainOut = require('../services/rain-out');
  let database;
  let trx;
  const LINK = 'https://portal.wavespestcontrol.com/l/k3j9m2x7qp';
  const PHONE = '+19415550100';

  beforeAll(async () => {
    const connection = process.env.DATABASE_URL;
    const url = new URL(connection);
    const ownedQA = process.env.WAVES_LOCAL_DEV === '1'
      && url.pathname === `/waves_qa_${String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '')}`;
    if (!['localhost', '127.0.0.1'].includes(url.hostname) && !ownedQA) {
      throw new Error('Use the disposable CI database or this managed worktree\'s private QA database');
    }
    database = require('knex')({ client: 'pg', connection });
    trx = await database.transaction();
    db.connection = trx;
    await trx.raw(`
      CREATE TEMP TABLE scheduled_services AS SELECT * FROM public.scheduled_services WITH NO DATA;
      CREATE TEMP TABLE customers AS SELECT * FROM public.customers WITH NO DATA;
      CREATE TEMP TABLE appointment_reminders AS SELECT * FROM public.appointment_reminders WITH NO DATA;
      CREATE TEMP TABLE reschedule_log AS SELECT * FROM public.reschedule_log WITH NO DATA;
      CREATE TEMP TABLE job_status_history AS SELECT * FROM public.job_status_history WITH NO DATA;
      CREATE TEMP TABLE sms_templates AS SELECT * FROM public.sms_templates WITH NO DATA;
      CREATE TEMP TABLE notification_prefs AS SELECT * FROM public.notification_prefs WITH NO DATA;
      CREATE TEMP TABLE messaging_suppression AS SELECT * FROM public.messaging_suppression WITH NO DATA;
    `);
  });
  afterAll(async () => {
    await trx?.rollback();
    await database?.destroy();
  });

  let customerId;
  let serviceId;
  let today;
  beforeEach(async () => {
    jest.clearAllMocks();
    process.env.GATE_QUICKMOVE_CUSTOMER_PICK = 'true';
    await trx.raw('TRUNCATE scheduled_services, customers, appointment_reminders, reschedule_log, job_status_history, sms_templates, notification_prefs, messaging_suppression');
    today = etDateString();
    customerId = randomUUID();
    serviceId = randomUUID();
    await trx('customers').insert({ id: customerId, first_name: 'Maria', last_name: 'Sample', phone: PHONE, active: true, latitude: 27.49, longitude: -82.57 });
    await trx('sms_templates').insert({
      id: randomUUID(), template_key: 'rain_out_customer_pick_v1', name: 'Quick Move - Customer Picks a Day',
      category: 'service', body: BODY, is_active: true, created_at: new Date(), updated_at: new Date(),
    });
    buildRescheduleLink.mockResolvedValue({ url: LINK, line: '' });
    sendCustomerMessage.mockResolvedValue({ sent: true, providerMessageId: `SM${'b'.repeat(32)}` });
    jest.spyOn(SmartRebooker, 'applyLiveMovePostCommitEffects').mockResolvedValue({ techCleared: true });
  });
  afterEach(() => {
    delete process.env.GATE_QUICKMOVE_CUSTOMER_PICK;
    jest.restoreAllMocks();
  });

  async function insertVisit(patch = {}) {
    const row = {
      id: serviceId, customer_id: customerId, technician_id: null, status: 'pending',
      scheduled_date: today, window_start: '09:00', window_end: '10:00', time_window: '9-11', window_display: '9:00 AM',
      route_order: 3, is_recurring: true, recurring_parent_id: randomUUID(), service_type: 'Quarterly Pest Control Service',
      customer_confirmed: true, confirmed_at: new Date(), track_state: 'scheduled', estimated_duration_minutes: 45,
      updated_at: new Date('2026-01-01T00:00:00Z'),
      ...patch,
    };
    await trx('scheduled_services').insert(row);
    await trx('appointment_reminders').insert({
      id: randomUUID(), scheduled_service_id: serviceId, customer_id: customerId,
      appointment_time: new Date(`${today}T14:00:00Z`), source: 'system_seed', cancelled: false,
      confirmation_sent: false, reminder_72h_sent: false, reminder_24h_sent: false,
      suppressed_by_sibling: false, windows_preclosed: false, created_at: new Date(), updated_at: new Date(),
    });
    return row;
  }
  const handOff = (overrides = {}) => RainOut.handOffToCustomer({
    serviceId, reasonCode: 'weather_rain', initiatedBy: 'tech', actorUserId: null, operatorInitiated: true, ...overrides,
  });
  const visitRow = () => trx('scheduled_services').where({ id: serviceId }).first();
  const dateOnly = (value) => (value instanceof Date ? etDateString(new Date(value.getTime() + 12 * 3600 * 1000)) : String(value).slice(0, 10));

  test('a pending plan visit leaves the route: due date, no window, marker set, reminder pre-closed, one log row, one text', async () => {
    await insertVisit();
    const before = await visitRow();
    const due = etDateString(addETDays(new Date(), 8));
    const { pickBy } = RainOut._test.pickDates(new Date());

    const result = await handOff();

    expect(result).toEqual(expect.objectContaining({ ok: true, dueDate: due, textSent: true, needsAttention: [] }));
    const after = await visitRow();
    expect(dateOnly(after.scheduled_date)).toBe(due);
    expect(dateOnly(after.recurring_dispatch_due_date)).toBe(due);
    expect(after).toEqual(expect.objectContaining({
      window_start: null, window_end: null, time_window: null, window_display: null, route_order: null,
      status: 'pending', customer_confirmed: false, confirmed_at: null,
      date_exception: true, date_exception_source: 'tech',
      // Untouched: who, what and how long.
      technician_id: null, customer_id: customerId, service_type: 'Quarterly Pest Control Service', estimated_duration_minutes: 45,
      track_state: 'scheduled',
    }));
    expect(new Date(after.customer_pick_by).toISOString()).toBe(pickBy.toISOString());
    expect(dateOnly(after.date_exception_cadence_date)).toBe(today);
    expect(after.track_token_expires_at).not.toBeNull();
    expect(new Date(after.updated_at).getTime()).toBeGreaterThan(new Date(before.updated_at).getTime());

    const reminder = await trx('appointment_reminders').where({ scheduled_service_id: serviceId }).first();
    expect(reminder).toEqual(expect.objectContaining({
      windows_preclosed: true, suppressed_by_sibling: true, confirmation_sent: true, reminder_72h_sent: true, reminder_24h_sent: true,
    }));

    const logs = await trx('reschedule_log').where({ scheduled_service_id: serviceId });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toEqual(expect.objectContaining({
      customer_id: customerId, reason_code: 'customer_pick', initiated_by: 'tech', notes: 'weather_rain',
      original_window: '09:00:00-10:00:00', new_window: null,
      occurrence_service_type: 'Quarterly Pest Control Service',
    }));
    expect(dateOnly(logs[0].original_date)).toBe(today);
    expect(dateOnly(logs[0].new_date)).toBe(due);
    expect(await trx('job_status_history').where({ job_id: serviceId })).toEqual([]);

    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(sendCustomerMessage.mock.calls[0][0].body).toMatch(/^Hi Maria - rain is moving through your area this (morning|afternoon|evening), so we need to move your Quarterly Pest Control Service\. Pick a new time here: portal\.wavespestcontrol\.com\/l\/k3j9m2x7qp\n\nPlease pick by /);
  });

  test('Auto-Dispatch skips the handed-off visit until the pick-by instant passes, then loads it as a due-date visit', async () => {
    await insertVisit();
    await handOff();
    const { loadEligibleServices } = require('../services/auto-dispatch');
    const lockBoundary = etDateString(addETDays(new Date(), 14));
    const lookahead = etDateString(addETDays(new Date(), 90));
    const loaded = async () => (await loadEligibleServices(lockBoundary, lookahead, today)).map((row) => row.id);

    expect(await loaded()).not.toContain(serviceId);
    await trx('scheduled_services').where({ id: serviceId }).update({ customer_pick_by: new Date(Date.now() - 60 * 1000) });
    expect(await loaded()).toContain(serviceId);
  });

  test('an en route visit lands on confirmed with its tracker rewound and a status history row', async () => {
    await insertVisit({
      status: 'en_route', track_state: 'en_route', en_route_at: new Date(Date.now() - 20 * 60 * 1000),
      track_sms_sent_at: new Date(Date.now() - 20 * 60 * 1000),
    });

    const result = await handOff();

    expect(result.ok).toBe(true);
    const after = await visitRow();
    expect(after).toEqual(expect.objectContaining({
      status: 'confirmed', track_state: 'scheduled', en_route_at: null, track_sms_sent_at: null, arrival_sms_sent_at: null, window_start: null,
    }));
    const history = await trx('job_status_history').where({ job_id: serviceId });
    expect(history).toEqual([expect.objectContaining({ from_status: 'en_route', to_status: 'confirmed', transitioned_by: null })]);
    expect(SmartRebooker.applyLiveMovePostCommitEffects).toHaveBeenCalledWith(
      expect.objectContaining({ id: serviceId, status: 'confirmed' }), { toStatus: 'confirmed' },
    );
  });

  test('a change that lands between the checks and the lock: state_changed, the newer state kept, nothing logged or sent', async () => {
    await insertVisit();
    // The concurrent edit lands while the checks run (the link preview is the last read before the write).
    buildRescheduleLink.mockImplementationOnce(async () => {
      await trx('scheduled_services').where({ id: serviceId }).update({ window_start: '13:00' });
      return { url: LINK, line: '' };
    });

    expect(await handOff()).toEqual({ ok: false, reason: 'state_changed' });

    const after = await visitRow();
    expect(dateOnly(after.scheduled_date)).toBe(today);
    expect(String(after.window_start).slice(0, 5)).toBe('13:00');
    expect(after.customer_pick_by).toBeNull();
    expect(await trx('reschedule_log').where({ scheduled_service_id: serviceId })).toEqual([]);
    const reminder = await trx('appointment_reminders').where({ scheduled_service_id: serviceId }).first();
    expect(reminder.windows_preclosed).toBe(false);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('a technician caller is fenced on the locked row: a reassigned visit refuses', async () => {
    const techA = randomUUID();
    const techB = randomUUID();
    await insertVisit({ technician_id: techB });
    expect(await handOff({ requireAssignedTechnicianId: techA, actorUserId: techA })).toEqual({ ok: false, reason: 'state_changed' });
    expect(String((await visitRow()).window_start).slice(0, 5)).toBe('09:00');
  });

  test.each([
    ['a STOP on the phone (the canonical suppression list)', async () => {
      await trx('messaging_suppression').insert({ phone: PHONE, reason: 'stop_keyword', active: true, created_at: new Date() });
    }, 'customer_texts_off'],
    ['texts turned off in the customer\'s notification settings', async () => {
      await trx('notification_prefs').insert({ id: randomUUID(), customer_id: customerId, sms_enabled: false, created_at: new Date(), updated_at: new Date() });
    }, 'customer_texts_off'],
    ['the template row disabled (the ops kill switch)', async () => {
      await trx('sms_templates').update({ is_active: false });
    }, 'pick_template_unavailable'],
    // Auto-Dispatch could never book these if the customer does not pick.
    ['an active customer whose plan carries an unresolved plan_lapsed alert', async () => {
      const { recurring_parent_id: parentId } = await trx('scheduled_services').where({ id: serviceId }).first('recurring_parent_id');
      await trx('recurring_plan_alerts').insert({ recurring_parent_id: parentId, customer_id: customerId, alert_type: 'plan_lapsed' });
    }, 'plan_lapsed'],
    ['a visit staff locked from Auto-Dispatch', async () => {
      await trx('scheduled_services').where({ id: serviceId }).update({ auto_dispatch_locked: true });
    }, 'auto_dispatch_held'],
  ])('%s: refused before any write', async (_label, arrange, reason) => {
    await insertVisit();
    await arrange();
    const before = await visitRow();

    expect(await handOff()).toEqual({ ok: false, reason });

    expect(await visitRow()).toEqual(before);
    expect(await trx('reschedule_log').where({ scheduled_service_id: serviceId })).toEqual([]);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });
});
