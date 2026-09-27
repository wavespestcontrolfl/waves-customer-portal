// Same-trip first-application billing review (redesigned per owner ruling,
// 2026-09-26 — "flag, don't auto-split"): a reserved-accept slot that sold
// MORE than one recurring program mints ONE draft invoice for the combined
// same-day total, linked to the RESERVED row (invoices.scheduled_service_id)
// — its "First service application" line carries every program's first
// visit. Every OTHER program's promoted parent is left with estimated_price
// NULL on purpose: closeout treats it as `sibling_first_application`,
// covered by the reserved row's invoice (see estimate-converter.js
// reservedAcceptPerVisitSplit and estimate-first-application-invoice.js
// findFirstApplicationInvoiceForEstimateService).
//
// That coverage is DATE-KEYED: findFirstApplicationInvoiceForEstimateService
// only matches when the invoice's own linked row shares the LOOKING row's
// scheduled_date. Once one of the two visits is rescheduled off the other's
// day, the date match breaks — the invoice-holding row still auto-charges
// its full (still-combined) amount at its own completion, while the moved
// sibling's completion finds no covering invoice and its NULL
// estimated_price bills nothing.
//
// EARLIER DESIGN (superseded): a prior version of this module auto-split the
// shared invoice at move time — reducing its line, pricing the moved sibling
// with its own quoted share, and stamping provenance. Five straight Codex
// review rounds each found ONE MORE money-correctness gap in that mutation
// (payment plans, discounts, saved-card charge attempts, scheduled-send
// invoices, transient batch-mover snapshots...) — a structural sign that
// touching the invoice's money at reschedule time, outside the normal
// billing/collection surfaces, is the wrong shape for this fix.
//
// OWNER RULING: never touch the invoice on a date-diverging move. Instead,
// in the SAME transaction as the date write, open a durable billing-review
// item on the invoice (idempotent, keyed by invoice id — see
// invoices.billing_review_opened_at) and HOLD automatic collection of that
// invoice while the review is open (server/services/invoice-helpers.js's
// assertInvoiceCollectible — the one gate every charge/send seam already
// calls — refuses while billing_review_opened_at is set). The office
// resolves the review by editing the invoice/prices by hand, then clears it
// (POST /admin/invoices/:id/billing-review/clear), which releases the hold.
// A move that lands the diverging members BACK on the same date, with the
// invoice never touched since the review opened, clears itself.
const logger = require('./logger');

function dateOnly(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).split('T')[0].slice(0, 10);
}

// ---------------------------------------------------------------------------
// Lookup: which invoice (if any) is this row's estimate-accept group sharing,
// and has anything diverged? No money is read or written here.
// ---------------------------------------------------------------------------

// Locates the estimate-accept group's locked member rows for a moved row, or
// a terminal skip when this row cannot be part of one.
async function loadLockedEstimateGroup(trx, scheduledServiceId) {
  const moved = await trx('scheduled_services')
    .where({ id: scheduledServiceId })
    .first('id', 'customer_id', 'source_estimate_id', 'recurring_parent_id');
  // Only a top-of-series (or one-time) row can be a first-application
  // invoice's reserved or promoted member — a later CHILD occurrence's date
  // is unrelated to the accept-time split.
  if (!moved || !moved.customer_id || !moved.source_estimate_id || moved.recurring_parent_id) {
    return { skip: { action: 'skipped', reason: 'not_estimate_anchor' } };
  }
  // Lock every member of this estimate's accept group up front — the read
  // below must not race a concurrent completion or a second reschedule of a
  // sibling landing between this read and the flag write.
  const members = await trx('scheduled_services')
    .where({ customer_id: moved.customer_id, source_estimate_id: moved.source_estimate_id })
    .whereNull('recurring_parent_id')
    .forUpdate()
    .select('id', 'scheduled_date', 'estimated_price', 'completed_at');
  if (members.length < 2) return { skip: { action: 'skipped', reason: 'no_siblings', moved } };
  return { moved, members };
}

// Locates the locked first-application invoice linked to any member of this
// group, or a terminal skip. A void invoice is a dead artifact (its charge
// was never collected and a replacement, if any, is a separate row) and is
// excluded; every other status is considered — this module never mutates
// the invoice, so there is no "safe to retotal" judgment to make here, only
// "does a shared invoice exist and does anything diverge from its date".
async function findLockedFirstApplicationInvoice(trx, moved, members) {
  const { isAutoGeneratedPayPerApplicationInvoice } = require('./estimate-first-application-invoice');
  const memberIds = members.map((m) => m.id);
  const candidates = await trx('invoices')
    .whereIn('scheduled_service_id', memberIds)
    .whereNot('status', 'void')
    .orderBy('created_at', 'desc')
    .forUpdate()
    .select('*');
  const invoice = candidates.find((inv) => isAutoGeneratedPayPerApplicationInvoice(inv));
  if (!invoice) return { skip: { action: 'skipped', reason: 'no_first_application_invoice', moved } };

  const invoiceRow = members.find((m) => String(m.id) === String(invoice.scheduled_service_id));
  if (!invoiceRow) return { skip: { action: 'skipped', reason: 'invoice_row_missing', moved, invoice } };
  return { invoice, invoiceRow };
}

// A stable fingerprint of exactly the columns the collection hold actually
// protects — never `updated_at`, which is only a proxy other invoice-
// mutating code paths are conventionally supposed to bump and nothing
// enforces (Claude fallback-auditor P1, this branch's own first push): a
// write that changed real money but forgot to touch updated_at would let
// maybeAutoClearBillingReview treat a genuinely-edited, still-uncovered
// invoice as "untouched" and silently release the hold. Comparing the
// money fields themselves has no such gap — anything that actually changed
// what the customer owes shows up here directly.
function invoiceMoneyFingerprint(invoice) {
  return JSON.stringify({
    total: invoice?.total ?? null,
    subtotal: invoice?.subtotal ?? null,
    discount_amount: invoice?.discount_amount ?? null,
    status: invoice?.status ?? null,
    lineItems: parseLineItems(invoice?.line_items) || invoice?.line_items || null,
  });
}

function parseLineItems(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Members that have diverged from the invoice-holding row's date and are
// still relying on it (never priced their own share, never completed — a
// completed row's billing outcome is already a settled fact this move
// cannot change). Pure filter, no DB reads.
function divergingUnpricedSiblings(invoiceRow, members) {
  const invoiceDate = dateOnly(invoiceRow.scheduled_date);
  return members.filter((m) => String(m.id) !== String(invoiceRow.id)
    && !m.completed_at
    && m.estimated_price == null
    && dateOnly(m.scheduled_date) !== invoiceDate);
}

// ---------------------------------------------------------------------------
// Durable review: open, idempotent, keyed by invoice id (invoices.
// billing_review_opened_at/_reason/_context). Never touches invoice money.
// ---------------------------------------------------------------------------

// Reuses the existing admin billing-review bell (notification-service's
// notifyAdmin, category 'billing' — the same mechanism complete-scheduled-
// service.js's manual-billing alerts use) so the office sees it, in ADDITION
// to the durable invoice-row flag the collection gate reads. Runs in its own
// savepoint off the caller's trx — a notification failure must never poison
// a transaction that otherwise just committed the date write cleanly.
async function raiseBillingReviewAlert(trx, invoice, moved, diverging) {
  try {
    const divergingDetail = diverging.length
      ? ` Sibling visit(s) diverged and are unpriced: ${diverging.map((d) => d.id).join(', ')}.`
      : '';
    await trx.transaction((logTrx) => require('./notification-service').notifyAdmin(
      'billing',
      'First-application invoice needs manual review — a same-trip visit moved days',
      `Estimate #${moved.source_estimate_id}: a visit shared a first-application invoice (${invoice.invoice_number || invoice.id}) with a sibling that just moved to a different day.${divergingDetail} The invoice-holding visit still bills the FULL combined amount at its own completion, and the diverging sibling's price is unset and now uncovered — it will complete WITHOUT billing unless the office prices it by hand. Automatic collection on this invoice (auto-charge, saved-card charge, scheduled send, autopay/dunning) is on hold until the office resolves this by hand and clears the review (Admin → Invoices → this invoice).`,
      {
        link: `/admin/invoices?invoice=${invoice.id}`,
        bell: true,
        metadata: {
          estimateId: moved.source_estimate_id,
          invoiceId: invoice.id,
          movedScheduledServiceId: moved.id,
          divergingSiblingIds: diverging.map((d) => d.id),
        },
        dedupeKey: `first_application_billing_review:${invoice.id}`,
        refreshOnDedupe: true,
        trx: logTrx,
      },
    ));
  } catch (e) {
    logger.warn(`[first-application-sibling-split] billing-review alert failed for estimate ${moved.source_estimate_id}, invoice ${invoice.id} (non-blocking): ${e.message}`);
  }
}

// First-write-wins (COALESCE-style, via whereNull on the write predicate) —
// a review already open keeps its ORIGINAL opened_at and invoice snapshot;
// only the admin bell's content refreshes with the latest diverging set.
async function openBillingReview(trx, invoice, moved, diverging) {
  const context = {
    sourceEstimateId: moved.source_estimate_id,
    invoiceHolderScheduledServiceId: invoice.scheduled_service_id,
    divergingSiblingIds: diverging.map((d) => d.id),
    // The invoice's own money fields AT THE MOMENT this review opens (see
    // invoiceMoneyFingerprint) — compared, not `updated_at`, to prove "the
    // invoice was never touched" at auto-clear time. That equality is the
    // trivial case a move back to the same date clears automatically.
    invoiceMoneyFingerprintAtOpen: invoiceMoneyFingerprint(invoice),
  };
  const [opened] = await trx('invoices')
    .where({ id: invoice.id })
    .whereNull('billing_review_opened_at')
    .update({
      billing_review_opened_at: new Date(),
      billing_review_reason: 'sibling_date_diverged',
      billing_review_context: JSON.stringify(context),
    })
    .returning('id');
  await raiseBillingReviewAlert(trx, invoice, moved, diverging);
  return { action: 'review_opened', invoiceId: invoice.id, opened: !!opened };
}

// The trivial auto-clear (owner ruling): the diverging members are back on
// the invoice-holding row's date AND the invoice's own money (total,
// subtotal, discount_amount, status, line items) has not changed since the
// review opened. Anything else — dates realigned but the invoice WAS
// edited, or dates still diverging — requires the office's own manual
// clear.
async function maybeAutoClearBillingReview(trx, invoice, moved) {
  if (!invoice.billing_review_opened_at) {
    return { action: 'skipped', reason: 'no_diverging_unpriced_sibling', invoiceId: invoice.id };
  }
  let context = invoice.billing_review_context;
  if (typeof context === 'string') {
    try { context = JSON.parse(context); } catch { context = null; }
  }
  const snapshot = context?.invoiceMoneyFingerprintAtOpen;
  const untouched = typeof snapshot === 'string' && snapshot === invoiceMoneyFingerprint(invoice);
  if (!untouched) {
    return { action: 'skipped', reason: 'review_open_requires_manual_clear', invoiceId: invoice.id };
  }
  const [cleared] = await trx('invoices')
    .where({ id: invoice.id })
    .whereNotNull('billing_review_opened_at')
    .update({ billing_review_opened_at: null, billing_review_reason: null, billing_review_context: null })
    .returning('id');
  if (cleared) {
    logger.info(`[first-application-sibling-split] estimate ${moved.source_estimate_id}: invoice ${invoice.id}'s billing review auto-cleared — the diverging visit(s) landed back on the invoice's date and the invoice was never touched`);
  }
  return { action: cleared ? 'review_auto_cleared' : 'skipped', invoiceId: invoice.id };
}

/**
 * Called after ANY write that changes scheduled_date on a top-of-series (or
 * one-time) scheduled_services row, inside the SAME transaction as that
 * write. Idempotent and side-effect-free unless it actually finds a shared
 * first-application invoice for this row's estimate-accept group — safe to
 * call unconditionally whenever a date-changing writer wants the guarantee,
 * and cheap to skip (an early return) for rows that never touched an
 * estimate accept. Never mutates invoice money or scheduled_services rows
 * other than the review columns on `invoices` themselves.
 *
 * Because this runs in the SAME transaction as the date write, a crash,
 * deadlock, or interrupted batch that rolls back the move also rolls back
 * the review flag with it — there is no window where a review can persist
 * for a move that never actually committed.
 *
 * @param {import('knex').Knex.Transaction} trx - the caller's OPEN transaction
 * @param {string} scheduledServiceId - the row whose date just changed (post-write id)
 */
async function flagFirstApplicationInvoiceReviewOnDateChange(trx, scheduledServiceId) {
  if (!trx || !scheduledServiceId) return { action: 'skipped', reason: 'missing_args' };

  const group = await loadLockedEstimateGroup(trx, scheduledServiceId);
  if (group.skip) return group.skip;
  const { moved, members } = group;

  const located = await findLockedFirstApplicationInvoice(trx, moved, members);
  if (located.skip) return located.skip;
  const { invoice, invoiceRow } = located;

  const diverging = divergingUnpricedSiblings(invoiceRow, members);
  if (diverging.length) {
    return openBillingReview(trx, invoice, moved, diverging);
  }
  return maybeAutoClearBillingReview(trx, invoice, moved);
}

/**
 * Same as flagFirstApplicationInvoiceReviewOnDateChange, but never blocks
 * the caller's own write: runs in its own SAVEPOINT (a nested transaction
 * off the caller's trx), so a failure inside it rolls back only its own
 * statements and leaves the caller's transaction perfectly usable for
 * whatever it does next. A plain try/catch around the direct call does NOT
 * achieve this on Postgres: the first failing statement aborts the WHOLE
 * transaction it ran in, and every later statement on that connection —
 * including the caller's own COMMIT — fails until something rolls it back.
 * Every date-changing writer enumerated in the PR (rebooker, admin-schedule
 * bulk + update-details, the Intelligence Bar's moveStopsToDay +
 * rescheduleAppointment, visit-groups' moveVisitAsUnit via rebooker) should
 * call this, not the plain function, directly.
 */
async function flagFirstApplicationInvoiceReviewOnDateChangeSafely(trx, scheduledServiceId, context = '') {
  try {
    return await trx.transaction((nested) => flagFirstApplicationInvoiceReviewOnDateChange(nested, scheduledServiceId));
  } catch (err) {
    logger.error(`[first-application-sibling-split] review flag failed for ${scheduledServiceId}${context ? ` (${context})` : ''} — caller's own write still commits: ${err.message}`);
    return { action: 'error', reason: err.message };
  }
}

module.exports = {
  flagFirstApplicationInvoiceReviewOnDateChange,
  flagFirstApplicationInvoiceReviewOnDateChangeSafely,
  dateOnly,
  // Exported for direct unit coverage of the lookup/classification pieces.
  loadLockedEstimateGroup,
  findLockedFirstApplicationInvoice,
  divergingUnpricedSiblings,
};
