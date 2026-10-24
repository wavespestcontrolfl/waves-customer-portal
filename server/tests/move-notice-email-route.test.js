'use strict';

// sendRescheduleNoticeForVisit (dispatch board, Edit appointment, bulk and
// Intelligence Bar moves): a reschedule text that reached nobody goes through
// deliverMoveNoticeEmail (GATE_MOVE_NOTICE_EMAIL), and the operator's line
// says when the email went out instead.

const mockDb = { first: {} };
jest.mock('../models/db', () => {
  const make = (table) => {
    const q = {};
    for (const m of ['where', 'whereIn', 'whereNull', 'whereNotNull', 'whereRaw', 'orderBy', 'select']) q[m] = () => q;
    q.first = async () => mockDb.first[table];
    q.update = async () => 1;
    q.catch = () => q;
    q.then = (res, rej) => Promise.resolve([]).then(res, rej);
    return q;
  };
  const db = jest.fn((table) => make(table));
  db.raw = jest.fn((sql) => sql);
  db.transaction = jest.fn(async (fn) => fn(db));
  db.fn = { now: () => new Date() };
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/appointment-reminders', () => ({
  safeSendAppointment: jest.fn(async () => false),
  visitPrefsRow: jest.fn(async () => ({})),
  smsServiceLabelStored: jest.fn((label) => label),
  markRescheduleNoticeSent: jest.fn(async () => {}),
  deliverMoveNoticeEmail: jest.fn(async () => true),
}));
jest.mock('../routes/admin-dispatch', () => ({
  captureReminderGuards: jest.fn(async () => []),
  rearmRescheduleReminderWindows: jest.fn(async () => {}),
}));
jest.mock('../services/outbound-review-confirm', () => ({ activateLegacyOutboundReviewRowIfNeeded: jest.fn(async () => {}) }));

const AppointmentReminders = require('../services/appointment-reminders');
const { rearmRescheduleReminderWindows } = require('../routes/admin-dispatch');
const { sendRescheduleNoticeForVisit } = require('../routes/admin-schedule');

beforeEach(() => {
  jest.clearAllMocks();
  mockDb.first = {
    scheduled_services: { customer_id: 'cust-1', service_type: 'Pest Control' },
    customers: { id: 'cust-1', first_name: 'Pat', phone: '+19415550101' },
    appointment_reminders: { service_type: 'Pest Control' },
  };
});

test('a text that reached nobody: the email version with this notice\'s window and stamp, and the operator hears it went by email', async () => {
  const notice = await sendRescheduleNoticeForVisit('svc-1', '2099-11-04', '16:00');
  expect(notice).toEqual({ sent: false, error: 'The text could not be delivered, so the customer got the reschedule notice by email.' });
  expect(AppointmentReminders.deliverMoveNoticeEmail).toHaveBeenCalledTimes(1);
  const emailArgs = AppointmentReminders.deliverMoveNoticeEmail.mock.calls[0][0];
  expect(emailArgs).toMatchObject({
    kind: 'rescheduled', customerId: 'cust-1', scheduledServiceId: 'svc-1', serviceLabel: 'Pest Control',
    arrivalWindow: 'between 4:00 PM and 6:00 PM', sendOutcome: {},
  });
  expect(emailArgs.apptTime.toISOString()).toBe('2099-11-04T21:00:00.000Z');
  // The text and its email share one stamp: a later carrier bounce rebuilds the key from the text's audit row.
  const textMeta = AppointmentReminders.safeSendAppointment.mock.calls[0][5];
  expect(textMeta.move_notice_at).toBe(emailArgs.noticeAt.toISOString());
  // The reminders still re-arm: a missed text never closes them.
  expect(rearmRescheduleReminderWindows).toHaveBeenCalledTimes(1);
});

test('no email went out either: today\'s lines, unchanged', async () => {
  AppointmentReminders.deliverMoveNoticeEmail.mockResolvedValue(false);
  expect(await sendRescheduleNoticeForVisit('svc-1', '2099-11-04', '16:00')).toEqual({
    sent: false, error: 'customer was not notified (no eligible recipient, opted out, or the text was blocked)',
  });
  AppointmentReminders.safeSendAppointment.mockImplementationOnce(async (...a) => { a[6].sendOutcome.retryable = true; return false; });
  expect(await sendRescheduleNoticeForVisit('svc-1', '2099-11-04', '16:00')).toEqual({
    sent: false, error: 'customer was not notified: notification preferences could not be read — send the reschedule notice again',
  });
});

test('a delivered text sends no email', async () => {
  AppointmentReminders.safeSendAppointment.mockResolvedValueOnce(true);
  const notice = await sendRescheduleNoticeForVisit('svc-1', '2099-11-04', '16:00');
  expect(notice).toEqual({ sent: true, error: null });
  expect(AppointmentReminders.deliverMoveNoticeEmail).not.toHaveBeenCalled();
});
