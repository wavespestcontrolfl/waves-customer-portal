/**
 * Customer account credit — the single place that moves money in or out of
 * a customer's credit balance.
 *
 * Invariant: `customers.account_credits` is a cached running balance and
 * `customer_credit_ledger` is the append-only history. They are written in
 * the SAME transaction by `postCreditMovement`, with a row lock on the
 * customer, so concurrent movements serialize and the cache can never drift
 * from the sum of the ledger. Never write `account_credits` directly — go
 * through this module.
 */
const db = require('../models/db');
const logger = require('./logger');

const VALID_SOURCES = Object.freeze([
  'manual', 'adjustment', 'invoice_application', 'invoice_prepaid', 'referral',
]);

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

async function getBalance(customerId) {
  const row = await db('customers').where({ id: customerId }).first('account_credits');
  if (!row) return null;
  return round2(row.account_credits || 0);
}

async function getLedger(customerId, { limit = 100 } = {}) {
  return db('customer_credit_ledger')
    .where({ customer_id: customerId })
    .orderBy('created_at', 'desc')
    .limit(limit);
}

/**
 * Apply a signed credit movement atomically.
 *
 *   delta > 0  → add credit to the balance (issuance, refund, referral)
 *   delta < 0  → consume credit (applied to an invoice)
 *
 * Locks the customer row, recomputes the balance, refuses to let the
 * balance go negative, updates the cache, and writes the ledger row. Pass
 * an existing knex transaction as `trx` to fold this into a larger unit of
 * work (e.g. the invoice prepaid transition); otherwise it opens its own.
 *
 * Returns { balanceAfter, entry }.
 */
async function postCreditMovement({
  customerId, delta, source, invoiceId = null, referralId = null,
  note = null, createdBy = null,
}, trx = null) {
  const amount = round2(delta);
  if (!customerId) throw new Error('customerId is required');
  if (!Number.isFinite(amount) || amount === 0) {
    throw new Error('delta must be a non-zero amount');
  }
  if (!VALID_SOURCES.includes(source)) {
    throw new Error(`source must be one of: ${VALID_SOURCES.join(', ')}`);
  }

  const run = async (t) => {
    const customer = await t('customers')
      .where({ id: customerId })
      .forUpdate()
      .first('id', 'account_credits');
    if (!customer) {
      const err = new Error('Customer not found');
      err.statusCode = 404;
      err.isOperational = true;
      throw err;
    }
    const current = round2(customer.account_credits || 0);
    const balanceAfter = round2(current + amount);
    if (balanceAfter < 0) {
      const err = new Error(
        `Insufficient account credit — balance is $${current.toFixed(2)}, `
        + `cannot apply $${Math.abs(amount).toFixed(2)}`,
      );
      err.statusCode = 400;
      err.isOperational = true;
      throw err;
    }

    await t('customers').where({ id: customerId }).update({
      account_credits: balanceAfter,
      updated_at: t.fn.now(),
    });

    const [entry] = await t('customer_credit_ledger').insert({
      customer_id: customerId,
      delta: amount,
      balance_after: balanceAfter,
      source,
      invoice_id: invoiceId,
      referral_id: referralId,
      note: note ? String(note).slice(0, 1000) : null,
      created_by: createdBy ? String(createdBy).slice(0, 200) : null,
    }).returning('*');

    return { balanceAfter, entry };
  };

  const result = trx ? await run(trx) : await db.transaction(run);
  logger.info(
    `[customer-credit] ${amount >= 0 ? '+' : ''}${amount.toFixed(2)} `
    + `(${source}) → customer ${customerId} balance $${result.balanceAfter.toFixed(2)}`,
  );
  return result;
}

// Ledger `source` → the credit-group `type` the customer portal billing card
// renders (referral / service / promo). Manual issuances + adjustments read as
// "promo"; consumption sources (invoice_application / invoice_prepaid) never
// appear because portalCreditsFromLedger only maps positive issuances.
const CREDIT_DISPLAY_TYPE_BY_SOURCE = Object.freeze({
  referral: 'referral',
  manual: 'promo',
  adjustment: 'promo',
});

// Controlled, customer-safe label per display type. We deliberately do NOT
// surface the raw ledger `note`: manual/adjustment notes are free-form operator
// input (internal comments / PII), and even the system referral note embeds the
// referee's name. The customer only ever sees one of these fixed labels.
const PUBLIC_CREDIT_LABEL_BY_TYPE = Object.freeze({
  referral: 'Referral reward',
  service: 'Service credit',
  promo: 'Account credit',
});

/**
 * Map raw customer_credit_ledger rows into the shape the portal billing
 * "Credits" card expects ({ type, description, amount, date }). Only issuances
 * (delta > 0) are shown as available credit — consumption rows (delta < 0, the
 * credit being applied to an invoice) are spend, not an available balance.
 * `description` is a controlled public label (never the raw operator note).
 */
function portalCreditsFromLedger(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .filter((e) => Number(e.delta) > 0)
    .map((e) => {
      const type = CREDIT_DISPLAY_TYPE_BY_SOURCE[e.source] || 'promo';
      return {
        id: e.id,
        type,
        description: PUBLIC_CREDIT_LABEL_BY_TYPE[type] || PUBLIC_CREDIT_LABEL_BY_TYPE.promo,
        amount: round2(e.delta),
        date: e.created_at,
      };
    });
}

/**
 * Pure decision math for auto-applying account credit to an invoice. No DB —
 * unit-testable. Given the invoice total, credit already applied, and the
 * customer's available balance, returns how much to apply now and whether the
 * invoice ends fully covered. `fullCoverageOnly` suppresses partial application.
 */
function computeApplication({ total, creditApplied = 0, balance = 0, fullCoverageOnly = false }) {
  const t = round2(total);
  const applied = round2(creditApplied);
  const bal = round2(balance);
  if (!(t > 0)) return { applyAmt: 0, fullyCovered: false, newCreditApplied: applied, skipReason: 'zero_total' };
  const remainingDue = round2(t - applied);
  if (remainingDue <= 0) return { applyAmt: 0, fullyCovered: true, newCreditApplied: applied, skipReason: 'already_covered' };
  if (bal <= 0) return { applyAmt: 0, fullyCovered: false, newCreditApplied: applied, skipReason: 'no_balance' };
  let applyAmt = round2(Math.min(bal, remainingDue));
  if (fullCoverageOnly && applyAmt < remainingDue) {
    return { applyAmt: 0, fullyCovered: false, newCreditApplied: applied, skipReason: 'partial_suppressed' };
  }
  // Never leave an UNCOLLECTIBLE sub-minimum residual: Stripe/Terminal reject a
  // charge under $0.50. If a partial would leave 0 < residual < min, apply less so
  // the remaining balance is at least the minimum (still collectible); if even
  // that is impossible (a sub-$0.50 invoice the balance can't fully cover), skip.
  const MIN_COLLECTIBLE = 0.5;
  if (round2(remainingDue - applyAmt) > 0 && round2(remainingDue - applyAmt) < MIN_COLLECTIBLE) {
    applyAmt = round2(remainingDue - MIN_COLLECTIBLE);
  }
  if (applyAmt <= 0) {
    return { applyAmt: 0, fullyCovered: false, newCreditApplied: applied, skipReason: 'residual_below_minimum' };
  }
  const newCreditApplied = round2(applied + applyAmt);
  return { applyAmt, fullyCovered: round2(t - newCreditApplied) <= 0, newCreditApplied, skipReason: null };
}

/**
 * Draw the customer's account credit down against an invoice's amount due,
 * recording it as `credit_applied` (and flipping to 'prepaid' when fully
 * covered). Reuses the same money invariants as the admin prepay flow. Skips
 * payer-billed (third-party) invoices, non-collectible statuses, $0 totals, and
 * already-covered invoices. Idempotent: re-running applies only the remaining
 * due, up to the remaining balance. Best-effort caller contract — callers must
 * not let a credit hiccup roll back invoice creation.
 */
async function applyAccountCreditToInvoice({ invoiceId, createdBy = 'system', fullCoverageOnly = false }, trx = null) {
  const run = async (t) => {
    const invoice = await t('invoices').where({ id: invoiceId }).forUpdate().first();
    if (!invoice) return { applied: 0, skipped: 'not_found' };
    // Homeowner credit must never touch a third-party (payer-billed) invoice.
    if (invoice.payer_id) return { applied: 0, skipped: 'payer_billed' };
    try {
      // eslint-disable-next-line global-require
      require('./invoice-helpers').assertInvoiceCollectible(invoice.status);
    } catch {
      return { applied: 0, skipped: 'uncollectible' };
    }
    // Money-agreement (PI ↔ invoice ↔ webhook): never mark an invoice prepaid
    // while a Stripe PaymentIntent exists — its client secret could still charge
    // the card, leaving the webhook to reconcile against a terminal prepaid
    // invoice and diverge. Fail CLOSED: skip (don't apply) when a PI is attached.
    // The invoice is locked, so this re-checks the PI id under the lock. (A fresh
    // completion invoice has no PI; the admin apply-credit route, by contrast,
    // explicitly triages/cancels the PI — auto-apply simply declines.)
    if (invoice.stripe_payment_intent_id) return { applied: 0, skipped: 'has_payment_intent' };
    // An active payment plan snapshots total_balance at creation; auto-applying
    // credit now would reduce amount due while the plan keeps collecting the
    // original balance (over-collection + consumed credit). Skip — the operator
    // can still apply credit explicitly via the admin route. Checked under the
    // invoice lock.
    const activePlan = await t('payment_plans')
      .where({ invoice_id: invoiceId, status: 'active' })
      .first('id');
    if (activePlan) return { applied: 0, skipped: 'active_payment_plan' };
    // Lock the customer row (also locked by postCreditMovement) so the balance
    // we price against can't move under us.
    const customer = await t('customers').where({ id: invoice.customer_id }).forUpdate().first('id', 'account_credits');
    // Partial application is now safe: every charge path (Stripe PI / autopay /
    // Terminal) and the webhook amount-verification price from amount due
    // (total − credit_applied) via invoiceAmountDue, so a collectible invoice
    // with credit_applied set is charged the reduced amount, not the full total.
    // Callers may still force full coverage via fullCoverageOnly.
    const { applyAmt, fullyCovered, newCreditApplied, skipReason } = computeApplication({
      total: invoice.total,
      creditApplied: invoice.credit_applied,
      balance: customer?.account_credits || 0,
      fullCoverageOnly,
    });
    if (applyAmt <= 0) return { applied: 0, skipped: skipReason || 'nothing_to_apply' };

    const { balanceAfter } = await postCreditMovement({
      customerId: invoice.customer_id,
      delta: -applyAmt,
      source: 'invoice_application',
      invoiceId,
      note: 'Account credit applied to invoice',
      createdBy,
    }, t);

    const updates = { credit_applied: newCreditApplied, updated_at: t.fn.now() };
    if (fullyCovered) {
      // Mirror the admin prepay close-out so paid_at-keyed paths treat it as
      // closed; status stays 'prepaid' (not 'paid') so collected-revenue stats
      // don't double-count a credit (no cash) against the payments ledger.
      updates.status = 'prepaid';
      // Normalize the TRANSIENT 'sending' claim (a pre-claimed project / scheduled
      // send may call this mid-send) to 'sent' — the status a send in progress
      // resolves to — so a later /reverse-prepaid can't reopen the invoice stuck
      // in 'sending' (which would strand it / let the stale-send sweeper mutate it).
      updates.prepaid_prev_status = String(invoice.status || '').toLowerCase() === 'sending'
        ? 'sent'
        : invoice.status;
      updates.prepaid_at = t.fn.now();
      updates.prepaid_by = createdBy;
      updates.paid_at = t.fn.now();
    }
    await t('invoices').where({ id: invoiceId }).update(updates);
    return {
      applied: applyAmt,
      creditApplied: newCreditApplied,
      fullyCovered,
      balanceAfter,
      status: fullyCovered ? 'prepaid' : invoice.status,
    };
  };
  return trx ? run(trx) : db.transaction(run);
}

/**
 * Return an invoice's applied account credit to the customer's balance when the
 * invoice is voided, and zero out credit_applied + prepaid stamps. Runs inside
 * the void transaction (mirrors restoreDepositCreditForVoidedInvoice). No-op
 * when nothing was applied. credit_applied is purely account-credit (estimate
 * deposits are tracked separately), so this never touches deposit credit.
 */
async function restoreAccountCreditForVoidedInvoice({ invoice, createdBy = 'system' }, trx) {
  const restore = round2(invoice?.credit_applied || 0);
  if (restore <= 0) return { restored: 0 };
  await postCreditMovement({
    customerId: invoice.customer_id,
    delta: restore,
    source: 'adjustment',
    invoiceId: invoice.id,
    note: `Account credit returned — invoice ${invoice.invoice_number || invoice.id} voided`,
    createdBy,
  }, trx);
  await trx('invoices').where({ id: invoice.id }).update({
    credit_applied: 0,
    prepaid_at: null,
    prepaid_by: null,
    prepaid_prev_status: null,
    paid_at: null,
    updated_at: trx.fn.now(),
  });
  return { restored: restore };
}

/**
 * Settle a FULLY refunded invoice: TERMINALIZE it to 'refunded' AND (if it carried
 * account credit) return that credit to the customer's balance. The status flip runs
 * for EVERY full refund from ANY non-terminal status, with or without credit, and is
 * load-bearing two ways: (1) revenue — the invoice-based rollups (getStats
 * total_collected etc.) filter status = 'paid', so a still-'paid' refunded invoice
 * keeps counting as collected, and once credit_applied is zeroed a credit-covered one
 * would jump back to GROSS; (2) settlement correctness — a PRE-SETTLEMENT refund
 * (charge.refunded before payment_intent.succeeded) leaves the invoice
 * 'sent'/'viewed'/'processing', and if not terminalized the later succeeded handler
 * (skips INVOICE_TERMINAL_PAYMENT_STATUSES incl. 'refunded') would settle the
 * fully-refunded charge as 'paid'. paid_at and the other stamps are kept as history.
 * Both callers (admin refund + charge.refunded webhook) invoke this only on FULL
 * refunds. Race-safe + idempotent: the row is locked + re-read under the lock so the
 * two paths can't double-restore, and only a NON-terminal row is flipped, so a
 * replayed event never clobbers an existing void/cancel/refund or re-credits. Runs
 * inside the caller's trx.
 */
async function returnAppliedCreditOnRefund({ invoiceId, createdBy = 'system' }, trx) {
  const inv = await trx('invoices').where({ id: invoiceId }).forUpdate()
    .first('id', 'customer_id', 'invoice_number', 'status', 'credit_applied');
  if (!inv) return { restored: 0 };
  const restore = round2(inv.credit_applied);
  // A FULL refund TERMINALIZES the invoice to 'refunded' from ANY non-terminal
  // status, not just paid/prepaid. A PRE-SETTLEMENT refund (charge.refunded arriving
  // before payment_intent.succeeded) leaves the invoice 'sent'/'viewed'/'processing';
  // if it isn't terminalized here, the later succeeded handler — which skips only
  // INVOICE_TERMINAL_PAYMENT_STATUSES (includes 'refunded') — would settle a
  // fully-refunded charge as 'paid', breaking PI ↔ invoice ↔ webhook agreement. Skip
  // only already-terminal statuses so a replayed event is a no-op and a prior
  // void/cancel isn't clobbered. (Both callers invoke this for FULL refunds only.)
  const alreadyTerminal = ['refunded', 'void', 'canceled', 'cancelled'].includes(String(inv.status || '').toLowerCase());
  const updates = { updated_at: trx.fn.now() };
  if (!alreadyTerminal) updates.status = 'refunded';
  if (restore > 0) updates.credit_applied = 0;
  if (!alreadyTerminal || restore > 0) {
    await trx('invoices').where({ id: invoiceId }).update(updates);
  }
  if (restore > 0) {
    await postCreditMovement({
      customerId: inv.customer_id,
      delta: restore,
      source: 'adjustment',
      invoiceId,
      note: `Account credit returned — invoice ${inv.invoice_number || invoiceId} fully refunded`,
      createdBy,
    }, trx);
  }
  return { restored: restore };
}

/**
 * Post-payment side effects to run when an auto-apply FULLY covers an invoice
 * (it's now prepaid/paid). Mirrors the manual apply-credit + record-payment
 * paths: stop dunning followups and sync any linked annual-prepay term so its
 * future visits get stamped prepaid. Each step is independent + best-effort;
 * a failure here never propagates to the caller (the credit is already applied).
 */
async function runPostFullCoverageSideEffects(invoiceId) {
  try {
    // eslint-disable-next-line global-require
    await require('./invoice-followups').stopOnPayment(invoiceId);
  } catch (e) {
    logger.warn(`[account-credit] stopOnPayment after full coverage failed for ${invoiceId}: ${e.message}`);
  }
  try {
    const inv = await db('invoices').where({ id: invoiceId }).first();
    // eslint-disable-next-line global-require
    if (inv) await require('./annual-prepay-renewals').syncTermForInvoicePayment(inv);
  } catch (e) {
    logger.warn(`[account-credit] annual-prepay term sync after full coverage failed for ${invoiceId}: ${e.message}`);
  }
}

/**
 * Gate-checked, best-effort wrapper around applyAccountCreditToInvoice for the
 * "about to ask for payment" seams — the pay-link send, charge-saved-card, and
 * Terminal handoff paths. Auto-apply otherwise only runs at dispatch completion,
 * so an invoice created any other way (manual, batch, from-service, charge-now)
 * could send a pay link or be charged for the gross total while the customer's
 * account credit sits unused.
 *
 * No-op unless GATE_AUTO_APPLY_ACCOUNT_CREDIT is on. NEVER throws — a credit
 * hiccup must never block sending or charging. Idempotent (applies only the
 * remaining due via the same row-locked path), so it's safe to call at multiple
 * seams and after the completion-time apply. Returns the applyAccountCreditToInvoice
 * result (with `applied` / `fullyCovered`), or null when gated off / on error.
 */
async function autoApplyAccountCreditIfEnabled(invoiceId, { createdBy = 'system', trx = null, deferFullCoverageSideEffects = false } = {}) {
  try {
    // eslint-disable-next-line global-require
    if (!require('../config/feature-gates').gates.autoApplyAccountCredit) return null;
    const result = await applyAccountCreditToInvoice({ invoiceId, createdBy }, trx);
    // When a seam-time apply FULLY covers the invoice (now prepaid / paid_at), run
    // the same post-payment side effects the manual apply-credit + record-payment
    // paths run — otherwise a credit-covered invoice keeps dunning followups armed
    // and, for an annual prepay, leaves its term payment_pending so future visits
    // aren't stamped prepaid. Best-effort + post-commit; never blocks the caller.
    // Skipped when running inside a caller trx (those commit + handle side effects
    // themselves), or when the caller defers them until a later success point (the
    // project report+invoice send applies credit BEFORE building/delivering, and
    // reverses it on failure — running stopOnPayment / term activation here would
    // leave them un-undone after a reversal, so it runs them only once delivered).
    if (result && result.fullyCovered && !trx && !deferFullCoverageSideEffects) {
      await runPostFullCoverageSideEffects(invoiceId);
    }
    return result;
  } catch (err) {
    logger.warn(`[account-credit] seam auto-apply skipped for invoice=${invoiceId}: ${err.message}`);
    return null;
  }
}

/**
 * Reverse a specific amount of auto-applied account credit on a still-collectible
 * invoice — return it to the customer's balance and reduce credit_applied by the
 * same amount (never below 0). Used when a seam applied credit but delivery then
 * failed (no recipient / provider error), so we don't consume credit + edit-lock
 * an invoice whose pay link never went out. Runs in its own transaction or the
 * caller's trx. No-op for $0 or already-cleared credit.
 */
async function reverseAppliedCredit({ invoiceId, amount, createdBy = 'system', note = null }, trx = null) {
  const want = round2(amount);
  if (!(want > 0)) return { reversed: 0 };
  const run = async (t) => {
    const inv = await t('invoices').where({ id: invoiceId }).forUpdate()
      .first('id', 'customer_id', 'invoice_number', 'credit_applied', 'status', 'stripe_payment_intent_id');
    if (!inv) return { reversed: 0 };
    // Refuse to reverse once a payment is in flight / settled against the REDUCED
    // amount. The send paths apply credit before they finish, so a concurrent
    // /pay setup, charge-card, or webhook may have already charged
    // total − credit_applied; returning the credit now would break reconciliation
    // (the PaymentIntent / payments row still reflects the reduced charge). Only a
    // still-collectible invoice with NO attached PaymentIntent is safe to reverse.
    // 'sending' included: a competing send may hold the claim and be building the
    // reduced pay link right now — the loser of that race must NOT reverse the
    // credit out from under it. Legit reversal paths run AFTER restoreSendClaim
    // (status already back to a collectible value), so they're unaffected.
    const settledOrInFlight = ['paid', 'prepaid', 'processing', 'sending', 'refunded', 'void', 'canceled', 'cancelled']
      .includes(String(inv.status || '').toLowerCase());
    if (settledOrInFlight || inv.stripe_payment_intent_id) {
      return { reversed: 0, skipped: 'payment_in_flight' };
    }
    const reverse = Math.min(want, round2(inv.credit_applied || 0));
    if (!(reverse > 0)) return { reversed: 0 };
    await t('invoices').where({ id: invoiceId })
      .update({ credit_applied: round2(round2(inv.credit_applied || 0) - reverse), updated_at: t.fn.now() });
    await postCreditMovement({
      customerId: inv.customer_id,
      delta: reverse,
      source: 'adjustment',
      invoiceId,
      note: note || `Auto-applied credit reversed — invoice ${inv.invoice_number || invoiceId} not delivered`,
      createdBy,
    }, t);
    return { reversed: reverse };
  };
  return trx ? run(trx) : db.transaction(run);
}

module.exports = {
  VALID_SOURCES,
  CREDIT_DISPLAY_TYPE_BY_SOURCE,
  round2,
  getBalance,
  getLedger,
  postCreditMovement,
  portalCreditsFromLedger,
  computeApplication,
  applyAccountCreditToInvoice,
  autoApplyAccountCreditIfEnabled,
  runPostFullCoverageSideEffects,
  reverseAppliedCredit,
  restoreAccountCreditForVoidedInvoice,
  returnAppliedCreditOnRefund,
};
