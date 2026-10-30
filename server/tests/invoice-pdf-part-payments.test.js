/**
 * Invoice PDF + send-card totals for a part-paid invoice (billing audit 2026-10-30, finding 1).
 *
 * The amount a customer still owes is invoiceAmountDue: total − credit_applied − amount_paid. The PDF used to subtract
 * only the credit, so a $100 invoice with $40 paid and $10 credit printed "Amount due $90.00" (owed: $50.00), and with
 * no credit it printed no amount due at all. TOTAL stays the original bill; the part payment is its own "Paid so far"
 * row. Receipts (paid/refunded rows, where the paid flip has zeroed amount_paid) keep their credit-only rows.
 */

const PDFDocument = require('pdfkit');
const { invoiceAmountDue } = require('../services/invoice-helpers');
const {
  buildInvoicePDFBuffer,
  buildReceiptPDFBuffer,
  invoiceBreakdownRows,
  invoiceTotalsFacts,
} = require('../services/pdf/invoice-pdf');

function invoice(overrides = {}) {
  return {
    invoice_number: 'WPC-TEST-PART',
    status: 'sent',
    subtotal: 100,
    discount_amount: 0,
    tax_amount: 0,
    total: 100,
    amount_paid: 40,
    credit_applied: 0,
    created_at: new Date('2026-10-30T12:00:00Z'),
    due_date: '2026-11-15',
    line_items: [{ description: 'Quarterly Pest Control', quantity: 1, unit_price: 100, amount: 100 }],
    customer: {
      first_name: 'Pat', last_name: 'Doe', address_line1: '1 Test St', city: 'Bradenton', state: 'FL', zip: '34209',
      property_type: 'residential',
    },
    ...overrides,
  };
}

async function renderedText(build) {
  const written = jest.spyOn(PDFDocument.prototype, 'text');
  try {
    const buffer = await build();
    expect(buffer.subarray(0, 4).toString()).toBe('%PDF');
    return written.mock.calls.map((args) => String(args[0]));
  } finally {
    written.mockRestore();
  }
}

// The value printed right after a label in the totals block (label and value are separate text() calls).
function valueAfter(texts, label) {
  const at = texts.lastIndexOf(label);
  return at === -1 ? undefined : texts[at + 1];
}

describe('invoice breakdown rows (the send card, in the PDF order)', () => {
  test('$40 paid, no credit: Paid so far and the $60 still owed', () => {
    expect(invoiceBreakdownRows(invoice(), invoice().customer)).toEqual([
      'Subtotal: $100.00',
      'Total: $100.00',
      'Paid so far: − $40.00',
      'Amount due: $60.00',
    ]);
  });

  test('$40 paid and $10 credit: Amount due is $50, not $90', () => {
    const inv = invoice({ credit_applied: 10 });
    expect(invoiceAmountDue(inv)).toBe(50);
    expect(invoiceBreakdownRows(inv, inv.customer)).toEqual([
      'Subtotal: $100.00',
      'Total: $100.00',
      'Account credit applied: − $10.00',
      'Paid so far: − $40.00',
      'Amount due: $50.00',
    ]);
  });

  test('credit only, nothing paid: rows unchanged', () => {
    const inv = invoice({ amount_paid: 0, credit_applied: 10 });
    expect(invoiceBreakdownRows(inv, inv.customer)).toEqual([
      'Subtotal: $100.00',
      'Total: $100.00',
      'Account credit applied: − $10.00',
      'Amount due: $90.00',
    ]);
  });

  test('neither credit nor a part payment: no deduction rows', () => {
    const inv = invoice({ amount_paid: 0 });
    expect(invoiceBreakdownRows(inv, inv.customer)).toEqual(['Subtotal: $100.00', 'Total: $100.00']);
  });

  test('a missing amount_paid column reads as nothing paid', () => {
    const inv = invoice();
    delete inv.amount_paid;
    expect(invoiceBreakdownRows(inv, inv.customer)).toEqual(['Subtotal: $100.00', 'Total: $100.00']);
  });

  test('amount due is computed in cents and never goes below zero', () => {
    expect(invoiceTotalsFacts(invoice({ total: 100.1, credit_applied: 33.33, amount_paid: 33.33 })).amountDue).toBe(33.44);
    expect(invoiceTotalsFacts(invoice({ total: 50, credit_applied: 30, amount_paid: 40 })).amountDue).toBe(0);
  });
});

describe('invoice PDF totals block', () => {
  test('$40 paid and $10 credit: prints Paid so far and Amount due $50.00, keeps TOTAL $100.00', async () => {
    const inv = invoice({ credit_applied: 10 });
    const texts = await renderedText(() => buildInvoicePDFBuffer(inv));
    expect(valueAfter(texts, 'TOTAL')).toBe('$100.00');
    expect(valueAfter(texts, 'Account credit applied')).toBe('− $10.00');
    expect(valueAfter(texts, 'Paid so far')).toBe('− $40.00');
    expect(valueAfter(texts, 'Amount due')).toBe('$50.00');
    expect(texts).not.toContain('$90.00');
  });

  test('$40 paid, no credit: prints Amount due $60.00 (it printed none before)', async () => {
    const texts = await renderedText(() => buildInvoicePDFBuffer(invoice()));
    expect(valueAfter(texts, 'TOTAL')).toBe('$100.00');
    expect(texts).not.toContain('Account credit applied');
    expect(valueAfter(texts, 'Paid so far')).toBe('− $40.00');
    expect(valueAfter(texts, 'Amount due')).toBe('$60.00');
  });

  test('nothing paid, no credit: no deduction rows', async () => {
    const texts = await renderedText(() => buildInvoicePDFBuffer(invoice({ amount_paid: 0 })));
    expect(texts).not.toContain('Paid so far');
    expect(texts).not.toContain('Amount due');
  });

  test('a receipt keeps its credit-only rows', async () => {
    const inv = invoice({ status: 'paid', paid_at: new Date('2026-10-30T15:00:00Z'), credit_applied: 10, amount_paid: 40 });
    const texts = await renderedText(() => buildReceiptPDFBuffer(inv, { amount: 90, refund_amount: 0 }));
    expect(texts).not.toContain('Paid so far');
    expect(valueAfter(texts, 'Amount due')).toBe('$90.00');
  });
});
