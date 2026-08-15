/**
 * Open-balance reads (owner ruling 2026-08-08, Donovan case): everything a
 * customer still owes across their OTHER open invoices, for the
 * previous-balance surfaces (invoice email note, pay-page list) and the
 * completion balance sweep.
 *
 * Selection deliberately mirrors the portal "Pay now" query in
 * billing-v2.js GET /balance (the existing open-invoice authority):
 *   - status sent/viewed/overdue — bills the customer has actually been
 *     DELIVERED. Drafts are excluded on purpose: a draft was never presented,
 *     so it is neither shown as "previous balance" nor auto-charged.
 *   - payer_id NULL / payer_statement_id NULL in SQL, then a LIVE payer
 *     re-resolution per row (pre-push P0): a payer assigned after the
 *     invoice was minted can live only on scheduled_services (or as the
 *     customer's default payer) while the reused invoice row stays
 *     payer-null — the completion rails re-resolve for exactly this reason.
 *     A payer-billed row is the third party's debt, never the homeowner's
 *     balance; a failed resolve DROPS the row (fail closed, same direction
 *     as previsit-balance-reminder).
 *   - positive remainder (total − credit_applied), computed in SQL with the
 *     same GREATEST expression as the balance sum, oldest first.
 *
 * Invoices are NEVER merged, voided, or re-totalled here — each row keeps
 * its own service date, amount, and dunning age (that per-invoice age is
 * what keeps the oldest debt escalating — owner ruling #2).
 */

const db = require('../models/db');
const logger = require('./logger');
const { invoiceAmountDue } = require('./invoice-helpers');

// Safety valve, not display pagination: high enough that every real
// customer's full balance fits (prod max open invoices per customer is
// single digits), low enough to bound the per-row payer resolves against
// pathological data. Hitting it is logged so an understated total is never
// silent (pre-push P1).
const MAX_OPEN_INVOICES = 200;

/**
 * The customer's open self-pay invoices, oldest first, excluding
 * `excludeInvoiceId` (the invoice currently being viewed/emailed/charged).
 * Every returned row has been live-payer-verified as self-pay. Callers
 * whitelist what they expose — in particular, sibling invoice TOKENS must
 * never ride a public by-token payload (pre-push P0: one leaked invoice
 * link must not fan out into bearer credentials for the account's other
 * invoices).
 */
// The ONE eligibility query — both the full read and the existence probe run
// this exact selection, so "is there an open balance" can never disagree with
// the invoice list (the columns are needed either way: eligibility itself is
// remainder > 0, cents-checked in JS below).
function openInvoiceQuery(customerId, { excludeInvoiceId = null, database = db } = {}) {
  const query = database('invoices')
    .where({ customer_id: customerId })
    .whereIn('status', ['sent', 'viewed', 'overdue'])
    .whereNull('payer_id')
    .whereNull('payer_statement_id')
    .whereRaw('GREATEST(total - COALESCE(credit_applied, 0), 0) > 0')
    .orderBy('created_at', 'asc')
    .limit(MAX_OPEN_INVOICES)
    .select(
      'id', 'invoice_number', 'status', 'service_type', 'service_date',
      'due_date', 'created_at', 'subtotal', 'discount_amount', 'total',
      'credit_applied', 'scheduled_service_id', 'stripe_payment_intent_id',
    );
  if (excludeInvoiceId) query.whereNot('id', excludeInvoiceId);
  return query;
}

// The per-row self-pay test the SQL cannot make alone: cents-authoritative
// remainder plus the LIVE payer re-resolution (fail-closed toward DROP).
// `onResolveFailure` (optional) fires when the drop is a RESOLVE FAILURE
// rather than a genuine payer: dropping the row keeps disclosure fail-closed,
// but it also silently UNDERSTATES any total built from the survivors —
// callers that would present that total as a definitive figure (the SMS
// balance line) must be able to tell "smaller balance" from "incomplete
// balance" and suppress instead. Existing callers that render the invoices
// individually (email note, sweep) are unchanged.
async function rowIsSelfPayDue(customerId, row, { onResolveFailure = null } = {}) {
  if (!(invoiceAmountDue(row) > 0)) return false;
  const PayerService = require('./payer');
  try {
    const resolved = await PayerService.resolveForInvoice({
      customerId: String(customerId),
      ...(row.scheduled_service_id ? { scheduledServiceId: String(row.scheduled_service_id) } : {}),
      throwOnError: true,
    });
    if (resolved?.payerId) return false;
  } catch (err) {
    logger.warn(`[open-balance] payer resolve failed for invoice ${row.invoice_number} — dropping from balance (fail closed): ${err.message}`);
    if (typeof onResolveFailure === 'function') onResolveFailure(err);
    return false;
  }
  return true;
}

async function openBalanceInvoices(customerId, { excludeInvoiceId = null, database = db, onResolveFailure = null } = {}) {
  if (!customerId) return [];
  const rows = await openInvoiceQuery(customerId, { excludeInvoiceId, database });
  if (rows.length >= MAX_OPEN_INVOICES) {
    logger.warn(`[open-balance] customer ${customerId} hit the ${MAX_OPEN_INVOICES}-invoice bound — balance surfaces may understate`);
  }

  const selfPay = [];
  for (const row of rows) {

    if (await rowIsSelfPayDue(customerId, row, { onResolveFailure })) selfPay.push(row);
  }
  return selfPay;
}

/**
 * EXISTENCE ONLY — "does this customer have any open self-pay balance", with
 * the exact same eligibility rules as the full read (same SQL, same
 * cents-authoritative remainder, same live payer re-resolution), but no total
 * is ever materialized and nothing amount-shaped is returned. Built for the
 * voice split tier (AGENTS.md): an unattested caller may hear THAT a balance
 * exists, and the figure must not even be fetched into the session. Stops at
 * the first qualifying row.
 */
async function openBalanceExists(customerId, { excludeInvoiceId = null, database = db } = {}) {
  if (!customerId) return false;
  // ⭐ NO AMOUNTS LEAVE THE DATABASE. The full read's projection carries
  // subtotal/total/credit_applied because its callers render them; an
  // existence probe has no business materializing 200 invoices' figures to
  // reduce them to a boolean. The cents-positive test runs IN SQL — the exact
  // integer arithmetic invoiceAmountDue performs
  // (ROUND(total·100) − ROUND(credit·100) > 0), not the float GREATEST the
  // broad-phase WHERE uses — and the projection is only what the live payer
  // re-resolution needs. Same eligibility rules, no figures in the process.
  const query = database('invoices')
    .where({ customer_id: customerId })
    .whereIn('status', ['sent', 'viewed', 'overdue'])
    .whereNull('payer_id')
    .whereNull('payer_statement_id')
    .whereRaw('(ROUND(total * 100) - ROUND(COALESCE(credit_applied, 0) * 100)) > 0')
    .orderBy('created_at', 'asc')
    .limit(MAX_OPEN_INVOICES)
    .select('id', 'invoice_number', 'scheduled_service_id');
  if (excludeInvoiceId) query.whereNot('id', excludeInvoiceId);
  const rows = await query;
  const PayerService = require('./payer');
  // ⭐ A DROPPED ROW IS NOT A "NO". The full read fails a resolve-outage row
  // toward DROP because SHOWING a possibly-payer-billed invoice is the harm
  // there. Here the harm is inverted: this boolean gets SPOKEN as "no open
  // balance" to a customer who may owe money, so a candidate lost to a
  // transient failure makes the answer INDETERMINATE (null) — the voice layer
  // already degrades null to "couldn't check, a team member can confirm".
  let anyResolveFailed = false;
  for (const row of rows) {
    try {
       
      const resolved = await PayerService.resolveForInvoice({
        customerId: String(customerId),
        ...(row.scheduled_service_id ? { scheduledServiceId: String(row.scheduled_service_id) } : {}),
        throwOnError: true,
      });
      if (resolved?.payerId) continue;
    } catch (err) {
      logger.warn(`[open-balance] payer resolve failed for invoice ${row.invoice_number} — existence answer degrades to indeterminate: ${err.message}`);
      anyResolveFailed = true;
      continue;
    }
    return true; // short-circuit at the first qualifying self-pay row
  }
  // ⭐ A FULL PAGE OF NON-QUALIFIERS IS NOT A "NO" EITHER. If the candidate
  // query hit its cap and every fetched row resolved to a payer, a self-pay
  // invoice can still exist beyond the cap — a confident false here would be
  // SPOKEN as "no open balance" to a customer who owes money. Off-the-end of
  // a full page is indeterminate, same degradation as a failed resolve.
  if (rows.length >= MAX_OPEN_INVOICES) return null;
  return anyResolveFailed ? null : false;
}

/**
 * { total, count, moreCount, invoices } for the previous-balance surfaces.
 * `total`/`count` cover the FULL self-pay open set; `invoices` is capped at
 * `displayLimit` for rendering, with `moreCount` carrying the remainder so a
 * capped list is never presented as complete (pre-push P1). `total` is the
 * cents-safe sum of per-invoice remainders — a pure sum, never
 * re-discounted or re-taxed (each invoice's own math already happened at
 * mint).
 */
async function openBalanceSummary(customerId, { displayLimit = 5, ...opts } = {}) {
  const invoices = await openBalanceInvoices(customerId, opts);
  const totalCents = invoices.reduce(
    (sum, inv) => sum + Math.round(invoiceAmountDue(inv) * 100),
    0,
  );
  return {
    total: totalCents / 100,
    count: invoices.length,
    moreCount: Math.max(0, invoices.length - displayLimit),
    invoices: invoices.slice(0, displayLimit),
  };
}

/**
 * The {past_due_line} value for the with-invoice completion texts
 * (service_complete_with_invoice / service_report_v1_with_invoice) — the
 * SMS-rail counterpart of the balanceVisibility email note (customers on the
 * completion-SMS delivery rail get no invoice email, so the email-only note
 * never reaches them — owner directive 2026-08-15).
 *
 * Same shape contract as reservice-link.reserviceLineForCustomer: a
 * self-contained clause ending in '\n\n' so an inserted bare token renders
 * clean copy, and '' whenever there is nothing to say — gate off, no open
 * balance, or any lookup failure. Best-effort: NEVER throws (a balance-line
 * failure must not cost the customer their completion text), and an
 * unsupplied-key suppression can't occur because every render site of the
 * completion family supplies this key (expand half; the token lands in the
 * two with-invoice bodies via a separate data-only migration once this is
 * deployed — same rollout discipline as {reservice_line}).
 *
 * `excludeInvoiceId` is the visit's OWN invoice — it is today's bill, not a
 * previous balance. Selection (self-pay only, live payer re-resolution,
 * remainders not face values) is openBalanceSummary's — payer-billed debt is
 * never presented to the homeowner.
 *
 * The clause says "previous balance", NEVER "past due" (codex P1): the
 * shared selection is delivered-and-unpaid (sent/viewed/overdue), which
 * includes invoices still inside their payment terms — the email note uses
 * the same words for the same reason. And a total any survivor-dropping
 * resolve failure made INCOMPLETE is suppressed outright (codex P2): a
 * too-small figure asserted over SMS reads as the whole balance, so saying
 * nothing beats saying something wrong.
 */
async function pastDueSmsLineForCustomer(customerId, { excludeInvoiceId = null } = {}) {
  try {
    const { isEnabled } = require('../config/feature-gates');
    if (!customerId || !isEnabled('completionSmsBalance')) return '';
    let resolveFailed = false;
    const prev = await openBalanceSummary(customerId, {
      excludeInvoiceId,
      onResolveFailure: () => { resolveFailed = true; },
    });
    if (resolveFailed) {
      logger.warn(`[open-balance] SMS balance line suppressed for ${customerId} — a payer resolve failed, so the total may understate`);
      return '';
    }
    if (!(prev.total > 0)) return '';
    const amount = `$${prev.total.toFixed(2)}`;
    const source = prev.count === 1 ? 'an earlier invoice' : `${prev.count} earlier invoices`;
    return `Reminder: your account also has a previous balance of ${amount} from ${source}, separate from today's invoice.\n\n`;
  } catch (err) {
    logger.warn(`[open-balance] SMS balance line failed for ${customerId}: ${err.message}`);
    return '';
  }
}

/**
 * Remove a rendered balance clause from an already-rendered SMS body — the
 * quiet-hours seam of the {past_due_line} rollout (codex P2, round 2): the
 * completion route's send-window PREcheck can pass at 19:5x ET while the
 * authoritative validator at the provider handoff still defers the send, so
 * the frozen replay body queued for the 8 AM window open could carry a
 * figure an overnight payment has invalidated. Callers strip the clause at
 * the moment the deferral is KNOWN (QUIET_HOURS_HOLD), which makes the
 * replay body identical to what the precheck-suppressed path would have
 * rendered. Mirrors the renderer's own post-processing (collapse \n{3,},
 * trim) so removing the sentence leaves no blank paragraph behind. A falsy
 * or absent clause returns the body unchanged.
 */
function stripBalanceLineFromBody(body, line) {
  if (typeof body !== 'string' || !line || typeof line !== 'string') return body;
  const clause = line.trim();
  if (!clause || !body.includes(clause)) return body;
  return body.split(clause).join('').replace(/\n{3,}/g, '\n\n').trim();
}

module.exports = { openBalanceInvoices, openBalanceSummary, openBalanceExists, rowIsSelfPayDue, pastDueSmsLineForCustomer, stripBalanceLineFromBody, MAX_OPEN_INVOICES };
