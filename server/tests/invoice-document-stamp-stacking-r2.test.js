/**
 * PR #4405 Codex round 2, the three invoice.js P1s — all "fresh evidence
 * beyond the earlier fix", i.e. the round-1 chokepoint was not wide enough:
 *
 * 1. (finding 2) buildScheduledServiceInvoiceLines emits a scheduled
 *    service's APPOINTMENT-level discount stamp with `discount_for: null`.
 *    The stack's entry filter required a parent line, so the stamp was
 *    dropped from the stack and its frozen dollars added independently
 *    afterwards: a $100 invoice carrying an existing 10% appointment
 *    discount plus a new 5% line discount totalled $85 (additive) instead
 *    of the compounded $85.50.
 *
 * 2. (finding 3) The same no-parent stamp was classified with the ordinary
 *    'line' scope instead of spansAll, and stackGroupConflict deliberately
 *    lets the SAME catalog id sit on two different line scopes — so the
 *    same WaveGuard tier could be applied twice, once as the appointment
 *    stamp and once re-picked on a service line.
 *
 * 3. (finding 4) The document pool was seeded from serviceLineByClientId
 *    only, but normalizeInvoiceLineItems accepts a positive service line
 *    with no client_id. Gate on, such a line plus `discountIds` gave the
 *    document stack an empty pool, every invoice-wide discount resolved to
 *    $0, and the undiscounted subtotal was charged.
 *
 * All three are fixed through helpers create() and calculateUpdateFinancials
 * SHARE (classifyInvoiceDiscountItem, stackInvoiceDocumentDiscounts) — the
 * recurring "create() got a fix the sibling path did not" shape on this PR —
 * so both paths are exercised here.
 */
process.env.GATE_DISCOUNT_STACKING = 'true';
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
  etDateString: jest.fn(() => '2026-09-11'),
  addETDays: jest.fn(() => new Date('2026-10-11T12:00:00Z')),
}));
jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: jest.fn(async (url) => url),
  invoiceShortCodePrefix: jest.fn(() => 'INV'),
}));

const db = require('../models/db');

async function mockTransaction(callback) {
  const trx = (...args) => db(...args);
  trx.isTransaction = true;
  trx.raw = db.raw;
  trx.fn = db.fn;
  trx.transaction = async (inner) => inner(trx);
  return callback(trx);
}

const InvoiceService = require('../services/invoice');
const calculateUpdateFinancials = InvoiceService._calculateUpdateFinancials;

function setupDb({ customer, discounts = [] }) {
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
        where: jest.fn(() => q), whereNot: jest.fn(() => q), whereNotIn: jest.fn(() => q),
        orderBy: jest.fn(() => q), first: jest.fn(async () => null),
        insert: jest.fn((data) => ({
          returning: jest.fn(async () => [{ id: 'invoice-1', invoice_number: data.invoice_number, ...data }]),
        })),
      };
      return q;
    }
    throw new Error(`Unexpected table query: ${table}`);
  });
  db.raw = jest.fn().mockResolvedValue({ rows: [] });
  db.transaction = jest.fn(mockTransaction);
}

const CUSTOMER = { id: 'customer-1', waveguard_tier: 'Bronze', property_type: 'residential' };
const SERVICE_LINE = {
  client_id: 'line-1', description: 'Pest Control', quantity: 1, unit_price: 100, amount: 100,
};

// The appointment-level stamp exactly as buildDiscountLineItem mints it with
// no parentClientId: `_appointment` scope in the client_id, discount_for
// null, document_discount true, and the frozen dollars already resolved.
function appointmentStamp({ discountId = null, dollars = 10, type = 'percentage', amount = 10 } = {}) {
  return {
    client_id: `discount_${discountId || 'custom'}_appointment`,
    _kind: 'discount',
    discount_id: discountId,
    discount_for: null,
    document_discount: true,
    description: 'Appointment discount',
    quantity: 1,
    unit_price: -dollars,
    amount: -dollars,
    discount_amount: amount,
    discount_type: type,
    discount_dollars: dollars,
    use_stored_discount: true,
    stored_discount_source: 'scheduled_service',
  };
}

const LINE_5 = {
  id: 'line5-id', name: 'Referral 5%', discount_type: 'percentage', amount: 5,
  is_active: true, show_in_invoices: true, is_stackable: true,
};
const TIER_GOLD = {
  id: 'tier-gold', name: 'Gold Tier', discount_type: 'percentage', amount: 10,
  is_active: true, show_in_invoices: true, is_stackable: false, stack_group: 'tier',
};

function linePick(d, clientId = `d-${d.id}`) {
  return {
    client_id: clientId, _kind: 'discount', discount_id: d.id, discount_for: 'line-1',
    description: d.name, quantity: 1, unit_price: -1, amount: -1,
  };
}

beforeEach(() => jest.clearAllMocks());

describe('finding 2 — a stored appointment stamp joins the document stack', () => {
  test('EDIT path: $100 + stored 10% appointment stamp + a new 5% line discount compounds to $85.50', async () => {
    setupDb({ customer: CUSTOMER, discounts: [LINE_5] });
    const result = await calculateUpdateFinancials({
      lineItems: [SERVICE_LINE, appointmentStamp({ dollars: 10 }), linePick(LINE_5)],
      customer: CUSTOMER,
      invoice: { id: 'invoice-1' },
      taxRate: 0,
    });
    // $100 − $10 stamp (fixed credit first) = $90, then 5% of $90 = $4.50.
    // Removed $14.50, total $85.50 — NOT the additive $15 / $85 the
    // parent-required filter produced by resolving the 5% on the full $100.
    expect(result.discount_amount).toBe(14.5);
    expect(result.total).toBe(85.5);
  });

  test('CREATE path: the same invoice built through create() totals $85.50 too', async () => {
    setupDb({ customer: CUSTOMER, discounts: [LINE_5] });
    const invoice = await InvoiceService.create({
      customerId: 'customer-1',
      title: 'Pest Control',
      lineItems: [SERVICE_LINE, appointmentStamp({ dollars: 10 }), linePick(LINE_5)],
      // What the scheduled-invoice mint declares (invoice.js ~L2479) so the
      // replayed stamp is trusted rather than treated as a caller-supplied
      // discount line.
      trustedStoredDiscountSources: ['scheduled_service'],
    });
    expect(invoice.discount_amount).toBe(14.5);
    expect(invoice.total).toBe(85.5);
  });

  test('the "Scheduled price adjustment" replay row is NOT swept into the stack', async () => {
    // Same no-parent shape, but a pure arithmetic top-up built inline rather
    // than through buildDiscountLineItem — no document_discount flag, no
    // `_appointment` client_id — so it stays a flat subtraction.
    setupDb({ customer: CUSTOMER, discounts: [LINE_5] });
    const adjustment = {
      client_id: 'discount_scheduled_price_svc-1',
      _kind: 'discount', discount_id: null, discount_for: null,
      description: 'Scheduled price adjustment', quantity: 1,
      unit_price: -10, amount: -10,
      discount_type: 'fixed_amount', discount_amount: 10, discount_dollars: 10,
      use_stored_discount: true, stored_discount_source: 'scheduled_service',
    };
    const result = await calculateUpdateFinancials({
      lineItems: [SERVICE_LINE, adjustment, linePick(LINE_5)],
      customer: CUSTOMER,
      invoice: { id: 'invoice-1' },
      taxRate: 0,
    });
    // The adjustment is not a discount TERM: the 5% still resolves against
    // the full $100 line. $10 + $5 = $15 off, total $85.
    expect(result.discount_amount).toBe(15);
    expect(result.total).toBe(85);
  });
});

describe('finding 3 — a no-parent appointment tier stamp spans the invoice', () => {
  test('EDIT path: the same tier as a stamp AND re-picked on a line is refused', async () => {
    setupDb({ customer: CUSTOMER, discounts: [TIER_GOLD] });
    await expect(calculateUpdateFinancials({
      lineItems: [
        SERVICE_LINE,
        appointmentStamp({ discountId: TIER_GOLD.id, dollars: 10 }),
        linePick(TIER_GOLD),
      ],
      customer: CUSTOMER,
      invoice: { id: 'invoice-1' },
      taxRate: 0,
    })).rejects.toThrow(/Only one WaveGuard tier discount can apply/);
  });

  test('CREATE path: the same double-tier invoice is refused', async () => {
    setupDb({ customer: CUSTOMER, discounts: [TIER_GOLD] });
    await expect(InvoiceService.create({
      customerId: 'customer-1',
      title: 'Pest Control',
      lineItems: [
        SERVICE_LINE,
        appointmentStamp({ discountId: TIER_GOLD.id, dollars: 10 }),
        linePick(TIER_GOLD),
      ],
      trustedStoredDiscountSources: ['scheduled_service'],
    })).rejects.toThrow(/Only one WaveGuard tier discount can apply/);
  });

  test('a tier stamp on its own still saves — the rule is one tier, not none', async () => {
    setupDb({ customer: CUSTOMER, discounts: [TIER_GOLD] });
    const result = await calculateUpdateFinancials({
      lineItems: [SERVICE_LINE, appointmentStamp({ discountId: TIER_GOLD.id, dollars: 10 })],
      customer: CUSTOMER,
      invoice: { id: 'invoice-1' },
      taxRate: 0,
    });
    expect(result.total).toBe(90);
  });
});

describe('finding 4 — the document pool takes every positive line, keyed or not', () => {
  const INVOICE_10 = {
    id: 'invoice10-id', name: 'Loyalty 10%', discount_type: 'percentage', amount: 10,
    is_active: true, show_in_invoices: true, is_stackable: true,
  };

  test('a service line with NO client_id still backs an invoice-level discount', async () => {
    setupDb({ customer: CUSTOMER, discounts: [INVOICE_10] });
    const invoice = await InvoiceService.create({
      customerId: 'customer-1',
      title: 'Pest Control',
      // normalizeInvoiceLineItems accepts this; only client_id is missing.
      lineItems: [{ description: 'Pest Control', quantity: 1, unit_price: 100, amount: 100 }],
      discountIds: [INVOICE_10.id],
    });
    // Pre-fix the pool was empty, the 10% resolved to $0 and the customer
    // was charged the full $100.
    expect(invoice.discount_amount).toBe(10);
    expect(invoice.total).toBe(90);
  });

  test('a mixed invoice (one keyed line, one unkeyed) pools BOTH lines', async () => {
    setupDb({ customer: CUSTOMER, discounts: [INVOICE_10] });
    const invoice = await InvoiceService.create({
      customerId: 'customer-1',
      title: 'Pest Control',
      lineItems: [
        SERVICE_LINE,
        { description: 'Lawn Care', quantity: 1, unit_price: 100, amount: 100 },
      ],
      discountIds: [INVOICE_10.id],
    });
    // 10% of the full $200 subtotal, not 10% of the one keyed line.
    expect(invoice.discount_amount).toBe(20);
    expect(invoice.total).toBe(180);
  });
});
