// ============================================================
// setup-fee-obligation.js
//
// Detects an accepted pay-per-application estimate whose WaveGuard setup
// fee (and with it the whole acceptance invoice — setup + first
// application) was NEVER minted. The standard verbal "Mark Won" accept
// skips the acceptance invoice by design (estimate-manual-acceptance:
// scheduling and invoicing stay under operator control), and a public
// accept whose invoice mint failed inside the converter's non-blocking
// try lands in the same state — so the first visit would auto-bill only
// the per-application price and the one-time setup fee silently
// evaporates. Completion billing consults this detector to PARK that
// first visit for manual billing instead (owner ruling 2026-08-24, same
// shape as the canceled-setup-fee parking from #3474), and the
// scheduling surfaces consult it to warn before completion.
//
// "Owed" here means ALL of:
//   - the estimate exists, is accepted, and the customer actually agreed
//     to the fee: the persisted send-snapshot shows it, or — absent
//     affirmative snapshot evidence (fee-less bundles are stale shapes
//     repaired at view time, never proof) — the accept postdates the end
//     of the rule's go-live day (older accepts never promised the fee);
//   - the accepted recurring mix actually carries the fee per the ONE
//     authority (estimate-converter.shouldIncludeWaveGuardSetupFeeForRecurring
//     — existing-customer waiver, operator waiver, bundle rule, solo
//     pest/mosquito rule all live there);
//   - it is not invoice-mode (bill_by_invoice bills through its own
//     proposal invoice) and holds no LIVE annual-prepay term (prepay
//     waives the fee; a cancelled term returned the customer to
//     per-application billing and does not suppress);
//   - the converter actually ran for it (activity_log
//     'estimate_converted' row) — the provenance that the acceptance
//     reached the invoicing decision at all;
//   - NO LIVE invoice stamped "accepted estimate #<id>" exists, and no
//     dead (void/refunded/canceled) stamped invoice that resolves it
//     exists. Resolving = refunded in ANY attachment state (the fee was
//     collected then deliberately refunded — an operator money action,
//     and a bounced refund restores the row to paid; never instruct a
//     re-bill), or canceled/cancelled + a positive setup-fee line +
//     PROVABLY discoverable by #3474's canceledSetupFee lane (attached
//     to a same-estimate visit on the completing visit's scheduled
//     date). Attachment alone proves nothing:
//     findFirstApplicationInvoiceForEstimateService excludes 'void'
//     outright and only joins same-date siblings, so a void attached
//     invoice, or a canceled one on a replaced-and-moved visit, leaves
//     the fee genuinely unbilled and the obligation survives it.
// ============================================================

const db = require('../models/db');

// The solo-plan setup-fee rule went live the EVENING of 2026-07-10 (see
// pricingBundleMissingRequiredSetupFee in estimate-public). Persisted
// acceptance-time display evidence outranks any date: the send snapshot's
// pricing bundle records exactly what the customer was shown. Only when
// no snapshot exists does the date decide, and then the cutoff is the END
// of 2026-07-10 ET — a midnight-UTC calendar proxy would sweep in
// same-day accepts whose estimate predated the evening deploy and demand
// an unagreed $99 (Codex P0, pre-push round 3). Fail-safe direction:
// without display evidence, an ambiguous same-day accept is OUT of scope.
const SETUP_FEE_RULE_SAFE_CUTOFF = '2026-07-11T04:00:00Z'; // 2026-07-11 00:00 ET

// Did the estimate the customer accepted actually SHOW the setup fee?
// Reads the persisted send-snapshot pricing bundle using the same
// service-key recognizers as pricingBundleMissingRequiredSetupFee.
// Returns 'shown' on affirmative evidence, 'feeless' when a bundle
// exists with no fee, null when there is no bundle at all. 'feeless' is
// deliberately NOT no-fee proof for a PUBLIC accept — a fee-less bundle
// on a fee-due mix is exactly the STALE shape estimate-public
// invalidates and recomputes WITH the fee at view time (Codex P0,
// pre-push round 4) — but a MANUAL Mark Won accept involves no page
// view, so there the fee-less snapshot IS the last pricing the customer
// saw (Codex P0, pre-push round 15).
// Returns { evidence: 'shown'|'feeless'|null, amount: number|null } —
// the amount is the FROZEN fee the customer actually accepted (a legacy
// or discounted snapshot may show something other than the current
// constant; the obligation must demand the accepted price, and changing
// WAVEGUARD_SETUP_FEE must never retro-edit outstanding obligations —
// Codex PR r4 P1).
function snapshotShowsSetupFee(estimateData) {
  const bundle = estimateData?.sendSnapshot?.pricingBundle;
  if (!bundle || typeof bundle !== 'object') return { evidence: null, amount: null };
  // Legacy frozen rows carry no normalized service key ("WaveGuard
  // Membership Setup", price 99) — the SAME textual recognizer the public
  // pricing path uses (isWaveGuardSetupOneTimeItem) must count them as
  // fee-shown, or a post-cutoff manual accept of a legacy snapshot would
  // read 'feeless' and disable the guard (Codex PR r3 P1).
  let isLegacySetupItem = () => false;
  let legacyAmount = null;
  try {
    ({
      isWaveGuardSetupOneTimeItem: isLegacySetupItem,
      oneTimeItemAmount: legacyAmount,
    } = require('../routes/estimate-public'));
  } catch { /* route unavailable in some harnesses — service-key check stands */ }
  const isSetupRow = (row) => row?.service === 'waveguard_setup' || isLegacySetupItem(row || {});
  // Amount precedence mirrors the authoritative row parser
  // (oneTimeItemAmount): DISCOUNTED fields outrank the original price —
  // the obligation must demand what the customer actually saw, never the
  // pre-discount figure (Codex PR r5 P1).
  // Zero is AUTHORITATIVE (Codex P0): a fully discounted/legacy $0 fee
  // row means the customer agreed to zero — never fall back to the
  // current constant for a row that exists. null = amount unreadable.
  const rowAmount = (row) => {
    const n = typeof legacyAmount === 'function'
      ? legacyAmount(row || {})
      : Number(row?.priceAfterDiscount ?? row?.totalAfterDiscount ?? row?.amount ?? row?.price ?? row?.total ?? row?.unit_price);
    return Number.isFinite(n) ? Math.max(0, Math.round(n * 100) / 100) : null;
  };
  const hit = (Array.isArray(bundle.firstVisitFees) ? bundle.firstVisitFees : []).find(isSetupRow)
    || (Array.isArray(bundle.oneTimeBreakdown?.items) ? bundle.oneTimeBreakdown.items : []).find(isSetupRow)
    || (bundle.setupFee && isSetupRow(bundle.setupFee) ? bundle.setupFee : null);
  if (hit) return { evidence: 'shown', amount: rowAmount(hit) };
  return { evidence: 'feeless', amount: null };
}

function parseEstimateData(raw) {
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) || {}; } catch { return {}; }
  }
  return raw || {};
}

// Plan membership by DURABLE recurring identity, never by service-type
// text: detectServiceLine only names a report category and defaults
// unknown types to 'pest', so a same-category one-time add-on (a pest
// corrective beside recurring pest service) would pass a text check
// (Codex P0, pre-push round 2). The converter/seeder stamp every billed
// plan row — parent AND children — is_recurring=true; that flag alone is
// the discriminator (Codex PR r3 P1): a non-recurring BOOSTER carries
// recurring_parent_id while explicitly billing its own one-off price
// (admin-schedule booster lane), so a parent link must never classify a
// row as a plan application. The obligation belongs to plan-application
// visits only: a one-time add-on/booster sourced from the same estimate
// must neither trigger the completion hold (suppressing its mint would
// drop its own charge) nor satisfy the first-visit check.
function isPlanApplicationRow(row) {
  return !!(row && row.is_recurring);
}

/**
 * @param {object} params
 * @param {string} params.sourceEstimateId  the visit's source_estimate_id
 * @param {string|null} params.customerId   when given, must match the
 *   estimate's customer (a re-linked visit must not park another
 *   customer's obligation)
 * @param {string|null} params.excludeScheduledServiceId  the visit being
 *   completed — excluded from the prior-completed-visit check
 * @param {{is_recurring?: boolean, recurring_parent_id?: string|null}|null}
 *   params.visitPlanRow  the completing visit's recurrence identity; when
 *   given, a NON-plan row (a one-time add-on from the same estimate:
 *   is_recurring falsy and no recurring_parent_id) reports not-owed so
 *   its own mint is never suppressed
 * @param {object} conn  knex connection/transaction
 * @returns {Promise<{owed: boolean, setupFee?: number, estimateId?: string,
 *   estimateSlug?: string|null, firstVisitAlreadyCompleted?: boolean,
 *   deadInvoice?: {id: string, invoiceNumber: string|null, status: string}|null}>}
 *   Throws on query failure — the completion caller fails CLOSED on it,
 *   the display caller catches and degrades to "no warning".
 */
async function findUnmintedSetupFeeObligation({
  sourceEstimateId,
  customerId = null,
  excludeScheduledServiceId = null,
  visitPlanRow = null,
} = {}, conn = db) {
  if (!sourceEstimateId) return { owed: false };
  const estimate = await conn('estimates').where({ id: sourceEstimateId }).first();
  if (!estimate) return { owed: false };
  if (String(estimate.status || '').toLowerCase() !== 'accepted') return { owed: false };
  if (customerId && String(estimate.customer_id) !== String(customerId)) return { owed: false };
  if (estimate.bill_by_invoice) return { owed: false };
  const acceptedAt = estimate.accepted_at ? new Date(estimate.accepted_at) : null;
  if (!acceptedAt || Number.isNaN(acceptedAt.getTime())) return { owed: false };

  const EstimateConverter = require('./estimate-converter');
  const estimateData = parseEstimateData(estimate.estimate_data);
  // Display evidence first, date proxy second: a snapshot that shows the
  // fee puts the accept in scope regardless of date. Otherwise only
  // accepts after the rule day fully ended qualify, and even then a
  // FEE-LESS snapshot accepted via manual Mark Won stays OUT of scope
  // (Codex P0, pre-push round 15): a public accept necessarily rendered
  // the repaired page with the fee, but a Mark Won accept involves no
  // page view — the fee-less snapshot is the last pricing the customer
  // saw, and billing an unagreed $99 is never fail-safe.
  const { evidence: feeEvidence, amount: snapshotFeeAmount } = snapshotShowsSetupFee(estimateData);
  // A shown fee row whose accepted amount is zero (fully discounted) or
  // unreadable proves no POSITIVE agreed fee — nothing to park (Codex
  // P0): the current constant substitutes only when NO fee row exists
  // (date-rule path below).
  if (feeEvidence === 'shown' && !(snapshotFeeAmount > 0)) return { owed: false };
  if (feeEvidence !== 'shown') {
    if (acceptedAt < new Date(SETUP_FEE_RULE_SAFE_CUTOFF)) return { owed: false };
    if (feeEvidence === 'feeless'
      && String(estimate.price_locked_by || '') !== 'customer_accept') {
      // Consent needs POSITIVE proof (Codex P0, pre-push round 16): the
      // activity-log row a manual accept writes is best-effort (its
      // insert failure is swallowed), so its absence proves nothing. The
      // DURABLE atomic marker is estimates.price_locked_by — only
      // 'customer_accept' proves the customer rendered the repaired page
      // with the fee; 'manual_accept', 'backfill', or null leave the
      // fee-less snapshot as the last pricing the customer saw.
      return { owed: false };
    }
  }
  const recurringServices = EstimateConverter.recurringServicesFromEstimateData(estimateData);
  if (!EstimateConverter.shouldIncludeWaveGuardSetupFeeForRecurring({ recurringServices, estimateData })) {
    return { owed: false };
  }

  // A completing visit that is not a plan-application row (a one-time
  // add-on sourced from the same estimate) never owns the obligation —
  // holding ITS mint would silently drop the add-on charge.
  if (visitPlanRow != null && !isPlanApplicationRow(visitPlanRow)) {
    return { owed: false };
  }

  // A COVERED annual-prepay term means the accept took (or switched to)
  // the prepay path and its money actually stands — the fee is waived by
  // that policy and the prepay invoice is its own billing record.
  // Coverage comes from the ONE canonical predicate
  // (annual-prepay-renewals.coveredTermsAsOf — Codex P0, pre-push rounds
  // 13 and 18): a cancelled/refunded term, a payment_pending term whose
  // invoice never settled, or a decided term whose backing payment was
  // clawed back all read NOT covered, and none of them may erase the
  // setup-fee obligation.
  const AnnualPrepayRenewals = require('./annual-prepay-renewals');
  const coveredPrepayTerm = await AnnualPrepayRenewals.coveredTermsAsOf(conn, null)
    .where('t.source_estimate_id', estimate.id)
    .first('t.id');
  if (coveredPrepayTerm) return { owed: false };

  // Every accept-time mint (converter setup/prepay draft, public inline
  // pay-per-application mint, invoice-mode mint) stamps
  // "accepted estimate #<id>" into the invoice notes — invoices carry no
  // estimate_id column, so the stamp is the deterministic linkage (same
  // convention as estimate-payment-context / buildAlreadyAcceptedSuccessPayload).
  // A stamped invoice satisfies the obligation only when it actually
  // BILLED the fee (invoiceHasPositiveSetupFeeLine, strict — no notes
  // fallback, round-17 P0; round-5 P0: stamped
  // "first application only" invoices are legitimate converter output):
  //   - LIVE + fee line → minted, done;
  //   - refunded + fee line, ANY attachment → the fee was collected then
  //     deliberately refunded; never instruct a re-bill (see below);
  //   - canceled/cancelled + attached + fee line → #3474's
  //     canceledSetupFee parking lane surfaces it.
  // Everything else — application-only rows in any status, void rows
  // (attachment proves nothing, findFirstApplicationInvoiceForEstimate
  // Service excludes 'void' outright), canceled fee rows unattached —
  // leaves the fee genuinely unbilled, so the obligation survives it
  // (Codex P0, round 1) and the alert names a dead fee-carrying invoice
  // so the office can distinguish "voided without replacement" from
  // "never minted".
  const DEAD_STATUSES = new Set([...require('./invoice').CANCELLED_SERVICE_RESOLVED_STATUSES, 'void']);
  const { invoiceHasPositiveSetupFeeLine, invoiceBillsBaseApplication } = require('./estimate-first-application-invoice');
  const stampedRows = await conn('invoices')
    .where({ customer_id: estimate.customer_id })
    .where('notes', 'like', `%accepted estimate #${estimate.id}%`)
    .select('id', 'invoice_number', 'status', 'scheduled_service_id', 'service_record_id', 'line_items', 'notes');
  // Every clearing path requires the invoice to have ACTUALLY BILLED the
  // fee (Codex P0, pre-push round 5): the converter legitimately mints
  // stamped "first application only" invoices (waived-then-changed data,
  // office edits, fee-less prior mints), and clearing on the stamp alone
  // would let completion proceed unparked while the $99 was never billed.
  // An application-only live stamped invoice leaves the obligation OWED —
  // the completion hold then suppresses the duplicate application mint
  // and the alert's revalidation directs staff to bill only the fee.
  const liveStampedFee = stampedRows.find((r) => !DEAD_STATUSES.has(String(r.status || '').toLowerCase())
    && invoiceHasPositiveSetupFeeLine(r));
  if (liveStampedFee) return { owed: false };
  // REFUNDED (fee-carrying) satisfies regardless of attachment (Codex
  // PR r2 P1): the fee was COLLECTED and then deliberately refunded —
  // an operator/webhook money action, not a silent leak — and a
  // setup-only acceptance invoice is deliberately created with NO
  // scheduled_service_id (estimate-converter). There is no refund-event
  // clock, and a bounced refund (refund.failed) restores the row to
  // paid: instructing a manual re-bill here would risk a double
  // collection.
  const refundedFee = stampedRows.find((r) => String(r.status || '').toLowerCase() === 'refunded'
    && invoiceHasPositiveSetupFeeLine(r));
  if (refundedFee) return { owed: false };
  // A CANCELED fee-carrying invoice satisfies only when #3474's
  // canceledSetupFee lane can PROVABLY discover it (Codex P0, pre-push
  // round 14): findFirstApplicationInvoiceForEstimateService joins
  // invoices by scheduled_service_id to a same-estimate visit ON THE
  // COMPLETING VISIT'S scheduled date. A canceled invoice attached to a
  // visit that was itself canceled and replaced on another date is
  // invisible to that lane — the obligation must survive it or the
  // replacement visit mints bare. Without a completing-visit context
  // (display callers) the attachment is unprovable → owed.
  const canceledAttachedFee = stampedRows.find((r) => {
    const status = String(r.status || '').toLowerCase();
    return (status === 'canceled' || status === 'cancelled')
      && r.scheduled_service_id && invoiceHasPositiveSetupFeeLine(r);
  });
  if (canceledAttachedFee && excludeScheduledServiceId) {
    const attachedRow = await conn('scheduled_services')
      .where({ id: canceledAttachedFee.scheduled_service_id })
      .first('scheduled_date', 'source_estimate_id');
    const completingRow = await conn('scheduled_services')
      .where({ id: excludeScheduledServiceId })
      .first('scheduled_date');
    const { dateOnly } = require('./estimate-first-application-invoice');
    const discoverable = !!(attachedRow && completingRow
      && String(attachedRow.source_estimate_id) === String(estimate.id)
      && dateOnly(attachedRow.scheduled_date)
      && dateOnly(attachedRow.scheduled_date) === dateOnly(completingRow.scheduled_date));
    if (discoverable) return { owed: false };
  }
  // Name only a dead FEE-CARRYING invoice — a dead application-only row
  // never billed the fee, so "never invoiced" is the accurate story.
  const deadInvoice = stampedRows.find((r) => DEAD_STATUSES.has(String(r.status || '').toLowerCase())
    && invoiceHasPositiveSetupFeeLine(r)) || null;

  // Converter provenance: the accept actually ran the conversion (tier
  // flip, activity row) and still minted nothing. Accepts that never
  // converted (legacy paths, pre-converter rows) are out of scope.
  const converted = await conn('activity_log')
    .where({ customer_id: estimate.customer_id, action: 'estimate_converted' })
    .where('description', 'like', `Estimate #${estimate.id} converted:%`)
    .first('id');
  if (!converted) return { owed: false };

  // The obligation resolves to sweep territory only on DURABLE BILLING
  // EVIDENCE: an earlier PLAN visit of this estimate that completed AND
  // carries a live invoice (billed bare, pre-fix — parking a LATER
  // routine visit would misdirect the office). Completion status alone
  // proves nothing (Codex P0, pre-push round 3): an inspection_only /
  // customer_declined outcome or a coverage-suppressed billing still
  // marks the row completed while minting nothing — clearing the
  // obligation on it would let every later performed application bypass
  // parking and lose the fee permanently. Only plan rows (is_recurring /
  // recurring_parent_id) count either way: a completed one-time add-on /
  // inspection from the same estimate must not release the hold on the
  // actual first application (Codex P0, round 1).
  let priorQuery = conn('scheduled_services')
    .where({ source_estimate_id: estimate.id })
    .where('status', 'completed');
  if (excludeScheduledServiceId) priorQuery = priorQuery.whereNot('id', excludeScheduledServiceId);
  const priorCompletedRows = await priorQuery.select('id', 'is_recurring', 'recurring_parent_id');
  const priorPlanRows = (priorCompletedRows || []).filter(isPlanApplicationRow);
  let priorCompleted = null;
  if (priorPlanRows.length) {
    const planIds = priorPlanRows.map((r) => r.id);
    const priorRecordIds = await conn('service_records')
      .whereIn('scheduled_service_id', planIds)
      .pluck('id');
    const priorBilledRows = await conn('invoices')
      .where((qb) => {
        qb.whereIn('scheduled_service_id', planIds);
        if (priorRecordIds.length) qb.orWhereIn('service_record_id', priorRecordIds);
      })
      .whereNotIn('status', Array.from(DEAD_STATUSES))
      .select('id', 'line_items', 'notes');
    // The evidence must be the plan APPLICATION being billed, not any
    // invoice that happens to hang off the visit (Codex P0, pre-push
    // round 6) — a setup-only or otherwise fee-marked attached invoice
    // proves nothing about the application and must not clear the guard.
    // Only the durable base-application identity counts (round 18 —
    // linkage alone is insufficient money evidence).
    priorCompleted = (priorBilledRows || []).find(invoiceBillsBaseApplication) || null;
  }

  return {
    owed: true,
    // The accepted (frozen) amount wins over the current constant.
    setupFee: snapshotFeeAmount != null ? snapshotFeeAmount : EstimateConverter.WAVEGUARD_SETUP_FEE,
    estimateId: estimate.id,
    estimateSlug: estimate.estimate_slug || null,
    firstVisitAlreadyCompleted: !!priorCompleted,
    deadInvoice: deadInvoice
      ? { id: deadInvoice.id, invoiceNumber: deadInvoice.invoice_number || null, status: String(deadInvoice.status || '') }
      : null,
  };
}

module.exports = {
  findUnmintedSetupFeeObligation,
  _private: {
    SETUP_FEE_RULE_SAFE_CUTOFF, parseEstimateData, isPlanApplicationRow, snapshotShowsSetupFee,
  },
};
