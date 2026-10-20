'use strict';

// Per-contact notification choices (contact login, GATE_CONTACT_LOGIN):
// services/contact-notification-prefs.js. The one rule every sender seam
// applies after the opt-in filter: a contact's stored choice only NARROWS —
// it holds that contact's text or email for a purpose they declined, never
// adds a recipient, and never touches the primary / billing recipients.
// Fail closed on an unreadable table; a missing table is the absent state;
// gate off = pass-through.

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const ContactPrefs = require('../services/contact-notification-prefs');

const CUSTOMER = { id: 'cust-1', phone: '+19415550101', first_name: 'Pat', email: 'pat@example.com',
  service_contact_name: 'Sam', service_contact_phone: '+19415550202', service_contact_email: 'sam@example.com',
  service_contact2_name: 'Terry', service_contact2_phone: '+19415550303', service_contact2_email: 'terry@example.com' };
const PRIMARY = { phone: '+19415550101', email: 'pat@example.com', name: 'Pat', role: 'primary' };
const SAM = { phone: '+19415550202', email: 'sam@example.com', name: 'Sam', role: 'service_contact' };
const TERRY = { phone: '+19415550303', email: 'terry@example.com', name: 'Terry', role: 'service_contact_2' };

let rows;
let failWith = null;
function builder() {
  const conds = [];
  const b = {};
  const matching = () => rows.filter((r) => conds.every((c) => c(r)));
  b.where = (obj) => { Object.entries(obj).forEach(([k, v]) => conds.push((r) => String(r[k]) === String(v))); return b; };
  b.whereNotIn = (col, vals) => { conds.push((r) => !vals.map(String).includes(String(r[col]))); return b; };
  b.select = async () => { if (failWith) throw failWith; return matching(); };
  b.first = async () => { if (failWith) throw failWith; return matching()[0] || null; };
  b.delete = async () => { if (failWith) throw failWith; const hit = matching(); rows = rows.filter((r) => !hit.includes(r)); return hit.length; };
  return b;
}

beforeEach(() => {
  rows = [];
  failWith = null;
  db.mockImplementation(() => builder());
  process.env.GATE_CONTACT_LOGIN = 'true';
});
afterEach(() => { delete process.env.GATE_CONTACT_LOGIN; });

describe('contactAllows (pure)', () => {
  test('no row = allowed; an explicit false on the purpose holds it', () => {
    expect(ContactPrefs.contactAllows(null, 'tech_en_route', 'sms')).toBe(true);
    expect(ContactPrefs.contactAllows({ tech_en_route: null }, 'tech_en_route', 'sms')).toBe(true);
    expect(ContactPrefs.contactAllows({ tech_en_route: false }, 'tech_en_route', 'sms')).toBe(false);
    expect(ContactPrefs.contactAllows({ tech_en_route: false }, 'tech_en_route', 'email')).toBe(false);
  });

  test('the master switches hold their channel; a purpose with no opt-out still honors them', () => {
    expect(ContactPrefs.contactAllows({ sms_enabled: false }, null, 'sms')).toBe(false);
    expect(ContactPrefs.contactAllows({ sms_enabled: false }, null, 'email')).toBe(true);
    expect(ContactPrefs.contactAllows({ email_enabled: false }, 'service_completed', 'email')).toBe(false);
    expect(ContactPrefs.contactAllows({ email_enabled: false }, 'service_completed', 'sms')).toBe(true);
  });

  test('a channel choice narrows to that leg; both / null = whatever the account sends', () => {
    expect(ContactPrefs.contactAllows({ en_route_channel: 'email' }, 'tech_en_route', 'sms')).toBe(false);
    expect(ContactPrefs.contactAllows({ en_route_channel: 'email' }, 'tech_en_route', 'email')).toBe(true);
    expect(ContactPrefs.contactAllows({ en_route_channel: 'sms' }, 'tech_en_route', 'email')).toBe(false);
    expect(ContactPrefs.contactAllows({ en_route_channel: 'both' }, 'tech_en_route', 'email')).toBe(true);
    expect(ContactPrefs.contactAllows({ en_route_channel: null }, 'tech_en_route', 'email')).toBe(true);
  });

  test('the appointment email event types map to their purpose column; no-show and cancellation to none', () => {
    expect(ContactPrefs.columnForEmailEvent('appointment.confirmation')).toBe('appointment_confirmation');
    expect(ContactPrefs.columnForEmailEvent('appointment.reminder_72h')).toBe('service_reminder_72h');
    expect(ContactPrefs.columnForEmailEvent('appointment.reminder_24h')).toBe('service_reminder_24h');
    expect(ContactPrefs.columnForEmailEvent('appointment.en_route')).toBe('tech_en_route');
    expect(ContactPrefs.columnForEmailEvent('appointment.tech_arrived')).toBe('tech_arrived');
    expect(ContactPrefs.columnForEmailEvent('appointment.no_show')).toBeNull();
  });
});

describe('filterContactsByOwnPrefs (send-path seam)', () => {
  test('drops only the service contact who declined this purpose; the holder and the other contact stay', async () => {
    rows = [{ customer_id: 'cust-1', phone_key: '9415550202', service_reminder_24h: false }];
    const kept = await ContactPrefs.filterContactsByOwnPrefs([SAM, TERRY, PRIMARY], 'cust-1', 'service_reminder_24h');
    expect(kept.map((c) => c.role)).toEqual(['service_contact_2', 'primary']);
  });

  test('a declined purpose in another column does not hold this one', async () => {
    rows = [{ customer_id: 'cust-1', phone_key: '9415550202', service_reminder_24h: false }];
    const kept = await ContactPrefs.filterContactsByOwnPrefs([SAM, PRIMARY], 'cust-1', 'tech_en_route');
    expect(kept).toEqual([SAM, PRIMARY]);
  });

  test('texts off for the contact holds every purpose, including one with no opt-out (null column)', async () => {
    rows = [{ customer_id: 'cust-1', phone_key: '9415550202', sms_enabled: false }];
    expect(await ContactPrefs.filterContactsByOwnPrefs([SAM, PRIMARY], 'cust-1', null)).toEqual([PRIMARY]);
  });

  test('never ADDS a recipient and never touches a primary row even when the holder opted out', async () => {
    rows = [{ customer_id: 'cust-1', phone_key: '9415550101', tech_en_route: false }];
    expect(await ContactPrefs.filterContactsByOwnPrefs([PRIMARY], 'cust-1', 'tech_en_route')).toEqual([PRIMARY]);
    expect(await ContactPrefs.filterContactsByOwnPrefs([], 'cust-1', 'tech_en_route')).toEqual([]);
  });

  test('gate off: pass-through, the table is not even read', async () => {
    delete process.env.GATE_CONTACT_LOGIN;
    rows = [{ customer_id: 'cust-1', phone_key: '9415550202', tech_en_route: false }];
    db.mockImplementation(() => { throw new Error('must not read'); });
    expect(await ContactPrefs.filterContactsByOwnPrefs([SAM, PRIMARY], 'cust-1', 'tech_en_route')).toEqual([SAM, PRIMARY]);
  });

  test('fails CLOSED: an unreadable table holds every service contact and keeps the holder', async () => {
    failWith = new Error('connection reset');
    const kept = await ContactPrefs.filterContactsByOwnPrefs([SAM, TERRY, PRIMARY], 'cust-1', 'tech_en_route');
    expect(kept).toEqual([PRIMARY]);
  });

  test('rethrows on a transaction handle (Postgres has aborted that transaction)', async () => {
    failWith = new Error('connection reset');
    const trx = Object.assign(() => builder(), { isTransaction: true });
    await expect(ContactPrefs.filterContactsByOwnPrefs([SAM], 'cust-1', 'tech_en_route', { dbh: trx })).rejects.toThrow('connection reset');
  });

  test('a missing table (un-migrated env) is the absent state: pass-through', async () => {
    failWith = Object.assign(new Error('relation does not exist'), { code: '42P01' });
    expect(await ContactPrefs.filterContactsByOwnPrefs([SAM, PRIMARY], 'cust-1', 'tech_en_route')).toEqual([SAM, PRIMARY]);
  });
});

describe('filterReportEmailRecipientsByContactPrefs (service-report email)', () => {
  const reportRecipients = [
    { phone: '+19415550202', email: 'sam@example.com', name: 'Sam', role: 'service_contact' },
    { phone: '+19415550303', email: 'terry@example.com', name: 'Terry', role: 'service_contact_2' },
    { ...PRIMARY },
  ];

  test('drops the slot whose phone declined service reports (or email), keeps the rest', async () => {
    rows = [
      { customer_id: 'cust-1', phone_key: '9415550202', service_completed: false },
      { customer_id: 'cust-1', phone_key: '9415550303', service_complete_channel: 'sms' },
    ];
    const kept = await ContactPrefs.filterReportEmailRecipientsByContactPrefs(reportRecipients, CUSTOMER);
    expect(kept.map((r) => r.role)).toEqual(['primary']);
  });

  test('an email-only slot (no phone, so no row) and a slot with no row pass through', async () => {
    rows = [];
    const customer = { ...CUSTOMER, service_contact2_phone: null };
    const kept = await ContactPrefs.filterReportEmailRecipientsByContactPrefs(reportRecipients, customer);
    expect(kept).toHaveLength(3);
  });

  test('fails closed on an unreadable table: slot emails held, the holder kept', async () => {
    failWith = new Error('boom');
    const kept = await ContactPrefs.filterReportEmailRecipientsByContactPrefs(reportRecipients, CUSTOMER);
    expect(kept.map((r) => r.role)).toEqual(['primary']);
  });
});

describe('contactDeclinesChannel (single-recipient resolvers: review outreach)', () => {
  test('a service contact whose master switch is off declines that channel; the other channel and the holder never do', async () => {
    rows = [{ customer_id: 'cust-1', phone_key: '9415550202', sms_enabled: false, email_enabled: true }];
    expect(await ContactPrefs.contactDeclinesChannel('cust-1', SAM, 'sms')).toBe(true);
    expect(await ContactPrefs.contactDeclinesChannel('cust-1', SAM, 'email')).toBe(false);
    expect(await ContactPrefs.contactDeclinesChannel('cust-1', PRIMARY, 'sms')).toBe(false);
    expect(await ContactPrefs.contactDeclinesChannel('cust-1', TERRY, 'sms')).toBe(false);
    expect(await ContactPrefs.contactDeclinesChannel('cust-1', null, 'sms')).toBe(false);
  });

  test('gate off never declines; an unreadable table declines (fail closed) except on a transaction, which rethrows', async () => {
    rows = [{ customer_id: 'cust-1', phone_key: '9415550202', sms_enabled: false }];
    delete process.env.GATE_CONTACT_LOGIN;
    expect(await ContactPrefs.contactDeclinesChannel('cust-1', SAM, 'sms')).toBe(false);
    process.env.GATE_CONTACT_LOGIN = 'true';
    failWith = new Error('boom');
    expect(await ContactPrefs.contactDeclinesChannel('cust-1', SAM, 'sms')).toBe(true);
    const trx = Object.assign(() => builder(), { isTransaction: true });
    await expect(ContactPrefs.contactDeclinesChannel('cust-1', SAM, 'sms', { dbh: trx })).rejects.toThrow('boom');
  });
});

describe('pruneContactNotificationPrefs (holder contact save)', () => {
  test('deletes the rows of phones no longer in a slot and keeps the survivors', async () => {
    rows = [
      { customer_id: 'cust-1', phone_key: '9415550202' },
      { customer_id: 'cust-1', phone_key: '9415550303' },
      { customer_id: 'cust-2', phone_key: '9415550303' },
    ];
    await ContactPrefs.pruneContactNotificationPrefs(() => builder(), 'cust-1', ['(941) 555-0303']);
    expect(rows).toEqual([
      { customer_id: 'cust-1', phone_key: '9415550303' },
      { customer_id: 'cust-2', phone_key: '9415550303' },
    ]);
  });

  test('an empty slot list clears every row of that customer only', async () => {
    rows = [{ customer_id: 'cust-1', phone_key: '9415550202' }, { customer_id: 'cust-2', phone_key: '9415550202' }];
    await ContactPrefs.pruneContactNotificationPrefs(() => builder(), 'cust-1', []);
    expect(rows).toEqual([{ customer_id: 'cust-2', phone_key: '9415550202' }]);
  });
});
