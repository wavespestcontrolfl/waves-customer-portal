/**
 * When the click auto-link linked this review (stamped in the same
 * transaction, with the same Date, as the customer's review_marked_at).
 * Ownership marker for reversals: the sole-basis flag reversal may clear
 * has_left_google_review only while customers.review_marked_at still equals
 * this moment — any LATER human mark (Customer 360 toggle re-confirm, manual
 * attribution) bumps review_marked_at past it and wins (GH codex #3483 r6:
 * a re-match must never clear an independently confirmed flag).
 */
exports.up = async function (knex) {
  const has = await knex.schema.hasColumn('google_reviews', 'auto_linked_at');
  if (!has) {
    await knex.schema.alterTable('google_reviews', (t) => {
      // Explicit useTz — compared for equality against customers.
      // review_marked_at (timestamptz); knex on pg already defaults to
      // timestamptz, this just pins it.
      t.timestamp('auto_linked_at', { useTz: true });
    });
  }
};

exports.down = async function (knex) {
  const has = await knex.schema.hasColumn('google_reviews', 'auto_linked_at');
  if (has) {
    await knex.schema.alterTable('google_reviews', (t) => {
      t.dropColumn('auto_linked_at');
    });
  }
};
