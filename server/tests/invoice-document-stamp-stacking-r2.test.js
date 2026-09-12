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
function appointmentStamp({ discountId = null, dollars = 10, type = 'percentage', amount = 10, scopeKey = null } = {}) {
  return {
    ...(scopeKey ? { document_scope_service_key: scopeKey } : {}),
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


/**
 * Round 3, P1 — a scheduled appointment discount narrowed to one service
 * (`discount_service_key_filter`) must not spread across every invoice line.
 * Round 2 made every no-parent stamp document-wide; a scoped one then moved
 * the base the OTHER lines' percentages compound on.
 */
describe('r3 — a SCOPED appointment stamp reaches only its own lines', () => {
  const PRIMARY = {
    client_id: 'line-1', description: 'Pest Control', quantity: 1, unit_price: 100, amount: 100,
    service_key: 'pest_general_quarterly',
  };
  const ADDON = {
    client_id: 'line-2', description: 'Lawn Care', quantity: 1, unit_price: 100, amount: 100,
    service_key: 'lawn_fert_monthly',
  };
  const LINE_10 = {
    id: 'line10-id', name: 'Line 10%', discount_type: 'percentage', amount: 10,
    is_active: true, show_in_invoices: true, is_stackable: true,
  };
  const primaryPick = {
    client_id: 'd-line10', _kind: 'discount', discount_id: LINE_10.id, discount_for: 'line-1',
    description: LINE_10.name, quantity: 1, unit_price: -1, amount: -1,
  };

  test('a $30 add-on-only credit leaves the primary line’s 10% at $10, not $8.50', async () => {
    setupDb({ customer: CUSTOMER, discounts: [LINE_10] });
    const result = await calculateUpdateFinancials({
      lineItems: [
        PRIMARY,
        ADDON,
        appointmentStamp({ dollars: 30, type: 'fixed_amount', amount: 30, scopeKey: 'lawn_fert_monthly' }),
        primaryPick,
      ],
      customer: CUSTOMER,
      invoice: { id: 'invoice-1' },
      taxRate: 0,
    });
    // $30 off the lawn line only; the pest line still carries its full $100
    // when its own 10% resolves. Removed = $30 + $10 = $40 of $200.
    expect(result.discount_amount).toBe(40);
    expect(result.total).toBe(160);
  });

  test('the same stamp UNSCOPED spreads and drops the 10% to $8.50 — the behavior scoping must avoid', async () => {
    setupDb({ customer: CUSTOMER, discounts: [LINE_10] });
    const result = await calculateUpdateFinancials({
      lineItems: [
        PRIMARY,
        ADDON,
        appointmentStamp({ dollars: 30, type: 'fixed_amount', amount: 30 }),
        primaryPick,
      ],
      customer: CUSTOMER,
      invoice: { id: 'invoice-1' },
      taxRate: 0,
    });
    // $15 off each line, then 10% of the primary's remaining $85 = $8.50.
    expect(result.discount_amount).toBe(38.5);
  });

  test('a scope naming no line on the invoice takes $0, not the frozen $30 (r4 P1)', async () => {
    // Codex #4405 r4 P1: an appointment discount scoped to one service (here
    // 'termite_bond') whose line was deleted/changed by THIS same invoice
    // edit resolves an empty eligible pool in the document stack — but the
    // reduce that turns stack results into discount_amount used to check
    // isStoredDiscountLineItem() FIRST and short-circuit straight to the
    // frozen storedDiscountDollars(item), never consulting the stack's
    // eligibleLines-aware result. A $30 add-on-only credit therefore
    // survived after the add-on it targeted was gone, and discounted
    // unrelated services (here the pest line's own pick) forever.
    setupDb({ customer: CUSTOMER, discounts: [LINE_10] });
    const result = await calculateUpdateFinancials({
      lineItems: [
        PRIMARY,
        ADDON,
        appointmentStamp({ dollars: 30, type: 'fixed_amount', amount: 30, scopeKey: 'termite_bond' }),
        primaryPick,
      ],
      customer: CUSTOMER,
      invoice: { id: 'invoice-1' },
      taxRate: 0,
    });
    // The orphaned stamp takes $0 (its scope matches nothing), so the
    // primary's own 10% resolves against its full $100 = $10. Total removed
    // is $10, NOT $40 (the pre-fix $30 orphaned stamp + $10).
    expect(result.discount_amount).toBe(10);
    expect(result.total).toBe(190);
  });

  test('CREATE path: the same orphaned-scope invoice also takes $0 for the stamp', async () => {
    setupDb({ customer: CUSTOMER, discounts: [LINE_10] });
    const invoice = await InvoiceService.create({
      customerId: 'customer-1',
      title: 'Pest Control',
      lineItems: [
        PRIMARY,
        ADDON,
        appointmentStamp({ dollars: 30, type: 'fixed_amount', amount: 30, scopeKey: 'termite_bond' }),
        primaryPick,
      ],
      trustedStoredDiscountSources: ['scheduled_service'],
    });
    expect(invoice.discount_amount).toBe(10);
    expect(invoice.total).toBe(190);
  });

  test('an UNSCOPED stamp keeps taking its full frozen dollars even with no other change', async () => {
    // Contrast case named in the assignment: an unscoped stamp's pool is
    // every line, so it must be completely unaffected by the r4 fix.
    setupDb({ customer: CUSTOMER, discounts: [LINE_10] });
    const result = await calculateUpdateFinancials({
      lineItems: [
        PRIMARY,
        ADDON,
        appointmentStamp({ dollars: 30, type: 'fixed_amount', amount: 30 }),
        primaryPick,
      ],
      customer: CUSTOMER,
      invoice: { id: 'invoice-1' },
      taxRate: 0,
    });
    expect(result.discount_amount).toBe(38.5);
  });
});


/**
 * Round-3 fallback P1 — classifyInvoiceDiscountItem must use the SAME
 * trusted-source list as the caller's parallel `stored` flag. Reading the
 * default let the two disagree on one item, so it matched neither the line
 * entries (no parent) nor the document entries (spansAll && stored), fell
 * through to the resolver and threw "Invalid line-item discount": a
 * legitimate legacy stamp replay became a hard invoice-save failure.
 */
describe('r3 fallback — spansAll and stored never disagree on one item', () => {
  // A LEGACY stamp: no document_discount flag (it predates the lane), so the
  // classifier can only recognize it structurally — trusted stored source
  // plus the `_appointment` client_id suffix.
  function legacyStamp({ source = 'scheduled_service', discountId = 'legacy-1' } = {}) {
    return {
      client_id: `discount_${discountId}_appointment`,
      _kind: 'discount',
      discount_id: discountId,
      discount_for: null,
      description: 'Appointment discount',
      quantity: 1,
      unit_price: -10,
      amount: -10,
      discount_type: 'fixed_amount',
      discount_amount: 10,
      discount_dollars: 10,
      use_stored_discount: true,
      stored_discount_source: source,
    };
  }
  const LEGACY_DISC = {
    id: 'legacy-1', name: 'Legacy Appointment Discount', discount_type: 'fixed_amount', amount: 10,
    is_active: true, show_in_invoices: true, is_stackable: true,
  };

  test('a caller trusting only validated_checkout still gets its stamp COMPOUNDED', async () => {
    setupDb({ customer: CUSTOMER, discounts: [LEGACY_DISC, LINE_5] });
    const invoice = await InvoiceService.create({
      customerId: 'customer-1',
      title: 'Checkout',
      lineItems: [
        SERVICE_LINE,
        legacyStamp({ source: 'validated_checkout' }),
        linePick(LINE_5),
      ],
      trustedStoredDiscountSources: ['validated_checkout'],
    });
    // Pre-fix, spansAll came from the DEFAULT trusted set (which does not
    // trust validated_checkout) while `stored` came from the caller's, so the
    // stamp was NOT collected as a document term. Its dollars were still
    // counted (the resolver's stored branch catches it), but the fresh 5%
    // resolved against the full $100 instead of the $90 the stamp left:
    // $15 off, not $14.50. The failure is a compounding mismatch, not the
    // hard save failure the finding predicted.
    expect(invoice.discount_amount).toBe(14.5);
    expect(invoice.total).toBe(85.5);
  });

  test('an UNTRUSTED no-parent discount row is still refused — unchanged from main', async () => {
    setupDb({ customer: CUSTOMER, discounts: [LEGACY_DISC] });
    // The caller does not trust scheduled_service, so this is neither a frozen
    // stamp nor a parented pick: refusing it is the pre-existing contract, and
    // the fix must not turn that into a silent document-wide discount. What
    // the fix changes is only that spansAll and stored now AGREE (both false)
    // instead of disagreeing.
    await expect(InvoiceService.create({
      customerId: 'customer-1',
      title: 'Checkout',
      lineItems: [SERVICE_LINE, legacyStamp({ source: 'scheduled_service' })],
      trustedStoredDiscountSources: ['validated_checkout'],
    })).rejects.toThrow(/Invalid line-item discount/);
  });

  test('the default trust list still recognizes a scheduled_service legacy stamp', async () => {
    setupDb({ customer: CUSTOMER, discounts: [LEGACY_DISC] });
    const result = await calculateUpdateFinancials({
      lineItems: [SERVICE_LINE, legacyStamp({ source: 'scheduled_service' })],
      customer: CUSTOMER,
      invoice: { id: 'invoice-1' },
      taxRate: 0,
    });
    expect(result.total).toBe(90);
  });
});


/**
 * The orphaned-scope fix must not overcharge a LEGACY invoice. Only lines
 * built by buildScheduledServiceInvoiceLines carry `service_key`; an invoice
 * persisted before this lane has none, so a scoped stamp replayed onto it
 * would match no line, resolve to $0, and silently bill the customer the
 * whole credit. Scope is honored only when the invoice actually carries keys.
 */
describe('a scoped stamp on a KEYLESS legacy invoice keeps its credit', () => {
  const KEYLESS_PRIMARY = {
    client_id: 'line-1', description: 'Pest Control', quantity: 1, unit_price: 100, amount: 100,
  };
  const KEYLESS_ADDON = {
    client_id: 'line-2', description: 'Lawn Care', quantity: 1, unit_price: 100, amount: 100,
  };

  test('no line carries a service key → the stamp is treated as unscoped, not dropped', async () => {
    setupDb({ customer: CUSTOMER, discounts: [] });
    const result = await calculateUpdateFinancials({
      lineItems: [
        KEYLESS_PRIMARY,
        KEYLESS_ADDON,
        appointmentStamp({ dollars: 30, type: 'fixed_amount', amount: 30, scopeKey: 'lawn_fert_monthly' }),
      ],
      customer: CUSTOMER,
      invoice: { id: 'invoice-1' },
      taxRate: 0,
    });
    // The $30 credit still applies. Dropping it would bill $200 instead of
    // $170 — an overcharge on an invoice that simply predates service_key.
    expect(result.discount_amount).toBe(30);
    expect(result.total).toBe(170);
  });

  test('keys PRESENT but none matching still resolves to $0 — the orphaned case', async () => {
    setupDb({ customer: CUSTOMER, discounts: [] });
    const result = await calculateUpdateFinancials({
      lineItems: [
        { ...KEYLESS_PRIMARY, service_key: 'pest_general_quarterly' },
        appointmentStamp({ dollars: 30, type: 'fixed_amount', amount: 30, scopeKey: 'lawn_fert_monthly' }),
      ],
      customer: CUSTOMER,
      invoice: { id: 'invoice-1' },
      taxRate: 0,
    });
    expect(result.discount_amount).toBe(0);
    expect(result.total).toBe(100);
  });
});
