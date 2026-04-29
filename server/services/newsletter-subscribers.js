/**
 * Shared subscriber helpers — used by every code path that adds, resubs,
 * or links a newsletter subscriber.
 *
 * Today this is just the customer-link helper, but it's the obvious home
 * for the consolidation called out in the audit (§9.3 — three subscribe
 * paths with subtly different validation): when that lands, fold the
 * insert/resub logic in here too.
 */

const db = require('../models/db');

/**
 * Link a newsletter subscriber to its matching customer (by email) when
 * one isn't linked yet. Case-insensitive on the customers side because
 * customer rows come from many entry points (booking, lead webhooks,
 * Twilio call ingestion, admin add) and not all of them lowercase email
 * before insert. Idempotent: only touches rows where customer_id IS NULL,
 * so calling repeatedly on the same email is a no-op.
 *
 * Without this, the "Customers only" / "Leads only" segment filters in
 * the composer match ~zero subscribers because customer_id was NULL on
 * every legacy row.
 */
async function linkToCustomer(email) {
  if (!email) return;
  const lc = email.toLowerCase();
  await db.raw(
    `UPDATE newsletter_subscribers
       SET customer_id = c.id, updated_at = NOW()
       FROM customers c
       WHERE newsletter_subscribers.email = ?
         AND LOWER(c.email) = ?
         AND newsletter_subscribers.customer_id IS NULL`,
    [lc, lc],
  );
}

module.exports = { linkToCustomer };
