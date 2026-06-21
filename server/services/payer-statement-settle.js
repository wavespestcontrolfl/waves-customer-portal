/**
 * Third-party Payer Phase 2 — P3 (pay + settle): statement settlement + the
 * status state machine shared by the pay flow, the Stripe webhook, and admin
 * reconcile.
 *
 *   open → finalized → sent → viewed → processing → paid   (or → void)
 *
 * - PAYABLE statuses (`finalized`/`sent`/`viewed`) are frozen and not-in-flight:
 *   a PaymentIntent may be created from one of these. `open` (accruing), `void`,
 *   `paid`, and `processing` (a confirmed payment in flight) must be refused.
 * - `processing` is entered ONLY on a CONFIRMED money-in-flight webhook (ACH
 *   `payment_intent.processing` / card `succeeded`), never on PI creation — an
 *   unconfirmed PI stays replaceable. Once `processing`, a second pay confirm AND
 *   admin reconcile are both refused.
 * - `overdue` is DERIVED from `due_date`, never a stored status; a past-due
 *   statement is still one of the payable statuses.
 *
 * Settlement CASCADES: paying a statement settles every accrued child invoice on
 * it atomically (one statement → one `payments` row → many invoices marked paid
 * with `paid_at = statement.paid_at`, a settlement marker, not N card charges).
 *
 * Design: docs/design/payer-net-statements-plan.md (Payment / reconciliation /
 * webhook + Cascade-on-settle).
 */

const db = require('../models/db');
const logger = require('./logger');
const { etDateString } = require('../utils/datetime-et');

// Frozen + not-in-flight: a PaymentIntent may be created from these.
const PAYABLE_STATEMENT_STATUSES = new Set(['finalized', 'sent', 'viewed']);
// Settle-to-paid is allowed from a payable status OR from `processing`
// (ACH that confirmed, or a card that went straight to succeeded). Never from
// `open` / `void` / `paid`.
const SETTLEABLE_STATEMENT_STATUSES = new Set(['finalized', 'sent', 'viewed', 'processing']);

const isPayableStatementStatus = (status) => PAYABLE_STATEMENT_STATUSES.has(status);

/**
 * The payable status a statement falls back to when its payment fails/cancels —
 * the latest delivery state it actually reached, derived from its timestamps. We
 * never store a "prior status"; viewed_at / sent_at / finalized_at are the truth.
 */
function priorPayableStatus(stmt) {
  if (stmt?.viewed_at) return 'viewed';
  if (stmt?.sent_at) return 'sent';
  return 'finalized';
}

/**
 * Cascade-settle a statement to `paid`. MUST run inside the caller's transaction
 * (webhook or admin reconcile). Idempotent: a statement already `paid` is a
 * no-op (duplicate/late webhook). Throws if settled from a non-settleable status.
 *
 * `settlement.amountCents` = the CHARGED total (surcharged for a card; bare total
 * for ACH/offline). The base/surcharge split rides the `*_cents` columns.
 */
async function settleStatementPaid(statementId, settlement = {}, { database = db, allowedStatuses = SETTLEABLE_STATEMENT_STATUSES } = {}) {
  const stmt = await database('payer_statements').where({ id: statementId }).forUpdate().first();
  if (!stmt) throw new Error(`settleStatementPaid: statement ${statementId} not found`);
  if (stmt.status === 'paid') {
    return { ok: true, alreadyPaid: true, statement: stmt };
  }
  // Webhook settles from any payable status OR `processing` (ACH confirmed);
  // an offline reconcile passes the PAYABLE-only set so it can't settle a
  // statement whose online payment is already in flight (double collection).
  if (!allowedStatuses.has(stmt.status)) {
    const err = new Error(`statement ${statementId} not settleable from '${stmt.status}'`);
    err.statusCode = (stmt.status === 'processing') ? 409 : 400;
    throw err;
  }

  const {
    paymentMethod = 'offline',
    processor = null,
    stripePaymentIntentId = null,
    stripeChargeId = null,
    amountCents,
    baseAmountCents = null,
    surchargeAmountCents = 0,
    surchargeRateBps = 0,
    surchargePolicyVersion = null,
    cardFunding = null,
    cardBrand = null,
    source = 'unknown',
  } = settlement;

  if (!Number.isFinite(amountCents)) throw new Error('settleStatementPaid: numeric amountCents required');

  // One settlement timestamp shared by the statement AND its children so a child's
  // paid_at is a true settlement marker (= statement.paid_at), not a per-row clock.
  const paidAt = new Date();

  await database('payer_statements').where({ id: statementId }).update({
    status: 'paid',
    paid_at: paidAt,
    payment_method: paymentMethod,
    stripe_charge_id: stripeChargeId || stmt.stripe_charge_id || null,
    stripe_payment_intent_id: stripePaymentIntentId || stmt.stripe_payment_intent_id || null,
    updated_at: paidAt,
  });

  // Cascade — accrued children are `draft`; settle every non-void/non-paid one.
  const childrenSettled = await database('invoices')
    .where({ payer_statement_id: statementId })
    .whereNotIn('status', ['void', 'paid'])
    .update({ status: 'paid', paid_at: paidAt, updated_at: paidAt });

  // ONE payer-scoped ledger row (customer_id NULL — a statement spans many homes).
  await database('payments').insert({
    customer_id: null,
    payer_id: stmt.payer_id,
    statement_id: statementId,
    processor,
    stripe_payment_intent_id: stripePaymentIntentId,
    stripe_charge_id: stripeChargeId,
    payment_date: etDateString(),
    amount: amountCents / 100,
    base_amount_cents: baseAmountCents,
    surcharge_amount_cents: surchargeAmountCents || 0,
    surcharge_rate_bps: surchargeRateBps || 0,
    surcharge_policy_version: surchargePolicyVersion,
    card_funding: cardFunding,
    card_brand: cardBrand,
    status: 'paid',
    description: `Payer statement S-${statementId} settlement (${paymentMethod})`,
    // `payments` has no `payment_method` string column (only payment_method_id FK)
    // — the method rides metadata; payer_statements.payment_method holds it too.
    metadata: JSON.stringify({ statement_id: statementId, payer_id: stmt.payer_id, payment_method: paymentMethod, source }),
  });

  logger.info(`[payer-statement-settle] statement ${statementId} → paid via ${paymentMethod}; ${childrenSettled} child invoice(s) cascaded (${source})`);
  return { ok: true, statement: { ...stmt, status: 'paid', paid_at: paidAt }, childrenSettled };
}

/**
 * Enter `processing` on a CONFIRMED money-in-flight webhook, ONLY from a payable
 * status and ONLY for the statement's active PI. Atomic conditional update —
 * returns true if it moved. A stale/replaced PI's event matches nothing.
 */
async function markStatementProcessing(statementId, piId, { database = db } = {}) {
  const moved = await database('payer_statements')
    .where({ id: statementId, stripe_payment_intent_id: piId })
    .whereIn('status', [...PAYABLE_STATEMENT_STATUSES])
    .update({ status: 'processing', updated_at: database.fn.now() });
  return moved > 0;
}

/**
 * Revert `processing → prior payable` on a payment_failed / canceled webhook for
 * the active PI (collectible again). No-op unless currently `processing` on THIS
 * PI. MUST run in the caller's transaction.
 */
async function revertStatementProcessing(statementId, piId, { database = db } = {}) {
  const stmt = await database('payer_statements')
    .where({ id: statementId, stripe_payment_intent_id: piId, status: 'processing' })
    .forUpdate()
    .first();
  if (!stmt) return false;
  await database('payer_statements').where({ id: statementId }).update({
    status: priorPayableStatus(stmt),
    updated_at: database.fn.now(),
  });
  logger.info(`[payer-statement-settle] statement ${statementId} payment ${piId} failed/canceled → ${priorPayableStatus(stmt)}`);
  return true;
}

/**
 * Stamp a statement `viewed` the first time AP opens its pay link (sent → viewed,
 * never a downgrade). `viewed` is a fact, not a dunning exit — reminders continue.
 */
async function markStatementViewed(statementId, { database = db } = {}) {
  return database('payer_statements')
    .where({ id: statementId, status: 'sent' })
    .update({ status: 'viewed', viewed_at: database.fn.now(), updated_at: database.fn.now() });
}

module.exports = {
  PAYABLE_STATEMENT_STATUSES,
  SETTLEABLE_STATEMENT_STATUSES,
  isPayableStatementStatus,
  priorPayableStatus,
  settleStatementPaid,
  markStatementProcessing,
  revertStatementProcessing,
  markStatementViewed,
};
