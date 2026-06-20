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
  const applyAmt = round2(Math.min(bal, remainingDue));
  if (fullCoverageOnly && applyAmt < remainingDue) {
    return { applyAmt: 0, fullyCovered: false, newCreditApplied: applied, skipReason: 'partial_suppressed' };
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
async function applyAccountCreditToInvoice({ invoiceId, createdBy = 'system' }, trx = null) {
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
    // Lock the customer row (also locked by postCreditMovement) so the balance
    // we price against can't move under us.
    const customer = await t('customers').where({ id: invoice.customer_id }).forUpdate().first('id', 'account_credits');
    // FAIL CLOSED to full coverage only: a partial application would leave the
    // invoice collectible with credit_applied set, but the Stripe/Terminal/autopay
    // charge paths still price from invoice.total (not total − credit_applied), so
    // a later payment would over-collect. The follow-up PR teaches those paths to
    // bill amount due and re-enables partial here.
    const { applyAmt, fullyCovered, newCreditApplied, skipReason } = computeApplication({
      total: invoice.total,
      creditApplied: invoice.credit_applied,
      balance: customer?.account_credits || 0,
      fullCoverageOnly: true,
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
      updates.prepaid_prev_status = invoice.status;
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
  restoreAccountCreditForVoidedInvoice,
};
