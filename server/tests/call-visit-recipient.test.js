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
  PREFS_UNAVAILABLE: Object.freeze({ __prefsUnavailable: true }),
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
  return { ...actual, notifyVisitRecipients: jest.fn(async () => true) };
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

const GATE = 'GATE_CALL_GIVEN_VISIT_TEXTS';
const gateBefore = process.env[GATE];
afterAll(() => { if (gateBefore === undefined) delete process.env[GATE]; else process.env[GATE] = gateBefore; });
beforeEach(() => {
  jest.clearAllMocks();
  delete process.env[GATE];
  getAppointmentContacts.mockReturnValue([PRIMARY]);
  sendCustomerMessage.mockResolvedValue({ sent: true });
});

// --- eligibility -----------------------------------------------------------------------------

describe('eligibleEntries: one rule, judged on the V2 entry alone', () => {
  const entry = (over = {}) => ({
    first_name: 'Bob', last_name: 'Roe', phone_e164: BOB, role: 'spouse_partner', wants_appointment_texts: true, ...over,
  });
  const eligible = (extraction, opts) => VisitRecipient.eligibleEntries(extraction, opts);

  test('the appointment-text request on the entry that carries the phone makes it eligible, in E.164 with its name and role', () => {
    expect(eligible({ secondary_contacts: [entry()] })).toEqual([
      { phoneKey: '9415550002', phoneE164: BOB, firstName: 'Bob', lastName: 'Roe', role: 'spouse_partner' },
    ]);
    expect(eligible({ secondary_contact: entry() })).toHaveLength(1);
  });

  test('a report-only request (wants_notifications) or a presence-only flag (on_site) is NOT a request to text them', () => {
    expect(eligible({ secondary_contacts: [entry({ wants_appointment_texts: false, wants_notifications: true })] })).toEqual([]);
    expect(eligible({ secondary_contacts: [entry({ wants_appointment_texts: false, on_site: true })] })).toEqual([]);
    expect(eligible({ secondary_contacts: [entry({ wants_appointment_texts: false, wants_notifications: true, on_site: true, role: 'tenant' })] })).toEqual([]);
  });

  test('the request must sit on the SAME entry as the phone: a flag on a different entry never moves onto this number', () => {
    const carriesPhone = entry({ wants_appointment_texts: false });
    const carriesFlag = entry({ phone_e164: null, first_name: 'Bob' });
    expect(eligible({ secondary_contact: carriesFlag, secondary_contacts: [carriesPhone] })).toEqual([]);
  });

  test('a merely mentioned person (no request) and an entry with no phone are not eligible', () => {
    expect(eligible({ secondary_contacts: [entry({ wants_appointment_texts: false })] })).toEqual([]);
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

  test('the singleton and its array mirror dedupe by phone', () => {
    expect(eligible({ secondary_contact: entry(), secondary_contacts: [entry()] })).toHaveLength(1);
  });
});

describe('informationalBody: no management link; only the en-route text carries the tracker link', () => {
  const facts = { label: 'Pest Control', day: 'Tuesday', date: 'December 1', window: 'between 9:00 AM and 11:00 AM' };

  test('the sender is "Waves", never "Waves Pest Control"', () => {
    for (const kind of ['confirmation', 'reminder_72h', 'reminder_24h', 'en_route']) {
      const body = VisitRecipient.informationalBody(kind, 'Bob', facts);
      expect(body).toMatch(/\bWaves\b/);
      expect(body).not.toContain('Waves Pest Control');
    }
  });

  test('a day-only promise names the day and no arrival window, the same as the holder text', () => {
    for (const kind of ['confirmation', 'reminder_72h']) {
      const body = VisitRecipient.informationalBody(kind, 'Bob', { ...facts, dayOnly: true });
      expect(body).toContain('Pest Control is scheduled for Tuesday, December 1.');
      expect(body).toContain('We will text you the arrival window the day before');
      expect(body).not.toMatch(/arriving|between|AM|PM/);
    }
  });

  test.each(['confirmation', 'reminder_72h', 'reminder_24h'])('%s names the visit and carries no link', (kind) => {
    const body = VisitRecipient.informationalBody(kind, 'Bob', facts);
    expect(body).toContain('Hi Bob');
    expect(body).toContain('Pest Control is scheduled for Tuesday, December 1, arriving between 9:00 AM and 11:00 AM.');
    expect(body).not.toMatch(/https?:|www\.|\.com|\/[a-z]+\/|link|reschedule|confirm\b|track/i);
    expect(body.length).toBeLessThan(300);
  });

  test('en route names the technician and the ETA and carries the tracker link (owner 2026-11-24)', () => {
    const body = VisitRecipient.informationalBody('en_route', 'Bob', { techName: 'Pat', etaMinutes: 15, trackUrl: 'https://x.test/t/abc' });
    expect(body).toBe('Hi Bob, Waves here. Pat is on the way, about 15 minutes away. Track live: https://x.test/t/abc Reply STOP to opt out.');
    expect(body).not.toMatch(/reschedule|confirm\b/i);
    expect(VisitRecipient.informationalBody('en_route', null, {})).toContain('Hi there,');
  });

  test('en route drops a missing or non-https tracker link', () => {
    for (const trackUrl of [undefined, null, '', 'http://x.test/t/abc', 'javascript:alert(1)', 'https://x.test/a b', 42]) {
      const body = VisitRecipient.informationalBody('en_route', 'Bob', { techName: 'Pat', trackUrl });
      expect(body).toBe('Hi Bob, Waves here. Pat is on the way. Reply STOP to opt out.');
    }
  });
});

describe('kindForNotice: only the confirmation and the two reminders are on the list', () => {
  test('the three notices map to a kind', () => {
    expect(VisitRecipient.kindForNotice('confirmation')).toBe('confirmation');
    expect(VisitRecipient.kindForNotice('72h')).toBe('reminder_72h');
    expect(VisitRecipient.kindForNotice('24h')).toBe('reminder_24h');
  });

  test('a reschedule, cancellation, no-show, arrival, en-route or any other notice maps to nothing', () => {
    for (const notice of ['rescheduled', 'cancelled', 'no_show', 'series_cancelled', 'tech_arrived', 'en_route', 'service_completion', 'review_request', '', null, undefined]) {
      expect(VisitRecipient.kindForNotice(notice)).toBeNull();
    }
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

describe('deliverAppointmentNotice dispatches the visit-only leg once per notice, whatever channel the holder chose', () => {
  const db = require('../models/db');
  const { deliverAppointmentNotice, deliverConfirmationByChannel } = AppointmentReminders._test;
  const notice = (over = {}) => deliverAppointmentNotice({
    channel: 'sms', kind: 'confirmation', customerId: 'cust-1', scheduledServiceId: 'ss-1',
    apptTime: new Date('2026-12-01T14:00:00.000Z'), serviceLabel: 'Pest Control',
    smsAttempt: jest.fn(async () => true), smsOutcome: { servedPhones: [HOLDER] }, dayState: { dayOnly: false }, ...over,
  });
  let prefsRow;

  beforeEach(() => {
    prefsRow = {};
    db.mockImplementation((table) => {
      const q = {};
      ['where', 'whereRaw', 'whereNotNull', 'whereIn', 'orderBy', 'select', 'leftJoin'].forEach((m) => { q[m] = jest.fn(() => q); });
      q.first = jest.fn(async () => (table === 'customers' ? CUSTOMER : table === 'notification_prefs' ? prefsRow : null));
      q.insert = jest.fn(async () => {});
      return q;
    });
  });

  test('gate OFF: the recipient module is never asked', async () => {
    await notice();
    expect(VisitRecipient.notifyVisitRecipients).not.toHaveBeenCalled();
  });

  test.each([
    ['confirmation', 'confirmation'],
    ['72h', 'reminder_72h'],
    ['24h', 'reminder_24h'],
  ])('gate ON: a %s notice hands the visit to the one recipient sender with the numbers it really texted', async (kind, recipientKind) => {
    process.env[GATE] = 'true';
    await notice({ kind });
    expect(VisitRecipient.notifyVisitRecipients).toHaveBeenCalledTimes(1);
    expect(VisitRecipient.notifyVisitRecipients.mock.calls[0][0]).toMatchObject({
      scheduledServiceId: 'ss-1', kind: recipientKind, excludePhones: [HOLDER], dayOnly: false,
    });
  });

  test.each(['sms', 'email', 'both'])('gate ON: a holder on %s still has the person texted, once', async (channel) => {
    process.env[GATE] = 'true';
    const AppointmentEmail = require('../services/appointment-email');
    AppointmentEmail.sendAppointmentConfirmationEmail.mockResolvedValue({ ok: true });
    AppointmentEmail.sendAppointmentReminderEmail.mockResolvedValue({ ok: true });
    await notice({ channel });
    expect(VisitRecipient.notifyVisitRecipients).toHaveBeenCalledTimes(1);
  });

  test('gate ON: a holder whose email-only notice texted nobody excludes nobody, even a number that is an allowed contact', async () => {
    process.env[GATE] = 'true';
    getAppointmentContacts.mockReturnValue([PRIMARY, { phone: BOB, role: 'service_contact', name: 'Bob Roe' }]);
    await notice({ channel: 'email', smsOutcome: {} });
    expect(VisitRecipient.notifyVisitRecipients.mock.calls[0][0].excludePhones).toEqual([]);
  });

  test('gate ON: only a number the notice really texted is excluded (a confirmed contact the fan-out texted)', async () => {
    process.env[GATE] = 'true';
    getAppointmentContacts.mockReturnValue([PRIMARY, { phone: BOB, role: 'service_contact', name: 'Bob Roe' }]);
    await notice({ smsOutcome: { servedPhones: [HOLDER, BOB] } });
    expect(VisitRecipient.notifyVisitRecipients.mock.calls[0][0].excludePhones).toEqual([HOLDER, BOB]);
    await notice({ smsOutcome: { servedPhones: [HOLDER] } });
    expect(VisitRecipient.notifyVisitRecipients.mock.calls[1][0].excludePhones).toEqual([HOLDER]);
  });

  test('gate ON: a confirmation another sender already logged to the number is skipped by the per-recipient gate; reminders have no such gate', async () => {
    process.env[GATE] = 'true';
    const logSpy = jest.spyOn(AppointmentReminders, 'confirmationLoggedForVisitPhone');
    await notice();
    const { gate } = VisitRecipient.notifyVisitRecipients.mock.calls[0][0];
    expect(typeof gate).toBe('function');
    await expect(gate({ phone: BOB })).resolves.toBe('send');
    logSpy.mockRestore();
    await notice({ kind: '72h' });
    expect(VisitRecipient.notifyVisitRecipients.mock.calls[1][0].gate).toBeUndefined();
  });

  test('gate ON: a customer with NO preferences row is on the defaults, so the person is still texted; an unreadable row holds', async () => {
    process.env[GATE] = 'true';
    prefsRow = undefined;
    await notice();
    expect(VisitRecipient.notifyVisitRecipients).toHaveBeenCalledTimes(1);
    db.mockImplementation((table) => {
      const q = {};
      ['where', 'whereRaw', 'whereNotNull', 'whereIn', 'orderBy', 'select', 'leftJoin'].forEach((m) => { q[m] = jest.fn(() => q); });
      q.first = jest.fn(async () => {
        if (table === 'notification_prefs') throw new Error('prefs read failed');
        return table === 'customers' ? CUSTOMER : null;
      });
      return q;
    });
    VisitRecipient.notifyVisitRecipients.mockClear();
    await notice();
    expect(VisitRecipient.notifyVisitRecipients).not.toHaveBeenCalled();
  });

  test('gate ON: the holder day-only promise rides along, so both people get the same promise', async () => {
    process.env[GATE] = 'true';
    await notice({ dayState: { dayOnly: true } });
    expect(VisitRecipient.notifyVisitRecipients.mock.calls[0][0].dayOnly).toBe(true);
  });

  test.each(['en_route', 'rescheduled', 'cancelled', 'tech_arrived'])('gate ON: a %s notice never reaches the recipient', async (kind) => {
    process.env[GATE] = 'true';
    await notice({ kind });
    expect(VisitRecipient.notifyVisitRecipients).not.toHaveBeenCalled();
  });

  test('gate ON: no visit, a callback-number hold, no account contact, or a lost claim sends nothing', async () => {
    process.env[GATE] = 'true';
    await notice({ scheduledServiceId: null });
    require('../services/disclaimed-number-holds').disclaimedNumberHeldForVisit.mockResolvedValueOnce(true);
    await notice();
    getAppointmentContacts.mockReturnValueOnce([]);
    await notice();
    await notice({ stillOwnsClaim: async () => false });
    expect(VisitRecipient.notifyVisitRecipients).not.toHaveBeenCalled();
  });

  test('gate ON: the holder result is the holder only, whatever the recipient sender does', async () => {
    process.env[GATE] = 'true';
    await expect(notice({ smsAttempt: jest.fn(async () => true) })).resolves.toBe(true);
    await expect(notice({ smsAttempt: jest.fn(async () => false), channel: 'sms' })).resolves.toBe(false);
    VisitRecipient.notifyVisitRecipients.mockRejectedValueOnce(new Error('boom'));
    await expect(notice({ smsAttempt: jest.fn(async () => true) })).resolves.toBe(true);
  });

  test('gate ON: the default-channel booking confirmation (the call pipeline\'s path, which skips deliverAppointmentNotice) also dispatches, once, after the holder\'s send', async () => {
    process.env[GATE] = 'true';
    const smsAttempt = jest.fn(async () => true);
    await expect(deliverConfirmationByChannel({ customerId: 'cust-1', scheduledServiceId: 'ss-1', serviceLabel: 'Pest Control', smsAttempt })).resolves.toBe(true);
    expect(smsAttempt).toHaveBeenCalledTimes(1);
    expect(VisitRecipient.notifyVisitRecipients).toHaveBeenCalledTimes(1);
    expect(VisitRecipient.notifyVisitRecipients.mock.calls[0][0]).toMatchObject({ scheduledServiceId: 'ss-1', kind: 'confirmation', dayOnly: false });
    // Gate off: nothing.
    delete process.env[GATE];
    VisitRecipient.notifyVisitRecipients.mockClear();
    await deliverConfirmationByChannel({ customerId: 'cust-1', scheduledServiceId: 'ss-1', serviceLabel: 'Pest Control', smsAttempt });
    expect(VisitRecipient.notifyVisitRecipients).not.toHaveBeenCalled();
  });
});

// A held 72 h reminder to an account contact is QUEUED for the replay, so that contact is served: the visit-only leg must not
// text the same number a second time the next morning.
describe('safeSendAppointment reports who it really served', () => {
  const HELD = { sent: false, blocked: true, code: 'QUIET_HOURS_HOLD', retryable: true, deferred: true, nextAllowedAt: '2026-12-02T13:00:00.000Z' };
  const send = (messageType, purpose, sendOutcome) => AppointmentReminders.safeSendAppointment(
    CUSTOMER, {}, async () => 'Hi', messageType, purpose, { scheduled_service_id: 'ss-1' }, { sendOutcome },
  );

  test('an accepted contact and a queued held contact are both served; a failed one is not; a held 24 h reminder is dropped, not served', async () => {
    getAppointmentContacts.mockReturnValue([PRIMARY, { phone: BOB, role: 'service_contact', name: 'Bob Roe' }]);
    sendCustomerMessage.mockResolvedValueOnce({ sent: true }).mockResolvedValueOnce(HELD);
    const queuedOutcome = {};
    await send('reminder_72h', 'appointment_reminder_72h', queuedOutcome);
    expect(queuedOutcome.servedPhones).toEqual([HOLDER, BOB]);
    sendCustomerMessage.mockResolvedValueOnce({ sent: true }).mockResolvedValueOnce({ sent: false, blocked: true, code: 'SUPPRESSED' });
    const failedOutcome = {};
    await send('reminder_72h', 'appointment_reminder_72h', failedOutcome);
    expect(failedOutcome.servedPhones).toEqual([HOLDER]);
    sendCustomerMessage.mockResolvedValueOnce({ sent: true }).mockResolvedValueOnce(HELD);
    const dayBeforeOutcome = {};
    await send('appointment_reminder', 'appointment_reminder_24h', dayBeforeOutcome);
    expect(dayBeforeOutcome.servedPhones).toEqual([HOLDER]);
  });
});

// --- sendTechEnRoute --------------------------------------------------------------------------------------

describe('sendTechEnRoute hands the en-route text to the visit-only recipients', () => {
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
    await enRoute();
    expect(VisitRecipient.notifyVisitRecipients).not.toHaveBeenCalled();
    expect(sentTo()).toEqual([HOLDER]);
  });

  test('gate ON: the recipient sender gets the visit, the technician, the ETA and a builder for the recipient\'s OWN tracker link; the holder results are untouched', async () => {
    process.env[GATE] = 'true';
    const result = await enRoute();
    expect(VisitRecipient.notifyVisitRecipients).toHaveBeenCalledWith({
      scheduledServiceId: 'ss-1', kind: 'en_route', excludePhones: [HOLDER],
      context: { techName: expect.any(String), etaMinutes: 15, trackUrlFor: expect.any(Function) },
    });
    expect(sentTo()).toEqual([HOLDER]);
    expect(result.results).toHaveLength(1);
  });

  test('gate ON: the recipient\'s link is built from the recipient token alone; the holder\'s tracker token never reaches the recipient sender', async () => {
    process.env[GATE] = 'true';
    await enRoute();
    const [{ context }] = VisitRecipient.notifyVisitRecipients.mock.calls[0];
    // No trackUrl of any kind in the context: only a builder that takes the recipient's token.
    expect(Object.keys(context).sort()).toEqual(['etaMinutes', 'techName', 'trackUrlFor']);
    const { shortenOrPassthrough } = require('../services/short-url');
    const url = await context.trackUrlFor('r'.repeat(64));
    // The short code carries no customer: the timeline counts a click on a customer's code as that customer's own.
    const opts = shortenOrPassthrough.mock.calls.at(-1)[1];
    expect(opts).toMatchObject({ kind: 'tracking', entityType: 'visit_text_recipients' });
    expect(opts.customerId).toBeUndefined();
    expect(opts.entityId).toBeUndefined();
    expect(url).toMatch(/^https:\/\/\S+\/track\/r{64}$/);
    expect(url).not.toContain('tok-1');
    expect(JSON.stringify(VisitRecipient.notifyVisitRecipients.mock.calls)).not.toContain('tok-1');
  });

  test('gate ON: the holder result is the same when the holder send is blocked', async () => {
    process.env[GATE] = 'true';
    sendCustomerMessage.mockResolvedValueOnce({ sent: false, blocked: true });
    const held = await enRoute();
    expect(held.success).toBe(false);
  });

  test('gate ON: a call without a visit id (legacy caller) reaches no recipient', async () => {
    process.env[GATE] = 'true';
    await TwilioService.sendTechEnRoute('cust-1', 'Pat', 15, 'tok-1', {});
    expect(VisitRecipient.notifyVisitRecipients).not.toHaveBeenCalled();
  });

  test('gate ON: a notice with no account contact at all reaches no recipient', async () => {
    process.env[GATE] = 'true';
    getAppointmentContacts.mockReturnValue([]);
    await enRoute();
    expect(VisitRecipient.notifyVisitRecipients).not.toHaveBeenCalled();
  });
});

// --- scope: what the permission can never reach -----------------------------------------------------------

describe('the permission stays on the visit row', () => {
  const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const code = (file) => read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  test('the recipient module writes only its own table and the replay row; it never writes consent, slots, opt-in rows, login, review asks or email', () => {
    const source = code('services/call-visit-recipient.js');
    for (const forbidden of [
      'service_contacts_consent', 'service_contact_phone', 'service_contact2', 'service_contact3', 'service_preferences',
      'contact_login', 'review', 'appointment-email', 'sendAppointmentConfirmationEmail', 'notification_prefs',
      'customer_accounts', 'persistCallSecondaryContact', 'buildAppointmentLink', 'reschedule_token', 'reschedule_line', 'reschedule-link', 'track_view_token', '/track/',
    ]) {
      expect(source).not.toContain(forbidden);
    }
    // Reads only, on every table but its own and the scheduled-text queue.
    expect([...new Set([...source.matchAll(/conn\('([a-z_]+)(?: as [a-z])?'\)/g)].map((m) => m[1]))].sort())
      .toEqual(['customers', 'messaging_suppression', 'recipient_optin', 'scheduled_services', 'sms_log']);
    expect(source).toContain("const TABLE = 'visit_text_recipients';");
    expect(source).not.toMatch(/conn\('(customers|messaging_suppression|recipient_optin|scheduled_services)(?: as [a-z])?'\)[^;]*\.(insert|update|del|delete)\(/);
    expect(source).toMatch(/conn\('sms_log'\)\.insert\(row\)/);
  });

  test('the visit-only send never claims the customer-initiated exemption and never asks for push routing', () => {
    const source = code('services/call-visit-recipient.js');
    expect(source).not.toContain('customerInitiated');
    expect(source).not.toContain('useCustomerChannel');
  });

  test('the senders ask one helper, and the gate stays off by default (read at call time)', () => {
    expect(code('services/appointment-reminders.js')).toContain('notifyVisitRecipients');
    expect(code('services/appointment-reminders.js')).toContain("audit.metadata?.appointment_contact_role === require('./call-visit-recipient').ROLE");
    expect(code('services/twilio.js')).toContain('notifyVisitRecipients');
    const gatesSource = read('config/feature-gates.js');
    expect(gatesSource).toContain("return process.env.GATE_CALL_GIVEN_VISIT_TEXTS === 'true';");
    expect(gatesSource).toContain('module.exports.callGivenVisitTextsLive = callGivenVisitTextsLive;');
  });

  test('the replay entry rechecks with the module, holds an unreadable answer, and gives the claim back when it ends unsent', () => {
    const registry = read('services/messaging/deferred-replay-registry.js');
    const at = registry.indexOf('  visit_text_recipient_deferred: {');
    expect(at).toBeGreaterThan(0);
    const entry = registry.slice(at, registry.indexOf('  // The report text to an on-location contact', at));
    expect(entry).toContain('recipientStillOwedDeferred(meta)');
    expect(entry).toContain("failClosed('visit-recipient'");
    expect(entry).toContain('releaseDeferredClaim(meta)');
    expect(VisitRecipient.DEFERRED_ENTRY_POINT).toBe('visit_text_recipient_deferred');
  });

  test('the migration keys the permission to the visit row, with a cascade and a unique visit + number key', () => {
    const migration = read('models/migrations/20261124170000_visit_text_recipients.js');
    expect(migration).toMatch(/references\('id'\)\.inTable\('scheduled_services'\)\.onDelete\('CASCADE'\)/);
    expect(migration).toContain("t.unique(['scheduled_service_id', 'phone_key']");
    expect(migration).not.toMatch(/inTable\('customers'\)/);
  });
});
