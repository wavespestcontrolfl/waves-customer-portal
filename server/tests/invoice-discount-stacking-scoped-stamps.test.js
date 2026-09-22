/**
 * Slice 5 of #4405 — carried #4405 review findings, now fixed in
 * buildScheduledServiceInvoiceLines / stackInvoiceDocumentDiscounts
 * (server/services/invoice.js):
 *
 *   - "Preserve category scope on appointment invoice stamps": a scheduled
 *     appointment discount narrowed to one service
 *     (scheduled_services.discount_service_key_filter /
 *     discount_service_category_filter) must narrow the invoice replay's
 *     document term to just the line(s) it reaches, not spread across
 *     every line on the invoice.
 *   - The lane's scope rule (owner ruling, #4405): no service-key snapshot
 *     ANYWHERE on the invoice ⇒ the stamp replays unscoped (pre-lane
 *     behavior, for invoices predating this lane); a snapshot present but
 *     matching NO line ⇒ the stamp is genuinely orphaned and resolves to
 *     $0, never a silent replay of its frozen face value against the
 *     wrong (or a deleted) line.
 *   - "Trust checkout-stamped discounts": a stored stamp's frozen dollars
 *     are read directly (never recomputed against the live catalog), and a
 *     fresh pick on the same/whole document compounds on what the stamp
 *     already left.
 *
 * All fixtures go through the REAL buildLineItemsForScheduledService (the
 * exact replay a completed-visit invoice uses) and the REAL
 * InvoiceService.create, mocked db only.
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

function setupDb({ customer, scheduledServices = [], scheduledAddons = [], discounts = [] }) {
  let insertedInvoice = null;
  const discountById = new Map(discounts.map((d) => [String(d.id), d]));
  db.mockImplementation((table) => {
    if (table === 'customers') {
      const q = { where: jest.fn(() => q), first: jest.fn(async () => customer) };
      return q;
    }
    if (table === 'scheduled_services') {
      const q = {
        criteria: {},
        where: jest.fn((criteria) => { q.criteria = criteria || {}; return q; }),
        leftJoin: jest.fn(() => q),
        select: jest.fn(() => q),
        first: jest.fn(async () => scheduledServices.find((row) => (
          !q.criteria.id || String(row.id) === String(q.criteria.id)
        ) && (
          !q.criteria['scheduled_services.id'] || String(row.id) === String(q.criteria['scheduled_services.id'])
        )) || null),
      };
      return q;
    }
    if (table === 'scheduled_service_addons') {
      const q = {
        criteria: {},
        where: jest.fn((criteria) => { q.criteria = criteria || {}; return q; }),
        orderBy: jest.fn(() => q),
        then: (resolve, reject) => {
          const rows = scheduledAddons.filter((row) => (
            !q.criteria.scheduled_service_id
            || String(row.scheduled_service_id) === String(q.criteria.scheduled_service_id)
          ));
          return Promise.resolve(rows).then(resolve, reject);
        },
        catch: (reject) => Promise.resolve(scheduledAddons).catch(reject),
      };
      return q;
    }
    if (table === 'discounts') {
      const q = {
        _ids: null,
        whereIn: jest.fn((_field, ids) => { q._ids = ids.map(String); return q; }),
        where: jest.fn(() => q),
        select: jest.fn(() => q),
        first: jest.fn(async () => null),
        then: (resolve, reject) => {
          const rows = q._ids ? q._ids.map((id) => discountById.get(id)).filter(Boolean) : discounts;
          return Promise.resolve(rows).then(resolve, reject);
        },
      };
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

const CUSTOMER = { id: 'customer-1', property_type: 'residential' };

async function createFromScheduled(scheduledServiceId, extraCreateArgs = {}) {
  const scheduledInvoice = await InvoiceService.buildLineItemsForScheduledService(scheduledServiceId, {
    fallbackAmount: 0,
    fallbackDescription: 'Service visit',
  });
  return InvoiceService.create({
    customerId: 'customer-1',
    title: 'Service visit',
    lineItems: scheduledInvoice.lineItems,
    discountIds: scheduledInvoice.discountIds,
    trustedStoredDiscountSources: ['scheduled_service'],
    ...extraCreateArgs,
  });
}

describe('scoped appointment stamps — GATE_DISCOUNT_STACKING on', () => {
  afterEach(() => { delete process.env.GATE_DISCOUNT_STACKING; });
  beforeEach(() => { process.env.GATE_DISCOUNT_STACKING = 'true'; });

  test('a stamp scoped to a service that matches one of two lines only discounts that line', async () => {
    setupDb({
      customer: CUSTOMER,
      scheduledServices: [{
        id: 'sched-1',
        service_type: 'Pest Control',
        estimated_price: 138,
        primary_line_price: 100,
        service_key_snapshot: 'pest_control',
        service_category_snapshot: 'pest',
        discount_id: 'lawn-credit',
        discount_name: 'Lawn Add-on Credit',
        discount_type: 'fixed_amount',
        discount_amount: 12,
        discount_dollars: 12,
        discount_service_key_filter: 'lawn_care',
        discount_service_category_filter: null,
      }],
      scheduledAddons: [{
        id: 'addon-1',
        scheduled_service_id: 'sched-1',
        service_name: 'Lawn Care',
        base_price: 50,
        estimated_price: 50,
        service_key_snapshot: 'lawn_care',
        service_category_snapshot: 'lawn',
      }],
    });

    const invoice = await createFromScheduled('sched-1');

    // Subtotal 150 (100 pest + 50 lawn); only the $50 lawn line absorbs the
    // $12 scoped credit — the $100 pest line is untouched.
    expect(invoice.subtotal).toBe(150);
    expect(invoice.discount_amount).toBe(12);
    expect(invoice.total).toBe(138);
  });

  test('a stamp scoped to a service NOT on this invoice resolves to $0 — orphaned, never a silent frozen-amount overcharge', async () => {
    setupDb({
      customer: CUSTOMER,
      scheduledServices: [{
        id: 'sched-1',
        service_type: 'Pest Control',
        estimated_price: 150,
        primary_line_price: 100,
        service_key_snapshot: 'pest_control',
        service_category_snapshot: 'pest',
        discount_id: 'lawn-credit',
        discount_name: 'Lawn Add-on Credit',
        discount_type: 'fixed_amount',
        discount_amount: 12,
        discount_dollars: 12,
        // Scoped to a service that no longer rides this invoice (the
        // add-on it was priced against was removed before completion).
        discount_service_key_filter: 'lawn_care',
        discount_service_category_filter: null,
      }],
      scheduledAddons: [{
        id: 'addon-1',
        scheduled_service_id: 'sched-1',
        service_name: 'Mosquito',
        base_price: 50,
        estimated_price: 50,
        service_key_snapshot: 'mosquito',
        service_category_snapshot: 'mosquito',
      }],
    });

    const invoice = await createFromScheduled('sched-1');

    expect(invoice.subtotal).toBe(150);
    expect(invoice.discount_amount).toBe(0);
    expect(invoice.total).toBe(150);
  });

  test('an unscoped stamp (no filter) still reaches every line, spread pro rata, exactly as before this lane', async () => {
    setupDb({
      customer: CUSTOMER,
      scheduledServices: [{
        id: 'sched-1',
        service_type: 'Pest Control',
        estimated_price: 150,
        primary_line_price: 100,
        service_key_snapshot: 'pest_control',
        service_category_snapshot: 'pest',
        discount_id: 'doc-credit',
        discount_name: 'Loyalty Credit',
        discount_type: 'fixed_amount',
        discount_amount: 30,
        discount_dollars: 30,
        discount_service_key_filter: null,
        discount_service_category_filter: null,
      }],
      scheduledAddons: [{
        id: 'addon-1',
        scheduled_service_id: 'sched-1',
        service_name: 'Lawn Care',
        base_price: 50,
        estimated_price: 50,
        service_key_snapshot: 'lawn_care',
        service_category_snapshot: 'lawn',
      }],
    });

    const invoice = await createFromScheduled('sched-1');

    expect(invoice.subtotal).toBe(150);
    expect(invoice.discount_amount).toBe(30);
    expect(invoice.total).toBe(120);
  });

  // A pre-lane invoice — hand-built lineItems, never routed through
  // buildScheduledServiceInvoiceLines — carries NO service_key on any
  // line. A defensively-shaped document-wide stamp with a scope filter on
  // it (a shape this invoice's own builder never produces, but a future
  // caller or historical data might) must still replay UNSCOPED rather
  // than resolving an empty pool and silently zeroing a real credit — the
  // lane rule's "no keys anywhere ⇒ unscoped" half.
  test('no service-key snapshot anywhere on the invoice: a scoped-looking stamp still replays unscoped', async () => {
    setupDb({ customer: CUSTOMER });
    const invoice = await InvoiceService.create({
      customerId: 'customer-1',
      title: 'Hand-built invoice',
      lineItems: [
        { client_id: 'line-1', description: 'Pest Control', quantity: 1, unit_price: 100, amount: 100 },
        {
          client_id: 'discount_doc-credit_appointment',
          _kind: 'discount',
          discount_id: 'doc-credit',
          discount_for: null,
          document_discount: true,
          document_scope_service_key: 'lawn_care', // no line on this invoice carries service_key at all
          description: 'Loyalty Credit',
          quantity: 1,
          unit_price: -20,
          amount: -20,
          discount_type: 'fixed_amount',
          discount_amount: 20,
          discount_dollars: 20,
          use_stored_discount: true,
          stored_discount_source: 'scheduled_service',
        },
      ],
      trustedStoredDiscountSources: ['scheduled_service'],
    });

    expect(invoice.subtotal).toBe(100);
    expect(invoice.discount_amount).toBe(20);
    expect(invoice.total).toBe(80);
  });

  test('a frozen stamp compounds with a fresh manual pick on the whole document (fixed before percent)', async () => {
    setupDb({
      customer: CUSTOMER,
      discounts: [{
        id: 'fresh-percent',
        discount_type: 'percentage',
        amount: 10,
        is_active: true,
        show_in_invoices: true,
        max_discount_dollars: null,
      }],
      scheduledServices: [{
        id: 'sched-1',
        service_type: 'Pest Control',
        estimated_price: 100,
        primary_line_price: 100,
        service_key_snapshot: 'pest_control',
        service_category_snapshot: 'pest',
        discount_id: 'stamp-credit',
        discount_name: 'Stamp Credit',
        discount_type: 'fixed_amount',
        discount_amount: 9,
        discount_dollars: 9,
        discount_service_key_filter: null,
        discount_service_category_filter: null,
      }],
    });

    const invoice = await createFromScheduled('sched-1', { discountIds: ['fresh-percent'] });

    // Fixed stamp ($9) applies first: 100 - 9 = 91. Then the fresh 10%
    // manual pick compounds on the remainder: 91 * 10% = $9.10.
    // Total discount = 9 + 9.10 = $18.10, never the un-compounded
    // 9 + 10 = $19 a naive "each independently" sum would give.
    expect(invoice.subtotal).toBe(100);
    expect(invoice.discount_amount).toBe(18.1);
    expect(invoice.total).toBe(81.9);
  });
});

describe('scoped appointment stamps — GATE_DISCOUNT_STACKING off: byte-identical to before this lane', () => {
  test('the scoped stamp from the orphan fixture above still replays its full frozen amount off gate (pre-lane behavior, unaffected by scope)', async () => {
    setupDb({
      customer: CUSTOMER,
      scheduledServices: [{
        id: 'sched-1',
        service_type: 'Pest Control',
        estimated_price: 150,
        primary_line_price: 100,
        service_key_snapshot: 'pest_control',
        service_category_snapshot: 'pest',
        discount_id: 'lawn-credit',
        discount_name: 'Lawn Add-on Credit',
        discount_type: 'fixed_amount',
        discount_amount: 12,
        discount_dollars: 12,
        discount_service_key_filter: 'lawn_care',
        discount_service_category_filter: null,
      }],
      scheduledAddons: [{
        id: 'addon-1',
        scheduled_service_id: 'sched-1',
        service_name: 'Mosquito',
        base_price: 50,
        estimated_price: 50,
        service_key_snapshot: 'mosquito',
        service_category_snapshot: 'mosquito',
      }],
    });

    const invoice = await createFromScheduled('sched-1');

    // Gate off never consults scope at all — the stamp's frozen $12
    // replays exactly as it always has, whether or not its target service
    // still rides this invoice.
    expect(invoice.subtotal).toBe(150);
    expect(invoice.discount_amount).toBe(12);
    expect(invoice.total).toBe(138);
  });
});
