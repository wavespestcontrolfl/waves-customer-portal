// Visit-only text recipients (GATE_CALL_GIVEN_VISIT_TEXTS, owner 2026-11-24 "yes, visit only").
//
// A caller books a visit and gives another person's number ("my husband Bob will be home, text him too").
// Bob gets THAT visit's confirmation, reminders and en-route text, and nothing else. This file pins:
//   - who is eligible (one pure function, judged on the V2 entry alone);
//   - the senders (safeSendAppointment for the confirmation + reminders, sendTechEnRoute; the call
//     pipeline's own sends are in call-visit-recipient-pipeline.test.js): gate off = unchanged, gate on =
//     Bob is added for those texts only;
//   - that the permission never touches the account's consent, slots, opt-in rows, login, review asks or email.
// The SQL semantics (one row per visit and number, the once-per-slot claim, the cascade) run on real
// PostgreSQL in call-visit-recipient-postgres.test.js.

jest.mock('../models/db', () => {
  const chain = () => {
    const q = {};
    ['where', 'whereRaw', 'whereNotNull', 'whereIn', 'orderBy', 'select'].forEach((m) => { q[m] = jest.fn(() => q); });
    q.first = jest.fn(async () => null);
    q.insert = jest.fn(async () => {});
    return q;
  };
  const mockDb = jest.fn(() => chain());
  mockDb.raw = jest.fn((sql) => sql);
  return mockDb;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../routes/admin-sms-templates', () => ({ getTemplate: jest.fn() }));
jest.mock('../config/twilio-numbers', () => ({ getOutboundNumber: jest.fn(() => '+19413180000') }));
jest.mock('../services/customer-contact', () => ({
  getAppointmentContacts: jest.fn(() => []),
  isServiceContactRole: jest.fn((role) => String(role || '').startsWith('service_contact')),
  getPrimaryContact: jest.fn(() => ({ phone: null })),
  prefsUnavailable: jest.fn(() => false),
  firstNameFrom: jest.fn((name) => String(name || '').trim().split(/\s+/)[0] || null),
}));
jest.mock('../services/recipient-optin', () => ({
  filterRecipientsByOptin: jest.fn(async (contacts) => contacts),
}));
jest.mock('../services/contact-notification-prefs', () => ({
  filterContactsByOwnPrefs: jest.fn(async (contacts) => contacts),
}));
jest.mock('../services/appointment-email', () => ({
  sendAppointmentConfirmationEmail: jest.fn(async () => ({ ok: true })),
  sendAppointmentReminderEmail: jest.fn(async () => ({ ok: true })),
  sendTechEnRouteEmail: jest.fn(async () => ({ ok: true })),
}));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({})) }));
jest.mock('../services/disclaimed-number-holds', () => ({
  disclaimedNumberHeldForVisit: jest.fn(async () => false),
  disclaimedNumberHeld: jest.fn(async () => false),
}));
jest.mock('../services/short-url', () => ({ shortenOrPassthrough: jest.fn(async (url) => url) }));
// The recipient module's database reads (who is on this visit, the once-per-slot claim) run on real
// PostgreSQL in call-visit-recipient-postgres.test.js; here the senders' use of it is what is pinned.
jest.mock('../services/call-visit-recipient', () => {
  const actual = jest.requireActual('../services/call-visit-recipient');
  return {
    ...actual,
    contactsForVisit: jest.fn(async () => []),
    sendOnce: jest.fn(async (contact, send) => ({ skipped: false, result: await send() })),
  };
});

const fs = require('fs');
const path = require('path');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { getAppointmentContacts } = require('../services/customer-contact');
const VisitRecipient = require('../services/call-visit-recipient');
const AppointmentReminders = require('../services/appointment-reminders');
const TwilioService = require('../services/twilio');
const smsTemplatesRouter = require('../routes/admin-sms-templates');

const HOLDER = '+19415550001';
const BOB = '+19415550002';
const CUSTOMER = { id: 'cust-1', phone: HOLDER, first_name: 'Phyllis' };
const PRIMARY = { phone: HOLDER, role: 'primary', name: 'Phyllis Roe' };
const BOB_CONTACT = {
  phone: BOB, email: null, name: 'Bob Roe', role: VisitRecipient.ROLE, visitRecipientId: 'vtr-1', claimKey: 'confirmation:2026-12-01T09:00',
};

const GATE = 'GATE_CALL_GIVEN_VISIT_TEXTS';
const gateBefore = process.env[GATE];
afterAll(() => { if (gateBefore === undefined) delete process.env[GATE]; else process.env[GATE] = gateBefore; });
beforeEach(() => {
  jest.clearAllMocks();
  delete process.env[GATE];
  getAppointmentContacts.mockReturnValue([PRIMARY]);
  sendCustomerMessage.mockResolvedValue({ sent: true });
  VisitRecipient.contactsForVisit.mockResolvedValue([]);
});

// --- eligibility -----------------------------------------------------------------------------

describe('eligibleEntries: one rule, judged on the V2 entry alone', () => {
  const entry = (over = {}) => ({
    first_name: 'Bob', last_name: 'Roe', phone_e164: BOB, role: 'spouse_partner', wants_notifications: true, ...over,
  });
  const eligible = (extraction, opts) => VisitRecipient.eligibleEntries(extraction, opts);

  test('the notify request on the entry that carries the phone makes it eligible, in E.164 with its name and role', () => {
    expect(eligible({ secondary_contacts: [entry()] })).toEqual([
      { phoneKey: '9415550002', phoneE164: BOB, firstName: 'Bob', lastName: 'Roe', role: 'spouse_partner' },
    ]);
  });

  test('an on-site role with the appointment-text flag or the on-site flag is eligible without wants_notifications', () => {
    expect(eligible({ secondary_contacts: [entry({ wants_notifications: false, wants_appointment_texts: true })] })).toHaveLength(1);
    expect(eligible({ secondary_contact: entry({ wants_notifications: false, on_site: true }) })).toHaveLength(1);
  });

  test('the flag must sit on the SAME entry as the phone: a flag on a different entry never moves onto this number', () => {
    const carriesPhone = entry({ wants_notifications: false, role: 'spouse_partner' });
    const carriesFlag = entry({ phone_e164: null, first_name: 'Bob', wants_notifications: true });
    expect(eligible({ secondary_contact: carriesFlag, secondary_contacts: [carriesPhone] })).toEqual([]);
  });

  test('an on-site flag on a role that is not an on-site role (a realtor, a lender) is not a request to text them', () => {
    expect(eligible({ secondary_contacts: [entry({ wants_notifications: false, wants_appointment_texts: true, role: 'real_estate_agent' })] })).toEqual([]);
  });

  test('a merely mentioned person (no request, no flag) and an entry with no phone are not eligible', () => {
    expect(eligible({ secondary_contacts: [entry({ wants_notifications: false })] })).toEqual([]);
    expect(eligible({ secondary_contacts: [entry({ phone_e164: null })] })).toEqual([]);
  });

  test('a number no NANP line can have is never eligible', () => {
    expect(eligible({ secondary_contacts: [entry({ phone_e164: '+11735550100' })] })).toEqual([]);
    expect(eligible({ secondary_contacts: [entry({ phone_e164: '+4420794609' })] })).toEqual([]);
  });

  test('the call legs, the caller numbers and the account holder number are excluded', () => {
    const call = { from_phone: '+19415550010', to_phone: '+19413180000' };
    const excludes = VisitRecipient.callerNumbers({
      call, contactPhone: '+19415550011', extractedPhone: '+19415550012',
      v2Extraction: { caller: { phone_e164: '+19415550013', text_phone_e164: '+19415550014' } },
    });
    expect(excludes).toHaveLength(6);
    for (const phone of excludes) {
      expect(eligible({ secondary_contacts: [entry({ phone_e164: phone })] }, { excludePhones: excludes })).toEqual([]);
    }
    // Formatting does not hide a match.
    expect(eligible({ secondary_contacts: [entry({ phone_e164: '+19415550010' })] }, { excludePhones: ['(941) 555-0010'] })).toEqual([]);
    expect(eligible({ secondary_contacts: [entry()] }, { excludePhones: excludes })).toHaveLength(1);
  });

  test('the singleton and its array mirror dedupe by phone; three entries at most come from the mapper', () => {
    expect(eligible({ secondary_contact: entry(), secondary_contacts: [entry()] })).toHaveLength(1);
  });
});

describe('kindForSend: only the confirmation and the two reminders are on the list', () => {
  test('the three texts map to a kind', () => {
    expect(VisitRecipient.kindForSend('confirmation', 'appointment_confirmation')).toBe('confirmation');
    expect(VisitRecipient.kindForSend('reminder_72h', 'appointment_reminder_72h')).toBe('reminder_72h');
    expect(VisitRecipient.kindForSend('appointment_reminder', 'appointment_reminder_24h')).toBe('reminder_24h');
  });

  test('a reschedule, cancellation, no-show, series cancel, arrival, completion or review send maps to nothing', () => {
    expect(VisitRecipient.kindForSend('appointment_rescheduled', 'appointment_confirmation')).toBeNull();
    expect(VisitRecipient.kindForSend('appointment_cancelled', 'appointment_cancellation')).toBeNull();
    expect(VisitRecipient.kindForSend('appointment_no_show', 'appointment_cancellation')).toBeNull();
    expect(VisitRecipient.kindForSend('appointment_series_cancelled', 'appointment_cancellation')).toBeNull();
    expect(VisitRecipient.kindForSend('tech_arrived', 'tech_arrived')).toBeNull();
    expect(VisitRecipient.kindForSend('service_completion', 'service_completion')).toBeNull();
    expect(VisitRecipient.kindForSend('review_request', 'review_request')).toBeNull();
    // A matching type with the wrong policy purpose is not the text either.
    expect(VisitRecipient.kindForSend('confirmation', 'appointment_cancellation')).toBeNull();
  });
});

// --- the gate -----------------------------------------------------------------------------------

describe('gateLive', () => {
  test('strict true only, read at call time', () => {
    for (const value of [undefined, '', '1', 'on', 'TRUE', 'yes', 'false']) {
      if (value === undefined) delete process.env[GATE]; else process.env[GATE] = value;
      expect(VisitRecipient.gateLive()).toBe(false);
    }
    process.env[GATE] = 'true';
    expect(VisitRecipient.gateLive()).toBe(true);
    delete process.env[GATE];
    expect(VisitRecipient.gateLive()).toBe(false);
  });
});

// --- safeSendAppointment: the confirmation and the reminders --------------------------------------------

describe('safeSendAppointment adds the visit-only recipient to the confirmation and the reminders', () => {
  const send = (messageType, purpose, sendOptions = {}) => AppointmentReminders.safeSendAppointment(
    CUSTOMER, {}, async (contact) => `Hi ${contact.name || 'there'}`, messageType, purpose,
    { scheduled_service_id: 'ss-1' }, sendOptions,
  );
  const sentTo = () => sendCustomerMessage.mock.calls.map(([input]) => input.to);

  test('gate OFF: the recipient module is never asked and only the account contact is texted', async () => {
    VisitRecipient.contactsForVisit.mockResolvedValue([BOB_CONTACT]);
    await send('confirmation', 'appointment_confirmation');
    expect(VisitRecipient.contactsForVisit).not.toHaveBeenCalled();
    expect(sentTo()).toEqual([HOLDER]);
  });

  test.each([
    ['confirmation', 'appointment_confirmation', 'confirmation'],
    ['reminder_72h', 'appointment_reminder_72h', 'reminder_72h'],
    ['appointment_reminder', 'appointment_reminder_24h', 'reminder_24h'],
  ])('gate ON: %s also texts the visit-only recipient, once, as a non-contact (no contact-login check)', async (messageType, purpose, kind) => {
    process.env[GATE] = 'true';
    VisitRecipient.contactsForVisit.mockResolvedValue([{ ...BOB_CONTACT, claimKey: `${kind}:2026-12-01T09:00` }]);
    const sent = await send(messageType, purpose);
    expect(sent).toBe(true);
    expect(VisitRecipient.contactsForVisit).toHaveBeenCalledWith('ss-1', kind, { excludePhones: [HOLDER] });
    expect(sentTo()).toEqual([HOLDER, BOB]);
    const bobSend = sendCustomerMessage.mock.calls[1][0];
    expect(bobSend.identityTrustLevel).toBe('phone_matches_customer');
    expect(bobSend.purpose).toBe(purpose);
    expect(bobSend.appointmentId).toBe('ss-1');
    expect(bobSend.body).toBe('Hi Bob Roe');
    expect(VisitRecipient.sendOnce).toHaveBeenCalledTimes(1);
  });

  test('gate ON: a reschedule, a cancellation and a no-show never reach the recipient', async () => {
    process.env[GATE] = 'true';
    VisitRecipient.contactsForVisit.mockResolvedValue([BOB_CONTACT]);
    await send('appointment_rescheduled', 'appointment_confirmation');
    await send('appointment_cancelled', 'appointment_cancellation');
    await send('appointment_no_show', 'appointment_cancellation');
    await send('appointment_series_cancelled', 'appointment_cancellation');
    expect(VisitRecipient.contactsForVisit).not.toHaveBeenCalled();
    expect(new Set(sentTo())).toEqual(new Set([HOLDER]));
  });

  test('gate ON: a notice with no scheduled_service_id never reaches the recipient (no visit, no permission)', async () => {
    process.env[GATE] = 'true';
    VisitRecipient.contactsForVisit.mockResolvedValue([BOB_CONTACT]);
    await AppointmentReminders.safeSendAppointment(CUSTOMER, {}, async () => 'Hi', 'confirmation', 'appointment_confirmation', {}, {});
    expect(VisitRecipient.contactsForVisit).not.toHaveBeenCalled();
  });

  test('gate ON: the number the notice already texts is excluded from the recipient list (no double send to the holder)', async () => {
    process.env[GATE] = 'true';
    getAppointmentContacts.mockReturnValue([PRIMARY, { phone: BOB, role: 'service_contact', name: 'Bob Roe' }]);
    await send('confirmation', 'appointment_confirmation');
    expect(VisitRecipient.contactsForVisit).toHaveBeenCalledWith('ss-1', 'confirmation', { excludePhones: [HOLDER, BOB] });
  });

  test('gate ON: the recipient send never decides the account holder outcome (holder blocked + Bob accepted = not sent)', async () => {
    process.env[GATE] = 'true';
    VisitRecipient.contactsForVisit.mockResolvedValue([BOB_CONTACT]);
    sendCustomerMessage
      .mockResolvedValueOnce({ sent: false, blocked: true, code: 'NO_CONSENT_RECORD' })
      .mockResolvedValueOnce({ sent: true });
    const outcome = {};
    const sent = await send('confirmation', 'appointment_confirmation', { sendOutcome: outcome });
    expect(sent).toBe(false);
    expect(outcome.providerAccepted).toBeUndefined();
    expect(outcome.failedRecipients).toEqual(['account holder']);
  });

  test('gate ON: a recipient failure never throws into the holder send or changes its result', async () => {
    process.env[GATE] = 'true';
    VisitRecipient.contactsForVisit.mockRejectedValue(new Error('boom'));
    await expect(send('confirmation', 'appointment_confirmation')).resolves.toBe(true);
    VisitRecipient.contactsForVisit.mockResolvedValue([BOB_CONTACT]);
    sendCustomerMessage.mockResolvedValueOnce({ sent: true }).mockRejectedValueOnce(new Error('twilio down'));
    await expect(send('confirmation', 'appointment_confirmation')).resolves.toBe(true);
  });

  test('gate ON: a callback-number hold on the visit keeps the recipient out too', async () => {
    process.env[GATE] = 'true';
    const holds = require('../services/disclaimed-number-holds');
    holds.disclaimedNumberHeldForVisit.mockResolvedValueOnce(true);
    VisitRecipient.contactsForVisit.mockResolvedValue([BOB_CONTACT]);
    const sent = await send('confirmation', 'appointment_confirmation');
    expect(sent).toBe(false);
    expect(VisitRecipient.contactsForVisit).not.toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('gate ON: a notice with no account contact at all sends no visit-only text either', async () => {
    process.env[GATE] = 'true';
    getAppointmentContacts.mockReturnValue([]);
    VisitRecipient.contactsForVisit.mockResolvedValue([BOB_CONTACT]);
    await expect(send('confirmation', 'appointment_confirmation')).resolves.toBe(false);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });
});

// --- sendTechEnRoute --------------------------------------------------------------------------------------

describe('sendTechEnRoute adds the visit-only recipient to the en-route text', () => {
  const PREFS = { tech_en_route: true, sms_enabled: true, appointment_notify_primary: true };

  beforeEach(() => {
    const db = require('../models/db');
    db.mockImplementation((table) => {
      const q = {};
      ['where', 'whereRaw', 'orderBy', 'select'].forEach((m) => { q[m] = jest.fn(() => q); });
      q.first = jest.fn(async () => (table === 'customers' ? CUSTOMER : null));
      return q;
    });
    jest.spyOn(TwilioService, '_visitPrefsFor').mockResolvedValue(PREFS);
    jest.spyOn(AppointmentReminders, 'resolveChannelPrefsRow').mockResolvedValue({ en_route_channel: 'sms' });
    smsTemplatesRouter.getTemplate.mockResolvedValue('Hi, your tech is on the way');
  });
  afterEach(() => jest.restoreAllMocks());

  const enRoute = () => TwilioService.sendTechEnRoute('cust-1', 'Pat', 15, 'tok-1', { scheduledServiceId: 'ss-1' });
  const sentTo = () => sendCustomerMessage.mock.calls.map(([input]) => input.to);

  test('gate OFF: only the account contact is texted and the recipient module is never asked', async () => {
    VisitRecipient.contactsForVisit.mockResolvedValue([BOB_CONTACT]);
    await enRoute();
    expect(VisitRecipient.contactsForVisit).not.toHaveBeenCalled();
    expect(sentTo()).toEqual([HOLDER]);
  });

  test('gate ON: the recipient gets the same en-route text for this visit, claimed once, as a non-contact', async () => {
    process.env[GATE] = 'true';
    VisitRecipient.contactsForVisit.mockResolvedValue([{ ...BOB_CONTACT, claimKey: 'en_route:2026-12-01T09:00' }]);
    const result = await enRoute();
    expect(VisitRecipient.contactsForVisit).toHaveBeenCalledWith('ss-1', 'en_route', { excludePhones: [HOLDER] });
    expect(sentTo()).toEqual([HOLDER, BOB]);
    const bobSend = sendCustomerMessage.mock.calls[1][0];
    expect(bobSend.purpose).toBe('tech_en_route');
    expect(bobSend.appointmentId).toBe('ss-1');
    expect(bobSend.identityTrustLevel).toBe('phone_matches_customer');
    expect(VisitRecipient.sendOnce).toHaveBeenCalledTimes(1);
    // The recipient's send is not part of the holder's results.
    expect(result.results).toHaveLength(1);
  });

  test('gate ON: the holder result is the same when the recipient send fails or throws', async () => {
    process.env[GATE] = 'true';
    VisitRecipient.contactsForVisit.mockResolvedValue([BOB_CONTACT]);
    sendCustomerMessage.mockResolvedValueOnce({ sent: true }).mockRejectedValueOnce(new Error('twilio down'));
    await expect(enRoute()).resolves.toMatchObject({ success: true });
    sendCustomerMessage.mockResolvedValueOnce({ sent: false, blocked: true }).mockResolvedValueOnce({ sent: true });
    const held = await enRoute();
    expect(held.success).toBe(false);
  });

  test('gate ON: a call without a visit id (legacy caller) reaches no recipient', async () => {
    process.env[GATE] = 'true';
    VisitRecipient.contactsForVisit.mockResolvedValue([BOB_CONTACT]);
    await TwilioService.sendTechEnRoute('cust-1', 'Pat', 15, 'tok-1', {});
    expect(VisitRecipient.contactsForVisit).not.toHaveBeenCalled();
  });
});

// --- scope: what the permission can never reach -----------------------------------------------------------

describe('the permission stays on the visit row', () => {
  const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const code = (file) => read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  test('the recipient module never reads or writes consent, slots, opt-in rows, login, review asks or email', () => {
    const source = code('services/call-visit-recipient.js');
    for (const forbidden of [
      'service_contacts_consent', 'service_contact_phone', 'service_contact2', 'service_contact3', 'service_preferences',
      'recipient_optin', 'recipient-optin', 'contact-notification-prefs', 'contact_login', 'review', 'appointment-email',
      'sendAppointmentConfirmationEmail', 'notification_prefs', 'customer_accounts', 'persistCallSecondaryContact',
    ]) {
      expect(source).not.toContain(forbidden);
    }
    // Other tables are only read; the one table it writes is the visit's own (conn(TABLE)).
    expect([...new Set([...source.matchAll(/conn\('([a-z_]+)(?: as [a-z])?'\)/g)].map((m) => m[1]))].sort())
      .toEqual(['customers', 'messaging_suppression', 'scheduled_services']);
    expect(source).toContain("const TABLE = 'visit_text_recipients';");
    expect(source).not.toMatch(/conn\('(customers|messaging_suppression|scheduled_services)(?: as [a-z])?'\)[^;]*\.(insert|update|del|delete)\(/);
    expect(source).not.toMatch(/conn\('customers'\)[^;]*\.(insert|update|del|delete)\(/);
  });

  test('the senders ask one helper, and the gate stays off by default (no entry in the gates object, read at call time)', () => {
    expect(code('services/appointment-reminders.js')).toContain('sendToVisitOnlyRecipients');
    expect(code('services/twilio.js')).toContain('visitRecipients.sendOnce');
    const gatesSource = read('config/feature-gates.js');
    expect(gatesSource).toContain("return process.env.GATE_CALL_GIVEN_VISIT_TEXTS === 'true';");
    expect(gatesSource).toContain('module.exports.callGivenVisitTextsLive = callGivenVisitTextsLive;');
  });

  test('the migration keys the permission to the visit row, with a cascade and a unique visit + number key', () => {
    const migration = read('models/migrations/20261124170000_visit_text_recipients.js');
    expect(migration).toMatch(/references\('id'\)\.inTable\('scheduled_services'\)\.onDelete\('CASCADE'\)/);
    expect(migration).toContain("t.unique(['scheduled_service_id', 'phone_key']");
    expect(migration).not.toMatch(/inTable\('customers'\)/);
  });
});
