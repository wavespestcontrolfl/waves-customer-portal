/**
 * Per-edition reader feedback (owner directive 2026-07-17): every edition
 * ends with "How was this week's newsletter? 👍 Great · 😐 Okay · 👎 Needs
 * work". The reaction lands on the recipient's delivery row — same pattern
 * as the quiz columns (20260620000002) — so per-send tallies come from a
 * GROUP BY with no new table, and one row per (send, subscriber) makes the
 * vote naturally idempotent (a changed mind overwrites, never double-counts).
 *
 * feedback_missing holds the 👎 follow-up ("what was missing?") as a jsonb
 * array of option keys from newsletter-feedback.js — the config there is the
 * only allowlist, mirroring how quiz answers are validated.
 */

exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('newsletter_send_deliveries');
  if (!hasTable) return;

  const hasReaction = await knex.schema.hasColumn('newsletter_send_deliveries', 'feedback_reaction');
  if (!hasReaction) {
    await knex.schema.alterTable('newsletter_send_deliveries', (t) => {
      t.string('feedback_reaction');       // 'great' | 'okay' | 'needs-work'
      t.jsonb('feedback_missing');         // 👎 follow-up option keys, null otherwise
      t.timestamp('feedback_at');
      t.index(['send_id', 'feedback_reaction'], 'nsd_send_feedback_reaction_idx');
    });
  }
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('newsletter_send_deliveries');
  if (!hasTable) return;

  const hasReaction = await knex.schema.hasColumn('newsletter_send_deliveries', 'feedback_reaction');
  if (hasReaction) {
    await knex.schema.alterTable('newsletter_send_deliveries', (t) => {
      t.dropIndex(['send_id', 'feedback_reaction'], 'nsd_send_feedback_reaction_idx');
      t.dropColumn('feedback_reaction');
      t.dropColumn('feedback_missing');
      t.dropColumn('feedback_at');
    });
  }
};
