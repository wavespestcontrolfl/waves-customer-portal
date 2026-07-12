/**
 * Re-lane open email-dictation triage cards into name_review.
 *
 * email_unverified / email_invalid were unmapped in buildTriageItem's
 * flagToCategoryMap, so their cards defaulted to service_unknown — buried
 * with billing noise instead of surfacing beside the other contact-confirm
 * cards (name_email_mismatch, email_bounce_reverify). The mapping fix in
 * call-routing-gates.js covers new cards; this moves the ones already open.
 * Resolved/dismissed history keeps its original category.
 */

exports.up = async function up(knex) {
  await knex('triage_items')
    .whereIn('reason_code', ['email_unverified', 'email_invalid'])
    .whereIn('status', ['open', 'in_progress'])
    .where({ category: 'service_unknown' })
    .update({ category: 'name_review', updated_at: knex.fn.now() });
};

exports.down = async function down(knex) {
  await knex('triage_items')
    .whereIn('reason_code', ['email_unverified', 'email_invalid'])
    .whereIn('status', ['open', 'in_progress'])
    .where({ category: 'name_review' })
    .update({ category: 'service_unknown', updated_at: knex.fn.now() });
};
