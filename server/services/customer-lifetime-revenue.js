/**
 * Lifetime revenue: what a customer has paid, net of refunds.
 *
 * Paid payments rows (amount minus refund_amount) plus estimate deposits.
 * Deposits deliberately have no payments row (estimate-deposits.js), so a
 * payments-only sum missed every deposit a customer paid. A deposit counts as
 * the invoice stats' collected cash (invoice.js): face minus face refunds,
 * plus the card surcharge minus refunded_surcharge, or, when that stamp is
 * NULL (a legacy refund), the surcharge prorated by the unrefunded face. A
 * deposit row with no customer_id belongs to its estimate's customer.
 *
 * customers.lifetime_revenue has no production writer (it reads $0); never
 * read it for a customer's revenue.
 */

// One paid payments row, net of refunds; one estimate deposit, net of refunds (see the header). Both
// LIFETIME_REVENUE_SQL and netCollections read these, so a lifetime and a windowed sum never disagree.
const PAYMENT_NET_SQL = 'p.amount - COALESCE(p.refund_amount, 0)';
const DEPOSIT_NET_SQL = `GREATEST(d.amount - COALESCE(d.refunded_amount, 0), 0)
      + COALESCE(CASE WHEN d.refunded_surcharge IS NOT NULL
          THEN GREATEST(COALESCE(d.card_surcharge, 0) - d.refunded_surcharge, 0)
          ELSE COALESCE(d.card_surcharge, 0) * GREATEST(d.amount - COALESCE(d.refunded_amount, 0), 0) / NULLIF(d.amount, 0) END, 0)`;

// Correlated on customers.id: select it from a query over the customers table.
const LIFETIME_REVENUE_SQL = `((SELECT COALESCE(SUM(${PAYMENT_NET_SQL}), 0)
    FROM payments p WHERE p.customer_id = customers.id AND p.status = 'paid')
  + (SELECT COALESCE(SUM(${DEPOSIT_NET_SQL}), 0)
    FROM estimate_deposits d LEFT JOIN estimates e ON e.id = d.estimate_id
    WHERE COALESCE(d.customer_id, e.customer_id) = customers.id AND d.received_at IS NOT NULL))`;

async function lifetimeRevenueFor(knex, customerId) {
  const row = await knex('customers')
    .where('customers.id', customerId)
    .first(knex.raw(`${LIFETIME_REVENUE_SQL}::float AS net`));
  return parseFloat(row?.net || 0);
}

/**
 * Each net collection of these customers on or after `from` (a Date): the same paid payments and deposits as
 * LIFETIME_REVENUE_SQL, dated (payment_date / received_at). Returns [{ customer_id, at, net }].
 */
async function netCollections(knex, customerIds, from) {
  if (!customerIds.length) return [];
  const payments = await knex('payments as p')
    .whereIn('p.customer_id', customerIds)
    .where('p.status', 'paid')
    .where('p.payment_date', '>=', from)
    .select('p.customer_id', 'p.payment_date as at', knex.raw(`(${PAYMENT_NET_SQL})::float AS net`));
  const deposits = await knex('estimate_deposits as d')
    .leftJoin('estimates as e', 'e.id', 'd.estimate_id')
    .whereIn(knex.raw('COALESCE(d.customer_id, e.customer_id)'), customerIds)
    .whereNotNull('d.received_at')
    .where('d.received_at', '>=', from)
    .select(knex.raw('COALESCE(d.customer_id, e.customer_id) AS customer_id'), 'd.received_at as at',
      knex.raw(`(${DEPOSIT_NET_SQL})::float AS net`));
  return [...payments, ...deposits];
}

module.exports = { LIFETIME_REVENUE_SQL, lifetimeRevenueFor, netCollections };
