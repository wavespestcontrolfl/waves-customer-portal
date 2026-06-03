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
  etDateString: jest.fn(() => '2026-05-11'),
  addETDays: jest.fn(() => new Date('2026-06-10T12:00:00Z')),
}));
jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: jest.fn(async (url) => url),
  invoiceShortCodePrefix: jest.fn(() => 'INV'),
}));

const db = require('../models/db');
const DiscountEngine = require('../services/discount-engine');
const InvoiceService = require('../services/invoice');

function setupDb({
  customer,
  discounts = [],
  scheduledServices = [],
  scheduledAddons = [],
  serviceRecords = [],
}) {
  let insertedInvoice = null;
  const discountById = new Map(discounts.map((row) => [String(row.id), row]));

  db.mockImplementation((table) => {
    if (table === 'customers') {
      const q = {
        where: jest.fn(() => q),
        first: jest.fn(async () => customer),
      };
      return q;
    }

    if (table === 'discounts') {
      const q = {
        ids: null,
        whereIn: jest.fn((_field, ids) => { q.ids = ids.map(String); return q; }),
        where: jest.fn(() => q),
        select: jest.fn(() => q),
        first: jest.fn(async () => discounts.find((row) => row.is_waveguard_tier_discount && row.requires_waveguard_tier === customer.waveguard_tier) || null),
        then: (resolve, reject) => {
          const rows = q.ids ? q.ids.map((id) => discountById.get(id)).filter(Boolean) : discounts;
          return Promise.resolve(rows).then(resolve, reject);
        },
      };
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
        ) && (
          !q.criteria.customer_id || String(row.customer_id) === String(q.criteria.customer_id)
        )) || null),
      };
      return q;
    }

    if (table === 'service_records') {
      const q = {
        criteria: {},
        where: jest.fn((criteria) => { q.criteria = criteria || {}; return q; }),
        andWhere: jest.fn((criteria) => { q.criteria = { ...q.criteria, ...(criteria || {}) }; return q; }),
        leftJoin: jest.fn(() => q),
        select: jest.fn(() => q),
        first: jest.fn(async () => serviceRecords.find((row) => (
          (!q.criteria.id || String(row.id) === String(q.criteria.id))
          && (!q.criteria['service_records.id'] || String(row.id) === String(q.criteria['service_records.id']))
          && (!q.criteria.customer_id || String(row.customer_id) === String(q.criteria.customer_id))
          && (!q.criteria['service_records.customer_id'] || String(row.customer_id) === String(q.criteria['service_records.customer_id']))
        )) || null),
      };
      return q;
    }

    if (table === 'service_products' || table === 'service_photos') {
      const q = {
        where: jest.fn(() => q),
        orderBy: jest.fn(() => q),
        select: jest.fn(async () => []),
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
        catch: (reject) => Promise.resolve(scheduledAddons.filter((row) => (
          !q.criteria.scheduled_service_id
          || String(row.scheduled_service_id) === String(q.criteria.scheduled_service_id)
        ))).catch(reject),
      };
      return q;
    }

    if (table === 'invoices') {
      const q = {
        where: jest.fn(() => q),
        orderBy: jest.fn(() => q),
        first: jest.fn(async () => null),
        insert: jest.fn((data) => {
          insertedInvoice = data;
          return {
            returning: jest.fn(async () => [{
              id: 'invoice-1',
              invoice_number: data.invoice_number,
              ...data,
            }]),
          };
        }),
      };
      return q;
    }

    throw new Error(`Unexpected table query: ${table}`);
  });

  return {
    getInsertedInvoice: () => insertedInvoice,
  };
}

describe('invoice tier discounts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    DiscountEngine.getDiscountForTier.mockResolvedValue(0.10);
  });

  test('does not apply Silver automatically when no discount was selected manually', async () => {
    const ctx = setupDb({
      customer: { id: 'customer-1', waveguard_tier: 'Silver', property_type: 'residential' },
      discounts: [{
        id: 'silver-id',
        name: 'WaveGuard Silver',
        discount_type: 'percentage',
        amount: 10,
        is_active: true,
        show_in_invoices: true,
        is_waveguard_tier_discount: true,
        requires_waveguard_tier: 'Silver',
      }],
    });

    const invoice = await InvoiceService.create({
      customerId: 'customer-1',
      title: 'Pest Control',
      lineItems: [{ description: 'Pest Control', quantity: 1, unit_price: 100, amount: 100 }],
    });

    expect(DiscountEngine.getDiscountForTier).not.toHaveBeenCalled();
    expect(DiscountEngine.calculateDiscounts).not.toHaveBeenCalled();
    expect(invoice.discount_amount).toBe(0);
    expect(invoice.total).toBe(100);
    expect(ctx.getInsertedInvoice().discount_label).toBeNull();
    expect(DiscountEngine.recordInvoiceDiscounts).not.toHaveBeenCalled();
  });

  test('manual Silver line discount applies only when selected', async () => {
    const ctx = setupDb({
      customer: { id: 'customer-1', waveguard_tier: 'Silver', property_type: 'residential' },
      discounts: [{
        id: 'silver-id',
        name: 'WaveGuard Silver',
        discount_type: 'percentage',
        amount: 10,
        is_active: true,
        show_in_invoices: true,
        is_waveguard_tier_discount: true,
        requires_waveguard_tier: 'Silver',
      }],
    });

    const invoice = await InvoiceService.create({
      customerId: 'customer-1',
      title: 'Pest Control',
      lineItems: [
        { client_id: 'line-1', description: 'Pest Control', quantity: 1, unit_price: 100, amount: 100 },
        { _kind: 'discount', discount_id: 'silver-id', discount_for: 'line-1', description: 'WaveGuard Silver', quantity: 1, unit_price: -1, amount: -1 },
      ],
    });

    expect(DiscountEngine.getDiscountForTier).not.toHaveBeenCalled();
    expect(DiscountEngine.calculateDiscounts).not.toHaveBeenCalled();
    expect(invoice.discount_amount).toBe(10);
    expect(invoice.total).toBe(90);
    expect(ctx.getInsertedInvoice().discount_label).toBe('Line-item discounts');
    expect(DiscountEngine.recordInvoiceDiscounts).toHaveBeenCalledWith(
      'invoice-1',
      [expect.objectContaining({ id: 'silver-id', name: 'WaveGuard Silver', discount_dollars: 10 })],
      'system'
    );
  });

  test('manual tier discount can be selected when customer does not match the tier', async () => {
    const ctx = setupDb({
      customer: { id: 'customer-1', waveguard_tier: 'Bronze', property_type: 'residential' },
      discounts: [{
        id: 'silver-id',
        name: 'WaveGuard Silver',
        discount_type: 'percentage',
        amount: 10,
        is_active: true,
        show_in_invoices: true,
        is_waveguard_tier_discount: true,
        requires_waveguard_tier: 'Silver',
      }],
    });

    const invoice = await InvoiceService.create({
      customerId: 'customer-1',
      title: 'Pest Control',
      lineItems: [
        { client_id: 'line-1', description: 'Pest Control', quantity: 1, unit_price: 100, amount: 100 },
        { _kind: 'discount', discount_id: 'silver-id', discount_for: 'line-1', description: 'WaveGuard Silver', quantity: 1, unit_price: -1, amount: -1 },
      ],
    });

    expect(invoice.discount_amount).toBe(10);
    expect(invoice.total).toBe(90);
    expect(ctx.getInsertedInvoice().discount_label).toBe('Line-item discounts');
  });


  test('scheduled invoice replay keeps zero-dollar primary service from double billing add-ons', async () => {
    setupDb({
      customer: { id: 'customer-1', waveguard_tier: 'Silver', property_type: 'residential' },
      scheduledServices: [{
        id: 'scheduled-1',
        service_type: 'Initial Visit',
        estimated_price: 50,
        primary_line_price: 0,
      }],
      scheduledAddons: [{
        id: 'addon-1',
        scheduled_service_id: 'scheduled-1',
        service_name: 'Rodent Add-on',
        base_price: 50,
        estimated_price: 50,
      }],
    });

    const scheduledInvoice = await InvoiceService.buildLineItemsForScheduledService('scheduled-1', {
      fallbackAmount: 50,
      fallbackDescription: 'Initial Visit',
    });

    expect(scheduledInvoice.discountIds).toEqual([]);
    expect(scheduledInvoice.lineItems).toEqual([
      expect.objectContaining({ description: 'Rodent Add-on', amount: 50 }),
    ]);
  });

  test('scheduled invoice replay skips stored discounts when gross base is unavailable', async () => {
    setupDb({
      customer: { id: 'customer-1', waveguard_tier: 'Silver', property_type: 'residential' },
      scheduledServices: [{
        id: 'scheduled-1',
        service_type: 'Pest Control',
        estimated_price: 90,
        primary_line_price: null,
        line_discount_id: 'silver-id',
        line_discount_name: 'WaveGuard Silver',
        line_discount_type: 'percentage',
        line_discount_amount: 10,
        line_discount_dollars: 10,
      }],
    });

    const scheduledInvoice = await InvoiceService.buildLineItemsForScheduledService('scheduled-1', {
      fallbackAmount: 90,
      fallbackDescription: 'Pest Control',
    });

    expect(scheduledInvoice.lineItems).toEqual([
      expect.objectContaining({ description: 'Pest Control', amount: 90 }),
    ]);
  });

  test('scheduled invoice replay reconciles gross callback lines to stored net amount', async () => {
    setupDb({
      customer: { id: 'customer-1', waveguard_tier: 'Silver', property_type: 'residential' },
      scheduledServices: [{
        id: 'scheduled-1',
        service_type: 'Callback Visit',
        estimated_price: 0,
        primary_line_price: 100,
      }],
    });

    const scheduledInvoice = await InvoiceService.buildLineItemsForScheduledService('scheduled-1', {
      fallbackAmount: 0,
      fallbackDescription: 'Callback Visit',
    });
    const invoice = await InvoiceService.create({
      customerId: 'customer-1',
      title: 'Callback Visit',
      lineItems: scheduledInvoice.lineItems,
      trustedStoredDiscountSources: ['scheduled_service'],
    });

    expect(invoice.subtotal).toBe(100);
    expect(invoice.discount_amount).toBe(100);
    expect(invoice.total).toBe(0);
  });

  test('scheduled invoice creation hydrates service date and type', async () => {
    const ctx = setupDb({
      customer: { id: 'customer-1', waveguard_tier: 'Bronze', property_type: 'residential' },
      scheduledServices: [{
        id: 'scheduled-1',
        customer_id: 'customer-1',
        scheduled_date: '2026-06-12',
        service_type: 'Quarterly Pest Control',
        technician_id: 'tech-1',
        tech_name: 'Taylor',
      }],
    });

    const invoice = await InvoiceService.create({
      customerId: 'customer-1',
      scheduledServiceId: 'scheduled-1',
      title: 'First Service Application',
      lineItems: [{ description: 'First service application', quantity: 1, unit_price: 125 }],
    });

    expect(invoice.service_date).toBe('2026-06-12');
    expect(invoice.service_type).toBe('Quarterly Pest Control');
    expect(ctx.getInsertedInvoice()).toMatchObject({
      scheduled_service_id: 'scheduled-1',
      service_date: '2026-06-12',
      service_type: 'Quarterly Pest Control',
      technician_id: 'tech-1',
      tech_name: 'Taylor',
    });
  });

  test('scheduled invoice replay uses persisted discount dollars instead of current catalog amounts', async () => {
    const ctx = setupDb({
      customer: { id: 'customer-1', waveguard_tier: 'Silver', property_type: 'residential' },
      discounts: [{
        id: 'silver-id',
        name: 'WaveGuard Silver',
        discount_type: 'percentage',
        amount: 25,
        is_active: true,
        show_in_invoices: true,
        is_waveguard_tier_discount: true,
        requires_waveguard_tier: 'Silver',
      }],
      scheduledServices: [{
        id: 'scheduled-1',
        service_type: 'Pest Control',
        estimated_price: 81,
        primary_line_price: 100,
        line_discount_id: 'silver-id',
        line_discount_name: 'WaveGuard Silver',
        line_discount_type: 'percentage',
        line_discount_amount: 10,
        line_discount_dollars: 10,
        discount_id: 'silver-id',
        discount_name: 'WaveGuard Silver',
        discount_type: 'percentage',
        discount_amount: 10,
        discount_dollars: 9,
      }],
    });

    const scheduledInvoice = await InvoiceService.buildLineItemsForScheduledService('scheduled-1', {
      fallbackAmount: 81,
      fallbackDescription: 'Pest Control',
    });
    const invoice = await InvoiceService.create({
      customerId: 'customer-1',
      title: 'Pest Control',
      lineItems: scheduledInvoice.lineItems,
      discountIds: scheduledInvoice.discountIds,
      trustedStoredDiscountSources: ['scheduled_service'],
    });

    expect(DiscountEngine.getDiscountForTier).not.toHaveBeenCalled();
    expect(invoice.discount_amount).toBe(19);
    expect(invoice.total).toBe(81);
    expect(ctx.getInsertedInvoice().subtotal).toBe(100);
    expect(DiscountEngine.recordInvoiceDiscounts).toHaveBeenCalledWith(
      'invoice-1',
      expect.arrayContaining([
        expect.objectContaining({ id: 'silver-id', name: 'WaveGuard Silver', amount: 10, discount_dollars: 10 }),
        expect.objectContaining({ id: 'silver-id', name: 'WaveGuard Silver', amount: 10, discount_dollars: 9 }),
      ]),
      'system'
    );
  });

  test('createFromService honors explicit amount instead of stale scheduled replay', async () => {
    const ctx = setupDb({
      customer: { id: 'customer-1', waveguard_tier: 'Silver', property_type: 'residential' },
      serviceRecords: [{
        id: 'record-1',
        customer_id: 'customer-1',
        scheduled_service_id: 'scheduled-1',
        service_type: 'Pest Control',
      }],
      scheduledServices: [{
        id: 'scheduled-1',
        service_type: 'Pest Control',
        estimated_price: 90,
        primary_line_price: 100,
        line_discount_id: 'silver-id',
        line_discount_name: 'WaveGuard Silver',
        line_discount_type: 'percentage',
        line_discount_amount: 10,
        line_discount_dollars: 10,
      }],
    });

    const invoice = await InvoiceService.createFromService('record-1', {
      amount: 77,
      description: 'Adjusted visit',
    });

    expect(invoice.subtotal).toBe(77);
    expect(invoice.discount_amount).toBe(0);
    expect(invoice.total).toBe(77);
    expect(JSON.parse(ctx.getInsertedInvoice().line_items)).toEqual([
      expect.objectContaining({ description: 'Adjusted visit', amount: 77 }),
    ]);
  });

  test('createFromService replays scheduled audit when completion requests scheduled replay', async () => {
    setupDb({
      customer: { id: 'customer-1', waveguard_tier: 'Silver', property_type: 'residential' },
      discounts: [{
        id: 'silver-id',
        name: 'WaveGuard Silver',
        discount_type: 'percentage',
        amount: 10,
        is_active: true,
        show_in_invoices: true,
        is_waveguard_tier_discount: true,
        requires_waveguard_tier: 'Silver',
      }],
      serviceRecords: [{
        id: 'record-1',
        customer_id: 'customer-1',
        scheduled_service_id: 'scheduled-1',
        service_type: 'Pest Control',
      }],
      scheduledServices: [{
        id: 'scheduled-1',
        service_type: 'Pest Control',
        estimated_price: 90,
        primary_line_price: 100,
        line_discount_id: 'silver-id',
        line_discount_name: 'WaveGuard Silver',
        line_discount_type: 'percentage',
        line_discount_amount: 10,
        line_discount_dollars: 10,
      }],
    });

    const invoice = await InvoiceService.createFromService('record-1', {
      amount: 77,
      description: 'Adjusted visit',
      useScheduledReplay: true,
    });

    expect(invoice.subtotal).toBe(100);
    expect(invoice.discount_amount).toBe(10);
    expect(invoice.total).toBe(90);
    expect(DiscountEngine.recordInvoiceDiscounts).toHaveBeenCalledWith(
      'invoice-1',
      [expect.objectContaining({ id: 'silver-id', discount_dollars: 10 })],
      'system'
    );
  });
});
