'use strict';

// GATE_MOVE_NOTICE_EMAIL (owner 2026-10-24 "reschedule email"): a reschedule
// or cancellation text that reached nobody, or that a carrier bounced, is
// followed by the same notice by email. These tests cover the one decision
// point (deliverMoveNoticeEmail), its helpers, and the three senders that
// call it: handleReschedule, handleCancellation (sendCancellationNotice) and
// handleUndeliveredSms.

// A lenient knex stand-in: every table answers from mockDb, so a test states
// only the rows it cares about. Updates and inserts are recorded.
const mockDb = { first: {}, rows: {}, updates: [], inserts: [] };
jest.mock('../models/db', () => {
  const make = (table) => {
    const q = {};
    for (const m of ['where', 'andWhere', 'orWhere', 'whereIn', 'whereNot', 'whereNotIn', 'whereNull', 'whereNotNull', 'whereRaw',
      'whereExists', 'whereNotExists', 'orderBy', 'leftJoin', 'join', 'limit', 'forUpdate', 'forShare', 'noWait', 'skipLocked',
      'modify', 'distinct', 'groupBy', 'count', 'select', 'returning']) q[m] = () => q;
    q.first = async (...cols) => {
      const v = mockDb.first[table];
      return typeof v === 'function' ? v(cols) : v;
    };
    q.pluck = async () => [];
    q.update = async (patch) => { mockDb.updates.push({ table, patch }); return 1; };
    q.insert = (row) => {
      mockDb.inserts.push({ table, row });
      return { returning: async () => [{ id: `new-${table}`, ...row }], then: (res, rej) => Promise.resolve([1]).then(res, rej) };
    };
    q.del = async () => 1;
    q.then = (res, rej) => Promise.resolve(mockDb.rows[table] || []).then(res, rej);
    return q;
  };
  const db = jest.fn((table) => make(table));
  db.raw = jest.fn((sql) => sql);
  db.transaction = jest.fn(async (fn) => fn(db));
  db.fn = { now: () => new Date() };
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/street-level-hold', () => ({ ...jest.requireActual('../services/street-level-hold'), isStreetLevelHoldVisit: jest.fn(async () => false) }));
jest.mock('../services/messaging/send-customer-message', () => ({
  ...jest.requireActual('../services/messaging/send-customer-message'),
  sendCustomerMessage: jest.fn(async () => ({ sent: false, code: 'PROVIDER_FAILED' })),
}));
jest.mock('../routes/admin-sms-templates', () => ({ getTemplate: jest.fn(async () => 'Your visit moved.') }));
jest.mock('../services/appointment-email', () => ({
  sendAppointmentConfirmationEmail: jest.fn(async () => ({ ok: true })),
  sendAppointmentReminderEmail: jest.fn(async () => ({ ok: true })),
  sendTechEnRouteEmail: jest.fn(async () => ({ ok: true })),
  sendAppointmentRescheduledEmail: jest.fn(async () => ({ ok: true })),
  sendAppointmentCancelledEmail: jest.fn(async () => ({ ok: true })),
}));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({ id: 'n1' })) }));
jest.mock('../services/reschedule-link', () => ({ buildRescheduleLink: jest.fn(async () => ({ url: 'https://example.invalid/r/1' })) }));
jest.mock('../services/visit-groups', () => ({ ...jest.requireActual('../services/visit-groups'), appointmentSendHeld: jest.fn(async () => false) }));
jest.mock('../services/cancel-generation-fence', () => ({ ...jest.requireActual('../services/cancel-generation-fence'), countRestorations: jest.fn(async () => 0) }));
jest.mock('../services/property-notification-prefs', () => ({ ...jest.requireActual('../services/property-notification-prefs'), prefsForVisit: jest.fn(async (prefs) => prefs) }));
jest.mock('../services/recipient-optin', () => ({ ...jest.requireActual('../services/recipient-optin'), filterRecipientsByOptin: jest.fn(async (contacts) => contacts) }));
jest.mock('../services/contact-notification-prefs', () => ({
  ...jest.requireActual('../services/contact-notification-prefs'),
  filterContactsByOwnPrefs: jest.fn(async (contacts) => contacts),
}));

const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const AppointmentEmail = require('../services/appointment-email');
const { notifyAdmin } = require('../services/notification-service');
const { appointmentSendHeld } = require('../services/visit-groups');
const { countRestorations } = require('../services/cancel-generation-fence');
const AppointmentReminders = require('../services/appointment-reminders');

const { deliverMoveNoticeEmail } = AppointmentReminders;
const { moveNoticeEmailKey, bouncedNoticeKind, cancellationNoticeReport } = AppointmentReminders._test;

// Synthetic customer. Far-future slot so "the slot is ahead" holds.
const CUSTOMER = { id: 'cust-1', first_name: 'Pat', last_name: 'Example', phone: '+19415550101', email: 'pat@example.com', is_primary_profile: true, account_id: null };
// 4:00 PM Eastern (standard time in November).
const SLOT = new Date('2099-11-04T21:00:00.000Z');
const NOTICE_AT = new Date('2099-10-24T12:00:00.000Z');

function base({ status = 'confirmed', prefs = {} } = {}) {
  mockDb.first = {
    customers: CUSTOMER,
    notification_prefs: { customer_id: 'cust-1', ...prefs },
    scheduled_services: { status, visit_id: null },
    notifications: null,
    sms_log: null,
    phone_line_types: null,
  };
  mockDb.rows = {};
  mockDb.updates = [];
  mockDb.inserts = [];
}

const args = (over = {}) => ({
  kind: 'rescheduled', customerId: 'cust-1', scheduledServiceId: 'svc-1', apptTime: SLOT,
  serviceLabel: 'Quarterly Pest Control', arrivalWindow: 'between 4:00 PM and 6:00 PM', noticeAt: NOTICE_AT, sendOutcome: {}, ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GATE_MOVE_NOTICE_EMAIL = 'true';
  base();
});
afterAll(() => { delete process.env.GATE_MOVE_NOTICE_EMAIL; });

describe('deliverMoveNoticeEmail', () => {
  test('gate off: no email, no reads', async () => {
    delete process.env.GATE_MOVE_NOTICE_EMAIL;
    expect(await deliverMoveNoticeEmail(args())).toBe(false);
    expect(AppointmentEmail.sendAppointmentRescheduledEmail).not.toHaveBeenCalled();
    expect(appointmentSendHeld).not.toHaveBeenCalled();
  });

  test('a reschedule text that reached nobody: the reschedule email, keyed by the notice stamp', async () => {
    expect(await deliverMoveNoticeEmail(args())).toBe(true);
    expect(AppointmentEmail.sendAppointmentRescheduledEmail).toHaveBeenCalledTimes(1);
    const sent = AppointmentEmail.sendAppointmentRescheduledEmail.mock.calls[0][0];
    expect(sent).toMatchObject({
      customerId: 'cust-1', scheduledServiceId: 'svc-1', appointmentTime: SLOT, serviceLabel: 'Quarterly Pest Control',
      arrivalWindow: 'between 4:00 PM and 6:00 PM', idempotencyKey: `appointment.rescheduled:svc-1:${NOTICE_AT.getTime()}`,
    });
    // The freshness check rides to the email's dispatch boundary.
    expect(typeof sent.stillCurrent).toBe('function');
    expect(appointmentSendHeld).toHaveBeenCalledWith('svc-1', SLOT.getTime());
  });

  test('a cancellation text that reached nobody: the cancellation email, keyed by the restoration count', async () => {
    base({ status: 'cancelled' });
    countRestorations.mockResolvedValueOnce(2);
    expect(await deliverMoveNoticeEmail(args({ kind: 'cancelled', arrivalWindow: undefined, noticeAt: undefined }))).toBe(true);
    expect(AppointmentEmail.sendAppointmentCancelledEmail).toHaveBeenCalledWith(expect.objectContaining({
      customerId: 'cust-1', scheduledServiceId: 'svc-1', idempotencyKey: 'appointment.cancelled:svc-1:r2',
    }));
    expect(AppointmentEmail.sendAppointmentRescheduledEmail).not.toHaveBeenCalled();
  });

  test.each(['QUIET_HOURS_HOLD', 'MOVE_HOLD', 'PUSH_IN_FLIGHT', 'REMINDER_PREFERENCES_HOLD'])('a %s text is deferred, not lost: no email', async (blockedCode) => {
    expect(await deliverMoveNoticeEmail(args({ sendOutcome: { blockedCode } }))).toBe(false);
    expect(AppointmentEmail.sendAppointmentRescheduledEmail).not.toHaveBeenCalled();
  });

  test('a text that failed for any other reason (landline, opt-out, provider) emails', async () => {
    expect(await deliverMoveNoticeEmail(args({ sendOutcome: { lastCode: 'SMS_OPTED_OUT', blockedCode: 'SMS_OPTED_OUT' } }))).toBe(true);
  });

  test('portal-wide email off: no email of either kind', async () => {
    base({ prefs: { email_enabled: false } });
    expect(await deliverMoveNoticeEmail(args())).toBe(false);
    base({ status: 'cancelled', prefs: { email_enabled: false } });
    expect(await deliverMoveNoticeEmail(args({ kind: 'cancelled' }))).toBe(false);
    expect(AppointmentEmail.sendAppointmentRescheduledEmail).not.toHaveBeenCalled();
    expect(AppointmentEmail.sendAppointmentCancelledEmail).not.toHaveBeenCalled();
  });

  test('appointment confirmations off: no reschedule email (its text follows the same switch); the cancellation still goes', async () => {
    base({ prefs: { appointment_confirmation: false } });
    expect(await deliverMoveNoticeEmail(args())).toBe(false);
    base({ status: 'cancelled', prefs: { appointment_confirmation: false } });
    expect(await deliverMoveNoticeEmail(args({ kind: 'cancelled' }))).toBe(true);
  });

  test('unreadable settings: no email', async () => {
    base();
    mockDb.first.notification_prefs = { customer_id: 'cust-1', __prefsUnavailable: true };
    expect(await deliverMoveNoticeEmail(args())).toBe(false);
    expect(AppointmentEmail.sendAppointmentRescheduledEmail).not.toHaveBeenCalled();
  });

  test.each([
    ['the visit was cancelled since', { status: 'cancelled' }, {}],
    ['the visit is gone', { status: null }, {}],
    ['the quoted slot is past', {}, { apptTime: new Date('2020-01-01T15:00:00.000Z') }],
  ])('a reschedule notice that is no longer true sends nothing: %s', async (_label, state, over) => {
    base(state);
    if (state.status === null) mockDb.first.scheduled_services = null;
    expect(await deliverMoveNoticeEmail(args(over))).toBe(false);
    expect(AppointmentEmail.sendAppointmentRescheduledEmail).not.toHaveBeenCalled();
  });

  test('the shared send guard holds the slot (moved again, or a grouped move): no reschedule email', async () => {
    appointmentSendHeld.mockResolvedValueOnce(true);
    expect(await deliverMoveNoticeEmail(args())).toBe(false);
    expect(AppointmentEmail.sendAppointmentRescheduledEmail).not.toHaveBeenCalled();
  });

  test('a cancellation notice for a visit restored since sends nothing', async () => {
    base({ status: 'confirmed' });
    expect(await deliverMoveNoticeEmail(args({ kind: 'cancelled' }))).toBe(false);
    expect(AppointmentEmail.sendAppointmentCancelledEmail).not.toHaveBeenCalled();
  });

  test('no usable email: the no-channel alert rings, naming the notice', async () => {
    AppointmentEmail.sendAppointmentRescheduledEmail.mockResolvedValueOnce({ ok: false, skipped: true, reason: 'missing_email' });
    expect(await deliverMoveNoticeEmail(args())).toBe(false);
    expect(notifyAdmin).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(notifyAdmin.mock.calls[0])).toMatch(/reschedule notice/);
  });

  test('every address suppressed: the alert says suppressed', async () => {
    AppointmentEmail.sendAppointmentRescheduledEmail.mockResolvedValueOnce({ ok: false, blocked: true, reason: 'suppressed' });
    expect(await deliverMoveNoticeEmail(args())).toBe(false);
    expect(notifyAdmin).toHaveBeenCalledTimes(1);
  });

  test('a held or failed email is no alert', async () => {
    AppointmentEmail.sendAppointmentRescheduledEmail.mockResolvedValueOnce({ ok: false, held: true, reason: 'stale_notice' });
    expect(await deliverMoveNoticeEmail(args())).toBe(false);
    AppointmentEmail.sendAppointmentRescheduledEmail.mockResolvedValueOnce({ ok: false, error: 'provider down' });
    expect(await deliverMoveNoticeEmail(args())).toBe(false);
    expect(notifyAdmin).not.toHaveBeenCalled();
  });

  test('never throws: a sender error is false', async () => {
    AppointmentEmail.sendAppointmentRescheduledEmail.mockRejectedValueOnce(new Error('boom'));
    await expect(deliverMoveNoticeEmail(args())).resolves.toBe(false);
  });
});

describe('helpers', () => {
  test('moveNoticeEmailKey: a reschedule by its stamp, a cancellation by its restoration count', async () => {
    expect(await moveNoticeEmailKey('rescheduled', 'svc-9', '2099-10-24T12:00:00.000Z')).toBe(`appointment.rescheduled:svc-9:${Date.parse('2099-10-24T12:00:00.000Z')}`);
    countRestorations.mockResolvedValueOnce(0);
    expect(await moveNoticeEmailKey('cancelled', 'svc-9')).toBe('appointment.cancelled:svc-9:r0');
    countRestorations.mockResolvedValueOnce(1);
    expect(await moveNoticeEmailKey('cancelled', 'svc-9')).toBe('appointment.cancelled:svc-9:r1');
  });

  test('bouncedNoticeKind: gate on, the two texts own their email; off, today\'s mapping', () => {
    const rescheduleText = { purpose: 'appointment_confirmation', metadata: { original_message_type: 'appointment_rescheduled' } };
    const cancelText = { purpose: 'appointment_cancellation', metadata: { original_message_type: 'appointment_cancelled' } };
    const confirmationText = { purpose: 'appointment_confirmation', metadata: { original_message_type: 'confirmation' } };
    expect(bouncedNoticeKind(rescheduleText)).toBe('rescheduled');
    expect(bouncedNoticeKind(cancelText)).toBe('cancelled');
    expect(bouncedNoticeKind(confirmationText)).toBe('confirmation');
    delete process.env.GATE_MOVE_NOTICE_EMAIL;
    expect(bouncedNoticeKind(rescheduleText)).toBe('confirmation');
    expect(bouncedNoticeKind(cancelText)).toBeUndefined();
    expect(bouncedNoticeKind(confirmationText)).toBe('confirmation');
  });

  test('cancellationNoticeReport: an email in the text\'s place counts as notified', () => {
    expect(cancellationNoticeReport(true, false)).toEqual([true, null]);
    expect(cancellationNoticeReport(false, true)).toEqual([true, 'The text could not be delivered, so the customer got the cancellation notice by email.']);
    expect(cancellationNoticeReport(false, false)).toEqual([false, 'customer was not notified (no eligible recipient, opted out, or the text was blocked)']);
  });
});

describe('handleUndeliveredSms: a carrier bounced a reschedule or cancellation text', () => {
  const rescheduleAudit = {
    channel: 'sms', purpose: 'appointment_confirmation', customer_id: 'cust-1', created_at: '2099-10-24T12:00:05.000Z',
    metadata: {
      original_message_type: 'appointment_rescheduled', scheduled_service_id: 'svc-1',
      rendered_slot_ms: SLOT.getTime(), move_notice_at: NOTICE_AT.toISOString(),
    },
  };
  const cancelAudit = {
    channel: 'sms', purpose: 'appointment_cancellation', customer_id: 'cust-1', created_at: '2099-10-24T12:00:05.000Z',
    metadata: { original_message_type: 'appointment_cancelled', scheduled_service_id: 'svc-1' },
  };
  const bounce = (errorCode = '30003') => AppointmentReminders.handleUndeliveredSms({ sid: 'SM1', status: 'undelivered', errorCode, to: '+19415550199' });

  test('gate on: a bounced reschedule text gets the reschedule email for the slot it quoted, keyed by its move stamp', async () => {
    mockDb.first.messaging_audit_log = rescheduleAudit;
    mockDb.first.appointment_reminders = { appointment_time: '2099-11-04T21:00:00.000Z', service_type: 'Pest Control', cancelled: false };
    await bounce();
    expect(AppointmentEmail.sendAppointmentRescheduledEmail).toHaveBeenCalledTimes(1);
    expect(AppointmentEmail.sendAppointmentRescheduledEmail).toHaveBeenCalledWith(expect.objectContaining({
      scheduledServiceId: 'svc-1', appointmentTime: SLOT, serviceLabel: 'Pest Control',
      arrivalWindow: 'between 4:00 PM and 6:00 PM', idempotencyKey: `appointment.rescheduled:svc-1:${NOTICE_AT.getTime()}`,
    }));
    expect(AppointmentEmail.sendAppointmentConfirmationEmail).not.toHaveBeenCalled();
  });

  test('gate on: two recipients\' bounces of one notice share one key', async () => {
    mockDb.first.appointment_reminders = { appointment_time: '2099-11-04T21:00:00.000Z', service_type: 'Pest Control', cancelled: false };
    mockDb.first.messaging_audit_log = rescheduleAudit;
    await bounce();
    mockDb.first.messaging_audit_log = { ...rescheduleAudit, created_at: '2099-10-24T12:00:09.000Z' };
    await bounce();
    const keys = AppointmentEmail.sendAppointmentRescheduledEmail.mock.calls.map(([a]) => a.idempotencyKey);
    expect(new Set(keys).size).toBe(1);
  });

  test('gate on: a visit moved again since the text sends no email (the newer notice owns it)', async () => {
    mockDb.first.messaging_audit_log = rescheduleAudit;
    mockDb.first.appointment_reminders = { appointment_time: '2099-11-06T14:00:00.000Z', service_type: 'Pest Control', cancelled: false };
    appointmentSendHeld.mockResolvedValueOnce(true);
    await bounce();
    expect(AppointmentEmail.sendAppointmentRescheduledEmail).not.toHaveBeenCalled();
    expect(AppointmentEmail.sendAppointmentConfirmationEmail).not.toHaveBeenCalled();
  });

  test('gate off: a bounced reschedule text keeps today\'s confirmation email', async () => {
    delete process.env.GATE_MOVE_NOTICE_EMAIL;
    mockDb.first.messaging_audit_log = rescheduleAudit;
    mockDb.first.appointment_reminders = { appointment_time: '2099-11-04T21:00:00.000Z', service_type: 'Pest Control', cancelled: false };
    await bounce();
    expect(AppointmentEmail.sendAppointmentConfirmationEmail).toHaveBeenCalledTimes(1);
    expect(AppointmentEmail.sendAppointmentRescheduledEmail).not.toHaveBeenCalled();
  });

  test('gate on: a bounced cancellation text gets the cancellation email', async () => {
    base({ status: 'cancelled' });
    mockDb.first.messaging_audit_log = cancelAudit;
    mockDb.first.appointment_reminders = { appointment_time: '2099-11-04T21:00:00.000Z', service_type: 'Pest Control', cancelled: true };
    await bounce();
    expect(AppointmentEmail.sendAppointmentCancelledEmail).toHaveBeenCalledWith(expect.objectContaining({
      scheduledServiceId: 'svc-1', appointmentTime: SLOT, serviceLabel: 'Pest Control', idempotencyKey: 'appointment.cancelled:svc-1:r0',
    }));
  });

  test('gate on: a 30006 bounce of a cancellation text on the primary phone also learns the landline', async () => {
    base({ status: 'cancelled' });
    mockDb.first.messaging_audit_log = cancelAudit;
    mockDb.first.appointment_reminders = { appointment_time: '2099-11-04T21:00:00.000Z', service_type: 'Pest Control', cancelled: true };
    mockDb.first.sms_log = { created_at: '2099-10-24T12:00:00.000Z', metadata: {} };
    mockDb.first.messaging_suppression = null;
    await AppointmentReminders.handleUndeliveredSms({ sid: 'SM2', status: 'undelivered', errorCode: '30006', to: CUSTOMER.phone });
    expect(mockDb.updates).toContainEqual({ table: 'customers', patch: { line_type: 'landline' } });
    expect(AppointmentEmail.sendAppointmentCancelledEmail).toHaveBeenCalledTimes(1);
  });

  test('gate off: a bounced cancellation text sends nothing, as today', async () => {
    delete process.env.GATE_MOVE_NOTICE_EMAIL;
    base({ status: 'cancelled' });
    mockDb.first.messaging_audit_log = cancelAudit;
    mockDb.first.appointment_reminders = { appointment_time: '2099-11-04T21:00:00.000Z', service_type: 'Pest Control', cancelled: true };
    await bounce();
    expect(AppointmentEmail.sendAppointmentCancelledEmail).not.toHaveBeenCalled();
    expect(AppointmentEmail.sendAppointmentConfirmationEmail).not.toHaveBeenCalled();
  });
});

describe('handleReschedule: the reschedule text reached nobody', () => {
  const reminder = {
    id: 'rem-1', scheduled_service_id: 'svc-1', customer_id: 'cust-1', appointment_time: new Date('2099-11-02T14:00:00.000Z'),
    service_type: 'Pest Control', confirmation_sent: true, reminder_72h_sent: false, reminder_24h_sent: false,
    windows_preclosed: false, suppressed_by_sibling: false, cancelled: false,
  };
  const reschedule = () => AppointmentReminders.handleReschedule('svc-1', '2099-11-04T16:00');

  test('a landline primary: no text, the reschedule email with the text\'s own window and this move\'s stamp', async () => {
    mockDb.first.customers = { ...CUSTOMER, line_type: 'landline' };
    mockDb.first.scheduled_services = { status: 'confirmed', visit_id: null, scheduled_date: '2099-11-04', window_start: '16:00:00' };
    mockDb.first.appointment_reminders = reminder;
    const before = Date.now();
    await reschedule();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(AppointmentEmail.sendAppointmentRescheduledEmail).toHaveBeenCalledTimes(1);
    const sent = AppointmentEmail.sendAppointmentRescheduledEmail.mock.calls[0][0];
    expect(sent).toMatchObject({ scheduledServiceId: 'svc-1', serviceLabel: 'Pest Control', arrivalWindow: 'between 4:00 PM and 6:00 PM' });
    expect(sent.appointmentTime.toISOString()).toBe('2099-11-04T21:00:00.000Z');
    const stamp = Number(sent.idempotencyKey.split(':').pop());
    expect(stamp).toBeGreaterThanOrEqual(before);
    expect(sent.idempotencyKey).toMatch(/^appointment\.rescheduled:svc-1:\d+$/);
  });

  test('a delivered text: no email, and the text carries the move stamp for a later bounce', async () => {
    mockDb.first.customers = { ...CUSTOMER, line_type: 'mobile' };
    mockDb.first.appointment_reminders = reminder;
    sendCustomerMessage.mockResolvedValueOnce({ sent: true, providerMessageId: 'SM-ok' });
    await reschedule();
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(sendCustomerMessage.mock.calls[0][0].metadata).toEqual(expect.objectContaining({ move_notice_at: expect.any(String) }));
    expect(AppointmentEmail.sendAppointmentRescheduledEmail).not.toHaveBeenCalled();
  });

  test('gate off: a landline primary gets nothing, as today', async () => {
    delete process.env.GATE_MOVE_NOTICE_EMAIL;
    mockDb.first.customers = { ...CUSTOMER, line_type: 'landline' };
    mockDb.first.appointment_reminders = reminder;
    await reschedule();
    expect(AppointmentEmail.sendAppointmentRescheduledEmail).not.toHaveBeenCalled();
  });
});

describe('handleCancellation: the cancellation text reached nobody', () => {
  const reminder = {
    id: 'rem-2', scheduled_service_id: 'svc-1', customer_id: 'cust-1', appointment_time: '2099-11-04T21:00:00.000Z',
    service_type: 'Pest Control', cancelled: false, cancellation_notice_state: null, cancellation_notice_at: null,
  };

  test('a landline primary: the cancellation email, and the operator hears it went by email', async () => {
    base({ status: 'cancelled' });
    mockDb.first.customers = { ...CUSTOMER, line_type: 'landline' };
    mockDb.first.appointment_reminders = reminder;
    const outcome = {};
    await AppointmentReminders.handleCancellation('svc-1', { outcome });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(AppointmentEmail.sendAppointmentCancelledEmail).toHaveBeenCalledWith(expect.objectContaining({
      scheduledServiceId: 'svc-1', serviceLabel: 'Pest Control', idempotencyKey: 'appointment.cancelled:svc-1:r0',
    }));
    expect(outcome).toMatchObject({ notificationSent: true, notificationError: 'The text could not be delivered, so the customer got the cancellation notice by email.' });
  });

  test('gate off: the same cancellation keeps today\'s outcome and sends no email', async () => {
    delete process.env.GATE_MOVE_NOTICE_EMAIL;
    base({ status: 'cancelled' });
    mockDb.first.customers = { ...CUSTOMER, line_type: 'landline' };
    mockDb.first.appointment_reminders = reminder;
    const outcome = {};
    await AppointmentReminders.handleCancellation('svc-1', { outcome });
    expect(AppointmentEmail.sendAppointmentCancelledEmail).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ notificationSent: false, notificationError: 'customer was not notified (no eligible recipient, opted out, or the text was blocked)' });
  });
});
