/**
 * The proof step of a customer-typed email change (services/customer-email-change-code.js): code shape, only a hash
 * stored, 15-minute expiry, wrong code adds an attempt, 5 attempts end the request (even for the right code), a code
 * works once (reuse), a new request replaces the open one, a code is bound to its own request, and the email copy.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'customer-email-change-code-test-secret';

const mockSendOne = jest.fn(async () => ({ messageId: 'm1' }));
jest.mock('../models/db', () => jest.fn());
const mockSuppressionRows = jest.fn(async () => []);
jest.mock('../services/email-template-library', () => ({
  activeSuppressionRows: (...a) => mockSuppressionRows(...a),
  GLOBAL_SUPPRESSION_TYPES: new Set(['bounce', 'spam_complaint', 'do_not_email']),
}));
jest.mock('../services/sendgrid-mail', () => ({ sendOne: (...a) => mockSendOne(...a) }));

// A tiny in-memory stand-in for the one table, with the few builder calls the service makes.
function makeTrx() {
  const rows = [];
  const trx = (table) => {
    if (table !== 'customer_email_change_requests') throw new Error(`unexpected table ${table}`);
    let filter = () => true;
    const b = {
      where: (cond) => { const prev = filter; filter = (r) => prev(r) && Object.entries(cond).every(([k, v]) => r[k] === v); return b; },
      whereNull: (col) => { const prev = filter; filter = (r) => prev(r) && r[col] == null; return b; },
      forUpdate: () => b,
      first: async () => rows.find(filter) || undefined,
      del: async () => { for (let i = rows.length - 1; i >= 0; i -= 1) if (filter(rows[i])) rows.splice(i, 1); },
      insert: async (row) => { rows.push({ attempts: 0, consumed_at: null, sent_at: null, ...row }); },
      update: async (patch) => { rows.filter(filter).forEach((r) => Object.assign(r, patch)); },
    };
    return b;
  };
  trx.fn = { now: () => 'NOW' };
  trx.rows = rows;
  return trx;
}

const Code = require('../services/customer-email-change-code');

const CUSTOMER = 'c1111111-1111-4111-8111-111111111111';
let trx;
beforeEach(() => { trx = makeTrx(); mockSendOne.mockClear(); mockSuppressionRows.mockReset().mockResolvedValue([]); jest.useRealTimers(); });
afterAll(() => jest.useRealTimers());

const ON_FILE = 'On.File@Example.test';
const issue = (email = 'New.Address@Example.test', fromEmail = ON_FILE) => Code.issueRequest(trx, { customerId: CUSTOMER, newEmail: email, fromEmail });
const check = (code, currentEmail = ON_FILE) => Code.checkCode(trx, { customerId: CUSTOMER, code, currentEmail });

describe('issueRequest', () => {
  test('a 6-digit code, 15 minutes, only an HMAC stored, address trimmed and lower-cased', async () => {
    const { id, code, expiresInMinutes } = await issue('  New.Address@Example.test ');
    expect(code).toMatch(/^\d{6}$/);
    expect(expiresInMinutes).toBe(15);
    const [row] = trx.rows;
    expect(row).toMatchObject({ id, customer_id: CUSTOMER, new_email: 'new.address@example.test', from_email: 'on.file@example.test', attempts: 0, consumed_at: null });
    expect(row.code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(code);
    expect(row.code_hash).toBe(Code.hashCode(id, code));
    const ms = new Date(row.expires_at).getTime() - Date.now();
    expect(ms).toBeGreaterThan(14.9 * 60 * 1000);
    expect(ms).toBeLessThanOrEqual(15 * 60 * 1000);
  });

  test('codes keep their leading zeros', () => {
    jest.spyOn(require('crypto'), 'randomInt').mockReturnValueOnce(42);
    expect(Code.generateCode()).toBe('000042');
    require('crypto').randomInt.mockRestore();
  });

  test('a new request replaces the open one (one open request per customer); the old code stops working', async () => {
    const first = await issue('first@example.test');
    const second = await issue('second@example.test');
    expect(trx.rows).toHaveLength(1);
    expect(trx.rows[0].id).toBe(second.id);
    expect((await check(first.code)).outcome).toBe('wrong');
  });

  test('another customer cannot use a code, and a hash is bound to its own request id', async () => {
    const { id, code } = await issue();
    expect((await Code.checkCode(trx, { customerId: 'c2222222-2222-4222-8222-222222222222', code, currentEmail: ON_FILE })).outcome).toBe('missing');
    expect(Code.hashCode('other-id', code)).not.toBe(Code.hashCode(id, code));
  });
});

describe('checkCode', () => {
  test('the right code is ok and reports the address it was sent to', async () => {
    const { id, code } = await issue();
    const res = await check(` ${code} `);
    expect(res.outcome).toBe('ok');
    expect(res.request).toMatchObject({ id, new_email: 'new.address@example.test' });
  });

  test('a wrong code adds one attempt and says how many are left', async () => {
    const { code } = await issue();
    const wrong = code === '000000' ? '111111' : '000000';
    const res = await check(wrong);
    expect(res).toMatchObject({ outcome: 'wrong', attemptsLeft: 4 });
    expect(trx.rows[0].attempts).toBe(1);
    expect((await check(code)).outcome).toBe('ok');
  });

  test('attempt cap: after 5 wrong codes even the right code is refused', async () => {
    const { code } = await issue();
    const wrong = code === '000000' ? '111111' : '000000';
    const lefts = [];
    for (let i = 0; i < 5; i += 1) lefts.push((await check(wrong)).attemptsLeft);
    expect(lefts).toEqual([4, 3, 2, 1, 0]);
    expect(Code.MAX_ATTEMPTS).toBe(5);
    expect((await check(code)).outcome).toBe('attempts');
    expect(trx.rows[0].attempts).toBe(5);
  });

  test('expiry: a right code at 14 minutes works; at 15 minutes it is expired', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-11-26T12:00:00Z'));
    const { code } = await issue();
    jest.setSystemTime(new Date('2026-11-26T12:14:00Z'));
    expect((await check(code)).outcome).toBe('ok');
    jest.setSystemTime(new Date('2026-11-26T12:15:00Z'));
    expect((await check(code)).outcome).toBe('expired');
  });

  test('stale: if the address on file moved after the code was sent, even the right code is refused and the request is consumed', async () => {
    const { code } = await issue();
    const res = await check(code, 'staff.corrected@example.test');
    expect(res.outcome).toBe('stale');
    expect(trx.rows[0].consumed_at).toBe('NOW');
    expect((await check(code)).outcome).toBe('missing');
  });

  test('stale is judged before the code: a wrong code on a moved address also reads stale and costs no attempt', async () => {
    await issue();
    expect((await check('000000', 'staff.corrected@example.test')).outcome).toBe('stale');
    expect(trx.rows[0].attempts).toBe(0);
  });

  test('the address on file compares trimmed and case-insensitively; none on file matches none', async () => {
    const a = await issue('n@example.test', '  ON.file@EXAMPLE.test ');
    expect((await check(a.code)).outcome).toBe('ok');
    const b = await issue('n@example.test', null);
    expect(trx.rows[0].from_email).toBeNull();
    expect((await check(b.code, '')).outcome).toBe('ok');
    const c = await issue('n@example.test', null);
    expect((await check(c.code, 'someone@example.test')).outcome).toBe('stale');
  });

  test('reuse: once consumed, the same code finds no open request', async () => {
    const { id, code } = await issue();
    expect((await check(code)).outcome).toBe('ok');
    await Code.consume(trx, id);
    expect(trx.rows[0].consumed_at).toBe('NOW');
    expect((await check(code)).outcome).toBe('missing');
  });

  test('no request at all is missing; a non-digit or empty code is just wrong', async () => {
    expect((await check('123456')).outcome).toBe('missing');
    await issue();
    expect((await check('')).outcome).toBe('wrong');
    expect((await check('abcdef')).outcome).toBe('wrong');
  });

  test('dropRequest and markSent', async () => {
    const { id } = await issue();
    await Code.markSent(trx, id);
    expect(trx.rows[0].sent_at).toBe('NOW');
    await Code.dropRequest(trx, id);
    expect(trx.rows).toHaveLength(0);
  });
});

describe('addressSuppressed (the sender\'s own global test)', () => {
  test.each([
    ['bounce', { suppression_type: 'bounce', group_key: 'service_operational' }],
    ['spam complaint', { suppression_type: 'spam_complaint', group_key: 'marketing_newsletter' }],
    ['do not email', { suppression_type: 'do_not_email', group_key: null }],
    ['a global unsubscribe (no group)', { suppression_type: 'unsubscribe', group_key: null }],
  ])('%s blocks the code', async (_l, row) => {
    mockSuppressionRows.mockResolvedValue([row]);
    expect(await Code.addressSuppressed(trx, 'x@example.test')).toBe(true);
    expect(mockSuppressionRows).toHaveBeenCalledWith('x@example.test', trx);
  });

  test('a list-only row (marketing newsletter unsubscribe) and no rows do not block a one-time code', async () => {
    mockSuppressionRows.mockResolvedValue([{ suppression_type: 'unsubscribe', group_key: 'marketing_newsletter' }]);
    expect(await Code.addressSuppressed(trx, 'x@example.test')).toBe(false);
    mockSuppressionRows.mockResolvedValue([]);
    expect(await Code.addressSuppressed(trx, 'x@example.test')).toBe(false);
  });

  test('the provider handoff re-checks: a suppression added since the request was stored stops the send', async () => {
    await Code.sendCode({ to: 'x@example.test', code: '123456' });
    const { providerBoundaryCheck } = mockSendOne.mock.calls[0][0];
    await expect(providerBoundaryCheck()).resolves.toEqual({ ok: true });
    mockSuppressionRows.mockResolvedValue([{ suppression_type: 'do_not_email', group_key: null }]);
    await expect(providerBoundaryCheck()).rejects.toMatchObject({ code: 'address_suppressed' });
  });
});

describe('the code email', () => {
  test('short plain copy with the code and the 15 minutes, to the NEW address, tracking off, no name', async () => {
    const mail = Code.buildCodeEmail('123456');
    expect(mail.text).toContain('Your Waves code to confirm this email is 123456. It expires in 15 minutes.');
    expect(mail.html).toContain('123456');
    await Code.sendCode({ to: 'new.address@example.test', code: '123456' });
    expect(mockSendOne).toHaveBeenCalledTimes(1);
    expect(mockSendOne.mock.calls[0][0]).toMatchObject({ to: 'new.address@example.test', disableTracking: true, categories: ['customer_email_change_code'] });
    expect(mockSendOne.mock.calls[0][0].text).not.toMatch(/Hi |Pat|Sample/);
  });

  test('a provider failure is thrown so the route can drop the request', async () => {
    mockSendOne.mockRejectedValueOnce(new Error('SendGrid 500'));
    await expect(Code.sendCode({ to: 'new.address@example.test', code: '123456' })).rejects.toThrow('SendGrid 500');
  });
});
