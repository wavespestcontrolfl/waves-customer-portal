/**
 * Codex #5021 P1 (item B): the first-application-sibling-split marker
 * (recurring_template_overrides.first_application_split_invoice_id, stamped
 * by first-application-sibling-split.js) is trusted PERMANENTLY by every
 * completion/closeout reader — nothing re-validates it against the source
 * invoice's current state. The chosen fix is the OTHER option the review
 * comment offered: fence edits to a split SOURCE invoice inside
 * InvoiceService.update() itself, so the invoice a marker points at can
 * never drift back to covering the sibling again. This file proves that
 * fence against a REAL Postgres round trip (real column, real predicate),
 * using the same models/db-mock-forwards-to-a-transaction pattern as
 * invoice-create-discount-stacking-postgres.test.js — every fixture rolls
 * back.
 *
 * Also covers the same PR's shared invoiceHasUnbackedDocumentDiscount fence
 * (item A) on update()'s OWN line-item retotal path — specifically the
 * Codex pre-push round-2 fix for checking it against the invoice's STORED
 * line items, never the submitted ones (an edit that intentionally removes
 * an already line-item-backed discount must succeed, not be refused as
 * "unreconstructable").
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

const testUrl = process.env.SIBLING_RESPLIT_TEST_DATABASE_URL || process.env.DATABASE_URL;
const usable = testUrl && ['localhost', '127.0.0.1'].includes(new URL(testUrl).hostname)
  && (new URL(testUrl).pathname.includes('sibling_resplit') || process.env.CI === 'true');
const postgres = usable ? describe : describe.skip;

postgres('InvoiceService.update — first-application split-source provenance fence', () => {
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

  async function fixture({ stampSplitMarker = false } = {}) {
    const customerId = randomUUID();
    const invoiceId = randomUUID();
    const siblingId = randomUUID();
    await trx('customers').insert({
      id: customerId, first_name: 'Synthetic split-source fixture', phone: `qa-${customerId.slice(0, 8)}`, active: true,
    });
    await trx('invoices').insert({
      id: invoiceId, customer_id: customerId,
      token: randomUUID(), invoice_number: `QA-${randomUUID().slice(0, 20)}`,
      status: 'draft', title: 'First Service Application',
      line_items: JSON.stringify([{ description: 'First service application', quantity: 1, unit_price: 97.20, amount: 97.20 }]),
      subtotal: 97.20, total: 97.20,
    });
    await trx('scheduled_services').insert({
      id: siblingId, customer_id: customerId, scheduled_date: '2026-11-02',
      service_type: 'Lawn Care', status: 'confirmed', estimated_price: 56.40,
      ...(stampSplitMarker
        ? { recurring_template_overrides: JSON.stringify({ first_application_split_invoice_id: invoiceId }) }
        : {}),
    });
    return { customerId, invoiceId, siblingId };
  }

  test('a source invoice this module already split off (marker points at it) refuses a line-item retotal', async () => {
    const { invoiceId } = await fixture({ stampSplitMarker: true });
    // Enforced ONLY at write time (excludeFirstApplicationSplitSource on
    // editQuery, under the invoice row lock) — a matching marker makes the
    // UPDATE match zero rows, so the caller sees the SAME generic
    // "changed while you were editing" error every other write-time
    // predicate miss produces (no separate pre-check query — see the
    // comment above runEdit in invoice.js for why).
    await expect(InvoiceService.update(invoiceId, {
      line_items: [{ description: 'First service application', quantity: 1, unit_price: 153.60, amount: 153.60 }],
    })).rejects.toThrow(/changed while you were editing/i);

    const stored = await trx('invoices').where({ id: invoiceId }).first();
    expect(Number(stored.total)).toBe(97.2);
  });

  test('an ordinary invoice with NO split marker anywhere still edits normally — the fence does not overreach', async () => {
    const { invoiceId } = await fixture({ stampSplitMarker: false });
    const updated = await InvoiceService.update(invoiceId, {
      line_items: [{ description: 'First service application', quantity: 1, unit_price: 120, amount: 120 }],
    });
    expect(Number(updated.total)).toBe(120);
  });

  test('a metadata-only edit (no line_items/tax_rate) on a split-source invoice is still allowed — the fence is scoped to retotals', async () => {
    const { invoiceId } = await fixture({ stampSplitMarker: true });
    const updated = await InvoiceService.update(invoiceId, { title: 'First Service Application (updated)' });
    expect(updated.title).toBe('First Service Application (updated)');
    expect(Number(updated.total)).toBe(97.2);
  });

  test('removing an EXISTING, already line-item-backed discount succeeds — checked against the STORED line items, not the submission', async () => {
    const { invoiceId } = await fixtureWithBackedDiscount();
    // The submission drops the negative "Referral credit" line entirely —
    // a deliberate removal, not evidence the discount was never
    // reconstructable. Codex pre-push P1 (round 2): checking the SUBMITTED
    // array here would see no negative line and wrongly refuse this.
    const updated = await InvoiceService.update(invoiceId, {
      line_items: [{ description: 'First service application', quantity: 1, unit_price: 97.20, amount: 97.20 }],
    });
    expect(Number(updated.discount_amount)).toBe(0);
    expect(Number(updated.total)).toBe(97.2);
  });

  test('a document-level discount with NO backing line item ANYWHERE (never had one) still refuses the retotal', async () => {
    const { invoiceId } = await fixtureWithUnbackedDiscount();
    await expect(InvoiceService.update(invoiceId, {
      line_items: [{ description: 'First service application', quantity: 1, unit_price: 120, amount: 120 }],
    })).rejects.toThrow(/document-level discount with no backing line item/i);
    const stored = await trx('invoices').where({ id: invoiceId }).first();
    expect(Number(stored.total)).toBe(82.20);
  });

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
      // A document-level discountIds pick — discount_amount is positive
      // but NO negative line was ever added to line_items (InvoiceService
      // .create's manualDiscounts never touch line_items — see invoice.js).
      line_items: JSON.stringify([{ description: 'First service application', quantity: 1, unit_price: 91.20, amount: 91.20 }]),
      discount_amount: 9.00, subtotal: 91.20, total: 82.20,
    });
    return { customerId, invoiceId };
  }
});
