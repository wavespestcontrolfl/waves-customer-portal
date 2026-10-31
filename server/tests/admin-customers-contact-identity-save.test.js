/**
 * PUT /admin/customers/:id — contact-family reconciliation (contact login,
 * GATE_CONTACT_LOGIN). A save that rewrites a contact slot OR the holder's own
 * number re-judges the row's contact notification choices and refresh
 * families in the same transaction, after the customers UPDATE (the revoker
 * reads the committed holder phone through the transaction). A holder-phone
 * change matters because a number the holder now owns is no contact's (codex
 * #6363 r35 P2): its family must end with this edit. An unrelated save, or
 * the same number in another format, runs none of it.
 */
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../services/customer-contact-fanout', () => {
  const actual = jest.requireActual('../services/customer-contact-fanout');
  return Object.fromEntries(Object.keys(actual).map((k) => [k, typeof actual[k] === 'function' ? jest.fn(async () => ({})) : actual[k]]));
});
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn(async () => {}) }));
jest.mock('../services/plan-rate-ledger', () => ({ syncScalarWriteToLedger: jest.fn(async () => {}) }));
jest.mock('../services/contact-notification-prefs', () => ({
  ...jest.requireActual('../services/contact-notification-prefs'),
  pruneContactNotificationPrefs: jest.fn(async () => 0),
}));
jest.mock('../middleware/auth', () => ({
  ...jest.requireActual('../middleware/auth'),
  revokeRemovedContactRefreshSessions: jest.fn(async () => 0),
  revokeContactRefreshFamilies: jest.fn(async () => 0),
}));

const mockState = { initial: null, locked: null, patches: [], ops: [] };

jest.mock('../models/db', () => {
  const build = (table, inTransaction = false) => {
    const query = { lockedRead: false };
    for (const method of ['where', 'whereNull', 'whereNot', 'whereRaw']) {
      query[method] = () => query;
    }
    query.select = () => {
      const chained = Object.create(query);
      chained.then = (resolve, reject) => Promise.resolve([]).then(resolve, reject);
      return chained;
    };
    query.forUpdate = () => { query.lockedRead = true; return query; };
    query.first = async () => {
      if (table !== 'customers') return null;
      return inTransaction && query.lockedRead ? { ...mockState.locked } : { ...mockState.initial };
    };
    query.update = async (patch) => {
      mockState.patches.push({ ...patch });
      mockState.ops.push('customers.update');
      Object.assign(mockState.locked, patch);
      return 1;
    };
    return query;
  };
  const db = jest.fn((table) => build(table));
  db.transaction = jest.fn(async (fn) => {
    const trx = jest.fn((table) => build(table, true));
    trx.raw = jest.fn(async () => ({ rows: [] }));
    return fn(trx);
  });
  db.raw = jest.fn(async () => ({ rows: [] }));
  db.schema = { hasTable: jest.fn(async () => true), hasColumn: jest.fn(async () => true) };
  return db;
});

const router = require('../routes/admin-customers');
const { pruneContactNotificationPrefs } = require('../services/contact-notification-prefs');
const { revokeRemovedContactRefreshSessions } = require('../middleware/auth');

const HOLDER_PHONE = '+19415550100';
const CONTACT_PHONE = '+19415550202';
const BASE = {
  id: 'customer-1',
  account_id: 'account-1',
  first_name: 'Test',
  last_name: 'Customer',
  phone: HOLDER_PHONE,
  service_contact_name: 'Sam Spouse',
  service_contact_phone: CONTACT_PHONE,
  service_contact_email: 'sam@example.com',
  active: true,
  pipeline_stage: 'active_customer',
  waveguard_tier: 'Bronze',
  waveguard_tier_source: 'auto',
  monthly_rate: 0,
  billing_mode: 'per_visit',
  deleted_at: null,
};

async function saveCustomer(body) {
  const layer = router.stack.find((entry) => entry.route?.path === '/:id' && entry.route?.methods?.put);
  if (!layer) throw new Error('PUT /:id route not registered');
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const req = { params: { id: 'customer-1' }, body, technicianId: 'admin-1', ip: '127.0.0.1', get: jest.fn(() => 'jest') };
  const result = { status: 200, body: null, error: null };
  const res = {
    status(code) { result.status = code; return res; },
    json(payload) { result.body = payload; return res; },
  };
  await handler(req, res, (error) => { result.error = error; });
  if (result.error) throw result.error;
  return result;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockState.initial = { ...BASE };
  mockState.locked = { ...BASE };
  mockState.patches = [];
  mockState.ops = [];
  revokeRemovedContactRefreshSessions.mockImplementation(async () => { mockState.ops.push('revoke'); return 0; });
});

describe('PUT /admin/customers/:id — contact-family reconciliation', () => {
  test('the holder taking a slot number as their own re-judges the contact families, after the customers UPDATE', async () => {
    const response = await saveCustomer({ phone: CONTACT_PHONE });
    expect(response).toMatchObject({ status: 200, body: { success: true } });
    expect(mockState.patches[0]).toMatchObject({ phone: expect.any(String) });
    expect(pruneContactNotificationPrefs).toHaveBeenCalledWith(expect.anything(), 'customer-1', [expect.objectContaining({ phone: CONTACT_PHONE })]);
    expect(revokeRemovedContactRefreshSessions).toHaveBeenCalledWith(expect.anything(), 'customer-1', [CONTACT_PHONE]);
    expect(mockState.ops).toEqual(['customers.update', 'revoke']);
  });

  test('a slot rewrite still runs it, with the slots as saved', async () => {
    await saveCustomer({ serviceContactPhone: '+19415550303' });
    expect(revokeRemovedContactRefreshSessions).toHaveBeenCalledWith(expect.anything(), 'customer-1', ['+19415550303']);
  });

  test('the holder\'s number in another format, or a save touching neither the phone nor a slot, runs none of it', async () => {
    await saveCustomer({ phone: '(941) 555-0100' });
    await saveCustomer({ firstName: 'Tess' });
    expect(pruneContactNotificationPrefs).not.toHaveBeenCalled();
    expect(revokeRemovedContactRefreshSessions).not.toHaveBeenCalled();
  });
});

// Customers audit C13: the additional service contacts take the primary
// contact's normalization and refuse a changed bad value as a field error,
// before anything is written. The editor posts every slot, so a stored value
// echoed unchanged is never re-judged.
describe('PUT /admin/customers/:id — service-contact values', () => {
  test.each([
    ['a short phone', { serviceContact2Phone: '555-12' }, 'serviceContact2Phone', '555-12 is not a valid phone number for Service contact 2.'],
    ['an impossible US number', { serviceContactPhone: '(041) 555-0303' }, 'serviceContactPhone', '(041) 555-0303 is not a valid US phone number. The area code cannot start with 0 or 1, and a US number has ten digits.'],
    ['a malformed email', { serviceContact3Email: 'not-an-email' }, 'serviceContact3Email', 'Enter a valid email address for Service contact 3.'],
    ['a name over 100 characters', { serviceContact2Name: 'x'.repeat(101) }, 'serviceContact2Name', 'Service contact 2 name must be 100 characters or fewer.'],
    ['an email over 150 characters', { serviceContact2Email: `${'a'.repeat(140)}@example.com` }, 'serviceContact2Email', 'Service contact 2 email must be 150 characters or fewer.'],
    ['a phone sent as a number', { serviceContact2Phone: 9415550404 }, 'serviceContact2Phone', 'Service contact 2 phone must be text.'],
  ])('%s is refused as a field error and nothing is written', async (_label, body, field, error) => {
    const response = await saveCustomer(body);
    expect(response).toMatchObject({ status: 400, body: { error, field, code: 'INVALID_SERVICE_CONTACT' } });
    expect(mockState.patches).toEqual([]);
  });

  test('a formatted phone and email are stored like the primary contact\'s', async () => {
    const response = await saveCustomer({ serviceContact2Phone: '(941) 555-0404', serviceContact2Email: ' Pat@Example.com ' });
    expect(response.status).toBe(200);
    expect(mockState.patches[0]).toMatchObject({ service_contact2_phone: '+19415550404', service_contact2_email: 'pat@example.com' });
  });

  test('a stored legacy value echoed unchanged, or a cleared slot, never blocks the save', async () => {
    mockState.initial.service_contact3_phone = '12345';
    mockState.locked.service_contact3_phone = '12345';
    expect((await saveCustomer({ lastName: 'Renamed', serviceContact3Phone: '12345' })).status).toBe(200);
    expect((await saveCustomer({ serviceContactName: '', serviceContactPhone: '', serviceContactEmail: '' })).status).toBe(200);
  });
});
