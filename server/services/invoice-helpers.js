const crypto = require('crypto');

// Shared by claim, finalization, and provider-boundary checks.
const SEND_CLAIMABLE_STATUSES = ['draft', 'scheduled', 'sent', 'viewed', 'overdue'];
const SEND_FINALIZABLE_STATUSES = [...SEND_CLAIMABLE_STATUSES, 'sending'];

// Same-trip first-application billing review (#5021 round-3 redesign —
// owner ruling: the hold only ever protects an invoice the customer has
// NOT yet received. 'draft' (never sent) and 'scheduled' (queued, not yet
// sent) are the two at-rest undelivered states; 'sending' is the in-flight
// claim a worker or operator send holds BETWEEN flipping the row and
// actually handing off to the SMS/email provider — the customer still does
// not have it yet, so a review that opens while a row sits claimed at
// 'sending' must still block that handoff (see invoice.js's preclaimed
// re-check, right before provider handoff). Once a row reaches 'sent' /
// 'viewed' / 'overdue' (or any terminal status), the customer already has
// it — a review opened at or after that point is recorded for the office
// (durable item + admin alert) but never blocks collection; blocking a
// delivered invoice would only obstruct payment on a total the customer
// already saw, with nothing left to protect.
const UNDELIVERED_INVOICE_STATUSES = Object.freeze(['draft', 'scheduled', 'sending']);

// The status-only check above is ambiguous for 'sending': claimInvoiceForSend
// flips ANY claimed row to 'sending' during the claim — a first send of a
// never-delivered draft AND a resend of an already-delivered (sent/viewed/
// overdue) invoice both read as 'sending' by the time a provider-handoff
// recheck (or a review that opens while the claim is in flight) looks at
// the row (Codex #5021 round-3 pre-push P1: the earlier version of this
// file used UNDELIVERED_INVOICE_STATUSES.includes(status) directly at
// EVERY billing-review checkpoint, which read a resend-in-flight of a
// DELIVERED invoice as still-undelivered and wrongly held it). The
// delivery stamps (sent_at/sms_sent_at/email_sent_at) are written once, on
// the FIRST successful delivery, and are never cleared by a later resend
// claim — their presence is the one signal a claim's own status flip
// can't erase, so 'sending' only counts as undelivered when none of them
// are set yet. Every billing-review enforcement point (assertInvoiceCollectible,
// the two claimInvoiceForSend checks, the sendViaSMS/sendInvoiceEmail
// provider-handoff rechecks) and the write-time `held` decision
// (first-application-sibling-split.js's openBillingReview) all call THIS,
// never the raw array, for exactly that reason.
function isInvoiceUndeliveredForBillingReview(invoice) {
  const status = invoiceStatusKey(invoice?.status);
  if (status === 'sending') {
    return !(invoice?.sent_at || invoice?.sms_sent_at || invoice?.email_sent_at);
  }
  return UNDELIVERED_INVOICE_STATUSES.includes(status);
}

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
  // Same-trip first-application billing review (owner ruling, #5021 round-3
  // redesign — "flag, don't auto-split"): a diverging sibling's move opens
  // a durable, invoice-keyed review (first-application-sibling-split.js, in
  // the SAME transaction as the date write) rather than touching this
  // invoice's money. This is the ONE gate every charge/send seam already
  // calls before moving money — widening it here, instead of fencing each
  // seam individually, is what actually holds automatic collection
  // (saved-card charge, scheduled send finalize, autopay/dunning) while the
  // review is open.
  //
  // Scoped to UNDELIVERED_INVOICE_STATUSES (round-3: the customer hasn't
  // received it yet) — a review recorded against an already-delivered
  // invoice (sent/viewed/overdue) or a terminal one (paid/prepaid/
  // processing/void/refunded/canceled — the checks above already returned
  // for those) is a durable item + admin alert ONLY: the office can't
  // recall what the customer already has, so blocking here would only
  // obstruct payment on a total the customer already saw. The office
  // resolves either case by hand and clears it (POST /admin/invoices/:id/
  // billing-review/clear, or — undelivered only — the trivial same-date/
  // untouched auto-clear).
  //
  // Placed AFTER every terminal-status check above (paid/prepaid/
  // processing/void/refunded/canceled already returned by this point) and
  // BEFORE the withdrawal check below — the "terminal status reports its
  // own reason first, withdrawal checked last" ordering the comment below
  // documents is unaffected: a terminal row never reaches this line at all.
  //
  // Depends on the caller's invoice object actually carrying this column —
  // every current caller of assertInvoiceCollectible (stripe.js, invoice-
  // manual-payment.js, admin-payments-reconcile.js, customer-credit.js)
  // fetches the row via a plain `.first()`/`.select('*')` with no column
  // projection, so this is never missing today; a future caller that
  // narrows its own SELECT must include billing_review_opened_at (and
  // status) or this hold silently never fires for it.
  if (invoice.billing_review_opened_at && isInvoiceUndeliveredForBillingReview(invoice)) {
    throw new Error('This invoice has an open billing review — a same-trip visit diverged in date; resolve and clear the review before collecting');
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

// A stable fingerprint of the review state an admin operator saw on the
// invoice detail page — never `updated_at` (see invoiceMoneyFingerprint in
// first-application-sibling-split.js for why that column is unreliable).
// POST /admin/invoices/:id/billing-review/clear requires the caller to echo
// this back; the server recomputes it under the row's own lock right
// before releasing the hold, and a mismatch means the review changed
// (typically: a NEW sibling diverged) since the operator loaded the page —
// clearing on stale information would silently drop that later divergence
// (Codex #5021 r3 P1). Returns null when no review is open — nothing for a
// client to echo back.
function billingReviewVersion(invoice) {
  if (!invoice?.billing_review_opened_at) return null;
  // Normalize context to an object before stringifying — pg's jsonb driver
  // usually parses it, but a caller that read the column as text (or a
  // fixture that inserted a JSON string) must hash identically either way.
  let context = invoice.billing_review_context;
  if (typeof context === 'string') {
    try { context = JSON.parse(context); } catch { /* hash the raw string below */ }
  }
  const payload = JSON.stringify({
    opened_at: new Date(invoice.billing_review_opened_at).toISOString(),
    reason: invoice.billing_review_reason || null,
    context: context || null,
  });
  return crypto.createHash('sha1').update(payload).digest('hex');
}

// The invoice detail/list serializers' one shared read of the review state
// (InvoiceService.getById / .list) — same shape either surface returns, so
// the admin UI's banner (AdminInvoicesPage.jsx) reads one consistent
// field regardless of which fetch populated the row. `held` mirrors
// EXACTLY what assertInvoiceCollectible / the send-claim predicates
// enforce (UNDELIVERED_INVOICE_STATUSES) — never re-derived by the client.
// Null when no review is open.
function billingReviewSummary(invoice) {
  if (!invoice?.billing_review_opened_at) return null;
  let context = invoice.billing_review_context;
  if (typeof context === 'string') {
    try { context = JSON.parse(context); } catch { context = null; }
  }
  return {
    reason: invoice.billing_review_reason || null,
    context: context || null,
    opened_at: invoice.billing_review_opened_at,
    held: isInvoiceUndeliveredForBillingReview(invoice),
    version: billingReviewVersion(invoice),
  };
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
  SEND_CLAIMABLE_STATUSES,
  SEND_FINALIZABLE_STATUSES,
  UNDELIVERED_INVOICE_STATUSES,
  isInvoiceUndeliveredForBillingReview,
  INVOICE_UPDATE_ALLOWED_FIELDS,
  STALE_SEND_PARK_ERROR,
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
  invoiceAmountDue,
  formatCardLine,
  billingReviewVersion,
  billingReviewSummary,
};
