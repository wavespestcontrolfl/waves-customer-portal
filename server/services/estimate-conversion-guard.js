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
 *     courtship this estimate belonged to already closed some other way),
 *     with NO conversion evidence of any kind — invoice, visit, service
 *     record, or an established-customer row — predating the estimate
 *     (whereNoConversionBeforeEstimate). Narrower than (1) so a live upsell
 *     estimate sent to a long-standing customer is never archived out from
 *     under Virginia.
 */

const db = require("../models/db");
const logger = require("./logger");
const { CUSTOMER_STAGES } = require("./customer-stages");

// Appointment rows that leave NO live booking behind — the repo's terminal
// convention (waveguard-existing-services TERMINAL_STATUSES) minus
// 'completed', which IS a conversion signal here. 'rescheduled' is the
// phantom row the reschedule flow leaves in place until SmartRebooker
// handles it; 'skipped'/'no_show' are terminal misses. None of them proves
// the customer converted, so none may suppress follow-ups or hold an
// estimate out of expiration.
const NON_LIVE_APPOINTMENT_STATUSES = ["cancelled", "rescheduled", "skipped", "no_show"];

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
      .whereNotIn("status", NON_LIVE_APPOINTMENT_STATUSES)
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
 * None-before disqualifiers shared by the archive sweep and the expiration
 * hold (knex `.modify` helper; the two callers must stay in lockstep, and
 * sharing one helper is what keeps them there). Any conversion evidence
 * PREDATING the estimate proves the customer was already converted when the
 * quote went out — the estimate is a live upsell and must be left alone.
 *
 * Five evidence sources, broader than the sweep's eligibility signals on
 * purpose (both asymmetries fail toward KEEPING an estimate):
 *  - paid invoices, judged by the EARLIER of minted and paid time: an
 *    invoice OPENED before the estimate is prior evidence even when it's
 *    only paid afterward (an existing customer settling an older bill
 *    post-quote must not make their live upsell look freshly converted),
 *    and null paid_at reads as paid at creation time — the lower bound —
 *    so an ambiguous invoice counts as predating;
 *  - bookings CREATED before the estimate (live or since completed) — the
 *    customer had already converted when the quote went out, even if the
 *    completion/payment evidence only lands afterward;
 *  - completed scheduled_services (legacy rows predate migration
 *    20260422000009 and carry NULL completed_at; fall back to the visit's
 *    scheduled_date, NOT NULL since the initial schema);
 *  - completed service_records — imported/legacy service history often lives
 *    ONLY here, with no scheduled_services or invoice rows at all;
 *  - the customer row itself: a real customer stage (CUSTOMER_STAGES) whose
 *    conversion date predates the estimate — a long-standing/imported
 *    customer may carry NO transactional rows whatsoever. The date is the
 *    canonical CONVERSION_DATE_SQL shape (customer-stages.js):
 *    member_since, else created_at as an ET date — quick-add/import paths
 *    may never stamp member_since, and for a real-stage customer created
 *    before the estimate that IS prior evidence. member_since is not
 *    re-stamped on conversion, so a stale intake-stamped date can only
 *    over-disqualify (estimate kept, ages to expiration) — never archive.
 *
 * Date semantics differ by evidence source, ON PURPOSE:
 *  - scheduled_date / service_date anchor to ET midnight (naive timestamp
 *    AT TIME ZONE 'America/New_York'), understating the real event time —
 *    a completed row is genuine conversion evidence either way, so reading
 *    it as "predates" only KEEPS a possibly-live upsell, never archives
 *    one. A bare ::timestamptz would be SESSION-timezone midnight — 8pm ET
 *    the PREVIOUS day on the UTC server — making a next-ET-day visit read
 *    as pre-estimate for any estimate created the evening before, so the
 *    sweep would refuse to archive it and it would later expire as lost.
 *  - the customer conversion date compares as a strictly-earlier ET
 *    calendar day. member_since is stamped when the customer converts,
 *    including at BOOKING time — before any completion/invoice evidence
 *    exists — so treating same-day as "before" would read a same-day
 *    post-estimate conversion as pre-estimate, lifting the first-booking
 *    expiration hold while the booking is still pending (the estimate
 *    would expire mid-courtship and be counted lost forever). Same-day
 *    therefore reads as NOT-before; the transactional guards above still
 *    catch a genuine same-day pre-estimate conversion.
 */
function whereNoConversionBeforeEstimate(query) {
  return query
    .whereNotExists(function () {
      this.select(db.raw("1"))
        .from("invoices")
        .whereRaw("invoices.customer_id = estimates.customer_id")
        .where("invoices.status", "paid")
        .whereRaw(
          "LEAST(invoices.created_at, COALESCE(invoices.paid_at, invoices.created_at)) < estimates.created_at",
        );
    })
    .whereNotExists(function () {
      // A booking CREATED before the estimate — still live or since
      // completed — proves the courtship closed before the quote went out,
      // even while its completion/payment evidence hasn't landed yet (the
      // completed-visit guard below can't see it: nothing completes before
      // it's created). created_at is a real timestamptz, so no date-cast
      // ambiguity. Dead bookings (NON_LIVE) prove nothing and never
      // disqualify.
      this.select(db.raw("1"))
        .from("scheduled_services")
        .whereRaw("scheduled_services.customer_id = estimates.customer_id")
        .whereNotIn(
          "scheduled_services.status",
          NON_LIVE_APPOINTMENT_STATUSES,
        )
        .whereRaw("scheduled_services.created_at < estimates.created_at");
    })
    .whereNotExists(function () {
      this.select(db.raw("1"))
        .from("scheduled_services")
        .whereRaw("scheduled_services.customer_id = estimates.customer_id")
        .where("scheduled_services.status", "completed")
        .whereRaw(
          "COALESCE(scheduled_services.completed_at, scheduled_services.scheduled_date::timestamp AT TIME ZONE 'America/New_York') < estimates.created_at",
        );
    })
    .whereNotExists(function () {
      this.select(db.raw("1"))
        .from("service_records")
        .whereRaw("service_records.customer_id = estimates.customer_id")
        .where("service_records.status", "completed")
        .whereRaw(
          "service_records.service_date::timestamp AT TIME ZONE 'America/New_York' < estimates.created_at",
        );
    })
    .whereNotExists(function () {
      this.select(db.raw("1"))
        .from("customers")
        .whereRaw("customers.id = estimates.customer_id")
        .whereIn("customers.pipeline_stage", CUSTOMER_STAGES)
        .whereRaw(
          "COALESCE(customers.member_since, (customers.created_at AT TIME ZONE 'America/New_York')::date) < (estimates.created_at AT TIME ZONE 'America/New_York')::date",
        );
    });
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
  // "First-ever" is judged ACROSS signal sources: at least one eligibility
  // signal (paid invoice or completed visit) exists, and NO conversion
  // evidence of ANY kind (whereNoConversionBeforeEstimate — a deliberately
  // broader set) predates the estimate. Judging each source independently
  // would let a customer with a pre-estimate completed service but no prior
  // invoice match the invoice branch on a later payment and lose a live
  // upsell estimate.
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
          // status='completed' alone is the signal — legacy rows (pre
          // 20260422000009) carry a NULL completed_at, and the none-before
          // disqualifier below already times them via scheduled_date.
          // Requiring completed_at here would leave a legacy-only customer
          // permanently ineligible, so their converted estimate would fall
          // through to expiration instead of being archived.
          this.select(db.raw("1"))
            .from("scheduled_services")
            .whereRaw("scheduled_services.customer_id = estimates.customer_id")
            .where("scheduled_services.status", "completed");
        }),
    )
    .modify(whereNoConversionBeforeEstimate)
    // Never archive an estimate holding a received (unconsumed, unrefunded)
    // acceptance deposit: archived rows are excluded from expiration, and
    // sweepTerminalEstimateDeposits only scans declined/expired estimates —
    // archiving would strand the customer's deposit money forever. Left
    // live, the row ages out → expires → the sweep refunds it; the per-send
    // conversion guard suppresses follow-up nags in the meantime.
    .whereNotExists(function () {
      this.select(db.raw("1"))
        .from("estimate_deposits")
        .whereRaw("estimate_deposits.estimate_id = estimates.id")
        .where("estimate_deposits.status", "received");
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

/**
 * Expiration hold (knex `.modify` helper for the expiration worker's
 * `estimates` queries): keep an estimate out of the daily expiration flips
 * while the customer's FIRST booking is still pending. Booking suppresses
 * follow-ups (customerConvertedSince) but the archive sweep above waits for
 * a completion/payment, so a visit scheduled beyond ESTIMATE_EXPIRATION_DAYS
 * would otherwise flip to `expired` mid-courtship — and the sweep's
 * sent/viewed filter can never reclaim an expired row, so the booked
 * conversion would be counted lost forever.
 *
 * Self-resolving, never a permanent park: the visit completes → the sweep
 * (which runs BEFORE expiration in the 6am chain) archives the estimate;
 * the visit dies (cancelled/rescheduled/skipped/no_show) → the hold lifts
 * and expiration resumes next run. A deposit-holding row resolves the same
 * way: completion lifts the hold, the sweep's deposit guard refuses it, it
 * expires, and the terminal-deposit sweep refunds.
 *
 * First-ever narrowing, in lockstep with the sweep's none-before guards
 * (the shared whereNoConversionBeforeEstimate helper IS the sync): a
 * customer who converted BEFORE the estimate is a long-standing customer
 * whose pending visits are routine; holding their open upsell estimate
 * would park it un-expirable for as long as they stay on service.
 */
function excludePendingFirstBookings(query) {
  return query.whereNotExists(function () {
    whereNoConversionBeforeEstimate(
      this.select(db.raw("1"))
        .from("scheduled_services as pending_visit")
        .whereRaw("pending_visit.customer_id = estimates.customer_id")
        .whereNotIn("pending_visit.status", [
          ...NON_LIVE_APPOINTMENT_STATUSES,
          "completed",
        ])
        .whereRaw("pending_visit.created_at >= estimates.created_at"),
    );
  });
}

module.exports = {
  customerConvertedSince,
  archiveConvertedOpenEstimates,
  excludePendingFirstBookings,
  NON_LIVE_APPOINTMENT_STATUSES,
};
