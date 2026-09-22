/**
 * #4405 review finding "Trust checkout-stamped discounts during invoice
 * edits" (carried into slice 5, invoice.js's calculateUpdateFinancials —
 * the retotal an existing draft's line-item/tax-only edit runs through).
 *
 * A catalog discount minted by mobile checkout is persisted on its invoice
 * line item with stored_discount_source: 'validated_checkout' and no
 * discount_for parent (server/routes/admin-schedule.js). Before this fix,
 * calculateUpdateFinancials called isStoredDiscountLineItem with its bare
 * default (trusts only 'scheduled_service'), so a checkout stamp fell
 * through to the fresh-pick branch, found neither a catalog row nor a
 * parent line, and threw "Invalid line-item discount" — any edit to a
 * draft invoice minted from mobile checkout was uneditable. Independent of
 * GATE_DISCOUNT_STACKING: a stamp is either trusted or it isn't.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const InvoiceService = require('../services/invoice');
const { calculateUpdateFinancials } = InvoiceService._internals;

function setupDiscountsDb() {
  db.mockImplementation((table) => {
    if (table === 'discounts') {
      const q = {
        whereIn: jest.fn(() => q),
        where: jest.fn(() => q),
        then: (resolve, reject) => Promise.resolve([]).then(resolve, reject),
      };
      return q;
    }
    if (table === 'payers') {
      return { where: jest.fn(() => ({ first: jest.fn(async () => null), catch: () => null })) };
    }
    const q = {
      where: jest.fn(() => q),
      first: jest.fn(async () => null),
      catch: (fn) => Promise.resolve(null).catch(fn),
    };
    return q;
  });
}

const CHECKOUT_STAMP_LINE_ITEMS = [
  { client_id: 'line-1', description: 'Pest Control', quantity: 1, unit_price: 100, amount: 100 },
  {
    _kind: 'discount',
    discount_id: 'checkout-tier',
    discount_for: null, // whole-checkout credit, not scoped to a line
    description: 'Mobile Checkout Silver',
    quantity: 1,
    unit_price: -10,
    amount: -10,
    discount_type: 'percentage',
    discount_amount: 10,
    discount_dollars: 10,
    use_stored_discount: true,
    stored_discount_source: 'validated_checkout',
  },
];

describe('calculateUpdateFinancials trusts a validated_checkout stamp', () => {
  test('a checkout-stamped discount line no longer throws "Invalid line-item discount" on edit', async () => {
    setupDiscountsDb();
    const result = await calculateUpdateFinancials({
      lineItems: CHECKOUT_STAMP_LINE_ITEMS,
      customer: { id: 'customer-1', property_type: 'residential' },
      invoice: { id: 'invoice-1' },
    });
    expect(result.subtotal).toBe(100);
    expect(result.discount_amount).toBe(10);
    expect(result.total).toBe(90);
  });

  test('an UNTRUSTED source with no parent and no catalog row still throws (regression guard: the widening is scoped to the two named sources)', async () => {
    setupDiscountsDb();
    const items = [
      { client_id: 'line-1', description: 'Pest Control', quantity: 1, unit_price: 100, amount: 100 },
      {
        _kind: 'discount',
        discount_id: 'some-other-id',
        discount_for: null,
        description: 'Unknown stamp',
        quantity: 1,
        unit_price: -10,
        amount: -10,
        use_stored_discount: true,
        stored_discount_source: 'some_untrusted_source',
      },
    ];
    await expect(calculateUpdateFinancials({
      lineItems: items,
      customer: { id: 'customer-1', property_type: 'residential' },
      invoice: { id: 'invoice-1' },
    })).rejects.toThrow('Invalid line-item discount');
  });

  test('a scheduled_service stamp keeps working exactly as before (no regression)', async () => {
    setupDiscountsDb();
    const items = [
      { client_id: 'line-1', description: 'Pest Control', quantity: 1, unit_price: 100, amount: 100 },
      {
        _kind: 'discount',
        discount_id: 'silver-id',
        discount_for: null,
        description: 'WaveGuard Silver',
        quantity: 1,
        unit_price: -10,
        amount: -10,
        discount_type: 'percentage',
        discount_amount: 10,
        discount_dollars: 10,
        use_stored_discount: true,
        stored_discount_source: 'scheduled_service',
      },
    ];
    const result = await calculateUpdateFinancials({
      lineItems: items,
      customer: { id: 'customer-1', property_type: 'residential' },
      invoice: { id: 'invoice-1' },
    });
    expect(result.discount_amount).toBe(10);
    expect(result.total).toBe(90);
  });
});
