/**
 * Regression coverage for the two invoice.js findings from PR #4405 Codex
 * round 1 (GATE_DISCOUNT_STACKING lane):
 *
 * 1. (P1) An invoice-level discount (discountIds) must compound on what a
 *    line-item discount already took off, not resolve independently against
 *    the untouched subtotal — a 10% invoice discount plus a 5% line discount
 *    removes the gated 14.5%, never an additive 15%.
 * 2. (P2) A trusted stored visit-discount stamp must still collide with a
 *    fresh pick from the same non-stackable tier group even after the
 *    stamp's catalog row is deactivated / hidden from invoices.
 *
 * The lane is dark by default; these cases exercise it ON, so the gate must
 * be set before the service module snapshots it (mirrors
 * invoice-tier-discounts.test.js).
 */
process.env.GATE_DISCOUNT_STACKING = 'true';
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/tax-calculator', () => ({
  calculateTax: jest.fn(async () => ({ rate: 0, amount: 0 })),
}));
jest.mock('../services/discount-engine', () => ({
  getDiscountForTier: jest.fn(),
  recordInvoiceDiscounts: jest.fn(),
  calculateDiscounts: jest.fn(async () => ({ discounts: [] })),
}));
jest.mock('../utils/datetime-et', () => ({
  etDateString: jest.fn(() => '2026-09-11'),
  addETDays: jest.fn(() => new Date('2026-10-11T12:00:00Z')),
}));
jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: jest.fn(async (url) => url),
  invoiceShortCodePrefix: jest.fn(() => 'INV'),
}));

const db = require('../models/db');

// Match knex's transaction identity; the root client is not its own trx.
async function mockTransaction(callback) {
  const trx = (...args) => db(...args);
  trx.isTransaction = true;
  trx.raw = db.raw;
  trx.fn = db.fn;
  trx.transaction = async (inner) => inner(trx);
  return callback(trx);
}

const InvoiceService = require('../services/invoice');

// A `discounts` mock that actually honors loadInvoiceDiscountRows' active +
// show_in_invoices `.where(...)` filter (unlike a bare `whereIn` passthrough)
// so a retired row is distinguishable from the same id read WITHOUT that
// filter — exactly the distinction Finding 2's fix depends on.
function setupDb({ customer, discounts = [] }) {
  let insertedInvoice = null;
  const discountById = new Map(discounts.map((row) => [String(row.id), row]));

  db.mockImplementation((table) => {
    if (table === 'customers') {
      const q = { where: jest.fn(() => q), first: jest.fn(async () => customer) };
      return q;
    }

    if (table === 'discounts') {
      const q = {
        ids: null,
        filtered: false,
        whereIn: jest.fn((_field, ids) => { q.ids = ids.map(String); return q; }),
        where: jest.fn(() => { q.filtered = true; return q; }),
        select: jest.fn(() => q),
        first: jest.fn(async () => null),
        then: (resolve, reject) => {
          const rows = (q.ids ? q.ids.map((id) => discountById.get(id)).filter(Boolean) : discounts)
            .filter((row) => !q.filtered || (row.is_active !== false && row.show_in_invoices !== false));
          return Promise.resolve(rows).then(resolve, reject);
        },
      };
      return q;
    }

    if (table === 'scheduled_services' || table === 'service_records') {
      const q = { where: jest.fn(() => q), leftJoin: jest.fn(() => q), select: jest.fn(() => q), first: jest.fn(async () => null) };
      return q;
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
          return {
            returning: jest.fn(async () => [{ id: 'invoice-1', invoice_number: data.invoice_number, ...data }]),
          };
        }),
      };
      return q;
    }

    throw new Error(`Unexpected table query: ${table}`);
  });
  db.raw = jest.fn().mockResolvedValue({ rows: [] });
  db.transaction = jest.fn(mockTransaction);

  return { getInsertedInvoice: () => insertedInvoice };
}

const CUSTOMER = { id: 'customer-1', waveguard_tier: 'Bronze', property_type: 'residential' };
const line = { client_id: 'line-1', description: 'Pest Control', quantity: 1, unit_price: 100, amount: 100 };
const pick = (d, clientId = `d-${d.id}`) => ({
  client_id: clientId, _kind: 'discount', discount_id: d.id, discount_for: 'line-1',
  description: d.name, quantity: 1, unit_price: -1, amount: -1,
});

describe('invoice-level discounts stack with line-item discounts (finding 1, P1)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('a 10% invoice discount plus a 5% line discount removes the gated 14.5%, not an additive 15%', async () => {
    const INVOICE_10 = {
      id: 'invoice10-id', name: 'Loyalty 10%', discount_type: 'percentage', amount: 10,
      is_active: true, show_in_invoices: true, is_stackable: true,
    };
    const LINE_5 = {
      id: 'line5-id', name: 'Referral 5%', discount_type: 'percentage', amount: 5,
      is_active: true, show_in_invoices: true, is_stackable: true,
    };
    setupDb({ customer: CUSTOMER, discounts: [INVOICE_10, LINE_5] });

    const invoice = await InvoiceService.create({
      customerId: 'customer-1',
      title: 'Pest Control',
      lineItems: [line, pick(LINE_5)],
      discountIds: [INVOICE_10.id],
    });

    // $100 -> line 5% off = $95 -> invoice 10% off $95 = $9.50. Total
    // removed = $5 + $9.50 = $14.50 (14.5%), never the additive $15.
    expect(invoice.discount_amount).toBe(14.5);
    expect(invoice.total).toBe(85.5);
  });

  // Parity with the visit rule (stackVisitDiscounts, discount-stack.js
  // ~L107-170): its four-step order runs fixed LINE credits, then the fixed
  // APPOINTMENT/document credit spread pro rata, THEN line percentages,
  // then the document percentage — so a fixed document-level credit must
  // land before a line percentage compounds, never after. A stored visit
  // stamp replays onto its own invoice, so the two surfaces must total the
  // same discount for the same picks.
  test('a fixed invoice-level credit lands before a line percentage compounds — the $63-vs-$60 case', async () => {
    const CREDIT_30 = {
      id: 'credit30-id', name: 'Office Credit', discount_type: 'fixed_amount', amount: 30,
      is_active: true, show_in_invoices: true, is_stackable: true,
    };
    const LINE_10 = {
      id: 'line10-id', name: 'Line 10%', discount_type: 'percentage', amount: 10,
      is_active: true, show_in_invoices: true, is_stackable: true,
    };
    setupDb({ customer: CUSTOMER, discounts: [CREDIT_30, LINE_10] });

    const invoice = await InvoiceService.create({
      customerId: 'customer-1',
      title: 'Pest Control',
      lineItems: [line, pick(LINE_10)],
      discountIds: [CREDIT_30.id],
    });

    // Visit rule: $30 credit off $100 first = $70 left, then 10% of $70 =
    // $7. Total removed = $30 + $7 = $37, total = $63 — NOT $60 (10% of
    // $100 = $10, then $30 off $90), which is what applying the invoice
    // credit AFTER the line percentage would print.
    expect(invoice.discount_amount).toBe(37);
    expect(invoice.total).toBe(63);
  });

  test('a fixed invoice-level credit plus a line percentage, general case', async () => {
    const CREDIT_25 = {
      id: 'credit25-id', name: 'Office Credit', discount_type: 'fixed_amount', amount: 25,
      is_active: true, show_in_invoices: true, is_stackable: true,
    };
    const LINE_20 = {
      id: 'line20-id', name: 'Line 20%', discount_type: 'percentage', amount: 20,
      is_active: true, show_in_invoices: true, is_stackable: true,
    };
    setupDb({ customer: CUSTOMER, discounts: [CREDIT_25, LINE_20] });

    const invoice = await InvoiceService.create({
      customerId: 'customer-1',
      title: 'Pest Control',
      lineItems: [line, pick(LINE_20)],
      discountIds: [CREDIT_25.id],
    });

    // $100 -> invoice $25 fixed credit off FIRST = $75 -> line 20% off $75
    // = $15. Total removed = $25 + $15 = $40, total = $60.
    expect(invoice.discount_amount).toBe(40);
    expect(invoice.total).toBe(60);
  });
});

// Codex pre-push P0: stackInvoiceDocumentDiscounts used to seed its line
// pool only from lines a negative discount ITEM points at — an undiscounted
// service line, or an invoice whose only pick is invoice-level, never
// entered the pool at all, so a document-level discount resolved to $0 (or
// a mixed invoice's pool was short every undiscounted line's gross). Fixed
// by seeding one group per POSITIVE service line, discounted or not.
describe('the document-level pool includes every positive service line (pre-push P0)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('a $100 line with NO line discount and a 10% invoice-level discount takes $10 off, not $0', async () => {
    const INVOICE_10 = {
      id: 'invoice10-id', name: 'Loyalty 10%', discount_type: 'percentage', amount: 10,
      is_active: true, show_in_invoices: true, is_stackable: true,
    };
    setupDb({ customer: CUSTOMER, discounts: [INVOICE_10] });

    const invoice = await InvoiceService.create({
      customerId: 'customer-1',
      title: 'Pest Control',
      lineItems: [line],
      discountIds: [INVOICE_10.id],
    });

    expect(invoice.discount_amount).toBe(10);
    expect(invoice.total).toBe(90);
  });

  test('the same line with a fixed $30 invoice-level credit takes $30 off, not $0', async () => {
    const CREDIT_30 = {
      id: 'credit30-id', name: 'Office Credit', discount_type: 'fixed_amount', amount: 30,
      is_active: true, show_in_invoices: true, is_stackable: true,
    };
    setupDb({ customer: CUSTOMER, discounts: [CREDIT_30] });

    const invoice = await InvoiceService.create({
      customerId: 'customer-1',
      title: 'Pest Control',
      lineItems: [line],
      discountIds: [CREDIT_30.id],
    });

    expect(invoice.discount_amount).toBe(30);
    expect(invoice.total).toBe(70);
  });

  test('a mixed invoice: the undiscounted line is in the pool and takes its pro-rata share of a fixed credit', async () => {
    const CREDIT_30 = {
      id: 'credit30-id', name: 'Office Credit', discount_type: 'fixed_amount', amount: 30,
      is_active: true, show_in_invoices: true, is_stackable: true,
    };
    const LINE_20 = {
      id: 'line20-id', name: 'Line 20%', discount_type: 'percentage', amount: 20,
      is_active: true, show_in_invoices: true, is_stackable: true,
    };
    const line1 = { client_id: 'line-1', description: 'Pest Control', quantity: 1, unit_price: 100, amount: 100 };
    const line2NoDiscount = { client_id: 'line-2', description: 'Mosquito', quantity: 1, unit_price: 50, amount: 50 };
    const line1Discount = {
      client_id: 'd-line20', _kind: 'discount', discount_id: LINE_20.id, discount_for: 'line-1',
      description: LINE_20.name, quantity: 1, unit_price: -1, amount: -1,
    };
    setupDb({ customer: CUSTOMER, discounts: [CREDIT_30, LINE_20] });

    const invoice = await InvoiceService.create({
      customerId: 'customer-1',
      title: 'Pest Control',
      lineItems: [line1, line1Discount, line2NoDiscount],
      discountIds: [CREDIT_30.id],
    });

    // Pool = $100 (line1) + $50 (line2, undiscounted but still in the
    // pool) = $150. $30 fixed credit spreads pro rata: line1 gets $20
    // (100/150 of $30), leaving $80 -> 20% line discount = $16. line2 (no
    // line discount of its own) gets the remaining $10 share, leaving $40
    // untouched — its presence in the pool is what SHRINKS line1's own
    // share of the credit from a wrongly-exclusive $30 down to $20.
    // Total removed = $20 (line1's credit share) + $16 (line1 20%) + $10
    // (line2's credit share) = $46. A pool that wrongly excluded line2
    // would give line1 the full $30 credit, 20% of the remaining $70 =
    // $14, for $44 off / $106 total instead.
    expect(invoice.discount_amount).toBe(46);
    expect(invoice.total).toBe(104);
  });

  test('the $63/$37 fixed-credit-before-percent case still holds after the pool fix', async () => {
    const CREDIT_30 = {
      id: 'credit30-id', name: 'Office Credit', discount_type: 'fixed_amount', amount: 30,
      is_active: true, show_in_invoices: true, is_stackable: true,
    };
    const LINE_10 = {
      id: 'line10-id', name: 'Line 10%', discount_type: 'percentage', amount: 10,
      is_active: true, show_in_invoices: true, is_stackable: true,
    };
    setupDb({ customer: CUSTOMER, discounts: [CREDIT_30, LINE_10] });

    const invoice = await InvoiceService.create({
      customerId: 'customer-1',
      title: 'Pest Control',
      lineItems: [line, pick(LINE_10)],
      discountIds: [CREDIT_30.id],
    });

    expect(invoice.discount_amount).toBe(37);
    expect(invoice.total).toBe(63);
  });

  test('the 14.5% compounding-percentages case still holds after the pool fix', async () => {
    const INVOICE_10 = {
      id: 'invoice10-id', name: 'Loyalty 10%', discount_type: 'percentage', amount: 10,
      is_active: true, show_in_invoices: true, is_stackable: true,
    };
    const LINE_5 = {
      id: 'line5-id', name: 'Referral 5%', discount_type: 'percentage', amount: 5,
      is_active: true, show_in_invoices: true, is_stackable: true,
    };
    setupDb({ customer: CUSTOMER, discounts: [INVOICE_10, LINE_5] });

    const invoice = await InvoiceService.create({
      customerId: 'customer-1',
      title: 'Pest Control',
      lineItems: [line, pick(LINE_5)],
      discountIds: [INVOICE_10.id],
    });

    expect(invoice.discount_amount).toBe(14.5);
    expect(invoice.total).toBe(85.5);
  });
});

describe('retired stored-discount stack-group metadata (finding 2, P2)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('a retired tier stamp still collides with a fresh pick from the same non-stackable group', async () => {
    const SILVER_RETIRED = {
      id: 'silver-id', name: 'WaveGuard Silver', discount_type: 'percentage', amount: 10,
      is_active: false, show_in_invoices: true, stack_group: 'tier', is_stackable: false,
    };
    const GOLD = {
      id: 'gold-id', name: 'WaveGuard Gold', discount_type: 'percentage', amount: 15,
      is_active: true, show_in_invoices: true, stack_group: 'tier', is_stackable: false,
    };
    setupDb({ customer: { ...CUSTOMER, waveguard_tier: 'Silver' }, discounts: [SILVER_RETIRED, GOLD] });

    await expect(InvoiceService.create({
      customerId: 'customer-1',
      title: 'Pest Control',
      trustedStoredDiscountSources: ['scheduled_service'],
      lineItems: [
        line,
        // The visit's own frozen stamp — resolved and stored before Silver
        // was retired from the catalog. Its dollars are never recomputed.
        {
          client_id: 'd-stamp', _kind: 'discount', discount_id: 'silver-id', discount_for: 'line-1',
          description: 'WaveGuard Silver', quantity: 1, unit_price: -10, amount: -10,
          discount_type: 'percentage', discount_amount: 10, discount_dollars: 10,
          use_stored_discount: true, stored_discount_source: 'scheduled_service',
        },
        // An operator hand-adds Gold on the same line after Silver was
        // retired — must still be refused as a second tier discount.
        pick(GOLD, 'd-gold'),
      ],
    })).rejects.toThrow(/Only one WaveGuard tier discount can apply/);
  });

  test('a retired NON-stored discount id (no live stamp) is unaffected — still filtered as before', async () => {
    // Sanity check: the permissive metadata load only ever widens the
    // trusted-STORED-id set; a fresh pick referencing a retired id (not a
    // trusted stamp) is still refused for the ordinary "unknown discount"
    // reason, not silently accepted.
    const SILVER_RETIRED = {
      id: 'silver-id', name: 'WaveGuard Silver', discount_type: 'percentage', amount: 10,
      is_active: false, show_in_invoices: true, stack_group: 'tier', is_stackable: false,
    };
    setupDb({ customer: CUSTOMER, discounts: [SILVER_RETIRED] });

    await expect(InvoiceService.create({
      customerId: 'customer-1',
      title: 'Pest Control',
      lineItems: [line, pick(SILVER_RETIRED, 'd-fresh')],
    })).rejects.toThrow(/Invalid line-item discount/);
  });
});
