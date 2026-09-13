const { invoiceAddressSnapshot, invoiceCustomerAddress } = require('../services/invoice-address');

test('a document snapshot preserves address while contact and payer authority remain live', () => {
  const original = { address_line1: '100 Example Grove', city: 'Sarasota', state: 'FL', zip: '34201' };
  const invoice = { customer_address_snapshot: invoiceAddressSnapshot(original) };
  const live = { ...original, address_line1: '300 Example Grove', email: 'current@example.test' };
  expect(invoiceCustomerAddress(invoice, live)).toMatchObject({ address_line1: '100 Example Grove', email: 'current@example.test' });
  expect(invoiceCustomerAddress({}, live)).toBe(live);
});

test('actual invoice and receipt PDFs use the saved address when passed a live customer by email/project callers', async () => {
  const PDFDocument = require('pdfkit');
  const written = jest.spyOn(PDFDocument.prototype, 'text');
  try {
    const invoice = { invoice_number: 'QA-DOCUMENT', status: 'paid', total: 89, subtotal: 89,
      created_at: new Date(), paid_at: new Date(), line_items: [],
      customer_address_snapshot: invoiceAddressSnapshot({ address_line1: '100 Example Grove', city: 'Sarasota', state: 'FL', zip: '34201' }),
      customer: { first_name: 'Synthetic', last_name: 'Fixture', address_line1: '300 Example Grove', city: 'Sarasota', state: 'FL', zip: '34201' } };
    const pdf = require('../services/pdf/invoice-pdf');
    for (const build of [() => pdf.buildInvoicePDFBuffer(invoice), () => pdf.buildReceiptPDFBuffer(invoice, null)]) {
      written.mockClear();
      const buffer = await build();
      expect(buffer.subarray(0, 4).toString()).toBe('%PDF');
      const text = written.mock.calls.map(args => String(args[0])).join('\n');
      expect(text).toContain('100 Example Grove');
      expect(text).not.toContain('300 Example Grove');
    }
  } finally { written.mockRestore(); }
});
