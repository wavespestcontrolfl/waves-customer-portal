// 2026-10-05: emailed receipts from a vendor's subdomain landed as
// "Unknown Vendor" (the mapping lists the company domain), and the same
// receipt mailed twice became two expenses. All values here are synthetic.
const mockCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({ messages: { create: mockCreate } })));
const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('../services/logger', () => mockLogger);
jest.mock('../services/email/gmail-client', () => ({ getAttachment: jest.fn(async () => Buffer.from('%PDF-1.7 test')) }));

const mockWrites = [];
const mockState = { vendors: [], duplicate: null, categories: [] };
jest.mock('../models/db', () => {
  const chain = (table) => {
    const filters = {};
    const q = {
      where: (a) => { if (a && typeof a === 'object') Object.assign(filters, a); return q; },
      whereILike: (col, pat) => { filters.ilike = pat; return q; },
      whereIn: (col, vals) => { filters.in = vals; return q; },
      whereRaw: (sql, binds) => { filters.raw = [sql, binds]; return q; },
      first: async () => {
        if (table === 'expenses') { mockState.lastDuplicateFilter = { ...filters }; return mockState.duplicate; }
        if (table === 'expense_categories') return mockState.categories.find((c) => filters.ilike && c.name.toLowerCase().includes(filters.ilike.replace(/%/g, '').toLowerCase())) || null;
        return null;
      },
      update: async (row) => { mockWrites.push([table, 'update', row]); return 1; },
      insert: (row) => { mockWrites.push([table, 'insert', row]); return { returning: async () => [{ id: 'exp-1' }] }; },
      then: (resolve) => resolve(
        table === 'email_attachments' ? [{ id: 'att-1', mime_type: 'application/pdf', gmail_attachment_id: 'g-1' }]
          : table === 'vendor_email_domains' ? mockState.vendors.filter((v) => (filters.in || []).includes(v.domain))
            : [],
      ),
    };
    return q;
  };
  const mockDb = jest.fn(chain);
  mockDb.transaction = async (cb) => { const trx = (t) => chain(t); trx.raw = async () => {}; return cb(trx); };
  return mockDb;
});
jest.mock('../services/expense-categorizer', () => ({ autoCategorizeExpense: jest.fn(async () => null), categoryDeductibleAmount: () => null }));

const { processVendorInvoice, senderDomainCandidates } = require('../services/email/invoice-processor');

const extraction = (fields) => mockCreate.mockResolvedValue({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(fields) }] });
const inserted = () => mockWrites.find(([t, op]) => t === 'expenses' && op === 'insert')?.[2];
const noPdf = () => mockCreate.mockRejectedValue(new Error('no pdf parse'));

beforeEach(() => {
  mockWrites.length = 0; mockCreate.mockReset(); Object.values(mockLogger).forEach((f) => f.mockClear());
  mockState.vendors = [{ domain: 'acme-cloud.example', vendor_name: 'Acme Cloud', expense_category: 'Software & Technology' }];
  mockState.duplicate = null;
  mockState.lastDuplicateFilter = undefined;
  mockState.categories = [{ id: 'cat-sw', name: 'Software & Technology' }];
});

test('sender domain candidates drop leading labels only', () => {
  expect(senderDomainCandidates('billing@mail.acme-cloud.example')).toEqual(['mail.acme-cloud.example', 'acme-cloud.example']);
  expect(senderDomainCandidates('x@acme-cloud.example.evil.example')).toEqual(['acme-cloud.example.evil.example', 'example.evil.example', 'evil.example']);
  expect(senderDomainCandidates('nobody')).toEqual([]);
});

test('a receipt from a mapped company subdomain takes the mapped vendor and category', async () => {
  extraction({ vendor_name: 'Acme Cloud, Inc.', invoice_number: 'TEST-0001', invoice_date: '2026-01-15', total: 12.34 });
  await processVendorInvoice({ id: 'e1', gmail_id: 'g', from_address: 'billing@mail.acme-cloud.example', subject: 'Your receipt' }, { extracted: {} });
  expect(inserted()).toEqual(expect.objectContaining({ vendor_name: 'Acme Cloud', category_id: 'cat-sw', amount: 12.34 }));
});

test('an old seeded category label is read as the real category', async () => {
  mockState.vendors = [{ domain: 'acme-cloud.example', vendor_name: 'Acme Cloud', expense_category: 'Software & Services' }];
  extraction({ invoice_number: 'TEST-0002', invoice_date: '2026-01-15', total: 12.34 });
  await processVendorInvoice({ id: 'e2', gmail_id: 'g', from_address: 'billing@mail.acme-cloud.example', subject: 'Your receipt' }, { extracted: {} });
  expect(inserted()).toEqual(expect.objectContaining({ vendor_name: 'Acme Cloud', category_id: 'cat-sw' }));
});

test('a look-alike domain does not take the mapping', async () => {
  extraction({ vendor_name: 'Acme Cloud, Inc.', invoice_number: 'TEST-0003', invoice_date: '2026-01-15', total: 99 });
  await processVendorInvoice({ id: 'e3', gmail_id: 'g', from_address: 'billing@acme-cloud.example.evil.example', subject: 'Invoice' }, { extracted: {} });
  expect(inserted()).toEqual(expect.objectContaining({ category_id: null }));
});

test('an unmapped sender takes the vendor name printed on the invoice', async () => {
  extraction({ vendor_name: 'Example Data Co', invoice_number: 'TEST-0004', invoice_date: '2026-01-15', total: 45 });
  await processVendorInvoice({ id: 'e4', gmail_id: 'g', from_address: 'receipts@pay-platform.example', subject: 'Your receipt' }, { extracted: {} });
  expect(inserted()).toEqual(expect.objectContaining({ vendor_name: 'Example Data Co', category_id: null }));
});

test('a placeholder name on the invoice falls through to "Unknown Vendor"', async () => {
  extraction({ vendor_name: 'string', invoice_number: 'TEST-0005', invoice_date: '2026-01-15', total: 5 });
  await processVendorInvoice({ id: 'e5', gmail_id: 'g', from_address: 'a@b.example', subject: 'Invoice' }, { extracted: {} });
  expect(inserted().vendor_name).toBe('Unknown Vendor');
});

test('an HTML-only receipt from an unmapped sender takes the sender display name', async () => {
  noPdf();
  await processVendorInvoice({ id: 'e6', gmail_id: 'g', from_address: 'no-reply@mailer.example', from_name: 'Example Mailer', subject: 'Payment received' },
    { extracted: { invoice_amount: '19.99', invoice_date: '2026-01-15' } });
  expect(inserted()).toEqual(expect.objectContaining({ vendor_name: 'Example Mailer', amount: 19.99 }));
});

test('the same receipt mailed twice links to the first expense instead of inserting a second', async () => {
  mockState.duplicate = { id: 'exp-earlier' };
  extraction({ vendor_name: 'Example Payments', invoice_number: '9000000001', invoice_date: '2026-01-15', total: 11.11 });
  await processVendorInvoice({ id: 'e7', gmail_id: 'g', from_address: 'p@payments.example', subject: 'Invoice' }, { extracted: {} });
  expect(inserted()).toBeUndefined();
  expect(mockWrites).toContainEqual(['emails', 'update', expect.objectContaining({ expense_id: 'exp-earlier', auto_action: 'expense_duplicate:11.11' })]);
});

test.each([
  ['the sender display name', { from_name: 'Example Forwarder' }, { invoice_number: 'TEST-0008', invoice_amount: '50.00', invoice_date: '2026-01-15' }],
  ['the classifier guess', {}, { vendor_name: 'Example Platform', invoice_number: 'TEST-0009', invoice_amount: '50.00', invoice_date: '2026-01-15' }],
  ['no name at all', {}, { invoice_number: 'TEST-0010', invoice_amount: '50.00', invoice_date: '2026-01-15' }],
])('a vendor name from %s never drives a duplicate match', async (_label, emailExtra, extracted) => {
  mockState.duplicate = { id: 'exp-other-merchant' };
  noPdf();
  await processVendorInvoice({ id: 'e8', gmail_id: 'g', from_address: 'a@unmapped.example', subject: 'Invoice', ...emailExtra }, { extracted });
  expect(inserted()).toEqual(expect.objectContaining({ amount: 50 }));
  expect(mockState.lastDuplicateFilter).toBeUndefined();
});

test('a non-scalar invoice number never drives the duplicate check', async () => {
  mockState.duplicate = { id: 'exp-object' };
  extraction({ vendor_name: 'Example Payments', invoice_date: '2026-01-15', total: 20 });
  await processVendorInvoice({ id: 'e9', gmail_id: 'g', from_address: 'p@payments.example', subject: 'Invoice' },
    { extracted: { invoice_number: { id: 1 } } });
  expect(inserted()).toEqual(expect.objectContaining({ amount: 20 }));
});

test('the duplicate lookup compares the whole description, the date and the amount rounded by Postgres', async () => {
  extraction({ vendor_name: 'Example Payments', invoice_number: '12', invoice_date: '2026-01-15', total: 16.804 });
  await processVendorInvoice({ id: 'e10', gmail_id: 'g', from_address: 'p@payments.example', subject: 'Invoice' }, { extracted: {} });
  expect(mockState.lastDuplicateFilter).toEqual(expect.objectContaining({
    vendor_name: 'Example Payments', expense_date: '2026-01-15', description: 'Example Payments Invoice #12 — via email',
    raw: ['amount = round(?::numeric, 2)', ['16.804']],
  }));
});

test('no duplicate check runs when the vendor name or description would be clipped', async () => {
  mockState.duplicate = { id: 'exp-clipped' };
  mockState.vendors = [{ domain: 'acme-cloud.example', vendor_name: 'V'.repeat(250), expense_category: 'Software & Technology' }];
  extraction({ invoice_number: 'TEST-0011', invoice_date: '2026-01-15', total: 16.8 });
  await processVendorInvoice({ id: 'e11', gmail_id: 'g', from_address: 'billing@acme-cloud.example', subject: 'Invoice' }, { extracted: {} });
  expect(inserted()).toEqual(expect.objectContaining({ amount: 16.8 }));
  expect(mockState.lastDuplicateFilter).toBeUndefined();
});

test('the log lines carry ids, never the vendor name', async () => {
  noPdf();
  await processVendorInvoice({ id: 'e13', gmail_id: 'g', from_address: 'a@unmapped.example', from_name: 'Pat Example', subject: 'Receipt' },
    { extracted: { invoice_amount: '30.00', invoice_date: '2026-01-15' } });
  const logged = JSON.stringify([...mockLogger.info.mock.calls, ...mockLogger.warn.mock.calls, ...mockLogger.error.mock.calls]);
  expect(inserted()).toEqual(expect.objectContaining({ vendor_name: 'Pat Example' }));
  expect(logged).not.toContain('Pat Example');
});
