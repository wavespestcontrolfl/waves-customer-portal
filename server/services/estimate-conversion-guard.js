/**
 * Estimate conversion guard.
 *
 * A customer can convert WITHOUT their estimate ever flipping to `accepted`:
 * the tech invoices at completion, an admin books the job directly, payment
 * is collected on-site. Only the public accept endpoint and the manual
 * acceptance service write `status='accepted'` — booking, invoicing, payment
 * and completion never touch the estimate row. The estimate then sits at
 * sent/viewed and the follow-up cron keeps nudging a customer we already
 * serviced and charged (prod: two customers got the full three-stage nag
 * ladder days after paying their invoice).
 *
 * Deliberately NOT solved by auto-flipping the estimate to `accepted`:
 * acceptance has money side-effects (prepay coverage, deposits, invoice
 * minting) and must never fire implicitly. Two mechanisms instead:
 *
 *  1. customerConvertedSince(est) — per-send suppression consumed by the
 *     follow-up safetyGate. Broad by design (any paid invoice or any live
 *     appointment created after the estimate, or an active pipeline stage):
 *     the cost of a suppressed upsell nudge is one missed automated poke;
 *     the cost of a missed suppression is nagging a paying customer.
 *  2. archiveConvertedOpenEstimates() — daily sweep that stamps archived_at
 *     on open estimates whose customer's FIRST-ever paid invoice or FIRST
 *     completed service happened after the estimate was created (i.e. the
 *     courtship this estimate belonged to already closed some other way).
 *     Narrower than (1) so a live upsell estimate sent to a long-standing
 *     customer is never archived out from under Virginia.
 */

const db = require("../models/db");
const logger = require("./logger");
const { CUSTOMER_STAGES } = require("./customer-stages");

/**
 * Has this estimate's customer converted since the estimate was created?
 *
 * Fail-CLOSED on lookup errors (same rule as the deposit-abandonment stage:
 * an unprompted SMS is never sent on unverified eligibility) — a transient
 * DB error skips this tick's send without burning the stage flag, and the
 * next cron tick re-evaluates.
 *
 * @returns {Promise<{converted: boolean, reason?: string}>}
 */
async function customerConvertedSince(est) {
  if (!est || !est.customer_id) return { converted: false };
  const createdAt = new Date(est.created_at || 0);
  try {
    // status='paid' with a null paid_at is a valid collected invoice (the
    // dashboard counts it); its pay time is unknown, so it fails toward
    // suppression rather than toward nagging.
    const paid = await db("invoices")
      .where({ customer_id: est.customer_id, status: "paid" })
      .where((q) => q.whereNull("paid_at").orWhere("paid_at", ">=", createdAt))
      .first("id");
    if (paid) return { converted: true, reason: "paid-invoice" };

    const booked = await db("scheduled_services")
      .where({ customer_id: est.customer_id })
      .whereNot("status", "cancelled")
      .where("created_at", ">=", createdAt)
      .first("id");
    if (booked) return { converted: true, reason: "appointment-booked" };

    const customer = await db("customers")
      .where({ id: est.customer_id })
      .first("pipeline_stage");
    if (customer && CUSTOMER_STAGES.includes(customer.pipeline_stage))
      return { converted: true, reason: `customer-stage:${customer.pipeline_stage}` };

    return { converted: false };
  } catch (e) {
    logger.error(
      `[est-conversion-guard] converted check failed for estimate ${est.id}: ${e.message}`,
    );
    return { converted: true, reason: "guard-error" };
  }
}

/**
 * Daily sweep: archive open (sent/viewed, un-archived) estimates whose
 * customer's first-ever conversion signal — first paid invoice or first
 * completed service — landed AFTER the estimate was created. "First-ever"
 * is the load-bearing part: an estimate sent to an already-converted
 * customer (tech upsell, add-on quote) has a conversion signal BEFORE its
 * created_at and is left alone.
 *
 * Archiving is status-neutral: the row keeps sent/viewed (no accept
 * side-effects), it just stops appearing in open lists and the follow-up
 * stage queries exclude archived rows.
 */
async function archiveConvertedOpenEstimates() {
  const now = new Date();
  // "First-ever" is judged ACROSS both signal sources: at least one signal
  // (paid invoice or completed service) exists, and NO signal of EITHER kind
  // predates the estimate. Judging each source independently would let a
  // customer with a pre-estimate completed service but no prior invoice
  // match the invoice branch on a later payment and lose a live upsell
  // estimate.
  const archivedRows = await db("estimates")
    .whereIn("status", ["sent", "viewed"])
    .whereNull("archived_at")
    .whereNotNull("customer_id")
    .where((q) =>
      q
        .whereExists(function () {
          this.select(db.raw("1"))
            .from("invoices")
            .whereRaw("invoices.customer_id = estimates.customer_id")
            .where("invoices.status", "paid");
        })
        .orWhereExists(function () {
          this.select(db.raw("1"))
            .from("scheduled_services")
            .whereRaw("scheduled_services.customer_id = estimates.customer_id")
            .where("scheduled_services.status", "completed")
            .whereNotNull("scheduled_services.completed_at");
        }),
    )
    .whereNotExists(function () {
      // A paid invoice with null paid_at reads as paid at its creation time
      // (the lower bound). An ambiguous invoice minted before the estimate
      // therefore counts as PREDATING it, and the estimate is left alone —
      // the sweep fails toward keeping a possibly-live upsell estimate.
      this.select(db.raw("1"))
        .from("invoices")
        .whereRaw("invoices.customer_id = estimates.customer_id")
        .where("invoices.status", "paid")
        .whereRaw(
          "COALESCE(invoices.paid_at, invoices.created_at) < estimates.created_at",
        );
    })
    .whereNotExists(function () {
      this.select(db.raw("1"))
        .from("scheduled_services")
        .whereRaw("scheduled_services.customer_id = estimates.customer_id")
        .where("scheduled_services.status", "completed")
        .whereNotNull("scheduled_services.completed_at")
        .whereRaw("scheduled_services.completed_at < estimates.created_at");
    })
    .update({ archived_at: now, updated_at: now })
    .returning(["id", "customer_name", "status"]);

  const archived = Array.isArray(archivedRows) ? archivedRows : [];
  if (archived.length > 0) {
    logger.info(
      `[est-conversion-guard] Archived ${archived.length} converted-customer estimate(s): ${archived
        .map((r) => r.id)
        .join(", ")}`,
    );
  } else {
    logger.info("[est-conversion-guard] Archive sweep: nothing to archive");
  }
  return { archived: archived.length, rows: archived };
}

module.exports = { customerConvertedSince, archiveConvertedOpenEstimates };
