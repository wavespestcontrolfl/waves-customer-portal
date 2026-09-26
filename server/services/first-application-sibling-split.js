// Same-trip first-application resplit (prod 2026-09-26): a reserved-accept
// slot that sold MORE than one recurring program mints ONE draft invoice for
// the combined same-day total, linked to the RESERVED row
// (invoices.scheduled_service_id) — its "First service application" line
// carries every program's first visit. Every OTHER program's promoted parent
// is left with estimated_price NULL on purpose: closeout treats it as
// `sibling_first_application`, covered by the reserved row's invoice (see
// estimate-converter.js reservedAcceptPerVisitSplit and
// estimate-first-application-invoice.findFirstApplicationInvoiceForEstimateService).
//
// That coverage is DATE-KEYED: findFirstApplicationInvoiceForEstimateService
// only matches when the invoice's own linked row shares the LOOKING row's
// scheduled_date. Once one of the two visits is rescheduled off the other's
// day, the date match breaks — the invoice-holding row still auto-charges
// its full (still-combined) amount at its own completion, while the moved
// sibling's completion finds no covering invoice and its NULL estimated_price
// bills nothing. The customer pays the full combined total on the date that
// happens to complete first and nothing on the other.
//
// This module is the ONE chokepoint every date-changing writer calls (inside
// the SAME transaction as the date write) to close that gap: when a member
// of a first-application-invoice group no longer shares the invoice row's
// date, peel that member's own quoted per-visit share
// (recurring_template_overrides.anchored_split_per_visit — the exact
// per-program amount the accept route stamped on EVERY member's own row,
// reserved and promoted alike; see recurring-appointment-seeder.js
// markParentRecurring) off the shared invoice line and give each row its own
// estimated_price. After the split, each visit's own completion bills its
// own amount through the ordinary per-application path — no more shared
// coverage to reason about.
const logger = require('./logger');

function dateOnly(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).split('T')[0].slice(0, 10);
}

function roundMoney(value) {
  return Math.round(Number(value) * 100) / 100;
}

// The per-visit share the accept route stamped on THIS row
// (recurring_template_overrides.anchored_split_per_visit) — provenance only,
// never inferred from a sibling's price or the invoice total.
function anchoredSplitPerVisit(row) {
  let raw = row?.recurring_template_overrides;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { return null; }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const amount = Number(raw.anchored_split_per_visit);
  return amount > 0 ? roundMoney(amount) : null;
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

function hasPositiveSetupFeeLine(lineItems) {
  return lineItems.some((li) => {
    const desc = String(li?.description || '');
    if (!/setup fee/i.test(desc)) return false;
    const qty = li?.quantity != null ? Number(li.quantity) : 1;
    const amt = li?.amount != null ? Number(li.amount) : Number(li?.unit_price) * qty;
    return Number.isFinite(amt) && amt > 0;
  });
}

/**
 * Called after ANY write that changes scheduled_date on a top-of-series (or
 * one-time) scheduled_services row, inside the SAME transaction as that
 * write. Idempotent and side-effect-free unless it actually finds a diverging
 * unpriced sibling to split off — safe to call unconditionally whenever a
 * date-changing writer wants the guarantee, and cheap to skip (an early
 * return) for rows that never touched an estimate accept.
 *
 * @param {import('knex').Knex.Transaction} trx - the caller's OPEN transaction
 * @param {string} scheduledServiceId - the row whose date just changed (post-write id)
 */
async function reconcileFirstApplicationSplitOnDateChange(trx, scheduledServiceId) {
  if (!trx || !scheduledServiceId) return { action: 'skipped', reason: 'missing_args' };
  const moved = await trx('scheduled_services')
    .where({ id: scheduledServiceId })
    .first('id', 'customer_id', 'source_estimate_id', 'recurring_parent_id');
  // Only a top-of-series (or one-time) row can be a first-application
  // invoice's reserved or promoted member — a later CHILD occurrence's date
  // is unrelated to the accept-time split.
  if (!moved || !moved.customer_id || !moved.source_estimate_id || moved.recurring_parent_id) {
    return { action: 'skipped', reason: 'not_estimate_anchor' };
  }

  // Lock every member of this estimate's accept group up front — the split
  // reads and writes several of these rows together and must not race a
  // concurrent completion or a second reschedule of a sibling.
  const members = await trx('scheduled_services')
    .where({ customer_id: moved.customer_id, source_estimate_id: moved.source_estimate_id })
    .whereNull('recurring_parent_id')
    .forUpdate()
    .select('id', 'scheduled_date', 'estimated_price', 'completed_at', 'recurring_template_overrides');
  if (members.length < 2) return { action: 'skipped', reason: 'no_siblings' };

  const InvoiceService = require('./invoice');
  const { isAutoGeneratedPayPerApplicationInvoice } = require('./estimate-first-application-invoice');

  const memberIds = members.map((m) => m.id);
  const draftCandidates = await trx('invoices')
    .whereIn('scheduled_service_id', memberIds)
    // Only when the invoice is still a fully open draft — unsent, unpaid, no
    // PaymentIntent, no payer-statement roll-up, no account credit applied.
    // A sent/viewed/paid invoice already reached the customer with the
    // combined total; re-splitting it now would either strand AR or double
    // the sibling's charge, so it is left untouched (declined, logged).
    .where('status', 'draft')
    .whereNull('paid_at')
    .whereNull('payment_recorded_at')
    .whereNull('stripe_payment_intent_id')
    .whereNull('payer_statement_id')
    .where((qb) => qb.whereNull('credit_applied').orWhere('credit_applied', 0))
    .orderBy('created_at', 'desc')
    // Locked for the rest of this transaction: the read above decides
    // eligibility and the write below recalculates money off that same
    // row — a concurrent send/payment/credit landing in between must not
    // overwrite itself with stale financials.
    .forUpdate()
    .select('*');
  const invoice = draftCandidates.find((inv) => isAutoGeneratedPayPerApplicationInvoice(inv));
  if (!invoice) return { action: 'skipped', reason: 'no_draft_first_application_invoice' };

  const invoiceRow = members.find((m) => String(m.id) === String(invoice.scheduled_service_id));
  // Never touch a completed row's money — a completed invoice-holding visit
  // means the combined amount was already (or is about to be) charged at
  // completion; the invoice's own status guard above already excludes almost
  // every such case, but a same-tick race is closed here too.
  if (!invoiceRow || invoiceRow.completed_at) {
    return { action: 'skipped', reason: 'invoice_row_completed_or_missing' };
  }

  if (InvoiceService._invoiceHasDepositCreditLine(invoice)) {
    logger.warn(`[first-application-sibling-split] estimate ${moved.source_estimate_id}: declining resplit — invoice ${invoice.id} carries a deposit credit line`);
    return { action: 'declined', reason: 'deposit_credit_present', invoiceId: invoice.id };
  }

  const lineItems = parseLineItems(invoice.line_items);
  if (!lineItems) return { action: 'skipped', reason: 'unreadable_line_items', invoiceId: invoice.id };

  if (hasPositiveSetupFeeLine(lineItems)) {
    logger.warn(`[first-application-sibling-split] estimate ${moved.source_estimate_id}: declining resplit — invoice ${invoice.id} carries a one-time setup-fee line`);
    return { action: 'declined', reason: 'setup_fee_present', invoiceId: invoice.id };
  }

  const { lineIsBaseApplication } = InvoiceService;
  const lineIndex = lineItems.findIndex((li) => {
    if (!lineIsBaseApplication(li)) return false;
    const qty = li?.quantity != null ? Number(li.quantity) : 1;
    const amt = li?.amount != null ? Number(li.amount) : Number(li?.unit_price) * qty;
    return Number.isFinite(amt) && amt > 0;
  });
  if (lineIndex === -1) return { action: 'skipped', reason: 'no_first_application_line', invoiceId: invoice.id };

  const invoiceDate = dateOnly(invoiceRow.scheduled_date);
  const siblings = members
    .filter((m) => String(m.id) !== String(invoiceRow.id))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));

  let remaining = roundMoney(lineItems[lineIndex].amount ?? lineItems[lineIndex].unit_price);
  const splits = [];
  const declines = [];
  for (const sib of siblings) {
    // Never touch a completed sibling's money.
    if (sib.completed_at) continue;
    // Already split (or never unpriced to begin with) — idempotent no-op.
    // This is also what makes a move BACK to the same day a no-op: once
    // split, each row bills its own amount regardless of date, so there is
    // nothing left to peel and nothing to double-reduce.
    if (sib.estimated_price != null) continue;
    // Still on the same trip as the invoice row — nothing has diverged.
    if (dateOnly(sib.scheduled_date) === invoiceDate) continue;
    const share = anchoredSplitPerVisit(sib);
    if (!(share > 0)) {
      declines.push({ id: sib.id, reason: 'no_anchored_split' });
      continue;
    }
    if (share > remaining) {
      declines.push({ id: sib.id, reason: 'line_amount_insufficient' });
      continue;
    }
    remaining = roundMoney(remaining - share);
    splits.push({ id: sib.id, amount: share });
  }

  if (declines.length) {
    logger.warn(`[first-application-sibling-split] estimate ${moved.source_estimate_id}: declined ${declines.length} sibling(s) on invoice ${invoice.id}: ${JSON.stringify(declines)}`);
  }
  if (!splits.length) {
    return {
      action: 'skipped',
      reason: declines.length ? 'ineligible_siblings' : 'no_diverging_unpriced_sibling',
      invoiceId: invoice.id,
      declines,
    };
  }

  const updatedLineItems = lineItems.slice();
  updatedLineItems[lineIndex] = { ...updatedLineItems[lineIndex], unit_price: remaining, amount: remaining };

  const customer = await trx('customers').where({ id: invoice.customer_id }).first('property_type');
  const financials = await InvoiceService._internals.calculateUpdateFinancials({
    lineItems: updatedLineItems,
    customer,
    invoice,
    taxRate: invoice.tax_rate,
  });

  const invoiceUpdated = await trx('invoices')
    .where({ id: invoice.id, status: 'draft' })
    .whereNull('paid_at')
    .whereNull('payment_recorded_at')
    .whereNull('stripe_payment_intent_id')
    .whereNull('payer_statement_id')
    .where((qb) => qb.whereNull('credit_applied').orWhere('credit_applied', 0))
    .update({ ...financials, updated_at: new Date() });
  if (!invoiceUpdated) {
    logger.error(`[first-application-sibling-split] estimate ${moved.source_estimate_id}: invoice ${invoice.id} changed state concurrently — resplit aborted for this pass`);
    return { action: 'skipped', reason: 'invoice_changed_concurrently', invoiceId: invoice.id };
  }

  await trx('scheduled_services').where({ id: invoiceRow.id }).update({ estimated_price: remaining });
  for (const split of splits) {
    await trx('scheduled_services').where({ id: split.id }).update({ estimated_price: split.amount });
  }

  const splitDescription = splits.map((s) => `visit ${s.id} → $${s.amount.toFixed(2)}`).join(', ');
  // Audit-only — in its OWN savepoint, separate from the money writes above:
  // on Postgres a failed statement aborts the whole transaction it ran in
  // until something rolls it back, so a plain try/catch around this insert
  // would not actually recover — it would leave the split's own writes
  // committed-but-unreachable (every later statement on this connection,
  // including COMMIT, would fail). A savepoint lets a log failure roll back
  // ONLY the log row while the split itself stays intact.
  try {
    await trx.transaction((logTrx) => logTrx('activity_log').insert({
      customer_id: moved.customer_id,
      action: 'first_application_invoice_resplit',
      description: `Estimate #${moved.source_estimate_id}: a same-trip visit moved to a different day than the shared first-application invoice (${invoice.invoice_number || invoice.id}). Split the "${lineItems[lineIndex].description}" line: visit ${invoiceRow.id} keeps $${remaining.toFixed(2)}; ${splitDescription}.`,
      metadata: JSON.stringify({
        estimateId: moved.source_estimate_id,
        invoiceId: invoice.id,
        invoiceRowId: invoiceRow.id,
        remaining,
        splits,
        declines,
      }),
    }));
  } catch (e) {
    logger.warn(`[first-application-sibling-split] activity_log insert failed (non-blocking): ${e.message}`);
  }

  logger.info(`[first-application-sibling-split] estimate ${moved.source_estimate_id}: split invoice ${invoice.id} — visit ${invoiceRow.id} keeps $${remaining.toFixed(2)}, ${splits.length} sibling(s) split off (${splitDescription})`);
  return { action: 'split', invoiceId: invoice.id, invoiceRowId: invoiceRow.id, remaining, splits, declines };
}

/**
 * Same as reconcileFirstApplicationSplitOnDateChange, but never blocks the
 * caller's own write: runs the reconcile in its own SAVEPOINT (a nested
 * transaction off the caller's trx), so a failure inside it rolls back only
 * the split's own statements and leaves the caller's transaction perfectly
 * usable for whatever it does next. A plain try/catch around the direct call
 * does NOT achieve this on Postgres: the first failing statement aborts the
 * WHOLE transaction it ran in, and every later statement on that connection
 * — including the caller's own COMMIT — fails until something rolls it back.
 * Every date-changing writer that has more work to do after this call (or
 * that simply wants the guarantee) should call this, not the plain function,
 * directly.
 */
async function reconcileFirstApplicationSplitOnDateChangeSafely(trx, scheduledServiceId, context = '') {
  try {
    return await trx.transaction((nested) => reconcileFirstApplicationSplitOnDateChange(nested, scheduledServiceId));
  } catch (err) {
    logger.error(`[first-application-sibling-split] reconcile failed for ${scheduledServiceId}${context ? ` (${context})` : ''} — caller's own write still commits: ${err.message}`);
    return { action: 'error', reason: err.message };
  }
}

module.exports = {
  reconcileFirstApplicationSplitOnDateChange,
  reconcileFirstApplicationSplitOnDateChangeSafely,
  anchoredSplitPerVisit,
  dateOnly,
};
