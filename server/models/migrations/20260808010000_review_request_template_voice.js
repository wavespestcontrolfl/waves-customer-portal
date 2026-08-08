/**
 * review_request: rewrite the canonical review-ask body in the drafter's voice.
 *
 * This is the fallback template — the body that sends whenever no outreach
 * template resolves (ReviewService.sendSMS's last resort). It was 24 of the
 * last 60 asks, and it still read like the 1-10 rate page it was written for:
 *
 *   "Hello {first_name}! How was your service? Your feedback helps us: {review_url}"
 *
 * Two problems, both audited 2026-08-08. It asks a question we do not want
 * answered over text — the link now 302s straight to the Google review form
 * behind GATE_REVIEW_DIRECT_LINK, so "how was your service?" sets up an
 * interaction the destination cannot deliver. And it is generic third-person
 * ("helps us") next to the personalized drafter's copy, which is specific,
 * first-person, and converts:
 *
 *   "Thanks for having us out on the Sarasota roaches, Stacey! Review: ..."
 *
 * New body matches that voice while staying a template. Constraints held:
 *   - ONE GSM-7 segment with a 12-character first name and the ~43-char
 *     shortened link (verified at 140 of 160 slots with "Christopher").
 *   - Plain ASCII punctuation only. An em dash or curly apostrophe flips the
 *     message to UCS-2 and halves the per-segment budget.
 *   - Keeps "Reply STOP to opt out." — house convention on every seeded
 *     template, and this is a template, not drafter output.
 *
 * Idempotent + reversible: the update is scoped to the exact prior body, so an
 * admin copy edit made through /admin is never clobbered, re-running is a
 * no-op, and down() restores the old text under the same condition.
 */

const TEMPLATE_KEY = 'review_request';

const PRIOR_BODY =
  'Hello {first_name}! How was your service? Your feedback helps us: {review_url}\n\nReply STOP to opt out.';

const NEW_BODY =
  'Thanks for having us out, {first_name}! A Google review would mean a lot: {review_url}\n\nReply STOP to opt out.';

async function swap(knex, from, to) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  await knex('sms_templates')
    .where({ template_key: TEMPLATE_KEY, body: from })
    .update({ body: to, updated_at: new Date() });
}

exports.up = async function up(knex) {
  await swap(knex, PRIOR_BODY, NEW_BODY);
};

exports.down = async function down(knex) {
  await swap(knex, NEW_BODY, PRIOR_BODY);
};
