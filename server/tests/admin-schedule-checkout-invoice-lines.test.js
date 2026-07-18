const adminScheduleRouter = require('../routes/admin-schedule');
const { invoiceAmountDue } = require('../services/invoice-helpers');

describe('Charge-now response math (canonical invoiceAmountDue)', () => {
  test('nets credit_applied off the gross — the tender surfaces collect this', () => {
    // Pins the contract the checkout sheet relies on: a $214 invoice with
    // $50 account credit charges $164, never the gross.
    expect(invoiceAmountDue({ total: '214.00', credit_applied: '50.00' })).toBe(164);
    expect(invoiceAmountDue({ total: 214, credit_applied: 0 })).toBe(214);
    expect(invoiceAmountDue({ total: 50, credit_applied: 80 })).toBe(0);
  });
});

describe('compactCheckoutInvoiceLines (schedule payload invoice summary)', () => {
  const { compactCheckoutInvoiceLines } = adminScheduleRouter._test;

  test('maps the accept-minted setup + first-application lines with amounts', () => {
    // Shape written by the estimate converter's standard branch.
    const lines = [
      { amount: 99, quantity: 1, unit_price: 99, description: 'WaveGuard Membership — one-time setup fee' },
      { amount: 115, quantity: 1, unit_price: 115, description: 'First service application' },
    ];
    expect(compactCheckoutInvoiceLines(lines)).toEqual([
      { description: 'WaveGuard Membership — one-time setup fee', amount: 99 },
      { description: 'First service application', amount: 115 },
    ]);
  });

  test('accepts a JSON string column value', () => {
    const raw = JSON.stringify([{ description: 'First service application', quantity: 1, unit_price: 115 }]);
    expect(compactCheckoutInvoiceLines(raw)).toEqual([
      { description: 'First service application', amount: 115 },
    ]);
  });

  test('derives amount from quantity * unit_price when amount is missing', () => {
    expect(compactCheckoutInvoiceLines([
      { description: 'Rodent bait stations', quantity: 3, unit_price: 25 },
    ])).toEqual([{ description: 'Rodent bait stations', amount: 75 }]);
  });

  test('keeps negative (discount) lines so previews match the invoice total', () => {
    expect(compactCheckoutInvoiceLines([
      { description: 'Quarterly Pest Control', amount: 130, quantity: 1, unit_price: 130 },
      { description: 'Neighbor discount', amount: -15, quantity: 1, unit_price: -15 },
    ])).toEqual([
      { description: 'Quarterly Pest Control', amount: 130 },
      { description: 'Neighbor discount', amount: -15 },
    ]);
  });

  test('drops unusable rows and never throws on junk input', () => {
    expect(compactCheckoutInvoiceLines(null)).toEqual([]);
    expect(compactCheckoutInvoiceLines('not-json')).toEqual([]);
    expect(compactCheckoutInvoiceLines({ description: 'not-an-array' })).toEqual([]);
    expect(compactCheckoutInvoiceLines([
      { description: '', amount: 10 },
      { description: 'ok', amount: 'NaN-ish' },
      null,
    ])).toEqual([{ description: 'ok', amount: 0 }]);
  });

  test('caps at 8 lines and truncates long descriptions', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      description: `Line ${i} ${'x'.repeat(200)}`,
      amount: i,
    }));
    const out = compactCheckoutInvoiceLines(many);
    expect(out).toHaveLength(8);
    expect(out[0].description.length).toBeLessThanOrEqual(160);
  });
});
