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

// Correlated on customers.id: select it from a query over the customers table.
const LIFETIME_REVENUE_SQL = `((SELECT COALESCE(SUM(p.amount - COALESCE(p.refund_amount, 0)), 0)
    FROM payments p WHERE p.customer_id = customers.id AND p.status = 'paid')
  + (SELECT COALESCE(SUM(GREATEST(d.amount - COALESCE(d.refunded_amount, 0), 0)
      + COALESCE(CASE WHEN d.refunded_surcharge IS NOT NULL
          THEN GREATEST(COALESCE(d.card_surcharge, 0) - d.refunded_surcharge, 0)
          ELSE COALESCE(d.card_surcharge, 0) * GREATEST(d.amount - COALESCE(d.refunded_amount, 0), 0) / NULLIF(d.amount, 0) END, 0)), 0)
    FROM estimate_deposits d LEFT JOIN estimates e ON e.id = d.estimate_id
    WHERE COALESCE(d.customer_id, e.customer_id) = customers.id AND d.received_at IS NOT NULL))`;

async function lifetimeRevenueFor(knex, customerId) {
  const row = await knex('customers')
    .where('customers.id', customerId)
    .first(knex.raw(`${LIFETIME_REVENUE_SQL}::float AS net`));
  return parseFloat(row?.net || 0);
}

module.exports = { LIFETIME_REVENUE_SQL, lifetimeRevenueFor };
