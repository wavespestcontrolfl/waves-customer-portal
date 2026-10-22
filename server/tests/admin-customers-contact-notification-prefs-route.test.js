/**
 * GET /api/admin/customers/:id/contact-notification-prefs and
 * PUT /api/admin/customers/:id/contact-notification-prefs/:slot — the
 * Customer 360 read-out and edit of an on-location contact's OWN
 * notification choices (contact login, GATE_CONTACT_LOGIN). Staff may
 * narrow (turn a purpose off, pick a delivery) but never turn texts on for a
 * contact who has not agreed in the app, and never stamp the attestation.
 * Same harness as admin-customers-property-preferences-route.test.js.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn(async () => {}) }));
jest.mock('../services/irrigation-weekly-email', () => ({ hasLawnServiceEvidence: jest.fn(async () => false), hasIrrigationEmailOptIn: jest.fn(async () => false) }));
jest.mock('../services/account-membership-email', () => ({ sendAccountUpdated: jest.fn(async () => ({ ok: true })) }));
// The technician assignment guard the GET shares with the profile and cards
// reads; flipped per test.
jest.mock('../services/technician-visit-scope', () => ({
  ...jest.requireActual('../services/technician-visit-scope'),
  technicianServicesCustomer: jest.fn(async () => true),
}));

const mockState = { customer: null, prefsRow: null, contactRows: [], optins: [] };

jest.mock('../models/db', () => {
  const table = (name) => {
    const conds = [];
    const q = {};
    const rowsOf = () => {
      if (name === 'customers') return mockState.customer ? [mockState.customer] : [];
      if (name === 'notification_prefs') return mockState.prefsRow ? [mockState.prefsRow] : [];
      if (name === 'service_contact_notification_prefs') return mockState.contactRows;
      if (name === 'recipient_optin') return mockState.optins;
      throw new Error(`Unexpected table ${name}`);
    };
    const matching = () => rowsOf().filter((r) => conds.every((c) => c(r)));
    q.where = jest.fn((obj) => { if (obj && typeof obj === 'object') conds.push((r) => Object.entries(obj).every(([k, v]) => String(r[k]) === String(v))); return q; });
    q.whereNull = jest.fn(() => q);
    q.whereNotNull = jest.fn(() => q);
    q.whereNotIn = jest.fn(() => q);
    q.first = jest.fn(async () => matching()[0] || null);
    q.select = jest.fn(async () => matching());
    q.update = jest.fn(async () => 0);
    q.insert = jest.fn((row) => ({
      onConflict: () => ({
        merge: async (patch) => {
          const existing = mockState.contactRows.find((r) => r.customer_id === row.customer_id && r.phone_key === row.phone_key);
          if (existing) Object.assign(existing, patch); else mockState.contactRows.push({ ...row });
          return [];
        },
      }),
    }));
    return q;
  };
  const dbFn = jest.fn((name) => table(name));
  dbFn.transaction = jest.fn(async (cb) => cb(Object.assign((name) => table(name), { isTransaction: true, raw: async () => {} })));
  dbFn.raw = jest.fn(async () => undefined);
  dbFn.fn = { now: jest.fn(() => new Date().toISOString()) };
  return dbFn;
});

const router = require('../routes/admin-customers');
const { recordAuditEvent } = require('../services/audit-log');
const { technicianServicesCustomer } = require('../services/technician-visit-scope');

async function run(method, path, { slot, body } = {}) {
  const layer = router.stack.find((e) => e.route?.path === path && e.route?.methods?.[method]);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const req = { params: { id: 'cust-1', ...(slot ? { slot: String(slot) } : {}) }, body, technicianId: 'admin-1', ip: '127.0.0.1', get: jest.fn(() => 'jest') };
  const result = { status: 200, body: null, error: null };
  const res = { status(c) { result.status = c; return res; }, json(p) { result.body = p; return res; } };
  await handler(req, res, (err) => { result.error = err; });
  if (result.error) throw result.error;
  return result;
}
const get = () => run('get', '/:id/contact-notification-prefs');
const put = (slot, body) => run('put', '/:id/contact-notification-prefs/:slot', { slot, body });

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GATE_CONTACT_LOGIN = 'true';
  mockState.customer = {
    id: 'cust-1', phone: '+19415550101', is_primary_profile: true, account_id: 'cust-1', contact_role: null,
    service_contact_name: 'Sam Spouse', service_contact_phone: '+19415550202', service_contact_email: 'sam@example.com', service_contact_role: null,
    service_contact2_name: 'Terry Tenant', service_contact2_phone: '+19415550303', service_contact2_email: null, service_contact2_role: 'tenant',
    service_contact3_name: null, service_contact3_phone: null, service_contact3_email: null, service_contact3_role: null,
  };
  mockState.prefsRow = { customer_id: 'cust-1', service_reminder_72h: false };
  mockState.contactRows = [];
  mockState.optins = [{ customer_id: 'cust-1', phone_key: '9415550303', status: 'pending' }];
});
afterEach(() => { delete process.env.GATE_CONTACT_LOGIN; });

describe('GET /:id/contact-notification-prefs', () => {
  test('lists every filled slot with effective choices, the holder\'s account-wide off, withheld reports and the opt-in state', async () => {
    mockState.contactRows = [{ customer_id: 'cust-1', phone_key: '9415550202', tech_en_route: false, en_route_channel: 'email', consent_attested_at: '2026-10-20T00:00:00Z' }];
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.live).toBe(true);
    expect(res.body.contacts).toHaveLength(2);
    const [sam, terry] = res.body.contacts;
    expect(sam).toMatchObject({ slot: 1, name: 'Sam Spouse', phone: '+19415550202', hasOwnChoices: true, emailAvailable: true, reportsWithheld: false, consentAttestedAt: '2026-10-20T00:00:00Z', smsOptin: 'none' });
    expect(sam.preferences).toMatchObject({ techEnRoute: false, enRouteChannel: 'email', serviceReminder72h: false, appointmentConfirmation: true, smsEnabled: true });
    expect(sam.accountOff.serviceReminder72h).toBe(true);
    expect(terry).toMatchObject({ slot: 2, hasOwnChoices: false, emailAvailable: false, reportsWithheld: true, contactRole: 'tenant', smsOptin: 'pending', consentAttestedAt: null });
    expect(terry.preferences.enRouteChannel).toBe('both');
  });

  test('gate off: the rows are still shown, flagged as not applied', async () => {
    delete process.env.GATE_CONTACT_LOGIN;
    const res = await get();
    expect(res.body.live).toBe(false);
    expect(res.body.contacts).toHaveLength(2);
  });

  test('unknown customer is a 404', async () => {
    mockState.customer = null;
    expect((await get()).status).toBe(404);
  });

  test('a technician reads a customer\'s contacts only when a visit is assigned to them: otherwise the same 404 as the profile read, before any row is read (codex security r1)', async () => {
    const db = require('../models/db');
    technicianServicesCustomer.mockResolvedValueOnce(false);
    expect((await get()).status).toBe(404);
    expect(technicianServicesCustomer).toHaveBeenCalledWith(expect.objectContaining({ params: { id: 'cust-1' } }), 'cust-1');
    expect(db).not.toHaveBeenCalledWith('customers');
  });
});

describe('PUT /:id/contact-notification-prefs/:slot', () => {
  test('narrowing (a purpose off, a delivery choice) upserts the slot\'s row and records an audit event with field names only', async () => {
    const res = await put(1, { techEnRoute: false, serviceCompleteChannel: 'email' });
    expect(res.status).toBe(200);
    expect(mockState.contactRows).toEqual([expect.objectContaining({ customer_id: 'cust-1', phone_key: '9415550202', tech_en_route: false, service_complete_channel: 'email' })]);
    expect(res.body.contacts[0].preferences).toMatchObject({ techEnRoute: false, serviceCompleteChannel: 'email' });
    expect(recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: 'customer.contact_notification_prefs.update', resource_id: 'cust-1', actor_id: 'admin-1',
      metadata: { slot: 1, fields: ['serviceCompleteChannel', 'techEnRoute'] },
    }));
  });

  test('turning texts ON for a contact who has not agreed in the app is refused; allowed once they have', async () => {
    mockState.contactRows = [{ customer_id: 'cust-1', phone_key: '9415550202', tech_en_route: false }];
    const refused = await put(1, { techEnRoute: true });
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe('CONSENT_REQUIRED');
    expect(mockState.contactRows[0].tech_en_route).toBe(false);
    mockState.contactRows[0].consent_attested_at = new Date('2026-10-19');
    const ok = await put(1, { techEnRoute: true });
    expect(ok.status).toBe(200);
    expect(mockState.contactRows[0].tech_en_route).toBe(true);
    // Staff never stamp the attestation themselves.
    expect(mockState.contactRows[0].consent_attested_at).toEqual(new Date('2026-10-19'));
  });

  test('email-only delivery needs an address; an empty slot, a bad slot and a bad body are refused', async () => {
    expect((await put(2, { enRouteChannel: 'email' })).status).toBe(400);
    expect((await put(3, { techEnRoute: false })).status).toBe(404);
    expect((await put(4, { techEnRoute: false })).status).toBe(400);
    expect((await put(1, {})).status).toBe(400);
    expect((await put(1, { consentAttested: true })).status).toBe(400);
    expect((await put(1, { enRouteChannel: 'push' })).status).toBe(400);
    expect(mockState.contactRows).toEqual([]);
  });
});
