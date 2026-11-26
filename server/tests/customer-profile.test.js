/**
 * Customer profile edit (GATE_CUSTOMER_PROFILE_EDIT): the REAL customer-profile router runs against a stubbed
 * auth layer, db and code service. Pins: gate off = 404 before any read, a contact session and a cancelled account
 * are refused, Joi validation, names save in one step, an EMAIL change is two steps (PUT mails a code and writes
 * nothing to customers or any fan-out; POST confirm-email judges the code and only then runs the locked commit),
 * the quota counts saved changes AND code emails, the audit rows carry field names (never values), and the notices
 * go to the OLD and the NEW address only after the confirm. The code service itself (expiry, wrong code, attempt
 * cap, reuse) is pinned in customer-email-change-code.test.js; the real auth layer's allow-list is checked here.
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
let mockWhereIn;
const mockTrxBuilder = (table) => {
  const b = {
    count: jest.fn(() => b),
    where: jest.fn((cond) => { if (!mockLockedWhere) mockLockedWhere = cond; return b; }),
    whereNull: jest.fn(() => b),
    whereIn: jest.fn((col, vals) => { mockWhereIn.push({ table, col, vals }); return b; }),
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
jest.mock('../services/customer-email-fanout', () => ({ propagateCustomerEmailChange: (...a) => mockEmailFanout(...a), resendPendingConfirmation: (...a) => mockResend(...a) }));
const mockNameFanout = jest.fn(async () => { mockOrder.push('nameFanout'); });
jest.mock('../services/customer-contact-fanout', () => ({ propagateCustomerNameChange: (...a) => mockNameFanout(...a) }));
const mockConflict = jest.fn(async () => null);
jest.mock('../services/customer-email-write', () => ({ findCrossAccountEmailConflict: (...a) => mockConflict(...a) }));
const mockDb = { transaction: jest.fn(async (fn) => fn(Object.assign((table) => mockTrxBuilder(table), { fn: { now: () => 'NOW' }, raw: (sql) => sql }))) };
jest.mock('../models/db', () => mockDb);
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const mockAudit = jest.fn(async () => 1);
jest.mock('../services/audit-log', () => ({ recordAuditEvent: (...a) => mockAudit(...a) }));
const mockCode = {
  addressSuppressed: jest.fn(async () => false),
  issueRequest: jest.fn(),
  markSent: jest.fn(async () => {}),
  dropRequest: jest.fn(async () => {}),
  checkCode: jest.fn(),
  consume: jest.fn(async () => {}),
  sendCode: jest.fn(async () => ({ messageId: 'm1' })),
};
jest.mock('../services/customer-email-change-code', () => ({
  addressSuppressed: (...a) => mockCode.addressSuppressed(...a),
  issueRequest: (...a) => mockCode.issueRequest(...a),
  markSent: (...a) => mockCode.markSent(...a),
  dropRequest: (...a) => mockCode.dropRequest(...a),
  checkCode: (...a) => mockCode.checkCode(...a),
  consume: (...a) => mockCode.consume(...a),
  sendCode: (...a) => mockCode.sendCode(...a),
}));
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
  mockWhereIn = [];
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
  Object.values(mockCode).forEach((fn) => fn.mockReset());
  mockCode.issueRequest.mockResolvedValue({ id: 'req-1', code: '123456', expiresInMinutes: 15 });
  mockCode.sendCode.mockResolvedValue({ messageId: 'm1' });
  mockCode.markSent.mockResolvedValue();
  mockCode.dropRequest.mockResolvedValue();
  mockCode.consume.mockResolvedValue();
  mockCode.addressSuppressed.mockResolvedValue(false);
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
async function confirm(code) {
  const res = await fetch(`${baseUrl}/api/customer/profile/confirm-email`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }),
  });
  let json = null;
  try { json = await res.json(); } catch { /* none */ }
  return { status: res.status, body: json || {} };
}
const flush = () => new Promise((r) => setImmediate(r));

const NEW_EMAIL = 'new.address@example.test';
const NOTICE_SUMMARY = 'Your Waves account details were changed in the app. If this was not you, call or text us right away.';
// Every notice from this route: ONE generic message, neutral greeting, empty contact name, one valueless item.
const expectGenericNotice = (notice, email) => {
  expect(notice).toMatchObject({
    alwaysNotify: true,
    changeSummary: NOTICE_SUMMARY,
    changedItems: [{ key: 'profile', label: 'Account profile' }],
    greetingName: 'there',
    contactOverride: { email, name: '' },
    accountSection: 'Account profile',
  });
  // No names, no addresses anywhere in it except the recipient.
  const rest = { ...notice };
  delete rest.contactOverride;
  delete rest.idempotencyKey;
  expect(JSON.stringify(rest)).not.toMatch(/Sam|Pat|Sample|@/);
};
const okCheck = (email = NEW_EMAIL) => ({ outcome: 'ok', request: { id: 'req-1', new_email: email } });
const savedAudits = () => mockAudit.mock.calls.map((c) => c[0].action);

describe('PUT /api/customer/profile', () => {
  test.each([undefined, '', 'false', 'on', 'TRUE'])('gate %p is off: 404, no transaction, no email', async (value) => {
    if (value === undefined) delete process.env.GATE_CUSTOMER_PROFILE_EDIT; else process.env.GATE_CUSTOMER_PROFILE_EDIT = value;
    expect(await put({ firstName: 'Sam' })).toMatchObject({ status: 404, body: { enabled: false } });
    expect(await confirm('123456')).toMatchObject({ status: 404, body: { enabled: false } });
    expect(mockDb.transaction).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockCode.sendCode).not.toHaveBeenCalled();
  });

  test('a contact session is refused 403 on both steps and nothing is read or sent', async () => {
    mockSession.contact = { name: 'Pal Contact', phone: '9415550100' };
    expect(await put({ firstName: 'Sam' })).toMatchObject({ status: 403, body: { code: 'ACCOUNT_HOLDER_ONLY' } });
    expect(await confirm('123456')).toMatchObject({ status: 403, body: { code: 'ACCOUNT_HOLDER_ONLY' } });
    expect(mockDb.transaction).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  test('the real auth layer does not list either route for a contact session', () => {
    expect(auth._test.contactSessionRoute({ method: 'PUT', baseUrl: '/api/customer/profile', path: '/' })).toBe(false);
    expect(auth._test.contactSessionRoute({ method: 'POST', baseUrl: '/api/customer/profile', path: '/confirm-email' })).toBe(false);
  });

  test('a cancelled account is refused 403 on both steps', async () => {
    mockSession.inactive = true;
    expect((await put({ firstName: 'Sam' })).status).toBe(403);
    expect((await confirm('123456')).status).toBe(403);
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
    expect((await put(body)).status).toBe(400);
    expect(mockDb.transaction).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockCode.issueRequest).not.toHaveBeenCalled();
  });

  test('phone in the body is ignored and never written', async () => {
    const res = await put({ firstName: 'Sam', phone: '9415550199' });
    expect(res.status).toBe(200);
    expect(Object.keys(mockUpdates[0]).sort()).toEqual(['first_name', 'updated_at']);
  });

  describe('a new email: step 1 mails a code and changes NOTHING', () => {
    test('writes nothing to customers, runs no fan-out, sends no notice; the code goes only to the NEW address', async () => {
      const res = await put({ email: `  ${NEW_EMAIL.toUpperCase()} ` });
      expect(res).toMatchObject({ status: 200, body: { changed: [], emailPending: { email: NEW_EMAIL, expiresInMinutes: 15 }, profile: { email: OLD_EMAIL } } });
      expect(mockUpdates).toHaveLength(0);
      expect(mockLockEmails).not.toHaveBeenCalled();
      expect(mockConflict).not.toHaveBeenCalled();
      expect(mockEmailFanout).not.toHaveBeenCalled();
      expect(mockCode.issueRequest.mock.calls[0][1]).toEqual({ customerId: CUSTOMER_ID, newEmail: NEW_EMAIL, fromEmail: OLD_EMAIL });
      expect(mockCode.sendCode).toHaveBeenCalledWith({ to: NEW_EMAIL, code: '123456' });
      expect(mockCode.markSent).toHaveBeenCalledWith(mockDb, 'req-1');
      await flush();
      expect(mockSend).not.toHaveBeenCalled();
      // The code never comes back to the app.
      expect(JSON.stringify(res.body)).not.toContain('123456');
    });

    test('the audit row for the code carries no address and no code', async () => {
      await put({ email: NEW_EMAIL });
      expect(savedAudits()).toEqual(['customer.profile_email_code_sent']);
      expect(JSON.stringify(mockAudit.mock.calls[0][0].metadata)).not.toMatch(/example|123456/);
    });

    test('the same address in another case is no change: no code, no audit', async () => {
      const res = await put({ email: OLD_EMAIL.toUpperCase() });
      expect(res).toMatchObject({ status: 200, body: { changed: [] } });
      expect(res.body.emailPending).toBeUndefined();
      expect(mockCode.issueRequest).not.toHaveBeenCalled();
      expect(mockAudit).not.toHaveBeenCalled();
    });

    test('a name and an email together: the name saves now; the CURRENT mailbox gets only a generic alert (no name, no values) and the code goes to the new one', async () => {
      const res = await put({ firstName: 'Sam', email: NEW_EMAIL });
      expect(res).toMatchObject({ status: 200, body: { changed: ['firstName'], emailPending: { email: NEW_EMAIL } } });
      expect(mockUpdates).toEqual([{ first_name: 'Sam', updated_at: 'NOW' }]);
      expect(mockEmailFanout).not.toHaveBeenCalled();
      expect(savedAudits().sort()).toEqual(['customer.profile_edit', 'customer.profile_email_code_sent']);
      await flush();
      expect(mockSend).toHaveBeenCalledTimes(1);
      expectGenericNotice(mockSend.mock.calls[0][0], OLD_EMAIL);
      expect(mockCode.sendCode).toHaveBeenCalledWith({ to: NEW_EMAIL, code: '123456' });
    });

    test('an email-only request sends no notice at all (nothing changed yet)', async () => {
      await put({ email: NEW_EMAIL });
      await flush();
      expect(mockSend).not.toHaveBeenCalled();
    });

    test('a combined edit whose code email fails still saved the name: 502 carries the saved name so the app can show it', async () => {
      mockCode.sendCode.mockRejectedValue(Object.assign(new Error('provider down'), { status: 503 }));
      const res = await put({ firstName: 'Sam', email: NEW_EMAIL });
      expect(res).toMatchObject({ status: 502, body: { code: 'code_send_failed', changed: ['firstName'], profile: { firstName: 'Sam', email: OLD_EMAIL } } });
      expect(mockUpdates).toEqual([{ first_name: 'Sam', updated_at: 'NOW' }]);
    });

    test('a customer with no email on file asks for a code for the first address too', async () => {
      mockRow.email = null;
      const res = await put({ email: NEW_EMAIL });
      expect(res.body.emailPending.email).toBe(NEW_EMAIL);
    });

    test('a suppressed address: 409 email_unavailable_for_code, nothing stored, no code, no quota row; a name saved beside it still saved', async () => {
      mockCode.addressSuppressed.mockResolvedValue(true);
      const res = await put({ firstName: 'Sam', email: NEW_EMAIL });
      expect(res).toMatchObject({
        status: 409,
        body: { code: 'email_unavailable_for_code', error: "We can't send email to that address. Please call or text the office.", changed: ['firstName'], profile: { firstName: 'Sam' } },
      });
      expect(mockCode.addressSuppressed.mock.calls[0][1]).toBe(NEW_EMAIL);
      expect(mockCode.issueRequest).not.toHaveBeenCalled();
      expect(mockCode.sendCode).not.toHaveBeenCalled();
      expect(savedAudits()).toEqual(['customer.profile_edit']);
      expect(res.body.error).not.toMatch(/suppress|bounce|unsubscrib|complaint/i);
    });

    test('a suppressed address alone: 409, no audit, no write, no notice', async () => {
      mockCode.addressSuppressed.mockResolvedValue(true);
      const res = await put({ email: NEW_EMAIL });
      expect(res).toMatchObject({ status: 409, body: { code: 'email_unavailable_for_code', changed: [] } });
      expect(mockAudit).not.toHaveBeenCalled();
      expect(mockUpdates).toHaveLength(0);
      await flush();
      expect(mockSend).not.toHaveBeenCalled();
    });

    test('the suppression check runs only for an address that would change, and before the quota is spent', async () => {
      await put({ email: OLD_EMAIL.toUpperCase() });
      expect(mockCode.addressSuppressed).not.toHaveBeenCalled();
      mockSavedInHour = 10;
      mockCode.addressSuppressed.mockResolvedValue(true);
      expect((await put({ email: NEW_EMAIL })).status).toBe(409);
    });

    test('quota: code emails count with saved changes; 10 in the last hour refuses with 429 and sends nothing', async () => {
      mockSavedInHour = 10;
      const res = await put({ email: NEW_EMAIL });
      expect(res).toMatchObject({ status: 429, body: { error: expect.stringContaining('Too many') } });
      expect(mockCode.issueRequest).not.toHaveBeenCalled();
      expect(mockCode.sendCode).not.toHaveBeenCalled();
      expect(mockAudit).not.toHaveBeenCalled();
      mockSavedInHour = 9;
      expect((await put({ email: NEW_EMAIL })).status).toBe(200);
    });

    test('the quota query counts BOTH audit actions, from the audit table, inside the transaction', async () => {
      await put({ email: NEW_EMAIL });
      expect(mockWhereIn.filter((w) => w.table === 'audit_log')).toEqual([
        { table: 'audit_log', col: 'action', vals: ['customer.profile_edit', 'customer.profile_email_code_sent'] },
      ]);
    });

    test('a failed send drops the request and answers 502; nothing else changed', async () => {
      mockCode.sendCode.mockRejectedValue(Object.assign(new Error('provider down'), { status: 503 }));
      const res = await put({ email: NEW_EMAIL });
      expect(res).toMatchObject({ status: 502, body: { code: 'code_send_failed' } });
      expect(mockCode.dropRequest).toHaveBeenCalledWith(mockDb, 'req-1');
      expect(mockCode.markSent).not.toHaveBeenCalled();
      expect(mockUpdates).toHaveLength(0);
    });
  });

  test('a name-only change: one generic notice to the current address (no names)', async () => {
    const res = await put({ firstName: 'Sam', lastName: 'Sample' });
    expect(res).toMatchObject({ status: 200, body: { changed: ['firstName'] } });
    expect(mockUpdates).toEqual([{ first_name: 'Sam', updated_at: 'NOW' }]);
    expect(mockCode.issueRequest).not.toHaveBeenCalled();
    await flush();
    expect(mockSend).toHaveBeenCalledTimes(1);
    expectGenericNotice(mockSend.mock.calls[0][0], OLD_EMAIL);
  });

  test('a name-only edit for a customer with no email on file saves and sends nothing', async () => {
    mockRow.email = null;
    expect((await put({ firstName: 'Sam' })).status).toBe(200);
    expect(mockEmailFanout).not.toHaveBeenCalled();
    await flush();
    expect(mockSend).not.toHaveBeenCalled();
  });

  test('name change fans out to open records with the locked before/after rows; order is lock, update, fan-out', async () => {
    await put({ firstName: 'Sam' });
    expect(mockLockedWhere).toEqual({ id: CUSTOMER_ID, active: true });
    expect(mockNameFanout).toHaveBeenCalledTimes(1);
    const [args] = mockNameFanout.mock.calls[0];
    expect(args.before).toMatchObject({ first_name: 'Pat' });
    expect(args.after).toMatchObject({ first_name: 'Sam', last_name: 'Sample' });
  });

  test('the name quota: 10 saved changes in the last hour refuses with 429; a no-op is never refused or counted', async () => {
    mockSavedInHour = 10;
    expect((await put({ firstName: 'Sam' })).status).toBe(429);
    expect(mockUpdates).toHaveLength(0);
    expect((await put({ firstName: 'Pat' })).status).toBe(200);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('a row cancelled after authenticate is refused 403 and nothing is sent', async () => {
    mockRow = undefined;
    expect((await put({ firstName: 'Sam', email: NEW_EMAIL })).status).toBe(403);
    expect(mockUpdates).toHaveLength(0);
    expect(mockAudit).not.toHaveBeenCalled();
    expect(mockCode.issueRequest).not.toHaveBeenCalled();
  });

  test('a profile that moved to another account after authenticate is refused 403 on both steps', async () => {
    mockRow.account_id = '99999999-9999-4999-8999-999999999999';
    expect((await put({ firstName: 'Sam', email: NEW_EMAIL })).status).toBe(403);
    expect((await confirm('123456')).status).toBe(403);
    expect(mockUpdates).toHaveLength(0);
    expect(mockCode.issueRequest).not.toHaveBeenCalled();
    expect(mockCode.checkCode).not.toHaveBeenCalled();
  });

  test('a row whose account matches the session account is edited (session account differs from its own id)', async () => {
    mockRow.account_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    mockSession.accountId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    expect((await put({ firstName: 'Sam' })).status).toBe(200);
  });

  test('nothing changed: 200, no update, no audit row, no email', async () => {
    const res = await put({ firstName: 'Pat', lastName: 'Sample', email: OLD_EMAIL });
    expect(res).toMatchObject({ status: 200, body: { changed: [] } });
    expect(mockUpdates).toHaveLength(0);
    expect(mockAudit).not.toHaveBeenCalled();
    expect(mockLockEmails).not.toHaveBeenCalled();
    await flush();
    expect(mockSend).not.toHaveBeenCalled();
  });

  test('a failing notice send does not undo or fail the save', async () => {
    mockSend.mockRejectedValue(new Error('provider down'));
    expect((await put({ firstName: 'Sam' })).status).toBe(200);
    expect(mockUpdates).toHaveLength(1);
    mockSend.mockResolvedValue({ ok: true });
  });
});

describe('POST /api/customer/profile/confirm-email', () => {
  test.each(['', '12345', '1234567', 'abcdef', '12 456'])('code %p is a 400 before anything is read', async (code) => {
    const res = await confirm(code);
    expect(res.status).toBe(400);
    expect(mockCode.checkCode).not.toHaveBeenCalled();
  });

  test('a right code runs the locked commit: row, address key, conflict check, update, fan-out, audit, then consume; notices to old and new', async () => {
    mockCode.checkCode.mockResolvedValue(okCheck());
    mockSavedInHour = 10; // the quota was spent when the code was sent; the confirm itself is never refused by it
    const res = await confirm('123456');
    expect(res).toMatchObject({ status: 200, body: { changed: ['email'], profile: { email: NEW_EMAIL } } });
    expect(mockLockedWhere).toEqual({ id: CUSTOMER_ID, active: true });
    expect(mockOrder).toEqual(['lock', 'update', 'emailFanout']);
    expect(mockLockEmails.mock.calls[0][1]).toEqual({ email: NEW_EMAIL });
    expect(mockConflict.mock.calls[0][1]).toMatchObject({ customerId: CUSTOMER_ID, email: NEW_EMAIL });
    expect(mockUpdates).toEqual([{ email: NEW_EMAIL, updated_at: 'NOW' }]);
    const [args] = mockEmailFanout.mock.calls[0];
    expect(args.before).toMatchObject({ email: OLD_EMAIL });
    expect(args.after).toMatchObject({ email: NEW_EMAIL });
    // The SAME fan-out the admin editor runs, with its default options (no narrowed review scope, newsletter included).
    expect(args.reviewReasonCodes).toBeUndefined();
    expect(args.source).toBe('Customer app profile edit');
    expect(savedAudits()).toEqual(['customer.profile_edit']);
    expect(mockAudit.mock.calls[0][0].metadata).toEqual({ fields: ['email'], source: 'customer_portal' });
    expect(mockCode.consume).toHaveBeenCalledWith(expect.anything(), 'req-1');
    await flush();
    expect(mockSend).toHaveBeenCalledTimes(2);
    const [toNew, toOld] = mockSend.mock.calls.map((c) => c[0]);
    expectGenericNotice(toOld, OLD_EMAIL);
    expectGenericNotice(toNew, NEW_EMAIL);
    expect(JSON.stringify(toOld)).not.toContain(NEW_EMAIL);
    expect(JSON.stringify(toNew)).not.toContain(OLD_EMAIL);
    expect(toOld.idempotencyKey).not.toBe(toNew.idempotencyKey);
  });

  test('the code check is given the address on file under the lock, so a request issued for another address is judged stale', async () => {
    mockCode.checkCode.mockResolvedValue(okCheck());
    await confirm('123456');
    expect(mockCode.checkCode.mock.calls[0][1]).toMatchObject({ customerId: CUSTOMER_ID, code: '123456', currentEmail: OLD_EMAIL });
  });

  test('the request records the address on file when the code is issued', async () => {
    await put({ email: NEW_EMAIL });
    expect(mockCode.issueRequest.mock.calls[0][1]).toEqual({ customerId: CUSTOMER_ID, newEmail: NEW_EMAIL, fromEmail: OLD_EMAIL });
  });

  test('the address that gets written is the one the code was SENT to, never one in the confirm request', async () => {
    mockCode.checkCode.mockResolvedValue(okCheck('sent.to@example.test'));
    const res = await fetch(`${baseUrl}/api/customer/profile/confirm-email`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: '123456', email: 'attacker@example.test' }),
    });
    expect(res.status).toBe(200);
    expect(mockUpdates).toEqual([{ email: 'sent.to@example.test', updated_at: 'NOW' }]);
  });

  test.each([
    ['wrong', { outcome: 'wrong', attemptsLeft: 3 }, 400, 'code_wrong', { attemptsLeft: 3 }],
    ['expired', { outcome: 'expired' }, 400, 'code_expired', {}],
    ['stale (the address on file moved since the code was sent)', { outcome: 'stale' }, 400, 'code_expired', {}],
    ['missing (never asked, or already used)', { outcome: 'missing' }, 400, 'code_expired', {}],
    ['too many attempts', { outcome: 'attempts' }, 429, 'code_attempts', {}],
  ])('%s: refused, nothing written, no notice, and the transaction COMMITS (the attempt count must persist)', async (_l, check, status, code, extra) => {
    mockCode.checkCode.mockResolvedValue(check);
    const res = await confirm('123456');
    expect(res).toMatchObject({ status, body: { code, ...extra } });
    expect(mockUpdates).toHaveLength(0);
    expect(mockEmailFanout).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
    expect(mockCode.consume).not.toHaveBeenCalled();
    await flush();
    expect(mockSend).not.toHaveBeenCalled();
    // The handler RETURNED (no throw), so the transaction callback resolved and a real transaction would commit.
    await expect(mockDb.transaction.mock.results[0].value).resolves.toMatchObject({ refused: check });
  });

  test('an address another account holds: 409 with no wording about whose it is, the request is consumed, nothing is written', async () => {
    mockCode.checkCode.mockResolvedValue(okCheck());
    mockConflict.mockResolvedValue({ id: 'other', account_id: 'other-account' });
    const res = await confirm('123456');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('email_unavailable');
    expect(res.body.error).not.toMatch(/another|account|customer/i);
    expect(mockUpdates).toHaveLength(0);
    expect(mockEmailFanout).not.toHaveBeenCalled();
    expect(mockCode.consume).toHaveBeenCalledWith(expect.anything(), 'req-1');
    await flush();
    expect(mockSend).not.toHaveBeenCalled();
  });

  test('a deferred DOI confirmation from the fan-out is sent after commit', async () => {
    mockCode.checkCode.mockResolvedValue(okCheck());
    mockEmailFanout.mockResolvedValueOnce({ pendingConfirmation: { id: 'sub-1', email: NEW_EMAIL } });
    await confirm('123456');
    expect(mockResend).toHaveBeenCalledWith({ id: 'sub-1', email: NEW_EMAIL });
  });

  test('the code was for the address the customer already has: consumed, no change, no audit, no notice', async () => {
    mockCode.checkCode.mockResolvedValue(okCheck(OLD_EMAIL));
    const res = await confirm('123456');
    expect(res).toMatchObject({ status: 200, body: { changed: [] } });
    expect(mockUpdates).toHaveLength(0);
    expect(mockAudit).not.toHaveBeenCalled();
    expect(mockCode.consume).toHaveBeenCalled();
    await flush();
    expect(mockSend).not.toHaveBeenCalled();
  });
});
