'use strict';
// Bill-To withdrawal for invoices that ride a VISIT without a combined-visit packet.
//
// The packet path (visit-completion-packets.js withdrawPacketInvoicesForOwner) withdraws a
// self-pay combined-visit invoice from the homeowner when a third-party payer takes over its
// visit. An invoice minted after completion from the service record alone (`service_record_id`
// set, `scheduled_service_id` and `payer_id` NULL), or one linked straight to the visit
// (`scheduled_service_id`), has no packet, so that path never saw it: the homeowner kept a live
// pay link for a bill that now belongs to AP.
//
// This module is the same transition for those rows, and it is called FROM the three packet
// entry points (withdrawPacketInvoicesForOwner, reconcileWithdrawnPacketInvoices,
// packetInvoiceSendInFlight), so every writer that already runs them - the customer Bill-To
// route, the job Bill-To route, payer activation, the customer merge, unvoid - covers these
// invoices with the same locks, in the same transaction, at the same point. The withdrawal
// itself is the packet path's own invoice-level function (withdrawInvoiceFromCustomer):
// homeowner credit returned, the invoice off the send queue, `payer_billed:<payer>` stamped,
// armed dunning paused. Every pay entry point already refuses a stamped invoice
// (invoiceWithdrawnFromCustomer / assertInvoiceCollectible).
//
// COMMS-FREE (owner directive 2026-09-08): nothing here sends or queues a customer message. The
// only send-adjacent effect is the release below putting an invoice that was waiting in the send
// queue BACK in it when the payer is removed - exactly what the packet release does.
//
// Not covered, on purpose: a visit-group packet (the packet path owns it), an annual-prepay
// invoice (the renewal fence owns it), a statement-accrued invoice, and an invoice with no visit
// linkage at all (a manual or project invoice): there is no visit to resolve a payer for.
const TERMINAL = ['void', 'refunded', 'canceled', 'cancelled', 'paid', 'prepaid'];
const NOT_WITHDRAWABLE = [...TERMINAL, 'processing'];

function scopeIsEmpty({ customerId, scheduledServiceId, scheduledServiceIds, payerId, invoiceId }) {
  return !customerId && !scheduledServiceId && !(scheduledServiceIds && scheduledServiceIds.length) && !payerId && !invoiceId;
}

// Invoices that ride a visit with no packet, no statement and no annual-prepay term.
function visitLinkedBase(trx, statusesExcluded) {
  return trx('invoices').whereNotIn('status', statusesExcluded)
    .whereNull('payer_id').whereNull('payer_statement_id')
    .whereNull('visit_completion_packet_id').whereNull('annual_prepay_term_id')
    .where((q) => q.whereNotNull('scheduled_service_id').orWhereNotNull('service_record_id'));
}

// A SUPERSET prefilter: the live resolver, run per invoice under held rows, is the authority.
function applyScope(trx, query, { customerId, scheduledServiceId, scheduledServiceIds, payerId, invoiceId }) {
  const linkedTo = (q, visits) => q.whereIn('scheduled_service_id', visits())
    .orWhere((x) => x.whereNull('scheduled_service_id')
      .whereIn('service_record_id', trx('service_records').whereIn('scheduled_service_id', visits()).select('id')));
  if (invoiceId) query.where({ id: invoiceId });
  if (customerId) query.where({ customer_id: customerId });
  if (scheduledServiceId) query.where((q) => linkedTo(q, () => [scheduledServiceId]));
  if (scheduledServiceIds && scheduledServiceIds.length) query.where((q) => linkedTo(q, () => scheduledServiceIds));
  if (payerId) {
    query.where((q) => q.whereIn('customer_id', trx('customers').where({ payer_id: payerId }).select('id'))
      .orWhere((x) => linkedTo(x, () => trx('scheduled_services').where({ payer_id: payerId }).select('id'))));
  }
  return query;
}

// The ownership rows taken in the packet path's order - customer, visit, then every payer row
// the resolver can consult (all FOR SHARE) - so a payer assignment serializes behind the decision
// instead of racing it. Returns the visit row.
async function lockOwnershipRows(trx, invoice, visitId) {
  await trx('customers').where({ id: invoice.customer_id }).forShare().first('id');
  const visit = await trx('scheduled_services').where({ id: visitId }).forShare().first('id', 'payer_id', 'self_pay_override');
  const customer = await trx('customers').where({ id: invoice.customer_id }).first('payer_id');
  const payerIds = [...new Set([visit?.payer_id, customer?.payer_id].filter(Boolean).map(String))];
  if (payerIds.length) await trx('payers').whereIn('id', payerIds).orderBy('id').forShare().select('id');
  return visit && { ...visit, customer_payer_id: customer?.payer_id ?? null };
}

// The same visit row without taking locks, for the read-only paths.
async function visitForOwnerJudgement(database, invoice, visitId) {
  const visit = await database('scheduled_services').where({ id: visitId }).first('id', 'payer_id', 'self_pay_override');
  const customer = await database('customers').where({ id: invoice.customer_id }).first('payer_id');
  return visit && { ...visit, customer_payer_id: customer?.payer_id ?? null };
}

// The live Bill-To decision, made under those rows. null = self-pay.
async function liveOwnerLocked(trx, invoice, visitId) {
  await lockOwnershipRows(trx, invoice, visitId);
  const resolved = await require('./payer').resolveForInvoice({
    database: trx, customerId: invoice.customer_id, scheduledServiceId: visitId, throwOnError: true,
  });
  return resolved?.payerId || null;
}

const linkedVisitOf = (invoice, trx) => require('./invoice').linkedScheduledServiceId(invoice, trx);

// The visits the fence, withdrawal and release will lock for these customers: the visit every
// non-terminal visit-linked invoice rides (processing and already-stamped ones included, since the
// fence judges the first and the release re-judges the second). A caller that takes a payer row FOR UPDATE before the withdrawal
// (payer activation) locks them FOR SHARE first, so it never waits on a visit a Bill-To editor
// already holds while that editor waits on the payer row.
async function linkedVisitIdsForCustomers(trx, customerIds) {
  if (!customerIds.length) return [];
  const base = () => visitLinkedBase(trx, TERMINAL).whereIn('customer_id', customerIds);
  const direct = await base().whereNotNull('scheduled_service_id').pluck('scheduled_service_id');
  const viaRecord = await trx('service_records').whereNotNull('scheduled_service_id')
    .whereIn('id', base().whereNull('scheduled_service_id').select('service_record_id')).pluck('scheduled_service_id');
  return [...new Set([...direct, ...viaRecord].map(String))];
}

// Withdraw every unpaid, still-collectible visit-linked invoice the scope's live owner now makes
// payer-owned. Returns the ids withdrawn.
async function withdrawLinkedInvoicesForOwner(trx, scope = {}) {
  if (scopeIsEmpty(scope)) return [];
  const { withdrawInvoiceFromCustomer } = require('./visit-completion-packets');
  const candidates = await applyScope(trx, visitLinkedBase(trx, NOT_WITHDRAWABLE), scope)
    .where((q) => q.whereNull('scheduled_send_error').orWhereNot('scheduled_send_error', 'like', 'payer_billed:%'))
    .orderBy('id')
    .select('id', 'customer_id', 'scheduled_service_id', 'service_record_id');
  const withdrawn = [];
  for (const invoice of candidates) {
    const visitId = await linkedVisitOf(invoice, trx);
    if (!visitId) continue;
    const owner = await liveOwnerLocked(trx, invoice, visitId);
    if (!owner) continue;
    // Re-judged on the HELD invoice row: it may have settled, been claimed for a processing
    // payment or withdrawn since the candidate read.
    const held = await trx('invoices').where({ id: invoice.id }).forUpdate().first('status', 'payer_id', 'payer_statement_id', 'scheduled_send_error');
    if (!held || held.payer_id || held.payer_statement_id || NOT_WITHDRAWABLE.includes(held.status)
      || /^payer_billed:/.test(String(held.scheduled_send_error || ''))) continue;
    if (await withdrawInvoiceFromCustomer(trx, { invoiceId: invoice.id, payerId: owner, markQueued: true })) withdrawn.push(invoice.id);
  }
  return withdrawn;
}

// The mirror, for ownership-REMOVING transitions (payer cleared, deactivated, self-pay pin set):
// a stamped invoice whose live owner is nobody is released - the stamp clears, an invoice that
// was waiting in the send queue goes back into it, the dunning the withdrawal paused resumes. A
// stamp whose payer changed follows the payer that owns the visit now. Returns the released count.
async function reconcileLinkedInvoices(trx, scope = {}) {
  if (scopeIsEmpty(scope)) return 0;
  const { resumeDunningPausedByWithdrawal, INVOICE_TERMINAL_STATUSES } = require('./visit-completion-packets');
  const { STALE_SEND_PARK_ERROR } = require('./invoice-helpers');
  const query = visitLinkedBase(trx, INVOICE_TERMINAL_STATUSES).where('scheduled_send_error', 'like', 'payer_billed:%');
  if (scope.payerId) {
    // Any flag combination for this payer; the visit/customer prefilter below does not apply.
    query.where((q) => q.where('scheduled_send_error', `payer_billed:${scope.payerId}`)
      .orWhere('scheduled_send_error', 'like', `payer_billed:${scope.payerId}:%`));
  }
  applyScope(trx, query, { ...scope, payerId: null });
  const stamped = await query.orderBy('id')
    .select('id', 'status', 'customer_id', 'scheduled_service_id', 'service_record_id', 'scheduled_send_error');
  let released = 0;
  for (const invoice of stamped) {
    const visitId = await linkedVisitOf(invoice, trx);
    if (!visitId) continue;
    const live = await liveOwnerLocked(trx, invoice, visitId);
    // `payer_billed:<id>[:park][:queued][:at=<iso send time>][:m=<marker>]` - the marker is the
    // verbatim send-state marker the withdrawal replaced and may itself contain ':'.
    const stamp = invoice.scheduled_send_error;
    const markerAt = stamp.indexOf(':m=');
    const priorMarker = markerAt >= 0 ? stamp.slice(markerAt + 3) : null;
    const withoutMarker = markerAt >= 0 ? stamp.slice(0, markerAt) : stamp;
    const sendAtAt = withoutMarker.indexOf(':at=');
    const priorSendAt = sendAtAt >= 0 ? new Date(withoutMarker.slice(sendAtAt + 4)) : null;
    const [, stampedPayer, ...flags] = (sendAtAt >= 0 ? withoutMarker.slice(0, sendAtAt) : withoutMarker).split(':');
    if (live) {
      if (String(live) !== stampedPayer) {
        await trx('invoices').where({ id: invoice.id, status: invoice.status, scheduled_send_error: stamp })
          .update({ scheduled_send_error: stamp.replace(/^payer_billed:[^:]+/, `payer_billed:${live}`), updated_at: trx.fn.now() });
      }
      continue;
    }
    const parked = flags.includes('park');
    const requeue = flags.includes('queued') && invoice.status === 'draft';
    // The marker goes back exactly as it was, so a requeued invoice stays email-only.
    const restored = parked ? STALE_SEND_PARK_ERROR : priorMarker;
    const moved = await trx('invoices')
      .where({ id: invoice.id, status: invoice.status, scheduled_send_error: stamp }).whereNull('payer_id')
      .update(requeue
        // Back at the operator's own time; "now" only when that time has already passed.
        ? { status: 'scheduled', scheduled_send_at: priorSendAt && priorSendAt > new Date() ? priorSendAt : trx.fn.now(), scheduled_send_attempts: 0, scheduled_send_error: restored, updated_at: trx.fn.now() }
        : { scheduled_send_error: restored, updated_at: trx.fn.now() });
    if (!moved) continue;
    await resumeDunningPausedByWithdrawal(trx, invoice.id);
    released += 1;
  }
  return released;
}

// Can this Bill-To change move the invoice's effective owner? Decided from the visit row, since
// the new payer is not written yet when the fence runs. A change to the visit's own Bill-To always
// can; a change to the customer default cannot reach a visit that names its own payer or is pinned
// self-pay; a payer activation reaches a visit that names that payer, or one inheriting a customer
// default that IS that payer.
function ownerCouldChange(scope, visit) {
  if (scope.scheduledServiceId || (scope.scheduledServiceIds && scope.scheduledServiceIds.length) || scope.invoiceId) return true;
  if (!visit) return false;
  if (visit.payer_id) return Boolean(scope.payerId) && String(visit.payer_id) === String(scope.payerId);
  if (visit.self_pay_override === true) return false;
  // Inheriting the customer default: a payer activation reaches it only when that default IS the
  // activating payer; a default-payer change always does.
  if (scope.payerId) return visit.customer_payer_id != null && String(visit.customer_payer_id) === String(scope.payerId);
  return true;
}

// The visit-linked invoices whose OWN checkout PaymentIntent this Bill-To change invalidates: the
// owner can move (same rule as the fence) and the invoice is one the withdrawal will take. Their
// client secrets must stop working, because a customer can confirm a pre-issued secret straight
// with Stripe, past every pay-page check.
async function linkedSessionInvoiceIds(database, scope = {}, ownerScope = scope) {
  const ids = new Set();
  if (scopeIsEmpty(scope)) return ids;
  const candidates = await applyScope(database, visitLinkedBase(database, TERMINAL), scope)
    .whereNotNull('stripe_payment_intent_id')
    .where((q) => q.whereNull('scheduled_send_error').orWhereNot('scheduled_send_error', 'like', 'payer_billed:%'))
    .select('id', 'customer_id', 'scheduled_service_id', 'service_record_id');
  for (const candidate of candidates) {
    const visitId = await linkedVisitOf(candidate, database);
    if (!visitId) continue;
    const visit = await visitForOwnerJudgement(database, candidate, visitId);
    if (ownerCouldChange(ownerScope, visit)) ids.add(String(candidate.id));
  }
  return ids;
}

// The refusal fence, run BEFORE the writer's first Stripe cancel: a visit-linked invoice whose
// owner this change would move and whose send claim is held, whose bank debit is captured, or whose
// charge is unresolved (an in-flight or ambiguous saved-card attempt, an orphan charge) is money or
// delivery in motion - the Bill-To change is refused (the caller's 409) instead of handing that debt
// to AP underneath it. The charge fence is read-only here (nothing is released or promoted).
//
// Inside a writer transaction the fence also LOCKS what it judges, in the packet path's order
// (customer, visit, payer rows FOR SHARE, then the invoice FOR UPDATE) and holds it to commit: a queue
// sender's claim flip (invoice.js claimInvoiceForSend / claimDueScheduledInvoiceForSend) and a
// saved-card claim (stripe.js claimInvoiceSavedCardCharge) both write or lock the invoice row, so
// neither can slip in between this check and the withdrawal; one that already committed is seen here
// as status 'sending' or an unresolved attempt.
async function linkedInvoiceChargeInFlight(database, scope = {}) {
  if (scopeIsEmpty(scope)) return false;
  const { isCollectionPendingFenceError } = require('./invoice-helpers');
  const locking = database.isTransaction === true;
  const candidates = await applyScope(database, visitLinkedBase(database, TERMINAL), scope)
    .where((q) => q.whereNull('scheduled_send_error').orWhereNot('scheduled_send_error', 'like', 'payer_billed:%'))
    .orderBy('id')
    .select('id', 'customer_id', 'scheduled_service_id', 'service_record_id', 'status', 'stripe_payment_intent_id');
  for (const candidate of candidates) {
    const visitId = await linkedVisitOf(candidate, database);
    if (!visitId) continue;
    const visit = locking
      ? await lockOwnershipRows(database, candidate, visitId)
      : await visitForOwnerJudgement(database, candidate, visitId);
    if (!ownerCouldChange(scope, visit)) continue;
    // Re-read under the invoice row lock: this is the row the claims race for.
    const invoice = locking
      ? await database('invoices').where({ id: candidate.id }).forUpdate()
        .first('id', 'status', 'payer_id', 'payer_statement_id', 'scheduled_send_error', 'stripe_payment_intent_id')
      : candidate;
    if (!invoice || invoice.payer_id || invoice.payer_statement_id || TERMINAL.includes(invoice.status)
      || /^payer_billed:/.test(String(invoice.scheduled_send_error || ''))) continue;
    if (invoice.status === 'sending') return true;
    if (invoice.status === 'processing' && invoice.stripe_payment_intent_id) return true;
    try {
      await require('./stripe').assertNoInvoiceChargeReconciliationPending(invoice.id, database, { readOnly: true });
    } catch (err) {
      if (isCollectionPendingFenceError(err)) return true;
      throw err;
    }
  }
  return false;
}

module.exports = { linkedSessionInvoiceIds, linkedVisitIdsForCustomers, withdrawLinkedInvoicesForOwner, reconcileLinkedInvoices, linkedInvoiceChargeInFlight };
