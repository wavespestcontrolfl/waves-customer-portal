'use strict';

// Contact session (GATE_CONTACT_LOGIN): GET/PUT /api/notifications/
// contact-preferences — the on-location contact's OWN choices, overlaid on
// the account's (a purpose the holder turned off reads off and locked), a
// consent rail for turning texts on, and the in-app attestation standing in
// for the YES reply on a pending / undelivered opt-in ask only (owner
// 2026-10-20) — never over a STOP. The holder's own contact save prunes the
// row of a removed phone.
//
// Real router + real express; the auth middleware is a stand-in that injects
// the session the real one would have built (its own rules are covered in
// contact-portal-access.test.js).

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/account-membership-email', () => ({ sendAccountUpdated: jest.fn(() => Promise.resolve()) }));
jest.mock('../services/recipient-optin', () => ({
  onRecipientConfirmed: jest.fn(() => Promise.resolve()),
  noteHolderSetNotifyPrimary: jest.fn(() => Promise.resolve()),
  claimRecipientOptins: jest.fn(() => Promise.resolve([])),
}));
jest.mock('../services/service-contact-events', () => ({ recordServiceContactChanges: jest.fn(() => Promise.resolve()) }));
const mockSession = { current: null };
jest.mock('../middleware/auth', () => ({
  authenticate: (req, _res, next) => { Object.assign(req, mockSession.current); next(); },
  revokeRemovedContactRefreshSessions: jest.fn(() => Promise.resolve(0)),
}));

const express = require('express');
const db = require('../models/db');
const { onRecipientConfirmed } = require('../services/recipient-optin');
const { revokeRemovedContactRefreshSessions } = require('../middleware/auth');
const router = require('../routes/notifications');

// ── in-memory db ──────────────────────────────────────────────────────────
let tables;
function builder(table) {
  const conds = [];
  const b = {};
  const rows = () => (tables[table] ||= []).filter((r) => conds.every((c) => c(r)));
  b.where = (a, op, val) => {
    if (typeof a === 'function') return b;
    if (typeof a === 'object') Object.entries(a).forEach(([k, v]) => conds.push((r) => String(r[k]) === String(v)));
    else if (val === undefined) conds.push((r) => String(r[a]) === String(op));
    else conds.push((r) => String(r[a]) === String(val));
    return b;
  };
  b.whereIn = (col, vals) => { conds.push((r) => vals.map(String).includes(String(r[col]))); return b; };
  b.whereNotIn = (col, vals) => { conds.push((r) => !vals.map(String).includes(String(r[col]))); return b; };
  b.whereNull = (col) => { conds.push((r) => r[col] == null); return b; };
  b.whereNotNull = (col) => { conds.push((r) => r[col] != null); return b; };
  b.orderBy = () => b;
  b.forUpdate = () => b;
  b.select = async () => rows();
  b.first = async () => rows()[0] || null;
  b.update = async (patch) => { const hit = rows(); hit.forEach((r) => Object.assign(r, patch)); return hit.length; };
  b.delete = async () => { const hit = rows(); tables[table] = tables[table].filter((r) => !hit.includes(r)); return hit.length; };
  b.insert = (row) => ({
    onConflict: () => ({
      merge: async (patch) => {
        const existing = (tables[table] ||= []).find((r) => String(r.customer_id) === String(row.customer_id) && String(r.phone_key) === String(row.phone_key));
        if (existing) Object.assign(existing, patch);
        else tables[table].push({ ...row });
        return [];
      },
      ignore: () => ({ returning: async () => [] }),
    }),
    returning: async () => { (tables[table] ||= []).push({ ...row }); return [row]; },
    then: (resolve) => { (tables[table] ||= []).push({ ...row }); return Promise.resolve([row]).then(resolve); },
  });
  return b;
}
function installDb() {
  const trx = Object.assign((table) => builder(table), { isTransaction: true, raw: async () => {} });
  db.mockImplementation((table) => builder(table));
  db.transaction = async (fn) => fn(trx);
  db.raw = async () => {};
  db.fn = { now: () => new Date() };
}

const HOLDER = {
  id: 'cust-1', account_id: 'cust-1', active: true, is_primary_profile: true, contact_role: null, deleted_at: null,
  phone: '+19415550101', email: 'pat@example.com', first_name: 'Pat',
  service_contact_name: 'Sam Spouse', service_contact_phone: '+19415550202', service_contact_email: 'sam@example.com', service_contact_role: null,
  service_contact2_name: 'Terry Tenant', service_contact2_phone: '+19415550303', service_contact2_email: null, service_contact2_role: 'tenant',
  service_contacts_consent_at: '2026-07-23T00:00:00Z',
};
const SAM = { slot: 1, name: 'Sam Spouse', phone: '+19415550202', email: 'sam@example.com', role: 'service_contact', contactRole: null, phoneKey: '9415550202' };
const TERRY = { slot: 2, name: 'Terry Tenant', phone: '+19415550303', email: '', role: 'service_contact_2', contactRole: 'tenant', phoneKey: '9415550303' };

let server;
let baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/notifications', router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  server = app.listen(0, '127.0.0.1', () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.close(done); });

beforeEach(() => {
  tables = {
    customers: [{ ...HOLDER }],
    notification_prefs: [{ customer_id: 'cust-1', service_reminder_72h: false }],
    service_contact_notification_prefs: [],
    recipient_optin: [],
  };
  installDb();
  onRecipientConfirmed.mockClear();
  mockSession.current = { customer: tables.customers[0], customerId: 'cust-1', accountId: 'cust-1', contactSession: SAM };
  process.env.GATE_CONTACT_LOGIN = 'true';
});
afterEach(() => { delete process.env.GATE_CONTACT_LOGIN; });

async function call(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch { /* none */ }
  return { status: res.status, body: json || {} };
}
const get = () => call('GET', '/api/notifications/contact-preferences');
const put = (body) => call('PUT', '/api/notifications/contact-preferences', body);

describe('GET /contact-preferences', () => {
  test('effective choices: every purpose on by default, the holder\'s account-wide off reads off AND locked', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.contact).toEqual({ name: 'Sam Spouse', phone: '+19415550202', email: 'sam@example.com', slot: 1 });
    expect(res.body.preferences.appointmentConfirmation).toBe(true);
    expect(res.body.preferences.serviceReminder72h).toBe(false);
    expect(res.body.accountOff.serviceReminder72h).toBe(true);
    expect(res.body.accountOff.appointmentConfirmation).toBe(false);
    expect(res.body.preferences.enRouteChannel).toBe('both');
    expect(res.body.preferences.smsEnabled).toBe(true);
    expect(res.body.emailAvailable).toBe(true);
    expect(res.body.reportsWithheld).toBe(false);
    expect(res.body.smsOptin).toBe('none');
    expect(res.body.consentAttestedAt).toBeNull();
  });

  test('the contact\'s own stored choice overlays; a tenant is told reports are withheld; no email = no email choice', async () => {
    tables.service_contact_notification_prefs.push({ customer_id: 'cust-1', phone_key: '9415550303', tech_en_route: false, en_route_channel: 'sms', consent_attested_at: '2026-10-20T00:00:00Z' });
    mockSession.current.contactSession = TERRY;
    const res = await get();
    expect(res.body.preferences.techEnRoute).toBe(false);
    expect(res.body.preferences.enRouteChannel).toBe('sms');
    expect(res.body.reportsWithheld).toBe(true);
    expect(res.body.emailAvailable).toBe(false);
    expect(res.body.consentAttestedAt).toBe('2026-10-20T00:00:00Z');
    // A stored email-only choice with no address on file reads as the
    // default, never as an option the card no longer offers (codex r6).
    tables.service_contact_notification_prefs[0].en_route_channel = 'email';
    expect((await get()).body.preferences.enRouteChannel).toBe('both');
  });

  test('a holder session is refused (the holder manages contacts through /property-preferences)', async () => {
    mockSession.current.contactSession = null;
    expect((await get()).status).toBe(403);
    expect((await put({ techEnRoute: false })).status).toBe(403);
  });
});

describe('PUT /contact-preferences', () => {
  test('turning a purpose OFF needs no attestation and narrows the next send', async () => {
    const res = await put({ techEnRoute: false, serviceCompleteChannel: 'email' });
    expect(res.status).toBe(200);
    expect(res.body.preferences.techEnRoute).toBe(false);
    expect(res.body.preferences.serviceCompleteChannel).toBe('email');
    expect(tables.service_contact_notification_prefs).toEqual([
      expect.objectContaining({ customer_id: 'cust-1', phone_key: '9415550202', tech_en_route: false, service_complete_channel: 'email' }),
    ]);
    expect(onRecipientConfirmed).not.toHaveBeenCalled();
  });

  test('turning texts ON without the attestation on file is refused (CONSENT_REQUIRED)', async () => {
    tables.service_contact_notification_prefs.push({ customer_id: 'cust-1', phone_key: '9415550202', tech_en_route: false });
    const res = await put({ techEnRoute: true });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CONSENT_REQUIRED');
    expect(tables.service_contact_notification_prefs[0].tech_en_route).toBe(false);
  });

  test('with the attestation: stamps consent, confirms THIS customer\'s pending or undelivered ask, leaves a STOP alone', async () => {
    tables.recipient_optin.push(
      { customer_id: 'cust-1', phone_key: '9415550202', status: 'pending' },
      { customer_id: 'cust-2', phone_key: '9415550202', status: 'pending' },
    );
    const res = await put({ techEnRoute: true, consentAttested: true });
    expect(res.status).toBe(200);
    expect(res.body.consentAttestedAt).toBeTruthy();
    expect(tables.recipient_optin.find((r) => r.customer_id === 'cust-1').status).toBe('confirmed');
    expect(tables.recipient_optin.find((r) => r.customer_id === 'cust-2').status).toBe('pending');
    expect(onRecipientConfirmed).toHaveBeenCalledWith('9415550202', expect.objectContaining({ dbh: expect.anything() }));

    // STOP stays STOP: a declined row is never confirmed from the app.
    onRecipientConfirmed.mockClear();
    tables.recipient_optin[0].status = 'declined';
    await put({ smsEnabled: true, consentAttested: true });
    expect(tables.recipient_optin[0].status).toBe('declined');
    expect(onRecipientConfirmed).not.toHaveBeenCalled();
  });

  test('an ask that failed to deliver (ask_failed) is confirmed by the in-app attestation too', async () => {
    tables.recipient_optin.push({ customer_id: 'cust-1', phone_key: '9415550202', status: 'ask_failed' });
    await put({ consentAttested: true, smsEnabled: true });
    expect(tables.recipient_optin[0].status).toBe('confirmed');
  });

  test('only a save that OPENS a text path needs the attestation: email-only delivery, a holder-off purpose, and a no-op re-enable do not (codex r1)', async () => {
    // Email-only delivery for a purpose the contact had off: no text path opens.
    tables.service_contact_notification_prefs.push({ customer_id: 'cust-1', phone_key: '9415550202', tech_en_route: false, en_route_channel: 'email' });
    expect((await put({ techEnRoute: true })).status).toBe(200);
    expect(tables.service_contact_notification_prefs[0].tech_en_route).toBe(true);
    // A purpose the holder turned off account-wide (serviceReminder72h): never a text path.
    tables.service_contact_notification_prefs[0].service_reminder_72h = false;
    expect((await put({ serviceReminder72h: true })).status).toBe(200);
    // Texts switched off on the row: turning a purpose on opens nothing yet…
    tables.service_contact_notification_prefs[0].sms_enabled = false;
    tables.service_contact_notification_prefs[0].tech_arrived = false;
    expect((await put({ techArrived: true })).status).toBe(200);
    // …but switching texts back on, with a purpose now live, does.
    const opened = await put({ smsEnabled: true });
    expect(opened.status).toBe(400);
    expect(opened.body.code).toBe('CONSENT_REQUIRED');
    // Moving a live purpose from email-only to Text opens a path too.
    tables.service_contact_notification_prefs[0].sms_enabled = true;
    const toText = await put({ enRouteChannel: 'sms' });
    expect(toText.status).toBe(400);
    expect(toText.body.code).toBe('CONSENT_REQUIRED');
  });

  test('a later enable needs no second attestation once one is on file', async () => {
    tables.service_contact_notification_prefs.push({ customer_id: 'cust-1', phone_key: '9415550202', tech_en_route: false, consent_attested_at: new Date('2026-10-19') });
    const res = await put({ techEnRoute: true });
    expect(res.status).toBe(200);
    expect(res.body.preferences.techEnRoute).toBe(true);
  });

  test('text-only delivery of the service report is refused while the contact report text is off (codex r9)', async () => {
    delete process.env.GATE_CONTACT_REPORT_TEXT;
    const res = await put({ serviceCompleteChannel: 'sms' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('REPORT_TEXT_UNAVAILABLE');
    expect(tables.service_contact_notification_prefs).toEqual([]);
    // Text + email (whatever the account sends) stays available.
    expect((await put({ serviceCompleteChannel: 'both' })).status).toBe(200);
  });

  test('email-only delivery needs an address on file for this contact', async () => {
    mockSession.current.contactSession = TERRY;
    const res = await put({ enRouteChannel: 'email' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/email address/i);
  });

  test('cannot re-enable a purpose the holder turned off account-wide: the stored true is harmless, the effective value stays off', async () => {
    const res = await put({ serviceReminder72h: true, consentAttested: true });
    expect(res.status).toBe(200);
    expect(res.body.preferences.serviceReminder72h).toBe(false);
    expect(res.body.accountOff.serviceReminder72h).toBe(true);
  });

  test('a contact the holder removed between the token check and the write gets 401 and nothing is written or confirmed (codex r3)', async () => {
    tables.recipient_optin.push({ customer_id: 'cust-1', phone_key: '9415550202', status: 'pending' });
    // The holder's save landed first: slot 1 now holds someone else.
    const holder = tables.customers[0];
    const original = holder.service_contact_phone;
    holder.service_contact_phone = '+19415550909';
    try {
      const res = await put({ techEnRoute: true, consentAttested: true });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('CONTACT_REMOVED');
      expect(tables.service_contact_notification_prefs).toEqual([]);
      expect(tables.recipient_optin[0].status).toBe('pending');
    } finally {
      holder.service_contact_phone = original;
    }
  });

  test('rejects an unknown field, an unknown channel, and an empty body', async () => {
    expect((await put({ billingEmail: 'x@y.z' })).status).toBe(500);
    expect((await put({ enRouteChannel: 'push' })).status).toBe(500);
    expect((await put({})).status).toBe(500);
  });
});

describe('holder contact save prunes a removed contact\'s choices', () => {
  test('PUT /property-preferences/:id with a new list deletes the rows of phones no longer in a slot', async () => {
    tables.service_contact_notification_prefs.push(
      { customer_id: 'cust-1', phone_key: '9415550202', tech_en_route: false },
      { customer_id: 'cust-1', phone_key: '9415550303', tech_en_route: false },
    );
    mockSession.current = { customer: tables.customers[0], customerId: 'cust-1', accountId: 'cust-1', contactSession: null };
    const res = await call('PUT', '/api/notifications/property-preferences/cust-1', {
      serviceContacts: [{ firstName: 'Terry', lastName: 'Tenant', phone: '+19415550303', email: '' }],
      serviceContactsConsent: true,
    });
    expect(res.status).toBe(200);
    expect(tables.service_contact_notification_prefs).toEqual([
      expect.objectContaining({ phone_key: '9415550303' }),
    ]);
    // The removed phone's portal sessions end with it (codex r6 P2).
    expect(revokeRemovedContactRefreshSessions).toHaveBeenCalledWith(expect.anything(), 'cust-1', ['+19415550303']);
  });

  test('a kept contact who lost their email loses their email-only delivery choices (codex r6)', async () => {
    tables.service_contact_notification_prefs.push(
      { customer_id: 'cust-1', phone_key: '9415550202', en_route_channel: 'email', service_complete_channel: 'both' },
    );
    mockSession.current = { customer: tables.customers[0], customerId: 'cust-1', accountId: 'cust-1', contactSession: null };
    const res = await call('PUT', '/api/notifications/property-preferences/cust-1', {
      serviceContacts: [{ firstName: 'Sam', lastName: 'Spouse', phone: '+19415550202', email: '' }],
      serviceContactsConsent: true,
    });
    expect(res.status).toBe(200);
    expect(tables.service_contact_notification_prefs[0]).toEqual(expect.objectContaining({ en_route_channel: null, service_complete_channel: 'both' }));
  });

  test('the legacy single-contact save (serviceContact) prunes the replaced slot-1 person too, keeping slot 2/3 survivors (codex r2)', async () => {
    tables.service_contact_notification_prefs.push(
      { customer_id: 'cust-1', phone_key: '9415550202', tech_en_route: false, consent_attested_at: '2026-10-20T00:00:00Z' },
      { customer_id: 'cust-1', phone_key: '9415550303', tech_en_route: false },
    );
    mockSession.current = { customer: tables.customers[0], customerId: 'cust-1', accountId: 'cust-1', contactSession: null };
    const res = await call('PUT', '/api/notifications/property-preferences/cust-1', {
      serviceContact: { firstName: 'Nora', lastName: 'New', phone: '+19415550404', email: '' },
      serviceContactsConsent: true,
    });
    expect(res.status).toBe(200);
    expect(tables.service_contact_notification_prefs.map((r) => r.phone_key)).toEqual(['9415550303']);
  });
});
