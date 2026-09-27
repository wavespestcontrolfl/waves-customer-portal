/**
 * InvoiceService.update() — document-level discount with no backing line
 * item (real Postgres round trip). calculateUpdateFinancials derives
 * discount_amount ENTIRELY from negative line items in the SUBMITTED array
 * (InvoiceService.create's own `discountIds` manual picks never become a
 * line), so retotaling an invoice whose discount was never materialized as
 * a line would silently zero the discount and increase the total.
 * invoiceHasUnbackedDocumentDiscount declines that retotal instead —
 * checked against the invoice's STORED (pre-edit) line items, never the
 * submitted ones, so an edit that intentionally removes an existing,
 * already-backed discount still succeeds.
 *
 * Every fixture rolls back.
 */
jest.setTimeout(30000);
let mockConnection;
jest.mock('../models/db', () => new Proxy((...args) => mockConnection(...args), {
  get(_target, key) {
    const value = mockConnection?.[key];
    return typeof value === 'function' ? value.bind(mockConnection) : value;
  },
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const testUrl = process.env.INVOICE_UPDATE_TEST_DATABASE_URL;
const usable = testUrl && ['localhost', '127.0.0.1'].includes(new URL(testUrl).hostname);
const postgres = usable ? describe : describe.skip;

postgres('InvoiceService.update — unbacked document-level discount fence', () => {
  const { randomUUID } = require('node:crypto');
  const InvoiceService = require('../services/invoice');
  let database;
  let trx;

  beforeAll(() => {
    database = require('knex')({ client: 'pg', connection: testUrl, pool: { min: 0, max: 2 } });
  });
  beforeEach(async () => {
    trx = await database.transaction();
    mockConnection = trx;
  });
  afterEach(async () => { await trx.rollback(); mockConnection = database; });
  afterAll(async () => { await database.destroy(); });

  async function fixtureWithBackedDiscount() {
    const customerId = randomUUID();
    const invoiceId = randomUUID();
    await trx('customers').insert({
      id: customerId, first_name: 'Synthetic backed-discount fixture', phone: `qa-${customerId.slice(0, 8)}`, active: true,
    });
    await trx('invoices').insert({
      id: invoiceId, customer_id: customerId,
      token: randomUUID(), invoice_number: `QA-${randomUUID().slice(0, 20)}`,
      status: 'draft', title: 'First Service Application',
      line_items: JSON.stringify([
        { description: 'First service application', quantity: 1, unit_price: 97.20, amount: 97.20 },
        { description: 'Referral credit', quantity: 1, unit_price: -9.72, amount: -9.72 },
      ]),
      discount_amount: 9.72, subtotal: 97.20, total: 87.48,
    });
    return { customerId, invoiceId };
  }

  async function fixtureWithUnbackedDiscount() {
    const customerId = randomUUID();
    const invoiceId = randomUUID();
    await trx('customers').insert({
      id: customerId, first_name: 'Synthetic unbacked-discount fixture', phone: `qa-${customerId.slice(0, 8)}`, active: true,
    });
    await trx('invoices').insert({
      id: invoiceId, customer_id: customerId,
      token: randomUUID(), invoice_number: `QA-${randomUUID().slice(0, 20)}`,
      status: 'draft', title: 'First Service Application',
      // A document-level discountIds pick — discount_amount is positive but
      // NO negative line was ever added to line_items (InvoiceService
      // .create's manualDiscounts never touch line_items — see invoice.js).
      line_items: JSON.stringify([{ description: 'First service application', quantity: 1, unit_price: 91.20, amount: 91.20 }]),
      discount_amount: 9.00, subtotal: 91.20, total: 82.20,
    });
    return { customerId, invoiceId };
  }

  async function fixtureWithMixedDiscount() {
    const customerId = randomUUID();
    const invoiceId = randomUUID();
    await trx('customers').insert({
      id: customerId, first_name: 'Synthetic mixed-discount fixture', phone: `qa-${customerId.slice(0, 8)}`, active: true,
    });
    await trx('invoices').insert({
      id: invoiceId, customer_id: customerId,
      token: randomUUID(), invoice_number: `QA-${randomUUID().slice(0, 20)}`,
      status: 'draft', title: 'First Service Application',
      // A $5 line-item discount PLUS a $10 document-level discountIds pick
      // on the SAME invoice — discount_amount (15) is only PARTLY backed by
      // the negative line (5). "any negative line exists" would wrongly
      // clear this invoice for a retotal.
      line_items: JSON.stringify([
        { description: 'First service application', quantity: 1, unit_price: 100, amount: 100 },
        { description: 'Line credit', quantity: 1, unit_price: -5, amount: -5 },
      ]),
      discount_amount: 15, subtotal: 100, total: 85,
    });
    return { customerId, invoiceId };
  }

  test('a discount PARTLY backed by a line item (a document-level pick rides alongside it) still refuses the retotal', async () => {
    const { invoiceId } = await fixtureWithMixedDiscount();
    await expect(InvoiceService.update(invoiceId, {
      line_items: [
        { description: 'First service application', quantity: 1, unit_price: 100, amount: 100 },
        { description: 'Line credit', quantity: 1, unit_price: -5, amount: -5 },
      ],
    })).rejects.toThrow(/document-level discount with no backing line item/i);
    const stored = await trx('invoices').where({ id: invoiceId }).first();
    expect(Number(stored.total)).toBe(85);
    expect(Number(stored.discount_amount)).toBe(15);
  });

  test('a document-level discount with NO backing line item ANYWHERE refuses the retotal', async () => {
    const { invoiceId } = await fixtureWithUnbackedDiscount();
    await expect(InvoiceService.update(invoiceId, {
      line_items: [{ description: 'First service application', quantity: 1, unit_price: 120, amount: 120 }],
    })).rejects.toThrow(/document-level discount with no backing line item/i);
    const stored = await trx('invoices').where({ id: invoiceId }).first();
    expect(Number(stored.total)).toBe(82.2);
  });

  test('removing an EXISTING, already line-item-backed discount succeeds — checked against the STORED line items, not the submission', async () => {
    const { invoiceId } = await fixtureWithBackedDiscount();
    // The submission drops the negative "Referral credit" line entirely —
    // a deliberate removal, not evidence the discount was never
    // reconstructable. Checking the SUBMITTED array here would see no
    // negative line and wrongly refuse this.
    const updated = await InvoiceService.update(invoiceId, {
      line_items: [{ description: 'First service application', quantity: 1, unit_price: 97.20, amount: 97.20 }],
    });
    expect(Number(updated.discount_amount)).toBe(0);
    expect(Number(updated.total)).toBe(97.2);
  });

  test('an ordinary invoice with no discount at all still edits normally — the fence does not overreach', async () => {
    const customerId = randomUUID();
    const invoiceId = randomUUID();
    await trx('customers').insert({
      id: customerId, first_name: 'Synthetic ordinary fixture', phone: `qa-${customerId.slice(0, 8)}`, active: true,
    });
    await trx('invoices').insert({
      id: invoiceId, customer_id: customerId,
      token: randomUUID(), invoice_number: `QA-${randomUUID().slice(0, 20)}`,
      status: 'draft', title: 'First Service Application',
      line_items: JSON.stringify([{ description: 'First service application', quantity: 1, unit_price: 97.20, amount: 97.20 }]),
      subtotal: 97.20, total: 97.20,
    });
    const updated = await InvoiceService.update(invoiceId, {
      line_items: [{ description: 'First service application', quantity: 1, unit_price: 120, amount: 120 }],
    });
    expect(Number(updated.total)).toBe(120);
  });

  test('a tax-rate-only update on an unbacked-discount invoice ALSO refuses the retotal — not just the line-item branch', async () => {
    const { invoiceId } = await fixtureWithUnbackedDiscount();
    // No line_items in this body at all — the separate tax_rate-only
    // branch also calls calculateUpdateFinancials and must be fenced the
    // same way, or this silently zeros the discount and raises the total.
    await expect(InvoiceService.update(invoiceId, { tax_rate: 0 }))
      .rejects.toThrow(/document-level discount with no backing line item/i);
    const stored = await trx('invoices').where({ id: invoiceId }).first();
    expect(Number(stored.total)).toBe(82.2);
    expect(Number(stored.discount_amount)).toBe(9);
  });

  test('a metadata-only edit (no line_items/tax_rate) on an unbacked-discount invoice is still allowed — the fence is scoped to retotals', async () => {
    const { invoiceId } = await fixtureWithUnbackedDiscount();
    const updated = await InvoiceService.update(invoiceId, { title: 'First Service Application (updated)' });
    expect(updated.title).toBe('First Service Application (updated)');
    expect(Number(updated.total)).toBe(82.2);
  });
});
