/**
 * Invoice PDF "Previous balance" block. The callers (invoice email, pay-page
 * download) decide eligibility and attach invoice.previous_balance; the PDF
 * prints it under this invoice's own totals, never folded into TOTAL. No
 * previous_balance, or a settled invoice, renders exactly as before.
 */

jest.mock('../models/db', () => jest.fn());

const PDFDocument = require('pdfkit');
const { buildInvoicePDFBuffer } = require('../services/pdf/invoice-pdf');

const previousBalance = {
  invoices: [
    { invoiceNumber: 'INV-OLD-1', serviceType: 'Quarterly Pest Control', serviceDate: '2026-08-01', dueDate: '2026-08-15', pastDue: true, amountDue: 200.1 },
    { invoiceNumber: 'INV-OLD-2', serviceDate: '2026-09-01', dueDate: '2026-09-15', pastDue: false, amountDue: 100 },
  ],
  moreCount: 1,
  total: 345.1,
  combinedTotal: 495.1,
  totalLabel: 'Total account balance',
};

function invoice(overrides = {}) {
  return {
    invoice_number: 'WPC-NEW', status: 'sent', subtotal: 150, discount_amount: 0, total: 150,
    created_at: new Date(), due_date: '2026-11-15',
    line_items: [{ description: 'Quarterly Pest Control', quantity: 1, unit_price: 150, amount: 150 }],
    customer: { first_name: 'Synthetic', last_name: 'Fixture', address_line1: '1 Test St', city: 'Bradenton', state: 'FL', zip: '34209' },
    ...overrides,
  };
}

async function renderedText(inv) {
  const written = jest.spyOn(PDFDocument.prototype, 'text');
  try {
    const buffer = await buildInvoicePDFBuffer(inv);
    expect(buffer.subarray(0, 4).toString()).toBe('%PDF');
    return written.mock.calls.map((args) => String(args[0])).join('\n');
  } finally { written.mockRestore(); }
}

describe('invoice PDF previous balance', () => {
  test('an open invoice lists each earlier invoice, the previous balance, and the account total; TOTAL stays its own', async () => {
    const text = await renderedText(invoice({ previous_balance: previousBalance }));
    expect(text).toContain('PREVIOUS BALANCE');
    expect(text).toContain('Invoice INV-OLD-1 · Quarterly Pest Control');
    expect(text).toContain('$200.10');
    expect(text).toContain('Invoice INV-OLD-2');
    // Past-due is the caller's flag: only the flagged row gets the caption,
    // and its due date is not repeated in the middle column.
    expect(text).toContain('Past due since August 15, 2026');
    expect(text).not.toContain('Past due since September 15, 2026');
    expect(text).not.toContain('Due August 15, 2026');
    expect(text).toContain('Service September 1, 2026 · Due September 15, 2026');
    expect(text).toContain('portal.wavespestcontrol.com or in the Waves app');
    expect(text).toContain('+ 1 more earlier invoice');
    expect(text).toContain('$345.10');
    expect(text).toContain('Total account balance');
    expect(text).toContain('$495.10');
    // This invoice's own TOTAL is unchanged.
    expect(text).toMatch(/TOTAL\n\$150\.00/);
  });

  test('the pay-page download labels its total as what the Pay button charges', async () => {
    const text = await renderedText(invoice({ previous_balance: { ...previousBalance, totalLabel: 'Total due today' } }));
    expect(text).toContain('Total due today');
    expect(text).not.toContain('Total account balance');
  });

  test('a Date-typed due date (what node-pg returns for DATE) prints the past-due caption', async () => {
    const dated = { ...previousBalance, invoices: [{ ...previousBalance.invoices[0], dueDate: new Date('2026-08-15T04:00:00Z') }] };
    const text = await renderedText(invoice({ previous_balance: dated }));
    expect(text).toContain('Past due since August 15, 2026');
  });

  test('pay-page download with a partial account credit shows the credit row so the rows add up', async () => {
    const text = await renderedText(invoice({ previous_balance: { ...previousBalance, creditToApply: 20, combinedTotal: 475.1, totalLabel: 'Total due today' } }));
    expect(text).toContain('Account credit applied at payment');
    expect(text).toContain('− $20.00');
    expect(text).toContain('$475.10');
  });

  test('no previous_balance: no block', async () => {
    const text = await renderedText(invoice());
    expect(text).not.toContain('PREVIOUS BALANCE');
    expect(text).not.toContain('Total account balance');
  });

  test('a paid invoice never prints a previous balance', async () => {
    const text = await renderedText(invoice({ status: 'paid', paid_at: new Date(), previous_balance: previousBalance }));
    expect(text).not.toContain('PREVIOUS BALANCE');
    expect(text).not.toContain('INV-OLD-1');
  });
});
