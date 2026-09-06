/**
 * Pure invoice helpers — no DB, no Stripe SDK, no Twilio.
 *
 * Encodes the audit invariants the unit tests pin:
 *   - INVOICE_UPDATE_ALLOWED_FIELDS: status (and other money columns)
 *     must NEVER be writable through the generic PUT /admin/invoices/:id
 *     endpoint. State transitions go through the explicit /void,
 *     /charge-card, /record-payment, /archive, /unarchive routes.
 *   - assertInvoiceVoidable: paid / processing invoices stay non-
 *     voidable so an admin click can't erase revenue.
 *
 * Imported by services/invoice.js and the audit unit tests.
 */

const INVOICE_UPDATE_ALLOWED_FIELDS = Object.freeze([
  'title', 'notes', 'email_message', 'due_date', 'line_items', 'tax_rate',
]);

const INVOICE_UNCOLLECTIBLE_STATUSES = Object.freeze([
  'paid',
  'prepaid',
  'processing',
  'void',
  'refunded',
  'canceled',
  'cancelled',
]);

// A visit in one of these states never ran and never will — an invoice
// still pointing at it must NOT take money (settlement, credit, prepaid
// stamps). The cancel paths void such invoices post-commit; a writer that
// wins the race against that void would otherwise leave money attached to
// a visit that never happens. Checked by the writers UNDER their row lock,
// so a cancel that commits first is always seen (#3878 r2/r5 windows).
// 'completed' is deliberately absent (normal billing) and so is
// 'rescheduled' (a pending reschedule REQUEST parks the same row).
const VISIT_NEVER_RAN_STATUSES = Object.freeze(['cancelled', 'canceled', 'no_show', 'skipped']);

// Read the linked visit's status under the caller's transaction (FOR UPDATE
// — same lock the settlement paths already take on the visit) and return
// the terminal status when the invoice must refuse money, else null.
//
// NOWAIT (Codex #3882 r3 P2, same reasoning as click-estimate-mint's
// lineage lock): the callers hold the invoice lock here, while the schedule
// edit's re-service conversion holds the visit and then waits on the same
// invoice (admin-schedule voidConversionInvoicesRestoringCredits). Both
// orders exist in the repo, so no ordering closes every cycle; what removes
// the deadlock is never WAITING on the visit while holding the invoice. A
// held visit row means staff is editing that very visit right now — PG
// answers 55P03 immediately and the caller's transaction rolls back whole;
// the operator retries once the edit lands.
async function lockVisitForSettlement(trx, scheduledServiceId, columns) {
  try {
    return await trx('scheduled_services').where({ id: scheduledServiceId }).forUpdate().noWait().first(...columns);
  } catch (err) {
    if (err?.code !== '55P03') throw err;
    const busy = new Error("This invoice's visit is being edited right now — nothing was recorded. Retry in a moment.");
    busy.statusCode = 409; busy.isOperational = true; busy.code = 'visit_busy';
    throw busy;
  }
}

async function visitRefusesSettlement(trx, scheduledServiceId) {
  if (!scheduledServiceId) return null;
  const visit = await lockVisitForSettlement(trx, scheduledServiceId, ['id', 'status']);
  const status = invoiceStatusKey(visit?.status);
  return VISIT_NEVER_RAN_STATUSES.includes(status) ? status : null;
}

function invoiceStatusKey(status) {
  return String(status || '').trim().toLowerCase();
}

/**
 * The amount a customer must actually pay for an invoice: its total minus any
 * account credit already applied (credit_applied). Computed in integer cents to
 * avoid float drift, clamped at 0. This is the canonical "charge base" — every
 * Stripe/Terminal/autopay charge path and the webhook amount-verification must
 * price from THIS, not raw invoice.total, or a credit-applied invoice
 * over-collects (admin apply-credit forbids partials for exactly this reason).
 */
function invoiceAmountDue(invoice) {
  const totalCents = Math.round((Number(invoice && invoice.total) || 0) * 100);
  const creditCents = Math.round((Number(invoice && invoice.credit_applied) || 0) * 100);
  return Math.max(0, totalCents - creditCents) / 100;
}

function isInvoiceCollectibleStatus(status) {
  return !INVOICE_UNCOLLECTIBLE_STATUSES.includes(invoiceStatusKey(status));
}

function assertInvoiceCollectible(currentStatus) {
  const status = invoiceStatusKey(currentStatus);
  if (status === 'paid') {
    throw new Error('Invoice already paid');
  }
  if (status === 'prepaid') {
    throw new Error('Invoice is already prepaid');
  }
  if (status === 'processing') {
    throw new Error('Bank payment is already processing');
  }
  if (status === 'void') {
    throw new Error('Invoice is void and cannot be paid');
  }
  if (status === 'refunded') {
    throw new Error('Invoice has been refunded and cannot be paid');
  }
  if (status === 'canceled' || status === 'cancelled') {
    throw new Error('Invoice is canceled and cannot be paid');
  }
}

function assertInvoiceVoidable(currentStatus) {
  if (currentStatus === 'paid') {
    throw new Error('Cannot void a paid invoice — issue a refund instead');
  }
  // 'prepaid' IS voidable: the void path returns the applied account credit to
  // the customer's balance (restoreAccountCreditForVoidedInvoice), so it is no
  // longer stranded. (Cash-backed prepayments book a payment row at issuance and
  // are caught by the in-flight/paid guards above and the void path's own
  // payment_recorded_at check.)
  if (currentStatus === 'processing') {
    throw new Error('Cannot void an invoice with a payment in flight — wait for it to settle, then refund if needed');
  }
  // 'sending' is a live send claim: the provider call may still be in
  // flight, and its finalize accepts draft/scheduled/sending rows — voiding
  // here (and possibly unvoiding to draft) would let that in-flight send
  // deliver the stale pre-void message and flip the restored draft back to
  // sent. The claim clears in seconds; refuse and retry (Codex #3493 r10).
  if (currentStatus === 'sending') {
    throw new Error('Cannot void this invoice — a send is already in progress; wait a moment and retry');
  }
}

/**
 * The " (Visa ending 4242)" clause customer-facing payment texts append after
 * an amount. One formatter for every sender (receipt SMS, combined completion
 * receipt, decline notice) so the card always reads the same; empty string
 * when either part is missing so templates can interpolate it unconditionally.
 */
function formatCardLine(brand, last4) {
  if (!brand || !last4) return '';
  const b = String(brand);
  return ` (${b.charAt(0).toUpperCase() + b.slice(1)} ending ${last4})`;
}

module.exports = {
  INVOICE_UPDATE_ALLOWED_FIELDS,
  INVOICE_UNCOLLECTIBLE_STATUSES,
  VISIT_NEVER_RAN_STATUSES,
  visitRefusesSettlement,
  lockVisitForSettlement,
  assertInvoiceCollectible,
  assertInvoiceVoidable,
  isInvoiceCollectibleStatus,
  invoiceAmountDue,
  formatCardLine,
};
