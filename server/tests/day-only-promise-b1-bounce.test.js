// GATE_DAY_ONLY_PROMISE part B1 (Codex P1-2): a bounced DAY-ONLY text. Its audit row omits rendered_slot_ms (no hour was
// promised) but carries the non-promise guard fields guard_slot_ms / promised_date, which handleUndeliveredSms uses
// wherever it used rendered_slot_ms: whole-stop copy, the changed-date guard and the visit-scoped email key. The fallback
// email is itself day-only. The window bounce is unchanged. Harness from appointment-undelivered-sms-fallback.test.js.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../routes/admin-sms-templates', () => ({ getTemplate: jest.fn() }));
jest.mock('../services/customer-contact', () => ({
  getAppointmentContacts: jest.fn(() => []),
  isServiceContactRole: jest.fn(() => false),
}));
jest.mock('../services/appointment-email', () => ({
  sendAppointmentConfirmationEmail: jest.fn(async () => ({ ok: true })),
  sendAppointmentReminderEmail: jest.fn(async () => ({ ok: true })),
  sendTechEnRouteEmail: jest.fn(async () => ({ ok: true })),
}));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({})) }));
jest.mock('../services/estimate-card-holds', () => ({
  cardHoldReminderLine: jest.fn(async () => ''),
  cardHoldReminderNote: jest.fn(async () => ''),
}));

jest.mock('../services/time-promise', () => ({
  ...jest.requireActual('../services/time-promise'),
  loadPromiseLevels: jest.fn(),
}));

const db = require('../models/db');
const timePromise = require('../services/time-promise');
const logger = require('../services/logger');
const AppointmentEmail = require('../services/appointment-email');
const NotificationService = require('../services/notification-service');
const AppointmentReminders = require('../services/appointment-reminders');

// Minimal knex-style chainable query mock.
function chain({ first } = {}) {
  const q = {};
  ['where', 'whereIn', 'whereNot', 'whereNull', 'whereNotNull', 'whereNotExists', 'whereRaw', 'orderBy', 'select', 'join', 'leftJoin', 'andWhere'].forEach((m) => {
    q[m] = jest.fn(() => q);
  });
  q.update = jest.fn(async () => 1);
  q.pluck = jest.fn(async () => []);
  q.first = jest.fn(async () => first);
  q.then = (resolve, reject) => Promise.resolve([]).then(resolve, reject);
  return q;
}

function setDbQueues(queues) {
  const tableQueues = new Map(Object.entries(queues));
  db.mockImplementation((table) => {
    const queue = tableQueues.get(table);
    if (!queue || !queue.length) throw new Error(`Unexpected db table ${table}`);
    return queue.shift();
  });
  // db.raw is used for the "now() - interval" reconstruction branch.
  db.raw = jest.fn((sql) => sql);
  // The 30006 cache gate runs its check + write in a transaction under the
  // shared per-phone advisory lock; the mock trx is the db mock itself.
  db.transaction = jest.fn(async (fn) => fn(db));
}

beforeEach(() => {
  jest.clearAllMocks();
  // Three days before the visit: outside the 24.25 h cutoff, so a day-only recovery is still valid.
  jest.useFakeTimers().setSystemTime(new Date('2026-06-19T14:00:00.000Z'));
  timePromise.loadPromiseLevels.mockImplementation(async (_conn, ids) => new Map(ids.map((id) => [id, 'none'])));
});
afterEach(() => { jest.useRealTimers(); });

const SLOT = Date.parse('2026-06-22T13:00:00.000Z');
const DAY_META = { promise_level: 'day', window_unknown: true, guard_slot_ms: SLOT, promised_date: '2026-06-22' };

function groupedWorld({ metadata, visitDate = '2026-06-22' }) {
  const auditChain = chain({
    first: {
      channel: 'sms', purpose: 'appointment_reminder_72h', customer_id: 'c9',
      metadata: { original_message_type: 'reminder_72h', scheduled_service_id: 'ss-owner', ...metadata },
    },
  });
  const ownerRow = { cancelled: false, customer_id: 'c9', scheduled_service_id: 'ss-owner', appointment_time: '2026-06-22T14:00:00.000Z', service_type: 'Quarterly Pest Control' };
  const membersChain = chain({});
  membersChain.select = jest.fn(async () => [
    { appointment_time: '2026-06-22T14:00:00.000Z', scheduled_service_id: 'ss-owner', scheduled_date: visitDate, window_start: '10:00:00' },
    { appointment_time: '2026-06-22T13:00:00.000Z', scheduled_service_id: 'ss-sib', scheduled_date: visitDate, window_start: '09:00:00' },
  ]);
  const labelChain = chain({});
  labelChain.select = jest.fn(async () => [
    { scheduled_service_id: 'ss-owner', label: 'Quarterly Pest Control' },
    { scheduled_service_id: 'ss-sib', label: 'Mosquito Treatment' },
  ]);
  setDbQueues({
    messaging_audit_log: [auditChain],
    customers: [chain({ first: { id: 'c9', phone: '+19415551234', email: 'c9@example.com', line_type: null } })],
    appointment_reminders: [chain({ first: ownerRow }), chain({})],
    scheduled_services: [chain({ first: { visit_id: 'visit-9' } })],
    service_visits: [chain({ first: { id: 'visit-9', scheduled_date: visitDate } })],
    'scheduled_services as ss': [membersChain, labelChain],
    'scheduled_services as s': [chain({ first: null }), chain({ first: null })],
    scheduled_service_addons: [chain({}), chain({})],
  });
}

const bounce = (sid) => AppointmentReminders.handleUndeliveredSms({ sid, status: 'undelivered', errorCode: '30003', to: '+19415551234' });

describe('a bounced day-only grouped 72-hour reminder', () => {
  test('whole-stop copy with every member\'s disclosure, the visit-scoped key, and a day-only email', async () => {
    const { cardHoldReminderNote } = require('../services/estimate-card-holds');
    cardHoldReminderNote.mockImplementation(async (id) => (id === 'ss-sib' ? 'Sibling hold note.' : ''));
    groupedWorld({ metadata: DAY_META });
    await bounce('SM_day_grouped');
    expect(AppointmentEmail.sendAppointmentReminderEmail).toHaveBeenCalledTimes(1);
    expect(AppointmentEmail.sendAppointmentReminderEmail).toHaveBeenCalledWith(expect.objectContaining({
      customerId: 'c9',
      scheduledServiceId: 'ss-owner',
      kind: '72h',
      appointmentTime: new Date('2026-06-22T13:00:00.000Z'),
      serviceLabel: 'Quarterly Pest Control & Mosquito Treatment',
      cardHoldPolicyNote: 'Sibling hold note.',
      idempotencyKey: 'appointment.reminder_72h:visit:visit-9:reminder_72h:2026-06-22',
      dayOnly: true,
    }));
    cardHoldReminderNote.mockImplementation(async () => '');
  });

  test('after the visit moved to another date: no recovery email (the new occurrence\'s key stays unconsumed)', async () => {
    groupedWorld({ metadata: DAY_META, visitDate: '2026-06-25' });
    await bounce('SM_day_moved');
    expect(AppointmentEmail.sendAppointmentReminderEmail).not.toHaveBeenCalled();
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('the occurrence can come from the guard slot alone (promised_date absent)', async () => {
    groupedWorld({ metadata: { promise_level: 'day', window_unknown: true, guard_slot_ms: SLOT }, visitDate: '2026-06-25' });
    await bounce('SM_day_guard_only');
    expect(AppointmentEmail.sendAppointmentReminderEmail).not.toHaveBeenCalled();
  });

  test('a day-only audit row with no guard fields at all falls back to per-row copy, still day-only', async () => {
    groupedWorld({ metadata: { promise_level: 'day', window_unknown: true } });
    await bounce('SM_day_noguard');
    const call = AppointmentEmail.sendAppointmentReminderEmail.mock.calls[0][0];
    expect(call.dayOnly).toBe(true);
    expect(call.serviceLabel).toBe('Quarterly Pest Control');
    expect(call.idempotencyKey).toBeUndefined();
  });
});

describe('a bounced window grouped reminder is unchanged', () => {
  test('rendered_slot_ms still drives the whole-stop copy and the key, and the email carries no dayOnly', async () => {
    groupedWorld({ metadata: { rendered_slot_ms: SLOT } });
    await bounce('SM_window_grouped');
    const call = AppointmentEmail.sendAppointmentReminderEmail.mock.calls[0][0];
    expect(call).toMatchObject({
      kind: '72h', appointmentTime: new Date('2026-06-22T13:00:00.000Z'),
      serviceLabel: 'Quarterly Pest Control & Mosquito Treatment',
      idempotencyKey: 'appointment.reminder_72h:visit:visit-9:reminder_72h:2026-06-22',
    });
    expect(call).not.toHaveProperty('dayOnly');
  });

  test('a stray guard field on a window row (no day marker) is not an occurrence', async () => {
    groupedWorld({ metadata: { guard_slot_ms: SLOT, promised_date: '2026-06-22' } });
    await bounce('SM_window_stray');
    const call = AppointmentEmail.sendAppointmentReminderEmail.mock.calls[0][0];
    expect(call).not.toHaveProperty('dayOnly');
    expect(call.idempotencyKey).toBeUndefined();
  });
});

// A bounce can arrive hours after the text: the day-only recovery is revalidated for NOW (Codex P1-4).
describe('a delayed bounce of a day-only text is revalidated before it recovers by email', () => {
  test('still early with nothing newer: the day-only email, as before', async () => {
    groupedWorld({ metadata: DAY_META });
    await bounce('SM_early');
    expect(timePromise.loadPromiseLevels).toHaveBeenCalledWith(db, ['ss-owner'], expect.any(Date));
    expect(AppointmentEmail.sendAppointmentReminderEmail.mock.calls[0][0]).toMatchObject({ dayOnly: true });
  });

  test('the 24-hour text already delivered a window (the latest promise is an hour): no day email, suppressed as stale', async () => {
    timePromise.loadPromiseLevels.mockResolvedValue(new Map([['ss-owner', 'hour']]));
    groupedWorld({ metadata: DAY_META });
    await bounce('SM_after_24h');
    expect(AppointmentEmail.sendAppointmentReminderEmail).not.toHaveBeenCalled();
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('suppressed as stale'));
  });

  test('inside the cutoff with nothing newer: today\'s window copy, never a day promise', async () => {
    jest.setSystemTime(new Date('2026-06-21T20:00:00.000Z')); // 17 h before the grouped 9:00 ET slot
    groupedWorld({ metadata: DAY_META });
    await bounce('SM_cutoff');
    const call = AppointmentEmail.sendAppointmentReminderEmail.mock.calls[0][0];
    expect(call).not.toHaveProperty('dayOnly');
    expect(call).toMatchObject({ kind: '72h', appointmentTime: new Date('2026-06-22T13:00:00.000Z'), idempotencyKey: 'appointment.reminder_72h:visit:visit-9:reminder_72h:2026-06-22' });
  });

  test('the promise cannot be read: suppressed (it must not become a newer day promise over a window we cannot see)', async () => {
    timePromise.loadPromiseLevels.mockRejectedValue(new Error('read failed'));
    groupedWorld({ metadata: DAY_META });
    await bounce('SM_unreadable');
    expect(AppointmentEmail.sendAppointmentReminderEmail).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('promise unreadable'));
  });

  test('a bounced day-only CONFIRMATION is revalidated the same way', async () => {
    timePromise.loadPromiseLevels.mockResolvedValue(new Map([['ss1', 'hour']]));
    const auditChain = chain({ first: { channel: 'sms', purpose: 'appointment_confirmation', customer_id: 'c1', metadata: { original_message_type: 'confirmation', scheduled_service_id: 'ss1', ...DAY_META } } });
    setDbQueues({
      messaging_audit_log: [auditChain],
      customers: [chain({ first: { id: 'c1', phone: '+19415551234', line_type: null } })],
      appointment_reminders: [chain({ first: { appointment_time: '2026-06-22T13:00:00.000Z', service_type: 'Pest Control' } }), chain({})],
    });
    await bounce('SM_conf');
    expect(AppointmentEmail.sendAppointmentConfirmationEmail).not.toHaveBeenCalled();
  });

  test('a window bounce is never revalidated (no promise read, same recovery)', async () => {
    groupedWorld({ metadata: { rendered_slot_ms: SLOT } });
    await bounce('SM_window_plain');
    expect(timePromise.loadPromiseLevels).not.toHaveBeenCalled();
    expect(AppointmentEmail.sendAppointmentReminderEmail).toHaveBeenCalledTimes(1);
  });
});
