// Codex r18 on #4884: a parsed total of 0 (a zero-total invoice or credit
// memo) is the extraction's answer — `total || classifier amount` treated it
// as missing and created an expense for the classifier's figure.
const mockCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({ messages: { create: mockCreate } })));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/email/gmail-client', () => ({ getAttachment: jest.fn(async () => Buffer.from('%PDF-1.7 test')) }));

const mockWrites = [];
jest.mock('../models/db', () => {
  const chain = (table) => {
    const q = {
      where: () => q, whereILike: () => q,
      first: async () => null,
      update: async (row) => { mockWrites.push([table, 'update', row]); return 1; },
      insert: (row) => { mockWrites.push([table, 'insert', row]); return { returning: async () => [{ id: 'exp-1' }] }; },
      then: (resolve) => resolve(table === 'email_attachments' ? [{ id: 'att-1', mime_type: 'application/pdf', gmail_attachment_id: 'g-1' }] : []),
    };
    return q;
  };
  return jest.fn(chain);
});

const { processVendorInvoice } = require('../services/email/invoice-processor');

const EMAIL = { id: 'email-1', gmail_id: 'gm-1', from_address: 'billing@acme.example', subject: 'Credit memo CM-7' };
const CLASSIFICATION = { extracted: { vendor_name: 'Acme', invoice_amount: '412.50' } };
const extraction = (fields) => mockCreate.mockResolvedValue({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(fields) }] });

beforeEach(() => { mockWrites.length = 0; mockCreate.mockReset(); });

test('a zero-total extraction creates no expense (the classifier amount is not substituted)', async () => {
  extraction({ invoice_number: 'CM-7', invoice_date: '2026-09-20', total: '0' });
  await processVendorInvoice(EMAIL, CLASSIFICATION);
  expect(mockWrites.find(([t, op]) => t === 'expenses' && op === 'insert')).toBeUndefined();
  expect(mockWrites).toContainEqual(['emails', 'update', expect.objectContaining({ auto_action: 'invoice_detected:no_amount' })]);
});

test('a missing total still falls back to the classifier amount', async () => {
  extraction({ invoice_number: 'INV-9', invoice_date: '2026-09-20' });
  await processVendorInvoice(EMAIL, CLASSIFICATION);
  expect(mockWrites.find(([t, op]) => t === 'expenses' && op === 'insert')).toEqual(['expenses', 'insert', expect.objectContaining({ amount: 412.5 })]);
});

test('a long vendor name / classifier invoice number is clipped to the expense columns, not a failed insert', async () => {
  extraction({ invoice_date: '2026-09-20', total: 25 });
  await processVendorInvoice(EMAIL, { extracted: { vendor_name: 'V'.repeat(250), invoice_number: 'N'.repeat(400) } });
  const [, , row] = mockWrites.find(([t, op]) => t === 'expenses' && op === 'insert');
  expect(row.description.length).toBeLessThanOrEqual(300);
  expect(row.vendor_name.length).toBeLessThanOrEqual(200);
});

test('a classifier date taxPeriodFor cannot place falls back to today (date and period) instead of throwing', async () => {
  extraction({ total: 25 });
  await processVendorInvoice(EMAIL, { extracted: { vendor_name: 'Acme', invoice_date: '0012-06-01' } });
  const insert = mockWrites.find(([t, op]) => t === 'expenses' && op === 'insert');
  expect(insert).toBeDefined();
  const [, , row] = insert;
  expect(row.expense_date).not.toBe('0012-06-01');
  expect(row.tax_year).toBe(row.expense_date.slice(0, 4));
});
