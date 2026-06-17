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

module.exports = {
  VALID_SOURCES,
  round2,
  getBalance,
  getLedger,
  postCreditMovement,
};
