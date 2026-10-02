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
// the resolver can consult (all FOR SHARE) - and the live Bill-To decision made under them, so a
// payer assignment serializes behind this decision instead of racing it. null = self-pay.
async function liveOwnerLocked(trx, invoice, visitId) {
  await trx('customers').where({ id: invoice.customer_id }).forShare().first('id');
  const visit = await trx('scheduled_services').where({ id: visitId }).forShare().first('id', 'payer_id');
  const customer = await trx('customers').where({ id: invoice.customer_id }).first('payer_id');
  const payerIds = [...new Set([visit?.payer_id, customer?.payer_id].filter(Boolean).map(String))];
  if (payerIds.length) await trx('payers').whereIn('id', payerIds).orderBy('id').forShare().select('id');
  const resolved = await require('./payer').resolveForInvoice({
    database: trx, customerId: invoice.customer_id, scheduledServiceId: visitId, throwOnError: true,
  });
  return resolved?.payerId || null;
}

const linkedVisitOf = (invoice, trx) => require('./invoice').linkedScheduledServiceId(invoice, trx);

// The visits the withdrawal above will lock for these customers (the visit each still-collectible
// visit-linked invoice rides). A caller that takes a payer row FOR UPDATE before the withdrawal
// (payer activation) locks them FOR SHARE first, so it never waits on a visit a Bill-To editor
// already holds while that editor waits on the payer row.
async function linkedVisitIdsForCustomers(trx, customerIds) {
  if (!customerIds.length) return [];
  const base = () => visitLinkedBase(trx, NOT_WITHDRAWABLE).whereIn('customer_id', customerIds);
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
    const [, stampedPayer, ...flags] = invoice.scheduled_send_error.split(':');
    const flagSuffix = flags.length ? `:${flags.join(':')}` : '';
    if (live) {
      if (String(live) !== stampedPayer) {
        await trx('invoices').where({ id: invoice.id, status: invoice.status, scheduled_send_error: invoice.scheduled_send_error })
          .update({ scheduled_send_error: `payer_billed:${live}${flagSuffix}`, updated_at: trx.fn.now() });
      }
      continue;
    }
    const parked = flags.includes('park');
    const requeue = flags.includes('queued') && invoice.status === 'draft';
    const moved = await trx('invoices')
      .where({ id: invoice.id, status: invoice.status, scheduled_send_error: invoice.scheduled_send_error }).whereNull('payer_id')
      .update(requeue
        ? { status: 'scheduled', scheduled_send_at: trx.fn.now(), scheduled_send_attempts: 0, scheduled_send_error: null, updated_at: trx.fn.now() }
        : { scheduled_send_error: parked ? STALE_SEND_PARK_ERROR : null, updated_at: trx.fn.now() });
    if (!moved) continue;
    await resumeDunningPausedByWithdrawal(trx, invoice.id);
    released += 1;
  }
  return released;
}

// The refusal fence, run BEFORE the writer's first Stripe cancel: a visit-linked invoice whose
// send claim is held, whose bank debit is captured, or whose charge is unresolved (an in-flight
// or ambiguous saved-card attempt, an orphan charge) is money or delivery in motion - the Bill-To
// change is refused (the caller's 409) instead of handing that debt to AP underneath it. The
// charge fence is read-only here (nothing is released or promoted).
async function linkedInvoiceChargeInFlight(database, scope = {}) {
  if (scopeIsEmpty(scope)) return false;
  const { isCollectionPendingFenceError } = require('./invoice-helpers');
  const candidates = await applyScope(database, visitLinkedBase(database, TERMINAL), scope)
    .where((q) => q.whereNull('scheduled_send_error').orWhereNot('scheduled_send_error', 'like', 'payer_billed:%'))
    .orderBy('id')
    .select('id', 'status', 'stripe_payment_intent_id');
  for (const invoice of candidates) {
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

module.exports = { linkedVisitIdsForCustomers, withdrawLinkedInvoicesForOwner, reconcileLinkedInvoices, linkedInvoiceChargeInFlight };
