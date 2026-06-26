/**
 * Partial unique index guaranteeing at most one UNRESOLVED signal of a given
 * type per customer.
 *
 * The event-driven rescore path (event-rescore.js) can run signal-detector
 * concurrently for the same customer when two inbound SMS webhooks arrive close
 * together. signal-detector dedupes by reading unresolved customer_signals then
 * inserting — a read-then-write race that, without this index, lets both calls
 * insert the same signal type and double-count its weight in the score. The
 * index makes the insert atomically idempotent (the loser gets 23505, which
 * signal-detector swallows). A resolved signal can still be re-detected later
 * (the predicate only constrains resolved = false rows).
 */
exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('customer_signals'))) return;

  // Collapse any pre-existing unresolved duplicates first (keep one row per
  // customer+type) so the unique index can be created.
  await knex.raw(`
    DELETE FROM customer_signals a
    USING customer_signals b
    WHERE a.resolved = false
      AND b.resolved = false
      AND a.customer_id = b.customer_id
      AND a.signal_type = b.signal_type
      AND a.ctid > b.ctid
  `);

  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS customer_signals_unresolved_uniq
    ON customer_signals (customer_id, signal_type)
    WHERE resolved = false
  `);
};

exports.down = async function (knex) {
  await knex.raw('DROP INDEX IF EXISTS customer_signals_unresolved_uniq');
};
