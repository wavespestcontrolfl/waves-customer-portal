/**
 * Customer profile edit (GATE_CUSTOMER_PROFILE_EDIT): the REAL customer-profile router runs against a stubbed
 * auth layer and db. Pins: gate off = 404 before any read, a contact session and a cancelled account are refused,
 * Joi validation, only the changed fields are written, the audit row carries field names (never values), and the
 * "account updated" notice goes to the OLD and the NEW address on an email change (one notice on a name change,
 * none when nothing changed). The real auth layer's contact allow-list is checked separately.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'customer-profile-test-secret';

let mockSession;
jest.mock('../middleware/auth', () => {
  const real = jest.requireActual('../middleware/auth');
  return {
    ...real,
    authenticateAllowInactive: (req, _res, next) => {
      req.customerId = mockSession.customerId;
      req.accountId = mockSession.accountId || mockSession.customerId;
      req.customerInactive = mockSession.inactive === true;
      req.contactSession = mockSession.contact || null;
      next();
    },
  };
});

let mockRow;
let mockUpdates;
let mockOrder;
let mockLockedWhere;
let mockSavedInHour;
const mockTrxBuilder = (table) => {
  const b = {
    count: jest.fn(() => b),
    where: jest.fn((cond) => { if (!mockLockedWhere) mockLockedWhere = cond; return b; }),
    whereNull: jest.fn(() => b),
    forUpdate: jest.fn(() => b),
    first: jest.fn(async () => (table === 'audit_log' ? { n: mockSavedInHour } : mockRow)),
    update: jest.fn(async (patch) => { mockOrder.push('update'); mockUpdates.push(patch); return 1; }),
  };
  return b;
};
const mockLockEmails = jest.fn(async () => { mockOrder.push('lock'); return []; });
jest.mock('../utils/customer-comms-lock', () => ({ lockAssignedCustomerEmails: (...a) => mockLockEmails(...a) }));
const mockEmailFanout = jest.fn(async () => { mockOrder.push('emailFanout'); return { pendingConfirmation: null, heldNewsletterResume: null }; });
const mockResend = jest.fn(async () => {});
jest.mock('../services/customer-email-fanout', () => ({ propagateSelfServiceEmailChange: (...a) => mockEmailFanout(...a), resendPendingConfirmation: (...a) => mockResend(...a) }));
const mockNameFanout = jest.fn(async () => { mockOrder.push('nameFanout'); });
jest.mock('../services/customer-contact-fanout', () => ({ propagateCustomerNameChange: (...a) => mockNameFanout(...a) }));
const mockConflict = jest.fn(async () => null);
jest.mock('../services/customer-email-write', () => ({ findCrossAccountEmailConflict: (...a) => mockConflict(...a) }));
const mockDb = { transaction: jest.fn(async (fn) => fn(Object.assign((table) => mockTrxBuilder(table), { fn: { now: () => 'NOW' }, raw: (sql) => sql }))) };
jest.mock('../models/db', () => mockDb);
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const mockAudit = jest.fn(async () => 1);
jest.mock('../services/audit-log', () => ({ recordAuditEvent: (...a) => mockAudit(...a) }));
const mockSend = jest.fn(async () => ({ ok: true }));
jest.mock('../services/account-membership-email', () => ({ sendAccountUpdated: (...a) => mockSend(...a) }));

const express = require('express');
const auth = require('../middleware/auth');

const OLD_EMAIL = 'pat.example@example.test';

let server;
let baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/customer/profile', require('../routes/customer-profile'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  server = app.listen(0, '127.0.0.1', () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});
afterAll((done) => { server.close(done); });

const savedGate = process.env.GATE_CUSTOMER_PROFILE_EDIT;
let seq = 0;
let CUSTOMER_ID;
beforeEach(() => {
  process.env.GATE_CUSTOMER_PROFILE_EDIT = 'true';
  // A fresh customer per test: the hourly limit is keyed on the customer.
  seq += 1;
  CUSTOMER_ID = `11111111-1111-4111-8111-${String(seq).padStart(12, '0')}`;
  mockSession = { customerId: CUSTOMER_ID };
  mockRow = { id: CUSTOMER_ID, active: true, first_name: 'Pat', last_name: 'Sample', email: OLD_EMAIL };
  mockUpdates = [];
  mockOrder = [];
  mockSavedInHour = 0;
  mockConflict.mockClear();
  mockConflict.mockResolvedValue(null);
  mockLockedWhere = null;
  mockLockEmails.mockClear();
  mockEmailFanout.mockClear();
  mockNameFanout.mockClear();
  mockResend.mockClear();
  mockDb.transaction.mockClear();
  mockAudit.mockClear();
  mockSend.mockClear();
});
afterAll(() => {
  if (savedGate === undefined) delete process.env.GATE_CUSTOMER_PROFILE_EDIT; else process.env.GATE_CUSTOMER_PROFILE_EDIT = savedGate;
});

async function put(body) {
  const res = await fetch(`${baseUrl}/api/customer/profile`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* none */ }
  return { status: res.status, body: json || {} };
}
const flush = () => new Promise((r) => setImmediate(r));

describe('PUT /api/customer/profile', () => {
  test.each([undefined, '', 'false', 'on', 'TRUE'])('gate %p is off: 404, no transaction, no email', async (value) => {
    if (value === undefined) delete process.env.GATE_CUSTOMER_PROFILE_EDIT; else process.env.GATE_CUSTOMER_PROFILE_EDIT = value;
    const res = await put({ firstName: 'Sam' });
    expect(res).toMatchObject({ status: 404, body: { enabled: false } });
    expect(mockDb.transaction).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  test('a contact session is refused 403 and nothing is read or sent', async () => {
    mockSession.contact = { name: 'Pal Contact', phone: '9415550100' };
    const res = await put({ firstName: 'Sam' });
    expect(res).toMatchObject({ status: 403, body: { code: 'ACCOUNT_HOLDER_ONLY' } });
    expect(mockDb.transaction).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  test('the real auth layer does not list this route for a contact session', () => {
    const req = { method: 'PUT', baseUrl: '/api/customer/profile', path: '/' };
    expect(auth._test.contactSessionRoute(req)).toBe(false);
  });

  test('a cancelled account is refused 403', async () => {
    mockSession.inactive = true;
    expect((await put({ firstName: 'Sam' })).status).toBe(403);
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  test.each([
    ['empty body', {}],
    ['blank first name', { firstName: '   ' }],
    ['bad email', { email: 'not-an-email' }],
    ['email too long', { email: `${'a'.repeat(150)}@example.test` }],
    ['name with markup', { firstName: '<b>Sam</b>' }],
    ['name over 50', { lastName: 'x'.repeat(51) }],
  ])('%s is a 400 and writes nothing', async (_label, body) => {
    const res = await put(body);
    expect(res.status).toBe(400);
    expect(mockDb.transaction).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  test('phone in the body is ignored and never written', async () => {
    const res = await put({ firstName: 'Sam', phone: '9415550199' });
    expect(res.status).toBe(200);
    expect(mockUpdates).toHaveLength(1);
    expect(Object.keys(mockUpdates[0]).sort()).toEqual(['first_name', 'updated_at']);
  });

  test('email change: trimmed, lower-cased, saved, audited by field name, notices to the old AND the new address', async () => {
    const res = await put({ email: '  New.Address@Example.test ' });
    expect(res).toMatchObject({ status: 200, body: { profile: { firstName: 'Pat', lastName: 'Sample', email: 'new.address@example.test' }, changed: ['email'] } });
    expect(mockUpdates).toEqual([{ email: 'new.address@example.test', updated_at: 'NOW' }]);
    expect(mockAudit).toHaveBeenCalledTimes(1);
    const audit = mockAudit.mock.calls[0][0];
    expect(audit).toMatchObject({ actor_type: 'customer', actor_id: CUSTOMER_ID, action: 'customer.profile_edit', critical: true });
    expect(audit.metadata).toEqual({ fields: ['email'], source: 'customer_portal' });
    await flush();
    expect(mockSend).toHaveBeenCalledTimes(2);
    const [toOld, toNew] = mockSend.mock.calls.map((c) => c[0]);
    // The old mailbox learns only that the address changed, never the replacement; the new mailbox never sees the old address.
    expect(toOld.changedItems).toEqual([{ key: 'email', label: 'Email address' }]);
    expect(JSON.stringify(toOld)).not.toContain('new.address@example.test');
    expect(toNew.changedItems).toEqual([{ key: 'email', label: 'Email address', newValue: 'new.address@example.test' }]);
    expect(JSON.stringify(toNew.changedItems)).not.toContain(OLD_EMAIL);
    expect(toOld.contactOverride).toEqual({ email: OLD_EMAIL, name: '' });
    expect(toOld.greetingName).toBe('there');
    expect(toNew.greetingName).toBeUndefined();
    expect(toNew.contactOverride).toEqual({ email: 'new.address@example.test', name: 'Pat' });
    for (const call of [toOld, toNew]) expect(call).toMatchObject({ customerId: CUSTOMER_ID, actorCustomerId: CUSTOMER_ID, alwaysNotify: true });
    expect(toOld.idempotencyKey).not.toBe(toNew.idempotencyKey);
  });

  test('name-only change: one notice, to the current address, naming old and new name', async () => {
    const res = await put({ firstName: 'Sam', lastName: 'Sample', email: OLD_EMAIL.toUpperCase() });
    expect(res).toMatchObject({ status: 200, body: { changed: ['firstName'] } });
    expect(mockUpdates).toEqual([{ first_name: 'Sam', updated_at: 'NOW' }]);
    await flush();
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0].contactOverride).toEqual({ email: OLD_EMAIL, name: 'Sam' });
    expect(mockSend.mock.calls[0][0].changedItems).toEqual([{ key: 'name', label: 'Name', oldValue: 'Pat Sample', newValue: 'Sam Sample' }]);
  });

  test('a customer with no email on file who adds one gets one notice (no old address to tell)', async () => {
    mockRow.email = null;
    const res = await put({ email: 'first.address@example.test' });
    expect(res.status).toBe(200);
    await flush();
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0].contactOverride).toEqual({ email: 'first.address@example.test', name: 'Pat' });
  });

  test('a rename and an email change together: the old mailbox gets neither name, the new mailbox gets the new one', async () => {
    await put({ firstName: 'Sam', email: 'new.address@example.test' });
    await flush();
    const [toOld, toNew] = mockSend.mock.calls.map((c) => c[0]);
    expect(toOld).toMatchObject({ greetingName: 'there', contactOverride: { email: OLD_EMAIL, name: '' } });
    expect(JSON.stringify(toOld)).not.toMatch(/Sam|Pat/);
    expect(toNew.contactOverride).toEqual({ email: 'new.address@example.test', name: 'Sam' });
  });

  test('a profile that moved to another account after authenticate (locked row account differs from the session) is refused 403, nothing written', async () => {
    mockRow.account_id = '99999999-9999-4999-8999-999999999999';
    const res = await put({ firstName: 'Sam', email: 'new.address@example.test' });
    expect(res.status).toBe(403);
    expect(mockUpdates).toHaveLength(0);
    expect(mockAudit).not.toHaveBeenCalled();
    expect(mockEmailFanout).not.toHaveBeenCalled();
    await flush();
    expect(mockSend).not.toHaveBeenCalled();
  });

  test('a row whose account matches the session account is edited (session account differs from its own id)', async () => {
    mockRow.account_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    mockSession.accountId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    expect((await put({ firstName: 'Sam' })).status).toBe(200);
  });

  test('a name-only edit for a customer with no email on file saves and sends nothing', async () => {
    mockRow.email = null;
    const res = await put({ firstName: 'Sam' });
    expect(res).toMatchObject({ status: 200, body: { changed: ['firstName'] } });
    expect(mockEmailFanout).not.toHaveBeenCalled();
    await flush();
    expect(mockSend).not.toHaveBeenCalled();
  });

  test('email change: locked read requires active, lock order is row then address key then write then fan-out', async () => {
    await put({ email: 'new.address@example.test' });
    expect(mockLockedWhere).toEqual({ id: CUSTOMER_ID, active: true });
    expect(mockOrder).toEqual(['lock', 'update', 'emailFanout']);
    expect(mockLockEmails.mock.calls[0][1]).toEqual({ email: 'new.address@example.test' });
    const [args] = mockEmailFanout.mock.calls[0];
    expect(args.before).toMatchObject({ email: OLD_EMAIL, first_name: 'Pat' });
    expect(args.after).toMatchObject({ email: 'new.address@example.test', first_name: 'Pat' });
    expect(args.reviewReasonCodes).toEqual(['customer_email_missing']);
    expect(mockNameFanout).not.toHaveBeenCalled();
  });

  test('name change fans out to open records with the locked before/after rows', async () => {
    await put({ firstName: 'Sam' });
    expect(mockNameFanout).toHaveBeenCalledTimes(1);
    const [args] = mockNameFanout.mock.calls[0];
    expect(args.before).toMatchObject({ first_name: 'Pat' });
    expect(args.after).toMatchObject({ first_name: 'Sam', last_name: 'Sample' });
    expect(mockEmailFanout).not.toHaveBeenCalled();
  });

  test('a deferred DOI confirmation from the fan-out is sent after commit', async () => {
    mockEmailFanout.mockResolvedValueOnce({ pendingConfirmation: { id: 'sub-1', email: 'new.address@example.test' } });
    await put({ email: 'new.address@example.test' });
    expect(mockResend).toHaveBeenCalledWith({ id: 'sub-1', email: 'new.address@example.test' });
  });

  test('a row cancelled after authenticate (no active row under the lock) is refused 403 and nothing is sent', async () => {
    mockRow = undefined;
    const res = await put({ email: 'new.address@example.test' });
    expect(res.status).toBe(403);
    expect(mockUpdates).toHaveLength(0);
    expect(mockAudit).not.toHaveBeenCalled();
    expect(mockEmailFanout).not.toHaveBeenCalled();
    await flush();
    expect(mockSend).not.toHaveBeenCalled();
  });

  test('nothing changed: 200, no update, no audit row, no email', async () => {
    const res = await put({ firstName: 'Pat', lastName: 'Sample', email: OLD_EMAIL });
    expect(res).toMatchObject({ status: 200, body: { changed: [] } });
    expect(mockUpdates).toHaveLength(0);
    expect(mockAudit).not.toHaveBeenCalled();
    expect(mockLockEmails).not.toHaveBeenCalled();
    expect(mockEmailFanout).not.toHaveBeenCalled();
    await flush();
    expect(mockSend).not.toHaveBeenCalled();
  });

  test('a failing email send does not undo or fail the save', async () => {
    mockSend.mockRejectedValue(new Error('provider down'));
    const res = await put({ email: 'later.address@example.test' });
    expect(res.status).toBe(200);
    expect(mockUpdates).toHaveLength(1);
    mockSend.mockResolvedValue({ ok: true });
  });

  test('the quota is counted from committed audit rows under the row lock: 10 in the last hour refuses with 429', async () => {
    mockSavedInHour = 10;
    const res = await put({ firstName: 'Sam' });
    expect(res).toMatchObject({ status: 429, body: { error: expect.stringContaining('Too many') } });
    expect(mockUpdates).toHaveLength(0);
    expect(mockAudit).not.toHaveBeenCalled();
    await flush();
    expect(mockSend).not.toHaveBeenCalled();
    mockSavedInHour = 9;
    expect((await put({ firstName: 'Sam' })).status).toBe(200);
  });

  test('a no-op save is never refused by the quota and never counted (no audit row written)', async () => {
    mockSavedInHour = 10;
    expect((await put({ firstName: 'Pat' })).status).toBe(200);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('an address held by another account is refused 409, with no wording that says whose it is, and nothing is written', async () => {
    mockConflict.mockResolvedValue({ id: 'other', account_id: 'other-account' });
    const res = await put({ email: 'taken.address@example.test' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('email_unavailable');
    expect(res.body.error).not.toMatch(/another|account|customer/i);
    expect(mockConflict.mock.calls[0][1]).toMatchObject({ customerId: CUSTOMER_ID, email: 'taken.address@example.test' });
    expect(mockUpdates).toHaveLength(0);
    expect(mockEmailFanout).not.toHaveBeenCalled();
    await flush();
    expect(mockSend).not.toHaveBeenCalled();
  });

  test('the conflict check is skipped for a name-only edit', async () => {
    await put({ firstName: 'Sam' });
    expect(mockConflict).not.toHaveBeenCalled();
  });

});
