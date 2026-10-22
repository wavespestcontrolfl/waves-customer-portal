// GATE_EMAIL_AUTH_STRICT (security audit run 2): hasAlignedAuth must read only
// real Authentication-Results method results, and a vendor invoice books an
// expense only when the sender authenticated as its From domain.
const mockCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({ messages: { create: mockCreate } })));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/email/gmail-client', () => ({ getAttachment: jest.fn(async () => Buffer.from('%PDF-1.7 test')) }));

const mockWrites = [];
let mockExpenseExists = false;
jest.mock('../models/db', () => {
  const chain = (table) => {
    const q = {
      where: () => q, whereILike: () => q, whereIn: () => q, whereRaw: () => q, forUpdate: () => q,
      first: async () => (table === 'expenses' && mockExpenseExists ? { id: 'exp-9' } : null),
      update: async (row) => { mockWrites.push([table, 'update', row]); return 1; },
      insert: (row) => { mockWrites.push([table, 'insert', row]); return { returning: async () => [{ id: 'exp-1' }] }; },
      then: (resolve) => resolve([]),
    };
    return q;
  };
  const mockDb = jest.fn(chain);
  mockDb.transaction = async (cb) => { const trx = (t) => chain(t); trx.raw = async () => {}; return cb(trx); };
  return mockDb;
});

const { hasAlignedAuth } = require('../services/email/inbox-hygiene');
const { processVendorInvoice } = require('../services/email/invoice-processor');

const FORGED = 'mx.google.com; dkim=none; spf=pass (google.com: domain of "x dkim=pass header.d=victim.example y"@evil.example designates 192.0.2.1 as permitted sender) smtp.mailfrom="x dkim=pass header.d=victim.example y"@evil.example';
const REAL_DKIM = 'mx.google.com; dkim=pass header.i=@victim.example header.s=s1 header.b=abc; spf=pass (google.com: domain of bounce@victim.example designates 192.0.2.1 as permitted sender) smtp.mailfrom=bounce@victim.example; dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=victim.example';
const REAL_SPF = 'mx.google.com; dkim=none; spf=pass (google.com: domain of bounce@victim.example designates 192.0.2.1 as permitted sender) smtp.mailfrom=bounce@victim.example';

const GATE = 'GATE_EMAIL_AUTH_STRICT';
afterEach(() => { delete process.env[GATE]; });

describe('hasAlignedAuth, gate off', () => {
  test('quoted-local-part forgery is still accepted (unchanged behavior)', () => {
    expect(hasAlignedAuth(FORGED, 'victim.example')).toBe(true);
  });
  test('real passes still pass', () => {
    expect(hasAlignedAuth(REAL_DKIM, 'victim.example')).toBe(true);
    expect(hasAlignedAuth(REAL_SPF, 'victim.example')).toBe(true);
  });
});

describe('hasAlignedAuth, gate on', () => {
  beforeEach(() => { process.env[GATE] = 'true'; });

  test('quoted-local-part forgery is rejected for the victim domain', () => {
    expect(hasAlignedAuth(FORGED, 'victim.example')).toBe(false);
  });
  test('forgery in a comment only is rejected', () => {
    expect(hasAlignedAuth('mx.google.com; dkim=none; spf=fail (google.com: dkim=pass header.d=victim.example)', 'victim.example')).toBe(false);
  });
  test('a comment with a quote makes the whole header untrusted', () => {
    expect(hasAlignedAuth('mx.google.com; dkim=pass header.d=victim.example (x "y)', 'victim.example')).toBe(false);
  });
  test('real DKIM and SPF passes aligned with the From domain pass', () => {
    expect(hasAlignedAuth(REAL_DKIM, 'victim.example')).toBe(true);
    expect(hasAlignedAuth(REAL_SPF, 'victim.example')).toBe(true);
    expect(hasAlignedAuth('mx.google.com; dkim=pass header.d=mail.victim.example', 'news.victim.example')).toBe(true);
  });
  test('a pass for another domain, a failed method or a foreign authserv-id is rejected', () => {
    expect(hasAlignedAuth('mx.google.com; dkim=pass header.d=attacker.example', 'victim.example')).toBe(false);
    expect(hasAlignedAuth('mx.google.com; dkim=fail header.d=victim.example', 'victim.example')).toBe(false);
    expect(hasAlignedAuth('evil.example; dkim=pass header.d=victim.example', 'victim.example')).toBe(false);
    expect(hasAlignedAuth('', 'victim.example')).toBe(false);
    expect(hasAlignedAuth(null, 'victim.example')).toBe(false);
  });
});

describe('processVendorInvoice authentication', () => {
  const CLASSIFICATION = { extracted: { vendor_name: 'Acme', invoice_amount: '412.50', payment_status: 'paid', invoice_number: 'INV-1', invoice_date: '2026-09-20' } };
  const email = (auth) => ({ id: 'email-1', gmail_id: 'gm-1', from_address: 'billing@victim.example', subject: 'Invoice', authentication_results: auth });
  const inserted = () => mockWrites.find(([t, op]) => t === 'expenses' && op === 'insert');

  beforeEach(() => { mockWrites.length = 0; mockCreate.mockReset(); mockExpenseExists = false; });

  test('gate off: an unauthenticated sender still books (unchanged)', async () => {
    await processVendorInvoice(email(FORGED), CLASSIFICATION);
    expect(inserted()).toBeDefined();
  });

  test('gate on: an unauthenticated sender books nothing and is marked for review', async () => {
    process.env[GATE] = 'true';
    await processVendorInvoice(email(FORGED), CLASSIFICATION);
    expect(inserted()).toBeUndefined();
    expect(mockWrites).toContainEqual(['emails', 'update', expect.objectContaining({ auto_action: 'invoice_detected:unauthenticated' })]);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('gate on: a missing Authentication-Results header books nothing', async () => {
    process.env[GATE] = 'true';
    await processVendorInvoice(email(null), CLASSIFICATION);
    expect(inserted()).toBeUndefined();
  });

  test('gate on: an email whose expense still exists keeps its outcome when reprocessed unauthenticated', async () => {
    process.env[GATE] = 'true';
    mockExpenseExists = true;
    await processVendorInvoice({ ...email(null), expense_id: 'exp-9' }, CLASSIFICATION);
    expect(inserted()).toBeUndefined();
    expect(mockWrites.find(([t, op]) => t === 'emails' && op === 'update')).toBeUndefined();
  });

  test('gate on: a stale expense_id (expense deleted) is treated as unbooked and marked unauthenticated', async () => {
    process.env[GATE] = 'true';
    mockExpenseExists = false;
    await processVendorInvoice({ ...email(null), expense_id: 'exp-gone' }, CLASSIFICATION);
    expect(inserted()).toBeUndefined();
    // the stale link is cleared with the marker, so the row reads not logged
    expect(mockWrites).toContainEqual(['emails', 'update', expect.objectContaining({ auto_action: 'invoice_detected:unauthenticated', expense_id: null })]);
  });

  test('gate on: a sender that authenticated as its From domain still books', async () => {
    process.env[GATE] = 'true';
    await processVendorInvoice(email(REAL_DKIM), CLASSIFICATION);
    expect(inserted()).toEqual(['expenses', 'insert', expect.objectContaining({ amount: 412.5 })]);
  });
});
