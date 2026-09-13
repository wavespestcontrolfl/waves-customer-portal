/**
 * PR #4405 Codex round 3, P1 — the invoice preview must stack a parentless
 * (appointment-level) stored stamp as a DOCUMENT term, the way the server
 * now does, instead of adding its frozen dollars beside an independently
 * resolved line discount.
 */
import { describe, it, expect } from 'vitest';
import { invoiceDiscountDollars } from './AdminInvoicesPage';

const LINE = (clientId, amount, serviceKey = null) => ({
  client_id: clientId, description: 'Service', quantity: 1, unit_price: amount, amount,
  ...(serviceKey ? { service_key: serviceKey } : {}),
});
const STAMP = ({ dollars, scopeKey = null }) => ({
  client_id: 'discount_x_appointment', _kind: 'discount', discount_for: null,
  use_stored_discount: true, discount_dollars: dollars,
  quantity: 1, unit_price: -dollars, amount: -dollars,
  ...(scopeKey ? { document_scope_service_key: scopeKey } : {}),
});
const PICK = (clientId, discountId, parent) => ({
  client_id: clientId, _kind: 'discount', discount_id: discountId, discount_for: parent,
  quantity: 1, unit_price: -1, amount: -1,
});
const PCT = (id, amount) => ({ id, discount_type: 'percentage', amount });

describe('invoiceDiscountDollars — parentless stamps ride the document stack', () => {
  it('a 5% line discount compounds AFTER a $10 appointment stamp: $4.50, not $5', () => {
    const dollars = invoiceDiscountDollars(
      [LINE('line-1', 100), STAMP({ dollars: 10 }), PICK('d-1', 'p5', 'line-1')],
      [PCT('p5', 5)],
      { compound: true },
    );
    expect(dollars.get('d-1')).toBe(4.5);
  });

  it('gate OFF is unchanged — the 5% resolves against the full line', () => {
    const dollars = invoiceDiscountDollars(
      [LINE('line-1', 100), STAMP({ dollars: 10 }), PICK('d-1', 'p5', 'line-1')],
      [PCT('p5', 5)],
      { compound: false },
    );
    expect(dollars.get('d-1')).toBe(5);
  });

  it('a SCOPED stamp reaches only its own line, leaving the other line’s 10% at $10', () => {
    const dollars = invoiceDiscountDollars(
      [
        LINE('line-1', 100, 'pest_general_quarterly'),
        LINE('line-2', 100, 'lawn_fert_monthly'),
        STAMP({ dollars: 30, scopeKey: 'lawn_fert_monthly' }),
        PICK('d-1', 'p10', 'line-1'),
      ],
      [PCT('p10', 10)],
      { compound: true },
    );
    expect(dollars.get('d-1')).toBe(10);
  });

  it('the same stamp unscoped spreads and drops that 10% to $8.50', () => {
    const dollars = invoiceDiscountDollars(
      [
        LINE('line-1', 100, 'pest_general_quarterly'),
        LINE('line-2', 100, 'lawn_fert_monthly'),
        STAMP({ dollars: 30 }),
        PICK('d-1', 'p10', 'line-1'),
      ],
      [PCT('p10', 10)],
      { compound: true },
    );
    expect(dollars.get('d-1')).toBe(8.5);
  });

  it('with no stamp at all, each parent line still stacks on its own', () => {
    const dollars = invoiceDiscountDollars(
      [
        LINE('line-1', 100), PICK('d-1', 'p10', 'line-1'),
        LINE('line-2', 200), PICK('d-2', 'p10', 'line-2'),
      ],
      [PCT('p10', 10)],
      { compound: true },
    );
    expect(dollars.get('d-1')).toBe(10);
    expect(dollars.get('d-2')).toBe(20);
  });
});
