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

describe('staff correction of one invoice address', () => {
  const { normalizeInvoiceAddressInput, correctInvoiceAddress } = require('../services/invoice-address');

  // Minimal knex-shaped fake: records every update; reads answer from rows.
  function fakeTrx(rows) {
    const updates = [];
    const trx = (table) => {
      const q = {
        where: (criteria) => { q.criteria = criteria; return q; },
        forUpdate: () => q,
        first: async () => (rows[table] || []).find((r) => Object.entries(q.criteria).every(([k, v]) => r[k] === v)) || null,
        update: async (patch) => { updates.push({ table, criteria: q.criteria, patch }); return 1; },
      };
      return q;
    };
    trx.fn = { now: () => 'NOW()' };
    return { trx, updates };
  }

  test('normalizes a complete address and refuses an incomplete or malformed one', () => {
    // Line 2 is always cleared: receipts print line 1 only, so the unit rides there.
    expect(normalizeInvoiceAddressInput({ address_line1: ' 12  Corrected Way Apt 2 ', address_line2: 'Apt 9', city: 'Bradenton', state: 'fl', zip: '34203' }))
      .toEqual({ address_line1: '12 Corrected Way Apt 2', address_line2: null, city: 'Bradenton', state: 'FL', zip: '34203' });
    for (const bad of [
      { city: 'Bradenton', state: 'FL', zip: '34203' },
      { address_line1: '12 Corrected Way', city: 'Bradenton', state: 'Florida', zip: '34203' },
      { address_line1: '12 Corrected Way', city: 'Bradenton', state: 'FL', zip: '3420' },
    ]) {
      expect(() => normalizeInvoiceAddressInput(bad)).toThrow(expect.objectContaining({ statusCode: 400, code: 'invalid_address' }));
    }
  });

  test('rewrites only the snapshot on that invoice and reports what the documents showed before', async () => {
    const { trx, updates } = fakeTrx({
      invoices: [{ id: 'inv-1', customer_id: 'cust-1', customer_address_snapshot: null }],
      customers: [{ id: 'cust-1', address_line1: '100 Wrong St', address_line2: null, city: 'Sarasota', state: 'FL', zip: '34201' }],
    });
    const result = await correctInvoiceAddress(trx, 'inv-1', { address_line1: '12 Corrected Way', city: 'Bradenton', state: 'FL', zip: '34203' });
    expect(result.before).toMatchObject({ address_line1: '100 Wrong St', city: 'Sarasota' });
    expect(result.after).toMatchObject({ address_line1: '12 Corrected Way', city: 'Bradenton', address_line2: null });
    expect(result.after.corrected_at).toEqual(expect.any(String));
    expect(updates).toEqual([{
      table: 'invoices',
      criteria: { id: 'inv-1' },
      patch: { customer_address_snapshot: result.after, updated_at: 'NOW()' },
    }]);
    // What the receipt/PDF then render: the corrected snapshot over the live customer.
    expect(invoiceCustomerAddress({ customer_address_snapshot: result.after }, { first_name: 'A', address_line1: '100 Wrong St' }))
      .toMatchObject({ first_name: 'A', address_line1: '12 Corrected Way', city: 'Bradenton' });
  });

  test('an unknown invoice writes nothing; a malformed address is refused before any read', async () => {
    const { trx, updates } = fakeTrx({ invoices: [], customers: [] });
    expect(await correctInvoiceAddress(trx, 'missing', { address_line1: '1 A St', city: 'X', state: 'FL', zip: '34201' })).toBeNull();
    await expect(correctInvoiceAddress(trx, 'missing', { address_line1: '1 A St' })).rejects.toMatchObject({ statusCode: 400 });
    expect(updates).toEqual([]);
  });
});
