/**
 * Codex #4813 r1 P1: a quote-wizard lead whose newsletter opt-in needs
 * double opt-in is enrolled in `new_lead` only after confirmation
 * (public-newsletter.js maybeEnrollConfirmedQuoteLead). That deferred
 * enrollment had no lead id, so the consultation-booking email block
 * (dark, GATE_LEAD_INSPECTION_LINK) always rendered empty for those leads.
 * `quote_lead_id` carries the lead through the pending flag: set by the
 * server-side quote route alongside quote_lead_automation_pending, read and
 * cleared at confirmation. Nullable; no FK (leads rows are soft-deleted and
 * the value is advisory context, not ownership).
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('newsletter_subscribers'))) return;
  if (await knex.schema.hasColumn('newsletter_subscribers', 'quote_lead_id')) return;
  await knex.schema.alterTable('newsletter_subscribers', (t) => {
    t.uuid('quote_lead_id').nullable();
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('newsletter_subscribers'))) return;
  if (!(await knex.schema.hasColumn('newsletter_subscribers', 'quote_lead_id'))) return;
  await knex.schema.alterTable('newsletter_subscribers', (t) => {
    t.dropColumn('quote_lead_id');
  });
};
