/**
 * Signup-lane classification + attempt ledger (Build C / Phase 1).
 *
 * Enriches seo_link_prospects with per-directory classification (free vs paid,
 * account/verification/CAPTCHA gating, link rel, automation policy) so the
 * citation runner can decide submit_free / pay_and_submit / skip / needs_account
 * before touching a form. Adds seo_signup_attempts as the honest evidence ledger
 * (one row per submission attempt: outcome, screenshot/receipt, live URL, rel,
 * cost). Payment-grant table is intentionally deferred to Phase 2.
 *
 * Applies on Railway DEPLOY.
 */

exports.up = async (knex) => {
  await knex.schema.alterTable('seo_link_prospects', (t) => {
    t.string('directory_category');        // ai_tool | local_business | pest_niche | general | ...
    t.boolean('requires_account');
    t.boolean('requires_email_verification');
    t.boolean('requires_captcha');
    t.boolean('requires_payment');
    t.decimal('detected_price_usd');
    t.boolean('recurring');
    t.string('offered_link_rel');          // dofollow | nofollow | sponsored | unknown
    t.string('automation_policy');         // submit_free | pay_and_submit | needs_account | skip | blocked_captcha
    t.string('risk_level');                // low | medium | high
    t.timestamp('last_classified_at');
  });

  await knex.schema.createTable('seo_signup_attempts', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('prospect_id').notNullable().references('id').inTable('seo_link_prospects').onDelete('CASCADE');
    t.string('outcome').notNullable();     // placed | skipped | failed | blocked_captcha | blocked_account | blocked_payment | blocked_price_changed
    t.string('mode');                      // auto | manual
    t.text('live_url');
    t.text('evidence_url');                // screenshot / receipt (S3)
    t.text('screenshot_url');
    t.decimal('cost_usd');
    t.string('link_rel');                  // dofollow | nofollow | sponsored | unknown
    t.boolean('indexed');
    t.string('error_code');
    t.text('error_message');
    t.timestamps(true, true);
    t.index('prospect_id');
    t.index('outcome');
  });
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('seo_signup_attempts');
  await knex.schema.alterTable('seo_link_prospects', (t) => {
    t.dropColumns(
      'directory_category', 'requires_account', 'requires_email_verification',
      'requires_captcha', 'requires_payment', 'detected_price_usd', 'recurring',
      'offered_link_rel', 'automation_policy', 'risk_level', 'last_classified_at',
    );
  });
};
