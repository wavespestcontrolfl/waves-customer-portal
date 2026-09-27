/**
 * InvoiceService.update()'s own billing-review chokepoint (round-4, Codex
 * #5021 P1): a manually-cleared (or auto-cleared) same-trip first-
 * application invoice only ever got re-checked by a LATER DATE CHANGE on
 * some member of its estimate-accept group — flagFirstApplicationInvoice-
 * ReviewOnDateChange / isDivergenceAlreadyResolved are only ever called from
 * that chokepoint. InvoiceService.update() could change the invoice's OWN
 * protected money fields afterward (e.g. an edited line item quietly
 * re-adding the sibling's charge) with the siblings STILL on different
 * days, and nothing ever re-validated it: no date write happens on a plain
 * money edit, so the date-change chokepoint never runs.
 *
 * update() now calls first-application-sibling-split.js's
 * reopenBillingReviewOnInvoiceMoneyChange in the SAME transaction as its
 * own edit — this suite proves the ACTUAL wiring end to end through the
 * real InvoiceService.update(), not just the module-level helper (that
 * helper's own unit coverage lives in
 * first-application-sibling-split.postgres.test.js).
 *
 * Real end-to-end coverage — DB-backed, self-skips without DATABASE_URL,
 * same convention as invoice-review-hold-serializer-postgres.test.js. Every
 * fixture is inserted and torn down per test (InvoiceService.update() opens
 * its own top-level transaction against the global db pool, so this suite
 * cannot use the rollback-transaction pattern the sibling-split module
 * suite uses).
 */
const SKIP = !process.env.DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;

describeOrSkip("InvoiceService.update() reopens a resolved billing review when money changes (round-4 #5021 P1)", () => {
  jest.setTimeout(30000);
  const { randomUUID } = require("crypto");
  const db = require("../models/db");
  const InvoiceService = require("../services/invoice");
  const {
    flagFirstApplicationInvoiceReviewOnDateChange,
    clearBillingReview,
  } = require("../services/first-application-sibling-split");
  const { assertInvoiceCollectible, billingReviewVersion } = require("../services/invoice-helpers");

  afterAll(async () => {
    await db.destroy();
  });

  const SAME_DATE = "2026-11-01";

  async function makeFixture() {
    const customerId = randomUUID();
    const estimateId = randomUUID();
    const pestId = randomUUID();
    const lawnId = randomUUID();
    const invoiceId = randomUUID();
    await db("customers").insert({
      id: customerId, first_name: "IU billing-review reopen fixture", phone: `qa-${customerId.slice(0, 8)}`, active: true,
    });
    await db("estimates").insert({ id: estimateId, customer_id: customerId, status: "accepted" });
    await db("scheduled_services").insert({
      id: pestId, customer_id: customerId, source_estimate_id: estimateId, scheduled_date: SAME_DATE,
      service_type: "Quarterly Pest Control", status: "confirmed", is_recurring: true, estimated_price: 153.6,
    });
    await db("scheduled_services").insert({
      id: lawnId, customer_id: customerId, source_estimate_id: estimateId, scheduled_date: SAME_DATE,
      service_type: "Lawn Care", status: "confirmed", is_recurring: true, estimated_price: null,
    });
    await db("invoices").insert({
      id: invoiceId, customer_id: customerId, scheduled_service_id: pestId,
      token: randomUUID(), invoice_number: `QA-${randomUUID().slice(0, 20)}`,
      status: "draft", title: "First Service Application",
      notes: `Auto-generated from accepted estimate #${estimateId}. Customer selected pay per application — first application only.`,
      line_items: JSON.stringify([{ description: "First service application", quantity: 1, unit_price: 97.2, amount: 97.2 }]),
      subtotal: 97.2, total: 97.2, tax_rate: 0, tax_amount: 0,
    });
    return { customerId, estimateId, pestId, lawnId, invoiceId };
  }

  async function cleanup(ids) {
    await db("invoices").where({ id: ids.invoiceId }).del();
    await db("scheduled_services").whereIn("id", [ids.pestId, ids.lawnId]).del();
    await db("estimates").where({ id: ids.estimateId }).del();
    await db("customers").where({ id: ids.customerId }).del();
  }

  // Diverges the lawn sibling, opens the durable review through the real
  // date-change chokepoint, then manually clears it — exactly the office
  // workflow (split by hand, then Clear) the round-4 finding is about.
  async function divergeOpenAndClear(ids) {
    await db("scheduled_services").where({ id: ids.lawnId }).update({ scheduled_date: "2026-11-02" });
    await db.transaction((trx) => flagFirstApplicationInvoiceReviewOnDateChange(trx, ids.lawnId));
    const opened = await db("invoices").where({ id: ids.invoiceId }).first();
    expect(opened.billing_review_opened_at).toBeTruthy();
    const version = billingReviewVersion(opened);
    const cleared = await clearBillingReview(ids.invoiceId, version, db);
    expect(cleared.code).toBe("cleared");
    expect((await db("invoices").where({ id: ids.invoiceId }).first()).billing_review_opened_at).toBeNull();
  }

  test("clear, then an edit that ADDS money back reopens the review and the hold applies", async () => {
    const ids = await makeFixture();
    try {
      await divergeOpenAndClear(ids);

      // The sibling's charge comes back onto the invoice — the exact
      // recombination this fix protects against. The siblings are STILL
      // on different days (no date write happens here at all).
      await InvoiceService.update(ids.invoiceId, {
        line_items: [
          { description: "First service application", quantity: 1, unit_price: 97.2, amount: 97.2 },
          { description: "Lawn care — sibling", quantity: 1, unit_price: 56.4, amount: 56.4 },
        ],
      });

      const after = await db("invoices").where({ id: ids.invoiceId }).first();
      expect(after.billing_review_opened_at).toBeTruthy();
      expect(after.billing_review_reason).toBe("sibling_date_diverged");
      expect(() => assertInvoiceCollectible(after)).toThrow(/billing review/i);
    } finally {
      await cleanup(ids);
    }
  });

  test("clear, then an edit that changes NOTHING about money does not reopen", async () => {
    const ids = await makeFixture();
    try {
      await divergeOpenAndClear(ids);

      // Metadata-only edit — title, no line_items/tax_rate at all.
      await InvoiceService.update(ids.invoiceId, { title: "First Service Application (renamed)" });

      const after = await db("invoices").where({ id: ids.invoiceId }).first();
      expect(after.billing_review_opened_at).toBeNull();
      expect(after.title).toBe("First Service Application (renamed)");
    } finally {
      await cleanup(ids);
    }
  });

  test("clear, then a line-item resend with byte-identical amounts does not reopen", async () => {
    const ids = await makeFixture();
    try {
      await divergeOpenAndClear(ids);

      // Same line items, same dollars — a retotal branch runs (line_items
      // is present) but the invoice's protected money fields end up
      // unchanged, so the money-only fingerprint compare must skip.
      await InvoiceService.update(ids.invoiceId, {
        line_items: [{ description: "First service application", quantity: 1, unit_price: 97.2, amount: 97.2 }],
      });

      const after = await db("invoices").where({ id: ids.invoiceId }).first();
      expect(after.billing_review_opened_at).toBeNull();
    } finally {
      await cleanup(ids);
    }
  });
});
