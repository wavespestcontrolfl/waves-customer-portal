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
let mockSiblings;
let mockAccountRow;
let mockUpdates;
let mockAccountUpdates;
let mockSiblingUpdates;
let mockOrder;
let mockLockedWhere;
let mockSavedInHour;
let mockWhereIn;
const mockTrxBuilder = (table) => {
  let targetId = null;
  let firstRead = false;
  const b = {
    count: jest.fn(() => b),
    where: jest.fn((cond) => {
      if (typeof cond === 'object' && cond && 'id' in cond) targetId = cond.id;
      if (!mockLockedWhere && targetId) mockLockedWhere = { id: targetId };
      return b;
    }),
    whereNull: jest.fn(() => b),
    whereIn: jest.fn((col, vals) => { mockWhereIn.push({ table, col, vals }); return b; }),
    orderBy: jest.fn(() => b),
    forUpdate: jest.fn(() => b),
    select: jest.fn(async () => {
      if (table === 'customers') return mockRow ? [mockRow, ...(mockSiblings || [])] : [];
      return [];
    }),
    first: jest.fn(async () => {
      firstRead = true;
      if (table === 'audit_log') return { n: mockSavedInHour };
      if (table === 'customer_accounts') return mockAccountRow;
      if (table === 'customers') return mockRow;
      return mockRow;
    }),
    update: jest.fn(async (patch) => {
      if (table === 'customer_accounts') {
        mockAccountUpdates.push(patch);
      } else if (table === 'customers' && targetId && mockRow && String(targetId) !== String(mockRow.id)) {
        mockSiblingUpdates.push({ id: targetId, ...patch });
      } else {
        mockOrder.push('update');
        mockUpdates.push(patch);
      }
      return firstRead ? 1 : 1;
    }),
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
const mockApplyEmail = jest.fn();
jest.mock('../services/customer-email-write', () => ({ applyOperatorCustomerEmail: (...a) => mockApplyEmail(...a) }));
// A savepoint (trx.transaction) runs on the same mock handle, flagged so a test can see the alert used it.
const mockMakeTrx = () => {
  const trx = Object.assign((table) => mockTrxBuilder(table), { fn: { now: () => 'NOW' }, raw: (sql) => sql });
  trx.transaction = jest.fn(async (fn) => fn(Object.assign((table) => mockTrxBuilder(table), { fn: trx.fn, raw: trx.raw, isSavepoint: true })));
  return trx;
};
const mockDb = { transaction: jest.fn(async (fn) => fn(mockMakeTrx())) };
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
// The real composer (its rules throw in tests), with the bell write captured.
const mockNotifyAdmin = jest.fn(async () => ({ id: 'n1' }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: (...a) => mockNotifyAdmin(...a) }));
const mockEnqueueStripeSync = jest.fn(async () => {});
jest.mock('../services/stripe-email-sync', () => ({ enqueue: (...a) => mockEnqueueStripeSync(...a) }));

const express = require('express');
const auth = require('../middleware/auth');

const OLD_EMAIL = 'pat.example@example.test';

let server;
let baseUrl;
// The error the route handed to next(): what the shared error handler would log (message and stack).
let forwardedError;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/customer/profile', require('../routes/customer-profile'));
  app.use((err, _req, res, _next) => { forwardedError = err; res.status(500).json({ error: err.message }); });
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
  mockSiblings = [];
  mockAccountRow = null;
  mockUpdates = [];
  mockAccountUpdates = [];
  mockSiblingUpdates = [];
  mockOrder = [];
  mockWhereIn = [];
  forwardedError = null;
  mockSavedInHour = 0;
  mockApplyEmail.mockReset();
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
async function confirm(code, email = 'new.address@example.test') {
  const res = await fetch(`${baseUrl}/api/customer/profile/confirm-email`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, ...(email === null ? {} : { email }) }),
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
    suppressProviderErrorLog: true,
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
      expect(mockApplyEmail).not.toHaveBeenCalled();
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
      expect(savedAudits()).toEqual(['customer.profile_email_code_requested']);
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
      expect(savedAudits().sort()).toEqual(['customer.profile_edit', 'customer.profile_email_code_requested']);
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

    test('a suppressed address: 409 email_unavailable_for_code, no code stored or sent, one quota row for the refusal; a name saved beside it still saved', async () => {
      mockCode.addressSuppressed.mockResolvedValue(true);
      const res = await put({ firstName: 'Sam', email: NEW_EMAIL });
      expect(res).toMatchObject({
        status: 409,
        body: { code: 'email_unavailable_for_code', error: "We can't send email to that address. Please call or text the office.", changed: ['firstName'], profile: { firstName: 'Sam' } },
      });
      expect(mockCode.addressSuppressed.mock.calls[0][1]).toBe(NEW_EMAIL);
      expect(mockCode.issueRequest).not.toHaveBeenCalled();
      expect(mockCode.sendCode).not.toHaveBeenCalled();
      expect(savedAudits()).toEqual(['customer.profile_edit', 'customer.profile_email_code_requested']);
      // The refusal row names its outcome only: no field, no address.
      expect(mockAudit.mock.calls[1][0].metadata).toEqual({ outcome: 'refused', source: 'customer_portal' });
      expect(res.body.error).not.toMatch(/suppress|bounce|unsubscrib|complaint/i);
    });

    test('a suppressed address alone: 409, the refusal uses one quota unit, no write, no notice', async () => {
      mockCode.addressSuppressed.mockResolvedValue(true);
      const res = await put({ email: NEW_EMAIL });
      expect(res).toMatchObject({ status: 409, body: { code: 'email_unavailable_for_code', changed: [] } });
      expect(savedAudits()).toEqual(['customer.profile_email_code_requested']);
      expect(mockUpdates).toHaveLength(0);
      await flush();
      expect(mockSend).not.toHaveBeenCalled();
    });

    test('the suppression check runs only for an address that would change, and only under the quota: a spent quota answers 429 without looking the address up', async () => {
      await put({ email: OLD_EMAIL.toUpperCase() });
      expect(mockCode.addressSuppressed).not.toHaveBeenCalled();
      mockSavedInHour = 10;
      mockCode.addressSuppressed.mockResolvedValue(true);
      expect((await put({ email: NEW_EMAIL })).status).toBe(429);
      expect(mockCode.addressSuppressed).not.toHaveBeenCalled();
      expect(mockAudit).not.toHaveBeenCalled();
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
        { table: 'audit_log', col: 'action', vals: ['customer.profile_edit', 'customer.profile_email_code_requested'] },
      ]);
    });

    test.each([
      ['a conclusive provider rejection', { status: 400 }],
      ['a 5xx', { status: 503 }],
      ['a network failure with no status', {}],
    ])('%s: 502, the request is dropped, and the code request keeps its quota unit (no second audit row)', async (_label, props) => {
      mockCode.sendCode.mockRejectedValueOnce(Object.assign(new Error('not sent or unknown'), props));
      const res = await put({ email: NEW_EMAIL });
      expect(res.status).toBe(502);
      expect(mockCode.dropRequest).toHaveBeenCalledWith(mockDb, 'req-1');
      expect(savedAudits()).toEqual(['customer.profile_email_code_requested']);
      expect(mockAudit.mock.calls[0][0].metadata).toEqual({ outcome: 'issued', source: 'customer_portal' });
    });

    // Regression: the address joined the suppression list after its request was stored, so sendCode refused at the
    // provider handoff. The route answered 502 "try again in a moment"; the documented answer is the 409 of the first check.
    test('a suppression found at the provider handoff: the same 409 as the first check (with the saved name), the request is dropped, the quota unit stays', async () => {
      mockCode.sendCode.mockRejectedValueOnce(Object.assign(new Error('address suppressed'), { code: 'address_suppressed' }));
      const res = await put({ firstName: 'Sam', email: NEW_EMAIL });
      expect(res).toMatchObject({
        status: 409,
        body: { code: 'email_unavailable_for_code', error: "We can't send email to that address. Please call or text the office.", changed: ['firstName'], profile: { firstName: 'Sam', email: OLD_EMAIL } },
      });
      expect(res.body.emailPending).toBeUndefined();
      expect(mockCode.dropRequest).toHaveBeenCalledWith(mockDb, 'req-1');
      expect(mockCode.markSent).not.toHaveBeenCalled();
      expect(savedAudits()).toEqual(['customer.profile_edit', 'customer.profile_email_code_requested']);
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
    // The office alert is for an EMAIL change only.
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
    expect(mockEnqueueStripeSync).not.toHaveBeenCalled();
  });

  test('a name-only edit for a customer with no email on file saves and sends nothing', async () => {
    mockRow.email = null;
    expect((await put({ firstName: 'Sam' })).status).toBe(200);
    expect(mockEmailFanout).not.toHaveBeenCalled();
    await flush();
    expect(mockSend).not.toHaveBeenCalled();
  });

  test('name change fans out to open records with the locked before/after rows', async () => {
    await put({ firstName: 'Sam' });
    expect(mockLockedWhere).toEqual({ id: CUSTOMER_ID });
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

  test('an inactive row (cancelled after authenticate) is refused 403 on both steps, judged on the LOCKED row', async () => {
    mockRow.active = false;
    expect((await put({ firstName: 'Sam' })).status).toBe(403);
    expect((await confirm('123456')).status).toBe(403);
    expect(mockUpdates).toHaveLength(0);
    expect(mockCode.checkCode).not.toHaveBeenCalled();
    expect(mockApplyEmail).not.toHaveBeenCalled();
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

  test('passes bypassEmailOptOut: true on security notices and syncs matching customer_accounts + identical-holder siblings without clobbering distinct or surname-only siblings', async () => {
    const ACCT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const SIB_MATCH = '22222222-2222-4222-8222-222222222222';
    const SIB_SURNAME = '44444444-4444-4444-8444-444444444444';
    const SIB_DIFF = '33333333-3333-4333-8333-333333333333';
    mockSession = { customerId: CUSTOMER_ID, accountId: ACCT };
    mockRow = { id: CUSTOMER_ID, account_id: ACCT, active: true, first_name: 'Pat', last_name: 'Sample', email: OLD_EMAIL };
    mockAccountRow = { id: ACCT, first_name: 'Pat', last_name: 'Sample', email: OLD_EMAIL };
    mockSiblings = [
      { id: SIB_MATCH, account_id: ACCT, active: true, first_name: 'Pat', last_name: 'Sample', email: OLD_EMAIL },
      { id: SIB_SURNAME, account_id: ACCT, active: true, first_name: 'Robin', last_name: 'Sample', email: 'robin@example.test' },
      { id: SIB_DIFF, account_id: ACCT, active: true, first_name: 'Alex', last_name: 'Tenant', email: 'tenant@example.test' },
    ];
    expect((await put({ firstName: 'Sam', lastName: 'Updated' })).status).toBe(200);
    await flush();
    expect(mockSend.mock.calls[0][0].bypassEmailOptOut).toBe(true);
    expect(mockAccountUpdates).toEqual([{ first_name: 'Sam', last_name: 'Updated', updated_at: 'NOW' }]);
    expect(mockSiblingUpdates).toEqual([{ id: SIB_MATCH, first_name: 'Sam', last_name: 'Updated', updated_at: 'NOW' }]);
    expect(mockNameFanout).toHaveBeenCalledTimes(2);
    expect(mockNameFanout.mock.calls.map((c) => c[0].after.id)).toEqual([CUSTOMER_ID, SIB_MATCH]);
  });

  test('confirm-email routes matching-holder sibling email updates through applyOperatorCustomerEmail, Stripe sync, and post-commit fanout', async () => {
    const ACCT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const SIB_MATCH = '22222222-2222-4222-8222-222222222222';
    const SIB_SURNAME = '44444444-4444-4444-8444-444444444444';
    const holderBefore = { id: CUSTOMER_ID, account_id: ACCT, active: true, first_name: 'Pat', last_name: 'Sample', email: OLD_EMAIL };
    mockSession = { customerId: CUSTOMER_ID, accountId: ACCT };
    mockRow = holderBefore;
    mockAccountRow = { id: ACCT, first_name: 'Pat', last_name: 'Sample', email: OLD_EMAIL };
    mockSiblings = [
      { id: SIB_MATCH, account_id: ACCT, active: true, first_name: 'Pat', last_name: 'Sample', email: OLD_EMAIL },
      { id: SIB_SURNAME, account_id: ACCT, active: true, first_name: 'Robin', last_name: 'Sample', email: 'robin@example.test' },
    ];
    mockCode.checkCode.mockResolvedValue({ outcome: 'ok', request: { id: 'req-1', new_email: NEW_EMAIL } });
    mockApplyEmail.mockImplementation(async (_trx, { customerId }) => ({
      outcome: 'updated',
      before: customerId === SIB_MATCH ? mockSiblings[0] : holderBefore,
      emailSync: { pendingConfirmation: { id: `sub-${customerId}`, email: NEW_EMAIL } },
    }));
    const res = await fetch(`${baseUrl}/api/customer/profile/confirm-email`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: '123456', email: NEW_EMAIL }),
    });
    expect(res.status).toBe(200);
    expect(mockApplyEmail.mock.calls.map((c) => c[1].customerId)).toEqual([CUSTOMER_ID, SIB_MATCH]);
    expect(mockEnqueueStripeSync.mock.calls.map((c) => c[1])).toEqual([SIB_MATCH, CUSTOMER_ID]);
    expect(mockResend).toHaveBeenCalledWith({ id: `sub-${CUSTOMER_ID}`, email: NEW_EMAIL });
    expect(mockResend).toHaveBeenCalledWith({ id: `sub-${SIB_MATCH}`, email: NEW_EMAIL });
  });
});

describe('POST /api/customer/profile/confirm-email', () => {
  const changed = (over = {}) => ({ outcome: 'changed', before: { ...mockRow }, emailSync: { pendingConfirmation: null, heldNewsletterResume: null }, ...over });

  test.each([['', NEW_EMAIL], ['12345', NEW_EMAIL], ['1234567', NEW_EMAIL], ['abcdef', NEW_EMAIL], ['12 456', NEW_EMAIL], ['123456', null], ['123456', 'not-an-email']])('code %p with address %p is a 400 before anything is read', async (code, email) => {
    expect((await confirm(code, email)).status).toBe(400);
    expect(mockCode.checkCode).not.toHaveBeenCalled();
    expect(mockApplyEmail).not.toHaveBeenCalled();
  });

  test('a right code DELEGATES to the shared operator email write (the one admin triage uses); then consumes, audits, notices', async () => {
    mockCode.checkCode.mockResolvedValue(okCheck());
    mockApplyEmail.mockImplementation(async () => changed());
    mockSavedInHour = 10; // the quota was spent when the code was sent; the confirm itself is never refused by it
    const res = await confirm('123456');
    expect(res).toMatchObject({ status: 200, body: { changed: ['email'], profile: { email: NEW_EMAIL } } });
    expect(mockApplyEmail).toHaveBeenCalledTimes(1);
    const [trxArg, args] = mockApplyEmail.mock.calls[0];
    expect(typeof trxArg).toBe('function');
    expect(args).toMatchObject({ customerId: CUSTOMER_ID, email: NEW_EMAIL, source: 'Customer app profile edit' });
    expect(mockCode.consume).toHaveBeenCalledWith(expect.anything(), 'req-1');
    expect(savedAudits()).toEqual(['customer.profile_edit']);
    expect(mockAudit.mock.calls[0][0].metadata).toEqual({ fields: ['email'], source: 'customer_portal' });
    // The route no longer writes customers or fans out itself: that is the shared writer's job.
    expect(mockUpdates).toHaveLength(0);
    expect(mockEmailFanout).not.toHaveBeenCalled();
    await flush();
    expect(mockSend).toHaveBeenCalledTimes(2);
    const [toNew, toOld] = mockSend.mock.calls.map((c) => c[0]);
    expectGenericNotice(toOld, OLD_EMAIL);
    expectGenericNotice(toNew, NEW_EMAIL);
    expect(JSON.stringify(toOld)).not.toContain(NEW_EMAIL);
    expect(JSON.stringify(toNew)).not.toContain(OLD_EMAIL);
    expect(toOld.idempotencyKey).not.toBe(toNew.idempotencyKey);
  });

  // Owner 11-27: the office hears about every confirmed email change.
  test('a confirmed change raises one office alert with the old and new address', async () => {
    mockNotifyAdmin.mockClear();
    mockCode.checkCode.mockResolvedValue(okCheck());
    mockApplyEmail.mockImplementation(async () => changed());
    expect((await confirm('123456')).status).toBe(200);
    await flush();
    expect(mockNotifyAdmin).toHaveBeenCalledTimes(1);
    const [category, title, body, opts] = mockNotifyAdmin.mock.calls[0];
    expect(category).toBe('customer');
    expect(title).toBe('Customers — Email changed in the app');
    expect(body).toContain(OLD_EMAIL);
    expect(body).toContain(NEW_EMAIL);
    expect(opts).toMatchObject({
      bell: true,
      link: `/admin/customers?customerId=${CUSTOMER_ID}`,
      dedupeKey: `profile_email_change:${CUSTOMER_ID}:req-1`,
      metadata: expect.objectContaining({ oldEmail: OLD_EMAIL, newEmail: NEW_EMAIL, severity: 'needs-you', doneWhen: 'email_change_reviewed' }),
    });
    // Written in the change's own transaction, so the two commit together.
    expect(typeof opts.trx).toBe('function');
    // Stripe's copy follows: a durable job queued on the same transaction handle.
    expect(mockEnqueueStripeSync).toHaveBeenCalledWith(opts.trx, CUSTOMER_ID, NEW_EMAIL, 'app_email_change');
    expect(opts.detail).toContain(`Old email: ${OLD_EMAIL}`);
    expect(opts.detail).toContain(`New email: ${NEW_EMAIL}`);
  });

  test('an address the alert copy rules refuse (an underscore) still raises the alert, with a fixed sentence', async () => {
    mockNotifyAdmin.mockClear();
    mockCode.checkCode.mockResolvedValue(okCheck('first_last@example.test'));
    mockApplyEmail.mockImplementation(async () => changed());
    expect((await confirm('123456', 'first_last@example.test')).status).toBe(200);
    await flush();
    expect(mockNotifyAdmin).toHaveBeenCalledTimes(1);
    const [, , body, opts] = mockNotifyAdmin.mock.calls[0];
    expect(body).toBe('A customer changed their email, and both addresses are in the details.');
    expect(opts.detail).toContain('New email: first_last@example.test');
  });

  test('a failed alert write fails the whole confirm (nothing commits), so the same code works on the retry', async () => {
    for (const failure of [() => mockNotifyAdmin.mockRejectedValueOnce(new Error('bell down')), () => mockNotifyAdmin.mockResolvedValueOnce(null)]) {
      mockNotifyAdmin.mockClear();
      failure();
      mockCode.checkCode.mockResolvedValue(okCheck());
      mockApplyEmail.mockImplementation(async () => changed());
      const res = await confirm('123456');
      expect(res.status).toBe(500);
      // The transaction callback threw: the mock db rejects, as Postgres would roll the change and the consume back.
      await expect(mockDb.transaction.mock.results[mockDb.transaction.mock.results.length - 1].value).rejects.toBeTruthy();
      await flush();
      expect(mockSend).not.toHaveBeenCalled();
      mockSend.mockClear();
    }
  });

  test('an unchanged address and a wrong code raise no alert', async () => {
    mockNotifyAdmin.mockClear(); mockEnqueueStripeSync.mockClear();
    mockCode.checkCode.mockResolvedValue(okCheck());
    mockApplyEmail.mockImplementation(async () => ({ outcome: 'unchanged', before: { ...mockRow } }));
    await confirm('123456');
    mockCode.checkCode.mockResolvedValue({ outcome: 'wrong', attemptsLeft: 3 });
    await confirm('123456');
    await flush();
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
    expect(mockEnqueueStripeSync).not.toHaveBeenCalled();
  });

  test('the rowAllowed it hands the writer refuses an inactive row and a row on another account', async () => {
    mockCode.checkCode.mockResolvedValue(okCheck());
    mockApplyEmail.mockImplementation(async () => changed());
    await confirm('123456');
    const { rowAllowed } = mockApplyEmail.mock.calls[0][1];
    expect(rowAllowed({ id: CUSTOMER_ID, active: true })).toBe(true);
    expect(rowAllowed({ id: CUSTOMER_ID, active: false })).toBe(false);
    expect(rowAllowed({ id: CUSTOMER_ID, active: true, account_id: 'another-account' })).toBe(false);
  });

  test('the code check is given the address on file under the lock and the address the form showed', async () => {
    mockCode.checkCode.mockResolvedValue(okCheck());
    mockApplyEmail.mockImplementation(async () => changed());
    await confirm('123456');
    expect(mockCode.checkCode.mock.calls[0][1]).toMatchObject({ customerId: CUSTOMER_ID, code: '123456', currentEmail: OLD_EMAIL, expectedEmail: NEW_EMAIL });
  });

  test('the address that gets written is the one the code was SENT to', async () => {
    mockCode.checkCode.mockResolvedValue(okCheck('sent.to@example.test'));
    mockApplyEmail.mockImplementation(async () => changed());
    const res = await confirm('123456', 'sent.to@example.test');
    expect(res.body.profile.email).toBe('sent.to@example.test');
    expect(mockApplyEmail.mock.calls[0][1].email).toBe('sent.to@example.test');
  });

  test.each([
    ['wrong', { outcome: 'wrong', attemptsLeft: 3 }, 400, 'code_wrong', { attemptsLeft: 3 }],
    ['expired', { outcome: 'expired' }, 400, 'code_expired', {}],
    ['stale (the address on file moved since the code was sent)', { outcome: 'stale' }, 400, 'code_expired', {}],
    ['for a different pending address than the form showed', { outcome: 'mismatch' }, 400, 'code_expired', {}],
    ['missing (never asked, or already used)', { outcome: 'missing' }, 400, 'code_expired', {}],
    ['too many attempts', { outcome: 'attempts' }, 429, 'code_attempts', {}],
  ])('%s: refused, nothing written, no notice, and the transaction COMMITS (the attempt count must persist)', async (_l, check, status, code, extra) => {
    mockCode.checkCode.mockResolvedValue(check);
    const res = await confirm('123456');
    expect(res).toMatchObject({ status, body: { code, ...extra } });
    expect(mockApplyEmail).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
    expect(mockCode.consume).not.toHaveBeenCalled();
    await flush();
    expect(mockSend).not.toHaveBeenCalled();
    await expect(mockDb.transaction.mock.results[0].value).resolves.toMatchObject({ refused: check });
  });

  test('an address another account holds (the shared writer refused): 409 with no wording about whose it is, the request is consumed, nothing else', async () => {
    mockCode.checkCode.mockResolvedValue(okCheck());
    mockApplyEmail.mockResolvedValue({ outcome: 'email_in_use', conflict: { id: 'other', account_id: 'other-account' } });
    const res = await confirm('123456');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('email_unavailable');
    expect(res.body.error).not.toMatch(/another|account|customer/i);
    expect(mockCode.consume).toHaveBeenCalledWith(expect.anything(), 'req-1');
    expect(mockAudit).not.toHaveBeenCalled();
    await flush();
    expect(mockSend).not.toHaveBeenCalled();
  });

  test.each(['not_allowed', 'customer_not_found'])('the shared writer answering %s is a 403 and nothing is sent', async (outcome) => {
    mockCode.checkCode.mockResolvedValue(okCheck());
    mockApplyEmail.mockResolvedValue({ outcome });
    expect((await confirm('123456')).status).toBe(403);
    expect(mockAudit).not.toHaveBeenCalled();
    await flush();
    expect(mockSend).not.toHaveBeenCalled();
  });

  test('a deferred DOI confirmation from the fan-out is sent after commit', async () => {
    mockCode.checkCode.mockResolvedValue(okCheck());
    mockApplyEmail.mockImplementation(async () => changed({ emailSync: { pendingConfirmation: { id: 'sub-1', email: NEW_EMAIL } } }));
    await confirm('123456');
    expect(mockResend).toHaveBeenCalledWith({ id: 'sub-1', email: NEW_EMAIL });
  });

  test('the code was for the address the customer already has (writer: unchanged): consumed, no audit, no notice', async () => {
    mockCode.checkCode.mockResolvedValue(okCheck(OLD_EMAIL));
    mockApplyEmail.mockResolvedValue({ outcome: 'unchanged', before: { ...mockRow }, emailSync: null });
    const res = await confirm('123456', OLD_EMAIL);
    expect(res).toMatchObject({ status: 200, body: { changed: [] } });
    expect(mockAudit).not.toHaveBeenCalled();
    expect(mockCode.consume).toHaveBeenCalled();
    await flush();
    expect(mockSend).not.toHaveBeenCalled();
  });
});

// The shared error handler logs message + stack of whatever a route forwards, and a Knex error's message is the failed
// SQL with its bound values. Regression: both handlers forwarded the raw error, so a failed write logged the typed
// name and email. Only the error's class and database code may leave the route.
describe('a database failure never forwards the typed name or email to the error log', () => {
  const sqlError = () => Object.assign(
    new Error(`update "customers" set "first_name" = 'Robin', "email" = '${NEW_EMAIL}' where "id" = 'x' - duplicate key value violates unique constraint`),
    { code: '23505' },
  );
  const expectNoBoundValues = (res) => {
    expect(res.status).toBe(500);
    const logged = `${forwardedError.message}\n${forwardedError.stack}`;
    expect(logged).not.toContain('Robin');
    expect(logged).not.toContain(NEW_EMAIL);
    expect(logged).not.toContain('first_name');
    expect(forwardedError.code).toBe('23505');
    expect(forwardedError.message).toContain('23505');
  };

  test('PUT', async () => {
    mockDb.transaction.mockRejectedValueOnce(sqlError());
    expectNoBoundValues(await put({ firstName: 'Robin', email: NEW_EMAIL }));
  });

  test('POST confirm-email', async () => {
    mockDb.transaction.mockRejectedValueOnce(sqlError());
    expectNoBoundValues(await confirm('123456'));
  });

  test('an error with no database code forwards its class name only', async () => {
    mockDb.transaction.mockRejectedValueOnce(new TypeError(`cannot read ${NEW_EMAIL}`));
    expect((await put({ firstName: 'Robin' })).status).toBe(500);
    expect(forwardedError.message).toBe('customer profile request failed (TypeError)');
    expect(forwardedError.stack).not.toContain(NEW_EMAIL);
  });
});
