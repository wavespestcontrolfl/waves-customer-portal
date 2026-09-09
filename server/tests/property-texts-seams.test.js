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
  APPOINTMENT_TOGGLES: ['appointment_confirmation', 'service_reminder_72h', 'service_reminder_24h', 'tech_en_route', 'tech_arrived'],
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
});

describe('consent validator', () => {
  const { loadContactState } = require('../services/messaging/validators/consent');
  test('an appointment send names its visit: the per-purpose toggles come from the property', async () => {
    Prefs.prefsForVisit.mockResolvedValueOnce({ ...PREFS, tech_arrived: false });
    const state = await loadContactState({ customerId: 'c1', appointmentId: 'v1', purpose: 'tech_arrived' });
    expect(Prefs.prefsForVisit).toHaveBeenCalledWith(PREFS, 'c1', 'v1', 'consent', expect.anything());
    expect(state.prefs.tech_arrived).toBe(false);
    expect(state.lookupFailed).toBe(false);
  });
  test('no appointmentId: untouched', async () => {
    const state = await loadContactState({ customerId: 'c1', purpose: 'tech_arrived' });
    expect(Prefs.prefsForVisit).not.toHaveBeenCalled();
    expect(state.prefs).toEqual(PREFS);
  });
  test('a resolver failure is a lookup failure (CONSENT_LOOKUP_FAILED → retry), not the customer row', async () => {
    Prefs.prefsForVisit.mockRejectedValueOnce(new Error('down'));
    const state = await loadContactState({ customerId: 'c1', appointmentId: 'v1', purpose: 'tech_arrived' });
    expect(state.lookupFailed).toBe(true);
  });
});
