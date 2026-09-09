/**
 * App property scope, PR 3 — every sender seam hands its visit to the
 * per-property resolver and honors what comes back: the reminder prefs
 * reader, the en-route / arrived composers, the bell preference check and
 * the consent validator. The resolver itself is unit-tested in
 * property-notification-prefs.test.js; here it is mocked.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/property-notification-prefs', () => ({
  prefsForVisit: jest.fn(async (prefs) => prefs),
  resolveAppointmentPrefs: jest.fn(async ({ prefs }) => ({ prefs, property: null, propertyDecided: false, propertyToggles: null })),
  APPOINTMENT_TOGGLES: ['appointment_confirmation', 'service_reminder_72h', 'service_reminder_24h', 'tech_en_route', 'tech_arrived'],
  PROPERTY_PREF_COLUMNS: ['appointment_confirmation', 'service_reminder_72h', 'service_reminder_24h', 'tech_en_route', 'tech_arrived', 'appointment_notify_primary'],
}));

const db = require('../models/db');
const Prefs = require('../services/property-notification-prefs');

function chain(rows) {
  const c = {};
  for (const m of ['where', 'whereIn', 'select', 'orderBy', 'limit', 'leftJoin']) c[m] = jest.fn(() => c);
  c.first = jest.fn(async () => rows[0]);
  c.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
  return c;
}
const PREFS = { customer_id: 'c1', sms_enabled: true, tech_en_route: true, tech_arrived: true, service_reminder_72h: true, service_reminder_24h: true, appointment_confirmation: true, appointment_notify_primary: true };

beforeEach(() => {
  jest.clearAllMocks();
  Prefs.prefsForVisit.mockReset();
  Prefs.prefsForVisit.mockImplementation(async (prefs) => prefs);
  Prefs.resolveAppointmentPrefs.mockReset();
  Prefs.resolveAppointmentPrefs.mockImplementation(async ({ prefs }) => ({ prefs, property: null, propertyDecided: false, propertyToggles: null }));
  db.mockImplementation((table) => {
    if (table === 'notification_prefs') return chain([PREFS]);
    if (table === 'customers') return chain([{ id: 'c1', first_name: 'Pat', last_name: 'Q', phone: '+19415550100', account_id: 'a1', is_primary_profile: true }]);
    return chain([]);
  });
});

describe('getReminderPrefs', () => {
  const { getReminderPrefs } = require('../services/appointment-reminders')._test;
  test('hands the visit to the resolver and reads the toggles from what it returns', async () => {
    Prefs.prefsForVisit.mockResolvedValueOnce({ ...PREFS, service_reminder_72h: false, tech_en_route: false });
    const out = await getReminderPrefs('c1', { scheduledServiceId: 'v1' });
    expect(Prefs.prefsForVisit).toHaveBeenCalledWith(PREFS, 'c1', 'v1', 'reminders');
    expect(out.serviceReminder72h).toBe(false);
    expect(out.raw.tech_en_route).toBe(false);
    expect(out.unavailable).toBe(false);
  });
  test('no visit: the resolver is not consulted (today\'s read)', async () => {
    await getReminderPrefs('c1');
    expect(Prefs.prefsForVisit).not.toHaveBeenCalled();
  });
  test('a resolver failure (enforced, property unreadable) reads as UNAVAILABLE — held, never the customer row', async () => {
    Prefs.prefsForVisit.mockRejectedValueOnce(new Error('customer_properties down'));
    const out = await getReminderPrefs('c1', { scheduledServiceId: 'v1' });
    expect(out.unavailable).toBe(true);
  });
});

describe('bell preference check', () => {
  const { customerPreferenceEnabled } = require('../services/notification-service')._private;
  test('passes the visit and honors the property toggle', async () => {
    Prefs.prefsForVisit.mockResolvedValueOnce({ tech_en_route: false });
    expect(await customerPreferenceEnabled('c1', 'tech_en_route', { scheduledServiceId: 'v1' })).toBe(false);
    expect(Prefs.prefsForVisit).toHaveBeenCalledWith(expect.anything(), 'c1', 'v1', 'bell');
    expect(await customerPreferenceEnabled('c1', 'tech_en_route')).toBe(true);
  });
  test('a resolver failure means NOT sent (preference uncertainty never becomes a push)', async () => {
    Prefs.prefsForVisit.mockRejectedValueOnce(new Error('down'));
    expect(await customerPreferenceEnabled('c1', 'tech_en_route', { scheduledServiceId: 'v1' })).toBe(false);
  });
  test('a key the property never owns (service_completed) skips the resolver even with a visit', async () => {
    expect(await customerPreferenceEnabled('c1', 'service_completed', { scheduledServiceId: 'v1' })).toBe(true);
    expect(Prefs.prefsForVisit).not.toHaveBeenCalled();
  });
});

describe('consent validator', () => {
  const { loadContactState, checkConsentForPurpose } = require('../services/messaging/validators/consent');
  test('an appointment send names its visit: the property decision lands in propertyToggles, the prefs row is untouched', async () => {
    Prefs.resolveAppointmentPrefs.mockResolvedValueOnce({ prefs: { ...PREFS, tech_arrived: false }, property: { id: 'pb' }, propertyDecided: true });
    const state = await loadContactState({ customerId: 'c1', appointmentId: 'v1', purpose: 'tech_arrived' });
    expect(Prefs.resolveAppointmentPrefs).toHaveBeenCalledWith(expect.objectContaining({ customerId: 'c1', scheduledServiceId: 'v1', prefs: PREFS, source: 'consent' }), expect.anything());
    expect(state.prefs).toEqual(PREFS);
    expect(state.propertyToggles.tech_arrived).toBe(false);
    expect(state.lookupFailed).toBe(false);
    const verdict = await checkConsentForPurpose({ customerId: 'c1', purpose: 'tech_arrived', channel: 'sms', audience: 'customer' },
      { requireConsent: 'transactional', prefsColumn: 'tech_arrived' }, { ...state, suppressionLoaded: true });
    expect(verdict.ok).toBe(false);
  });
  test('a customer with NO prefs row still gets the ruling-R1 decision without minting a row', async () => {
    db.mockImplementation((table) => {
      if (table === 'notification_prefs') return chain([]);
      if (table === 'customers') return chain([{ id: 'c1', first_name: 'Pat', last_name: 'Q', phone: '+19415550100' }]);
      return chain([]);
    });
    Prefs.resolveAppointmentPrefs.mockResolvedValueOnce({ prefs: { tech_en_route: false }, property: { id: 'pr' }, propertyDecided: true });
    const state = await loadContactState({ customerId: 'c1', appointmentId: 'v1', purpose: 'tech_en_route' });
    expect(Prefs.resolveAppointmentPrefs).toHaveBeenCalledWith(expect.objectContaining({ prefs: {} }), expect.anything());
    expect(state.prefs).toBeUndefined();
    expect(state.propertyToggles.tech_en_route).toBe(false);
  });
  test('no appointmentId: untouched', async () => {
    const state = await loadContactState({ customerId: 'c1', purpose: 'tech_arrived' });
    expect(Prefs.resolveAppointmentPrefs).not.toHaveBeenCalled();
    expect(state.prefs).toEqual(PREFS);
  });
  test('a resolver failure is a lookup failure (CONSENT_LOOKUP_FAILED → retry), not the customer row', async () => {
    Prefs.resolveAppointmentPrefs.mockRejectedValueOnce(new Error('down'));
    const state = await loadContactState({ customerId: 'c1', appointmentId: 'v1', purpose: 'tech_arrived' });
    expect(state.lookupFailed).toBe(true);
  });
});

describe('appointment email recipients', () => {
  const { resolveRecipients, sendTemplate } = require('../services/appointment-email')._private;
  const customer = { id: 'c1', first_name: 'Pat', last_name: 'Q', email: 'pat@example.com', phone: '+19415550100' };
  test('the visit reaches the resolver and notify-primary follows what it returns', async () => {
    Prefs.prefsForVisit.mockResolvedValueOnce({ ...PREFS, appointment_notify_primary: false });
    await resolveRecipients(customer, { scheduledServiceId: 'v1' });
    expect(Prefs.prefsForVisit).toHaveBeenCalledWith(PREFS, 'c1', 'v1', 'email_recipients');
  });
  test('a resolver failure HOLDS the email (never the fan-out on unknown settings)', async () => {
    Prefs.prefsForVisit.mockRejectedValueOnce(new Error('down'));
    await expect(resolveRecipients(customer, { scheduledServiceId: 'v1' })).rejects.toMatchObject({ code: 'PROPERTY_PREFS_UNAVAILABLE' });
    db.mockImplementation((table) => {
      if (table === 'customers') return chain([customer]);
      if (table === 'notification_prefs') return chain([PREFS]);
      const c = chain([]); c.insert = jest.fn(async () => [1]); return c;
    });
    Prefs.prefsForVisit.mockRejectedValueOnce(new Error('down'));
    const out = await sendTemplate({ customerId: 'c1', templateKey: 'appointment.en_route', eventType: 'appointment.en_route', scheduledServiceId: 'v1' });
    expect(out).toMatchObject({ ok: false, held: true, reason: 'preferences_unavailable' });
  });
  test('an unreadable CUSTOMER row holds the email too — one posture, no fallback to the primary on unknown settings', async () => {
    db.mockImplementation((table) => {
      if (table === 'customers') return chain([customer]);
      if (table === 'notification_prefs') { const c = chain([]); c.first = jest.fn(async () => { throw new Error('prefs down'); }); return c; }
      const c = chain([]); c.insert = jest.fn(async () => [1]); return c;
    });
    const out = await sendTemplate({ customerId: 'c1', templateKey: 'appointment.no_show', eventType: 'appointment.no_show', scheduledServiceId: 'v1' });
    expect(out).toMatchObject({ ok: false, held: true, reason: 'preferences_unavailable' });
    expect(Prefs.prefsForVisit).not.toHaveBeenCalled();
  });
});

describe('direct appointment notices (visitPrefsRow)', () => {
  const { visitPrefsRow } = require('../services/appointment-reminders')._test;
  test('resolves the row through the property for the visit; a failure is the unavailable sentinel', async () => {
    Prefs.prefsForVisit.mockResolvedValueOnce({ ...PREFS, appointment_notify_primary: false });
    expect((await visitPrefsRow('c1', 'v1')).appointment_notify_primary).toBe(false);
    expect(Prefs.prefsForVisit).toHaveBeenCalledWith(PREFS, 'c1', 'v1', 'reminders');
    Prefs.prefsForVisit.mockRejectedValueOnce(new Error('down'));
    expect((await visitPrefsRow('c1', 'v1')).__prefsUnavailable).toBe(true);
    Prefs.prefsForVisit.mockClear();
    expect(await visitPrefsRow('c1', null)).toEqual(PREFS);
    expect(Prefs.prefsForVisit).not.toHaveBeenCalled();
  });
});

describe('safeSendAppointment on an unreadable preferences row', () => {
  const { safeSendAppointment } = require('../services/appointment-reminders');
  const { PREFS_UNAVAILABLE } = require('../services/customer-contact');
  test('is a RETRYABLE non-send: nothing rendered, sendOutcome.retryable set', async () => {
    const renderBody = jest.fn();
    const sendOutcome = {};
    const sent = await safeSendAppointment({ id: 'c1', phone: '+19415550100', first_name: 'Pat' }, PREFS_UNAVAILABLE, renderBody, 'appointment_cancelled', 'appointment_cancelled', {}, { sendOutcome });
    expect(sent).toBe(false);
    expect(renderBody).not.toHaveBeenCalled();
    expect(sendOutcome).toMatchObject({ retryable: true, lastCode: 'PREFERENCES_UNAVAILABLE' });
  });
});

describe('primary-flip and merge hygiene', () => {
  const real = jest.requireActual('../services/property-notification-prefs');
  test('a promoted house drops its row; a moved row follows its new customer', async () => {
    const calls = [];
    const knex = Object.assign((table) => {
      const c = { where: jest.fn((w) => { calls.push([table, 'where', w]); return c; }), del: jest.fn(async () => { calls.push([table, 'del']); return 1; }), update: jest.fn(async (u) => { calls.push([table, 'update', u]); return 1; }) };
      return c;
    }, { fn: { now: () => 'now()' } });
    expect(await real.clearPrimaryPropertyPrefs('pa', knex)).toBe(1);
    expect(calls).toEqual(expect.arrayContaining([['property_notification_prefs', 'where', { property_id: 'pa' }], ['property_notification_prefs', 'del']]));
    expect(await real.repointPropertyPrefs('pb', 'winner', knex)).toBe(1);
    expect(calls[calls.length - 1]).toEqual(['property_notification_prefs', 'update', { customer_id: 'winner', updated_at: 'now()' }]);
    expect(await real.clearPrimaryPropertyPrefs(null, knex)).toBe(0);
  });
});

