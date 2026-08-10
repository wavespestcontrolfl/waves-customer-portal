// Partial appointment-notice fan-out across the 20:00 ET boundary (codex
// #3259 r20): when an EARLIER contact was provider-accepted and a LATER
// contact crossed the cutoff, callers finalize the notice as sent — so
// safeSendAppointment must persist ONLY the held recipients on the
// scheduled rail (entry_point appointment_notice_contact_deferred, frozen
// contact phone, NO refresh_customer_phone). A held 24h reminder is
// SKIPPED, not queued (owner same-day ruling); a fan-out where NOTHING was
// accepted queues nothing — the callers' own defer/skip paths re-fire the
// whole notice.

jest.mock('../models/db', () => {
  const inserts = [];
  const chain = () => {
    const q = {};
    ['where', 'whereRaw', 'whereNotNull', 'whereIn', 'orderBy', 'select'].forEach((m) => { q[m] = jest.fn(() => q); });
    q.first = jest.fn(async () => null);
    q.insert = jest.fn(async (row) => { inserts.push(row); });
    return q;
  };
  const mockDb = jest.fn(() => chain());
  mockDb.raw = jest.fn((sql) => sql);
  mockDb._inserts = inserts;
  return mockDb;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../routes/admin-sms-templates', () => ({ getTemplate: jest.fn() }));
jest.mock('../config/twilio-numbers', () => ({ getOutboundNumber: jest.fn(() => '+19413180000') }));
jest.mock('../services/customer-contact', () => ({
  getAppointmentContacts: jest.fn(() => []),
  isServiceContactRole: jest.fn((role) => role !== 'primary'),
  getPrimaryContact: jest.fn(() => ({ phone: null })),
  prefsUnavailable: jest.fn(() => false),
}));
jest.mock('../services/recipient-optin', () => ({
  filterRecipientsByOptin: jest.fn(async (contacts) => contacts),
}));
jest.mock('../services/appointment-email', () => ({
  sendAppointmentConfirmationEmail: jest.fn(async () => ({ ok: true })),
  sendAppointmentReminderEmail: jest.fn(async () => ({ ok: true })),
  sendTechEnRouteEmail: jest.fn(async () => ({ ok: true })),
}));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({})) }));

const db = require('../models/db');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { getAppointmentContacts } = require('../services/customer-contact');
const AppointmentReminders = require('../services/appointment-reminders');

const CUSTOMER = { id: 'cust-1', phone: '+19415550001' };
const PRIMARY = { phone: '+19415550001', role: 'primary' };
const SPOUSE = { phone: '+19415550002', role: 'spouse' };

const ACCEPTED = { sent: true };
const HELD = {
  sent: false,
  blocked: true,
  code: 'QUIET_HOURS_HOLD',
  retryable: true,
  deferred: true,
  nextAllowedAt: '2026-08-11T12:00:00.000Z',
};

describe('safeSendAppointment partial fan-out across the send-window boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db._inserts.length = 0;
    getAppointmentContacts.mockReturnValue([PRIMARY, SPOUSE]);
  });

  test('an accepted primary + held secondary queues ONLY the held contact, frozen to its own phone', async () => {
    sendCustomerMessage.mockResolvedValueOnce(ACCEPTED).mockResolvedValueOnce(HELD);
    const outcome = {};
    const sent = await AppointmentReminders.safeSendAppointment(
      CUSTOMER, {}, async (c) => `Hi ${c.role}`, 'confirmation', 'appointment_confirmation',
      { scheduled_service_id: 'ss-1' }, { sendOutcome: outcome },
    );
    expect(sent).toBe(true);
    expect(db._inserts).toHaveLength(1);
    const row = db._inserts[0];
    expect(row.to_phone).toBe(SPOUSE.phone);
    expect(row.status).toBe('scheduled');
    expect(row.scheduled_for).toEqual(new Date(HELD.nextAllowedAt));
    const meta = JSON.parse(row.metadata);
    expect(meta.entry_point).toBe('appointment_notice_contact_deferred');
    expect(meta.scheduled_service_id).toBe('ss-1');
    expect(meta.replay_purpose).toBe('appointment_confirmation');
    expect(meta.refresh_customer_phone).toBeUndefined();
    // The sticky defer-don't-close evidence still reads held for callers.
    expect(outcome.blockedCode).toBe('QUIET_HOURS_HOLD');
  });

  test('a held 24h-reminder contact is skipped, never queued onto the visit day', async () => {
    sendCustomerMessage.mockResolvedValueOnce(ACCEPTED).mockResolvedValueOnce(HELD);
    const sent = await AppointmentReminders.safeSendAppointment(
      CUSTOMER, {}, async () => 'Reminder', 'appointment_reminder', 'appointment_reminder_24h',
      { scheduled_service_id: 'ss-1' }, {},
    );
    expect(sent).toBe(true);
    expect(db._inserts).toHaveLength(0);
  });

  test('a fan-out where nothing was accepted queues nothing — the whole-notice defer path owns it', async () => {
    sendCustomerMessage.mockResolvedValue(HELD);
    const outcome = {};
    const sent = await AppointmentReminders.safeSendAppointment(
      CUSTOMER, {}, async () => 'Confirm', 'confirmation', 'appointment_confirmation',
      { scheduled_service_id: 'ss-1' }, { sendOutcome: outcome },
    );
    expect(sent).toBe(false);
    expect(db._inserts).toHaveLength(0);
    expect(outcome.blockedCode).toBe('QUIET_HOURS_HOLD');
  });

  test('r21: operator provenance rides the fan-out — an authenticated action is exempt from the window', async () => {
    sendCustomerMessage.mockResolvedValue(ACCEPTED);
    await AppointmentReminders.safeSendAppointment(
      CUSTOMER, {}, async () => 'Missed you', 'appointment_no_show', 'appointment_cancellation',
      { scheduled_service_id: 'ss-1' }, { operatorInitiated: true },
    );
    expect(sendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({ operatorInitiated: true }));

    // Default stays FENCED — an automated caller must never inherit it.
    sendCustomerMessage.mockClear();
    await AppointmentReminders.safeSendAppointment(
      CUSTOMER, {}, async () => 'Reminder', 'appointment_reminder', 'appointment_reminder_24h',
      { scheduled_service_id: 'ss-1' }, {},
    );
    expect(sendCustomerMessage).toHaveBeenCalledWith(expect.not.objectContaining({ operatorInitiated: true }));
  });

  test('r21: a one-shot notice with no re-fire path queues EVERY held contact on a full hold', async () => {
    sendCustomerMessage.mockResolvedValue(HELD);
    const sent = await AppointmentReminders.safeSendAppointment(
      CUSTOMER, {}, async (c) => `Missed you ${c.role}`, 'appointment_no_show', 'appointment_cancellation',
      { scheduled_service_id: 'ss-1' }, { queueHeldContactsOnFullHold: true },
    );
    expect(sent).toBe(false);
    expect(db._inserts).toHaveLength(2);
    expect(db._inserts.map((r) => r.to_phone)).toEqual([PRIMARY.phone, SPOUSE.phone]);
    expect(JSON.parse(db._inserts[0].metadata).entry_point).toBe('appointment_notice_contact_deferred');
  });

  test('a later NON-hold block (opt-out) is not misread as held — nothing queued for it', async () => {
    sendCustomerMessage
      .mockResolvedValueOnce(ACCEPTED)
      .mockResolvedValueOnce({ sent: false, blocked: true, code: 'RECIPIENT_OPTED_OUT' });
    const sent = await AppointmentReminders.safeSendAppointment(
      CUSTOMER, {}, async () => 'Confirm', 'confirmation', 'appointment_confirmation',
      { scheduled_service_id: 'ss-1' }, {},
    );
    expect(sent).toBe(true);
    expect(db._inserts).toHaveLength(0);
  });
});
