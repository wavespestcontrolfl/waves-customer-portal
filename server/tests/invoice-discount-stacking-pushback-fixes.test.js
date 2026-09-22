/**
 * Three P0 findings from this slice's own local pre-push Codex audit
 * (round 1, on 87ddaf82d7) — each reproduced here with the auditor's exact
 * numbers before being fixed in server/services/invoice.js:
 *
 *  1. "Apply the same stacking calculation during invoice edits" —
 *     calculateUpdateFinancials (the existing-draft edit/retotal path) had
 *     its own, unfixed additive math: a create()'d $111 invoice with 10%
 *     and 5% line discounts saved $16.10, but resubmitting the SAME
 *     unchanged lines through an edit produced the additive $16.65 — a
 *     no-op save silently changed the total. Fixed by routing BOTH paths
 *     through the same computeStackedDocumentDiscountLines helper.
 *  2. "Reconcile frozen line credits with the engine's remaining
 *     balances" — a stored per-line credit replied with its own frozen
 *     face value even when a competing document credit's canonical-order
 *     allocation had already clamped that line's remaining balance below
 *     it: $50/$100 lines, a frozen $50 credit on line one plus an $80
 *     document credit resolves $103.33 in the engine but the save recorded
 *     $130 — enough to drive line one's own net negative. Fixed by reading
 *     every stored LINE entry's resolved dollars off the engine's own
 *     termDollars slot instead of unconditionally trusting the frozen
 *     face value.
 *  3. "Include existing unparented credits in the document stack" — an
 *     unparented credit (a validated_checkout stamp, the builder's own
 *     "Scheduled price adjustment" row, or a plain literal credit like
 *     "Referral Credit") was subtracted OUTSIDE the stack unless it also
 *     carried document_discount:true, so a fresh percentage compounded
 *     against the untouched base instead of what the credit already took:
 *     a $30 such credit plus a 10% line discount on $100 saved $60, not
 *     the specified $63. Fixed by making EVERY unparented credit — stored
 *     or a plain id-less literal — join the document stack.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/tax-calculator', () => ({
  calculateTax: jest.fn(async () => ({ rate: 0, amount: 0 })),
}));
jest.mock('../services/discount-engine', () => ({
  getDiscountForTier: jest.fn(),
  recordInvoiceDiscounts: jest.fn(),
  calculateDiscounts: jest.fn(async () => ({ discounts: [] })),
}));
jest.mock('../utils/datetime-et', () => ({
  etDateString: jest.fn(() => '2026-09-22'),
  addETDays: jest.fn(() => new Date('2026-10-22T12:00:00Z')),
}));
jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: jest.fn(async (url) => url),
  invoiceShortCodePrefix: jest.fn(() => 'INV'),
}));

const db = require('../models/db');
const InvoiceService = require('../services/invoice');
const { calculateUpdateFinancials } = InvoiceService._internals;

function setupDb({ customer, discounts = [] }) {
  let insertedInvoice = null;
  const discountById = new Map(discounts.map((d) => [String(d.id), d]));
  db.mockImplementation((table) => {
    if (table === 'customers') {
      return { where: jest.fn(() => ({ first: jest.fn(async () => customer) })) };
    }
    if (table === 'discounts') {
      const q = {
        _ids: null,
        whereIn: jest.fn((_field, ids) => { q._ids = ids.map(String); return q; }),
        where: jest.fn(() => q),
        first: jest.fn(async () => null),
        then: (resolve, reject) => {
          const rows = q._ids ? q._ids.map((id) => discountById.get(id)).filter(Boolean) : discounts;
          return Promise.resolve(rows).then(resolve, reject);
        },
      };
      return q;
    }
    if (table === 'payers') {
      return { where: jest.fn(() => ({ first: jest.fn(async () => null), catch: () => null })) };
    }
    if (table === 'invoices') {
      const q = {
        where: jest.fn(() => q),
        whereNot: jest.fn(() => q),
        whereNotIn: jest.fn(() => q),
        orderBy: jest.fn(() => q),
        first: jest.fn(async () => null),
        insert: jest.fn((data) => {
          insertedInvoice = data;
          return { returning: jest.fn(async () => [{ id: 'invoice-1', invoice_number: data.invoice_number, ...data }]) };
        }),
      };
      return q;
    }
    const q = {
      where: jest.fn(() => q),
      whereIn: jest.fn(() => q),
      andWhere: jest.fn(() => q),
      leftJoin: jest.fn(() => q),
      orderBy: jest.fn(() => q),
      select: jest.fn(async () => []),
      first: jest.fn(async () => null),
      insert: jest.fn(async () => []),
      then: (resolve, reject) => Promise.resolve([]).then(resolve, reject),
    };
    return q;
  });
  return { getInsertedInvoice: () => insertedInvoice };
}

afterEach(() => { delete process.env.GATE_DISCOUNT_STACKING; });

describe('finding 1 — create-to-edit round trip stays compounded', () => {
  test('a create()d $111 invoice with 10%+5% line discounts saves $16.10, and resubmitting the SAME unchanged lines through an edit still reports $16.10, never the additive $16.65', async () => {
    process.env.GATE_DISCOUNT_STACKING = 'true';
    setupDb({
      customer: { id: 'customer-1', property_type: 'residential' },
      discounts: [
        { id: 'ten-pct', discount_type: 'percentage', amount: 10, is_active: true, show_in_invoices: true, max_discount_dollars: null },
        { id: 'five-pct', discount_type: 'percentage', amount: 5, is_active: true, show_in_invoices: true, max_discount_dollars: null },
      ],
    });
    const created = await InvoiceService.create({
      customerId: 'customer-1',
      title: 'Pest Control',
      lineItems: [
        { client_id: 'line-1', description: 'Pest Control', quantity: 1, unit_price: 111, amount: 111 },
        { discount_id: 'ten-pct', discount_for: 'line-1', description: 'Ten Percent', quantity: 1, unit_price: -1, amount: -1 },
        { discount_id: 'five-pct', discount_for: 'line-1', description: 'Five Percent', quantity: 1, unit_price: -1, amount: -1 },
      ],
    });
    expect(created.discount_amount).toBe(16.1);

    // The invoice save's OWN stored line items — exactly what an edit form
    // re-submits unchanged: the discount lines already carry their
    // RESOLVED (compounded) dollars from create(), not the original
    // placeholder -1 the operator's picker sent.
    const resubmitItems = JSON.parse(created.line_items);

    const edited = await calculateUpdateFinancials({
      lineItems: resubmitItems,
      customer: { id: 'customer-1', property_type: 'residential' },
      invoice: { id: 'invoice-1' },
    });
    expect(edited.discount_amount).toBe(16.1);
    expect(edited.discount_amount).toBe(created.discount_amount);
  });

  test('gate off: the same round trip stays additive on both sides ($16.65 either way)', async () => {
    setupDb({
      customer: { id: 'customer-1', property_type: 'residential' },
      discounts: [
        { id: 'ten-pct', discount_type: 'percentage', amount: 10, is_active: true, show_in_invoices: true, max_discount_dollars: null },
        { id: 'five-pct', discount_type: 'percentage', amount: 5, is_active: true, show_in_invoices: true, max_discount_dollars: null },
      ],
    });
    const created = await InvoiceService.create({
      customerId: 'customer-1',
      title: 'Pest Control',
      lineItems: [
        { client_id: 'line-1', description: 'Pest Control', quantity: 1, unit_price: 111, amount: 111 },
        { discount_id: 'ten-pct', discount_for: 'line-1', description: 'Ten Percent', quantity: 1, unit_price: -1, amount: -1 },
        { discount_id: 'five-pct', discount_for: 'line-1', description: 'Five Percent', quantity: 1, unit_price: -1, amount: -1 },
      ],
    });
    expect(created.discount_amount).toBe(16.65);

    const edited = await calculateUpdateFinancials({
      lineItems: [
        { client_id: 'line-1', description: 'Pest Control', quantity: 1, unit_price: 111, amount: 111 },
        { discount_id: 'ten-pct', discount_for: 'line-1', description: 'Ten Percent', quantity: 1, unit_price: -11.1, amount: -11.1 },
        { discount_id: 'five-pct', discount_for: 'line-1', description: 'Five Percent', quantity: 1, unit_price: -5.55, amount: -5.55 },
      ],
      customer: { id: 'customer-1', property_type: 'residential' },
      invoice: { id: 'invoice-1' },
    });
    expect(edited.discount_amount).toBe(16.65);
  });
});

describe('finding 2 — a stored line credit reads the engine\'s resolved dollars, not its frozen face value unconditionally', () => {
  test('$50/$100 lines, a frozen $50 credit on line one plus an $80 document credit resolve $103.33 total, never the $130 double-count', async () => {
    process.env.GATE_DISCOUNT_STACKING = 'true';
    setupDb({
      customer: { id: 'customer-1', property_type: 'residential' },
      discounts: [
        { id: 'doc-80', discount_type: 'fixed_amount', amount: 80, is_active: true, show_in_invoices: true, max_discount_dollars: null },
      ],
    });
    const invoice = await InvoiceService.create({
      customerId: 'customer-1',
      title: 'Two-line invoice',
      lineItems: [
        { client_id: 'line-1', description: 'Line one', quantity: 1, unit_price: 50, amount: 50 },
        { client_id: 'line-2', description: 'Line two', quantity: 1, unit_price: 100, amount: 100 },
        {
          discount_id: 'frozen-50', discount_for: 'line-1', description: 'Frozen stamp',
          quantity: 1, unit_price: -50, amount: -50,
          discount_type: 'fixed_amount', discount_amount: 50, discount_dollars: 50,
          use_stored_discount: true, stored_discount_source: 'scheduled_service',
        },
      ],
      discountIds: ['doc-80'],
      trustedStoredDiscountSources: ['scheduled_service'],
    });

    expect(invoice.subtotal).toBe(150);
    // The engine's own resolution, not the naive 50+80=130 double-count —
    // and critically, never more than either line's own gross (no negative
    // net anywhere).
    expect(invoice.discount_amount).toBe(103.33);
    expect(invoice.total).toBe(46.67);
  });
});

describe('finding 3 — an unparented credit (stored or plain) reduces the base a fresh percentage compounds against', () => {
  test('a $30 stored, unparented (validated_checkout-shaped) credit plus a fresh 10% line pick on $100 saves $33, never the un-compounded $30 (this base check: no fresh percentage at all, just the credit alone, proves the credit itself still lands exactly $30 without a percentage present)', async () => {
    process.env.GATE_DISCOUNT_STACKING = 'true';
    setupDb({ customer: { id: 'customer-1', property_type: 'residential' } });
    const invoice = await InvoiceService.create({
      customerId: 'customer-1',
      title: 'Checkout invoice',
      lineItems: [
        { client_id: 'line-1', description: 'Service', quantity: 1, unit_price: 100, amount: 100 },
        {
          discount_id: 'checkout-tier', discount_for: null, description: 'Mobile Checkout Silver',
          quantity: 1, unit_price: -30, amount: -30,
          discount_type: 'percentage', discount_amount: 30, discount_dollars: 30,
          use_stored_discount: true, stored_discount_source: 'validated_checkout',
        },
      ],
      trustedStoredDiscountSources: ['scheduled_service', 'validated_checkout'],
    });
    expect(invoice.discount_amount).toBe(30);
    expect(invoice.total).toBe(70);
  });

  test('the same $30 unparented credit PLUS a fresh 10% line pick on $100 saves $37 ($30 + 10% of the remaining $70), never the specified-wrong $40 that ignoring the credit for the percentage base would give', async () => {
    process.env.GATE_DISCOUNT_STACKING = 'true';
    setupDb({
      customer: { id: 'customer-1', property_type: 'residential' },
      discounts: [
        { id: 'fresh-ten-pct', discount_type: 'percentage', amount: 10, is_active: true, show_in_invoices: true, max_discount_dollars: null },
      ],
    });
    const invoice = await InvoiceService.create({
      customerId: 'customer-1',
      title: 'Checkout invoice',
      lineItems: [
        { client_id: 'line-1', description: 'Service', quantity: 1, unit_price: 100, amount: 100 },
        {
          discount_id: 'checkout-tier', discount_for: null, description: 'Mobile Checkout Silver',
          quantity: 1, unit_price: -30, amount: -30,
          discount_type: 'percentage', discount_amount: 30, discount_dollars: 30,
          use_stored_discount: true, stored_discount_source: 'validated_checkout',
        },
        { discount_id: 'fresh-ten-pct', discount_for: 'line-1', description: 'Fresh Ten Percent', quantity: 1, unit_price: -1, amount: -1 },
      ],
      trustedStoredDiscountSources: ['scheduled_service', 'validated_checkout'],
    });
    // $30 fixed off first (100 -> 70), then 10% of the remaining $70 = $7.
    expect(invoice.discount_amount).toBe(37);
    expect(invoice.total).toBe(63);
  });

  test("a plain literal credit with no discount_id (e.g. a promised \"Referral Credit\") plus a 10% line pick on $100 saves $63, matching the owner's own worked example — never the additive $60", async () => {
    process.env.GATE_DISCOUNT_STACKING = 'true';
    setupDb({
      customer: { id: 'customer-1', property_type: 'residential' },
      discounts: [
        { id: 'fresh-ten-pct', discount_type: 'percentage', amount: 10, is_active: true, show_in_invoices: true, max_discount_dollars: null },
      ],
    });
    const invoice = await InvoiceService.create({
      customerId: 'customer-1',
      title: 'Referral invoice',
      lineItems: [
        { client_id: 'line-1', description: 'Service', quantity: 1, unit_price: 100, amount: 100 },
        { description: 'Referral Credit', quantity: 1, unit_price: -30, amount: -30 },
        { discount_id: 'fresh-ten-pct', discount_for: 'line-1', description: 'Fresh Ten Percent', quantity: 1, unit_price: -1, amount: -1 },
      ],
    });
    expect(invoice.discount_amount).toBe(37);
    expect(invoice.total).toBe(63);
    expect(invoice.discount_label).toContain('Referral Credit');
  });
});
