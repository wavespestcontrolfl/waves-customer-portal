// Shared by claim, finalization, and provider-boundary checks.
const SEND_CLAIMABLE_STATUSES = ['draft', 'scheduled', 'sent', 'viewed', 'overdue'];
const SEND_FINALIZABLE_STATUSES = [...SEND_CLAIMABLE_STATUSES, 'sending'];

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

// A combined-visit packet invoice whose Bill-To moved to a third-party payer
// AFTER the homeowner already held a pay link (sent / viewed / overdue) cannot
// be recalled: withdrawPacketInvoiceForPayer leaves the status collectible and
// payer_id NULL, and records the withdrawal ONLY in this stamp
// (`payer_billed:<payerId>[:hold]`, cleared by reconcileWithdrawnPacketInvoices
// when ownership returns to self-pay).
//
// Collectibility is therefore not a property of `status` alone. Rather than ask
// every money seam to re-derive it — the public pay routes, the saved-card
// charges, admin manual payment, credit application — the one gate they all
// already share reads the stamp here. That keeps the invariant in a single
// place instead of a convention each new collection path has to remember.
const PACKET_WITHDRAWN_SEND_ERROR = /^payer_billed:/;

// The stale-send recovery parks an ambiguous claim here: status `scheduled`
// with a NULL scheduled_send_at (so no worker picks it up) and this text as
// the operator's evidence. A withdrawal has to preserve that state — the row
// may already have reached the customer — instead of turning it into a fresh
// draft the release would re-queue.
// Every writer that CLEARS scheduled_send_error must keep a `payer_billed:`
// withdrawal stamp: the stamp is the only record that a combined-visit
// invoice's Bill-To moved to a third-party payer while the homeowner already
// held its pay link, and clearing it makes the invoice collectible from the
// homeowner again (Codex #4311 r29 P0). Use in place of `scheduled_send_error:
// null`; a row with no stamp still ends up NULL.
/**
 * The freshest ownership verdict, as a sendCustomerMessage preDispatchCheck:
 * the canonical sender runs it immediately before provider preparation, which
 * is the last point a dunning rail can abort without holding a lock across
 * provider I/O (Codex #4311 r42 P1). Fail closed — an unreadable row blocks
 * the send, because "cannot tell" and "self-pay" are not the same answer.
 */
function selfPayAtDispatch(invoiceId, database) {
  return async () => {
    try {
      const live = await database('invoices').where({ id: invoiceId }).first('payer_id', 'scheduled_send_error');
      if (!live) return { ok: false, code: 'INVOICE_UNREADABLE', reason: 'invoice could not be re-read before dispatch' };
      if (live.payer_id || invoiceWithdrawnFromCustomer(live)) {
        return { ok: false, code: 'INVOICE_PAYER_BILLED', reason: 'invoice is billed to a third-party payer' };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, code: 'INVOICE_UNREADABLE', reason: err.message };
    }
  };
}

function preserveWithdrawalStamp(database) {
  return database.raw("CASE WHEN scheduled_send_error LIKE 'payer_billed:%' THEN scheduled_send_error ELSE NULL END");
}

// The accepted-Text/pending-Email marker on scheduled_send_error (matched everywhere by
// prefix): the queue's sender treats the Text leg as delivered and sends only the Email.
// A combined-visit invoice whose link rides the visit summary text is scheduled under it
// from the start (visit-completion-packets.js).
const BILLING_EMAIL_PENDING_AFTER_CHANNEL_ACCEPTED = 'BILLING_EMAIL_PENDING_AFTER_CHANNEL_ACCEPTED';
// The same marker for an invoice whose Text leg is carried by the visit summary text: the
// suffix says the Email is then the customer's only guaranteed path to the link, so a failed
// Email is retried (the queue's own attempt cap) instead of finalizing the invoice as sent.
const SUMMARY_TEXT_CARRIED_ERROR = `${BILLING_EMAIL_PENDING_AFTER_CHANNEL_ACCEPTED}:visit_summary`;
// The planned state that precedes it: the Text leg belongs to the visit summary text, which has
// not been accepted yet. The queue's sender never texts the invoice and does NOT count the Text
// leg as delivered (no BILLING_EMAIL_PENDING... prefix on purpose); it is promoted to the
// carried marker above only when the summary's link-bearing text is accepted.
const SUMMARY_TEXT_PLANNED_ERROR = 'SUMMARY_TEXT_PLANNED';

// The scheduled-send queue's own send claim is told apart from an operator's by its token: the
// column is a uuid, so the queue's tokens are version-8 uuids (the version nibble is '8'), which
// nothing else generates. The visit summary needs the difference: a planned invoice claimed by the
// queue sends email only (the summary text still carries the link), while any other claim on the
// invoice may text it.
function newQueueSendClaimToken() {
  return require('crypto').randomUUID().replace(/^(.{14})./, '$18');
}
function isQueueSendClaimToken(token) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-/i.test(String(token || ''));
}

const STALE_SEND_PARK_ERROR = 'Recovered from stale sending claim — delivery unverified; check whether the customer received it, then resend or re-schedule manually';

// The stale-claim review hold, read back from the park above: a row parked
// there is `scheduled` with a NULL scheduled_send_at (out of the due query)
// and this exact text in scheduled_send_error. Matched by prefix off the ONE
// constant above (never a second re-typed string) so the write and the read
// can't drift apart. An automatic claimant (no operatorInitiated) must
// honor this hold; only a deliberate operator Resend is the way off it —
// gated in claimInvoiceForSend.
function isStaleClaimReviewHold(invoice) {
  return !!invoice
    && invoice.status === 'scheduled'
    && invoice.scheduled_send_at == null
    && typeof invoice.scheduled_send_error === 'string'
    && invoice.scheduled_send_error.startsWith(STALE_SEND_PARK_ERROR);
}

function staleClaimReviewHoldError(invoiceId) {
  const e = new Error(`Invoice ${invoiceId} is not sendable — parked under a stale-claim review hold (delivery unverified); an operator must review and resend`);
  e.code = 'stale_claim_review_hold';
  return e;
}

function invoiceWithdrawnFromCustomer(invoice) {
  return !!invoice
    && typeof invoice === 'object'
    && PACKET_WITHDRAWN_SEND_ERROR.test(String(invoice.scheduled_send_error || ''));
}

// Codex round-23 P1: ONE definition of "a collectible invoice the HOMEOWNER owes" shared by the SMS context
// (outstanding balance, open invoice, Zelle-target list, invoice-status facts), the settlement / obligation
// checks and the drafter's invoice-status map. Status must be one a customer can still be asked to pay
// (sent / viewed / overdue — see the note below on partially_paid), the invoice must not be payer-billed (payer_id) or WITHDRAWN to a
// payer (stamp only), and `hasCollectibleAmountDue` adds a positive amount due (total minus applied credit).
// Codex round-36 P1: EXACTLY the statuses /api/billing/balance (the customer portal) sums as owed. A partially_paid
// invoice is NOT among them (a billing product decision this module does not change), so the SMS grounding balance
// agrees with the portal and treats a partially_paid invoice with an amount due as an UNCOUNTED obligation instead
// (isUncountedPartialDueInvoice): settlement claims fail closed on it, unpaid claims bind through the invoice status.
const OWN_COLLECTIBLE_INVOICE_STATUSES = Object.freeze(['sent', 'viewed', 'overdue']);
const PARTIALLY_PAID_STATUS = 'partially_paid';
// Codex round-49 P1: a statement-accrued child (payer_statement_id, payer_id NULL) is the payer's - the pay page and the portal's Pay
// Now list treat it so - never the homeowner's debt.
const isStampedPayerInvoice = (invoice) => !!(invoice.payer_id || invoice.payer_statement_id);
function isUncountedPartialDueInvoice(invoice) {
  return !!invoice
    && !isStampedPayerInvoice(invoice)
    && invoiceStatusKey(invoice.status) === PARTIALLY_PAID_STATUS
    && !invoiceWithdrawnFromCustomer(invoice)
    && invoiceAmountDue(invoice) > 0;
}
function isCollectibleOwnInvoice(invoice) {
  return !!invoice
    && !isStampedPayerInvoice(invoice)
    && OWN_COLLECTIBLE_INVOICE_STATUSES.includes(invoiceStatusKey(invoice.status))
    && !invoiceWithdrawnFromCustomer(invoice);
}
function hasCollectibleAmountDue(invoice) {
  return isCollectibleOwnInvoice(invoice) && invoiceAmountDue(invoice) > 0;
}

// Takes the invoice ROW — the only shape that can see the withdrawal stamp.
// There is deliberately no status-string overload (Codex #4311 r27 P2,
// AGENTS.md: no compatibility shims for callers this repo controls): a second
// internal contract that silently skips the withdrawal check would let the
// payer-owned collection bug back in the first time a new seam followed the
// old shape. Every call site in this repo passes the row; anything else is a
// programming error and fails loudly rather than collecting.
function assertInvoiceCollectible(invoice) {
  if (!invoice || typeof invoice !== 'object') {
    throw new Error('assertInvoiceCollectible requires the invoice row (a status string cannot show a payer withdrawal)');
  }
  const row = invoice;
  const status = invoiceStatusKey(row.status);
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
  // Checked last so a terminal status still reports its own, more accurate
  // reason (a withdrawal never stamps a terminal row, but a row that settled
  // between the withdrawal and this read can carry both).
  assertInvoiceNotWithdrawnFromCustomer(row);
}

// The withdrawal half of assertInvoiceCollectible on its own, for the seams
// that deliberately let a terminal status through (the /confirm rails accept
// an already-`paid` row so a replayed PaymentIntent returns its recorded
// payment idempotently). Those call sites gate assertInvoiceCollectible on a
// terminal-status list, which is exactly the set a withdrawn invoice is NOT
// in — `sent`/`viewed`/`overdue` with a NULL payer_id — so the row-aware gate
// never ran for them. Call this AFTER the terminal-status handling so a
// settled row still reports its own reason first.
function assertInvoiceNotWithdrawnFromCustomer(invoice) {
  if (invoiceWithdrawnFromCustomer(invoice)) {
    throw new Error('This visit is now billed to a third-party payer and is no longer payable here');
  }
}

function assertInvoiceVoidable(currentStatus) {
  if (currentStatus === 'paid') {
    const err = new Error('Cannot void a paid invoice — issue a refund instead');
    // Codex round-3 audit P0 follow-up: tagged so a caller with its OWN
    // "genuinely unsettled" requirement (e.g. voidInvoice's
    // requireUnsettled option, termite-annual-renewal-charge.js's grace
    // lapse) can classify this refusal as a DURABLE settlement without
    // string-matching the message — purely additive; every existing
    // caller is unaffected.
    err.code = 'INVOICE_ALREADY_PAID';
    throw err;
  }
  // 'prepaid' IS voidable: the void path returns the applied account credit to
  // the customer's balance (restoreAccountCreditForVoidedInvoice), so it is no
  // longer stranded. (Cash-backed prepayments book a payment row at issuance and
  // are caught by the in-flight/paid guards above and the void path's own
  // payment_recorded_at check.)
  if (currentStatus === 'processing') {
    const err = new Error('Cannot void an invoice with a payment in flight — wait for it to settle, then refund if needed');
    err.code = 'INVOICE_PAYMENT_IN_FLIGHT';
    throw err;
  }
  // 'sending' is a live send claim: the provider call may still be in
  // flight, and its finalize accepts draft/scheduled/sending rows — voiding
  // here (and possibly unvoiding to draft) would let that in-flight send
  // deliver the stale pre-void message and flip the restored draft back to
  // sent. The claim clears in seconds; refuse and retry (Codex #3493 r10).
  if (currentStatus === 'sending') {
    const err = new Error('Cannot void this invoice — a send is already in progress; wait a moment and retry');
    err.code = 'INVOICE_SEND_IN_PROGRESS';
    throw err;
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

// A collection-fence throw that means "money may already be moving or owed
// reconciliation on this invoice" (an in-flight or ambiguous saved-card
// attempt, an orphan charge, a received deposit awaiting settlement) — as
// opposed to an unexpected failure (a DB error), which proves nothing either
// way. Customer-dunning callers exclude/skip on the former and HOLD on the
// latter, so the two must be told apart. Codes are the ones
// stripe.assertNoInvoiceChargeReconciliationPending and
// estimate-deposits.assertInvoiceDepositSettlementReady throw.
const COLLECTION_PENDING_FENCE_CODES = Object.freeze([
  'STRIPE_CHARGE_IN_PROGRESS',
  'STRIPE_AMBIGUOUS_OUTCOME',
  'STRIPE_CHARGED_DB_FAILED',
  'DEPOSIT_RECONCILIATION_REQUIRED',
]);
function isCollectionPendingFenceError(err) {
  if (!err) return false;
  return COLLECTION_PENDING_FENCE_CODES.includes(err.code) || err.reconciliationRequired === true;
}

module.exports = {
  SEND_CLAIMABLE_STATUSES,
  SEND_FINALIZABLE_STATUSES,
  INVOICE_UPDATE_ALLOWED_FIELDS,
  STALE_SEND_PARK_ERROR,
  BILLING_EMAIL_PENDING_AFTER_CHANNEL_ACCEPTED,
  SUMMARY_TEXT_CARRIED_ERROR,
  SUMMARY_TEXT_PLANNED_ERROR,
  newQueueSendClaimToken,
  isQueueSendClaimToken,
  isStaleClaimReviewHold,
  staleClaimReviewHoldError,
  preserveWithdrawalStamp,
  selfPayAtDispatch,
  INVOICE_UNCOLLECTIBLE_STATUSES,
  VISIT_NEVER_RAN_STATUSES,
  visitRefusesSettlement,
  lockVisitForSettlement,
  assertInvoiceCollectible,
  assertInvoiceNotWithdrawnFromCustomer,
  assertInvoiceVoidable,
  isInvoiceCollectibleStatus,
  invoiceWithdrawnFromCustomer,
  OWN_COLLECTIBLE_INVOICE_STATUSES,
  PARTIALLY_PAID_STATUS,
  isUncountedPartialDueInvoice,
  isCollectibleOwnInvoice,
  hasCollectibleAmountDue,
  invoiceAmountDue,
  formatCardLine,
  COLLECTION_PENDING_FENCE_CODES,
  isCollectionPendingFenceError,
};
