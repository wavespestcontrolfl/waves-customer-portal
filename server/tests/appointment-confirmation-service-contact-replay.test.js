/**
 * sendConfirmationToServiceContact: the booking confirmation replayed to an
 * on-site recipient after their YES to the opt-in ask (owner redesign
 * 2026-10-01). Same template ladder as the primary's confirmation, service-
 * contact trust floor, inbound-reply (conversationalContext) provenance, and a
 * 24h sms_log dedupe per phone + visit. Live, future visits only.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(async () => ({ sent: true })),
}));
jest.mock('../services/messaging/validators/line-type', () => ({
  readCachedLineType: jest.fn(async () => ({ state: 'hit', lineType: 'mobile' })),
  cacheLineType: jest.fn(),
  NON_SMS_LINE_TYPES: new Set(['landline', 'fixedVoip']),
}));
jest.mock('../services/customer-contact', () => ({
  getAppointmentContacts: jest.fn(() => []),
  isServiceContactRole: jest.fn(() => true),
  firstNameFrom: jest.fn((n) => String(n || '').split(/\s+/)[0]),
  prefsUnavailable: jest.fn(() => false),
  PREFS_UNAVAILABLE: { __prefsUnavailable: true },
  getPrimaryContact: jest.fn(() => ({})),
}));
jest.mock('../services/recipient-optin', () => ({ filterRecipientsByOptin: jest.fn(async (c) => c) }));
jest.mock('../routes/admin-sms-templates', () => ({
  getTemplate: jest.fn(async (key, vars) => `CONFIRM ${key} for ${vars.first_name} ${vars.service_type} ${vars.date} ${vars.time}`),
}));
jest.mock('../services/estimate-card-holds', () => ({ cardHoldReminderLine: jest.fn(async () => '') }));
jest.mock('../services/reschedule-link', () => ({ buildRescheduleLink: jest.fn(async () => ({ url: null, line: '' })) }));
jest.mock('../services/appointment-link', () => ({ buildAppointmentLink: jest.fn(async () => ({ line: 'LINK' })) }));
jest.mock('../services/appointment-email', () => ({}));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({})) }));
jest.mock('../services/disclaimed-number-holds', () => ({ disclaimedNumberHeldForVisit: jest.fn(async () => false) }));

const db = require('../models/db');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const AppointmentReminders = require('../services/appointment-reminders');

const contact = { name: 'Sample Spouse', phone: '+15550100123', role: 'spouse_partner' };
const future = new Date(Date.now() + 48 * 3600000);

function chain(first) {
  const q = {};
  ['where', 'whereRaw', 'whereNull', 'orderBy'].forEach((m) => { q[m] = jest.fn(() => q); });
  q.first = jest.fn(async () => first);
  return q;
}
function wire({ svc = { id: 's1', status: 'confirmed', service_type: 'Pest Control', customer_confirmed: true }, reminder = { appointment_time: future, cancelled: false }, dup = null, prefsRow, prefsFail = false } = {}) {
  db.mockImplementation((table) => {
    if (table === 'scheduled_services') return chain(svc);
    if (table === 'notification_prefs') {
      if (prefsFail) { const q = chain(null); q.first = jest.fn(() => Promise.reject(new Error('db down'))); return q; }
      return chain(prefsRow);
    }
    if (table === 'appointment_reminders') return chain(reminder);
    if (table === 'sms_log') return chain(dup);
    return chain(undefined);
  });
}

beforeEach(() => { jest.clearAllMocks(); });

describe('sendConfirmationToServiceContact', () => {
  test('the reminder row not registered yet: the visit row\'s own date/time is used, and it still sends', async () => {
    const d = new Date(Date.now() + 72 * 3600000).toISOString().slice(0, 10);
    wire({ svc: { id: 's1', status: 'pending', service_type: 'Pest Control', scheduled_date: d, window_start: '10:00:00' }, reminder: null });
    const res = await AppointmentReminders.sendConfirmationToServiceContact({ customerId: 'c1', scheduledServiceId: 's1', contact });
    expect(res).toEqual({ sent: true });
  });

  test('a cancelled reminder row means the slot was pulled: not sent', async () => {
    wire({ reminder: { appointment_time: future, cancelled: true } });
    const res = await AppointmentReminders.sendConfirmationToServiceContact({ customerId: 'c1', scheduledServiceId: 's1', contact });
    expect(res).toEqual({ sent: false, reason: 'visit_not_live' });
  });

  test('sends the confirmation once: service-contact trust, inbound-reply provenance, not customer-initiated', async () => {
    wire();
    const res = await AppointmentReminders.sendConfirmationToServiceContact({ customerId: 'c1', scheduledServiceId: 's1', contact, inReplyToYes: true });
    expect(res).toEqual({ sent: true });
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    const arg = sendCustomerMessage.mock.calls[0][0];
    expect(arg).toMatchObject({
      to: '+15550100123',
      channel: 'sms',
      audience: 'customer',
      purpose: 'appointment_confirmation',
      customerId: 'c1',
      appointmentId: 's1',
      identityTrustLevel: 'service_contact_authorized',
      conversationalContext: true,
      renderedSlotMs: future.getTime(),
      metadata: { original_message_type: 'confirmation', scheduled_service_id: 's1', appointment_contact_role: 'spouse_partner' },
    });
    expect(arg).not.toHaveProperty('customerInitiated');
    expect(arg.body).toContain('CONFIRM appointment_confirmation for Sample Pest Control');
  });

  test('dedupes on sms_log (same phone + confirmation + visit within 24h)', async () => {
    wire({ dup: { id: 'prev' } });
    expect(await AppointmentReminders.sendConfirmationToServiceContact({ customerId: 'c1', scheduledServiceId: 's1', contact }))
      .toEqual({ sent: false, reason: 'already_sent' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('never for a dead, cancelled or past visit', async () => {
    for (const svc of [{ id: 's1', status: 'cancelled' }, { id: 's1', status: 'completed' }, { id: 's1', status: 'en_route' }]) {
      wire({ svc });
      expect((await AppointmentReminders.sendConfirmationToServiceContact({ customerId: 'c1', scheduledServiceId: 's1', contact })).reason).toBe('visit_not_live');
    }
    wire({ reminder: { appointment_time: new Date(Date.now() - 3600000), cancelled: false } });
    expect((await AppointmentReminders.sendConfirmationToServiceContact({ customerId: 'c1', scheduledServiceId: 's1', contact })).reason).toBe('visit_not_future');
    wire({ reminder: { appointment_time: future, cancelled: true } });
    expect((await AppointmentReminders.sendConfirmationToServiceContact({ customerId: 'c1', scheduledServiceId: 's1', contact })).reason).toBe('visit_not_live');
    wire({ svc: null });
    expect((await AppointmentReminders.sendConfirmationToServiceContact({ customerId: 'c1', scheduledServiceId: 's1', contact })).reason).toBe('visit_not_live');
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('missing input and a blocked send report a reason and never throw', async () => {
    expect((await AppointmentReminders.sendConfirmationToServiceContact({ customerId: 'c1', scheduledServiceId: 's1', contact: {} })).reason).toBe('missing_input');
    wire();
    sendCustomerMessage.mockResolvedValueOnce({ sent: false, code: 'CONSENT_REQUIRED' });
    expect(await AppointmentReminders.sendConfirmationToServiceContact({ customerId: 'c1', scheduledServiceId: 's1', contact }))
      .toEqual({ sent: false, reason: 'CONSENT_REQUIRED' });
  });

  test('a retry or booking-time reconcile (not answering a YES) honors the send window', async () => {
    wire();
    await AppointmentReminders.sendConfirmationToServiceContact({ customerId: 'c1', scheduledServiceId: 's1', contact });
    expect(sendCustomerMessage.mock.calls[0][0].conversationalContext).toBe(false);
  });

  test('honors the account\'s confirmation choices: email-only channel, SMS off or confirmations off = no text', async () => {
    for (const [opts, reason] of [
      [{ prefsRow: { appointment_confirmation_channel: 'email' } }, 'sms_not_chosen'],
      [{ prefsRow: { sms_enabled: false } }, 'sms_not_chosen'],
      [{ prefsRow: { appointment_confirmation: false } }, 'confirmation_off'],
      [{ prefsFail: true }, 'prefs_unavailable'],
    ]) {
      wire(opts);
      const res = await AppointmentReminders.sendConfirmationToServiceContact({ customerId: 'c1', scheduledServiceId: 's1', contact });
      expect(res).toEqual({ sent: false, reason });
    }
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });
});
