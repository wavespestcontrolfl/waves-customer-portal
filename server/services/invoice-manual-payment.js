/**
 * Manual (off-Stripe) invoice settlement — the ONE path that marks an invoice
 * paid for cash / check / Zelle / Venmo / PayPal / other money that landed
 * outside the gateway. Extracted 1:1 from POST /admin/invoices/:id/record-
 * payment (2026-09-02) so a non-route caller — the Zelle payment-notice
 * reconciler — settles through exactly the same guards, transaction, ledger
 * row, side effects and receipt pipeline as the operator's Add-payment tap.
 *
 * Contract (unchanged from the route):
 *   recordManualPayment(invoiceId, { method, reference, note, recordedBy,
 *                                    sendReceipt = true, via = 'both',
 *                                    expectedAmountCents, requireSelfPay,
 *                                    automated })
 *     → { invoice, receipt }   receipt = { email, sms } | null
 *
 * amountCents (optional, the Invoices page, owner 2026-10-29): the cents the office received. Under the invoice row lock the amount is
 * compared with what is still owed (invoiceAmountDue of the LOCKED row): equal = the whole balance, today's paid flip, unchanged;
 * more = refused; less = a PART PAYMENT (only behind GATE_PARTIAL_PAYMENTS, and only for a person at the Invoices page). A part payment
 * inserts the same off-gateway payments row, adds the amount to invoices.amount_paid, leaves the status alone, stamps
 * payment_recorded_at (the "money is on this invoice" signal every void/edit/settle guard already reads), writes the recorded and the
 * completion markers Undo works from, and retires an open Stripe session exactly as a full payment does. It skips the paid flip, the
 * receipt, the reminder stop, the review ask, the closeout, the pause clear, the prepay activation and the plan completion: reminders
 * continue for the remainder. The paid flip of a part-paid invoice resets amount_paid to 0 (the column holds money received on an
 * invoice that is still open), books the REMAINDER as the payments row, and the receipt reads the whole bill.
 * Refused for a part: gate off; Auto Pay customer (fail closed); an active payment plan; an annual prepay invoice; a payer-billed
 * invoice; any caller carrying expectedAmountCents / settlementFence / requireSelfPay / automated (the Zelle paths, the Intelligence Bar).
 * owedCentsSeen (required with amountCents): the amount owed the page showed. It must still be what is owed, before the lock and on
 * the locked row, so a double click, a retry after a lost response, or a payment someone else recorded meanwhile is refused (409)
 * instead of booking the same part payment twice.
 *
 * expectedAmountCents (optional, the Zelle notice reconciler): the amount the
 * caller is settling FOR. Checked under the invoice row lock right before the
 * paid flip — if the amount due moved since the caller looked (an edit, a
 * credit), nothing is written and a 409 says so, so the ledger can never
 * record a different sum than the money that arrived.
 *
 * The card also supplies a settlementFence (below), carrying `closeoutTarget` (the visit id its card said the payment's closeout would
 * complete, or 'none') and `closeoutVisit` (that visit's facts as the card showed them: service type, scheduled date, status, edit time):
 * written as a pin inside the settlement transaction and handed to the closeout as its approved target and visit, so a visit that became
 * closable after the card, or was edited, rescheduled, reclassified or cancelled since, is left open (the closeout re-asserts the facts
 * under the visit's lock), on the first run and on every retry. The payment stays recorded; the result carries `closeout`. It throws its own 409 refusals (`drift: true`); the fence is handed the LOCKED
 * invoice row as its second argument when it runs under the lock.
 *
 * requireSelfPay (optional, both Zelle notice paths): the caller matched the
 * invoice as an OPEN SELF-PAY invoice (no payer, no statement, live payer
 * resolution empty) before calling. Re-run those predicates on the LOCKED row
 * inside the transaction — a concurrent payer reassignment between the
 * caller's check and the paid flip would otherwise settle another billing
 * party's invoice with the homeowner's transfer. Refuses with a 409 and
 * writes nothing.
 *
 * automated (optional, the Zelle reconciler's auto-settlement): nobody tapped
 * a button, so the receipt is NOT sent inline — a receipt_delivery_jobs row
 * is inserted IN the settlement transaction (the automatic receipt queue,
 * receipt-delivery-queue.js, is the one mechanism that honors
 * the payment_receipt opt-out, the SMS send window and the
 * retry ladder) and drained after commit. The job commits with the
 * payment or not at all. `receipt` then reads { queued: true }. Operator
 * paths leave it false and send inline.
 *
 * settlementFence (optional, both Zelle paths): async (db|trx) => boolean.
 * Run TWICE: on the pre-lock read before any Stripe session is retired (a
 * worker that no longer owns its claim must not destroy the customer's
 * checkout), and under the invoice row lock right before the paid flip on
 * the payment connection — there the callers SELECT … FOR UPDATE their
 * notice claim (id + status + claim_token) so the row stays locked through
 * the commit and a swept-and-RECLAIMED worker can never commit a second
 * invoice for one transfer. false → 409, nothing written.
 *
 * Refusals throw an Error carrying `statusCode` (400 / 404 / 409) and
 * `isOperational`; the lost-race 409 also carries `currentStatus`. Anything
 * else (DB outage, a sentinel thrown inside the transaction) is rethrown
 * untouched so the route surfaces it as a 500 exactly as before.
 *
 * Refuses to overwrite an already-paid invoice (use refund flow first) and
 * refuses to mark a void invoice paid. Stripe-paid invoices keep their
 * card_brand/card_last_four; manual payments leave those NULL so timeline
 * rendering can distinguish. Venmo and PayPal are named tenders (2026-08-29)
 * so revenue reports can tell them apart from 'other' — still off-gateway
 * settlements (no webhook, no Stripe object); recorded after the money lands.
 */
const db = require('../models/db');
const logger = require('./logger');
const InvoiceService = require('./invoice');
const PaymentPlans = require('./payment-plans');
const { guardOpenPaymentIntentForPrepaid } = require('./prepaid-pi-guard');
const { etDateString } = require('../utils/datetime-et');
const { recordAuditEvent } = require('./audit-log');
const { assertInvoiceCollectible, INVOICE_UNCOLLECTIBLE_STATUSES, invoiceAmountDue, visitRefusesSettlement, lockVisitForSettlement } = require('./invoice-helpers');
const { partialPaymentsLive } = require('../config/feature-gates');
const { customerOnAutopay } = require('./autopay-eligibility');

// Append the operator note to the invoice notes (don't clobber existing notes). Built from the LOCKED row's notes inside the
// settlement transaction, so a note saved between the unlocked read and the lock is kept, not overwritten.
function appendOperatorNote(existing, { method, reference, note }) {
  if (!note) return existing || null;
  // ET wall-clock date (the one convention — utils/datetime-et), not UTC.
  const line = `[${etDateString()}] ${method.toUpperCase()}${reference ? ` ${reference}` : ''}: ${note}`;
  return existing ? `${existing}\n${line}` : line;
}

const VALID_PAYMENT_METHODS = ['cash', 'check', 'zelle', 'venmo', 'paypal', 'other'];
// The audit_log action recordManualPayment writes with every settlement, and the invoice columns the paid flip overwrites (their
// pre-payment values ride the marker so Undo can put them back exactly). Read by invoice-manual-payment-undo.js.
const MANUAL_PAYMENT_RECORDED_ACTION = 'invoice.manual_payment_recorded';
// Written when every post-commit effect below has finished (reminder stop, pause clear, review ask, closeout, receipt). Undo refuses until it
// exists, so it can never reverse a payment while those effects are still running against the paid snapshot.
const MANUAL_PAYMENT_EFFECTS_DONE_ACTION = 'invoice.manual_payment_effects_done';
// amount_paid rides the list because the paid flip resets it to 0 (money received on a still-open invoice is the paid payment's now): Undo of
// the final payment of a part-paid invoice puts the earlier parts back from the marker.
const PAID_FIELDS = ['status', 'notes', 'paid_at', 'payment_method', 'payment_reference', 'payment_recorded_by', 'payment_recorded_at', 'amount_paid'];
// A part payment changes only these invoice columns besides amount_paid (the status and the tender stay as they were); their prior values
// ride its marker so Undo of the part can put them back.
const PART_FIELDS = ['notes', 'payment_recorded_by', 'payment_recorded_at'];
const VALID_RECEIPT_CHANNELS = ['email', 'sms', 'both'];

function refusal(statusCode, message, extra = {}) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.isOperational = true;
  Object.assign(err, extra);
  return err;
}

// ── Retire an open Stripe collection session before an off-Stripe settlement ──
// Once the invoice is paid/prepaid, assertInvoiceCollectible blocks NEW
// PaymentIntents / Terminal handoffs, but an already-minted PI (the pay page
// mints one on load) could still be confirmed from a still-open tab and
// charge the card a second time. The ONE mechanism for this is
// services/prepaid-pi-guard.js (also run by mark-prepaid in admin-schedule
// and the completion-side application in admin-dispatch — codex #3610 r6
// P1: no parallel retire logic here). This wrapper only maps its verdict to
// the { status, error } the routes send as-is; null means clear. Shared by
// apply-credit (route) and recordManualPayment.
async function retireOpenPaymentIntentBeforeSettlement(invoice, { action }) {
  const openPiId = invoice.stripe_payment_intent_id || null;
  if (!openPiId) return null;
  const verdict = await guardOpenPaymentIntentForPrepaid(invoice);
  if (verdict.ok) return null;
  if (verdict.reason === 'payment_in_flight') {
    return { status: 409, error: `A payment is already in flight (${verdict.piStatus}); wait for it to settle or refund it before ${action}` };
  }
  return { status: 409, error: `Open payment session ${openPiId} could not be verified (${verdict.detail || 'payment service unavailable'}); resolve it before ${action}` };
}

// Why this invoice cannot take a part payment right now, or null. `conn` is the pool (before the lock) or the transaction holding the invoice
// lock. Auto Pay reads fail closed: an unreadable answer refuses. The messages are for the office, in plain English.
async function partPaymentRefusal(conn, invoice) {
  if (invoice.payer_id || invoice.payer_statement_id) {
    return 'This invoice is billed to a payer, so a part payment cannot be recorded on it.';
  }
  const plan = await conn('payment_plans').where({ invoice_id: invoice.id, status: 'active' }).first('id');
  if (plan) return 'This invoice has a payment plan, so a part payment cannot be recorded on it.';
  // An undecided card dispute: a won dispute puts the invoice back to the paid state of the disputed payment, which would swallow a part
  // received meanwhile. Parts wait until the dispute is decided (dispute_final holds the outcome).
  const openDispute = await conn('payments').where({ status: 'disputed' })
    .whereRaw("(metadata->>'dispute_invoice_id' = CAST(? AS text) OR metadata->>'invoice_id' = CAST(? AS text))", [invoice.id, invoice.id])
    .whereRaw("metadata->>'dispute_final' IS NULL")
    .first('id');
  if (openDispute) return 'This invoice has an open card dispute, so a part payment cannot be recorded until the dispute is decided.';
  const { resolveInvoiceTermId } = require('./invoice-prepay');
  const onTerm = await resolveInvoiceTermId(invoice, conn, { strict: true })
    || ((await conn.schema.hasTable('annual_prepay_terms')) && await conn('annual_prepay_terms').where({ prepay_invoice_id: invoice.id }).first('id'));
  if (onTerm) return 'This is an annual prepay invoice, so a part payment cannot be recorded on it.';
  try {
    const customer = await conn('customers').where({ id: invoice.customer_id }).first();
    if (!customer || await customerOnAutopay(customer, { db: conn, failClosed: true })) {
      return 'This customer is on Auto Pay, so a part payment cannot be recorded on this invoice yet.';
    }
  } catch (err) {
    logger.warn(`[invoice-manual-payment] Auto Pay check failed for invoice ${invoice.id}: ${err.message}`);
    return 'Auto Pay could not be checked for this customer, so a part payment cannot be recorded right now.';
  }
  return null;
}

function owedChangedMessage(nowCents) {
  return `The amount owed on this invoice changed to $${(nowCents / 100).toFixed(2)} since the page loaded (another payment or an edit). Reload the invoice and check it before you record a payment. Nothing was recorded.`;
}

async function recordManualPayment(id, {
  method,
  reference,
  note,
  recordedBy = 'admin',
  sendReceipt = true,
  via = 'both',
  expectedAmountCents = null,
  amountCents = null,
  // The amount owed the Invoices page showed when the office typed amountCents (required with it).
  owedCentsSeen = null,
  requireSelfPay = false,
  automated = false,
  settlementFence = null,
  // Staff user id behind an operator-recorded payment (audit attribution
  // for the invoice-issued closeout); null for automated settlements.
  recordedByTechnicianId = null,
} = {}) {
  if (expectedAmountCents != null && !(Number.isSafeInteger(expectedAmountCents) && expectedAmountCents > 0)) {
    throw refusal(400, 'expectedAmountCents must be a positive integer number of cents');
  }
  if (amountCents != null && !(Number.isSafeInteger(amountCents) && amountCents > 0)) {
    throw refusal(400, 'amount must be a positive amount of money');
  }
  if (amountCents != null && !(Number.isSafeInteger(owedCentsSeen) && owedCentsSeen > 0)) {
    throw refusal(400, 'Reload the invoice and enter the payment again. Nothing was recorded.');
  }
  if (!method || !VALID_PAYMENT_METHODS.includes(method)) {
    throw refusal(400, `method must be one of: ${VALID_PAYMENT_METHODS.join(', ')}`);
  }
  if (sendReceipt && !VALID_RECEIPT_CHANNELS.includes(via)) {
    throw refusal(400, "via must be 'email', 'sms', or 'both'");
  }
  // The visit the Intelligence Bar card said this payment would close out ('none' = none); undefined for the Invoices page.
  const approvedCloseoutTarget = settlementFence?.closeoutTarget;
  const approvedCloseoutVisit = settlementFence?.closeoutVisit;
  const trimmedReference = typeof reference === 'string' ? reference.trim().slice(0, 200) : '';
  const trimmedNote = typeof note === 'string' ? note.trim().slice(0, 400) : '';

  const invoice = await db('invoices').where({ id }).first();
  if (!invoice) throw refusal(404, 'Invoice not found');
  // Phase 2: an accrued invoice is collected ONLY via its consolidated
  // statement — never mark an individual accrued invoice paid here (it would
  // settle once manually and again when the statement settles).
  if (invoice.payer_statement_id) {
    throw refusal(400, 'Invoice is billed on the payer’s monthly statement — record the payment against the statement, not the individual invoice');
  }
  // Terminal or in-flight invoices can never be manually marked paid.
  // This shares the same transition guard as Stripe collection paths.
  try {
    assertInvoiceCollectible(invoice);
  } catch (err) {
    throw refusal(invoice.status === 'processing' ? 409 : 400, err.message);
  }
  // Refuse to mark a $0 invoice paid — surfaces upstream creation bugs
  // instead of silently producing "$0.00 PAID" rows that misreport revenue.
  if (parseFloat(invoice.total || 0) <= 0) {
    throw refusal(400, 'Invoice has no amount to collect (total is $0)');
  }

  // The amount the office entered, against what is still owed (the pre-lock read; the locked row decides below). More than owed is
  // refused; the whole balance is today's full path, fenced to that figure; less is a part payment.
  let partCents = null;
  if (amountCents != null) {
    const owedCents = Math.round(invoiceAmountDue(invoice) * 100);
    // A repeat of the same submit (a double click, a retry after a lost response) or a payment someone else recorded meanwhile meets
    // a different amount owed than the page showed: refused, so one payment is never booked twice. Checked again on the locked row.
    if (owedCentsSeen !== owedCents) throw refusal(409, owedChangedMessage(owedCents));
    if (amountCents > owedCents) {
      throw refusal(400, `That is more than the $${(owedCents / 100).toFixed(2)} still owed on this invoice. Nothing was recorded.`);
    }
    if (amountCents === owedCents) {
      if (expectedAmountCents == null) expectedAmountCents = amountCents;
    } else {
      if (!partialPaymentsLive()) throw refusal(400, 'Part payments are not turned on. Record the whole amount owed, or ask for help.');
      // Person-entered only: the Zelle reconciler and notice Apply, and the Intelligence Bar card, carry a figure or a fence of their own.
      if (automated || expectedAmountCents != null || settlementFence || requireSelfPay) {
        throw refusal(400, 'A part payment can only be entered by hand on the Invoices page.');
      }
      const refused = await partPaymentRefusal(db, invoice);
      if (refused) throw refusal(409, `${refused} Nothing was recorded.`);
      partCents = amountCents;
      // The live payer re-resolution (rowIsSelfPayDue), run now and again on the locked row like the Zelle paths.
      requireSelfPay = true;
    }
  }
  // A part-paid invoice never settles from a Zelle notice by itself: the office records what is left by hand.
  if (automated && Number(invoice.amount_paid) > 0) {
    throw refusal(409, 'This invoice has a part payment, so a Zelle notice cannot settle it by itself. The office records the rest by hand. Nothing was recorded.');
  }

  // Combined pay-page session release BEFORE accepting a manual payment
  // (codex #3427 r29 P0): this invoice may ride a combined PI a browser
  // can still confirm directly — recording cash/check now and letting
  // that capture land later double-charges the customer. Unconfirmed →
  // cancel + unstamp (fail closed); already canceled → finish the stamp
  // cleanup; anything in flight refuses (the collectible guard above
  // already blocks 'processing' invoices, this covers seam races).

  // Standalone pay-page PaymentIntent (codex #3610 P1): the combined-session
  // release inside the transaction below leaves a NON-combined PI untouched,
  // yet the pay page mints one on load and steers customers to Zelle beside
  // it. Cancel it before the paid flip so a still-open tab can't confirm it
  // after the transfer is recorded; refuse while money is in flight. Runs
  // pre-lock (Stripe call), same as apply-credit; the trx's collectible
  // guard covers the seam.
  // Zelle-caller predicates FIRST, on the pre-lock read: a stale or raced
  // automated match must refuse here, BEFORE the customer's live Stripe
  // session is retired below — never cancel a valid checkout for a
  // settlement that then records nothing. The under-lock re-checks below
  // remain the race fences.
  // Whole-balance match only: a partially paid invoice (amount_paid > 0) must not auto-match a notice (the partial-payment writer enforces it).
  if (expectedAmountCents != null) {
    const actualCents = Math.round(invoiceAmountDue(invoice) * 100);
    if (actualCents !== expectedAmountCents) {
      throw refusal(409, `Invoice amount due is $${(actualCents / 100).toFixed(2)}, not the $${(expectedAmountCents / 100).toFixed(2)} being recorded — nothing was recorded`, { amountMismatch: { expectedCents: expectedAmountCents, actualCents } });
    }
  }
  if (requireSelfPay) {
    const { rowIsSelfPayDue } = require('./open-balance');
    if (invoice.payer_id || invoice.payer_statement_id || !(await rowIsSelfPayDue(invoice.customer_id, invoice))) {
      throw refusal(409, 'Invoice is no longer an open self-pay invoice (a payer or statement was assigned) — nothing was recorded', { drift: true });
    }
  }
  if (settlementFence && !(await settlementFence(db))) {
    throw refusal(409, 'The settlement claim was lost before the payment could be recorded (the notice was reclaimed, or the bank changed or withdrew the payment) — nothing was recorded');
  }
  const triagedPiId = invoice.stripe_payment_intent_id || null;
  const openPi = await retireOpenPaymentIntentBeforeSettlement(invoice, { action: 'recording a manual payment' });
  if (openPi) throw refusal(openPi.status, openPi.error);

  // Atomic transition. Two concurrent double-clicks both pass the
  // precheck above, but Postgres serializes UPDATEs against the same
  // row so only one of these statements actually changes anything;
  // the loser gets an empty .returning('*') and bails out before any
  // side effects (receipt send, activity row) run a second time.
  //
  // The payments-ledger insert rides the SAME transaction as the status
  // flip: the ledger row is load-bearing for every revenue rollup, and a
  // best-effort insert after commit left collected cash permanently
  // missing on a transient DB failure — with no alert and no sweep (the
  // dashboard gap-fallback only rescues Stripe-PI invoices). Either both
  // commit or the operator gets a retryable error and nothing changed.
  let settledPaymentId = null;
  // The cash this call booked (the part, or the remainder of a part-paid invoice): the paid flip resets amount_paid, so the row read after it
  // no longer says what was owed.
  let settledAmount = null;
  const updatedInvoice = await db.transaction(async (trx) => {
    // Combined-session reservation INSIDE the collection transaction
    // (codex #3427 r30 P0, serialized r31 P0): the helper takes the
    // per-customer combined lock, re-reads the invoice under it, and
    // releases any combined session — the lock holds through this
    // commit, so /setup cannot stamp a confirmable combined PI between
    // the check and the paid flip. Throws are 409-shaped; the caller
    // surfaces them.
    await require('./pay-combined').releaseCombinedSessionBeforeCollection(trx, invoice, { context: 'recording a manual payment' });
    // Seam re-check under the row lock (codex #3610 r2 P1, mirrors
    // apply-credit): /setup could have minted a NEW standalone PI between
    // the pre-lock triage above and this lock. The combined release only
    // handles combined PIs, so a fresh standalone stamp means a live client
    // secret we never retired — refuse; the operator retries and the new PI
    // gets triaged. A cleared stamp (null) is fine: nothing is live.
    const locked = await trx('invoices').where({ id }).forUpdate().first();
    if (!locked) return null;
    const lockedPiId = locked.stripe_payment_intent_id || null;
    if (lockedPiId && lockedPiId !== triagedPiId) return { racedNewPaymentIntent: lockedPiId };
    // The collectibility gate re-run UNDER THE LOCK (audit P0): the unlocked
    // read at the top of this function can be overtaken by a Bill-To
    // assignment that stamps the withdrawal, and only `status` is re-checked
    // at the paid flip below. The self-pay fence does not cover it either —
    // that resolver reads this invoice's own representative service, while the
    // payer may sit on another billed member of the same packet, and it is
    // skipped entirely when the caller does not require self-pay.
    try {
      assertInvoiceCollectible(locked);
    } catch (err) {
      return { noLongerCollectible: err.message };
    }
    // Saved-card claim fence (ADMIN-BUG-R20): every OTHER collection rail
    // (pay-combined, pay-v2, Terminal, the webhook branches, void/unvoid)
    // asks assertNoInvoiceChargeReconciliationPending before moving or
    // accepting money. A card charge whose process died right after the
    // Stripe call leaves the invoice 'sent' with the claim row still
    // 'claimed'/submitted — without this check a manual settlement here
    // would collect the invoice a SECOND time (once by card, quarantined
    // into stripe_orphan_charges when the webhook lands, once by
    // cash/check/Zelle/credit). Run under the SAME row lock as the paid
    // flip so a claim that lands between the pre-lock read and here is
    // still caught.
    try {
      await require('./stripe').assertNoInvoiceChargeReconciliationPending(id, trx);
    } catch (err) {
      if (['STRIPE_CHARGE_IN_PROGRESS', 'STRIPE_AMBIGUOUS_OUTCOME', 'STRIPE_CHARGED_DB_FAILED'].includes(err.code)) {
        return { chargeReconciliationPending: err.message };
      }
      throw err;
    }
    // Amount fence under the same lock as the paid flip: the caller settles
    // a specific sum; the ledger row below records invoiceAmountDue(row), so
    // the two must agree NOW, not when the caller last looked.
    // Whole-balance match only: a partially paid invoice (amount_paid > 0) must not auto-match a notice (the partial-payment writer enforces it).
    if (expectedAmountCents != null) {
      const actualCents = Math.round(invoiceAmountDue(locked) * 100);
      if (actualCents !== expectedAmountCents) return { amountMismatch: { expectedCents: expectedAmountCents, actualCents } };
    }
    // Self-pay fence under the same lock: the row's own payer columns plus
    // the live payer re-resolution (rowIsSelfPayDue, fail-closed). A payer
    // assigned after the caller's eligibility check makes this refuse. The
    // resolution rides THIS trx: the Zelle callers hold their notice trx on
    // one connection and this trx on the other (DB_POOL_MAX floor is 2), so
    // a third acquire here would wait on itself.
    if (requireSelfPay) {
      // Lock the payer-SOURCE rows the resolution reads (customers.payer_id,
      // the visit's payer_id / self_pay_override) AND the payer rows they
      // point at (an inactive payer resolves as self-pay; a concurrent
      // re-activation must wait) so no reassignment can commit between this
      // read and the paid flip. Lock order: invoice → customer → visit → payer.
      // The visit lock is NOWAIT (Codex #3882 r4 P2): this is the first
      // visit acquisition on the self-pay path, so a blocking wait here
      // would recreate the invoice↔visit cycle the fence below avoids.
      const cust = await trx('customers').where({ id: locked.customer_id }).forUpdate().first('id', 'payer_id');
      const visit = locked.scheduled_service_id
        ? await lockVisitForSettlement(trx, locked.scheduled_service_id, ['id', 'payer_id'])
        : null;
      const payerIds = [...new Set([cust?.payer_id, visit?.payer_id].filter(Boolean))];
      if (payerIds.length) await trx('payers').whereIn('id', payerIds).orderBy('id', 'asc').forUpdate().select('id');
      const { rowIsSelfPayDue } = require('./open-balance');
      const selfPay = !locked.payer_id && !locked.payer_statement_id && await rowIsSelfPayDue(locked.customer_id, locked, { database: trx });
      if (!selfPay) return { notSelfPay: true };
    }
    // The reconciler never settles a part-paid invoice (re-read on the locked row, like the pre-lock check).
    if (automated && Number(locked.amount_paid) > 0) return { partPaidNotice: true };
    // A part payment, decided on the LOCKED row: still less than what is owed, and nothing that makes it unsafe appeared since the pre-lock read.
    if (partCents != null) {
      const lockedOwedCents = Math.round(invoiceAmountDue(locked) * 100);
      if (lockedOwedCents !== owedCentsSeen) return { owedChanged: { nowCents: lockedOwedCents } };
      if (partCents >= lockedOwedCents) return { amountMismatch: { expectedCents: partCents, actualCents: lockedOwedCents } };
      const refused = await partPaymentRefusal(trx, locked);
      if (refused) return { partRefused: refused };
    }
    // Visit fence under the same lock (after the invoice → customer → visit
    // → payer order above; the visit row is re-locked, never taken earlier):
    // an invoice whose visit is cancelled / no-show / skipped takes no
    // money. The cancel voids it post-commit; a payment that raced that
    // void would otherwise sit on a visit that never happens (#3878 r2).
    {
      const neverRan = await visitRefusesSettlement(trx, locked.scheduled_service_id);
      if (neverRan) return { visitNeverRan: neverRan };
    }
    if (settlementFence && !(await settlementFence(trx, locked))) return { fenceLost: true };
    if (partCents != null) {
      const partAmount = partCents / 100;
      const [partRow] = await trx('invoices')
        .where({ id })
        .whereNotIn('status', INVOICE_UNCOLLECTIBLE_STATUSES)
        .update({
          amount_paid: trx.raw('ROUND(COALESCE(amount_paid, 0) + ?::numeric, 2)', [partAmount]),
          // The status and the tender stay as they were. payment_recorded_at is the "money is on this invoice" signal the void, edit and
          // settle guards read (and the instant Undo matches its marker against); the retired session leaves no stale stamp.
          payment_recorded_by: recordedBy,
          payment_recorded_at: trx.fn.now(),
          stripe_payment_intent_id: null,
          processor: null,
          notes: appendOperatorNote(locked.notes, { method, reference: trimmedReference, note: trimmedNote }),
          updated_at: trx.fn.now(),
        })
        .returning('*');
      if (!partRow) return null;
      const [{ id: partPaymentId }] = await trx('payments').insert({
        customer_id: partRow.customer_id,
        amount: partAmount,
        status: 'paid',
        description: `Invoice ${partRow.invoice_number} — ${method} (part payment)${trimmedReference ? ` (${trimmedReference})` : ''}`,
        payment_date: etDateString(),
        // Linked to the invoice so every "is there money on this invoice" read (void, edit, prepay and refund guards) sees it.
        metadata: JSON.stringify({ invoice_id: partRow.id, partial_payment: true }),
      }).returning('id');
      settledPaymentId = partPaymentId;
      settledAmount = partAmount;
      await recordAuditEvent({
        actor_type: recordedByTechnicianId ? 'admin' : 'system',
        actor_id: recordedByTechnicianId,
        action: MANUAL_PAYMENT_RECORDED_ACTION,
        resource_type: 'invoices',
        resource_id: id,
        metadata: {
          paymentId: partPaymentId,
          method,
          amount: partAmount,
          partial: true,
          automated: false,
          recordedBy,
          previous: Object.fromEntries(PART_FIELDS.map((field) => [field, locked[field] ?? null])),
        },
        critical: true,
        trx,
      });
      return partRow;
    }
    const [row] = await trx('invoices')
      .where({ id })
      .whereNotIn('status', INVOICE_UNCOLLECTIBLE_STATUSES)
      .update({
        status: 'paid',
        // The money received so far is this payment's now: the column holds money received on a still-open invoice. The remainder is the
        // ledger row below (read from the locked row); the receipt reads the whole bill off total and credit.
        amount_paid: 0,
        paid_at: trx.fn.now(),
        payment_method: method,
        payment_reference: trimmedReference || null,
        payment_recorded_by: recordedBy,
        payment_recorded_at: trx.fn.now(),
        // The pay-page PI was retired above (or never existed) and this
        // invoice is settling OFF-gateway: drop the stamp and the stale
        // 'stripe' processor tag (codex #3610 r3 P1) — otherwise the tax
        // export's gap-revenue synthesis (admin-tax: paid + processor=stripe
        // + PI with no payments row) double-counts it beside the manual
        // ledger row inserted below. The ID was needed only for the locked
        // seam comparison, which already ran.
        stripe_payment_intent_id: null,
        processor: null,
        notes: appendOperatorNote(locked.notes, { method, reference: trimmedReference, note: trimmedNote }),
        updated_at: trx.fn.now(),
      })
      .returning('*');
    if (!row) return null;
    // The card's closeout target as a pin, in this transaction: it commits with the payment or not at all.
    await require('./invoice-issued-closeout').recordApprovedPaidCloseoutTarget(id, approvedCloseoutTarget, { conn: trx, actorTechnicianId: recordedByTechnicianId, approvedVisit: approvedCloseoutVisit });

    // Payments-ledger row so revenue dashboards (admin-dashboard, monthly
    // reports) sum manual cash/check/Zelle alongside Stripe collections.
    // No `processor` set — that column is reserved for actual gateways
    // (`stripe`); leaving it null is the existing convention for off-
    // gateway money (see admin-payments-reconcile.js manual branch).
    const paymentRow = {
      customer_id: row.customer_id,
      // Record the CASH actually received — amount due (total − applied account
      // credit) — not the full total, or manual cash/check/Zelle over-states
      // revenue by the applied credit (which isn't cash).
      amount: invoiceAmountDue(locked),
      status: 'paid',
      description: `Invoice ${row.invoice_number} — ${method}`
        + `${trimmedReference ? ` (${trimmedReference})` : ''}`,
      payment_date: etDateString(),
    };
    // Third-party Bill-To: link a payer-billed manual payment to its invoice so
    // the customer-facing billing history/balance can filter it out. Self-pay
    // rows normally stay unlinked to use the receipt-total fallback — BUT when
    // account credit was applied the recorded cash (amount due) differs from
    // invoice.total, so they MUST be linked or the receipt falls back to the
    // pre-credit total instead of the amount actually received.
    if (row.payer_id || Number(row.credit_applied) > 0 || Number(locked.amount_paid) > 0) {
      paymentRow.metadata = JSON.stringify({
        invoice_id: row.id,
        // This payment is the last of a part-paid invoice; the earlier parts are their own ledger rows.
        ...(Number(locked.amount_paid) > 0 ? { completes_part_payments: true, amount_paid_before: Number(locked.amount_paid) } : {}),
        // Payer ownership rides the ledger row itself: billing-cron's
        // pause veto and the webhook auto-clear both exclude payer-funded
        // money by metadata.payer_id — without this stamp a manually
        // recorded third-party payment would read as the homeowner's own
        // tender and veto a pause their dead card earned.
        ...(row.payer_id ? { payer_id: row.payer_id } : {}),
      });
    }
    const [{ id: paymentId }] = await trx('payments').insert(paymentRow).returning('id');
    settledPaymentId = paymentId;
    settledAmount = paymentRow.amount;
    // The marker Undo (invoice-manual-payment-undo.js) works from, in the SAME transaction: which ledger row backs this payment, how the
    // invoice looked before it, and whether a person or the Zelle reconciler recorded it. The marker's created_at is this transaction's
    // now(), the same instant payment_recorded_at carries, which is how Undo proves the marker belongs to the payment still on the invoice.
    await recordAuditEvent({
      actor_type: recordedByTechnicianId ? 'admin' : 'system',
      actor_id: recordedByTechnicianId,
      action: MANUAL_PAYMENT_RECORDED_ACTION,
      resource_type: 'invoices',
      resource_id: id,
      metadata: {
        paymentId,
        method,
        amount: paymentRow.amount,
        automated: Boolean(automated),
        recordedBy,
        previous: Object.fromEntries(PAID_FIELDS.map((field) => [field, locked[field] ?? null])),
      },
      critical: true,
      trx,
    });
    // The invoice is settled — an active payment plan has nothing left to
    // collect. Complete it on the SAME trx so a paid invoice never keeps
    // an `active` plan that blocks edits / credit reversal.
    await PaymentPlans.completeActivePlansForInvoice(row.id, trx);
    if (sendReceipt && automated) {
      // Same transaction as the paid flip: the receipt job is durable the
      // moment the payment is. The customer sent the money themselves (a
      // Zelle transfer minutes ago), so the receipt is customer-initiated
      // for the send-window decision.
      await require('./receipt-delivery-queue').enqueueReceiptDelivery({ invoiceId: id, source: 'zelle_notice_reconciler', customerInitiated: true, database: trx });
    }
    return row;
  });

  if (updatedInvoice?.racedNewPaymentIntent) {
    throw refusal(409, 'A new payment session started for this invoice — retry recording the payment');
  }
  if (updatedInvoice?.amountMismatch) {
    const { expectedCents, actualCents } = updatedInvoice.amountMismatch;
    throw refusal(409, `Invoice amount due is $${(actualCents / 100).toFixed(2)}, not the $${(expectedCents / 100).toFixed(2)} being recorded — nothing was recorded`, { amountMismatch: updatedInvoice.amountMismatch });
  }
  if (updatedInvoice?.owedChanged) {
    throw refusal(409, owedChangedMessage(updatedInvoice.owedChanged.nowCents));
  }
  if (updatedInvoice?.partRefused) {
    throw refusal(409, `${updatedInvoice.partRefused} Nothing was recorded.`);
  }
  if (updatedInvoice?.partPaidNotice) {
    throw refusal(409, 'This invoice has a part payment, so a Zelle notice cannot settle it by itself. The office records the rest by hand. Nothing was recorded.');
  }
  if (updatedInvoice?.fenceLost) {
    throw refusal(409, 'The settlement claim was lost before the payment could be recorded (the notice was reclaimed, or the bank changed or withdrew the payment) — nothing was recorded');
  }
  if (updatedInvoice?.visitNeverRan) {
    throw refusal(409, `This invoice's visit is ${updatedInvoice.visitNeverRan.replace('_', '-')} — nothing was recorded. Void or reissue the invoice, or record the money as account credit.`, { visitNeverRan: updatedInvoice.visitNeverRan });
  }
  if (updatedInvoice?.noLongerCollectible) {
    throw refusal(409, `${updatedInvoice.noLongerCollectible} — nothing was recorded`);
  }
  if (updatedInvoice?.chargeReconciliationPending) {
    throw refusal(409, `${updatedInvoice.chargeReconciliationPending} — resolve it before recording another payment`);
  }
  if (updatedInvoice?.notSelfPay) {
    throw refusal(409, 'Invoice is no longer an open self-pay invoice (a payer or statement was assigned) — nothing was recorded', { drift: true });
  }
  if (!updatedInvoice) {
    // Lost the race to a concurrent caller (or another path marked it
    // paid in between). Re-fetch so the caller can return a useful 409 body.
    const current = await db('invoices').where({ id }).first();
    throw refusal(409, 'Invoice status changed before payment could be recorded', { currentStatus: current?.status });
  }

  if (partCents != null) {
    // A part payment ends here: no receipt, no reminder stop (reminders continue for the remainder), no review ask, closeout, pause clear,
    // prepay activation or plan completion. The completion marker tells Undo that nothing else is still running against this payment.
    const remainingCents = Math.round(invoiceAmountDue(updatedInvoice) * 100);
    await db('activity_log').insert({
      customer_id: updatedInvoice.customer_id,
      admin_user_id: recordedByTechnicianId,
      action: 'invoice_part_payment_recorded',
      description: `Part payment recorded for ${updatedInvoice.invoice_number} ($${settledAmount.toFixed(2)} via ${method}`
        + `${trimmedReference ? ` · ref ${trimmedReference}` : ''}; $${(remainingCents / 100).toFixed(2)} still owed) — ${recordedBy}`,
    }).catch((err) => logger.warn(`[admin-invoices:record-payment] activity_log insert failed: ${err.message}`));
    await recordAuditEvent({
      actor_type: recordedByTechnicianId ? 'admin' : 'system',
      actor_id: recordedByTechnicianId,
      action: MANUAL_PAYMENT_EFFECTS_DONE_ACTION,
      resource_type: 'invoices',
      resource_id: id,
      metadata: { paymentId: settledPaymentId },
    });
    return {
      invoice: await db('invoices').where({ id }).first(),
      receipt: null,
      closeout: null,
      partial: { amount: settledAmount, remaining: remainingCents / 100 },
    };
  }

  // Stop the follow-up sequence the same way the Stripe webhook does.
  try {
    const FollowUps = require('./invoice-followups');
    await FollowUps.stopOnPayment(id);
  } catch (err) {
    logger.warn(`[admin-invoices:record-payment] stopOnPayment failed: ${err.message}`);
  }

  // The automatic-clear contract does not stop at Stripe: a check/cash/
  // Zelle payment recorded here is the customer paying, and the Customer
  // 360 banner promises the pause clears when a payment succeeds. NOT for
  // payer-funded rows — the payer's tender proves nothing about the
  // homeowner's card. The settlement moment is NOW (a human recorded
  // money they are holding). The helper owns every other rule (reason
  // gate, causality, locking); a failure logs — the operator who just
  // recorded the payment sees the banner still up and has the button.
  if (!updatedInvoice.payer_id) {
    try {
      const { maybeResumeBillingPauseOnPayment } = require('./billing-pause');
      await maybeResumeBillingPauseOnPayment(updatedInvoice.customer_id, {
        paymentIntentId: null,
        source: 'admin_record_payment',
        settledAt: new Date(),
      });
    } catch (pauseErr) {
      logger.warn(`[admin-invoices:record-payment] billing-pause auto-clear failed: ${pauseErr.message}`);
    }
  }

  // A completion invoice delivered unpaid deferred its review ask to
  // payment — an off-Stripe settlement (cash/check/Zelle) never reaches the
  // Stripe webhook, so trigger the same shared enrollment here (Codex P2,
  // PR #3104 r2). Guards (completion opt-out, visit outcome, dedupe,
  // cap/cooldown) all live in the helper; standalone invoices no-op.
  if (updatedInvoice.status === 'paid') {
    try {
      const ReviewService = require('./review-request');
      const outcome = await ReviewService.enrollForPaidInvoice(updatedInvoice, { source: 'record_payment' });
      // No webhook redelivers this rail (Codex #4311 r32 P1): when the
      // enrollment AND its recovery marker both failed, nothing durable says
      // the ask is still owed, so the office is told instead of the outcome
      // being discarded.
      if (outcome && outcome.recorded === false) {
        logger.error(`[admin-invoices:record-payment] review enrollment for invoice ${updatedInvoice.id} is UNRECORDED — no retry marker exists`);
        await require('./dispatch-alerts').createAlert({
          type: 'visit_closeout_review',
          severity: 'warn',
          payload: {
            reason: 'review_enrollment_unrecorded',
            source: 'record_payment',
            invoiceIds: [updatedInvoice.id],
            detail: 'This manually settled invoice owes a review ask that could not be recorded — re-run the enrollment or ask manually.',
          },
        }).catch((alertErr) => logger.error(`[admin-invoices:record-payment] could not raise the unrecorded-enrollment alert: ${alertErr.message}`));
      }
    } catch (err) {
      logger.warn(`[admin-invoices:record-payment] review enrollment failed: ${err.message}`);
    }
  }

  try {
    const AnnualPrepayRenewals = require('./annual-prepay-renewals');
    await AnnualPrepayRenewals.syncTermForInvoicePayment(updatedInvoice);
  } catch (err) {
    logger.warn(`[admin-invoices:record-payment] annual prepay activation failed: ${err.message}`);
  }

  await db('activity_log').insert({
    customer_id: updatedInvoice.customer_id,
    action: 'invoice_payment_recorded',
    description: `Manual payment recorded for ${updatedInvoice.invoice_number}`
      + ` ($${settledAmount.toFixed(2)} via ${method}`
      + `${trimmedReference ? ` · ref ${trimmedReference}` : ''})`
      + ` — ${recordedBy}`,
  }).catch((err) => logger.warn(`[admin-invoices:record-payment] activity_log insert failed: ${err.message}`));

  // Optional inline receipt — same pipeline as /:id/send-receipt.
  let emailResult = null;
  let smsResult = null;
  let queued = false;
  if (sendReceipt && automated) {
    // The job row committed with the payment above; just nudge the drain.
    require('./receipt-delivery-queue').scheduleReceiptDeliveryDrain({ delayMs: 3000, limit: 5 });
    queued = true;
  } else if (sendReceipt) {
    const { sendReceiptEmail } = require('./invoice-email');
    const { claimReceiptJobForOperatorSend, recordOperatorReceiptDelivered, releaseOperatorReceiptClaim } = require('./receipt-delivery-queue');
    // The payment is already recorded: a claim failure only skips the
    // receipt (reported back), never fails the payment.
    const claim = await claimReceiptJobForOperatorSend(id, { sawUnsent: !updatedInvoice.receipt_sent_at })
      .catch((err) => ({ error: err.message }));
    if (claim.inFlight && !claim.byOperator) {
      // A queued job for this invoice is delivering the receipt right now.
      queued = true;
    } else if (claim.inFlight) {
      // Another operator send holds it and delivers only what that operator
      // chose — no promise this payment's receipt goes out: report it unsent.
      emailResult = { ok: false, error: 'another receipt send for this invoice is in progress — resend from the Invoices page' };
    } else if (claim.alreadySent) {
      emailResult = { ok: false, error: 'receipt already sent' };
    } else if (claim.error) {
      emailResult = { ok: false, error: `receipt claim failed: ${claim.error}` };
    }
    const canSend = !claim.inFlight && !claim.alreadySent && !claim.error;
    const emailLeg = via === 'email' || via === 'both';
    const smsLeg = via === 'sms' || via === 'both';
    if (canSend) {
      try {
        if (emailLeg) {
          emailResult = await sendReceiptEmail(id).catch((err) => ({ ok: false, error: err.message }));
          if (emailResult?.ok) await recordOperatorReceiptDelivered(claim, 'email');
        }
        const r = smsLeg
          ? await InvoiceService.sendReceipt(id, { force: true, recordActivity: false, hasEmailLeg: emailLeg, operatorInitiated: true })
            .catch((err) => ({ sent: false, reason: err.message }))
          : null;
        if (r) smsResult = r.sent ? { ok: true } : { ok: false, error: r.reason || r.code || 'not-sent' };
        if (smsResult?.ok) await recordOperatorReceiptDelivered(claim, 'sms');
        if (emailResult?.ok || smsResult?.ok) {
          await db('invoices').where({ id }).update({ receipt_sent_at: db.fn.now() });
        }
      } finally {
        await releaseOperatorReceiptClaim(claim, { emailDelivered: emailResult?.ok === true, smsDelivered: smsResult?.ok === true, smsResult, emailResult });
      }
    }
    if (emailResult?.ok || smsResult?.ok) {
      await db('activity_log').insert({
        customer_id: updatedInvoice.customer_id,
        action: 'invoice_receipt_sent',
        description: `Receipt sent for invoice ${updatedInvoice.invoice_number}`
          + ` (${[emailResult?.ok && 'email', smsResult?.ok && 'sms'].filter(Boolean).join(' + ')})`
          + ' — auto after manual payment',
      }).catch((err) => logger.warn(`[admin-invoices:record-payment] activity_log insert failed: ${err.message}`));
    }
  }

  // Invoice issued ⇒ visit completed (owner ruling 2026-09-07, dark behind
  // GATE_INVOICE_ISSUED_CLOSES_VISIT): money received by hand proves the
  // visit happened — close it out quietly. Best-effort after the payment
  // is recorded.
  const { closeOutVisitForIssuedInvoice } = require('./invoice-issued-closeout');
  const closeout = await closeOutVisitForIssuedInvoice({ invoiceId: id, trigger: 'paid', actorTechnicianId: recordedByTechnicianId, approvedTarget: approvedCloseoutTarget, approvedVisit: approvedCloseoutVisit });

  // Every post-commit effect has finished: Undo may now consider this payment. Best-effort by design (recordAuditEvent logs and swallows):
  // the payment is committed, so a lost marker only leaves it un-undoable, the safe direction. A crash before this line does the same.
  await recordAuditEvent({
    actor_type: recordedByTechnicianId ? 'admin' : 'system',
    actor_id: recordedByTechnicianId,
    action: MANUAL_PAYMENT_EFFECTS_DONE_ACTION,
    resource_type: 'invoices',
    resource_id: id,
    metadata: { paymentId: settledPaymentId },
  });

  const final = await db('invoices').where({ id }).first();
  return {
    invoice: final,
    receipt: !sendReceipt ? null : queued ? { queued: true } : { email: emailResult, sms: smsResult },
    // What the post-payment closeout did (the Intelligence Bar card reports it; the Invoices page route does not forward it).
    closeout,
  };
}

module.exports = {
  VALID_PAYMENT_METHODS,
  MANUAL_PAYMENT_RECORDED_ACTION,
  MANUAL_PAYMENT_EFFECTS_DONE_ACTION,
  PAID_FIELDS,
  PART_FIELDS,
  refusal,
  recordManualPayment,
  retireOpenPaymentIntentBeforeSettlement,
};
