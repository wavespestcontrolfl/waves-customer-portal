/**
 * annualPrepayTermSetupFeeFallback (codex round-2 P0 follow-up on #4671):
 *
 * The Customer 360 annual-prepay-terms query derives prepaySetupFeeAmount
 * from a LEFT JOIN to setup_fee_claims (codex #3591 r72 P1) so the client's
 * renewal-default math (annualPrepayPretaxBase, Customer360ProfileV2.jsx)
 * can subtract the one-time setup share from the pre-tax subtotal instead
 * of re-charging it as recurring coverage on the next renewal.
 *
 * An ESTIMATE-origin on-site prepay switch deliberately never ledgers a
 * setup_fee_claims row on its first cycle (invoice.js
 * retireRodentSetupObligationForRevivedPrepay — the superseded accept
 * invoice's marker re-mint is the sole restore mechanism there), so that
 * join finds nothing even though the prepay invoice's OWN line items still
 * carry the $99 setup line. This fallback reads it from there instead,
 * only when the claims-ledger join came up empty.
 */
const { annualPrepayTermSetupFeeFallback } = require('../routes/admin-customers')._private;

describe('annualPrepayTermSetupFeeFallback', () => {
  test('leaves an already-populated claims-ledger amount untouched (the common case)', () => {
    const row = { prepay_setup_fee_amount: '99.00', prepay_invoice_line_items: [] };
    expect(annualPrepayTermSetupFeeFallback(row)).toBe(row);
    expect(row.prepay_setup_fee_amount).toBe('99.00');
  });

  test('falls back to the invoice’s own setup line when the claims-ledger join is null (estimate-origin switch, first cycle)', () => {
    const row = {
      prepay_setup_fee_amount: null,
      prepay_invoice_line_items: JSON.stringify([
        { description: 'Rodent Bait Stations - Annual Prepay', unit_price: 486.4, amount: 486.4 },
        { description: 'Bait Station Setup — one-time setup fee', unit_price: 99, amount: 99, category: 'Setup fee' },
      ]),
    };
    annualPrepayTermSetupFeeFallback(row);
    expect(row.prepay_setup_fee_amount).toBe(99);
  });

  test('accepts an already-parsed line_items array (knex jsonb columns come back parsed)', () => {
    const row = {
      prepay_setup_fee_amount: null,
      prepay_invoice_line_items: [
        { description: 'Bait Station Setup — one-time setup fee', amount: 99 },
      ],
    };
    annualPrepayTermSetupFeeFallback(row);
    expect(row.prepay_setup_fee_amount).toBe(99);
  });

  test('reads unit_price when amount is absent, and leaves null when no setup line exists', () => {
    const withUnitPrice = {
      prepay_setup_fee_amount: null,
      prepay_invoice_line_items: [{ description: 'Bait Station Setup — one-time setup fee', unit_price: 99 }],
    };
    annualPrepayTermSetupFeeFallback(withUnitPrice);
    expect(withUnitPrice.prepay_setup_fee_amount).toBe(99);

    const noSetupLine = {
      prepay_setup_fee_amount: null,
      prepay_invoice_line_items: [{ description: 'First service application', amount: 128 }],
    };
    annualPrepayTermSetupFeeFallback(noSetupLine);
    expect(noSetupLine.prepay_setup_fee_amount).toBeNull();
  });

  test('codex round-3 P1: a broad match must not pick the annual-prepay line over the setup line', () => {
    // The converter's own annual-prepay line text contains the substring
    // "setup fee" too ("WaveGuard Membership — 12 months prepaid (setup fee
    // waived)"). A broad /setup fee/i .find() picks whichever line sorts
    // first — here the $500 annual line — and would expose $500 as the
    // "setup share", so the renewal default subtracts $500 instead of $99
    // and suggests $0 (or a negative/garbage coverage) for next year.
    const row = {
      prepay_setup_fee_amount: null,
      prepay_invoice_line_items: [
        { description: 'WaveGuard Membership — 12 months prepaid (setup fee waived)', amount: 500 },
        { description: 'Bait Station Setup — one-time setup fee', amount: 99 },
      ],
    };
    annualPrepayTermSetupFeeFallback(row);
    expect(row.prepay_setup_fee_amount).toBe(99);
  });

  test('is null-safe for a missing/unparseable line_items value', () => {
    expect(() => annualPrepayTermSetupFeeFallback({ prepay_setup_fee_amount: null, prepay_invoice_line_items: null })).not.toThrow();
    expect(() => annualPrepayTermSetupFeeFallback({ prepay_setup_fee_amount: null, prepay_invoice_line_items: 'not json' })).not.toThrow();
    expect(annualPrepayTermSetupFeeFallback(null)).toBeNull();
  });
});
