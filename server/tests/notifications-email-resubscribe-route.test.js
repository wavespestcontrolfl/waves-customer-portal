'use strict';

// GATE_PORTAL_EMAIL_RESUBSCRIBE on the two "Email messages" switches:
//   holder   GET/PUT /api/notifications/preferences
//   contact  GET/PUT /api/notifications/contact-preferences
// Gate off: nothing changes (no read, no release, no SendGrid call). Gate on:
// a customer-made unsubscribe reads as OFF, an OFF save is always stored as
// before (it is an explicit opt-out), and an ON save releases the block inside the save's
// own transaction, but only after SendGrid's own list was cleared BEFORE that
// transaction, and only the rows SendGrid confirmed.
// The service's row rules are proven on real SQL in email-resubscribe-postgres.test.js.
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
  hasReleasableUnsubscribe: jest.fn(),
  releaseOwnUnsubscribes: jest.fn(),
  clearSendgridBeforeRelease: jest.fn(),
  normalizeEmail: (email) => String(email || '').trim().toLowerCase(),
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

// `blocked` = the set of addresses the service reports a customer-made unsubscribe for.
let blocked;
const CLEARED = { clearedIds: ['sup-1'], outcomes: [{ list: 'global', ok: true, status: 204 }], clearById: { 'sup-1': { ok: true, status: 204, at: '2026-11-04T12:00:00.000Z' } }, versionById: { 'sup-1': '555' } };
const NOT_CLEARED = { clearedIds: [], outcomes: [{ list: 'global', ok: false, status: 500 }], clearById: {} };
let preClear;
beforeEach(() => {
  tables = {
    customers: [{ ...HOLDER }],
    notification_prefs: [{ customer_id: 'cust-1' }],
    service_contact_notification_prefs: [],
    recipient_optin: [],
  };
  installDb();
  blocked = new Set(['pat@example.com', 'sam@example.com']);
  preClear = CLEARED;
  Resub.hasReleasableUnsubscribe.mockReset().mockImplementation(async (email) => blocked.has(email));
  Resub.releaseOwnUnsubscribes.mockReset().mockImplementation(async ({ email }) => { events.push('release'); return blocked.has(email) ? [{ id: 'sup-1', email, group_key: null }] : []; });
  Resub.clearSendgridBeforeRelease.mockReset().mockImplementation(async () => { events.push('sendgrid-clear'); return preClear; });
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
const holderPut = (body) => call('PUT', '/api/notifications/preferences', body);
const asContact = () => { mockSession.current = { ...mockSession.current, contactSession: SAM }; };
const contactGet = () => call('GET', '/api/notifications/contact-preferences');
const contactPut = (body) => call('PUT', '/api/notifications/contact-preferences', body);
const storedHolder = () => tables.notification_prefs[0].email_enabled;
const storedContact = () => (tables.service_contact_notification_prefs[0] || {}).email_enabled;

describe('account holder switch', () => {
  test('gate off: the payload is stored-only, and nothing is read, released or cleared', async () => {
    const res = await holderGet();
    expect(res.status).toBe(200);
    expect(res.body.emailEnabled).toBe(true);
    const put = await holderPut({ emailEnabled: true });
    expect(put.status).toBe(200);
    expect(Resub.hasReleasableUnsubscribe).not.toHaveBeenCalled();
    expect(Resub.releaseOwnUnsubscribes).not.toHaveBeenCalled();
    expect(Resub.clearSendgridBeforeRelease).not.toHaveBeenCalled();
    expect(storedHolder()).toBe(true);
  });

  test('gate on: GET shows OFF while the customer-made block stands; the stored value is untouched; other fields identical', async () => {
    const before = (await holderGet()).body;
    gateOn();
    const res = await holderGet();
    expect(Resub.hasReleasableUnsubscribe).toHaveBeenCalledWith('pat@example.com', expect.anything());
    expect(res.body.emailEnabled).toBe(false);
    expect({ ...res.body, emailEnabled: true }).toEqual(before);
    expect(storedHolder()).toBeUndefined();
  });

  test('gate on, no block: GET is unchanged', async () => {
    gateOn();
    blocked.clear();
    expect((await holderGet()).body.emailEnabled).toBe(true);
  });

  test('gate on: an ON save clears SendGrid BEFORE the transaction, then releases the confirmed rows inside it', async () => {
    gateOn();
    const res = await holderPut({ emailEnabled: true });
    expect(res.status).toBe(200);
    expect(Resub.clearSendgridBeforeRelease).toHaveBeenCalledWith('pat@example.com');
    expect(Resub.releaseOwnUnsubscribes).toHaveBeenCalledWith({
      email: 'pat@example.com', customerId: 'cust-1', actor: 'holder',
      onlyIds: ['sup-1'], versionById: { 'sup-1': '555' }, sendgridClear: CLEARED.clearById,
    }, { dbh: trx });
    expect(events).toEqual(['sendgrid-clear', 'tx-start', 'release', 'tx-end']);
    expect(storedHolder()).toBe(true);
  });

  test('gate on: a failed SendGrid clear releases nothing, still saves ON, and the next GET still shows OFF (retryable)', async () => {
    gateOn();
    preClear = NOT_CLEARED;
    const res = await holderPut({ emailEnabled: true });
    expect(res.status).toBe(200);
    expect(Resub.releaseOwnUnsubscribes).not.toHaveBeenCalled();
    expect(storedHolder()).toBe(true);
    expect((await holderGet()).body.emailEnabled).toBe(false);
    preClear = CLEARED;
    await holderPut({ emailEnabled: true });
    expect(Resub.releaseOwnUnsubscribes).toHaveBeenCalledTimes(1);
  });

  test('gate on: an address that changed between the clear and the lock releases nothing', async () => {
    gateOn();
    Resub.clearSendgridBeforeRelease.mockImplementationOnce(async () => { tables.customers[0].email = 'new@example.com'; return CLEARED; });
    expect((await holderPut({ emailEnabled: true })).status).toBe(200);
    expect(Resub.releaseOwnUnsubscribes).not.toHaveBeenCalled();
  });

  test('gate on, nothing to release: the ON save is as today', async () => {
    gateOn();
    blocked.clear();
    preClear = { clearedIds: [], outcomes: [], clearById: {} };
    expect((await holderPut({ emailEnabled: true })).status).toBe(200);
    expect(Resub.releaseOwnUnsubscribes).not.toHaveBeenCalled();
    expect(storedHolder()).toBe(true);
  });

  test('gate on, block present: an OFF save is stored as OFF (an explicit opt-out), releases nothing; a later ON save stores ON and still releases', async () => {
    gateOn();
    expect((await holderPut({ emailEnabled: false })).status).toBe(200);
    expect(storedHolder()).toBe(false);
    expect(Resub.clearSendgridBeforeRelease).not.toHaveBeenCalled();
    expect(Resub.releaseOwnUnsubscribes).not.toHaveBeenCalled();
    expect((await holderPut({ emailEnabled: true })).status).toBe(200);
    expect(storedHolder()).toBe(true);
    expect(Resub.releaseOwnUnsubscribes).toHaveBeenCalledTimes(1);
  });
});

describe('additional contact switch', () => {
  beforeEach(() => { asContact(); });

  test('gate off: nothing is read, released or cleared', async () => {
    expect((await contactGet()).body.preferences.emailEnabled).toBe(true);
    expect((await contactPut({ emailEnabled: true })).status).toBe(200);
    expect(Resub.hasReleasableUnsubscribe).not.toHaveBeenCalled();
    expect(Resub.releaseOwnUnsubscribes).not.toHaveBeenCalled();
    expect(Resub.clearSendgridBeforeRelease).not.toHaveBeenCalled();
  });

  test('gate on: GET shows OFF for a blocked address and leaves the other fields alone', async () => {
    const before = (await contactGet()).body;
    gateOn();
    const res = await contactGet();
    expect(Resub.hasReleasableUnsubscribe).toHaveBeenCalledWith('sam@example.com', expect.anything());
    expect(res.body.preferences.emailEnabled).toBe(false);
    expect({ ...res.body, preferences: { ...res.body.preferences, emailEnabled: true } }).toEqual(before);
    expect(storedContact()).toBeUndefined();
  });

  test('gate on: an ON save clears SendGrid for the CONTACT address BEFORE the lock transaction, then releases inside it', async () => {
    gateOn();
    const res = await contactPut({ emailEnabled: true });
    expect(res.status).toBe(200);
    expect(Resub.clearSendgridBeforeRelease).toHaveBeenCalledWith('sam@example.com');
    expect(Resub.releaseOwnUnsubscribes).toHaveBeenCalledWith({
      email: 'sam@example.com', customerId: 'cust-1', actor: 'contact', contactSlot: 1,
      onlyIds: ['sup-1'], versionById: { 'sup-1': '555' }, sendgridClear: CLEARED.clearById,
    }, { dbh: trx });
    expect(events).toEqual(['sendgrid-clear', 'tx-start', 'release', 'tx-end']);
    expect(storedContact()).toBe(true);
  });

  test('gate on: a failed SendGrid clear releases nothing, still saves ON, and the next GET still shows OFF', async () => {
    gateOn();
    preClear = NOT_CLEARED;
    expect((await contactPut({ emailEnabled: true })).status).toBe(200);
    expect(Resub.releaseOwnUnsubscribes).not.toHaveBeenCalled();
    expect(storedContact()).toBe(true);
    expect((await contactGet()).body.preferences.emailEnabled).toBe(false);
  });

  test('gate on: a contact address changed by the holder between the clear and the lock releases nothing', async () => {
    gateOn();
    mockSession.current = { ...mockSession.current, customer: { ...HOLDER } };
    Resub.clearSendgridBeforeRelease.mockImplementationOnce(async () => { tables.customers[0].service_contact_email = 'other@example.com'; return CLEARED; });
    expect((await contactPut({ emailEnabled: true })).status).toBe(200);
    expect(Resub.releaseOwnUnsubscribes).not.toHaveBeenCalled();
  });

  test('gate on, block present: an OFF save is stored as OFF (an explicit opt-out), releases nothing; a later ON save stores ON and still releases', async () => {
    gateOn();
    expect((await contactPut({ emailEnabled: false })).status).toBe(200);
    expect(storedContact()).toBe(false);
    expect(Resub.clearSendgridBeforeRelease).not.toHaveBeenCalled();
    expect(Resub.releaseOwnUnsubscribes).not.toHaveBeenCalled();
    expect((await contactPut({ emailEnabled: true })).status).toBe(200);
    expect(storedContact()).toBe(true);
    expect(Resub.releaseOwnUnsubscribes).toHaveBeenCalledTimes(1);
  });
});
