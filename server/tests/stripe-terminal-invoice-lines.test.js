// The Waves Admin amount screen lists what the customer pays for: the
// invoice's service lines and the totals rows the invoice PDF prints, ending
// at the amount due. Prices show only when those rows add up to the charge.

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { terminalInvoiceLines } = require('../routes/stripe-terminal')._test;
const logger = require('../services/logger');

const line = (description, amount, extra = {}) => ({ description, quantity: 1, unit_price: amount, amount, ...extra });

describe('terminalInvoiceLines', () => {
  test('lists each service with its price when the lines make up the amount due', () => {
    const invoice = {
      invoice_number: 'WPC-2026-0123',
      line_items: [line('Quarterly Pest Control Service', 119), line('Lawn Fertilization', 70)],
      subtotal: 189, total: 189,
    };
    expect(terminalInvoiceLines(invoice, null, 18900)).toEqual({
      invoice_number: 'WPC-2026-0123',
      items: [
        { description: 'Quarterly Pest Control Service', amount_cents: 11900 },
        { description: 'Lawn Fertilization', amount_cents: 7000 },
      ],
      adjustments: [],
    });
  });

  test('adds the discount, account credit and part payment rows the invoice PDF prints', () => {
    const invoice = {
      line_items: [line('Termite Inspection', 200), line('Loyalty discount', -20, { _kind: 'discount' })],
      subtotal: 200, discount_amount: 20, discount_label: 'Gold WaveGuard discount',
      total: 180, credit_applied: 30, amount_paid: 50,
    };
    expect(terminalInvoiceLines(invoice, null, 10000)).toEqual({
      invoice_number: null,
      items: [{ description: 'Termite Inspection', amount_cents: 20000 }],
      adjustments: [
        { label: 'Gold WaveGuard discount', amount_cents: -2000 },
        { label: 'Account credit applied', amount_cents: -3000 },
        { label: 'Paid so far', amount_cents: -5000 },
      ],
    });
  });

  test('shows tax for a commercial customer and the quantity on a multi-unit line', () => {
    const invoice = {
      line_items: [{ description: 'Bait Station Service', quantity: 3, unit_price: 25, amount: 75 }],
      subtotal: 75, tax_amount: 5.25, tax_rate: 0.07, total: 80.25,
    };
    expect(terminalInvoiceLines(invoice, { property_type: 'commercial' }, 8025)).toEqual({
      invoice_number: null,
      items: [{ description: 'Bait Station Service × 3', amount_cents: 7500 }],
      adjustments: [{ label: 'Tax (7.00%)', amount_cents: 525 }],
    });
  });

  test('drops the prices when the rows do not add up to the charge', () => {
    // Residential tax is not printed, so the visible rows miss the stored total.
    const invoice = {
      line_items: [line('Mosquito Service', 100)],
      subtotal: 100, tax_amount: 7, tax_rate: 0.07, total: 107,
    };
    expect(terminalInvoiceLines(invoice, { property_type: 'residential' }, 10700)).toEqual({
      invoice_number: null,
      items: [{ description: 'Mosquito Service', amount_cents: null }],
      adjustments: [],
    });
  });

  test('reads line items stored as a JSON string', () => {
    const invoice = { line_items: JSON.stringify([line('Rodent Exclusion', 450)]), subtotal: 450, total: 450 };
    expect(terminalInvoiceLines(invoice, null, 45000).items).toEqual([
      { description: 'Rodent Exclusion', amount_cents: 45000 },
    ]);
  });

  test('returns no lines instead of throwing, because the handoff is already used', () => {
    const invoice = { id: 'inv-9', invoice_number: 'WPC-2026-0999' };
    Object.defineProperty(invoice, 'line_items', { get() { throw new Error('unreadable'); } });
    expect(terminalInvoiceLines(invoice, null, 100)).toEqual({ invoice_number: 'WPC-2026-0999', items: [], adjustments: [] });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('inv-9'));
  });
});
