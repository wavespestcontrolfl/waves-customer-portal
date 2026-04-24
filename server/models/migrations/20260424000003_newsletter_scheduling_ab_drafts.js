/**
 * Newsletter feature expansion — scheduling, A/B subject testing, AI drafts.
 *
 *   • newsletter_sends.scheduled_for     timestamptz for deferred sends
 *   • newsletter_sends.subject_b         optional second subject for A/B
 *   • newsletter_sends.ai_prompt         prompt used to draft (for re-rolls)
 *   • newsletter_send_deliveries.ab_variant 'a' | 'b' | null
 *
 * The existing segment_filter jsonb column on newsletter_sends is already
 * present from 20260418000008 — no new column needed for segmentation.
 */

exports.up = async function (knex) {
  await knex.schema.alterTable('newsletter_sends', (t) => {
    t.timestamp('scheduled_for');
    t.string('subject_b');
    t.text('ai_prompt');
    t.index(['scheduled_for']);
  });

  await knex.schema.alterTable('newsletter_send_deliveries', (t) => {
    t.string('ab_variant', 1);  // 'a' | 'b' | null
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('newsletter_send_deliveries', (t) => {
    t.dropColumn('ab_variant');
  });
  await knex.schema.alterTable('newsletter_sends', (t) => {
    t.dropIndex(['scheduled_for']);
    t.dropColumn('scheduled_for');
    t.dropColumn('subject_b');
    t.dropColumn('ai_prompt');
  });
};
