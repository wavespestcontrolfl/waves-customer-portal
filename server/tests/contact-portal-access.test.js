'use strict';

// Contact login (GATE_CONTACT_LOGIN): an on-location contact signs in with
// their OWN number through the SMS code login and holds a CONTACT session on
// the account holder's row — exactly the routes in CONTACT_SESSION_ROUTES
// (403 ACCOUNT_HOLDER_ONLY elsewhere, never a 401 that reads as a dead
// session), a narrowed /auth/me, a one-entry property list, and a refresh
// family that dies when the holder removes the contact or the gate goes off.
// The account holder's own number always wins the login.
//
// Same harness as cancelled-portal-read-access.test.js: real middleware +
// real /api/auth router, stand-in routers at their production prefixes.

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('express-rate-limit', () => () => (_req, _res, next) => next());
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('@sentry/node', () => ({ captureException: jest.fn() }));
jest.mock('../services/twilio', () => ({
  sendVerificationCode: jest.fn().mockResolvedValue({}),
  checkVerificationCode: jest.fn().mockResolvedValue({ success: true }),
}));
jest.mock('../services/customer-credit', () => ({
  getLedger: jest.fn().mockResolvedValue([]),
  portalCreditsFromLedger: jest.fn(() => []),
  round2: (n) => Math.round(Number(n || 0) * 100) / 100,
}));
jest.mock('../services/cancellation-resolution', () => ({
  cancelFlowV2Enabled: () => process.env.GATE_CANCEL_FLOW_V2 === 'true',
}));

const express = require('express');
const db = require('../models/db');
const auth = require('../middleware/auth');
const authRouter = require('../routes/auth');
const TwilioService = require('../services/twilio');

// ── in-memory db ──────────────────────────────────────────────────────────
let tables;
// Runs when a customers row is locked FOR UPDATE: stands in for a writer that
// committed between a login's lookup and its lock.
let onCustomersLock = null;
const norm = (col) => String(col).replace(/^[a-z]+\./, '');
const digitsOf = (v) => String(v || '').replace(/\D/g, '');
function builder(table) {
  const conds = [];
  const b = {};
  const rows = () => (tables[table] || []).filter((r) => conds.every((c) => c(r)));
  b.where = (a, op, val) => {
    if (typeof a === 'function') {
      // Grouped predicate: the contact lookup ORs the three slot columns.
      const group = [];
      const sub = {
        orWhereRaw: (sql, params) => {
          const col = (sql.match(/COALESCE\((\w+)/) || [])[1];
          const like = String(params[0]).replace(/%/g, '');
          group.push((r) => digitsOf(r[col]).endsWith(like));
          return sub;
        },
        where: () => sub,
        orWhere: () => sub,
      };
      a.call(sub);
      if (group.length) conds.push((r) => group.some((g) => g(r)));
      return b;
    }
    if (typeof a === 'object') Object.entries(a).forEach(([k, v]) => conds.push((r) => String(r[norm(k)]) === String(v)));
    else if (val === undefined) conds.push((r) => String(r[norm(a)]) === String(op));
    else conds.push((r) => String(r[norm(a)]) === String(val));
    return b;
  };
  b.whereNull = (col) => { conds.push((r) => r[norm(col)] == null); return b; };
  b.whereNotNull = (col) => { conds.push((r) => r[norm(col)] != null); return b; };
  b.whereIn = (col, vals) => { conds.push((r) => vals.map(String).includes(String(r[norm(col)]))); return b; };
  b.whereNotIn = (col, vals) => { conds.push((r) => !vals.map(String).includes(String(r[norm(col)]))); return b; };
  b.whereRaw = (sql, params) => {
    if (/regexp_replace/.test(sql)) {
      const like = String(params[0]).replace(/%/g, '');
      conds.push((r) => digitsOf(r.phone).endsWith(like));
    }
    return b;
  };
  const orders = [];
  b.orderBy = (col, dir) => { orders.push([norm(col), dir === 'desc' ? 'desc' : 'asc']); return b; };
  const sorted = () => {
    const list = rows();
    if (!orders.length) return list;
    const rank = (v) => (v === true ? 1 : v === false ? 0 : v);
    return [...list].sort((x, y) => {
      for (const [col, dir] of orders) {
        const a = rank(x[col]); const c = rank(y[col]);
        const aNull = a == null; const cNull = c == null;
        let cmp = 0;
        if (aNull && cNull) cmp = 0;
        else if (aNull) cmp = 1;
        else if (cNull) cmp = -1;
        else cmp = a > c ? 1 : a < c ? -1 : 0;
        if (cmp !== 0) return dir === 'desc' ? -cmp : cmp;
      }
      return 0;
    });
  };
  b.orderByRaw = () => b;
  b.leftJoin = () => b;
  b.select = () => b;
  b.limit = () => b;
  b.forUpdate = () => { if (table === 'customers' && onCustomersLock) onCustomersLock(); return b; };
  b.first = async () => sorted()[0] || null;
  b.pluck = async (col) => sorted().map((r) => r[norm(col)]);
  b.update = async (patch) => { const hit = rows(); hit.forEach((r) => Object.assign(r, patch)); return hit.length; };
  b.insert = (row) => {
    const list = (tables[table] ||= []);
    const inserted = { ...row };
    list.push(inserted);
    const ret = { returning: async () => [inserted] };
    return Object.assign(Promise.resolve([inserted]), ret, { onConflict: () => ({ ignore: () => ret }) });
  };
  b.then = (resolve, reject) => Promise.resolve(sorted()).then(resolve, reject);
  return b;
}
function installDb() {
  db.mockImplementation((table) => builder(table));
  db.transaction = async (fn) => fn((table) => builder(table));
  db.schema = { hasTable: async () => false };
  db.fn = { now: () => new Date() };
}

const HOLDER_PHONE = '+19415550101';
const CONTACT_PHONE = '+19415550202';
const TENANT_PHONE = '+19415550303';
const HOLDER = {
  id: 'cust-holder', account_id: 'cust-holder', active: true, pipeline_stage: 'active_customer', deleted_at: null,
  first_name: 'Pat', last_name: 'Owner', phone: HOLDER_PHONE, email: 'pat@example.com',
  is_primary_profile: true, profile_label: 'Primary', monthly_rate: '120.00', waveguard_tier: 'gold',
  referral_code: 'PAT123', account_credits: 40, member_since: '2025-01-01', created_at: '2025-01-01',
  address_line1: '1 Gulf Dr', city: 'Bradenton', state: 'FL', zip: '34205', contact_role: null,
  service_contact_name: 'Sam Spouse', service_contact_phone: CONTACT_PHONE, service_contact_email: 'sam@example.com', service_contact_role: null,
  service_contact2_name: 'Terry Tenant', service_contact2_phone: TENANT_PHONE, service_contact2_email: null, service_contact2_role: 'tenant',
  service_contact3_name: null, service_contact3_phone: null, service_contact3_email: null, service_contact3_role: null,
  service_contacts_consent_at: '2026-07-23T00:00:00Z',
};

// ── app: real /api/auth + stand-in routers ───────────────────────────────
const ECHO = (req, res) => res.json({ ok: true, contact: req.contactSession ? req.contactSession.slot : null, id: req.customerId });
function standIn(paths) {
  const r = express.Router();
  r.use(auth.authenticate);
  for (const [method, path] of paths) r[method.toLowerCase()](path, ECHO);
  return r;
}
let server;
let baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  app.use('/api/billing', standIn([['GET', '/'], ['GET', '/balance'], ['GET', '/cards'], ['POST', '/cards']]));
  app.use('/api/billing/autopay', standIn([['GET', '/'], ['PUT', '/']]));
  app.use('/api/schedule', standIn([['GET', '/'], ['GET', '/next'], ['GET', '/account-next'], ['GET', '/properties-next'], ['POST', '/:id/confirm'], ['POST', '/:id/reschedule']]));
  app.use('/api/services', standIn([['GET', '/'], ['GET', '/stats/summary'], ['GET', '/:id']]));
  app.use('/api/documents', standIn([['GET', '/'], ['GET', '/service-report/:id'], ['GET', '/:id/download'], ['POST', '/share/:id']]));
  app.use('/api/tracking', standIn([['GET', '/active'], ['GET', '/today'], ['GET', '/maps-key'], ['POST', '/:id/note']]));
  app.use('/api/property', standIn([['GET', '/termite-bond'], ['GET', '/preferences']]));
  app.use('/api/notifications', standIn([['GET', '/preferences'], ['PUT', '/preferences'], ['GET', '/property-preferences'], ['PUT', '/property-preferences/:id'], ['GET', '/contact-preferences'], ['PUT', '/contact-preferences']]));
  app.use('/api/requests', standIn([['POST', '/restart-plan'], ['GET', '/'], ['POST', '/']]));
  app.use('/api/referrals', standIn([['GET', '/']]));
  app.use('/api/push', standIn([['POST', '/native-subscribe'], ['POST', '/native-unsubscribe'], ['GET', '/status']]));
  app.use('/api/customer-notifications', standIn([['GET', '/unread-count']]));
  app.use('/api/customer/activity', standIn([['POST', '/page-view'], ['POST', '/heartbeat'], ['POST', '/push-open']]));
  app.use('/api/ai', standIn([['POST', '/chat']]));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  server = app.listen(0, '127.0.0.1', () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});
afterAll((done) => { server.close(done); });

beforeEach(() => {
  tables = {
    customers: [{ ...HOLDER }],
    customer_accounts: [{ id: 'cust-holder' }],
    customer_refresh_tokens: [],
    notification_prefs: [],
  };
  installDb();
  TwilioService.sendVerificationCode.mockClear();
  process.env.GATE_CONTACT_LOGIN = 'true';
});
afterEach(() => { delete process.env.GATE_CONTACT_LOGIN; });

async function call(method, path, headers = {}, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* none */ }
  return { status: res.status, body: json || {} };
}
const login = (phone) => call('POST', '/api/auth/verify-code', {}, { phone, code: '123456' });
const bearerOf = (token) => ({ Authorization: `Bearer ${token}` });

const CONTACT_READS = [
  ['GET', '/api/auth/me'], ['GET', '/api/auth/properties'],
  ['GET', '/api/schedule?days=90'], ['GET', '/api/schedule/next'],
  ['GET', '/api/services?limit=20'], ['GET', '/api/services/svc-1'], ['GET', '/api/services/stats/summary'],
  ['GET', '/api/documents'], ['GET', '/api/documents/service-report/svc-1'], ['GET', '/api/documents/doc-1/download'],
  ['GET', '/api/tracking/active'], ['GET', '/api/tracking/today'], ['GET', '/api/tracking/maps-key'],
  ['GET', '/api/notifications/contact-preferences'], ['PUT', '/api/notifications/contact-preferences'],
  ['POST', '/api/customer/activity/page-view'], ['POST', '/api/customer/activity/heartbeat'], ['POST', '/api/customer/activity/push-open'],
  // Token-scoped release of this device's holder registration on contact login (codex r4).
  ['POST', '/api/push/native-unsubscribe'],
];
const HOLDER_ONLY = [
  ['GET', '/api/billing'], ['GET', '/api/billing/balance'], ['GET', '/api/billing/cards'], ['POST', '/api/billing/cards'],
  ['GET', '/api/billing/autopay'], ['PUT', '/api/billing/autopay'],
  ['POST', '/api/schedule/svc-1/confirm'], ['POST', '/api/schedule/svc-1/reschedule'],
  // The account's other profiles / saved houses are not a contact's to list.
  ['GET', '/api/schedule/account-next'], ['GET', '/api/schedule/properties-next'],
  ['POST', '/api/documents/share/doc-1'],
  ['POST', '/api/tracking/svc-1/note'],
  ['GET', '/api/property/termite-bond'], ['GET', '/api/property/preferences'],
  ['GET', '/api/notifications/preferences'], ['PUT', '/api/notifications/preferences'],
  ['GET', '/api/notifications/property-preferences'], ['PUT', '/api/notifications/property-preferences/cust-holder'],
  ['POST', '/api/requests/restart-plan'], ['GET', '/api/requests'], ['POST', '/api/requests'],
  ['GET', '/api/referrals'],
  ['POST', '/api/push/native-subscribe'], ['GET', '/api/push/status'],
  ['GET', '/api/customer-notifications/unread-count'],
  ['POST', '/api/ai/chat'],
  ['POST', '/api/auth/select-property'], ['PUT', '/api/auth/credit-preference'], ['DELETE', '/api/auth/account'],
];

describe('contact login — who a number signs in as', () => {
  test('a contact number logs into the holder\'s row as a contact session; verify-code says so', async () => {
    const res = await login(CONTACT_PHONE);
    expect(res.status).toBe(200);
    expect(res.body.customer.id).toBe('cust-holder');
    expect(res.body.actor).toEqual({ kind: 'contact', slot: 1, name: 'Sam Spouse', phone: CONTACT_PHONE, email: 'sam@example.com' });
    // The login response's identity is the CONTACT's, never the holder's
    // (codex round 1): the holder's name, number and email stay off the
    // contact's device.
    expect(res.body.customer).toMatchObject({ firstName: 'Sam', lastName: 'Spouse', phone: CONTACT_PHONE, email: 'sam@example.com' });
    expect(JSON.stringify(res.body)).not.toMatch(/Pat|Owner|pat@example\.com|9415550101/);
    expect(res.body.properties.map((p) => p.id)).toEqual(['cust-holder']);
  });

  test('the holder removing the contact between the OTP check and the mint leaves no session: 401, no family written, nothing of the property returned (codex r10 P2)', async () => {
    onCustomersLock = () => {
      Object.assign(tables.customers[0], { service_contact_name: null, service_contact_phone: null, service_contact_email: null });
      onCustomersLock = null;
    };
    const res = await login(CONTACT_PHONE);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid or expired verification code' });
    expect(tables.customer_refresh_tokens).toEqual([]);
    // The holder's own login is minted without the slot check.
    expect((await login(HOLDER_PHONE)).status).toBe(200);
  });

  test('send-code actually sends to a contact number (both login steps use the same resolver)', async () => {
    const res = await call('POST', '/api/auth/send-code', {}, { phone: CONTACT_PHONE });
    expect(res.status).toBe(200);
    expect(TwilioService.sendVerificationCode).toHaveBeenCalledWith(CONTACT_PHONE);
  });

  test('the holder\'s own number is a holder session, never a contact one', async () => {
    const res = await login(HOLDER_PHONE);
    expect(res.status).toBe(200);
    expect(res.body.actor).toEqual({ kind: 'holder' });
    const me = await call('GET', '/api/auth/me', bearerOf(res.body.token));
    expect(me.body.actor).toEqual({ kind: 'holder' });
    expect(me.body.referralCode).toBe('PAT123');
  });

  test('a number that is BOTH a holder elsewhere and a contact here signs in as the holder', async () => {
    tables.customers.push({
      ...HOLDER, id: 'cust-sam', account_id: 'cust-sam', phone: CONTACT_PHONE, first_name: 'Sam', referral_code: 'SAM1',
      service_contact_name: null, service_contact_phone: null, service_contact2_name: null, service_contact2_phone: null, service_contact2_role: null,
    });
    tables.customer_accounts.push({ id: 'cust-sam' });
    const res = await login(CONTACT_PHONE);
    expect(res.status).toBe(200);
    expect(res.body.customer.id).toBe('cust-sam');
    expect(res.body.actor).toEqual({ kind: 'holder' });
  });

  test('a contact on several rows lands on the primary profile, then the oldest', async () => {
    tables.customers.push({ ...HOLDER, id: 'cust-rental', account_id: 'cust-holder', is_primary_profile: false, created_at: '2024-01-01' });
    const res = await login(CONTACT_PHONE);
    expect(res.body.customer.id).toBe('cust-holder');
    tables.customers.find((c) => c.id === 'cust-holder').is_primary_profile = false;
    const again = await login(CONTACT_PHONE);
    expect(again.body.customer.id).toBe('cust-rental');
  });

  test('a contact on an INACTIVE (churned) row never logs in, with or without the cancelled allowance', async () => {
    process.env.GATE_CANCEL_FLOW_V2 = 'true';
    Object.assign(tables.customers[0], { active: false, pipeline_stage: 'churned' });
    const res = await login(CONTACT_PHONE);
    expect(res.status).toBe(401);
    delete process.env.GATE_CANCEL_FLOW_V2;
  });

  test('only a number the holder attested to logs in: an inferred, unconsented slot phone (or an unstamped account) is unknown (codex r4 security)', async () => {
    // The call pipeline filed this number without the holder's attestation
    // covering it (#5467): held out of texts until their own YES, and out of login.
    tables.customers[0].service_preferences = JSON.stringify({ unconsented_slot_phone_keys: ['9415550202'] });
    await call('POST', '/api/auth/send-code', {}, { phone: CONTACT_PHONE });
    expect(TwilioService.sendVerificationCode).not.toHaveBeenCalled();
    expect((await login(CONTACT_PHONE)).status).toBe(401);
    // The other, attested contact on the row still signs in.
    expect((await login(TENANT_PHONE)).status).toBe(200);
    // No attestation on the account at all: no contact logs in.
    tables.customers[0].service_preferences = null;
    tables.customers[0].service_contacts_consent_at = null;
    expect((await login(TENANT_PHONE)).status).toBe(401);
    expect((await login(HOLDER_PHONE)).status).toBe(200);
    // The SMS fan-out rollback switch (DISABLE_CONTACT_CONSENT_GATE=1) is
    // not an attestation: it must not open the login (codex r6 P1).
    process.env.DISABLE_CONTACT_CONSENT_GATE = '1';
    try {
      expect((await login(TENANT_PHONE)).status).toBe(401);
    } finally {
      delete process.env.DISABLE_CONTACT_CONSENT_GATE;
    }
  });

  test('a live contact session ends when its number becomes unconsented (401), like a removed slot', async () => {
    const { body } = await login(CONTACT_PHONE);
    expect((await call('GET', '/api/auth/me', bearerOf(body.token))).status).toBe(200);
    tables.customers[0].service_preferences = JSON.stringify({ unconsented_slot_phone_keys: ['9415550202'] });
    expect((await call('GET', '/api/auth/me', bearerOf(body.token))).status).toBe(401);
  });

  test('gate off: a contact number is unknown at send-code and refused at verify-code; the holder still logs in', async () => {
    delete process.env.GATE_CONTACT_LOGIN;
    await call('POST', '/api/auth/send-code', {}, { phone: CONTACT_PHONE });
    expect(TwilioService.sendVerificationCode).not.toHaveBeenCalled();
    expect((await login(CONTACT_PHONE)).status).toBe(401);
    expect((await login(HOLDER_PHONE)).status).toBe(200);
  });
});

describe('contact session — route allow-list', () => {
  let token;
  beforeEach(async () => { token = (await login(CONTACT_PHONE)).body.token; });

  test.each(CONTACT_READS)('%s %s is admitted as a contact session', async (method, path) => {
    const res = await call(method, path, bearerOf(token), method === 'GET' ? undefined : {});
    expect(res.status).toBe(200);
    if (path.startsWith('/api/auth/me')) {
      expect(res.body.actor.kind).toBe('contact');
      expect(res.body.firstName).toBe('Sam');
      expect(res.body.lastName).toBe('Spouse');
      expect(res.body.phone).toBe(CONTACT_PHONE);
      expect(res.body.address.line1).toBe('1 Gulf Dr');
      // Nothing the Billing / Refer tabs render from, and not the holder's
      // plan tier (codex r6 P2).
      for (const key of ['referralCode', 'accountCredit', 'credits', 'annualPrepay', 'monthlyRate', 'autoApplyAccountCredit', 'tier']) {
        expect(res.body).not.toHaveProperty(key);
      }
      expect(res.body.notificationPrefs).toBeNull();
      expect(res.body.propertyScope).toEqual({ enabled: false, propertyId: null, closed: false });
    } else if (path.startsWith('/api/auth/properties')) {
      expect(res.body.properties.map((p) => p.id)).toEqual(['cust-holder']);
      // Label + address only: no holder name, no rate, no tier.
      expect(JSON.stringify(res.body)).not.toMatch(/Pat|Owner|120|gold/);
      expect(res.body.properties[0]).not.toHaveProperty('tier');
    } else {
      expect(res.body).toEqual({ ok: true, contact: 1, id: 'cust-holder' });
    }
  });

  test.each(HOLDER_ONLY)('%s %s answers 403 ACCOUNT_HOLDER_ONLY (not a dead-session 401)', async (method, path) => {
    const res = await call(method, path, bearerOf(token), ['POST', 'PUT'].includes(method) ? {} : undefined);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ACCOUNT_HOLDER_ONLY');
  });

  test('the holder reaches every holder-only route exactly as before', async () => {
    const holderToken = (await login(HOLDER_PHONE)).body.token;
    const res = await call('GET', '/api/billing/cards', bearerOf(holderToken));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, contact: null, id: 'cust-holder' });
  });

  test('is exact on paths (a sibling route is not admitted by prefix)', () => {
    const { contactSessionRoute } = auth._test;
    expect(contactSessionRoute({ method: 'GET', baseUrl: '/api/schedule', path: '/' })).toBe(true);
    expect(contactSessionRoute({ method: 'GET', baseUrl: '/api/schedule', path: '/next/extra' })).toBe(false);
    expect(contactSessionRoute({ method: 'GET', baseUrl: '/api/services', path: '/svc-1' })).toBe(true);
    expect(contactSessionRoute({ method: 'GET', baseUrl: '/api/services', path: '/svc-1/photos' })).toBe(false);
    expect(contactSessionRoute({ method: 'POST', baseUrl: '/api/schedule', path: '/' })).toBe(false);
  });
});

describe('contact session — lifecycle', () => {
  test('the refresh token rotates and the new access token is still a contact session', async () => {
    const first = await login(CONTACT_PHONE);
    const refreshed = await call('POST', '/api/auth/refresh', {}, { refreshToken: first.body.refreshToken });
    expect(refreshed.status).toBe(200);
    const me = await call('GET', '/api/auth/me', bearerOf(refreshed.body.token));
    expect(me.status).toBe(200);
    expect(me.body.actor.kind).toBe('contact');
    const billing = await call('GET', '/api/billing', bearerOf(refreshed.body.token));
    expect(billing.status).toBe(403);
  });

  test('the holder removing the contact ends the session: requests 401, refresh refused, and the family is dead even once the number is re-added', async () => {
    const first = await login(CONTACT_PHONE);
    const slot = { service_contact_name: 'Sam Spouse', service_contact_phone: CONTACT_PHONE, service_contact_email: 'sam@example.com' };
    Object.assign(tables.customers[0], { service_contact_name: null, service_contact_phone: null, service_contact_email: null });
    expect((await call('GET', '/api/auth/me', bearerOf(first.body.token))).status).toBe(401);
    expect((await call('POST', '/api/auth/refresh', {}, { refreshToken: first.body.refreshToken })).status).toBe(401);
    // The refused exchange revoked the family (codex r6 P2): re-adding the
    // same number does not revive the removed device's token.
    expect(tables.customer_refresh_tokens.every((r) => r.revoked_at && r.revoke_reason === 'contact_removed')).toBe(true);
    Object.assign(tables.customers[0], slot);
    expect((await call('POST', '/api/auth/refresh', {}, { refreshToken: first.body.refreshToken })).status).toBe(401);
    // A fresh OTP login works again.
    expect((await login(CONTACT_PHONE)).status).toBe(200);
  });

  test('the holder\'s contact save revokes the families of the phones it removed, by the contact key the family was minted with', async () => {
    const contact = await login(CONTACT_PHONE);
    const tenant = await login(TENANT_PHONE);
    const holder = await login(HOLDER_PHONE);
    expect(tables.customer_refresh_tokens.map((r) => r.contact_key)).toEqual(['9415550202', '9415550303', null]);
    // Slot 1 removed, the tenant kept (the save path prunes by the kept phones).
    await auth.revokeRemovedContactRefreshSessions((table) => builder(table), 'cust-holder', [TENANT_PHONE]);
    Object.assign(tables.customers[0], { service_contact_name: null, service_contact_phone: null, service_contact_email: null });
    expect((await call('POST', '/api/auth/refresh', {}, { refreshToken: contact.body.refreshToken })).status).toBe(401);
    expect((await call('POST', '/api/auth/refresh', {}, { refreshToken: tenant.body.refreshToken })).status).toBe(200);
    expect((await call('POST', '/api/auth/refresh', {}, { refreshToken: holder.body.refreshToken })).status).toBe(200);
  });

  test('a still-valid ACCESS token of a revoked family is refused on every request, even once the number is back in a slot (codex r8 P2)', async () => {
    const contact = await login(CONTACT_PHONE);
    const holder = await login(HOLDER_PHONE);
    expect((await call('GET', '/api/auth/me', bearerOf(contact.body.token))).status).toBe(200);
    // The holder removed the contact (family revoked by the save) and re-added
    // the same number before the 15-minute access token expired.
    await auth.revokeRemovedContactRefreshSessions((table) => builder(table), 'cust-holder', [TENANT_PHONE]);
    expect((await call('GET', '/api/auth/me', bearerOf(contact.body.token))).status).toBe(401);
    expect((await call('GET', '/api/schedule?days=90', bearerOf(contact.body.token))).status).toBe(401);
    expect((await call('GET', '/api/auth/me', bearerOf(holder.body.token))).status).toBe(200);
    // A fresh OTP login mints a new family and works.
    expect((await call('GET', '/api/auth/me', bearerOf((await login(CONTACT_PHONE)).body.token))).status).toBe(200);
  });

  test('the contact moving to another slot keeps the session (the claim is the phone, not the slot)', async () => {
    const first = await login(CONTACT_PHONE);
    Object.assign(tables.customers[0], {
      service_contact_name: 'Terry Tenant', service_contact_phone: TENANT_PHONE, service_contact_role: 'tenant',
      service_contact2_name: 'Sam Spouse', service_contact2_phone: CONTACT_PHONE, service_contact2_role: null,
    });
    const me = await call('GET', '/api/auth/me', bearerOf(first.body.token));
    expect(me.status).toBe(200);
    expect(me.body.actor.slot).toBe(2);
  });

  test('gate off: an existing contact token is refused (401) and cannot refresh; a holder token is untouched', async () => {
    const contact = await login(CONTACT_PHONE);
    const holder = await login(HOLDER_PHONE);
    delete process.env.GATE_CONTACT_LOGIN;
    expect((await call('GET', '/api/auth/me', bearerOf(contact.body.token))).status).toBe(401);
    expect((await call('POST', '/api/auth/refresh', {}, { refreshToken: contact.body.refreshToken })).status).toBe(401);
    expect((await call('GET', '/api/auth/me', bearerOf(holder.body.token))).status).toBe(200);
  });

  test('a contact token cannot switch profiles (no select-property), and a forged claim on a non-contact number is refused', async () => {
    const forged = auth.generateToken('cust-holder', 'cust-holder', 'fam-x', { contactKey: '9415559999' });
    expect((await call('GET', '/api/auth/me', bearerOf(forged))).status).toBe(401);
    // The holder's own number as a "contact" claim is refused too.
    const holderAsContact = auth.generateToken('cust-holder', 'cust-holder', 'fam-x', { contactKey: HOLDER_PHONE.slice(-10) });
    expect((await call('GET', '/api/auth/me', bearerOf(holderAsContact))).status).toBe(401);
  });

  test('a contact bearer is not a verified customer for public booking flows (resolveBearerCustomer)', async () => {
    const contact = await login(CONTACT_PHONE);
    const resolved = await auth.resolveBearerCustomer({ headers: { authorization: `Bearer ${contact.body.token}` } });
    expect(resolved).toBeNull();
    const holder = await login(HOLDER_PHONE);
    const holderResolved = await auth.resolveBearerCustomer({ headers: { authorization: `Bearer ${holder.body.token}` } });
    expect(holderResolved?.id).toBe('cust-holder');
  });
});
