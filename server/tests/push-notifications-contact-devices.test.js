// Contact devices (contact login, GATE_CONTACT_LOGIN): a push_subscriptions
// row stamped with contact_phone_key is an on-location contact's phone. The
// sender (sendToCustomer) excludes it from every push except the appointment
// and report purposes contactPushPurpose names, and then only while the key
// still occupies a contact slot and the contact's own choices allow it —
// so a contact never sees the holder's billing, and a removed contact stops
// at once. The holder's devices are untouched either way. customerStatus
// answers per person.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/apns', () => ({ send: jest.fn(async () => ({ ok: true })), status: () => ({ configured: true }) }));
jest.mock('../services/fcm', () => ({ send: jest.fn(async () => ({ ok: true })), status: () => ({ configured: true }) }));
jest.mock('../services/account-properties', () => ({
  accountPropertyIds: jest.fn(async () => []),
  resolvePrimaryProfileId: jest.fn(async (req) => req.customerId),
  appPropertyScopeEnabled: jest.fn(() => false),
}));
jest.mock('../config/feature-gates', () => ({
  gateEnvValue: jest.fn(() => false),
  contactLoginLive: () => process.env.GATE_CONTACT_LOGIN === 'true',
}));

const db = require('../models/db');
const apns = require('../services/apns');
const Push = require('../services/push-notifications');

const HOLDER_ID = 'cust-1';
const CONTACT_KEY = '9415550202';
const CUSTOMER = { id: HOLDER_ID, account_id: null, is_primary_profile: true, active: true, deleted_at: null, phone: '+19415550101',
  contact_role: null, service_contacts_consent_at: '2026-10-01T00:00:00Z', service_preferences: null,
  service_contact_name: 'Sam', service_contact_phone: '+19415550202', service_contact_email: null, service_contact_role: null,
  service_contact2_name: null, service_contact2_phone: null, service_contact2_email: null, service_contact2_role: null,
  service_contact3_name: null, service_contact3_phone: null, service_contact3_email: null, service_contact3_role: null };
const HOLDER_DEVICE = { id: 'sub-h', customer_id: HOLDER_ID, platform: 'ios', device_token: 'tok-h', contact_phone_key: null, role: 'customer', active: true, updated_at: new Date() };
const CONTACT_DEVICE = { id: 'sub-c', customer_id: HOLDER_ID, platform: 'ios', device_token: 'tok-c', contact_phone_key: CONTACT_KEY, role: 'customer', active: true, updated_at: new Date() };

let subs;
let prefRows;
let customerRow;
let prefsFail;
function subsQuery() {
  const conds = [];
  const q = {};
  q.whereIn = () => q;
  q.where = (obj) => { if (obj && typeof obj === 'object') conds.push((r) => Object.entries(obj).every(([k, v]) => String(r[k]) === String(v))); return q; };
  q.whereNull = (col) => { conds.push((r) => r[col] == null); return q; };
  q.modify = (fn) => { fn(q); return q; };
  q.select = async () => subs.filter((r) => conds.every((c) => c(r)));
  q.then = (resolve, reject) => Promise.resolve(subs.filter((r) => conds.every((c) => c(r)))).then(resolve, reject);
  return q;
}
beforeEach(() => {
  jest.clearAllMocks();
  process.env.GATE_CONTACT_LOGIN = 'true';
  subs = [HOLDER_DEVICE, CONTACT_DEVICE];
  prefRows = [];
  prefsFail = false;
  customerRow = CUSTOMER;
  db.mockImplementation((table) => {
    if (table === 'customers') return { where: () => ({ first: async () => customerRow }) };
    if (table === 'notification_prefs') return { where: () => ({ first: async () => ({ push_enabled: true }) }) };
    if (table === 'push_subscriptions') return subsQuery();
    if (table === 'service_contact_notification_prefs') return { where: () => ({ select: async () => { if (prefsFail) throw new Error('boom'); return prefRows; } }) };
    throw new Error(`Unexpected table ${table}`);
  });
});
afterEach(() => { delete process.env.GATE_CONTACT_LOGIN; });
// apns.send(token, ...) — the device token is the first argument.
const sentTokens = () => apns.send.mock.calls.map((c) => c[0]);

async function send(messageType) {
  return Push.sendToCustomer(HOLDER_ID, { title: 't', body: 'b', url: '/', category: 'service' }, messageType ? { messageType } : {});
}

describe('sendToCustomer — contact devices', () => {
  test('a billing push, and an untyped push, reach the holder\'s device only', async () => {
    await send('billing_reminder');
    expect(apns.send).toHaveBeenCalledTimes(1);
    expect(sentTokens()).toEqual(['tok-h']);
    apns.send.mockClear();
    await send(undefined);
    expect(apns.send).toHaveBeenCalledTimes(1);
    expect(sentTokens()).toEqual(['tok-h']);
  });

  test.each(['tech_en_route', 'tech_arrived', 'appointment_reminder', 'reminder_72h', 'appointment_confirmation', 'service_complete', 'service_report_v1', 'appointment_cancelled', 'service_completed'])(
    '%s reaches the contact device too', async (type) => {
      const result = await send(type);
      expect(result.sent).toBe(2);
      expect(sentTokens().sort()).toEqual(['tok-c', 'tok-h']);
    },
  );

  test('the contact\'s own choice holds their device: purpose off, texts off, or email-only delivery', async () => {
    prefRows = [{ phone_key: CONTACT_KEY, tech_en_route: false }];
    await send('tech_en_route');
    expect(sentTokens()).toEqual(['tok-h']);
    apns.send.mockClear();
    prefRows = [{ phone_key: CONTACT_KEY, sms_enabled: false }];
    await send('appointment_cancelled');
    expect(sentTokens()).toEqual(['tok-h']);
    apns.send.mockClear();
    prefRows = [{ phone_key: CONTACT_KEY, en_route_channel: 'email' }];
    await send('tech_en_route');
    expect(sentTokens()).toEqual(['tok-h']);
    apns.send.mockClear();
    prefRows = [{ phone_key: CONTACT_KEY, tech_arrived: false }];
    await send('tech_en_route');
    expect(sentTokens().sort()).toEqual(['tok-c', 'tok-h']);
  });

  test('a device whose key no longer occupies a contact slot is dropped (the holder removed the contact)', async () => {
    customerRow = { ...CUSTOMER, service_contact_phone: '+19415550999' };
    await send('tech_en_route');
    expect(sentTokens()).toEqual(['tok-h']);
  });

  test('fails closed: an unreadable choices table drops the contact device and keeps the holder\'s', async () => {
    prefsFail = true;
    await send('tech_en_route');
    expect(sentTokens()).toEqual(['tok-h']);
  });

  test('gate off: contact devices are excluded from everything', async () => {
    delete process.env.GATE_CONTACT_LOGIN;
    await send('tech_en_route');
    expect(sentTokens()).toEqual(['tok-h']);
  });

  // The contact's authorization is re-read at the push, as the login and the
  // Documents tab read it (codex security r1): a number the attestation no
  // longer covers gets nothing; a contact the report rule withholds reports
  // from gets no report push (its body and link carry the report), but still
  // the appointment notices.
  test('a number whose consent was withdrawn (attestation cleared, or the key on the unconsented list) gets no push', async () => {
    customerRow = { ...CUSTOMER, service_contacts_consent_at: null };
    await send('tech_en_route');
    expect(sentTokens()).toEqual(['tok-h']);
    apns.send.mockClear();
    customerRow = { ...CUSTOMER, service_preferences: JSON.stringify({ unconsented_slot_phone_keys: [CONTACT_KEY] }) };
    await send('tech_en_route');
    expect(sentTokens()).toEqual(['tok-h']);
  });

  test('a tenant contact gets the en-route push but never the report push', async () => {
    customerRow = { ...CUSTOMER, service_contact_role: 'tenant' };
    await send('tech_en_route');
    expect(sentTokens().sort()).toEqual(['tok-c', 'tok-h']);
    apns.send.mockClear();
    await send('service_complete');
    expect(sentTokens()).toEqual(['tok-h']);
    apns.send.mockClear();
    customerRow = { ...CUSTOMER, service_contact_role: 'tenant', contact_role: 'property_manager' };
    await send('service_report_v1');
    expect(sentTokens()).toEqual(['tok-h']);
  });

  test('contactPushPurpose: an exact allowlist — the plain completion notices, never a billing-bearing variant', () => {
    const { contactPushPurpose } = require('../services/contact-notification-prefs');
    expect(contactPushPurpose('tech_en_route')).toEqual({ allowed: true, column: 'tech_en_route' });
    expect(contactPushPurpose('service_complete')).toEqual({ allowed: true, column: 'service_completed' });
    expect(contactPushPurpose('service_report_v1')).toEqual({ allowed: true, column: 'service_completed' });
    expect(contactPushPurpose('appointment_no_show')).toEqual({ allowed: true, column: null });
    for (const type of ['service_complete_with_invoice', 'service_report_v1_with_invoice', 'service_complete_paid_receipt',
      'service_complete_annual_prepay', 'service_report_v1_ready',
      'receipt', 'invoice', 'payment_failure', 'service_request_received', 'weather_alerts', 'one_tap_purchase', '', undefined]) {
      expect(contactPushPurpose(type).allowed).toBe(false);
    }
  });
});

describe('sendToCustomer — a contact device belongs to ONE profile', () => {
  test('a push addressed to this profile never reaches a contact device registered on a sibling profile; the holder\'s sibling device still gets it (codex r1)', async () => {
    // The account-wide lookup returned a sibling profile's rows too.
    subs = [
      HOLDER_DEVICE,
      CONTACT_DEVICE,
      { ...HOLDER_DEVICE, id: 'sub-h2', customer_id: 'cust-sibling', device_token: 'tok-h2' },
      { ...CONTACT_DEVICE, id: 'sub-c2', customer_id: 'cust-sibling', device_token: 'tok-c2', contact_phone_key: '9415550999' },
    ];
    await send('tech_en_route');
    expect(sentTokens().sort()).toEqual(['tok-c', 'tok-h', 'tok-h2']);
  });
});

describe('customerStatus — per person', () => {
  test('the holder\'s status never counts a contact device; a contact\'s counts only theirs', async () => {
    subs = [CONTACT_DEVICE];
    expect((await Push.customerStatus(HOLDER_ID)).registered).toBe(false);
    expect((await Push.customerStatus(HOLDER_ID, undefined, { contactKey: CONTACT_KEY })).registered).toBe(true);
    subs = [HOLDER_DEVICE];
    expect((await Push.customerStatus(HOLDER_ID)).registered).toBe(true);
    expect((await Push.customerStatus(HOLDER_ID, undefined, { contactKey: CONTACT_KEY })).registered).toBe(false);
  });
});
