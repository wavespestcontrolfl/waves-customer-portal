'use strict';

// GATE_PORTAL_EMAIL_RESUBSCRIBE on the account holder's notification routes:
//   GET  /api/notifications/preferences          adds emailResubscribe (never changes emailEnabled)
//   POST /api/notifications/email-resubscribe    asks for ONE "Turn Waves emails back on?" email
// Gate off: nothing changes (no read, no route). Contact sessions are out (403 / no field).
// The service rules (24 h limit, bounce block, hashed token) are proven on real SQL in
// email-resubscribe-postgres.test.js; here the service is mocked and the route wiring is checked.
//
// Real router + real express; the auth middleware is a stand-in.

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/account-membership-email', () => ({ sendAccountUpdated: jest.fn(() => Promise.resolve()) }));
jest.mock('../services/recipient-optin', () => ({
  onRecipientConfirmed: jest.fn(() => Promise.resolve()),
  noteHolderSetNotifyPrimary: jest.fn(() => Promise.resolve()),
  claimRecipientOptins: jest.fn(() => Promise.resolve([])),
}));
jest.mock('../services/service-contact-events', () => ({ recordServiceContactChanges: jest.fn(() => Promise.resolve()) }));
jest.mock('../services/email-resubscribe', () => ({
  resubscribeStatus: jest.fn(),
  requestResubscribeEmail: jest.fn(),
}));
const mockSession = { current: null };
jest.mock('../middleware/auth', () => ({
  authenticate: (req, _res, next) => { Object.assign(req, mockSession.current); next(); },
  revokeRemovedContactRefreshSessions: jest.fn(() => Promise.resolve(0)),
}));

const express = require('express');
const db = require('../models/db');
const Resub = require('../services/email-resubscribe');
const router = require('../routes/notifications');

// ── in-memory db ──────────────────────────────────────────────────────────
let tables;
let events;
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
let trx;
function installDb() {
  events = [];
  trx = Object.assign((table) => builder(table), { isTransaction: true, raw: async () => {} });
  trx.transaction = async (fn) => fn(trx);
  db.mockImplementation((table) => builder(table));
  db.transaction = async (fn) => { events.push('tx-start'); const out = await fn(trx); events.push('tx-end'); return out; };
  db.raw = async () => {};
  db.fn = { now: () => new Date() };
}

const HOLDER = {
  id: 'cust-1', account_id: 'cust-1', active: true, is_primary_profile: true, contact_role: null, deleted_at: null,
  phone: '+19415550101', email: 'pat@example.com', first_name: 'Pat',
  service_contact_name: 'Sam Spouse', service_contact_phone: '+19415550202', service_contact_email: 'sam@example.com', service_contact_role: null,
  service_contacts_consent_at: '2026-07-23T00:00:00Z',
};
const SAM = { slot: 1, name: 'Sam Spouse', phone: '+19415550202', email: 'sam@example.com', role: 'service_contact', contactRole: null, phoneKey: '9415550202' };

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
    notification_prefs: [{ customer_id: 'cust-1' }],
    service_contact_notification_prefs: [],
    recipient_optin: [],
  };
  installDb();
  Resub.resubscribeStatus.mockReset().mockResolvedValue({ state: 'paused', maskedEmail: 'p***@example.com' });
  Resub.requestResubscribeEmail.mockReset().mockResolvedValue({ state: 'sent', maskedEmail: 'p***@example.com', sentAt: '2026-11-04T12:00:00.000Z' });
  mockSession.current = { customer: tables.customers[0], customerId: 'cust-1', accountId: 'cust-1', contactSession: null };
  delete process.env.GATE_PORTAL_EMAIL_RESUBSCRIBE;
  process.env.GATE_CONTACT_LOGIN = 'true';
});
afterEach(() => { delete process.env.GATE_PORTAL_EMAIL_RESUBSCRIBE; delete process.env.GATE_CONTACT_LOGIN; });

async function call(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch { /* none */ }
  return { status: res.status, body: json || {} };
}
const gateOn = () => { process.env.GATE_PORTAL_EMAIL_RESUBSCRIBE = 'true'; };
const holderGet = () => call('GET', '/api/notifications/preferences');
const ask = () => call('POST', '/api/notifications/email-resubscribe');
const asContact = () => { mockSession.current = { ...mockSession.current, contactSession: SAM }; };

describe('GET /preferences: emailResubscribe', () => {
  test('gate off: the field is absent and the service is never read', async () => {
    const res = await holderGet();
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('emailResubscribe');
    expect(Resub.resubscribeStatus).not.toHaveBeenCalled();
  });

  test('gate on, paused: the field carries the masked address; emailEnabled and every other field are unchanged', async () => {
    const before = (await holderGet()).body;
    gateOn();
    const res = await holderGet();
    expect(Resub.resubscribeStatus).toHaveBeenCalledWith('pat@example.com', expect.anything());
    expect(res.body.emailResubscribe).toEqual({ state: 'paused', maskedEmail: 'p***@example.com' });
    const rest = { ...res.body };
    delete rest.emailResubscribe;
    expect(rest).toEqual(before);
    expect(rest.emailEnabled).toBe(true);
    expect(tables.notification_prefs[0].email_enabled).toBeUndefined();
  });

  test('gate on, sent: the field carries the sent state and time', async () => {
    gateOn();
    Resub.resubscribeStatus.mockResolvedValue({ state: 'sent', maskedEmail: 'p***@example.com', sentAt: '2026-11-04T12:00:00.000Z' });
    expect((await holderGet()).body.emailResubscribe).toEqual({ state: 'sent', maskedEmail: 'p***@example.com', sentAt: '2026-11-04T12:00:00.000Z' });
  });

  test('gate on, nothing paused (or the service reads nothing): the field is absent', async () => {
    gateOn();
    Resub.resubscribeStatus.mockResolvedValue(null);
    expect((await holderGet()).body).not.toHaveProperty('emailResubscribe');
  });

  test('gate on, a contact session: no field and no read', async () => {
    gateOn();
    asContact();
    const res = await holderGet();
    expect(res.body).not.toHaveProperty('emailResubscribe');
    expect(Resub.resubscribeStatus).not.toHaveBeenCalled();
  });

  test('gate on, a failing read never fails the screen', async () => {
    gateOn();
    Resub.resubscribeStatus.mockRejectedValue(new Error('boom'));
    const res = await holderGet();
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('emailResubscribe');
  });
});

describe('POST /email-resubscribe', () => {
  test('gate off: 404 { state: off } and nothing is read or sent', async () => {
    const res = await ask();
    expect(res).toEqual({ status: 404, body: { state: 'off' } });
    expect(Resub.requestResubscribeEmail).not.toHaveBeenCalled();
  });

  test('gate on, a contact session: 403 and nothing is sent', async () => {
    gateOn();
    asContact();
    const res = await ask();
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('HOLDER_SESSION_ONLY');
    expect(Resub.requestResubscribeEmail).not.toHaveBeenCalled();
  });

  test("gate on: asks for the holder's OWN address on file (never an address from the request) and returns the answer", async () => {
    gateOn();
    const res = await call('POST', '/api/notifications/email-resubscribe', { email: 'someone-else@example.com' });
    expect(res).toEqual({ status: 200, body: { state: 'sent', maskedEmail: 'p***@example.com', sentAt: '2026-11-04T12:00:00.000Z' } });
    expect(Resub.requestResubscribeEmail).toHaveBeenCalledWith(
      { customerId: 'cust-1', email: 'pat@example.com', firstName: 'Pat' }, { dbh: expect.anything() });
  });

  test.each([
    ['not_paused', { state: 'not_paused' }],
    ['failed', { state: 'failed' }],
  ])('gate on: %s is passed through', async (_name, answer) => {
    gateOn();
    Resub.requestResubscribeEmail.mockResolvedValue(answer);
    expect(await ask()).toEqual({ status: 200, body: answer });
  });

  test('gate on, no usable address on file: not_paused and nothing is sent', async () => {
    gateOn();
    tables.customers[0].email = '';
    expect(await ask()).toEqual({ status: 200, body: { state: 'not_paused' } });
    expect(Resub.requestResubscribeEmail).not.toHaveBeenCalled();
  });

  test('gate on: the 7th tap in ten minutes is a 429 and sends nothing more', async () => {
    gateOn();
    mockSession.current = { ...mockSession.current, customerId: 'cust-rate', customer: { ...HOLDER, id: 'cust-rate' } };
    tables.customers.push({ ...HOLDER, id: 'cust-rate' });
    const statuses = [];
    for (let i = 0; i < 7; i += 1) statuses.push((await ask()).status);
    expect(statuses).toEqual([200, 200, 200, 200, 200, 200, 429]);
    expect(Resub.requestResubscribeEmail).toHaveBeenCalledTimes(6);
  });

  test('gate on: a service error is a 500, not a send', async () => {
    gateOn();
    Resub.requestResubscribeEmail.mockRejectedValue(new Error('db down'));
    expect((await ask()).status).toBe(500);
  });
});

describe('the contact switch and the holder save are exactly as on main', () => {
  test('gate on: PUT /preferences stores emailEnabled as before and reads/sends nothing for resubscribe', async () => {
    gateOn();
    const res = await call('PUT', '/api/notifications/preferences', { emailEnabled: true });
    expect(res.status).toBe(200);
    expect(Resub.requestResubscribeEmail).not.toHaveBeenCalled();
    expect(tables.notification_prefs[0].email_enabled).toBe(true);
  });

  test('gate on: GET /contact-preferences has no emailResubscribe field', async () => {
    gateOn();
    asContact();
    const res = await call('GET', '/api/notifications/contact-preferences');
    expect(res.body).not.toHaveProperty('emailResubscribe');
    expect(Resub.resubscribeStatus).not.toHaveBeenCalled();
  });
});
