// Same-trip first-application billing ALERT (redesigned per owner ruling,
// 2026-09-27 — "alert only, no hold"; supersedes the #5021 round-3..7 hold
// design entirely — see the PR body for the full ruling history). A
// reserved-accept slot that sells MORE than one recurring program mints ONE
// combined "First service application" invoice, linked to the RESERVED
// row. Every OTHER program's promoted parent is left with estimated_price
// NULL on purpose — treated as covered by that shared invoice while both
// visits share a date (see estimate-converter.js reservedAcceptPerVisitSplit
// and estimate-first-application-invoice.js
// findFirstApplicationInvoiceForEstimateService, whose own date-keyed match
// simply stops matching once a member's date diverges — no code change
// needed there).
//
// PRIOR DESIGNS (superseded, see PR #5021's body for the full history):
// round 1-2 auto-split the shared invoice's money at move time (Codex found
// a new money-correctness gap every round). Round 3-7 replaced that with a
// durable, invoice-row hold (new columns, a manual clear route, an
// auto-clear, durable-provenance fallbacks, a dedicated advisory lock) — but
// each round's fix to make the hold correctly IDENTIFY and LOCK the invoice
// across every money seam (send-claim, provider handoff, InvoiceService.
// update, lock ordering against a concurrent edit) surfaced a new structural
// gap, round after round. The owner's conclusion: a hold is the wrong shape
// for this problem, because it requires perfectly tracking one invoice's
// identity and state across every money-moving seam in the app.
//
// OWNER RULING (this design): never touch the invoice, never hold
// collection, never lock anything new. In the SAME transaction as the date
// write, write a DURABLE admin alert (notification-service.notifyAdmin,
// category 'billing') — keyed on the ESTIMATE and the diverging visit ids,
// never on finding the invoice by text-matching its title/notes. The alert
// fires whenever a date write leaves at least one UNPRICED member of a
// same-trip group (source_estimate_id, top-of-series, sharing a customer)
// on a different day than the group's PRICED (reserved/invoice-holding)
// member — the unpriced member is the one relying on the shared invoice, so
// that specific divergence is what the office must split by hand.
//
// The alert best-effort includes the shared invoice's own link/number, by
// reusing estimate-first-application-invoice.js's authoritative text-match
// (selectFirstApplicationInvoiceMatch) — but the alert does NOT depend on
// that match succeeding: a renamed/retitled invoice (or one this lookup
// otherwise can't recognize) still gets the alert, just without a link,
// telling the office to go find the estimate's first-application invoice
// by hand. There is no durable "resolved" state to track (no invoice
// columns, no clear route) — the notification itself, plus its dedupe
// key/version, IS the durable record. A later recurrence of the SAME
// divergence (the same estimate + same diverging visit ids) after the
// office already read/dismissed the earlier alert reopens the bell
// (unread again); a repeat call describing the SAME still-open divergence
// does not spam a second bell.
//
// Fails CLOSED: if raising the alert throws, the caller's own transaction
// — including the date write itself — rolls back. Silently committing the
// date move without a durable alert would recreate the exact
// combined-charge/unpriced-sibling gap this module exists to catch, so a
// retryable failure on the whole move is the safe side of that choice
// (kept from the prior design's own round-4 fix, applied here from the
// start since there was never a working "swallow and log" version of this
// design).
//
// Deliberately takes NO new lock (no sibling-group advisory lock, no
// invoice row lock): the alert's own dedupe key (estimate id + sorted
// diverging visit ids) plus notifyAdmin's existing per-dedupeKey advisory
// lock already serialize two concurrent callers that would otherwise both
// try to raise the same alert — nothing here ever mutates a row that a
// concurrent writer could be racing over, so there is no deadlock class to
// close with an extra lock.
//
// Callers (every date-changing writer that can move a same-trip first-
// application visit, unchanged wiring from the prior design):
//   rebooker.js rescheduleOnce (single) + rescheduleSeries (series anchor)
//   admin-schedule.js bulk-reschedule route (per row) + update-details
//   intelligence-bar/schedule-tools.js moveStopsToDay (every stop in the
//     batch, judged on the batch's final per-row state)
//   intelligence-bar/tools.js rescheduleAppointment
//   visit-groups.js moveVisitAsUnit — reaches this through rebooker's own
//     per-member rescheduleOnce call; no separate wiring needed.

const logger = require('./logger');

function dateOnly(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).split('T')[0].slice(0, 10);
}

// Locates the moved row's estimate-accept group — a plain, unlocked read
// (see the module header: no new lock is taken anywhere in this module).
// Only a top-of-series (or one-time) row can be part of a first-application
// invoice's reserved/promoted group — a later CHILD occurrence's date is
// unrelated to the accept-time split.
async function loadEstimateGroup(trx, scheduledServiceId) {
  const moved = await trx('scheduled_services')
    .where({ id: scheduledServiceId })
    .first('id', 'customer_id', 'source_estimate_id', 'recurring_parent_id');
  if (!moved || !moved.customer_id || !moved.source_estimate_id || moved.recurring_parent_id) {
    return { skip: { action: 'skipped', reason: 'not_estimate_anchor' } };
  }
  const members = await trx('scheduled_services')
    .where({ customer_id: moved.customer_id, source_estimate_id: moved.source_estimate_id })
    .whereNull('recurring_parent_id')
    .orderBy('id')
    .select('id', 'scheduled_date', 'estimated_price', 'completed_at');
  if (members.length < 2) return { skip: { action: 'skipped', reason: 'no_siblings', moved } };
  return { moved, members };
}

// The group's PRICED (reserved/invoice-holding) member — the one whose own
// quoted price covers the combined same-day total, and therefore the row
// every unpriced sibling's coverage is anchored to. No priced member at all
// means this isn't (or is no longer) a reserved-accept split group.
function findPricedAnchor(members) {
  return members.find((m) => m.estimated_price != null) || null;
}

// Members currently diverging from the anchor's date: unpriced (relying on
// the shared invoice — see the module header) and not already completed (a
// completed row's billing outcome is a settled fact a plain date move can't
// change).
function divergingSiblings(anchor, members) {
  const anchorDate = dateOnly(anchor.scheduled_date);
  return members.filter((m) => String(m.id) !== String(anchor.id)
    && m.estimated_price == null
    && !m.completed_at
    && dateOnly(m.scheduled_date) !== anchorDate);
}

// Best-effort invoice lookup for the alert's own link/number — reuses
// estimate-first-application-invoice.js's authoritative text-match
// precedence (selectFirstApplicationInvoiceMatch) so this never re-derives
// its own notion of "which invoice." Returns null on no match (a renamed
// invoice, or genuinely none) — the alert still fires either way, see
// raiseDivergenceAlert.
async function findFirstApplicationInvoiceForAlert(trx, memberIds) {
  const { selectFirstApplicationInvoiceMatch } = require('./estimate-first-application-invoice');
  const candidates = await trx('invoices')
    .whereIn('scheduled_service_id', memberIds)
    .whereNot('status', 'void')
    .orderBy('created_at', 'desc')
    .select('*');
  const { invoice, liveBeside } = selectFirstApplicationInvoiceMatch(candidates);
  return liveBeside || invoice || null;
}

// Decides the dedupeVersion to hand notifyAdmin for this dedupeKey — reads
// the CURRENT standing notification (if any) for it first, in the same
// trx, so the version we submit reflects whether this is the SAME
// still-unread divergence (keep its existing version — no needless
// re-bell) or a fresh occurrence (no standing row, or the standing one was
// already read/dismissed — a genuine recurrence, which must always
// re-bell). A plain read (no lock): notifyAdmin's own per-dedupeKey
// advisory lock is what actually serializes the write that follows, so a
// race here can only affect which side of "same version" vs "fresh
// version" a concurrent caller picks — never correctness of the alert
// itself.
async function nextDedupeVersion(trx, dedupeKey) {
  const existing = await trx('notifications')
    .where({ recipient_type: 'admin' })
    .whereRaw("metadata->>'dedupeKey' = ?", [dedupeKey])
    .first('read_at', 'metadata');
  if (existing && !existing.read_at) {
    let meta = existing.metadata;
    if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch { meta = null; } }
    if (meta && typeof meta.dedupeVersion === 'string') return meta.dedupeVersion;
  }
  return new Date().toISOString();
}

// Raises the durable admin alert, IN THE SAME TRANSACTION as the date
// write (`trx`) — see the module header for why this must propagate a
// failure rather than swallow it (no try/catch here on purpose).
async function raiseDivergenceAlert(trx, { estimateId, diverging, invoice }) {
  const sortedIds = [...new Set(diverging.map((d) => String(d.id)))].sort();
  const dedupeKey = `first_application_sibling_divergence:${estimateId}:${sortedIds.join(',')}`;
  const dedupeVersion = await nextDedupeVersion(trx, dedupeKey);
  const invoiceRef = invoice
    ? `Invoice ${invoice.invoice_number || invoice.id}.`
    : `Check the first-application invoice for estimate #${estimateId}.`;
  await require('./notification-service').notifyAdmin(
    'billing',
    'First-application invoice may need to be split by hand',
    `Visits from one estimate were moved to different days. The combined first-application invoice may now charge for both on one day — split it by hand. ${invoiceRef}`,
    {
      link: invoice ? `/admin/invoices?invoice=${invoice.id}` : `/admin/estimates/${estimateId}`,
      bell: true,
      metadata: { estimateId: String(estimateId), divergingSiblingIds: sortedIds },
      dedupeKey,
      dedupeVersion,
      refreshOnDedupe: true,
      trx,
    },
  );
}

/**
 * Called after ANY write that changes scheduled_date on a top-of-series (or
 * one-time) scheduled_services row, inside the SAME transaction as that
 * write. Side-effect-free unless it actually finds an unpriced sibling
 * diverging from the group's priced (reserved) member's date — cheap and
 * safe to call unconditionally.
 *
 * Because this runs in the SAME transaction as the date write, a crash,
 * deadlock, or a failure raising the alert rolls the whole move back with
 * it — there is no window where a move commits without its alert (see the
 * module header's fail-closed note).
 *
 * @param {import('knex').Knex.Transaction} trx - the caller's OPEN transaction
 * @param {string} scheduledServiceId - the row whose date just changed (post-write id)
 */
async function flagFirstApplicationSiblingDivergence(trx, scheduledServiceId) {
  if (!trx || !scheduledServiceId) return { action: 'skipped', reason: 'missing_args' };

  const group = await loadEstimateGroup(trx, scheduledServiceId);
  if (group.skip) return group.skip;
  const { moved, members } = group;

  const anchor = findPricedAnchor(members);
  if (!anchor) return { action: 'skipped', reason: 'no_priced_anchor', moved };

  const diverging = divergingSiblings(anchor, members);
  if (!diverging.length) return { action: 'skipped', reason: 'no_diverging_sibling', moved };

  const invoice = await findFirstApplicationInvoiceForAlert(trx, members.map((m) => m.id));
  await raiseDivergenceAlert(trx, { estimateId: moved.source_estimate_id, diverging, invoice });
  return {
    action: 'alert_raised',
    estimateId: moved.source_estimate_id,
    invoiceId: invoice ? invoice.id : null,
    divergingSiblingIds: diverging.map((d) => d.id),
  };
}

/**
 * Same as flagFirstApplicationSiblingDivergence, with one logged line on a
 * genuine failure before re-throwing — every call site runs this inside its
 * OWN caller transaction, so the caller's await rejects too and the whole
 * move (including the date write) rolls back rather than committing without
 * its alert. See the module header's fail-closed note.
 */
async function flagFirstApplicationSiblingDivergenceSafely(trx, scheduledServiceId, context = '') {
  try {
    return await flagFirstApplicationSiblingDivergence(trx, scheduledServiceId);
  } catch (err) {
    logger.error(`[first-application-sibling-split] divergence alert failed for ${scheduledServiceId}${context ? ` (${context})` : ''} — propagating so the move rolls back rather than committing without it: ${err.message}`);
    throw err;
  }
}

module.exports = {
  flagFirstApplicationSiblingDivergence,
  flagFirstApplicationSiblingDivergenceSafely,
  dateOnly,
  // Exported for direct unit coverage of the lookup/classification pieces.
  loadEstimateGroup,
  findPricedAnchor,
  divergingSiblings,
  findFirstApplicationInvoiceForAlert,
};
