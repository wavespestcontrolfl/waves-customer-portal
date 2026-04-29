/**
 * Backfill newsletter_subscribers.customer_id where the subscriber's email
 * already matches an existing customer row but customer_id was never set.
 *
 * The column was added in 20260418000008 but only one of the four
 * subscribe paths (the public-quote dual-write) ever populated it, and
 * even that one hard-coded id: null. As a result the "Customers only"
 * segment filter in the composer matched almost no rows. Going forward,
 * services/newsletter-subscribers.js#linkToCustomer is called from every
 * subscribe path so new rows link automatically — this migration cleans
 * up the historical state.
 *
 * Case-insensitive on the customers side (see linkToCustomer for the
 * rationale).
 */

exports.up = async function (knex) {
  await knex.raw(`
    UPDATE newsletter_subscribers ns
       SET customer_id = c.id, updated_at = NOW()
      FROM customers c
     WHERE ns.customer_id IS NULL
       AND ns.email = LOWER(c.email)
  `);
};

exports.down = async function () {
  // No-op. The column itself isn't dropped here, and clearing customer_id
  // would erase the new auto-link writes from production traffic.
};
