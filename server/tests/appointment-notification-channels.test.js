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

const db = require('../models/db');
const AppointmentEmail = require('../services/appointment-email');
const NotificationService = require('../services/notification-service');
const AppointmentReminders = require('../services/appointment-reminders');

const { apptChannel, deliverAppointmentNotice } = AppointmentReminders._test;

// Minimal knex-style chainable mock. first() resolves null so the
// no-reachable-channel alert dedupe check finds no prior row and proceeds.
function chain() {
  const q = {};
  ['where', 'whereRaw', 'whereNotNull', 'orderBy', 'select'].forEach((m) => { q[m] = jest.fn(() => q); });
  q.first = jest.fn(async () => null);
  return q;
}

const args = (extra = {}) => ({
  kind: '24h',
  customerId: 'c1',
  scheduledServiceId: 'ss1',
  apptTime: new Date('2026-06-20T13:00:00.000Z'),
  serviceLabel: 'Quarterly Pest Control',
  ...extra,
});

beforeEach(() => {
  jest.clearAllMocks();
  AppointmentEmail.sendAppointmentReminderEmail.mockResolvedValue({ ok: true });
  db.mockImplementation(() => chain());
  db.raw = jest.fn((sql) => sql);
});

describe('apptChannel', () => {
  test('normalizes unknown / null values to sms', () => {
    expect(apptChannel('sms')).toBe('sms');
    expect(apptChannel('email')).toBe('email');
    expect(apptChannel('both')).toBe('both');
    expect(apptChannel(null)).toBe('sms');
    expect(apptChannel(undefined)).toBe('sms');
    expect(apptChannel('phone')).toBe('sms');
  });
});

describe('deliverAppointmentNotice channel routing', () => {
  test("'sms' default: sends SMS, no email when delivered", async () => {
    const smsAttempt = jest.fn(async () => true);
    const reached = await deliverAppointmentNotice(args({ channel: 'sms', smsAttempt }));

    expect(reached).toBe(true);
    expect(smsAttempt).toHaveBeenCalledTimes(1);
    expect(AppointmentEmail.sendAppointmentReminderEmail).not.toHaveBeenCalled();
  });

  test("'sms' default: SMS fails -> email fallback", async () => {
    const smsAttempt = jest.fn(async () => false);
    await deliverAppointmentNotice(args({ channel: 'sms', smsAttempt }));

    expect(smsAttempt).toHaveBeenCalledTimes(1);
    expect(AppointmentEmail.sendAppointmentReminderEmail).toHaveBeenCalledTimes(1);
  });

  test("'email': sends email, never attempts SMS", async () => {
    const smsAttempt = jest.fn(async () => true);
    const reached = await deliverAppointmentNotice(args({ channel: 'email', smsAttempt }));

    expect(reached).toBe(true);
    expect(AppointmentEmail.sendAppointmentReminderEmail).toHaveBeenCalledTimes(1);
    expect(smsAttempt).not.toHaveBeenCalled();
  });

  test("'email': no usable email -> falls back to SMS (no admin alert when SMS works)", async () => {
    AppointmentEmail.sendAppointmentReminderEmail.mockResolvedValue({ ok: false, skipped: true, reason: 'missing_email' });
    const smsAttempt = jest.fn(async () => true);
    const reached = await deliverAppointmentNotice(args({ channel: 'email', smsAttempt }));

    expect(reached).toBe(true);
    expect(smsAttempt).toHaveBeenCalledTimes(1);
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test("'email': email and SMS both fail -> raises no-reachable-channel alert", async () => {
    AppointmentEmail.sendAppointmentReminderEmail.mockResolvedValue({ ok: false, skipped: true, reason: 'missing_email' });
    const smsAttempt = jest.fn(async () => false);
    const reached = await deliverAppointmentNotice(args({ channel: 'email', smsAttempt }));

    expect(reached).toBe(false);
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
  });

  test("'both': sends SMS and email", async () => {
    const smsAttempt = jest.fn(async () => true);
    await deliverAppointmentNotice(args({ channel: 'both', smsAttempt }));

    expect(smsAttempt).toHaveBeenCalledTimes(1);
    expect(AppointmentEmail.sendAppointmentReminderEmail).toHaveBeenCalledTimes(1);
  });
});
