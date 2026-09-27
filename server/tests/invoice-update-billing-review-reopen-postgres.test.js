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
    loadLockedEstimateGroup,
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

  // Round-4 Codex P1 #2 (second pre-push round): the group's invoice is
  // identified by pattern-matching its auto-generated title/notes text
  // (isAutoGeneratedPayPerApplicationInvoice) — replacing that wording
  // through the SAME editable PUT route (e.g. the office tidying up the
  // notes while splitting the invoice by hand) would otherwise permanently
  // hide this invoice from findLockedFirstApplicationInvoice, silently
  // skipping the reopen check forever after. The fallback trusts THIS
  // invoice's own resolution record (proof it was reviewed once) instead.
  test("clear, then an edit that BOTH rewrites the auto-generated notes AND adds money back still reopens the review", async () => {
    const ids = await makeFixture();
    try {
      await divergeOpenAndClear(ids);

      // A single PUT that both destroys the text-match AND recombines the
      // money — exactly the auditor's scenario.
      await InvoiceService.update(ids.invoiceId, {
        notes: "Split by hand 2026-11-01 — see office notes for the lawn share",
        line_items: [
          { description: "First service application", quantity: 1, unit_price: 97.2, amount: 97.2 },
          { description: "Lawn care — sibling", quantity: 1, unit_price: 56.4, amount: 56.4 },
        ],
      });

      const after = await db("invoices").where({ id: ids.invoiceId }).first();
      expect(after.notes).toMatch(/split by hand/i);
      expect(after.billing_review_opened_at).toBeTruthy();
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

  // Round-4 Codex P1 #2: a money edit while the review is ALREADY open
  // deliberately does nothing to opened_at/reason/context (it's already
  // held/alerted — reopenBillingReviewOnInvoiceMoneyChange's own
  // 'review_already_open' skip) — but without folding the money into
  // billingReviewVersion, an operator who loaded the page BEFORE that edit
  // would still hold a version that matches the unchanged metadata, and
  // could Clear against amounts they never saw.
  test("a money edit WHILE the review is open changes billingReviewVersion — a stale (pre-edit) version is refused; the fresh one clears", async () => {
    const ids = await makeFixture();
    try {
      await db("scheduled_services").where({ id: ids.lawnId }).update({ scheduled_date: "2026-11-02" });
      await db.transaction((trx) => flagFirstApplicationInvoiceReviewOnDateChange(trx, ids.lawnId));
      const opened = await db("invoices").where({ id: ids.invoiceId }).first();
      expect(opened.billing_review_opened_at).toBeTruthy();
      const staleVersion = billingReviewVersion(opened);

      // An edit changes the invoice's ACTUAL money while the review is
      // STILL open — no date write involved (e.g. the sibling's charge
      // getting added back).
      await InvoiceService.update(ids.invoiceId, {
        line_items: [
          { description: "First service application", quantity: 1, unit_price: 97.2, amount: 97.2 },
          { description: "Lawn care — sibling", quantity: 1, unit_price: 56.4, amount: 56.4 },
        ],
      });

      const afterEdit = await db("invoices").where({ id: ids.invoiceId }).first();
      expect(afterEdit.billing_review_opened_at).toBeTruthy(); // still open — untouched by design
      const freshVersion = billingReviewVersion(afterEdit);
      expect(freshVersion).not.toBe(staleVersion);

      const staleClear = await clearBillingReview(ids.invoiceId, staleVersion, db);
      expect(staleClear.code).toBe("stale");
      expect((await db("invoices").where({ id: ids.invoiceId }).first()).billing_review_opened_at).toBeTruthy();

      const freshClear = await clearBillingReview(ids.invoiceId, freshVersion, db);
      expect(freshClear.code).toBe("cleared");
    } finally {
      await cleanup(ids);
    }
  });

  // Round-4 Codex P1 #1, then hardened by the ROOT FIX (structural lock
  // order, first-application-sibling-split.js's lockSiblingGroupForVisit):
  // InvoiceService.update() locks the INVOICE first (its own editability
  // guard), while every date-changing writer locks scheduled_services
  // FIRST, then the invoice — a lock-order inversion that could deadlock a
  // concurrent reschedule against a concurrent invoice edit on the same
  // estimate group (confirmed against real Postgres: even an UPDATE that
  // never touches scheduled_service_id can need an implicit lock on the
  // linked scheduled_services row, via the invoices→scheduled_services
  // foreign key's own referential-integrity check, once the invoice row
  // has already been written once in the same transaction). The ROOT fix:
  // runEdit takes lockSiblingGroupForVisit — ONE estimate-scoped advisory
  // lock, namespaced separately from every row lock — UNCONDITIONALLY, at
  // the very top of its transaction, before EVERYTHING else, including the
  // row-level scheduled_services-group lock (loadLockedEstimateGroup,
  // still taken afterward for a retotal edit, for the narrower FK-implicit-
  // lock reason above) and its own invoice lock. Every date-changing writer
  // takes the SAME advisory lock first too, so whichever side gets there
  // first fully finishes before the other takes ANY row lock at all — no
  // cross-transaction cycle is possible. Proven here with two REAL,
  // concurrently open connections and the ACTUAL InvoiceService.update(),
  // not just the module helper: connection 1 takes the group lock first
  // (mimicking a reschedule in-flight — loadLockedEstimateGroup now also
  // takes the SAME advisory lock, re-entrantly); the real update() call —
  // reaching the very same advisory lock at the top of runEdit — WAITS for
  // it (ordinary contention, not a deadlock) and completes cleanly the
  // moment connection 1 releases.
  test("two connections: a concurrent reschedule's group lock never deadlocks a real InvoiceService.update() money edit", async () => {
    const ids = await makeFixture();
    let trx1;
    try {
      await db("scheduled_services").where({ id: ids.lawnId }).update({ scheduled_date: "2026-11-02" });

      // Connection 1: holds the SAME scheduled_services FOR UPDATE lock a
      // real date-change writer would hold at this point, left OPEN
      // (uncommitted) for a moment.
      trx1 = await db.transaction();
      const group = await loadLockedEstimateGroup(trx1, ids.lawnId);
      expect(group.skip).toBeUndefined();

      // Connection 2: the REAL InvoiceService.update() money edit, on its
      // own transaction/connection. It reaches the SAME lock at the top of
      // runEdit and must wait for connection 1 — kicked off but not
      // awaited yet, so both are genuinely in flight together.
      const updatePromise = InvoiceService.update(ids.invoiceId, {
        line_items: [
          { description: "First service application", quantity: 1, unit_price: 97.2, amount: 97.2 },
          { description: "Lawn care — sibling", quantity: 1, unit_price: 56.4, amount: 56.4 },
        ],
      });

      // Give the update a moment to actually be waiting on connection 1,
      // then release it — if this were a real deadlock, releasing one
      // side is exactly what would be IMPOSSIBLE (each side would already
      // be blocked on the other). Here it's ordinary, resolvable
      // contention: connection 1 lets go, and the update proceeds.
      await new Promise((resolve) => { setTimeout(resolve, 500); });
      await trx1.rollback();
      trx1 = null;

      await updatePromise;

      const after = await db("invoices").where({ id: ids.invoiceId }).first();
      expect(after.billing_review_opened_at).toBeTruthy();
      expect(after.billing_review_reason).toBe("sibling_date_diverged");
    } finally {
      if (trx1) await trx1.rollback().catch(() => {});
      await cleanup(ids);
    }
  });
});
