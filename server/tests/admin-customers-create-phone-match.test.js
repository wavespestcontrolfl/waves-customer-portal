/**
 * POST /admin/customers and POST /admin/customers/quick-add on a live phone
 * match must not silently mint a duplicate profile (#3453's admin-confirm
 * pattern extended to the direct create paths):
 *  - submitted street key matches a live profile on the matched account →
 *    409 DUPLICATE_PROFILE and NO customers insert, unless the admin passed
 *    confirmDuplicate:true;
 *  - genuinely different address → 409 PHONE_MATCH_CONFIRM and NO insert
 *    until confirmAttach:true, and the success response flags the attach
 *    (attachedToExistingAccount + existingCustomerId/Name);
 *  - no phone match → plain create, no confirmation round-trip.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => jest.fn());
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => { req.technicianId = 'admin-1'; req.techRole = 'admin'; next(); },
  requireTechOrAdmin: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn(async () => {}) }));
jest.mock('../services/pipeline-manager', () => ({ onEvent: jest.fn(async () => {}) }));
jest.mock('../services/lead-scorer', () => ({ calculateScore: jest.fn(async () => 0) }));
jest.mock('../services/geocoder', () => ({ ensureCustomerGeocoded: jest.fn(async () => {}) }));

const express = require('express');
const db = require('../models/db');
const router = require('../routes/admin-customers');

// Minimal chainable knex stand-in. Chain calls are recorded; terminals
// resolve from the fixture state. Inserts are captured so tests can assert
// "no customers row was written" on the 409 paths.
function makeDb(state) {
  const builder = (table) => {
    const q = { _ops: [] };
    for (const m of ['where', 'whereNot', 'whereNull', 'whereNotNull', 'whereRaw', 'orWhere', 'orderBy', 'select', 'forUpdate']) {
      q[m] = (...args) => { q._ops.push({ op: m, args }); return q; };
    }
    q.count = () => { q._count = true; return q; };
    q.first = async () => {
      if (table === 'customers') {
        if (q._count) return { count: state.accountProfiles.length };
        // findAccountByContact's phone lookup (last-10-digits regexp).
        if (q._ops.some((o) => o.op === 'whereRaw' && /regexp_replace/.test(String(o.args[0])))) {
          return state.phoneMatchRow;
        }
      }
      return null;
    };
    q.insert = (row) => {
      state.inserts.push({ table, row });
      const saved = { id: `${table}-new`, ...row };
      return {
        returning: async () => [saved],
        onConflict: () => ({ ignore: async () => {} }),
        then: (ok, err) => Promise.resolve([saved]).then(ok, err),
      };
    };
    q.update = async (patch) => { state.updates.push({ table, patch }); return 1; };
    // Awaiting a non-terminal chain (assertPhoneAttachConfirmed's profiles
    // select on the matched account).
    q.then = (ok, err) => {
      const rows = table === 'customers' ? state.accountProfiles : [];
      return Promise.resolve(rows).then(ok, err);
    };
    return q;
  };
  const dbFn = (table) => builder(table);
  dbFn.transaction = jest.fn(async (fn) => fn(Object.assign((t) => builder(t), { isTransaction: true })));
  dbFn.raw = jest.fn(async () => ({ rows: [] }));
  return dbFn;
}

function install(state) {
  const d = makeDb(state);
  db.mockImplementation(d);
  db.transaction = d.transaction;
  db.raw = d.raw;
  return d;
}

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/admin/customers', router);
  app.use((err, _req, res, _next) => res.status(err.statusCode || err.status || 500).json({ error: err.message, code: err.code }));
  const server = app.listen(0);
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { await new Promise((r) => server.close(r)); }
}

const MATCH_ROW = {
  id: 'cust-exist',
  account_id: 'acct-1',
  is_primary_profile: true,
  first_name: 'Existing',
  last_name: 'Owner',
  phone: '+15551234567',
  email: null,
  address_line1: '123 Main St',
  address_line2: null,
  city: 'Testville',
  state: 'FL',
  zip: '00000',
};

function freshState({ phoneMatch = true } = {}) {
  return {
    phoneMatchRow: phoneMatch ? { ...MATCH_ROW } : null,
    accountProfiles: phoneMatch ? [{ ...MATCH_ROW }] : [],
    inserts: [],
    updates: [],
  };
}

const BASE_BODY = {
  firstName: 'Testfirst',
  lastName: 'Testlast',
  phone: '(555) 123-4567',
  city: 'Testville',
  state: 'FL',
  zip: '00000',
};

function post(baseUrl, path, extra = {}) {
  return fetch(`${baseUrl}/admin/customers${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...BASE_BODY, ...extra }),
  });
}

const customersInserts = (state) => state.inserts.filter((i) => i.table === 'customers');

beforeEach(() => {
  jest.clearAllMocks();
  db.mockReset();
});

describe('POST /admin/customers — phone-match confirm gate', () => {
  it('same phone + same street key ("Street" vs "St") → 409 DUPLICATE_PROFILE, no insert', async () => {
    const state = freshState();
    install(state);
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, '/', { addressLine1: '123 Main Street' });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.code).toBe('DUPLICATE_PROFILE');
      expect(body.match).toMatchObject({ customerId: 'cust-exist', accountId: 'acct-1', name: 'Existing Owner' });
      expect(body.match.address).toContain('123 Main St');
    });
    expect(customersInserts(state)).toHaveLength(0);
  });

  it('same street + confirmDuplicate:true → 201, insert on the matched account, attach flagged', async () => {
    const state = freshState();
    install(state);
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, '/', { addressLine1: '123 Main Street', confirmDuplicate: true });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.attachedToExistingAccount).toBe(true);
      expect(body.existingCustomerId).toBe('cust-exist');
    });
    const inserts = customersInserts(state);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].row).toMatchObject({ account_id: 'acct-1', is_primary_profile: false, profile_label: 'Rental property' });
  });

  it('same phone + different street → 409 PHONE_MATCH_CONFIRM with the match, no insert', async () => {
    const state = freshState();
    install(state);
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, '/', { addressLine1: '123 Main Ave' });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.code).toBe('PHONE_MATCH_CONFIRM');
      expect(body.match).toMatchObject({ customerId: 'cust-exist', accountId: 'acct-1', name: 'Existing Owner' });
    });
    expect(customersInserts(state)).toHaveLength(0);
  });

  it('different street + confirmAttach:true → 201, attaches as non-primary and flags the attach', async () => {
    const state = freshState();
    install(state);
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, '/', { addressLine1: '456 Oak Ave', confirmAttach: true });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.attachedToExistingAccount).toBe(true);
      expect(body.existingCustomerId).toBe('cust-exist');
      expect(body.existingCustomerName).toBe('Existing Owner');
    });
    const inserts = customersInserts(state);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].row).toMatchObject({ account_id: 'acct-1', is_primary_profile: false, profile_label: 'Rental property' });
  });

  it('no live phone match → plain create (fresh account, primary profile), no confirmation', async () => {
    const state = freshState({ phoneMatch: false });
    install(state);
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, '/', { addressLine1: '456 Oak Ave' });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.attachedToExistingAccount).toBe(false);
    });
    expect(state.inserts.filter((i) => i.table === 'customer_accounts')).toHaveLength(1);
    const inserts = customersInserts(state);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].row).toMatchObject({ is_primary_profile: true, profile_label: 'Primary' });
  });
});

describe('POST /admin/customers/quick-add — phone-match confirm gate', () => {
  it('same street key → 409 DUPLICATE_PROFILE, no insert', async () => {
    const state = freshState();
    install(state);
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, '/quick-add', { address: '123 Main Street' });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.code).toBe('DUPLICATE_PROFILE');
      expect(body.match).toMatchObject({ customerId: 'cust-exist' });
    });
    expect(customersInserts(state)).toHaveLength(0);
  });

  it('different street + confirmAttach:true → 201 with attach + existing-account identity in the response', async () => {
    const state = freshState();
    install(state);
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, '/quick-add', { address: '456 Oak Ave', confirmAttach: true });
      expect(res.status).toBe(201);
      const { customer } = await res.json();
      expect(customer.attachedToExistingAccount).toBe(true);
      expect(customer.existingCustomerId).toBe('cust-exist');
      expect(customer.existingCustomerName).toBe('Existing Owner');
    });
    expect(customersInserts(state)).toHaveLength(1);
  });

  it('different street, no flag → 409 PHONE_MATCH_CONFIRM, no insert', async () => {
    const state = freshState();
    install(state);
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, '/quick-add', { address: '456 Oak Ave' });
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('PHONE_MATCH_CONFIRM');
    });
    expect(customersInserts(state)).toHaveLength(0);
  });
});
