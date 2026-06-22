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

const { apptChannel, deliverAppointmentNotice, deliverConfirmationByChannel, getReminderPrefs } = AppointmentReminders._test;

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
    const reached = await deliverAppointmentNotice(args({ channel: 'both', smsAttempt }));

    expect(reached).toBe(true);
    expect(smsAttempt).toHaveBeenCalledTimes(1);
    expect(AppointmentEmail.sendAppointmentReminderEmail).toHaveBeenCalledTimes(1);
  });

  test("'both': SMS blocked but email delivered still counts as reached", async () => {
    const smsAttempt = jest.fn(async () => false);
    const reached = await deliverAppointmentNotice(args({ channel: 'both', smsAttempt }));

    expect(reached).toBe(true);
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test("'both': a throwing SMS leg does not abort the email leg or bubble", async () => {
    const smsAttempt = jest.fn(async () => { throw new Error('customer SMS blocked'); });
    const reached = await deliverAppointmentNotice(args({ channel: 'both', smsAttempt }));

    expect(reached).toBe(true); // email still delivered
    expect(AppointmentEmail.sendAppointmentReminderEmail).toHaveBeenCalledTimes(1);
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test("'both': both channels fail -> raises no-reachable-channel alert", async () => {
    AppointmentEmail.sendAppointmentReminderEmail.mockResolvedValue({ ok: false, skipped: true, reason: 'missing_email' });
    const smsAttempt = jest.fn(async () => false);
    const reached = await deliverAppointmentNotice(args({ channel: 'both', smsAttempt }));

    expect(reached).toBe(false);
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
  });
});

describe('getReminderPrefs account-level channel resolution', () => {
  // chain whose first() resolves a fixed value.
  function firstChain(value) {
    const q = {};
    ['where', 'whereIn'].forEach((m) => { q[m] = jest.fn(() => q); });
    q.first = jest.fn(async () => value);
    return q;
  }

  // Drive db(table) by a per-table FIFO queue of chains.
  function setDbQueues(queues) {
    const tableQueues = new Map(Object.entries(queues));
    db.mockImplementation((table) => {
      const queue = tableQueues.get(table);
      if (!queue || !queue.length) throw new Error(`Unexpected db table ${table}`);
      return queue.shift();
    });
  }

  test('secondary property inherits the primary profile channel', async () => {
    setDbQueues({
      notification_prefs: [
        // property's own prefs (default sms)
        firstChain({ appointment_confirmation_channel: 'sms', service_reminder_72h_channel: 'sms', service_reminder_24h_channel: 'sms', service_reminder_72h: true }),
        // primary owner's prefs (email)
        firstChain({ appointment_confirmation_channel: 'email', service_reminder_72h_channel: 'email', service_reminder_24h_channel: 'email' }),
      ],
      customers: [
        firstChain({ account_id: 'acct-1', is_primary_profile: false }),
        firstChain({ id: 'primary-1' }),
      ],
    });

    const prefs = await getReminderPrefs('secondary-1');
    expect(prefs.confirmationChannel).toBe('email');
    expect(prefs.reminder72hChannel).toBe('email');
    // Toggles still come from the property's own row.
    expect(prefs.serviceReminder72h).toBe(true);
  });

  test('primary profile uses its own channel without an extra lookup', async () => {
    setDbQueues({
      notification_prefs: [
        firstChain({ appointment_confirmation_channel: 'both', service_reminder_24h_channel: 'both' }),
      ],
      customers: [
        firstChain({ account_id: 'acct-1', is_primary_profile: true }),
      ],
    });

    const prefs = await getReminderPrefs('primary-1');
    expect(prefs.confirmationChannel).toBe('both');
    expect(prefs.reminder24hChannel).toBe('both');
  });
});

describe('deliverConfirmationByChannel (self-service booking paths)', () => {
  function firstChain(value) {
    const q = {};
    ['where', 'whereIn'].forEach((m) => { q[m] = jest.fn(() => q); });
    q.first = jest.fn(async () => value);
    return q;
  }
  function setDbQueues(queues) {
    const tableQueues = new Map(Object.entries(queues));
    db.mockImplementation((table) => {
      const queue = tableQueues.get(table);
      if (!queue || !queue.length) throw new Error(`Unexpected db table ${table}`);
      return queue.shift();
    });
  }

  test("'sms' preference: runs the caller's SMS send, never emails", async () => {
    setDbQueues({
      notification_prefs: [firstChain({ appointment_confirmation_channel: 'sms' })],
      customers: [firstChain({ account_id: 'acct-1', is_primary_profile: true })],
    });
    const smsAttempt = jest.fn(async () => true);
    const reached = await deliverConfirmationByChannel({ customerId: 'c1', scheduledServiceId: 'ss1', serviceLabel: 'X', smsAttempt });

    expect(reached).toBe(true);
    expect(smsAttempt).toHaveBeenCalledTimes(1);
    expect(AppointmentEmail.sendAppointmentConfirmationEmail).not.toHaveBeenCalled();
  });

  test("'email' preference: emails the confirmation with the derived appt time, skips SMS", async () => {
    setDbQueues({
      notification_prefs: [firstChain({ appointment_confirmation_channel: 'email' })],
      customers: [firstChain({ account_id: 'acct-1', is_primary_profile: true })],
      scheduled_services: [firstChain({ scheduled_date: '2026-06-20', window_start: '08:00:00' })],
    });
    const smsAttempt = jest.fn(async () => true);
    const reached = await deliverConfirmationByChannel({ customerId: 'c1', scheduledServiceId: 'ss1', serviceLabel: 'X', smsAttempt });

    expect(reached).toBe(true);
    expect(smsAttempt).not.toHaveBeenCalled();
    expect(AppointmentEmail.sendAppointmentConfirmationEmail).toHaveBeenCalledTimes(1);
    const callArg = AppointmentEmail.sendAppointmentConfirmationEmail.mock.calls[0][0];
    expect(callArg.appointmentTime instanceof Date).toBe(true);
  });

  test('opted-out customer (confirmation toggle off) is not emailed even on the email channel', async () => {
    setDbQueues({
      notification_prefs: [firstChain({ appointment_confirmation_channel: 'email', appointment_confirmation: false })],
      customers: [firstChain({ account_id: 'acct-1', is_primary_profile: true })],
    });
    const smsAttempt = jest.fn(async () => false);
    const reached = await deliverConfirmationByChannel({ customerId: 'c1', scheduledServiceId: 'ss1', smsAttempt });

    // Falls to the SMS-only path, where sendCustomerMessage's validator suppresses
    // it for the opted-out customer; the email path (which bypasses that check) is
    // never taken.
    expect(smsAttempt).toHaveBeenCalledTimes(1);
    expect(AppointmentEmail.sendAppointmentConfirmationEmail).not.toHaveBeenCalled();
    expect(reached).toBe(false);
  });

  test('falls back to the SMS send when channel prefs are unavailable', async () => {
    setDbQueues({
      notification_prefs: [firstChain(null)],
      customers: [firstChain(null)],
    });
    const smsAttempt = jest.fn(async () => true);
    const reached = await deliverConfirmationByChannel({ customerId: 'c1', scheduledServiceId: 'ss1', smsAttempt });

    expect(reached).toBe(true);
    expect(smsAttempt).toHaveBeenCalledTimes(1);
    expect(AppointmentEmail.sendAppointmentConfirmationEmail).not.toHaveBeenCalled();
  });
});
