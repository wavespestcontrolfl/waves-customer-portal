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
 * Self-skips without DATABASE_URL, same convention the CI "DB-gated
 * suites" step selects on (.github/workflows/tests.yml — `grep -l 'const
 * SKIP = !process.env.DATABASE_URL'`).
 *
 * Every fixture rolls back.
 */
const SKIP = !process.env.DATABASE_URL;
let mockConnection;
jest.mock('../models/db', () => new Proxy((...args) => mockConnection(...args), {
  get(_target, key) {
    const value = mockConnection?.[key];
    return typeof value === 'function' ? value.bind(mockConnection) : value;
  },
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => { req.technicianId = 'admin-1'; req.techRole = 'admin'; next(); },
  requireTechOrAdmin: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
}));

const postgres = SKIP ? describe.skip : describe;

postgres('InvoiceService.update — unbacked document-level discount fence', () => {
  const { randomUUID } = require('node:crypto');
  const express = require('express');
  const InvoiceService = require('../services/invoice');
  let database;
  let trx;

  beforeAll(() => {
    const connection = process.env.DATABASE_URL;
    const url = new URL(connection);
    // Same guard as annual-prepay-invoice-routes-postgres.test.js: this
    // suite runs real INSERT/UPDATE statements — refuse anything that
    // isn't a disposable CI database or this worktree's own private QA copy.
    const localCI = ['localhost', '127.0.0.1'].includes(url.hostname);
    const ownedQA = process.env.WAVES_LOCAL_DEV === '1'
      && url.pathname === `/waves_qa_${String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '')}`;
    if (!localCI && !ownedQA) throw new Error('Use disposable CI or this worktree\'s private QA database');
    database = require('knex')({ client: 'pg', connection, pool: { min: 0, max: 2 } });
  });
  beforeEach(async () => {
    trx = await database.transaction();
    mockConnection = trx;
  });
  afterEach(async () => { await trx.rollback(); mockConnection = database; });
  afterAll(async () => { await database.destroy(); });

  async function insertCustomer(label) {
    const customerId = randomUUID();
    await trx('customers').insert({
      id: customerId, first_name: label, phone: `qa-${customerId.slice(0, 8)}`, active: true,
    });
    return customerId;
  }

  async function fixtureWithBackedDiscount() {
    const customerId = await insertCustomer('Synthetic backed-discount fixture');
    const invoiceId = randomUUID();
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
    const customerId = await insertCustomer('Synthetic unbacked-discount fixture');
    const invoiceId = randomUUID();
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
    const customerId = await insertCustomer('Synthetic mixed-discount fixture');
    const invoiceId = randomUUID();
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

  // The capped-mixed-discount shape (Codex round-1 P1): create()'s combined-
  // discount cap (invoice.js ~3786-3850) scales the invoice_discounts AUDIT
  // rows proportionally when a line-item discount plus a document-level pick
  // exceed the subtotal, but it never rewrites the negative line item's OWN
  // stored amount — that was already mutated to its full PRE-cap value a few
  // lines earlier. So the stored negative line (-$100) can equal the capped
  // discount_amount ($100) even though $10 of that $100 was really an
  // unbacked document-level pick. Persisted invoice_discounts provenance (a
  // discount_id with no matching negative line) is what catches this.
  async function fixtureWithCappedMixedDiscount() {
    const customerId = await insertCustomer('Synthetic capped-mixed-discount fixture');
    const invoiceId = randomUUID();
    const lineDiscountId = randomUUID();
    const docDiscountId = randomUUID();
    await trx('invoices').insert({
      id: invoiceId, customer_id: customerId,
      token: randomUUID(), invoice_number: `QA-${randomUUID().slice(0, 20)}`,
      status: 'draft', title: 'First Service Application',
      line_items: JSON.stringify([
        { description: 'First service application', quantity: 1, unit_price: 100, amount: 100 },
        {
          description: 'Line credit', quantity: 1, unit_price: -100, amount: -100,
          discount_id: lineDiscountId,
        },
      ]),
      // Uncapped this would be $110 (a $100 line credit + a $10 document
      // pick) against a $100 subtotal — create() caps discount_amount at
      // the subtotal itself.
      discount_amount: 100, subtotal: 100, total: 0,
    });
    await trx('invoice_discounts').insert([
      { invoice_id: invoiceId, discount_id: lineDiscountId, discount_dollars: 90.91 },
      { invoice_id: invoiceId, discount_id: docDiscountId, discount_dollars: 9.09 },
    ]);
    return { customerId, invoiceId, lineDiscountId, docDiscountId };
  }

  // Codex round-4 P0: with stacking off, create() lets the SAME catalog
  // discount be picked BOTH as a document-level discountIds entry AND as a
  // separate line-item discount on the same invoice — two invoice_discounts
  // rows sharing one discount_id, only one of them backed by a line. A
  // set-membership match ("does this id appear on any current line?") sees
  // the id once and wrongly waves both rows through; matching by OCCURRENCE
  // COUNT catches the excess.
  async function fixtureWithCappedSameIdMixedDiscount() {
    const customerId = await insertCustomer('Synthetic capped-same-id-mixed-discount fixture');
    const invoiceId = randomUUID();
    const sharedDiscountId = randomUUID();
    await trx('invoices').insert({
      id: invoiceId, customer_id: customerId,
      token: randomUUID(), invoice_number: `QA-${randomUUID().slice(0, 20)}`,
      status: 'draft', title: 'First Service Application',
      line_items: JSON.stringify([
        { description: 'First service application', quantity: 1, unit_price: 100, amount: 100 },
        {
          description: 'Fixed discount', quantity: 1, unit_price: -100, amount: -100,
          discount_id: sharedDiscountId,
        },
      ]),
      // Uncapped this would be $200 (the SAME $100 fixed catalog discount
      // picked once as a line-item discount and once as a document-level
      // discountIds entry) against a $100 subtotal — capped at $100.
      discount_amount: 100, subtotal: 100, total: 0,
    });
    await trx('invoice_discounts').insert([
      { invoice_id: invoiceId, discount_id: sharedDiscountId, discount_dollars: 50 },
      { invoice_id: invoiceId, discount_id: sharedDiscountId, discount_dollars: 50 },
    ]);
    return { customerId, invoiceId, sharedDiscountId };
  }

  test('a capped discount where the SAME catalog id backs a line AND rides as a document-level pick refuses the retotal', async () => {
    const { invoiceId, sharedDiscountId } = await fixtureWithCappedSameIdMixedDiscount();
    await expect(InvoiceService.update(invoiceId, {
      line_items: [
        { description: 'First service application', quantity: 1, unit_price: 300, amount: 300 },
        {
          description: 'Fixed discount', quantity: 1, unit_price: -100, amount: -100,
          discount_id: sharedDiscountId,
        },
      ],
    })).rejects.toThrow(/document-level discount with no backing line item/i);
    const stored = await trx('invoices').where({ id: invoiceId }).first();
    expect(Number(stored.total)).toBe(0);
    expect(Number(stored.discount_amount)).toBe(100);
  });

  // The legitimate counterpart: a SINGLE line-item discount that happens to
  // equal 100% of the subtotal. discount_amount === subtotal here too, but
  // there was never any capping/scaling (uncappedDiscount was never >
  // subtotal) and no document-level pick rode alongside it — the fence must
  // not refuse this just because the cents sum looks like the capped shape.
  async function fixtureWithLegitFullLineDiscount() {
    const customerId = await insertCustomer('Synthetic full-line-discount fixture');
    const invoiceId = randomUUID();
    const promoDiscountId = randomUUID();
    await trx('invoices').insert({
      id: invoiceId, customer_id: customerId,
      token: randomUUID(), invoice_number: `QA-${randomUUID().slice(0, 20)}`,
      status: 'draft', title: 'First Service Application',
      line_items: JSON.stringify([
        { description: 'First service application', quantity: 1, unit_price: 50, amount: 50 },
        {
          description: 'Free service promo', quantity: 1, unit_price: -50, amount: -50,
          discount_id: promoDiscountId,
        },
      ]),
      discount_amount: 50, subtotal: 50, total: 0,
    });
    await trx('invoice_discounts').insert([
      { invoice_id: invoiceId, discount_id: promoDiscountId, discount_dollars: 50 },
    ]);
    return { customerId, invoiceId, promoDiscountId };
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

  test('a capped mixed discount (line credit + document pick exceeding the subtotal) refuses the retotal even though the stored line sum equals discount_amount', async () => {
    // The exact Codex round-1 example: a $100 service with a -$100 line
    // credit and a $10 document discount. Raising the service to $200
    // would otherwise retotal from the line item alone and silently drop
    // the $10 document discount.
    const { invoiceId, lineDiscountId } = await fixtureWithCappedMixedDiscount();
    await expect(InvoiceService.update(invoiceId, {
      line_items: [
        { description: 'First service application', quantity: 1, unit_price: 200, amount: 200 },
        {
          description: 'Line credit', quantity: 1, unit_price: -100, amount: -100,
          discount_id: lineDiscountId,
        },
      ],
    })).rejects.toThrow(/document-level discount with no backing line item/i);
    const stored = await trx('invoices').where({ id: invoiceId }).first();
    expect(Number(stored.total)).toBe(0);
    expect(Number(stored.discount_amount)).toBe(100);
  });

  // Codex round-2 P1: a plain literal negative line item (no discount_id at
  // all — a supported create() shape, e.g. an ad-hoc "Courtesy discount")
  // records its invoice_discounts audit row with discount_id=null
  // (recordInvoiceDiscounts: `d.id || null`). A null id must never be
  // mistaken for document-level provenance just because it has no id to
  // match against a line — only a manual discountIds pick (which always
  // resolves a real catalog row) can produce that shape.
  async function fixtureWithLegitLiteralFullLineDiscount() {
    const customerId = await insertCustomer('Synthetic literal-full-line-discount fixture');
    const invoiceId = randomUUID();
    await trx('invoices').insert({
      id: invoiceId, customer_id: customerId,
      token: randomUUID(), invoice_number: `QA-${randomUUID().slice(0, 20)}`,
      status: 'draft', title: 'First Service Application',
      line_items: JSON.stringify([
        { description: 'First service application', quantity: 1, unit_price: 50, amount: 50 },
        { description: 'Courtesy discount', quantity: 1, unit_price: -50, amount: -50 },
      ]),
      discount_amount: 50, subtotal: 50, total: 0,
    });
    await trx('invoice_discounts').insert([
      { invoice_id: invoiceId, discount_id: null, discount_name: 'Courtesy discount', discount_dollars: 50 },
    ]);
    return { customerId, invoiceId };
  }

  // Codex round-3 P1: a SECOND edit that changes the discount composition
  // away from what create() left must not get stuck refusing every LATER
  // edit forever just because the STALE create-time invoice_discounts rows
  // no longer match the current lines. reconcileInvoiceDiscountProvenance
  // (called after every successful line-item retotal) is what keeps the
  // provenance table in sync so this doesn't happen.
  test('replacing a catalog-backed discount with a literal credit, then editing again, does not get stuck refusing forever', async () => {
    const customerId = await insertCustomer('Synthetic reconcile-on-edit fixture');
    const invoiceId = randomUUID();
    const catalogDiscountId = randomUUID();
    await trx('invoices').insert({
      id: invoiceId, customer_id: customerId,
      token: randomUUID(), invoice_number: `QA-${randomUUID().slice(0, 20)}`,
      status: 'draft', title: 'First Service Application',
      line_items: JSON.stringify([
        { description: 'First service application', quantity: 1, unit_price: 100, amount: 100 },
        {
          description: 'Loyalty discount', quantity: 1, unit_price: -10, amount: -10,
          discount_id: catalogDiscountId,
        },
      ]),
      discount_amount: 10, subtotal: 100, total: 90,
    });
    await trx('invoice_discounts').insert([
      { invoice_id: invoiceId, discount_id: catalogDiscountId, discount_dollars: 10 },
    ]);

    // Edit #1: replace the lines with a $50 service + a $50 LITERAL credit
    // (no discount_id) — discount_amount now equals the new subtotal
    // exactly (the ambiguous shape), but there is no document-level
    // component here at all.
    const afterFirstEdit = await InvoiceService.update(invoiceId, {
      line_items: [
        { description: 'First service application', quantity: 1, unit_price: 50, amount: 50 },
        { description: 'Courtesy discount', quantity: 1, unit_price: -50, amount: -50 },
      ],
    });
    expect(Number(afterFirstEdit.discount_amount)).toBe(50);
    expect(Number(afterFirstEdit.total)).toBe(0);

    // The stale catalog-discount audit row must be gone — reconciled to
    // reflect the invoice's CURRENT (literal-credit) composition.
    const provenance = await trx('invoice_discounts').where({ invoice_id: invoiceId });
    expect(provenance).toHaveLength(1);
    expect(provenance[0].discount_id).toBeNull();

    // Edit #2: a later, unrelated retotal on this now-literal-only invoice
    // must NOT be refused just because the ORIGINAL catalog discount_id is
    // no longer present anywhere.
    const afterSecondEdit = await InvoiceService.update(invoiceId, {
      line_items: [
        { description: 'First service application', quantity: 1, unit_price: 80, amount: 80 },
        { description: 'Courtesy discount', quantity: 1, unit_price: -50, amount: -50 },
      ],
    });
    expect(Number(afterSecondEdit.discount_amount)).toBe(50);
    expect(Number(afterSecondEdit.total)).toBe(30);
  });

  // Codex round-5 P1: reconcileInvoiceDiscountProvenance must record the
  // discount_dollars that actually APPLIED (calculateUpdateFinancials caps
  // discount_amount at subtotal via Math.min, without rescaling the line
  // item's own stored dollars), never the inflated raw per-line amount.
  test('a capped line-only discount (a literal credit larger than the subtotal) reconciles invoice_discounts to the CAPPED amount, not the raw line dollars', async () => {
    const customerId = await insertCustomer('Synthetic capped-line-only fixture');
    const invoiceId = randomUUID();
    await trx('invoices').insert({
      id: invoiceId, customer_id: customerId,
      token: randomUUID(), invoice_number: `QA-${randomUUID().slice(0, 20)}`,
      status: 'draft', title: 'First Service Application',
      line_items: JSON.stringify([{ description: 'First service application', quantity: 1, unit_price: 100, amount: 100 }]),
      subtotal: 100, total: 100,
    });
    // A $50 service with a literal -$100 credit — the credit exceeds the
    // subtotal, so only $50 actually applies (discount can never exceed
    // the subtotal; the total never goes negative).
    const updated = await InvoiceService.update(invoiceId, {
      line_items: [
        { description: 'First service application', quantity: 1, unit_price: 50, amount: 50 },
        { description: 'Oversized credit', quantity: 1, unit_price: -100, amount: -100 },
      ],
    });
    expect(Number(updated.discount_amount)).toBe(50);
    expect(Number(updated.total)).toBe(0);
    const provenance = await trx('invoice_discounts').where({ invoice_id: invoiceId });
    expect(provenance).toHaveLength(1);
    expect(Number(provenance[0].discount_dollars)).toBe(50);
  });

  test('a legit literal (no discount_id) line-item credit that happens to equal 100% of the subtotal still retotals normally', async () => {
    const { invoiceId } = await fixtureWithLegitLiteralFullLineDiscount();
    const updated = await InvoiceService.update(invoiceId, {
      line_items: [
        { description: 'First service application', quantity: 1, unit_price: 80, amount: 80 },
        { description: 'Courtesy discount', quantity: 1, unit_price: -50, amount: -50 },
      ],
    });
    expect(Number(updated.discount_amount)).toBe(50);
    expect(Number(updated.total)).toBe(30);
  });

  test('a legit single line-item discount that happens to equal 100% of the subtotal still retotals normally', async () => {
    const { invoiceId } = await fixtureWithLegitFullLineDiscount();
    // Resubmitted as a plain literal credit (no discount_id/discount_for) —
    // calculateUpdateFinancials's own line-item resolution otherwise
    // requires a discount_id to resolve to a real catalog row + parent
    // line, which is orthogonal to what invoiceHasUnbackedDocumentDiscount
    // is being proven here: that the STORED fixture's fully line-backed
    // discount is not mistaken for the capped/ambiguous shape.
    const updated = await InvoiceService.update(invoiceId, {
      line_items: [
        { description: 'First service application', quantity: 1, unit_price: 80, amount: 80 },
        { description: 'Free service promo', quantity: 1, unit_price: -50, amount: -50 },
      ],
    });
    expect(Number(updated.discount_amount)).toBe(50);
    expect(Number(updated.total)).toBe(30);
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
    const customerId = await insertCustomer('Synthetic ordinary fixture');
    const invoiceId = randomUUID();
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

  // Route-level (Codex round-1 P2): the fence must surface as an operator-
  // actionable 409, not a generic 500, so the operator sees the "void and
  // replace" instruction instead of "Internal server error".
  describe('PUT /admin/invoices/:id', () => {
    async function request(method, path, body) {
      const app = express();
      app.use(express.json());
      app.use('/admin/invoices', require('../routes/admin-invoices'));
      app.use((err, _req, res, _next) => res.status(err.statusCode || err.status || 500).json({ error: err.message }));
      const server = app.listen(0);
      try {
        const res = await fetch(`http://127.0.0.1:${server.address().port}/admin/invoices${path}`, {
          method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
        });
        const json = await res.json().catch(() => null);
        return { status: res.status, body: json };
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    }

    test('returns a 409 with the void-and-replace instruction instead of a 500', async () => {
      const { invoiceId } = await fixtureWithUnbackedDiscount();
      const res = await request('PUT', `/${invoiceId}`, {
        line_items: [{ description: 'First service application', quantity: 1, unit_price: 120, amount: 120 }],
      });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/document-level discount with no backing line item/i);
      expect(res.body.error).toMatch(/void it and create a replacement/i);
    });
  });
});
