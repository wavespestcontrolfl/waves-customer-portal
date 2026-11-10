/**
 * GATE_DAY_ONLY_PROMISE part E, second round: (1) the office fields reach every editor entry point: the list feed and the
 * visit-summary read (the fallback for a row from any other feed) carry customerAskedTime / told / reminder24hOn, gate on only;
 * (2) `reminder24hOn` follows the senders' own rule (appointment-reminders.loadReminder24hAnswers over reminder24hWillSend),
 * from bulk reads; (3) the client's 24.25-hour cutoff equals the server's DAY_PROMISE_CUTOFF_HOURS. Synthetic ids only.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.setTimeout(30000);

const fs = require('fs');
const path = require('path');

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/auto-dispatch/told-visits', () => ({
  loadPromiseLevels: jest.fn(),
  resolvePromises: jest.fn(),
  loadToldVisitIds: jest.fn(),
  promiseLevelOf: jest.requireActual('../services/auto-dispatch/told-visits').promiseLevelOf,
}));
jest.mock('../services/visit-groups', () => ({ visitSummaryForService: jest.fn(async () => null) }));
const mockEnforced = { on: false };
jest.mock('../services/property-notification-prefs', () => ({
  ...jest.requireActual('../services/property-notification-prefs'),
  propertyTextsEnforced: () => mockEnforced.on,
}));
const propertyPrefs = require('../services/property-notification-prefs');

const db = require('../models/db');
const { resolvePromises } = require('../services/auto-dispatch/told-visits');
const { DAY_PROMISE_CUTOFF_HOURS } = require('../services/time-promise');
const reminders = require('../services/appointment-reminders');
const adminSchedule = require('../routes/admin-schedule');
const adminCustomers = require('../routes/admin-customers');

const withGate = (value, fn) => async () => {
  const prior = process.env.GATE_DAY_ONLY_PROMISE;
  if (value === undefined) delete process.env.GATE_DAY_ONLY_PROMISE; else process.env.GATE_DAY_ONLY_PROMISE = value;
  try { await fn(); } finally {
    if (prior === undefined) delete process.env.GATE_DAY_ONLY_PROMISE; else process.env.GATE_DAY_ONLY_PROMISE = prior;
  }
};

/** A knex-shaped fake over in-memory tables: whereIn / where({}) / select, with a call log per table. */
function fakeTables(tables, { fail = false } = {}) {
  const calls = [];
  const conn = jest.fn((table) => {
    calls.push(table);
    let rows = tables[table] || [];
    const chain = {
      whereIn: (col, vals) => { const set = vals.map(String); rows = rows.filter((r) => set.includes(String(r[col]))); return chain; },
      where: (cond) => { rows = rows.filter((r) => Object.entries(cond).every(([k, v]) => r[k] === v)); return chain; },
      first: async () => rows[0],
      select: async () => { if (fail) throw new Error('read failed'); return rows; },
    };
    return chain;
  });
  conn.raw = (sql) => ({ raw: sql });
  conn.calls = calls;
  return conn;
}

describe('loadReminder24hAnswers / loadVisitReminder24hAnswers (the senders\' rule, in bulk, read-only)', () => {
  beforeEach(() => { mockEnforced.on = false; });

  const tables = () => ({
    customers: [
      { id: 'c-default', account_id: 'a1', is_primary_profile: true },
      { id: 'c-off', account_id: 'a2', is_primary_profile: true },
      { id: 'c-sms-only', account_id: 'a3', is_primary_profile: true },
      { id: 'c-child', account_id: 'a4', is_primary_profile: false },
      { id: 'c-owner', account_id: 'a4', is_primary_profile: true },
    ],
    notification_prefs: [
      { customer_id: 'c-off', service_reminder_24h: false },
      { customer_id: 'c-sms-only', service_reminder_24h: true, service_reminder_24h_channel: 'sms', sms_enabled: false },
      { customer_id: 'c-child', service_reminder_24h: true, service_reminder_24h_channel: 'both', sms_enabled: true },
      { customer_id: 'c-owner', service_reminder_24h: true, service_reminder_24h_channel: 'sms', sms_enabled: false },
    ],
    customer_properties: [
      { id: 'p-primary', customer_id: 'c-default', is_primary: true, active: true, relationship: 'own_home' },
      { id: 'p-off', customer_id: 'c-default', is_primary: false, active: true, relationship: 'own_home' },
      { id: 'p-rental', customer_id: 'c-default', is_primary: false, active: true, relationship: 'rental_owned' },
      { id: 'p-family', customer_id: 'c-default', is_primary: false, active: true, relationship: 'family_home' },
      { id: 'p-retired', customer_id: 'c-default', is_primary: false, active: false, relationship: 'rental_owned' },
      { id: 'p-foreign', customer_id: 'c-off', is_primary: false, active: true, relationship: 'rental_owned' },
    ],
    property_notification_prefs: [
      { property_id: 'p-off', service_reminder_24h: false },
      { property_id: 'p-rental', service_reminder_24h: true },
    ],
    property_text_decisions: [],
  });

  test('no prefs row = reminder on; reminder off = off; a text-only choice with texts off = off', async () => {
    const out = await reminders.loadReminder24hAnswers(fakeTables(tables()), ['c-default', 'c-off', 'c-sms-only']);
    expect(out.get('c-default')).toBe(true);
    expect(out.get('c-off')).toBe(false);
    expect(out.get('c-sms-only')).toBe(false);
  });

  test('a secondary profile takes its channel from the account owner\'s row, as resolveChannelPrefsRow does', async () => {
    const out = await reminders.loadReminder24hAnswers(fakeTables(tables()), ['c-child']);
    expect(out.get('c-child')).toBe(reminders.reminder24hWillSend({ serviceReminder24h: true, reminder24hChannel: 'sms', smsEnabled: true }));
  });

  test('three bulk reads however many customers; none for no customers', async () => {
    const conn = fakeTables(tables());
    await reminders.loadReminder24hAnswers(conn, ['c-default', 'c-off', 'c-sms-only', 'c-child', 'c-default']);
    expect(conn.calls).toEqual(['customers', 'customers', 'notification_prefs']);
    const none = fakeTables(tables());
    expect((await reminders.loadReminder24hAnswers(none, [])).size).toBe(0);
    expect(none).not.toHaveBeenCalled();
  });

  test('a failed read throws (the callers leave the field out)', async () => {
    await expect(reminders.loadReminder24hAnswers(fakeTables(tables(), { fail: true }), ['c-off'])).rejects.toThrow('read failed');
  });

  const visit = (id, property_id, customer_id = 'c-default') => ({ id, customer_id, property_id });
  const run = async (visits, { enforced }) => {
    mockEnforced.on = enforced;
    const conn = fakeTables(tables());
    const out = await reminders.loadVisitReminder24hAnswers(conn, visits);
    return { out, conn };
  };

  test('enforced: a non-primary property\'s own toggle wins over the customer row (service_reminder_24h false = off)', async () => {
    const { out } = await run([visit('v-off', 'p-off')], { enforced: true });
    expect(out.get('v-off')).toBe(false);
  });

  test('enforced: a quiet relationship (rental_owned) with no property row = off; a chosen toggle wins; an inheriting relationship = the customer row', async () => {
    const { out } = await run([visit('v-rental', 'p-rental'), visit('v-family', 'p-family')], { enforced: true });
    expect(out.get('v-rental')).toBe(true); // p-rental has a row with service_reminder_24h true
    expect(out.get('v-family')).toBe(true);
    const quiet = tables();
    quiet.property_notification_prefs = [];
    mockEnforced.on = true;
    const again = await reminders.loadVisitReminder24hAnswers(fakeTables(quiet), [visit('v-rental', 'p-rental'), visit('v-family', 'p-family')]);
    expect(again.get('v-rental')).toBe(false);
    expect(again.get('v-family')).toBe(true);
  });

  test('enforced: a primary, unstamped, retired or foreign property keeps the customer row', async () => {
    const { out } = await run([
      visit('v-primary', 'p-primary'), visit('v-unstamped', null), visit('v-retired', 'p-retired'), visit('v-foreign', 'p-foreign', 'c-default'),
    ], { enforced: true });
    expect(out.get('v-primary')).toBe(true);
    expect(out.get('v-unstamped')).toBe(true);
    expect(out.get('v-retired')).toBe(true);
    expect(out.get('v-foreign')).toBe(true); // the property belongs to another customer
  });

  test('shadow mode (not enforced): the customer row, NO property reads and NO writes', async () => {
    const { out, conn } = await run([visit('v-off', 'p-off'), visit('v-rental', 'p-rental')], { enforced: false });
    expect(out.get('v-off')).toBe(true);
    expect(out.get('v-rental')).toBe(true);
    expect(conn.calls).toEqual(['customers', 'notification_prefs']);
    expect(conn.calls).not.toContain('customer_properties');
    expect(conn.calls).not.toContain('property_notification_prefs');
    expect(conn.calls).not.toContain('property_text_decisions');
  });

  test('enforced: ONE extra pair of reads for the whole payload, read-only (no decision-log table is ever touched)', async () => {
    const { conn } = await run([visit('a', 'p-off'), visit('b', 'p-rental'), visit('c', 'p-family'), visit('d', null)], { enforced: true });
    expect(conn.calls.filter((t) => t === 'customer_properties')).toHaveLength(1);
    expect(conn.calls.filter((t) => t === 'property_notification_prefs')).toHaveLength(1);
    expect(conn.calls).not.toContain('property_text_decisions');
  });

  test('enforced: a failed property read throws (unknown)', async () => {
    mockEnforced.on = true;
    const conn = fakeTables(tables());
    const failing = jest.fn((table) => { if (table === 'customer_properties') throw new Error('property read failed'); return conn(table); });
    failing.raw = conn.raw;
    await expect(reminders.loadVisitReminder24hAnswers(failing, [visit('v', 'p-off')])).rejects.toThrow('property read failed');
  });

  test('the booking window: the customer row\'s answer, and each saved property\'s own while enforced', async () => {
    mockEnforced.on = false;
    expect(await reminders.loadBookingReminder24hAnswers(fakeTables(tables()), 'c-default')).toEqual({ customer: true, properties: {} });
    mockEnforced.on = true;
    const on = await reminders.loadBookingReminder24hAnswers(fakeTables(tables()), 'c-default');
    expect(on.customer).toBe(true);
    expect(on.properties).toEqual({ 'p-off': false, 'p-rental': true, 'p-family': true });
  });

  test('the overlay is the one helper resolveAppointmentPrefs uses', () => {
    const property = { id: 'p', relationship: 'rental_owned' };
    const customerPrefs = { sms_enabled: true, service_reminder_24h: true, service_reminder_72h: true };
    const overlaid = propertyPrefs.overlayPropertyPrefs(property, undefined, customerPrefs);
    expect(overlaid).toEqual({ ...customerPrefs, ...propertyPrefs.effectivePropertyToggles(property, undefined, customerPrefs) });
    expect(overlaid.service_reminder_24h).toBe(false);
    expect(overlaid.sms_enabled).toBe(true);
  });
});

describe('GET /:id/visit-summary (the fallback read for a row from any other feed)', () => {
  const handler = adminSchedule.stack
    ? adminSchedule.stack.find((l) => l.route?.path === '/:id/visit-summary' && l.route.methods.get).route.stack.slice(-1)[0].handle
    : null;
  const run = async () => {
    const res = { json: jest.fn() };
    await handler({ params: { id: 'v1' }, technicianId: 't1' }, res, jest.fn());
    return res.json.mock.calls[0][0];
  };

  beforeEach(() => {
    db.mockReset();
    db.raw = (sql) => ({ raw: sql });
    resolvePromises.mockReset();
  });

  test('gate off: the reply is exactly {visit}; nothing else is read', withGate(undefined, async () => {
    expect(await run()).toEqual({ visit: null });
    expect(db).not.toHaveBeenCalled();
    expect(resolvePromises).not.toHaveBeenCalled();
  }));

  test('gate on: {visit, office} with customerAskedTime, told and reminder24hOn', withGate('true', async () => {
    const soon = new Date(Date.now() + 4 * 86400000);
    const tables = {
      scheduled_services: [{ id: 'v1', customer_id: 'c-default', scheduled_date: soon.toISOString().slice(0, 10), status: 'confirmed', customer_asked_time: true, customer_asked_time_at: null, has_slot_change: false, slot_after_intent: false }],
      customers: [{ id: 'c-default', account_id: 'a1', is_primary_profile: true }],
      notification_prefs: [],
    };
    const conn = fakeTables(tables);
    db.mockImplementation(conn);
    db.raw = conn.raw;
    resolvePromises.mockResolvedValue(new Map([['v1', { start_at: soon.toISOString() }]]));
    const reply = await run();
    expect(reply.visit).toBeNull();
    expect(reply.office).toMatchObject({ customerAskedTime: true, reminder24hOn: true, told: { level: 'hour', dayOnly: false } });
    expect(resolvePromises).toHaveBeenCalledTimes(1);
  }));

  test('gate on, a failed read: the reply is still {visit}', withGate('true', async () => {
    db.mockImplementation(() => { throw new Error('db down'); });
    expect(await run()).toEqual({ visit: null });
  }));
});

describe('schedule-estimates carries the reminder answers for the booking window', () => {
  test('gate off: {} and no read; gate on: the customer row\'s answer and, while enforced, each property\'s', async () => {
    db.mockReset();
    expect(await adminCustomers.reminder24hField('c-default')).toEqual({});
    expect(db).not.toHaveBeenCalled();
    const prior = process.env.GATE_DAY_ONLY_PROMISE;
    process.env.GATE_DAY_ONLY_PROMISE = 'true';
    const data = {
      customers: [{ id: 'c-off', account_id: 'a2', is_primary_profile: true }],
      notification_prefs: [{ customer_id: 'c-off', service_reminder_24h: false }],
      customer_properties: [{ id: 'p-1', customer_id: 'c-off', is_primary: false, active: true, relationship: 'rental_owned' }],
      property_notification_prefs: [{ property_id: 'p-1', service_reminder_24h: true }],
    };
    try {
      mockEnforced.on = false;
      db.mockImplementation(fakeTables(data));
      expect(await adminCustomers.reminder24hField('c-off')).toEqual({ reminder24hOn: false, reminder24hByProperty: {} });
      mockEnforced.on = true;
      db.mockImplementation(fakeTables(data));
      expect(await adminCustomers.reminder24hField('c-off')).toEqual({ reminder24hOn: false, reminder24hByProperty: { 'p-1': true } });
      db.mockImplementation(fakeTables(data, { fail: true }));
      expect(await adminCustomers.reminder24hField('c-off')).toEqual({});
    } finally {
      mockEnforced.on = false;
      if (prior === undefined) delete process.env.GATE_DAY_ONLY_PROMISE; else process.env.GATE_DAY_ONLY_PROMISE = prior;
    }
  });
});

describe('the list feed and the client cutoff', () => {
  test('GET /list stamps the office fields on its rows (the same helper as the day and week feeds)', () => {
    const source = fs.readFileSync(path.join(__dirname, '../routes/admin-schedule.js'), 'utf8');
    const start = source.indexOf("router.get('/list'");
    const end = source.indexOf("router.post('/bulk-action'");
    const list = source.slice(start, end);
    expect(list).toMatch(/await attachOfficeToldFields\(req, mapped\);\s+res\.json\(\{\s+services: mapped/);
  });

  test('the client\'s cutoff constant equals the server\'s DAY_PROMISE_CUTOFF_HOURS', () => {
    const client = fs.readFileSync(path.join(__dirname, '../../client/src/components/schedule/dayOnlyPromise.js'), 'utf8');
    const match = client.match(/export const DAY_PROMISE_CUTOFF_HOURS = ([0-9.]+);/);
    expect(match).not.toBeNull();
    expect(Number(match[1])).toBe(DAY_PROMISE_CUTOFF_HOURS);
  });
});
