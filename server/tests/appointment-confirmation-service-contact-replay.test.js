/**
 * sendConfirmationToServiceContact: the booking confirmation replayed to an
 * on-site recipient after their YES to the opt-in ask (owner redesign
 * 2026-10-01). Same template as the primary's confirmation (shared
 * renderConfirmationBody), service-contact trust floor, inbound-reply
 * provenance only when answering the YES, revalidation through the same
 * appointment-recipient resolvers every appointment text uses, a visit-lifetime
 * sms_log dedupe per phone + visit, the canonical customer-promised arrival,
 * and the shared delivery verdict (classifyDeliveryCertainty).
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(async () => ({ sent: true, deliveryOutcome: 'accepted' })),
  // Mirrors the real contract (send-customer-message.js classifyDeliveryCertainty).
  classifyDeliveryCertainty: jest.fn((o) => {
    if (!o) return 'unknown';
    if (o.deliveryOutcome === 'accepted') return 'sent';
    if (o.deliveryOutcome === 'not_sent') return 'not_sent';
    if (o.deliveryOutcome === 'uncertain') return 'unknown';
    return o.blocked === true ? 'not_sent' : 'unknown';
  }),
}));
jest.mock('../services/messaging/validators/line-type', () => ({
  readCachedLineType: jest.fn(async () => ({ state: 'hit', lineType: 'mobile' })),
  cacheLineType: jest.fn(),
  NON_SMS_LINE_TYPES: new Set(['landline', 'fixedVoip']),
}));
// The appointment-recipient resolver: the account's consented slot phones.
jest.mock('../services/customer-contact', () => ({
  getAppointmentContacts: jest.fn((acct) => (acct && acct.service_contacts_consent_at
    ? [{ phone: acct.service_contact_phone, name: 'Sample Spouse', role: 'service_contact' }]
    : [])),
  isServiceContactRole: jest.fn(() => true),
  firstNameFrom: jest.fn((n) => String(n || '').split(/\s+/)[0]),
  prefsUnavailable: jest.fn(() => false),
  PREFS_UNAVAILABLE: { __prefsUnavailable: true },
  getPrimaryContact: jest.fn(() => ({})),
}));
jest.mock('../services/recipient-optin', () => ({ filterRecipientsByOptin: jest.fn(async (c) => c) }));
// Canonical arrival: the reservation helper returns the group's arrival start.
jest.mock('../services/reservation-arrival', () => ({ arrivalStartForService: jest.fn(async (_db, svc) => svc.__arrival || svc.window_start) }));
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
const dayAhead = (n) => new Date(Date.now() + n * 24 * 3600000).toISOString().slice(0, 10);
const SVC = { id: 's1', status: 'confirmed', service_type: 'Pest Control', customer_confirmed: true, scheduled_date: dayAhead(3), window_start: '10:00:00' };
const ACCT = { id: 'c1', service_contact_phone: '+15550100123', service_contacts_consent_at: new Date('2026-10-01T00:00:00Z') };

function chain(first, { rejects = false } = {}) {
  const q = { calls: { whereRaw: [], whereNotIn: [] } };
  ['where', 'whereNull', 'orderBy'].forEach((m) => { q[m] = jest.fn(() => q); });
  q.whereRaw = jest.fn((...args) => { q.calls.whereRaw.push(args); return q; });
  q.whereNotIn = jest.fn((col, list) => { q.calls.whereNotIn.push(list); return q; });
  q.first = jest.fn(async () => {
    if (rejects) throw new Error('db down');
    // The status filter the caller asked for (whereNotIn) is honored.
    if (first && q.calls.whereNotIn.some((list) => list.includes(first.status))) return undefined;
    // knex's .first() answers undefined (never null) for no row.
    return first === null ? undefined : first;
  });
  return q;
}
let lastSmsLog = null;
function wire({ svc = SVC, reminder = { cancelled: false, service_type: null, confirmation_sent: true }, dup = null, dupRejects = false, prefsRow, prefsFail = false, acct = ACCT, optin = { status: 'confirmed' }, optinRejects = false } = {}) {
  db.mockImplementation((table) => {
    if (table === 'customers') return chain(acct);
    if (table === 'recipient_optin') return chain(optin, { rejects: optinRejects });
    if (table === 'scheduled_services') return chain(svc);
    if (table === 'notification_prefs') return chain(prefsRow, { rejects: prefsFail });
    if (table === 'appointment_reminders') return chain(reminder);
    if (table === 'sms_log') { lastSmsLog = chain(dup, { rejects: dupRejects }); return lastSmsLog; }
    return chain(undefined);
  });
}
const send = (extra = {}) => AppointmentReminders.sendConfirmationToServiceContact({ customerId: 'c1', scheduledServiceId: 's1', contact, ...extra });

beforeEach(() => { jest.clearAllMocks(); });

describe('sendConfirmationToServiceContact', () => {
  test('sends once: service-contact trust, the canonical arrival, not a reply unless answering the YES', async () => {
    wire();
    expect(await send()).toEqual({ sent: true });
    const arg = sendCustomerMessage.mock.calls[0][0];
    expect(arg).toMatchObject({
      to: '+15550100123',
      channel: 'sms',
      audience: 'customer',
      purpose: 'appointment_confirmation',
      customerId: 'c1',
      appointmentId: 's1',
      identityTrustLevel: 'service_contact_authorized',
      conversationalContext: false,
      renderedSlotMs: AppointmentReminders.composeScheduledApptTime(SVC).getTime(),
      metadata: { original_message_type: 'confirmation', scheduled_service_id: 's1', entry_point: 'recipient_optin_confirmed_replay' },
    });
    expect(arg).not.toHaveProperty('customerInitiated');
    expect(arg.body).toContain('CONFIRM appointment_confirmation for Sample Pest Control');
    wire();
    await send({ inReplyToYes: true });
    expect(sendCustomerMessage.mock.calls[1][0].conversationalContext).toBe(true);
  });

  test('a combined allocation\'s later member quotes the group\'s arrival, not its own work slot', async () => {
    wire({ svc: { ...SVC, window_start: '14:00:00', __arrival: '10:00:00' } });
    await send();
    expect(sendCustomerMessage.mock.calls[0][0].renderedSlotMs).toBe(AppointmentReminders.composeScheduledApptTime(SVC).getTime());
  });

  test('the reminder row not registered yet still sends', async () => {
    wire({ reminder: null });
    expect(await send()).toEqual({ sent: true });
  });

  test('never for a dead, under-way, rescheduling, pulled, missing or past visit', async () => {
    for (const status of ['cancelled', 'completed', 'en_route', 'rescheduled']) {
      wire({ svc: { ...SVC, status } });
      expect((await send()).reason).toBe('visit_not_live');
    }
    wire({ reminder: { cancelled: true } });
    expect((await send()).reason).toBe('visit_not_live');
    wire({ svc: null });
    expect((await send()).reason).toBe('visit_not_live');
    wire({ svc: { ...SVC, scheduled_date: dayAhead(-2) } });
    expect((await send()).reason).toBe('visit_not_live');
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('the account\'s confirmation choices: email-only channel, SMS off or confirmations off = no text; unreadable prefs retries', async () => {
    for (const prefsRow of [{ appointment_confirmation_channel: 'email' }, { sms_enabled: false }, { appointment_confirmation: false }]) {
      wire({ prefsRow });
      expect(await send()).toEqual({ sent: false, reason: 'sms_not_chosen' });
    }
    wire({ prefsFail: true });
    expect(await send()).toEqual({ sent: false, reason: 'error' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('revalidated through the appointment-recipient resolvers: not a recipient any more (slot / consent / hold / opt-in) = not sent', async () => {
    wire({ acct: { ...ACCT, service_contacts_consent_at: null } });
    expect(await send()).toEqual({ sent: false, reason: 'not_a_recipient' });
    wire({ acct: { ...ACCT, service_contact_phone: '+15550109999' } });
    expect(await send()).toEqual({ sent: false, reason: 'not_a_recipient' });
    wire({ optin: { status: 'declined' } });
    expect(await send()).toEqual({ sent: false, reason: 'not_a_recipient' });
    wire({ optin: null });
    expect(await send()).toEqual({ sent: false, reason: 'not_a_recipient' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('an unreadable opt-in row retries (error), never reads as a refusal', async () => {
    wire({ optinRejects: true });
    expect(await send()).toEqual({ sent: false, reason: 'error' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('the visit\'s own confirmation still pending (held): the replay waits for it (retryable), never sends a second copy', async () => {
    wire({ reminder: { cancelled: false, service_type: null, confirmation_sent: false } });
    expect(await send()).toEqual({ sent: false, reason: 'primary_confirmation_pending' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('dedupe: a prior send to this phone (last 10) for this visit blocks a resend; failed sends do not count; an unreadable dedupe retries', async () => {
    wire({ dup: { id: 'prior' } });
    expect(await send({ contact: { ...contact, phone: '(555) 010-0123' } })).toEqual({ sent: false, reason: 'already_sent' });
    const raws = lastSmsLog.calls.whereRaw.map(([sql, binds]) => [sql, binds]);
    expect(raws.some(([, binds]) => binds && binds[0] === '5550100123')).toBe(true);
    expect(raws.some(([sql]) => sql.includes("not in ('failed', 'undelivered', 'canceled')"))).toBe(true);
    // No time window: the dedupe spans the visit's lifetime.
    expect(raws.some(([sql]) => /created_at/.test(sql))).toBe(false);
    wire({ dupRejects: true });
    expect(await send()).toEqual({ sent: false, reason: 'error' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('customer-facing label: the reminder row\'s label, else the visit\'s, admin suffixes stripped', async () => {
    wire({ svc: { ...SVC, service_type: 'Pest Control (Quarterly) — Heavy' } });
    await send();
    expect(sendCustomerMessage.mock.calls[0][0].body).toContain(' Pest Control ');
    expect(sendCustomerMessage.mock.calls[0][0].body).not.toMatch(/Quarterly|Heavy/);
  });

  test('the shared delivery verdict: definitely not sent (incl. sentinels with sent:true) retries; uncertain is final', async () => {
    for (const [result, expected] of [
      [{ sent: true, sid: 'template-disabled', deliveryOutcome: 'not_sent' }, { sent: false, reason: 'not_sent' }],
      [{ sent: false, blocked: true, code: 'QUIET_HOURS_HOLD' }, { sent: false, reason: 'not_sent' }],
      [{ sent: true, deliveryOutcome: 'uncertain' }, { sent: false, reason: 'delivery_uncertain' }],
    ]) {
      wire();
      sendCustomerMessage.mockResolvedValueOnce(result);
      expect(await send()).toEqual(expected);
    }
  });
});
