'use strict';

/**
 * Cancellation confirmation SMS: max two segments (owner ruling 2026-08-31,
 * first live V2 cancel on the test account).
 *
 * The H0 truth body (20260830000030) is 306 characters BEFORE the name and
 * date are substituted, so every real send rendered as three segments. This
 * keeps every truth claim that matters in a text (cancelled as of date,
 * visits off, autopay off, completed visits still payable, reply to reverse)
 * and drops the late-cancellation-window clause, which the portal outcome
 * copy still carries. GSM-7 only, no emoji (house voice).
 *
 * Guarded rewrite: only a row still carrying the H0 body is touched; an
 * operator-edited body is left alone. Variants get the same treatment.
 */

const KEY = 'service_cancellation_confirmation';
const PRIOR_BODY =
  'Hello {first_name}! Your Waves plan is cancelled as of {effective_date}. Upcoming visits are off the calendar and autopay is off. Nothing more is charged for future service; a visit already inside its late-cancellation window keeps its scheduled-visit fee. Changed your mind or have a question? Reply here.';
const BODY =
  'Hello {first_name}! Your Waves plan is cancelled as of {effective_date}. Upcoming visits are off the calendar and autopay is off. Completed visits stay payable. Changed your mind or have a question? Reply here.';

async function rewrite(knex, table, from, to, stamp) {
  if (!(await knex.schema.hasTable(table))) return;
  const cols = await knex(table).columnInfo();
  if (!cols.body) return;
  const patch = { body: to };
  if (cols.updated_at) patch.updated_at = new Date();
  if (cols.metadata && table === 'sms_template_variants') {
    // Variants keep their own metadata; only stamp which migration touched them.
    const rows = await knex(table).where({ template_key: KEY, body: from }).select('id', 'metadata');
    for (const row of rows) {
      let meta = {};
      try { meta = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata || {}); } catch (err) { meta = {}; }
      await knex(table).where({ id: row.id }).update({ ...patch, metadata: JSON.stringify({ ...meta, rewritten_by: stamp }) });
    }
    return;
  }
  await knex(table).where({ template_key: KEY, body: from }).update(patch);
}

// The email is no longer an SMS-failure fallback (owner ruling 2026-08-31:
// a customer-initiated request gets both) — fix the admin-facing
// description only where it still carries the seeded text.
const EMAIL_KEY = 'account.cancellation_received';
const EMAIL_PRIOR_DESCRIPTION =
  'Confirmation sent when a customer submits a cancellation request from the portal — fallback for an undeliverable cancellation SMS. No portal links: the account is inactive by the time this sends.';
const EMAIL_DESCRIPTION =
  'Confirmation sent when a customer submits a cancellation request from the portal — sent alongside the confirmation SMS. No portal links: the account is inactive by the time this sends.';

async function rewriteEmailDescription(knex, from, to) {
  if (!(await knex.schema.hasTable('email_templates'))) return;
  const cols = await knex('email_templates').columnInfo();
  if (!cols.description) return;
  const patch = { description: to };
  if (cols.updated_at) patch.updated_at = new Date();
  await knex('email_templates').where({ template_key: EMAIL_KEY, description: from }).update(patch);
}

exports.up = async function up(knex) {
  await rewrite(knex, 'sms_templates', PRIOR_BODY, BODY, '20260831000030_cancellation_confirmation_two_segments');
  await rewrite(knex, 'sms_template_variants', PRIOR_BODY, BODY, '20260831000030_cancellation_confirmation_two_segments');
  await rewriteEmailDescription(knex, EMAIL_PRIOR_DESCRIPTION, EMAIL_DESCRIPTION);
};

exports.down = async function down(knex) {
  await rewrite(knex, 'sms_templates', BODY, PRIOR_BODY, '20260831000030_cancellation_confirmation_two_segments:down');
  await rewrite(knex, 'sms_template_variants', BODY, PRIOR_BODY, '20260831000030_cancellation_confirmation_two_segments:down');
  await rewriteEmailDescription(knex, EMAIL_DESCRIPTION, EMAIL_PRIOR_DESCRIPTION);
};

module.exports.CANCELLATION_CONFIRMATION_BODY = BODY;
module.exports.CANCELLATION_CONFIRMATION_PRIOR_BODY = PRIOR_BODY;
