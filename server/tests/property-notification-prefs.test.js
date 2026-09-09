/**
 * Appointment texts per SAVED PROPERTY (app property scope, PR 3): the
 * resolver every sender seam calls. Pins ruling R1 (defaults by relationship),
 * the primary/unstamped "customer row byte-for-byte" rule, the two gates
 * (scope off = never reads the table; texts off = shadow log only) and the
 * failure posture (lookup failure = customer row in shadow, throw enforced).
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const Prefs = require('../services/property-notification-prefs');

const CUSTOMER = { customer_id: 'c1', appointment_confirmation: true, service_reminder_72h: false, service_reminder_24h: true, tech_en_route: true, tech_arrived: true, appointment_notify_primary: true, sms_enabled: true };
const SECONDARY = { id: 'pb', customer_id: 'c1', is_primary: false, active: true, relationship: 'family_home' };
const RENTAL = { ...SECONDARY, id: 'pr', relationship: 'rental_owned' };
const PRIMARY = { ...SECONDARY, id: 'pa', is_primary: true };

function chain(rows) {
  const c = {};
  for (const m of ['where', 'whereIn', 'select', 'orderBy', 'limit', 'onConflict']) c[m] = jest.fn(() => c);
  c.first = jest.fn(async () => rows[0]);
  c.insert = jest.fn(() => c);
  c.ignore = jest.fn(async () => [1]);
  c.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
  return c;
}
let inserts;
function setDb({ visit, property, row, failOn = null }) {
  inserts = [];
  db.mockImplementation((table) => {
    if (failOn === table) { const c = chain([]); c.first = jest.fn(async () => { throw new Error(`${table} down`); }); return c; }
    if (table === 'scheduled_services') return chain(visit ? [visit] : []);
    if (table === 'customer_properties') return chain(property ? [property] : []);
    if (table === 'property_notification_prefs') return chain(row ? [row] : []);
    if (table === 'property_text_decisions') { const c = chain([]); c.insert = jest.fn((r) => { inserts.push(r); return c; }); return c; }
    throw new Error(`unexpected table ${table}`);
  });
}

beforeEach(() => { jest.clearAllMocks(); delete process.env.GATE_APP_PROPERTY_SCOPE; delete process.env.GATE_APP_PROPERTY_TEXTS; });

describe('defaults (ruling R1)', () => {
  test('own_home / family_home / unrecorded inherit the customer row; rental_owned / managed_for_client start OFF', () => {
    expect(Prefs.defaultPropertyToggles(SECONDARY, CUSTOMER)).toEqual({ appointment_confirmation: true, service_reminder_72h: false, service_reminder_24h: true, tech_en_route: true, tech_arrived: true, appointment_notify_primary: true });
    expect(Prefs.defaultPropertyToggles({ relationship: null }, CUSTOMER).tech_en_route).toBe(true);
    for (const rel of ['rental_owned', 'managed_for_client']) {
      const d = Prefs.defaultPropertyToggles({ relationship: rel }, CUSTOMER);
      expect(Prefs.APPOINTMENT_TOGGLES.every((c) => d[c] === false)).toBe(true);
      expect(d.appointment_notify_primary).toBe(true); // "send to me too" inherits
    }
    // No customer row at all = the table defaults (everything on).
    expect(Prefs.defaultPropertyToggles(SECONDARY, null).service_reminder_72h).toBe(true);
  });
  test('a CHOSEN toggle (non-null) wins over the default; NULL keeps the default', () => {
    const eff = Prefs.effectivePropertyToggles(RENTAL, { tech_en_route: true, service_reminder_72h: null }, CUSTOMER);
    expect(eff.tech_en_route).toBe(true);
    expect(eff.service_reminder_72h).toBe(false);
    expect(eff.appointment_confirmation).toBe(false);
  });
});

describe('resolveAppointmentPrefs', () => {
  test('scope gate OFF: never touches the database, answers the customer row', async () => {
    setDb({ visit: { property_id: 'pb' }, property: SECONDARY });
    const out = await Prefs.resolveAppointmentPrefs({ customerId: 'c1', scheduledServiceId: 'v1', prefs: CUSTOMER, source: 't' });
    expect(out.prefs).toBe(CUSTOMER);
    expect(out.propertyDecided).toBe(false);
    expect(db).not.toHaveBeenCalled();
  });
  test('scope ON, texts OFF (shadow): customer row answers, the decision is logged with agreed=false when they differ', async () => {
    process.env.GATE_APP_PROPERTY_SCOPE = 'true';
    setDb({ visit: { property_id: 'pr' }, property: RENTAL, row: null });
    const out = await Prefs.resolveAppointmentPrefs({ customerId: 'c1', scheduledServiceId: 'v1', prefs: CUSTOMER, source: 'en_route' });
    expect(out.prefs).toBe(CUSTOMER);
    expect(out.propertyDecided).toBe(false);
    expect(out.propertyToggles.tech_en_route).toBe(false);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({ customer_id: 'c1', property_id: 'pr', scheduled_service_id: 'v1', source: 'en_route', relationship: 'rental_owned', agreed: false, enforced: false });
    expect(JSON.parse(inserts[0].property_decisions).tech_en_route).toBe(false);
    expect(JSON.parse(inserts[0].customer_decisions).tech_en_route).toBe(true);
  });
  test('shadow: an inheriting family home with NO chosen toggle agrees by construction — not logged; with a chosen toggle it is', async () => {
    process.env.GATE_APP_PROPERTY_SCOPE = 'true';
    setDb({ visit: { property_id: 'pb' }, property: SECONDARY, row: null });
    await Prefs.resolveAppointmentPrefs({ customerId: 'c1', scheduledServiceId: 'v1', prefs: CUSTOMER, source: 'reminders' });
    expect(inserts).toHaveLength(0);
    setDb({ visit: { property_id: 'pb' }, property: SECONDARY, row: { tech_en_route: false } });
    await Prefs.resolveAppointmentPrefs({ customerId: 'c1', scheduledServiceId: 'v1', prefs: CUSTOMER, source: 'reminders' });
    expect(inserts).toHaveLength(1);
    expect(inserts[0].agreed).toBe(false);
  });
  test('the shadow row is written on the ROOT handle with a dedupe key, never on a caller transaction; a trx read failure rethrows', async () => {
    process.env.GATE_APP_PROPERTY_SCOPE = 'true';
    setDb({ visit: { property_id: 'pr' }, property: RENTAL, row: null });
    const trxCalls = [];
    const trx = Object.assign((table) => { trxCalls.push(table); return db(table); }, { isTransaction: true });
    await Prefs.resolveAppointmentPrefs({ customerId: 'c1', scheduledServiceId: 'v1', prefs: CUSTOMER, source: 'consent' }, trx);
    expect(inserts).toHaveLength(1);
    expect(trxCalls).not.toContain('property_text_decisions');
    setDb({ visit: { property_id: 'pb' }, property: SECONDARY, failOn: 'customer_properties' });
    await expect(Prefs.resolveAppointmentPrefs({ customerId: 'c1', scheduledServiceId: 'v1', prefs: CUSTOMER, source: 'consent' }, trx)).rejects.toThrow('down');
  });
  test('texts ON (enforced): the six columns are overlaid, everything else on the row stays', async () => {
    process.env.GATE_APP_PROPERTY_SCOPE = 'true'; process.env.GATE_APP_PROPERTY_TEXTS = 'true';
    setDb({ visit: { property_id: 'pr' }, property: RENTAL, row: { tech_arrived: true } });
    const out = await Prefs.resolveAppointmentPrefs({ customerId: 'c1', scheduledServiceId: 'v1', prefs: CUSTOMER, source: 'arrived' });
    expect(out.propertyDecided).toBe(true);
    expect(out.prefs).not.toBe(CUSTOMER);
    expect(out.prefs).toMatchObject({ tech_en_route: false, tech_arrived: true, appointment_confirmation: false, appointment_notify_primary: true, sms_enabled: true, customer_id: 'c1' });
    // Enforced: the comparison has no reader — nothing logged.
    expect(inserts).toHaveLength(0);
  });
  test('unstamped visit, a PRIMARY property, a retired one, or a foreign one: customer row, nothing logged', async () => {
    process.env.GATE_APP_PROPERTY_SCOPE = 'true'; process.env.GATE_APP_PROPERTY_TEXTS = 'true';
    for (const args of [
      { visit: { property_id: null } },
      { visit: { property_id: 'pa' }, property: PRIMARY },
      { visit: { property_id: 'pb' }, property: { ...SECONDARY, active: false } },
      { visit: { property_id: 'px' }, property: null },
      { visit: null },
    ]) {
      setDb(args);
      const out = await Prefs.resolveAppointmentPrefs({ customerId: 'c1', scheduledServiceId: 'v1', prefs: CUSTOMER, source: 't' });
      expect(out.prefs).toBe(CUSTOMER);
      expect(inserts).toHaveLength(0);
    }
  });
  test('no visit id = customer row without a read', async () => {
    process.env.GATE_APP_PROPERTY_SCOPE = 'true';
    setDb({});
    const out = await Prefs.resolveAppointmentPrefs({ customerId: 'c1', scheduledServiceId: null, prefs: CUSTOMER, source: 't' });
    expect(out.prefs).toBe(CUSTOMER);
    expect(db).not.toHaveBeenCalled();
  });
  test('lookup FAILURE: customer row in shadow mode, THROWS under enforcement', async () => {
    process.env.GATE_APP_PROPERTY_SCOPE = 'true';
    setDb({ visit: { property_id: 'pb' }, property: SECONDARY, failOn: 'customer_properties' });
    const out = await Prefs.resolveAppointmentPrefs({ customerId: 'c1', scheduledServiceId: 'v1', prefs: CUSTOMER, source: 't' });
    expect(out.prefs).toBe(CUSTOMER);
    process.env.GATE_APP_PROPERTY_TEXTS = 'true';
    setDb({ visit: { property_id: 'pb' }, property: SECONDARY, failOn: 'customer_properties' });
    await expect(Prefs.resolveAppointmentPrefs({ customerId: 'c1', scheduledServiceId: 'v1', prefs: CUSTOMER, source: 't' })).rejects.toThrow('customer_properties down');
  });
  test('a failed shadow-log WRITE never decides a send', async () => {
    process.env.GATE_APP_PROPERTY_SCOPE = 'true'; process.env.GATE_APP_PROPERTY_TEXTS = 'true';
    setDb({ visit: { property_id: 'pr' }, property: RENTAL, row: null });
    delete process.env.GATE_APP_PROPERTY_TEXTS;
    db.mockImplementation((table) => {
      if (table === 'scheduled_services') return chain([{ property_id: 'pr' }]);
      if (table === 'customer_properties') return chain([RENTAL]);
      if (table === 'property_notification_prefs') return chain([]);
      const c = chain([]); c.ignore = jest.fn(async () => { throw new Error('log down'); }); return c;
    });
    const out = await Prefs.resolveAppointmentPrefs({ customerId: 'c1', scheduledServiceId: 'v1', prefs: CUSTOMER, source: 't' });
    expect(out.prefs).toBe(CUSTOMER);
    expect(out.propertyToggles.tech_en_route).toBe(false);
  });
  test('prefsForVisit returns the row to read from', async () => {
    process.env.GATE_APP_PROPERTY_SCOPE = 'true'; process.env.GATE_APP_PROPERTY_TEXTS = 'true';
    setDb({ visit: { property_id: 'pr' }, property: RENTAL, row: null });
    expect((await Prefs.prefsForVisit(CUSTOMER, 'c1', 'v1', 't')).service_reminder_24h).toBe(false);
    expect(await Prefs.prefsForVisit(null, 'c1', null, 't')).toBeNull();
  });
});
