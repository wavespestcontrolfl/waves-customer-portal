// 2026-10-05: emailed receipts landed as "Unknown Vendor" (334 Anthropic
// receipts from mail.anthropic.com while the mapping lists anthropic.com),
// and the same receipt mailed twice became two expenses.
const mockCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({ messages: { create: mockCreate } })));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
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
  return jest.fn(chain);
});
jest.mock('../services/expense-categorizer', () => ({ autoCategorizeExpense: jest.fn(async () => null), categoryDeductibleAmount: () => null }));

const { processVendorInvoice, senderDomainCandidates } = require('../services/email/invoice-processor');

const extraction = (fields) => mockCreate.mockResolvedValue({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(fields) }] });
const inserted = () => mockWrites.find(([t, op]) => t === 'expenses' && op === 'insert')?.[2];

beforeEach(() => {
  mockWrites.length = 0; mockCreate.mockReset();
  mockState.vendors = [{ domain: 'anthropic.com', vendor_name: 'Anthropic', expense_category: 'Software & Technology' }];
  mockState.duplicate = null;
  mockState.categories = [{ id: 'cat-sw', name: 'Software & Technology' }];
});

test('sender domain candidates drop leading labels only', () => {
  expect(senderDomainCandidates('invoice+statements@mail.anthropic.com')).toEqual(['mail.anthropic.com', 'anthropic.com']);
  expect(senderDomainCandidates('x@anthropic.com.evil.example')).toEqual(['anthropic.com.evil.example', 'com.evil.example', 'evil.example']);
  expect(senderDomainCandidates('nobody')).toEqual([]);
});

test('a receipt from a mapped company subdomain takes the mapped vendor and category', async () => {
  extraction({ vendor_name: 'Anthropic, PBC', invoice_number: '25WSLCSD-0300', invoice_date: '2026-10-04', total: 10.12 });
  await processVendorInvoice({ id: 'e1', gmail_id: 'g', from_address: 'invoice+statements@mail.anthropic.com', subject: 'Your receipt' }, { extracted: {} });
  expect(inserted()).toEqual(expect.objectContaining({ vendor_name: 'Anthropic', category_id: 'cat-sw', amount: 10.12 }));
});

test('a look-alike domain does not take the mapping', async () => {
  extraction({ vendor_name: 'Anthropic, PBC', invoice_number: 'X1', invoice_date: '2026-10-04', total: 99 });
  await processVendorInvoice({ id: 'e2', gmail_id: 'g', from_address: 'billing@anthropic.com.evil.example', subject: 'Invoice' }, { extracted: {} });
  expect(inserted()).toEqual(expect.objectContaining({ category_id: null }));
});

test('an unmapped sender takes the vendor name printed on the invoice, not "Unknown Vendor"', async () => {
  extraction({ vendor_name: 'RentCast', invoice_number: '2032-6714', invoice_date: '2026-04-27', total: 144 });
  await processVendorInvoice({ id: 'e3', gmail_id: 'g', from_address: 'receipts@stripe.com', subject: 'Your receipt from RentCast' }, { extracted: {} });
  expect(inserted()).toEqual(expect.objectContaining({ vendor_name: 'RentCast', category_id: null }));
});

test('a placeholder name on the invoice falls through to the classifier, then to "Unknown Vendor"', async () => {
  extraction({ vendor_name: 'string', invoice_number: 'A1', invoice_date: '2026-09-01', total: 5 });
  await processVendorInvoice({ id: 'e4', gmail_id: 'g', from_address: 'a@b.example', subject: 'Invoice' }, { extracted: {} });
  expect(inserted().vendor_name).toBe('Unknown Vendor');
});

test('the same receipt mailed twice links to the first expense instead of inserting a second', async () => {
  mockState.duplicate = { id: 'exp-earlier' };
  extraction({ vendor_name: 'Google', invoice_number: '5639331278', invoice_date: '2026-09-01', total: 16.8 });
  await processVendorInvoice({ id: 'e5', gmail_id: 'g', from_address: 'payments-noreply@google.com', subject: 'Invoice' }, { extracted: {} });
  expect(inserted()).toBeUndefined();
  expect(mockWrites).toContainEqual(['emails', 'update', expect.objectContaining({ expense_id: 'exp-earlier', auto_action: 'expense_duplicate:16.8' })]);
});

test('an unknown vendor is never treated as a duplicate (unrelated senders share the label)', async () => {
  mockState.duplicate = { id: 'exp-other-vendor' };
  extraction({ invoice_number: '1001', invoice_date: '2026-09-01', total: 50 });
  await processVendorInvoice({ id: 'e6', gmail_id: 'g', from_address: 'a@unmapped.example', subject: 'Invoice' }, { extracted: {} });
  expect(inserted()).toEqual(expect.objectContaining({ vendor_name: 'Unknown Vendor', amount: 50 }));
});

test('the duplicate lookup compares the whole description, so a longer invoice number never matches', async () => {
  extraction({ vendor_name: 'Google', invoice_number: '12', invoice_date: '2026-09-01', total: 16.8 });
  await processVendorInvoice({ id: 'e7', gmail_id: 'g', from_address: 'p@google.com', subject: 'Invoice' }, { extracted: {} });
  expect(mockState.lastDuplicateFilter).toEqual(expect.objectContaining({ vendor_name: 'Google', amount: 16.8, description: 'Google Invoice #12 — via email' }));
});

test('no duplicate check runs when the description would be clipped', async () => {
  mockState.duplicate = { id: 'exp-clipped' };
  extraction({ vendor_name: 'Google', invoice_number: 'N'.repeat(400), invoice_date: '2026-09-01', total: 16.8 });
  await processVendorInvoice({ id: 'e8', gmail_id: 'g', from_address: 'p@google.com', subject: 'Invoice' }, { extracted: {} });
  expect(inserted()).toEqual(expect.objectContaining({ vendor_name: 'Google', amount: 16.8 }));
});
