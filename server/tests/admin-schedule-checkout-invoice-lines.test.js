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

describe('calculateDiscountDollars percentage rounding (checkout mint cap-check)', () => {
  const { calculateDiscountDollars } = adminScheduleRouter._test;

  // Codex pre-push audit P0 (slice 9 of #4405): the mobile checkout sheet's
  // preview now runs every discount through lib/discountStack's cent-exact
  // percentageDiscountDollars (5% of $20.70 = $1.04, per CLAUDE.md's
  // "regardless of the gate" rounding rule), but this cap-check still used
  // baseAmount * (amount/100) then Math.round(dollars*100)/100 — plain
  // IEEE754 float division, which lands 5% of $20.70 at $1.03
  // (20.70 * 0.05 === 1.0349999999999999). The server's
  // Math.min(submittedDollars, resolved.dollars) then clamped the sheet's
  // correct $1.04 preview down to the old $1.03, minting a total the
  // technician never saw on screen.
  test('5% of $20.70 clamps at the cent-exact $1.04, never the float-rounded $1.03', () => {
    const row = { discount_type: 'percentage', amount: 5, max_discount_dollars: null };
    expect(calculateDiscountDollars(row, 20.70, 5).dollars).toBe(1.04);
  });

  test('a max_discount_dollars cap still clamps below the cent-exact amount', () => {
    const row = { discount_type: 'percentage', amount: 5, max_discount_dollars: 0.5 };
    expect(calculateDiscountDollars(row, 20.70, 5).dollars).toBe(0.5);
  });

  // Not itself behind GATE_DISCOUNT_STACKING — this cap-check runs on every
  // checkout mint whether or not the gate is live, so the corrected rounding
  // must be identical either way (CLAUDE.md: "regardless of the gate").
  test('gate-off parity — the same cent-exact rounding applies with GATE_DISCOUNT_STACKING unset', () => {
    const prior = process.env.GATE_DISCOUNT_STACKING;
    delete process.env.GATE_DISCOUNT_STACKING;
    try {
      const row = { discount_type: 'percentage', amount: 5, max_discount_dollars: null };
      expect(calculateDiscountDollars(row, 20.70, 5).dollars).toBe(1.04);
    } finally {
      if (prior === undefined) delete process.env.GATE_DISCOUNT_STACKING;
      else process.env.GATE_DISCOUNT_STACKING = prior;
    }
  });

  test('fixed and free_service types are unaffected by the percentage-path fix', () => {
    expect(calculateDiscountDollars({ discount_type: 'fixed_amount', amount: 15 }, 100, 15).dollars).toBe(15);
    expect(calculateDiscountDollars({ discount_type: 'free_service', amount: 0 }, 42.5, 0).dollars).toBe(42.5);
  });
});
