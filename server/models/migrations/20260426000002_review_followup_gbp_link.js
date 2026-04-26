/**
 * Followup review SMS now points straight at the Google Business Profile
 * review form (instead of the tokenized rate page). Customers who ignored
 * the first SMS get a friction-free path to drop a review on Google directly.
 *
 * Updates the review_request_followup template body + variable list. The
 * service code (server/services/review-request.js) renders {google_review_url}
 * by resolving the customer's city to a GBP location.
 */
exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;

  const body = 'No pressure at all, {first_name} — but if you get a sec, your review helps other SWFL families find a pest company they can trust → {google_review_url} 🌊';
  const variables = JSON.stringify(['first_name', 'google_review_url']);

  const existing = await knex('sms_templates')
    .where({ template_key: 'review_request_followup' })
    .first();

  if (existing) {
    await knex('sms_templates')
      .where({ template_key: 'review_request_followup' })
      .update({ body, variables, updated_at: new Date() });
  } else {
    await knex('sms_templates').insert({
      template_key: 'review_request_followup',
      name: 'Review Request — 48h Non-Responder',
      category: 'reviews',
      body,
      variables,
      sort_order: 31,
      created_at: new Date(),
      updated_at: new Date(),
    });
  }
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  const body = 'No pressure at all, {first_name} — but if you get a sec, your review helps other SWFL families find a pest company they can trust → {review_url} 🌊';
  const variables = JSON.stringify(['first_name', 'review_url']);
  await knex('sms_templates')
    .where({ template_key: 'review_request_followup' })
    .update({ body, variables, updated_at: new Date() });
};
