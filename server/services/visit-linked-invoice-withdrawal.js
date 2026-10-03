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
// Lock order: scope of this PR
//   The Bill-To writers this module serves (the job and customer Bill-To routes, series children, payer
//   activation, the customer merge and its undo, unvoid) take customer -> visit -> payer -> invoice, and
//   this module's fence, withdrawal and release run inside them in that order. The charge, account-credit,
//   void, refund and settlement paths are UNCHANGED by this PR and may take the invoice first. A deadlock
//   between the two families is detected by PostgreSQL, which aborts one request; the aborted request is
//   retryable. Reordering the money paths is deliberately out of scope here (owner ruling 2026-10-03).
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
    // An annual-prepay invoice is identified by the TERM's own link too: some carry a visit link and a NULL
    // annual_prepay_term_id (annual-prepay-renewals.js), and a visit's payer must never withdraw the year.
    .whereNotIn('id', trx('annual_prepay_terms').whereNotNull('prepay_invoice_id').select('prepay_invoice_id'))
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

// ONE answer to "who owns this invoice, before and after this Bill-To change?"
//
// The Bill-To resolver (payer.resolveForInvoice) reads, in order: the visit's own payer, else - unless
// the visit is pinned self-pay - the customer's default payer; and a payer that is inactive (or gone)
// is self-pay, with NO fall-through to the next level. ownerOf mirrors exactly that over a state read
// from rows (and a pending write laid over it), and ownerTransitions applies it per invoice. Every
// consumer below - the in-flight fence, the single-checkout invalidation (pay-combined), the
// withdrawal and the release - reads the same result, and every writer's route runs them whenever an
// invoice MOVED, never on whether a payer field was submitted:
//
//   mode 'pre'  (before the write): before = owner now; after = owner with `pending` laid over it.
//               pending = { visitPatch: {visitIds, payer_id?, self_pay_override?},
//                           customerPatch: {customerId, payer_id},
//                           payerPatch: {id, active} }
//               With no pending the new state is unknown and every candidate counts as moved.
//               The before-owner is remembered per transaction (first write wins).
//   mode 'post' (after the write, inside the same transaction): after = owner now, read under the
//               ownership rows; before = the remembered pre-write owner, else the owner the invoice
//               itself records (unstamped = self-pay, stamped = the payer named by the stamp).
const plans = new WeakMap(); // transaction -> Map(invoiceId -> before owner)

const idOrNull = (value) => (value == null || value === '' ? null : String(value));

function ownerOf(state, activePayerIds) {
  const candidate = idOrNull(state.visitPayerId) || (state.selfPay ? null : idOrNull(state.customerPayerId));
  return candidate && activePayerIds.has(candidate) ? candidate : null;
}

// The pending write laid over a state read from rows.
function withPending(state, { visitId, customerId }, pending) {
  const next = { ...state };
  const visitPatch = pending?.visitPatch;
  if (visitPatch && (visitPatch.visitIds || []).map(String).includes(String(visitId))) {
    if ('payer_id' in visitPatch) next.visitPayerId = idOrNull(visitPatch.payer_id);
    if ('self_pay_override' in visitPatch) next.selfPay = visitPatch.self_pay_override === true;
  }
  const customerPatch = pending?.customerPatch;
  if (customerPatch && String(customerPatch.customerId) === String(customerId)) next.customerPayerId = idOrNull(customerPatch.payer_id);
  return next;
}

// The rows the resolver reads, in the packet path's lock order when `lock` (customer, visit, then
// every payer row FOR SHARE), so a payer assignment serializes behind the decision instead of racing it.
async function readOwnerState(database, invoice, visitId, { lock, pending }) {
  if (lock) await database('customers').where({ id: invoice.customer_id }).forShare().first('id');
  const visitRow = await (lock ? database('scheduled_services').where({ id: visitId }).forShare() : database('scheduled_services').where({ id: visitId }))
    .first('id', 'customer_id', 'payer_id', 'self_pay_override');
  const customer = await database('customers').where({ id: invoice.customer_id }).first('payer_id');
  // A visit of another customer is ignored by the resolver.
  const visit = visitRow && String(visitRow.customer_id) === String(invoice.customer_id) ? visitRow : null;
  const held = [...new Set([visitRow?.payer_id, customer?.payer_id].filter(Boolean).map(String))];
  const pendingPayerIds = [pending?.visitPatch?.payer_id, pending?.customerPatch?.payer_id, pending?.payerPatch?.id]
    .filter(Boolean).map(String);
  const looked = [...new Set([...held, ...pendingPayerIds])];
  // The payer rows the answer depends on - the ones referenced now AND the ones the pending write is
  // about to reference - are taken FOR SHARE (one ordered statement) BEFORE their active flag is read,
  // so a concurrent deactivation waits for this transaction and cannot change the answer between the
  // plan (the fence, the checkout cancel) and the write.
  if (lock && looked.length) await database('payers').whereIn('id', looked).orderBy('id').forShare().select('id');
  const activeBefore = new Set(looked.length
    ? (await database('payers').whereIn('id', looked).select('id', 'active')).filter((p) => p.active !== false).map((p) => String(p.id))
    : []);
  // The pending payer write applies to the AFTER view only.
  const activeAfter = new Set(activeBefore);
  if (pending?.payerPatch) {
    const patched = String(pending.payerPatch.id);
    if (pending.payerPatch.active === false) activeAfter.delete(patched);
    else if (pending.payerPatch.active === true) activeAfter.add(patched);
  }
  return {
    state: { visitPayerId: visit?.payer_id ?? null, selfPay: visit?.self_pay_override === true, customerPayerId: customer?.payer_id ?? null },
    activeBefore,
    activeAfter,
  };
}

const linkedVisitOf = (invoice, trx) => require('./invoice').linkedScheduledServiceId(invoice, trx);
const stampedPayerOf = (error) => /^payer_billed:([^:]+)/.exec(String(error || ''))?.[1] || null;

async function ownerTransitions(database, scope = {}, { mode = 'post', pending = null, lock = false, stamped = 'unstamped', stampedForPayer = null } = {}) {
  if (scopeIsEmpty(scope)) return [];
  const query = applyScope(database, visitLinkedBase(database, TERMINAL), stamped === 'stamped' ? { ...scope, payerId: null } : scope);
  if (stamped === 'stamped') {
    query.where('scheduled_send_error', 'like', 'payer_billed:%');
    if (stampedForPayer) {
      query.where((q) => q.where('scheduled_send_error', `payer_billed:${stampedForPayer}`)
        .orWhere('scheduled_send_error', 'like', `payer_billed:${stampedForPayer}:%`));
    }
  } else {
    query.where((q) => q.whereNull('scheduled_send_error').orWhereNot('scheduled_send_error', 'like', 'payer_billed:%'));
  }
  const rows = await query.orderBy('id')
    .select('id', 'customer_id', 'scheduled_service_id', 'service_record_id', 'status', 'stripe_payment_intent_id', 'scheduled_send_error');
  const plan = database.isTransaction === true ? (plans.get(database) || plans.set(database, new Map()).get(database)) : null;
  const out = [];
  for (const row of rows) {
    const visitId = await linkedVisitOf(row, database);
    if (!visitId) continue;
    const { state, activeBefore, activeAfter } = await readOwnerState(database, row, visitId, { lock, pending: mode === 'pre' ? pending : null });
    const ids = { visitId, customerId: row.customer_id };
    let beforeOwner;
    let afterOwner;
    let moved;
    if (mode === 'pre') {
      beforeOwner = ownerOf(state, activeBefore);
      afterOwner = pending ? ownerOf(withPending(state, ids, pending), activeAfter) : undefined;
      moved = pending ? beforeOwner !== afterOwner : true;
      if (plan && !plan.has(String(row.id))) plan.set(String(row.id), beforeOwner);
    } else {
      afterOwner = ownerOf(state, activeBefore);
      beforeOwner = plan && plan.has(String(row.id)) ? plan.get(String(row.id)) : (stampedPayerOf(row.scheduled_send_error));
      moved = beforeOwner !== afterOwner;
    }
    out.push({
      invoiceId: row.id, customerId: row.customer_id, visitId, status: row.status,
      stripePaymentIntentId: row.stripe_payment_intent_id, scheduledSendError: row.scheduled_send_error,
      beforeOwner, afterOwner, moved,
    });
  }
  return out;
}

// The VISIT's own effective owner before and after a pending Bill-To write, the one answer the job
// route keys its whole pipeline on (the combined-packet release and withdrawal as well as the
// visit-linked invoices'): did who pays for these visits move, and to a payer?
async function visitOwnerTransitions(database, visitIds, { pending = null, lock = false } = {}) {
  const ids = [...new Set((visitIds || []).filter(Boolean).map(String))].sort();
  if (!ids.length) return [];
  const visits = await database('scheduled_services').whereIn('id', ids).orderBy('id').select('id', 'customer_id');
  const out = [];
  for (const visit of visits) {
    const { state, activeBefore, activeAfter } = await readOwnerState(database, { customer_id: visit.customer_id }, visit.id, { lock, pending });
    const beforeOwner = ownerOf(state, activeBefore);
    const afterOwner = pending ? ownerOf(withPending(state, { visitId: visit.id, customerId: visit.customer_id }, pending), activeAfter) : undefined;
    out.push({ visitId: visit.id, beforeOwner, afterOwner, moved: pending ? beforeOwner !== afterOwner : true });
  }
  return out;
}

// Remember the owner of every visit-linked invoice in scope BEFORE a write that changes who pays,
// for a writer with nothing to refuse at that point: the withdrawal after the write then acts on what
// moved, not on every invoice that merely resolves to a payer now (an invoice with no remembered
// owner is judged against what it records: self-pay, or the payer named by its stamp).
async function recordOwnerPlan(trx, scope, pending = null, { lock = false } = {}) {
  await ownerTransitions(trx, scope, { mode: 'pre', pending, lock, stamped: 'unstamped' });
}

// Take the ownership rows a later fence, withdrawal or release will read (customer, visit, then every
// payer row, all FOR SHARE) for ONE invoice, without judging anything: a writer that is about to
// update an invoice row (unvoid) takes them first, so it is never holding the invoice while waiting on a
// payer row that a payer writer holds and wants the invoice for.
async function lockLinkedOwnershipRows(trx, invoice) {
  const visitId = await linkedVisitOf(invoice, trx);
  if (!visitId) return;
  await readOwnerState(trx, invoice, visitId, { lock: true, pending: null });
}

// The visits the fence, withdrawal and release will lock for these customers: the visit every
// non-terminal visit-linked invoice rides (processing and already-stamped ones included, since the
// fence judges the first and the release re-judges the second). A caller that takes a payer row FOR
// UPDATE before the withdrawal (payer activation) locks them FOR SHARE first, so it never waits on a
// visit a Bill-To editor already holds while that editor waits on the payer row.
async function linkedVisitIdsForCustomers(trx, customerIds) {
  if (!customerIds.length) return [];
  const base = () => visitLinkedBase(trx, TERMINAL).whereIn('customer_id', customerIds);
  const direct = await base().whereNotNull('scheduled_service_id').pluck('scheduled_service_id');
  const viaRecord = await trx('service_records').whereNotNull('scheduled_service_id')
    .whereIn('id', base().whereNull('scheduled_service_id').select('service_record_id')).pluck('scheduled_service_id');
  return [...new Set([...direct, ...viaRecord].map(String))];
}

// Withdraw every unpaid, still-collectible visit-linked invoice that MOVED to a payer. Returns the ids.
async function withdrawLinkedInvoicesForOwner(trx, scope = {}) {
  const { withdrawInvoiceFromCustomer } = require('./visit-completion-packets');
  const withdrawn = [];
  for (const t of await ownerTransitions(trx, scope, { mode: 'post', lock: true, stamped: 'unstamped' })) {
    if (NOT_WITHDRAWABLE.includes(t.status) || !t.moved || !t.afterOwner) continue;
    // Re-judged on the HELD invoice row: it may have settled, been claimed for a processing
    // payment or withdrawn since the candidate read.
    const held = await trx('invoices').where({ id: t.invoiceId }).forUpdate().first('status', 'payer_id', 'payer_statement_id', 'scheduled_send_error');
    if (!held || held.payer_id || held.payer_statement_id || NOT_WITHDRAWABLE.includes(held.status)
      || /^payer_billed:/.test(String(held.scheduled_send_error || ''))) continue;
    if (await withdrawInvoiceFromCustomer(trx, { invoiceId: t.invoiceId, payerId: t.afterOwner, markQueued: true })) withdrawn.push(t.invoiceId);
  }
  return withdrawn;
}

// The mirror, for ownership-REMOVING transitions (payer cleared, deactivated, self-pay pin set):
// a stamped invoice whose owner is now nobody is released - the stamp clears, an invoice that was
// waiting in the send queue goes back into it, the dunning the withdrawal paused resumes. A stamp
// whose payer changed follows the payer that owns the visit now. Returns the released count.
async function reconcileLinkedInvoices(trx, scope = {}) {
  const { resumeDunningPausedByWithdrawal } = require('./visit-completion-packets');
  const { STALE_SEND_PARK_ERROR } = require('./invoice-helpers');
  let released = 0;
  for (const t of await ownerTransitions(trx, scope, { mode: 'post', lock: true, stamped: 'stamped', stampedForPayer: scope.payerId })) {
    // `payer_billed:<id>[:park][:queued][:at=<iso send time>][:m=<marker>]` - the marker is the
    // verbatim send-state marker the withdrawal replaced and may itself contain ':'.
    const stamp = t.scheduledSendError;
    const markerAt = stamp.indexOf(':m=');
    const priorMarker = markerAt >= 0 ? stamp.slice(markerAt + 3) : null;
    const withoutMarker = markerAt >= 0 ? stamp.slice(0, markerAt) : stamp;
    const sendAtAt = withoutMarker.indexOf(':at=');
    const priorSendAt = sendAtAt >= 0 ? new Date(withoutMarker.slice(sendAtAt + 4)) : null;
    const [, stampedPayer, ...flags] = (sendAtAt >= 0 ? withoutMarker.slice(0, sendAtAt) : withoutMarker).split(':');
    if (t.afterOwner) {
      if (t.afterOwner !== stampedPayer) {
        await trx('invoices').where({ id: t.invoiceId, status: t.status, scheduled_send_error: stamp })
          .update({ scheduled_send_error: stamp.replace(/^payer_billed:[^:]+/, `payer_billed:${t.afterOwner}`), updated_at: trx.fn.now() });
      }
      continue;
    }
    const parked = flags.includes('park');
    const requeue = flags.includes('queued') && t.status === 'draft';
    // The marker goes back exactly as it was, so a requeued invoice stays email-only.
    const restored = parked ? STALE_SEND_PARK_ERROR : priorMarker;
    const moved = await trx('invoices')
      .where({ id: t.invoiceId, status: t.status, scheduled_send_error: stamp }).whereNull('payer_id')
      .update(requeue
        // Back at the operator's own time; "now" only when that time has already passed.
        ? { status: 'scheduled', scheduled_send_at: priorSendAt && priorSendAt > new Date() ? priorSendAt : trx.fn.now(), scheduled_send_attempts: 0, scheduled_send_error: restored, updated_at: trx.fn.now() }
        : { scheduled_send_error: restored, updated_at: trx.fn.now() });
    if (!moved) continue;
    await resumeDunningPausedByWithdrawal(trx, t.invoiceId);
    released += 1;
  }
  return released;
}

// The visit-linked invoices whose OWN checkout PaymentIntent this Bill-To change invalidates: the
// invoice moves to a payer. Their client secrets must stop working, because a customer can confirm a
// pre-issued secret straight with Stripe, past every pay-page check.
async function linkedSessionInvoiceIds(database, scope = {}, { pending = null } = {}) {
  // Inside a writer transaction the ownership rows (the pending payer included) are held FOR SHARE
  // before the answer that cancels a checkout is read.
  const transitions = await ownerTransitions(database, scope, { mode: 'pre', pending, lock: database.isTransaction === true, stamped: 'unstamped' });
  return new Set(transitions
    .filter((t) => t.moved && t.stripePaymentIntentId && t.afterOwner !== null)
    .map((t) => String(t.invoiceId)));
}

// The refusal fence, run BEFORE the writer's first Stripe cancel: a visit-linked invoice this change
// MOVES, whose send claim is held, whose bank debit is captured, or whose charge is unresolved (an
// in-flight or ambiguous saved-card attempt, an orphan charge) is money or delivery in motion - the
// Bill-To change is refused (the caller's 409) instead of handing that debt to AP underneath it. The
// charge fence is read-only here (nothing is released or promoted).
//
// Inside a writer transaction the fence also LOCKS what it judges, in the packet path's order
// (customer, visit, payer rows FOR SHARE, then the invoice FOR UPDATE) and holds it to commit: a queue
// sender's claim flip (invoice.js claimInvoiceForSend / claimDueScheduledInvoiceForSend) and a
// saved-card claim (stripe.js claimInvoiceSavedCardCharge) both write or lock the invoice row, so
// neither can slip in between this check and the withdrawal; one that already committed is seen here
// as status 'sending' or an unresolved attempt.
async function linkedInvoiceChargeInFlight(database, scope = {}, { pending = null } = {}) {
  const { isCollectionPendingFenceError } = require('./invoice-helpers');
  const locking = database.isTransaction === true;
  const transitions = await ownerTransitions(database, scope, { mode: 'pre', pending, lock: locking, stamped: 'unstamped' });
  for (const t of transitions) {
    if (!t.moved) continue;
    // Re-read under the invoice row lock: this is the row the claims race for.
    const invoice = locking
      ? await database('invoices').where({ id: t.invoiceId }).forUpdate()
        .first('id', 'status', 'payer_id', 'payer_statement_id', 'scheduled_send_error', 'stripe_payment_intent_id')
      : { id: t.invoiceId, status: t.status, stripe_payment_intent_id: t.stripePaymentIntentId, scheduled_send_error: t.scheduledSendError };
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

module.exports = { visitOwnerTransitions, lockLinkedOwnershipRows, recordOwnerPlan, ownerTransitions, ownerOf, linkedSessionInvoiceIds, linkedVisitIdsForCustomers, withdrawLinkedInvoicesForOwner, reconcileLinkedInvoices, linkedInvoiceChargeInFlight };
