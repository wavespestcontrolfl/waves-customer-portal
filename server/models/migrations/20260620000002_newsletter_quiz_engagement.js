/**
 * Newsletter Phase 2 — in-email engagement quiz.
 *
 * Adds a per-recipient engagement token + quiz-answer ledger to
 * newsletter_send_deliveries. The token is the auth for the public
 * /api/public/newsletter/quiz/:token endpoint (same model as
 * unsubscribe_token): the recipient proves ownership by holding the
 * uuid we mailed only to them, so a single answer click can tag the
 * matching subscriber for segmentation without a login.
 *
 * One delivery row already == one recipient per campaign (unique
 * [send_id, subscriber_id]), so the quiz answer lives here rather than in
 * a new table — it mirrors the existing opened_at/clicked_at engagement
 * columns this table already carries.
 */

exports.up = async function (knex) {
  const hasEngagementToken = await knex.schema.hasColumn('newsletter_send_deliveries', 'engagement_token');
  if (!hasEngagementToken) {
    await knex.schema.alterTable('newsletter_send_deliveries', (t) => {
      // gen_random_uuid() is volatile, so ADD COLUMN evaluates it per existing
      // row (no fast-path) — every row gets a distinct token, satisfying the
      // unique index below.
      t.uuid('engagement_token').defaultTo(knex.raw('gen_random_uuid()'));
      t.string('quiz_id');         // which quiz the recipient answered (e.g. 'lawn-headache-v1')
      t.string('quiz_answer');     // the answer key they clicked (e.g. 'brown-patch')
      t.timestamp('quiz_answered_at');
    });

    // Defensive backfill for any row the volatile default somehow skipped
    // (matches the unsubscribe_token backfill in 20260418000008).
    await knex.raw(`
      UPDATE newsletter_send_deliveries
      SET engagement_token = gen_random_uuid()
      WHERE engagement_token IS NULL
    `);

    // Unique so a token resolves to exactly one delivery (one recipient).
    await knex.schema.alterTable('newsletter_send_deliveries', (t) => {
      t.unique(['engagement_token']);
    });
  }
};

exports.down = async function (knex) {
  const hasEngagementToken = await knex.schema.hasColumn('newsletter_send_deliveries', 'engagement_token');
  if (hasEngagementToken) {
    await knex.schema.alterTable('newsletter_send_deliveries', (t) => {
      t.dropColumn('engagement_token');
      t.dropColumn('quiz_id');
      t.dropColumn('quiz_answer');
      t.dropColumn('quiz_answered_at');
    });
  }
};
