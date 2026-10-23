/**
 * Post-commit follow-through for CANCELLED visits — the money and tracker
 * obligations a cancellation carries beyond flipping `status`.
 *
 * Extracted verbatim from the series-scope branch of
 * PUT /api/admin/dispatch/:serviceId/status (admin-dispatch.js) so a second
 * surface that cancels visits — the Edit-appointment plan-length trim in
 * admin-schedule.js — runs the SAME obligations instead of reimplementing a
 * subset of them. Codex #3337 found three of those obligations missing from
 * the trim across three review rounds (the /secure card-request rail, the
 * invoice void, tracker state); the answer to the third one was to stop
 * growing a parallel path and share this one (AGENTS.md: find the existing
 * mechanism and extend its coverage).
 *
 * Collection ordering is load-bearing:
 *   1. Invoice void — closes the service invoice collection rail before a
 *      cancellation fee is attempted, restores credit, and stops dunning.
 *   2. Card fee rails — the estimate card-hold, falling back to the /secure
 *      agreement when no hold exists. Unresolved outcomes alert the office.
 *   3. Tracker cancel — moves track_state off scheduled/en_route and stamps
 *      cancelled_at + the 24h receipt window, recording failures for the ops
 *      alert rail.
 *
 * Every step is best-effort and PER TARGET: the cancels are already committed,
 * so one target's thrown fee step must alert on that visit and let the loop
 * continue — aborting would leave later already-cancelled targets with neither
 * a terminal fee stamp nor an alert, and a retry would never revisit them.
 *
 * MUST be called AFTER the cancelling transaction commits: every step reads
 * the visit's committed state on its own connection.
 */
const logger = require('./logger');
const db = require('../models/db');
const trackTransitions = require('./track-transitions');
const {
  recordTrackTransitionFailure,
  recordTrackTransitionResultFailure,
} = require('./track-transition-alerts');

// Approved effects another worker or admin already carried out between the cancel's commit and this sweep: the sweep
// only lists still-open invoices and still-redeemed offers, so those are absent from its result and would otherwise be
// reported as "changed since the card". Re-read just the missing ones; an invoice already void, or an offer already
// reopened or expired with no booking bound, is the state the card promised. A failed re-read settles nothing (the
// effect is then reported, the safe side).
async function alreadySettledApprovedEffects(pinned, missingInvoiceIds, creditNeedsCheck) {
  const settled = { invoices: new Set(), creditsReversed: 0 };
  try {
    if (missingInvoiceIds.length) {
      const rows = await db('invoices').whereIn('id', missingInvoiceIds).select('id', 'status');
      for (const row of rows || []) if (String(row.status) === 'void') settled.invoices.add(String(row.id));
    }
    if (creditNeedsCheck) {
      const rows = await db('inspection_credit_offers').whereIn('id', pinned.creditReversalOfferIds || []).select('id', 'status', 'redeemed_scheduled_service_id');
      settled.creditsReversed = (rows || []).filter((r) => ['offered', 'expired'].includes(String(r.status)) && !r.redeemed_scheduled_service_id).length;
    }
  } catch (err) {
    logger.warn(`[cancel-followthrough] could not re-read approved effects: ${err.message}`);
  }
  return settled;
}

// Opt-in (pinnedEffects): which approved money effects were not acted on. An approved invoice that was not voided
// changed since the card (amounts, a payment in flight, a different PaymentIntent) and is left for the office; an
// approved credit reversal that did not run was rebound, deferred or lost a race. An effect somebody else already
// completed (the invoice is void, the offer reversed) counts as done.
async function reportUnactedMoney(moneyReport, pinned, voided) {
  if (!moneyReport || !Array.isArray(moneyReport.skipped)) return;
  const done = new Set((voided || []).map(String));
  const missing = (pinned.invoices || []).filter((inv) => !done.has(String(inv.id)));
  const wanted = (pinned.creditReversalOfferIds || []).length;
  const reversed = voided?.inspectionCreditReversal?.reversed ?? 0;
  const settled = await alreadySettledApprovedEffects(pinned, missing.map((inv) => inv.id), reversed < wanted);
  for (const inv of missing) {
    if (!settled.invoices.has(String(inv.id))) moneyReport.skipped.push({ kind: 'invoice', id: inv.id, reason: 'not_voided_changed_since_card' });
  }
  if (Math.max(reversed, settled.creditsReversed) < wanted) moneyReport.skipped.push({ kind: 'inspection_credit', reason: 'not_reversed' });
}

// Opt-in (linkedChildren): the tracker cancel, which runs the linked-visit cascade, did not finish, so no approved
// linked visit was cancelled by it.
function reportLinkedCascadeNotRun(linkedChildren, linkedChildReport) {
  if (!Array.isArray(linkedChildren) || !linkedChildReport || !Array.isArray(linkedChildReport.skipped)) return;
  for (const child of linkedChildren) linkedChildReport.skipped.push({ id: child.id, reason: 'cascade_not_run' });
}

// Close service-invoice collection before starting a Stripe fee call. A failed cleanup skips the fee and alerts, but
// tracker cleanup and the other cancelled visits still proceed. With a pinned effect set (the Intelligence Bar cancel
// card) only the approved invoices and credit reversals run, and every approved effect not carried out is reported.
async function closeVisitInvoices(id, pinned, moneyReport, cancelFence = null) {
  const InvoiceService = require('./invoice');
  if (pinned) {
    const voided = await InvoiceService.voidOpenInvoicesForCancelledService(id, {
      pinnedInvoices: pinned.invoices || [],
      pinnedCreditReversalOfferIds: pinned.creditReversalOfferIds || [],
      ...(cancelFence ? { cancelFence } : {}),
    });
    await reportUnactedMoney(moneyReport, pinned, voided);
  } else {
    await InvoiceService.voidOpenInvoicesForCancelledService(id);
  }
  // The void sweep deliberately skips unsafe invoices without throwing.
  // Reuse its callers' resolved-status contract: paid/processing money,
  // an unverifiable PI, and still-collectible invoices all need review.
  const unresolvedInvoice = await InvoiceService.unresolvedInvoicesForCancelledService(db, id).first('id');
  if (unresolvedInvoice) {
    throw Object.assign(new Error('Service invoice still needs money handling; fee requires review'), { code: 'MONEY_REVIEW' });
  }
}

// The instant the fee rails judge. Explicit waivers need no history, including legacy cancelled visits.
async function cancellationInstant(id, { now, waiveFee }) {
  let cancelledAt = now || (waiveFee ? new Date() : null);
  if (!cancelledAt) {
    const transition = await db('job_status_history')
      .where({ job_id: id, to_status: 'cancelled' })
      .whereNot('from_status', 'cancelled')
      .orderBy('transitioned_at', 'desc')
      .first('transitioned_at');
    cancelledAt = transition?.transitioned_at;
  }
  const feeTime = new Date(cancelledAt || NaN);
  if (!Number.isFinite(feeTime.getTime())) {
    throw Object.assign(new Error('Cancellation time unavailable; fee requires review'), { code: 'MONEY_REVIEW' });
  }
  return feeTime;
}

// A pinned (card-confirmed) cancel is only ever a visit with NO card fee rail (the card refuses any other). It runs no
// card rail at all, so nothing can charge, release or park a hold the card never showed; re-read the rails at the
// cancellation instant and send anything that appeared since to office review.
async function settlePinnedFee(id, feeTime) {
  const { previewCancelFee, feeRailClear } = require('./appointment-cancel-impact');
  if (!feeRailClear(await previewCancelFee(id, feeTime))) {
    throw Object.assign(new Error('A card fee agreement appeared since the confirmed card; fee requires review'), { code: 'MONEY_REVIEW' });
  }
  return { released: true, reason: 'pinned_no_card_rail' };
}

// The estimate card hold first, falling back to the /secure appointment-card agreement.
async function settleCardRails(feeOptions) {
  const CardHolds = require('./estimate-card-holds');
  const ApptCardRequests = require('./appointment-card-request');
  const { reason: holdReason, charged, released, parked } = await CardHolds.handleCardHoldCancellation(feeOptions);
  return holdReason === 'no_hold'
    ? ApptCardRequests.handleAppointmentCardCancellation(feeOptions)
    : {
      released: [charged, released, parked, holdReason === 'park_gate_off'].includes(true),
      reason: holdReason || 'hold_unresolved',
    };
}

// The money obligations of one cancelled visit, best-effort: a thrown step becomes a fee_step_error outcome (and, for a
// pinned set, a reported skip) so the office is alerted and the tracker cleanup still runs.
async function settleVisitMoney(id, ctx) {
  const pinned = ctx.pinnedEffects?.[id] || null;
  try {
    await closeVisitInvoices(id, pinned, ctx.moneyReport, ctx.cancelFence);
    const CardHolds = require('./estimate-card-holds');
    const feeTime = await cancellationInstant(id, ctx);
    if (pinned) return await settlePinnedFee(id, feeTime);
    // Two clocks: original cancellation decides the cutoff; REAL elapsed
    // time prevents a stale retry from charging weeks after the event.
    return await settleCardRails({
      scheduledServiceId: id,
      waiveFee: ctx.waiveFee || Date.now() - feeTime.getTime() > CardHolds.NO_SHOW_FEE_MAX_AGE_MS,
      now: feeTime,
    });
  } catch (e) {
    logger.error(`[${ctx.source}] cancellation money handling failed (target ${id}): ${e.message}`);
    // Recovery sweep only: an unexpected failure (a database error) is NOT a finished step: it is a hit, so the sweep retries the
    // bundle. A deliberate review verdict (MONEY_REVIEW) stays a reported skip.
    if (ctx.cancelFence && e && e.code !== 'MONEY_REVIEW' && e.code !== 'CANCEL_FENCE') ctx.cancelFence.hits.push('money_step_error');
    if (pinned && ctx.moneyReport && Array.isArray(ctx.moneyReport.skipped)) ctx.moneyReport.skipped.push({ kind: 'follow_through', reason: e.message });
    return { released: false, reason: 'fee_step_error' };
  }
}

// The tracker cancel, which also runs the linked-visit cascade; an approved linked visit it did not get to is reported.
async function cancelVisitTracker(id, { actorId, reason, source, linkedChildren, linkedChildReport, cancelFence }) {
  try {
    const result = await trackTransitions.cancel(id, {
      reason,
      actorId,
      ...(cancelFence ? { cancelFence } : {}),
      ...(Array.isArray(linkedChildren) ? { linkedChildren, linkedChildReport } : {}),
    });
    if (!result?.ok) reportLinkedCascadeNotRun(linkedChildren, linkedChildReport);
    // A fence refusal is not a tracker fault: the recovery sweep reports it (the visit is no longer the approved cancel).
    if (result?.reason === 'cancel_fence') return;
    await recordTrackTransitionResultFailure({ jobId: id, action: 'cancel', actorId, result, cancelFence });
  } catch (e) {
    reportLinkedCascadeNotRun(linkedChildren, linkedChildReport);
    if (e && e.code === 'CANCEL_FENCE') return;
    logger.error(`[${source}] cancel track transition failed for ${id}: ${e.message}`);
    // Recovery sweep only: a failed tracker cancel is NOT done. It is recorded as a hit so the sweep retries the bundle
    // (and reports it if the attempts run out) instead of saving the follow-through as finished. No dispatch alert per
    // retry. Every other caller keeps the best-effort alert.
    if (cancelFence) {
      cancelFence.hits.push('tracker_error');
      return;
    }
    await recordTrackTransitionFailure({ jobId: id, action: 'cancel', actorId, error: e, cancelFence });
  }
}

// The recovery sweep's pre-check (a point-in-time read; the guard of each write is inside that write's transaction).
async function cancelFenceStands(cancelFence) {
  const { assertCancelGeneration, isCancelFence } = require('./cancel-generation-fence');
  try {
    await assertCancelGeneration(db, cancelFence);
    return true;
  } catch (err) {
    if (isCancelFence(err)) return false;
    throw err;
  }
}

/**
 * @param {object}   opts
 * @param {string[]} opts.targetIds  Committed-cancelled scheduled_service ids.
 * @param {string}   [opts.actorId]  Admin/tech id for tracker + alert records.
 * @param {boolean}  [opts.waiveFee] Release the late-cancel fee instead of
 *   charging it. ADMIN-GATED at the call site — this module does not check
 *   the role, it honors what it is told (same contract as the dispatch path).
 * @param {string}   [opts.reason]   Cancellation reason for the tracker stamp.
 * @param {string}   [opts.source]   Log prefix, e.g. 'admin-dispatch'.
 * @param {Date} [opts.now] Explicit cancellation instant for callers that
 *   already retain it. Otherwise read the latest real cancellation transition;
 *   same-status retries must never evaluate fees against the retry clock.
 * @param {object[]} [opts.linkedChildren] Opt-in (the Intelligence Bar cancel card): the linked follow-up visits the
 *   operator approved ({ id, status, scheduled_date, service_type }). The cascade then cancels only those, each
 *   re-checked under its own lock; the rest are listed in opts.linkedChildReport.skipped.
 * @param {object} [opts.moneyReport] Out-param with pinnedEffects: `{ skipped: [] }` collects each approved money
 *   effect that was NOT acted on ({ kind, id?, reason }) because it changed since the card, so the receipt can say so.
 * @param {object} [opts.cancelFence] Opt-in (the Intelligence Bar cancel recovery sweep): { visitId, since, hits }. Every
 *   mutation re-proves inside its own transaction that the visit is still the cancelled one the card approved
 *   (services/cancel-generation-fence.js); refusals are pushed to cancelFence.hits.
 * @param {object} [opts.pinnedEffects] Per-target effects a confirmation
 *   card showed, keyed by target id: `{ invoices, fee,
 *   creditReversalOfferIds }` (from appointment-cancel-impact.js). A pinned
 *   target voids ONLY the listed invoices at the listed amounts, reverses
 *   inspection credit only for the listed offers, and runs NO card rail
 *   (the card only confirms visits without one); a rail that appeared since
 *   goes to office review. Unpinned targets are unchanged.
 */
async function runVisitCancellationFollowThrough({
  targetIds = [],
  actorId = null,
  waiveFee = false,
  reason = null,
  source = 'cancellation',
  now,
  pinnedEffects = null,
  linkedChildren = null,
  linkedChildReport = null,
  moneyReport = null,
  cancelFence = null,
} = {}) {
  const ids = targetIds.filter(Boolean);
  const ApptCardRequests = require('./appointment-card-request');
  const ctx = { actorId, waiveFee, reason, source, now, pinnedEffects, linkedChildren, linkedChildReport, moneyReport, cancelFence };

  for (const id of ids) {
    // Recovery sweep only: a visit that is no longer the cancelled one the card approved gets no money handling and no
    // tracker cancel at all (each mutation below re-proves it again inside its own transaction).
    if (cancelFence && !(await cancelFenceStands(cancelFence))) continue;
    const feeOutcome = await settleVisitMoney(id, ctx);
    // A fence refusal during the money step means the visit changed (or is busy): the bundle's own restoration alert or
    // retry owns it, so no generic fee alert and no tracker cancel on top.
    if (cancelFence && cancelFence.hits.length) continue;
    // One normalized outcome for BOTH rails and thrown failures. The alert service ignores clean outcomes, so no duplicate
    // decision tree here. With a fence the alert row is written in the transaction that proves the generation (a restore
    // that landed while the money step read raises no "cancellation fee" alert for a live visit); a refusal lands on
    // cancelFence.hits and no tracker cancel follows it.
    await ApptCardRequests.alertUnresolvedCancellationFee({ scheduledServiceId: id, outcome: feeOutcome, ...(cancelFence ? { cancelFence } : {}) });
    if (cancelFence && cancelFence.hits.length) continue;
    await cancelVisitTracker(id, ctx);
  }

  return { settled: ids.length };
}

module.exports = { runVisitCancellationFollowThrough };
